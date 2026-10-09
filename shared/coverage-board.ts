/**
 * The coverage board — ONE model of "what does the CIM still need from the
 * seller?", shared by every surface that shows interview coverage: the
 * "Interview together" board (live and checklist mode), the broker's panel in
 * the AI interview, the Overview's interview-outline card, the seller's
 * progress page and the seller's "What we've covered" panel. The server
 * builds it (server/interview/coverage-board.ts); this file holds the types
 * and the pure helpers both sides use (counts, the headline, copy, filters,
 * the stable list order, "what to ask next", the call sheet).
 *
 * Items, not keys: a board item is one group of alternatives ("busy and slow
 * months" answers seasonality / peak / slow), one ungrouped generic field,
 * one industry-checklist item, one broker-added or "also noted" item. Every
 * data point counts equally in the headline percent; CIM quality is shown
 * only as a label next to it.
 *
 * Pure: no server or browser imports.
 */
import type { SourceKind } from "./schema";
import type { CimReadiness } from "./cim-readiness";

export type CoverageItemStatus = "on_file" | "partial" | "verify" | "missing";
/** broker = everything; screen = "Seller can see this screen" (statuses from the broker view, every value from the seller-safe view); seller = statuses only. */
export type CoverageAudience = "broker" | "screen" | "seller";

export const COVERAGE_STATUSES: readonly CoverageItemStatus[] = ["on_file", "partial", "verify", "missing"];

export interface CoverageItemSource {
  kind: SourceKind | "unknown";
  /** "Call · Interview together — 9 Oct", "Document · 2024 Compilation.pdf", "Your note · during the call". */
  label: string;
  documentId?: string;
  at?: string;
  /** The seller's words, ≤ 200 chars. */
  excerpt?: string;
  speaker?: string;
  /** A broker-only row, the broker's notes, CRM — never sent to the screen or seller audience. */
  private?: boolean;
}

/** One key a filing or an edit may write, with its own meaning. writable=false for the broker's own computations (SDE…). */
export interface CoverageMember { key: string; label: string; writable: boolean }

export type CoverageMarkKind = "verify_later" | "note" | "asked" | "not_known" | "confirmed" | "doc_promised";

export interface CoverageItemMark { kind: CoverageMarkKind; note?: string; at: string }

export type CoverageReason =
  | { code: "lead"; leadKind: "crm" | "website" | "social" }
  | { code: "estimate" }
  | { code: "conflict"; a?: string; aSource?: string; b?: string; bSource?: string; privateSide: boolean }
  | { code: "marked" }
  | { code: "broker_notes" }
  | { code: "guard"; detail: "number" | "date" | "legal" }
  | { code: "routed" }
  | { code: "not_known"; whoHasIt?: string }
  | { code: "in_source"; sourceLabel: string; private: boolean }
  | { code: "partly_on_file"; onFile: string; missing: string };

export interface CoverageItem {
  /** `${sectionKey}:${members[0].key}` — unique on a board. */
  id: string;
  sectionKey: string;
  label: string;
  members: CoverageMember[];
  /** Members + aliases + the checklist's answeredByKey: what counts as answered. */
  readKeys: string[];
  /** The member/alias whose value is shown (edits target it). */
  valueKey: string | null;
  critical: boolean;
  /** "figures" = a question about the numbers (dd) — shown, never counted. */
  origin: "generic" | "industry" | "broker" | "noted" | "figures";
  status: CoverageItemStatus;
  reason: CoverageReason | null;
  /** Display text ≤ 280 chars; null for the seller audience always. */
  value: string | null;
  /** screen audience: on file, but only the broker can see it. */
  privateValue?: boolean;
  /** Money talk (add-backs, SDE, adjusted earnings): no value or reason on the screen audience. */
  moneyTalk?: boolean;
  source: CoverageItemSource | null;
  /** Suggested way to ask, spoken, one sentence. */
  ask: string;
  /** Why buyers care, ≤ 20 words. */
  why: string;
  estimate?: boolean;
  yourNote?: boolean;
  confirmedByYou?: boolean;
  filedAt?: string;
  filedInSittingId?: string;
  filedByChunkId?: string;
  suggestion?: { value: string; quote: string; chunkId: string; memberKey: string };
  marks: CoverageItemMark[];
  conflictId?: string;
}

/** A row shown, never counted: the item lives in another section. */
export interface CoverageReference {
  id: string; sectionKey: string; label: string; homeSectionKey: string; homeItemId: string;
}

export interface CoverageSection {
  key: string;
  title: string;
  order: number;
  importance: "critical" | "important" | "helpful";
  importanceReason: string;
  items: CoverageItem[];
  references: CoverageReference[];
  /** Origin "figures" items excluded. */
  counts: Record<CoverageItemStatus, number>;
  figureQuestions: number;
}

export interface CoverageTotals {
  items: number; on_file: number; partial: number; verify: number; missing: number;
  criticalItems: number; criticalOpen: number;
}

/** "Open questions": a conflict routed to the seller that no item shows. Never counted. */
export interface RoutedQuestion {
  discrepancyId: string; label: string; ask: string;
  raisedInSitting?: { at: string };
}

/** "Documents still needed" (read-only — the board never changes a request's status). */
export interface DocumentNeeded {
  requirementId: string; name: string; required: boolean; sellerSaysNoCopy: boolean;
  buyerAsked?: boolean; neededBy?: string;
  promised: boolean;
}

export interface CoverageRemoved {
  items: Array<{ key: string; label: string; sectionKey: string }>;
  sections: Array<{ key: string; title: string }>;
}

export interface CoverageBoard {
  dealId: string;
  audience: CoverageAudience;
  generatedAt: string;
  /** Hash of item ids + statuses + values (the client skips identical pushes). */
  version: string;
  sections: CoverageSection[];
  totals: CoverageTotals;
  percentCollected: number;
  /** score only for the broker audience. */
  quality: { label: CimReadiness["label"]; score?: number; summary?: string };
  routed: RoutedQuestion[];
  documents: DocumentNeeded[];
  plan: { status: "ready" | "building" | "unavailable" | "no_industry"; industry: string | null };
  /** broker audience only: what the broker took off the checklist (restorable). */
  removed?: CoverageRemoved;
}

/** The popover / sheet detail of one item (GET …/coverage-board/items/:itemId). */
export interface CoverageItemDetail {
  item: CoverageItem;
  /** Other values on file (≤ 3). */
  otherValues: Array<{ value: string; source: string }>;
  members: Array<{ key: string; label: string; onFile: boolean; writable: boolean }>;
  /** The broker's private note (broker audience only). */
  note: string | null;
  /** The full shown value (untruncated; null when masked). */
  fullValue: string | null;
}

/** What the seller-side interview header shows after each turn. */
export interface CoverageSummary {
  percentCollected: number;
  totals: CoverageTotals;
  quality: { label: CimReadiness["label"] };
}

/** The seller's words as shown: in quotes — except a broker statement the seller agreed to, which already quotes both. */
export function quoted(excerpt: string): string {
  return /^The seller agreed:/.test(excerpt) ? excerpt : `“${excerpt}”`;
}

// ─────────────────────────────────────────────────────────────────────────
// Non-answers
// ─────────────────────────────────────────────────────────────────────────

/**
 * A recorded value that is not an answer: "TBD", "Owner does not know …",
 * "I'll check with Denise". Anchored, so a fact with a caveat ("Renewal
 * option not yet confirmed by landlord", "Unknown Brewing Co.") stays a fact.
 */
export const NOT_KNOWN_RE =
  /^(?:unknown|not known|tbc|tbd|to be confirmed|not sure|n\/a)\.?$|^(?:the )?(?:owner|seller|i|we|he|she|they)\b[^.;]{0,30}?\b(?:does(?:n['’]?t| not) know|is(?:n['’]?t| not) sure|will (?:check|confirm|find out|get back)|needs? to (?:check|confirm)|has to (?:check|confirm)|can(?:'?t|not) (?:say|remember|recall))\b/i;

export function isNotKnownValue(value: string | null | undefined): boolean {
  return !!value && NOT_KNOWN_RE.test(value.trim().replace(/^I'll\b/i, "I will").replace(/^we'll\b/i, "we will"));
}

// ─────────────────────────────────────────────────────────────────────────
// Counts and the headline
// ─────────────────────────────────────────────────────────────────────────

const emptyCounts = (): Record<CoverageItemStatus, number> => ({ on_file: 0, partial: 0, verify: 0, missing: 0 });

/** Counted items: everything but the questions about the numbers. */
export function countedItems(items: CoverageItem[]): CoverageItem[] {
  return items.filter((i) => i.origin !== "figures");
}

export function sectionCounts(items: CoverageItem[]): Record<CoverageItemStatus, number> {
  const c = emptyCounts();
  for (const i of countedItems(items)) c[i.status] += 1;
  return c;
}

export function summarise(sections: Array<Pick<CoverageSection, "items">>): CoverageTotals {
  const t: CoverageTotals = { items: 0, on_file: 0, partial: 0, verify: 0, missing: 0, criticalItems: 0, criticalOpen: 0 };
  for (const s of sections) {
    for (const i of countedItems(s.items)) {
      t.items += 1;
      t[i.status] += 1;
      if (i.critical) {
        t.criticalItems += 1;
        if (i.status !== "on_file") t.criticalOpen += 1;
      }
    }
  }
  return t;
}

/** round(100 × on file ÷ items); 0 when there are no items. */
export function percentCollected(totals: Pick<CoverageTotals, "items" | "on_file">): number {
  return totals.items > 0 ? Math.round((100 * totals.on_file) / totals.items) : 0;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export interface CoverageHeadline {
  percent: number;
  /** "87% of the CIM's information collected" */
  long: string;
  /** "87% collected" (phones) */
  short: string;
  /** "3 critical still open" / "Every critical data point is on file" */
  critical: string;
  /** "3 critical open" (phones) */
  criticalShort: string;
  criticalOpen: number;
  counts: Array<{ status: CoverageItemStatus; n: number; label: string }>;
  quality: string;
}

export const QUALITY_TOOLTIP =
  "Quality weighs what buyers care about most, and a missing critical item caps it — it's the quality label on the deal's Overview. The percent counts every data point equally.";
/** The seller's version (they have no deal Overview). */
export const QUALITY_TOOLTIP_SELLER =
  "Quality weighs what buyers care about most. The percent counts every data point equally.";

export function headline(board: Pick<CoverageBoard, "totals" | "percentCollected" | "quality">): CoverageHeadline {
  const t = board.totals;
  const p = board.percentCollected;
  return {
    percent: p,
    long: `${p}% of the CIM's information collected`,
    short: `${p}% collected`,
    critical: t.criticalOpen > 0 ? `${t.criticalOpen} critical still open` : "Every critical data point is on file",
    criticalShort: t.criticalOpen > 0 ? `${t.criticalOpen} critical open` : "Critical all on file",
    criticalOpen: t.criticalOpen,
    counts: [
      { status: "on_file", n: t.on_file, label: `${t.on_file} on file` },
      { status: "partial", n: t.partial, label: `${t.partial} partial` },
      { status: "verify", n: t.verify, label: `${t.verify} to verify` },
      { status: "missing", n: t.missing, label: `${t.missing} missing` },
    ],
    quality: `Quality: ${board.quality.label}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Copy
// ─────────────────────────────────────────────────────────────────────────

export const STATUS_LABEL: Record<CoverageItemStatus, string> = {
  on_file: "On file",
  partial: "Partial",
  verify: "To verify",
  missing: "Missing",
};

export const CHIP = {
  justFiled: "Just filed",
  thisSession: "This session",
  estimate: "Estimate",
  yourNote: "Your note",
  confirmedByYou: "Confirmed by you",
  critical: "Critical",
  industry: "Industry",
  added: "Added",
  alsoNoted: "Also noted",
  numbers: "Numbers",
} as const;

export const MASKED_VALUE = "On file — private to you";

export type CoverageView = "ask" | "all" | "filed" | "verify" | "questions" | "docs" | "section";
export type CoverageFilter = "all" | "missing" | "partial" | "verify" | "critical";

export const VIEW_TITLE: Record<CoverageView, string> = {
  ask: "To ask",
  all: "Everything",
  filed: "Filed this session",
  verify: "To verify",
  questions: "Open questions",
  docs: "Documents still needed",
  section: "Section",
};

export function viewHeader(view: CoverageView, n: number): string {
  switch (view) {
    case "ask":
      return `${n === 1 ? "1 data point" : `${n} data points`} not on file yet — critical first. Go in any order; Cimple files answers as the seller talks.`;
    case "all":
      return "Every data point the CIM needs, section by section.";
    case "filed":
      return "What Cimple filed while you talked. Undo anything that's wrong.";
    case "verify":
      return "On file, but worth a second check with the seller.";
    case "questions":
      return "Questions about the numbers, and conflicts you sent to the seller. Raise them now and Cimple files the answers.";
    case "docs":
      return "Documents the CIM still needs. Tell the seller what to send — nothing here changes until they upload it.";
    default:
      return "";
  }
}

/** Checklist mode (no listening): the "To ask" header doesn't promise live filing. */
export function checklistViewHeader(view: CoverageView, n: number): string {
  if (view === "ask") return `${n === 1 ? "1 data point" : `${n} data points`} not on file yet — critical first. Add an answer, confirm what's on file, or start an interview together.`;
  if (view === "questions") return "Questions about the numbers, and conflicts you sent to the seller.";
  return viewHeader(view, n);
}

const LEAD_WORDS: Record<"crm" | "website" | "social", string> = { crm: "your CRM notes", website: "the website", social: "social media" };

/** Why an item is partial or to verify, in the audience's words. The screen variant never names a private source or value. */
export function reasonText(reason: CoverageReason | null, audience: CoverageAudience): string {
  if (!reason) return "";
  const screen = audience !== "broker";
  switch (reason.code) {
    case "lead":
      return screen ? "To verify — confirm with the seller." : `To verify — only in ${LEAD_WORDS[reason.leadKind]} so far.`;
    case "estimate":
      return "To verify — the seller's estimate.";
    case "conflict": {
      const bothSides = reason.a && reason.b && reason.aSource && reason.bSource;
      if (reason.privateSide || !bothSides) return "To verify — another source on file disagrees.";
      return `To verify — two sources disagree: ${reason.a} (${reason.aSource}) and ${reason.b} (${reason.bSource}).`;
    }
    case "marked":
      return screen ? "To verify." : "To verify — you marked this to check later.";
    case "broker_notes":
      return screen ? "To verify — confirm with the seller." : "To verify — from your own notes; the seller hasn't confirmed it.";
    case "guard":
      return reason.detail === "date"
        ? "To verify — the year wasn't said."
        : reason.detail === "legal"
          ? "To verify — check this with a lawyer."
          : "To verify — the number filed isn't exactly what the seller said.";
    case "routed":
      return "To verify — you sent this to the seller; ask it now.";
    case "not_known":
      return `Partial — not known yet${reason.whoHasIt ? ` — ${reason.whoHasIt} has it` : ""}.`;
    case "in_source":
      return screen || reason.private ? "Partial — confirm it with the seller." : `Partial — ${reason.sourceLabel} mentions it; confirm it with the seller.`;
    case "partly_on_file":
      return `Partial — on file: ${reason.onFile}. Still missing: ${reason.missing}.`;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Ordering, views and filters
// ─────────────────────────────────────────────────────────────────────────

const IMPORTANCE_RANK = { critical: 0, important: 1, helpful: 2 } as const;
const STATUS_RANK: Record<CoverageItemStatus, number> = { missing: 0, partial: 1, verify: 2, on_file: 3 };

/** Sections in board order: critical first, then important, helpful; CIM order within. */
export function orderedSections(board: Pick<CoverageBoard, "sections">): CoverageSection[] {
  return [...board.sections].sort((a, b) => IMPORTANCE_RANK[a.importance] - IMPORTANCE_RANK[b.importance] || a.order - b.order);
}

/** Within a section: critical items, then missing, partial, to verify (on file last); plan order otherwise. */
export function orderedItems(items: CoverageItem[]): CoverageItem[] {
  return items
    .map((it, idx) => ({ it, idx }))
    .sort((a, b) => Number(b.it.critical) - Number(a.it.critical) || STATUS_RANK[a.it.status] - STATUS_RANK[b.it.status] || a.idx - b.idx)
    .map((x) => x.it);
}

export function matchesFilter(item: CoverageItem, filter: CoverageFilter): boolean {
  switch (filter) {
    case "missing": return item.status === "missing";
    case "partial": return item.status === "partial";
    case "verify": return item.status === "verify";
    case "critical": return item.critical && item.status !== "on_file";
    default: return true;
  }
}

function normaliseQuery(q: string): string {
  return q.toLowerCase().replace(/\s+/g, " ").trim();
}

export function matchesQuery(item: CoverageItem, query: string): boolean {
  const q = normaliseQuery(query);
  if (!q) return true;
  return [item.label, item.ask, item.value ?? "", ...item.members.map((m) => m.label)].some((t) => t.toLowerCase().includes(q));
}

/** Does an item belong in a view (before the filter chips and search)? */
export function inView(item: CoverageItem, view: CoverageView, opts: { sectionKey?: string; sittingId?: string } = {}): boolean {
  switch (view) {
    case "ask": return item.status !== "on_file" && item.origin !== "figures";
    case "all": return true;
    case "filed": return !!opts.sittingId && item.filedInSittingId === opts.sittingId;
    case "verify": return item.status === "verify";
    case "questions": return item.origin === "figures" && item.status !== "on_file";
    case "section": return item.sectionKey === opts.sectionKey;
    case "docs": return false;
  }
}

export interface ViewGroup { section: CoverageSection; items: CoverageItem[] }

/** Items of a view, grouped by section in board order (counts for the chips come from `filterCounts`). */
export function filterItems(
  board: Pick<CoverageBoard, "sections">,
  opts: { view: CoverageView; filter?: CoverageFilter; query?: string; sectionKey?: string; sittingId?: string },
): ViewGroup[] {
  const out: ViewGroup[] = [];
  for (const section of orderedSections(board)) {
    if (opts.view === "section" && section.key !== opts.sectionKey) continue;
    const items = orderedItems(section.items).filter(
      (i) => inView(i, opts.view, opts) && matchesFilter(i, opts.filter ?? "all") && matchesQuery(i, opts.query ?? ""),
    );
    if (items.length > 0) out.push({ section, items });
  }
  return out;
}

/** Counts per filter chip within a view (search applied). */
export function filterCounts(
  board: Pick<CoverageBoard, "sections">,
  opts: { view: CoverageView; query?: string; sectionKey?: string; sittingId?: string },
): Record<CoverageFilter, number> {
  const counts: Record<CoverageFilter, number> = { all: 0, missing: 0, partial: 0, verify: 0, critical: 0 };
  for (const s of board.sections) {
    for (const i of s.items) {
      if (opts.view === "section" && s.key !== opts.sectionKey) continue;
      if (!inView(i, opts.view, opts) || !matchesQuery(i, opts.query ?? "")) continue;
      for (const f of ["all", "missing", "partial", "verify", "critical"] as CoverageFilter[]) if (matchesFilter(i, f)) counts[f] += 1;
    }
  }
  return counts;
}

/** Rail counts for the views. */
export function viewCounts(board: CoverageBoard, sittingId?: string): Record<Exclude<CoverageView, "section">, number> {
  const all = board.sections.flatMap((s) => s.items);
  return {
    ask: all.filter((i) => inView(i, "ask")).length,
    all: countedItems(all).length,
    filed: sittingId ? all.filter((i) => i.filedInSittingId === sittingId).length : 0,
    verify: all.filter((i) => i.status === "verify").length,
    questions: all.filter((i) => inView(i, "questions")).length + board.routed.length,
    docs: board.documents.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Stable list (filed rows never jump)
// ─────────────────────────────────────────────────────────────────────────

export interface OrderSnapshot {
  /** view|filter|query|section — a change takes a new snapshot. */
  key: string;
  ids: string[];
  at: number;
}

/**
 * The order the broker sees. While the view, filter and search stay the
 * same, every row stays where it is (a status change never moves or removes
 * a row — a filed item stays put, shown as on file); items that newly match
 * are appended at the end of their section group (a new section group at the
 * end). Rows whose item no longer exists on the board (taken off the
 * checklist) go. A new key takes a fresh snapshot of `current`.
 * `current` = the ids matching now, in natural order; `sectionOf` maps every
 * board item id to its section; `exists` = every board item id.
 */
export function stableOrder(
  snapshot: OrderSnapshot | null,
  current: { key: string; ids: string[] },
  sectionOf: Record<string, string>,
  exists: ReadonlySet<string>,
  now: number,
): OrderSnapshot {
  if (!snapshot || snapshot.key !== current.key) return { key: current.key, ids: [...current.ids], at: now };
  const ids = snapshot.ids.filter((id) => exists.has(id));
  const have = new Set(ids);
  for (const id of current.ids) {
    if (have.has(id)) continue;
    const sec = sectionOf[id];
    let at = -1;
    for (let i = ids.length - 1; i >= 0; i--) if (sectionOf[ids[i]] === sec) { at = i; break; }
    if (at === -1) ids.push(id);
    else ids.splice(at + 1, 0, id);
    have.add(id);
  }
  return { key: snapshot.key, ids, at: snapshot.at };
}

/** Filed rows parked in a view they no longer match ("Tidy the list (3 filed)" from 3). */
export function parkedFiled(snapshot: OrderSnapshot, currentIds: ReadonlySet<string>): string[] {
  return snapshot.ids.filter((id) => !currentIds.has(id));
}

// ─────────────────────────────────────────────────────────────────────────
// What to ask next (no AI)
// ─────────────────────────────────────────────────────────────────────────

export interface NextToAskContext {
  /** Sections the conversation is on now (the last filing's topics). */
  topicSections?: string[];
  /** itemId → when an "asked" mark was set (ms). */
  askedAt?: Record<string, number>;
  /** The extraction's follow-up, if any. */
  followUp?: { itemId?: string; ask: string; at: number } | null;
  now?: number;
  limit?: number;
}

export interface NextToAskSuggestion {
  kind: "follow_up" | "same_topic" | "critical" | "top";
  /** "Follow up" / "Same topic" / "Critical, not asked yet" */
  chip: string;
  itemId?: string;
  label: string;
  ask: string;
  sectionKey?: string;
}

const IMPORTANCE_SCORE = { critical: 3, important: 2, helpful: 1 } as const;

export function scoreItem(item: CoverageItem, section: Pick<CoverageSection, "importance">, ctx: NextToAskContext = {}): number {
  const now = ctx.now ?? Date.now();
  let s = IMPORTANCE_SCORE[section.importance];
  if (item.critical) s += 3;
  s += item.status === "missing" ? 2 : item.status === "partial" ? 1.5 : item.status === "verify" ? 1 : 0;
  if (ctx.topicSections?.includes(item.sectionKey)) s += 2.5;
  if (item.marks.some((m) => m.kind === "verify_later")) s += 0.5;
  const asked = ctx.askedAt?.[item.id];
  if (asked !== undefined && now - asked < 10 * 60_000) s -= 5;
  // Asked already, and someone else has the answer ("Denise has the EMR") — it waits for them.
  if (item.reason?.code === "not_known") s -= 4;
  return s;
}

/** Ranked open items (the Overview's "top 5 to ask" uses this with no topic). */
export function rankOpenItems(board: Pick<CoverageBoard, "sections">, ctx: NextToAskContext = {}): CoverageItem[] {
  const scored: Array<{ item: CoverageItem; s: number; order: number }> = [];
  let order = 0;
  for (const section of orderedSections(board)) {
    for (const item of orderedItems(section.items)) {
      order++;
      if (item.status === "on_file" || item.origin === "figures") continue;
      scored.push({ item, s: scoreItem(item, section, ctx), order });
    }
  }
  return scored.sort((a, b) => b.s - a.s || a.order - b.order).map((x) => x.item);
}

/** "Suggest what to ask next": a follow-up, the best item on the current topic, the best critical item. */
export function nextToAsk(board: Pick<CoverageBoard, "sections">, ctx: NextToAskContext = {}): NextToAskSuggestion[] {
  const now = ctx.now ?? Date.now();
  const limit = ctx.limit ?? 3;
  const ranked = rankOpenItems(board, ctx);
  const out: NextToAskSuggestion[] = [];
  const used = new Set<string>();
  const push = (s: NextToAskSuggestion) => {
    if (s.itemId && used.has(s.itemId)) return;
    if (s.itemId) used.add(s.itemId);
    out.push(s);
  };
  if (ctx.followUp && now - ctx.followUp.at < 3 * 60_000 && ctx.followUp.ask.trim()) {
    const item = ranked.find((i) => i.id === ctx.followUp!.itemId);
    push({ kind: "follow_up", chip: "Follow up", itemId: item?.id, label: item?.label ?? "Follow up", ask: ctx.followUp.ask.trim(), sectionKey: item?.sectionKey });
  }
  if (ctx.topicSections && ctx.topicSections.length > 0) {
    const same = ranked.find((i) => ctx.topicSections!.includes(i.sectionKey) && !used.has(i.id));
    if (same) push({ kind: "same_topic", chip: "Same topic", itemId: same.id, label: same.label, ask: same.ask, sectionKey: same.sectionKey });
  }
  const crit = ranked.find((i) => i.critical && !used.has(i.id) && i.reason?.code !== "not_known" && !(ctx.askedAt?.[i.id] !== undefined && now - (ctx.askedAt?.[i.id] ?? 0) < 10 * 60_000));
  if (crit) push({ kind: "critical", chip: "Critical, not asked yet", itemId: crit.id, label: crit.label, ask: crit.ask, sectionKey: crit.sectionKey });
  for (const i of ranked) {
    if (out.length >= limit) break;
    if (used.has(i.id)) continue;
    push({ kind: "top", chip: i.critical ? "Critical" : "Next up", itemId: i.id, label: i.label, ask: i.ask, sectionKey: i.sectionKey });
  }
  return out.slice(0, limit);
}

// ─────────────────────────────────────────────────────────────────────────
// Call sheet (copy / print; no AI)
// ─────────────────────────────────────────────────────────────────────────

export interface CallSheet {
  title: string;
  groups: Array<{ section: string; critical: boolean; items: Array<{ label: string; ask: string; critical: boolean; status: CoverageItemStatus }> }>;
  documents: Array<{ name: string; required: boolean }>;
  text: string;
}

export function callSheet(board: CoverageBoard, businessName?: string): CallSheet {
  const groups: CallSheet["groups"] = [];
  for (const section of orderedSections(board)) {
    const items = orderedItems(section.items)
      .filter((i) => i.status !== "on_file" && i.origin !== "figures")
      .map((i) => ({ label: i.label, ask: i.ask, critical: i.critical, status: i.status }));
    if (items.length > 0) groups.push({ section: section.title, critical: section.importance === "critical", items });
  }
  // Critical sections first is the board order already; within, critical items lead.
  const documents = board.documents.map((d) => ({ name: d.name, required: d.required }));
  const title = `${businessName ? `${businessName} — ` : ""}call sheet`;
  const lines: string[] = [title, ""];
  for (const g of groups) {
    lines.push(`${g.section}${g.critical ? " (critical)" : ""}`);
    for (const i of g.items) lines.push(`  [ ] ${i.label}${i.critical ? " — CRITICAL" : ""}${i.ask ? `\n      Ask: ${i.ask}` : ""}`);
    lines.push("");
  }
  if (documents.length > 0) {
    lines.push("Documents still needed");
    for (const d of documents) lines.push(`  [ ] ${d.name}${d.required ? "" : " (nice to have)"}`);
  }
  return { title, groups, documents, text: lines.join("\n").trim() };
}

// ─────────────────────────────────────────────────────────────────────────
// Version hash (FNV-1a; same in Node and the browser)
// ─────────────────────────────────────────────────────────────────────────

export function hashText(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

export function boardVersion(sections: Array<Pick<CoverageSection, "items">>): string {
  const parts: string[] = [];
  for (const s of sections) for (const i of s.items) parts.push(`${i.id}|${i.status}|${i.value ?? ""}|${i.reason?.code ?? ""}|${i.marks.map((m) => m.kind).join(",")}`);
  return hashText(parts.join("\n"));
}

/** The summary the seller's interview header shows. */
export function summaryOf(board: Pick<CoverageBoard, "percentCollected" | "totals" | "quality">): CoverageSummary {
  return { percentCollected: board.percentCollected, totals: board.totals, quality: { label: board.quality.label } };
}

/** "x of y on file" for a section (figures excluded). */
export function sectionOnFile(section: Pick<CoverageSection, "counts">): { onFile: number; items: number } {
  const c = section.counts;
  return { onFile: c.on_file, items: c.on_file + c.partial + c.verify + c.missing };
}
