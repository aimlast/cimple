/**
 * Deal list: slim list, sort/group/filter data, archive/unarchive (workstream: deal-list).
 * Registered from server/routes.ts (merge anchor) — keep this workstream's
 * new endpoints in this file.
 *
 * GET /api/deals/list returns one slim row per deal (no large JSON columns)
 * with everything the broker's deal list sorts, groups and filters by:
 * phase, whose move it is (shared/deal-progress), readiness, money, counts
 * and a DERIVED last-activity time. `deals.updatedAt` is deliberately not
 * used for "recent" — background jobs (CIM generation progress, interview
 * plan, section importance, deep check…) bump it constantly.
 */
import type { Express } from "express";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import {
  deals,
  documents,
  buyerAccess,
  cimSections,
  discrepancies,
  interviewSessions,
  sellerInvites,
  type Deal,
} from "@shared/schema";
import { computeCimReadiness, type CimReadiness } from "@shared/cim-readiness";
import {
  computeNextStep,
  phaseLabel,
  type DealProgressExtras,
  type DealProgressInput,
  type NextStep,
} from "@shared/deal-progress";
import { requireBroker, requireOwnedDeal } from "../broker-auth/routes.js";
import { buildSectionCoverage } from "../interview/knowledge-base";
import { getSectionImportance } from "../interview/section-importance.js";
import { getInterviewOutline } from "../interview/outline.js";
import { coverageAdjustmentsForDeal } from "../interview/interview-plan.js";
import { typedNumericValues } from "../interview/info-merger";
import { getLiveCimGenerationStatus } from "../cim/generation-jobs";
import { effectiveAskingPrice } from "../information/deal-mirror";

/* ─── Types ─────────────────────────────────────────────────────────── */

export interface DealListRow {
  id: string;
  businessName: string;
  industry: string;
  subIndustry: string | null;
  region: string | null;
  phase: string;
  phaseLabel: string;
  isLive: boolean;
  archivedAt: string | null;
  createdAt: string;
  lastActivityAt: string;
  askingPrice: string | null;
  askingPriceValue: number | null;
  annualRevenue: number | null;
  sde: number | null;
  readiness: { score: number; label: CimReadiness["label"] } | null;
  nextStep: NextStep;
  counts: { documents: number; buyersWithAccess: number; buyerViews: number; openDiscrepancies: number };
  sellerName: string | null;
  blindCodename: string | null;
}

/** Per-deal facts that live outside the deals row, loaded in grouped queries. */
export interface DealSideFacts {
  extras: DealProgressExtras;
  lastActivityMs: number;
  documents: number;
  buyerViews: number;
  openDiscrepancies: number;
  sellerName: string | null;
  confidence?: Record<string, string>;
}

/* ─── Helpers ───────────────────────────────────────────────────────── */

/**
 * Epoch ms from a Date or a driver string. Aggregates over `timestamp`
 * (without time zone) columns come back as bare "2026-09-25 03:02:24"
 * strings holding UTC wall time — read them as UTC, the way drizzle maps
 * typed timestamp columns, or they shift by the server's offset.
 */
const toMs = (v: unknown): number => {
  if (!v) return 0;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : 0;
  const s = String(v).trim();
  const hasZone = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(s);
  const t = new Date(hasZone ? s : `${s.replace(" ", "T")}Z`).getTime();
  return Number.isFinite(t) ? t : 0;
};
const toNum = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** First currency amount in a free-text money value ("$2.4M", "about 850k"). */
export function moneyValue(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? raw : null;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const n = typedNumericValues(raw).find((t) => t.kind === "currency")?.value;
  return n && n > 0 ? n : null;
}

/** Latest year's value from a { "2023": "$1.8M", ... } map. */
function latestYearValue(map: unknown): number | null {
  if (!map || typeof map !== "object" || Array.isArray(map)) return null;
  const years = Object.keys(map as Record<string, unknown>)
    .filter((k) => /^\d{4}/.test(k))
    .sort()
    .reverse();
  for (const y of years) {
    const v = moneyValue((map as Record<string, unknown>)[y]);
    if (v) return v;
  }
  return null;
}

const PROVINCES: Record<string, string> = {
  ON: "Ontario", QC: "Quebec", BC: "British Columbia", AB: "Alberta", MB: "Manitoba",
  SK: "Saskatchewan", NS: "Nova Scotia", NB: "New Brunswick", NL: "Newfoundland and Labrador",
  PE: "Prince Edward Island", YT: "Yukon", NT: "Northwest Territories", NU: "Nunavut",
};
const STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado",
  CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho",
  IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada",
  NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina",
  ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas",
  UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia",
  WI: "Wisconsin", WY: "Wyoming", DC: "District of Columbia",
};
const REGION_NAMES = [...Object.values(PROVINCES), "Newfoundland", ...Object.values(STATES)]
  .sort((a, b) => b.length - a.length); // "West Virginia" before "Virginia"
const REGION_NAME_RE = new RegExp(`\\b(${REGION_NAMES.join("|")})\\b`, "i");

/**
 * Province / state from free-text locations ("Kitchener, ON", "Austin, Texas").
 * Two-letter codes are only trusted after a comma or on their own, so "IN"
 * or "OR" inside a sentence never reads as a state.
 */
export function regionFrom(...candidates: unknown[]): string | null {
  for (const c of candidates) {
    const text =
      typeof c === "string" ? c
      : c && typeof c === "object" ? Object.values(c as Record<string, unknown>).filter((v) => typeof v === "string").join(", ")
      : "";
    if (!text.trim()) continue;
    const named = REGION_NAME_RE.exec(text);
    if (named) {
      const hit = REGION_NAMES.find((n) => n.toLowerCase() === named[1].toLowerCase()) ?? named[1];
      return hit === "Newfoundland" ? PROVINCES.NL : hit;
    }
    const code = /(?:^|,)\s*([A-Z]{2})\b(?:\s+[A-Z]\d[A-Z]|\s+\d{5})?\s*(?:,|$)/.exec(text.trim());
    if (code) {
      const full = PROVINCES[code[1]] ?? STATES[code[1]];
      if (full) return full;
    }
  }
  return null;
}

/* ─── Grouped side-fact loading (shared with the dashboard) ─────────── */

/**
 * Everything outside the deals row the list and dashboard need, for many
 * deals at once: a handful of grouped queries over the given ids, never one
 * query per deal. Callers must pass only ids the session broker owns.
 */
export async function loadDealSideFacts(
  dealRows: Array<Pick<Deal, "id" | "createdAt">>,
  opts: { confidence?: boolean } = {},
): Promise<Map<string, DealSideFacts>> {
  const out = new Map<string, DealSideFacts>();
  if (dealRows.length === 0) return out;
  const ids = dealRows.map((d) => d.id);

  const [sessionRows, docRows, buyerRows, sectionRows, discRows, inviteRows] = await Promise.all([
    // Latest session per deal: its activity time and (optionally) the
    // interview's confidence levels, which the readiness score uses.
    db
      .selectDistinctOn([interviewSessions.dealId], {
        dealId: interviewSessions.dealId,
        lastActivityAt: interviewSessions.lastActivityAt,
        confidence: opts.confidence
          ? sql<Record<string, string> | null>`${interviewSessions.extractedInfo} -> '_confidenceLevels'`
          : sql<null>`null`,
      })
      .from(interviewSessions)
      .where(inArray(interviewSessions.dealId, ids))
      .orderBy(interviewSessions.dealId, desc(interviewSessions.lastActivityAt)),
    db
      .select({
        dealId: documents.dealId,
        count: sql<number>`count(*)::int`,
        latest: sql<string | null>`max(${documents.createdAt})`,
      })
      .from(documents)
      .where(inArray(documents.dealId, ids))
      .groupBy(documents.dealId),
    db
      .select({
        dealId: buyerAccess.dealId,
        active: sql<number>`count(*) filter (where ${buyerAccess.revokedAt} is null and (${buyerAccess.expiresAt} is null or ${buyerAccess.expiresAt} > now()))::int`,
        viewing: sql<number>`count(*) filter (where ${buyerAccess.revokedAt} is null and ${buyerAccess.firstViewedAt} is not null and coalesce(${buyerAccess.decision}, 'under_review') = 'under_review' and (${buyerAccess.expiresAt} is null or ${buyerAccess.expiresAt} > now()))::int`,
        views: sql<number>`coalesce(sum(${buyerAccess.viewCount}), 0)::int`,
        latest: sql<string | null>`max(greatest(${buyerAccess.createdAt}, coalesce(${buyerAccess.lastAccessedAt}, ${buyerAccess.createdAt})))`,
      })
      .from(buyerAccess)
      .where(inArray(buyerAccess.dealId, ids))
      .groupBy(buyerAccess.dealId),
    db
      .select({
        dealId: cimSections.dealId,
        count: sql<number>`count(*)::int`,
        latest: sql<string | null>`max(${cimSections.updatedAt})`,
      })
      .from(cimSections)
      .where(inArray(cimSections.dealId, ids))
      .groupBy(cimSections.dealId),
    db
      .select({
        dealId: discrepancies.dealId,
        open: sql<number>`count(*)::int`,
        critical: sql<number>`count(*) filter (where ${discrepancies.severity} = 'critical')::int`,
      })
      .from(discrepancies)
      // Same statuses that gate generation/approvals/publish in routes.ts.
      .where(and(inArray(discrepancies.dealId, ids), inArray(discrepancies.status, ["open", "seller_responded"])))
      .groupBy(discrepancies.dealId),
    db
      .selectDistinctOn([sellerInvites.dealId], {
        dealId: sellerInvites.dealId,
        sellerName: sellerInvites.sellerName,
        sellerEmail: sellerInvites.sellerEmail,
        createdAt: sellerInvites.createdAt,
        acceptedAt: sellerInvites.acceptedAt,
      })
      .from(sellerInvites)
      .where(inArray(sellerInvites.dealId, ids))
      .orderBy(sellerInvites.dealId, desc(sellerInvites.createdAt)),
  ]);

  const byDeal = <T extends { dealId: string }>(rows: T[]) => new Map(rows.map((r) => [r.dealId, r]));
  const sessions = byDeal(sessionRows);
  const docs = byDeal(docRows);
  const buyers = byDeal(buyerRows);
  const sections = byDeal(sectionRows);
  const discs = byDeal(discRows);
  const invites = byDeal(inviteRows);

  for (const d of dealRows) {
    const s = sessions.get(d.id);
    const doc = docs.get(d.id);
    const b = buyers.get(d.id);
    const sec = sections.get(d.id);
    const disc = discs.get(d.id);
    const inv = invites.get(d.id);
    const lastActivityMs = Math.max(
      toMs(d.createdAt),
      toMs(s?.lastActivityAt),
      toMs(doc?.latest),
      toMs(b?.latest),
      toMs(sec?.latest),
      toMs(inv?.createdAt),
      toMs(inv?.acceptedAt),
    );
    const sellerName = inv?.sellerName?.trim() || null;
    out.set(d.id, {
      extras: {
        invited: !!inv,
        interviewStarted: !!s,
        hasCimSections: toNum(sec?.count) > 0,
        cimGenerating: getLiveCimGenerationStatus(d.id)?.status === "running",
        openCriticalDiscrepancies: toNum(disc?.critical),
        buyersWithAccess: toNum(b?.active),
        buyersViewing: toNum(b?.viewing),
      },
      lastActivityMs,
      documents: toNum(doc?.count),
      buyerViews: toNum(b?.views),
      openDiscrepancies: toNum(disc?.open),
      sellerName,
      confidence: (s?.confidence as Record<string, string> | null | undefined) ?? undefined,
    });
  }
  return out;
}

/* ─── Slim deal rows ────────────────────────────────────────────────── */

/**
 * Only the columns the list needs. The big JSON columns that only matter
 * for "is it there?" come back as booleans; extractedInfo + the small
 * importance/outline/plan JSON feed readiness and money server-side and
 * are never sent to the browser.
 */
const slimColumns = {
  id: deals.id,
  brokerId: deals.brokerId,
  businessName: deals.businessName,
  industry: deals.industry,
  subIndustry: deals.subIndustry,
  location: deals.location,
  phase: deals.phase,
  isLive: deals.isLive,
  archivedAt: deals.archivedAt,
  createdAt: deals.createdAt,
  askingPrice: deals.askingPrice,
  blindCodename: deals.blindCodename,
  ndaSigned: deals.ndaSigned,
  ndaSentAt: deals.ndaSentAt,
  sqCompleted: deals.sqCompleted,
  valuationCompleted: deals.valuationCompleted,
  interviewCompleted: deals.interviewCompleted,
  contentApprovedByBroker: deals.contentApprovedByBroker,
  contentApprovedBySeller: deals.contentApprovedBySeller,
  designApprovedByBroker: deals.designApprovedByBroker,
  designApprovedBySeller: deals.designApprovedBySeller,
  cimLayoutGeneratedAt: deals.cimLayoutGeneratedAt,
  scrapedAt: deals.scrapedAt,
  questionnaireData: sql<boolean>`(${deals.questionnaireData} is not null)`,
  cimContent: sql<boolean>`(${deals.cimContent} is not null)`,
  cimDesignData: sql<boolean>`(${deals.cimDesignData} is not null)`,
  extractedInfo: deals.extractedInfo,
  sectionImportance: deals.sectionImportance,
  interviewOutline: deals.interviewOutline,
  interviewPlan: deals.interviewPlan,
};
type SlimDeal = Awaited<ReturnType<typeof selectSlimDeals>>[number];

function selectSlimDeals(brokerId: string, includeArchived: boolean) {
  return db
    .select(slimColumns)
    .from(deals)
    .where(includeArchived ? eq(deals.brokerId, brokerId) : and(eq(deals.brokerId, brokerId), isNull(deals.archivedAt)))
    .orderBy(desc(deals.createdAt));
}

function readinessFor(d: SlimDeal, confidence?: Record<string, string>): DealListRow["readiness"] {
  try {
    const sections = buildSectionCoverage(
      (d.extractedInfo || {}) as any,
      confidence,
      getSectionImportance(d as any),
      getInterviewOutline(d as any).excludedSections,
      coverageAdjustmentsForDeal(d as any),
    );
    const r = computeCimReadiness(sections);
    return { score: r.score, label: r.label };
  } catch (err) {
    console.warn(`[deal-list] readiness failed for ${d.id}:`, err);
    return null;
  }
}

/**
 * Next step for the dashboard's "your move" list — the same rule as the
 * list rows, including the readiness-aware "can the CIM be written yet?"
 * gate (the score is only needed for a phase-3 deal without an interview).
 */
export function dealNextStep(
  d: DealProgressInput & Pick<SlimDeal, "extractedInfo" | "sectionImportance" | "interviewOutline" | "interviewPlan">,
  facts: DealSideFacts | undefined,
) {
  const needsScore = d.phase === "phase3_content_creation" && !d.interviewCompleted;
  const readinessScore = needsScore ? readinessFor(d as unknown as SlimDeal, facts?.confidence)?.score ?? null : null;
  return computeNextStep(d, { ...(facts?.extras ?? {}), readinessScore });
}

function toListRow(d: SlimDeal, facts: DealSideFacts | undefined): DealListRow {
  const info = (d.extractedInfo || {}) as Record<string, unknown>;
  const extras = facts?.extras ?? {};
  // One value with the Information tab (see information/deal-mirror.ts).
  const askingText = effectiveAskingPrice({ askingPrice: d.askingPrice, extractedInfo: info });
  const readiness = readinessFor(d, facts?.confidence);
  return {
    id: d.id,
    businessName: d.businessName,
    industry: d.industry,
    subIndustry: d.subIndustry ?? null,
    region: regionFrom(
      d.location,
      ...["locationSite", "location", "locations", "province", "state", "region", "city",
          "businessAddress", "address", "headquarters", "leaseAddress"].map((k) => info[k]),
    ),
    phase: d.phase,
    phaseLabel: phaseLabel(d.phase),
    isLive: !!d.isLive,
    archivedAt: d.archivedAt ? new Date(d.archivedAt).toISOString() : null,
    createdAt: new Date(d.createdAt).toISOString(),
    lastActivityAt: new Date(facts?.lastActivityMs || toMs(d.createdAt)).toISOString(),
    askingPrice: askingText,
    askingPriceValue: moneyValue(askingText),
    annualRevenue: moneyValue(info.annualRevenue) ?? latestYearValue(info.revenueByYear),
    sde: moneyValue(info.sde),
    readiness,
    // The readiness score decides "can the CIM be written yet?" when the
    // interview isn't complete — the same rule as every Generate button.
    nextStep: computeNextStep(d as unknown as DealProgressInput, { ...extras, readinessScore: readiness?.score ?? null }),
    counts: {
      documents: facts?.documents ?? 0,
      buyersWithAccess: extras.buyersWithAccess ?? 0,
      buyerViews: facts?.buyerViews ?? 0,
      openDiscrepancies: facts?.openDiscrepancies ?? 0,
    },
    sellerName: facts?.sellerName ?? null,
    blindCodename: d.blindCodename ?? null,
  };
}

/* ─── Routes ────────────────────────────────────────────────────────── */

export function registerDealListRoutes(app: Express): void {
  // Slim list for the broker's deal list. Archived deals only with ?includeArchived=1.
  app.get("/api/deals/list", requireBroker, async (req, res) => {
    try {
      const brokerId = req.session.brokerId!;
      const includeArchived = req.query.includeArchived === "1" || req.query.includeArchived === "true";
      const rows = await selectSlimDeals(brokerId, includeArchived);
      const facts = await loadDealSideFacts(rows, { confidence: true });
      const list = rows
        .map((d) => toListRow(d, facts.get(d.id)))
        .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
      res.json(list);
    } catch (error: any) {
      console.error("Error building deal list:", error);
      res.status(500).json({ error: "Couldn't load your deals" });
    }
  });

  // Archive: hides the deal from the list, dashboard and pickers. Nothing is
  // deleted — buyer links, the CIM and every document keep working.
  app.post("/api/deals/:dealId/archive", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const deal = res.locals.deal as Deal;
      const archivedAt = deal.archivedAt ?? new Date();
      // Direct update (not storage.updateDeal) so archiving doesn't count as
      // deal activity via updatedAt.
      await db.update(deals).set({ archivedAt }).where(eq(deals.id, deal.id));
      res.json({ id: deal.id, archivedAt: new Date(archivedAt).toISOString(), isLive: !!deal.isLive });
    } catch (error: any) {
      console.error("Error archiving deal:", error);
      res.status(500).json({ error: "Couldn't archive the deal" });
    }
  });

  app.post("/api/deals/:dealId/unarchive", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const deal = res.locals.deal as Deal;
      await db.update(deals).set({ archivedAt: null }).where(eq(deals.id, deal.id));
      res.json({ id: deal.id, archivedAt: null });
    } catch (error: any) {
      console.error("Error restoring deal:", error);
      res.status(500).json({ error: "Couldn't restore the deal" });
    }
  });
}
