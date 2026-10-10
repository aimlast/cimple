/**
 * Read-only report (gl spec §11): the old "Verify Addbacks" rows
 * (addback_verifications) the new "Add-backs in the books" replaces. Lists
 * each deal's row with its counts — add-backs, uploaded transactions,
 * seller questions — so the integrator can confirm nothing is lost before
 * the old table is retired. Writes nothing, calls no AI.
 *
 *   DATABASE_URL=… ANTHROPIC_API_KEY=disabled npx tsx scripts/report-legacy-addback-verifications.ts
 */
import { db } from "../server/db";
import { addbackVerifications, deals } from "@shared/schema";
import { eq } from "drizzle-orm";

async function main() {
  const rows = await db
    .select({ v: addbackVerifications, name: deals.businessName, archived: deals.archivedAt, demo: deals.demoKey })
    .from(addbackVerifications)
    .leftJoin(deals, eq(deals.id, addbackVerifications.dealId));
  let withWork = 0;
  for (const { v, name, archived, demo } of rows) {
    const r = v as unknown as Record<string, unknown>;
    const addbacks = Array.isArray(r.addbacks) ? (r.addbacks as unknown[]).length : 0;
    const txns = Array.isArray(r.uploadedTransactionData) ? (r.uploadedTransactionData as unknown[]).length : 0;
    const questions = Array.isArray(r.sellerQuestions) ? (r.sellerQuestions as unknown[]).length : 0;
    if (addbacks || txns || questions) withWork++;
    console.log(`${r.dealId}  ${name ?? "(deal deleted)"}${archived ? " [archived]" : ""}${demo ? " [demo]" : ""}  status=${r.status ?? "?"}  add-backs=${addbacks}  transactions=${txns}  questions=${questions}`);
  }
  console.log(`${rows.length} row(s); ${withWork} with any work in them. Nothing was written.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("report failed:", err);
  process.exit(1);
});
