/**
 * loadDealReadingFacts — everything known about how buyers read one deal's
 * CIM, for one filter set, as plain data (shared/analytics-v2.ts
 * DealReadingFacts). The hand-off between the CAPTURE stream (which owns
 * this file: SQL over reading_rollups / buyer_visits / analytics_events /
 * cim_renditions, with GROUP BYs — never all raw events in JS) and the
 * INTELLIGENCE stream (pure functions over the result, insights.ts).
 *
 * CONTRACT (base): the signature and the DealReadingFacts shape. The body
 * below is the base stub — buyers come from buyer_access with no reading
 * yet, so every consumer can be built and tested against real shapes.
 * Rules the implementation must keep:
 *   - self_view visits (the owning broker previewing) are excluded;
 *   - filters apply (range on visit last_seen_at, device class, buyers,
 *     segment by decision / buyer type, rendition);
 *   - pages come from the chosen rendition (default: the latest with
 *     reading for the filter), with REAL titles (broker side) and the
 *     served title when it differs (blind);
 *   - revoked access rows are still listed (their reading happened).
 */
import type { BuyerAccess, Deal } from "@shared/schema";
import {
  type BuyerReadingFacts,
  type CimMode,
  type DealReadingFacts,
  type EngagementFilters,
} from "@shared/analytics-v2";
import { cimModeForAccessLevel } from "@shared/cim-layouts";
import { storage } from "../storage";

export async function loadDealReadingFacts(
  deal: Deal,
  filters: EngagementFilters,
  now: Date = new Date(),
): Promise<DealReadingFacts> {
  const accesses = await storage.getBuyerAccessByDeal(deal.id);
  return {
    dealId: deal.id,
    dealName: deal.businessName,
    rendition: null,
    renditions: [],
    now: now.toISOString(),
    filters,
    pages: [],
    buyers: accesses
      .filter((a) => filters.buyers.length === 0 || filters.buyers.includes(a.id))
      .map((a) => buyerShell(a)),
    legacyOnly: false,
    lastWriteAt: null,
  };
}

/** A buyer with no reading recorded (the base stub; also how "Not opened yet" buyers look). */
export function buyerShell(a: BuyerAccess): BuyerReadingFacts {
  const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
  const contacted = ((a.accessEvents as Array<{ type: string; at: string }> | null) ?? [])
    .filter((e) => e.type === "contacted")
    .map((e) => e.at)
    .sort()
    .pop() ?? null;
  return {
    accessId: a.id,
    buyerUserId: a.buyerUserId ?? null,
    name: a.buyerName || a.buyerEmail,
    company: a.buyerCompany ?? null,
    email: a.buyerEmail,
    buyerType: a.buyerType ?? null,
    accessLevel: a.accessLevel,
    mode: cimModeForAccessLevel(a.accessLevel) as CimMode,
    grantedAt: iso(a.createdAt)!,
    firstViewedAt: iso(a.firstViewedAt),
    ndaSignedAt: iso(a.ndaSignedAt),
    decision: a.decision ?? "under_review",
    decisionAt: iso(a.decisionAt),
    contactedAt: contacted,
    fit: null,
    visits: [],
    pages: {},
    blocks: {},
    events: [],
    questions: [],
  };
}
