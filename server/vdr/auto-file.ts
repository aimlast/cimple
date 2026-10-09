/**
 * Auto-filing and the recommended sharing plan (vdr spec §4.6, §4.7). Pure:
 * no database, no AI — a fixed business-broker index plus a deterministic
 * classifier over the document's name, original name, extracted document
 * type and subcategory. Checked against every room document of the nine
 * fictional demo deals: 72 of 72 land in a sensible folder by a rule.
 */
import {
  DATA_ROOM_LEVELS,
  LEDGER_NAME,
  VDR_PRESET_FOLDERS,
  isLedgerDoc,
  presetFolder,
  storedLevelKey,
  type PresetKey,
  type VdrDocKind,
  type VdrFlag,
} from "@shared/vdr";
import { DD_ACCESS_LEVEL } from "@shared/access-levels";

export type AutoFileDoc = {
  name?: string | null;
  originalName?: string | null;
  subcategory?: string | null;
  category?: string | null;
  mimeType?: string | null;
  fileUrl?: string | null;
  extractedData?: unknown;
};

function haystack(doc: AutoFileDoc): string {
  const ed = (doc.extractedData ?? null) as Record<string, unknown> | null;
  const dtype = ed && typeof ed._documentType === "string" ? ed._documentType : "";
  return `${doc.name ?? ""} ${doc.originalName ?? ""} ${dtype} ${doc.subcategory ?? ""}`.toLowerCase();
}

const RULES: Array<[PresetKey, (h: string, sub: string) => boolean]> = [
  ["financial.gl", (h, sub) => /^(general_ledger|quickbooks_export|pnl_detail|addback_support)$/.test(sub) || LEDGER_NAME.test(h)],
  ["financial.tax", (h) => /\bt2\b|\bt1\b|\bt4|tax return|notice of assessment|\bhst\b|\bgst\b|\b1120s?\b|\b1065\b|schedule c\b/.test(h)],
  ["financial.bank", (h) => /bank statement|bank rec/.test(h)],
  ["financial.revenue", (h) => /revenue by|customer|sales by|by client|payer mix|volumes|backlog|\bwip\b|work in progress|pipeline|\bmrr\b|recurring revenue/.test(h)],
  ["financial.statements", (h) => /financial statement|compil|review engagement|audited|income statement|balance sheet|\bp&l\b|profit (and|&) loss|\bpnl\b|year[- ]end statement/.test(h)],
  ["people.agreements", (h) => /employment agreement|offer letter|non-?compete|contractor agreement/.test(h)],
  ["people.staff", (h) => /staff|employee|roster|payroll|org(ani[sz]ational)? chart|headcount/.test(h)],
  ["compliance", (h) => /licen[cs]e|permit|registration|accreditation|certification|\biso \d{4,5}|inspection|compliance|regulatory|safety|cvsa|tssa|\bocp\b/.test(h)],
  ["financial.debt", (h) => /\bar aging|receivable|payable|debt|loan|credit facility|line of credit|equipment lease|financing/.test(h)],
  ["legal.property", (h) => /lease|premises|property|deed|landlord/.test(h)],
  ["legal.corporate", (h) => /minute book|articles of|incorporation|share register|shareholder|by-?law|corporate record/.test(h)],
  ["legal.insurance", (h) => /insurance|policy schedule|certificate of insurance/.test(h)],
  ["legal.contracts", (h) => /contract|agreement|supplier|vendor|\bmsa\b/.test(h)],
  ["operations.assets", (h) => /fleet|equipment|asset (list|register)|inventory|vehicle/.test(h)],
  ["marketing", (h) => /marketing|brochure|price list|catalog/.test(h)],
];

function categoryFallback(category: string | null | undefined): PresetKey {
  const c = String(category ?? "").toLowerCase();
  if (c === "financials" || c === "financial") return "financial";
  if (c === "legal") return "legal";
  if (c === "operations" || c === "operational") return "operations.reports";
  if (c === "marketing") return "marketing";
  return "other";
}

/** The preset folder a document belongs in (the first rule that matches wins). */
export function presetFor(doc: AutoFileDoc): { key: PresetKey; byRule: boolean } {
  const h = haystack(doc);
  const sub = String(doc.subcategory ?? "").toLowerCase();
  for (const [key, test] of RULES) if (test(h, sub)) return { key, byRule: true };
  return { key: categoryFallback(doc.category), byRule: false };
}

/** The closed citation vocabulary for a document (dd's chip kinds come from here). */
export function docKindFor(doc: AutoFileDoc): VdrDocKind {
  const key = presetFor(doc).key;
  const h = haystack(doc);
  switch (key) {
    case "financial.statements": return "financial_statements";
    case "financial.tax": return "tax_return";
    case "financial.bank": return "bank_statement";
    case "financial.gl":
      if (isLedgerDoc({ ...doc, name: doc.name ?? null })) return "general_ledger";
      if (/invoice|receipt|bill\b/.test(h)) return "invoice";
      if (/payroll|t4|salary|wage|paystub|pay stub/.test(h)) return "payroll_report";
      return "other";
    case "financial.revenue": return "revenue_report";
    case "financial.debt": return /lease/.test(h) ? "lease" : "ar_ap_report";
    case "legal.corporate": return "corporate_record";
    case "legal.property": return "lease";
    case "legal.contracts": return "contract";
    case "legal.insurance": return "insurance";
    case "operations.assets": return "asset_list";
    case "operations.reports":
    case "operations": return "operating_report";
    case "people.staff": return /payroll|t4|salary|wage/.test(h) ? "payroll_report" : "other";
    case "people.agreements": return "contract";
    case "compliance": return /insurance/.test(h) && !/licen[cs]e|permit|registration/.test(h) ? "insurance" : "licence";
    default: return "other";
  }
}

// ── Placing documents ─────────────────────────────────────────────────────

export type FolderRow = { id: string; presetKey: string | null; parentId: string | null };

/** Where each document lands: its preset folder's id (null when the folder is missing). */
export function planAutoFile<D extends AutoFileDoc & { id: string }>(docs: ReadonlyArray<D>, folders: ReadonlyArray<FolderRow>): Array<{ documentId: string; folderId: string | null; presetKey: PresetKey }> {
  const byPreset = new Map(folders.filter((f) => f.presetKey).map((f) => [f.presetKey!, f.id]));
  return docs.map((d) => {
    const key = presetFor(d).key;
    return { documentId: d.id, presetKey: key, folderId: byPreset.get(key) ?? byPreset.get("other") ?? null };
  });
}

/** The preset folders to create for a new room, parents first, with their positions. */
export function presetFolderRows(): Array<{ presetKey: PresetKey; parentKey: PresetKey | null; name: string; position: number }> {
  const pos = new Map<string | null, number>();
  return VDR_PRESET_FOLDERS.map((f) => {
    const n = (pos.get(f.parent) ?? 0) + 1;
    pos.set(f.parent, n);
    return { presetKey: f.key, parentKey: f.parent, name: f.name, position: n };
  });
}

// ── The recommended plan (set-up step 2) ──────────────────────────────────

export type PlanFolder = { folderId: string; presetKey: string | null; name: string; count: number; levels: string[] };
export type PlanFlagged = { itemId: string; title: string; flags: VdrFlag[] };

/**
 * One row per folder that holds documents, pre-filled from §4.6
 * (Due diligence buyers / Not yet), plus the flagged documents the broker
 * must check first. Full CIM buyers are never in the plan.
 */
export function recommendedPlan(
  folders: ReadonlyArray<FolderRow & { name: string }>,
  items: ReadonlyArray<{ id: string; folderId: string; title: string; removedAt?: Date | string | null }>,
  lookFlags: ReadonlyMap<string, VdrFlag[]>,
): { folders: PlanFolder[]; flagged: PlanFlagged[] } {
  const live = items.filter((i) => !i.removedAt);
  const count = new Map<string, number>();
  for (const it of live) count.set(it.folderId, (count.get(it.folderId) ?? 0) + 1);
  const out: PlanFolder[] = [];
  for (const f of folders) {
    const n = count.get(f.id) ?? 0;
    if (n === 0) continue;
    const preset = presetFolder(f.presetKey);
    // A broker's own folder inherits its preset ancestor's recommendation.
    let rec = preset?.recommended ?? null;
    if (!preset && f.parentId) {
      const parent = folders.find((p) => p.id === f.parentId);
      rec = presetFolder(parent?.presetKey ?? null)?.recommended ?? null;
    }
    out.push({ folderId: f.id, presetKey: f.presetKey, name: f.name, count: n, levels: rec === "dd" ? [DD_ACCESS_LEVEL] : [] });
  }
  const flagged: PlanFlagged[] = [];
  for (const it of live) {
    const flags = (lookFlags.get(it.id) ?? []).filter((x) => x.look);
    if (flags.length > 0) flagged.push({ itemId: it.id, title: it.title, flags });
  }
  return { folders: out, flagged };
}

/**
 * The level shares the confirmed plan writes: every unflagged item (or
 * flagged one the broker ticked) in a folder the broker set to a level.
 * Ledgers only ever get the due-diligence level (gl's rule).
 */
export function planShareRows(
  choice: ReadonlyArray<{ folderId: string; levels: ReadonlyArray<string> }>,
  items: ReadonlyArray<{ id: string; folderId: string; removedAt?: Date | string | null; isLedger?: boolean }>,
  flaggedItemIds: ReadonlySet<string>,
  includeFlagged: ReadonlySet<string>,
): Array<{ itemId: string; accessLevel: string }> {
  const levelsByFolder = new Map<string, string[]>();
  for (const c of choice) {
    const levels = Array.from(new Set(c.levels.map(storedLevelKey))).filter((l) => DATA_ROOM_LEVELS.includes(l));
    levelsByFolder.set(c.folderId, levels);
  }
  const rows: Array<{ itemId: string; accessLevel: string }> = [];
  for (const it of items) {
    if (it.removedAt) continue;
    const levels = levelsByFolder.get(it.folderId) ?? [];
    if (levels.length === 0) continue;
    if (flaggedItemIds.has(it.id) && !includeFlagged.has(it.id)) continue;
    for (const level of levels) {
      if (it.isLedger && level !== DD_ACCESS_LEVEL) continue;
      rows.push({ itemId: it.id, accessLevel: level });
    }
  }
  return rows;
}

/**
 * "New in 1.2 Tax returns: 'T2 2025'. Share it like the rest?" — an unshared
 * live item in a folder whose share hint is set and whose OTHER live items
 * are all shared the same way (same level set, no buyer rows). Never shares.
 */
export function newInHintedFolder(
  folders: ReadonlyArray<{ id: string; shareHint: { levels: string[] } | null }>,
  items: ReadonlyArray<{ id: string; folderId: string; removedAt?: Date | string | null }>,
  shares: ReadonlyArray<{ itemId: string; audience: string; accessLevel: string | null; effect: string }>,
): Array<{ itemId: string; folderId: string; levels: string[] }> {
  const levelsOf = (itemId: string) =>
    shares.filter((s) => s.itemId === itemId && s.audience === "level" && s.effect === "allow" && s.accessLevel).map((s) => storedLevelKey(s.accessLevel!)).sort().join(",");
  const out: Array<{ itemId: string; folderId: string; levels: string[] }> = [];
  for (const f of folders) {
    const hint = (f.shareHint?.levels ?? []).map(storedLevelKey).filter((l) => DATA_ROOM_LEVELS.includes(l)).sort();
    if (hint.length === 0) continue;
    const live = items.filter((i) => i.folderId === f.id && !i.removedAt);
    const unshared = live.filter((i) => !shares.some((s) => s.itemId === i.id && s.effect === "allow"));
    const others = live.filter((i) => !unshared.includes(i));
    if (unshared.length === 0 || others.length === 0) continue;
    const key = hint.join(",");
    if (!others.every((o) => levelsOf(o.id) === key)) continue;
    for (const u of unshared) out.push({ itemId: u.id, folderId: f.id, levels: hint });
  }
  return out;
}
