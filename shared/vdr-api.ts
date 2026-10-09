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
  /** The due-diligence CIM points to this document (dd's registry, else fact tracing). */
  ddCited?: boolean;
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
  /** Their team in the room (pass 4): active and asked-for people. */
  team?: RoomTeamRow[];
  /** Their Cimple buyer account, when they have one ("Open their profile"). */
  buyerUserId?: string | null;
};

/** One person on a buyer's team (broker view). */
export type RoomTeamRow = {
  id: string;
  name: string;
  email: string;
  role: string;
  status: "requested" | "active" | "declined" | "removed";
  /** They confirmed confidentiality (their first visit). */
  acknowledgedAt: string | null;
  linkSentAt: string | null;
  lastVisitAt: string | null;
  documentsOpened: number;
  createdBy: "broker" | "buyer";
  createdAt: string;
};

/** The buyer's own team (their room's "Your team"). */
export type BuyerTeamRow = { id: string; name: string; email: string; role: string; status: "requested" | "active"; acknowledged: boolean };

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

export type BulkShareResult = { changed: number; skipped: Array<{ itemId: string; title: string; reason: string }>; newlyVisibleBuyers: number; newlyVisible?: NewlyVisible[] };

/** A buyer who can open something they couldn't before a share ("Let them know?"). */
export type NewlyVisible = { accessId: string; label: string };

// ── Viewer (broker and buyer) ─────────────────────────────────────────────

export type VdrManifest = {
  /** Broker view with `?needle=`: the page that prints it (PDFs only) and boxes around it (fractions of the page). */
  focusPage?: number | null;
  focusBoxes?: Array<[number, number, number, number]>;
  status: "ready" | "pending" | "failed";
  kind: VdrPreparedKind | null;
  pages: Array<{ w: number; h: number }>;
  sheets: Array<{ index: number; name: string; rows: number; cols: number; firstRow: number; firstCol: number }>;
  error: string | null;
  download: { allowed: boolean; label: string };
  /** A READY general ledger (kind "ledger"): its document, whose rows gl's viewer reads (buyer: `…/data-room/ledger/:documentId/rows`). */
  ledgerDocumentId?: string | null;
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
  /** The reader's document requests (pass 3). */
  requests?: BuyerRequestRow[];
  /** May this reader ask for documents (not in the broker's preview). */
  canRequest?: boolean;
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
  /** The buyer's team (principal only; pass 4) and whether they may ask to add someone. */
  team?: BuyerTeamRow[];
  canInviteTeam?: boolean;
  /** The memorandum is published for this link (the header's "Memorandum | Data room" switch shows only then; never for a team member). */
  memorandumAvailable: boolean;
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
  /** Buyer-safe figures from this document (pass 3; absent on older payloads). */
  keyFigures?: Array<{ label: string; value: string }>;
  /** Opened from a citation with `?needle=`: the page that prints it (PDFs only), else null; boxes around the figure on it. */
  focusPage?: number | null;
  focusBoxes?: Array<[number, number, number, number]>;
  /** Who reads (the on-screen watermark on sheets, Word and text when opened from the CIM). */
  reader?: { name: string | null; email: string };
  /** Due diligence only: what it was checked against (dd's checks; a counterpart the reader can't open is "another document"). */
  checks?: Array<{ ok: boolean; text: string }>;
  /** Memorandum pages that use its figures (none for a team member). */
  usedIn?: Array<{ sectionId: string; title: string }>;
  /** The reader's own questions about it, and answers the broker shared with everyone who can open it. */
  questions?: BuyerDocQuestion[];
  /** May this reader ask about it (not in the broker's preview). */
  canAsk?: boolean;
};

export type BuyerDocQuestion = {
  id: string;
  question: string;
  answer: string | null;
  status: "waiting" | "answered";
  /** Asked by this buyer or their team (else an answer the broker shared). */
  mine: boolean;
  page: number | null;
  at: string;
};

/** A buyer's own document request, as they see it ("Your requests"). */
export type BuyerRequestRow = {
  id: string;
  text: string;
  status: "open" | "asked_seller" | "ready_to_share" | "shared" | "declined";
  /** "Waiting for the broker" · "Shared: now in 1.6" · "The broker replied: '…'". */
  statusText: string;
  itemId: string | null;
  at: string;
};

export type BuyerSearchHit = { itemId: string; number: string | null; title: string; page: number; label: string; snippet: Array<{ text: string; match: boolean }> };

export type ViewStart = { viewId: string; trace: string };

/** `dataRoom` on GET /api/view/:token (INTEGRATION §2.3). */
export type ViewRoomDataRoom = { available: boolean; newCount: number; closed: boolean; allowDownloads: boolean; expiresAt: string | null };

export type { DownloadDecision };

// ── Pass 3: requests, the "Waiting on you" list, activity, Cimple's notes ──

export type RequestStatus = "open" | "asked_seller" | "ready_to_share" | "shared" | "declined";

/** One buyer request as the broker sees it (To do › Buyer requests). */
export type RoomRequestRow = {
  id: string;
  listId: string | null;
  kind: "document" | "room_access";
  text: string;
  status: RequestStatus;
  buyer: {
    key: string;
    accessId: string;
    name: string | null;
    company: string | null;
    email: string;
    levelLabel: string;
    /** The buyer can open the room right now. */
    hasRoom: boolean;
    rule: RoomLevelRule;
  };
  /** A team member asked ("Priya Shah, accountant"). */
  askedBy: { name: string; role: string } | null;
  /** The room document the request names (from the viewer's "Ask"), when it still exists. */
  item: { id: string; number: string | null; title: string } | null;
  /** The document a DD citation pointed at (broker only; never echoed to the buyer). */
  citedDocument: { id: string; name: string } | null;
  requirement: { id: string; name: string; status: string; neededBy: string | null; note: string | null } | null;
  /** The seller's upload that answers it (Ready to share). */
  ready: { documentId: string; name: string; itemId: string | null } | null;
  brokerNote: string | null;
  createdAt: string;
  resolvedAt: string | null;
};

export type RoomRequestsPayload = {
  requests: RoomRequestRow[];
  /** Pasted lists ("Northgate sent a list of 34 requests · Oct 7"). */
  lists: Array<{ listId: string; buyerKey: string; buyerLabel: string; count: number; open: number; createdAt: string }>;
};

export type WaitingKind =
  | "plan"
  | "request"
  | "request_ready"
  | "team_request"
  | "question"
  | "new_version"
  | "hinted"
  | "flag"
  | "dd_cited"
  | "descriptions"
  | "link_ending"
  | "seller_removed";

/** One "Waiting on you" row (§5.8). `text` is the plain line; the client picks the action by kind. */
export type WaitingItem = {
  key: string;
  kind: WaitingKind;
  text: string;
  at: string | null;
  itemId?: string | null;
  requestId?: string | null;
  questionId?: string | null;
  /** A buyer asked to add someone from their team (Approve and send the link · Decline). */
  teamMemberId?: string | null;
  teamMemberName?: string | null;
  accessId?: string | null;
  buyerLabel?: string | null;
  levels?: string[];
  flags?: VdrFlag[];
  itemIds?: string[];
  /** For a ready request: share with this buyer (key) then "Tell the buyer". */
  shared?: boolean;
};

export type WaitingPayload = { items: WaitingItem[] };

/** The email the broker can edit and send (never sent automatically). */
export type EmailDraft = { to: string[]; subject: string; message: string; demo: boolean };

export type ActivityPerson = { memberId: string | null; name: string; role: string; activeMs: number; opens: number };

export type ActivityBuyerRow = {
  key: string;
  accessId: string | null;
  label: string;
  email: string;
  canSee: number;
  openedDocs: number;
  activeMs: number;
  downloads: number;
  lastAt: string | null;
  newNotOpened: number;
  top: Array<{ itemId: string; number: string | null; title: string; activeMs: number }>;
  documents: Array<{ itemId: string; number: string | null; title: string; activeMs: number; opens: number; pages: number[]; downloads: number; fromCim: boolean; lastAt: string }>;
  people: ActivityPerson[];
};

export type ActivityDocRow = {
  itemId: string;
  number: string | null;
  title: string;
  readers: number;
  canSee: number;
  activeMs: number;
  downloads: number;
  pageCount: number;
  pages: Record<string, number>;
  lastAt: string | null;
};

export type ActivityLogRow = {
  id: string;
  at: string;
  action: string;
  actorKind: string;
  text: string;
  buyerKey: string | null;
  itemId: string | null;
  person: string | null;
};

export type TraceHit = {
  trace: string;
  at: string;
  buyerLabel: string;
  email: string;
  person: string | null;
  itemId: string;
  number: string | null;
  title: string;
};

export type ActivityPayload = {
  view: "buyers" | "documents" | "log";
  buyers: ActivityBuyerRow[];
  documents: ActivityDocRow[];
  log: ActivityLogRow[];
  logTotal: number;
  trace: { query: string; hits: TraceHit[] } | null;
  filters: {
    buyers: Array<{ key: string; label: string }>;
    people: Array<{ id: string; label: string }>;
    items: Array<{ id: string; label: string }>;
    actions: Array<{ key: string; label: string }>;
  };
};

/** The broker's "Cimple's notes" on one document (§5.4, §9.6). */
export type ItemNotesPayload = {
  keyFigures: Array<{ key: string; label: string; value: string; inCim: boolean }>;
  cimLinks: Array<{ sectionId: string; title: string }>;
  ddCitedIn: Array<{ sectionId: string; title: string; page: number | null }>;
  checks: Array<{ tone: "match" | "resolved" | "open"; text: string }>;
  questions: Array<{ id: string; question: string; who: string; page: number | null; status: string; statusLabel: string; at: string }>;
  summary: {
    /** Drafts left today for this deal (the daily cap). */
    remainingToday: number;
    capped: boolean;
    running: boolean;
    /** "Cimple's draft didn't pass its checks, so a basic description is shown. …" */
    note: string | null;
  };
};

// ── Pass 4: citations (vdr spec §6.6, §11.1) ──

export type ResolvedDocument =
  | { available: true; itemId: string; title: string; number: string | null; replaced?: true }
  | { available: false };
export type ResolvePayload = { documents: Record<string, ResolvedDocument> };

export type BrokerResolvedDocument =
  | { available: true; documentId: string; title: string; itemId: string | null; number: string | null; inRoom: boolean; brokerOnly: boolean; replaced?: true }
  | { available: false };
export type BrokerResolvePayload = { documents: Record<string, BrokerResolvedDocument> };
