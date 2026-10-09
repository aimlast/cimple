/**
 * The data room's rules (vdr spec §4) — pure, shared by the client and the
 * server. Every buyer path decides what a reader may see with
 * `itemVisibility`; nothing here touches the database.
 *
 * Levels are read ONLY through the access-level registry
 * (shared/access-levels.ts, INTEGRATION §2.1): teaser links never have a
 * room, Blind CIM links never have one in this version (V4), due-diligence
 * links have it automatically, Full CIM links when the broker turns it on.
 */
import {
  DD_ACCESS_LEVEL,
  NAMED_ACCESS_LEVEL,
  accessLevelLabel,
  cimModeForAccessLevel,
  isTeaserOnly,
  normalizeAccessLevel,
  sameAccessLevel,
} from "./access-levels";

// ── Limits ────────────────────────────────────────────────────────────────

export const VDR_LIMITS = {
  folderDepth: 3,
  folderName: 120,
  title: 200,
  teamPerBuyer: 5,
  requestText: 500,
  requestListLines: 100,
  questionText: 1000,
  uploadBytes: 20 * 1024 * 1024,
  uploadExtensions: [".pdf", ".docx", ".doc", ".xlsx", ".xls", ".csv", ".pptx", ".ppt", ".txt", ".md", ".jpg", ".jpeg", ".png", ".webp"] as readonly string[],
  searchMin: 2,
  searchMax: 100,
  searchHits: 50,
  resolveMax: 50,
  rowsMax: 500,
  pageMsKeys: 2000,
  newVisitGapMs: 30 * 60_000,
  expiryWarnDays: 5,
  summaryDailyCap: 60,
  pageTextMaxChars: 200_000,
  sheetChunkRows: 1000,
  sheetPageRows: 200,
  prerenderPages: 3,
} as const;

// ── Prepared state (stored on vdr_items.prepared) ─────────────────────────

export type VdrPreparedKind = "pdf" | "image" | "sheet" | "ledger" | "ledger_pending" | "html" | "text" | "unsupported";
export type VdrErrorCode = "file_missing" | "too_long" | "too_large" | "unreadable" | "password" | "xfa" | "renderer_unavailable" | "timeout";

export interface VdrPrepared {
  status: "pending" | "ready" | "failed";
  forFile: string;                       // sha256 (hex, 16) of served bytes + kind + gl status (§9.5); stale when it changes
  kind: VdrPreparedKind;
  pages?: Array<{ w: number; h: number; hasText: boolean }>;
  sheets?: Array<{ name: string; rows: number; cols: number; firstRow: number; firstCol: number; hidden?: boolean; truncated?: boolean }>;
  personal?: { count: number; kinds: Array<"sin" | "ssn" | "card" | "account">; pages: number[] };
  officeScan?: { count: number; parts: string[] };      // every zip part scanned (docx/xlsx/pptx), §4.8
  hidden?: { count: number; pages: number[] };          // V19
  forms?: { fields: number; covered: number };
  strippedAnnotations?: number;
  personalRecords?: boolean;
  error?: string;                                       // plain words
  errorCode?: VdrErrorCode;
  attempts?: number;                                    // crashes/timeouts on this forFile (2 → sticky failed)
  startedAt?: string;
  preparedAt?: string;
  /** sha256 (hex, 16) of the served bytes alone — a change is a new version ("Updated"). */
  fileHash?: string;
  /** PDFs: "sanitised" (served.pdf written) or "original" (couldn't be rewritten: no annotations drawn, no original download). */
  servedCopy?: "sanitised" | "original";
}

/** Kinds a reader turns pages in (a question can name a page); sheets, Word and text have no pages. */
export function hasPages(kind: VdrPreparedKind | null | undefined): boolean {
  return kind === "pdf" || kind === "image";
}

/**
 * The page a document question is about: only for a kind with pages, and
 * only a page the document has (else null — a spreadsheet's question is
 * never "about page 1").
 */
export function questionPage(kind: VdrPreparedKind | null | undefined, pageCount: number, page: unknown): number | null {
  if (!hasPages(kind)) return null;
  const n = Number(page);
  if (!Number.isInteger(n) || n < 1) return null;
  return pageCount > 0 && n > pageCount ? null : n;
}

/** A key figure's value as lines: "2023: $297,642 · 2022: $309,386" → one line per year; anything else stays one line. */
export function figureLines(value: string): string[] {
  const parts = value.split(" · ");
  return parts.length > 1 && parts.every((p) => /^(?:19|20)\d{2}: \S/.test(p)) ? parts : [value];
}

/** A stored question's page as shown: dropped for a kind known to have no pages (a sheet's "page 1"). */
export function shownQuestionPage(kind: VdrPreparedKind | null | undefined, page: number | null | undefined): number | null {
  return kind && !hasPages(kind) ? null : page ?? null;
}

/** Plain words for a failed preparation (broker copy, §5.3). */
export function preparedErrorCopy(code: VdrErrorCode | undefined | null): string {
  switch (code) {
    case "password": return "This PDF has a password. Upload a copy without one.";
    case "xfa": return "This is a fillable form Cimple can't show. Print it to PDF and upload that copy.";
    case "too_long": return "Over 500 pages.";
    case "file_missing": return "The file isn't on the server. Upload it again.";
    case "renderer_unavailable": return "Page previews aren't available on the server right now.";
    case "too_large":
    case "unreadable":
    case "timeout":
    default: return "Too large or damaged to preview.";
  }
}

// ── What a file is, for preparing ─────────────────────────────────────────

const EXT_KIND: Record<string, Exclude<VdrPreparedKind, "ledger" | "ledger_pending">> = {
  ".pdf": "pdf",
  ".jpg": "image", ".jpeg": "image", ".png": "image", ".webp": "image",
  ".xlsx": "sheet", ".xls": "sheet", ".csv": "sheet",
  ".docx": "html",
  ".doc": "text", ".pptx": "text", ".ppt": "text", ".txt": "text", ".md": "text",
};

export function extensionOf(name: string | null | undefined): string {
  const m = String(name ?? "").toLowerCase().match(/\.[a-z0-9]{1,8}$/);
  return m ? m[0] : "";
}

/** The viewer kind for a file (by extension first, then mime type). */
export function fileKindFor(file: { name?: string | null; mimeType?: string | null }): Exclude<VdrPreparedKind, "ledger" | "ledger_pending"> {
  const byExt = EXT_KIND[extensionOf(file.name)];
  if (byExt) return byExt;
  const m = String(file.mimeType ?? "").toLowerCase();
  if (m === "application/pdf") return "pdf";
  if (m === "image/png" || m === "image/jpeg" || m === "image/webp") return "image";
  if (m.includes("spreadsheet") || m === "application/vnd.ms-excel" || m === "text/csv") return "sheet";
  if (m.includes("wordprocessingml")) return "html";
  if (m.startsWith("text/") || m.includes("presentation") || m === "application/msword" || m === "application/vnd.ms-powerpoint") return "text";
  return "unsupported";
}

export function isSpreadsheetFile(file: { name?: string | null; mimeType?: string | null }): boolean {
  return fileKindFor(file) === "sheet";
}

export function isImageMime(mime: string | null | undefined): boolean {
  return /^image\/(png|jpe?g|webp|gif|heic|heif|tiff|bmp)$/i.test(String(mime ?? ""));
}

// ── Room material (V1) ────────────────────────────────────────────────────

export type RoomDocLike = {
  visibility: string | null;
  sourceKind: string | null;
  category: string | null;
  subcategory: string | null;
  fileUrl: string | null;
};

const WORKING_CATEGORIES = new Set(["transcripts", "email"]);
const WORKING_SUBCATEGORIES = new Set(["transcript", "call", "email", "crm_note"]);

/**
 * Only real documents can go in the room: source kind "document" (or none,
 * legacy rows), a file, not broker-only — and never an email, call or CRM
 * note, including legacy rows uploaded before Provenance v2.
 */
export function isRoomMaterial(doc: RoomDocLike): boolean {
  if (doc.visibility === "broker_only") return false;
  if (doc.sourceKind && doc.sourceKind !== "document") return false;
  if (!doc.fileUrl) return false;
  if (doc.category && WORKING_CATEGORIES.has(doc.category)) return false;
  if (doc.subcategory && WORKING_SUBCATEGORIES.has(doc.subcategory)) return false;
  return true;
}

/** Why a document can't go in the room (broker copy), or null. */
export function notRoomMaterialReason(doc: RoomDocLike): string | null {
  if (doc.visibility === "broker_only") return "Private files (broker-only) can't be shared.";
  if (isRoomMaterial(doc)) return null;
  return "Emails, call notes and CRM notes are your working material and stay out of the data room. To share an email, save it as a PDF and upload it.";
}

/** vdr's rule for what the DD CIM may cite at all (§11.1). */
export function citableDocument(doc: RoomDocLike): boolean {
  return isRoomMaterial(doc);
}

/** The general-ledger name pattern (auto-file rule 1). */
export const LEDGER_NAME = /general ledger|\bg\/l\b|\bgl (export|detail|report)\b|trial balance|transaction (list|detail)/i;

/**
 * Is it a general ledger? Subcategory general_ledger, or a spreadsheet/CSV
 * whose name says so. Add-back support documents (a T4, an invoice) are not
 * ledgers. (At the gl merge, gl's pure `isGlDocument` is OR-ed in.)
 */
export function isLedgerDoc(doc: { subcategory?: string | null; name?: string | null; originalName?: string | null; mimeType?: string | null; fileUrl?: string | null }): boolean {
  if (doc.subcategory === "general_ledger") return true;
  if (doc.subcategory === "addback_support") return false;
  const file = { name: doc.originalName || doc.name || doc.fileUrl, mimeType: doc.mimeType };
  const fileByUrl = { name: doc.fileUrl, mimeType: doc.mimeType };
  if (!isSpreadsheetFile(file) && !isSpreadsheetFile(fileByUrl)) return false;
  return LEDGER_NAME.test(`${doc.name ?? ""} ${doc.originalName ?? ""}`);
}

// ── Room access for a reader (§4.1) ───────────────────────────────────────

export type RoomAccessSetting = "auto" | "on" | "off";
export type RoomLevelRule = "never_teaser" | "never_blind" | "auto_on" | "manual";

export function dataRoomLevelRule(level: string | null | undefined): RoomLevelRule {
  if (isTeaserOnly(level)) return "never_teaser";               // C3: teaser first
  const mode = cimModeForAccessLevel(level);
  if (mode === "blind") return "never_blind";                     // V4
  return mode === "dd" ? "auto_on" : "manual";
}

/** A level that can have a data room at all (Full CIM, due diligence). */
export function isRoomLevel(level: string | null | undefined): boolean {
  const r = dataRoomLevelRule(level);
  return r === "auto_on" || r === "manual";
}

/** The levels documents can be shared with, in display order (normalised keys). */
export const DATA_ROOM_LEVELS: readonly string[] = [DD_ACCESS_LEVEL, NAMED_ACCESS_LEVEL];

/** "Due diligence buyers" / "Full CIM buyers". */
export function roomLevelAudienceLabel(level: string): string {
  return `${accessLevelLabel(level)} buyers`;
}

export function hasRoomAccess(level: string | null | undefined, setting: RoomAccessSetting | string | null | undefined): boolean {
  const rule = dataRoomLevelRule(level);
  if (rule === "never_teaser" || rule === "never_blind") return false;
  if (setting === "on") return true;
  if (setting === "off") return false;
  return rule === "auto_on";
}

/** Buyer identity for per-buyer rows (V17): the email, trimmed and lower-cased. */
export const buyerKey = (email: string | null | undefined) => String(email ?? "").trim().toLowerCase();

export type AccessRowLike = {
  id: string;
  dealId: string;
  buyerEmail: string;
  accessLevel: string | null;
  ndaSigned: boolean | null;
  revokedAt: Date | string | null;
  expiresAt: Date | string | null;
  createdAt?: Date | string | null;
};

export function linkLive(row: Pick<AccessRowLike, "revokedAt" | "expiresAt">, now: Date = new Date()): boolean {
  if (row.revokedAt) return false;
  if (row.expiresAt && new Date(row.expiresAt).getTime() <= now.getTime()) return false;
  return true;
}

/**
 * The buyer's best live link for the room (a team member's reader): not
 * revoked or expired, NDA signed, room access — due diligence before Full CIM,
 * then the newest. Null if none.
 */
export function principalLinkFor<T extends AccessRowLike>(
  rows: ReadonlyArray<T>,
  key: string,
  setting: RoomAccessSetting | string | null | undefined,
  now: Date = new Date(),
): T | null {
  const ok = rows.filter((r) => buyerKey(r.buyerEmail) === key && linkLive(r, now) && !!r.ndaSigned && hasRoomAccess(r.accessLevel, setting));
  if (ok.length === 0) return null;
  const score = (r: T) => (dataRoomLevelRule(r.accessLevel) === "auto_on" ? 2 : 1);
  return ok.slice().sort((a, b) => score(b) - score(a) || new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime())[0];
}

// ── The visibility function (§4.2) ────────────────────────────────────────

export type VdrHidden =
  | "link" | "nda" | "room_none" | "room_closed" | "no_room_access" | "team_ended"   // whole-room reasons
  | "removed" | "private" | "not_room_material" | "file_missing"                    // item reasons
  | "not_shared" | "excluded" | "dd_only" | "ledger_pending" | "not_ready"
  /** Shared, but a needs-a-look flag (§4.9) isn't ticked for the current file: held back until the broker checks it (fail-closed). */
  | "held_for_check";

export type ShareLike = { audience: "level" | "buyer" | string; accessLevel: string | null; buyerEmail: string | null; effect: "allow" | "deny" | string };

export type VisibilityInput = {
  dealId: string;
  reader: { dealId: string; accessLevel: string; buyerEmail: string; mode: "normal" | "dd" | "blind" };
  item: { dealId: string; removedAt: Date | string | null; prepared: VdrPrepared | null; isLedger: boolean };
  doc: (RoomDocLike & { dealId: string }) | null;
  servedFileExists: boolean;
  shares: ReadonlyArray<ShareLike>;
  /** Needs-a-look flags not ticked for the current file (uncheckedLookFlags). Any → held back. */
  uncheckedFlags?: number;
};

export type Visibility = { visible: true } | { visible: false; reason: VdrHidden };

export function itemVisibility(i: VisibilityInput): Visibility {
  const hide = (reason: VdrHidden): Visibility => ({ visible: false, reason });
  if (i.item.dealId !== i.dealId || i.reader.dealId !== i.dealId) return hide("removed");
  if (i.item.removedAt) return hide("removed");
  if (!i.doc || i.doc.dealId !== i.dealId) return hide("removed");
  if (i.doc.visibility === "broker_only") return hide("private");
  if (!isRoomMaterial(i.doc)) return hide("not_room_material");
  if (!i.servedFileExists) return hide("file_missing");
  const key = buyerKey(i.reader.buyerEmail);
  const forBuyer = i.shares.filter((s) => s.audience === "buyer" && buyerKey(s.buyerEmail) === key);
  if (forBuyer.some((s) => s.effect === "deny")) return hide("excluded");
  const allowed =
    forBuyer.some((s) => s.effect === "allow") ||
    i.shares.some((s) => s.audience === "level" && s.effect !== "deny" && !!s.accessLevel && sameAccessLevel(s.accessLevel, i.reader.accessLevel));
  if (!allowed) return hide("not_shared");
  if (i.item.isLedger && i.reader.mode !== "dd") return hide("dd_only");
  if (i.item.prepared?.kind === "ledger_pending") return hide("ledger_pending");
  if (!i.item.prepared || i.item.prepared.status !== "ready") return hide("not_ready");
  // A document shared before Cimple finished checking it (the plan, a folder
  // share) and found to need a look is never served until the broker ticks it.
  if ((i.uncheckedFlags ?? 0) > 0) return hide("held_for_check");
  return { visible: true };
}

/** Listed to the reader (the list shows "Getting it ready…" for not_ready); everything else is absent. */
export function listedForReader(v: Visibility): boolean {
  return v.visible || v.reason === "not_ready";
}

// ── Downloads (§4.3) ──────────────────────────────────────────────────────

export type VdrDownloadAs = "pages_pdf" | "values_xlsx" | "original_sanitised_pdf" | "original_stamped_office" | "ledger_original";
export type DownloadDecision =
  | { allowed: true; as: VdrDownloadAs }
  | { allowed: false; why: "not_allowed" | "personal_numbers" | "not_ready" | "ledger" | "unsupported" };

export function downloadDecision(i: {
  item: { downloadable: boolean; downloadOriginal: boolean };
  prepared: VdrPrepared | null;
  buyer: { allowDownloads: boolean };
  ledger?: { allowOriginalDownload: boolean } | null;
}): DownloadDecision {
  const p = i.prepared;
  if (!p || p.status !== "ready" || p.kind === "ledger_pending") return { allowed: false, why: p?.kind === "ledger_pending" ? "ledger" : "not_ready" };
  const both = i.item.downloadable && i.buyer.allowDownloads;
  if (p.kind === "ledger") {
    return both && i.ledger?.allowOriginalDownload ? { allowed: true, as: "ledger_original" } : { allowed: false, why: "ledger" };
  }
  if (p.kind === "unsupported") return { allowed: false, why: "unsupported" };
  if (!both) return { allowed: false, why: "not_allowed" };
  const covered = (p.personal?.count ?? 0) + (p.officeScan?.count ?? 0);
  switch (p.kind) {
    case "image":
      return { allowed: true, as: "pages_pdf" };
    case "pdf":
      if (!i.item.downloadOriginal || p.servedCopy === "original") return { allowed: true, as: "pages_pdf" };
      return (p.personal?.count ?? 0) > 0 ? { allowed: false, why: "personal_numbers" } : { allowed: true, as: "original_sanitised_pdf" };
    case "sheet":
      if (!i.item.downloadOriginal || !p.officeScan) return { allowed: true, as: "values_xlsx" };
      return covered > 0 ? { allowed: false, why: "personal_numbers" } : { allowed: true, as: "original_stamped_office" };
    case "html":
    case "text":
      if (!i.item.downloadOriginal) return { allowed: false, why: "not_allowed" };
      return covered > 0 ? { allowed: false, why: "personal_numbers" } : { allowed: true, as: "original_stamped_office" };
    default:
      return { allowed: false, why: "unsupported" };
  }
}

/** The buyer's download button label, or the reason there's none. */
export function downloadCopy(d: DownloadDecision): string {
  if (d.allowed) {
    switch (d.as) {
      case "pages_pdf": return "Download (pages as PDF)";
      case "values_xlsx": return "Download (values only)";
      default: return "Download original";
    }
  }
  switch (d.why) {
    case "personal_numbers": return "This file can't be downloaded because it contains personal information.";
    case "ledger": return "The general ledger can't be downloaded. Your broker can share specific entries.";
    default: return "View only. Ask your broker if you need a copy.";
  }
}

// ── Flags (§4.9) ──────────────────────────────────────────────────────────

export type VdrFlagKey =
  | "scanned" | "staff_records" | "hidden_words" | "private_matters" | "file_missing"   // needs a look
  | "personal_covered" | "form_fields" | "comments_removed" | "private_notes";          // notes
export type VdrFlag = { key: VdrFlagKey; look: boolean; copy: string; pages?: number[] };

/** "page 2" · "pages 3–5" · "pages 1, 3 and 7". */
export function pageListCopy(pages: ReadonlyArray<number>): string {
  const ps = Array.from(new Set(pages)).sort((a, b) => a - b);
  if (ps.length === 0) return "";
  if (ps.length === 1) return `page ${ps[0]}`;
  const consecutive = ps.every((p, i) => i === 0 || p === ps[i - 1] + 1);
  if (consecutive) return `pages ${ps[0]}–${ps[ps.length - 1]}`;
  return `pages ${ps.slice(0, -1).join(", ")} and ${ps[ps.length - 1]}`;
}

const KIND_WORDS: Record<string, [string, string]> = {
  sin: ["social insurance number", "social insurance numbers"],
  ssn: ["social security number", "social security numbers"],
  card: ["card number", "card numbers"],
  account: ["account number", "account numbers"],
};

/** "3 social insurance numbers on page 2" (or "4 personal numbers on pages 1–3" for a mix). */
export function personalCopy(p: NonNullable<VdrPrepared["personal"]>): string {
  const kinds = Array.from(new Set(p.kinds));
  const words = kinds.length === 1 ? KIND_WORDS[kinds[0]] : ["personal number", "personal numbers"];
  const noun = p.count === 1 ? words[0] : words[1];
  const where = p.pages.length > 0 ? ` on ${pageListCopy(p.pages)}` : "";
  return `${p.count} ${noun}${where}`;
}

export function itemFlags(
  prepared: VdrPrepared | null,
  doc: { extractedData?: unknown } | null,
  info: { privateMatters?: ReadonlyArray<string>; fileMissing?: boolean; isLedger?: boolean } = {},
): VdrFlag[] {
  const out: VdrFlag[] = [];
  if (info.fileMissing || prepared?.errorCode === "file_missing") {
    out.push({ key: "file_missing", look: true, copy: "The file isn't on the server. Upload it again." });
  }
  const p = prepared?.status === "ready" ? prepared : null;
  if (p && (p.kind === "pdf" || p.kind === "image") && p.pages) {
    const scanned = p.pages.map((pg, i) => (pg.hasText ? 0 : i + 1)).filter((n) => n > 0);
    if (scanned.length > 0) {
      const where = pageListCopy(scanned);
      out.push({
        key: "scanned",
        look: true,
        pages: scanned,
        copy: `Cimple couldn't read text on ${where}, so it couldn't check ${scanned.length === 1 ? "it" : "them"} for personal numbers.`,
      });
    }
  }
  if (p?.personalRecords || info.isLedger) {
    out.push({ key: "staff_records", look: true, copy: "Staff or pay records. Buyers usually see these late in due diligence, often with names removed." });
  }
  if (p?.hidden && p.hidden.count > 0) {
    out.push({
      key: "hidden_words",
      look: true,
      pages: p.hidden.pages,
      copy: `Words are hidden on ${pageListCopy(p.hidden.pages)}, under black boxes or printed so they can't be seen. Black boxes drawn in a PDF editor don't remove the words underneath. Buyers see the page as it looks and the hidden words are left out of search, but use your PDF tool's Redact feature or upload a cleaned copy if you meant to remove them.`,
    });
  }
  const matters = (info.privateMatters ?? []).filter((s) => typeof s === "string" && s.trim());
  if (matters.length > 0) {
    out.push({
      key: "private_matters",
      look: true,
      copy: `Cimple kept something from this document out of the CIM: '${matters[0]}'. Check the document before sharing it.`,
    });
  }
  if (p?.personal && p.personal.count > 0) {
    out.push({ key: "personal_covered", look: false, pages: p.personal.pages, copy: `${personalCopy(p.personal)} ${p.personal.count === 1 ? "is" : "are"} covered on every page buyers see.` });
  }
  if (p?.forms && p.forms.fields > 0) {
    out.push({ key: "form_fields", look: false, copy: "A fillable form. Buyers see the filled-in values; any personal numbers in them are covered." });
  }
  if (p?.strippedAnnotations && p.strippedAnnotations > 0) {
    out.push({ key: "comments_removed", look: false, copy: "Comments and stamps added in a PDF editor are removed for buyers." });
  }
  const ed = (doc?.extractedData ?? null) as Record<string, unknown> | null;
  const hasNotes = !!ed && ((typeof ed._privateNotes === "string" && ed._privateNotes.trim() !== "") || (Array.isArray(ed._privateNotes) && ed._privateNotes.length > 0) || (Array.isArray(ed.redFlags) && ed.redFlags.length > 0));
  if (hasNotes) out.push({ key: "private_notes", look: false, copy: "Notes only you see." });
  return out;
}

/** Needs-a-look flags the broker hasn't ticked for the CURRENT served file. */
export function uncheckedLookFlags(
  flags: ReadonlyArray<VdrFlag>,
  item: { checkedFlags?: ReadonlyArray<string> | null; checkedForFile?: string | null },
  prepared: VdrPrepared | null,
): VdrFlagKey[] {
  const ticked = item.checkedForFile && prepared && item.checkedForFile === prepared.forFile ? new Set(item.checkedFlags ?? []) : new Set<string>();
  return flags.filter((f) => f.look && !ticked.has(f.key)).map((f) => f.key);
}

// ── Preset folders (§4.6) ─────────────────────────────────────────────────

export type PresetKey =
  | "financial" | "financial.statements" | "financial.tax" | "financial.bank" | "financial.gl" | "financial.revenue" | "financial.debt"
  | "legal" | "legal.corporate" | "legal.property" | "legal.contracts" | "legal.insurance"
  | "operations" | "operations.assets" | "operations.reports"
  | "people" | "people.staff" | "people.agreements"
  | "compliance" | "marketing" | "other";

export type PresetFolder = { key: PresetKey; parent: PresetKey | null; name: string; recommended: "dd" | "not_yet" | null };

/** The standard business-broker index. Names carry no numbers (numbers are computed). */
export const VDR_PRESET_FOLDERS: readonly PresetFolder[] = [
  { key: "financial", parent: null, name: "Financial", recommended: null },
  { key: "financial.statements", parent: "financial", name: "Financial statements", recommended: "dd" },
  { key: "financial.tax", parent: "financial", name: "Tax returns", recommended: "dd" },
  { key: "financial.bank", parent: "financial", name: "Bank statements", recommended: "not_yet" },
  { key: "financial.gl", parent: "financial", name: "General ledger & add-back support", recommended: "not_yet" },
  { key: "financial.revenue", parent: "financial", name: "Revenue & customers", recommended: "dd" },
  { key: "financial.debt", parent: "financial", name: "Receivables, payables & debt", recommended: "dd" },
  { key: "legal", parent: null, name: "Legal & corporate", recommended: null },
  { key: "legal.corporate", parent: "legal", name: "Corporate records", recommended: "dd" },
  { key: "legal.property", parent: "legal", name: "Leases & property", recommended: "dd" },
  { key: "legal.contracts", parent: "legal", name: "Contracts", recommended: "dd" },
  { key: "legal.insurance", parent: "legal", name: "Insurance", recommended: "dd" },
  { key: "operations", parent: null, name: "Operations", recommended: null },
  { key: "operations.assets", parent: "operations", name: "Equipment & assets", recommended: "dd" },
  { key: "operations.reports", parent: "operations", name: "Operating reports", recommended: "dd" },
  { key: "people", parent: null, name: "People", recommended: "not_yet" },
  { key: "people.staff", parent: "people", name: "Staff & organisation", recommended: "not_yet" },
  { key: "people.agreements", parent: "people", name: "Employment agreements", recommended: "not_yet" },
  { key: "compliance", parent: null, name: "Licences, permits & compliance", recommended: "dd" },
  { key: "marketing", parent: null, name: "Sales & marketing", recommended: "dd" },
  { key: "other", parent: null, name: "Other documents", recommended: "not_yet" },
];

export function presetFolder(key: string | null | undefined): PresetFolder | null {
  return VDR_PRESET_FOLDERS.find((f) => f.key === key) ?? null;
}

// ── Index numbering (§4.5) ────────────────────────────────────────────────

export type FolderLike = { id: string; parentId: string | null; position: number; name: string; createdAt?: Date | string | null };
export type ItemLike = { id: string; folderId: string; position: number; title: string; removedAt?: Date | string | null; addedAt?: Date | string | null; createdAt?: Date | string | null };

const byPosition = <T extends { position: number; id: string; createdAt?: Date | string | null }>(a: T, b: T) =>
  a.position - b.position || new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime() || a.id.localeCompare(b.id);

/** Depth of a folder (top level = 1). Infinity on a cycle. */
export function folderDepth(folders: ReadonlyArray<FolderLike>, id: string): number {
  const byId = new Map(folders.map((f) => [f.id, f]));
  let d = 0;
  const seen = new Set<string>();
  let cur: FolderLike | undefined = byId.get(id);
  while (cur) {
    if (seen.has(cur.id)) return Infinity;
    seen.add(cur.id);
    d += 1;
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return d;
}

/**
 * The room's numbers: folders by position, numbering sub-folders first and
 * then documents, continuously ("1.2" a folder, "1.2.3" its third entry).
 * Everyone sees these numbers; live items only (tombstones get none).
 */
export function indexNumbers(folders: ReadonlyArray<FolderLike>, items: ReadonlyArray<ItemLike>): { folders: Map<string, string>; items: Map<string, string> } {
  const fNum = new Map<string, string>();
  const iNum = new Map<string, string>();
  const ids = new Set(folders.map((f) => f.id));
  const children = new Map<string | null, FolderLike[]>();
  for (const f of folders) {
    const parent = f.parentId && ids.has(f.parentId) ? f.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), f]);
  }
  const live = items.filter((i) => !i.removedAt);
  const itemsIn = new Map<string, ItemLike[]>();
  for (const it of live) itemsIn.set(it.folderId, [...(itemsIn.get(it.folderId) ?? []), it]);
  const walk = (parent: string | null, prefix: string, depth: number) => {
    if (depth > 10) return;
    const subs = (children.get(parent) ?? []).slice().sort(byPosition);
    let n = 0;
    for (const f of subs) {
      n += 1;
      const num = prefix ? `${prefix}.${n}` : String(n);
      fNum.set(f.id, num);
      walk(f.id, num, depth + 1);
    }
    if (parent) {
      const docs = (itemsIn.get(parent) ?? []).slice().sort((a, b) => a.position - b.position || new Date(a.addedAt ?? a.createdAt ?? 0).getTime() - new Date(b.addedAt ?? b.createdAt ?? 0).getTime() || a.id.localeCompare(b.id));
      for (const it of docs) {
        n += 1;
        iNum.set(it.id, `${prefix}.${n}`);
      }
    }
  };
  walk(null, "", 0);
  return { folders: fNum, items: iNum };
}

/**
 * The tree a reader sees: only the items they can open and the folders that
 * contain them (ancestors included). Numbers are NOT recomputed, so a buyer
 * may see 1.2.1 and 1.2.3; a hidden 1.2.2 is never named.
 */
export function visibleTree<F extends FolderLike, I extends ItemLike>(folders: ReadonlyArray<F>, items: ReadonlyArray<I>, visibleItemIds: ReadonlySet<string>): { folders: F[]; items: I[] } {
  const keepItems = items.filter((i) => !i.removedAt && visibleItemIds.has(i.id));
  const byId = new Map(folders.map((f) => [f.id, f]));
  const keep = new Set<string>();
  for (const it of keepItems) {
    let cur = byId.get(it.folderId);
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      keep.add(cur.id);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
  }
  return { folders: folders.filter((f) => keep.has(f.id)), items: keepItems };
}

// ── New since your last visit (§4.4) ──────────────────────────────────────

export function isNewForBuyer(i: {
  grants: ReadonlyArray<{ createdAt: Date | string }>;
  previousVisitAt: Date | string | null;
  fileChangedAt: Date | string | null;
  openedEarlierVersion: boolean;
}): { isNew: boolean; isUpdated: boolean } {
  if (!i.previousVisitAt) return { isNew: false, isUpdated: false };
  const prev = new Date(i.previousVisitAt).getTime();
  const isNew = i.grants.some((g) => new Date(g.createdAt).getTime() > prev);
  const isUpdated = !isNew && !!i.fileChangedAt && new Date(i.fileChangedAt).getTime() > prev && i.openedEarlierVersion;
  return { isNew, isUpdated };
}

/** Visit stamps roll when the last visit was more than 30 minutes ago. */
export function rollVisitStamps(s: { lastVisitAt: Date | null; previousVisitAt: Date | null }, now: Date): { lastVisitAt: Date; previousVisitAt: Date | null; rolled: boolean } {
  if (!s.lastVisitAt || now.getTime() - s.lastVisitAt.getTime() > VDR_LIMITS.newVisitGapMs) {
    return { lastVisitAt: now, previousVisitAt: s.lastVisitAt ?? null, rolled: true };
  }
  return { lastVisitAt: now, previousVisitAt: s.previousVisitAt, rolled: false };
}

// ── Citations (§11.1) ─────────────────────────────────────────────────────

/** A closed vocabulary, so a chip can name a source without a document title. */
export type VdrDocKind =
  | "financial_statements" | "tax_return" | "general_ledger" | "bank_statement" | "revenue_report"
  | "ar_ap_report" | "lease" | "contract" | "corporate_record" | "payroll_report" | "invoice"
  | "licence" | "insurance" | "asset_list" | "operating_report" | "other";

export const VDR_DOC_KINDS: readonly VdrDocKind[] = [
  "financial_statements", "tax_return", "general_ledger", "bank_statement", "revenue_report",
  "ar_ap_report", "lease", "contract", "corporate_record", "payroll_report", "invoice",
  "licence", "insurance", "asset_list", "operating_report", "other",
];

export interface VdrDocRef {
  documentId: string;            // documents.id; must pass citableDocument
  kind: VdrDocKind;              // for the neutral label when the document isn't visible
  period?: string | null;        // "2023" | "FY2023" | "2024-06" — validated; anything else is dropped
  page?: number | null;          // 1-based PDF page when known
  needle?: string | null;        // ≤ 80 chars: the figure/phrase to locate when page is unknown
  sheet?: string | null;         // spreadsheet sheet name (shown only when the document is visible)
  rows?: number[] | null;        // 1-based Excel row numbers (§9.10) (≤ 500)
  sumColumn?: number | null;     // absolute 0-based Excel column (A = 0)
}

const KIND_LABEL: Record<VdrDocKind, string> = {
  financial_statements: "Financial statements",
  tax_return: "Tax return",
  general_ledger: "General ledger",
  bank_statement: "Bank statement",
  revenue_report: "Revenue report",
  ar_ap_report: "Receivables and payables report",
  lease: "Lease",
  contract: "Contract",
  corporate_record: "Corporate record",
  payroll_report: "Payroll report",
  invoice: "Invoice",
  licence: "Licence",
  insurance: "Insurance document",
  asset_list: "Asset list",
  operating_report: "Operating report",
  other: "A supporting document",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A validated period, or null ("2023", "FY2023", "2024-06"). */
export function cleanPeriod(p: unknown): string | null {
  return typeof p === "string" && /^(FY)?\d{4}(-\d{2})?$/.test(p.trim()) ? p.trim() : null;
}

/** The chip text when the document isn't visible: "Tax return 2023", else "A supporting document". Never a title. */
export function citationLabel(ref: Pick<VdrDocRef, "kind" | "period">): string {
  const kind = (VDR_DOC_KINDS as readonly string[]).includes(ref.kind) ? ref.kind : "other";
  if (kind === "other") return KIND_LABEL.other;
  const period = cleanPeriod(ref.period);
  if (!period) return KIND_LABEL[kind];
  const m = period.match(/^(FY)?(\d{4})-(\d{2})$/);
  const shown = m && Number(m[3]) >= 1 && Number(m[3]) <= 12 ? `${MONTHS[Number(m[3]) - 1]} ${m[2]}` : period;
  return `${KIND_LABEL[kind]} ${shown}`;
}

// ── Links ─────────────────────────────────────────────────────────────────

/** The buyer's data-room URL (optionally opening a document at a place). */
export function vdrBuyerHref(i: { token: string; itemId?: string | null; documentId?: string | null; page?: number | null; rows?: ReadonlyArray<number> | null; sheet?: string | null; fy?: string | null; folderId?: string | null }): string {
  const q = new URLSearchParams();
  if (i.folderId) q.set("folder", i.folderId);
  if (i.itemId) q.set("doc", i.itemId);
  else if (i.documentId) q.set("document", i.documentId);
  if (i.page && i.page > 0) q.set("page", String(Math.floor(i.page)));
  if (i.sheet) q.set("sheet", i.sheet);
  if (i.rows && i.rows.length) q.set("rows", i.rows.slice(0, VDR_LIMITS.rowsMax).filter((n) => Number.isInteger(n) && n > 0).join(","));
  if (i.fy) q.set("fy", i.fy);
  const qs = q.toString();
  return `/view/${encodeURIComponent(i.token)}/data-room${qs ? `?${qs}` : ""}`;
}

/** The broker's Data room tab URL. */
export function vdrBrokerHref(dealId: string, i: { view?: "documents" | "buyers" | "todo" | "activity"; itemId?: string | null; folderId?: string | null; buyer?: string | null } = {}): string {
  const q = new URLSearchParams();
  if (i.view && i.view !== "documents") q.set("view", i.view);
  if (i.folderId) q.set("folder", i.folderId);
  if (i.itemId) q.set("item", i.itemId);
  if (i.buyer) q.set("buyer", i.buyer);
  const qs = q.toString();
  return `/deal/${encodeURIComponent(dealId)}/data-room${qs ? `?${qs}` : ""}`;
}

// ── Activity vocabulary ───────────────────────────────────────────────────

export const VDR_ACTIONS = [
  "room_set_up", "plan_applied", "room_opened", "room_closed", "settings_changed",
  "folder_created", "folder_renamed", "folder_moved", "folder_deleted",
  "item_added", "item_moved", "item_renamed", "item_removed", "item_restored", "item_tombstoned",
  "seller_removed_shared", "new_version", "clean_copy_added", "clean_copy_removed",
  "shared", "unshared", "downloads_changed", "original_offered", "checked_by_broker",
  "summary_drafted", "summary_accepted", "summary_edited",
  "buyer_room_changed", "buyer_downloads_changed",
  "request_resolved", "request_ready", "seller_emailed", "told_buyer", "buyers_emailed",
  "team_requested", "team_added", "team_link_sent", "team_removed", "team_acknowledged",
  "buyer_opened_room", "buyer_opened_item", "buyer_downloaded", "buyer_searched", "buyer_requested",
  "buyer_asked", "buyer_denied", "index_downloaded",
  // Pass 3: the broker set a "Waiting on you" item aside ("Not now" / "Dismiss").
  "todo_dismissed",
] as const;
export type VdrAction = (typeof VDR_ACTIONS)[number];

/** A normalised level key for storage (C2: never a legacy value). */
export function storedLevelKey(level: string): string {
  return normalizeAccessLevel(level);
}

// ── Sharing, eligibility and plain labels (pass 2: the broker's tab, the buyer's room) ──

/** What a document's grants come to, for the broker's sharing chip (§5.3). */
export type ShareSummary = {
  shared: boolean;
  levels: string[];          // normalised data-room levels with a grant, in display order
  buyers: number;            // specific buyers allowed
  hiddenFrom: number;        // specific buyers denied
  label: string;             // "Not shared" · "Due diligence buyers" · "Due diligence + 2 buyers" · "3 buyers" · "Every buyer with the room"
};

export function shareSummary(shares: ReadonlyArray<ShareLike>): ShareSummary {
  const levels = DATA_ROOM_LEVELS.filter((l) => shares.some((s) => s.audience === "level" && s.effect !== "deny" && !!s.accessLevel && sameAccessLevel(s.accessLevel, l)));
  const buyers = new Set(shares.filter((s) => s.audience === "buyer" && s.effect === "allow").map((s) => buyerKey(s.buyerEmail))).size;
  const hiddenFrom = new Set(shares.filter((s) => s.audience === "buyer" && s.effect === "deny").map((s) => buyerKey(s.buyerEmail))).size;
  let label: string;
  if (levels.length === DATA_ROOM_LEVELS.length) label = "Every buyer with the room";
  else if (levels.length === 1) {
    const base = accessLevelLabel(levels[0]);
    label = buyers > 0 ? `${base} + ${buyers} ${buyers === 1 ? "buyer" : "buyers"}` : `${base} buyers`;
  } else if (buyers > 0) label = `${buyers} ${buyers === 1 ? "buyer" : "buyers"}`;
  else label = "Not shared";
  if (hiddenFrom > 0 && label !== "Not shared") label += ` (hidden from ${hiddenFrom})`;
  return { shared: levels.length > 0 || buyers > 0, levels, buyers, hiddenFrom, label };
}

export type BuyerIneligibleReason = "teaser" | "blind" | "nda" | "revoked" | "expired";

/** Why a buyer's link can't have documents (§5.7 "Not eligible yet"), or null when it can. */
export function roomIneligibleReason(row: Pick<AccessRowLike, "accessLevel" | "ndaSigned" | "revokedAt" | "expiresAt">, now: Date = new Date()): BuyerIneligibleReason | null {
  if (row.revokedAt) return "revoked";
  if (row.expiresAt && new Date(row.expiresAt).getTime() <= now.getTime()) return "expired";
  const rule = dataRoomLevelRule(row.accessLevel);
  if (rule === "never_teaser") return "teaser";
  if (rule === "never_blind") return "blind";
  if (!row.ndaSigned) return "nda";
  return null;
}

export function ineligibleCopy(reason: BuyerIneligibleReason): string {
  switch (reason) {
    case "teaser": return "Teaser: no data room before the NDA"; // access-level-literal-ok: a BuyerIneligibleReason key, not a stored level
    case "blind": return "Blind CIM: documents name the business.";
    case "nda": return "Hasn't signed the NDA";
    case "revoked": return "Link revoked";
    default: return "Link expired";
  }
}

/** The download chip on a broker row. */
export function downloadChipLabel(item: { downloadable: boolean; downloadOriginal: boolean }): string {
  if (!item.downloadable) return "View only";
  return item.downloadOriginal ? "Download · original" : "Download";
}

const DOC_TYPE_WORDS: Array<[RegExp, string]> = [
  [/\bt2\b|corporat\w* income tax/i, "T2 corporate income tax return"],
  [/\bt1\b/i, "T1 personal income tax return"],
  [/notice of assessment/i, "Notice of assessment"],
  [/tax return|\b1120s?\b|\b1065\b/i, "Tax return"],
  [/financial statement|compil|review engagement|audited/i, "Financial statements"],
  [/income statement|profit (and|&) loss|\bp&l\b/i, "Income statement"],
  [/balance sheet/i, "Balance sheet"],
  [/general ledger/i, "General ledger"],
  [/lease/i, "Lease"],
  [/minute book/i, "Minute book"],
];

/** "PDF · 6 pages" · "Spreadsheet · 3 sheets" · "Word" · "Photo" · "General ledger". */
export function fileSizeLabel(prepared: Pick<VdrPrepared, "kind" | "pages" | "sheets" | "status"> | null, fallbackKind?: VdrPreparedKind | null): string {
  const kind = prepared?.kind ?? fallbackKind ?? "unsupported";
  const pages = prepared?.status === "ready" ? prepared.pages?.length ?? 0 : 0;
  const sheets = prepared?.status === "ready" ? prepared.sheets?.length ?? 0 : 0;
  switch (kind) {
    case "pdf": return pages ? `PDF · ${pages} ${pages === 1 ? "page" : "pages"}` : "PDF";
    case "image": return "Photo";
    case "sheet": return sheets ? `Spreadsheet · ${sheets} ${sheets === 1 ? "sheet" : "sheets"}` : "Spreadsheet";
    case "html": return "Word";
    case "text": return "Text";
    case "ledger":
    case "ledger_pending": return "General ledger";
    default: return "File";
  }
}

/** A document's period end as words ("Dec 31, 2023"), from the extraction or the source's details. */
export function periodEndLabel(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const m = raw.trim().match(/^(\d{4})-(\d{2})(?:-(\d{2}))?/);
  if (!m) return raw.trim().slice(0, 40);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return raw.trim().slice(0, 40);
  return m[3] ? `${MONTHS[month - 1]} ${Number(m[3])}, ${m[1]}` : `${MONTHS[month - 1]} ${m[1]}`;
}

/** A document's type in plain words, from the extraction (`_documentType`) or its name. */
export function documentTypeLabel(doc: { name?: string | null; extractedData?: unknown } | null): string | null {
  const ed = (doc?.extractedData ?? null) as Record<string, unknown> | null;
  let t = typeof ed?._documentType === "string" ? ed._documentType.replace(/\s*\([^)]*\)?\s*$/g, "").replace(/\s+/g, " ").trim() : "";
  if (t.length > 60) t = t.slice(0, 60).replace(/[\s,;:&-]+\S*$/, "");
  if (t) return t.charAt(0).toUpperCase() + t.slice(1);
  const name = String(doc?.name ?? "");
  for (const [re, words] of DOC_TYPE_WORDS) if (re.test(name)) return words;
  return null;
}

/**
 * The basic line buyers read about a document until the broker accepts a
 * description (V12): "{Document type} for the period ending {date}, {pages} pages."
 * Built only from the document's type, period and page count — no figures.
 */
export function basicDescription(
  doc: { name?: string | null; extractedData?: unknown; sourceMeta?: unknown } | null,
  prepared: Pick<VdrPrepared, "kind" | "pages" | "sheets" | "status"> | null,
): string {
  const ed = (doc?.extractedData ?? null) as Record<string, unknown> | null;
  const meta = (doc?.sourceMeta ?? null) as Record<string, unknown> | null;
  const type = documentTypeLabel(doc) ?? (prepared?.kind === "sheet" ? "Spreadsheet" : prepared?.kind === "image" ? "Photo" : "Document");
  const period = periodEndLabel(ed?._periodEnd ?? meta?.periodEnd);
  const pages = prepared?.status === "ready" ? prepared.pages?.length ?? 0 : 0;
  const sheets = prepared?.status === "ready" ? prepared.sheets?.length ?? 0 : 0;
  const size = pages > 1 ? `, ${pages} pages` : sheets > 1 ? `, ${sheets} sheets` : "";
  return `${type}${period ? ` for the period ending ${period}` : ""}${size}.`;
}

/** The description a buyer reads: the broker-accepted one, else the basic line (V12). */
export function buyerDescriptionFor(
  item: { buyerSummary: string | null; buyerSummaryPoints: unknown; buyerSummaryStatus: string | null; buyerSummaryHidden: boolean },
  basic: string,
): { text: string; points: string[]; accepted: boolean } {
  if (!item.buyerSummaryHidden && item.buyerSummaryStatus === "accepted" && item.buyerSummary && item.buyerSummary.trim()) {
    const points = Array.isArray(item.buyerSummaryPoints) ? (item.buyerSummaryPoints as unknown[]).filter((p): p is string => typeof p === "string" && !!p.trim()).slice(0, 4) : [];
    return { text: item.buyerSummary.trim(), points, accepted: true };
  }
  return { text: basic, points: [], accepted: false };
}

/** The watermark line burned into every page a reader sees (§9.7). */
export function watermarkLine(i: { name?: string | null; email: string; at: Date; trace: string; principalCompany?: string | null }): string {
  const iso = i.at.toISOString();
  const when = `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
  const who = (i.name && i.name.trim()) || i.email;
  return [who, i.email, ...(i.principalCompany ? [`for ${i.principalCompany}`] : []), when, i.trace].join(" · ");
}

/** "Oct 9, 2026, 18:53 UTC" — the watermark's time, always UTC and named (the trace line's basis). */
export function watermarkWhen(at: Date): string {
  const hh = String(at.getUTCHours()).padStart(2, "0");
  const mm = String(at.getUTCMinutes()).padStart(2, "0");
  return `${MONTHS[at.getUTCMonth()]} ${at.getUTCDate()}, ${at.getUTCFullYear()}, ${hh}:${mm} UTC`;
}

/**
 * The footer band on every page a reader sees: who is viewing and when
 * (the view's start, in UTC like the trace line — never "shared on", which
 * it isn't), and the firm that shared it (checker r2 R2-6).
 */
export function watermarkFooter(i: { email: string; at: Date; firm?: string | null }): string {
  return `Confidential · viewed by ${i.email} on ${watermarkWhen(i.at)}${i.firm ? ` · shared by ${i.firm}` : ""}`;
}

/** A device class from a viewport width (the view's `deviceClass`). */
export function deviceClassFor(width: number | null | undefined): "desktop" | "tablet" | "phone" {
  const w = Number(width) || 0;
  return w > 0 && w < 600 ? "phone" : w > 0 && w < 1024 ? "tablet" : "desktop";
}

export const VDR_VIEW_SOURCES = ["room", "search", "new", "cim", "question", "preview", "demo"] as const;
export type VdrViewSource = (typeof VDR_VIEW_SOURCES)[number];
