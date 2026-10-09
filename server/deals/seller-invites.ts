/**
 * seller-invites.ts — one seller link per person on the seller side
 * (moved unchanged out of routes.ts so "Add-backs in the books" can give a
 * seller's accountant their own link the same way the Team tab does).
 */
import crypto from "node:crypto";
import { storage } from "../storage";

/** The deal's seller invite for this email (its name kept current), or a new one. */
export async function findOrCreateSellerInvite(
  dealId: string,
  sellerEmail: string,
  sellerName?: string | null,
) {
  const { insertSellerInviteSchema } = await import("@shared/schema");
  const existing = await storage.getSellerInvitesByDealId(dealId);
  const match = sellerEmail
    ? existing.find(
        (i) => (i.sellerEmail || "").toLowerCase() === sellerEmail.toLowerCase(),
      )
    : undefined;
  if (match) {
    // Keep the seller's name current on re-invite.
    if (sellerName && sellerName !== match.sellerName) {
      const updated = await storage.updateSellerInvite(match.id, { sellerName });
      if (updated) return updated;
    }
    return match;
  }
  const validated = insertSellerInviteSchema.parse({
    dealId,
    token: crypto.randomUUID(),
    sellerEmail: sellerEmail || null,
    sellerName: sellerName || null,
  });
  return storage.createSellerInvite(validated);
}
