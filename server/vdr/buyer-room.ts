/**
 * What a buyer (or their team member, or the broker previewing a buyer)
 * receives from the data room (vdr spec §6, §9.3). Built by WHITELISTING:
 * titles, the room's numbers, size labels, new/updated badges, download
 * decisions — never a document's name on disk, its text, extraction, private
 * notes, red flags, flags or another buyer's anything.
 */
import type { VdrFolder, VdrView } from "@shared/schema";
import { sameAccessLevel } from "@shared/access-levels";
import {
  basicDescription,
  buyerDescriptionFor,
  fileSizeLabel,
  indexNumbers,
  isNewForBuyer,
  rollVisitStamps,
  visibleTree,
} from "@shared/vdr";
import type { BuyerItemAbout, BuyerRoomFolder, BuyerRoomItem, BuyerRoomPayload } from "@shared/vdr-api";
import { logVdrQuietly, type VdrStore } from "./store";
import { listedItems, type ReaderItem, type RoomSnapshot, type VdrGate } from "./access";
import { decisionFor, manifestFor } from "./serve";
import { buyerLog } from "./activity";

export type BuyerRoomDeps = {
  store: VdrStore;
  brand: (brokerId: string | null) => Promise<{ firmName: string | null; logoUrl: string | null }>;
  now: () => Date;
};

function numbered(snap: RoomSnapshot) {
  return indexNumbers(snap.folders, snap.items);
}

function byNumber(a: { number: string | null; title: string }, b: { number: string | null; title: string }) {
  return (a.number ?? "~").localeCompare(b.number ?? "~", undefined, { numeric: true }) || a.title.localeCompare(b.title);
}

/** The reader's grants on an item (allow by name, or by their level). */
function grantsFor(d: ReaderItem, gate: VdrGate) {
  return d.shares.filter((s) => s.effect === "allow" && ((s.audience === "buyer" && s.buyerEmail === gate.reader.buyerEmail) || (s.audience === "level" && sameAccessLevel(s.accessLevel, gate.reader.accessLevel))));
}

export function buyerItems(gate: VdrGate, snap: RoomSnapshot, decided: ReadonlyArray<ReaderItem>, views: ReadonlyArray<VdrView>, previousVisitAt: Date | null): BuyerRoomItem[] {
  const numbers = numbered(snap).items;
  const allowDownloads = !!gate.setting?.allowDownloads;
  const mine = views.filter((v) => v.buyerAccessId === gate.access.id || v.buyerEmail === gate.reader.buyerEmail);
  return listedItems(decided)
    .map((d) => {
      const opened = mine.some((v) => v.itemId === d.item.id && (v.teamMemberId ?? null) === (gate.viewer.teamMemberId ?? null));
      const openedEarlier = mine.some((v) => v.itemId === d.item.id && v.fileVersion < (d.item.fileVersion ?? 1));
      const badge = isNewForBuyer({ grants: grantsFor(d, gate).map((s) => ({ createdAt: s.createdAt })), previousVisitAt, fileChangedAt: d.item.fileChangedAt ?? null, openedEarlierVersion: openedEarlier });
      const ready = d.visibility.visible;
      const decision = decisionFor(d.item, d.item.prepared ?? null, allowDownloads);
      return {
        id: d.item.id,
        folderId: d.item.folderId,
        number: numbers.get(d.item.id) ?? null,
        title: d.item.title,
        sizeLabel: fileSizeLabel(d.item.prepared ?? null),
        ready,
        isNew: badge.isNew,
        isUpdated: badge.isUpdated,
        opened,
        download: { allowed: ready && decision.allowed, label: decision.allowed ? "Download" : "View only" },
      };
    })
    .sort(byNumber);
}

export function buyerFolders(snap: RoomSnapshot, items: ReadonlyArray<BuyerRoomItem>): BuyerRoomFolder[] {
  const numbers = numbered(snap).folders;
  const ids = new Set(items.map((i) => i.id));
  const tree = visibleTree(snap.folders, snap.items, ids);
  const byId = new Map<string, VdrFolder>(snap.folders.map((f) => [f.id, f]));
  const count = new Map<string, number>();
  for (const it of items) {
    let f = byId.get(it.folderId);
    const seen = new Set<string>();
    while (f && !seen.has(f.id)) {
      seen.add(f.id);
      count.set(f.id, (count.get(f.id) ?? 0) + 1);
      f = f.parentId ? byId.get(f.parentId) : undefined;
    }
  }
  return tree.folders
    .map((f) => ({ id: f.id, parentId: f.parentId && tree.folders.some((x) => x.id === f.parentId) ? f.parentId : null, name: f.name, number: numbers.get(f.id) ?? "", count: count.get(f.id) ?? 0 }))
    .sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));
}

/**
 * The room payload. Rolls the reader's visit stamps (a visit = a gap of
 * over 30 minutes) and logs `buyer_opened_room` once per visit — never for
 * the broker's preview.
 */
export async function buyerRoomPayload(
  deps: BuyerRoomDeps,
  gate: VdrGate,
  snap: RoomSnapshot,
  decided: ReadonlyArray<ReaderItem>,
  opts: { preview?: boolean; ipHash?: string | null } = {},
): Promise<BuyerRoomPayload> {
  const now = deps.now();
  let previousVisitAt: Date | null;
  if (opts.preview) {
    previousVisitAt = gate.member ? gate.member.previousVisitAt ?? null : gate.setting?.previousVisitAt ?? null;
  } else if (gate.member) {
    const r = rollVisitStamps({ lastVisitAt: gate.member.lastVisitAt ?? null, previousVisitAt: gate.member.previousVisitAt ?? null }, now);
    await deps.store.updateTeamMember(gate.member.id, { lastVisitAt: r.lastVisitAt, previousVisitAt: r.previousVisitAt });
    previousVisitAt = r.previousVisitAt;
    if (r.rolled) await logVdrQuietly(deps.store, buyerLog(gate, "buyer_opened_room", { ipHash: opts.ipHash ?? null }));
  } else {
    const r = rollVisitStamps({ lastVisitAt: gate.setting?.lastVisitAt ?? null, previousVisitAt: gate.setting?.previousVisitAt ?? null }, now);
    await deps.store.upsertBuyerSettings(gate.deal.id, gate.reader.buyerEmail, { lastVisitAt: r.lastVisitAt, previousVisitAt: r.previousVisitAt });
    previousVisitAt = r.previousVisitAt;
    if (r.rolled) await logVdrQuietly(deps.store, buyerLog(gate, "buyer_opened_room", { ipHash: opts.ipHash ?? null }));
  }
  const views = await deps.store.listViews(gate.deal.id);
  const items = buyerItems(gate, snap, decided, views, previousVisitAt);
  const folders = buyerFolders(snap, items);
  const brand = await deps.brand(gate.deal.brokerId ?? null).catch(() => ({ firmName: null, logoUrl: null }));
  const exp = gate.access.expiresAt ? new Date(gate.access.expiresAt).getTime() : null;
  return {
    reader: {
      kind: opts.preview ? "preview" : gate.viewer.kind,
      name: gate.viewer.name,
      email: gate.viewer.email,
      principalCompany: gate.member ? gate.access.buyerCompany || gate.access.buyerName || null : null,
    },
    deal: { name: gate.deal.businessName, firmName: brand.firmName, firmLogo: brand.logoUrl },
    folders,
    items,
    previousVisitAt: previousVisitAt ? new Date(previousVisitAt).toISOString() : null,
    expiresAt: exp ? new Date(exp).toISOString() : null,
    endsInDays: exp == null ? null : Math.max(0, Math.ceil((exp - now.getTime()) / 86_400_000)),
    newCount: items.filter((i) => i.isNew || i.isUpdated).length,
    allowDownloads: !!gate.setting?.allowDownloads,
  };
}

/** The About card + manifest for one item (the viewer's side panel). */
export function buyerItemAbout(gate: VdrGate, snap: RoomSnapshot, decided: ReadonlyArray<ReaderItem>, d: ReaderItem): BuyerItemAbout {
  const numbers = numbered(snap);
  const listed = listedItems(decided).map((x) => ({ id: x.item.id, number: numbers.items.get(x.item.id) ?? null, title: x.item.title })).sort(byNumber);
  const at = listed.findIndex((x) => x.id === d.item.id);
  const byId = new Map(snap.folders.map((f) => [f.id, f]));
  const trail: Array<{ id: string; number: string; name: string }> = [];
  let f = byId.get(d.item.folderId);
  const seen = new Set<string>();
  while (f && !seen.has(f.id)) {
    seen.add(f.id);
    trail.unshift({ id: f.id, number: numbers.folders.get(f.id) ?? "", name: f.name });
    f = f.parentId ? byId.get(f.parentId) : undefined;
  }
  const decision = decisionFor(d.item, d.item.prepared ?? null, !!gate.setting?.allowDownloads);
  const desc = buyerDescriptionFor(
    { buyerSummary: d.item.buyerSummary ?? null, buyerSummaryPoints: d.item.buyerSummaryPoints, buyerSummaryStatus: d.item.buyerSummaryStatus ?? null, buyerSummaryHidden: !!d.item.buyerSummaryHidden },
    basicDescription(d.doc, d.item.prepared ?? null),
  );
  return {
    id: d.item.id,
    number: numbers.items.get(d.item.id) ?? null,
    title: d.item.title,
    sizeLabel: fileSizeLabel(d.item.prepared ?? null),
    description: { text: desc.text, points: desc.points },
    manifest: manifestFor(d.item, d.doc, d.visibility.visible ? decision : { allowed: false, why: "not_ready" }, "buyer"),
    folderTrail: trail,
    prevId: at > 0 ? listed[at - 1].id : null,
    nextId: at >= 0 && at < listed.length - 1 ? listed[at + 1].id : null,
  };
}
