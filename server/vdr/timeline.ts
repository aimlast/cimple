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
