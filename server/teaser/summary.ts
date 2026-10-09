/**
 * The teaser's state for the broker.
 *
 *  - teaserSummary(deal, row): the light summary (CIM tab strip, Buyers tab,
 *    dashboard, the 2 s poll while writing). Held blocks reach the broker
 *    without being looked for: every published block is re-checked with the
 *    CURRENT identity terms. The checks are cached per (published_rev,
 *    draft_rev, the deal's updatedAt, the served codename); reading counts
 *    are cached 15 s.
 *  - teaserState(deal, row): the full state (Teaser tab, editor) — the draft
 *    with per-block checks (never stored), staleness, the seller line.
 */
import type { Deal } from "@shared/schema";
import { TEASER_ACCESS_LEVEL } from "@shared/access-levels";
import { type TeaserBlockCheck, type TeaserDoc, type TeaserSummary } from "@shared/teaser";
import { guardTeaserText } from "@shared/teaser-guard";
import { checkTeaserDoc, swapCodename, teaserDocDiff, teaserTerms, NO_CODENAME } from "@shared/teaser-view";
import { TEASER_TEMPLATES, savedTemplateId } from "@shared/teaser-templates";
import { isBuiltInTeaserTemplate } from "@shared/teaser";
import { teaserPublished, withStaleRunFailed, type TeaserRow } from "./store";
import { teaserEngagement } from "./engagement";

export async function servedCodenameFor(deal: Deal): Promise<string> {
  const { servedBlindCodename } = await import("../cim/published-snapshot");
  return (await servedBlindCodename(deal).catch(() => null)) ?? deal.blindCodename ?? NO_CODENAME;
}

function statusOf(row: TeaserRow | null): TeaserSummary["status"] {
  if (!row) return "none";
  if (row.published && row.unpublishedAt) return "offline";
  if (teaserPublished(row)) return "published";
  return "draft";
}

function sellerLine(row: TeaserRow): TeaserSummary["seller"] {
  const s = row.sellerCheck;
  if (!s) return { state: "none", at: null, note: null };
  if (s.status === "sent") return { state: "sent", at: s.sentAt, note: null };
  if (s.status === "changes_requested") return { state: "changes_requested", at: s.at ?? null, note: s.note ?? null };
  // Approved: the current draft, or an earlier version.
  return { state: s.sentRev === row.draftRev ? "approved" : "approved_earlier", at: s.at ?? null, note: null };
}

interface CheckCache {
  key: string;
  heldBlocks: TeaserSummary["heldBlocks"];
  draftHeldBlocks: TeaserSummary["draftHeldBlocks"];
  pinpointCount: number;
}
const checkCache = new Map<string, CheckCache>();
const countCache = new Map<string, { at: number; counts: TeaserSummary["counts"] }>();
export function _resetTeaserSummaryCacheForTests(): void {
  checkCache.clear();
  countCache.clear();
}

const titleOf = (doc: TeaserDoc | null, id: string) => doc?.blocks.find((b) => b.id === id)?.title || "A block";

function held(doc: TeaserDoc | null, checks: TeaserBlockCheck[]): TeaserSummary["heldBlocks"] {
  return checks
    .filter((c) => (c.held || !!c.layoutProblem) && doc?.blocks.some((b) => b.id === c.blockId && !b.hidden && !b.placeholder))
    .map((c) => ({ blockId: c.blockId, title: titleOf(doc, c.blockId), reason: c.reason ?? c.layoutProblem ?? "" }));
}

/** The light summary. Never throws for a missing row (status "none"). */
export async function teaserSummary(deal: Deal, row: TeaserRow | null, opts: { counts?: boolean; now?: number } = {}): Promise<TeaserSummary> {
  const counts = opts.counts === false ? emptyCounts() : await countsFor(deal.id, opts.now);
  if (!row) {
    return {
      status: "none", templateKey: null, publishedAt: null, unpublishedAt: null, draftRev: 0, publishedRev: 0, changedSincePublish: 0,
      heldBlocks: [], draftHeldBlocks: [], pinpointCount: 0, seller: { state: "none", at: null, note: null }, generation: null, reviewNeeded: false, counts,
    };
  }
  const r = withStaleRunFailed(row);
  const codename = await servedCodenameFor(deal);
  const key = [r.publishedRev, r.draftRev, deal.updatedAt ? new Date(deal.updatedAt).getTime() : 0, codename].join("|");
  let c = checkCache.get(deal.id);
  if (!c || c.key !== key) {
    const terms = teaserTerms(deal, codename);
    const pub = r.published ? swapCodename(r.published, r.codenameUsed, codename) : null;
    const draft = swapCodename(r.draft, r.codenameUsed, codename);
    const pubChecks = checkTeaserDoc(pub, terms);
    const draftChecks = checkTeaserDoc(draft, terms);
    c = {
      key,
      heldBlocks: teaserPublished(r) ? held(pub, pubChecks) : [],
      draftHeldBlocks: held(draft, draftChecks),
      pinpointCount: draftChecks.filter((x) => x.pinpoint.length > 0 && draft.blocks.some((b) => b.id === x.blockId && !b.hidden)).length,
    };
    checkCache.set(deal.id, c);
    if (checkCache.size > 2_000) checkCache.delete(checkCache.keys().next().value as string);
  }
  const diff = teaserDocDiff(r.draft, r.published);
  const g = r.generation;
  return {
    status: statusOf(r),
    templateKey: r.templateKey,
    publishedAt: r.publishedAt ? r.publishedAt.toISOString() : null,
    unpublishedAt: r.unpublishedAt ? r.unpublishedAt.toISOString() : null,
    draftRev: r.draftRev,
    publishedRev: r.publishedRev,
    changedSincePublish: r.published ? diff.changed + diff.added + diff.removed + (diff.headerChanged ? 1 : 0) : 0,
    heldBlocks: c.heldBlocks,
    draftHeldBlocks: c.draftHeldBlocks,
    pinpointCount: c.pinpointCount,
    seller: sellerLine(r),
    generation: g ? { status: g.status, error: g.error ?? null, basis: g.basis ?? null, startedAt: g.startedAt, reviewFailed: !!g.reviewFailed, warnings: g.warnings ?? [] } : null,
    reviewNeeded: !!g?.reviewFailed && !r.reviewConfirmed,
    counts,
  };
}

function emptyCounts(): TeaserSummary["counts"] {
  return { links: 0, opened: 0, openedToday: 0, asked: 0, granted: 0, passed: 0, worthACall: 0, freshLinkRequests: 0 };
}

async function countsFor(dealId: string, now = Date.now()): Promise<TeaserSummary["counts"]> {
  const cached = countCache.get(dealId);
  if (cached && now - cached.at < 15_000) return cached.counts;
  try {
    const e = await teaserEngagement(dealId, now);
    const counts = {
      links: e.buyers.filter((b) => b.active && !b.expired).length,
      opened: e.funnel.opened,
      openedToday: e.openedToday,
      asked: e.funnel.asked,
      granted: e.funnel.granted,
      passed: e.funnel.passed,
      worthACall: e.buyers.filter((b) => b.worthACall).length,
      freshLinkRequests: e.buyers.filter((b) => b.freshLinkRequestedAt && b.active && b.expired).length,
    };
    countCache.set(dealId, { at: now, counts });
    return counts;
  } catch (err) {
    console.warn(`[teaser] counts failed for deal ${dealId}:`, (err as Error)?.message);
    return emptyCounts();
  }
}

/** The template's display name ("One-page teaser", a saved template's own name). */
export async function templateName(key: string, brokerId: string): Promise<string> {
  if (isBuiltInTeaserTemplate(key)) return TEASER_TEMPLATES[key].name;
  if (savedTemplateId(key)) {
    const { savedTemplateDef } = await import("./templates-store");
    return (await savedTemplateDef(key, brokerId).catch(() => null))?.name ?? "Your template";
  }
  return TEASER_TEMPLATES.one_page.name;
}

export interface TeaserStateView {
  teaser: {
    id: string;
    templateKey: string;
    templateName: string;
    designTemplateId: string | null;
    pageSize: TeaserRow["pageSize"];
    numbers: TeaserRow["numbers"];
    showAskingPrice: boolean;
    linkLifetime: TeaserRow["linkLifetime"];
    autoGrant: TeaserRow["autoGrant"];
    draft: TeaserDoc;
    draftRev: number;
    checks: TeaserBlockCheck[];
    headerProblem: string | null;
    codename: string;
    codenameProblem: string | null;
    generation: TeaserRow["generation"];
    reviewConfirmed: TeaserRow["reviewConfirmed"];
    sellerCheck: { status: string; sentAt: string; sentRev: number; at: string | null; byName: string | null; note: string | null } | null;
    publishedRev: number;
    publishedAt: string | null;
    unpublishedAt: string | null;
    canUndo: boolean;
    hasPublished: boolean;
  };
  summary: TeaserSummary;
  staleness: Array<{ label: string; published: string; now: string }>;
  engagementCounts: TeaserSummary["counts"];
  /** Quiet notes (an open question that doesn't change what the teaser shows). */
  notes: string[];
}

/** The full state for the Teaser tab and the editor. */
export async function teaserState(deal: Deal, row: TeaserRow, opts: { staleness?: boolean } = {}): Promise<TeaserStateView> {
  const r = withStaleRunFailed(row);
  const codename = await servedCodenameFor(deal);
  const terms = teaserTerms(deal, codename);
  const draft = swapCodename(r.draft, r.codenameUsed, codename);
  const checks = checkTeaserDoc(draft, terms);
  const h = draft.header;
  const headerProblem = h && !guardTeaserText([h.label, h.tagline, ...h.chips], terms).ok ? "The header names the business — reword the one-line description or a chip." : null;
  const { codenameProblem } = await import("../cim/codenames");
  const summary = await teaserSummary(deal, r);
  let staleness: TeaserStateView["staleness"] = [];
  let notes: string[] = [];
  if (opts.staleness !== false) {
    try {
      const { teaserFigures } = await import("./key-numbers");
      const { teaserStaleness } = await import("./doc-ops");
      const f = await teaserFigures(deal);
      staleness = teaserStaleness(r.published, r.templateKey, f, { numbers: r.numbers, showAskingPrice: r.showAskingPrice });
      const { storage } = await import("../storage");
      const { discrepancyGateFor } = await import("./generate");
      notes = discrepancyGateFor((await storage.getDiscrepanciesByDeal(deal.id).catch(() => [])) as never, r.numbers).notes;
    } catch (err) {
      console.warn(`[teaser] staleness failed for deal ${deal.id}:`, (err as Error)?.message);
    }
  }
  const s = r.sellerCheck;
  return {
    teaser: {
      id: r.id,
      templateKey: r.templateKey,
      templateName: await templateName(r.templateKey, deal.brokerId),
      designTemplateId: r.designTemplateId,
      pageSize: r.pageSize,
      numbers: r.numbers,
      showAskingPrice: r.showAskingPrice,
      linkLifetime: r.linkLifetime,
      autoGrant: r.autoGrant,
      draft,
      draftRev: r.draftRev,
      checks,
      headerProblem,
      codename,
      codenameProblem: codename === NO_CODENAME ? null : codenameProblem(deal as never, codename),
      generation: r.generation,
      reviewConfirmed: r.reviewConfirmed,
      sellerCheck: s ? { status: s.status, sentAt: s.sentAt, sentRev: s.sentRev, at: s.at ?? null, byName: s.byName ?? null, note: s.note ?? null } : null,
      publishedRev: r.publishedRev,
      publishedAt: r.publishedAt ? r.publishedAt.toISOString() : null,
      unpublishedAt: r.unpublishedAt ? r.unpublishedAt.toISOString() : null,
      canUndo: r.history.length > 0,
      hasPublished: !!r.published,
    },
    summary,
    staleness,
    engagementCounts: summary.counts,
    notes,
  };
}

export { TEASER_ACCESS_LEVEL };
