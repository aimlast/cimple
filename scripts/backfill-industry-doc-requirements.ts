/**
 * One-off backfill (free round 2, J5): adds the industry-specific document
 * requests existing deals never got. Deal creation looked up the New Deal
 * label ("Restaurant / Food Service") in a table keyed restaurant_food_service,
 * found nothing, and every deal got only the 12 universal rows. No AI calls;
 * existing rows (and anything the seller uploaded against them) are never
 * touched — only missing rows are added.
 *
 * Dry run (default) prints what would be added:
 *   DATABASE_URL=… ANTHROPIC_API_KEY=disabled npx tsx scripts/backfill-industry-doc-requirements.ts [dealId …]
 * Apply:
 *   DATABASE_URL=… ANTHROPIC_API_KEY=disabled npx tsx scripts/backfill-industry-doc-requirements.ts --apply [dealId …]
 * With no deal ids, every non-archived deal is checked.
 */
import { storage } from "../server/storage";
import { db } from "../server/db";
import { deals } from "@shared/schema";
import { isNull } from "drizzle-orm";
import { industryDocsKey, populateDocumentRequirements, requirementsForIndustry } from "../server/documents/requirements";

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const ids = args.filter((a) => !a.startsWith("--"));
  const rows = ids.length > 0
    ? (await Promise.all(ids.map((id) => storage.getDeal(id)))).filter((d): d is NonNullable<typeof d> => !!d)
    : await db.select().from(deals).where(isNull(deals.archivedAt));

  let total = 0;
  for (const deal of rows) {
    const key = industryDocsKey(deal.industry, deal.subIndustry);
    if (!key) continue;
    const existing = new Set((await storage.getDocumentRequirementsByDeal(deal.id)).map((r) => r.documentName));
    const missing = requirementsForIndustry(deal.industry, deal.subIndustry).filter((r) => !existing.has(r.documentName));
    if (missing.length === 0) continue;
    total += missing.length;
    console.log(`${deal.id}  ${deal.businessName} (${deal.industry} → ${key}): ${missing.length} to add — ${missing.map((m) => m.documentName).join("; ")}`);
    if (apply) {
      const added = await populateDocumentRequirements(deal.id, deal.industry, deal.subIndustry);
      console.log(`  added ${added}`);
    }
  }
  console.log(`${apply ? "Added" : "Would add"} ${total} row(s) across ${rows.length} deal(s) checked.${apply ? "" : " Re-run with --apply to write."}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
