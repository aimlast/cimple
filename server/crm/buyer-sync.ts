/**
 * CRM buyer sync — turns the broker's CRM buyer contacts into matchable
 * buyer profiles, so Suggested buyers works on the broker's whole buyer list
 * without anyone filling in a form.
 *
 * For each buyer contact in the connected CRM (Pipedrive today) we read the
 * person record, organisation, custom fields, notes and the deals they sit on
 * (= the listings they enquired about), and the supporting model extracts a
 * buyer profile: type, budget, industries, locations and the deep matching
 * criteria (BUYER_CRITERIA_SECTIONS keys).
 *
 * Privacy rules (non-negotiable):
 *   - The extracted profile is stored on the broker's own contact row
 *     (broker_buyer_contacts.crm_profile), NEVER on the global buyer_users
 *     row. That row is visible to the buyer and shared across brokers; CRM
 *     notes are the broker's private working notes.
 *   - Nobody is emailed. A new buyer_users row is created with contact basics
 *     only and no password; it becomes a real account only if the broker
 *     later invites them or they sign up themselves.
 *   - What the buyer enters themselves always wins (mergeBuyerProfile).
 *
 * Unchanged CRM records are skipped cheaply (crm_sync_key), so the scheduled
 * re-sync mostly costs a few API reads per contact and no model calls.
 */
import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "crypto";
import { storage } from "../storage";
import { agentConfig } from "../interview/config/load-config";
import {
  BUYER_CRITERIA_SECTIONS,
  type BuyerUser, type CrmBuyerProfile, type Integration,
} from "@shared/schema";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
/** Overridable so the sync can be exercised against a local fake in tests. */
const PD_BASE = () => process.env.PIPEDRIVE_API_BASE || "https://api.pipedrive.com";
const MAX_CONTACTS_PER_RUN = 3000;
const AI_BATCH = 5;

export type BuyerSyncMode = "pipelines" | "labels" | "all";

export interface BuyerSyncSettings {
  mode: BuyerSyncMode;
  pipelineIds?: number[];
  labelIds?: number[];
  /** Re-sync automatically every few hours. */
  auto: boolean;
}

export interface BuyerSyncStatus {
  state: "idle" | "running" | "done" | "failed";
  startedAt?: string;
  finishedAt?: string;
  total?: number;
  processed?: number;
  created?: number;
  updated?: number;
  unchanged?: number;
  skippedNoEmail?: number;
  errors?: number;
  message?: string;
}

// ── Pipedrive API ───────────────────────────────────────────────────────

async function pd(token: string, path: string, params: Record<string, string | number> = {}): Promise<any> {
  const qs = new URLSearchParams({ ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])), api_token: token });
  const url = `${PD_BASE()}${path}${path.includes("?") ? "&" : "?"}${qs}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url);
    if (res.status === 429) {
      const wait = Number(res.headers.get("retry-after")) || 2 ** attempt;
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`Pipedrive ${path} → ${res.status}`);
    return res.json();
  }
  throw new Error(`Pipedrive ${path} rate-limited`);
}

/** Every page of a v1 list endpoint. */
async function pdAll(token: string, path: string, params: Record<string, string | number> = {}, cap = MAX_CONTACTS_PER_RUN * 3): Promise<any[]> {
  const out: any[] = [];
  let start = 0;
  while (out.length < cap) {
    const body = await pd(token, path, { ...params, start, limit: 500 });
    out.push(...(body?.data || []));
    const more = body?.additional_data?.pagination?.more_items_in_collection;
    if (!more) break;
    start = body.additional_data.pagination.next_start ?? start + 500;
  }
  return out;
}

const firstEmail = (p: any): string | null => {
  const e = Array.isArray(p?.email) ? p.email.find((x: any) => x?.primary)?.value || p.email[0]?.value : p?.primary_email || p?.email;
  return typeof e === "string" && e.includes("@") ? e.toLowerCase().trim() : null;
};
const firstPhone = (p: any): string | null => {
  const v = Array.isArray(p?.phone) ? p.phone.find((x: any) => x?.primary)?.value || p.phone[0]?.value : p?.phone;
  return typeof v === "string" && v.trim() ? v.trim() : null;
};
const personLabelIds = (p: any): number[] =>
  Array.isArray(p?.label_ids) ? p.label_ids.map(Number) : p?.label != null ? [Number(p.label)] : [];

export async function getPipedriveBuyerSyncOptions(token: string) {
  const [pipelines, personFields] = await Promise.all([
    pd(token, "/v1/pipelines").then((b) => b?.data || []),
    pdAll(token, "/v1/personFields"),
  ]);
  const labelField = personFields.find((f: any) => f.key === "label" || f.key === "label_ids");
  return {
    pipelines: pipelines.map((p: any) => ({ id: Number(p.id), name: String(p.name) })),
    labels: (labelField?.options || []).map((o: any) => ({ id: Number(o.id), name: String(o.label) })),
  };
}

// ── Model extraction ────────────────────────────────────────────────────

const CRITERIA_KEYS: Record<string, { type: string; options?: readonly string[] }> = {};
for (const section of Object.values(BUYER_CRITERIA_SECTIONS)) {
  for (const [key, def] of Object.entries(section.fields)) CRITERIA_KEYS[key] = def as any;
}
const CRITERIA_DOC = Object.entries(CRITERIA_KEYS)
  .filter(([k]) => k !== "targetIndustries" && k !== "targetLocations")
  .map(([k, d]) => `${k} (${d.type}${d.options ? `: ${d.options.join("|")}` : ""})`)
  .join(", ");

const EXTRACT_TOOL: Anthropic.Tool = {
  name: "buyer_profiles",
  description: "Structured acquisition profile for each buyer contact.",
  input_schema: {
    type: "object",
    properties: {
      buyers: {
        type: "array",
        items: {
          type: "object",
          properties: {
            ref: { type: "string" },
            buyerType: { type: ["string", "null"], enum: ["individual", "strategic", "financial", "search_fund", "family_office", "private_equity", null] },
            background: { type: ["string", "null"], description: "1-2 sentence summary for the broker: who they are and what they want. Plain facts only." },
            liquidFunds: { type: ["string", "null"], description: "Cash/equity available, as stated, e.g. '$750K'." },
            hasProofOfFunds: { type: ["boolean", "null"] },
            targetIndustries: { type: "array", items: { type: "string" } },
            targetLocations: { type: "array", items: { type: "string" } },
            criteria: {
              type: "object",
              description: `Only keys from this list: ${CRITERIA_DOC}. Currency values as plain numbers in dollars (e.g. 2000000). Omit anything not supported by the record.`,
            },
            inferred: {
              type: "array",
              items: { type: "string" },
              description: "Names of fields you inferred rather than read directly (e.g. targetIndustries taken from the listings they enquired about).",
            },
          },
          required: ["ref", "targetIndustries", "targetLocations", "criteria", "inferred"],
        },
      },
    },
    required: ["buyers"],
  },
};

interface ExtractInput { ref: string; context: string }

async function extractProfiles(batch: ExtractInput[]): Promise<Map<string, CrmBuyerProfile>> {
  const out = new Map<string, CrmBuyerProfile>();
  if (!process.env.ANTHROPIC_API_KEY || batch.length === 0) return out;
  const response = await anthropic.messages.create({
    model: agentConfig.models.supportingAgents,
    max_tokens: 4000,
    temperature: 0,
    tools: [EXTRACT_TOOL],
    tool_choice: { type: "tool", name: "buyer_profiles" },
    system: [
      "You read a business broker's CRM records about business BUYERS and extract each buyer's acquisition profile, used to match them to businesses for sale.",
      "Record only what the record supports. Never invent budgets, industries or criteria. If a buyer only enquired about listings, you may take the industries/locations/size of those listings as their interests, and list those fields in `inferred`.",
      "Budget language: 'up to $2M' → askingPriceMax 2000000; 'looking for $300-500K SDE' → sdeMin 300000, sdeMax 500000. 'Has $500K liquid' → liquidFunds '$500K'. Proof of funds only when the record says it was provided/verified.",
      "buyerType: individual (person buying to own/operate), strategic (an operating company), private_equity / family_office / search_fund / financial (other investors). null if unclear.",
      "Return one entry per record, using its ref.",
    ].join(" "),
    messages: [{ role: "user", content: batch.map((b) => `<record ref="${b.ref}">\n${b.context}\n</record>`).join("\n\n") }],
  });
  const block = response.content.find((b) => b.type === "tool_use");
  const buyers = ((block && block.type === "tool_use" ? block.input : {}) as { buyers?: any[] }).buyers ?? [];
  for (const b of buyers) {
    if (!b?.ref) continue;
    const criteria: Record<string, any> = {};
    for (const [k, v] of Object.entries(b.criteria || {})) {
      const def = CRITERIA_KEYS[k];
      if (!def || v == null || v === "" || k === "targetIndustries" || k === "targetLocations") continue;
      if (def.type === "currency") { const n = Number(String(v).replace(/[^0-9.]/g, "")); if (n > 0) criteria[k] = String(Math.round(n)); }
      else if (def.type === "percent" || def.type === "number") { const n = Number(String(v).replace(/[^0-9.-]/g, "")); if (Number.isFinite(n)) criteria[k] = n; }
      else if (def.type === "boolean") { if (typeof v === "boolean") criteria[k] = v; }
      else if (def.type === "select") { if (def.options?.includes(String(v))) criteria[k] = String(v); }
      else if (def.type === "multiselect" || def.type === "tags") { const arr = (Array.isArray(v) ? v : [v]).map(String).filter((x) => !def.options || def.options.includes(x)); if (arr.length) criteria[k] = arr; }
    }
    const strs = (v: unknown) => (Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 12) : []);
    out.set(String(b.ref), {
      buyerType: b.buyerType ?? null,
      background: typeof b.background === "string" ? b.background.slice(0, 600) : null,
      liquidFunds: typeof b.liquidFunds === "string" ? b.liquidFunds.slice(0, 60) : null,
      hasProofOfFunds: typeof b.hasProofOfFunds === "boolean" ? b.hasProofOfFunds : null,
      targetIndustries: strs(b.targetIndustries),
      targetLocations: strs(b.targetLocations),
      buyerCriteria: criteria,
      inferred: strs(b.inferred),
    });
  }
  return out;
}

// ── Sync job ────────────────────────────────────────────────────────────

const running = new Map<string, BuyerSyncStatus>();

export function getLiveBuyerSyncStatus(brokerId: string): BuyerSyncStatus | undefined {
  return running.get(brokerId);
}

async function saveSyncState(integration: Integration, patch: { settings?: BuyerSyncSettings; status?: BuyerSyncStatus; lastSuccessAt?: string }) {
  const fresh = (await storage.getIntegrationsByBroker(integration.brokerId)).find((i) => i.id === integration.id) || integration;
  const config = (fresh.config as any) || {};
  const buyerSync = { ...(config.buyerSync || {}), ...patch };
  await storage.updateIntegration(integration.id, { config: { ...config, buyerSync } } as any);
}

export async function getPipedriveIntegration(brokerId: string): Promise<Integration | undefined> {
  return (await storage.getIntegrationsByBroker(brokerId)).find((i) => i.provider === "pipedrive" && i.status === "connected" && !!i.accessToken);
}

/**
 * Start a sync in the background. Resolves once the job is queued; progress
 * is readable via getLiveBuyerSyncStatus / the integration's config.
 */
export async function startPipedriveBuyerSync(brokerId: string, settings: BuyerSyncSettings, opts: { limit?: number } = {}): Promise<{ started: boolean; reason?: string }> {
  if (running.get(brokerId)?.state === "running") return { started: false, reason: "already_running" };
  const integration = await getPipedriveIntegration(brokerId);
  if (!integration) return { started: false, reason: "not_connected" };
  const status: BuyerSyncStatus = { state: "running", startedAt: new Date().toISOString(), processed: 0, created: 0, updated: 0, unchanged: 0, skippedNoEmail: 0, errors: 0 };
  running.set(brokerId, status);
  await saveSyncState(integration, { settings, status });
  void runSync(integration, settings, status, opts.limit)
    .then(async () => {
      status.state = "done";
      status.finishedAt = new Date().toISOString();
      await saveSyncState(integration, { status, lastSuccessAt: status.startedAt });
    })
    .catch(async (err) => {
      console.error("[buyer-sync] failed:", err);
      status.state = "failed";
      status.finishedAt = new Date().toISOString();
      status.message = err instanceof Error ? err.message : String(err);
      await saveSyncState(integration, { status }).catch(() => {});
    })
    .finally(() => setTimeout(() => { if (running.get(brokerId) === status) running.delete(brokerId); }, 60_000));
  return { started: true };
}

interface Candidate {
  personId: number;
  deals: Array<{ id: number; title: string; stage?: string | null; status?: string | null; value?: number | null; currency?: string | null; updated?: string | null }>;
}

async function collectCandidates(token: string, settings: BuyerSyncSettings): Promise<Map<number, Candidate>> {
  const out = new Map<number, Candidate>();
  const add = (personId: number) => {
    if (!out.has(personId)) out.set(personId, { personId, deals: [] });
    return out.get(personId)!;
  };
  if (settings.mode === "pipelines") {
    const stages = new Map<number, string>();
    for (const s of await pdAll(token, "/v1/stages")) stages.set(Number(s.id), String(s.name));
    for (const pipelineId of settings.pipelineIds || []) {
      const deals = await pdAll(token, `/v1/pipelines/${pipelineId}/deals`, { everyone: 1 });
      for (const d of deals) {
        const pid = typeof d.person_id === "object" ? d.person_id?.value : d.person_id;
        if (!pid) continue;
        add(Number(pid)).deals.push({
          id: Number(d.id), title: String(d.title || ""), stage: stages.get(Number(d.stage_id)) ?? null,
          status: d.status ?? null, value: d.value ?? null, currency: d.currency ?? null, updated: d.update_time ?? null,
        });
      }
    }
  } else {
    const wanted = new Set((settings.labelIds || []).map(Number));
    for (const p of await pdAll(token, "/v1/persons")) {
      if (settings.mode === "labels" && !personLabelIds(p).some((id) => wanted.has(id))) continue;
      add(Number(p.id));
    }
  }
  return out;
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const item = items[i++]; await fn(item); }
  }));
}

async function runSync(integration: Integration, settings: BuyerSyncSettings, status: BuyerSyncStatus, limit?: number) {
  const token = integration.accessToken!;
  const brokerId = integration.brokerId;
  const [candidates, personFields] = await Promise.all([collectCandidates(token, settings), pdAll(token, "/v1/personFields")]);
  // Custom person fields are keyed by 40-char hashes — map them to their names.
  const customNames = new Map<string, string>();
  for (const f of personFields) if (typeof f.key === "string" && /^[0-9a-f]{40}$/.test(f.key)) customNames.set(f.key, String(f.name));
  const optionLabels = new Map<string, string>();
  for (const f of personFields) for (const o of f.options || []) optionLabels.set(`${f.key}:${o.id}`, String(o.label));

  let list = Array.from(candidates.values()).slice(0, limit ?? MAX_CONTACTS_PER_RUN);
  status.total = list.length;

  const pending: Array<ExtractInput & { apply: (p: CrmBuyerProfile) => Promise<void> }> = [];
  const flush = async () => {
    const batch = pending.splice(0, pending.length);
    if (!batch.length) return;
    let profiles = new Map<string, CrmBuyerProfile>();
    try { profiles = await extractProfiles(batch); } catch (err) { console.error("[buyer-sync] extraction failed:", err); }
    for (const b of batch) {
      const p = profiles.get(b.ref);
      if (!p) { status.errors!++; continue; }
      await b.apply(p).catch((err) => { console.error("[buyer-sync] save failed:", err); status.errors!++; });
    }
  };

  await mapLimit(list, 4, async (cand) => {
    try {
      const person = (await pd(token, `/v1/persons/${cand.personId}`))?.data;
      const email = firstEmail(person);
      if (!person || !email) { status.skippedNoEmail!++; status.processed!++; return; }
      if (settings.mode !== "pipelines") {
        const deals = await pdAll(token, `/v1/persons/${cand.personId}/deals`, { status: "all_not_deleted" }, 200).catch(() => []);
        cand.deals = deals.map((d: any) => ({ id: Number(d.id), title: String(d.title || ""), stage: d.stage_name ?? null, status: d.status ?? null, value: d.value ?? null, currency: d.currency ?? null, updated: d.update_time ?? null }));
      }

      // Contact basics go on the global row only when missing there.
      let buyer: BuyerUser | undefined = await storage.getBuyerUserByEmail(email);
      let created = false;
      const name = String(person.name || email);
      const orgName = typeof person.org_id === "object" ? person.org_id?.name ?? null : person.org_name ?? null;
      if (!buyer) {
        buyer = await storage.createBuyerUser({
          email, passwordHash: null, name, phone: firstPhone(person), company: orgName, title: person.job_title ?? null,
          linkedinUrl: null, buyerCriteria: {}, targetIndustries: [] as any, targetLocations: [] as any, buyerType: null,
          background: null, liquidFunds: null, hasProofOfFunds: false, profileCompletionPct: 0, emailVerified: false,
          source: "crm_imported", invitedByBroker: brokerId, invitedByDeal: null, resetToken: null, resetTokenExpiresAt: null,
        } as any);
        created = true;
      } else {
        const fill: Partial<BuyerUser> = {};
        if (!buyer.phone && firstPhone(person)) fill.phone = firstPhone(person);
        if (!buyer.company && orgName) fill.company = orgName;
        if (!buyer.title && person.job_title) fill.title = person.job_title;
        if (Object.keys(fill).length) buyer = (await storage.updateBuyerUser(buyer.id, fill)) || buyer;
      }
      let contact = await storage.getBrokerBuyerContact(brokerId, buyer.id);
      if (!contact) {
        contact = await storage.createBrokerBuyerContact({ brokerId, buyerUserId: buyer.id, source: "crm", tags: [] as any, notes: null } as any);
        created = true;
      }

      // Cheap change detector: person + their deals. Unchanged → nothing to do.
      const syncKey = createHash("sha1").update(JSON.stringify([
        person.update_time, person.last_activity_date, person.notes_count,
        cand.deals.map((d) => [d.id, d.stage, d.status, d.updated]),
      ])).digest("hex");
      if (contact.crmSyncKey === syncKey && contact.crmProfile) { status.unchanged!++; status.processed!++; return; }

      const notes = await pdAll(token, "/v1/notes", { person_id: cand.personId, sort: "add_time DESC" }, 60).catch(() => []);
      const custom: string[] = [];
      for (const [k, v] of Object.entries(person)) {
        if (!customNames.has(k) || v == null || v === "") continue;
        const val = typeof v === "object" ? JSON.stringify(v) : optionLabels.get(`${k}:${v}`) ?? String(v);
        custom.push(`${customNames.get(k)}: ${val}`);
      }
      const context = [
        `Name: ${name}`,
        orgName ? `Organisation: ${orgName}` : "",
        person.job_title ? `Job title: ${person.job_title}` : "",
        custom.length ? `Custom fields:\n${custom.join("\n")}` : "",
        cand.deals.length ? `Listings/deals this contact is on:\n${cand.deals.slice(0, 25).map((d) => `- ${d.title}${d.stage ? ` (stage: ${d.stage})` : ""}${d.status ? ` [${d.status}]` : ""}`).join("\n")}` : "",
        notes.length ? `Notes (newest first):\n${notes.slice(0, 40).map((n: any) => `- ${String(n.content || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 1200)}`).join("\n")}` : "",
      ].filter(Boolean).join("\n").slice(0, 14000);

      const contactId = contact.id;
      const wasCreated = created;
      pending.push({
        ref: String(cand.personId),
        context,
        apply: async (profile) => {
          profile.inquiries = cand.deals.slice(0, 25).map((d) => ({ title: d.title, stage: d.stage ?? null, status: d.status ?? null }));
          profile.extractedAt = new Date().toISOString();
          await storage.updateBrokerBuyerContact(contactId, {
            crmProvider: "pipedrive", crmRecordId: String(cand.personId), crmProfile: profile as any,
            crmSyncKey: syncKey, crmSyncedAt: new Date(),
          } as any);
          if (wasCreated) status.created!++; else status.updated!++;
          status.processed!++;
        },
      });
      if (pending.length >= AI_BATCH) await flush();
    } catch (err) {
      console.error(`[buyer-sync] person ${cand.personId} failed:`, err);
      status.errors!++;
      status.processed!++;
    }
  });
  await flush();
}

// ── Scheduler ───────────────────────────────────────────────────────────

/** Re-sync every broker who switched automatic sync on. */
export function startBuyerSyncScheduler(intervalMs = 6 * 60 * 60 * 1000) {
  const tick = async () => {
    try {
      const all = await storage.getAllIntegrations();
      for (const i of all || []) {
        const cfg = (i.config as any)?.buyerSync;
        if (i.provider !== "pipedrive" || i.status !== "connected" || !cfg?.settings?.auto) continue;
        await startPipedriveBuyerSync(i.brokerId, cfg.settings).catch(() => {});
      }
    } catch (err) {
      console.error("[buyer-sync] scheduler tick failed:", err);
    }
  };
  setTimeout(tick, 5 * 60 * 1000);
  setInterval(tick, intervalMs);
}
