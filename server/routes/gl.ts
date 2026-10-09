/**
 * Routes of "Add-backs in the books" (gl spec §6.7) — pass 1: the ledger
 * files themselves. Uploading (broker and seller), reading as a ledger,
 * setting columns, reading again, the broker's ledger viewer.
 *
 * Every GL upload passes `glUploadGate` BEFORE multer writes a byte: the
 * caller's right (broker session that owns the deal, or the owner's /
 * accountant's seller link — never a broker previewing the seller's page),
 * the declared size, and at most 3 GL uploads in flight per server. The
 * per-IP limit (20 GL uploads an hour) is in server/index.ts.
 */
import type { Express, NextFunction, Request, Response } from "express";
import multer from "multer";
import rateLimit from "express-rate-limit";
import { createHash } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { storage } from "../storage";
import { requireBroker, requireOwnedDeal, isDealOwnerSession } from "../broker-auth/routes";
import { newDocumentFileName, resolveDocumentPath } from "../documents/document-path";
import { sellerLinkRights, OWNER_OR_ACCOUNTANT_MESSAGE } from "@shared/seller-link-rights";
import type { Document, GlLedger } from "@shared/schema";
import type { GlLayout, GlLedgerView, GlRole, GlYearSummary } from "@shared/gl-types";
import { glStore } from "../gl/store";
import { ledgerAudience } from "../gl/audience";
import { GL_CSV_MAX_BYTES, GL_XLSX_MAX_BYTES, dealFiscalYearEnd, readAsLedger, readAsNormalDocument, requestedYearsFor, rereadWithLayout, startLedgerRead } from "../gl/ingest";
import { ledgerFileKind, peekRows } from "../gl/read-file";
import { withHeavySheetSlot } from "../documents/heavy-sheet";
import { detectLayout } from "../gl/detect";
import { parseLedgerRows } from "../gl/parse";
import { cellText } from "../gl/text";
import { restampSourceVisibility } from "../documents/source-visibility";
import { ensureGlRequirement } from "../documents/requirements";
// Pass 2: the add-backs (installs the ledger reader's follow-up — tie-out and proposals — on import).
import { refreshGl } from "../gl/service";
import { loadGlContext } from "../gl/context";
import { buildBrokerView } from "../gl/broker-view";
import { registerGlBrokerRoutes } from "../gl/routes-broker";
import { registerGlSellerRoutes, sellerBooksPayload, SUPPORT_MAX_BYTES } from "../gl/routes-seller";
import { registerGlBuyerRoutes } from "../gl/routes-buyer";
// The assistant's two jobs install themselves on load: the column mapper (ledger reader) and the ranker (proposal run).
import "../gl/map-columns-ai";
import "../gl/rank-ai";

const uploadsDir = () => process.env.UPLOADS_DIR || path.join(process.cwd(), "public", "uploads");

// ── The pre-multer gate ──────────────────────────────────────────────────

export const GL_UPLOAD_HEADROOM = 64 * 1024;
export const GL_MAX_IN_FLIGHT = 3;
let inFlight = 0;

/** GL uploads being received right now (tests). */
export function glUploadsInFlight(): number {
  return inFlight;
}

export const UPLOAD_MESSAGES = {
  tooBig: "Ledger files can be up to 60 MB as CSV or 15 MB as Excel.",
  busy: "Cimple is busy reading other files — try again in a minute.",
  preview: "You're previewing the seller's page — nothing is saved.",
  noFile: "Choose an Excel (.xlsx, .xls) or CSV file.",
  wrongType: "Ledgers can be uploaded as Excel (.xlsx, .xls) or CSV files. Export the 'General Ledger' report as Excel or CSV.",
} as const;

/** Who is uploading, once the gate let them through (res.locals.glUpload). */
export interface GlUploadCaller {
  dealId: string;
  by: "broker" | "seller";
  memberId: string | null;
}

export interface GlGateDeps {
  getSellerInviteByToken(token: string): Promise<{ id: string; dealId: string; sellerEmail?: string | null } | undefined>;
  getDealMembers(dealId: string): Promise<Array<{ id: string; email?: string | null; teamType?: string | null; role?: string | null; permissions?: unknown; inviteStatus?: string | null }>>;
  isDealOwnerSession(req: Request, dealId: string): Promise<boolean>;
}

const gateDeps: GlGateDeps = {
  getSellerInviteByToken: (t) => storage.getSellerInviteByToken(t) as any,
  getDealMembers: (id) => storage.getDealMembers(id) as any,
  isDealOwnerSession,
};

/**
 * The checks every GL upload passes before multer writes anything (D10,
 * E11). Broker routes run requireBroker + requireOwnedDeal before this.
 * `maxBytes` is the largest file the route accepts.
 */
export function glUploadGate(side: "broker" | "seller", maxBytes: number, deps: GlGateDeps = gateDeps) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      let caller: GlUploadCaller;
      if (side === "seller") {
        const invite = await deps.getSellerInviteByToken(String(req.params.token ?? ""));
        if (!invite) return res.status(404).json({ error: "This link isn't valid any more." });
        const rights = sellerLinkRights(invite, await deps.getDealMembers(invite.dealId));
        if (!rights.canTraceAddbacks) return res.status(403).json({ error: OWNER_OR_ACCOUNTANT_MESSAGE });
        if (await deps.isDealOwnerSession(req, invite.dealId)) return res.status(409).json({ error: UPLOAD_MESSAGES.preview });
        caller = { dealId: invite.dealId, by: "seller", memberId: rights.memberId };
      } else {
        caller = { dealId: String(req.params.dealId), by: "broker", memberId: null };
      }
      const declared = Number(req.headers["content-length"] ?? 0);
      if (!Number.isFinite(declared) || declared > maxBytes + GL_UPLOAD_HEADROOM) {
        return res.status(413).json({ error: UPLOAD_MESSAGES.tooBig });
      }
      if (inFlight >= GL_MAX_IN_FLIGHT) return res.status(503).json({ error: UPLOAD_MESSAGES.busy });
      inFlight++;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        inFlight--;
      };
      res.on("finish", release);
      res.on("close", release);
      res.locals.glUpload = caller;
      next();
    } catch (err) {
      console.error("[gl] upload gate failed:", err);
      res.status(500).json({ error: "Upload failed" });
    }
  };
}

const LEDGER_EXT = [".csv", ".tsv", ".txt", ".xlsx", ".xls"];

function ledgerMulter(maxBytes: number) {
  return multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => {
        const dir = path.join(uploadsDir(), "docs");
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (_req, file, cb) => cb(null, newDocumentFileName("doc", path.extname(file.originalname))),
    }),
    limits: { fileSize: maxBytes, files: 1 },
    fileFilter: (req, file, cb) => {
      const ok = LEDGER_EXT.includes(path.extname(file.originalname).toLowerCase());
      if (!ok) (req as any).glRejected = true;
      cb(null, ok);
    },
  }).single("file");
}

/** multer with its errors as plain JSON (size → 413). */
function receiveLedgerFile(maxBytes: number) {
  const mw = ledgerMulter(maxBytes);
  return (req: Request, res: Response, next: NextFunction) =>
    mw(req, res, (err: unknown) => {
      if (err) {
        const code = (err as { code?: string }).code;
        if (code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: UPLOAD_MESSAGES.tooBig });
        return res.status(400).json({ error: UPLOAD_MESSAGES.noFile });
      }
      next();
    });
}

const decodeName = (raw: string): string => {
  try {
    const decoded = Buffer.from(raw, "latin1").toString("utf8");
    return decoded.includes("�") ? raw : decoded;
  } catch {
    return raw;
  }
};

/** After multer: the file's own size rule (Excel ≤ 15 MB), then the document row and the read. */
async function createLedgerFromUpload(req: Request, res: Response): Promise<void> {
  const caller = res.locals.glUpload as GlUploadCaller;
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: (req as any).glRejected ? UPLOAD_MESSAGES.wrongType : UPLOAD_MESSAGES.noFile });
    return;
  }
  const kind = ledgerFileKind(file.originalname);
  if (!kind || (kind === "xlsx" && file.size > GL_XLSX_MAX_BYTES) || (kind === "csv" && file.size > GL_CSV_MAX_BYTES)) {
    fs.unlink(file.path, () => {});
    res.status(kind ? 413 : 400).json({ error: kind ? UPLOAD_MESSAGES.tooBig : UPLOAD_MESSAGES.wrongType });
    return;
  }
  const role = req.body?.role === "adjustments" ? "adjustments" : "ledger";
  // A broker may keep a ledger private (D25); a seller's upload is always shared with the broker and the seller.
  const visibility = caller.by === "broker" && req.body?.visibility === "broker_only" ? "broker_only" : "shared";
  const name = decodeName(file.originalname).slice(0, 200);
  const doc = await storage.createDocument({
    dealId: caller.dealId,
    uploadedBy: caller.by,
    name,
    originalName: name,
    category: "financials",
    subcategory: "general_ledger",
    fileUrl: `/uploads/docs/${file.filename}`,
    fileSize: file.size ?? null,
    mimeType: file.mimetype || null,
    status: "pending",
    sourceKind: "document",
    sourceMeta: null,
    visibility,
  } as any);
  const ledger = await startLedgerRead(doc, { uploadedBy: caller.by, role });
  res.json({ ledger: ledgerView(ledger, doc) });
}

// ── Views ────────────────────────────────────────────────────────────────

export function ledgerView(l: GlLedger, doc: Pick<Document, "name" | "originalName" | "visibility" | "sourceKind">): GlLedgerView {
  return {
    id: l.id,
    documentId: l.documentId,
    fileName: doc.originalName || doc.name,
    role: (l.role as GlLedgerView["role"]) ?? "ledger",
    status: l.status as GlLedgerView["status"],
    software: (l.software as GlLedgerView["software"]) ?? null,
    basis: (l.basis as GlLedgerView["basis"]) ?? null,
    periodStart: l.periodStart,
    periodEnd: l.periodEnd,
    years: (l.years as Record<string, GlYearSummary> | null) ?? {},
    rowCount: l.rowCount,
    accountCount: l.accountCount,
    duplicateCount: l.duplicateCount,
    skippedCount: l.skippedCount,
    progress: (l.progress as GlLedgerView["progress"]) ?? null,
    problems: (l.problems as GlLedgerView["problems"]) ?? [],
    failure: l.failure,
    uploadedBy: l.uploadedBy === "seller" ? "seller" : "broker",
    audience: ledgerAudience(doc, l),
    layoutBy: (l.layoutBy as GlLedgerView["layoutBy"]) ?? null,
    showStaffNames: l.showStaffNames,
    allowOriginalDownload: l.allowOriginalDownload,
    createdAt: new Date(l.createdAt).toISOString(),
  };
}

/** What the seller sees about their ledgers: their own audience only, no layout, no internals. */
export function sellerLedgerView(v: GlLedgerView) {
  return {
    id: v.id,
    fileName: v.fileName,
    role: v.role,
    status: v.status,
    periodStart: v.periodStart,
    periodEnd: v.periodEnd,
    rowCount: v.rowCount,
    years: Object.keys(v.years).sort(),
    progress: v.progress ? { rowsRead: v.progress.rowsRead } : null,
    problems: v.problems.map((p) => ({ kind: p.kind, message: p.message, years: p.years ?? [], count: p.count ?? null })),
    failure: v.failure,
  };
}

async function brokerLedgerViews(dealId: string): Promise<{ ledgers: GlLedgerView[]; unread: Array<{ documentId: string; name: string; reason: "not_read" | "pdf" }> }> {
  const [ledgers, docs] = await Promise.all([glStore().listLedgers(dealId), storage.getDocumentsByDeal(dealId)]);
  const byId = new Map(docs.map((d) => [d.id, d]));
  const withLedger = new Set(ledgers.map((l) => l.documentId));
  const views = ledgers.filter((l) => byId.has(l.documentId)).map((l) => ledgerView(l, byId.get(l.documentId)!));
  const unread = docs
    .filter((d) => d.subcategory === "general_ledger" && !withLedger.has(d.id))
    .map((d) => ({ documentId: d.id, name: d.originalName || d.name, reason: (ledgerFileKind(d.fileUrl) ? "not_read" : "pdf") as "not_read" | "pdf" }));
  return { ledgers: views, unread };
}

async function ownedLedger(req: Request, res: Response): Promise<{ ledger: GlLedger; doc: Document } | null> {
  const ledger = await glStore().getLedger(String(req.params.ledgerId));
  if (!ledger || ledger.dealId !== req.params.dealId) {
    res.status(404).json({ error: "Ledger not found" });
    return null;
  }
  const doc = await storage.getDocument(ledger.documentId);
  if (!doc || doc.dealId !== req.params.dealId) {
    res.status(404).json({ error: "Ledger not found" });
    return null;
  }
  return { ledger, doc };
}

// ── Layout input (the broker's column dialog) ────────────────────────────

const ROLES: GlRole[] = ["date", "account", "account_number", "account_type", "name", "memo", "type", "number", "debit", "credit", "amount", "balance", "ignore"];

/** A broker's column choices → a layout, or a plain error. */
export function layoutFromBody(body: unknown): { layout: GlLayout } | { error: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const headerRow = Number(b.headerRow);
  if (!Number.isInteger(headerRow) || headerRow < -1 || headerRow > 200) return { error: "Pick the row with the column headings." };
  const cols = Array.isArray(b.columns) ? b.columns : [];
  if (cols.length === 0 || cols.length > 80) return { error: "Pick which column holds what." };
  const columns: GlLayout["columns"] = [];
  const seen = new Set<number>();
  for (const c of cols) {
    const index = Number((c as any)?.index);
    const role = String((c as any)?.role ?? "") as GlRole;
    if (!Number.isInteger(index) || index < 0 || index > 200 || seen.has(index) || !ROLES.includes(role)) return { error: "Pick which column holds what." };
    seen.add(index);
    columns.push({ index, role, header: String((c as any)?.header ?? "").slice(0, 120) });
  }
  const count = (r: GlRole) => columns.filter((c) => c.role === r).length;
  if (count("date") !== 1) return { error: "Pick the one column that has the date." };
  if (count("amount") === 0 && count("debit") === 0 && count("credit") === 0) return { error: "Pick the amount column, or the money in / money out columns." };
  const accountMode = b.accountMode === "heading_rows" || b.accountMode === "column_fill_down" || b.accountMode === "column" ? b.accountMode : count("account") ? "column" : "heading_rows";
  if (accountMode !== "heading_rows" && count("account") === 0) return { error: "Pick the account column, or say the account names are headings above each group." };
  const dateOrder = b.dateOrder === "dmy" || b.dateOrder === "ymd" || b.dateOrder === "mdy" ? b.dateOrder : "mdy";
  const amountMode = count("debit") || count("credit") ? "debit_credit" : "single";
  return { layout: { headerRow, columns, accountMode, dateOrder, amountMode, sheet: typeof b.sheet === "string" ? b.sheet.slice(0, 120) : null } };
}

// ── Rate limits (registered from server/index.ts, before the routes) ─────

/** Only a POST to the mount itself (the upload), never the GETs under it. */
const uploadOnly = (limiter: ReturnType<typeof rateLimit>) => (req: Request, res: Response, next: NextFunction) =>
  req.method === "POST" && (req.path === "/" || req.path === "") ? limiter(req, res, next) : next();
const sellerKey = (req: Request) => `gl:${createHash("sha256").update(String(req.params.token ?? "")).digest("hex").slice(0, 32)}`;

export const GL_UPLOADS_PER_IP_PER_HOUR = 20;

export function applyGlRateLimits(app: Express, aiLimiter?: import("express").RequestHandler): void {
  // "Look again" may ask Cimple's assistant: the AI endpoints' per-IP ceiling (its daily budget caps the cost).
  if (aiLimiter) app.use("/api/deals/:dealId/gl/traces/:traceId/look-again", aiLimiter);
  // A buyer's private question about a ledger entry (P2): 20 an hour per link.
  app.use("/api/view/:token/gl/question", rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: sellerKey,
    message: { error: "Too many questions — please try again later." },
  }));
  const perIp = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: GL_UPLOADS_PER_IP_PER_HOUR,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many uploads. Please try again in a while." },
  });
  app.use("/api/deals/:dealId/gl/ledgers", uploadOnly(perIp));
  app.use("/api/seller/:token/gl/ledgers", uploadOnly(perIp));
  app.use("/api/seller/:token/gl", rateLimit({
    windowMs: 60 * 1000,
    limit: (req) => (req.method === "GET" ? 120 : 240),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: sellerKey,
    message: { error: "Too many requests" },
  }));
  app.use("/api/seller/:token/gl/search", rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `${sellerKey(req)}:search`,
    message: { error: "Too many searches — wait a moment and try again." },
  }));
  app.use("/api/seller/:token/gl/traces/:traceId/support-docs", (req, res, next) => (req.method === "POST" ? perIp(req, res, next) : next()));
  app.use("/api/seller/:token/gl/ledgers", uploadOnly(rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: sellerKey,
    message: { error: "Too many uploads. Please try again in a while." },
  })));
}

// ── Registration ─────────────────────────────────────────────────────────

export function registerGlRoutes(app: Express): void {
  // ── Broker ──
  app.get("/api/deals/:dealId/gl", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const dealId = String(req.params.dealId);
      // A deal from before the ledger row existed gets it on the seller's checklist now (idempotent).
      void ensureGlRequirement(dealId);
      const fye = await dealFiscalYearEnd(dealId);
      const [{ ledgers, unread }, requestedYears] = await Promise.all([brokerLedgerViews(dealId), requestedYearsFor(dealId, fye)]);
      // The add-backs (synced with the analysis first — skipped when nothing changed). A failure here
      // never hides the ledgers: the panel says the add-backs couldn't load.
      let view: Awaited<ReturnType<typeof buildBrokerView>> | null = null;
      try {
        await refreshGl(dealId);
        view = await buildBrokerView(await loadGlContext(dealId));
      } catch (err) {
        console.error("[gl] add-backs view failed:", err);
      }
      res.json({
        fiscalYearEnd: fye,
        requestedYears,
        ledgers,
        unread,
        ...(view ?? { tracesError: true }),
      });
    } catch (err) {
      console.error("[gl] GET failed:", err);
      res.status(500).json({ error: "Couldn't load the ledgers" });
    }
  });

  app.post(
    "/api/deals/:dealId/gl/ledgers",
    requireBroker,
    requireOwnedDeal,
    glUploadGate("broker", GL_CSV_MAX_BYTES),
    receiveLedgerFile(GL_CSV_MAX_BYTES),
    async (req, res) => {
      try {
        await createLedgerFromUpload(req, res);
      } catch (err) {
        console.error("[gl] broker upload failed:", err);
        if (req.file?.path) fs.unlink(req.file.path, () => {});
        if (!res.headersSent) res.status(500).json({ error: "Upload failed" });
      }
    },
  );

  app.post("/api/deals/:dealId/gl/ledgers/read-as-ledger", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const documentId = typeof req.body?.documentId === "string" ? req.body.documentId : "";
      const doc = documentId ? await storage.getDocument(documentId) : undefined;
      if (!doc || doc.dealId !== req.params.dealId) return res.status(404).json({ error: "Document not found" });
      if (!ledgerFileKind(doc.fileUrl)) return res.status(400).json({ error: UPLOAD_MESSAGES.wrongType });
      const ledger = await readAsLedger(doc.id);
      if (!ledger) return res.status(400).json({ error: UPLOAD_MESSAGES.wrongType });
      res.json({ ledger: ledgerView(ledger, doc) });
    } catch (err) {
      console.error("[gl] read-as-ledger failed:", err);
      res.status(500).json({ error: "Couldn't start reading the ledger" });
    }
  });

  app.post("/api/deals/:dealId/gl/ledgers/:ledgerId/not-ledger", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const found = await ownedLedger(req, res);
      if (!found) return;
      await readAsNormalDocument(found.doc.id);
      res.json({ ok: true });
    } catch (err) {
      console.error("[gl] not-ledger failed:", err);
      res.status(500).json({ error: "Couldn't read it as a normal document" });
    }
  });

  app.get("/api/deals/:dealId/gl/ledgers/:ledgerId/sample", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const found = await ownedLedger(req, res);
      if (!found) return;
      const filePath = resolveDocumentPath(found.doc);
      const kind = ledgerFileKind(found.doc.fileUrl);
      if (!filePath || !kind || !fs.existsSync(filePath)) return res.status(404).json({ error: "The file isn't on the server any more — upload it again." });
      const rows = kind === "xlsx" ? await withHeavySheetSlot(() => peekRows(filePath, kind, 60, found.doc.fileUrl)) : await peekRows(filePath, kind, 60, found.doc.fileUrl);
      const det = detectLayout(rows);
      const firstSheet = rows[0]?.sheet ?? null;
      const sample = rows.filter((r) => r.sheet === firstSheet).slice(0, 40).map((r) => ({ rowNo: r.rowNo, cells: r.cells.map((c) => cellText(c, 40)) }));
      res.json({ sheet: firstSheet, rows: sample, guess: det?.layout ?? (found.ledger.layout as GlLayout | null) ?? null });
    } catch (err) {
      console.error("[gl] sample failed:", err);
      res.status(500).json({ error: "Couldn't open the file" });
    }
  });

  app.post("/api/deals/:dealId/gl/ledgers/:ledgerId/columns", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const found = await ownedLedger(req, res);
      if (!found) return;
      const parsed = layoutFromBody(req.body);
      if ("error" in parsed) return res.status(400).json({ error: parsed.error });
      // Preview only: the first entries these columns give (the dialog's live preview).
      if (req.query.preview === "1") {
        const filePath = resolveDocumentPath(found.doc);
        const kind = ledgerFileKind(found.doc.fileUrl);
        if (!filePath || !kind) return res.status(404).json({ error: "The file isn't on the server any more — upload it again." });
        const rows = kind === "xlsx" ? await withHeavySheetSlot(() => peekRows(filePath, kind, 260, found.doc.fileUrl)) : await peekRows(filePath, kind, 260, found.doc.fileUrl);
        const { entries } = parseLedgerRows(rows, parsed.layout);
        return res.json({ entries: entries.slice(0, 5).map((e) => ({ date: e.txnDate, account: e.account, name: e.name, memo: e.memo, amountCents: e.amountCents })), count: entries.length });
      }
      await rereadWithLayout(found.ledger, parsed.layout, "broker");
      res.json({ ok: true });
    } catch (err) {
      console.error("[gl] columns failed:", err);
      res.status(500).json({ error: "Couldn't read the ledger with these columns" });
    }
  });

  app.post("/api/deals/:dealId/gl/ledgers/:ledgerId/reread", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const found = await ownedLedger(req, res);
      if (!found) return;
      const keep = found.ledger.layoutBy === "broker" || found.ledger.layoutBy === "ai";
      await rereadWithLayout(found.ledger, keep ? (found.ledger.layout as GlLayout) : null, (found.ledger.layoutBy as "broker" | "ai") ?? "broker");
      res.json({ ok: true });
    } catch (err) {
      console.error("[gl] reread failed:", err);
      res.status(500).json({ error: "Couldn't read the ledger again" });
    }
  });

  app.patch("/api/deals/:dealId/gl/ledgers/:ledgerId", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const found = await ownedLedger(req, res);
      if (!found) return;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const owned = ["dealId", "documentId", "status", "rowCount", "layout", "years", "problems", "uploadedBy", "sharedWithSellerByBroker"];
      const bad = owned.find((k) => k in body);
      if (bad) return res.status(400).json({ error: `"${bad}" can't be set here` });
      const patch: Partial<GlLedger> = {};
      if (typeof body.showStaffNames === "boolean") patch.showStaffNames = body.showStaffNames;
      if (typeof body.allowOriginalDownload === "boolean") patch.allowOriginalDownload = body.allowOriginalDownload;
      if (body.role === "ledger" || body.role === "adjustments") patch.role = body.role;
      if (body.sharedWithSeller === true && ledgerAudience(found.doc, found.ledger) === "broker") {
        // "Share it with the seller" (D25): the document becomes shared — the seller will see every entry.
        patch.sharedWithSellerByBroker = true;
        if (found.doc.visibility === "broker_only") {
          await storage.updateDocument(found.doc.id, { visibility: "shared" } as any);
          await restampSourceVisibility(found.doc.dealId, found.doc.id, false);
        }
      }
      if (Object.keys(patch).length === 0 && body.sharedWithSeller !== true) return res.status(400).json({ error: "Nothing to change" });
      const updated = Object.keys(patch).length ? await glStore().updateLedger(found.ledger.id, patch) : found.ledger;
      if (patch.sharedWithSellerByBroker || patch.role) {
        const { syncGlRequirement } = await import("../gl/requirement");
        await syncGlRequirement(found.ledger.dealId);
      }
      const doc = (await storage.getDocument(found.doc.id)) ?? found.doc;
      res.json({ ledger: ledgerView(updated ?? found.ledger, doc) });
    } catch (err) {
      console.error("[gl] ledger PATCH failed:", err);
      res.status(500).json({ error: "Couldn't change the ledger" });
    }
  });

  app.get("/api/deals/:dealId/gl/ledgers/:ledgerId/rows", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const found = await ownedLedger(req, res);
      if (!found) return;
      const q = (k: string) => (typeof req.query[k] === "string" ? String(req.query[k]) : "");
      const fy = /^\d{4}$/.test(q("fy")) ? q("fy") : null;
      const accountKey = q("account").slice(0, 300) || null;
      const search = q("q").slice(0, 100);
      const page = Math.max(0, Math.min(100_000, Number(q("page")) || 0));
      const around = Number(q("around")) || null;
      const store = glStore();
      const [rows, accounts] = await Promise.all([
        store.ledgerRows({ ledgerId: found.ledger.id, fy, accountKey, q: search, page, around }),
        store.accountTotals(found.ledger.id, fy),
      ]);
      res.json({
        ledger: ledgerView(found.ledger, found.doc),
        years: Object.keys((found.ledger.years as Record<string, GlYearSummary> | null) ?? {}).sort(),
        accounts,
        page: rows.page,
        pageSize: rows.pageSize,
        total: rows.total,
        rows: rows.rows.map((t) => ({
          rowNo: t.rowNo,
          sheet: t.sheet,
          date: t.txnDate,
          fiscalYear: t.fiscalYear,
          account: t.account,
          accountKey: t.accountKey,
          accountNumber: t.accountNumber,
          name: t.name,
          memo: t.memo,
          type: t.txnType,
          number: t.txnNumber,
          amountCents: t.amountCents,
          duplicate: t.duplicate,
          hint: t.sensitiveHint,
        })),
      });
    } catch (err) {
      console.error("[gl] rows failed:", err);
      res.status(500).json({ error: "Couldn't load the entries" });
    }
  });

  // ── Pass 2: the add-backs (broker and seller) ──
  registerGlBrokerRoutes(app);
  registerGlSellerRoutes(app, { supportGate: glUploadGate("seller", SUPPORT_MAX_BYTES) });
  // ── Pass 3: buyers ("Ask about this entry"; the ledger rows are served by the data room through viewer.ts) ──
  registerGlBuyerRoutes(app);

  // ── Seller (token in the path) ──
  app.get("/api/seller/:token/gl", async (req, res) => {
    try {
      const invite = await storage.getSellerInviteByToken(String(req.params.token));
      if (!invite) return res.status(404).json({ error: "This link isn't valid any more." });
      const rights = sellerLinkRights(invite, await storage.getDealMembers(invite.dealId));
      if (!rights.canTraceAddbacks) return res.status(403).json({ error: OWNER_OR_ACCOUNTANT_MESSAGE, code: "not_owner_or_accountant" });
      void ensureGlRequirement(invite.dealId);
      const fye = await dealFiscalYearEnd(invite.dealId);
      const { ledgers } = await brokerLedgerViews(invite.dealId);
      // Only ledgers the seller may see — a ledger private to the broker is never listed.
      const mine = ledgers.filter((l) => l.audience === "shared").map(sellerLedgerView);
      const deal = await storage.getDeal(invite.dealId);
      const preview = await isDealOwnerSession(req, invite.dealId);
      const base = { fiscalYearEnd: fye, requestedYears: await requestedYearsFor(invite.dealId, fye), preview, ledgers: mine, businessName: deal?.businessName ?? null };
      if (!deal) return res.json({ state: "not_requested", ...base });
      // The costs (gl spec §9.1 — a whitelist). Synced with the analysis first (fingerprint-skipped).
      await refreshGl(invite.dealId).catch((err) => console.warn("[gl] seller sync failed:", err));
      const view = await sellerBooksPayload({ invite, deal, members: await storage.getDealMembers(invite.dealId), role: rights.role, memberId: rights.memberId, preview });
      res.json({ ...view, ...base, state: view.state });
    } catch (err) {
      console.error("[gl] seller GET failed:", err);
      res.status(500).json({ error: "Couldn't load your books" });
    }
  });

  app.post(
    "/api/seller/:token/gl/ledgers",
    glUploadGate("seller", GL_CSV_MAX_BYTES),
    receiveLedgerFile(GL_CSV_MAX_BYTES),
    async (req, res) => {
      try {
        await createLedgerFromUpload(req, res);
      } catch (err) {
        console.error("[gl] seller upload failed:", err);
        if (req.file?.path) fs.unlink(req.file.path, () => {});
        if (!res.headersSent) res.status(500).json({ error: "Upload failed" });
      }
    },
  );
}
