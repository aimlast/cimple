/**
 * Data room (VDR) broker routes — vdr spec §9.2. Registered from
 * server/routes.ts. No AI, no email.
 *
 * Every route: requireBroker + the deal must be the session broker's (404
 * otherwise). Every id a request carries — in the path (folder, item,
 * access), the query (`as=`, `item=`) or the body (documentId, folderId,
 * itemIds[], allow[] / deny[], beforeItemId) — must belong to `:dealId`,
 * else 404, so a brokerage can never touch another's rows by id.
 *
 *   GET    /api/vdr/health                                (Wave 0 canary)
 *   GET    /api/deals/:dealId/data-room                   the tab's payload
 *   POST   …/data-room/setup                              { mode: "auto" | "empty" }
 *   GET    …/data-room/plan · POST …/data-room/plan       the sharing plan
 *   PATCH  …/data-room/settings                           { status?, autoAddNew? }
 *   POST   …/data-room/folders · PATCH/DELETE …/folders/:folderId
 *   POST   …/data-room/items                              { documentId, folderId? }
 *   PATCH  …/data-room/items/:itemId                      title, downloads, description
 *   POST   …/data-room/items/:itemId/checked              { flags }
 *   POST   …/data-room/items/move                         { itemIds, folderId, beforeItemId? }
 *   DELETE …/data-room/items/:itemId                      take it out of the room
 *   POST   …/data-room/items/:itemId/restore · /share-like-replaced · /prepare
 *   POST/DELETE …/data-room/items/:itemId/clean-copy
 *   GET    …/data-room/audience                           who documents can be shared with
 *   PUT    …/data-room/items/:itemId/shares               the Share dialog
 *   POST   …/data-room/shares/bulk                        several items or a folder
 *   GET    …/data-room/dd-cited · POST …/data-room/share-dd-cited
 *   POST   …/data-room/upload                             multipart file, folderId, read
 *   GET    …/data-room/buyers · PATCH …/data-room/buyers/:accessId
 *   GET    …/data-room/items/:itemId/view|pages/:n|sheet|html|text|download   (?as=<accessId>)
 *   GET    …/data-room/preview/:accessId[/items/:itemId]  what one buyer sees
 *   GET    …/data-room/activity?item=                     one document's readers (the drawer)
 *   GET    …/data-room/resolve?documentIds=               citation chips in the broker's CIM preview
 *   POST   …/data-room/buyers/:accessId/team              add someone from their team { name, email, role, send }
 *   PATCH  …/data-room/team/:memberId                     { action: approve | decline | remove | resend | new_link, send? }
 */
import type { Express, NextFunction, Request, Response } from "express";
import fs from "fs";
import path from "path";
import multer from "multer";
import type { BuyerAccess, BuyerQuestion, CimSection, Deal, DealDocumentRequirement, Discrepancy, InsertDealDocumentRequirement, InsertVdrActivity, VdrFolder, VdrItem, VdrRequest } from "@shared/schema";
import { DD_ACCESS_LEVEL, parseAccessLevelInput, sameAccessLevel } from "@shared/access-levels";
import {
  VDR_LIMITS,
  basicDescription,
  buyerKey,
  dataRoomLevelRule,
  extensionOf,
  folderDepth,
  isRoomMaterial,
  notRoomMaterialReason,
  presetFolder,
  shareSummary,
  watermarkFooter,
  watermarkLine,
  indexNumbers,
  ineligibleCopy,
  isNewForBuyer,
  roomIneligibleReason,
  type VdrAction,
  type VdrFlagKey,
} from "@shared/vdr";
import type { ActivityPayload, BulkShareResult, EmailDraft, ItemNotesPayload, SharingPlanPayload, WaitingPayload } from "@shared/vdr-api";
import { requireBroker } from "../broker-auth/routes.js";
import { vdrHealth } from "../vdr/health";
import { dbVdrStore, logVdrQuietly, type VdrStore } from "../vdr/store";
import { decideItems, flagsFor, gateForLink, isLedgerItemDoc, itemFor, loadRoom, VdrHttpError, type GateDeps } from "../vdr/access";
import {
  buildBuyers,
  currentShareInput,
  groupBuyers,
  itemRow,
  loadBrokerContext,
  parseShareBody,
  readersOf,
  roomPayload,
  shareAudience,
  validateShares,
  roomAndWaiting,
  LEDGER_DD_ONLY,
  type BrokerDeps,
  type ShareInput,
} from "../vdr/broker-room";
import { buyerAboutExtras, buyerItemAbout, buyerRoomPayload } from "../vdr/buyer-room";
import { recommendedPlan } from "../vdr/auto-file";
import { fileDocumentIntoRoom, restoreItem, setUpRoom, shareLikeReplaced, defaultSetupDeps, type SetupDeps } from "../vdr/setup";
import { ensurePrepared, enqueuePrepare } from "../vdr/prepare";
import { cleanCopyPath, cleanCopyRelPath, newPrivateName, removeCleanCopy, removeItemCache } from "../vdr/files";
import { decisionFor, docHtml, docText, kickPrepare, manifestFor, pageImage, ServeError, sheetRows, defaultServeDeps, type ServeDeps } from "../vdr/serve";
import { brokerChecks, documentCimLinks, documentFacts, documentQuestions, keyFigureRank, privateMattersByDocument, sectionText } from "../vdr/analysis";
import { ddCitedDocumentIds, ddDocumentChecks } from "../vdr/dd-adapter";
import { parseDocumentIds, replacementsFor, resolveForBroker } from "../vdr/resolve";
import { locateInItem } from "../vdr/locate";
import { askSeller, brokerRequestRows, declineRequests, markShared, parseNeededBy, type RequestDeps } from "../vdr/requests";
import { askerLabel } from "../vdr/todo";
import { activityByBuyer, activityByDocument, activityCsv, activityLog, findTrace, labelForKey, LOG_ACTION_FILTERS, type LogFilter, type ReportContext } from "../vdr/activity-report";
import { newDocumentFileName, resolveDocumentPath, uploadsRoot } from "../documents/document-path";
import { decodeUploadName } from "../documents/upload";
import { emailSellerAboutRequests, letBuyersKnowDraft, sendBrokerEmailToBuyers, sendTeamLinkEmail, tellBuyerDraft, type BuyerEmailDeps, type SellerEmailDeps } from "../vdr/emails";
import { TEAM_MAX, newTeamToken, parseTeamInput, principalCompanyOf, teamAddProblem, teamLinkUrl } from "../vdr/team";
import { defaultSummaryDeps, redraftOne, remainingToday, requestSummaries, type SummaryDeps } from "../vdr/buyer-summary";

export type DataRoomRouteDeps = {
  store: VdrStore;
  getDeal: (id: string) => Promise<Deal | undefined | null>;
  accessRowsForDeal: (dealId: string) => Promise<BuyerAccess[]>;
  requirementsForDeal: (dealId: string) => Promise<DealDocumentRequirement[]>;
  brokerName: (brokerId: string) => Promise<string | null>;
  brand: (brokerId: string | null) => Promise<{ firmName: string | null; logoUrl: string | null }>;
  ddCited: (dealId: string) => Promise<string[] | null>;
  setup: () => SetupDeps;
  serve: () => ServeDeps;
  root: () => string;
  now: () => Date;
  /** The real upload path (createUploadedDocument); tests may replace it. */
  createUpload?: typeof import("../documents/upload").createUploadedDocument;
  // ── Pass 3: requests, To do, notes, emails (the broker's click only) ──
  questionsForDeal: (dealId: string) => Promise<BuyerQuestion[]>;
  createRequirement: (row: InsertDealDocumentRequirement) => Promise<DealDocumentRequirement>;
  discrepanciesForDeal: (dealId: string) => Promise<Discrepancy[]>;
  cimSectionsForDeal: (dealId: string) => Promise<CimSection[]>;
  sellerEmail: SellerEmailDeps;
  buyerEmail: BuyerEmailDeps;
  summary: () => SummaryDeps;
  /** The CIM sections a buyer is served (preview's "Used in the memorandum"); tests stub it. */
  servedSections?: typeof import("../vdr/analysis").servedSectionsFor;
};

async function defaultDeps(): Promise<DataRoomRouteDeps> {
  const { storage } = await import("../storage");
  const { brokerageBrand } = await import("../cim/templates");
  const notifications = await import("../notifications/service");
  return {
    questionsForDeal: (d) => storage.getQuestionsByDeal(d),
    createRequirement: (row) => storage.createDocumentRequirement(row),
    discrepanciesForDeal: (d) => storage.getDiscrepanciesByDeal(d),
    cimSectionsForDeal: (d) => storage.getCimSectionsByDeal(d),
    sellerEmail: { notifySellerPortal: (dealId, ev, opts) => notifications.notifySellerPortal(dealId, ev, opts) },
    buyerEmail: {
      sendDirect: notifications.sendDirectEmail,
      recordBuyerEmail: async (row) => (await import("../buyers/profile-data")).recordBuyerEmail(row),
      broker: async (brokerId) => {
        const [u, b] = await Promise.all([storage.getUser(brokerId), storage.getBrandingByBroker(brokerId).catch(() => undefined)]);
        return { name: u?.name?.trim() || null, email: u?.email ?? null, company: (b as { companyName?: string | null } | undefined)?.companyName ?? null };
      },
      appUrl: () => process.env.APP_URL || "https://app.cimple.ca",
    },
    summary: defaultSummaryDeps,
    store: dbVdrStore,
    getDeal: (id) => storage.getDeal(id),
    accessRowsForDeal: (d) => storage.getBuyerAccessByDeal(d),
    requirementsForDeal: (d) => storage.getDocumentRequirementsByDeal(d),
    brokerName: async (id) => (await storage.getUser(id))?.name || null,
    brand: async (id) => {
      const b = await brokerageBrand(id);
      return { firmName: b.firmName || null, logoUrl: b.logoUrl || null };
    },
    ddCited: ddCitedDocumentIds,
    setup: defaultSetupDeps,
    serve: defaultServeDeps,
    root: uploadsRoot,
    now: () => new Date(),
  };
}

const isId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v);

function send(res: Response, err: unknown, what: string) {
  if (err instanceof VdrHttpError) return res.status(err.status).json(err.body);
  if (err instanceof ServeError) return res.status(err.status).json({ error: err.message, code: err.code });
  console.error(`[vdr] ${what}:`, err);
  return res.status(500).json({ error: `Couldn't ${what}. Try again.` });
}

const notFound = () => new VdrHttpError(404, { error: "Not found" });
const bad = (error: string) => new VdrHttpError(400, { error });

/** Upload type check (§5.6): the allowlist, with plain words for the usual refusals. */
export function uploadRefusal(name: string): string | null {
  const ext = extensionOf(name);
  if (VDR_LIMITS.uploadExtensions.includes(ext)) return null;
  if (ext === ".heic" || ext === ".heif") return `"${name}": .heic (iPhone photo): share it as a JPEG, or set the camera to 'Most compatible'.`;
  if (ext === ".zip") return `"${name}": .zip: unzip it first and drop the folder.`;
  return `"${name}": ${ext || "These"} files can't go in the data room.`;
}

/** The parser category for a folder (so a statement dropped in 1.1 is read as one). */
function categoryForFolder(folders: ReadonlyArray<VdrFolder>, folderId: string): string {
  const byId = new Map(folders.map((f) => [f.id, f]));
  let f = byId.get(folderId);
  const seen = new Set<string>();
  while (f && !seen.has(f.id)) {
    seen.add(f.id);
    const key = f.presetKey ?? "";
    if (key.startsWith("financial")) return "financials";
    if (key.startsWith("legal") || key === "compliance") return "legal";
    if (key.startsWith("operations") || key.startsWith("people")) return "operations";
    if (key === "marketing") return "marketing";
    f = f.parentId ? byId.get(f.parentId) : undefined;
  }
  return "other";
}

export function registerDataRoomRoutes(app: Express, overrides?: Partial<DataRoomRouteDeps>) {
  let depsP: Promise<DataRoomRouteDeps> | null = null;
  const deps = () => (depsP ??= defaultDeps().then((d) => ({ ...d, ...(overrides ?? {}) })));

  app.get("/api/vdr/health", requireBroker, async (_req, res) => {
    try {
      const health = await vdrHealth();
      res.setHeader("Cache-Control", "no-store");
      res.status(health.renderer === "ok" ? 200 : 503).json(health);
    } catch (err: any) {
      console.error("[vdr] health check failed:", err);
      res.status(503).json({ renderer: `renderer_unavailable: ${String(err?.message || err).slice(0, 200)}`, node: process.version });
    }
  });

  const BASE = "/api/deals/:dealId/data-room";

  /** The deal must be this broker's (404 otherwise). */
  const ownDeal = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const d = await deps();
      const dealId = req.params.dealId;
      const deal = isId(dealId) ? await d.getDeal(dealId) : null;
      if (!deal || !req.session?.brokerId || deal.brokerId !== req.session.brokerId) return res.status(404).json({ error: "Deal not found" });
      res.locals.deal = deal;
      next();
    } catch (err) {
      send(res, err, "load the deal");
    }
  };
  const guard = [requireBroker, ownDeal];

  const brokerDeps = (d: DataRoomRouteDeps): BrokerDeps => ({
    store: d.store,
    accessRowsForDeal: d.accessRowsForDeal,
    requirementsForDeal: d.requirementsForDeal,
    privateMatters: (deal, ids) => privateMattersByDocument(deal, ids),
    ddCitedDocumentIds: d.ddCited,
    root: d.root(),
    now: d.now,
    questionsForDeal: d.questionsForDeal,
  });
  const by = (req: Request) => String(req.session?.brokerId ?? "broker");
  const brokerLog = (req: Request, dealId: string, action: VdrAction, extra: Partial<InsertVdrActivity> = {}): InsertVdrActivity =>
    ({ dealId, action, actorKind: "broker", actorId: by(req), ...extra });

  /** A live (or tombstoned, when allowed) item of THIS deal, else 404. */
  async function dealItem(d: DataRoomRouteDeps, dealId: string, itemId: unknown, opts: { allowRemoved?: boolean } = {}): Promise<VdrItem> {
    if (!isId(itemId)) throw notFound();
    const it = await d.store.getItem(itemId);
    if (!it || it.dealId !== dealId || (it.removedAt && !opts.allowRemoved)) throw notFound();
    return it;
  }
  async function dealFolder(d: DataRoomRouteDeps, dealId: string, folderId: unknown): Promise<VdrFolder> {
    if (!isId(folderId)) throw notFound();
    const f = (await d.store.listFolders(dealId)).find((x) => x.id === folderId);
    if (!f) throw notFound();
    return f;
  }
  async function dealAccess(d: DataRoomRouteDeps, dealId: string, accessId: unknown): Promise<BuyerAccess> {
    if (!isId(accessId)) throw notFound();
    const a = (await d.accessRowsForDeal(dealId)).find((r) => r.id === accessId && r.dealId === dealId);
    if (!a) throw notFound();
    return a;
  }
  async function requireRoom(d: DataRoomRouteDeps, dealId: string) {
    const room = await d.store.getRoom(dealId);
    if (!room) throw new VdrHttpError(409, { code: "room_none", error: "Set up the data room first." });
    return room;
  }

  // ── The tab ────────────────────────────────────────────────────────────

  app.get(BASE, ...guard, async (req, res) => {
    try {
      const d = await deps();
      res.setHeader("Cache-Control", "no-store");
      res.json(await roomPayload(brokerDeps(d), res.locals.deal as Deal));
    } catch (err) {
      send(res, err, "load the data room");
    }
  });

  app.post(`${BASE}/setup`, ...guard, async (req, res) => {
    try {
      const d = await deps();
      const mode = req.body?.mode === "empty" ? "empty" : "auto";
      const deal = res.locals.deal as Deal;
      const r = await setUpRoom(deal.id, by(req), mode, d.setup());
      res.json({ placed: r.placed.length, plan: await planPayload(d, deal) });
    } catch (err) {
      send(res, err, "set up the data room");
    }
  });

  async function planPayload(d: DataRoomRouteDeps, deal: Deal): Promise<SharingPlanPayload> {
    const room = await d.store.getRoom(deal.id);
    const ctx = await loadBrokerContext(brokerDeps(d), deal);
    const { snap, pm } = ctx;
    const numbers = indexNumbers(snap.folders, snap.items);
    const look = new Map<string, ReturnType<typeof flagsFor>["flags"]>();
    for (const it of snap.items.filter((i) => !i.removedAt)) {
      const doc = it.documentId ? snap.docs.get(it.documentId) ?? null : null;
      const f = flagsFor(it, doc, { privateMatters: doc ? pm.get(doc.id) : [], fileMissing: false, isLedger: isLedgerItemDoc(doc) });
      look.set(it.id, f.flags.filter((x) => f.unchecked.includes(x.key)));
    }
    const plan = recommendedPlan(snap.folders, snap.items, look);
    const live = snap.items.filter((i) => !i.removedAt);
    return {
      folders: plan.folders.map((f) => {
        const folder = snap.folders.find((x) => x.id === f.folderId)!;
        const hint = (folder.shareHint as { levels: string[] } | null)?.levels ?? null;
        const preset = presetFolder(folder.presetKey);
        const parent = folder.parentId ? snap.folders.find((x) => x.id === folder.parentId) : null;
        const rec = preset?.recommended ?? presetFolder(parent?.presetKey ?? null)?.recommended ?? "not_yet";
        return { folderId: f.folderId, name: f.name, number: numbers.folders.get(f.folderId) ?? "", documents: f.count, recommended: (rec === "dd" ? "dd" : "not_yet") as "dd" | "not_yet", levels: hint ?? f.levels };
      }).sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true })),
      flagged: plan.flagged.map((x) => ({ itemId: x.itemId, number: numbers.items.get(x.itemId) ?? null, title: x.title, flags: x.flags })),
      summaries: live.map((it) => {
        const doc = it.documentId ? snap.docs.get(it.documentId) ?? null : null;
        return { itemId: it.id, title: it.title, text: it.buyerSummary ?? null, status: it.buyerSummaryStatus ?? null, basic: basicDescription(doc, it.prepared ?? null) };
      }),
      planAppliedAt: room?.planAppliedAt ? new Date(room.planAppliedAt).toISOString() : null,
    };
  }

  app.get(`${BASE}/plan`, ...guard, async (req, res) => {
    try {
      const d = await deps();
      await requireRoom(d, req.params.dealId);
      res.json(await planPayload(d, res.locals.deal as Deal));
    } catch (err) {
      send(res, err, "load the sharing plan");
    }
  });

  app.post(`${BASE}/plan`, ...guard, async (req, res) => {
    try {
      const d = await deps();
      const deal = res.locals.deal as Deal;
      await requireRoom(d, deal.id);
      const body = req.body ?? {};
      if (!Array.isArray(body.folders) || body.folders.length > 200) throw bad("Choose who sees each folder.");
      const ctx = await loadBrokerContext(brokerDeps(d), deal);
      const { snap, groups, pm } = ctx;
      const choice: Array<{ folderId: string; levels: string[] }> = [];
      for (const f of body.folders) {
        if (!f || !snap.folders.some((x) => x.id === f.folderId)) throw notFound();
        if (!Array.isArray(f.levels) || f.levels.length > 4) throw bad("Choose who sees each folder.");
        const levels: string[] = [];
        for (const raw of f.levels) {
          const lvl = parseAccessLevelInput(raw);
          if (!lvl || (dataRoomLevelRule(lvl) !== "auto_on" && dataRoomLevelRule(lvl) !== "manual")) throw bad("Teaser and Blind CIM buyers can't have documents.");
          levels.push(lvl);
        }
        choice.push({ folderId: f.folderId, levels });
      }
      const live = snap.items.filter((i) => !i.removedAt);
      const ids = (v: unknown): string[] => {
        if (v == null) return [];
        if (!Array.isArray(v) || v.length > 500) throw bad("Too many documents.");
        for (const x of v) if (!live.some((i) => i.id === x)) throw notFound();
        return v as string[];
      };
      const includeFlagged = new Set(ids(body.includeFlagged));
      const accept = new Set(ids(body.acceptSummaries));
      const flaggedIds = new Set<string>();
      const ticks = new Map<string, VdrFlagKey[]>();
      for (const it of live) {
        const doc = it.documentId ? snap.docs.get(it.documentId) ?? null : null;
        const f = flagsFor(it, doc, { privateMatters: doc ? pm.get(doc.id) : [], fileMissing: false, isLedger: isLedgerItemDoc(doc) });
        if (f.unchecked.length) {
          flaggedIds.add(it.id);
          if (includeFlagged.has(it.id)) ticks.set(it.id, f.unchecked);
        }
      }
      const { planShareRows } = await import("../vdr/auto-file");
      const rows = planShareRows(choice, live.map((i) => ({ ...i, isLedger: isLedgerItemDoc(i.documentId ? snap.docs.get(i.documentId) ?? null : null) })), flaggedIds, includeFlagged);
      const existing = new Set(snap.shares.filter((s) => s.audience === "level").map((s) => `${s.itemId}|${s.accessLevel}`));
      const fresh = rows.filter((r) => !existing.has(`${r.itemId}|${r.accessLevel}`));
      // Who could open each touched item before and after (for "Let them know?").
      const touched = new Set(fresh.map((r) => r.itemId));
      const before = new Set<string>();
      const after = new Set<string>();
      for (const id of Array.from(touched)) {
        const it = live.find((i) => i.id === id)!;
        const isLedger = isLedgerItemDoc(it.documentId ? snap.docs.get(it.documentId) ?? null : null);
        const cur = snap.shares.filter((s) => s.itemId === id);
        for (const k of Array.from(readersOf(groups, cur, isLedger))) before.add(`${id}|${k}`);
        const next = [...cur, ...fresh.filter((r) => r.itemId === id).map((r) => ({ audience: "level", accessLevel: r.accessLevel, buyerEmail: null, effect: "allow" }))];
        for (const k of Array.from(readersOf(groups, next as any, isLedger))) after.add(`${id}|${k}`);
      }
      const newlyVisible = new Set(Array.from(after).filter((x) => !before.has(x)).map((x) => x.split("|")[1]));
      await d.store.insertShares(fresh.map((r) => ({ dealId: deal.id, itemId: r.itemId, audience: "level", accessLevel: r.accessLevel, buyerEmail: null, effect: "allow", createdBy: "plan" })));
      const now = d.now();
      for (const [itemId, flags] of Array.from(ticks.entries())) {
        const it = live.find((i) => i.id === itemId)!;
        await d.store.updateItem(itemId, { checkedAt: now, checkedBy: by(req), checkedFlags: flags, checkedForFile: it.prepared?.forFile ?? null });
      }
      for (const c of choice) {
        await d.store.updateFolder(c.folderId, { shareHint: c.levels.length ? { levels: c.levels } : null });
      }
      for (const id of Array.from(accept)) {
        const it = live.find((i) => i.id === id)!;
        if (it.buyerSummary && it.buyerSummaryStatus === "drafted") await d.store.updateItem(id, { buyerSummaryStatus: "accepted" });
      }
      await d.store.updateRoom(deal.id, { planAppliedAt: now });
      const logs: InsertVdrActivity[] = [brokerLog(req, deal.id, "plan_applied", { detail: { shared: touched.size, levels: fresh.length, ticked: ticks.size } })];
      for (const [itemId, flags] of Array.from(ticks.entries())) logs.push(brokerLog(req, deal.id, "checked_by_broker", { itemId, detail: { flags } }));
      await logVdrQuietly(d.store, logs);
      res.json({ shared: touched.size, newlyVisibleBuyers: newlyVisible.size, newlyVisible: newlyList(ctx, newlyVisible), itemIds: Array.from(touched) });
    } catch (err) {
      send(res, err, "apply the sharing plan");
    }
  });

  app.patch(`${BASE}/settings`, ...guard, async (req, res) => {
    try {
      const d = await deps();
      const deal = res.locals.deal as Deal;
      const room = await requireRoom(d, deal.id);
      const patch: Record<string, unknown> = {};
      const logs: InsertVdrActivity[] = [];
      if (req.body?.status === "open" || req.body?.status === "closed") {
        if (req.body.status !== room.status) {
          patch.status = req.body.status;
          patch.closedAt = req.body.status === "closed" ? d.now() : null;
          logs.push(brokerLog(req, deal.id, req.body.status === "closed" ? "room_closed" : "room_opened"));
        }
      }
      if (typeof req.body?.autoAddNew === "boolean" && req.body.autoAddNew !== room.autoAddNew) {
        patch.autoAddNew = req.body.autoAddNew;
        logs.push(brokerLog(req, deal.id, "settings_changed", { detail: { autoAddNew: req.body.autoAddNew } }));
      }
      if (Object.keys(patch).length) await d.store.updateRoom(deal.id, patch as any);
      await logVdrQuietly(d.store, logs);
      res.json({ ok: true });
    } catch (err) {
      send(res, err, "save the room settings");
    }
  });

  // ── Folders ────────────────────────────────────────────────────────────

  const cleanName = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

  app.post(`${BASE}/folders`, ...guard, async (req, res) => {
    try {
      const d = await deps();
      const dealId = req.params.dealId;
      await requireRoom(d, dealId);
      const name = cleanName(req.body?.name, VDR_LIMITS.folderName);
      if (!name) throw bad("Give the folder a name.");
      const folders = await d.store.listFolders(dealId);
      let parentId: string | null = null;
      if (req.body?.parentId != null) {
        const parent = await dealFolder(d, dealId, req.body.parentId);
        if (folderDepth(folders, parent.id) >= VDR_LIMITS.folderDepth) throw bad("Folders can go three levels deep.");
        parentId = parent.id;
      }
      const siblings = folders.filter((f) => (f.parentId ?? null) === parentId);
      const f = await d.store.insertFolder({ dealId, parentId, name, position: siblings.reduce((m, x) => Math.max(m, x.position), 0) + 1, presetKey: null });
      await logVdrQuietly(d.store, brokerLog(req, dealId, "folder_created", { folderId: f?.id, detail: { name } }));
      res.json(f);
    } catch (err) {
      send(res, err, "add the folder");
    }
  });

  app.patch(`${BASE}/folders/:folderId`, ...guard, async (req, res) => {
    try {
      const d = await deps();
      const dealId = req.params.dealId;
      const folder = await dealFolder(d, dealId, req.params.folderId);
      const folders = await d.store.listFolders(dealId);
      const patch: Partial<VdrFolder> = {};
      const logs: InsertVdrActivity[] = [];
      if (req.body?.name !== undefined) {
        const name = cleanName(req.body.name, VDR_LIMITS.folderName);
        if (!name) throw bad("Give the folder a name.");
        if (name !== folder.name) { patch.name = name; logs.push(brokerLog(req, dealId, "folder_renamed", { folderId: folder.id, detail: { from: folder.name, to: name } })); }
      }
      let parentId = folder.parentId ?? null;
      if (req.body?.parentId !== undefined) {
        const next = req.body.parentId === null ? null : (await dealFolder(d, dealId, req.body.parentId)).id;
        if (next) {
          // No cycles: the new parent can't be the folder or one of its sub-folders.
          let cur: VdrFolder | undefined = folders.find((f) => f.id === next);
          const seen = new Set<string>();
          while (cur && !seen.has(cur.id)) {
            if (cur.id === folder.id) throw bad("A folder can't go inside itself.");
            seen.add(cur.id);
            cur = cur.parentId ? folders.find((f) => f.id === cur!.parentId) : undefined;
          }
          // Depth: the new parent's depth + this folder's own height.
          const height = (id: string, seen2 = new Set<string>()): number => {
            if (seen2.has(id)) return 1;
            seen2.add(id);
            const kids = folders.filter((f) => f.parentId === id);
            return 1 + (kids.length ? Math.max(...kids.map((k) => height(k.id, seen2))) : 0);
          };
          if (folderDepth(folders, next) + height(folder.id) > VDR_LIMITS.folderDepth) throw bad("Folders can go three levels deep.");
        }
        if (next !== parentId) {
          parentId = next;
          patch.parentId = next;
          logs.push(brokerLog(req, dealId, "folder_moved", { folderId: folder.id }));
        }
      }
      if (patch.name || patch.parentId !== undefined) await d.store.updateFolder(folder.id, patch);
      if (req.body?.position !== undefined || patch.parentId !== undefined) {
        const siblings = (await d.store.listFolders(dealId)).filter((f) => (f.parentId ?? null) === parentId && f.id !== folder.id).sort((a, b) => a.position - b.position);
        const at = Number.isInteger(req.body?.position) ? Math.max(0, Math.min(siblings.length, req.body.position)) : siblings.length;
        siblings.splice(at, 0, folder);
        for (let i = 0; i < siblings.length; i++) if (siblings[i].position !== i + 1 || siblings[i].id === folder.id) await d.store.updateFolder(siblings[i].id, { position: i + 1 });
      }
      await logVdrQuietly(d.store, logs);
      res.json({ ok: true });
    } catch (err) {
      send(res, err, "change the folder");
    }
  });

  app.delete(`${BASE}/folders/:folderId`, ...guard, async (req, res) => {
    try {
      const d = await deps();
      const dealId = req.params.dealId;
      const folder = await dealFolder(d, dealId, req.params.folderId);
      const [items, folders] = await Promise.all([d.store.listItems(dealId), d.store.listFolders(dealId)]);
      const docs = items.filter((i) => i.folderId === folder.id && !i.removedAt).length;
      const subs = folders.filter((f) => f.parentId === folder.id).length;
      if (docs > 0) return res.status(409).json({ error: `Move or remove its ${docs === 1 ? "document" : `${docs} documents`} first` });
      if (subs > 0) return res.status(409).json({ error: `Move or delete its ${subs === 1 ? "sub-folder" : `${subs} sub-folders`} first` });
      await d.store.deleteFolder(folder.id);
      await logVdrQuietly(d.store, brokerLog(req, dealId, "folder_deleted", { detail: { name: folder.name } }));
      res.json({ ok: true });
    } catch (err) {
      send(res, err, "delete the folder");
    }
  });

  // ── Items ──────────────────────────────────────────────────────────────

  app.post(`${BASE}/items`, ...guard, async (req, res) => {
    try {
      const d = await deps();
      const dealId = req.params.dealId;
      await requireRoom(d, dealId);
      if (!isId(req.body?.documentId)) throw notFound();
      const doc = await d.store.getDocument(req.body.documentId);
      if (!doc || doc.dealId !== dealId) throw notFound();
      if (!isRoomMaterial(doc)) throw bad(notRoomMaterialReason(doc) ?? "It can't go in the data room.");
      const folderId = req.body?.folderId != null ? (await dealFolder(d, dealId, req.body.folderId)).id : null;
      const item = await fileDocumentIntoRoom(dealId, doc.id, "broker", { explicit: true, folderId }, d.setup());
      if (!item) throw bad("It can't go in the data room.");
      res.json({ id: item.id });
    } catch (err) {
      send(res, err, "put it in the room");
    }
  });

  app.post(`${BASE}/items/move`, ...guard, async (req, res) => {
    try {
      const d = await deps();
      const dealId = req.params.dealId;
      const target = await dealFolder(d, dealId, req.body?.folderId);
      const ids = req.body?.itemIds;
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > 500) throw bad("Choose what to move.");
      const items = await d.store.listItems(dealId);
      const moving: VdrItem[] = [];
      for (const id of Array.from(new Set(ids))) {
        const it = items.find((i) => i.id === id && !i.removedAt);
        if (!it) throw notFound();
        moving.push(it);
      }
      let before: VdrItem | null = null;
      if (req.body?.beforeItemId != null) {
        before = items.find((i) => i.id === req.body.beforeItemId && !i.removedAt) ?? null;
        if (!before || before.folderId !== target.id) throw notFound();
      }
      const movingIds = new Set(moving.map((m) => m.id));
      const rest = items.filter((i) => !i.removedAt && i.folderId === target.id && !movingIds.has(i.id)).sort((a, b) => a.position - b.position);
      const at = before && !movingIds.has(before.id) ? rest.findIndex((i) => i.id === before!.id) : rest.length;
      rest.splice(at < 0 ? rest.length : at, 0, ...moving);
      await d.store.moveItems(rest.map((it, i) => ({ id: it.id, folderId: target.id, position: i + 1 })));
      await logVdrQuietly(d.store, moving.filter((m) => m.folderId !== target.id).map((m) => brokerLog(req, dealId, "item_moved", { itemId: m.id, folderId: target.id, detail: { from: m.folderId } })));
      res.json({ moved: moving.length });
    } catch (err) {
      send(res, err, "move the documents");
    }
  });

  app.patch(`${BASE}/items/:itemId`, ...guard, async (req, res) => {
    try {
      const d = await deps();
      const dealId = req.params.dealId;
      const item = await dealItem(d, dealId, req.params.itemId);
      const b = req.body ?? {};
      const patch: Partial<VdrItem> = {};
      const logs: InsertVdrActivity[] = [];
      if (b.title !== undefined) {
        const title = cleanName(b.title, VDR_LIMITS.title);
        if (!title) throw bad("Give the document a name.");
        if (title !== item.title) { patch.title = title; logs.push(brokerLog(req, dealId, "item_renamed", { itemId: item.id, detail: { from: item.title, to: title } })); }
      }
      if (typeof b.downloadable === "boolean" && b.downloadable !== item.downloadable) {
        patch.downloadable = b.downloadable;
        if (!b.downloadable) patch.downloadOriginal = false;
        logs.push(brokerLog(req, dealId, "downloads_changed", { itemId: item.id, detail: { downloadable: b.downloadable } }));
      }
      if (typeof b.downloadOriginal === "boolean" && b.downloadOriginal !== item.downloadOriginal) {
        if (b.downloadOriginal) {
          const p = item.prepared ?? null;
          if (!p || p.status !== "ready") throw new VdrHttpError(409, { error: "Cimple is still preparing this document. Try again in a minute." });
          if (p.kind === "pdf") {
            if (p.servedCopy === "original") throw new VdrHttpError(409, { error: "Cimple couldn't clean this PDF, so only page images can be downloaded." });
            if ((p.personal?.count ?? 0) > 0) throw new VdrHttpError(409, { error: "This file has social insurance numbers in it, so only the covered copy can be downloaded." });
          } else if (p.kind === "image") {
            throw new VdrHttpError(409, { error: "Photos download as a PDF of the page with the buyer's name on it." });
          } else {
            throw new VdrHttpError(409, { error: "Offering the original isn't available for this kind of file yet. Spreadsheets download as a values-only copy." });
          }
          patch.downloadable = true;
        }
        patch.downloadOriginal = b.downloadOriginal;
        logs.push(brokerLog(req, dealId, "original_offered", { itemId: item.id, detail: { on: b.downloadOriginal } }));
      }
      if (b.buyerSummary !== undefined) {
        const text = typeof b.buyerSummary === "string" ? b.buyerSummary.replace(/\s+/g, " ").trim().slice(0, 600) : "";
        const points = Array.isArray(b.buyerSummaryPoints) ? (b.buyerSummaryPoints as unknown[]).filter((p): p is string => typeof p === "string" && !!p.trim()).map((p) => p.trim().slice(0, 160)).slice(0, 4) : [];
        if (text) {
          Object.assign(patch, { buyerSummary: text, buyerSummaryPoints: points, buyerSummarySource: "broker", buyerSummaryStatus: "accepted", buyerSummaryAt: d.now() });
        } else {
          Object.assign(patch, { buyerSummary: null, buyerSummaryPoints: null, buyerSummarySource: "basic", buyerSummaryStatus: "accepted", buyerSummaryAt: d.now() });
        }
        logs.push(brokerLog(req, dealId, "summary_edited", { itemId: item.id }));
      }
      if (b.acceptSummary === true && item.buyerSummary && item.buyerSummaryStatus === "drafted") {
        patch.buyerSummaryStatus = "accepted";
        logs.push(brokerLog(req, dealId, "summary_accepted", { itemId: item.id }));
      }
      if (typeof b.buyerSummaryHidden === "boolean" && b.buyerSummaryHidden !== item.buyerSummaryHidden) patch.buyerSummaryHidden = b.buyerSummaryHidden;
      if (Object.keys(patch).length) await d.store.updateItem(item.id, patch as any);
      await logVdrQuietly(d.store, logs);
      res.json({ ok: true });
    } catch (err) {
      send(res, err, "save the change");
    }
  });

  app.post(`${BASE}/items/:itemId/checked`, ...guard, async (req, res) => {
    try {
      const d = await deps();
      const dealId = req.params.dealId;
      const deal = res.locals.deal as Deal;
      const item = await dealItem(d, dealId, req.params.itemId);
      const doc = item.documentId ? await d.store.getDocument(item.documentId) : null;
      const pm = privateMattersByDocument(deal, doc ? [doc.id] : []);
      const { flags } = flagsFor(item, doc, { privateMatters: doc ? pm.get(doc.id) : [], fileMissing: false, isLedger: isLedgerItemDoc(doc) });
      const look = new Set(flags.filter((f) => f.look).map((f) => f.key));
      const asked = Array.isArray(req.body?.flags) ? (req.body.flags as unknown[]).filter((x): x is string => typeof x === "string" && look.has(x as VdrFlagKey)) : Array.from(look);
      if (asked.length === 0) throw bad("There's nothing to check on this document.");
      const forFile = item.prepared?.forFile ?? null;
      const prev = item.checkedForFile && item.checkedForFile === forFile ? ((item.checkedFlags as string[] | null) ?? []) : [];
      const merged = Array.from(new Set([...prev, ...asked]));
      await d.store.updateItem(item.id, { checkedAt: d.now(), checkedBy: by(req), checkedFlags: merged, checkedForFile: forFile });
      await logVdrQuietly(d.store, brokerLog(req, dealId, "checked_by_broker", { itemId: item.id, detail: { flags: asked } }));
      res.json({ checked: merged });
    } catch (err) {
      send(res, err, "save the check");
    }
  });

  app.delete(`${BASE}/items/:itemId`, ...guard, async (req, res) => {
    try {
      const d = await deps();
      const dealId = req.params.dealId;
      const item = await dealItem(d, dealId, req.params.itemId, { allowRemoved: true });
      if (item.removedAt) {
        // A tombstone ("File deleted"): "Remove from the list" — it stays out of the list for good.
        if (item.removedReason !== "broker") await d.store.updateItem(item.id, { removedReason: "broker" });
        return res.json({ ok: true });
      }
      const shares = await d.store.sharesForItem(item.id);
      await d.store.updateItem(item.id, { removedAt: d.now(), removedReason: "broker" });
      await d.store.deleteSharesForItem(item.id);
      await removeItemCache(item.dealId, item.id, null, d.root());
      await d.store.deletePageText(item.id);
      await logVdrQuietly(d.store, brokerLog(req, dealId, "item_removed", { itemId: item.id, folderId: item.folderId, detail: { title: item.title, wasShared: shareSummary(shares).shared } }));
      res.json({ ok: true });
    } catch (err) {
      send(res, err, "take it out of the room");
    }
  });

  app.post(`${BASE}/items/:itemId/restore`, ...guard, async (req, res) => {
    try {
      const d = await deps();
      const item = await dealItem(d, req.params.dealId, req.params.itemId, { allowRemoved: true });
      const r = await restoreItem(item.id, by(req), d.setup());
      if (!r.ok) throw new VdrHttpError(409, { error: r.reason });
      res.json({ id: r.item.id });
    } catch (err) {
      send(res, err, "put it back");
    }
  });

  app.post(`${BASE}/items/:itemId/share-like-replaced`, ...guard, async (req, res) => {
    try {
      const d = await deps();
      const item = await dealItem(d, req.params.dealId, req.params.itemId);
      if (!item.replacesItemId) throw bad("This isn't a new version of another document.");
      const r = await shareLikeReplaced(item.id, by(req), d.setup());
      res.json(r);
    } catch (err) {
      send(res, err, "share the new version");
    }
  });

  app.post(`${BASE}/items/:itemId/prepare`, ...guard, async (req, res) => {
    try {
      const d = await deps();
      const item = await dealItem(d, req.params.dealId, req.params.itemId);
      void ensurePrepared(item.id, { force: true }).catch(() => undefined);
      res.json({ ok: true });
    } catch (err) {
      send(res, err, "try again");
    }
  });

  // Cleaned copies: stored privately, served instead of the original, never read for facts.
  const cleanUpload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => {
        const dir = path.join(uploadsRoot(), "private-vdr", ".incoming");
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (_req, file, cb) => cb(null, newPrivateName(extensionOf(file.originalname))),
    }),
    limits: { fileSize: VDR_LIMITS.uploadBytes, files: 1 },
    fileFilter: (req, file, cb) => {
      const why = uploadRefusal(file.originalname);
      if (why) (req as any).vdrRefusal = why;
      cb(null, !why);
    },
  });

  app.post(`${BASE}/items/:itemId/clean-copy`, ...guard, async (req, res, next) => {
    // The item must be this deal's before anything is written.
    try {
      const d = await deps();
      res.locals.item = await dealItem(d, req.params.dealId, req.params.itemId);
      next();
    } catch (err) {
      send(res, err, "upload the cleaned copy");
    }
  }, (req, res, next) => cleanUpload.single("file")(req, res, (err: any) => {
    if (err) return res.status(400).json({ error: err?.code === "LIMIT_FILE_SIZE" ? "Too large (over 20 MB). Save a smaller copy or split it." : "Couldn't receive the file." });
    next();
  }), async (req, res) => {
    const tmp = req.file?.path;
    try {
      const d = await deps();
      const item = res.locals.item as VdrItem;
      if (!req.file) throw bad((req as any).vdrRefusal || "Choose a file.");
      const name = newPrivateName(extensionOf(req.file.originalname));
      const dest = cleanCopyPath(item.dealId, name, d.root());
      const rel = cleanCopyRelPath(item.dealId, name);
      if (!dest || !rel) throw bad("Couldn't store the file.");
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(req.file.path, dest);
      const old = item.cleanCopyPath;
      await d.store.updateItem(item.id, { cleanCopyPath: rel, cleanCopyMime: req.file.mimetype || null, cleanCopyName: String(req.file.originalname).slice(0, 200), cleanCopyAt: d.now(), prepared: null });
      if (old) await removeCleanCopy(old, item.dealId, d.root());
      await removeItemCache(item.dealId, item.id, null, d.root());
      await d.store.deletePageText(item.id);
      await logVdrQuietly(d.store, brokerLog(req, item.dealId, "clean_copy_added", { itemId: item.id }));
      enqueuePrepare(item.id);
      res.json({ ok: true });
    } catch (err) {
      if (tmp && fs.existsSync(tmp)) fs.unlink(tmp, () => {});
      send(res, err, "upload the cleaned copy");
    }
  });

  app.delete(`${BASE}/items/:itemId/clean-copy`, ...guard, async (req, res) => {
    try {
      const d = await deps();
      const item = await dealItem(d, req.params.dealId, req.params.itemId);
      if (!item.cleanCopyPath) return res.json({ ok: true });
      await removeCleanCopy(item.cleanCopyPath, item.dealId, d.root());
      await d.store.updateItem(item.id, { cleanCopyPath: null, cleanCopyMime: null, cleanCopyName: null, cleanCopyAt: null, prepared: null });
      await removeItemCache(item.dealId, item.id, null, d.root());
      await d.store.deletePageText(item.id);
      await logVdrQuietly(d.store, brokerLog(req, item.dealId, "clean_copy_removed", { itemId: item.id }));
      enqueuePrepare(item.id);
      res.json({ ok: true });
    } catch (err) {
      send(res, err, "remove the cleaned copy");
    }
  });

  // ── Sharing ────────────────────────────────────────────────────────────

  app.get(`${BASE}/audience`, ...guard, async (req, res) => {
    try {
      const d = await deps();
      const deal = res.locals.deal as Deal;
      const [rows, settings] = await Promise.all([d.accessRowsForDeal(deal.id), d.store.listBuyerSettings(deal.id)]);
      res.json(shareAudience(groupBuyers(rows.filter((r) => r.dealId === deal.id), settings, d.now())));
    } catch (err) {
      send(res, err, "load the buyers");
    }
  });

  /** Writes new grant sets (one transaction) + ticks + logs; returns how many buyers newly reach something. */
  async function writeShares(
    d: DataRoomRouteDeps,
    req: Request,
    dealId: string,
    ctx: Awaited<ReturnType<typeof loadBrokerContext>>,
    changes: Array<{ item: VdrItem; rows: any[]; tick: VdrFlagKey[] }>,
  ): Promise<Set<string>> {
    const { snap, groups } = ctx;
    const newly = new Set<string>();
    const logs: InsertVdrActivity[] = [];
    for (const c of changes) {
      const isLedger = isLedgerItemDoc(c.item.documentId ? snap.docs.get(c.item.documentId) ?? null : null);
      const cur = snap.shares.filter((s) => s.itemId === c.item.id);
      const before = readersOf(groups, cur, isLedger);
      const after = readersOf(groups, c.rows, isLedger);
      for (const k of Array.from(after)) if (!before.has(k)) newly.add(k);
      const was = shareSummary(cur);
      const now = shareSummary(c.rows as Array<{ audience: string; accessLevel: string | null; buyerEmail: string | null; effect: string }>);
      if (was.label !== now.label) logs.push(brokerLog(req, dealId, now.shared || !was.shared ? "shared" : "unshared", { itemId: c.item.id, detail: { from: was.label, to: now.label } }));
      if (c.tick.length) logs.push(brokerLog(req, dealId, "checked_by_broker", { itemId: c.item.id, detail: { flags: c.tick } }));
    }
    // A grant that stays keeps its date: "New since your last visit" must not light up on every save.
    const keyOf = (r: { audience: string; accessLevel?: string | null; buyerEmail?: string | null; effect?: string | null }) => `${r.audience}|${r.accessLevel ?? ""}|${r.buyerEmail ?? ""}|${r.effect ?? "allow"}`;
    for (const c of changes) {
      const before = new Map(snap.shares.filter((s) => s.itemId === c.item.id).map((s) => [keyOf(s), s.createdAt]));
      for (const r of c.rows) { const at = before.get(keyOf(r)); if (at) r.createdAt = at; }
    }
    await d.store.replaceShares(changes.map((c) => ({ itemId: c.item.id, rows: c.rows })));
    const stamp = d.now();
    for (const c of changes) {
      if (!c.tick.length) continue;
      const forFile = c.item.prepared?.forFile ?? null;
      const prev = c.item.checkedForFile && c.item.checkedForFile === forFile ? ((c.item.checkedFlags as string[] | null) ?? []) : [];
      await d.store.updateItem(c.item.id, { checkedAt: stamp, checkedBy: by(req), checkedFlags: Array.from(new Set([...prev, ...c.tick])), checkedForFile: forFile });
    }
    await logVdrQuietly(d.store, logs);
    return newly;
  }

  /** The buyers (by key) who newly reach something, as {accessId, label} for "Let them know?". */
  const newlyList = (ctx: Awaited<ReturnType<typeof loadBrokerContext>>, keys: Set<string>) =>
    Array.from(keys).map((k) => {
      const g = ctx.groups.find((x) => x.key === k);
      const link = g?.eligible ?? g?.rows[0] ?? null;
      return { accessId: link?.id ?? "", label: (link?.buyerCompany || link?.buyerName || link?.buyerEmail || k) as string };
    }).filter((x) => x.accessId);

  app.put(`${BASE}/items/:itemId/shares`, ...guard, async (req, res) => {
    try {
      const d = await deps();
      const deal = res.locals.deal as Deal;
      const item = await dealItem(d, deal.id, req.params.itemId);
      const input = parseShareBody(req.body);
      if (!input) throw bad("Choose who can see it.");
      const ctx = await loadBrokerContext(brokerDeps(d), deal);
      const doc = item.documentId ? ctx.snap.docs.get(item.documentId) ?? null : null;
      if (!doc || !isRoomMaterial(doc)) throw bad(notRoomMaterialReason(doc ?? { visibility: null, sourceKind: null, category: null, subcategory: null, fileUrl: null }) ?? "It can't be shared.");
      const isLedger = isLedgerItemDoc(doc);
      const { unchecked } = flagsFor(item, doc, { privateMatters: ctx.pm.get(doc.id) ?? [], fileMissing: false, isLedger });
      const checkedFlags = Array.isArray(req.body?.checkedFlags) ? (req.body.checkedFlags as unknown[]).filter((x): x is string => typeof x === "string") : [];
      const v = validateShares({ dealId: deal.id, item, isLedger, unchecked, checkedFlags, accessRows: ctx.rows, input, by: by(req), now: ctx.now });
      if (!v.ok) return res.status(v.failure.status).json(v.failure.body);
      const newly = await writeShares(d, req, deal.id, ctx, [{ item, rows: v.rows, tick: v.tick }]);
      if (req.body?.acceptSummary === true && item.buyerSummary && item.buyerSummaryStatus === "drafted") {
        await d.store.updateItem(item.id, { buyerSummaryStatus: "accepted" });
        await logVdrQuietly(d.store, brokerLog(req, deal.id, "summary_accepted", { itemId: item.id }));
      }
      res.json({ newlyVisibleBuyers: newly.size, newlyVisible: newlyList(ctx, newly) });
    } catch (err) {
      send(res, err, "save who can see it");
    }
  });

  app.post(`${BASE}/shares/bulk`, ...guard, async (req, res) => {
    try {
      const d = await deps();
      const deal = res.locals.deal as Deal;
      await requireRoom(d, deal.id);
      const b = req.body ?? {};
      const ctx = await loadBrokerContext(brokerDeps(d), deal);
      const { snap } = ctx;
      let targets: VdrItem[];
      if (b.folderId != null) {
        const folder = await dealFolder(d, deal.id, b.folderId);
        const within = new Set<string>([folder.id]);
        let grew = true;
        while (grew) {
          grew = false;
          for (const f of snap.folders) if (f.parentId && within.has(f.parentId) && !within.has(f.id)) { within.add(f.id); grew = true; }
        }
        targets = snap.items.filter((i) => !i.removedAt && within.has(i.folderId));
      } else {
        if (!Array.isArray(b.itemIds) || b.itemIds.length === 0 || b.itemIds.length > 500) throw bad("Choose documents to share.");
        targets = [];
        for (const id of Array.from(new Set(b.itemIds))) {
          const it = snap.items.find((i) => i.id === id && !i.removedAt);
          if (!it) throw notFound();
          targets.push(it);
        }
      }
      const add = parseShareBody({ levels: b.add?.levels, allow: b.add?.allow });
      const remove = parseShareBody({ levels: b.remove?.levels, allow: b.remove?.allow });
      if (!add || !remove) throw bad("Choose who can see them.");
      // Tenancy first: every buyer named must be one of this deal's links.
      for (const id of [...add.allow, ...remove.allow]) if (!ctx.rows.some((r) => r.id === id)) throw notFound();
      const removeLevels = new Set(remove.levels.map((l) => parseAccessLevelInput(l)).filter(Boolean) as string[]);
      const removeKeys = new Set(remove.allow.map((id) => buyerKey(ctx.rows.find((r) => r.id === id)!.buyerEmail)));
      const ticksBy = (b.checkedFlags && typeof b.checkedFlags === "object") ? (b.checkedFlags as Record<string, unknown>) : {};
      const changes: Array<{ item: VdrItem; rows: any[]; tick: VdrFlagKey[] }> = [];
      const skipped: BulkShareResult["skipped"] = [];
      for (const item of targets) {
        const doc = item.documentId ? snap.docs.get(item.documentId) ?? null : null;
        if (!doc || !isRoomMaterial(doc)) { skipped.push({ itemId: item.id, title: item.title, reason: "It can't be shared." }); continue; }
        const isLedger = isLedgerItemDoc(doc);
        const cur = currentShareInput(snap.shares.filter((s) => s.itemId === item.id), ctx.groups);
        const keyOf = (id: string) => buyerKey(ctx.rows.find((r) => r.id === id)?.buyerEmail);
        const next: ShareInput = {
          levels: Array.from(new Set([...cur.levels.filter((l) => !removeLevels.has(l)), ...add.levels])),
          allow: Array.from(new Set([...cur.allow.filter((id) => !removeKeys.has(keyOf(id))), ...add.allow])),
          deny: cur.deny.filter((id) => !add.allow.some((a) => keyOf(a) === keyOf(id))),
        };
        if (isLedger && next.levels.some((l) => parseAccessLevelInput(l) !== DD_ACCESS_LEVEL)) {
          next.levels = next.levels.filter((l) => parseAccessLevelInput(l) === DD_ACCESS_LEVEL);
          if (add.levels.some((l) => parseAccessLevelInput(l) !== DD_ACCESS_LEVEL)) skipped.push({ itemId: item.id, title: item.title, reason: LEDGER_DD_ONLY });
        }
        const { unchecked } = flagsFor(item, doc, { privateMatters: ctx.pm.get(doc.id) ?? [], fileMissing: false, isLedger });
        const ticked = Array.isArray(ticksBy[item.id]) ? (ticksBy[item.id] as unknown[]).filter((x): x is string => typeof x === "string") : [];
        const v = validateShares({ dealId: deal.id, item, isLedger, unchecked, checkedFlags: ticked, accessRows: ctx.rows, input: next, by: by(req), now: ctx.now });
        if (!v.ok) {
          if (v.failure.status === 404) throw notFound();
          const reason = v.failure.body.code === "check_first" ? "Needs your check first." : String(v.failure.body.error ?? "It couldn't be shared.");
          if (!skipped.some((s) => s.itemId === item.id)) skipped.push({ itemId: item.id, title: item.title, reason });
          continue;
        }
        const same = JSON.stringify(shareSummary(v.rows as Array<{ audience: string; accessLevel: string | null; buyerEmail: string | null; effect: string }>)) === JSON.stringify(shareSummary(snap.shares.filter((s) => s.itemId === item.id))) && v.tick.length === 0 &&
          v.rows.length === snap.shares.filter((s) => s.itemId === item.id).length;
        if (!same) changes.push({ item, rows: v.rows, tick: v.tick });
      }
      const newly = changes.length ? await writeShares(d, req, deal.id, ctx, changes) : new Set<string>();
      const out: BulkShareResult = { changed: changes.length, skipped, newlyVisibleBuyers: newly.size, newlyVisible: newlyList(ctx, newly) };
      res.json(out);
    } catch (err) {
      send(res, err, "share them");
    }
  });

  // "Share what the DD CIM cites" (§5.3): nothing until dd ships its registry.
  app.get(`${BASE}/dd-cited`, ...guard, async (req, res) => {
    try {
      const d = await deps();
      const deal = res.locals.deal as Deal;
      const cited = await d.ddCited(deal.id);
      if (!cited) return res.json({ available: false, share: [], check: [], cannot: [] });
      const ctx = await loadBrokerContext(brokerDeps(d), deal);
      const { snap } = ctx;
      const share: Array<{ itemId: string | null; documentId: string; title: string; place: boolean }> = [];
      const check: Array<{ itemId: string; title: string; flags: unknown[] }> = [];
      const cannot: Array<{ documentId: string | null; reason: string }> = [];
      let privateCount = 0;
      for (const id of Array.from(new Set(cited))) {
        const doc = snap.docs.get(id);
        if (!doc) continue;
        if (doc.visibility === "broker_only") { privateCount++; continue; }
        if (!isRoomMaterial(doc)) { cannot.push({ documentId: id, reason: "Not a document that can go in the data room." }); continue; }
        const item = snap.items.find((i) => i.documentId === id && !i.removedAt);
        const isLedger = isLedgerItemDoc(doc);
        if (isLedger && item?.prepared?.kind !== "ledger") { cannot.push({ documentId: id, reason: "General ledger: Cimple hasn't read it yet. Open Financials → Add-backs in the books." }); continue; }
        if (!item) { share.push({ itemId: null, documentId: id, title: doc.name, place: true }); continue; }
        if (snap.shares.some((s) => s.itemId === item.id && s.audience === "level" && s.accessLevel === DD_ACCESS_LEVEL)) continue;
        const f = flagsFor(item, doc, { privateMatters: ctx.pm.get(doc.id) ?? [], fileMissing: false, isLedger });
        if (f.unchecked.length) check.push({ itemId: item.id, title: item.title, flags: f.flags.filter((x) => f.unchecked.includes(x.key)) });
        else share.push({ itemId: item.id, documentId: id, title: item.title, place: false });
      }
      if (privateCount) cannot.push({ documentId: null, reason: `${privateCount} private ${privateCount === 1 ? "file" : "files"} (broker-only)` });
      res.json({ available: true, share, check, cannot });
    } catch (err) {
      send(res, err, "load what the DD CIM cites");
    }
  });

  app.post(`${BASE}/share-dd-cited`, ...guard, async (req, res) => {
    try {
      const d = await deps();
      const deal = res.locals.deal as Deal;
      await requireRoom(d, deal.id);
      const cited = new Set((await d.ddCited(deal.id)) ?? []);
      const docIds = Array.isArray(req.body?.documentIds) ? (req.body.documentIds as unknown[]) : [];
      const itemIds = Array.isArray(req.body?.itemIds) ? (req.body.itemIds as unknown[]) : [];
      if (docIds.length + itemIds.length > 500) throw bad("Too many documents.");
      const placed: string[] = [];
      for (const id of docIds) {
        if (!isId(id) || !cited.has(id)) throw notFound();
        const doc = await d.store.getDocument(id);
        if (!doc || doc.dealId !== deal.id) throw notFound();
        const it = await fileDocumentIntoRoom(deal.id, id, "broker", { explicit: true }, d.setup());
        if (it) placed.push(it.id);
      }
      const ids = [...itemIds.map((x) => String(x)), ...placed];
      const ctx = await loadBrokerContext(brokerDeps(d), deal);
      const ticksBy = (req.body?.checkedFlags && typeof req.body.checkedFlags === "object") ? (req.body.checkedFlags as Record<string, unknown>) : {};
      const changes: Array<{ item: VdrItem; rows: any[]; tick: VdrFlagKey[] }> = [];
      const skipped: BulkShareResult["skipped"] = [];
      for (const id of Array.from(new Set(ids))) {
        const item = ctx.snap.items.find((i) => i.id === id && !i.removedAt);
        if (!item || !item.documentId || !cited.has(item.documentId)) throw notFound();
        const doc = ctx.snap.docs.get(item.documentId) ?? null;
        const isLedger = isLedgerItemDoc(doc);
        const cur = currentShareInput(ctx.snap.shares.filter((s) => s.itemId === item.id), ctx.groups);
        const next = { ...cur, levels: Array.from(new Set([...cur.levels, DD_ACCESS_LEVEL])) };
        const { unchecked } = flagsFor(item, doc, { privateMatters: doc ? ctx.pm.get(doc.id) ?? [] : [], fileMissing: false, isLedger });
        const ticked = Array.isArray(ticksBy[item.id]) ? (ticksBy[item.id] as unknown[]).filter((x): x is string => typeof x === "string") : [];
        const v = validateShares({ dealId: deal.id, item, isLedger, unchecked, checkedFlags: ticked, accessRows: ctx.rows, input: next, by: by(req), now: ctx.now });
        if (!v.ok) { skipped.push({ itemId: item.id, title: item.title, reason: v.failure.body.code === "check_first" ? "Needs your check first." : String(v.failure.body.error) }); continue; }
        changes.push({ item, rows: v.rows, tick: v.tick });
      }
      const newly = changes.length ? await writeShares(d, req, deal.id, ctx, changes) : new Set<string>();
      res.json({ changed: changes.length, skipped, newlyVisibleBuyers: newly.size, newlyVisible: newlyList(ctx, newly), itemIds: changes.map((c) => c.item.id) } satisfies BulkShareResult & { itemIds: string[] });
    } catch (err) {
      send(res, err, "share them");
    }
  });

  // ── Upload ─────────────────────────────────────────────────────────────

  const roomUpload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => {
        const dir = path.join(uploadsRoot(), "docs");
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (_req, file, cb) => cb(null, newDocumentFileName("doc", extensionOf(file.originalname))),
    }),
    limits: { fileSize: VDR_LIMITS.uploadBytes, files: 1 },
    fileFilter: (req, file, cb) => {
      const why = uploadRefusal(decodeUploadName(file.originalname));
      if (why) (req as any).vdrRefusal = why;
      cb(null, !why);
    },
  });

  // Who may upload is checked BEFORE the file is written (requireBroker + this deal).
  app.post(`${BASE}/upload`, ...guard, async (req, res, next) => {
    try {
      const d = await deps();
      await requireRoom(d, req.params.dealId);
      next();
    } catch (err) {
      send(res, err, "upload");
    }
  }, (req, res, next) => roomUpload.single("file")(req, res, (err: any) => {
    if (err) return res.status(400).json({ error: err?.code === "LIMIT_FILE_SIZE" ? "Too large (over 20 MB). Save a smaller copy or split it." : "Couldn't receive the file." });
    next();
  }), async (req, res) => {
    const tmp = req.file?.path;
    try {
      const d = await deps();
      const dealId = req.params.dealId;
      if (!req.file) throw bad((req as any).vdrRefusal || "Choose a file.");
      const folder = await dealFolder(d, dealId, req.body?.folderId);
      const folders = await d.store.listFolders(dealId);
      const create = d.createUpload ?? (await import("../documents/upload")).createUploadedDocument;
      let itemId: string | null = null;
      const out = await create({
        dealId,
        file: req.file,
        uploadedBy: "broker",
        body: { category: categoryForFolder(folders, folder.id), sourceKind: "document", visibility: "shared" },
        readSkipped: req.body?.read === "store_only",
        beforeParse: async (doc) => {
          const it = await fileDocumentIntoRoom(dealId, doc.id, "broker", { explicit: true, folderId: folder.id }, d.setup());
          itemId = it?.id ?? null;
        },
      });
      if (!out.ok) return res.status(out.status).json({ error: out.error });
      res.json({ documentId: out.doc.id, itemId });
    } catch (err) {
      if (tmp && fs.existsSync(tmp)) fs.unlink(tmp, () => {});
      send(res, err, "upload the file");
    }
  });

  // ── Buyers ─────────────────────────────────────────────────────────────

  app.get(`${BASE}/buyers`, ...guard, async (req, res) => {
    try {
      const d = await deps();
      const deal = res.locals.deal as Deal;
      const ctx = await loadBrokerContext(brokerDeps(d), deal);
      const team = await d.store.listTeamMembers(deal.id).catch(() => []);
      res.json(buildBuyers(deal.id, ctx.groups, ctx.snap, ctx.views, { root: d.root(), now: ctx.now, privateMatters: ctx.pm, team }));
    } catch (err) {
      send(res, err, "load the buyers");
    }
  });

  app.patch(`${BASE}/buyers/:accessId`, ...guard, async (req, res) => {
    try {
      const d = await deps();
      const dealId = req.params.dealId;
      const link = await dealAccess(d, dealId, req.params.accessId);
      const rule = dataRoomLevelRule(link.accessLevel);
      if (rule === "never_teaser" || rule === "never_blind") throw new VdrHttpError(409, { error: "Teaser and Blind CIM buyers don't get a data room. Move them to Full CIM first." });
      const key = buyerKey(link.buyerEmail);
      const patch: Record<string, unknown> = { updatedBy: by(req) };
      const logs: InsertVdrActivity[] = [];
      if (req.body?.roomAccess !== undefined) {
        const v = req.body.roomAccess;
        if (v !== "auto" && v !== "on" && v !== "off") throw bad("Choose on or off.");
        // Due diligence: automatic (on) or off; Full CIM: on or off.
        patch.roomAccess = rule === "auto_on" ? (v === "off" ? "off" : "auto") : v === "on" ? "on" : "off";
        logs.push(brokerLog(req, dealId, "buyer_room_changed", { buyerEmail: key, detail: { roomAccess: patch.roomAccess } }));
      }
      if (typeof req.body?.allowDownloads === "boolean") {
        patch.allowDownloads = req.body.allowDownloads;
        logs.push(brokerLog(req, dealId, "buyer_downloads_changed", { buyerEmail: key, detail: { allowDownloads: req.body.allowDownloads } }));
      }
      const row = await d.store.upsertBuyerSettings(dealId, key, patch as any);
      await logVdrQuietly(d.store, logs);
      res.json({ roomAccess: row.roomAccess, allowDownloads: row.allowDownloads });
    } catch (err) {
      send(res, err, "save the buyer's access");
    }
  });

  // ── Citations in the broker's CIM preview (vdr spec §11.1.2): always the document's own name ──

  app.get(`${BASE}/resolve`, ...guard, async (req, res) => {
    try {
      const d = await deps();
      const deal = res.locals.deal as Deal;
      const ids = parseDocumentIds(req.query.documentIds);
      if (!ids) throw bad("Malformed");
      const snap = await loadRoom(d.store, deal.id);
      const replacements = await replacementsFor(d.store, deal.id);
      res.setHeader("Cache-Control", "no-store");
      res.json({ documents: resolveForBroker(ids, deal.id, snap.docs, snap, replacements) });
    } catch (err) {
      send(res, err, "look up the documents");
    }
  });

  // ── A buyer's team (vdr spec §5.7, §6.8): the link only on the broker's click ──

  /** A fresh link for a member (only its hash is kept): emailed when asked, and returned once so it can be copied. */
  async function issueTeamLink(d: DataRoomRouteDeps, req: Request, deal: Deal, memberId: string, principal: BuyerAccess, to: string, send: boolean) {
    const { token, hash } = newTeamToken();
    await d.store.updateTeamMember(memberId, { tokenHash: hash, status: "active", ...(send && !deal.demoKey ? { linkSentAt: d.now() } : {}) });
    let emailed: { sent: boolean; demo: boolean } = { sent: false, demo: !!deal.demoKey };
    if (send) {
      emailed = await sendTeamLinkEmail(d.buyerEmail, { deal, brokerId: by(req), to, token, principalCompany: principalCompanyOf(principal) });
      await logVdrQuietly(d.store, brokerLog(req, deal.id, "team_link_sent", { buyerEmail: buyerKey(principal.buyerEmail), detail: { memberId, sent: emailed.sent, demo: emailed.demo } }));
    }
    return { link: teamLinkUrl(d.buyerEmail.appUrl(), token), emailed };
  }

  /** The buyer's best room link (their team works through it), or a plain refusal. */
  async function principalWithRoom(d: DataRoomRouteDeps, deal: Deal, principalEmail: string) {
    const ctx = await loadBrokerContext(brokerDeps(d), deal);
    const g = ctx.groups.find((x) => x.key === principalEmail);
    if (!g?.eligible || !g.hasRoom) throw new VdrHttpError(409, { error: "Turn the data room on for this buyer first. Their team works through their access." });
    return g.eligible;
  }

  app.post(`${BASE}/buyers/:accessId/team`, ...guard, async (req, res) => {
    try {
      const d = await deps();
      const deal = res.locals.deal as Deal;
      await requireRoom(d, deal.id);
      const link = await dealAccess(d, deal.id, req.params.accessId);
      const input = parseTeamInput(req.body);
      if ("error" in input) throw bad(input.error);
      const key = buyerKey(link.buyerEmail);
      const principal = await principalWithRoom(d, deal, key);
      const members = await d.store.listTeamMembers(deal.id);
      const problem = teamAddProblem(members, principal, input);
      if (problem) throw new VdrHttpError(409, { error: problem });
      // A person removed or declined before comes back on the same row.
      const old = members.find((m) => m.principalEmail === key && m.email === input.email);
      let member = old ?? null;
      if (old) await d.store.updateTeamMember(old.id, { name: input.name, role: input.role, status: "active", ackAt: null, ackName: null, ackIpHash: null, createdBy: "broker", addedViaAccessId: principal.id });
      else member = await d.store.insertTeamMember({ dealId: deal.id, principalEmail: key, addedViaAccessId: principal.id, name: input.name, email: input.email, role: input.role, status: "active", createdBy: "broker" });
      if (!member) throw new VdrHttpError(409, { error: "They're already on this buyer's team." });
      await logVdrQuietly(d.store, brokerLog(req, deal.id, "team_added", { buyerEmail: key, detail: { memberId: member.id, role: input.role } }));
      const out = await issueTeamLink(d, req, deal, member.id, principal, input.email, req.body?.send === true);
      res.json({ id: member.id, ...out });
    } catch (err) {
      send(res, err, "add them");
    }
  });

  app.patch(`${BASE}/team/:memberId`, ...guard, async (req, res) => {
    try {
      const d = await deps();
      const deal = res.locals.deal as Deal;
      if (!isId(req.params.memberId)) throw notFound();
      const m = await d.store.getTeamMember(req.params.memberId);
      if (!m || m.dealId !== deal.id) throw notFound();
      const action = String(req.body?.action ?? "");
      const send = req.body?.send === true;
      if (action === "decline") {
        if (m.status !== "requested") throw new VdrHttpError(409, { error: "There's nothing to decline." });
        await d.store.updateTeamMember(m.id, { status: "declined", tokenHash: null });
        await logVdrQuietly(d.store, brokerLog(req, deal.id, "team_removed", { buyerEmail: m.principalEmail, detail: { memberId: m.id, declined: true } }));
        return res.json({ ok: true });
      }
      if (action === "remove") {
        // The link stops working at once (its hash is cleared).
        await d.store.updateTeamMember(m.id, { status: "removed", tokenHash: null });
        await logVdrQuietly(d.store, brokerLog(req, deal.id, "team_removed", { buyerEmail: m.principalEmail, detail: { memberId: m.id } }));
        return res.json({ ok: true });
      }
      if (action === "approve" || action === "resend" || action === "new_link") {
        if (action === "approve" && m.status !== "requested") throw new VdrHttpError(409, { error: "They're already on the team." });
        if (action !== "approve" && m.status !== "active") throw new VdrHttpError(409, { error: "Add them to the team first." });
        const principal = await principalWithRoom(d, deal, m.principalEmail);
        if (action === "approve") {
          const members = await d.store.listTeamMembers(deal.id);
          const others = members.filter((x) => x.id !== m.id);
          if (others.filter((x) => x.principalEmail === m.principalEmail && x.status === "active").length >= TEAM_MAX) throw new VdrHttpError(409, { error: `A buyer can have up to ${TEAM_MAX} people on their team. Remove someone first.` });
          await logVdrQuietly(d.store, brokerLog(req, deal.id, "team_added", { buyerEmail: m.principalEmail, detail: { memberId: m.id, role: m.role, approved: true } }));
        }
        const out = await issueTeamLink(d, req, deal, m.id, principal, m.email, action === "resend" ? true : send);
        return res.json({ ok: true, ...out });
      }
      throw bad("Choose approve, decline, remove or send the link again.");
    } catch (err) {
      send(res, err, "update their access");
    }
  });

  // ── Viewing (broker, or "View as a buyer" with ?as=<accessId>) ─────────

  /** Resolves `as=`: a gate for that buyer's link (same checks the buyer gets), and that item decided for them. */
  async function asBuyer(d: DataRoomRouteDeps, deal: Deal, asId: unknown) {
    const link = await dealAccess(d, deal.id, asId);
    const gate = await gateForLink({ store: d.store, now: d.now }, { access: link, member: null, deal });
    const snap = await loadRoom(d.store, deal.id);
    const pm = privateMattersByDocument(deal, snap.items.filter((i) => !i.removedAt && i.documentId).map((i) => i.documentId!));
    const decided = decideItems(snap, gate.reader, d.root(), { privateMatters: pm });
    return { gate, snap, decided };
  }

  const previewMark = (gate: Awaited<ReturnType<typeof asBuyer>>["gate"], firm: string | null, at: Date) => ({
    line: `${watermarkLine({ name: gate.viewer.name, email: gate.viewer.email, at, trace: "PREVIEW" })} · PREVIEW`,
    footer: watermarkFooter({ email: gate.viewer.email, at, firm }),
  });

  async function brokerMark(d: DataRoomRouteDeps, req: Request) {
    const name = (await d.brokerName(by(req)).catch(() => null)) || "you";
    return { line: null, footer: `Your view · ${name} · buyers see their own name on every page` };
  }

  app.get(`${BASE}/items/:itemId/view`, ...guard, async (req, res) => {
    try {
      const d = await deps();
      const deal = res.locals.deal as Deal;
      if (req.query.as != null) {
        const { gate, decided } = await asBuyer(d, deal, req.query.as);
        const one = itemFor(decided, String(req.params.itemId), { allowNotReady: true });
        if (!one.item.prepared || one.item.prepared.status !== "ready") kickPrepare(one.item.id);
        const focusPage = req.query.needle != null && one.visibility.visible ? await locateInItem(one.item, req.query.needle, d.store).catch(() => null) : null;
        return res.json({ ...manifestFor(one.item, one.doc, decisionFor(one.item, one.item.prepared ?? null, !!gate.setting?.allowDownloads), "buyer"), focusPage });
      }
      const item = await dealItem(d, deal.id, req.params.itemId);
      const doc = item.documentId ? await d.store.getDocument(item.documentId) : null;
      if (!item.prepared || item.prepared.status !== "ready") kickPrepare(item.id);
      const focusPage = req.query.needle != null ? await locateInItem(item, req.query.needle, d.store).catch(() => null) : null;
      res.json({ ...manifestFor(item, doc, { allowed: true, as: "pages_pdf" }, "broker"), focusPage });
    } catch (err) {
      send(res, err, "open the document");
    }
  });

  app.get(`${BASE}/items/:itemId/pages/:n`, ...guard, async (req, res) => {
    try {
      const d = await deps();
      const deal = res.locals.deal as Deal;
      const n = Number(req.params.n);
      const w = Number(req.query.w) === 700 ? 700 : 1400;
      if (!Number.isInteger(n) || n < 1 || n > 10_000) throw notFound();
      let bytes: Uint8Array;
      if (req.query.as != null) {
        const { gate, decided } = await asBuyer(d, deal, req.query.as);
        const one = itemFor(decided, String(req.params.itemId));
        const brand = await d.brand(deal.brokerId ?? null).catch(() => ({ firmName: null, logoUrl: null }));
        const at = d.now();
        at.setUTCSeconds(0, 0);
        bytes = await pageImage(one.item, one.doc, n, w, previewMark(gate, brand.firmName, at), `preview:${gate.access.id}:${at.getTime()}`, d.serve());
      } else {
        const item = await dealItem(d, deal.id, req.params.itemId);
        const doc = item.documentId ? await d.store.getDocument(item.documentId) : null;
        bytes = await pageImage(item, doc, n, w, await brokerMark(d, req), `broker:${by(req)}`, d.serve());
      }
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Disposition", "inline");
      res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      res.end(Buffer.from(bytes));
    } catch (err) {
      send(res, err, "show the page");
    }
  });

  async function brokerOrPreviewItem(d: DataRoomRouteDeps, deal: Deal, req: Request) {
    if (req.query.as != null) {
      const { decided } = await asBuyer(d, deal, req.query.as);
      return itemFor(decided, String(req.params.itemId)).item;
    }
    return dealItem(d, deal.id, req.params.itemId);
  }

  app.get(`${BASE}/items/:itemId/sheet`, ...guard, async (req, res) => {
    try {
      const d = await deps();
      const item = await brokerOrPreviewItem(d, res.locals.deal as Deal, req);
      const rows = typeof req.query.rows === "string" ? req.query.rows.split(",").map(Number).filter((x) => Number.isInteger(x) && x > 0).slice(0, VDR_LIMITS.rowsMax) : null;
      const out = sheetRows(item, Number(req.query.sheet) || 0, Number(req.query.offset) || 0, Math.min(500, Number(req.query.limit) || 200), rows, d.root());
      if (!out) throw notFound();
      res.setHeader("Cache-Control", "private, no-store");
      res.json(out);
    } catch (err) {
      send(res, err, "show the sheet");
    }
  });

  app.get(`${BASE}/items/:itemId/html`, ...guard, async (req, res) => {
    try {
      const d = await deps();
      const item = await brokerOrPreviewItem(d, res.locals.deal as Deal, req);
      const html = docHtml(item, d.root());
      if (html == null) throw notFound();
      res.setHeader("Cache-Control", "private, no-store");
      res.json({ html });
    } catch (err) {
      send(res, err, "show the document");
    }
  });

  app.get(`${BASE}/items/:itemId/text`, ...guard, async (req, res) => {
    try {
      const d = await deps();
      const item = await brokerOrPreviewItem(d, res.locals.deal as Deal, req);
      const text = docText(item, d.root());
      if (text == null) throw notFound();
      res.setHeader("Cache-Control", "private, no-store");
      res.json({ text });
    } catch (err) {
      send(res, err, "show the document");
    }
  });

  // The broker always gets the original file (their own deal's document).
  app.get(`${BASE}/items/:itemId/download`, ...guard, async (req, res) => {
    try {
      const d = await deps();
      const item = await dealItem(d, req.params.dealId, req.params.itemId);
      const doc = item.documentId ? await d.store.getDocument(item.documentId) : null;
      const abs = doc ? resolveDocumentPath(doc, d.root()) : null;
      if (!doc || !abs || !fs.existsSync(abs)) throw notFound();
      const ext = extensionOf(doc.fileUrl);
      const name = `${item.title.replace(/[\u0000-\u001f"\\/:*?<>|]+/g, " ").trim().slice(0, 100) || "document"}${extensionOf(item.title) ? "" : ext}`;
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
      fs.createReadStream(abs).pipe(res);
    } catch (err) {
      send(res, err, "download it");
    }
  });

  app.get(`${BASE}/preview/:accessId`, ...guard, async (req, res) => {
    try {
      const d = await deps();
      const deal = res.locals.deal as Deal;
      const { gate, snap, decided } = await asBuyer(d, deal, req.params.accessId);
      res.setHeader("Cache-Control", "no-store");
      res.json(await buyerRoomPayload({ store: d.store, brand: d.brand, now: d.now }, gate, snap, decided, { preview: true }));
    } catch (err) {
      send(res, err, "show what the buyer sees");
    }
  });

  app.get(`${BASE}/preview/:accessId/items/:itemId`, ...guard, async (req, res) => {
    try {
      const d = await deps();
      const deal = res.locals.deal as Deal;
      const { gate, snap, decided } = await asBuyer(d, deal, req.params.accessId);
      const one = itemFor(decided, String(req.params.itemId), { allowNotReady: true });
      if (!one.item.prepared || one.item.prepared.status !== "ready") kickPrepare(one.item.id);
      const extras = await buyerAboutExtras({ questionsForDeal: d.questionsForDeal, servedSections: d.servedSections }, gate, snap, decided, one, { preview: true });
      res.json({ ...buyerItemAbout(gate, snap, decided, one), ...extras });
    } catch (err) {
      send(res, err, "show what the buyer sees");
    }
  });

  // ── Pass 3: To do, buyer requests, emails (the broker's click only) ────────

  app.get(`${BASE}/todo`, ...guard, async (req, res) => {
    try {
      const d = await deps();
      const deal = res.locals.deal as Deal;
      await requireRoom(d, deal.id);
      const { waiting } = await roomAndWaiting(brokerDeps(d), deal);
      res.setHeader("Cache-Control", "no-store");
      res.json({ items: waiting } satisfies WaitingPayload);
    } catch (err) {
      send(res, err, "load your to-do list");
    }
  });

  // "Not now" on a new file in a shared folder, "Dismiss" on the DD-cited line.
  app.post(`${BASE}/todo/dismiss`, ...guard, async (req, res) => {
    try {
      const d = await deps();
      const dealId = req.params.dealId;
      const key = typeof req.body?.key === "string" ? req.body.key : "";
      const m = /^hint:([A-Za-z0-9_-]{1,64})$/.exec(key);
      if (m) await dealItem(d, dealId, m[1]);
      else if (key !== "dd_cited") throw bad("Nothing to set aside.");
      await logVdrQuietly(d.store, brokerLog(req, dealId, "todo_dismissed", { itemId: m ? m[1] : null, detail: { key } }));
      res.json({ ok: true });
    } catch (err) {
      send(res, err, "set it aside");
    }
  });

  const requestDeps = (d: DataRoomRouteDeps): RequestDeps => ({ store: d.store, now: d.now, createRequirement: d.createRequirement, requirementsForDeal: d.requirementsForDeal });

  async function dealRequest(d: DataRoomRouteDeps, dealId: string, requestId: unknown): Promise<VdrRequest> {
    if (!isId(requestId)) throw notFound();
    const r = await d.store.getRequest(requestId);
    if (!r || r.dealId !== dealId) throw notFound();
    return r;
  }

  /** Requirement ids already in a "Your broker added … to your checklist" email. */
  async function emailedRequirementIds(d: DataRoomRouteDeps, dealId: string): Promise<{ ids: Set<string>; lastAt: string | null }> {
    const rows = await d.store.listActivityByActions(dealId, ["seller_emailed"]).catch(() => []);
    const ids = new Set<string>();
    for (const r of rows) for (const id of (((r.detail ?? {}) as Record<string, unknown>).requirementIds as string[] | undefined) ?? []) ids.add(id);
    return { ids, lastAt: rows[0] ? new Date(rows[0].at).toISOString() : null };
  }

  app.get(`${BASE}/requests`, ...guard, async (req, res) => {
    try {
      const d = await deps();
      const deal = res.locals.deal as Deal;
      const [ctx, requests, requirements, team, emailed] = await Promise.all([
        loadBrokerContext(brokerDeps(d), deal),
        d.store.listRequests(deal.id),
        d.requirementsForDeal(deal.id).catch(() => [] as DealDocumentRequirement[]),
        d.store.listTeamMembers(deal.id).catch(() => []),
        emailedRequirementIds(d, deal.id),
      ]);
      const status = typeof req.query.status === "string" ? req.query.status : null;
      const numbers = indexNumbers(ctx.snap.folders, ctx.snap.items);
      const rows = brokerRequestRows({ requests: status ? requests.filter((r) => r.status === status) : requests, groups: ctx.groups, accessRows: ctx.rows, items: ctx.snap.items, numbers: numbers.items, docs: ctx.snap.docs, requirements, team });
      const unsent = requests.filter((r) => r.status === "asked_seller" && r.requirementId && !emailed.ids.has(r.requirementId)).map((r) => r.requirementId!);
      res.setHeader("Cache-Control", "no-store");
      res.json({ ...rows, sellerEmail: { lastAt: emailed.lastAt, unsent: Array.from(new Set(unsent)) } });
    } catch (err) {
      send(res, err, "load the requests");
    }
  });

  /** Shares an item with the buyer who asked (their own grant), within the sharing rules. */
  async function shareWithRequester(d: DataRoomRouteDeps, req: Request, deal: Deal, r: VdrRequest, itemId: string, opts: { turnOnRoom?: boolean; checkedFlags?: string[] }) {
    const ctx = await loadBrokerContext(brokerDeps(d), deal);
    const item = ctx.snap.items.find((i) => i.id === itemId && !i.removedAt);
    if (!item) throw notFound();
    const doc = item.documentId ? ctx.snap.docs.get(item.documentId) ?? null : null;
    if (!doc || !isRoomMaterial(doc)) throw bad("That document can't be shared.");
    const group = ctx.groups.find((g) => g.key === r.buyerEmail);
    const link = group?.eligible ?? null;
    if (!group || !link) {
      const any = group?.rows[0] ?? ctx.rows.find((a) => a.id === r.buyerAccessId);
      const why = any ? roomIneligibleReason(any, ctx.now) : null;
      throw new VdrHttpError(409, { code: "not_eligible", error: why === "blind" ? "They're on the Blind CIM. Move them to Full CIM first (Buyers view)." : why ? `They can't have documents yet: ${ineligibleCopy(why).toLowerCase()}.` : "They can't have documents yet." });
    }
    if (!group.hasRoom) {
      if (!opts.turnOnRoom) throw new VdrHttpError(409, { code: "no_room", error: `${link.buyerCompany || link.buyerName || link.buyerEmail} doesn't have the data room. Turn it on for them?` });
      const rule = dataRoomLevelRule(link.accessLevel);
      await d.store.upsertBuyerSettings(deal.id, group.key, { roomAccess: rule === "auto_on" ? "auto" : "on", updatedBy: by(req) } as any);
      await logVdrQuietly(d.store, brokerLog(req, deal.id, "buyer_room_changed", { buyerEmail: group.key, detail: { roomAccess: "on" } }));
    }
    const fresh = opts.turnOnRoom ? await loadBrokerContext(brokerDeps(d), deal) : ctx;
    const isLedger = isLedgerItemDoc(doc);
    const cur = currentShareInput(fresh.snap.shares.filter((s) => s.itemId === item.id), fresh.groups);
    const next = { ...cur, allow: Array.from(new Set([...cur.allow, link.id])), deny: cur.deny.filter((id) => buyerKey(fresh.rows.find((x) => x.id === id)?.buyerEmail) !== group.key) };
    const { unchecked } = flagsFor(item, doc, { privateMatters: fresh.pm.get(doc.id) ?? [], fileMissing: false, isLedger });
    const v = validateShares({ dealId: deal.id, item, isLedger, unchecked, checkedFlags: opts.checkedFlags ?? [], accessRows: fresh.rows, input: next, by: by(req), now: fresh.now });
    if (!v.ok) {
      if (v.failure.body.code === "check_first") throw new VdrHttpError(409, { ...v.failure.body, itemId: item.id });
      throw new VdrHttpError(v.failure.status, v.failure.body);
    }
    await writeShares(d, req, deal.id, fresh, [{ item, rows: v.rows, tick: v.tick }]);
    await markShared(requestDeps(d), r, item.id, by(req));
    return { item, link };
  }

  app.patch(`${BASE}/requests/:requestId`, ...guard, async (req, res) => {
    try {
      const d = await deps();
      const deal = res.locals.deal as Deal;
      const r = await dealRequest(d, deal.id, req.params.requestId);
      const b = req.body ?? {};
      const action = b.action;
      if (action === "decline") {
        await declineRequests(requestDeps(d), deal.id, [r], typeof b.note === "string" ? b.note : null, by(req));
        return res.json({ ok: true, status: "declined" });
      }
      if (r.status === "shared" || r.status === "declined") throw new VdrHttpError(409, { error: "This request has already been answered." });
      if (action === "share") {
        if (r.kind !== "document") throw bad("Use 'Give them the data room' for an access request.");
        await shareWithRequester(d, req, deal, r, String(b.itemId ?? ""), { turnOnRoom: b.turnOnRoom === true, checkedFlags: Array.isArray(b.checkedFlags) ? b.checkedFlags.filter((x: unknown): x is string => typeof x === "string") : [] });
        return res.json({ ok: true, status: "shared" });
      }
      if (action === "grant_room") {
        if (r.kind !== "room_access") throw bad("This is a request for a document.");
        const ctx = await loadBrokerContext(brokerDeps(d), deal);
        const group = ctx.groups.find((g) => g.key === r.buyerEmail);
        const link = group?.eligible ?? null;
        if (!link) {
          const any = group?.rows[0] ?? ctx.rows.find((a) => a.id === r.buyerAccessId);
          const why = any ? roomIneligibleReason(any, ctx.now) : null;
          throw new VdrHttpError(409, { code: why === "blind" ? "blind" : "not_eligible", accessId: any?.id ?? null, error: why === "blind" ? "They're on the Blind CIM. Move them to Full CIM first, then give them the data room." : why ? `They can't have the data room yet: ${ineligibleCopy(why).toLowerCase()}.` : "They can't have the data room yet." });
        }
        await d.store.upsertBuyerSettings(deal.id, r.buyerEmail, { roomAccess: dataRoomLevelRule(link.accessLevel) === "auto_on" ? "auto" : "on", updatedBy: by(req) } as any);
        await d.store.updateRequest(r.id, { status: "shared", resolvedAt: d.now(), resolvedBy: by(req) });
        await logVdrQuietly(d.store, [
          brokerLog(req, deal.id, "buyer_room_changed", { buyerEmail: r.buyerEmail, detail: { roomAccess: "on" } }),
          brokerLog(req, deal.id, "request_resolved", { buyerEmail: r.buyerEmail, detail: { requestId: r.id, how: "room_access" } }),
        ]);
        return res.json({ ok: true, status: "shared" });
      }
      if (action === "ask_seller") {
        if (r.kind !== "document") throw bad("Ask the seller is for documents.");
        if (r.status === "asked_seller" || r.status === "ready_to_share") throw new VdrHttpError(409, { error: "The seller has already been asked for this." });
        const needed = parseNeededBy(b.neededBy, d.now());
        if (!needed.ok) throw bad(needed.error);
        const name = typeof b.requirementName === "string" ? b.requirementName.replace(/\s+/g, " ").trim().slice(0, 200) : "";
        const note = typeof b.requirementNote === "string" ? b.requirementNote : null;
        let folderPresetKey: string | null = null;
        if (r.itemId) {
          const it = await d.store.getItem(r.itemId);
          if (it && it.dealId === deal.id) folderPresetKey = (await d.store.listFolders(deal.id)).find((f) => f.id === it.folderId)?.presetKey ?? null;
        }
        const created = await askSeller(requestDeps(d), deal.id, [r], { name: name || null, note, neededBy: needed.at, folderPresetKey }, by(req));
        return res.json({ ok: true, status: "asked_seller", requirementIds: created.map((c) => c.id) });
      }
      throw bad("Choose what to do with the request.");
    } catch (err) {
      send(res, err, "answer the request");
    }
  });

  app.post(`${BASE}/requests/bulk`, ...guard, async (req, res) => {
    try {
      const d = await deps();
      const deal = res.locals.deal as Deal;
      const ids = req.body?.requestIds;
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > 200) throw bad("Choose the requests.");
      const rows: VdrRequest[] = [];
      for (const id of Array.from(new Set(ids))) rows.push(await dealRequest(d, deal.id, id));
      if (req.body?.action === "decline") {
        const n = await declineRequests(requestDeps(d), deal.id, rows, typeof req.body?.note === "string" ? req.body.note : null, by(req));
        return res.json({ ok: true, declined: n });
      }
      if (req.body?.action === "ask_seller") {
        const needed = parseNeededBy(req.body?.neededBy, d.now());
        if (!needed.ok) throw bad(needed.error);
        const todo = rows.filter((r) => r.kind === "document" && r.status === "open");
        const created = await askSeller(requestDeps(d), deal.id, todo, { note: typeof req.body?.note === "string" ? req.body.note : null, neededBy: needed.at }, by(req));
        return res.json({ ok: true, asked: created.length, requirementIds: created.map((c) => c.id) });
      }
      throw bad("Choose what to do with the requests.");
    } catch (err) {
      send(res, err, "answer the requests");
    }
  });

  // "Email the seller now" — one email for these checklist rows (and any other asks not emailed yet).
  app.post(`${BASE}/requests/email-seller`, ...guard, async (req, res) => {
    try {
      const d = await deps();
      const deal = res.locals.deal as Deal;
      const ids = req.body?.requirementIds;
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > 200) throw bad("Choose what to ask the seller for.");
      const all = await d.requirementsForDeal(deal.id);
      const wanted: DealDocumentRequirement[] = [];
      for (const id of Array.from(new Set(ids))) {
        const row = all.find((x) => x.id === id && x.dealId === deal.id);
        if (!row) throw notFound();
        if (row.source !== "buyer_request") throw bad("Only documents asked for from buyers' requests are emailed here.");
        wanted.push(row);
      }
      const emailed = await emailedRequirementIds(d, deal.id);
      const requests = await d.store.listRequests(deal.id);
      const pendingIds = new Set(requests.filter((r) => r.status === "asked_seller" && r.requirementId).map((r) => r.requirementId!));
      // Asks from the last 10 minutes that weren't emailed go in the same email.
      const recent = all.filter((x) => x.source === "buyer_request" && x.status === "missing" && pendingIds.has(x.id) && !emailed.ids.has(x.id) && !wanted.some((w) => w.id === x.id) && d.now().getTime() - new Date(x.createdAt).getTime() <= 10 * 60_000);
      const rows = [...wanted, ...recent];
      const r = await emailSellerAboutRequests(d.sellerEmail, deal, rows.map((x) => ({ id: x.id, documentName: x.documentName, notes: x.notes, neededBy: x.neededBy })));
      await logVdrQuietly(d.store, brokerLog(req, deal.id, "seller_emailed", { detail: { count: rows.length, requirementIds: rows.map((x) => x.id), recipients: r.recipients, sent: r.emailsSent, demo: r.demo, event: r.event } }));
      res.json({ count: rows.length, recipients: r.recipients, sent: r.emailsSent, demo: r.demo });
    } catch (err) {
      send(res, err, "email the seller");
    }
  });

  // "Ready to share" → one click: the buyer who asked can open it, the request closes, and the prefilled email comes back.
  app.post(`${BASE}/requests/:requestId/share-and-tell`, ...guard, async (req, res) => {
    try {
      const d = await deps();
      const deal = res.locals.deal as Deal;
      const r = await dealRequest(d, deal.id, req.params.requestId);
      if (r.status !== "ready_to_share" || !r.readyDocumentId) throw new VdrHttpError(409, { error: "The seller hasn't uploaded it yet." });
      const doc = await d.store.getDocument(r.readyDocumentId);
      if (!doc || doc.dealId !== deal.id) throw notFound();
      const item = await fileDocumentIntoRoom(deal.id, doc.id, "broker", { explicit: true }, d.setup());
      if (!item) throw bad("That document can't go in the data room.");
      const { link } = await shareWithRequester(d, req, deal, r, item.id, { turnOnRoom: req.body?.turnOnRoom === true, checkedFlags: Array.isArray(req.body?.checkedFlags) ? req.body.checkedFlags.filter((x: unknown): x is string => typeof x === "string") : [] });
      const who = await d.buyerEmail.broker(by(req)).catch(() => ({ name: null, email: null, company: null }));
      const draft = tellBuyerDraft(item.title, who.name || who.company);
      res.json({ ok: true, itemId: item.id, draft: { to: [link.buyerCompany || link.buyerName || link.buyerEmail], subject: draft.subject, message: draft.message, demo: !!deal.demoKey } satisfies EmailDraft });
    } catch (err) {
      send(res, err, "share it");
    }
  });

  app.get(`${BASE}/requests/:requestId/tell-buyer`, ...guard, async (req, res) => {
    try {
      const d = await deps();
      const deal = res.locals.deal as Deal;
      const r = await dealRequest(d, deal.id, req.params.requestId);
      const ctx = await loadBrokerContext(brokerDeps(d), deal);
      const item = r.itemId ? ctx.snap.items.find((i) => i.id === r.itemId) ?? null : null;
      const link = ctx.groups.find((g) => g.key === r.buyerEmail)?.eligible ?? null;
      const who = await d.buyerEmail.broker(by(req)).catch(() => ({ name: null, email: null, company: null }));
      const draft = tellBuyerDraft(item?.title ?? r.text, who.name || who.company);
      res.json({ to: link ? [link.buyerCompany || link.buyerName || link.buyerEmail] : [], subject: draft.subject, message: draft.message, demo: !!deal.demoKey } satisfies EmailDraft);
    } catch (err) {
      send(res, err, "prepare the email");
    }
  });

  const emailText = (b: any) => {
    const subject = typeof b?.subject === "string" ? b.subject.replace(/\s+/g, " ").trim().slice(0, 200) : "";
    const message = typeof b?.message === "string" ? b.message.trim().slice(0, 2000) : "";
    if (!subject || !message) throw bad("Write a subject and a message.");
    return { subject, message };
  };

  app.post(`${BASE}/requests/:requestId/tell-buyer`, ...guard, async (req, res) => {
    try {
      const d = await deps();
      const deal = res.locals.deal as Deal;
      const r = await dealRequest(d, deal.id, req.params.requestId);
      if (r.status !== "shared") throw new VdrHttpError(409, { error: "Share the document first." });
      const { subject, message } = emailText(req.body);
      const ctx = await loadBrokerContext(brokerDeps(d), deal);
      const link = ctx.groups.find((g) => g.key === r.buyerEmail)?.eligible ?? null;
      if (!link) throw new VdrHttpError(409, { error: "Their link has ended, so there's nothing to send them to." });
      const out = await sendBrokerEmailToBuyers(d.buyerEmail, { deal, brokerId: by(req), to: [{ accessToken: link.accessToken, buyerEmail: link.buyerEmail, buyerUserId: (link as any).buyerUserId ?? null, itemId: r.itemId }], subject, message });
      await logVdrQuietly(d.store, brokerLog(req, deal.id, "told_buyer", { itemId: r.itemId, buyerEmail: r.buyerEmail, detail: { requestId: r.id, sent: out.sent, demo: out.demo } }));
      res.json(out);
    } catch (err) {
      send(res, err, "send the email");
    }
  });

  // "Let them know?" after a share: the draft, then the broker's send.
  async function digestTargets(d: DataRoomRouteDeps, deal: Deal, body: any) {
    const itemIds = body?.itemIds;
    const accessIds = body?.accessIds;
    if (!Array.isArray(itemIds) || itemIds.length === 0 || itemIds.length > 200) throw bad("Choose the documents.");
    if (!Array.isArray(accessIds) || accessIds.length === 0 || accessIds.length > 50) throw bad("Choose who to tell.");
    const ctx = await loadBrokerContext(brokerDeps(d), deal);
    const items: VdrItem[] = [];
    for (const id of Array.from(new Set(itemIds))) {
      const it = ctx.snap.items.find((i) => i.id === id && !i.removedAt);
      if (!it) throw notFound();
      items.push(it);
    }
    const links: BuyerAccess[] = [];
    for (const id of Array.from(new Set(accessIds))) {
      const a = ctx.rows.find((r) => r.id === id);
      if (!a) throw notFound();
      links.push(a);
    }
    // Only buyers who can open at least one of these documents right now.
    const to: Array<{ link: BuyerAccess; itemId: string }> = [];
    for (const a of links) {
      const g = ctx.groups.find((x) => x.key === buyerKey(a.buyerEmail));
      if (!g?.eligible || !g.hasRoom) continue;
      const reader = { dealId: deal.id, accessLevel: g.eligible.accessLevel, buyerEmail: g.key, mode: (dataRoomLevelRule(g.eligible.accessLevel) === "auto_on" ? "dd" : "normal") as "dd" | "normal" };
      const decided = decideItems(ctx.snap, { ...reader, accessLevel: parseAccessLevelInput(reader.accessLevel) ?? reader.accessLevel }, d.root(), { privateMatters: ctx.pm });
      const visible = items.filter((it) => decided.some((x) => x.item.id === it.id && x.visibility.visible));
      if (visible.length > 0 && !to.some((t) => t.link.id === g.eligible!.id)) to.push({ link: g.eligible, itemId: visible[0].id });
    }
    return { items, to };
  }

  app.post(`${BASE}/let-buyers-know/draft`, ...guard, async (req, res) => {
    try {
      const d = await deps();
      const deal = res.locals.deal as Deal;
      const { items, to } = await digestTargets(d, deal, req.body);
      const who = await d.buyerEmail.broker(by(req)).catch(() => ({ name: null, email: null, company: null }));
      const draft = letBuyersKnowDraft(deal.businessName, items.map((i) => i.title), who.name || who.company);
      res.json({ to: to.map((t) => t.link.buyerCompany || t.link.buyerName || t.link.buyerEmail), subject: draft.subject, message: draft.message, demo: !!deal.demoKey } satisfies EmailDraft);
    } catch (err) {
      send(res, err, "prepare the email");
    }
  });

  app.post(`${BASE}/let-buyers-know`, ...guard, async (req, res) => {
    try {
      const d = await deps();
      const deal = res.locals.deal as Deal;
      const { subject, message } = emailText(req.body);
      const { items, to } = await digestTargets(d, deal, req.body);
      if (to.length === 0) throw new VdrHttpError(409, { error: "None of them can open these documents right now." });
      const out = await sendBrokerEmailToBuyers(d.buyerEmail, { deal, brokerId: by(req), to: to.map((t) => ({ accessToken: t.link.accessToken, buyerEmail: t.link.buyerEmail, buyerUserId: (t.link as any).buyerUserId ?? null, itemId: items.length === 1 ? t.itemId : null })), subject, message });
      await logVdrQuietly(d.store, brokerLog(req, deal.id, "buyers_emailed", { detail: { count: to.length, items: items.length, sent: out.sent, demo: out.demo } }));
      res.json({ ...out, recipients: to.length });
    } catch (err) {
      send(res, err, "send the email");
    }
  });

  // The Q&A tab's document chips (§5.12): which document and page each data-room question is about, and who asked.
  app.get(`${BASE}/questions`, ...guard, async (req, res) => {
    try {
      const d = await deps();
      const deal = res.locals.deal as Deal;
      const [questions, items, folders, rows, team] = await Promise.all([
        d.questionsForDeal(deal.id).catch(() => [] as BuyerQuestion[]),
        d.store.listItems(deal.id),
        d.store.listFolders(deal.id),
        d.accessRowsForDeal(deal.id),
        d.store.listTeamMembers(deal.id).catch(() => []),
      ]);
      const numbers = indexNumbers(folders, items).items;
      const out = questions.filter((q) => q.vdrItemId).map((q) => {
        const it = items.find((i) => i.id === q.vdrItemId);
        const link = rows.find((r) => r.id === q.buyerAccessId);
        const buyer = link ? (link.buyerCompany || link.buyerName || link.buyerEmail) : "A buyer";
        const m = q.vdrTeamMemberId ? team.find((t) => t.id === q.vdrTeamMemberId) : null;
        return {
          id: q.id,
          itemId: it && !it.removedAt ? it.id : null,
          number: it ? numbers.get(it.id) ?? null : null,
          title: it?.title ?? "A document no longer in the room",
          page: q.vdrPage ?? null,
          buyer,
          askedBy: askerLabel(buyer, m ?? null),
          scope: q.answerScope === "room" ? "room" : "private",
        };
      });
      res.setHeader("Cache-Control", "no-store");
      res.json(out);
    } catch (err) {
      send(res, err, "load the document questions");
    }
  });

  // ── Pass 3: descriptions (V12) ─────────────────────────────────────────────

  // The Share dialog opens for a document without a description: queue one (no AI call here).
  app.post(`${BASE}/items/:itemId/summary/ensure`, ...guard, async (req, res) => {
    try {
      const d = await deps();
      const item = await dealItem(d, req.params.dealId, req.params.itemId);
      const n = await requestSummaries(d.store, item.dealId, [item.id], d.now());
      res.json({ queued: n > 0 });
    } catch (err) {
      send(res, err, "ask for a description");
    }
  });

  // "Draft again" — the broker's click (aiLimiter + the deal's daily cap).
  app.post(`${BASE}/items/:itemId/summary`, ...guard, async (req, res) => {
    try {
      const d = await deps();
      const deal = res.locals.deal as Deal;
      await dealItem(d, deal.id, req.params.itemId);
      const r = await redraftOne(d.summary(), deal, String(req.params.itemId));
      res.status(r.ok ? 200 : 409).json({ ...r, error: r.ok ? undefined : r.message });
    } catch (err) {
      send(res, err, "draft the description");
    }
  });

  // "Use all" (To do › Descriptions to accept).
  app.post(`${BASE}/summaries/accept`, ...guard, async (req, res) => {
    try {
      const d = await deps();
      const dealId = req.params.dealId;
      const ids = req.body?.itemIds;
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > 500) throw bad("Choose the descriptions.");
      let n = 0;
      const logs: InsertVdrActivity[] = [];
      for (const id of Array.from(new Set(ids))) {
        const it = await dealItem(d, dealId, id);
        if (it.buyerSummary && it.buyerSummaryStatus === "drafted") {
          await d.store.updateItem(it.id, { buyerSummaryStatus: "accepted" });
          logs.push(brokerLog(req, dealId, "summary_accepted", { itemId: it.id }));
          n++;
        }
      }
      await logVdrQuietly(d.store, logs);
      res.json({ accepted: n });
    } catch (err) {
      send(res, err, "accept the descriptions");
    }
  });

  // ── Pass 3: Cimple's notes on a document (broker) ──────────────────────────

  app.get(`${BASE}/items/:itemId/notes`, ...guard, async (req, res) => {
    try {
      const d = await deps();
      const deal = res.locals.deal as Deal;
      const item = await dealItem(d, deal.id, req.params.itemId, { allowRemoved: true });
      const [doc, docs, sections, discrepancies, questions, room, rows, team] = await Promise.all([
        item.documentId ? d.store.getDocument(item.documentId) : Promise.resolve(null),
        d.store.listDocuments(deal.id),
        d.cimSectionsForDeal(deal.id).catch(() => [] as CimSection[]),
        d.discrepanciesForDeal(deal.id).catch(() => [] as Discrepancy[]),
        d.questionsForDeal(deal.id).catch(() => [] as BuyerQuestion[]),
        d.store.getRoom(deal.id),
        d.accessRowsForDeal(deal.id),
        d.store.listTeamMembers(deal.id).catch(() => []),
      ]);
      const facts = doc ? documentFacts((deal.extractedInfo ?? {}) as Record<string, unknown>, doc.id) : [];
      const visibleSections = sections.filter((s) => s.isVisible !== false).map((s) => sectionText(s));
      const { links, inCim } = documentCimLinks(facts, visibleSections);
      const keyFigures = facts.slice().sort((a, b) => keyFigureRank(a) - keyFigureRank(b)).slice(0, 12).map((f) => ({ key: f.key, label: f.label, value: f.text.length > 160 ? `${f.text.slice(0, 159)}…` : f.text, inCim: inCim.has(f.key) }));
      let checks: ItemNotesPayload["checks"] = [];
      if (doc) {
        const dd = await ddDocumentChecks(deal.id, doc.id).catch(() => null);
        if (dd) {
          checks = dd.map((c) => {
            const other = c.other ? docs.find((x) => x.id === c.other!.documentId)?.name ?? "another document" : null;
            return c.status === "match"
              ? { tone: "match" as const, text: `${c.label} matches ${other ?? "the other sources"}${c.thisValue ? ` (${c.thisValue})` : ""}.` }
              : { tone: c.explanation ? ("resolved" as const) : ("open" as const), text: `${c.label}: ${c.thisValue} here${c.otherValue ? ` vs ${c.otherValue}${other ? ` in ${other}` : ""}` : ""}.${c.explanation ? ` ${c.explanation}` : " No reason recorded yet."}` };
          });
        } else {
          checks = brokerChecks(doc, facts, discrepancies, docs);
        }
      }
      const labelFor = (q: { buyerAccessId: string | null; vdrTeamMemberId: string | null }) => {
        const link = rows.find((r) => r.id === q.buyerAccessId);
        const buyer = link ? (link.buyerCompany || link.buyerName || link.buyerEmail) : "A buyer";
        const m = q.vdrTeamMemberId ? team.find((t) => t.id === q.vdrTeamMemberId) : null;
        return askerLabel(buyer, m ?? null);
      };
      const left = remainingToday(room ? { summaryBudgetDay: room.summaryBudgetDay ?? null, summaryBudgetUsed: room.summaryBudgetUsed ?? 0 } : null, d.now());
      const note = item.buyerSummaryStatus === "failed"
        ? item.buyerSummarySource === "unavailable"
          ? "Cimple couldn't write a description right now, so the basic line is shown. Write your own or try Draft again later."
          : "Cimple's draft didn't pass its checks, so a basic description is shown. Write your own or draft again."
        : item.buyerSummaryStatus === "pending" && left === 0
          ? "Cimple has written today's descriptions for this deal. Try again tomorrow or write your own."
          : null;
      const out: ItemNotesPayload = {
        keyFigures,
        cimLinks: links.map((l) => ({ sectionId: l.sectionId, title: l.title })),
        ddCitedIn: [],
        checks,
        questions: documentQuestions(questions, item.id, labelFor),
        summary: { remainingToday: left, capped: left === 0, running: item.buyerSummaryStatus === "pending", note },
      };
      res.setHeader("Cache-Control", "no-store");
      res.json(out);
    } catch (err) {
      send(res, err, "load Cimple's notes");
    }
  });

  // ── Pass 3: Activity (by buyer · by document · full log · CSV · trace) ────

  async function activityContext(d: DataRoomRouteDeps, deal: Deal) {
    const ctx = await loadBrokerContext(brokerDeps(d), deal);
    const numbers = indexNumbers(ctx.snap.folders, ctx.snap.items);
    const team = await d.store.listTeamMembers(deal.id).catch(() => []);
    const canSee = new Map<string, Set<string>>();
    const newFor = new Map<string, Set<string>>();
    for (const g of ctx.groups) {
      if (!g.hasRoom || !g.eligible) continue;
      const reader = { dealId: deal.id, accessLevel: parseAccessLevelInput(g.eligible.accessLevel) ?? g.eligible.accessLevel, buyerEmail: g.key, mode: (dataRoomLevelRule(g.eligible.accessLevel) === "auto_on" ? "dd" : "normal") as "dd" | "normal" };
      const decided = decideItems(ctx.snap, reader, d.root(), { privateMatters: ctx.pm });
      const visible = decided.filter((x) => x.visibility.visible);
      canSee.set(g.key, new Set(visible.map((x) => x.item.id)));
      const prev = g.setting?.previousVisitAt ?? null;
      const fresh = new Set<string>();
      for (const x of visible) {
        const grants = x.shares.filter((s) => s.effect === "allow" && ((s.audience === "buyer" && s.buyerEmail === g.key) || (s.audience === "level" && sameAccessLevel(s.accessLevel, reader.accessLevel))));
        if (isNewForBuyer({ grants: grants.map((s) => ({ createdAt: s.createdAt })), previousVisitAt: prev, fileChangedAt: x.item.fileChangedAt ?? null, openedEarlierVersion: false }).isNew) fresh.add(x.item.id);
      }
      newFor.set(g.key, fresh);
    }
    const report: ReportContext = { items: ctx.snap.items, numbers: numbers.items, accessRows: ctx.rows, team, canSee, newFor };
    return { ctx, report, team };
  }

  function logFilter(d: DataRoomRouteDeps, q: Request["query"], ctx: Awaited<ReturnType<typeof loadBrokerContext>>, team: ReadonlyArray<{ id: string }>): LogFilter {
    const f: LogFilter = {};
    if (q.buyer != null) {
      const link = ctx.rows.find((r) => r.id === q.buyer);
      if (!link) throw notFound();
      f.buyer = buyerKey(link.buyerEmail);
    }
    if (q.person != null) {
      if (q.person !== "principal" && !team.some((t) => t.id === q.person)) throw notFound();
      f.person = String(q.person);
    }
    if (q.item != null) {
      if (!ctx.snap.items.some((i) => i.id === q.item)) throw notFound();
      f.item = String(q.item);
    }
    if (typeof q.action === "string" && q.action) f.action = q.action.slice(0, 40);
    const date = (v: unknown, end: boolean) => {
      if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
      return new Date(`${v}T${end ? "23:59:59" : "00:00:00"}Z`);
    };
    f.from = date(q.from, false);
    f.to = date(q.to, true);
    return f;
  }

  app.get(`${BASE}/activity`, ...guard, async (req, res, next) => {
    if (req.query.view == null) return next();
    try {
      const d = await deps();
      const deal = res.locals.deal as Deal;
      const view = req.query.view === "documents" ? "documents" : req.query.view === "log" ? "log" : "buyers";
      const { ctx, report, team } = await activityContext(d, deal);
      const f = logFilter(d, req.query, ctx, team);
      const views = ctx.views;
      let log: ActivityPayload["log"] = [];
      let logTotal = 0;
      if (view === "log") {
        const rows = await d.store.listActivity(deal.id, 5000);
        const all = activityLog(rows, report, f);
        logTotal = all.length;
        log = all.slice(0, 500);
      }
      const traceQ = typeof req.query.trace === "string" ? req.query.trace.slice(0, 20) : "";
      const out: ActivityPayload = {
        view,
        buyers: view === "buyers" ? activityByBuyer(f.buyer ? views.filter((v) => v.buyerEmail === f.buyer) : views, report).filter((b) => !f.buyer || b.key === f.buyer) : [],
        documents: view === "documents" ? activityByDocument(views, report) : [],
        log,
        logTotal,
        trace: traceQ ? { query: traceQ, hits: findTrace(views, traceQ, report) } : null,
        filters: {
          buyers: ctx.groups.filter((g) => g.hasRoom || views.some((v) => v.buyerEmail === g.key)).map((g) => ({ key: (g.eligible ?? g.rows[0]).id, label: labelForKey(g.key, ctx.rows) })),
          people: [{ id: "principal", label: "The buyer themselves" }, ...team.filter((t) => t.status === "active" || t.status === "removed").map((t) => ({ id: t.id, label: `${t.name} (${t.role})` }))],
          items: ctx.snap.items.filter((i) => !i.removedAt).map((i) => ({ id: i.id, label: `${report.numbers.get(i.id) ?? ""} ${i.title}`.trim() })).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true })),
          actions: LOG_ACTION_FILTERS.slice(),
        },
      };
      res.setHeader("Cache-Control", "no-store");
      res.json(out);
    } catch (err) {
      send(res, err, "load the activity");
    }
  });

  app.get(`${BASE}/activity.csv`, ...guard, async (req, res) => {
    try {
      const d = await deps();
      const deal = res.locals.deal as Deal;
      const { ctx, report, team } = await activityContext(d, deal);
      const f = logFilter(d, req.query, ctx, team);
      const rows = activityLog(await d.store.listActivity(deal.id, 20000), report, f);
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="data-room-activity.csv"`);
      res.send(activityCsv(rows, report));
    } catch (err) {
      send(res, err, "export the activity");
    }
  });

  // One document's readers, for the drawer's Activity tab.
  app.get(`${BASE}/activity`, ...guard, async (req, res) => {
    try {
      const d = await deps();
      const deal = res.locals.deal as Deal;
      const item = await dealItem(d, deal.id, req.query.item, { allowRemoved: true });
      const [views, rows] = await Promise.all([d.store.listViews(deal.id), d.accessRowsForDeal(deal.id)]);
      const mine = views.filter((v) => v.itemId === item.id && v.source !== "preview");
      const byBuyer = new Map<string, { opens: number; activeMs: number; pages: Record<string, number>; downloaded: boolean; lastAt: number }>();
      const pages: Record<string, number> = {};
      for (const v of mine) {
        const s = byBuyer.get(v.buyerEmail) ?? { opens: 0, activeMs: 0, pages: {}, downloaded: false, lastAt: 0 };
        s.opens += 1;
        s.activeMs += v.activeMs ?? 0;
        s.downloaded ||= !!v.downloaded;
        s.lastAt = Math.max(s.lastAt, new Date(v.lastSeenAt).getTime());
        for (const [k, ms] of Object.entries((v.pageMs as Record<string, number> | null) ?? {})) {
          if (!/^\d+$/.test(k)) continue;
          s.pages[k] = (s.pages[k] ?? 0) + ms;
          pages[k] = (pages[k] ?? 0) + ms;
        }
        byBuyer.set(v.buyerEmail, s);
      }
      const buyers = Array.from(byBuyer.entries()).map(([key, s]) => {
        const link = rows.find((r) => buyerKey(r.buyerEmail) === key);
        return { key, name: link?.buyerName ?? null, company: link?.buyerCompany ?? null, email: link?.buyerEmail ?? key, opens: s.opens, activeMs: s.activeMs, pagesRead: Object.keys(s.pages).map(Number).sort((a, b) => a - b), downloaded: s.downloaded, lastAt: new Date(s.lastAt).toISOString() };
      }).sort((a, b) => b.activeMs - a.activeMs);
      res.json({ buyers, pages, pageCount: item.prepared?.pages?.length ?? 0 });
    } catch (err) {
      send(res, err, "load the activity");
    }
  });
}
