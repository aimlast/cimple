/**
 * Renditions — exactly what a buyer was served (shared/analytics-v2.ts
 * RenditionPage). GET /api/view/:token records one on its content branch
 * (the buildBuyerCim output after every blind guard, locked stubs
 * included, and the design payload), so the broker's heat map can be drawn
 * on the very version the buyer read — blind titles and all — and block
 * keys can be labelled from the SERVED data (a blind buyer's labels quote
 * the redacted text, never the real one).
 *
 *   id          first 32 hex of sha256 over {mode, variant, design, sections}:
 *               identical servings share one row (INSERT … ON CONFLICT DO NOTHING)
 *   page_index  pages in document order (sections + the brokerage disclaimer /
 *               contact pages exactly where the view room puts them), each
 *               with its lineage, printed parts, blocks and expected time
 *
 * The buyer only ever receives the opaque id and the page ids it was
 * already served (ViewRoomReading).
 */
import { createHash } from "crypto";
import { sql } from "drizzle-orm";
import {
  CONTACT_PAGE_ID,
  DISCLAIMER_PAGE_ID,
  blockFingerprint,
  blocksOf,
  brokeragePageBlocks,
  expectedMsOf,
  partCount,
  type CimBlock,
} from "@shared/cim-blocks";
import type { CimMode, CimVariant, RenditionBlock, RenditionPage, ViewRoomReading } from "@shared/analytics-v2";
import type { BuyerSection } from "@shared/cim-buyer-view";

/** teaser buyers get locked stubs; every other level is the "full" variant of its mode. */
export function variantForAccessLevel(level: string | null | undefined): CimVariant {
  return level === "teaser" ? "teaser" : "full";
}

/** The design flags the view room reads for the brokerage pages. */
interface DesignLike {
  brokerage?: { showDisclaimerPage?: boolean | null; showContactPage?: boolean | null } | null;
}

/**
 * The served pages in the view room's order: the disclaimer after the cover
 * (or first), the contact page last — client/src/components/cim/CimFrontBackPages.tsx
 * withBrokeragePages (mirrored; tests/unit/reading-ingest.test.ts holds them equal).
 */
export function servedPageOrder(sections: ReadonlyArray<{ id: string; layoutType: string }>, design: DesignLike | null | undefined): string[] {
  const ids = sections.map((s) => s.id);
  if (ids.length === 0) return ids;
  if (design?.brokerage?.showDisclaimerPage !== false) ids.splice(sections[0]?.layoutType === "cover_page" ? 1 : 0, 0, DISCLAIMER_PAGE_ID);
  if (design?.brokerage?.showContactPage !== false) ids.push(CONTACT_PAGE_ID);
  return ids;
}

const toRenditionBlock = (b: CimBlock): RenditionBlock => ({
  key: b.key,
  kind: b.kind,
  label: b.label,
  expectedMs: b.expectedMs,
  part: b.part,
  ...(b.virtual ? { virtual: true as const } : {}),
  ...(b.when ? { when: b.when } : {}),
});

/** The view room renders only visible sections (buildBuyerCim serves only those; kept defensive). */
const shownToBuyer = (s: BuyerSection) => (s as { isVisible?: boolean }).isVisible !== false;

/** A live section's analytics lineage (stable across regenerations). */
export interface LineageSource {
  id: string;
  analyticsLineage?: string | null;
}

/** The page index of a served CIM. Labels come from the SERVED sections only. */
export function buildPageIndex(
  sections: ReadonlyArray<BuyerSection>,
  design: DesignLike | null | undefined,
  live: ReadonlyArray<LineageSource> = [],
): RenditionPage[] {
  const shown = sections.filter(shownToBuyer);
  const byId = new Map(shown.map((s) => [s.id, s]));
  const lineage = new Map(live.map((s) => [s.id, s.analyticsLineage || s.id]));
  return servedPageOrder(shown, design).map((pageId, order): RenditionPage => {
    if (pageId === DISCLAIMER_PAGE_ID || pageId === CONTACT_PAGE_ID) {
      const blocks = brokeragePageBlocks(pageId);
      return {
        pageId, lineageId: pageId, order, parts: 1,
        servedTitle: pageId === DISCLAIMER_PAGE_ID ? "Confidentiality & disclaimer" : "Contact",
        layoutType: pageId === DISCLAIMER_PAGE_ID ? "disclaimer_page" : "contact_page",
        locked: false, expectedMs: expectedMsOf(blocks), blockFingerprint: blockFingerprint(pageId, blocks),
        blocks: blocks.map(toRenditionBlock),
      };
    }
    const s = byId.get(pageId)!;
    const blocks = blocksOf({ ...s, locked: s.locked === true });
    const defaultView = blocks.filter((b) => !b.virtual && !b.when);
    return {
      pageId,
      lineageId: lineage.get(pageId) ?? pageId,
      order,
      parts: partCount(blocks),
      servedTitle: s.sectionTitle,
      layoutType: s.layoutType,
      locked: s.locked === true,
      expectedMs: expectedMsOf(blocks),
      blockFingerprint: blockFingerprint(s.layoutType, defaultView),
      blocks: blocks.map(toRenditionBlock),
    };
  });
}

/** Stable JSON (sorted keys) so equal servings hash equal. */
function stableJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(",")}}`;
}

export function renditionId(input: { mode: CimMode; variant: CimVariant; design: unknown; sections: unknown }): string {
  return createHash("sha256").update(stableJson({ mode: input.mode, variant: input.variant, design: input.design ?? null, sections: input.sections })).digest("hex").slice(0, 32);
}

export interface RenditionInput {
  dealId: string;
  mode: CimMode;
  variant: CimVariant;
  cimLayoutVersion: number | null;
  sections: BuyerSection[];
  design: unknown;
  /** The deal's live sections (for lineage). */
  live: ReadonlyArray<LineageSource>;
}

export interface RenditionWriter {
  insert(row: { id: string; dealId: string; mode: string; variant: string; cimLayoutVersion: number | null; sections: unknown; design: unknown; pageIndex: RenditionPage[] }): Promise<void>;
}

/** Ids this process has already written (a GET is polled every 10–60 s: don't re-insert). */
const known = new Map<string, number>();
const KNOWN_MAX = 2_000;
/** Re-assert a known row daily (it may have been pruned meanwhile). */
const KNOWN_TTL_MS = 86_400_000;
/** A version nobody read is kept this long after it was first served. */
export const RENDITION_PRUNE_AFTER_DAYS = 30;

export const dbRenditionWriter: RenditionWriter = {
  async insert(row) {
    const { db } = await import("../db");
    const inserted = (await db.execute(sql`
      INSERT INTO cim_renditions (id, deal_id, mode, variant, cim_layout_version, sections, design, page_index)
      VALUES (${row.id}, ${row.dealId}, ${row.mode}, ${row.variant}, ${row.cimLayoutVersion},
              ${JSON.stringify(row.sections)}::jsonb, ${JSON.stringify(row.design ?? null)}::jsonb, ${JSON.stringify(row.pageIndex)}::jsonb)
      ON CONFLICT (id) DO NOTHING
      RETURNING id`)) as unknown as unknown[];
    // A new version was just served: drop this deal's old versions that
    // nobody ever read (each row holds the whole served CIM, and one is
    // written per access level × CIM edit). Kept: anything with a visit, an
    // event or a question on it, the newest version per mode × variant, and
    // any version this process is still serving.
    if (inserted.length > 0) {
      const serving = Array.from(known.keys()).concat(row.id).join(",");
      await db.execute(sql`
        DELETE FROM cim_renditions c
        WHERE c.deal_id = ${row.dealId}
          AND c.created_at < ${new Date(Date.now() - RENDITION_PRUNE_AFTER_DAYS * 86_400_000).toISOString()}::timestamp
          AND c.id <> ALL(string_to_array(${serving}, ','))
          AND c.id NOT IN (SELECT DISTINCT ON (mode, variant) id FROM cim_renditions
                           WHERE deal_id = ${row.dealId} ORDER BY mode, variant, created_at DESC)
          AND NOT EXISTS (SELECT 1 FROM buyer_visits v WHERE v.deal_id = c.deal_id AND v.rendition_id = c.id)
          AND NOT EXISTS (SELECT 1 FROM analytics_events e WHERE e.deal_id = c.deal_id AND e.rendition_id = c.id)
          AND NOT EXISTS (SELECT 1 FROM buyer_questions q WHERE q.deal_id = c.deal_id AND q.rendition_id = c.id)`)
        .catch((err: Error) => console.warn("[reading] rendition prune skipped:", err.message));
    }
  },
};

/**
 * Records what this buyer was served and returns the `reading` block for
 * the view room. Never throws into the view: a failure returns null (the
 * page still opens; nothing is tracked).
 */
export async function recordRendition(input: RenditionInput, writer: RenditionWriter = dbRenditionWriter): Promise<ViewRoomReading | null> {
  try {
    const shown = input.sections.filter(shownToBuyer);
    if (shown.length === 0) return null;
    const id = renditionId({ mode: input.mode, variant: input.variant, design: input.design, sections: input.sections });
    const pageIndex = buildPageIndex(input.sections, input.design as DesignLike, input.live);
    const seenAt = known.get(id);
    if (!seenAt || Date.now() - seenAt > KNOWN_TTL_MS) {
      await writer.insert({
        id, dealId: input.dealId, mode: input.mode, variant: input.variant, cimLayoutVersion: input.cimLayoutVersion,
        sections: input.sections, design: input.design, pageIndex,
      });
      known.delete(id);
      known.set(id, Date.now());
      if (known.size > KNOWN_MAX) known.delete(known.keys().next().value as string);
    }
    return { renditionId: id, pageOrder: pageIndex.map((p) => p.pageId) };
  } catch (err) {
    console.warn("[reading] rendition not recorded:", (err as Error)?.message);
    return null;
  }
}

/** Test hook: forget which ids were written. */
export function _resetRenditionCache(): void {
  known.clear();
}

/**
 * What a buyer at this access level is served right now — the same inputs
 * as GET /api/view/:token (buildBuyerCim over buyerCimRows — the kept copy
 * while an update is reviewed, a live CIM's approved versions otherwise —
 * with the codename that copy was redacted under, + the design payload).
 * Null while the CIM is held, the blind version is still being prepared or
 * nothing is shown. Used by the reading seeder (scripts/seed-reading-demo.ts)
 * and the legacy view (server/engagement/legacy.ts); the view room itself
 * records what it actually served.
 */
export async function servedCimFor(
  deal: import("@shared/schema").Deal,
  accessLevel: string,
  opts: { accessId?: string | null } = {},
): Promise<(RenditionInput & { accessLevel: string }) | null> {
  const [{ buildBuyerCim, cimHeldFromBuyers }, { designPayload }, { loadMediaAssets }, { listedAskingPrice }, { cimModeForAccessLevel }, { buyerCimRows, servedBlindCodename }] = await Promise.all([
    import("@shared/cim-buyer-view"),
    import("../cim/templates"),
    import("../cim/media-store"),
    import("../information/deal-mirror"),
    import("@shared/cim-layouts"),
    import("../cim/published-snapshot"),
  ]);
  if (cimHeldFromBuyers(deal)) return null;
  const mode = cimModeForAccessLevel(accessLevel);
  const [rows, media, keptCodename] = await Promise.all([
    buyerCimRows(deal, accessLevel),
    loadMediaAssets(deal.id),
    servedBlindCodename(deal),
  ]);
  if (rows.missing) return null;
  const servedDeal = keptCodename ? { ...deal, blindCodename: keptCodename } : deal;
  // The same extras as the view room (INTEGRATION §2.2), so the pages here —
  // the DD "How the figures check out" page included — are the ones buyers got.
  const { buyerCimExtras } = await import("../cim/buyer-extras");
  const extras = await buyerCimExtras(servedDeal, accessLevel, opts.accessId ?? null);
  const cim = buildBuyerCim({ deal: servedDeal, accessLevel, sections: rows.sections, overrides: rows.overrides, media, askingPrice: listedAskingPrice(deal), published: rows.published, figures: extras.figures });
  if (cim.preparing || cim.sections.length === 0) return null;
  const design = await designPayload(deal, mode);
  return {
    dealId: deal.id, mode, variant: variantForAccessLevel(accessLevel), cimLayoutVersion: deal.cimLayoutVersion ?? null,
    sections: cim.sections, design, live: rows.sections, accessLevel,
  };
}
