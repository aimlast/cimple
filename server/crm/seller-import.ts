/**
 * seller-import.ts — the seller's side of the broker's CRM, pulled into the deal.
 *
 * The broker links a Cimple deal to the seller's record in Pipedrive (a deal,
 * an organisation or a person). An import then turns everything the CRM
 * holds about the seller into sources on the deal, each read by the
 * kind-aware extractor and merged into the facts with provenance
 * (server/documents/ingest.ts → createAndIngestSource):
 *
 *   record (deal + organisation + person, custom fields by name)  → 1 source, kind "crm"
 *   every note on the deal / organisation / person                → 1 source per note, kind "crm"
 *   activities that carry notes (calls, meetings…)                → kind "crm"
 *   emails linked to the records (when Pipedrive shares them)      → kind "email"
 *   attached files (PDF, Excel, Word, text…)                       → downloaded, kind "document"
 *
 * Everything imported is broker-only by default: CRM notes are the broker's
 * own working notes and are never shown or served to the seller, and the
 * interview agent confirms their facts without ever mentioning the CRM. The
 * broker can share an individual source from the Information tab.
 *
 * Re-import is idempotent: deals.crmLink.imported remembers every item by
 * "<type>:<id>" with its version (CRM update time or content hash). An
 * unchanged item is skipped — including one the broker deleted in Cimple;
 * a changed one replaces its old source (and the facts that came from it).
 */
import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { storage } from "../storage";
import { createAndIngestSource, withDealFactsLock } from "../documents/ingest";
import { removeDocumentFields } from "../interview/info-merger";
import {
  pdAll,
  pdData,
  pdDownload,
  pipedriveMe,
  pipedriveRecordUrl,
  personEmail,
  personPhone,
  relId,
  htmlToText,
  PipedriveError,
} from "./pipedrive";
import type {
  CrmImportStatus,
  CrmImportedItem,
  CrmRecordType,
  Deal,
  DealCrmLink,
  DealSellerContact,
  Document,
} from "@shared/schema";
import type { CrmPrefill, CrmSearchResult, CrmStatusResponse, SellerContactView } from "@shared/crm-seller";

const MAX_NOTES = 150;
const MAX_ACTIVITIES = 100;
const MAX_EMAILS = 60;
const MAX_FILES = 25;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MIN_TEXT_CHARS = 15;
const INGEST_CONCURRENCY = 3;
const FILE_EXTENSIONS = new Set(["pdf", "xlsx", "xls", "docx", "doc", "pptx", "ppt", "txt", "csv", "md"]);
const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ppt: "application/vnd.ms-powerpoint",
  txt: "text/plain",
  csv: "text/csv",
  md: "text/markdown",
};

const uploadsDir = () => process.env.UPLOADS_DIR || path.join(process.cwd(), "public", "uploads");
const sha = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);

export class CrmImportError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "CrmImportError";
  }
}

/** Broker-facing message + HTTP status for a Pipedrive failure. */
export function pipedriveErrorResponse(err: unknown): { status: number; error: string } {
  if (err instanceof CrmImportError) return { status: err.status, error: err.message };
  if (err instanceof PipedriveError) {
    if (err.status === 401) return { status: 400, error: "Pipedrive rejected the saved token — reconnect Pipedrive in Integrations." };
    if (err.status === 403) return { status: 403, error: "Your Pipedrive user doesn't have access to that record." };
    if (err.status === 404) return { status: 404, error: "That record no longer exists in Pipedrive." };
    return { status: 502, error: err.message };
  }
  return { status: 500, error: "Something went wrong talking to Pipedrive." };
}

// ── Search ──────────────────────────────────────────────────────────────

function compact(parts: Array<string | null | undefined | false>): string | null {
  const s = parts.filter((p): p is string => typeof p === "string" && p.trim().length > 0).map((p) => p.trim()).join(" · ");
  return s || null;
}

/** Deals, organisations and people matching `q` (Pipedrive itemSearch). */
export async function searchPipedrive(token: string, q: string): Promise<CrmSearchResult[]> {
  const term = q.trim();
  if (term.length < 2) return [];
  const data = await pdData<any>(token, "/v1/itemSearch", {
    term,
    item_types: "deal,organization,person",
    limit: 20,
  });
  const out: CrmSearchResult[] = [];
  for (const row of data?.items || []) {
    const it = row?.item;
    if (!it || it.id == null) continue;
    if (it.type === "deal") {
      out.push({
        type: "deal",
        id: String(it.id),
        title: String(it.title || "Untitled deal"),
        subtitle: compact([it.organization?.name, it.person?.name, it.stage?.name, it.status && it.status !== "open" ? it.status : null]),
      });
    } else if (it.type === "organization") {
      out.push({
        type: "organization",
        id: String(it.id),
        title: String(it.name || "Unnamed organisation"),
        subtitle: compact([typeof it.address === "string" ? it.address : null]),
      });
    } else if (it.type === "person") {
      out.push({
        type: "person",
        id: String(it.id),
        title: String(it.name || "Unnamed person"),
        subtitle: compact([it.organization?.name, Array.isArray(it.emails) ? it.emails[0] : null]),
      });
    }
  }
  // Deals first (the usual thing to link), then organisations, then people.
  const order: Record<CrmRecordType, number> = { deal: 0, organization: 1, person: 2 };
  return out.sort((a, b) => order[a.type] - order[b.type]).slice(0, 15);
}

// ── Records + field names ────────────────────────────────────────────────

interface FieldDef {
  key: string;
  name: string;
  field_type?: string;
  options?: Array<{ id: number | string; label: string }>;
}

interface Bundle {
  deal: any | null;
  org: any | null;
  person: any | null;
  fields: { deal: FieldDef[]; org: FieldDef[]; person: FieldDef[] };
}

const RECORD_PATH: Record<CrmRecordType, string> = { deal: "deals", organization: "organizations", person: "persons" };

async function getRecord(token: string, type: CrmRecordType, id: string): Promise<any> {
  if (!/^\d+$/.test(id)) throw new CrmImportError("That isn't a Pipedrive record id");
  const rec = await pdData<any>(token, `/v1/${RECORD_PATH[type]}/${id}`);
  if (!rec) throw new PipedriveError("Not found in Pipedrive", 404, `/v1/${RECORD_PATH[type]}/${id}`);
  return rec;
}

async function fieldDefs(token: string, which: "dealFields" | "organizationFields" | "personFields"): Promise<FieldDef[]> {
  try {
    return await pdAll<FieldDef>(token, `/v1/${which}`, {}, 1000);
  } catch (err) {
    console.warn(`[crm-seller] couldn't read ${which}:`, (err as Error).message);
    return [];
  }
}

async function loadBundle(token: string, link: Pick<DealCrmLink, "dealId" | "orgId" | "personId">): Promise<Bundle> {
  const [deal, org, person, dealF, orgF, personF] = await Promise.all([
    link.dealId ? getRecord(token, "deal", link.dealId) : Promise.resolve(null),
    link.orgId ? getRecord(token, "organization", link.orgId).catch(() => null) : Promise.resolve(null),
    link.personId ? getRecord(token, "person", link.personId).catch(() => null) : Promise.resolve(null),
    link.dealId ? fieldDefs(token, "dealFields") : Promise.resolve([]),
    link.orgId ? fieldDefs(token, "organizationFields") : Promise.resolve([]),
    link.personId ? fieldDefs(token, "personFields") : Promise.resolve([]),
  ]);
  return { deal, org, person, fields: { deal: dealF, org: orgF, person: personF } };
}

/**
 * CRM housekeeping that says nothing about the business (ids, counters,
 * pipeline mechanics, owner, timestamps). Also the deal "value": in a
 * listing pipeline it may be the asking price or the broker's fee — too
 * ambiguous to hand to the extractor.
 */
const HOUSEKEEPING_KEY =
  /^(id|company_id|creator_user_id|user_id|owner_id|owner_name|visible_to|cc_email|pipeline_id|stage_id|label_ids|first_char|picture_id|org_hidden|person_hidden|active_flag|rotten_time|probability|status|marketing_status|delete_time|value|currency|formatted_value|weighted_value.*|.*_count|next_activity.*|last_activity.*|last_incoming_mail_time|last_outgoing_mail_time|update_time|add_time|stage_change_time|won_time|lost_time|close_time|first_won_time|expected_close_date|local_.*|origin.*|channel.*|smart_bcc_email|lost_reason|followers?_.*|related_.*|im|birthday|notes|primary_email|org_name|owner_email|cc_email|stage_order_nr|acv|arr|mrr|.*_currency)$/;

function formatValue(field: FieldDef | undefined, raw: unknown, record: any): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (Array.isArray(raw)) {
    const vals = raw.map((v) => (v && typeof v === "object" ? (v as any).value ?? (v as any).name : v)).filter((v) => v !== null && v !== undefined && String(v).trim());
    return vals.length ? vals.map(String).join(", ") : null;
  }
  if (typeof raw === "object") {
    const o = raw as any;
    return typeof o.name === "string" && o.name.trim() ? o.name.trim() : typeof o.value === "string" ? o.value : null;
  }
  if (typeof raw === "boolean") return raw ? "Yes" : "No";
  const opts = field?.options;
  if (opts && opts.length && (field?.field_type === "enum" || field?.field_type === "set")) {
    const labels = String(raw).split(",").map((id) => opts.find((o) => String(o.id) === id.trim())?.label).filter(Boolean);
    if (labels.length) return labels.join(", ");
  }
  if (field?.field_type === "monetary") {
    const cur = record?.[`${field.key}_currency`];
    return `${raw}${cur ? ` ${cur}` : ""}`;
  }
  const s = String(raw).trim();
  return s ? s.slice(0, 2000) : null;
}

/** "Label: value" lines for every meaningful field on a record, custom fields by name. */
export function describeRecord(record: any, fields: FieldDef[]): string[] {
  if (!record || typeof record !== "object") return [];
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const [key, raw] of Object.entries(record)) {
    if (HOUSEKEEPING_KEY.test(key) || seen.has(key)) continue;
    const field = byKey.get(key);
    // Keys Pipedrive didn't describe: keep only readable scalar ones.
    if (!field && (typeof raw === "object" && raw !== null && !Array.isArray(raw) && !(raw as any).name)) continue;
    // Address sub-parts (address_locality…) are covered by the full address.
    if (/^address_/.test(key) || /_(subpremise|street_number|route|sublocality|locality|admin_area_level_[12]|country|postal_code|formatted_address)$/.test(key)) continue;
    const value = formatValue(field, raw, record);
    if (!value) continue;
    const label = field?.name || key.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
    lines.push(`${label}: ${value}`);
    seen.add(key);
  }
  return lines;
}

function customFieldValue(record: any, fields: FieldDef[], nameRe: RegExp): string | null {
  if (!record) return null;
  for (const f of fields) {
    if (!nameRe.test(f.name || "")) continue;
    const v = formatValue(f, record[f.key], record);
    if (v) return v;
  }
  return null;
}

function orgLocation(org: any): string | null {
  if (!org) return null;
  const city = typeof org.address_locality === "string" ? org.address_locality.trim() : "";
  const region = typeof org.address_admin_area_level_1 === "string" ? org.address_admin_area_level_1.trim() : "";
  if (city || region) return [city, region].filter(Boolean).join(", ");
  return typeof org.address === "string" && org.address.trim() ? org.address.trim() : null;
}

function contactFromPerson(person: any, fields: FieldDef[]): CrmPrefill["contact"] {
  if (!person) return null;
  const name = typeof person.name === "string" && person.name.trim() ? person.name.trim() : undefined;
  const email = personEmail(person) ?? undefined;
  const phone = personPhone(person) ?? undefined;
  const title =
    (typeof person.job_title === "string" && person.job_title.trim() ? person.job_title.trim() : null) ??
    customFieldValue(person, fields, /^(job )?title$|position|role/i) ??
    undefined;
  if (!name && !email && !phone) return null;
  return { name, email, phone, title };
}

// ── Link ────────────────────────────────────────────────────────────────

export interface ResolvedLink {
  link: DealCrmLink;
  contact: CrmPrefill["contact"];
  prefill: CrmPrefill;
}

/** Looks up the picked record and everything it points at (org, contact person). */
export async function resolvePipedriveLink(token: string, type: CrmRecordType, id: string): Promise<ResolvedLink> {
  const rec = await getRecord(token, type, id);
  let dealId: string | undefined;
  let orgId: string | undefined;
  let personId: string | undefined;
  let title: string;
  if (type === "deal") {
    dealId = String(rec.id);
    orgId = relId(rec.org_id) ?? undefined;
    personId = relId(rec.person_id) ?? undefined;
    title = String(rec.title || "Pipedrive deal");
  } else if (type === "organization") {
    orgId = String(rec.id);
    title = String(rec.name || "Pipedrive organisation");
    try {
      const people = await pdData<any[]>(token, `/v1/organizations/${orgId}/persons`, { limit: 5 });
      if (Array.isArray(people) && people[0]?.id != null) personId = String(people[0].id);
    } catch {
      /* the organisation's people are optional */
    }
  } else {
    personId = String(rec.id);
    orgId = relId(rec.org_id) ?? undefined;
    title = String(rec.name || "Pipedrive contact");
  }

  const bundle = await loadBundle(token, { dealId, orgId, personId });
  let companyDomain: string | null = null;
  try {
    companyDomain = (await pipedriveMe(token))?.companyDomain ?? null;
  } catch {
    /* the link just won't have an "open in Pipedrive" url */
  }
  const url = pipedriveRecordUrl(companyDomain, type, id) ?? undefined;
  const contact = contactFromPerson(bundle.person, bundle.fields.person);
  const industryRe = /industry|sector|vertical|business type|type of business/i;
  const websiteRe = /web ?site|url|domain|web$/i;
  const prefill: CrmPrefill = {
    title,
    businessName: (bundle.org?.name && String(bundle.org.name).trim()) || (bundle.deal?.title && String(bundle.deal.title).trim()) || title,
    industryText:
      customFieldValue(bundle.deal, bundle.fields.deal, industryRe) ?? customFieldValue(bundle.org, bundle.fields.org, industryRe),
    location: orgLocation(bundle.org),
    websiteUrl:
      (typeof bundle.org?.website === "string" && bundle.org.website.trim()) ||
      customFieldValue(bundle.org, bundle.fields.org, websiteRe) ||
      customFieldValue(bundle.deal, bundle.fields.deal, websiteRe) ||
      null,
    contact,
  };
  return {
    link: { provider: "pipedrive", linkedType: type, dealId, orgId, personId, title, url, linkedAt: new Date().toISOString() },
    contact,
    prefill,
  };
}

/** Whether a CRM-sourced contact may replace what's on the deal (never a broker's own edit). */
export function mayReplaceSellerContact(current: DealSellerContact | null | undefined): boolean {
  return !current || current.source !== "broker";
}

export function sellerContactFromCrm(contact: CrmPrefill["contact"]): DealSellerContact | null {
  if (!contact) return null;
  return { ...contact, source: "crm", updatedAt: new Date().toISOString() };
}

// ── Import items ────────────────────────────────────────────────────────

type ItemKind = "record" | "notes" | "activities" | "emails" | "files";

interface ImportItem {
  /** "note:12", "file:9", "record:deal:4", "mail:33", "activity:7" */
  key: string;
  kind: ItemKind;
  version: string;
  /** Builds the source (downloads files lazily). null = nothing usable (skipped). */
  build: () => Promise<Parameters<typeof createAndIngestSource>[0] | null>;
}

/** Pipedrive times are UTC "YYYY-MM-DD HH:MM:SS" (or a bare date). */
function parseCrmTime(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const s = String(raw).trim();
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z`
    : /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(s) ? `${s.replace(" ", "T")}Z`
    : s;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}
const niceDate = (raw: string | null | undefined): string | null => {
  const d = parseCrmTime(raw);
  if (!d) return raw ? String(raw) : null;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
};
/** An ISO timestamp for sourceMeta.date (bare dates pinned to midday UTC so they don't slip a day in the Americas). */
const isoDate = (raw: string | null | undefined): string | undefined => {
  if (!raw) return undefined;
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T12:00:00.000Z`;
  return parseCrmTime(s)?.toISOString() ?? (s || undefined);
};
const snippet = (text: string, n = 56) => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n).replace(/\s+\S*$/, "")}…` : one;
};

function recordItem(bundle: Bundle, link: DealCrmLink, dealId: string): ImportItem | null {
  const blocks: string[] = [];
  if (bundle.deal) {
    const lines = describeRecord(bundle.deal, bundle.fields.deal);
    if (lines.length) blocks.push(`DEAL — ${bundle.deal.title ?? ""}\n${lines.join("\n")}`);
  }
  if (bundle.org) {
    const lines = describeRecord(bundle.org, bundle.fields.org);
    if (lines.length) blocks.push(`ORGANISATION (the business) — ${bundle.org.name ?? ""}\n${lines.join("\n")}`);
  }
  if (bundle.person) {
    const lines = describeRecord(bundle.person, bundle.fields.person);
    if (lines.length) blocks.push(`CONTACT PERSON (the seller) — ${bundle.person.name ?? ""}\n${lines.join("\n")}`);
  }
  if (blocks.length === 0) return null;
  const text =
    `Pipedrive CRM record for the seller's business, as kept by the broker.\n\n${blocks.join("\n\n")}\n`;
  const recordKey = `record:${link.linkedType ?? (link.dealId ? "deal" : link.orgId ? "organization" : "person")}:${link.dealId ?? link.orgId ?? link.personId}`;
  return {
    key: recordKey,
    kind: "record",
    version: sha(text),
    build: async () => ({
      dealId,
      kind: "crm",
      title: `CRM record — ${link.title}`.slice(0, 200),
      text,
      meta: { provider: "pipedrive", recordType: link.linkedType ?? "deal", recordId: link.dealId ?? link.orgId ?? link.personId, url: link.url },
      visibility: "broker_only",
    }),
  };
}

async function listNotes(token: string, link: DealCrmLink): Promise<any[]> {
  const byId = new Map<string, any>();
  const filters: Array<[string, string | undefined]> = [["deal_id", link.dealId], ["org_id", link.orgId], ["person_id", link.personId]];
  for (const [param, id] of filters) {
    if (!id) continue;
    const notes = await pdAll<any>(token, "/v1/notes", { [param]: id, sort: "add_time DESC" }, MAX_NOTES);
    for (const n of notes) if (n?.id != null && !byId.has(String(n.id))) byId.set(String(n.id), n);
  }
  return Array.from(byId.values()).slice(0, MAX_NOTES);
}

function noteItem(n: any, dealId: string): ImportItem {
  const body = htmlToText(n.content);
  const author = n.user?.name || null;
  return {
    key: `note:${n.id}`,
    kind: "notes",
    version: String(n.update_time || n.add_time || "") + "|" + sha(body),
    build: async () => {
      if (body.length < MIN_TEXT_CHARS) return null;
      const when = niceDate(n.add_time);
      const header = [`Pipedrive note${author ? ` by ${author}` : ""}${when ? `, ${when}` : ""}`];
      const about = [n.deal?.title && `Deal: ${n.deal.title}`, n.organization?.name && `Organisation: ${n.organization.name}`, n.person?.name && `Person: ${n.person.name}`].filter(Boolean);
      return {
        dealId,
        kind: "crm",
        title: `CRM note — ${snippet(body)}`.slice(0, 200),
        text: `${header.join("")}\n${about.join("\n")}\n\n${body}\n`,
        meta: { provider: "pipedrive", recordType: "note", recordId: String(n.id), date: isoDate(n.add_time), from: author ?? undefined },
        visibility: "broker_only",
      };
    },
  };
}

async function listActivities(token: string, link: DealCrmLink): Promise<any[]> {
  const byId = new Map<string, any>();
  const sources: Array<string | null> = [
    link.dealId ? `/v1/deals/${link.dealId}/activities` : null,
    link.orgId ? `/v1/organizations/${link.orgId}/activities` : null,
    link.personId ? `/v1/persons/${link.personId}/activities` : null,
  ];
  for (const p of sources) {
    if (!p) continue;
    try {
      const acts = await pdAll<any>(token, p, {}, MAX_ACTIVITIES);
      for (const a of acts) if (a?.id != null && !byId.has(String(a.id))) byId.set(String(a.id), a);
    } catch (err) {
      if (!(err instanceof PipedriveError && (err.status === 404 || err.status === 403))) throw err;
    }
  }
  return Array.from(byId.values())
    .filter((a) => htmlToText(a.note || a.public_description || "").length >= MIN_TEXT_CHARS)
    .slice(0, MAX_ACTIVITIES);
}

function activityItem(a: any, dealId: string): ImportItem {
  const notes = htmlToText(a.note || a.public_description || "");
  const type = String(a.type || "activity").replace(/_/g, " ");
  const subject = String(a.subject || type).trim();
  const when = a.due_date || a.marked_as_done_time || a.add_time;
  return {
    key: `activity:${a.id}`,
    kind: "activities",
    version: String(a.update_time || a.add_time || "") + "|" + sha(notes + subject),
    build: async () => ({
      dealId,
      kind: "crm",
      title: `CRM ${type} — ${subject}`.slice(0, 200),
      text:
        `Pipedrive ${type} logged by the broker${a.owner_name ? ` (${a.owner_name})` : ""}\n` +
        `Subject: ${subject}\n` +
        (when ? `Date: ${niceDate(when)}\n` : "") +
        (a.done != null ? `Done: ${a.done ? "yes" : "no"}\n` : "") +
        (a.person_name ? `With: ${a.person_name}\n` : "") +
        `\nNotes:\n${notes}\n`,
      meta: { provider: "pipedrive", recordType: "activity", recordId: String(a.id), date: isoDate(when), from: a.owner_name || undefined },
      visibility: "broker_only",
    }),
  };
}

function mailParty(list: any): string {
  if (!Array.isArray(list)) return "";
  return list
    .map((p: any) => {
      const email = p?.email_address || p?.email || "";
      const name = p?.name || "";
      return name && email ? `${name} <${email}>` : name || email;
    })
    .filter(Boolean)
    .join(", ");
}

async function listMail(token: string, link: DealCrmLink, warnings: string[]): Promise<any[]> {
  const byId = new Map<string, any>();
  const sources: Array<string | null> = [
    link.dealId ? `/v1/deals/${link.dealId}/mailMessages` : null,
    link.personId ? `/v1/persons/${link.personId}/mailMessages` : null,
    link.orgId ? `/v1/organizations/${link.orgId}/mailMessages` : null,
  ];
  let refused = false;
  for (const p of sources) {
    if (!p) continue;
    try {
      const rows = await pdAll<any>(token, p, {}, MAX_EMAILS);
      for (const row of rows) {
        const m = row?.data ?? row;
        if (m?.id != null && !byId.has(String(m.id))) byId.set(String(m.id), m);
      }
    } catch (err) {
      if (err instanceof PipedriveError && (err.status === 403 || err.status === 404 || err.status === 400)) {
        refused = refused || err.status === 403;
        continue;
      }
      throw err;
    }
  }
  if (refused) warnings.push("Pipedrive didn't share some linked emails (mail sync may be off, or the emails are private to another user).");
  return Array.from(byId.values()).slice(0, MAX_EMAILS);
}

function mailItem(token: string, m: any, dealId: string): ImportItem {
  const subject = String(m.subject || "(no subject)").trim();
  const when = m.message_time || m.add_time;
  return {
    key: `mail:${m.id}`,
    kind: "emails",
    version: String(m.update_time || m.message_time || m.add_time || ""),
    build: async () => {
      let body = typeof m.body === "string" ? m.body : "";
      if (!body) {
        try {
          const full = await pdData<any>(token, `/v1/mailbox/mailMessages/${m.id}`, { include_body: 1 });
          body = typeof full?.body === "string" ? full.body : "";
        } catch {
          /* fall back to the snippet */
        }
      }
      const text = htmlToText(body) || htmlToText(m.snippet);
      if (text.length < MIN_TEXT_CHARS) return null;
      const from = mailParty(m.from);
      const to = mailParty(m.to);
      const cc = mailParty(m.cc);
      return {
        dealId,
        kind: "email",
        title: `Email — ${subject}`.slice(0, 200),
        text:
          `From: ${from}\nTo: ${to}\n${cc ? `Cc: ${cc}\n` : ""}` +
          (when ? `Date: ${niceDate(when)}\n` : "") +
          `Subject: ${subject}\n\n${text}\n`,
        meta: {
          provider: "pipedrive",
          recordType: "mail",
          recordId: String(m.id),
          from: from || undefined,
          to: to || undefined,
          subject,
          date: isoDate(when),
        },
        visibility: "broker_only",
      };
    },
  };
}

async function listFiles(token: string, link: DealCrmLink): Promise<any[]> {
  const byId = new Map<string, any>();
  const sources: Array<string | null> = [
    link.dealId ? `/v1/deals/${link.dealId}/files` : null,
    link.orgId ? `/v1/organizations/${link.orgId}/files` : null,
    link.personId ? `/v1/persons/${link.personId}/files` : null,
  ];
  for (const p of sources) {
    if (!p) continue;
    try {
      const files = await pdAll<any>(token, p, {}, MAX_FILES * 2);
      for (const f of files) if (f?.id != null && !byId.has(String(f.id))) byId.set(String(f.id), f);
    } catch (err) {
      if (!(err instanceof PipedriveError && (err.status === 404 || err.status === 403))) throw err;
    }
  }
  return Array.from(byId.values())
    .filter((f) => f.active_flag !== false && !f.inline_flag)
    .slice(0, MAX_FILES);
}

function fileExt(f: any): string {
  const fromName = String(f.file_name || f.name || "").match(/\.([a-z0-9]{1,5})$/i)?.[1];
  return String(fromName || f.file_type || "").toLowerCase();
}

/** Parser category from the file name (drives which extraction guidance applies). */
function guessCategory(name: string): { category: string; subcategory: string | null } {
  const n = name.toLowerCase();
  if (/p\s*&\s*l|profit|income statement|financial|balance sheet|compilation|t2|tax return|general ledger|ar aging|receivable/.test(n)) {
    return { category: "financials", subcategory: /tax|t2/.test(n) ? "tax_returns" : /balance/.test(n) ? "balance_sheet" : /income|p\s*&\s*l|profit/.test(n) ? "pnl" : null };
  }
  if (/lease|contract|agreement|licen[cs]e|permit|minute book|articles/.test(n)) return { category: "legal", subcategory: /lease/.test(n) ? "lease" : null };
  if (/employee|staff|payroll|equipment|asset|inventory|org chart/.test(n)) return { category: "operations", subcategory: null };
  if (/brochure|marketing|website|menu/.test(n)) return { category: "marketing", subcategory: null };
  return { category: "other", subcategory: null };
}

function fileItem(token: string, f: any, dealId: string, skipped: (why: string) => void): ImportItem {
  const name = String(f.name || f.file_name || `file-${f.id}`);
  const ext = fileExt(f);
  return {
    key: `file:${f.id}`,
    kind: "files",
    version: `${f.update_time || f.add_time || ""}|${f.file_size ?? ""}`,
    build: async () => {
      if (!FILE_EXTENSIONS.has(ext)) { skipped(`${name} (a .${ext || "?"} file Cimple can't read)`); return null; }
      if (f.remote_location && !["s3", "pipedrive"].includes(String(f.remote_location))) { skipped(`${name} (stored in ${f.remote_location}, not in Pipedrive)`); return null; }
      if (Number(f.file_size) > MAX_FILE_BYTES) { skipped(`${name} (larger than 25 MB)`); return null; }
      const { buffer } = await pdDownload(token, `/v1/files/${f.id}/download`, MAX_FILE_BYTES);
      const docsDir = path.join(uploadsDir(), "docs");
      fs.mkdirSync(docsDir, { recursive: true });
      const filePath = path.join(docsDir, `crm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`);
      fs.writeFileSync(filePath, buffer);
      const { category, subcategory } = guessCategory(name);
      return {
        dealId,
        kind: "document",
        title: name,
        filePath,
        originalName: String(f.file_name || name),
        mimeType: MIME_BY_EXT[ext],
        category,
        subcategory,
        meta: { provider: "pipedrive", recordType: "file", recordId: String(f.id), date: isoDate(f.add_time) },
        visibility: "broker_only",
      };
    },
  };
}

// ── Job ─────────────────────────────────────────────────────────────────

const live = new Map<string, CrmImportStatus>();

export function isImportRunning(dealId: string): boolean {
  return live.get(dealId)?.state === "running";
}

/** The status to show: live while running; a persisted "running" with no live job was interrupted. */
export function effectiveImportStatus(deal: Pick<Deal, "id" | "crmLink">): CrmImportStatus | null {
  const running = live.get(deal.id);
  if (running) return running;
  const saved = (deal.crmLink as DealCrmLink | null)?.lastImportStatus ?? null;
  if (saved?.state === "running") {
    return { ...saved, state: "failed", message: "The import was interrupted (the server restarted). Run it again — nothing is imported twice." };
  }
  return saved;
}

/**
 * Updates deals.crmLink only while the same link is still in place (the
 * broker may unlink, or link another record, mid-import).
 */
async function updateLink(dealId: string, linkedAt: string, mutate: (link: DealCrmLink) => DealCrmLink): Promise<boolean> {
  const deal = await storage.getDeal(dealId);
  const link = deal?.crmLink as DealCrmLink | null | undefined;
  if (!deal || !link || link.linkedAt !== linkedAt) return false;
  await storage.updateDeal(dealId, { crmLink: mutate(link) } as any);
  return true;
}

async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

/** Matches a documents row to a CRM item key (sources imported before the map existed, or after an unlink). */
function docKey(d: Document): string | null {
  const m = (d.sourceMeta as { provider?: string; recordType?: string; recordId?: string } | null) ?? null;
  if (!m || m.provider !== "pipedrive" || !m.recordType || !m.recordId) return null;
  if (m.recordType === "note" || m.recordType === "file" || m.recordType === "activity" || m.recordType === "mail") return `${m.recordType}:${m.recordId}`;
  return `record:${m.recordType}:${m.recordId}`;
}

/**
 * Starts a background import for a linked deal. Throws CrmImportError when
 * the deal isn't linked / Pipedrive isn't connected / an import is running.
 */
export async function startCrmImport(dealId: string, token: string): Promise<CrmImportStatus> {
  if (isImportRunning(dealId)) throw new CrmImportError("An import is already running for this deal", 409);
  const deal = await storage.getDeal(dealId);
  const link = deal?.crmLink as DealCrmLink | null | undefined;
  if (!deal || !link) throw new CrmImportError("Link this deal to a Pipedrive record first");
  const status: CrmImportStatus = { state: "running", startedAt: new Date().toISOString(), total: 0, processed: 0, imported: 0, unchanged: 0, skipped: 0, failed: 0, byKind: {} };
  live.set(dealId, status);
  await updateLink(dealId, link.linkedAt, (l) => ({ ...l, lastImportStatus: status }));
  runImport(dealId, token, link, status).catch((err) => {
    console.error(`[crm-seller] import crashed for ${dealId}:`, err);
  });
  return status;
}

async function runImport(dealId: string, token: string, link: DealCrmLink, status: CrmImportStatus): Promise<void> {
  const warnings: string[] = [];
  const skippedFiles: string[] = [];
  const imported: Record<string, CrmImportedItem> = { ...(link.imported ?? {}) };
  let stillLinked = true;
  const persist = async () => {
    if (!stillLinked) return;
    stillLinked = await updateLink(dealId, link.linkedAt, (l) => ({ ...l, imported: { ...imported }, lastImportStatus: { ...status } }));
  };

  try {
    // 1. What the CRM has.
    const bundle = await loadBundle(token, link);
    const items: ImportItem[] = [];
    const rec = recordItem(bundle, link, dealId);
    if (rec) items.push(rec);
    const [notes, activities, mail, files] = await Promise.all([
      listNotes(token, link),
      listActivities(token, link),
      listMail(token, link, warnings),
      listFiles(token, link),
    ]);
    for (const n of notes) items.push(noteItem(n, dealId));
    for (const a of activities) items.push(activityItem(a, dealId));
    for (const m of mail) items.push(mailItem(token, m, dealId));
    for (const f of files) items.push(fileItem(token, f, dealId, (why) => skippedFiles.push(why)));

    // Refresh the seller's contact from the CRM (never over the broker's own edit).
    const contact = contactFromPerson(bundle.person, bundle.fields.person);
    if (contact) {
      const current = await storage.getDeal(dealId);
      if (current && mayReplaceSellerContact(current.sellerContact as DealSellerContact | null)) {
        await storage.updateDeal(dealId, { sellerContact: sellerContactFromCrm(contact) } as any);
      }
    }

    // 2. What's already here.
    const existingDocs = await storage.getDocumentsByDeal(dealId);
    const docsById = new Map(existingDocs.map((d) => [d.id, d]));
    const docsByKey = new Map<string, Document>();
    for (const d of existingDocs) {
      const k = docKey(d);
      if (k) docsByKey.set(k, d);
    }

    status.total = items.length;
    await persist();

    // 3. Import new / changed items.
    await runPool(items, INGEST_CONCURRENCY, async (item) => {
      if (!stillLinked) return;
      try {
        const prev = imported[item.key];
        const existingDoc = (prev && docsById.get(prev.documentId)) || docsByKey.get(item.key) || null;
        // A source that couldn't be read last time is always tried again.
        const lastFailed = existingDoc?.status === "failed";
        const unchanged = !lastFailed && (prev ? prev.version === item.version : !!existingDoc);
        if (unchanged) {
          // Same as last time — including a source the broker deleted on purpose.
          if (!prev && existingDoc) imported[item.key] = { documentId: existingDoc.id, version: item.version };
          status.unchanged = (status.unchanged ?? 0) + 1;
          return;
        }
        const input = await item.build();
        if (!input) {
          status.skipped = (status.skipped ?? 0) + 1;
          return;
        }
        const doc = await createAndIngestSource({ ...input, uploadedBy: "broker" });
        if (doc.status === "failed" && existingDoc) {
          // The new version couldn't be read — keep the old source (and its
          // facts); the next import tries again.
          await retireDocument(doc);
          status.failed = (status.failed ?? 0) + 1;
          return;
        }
        // A changed item replaces its old source and the facts that came
        // from it (an equal-ranked value from the new version steps in).
        if (existingDoc) await retireDocument(existingDoc);
        imported[item.key] = { documentId: doc.id, version: item.version };
        if (doc.status === "failed") status.failed = (status.failed ?? 0) + 1;
        else {
          status.imported = (status.imported ?? 0) + 1;
          const byKind = (status.byKind = status.byKind ?? {});
          byKind[item.kind] = (byKind[item.kind] ?? 0) + 1;
        }
      } catch (err) {
        console.warn(`[crm-seller] ${item.key} failed:`, (err as Error).message);
        status.failed = (status.failed ?? 0) + 1;
      } finally {
        status.processed = (status.processed ?? 0) + 1;
        await persist().catch(() => {});
      }
    });

    if (skippedFiles.length) warnings.push(`Not imported: ${skippedFiles.slice(0, 5).join("; ")}${skippedFiles.length > 5 ? ` and ${skippedFiles.length - 5} more` : ""}.`);
    status.state = "done";
    status.finishedAt = new Date().toISOString();
    status.warnings = warnings.length ? warnings : undefined;
    status.message = summarise(status);
  } catch (err) {
    const { error } = pipedriveErrorResponse(err);
    status.state = "failed";
    status.finishedAt = new Date().toISOString();
    status.message = error;
    status.warnings = warnings.length ? warnings : undefined;
    console.error(`[crm-seller] import failed for ${dealId}:`, err);
  } finally {
    live.delete(dealId);
    if (stillLinked) {
      await updateLink(dealId, link.linkedAt, (l) => ({
        ...l,
        imported: { ...imported },
        lastImportStatus: { ...status },
        lastImportAt: status.state === "done" ? status.finishedAt : l.lastImportAt,
      })).catch((e) => console.error("[crm-seller] couldn't save the import status:", e));
    }
  }
}

function summarise(s: CrmImportStatus): string {
  const n = s.imported ?? 0;
  const parts: string[] = [];
  if (n === 0 && (s.unchanged ?? 0) > 0) parts.push("Everything was already up to date");
  else if (n === 0) parts.push("Nothing new to import");
  else {
    const b = s.byKind ?? {};
    const bits = [
      b.record ? "the CRM record" : null,
      b.notes ? `${b.notes} note${b.notes === 1 ? "" : "s"}` : null,
      b.activities ? `${b.activities} activit${b.activities === 1 ? "y" : "ies"}` : null,
      b.emails ? `${b.emails} email${b.emails === 1 ? "" : "s"}` : null,
      b.files ? `${b.files} file${b.files === 1 ? "" : "s"}` : null,
    ].filter(Boolean);
    parts.push(`Imported ${bits.join(", ")}`);
    if ((s.unchanged ?? 0) > 0) parts.push(`${s.unchanged} unchanged`);
  }
  if ((s.failed ?? 0) > 0) parts.push(`${s.failed} couldn't be read`);
  return parts.join(" · ");
}

/** Deletes a superseded source and the facts only it contributed. */
async function retireDocument(doc: Document): Promise<void> {
  try {
    await storage.deleteDocument(doc.id);
    await withDealFactsLock(doc.dealId, async () => {
      const deal = await storage.getDeal(doc.dealId);
      if (!deal) return;
      const { info, removed } = removeDocumentFields((deal.extractedInfo as Record<string, unknown>) || {}, doc.id);
      if (removed.length > 0) await storage.updateDeal(doc.dealId, { extractedInfo: info } as any);
    });
  } catch (err) {
    console.warn(`[crm-seller] couldn't retire superseded source ${doc.id}:`, err);
  }
}

// ── Status view ─────────────────────────────────────────────────────────

export async function buildSellerView(deal: Deal): Promise<SellerContactView> {
  const contact = (deal.sellerContact as DealSellerContact | null) ?? null;
  let invite: SellerContactView["invite"] = null;
  try {
    const invites = await storage.getSellerInvitesByDealId(deal.id);
    const newestFirst = [...invites].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
    const primary = newestFirst.find((i) => !!i.acceptedAt) ?? newestFirst.find((i) => !!i.sentAt) ?? newestFirst[0];
    if (primary) {
      invite = {
        name: primary.sellerName ?? null,
        email: primary.sellerEmail ?? null,
        status: primary.acceptedAt ? "opened" : primary.sentAt ? "emailed" : "created",
      };
    }
  } catch {
    /* invites are optional here */
  }
  if (contact) {
    return {
      name: contact.name ?? null,
      email: contact.email ?? null,
      phone: contact.phone ?? null,
      title: contact.title ?? null,
      source: contact.source,
      updatedAt: contact.updatedAt ?? null,
      invite,
    };
  }
  return {
    name: invite?.name ?? null,
    email: invite?.email ?? null,
    phone: null,
    title: null,
    source: invite ? "invite" : null,
    updatedAt: null,
    invite,
  };
}

export async function buildCrmStatus(deal: Deal, connected: boolean): Promise<CrmStatusResponse> {
  const link = (deal.crmLink as DealCrmLink | null) ?? null;
  let linkOut: CrmStatusResponse["link"] = null;
  if (link) {
    const { imported, lastImportStatus: _s, ...rest } = link;
    linkOut = { ...rest, importedCount: Object.keys(imported ?? {}).length };
  }
  return {
    connected,
    provider: connected ? "pipedrive" : null,
    link: linkOut,
    import: effectiveImportStatus(deal),
    seller: await buildSellerView(deal),
  };
}
