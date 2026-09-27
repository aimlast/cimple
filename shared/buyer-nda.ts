/**
 * The buyer's non-disclosure agreement shown at the view-room NDA step.
 *
 * The brokerage sets its own terms (Settings → Buyer NDA, stored on the
 * broker's `users.settings.buyerNdaTerms`) and may override them for one
 * deal (`users.settings.buyerNdaDealTerms[dealId]`). Without either, the
 * standard terms below are used. Terms may use two placeholders, filled in
 * when shown to the buyer:
 *   {firm}         the brokerage's name (else the broker's own name)
 *   {opportunity}  how this buyer may see the deal named — the project
 *                  codename on the Blind CIM, never the business's name
 *
 * The exact rendered text the buyer saw is what they sign: its hash is
 * checked at signing, and the text, hash and typed name are kept on the
 * access row (ndaProfile.signature) as the record of the agreement.
 *
 * Pure — shared by the server, the view room and Settings.
 */

export const BUYER_NDA_MAX_LENGTH = 20_000;

export const STANDARD_BUYER_NDA_TERMS = `CONFIDENTIALITY AND NON-DISCLOSURE AGREEMENT

You are asking {firm} (the "Broker") for confidential information about {opportunity} (the "Business"), which its owner is considering selling. In return for receiving that information, you agree as follows.

1. Confidential Information. "Confidential Information" means everything you receive about the Business — through this site, by email, in conversation, on visits or otherwise — including the identity of the Business and the fact that it may be for sale, its financial statements, customers, suppliers, employees, contracts, operations, and any notes or analyses you prepare from it. It does not include information you can show was already public through no fault of yours, or was lawfully in your possession before you received it from the Broker.

2. Use. You will use the Confidential Information only to evaluate a possible purchase of the Business, and for no other purpose.

3. Non-disclosure. You will keep the Confidential Information strictly confidential and will not disclose it to anyone except your own advisors, lenders and investors who need it to help you evaluate the purchase, who are told it is confidential, and who are bound to keep it confidential. You are responsible for any breach by them.

4. No contact. You will not contact the Business's owners, employees, customers, suppliers, landlord or lenders about the Business or its sale except through the Broker, unless the Broker agrees in writing.

5. Non-solicitation. For two (2) years from the date you accept this agreement, you will not, directly or indirectly, solicit or hire any employee of the Business, or solicit any of its customers, using or as a result of the Confidential Information.

6. Return or destruction. If you decide not to proceed, or when the Broker asks, you will promptly return or destroy all Confidential Information and any copies, notes or analyses containing it.

7. No obligation and no warranty. This agreement does not oblige either party to complete a transaction. The Confidential Information is provided as is; neither the Broker nor the owner makes any representation about its accuracy or completeness except as may be set out in a final signed purchase agreement.

8. Remedies. You agree that a breach may cause irreparable harm to the Business and its owner, who may seek an injunction in addition to any other remedy available to them.

9. Term and law. Your obligations last for two (2) years from the date you accept this agreement. This agreement is governed by the laws of the province or state in which the Broker's office is located.

By typing your full name and selecting "I agree", you confirm that you have read these terms and agree to be legally bound by them, on behalf of yourself and any company you represent.`;

export type BuyerNdaTermsSource = "deal" | "brokerage" | "standard";

export interface BuyerNdaSettings {
  buyerNdaTerms?: unknown;
  buyerNdaDealTerms?: unknown;
}

const cleanTerms = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.replace(/\r\n/g, "\n").trim();
  return t ? t.slice(0, BUYER_NDA_MAX_LENGTH) : null;
};

/** The unrendered terms in force for a deal, and where they came from. */
export function buyerNdaTemplateFor(settings: BuyerNdaSettings | null | undefined, dealId: string): { template: string; source: BuyerNdaTermsSource } {
  const perDeal = settings?.buyerNdaDealTerms && typeof settings.buyerNdaDealTerms === "object"
    ? cleanTerms((settings.buyerNdaDealTerms as Record<string, unknown>)[dealId])
    : null;
  if (perDeal) return { template: perDeal, source: "deal" };
  const brokerage = cleanTerms(settings?.buyerNdaTerms);
  if (brokerage) return { template: brokerage, source: "brokerage" };
  return { template: STANDARD_BUYER_NDA_TERMS, source: "standard" };
}

/** Fill the placeholders. `opportunity` must already be buyer-safe (codename on Blind). */
export function renderBuyerNdaTerms(template: string, vars: { firm?: string | null; opportunity?: string | null }): string {
  const firm = vars.firm?.trim() || "the broker who shared this opportunity with you";
  const opportunity = vars.opportunity?.trim() || "the business described to you";
  return template.replace(/\{firm\}/g, firm).replace(/\{opportunity\}/g, opportunity);
}

/** A typed signature: a real name — at least two letters, not an email or a lone initial. */
export function validSignerName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const name = v.replace(/\s+/g, " ").trim();
  if (name.length < 2 || name.length > 120) return null;
  if (name.includes("@")) return null;
  if (name.replace(/[\s\d.,'’"\-_()!?:;/\\]/g, "").length < 2) return null;
  return name;
}

export { cleanTerms as cleanBuyerNdaTerms };
