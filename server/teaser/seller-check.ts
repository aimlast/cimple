/**
 * "Ask the seller to check it" (spec §4.6, decision 14; optional — the
 * broker decides). The broker's click snapshots the guarded, visible draft
 * into seller_check.doc and emails each seller-team owner their review link
 * (the existing cim_ready event, metadata.kind = "teaser"). The seller reads
 * it on /seller/:token/review and approves, or asks for changes with a note
 * (a broker task, like the CIM review). Only the owner's link signs off.
 */
import type { Deal } from "@shared/schema";
import { buildBuyerTeaser, checkTeaserBlock, teaserTerms } from "@shared/teaser-view";
import type { TeaserDoc } from "@shared/teaser";
import { sellerLinkRights, type SellerLinkRights } from "@shared/seller-link-rights";
import { teaserStore, TeaserConflict, type TeaserRow } from "./store";
import { servedCodenameFor } from "./summary";

export const TEASER_REVIEW_TASK_CREATOR = "seller_teaser_review";
export const ONLY_OWNER_TEASER = (owner: string | null) =>
  `Only ${owner?.trim() || "the business owner"} can approve the teaser — you can read it.`;

export class SellerCheckError extends Error {
  constructor(public status: 400 | 403 | 404 | 409, message: string, public code: string) {
    super(message);
  }
}

/** The seller-team owner (the person who signs off), or null when the deal has none with a link. */
export async function sellerOwner(dealId: string): Promise<{ name: string | null; email: string | null } | null> {
  const { storage } = await import("../storage");
  const [invites, members] = await Promise.all([storage.getSellerInvitesByDealId(dealId), storage.getDealMembers(dealId)]);
  for (const inv of invites) {
    if ((inv as { status?: string | null }).status === "revoked" || !inv.token) continue;
    if (sellerLinkRights(inv, members as never).canApproveCim) return { name: inv.sellerName ?? null, email: inv.sellerEmail ?? null };
  }
  return null;
}

/** The snapshot the seller reads: visible, written blocks that pass the identity check now. */
export function sellerCheckDoc(draft: TeaserDoc, deal: Deal, codename: string): TeaserDoc {
  const terms = teaserTerms(deal, codename);
  return {
    header: draft.header,
    blocks: draft.blocks.filter((b) => !b.hidden && !b.placeholder && !checkTeaserBlock(b, terms).held),
  };
}

export async function sendSellerCheck(deal: Deal, rev: number): Promise<TeaserRow> {
  const owner = await sellerOwner(deal.id);
  if (!owner) throw new SellerCheckError(409, "Add the seller on the Team tab first.", "no_seller_owner");
  const codename = await servedCodenameFor(deal);
  let conflict: Error | null = null;
  const row = await teaserStore().update(deal.id, (r) => {
    if (r.draftRev !== rev) {
      conflict = new TeaserConflict("stale", "This teaser changed in another tab — showing the latest.");
      return null;
    }
    const doc = sellerCheckDoc(r.draft, deal, codename);
    if (doc.blocks.length === 0) {
      conflict = new SellerCheckError(409, "Write the teaser first — there's nothing for the seller to check yet.", "empty");
      return null;
    }
    return { sellerCheck: { status: "sent", sentAt: new Date().toISOString(), sentRev: r.draftRev, doc, at: null, byName: null, note: null } };
  });
  if (conflict) throw conflict;
  if (!row) throw new TeaserConflict("missing", "There's no teaser yet.");
  const { notifySellerPortal } = await import("../notifications/service");
  await notifySellerPortal(deal.id, "cim_ready", {
    title: "Your broker would like you to check the teaser",
    body: "It's the short anonymous summary buyers see before they sign an NDA. Please check that nothing in it would let someone recognise your business, then approve it or tell your broker what to change.",
    path: "review",
    businessName: deal.businessName,
    metadata: { kind: "teaser", rev: row.draftRev },
  }).catch((err: unknown) => console.warn("[teaser] seller check email failed:", err));
  return row;
}

export interface SellerFound {
  deal: Deal;
  sellerName: string | null;
  rights: SellerLinkRights;
}

/** The teaser for the seller's review page (null = nothing sent yet). */
export async function sellerTeaserView(found: SellerFound, previewByBroker: boolean) {
  const { getDealTeaser } = await import("./store");
  const row = await getDealTeaser(found.deal.id);
  const check = row?.sellerCheck;
  if (!row || !check) return { available: false as const };
  const { buyerTeaserFor } = await import("./serve");
  const built = await buyerTeaserFor(found.deal, { ...row, draft: check.doc }, { draft: true });
  const owner = await sellerOwner(found.deal.id);
  return {
    available: true as const,
    status: check.status,
    sentAt: check.sentAt,
    at: check.at ?? null,
    note: check.note ?? null,
    header: built.teaser.header,
    blocks: built.teaser.blocks,
    pageSize: row.pageSize,
    design: built.design,
    canApprove: found.rights.canApproveCim && !previewByBroker,
    readOnlyMessage: found.rights.canApproveCim ? null : ONLY_OWNER_TEASER(owner?.name ?? null),
    previewByBroker,
  };
}

function guardSeller(found: SellerFound, previewByBroker: boolean): void {
  if (previewByBroker) throw new SellerCheckError(403, "You're signed in as the deal's broker — this is the seller's button.", "broker_preview");
  if (!found.rights.canApproveCim) throw new SellerCheckError(403, ONLY_OWNER_TEASER(null), "not_owner");
}

export async function approveSellerCheck(found: SellerFound, previewByBroker: boolean): Promise<void> {
  guardSeller(found, previewByBroker);
  let missing = false;
  await teaserStore().update(found.deal.id, (r) => {
    if (!r.sellerCheck) {
      missing = true;
      return null;
    }
    return { sellerCheck: { ...r.sellerCheck, status: "approved", at: new Date().toISOString(), byName: found.sellerName, note: null } };
  });
  if (missing) throw new SellerCheckError(409, "There's no teaser waiting for your check right now.", "nothing_sent");
  const { storage } = await import("../storage");
  const open = (await storage.getTasksByDeal(found.deal.id)).filter((t) => t.createdBy === TEASER_REVIEW_TASK_CREATOR && t.status !== "completed");
  await Promise.all(open.map((t) => storage.updateTask(t.id, { status: "completed", completedAt: new Date() } as never)));
  const { notify } = await import("../notifications/service");
  notify(found.deal.id, "cim_seller_approved", {
    title: `The seller approved the teaser — ${found.deal.businessName}`,
    body: "The seller checked the teaser and approved it. You can publish it from the CIM tab.",
    actionUrl: `/deal/${found.deal.id}/cim?view=teaser`,
    businessName: found.deal.businessName,
    metadata: { kind: "teaser" },
  }).catch((e: unknown) => console.warn("[teaser] broker email failed:", e));
}

export async function requestSellerChanges(found: SellerFound, previewByBroker: boolean, noteRaw: unknown): Promise<{ taskId: string }> {
  guardSeller(found, previewByBroker);
  const note = typeof noteRaw === "string" ? noteRaw.trim().slice(0, 4000) : "";
  if (note.length < 3) throw new SellerCheckError(400, "Tell your broker what should change.", "note_required");
  let missing = false;
  await teaserStore().update(found.deal.id, (r) => {
    if (!r.sellerCheck) {
      missing = true;
      return null;
    }
    return { sellerCheck: { ...r.sellerCheck, status: "changes_requested", at: new Date().toISOString(), byName: found.sellerName, note } };
  });
  if (missing) throw new SellerCheckError(409, "There's no teaser waiting for your check right now.", "nothing_sent");
  const { storage } = await import("../storage");
  const who = found.sellerName?.trim() || "The seller";
  const task = await storage.createTask({
    dealId: found.deal.id,
    createdBy: TEASER_REVIEW_TASK_CREATOR,
    assignedTo: found.deal.brokerId || null,
    type: "follow_up",
    title: `${who} asked for changes to the teaser`,
    description: note,
    relatedField: null,
    status: "pending",
    priority: "high",
    aiAttempts: 0,
    aiExplanation: null,
  } as never);
  const { notify, escapeHtml } = await import("../notifications/service");
  notify(found.deal.id, "cim_changes_requested", {
    title: `The seller asked for changes to the teaser — ${found.deal.businessName}`,
    body: `${escapeHtml(who)} wrote: “${escapeHtml(note.slice(0, 1200))}”`,
    actionUrl: `/deal/${found.deal.id}/cim?view=teaser`,
    businessName: found.deal.businessName,
    metadata: { kind: "teaser", taskId: task.id },
  }).catch((e: unknown) => console.warn("[teaser] broker email failed:", e));
  return { taskId: task.id };
}

/** Re-export for the routes. */
export { buildBuyerTeaser };
