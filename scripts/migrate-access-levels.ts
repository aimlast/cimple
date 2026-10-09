/**
 * Access-level tidy-up (October 2026; post-deploy, optional — every reader
 * normalises, so nothing depends on it). Maps the legacy values to the level
 * they always meant: buyer_access / buyer_visits / deal_members
 *   teaser → blind, full → blind, loi → named        (shared/access-levels.ts)
 * No AI, no email. Module: server/migrations/access-levels-2026-10.ts.
 *
 * DRY RUN (default, read-only transaction): per-table counts, rows on deleted
 * deals, deals with locked sections (retired), sample rows; the planned
 * change list goes to scripts/out/access-levels-<time>.json.
 *   ANTHROPIC_API_KEY=disabled DATABASE_URL=… npx tsx scripts/migrate-access-levels.ts
 *
 * APPLY: one transaction (lock_timeout 5s, statement_timeout 60s,
 * pg_try_advisory_xact_lock — a second run at the same time changes nothing);
 * each table's RETURNING rows are the change record, written to
 * scripts/out/access-levels-applied-<time>.json. Then it re-checks: 0 left.
 *   … npx tsx scripts/migrate-access-levels.ts --apply
 *
 * PROOF MODE: --deal <id> limits every statement to one deal, and refuses
 * unless the deal belongs to qa_cimgen and is named "QA OCT — …".
 *
 * Undo: scripts/rollback-access-levels.ts (needs no change record — the
 * mapping back is total).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { sql } from "drizzle-orm";
import { db } from "../server/db";
import {
  KNOWN_LEVEL_VALUES, TIDY_TABLES, applyTidy, countsLine, proofDealCheck, readTidyPlan,
  type TidyDb, type TidyPlan,
} from "../server/migrations/access-levels-2026-10";

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "out");
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
const short = (id: string | null | undefined) => (id ? `${id.slice(0, 8)}…` : "—");

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : null;
}

function writeOut(name: string, data: unknown): string {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return path.relative(process.cwd(), file);
}

function printPlan(plan: TidyPlan, heading: string) {
  console.log(heading);
  for (const t of TIDY_TABLES) console.log(`  ${t.padEnd(14)} ${countsLine(plan.counts[t] ?? {})}`);
  console.log(`  total          ${plan.total}`);
}

async function context(scopeDeal: string | null) {
  // Read-only facts around the plan (nothing here writes).
  const rows = await (db as unknown as TidyDb).transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    const scope = scopeDeal ? sql` AND b.deal_id = ${scopeDeal}` : sql``;
    const onDeleted = await tx.execute(sql`
      SELECT b.access_level AS "level", count(*)::int AS n FROM buyer_access b
      WHERE NOT EXISTS (SELECT 1 FROM deals d WHERE d.id = b.deal_id)${scope}
      GROUP BY 1 ORDER BY 1`);
    const byValue: Record<string, unknown> = {};
    for (const t of TIDY_TABLES) {
      byValue[t] = await tx.execute(sql`
        SELECT coalesce(access_level, '(none)') AS "level", count(*)::int AS n FROM ${sql.identifier(t)} b
        WHERE true${scope} GROUP BY 1 ORDER BY 1`);
    }
    const locked = await tx.execute(sql`
      SELECT deal_id AS "dealId", count(*)::int AS n FROM cim_sections b
      WHERE access_tier = 'full'${scope} GROUP BY 1 ORDER BY 2 DESC`);
    return { onDeleted, byValue, locked };
  });
  return rows as {
    onDeleted: Array<{ level: string; n: number }>;
    byValue: Record<string, Array<{ level: string; n: number }>>;
    locked: Array<{ dealId: string; n: number }>;
  };
}

async function main() {
  const apply = process.argv.includes("--apply");
  const dealId = argValue("--deal");
  if (process.argv.includes("--deal") && !dealId) throw new Error("--deal needs a deal id");
  if (dealId) {
    const refusal = await proofDealCheck(db as unknown as TidyDb, dealId);
    if (refusal) {
      console.error(`Refused: ${refusal}`);
      process.exit(2);
    }
    console.log(`Proof mode: deal ${short(dealId)} only.`);
  }

  const plan = await readTidyPlan(db as unknown as TidyDb, { dealId });
  printPlan(plan, `Dry run${dealId ? " (one deal)" : ""} — legacy access levels to map:`);
  const ctx = await context(dealId);
  console.log("Values on file now:");
  for (const t of TIDY_TABLES) {
    const vals = ctx.byValue[t] ?? [];
    console.log(`  ${t.padEnd(14)} ${vals.length ? vals.map((v) => `${v.level} ${v.n}`).join(", ") : "no rows"}`);
    const odd = vals.filter((v) => v.level !== "(none)" && !KNOWN_LEVEL_VALUES.has(v.level));
    if (odd.length) console.log(`  ${"".padEnd(14)} ⚠ not a level (left as is; readers treat it as a Teaser link): ${odd.map((v) => v.level).join(", ")}`);
  }
  if (ctx.onDeleted.length) {
    console.log(`buyer_access rows on deleted deals (mapped too; harmless — scripts/cleanup-orphaned-deal-data.ts removes them): ${ctx.onDeleted.map((r) => `${r.level} ${r.n}`).join(", ")}`);
  }
  console.log(ctx.locked.length
    ? `Deals with "Full access only" sections (retired — their Blind CIM buyers now get those sections): ${ctx.locked.map((r) => `${short(r.dealId)} (${r.n})`).join(", ")}`
    : `Deals with "Full access only" sections (retired): none`);
  for (const t of TIDY_TABLES) {
    const sample = plan.changes.filter((c) => c.table === t).slice(0, 5);
    if (sample.length) console.log(`Sample ${t}: ${sample.map((c) => `${short(c.id)} deal ${short(c.dealId)} ${c.from}→${c.to}`).join(" · ")}`);
  }
  const planFile = writeOut(`access-levels-${stamp()}.json`, { at: new Date().toISOString(), scope: dealId ? { dealId } : "all", counts: plan.counts, total: plan.total, changes: plan.changes });
  console.log(`Plan written to ${planFile}`);

  if (!apply) {
    console.log("Dry run only — nothing changed. Run again with --apply to map them.");
    process.exit(0);
  }

  const result = await applyTidy(db as unknown as TidyDb, { dealId });
  const recordFile = writeOut(`access-levels-applied-${stamp()}.json`, { at: new Date().toISOString(), scope: dealId ? { dealId } : "all", counts: result.counts, total: result.total, changes: result.changes });
  printPlan(result, "Applied (one transaction) — change record:");
  console.log(`Change record written to ${recordFile}`);
  const after = await readTidyPlan(db as unknown as TidyDb, { dealId });
  console.log(after.total === 0 ? "Re-check: 0 legacy values left." : `⚠ Re-check: ${after.total} legacy values still on file (written after the run by an older server?) — run again.`);
  process.exit(0);
}

main().catch((err) => {
  // Never echo a connection string.
  console.error(String(err?.message || err).replace(/postgres(ql)?:\/\/[^\s"']+/g, "<DATABASE_URL>"));
  process.exit(1);
});
