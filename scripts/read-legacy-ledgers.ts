/**
 * Reads general ledgers uploaded before "Add-backs in the books" existed
 * (gl spec §11, INTEGRATION §5 wave 3 step 3.4): documents filed as
 * subcategory "general_ledger" with no gl_ledgers row. A PDF/Word ledger is
 * listed but never read (it can't be matched entry by entry — the broker
 * asks for the Excel/CSV export).
 *
 * The file must be on this machine's UPLOADS_DIR (the Railway volume): run
 * --apply where the uploads live. No AI unless a key is set AND a layout is
 * unusual — run with ANTHROPIC_API_KEY=disabled and an unusual layout simply
 * waits for its columns ("needs columns" on the broker's panel).
 *
 * Dry run (default) lists what would be read:
 *   DATABASE_URL=… ANTHROPIC_API_KEY=disabled DISABLE_SCHEDULERS=1 npx tsx scripts/read-legacy-ledgers.ts [dealId …]
 * Read them:
 *   … npx tsx scripts/read-legacy-ledgers.ts --apply [dealId …]
 */
import fs from "node:fs";
import { db } from "../server/db";
import { documents, glLedgers } from "@shared/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { readAsLedger, glQueueIdle } from "../server/gl/ingest";
import { ledgerFileKind } from "../server/gl/read-file";
import { resolveDocumentPath } from "../server/documents/document-path";
import { glStore } from "../server/gl/store";

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const ids = args.filter((a) => !a.startsWith("--"));
  const rows = await db
    .select({ d: documents })
    .from(documents)
    .leftJoin(glLedgers, eq(glLedgers.documentId, documents.id))
    .where(and(eq(documents.subcategory, "general_ledger"), isNull(glLedgers.id), ...(ids.length ? [inArray(documents.dealId, ids)] : [])));
  let readable = 0;
  for (const { d } of rows) {
    const name = d.originalName || d.name;
    const kind = ledgerFileKind(name);
    const path = resolveDocumentPath(d as any);
    const present = !!path && fs.existsSync(path);
    const why = !kind ? "a PDF/Word ledger — not read (ask for the Excel/CSV export)" : !present ? "the file isn't on this machine's UPLOADS_DIR — run where the uploads live" : "will be read";
    console.log(`${d.dealId}  ${d.id}  "${name}"  ${d.visibility === "broker_only" ? "[private to the broker] " : ""}→ ${why}`);
    if (!kind || !present) continue;
    readable++;
    if (apply) {
      const ledger = await readAsLedger(d.id, d.uploadedBy === "seller" ? "seller" : "broker");
      await glQueueIdle();
      const after = ledger ? await glStore().getLedger(ledger.id) : null;
      console.log(`    → ${after?.status ?? "not read"}${after?.status === "ready" ? `, ${after.rowCount} entries` : after?.failure ? ` (${after.failure})` : ""}`);
    }
  }
  console.log(`${rows.length} unread ledger document(s); ${readable} readable here.${apply ? "" : " Re-run with --apply to read them."}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("read-legacy-ledgers failed:", err);
  process.exit(1);
});
