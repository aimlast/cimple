/**
 * The data room's HTTP payloads (vdr spec §9.2, §9.3), shared by the routes
 * and the client so both sides agree on every field. Types only.
 *
 * Nothing here ever carries a file path, a token, a document's text, its
 * private notes or red flags to a buyer: the buyer types are built by
 * whitelisting on the server (server/vdr/buyer-room.ts).
 */
import type { DownloadDecision, RoomAccessSetting, RoomLevelRule, ShareSummary, VdrFlag, VdrFlagKey, VdrPreparedKind, BuyerIneligibleReason } from "./vdr";

// ── Broker ────────────────────────────────────────────────────────────────

export type RoomFolderRow = {
  id: string;
  parentId: string | null;
  name: string;
  position: number;
  presetKey: string | null;
  number: string;
  depth: number;
  /** Live documents in this folder and its sub-folders. */
  count: number;
  /** The sharing plan's choice for this folder (a hint, never automatic). */
  shareHint: { levels: string[] } | null;
};

export type RoomPreparedSummary = {
  status: "pending" | "ready" | "failed";
  kind: VdrPreparedKind;
  pages: number | null;
  sheets: number | null;
  error: string | null;
  errorCode: string | null;
};

export type RoomShareRow = { email: string; accessId: string | null; name: string | null; company: string | null };

export type RoomItemRow = {
  id: string;
  folderId: string;
  documentId: string | null;
  number: string | null;
  title: string;
  position: number;
  addedBy: string;
  addedAt: string;
  /** The document behind it (broker view; never sent to buyers). */
  doc: {
    name: string;
    typeLabel: string | null;
    periodLabel: string | null;
    uploadedBy: string;
    createdAt: string;
    visibility: string | null;
    status: string | null;
  } | null;
  sizeLabel: string;
  prepared: RoomPreparedSummary | null;
  flags: VdrFlag[];
  /** Needs-a-look flags not yet ticked for the current file. */
  unchecked: VdrFlagKey[];
  checked: { at: string; flags: string[] } | null;
  sharing: ShareSummary & { allow: RoomShareRow[]; deny: RoomShareRow[] };
  downloadable: boolean;
  downloadOriginal: boolean;
  downloadLabel: string;
  cleanCopy: { name: string | null; at: string | null } | null;
  opened: { buyers: number; activeMs: number; lastAt: string | null };
  isLedger: boolean;
  /** A seller's new version that isn't shared yet ("Share with the same people"). */
  newVersion: { replaces: string; oldWasShared: boolean } | null;
  removed: { at: string; reason: string; wasShared: boolean; buyersCouldOpen: number } | null;
  summary: {
    text: string | null;
    points: string[];
    source: string | null;
    status: string | null;
    hidden: boolean;
    basic: string;
  };
  fileVersion: number;
};

export type NotPlacedDoc = {
  documentId: string;
  name: string;
  typeLabel: string | null;
  uploadedBy: string;
  createdAt: string;
  /** The folder it would land in ("Tax returns"). */
  suggestedFolder: string | null;
};

export type DealDocumentRow = {
  id: string;
  name: string;
  typeLabel: string;
  uploadedBy: string;
  createdAt: string;
  roomMaterial: boolean;
};

export type RoomKpis = {
  inRoom: number;
  shared: number;
  buyersWithAccess: number;
  openedThisWeek: { documents: number; buyers: number };
  waiting: number;
  missingRequired: number;
  /** Documents shared per data-room level (normalised keys) — the CIM tab's tiles (§11.3). */
  sharedByLevel: Record<string, number>;
  /** Buyers with the room per level (normalised keys). */
  roomBuyersByLevel: Record<string, number>;
  /** Documents the DD CIM points to that aren't shared with due-diligence buyers (0 until dd ships its registry). */
  ddCitedNotShared: number;
};

export type BrokerRoomPayload = {
  room: null | {
    status: "open" | "closed";
    autoAddNew: boolean;
    planAppliedAt: string | null;
    setUpAt: string;
    closedAt: string | null;
  };
  folders: RoomFolderRow[];
  items: RoomItemRow[];
  notPlaced: NotPlacedDoc[];
  /** Every document and source of the deal (the list under the "Set up" card). */
  documents: DealDocumentRow[];
  kpis: RoomKpis;
  deal: { live: boolean; everLive: boolean; name: string };
  ddCited: { available: boolean; total: number; notShared: number };
};

export type PlanFolderRow = {
  folderId: string;
  name: string;
  number: string;
  documents: number;
  recommended: "dd" | "not_yet";
  levels: string[];
};

export type PlanFlaggedRow = { itemId: string; number: string | null; title: string; flags: VdrFlag[] };

export type SharingPlanPayload = {
  folders: PlanFolderRow[];
  flagged: PlanFlaggedRow[];
  summaries: Array<{ itemId: string; title: string; text: string | null; status: string | null; basic: string }>;
  planAppliedAt: string | null;
};

export type RoomBuyerRow = {
  key: string;
  accessId: string;
  name: string | null;
  company: string | null;
  email: string;
  level: string;
  levelLabel: string;
  links: number;
  rule: RoomLevelRule;
  roomAccess: RoomAccessSetting;
  hasRoom: boolean;
  allowDownloads: boolean;
  canSee: number;
  newCount: number;
  lastOpenedAt: string | null;
  expiresAt: string | null;
  endsInDays: number | null;
};

export type NotEligibleBuyerRow = {
  key: string;
  accessId: string;
  name: string | null;
  company: string | null;
  email: string;
  level: string;
  levelLabel: string;
  reason: BuyerIneligibleReason;
  copy: string;
};

export type RoomBuyersPayload = { eligible: RoomBuyerRow[]; notEligible: NotEligibleBuyerRow[] };

export type ShareCheck = { itemId: string; title: string; flags: VdrFlag[] };

/** The Share dialog's audience: levels with counts, buyers who can have the room. */
export type ShareAudience = {
  levels: Array<{ key: string; label: string; buyers: number; rule: RoomLevelRule }>;
  buyers: Array<{ accessId: string; key: string; name: string | null; company: string | null; email: string; level: string; levelLabel: string; hasRoom: boolean; dd: boolean }>;
};

export type BulkShareResult = { changed: number; skipped: Array<{ itemId: string; title: string; reason: string }>; newlyVisibleBuyers: number };

// ── Viewer (broker and buyer) ─────────────────────────────────────────────

export type VdrManifest = {
  status: "ready" | "pending" | "failed";
  kind: VdrPreparedKind | null;
  pages: Array<{ w: number; h: number }>;
  sheets: Array<{ index: number; name: string; rows: number; cols: number; firstRow: number; firstCol: number }>;
  error: string | null;
  download: { allowed: boolean; label: string };
};

export type VdrSheetRows = {
  sheet: { index: number; name: string; rows: number; cols: number; firstRow: number; firstCol: number };
  offset: number;
  total: number;
  rows: Array<{ r: number; v: Array<string | null> }>;
  /** Covered cells [excelRow, absoluteCol] (shown as covered). */
  covered: Array<[number, number]>;
};

// ── Buyer ─────────────────────────────────────────────────────────────────

export type BuyerRoomFolder = { id: string; parentId: string | null; name: string; number: string; count: number };

export type BuyerRoomItem = {
  id: string;
  folderId: string;
  number: string | null;
  title: string;
  sizeLabel: string;
  ready: boolean;
  isNew: boolean;
  isUpdated: boolean;
  opened: boolean;
  download: { allowed: boolean; label: string };
};

export type BuyerRoomPayload = {
  reader: {
    kind: "buyer" | "team" | "preview";
    name: string | null;
    email: string;
    /** For a team member: the buyer they work for. */
    principalCompany: string | null;
  };
  deal: { name: string; firmName: string | null; firmLogo: string | null };
  folders: BuyerRoomFolder[];
  items: BuyerRoomItem[];
  /** The visit before this one (for "Nothing new since your last visit on …"). */
  previousVisitAt: string | null;
  expiresAt: string | null;
  endsInDays: number | null;
  newCount: number;
  allowDownloads: boolean;
};

export type BuyerItemAbout = {
  id: string;
  number: string | null;
  title: string;
  sizeLabel: string;
  description: { text: string; points: string[] };
  manifest: VdrManifest;
  folderTrail: Array<{ id: string; number: string; name: string }>;
  prevId: string | null;
  nextId: string | null;
};

export type BuyerSearchHit = { itemId: string; number: string | null; title: string; page: number; label: string; snippet: Array<{ text: string; match: boolean }> };

export type ViewStart = { viewId: string; trace: string };

/** `dataRoom` on GET /api/view/:token (INTEGRATION §2.3). */
export type ViewRoomDataRoom = { available: boolean; newCount: number; closed: boolean; allowDownloads: boolean; expiresAt: string | null };

export type { DownloadDecision };
