/**
 * Buyer profile page: overlay edits, timeline, AI summary, email (workstream: buyers).
 * Registered from server/routes.ts (merge anchor) — keep this workstream's
 * new endpoints in this file.
 *
 * Every route: requireBroker + the buyer must be on THIS broker's list
 * (isBuyerInBrokerList), else 404 — a broker can never read or touch a buyer
 * they don't already know. Broker edits go to the broker-private overlay on
 * their own contact row; the buyer's global profile is never written here.
 */
import type { Express, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import {
  BUYER_INTEREST_STATUSES, BUYER_CRITERIA_FIELDS, buyerCriteriaSchema,
  type BrokerBuyerOverlay, type BrokerOverlayMeta, type BuyerAiSummary,
} from "@shared/schema";
import { blindIdentifiers } from "@shared/blind-identifiers";
import { requireBroker, getOwnedDeal } from "../broker-auth/routes.js";
import { storage } from "../storage";
import { sendDirectEmail } from "../notifications/service";
import {
  isBuyerInBrokerList, getContact, ensureContact, updateContact, recordBuyerEmail, getBuyerAccessOnBrokerDeals,
} from "../buyers/profile-data";
import { buildBuyerProfileView, buildBuyerTimeline, loadSummaryInput, mergedForBroker } from "../buyers/profile-view";
import { loadBrokerScope } from "../buyers/provenance-scope";
import { generateBuyerSummary, draftBuyerEmail, aiAvailable } from "../buyers/profile-ai";
import { blindDealSummary } from "../buyers/blind-deal-summary";
import { db } from "../db";
import { buyerUsers } from "@shared/schema";
import { and, eq } from "drizzle-orm";

const aiLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please slow down and try again shortly." },
});
const emailLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "You've sent a lot of emails in a short time. Please wait a few minutes." },
});

/** 404 unless the buyer is on the signed-in broker's list. */
async function requireListedBuyer(req: Request, res: Response): Promise<string | null> {
  const brokerId = req.session.brokerId!;
  const buyerId = req.params.id;
  if (!(await isBuyerInBrokerList(brokerId, buyerId))) {
    res.status(404).json({ error: "Buyer not found" });
    return null;
  }
  return buyerId;
}

const FIELD_LABELS: Record<string, string> = {
  name: "Name", phone: "Phone", company: "Company", title: "Title", linkedinUrl: "LinkedIn", buyerType: "Buyer type",
  background: "Background", liquidFunds: "Liquid funds", hasProofOfFunds: "Proof of funds",
  targetIndustries: "Target industries", targetLocations: "Target locations",
};

const text = (max: number) => z.string().trim().max(max).nullable();
const tagArray = z.array(z.string().trim().min(1).max(120)).max(40).nullable();
// Every key optional; `null` reverts that field to what the buyer / CRM says.
const overlayPatchSchema = z.object({
  name: text(160),
  phone: text(60),
  company: text(200),
  title: text(160),
  linkedinUrl: text(300),
  buyerType: text(40),
  background: text(4000),
  liquidFunds: text(80),
  hasProofOfFunds: z.boolean().nullable(),
  targetIndustries: tagArray,
  targetLocations: tagArray,
  buyerCriteria: buyerCriteriaSchema,
}).partial().strict();

const emailBody = z.object({
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(10000),
  dealId: z.string().trim().min(1).nullable().optional(),
});

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Plain-text broker email → simple, escaped HTML. */
export function brokerEmailHtml(body: string, footer: string): string {
  const paras = body.replace(/\r\n/g, "\n").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
    .map((p) => `<p style="margin:0 0 16px 0;color:#333;font-size:14px;line-height:1.6;">${escapeHtml(p).replace(/\n/g, "<br/>")}</p>`)
    .join("");
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:24px;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#fff;padding:32px 28px;border-radius:8px;border:1px solid #e5e5e5;">
    ${paras}
  </div>
  <p style="text-align:center;color:#999;font-size:11px;margin-top:16px;">${escapeHtml(footer)}</p>
</body>
</html>`;
}

export function registerBuyerProfileRoutes(app: Express): void {
  // ── Full profile ──────────────────────────────────────────────────
  app.get("/api/broker/buyers/:id/profile", requireBroker, async (req, res) => {
    try {
      if (!(await requireListedBuyer(req, res))) return;
      const view = await buildBuyerProfileView(req.session.brokerId!, req.params.id);
      if (!view) return res.status(404).json({ error: "Buyer not found" });
      res.json(view);
    } catch (err) {
      console.error("[buyer-profile] load failed:", err);
      res.status(500).json({ error: "Couldn't load this buyer" });
    }
  });

  // ── Broker edits (private overlay) ────────────────────────────────
  app.patch("/api/broker/buyers/:id/profile", requireBroker, async (req, res) => {
    try {
      if (!(await requireListedBuyer(req, res))) return;
      const brokerId = req.session.brokerId!;
      const patch = overlayPatchSchema.parse(req.body ?? {});
      if (patch.name !== undefined && patch.name !== null && !patch.name) {
        return res.status(400).json({ error: "A buyer needs a name — clear it with “Revert” instead." });
      }
      const contact = await ensureContact(brokerId, req.params.id);
      const overlay: BrokerBuyerOverlay = { ...((contact.brokerProfile as BrokerBuyerOverlay | null) ?? {}) };
      const meta: BrokerOverlayMeta = { ...((contact.brokerProfileMeta as BrokerOverlayMeta | null) ?? {}) };
      const now = new Date().toISOString();

      for (const [k, v] of Object.entries(patch)) {
        if (k === "buyerCriteria") continue;
        if (v === undefined) continue;
        if (v === null) { delete (overlay as any)[k]; delete meta[k]; }
        else { (overlay as any)[k] = v; meta[k] = { at: now }; }
      }
      if (patch.buyerCriteria) {
        const crit: Record<string, any> = { ...(overlay.buyerCriteria ?? {}) };
        const raw = (req.body?.buyerCriteria ?? {}) as Record<string, unknown>;
        for (const k of Object.keys(raw)) {
          if (!(k in patch.buyerCriteria)) continue;            // unknown key — stripped by the schema
          const v = (patch.buyerCriteria as Record<string, any>)[k];
          const key = `criteria.${k}`;
          if (v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) { delete crit[k]; delete meta[key]; }
          else { crit[k] = v; meta[key] = { at: now }; }
        }
        if (Object.keys(crit).length) overlay.buyerCriteria = crit; else delete overlay.buyerCriteria;
      }

      await updateContact(contact.id, { brokerProfile: overlay as any, brokerProfileMeta: meta as any });
      const view = await buildBuyerProfileView(brokerId, req.params.id);
      res.json(view);
    } catch (err: any) {
      if (err?.name === "ZodError") {
        const issue = err.errors?.[0];
        const key = issue?.path?.[issue.path.length - 1];
        const label = typeof key === "string" ? (BUYER_CRITERIA_FIELDS[key]?.label ?? FIELD_LABELS[key] ?? key) : null;
        const why = issue?.code === "too_big" ? "is too long" : issue?.code === "unrecognized_keys" ? "can't be edited here" : "isn't a valid value";
        return res.status(400).json({ error: label ? `${label} ${why}` : "Some of those values aren't valid", details: err.errors });
      }
      console.error("[buyer-profile] overlay save failed:", err);
      res.status(500).json({ error: "Couldn't save your changes" });
    }
  });

  // ── Tags, notes, interest ─────────────────────────────────────────
  app.patch("/api/broker/buyers/:id/contact", requireBroker, async (req, res) => {
    try {
      if (!(await requireListedBuyer(req, res))) return;
      const body = z.object({
        tags: z.array(z.string().trim().min(1).max(60)).max(40).optional(),
        notes: z.string().max(10000).nullable().optional(),
        interestStatus: z.enum(BUYER_INTEREST_STATUSES).nullable().optional(),
      }).strict().parse(req.body ?? {});
      const contact = await ensureContact(req.session.brokerId!, req.params.id);
      const updated = await updateContact(contact.id, {
        ...(body.tags !== undefined ? { tags: Array.from(new Set(body.tags)) as any } : {}),
        ...(body.notes !== undefined ? { notes: body.notes?.trim() ? body.notes : null } : {}),
        ...(body.interestStatus !== undefined ? { interestStatus: body.interestStatus } : {}),
      });
      res.json({ tags: updated?.tags ?? [], notes: updated?.notes ?? null, interestStatus: updated?.interestStatus ?? null });
    } catch (err: any) {
      if (err?.name === "ZodError") return res.status(400).json({ error: "Invalid update", details: err.errors });
      console.error("[buyer-profile] contact save failed:", err);
      res.status(500).json({ error: "Couldn't save" });
    }
  });

  // ── Remove from my list (contact row only — the buyer's account stays) ──
  app.delete("/api/broker/buyers/:id", requireBroker, async (req, res) => {
    try {
      if (!(await requireListedBuyer(req, res))) return;
      const brokerId = req.session.brokerId!;
      const buyer = await storage.getBuyerUser(req.params.id);
      if (!buyer) return res.status(404).json({ error: "Buyer not found" });
      const contact = await getContact(brokerId, buyer.id);
      if (contact) await storage.deleteBrokerBuyerContact(contact.id);
      // "Invited by this broker" also puts a buyer on the list — that marker is
      // this broker's, so clearing it is part of removing them.
      if (buyer.invitedByBroker === brokerId) {
        await db.update(buyerUsers).set({ invitedByBroker: null }).where(and(eq(buyerUsers.id, buyer.id), eq(buyerUsers.invitedByBroker, brokerId)));
      }
      // Buyers with access to one of this broker's deals stay listed (their
      // activity is on the broker's deals) until that access is revoked.
      const stillListed = await isBuyerInBrokerList(brokerId, buyer.id);
      res.json({ removed: true, stillListed, reason: stillListed ? "They still have access to one of your deals. Revoke it on the deal's Buyers tab to remove them completely." : null });
    } catch (err) {
      console.error("[buyer-profile] remove failed:", err);
      res.status(500).json({ error: "Couldn't remove this buyer" });
    }
  });

  // ── Timeline ──────────────────────────────────────────────────────
  app.get("/api/broker/buyers/:id/timeline", requireBroker, async (req, res) => {
    try {
      if (!(await requireListedBuyer(req, res))) return;
      const events = await buildBuyerTimeline(req.session.brokerId!, req.params.id);
      if (!events) return res.status(404).json({ error: "Buyer not found" });
      res.json({ events });
    } catch (err) {
      console.error("[buyer-profile] timeline failed:", err);
      res.status(500).json({ error: "Couldn't load the activity" });
    }
  });

  // ── AI summary (cached against a fingerprint of what it reads) ─────
  app.post("/api/broker/buyers/:id/ai-summary", requireBroker, aiLimiter, async (req, res) => {
    try {
      if (!(await requireListedBuyer(req, res))) return;
      const brokerId = req.session.brokerId!;
      const loaded = await loadSummaryInput(brokerId, req.params.id);
      if (!loaded) return res.status(404).json({ error: "Buyer not found" });
      const contact = loaded.ctx.contact;
      const cached = (contact?.aiSummary as BuyerAiSummary | null) ?? null;
      if (cached && cached.key === loaded.key && req.body?.force !== true) {
        return res.json({ text: cached.text, at: cached.at, stale: false, cached: true });
      }
      if (!aiAvailable()) return res.status(503).json({ error: "AI is unavailable right now" });
      const text = await generateBuyerSummary(loaded.input);
      if (!text) return res.status(502).json({ error: "The summary didn't come back — try again" });
      const summary: BuyerAiSummary = { text, at: new Date().toISOString(), key: loaded.key };
      const c = contact ?? (await ensureContact(brokerId, req.params.id));
      await updateContact(c.id, { aiSummary: summary as any });
      res.json({ text, at: summary.at, stale: false, cached: false });
    } catch (err) {
      console.error("[buyer-profile] AI summary failed:", err);
      res.status(500).json({ error: "Couldn't write the summary" });
    }
  });

  // ── Email: AI draft (broker edits, then sends) ─────────────────────
  app.post("/api/broker/buyers/:id/email/draft", requireBroker, aiLimiter, async (req, res) => {
    try {
      if (!(await requireListedBuyer(req, res))) return;
      const brokerId = req.session.brokerId!;
      const body = z.object({
        dealId: z.string().trim().min(1).nullable().optional(),
        instructions: z.string().max(2000).nullable().optional(),
      }).parse(req.body ?? {});
      const buyer = await storage.getBuyerUser(req.params.id);
      if (!buyer) return res.status(404).json({ error: "Buyer not found" });
      const deal = body.dealId ? await getOwnedDeal(body.dealId, brokerId) : null;
      if (body.dealId && !deal) return res.status(404).json({ error: "Deal not found" });

      const [contact, scope] = await Promise.all([getContact(brokerId, buyer.id), loadBrokerScope(brokerId)]);
      const { display } = mergedForBroker(buyer, contact, scope);
      const [brokerUser, branding] = await Promise.all([storage.getUser(brokerId), storage.getBrandingByBroker(brokerId)]);
      let dealContext: { hasAccess: boolean; ndaSigned: boolean; decision: string | null } | null = null;
      if (deal) {
        const access = (await getBuyerAccessOnBrokerDeals([deal.id], buyer))[0];
        dealContext = { hasAccess: !!access && !access.revokedAt, ndaSigned: !!access?.ndaSignedAt, decision: access?.decision && access.decision !== "under_review" ? access.decision : null };
      }
      const criteria = (display.buyerCriteria as Record<string, any>) || {};
      const draft = await draftBuyerEmail({
        brokerName: brokerUser?.name || brokerUser?.username || "Your broker",
        brokerCompany: (branding as any)?.companyName || null,
        buyer: {
          firstName: (display.name || buyer.email).split(/\s+/)[0],
          company: display.company ?? null,
          buyerType: display.buyerType ?? null,
          targetIndustries: (display.targetIndustries as string[]) ?? [],
          targetLocations: (display.targetLocations as string[]) ?? [],
          lookingFor: typeof criteria.lookingFor === "string" ? criteria.lookingFor.slice(0, 600) : null,
        },
        deal: deal ? blindDealSummary(deal) : null,
        dealContext,
        instructions: body.instructions ?? null,
        forbidden: deal ? blindIdentifiers(deal as any) : [],
      });
      res.json({ ...draft, to: buyer.email, replyTo: brokerUser?.email ?? null, blindSafe: !!deal });
    } catch (err: any) {
      if (err?.name === "ZodError") return res.status(400).json({ error: "Invalid request" });
      console.error("[buyer-profile] draft failed:", err);
      res.status(500).json({ error: "Couldn't draft the email" });
    }
  });

  // ── Email: send (only ever when the broker clicks Send) ────────────
  app.post("/api/broker/buyers/:id/email", requireBroker, emailLimiter, async (req, res) => {
    try {
      if (!(await requireListedBuyer(req, res))) return;
      const brokerId = req.session.brokerId!;
      const body = emailBody.parse(req.body ?? {});
      const buyer = await storage.getBuyerUser(req.params.id);
      if (!buyer) return res.status(404).json({ error: "Buyer not found" });
      if (body.dealId && !(await getOwnedDeal(body.dealId, brokerId))) return res.status(404).json({ error: "Deal not found" });
      const [brokerUser, branding] = await Promise.all([storage.getUser(brokerId), storage.getBrandingByBroker(brokerId)]);
      const brokerName = brokerUser?.name || brokerUser?.username || null;
      const company = (branding as any)?.companyName || null;
      const replyTo = brokerUser?.email && brokerUser.email.includes("@") ? brokerUser.email : null;
      const html = brokerEmailHtml(body.body, `Sent via Cimple on behalf of ${company || brokerName || "your broker"}`);

      const sent = await sendDirectEmail(buyer.email, body.subject, html, undefined, {
        replyTo,
        fromName: brokerName ? `${brokerName} via Cimple` : null,
      });
      const record = await recordBuyerEmail({
        brokerId, buyerUserId: buyer.id, dealId: body.dealId ?? null, toEmail: buyer.email, replyTo,
        subject: body.subject, body: body.body, status: sent ? "sent" : "failed",
        errorMessage: sent ? null : process.env.RESEND_API_KEY ? "The email provider didn't accept it" : "Email isn't set up on this server — nothing was sent",
        sentAt: sent ? new Date() : null,
      });
      // 200 either way: the attempt is recorded; the page shows "not delivered" + why.
      res.json({ id: record.id, status: record.status, error: record.errorMessage });
    } catch (err: any) {
      if (err?.name === "ZodError") return res.status(400).json({ error: "A subject and a message are required" });
      console.error("[buyer-profile] send failed:", err);
      res.status(500).json({ error: "Couldn't send the email" });
    }
  });
}
