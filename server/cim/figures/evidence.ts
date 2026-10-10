/**
 * evidence — what the AI pass may cite for a figure's "why" (spec §9.4).
 *
 *   I<n>  the seller's own words: facts with seller-side provenance (reason
 *         keys first), then raw seller messages from seller-line sessions
 *         that mention a candidate's line or year. A broker-led exchange
 *         gives only the seller's side; "Broker:" lines are never evidence.
 *         Cut by every keep-out request; dropped when it carries a value the
 *         seller retracted; staff-private matters screened out.
 *   D<n>  passages (±500 characters around the line's words) from documents
 *         buyers may be shown and from non-private call / email transcripts.
 *   R<n>  the broker's settled conflicts with no private side (their
 *         resolution note is marked internal).
 *   hints the analysis's notes — where a reason may be found, never citable.
 *
 * Never: the broker's private notes, held or kept-out material, broker-only
 * or CRM sources, anything the staff-private screen holds back.
 *
 * buildFigureEvidence is pure; loadFigureEvidence reads the rows.
 */
import { createHash } from "node:crypto";
import { lineWords, type LineId } from "@shared/figure-lines";
import { cutPrivateDetail, carriesPrivateDetail } from "../../interview/seller-keep-out";
import { sellerSideOf } from "../../interview/money-talk";
import { screenStaffPrivateText } from "../staff-private";
import { isBrokerSessionSource } from "../../interview/info-merger";
import { isCaptureKey } from "@shared/figure-explain";
import { holdsText, type FigureScreenCtx } from "./guards";

export type EvidenceKind = "fact" | "interview" | "transcript" | "document" | "discrepancy";

export interface EvidenceRef {
  id: string;
  kind: EvidenceKind;
  text: string;
  meta: {
    factKey?: string;
    sessionId?: string;
    messageIndex?: number;
    documentId?: string;
    page?: number | null;
    discrepancyId?: string;
    /** A broker resolution note. */
    internal?: true;
    /** Said on a call / video call (basis "a conversation with the owner"). */
    spoken?: true;
    /** A label for the broker's drawer ("Warehouse lease", "Interview, Oct 3"). */
    label?: string;
  };
}

export interface FigureEvidence {
  refs: Map<string, EvidenceRef>;
  hints: string[];
  /** Hash of everything citable (a candidate's fingerprint includes it). */
  digest: string;
}

export interface EvidenceTarget {
  line: LineId;
  lineLabel: string;
  year: string;
  fromYear?: string;
}

export interface EvidenceSession {
  id: string;
  /** "seller" | "broker_with_seller" | "broker". Broker-alone sessions are never evidence. */
  mode: string;
  messages: Array<{ role: string; content: string }>;
  retracted: Array<{ key: string; value: string }>;
  at?: string | null;
}

export interface EvidenceDocument {
  id: string;
  name: string;
  /** May be cited to buyers (a shared document). */
  citable: boolean;
  /** A shared (not broker-only) call / video / email transcript. */
  transcript: boolean;
  text: string | null;
}

export interface EvidenceDiscrepancy {
  id: string;
  field: string;
  status: string;
  source?: string | null;
  interviewValue?: string | null;
  documentValue?: string | null;
  brokerNotes?: string | null;
  sellerResponse?: string | null;
  resolvedValue?: string | null;
  /** discrepancyHasPrivateSide(d) — any private side keeps it out. */
  privateSide: boolean;
  /** source = "merge" against a CRM source. */
  crmMerge: boolean;
}

export interface EvidenceInput {
  targets: EvidenceTarget[];
  facts: Record<string, unknown>;
  sessions: EvidenceSession[];
  documents: EvidenceDocument[];
  discrepancies: EvidenceDiscrepancy[];
  screen: FigureScreenCtx;
  hints: string[];
}

const MAX_MESSAGES = 40;
const MAX_PASSAGES = 30;
const MESSAGE_CHARS = 1200;
const PASSAGE_RADIUS = 500;

const SELLER_SPOKEN = new Set(["call", "video_call"]);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Words that tie a text to the targets (each target's line words; years separately). */
function targetWords(targets: EvidenceTarget[]): { words: string[]; years: Set<string> } {
  const words = new Set<string>();
  const years = new Set<string>();
  for (const t of targets) {
    for (const w of lineWords(t.line, t.lineLabel)) if (w.length >= 3) words.add(w.toLowerCase());
    years.add(t.year);
    if (t.fromYear) years.add(t.fromYear);
  }
  return { words: Array.from(words), years };
}

function mentionsAny(text: string, words: string[]): boolean {
  const t = text.toLowerCase();
  return words.some((w) => new RegExp(`(?:^|[^a-z])${escapeRe(w)}`).test(t));
}

/** The text as the screens leave it (null = nothing may be used). */
function screened(text: string, screen: FigureScreenCtx): string | null {
  let t = String(text ?? "");
  if (!t.trim()) return null;
  for (const e of screen.keepOut) {
    const cut = cutPrivateDetail(t, e);
    if (cut === null) continue;
    t = cut;
    if (!t.trim() || carriesPrivateDetail(t, e)) return null;
  }
  t = screenStaffPrivateText(t, screen.staff, screen.included).text;
  if (!t.trim()) return null;
  // Anything still naming a held party, a staff member or a personal matter is left out whole.
  if (holdsText(t, screen, { owners: true })) return null;
  return t.trim();
}

const GENERIC_HANDBACK = /^(?:raised with the seller in the ai interview|the interview ended on)/i;

export function buildFigureEvidence(input: EvidenceInput): FigureEvidence {
  const refs = new Map<string, EvidenceRef>();
  const { words, years } = targetWords(input.targets);
  const yearList = Array.from(years);
  const about = (text: string) => mentionsAny(text, words) || yearList.some((y) => text.includes(y));
  let iN = 0, dN = 0, rN = 0;

  // I — facts with seller-side provenance (reason keys first).
  const sources = ((input.facts._fieldSources ?? {}) as Record<string, any>) || {};
  const factKeys = Object.keys(input.facts).filter((k) => !k.startsWith("_"));
  const ordered = [...factKeys.filter((k) => isCaptureKey(k) || /^reason/i.test(k)), ...factKeys.filter((k) => !(isCaptureKey(k) || /^reason/i.test(k)))];
  for (const key of ordered) {
    const src = sources[key];
    if (!src || typeof src !== "object") continue;
    const kind = String(src.source ?? "");
    if (kind !== "interview" && !SELLER_SPOKEN.has(kind)) continue;
    if (src.brokerOnly || src.hiddenFromSeller || isBrokerSessionSource(src)) continue;
    if (typeof src.speaker === "string" && /\bbroker\b/i.test(src.speaker)) continue;
    const value = input.facts[key];
    if (value === null || value === undefined || typeof value === "object") continue;
    const reasonKey = isCaptureKey(key) || /^reason/i.test(key);
    const keyWords = key.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
    if (!reasonKey && !mentionsAny(keyWords, words)) continue;
    const excerpt = typeof src.excerpt === "string" && src.excerpt.trim() && src.excerpt.trim() !== String(value).trim() ? src.excerpt.trim() : null;
    const text = screened(excerpt ? `${String(value)}\n“${excerpt}”` : String(value), input.screen);
    if (!text) continue;
    iN++;
    refs.set(`I${iN}`, {
      id: `I${iN}`, kind: SELLER_SPOKEN.has(kind) ? "transcript" : "fact", text: text.slice(0, MESSAGE_CHARS),
      meta: { factKey: key, ...(src.sessionId ? { sessionId: String(src.sessionId) } : {}), ...(src.documentId ? { documentId: String(src.documentId) } : {}), ...(SELLER_SPOKEN.has(kind) ? { spoken: true as const } : {}), label: SELLER_SPOKEN.has(kind) ? "A conversation with the owner" : "The owner" },
    });
  }

  // I — the seller's own messages (seller-line sessions; the seller's side only).
  let messages = 0;
  for (const s of input.sessions) {
    if (s.mode === "broker") continue;
    const retracted = s.retracted.map((r) => String(r.value ?? "").trim()).filter((v) => v.length >= 3);
    s.messages.forEach((m, index) => {
      if (messages >= MAX_MESSAGES || m.role !== "user") return;
      const side = s.mode === "broker_with_seller" ? sellerSideOf(m.content) : m.content;
      if (!side || !side.trim() || !about(side)) return;
      if (retracted.some((v) => side.includes(v))) return;
      const text = screened(side, input.screen);
      if (!text) return;
      messages++;
      iN++;
      refs.set(`I${iN}`, {
        id: `I${iN}`, kind: s.mode === "broker_with_seller" ? "transcript" : "interview", text: text.slice(0, MESSAGE_CHARS),
        meta: { sessionId: s.id, messageIndex: index, ...(s.mode === "broker_with_seller" ? { spoken: true as const } : {}), label: s.mode === "broker_with_seller" ? "Interview together" : "The owner, in the interview" },
      });
    });
  }

  // D — passages from shared documents and transcripts.
  let passages = 0;
  for (const doc of input.documents) {
    if (passages >= MAX_PASSAGES) break;
    if (!(doc.citable || doc.transcript) || !doc.text) continue;
    const text = doc.text;
    const lower = text.toLowerCase();
    const hits: number[] = [];
    for (const w of words) {
      const re = new RegExp(`(?:^|[^a-z])${escapeRe(w)}`, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(lower)) && hits.length < 12) hits.push(m.index);
    }
    hits.sort((a, b) => a - b);
    let lastEnd = -1;
    for (const at of hits) {
      if (passages >= MAX_PASSAGES) break;
      const start = Math.max(0, at - PASSAGE_RADIUS);
      if (start < lastEnd) continue;
      const end = Math.min(text.length, at + PASSAGE_RADIUS);
      lastEnd = end;
      const chunk = text.slice(start, end);
      if (!yearList.some((y) => chunk.includes(y)) && !doc.transcript) {
        // A document passage must be about the years in question (a lease's start date, a 2023 note).
        if (!/\b(?:19|20)\d{2}\b/.test(chunk)) continue;
      }
      const clean = screened(chunk, input.screen);
      if (!clean) continue;
      passages++;
      dN++;
      refs.set(`D${dN}`, {
        id: `D${dN}`, kind: doc.transcript ? "transcript" : "document", text: clean,
        meta: { documentId: doc.id, ...(doc.transcript ? { spoken: true as const } : {}), label: doc.name },
      });
    }
  }

  // R — the broker's settled conflicts, with no private side.
  for (const d of input.discrepancies) {
    if (!(d.status === "resolved" || d.status === "accepted")) continue;
    if (d.privateSide || d.crmMerge) continue;
    if (!about(`${d.field} ${d.brokerNotes ?? ""} ${d.sellerResponse ?? ""}`)) continue;
    const parts = [`${d.field}: ${d.interviewValue ?? "—"} vs ${d.documentValue ?? "—"}${d.resolvedValue ? `; settled at ${d.resolvedValue}` : ""}.`];
    if (d.brokerNotes && d.brokerNotes.trim()) parts.push(`Resolution note: ${d.brokerNotes.trim()}`);
    if (d.sellerResponse && d.sellerResponse.trim() && !GENERIC_HANDBACK.test(d.sellerResponse.trim())) parts.push(`The owner's answer: ${d.sellerResponse.trim()}`);
    const text = screened(parts.join("\n"), input.screen);
    if (!text) continue;
    rN++;
    refs.set(`R${rN}`, {
      id: `R${rN}`, kind: "discrepancy", text: text.slice(0, MESSAGE_CHARS),
      meta: { discrepancyId: d.id, ...(d.brokerNotes && d.brokerNotes.trim() ? { internal: true as const } : {}), label: "Your resolution note (internal)" },
    });
  }

  const hints = input.hints.filter((h) => about(h)).slice(0, 20);
  const digest = createHash("sha256")
    .update(JSON.stringify(Array.from(refs.values()).map((r) => [r.kind, r.text, r.meta.documentId ?? r.meta.factKey ?? r.meta.sessionId ?? r.meta.discrepancyId ?? ""])))
    .digest("hex")
    .slice(0, 16);
  return { refs, hints, digest };
}

// ── Loading the rows ─────────────────────────────────────────────────────

/** Read a deal's sessions, documents and settled conflicts, then build the evidence. */
export async function loadFigureEvidence(dealId: string, targets: EvidenceTarget[], ctx: { facts: Record<string, unknown>; screen: FigureScreenCtx; hints: string[] }): Promise<FigureEvidence> {
  const { db } = await import("../../db");
  const { documents, interviewSessions, discrepancies } = await import("@shared/schema");
  const { eq } = await import("drizzle-orm");
  const { figureCitableDocument } = await import("@shared/figure-layer");
  const { discrepancyHasPrivateSide } = await import("@shared/discrepancy-sides");
  const { sessionModeOf } = await import("../../interview/session-mode");
  const [docRows, sessionRows, discRows] = await Promise.all([
    db.select({
      id: documents.id, name: documents.name, category: documents.category, subcategory: documents.subcategory, visibility: documents.visibility,
      sourceKind: documents.sourceKind, fileUrl: documents.fileUrl, extractedText: documents.extractedText,
    }).from(documents).where(eq(documents.dealId, dealId)),
    db.select().from(interviewSessions).where(eq(interviewSessions.dealId, dealId)),
    db.select().from(discrepancies).where(eq(discrepancies.dealId, dealId)),
  ]);
  const docs: EvidenceDocument[] = docRows.map((d: any) => {
    const transcriptKind = ["call", "video_call", "email"].includes(String(d.sourceKind ?? "")) || ["transcripts", "email"].includes(String(d.category ?? ""));
    return {
      id: d.id, name: d.name ?? "",
      citable: figureCitableDocument(d),
      transcript: transcriptKind && d.visibility !== "broker_only" && String(d.sourceKind ?? "") !== "crm",
      text: d.extractedText ?? null,
    };
  });
  const sessions: EvidenceSession[] = sessionRows.map((s: any) => {
    const meta = (s.extractedInfo ?? {}) as Record<string, unknown>;
    return {
      id: s.id, mode: sessionModeOf(s), messages: Array.isArray(s.messages) ? s.messages : [],
      retracted: Array.isArray(meta._retracted) ? (meta._retracted as Array<{ key: string; value: string }>) : [],
      at: s.lastActivityAt ? new Date(s.lastActivityAt).toISOString() : null,
    };
  });
  const discs: EvidenceDiscrepancy[] = discRows.map((d: any) => {
    const p = discrepancyHasPrivateSide(d);
    const crm = /crm/i.test(JSON.stringify(d.sideSources ?? {}));
    return {
      id: d.id, field: d.field ?? "", status: d.status, source: d.source,
      interviewValue: d.interviewValue, documentValue: d.documentValue, brokerNotes: d.brokerNotes, sellerResponse: d.sellerResponse, resolvedValue: d.resolvedValue,
      privateSide: p.interview || p.document, crmMerge: d.source === "merge" && crm,
    };
  });
  return buildFigureEvidence({ targets, facts: ctx.facts, sessions, documents: docs, discrepancies: discs, screen: ctx.screen, hints: ctx.hints });
}
