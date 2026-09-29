/**
 * One-off backfill (free round 2, J5): adds the industry-specific document
 * requests existing deals never got. Deal creation looked up the New Deal
 * label ("Restaurant / Food Service") in a table keyed restaurant_food_service,
 * found nothing, and every deal got only the 12 universal rows. No AI calls;
 * existing rows (and anything the seller uploaded against them) are never
 * touched — only missing rows are added.
 *
 * A request for a document the deal already holds (a shared, readable
 * document whose name the request matches — the upload rule) is added as
 * received and credited to that document, never as "missing"
 * (planDocumentRequirements; release review DEP-3). The dry run lists each.
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
import { industryDocsKey, planDocumentRequirements, populateDocumentRequirements } from "../server/documents/requirements";

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const ids = args.filter((a) => !a.startsWith("--"));
  const rows = ids.length > 0
    ? (await Promise.all(ids.map((id) => storage.getDeal(id)))).filter((d): d is NonNullable<typeof d> => !!d)
    : await db.select().from(deals).where(isNull(deals.archivedAt));

  let total = 0;
  let onFile = 0;
  for (const deal of rows) {
    const key = industryDocsKey(deal.industry, deal.subIndustry);
    if (!key) continue;
    const plan = planDocumentRequirements(
      await storage.getDocumentRequirementsByDeal(deal.id),
      await storage.getDocumentsByDeal(deal.id),
      deal.industry,
      deal.subIndustry,
    );
    if (plan.length === 0) continue;
    total += plan.length;
    const held = plan.filter((p) => p.heldBy);
    onFile += held.length;
    console.log(`${deal.id}  ${deal.businessName} (${deal.industry} → ${key}): ${plan.length} to add — ${plan.map((p) => p.doc.documentName).join("; ")}`);
    for (const p of held) console.log(`    already on file → "${p.doc.documentName}" credited to "${p.heldBy!.name}"`);
    if (apply) {
      const added = await populateDocumentRequirements(deal.id, deal.industry, deal.subIndustry);
      console.log(`  added ${added}`);
    }
  }
  console.log(`${apply ? "Added" : "Would add"} ${total} row(s) across ${rows.length} deal(s) checked — ${onFile} of them already on file (added as received).${apply ? "" : " Re-run with --apply to write."}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
