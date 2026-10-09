/**
 * Interview together + the coverage board (specs/together.md §7.2).
 *
 * Board:
 *   GET    /api/deals/:dealId/coverage-board?audience=broker|screen[&sittingId=]   the board (never calls a model, starts nothing)
 *   GET    /api/deals/:dealId/coverage-board/items/:itemId?audience=              popover detail
 *   POST   /api/deals/:dealId/coverage-board/items/:itemId/marks                  {kind: verify_later|note|doc_promised, note?}
 *   DELETE /api/deals/:dealId/coverage-board/items/:itemId/marks/:kind
 *   POST   /api/deals/:dealId/coverage-board/items/:itemId/confirm                ✓ Confirmed (a "confirmed" mark; a lead is vouched for)
 *   POST   /api/deals/:dealId/coverage-board/items/:itemId/answer                 ✓ Answered: {sittingId, mode: "auto"|"note", memberKey?, value?}
 *   GET    /api/seller/:token/coverage                                             the seller's "What we've covered" (statuses only)
 *
 * Sittings (a session together):
 *   POST   /api/deals/:dealId/together/sittings                         {via} start or resume (no AI call, no interview session)
 *   GET    /api/deals/:dealId/together/sittings                         list (Interview tab, Overview)
 *   GET    …/sittings/:sittingId[?afterSeq=]                            the sitting + its lines (broker only)
 *   GET    …/sittings/:sittingId/events                                 SSE (hello, lines, board, listen, sitting…)
 *   GET    …/sittings/:sittingId/state?after=<eventSeq>                 poll fallback
 *   POST   …/sittings/:sittingId/consent                                "They know — start"
 *   POST   …/sittings/:sittingId/lines                                  {clientId, lines[]} (idempotent)
 *   POST   …/sittings/:sittingId/speakers                               {speaker, role}
 *   PATCH  …/sittings/:sittingId                                        {sellerSeesScreen}
 *   POST   …/sittings/:sittingId/pause | /resume
 *   GET    …/sittings/:sittingId/summary                                the summary as it stands (the End dialog)
 *   POST   …/sittings/:sittingId/end                                    {completeInterview, followUps[], documents[], addToNextSession}
 *   POST   …/sittings/:sittingId/follow-up-email                        {itemIds, documentIds, preview?} (broker click; demo deals record only)
 *
 * Tenancy: every broker route is requireBroker + requireOwnedDeal (404 for
 * another brokerage's deal), and a sitting must belong to the deal (404);
 * the seller route checks the invite token. Rate limits:
 * server/together/limits.ts (mounted in server/index.ts).
 */
import type { Express, Request, Response } from "express";
import type { CoverageAudience, CoverageMarkKind } from "@shared/coverage-board";
import type { Deal } from "@shared/schema";
import { requireBroker, requireOwnedDeal } from "../broker-auth/routes.js";
import { storage } from "../storage";
import { buildCoverageBoard, itemDetail, loadCoverageInputs } from "../interview/coverage-board";
import { BROKER_MARK_KINDS, ITEM_ID_RE, MARK_KINDS, MARK_NOTE_MAX, clearMark, setMark } from "../together/marks";
import { BoardActionError, confirmItem, writeBrokerCallNotes } from "../together/capture-apply";
import { isTogetherVia, sittingDurationMin, validateLinesBody, type SittingListRow, type SpeakerRole, type TogetherVia } from "@shared/together";
import * as hub from "../together/hub";
import {
  appendLines,
  lineView,
  pauseSitting,
  recordConsent,
  resumeSitting,
  setSellerSeesScreen,
  setSpeakerRole,
  sittingAudience,
  sittingForDeal,
  sittingView,
  startOrResumeSitting,
} from "../together/sittings";
import { togetherStore } from "../together/store";
import { currentSummary, endSitting, parseEndBody, sendFollowUpEmail } from "../together/summary";
import { fileNow, filingOn, promoteHeldAnswers, refile, rememberBoard, retryNow, sittingBoardFor, withHeldAnswers } from "../together/pipeline";
import { undoCapture } from "../together/capture-apply";
import type { TogetherChunk, TogetherSitting } from "@shared/schema";


function brokerAudience(req: Request): Exclude<CoverageAudience, "seller"> {
  return req.query.audience === "screen" ? "screen" : "broker";
}

function itemIdParam(req: Request): string | null {
  const id = String(req.params.itemId ?? "");
  return ITEM_ID_RE.test(id) ? id : null;
}

/** The board in the sitting's audience — the server decides, on every path (D10). Held possible answers on it (broker only). */
async function sittingBoard(deal: Deal, sitting: TogetherSitting) {
  return sittingBoardFor(deal, sitting);
}

/** Pushes the board to every open tab of the sitting (after a write). */
async function publishBoard(dealId: string, sittingId: string): Promise<void> {
  try {
    const [deal, sitting] = await Promise.all([storage.getDeal(dealId), togetherStore().getSitting(sittingId)]);
    if (!deal || !sitting || sitting.status === "ended") return;
    const board = await sittingBoard(deal, sitting);
    rememberBoard(sittingId, board);
    hub.publish(sittingId, { type: "board", board });
  } catch (err) {
    console.warn(`[together] couldn't push the board for ${sittingId}:`, (err as Error).message);
  }
}

/** Waits (≤ ms) for a part to be filed; returns it as it ended, or null when still going. */
async function partFiled(chunkId: string, ms: number): Promise<TogetherChunk | null> {
  const until = Date.now() + ms;
  for (;;) {
    const c = await togetherStore().getChunk(chunkId);
    if (!c) return null;
    if (c.status === "done" || c.status === "failed" || c.status === "skipped") return c;
    if (Date.now() >= until) return null;
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Did this part file anything under the item? */
function filedItem(c: TogetherChunk | null, item: { id: string; members: Array<{ key: string }> }): boolean {
  const res = (c?.result ?? null) as { filed?: Array<{ key: string; itemId?: string | null; undoneAt?: string }> } | null;
  return !!res?.filed?.some((f) => !f.undoneAt && (f.itemId === item.id || item.members.some((m) => m.key === f.key)));
}

/** The broker's display name (meeting participants are matched on it). */
async function brokerDisplayName(brokerId: string): Promise<string> {
  const u = await storage.getUser(brokerId).catch(() => undefined);
  return String((u as { name?: string | null } | undefined)?.name ?? "").trim().toLowerCase();
}

/** Every item's suggested question (on file ones too — the broker may check them) — the room's broker is whoever reads one aloud. */
async function openAsks(deal: Deal): Promise<string[]> {
  const board = await buildCoverageBoard(deal, { audience: "broker" });
  return board.sections.flatMap((s) => s.items.filter((i) => i.ask).map((i) => i.ask)).slice(0, 200);
}

/** Every item's ask and label, with whether it's still open (for "asked" marks). */
async function askItems(deal: Deal): Promise<Array<{ itemId: string; sectionKey: string; ask: string; label: string; open: boolean }>> {
  const board = await buildCoverageBoard(deal, { audience: "broker" });
  return board.sections.flatMap((s) => s.items.filter((i) => i.ask && i.origin !== "figures").map((i) => ({ itemId: i.id, sectionKey: s.key, ask: i.ask, label: i.label, open: i.status !== "on_file" })));
}

function fail(res: Response, err: unknown, fallback: string) {
  if (err instanceof BoardActionError) return res.status(err.status).json({ error: err.message, code: err.code, ...err.details });
  console.error(`[together] ${fallback}:`, (err as Error)?.message ?? err);
  return res.status(500).json({ error: fallback });
}

export function registerTogetherRoutes(app: Express): void {
  app.get("/api/deals/:dealId/coverage-board", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const deal = res.locals.deal as Deal;
      // (A live sitting with "Seller can see this screen" on always gets the screen board.)
      const sittingId = typeof req.query.sittingId === "string" ? req.query.sittingId : "";
      const sitting = sittingId ? await sittingForDeal(deal.id, sittingId) : null;
      const audience = sitting && sitting.status !== "ended" && sitting.sellerSeesScreen ? "screen" : brokerAudience(req);
      const board = await buildCoverageBoard(deal, { audience });
      res.json(sitting ? withHeldAnswers(board, sitting) : board);
    } catch (err) {
      fail(res, err, "Couldn't load the checklist");
    }
  });

  app.get("/api/deals/:dealId/coverage-board/items/:itemId", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const itemId = itemIdParam(req);
      if (!itemId) return res.status(400).json({ error: "That isn't a checklist item" });
      const sittingId = typeof req.query.sittingId === "string" ? req.query.sittingId : "";
      const sitting = sittingId ? await sittingForDeal(req.params.dealId, sittingId) : null;
      const audience = sitting && sitting.status !== "ended" && sitting.sellerSeesScreen ? "screen" : brokerAudience(req);
      const detail = itemDetail(await loadCoverageInputs(res.locals.deal as Deal), audience, itemId);
      if (!detail) return res.status(404).json({ error: "That data point isn't on the checklist any more." });
      res.json(detail);
    } catch (err) {
      fail(res, err, "Couldn't load that data point");
    }
  });

  app.post("/api/deals/:dealId/coverage-board/items/:itemId/marks", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const itemId = itemIdParam(req);
      if (!itemId) return res.status(400).json({ error: "That isn't a checklist item" });
      const kind = String(req.body?.kind ?? "") as CoverageMarkKind;
      if (!BROKER_MARK_KINDS.includes(kind)) return res.status(400).json({ error: "That isn't a mark the board can set" });
      if ((kind === "doc_promised") !== itemId.startsWith("doc:")) return res.status(400).json({ error: "That mark doesn't fit this item" });
      const note = typeof req.body?.note === "string" ? req.body.note : null;
      if (kind === "note" && !note?.trim()) return res.status(400).json({ error: "Write the note first" });
      if (note && note.length > MARK_NOTE_MAX) return res.status(400).json({ error: "That note is too long" });
      const sectionKey = itemId.includes(":") && !/^(doc|routed):/.test(itemId) ? itemId.split(":")[0] : null;
      await setMark({
        dealId: req.params.dealId,
        itemId,
        kind,
        sectionKey,
        note: kind === "note" ? note : null,
        sittingId: typeof req.body?.sittingId === "string" ? req.body.sittingId.slice(0, 64) : null,
        createdBy: String(req.session.brokerId),
      });
      res.json({ ok: true });
    } catch (err) {
      fail(res, err, "Couldn't save that");
    }
  });

  app.delete("/api/deals/:dealId/coverage-board/items/:itemId/marks/:kind", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const itemId = itemIdParam(req);
      if (!itemId) return res.status(400).json({ error: "That isn't a checklist item" });
      const kind = String(req.params.kind ?? "") as CoverageMarkKind;
      if (!MARK_KINDS.includes(kind) || kind === "asked") return res.status(400).json({ error: "That isn't a mark the board can clear" });
      const cleared = await clearMark(req.params.dealId, itemId, kind);
      res.json({ ok: true, cleared });
    } catch (err) {
      fail(res, err, "Couldn't clear that");
    }
  });

  app.post("/api/deals/:dealId/coverage-board/items/:itemId/confirm", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const itemId = itemIdParam(req);
      if (!itemId || /^(doc|routed):/.test(itemId)) return res.status(400).json({ error: "That isn't a data point" });
      const deal = res.locals.deal as Deal;
      const sittingId = typeof req.body?.sittingId === "string" ? req.body.sittingId.slice(0, 64) : null;
      // In a live session where the seller has spoken since the item was raised,
      // their own words are filed (a focused capture); otherwise "confirmed by you".
      const sitting = sittingId ? await sittingForDeal(deal.id, sittingId) : null;
      if (sitting && sitting.status !== "ended" && filingOn(sitting) && req.body?.mode !== "mark") {
        const chunkId = await fileNow(sitting, itemId).catch(() => null);
        if (chunkId) {
          const part = await partFiled(chunkId, 15_000);
          const board0 = await buildCoverageBoard(deal, { audience: "broker" });
          const item = board0.sections.flatMap((x) => x.items).find((i) => i.id === itemId);
          if (item && filedItem(part, item)) return res.status(200).json({ ok: true, filed: true, chunkId });
          if (!part) return res.status(202).json({ ok: true, pending: true, chunkId });
        }
      }
      const board = await confirmItem(deal, itemId, String(req.session.brokerId), {
        sittingId,
        reload: async () => (await storage.getDeal(deal.id)) ?? deal,
      });
      if (sitting) void publishBoard(deal.id, sitting.id);
      res.json({ ok: true, board });
    } catch (err) {
      fail(res, err, "Couldn't confirm that");
    }
  });

  // ✓ Answered: "auto" files what the seller just said with one focused
  // capture (live capture — pass 3); "note" files what the broker typed as
  // the broker's own call note (never the seller's words, never final).
  app.post("/api/deals/:dealId/coverage-board/items/:itemId/answer", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const itemId = itemIdParam(req);
      if (!itemId || /^(doc|routed):/.test(itemId)) return res.status(400).json({ error: "That isn't a data point" });
      const deal = res.locals.deal as Deal;
      const sittingId = typeof req.body?.sittingId === "string" ? req.body.sittingId : "";
      const sitting = sittingId ? await sittingForDeal(deal.id, sittingId) : null;
      if (!sitting) return res.status(404).json({ error: "That session isn't there any more." });
      if (sitting.status === "ended") return res.status(409).json({ error: "This session has ended. Start a new session to keep going.", code: "ended" });
      const mode = req.body?.mode === "note" ? "note" : "auto";
      const board = await buildCoverageBoard(deal, { audience: "broker" });
      const item = board.sections.flatMap((s) => s.items).find((i) => i.id === itemId);
      if (!item) return res.status(404).json({ error: "That data point isn't on the checklist any more." });
      if (mode === "auto") {
        // ✓ Answered: one focused capture of what the seller just said about it.
        // Nothing to file from, live filing off, the AI down, or no answer in
        // those words → the broker types it (the editor opens on any refusal).
        if (!filingOn(sitting)) return res.status(409).json({ error: "Type what the seller said — it's filed as your note.", code: "no_capture" });
        const chunkId = await fileNow(sitting, itemId);
        if (!chunkId) return res.status(409).json({ error: "Nothing the seller said is waiting to be filed for this one — type it.", code: "no_lines" });
        hub.touch(sitting.id, String(req.session.brokerId));
        const part = await partFiled(chunkId, 15_000);
        if (!part) return res.status(202).json({ ok: true, pending: true, chunkId });
        if (part.status === "failed") return res.status(409).json({ error: "Cimple can't file answers right now — type what the seller said.", code: "ai_unavailable", chunkId });
        if (!filedItem(part, item)) return res.status(409).json({ error: "Cimple couldn't find the answer in what was said — type it?", code: "no_answer", chunkId });
        return res.json({ ok: true, filed: true, chunkId });
      }
      const writable = item.members.filter((m) => m.writable);
      if (writable.length === 0) return res.status(400).json({ error: "This one is your own calculation — change it on the deal's Financials tab.", code: "not_writable" });
      const memberKey = typeof req.body?.memberKey === "string" && writable.some((m) => m.key === req.body.memberKey) ? req.body.memberKey : writable.length === 1 ? writable[0].key : null;
      if (!memberKey) return res.status(400).json({ error: "Pick which of these the answer is.", code: "member_required" });
      const value = typeof req.body?.value === "string" ? req.body.value.trim() : "";
      if (!value) return res.status(400).json({ error: "Type what the seller said first." });
      if (value.length > 400) return res.status(400).json({ error: "Keep it under 400 characters." });
      const result = await writeBrokerCallNotes(deal.id, [{ key: memberKey, value }], { sittingId: sitting.id });
      hub.touch(sitting.id, String(req.session.brokerId));
      void publishBoard(deal.id, sitting.id);
      if (result.written.includes(memberKey)) return res.json({ ok: true, filed: true, result });
      if (result.keptBeside.includes(memberKey)) {
        return res.json({ ok: true, filed: false, keptBeside: true, result, message: "Kept beside what's on file — the seller's own words, a document or your edit stands." });
      }
      const code = result.dropped.find((d) => d.key === memberKey)?.code ?? "dropped";
      const message =
        code === "normalisation" ? "That's a treatment call (an add-back) — it's kept as a private note for you, not as a fact."
          : code === "keep_out" ? "That mentions something the seller asked to keep out of the book — it's held back."
            : code === "staff_private" ? "That's a staff member's private matter — it went to your private notes, not the CIM."
              : "Nothing was filed.";
      return res.status(422).json({ error: message, code, result });
    } catch (err) {
      fail(res, err, "Couldn't save that");
    }
  });

  // ✓ File it: a held possible answer is the seller's (its lines are marked so) — filed with no AI call.
  app.post("/api/deals/:dealId/coverage-board/items/:itemId/file-suggestion", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const itemId = itemIdParam(req);
      if (!itemId) return res.status(400).json({ error: "That isn't a checklist item" });
      const sitting = typeof req.body?.sittingId === "string" ? await sittingForDeal(req.params.dealId, req.body.sittingId) : null;
      if (!sitting) return res.status(404).json({ error: "That session isn't there any more." });
      if (sitting.status === "ended") return res.status(409).json({ error: "This session has ended.", code: "ended" });
      const chunkId = typeof req.body?.chunkId === "string" ? req.body.chunkId : "";
      const held = ((sitting.captureState ?? {}) as { held?: Array<{ itemId: string; chunkId: string; lines: number[] }> }).held ?? [];
      // (Every possible answer held for the item — the board shows them together.)
      const hs = held.filter((x) => x.itemId === itemId);
      if (hs.length === 0 || !hs.some((x) => x.chunkId === chunkId)) return res.status(404).json({ error: "That possible answer isn't there any more." });
      await togetherStore().attestLines(sitting.id, Array.from(new Set(hs.flatMap((x) => x.lines))), new Date());
      const fresh = (await togetherStore().getSitting(sitting.id)) ?? sitting;
      const out = await promoteHeldAnswers(fresh, { only: { itemId } });
      hub.touch(sitting.id, String(req.session.brokerId));
      void publishBoard(req.params.dealId, sitting.id);
      res.json({ ok: true, filed: out.filed > 0 });
    } catch (err) {
      fail(res, err, "Couldn't file that");
    }
  });

  // ── Sittings ───────────────────────────────────────────────────────────

  const sittingOr404 = async (req: Request, res: Response): Promise<TogetherSitting | null> => {
    const s = await sittingForDeal(req.params.dealId, String(req.params.sittingId ?? ""));
    if (!s) {
      res.status(404).json({ error: "That session isn't there any more." });
      return null;
    }
    return s;
  };
  const viewOf = (s: TogetherSitting, chunks?: TogetherChunk[]) => sittingView(s, chunks ? { chunks } : {});

  app.post("/api/deals/:dealId/together/sittings", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const deal = res.locals.deal as Deal;
      const via: TogetherVia = isTogetherVia(req.body?.via) ? req.body.via : "person";
      const brokerId = String(req.session.brokerId);
      const started = await startOrResumeSitting(deal, brokerId, via, {
        endStale: async (stale) => {
          const summary = await currentSummary(stale, deal);
          await togetherStore().updateSitting(stale.id, { summary });
        },
      });
      kickSittingBackground(deal);
      const [board, lines, chunks] = await Promise.all([sittingBoard(deal, started.sitting), togetherStore().lastLines(started.sitting.id, 200), togetherStore().listChunks(started.sitting.id)]);
      rememberBoard(started.sitting.id, board);
      res.json({ sitting: viewOf(started.sitting, chunks), board, lines: lines.map(lineView), resumed: started.resumed, lastClientSeq: null });
    } catch (err) {
      fail(res, err, "Couldn't start the session");
    }
  });

  app.get("/api/deals/:dealId/together/sittings", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const rows = await togetherStore().listSittings(req.params.dealId);
      const out: SittingListRow[] = [];
      for (const s of rows.slice(0, 50)) {
        const summary = s.summary as { filed?: unknown[] } | null;
        out.push({
          id: s.id,
          via: s.via as TogetherVia,
          status: s.status as SittingListRow["status"],
          startedAt: new Date(s.startedAt).toISOString(),
          endedAt: s.endedAt ? new Date(s.endedAt).toISOString() : null,
          durationMin: sittingDurationMin(s),
          filed: Array.isArray(summary?.filed) ? summary!.filed!.length : 0,
          lines: s.lineSeq,
        });
      }
      res.json(out);
    } catch (err) {
      fail(res, err, "Couldn't load the sessions");
    }
  });

  app.get("/api/deals/:dealId/together/sittings/:sittingId", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const s = await sittingOr404(req, res);
      if (!s) return;
      const after = Math.max(0, Number(req.query.afterSeq) || 0);
      const [lines, chunks] = await Promise.all([togetherStore().linesAfter(s.id, after, 500), togetherStore().listChunks(s.id)]);
      res.json({ sitting: viewOf(s, chunks), lines: lines.map(lineView), more: lines.length === 500 });
    } catch (err) {
      fail(res, err, "Couldn't load the session");
    }
  });

  app.get("/api/deals/:dealId/together/sittings/:sittingId/events", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const s = await sittingOr404(req, res);
      if (!s) return;
      hub.subscribe(s.id, req, res, {
        brokerId: String(req.session.brokerId),
        hello: (eventSeq) => ({ type: "hello", eventSeq, sitting: viewOf(s) }),
      });
    } catch (err) {
      if (!res.headersSent) fail(res, err, "Couldn't open the live updates");
    }
  });

  app.get("/api/deals/:dealId/together/sittings/:sittingId/state", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const s = await sittingOr404(req, res);
      if (!s) return;
      hub.touch(s.id, String(req.session.brokerId));
      const after = Math.max(0, Number(req.query.after) || 0);
      const st = hub.stateSince(s.id, after);
      if (!st.reset) return res.json({ eventSeq: st.eventSeq, events: st.events, reset: false });
      // Too far behind: a fresh snapshot (in the sitting's audience).
      const deal = res.locals.deal as Deal;
      const [board, lines] = await Promise.all([sittingBoard(deal, s), togetherStore().lastLines(s.id, 200)]);
      res.json({ eventSeq: st.eventSeq, events: [], reset: true, sitting: viewOf(s), board, lines: lines.map(lineView) });
    } catch (err) {
      fail(res, err, "Couldn't load the live updates");
    }
  });

  app.post("/api/deals/:dealId/together/sittings/:sittingId/consent", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const s = await sittingOr404(req, res);
      if (!s) return;
      const row = await recordConsent(s);
      res.json({ sitting: viewOf(row) });
    } catch (err) {
      fail(res, err, "Couldn't save that");
    }
  });

  app.post("/api/deals/:dealId/together/sittings/:sittingId/lines", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const s = await sittingOr404(req, res);
      if (!s) return;
      const check = validateLinesBody(req.body);
      if (!check.ok) return res.status(400).json({ error: check.error });
      const deal = res.locals.deal as Deal;
      hub.touch(s.id, String(req.session.brokerId));
      const r = await appendLines(s.id, check.clientId, check.lines, {
        deal,
        asks: () => openAsks(deal),
        askItems: () => askItems(deal),
        brokerName: () => brokerDisplayName(s.brokerId),
      });
      res.json({ accepted: r.accepted.length, skipped: r.skipped, lastSeq: r.lastSeq });
    } catch (err) {
      fail(res, err, "Couldn't save what was said");
    }
  });

  app.post("/api/deals/:dealId/together/sittings/:sittingId/speakers", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const s = await sittingOr404(req, res);
      if (!s) return;
      const speaker = typeof req.body?.speaker === "string" ? req.body.speaker : "";
      const role = req.body?.role as SpeakerRole;
      if (!speaker || speaker.length > 64 || !/^[A-Za-z0-9:_\-.]+$/.test(speaker)) return res.status(400).json({ error: "That isn't a speaker on this call." });
      if (role !== "broker" && role !== "seller" && role !== "other") return res.status(400).json({ error: "Say whether it's you, the seller or someone else." });
      const row = await setSpeakerRole(s.id, speaker, role, { deal: res.locals.deal as Deal });
      res.json({ sitting: viewOf(row) });
    } catch (err) {
      fail(res, err, "Couldn't save who that is");
    }
  });

  app.patch("/api/deals/:dealId/together/sittings/:sittingId", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const s = await sittingOr404(req, res);
      if (!s) return;
      if (typeof req.body?.sellerSeesScreen !== "boolean") return res.status(400).json({ error: "Nothing to change." });
      if (s.status === "ended") return res.status(409).json({ error: "This session has ended.", code: "ended" });
      const row = await setSellerSeesScreen(s, req.body.sellerSeesScreen);
      // The board, in the new audience, to every open tab (and the floating window).
      const board = await sittingBoard(res.locals.deal as Deal, row);
      hub.publish(row.id, { type: "board", board });
      res.json({ sitting: viewOf(row), board });
    } catch (err) {
      fail(res, err, "Couldn't change that");
    }
  });

  app.post("/api/deals/:dealId/together/sittings/:sittingId/pause", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const s = await sittingOr404(req, res);
      if (!s) return;
      if (s.status === "ended") return res.json({ sitting: viewOf(s) });
      res.json({ sitting: viewOf(await pauseSitting(s)) });
    } catch (err) {
      fail(res, err, "Couldn't pause");
    }
  });

  app.post("/api/deals/:dealId/together/sittings/:sittingId/resume", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const s = await sittingOr404(req, res);
      if (!s) return;
      hub.touch(s.id, String(req.session.brokerId));
      res.json({ sitting: viewOf(await resumeSitting(s)) });
    } catch (err) {
      fail(res, err, "Couldn't resume");
    }
  });

  app.get("/api/deals/:dealId/together/sittings/:sittingId/summary", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const s = await sittingOr404(req, res);
      if (!s) return;
      if (s.status === "ended" && s.summary) return res.json(s.summary);
      res.json(await currentSummary(s, res.locals.deal as Deal));
    } catch (err) {
      fail(res, err, "Couldn't build the summary");
    }
  });

  app.post("/api/deals/:dealId/together/sittings/:sittingId/end", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const s = await sittingOr404(req, res);
      if (!s) return;
      const body = parseEndBody(req.body);
      if ("error" in body) return res.status(400).json({ error: body.error });
      const out = await endSitting(s, res.locals.deal as Deal, body);
      res.json({ sitting: viewOf(out.sitting), summary: out.summary, followUpsAdded: out.followUpsAdded });
    } catch (err) {
      fail(res, err, "Couldn't end the session");
    }
  });

  // "Save this answer now": the open part is filed now.
  app.post("/api/deals/:dealId/together/sittings/:sittingId/file-now", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const s = await sittingOr404(req, res);
      if (!s) return;
      if (s.status === "ended") return res.status(409).json({ error: "This session has ended.", code: "ended" });
      hub.touch(s.id, String(req.session.brokerId));
      const chunkId = await fileNow(s);
      res.json({ ok: true, chunkId });
    } catch (err) {
      fail(res, err, "Couldn't file that now");
    }
  });

  // Undo one filing (inline for 60 s, then from "Filed this session" and the summary).
  app.post("/api/deals/:dealId/together/sittings/:sittingId/captures/:chunkId/undo", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const s = await sittingOr404(req, res);
      if (!s) return;
      const key = typeof req.body?.key === "string" ? req.body.key : "";
      if (!key || key.length > 64) return res.status(400).json({ error: "Say which value to undo." });
      const chunk = await togetherStore().getChunk(String(req.params.chunkId ?? ""));
      if (!chunk || chunk.sittingId !== s.id) return res.status(404).json({ error: "That filing isn't there any more." });
      await undoCapture({ sitting: s, chunk, key });
      hub.touch(s.id, String(req.session.brokerId));
      await publishBoard(req.params.dealId, s.id);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err, "Couldn't undo that");
    }
  });

  // "Re-file the last 10 minutes" (wrong speakers discovered late — reads them again; costs AI).
  app.post("/api/deals/:dealId/together/sittings/:sittingId/refile", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const s = await sittingOr404(req, res);
      if (!s) return;
      const minutes = Math.max(1, Math.min(30, Number(req.body?.minutes) || 10));
      const out = await refile(s, minutes);
      res.json({ ok: true, ...out });
    } catch (err) {
      fail(res, err, "Couldn't read that part again");
    }
  });

  // "Try now" / "Try again": parts waiting for the AI are tried at once.
  app.post("/api/deals/:dealId/together/sittings/:sittingId/retry", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const s = await sittingOr404(req, res);
      if (!s) return;
      const out = await retryNow(s);
      res.json({ ok: true, ...out });
    } catch (err) {
      fail(res, err, "Couldn't try again");
    }
  });

  app.post("/api/deals/:dealId/together/sittings/:sittingId/follow-up-email", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const s = await sittingOr404(req, res);
      if (!s) return;
      const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length <= 140) : []);
      const out = await sendFollowUpEmail({
        deal: (await storage.getDeal(req.params.dealId)) ?? (res.locals.deal as Deal),
        sitting: s,
        itemIds: ids(req.body?.itemIds),
        documentIds: ids(req.body?.documentIds),
        asks: req.body?.asks && typeof req.body.asks === "object" && !Array.isArray(req.body.asks)
          ? Object.fromEntries(Object.entries(req.body.asks as Record<string, unknown>).filter(([k, v]) => typeof v === "string" && k.length <= 140).slice(0, 50).map(([k, v]) => [k, String(v).slice(0, 400)]))
          : undefined,
        preview: req.body?.preview !== false,
        brokerId: String(req.session.brokerId),
      });
      res.json(out);
    } catch (err) {
      fail(res, err, "Couldn't prepare the email");
    }
  });

  // The seller's "What we've covered" (statuses and counts only — no values,
  // sources, reasons or notes; broker-added labels hidden).
  app.get("/api/seller/:token/coverage", async (req, res) => {
    try {
      const invite = await storage.getSellerInviteByToken(req.params.token);
      if (!invite) return res.status(404).json({ error: "Invite not found" });
      const deal = await storage.getDeal(invite.dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });
      res.json(await buildCoverageBoard(deal, { audience: "seller" }));
    } catch (err) {
      fail(res, err, "Couldn't load your progress");
    }
  });
}

/**
 * A sitting starting builds what the board's asks come from (the industry
 * checklist, section importance and the one-off phrasing pass) in the
 * background. Never with the key off or on a local server
 * with schedulers off; a GET never does this (§7.2).
 */
export function kickSittingBackground(deal: Deal): void {
  if (process.env.ANTHROPIC_API_KEY === "disabled" || process.env.DISABLE_SCHEDULERS === "1") return;
  void import("../interview/section-importance").then(({ ensureSectionImportance }) => ensureSectionImportance(deal as never)).catch(() => undefined);
  // The industry checklist, then its suggested ways to ask (one call per deal, once).
  void import("../interview/interview-plan")
    .then(({ ensureInterviewPlan }) => ensureInterviewPlan(deal as never))
    .then(async () => {
      const fresh = (await storage.getDeal(deal.id)) ?? deal;
      const { ensurePlanPhrasing } = await import("../interview/plan-phrasing");
      return ensurePlanPhrasing(fresh);
    })
    .catch(() => undefined);
}
