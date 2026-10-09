/**
 * "Ask for the CIM" from the teaser (spec §4.8). A request reuses the buyer
 * approval workflow (buyer_approval_requests, source = 'teaser_request'):
 * the broker gives access (Blind CIM / Full CIM / Due diligence), asks the
 * seller first, or declines. Requests never grant anything by themselves —
 * only the broker's click, the seller's approval the broker asked for, or
 * the per-deal automatic access the broker switched on (CIM live and the
 * NDA signer is the link's own recipient).
 *
 * One open request per link (idempotent); the email on the request is
 * always the link's own address; every buyer-typed value reaching the
 * broker's email is escaped. The broker is told through the EXISTING
 * buyer_approval_requested event (NOTIFICATION_ROUTING is untouched).
 */
import type { BuyerAccess, BuyerAccessEvent, BuyerApprovalRequest, Deal } from "@shared/schema";
import { riskLevelForCategory } from "@shared/schema";
import { isTeaserOnly, seesCim, normalizeAccessLevel, TEASER_ACCESS_LEVEL } from "@shared/access-levels";
import { dealPublishedForBuyers } from "@shared/buyer-publish-gate";
import { FUNDING_OPTIONS, TIMELINE_OPTIONS, formatPrice, type NdaBuyerProfile } from "@shared/nda-buyer-profile";
import { TEASER_PASS_REASONS, autoGrantLevel, type TeaserPassReason, type TeaserRequestState } from "@shared/teaser";
import { viewLinkProblem } from "../buyers/view-access";

export const TEASER_REQUEST_SOURCE = "teaser_request";
/** Statuses where the request is still with the broker or the seller. */
export const OPEN_REQUEST_STATUSES = new Set(["pending_broker_review", "approved_by_broker", "pending_seller_review", "approved_by_seller", "approved_waiting_publish"]);

/**
 * Approved while the CIM wasn't live — granted at publish (grantWaitingApprovals):
 * the seller's approval (approved_by_seller) or the broker's "Give access"
 * (approved_waiting_publish), not yet given.
 */
export function waitingForPublish(r: { status: string; grantedBuyerAccessId?: string | null }): boolean {
  return (r.status === "approved_by_seller" || r.status === "approved_waiting_publish") && !r.grantedBuyerAccessId;
}

export class TeaserRequestError extends Error {
  constructor(public status: 400 | 403 | 404 | 409, message: string, public code: string) {
    super(message);
  }
}

export interface TeaserRequestInfo {
  linkName: string | null;
  linkEmail: string;
  signerName: string | null;
  emailCheck: "code" | "account" | "demo";
  mismatch: boolean;
}

/** Names compared folded (case, accents, punctuation, titles). */
export function foldName(n: string | null | undefined): string {
  return (n ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\b(?:dr|mr|mrs|ms|mx|prof)\.?\s+/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The signer differs from the link's name (both present). */
export function namesMismatch(linkName: string | null | undefined, signerName: string | null | undefined): boolean {
  const a = foldName(linkName);
  const b = foldName(signerName);
  return !!a && !!b && a !== b;
}

/** The NDA buyer type → a BUYER_CATEGORIES value (the request card shows the buyer's own words too). */
export function categoryFor(p: Pick<NdaBuyerProfile, "buyerType" | "operateSelf" | "financialKind"> | null | undefined): string {
  if (!p) return "other";
  if (p.buyerType === "individual") return p.operateSelf === "yes" ? "individual_strategic" : "individual_financial";
  if (p.buyerType === "strategic") return "strategic_acquirer";
  if (p.buyerType === "financial") {
    if (p.financialKind === "private_equity") return "pe_generalist";
    if (p.financialKind === "family_office") return "family_office";
    if (p.financialKind === "search_fund") return "search_fund";
    return "independent_sponsor";
  }
  return "other";
}

/** A plain summary of the NDA profile for the request card (what they want, price, funding, timeline). */
export function backgroundFor(p: Partial<NdaBuyerProfile> | null | undefined): string | null {
  if (!p) return null;
  const label = <T extends readonly { value: string; label: string }[]>(opts: T, v: unknown) => opts.find((o) => o.value === v)?.label ?? null;
  const price = p.priceMin != null || p.priceMax != null
    ? `${p.priceMin != null ? formatPrice(p.priceMin) : "up"}${p.priceMax != null ? `–${formatPrice(p.priceMax)}` : "+"}`
    : null;
  const parts = [
    p.lookingFor ? `Looking for: ${String(p.lookingFor).trim()}` : null,
    price ? `Price range: ${price}` : null,
    label(FUNDING_OPTIONS, p.funding) ? `Funding: ${label(FUNDING_OPTIONS, p.funding)}` : null,
    label(TIMELINE_OPTIONS, p.timeline) ? `Timeline: ${label(TIMELINE_OPTIONS, p.timeline)}` : null,
    p.fitReason ? `Why it fits: ${String(p.fitReason).trim()}` : null,
    p.background ? `Background: ${String(p.background).trim()}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join("\n").slice(0, 4000) : null;
}

/** The request state a teaser link shows (the latest teaser request on it). */
export function requestStateFor(accessId: string, requests: Array<Pick<BuyerApprovalRequest, "status" | "createdAt" | "updatedAt"> & { buyerAccessId?: string | null; source?: string | null; grantedAt?: Date | null }>): { state: TeaserRequestState; at: string | null } {
  const mine = requests
    .filter((r) => r.buyerAccessId === accessId && r.source === TEASER_REQUEST_SOURCE)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const r = mine[0];
  if (!r) return { state: "none", at: null };
  const at = new Date(r.updatedAt ?? r.createdAt).toISOString();
  if (r.status === "access_granted") return { state: "granted", at: r.grantedAt ? new Date(r.grantedAt).toISOString() : at };
  if (r.status === "approved_waiting_publish") return { state: "approved_waiting", at };
  if (r.status === "rejected" || r.status === "rejected_by_broker" || r.status === "rejected_by_seller") return { state: "declined", at };
  if (OPEN_REQUEST_STATUSES.has(r.status)) return { state: "requested", at: new Date(r.createdAt).toISOString() };
  return { state: "none", at: null };
}

const locks = new Map<string, Promise<unknown>>();
async function withAccessLock<T>(accessId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(accessId) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  locks.set(accessId, run.finally(() => { if (locks.get(accessId) === run) locks.delete(accessId); }));
  return run;
}

export interface EnsureRequestInput {
  /** The NDA profile (sign-nda / cim-request) or null when the profile on file was confirmed. */
  profile: Partial<NdaBuyerProfile> | null;
  note?: string | null;
  signerName?: string | null;
  emailCheck: "code" | "account" | "demo";
  /** The name the broker sent the link to, read BEFORE the NDA/profile step rewrote the row. */
  linkName?: string | null;
}

export interface EnsureRequestDeps {
  /** Auto-grant (grantApprovedBuyer with grantedBy "auto", no buyer email). */
  autoGrant?: (request: BuyerApprovalRequest, level: string) => Promise<void>;
  /** The deal's auto_grant setting ("off" | "blind" | "named"). */
  autoGrantLevel?: string;
}

/**
 * The open request for this teaser link — created once. Refuses a link that
 * already opens a CIM (409), an email that already has a CIM link on this
 * deal (409). The email check is the caller's (routes) — 400 before this.
 */
export async function ensureTeaserRequest(
  access: BuyerAccess,
  deal: Deal,
  input: EnsureRequestInput,
  deps: EnsureRequestDeps = {},
): Promise<{ request: BuyerApprovalRequest; created: boolean; state: TeaserRequestState; autoGranted: boolean }> {
  const { storage } = await import("../storage");
  return withAccessLock(access.id, async () => {
    const fresh = (await storage.getBuyerAccess(access.id)) ?? access;
    if (!isTeaserOnly(fresh.accessLevel)) throw new TeaserRequestError(409, "You already have the CIM.", "already_cim");
    const others = await storage.getBuyerAccessByDeal(deal.id);
    const email = fresh.buyerEmail.trim().toLowerCase();
    if (others.some((a) => a.id !== fresh.id && a.buyerEmail.trim().toLowerCase() === email && seesCim(a.accessLevel) && !viewLinkProblem(a))) {
      throw new TeaserRequestError(409, "You already have access to the CIM. Use the link your broker sent you.", "has_cim_link");
    }
    const requests = await storage.getBuyerApprovalRequestsByDeal(deal.id);
    const open = requests.find((r) => (r as { buyerAccessId?: string | null }).buyerAccessId === fresh.id && (r as { source?: string | null }).source === TEASER_REQUEST_SOURCE && OPEN_REQUEST_STATUSES.has(r.status));
    if (open) {
      const note = typeof input.note === "string" ? input.note.trim().slice(0, 1000) : "";
      if (note && note !== (open as { buyerNote?: string | null }).buyerNote) await storage.updateBuyerApprovalRequest(open.id, { buyerNote: note } as never);
      return { request: open, created: false, state: requestStateFor(fresh.id, requests).state, autoGranted: false };
    }

    const nda = ((fresh.ndaProfile as Record<string, unknown> | null) ?? {}) as Partial<NdaBuyerProfile> & { signature?: { signerName?: string } };
    const profile = (input.profile ?? nda) as Partial<NdaBuyerProfile>;
    const signerName = input.signerName ?? nda.signature?.signerName ?? profile.name ?? null;
    const linkName = input.linkName !== undefined ? input.linkName : fresh.buyerName ?? null;
    const info: TeaserRequestInfo = {
      linkName,
      linkEmail: fresh.buyerEmail,
      signerName,
      emailCheck: input.emailCheck,
      mismatch: namesMismatch(linkName, signerName),
    };
    const category = categoryFor(profile as NdaBuyerProfile);
    const hasProof = profile.proofOfFunds === "yes";
    const RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };
    const riskLevel = ([riskLevelForCategory(category), hasProof ? "low" : "medium"] as Array<"low" | "medium" | "high">).reduce((a, b) => (RANK[b] > RANK[a] ? b : a));
    const crypto = await import("node:crypto");
    const note = typeof input.note === "string" && input.note.trim() ? input.note.trim().slice(0, 1000) : null;
    const request = await storage.createBuyerApprovalRequest({
      dealId: deal.id,
      submittedBy: "buyer",
      submittedByName: profile.name ?? fresh.buyerName ?? null,
      submittedByRole: "buyer",
      buyerName: profile.name || fresh.buyerName || fresh.buyerEmail,
      buyerTitle: profile.title ?? null,
      buyerEmail: fresh.buyerEmail,
      buyerPhone: profile.phone ?? null,
      buyerCompany: profile.company || fresh.buyerCompany || null,
      buyerCompanyUrl: profile.companyWebsite ?? null,
      linkedinUrl: null,
      otherProfileUrls: [],
      category,
      riskLevel,
      background: backgroundFor(profile),
      financialCapability: { hasProofOfFunds: hasProof, sourceOfFunds: FUNDING_OPTIONS.find((o) => o.value === profile.funding)?.label },
      partners: [],
      isCompetitor: false,
      competitorDetails: null,
      ndaSigned: !!fresh.ndaSigned,
      ndaDocumentId: null,
      ndaNotes: null,
      crmSource: null,
      crmRecordId: null,
      crmRawData: null,
      status: "pending_broker_review",
      sellerReviewToken: crypto.randomUUID(),
      source: TEASER_REQUEST_SOURCE,
      buyerAccessId: fresh.id,
      grantAccessLevel: null,
      grantedBy: null,
      buyerNote: note,
      teaserRequest: info,
    } as never);
    const events = [...(((fresh.accessEvents as BuyerAccessEvent[] | null) ?? []))];
    events.push({ type: "cim_requested", at: new Date().toISOString() });
    await storage.updateBuyerAccess(fresh.id, { accessEvents: events.slice(-50) } as never);

    // Auto-grant: only when the broker switched it on, the CIM is live, and the signer is the link's recipient.
    const level = autoGrantLevel(deps.autoGrantLevel);
    let autoGranted = false;
    if (level && dealPublishedForBuyers(deal) && !info.mismatch && deps.autoGrant) {
      try {
        await deps.autoGrant(request, level);
        autoGranted = true;
      } catch (err) {
        console.error(`[teaser] auto-grant failed for request ${request.id}:`, err);
      }
    }
    if (!autoGranted) await notifyBrokerOfRequest(deal, request, info);
    return { request, created: true, state: autoGranted ? "granted" : "requested", autoGranted };
  });
}

/** "{Buyer} asked for the CIM" — the existing buyer_approval_requested event, every buyer value escaped. */
export async function notifyBrokerOfRequest(deal: Deal, request: BuyerApprovalRequest, info: TeaserRequestInfo): Promise<void> {
  const { notify, escapeHtml } = await import("../notifications/service");
  const who = request.buyerName || request.buyerEmail;
  const note = (request as { buyerNote?: string | null }).buyerNote;
  const confirmed = info.emailCheck === "demo" ? "" : " confirmed their email and";
  const nda = request.ndaSigned ? " signed the NDA" : " sent their details";
  const body =
    `<strong>${escapeHtml(who)}</strong>${request.buyerCompany ? ` (${escapeHtml(request.buyerCompany)})` : ""} read the teaser,${confirmed}${nda}.` +
    (info.mismatch ? `<br/><br/>Signed by ${escapeHtml(info.signerName ?? "")} — you sent this link to ${escapeHtml(info.linkName ?? info.linkEmail)}.` : "") +
    (note ? `<br/><br/><em>Their note:</em> &ldquo;${escapeHtml(note)}&rdquo;` : "") +
    (request.background ? `<br/><br/>${escapeHtml(request.background).replace(/\n/g, "<br/>")}` : "");
  await notify(deal.id, "buyer_approval_requested", {
    title: `${who} asked for the CIM`,
    body,
    actionUrl: `/deal/${deal.id}/buyers?stage=approval`,
    businessName: deal.businessName,
    metadata: { approvalRequestId: request.id, source: TEASER_REQUEST_SOURCE },
  }).catch((err: unknown) => console.warn("[teaser] request notice failed:", err));
}

/** The buyer adds or updates their note while the request is open. */
export async function updateRequestNote(access: BuyerAccess, note: string): Promise<boolean> {
  const { storage } = await import("../storage");
  const requests = await storage.getBuyerApprovalRequestsByDeal(access.dealId);
  const open = requests.find((r) => (r as { buyerAccessId?: string | null }).buyerAccessId === access.id && (r as { source?: string | null }).source === TEASER_REQUEST_SOURCE && OPEN_REQUEST_STATUSES.has(r.status));
  if (!open) return false;
  await storage.updateBuyerApprovalRequest(open.id, { buyerNote: note.trim().slice(0, 1000) || null } as never);
  return true;
}

/**
 * A broker moved this link to a CIM level by hand (PATCH /api/buyers/:id):
 * its open teaser request is closed as given.
 */
export async function closeRequestOnLevelChange(access: Pick<BuyerAccess, "id" | "dealId">, level: string): Promise<void> {
  if (isTeaserOnly(level)) return;
  const { storage } = await import("../storage");
  const requests = await storage.getBuyerApprovalRequestsByDeal(access.dealId);
  for (const r of requests) {
    if ((r as { buyerAccessId?: string | null }).buyerAccessId !== access.id || (r as { source?: string | null }).source !== TEASER_REQUEST_SOURCE || !OPEN_REQUEST_STATUSES.has(r.status)) continue;
    await storage.updateBuyerApprovalRequest(r.id, {
      status: "access_granted",
      grantAccessLevel: normalizeAccessLevel(level),
      grantedBy: "broker",
      grantedBuyerAccessId: access.id,
      grantedAt: new Date(),
    } as never);
  }
}

/** "Not for me" — the latest pass wins; never the CIM decision, never an email. */
export async function recordTeaserPass(access: BuyerAccess, reasons: unknown, note: unknown): Promise<void> {
  const { storage } = await import("../storage");
  const list = (Array.isArray(reasons) ? reasons : []).filter((r): r is TeaserPassReason => (TEASER_PASS_REASONS as readonly string[]).includes(String(r)));
  const events = [...(((access.accessEvents as BuyerAccessEvent[] | null) ?? []))];
  events.push({ type: "teaser_passed", at: new Date().toISOString(), reasons: Array.from(new Set(list)), note: typeof note === "string" && note.trim() ? note.trim().slice(0, 500) : null });
  await storage.updateBuyerAccess(access.id, { accessEvents: events.slice(-50) } as never);
}

/** A fresh link asked for (an EXPIRED, not revoked, teaser link): at most once per 24 h. */
export async function recordFreshLinkRequest(access: BuyerAccess, now = Date.now()): Promise<"recorded" | "already" | "not_expired" | "not_teaser" | "revoked"> {
  if (!isTeaserOnly(access.accessLevel)) return "not_teaser";
  if (access.revokedAt) return "revoked";
  if (!access.expiresAt || new Date(access.expiresAt).getTime() >= now) return "not_expired";
  const events = [...(((access.accessEvents as BuyerAccessEvent[] | null) ?? []))];
  const last = [...events].reverse().find((e) => e.type === "fresh_link_requested");
  if (last && now - Date.parse(last.at) < 86_400_000) return "already";
  events.push({ type: "fresh_link_requested", at: new Date(now).toISOString() });
  const { storage } = await import("../storage");
  await storage.updateBuyerAccess(access.id, { accessEvents: events.slice(-50) } as never);
  return "recorded";
}

/** The latest "Not for me" on a link (null when none). */
export function latestPass(access: Pick<BuyerAccess, "accessEvents">): { at: string; reasons: string[]; note: string | null } | null {
  const events = ((access.accessEvents as BuyerAccessEvent[] | null) ?? []).filter((e) => e.type === "teaser_passed");
  const e = events[events.length - 1];
  return e ? { at: e.at, reasons: e.reasons ?? [], note: e.note ?? null } : null;
}

export { TEASER_ACCESS_LEVEL };
