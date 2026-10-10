/**
 * Do the sample-reading columns exist yet? (buyer_visits.demo_seed,
 * buyer_visits.superseded_by, cim_renditions.demo_seed — shared/schema.ts,
 * added by the heat-map release.)
 *
 * In production `db:push` runs before the server starts, so the answer is
 * always yes there. A local server on a branch against a database that
 * doesn't have them yet must still work: the reading queries then omit the
 * two filters, which is exactly equivalent — without the columns no visit
 * can be hidden or tagged as sample reading.
 *
 * One probe per process; a negative answer is re-probed at most every 60 s
 * (so a deploy that adds the columns is picked up without a restart). A
 * failed probe counts as "no" and is retried on the same schedule. No AI.
 */
import { sql } from "drizzle-orm";

const RETRY_NO_MS = 60_000;

let known: boolean | null = null;
let checkedAt = 0;
let inflight: Promise<boolean> | null = null;
let probe: () => Promise<boolean> = dbProbe;

async function dbProbe(): Promise<boolean> {
  const { db } = await import("../db");
  const rows = (await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND ((table_name = 'buyer_visits' AND column_name IN ('demo_seed', 'superseded_by'))
        OR (table_name = 'cim_renditions' AND column_name = 'demo_seed'))`)) as unknown as Array<{ n: unknown }>;
  return Number(rows?.[0]?.n ?? 0) === 3;
}

/** True once the three sample-reading columns exist (cached; see above). */
export async function sampleColumns(now: number = Date.now()): Promise<boolean> {
  if (known === true) return true;
  if (known === false && now - checkedAt < RETRY_NO_MS) return false;
  if (!inflight) {
    inflight = probe()
      .catch(() => false)
      .then((ok) => {
        known = ok;
        checkedAt = Date.now();
        inflight = null;
        return ok;
      });
  }
  return inflight;
}

/** Test hooks: force an answer (null = probe again), or swap the probe. */
export function _setSampleColumnsForTest(value: boolean | null, nextProbe?: () => Promise<boolean>): void {
  known = value;
  checkedAt = value === null ? 0 : Date.now();
  inflight = null;
  if (nextProbe) probe = nextProbe;
}

export function _resetSampleColumnsProbe(): void {
  known = null;
  checkedAt = 0;
  inflight = null;
  probe = dbProbe;
}
