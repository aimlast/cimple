/**
 * Tenancy helpers for the engagement (reading analytics) APIs — shared by
 * every stream. Deal routes already pass requireBroker + requireOwnedDeal;
 * any buyer_access id in a URL must ALSO belong to that deal (a broker can't
 * read another deal's buyer by guessing an id). Foreign ids read as missing.
 */
import type { BuyerAccess, Deal } from "@shared/schema";
import { storage } from "../storage";

/** The buyer_access row, only when it belongs to this deal. */
export async function getDealAccess(dealId: string, accessId: string): Promise<BuyerAccess | null> {
  if (!accessId || typeof accessId !== "string") return null;
  const access = await storage.getBuyerAccess(accessId);
  return access && access.dealId === dealId ? access : null;
}

/** The broker's own, non-archived deals (global engagement pages). */
export async function ownedLiveDeals(brokerId: string): Promise<Deal[]> {
  const deals = await storage.getAllDeals(brokerId);
  return deals.filter((d) => !d.archivedAt);
}
