/**
 * Per-broker view of a buyer's provenance.
 *
 * buyer_users is ONE global row shared by every brokerage, and its
 * field_sources stamps are written by whoever acted on it: the buyer, an NDA
 * signed on some brokerage's deal, a broker's manual add / CSV / CRM sync, an
 * approval. A broker must only ever see the stamps that are theirs (or the
 * buyer's own edits). Anything else is shown neutrally as "other" — no deal
 * id, no brokerage, never "you…" wording — so one brokerage never learns
 * another's deal ids or when it touched the buyer, and is never told it did
 * something it didn't.
 */
import { db } from "../db";
import { eq } from "drizzle-orm";
import {
  deals, legacyOwnSource,
  type BrokerBuyerContact, type BuyerFieldSource, type BuyerFieldSources, type BuyerUser,
} from "@shared/schema";

export interface BrokerScope {
  brokerId: string;
  /** Every deal this broker owns. */
  dealIds: ReadonlySet<string>;
}

export async function loadBrokerScope(brokerId: string): Promise<BrokerScope> {
  const rows = await db.select({ id: deals.id }).from(deals).where(eq(deals.brokerId, brokerId));
  return { brokerId, dealIds: new Set(rows.map((r) => r.id)) };
}

/** A neutral stamp: someone else wrote this value on the buyer's global profile. */
export interface NeutralFieldSource { source: "other"; at: string }
export type ScopedFieldSource = BuyerFieldSource | NeutralFieldSource;
export type ScopedFieldSources = Record<string, ScopedFieldSource>;

const CONTACT_SOURCE_FOR: Record<string, string> = { broker_import: "manual", csv: "csv", crm: "crm" };
const WINDOW_MS = 2 * 60_000;
const near = (a: string | Date | null | undefined, b: string | Date | null | undefined) =>
  !!a && !!b && Math.abs(new Date(a).getTime() - new Date(b).getTime()) < WINDOW_MS;

/**
 * Was this stamp written by the broker in `scope` (or by the buyer)?
 * Stamps from before brokerId was recorded are attributed only when they line
 * up with this broker's own add of the buyer (same kind, within two minutes).
 */
export function stampBelongsToBroker(
  s: BuyerFieldSource,
  scope: BrokerScope,
  buyer: Pick<BuyerUser, "invitedByBroker" | "createdAt">,
  contact: Pick<BrokerBuyerContact, "source" | "addedAt"> | null | undefined,
): boolean {
  switch (s.source) {
    case "buyer":
      return true; // the buyer's own words on their own profile
    case "nda":
    case "approval":
      return !!s.dealId && scope.dealIds.has(s.dealId);
    case "broker_import":
    case "csv":
    case "crm":
      if (s.brokerId) return s.brokerId === scope.brokerId;
      if (contact && contact.source === CONTACT_SOURCE_FOR[s.source] && near(s.at, contact.addedAt)) return true;
      return buyer.invitedByBroker === scope.brokerId && near(s.at, buyer.createdAt);
    default:
      return false;
  }
}

/** The buyer's field_sources as this broker may see them. Keys are never dropped (presence matters to the merge). */
export function scopeFieldSources(
  buyer: Pick<BuyerUser, "fieldSources" | "invitedByBroker" | "createdAt">,
  contact: Pick<BrokerBuyerContact, "source" | "addedAt"> | null | undefined,
  scope: BrokerScope,
): ScopedFieldSources {
  const out: ScopedFieldSources = {};
  for (const [k, s] of Object.entries((buyer.fieldSources as BuyerFieldSources | null) ?? {})) {
    if (!s || typeof s !== "object") continue;
    out[k] = stampBelongsToBroker(s, scope, buyer, contact)
      ? { source: s.source, at: s.at, ...(s.dealId ? { dealId: s.dealId } : {}) } // brokerId is internal
      : { source: "other", at: s.at };
  }
  return out;
}

/**
 * Best guess for a value written before per-field sources existed, from how
 * the account started — but only if that start was this broker's doing.
 */
export function legacySourceForBroker(
  buyer: Pick<BuyerUser, "source" | "invitedByBroker" | "invitedByDeal">,
  scope: BrokerScope,
): BuyerFieldSource["source"] | "other" {
  const guess = legacyOwnSource(buyer);
  if (guess === "buyer") return "buyer";
  if (guess === "nda") return buyer.invitedByDeal && scope.dealIds.has(buyer.invitedByDeal) ? "nda" : "other";
  return buyer.invitedByBroker === scope.brokerId ? guess : "other";
}

/** How the account started, as this broker may see it ("other" when another brokerage created it). */
export function accountSourceForBroker(
  buyer: Pick<BuyerUser, "source" | "invitedByBroker" | "invitedByDeal">,
  scope: BrokerScope,
): string | null {
  switch (buyer.source) {
    case "self_signup":
    case null:
    case undefined:
      return buyer.source ?? null;
    case "nda_signed":
      return buyer.invitedByDeal && scope.dealIds.has(buyer.invitedByDeal) ? buyer.source : "other";
    default:
      return buyer.invitedByBroker === scope.brokerId ? buyer.source : "other";
  }
}
