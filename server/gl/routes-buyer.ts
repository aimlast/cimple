/**
 * The buyers' route of "Add-backs in the books" (gl spec §6.7, P2): "Ask
 * about this entry" on the due-diligence page — a private question to the
 * broker about one add-back or one of its ledger entries.
 *
 *   POST /api/view/:token/gl/question { lineId, rowNo?, text ≤ 1,000 }
 *
 * The view room's own gates (a valid link, the CIM published, the NDA
 * signed), then due diligence only. The question names the entry as the
 * buyer was shown it (date, amount, account, row — never a withheld name)
 * and goes to the broker as a private question (buyer_questions, status
 * pending_broker, answer scope "private"). No AI. 20 an hour per link
 * (server/routes/gl.ts applyGlRateLimits).
 */
import type { Express } from "express";
import { storage } from "../storage";
import { viewLinkError, viewLinkProblem } from "../buyers/view-access";
import { dealPublishedForBuyers, notPublishedBody } from "@shared/buyer-publish-gate";
import { ndaBlocksBuyer } from "@shared/cim-buyer-view";
import { formatDay } from "@shared/gl-copy";
import { glEvidenceForBuyer } from "./evidence";
import { cimModeForAccessLevel, isTeaserOnly } from "./levels";
import { refuseUnknownKeys } from "./routes-broker";

export const GL_QUESTION_MAX = 1000;

const money = (d: number) => `${d < 0 ? "−" : ""}$${Math.abs(d).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function registerGlBuyerRoutes(app: Express): void {
  app.post("/api/view/:token/gl/question", async (req, res) => {
    try {
      const bad = refuseUnknownKeys(req.body, ["lineId", "rowNo", "text"]);
      if (bad) return res.status(400).json({ error: bad });
      const lineId = typeof req.body?.lineId === "string" && /^[0-9a-f]{12}$/.test(req.body.lineId) ? req.body.lineId : null;
      const rowNo = req.body?.rowNo === undefined || req.body?.rowNo === null ? null : Number(req.body.rowNo);
      const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
      if (!lineId || (rowNo !== null && (!Number.isInteger(rowNo) || rowNo < 1))) return res.status(400).json({ error: "That entry couldn't be found." });
      if (text.length < 3) return res.status(400).json({ error: "Write your question first." });
      if (text.length > GL_QUESTION_MAX) return res.status(400).json({ error: `Please keep your question under ${GL_QUESTION_MAX.toLocaleString("en-US")} characters.` });

      const access = await storage.getBuyerAccessByToken(String(req.params.token));
      const problem = viewLinkProblem(access);
      if (problem || !access) { const e = viewLinkError(problem ?? "not_found"); return res.status(e.status).json({ error: e.error }); }
      const deal = await storage.getDeal(access.dealId);
      if (!deal) return res.status(404).json({ error: "Access denied or link expired" });
      if (!dealPublishedForBuyers(deal)) return res.status(403).json(notPublishedBody());
      if (ndaBlocksBuyer(deal, access)) return res.status(403).json({ error: "Sign the NDA to ask questions about this business", code: "nda_required" });
      if (isTeaserOnly(access.accessLevel) || cimModeForAccessLevel(access.accessLevel) !== "dd") {
        return res.status(403).json({ error: "Questions about ledger entries are for due-diligence buyers." });
      }

      // The entry as THIS buyer was shown it (masked, tightened now).
      const ev = await glEvidenceForBuyer(deal.id, access.accessLevel, access.id);
      const line = ev?.lines.find((l) => l.lineId === lineId);
      if (!ev || !line) return res.status(404).json({ error: "That entry couldn't be found." });
      let about = `About the add-back "${line.label ?? "an add-back"}"`;
      if (rowNo !== null) {
        const entry = (line.years ?? []).flatMap((y) => y.entries).find((e) => e.rowNo === rowNo);
        if (!entry) return res.status(404).json({ error: "That entry couldn't be found." });
        about = `About the ledger entry of ${formatDay(entry.date) || entry.date}, ${money(entry.amount)} in ${entry.account} (row ${rowNo})`;
      }
      const question = `${about}: ${text}`;
      const saved = await storage.createBuyerQuestion({
        dealId: deal.id,
        buyerAccessId: access.id,
        question,
        aiAnswer: null,
        status: "pending_broker",
        isPublished: false,
        publishedAnswer: null,
        addedToKnowledgeBase: false,
        answerScope: "private",
        sectionId: ev.pageId,
      } as any);
      const { notify } = await import("../notifications/service");
      const { escapeHtml } = await import("../notifications/email-escape");
      notify(deal.id, "buyer_question", {
        title: "A due-diligence buyer asked about an add-back",
        body: `A buyer asked: &ldquo;${escapeHtml(question.slice(0, 160))}${question.length > 160 ? "..." : ""}&rdquo;`,
        actionUrl: `/deal/${deal.id}`,
        businessName: deal.businessName,
      }).catch(() => undefined);
      res.json({ ok: true, id: saved.id, message: "Sent to your broker. Their answer will appear with your questions." });
    } catch (err) {
      console.error("[gl] buyer question failed:", err);
      res.status(500).json({ error: "Your question couldn't be sent — try again." });
    }
  });
}
