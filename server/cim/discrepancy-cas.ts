/**
 * Writes to a discrepancy row that an AI run decided on from an older copy.
 *
 * The financial analysis and the verification check read the deal's rows,
 * spend minutes in a model call, then refresh, re-raise or supersede rows
 * from that snapshot. Meanwhile the broker may have resolved a row or routed
 * it to the seller. A plain update then overturned that decision (a resolved
 * "Revenue 2024" row came back as superseded, so its resolution left the CIM
 * writer's RESOLVED block and the next run raised it again as a new open
 * critical).
 *
 * Every such write is conditional: it lands only while the row still has the
 * status the run saw (compare-and-set, one SQL statement in DbStorage). A row
 * whose status moved on is left exactly as the broker left it.
 */
import type { IStorage } from "../storage";
import type { Discrepancy, InsertDiscrepancy } from "@shared/schema";

export type DiscrepancyWriteStore = Pick<IStorage, "updateDiscrepancy"> &
  Partial<Pick<IStorage, "updateDiscrepancyIfStatus" | "getDiscrepancy">>;

/**
 * Updates the row only while its status is still one of `statuses`. Returns
 * the updated row, or undefined when the row is gone or moved on. A store
 * without the conditional write re-reads the row first; a bare test store
 * with neither falls back to the plain update.
 */
export async function updateDiscrepancyIfStill(
  store: DiscrepancyWriteStore,
  id: string,
  statuses: readonly string[],
  updates: Partial<InsertDiscrepancy>,
): Promise<Discrepancy | undefined> {
  if (typeof store.updateDiscrepancyIfStatus === "function") {
    return store.updateDiscrepancyIfStatus(id, statuses, updates);
  }
  if (typeof store.getDiscrepancy === "function") {
    const now = await store.getDiscrepancy(id);
    if (!now || !statuses.includes(now.status)) return undefined;
  }
  return store.updateDiscrepancy(id, updates);
}
