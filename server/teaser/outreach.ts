/**
 * Outreach emails with teaser links (spec §4.9). Drafts never contain a
 * token — only the placeholder {teaser link}. At send, each buyer's own link
 * replaces it: their existing active link on this deal (whatever its level),
 * else a new Teaser link (teaser_only) that lasts as the teaser's link-
 * lifetime setting says. The broker still reviews and clicks send.
 */
import type { BuyerAccess, BuyerAccessEvent, Deal } from "@shared/schema";
import { TEASER_ACCESS_LEVEL } from "@shared/access-levels";
import { viewLinkProblem } from "../buyers/view-access";
import type { TeaserRow } from "./store";

export const TEASER_LINK_TOKEN = "{teaser link}";
export const TEASER_LINK_LINE = `Here's a short anonymous summary of the business: ${TEASER_LINK_TOKEN}`;
export const TEASER_NEXT_STEP = "If you'd like the full confidential memorandum, ask for it from the summary — it takes a few minutes.";

export function hasTeaserToken(text: string): boolean {
  return text.includes(TEASER_LINK_TOKEN);
}

/** The teaser line, appended before the sign-off when a draft left it out. */
export function withTeaserLink(body: string, signOffName?: string | null): string {
  if (hasTeaserToken(body)) return body;
  const paras = body.split(/\n{2,}/);
  // The sign-off: the last paragraph starting "Best" / "Thanks" / "Regards" / "Cheers", or naming the broker.
  let at = paras.length;
  for (let i = paras.length - 1; i >= Math.max(0, paras.length - 2); i--) {
    if (/^(?:best|thanks|thank you|regards|kind regards|warm regards|cheers|sincerely)\b/i.test(paras[i].trim()) || (signOffName && paras[i].trim().startsWith(signOffName))) at = i;
  }
  paras.splice(at, 0, TEASER_LINK_LINE);
  return paras.join("\n\n");
}

/** The link's lifetime from the teaser's setting (null = until the teaser is taken offline). */
export function teaserLinkExpiry(row: Pick<TeaserRow, "linkLifetime">, now = Date.now()): Date | null {
  return row.linkLifetime === "until_offline" ? null : new Date(now + Number(row.linkLifetime) * 86_400_000);
}

/** The buyer's link for this email: an active one on the deal, else a new Teaser link. */
export async function ensureTeaserLinkFor(
  deal: Pick<Deal, "id">,
  row: Pick<TeaserRow, "linkLifetime">,
  buyer: { email: string; name?: string | null; company?: string | null; id?: string | null; emailVerified?: boolean | null },
): Promise<{ access: BuyerAccess; created: boolean }> {
  const { storage } = await import("../storage");
  const email = buyer.email.trim().toLowerCase();
  const existing = (await storage.getBuyerAccessByDeal(deal.id))
    .filter((a) => a.buyerEmail.trim().toLowerCase() === email && !viewLinkProblem(a))
    .sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime())[0];
  if (existing) return { access: existing, created: false };
  const { randomUUID } = await import("node:crypto");
  const access = await storage.createBuyerAccess({
    dealId: deal.id,
    // Linked only to an account that proved its inbox (the same rule as POST /buyers).
    buyerUserId: buyer.id && buyer.emailVerified ? buyer.id : null,
    accessToken: randomUUID(),
    buyerEmail: email,
    buyerName: buyer.name ?? null,
    buyerCompany: buyer.company ?? null,
    accessLevel: TEASER_ACCESS_LEVEL,
    expiresAt: teaserLinkExpiry(row),
    accessEvents: [{ type: "granted", at: new Date().toISOString(), accessLevel: TEASER_ACCESS_LEVEL, via: "outreach" }] satisfies BuyerAccessEvent[],
  } as never);
  return { access, created: true };
}

/** The plain body with the buyer's link in place of the token. */
export function fillTeaserToken(body: string, url: string): string {
  return body.split(TEASER_LINK_TOKEN).join(url);
}

/** One paragraph as HTML: escaped text, the link (escaped) as a link. */
export function paragraphHtml(p: string, url: string | null, esc: (t: string) => string): string {
  if (!url || !p.includes(TEASER_LINK_TOKEN)) return esc(p).replace(/\n/g, "<br/>");
  return p.split(TEASER_LINK_TOKEN).map((part) => esc(part).replace(/\n/g, "<br/>")).join(`<a href="${esc(url)}" style="color:#1f3a68;">${esc(url)}</a>`);
}
