/**
 * A broker's saved teaser templates (teaser_templates) and their brokerage-
 * wide teaser wording (branding_settings.teaser_settings).
 *
 * "Save as my teaser template" keeps the block list (slot, title, layout, a
 * layout skeleton with NO deal text) and the broker's own fixed wording
 * (next step, confidentiality, their custom prose), plus the settings (page
 * size, number style, the asking-price switch). Up to 20 per broker. Every
 * read and write is scoped to the broker: another broker's template is 404.
 *
 * Nothing that belongs to the deal it was saved from may travel: every title
 * and every line of the broker's wording is checked against THAT deal's
 * identity terms (the Blind CIM's check) and for its figures. A title that
 * names it falls back to the built-in title; a sentence or line that names it
 * (or carries a money figure, a percentage or a year) is left out — and the
 * broker is told what was left out. The deal's codename becomes
 * {codename}, filled with the new deal's codename when the template is used.
 * Using a template re-runs the same check against the source deal as it is
 * now (a name added to its facts after saving is still caught).
 */
import { and, asc, eq } from "drizzle-orm";
import { teaserTemplates, type TeaserTemplateRow } from "@shared/schema";
import type { TeaserDoc, TeaserPageSize } from "@shared/teaser";
import type { NumberStyle } from "@shared/deal-bands";
import {
  TEASER_TEMPLATES,
  savedTemplateId,
  savedTemplateKey,
  templateFromSaved,
  type SavedTeaserBlock,
  type TeaserTemplateDef,
} from "@shared/teaser-templates";
import { isBuiltInTeaserTemplate } from "@shared/teaser";
import { blindLeakTerms, foldForMatch, mapStrings, type BlindTerm } from "@shared/blind-guard";
import { guardTeaserText, heldReason } from "@shared/teaser-guard";
import { CODENAME_TOKEN } from "@shared/teaser-templates";
import { NO_CODENAME } from "@shared/teaser-view";

export const TEMPLATE_LIMIT = 20;
export const TEMPLATE_NAME_MAX = 80;
export const WORDING_MAX = 400;

export class TemplateLimitError extends Error {
  constructor() {
    super(`You can keep up to ${TEMPLATE_LIMIT} teaser templates. Delete one to save another.`);
  }
}

export interface SavedTemplateSettings {
  pageSize?: TeaserPageSize;
  numbers?: NumberStyle;
  showAskingPrice?: boolean;
  /** The deal it was saved from (server-only): using the template re-checks against that deal as it is now. */
  sourceDealId?: string;
}

export interface TemplateRowLike {
  id: string;
  brokerId: string;
  name: string;
  basedOn: string | null;
  blocks: unknown;
  settings: unknown;
  createdAt: Date;
  updatedAt: Date;
}

export interface TemplatesStore {
  list(brokerId: string): Promise<TemplateRowLike[]>;
  get(brokerId: string, id: string): Promise<TemplateRowLike | null>;
  insert(row: Omit<TemplateRowLike, "id" | "createdAt" | "updatedAt">): Promise<TemplateRowLike>;
  update(brokerId: string, id: string, patch: Partial<Pick<TemplateRowLike, "name">>): Promise<TemplateRowLike | null>;
  delete(brokerId: string, id: string): Promise<boolean>;
}

const fromDb = (r: TeaserTemplateRow): TemplateRowLike => ({ ...r, basedOn: r.basedOn ?? null });

const dbTemplates: TemplatesStore = {
  async list(brokerId) {
    const { db } = await import("../db");
    return (await db.select().from(teaserTemplates).where(eq(teaserTemplates.brokerId, brokerId)).orderBy(asc(teaserTemplates.createdAt))).map(fromDb);
  },
  async get(brokerId, id) {
    const { db } = await import("../db");
    const [r] = await db.select().from(teaserTemplates).where(and(eq(teaserTemplates.id, id), eq(teaserTemplates.brokerId, brokerId))).limit(1);
    return r ? fromDb(r) : null;
  },
  async insert(row) {
    const { db } = await import("../db");
    const [r] = await db.insert(teaserTemplates).values(row as typeof teaserTemplates.$inferInsert).returning();
    return fromDb(r);
  },
  async update(brokerId, id, patch) {
    const { db } = await import("../db");
    const [r] = await db.update(teaserTemplates).set({ ...patch, updatedAt: new Date() }).where(and(eq(teaserTemplates.id, id), eq(teaserTemplates.brokerId, brokerId))).returning();
    return r ? fromDb(r) : null;
  },
  async delete(brokerId, id) {
    const { db } = await import("../db");
    const r = await db.delete(teaserTemplates).where(and(eq(teaserTemplates.id, id), eq(teaserTemplates.brokerId, brokerId))).returning({ id: teaserTemplates.id });
    return r.length > 0;
  },
};

export function memoryTemplatesStore(): TemplatesStore & { rows: TemplateRowLike[] } {
  const rows: TemplateRowLike[] = [];
  let n = 0;
  return {
    rows,
    async list(brokerId) {
      return rows.filter((r) => r.brokerId === brokerId).map((r) => ({ ...r }));
    },
    async get(brokerId, id) {
      const r = rows.find((x) => x.id === id && x.brokerId === brokerId);
      return r ? { ...r } : null;
    },
    async insert(row) {
      const r = { ...row, id: `tpl-${++n}`, createdAt: new Date(), updatedAt: new Date() };
      rows.push(r);
      return { ...r };
    },
    async update(brokerId, id, patch) {
      const r = rows.find((x) => x.id === id && x.brokerId === brokerId);
      if (!r) return null;
      Object.assign(r, patch, { updatedAt: new Date() });
      return { ...r };
    },
    async delete(brokerId, id) {
      const i = rows.findIndex((x) => x.id === id && x.brokerId === brokerId);
      if (i < 0) return false;
      rows.splice(i, 1);
      return true;
    },
  };
}

let templates: TemplatesStore = dbTemplates;
export function _setTemplatesStoreForTests(s: TemplatesStore | null): void {
  templates = s ?? dbTemplates;
}

/** Layout skeleton: the same structure with every string blanked (no deal text) — cells and lists emptied. */
export function skeletonOf(data: unknown, depth = 0): unknown {
  if (depth > 8 || data === null || data === undefined) return data ?? null;
  if (typeof data === "string") return "";
  if (typeof data === "number") return 0;
  if (typeof data === "boolean") return data;
  if (Array.isArray(data)) return [];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if (k === "cells" || k === "metrics" || k === "stats" || k === "items" || k === "tags" || k === "data") out[k] = [];
    else if (k === "indexed" || k === "columns" || k === "style" || k === "ordered" || k === "layoutType" || k === "series") out[k] = k === "series" ? [] : v;
    else out[k] = skeletonOf(v, depth + 1);
  }
  return out;
}

/** The blocks as they stand in the doc (titles and the broker's wording verbatim) — always scrubbed before saving. */
function rawBlocksForTemplate(doc: TeaserDoc): SavedTeaserBlock[] {
  return doc.blocks.map((b) => {
    const own = b.origin === "broker" && b.layoutType === "prose_highlight" && (b.slot === "confidentiality" || b.slot === "custom")
      ? (b.body ?? "")
      : b.origin === "broker" && b.slot === "next_step"
        ? ((b.layoutData.items as Array<{ title?: string }> | undefined) ?? []).map((i) => i.title ?? "").filter((t) => t && !t.startsWith("Questions?")).join("\n")
        : "";
    const slot = b.slot === "custom" ? `custom_${b.id.slice(0, 8)}` : b.slot;
    return { slot, title: b.title, layoutType: b.layoutType, skeleton: skeletonOf(b.layoutData) as Record<string, unknown>, ...(own.trim() ? { fixedText: own.trim().slice(0, 4000) } : {}) };
  });
}

// ── Keeping the source deal out of a template ──────────────────────────────

/** Who the source deal is: its identity terms (the Blind CIM's) and every codename it has used. */
export interface TemplateScrub {
  terms: BlindTerm[];
  codenames: string[];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A figure that is the deal's own information: a money sign, a percentage, or a number of three or more digits (a year, a count, an amount). */
export function dealFigureIn(text: string): string | null {
  const m = /[$€£¥]\s*\d[\d,.]*\s*[kKmMbB]?|\d[\d,.]*\s*%|\d[\d,.]*\s*per ?cent|\d(?:[\d,.]*\d){2,}/i.exec(text);
  return m ? m[0].trim() : null;
}

function tokeniseCodenames(text: string, codenames: string[]): string {
  let out = text;
  for (const c of codenames.filter((x) => x && x.trim() && x !== NO_CODENAME).sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(escapeRe(c.trim()), "gi"), CODENAME_TOKEN);
  }
  return out;
}

/** Why a piece of text can't travel ("it names “Surrey” (the town)"), or null when it can. */
function belongsToDeal(text: string, scrub: TemplateScrub): string | null {
  const plain = text.split(CODENAME_TOKEN).join(" ");
  const g = guardTeaserText(plain, scrub.terms);
  if (g.leaks.length > 0) return heldReason({ ...g, placeholders: [] }, scrub.terms);
  const fig = dealFigureIn(plain);
  if (fig) return `it has a figure from this deal (“${fig}”)`;
  return null;
}

/** The broker's wording with every line or sentence that belongs to the source deal left out. */
function scrubWording(text: string, scrub: TemplateScrub, where: string, leftOut: string[], unit: "sentence" | "line" = "sentence"): string {
  const keptLines: string[] = [];
  for (const line of tokeniseCodenames(text, scrub.codenames).split("\n")) {
    const sentences = line.split(/(?<=[.!?])\s+/);
    const kept: string[] = [];
    for (const s of sentences) {
      if (!s.trim()) continue;
      const why = belongsToDeal(s, scrub);
      if (why) leftOut.push(`A ${unit} in ${where}: ${why}`);
      else kept.push(s);
    }
    if (kept.length > 0) keptLines.push(kept.join(" "));
  }
  return keptLines.join("\n").trim();
}

const BUILT_IN_TITLES = new Map<string, string>();
for (const t of Object.values(TEASER_TEMPLATES)) for (const s of t.slots) if (!BUILT_IN_TITLES.has(s.slot)) BUILT_IN_TITLES.set(s.slot, s.title);

/** The built-in title for a slot (from the template it was based on, else any built-in), "" for the broker's own block. */
function builtInTitle(slot: string, basedOn: string | null): string {
  const base = basedOn && isBuiltInTeaserTemplate(basedOn) ? TEASER_TEMPLATES[basedOn] : null;
  return base?.slots.find((s) => s.slot === slot)?.title ?? BUILT_IN_TITLES.get(slot) ?? "";
}

const named = (title: string) => (title.trim() ? `“${title.trim()}”` : "an untitled block");

/**
 * Saved blocks with nothing of the source deal: titles that name it fall
 * back to the built-in title, the broker's wording keeps only the lines
 * and sentences that don't name it or carry its figures, the codename
 * becomes {codename}, and any text left in a layout skeleton is checked
 * too. `leftOut` says, in plain words, what was dropped and why.
 */
export function scrubSavedBlocks(blocks: SavedTeaserBlock[], scrub: TemplateScrub, basedOn: string | null): { blocks: SavedTeaserBlock[]; leftOut: string[] } {
  const leftOut: string[] = [];
  const out = blocks.map((b) => {
    const rawTitle = typeof b.title === "string" ? b.title : "";
    let title = tokeniseCodenames(rawTitle, scrub.codenames);
    const titleWhy = title.trim() ? belongsToDeal(title, scrub) : null;
    if (titleWhy) {
      const fallback = builtInTitle(b.slot, basedOn);
      leftOut.push(`The title ${named(rawTitle)}: ${titleWhy}${fallback ? ` — it's “${fallback}” in the template` : ""}`);
      title = fallback;
    }
    const where = title.trim() ? named(title) : rawTitle.trim() ? `the block titled ${named(rawTitle)}` : b.slot === "confidentiality" ? "the confidentiality note" : "your own block";
    const skeleton = mapStrings(b.skeleton ?? {}, (s) => {
      if (!s) return s;
      const t = tokeniseCodenames(s, scrub.codenames);
      return belongsToDeal(t, scrub) ? "" : t;
    });
    const next: SavedTeaserBlock = { slot: b.slot, title, layoutType: b.layoutType, skeleton };
    if (typeof b.fixedText === "string" && b.fixedText.trim()) {
      const text = scrubWording(b.fixedText, scrub, where, leftOut, b.slot === "next_step" ? "line" : "sentence");
      if (text) next.fixedText = text;
    }
    return next;
  });
  return { blocks: out, leftOut };
}

/** The blocks to save: no deal text — only the broker's own wording travels, minus anything of the source deal. */
export function blocksForTemplate(doc: TeaserDoc, scrub: TemplateScrub, basedOn: string | null = null): { blocks: SavedTeaserBlock[]; leftOut: string[] } {
  return scrubSavedBlocks(rawBlocksForTemplate(doc), scrub, basedOn);
}

/**
 * The given names of the deal's people ("Harjit" of "Harjit Sandhu"). The
 * Blind CIM's check doesn't flag a first name alone (too many false hits in
 * a whole CIM), but a template is the broker's short wording travelling to
 * ANOTHER deal: "Call Harjit for a tour" must stay behind.
 */
export function givenNamesOf(terms: BlindTerm[]): string[] {
  const fold = (w: string) => foldForMatch(w);
  const surnames = new Set(terms.filter((t) => t.kind === "person" && !t.text.trim().includes(" ")).map((t) => fold(t.text)));
  const out = new Set<string>();
  for (const t of terms) {
    if (t.kind !== "person" && t.kind !== "name") continue;
    const words = t.text.trim().split(/\s+/);
    if (words.length < 2 || words.length > 3) continue;
    // A business-name term counts only when it is a person's name (the owner): its last word is a known surname.
    if (t.kind === "name" && !surnames.has(fold(words[words.length - 1]))) continue;
    const first = words[0];
    if (!/^[A-Z][a-zà-ÿ'’-]{2,}$/.test(first)) continue; // never "Dr." or an initial
    out.add(first);
  }
  return Array.from(out);
}

/** A deal's template scrub from its facts and codenames (pure). */
export function templateScrubOf(deal: { businessName?: string | null; extractedInfo?: unknown; employeeChart?: unknown; industry?: string | null; subIndustry?: string | null }, served: string, codenames: string[]): TemplateScrub {
  const base = blindLeakTerms(deal, { codename: served || NO_CODENAME });
  const terms = blindLeakTerms(deal, { codename: served || NO_CODENAME, extraPeople: givenNamesOf(base) });
  return { terms, codenames: Array.from(new Set([served, ...codenames].filter((c): c is string => typeof c === "string" && !!c.trim() && c !== NO_CODENAME))) };
}

/** The scrub for a deal: its identity terms (+ its people's given names) and every codename buyers have been or are served. */
export async function templateScrubFor(deal: import("@shared/schema").Deal, extraCodenames: Array<string | null | undefined> = []): Promise<TemplateScrub> {
  const { servedCodenameFor } = await import("./summary");
  const served = await servedCodenameFor(deal).catch(() => deal.blindCodename ?? NO_CODENAME);
  return templateScrubOf(deal, served, [deal.blindCodename, ...extraCodenames].filter((c): c is string => typeof c === "string"));
}

/** The source deal's scrub as it is now (null when it's gone or isn't this broker's). */
type SourceScrub = (dealId: string, brokerId: string) => Promise<TemplateScrub | null>;
const dbSourceScrub: SourceScrub = async (dealId, brokerId) => {
  const { storage } = await import("../storage");
  const deal = await storage.getDeal(dealId).catch(() => undefined);
  if (!deal || deal.brokerId !== brokerId) return null;
  const { getDealTeaser } = await import("./store");
  const row = await getDealTeaser(deal.id).catch(() => null);
  return templateScrubFor(deal, [row?.codenameUsed]);
};
let sourceScrub: SourceScrub = dbSourceScrub;
export function _setTemplateSourceScrubForTests(fn: SourceScrub | null): void {
  sourceScrub = fn ?? dbSourceScrub;
}

export interface TemplateListItem {
  id: string;
  key: string;
  name: string;
  basedOn: string | null;
  blocks: number;
  settings: SavedTemplateSettings;
  createdAt: string;
}

const listItem = (r: TemplateRowLike): TemplateListItem => {
  const { sourceDealId: _source, ...settings } = (r.settings && typeof r.settings === "object" ? r.settings : {}) as SavedTemplateSettings;
  return {
    id: r.id,
    key: savedTemplateKey(r.id),
    name: r.name,
    basedOn: r.basedOn,
    blocks: Array.isArray(r.blocks) ? r.blocks.length : 0,
    settings,
    createdAt: r.createdAt.toISOString(),
  };
};

export async function listTeaserTemplates(brokerId: string): Promise<{ templates: TemplateListItem[]; defaultTemplate: string | null }> {
  const [rows, settings] = await Promise.all([templates.list(brokerId), getTeaserSettings(brokerId)]);
  const items = rows.map(listItem);
  const def = settings.defaultTemplate;
  const valid = def && (isBuiltInTeaserTemplate(def) || items.some((t) => t.key === def)) ? def : null;
  return { templates: items, defaultTemplate: valid };
}

export async function saveTeaserTemplate(
  brokerId: string,
  input: { name: string; basedOn: string | null; doc: TeaserDoc; settings: SavedTemplateSettings; makeDefault?: boolean; scrub: TemplateScrub; sourceDealId?: string },
): Promise<TemplateListItem & { leftOut: string[] }> {
  const name = input.name.replace(/\s+/g, " ").trim().slice(0, TEMPLATE_NAME_MAX);
  if (!name) throw new Error("Give the template a name.");
  const existing = await templates.list(brokerId);
  if (existing.length >= TEMPLATE_LIMIT) throw new TemplateLimitError();
  const basedOn = input.basedOn && isBuiltInTeaserTemplate(input.basedOn) ? input.basedOn : null;
  const { blocks, leftOut } = blocksForTemplate(input.doc, input.scrub, basedOn);
  const settings: SavedTemplateSettings = { ...input.settings, ...(input.sourceDealId ? { sourceDealId: input.sourceDealId } : {}) };
  const row = await templates.insert({ brokerId, name, basedOn, blocks, settings });
  if (input.makeDefault) await setDefaultTeaserTemplate(brokerId, savedTemplateKey(row.id));
  return { ...listItem(row), leftOut };
}

export async function renameTeaserTemplate(brokerId: string, id: string, patch: { name?: string; makeDefault?: boolean }): Promise<TemplateListItem | null> {
  let row = await templates.get(brokerId, id);
  if (!row) return null;
  if (typeof patch.name === "string") {
    const name = patch.name.replace(/\s+/g, " ").trim().slice(0, TEMPLATE_NAME_MAX);
    if (!name) throw new Error("Give the template a name.");
    row = (await templates.update(brokerId, id, { name })) ?? row;
  }
  if (patch.makeDefault === true) await setDefaultTeaserTemplate(brokerId, savedTemplateKey(id));
  if (patch.makeDefault === false) {
    const s = await getTeaserSettings(brokerId);
    if (s.defaultTemplate === savedTemplateKey(id)) await setDefaultTeaserTemplate(brokerId, null);
  }
  return listItem(row);
}

export async function deleteTeaserTemplate(brokerId: string, id: string): Promise<boolean> {
  const ok = await templates.delete(brokerId, id);
  if (ok) {
    const s = await getTeaserSettings(brokerId);
    if (s.defaultTemplate === savedTemplateKey(id)) await setDefaultTeaserTemplate(brokerId, null);
  }
  return ok;
}

/** A "saved:<id>" key → the template definition (broker-scoped; null when it isn't theirs or is gone). */
export async function savedTemplateDef(key: string, brokerId: string): Promise<TeaserTemplateDef | null> {
  const id = savedTemplateId(key);
  if (!id) return isBuiltInTeaserTemplate(key) ? TEASER_TEMPLATES[key] : null;
  const row = await templates.get(brokerId, id);
  if (!row) return null;
  // Re-check against the deal it came from, as that deal is now (a name added since saving is still caught).
  const source = ((row.settings && typeof row.settings === "object" ? row.settings : {}) as SavedTemplateSettings).sourceDealId;
  const scrub = source ? await sourceScrub(source, brokerId).catch(() => null) : null;
  const blocks = scrub && Array.isArray(row.blocks) ? scrubSavedBlocks(row.blocks as SavedTeaserBlock[], scrub, row.basedOn).blocks : row.blocks;
  return templateFromSaved({ ...row, blocks });
}

// ── Brokerage-wide teaser wording (branding_settings.teaser_settings) ──────

export interface TeaserBrokerSettings {
  defaultTemplate: string | null;
  confidentiality: string | null;
  nextStep: string | null;
}

export interface TeaserSettingsStore {
  get(brokerId: string): Promise<Record<string, unknown> | null>;
  set(brokerId: string, value: Record<string, unknown>): Promise<void>;
}

const dbSettings: TeaserSettingsStore = {
  async get(brokerId) {
    const { storage } = await import("../storage");
    const b = await storage.getBrandingByBroker(brokerId);
    const v = (b as { teaserSettings?: unknown } | undefined)?.teaserSettings;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  },
  async set(brokerId, value) {
    const { storage } = await import("../storage");
    const b = await storage.getBrandingByBroker(brokerId);
    if (b) await storage.updateBrandingSettings(b.id, { teaserSettings: value } as never);
    else await storage.createBrandingSettings({ brokerId, teaserSettings: value } as never);
  },
};

let settingsStore: TeaserSettingsStore = dbSettings;
export function _setTeaserSettingsStoreForTests(s: TeaserSettingsStore | null): void {
  settingsStore = s ?? dbSettings;
}

const clean = (v: unknown, max = WORDING_MAX): string | null => {
  if (typeof v !== "string") return null;
  const t = v.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return t ? t.slice(0, max) : null;
};

export async function getTeaserSettings(brokerId: string): Promise<TeaserBrokerSettings> {
  const raw = (await settingsStore.get(brokerId).catch(() => null)) ?? {};
  return {
    defaultTemplate: typeof raw.defaultTemplate === "string" ? raw.defaultTemplate : null,
    confidentiality: clean(raw.confidentiality),
    nextStep: clean(raw.nextStep),
  };
}

export async function patchTeaserSettings(brokerId: string, patch: { confidentiality?: string | null; nextStep?: string | null; defaultTemplate?: string | null }): Promise<TeaserBrokerSettings> {
  const cur = await getTeaserSettings(brokerId);
  const next = { ...cur };
  if (patch.confidentiality !== undefined) next.confidentiality = clean(patch.confidentiality);
  if (patch.nextStep !== undefined) next.nextStep = clean(patch.nextStep);
  if (patch.defaultTemplate !== undefined) next.defaultTemplate = patch.defaultTemplate;
  await settingsStore.set(brokerId, next as unknown as Record<string, unknown>);
  return next;
}

export async function setDefaultTeaserTemplate(brokerId: string, key: string | null): Promise<void> {
  await patchTeaserSettings(brokerId, { defaultTemplate: key });
}
