/**
 * guards — what may never reach a buyer through a figure note or any string
 * of the figure layer (spec §9.5, D23). No AI here, ever: edit and serve
 * paths use only these rules plus the last build's stored keep-out snapshot
 * (cim_figure_state.keep_out); they never call keepOutFor (a paid review).
 *
 * The screen context: the keep-out names from the broker's private notes,
 * the last build's AI keep-out names, the seller's keep-out requests,
 * the confidential holds of the facts, the deal's staff (staff-private
 * matters and staff names), and sensitive (health / personal) detail.
 *
 *   holdReason / holdsText  one rule set for every buyer string (D23)
 *   guardFigureNote         the AI pass's 11 guards (a failure = no note)
 *   guardBrokerText         the broker's own words (edits, hint-based and
 *                           broker-written notes): the privacy guards block,
 *                           an unknown figure only warns ("Your figure")
 */
import { keepOutFromNotes, mentionsHeldPerson, hasSensitiveDetail, screenFactsForCim } from "../sensitive-facts";
import { includedStaffPrivate, screenStaffPrivateText, staffContextFrom, type StaffContext } from "../staff-private";
import { carriesPrivateDetail, getSellerKeepOut, type SellerKeepOutEntry } from "../../interview/seller-keep-out";
import { isKnownFigure, knownFiguresFrom, parseFigures, type Figure } from "../figure-check";
import { INTERNAL_WORDING } from "../dd-enrichment-wording";
import { blindPlaceholders, findBlindLeaks, type BlindTerm } from "@shared/blind-guard";
import { dollars, percentOf } from "@shared/figure-compare";
import type { StringScreen } from "@shared/figure-strings";

export interface FigureScreenCtx {
  heldNames: string[];
  keepOut: SellerKeepOutEntry[];
  staff: StaffContext;
  included: Set<string>;
  /**
   * People the staff facts list with a role ("Maria Moretti (spouse,
   * bookkeeper)") who aren't the owner: notes never name them, even when
   * they share the owner's surname (staffContextFrom counts family as owners).
   */
  familyStaff?: string[];
}

const PERSON_WITH_ROLE = /\b([A-Z][a-z]+(?:[-'][A-Z][a-z]+)?(?:\s+[A-Z][a-z]+(?:[-'][A-Z][a-z]+)?){1,2})\s*\(/g;
const STAFF_FACT_KEY = /employee|staff|team|management|people|personnel|manager|family/i;
const OWNER_FACT_KEY = /^(?:ownerName|ownerNames|sellerName|owners?|principalOwner|ownerFullName)$/i;

/** Named people in the staff facts who aren't the owner (see familyStaff). Pure. */
export function familyStaffFrom(info: Record<string, unknown>): string[] {
  // Every word of the owner facts ("Harjit and Surinder Grewal" → harjit, surinder, grewal).
  const ownerWords = new Set<string>();
  for (const [k, v] of Object.entries(info)) {
    if (!OWNER_FACT_KEY.test(k) || typeof v !== "string") continue;
    for (const w of v.toLowerCase().split(/[^a-z'-]+/)) if (w.length >= 2) ownerWords.add(w);
  }
  const out = new Set<string>();
  for (const [k, v] of Object.entries(info)) {
    if (k.startsWith("_") || !STAFF_FACT_KEY.test(k) || typeof v !== "string") continue;
    for (const m of Array.from(v.matchAll(PERSON_WITH_ROLE))) {
      const name = m[1].trim();
      // The owner, however the facts spell them, may be named.
      if (name.toLowerCase().split(/\s+/).every((w) => ownerWords.has(w))) continue;
      out.add(name);
    }
  }
  return Array.from(out);
}

/** The screen context for a deal, from its facts and the last build's stored keep-out names. No AI. */
export function screenCtxFor(info: Record<string, unknown> | null | undefined, stored?: { names?: string[] } | null): FigureScreenCtx {
  const facts = (info ?? {}) as Record<string, unknown>;
  const fromNotes = keepOutFromNotes(facts);
  let heldNames: string[] = [];
  try {
    const pairs = Object.entries(facts).filter(([k]) => !k.startsWith("_"));
    heldNames = screenFactsForCim(pairs, fromNotes).heldNames;
  } catch {
    heldNames = [];
  }
  return {
    heldNames: Array.from(new Set([...(fromNotes.names ?? []), ...(stored?.names ?? []), ...heldNames].filter((n) => typeof n === "string" && n.trim().length > 1))),
    keepOut: getSellerKeepOut(facts),
    staff: staffContextFrom(facts),
    included: includedStaffPrivate(facts),
    familyStaff: familyStaffFrom(facts),
  };
}

function wordRe(name: string): RegExp {
  return new RegExp(`(?:^|[^A-Za-z])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[^A-Za-z]|$)`);
}

export type HoldKind = "held_name" | "keep_out" | "staff_private" | "staff_name" | "sensitive";
export interface Hold {
  kind: HoldKind;
  name?: string;
}

/**
 * Why a text must not reach a buyer, or null when it may. `owners` = the
 * owner's own name is allowed (Full / DD notes; never in the Blind CIM).
 */
export function holdReason(text: string, ctx: FigureScreenCtx, opts: { owners?: boolean } = {}): Hold | null {
  const t = String(text ?? "");
  if (!t.trim()) return null;
  const held = mentionsHeldPerson(t, ctx.heldNames);
  if (held) return { kind: "held_name", name: held };
  for (const e of ctx.keepOut) if (carriesPrivateDetail(t, e)) return { kind: "keep_out" };
  if (screenStaffPrivateText(t, ctx.staff, ctx.included).held.length > 0) return { kind: "staff_private" };
  const ownerWords = new Set(ctx.staff.ownerNames);
  for (const name of ctx.staff.staffNames) {
    const words = name.toLowerCase().split(/\s+/);
    if (opts.owners && words.every((w) => ownerWords.has(w))) continue;
    if (wordRe(name).test(t)) return { kind: "staff_name", name };
  }
  for (const name of ctx.familyStaff ?? []) {
    if (ctx.staff.staffNames.includes(name)) continue;
    if (wordRe(name).test(t)) return { kind: "staff_name", name };
  }
  if (hasSensitiveDetail(t)) return { kind: "sensitive" };
  return null;
}

/** The hold as a short reason (logs, the workspace's "A suggested note was dropped: …"). */
export function holdsText(text: string, ctx: FigureScreenCtx, opts: { owners?: boolean } = {}): string | null {
  const h = holdReason(text, ctx, opts);
  if (!h) return null;
  switch (h.kind) {
    case "held_name": return `names someone kept out of the CIM (${h.name})`;
    case "keep_out": return "carries a detail the seller asked to keep out of the CIM";
    case "staff_private": return "carries a private staff matter";
    case "staff_name": return `names a staff member (${h.name})`;
    case "sensitive": return "carries a personal or health detail";
  }
}

/** The D23 string pipeline's screen for buyer strings of this deal. */
export function stringScreenFor(ctx: FigureScreenCtx, opts: { owners?: boolean } = {}): StringScreen {
  return { keep: (text: string) => holdsText(text, ctx, opts) === null };
}

// ── Shared checks ────────────────────────────────────────────────────────

/** Wording about how the memorandum was made — never in a buyer note (guard 9). */
const PROCESS_WORDS = /\b(?:interview(?:ed|s)?|broker'?s?|cimple|crm|transcripts?|the analysis|our analysis|call notes?)\b/i;

export function internalWordingIn(text: string): string | null {
  const t = String(text ?? "");
  const a = t.match(INTERNAL_WORDING);
  if (a) return a[0];
  const b = t.match(PROCESS_WORDS);
  return b ? b[0] : null;
}

/** Sentences in a note (a figure's decimal point or "Inc." never splits one). */
export function sentenceCount(text: string): number {
  const t = String(text ?? "").trim();
  if (!t) return 0;
  const cuts = t.match(/[.!?](?=\s+["“(]?[A-Z0-9$])/g) ?? [];
  return cuts.length + 1;
}

/** Normalised for the verbatim-quote check: case, whitespace, quotes, dashes. */
export function normalizeQuote(s: string): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[‘’‚‛′`]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐‑‒–—―−]/g, "-")
    .replace(/…/g, "...")
    .replace(/(\d),(?=\d{3}\b)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Money and percentages in a text, plus plain numbers big enough to be amounts (never a bare year). */
function checkableFigures(text: string): Figure[] {
  return parseFigures(text).filter((f) => {
    if (f.kind === "percent") return true;
    if (f.kind === "money") return f.value !== 0;
    if (Number.isInteger(f.value) && f.value >= 1900 && f.value <= 2100 && !f.text.includes(",")) return false;
    return Math.abs(f.value) >= 1000 || f.text.includes(",");
  });
}

/** The candidate's own numbers as text the figure guard can read (values, change, its percentage). */
export function candidateFigureText(c: FigureGuardCandidate): string {
  const out: string[] = [dollars(c.value)];
  if (typeof c.fromValue === "number") {
    out.push(dollars(c.fromValue));
    const d = Math.abs(c.value) - Math.abs(c.fromValue);
    out.push(dollars(d));
    const pct = percentOf(d, c.fromValue, "change");
    if (pct) out.push(pct);
    if (c.fromValue !== 0) {
      const raw = (Math.abs(d) / Math.abs(c.fromValue)) * 100;
      out.push(`${raw.toFixed(0)}%`, `${raw.toFixed(1)}%`);
    }
  }
  if (typeof c.other === "number") {
    out.push(dollars(c.other));
    const d = Math.abs(c.other) - Math.abs(c.value);
    out.push(dollars(d));
    const pct = percentOf(d, c.value, "difference");
    if (pct) out.push(pct);
  }
  return out.join(" · ");
}

/** The first figure in `text` that isn't in `known` (null = all known). */
export function unknownFigure(text: string, knownText: string): string | null {
  const known = knownFiguresFrom(knownText);
  for (const f of checkableFigures(text)) {
    if (!isKnownFigure(f, known, { scaleVariants: true })) return f.text;
  }
  return null;
}

/** Why a blind wording can't be used (null = it can). */
export function blindProblem(blindText: string, ctx: Pick<FigureGuardCtx, "blindTerms" | "lineLabels" | "blindWords">): string | null {
  const t = String(blindText ?? "");
  if (!t.trim()) return null;
  const leaks = findBlindLeaks(t, ctx.blindTerms ?? []);
  if (leaks.length > 0) return leaks[0];
  const ph = blindPlaceholders(t);
  if (ph.length > 0) return ph[0];
  const blindWords = new Set((ctx.blindWords ?? []).map((w) => w.toLowerCase()));
  for (const label of ctx.lineLabels ?? []) {
    const l = label.replace(/\s*\([^)]*\)/g, "").trim();
    if (l.length < 4 || blindWords.has(l.toLowerCase())) continue;
    if (new RegExp(`(?:^|[^a-z])${l.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[^a-z]|$)`).test(t.toLowerCase())) return label;
  }
  return null;
}

// ── The AI pass's guards (§9.5, in order) ───────────────────────────────────

export interface FigureGuardCandidate {
  id: string;
  value: number;
  fromValue?: number;
  other?: number;
}

export interface FigureGuardCtx {
  screen: FigureScreenCtx;
  /** blindLeakTerms(deal, { codename }) — what would identify the business in the Blind CIM. */
  blindTerms: BlindTerm[];
  /** The analysis's own line labels (a blind wording must not use them). */
  lineLabels: string[];
  /** Category words a blind wording may use ("rent", "operating expenses"). */
  blindWords: string[];
}

export interface RawFigureNote {
  candidateId: string;
  status: "explained" | "no_reason_on_file";
  text?: string | null;
  blindText?: string | null;
  sources?: Array<{ ref: string; quote: string }>;
}

export type FigureGuardResult =
  | { ok: true; text: string; blindText: string | null; sources: Array<{ ref: string; quote: string }>; blindDropped?: string }
  | { ok: false; why: string };

const MAX_NOTE = 320;

/**
 * The 11 guards on one AI note. A failure turns the candidate into "no reason
 * on file" (logged for the workspace as "A suggested note was dropped: …").
 * Guard 11 only takes the blind wording away; the named note stands.
 */
export function guardFigureNote(
  note: RawFigureNote,
  candidate: FigureGuardCandidate,
  evidence: { refs: Map<string, { text: string }> },
  ctx: FigureGuardCtx,
): FigureGuardResult {
  if (note.status !== "explained") return { ok: false, why: "no reason on file" };
  const text = String(note.text ?? "").replace(/\s+/g, " ").trim();
  const sources = (note.sources ?? []).filter((s) => s && typeof s.ref === "string" && typeof s.quote === "string");
  // 1. A reason needs words and a source.
  if (!text) return { ok: false, why: "no wording" };
  if (sources.length === 0) return { ok: false, why: "it cites nothing" };
  // 2. Every source is in this build's evidence, quoted word for word.
  for (const s of sources) {
    const ref = evidence.refs.get(s.ref);
    if (!ref) return { ok: false, why: `it cites ${s.ref}, which Cimple didn't give it` };
    const q = normalizeQuote(s.quote);
    if (q.length < 12) return { ok: false, why: "a quote is too short to check" };
    if (!normalizeQuote(ref.text).includes(q)) return { ok: false, why: `its quote isn't in ${s.ref}` };
  }
  // 3. Every figure is the candidate's or in a quote.
  const knownText = [candidateFigureText(candidate), ...sources.map((s) => s.quote)].join("\n");
  const stray = unknownFigure(text, knownText);
  if (stray) return { ok: false, why: `${stray} isn't in the figures or the quoted sources` };
  // 4–8. Held / keep-out names, staff-private matters, staff names (owners allowed in named notes), health, kept-out topics.
  const hold = holdsText(text, ctx.screen, { owners: true });
  if (hold) return { ok: false, why: `it ${hold}` };
  // 9. No wording about how the memorandum was made.
  const internal = internalWordingIn(text);
  if (internal) return { ok: false, why: `it uses internal wording ("${internal}")` };
  // 10. At most two sentences, 320 characters.
  if (text.length > MAX_NOTE) return { ok: false, why: "it is longer than 320 characters" };
  if (sentenceCount(text) > 2) return { ok: false, why: "it is longer than two sentences" };
  // 11. The blind wording: no identifying word, placeholder or analysis line label — else not shown blind.
  let blindText: string | null = String(note.blindText ?? "").replace(/\s+/g, " ").trim() || null;
  let blindDropped: string | undefined;
  if (blindText) {
    const problem =
      blindText.length > MAX_NOTE || sentenceCount(blindText) > 2 ? "too long"
      : unknownFigure(blindText, knownText) ? "a figure that isn't in the sources"
      : holdsText(blindText, ctx.screen, { owners: false }) ? "a name or private detail"
      : internalWordingIn(blindText) ? "internal wording"
      : blindProblem(blindText, ctx);
    if (problem) {
      blindDropped = problem;
      blindText = null;
    }
  }
  return { ok: true, text, blindText, sources, ...(blindDropped ? { blindDropped } : {}) };
}

// ── The broker's own words ──────────────────────────────────────────────────

export type BrokerTextResult =
  | { ok: true; warnings: Array<{ field: "text" | "blindText"; message: string }> }
  | { ok: false; field: "text" | "blindText"; message: string };

function holdMessage(h: Hold): string {
  switch (h.kind) {
    case "staff_name": return `This names ${h.name}, a staff member. Notes never name staff. Use the role instead.`;
    case "held_name": return "This names someone the seller asked to keep out of the CIM.";
    case "keep_out": return "This carries something the seller asked to keep out of the CIM.";
    case "staff_private": return "This mentions a private staff matter. Notes never carry those; they stay out of every version of the CIM.";
    case "sensitive": return "This mentions a personal or health detail. Notes never carry those.";
  }
}

/**
 * The broker's note text (an edit, a note from Cimple's hint, a note they
 * write): the privacy guards (4–9) on the named wording — the owner may be
 * named — and guard 11 on the blind wording. A figure that isn't in the
 * figures or the sources only warns ("Your figure"): the broker may state one.
 */
export function guardBrokerText(
  text: string,
  blindText: string | null | undefined,
  ctx: FigureGuardCtx,
  known?: { candidate?: FigureGuardCandidate; quotes?: string[] },
): BrokerTextResult {
  const t = String(text ?? "").trim();
  if (!t) return { ok: false, field: "text", message: "Write what buyers should read." };
  if (t.length > MAX_NOTE) return { ok: false, field: "text", message: "Keep it under 320 characters: two short sentences at most." };
  const h = holdReason(t, ctx.screen, { owners: true });
  if (h) return { ok: false, field: "text", message: holdMessage(h) };
  const internal = internalWordingIn(t);
  if (internal) return { ok: false, field: "text", message: `Buyers read this note. Leave out how the CIM was put together (“${internal}”).` };
  const b = String(blindText ?? "").trim();
  if (b) {
    if (b.length > MAX_NOTE) return { ok: false, field: "blindText", message: "Keep the blind wording under 320 characters." };
    const bh = holdReason(b, ctx.screen, { owners: false });
    if (bh) return { ok: false, field: "blindText", message: holdMessage(bh) };
    const leak = blindProblem(b, ctx);
    if (leak) return { ok: false, field: "blindText", message: `This would show “${leak}” in the Blind CIM. Change the blind wording or turn it off for the Blind CIM.` };
    const bi = internalWordingIn(b);
    if (bi) return { ok: false, field: "blindText", message: `Buyers read this note. Leave out how the CIM was put together (“${bi}”).` };
  }
  const warnings: Array<{ field: "text" | "blindText"; message: string }> = [];
  if (known?.candidate) {
    const knownText = [candidateFigureText(known.candidate), ...(known.quotes ?? [])].join("\n");
    const stray = unknownFigure(t, knownText);
    if (stray) warnings.push({ field: "text", message: `Your figure: ${stray} isn't in the CIM's figures or the quoted sources. Check it before buyers see it.` });
  }
  return { ok: true, warnings };
}
