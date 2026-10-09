/**
 * The Analytics page's Buyers tab: everyone the broker gave a link to, on
 * every deal (spec §3.4, §6.2). Pure.
 *
 *   CIM rows      one per CIM link in the reading facts, with the SAME
 *                 status and words as the deal's buyer card (buyerInsight)
 *                 and the same reading time (Σ visit active time)
 *   teaser rows   one per teaser-only link (document "teaser"): "Has the
 *                 teaser" / "Asked for the CIM", no reading columns
 *
 * No CRM profile, private notes or deep-check text — `fitText` is the
 * stored "4 of 6 criteria" count.
 */
import type { BuyerReadingFacts } from "@shared/analytics-v2";
import { questionWaitingOn, type BuyerDashboardRow } from "@shared/analytics-dashboard";
import { dealPublishedForBuyers } from "@shared/buyer-publish-gate";
import { buyerInsight, readingSummary } from "../engagement/insights";
import { insightContext } from "../engagement/responses";
import { cimOnly } from "./kpis";
import type { AccessRow, BrokerInputs } from "./load";
import { accessLevelLabel, isTeaserOnly } from "./levels";

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

export function fitOfBuyer(b: Pick<BuyerReadingFacts, "fit">): { matched: number; total: number } | null {
  const m = b.fit?.criteriaMatched;
  const n = b.fit?.criteriaTotal;
  return typeof m === "number" && typeof n === "number" && n > 0 ? { matched: m, total: n } : null;
}

export function fitText(fit: { matched: number; total: number } | null): string | null {
  return fit ? `${fit.matched} of ${fit.total} criteria` : null;
}

export function buyerRows(inputs: BrokerInputs, now: Date): BuyerDashboardRow[] {
  void now;
  const rows: BuyerDashboardRow[] = [];
  const accessById = new Map(inputs.access.map((a) => [a.id, a]));
  const waitingByAccess = new Map<string, number>();
  for (const q of inputs.questions) {
    if (q.accessId && questionWaitingOn(q.status, q.publishedAnswer) === "broker") waitingByAccess.set(q.accessId, (waitingByAccess.get(q.accessId) ?? 0) + 1);
  }
  const dealsById = new Map(inputs.deals.map((d) => [d.id, d]));

  for (const item of inputs.items) {
    const facts = cimOnly(item.facts);
    const ctx = insightContext(facts);
    for (const b of facts.buyers) {
      const insight = buyerInsight(b, ctx);
      const sum = readingSummary(b, facts.pages);
      const fit = fitOfBuyer(b);
      const firstSeen = b.visits.map((v) => v.startedAt).sort()[0] ?? b.firstViewedAt ?? null;
      const lastSeen = b.visits.map((v) => v.lastSeenAt).sort().pop() ?? null;
      rows.push({
        accessId: b.accessId,
        dealId: item.deal.id,
        dealName: item.deal.businessName,
        demo: item.demo,
        live: item.live,
        document: "cim",
        buyerUserId: b.buyerUserId,
        name: b.name,
        company: b.company,
        email: b.email,
        buyerType: b.buyerType,
        accessLevel: b.accessLevel,
        accessLabel: accessLevelLabel(b.accessLevel),
        status: insight.status,
        statusLabel: insight.statusLabel,
        readingMs: b.visits.reduce((s, v) => s + v.activeMs, 0),
        visits: b.visits.length,
        pagesRead: sum.pagesRead,
        contentPages: sum.contentPages,
        firstSeenAt: firstSeen,
        lastSeenAt: lastSeen,
        grantedAt: b.grantedAt,
        ndaSignedAt: b.ndaSignedAt,
        decision: b.decision,
        decisionAt: b.decisionAt,
        questions: b.questions.length,
        questionsWaiting: waitingByAccess.get(b.accessId) ?? 0,
        contactedAt: b.contactedAt,
        expiresAt: b.expiresAt ?? iso(accessById.get(b.accessId)?.expiresAt),
        revokedAt: b.revokedAt ?? iso(accessById.get(b.accessId)?.revokedAt),
        fit,
        fitText: fitText(fit),
      });
    }
  }

  for (const a of inputs.access) {
    if (!isTeaserOnly(a.accessLevel)) continue;
    const deal = dealsById.get(a.dealId);
    if (!deal) continue;
    rows.push(teaserRow(a, deal.businessName, !!deal.demoKey, dealPublishedForBuyers(deal), waitingByAccess.get(a.id) ?? 0));
  }
  return rows;
}

function teaserRow(a: AccessRow, dealName: string, demo: boolean, live: boolean, waiting: number): BuyerDashboardRow {
  const askedForCim = a.accessEvents.some((e) => e.type === "cim_requested");
  return {
    accessId: a.id,
    dealId: a.dealId,
    dealName,
    demo,
    live,
    document: "teaser",
    buyerUserId: a.buyerUserId,
    name: a.buyerName || a.buyerEmail,
    company: a.buyerCompany,
    email: a.buyerEmail,
    buyerType: a.buyerType,
    accessLevel: a.accessLevel,
    accessLabel: accessLevelLabel(a.accessLevel),
    status: askedForCim ? "teaser_asked" : "teaser",
    statusLabel: askedForCim ? "Asked for the CIM" : "Has the teaser",
    readingMs: null,
    visits: null,
    pagesRead: null,
    contentPages: null,
    firstSeenAt: iso(a.firstViewedAt),
    lastSeenAt: null,
    grantedAt: a.createdAt.toISOString(),
    ndaSignedAt: iso(a.ndaSignedAt),
    decision: a.decision ?? "under_review",
    decisionAt: iso(a.decisionAt),
    questions: 0,
    questionsWaiting: waiting,
    contactedAt: a.accessEvents.filter((e) => e.type === "contacted").map((e) => e.at).sort().pop() ?? null,
    expiresAt: iso(a.expiresAt),
    revokedAt: iso(a.revokedAt),
    fit: null,
    fitText: null,
  };
}
