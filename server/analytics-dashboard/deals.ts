/**
 * The Analytics page's Deals tab: each CIM side by side (spec §6.2). Pure.
 *
 *   Opened            the KPI "opened" (all time): "13 of 13"
 *   Read · period     the KPI "reading" for one deal
 *   Time per buyer    median, over CIM links with ≥ 1 visit, of Σ visit active time
 *   How far they got  median, over CIM links with ≥ 1 visit, of pages reached, "of" the content pages
 *   NDA → Interested  NDAs signed (any level), then interested (CIM links), all time
 *   Teaser            links sent as a teaser · of those, asked for the CIM
 *   Waiting on you    the KPI "waiting" for one deal
 *   Last activity     latest visit, question, NDA, decision or CIM request
 */
import type { Deal } from "@shared/schema";
import type { DashboardRange, DealDashboardRow } from "@shared/analytics-dashboard";
import { dealPublishedForBuyers } from "@shared/buyer-publish-gate";
import { readingSummary } from "../engagement/insights";
import type { CaptureFacts } from "../engagement/facts";
import { hasPartByPart } from "./attention";
import { cimOnly, computeKpis, kpiValue } from "./kpis";
import type { AccessRow, BrokerInputs, DashboardItem } from "./load";
import { isTeaserOnly } from "./levels";

const t = (iso: string | null | undefined): number => (iso ? Date.parse(iso) || 0 : 0);

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
}

/** Content pages a buyer could open: not front matter, not locked. */
export function contentPageCount(facts: CaptureFacts): number {
  return facts.pages.filter((p) => p.role !== "front_matter" && !p.locked).length;
}

/** The first "granted" broker action's level, else the link's level now. */
function grantedLevel(a: AccessRow): string {
  return a.accessEvents.find((e) => e.type === "granted" && e.accessLevel)?.accessLevel ?? a.accessLevel;
}

const asked = (a: AccessRow) => a.accessEvents.some((e) => e.type === "cim_requested");

/** Teaser links sent on this deal (teaser-only now, or first given as a teaser) and how many asked for the CIM. */
export function teaserCounts(access: AccessRow[]): { sent: number; asked: number } | null {
  const sent = access.filter((a) => isTeaserOnly(a.accessLevel) || isTeaserOnly(grantedLevel(a)));
  if (sent.length === 0) return null;
  return { sent: sent.length, asked: sent.filter(asked).length };
}

/** The latest thing that happened on a deal (ms; 0 = nothing). */
export function dealLastActivity(item: DashboardItem | null, access: AccessRow[], questionTimes: number[]): number {
  let m = 0;
  if (item) {
    for (const b of cimOnly(item.facts).buyers) {
      for (const v of b.visits) m = Math.max(m, t(v.lastSeenAt));
      for (const q of b.questions) m = Math.max(m, t(q.askedAt));
    }
  }
  for (const a of access) {
    if (a.ndaSignedAt) m = Math.max(m, a.ndaSignedAt.getTime());
    if (a.decisionAt) m = Math.max(m, a.decisionAt.getTime());
    for (const e of a.accessEvents) if (e.type === "cim_requested") m = Math.max(m, t(e.at));
  }
  for (const q of questionTimes) m = Math.max(m, q);
  return m;
}

/** One row per deal with at least one buyer link (CIM or teaser). */
export function dealRows(inputs: BrokerInputs, range: DashboardRange, now: Date): DealDashboardRow[] {
  const rows: DealDashboardRow[] = [];
  const failed = new Set(inputs.failed.map((f) => f.dealId));
  for (const deal of inputs.deals) {
    const access = inputs.access.filter((a) => a.dealId === deal.id);
    if (access.length === 0 || failed.has(deal.id)) continue;
    const item = inputs.items.find((it) => it.deal.id === deal.id) ?? null;
    const one: BrokerInputs = {
      ...inputs,
      deals: [deal],
      items: item ? [item] : [],
      access,
      questions: inputs.questions.filter((q) => q.dealId === deal.id),
      approvals: inputs.approvals.filter((a) => a.dealId === deal.id),
      decisions: inputs.decisions.filter((d) => d.dealId === deal.id),
    };
    const all = computeKpis(one, { range: "all", now, scope: "deal" }).kpis;
    const inRange = range === "all" ? all : computeKpis(one, { range, now, scope: "deal" }).kpis;
    const facts = item ? cimOnly(item.facts) : null;
    const readers = facts ? facts.buyers.filter((b) => b.visits.length > 0) : [];
    const lastAt = dealLastActivity(item, access, one.questions.map((q) => q.askedAt.getTime()));
    rows.push({
      dealId: deal.id,
      dealName: deal.businessName,
      live: dealPublishedForBuyers(deal),
      demo: !!deal.demoKey,
      granted: facts ? facts.buyers.length : 0,
      opened: kpiValue(all, "opened"),
      readingInRange: kpiValue(inRange, "reading"),
      medianReadingMs: median(readers.map((b) => b.visits.reduce((s, v) => s + v.activeMs, 0))),
      // No pages to draw on (e.g. old reading on a CIM that can't be rebuilt): "—", never "0 of 0".
      medianPagesReached: facts && contentPageCount(facts) > 0 ? median(readers.map((b) => readingSummary(b, facts.pages).pagesReached)) : null,
      contentPages: facts ? contentPageCount(facts) : 0,
      ndaSigned: access.filter((a) => !!a.ndaSignedAt).length,
      interested: facts ? facts.buyers.filter((b) => b.decision === "interested").length : 0,
      waiting: kpiValue(all, "waiting"),
      teaser: teaserCounts(access),
      lastActivityAt: lastAt ? new Date(lastAt).toISOString() : null,
      partByPart: item ? hasPartByPart([item]) : false,
    });
  }
  return rows.sort((a, b) => t(b.lastActivityAt) - t(a.lastActivityAt) || a.dealName.localeCompare(b.dealName));
}

/** Deals with no buyer link at all (the collapsible "{n} deals have no buyers yet"). */
export function dealsWithoutBuyers(inputs: Pick<BrokerInputs, "deals" | "access">): Array<{ dealId: string; dealName: string; live: boolean; demo: boolean }> {
  const withBuyers = new Set(inputs.access.map((a) => a.dealId));
  return inputs.deals
    .filter((d: Deal) => !withBuyers.has(d.id))
    .map((d) => ({ dealId: d.id, dealName: d.businessName, live: dealPublishedForBuyers(d), demo: !!d.demoKey }))
    .sort((a, b) => a.dealName.localeCompare(b.dealName));
}
