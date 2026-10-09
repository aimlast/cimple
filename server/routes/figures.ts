/**
 * Figure notes and due-diligence checks — broker routes (stream "dd", spec §9.2).
 * Every route: requireBroker + requireOwnedDeal; note ids, question ids and
 * check keys are looked up WITH the deal id; GETs never write (a stale deal
 * is refreshed in the background); bodies are Zod-validated; bulk calls are
 * bounded (≤ 200 notes, ≤ 300 checks, ≤ 20 questions).
 *
 *   GET  …/figure-layer?level=        the builder's buyer preview (D21); &audience=buyer = exactly what
 *                                     that version's buyers get (the print preview: approved notes only)
 *   GET  …/figures                    the Numbers & sources workspace
 *   GET  …/figures/status[?counts=1]  poll target while a refresh/build runs (+ the CIM tab's counts)
 *   POST …/figures/refresh            deterministic refresh now ($0)
 *   POST …/figures/build              the AI pass (202; 409 running; 429 daily limit) — aiLimiter
 *   PATCH …/figures/notes/:noteId     approve / hide / restore / use the newer wording / edit (409 on a stale version)
 *   POST …/figures/notes/approve      bulk approve
 *   POST …/figures/notes              the broker's own note
 *   PUT  …/figures/checks             show / leave out / Cimple read it wrong
 *   POST …/figures/checks/show        bulk show
 *   POST …/figures/publish            the review sheet, in one transaction
 *   PUT  …/figures/settings           auto-ask, DD checks on/off
 *   POST …/figures/questions/ask      the one follow-up path (?preview=1 lists without sending)
 *   PATCH …/figures/questions/:id     not needed / reopen
 */
import type { Express, Request, Response } from "express";
import { z } from "zod";
import type { CimSection, Deal } from "@shared/schema";
import { requireBroker, requireOwnedDeal } from "../broker-auth/routes.js";
import { storage } from "../storage";
import { buildBuyerCim } from "@shared/cim-buyer-view";
import { cimModeForAccessLevel, isTeaserOnly, parseAccessLevelInput, DD_ACCESS_LEVEL, sameAccessLevel } from "@shared/access-levels";
import { DD_SOURCE_CHECK_PAGE_ID } from "@shared/figure-layer";
import { figureKey as figureKeyOf, parseFigureKey } from "@shared/figure-lines";
import { anchorFigures } from "@shared/figure-anchors";
import { captureKeyFor } from "@shared/figure-explain";
import { listedAskingPrice } from "../information/deal-mirror";
import { loadMediaAssets } from "../cim/media-store";
import { figureInputsFor, invalidateFigureRaw, loadFigureRaw, type FigureRaw } from "../cim/figures/serve";
import {
  approveNotes, brokerUpdateNote, figureCounts, getFigureState, getNote, getQuestion, inFigureTransaction, insertQuestionIfAbsent,
  listDecisions, putDecision, setAutoAsk, setDdShown, updateQuestionIf, upsertBrokerNote, withFigureLock,
} from "../cim/figures/store";
import { refreshFingerprint, runFigureRefresh, scheduleFigureRefresh } from "../cim/figures/refresh";
import { dailyLimitReached, effectiveBuild, figureBuildRunning, guardCtxFor, startFigureBuild } from "../cim/figures/build";
import { guardBrokerText } from "../cim/figures/guards";
import { buildWorkspace } from "../cim/figures/workspace";
import { autoAskEffective, closeAnsweredQuestions, lineWordOf, questionWording, sellerValues, planExplainQuestions } from "../cim/figures/requests";
import { movedEnough, previousOf } from "../cim/figures/computed";
import { sendSellerFollowUps } from "../interview/seller-followups";

const BASE = "/api/deals/:dealId";

/** At most one manual refresh per deal every 30 s (a second click joins the running one). */
const lastManual = new Map<string, number>();

const brokerOf = (req: Request) => String(req.session.brokerId ?? "");

function badBody(res: Response, err: z.ZodError) {
  return res.status(400).json({ error: "Something in the request isn't right.", issues: err.issues.slice(0, 5).map((i) => i.message) });
}

/** The guard context for broker text on this deal (no AI). */
function brokerGuardCtx(deal: Deal, raw: FigureRaw) {
  const lineLabels = Object.values(raw.registry).filter((f) => String(f.line).startsWith("line:")).map((f) => f.lineLabel);
  return guardCtxFor(deal, raw.info, raw.state?.keepOut?.names ?? [], lineLabels);
}

/** The candidate figures a note is about (for the "Your figure" warning). */
function noteCandidate(raw: FigureRaw, figureKey: string, kind: string, compareKey: string) {
  const fig = raw.registry[figureKey];
  if (!fig) return undefined;
  const prev = kind === "movement" ? raw.registry[figureKeyOf(fig.line, compareKey || String(Number(fig.year) - 1))] : undefined;
  const check = kind === "difference" ? raw.checks.checks.find((c) => c.key === `${figureKey}~${compareKey}`) : undefined;
  return { id: figureKey, value: fig.value, ...(prev ? { fromValue: prev.value } : {}), ...(check ? { other: check.other } : {}) };
}

/** Is a check one buyers may be shown (D9a and D11 refuse)? */
function showRefusal(raw: FigureRaw, checkKey: string): string | null {
  const c = raw.checks.checks.find((x) => x.key === checkKey);
  if (!c) return "That check isn't on this deal any more.";
  if (c.kind === "cim_statements") return "This compares the CIM with its own statements; fix the figure on the Financials tab instead.";
  if (raw.checks.checks.some((x) => x.figureKey === c.figureKey && x.kind === "cim_statements" && x.cimMismatch)) return "Your CIM differs from the statements on this figure. Fix it first.";
  if (!c.located && !["match", "rounding"].includes(c.size)) return "Cimple couldn't find this figure in the document. Check the document first.";
  return null;
}

export function registerFigureRoutes(app: Express): void {
  /**
   * The broker's preview of a buyer version: the figure layer over exactly the
   * sections the builder previews (working copy + that version's overrides),
   * with everything shown and `preview` marks on what buyers don't see yet.
   * Returns the extra page ("How the figures check out") to insert in DD.
   */
  app.get(`${BASE}/figure-layer`, requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const deal = res.locals.deal as Deal;
      const level = parseAccessLevelInput(req.query.level);
      if (!level) return res.status(400).json({ error: "Choose which buyer to preview as." });
      if (isTeaserOnly(level)) return res.json({ layer: null, extraSections: [], refreshing: false });
      const mode = cimModeForAccessLevel(level);
      const [raw, sections, overrides, media, state, fingerprint] = await Promise.all([
        loadFigureRaw(deal.id),
        storage.getCimSectionsByDeal(deal.id),
        mode === "normal" ? Promise.resolve([]) : storage.getCimSectionOverrides(deal.id, mode),
        loadMediaAssets(deal.id),
        getFigureState(deal.id),
        refreshFingerprint(deal.id),
      ]);
      const { withGlLines } = await import("../cim/figures/gl-contract");
      const audience = req.query.audience === "buyer" ? "buyer" : "broker";
      const base = figureInputsFor(raw, { audience, mode });
      const figures = mode === "blind" ? base : await withGlLines(base, deal.id, raw.bridgeLines);
      // The level as the client sent it (validated above): legacy keys
      // ("loi", "full") and new ones read the same through the registry.
      const view = buildBuyerCim({
        deal, accessLevel: String(req.query.level), sections: sections as CimSection[], overrides, media, askingPrice: listedAskingPrice(deal), figures,
      });
      const stale = state?.refreshedFingerprint !== fingerprint;
      // Never a write in a GET: a stale deal is refreshed in the background.
      if (stale) scheduleFigureRefresh(deal.id, "preview");
      const i = view.sections.findIndex((s) => s.id === DD_SOURCE_CHECK_PAGE_ID);
      const extraSections = i >= 0 ? [{ afterId: i > 0 ? view.sections[i - 1].id : null, section: view.sections[i] }] : [];
      res.json({
        layer: view.figureLayer,
        extraSections,
        refreshing: stale,
        ...(view.figureLayerDropped ? { dropped: view.figureLayerDropped } : {}),
        noFigures: raw.noFigures,
        hasOtherRecords: raw.sources.some((s) => s.kind !== "statements"),
      });
    } catch (err) {
      console.error("[figures] preview layer", err);
      res.status(500).json({ error: "Couldn't load the figure notes for this preview." });
    }
  });

  /** The Numbers & sources workspace (read-only). */
  app.get(`${BASE}/figures`, requireBroker, requireOwnedDeal, async (_req, res) => {
    try {
      const deal = res.locals.deal as Deal;
      const [raw, sections, state, fingerprint, access, ddOverrides, decisions] = await Promise.all([
        loadFigureRaw(deal.id),
        storage.getCimSectionsByDeal(deal.id),
        getFigureState(deal.id),
        refreshFingerprint(deal.id),
        storage.getBuyerAccessByDeal(deal.id),
        storage.getCimSectionOverrides(deal.id, "dd"),
        listDecisions(deal.id),
      ]);
      const stale = state?.refreshedFingerprint !== fingerprint;
      if (stale) scheduleFigureRefresh(deal.id, "workspace");
      const ws = buildWorkspace({
        raw,
        sections: (sections as CimSection[]).filter((s) => s.isVisible !== false),
        build: effectiveBuild(state?.build ?? null, figureBuildRunning(deal.id)),
        autoAsk: autoAskEffective(state?.autoAsk, deal.createdAt),
        autoAskChosen: typeof state?.autoAsk === "boolean",
        stale,
        ddBuyers: access.filter((a: any) => !a.revokedAt && sameAccessLevel(a.accessLevel, DD_ACCESS_LEVEL)).length,
        dailyLimit: dailyLimitReached(state),
        oldDdWording: (ddOverrides as any[]).some((o) => /\[\[dd\]\][^[]*verif/i.test(JSON.stringify(o.layoutData ?? o.content ?? ""))),
        leftOutReasons: Object.fromEntries(decisions.filter((d) => d.state === "left_out" && d.reason).map((d) => [d.checkKey, d.reason!])),
      });
      res.json(ws);
    } catch (err) {
      console.error("[figures] workspace", err);
      res.status(500).json({ error: "Couldn't load the numbers and sources." });
    }
  });

  app.get(`${BASE}/figures/status`, requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const deal = res.locals.deal as Deal;
      const state = await getFigureState(deal.id);
      const base = {
        build: effectiveBuild(state?.build ?? null, figureBuildRunning(deal.id)),
        refreshedAt: state?.refreshedAt ?? null,
        version: state?.updatedAt ?? null,
        ddShownAt: state?.ddShownAt ?? null,
      };
      if (req.query.counts !== "1") return res.json(base);
      res.json({ ...base, counts: await figureCounts(deal.id) });
    } catch (err) {
      console.error("[figures] status", err);
      res.status(500).json({ error: "Couldn't load the status." });
    }
  });

  app.post(`${BASE}/figures/refresh`, requireBroker, requireOwnedDeal, async (_req, res) => {
    const deal = res.locals.deal as Deal;
    const last = lastManual.get(deal.id) ?? 0;
    if (Date.now() - last < 30_000) {
      runFigureRefresh(deal.id).catch(() => {});
      return res.status(202).json({ started: false, running: true });
    }
    lastManual.set(deal.id, Date.now());
    try {
      const r = await runFigureRefresh(deal.id);
      await planExplainQuestions(deal.id);
      res.json({ ok: true, located: r.located, written: r.written, proposals: r.proposals, removed: r.removed });
    } catch (err) {
      console.error("[figures] refresh", err);
      res.status(500).json({ error: "Cimple couldn't check the numbers just now. Try again in a minute." });
    }
  });

  const BuildBody = z.object({ scope: z.enum(["changed", "all"]).optional() }).strict();
  app.post(`${BASE}/figures/build`, requireBroker, requireOwnedDeal, async (req, res) => {
    const parsed = BuildBody.safeParse(req.body ?? {});
    if (!parsed.success) return badBody(res, parsed.error);
    const deal = res.locals.deal as Deal;
    try {
      if (figureBuildRunning(deal.id)) return res.status(409).json({ code: "running", error: "Cimple is already reading for reasons on this deal." });
      const state = await getFigureState(deal.id);
      if (dailyLimitReached(state)) {
        return res.status(429).json({ code: "daily_limit", error: "Cimple has checked this deal's numbers 4 times today. You can still write reasons yourself or use Cimple's suggestions; checking again works tomorrow." });
      }
      const r = startFigureBuild(deal.id, { reason: "broker", scope: parsed.data.scope ?? "changed" });
      r.done.catch(() => {});
      res.status(202).json({ started: r.started, startedAt: new Date().toISOString() });
    } catch (err) {
      console.error("[figures] build", err);
      res.status(500).json({ error: "Couldn't start reading for reasons. Try again in a minute." });
    }
  });

  // ── Notes ───────────────────────────────────────────────────────────────

  const NotePatch = z.object({
    version: z.string().min(10).max(40),
    action: z.enum(["approve", "hide", "restore", "use_proposal"]).optional(),
    text: z.string().max(320).optional(),
    blindText: z.string().max(320).nullable().optional(),
  }).strict();
  app.patch(`${BASE}/figures/notes/:noteId`, requireBroker, requireOwnedDeal, async (req, res) => {
    const parsed = NotePatch.safeParse(req.body ?? {});
    if (!parsed.success) return badBody(res, parsed.error);
    const deal = res.locals.deal as Deal;
    const body = parsed.data;
    try {
      const note = await getNote(deal.id, req.params.noteId);
      if (!note) return res.status(404).json({ error: "That note isn't on this deal." });
      let warnings: Array<{ field: string; message: string }> = [];
      if (body.text !== undefined || body.blindText !== undefined) {
        const raw = await loadFigureRaw(deal.id);
        const g = guardBrokerText(body.text ?? note.text, body.blindText === undefined ? note.blindText : body.blindText, brokerGuardCtx(deal, raw), {
          candidate: noteCandidate(raw, note.figureKey, note.kind, note.compareKey),
          quotes: (note.sources ?? []).map((s) => s.quote ?? "").filter(Boolean),
        });
        if (!g.ok) return res.status(422).json({ field: g.field, message: g.message });
        warnings = g.warnings;
      }
      if (body.action === "approve" && note.staleReason === "seller_flagged" && body.text === undefined) {
        return res.status(422).json({ field: "text", message: "The owner asked for a change. Edit the wording (or restore it) before showing it again." });
      }
      const r = await withFigureLock(deal.id, () => brokerUpdateNote(deal.id, note.id, body.version, {
        action: body.action, text: body.text, blindText: body.blindText, by: brokerOf(req),
      }));
      if (r === "not_found") return res.status(404).json({ error: "That note isn't on this deal." });
      if (r === "conflict") return res.status(409).json({ error: "This note changed while you were editing. Reload to see the latest." });
      invalidateFigureRaw(deal.id);
      if (body.action === "approve") await closeAnsweredQuestions(deal.id);
      res.json({ note: r, warnings });
    } catch (err) {
      console.error("[figures] note patch", err);
      res.status(500).json({ error: "Couldn't save the note." });
    }
  });

  const BulkApprove = z.object({ ids: z.array(z.string().min(1).max(64)).min(1).max(200) }).strict();
  app.post(`${BASE}/figures/notes/approve`, requireBroker, requireOwnedDeal, async (req, res) => {
    const parsed = BulkApprove.safeParse(req.body ?? {});
    if (!parsed.success) return badBody(res, parsed.error);
    const deal = res.locals.deal as Deal;
    try {
      const r = await withFigureLock(deal.id, () => approveNotes(deal.id, parsed.data.ids.map((id) => ({ id })), brokerOf(req)));
      invalidateFigureRaw(deal.id);
      await closeAnsweredQuestions(deal.id);
      res.json({ approved: r.approved.length, skipped: r.skipped });
    } catch (err) {
      console.error("[figures] bulk approve", err);
      res.status(500).json({ error: "Couldn't show those notes." });
    }
  });

  const NewNote = z.object({
    figureKey: z.string().min(3).max(200),
    kind: z.enum(["movement", "difference", "context"]),
    compareKey: z.string().max(120).optional(),
    text: z.string().min(1).max(320),
    blindText: z.string().max(320).nullable().optional(),
    fromHint: z.boolean().optional(),
    fromQuestionId: z.string().max(64).optional(),
  }).strict();
  app.post(`${BASE}/figures/notes`, requireBroker, requireOwnedDeal, async (req, res) => {
    const parsed = NewNote.safeParse(req.body ?? {});
    if (!parsed.success) return badBody(res, parsed.error);
    const deal = res.locals.deal as Deal;
    const body = parsed.data;
    try {
      const raw = await loadFigureRaw(deal.id);
      const fig = raw.registry[body.figureKey];
      if (!fig) return res.status(400).json({ error: "That figure isn't in this deal's numbers." });
      let compareKey = body.compareKey ?? "";
      let fromValue: number | undefined;
      let other: number | undefined;
      if (body.kind === "movement") {
        const prev = compareKey ? raw.registry[figureKeyOf(fig.line, compareKey)] : previousOf(raw.registry, fig);
        if (!prev) return res.status(400).json({ error: "There's no earlier year to compare this figure with." });
        compareKey = prev.year;
        fromValue = prev.value;
      } else if (body.kind === "difference") {
        const check = raw.checks.checks.find((c) => c.key === `${body.figureKey}~${compareKey}`);
        if (!check) return res.status(400).json({ error: "That comparison isn't on this deal." });
        other = check.other;
      } else {
        compareKey = "";
      }
      const question = body.fromQuestionId ? await getQuestion(deal.id, body.fromQuestionId) : null;
      const candidate = { id: body.figureKey, value: fig.value, ...(fromValue !== undefined ? { fromValue } : {}), ...(other !== undefined ? { other } : {}) };
      const answer = question ? String(raw.info[question.captureKey] ?? "") : "";
      const g = guardBrokerText(body.text, body.blindText ?? null, brokerGuardCtx(deal, raw), { candidate, quotes: answer ? [answer] : [] });
      if (!g.ok) return res.status(422).json({ field: g.field, message: g.message });
      const sources = [
        ...(body.fromHint ? [{ kind: "hint" as const }] : []),
        ...(question && answer ? [{ kind: "fact" as const, factKey: question.captureKey, quote: answer.slice(0, 240) }] : []),
      ];
      const note = await withFigureLock(deal.id, () => upsertBrokerNote(deal.id, {
        figureKey: body.figureKey, kind: body.kind, compareKey, text: body.text.trim(), blindText: body.blindText?.trim() || null, sources,
        valuesSnapshot: { year: fig.year, value: fig.value, ...(fromValue !== undefined ? { fromYear: compareKey, fromValue } : {}), ...(other !== undefined ? { other } : {}) },
        by: brokerOf(req),
      }));
      if (question) await updateQuestionIf(deal.id, question.id, ["suggested", "ask_seller", "asked", "answered"], { status: "closed", closedReason: "written_by_broker" });
      invalidateFigureRaw(deal.id);
      await closeAnsweredQuestions(deal.id);
      res.json({ note, warnings: g.warnings });
    } catch (err) {
      console.error("[figures] new note", err);
      res.status(500).json({ error: "Couldn't save the note." });
    }
  });

  // ── Checks ──────────────────────────────────────────────────────────────

  const CheckPut = z.object({
    checkKey: z.string().min(3).max(300),
    state: z.enum(["shown", "left_out", "corrected"]),
    reason: z.string().max(300).optional(),
    correctedValue: z.number().finite().optional(),
  }).strict();
  app.put(`${BASE}/figures/checks`, requireBroker, requireOwnedDeal, async (req, res) => {
    const parsed = CheckPut.safeParse(req.body ?? {});
    if (!parsed.success) return badBody(res, parsed.error);
    const deal = res.locals.deal as Deal;
    const body = parsed.data;
    try {
      const raw = await loadFigureRaw(deal.id);
      const check = raw.checks.checks.find((c) => c.key === body.checkKey);
      if (!check) return res.status(404).json({ error: "That check isn't on this deal." });
      if (body.state === "left_out" && !(body.reason && body.reason.trim().length >= 1)) return res.status(422).json({ field: "reason", message: "Say why it's left out (only you see this)." });
      if (body.state === "corrected" && typeof body.correctedValue !== "number") return res.status(422).json({ field: "correctedValue", message: "Enter what the document actually says." });
      if (body.state === "shown") {
        const refusal = showRefusal(raw, body.checkKey);
        if (refusal) return res.status(422).json({ field: "state", message: refusal });
      }
      await withFigureLock(deal.id, () => putDecision(deal.id, {
        checkKey: body.checkKey, state: body.state, reason: body.state === "left_out" ? body.reason!.trim() : null,
        correctedValue: body.state === "corrected" ? body.correctedValue! : null,
        valuesSnapshot: { base: check.base, other: check.other }, by: brokerOf(req),
      }));
      invalidateFigureRaw(deal.id);
      scheduleFigureRefresh(deal.id, "check decision");
      res.json({ ok: true });
    } catch (err) {
      console.error("[figures] check decision", err);
      res.status(500).json({ error: "Couldn't save that." });
    }
  });

  const ShowChecks = z.object({ keys: z.array(z.string().min(3).max(300)).min(1).max(300) }).strict();
  app.post(`${BASE}/figures/checks/show`, requireBroker, requireOwnedDeal, async (req, res) => {
    const parsed = ShowChecks.safeParse(req.body ?? {});
    if (!parsed.success) return badBody(res, parsed.error);
    const deal = res.locals.deal as Deal;
    try {
      const raw = await loadFigureRaw(deal.id);
      const refused: Array<{ key: string; reason: string }> = [];
      let shown = 0;
      await withFigureLock(deal.id, async () => {
        for (const key of Array.from(new Set(parsed.data.keys))) {
          const refusal = showRefusal(raw, key);
          if (refusal) { refused.push({ key, reason: refusal }); continue; }
          const c = raw.checks.checks.find((x) => x.key === key)!;
          await putDecision(deal.id, { checkKey: key, state: "shown", reason: null, correctedValue: null, valuesSnapshot: { base: c.base, other: c.other }, by: brokerOf(req) });
          shown++;
        }
      });
      invalidateFigureRaw(deal.id);
      res.json({ shown, refused });
    } catch (err) {
      console.error("[figures] show checks", err);
      res.status(500).json({ error: "Couldn't show those checks." });
    }
  });

  /** The review sheet: approve notes, show checks and turn the DD checks on — one transaction. */
  const Publish = z.object({
    notes: z.array(z.object({ id: z.string().min(1).max(64), fingerprint: z.string().max(80).optional() }).strict()).max(200),
    checkKeys: z.array(z.string().min(3).max(300)).max(300),
    leaveOut: z.array(z.string().min(3).max(300)).max(300).optional(),
    turnOnChecks: z.boolean(),
  }).strict();
  app.post(`${BASE}/figures/publish`, requireBroker, requireOwnedDeal, async (req, res) => {
    const parsed = Publish.safeParse(req.body ?? {});
    if (!parsed.success) return badBody(res, parsed.error);
    const deal = res.locals.deal as Deal;
    const body = parsed.data;
    try {
      const raw = await loadFigureRaw(deal.id);
      const by = brokerOf(req);
      const refused: Array<{ key: string; reason: string }> = [];
      const result = await withFigureLock(deal.id, () => inFigureTransaction(async (tx) => {
        const notes = await approveNotes(deal.id, body.notes.map((n) => ({ id: n.id, fingerprint: n.fingerprint ?? null })), by, tx, { allowInternal: true });
        let shown = 0;
        for (const key of Array.from(new Set(body.checkKeys))) {
          const refusal = showRefusal(raw, key);
          if (refusal) { refused.push({ key, reason: refusal }); continue; }
          const c = raw.checks.checks.find((x) => x.key === key)!;
          await putDecision(deal.id, { checkKey: key, state: "shown", reason: null, correctedValue: null, valuesSnapshot: { base: c.base, other: c.other }, by }, tx);
          shown++;
        }
        let leftOut = 0;
        for (const key of Array.from(new Set(body.leaveOut ?? []))) {
          const c = raw.checks.checks.find((x) => x.key === key);
          if (!c) continue;
          await putDecision(deal.id, { checkKey: key, state: "left_out", reason: "Unticked in Review and show to buyers", correctedValue: null, valuesSnapshot: { base: c.base, other: c.other }, by }, tx);
          leftOut++;
        }
        if (body.turnOnChecks) await setDdShown(deal.id, new Date(), by, tx);
        return { approved: notes.approved.length, skippedNotes: notes.skipped, shown, leftOut };
      }));
      invalidateFigureRaw(deal.id);
      await closeAnsweredQuestions(deal.id);
      res.json({ ...result, refused, checksOn: body.turnOnChecks });
    } catch (err) {
      console.error("[figures] publish", err);
      res.status(500).json({ error: "Nothing was changed. Try again in a moment." });
    }
  });

  const Settings = z.object({ autoAsk: z.boolean().optional(), ddChecksOn: z.boolean().optional() }).strict();
  app.put(`${BASE}/figures/settings`, requireBroker, requireOwnedDeal, async (req, res) => {
    const parsed = Settings.safeParse(req.body ?? {});
    if (!parsed.success) return badBody(res, parsed.error);
    const deal = res.locals.deal as Deal;
    try {
      if (parsed.data.autoAsk !== undefined) await setAutoAsk(deal.id, parsed.data.autoAsk);
      if (parsed.data.ddChecksOn !== undefined) await setDdShown(deal.id, parsed.data.ddChecksOn ? new Date() : null, parsed.data.ddChecksOn ? brokerOf(req) : null);
      invalidateFigureRaw(deal.id);
      if (parsed.data.autoAsk) void planExplainQuestions(deal.id);
      res.json({ ok: true });
    } catch (err) {
      console.error("[figures] settings", err);
      res.status(500).json({ error: "Couldn't save that setting." });
    }
  });

  // ── Questions for the seller ────────────────────────────────────────────

  const Ask = z.object({
    questionIds: z.array(z.string().min(1).max(64)).max(20).optional(),
    figureKeys: z.array(z.string().min(3).max(200)).max(20).optional(),
  }).strict();
  app.post(`${BASE}/figures/questions/ask`, requireBroker, requireOwnedDeal, async (req, res) => {
    const parsed = Ask.safeParse(req.body ?? {});
    if (!parsed.success) return badBody(res, parsed.error);
    const deal = res.locals.deal as Deal;
    const preview = req.query.preview === "1";
    try {
      const ids = new Set(parsed.data.questionIds ?? []);
      const notYet: string[] = [];
      // "Ask the seller" on a figure with no question yet: make one (seller wording, statements as issued) — in a preview, only list it.
      for (const key of parsed.data.figureKeys ?? []) {
        const r = await questionForFigure(deal, key, preview);
        if (r.id) ids.add(r.id);
        else if (preview && r.label) notYet.push(r.label);
      }
      const r = await sendSellerFollowUps(deal.id, { questionIds: Array.from(ids).slice(0, 20), includeNeverAsked: true, preview });
      const listed = preview && notYet.length > 0 ? [...notYet.map((label) => ({ kind: "figure" as const, label })), ...r.listed] : r.listed;
      res.json({ ...r, listed, questionIds: Array.from(ids) });
    } catch (err) {
      console.error("[figures] ask", err);
      res.status(500).json({ error: "Couldn't send the questions. Try again in a moment." });
    }
  });

  const QuestionPatch = z.object({ action: z.enum(["not_needed", "reopen"]) }).strict();
  app.patch(`${BASE}/figures/questions/:id`, requireBroker, requireOwnedDeal, async (req, res) => {
    const parsed = QuestionPatch.safeParse(req.body ?? {});
    if (!parsed.success) return badBody(res, parsed.error);
    const deal = res.locals.deal as Deal;
    try {
      const q = await getQuestion(deal.id, req.params.id);
      if (!q) return res.status(404).json({ error: "That question isn't on this deal." });
      const ok = parsed.data.action === "not_needed"
        ? await updateQuestionIf(deal.id, q.id, ["suggested", "ask_seller", "asked", "answered"], { status: "closed", closedReason: "not_needed" })
        : await updateQuestionIf(deal.id, q.id, ["closed", "asked"], { status: "suggested", closedReason: null, routedAt: null, routedBy: null });
      if (!ok) return res.status(409).json({ error: "This question changed meanwhile. Reload to see the latest." });
      invalidateFigureRaw(deal.id);
      res.json({ ok: true });
    } catch (err) {
      console.error("[figures] question patch", err);
      res.status(500).json({ error: "Couldn't save that." });
    }
  });
}

/**
 * The question for one figure's movement (the broker's "Ask the seller" on a
 * row with none yet). Returns its id (an existing one for the same figure, or
 * a new suggested row). In a preview nothing is written (null when none exists).
 */
async function questionForFigure(deal: Deal, key: string, preview: boolean): Promise<{ id: string | null; label: string | null }> {
  const parsed = parseFigureKey(key);
  if (!parsed) return { id: null, label: null };
  const raw = await loadFigureRaw(deal.id);
  const fig = raw.registry[key];
  if (!fig) return { id: null, label: null };
  const prev = previousOf(raw.registry, fig);
  const existing = raw.questions.find((q) => q.figureKey === key && q.kind === "movement" && q.status !== "closed");
  if (existing) return { id: existing.id, label: null };
  if (!prev || !movedEnough(prev.value, fig.value)) return { id: null, label: null };
  const label = `${lineWordOf({ line: fig.line, lineLabel: fig.lineLabel })} ${fig.year}`;
  if (preview) return { id: null, label };
  const candidate = {
    key: `${key}|movement|${prev.year}`, figureKey: key, kind: "movement" as const, compareKey: prev.year, line: fig.line, lineLabel: fig.lineLabel,
    year: fig.year, value: fig.value, fromYear: prev.year, fromValue: prev.value, weight: 0, total: !!fig.total, valuesFingerprint: "",
  };
  const { db } = await import("../db");
  const { documents } = await import("@shared/schema");
  const { inArray } = await import("drizzle-orm");
  const st = raw.sources.filter((s) => s.kind === "statements");
  const texts = st.length > 0
    ? await db.select({ id: documents.id, extractedText: documents.extractedText }).from(documents).where(inArray(documents.id, st.map((s) => s.documentId)))
    : [];
  const byId = new Map(texts.map((t: { id: string; extractedText: string | null }) => [t.id, t.extractedText]));
  const id = await insertQuestionIfAbsent(deal.id, {
    figureKey: key, kind: "movement", compareKey: prev.year, captureKey: captureKeyFor(fig.lineLabel, "movement", fig.year),
    question: questionWording(candidate),
    valuesShown: sellerValues(candidate, st.map((source) => ({ source, text: byId.get(source.documentId) ?? null })), raw.checks.checks),
    status: "suggested", routedBy: null,
  });
  invalidateFigureRaw(deal.id);
  if (id) return { id, label };
  const again = (await loadFigureRaw(deal.id)).questions.find((q) => q.figureKey === key && q.kind === "movement");
  return { id: again?.id ?? null, label };
}

// (anchorFigures is used by the workspace builder; re-exported here for scripts.)
export { anchorFigures };
