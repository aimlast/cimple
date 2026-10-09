/**
 * Editing the teaser (spec §4.6) — pure operations on a TeaserDoc. The
 * routes run them through saveDraft (rev check, history, the "writing"
 * lock) and return the per-block checks, computed on every read.
 *
 * Rules: blocks stay in TEASER_LAYOUTS; two-column columns hold only text,
 * lists, figures or highlights; a line chart only the indexed trend; limits
 * apply (30 blocks, 120-character titles, 4,000-character text, 40-character
 * key-number cells, 140-character tagline, 5 chips). Sample data is allowed
 * in the draft but blocks publishing.
 */
import { randomUUID } from "node:crypto";
import { collectStrings } from "@shared/blind-guard";
import { defaultLayoutData, sameLayoutFamily } from "@shared/cim-layouts";
import {
  LINE_KEY_PREFIX,
  MAX_DEAL_LINES,
  TEASER_LIMITS,
  blockCells,
  cellLimit,
  isTeaserLayout,
  validateTeaserLayout,
  withCellsApplied,
  type KeyCell,
  type TeaserBlock,
  type TeaserDoc,
  type TeaserHeader,
  type TeaserLayout,
} from "@shared/teaser";
import type { NumberStyle } from "@shared/deal-bands";
import type { TeaserTemplateDef } from "@shared/teaser-templates";
import {
  dealCells,
  financialSnapshotCells,
  keyCellsFor,
  listingRowsFor,
  mergeCells,
  operationsCells,
  trendLayoutData,
  type TeaserFigures,
} from "./key-numbers";

/** A refused edit: the HTTP status and a plain sentence. */
export class TeaserOpError extends Error {
  constructor(public status: 400 | 404 | 409, message: string, public code?: string) {
    super(message);
  }
}

const nowIso = () => new Date().toISOString();
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function findBlock(doc: TeaserDoc, id: string): TeaserBlock {
  const b = doc.blocks.find((x) => x.id === id);
  if (!b) throw new TeaserOpError(404, "That block isn't in this teaser any more.");
  return b;
}

function checkLimits(block: TeaserBlock): void {
  if (block.title.length > TEASER_LIMITS.title) throw new TeaserOpError(400, `Keep the title under ${TEASER_LIMITS.title} characters.`);
  if ((block.body ?? "").length > TEASER_LIMITS.text) throw new TeaserOpError(400, `Keep the text under ${TEASER_LIMITS.text.toLocaleString("en-US")} characters.`);
  for (const t of collectStrings(block.layoutData)) {
    if (t.length > TEASER_LIMITS.text) throw new TeaserOpError(400, `Keep each piece of text under ${TEASER_LIMITS.text.toLocaleString("en-US")} characters.`);
  }
  if (JSON.stringify(block.layoutData).length > 40_000) throw new TeaserOpError(400, "This block is too long for a teaser.");
  for (const c of blockCells(block)) if (c.value.length > cellLimit(c.key)) throw new TeaserOpError(400, `Keep each key number under ${cellLimit(c.key)} characters.`);
  const problem = validateTeaserLayout(block);
  if (problem) throw new TeaserOpError(400, problem);
}

/** A prose block keeps body and layoutData.body in step. */
function syncBody(block: TeaserBlock): TeaserBlock {
  if (block.layoutType !== "prose_highlight") return block;
  const data = { ...block.layoutData };
  const body = typeof block.body === "string" ? block.body : typeof data.body === "string" ? (data.body as string) : "";
  data.body = body;
  return { ...block, body, layoutData: data };
}

function hasContent(block: TeaserBlock): boolean {
  return collectStrings([block.body ?? "", block.layoutData]).some((t) => t.trim().length > 0);
}

// ── Block operations ─────────────────────────────────────────────────────

export interface BlockPatch {
  title?: string;
  layoutData?: Record<string, unknown>;
  body?: string | null;
  hidden?: boolean;
}

export function patchBlock(doc: TeaserDoc, id: string, patch: BlockPatch): TeaserDoc {
  const next = clone(doc);
  const i = next.blocks.findIndex((b) => b.id === id);
  if (i < 0) throw new TeaserOpError(404, "That block isn't in this teaser any more.");
  let b = next.blocks[i];
  const content = patch.title !== undefined || patch.layoutData !== undefined || patch.body !== undefined;
  if (patch.title !== undefined) b.title = String(patch.title).replace(/\s+/g, " ").trim();
  if (patch.layoutData !== undefined) {
    if (!patch.layoutData || typeof patch.layoutData !== "object" || Array.isArray(patch.layoutData)) throw new TeaserOpError(400, "That block data isn't readable.");
    // Cells are the source of what's drawn from them (the key numbers, the
    // "Deal at a glance" column). An edit of the drawn data is applied TO the
    // cells — never accepted and then redrawn over (that lost the broker's words).
    const layoutProblem = validateTeaserLayout({ ...b, layoutData: patch.layoutData as Record<string, unknown> });
    if (layoutProblem) throw new TeaserOpError(400, layoutProblem);
    b.layoutData = Array.isArray(b.layoutData.cells)
      ? { ...patch.layoutData, cells: cellsAfterDrawnEdit(b, patch.layoutData as Record<string, unknown>) }
      : { ...patch.layoutData };
    if (b.layoutType === "prose_highlight" && typeof patch.layoutData.body === "string" && patch.body === undefined) b.body = patch.layoutData.body as string;
  }
  if (patch.body !== undefined) b.body = patch.body === null ? null : String(patch.body);
  if (patch.hidden !== undefined) b.hidden = !!patch.hidden;
  b = syncBody(b);
  if (Array.isArray(b.layoutData.cells)) b = withCellsApplied(b);
  if (content) {
    b.origin = "broker";
    if (b.placeholder && hasContent(b)) {
      delete b.placeholder;
      if (patch.hidden === undefined) b.hidden = false;
    }
  }
  b.updatedAt = nowIso();
  checkLimits(b);
  next.blocks[i] = b;
  return next;
}

/** Type over a key number ("Edited by you"), or reset it from the facts (`value: null`). */
export function patchCell(doc: TeaserDoc, blockId: string, key: string, value: string | null, fresh?: KeyCell[]): TeaserDoc {
  const next = clone(doc);
  const b = findBlock(next, blockId);
  const cells = blockCells(b);
  const i = cells.findIndex((c) => c.key === key);
  if (value === null) {
    const f = fresh?.find((c) => c.key === key);
    if (i >= 0 && f) cells[i] = { ...f };
    else if (i >= 0) cells.splice(i, 1);
  } else {
    const v = value.replace(/\s+/g, " ").trim();
    if (!v) throw new TeaserOpError(400, "Type a value, or use Reset from the facts.");
    if (v.length > cellLimit(key)) throw new TeaserOpError(400, `Keep each key number under ${cellLimit(key)} characters.`);
    if (i < 0) throw new TeaserOpError(404, "That key number isn't in this block.");
    const { removed: _r, ...cell } = cells[i];
    void _r;
    cells[i] = { ...cell, value: v, edited: true, editedAt: nowIso() };
  }
  const updated = withCellsApplied({ ...b, layoutData: { ...b.layoutData, cells }, updatedAt: nowIso() });
  next.blocks = next.blocks.map((x) => (x.id === blockId ? updated : x));
  return next;
}

// ── Lines drawn from cells ("Deal at a glance", key numbers) ───────────────

const fold = (t: string) => t.replace(/\s+/g, " ").trim().toLowerCase();
const newLineKey = () => `${LINE_KEY_PREFIX}${randomUUID().slice(0, 8)}`;

/** The "Label: value" pairs a block draws from its cells, as the renderer gets them. */
function drawnPairs(layoutType: string, data: Record<string, unknown>): Array<{ label: string; value: string }> | null {
  const asPairs = (v: unknown) => (Array.isArray(v) ? v.map((x) => ({ label: String((x as { label?: unknown })?.label ?? ""), value: String((x as { value?: unknown })?.value ?? "") })) : null);
  if (layoutType === "metric_grid") return asPairs(data.metrics);
  if (layoutType === "icon_stat_row") return asPairs(data.stats);
  if (layoutType === "two_column") {
    const right = data.right && typeof data.right === "object" ? (data.right as Record<string, unknown>) : null;
    if (!right || typeof right.content !== "string") return null;
    const pairs: Array<{ label: string; value: string }> = [];
    for (const line of right.content.split("\n").map((l) => l.trim()).filter(Boolean)) {
      const m = /^([^:]{1,40}):\s*(.+)$/.exec(line);
      if (!m) throw new TeaserOpError(400, "Write each “Deal at a glance” line as “Label: value” — or use “Add a line”.");
      pairs.push({ label: m[1].trim(), value: m[2].trim() });
    }
    return pairs;
  }
  return null;
}

/**
 * The cells after an edit of what's drawn from them: a changed value is the
 * broker's (edited), a new line is added (theirs), a line taken off is
 * removed (a fact line is kept empty and marked, so a refresh from the facts
 * doesn't bring it back). An unchanged drawing leaves the cells as they are.
 */
function cellsAfterDrawnEdit(b: TeaserBlock, patched: Record<string, unknown>): KeyCell[] {
  const cells = blockCells(b);
  const before = drawnPairs(b.layoutType, withCellsApplied(b).layoutData);
  const after = drawnPairs(b.layoutType, patched);
  if (!after || !before || JSON.stringify(after) === JSON.stringify(before)) return cells;
  if (after.length > Math.max(MAX_DEAL_LINES, cells.length)) throw new TeaserOpError(400, `Keep it to ${MAX_DEAL_LINES} lines.`);
  const at = nowIso();
  const used = new Set<string>();
  const out: KeyCell[] = [];
  for (const p of after) {
    if (!p.label.trim()) throw new TeaserOpError(400, "Give each line a label.");
    const match = cells.find((c) => !used.has(c.key) && !c.removed && fold(c.label) === fold(p.label)) ?? cells.find((c) => !used.has(c.key) && fold(c.label) === fold(p.label));
    if (match) {
      used.add(match.key);
      if (match.value === p.value && !match.removed) out.push(match);
      else {
        const { removed: _r, ...rest } = match;
        void _r;
        out.push({ ...rest, value: p.value, edited: true, editedAt: at });
      }
    } else {
      out.push({ key: newLineKey(), label: p.label.slice(0, 40), value: p.value, edited: true, added: true, editedAt: at });
    }
  }
  for (const c of cells) {
    if (used.has(c.key) || c.added) continue;
    out.push(c.removed ? c : { ...c, value: "", removed: true, edited: true, editedAt: at });
  }
  return out;
}

function linesBlock(doc: TeaserDoc, blockId: string): TeaserBlock {
  const b = findBlock(doc, blockId);
  if (b.layoutType !== "two_column" || !Array.isArray(b.layoutData.cells)) throw new TeaserOpError(400, "Lines can be added to the “Deal at a glance” column only.");
  return b;
}

/** "Add a line" to a two-column block's "Deal at a glance" column. */
export function addCellLine(doc: TeaserDoc, blockId: string, label: string, value: string): { doc: TeaserDoc; key: string } {
  const next = clone(doc);
  const b = linesBlock(next, blockId);
  const l = label.replace(/\s+/g, " ").trim();
  const v = value.replace(/\s+/g, " ").trim();
  if (!l || !v) throw new TeaserOpError(400, "Type a label and a value for the line.");
  if (l.length > 40) throw new TeaserOpError(400, "Keep the label under 40 characters.");
  if (l.includes(":")) throw new TeaserOpError(400, "Leave the colon out of the label.");
  if (v.length > TEASER_LIMITS.phraseCell) throw new TeaserOpError(400, `Keep the line under ${TEASER_LIMITS.phraseCell} characters.`);
  const cells = blockCells(b);
  if (cells.filter((c) => !c.removed).length >= MAX_DEAL_LINES) throw new TeaserOpError(400, `Keep it to ${MAX_DEAL_LINES} lines.`);
  const key = newLineKey();
  cells.push({ key, label: l, value: v, edited: true, added: true, editedAt: nowIso() });
  let updated = withCellsApplied({ ...b, layoutData: { ...b.layoutData, cells }, origin: "broker", updatedAt: nowIso() });
  // A "Deal at a glance" left empty by the template start is shown once it has a line.
  if (updated.placeholder) {
    const { placeholder: _p, ...rest } = updated;
    void _p;
    updated = { ...rest, hidden: false };
  }
  next.blocks = next.blocks.map((x) => (x.id === blockId ? updated : x));
  return { doc: next, key };
}

/** Take a line off: a line the broker added goes; a line from the facts is kept empty and marked (Reset from the facts brings it back). */
export function removeCellLine(doc: TeaserDoc, blockId: string, key: string): TeaserDoc {
  const next = clone(doc);
  const b = linesBlock(next, blockId);
  const cells = blockCells(b);
  const i = cells.findIndex((c) => c.key === key);
  if (i < 0) throw new TeaserOpError(404, "That line isn't in this block any more.");
  if (cells[i].added) cells.splice(i, 1);
  else cells[i] = { ...cells[i], value: "", removed: true, edited: true, editedAt: nowIso() };
  const updated = withCellsApplied({ ...b, layoutData: { ...b.layoutData, cells }, updatedAt: nowIso() });
  next.blocks = next.blocks.map((x) => (x.id === blockId ? updated : x));
  return next;
}

/** A blank block of this layout (no sample rows for prose; the layout's own blank otherwise). */
export function blankData(layoutType: TeaserLayout): Record<string, unknown> {
  if (layoutType === "prose_highlight") return { body: "" };
  if (layoutType === "line_chart") return { indexed: true, data: [], series: [{ key: "index", label: "Revenue (first year = 100)" }] };
  if (layoutType === "two_column") return { left: { title: "", content: "", layoutType: "prose" }, right: { title: "", content: "", layoutType: "list" } };
  return defaultLayoutData(layoutType);
}

export function addBlock(
  doc: TeaserDoc,
  input: { after?: string | null; layoutType: string; title: string; layoutData?: Record<string, unknown> | null; body?: string | null; origin?: TeaserBlock["origin"] },
): { doc: TeaserDoc; block: TeaserBlock } {
  if (!isTeaserLayout(input.layoutType)) throw new TeaserOpError(400, "This layout can't be used in a teaser — pick another one.");
  if (doc.blocks.length >= TEASER_LIMITS.blocks) throw new TeaserOpError(400, `A teaser can have up to ${TEASER_LIMITS.blocks} blocks.`);
  const block = syncBody({
    id: randomUUID(),
    slot: "custom",
    title: String(input.title ?? "").replace(/\s+/g, " ").trim(),
    layoutType: input.layoutType,
    layoutData: input.layoutData ? { ...input.layoutData } : blankData(input.layoutType),
    body: input.body ?? (input.layoutType === "prose_highlight" ? "" : null),
    hidden: false,
    origin: input.origin ?? "broker",
    facts: [],
    updatedAt: nowIso(),
  });
  checkLimits(block);
  const next = clone(doc);
  const at = input.after ? next.blocks.findIndex((b) => b.id === input.after) : -1;
  if (input.after && at < 0) throw new TeaserOpError(404, "That block isn't in this teaser any more.");
  next.blocks.splice(at < 0 ? next.blocks.length : at + 1, 0, block);
  return { doc: next, block };
}

export function removeBlock(doc: TeaserDoc, id: string): TeaserDoc {
  findBlock(doc, id);
  return { ...clone(doc), blocks: doc.blocks.filter((b) => b.id !== id).map((b) => clone(b)) };
}

export function duplicateBlock(doc: TeaserDoc, id: string): { doc: TeaserDoc; block: TeaserBlock } {
  if (doc.blocks.length >= TEASER_LIMITS.blocks) throw new TeaserOpError(400, `A teaser can have up to ${TEASER_LIMITS.blocks} blocks.`);
  const src = findBlock(doc, id);
  const copy: TeaserBlock = { ...clone(src), id: randomUUID(), slot: "custom", origin: "broker", updatedAt: nowIso() };
  delete copy.placeholder;
  const next = clone(doc);
  const at = next.blocks.findIndex((b) => b.id === id);
  next.blocks.splice(at + 1, 0, copy);
  return { doc: next, block: copy };
}

export function reorder(doc: TeaserDoc, ids: string[]): TeaserDoc {
  const have = doc.blocks.map((b) => b.id);
  if (ids.length !== have.length || new Set(ids).size !== ids.length || ids.some((id) => !have.includes(id))) {
    throw new TeaserOpError(409, "The blocks changed while you were moving them — showing the latest.", "stale");
  }
  const byId = new Map(doc.blocks.map((b) => [b.id, clone(b)]));
  return { ...clone(doc), blocks: ids.map((id) => byId.get(id)!) };
}

/** Within the same family (callout_list ↔ numbered_list…) the content carries over; otherwise the block starts blank. */
export function setLayout(doc: TeaserDoc, id: string, layoutType: string): TeaserDoc {
  if (!isTeaserLayout(layoutType)) throw new TeaserOpError(400, "This layout can't be used in a teaser — pick another one.");
  const next = clone(doc);
  const b = findBlock(next, id);
  const same = sameLayoutFamily(b.layoutType, layoutType) || listSwap(b.layoutType, layoutType);
  const data = same ? convertSameFamily(b.layoutData, b.layoutType, layoutType) : blankData(layoutType);
  const updated = syncBody({ ...b, layoutType, layoutData: data, body: layoutType === "prose_highlight" ? (same ? b.body : "") : null, origin: "broker", updatedAt: nowIso() });
  checkLimits(updated);
  next.blocks = next.blocks.map((x) => (x.id === id ? updated : x));
  return next;
}

const LIST_FAMILY = new Set(["callout_list", "numbered_list"]);
const STAT_FAMILY = new Set(["metric_grid", "icon_stat_row"]);
function listSwap(a: string, b: string): boolean {
  return (LIST_FAMILY.has(a) && LIST_FAMILY.has(b)) || (STAT_FAMILY.has(a) && STAT_FAMILY.has(b));
}
function convertSameFamily(data: Record<string, unknown>, from: string, to: string): Record<string, unknown> {
  const d = clone(data);
  if (STAT_FAMILY.has(from) && STAT_FAMILY.has(to)) {
    const list = (d.metrics ?? d.stats ?? []) as unknown[];
    return to === "metric_grid" ? { ...d, metrics: list, stats: undefined } : { ...d, stats: list, metrics: undefined };
  }
  if (LIST_FAMILY.has(from) && LIST_FAMILY.has(to)) {
    return to === "numbered_list" ? { items: d.items ?? [], ordered: true } : { items: d.items ?? [], style: "list", columns: 1 };
  }
  return d;
}

export function patchHeader(doc: TeaserDoc, patch: { label?: string; tagline?: string; chips?: string[] }): TeaserDoc {
  const next = clone(doc);
  const h: TeaserHeader = next.header ?? { label: "CONFIDENTIAL OPPORTUNITY", tagline: "", chips: [] };
  if (patch.label !== undefined) {
    const v = String(patch.label).replace(/\s+/g, " ").trim();
    if (v.length > 60) throw new TeaserOpError(400, "Keep the label under 60 characters.");
    h.label = v || "CONFIDENTIAL OPPORTUNITY";
  }
  if (patch.tagline !== undefined) {
    const v = String(patch.tagline).replace(/\s+/g, " ").trim();
    if (v.length > TEASER_LIMITS.tagline) throw new TeaserOpError(400, `Keep the one-line description under ${TEASER_LIMITS.tagline} characters.`);
    h.tagline = v;
  }
  if (patch.chips !== undefined) {
    const chips = (Array.isArray(patch.chips) ? patch.chips : []).map((c) => String(c).replace(/\s+/g, " ").trim()).filter(Boolean);
    if (chips.length > TEASER_LIMITS.chips) throw new TeaserOpError(400, `Use up to ${TEASER_LIMITS.chips} chips.`);
    if (chips.some((c) => c.length > 40)) throw new TeaserOpError(400, "Keep each chip under 40 characters.");
    h.chips = chips;
  }
  next.header = h;
  return next;
}

// ── Fixed blocks from the facts ──────────────────────────────────────────

/** The fresh cells a fixed slot gets from the facts now (null = not a cell slot). */
export function freshCellsFor(slot: string, templateKey: string, f: TeaserFigures, s: { numbers: NumberStyle; showAskingPrice: boolean }, current?: TeaserBlock): KeyCell[] | null {
  switch (slot) {
    case "key_numbers":
      return keyCellsFor(templateKey, f, s);
    case "listing_facts": {
      // The AI phrases stay as written (they aren't facts).
      const cur = current ? blockCells(current) : [];
      // The phrases on the block stay as written; a missing one comes from the facts' fixed phrases.
      const phrase = (k: "financing" | "supportTraining" | "reasonForSale") => cur.find((c) => c.key === k)?.value ?? f.phrases?.[k] ?? null;
      return listingRowsFor(f, s, { financing: phrase("financing"), supportTraining: phrase("supportTraining"), reasonForSale: phrase("reasonForSale") });
    }
    case "operations": {
      const notes = (current ? blockCells(current) : []).filter((c) => c.key.startsWith("note"));
      return [...operationsCells(f), ...notes];
    }
    case "financial_snapshot":
      return financialSnapshotCells(f);
    case "opportunity":
    case "deal_structure": {
      const cur = current ? blockCells(current) : [];
      const phrase = (k: "reasonForSale" | "transition" | "financing") => cur.find((c) => c.key === k && !c.edited)?.value ?? cur.find((c) => c.key === k)?.value ?? f.phrases?.[k] ?? null;
      const cells = dealCells(f, { reasonForSale: phrase("reasonForSale"), transition: phrase("transition"), financing: phrase("financing") }, slot === "deal_structure" || cur.some((c) => c.key === "financing"));
      // Lines the broker added stay (mergeCells keeps every edited line).
      return slot === "deal_structure" ? cells.filter((c) => c.key !== "reasonForSale" && c.key !== "transition") : cells;
    }
    default:
      return null;
  }
}

/**
 * Recompute the fixed parts of a doc from the facts: cells (edited ones kept
 * unless `all`), the trend line. Returns the doc and what changed.
 */
export function recomputeFixed(
  doc: TeaserDoc,
  templateKey: string,
  f: TeaserFigures,
  s: { numbers: NumberStyle; showAskingPrice: boolean },
  opts: { all?: boolean; onlyBlockId?: string } = {},
): { doc: TeaserDoc; changed: Array<{ blockId: string; label: string; was: string; now: string }> } {
  const next = clone(doc);
  const changed: Array<{ blockId: string; label: string; was: string; now: string }> = [];
  next.blocks = next.blocks.map((b) => {
    if (opts.onlyBlockId && b.id !== opts.onlyBlockId) return b;
    if (b.slot === "trend" && b.layoutType === "line_chart") {
      const data = trendLayoutData(f);
      return data && JSON.stringify(data) !== JSON.stringify(b.layoutData) ? { ...b, layoutData: data, updatedAt: nowIso() } : b;
    }
    const fresh = freshCellsFor(b.slot, templateKey, f, s, b);
    if (!fresh) return b;
    const current = blockCells(b);
    const merged = opts.all ? fresh : mergeCells(current, fresh);
    for (const c of merged) {
      const was = current.find((x) => x.key === c.key);
      if (!was) changed.push({ blockId: b.id, label: c.label, was: "", now: c.value });
      else if (was.value !== c.value) changed.push({ blockId: b.id, label: c.label, was: was.value, now: c.value });
    }
    for (const c of current) if (!merged.some((x) => x.key === c.key)) changed.push({ blockId: b.id, label: c.label, was: c.value, now: "" });
    if (JSON.stringify(merged) === JSON.stringify(current)) return b;
    return withCellsApplied({ ...b, layoutData: { ...b.layoutData, cells: merged }, updatedAt: nowIso() });
  });
  return { doc: next, changed };
}

/** Facts changed since publishing: the fixed cells recomputed on the PUBLISHED doc (edited cells skipped). */
export function teaserStaleness(published: TeaserDoc | null, templateKey: string, f: TeaserFigures, s: { numbers: NumberStyle; showAskingPrice: boolean }): Array<{ label: string; published: string; now: string }> {
  if (!published) return [];
  return recomputeFixed(published, templateKey, f, s).changed
    .filter((c) => c.was !== c.now)
    .map((c) => ({ label: c.label, published: c.was || "—", now: c.now || "—" }));
}

/** Undo: the last history entry (null when there's nothing to undo). */
export function undoDoc(history: Array<{ doc: TeaserDoc }>): { doc: TeaserDoc; history: Array<{ doc: TeaserDoc }> } | null {
  if (history.length === 0) return null;
  const last = history[history.length - 1];
  return { doc: clone(last.doc), history: history.slice(0, -1) };
}

/**
 * Applying another template to a draft: blocks the broker edited stay;
 * missing slots are added (AI slots as placeholders, written in the
 * background as one call). Returns the doc and the ids to fill.
 */
export function applyTemplateSlots(doc: TeaserDoc, def: TeaserTemplateDef, fixed: (slot: string) => TeaserBlock | null): { doc: TeaserDoc; added: string[]; toFill: string[] } {
  const next = clone(doc);
  const have = new Set(next.blocks.map((b) => b.slot));
  const added: string[] = [];
  const toFill: string[] = [];
  const ordered: TeaserBlock[] = [];
  for (const slot of def.slots) {
    const existing = next.blocks.find((b) => b.slot === slot.slot);
    if (existing) {
      ordered.push(existing);
      continue;
    }
    if (have.has(slot.slot)) continue;
    const made = fixed(slot.slot);
    if (made) {
      ordered.push(made);
      added.push(made.id);
      continue;
    }
    if (slot.conditional) continue;
    const ph: TeaserBlock = {
      id: randomUUID(),
      slot: slot.slot,
      title: slot.title,
      layoutType: slot.layoutType,
      layoutData: blankData(slot.layoutType),
      body: slot.layoutType === "prose_highlight" ? "" : null,
      hidden: true,
      origin: "ai",
      placeholder: true,
      facts: [],
      updatedAt: nowIso(),
    };
    ordered.push(ph);
    added.push(ph.id);
    toFill.push(ph.id);
  }
  // Blocks not in the new template (custom ones, or slots it doesn't have) stay, after.
  for (const b of next.blocks) if (!ordered.includes(b)) ordered.push(b);
  return { doc: { ...next, blocks: ordered }, added, toFill };
}

// ── Publish ──────────────────────────────────────────────────────────────

export interface PublishContext {
  codenameProblem: string | null;
  /** Per-block checks with CURRENT terms (checkTeaserDoc). */
  checks: Array<{ blockId: string; held: boolean; reason: string | null; layoutProblem: string | null; sample: boolean }>;
  headerProblem: string | null;
  /** The confidentiality review ran now (or there was nothing to review), or the broker confirmed. */
  reviewOk: boolean;
  discrepancyReasons: string[];
}

/** Why the draft can't be published yet (empty = it can). */
export function publishProblems(doc: TeaserDoc, ctx: PublishContext): string[] {
  const problems: string[] = [];
  if (ctx.codenameProblem) problems.push(`Change the codename first: ${ctx.codenameProblem}`);
  if (!doc.header) problems.push("Add the header (codename and one-line description).");
  if (ctx.headerProblem) problems.push(ctx.headerProblem);
  const visible = doc.blocks.filter((b) => !b.hidden);
  if (visible.length < 2) problems.push("Show at least two blocks to buyers.");
  const byId = new Map(ctx.checks.map((c) => [c.blockId, c]));
  for (const b of visible) {
    const c = byId.get(b.id);
    const name = b.title || "A block";
    if (b.placeholder) problems.push(`${name}: write it or hide it — it's still empty.`);
    if (c?.held) problems.push(`${name}: buyers won't see it — ${c.reason}. Reword it.`);
    if (c?.layoutProblem) problems.push(`${name}: ${c.layoutProblem}`);
    if (c?.sample) problems.push(`${name}: it still shows sample data.`);
  }
  if (!ctx.reviewOk) problems.push("The confidentiality check couldn't run. Check again, or confirm you've checked the teaser yourself.");
  problems.push(...ctx.discrepancyReasons);
  return problems;
}

/** The published snapshot: visible, written blocks only. */
export function publishedSnapshot(doc: TeaserDoc): TeaserDoc {
  return { header: clone(doc.header), blocks: doc.blocks.filter((b) => !b.hidden && !b.placeholder).map((b) => clone(b)) };
}
