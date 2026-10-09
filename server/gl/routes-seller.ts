/**
 * The seller's routes of "Add-backs in the books" (gl spec §6.7), pass 2:
 * /seller/:token/books — the costs, the entries Cimple found, ticking,
 * searching, "Yes, that's right", a T4 or invoice instead, notes, "This
 * isn't in my ledger", the broker's question, other costs, the accountant
 * hand-off, "Email me this link", "I can't get my ledger" and sending it
 * back to the broker with the seller's confirmation.
 *
 * Every handler: token → invite → deal → sellerLinkRights(...).canTraceAddbacks
 * (owner or accountant; the attorney and representative get 403); every
 * write refuses a broker previewing the seller's page (409, nothing saved);
 * only ledgers the seller may see; only costs the broker sent and hasn't
 * removed; nothing about costs before the request or after it was withdrawn.
 * Seller actions never call the AI.
 */
import type { Express, NextFunction, Request, Response } from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { storage } from "../storage";
import { isDealOwnerSession } from "../broker-auth/routes";
import { sellerLinkRights, OWNER_OR_ACCOUNTANT_MESSAGE } from "@shared/seller-link-rights";
import { TEAM_ROLES, type Deal, type GlAddbackTrace, type GlTracing, type SellerInvite, type DealMember } from "@shared/schema";
import type { GlSellerSuggestion } from "@shared/gl-types";
import { newDocumentFileName } from "../documents/document-path";
import { glStore } from "./store";
import { loadGlContext, sellerReconcileCtx } from "./context";
import { sellerBooksView, sellerEntry, sellerVisibleTraces } from "./seller-view";
import { parseLinkWrite, writeLinks, confirmSummary } from "./links";
import { parseSupportAmounts } from "./support-docs";
import { recomputeTraces } from "./match-run";
import { notifyBroker, emailSellerTheirLink } from "./notify";
import { parseMoneyToCents } from "./text";
import { refuseUnknownKeys } from "./routes-broker";

export const PREVIEW_MESSAGE = "You're previewing the seller's page — nothing is saved.";

export interface SellerCaller {
  invite: SellerInvite;
  deal: Deal;
  members: DealMember[];
  role: string;
  memberId: string | null;
  preview: boolean;
}

/** The seller link's right to this step (owner or accountant), or the answer that refuses it. */
export async function sellerCaller(req: Request, res: Response, opts: { write?: boolean } = {}): Promise<SellerCaller | null> {
  const invite = await storage.getSellerInviteByToken(String(req.params.token ?? ""));
  if (!invite) {
    res.status(404).json({ error: "This link isn't valid any more." });
    return null;
  }
  const deal = await storage.getDeal(invite.dealId);
  if (!deal) {
    res.status(404).json({ error: "This link isn't valid any more." });
    return null;
  }
  const members = await storage.getDealMembers(invite.dealId);
  const rights = sellerLinkRights(invite, members);
  if (!rights.canTraceAddbacks) {
    res.status(403).json({ error: OWNER_OR_ACCOUNTANT_MESSAGE, code: "not_owner_or_accountant" });
    return null;
  }
  const preview = await isDealOwnerSession(req, invite.dealId);
  if (opts.write && preview) {
    res.status(409).json({ error: PREVIEW_MESSAGE, code: "preview" });
    return null;
  }
  return { invite, deal, members, role: rights.role, memberId: rights.memberId, preview };
}

/** A cost the seller may work on: sent, not removed, the request open. */
async function sellerTrace(req: Request, res: Response, caller: SellerCaller): Promise<{ trace: GlAddbackTrace; tracing: GlTracing } | null> {
  const store = glStore();
  const tracing = await store.getTracing(caller.deal.id);
  const t = await store.getTrace(String(req.params.traceId ?? req.query.trace ?? ""));
  if (!tracing?.requestedAt || tracing.withdrawnAt || !t || t.dealId !== caller.deal.id || !sellerVisibleTraces([t]).length) {
    res.status(404).json({ error: "That cost isn't on your list any more." });
    return null;
  }
  return { trace: t, tracing };
}

const utcDay = () => new Date().toISOString().slice(0, 10);
const fail = (res: Response, what: string) => (err: unknown) => {
  console.error(`[gl] seller ${what} failed:`, err);
  if (!res.headersSent) res.status(500).json({ error: `Couldn't ${what} — try again.` });
};

/** Per-deal, per-day counters on gl_tracing (seller notices; "Email me this link"). */
async function underDailyCap(dealId: string, key: "emailLinkSends" | "otherCosts" | "accountant", cap: number): Promise<boolean> {
  const store = glStore();
  const tracing = (await store.getTracing(dealId))!;
  const day = utcDay();
  if (key === "emailLinkSends") {
    const cur = tracing.emailLinkSends as { day: string; count: number } | null;
    const count = cur?.day === day ? cur.count : 0;
    if (count >= cap) return false;
    await store.updateTracing(dealId, { emailLinkSends: { day, count: count + 1 } } as Partial<GlTracing>);
    return true;
  }
  // Other costs and accountant requests are counted from their own stored entries.
  if (key === "otherCosts") {
    const list = (tracing.sellerSuggestions as GlSellerSuggestion[] | null) ?? [];
    return list.filter((s) => s.at.slice(0, 10) === day).length < cap;
  }
  return true;
}

// ── Support documents (T4 slips, payroll summaries, invoices) ────────────

const SUPPORT_EXT = [".pdf", ".jpg", ".jpeg", ".png", ".xlsx", ".xls", ".csv"];
export const SUPPORT_MAX_BYTES = 15 * 1024 * 1024;
const uploadsDir = () => process.env.UPLOADS_DIR || path.join(process.cwd(), "public", "uploads");

function receiveSupportFile() {
  const mw = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => {
        const dir = path.join(uploadsDir(), "docs");
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (_req, file, cb) => cb(null, newDocumentFileName("doc", path.extname(file.originalname))),
    }),
    limits: { fileSize: SUPPORT_MAX_BYTES, files: 1 },
    fileFilter: (req, file, cb) => {
      const ok = SUPPORT_EXT.includes(path.extname(file.originalname).toLowerCase());
      if (!ok) (req as any).glRejected = true;
      cb(null, ok);
    },
  }).single("file");
  return (req: Request, res: Response, next: NextFunction) =>
    mw(req, res, (err: unknown) => {
      if (err) {
        if ((err as { code?: string }).code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "Documents can be up to 15 MB." });
        return res.status(400).json({ error: "Upload a PDF, a photo (JPG or PNG) or a spreadsheet." });
      }
      next();
    });
}

export function registerGlSellerRoutes(app: Express, opts: { supportGate: (req: Request, res: Response, next: NextFunction) => unknown }): void {
  // ── Reading ──
  app.get("/api/seller/:token/gl/entries", async (req, res) => {
    try {
      const caller = await sellerCaller(req, res);
      if (!caller) return;
      const found = await sellerTrace(req, res, caller);
      if (!found) return;
      const fy = typeof req.query.fy === "string" && /^\d{4}$/.test(req.query.fy) ? req.query.fy : null;
      const c = await loadGlContext(caller.deal.id);
      const links = (await glStore().linksOfTrace(found.trace.id)).filter((k) => (!fy || k.fiscalYear === fy));
      const docs = new Map(c.docs.map((d) => [d.id, d]));
      res.json({
        entries: links
          .filter((k) => k.ledgerId && c.sellerLedgerIds.has(k.ledgerId) && k.state !== "orphaned")
          .map((k) => ({
            ledgerId: k.ledgerId, rowNo: k.rowNo, fiscalYear: k.fiscalYear, date: k.txnDate, account: k.account, name: k.name, memo: k.memo,
            amountCents: k.amountCents, state: k.state, reason: k.reason, confidence: k.confidence, mine: k.proposedBy === "seller_search",
          })),
        documents: links
          .filter((k) => k.documentId && c.sellerDocIds.has(k.documentId))
          .map((k) => ({ documentId: k.documentId, fiscalYear: k.fiscalYear, amountCents: k.amountCents, check: k.docAmountCheck, name: docs.get(k.documentId!)?.originalName || docs.get(k.documentId!)?.name || "Document" })),
      });
    } catch (err) {
      fail(res, "load the entries")(err);
    }
  });

  app.get("/api/seller/:token/gl/search", async (req, res) => {
    try {
      const caller = await sellerCaller(req, res);
      if (!caller) return;
      const q = (k: string) => (typeof req.query[k] === "string" ? String(req.query[k]) : "");
      const min = q("min") ? parseMoneyToCents(q("min")) : null;
      const max = q("max") ? parseMoneyToCents(q("max")) : null;
      if ((q("min") && min === null) || (q("max") && max === null)) return res.status(400).json({ error: "Type amounts as numbers, like 1150 or 1,150.00." });
      const store = glStore();
      const tracing = await store.getTracing(caller.deal.id);
      if (!tracing?.requestedAt || tracing.withdrawnAt) return res.json({ rows: [] });
      const c = await loadGlContext(caller.deal.id);
      // Only the years the broker asked about.
      const years = new Set<string>();
      for (const t of sellerVisibleTraces(await store.listTraces(caller.deal.id))) for (const y of Object.keys((t.claims as Record<string, number>) ?? {})) years.add(y);
      const fy = q("fy");
      const fiscalYears = /^\d{4}$/.test(fy) ? (years.has(fy) ? [fy] : []) : Array.from(years);
      if (fiscalYears.length === 0) return res.json({ rows: [] });
      const rows = await store.searchRows({
        dealId: caller.deal.id, ledgerIds: Array.from(c.sellerLedgerIds), fiscalYears, q: q("q").slice(0, 100),
        minCents: min, maxCents: max, accountKey: q("account").slice(0, 300) || null, limit: 50,
      });
      res.json({ rows: rows.map(sellerEntry) });
    } catch (err) {
      fail(res, "search your ledger")(err);
    }
  });

  // ── Writes ──
  app.put("/api/seller/:token/gl/traces/:traceId/links", async (req, res) => {
    try {
      const caller = await sellerCaller(req, res, { write: true });
      if (!caller) return;
      const bad = refuseUnknownKeys(req.body, ["fy", "add", "remove", "reject"]);
      if (bad) return res.status(400).json({ error: bad });
      const found = await sellerTrace(req, res, caller);
      if (!found) return;
      const w = parseLinkWrite(req.body);
      if ("error" in w) return res.status(400).json({ error: w.error });
      const c = await loadGlContext(caller.deal.id);
      const r = await writeLinks(found.trace, w, { by: "seller", memberId: caller.memberId }, c);
      if (!r.ok) return res.status(r.status).json({ error: r.error });
      res.json({ ok: true });
    } catch (err) {
      fail(res, "save your ticks")(err);
    }
  });

  app.post("/api/seller/:token/gl/traces/:traceId/confirm-summary", async (req, res) => {
    try {
      const caller = await sellerCaller(req, res, { write: true });
      if (!caller) return;
      const found = await sellerTrace(req, res, caller);
      if (!found) return;
      const n = await confirmSummary(found.trace, { by: "seller", memberId: caller.memberId }, await loadGlContext(caller.deal.id));
      res.json({ ok: true, confirmed: n });
    } catch (err) {
      fail(res, "save that")(err);
    }
  });

  app.post("/api/seller/:token/gl/traces/:traceId/status", async (req, res) => {
    try {
      const caller = await sellerCaller(req, res, { write: true });
      if (!caller) return;
      const found = await sellerTrace(req, res, caller);
      if (!found) return;
      const status = req.body?.status;
      if (status !== "in_progress" && status !== "done") return res.status(400).json({ error: "That isn't a step." });
      await glStore().updateTrace(found.trace.id, { sellerStatus: status, ...(status === "done" ? { reopenedNote: null } : {}) } as Partial<GlAddbackTrace>);
      res.json({ ok: true });
    } catch (err) {
      fail(res, "save that")(err);
    }
  });

  app.post("/api/seller/:token/gl/traces/:traceId/note", async (req, res) => {
    try {
      const caller = await sellerCaller(req, res, { write: true });
      if (!caller) return;
      const bad = refuseUnknownKeys(req.body, ["text", "off"]);
      if (bad) return res.status(400).json({ error: bad });
      const found = await sellerTrace(req, res, caller);
      if (!found) return;
      const text = typeof req.body?.text === "string" ? req.body.text.trim().slice(0, 2000) : "";
      const patch: Partial<GlAddbackTrace> = { sellerNote: text || null };
      if (req.body?.off === true && text) patch.sellerStatus = "disputed";
      await glStore().updateTrace(found.trace.id, patch);
      res.json({ ok: true });
    } catch (err) {
      fail(res, "save your note")(err);
    }
  });

  app.post("/api/seller/:token/gl/traces/:traceId/not-in-ledger", async (req, res) => {
    try {
      const caller = await sellerCaller(req, res, { write: true });
      if (!caller) return;
      const bad = refuseUnknownKeys(req.body, ["reason", "fy", "undo"]);
      if (bad) return res.status(400).json({ error: bad });
      const found = await sellerTrace(req, res, caller);
      if (!found) return;
      if (req.body?.undo === true) {
        await glStore().updateTrace(found.trace.id, { notInLedger: null, sellerStatus: "in_progress" } as Partial<GlAddbackTrace>);
      } else {
        const reason = req.body?.reason;
        if (!["personal", "other_document", "unsure"].includes(reason)) return res.status(400).json({ error: "Pick what happened." });
        const fy = typeof req.body?.fy === "string" && /^\d{4}$/.test(req.body.fy) ? req.body.fy : null;
        const prev = found.trace.notInLedger as { years?: string[] } | null;
        const years = fy ? Array.from(new Set([...(prev?.years ?? []), fy])) : undefined;
        await glStore().updateTrace(found.trace.id, {
          notInLedger: { reason, at: new Date().toISOString(), ...(years ? { years } : {}) },
          ...(reason !== "other_document" && !fy ? { sellerStatus: "not_in_ledger" } : {}),
        } as Partial<GlAddbackTrace>);
      }
      await recomputeTraces(caller.deal.id, [found.trace.id]);
      res.json({ ok: true });
    } catch (err) {
      fail(res, "save that")(err);
    }
  });

  app.post("/api/seller/:token/gl/traces/:traceId/answer", async (req, res) => {
    try {
      const caller = await sellerCaller(req, res, { write: true });
      if (!caller) return;
      const bad = refuseUnknownKeys(req.body, ["text"]);
      if (bad) return res.status(400).json({ error: bad });
      const found = await sellerTrace(req, res, caller);
      if (!found) return;
      const q = found.trace.question as { text: string; askedAt: string } | null;
      if (!q) return res.status(409).json({ error: "There's no question to answer." });
      const text = typeof req.body?.text === "string" ? req.body.text.trim().slice(0, 2000) : "";
      if (!text) return res.status(400).json({ error: "Type your answer." });
      await glStore().updateTrace(found.trace.id, { question: { ...q, answer: text, answeredAt: new Date().toISOString() } } as Partial<GlAddbackTrace>);
      res.json({ ok: true });
    } catch (err) {
      fail(res, "send your answer")(err);
    }
  });

  // A T4 / payroll summary / invoice for one or more years of a cost.
  app.post(
    "/api/seller/:token/gl/traces/:traceId/support-docs",
    opts.supportGate,
    receiveSupportFile(),
    async (req, res) => {
      const cleanup = () => { if (req.file?.path) fs.unlink(req.file.path, () => {}); };
      try {
        const caller = await sellerCaller(req, res, { write: true });
        if (!caller) return cleanup();
        const found = await sellerTrace(req, res, caller);
        if (!found) return cleanup();
        if (!req.file) return res.status(400).json({ error: (req as any).glRejected ? "Upload a PDF, a photo (JPG or PNG) or a spreadsheet." : "Choose the document to upload." });
        const parsed = parseSupportAmounts(found.trace, req.body?.years, req.body?.amounts);
        if ("error" in parsed) {
          cleanup();
          return res.status(400).json({ error: parsed.error });
        }
        const name = Buffer.from(req.file.originalname, "latin1").toString("utf8").slice(0, 200);
        const doc = await storage.createDocument({
          dealId: caller.deal.id, uploadedBy: "seller", name, originalName: name, category: "financials", subcategory: "addback_support",
          fileUrl: `/uploads/docs/${req.file.filename}`, fileSize: req.file.size ?? null, mimeType: req.file.mimetype || null, status: "pending",
          sourceKind: "document", sourceMeta: { glTraceId: found.trace.id }, visibility: "shared",
        } as any);
        const store = glStore();
        for (const y of parsed.years) {
          await store.upsertDocLink({
            traceId: found.trace.id, dealId: caller.deal.id, fiscalYear: y.year, documentId: doc.id, amountCents: y.cents, docAmountCheck: null,
            state: "confirmed", proposedBy: "seller_document", decidedBy: "seller", decidedByMember: caller.memberId, decidedAt: new Date(),
          } as any);
        }
        if (found.trace.sellerStatus === "not_started") await store.updateTrace(found.trace.id, { sellerStatus: "in_progress" } as Partial<GlAddbackTrace>);
        await recomputeTraces(caller.deal.id, [found.trace.id]);
        // The normal reader reads it; when it's done the amounts are looked for in its text (ingest.ts finally → onGlSupportDocumentRead).
        const { ingestDocument } = await import("../documents/ingest");
        void ingestDocument(doc.id).catch((err) => console.error(`[gl] reading support document ${doc.id} failed:`, err));
        res.json({ ok: true, documentId: doc.id });
      } catch (err) {
        cleanup();
        fail(res, "upload the document")(err);
      }
    },
  );

  app.post("/api/seller/:token/gl/other-costs", async (req, res) => {
    try {
      const caller = await sellerCaller(req, res, { write: true });
      if (!caller) return;
      const bad = refuseUnknownKeys(req.body, ["text", "entries"]);
      if (bad) return res.status(400).json({ error: bad });
      const text = typeof req.body?.text === "string" ? req.body.text.trim().slice(0, 2000) : "";
      if (text.length < 3) return res.status(400).json({ error: "Tell your broker what the business pays for." });
      const c = await loadGlContext(caller.deal.id);
      if (!(await underDailyCap(caller.deal.id, "otherCosts", 5))) return res.status(429).json({ error: "You've sent several of these today — your broker has them. Add more tomorrow." });
      const refs = Array.isArray(req.body?.entries) ? req.body.entries.slice(0, 50) : [];
      const keys = refs.map((r: any) => ({ ledgerId: String(r?.ledgerId ?? ""), rowNo: Number(r?.rowNo) })).filter((k: any) => k.ledgerId && Number.isInteger(k.rowNo));
      const rows = (await glStore().rowsForKeys(caller.deal.id, keys)).filter((r) => c.sellerLedgerIds.has(r.ledgerId));
      const suggestion: GlSellerSuggestion = {
        id: randomUUID(), text, at: new Date().toISOString(), byMember: caller.memberId, status: "new",
        entries: rows.map((r) => ({ ledgerId: r.ledgerId, rowNo: r.rowNo, txnDate: r.txnDate, account: r.account, name: r.name, memo: r.memo, amountCents: r.amountCents })),
      };
      const list = ((c.tracing.sellerSuggestions as GlSellerSuggestion[] | null) ?? []).concat(suggestion).slice(-50);
      await glStore().updateTracing(caller.deal.id, { sellerSuggestions: list } as Partial<GlTracing>);
      await notifyBroker(caller.deal.id, "other_costs", { seller: caller.invite.sellerName });
      res.json({ ok: true });
    } catch (err) {
      fail(res, "send that to your broker")(err);
    }
  });

  app.post("/api/seller/:token/gl/accountant", async (req, res) => {
    try {
      const caller = await sellerCaller(req, res, { write: true });
      if (!caller) return;
      const bad = refuseUnknownKeys(req.body, ["name", "email"]);
      if (bad) return res.status(400).json({ error: bad });
      const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 120) : "";
      const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase().slice(0, 200) : "";
      if (!name) return res.status(400).json({ error: "Type your accountant's name." });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Type your accountant's email address." });
      const invites = await storage.getSellerInvitesByDealId(caller.deal.id);
      const onDeal = invites.some((i) => (i.sellerEmail ?? "").trim().toLowerCase() === email) || caller.members.some((m) => (m.email ?? "").trim().toLowerCase() === email);
      if (onDeal || (caller.invite.sellerEmail ?? "").trim().toLowerCase() === email) return res.status(409).json({ error: "That email is already on this deal." });
      const c = await loadGlContext(caller.deal.id);
      const prev = c.tracing.accountantRequest as { at: string; sentAt?: string; declinedAt?: string } | null;
      if (prev && !prev.sentAt && !prev.declinedAt) return res.status(409).json({ error: "Your broker already has your accountant's details." });
      const role = (TEAM_ROLES.seller as Record<string, { permissions: readonly string[] }>).accountant;
      const member = await storage.createDealMember({
        dealId: caller.deal.id, email, name, phone: null, teamType: "seller", role: "accountant", permissions: role ? [...role.permissions] : [],
        inviteToken: randomUUID(), inviteStatus: "pending", invitedAt: null, accessLevel: null, emailNotifications: true, smsNotifications: false,
      } as any);
      await glStore().updateTracing(caller.deal.id, { accountantRequest: { memberId: member.id, name, email, at: new Date().toISOString() } } as Partial<GlTracing>);
      await notifyBroker(caller.deal.id, "accountant", { seller: caller.invite.sellerName, accountant: name });
      res.json({ ok: true });
    } catch (err) {
      fail(res, "send that to your broker")(err);
    }
  });

  app.post("/api/seller/:token/gl/email-me-link", async (req, res) => {
    try {
      const caller = await sellerCaller(req, res, { write: true });
      if (!caller) return;
      if (!caller.invite.sellerEmail) return res.status(409).json({ error: "There's no email address on your link — copy the link instead." });
      await loadGlContext(caller.deal.id);
      if (!(await underDailyCap(caller.deal.id, "emailLinkSends", 3))) return res.status(429).json({ error: "We've sent it a few times today — check your inbox, or copy the link instead." });
      const r = await emailSellerTheirLink(caller.invite);
      res.json({ ok: true, ...r });
    } catch (err) {
      fail(res, "email the link")(err);
    }
  });

  app.post("/api/seller/:token/gl/cant-get-ledger", async (req, res) => {
    try {
      const caller = await sellerCaller(req, res, { write: true });
      if (!caller) return;
      const bad = refuseUnknownKeys(req.body, ["reason", "note"]);
      if (bad) return res.status(400).json({ error: bad });
      const reason = req.body?.reason;
      if (!["no_software", "other"].includes(reason)) return res.status(400).json({ error: "Pick what happened." });
      const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 1000) : "";
      if (reason === "other" && !note) return res.status(400).json({ error: "Tell your broker what's happening." });
      await loadGlContext(caller.deal.id);
      await glStore().updateTracing(caller.deal.id, { cantGetLedger: { reason, ...(note ? { note } : {}), at: new Date().toISOString() } } as Partial<GlTracing>);
      await notifyBroker(caller.deal.id, "cant_get_ledger", { seller: caller.invite.sellerName, reason: reason === "no_software" ? "I don't use accounting software" : note });
      res.json({ ok: true });
    } catch (err) {
      fail(res, "send that to your broker")(err);
    }
  });

  app.post("/api/seller/:token/gl/done", async (req, res) => {
    try {
      const caller = await sellerCaller(req, res, { write: true });
      if (!caller) return;
      const bad = refuseUnknownKeys(req.body, ["confirm"]);
      if (bad) return res.status(400).json({ error: bad });
      if (req.body?.confirm !== true) return res.status(400).json({ error: "Tick \"These entries are correct to the best of my knowledge\" first." });
      const store = glStore();
      const tracing = await store.getTracing(caller.deal.id);
      if (!tracing?.requestedAt || tracing.withdrawnAt) return res.status(409).json({ error: "Your broker isn't waiting on this any more." });
      const costs = sellerVisibleTraces(await store.listTraces(caller.deal.id));
      const open = costs.filter((t) => !["done", "not_in_ledger", "disputed"].includes(t.sellerStatus));
      if (open.length) return res.status(409).json({ error: `Finish ${open.length === 1 ? `"${open[0].sellerLabel}"` : `${open.length} costs`} first.` });
      const first = !tracing.sellerDoneAt;
      await store.updateTracing(caller.deal.id, {
        sellerDoneAt: new Date(),
        sellerConfirmation: { role: caller.role === "accountant" ? "accountant" : "owner", memberId: caller.memberId, name: caller.invite.sellerName ?? null, at: new Date().toISOString() },
      } as Partial<GlTracing>);
      if (first) await notifyBroker(caller.deal.id, "finished", { seller: caller.invite.sellerName });
      res.json({ ok: true });
    } catch (err) {
      fail(res, "send it to your broker")(err);
    }
  });
}

/** The books page's data for a seller link (pure shaping in seller-view.ts). */
export async function sellerBooksPayload(caller: SellerCaller) {
  const c = await loadGlContext(caller.deal.id);
  const store = glStore();
  const [traces, links] = await Promise.all([store.listTraces(caller.deal.id), store.linksOfDeal(caller.deal.id)]);
  const { jurisdictionOf } = await import("../interview/reply-guards");
  return sellerBooksView({
    tracing: c.tracing, traces, links, ctx: sellerReconcileCtx(c), sellerLedgerYears: c.yearsSeller, sellerLedgerIds: c.sellerLedgerIds,
    country: jurisdictionOf(caller.deal.location ?? null),
  });
}
