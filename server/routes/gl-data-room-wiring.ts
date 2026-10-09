/**
 * gl × the data room (INTEGRATION §2.6, §6 step 7) — the integrator's one
 * composition point, so neither stream imports the other's internals:
 *
 *  1. gl → room: every ledger status change (read, needs columns, failed,
 *     deleted) re-prepares the ledger's room items (`onLedgerStatusChanged`,
 *     server/vdr/setup.ts), so a ledger leaves `ledger_pending` the moment gl
 *     has read it, and goes back to it when gl can't.
 *  2. room → gl: "ledger documents this buyer is kept from" — a data-room
 *     share row that hides the item from that buyer (audience buyer, effect
 *     deny) — for gl's due-diligence page, which then leaves out that file's
 *     entries for that buyer ("N more entries are available on request").
 *
 * The data room's own calls into gl (status, summary, rows for a buyer, the
 * heavy-sheet slot) go through server/vdr/gl-adapter.ts.
 */
import { buyerKey } from "@shared/vdr";

export interface DenyLookupDeps {
  getAccess: (accessId: string) => Promise<{ dealId: string; buyerEmail: string | null } | undefined>;
  listItems: (dealId: string) => Promise<Array<{ id: string; documentId: string | null; removedAt: Date | string | null }>>;
  listShares: (dealId: string) => Promise<Array<{ itemId: string; audience: string; buyerEmail: string | null; effect: string }>>;
}

/** The documents a buyer link is kept from in the deal's data room (its live items with a buyer deny row). */
export function ledgerDenyLookup(deps: DenyLookupDeps) {
  return async (dealId: string, accessId: string): Promise<ReadonlySet<string>> => {
    const access = await deps.getAccess(accessId);
    if (!access || access.dealId !== dealId) return new Set();
    const key = buyerKey(access.buyerEmail);
    if (!key) return new Set();
    const [items, shares] = await Promise.all([deps.listItems(dealId), deps.listShares(dealId)]);
    const denied = new Set(shares.filter((s) => s.audience === "buyer" && s.effect === "deny" && buyerKey(s.buyerEmail) === key).map((s) => s.itemId));
    const out = new Set<string>();
    for (const it of items) if (!it.removedAt && it.documentId && denied.has(it.id)) out.add(it.documentId);
    return out;
  };
}

let wired = false;

/** Once, at start-up (server/routes.ts, right after registerGlRoutes). */
export async function registerGlDataRoomWiring(): Promise<void> {
  if (wired) return;
  wired = true;
  const [{ onGlLedgerStatusChanged }, { setGlLedgerDenyLookup }, { onLedgerStatusChanged }, { dbVdrStore }, { storage }] = await Promise.all([
    import("../gl/events"),
    import("../gl/evidence"),
    import("../vdr/setup"),
    import("../vdr/store"),
    import("../storage"),
  ]);
  onGlLedgerStatusChanged((documentId) => onLedgerStatusChanged(documentId));
  setGlLedgerDenyLookup(
    ledgerDenyLookup({
      getAccess: async (id) => {
        const a = await storage.getBuyerAccess(id);
        return a ? { dealId: a.dealId, buyerEmail: a.buyerEmail ?? null } : undefined;
      },
      listItems: (dealId) => dbVdrStore.listItems(dealId),
      listShares: (dealId) => dbVdrStore.listShares(dealId),
    }),
  );
}
