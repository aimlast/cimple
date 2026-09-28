/**
 * The buyer NDA as one buyer sees it (shared/buyer-nda.ts holds the terms
 * and the rules): the brokerage's terms — per-deal override, brokerage
 * default, or the standard terms — filled in with the brokerage's name and
 * the deal named the way this buyer may see it (codename on the Blind CIM).
 *
 * `hash` identifies the exact text: the view room sends it back at signing
 * and the server refuses a signature against text the buyer was not shown.
 */
import crypto from "crypto";
import { storage } from "../storage";
import { brokerageBrand } from "../cim/templates";
import { buyerFacingDealName } from "../reminders/decision-reminders";
import { buyerNdaTemplateFor, renderBuyerNdaTerms, type BuyerNdaTermsSource } from "@shared/buyer-nda";
import type { BuyerAccess, Deal } from "@shared/schema";

export interface BuyerNdaForBuyer {
  text: string;
  hash: string;
  source: BuyerNdaTermsSource;
}

export function hashNdaText(text: string): string {
  return `sha256:${crypto.createHash("sha256").update(text, "utf8").digest("hex")}`;
}

export async function buyerNdaFor(
  deal: Pick<Deal, "id" | "brokerId" | "businessName"> & { blindCodename?: string | null },
  access: Pick<BuyerAccess, "accessLevel">,
): Promise<BuyerNdaForBuyer> {
  const [user, brand] = await Promise.all([
    deal.brokerId ? storage.getUser(deal.brokerId).catch(() => undefined) : Promise.resolve(undefined),
    brokerageBrand(deal.brokerId).catch(() => null),
  ]);
  const { template, source } = buyerNdaTemplateFor((user?.settings as Record<string, unknown> | null) ?? null, deal.id);
  const text = renderBuyerNdaTerms(template, {
    firm: brand?.firmName ?? user?.name ?? null,
    opportunity: buyerFacingDealName(deal, access).name,
  });
  return { text, hash: hashNdaText(text), source };
}

/** The signature record kept on buyer_access.ndaProfile.signature. */
export interface BuyerNdaSignature {
  signerName: string;
  signedAt: string;
  ip: string | null;
  termsHash: string;
  termsText: string;
  termsSource: BuyerNdaTermsSource;
}

/** A plain-text copy of a signed NDA for the buyer to keep. */
export function signedNdaCopy(sig: BuyerNdaSignature, buyerEmail: string): string {
  const when = new Date(sig.signedAt);
  const stamp = isNaN(when.getTime()) ? sig.signedAt : when.toUTCString();
  return [
    sig.termsText,
    "",
    "────────────────────────────────────────",
    `Accepted electronically by: ${sig.signerName}`,
    `Email: ${buyerEmail}`,
    `Date and time: ${stamp}`,
    `Document fingerprint: ${sig.termsHash}`,
  ].join("\n");
}
