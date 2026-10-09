/**
 * The seller's CIM review — /seller/:token/review.
 *
 * "Seller approved" was required for the content and the design, and the
 * deal list said "Waiting on the seller: content approval", but no seller
 * page showed the CIM and nothing ever sent it to them (cim_ready had no
 * emitter). The broker's only way forward was "Approve as Seller", so a
 * CIM could reach buyers without the seller ever reading it.
 *
 * Now:
 *   - the broker sends it for review (POST /api/deals/:dealId/seller-review/send)
 *     — each seller gets their own link by email (cim_ready);
 *   - the seller reads the named CIM read-only and approves, or asks for
 *     changes with a note (a task on the broker's open items + an email);
 *   - the broker's "Approve on the seller's behalf" stays, as an explicit,
 *     labelled override (the deal PATCH).
 * The seller sees the CIM once the broker has approved it (content, then
 * design) — never an unreviewed draft.
 */
import type { Express, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { storage } from "../storage";
import { requireBroker, requireOwnedDeal, getOwnedDeal } from "../broker-auth/routes";
import { buildBuyerCim, cimHeldFromBuyers } from "@shared/cim-buyer-view";
import { discrepancyBlocksCim } from "@shared/discrepancy-gate";
import {
  sellerApprovalField,
  sellerReviewStage,
  SELLER_REVIEW_TASK_CREATOR,
  isOpenTask,
  type SellerReviewStage,
} from "@shared/seller-portal";
import { listedAskingPrice } from "../information/deal-mirror";
import { loadMediaAssets } from "../cim/media-store";
import type { Deal } from "@shared/schema";
import { sellerLinkRights, OWNER_SIGNS_OFF_MESSAGE, type SellerLinkRights } from "@shared/seller-link-rights";

const STAGE_WORD: Record<SellerReviewStage, string> = {
  not_ready: "",
  content: "content",
  design: "design",
  waiting: "",
  approved: "",
};

/**
 * The seller's invite + deal + what this link may do, or null (unknown /
 * revoked token). Every seller-team member has their own link, so the
 * sign-off is checked against who holds it (shared/seller-link-rights.ts).
 */
async function sellerDeal(token: string): Promise<{ deal: Deal; inviteId: string; sellerName: string | null; rights: SellerLinkRights } | null> {
  const invite = await storage.getSellerInviteByToken(token);
  if (!invite) return null;
  const deal = await storage.getDeal(invite.dealId);
  if (!deal) return null;
  const rights = sellerLinkRights(invite, await storage.getDealMembers(deal.id));
  return { deal, inviteId: invite.id, sellerName: invite.sellerName ?? null, rights };
}

/**
 * The deal's own broker previewing the seller's link: they never give the
 * seller's approval by accident — the Overview has the labelled override.
 */
async function isOwningBroker(req: Request, deal: Deal): Promise<boolean> {
  return !!req.session?.brokerId && !!(await getOwnedDeal(deal.id, req.session.brokerId));
}

const sellerReviewLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });

export function registerSellerReviewRoutes(app: Express) {
  // ── Seller: the CIM to review ─────────────────────────────────────────
  app.get("/api/seller/:token/cim-review", async (req: Request, res: Response) => {
    try {
      const found = await sellerDeal(req.params.token);
      if (!found) return res.status(404).json({ error: "This link isn't valid any more — ask your broker for a new one." });
      const { deal, rights } = found;
      const stage = sellerReviewStage(deal);
      const base = {
        stage,
        businessName: deal.businessName,
        approvals: { content: !!deal.contentApprovedBySeller, design: !!deal.designApprovedBySeller },
        previewByBroker: await isOwningBroker(req, deal),
        // Only the owner's link approves or asks for changes (an accountant's
        // or attorney's link can read it).
        canApprove: rights.canApproveCim,
      };
      // Nothing before the broker has approved it, and nothing while a
      // regenerated CIM waits for the broker's review.
      if (stage === "not_ready" || cimHeldFromBuyers(deal)) {
        return res.json({ ...base, stage: "not_ready", sections: [], design: null });
      }
      const [sections, media] = await Promise.all([storage.getCimSectionsByDeal(deal.id), loadMediaAssets(deal.id)]);
      // The named CIM exactly as an LOI buyer would get it (hidden sections,
      // failed placeholders and AI notes never included).
      const cim = buildBuyerCim({ deal, accessLevel: "loi", sections, overrides: [], media, askingPrice: listedAskingPrice(deal) });
      const { designPayload } = await import("../cim/templates");
      const design = await designPayload(deal, "normal");
      const openRequests = (await storage.getTasksByDeal(deal.id)).filter(
        (t) => t.createdBy === SELLER_REVIEW_TASK_CREATOR && isOpenTask(t),
      );
      // dd: what buyers read about the figures in the owner's words (D22).
      const { sellerFigureNotes } = await import("../cim/figures/seller");
      const figureNotes = await sellerFigureNotes(deal, cim.sections);
      res.json({
        ...base,
        sections: cim.sections,
        design,
        changesRequested: openRequests.map((t) => ({ id: t.id, note: t.description ?? "", at: t.createdAt })),
        figureNotes,
      });
    } catch (err) {
      console.error("[seller-review] load failed:", err);
      res.status(500).json({ error: "Couldn't load your CIM" });
    }
  });

  // ── Seller: approve the stage they were sent ──────────────────────────
  app.post("/api/seller/:token/cim-review/approve", sellerReviewLimiter, async (req: Request, res: Response) => {
    try {
      const found = await sellerDeal(req.params.token);
      if (!found) return res.status(404).json({ error: "This link isn't valid any more — ask your broker for a new one." });
      const { deal, rights } = found;
      if (await isOwningBroker(req, deal)) {
        return res.status(403).json({ error: "You're signed in as the deal's broker. To record the seller's approval yourself, use “Approve on the seller's behalf” on the deal's Overview.", code: "broker_preview" });
      }
      if (!rights.canApproveCim) {
        return res.status(403).json({ error: OWNER_SIGNS_OFF_MESSAGE, code: "not_owner" });
      }
      const stage = sellerReviewStage(deal);
      const field = sellerApprovalField(stage);
      // The stage the seller was looking at must still be the one open (the
      // broker may have regenerated or re-approved in between).
      if (!field || (req.body?.stage && req.body.stage !== stage)) {
        return res.status(409).json({ error: "This CIM changed since you opened it — reload to see the latest version.", stage });
      }
      // The same gate as every approval: an unresolved critical conflict first.
      const blocking = (await storage.getDiscrepanciesByDeal(deal.id)).filter((d) => discrepancyBlocksCim(d, deal.interviewCompleted));
      if (blocking.length > 0) {
        const theirs = blocking.every((d) => d.status === "ask_seller");
        return res.status(409).json({
          error: theirs
            ? "Your broker has a follow-up question for you first — answer it from your progress page, then approve."
            : "Your broker is still checking a few facts in this CIM. They'll send it back to you once that's done.",
          code: theirs ? "follow_up_questions" : "discrepancies",
        });
      }
      await storage.updateDeal(deal.id, { [field]: true } as any);
      // Their earlier change requests for this CIM are settled by the approval.
      const open = (await storage.getTasksByDeal(deal.id)).filter((t) => t.createdBy === SELLER_REVIEW_TASK_CREATOR && isOpenTask(t));
      await Promise.all(open.map((t) => storage.updateTask(t.id, { status: "completed", completedAt: new Date() } as any)));
      const { notify } = await import("../notifications/service");
      notify(deal.id, "cim_seller_approved", {
        title: `The seller approved the CIM ${STAGE_WORD[stage]} — ${deal.businessName}`,
        body: stage === "design"
          ? "The seller signed off the CIM's design. It's ready to publish once every section is approved."
          : "The seller approved the CIM content. You can move the deal to Design.",
        actionUrl: `/deal/${deal.id}/overview`,
        businessName: deal.businessName,
        metadata: { stage },
      }).catch((e) => console.warn("[seller-review] broker email failed:", e));
      res.json({ ok: true, stage: sellerReviewStage({ ...deal, [field]: true }) });
    } catch (err) {
      console.error("[seller-review] approve failed:", err);
      res.status(500).json({ error: "Couldn't record your approval" });
    }
  });

  // ── Seller: ask for changes ───────────────────────────────────────────
  app.post("/api/seller/:token/cim-review/request-changes", sellerReviewLimiter, async (req: Request, res: Response) => {
    try {
      const found = await sellerDeal(req.params.token);
      if (!found) return res.status(404).json({ error: "This link isn't valid any more — ask your broker for a new one." });
      const { deal, sellerName, rights } = found;
      if (await isOwningBroker(req, deal)) {
        return res.status(403).json({ error: "You're signed in as the deal's broker — this is the seller's button.", code: "broker_preview" });
      }
      if (!rights.canApproveCim) {
        return res.status(403).json({ error: OWNER_SIGNS_OFF_MESSAGE, code: "not_owner" });
      }
      const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 4000) : "";
      if (note.length < 3) return res.status(400).json({ error: "Tell your broker what should change." });
      const stage = sellerReviewStage(deal);
      if (stage !== "content" && stage !== "design") {
        return res.status(409).json({ error: "There's nothing waiting for your review right now.", stage });
      }
      const who = sellerName?.trim() || "The seller";
      const task = await storage.createTask({
        dealId: deal.id,
        createdBy: SELLER_REVIEW_TASK_CREATOR,
        assignedTo: deal.brokerId || null,
        type: "follow_up",
        title: `${who} asked for changes to the CIM ${STAGE_WORD[stage]}`,
        description: note,
        relatedField: null,
        status: "pending",
        priority: "high",
        aiAttempts: 0,
        aiExplanation: null,
      } as any);
      const { notify } = await import("../notifications/service");
      const { escapeHtml } = await import("../notifications/email-escape");
      notify(deal.id, "cim_changes_requested", {
        title: `The seller asked for changes to the CIM — ${deal.businessName}`,
        body: `${escapeHtml(who)} wrote: “${escapeHtml(note.slice(0, 1200))}”`,
        actionUrl: `/deal/${deal.id}/overview`,
        businessName: deal.businessName,
        metadata: { stage, taskId: task.id },
      }).catch((e) => console.warn("[seller-review] broker email failed:", e));
      res.json({ ok: true, taskId: task.id });
    } catch (err) {
      console.error("[seller-review] request-changes failed:", err);
      res.status(500).json({ error: "Couldn't send your note" });
    }
  });

  // ── Seller (owner): "Change this" on a note about the figures (dd, D22) ──
  app.post("/api/seller/:token/cim-review/figure-notes/:noteId/flag", sellerReviewLimiter, async (req: Request, res: Response) => {
    try {
      const found = await sellerDeal(req.params.token);
      if (!found) return res.status(404).json({ error: "This link isn't valid any more — ask your broker for a new one." });
      const { deal, sellerName, rights } = found;
      if (await isOwningBroker(req, deal)) {
        return res.status(403).json({ error: "You're signed in as the deal's broker — this is the seller's button.", code: "broker_preview" });
      }
      if (!rights.canApproveCim) {
        return res.status(403).json({ error: OWNER_SIGNS_OFF_MESSAGE, code: "not_owner" });
      }
      const comment = typeof req.body?.comment === "string" ? req.body.comment.trim() : "";
      if (comment.length < 1) return res.status(400).json({ error: "Tell your broker what should change." });
      if (comment.length > 500) return res.status(400).json({ error: "Please keep it to 500 characters." });
      // Only a note this link can see (approved, quoting the owner, served on
      // the CIM the seller reviews) — another deal's or a hidden note is a 404.
      if (sellerReviewStage(deal) === "not_ready" || cimHeldFromBuyers(deal)) {
        return res.status(404).json({ error: "That note isn't shown any more." });
      }
      const sections = await storage.getCimSectionsByDeal(deal.id);
      const { levelServing } = await import("../cim/figures/served");
      const cim = buildBuyerCim({ deal, accessLevel: levelServing("normal"), sections, overrides: [], media: [], askingPrice: listedAskingPrice(deal) });
      const { flagSellerFigureNote } = await import("../cim/figures/seller");
      const note = await flagSellerFigureNote(deal, cim.sections, String(req.params.noteId), comment);
      if (!note) return res.status(404).json({ error: "That note isn't shown any more." });
      const who = sellerName?.trim() || "The owner";
      const { notify } = await import("../notifications/service");
      const { escapeHtml } = await import("../notifications/email-escape");
      notify(deal.id, "cim_changes_requested", {
        title: `The owner asked for a change to a note on the CIM's figures — ${deal.businessName}`,
        body: `${escapeHtml(who)} wrote about ${escapeHtml(note.label)}: “${escapeHtml(comment)}”. Buyers don't see that note until you look at it.`,
        actionUrl: `/deal/${deal.id}/cim?view=numbers&tab=moves&filter=look&note=${encodeURIComponent(note.id)}`,
        businessName: deal.businessName,
        metadata: { kind: "figure_note", noteId: note.id },
      }).catch((e) => console.warn("[seller-review] broker notice failed:", e));
      res.json({ ok: true });
    } catch (err) {
      console.error("[seller-review] figure note flag failed:", err);
      res.status(500).json({ error: "Couldn't send your note" });
    }
  });

  // ── Broker: send it to the seller ─────────────────────────────────────
  app.post("/api/deals/:dealId/seller-review/send", requireBroker, requireOwnedDeal, sellerReviewLimiter, async (req: Request, res: Response) => {
    try {
      const deal = res.locals.deal as Deal;
      const stage = sellerReviewStage(deal);
      if (stage !== "content" && stage !== "design") {
        return res.status(409).json({
          error: stage === "not_ready" ? "Approve the CIM yourself first — the seller reviews what you've approved." : "The seller has nothing waiting for review.",
          stage,
        });
      }
      const { notifySellerPortal } = await import("../notifications/service");
      const result = await notifySellerPortal(deal.id, "cim_ready", {
        title: stage === "design" ? "Your CIM is ready for your sign-off" : "Your CIM is ready for your review",
        body:
          (stage === "design"
            ? "Your broker has finished the design of your CIM. "
            : "Your broker has drafted your CIM — the document buyers will read about your business. ") +
          "Please read it and approve it, or tell your broker what should change. Nothing goes to buyers until you've signed off.",
        path: "review",
        businessName: deal.businessName,
        metadata: { stage },
      });
      res.json({ ok: true, stage, ...result });
    } catch (err) {
      console.error("[seller-review] send failed:", err);
      res.status(500).json({ error: "Couldn't send the CIM to the seller" });
    }
  });

  // ── Broker: where the seller's review stands ──────────────────────────
  app.get("/api/deals/:dealId/seller-review", requireBroker, requireOwnedDeal, async (_req: Request, res: Response) => {
    try {
      const deal = res.locals.deal as Deal;
      const stage = sellerReviewStage(deal);
      const sent = (await storage.getNotificationsByDeal(deal.id))
        .filter((n) => n.type === "cim_ready")
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      const changeRequests = (await storage.getTasksByDeal(deal.id))
        .filter((t) => t.createdBy === SELLER_REVIEW_TASK_CREATOR && isOpenTask(t))
        .map((t) => ({ id: t.id, title: t.title, note: t.description ?? "", at: t.createdAt }));
      res.json({
        stage,
        lastSentAt: sent[0]?.createdAt ?? null,
        lastSentStage: (sent[0]?.metadata as { stage?: string } | null)?.stage ?? null,
        changeRequests,
      });
    } catch (err) {
      console.error("[seller-review] status failed:", err);
      res.status(500).json({ error: "Couldn't load the seller's review" });
    }
  });
}
