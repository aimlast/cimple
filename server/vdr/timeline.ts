/**
 * The buyer profile's data-room events (vdr spec §9.4): read once per
 * profile for the buyer's links on the broker's deals. Never throws — the
 * timeline shows what it can.
 */
import type { BuyerAccess } from "@shared/schema";
import { dbVdrStore, type VdrStore } from "./store";
import { vdrTimelineEvents, type TimelineLike } from "./activity-report";

export async function vdrTimelineEventsFor(
  accesses: ReadonlyArray<Pick<BuyerAccess, "id" | "dealId" | "buyerEmail">>,
  fmtDuration: (seconds: number) => string,
  store: VdrStore = dbVdrStore,
): Promise<TimelineLike[]> {
  try {
    const dealIds = Array.from(new Set(accesses.map((a) => a.dealId))).slice(0, 50);
    const loaded = await Promise.all(
      dealIds.map(async (id) => {
        const room = await store.getRoom(id);
        if (!room) return null;
        const [views, activity, items] = await Promise.all([store.listViews(id), store.listActivity(id, 5000), store.listItems(id)]);
        return { views, activity, items };
      }),
    );
    const views = loaded.flatMap((l) => l?.views ?? []);
    const activity = loaded.flatMap((l) => l?.activity ?? []);
    const items = loaded.flatMap((l) => l?.items ?? []);
    return vdrTimelineEvents({ accesses, views, activity, items }, fmtDuration);
  } catch (err: any) {
    console.warn("[vdr] timeline events couldn't be read:", err?.message ?? err);
    return [];
  }
}

// ── For the analytics stream (vdr spec §11.4) ─────────────────────────────

/** Per buyer (email key), the last 7 days in the data room: the proposed "data_room_diligence" signal's inputs. Never throws. */
export async function vdrSignalsForDeal(dealId: string, now: Date = new Date(), store: VdrStore = dbVdrStore) {
  try {
    if (!(await store.getRoom(dealId))) return new Map();
    const [views, items, folders] = await Promise.all([store.listViews(dealId), store.listItems(dealId), store.listFolders(dealId)]);
    // The Financial preset folder and everything under it.
    const fin = new Set(folders.filter((f) => (f.presetKey ?? "").startsWith("financial")).map((f) => f.id));
    let grew = true;
    while (grew) {
      grew = false;
      for (const f of folders) if (f.parentId && fin.has(f.parentId) && !fin.has(f.id)) { fin.add(f.id); grew = true; }
    }
    const { vdrSignals } = await import("./activity-report");
    return vdrSignals(views, items, fin, now);
  } catch (err: any) {
    console.warn(`[vdr] signals couldn't be read for deal ${dealId}:`, err?.message ?? err);
    return new Map();
  }
}

/** One buyer's data-room events on one deal, oldest first (the journey drawer). Never throws. */
export async function vdrJourneyEvents(dealId: string, buyerEmail: string, store: VdrStore = dbVdrStore): Promise<TimelineLike[]> {
  const evs = await vdrTimelineEventsFor([{ id: "", dealId, buyerEmail }], (s) => (s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m` : s >= 60 ? `${Math.round(s / 60)} min` : `${s}s`), store);
  return evs.sort((a, b) => a.at.localeCompare(b.at));
}

/** Across a broker's deals: rooms, documents shared, buyers reading this week (the Analytics page). Never throws. */
export async function vdrBrokerTotals(dealIds: ReadonlyArray<string>, now: Date = new Date(), store: VdrStore = dbVdrStore): Promise<{ rooms: number; documentsShared: number; buyersReading7d: number; activeMs7d: number }> {
  const out = { rooms: 0, documentsShared: 0, buyersReading7d: 0, activeMs7d: 0 };
  try {
    const since = now.getTime() - 7 * 86_400_000;
    for (const id of dealIds.slice(0, 200)) {
      if (!(await store.getRoom(id))) continue;
      out.rooms++;
      const [shares, views] = await Promise.all([store.listShares(id), store.listViews(id)]);
      out.documentsShared += new Set(shares.filter((s) => s.effect === "allow").map((s) => s.itemId)).size;
      const recent = views.filter((v) => v.source !== "preview" && new Date(v.lastSeenAt).getTime() >= since);
      out.buyersReading7d += new Set(recent.map((v) => v.buyerEmail)).size;
      out.activeMs7d += recent.reduce((n, v) => n + (v.activeMs ?? 0), 0);
    }
  } catch (err: any) {
    console.warn("[vdr] broker totals couldn't be read:", err?.message ?? err);
  }
  return out;
}
