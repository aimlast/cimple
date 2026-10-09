/**
 * Inputs → the analytics dashboards' API responses (shared/analytics-dashboard.ts).
 * Pure: the routes load (load.ts, reading-now.ts, the extra sources) and
 * call these; tests call them directly.
 */
import type { CallListEntry } from "@shared/analytics-v2";
import {
  forTextOf,
  hasReadCim,
  isSampleVisit,
  parseRangeRequest,
  resolveRange,
  type ActivityResponse,
  type AnalyticsBuyersResponse,
  type AnalyticsDealsResponse,
  type AnalyticsOverviewResponse,
  type AttentionResponse,
  type DealKpisResponse,
  type HeadsUp,
  type PartialLoad,
  type RangeRequest,
} from "@shared/analytics-dashboard";
import { dealPublishedForBuyers } from "@shared/buyer-publish-gate";
import { buildSummaryResponse, pageRefOf } from "../engagement/responses";
import { buildCallList } from "../routes/engagement-insights";
import { activityItems, pageItems, type ActivityOptions } from "./activity";
import { attentionBasis, hasPartByPart, kindAttention, layoutAttention, roleAttention } from "./attention";
import { buyerRows } from "./buyers";
import { dealRows, dealsWithoutBuyers } from "./deals";
import { activeVisits, buyerGroups, cimOnly, computeKpis, headsUp, kpiValue, lastActivity } from "./kpis";
import type { BrokerInputs, DealInputs } from "./load";
import { readingNowResponseRows, type ReadingNowDbRow } from "./reading-now";
import { seesCim } from "./levels";

const DAY = 86_400_000;
const t = (iso: string | null | undefined): number => (iso ? Date.parse(iso) || 0 : 0);

export function partialOf(inputs: Pick<BrokerInputs, "failed">): PartialLoad | null {
  return inputs.failed.length ? { failedDeals: inputs.failed.map((f) => ({ ...f })) } : null;
}

/** The period to show for a request ("auto" resolves on the counted deals' last activity). */
export function resolveRangeFor(inputs: BrokerInputs, req: RangeRequest | unknown, now: Date) {
  const last = lastActivity(inputs);
  return { ...resolveRange(parseRangeRequest(req), last?.at ?? null, now), last };
}

export function overviewResponse(inputs: BrokerInputs, rangeReq: unknown, now: Date, extraHeadsUp: HeadsUp[] = []): AnalyticsOverviewResponse {
  const { range, auto, last } = resolveRangeFor(inputs, rangeReq, now);
  const { kpis } = computeKpis(inputs, { range, now, scope: "broker" });
  const cim = inputs.items.flatMap((it) => cimOnly(it.facts).buyers);
  const dealsWithBuyers = new Set(inputs.access.map((a) => a.dealId)).size;
  return {
    range,
    rangeAuto: auto,
    now: now.toISOString(),
    examples: { ...inputs.examples },
    kpis,
    headsUp: headsUp(inputs, now, extraHeadsUp),
    counts: {
      deals: inputs.ownDeals,
      dealsWithBuyers,
      buyers: inputs.access.length,
      call: kpiValue(kpis, "to_call"),
      notOpened: cim.filter((b) => !b.revokedAt && b.visits.length === 0 && !b.firstViewedAt).length,
      teaserOnly: inputs.access.filter((a) => !seesCim(a.accessLevel)).length,
    },
    lastActivity: last ? { at: last.at.toISOString(), text: last.text, dealId: last.dealId } : null,
    demoDealIds: inputs.deals.filter((d) => !!d.demoKey).map((d) => d.id),
    partial: partialOf(inputs),
  };
}

/** The global "Who to call": the same items as the KPI strip, so the list and "Worth a call" agree. */
export function callListResponse(inputs: BrokerInputs, size = 15): { entries: CallListEntry[] } {
  return { entries: buildCallList(inputs.items.map((it) => ({ deal: it.deal, facts: cimOnly(it.facts) })), size) };
}

export function dealsResponse(inputs: BrokerInputs, rangeReq: unknown, now: Date): AnalyticsDealsResponse {
  const { range, auto } = resolveRangeFor(inputs, rangeReq, now);
  return { range, rangeAuto: auto, rows: dealRows(inputs, range, now), withoutBuyers: dealsWithoutBuyers(inputs), partial: partialOf(inputs) };
}

export function buyersResponse(inputs: BrokerInputs, now: Date): AnalyticsBuyersResponse {
  return { rows: buyerRows(inputs, now), partial: partialOf(inputs) };
}

export function attentionResponse(inputs: BrokerInputs, benchmarks: AttentionResponse["benchmarks"] = []): AttentionResponse {
  return {
    partByPart: hasPartByPart(inputs.items),
    byRole: roleAttention(inputs.items),
    byKind: kindAttention(inputs.items),
    byLayout: layoutAttention(inputs.items),
    benchmarks,
    basis: attentionBasis(inputs.items),
  };
}

export function activityResponse(
  inputs: BrokerInputs,
  opts: Omit<ActivityOptions, "range"> & { range: unknown; cursor?: string | null; limit?: number },
): ActivityResponse {
  const { range, last } = resolveRangeFor(inputs, opts.range, opts.now);
  const all = activityItems(inputs, inputs.decisions, { ...opts, range });
  const page = pageItems(all, opts.cursor ?? null, opts.limit);
  return {
    items: page.items,
    next: page.next,
    total: all.length,
    lastActivity: last ? { at: last.at.toISOString(), text: last.text } : null,
    partial: partialOf(inputs),
  };
}

// ── The deal Engagement tab and the pulse ─────────────────────────────────

export function dealKpisResponse(inputs: DealInputs, readingNow: ReadingNowDbRow[], now: Date): DealKpisResponse {
  const item = inputs.items[0];
  const deal = inputs.deals[0];
  const facts = cimOnly(item.facts);
  const range = inputs.filters.range;
  const { kpis } = computeKpis(inputs, { range, now, scope: "deal", filters: inputs.filters });
  const callTop = buildCallList([{ deal, facts }], 3);
  const groups = buyerGroups(inputs.groupFacts, item.facts);
  // Every listed link (teaser readers too: the shell says "reading the teaser"; no page for them).
  const listed = new Set(item.facts.buyers.map((b) => b.accessId));
  const rows = readingNowResponseRows(readingNow.filter((r) => r.dealId === deal.id && listed.has(r.accessId)), () => deal.businessName).map((r) => {
    const b = facts.buyers.find((x) => x.accessId === r.accessId);
    const latest = b ? [...b.visits].sort((x, y) => t(y.lastSeenAt) - t(x.lastSeenAt))[0] : undefined;
    const at = latest?.path.length ? latest.path[latest.path.length - 1][1] : null;
    const ref = at ? pageRefOf(facts, at) : null;
    return { ...r, page: ref ? { label: ref.label, title: ref.title } : null };
  });
  const nowMs = now.getTime();
  const lastRead = (b: (typeof facts.buyers)[number]) => activeVisits(b).reduce((m, v) => Math.max(m, t(v.lastSeenAt)), 0);
  const lastReadAt = facts.buyers.reduce((m, b) => Math.max(m, lastRead(b)), 0);
  const published = dealPublishedForBuyers(deal);
  return {
    published,
    kpis,
    callTop,
    groups,
    readingNow: rows,
    readersAll: facts.buyers.filter(hasReadCim).length,
    readersWeek: facts.buyers.filter((b) => { const l = lastRead(b); return l > 0 && nowMs - l <= 7 * DAY; }).length,
    lastReadAt: lastReadAt ? new Date(lastReadAt).toISOString() : null,
    grantedCim: facts.buyers.length,
    mostStudiedPage: buildSummaryResponse(facts, published, deal.businessName).mostStudiedPage,
    renditions: item.facts.renditions,
    legacyOnly: item.facts.legacyOnly,
    sampleReading: facts.buyers.some((b) => b.visits.some(isSampleVisit)),
    forText: forTextOf(inputs.filters),
  };
}
