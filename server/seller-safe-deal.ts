/**
 * The deal as the SELLER may see it (invite link / intake save responses).
 *
 * The seller's browser used to receive the whole deals row — including the
 * broker's private material: extractedInfo (with facts from CRM notes and
 * private emails, and _brokerPrivateNotes), the seller communication
 * profile, the CRM link, the broker's deal notes, the notetaker bot's
 * webhook secret and the call's owner token. Only what the seller pages
 * actually use goes out now (SellerLayout, SellerIntake, SellerInterview,
 * SellerDocuments read id, businessName, location, questionnaireData,
 * operationalSystems, employeeChart, interviewCompleted).
 */
import type { Deal } from "@shared/schema";

const SELLER_VISIBLE_KEYS = [
  "id",
  "businessName",
  "industry",
  "subIndustry",
  "location",
  "websiteUrl",
  "phase",
  "status",
  "questionnaireData",
  "operationalSystems",
  "employeeChart",
  "sqCompleted",
  "interviewCompleted",
  "ndaSigned",
  "contentApprovedBySeller",
  "designApprovedBySeller",
  "createdAt",
  "updatedAt",
] as const satisfies readonly (keyof Deal)[];

export type SellerSafeDeal = Pick<Deal, (typeof SELLER_VISIBLE_KEYS)[number]>;

export function sellerSafeDeal(deal: Deal): SellerSafeDeal {
  const out: Record<string, unknown> = {};
  for (const key of SELLER_VISIBLE_KEYS) out[key] = deal[key];
  return out as SellerSafeDeal;
}
