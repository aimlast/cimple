/**
 * Release review UX-F14: checklist rows credited to a source the current
 * rules would never credit (server/documents/requirements.ts
 * wrongChecklistCredits) — an e-mail / call / CRM record ("Tax Returns (3
 * Years) — Email - RE: Document request …", whose subject the seller saw),
 * or a document the row's own name never matches ("Bank Statements (3
 * Months) — Compiled financial statements FY2023"). Written by older code.
 *
 * Dry run (default) lists every such row, why, and what it would hold after
 * (another source on the deal that IS the document, else "missing"):
 *   DATABASE_URL=… ANTHROPIC_API_KEY=disabled npx tsx scripts/repair-checklist-credits.ts [--deal <id> …]
 * Apply (one transaction per deal; the change record is printed):
 *   … --apply                          e-mail / call / CRM credits only
 *   … --apply --include-name-mismatch  also documents the row's name never matches —
 *                                      on demo deals only, unless --allow-real (a broker may
 *                                      have linked a file by hand)
 * The general-ledger row is never touched. No AI, no email.
 */
import { and, eq } from "drizzle-orm";
import { db } from "../server/db";
import { storage } from "../server/storage";
import { deals, dealDocumentRequirements } from "@shared/schema";
import { wrongChecklistCredits } from "../server/documents/requirements";

function parseArgs(argv: string[]) {
  const a = { deals: [] as string[], apply: false, includeNameMismatch: false, allowReal: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--deal" && argv[i + 1]) a.deals.push(argv[++i]);
    else if (argv[i] === "--apply") a.apply = true;
    else if (argv[i] === "--include-name-mismatch") a.includeNameMismatch = true;
    else if (argv[i] === "--allow-real") a.allowReal = true;
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const list = args.deals.length
    ? (await Promise.all(args.deals.map((id) => storage.getDeal(id)))).filter((d): d is NonNullable<typeof d> => !!d)
    : await db.select().from(deals);
  let found = 0;
  let changed = 0;
  for (const deal of list) {
    const rows = await storage.getDocumentRequirementsByDeal(deal.id);
    if (!rows.some((r) => r.uploadedFileId)) continue;
    const docs = await storage.getDocumentsByDeal(deal.id);
    const nameMismatch = args.includeNameMismatch && (!!deal.demoKey || args.allowReal);
    const wrong = wrongChecklistCredits(rows as any[], docs as any[], { includeNameMismatch: nameMismatch });
    if (wrong.length === 0) continue;
    found += wrong.length;
    console.log(`${deal.id}  ${deal.businessName}${deal.demoKey ? " (demo)" : ""}`);
    for (const w of wrong) {
      const fix = w.reason === "not_a_document" || nameMismatch;
      console.log(`    "${w.row.documentName}" ← "${w.doc.name}" [${w.reason === "not_a_document" ? `${w.doc.sourceKind}, not a document` : "the row's name never matches it"}] → ${fix ? (w.replacement ? `credited to "${w.replacement.name}"` : "missing") : "kept (pass --include-name-mismatch)"}`);
    }
    if (!args.apply) continue;
    const toFix = wrong.filter((w) => w.reason === "not_a_document" || nameMismatch);
    if (toFix.length === 0) continue;
    await db.transaction(async (tx) => {
      for (const w of toFix) {
        const r = w.replacement;
        await tx.update(dealDocumentRequirements).set(r
          ? { status: "uploaded", uploadedFileId: r.id, uploadedBy: (r as any).uploadedBy === "seller" ? "seller" : "broker", uploadedAt: r.createdAt ? new Date(r.createdAt as any) : new Date(), updatedAt: new Date() } as any
          : { status: "missing", uploadedFileId: null, uploadedBy: null, uploadedAt: null, updatedAt: new Date() } as any)
          .where(and(eq(dealDocumentRequirements.id, w.row.id), eq(dealDocumentRequirements.uploadedFileId, w.doc.id)));
      }
    });
    changed += toFix.length;
    console.log(`    applied ${toFix.length}: ${JSON.stringify(toFix.map((w) => ({ row: w.row.id, from: w.doc.id, to: w.replacement?.id ?? null })))}`);
  }
  console.log(`${found} credit(s) found across ${list.length} deal(s)${args.apply ? `; ${changed} repaired` : " — dry run, nothing written (--apply to write)"}.`);
  process.exit(0);
}

if (process.argv[1] && /repair-checklist-credits/.test(process.argv[1])) {
  main().catch((err) => { console.error(err?.message ?? err); process.exit(1); });
}
