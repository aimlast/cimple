/**
 * One-off backfill (QA-harvest facts1): stamps every fact source that points
 * at a documents row with that row's visibility (FieldSource.brokerOnly) and
 * upgrades older bare-id per-year entries (revenueByYear.years) to full
 * per-year sources, so the CIM writers, the deal list and the seller view
 * can tell a broker-only CRM year from a statement year on deals ingested
 * before the stamp existed. No AI calls; values are never changed.
 *
 * Dry run (default) prints what would change:
 *   DATABASE_URL=… npx tsx scripts/backfill-fact-stamps.ts [dealId …]
 * Apply:
 *   DATABASE_URL=… npx tsx scripts/backfill-fact-stamps.ts --apply [dealId …]
 * With no deal ids, every deal is checked.
 *
 * A full reprocess (POST /api/deals/:id/documents/reprocess) does this too,
 * and also re-reads every source with the current merge rules.
 */
import { storage } from "../server/storage";
import { withDealFactsLock } from "../server/documents/facts-lock";
import { stampSourceDetails } from "../server/documents/merge-policy";
import { db } from "../server/db";
import { deals } from "@shared/schema";

/** JSON with sorted keys — Postgres jsonb reorders keys, so a plain stringify would see changes that aren't. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const ids = args.filter((a) => !a.startsWith("--"));
  const targets = ids.length > 0 ? ids : (await db.select({ id: deals.id }).from(deals)).map((d) => d.id);
  let changed = 0;
  for (const id of targets) {
    await withDealFactsLock(id, async () => {
      const deal = await storage.getDeal(id);
      if (!deal?.extractedInfo) return;
      const info = deal.extractedInfo as Record<string, unknown>;
      const stamped = stampSourceDetails(info, await storage.getDocumentsByDeal(id));
      if (stable(stamped) === stable(info)) return;
      changed++;
      console.log(`${apply ? "stamped" : "would stamp"} ${id} (${deal.businessName})`);
      if (apply) await storage.updateDeal(id, { extractedInfo: stamped } as any);
    });
  }
  console.log(`${changed} of ${targets.length} deal(s) ${apply ? "updated" : "would change"}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
