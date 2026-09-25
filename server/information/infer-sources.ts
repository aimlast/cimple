/**
 * Traces facts collected before Cimple recorded provenance back to where they
 * most likely came from — at read time, never written to the deal.
 *
 * Most deals created before 2026-08-22 have no `_fieldSources` at all, and
 * facts recorded between then and per-session tracking say "interview" with
 * no session. Without this, the Information tab showed every such fact as
 * "Source not recorded" and every source with "0 facts".
 *
 * Evidence, strongest first (the first match wins):
 *   1. an interview session's confidence map has the key AND the seller's own
 *      words in that session contain the value → that session + turn;
 *   2. the intake questionnaire gave exactly this value → questionnaire;
 *   3. a document's extraction gave exactly this value → that document
 *      (per year for maps such as revenueByYear);
 *   4. the website scrape gave exactly this value → website;
 *   5. an interview session's confidence map has the key → that session;
 *   6. the seller's words in an interview contain the value → that session + turn.
 * Anything else stays unknown ("collected before source tracking").
 * Every inferred source carries `inferred: true`, which the UI shows.
 *
 * Pure — no I/O.
 */
import type { Document, InterviewSession } from "@shared/schema";
import { canonicalFieldName, isSourceKind, type FieldSource, type SourceKind } from "../interview/info-merger";
import { questionnaireFacts } from "../interview/questionnaire-facts";
import { websiteFactKey } from "./facts";

/** `inferred`: the whole source was traced. `sessionLinked`: a recorded interview source whose session was traced. */
export type InferredFieldSource = FieldSource & { inferred?: boolean; sessionLinked?: boolean };

type Info = Record<string, unknown>;

const LIVE = new Set(["interview", "call", "video_call"]);

/** True when a recorded source says nothing useful (missing, junk, or the legacy stub). */
export function isUntrackedSource(src: FieldSource | undefined | null): boolean {
  return !src || !isSourceKind(src.source) || (src.source === "system" && src.note === "Recorded before sources were tracked");
}

// ── value comparison ─────────────────────────────────────────────────────

function flat(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(flat).join(", ");
  if (typeof v === "object") {
    return Object.entries(v as Info)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, x]) => `${k}: ${flat(x)}`)
      .join("; ");
  }
  return String(v);
}

function norm(v: unknown): string {
  return flat(v)
    .toLowerCase()
    .replace(/(\d)[,.](?=\d{3}\b)/g, "$1") // thousands separators: "2,650" = "2650"
    .replace(/[\s,;:.!?"'’“”()\-–—]+/g, " ")
    .trim();
}

/** A value that is essentially one number ("$1,750,000", "1.75M", 1750000) → that number. */
export function numericValue(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^(?:c?\$|cad|usd)?\s*(-?[\d,]*\.?\d+)\s*(k|m|mm|million|thousand|b|billion)?\s*(?:cad|usd)?$/i);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] || "").toLowerCase();
  const mult = unit === "k" || unit === "thousand" ? 1e3 : unit === "m" || unit === "mm" || unit === "million" ? 1e6 : unit === "b" || unit === "billion" ? 1e9 : 1;
  return n * mult;
}

export function sameValue(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  const na = numericValue(a);
  const nb = numericValue(b);
  if (na !== null && nb !== null) return Math.abs(na - nb) < 0.005 * Math.max(1, Math.abs(na));
  const sa = norm(a);
  return sa.length > 0 && sa === norm(b);
}

/**
 * Where in the seller's words a value appears, if it clearly does. Numbers
 * need 3+ significant digits (a bare "5" or "2" proves nothing); text needs
 * 6+ characters and must appear whole.
 */
function mentionIn(textNorm: string, textNums: Set<number>, value: unknown): boolean {
  const n = numericValue(value);
  if (n !== null) {
    if (Math.abs(n) < 100) return false;
    return Array.from(textNums).some((t) => Math.abs(t - n) < 0.005 * Math.abs(n));
  }
  if (typeof value !== "string") return false;
  const v = norm(value);
  if (v.length < 6 || v.split(" ").length > 12) return false;
  return (" " + textNorm + " ").includes(" " + v + " ");
}

/** Every number written in a message ("$1.75M", "1,750,000", "40 hours"). */
function numbersIn(text: string): Set<number> {
  const out = new Set<number>();
  const re = /(?:c?\$\s*)?(\d[\d,]*\.?\d*)\s*(k|m|mm|million|thousand|b|billion)?\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const n = numericValue(`${m[1]}${m[2] ? m[2] : ""}`);
    if (n !== null) out.add(n);
  }
  return out;
}

// ── inputs ────────────────────────────────────────────────────────────────

interface SessionEvidence {
  id: string;
  kind: SourceKind;
  confidenceKeys: Set<string>;
  /** Seller turns: 1-based turn number, normalised text, numbers in it. */
  turns: Array<{ turn: number; text: string; nums: Set<number> }>;
  startedAt: number;
}

function sessionEvidence(sessions: InterviewSession[], kindOf: (s: InterviewSession) => SourceKind): SessionEvidence[] {
  return sessions
    .map((s) => {
      const meta = (s.extractedInfo as Info | null) || {};
      const conf = (meta._confidenceLevels as Record<string, unknown> | undefined) || {};
      const msgs = Array.isArray(s.messages) ? (s.messages as Array<{ role?: string; content?: unknown }>) : [];
      const turns: SessionEvidence["turns"] = [];
      let n = 0;
      for (const m of msgs) {
        if (m?.role !== "user") continue;
        n++;
        const raw = typeof m.content === "string" ? m.content : "";
        if (raw) turns.push({ turn: n, text: norm(raw), nums: numbersIn(raw) });
      }
      return { id: s.id, kind: kindOf(s), confidenceKeys: new Set(Object.keys(conf)), turns, startedAt: +new Date(s.startedAt) };
    })
    .sort((a, b) => a.startedAt - b.startedAt);
}

function firstMention(sessions: SessionEvidence[], value: unknown, only?: SessionEvidence): { session: SessionEvidence; turn: number } | null {
  for (const s of only ? [only] : sessions) {
    for (const t of s.turns) if (mentionIn(t.text, t.nums, value)) return { session: s, turn: t.turn };
  }
  return null;
}

/** A document's extracted value for a fact key (its own spelling or the canonical one). */
function docValue(data: Info, key: string): unknown {
  if (key in data) return data[key];
  for (const [k, v] of Object.entries(data)) if (canonicalFieldName(k) === key) return v;
  return undefined;
}

export interface InferInputs {
  info: Info;
  sources: Record<string, FieldSource>;
  factKeys: string[];
  documents: Document[];
  sessions: InterviewSession[];
  sessionKind: (s: InterviewSession) => SourceKind;
  questionnaire: { questionnaireData?: unknown; operationalSystems?: unknown; employeeChart?: unknown };
  scraped: Info | null;
}

/**
 * Sources for every fact key: the recorded source when it is complete, a
 * session-linked copy when an interview source lacks its session, or an
 * inferred one for untracked facts. Keys with no evidence are omitted.
 */
export function inferFieldSources(input: InferInputs): Record<string, InferredFieldSource> {
  const { info, sources, factKeys, documents } = input;
  const sessions = sessionEvidence(input.sessions, input.sessionKind);
  const docs = [...documents].sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt));
  const qFacts = new Map<string, string>();
  for (const [k, v] of questionnaireFacts(input.questionnaire)) if (!qFacts.has(k)) qFacts.set(k, v);
  const webFacts = new Map<string, unknown>();
  for (const [field, v] of Object.entries(input.scraped || {})) webFacts.set(websiteFactKey(field), v);

  const out: Record<string, InferredFieldSource> = {};
  for (const key of factKeys) {
    const recorded = sources[key];
    const value = info[key];

    // Recorded live-session source without its session (before per-session
    // tracking): link it to the session that captured the key — only ever a
    // session of the SAME kind. The kind was recorded; linking an "interview"
    // fact to a broker-led call would make the chip and the source list
    // disagree, so with no same-kind session it stays unlinked (it is then
    // counted under the "AI interview" row for pre-session facts).
    if (!isUntrackedSource(recorded)) {
      const pool = LIVE.has(recorded.source) && !recorded.sessionId && !recorded.documentId
        ? sessions.filter((s) => s.kind === recorded.source)
        : [];
      if (pool.length > 0) {
        const byConf = [...pool].reverse().find((s) => s.confidenceKeys.has(key));
        const mention = firstMention(pool, value, byConf);
        const session = byConf ?? mention?.session ?? pool[pool.length - 1];
        out[key] = {
          ...recorded,
          sessionId: session.id,
          ...(mention && mention.session === session && typeof recorded.turn !== "number" ? { turn: mention.turn } : {}),
          // The kind was recorded; only the session link is traced.
          sessionLinked: true,
        };
      } else {
        out[key] = recorded;
      }
      continue;
    }

    const confSession = sessions.find((s) => s.confidenceKeys.has(key));
    // 1. Interview captured the key and the seller said the value.
    if (confSession) {
      const m = firstMention(sessions, value, confSession);
      if (m) {
        out[key] = { source: confSession.kind, sessionId: confSession.id, turn: m.turn, inferred: true };
        continue;
      }
    }
    // 2. Questionnaire gave this exact value.
    const q = qFacts.get(key);
    if (q !== undefined && sameValue(q, value)) {
      out[key] = { source: "questionnaire", inferred: true };
      continue;
    }
    // 3. A document gave this exact value (maps: per year).
    const docMatch = matchDocument(docs, key, value);
    if (docMatch) {
      out[key] = { ...docMatch, inferred: true };
      continue;
    }
    // 4. The website scrape gave this exact value.
    if (webFacts.has(key) && sameValue(webFacts.get(key), value)) {
      out[key] = { source: "website", inferred: true };
      continue;
    }
    // 5. The interview captured the key (value since refined).
    if (confSession) {
      out[key] = { source: confSession.kind, sessionId: confSession.id, inferred: true };
      continue;
    }
    // 6. The seller said the value in an interview.
    const m = firstMention(sessions, value);
    if (m) {
      out[key] = { source: m.session.kind, sessionId: m.session.id, turn: m.turn, inferred: true };
      continue;
    }
  }
  return out;
}

function docKind(d: Document): SourceKind {
  const k = (d as { sourceKind?: unknown }).sourceKind;
  return isSourceKind(k) ? k : "document";
}

function matchDocument(docs: Document[], key: string, value: unknown): FieldSource | null {
  const isMap = !!value && typeof value === "object" && !Array.isArray(value);
  if (isMap) {
    // Every year/sub-key must be accounted for by some document.
    const years: Record<string, string> = {};
    let first: Document | null = null;
    for (const [sub, v] of Object.entries(value as Info)) {
      const d = docs.find((doc) => {
        const dv = docValue((doc.extractedData as Info | null) || {}, key);
        if (dv && typeof dv === "object" && !Array.isArray(dv)) return sameValue((dv as Info)[sub], v);
        return false;
      });
      if (!d) return null;
      years[sub] = d.id;
      first = first ?? d;
    }
    if (!first) return null;
    const ids = new Set(Object.values(years));
    return ids.size === 1 ? { source: docKind(first), documentId: first.id } : { source: docKind(first), documentId: first.id, years };
  }
  for (const d of docs) {
    const dv = docValue((d.extractedData as Info | null) || {}, key);
    if (dv !== undefined && sameValue(dv, value)) return { source: docKind(d), documentId: d.id };
  }
  return null;
}
