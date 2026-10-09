/**
 * Who may open the data room, and which documents (vdr spec §9.3, §4.2).
 *
 * `vdrBuyerGate` runs first on every buyer and team route. It re-reads the
 * link, the room, the buyer's settings and (for a team member) the principal
 * buyer's best live link on EVERY request — nothing is cached (V10), so a
 * revoked link, a closed room or a level change takes effect on the very next
 * click. There is deliberately NO `isLive` check (V3): a buyer in due
 * diligence keeps the room when the CIM is taken offline.
 *
 * `readerItems` then decides each document with `itemVisibility` (the one
 * rule): hidden items are absent from the list, search and resolve, and any
 * direct request for one answers 404 "Not found" (never 403).
 *
 * Everything is deps-injected (pattern: uploads-gate.ts) for the unit and
 * route tests; `defaultGateDeps()` wires the database.
 */
import fs from "fs";
import { createHash } from "crypto";
import type { BuyerAccess, Deal, Document, VdrBuyerSettings, VdrFolder, VdrItem, VdrRoom, VdrShare, VdrTeamMember } from "@shared/schema";
import { cimModeForAccessLevel, normalizeAccessLevel } from "@shared/access-levels";
import {
  buyerKey,
  dataRoomLevelRule,
  hasRoomAccess,
  isLedgerDoc,
  itemFlags,
  itemVisibility,
  listedForReader,
  principalLinkFor,
  uncheckedLookFlags,
  type RoomAccessSetting,
  type VdrFlag,
  type VdrFlagKey,
  type Visibility,
} from "@shared/vdr";
import { dbVdrStore, type VdrStore } from "./store";
import { servedFilePath } from "./files";
import { isGlDocument } from "./gl-adapter";
import { uploadsRoot } from "../documents/document-path";

export class VdrHttpError extends Error {
  constructor(public readonly status: number, public readonly body: Record<string, unknown>) {
    super(String(body.error ?? body.code ?? status));
    this.name = "VdrHttpError";
  }
}

export const NOT_FOUND = () => new VdrHttpError(404, { error: "Not found" });

export type GateDeps = {
  store: VdrStore;
  accessByToken: (token: string) => Promise<BuyerAccess | undefined | null>;
  accessRowsForDeal: (dealId: string) => Promise<BuyerAccess[]>;
  getDeal: (id: string) => Promise<Deal | undefined | null>;
  now: () => Date;
  root: string;
};

export async function defaultGateDeps(): Promise<GateDeps> {
  const { storage } = await import("../storage");
  return {
    store: dbVdrStore,
    accessByToken: (t) => storage.getBuyerAccessByToken(t),
    accessRowsForDeal: (d) => storage.getBuyerAccessByDeal(d),
    getDeal: (id) => storage.getDeal(id),
    now: () => new Date(),
    root: uploadsRoot(),
  };
}

export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

export type VdrReader = { dealId: string; accessLevel: string; buyerEmail: string; mode: "normal" | "dd" };

export type VdrGate = {
  /** The principal buyer's link (also for a team member). */
  access: BuyerAccess;
  member: VdrTeamMember | null;
  deal: Deal;
  room: VdrRoom;
  setting: VdrBuyerSettings | null;
  mode: "normal" | "dd";
  reader: VdrReader;
  viewer: { kind: "buyer" | "team"; teamMemberId: string | null; name: string | null; email: string };
};

function viewLinkErr(access: BuyerAccess | null | undefined, now: Date): VdrHttpError | null {
  if (!access) return new VdrHttpError(404, { error: "Access denied or link expired" });
  if (access.revokedAt) return new VdrHttpError(403, { error: "Access has been revoked" });
  if (access.expiresAt && new Date(access.expiresAt).getTime() < now.getTime()) return new VdrHttpError(403, { error: "Link has expired" });
  return null;
}

/**
 * The gate (spec §9.3). Throws VdrHttpError. `allowNoAck` admits a team
 * member who hasn't acknowledged yet (only the room payload and POST
 * /acknowledge pass).
 */
export async function vdrBuyerGate(deps: GateDeps, token: string, opts: { allowNoAck?: boolean } = {}): Promise<VdrGate> {
  if (typeof token !== "string" || token.length < 8 || token.length > 200) throw new VdrHttpError(404, { error: "Access denied or link expired" });
  const now = deps.now();
  const access = (await deps.accessByToken(token)) ?? null;
  if (access) {
    const err = viewLinkErr(access, now);
    if (err) throw err;
    const deal = (await deps.getDeal(access.dealId)) ?? null;
    if (!deal) throw new VdrHttpError(404, { error: "Access denied or link expired" });
    return gateForLink(deps, { access, member: null, deal }, opts);
  }
  const member = await deps.store.teamMemberByTokenHash(tokenHash(token));
  if (!member || member.status !== "active") throw new VdrHttpError(404, { error: "Access denied or link expired" });
  const deal = (await deps.getDeal(member.dealId)) ?? null;
  if (!deal) throw new VdrHttpError(404, { error: "Access denied or link expired" });
  const settings = await deps.store.listBuyerSettings(deal.id);
  const principalSetting = settings.find((s) => s.buyerEmail === member.principalEmail) ?? null;
  const rows = (await deps.accessRowsForDeal(deal.id)).filter((r) => r.dealId === deal.id);
  const principal = principalLinkFor(rows, member.principalEmail, principalSetting?.roomAccess, now);
  if (!principal) {
    const company = rows.find((r) => buyerKey(r.buyerEmail) === member.principalEmail)?.buyerCompany || "The buyer";
    throw new VdrHttpError(403, { code: "team_ended", error: `${company}'s access to this data room has ended` });
  }
  return gateForLink(deps, { access: principal, member, deal }, opts);
}

/**
 * Steps 4–7 of the gate for a resolved link (a buyer's own, a team member's
 * principal, or the link the broker previews with "View as a buyer").
 */
export async function gateForLink(
  deps: Pick<GateDeps, "store" | "now">,
  i: { access: BuyerAccess; member: VdrTeamMember | null; deal: Deal },
  opts: { allowNoAck?: boolean } = {},
): Promise<VdrGate> {
  const { access, member, deal } = i;
  const linkErr = viewLinkErr(access, deps.now());
  if (linkErr) throw linkErr;
  if (!access.ndaSigned) throw new VdrHttpError(403, { code: "nda_required", error: "Sign the NDA to open the data room" });
  if (member && !member.ackAt && !opts.allowNoAck) throw new VdrHttpError(403, { code: "ack_required", error: "Please confirm before opening the data room" });
  const room = await deps.store.getRoom(deal.id);
  if (!room) throw new VdrHttpError(404, { code: "room_none", error: "The data room isn't open to you yet" });
  if (room.status === "closed") throw new VdrHttpError(403, { code: "room_closed", error: "The data room is closed" });
  const key = buyerKey(access.buyerEmail);
  const setting = (await deps.store.listBuyerSettings(deal.id)).find((s) => s.buyerEmail === key) ?? null;
  if (!hasRoomAccess(access.accessLevel, setting?.roomAccess as RoomAccessSetting | undefined)) {
    throw new VdrHttpError(403, { code: "no_room_access", teaser: dataRoomLevelRule(access.accessLevel) === "never_teaser", error: "The data room isn't open to you yet" });
  }
  const mode = cimModeForAccessLevel(access.accessLevel) === "dd" ? "dd" : "normal";
  return {
    access,
    member,
    deal,
    room,
    setting,
    mode,
    reader: { dealId: deal.id, accessLevel: normalizeAccessLevel(access.accessLevel), buyerEmail: key, mode },
    viewer: member
      ? { kind: "team", teamMemberId: member.id, name: member.ackName || member.name, email: member.email }
      : { kind: "buyer", teamMemberId: null, name: access.buyerName ?? null, email: access.buyerEmail },
  };
}

export type ReaderItem = { item: VdrItem; doc: Document | null; shares: VdrShare[]; visibility: Visibility; flags: VdrFlag[]; unchecked: VdrFlagKey[] };

/** Room material loaded once per request (no caching across requests, V10). */
export type RoomSnapshot = { folders: VdrFolder[]; items: VdrItem[]; shares: VdrShare[]; docs: Map<string, Document> };

export async function loadRoom(store: VdrStore, dealId: string): Promise<RoomSnapshot> {
  const [folders, items, shares, docs] = await Promise.all([store.listFolders(dealId), store.listItems(dealId), store.listShares(dealId), store.listDocuments(dealId)]);
  return { folders, items, shares, docs: new Map(docs.map((d) => [d.id, d])) };
}

export function isLedgerItemDoc(doc: Document | null): boolean {
  return !!doc && (isLedgerDoc(doc) || isGlDocument(doc));
}

/** An item's §4.9 flags and the needs-a-look ones not ticked for its current file. */
export function flagsFor(item: VdrItem, doc: Document | null, i: { privateMatters?: ReadonlyArray<string>; fileMissing: boolean; isLedger: boolean }): { flags: VdrFlag[]; unchecked: VdrFlagKey[] } {
  const flags = itemFlags(item.prepared ?? null, doc, { privateMatters: i.privateMatters ?? [], fileMissing: i.fileMissing, isLedger: i.isLedger });
  return { flags, unchecked: uncheckedLookFlags(flags, { checkedFlags: (item.checkedFlags as string[] | null) ?? null, checkedForFile: item.checkedForFile ?? null }, item.prepared ?? null) };
}

/**
 * Decides every live item for a reader (the one rule). `privateMatters`
 * (document id → what Cimple kept out of the CIM from it) feeds the
 * "Private matters" flag; a shared item with an unticked needs-a-look flag
 * is held back (`held_for_check`).
 */
export function decideItems(
  snap: RoomSnapshot,
  reader: VdrReader,
  root: string,
  opts: { privateMatters?: ReadonlyMap<string, string[]>; fileExists?: (p: string) => boolean } = {},
): ReaderItem[] {
  const fileExists = opts.fileExists ?? fs.existsSync;
  const out: ReaderItem[] = [];
  for (const item of snap.items) {
    if (item.removedAt) continue;
    const doc = item.documentId ? snap.docs.get(item.documentId) ?? null : null;
    const shares = snap.shares.filter((s) => s.itemId === item.id);
    const path = doc ? servedFilePath(item, doc, root) : null;
    const exists = !!path && fileExists(path);
    const isLedger = isLedgerItemDoc(doc);
    const { flags, unchecked } = flagsFor(item, doc, { privateMatters: doc ? opts.privateMatters?.get(doc.id) : [], fileMissing: !exists, isLedger });
    const visibility = itemVisibility({
      dealId: reader.dealId,
      reader,
      item: { dealId: item.dealId, removedAt: item.removedAt, prepared: item.prepared ?? null, isLedger },
      doc: doc ? { dealId: doc.dealId, visibility: doc.visibility ?? null, sourceKind: doc.sourceKind ?? null, category: doc.category ?? null, subcategory: doc.subcategory ?? null, fileUrl: doc.fileUrl ?? null } : null,
      servedFileExists: exists,
      shares,
      uncheckedFlags: unchecked.length,
    });
    out.push({ item, doc, shares, visibility, flags, unchecked });
  }
  return out;
}

/** The items a reader may see listed (visible, or being prepared). */
export function listedItems(decided: ReadonlyArray<ReaderItem>): ReaderItem[] {
  return decided.filter((d) => listedForReader(d.visibility));
}

/** One item for a reader, or a 404 (never 403: existence isn't revealed). */
export function itemFor(decided: ReadonlyArray<ReaderItem>, itemId: string, opts: { allowNotReady?: boolean } = {}): ReaderItem {
  const d = decided.find((x) => x.item.id === itemId);
  if (!d) throw NOT_FOUND();
  if (d.visibility.visible) return d;
  if (opts.allowNotReady && d.visibility.reason === "not_ready") return d;
  throw NOT_FOUND();
}

/** Item ids visible to a reader right now (Q&A's document scope, §9.9). */
export async function visibleItemIdsForReader(store: VdrStore, deal: Deal, reader: VdrReader, root: string = uploadsRoot()): Promise<Set<string>> {
  const snap = await loadRoom(store, reader.dealId);
  const { privateMattersByDocument } = await import("./analysis");
  const pm = privateMattersByDocument(deal, Array.from(snap.docs.keys()));
  return new Set(decideItems(snap, reader, root, { privateMatters: pm }).filter((d) => d.visibility.visible).map((d) => d.item.id));
}

/**
 * Room items one buyer link can open right now — the full gate (link live,
 * NDA, room open, the buyer's room access) and the one rule per item. Empty
 * when the gate refuses (a teaser or Blind CIM link, no room, closed…).
 * Used by the Q&A's document scope (§9.9). Never throws.
 */
export async function itemIdsVisibleToLink(
  deal: Deal,
  link: BuyerAccess,
  deps: Pick<GateDeps, "store" | "now" | "root"> = { store: dbVdrStore, now: () => new Date(), root: uploadsRoot() },
): Promise<Set<string>> {
  try {
    const gate = await gateForLink(deps, { access: link, member: null, deal });
    const { decided } = await decideForGate(deps, gate);
    return new Set(decided.filter((d) => d.visibility.visible).map((d) => d.item.id));
  } catch {
    return new Set();
  }
}

/** Everything a reader may see, decided once per request. */
export async function decideForGate(deps: Pick<GateDeps, "store" | "root">, gate: VdrGate, fileExists?: (p: string) => boolean): Promise<{ snap: RoomSnapshot; decided: ReaderItem[] }> {
  const snap = await loadRoom(deps.store, gate.deal.id);
  const { privateMattersByDocument } = await import("./analysis");
  const pm = privateMattersByDocument(gate.deal, snap.items.filter((i) => !i.removedAt && i.documentId).map((i) => i.documentId!));
  return { snap, decided: decideItems(snap, gate.reader, deps.root, { privateMatters: pm, fileExists }) };
}
