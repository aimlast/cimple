/**
 * The broker's Data room tab (vdr spec §5): the payloads and the sharing
 * rules. No AI, no email.
 *
 *  - roomPayload: folders with the room's numbers, items with their sharing
 *    chip, flags, opened stats and status, the documents not placed yet, and
 *    the five KPI numbers (+ the CIM tab's per-level numbers, §11.3).
 *  - roomBuyers: one row per buyer (by email, V17) who can have the room,
 *    plus "Not eligible yet" with the plain reason.
 *  - validateShares / applyShares: the Share dialog's PUT and the bulk /
 *    folder share. Levels and buyers are checked against the access-level
 *    registry, every access id must be this deal's (else 404), a ledger is
 *    due-diligence only (gl's copy), needs-a-look flags must be ticked.
 */
import fs from "fs";
import type { BuyerAccess, BuyerQuestion, DealDocumentRequirement, Deal, Document, InsertVdrShare, VdrBuyerSettings, VdrFolder, VdrItem, VdrRequest, VdrShare, VdrTeamMember, VdrView } from "@shared/schema";
import { accessLevelLabel, normalizeAccessLevel, parseAccessLevelInput, sameAccessLevel, DD_ACCESS_LEVEL } from "@shared/access-levels";
import {
  DATA_ROOM_LEVELS,
  VDR_LIMITS,
  basicDescription,
  buyerKey,
  dataRoomLevelRule,
  documentTypeLabel,
  downloadChipLabel,
  fileKindFor,
  fileSizeLabel,
  folderDepth,
  hasRoomAccess,
  indexNumbers,
  ineligibleCopy,
  isNewForBuyer,
  isRoomLevel,
  isRoomMaterial,
  linkLive,
  periodEndLabel,
  presetFolder,
  roomIneligibleReason,
  shareSummary,
  type RoomAccessSetting,
  type VdrFlag,
  type VdrFlagKey,
} from "@shared/vdr";
import type {
  BrokerRoomPayload,
  DealDocumentRow,
  NotEligibleBuyerRow,
  NotPlacedDoc,
  RoomBuyerRow,
  RoomFolderRow,
  RoomItemRow,
  RoomShareRow,
  RoomTeamRow,
  ShareAudience,
  WaitingItem,
} from "@shared/vdr-api";
import { presetFor } from "./auto-file";
import { decideItems, flagsFor, isLedgerItemDoc, loadRoom, type RoomSnapshot, type VdrReader } from "./access";
import { servedFilePath } from "./files";
import { waitingItems } from "./todo";
import type { VdrStore } from "./store";

export type BrokerDeps = {
  store: VdrStore;
  accessRowsForDeal: (dealId: string) => Promise<BuyerAccess[]>;
  requirementsForDeal: (dealId: string) => Promise<DealDocumentRequirement[]>;
  privateMatters: (deal: Deal, documentIds: string[]) => Map<string, string[]>;
  ddCitedDocumentIds: (dealId: string) => Promise<string[] | null>;
  root: string;
  now: () => Date;
  fileExists?: (p: string) => boolean;
  /** The deal's buyer questions (document questions feed "Waiting on you"). */
  questionsForDeal?: (dealId: string) => Promise<BuyerQuestion[]>;
};

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

const SOURCE_LABEL: Record<string, string> = {
  document: "Document",
  email: "Email",
  call: "Call notes",
  video_call: "Video call",
  crm: "CRM note",
  website: "Website",
  social: "Social media",
  broker: "Your note",
  questionnaire: "Questionnaire",
  system: "System",
};

function typeLabelOf(doc: Document): string {
  if (doc.sourceKind && doc.sourceKind !== "document") return SOURCE_LABEL[doc.sourceKind] ?? "Source";
  if (doc.category === "transcripts") return "Call notes";
  if (doc.category === "email") return "Email";
  return documentTypeLabel(doc) ?? (fileKindFor({ name: doc.originalName || doc.name, mimeType: doc.mimeType }) === "sheet" ? "Spreadsheet" : "Document");
}

/** The room buyer a level/allow share would reach: one per email, the best live link with the room. */
export type BuyerGroup = {
  key: string;
  rows: BuyerAccess[];
  setting: VdrBuyerSettings | null;
  /** The link that can have the room (live, NDA, Full CIM or DD), DD first then newest. */
  eligible: BuyerAccess | null;
  hasRoom: boolean;
};

export function groupBuyers(rows: ReadonlyArray<BuyerAccess>, settings: ReadonlyArray<VdrBuyerSettings>, now: Date): BuyerGroup[] {
  const byKey = new Map<string, BuyerAccess[]>();
  for (const r of rows) {
    const k = buyerKey(r.buyerEmail);
    if (!k) continue;
    byKey.set(k, [...(byKey.get(k) ?? []), r]);
  }
  const out: BuyerGroup[] = [];
  for (const [key, list] of Array.from(byKey.entries())) {
    const setting = settings.find((s) => s.buyerEmail === key) ?? null;
    const ok = list.filter((r) => roomIneligibleReason(r, now) === null);
    const score = (r: BuyerAccess) => (dataRoomLevelRule(r.accessLevel) === "auto_on" ? 2 : 1);
    const eligible = ok.sort((a, b) => score(b) - score(a) || new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime())[0] ?? null;
    out.push({ key, rows: list, setting, eligible, hasRoom: !!eligible && hasRoomAccess(eligible.accessLevel, setting?.roomAccess as RoomAccessSetting | undefined) });
  }
  return out;
}

function readerOf(dealId: string, link: BuyerAccess): VdrReader {
  return { dealId, accessLevel: normalizeAccessLevel(link.accessLevel), buyerEmail: buyerKey(link.buyerEmail), mode: dataRoomLevelRule(link.accessLevel) === "auto_on" ? "dd" : "normal" };
}

function shareRowsFor(shares: ReadonlyArray<VdrShare>, groups: ReadonlyArray<BuyerGroup>, effect: "allow" | "deny"): RoomShareRow[] {
  return shares
    .filter((s) => s.audience === "buyer" && s.effect === effect && s.buyerEmail)
    .map((s) => {
      const g = groups.find((x) => x.key === s.buyerEmail);
      const link = g?.eligible ?? g?.rows[0] ?? null;
      return { email: s.buyerEmail!, accessId: link?.id ?? null, name: link?.buyerName ?? null, company: link?.buyerCompany ?? null };
    });
}

function viewStats(views: ReadonlyArray<VdrView>): Map<string, { buyers: Set<string>; activeMs: number; lastAt: number }> {
  const m = new Map<string, { buyers: Set<string>; activeMs: number; lastAt: number }>();
  for (const v of views) {
    if (v.source === "preview") continue;
    const s = m.get(v.itemId) ?? { buyers: new Set<string>(), activeMs: 0, lastAt: 0 };
    s.buyers.add(v.buyerEmail);
    s.activeMs += v.activeMs ?? 0;
    s.lastAt = Math.max(s.lastAt, new Date(v.lastSeenAt).getTime());
    m.set(v.itemId, s);
  }
  return m;
}

function folderRows(folders: ReadonlyArray<VdrFolder>, items: ReadonlyArray<VdrItem>, numbers: Map<string, string>): RoomFolderRow[] {
  const live = items.filter((i) => !i.removedAt);
  const direct = new Map<string, number>();
  for (const it of live) direct.set(it.folderId, (direct.get(it.folderId) ?? 0) + 1);
  const children = new Map<string, string[]>();
  for (const f of folders) if (f.parentId) children.set(f.parentId, [...(children.get(f.parentId) ?? []), f.id]);
  const total = (id: string, seen = new Set<string>()): number => {
    if (seen.has(id)) return 0;
    seen.add(id);
    return (direct.get(id) ?? 0) + (children.get(id) ?? []).reduce((n, c) => n + total(c, seen), 0);
  };
  return folders
    .map((f) => ({
      id: f.id,
      parentId: f.parentId,
      name: f.name,
      position: f.position,
      presetKey: f.presetKey,
      number: numbers.get(f.id) ?? "",
      depth: folderDepth(folders, f.id),
      count: total(f.id),
      shareHint: (f.shareHint as { levels: string[] } | null) ?? null,
    }))
    .sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));
}

/** The "set aside" keys of the Waiting list ("Not now" on a hinted file, "Dismiss" on the DD line). */
export async function dismissedKeys(store: VdrStore, dealId: string): Promise<Set<string>> {
  const rows = await store.listActivityByActions(dealId, ["todo_dismissed"]).catch(() => []);
  return new Set(rows.map((r) => String(((r.detail ?? {}) as Record<string, unknown>).key ?? "")).filter(Boolean));
}

/** The Buyers view (§5.7) — and the per-buyer numbers the KPI strip needs. */
export function buildBuyers(
  dealId: string,
  groups: ReadonlyArray<BuyerGroup>,
  snap: RoomSnapshot,
  views: ReadonlyArray<VdrView>,
  i: { root: string; now: Date; privateMatters: ReadonlyMap<string, string[]>; fileExists?: (p: string) => boolean; team?: ReadonlyArray<VdrTeamMember> },
): { eligible: RoomBuyerRow[]; notEligible: NotEligibleBuyerRow[] } {
  const eligible: RoomBuyerRow[] = [];
  const notEligible: NotEligibleBuyerRow[] = [];
  for (const g of groups) {
    if (!g.eligible) {
      const pick = g.rows.slice().sort((a, b) => Number(linkLive(b, i.now)) - Number(linkLive(a, i.now)) || new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime())[0];
      const reason = roomIneligibleReason(pick, i.now) ?? "nda";
      notEligible.push({ key: g.key, accessId: pick.id, name: pick.buyerName ?? null, company: pick.buyerCompany ?? null, email: pick.buyerEmail, level: normalizeAccessLevel(pick.accessLevel), levelLabel: accessLevelLabel(pick.accessLevel), reason, copy: ineligibleCopy(reason) });
      continue;
    }
    const link = g.eligible;
    const reader = readerOf(dealId, link);
    const decided = g.hasRoom ? decideItems(snap, reader, i.root, { privateMatters: i.privateMatters, fileExists: i.fileExists }) : [];
    const visible = decided.filter((d) => d.visibility.visible);
    const prev = g.setting?.previousVisitAt ?? null;
    const myViews = views.filter((v) => v.buyerEmail === g.key && v.source !== "preview");
    const newCount = visible.filter((d) => {
      const grants = d.shares.filter((s) => s.effect === "allow" && ((s.audience === "buyer" && s.buyerEmail === g.key) || (s.audience === "level" && sameAccessLevel(s.accessLevel, reader.accessLevel))));
      const opened = myViews.some((v) => v.itemId === d.item.id && v.fileVersion < (d.item.fileVersion ?? 1));
      return isNewForBuyer({ grants: grants.map((s) => ({ createdAt: s.createdAt })), previousVisitAt: prev, fileChangedAt: d.item.fileChangedAt ?? null, openedEarlierVersion: opened }).isNew;
    }).length;
    const last = myViews.reduce((m, v) => Math.max(m, new Date(v.lastSeenAt).getTime()), 0);
    const exp = link.expiresAt ? new Date(link.expiresAt).getTime() : null;
    eligible.push({
      key: g.key,
      accessId: link.id,
      name: link.buyerName ?? null,
      company: link.buyerCompany ?? null,
      email: link.buyerEmail,
      level: normalizeAccessLevel(link.accessLevel),
      levelLabel: accessLevelLabel(link.accessLevel),
      links: g.rows.filter((r) => linkLive(r, i.now)).length,
      rule: dataRoomLevelRule(link.accessLevel),
      roomAccess: ((g.setting?.roomAccess as RoomAccessSetting) ?? "auto"),
      hasRoom: g.hasRoom,
      allowDownloads: !!g.setting?.allowDownloads,
      canSee: visible.length,
      newCount,
      lastOpenedAt: last ? new Date(last).toISOString() : null,
      expiresAt: iso(link.expiresAt),
      endsInDays: exp == null ? null : Math.max(0, Math.ceil((exp - i.now.getTime()) / 86_400_000)),
      team: teamRows(i.team ?? [], g.key, myViews),
      buyerUserId: g.rows.find((r) => r.buyerUserId)?.buyerUserId ?? null,
    });
  }
  const byName = (a: { name: string | null; email: string }, b: { name: string | null; email: string }) => (a.name || a.email).localeCompare(b.name || b.email);
  eligible.sort((a, b) => Number(b.rule === "auto_on") - Number(a.rule === "auto_on") || Number(b.hasRoom) - Number(a.hasRoom) || byName(a, b));
  notEligible.sort(byName);
  return { eligible, notEligible };
}

/** A buyer's team for the broker (asked-for and active people; §5.7). */
export function teamRows(team: ReadonlyArray<VdrTeamMember>, buyerKeyOf: string, views: ReadonlyArray<VdrView>): RoomTeamRow[] {
  return team
    .filter((m) => m.principalEmail === buyerKeyOf && (m.status === "active" || m.status === "requested"))
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    .map((m) => ({
      id: m.id,
      name: m.name,
      email: m.email,
      role: m.role,
      status: m.status as RoomTeamRow["status"],
      acknowledgedAt: iso(m.ackAt),
      linkSentAt: iso(m.linkSentAt),
      lastVisitAt: iso(m.lastVisitAt),
      documentsOpened: new Set(views.filter((v) => v.teamMemberId === m.id && v.source !== "preview").map((v) => v.itemId)).size,
      createdBy: m.createdBy === "buyer" ? "buyer" : "broker",
      createdAt: new Date(m.createdAt).toISOString(),
    }));
}

export async function loadBrokerContext(deps: BrokerDeps, deal: Deal) {
  const [snap, accessRows, settings, views] = await Promise.all([
    loadRoom(deps.store, deal.id),
    deps.accessRowsForDeal(deal.id),
    deps.store.listBuyerSettings(deal.id),
    deps.store.listViews(deal.id),
  ]);
  const rows = accessRows.filter((r) => r.dealId === deal.id);
  const now = deps.now();
  const groups = groupBuyers(rows, settings, now);
  const pm = deps.privateMatters(deal, snap.items.filter((i) => !i.removedAt && i.documentId).map((i) => i.documentId!));
  return { snap, rows, settings, views, groups, now, pm };
}

export type BrokerContext = Awaited<ReturnType<typeof loadBrokerContext>>;

export function itemRow(
  item: VdrItem,
  snap: RoomSnapshot,
  ctx: { groups: ReadonlyArray<BuyerGroup>; pm: ReadonlyMap<string, string[]>; stats: Map<string, { buyers: Set<string>; activeMs: number; lastAt: number }>; numbers: Map<string, string>; root: string; fileExists: (p: string) => boolean },
): RoomItemRow {
  const doc = item.documentId ? snap.docs.get(item.documentId) ?? null : null;
  const shares = snap.shares.filter((s) => s.itemId === item.id);
  // A tombstone's file is never checked (it has no flags to show).
  const path = doc && !item.removedAt ? servedFilePath(item, doc, ctx.root) : null;
  const exists = !!path && ctx.fileExists(path);
  const isLedger = isLedgerItemDoc(doc);
  const { flags, unchecked } = item.removedAt ? { flags: [] as VdrFlag[], unchecked: [] as VdrFlagKey[] } : flagsFor(item, doc, { privateMatters: doc ? ctx.pm.get(doc.id) ?? [] : [], fileMissing: !exists, isLedger });
  const summary = shareSummary(shares);
  const st = ctx.stats.get(item.id);
  const p = item.prepared ?? null;
  const replaced = item.replacesItemId ? snap.items.find((x) => x.id === item.replacesItemId) ?? null : null;
  const replacedShared = !!replaced && snap.shares.some((s) => s.itemId === replaced.id && s.effect === "allow");
  const ed = (doc?.extractedData ?? null) as Record<string, unknown> | null;
  const meta = (doc?.sourceMeta ?? null) as Record<string, unknown> | null;
  const basic = basicDescription(doc, p);
  return {
    id: item.id,
    folderId: item.folderId,
    documentId: item.documentId,
    number: ctx.numbers.get(item.id) ?? null,
    title: item.title,
    position: item.position,
    addedBy: item.addedBy,
    addedAt: new Date(item.addedAt).toISOString(),
    doc: doc
      ? {
          name: doc.name,
          typeLabel: documentTypeLabel(doc),
          periodLabel: periodEndLabel(ed?._periodEnd ?? meta?.periodEnd),
          uploadedBy: doc.uploadedBy,
          createdAt: new Date(doc.createdAt).toISOString(),
          visibility: doc.visibility ?? null,
          status: doc.status ?? null,
        }
      : null,
    sizeLabel: fileSizeLabel(p, doc ? fileKindFor({ name: doc.originalName || doc.name, mimeType: doc.mimeType }) : null),
    prepared: p ? { status: p.status, kind: p.kind, pages: p.pages?.length ?? null, sheets: p.sheets?.length ?? null, error: p.error ?? null, errorCode: p.errorCode ?? null } : null,
    flags,
    unchecked,
    checked: item.checkedAt && item.checkedForFile && p && item.checkedForFile === p.forFile ? { at: new Date(item.checkedAt).toISOString(), flags: (item.checkedFlags as string[] | null) ?? [] } : null,
    sharing: { ...summary, allow: shareRowsFor(shares, ctx.groups, "allow"), deny: shareRowsFor(shares, ctx.groups, "deny") },
    downloadable: item.downloadable,
    downloadOriginal: item.downloadOriginal,
    downloadLabel: downloadChipLabel(item),
    cleanCopy: item.cleanCopyPath ? { name: item.cleanCopyName ?? null, at: iso(item.cleanCopyAt) } : null,
    opened: { buyers: st?.buyers.size ?? 0, activeMs: st?.activeMs ?? 0, lastAt: st?.lastAt ? new Date(st.lastAt).toISOString() : null },
    isLedger,
    newVersion: item.replacesItemId && !summary.shared ? { replaces: item.replacesItemId, oldWasShared: replacedShared } : null,
    removed: item.removedAt
      ? { at: new Date(item.removedAt).toISOString(), reason: item.removedReason ?? "source_deleted", wasShared: summary.shared, buyersCouldOpen: st?.buyers.size ?? 0 }
      : null,
    summary: {
      text: item.buyerSummary ?? null,
      points: Array.isArray(item.buyerSummaryPoints) ? (item.buyerSummaryPoints as string[]) : [],
      source: item.buyerSummarySource ?? null,
      status: item.buyerSummaryStatus ?? null,
      hidden: !!item.buyerSummaryHidden,
      basic,
    },
    fileVersion: item.fileVersion ?? 1,
  };
}

export async function roomPayload(deps: BrokerDeps, deal: Deal): Promise<BrokerRoomPayload> {
  return (await roomAndWaiting(deps, deal)).payload;
}

/** One answer per file for the whole load (every buyer's decision asks about the same files). */
export function memoFileExists(fileExists: (p: string) => boolean): (p: string) => boolean {
  const seen = new Map<string, boolean>();
  return (p) => {
    let v = seen.get(p);
    if (v === undefined) { v = fileExists(p); seen.set(p, v); }
    return v;
  };
}

/** What "Waiting on you" reads besides the room itself. */
export type WaitingInputs = {
  requests: VdrRequest[];
  questions: BuyerQuestion[];
  team: VdrTeamMember[];
  dismissed: Set<string>;
};

async function loadWaitingInputs(deps: BrokerDeps, dealId: string): Promise<WaitingInputs> {
  const [requests, questions, team, dismissed] = await Promise.all([
    deps.store.listRequests(dealId).catch(() => [] as VdrRequest[]),
    deps.questionsForDeal ? deps.questionsForDeal(dealId).catch(() => [] as BuyerQuestion[]) : Promise.resolve([] as BuyerQuestion[]),
    deps.store.listTeamMembers(dealId).catch(() => [] as VdrTeamMember[]),
    dismissedKeys(deps.store, dealId),
  ]);
  return { requests, questions, team, dismissed };
}

/**
 * The tab's payload and its "Waiting on you" list, from one load (GET …/todo
 * uses the list). Every read starts at once — the room, its buyers, views,
 * the checklist, what the DD CIM cites and what's waiting — so the tab costs
 * one round of database reads, not five one after another (checker F6).
 */
export async function roomAndWaiting(deps: BrokerDeps, deal: Deal): Promise<{ payload: BrokerRoomPayload; waiting: WaitingItem[] }> {
  const [ctx, room, requirements, cited, inputs] = await Promise.all([
    loadBrokerContext(deps, deal),
    deps.store.getRoom(deal.id),
    deps.requirementsForDeal(deal.id).catch(() => [] as DealDocumentRequirement[]),
    deps.ddCitedDocumentIds(deal.id).catch(() => null),
    loadWaitingInputs(deps, deal.id),
  ]);
  const { snap, groups, views, now, pm, rows } = ctx;
  const fileExists = memoFileExists(deps.fileExists ?? fs.existsSync);
  const numbers = indexNumbers(snap.folders, snap.items);
  const stats = viewStats(views);
  // Tombstones a broker took out ("broker") live in "Not in the room"; the others show greyed in their folder.
  const shownItems = snap.items.filter((i) => !i.removedAt || i.removedReason !== "broker");
  const items = shownItems.map((it) => itemRow(it, snap, { groups, pm, stats, numbers: numbers.items, root: deps.root, fileExists }));
  const liveDocIds = new Set(snap.items.filter((i) => !i.removedAt && i.documentId).map((i) => i.documentId!));
  const allDocs = Array.from(snap.docs.values()).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const notPlaced: NotPlacedDoc[] = room
    ? allDocs.filter((d) => isRoomMaterial(d) && !liveDocIds.has(d.id)).map((d) => ({
        documentId: d.id,
        name: d.name,
        typeLabel: documentTypeLabel(d),
        uploadedBy: d.uploadedBy,
        createdAt: new Date(d.createdAt).toISOString(),
        suggestedFolder: presetFolder(presetFor(d).key)?.name ?? null,
      }))
    : [];
  const documents: DealDocumentRow[] = allDocs.map((d) => ({ id: d.id, name: d.name, typeLabel: typeLabelOf(d), uploadedBy: d.uploadedBy, createdAt: new Date(d.createdAt).toISOString(), roomMaterial: isRoomMaterial(d) }));
  const buyers = buildBuyers(deal.id, groups, snap, views, { root: deps.root, now, privateMatters: pm, fileExists });
  const live = items.filter((i) => !i.removed);
  const sharedByLevel: Record<string, number> = {};
  const roomBuyersByLevel: Record<string, number> = {};
  for (const level of DATA_ROOM_LEVELS) {
    sharedByLevel[level] = live.filter((i) => i.sharing.levels.includes(level)).length;
    roomBuyersByLevel[level] = buyers.eligible.filter((b) => b.hasRoom && sameAccessLevel(b.level, level)).length;
  }
  const waiting = room
    ? waitingFromInputs(ctx, items, buyers.eligible, folderRows(snap.folders, snap.items, numbers.folders), inputs, cited)
    : [];
  const weekAgo = now.getTime() - 7 * 86_400_000;
  const recent = views.filter((v) => v.source !== "preview" && new Date(v.lastSeenAt).getTime() >= weekAgo);
  const ddShared = new Set(live.filter((i) => i.sharing.levels.includes(DD_ACCESS_LEVEL) && i.documentId).map((i) => i.documentId!));
  const citedIds = cited ? Array.from(new Set(cited)) : [];
  const ddNotShared = citedIds.filter((id) => !ddShared.has(id)).length;
  const citedSet = new Set(citedIds);
  for (const i of items) i.ddCited = !!i.documentId && citedSet.has(i.documentId);
  const payload: BrokerRoomPayload = {
    room: room ? { status: room.status === "closed" ? "closed" : "open", autoAddNew: room.autoAddNew, planAppliedAt: iso(room.planAppliedAt), setUpAt: new Date(room.setUpAt).toISOString(), closedAt: iso(room.closedAt) } : null,
    folders: room ? folderRows(snap.folders, snap.items, numbers.folders) : [],
    items: room ? items : [],
    notPlaced,
    documents,
    kpis: {
      inRoom: live.length,
      shared: live.filter((i) => i.sharing.shared).length,
      buyersWithAccess: buyers.eligible.filter((b) => b.hasRoom).length,
      openedThisWeek: { documents: new Set(recent.map((v) => v.itemId)).size, buyers: new Set(recent.map((v) => v.buyerEmail)).size },
      waiting: waiting.length,
      missingRequired: requirements.filter((r) => r.status === "missing" && r.isRequired !== false).length,
      sharedByLevel,
      roomBuyersByLevel,
      ddCitedNotShared: ddNotShared,
    },
    deal: { live: !!deal.isLive, everLive: !!deal.isLive || rows.length > 0, name: deal.businessName },
    ddCited: { available: !!cited, total: citedIds.length, notShared: ddNotShared },
  };
  return { payload, waiting };
}

/** "Waiting on you" (§5.8) for a deal, from the tab's own context. */
export async function waitingFor(
  deps: BrokerDeps,
  deal: Deal,
  ctx: BrokerContext,
  items: ReadonlyArray<RoomItemRow>,
  buyers: ReadonlyArray<RoomBuyerRow>,
  folders: ReadonlyArray<RoomFolderRow>,
): Promise<WaitingItem[]> {
  const [inputs, cited] = await Promise.all([loadWaitingInputs(deps, deal.id), deps.ddCitedDocumentIds(deal.id).catch(() => null)]);
  return waitingFromInputs(ctx, items, buyers, folders, inputs, cited);
}

/** "Waiting on you" from what's already read (no I/O). */
export function waitingFromInputs(
  ctx: BrokerContext,
  items: ReadonlyArray<RoomItemRow>,
  buyers: ReadonlyArray<RoomBuyerRow>,
  folders: ReadonlyArray<RoomFolderRow>,
  inputs: WaitingInputs,
  cited: ReadonlyArray<string> | null,
): WaitingItem[] {
  const { requests, questions, team, dismissed } = inputs;
  const live = items.filter((i) => !i.removed);
  const ddShared = new Set(live.filter((i) => i.sharing.levels.includes(DD_ACCESS_LEVEL) && i.documentId).map((i) => i.documentId!));
  const citedIds = cited ? Array.from(new Set(cited)) : [];
  return waitingItems({
    now: ctx.now,
    items,
    rawItems: ctx.snap.items,
    folders: folders.map((f) => ({ id: f.id, number: f.number, name: f.name, shareHint: f.shareHint })),
    shares: ctx.snap.shares,
    groups: ctx.groups,
    buyers,
    accessRows: ctx.rows,
    requests,
    questions,
    team,
    dismissed,
    ddCited: { available: !!cited, total: citedIds.length, notShared: citedIds.filter((id) => !ddShared.has(id)).length },
    docNames: new Map(Array.from(ctx.snap.docs.values()).map((d) => [d.id, d.name])),
  });
}

/** The Share dialog's audience (§5.5). */
export function shareAudience(groups: ReadonlyArray<BuyerGroup>): ShareAudience {
  const levels = DATA_ROOM_LEVELS.map((key) => ({
    key,
    label: `${accessLevelLabel(key)} buyers`,
    buyers: groups.filter((g) => g.hasRoom && g.eligible && sameAccessLevel(g.eligible.accessLevel, key)).length,
    rule: dataRoomLevelRule(key),
  }));
  const buyers = groups
    .filter((g) => g.eligible)
    .map((g) => ({
      accessId: g.eligible!.id,
      key: g.key,
      name: g.eligible!.buyerName ?? null,
      company: g.eligible!.buyerCompany ?? null,
      email: g.eligible!.buyerEmail,
      level: normalizeAccessLevel(g.eligible!.accessLevel),
      levelLabel: accessLevelLabel(g.eligible!.accessLevel),
      hasRoom: g.hasRoom,
      dd: dataRoomLevelRule(g.eligible!.accessLevel) === "auto_on",
    }))
    .sort((a, b) => (a.name || a.email).localeCompare(b.name || b.email));
  return { levels, buyers };
}

// ── Sharing rules ─────────────────────────────────────────────────────────

export const LEDGER_DD_ONLY = "Only due-diligence buyers can open the general ledger. Move this buyer to Due diligence first.";
export const NOT_ROOM_BUYER = "Teaser and Blind CIM buyers can't have documents. Move them to Full CIM first.";

export type ShareInput = { levels: string[]; allow: string[]; deny: string[] };
export type ShareFailure = { status: number; body: Record<string, unknown> };

/** Request body → a clean ShareInput (arrays of strings, no duplicates, capped), or null. */
export function parseShareBody(b: unknown): ShareInput | null {
  if (!b || typeof b !== "object") return null;
  const o = b as Record<string, unknown>;
  const list = (v: unknown, max: number): string[] | null => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || v.length > max || v.some((x) => typeof x !== "string" || x.length > 100)) return null;
    return Array.from(new Set(v as string[]));
  };
  const levels = list(o.levels, 10), allow = list(o.allow, 500), deny = list(o.deny, 500);
  if (!levels || !allow || !deny) return null;
  return { levels, allow, deny };
}

/**
 * Checks one item's new grant set and turns it into share rows (by buyer
 * key, V17). Foreign access ids → 404 (never reveals another deal's links).
 */
export function validateShares(
  i: { dealId: string; item: VdrItem; isLedger: boolean; unchecked: ReadonlyArray<VdrFlagKey>; checkedFlags: ReadonlyArray<string>; accessRows: ReadonlyArray<BuyerAccess>; input: ShareInput; by: string; now: Date },
): { ok: true; rows: InsertVdrShare[]; tick: VdrFlagKey[] } | { ok: false; failure: ShareFailure } {
  const levels: string[] = [];
  for (const raw of i.input.levels) {
    const lvl = parseAccessLevelInput(raw);
    if (!lvl || !isRoomLevel(lvl)) return { ok: false, failure: { status: 400, body: { error: NOT_ROOM_BUYER } } };
    if (i.isLedger && lvl !== DD_ACCESS_LEVEL) return { ok: false, failure: { status: 409, body: { code: "ledger_dd_only", error: LEDGER_DD_ONLY } } };
    if (!levels.includes(lvl)) levels.push(lvl);
  }
  const byId = new Map(i.accessRows.filter((r) => r.dealId === i.dealId).map((r) => [r.id, r]));
  const rows: InsertVdrShare[] = levels.map((accessLevel) => ({ dealId: i.dealId, itemId: i.item.id, audience: "level", accessLevel, buyerEmail: null, effect: "allow", createdBy: i.by }));
  const seen = new Set<string>();
  for (const id of i.input.allow) {
    const r = byId.get(id);
    if (!r) return { ok: false, failure: { status: 404, body: { error: "Not found" } } };
    const why = roomIneligibleReason(r, i.now);
    if (why === "teaser" || why === "blind") return { ok: false, failure: { status: 400, body: { error: NOT_ROOM_BUYER } } };
    if (why === "nda") return { ok: false, failure: { status: 400, body: { error: `${r.buyerName || r.buyerEmail} hasn't signed the NDA yet.` } } };
    if (why) return { ok: false, failure: { status: 400, body: { error: `${r.buyerName || r.buyerEmail}'s link has ${why === "revoked" ? "been revoked" : "expired"}.` } } };
    if (i.isLedger && dataRoomLevelRule(r.accessLevel) !== "auto_on") return { ok: false, failure: { status: 409, body: { code: "ledger_dd_only", error: LEDGER_DD_ONLY } } };
    const key = buyerKey(r.buyerEmail);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ dealId: i.dealId, itemId: i.item.id, audience: "buyer", accessLevel: null, buyerEmail: key, viaAccessId: r.id, effect: "allow", createdBy: i.by });
  }
  const denied = new Set<string>();
  for (const id of i.input.deny) {
    const r = byId.get(id);
    if (!r) return { ok: false, failure: { status: 404, body: { error: "Not found" } } };
    const key = buyerKey(r.buyerEmail);
    if (seen.has(key)) return { ok: false, failure: { status: 400, body: { error: `${r.buyerName || r.buyerEmail} can't be both allowed and hidden.` } } };
    if (denied.has(key)) continue;
    denied.add(key);
    rows.push({ dealId: i.dealId, itemId: i.item.id, audience: "buyer", accessLevel: null, buyerEmail: key, viaAccessId: r.id, effect: "deny", createdBy: i.by });
  }
  const grants = rows.some((r) => r.effect === "allow");
  const missing = grants ? i.unchecked.filter((f) => !i.checkedFlags.includes(f)) : [];
  if (missing.length > 0) return { ok: false, failure: { status: 409, body: { code: "check_first", flags: missing, error: "Cimple couldn't check everything in this document. Tick \"I've checked it\" first." } } };
  return { ok: true, rows, tick: grants ? i.unchecked.filter((f) => i.checkedFlags.includes(f)) : [] };
}

/** The grant set an item has now, as a ShareInput (access ids picked from the buyer's best link). */
export function currentShareInput(shares: ReadonlyArray<VdrShare>, groups: ReadonlyArray<BuyerGroup>): ShareInput {
  const idFor = (key: string | null) => {
    const g = groups.find((x) => x.key === key);
    return (g?.eligible ?? g?.rows[0])?.id ?? null;
  };
  return {
    levels: shares.filter((s) => s.audience === "level" && s.effect === "allow" && s.accessLevel).map((s) => normalizeAccessLevel(s.accessLevel)),
    allow: shares.filter((s) => s.audience === "buyer" && s.effect === "allow").map((s) => idFor(s.buyerEmail)).filter((x): x is string => !!x),
    deny: shares.filter((s) => s.audience === "buyer" && s.effect === "deny").map((s) => idFor(s.buyerEmail)).filter((x): x is string => !!x),
  };
}

/** Who (by buyer key) can open an item under a grant set: room buyers allowed by level or by name, not hidden. */
export function readersOf(groups: ReadonlyArray<BuyerGroup>, shares: ReadonlyArray<Pick<VdrShare, "audience" | "accessLevel" | "buyerEmail" | "effect">>, isLedger: boolean): Set<string> {
  const out = new Set<string>();
  for (const g of groups) {
    if (!g.hasRoom || !g.eligible) continue;
    if (shares.some((s) => s.audience === "buyer" && s.effect === "deny" && s.buyerEmail === g.key)) continue;
    if (isLedger && dataRoomLevelRule(g.eligible.accessLevel) !== "auto_on") continue;
    const ok = shares.some((s) => s.effect === "allow" && ((s.audience === "buyer" && s.buyerEmail === g.key) || (s.audience === "level" && sameAccessLevel(s.accessLevel, g.eligible!.accessLevel))));
    if (ok) out.add(g.key);
  }
  return out;
}

export { DD_ACCESS_LEVEL };
