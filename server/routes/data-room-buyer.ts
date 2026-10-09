/**
 * The buyer's data room — vdr spec §9.3. All under /api/view/:token/data-room
 * (the token is redacted from logs by server/log-redact.ts). Registered from
 * server/routes.ts; per-token rate limits in server/vdr/rate-limits.ts.
 *
 * `vdrBuyerGate` runs first on every route and re-reads everything (V10).
 * A document the reader can't open answers 404 "Not found" — the same for
 * not shared, broker-only, hidden from them, a ledger outside due diligence,
 * one Cimple hasn't finished checking, or an id that doesn't exist — and is
 * never listed or searched. Page images carry the reader's watermark with a
 * server-issued trace; nothing here ever sends the original bytes unless the
 * broker chose to offer the original (§4.3).
 *
 *   GET  ""                         the room (tree, items, badges); rolls the visit stamps
 *   GET  /index.csv                 the reader's visible index
 *   GET  /items/:itemId             About + viewer manifest
 *   POST /views/start               { itemId, source, width } → { viewId, trace }
 *   POST /views                     a beat { viewId, activeMs, pageMs, maxPage } (JSON or a text/plain beacon)
 *   GET  /items/:itemId/pages/:n    ?w=700|1400&v=<viewId>  watermarked JPEG
 *   GET  /items/:itemId/sheet|html|text
 *   GET  /items/:itemId/download    ?v=<viewId>
 *   GET  /search                    ?q=
 */
import express, { type Express, type Request, type Response } from "express";
import type { BuyerQuestion, InsertBuyerQuestion } from "@shared/schema";
import { watermarkFooter, watermarkLine, VDR_LIMITS, fileSizeLabel } from "@shared/vdr";
import type { ViewStart } from "@shared/vdr-api";
import { logVdrQuietly } from "../vdr/store";
import { decideForGate, defaultGateDeps, itemFor, listedItems, vdrBuyerGate, VdrHttpError, type GateDeps, type VdrGate } from "../vdr/access";
import { buyerAboutExtras, buyerItemAbout, buyerItems, buyerRoomPayload } from "../vdr/buyer-room";
import { parseBuyerRequest, requestRows } from "../vdr/requests";
import { dataRoomLevelRule, buyerKey } from "@shared/vdr";
import { buildDownload, decisionFor, docHtml, docText, kickPrepare, pageImage, ServeError, sheetRows, defaultServeDeps, type ServeDeps } from "../vdr/serve";
import { buyerLog, ipHashFor, logDenied, parseBeat, recordView, startView, viewForPage } from "../vdr/activity";
import { cleanQuery, searchRoom } from "../vdr/search";
import { csvCell } from "../vdr/activity-report";
import { indexNumbers } from "@shared/vdr";

export type BuyerRouteDeps = GateDeps & {
  serve: ServeDeps;
  brand: (brokerId: string | null) => Promise<{ firmName: string | null; logoUrl: string | null }>;
  // ── Pass 3: requests and document questions (no AI; the broker is alerted in-app) ──
  questionsForDeal: (dealId: string) => Promise<BuyerQuestion[]>;
  createQuestion: (row: InsertBuyerQuestion) => Promise<BuyerQuestion>;
  /** The existing "buyer_question" alert to the broker (demo deals never email). */
  notifyBroker: (dealId: string, title: string, body: string, actionUrl: string, businessName: string | null) => Promise<unknown>;
  /** The CIM sections a buyer is served ("Used in the memorandum"); tests stub it. */
  servedSections?: typeof import("../vdr/analysis").servedSectionsFor;
};

async function defaultBuyerDeps(): Promise<BuyerRouteDeps> {
  const { brokerageBrand } = await import("../cim/templates");
  const { storage } = await import("../storage");
  return {
    ...(await defaultGateDeps()),
    serve: defaultServeDeps(),
    brand: async (id) => {
      const b = await brokerageBrand(id);
      return { firmName: b.firmName || null, logoUrl: b.logoUrl || null };
    },
    questionsForDeal: (d) => storage.getQuestionsByDeal(d),
    createQuestion: (row) => storage.createBuyerQuestion(row),
    notifyBroker: async (dealId, title, body, actionUrl, businessName) => {
      const { notify } = await import("../notifications/service");
      return notify(dealId, "buyer_question", { title, body, actionUrl, businessName: businessName ?? undefined });
    },
  };
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function send(res: Response, err: unknown, what: string) {
  if (err instanceof VdrHttpError) return res.status(err.status).json(err.body);
  if (err instanceof ServeError) return res.status(err.status).json({ error: err.message, code: err.code });
  console.error(`[vdr] buyer ${what}:`, err);
  return res.status(500).json({ error: "Something went wrong. Try again." });
}

const textBeat = express.text({ type: "text/plain", limit: "16kb" });

export { csvCell };

export function registerDataRoomBuyerRoutes(app: Express, overrides?: Partial<BuyerRouteDeps>) {
  let depsP: Promise<BuyerRouteDeps> | null = null;
  const deps = () => (depsP ??= defaultBuyerDeps().then((d) => ({ ...d, ...(overrides ?? {}) })));
  const BASE = "/api/view/:token/data-room";

  /** The owning broker opening a buyer's link (their reading isn't a buyer's). */
  const ownerPreview = (req: Request, gate: VdrGate) => !!req.session?.brokerId && req.session.brokerId === gate.deal.brokerId;

  async function gateAndItems(req: Request, opts: { allowNoAck?: boolean } = {}) {
    const d = await deps();
    const gate = await vdrBuyerGate(d, String(req.params.token), opts);
    const { snap, decided } = await decideForGate(d, gate);
    return { d, gate, snap, decided };
  }

  async function hidden(d: BuyerRouteDeps, gate: VdrGate, req: Request, itemId: string): Promise<never> {
    if (!ownerPreview(req, gate)) await logDenied(d.store, gate, itemId, ipHashFor(gate.deal.id, req));
    throw new VdrHttpError(404, { error: "Not found" });
  }

  function markFor(gate: VdrGate, view: { startedAt: Date | string; trace: string }, firm: string | null) {
    const at = new Date(view.startedAt);
    return {
      line: watermarkLine({ name: gate.viewer.name, email: gate.viewer.email, at, trace: view.trace, principalCompany: gate.member ? gate.access.buyerCompany || gate.access.buyerName || null : null }),
      footer: watermarkFooter({ email: gate.viewer.email, at, firm }),
    };
  }

  app.get(BASE, async (req, res) => {
    try {
      const { d, gate, snap, decided } = await gateAndItems(req, { allowNoAck: true });
      res.setHeader("Cache-Control", "no-store");
      if (gate.member && !gate.member.ackAt) {
        // Team members confirm confidentiality first (their acknowledgement screen ships with team access).
        return res.status(403).json({ code: "ack_required", principalCompany: gate.access.buyerCompany || gate.access.buyerName || null, role: gate.member.role });
      }
      res.json(await buyerRoomPayload({ store: d.store, brand: d.brand, now: d.now }, gate, snap, decided, { preview: ownerPreview(req, gate), ipHash: ipHashFor(gate.deal.id, req) }));
    } catch (err) {
      send(res, err, "room");
    }
  });

  app.get(`${BASE}/index.csv`, async (req, res) => {
    try {
      const { d, gate, snap, decided } = await gateAndItems(req);
      const numbers = indexNumbers(snap.folders, snap.items);
      const rows = listedItems(decided)
        .map((x) => ({ number: numbers.items.get(x.item.id) ?? "", title: x.item.title, type: fileSizeLabel(x.item.prepared ?? null).split(" · ")[0], pages: x.item.prepared?.pages?.length ?? "", added: new Date(x.item.addedAt).toISOString().slice(0, 10) }))
        .sort((a, b) => String(a.number).localeCompare(String(b.number), undefined, { numeric: true }));
      const lines = [["Number", "Document", "Type", "Pages", "Date added"].map(csvCell).join(","), ...rows.map((r) => [r.number, r.title, r.type, r.pages, r.added].map(csvCell).join(","))];
      if (!ownerPreview(req, gate)) await logVdrQuietly(d.store, buyerLog(gate, "index_downloaded", { ipHash: ipHashFor(gate.deal.id, req) }));
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="data-room-index.csv"`);
      res.send("﻿" + lines.join("\r\n") + "\r\n");
    } catch (err) {
      send(res, err, "index");
    }
  });

  app.get(`${BASE}/items/:itemId`, async (req, res) => {
    try {
      const { d, gate, snap, decided } = await gateAndItems(req);
      let one;
      try { one = itemFor(decided, String(req.params.itemId), { allowNotReady: true }); } catch { return await hidden(d, gate, req, String(req.params.itemId)); }
      if (!one.item.prepared || one.item.prepared.status !== "ready") kickPrepare(one.item.id);
      res.setHeader("Cache-Control", "no-store");
      const extras = await buyerAboutExtras(d, gate, snap, decided, one, { preview: ownerPreview(req, gate) });
      res.json({ ...buyerItemAbout(gate, snap, decided, one), ...extras });
    } catch (err) {
      send(res, err, "item");
    }
  });

  app.post(`${BASE}/views/start`, async (req, res) => {
    try {
      const { d, gate, decided } = await gateAndItems(req);
      const itemId = String(req.body?.itemId ?? "");
      let one;
      try { one = itemFor(decided, itemId); } catch { return await hidden(d, gate, req, itemId); }
      const r = await startView(d.store, gate, { id: one.item.id, documentId: one.item.documentId, fileVersion: one.item.fileVersion ?? 1 }, { source: req.body?.source, width: req.body?.width, preview: ownerPreview(req, gate), ipHash: ipHashFor(gate.deal.id, req) }, d.now());
      const out: ViewStart = { viewId: r.viewId, trace: r.trace };
      res.json(out);
    } catch (err) {
      send(res, err, "view start");
    }
  });

  app.post(`${BASE}/views`, textBeat, async (req, res) => {
    try {
      const d = await deps();
      const gate = await vdrBuyerGate(d, String(req.params.token));
      const beat = parseBeat(req.body);
      if (!beat) return res.status(400).json({ error: "Malformed" });
      const v = await recordView(d.store, gate, beat, d.now());
      if (!v) return res.status(404).json({ error: "Not found" });
      res.status(204).end();
    } catch (err) {
      send(res, err, "view beat");
    }
  });

  app.get(`${BASE}/items/:itemId/pages/:n`, async (req, res) => {
    try {
      const { d, gate, decided } = await gateAndItems(req);
      const itemId = String(req.params.itemId);
      let one;
      try { one = itemFor(decided, itemId); } catch { return await hidden(d, gate, req, itemId); }
      const n = Number(req.params.n);
      if (!Number.isInteger(n) || n < 1 || n > 10_000) throw new VdrHttpError(404, { error: "Not found" });
      const view = await viewForPage(d.store, gate, req.query.v, itemId);
      if (!view) throw new VdrHttpError(404, { error: "Not found" });
      const w = Number(req.query.w) === 700 ? 700 : 1400;
      const brand = await d.brand(gate.deal.brokerId ?? null).catch(() => ({ firmName: null, logoUrl: null }));
      const bytes = await pageImage(one.item, one.doc, n, w, markFor(gate, view, brand.firmName), `view:${view.id}`, d.serve);
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Disposition", "inline");
      res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      res.end(Buffer.from(bytes));
    } catch (err) {
      send(res, err, "page");
    }
  });

  app.get(`${BASE}/items/:itemId/sheet`, async (req, res) => {
    try {
      const { d, gate, decided } = await gateAndItems(req);
      const itemId = String(req.params.itemId);
      let one;
      try { one = itemFor(decided, itemId); } catch { return await hidden(d, gate, req, itemId); }
      const rows = typeof req.query.rows === "string" ? req.query.rows.split(",").map(Number).filter((x) => Number.isInteger(x) && x > 0).slice(0, VDR_LIMITS.rowsMax) : null;
      const out = sheetRows(one.item, Number(req.query.sheet) || 0, Number(req.query.offset) || 0, Math.min(500, Number(req.query.limit) || 200), rows, d.root);
      if (!out) throw new VdrHttpError(404, { error: "Not found" });
      res.setHeader("Cache-Control", "private, no-store");
      res.json(out);
    } catch (err) {
      send(res, err, "sheet");
    }
  });

  app.get(`${BASE}/items/:itemId/html`, async (req, res) => {
    try {
      const { d, gate, decided } = await gateAndItems(req);
      const itemId = String(req.params.itemId);
      let one;
      try { one = itemFor(decided, itemId); } catch { return await hidden(d, gate, req, itemId); }
      const html = docHtml(one.item, d.root);
      if (html == null) throw new VdrHttpError(404, { error: "Not found" });
      res.setHeader("Cache-Control", "private, no-store");
      res.json({ html });
    } catch (err) {
      send(res, err, "html");
    }
  });

  app.get(`${BASE}/items/:itemId/text`, async (req, res) => {
    try {
      const { d, gate, decided } = await gateAndItems(req);
      const itemId = String(req.params.itemId);
      let one;
      try { one = itemFor(decided, itemId); } catch { return await hidden(d, gate, req, itemId); }
      const text = docText(one.item, d.root);
      if (text == null) throw new VdrHttpError(404, { error: "Not found" });
      res.setHeader("Cache-Control", "private, no-store");
      res.json({ text });
    } catch (err) {
      send(res, err, "text");
    }
  });

  app.get(`${BASE}/items/:itemId/download`, async (req, res) => {
    try {
      const { d, gate, decided } = await gateAndItems(req);
      const itemId = String(req.params.itemId);
      let one;
      try { one = itemFor(decided, itemId); } catch { return await hidden(d, gate, req, itemId); }
      const decision = decisionFor(one.item, one.item.prepared ?? null, !!gate.setting?.allowDownloads);
      if (!decision.allowed) throw new ServeError(403, decision.why, "View only. Ask your broker if you need a copy.");
      const preview = ownerPreview(req, gate);
      let view = await viewForPage(d.store, gate, req.query.v, itemId);
      if (!view) view = (await startView(d.store, gate, { id: one.item.id, documentId: one.item.documentId, fileVersion: one.item.fileVersion ?? 1 }, { source: "room", preview, ipHash: ipHashFor(gate.deal.id, req) }, d.now())).view;
      const brand = await d.brand(gate.deal.brokerId ?? null).catch(() => ({ firmName: null, logoUrl: null }));
      const mark = markFor(gate, view, brand.firmName);
      const at = d.now();
      const stamp = `Confidential · downloaded by ${gate.viewer.name || gate.viewer.email} ${gate.viewer.email} · ${at.toISOString().slice(0, 16).replace("T", " ")} UTC · ${view.trace}`;
      const built = await buildDownload(one.item, one.doc, decision, mark, stamp, d.serve);
      await d.store.markViewDownloaded(view.id);
      if (!preview) await logVdrQuietly(d.store, buyerLog(gate, "buyer_downloaded", { itemId: one.item.id, detail: { as: decision.as, viewId: view.id }, ipHash: ipHashFor(gate.deal.id, req) }));
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Type", built.contentType);
      res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(built.fileName)}`);
      res.end(Buffer.from(built.bytes));
    } catch (err) {
      send(res, err, "download");
    }
  });

  // ── Pass 3: ask for a document (one or a pasted list) · ask for access · ask about a document ──

  app.post(`${BASE}/requests`, async (req, res) => {
    try {
      const d = await deps();
      const token = String(req.params.token);
      if (req.body?.kind === "room_access") {
        // A Blind CIM or Full CIM buyer without the room asks for it (§6.5). Never a teaser link (C23), never a team member.
        let open = false;
        try { await vdrBuyerGate(d, token); open = true; } catch (err) {
          if (!(err instanceof VdrHttpError) || (err.body.code !== "no_room_access" && err.body.code !== "room_none")) throw err;
        }
        if (open) return res.status(409).json({ error: "You already have the data room." });
        const access = await d.accessByToken(token);
        if (!access || access.revokedAt || (access.expiresAt && new Date(access.expiresAt).getTime() < d.now().getTime())) return res.status(404).json({ error: "Access denied or link expired" });
        if (!access.ndaSigned) return res.status(403).json({ code: "nda_required", error: "Sign the NDA first." });
        if (dataRoomLevelRule(access.accessLevel) === "never_teaser") return res.status(403).json({ code: "teaser", error: "Ask for the CIM from your summary first." });
        if (req.session?.brokerId) return res.status(403).json({ error: "Preview: nothing is sent." });
        const key = buyerKey(access.buyerEmail);
        const existing = (await d.store.listRequests(access.dealId)).find((r) => r.kind === "room_access" && r.buyerEmail === key && r.status === "open");
        if (existing) return res.json({ ok: true, already: true });
        const deal = await d.getDeal(access.dealId);
        await d.store.insertRequests(requestRows(access.dealId, { accessId: access.id, buyerEmail: key, teamMemberId: null, kind: "room_access", rows: [{ text: "Access to the data room", itemId: null, documentId: null }], list: false }));
        await logVdrQuietly(d.store, { dealId: access.dealId, action: "buyer_requested", actorKind: "buyer", actorId: access.id, buyerEmail: key, detail: { count: 1, kind: "room_access" }, ipHash: ipHashFor(access.dealId, req) });
        void d.notifyBroker(access.dealId, "A buyer asked for the data room", `${escapeHtml(access.buyerCompany || access.buyerName || access.buyerEmail)} asked for access to the data room.`, `/deal/${access.dealId}/data-room?view=todo&todo=requests`, deal?.businessName ?? null).catch(() => undefined);
        return res.json({ ok: true });
      }
      const { gate, decided } = await gateAndItems(req);
      if (ownerPreview(req, gate)) return res.status(403).json({ error: "Preview: nothing is sent." });
      const parsed = parseBuyerRequest(req.body);
      if ("error" in parsed) return res.status(400).json({ error: parsed.error });
      for (const r of parsed.rows) {
        // A named document must be one they can see; a citation's document must be this deal's (never echoed back).
        if (r.itemId) { try { itemFor(decided, r.itemId, { allowNotReady: true }); } catch { return res.status(404).json({ error: "Not found" }); } }
        if (r.documentId) {
          const doc = await d.store.getDocument(r.documentId);
          if (!doc || doc.dealId !== gate.deal.id) return res.status(404).json({ error: "Not found" });
        }
      }
      const rows = await d.store.insertRequests(requestRows(gate.deal.id, { accessId: gate.access.id, buyerEmail: gate.reader.buyerEmail, teamMemberId: gate.viewer.teamMemberId, kind: "document", rows: parsed.rows, list: parsed.list }));
      await logVdrQuietly(d.store, buyerLog(gate, "buyer_requested", { detail: { count: rows.length, kind: "document" }, ipHash: ipHashFor(gate.deal.id, req) }));
      const who = gate.member ? `${gate.member.name} (for ${gate.access.buyerCompany || gate.access.buyerName || gate.access.buyerEmail})` : gate.access.buyerCompany || gate.access.buyerName || gate.access.buyerEmail;
      const what = rows.length === 1 ? `&ldquo;${escapeHtml(rows[0].text.slice(0, 160))}&rdquo;` : `a list of ${rows.length} documents`;
      void d.notifyBroker(gate.deal.id, "A buyer asked for a document in the data room", `${escapeHtml(who)} asked for ${what}.`, `/deal/${gate.deal.id}/data-room?view=todo&todo=requests`, gate.deal.businessName ?? null).catch(() => undefined);
      res.json({ ok: true, count: rows.length });
    } catch (err) {
      send(res, err, "request");
    }
  });

  app.post(`${BASE}/items/:itemId/questions`, async (req, res) => {
    try {
      const { d, gate, decided } = await gateAndItems(req);
      const itemId = String(req.params.itemId);
      let one;
      try { one = itemFor(decided, itemId); } catch { return await hidden(d, gate, req, itemId); }
      if (ownerPreview(req, gate)) return res.status(403).json({ error: "Preview: nothing is sent." });
      const question = typeof req.body?.question === "string" ? req.body.question.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").trim() : "";
      if (!question) return res.status(400).json({ error: "Type your question." });
      if (question.length > VDR_LIMITS.questionText) return res.status(400).json({ error: `Keep it under ${VDR_LIMITS.questionText} characters.` });
      const pages = one.item.prepared?.pages?.length ?? 0;
      const pageN = Number(req.body?.page);
      const page = Number.isInteger(pageN) && pageN >= 1 && (pages === 0 || pageN <= pages) ? pageN : null;
      // No AI: straight to the broker, answer private to this buyer unless the broker shares it (V11).
      const q = await d.createQuestion({
        dealId: gate.deal.id,
        buyerAccessId: gate.access.id,
        question,
        status: "pending_broker",
        isPublished: false,
        addedToKnowledgeBase: false,
        answerScope: "private",
        vdrItemId: one.item.id,
        vdrPage: page,
        vdrTeamMemberId: gate.viewer.teamMemberId,
      } as InsertBuyerQuestion);
      await logVdrQuietly(d.store, buyerLog(gate, "buyer_asked", { itemId: one.item.id, detail: { page }, ipHash: ipHashFor(gate.deal.id, req) }));
      const who = gate.member ? `${gate.member.name} (for ${gate.access.buyerCompany || gate.access.buyerName || gate.access.buyerEmail})` : gate.access.buyerCompany || gate.access.buyerName || gate.access.buyerEmail;
      void d.notifyBroker(gate.deal.id, "A buyer asked about a document", `${escapeHtml(who)} asked about &ldquo;${escapeHtml(one.item.title)}&rdquo;${page ? ` (page ${page})` : ""}: &ldquo;${escapeHtml(question.slice(0, 160))}&rdquo;`, `/deal/${gate.deal.id}/qa`, gate.deal.businessName ?? null).catch(() => undefined);
      res.json({ ok: true, id: q.id });
    } catch (err) {
      send(res, err, "question");
    }
  });

  app.get(`${BASE}/search`, async (req, res) => {
    try {
      const q = cleanQuery(req.query.q);
      if (!q) return res.status(400).json({ error: `Type ${VDR_LIMITS.searchMin} to ${VDR_LIMITS.searchMax} characters.` });
      const { d, gate, snap, decided } = await gateAndItems(req);
      const numbers = indexNumbers(snap.folders, snap.items);
      // Only documents the reader can open right now; never a ledger (gl searches those in its own viewer).
      const usable = decided.filter((x) => x.visibility.visible).map((x) => ({
        id: x.item.id,
        title: x.item.title,
        number: numbers.items.get(x.item.id) ?? null,
        searchable: x.item.prepared?.kind !== "ledger" && x.item.prepared?.kind !== "ledger_pending",
      }));
      const hits = await searchRoom(d.store, gate.deal.id, usable, q);
      if (!ownerPreview(req, gate)) await logVdrQuietly(d.store, buyerLog(gate, "buyer_searched", { detail: { hits: hits.length }, ipHash: ipHashFor(gate.deal.id, req) }));
      res.setHeader("Cache-Control", "no-store");
      res.json({ q, hits });
    } catch (err) {
      send(res, err, "search");
    }
  });
}

/**
 * `dataRoom` for GET /api/view/:token (INTEGRATION §2.3): whether this
 * reader has the room, how many documents are new, whether it's closed,
 * downloads, link expiry. Never throws; null when it can't be worked out.
 */
export async function viewRoomDataRoom(token: string, deps?: Partial<BuyerRouteDeps>): Promise<{ available: boolean; newCount: number; closed: boolean; allowDownloads: boolean; expiresAt: string | null } | null> {
  try {
    const d = { ...(await defaultBuyerDeps()), ...(deps ?? {}) };
    let gate: VdrGate;
    try {
      gate = await vdrBuyerGate(d, token);
    } catch (err) {
      if (err instanceof VdrHttpError && err.body.code === "room_closed") return { available: false, newCount: 0, closed: true, allowDownloads: false, expiresAt: null };
      return { available: false, newCount: 0, closed: false, allowDownloads: false, expiresAt: null };
    }
    const { snap, decided } = await decideForGate(d, gate);
    const views = await d.store.listViews(gate.deal.id);
    // "New" against the visit the room will compare with when they open it (it rolls after 30 minutes away).
    const last = gate.setting?.lastVisitAt ? new Date(gate.setting.lastVisitAt) : null;
    const ref = last && d.now().getTime() - last.getTime() > VDR_LIMITS.newVisitGapMs ? last : gate.setting?.previousVisitAt ?? null;
    const items = buyerItems(gate, snap, decided, views, ref);
    return {
      available: true,
      newCount: items.filter((i) => i.isNew || i.isUpdated).length,
      closed: false,
      allowDownloads: !!gate.setting?.allowDownloads,
      expiresAt: gate.access.expiresAt ? new Date(gate.access.expiresAt).toISOString() : null,
    };
  } catch (err: any) {
    console.warn("[vdr] dataRoom for the view room:", err?.message ?? err);
    return null;
  }
}
