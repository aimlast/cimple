/**
 * A broker's saved teaser templates (teaser_templates) and their brokerage-
 * wide teaser wording (branding_settings.teaser_settings).
 *
 * "Save as my teaser template" keeps the block list (slot, title, layout, a
 * layout skeleton with NO deal text) and the broker's own fixed wording
 * (next step, confidentiality, their custom prose), plus the settings (page
 * size, number style, the asking-price switch). Up to 20 per broker. Every
 * read and write is scoped to the broker: another broker's template is 404.
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

/** The blocks to save: no deal text — only the broker's own fixed wording travels. */
export function blocksForTemplate(doc: TeaserDoc): SavedTeaserBlock[] {
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

export interface TemplateListItem {
  id: string;
  key: string;
  name: string;
  basedOn: string | null;
  blocks: number;
  settings: SavedTemplateSettings;
  createdAt: string;
}

const listItem = (r: TemplateRowLike): TemplateListItem => ({
  id: r.id,
  key: savedTemplateKey(r.id),
  name: r.name,
  basedOn: r.basedOn,
  blocks: Array.isArray(r.blocks) ? r.blocks.length : 0,
  settings: (r.settings && typeof r.settings === "object" ? r.settings : {}) as SavedTemplateSettings,
  createdAt: r.createdAt.toISOString(),
});

export async function listTeaserTemplates(brokerId: string): Promise<{ templates: TemplateListItem[]; defaultTemplate: string | null }> {
  const [rows, settings] = await Promise.all([templates.list(brokerId), getTeaserSettings(brokerId)]);
  const items = rows.map(listItem);
  const def = settings.defaultTemplate;
  const valid = def && (isBuiltInTeaserTemplate(def) || items.some((t) => t.key === def)) ? def : null;
  return { templates: items, defaultTemplate: valid };
}

export async function saveTeaserTemplate(
  brokerId: string,
  input: { name: string; basedOn: string | null; doc: TeaserDoc; settings: SavedTemplateSettings; makeDefault?: boolean },
): Promise<TemplateListItem> {
  const name = input.name.replace(/\s+/g, " ").trim().slice(0, TEMPLATE_NAME_MAX);
  if (!name) throw new Error("Give the template a name.");
  const existing = await templates.list(brokerId);
  if (existing.length >= TEMPLATE_LIMIT) throw new TemplateLimitError();
  const basedOn = input.basedOn && isBuiltInTeaserTemplate(input.basedOn) ? input.basedOn : null;
  const row = await templates.insert({ brokerId, name, basedOn, blocks: blocksForTemplate(input.doc), settings: input.settings });
  if (input.makeDefault) await setDefaultTeaserTemplate(brokerId, savedTemplateKey(row.id));
  return listItem(row);
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
  return row ? templateFromSaved(row) : null;
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
