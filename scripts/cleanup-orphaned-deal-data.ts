/**
 * One-off clean-up (second free round, security S4): rows and files left
 * behind by deals deleted before DELETE /api/deals/:id cascaded
 * (server/deals/delete-deal.ts). On 2026-09-28 production held 109
 * documents (with extracted text), 18 seller invites, 115 buyer links and
 * 12 interview sessions whose deal no longer exists. No AI calls.
 *
 * Dry run (default) counts what would go, per table (read-only):
 *   DATABASE_URL=… npx tsx scripts/cleanup-orphaned-deal-data.ts
 * Apply (deletes the orphaned rows, detaches the rest, and — when run where
 * UPLOADS_DIR is the real volume, i.e. inside the Railway container —
 * unlinks orphaned documents' files that no live row shares):
 *   DATABASE_URL=… UPLOADS_DIR=/data/uploads npx tsx scripts/cleanup-orphaned-deal-data.ts --apply
 */
import fs from "fs";
import { sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { db } from "../server/db";
import { DEAL_CHILD_TABLES, orphanedRowsWhere } from "../server/deals/delete-deal";
import { resolveDocumentPath } from "../server/documents/document-path";

async function main() {
  const apply = process.argv.includes("--apply");
  let total = 0;

  // Files first (the rows say where they are): orphaned documents whose file
  // no document of a live deal points at.
  const orphanFiles = (await db.execute(sql`
    SELECT DISTINCT d.file_url AS "fileUrl" FROM documents d
    WHERE NOT EXISTS (SELECT 1 FROM deals x WHERE x.id = d.deal_id)
      AND d.file_url IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM documents o JOIN deals x2 ON x2.id = o.deal_id WHERE o.file_url = d.file_url
      )`)) as unknown as Array<{ fileUrl: string }>;
  const paths = orphanFiles.map((r) => resolveDocumentPath({ fileUrl: r.fileUrl })).filter((p): p is string => !!p);
  const onDisk = paths.filter((p) => fs.existsSync(p));
  console.log(`documents' files: ${paths.length} orphaned, ${onDisk.length} present under ${process.env.UPLOADS_DIR || "(default uploads dir)"}`);

  // Tables in the database that carry a deal id but that neither the deal
  // delete nor this script knows about (a stream's table not yet listed in
  // DEAL_CHILD_TABLES): named so they are decided (delete or detach), never
  // touched here.
  const known = new Set(Object.values(DEAL_CHILD_TABLES).map((e) => getTableConfig(e.table as any).name));
  const withDealId = (await db.execute(sql`
    SELECT DISTINCT table_name AS "table" FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name IN ('deal_id', 'invited_by_deal')`)) as unknown as Array<{ table: string }>;
  const unlisted = withDealId.map((r) => r.table).filter((t) => t !== "deals" && !known.has(t)).sort();
  if (unlisted.length) console.log(`NOT COVERED (add to DEAL_CHILD_TABLES in server/deals/delete-deal.ts): ${unlisted.join(", ")}`);

  for (const [label, entry] of Object.entries(DEAL_CHILD_TABLES)) {
    const table = getTableConfig(entry.table as any).name;
    const column = (entry.column as any).name as string;
    const orphaned = orphanedRowsWhere(table, column);
    const rows = (await db.execute(sql`
      SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE ${orphaned}`)) as unknown as Array<{ n: number }>;
    const n = Number(rows[0]?.n ?? 0);
    if (n === 0) continue;
    total += n;
    const action = "field" in entry ? "detach" : "delete";
    console.log(`${label}: ${n} orphaned row(s) → ${action}`);
    if (!apply) continue;
    if ("field" in entry) {
      await db.execute(sql`UPDATE ${sql.identifier(table)} SET ${sql.identifier(column)} = NULL WHERE ${orphaned}`);
    } else {
      // Exactly the rows counted above (orphanedRowsWhere): a row with no
      // deal id at all is never removed.
      await db.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE ${orphaned}`);
    }
  }

  if (apply) {
    let removed = 0;
    for (const p of onDisk) {
      try { fs.unlinkSync(p); removed++; } catch { /* gone */ }
    }
    console.log(`applied: ${total} row(s), ${removed} file(s) removed`);
  } else {
    console.log(`dry run: ${total} row(s) would be removed or detached (pass --apply)`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
