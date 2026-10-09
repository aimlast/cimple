/**
 * deal_teasers — one teaser per deal (shared/teaser.ts TeaserDoc as JSON).
 *
 * Every write is a locked read-modify-write (SELECT … FOR UPDATE inside one
 * transaction), so the broker's edits, a background AI run and a publish
 * never overwrite each other:
 *  - saveDraft(dealId, rev, mutate): optimistic concurrency on draft_rev
 *    (a mismatch → TeaserConflict "stale"), the previous draft pushed to
 *    history (≤ 20, for Undo); refused with "writing" while Cimple writes
 *    the whole teaser, or when the edit touches a block a run is filling;
 *  - saveOwnedBlocks(dealId, run, blocks): a background writer fills only
 *    blocks it owns that are still a placeholder or untouched since the run
 *    started (a broker edit made meanwhile wins), bumping draft_rev once.
 * A run still "running" after 3 minutes (at boot or on a read) reads as
 * failed: "Interrupted — try again".
 *
 * Tests swap in memory (_setTeaserStoreForTests(memoryTeaserStore())).
 */
import { eq, sql } from "drizzle-orm";
import { dealTeasers, type DealTeaser } from "@shared/schema";
import {
  EMPTY_TEASER_DOC,
  autoGrantLevel,
  type TeaserAutoGrant,
  type TeaserBlock,
  type TeaserDoc,
  type TeaserGeneration,
  type TeaserLinkLifetime,
  type TeaserPageSize,
  type TeaserSellerCheck,
} from "@shared/teaser";
import type { NumberStyle } from "@shared/deal-bands";

export interface TeaserHistoryEntry {
  at: string;
  reason: string;
  doc: TeaserDoc;
}

export interface TeaserRow {
  id: string;
  dealId: string;
  templateKey: string;
  designTemplateId: string | null;
  pageSize: TeaserPageSize;
  numbers: NumberStyle;
  showAskingPrice: boolean;
  linkLifetime: TeaserLinkLifetime;
  autoGrant: TeaserAutoGrant;
  draft: TeaserDoc;
  draftRev: number;
  history: TeaserHistoryEntry[];
  generation: TeaserGeneration | null;
  codenameUsed: string | null;
  reviewConfirmed: { by: string | null; at: string } | null;
  sellerCheck: TeaserSellerCheck | null;
  published: TeaserDoc | null;
  publishedRev: number;
  publishedAt: Date | null;
  unpublishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type TeaserPatch = Partial<Omit<TeaserRow, "id" | "dealId" | "createdAt">>;

export const HISTORY_MAX = 20;
/** A run still marked running after this is reported failed. */
export const RUN_STALE_MS = 3 * 60_000;
export const INTERRUPTED = "Interrupted — try again.";

export class TeaserConflict extends Error {
  constructor(public code: "stale" | "writing" | "missing", message?: string) {
    super(message ?? code);
  }
}

export interface TeaserStore {
  get(dealId: string): Promise<TeaserRow | null>;
  /** Insert a row for the deal (an existing one is returned unchanged). */
  create(dealId: string, init: TeaserPatch): Promise<TeaserRow>;
  /** Locked read-modify-write; `fn` returns the patch (null = no change). */
  update(dealId: string, fn: (row: TeaserRow) => TeaserPatch | null | Promise<TeaserPatch | null>): Promise<TeaserRow | null>;
  delete(dealId: string): Promise<void>;
  /** Every row (codename rename, dashboards). */
  listByDeals(dealIds: string[]): Promise<TeaserRow[]>;
}

const asDoc = (v: unknown): TeaserDoc => {
  if (!v || typeof v !== "object") return { header: null, blocks: [] };
  const d = v as Partial<TeaserDoc>;
  return { header: d.header ?? null, blocks: Array.isArray(d.blocks) ? (d.blocks as TeaserBlock[]) : [] };
};

export function rowFromDb(r: DealTeaser): TeaserRow {
  return {
    id: r.id,
    dealId: r.dealId,
    templateKey: r.templateKey,
    designTemplateId: r.designTemplateId ?? null,
    pageSize: (r.pageSize === "a4" ? "a4" : "letter") as TeaserPageSize,
    numbers: (r.numbers === "rounded" ? "rounded" : "ranges") as NumberStyle,
    showAskingPrice: r.showAskingPrice,
    linkLifetime: (["30", "90"].includes(r.linkLifetime) ? r.linkLifetime : "until_offline") as TeaserLinkLifetime,
    autoGrant: (autoGrantLevel(r.autoGrant) ?? "off") as TeaserAutoGrant,
    draft: asDoc(r.draft),
    draftRev: r.draftRev,
    history: Array.isArray(r.history) ? (r.history as TeaserHistoryEntry[]) : [],
    generation: (r.generation as TeaserGeneration | null) ?? null,
    codenameUsed: r.codenameUsed ?? null,
    reviewConfirmed: (r.reviewConfirmed as TeaserRow["reviewConfirmed"]) ?? null,
    sellerCheck: (r.sellerCheck as TeaserSellerCheck | null) ?? null,
    published: r.published ? asDoc(r.published) : null,
    publishedRev: r.publishedRev,
    publishedAt: r.publishedAt ?? null,
    unpublishedAt: r.unpublishedAt ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function toDb(p: TeaserPatch): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) if (v !== undefined) out[k] = v;
  return out;
}

const dbStore: TeaserStore = {
  async get(dealId) {
    const { db } = await import("../db");
    const [r] = await db.select().from(dealTeasers).where(eq(dealTeasers.dealId, dealId)).limit(1);
    return r ? rowFromDb(r) : null;
  },
  async create(dealId, init) {
    const { db } = await import("../db");
    await db.insert(dealTeasers).values({ dealId, ...(toDb(init) as object) } as typeof dealTeasers.$inferInsert).onConflictDoNothing();
    const [r] = await db.select().from(dealTeasers).where(eq(dealTeasers.dealId, dealId)).limit(1);
    return rowFromDb(r);
  },
  async update(dealId, fn) {
    const { db } = await import("../db");
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM deal_teasers WHERE deal_id = ${dealId} FOR UPDATE`);
      const [r] = await tx.select().from(dealTeasers).where(eq(dealTeasers.dealId, dealId)).limit(1);
      if (!r) return null;
      const row = rowFromDb(r);
      const patch = await fn(row);
      if (!patch) return row;
      const [u] = await tx.update(dealTeasers).set({ ...(toDb(patch) as object), updatedAt: new Date() } as never).where(eq(dealTeasers.dealId, dealId)).returning();
      return rowFromDb(u);
    });
  },
  async delete(dealId) {
    const { db } = await import("../db");
    await db.delete(dealTeasers).where(eq(dealTeasers.dealId, dealId));
  },
  async listByDeals(dealIds) {
    if (dealIds.length === 0) return [];
    const { db } = await import("../db");
    const { inArray } = await import("drizzle-orm");
    const rows = await db.select().from(dealTeasers).where(inArray(dealTeasers.dealId, dealIds));
    return rows.map(rowFromDb);
  },
};

/** An in-memory store (tests, offline proofs). Same semantics; serial updates. */
export function memoryTeaserStore(): TeaserStore & { rows: Map<string, TeaserRow> } {
  const rows = new Map<string, TeaserRow>();
  let chain: Promise<unknown> = Promise.resolve();
  const clone = <T>(v: T): T => (v === null || v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));
  const revive = (r: TeaserRow): TeaserRow => ({
    ...clone(r),
    publishedAt: r.publishedAt ? new Date(r.publishedAt) : null,
    unpublishedAt: r.unpublishedAt ? new Date(r.unpublishedAt) : null,
    createdAt: new Date(r.createdAt),
    updatedAt: new Date(r.updatedAt),
  });
  return {
    rows,
    async get(dealId) {
      const r = rows.get(dealId);
      return r ? revive(r) : null;
    },
    async create(dealId, init) {
      if (!rows.has(dealId)) {
        const now = new Date();
        rows.set(dealId, {
          id: `teaser-${dealId}`,
          dealId,
          templateKey: "one_page",
          designTemplateId: null,
          pageSize: "letter",
          numbers: "ranges",
          showAskingPrice: true,
          linkLifetime: "until_offline",
          autoGrant: "off",
          draft: clone(EMPTY_TEASER_DOC),
          draftRev: 0,
          history: [],
          generation: null,
          codenameUsed: null,
          reviewConfirmed: null,
          sellerCheck: null,
          published: null,
          publishedRev: 0,
          publishedAt: null,
          unpublishedAt: null,
          createdAt: now,
          updatedAt: now,
          ...(toDb(init) as Partial<TeaserRow>),
        });
      }
      return revive(rows.get(dealId)!);
    },
    async update(dealId, fn) {
      const run = chain.then(async () => {
        const r = rows.get(dealId);
        if (!r) return null;
        const patch = await fn(revive(r));
        if (!patch) return revive(r);
        const next = { ...r, ...(toDb(patch) as Partial<TeaserRow>), updatedAt: new Date() };
        rows.set(dealId, clone(next) as TeaserRow);
        return revive(rows.get(dealId)!);
      });
      chain = run.catch(() => undefined);
      return run;
    },
    async delete(dealId) {
      rows.delete(dealId);
    },
    async listByDeals(dealIds) {
      return dealIds.map((id) => rows.get(id)).filter((r): r is TeaserRow => !!r).map(revive);
    },
  };
}

let store: TeaserStore = dbStore;
/** Tests: keep teasers in memory (null restores the database). */
export function _setTeaserStoreForTests(s: TeaserStore | null): void {
  store = s ?? dbStore;
}
export function teaserStore(): TeaserStore {
  return store;
}

/** A running generation older than RUN_STALE_MS reads as failed. */
export function withStaleRunFailed(row: TeaserRow, now = Date.now()): TeaserRow {
  const g = row.generation;
  if (g?.status === "running" && now - Date.parse(g.startedAt) > RUN_STALE_MS) {
    return { ...row, generation: { ...g, status: "failed", error: INTERRUPTED, finishedAt: new Date(now).toISOString() } };
  }
  return row;
}

export async function getDealTeaser(dealId: string): Promise<TeaserRow | null> {
  const row = await store.get(dealId);
  if (!row) return null;
  const fixed = withStaleRunFailed(row);
  if (fixed !== row) {
    // Persist the "interrupted" outcome so every reader agrees.
    await store.update(dealId, (r) => (r.generation?.status === "running" ? { generation: withStaleRunFailed(r).generation } : null)).catch(() => undefined);
  }
  return fixed;
}

/** Published and online: buyers with a teaser link can read it. */
export function teaserPublished(row: Pick<TeaserRow, "published" | "unpublishedAt"> | null | undefined): boolean {
  return !!row && !!row.published && !row.unpublishedAt && row.published.blocks.length > 0;
}

/** Is a whole-teaser run in progress (every edit waits)? */
export function fullRewriteRunning(row: TeaserRow): boolean {
  const g = withStaleRunFailed(row).generation;
  return g?.status === "running" && !!g.fullRewrite;
}

/** Block ids a running background writer owns. */
export function ownedByRun(row: TeaserRow): Set<string> {
  const g = withStaleRunFailed(row).generation;
  return g?.status === "running" ? new Set(g.ownedBlockIds ?? []) : new Set();
}

export interface DraftMutation {
  doc: TeaserDoc;
  reason: string;
  /** Other row fields to set with the draft (settings, codename_used…). */
  extra?: TeaserPatch;
}

/**
 * Change the draft at `rev`. Throws TeaserConflict("stale") on a rev
 * mismatch and ("writing") while Cimple writes the teaser or the touched
 * blocks. `touches` = block ids the change edits (null = the whole doc).
 */
export async function saveDraft(
  dealId: string,
  rev: number,
  mutate: (doc: TeaserDoc, row: TeaserRow) => DraftMutation | null,
  touches: string[] | null = null,
): Promise<TeaserRow> {
  let conflict: TeaserConflict | null = null;
  const updated = await store.update(dealId, (row) => {
    if (row.draftRev !== rev) {
      conflict = new TeaserConflict("stale", "This teaser changed in another tab — showing the latest.");
      return null;
    }
    if (fullRewriteRunning(row)) {
      conflict = new TeaserConflict("writing", "Cimple is writing your teaser — try again in a moment.");
      return null;
    }
    const owned = ownedByRun(row);
    if (owned.size > 0 && (touches === null || touches.some((id) => owned.has(id)))) {
      conflict = new TeaserConflict("writing", "Cimple is writing this block — try again in a moment.");
      return null;
    }
    const m = mutate(row.draft, row);
    if (!m) return null;
    const history = [...row.history, { at: new Date().toISOString(), reason: m.reason, doc: row.draft }].slice(-HISTORY_MAX);
    return { ...(m.extra ?? {}), draft: m.doc, draftRev: row.draftRev + 1, history };
  });
  if (conflict) throw conflict;
  if (!updated) throw new TeaserConflict("missing", "There's no teaser yet.");
  return updated;
}

/**
 * A background writer saves its blocks: only blocks it owns that are still
 * a placeholder, or untouched since the run started (and not the broker's).
 * Adds owned blocks that don't exist yet (new slots) after their anchor.
 * Bumps draft_rev once and pushes one history entry.
 */
export async function saveOwnedBlocks(
  dealId: string,
  run: { startedAt: string; ownedBlockIds: string[] },
  blocks: TeaserBlock[],
  extra: TeaserPatch = {},
  reason = "Written by AI",
): Promise<{ row: TeaserRow | null; written: string[]; skipped: string[] }> {
  const written: string[] = [];
  const skipped: string[] = [];
  const started = Date.parse(run.startedAt);
  const owned = new Set(run.ownedBlockIds);
  const row = await store.update(dealId, (r) => {
    const next = r.draft.blocks.map((b) => {
      const incoming = blocks.find((x) => x.id === b.id);
      if (!incoming || !owned.has(b.id)) return b;
      const untouched = b.placeholder || (Date.parse(b.updatedAt) <= started && b.origin !== "broker");
      if (!untouched) {
        skipped.push(b.id);
        return b;
      }
      written.push(b.id);
      return incoming;
    });
    // New owned blocks (a template switch added slots).
    for (const b of blocks) {
      if (!owned.has(b.id) || next.some((x) => x.id === b.id)) continue;
      next.push(b);
      written.push(b.id);
    }
    const history = [...r.history, { at: new Date().toISOString(), reason, doc: r.draft }].slice(-HISTORY_MAX);
    return { ...extra, draft: { ...r.draft, blocks: next }, draftRev: r.draftRev + 1, history };
  });
  return { row, written, skipped };
}

export async function setGeneration(dealId: string, generation: TeaserGeneration | null, extra: TeaserPatch = {}): Promise<TeaserRow | null> {
  return store.update(dealId, () => ({ ...extra, generation }));
}

export async function deleteTeaser(dealId: string): Promise<void> {
  await store.delete(dealId);
}

/**
 * A codename rename (server/cim/codenames.ts): the old codename swapped in
 * the draft, the published copy and the seller-check copy. Returns how many
 * documents changed (0 or 1 row; counted per document).
 */
export async function renameTeaserCodename(dealId: string, swap: (s: string) => string, next: string): Promise<number> {
  const { mapStrings } = await import("@shared/blind-guard");
  let changed = 0;
  await store.update(dealId, (r) => {
    const draft = mapStrings(r.draft, swap);
    const published = r.published ? mapStrings(r.published, swap) : null;
    const sellerCheck = r.sellerCheck ? { ...r.sellerCheck, doc: mapStrings(r.sellerCheck.doc, swap) } : null;
    if (JSON.stringify(draft) !== JSON.stringify(r.draft)) changed++;
    if (JSON.stringify(published) !== JSON.stringify(r.published)) changed++;
    if (JSON.stringify(sellerCheck) !== JSON.stringify(r.sellerCheck)) changed++;
    return { draft, published, sellerCheck, codenameUsed: next };
  });
  return changed;
}
