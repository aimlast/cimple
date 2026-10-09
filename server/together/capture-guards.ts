/**
 * The guards between the extraction call and the deal's facts
 * (specs/together.md §5.6). Pure — the facts and the conversation are
 * passed in. In order; every drop is recorded with a reason code:
 *
 *  1. shape — a writable member of a checklist item (an add-back item is
 *     moved to its neutral key in step 3); aliases and the broker's own
 *     computations (SDE, adjusted earnings) are refused;
 *  2. quote and speaker — the quote must be in the cited NEW lines; only the
 *     seller's lines become the seller's facts; an unknown speaker's answer
 *     is HELD as a possible answer; a broker statement counts only with the
 *     seller's agreement after it; typed lines are the broker's note;
 *  3. normalisation (the interview's guardNormalisationFields);
 *  4–8. the interview's grounding, numeric, date and legal guards on the
 *     seller's words of this part;
 *  9. keep-out (what the seller asked to keep out of the book) and private
 *     matters;
 *  10. withdrawals; 11. "doesn't know" (a mark, never a value);
 *  12. what the broker said with no reply (shown, never filed).
 */
import type { SpeakerRole } from "@shared/together";
import { CIM_SECTIONS } from "@shared/schema";
import {
  applyGroundingGuard,
  applyNumericFidelityGuard,
  canonicalFieldName,
  mergeExtractedFields,
  SOURCE_META_KEYS,
  typedNumericValues,
  type FieldChange,
} from "../interview/info-merger";
import { applyDateFidelityGuard, applyLegalGroundingGuard, type Retraction } from "../interview/fact-guards";
import { addbackItemKey, guardNormalisationFields, type GuardableField } from "../interview/reply-guards";
import { carriesPrivateDetail, HELD_BACK_NOTE_REASON, SELLER_KEEP_OUT_REASON, type SellerKeepOutEntry } from "../interview/seller-keep-out";
import { BROKER_WORK_KEY_RE } from "../interview/source-privacy";
import type { CaptureCatalogue, CaptureOutput } from "./capture";

export interface GuardLine {
  seq: number;
  role: SpeakerRole;
  typed: boolean;
  text: string;
}

export type DropCode =
  | "unknown_key"
  | "broker_work"
  | "bad_other_fact"
  | "no_quote"
  | "quote_not_found"
  | "not_new"
  | "not_seller"
  | "not_typed"
  | "restatement"
  | "normalisation"
  | "keep_out"
  | "empty";

export interface GuardedAnswer {
  key: string;
  itemId: string | null;
  value: string;
  quote: string;
  /** What the source records as the seller's words ("The seller agreed: …" for a broker statement). */
  excerpt: string;
  lines: number[];
  speaker: "seller" | "broker_confirmed";
  confidence: "confirmed" | "approximate" | "inferred";
  verify?: "number" | "date" | "legal";
}

export interface HeldSuggestion {
  itemId: string;
  memberKey: string;
  value: string;
  quote: string;
  lines: number[];
  confidence: "confirmed" | "approximate";
  speaker: "seller" | "broker_confirmed";
}

export interface GuardedCapture {
  spoken: GuardedAnswer[];
  typed: Array<{ key: string; itemId: string | null; value: string; lines: number[] }>;
  suggestions: HeldSuggestion[];
  brokerUnconfirmed: Array<{ key: string; itemId: string | null; value: string; quote: string }>;
  notKnown: Array<{ key: string; itemId: string | null; whoHasIt?: string; quote: string }>;
  privateNotes: Array<{ note: string; reason: string }>;
  keepOut: SellerKeepOutEntry[];
  retractions: Retraction[];
  otherFacts: Array<{ key: string; label: string; sectionKey: string; value: string; quote: string; lines: number[]; confidence: "confirmed" | "approximate" }>;
  dropped: Array<{ key: string; code: DropCode }>;
  followUp: CaptureOutput["followUp"];
  topicSections: string[];
}

export interface GuardContext {
  newLines: GuardLine[];
  catalogue: CaptureCatalogue;
  /** The seller-safe facts (what was on file before). */
  sellerFacts: Record<string, unknown>;
  /** The sitting's seller text so far (≤ 6,000 chars). */
  sessionSellerText?: string;
  onFileText?: string;
  keepOut: SellerKeepOutEntry[];
  today?: Date;
}

/** "yes", "right", "that's correct"… — the seller agreeing with what the broker said. */
export const AGREE_RE = /^\s*(yes|yeah|yep|yup|right|correct|exactly|that'?s (right|correct|it)|mm-?hmm|sure|about that|roughly|that sounds right)\b/i;

const OTHER_KEY_RE = /^[a-z][A-Za-z0-9]{2,47}$/;
const SECTION_KEYS = new Set(CIM_SECTIONS.map((s) => s.key as string));

const tokens = (s: string): string[] => (s.toLowerCase().replace(/[’‘]/g, "'").match(/[a-z0-9$%][a-z0-9$%'.]*/g) ?? []).map((t) => t.replace(/[.']+$/, "")).filter(Boolean);

/** Is the quote in these lines (normalised tokens, overlap ≥ 0.8)? */
export function quoteFound(quote: string, lines: string[]): boolean {
  const q = tokens(quote);
  if (q.length === 0) return false;
  const have = new Set(lines.flatMap(tokens));
  return q.filter((t) => have.has(t)).length / q.length >= 0.8;
}

const isSellerLine = (l: GuardLine) => !l.typed && l.role === "seller";

const PRIVATE_REASON: Record<CaptureOutput["private"][number]["reason"], string> = {
  staff_private: "a private staff matter — for the broker, kept out of the CIM",
  seller_asked: SELLER_KEEP_OUT_REASON,
  health_family: "a personal matter said on the call — kept out of the CIM",
  other: "said on the call — kept private for you",
};

/** Step 1: a key the board may file under (or an add-back item, moved later). */
function shapeOf(rawKey: string, catalogue: CaptureCatalogue): { key: string; itemId: string | null } | { drop: DropCode } {
  const key = canonicalFieldName(rawKey);
  const itemId = catalogue.byKey.get(key) ?? catalogue.byKey.get(rawKey) ?? null;
  if (itemId) return { key: catalogue.byKey.has(key) ? key : rawKey, itemId };
  if (addbackItemKey(rawKey)) return { key: rawKey, itemId: catalogue.byKey.get("addbacks") ?? null };
  if (BROKER_WORK_KEY_RE.test(key) || BROKER_WORK_KEY_RE.test(rawKey)) return { drop: "broker_work" };
  return { drop: "unknown_key" };
}

/** The guards. Pure. */
export function guardCaptured(output: CaptureOutput, ctx: GuardContext): GuardedCapture {
  const out: GuardedCapture = {
    spoken: [],
    typed: [],
    suggestions: [],
    brokerUnconfirmed: [],
    notKnown: [],
    privateNotes: [],
    keepOut: [],
    retractions: [],
    otherFacts: [],
    dropped: [],
    followUp: output.followUp,
    topicSections: output.topicSections.filter((s) => SECTION_KEYS.has(s)),
  };
  const bySeq = new Map(ctx.newLines.map((l) => [l.seq, l] as const));
  const sellerText = ctx.newLines.filter(isSellerLine).map((l) => l.text).join("\n");
  const brokerText = ctx.newLines.filter((l) => !l.typed && l.role === "broker").map((l) => l.text).join("\n");

  // ── 1–2: shape, quote and speaker ──
  type Candidate = { key: string; itemId: string | null; value: string; quote: string; lines: number[]; speaker: "seller" | "broker_confirmed"; confidence: "confirmed" | "approximate"; basis: "verbatim" | "computed" };
  const candidates: Candidate[] = [];
  for (const a of output.answers) {
    const shape = shapeOf(a.key, ctx.catalogue);
    if ("drop" in shape) { out.dropped.push({ key: a.key, code: shape.drop }); continue; }
    if (!a.value.trim()) { out.dropped.push({ key: a.key, code: "empty" }); continue; }
    if (!a.quote.trim()) { out.dropped.push({ key: shape.key, code: "no_quote" }); continue; }
    const cited = a.lines.map((n) => bySeq.get(n));
    if (cited.length === 0 || cited.some((l) => !l)) { out.dropped.push({ key: shape.key, code: "not_new" }); continue; }
    const lines = cited as GuardLine[];
    if (!quoteFound(a.quote, lines.map((l) => l.text))) { out.dropped.push({ key: shape.key, code: "quote_not_found" }); continue; }
    if (a.speaker === "typed") {
      if (!lines.every((l) => l.typed)) { out.dropped.push({ key: shape.key, code: "not_typed" }); continue; }
      out.typed.push({ key: shape.key, itemId: shape.itemId, value: a.value, lines: a.lines });
      continue;
    }
    if (lines.some((l) => l.typed)) { out.dropped.push({ key: shape.key, code: "not_seller" }); continue; }
    const hold = () =>
      shape.itemId
        ? out.suggestions.push({ itemId: shape.itemId, memberKey: shape.key, value: a.value, quote: a.quote, lines: a.lines, confidence: a.confidence, speaker: a.speaker === "broker_confirmed" ? "broker_confirmed" : "seller" })
        : out.dropped.push({ key: shape.key, code: "unknown_key" });
    if (a.speaker === "seller") {
      if (lines.some((l) => l.role === "unknown")) { hold(); continue; }
      if (!lines.every(isSellerLine)) { out.dropped.push({ key: shape.key, code: "not_seller" }); continue; }
      candidates.push({ ...shape, value: a.value, quote: a.quote, lines: a.lines, speaker: "seller", confidence: a.confidence, basis: a.basis });
      continue;
    }
    // broker_confirmed: the broker's statement, then the seller agreeing (or saying the figure again).
    const brokerLines = lines.filter((l) => l.role === "broker");
    const unknownAround = ctx.newLines.some((l) => !l.typed && l.role === "unknown");
    if (brokerLines.length === 0) {
      if (lines.some((l) => l.role === "unknown") || unknownAround) { hold(); continue; }
      if (lines.every(isSellerLine)) { candidates.push({ ...shape, value: a.value, quote: a.quote, lines: a.lines, speaker: "seller", confidence: a.confidence, basis: a.basis }); continue; }
      out.dropped.push({ key: shape.key, code: "not_seller" });
      continue;
    }
    const lastBroker = Math.max(...brokerLines.map((l) => l.seq));
    const figures = typedNumericValues(a.value).map((t) => t.value);
    const agrees = ctx.newLines.filter(
      (l) => isSellerLine(l) && l.seq > lastBroker && (AGREE_RE.test(l.text) || (figures.length > 0 && typedNumericValues(l.text).some((t) => figures.some((f) => Math.abs(f - t.value) <= Math.max(1, Math.abs(f) * 0.01))))),
    );
    if (agrees.length === 0) {
      if (unknownAround) { hold(); continue; }
      out.brokerUnconfirmed.push({ key: shape.key, itemId: shape.itemId, value: a.value, quote: a.quote });
      continue;
    }
    const brokerWords = brokerLines.map((l) => l.text.trim()).join(" ");
    const sellerWords = agrees[0].text.trim();
    candidates.push({
      ...shape,
      value: a.value,
      quote: `The seller agreed: "${brokerWords.slice(0, 120)}" — "${sellerWords.slice(0, 80)}"`,
      lines: Array.from(new Set([...a.lines, agrees[0].seq])),
      speaker: "broker_confirmed",
      confidence: a.confidence,
      basis: a.basis,
    });
  }

  // ── 3: normalisation ──
  const fields: Record<string, GuardableField> = {};
  const meta = new Map<string, Candidate>();
  for (const c of candidates) {
    // (Two answers for one key in one part: the later one stands.)
    fields[c.key] = { value: c.value, confidence: c.confidence, source: "seller_statement", basis: c.basis };
    meta.set(c.key, c);
  }
  const normNotes: Array<{ note: string; reason: string }> = [];
  const before = new Set(Object.keys(fields));
  guardNormalisationFields(fields, normNotes);
  for (const k of Array.from(before)) if (!fields[k]) out.dropped.push({ key: k, code: "normalisation" });
  for (const k of Object.keys(fields)) {
    if (meta.has(k)) continue;
    // An add-back item moved to its neutral key: same line, same words.
    const from = Array.from(before).find((b) => addbackItemKey(b) === k);
    const m = from ? meta.get(from) : undefined;
    if (m) meta.set(k, { ...m, key: k });
  }
  out.privateNotes.push(...normNotes);

  // ── 4–8: the interview's guards on the seller's words of this part ──
  const newFields: Record<string, { value: string; confidence: "confirmed" | "inferred" | "approximate"; source: "seller_statement"; basis?: "verbatim" | "computed" | "inferred" }> = {};
  for (const [k, f] of Object.entries(fields)) newFields[k] = { value: f.value, confidence: f.confidence as "confirmed" | "approximate", source: "seller_statement", basis: (f.basis as "verbatim" | "computed") ?? "verbatim" };
  const conf: Record<string, string> = {};
  const { changes } = mergeExtractedFields(ctx.sellerFacts as never, newFields as never, conf);
  const verify = new Map<string, "number" | "date" | "legal">();
  const restated = new Set<string>();
  for (const f of applyGroundingGuard(changes, conf, sellerText)) {
    if (f.restatement) restated.add(f.fieldName);
    else verify.set(f.fieldName, "number");
  }
  for (const f of applyNumericFidelityGuard(changes, conf, sellerText, [])) if (!verify.has(f.fieldName)) verify.set(f.fieldName, "number");
  for (const f of applyDateFidelityGuard(changes, conf, {
    sellerMessage: sellerText,
    sessionSellerText: ctx.sessionSellerText ?? "",
    prevAiMessage: brokerText,
    onFileText: ctx.onFileText ?? "",
    existingKeys: Object.keys(ctx.sellerFacts),
    ...(ctx.today ? { today: ctx.today } : {}),
  })) {
    if (f.needsVerification || !f.corrected) verify.set(f.fieldName, "date");
  }
  for (const f of applyLegalGroundingGuard(changes, conf, brokerText || undefined)) verify.set(f.fieldName, "legal");
  const changeOf = new Map<string, FieldChange>(changes.map((c) => [c.fieldName, c]));

  // ── 9: keep-out ──
  const newKeepOut: SellerKeepOutEntry[] = [];
  for (const p of output.private) {
    if (p.reason === "seller_asked" && (p.keepOutTerms?.length || p.note)) newKeepOut.push({ detail: p.note, terms: (p.keepOutTerms ?? []).filter(Boolean), at: new Date().toISOString() });
  }
  const keepOut = [...ctx.keepOut, ...newKeepOut];
  out.keepOut = newKeepOut;

  for (const [rawKey, f] of Object.entries(fields)) {
    const key = canonicalFieldName(rawKey);
    const m = meta.get(rawKey) ?? meta.get(key);
    if (!m) continue;
    if (restated.has(key)) { out.dropped.push({ key, code: "restatement" }); continue; }
    const ch = changeOf.get(key);
    const value = (ch?.newValue ?? f.value).trim();
    const entry = keepOut.find((e) => carriesPrivateDetail(value, e));
    if (entry) {
      out.dropped.push({ key, code: "keep_out" });
      if (value.split(/\s+/).length > 8) out.privateNotes.push({ note: value, reason: HELD_BACK_NOTE_REASON });
      continue;
    }
    const v = verify.get(key);
    const confidence = (ch?.newConfidence ?? f.confidence) as GuardedAnswer["confidence"];
    out.spoken.push({
      key,
      itemId: m.itemId,
      value,
      quote: m.quote,
      excerpt: m.speaker === "broker_confirmed" ? m.quote : m.quote.slice(0, 200),
      lines: m.lines,
      speaker: m.speaker,
      confidence: confidence === "confirmed" || confidence === "approximate" || confidence === "inferred" ? confidence : "approximate",
      ...(v ? { verify: v } : {}),
    });
  }

  // ── also noted (a useful fact that fits no item) ──
  for (const o of output.otherFacts) {
    const key = o.key;
    if (!OTHER_KEY_RE.test(key) || key.startsWith("_") || SOURCE_META_KEYS.has(key) || BROKER_WORK_KEY_RE.test(key) || !SECTION_KEYS.has(o.sectionKey) || ctx.catalogue.byKey.has(key)) {
      out.dropped.push({ key, code: "bad_other_fact" });
      continue;
    }
    const lines = (o.lines ?? []).map((n) => bySeq.get(n)).filter((l): l is GuardLine => !!l);
    if (lines.length === 0 || !lines.every(isSellerLine) || !quoteFound(o.quote, lines.map((l) => l.text))) {
      out.dropped.push({ key, code: lines.some((l) => l.role === "unknown") ? "not_seller" : "quote_not_found" });
      continue;
    }
    if (keepOut.some((e) => carriesPrivateDetail(o.value, e))) { out.dropped.push({ key, code: "keep_out" }); continue; }
    out.otherFacts.push({ key, label: o.label || key, sectionKey: o.sectionKey, value: o.value, quote: o.quote, lines: lines.map((l) => l.seq), confidence: o.confidence });
  }

  // ── 10–13 ──
  for (const w of output.withdrawn) {
    const key = canonicalFieldName(w.key);
    if (!ctx.catalogue.byKey.has(key)) continue;
    out.retractions.push({ field: key, reason: w.quote ? `The seller withdrew it on the call: "${w.quote.slice(0, 120)}"` : "The seller withdrew it on the call" });
  }
  for (const n of output.notKnown) {
    const key = canonicalFieldName(n.key);
    const itemId = ctx.catalogue.byKey.get(key) ?? null;
    if (!itemId) continue;
    out.notKnown.push({ key, itemId, ...(n.whoHasIt ? { whoHasIt: n.whoHasIt } : {}), quote: n.quote });
  }
  for (const b of output.brokerUnconfirmed) {
    const key = canonicalFieldName(b.key);
    out.brokerUnconfirmed.push({ key, itemId: ctx.catalogue.byKey.get(key) ?? null, value: b.value, quote: b.quote });
  }
  for (const p of output.private) out.privateNotes.push({ note: p.note, reason: PRIVATE_REASON[p.reason] });
  return out;
}

/**
 * Held possible answers when the roles become known (§5.6 last paragraph;
 * no AI): an answer whose cited lines are now all the seller's is filed; one
 * citing the broker's lines becomes "you said … — the seller didn't confirm";
 * one still citing an unknown speaker stays held. Pure.
 */
export function promoteHeld(
  held: HeldSuggestion[],
  roleOf: (seq: number) => SpeakerRole,
): { file: HeldSuggestion[]; brokerUnconfirmed: HeldSuggestion[]; stillHeld: HeldSuggestion[] } {
  const file: HeldSuggestion[] = [];
  const brokerUnconfirmed: HeldSuggestion[] = [];
  const stillHeld: HeldSuggestion[] = [];
  for (const h of held) {
    const roles = h.lines.map(roleOf);
    if (roles.some((r) => r === "unknown")) stillHeld.push(h);
    else if (roles.every((r) => r === "seller")) file.push(h);
    else brokerUnconfirmed.push(h);
  }
  return { file, brokerUnconfirmed, stillHeld };
}
