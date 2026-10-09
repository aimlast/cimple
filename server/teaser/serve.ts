/**
 * Serving the teaser to a buyer (spec §4.7; INTEGRATION §2.3 step 3).
 *
 * GET /api/view/:token for a teaser_only link answers here, right after the
 * revoked/expired checks and BEFORE the CIM-published, NDA and view-stamp
 * steps: the teaser is read before any NDA and never counts as a CIM view
 * (firstViewedAt / viewCount drive CIM metrics and reminders — only
 * lastAccessedAt moves).
 *
 * The payload is a whitelist: no sections of the CIM, no published
 * questions, no extractedInfo, no data room. Every block is re-checked with
 * the current identity terms; one that fails isn't served.
 */
import type { Request, Response } from "express";
import type { BuyerAccess, Deal } from "@shared/schema";
import { TEASER_ACCESS_LEVEL } from "@shared/access-levels";
import type { ViewRoomReading } from "@shared/analytics-v2";
import { buildBuyerTeaser, type BuyerTeaser, type TeaserContact } from "@shared/teaser-view";
import { viewLinkProblem } from "../buyers/view-access";
import { getDealTeaser, teaserPublished, type TeaserRow } from "./store";
import { emailCheckState } from "./email-check";
import { latestPass, requestStateFor } from "./requests";
import { servedCodenameFor } from "./summary";

/** A teaser link reads the teaser: published and online, and the link itself usable. */
export function linkOpenForBuyer(
  _deal: Pick<Deal, "id"> | null | undefined,
  access: Pick<BuyerAccess, "revokedAt" | "expiresAt"> | null | undefined,
  teaser: Pick<TeaserRow, "published" | "unpublishedAt"> | null | undefined,
): boolean {
  return !!access && !viewLinkProblem(access) && teaserPublished(teaser ?? null);
}

/** The teaser design: the deal's (or the teaser's own) look, always the BLIND payload, brokerage pages off. */
export async function teaserDesign(deal: Deal, row: Pick<TeaserRow, "designTemplateId">) {
  const { designPayload } = await import("../cim/templates");
  const d = await designPayload({ ...deal, designTemplateId: row.designTemplateId ?? deal.designTemplateId } as Deal, "blind");
  return {
    ...d,
    template: { ...d.template, name: "" },
    business: null,
    brokerage: { ...d.brokerage, showDisclaimerPage: false, showContactPage: false },
  };
}

/** The brokerage contact (not business identity). */
export function contactFromDesign(design: { brokerage: { firmName: string | null; contactName: string | null; email: string | null; phone: string | null } }): TeaserContact {
  return { firm: design.brokerage.firmName, name: design.brokerage.contactName, email: design.brokerage.email, phone: design.brokerage.phone };
}

/** The buyer teaser for a row (the published doc, or the draft for the broker's preview). */
export async function buyerTeaserFor(deal: Deal, row: TeaserRow, opts: { draft?: boolean } = {}): Promise<{ teaser: BuyerTeaser; design: Awaited<ReturnType<typeof teaserDesign>>; contact: TeaserContact; codename: string }> {
  const { listedAskingPrice } = await import("../information/deal-mirror");
  const [design, codename] = await Promise.all([teaserDesign(deal, row), servedCodenameFor(deal)]);
  const contact = contactFromDesign(design);
  const doc = opts.draft ? row.draft : (row.published ?? { header: null, blocks: [] });
  const teaser = buildBuyerTeaser({
    deal,
    doc,
    codename,
    codenameUsed: row.codenameUsed,
    askingPrice: listedAskingPrice(deal),
    showAskingPrice: row.showAskingPrice,
    numbers: row.numbers,
    contact,
  });
  return { teaser, design, contact, codename };
}

export const TEASER_NOT_PUBLISHED = { code: "not_published", error: "This summary isn't available right now." } as const;

type RenditionWriterLike = import("../analytics/renditions").RenditionWriter;
let renditionWriter: RenditionWriterLike | undefined;
/** Tests: where teaser renditions are written (undefined restores the database). */
export function _setTeaserRenditionWriterForTests(w: RenditionWriterLike | undefined): void {
  renditionWriter = w;
}

/**
 * The view-room teaser branch. `ownerPreview` = the owning broker is looking
 * (no reading recorded). Returns after responding.
 */
export async function serveTeaser(req: Request, res: Response, access: BuyerAccess, deal: Deal): Promise<void> {
  const row = await getDealTeaser(deal.id);
  if (!linkOpenForBuyer(deal, access, row) || !row) {
    res.status(403).json(TEASER_NOT_PUBLISHED);
    return;
  }
  const { storage } = await import("../storage");
  const built = await buyerTeaserFor(deal, row);
  if (built.teaser.blocks.length === 0) {
    res.status(403).json(TEASER_NOT_PUBLISHED);
    return;
  }
  if (built.teaser.leaked.length > 0) console.warn(`[teaser] withheld ${built.teaser.leaked.length} teaser block(s) on deal ${deal.id} that now name identifying details`);
  // Only lastAccessedAt moves — never firstViewedAt or viewCount (CIM metrics and reminders).
  await storage.updateBuyerAccess(access.id, { lastAccessedAt: new Date() } as never).catch(() => undefined);
  const session = (req as Request & { session?: { brokerId?: string; buyerId?: string } }).session;
  const ownerPreview = !!session?.brokerId && session.brokerId === deal.brokerId;
  let reading: ViewRoomReading | null = null;
  if (!ownerPreview) {
    const { recordTeaserRendition } = await import("../analytics/renditions");
    reading = await recordTeaserRendition({
      dealId: deal.id,
      sections: built.teaser.blocks,
      design: built.design,
      header: built.teaser.header,
    }, renditionWriter);
  }
  const [emailCheck, requests] = await Promise.all([
    emailCheckState(access, deal, session?.buyerId ?? null),
    storage.getBuyerApprovalRequestsByDeal(deal.id).catch(() => []),
  ]);
  const req2 = requestStateFor(access.id, requests as never);
  const pass = latestPass(access);
  res.json({
    document: "teaser",
    access: {
      id: access.id,
      dealId: access.dealId,
      buyerEmail: access.buyerEmail,
      buyerName: access.buyerName,
      accessLevel: TEASER_ACCESS_LEVEL,
      ndaSigned: access.ndaSigned,
      ndaSignedAt: access.ndaSignedAt,
      watermarkEnabled: access.watermarkEnabled,
      expiresAt: access.expiresAt,
    },
    deal: { id: deal.id, businessName: built.codename, industry: deal.industry },
    teaser: { header: built.teaser.header, blocks: built.teaser.blocks, pageSize: row.pageSize },
    design: built.design,
    branding: { companyName: built.design.brokerage.firmName, logoUrl: built.design.brokerage.logoUrl, disclaimer: built.design.brokerage.disclaimer },
    contact: built.contact,
    ndaRequired: !!deal.ndaRequired,
    emailCheck: { needed: emailCheck.needed, maskedEmail: emailCheck.maskedEmail, verified: emailCheck.verified, method: emailCheck.method },
    cimRequest: { state: req2.state, at: req2.at },
    passed: pass ? { at: pass.at, reasons: pass.reasons } : null,
    ...(reading ? { reading } : {}),
  });
}

/** The 403 an EXPIRED teaser link gets (the client shows "Ask {firm} for a fresh link"). */
export async function expiredTeaserBody(deal: Deal | null | undefined): Promise<{ code: "expired"; teaser: true; error: string; firm: string | null }> {
  let firm: string | null = null;
  if (deal) {
    try {
      const { brokerageBrand } = await import("../cim/templates");
      firm = (await brokerageBrand(deal.brokerId)).firmName;
    } catch {
      firm = null;
    }
  }
  return { code: "expired", teaser: true, error: "Link has expired", firm };
}
