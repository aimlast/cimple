/**
 * Demo set-up for "Add-backs in the books" (gl spec §11, founder question
 * F2 / INTEGRATION Q15 — RUN ONLY WITH THE FOUNDER'S YES; written, never run
 * on the founder's deals by the builder). Fictional deals only (a demo key
 * is required); no AI; no email.
 *
 * For a demo deal it builds a fictional general ledger that ties to the
 * deal's statements and holds the entries behind each approved add-back
 * (server/gl/demo-ledger.ts), plus a fictional T4 per person and year for
 * owner / related-party pay; reads the ledger like an upload; ticks the
 * entries as if the seller had confirmed them ("correct to the best of my
 * knowledge"); marks every add-back reviewed with Cimple's suggestion.
 * Showing it to buyers needs --publish (the publish dialog's defaults). It
 * refuses while the earnings bridge buyers read (the CIM's, or the kept copy
 * of a live CIM under an update) shows other add-backs or amounts — buyers
 * would read two different lists — unless --accept-older-bridge (the DD page
 * then opens with a notice; the Full/Blind note stays off). The fix: publish
 * the CIM update (or regenerate the bridge) first, then "Show to buyers…".
 *
 *   Dry run (default — writes nothing, prints the plan and the tie-out):
 *     DATABASE_URL=… ANTHROPIC_API_KEY=disabled DISABLE_SCHEDULERS=1 npx tsx scripts/seed-demo-gl.ts --deal <demoKey|dealId>
 *   Apply:      … --deal <…> --apply [--publish [--accept-older-bridge]]
 *   Remove:     … --deal <…> --remove [--apply]
 *
 * Files are written under UPLOADS_DIR/docs — run where the uploads live (the
 * Railway volume) so the data room can open them; the entries themselves are
 * in the database either way. Refuses a deal that already has general-ledger
 * documents not made by this script (unless --force), and a deal already
 * seeded (remove first).
 */
import fs from "node:fs";
import path from "node:path";
import { db } from "../server/db";
import { storage } from "../server/storage";
import { deals } from "@shared/schema";
import { eq } from "drizzle-orm";
import { DEMO_SEED_TAG, buildDemoLedger, type DemoTraceInput } from "../server/gl/demo-ledger";
import { statementsByYear, tieOutFor } from "../server/gl/tie-out";
import { analysisForTraces, refreshGl } from "../server/gl/service";
import { planTraces } from "../server/gl/traces";
import "../server/gl/map-columns-ai";
import "../server/gl/rank-ai";
import { glStore } from "../server/gl/store";
import { personsFor, recomputeTraces } from "../server/gl/match-run";
import { glQueueIdle } from "../server/gl/ingest";
import { onGlSupportDocumentRead } from "../server/gl/support-docs";
import { ownerNamesText } from "../server/gl/context";
import { newDocumentFileName } from "../server/documents/document-path";
import { uploadsRoot } from "../server/documents/document-path";
import { publishEvidence, publishPreview } from "../server/gl/evidence";
import { claimedYears } from "@shared/gl-reconcile";

type Args = { deal: string | null; apply: boolean; publish: boolean; remove: boolean; force: boolean; acceptOlderBridge: boolean };
function args(): Args {
  const a = process.argv.slice(2);
  const i = a.indexOf("--deal");
  return {
    deal: i >= 0 ? a[i + 1] ?? null : null, apply: a.includes("--apply"), publish: a.includes("--publish"), remove: a.includes("--remove"), force: a.includes("--force"),
    acceptOlderBridge: a.includes("--accept-older-bridge"),
  };
}

const seeded = (d: { sourceMeta?: unknown }) => (d.sourceMeta as { demoSeed?: string } | null)?.demoSeed === DEMO_SEED_TAG;
const dollars = (c: number) => `$${(c / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

async function main() {
  const o = args();
  if (!o.deal) throw new Error("Pass --deal <demo key or deal id>.");
  const byKey = await db.select().from(deals).where(eq(deals.demoKey, o.deal)).limit(2);
  if (byKey.length > 1) throw new Error(`More than one deal has the demo key "${o.deal}" — pass the deal's id instead.`);
  const deal = byKey[0] ?? (await storage.getDeal(o.deal));
  if (!deal) throw new Error(`No deal "${o.deal}".`);
  if (!deal.demoKey) throw new Error(`"${deal.businessName}" has no demo key — this script only touches fictional demo deals.`);
  console.log(`${deal.businessName} (${deal.id}, demo key ${deal.demoKey})`);
  const docs = await storage.getDocumentsByDeal(deal.id);
  const glDocs = docs.filter((d) => d.subcategory === "general_ledger" || d.subcategory === "addback_support");
  const mine = glDocs.filter(seeded);
  const others = glDocs.filter((d) => !seeded(d));

  if (o.remove) {
    console.log(`Seeded documents: ${mine.length} (${mine.map((d) => d.name).join(", ") || "none"})`);
    if (!o.apply) return console.log("Dry run — re-run with --remove --apply to delete them and reset the add-backs' review.");
    const { deleteDocumentAndProvenance } = await import("../server/documents/cleanup");
    for (const d of mine) await deleteDocumentAndProvenance(d.id);
    const store = glStore();
    for (const t of await store.listTraces(deal.id)) {
      await store.updateTrace(t.id, { sentAt: null, sellerStatus: "not_started", brokerVerdict: null, reviewedAt: null } as any);
    }
    await store.updateTracing(deal.id, { requestedAt: null, sellerDoneAt: null, sellerConfirmation: null, reviewedAt: null, published: null, publishedAt: null, publishedBy: null } as any);
    await refreshGl(deal.id, { force: true });
    return console.log(`Removed ${mine.length} document(s); the add-backs are back to "not requested".`);
  }

  if (mine.length > 0) throw new Error(`Already seeded (${mine.length} document(s)) — run with --remove --apply first.`);
  if (others.length > 0 && !o.force) throw new Error(`The deal already has ${others.length} general-ledger document(s) not made by this script (${others.map((d) => d.name).join(", ")}) — add --force to seed anyway.`);

  // What the analysis claims, keyed as the traces key it.
  const analysis = await analysisForTraces(deal.id);
  if (!analysis?.normalization) throw new Error("No financial analysis with add-backs on this deal.");
  const plan = planTraces(analysis.normalization, [], { info: (deal.extractedInfo as Record<string, unknown> | null) ?? null, country: null, analysisId: analysis.id });
  const statements = await statementsByYear(deal.id);
  const years = Object.keys(statements).filter((y) => statements[y].revenueCents != null && statements[y].netIncomeCents != null).sort();
  if (years.length === 0) throw new Error("The analysis has no statement revenue and net income to tie to.");
  const ownerText = ownerNamesText(deal);
  const traces: DemoTraceInput[] = plan.inserts.map((t) => {
    const persons = personsFor({ label: t.label, category: t.category ?? null, proof: t.proof } as any, ownerText);
    const person = persons[0] ? `${persons[0].first[0].toUpperCase()}${persons[0].first.slice(1)} ${persons[0].last[0].toUpperCase()}${persons[0].last.slice(1)}` : null;
    return { addbackKey: t.addbackKey, label: t.label, category: t.category ?? null, proof: t.proof ?? "ledger", sharePct: t.sharePct ?? null, claims: (t.claims as Record<string, number>) ?? {}, person };
  });
  // Read-only in a dry run (loadGlContext would create the deal's tracing row).
  const { fiscalYearEndFor } = await import("../server/gl/fiscal");
  const fye = (await glStore().getTracing(deal.id))?.fiscalYearEnd ?? fiscalYearEndFor(deal, docs);
  const ledger = buildDemoLedger({
    dealId: deal.id, business: deal.businessName, fye,
    years: years.map((y) => ({ year: y, revenueCents: statements[y].revenueCents!, netIncomeCents: statements[y].netIncomeCents! })),
    traces,
  });

  console.log(`Fiscal years ${years.join(", ")} (year ends ${fye}); ${ledger.rows.length} ledger entries; ${ledger.t4s.length} T4 document(s).`);
  for (const y of years) {
    const c = ledger.check[y];
    const st = statements[y];
    console.log(`  ${y}: revenue ${dollars(c.revenueCents)} (statements ${dollars(st.revenueCents!)}), net income ${dollars(c.netIncomeCents)} (statements ${dollars(st.netIncomeCents!)})`);
  }
  for (const t of traces) {
    const p = ledger.planted.filter((x) => x.addbackKey === t.addbackKey);
    const t4 = ledger.t4s.filter((x) => x.addbackKey === t.addbackKey);
    console.log(`  • ${t.label}: ${p.length ? p.map((x) => `${x.year} ${x.entries} entr${x.entries === 1 ? "y" : "ies"} on "${x.account}" = ${dollars(x.cents)}`).join("; ") : t4.length ? t4.map((x) => `${x.year} T4 for ${x.person} ${dollars(x.cents)}`).join("; ") : "nothing (no claim)"}`);
  }
  for (const p of ledger.problems) console.log(`  ! ${p}`);
  if (!o.apply) return console.log("Dry run — nothing was written. Re-run with --apply (and --publish to show it to buyers).");
  if (ledger.problems.length) throw new Error("The ledger can't tie to the statements — not applied.");

  // 1. The ledger file, read like a seller's upload.
  const dir = path.join(uploadsRoot(), "docs");
  fs.mkdirSync(dir, { recursive: true });
  const fileName = newDocumentFileName("doc", ".csv");
  fs.writeFileSync(path.join(dir, fileName), ledger.csv);
  const name = `General Ledger ${years[0]}–${years[years.length - 1]} (sample).csv`;
  const doc = await storage.createDocument({
    dealId: deal.id, uploadedBy: "seller", name, originalName: name, category: "financials", subcategory: "general_ledger",
    fileUrl: `/uploads/docs/${fileName}`, fileSize: Buffer.byteLength(ledger.csv), mimeType: "text/csv", status: "pending",
    sourceKind: "document", sourceMeta: { demoSeed: DEMO_SEED_TAG }, visibility: "shared",
  } as any);
  const { ingestDocument } = await import("../server/documents/ingest");
  await ingestDocument(doc.id);
  await glQueueIdle();
  const read = await glStore().getLedgerByDocument(doc.id);
  if (read?.status !== "ready") throw new Error(`The sample ledger didn't read (${read?.status ?? "no ledger"}${read?.failure ? `: ${read.failure}` : ""}).`);
  console.log(`Ledger read: ${read.rowCount} entries.`);
  await refreshGl(deal.id, { force: true });

  // 2. Seller-side work: T4s for pay, every proposed entry ticked, sent and confirmed.
  const store = glStore();
  const live = (await store.listTraces(deal.id)).filter((t) => !t.removedAt && t.includeInCim);
  const now = Date.now();
  for (const t4 of ledger.t4s) {
    const trace = live.find((t) => t.addbackKey === t4.addbackKey);
    if (!trace) continue;
    const f = newDocumentFileName("doc", ".txt");
    fs.writeFileSync(path.join(dir, f), t4.text);
    const n = `T4 ${t4.year} — ${t4.person} (sample).txt`;
    const sup = await storage.createDocument({
      dealId: deal.id, uploadedBy: "seller", name: n, originalName: n, category: "financials", subcategory: "addback_support",
      fileUrl: `/uploads/docs/${f}`, fileSize: Buffer.byteLength(t4.text), mimeType: "text/plain", status: "extracted", isProcessed: true,
      extractedText: t4.text, sourceKind: "document", sourceMeta: { demoSeed: DEMO_SEED_TAG, glTraceId: trace.id }, visibility: "shared",
    } as any);
    await store.upsertDocLink({ traceId: trace.id, dealId: deal.id, fiscalYear: t4.year, documentId: sup.id, amountCents: t4.cents, docAmountCheck: null, state: "confirmed", proposedBy: "seller_document", decidedBy: "seller", decidedByMember: null, decidedAt: new Date(now - 3 * 86400_000) } as any);
    await onGlSupportDocumentRead(sup.id);
  }
  for (const t of live.filter((x) => x.proof !== "statement" && x.proof !== "payroll")) {
    const years = claimedYears({ claims: (t.claims as Record<string, number>) ?? {} });
    const proposals = (await store.linksOfTrace(t.id)).filter((k) => k.state === "proposed" && k.ledgerId && years.includes(k.fiscalYear));
    if (proposals.length) {
      await store.decideEntryLinks(proposals.map((k) => ({ ...k, traceId: t.id, ledgerId: k.ledgerId!, rowNo: k.rowNo!, state: "confirmed" as const, decidedBy: "seller", decidedByMember: null, decidedAt: new Date(now - 3 * 86400_000) } as any)));
    }
  }
  for (const t of live.filter((x) => x.proof !== "statement")) await store.updateTrace(t.id, { sentAt: new Date(now - 6 * 86400_000), sellerStatus: "done" } as any);
  const owner = traces.find((t) => t.person)?.person ?? null;
  await store.updateTracing(deal.id, {
    requestedAt: new Date(now - 6 * 86400_000), sellerDoneAt: new Date(now - 2 * 86400_000),
    sellerConfirmation: { role: "owner", memberId: null, name: owner, at: new Date(now - 2 * 86400_000).toISOString() },
  } as any);
  await recomputeTraces(deal.id);
  await tieOutFor(deal.id);

  // 3. The broker's review: Cimple's suggestion for each.
  for (const t of (await store.listTraces(deal.id)).filter((x) => !x.removedAt && x.proof !== "statement")) {
    await store.updateTrace(t.id, { reviewedAt: new Date(now - 86400_000), brokerVerdict: (t.computed as any)?.suggestedVerdict ?? "not_found" } as any);
  }
  await store.updateTracing(deal.id, { reviewedAt: new Date(now - 86400_000) } as any);
  const after = await store.listTraces(deal.id);
  for (const t of after.filter((x) => !x.removedAt && x.proof !== "statement")) console.log(`  ✓ ${t.label}: ${t.brokerVerdict}`);
  const tie = ((await store.getTracing(deal.id))?.tieOut ?? {}) as Record<string, { state: string }>;
  console.log(`Tie-out: ${Object.entries(tie).map(([y, v]) => `${y} ${v.state}`).join(", ")}`);

  // 4. Buyers — only when asked.
  if (o.publish) {
    // The publish dialog's defaults, never more: the Full/Blind note stays off when the CIM's
    // earnings bridge shows other add-backs (a bridge from an earlier analysis) — regenerate it first.
    const p = await publishPreview(deal.id);
    if (!p.canPublish) {
      console.log(`Not shown to buyers: ${p.blocked}`);
      return;
    }
    for (const w of p.warnings) console.log(`  ! ${w}`);
    if (!p.versions.normal && p.reasons.normal) console.log(`  Full/Blind note: ${p.reasons.normal}`);
    const older = p.bridgeMismatch ?? p.keptBridgeMismatch;
    if (older && !o.acceptOlderBridge) {
      console.log(`Not shown to buyers: the earnings bridge buyers read ("${older}") shows other add-backs or amounts than the ones found in the books, so they would read two different lists.`);
      console.log(p.keptBridgeMismatch
        ? "  Publish the updated CIM first (CIM tab → Publish update), then Financials → Add-backs in the books → Show to buyers…"
        : "  Regenerate that section first, then Financials → Add-backs in the books → Show to buyers…");
      console.log("  (To show the due-diligence page anyway — it then opens by saying its amounts are the current ones — use Show to buyers…, or re-seed: --remove --apply, then --apply --publish --accept-older-bridge.)");
      console.log(`Done (not published). Undo with: --deal ${deal.id} --remove --apply`);
      return;
    }
    const r = await publishEvidence(deal.id, { versions: p.versions, leaveOut: [] }, null);
    console.log(`Shown to buyers: ${Object.entries(r.versions).filter(([, v]) => v).map(([k]) => k).join(", ")} (${r.lines} add-backs).`);
  } else {
    console.log("Not shown to buyers (add --publish, or use Financials → Add-backs in the books → Show to buyers…).");
  }
  console.log(`Done. Undo with: --deal ${deal.id} --remove --apply`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("seed-demo-gl:", err instanceof Error ? err.message : err);
  process.exit(1);
});
