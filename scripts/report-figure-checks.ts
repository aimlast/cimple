/**
 * report-figure-checks — READ-ONLY report of the DD figure layer, per deal
 * (dd spec §12). No writes (its own database connection is read-only), no AI.
 * There is no --apply: nothing here changes anything.
 *
 * For every deal with CIM sections and a financial analysis (or --deal <id>):
 *   - figures the CIM shows, per section (label AND value anchors, D3);
 *   - the checks against the tax returns and other records, by state;
 *   - "Fix first": CIM figures that disagree with their own statements (D9a);
 *   - figures Cimple couldn't find in their document's text (D11) — located
 *     here in memory, exactly as the refresh would, without storing anything;
 *   - worked-out notes (D6/D7), analysis hints matched (D8a);
 *   - the AI pass's candidates and its estimated cost (it is never run here).
 * --quiet prints counts only (no business names, no line labels, no text).
 *
 *   ANTHROPIC_API_KEY=disabled DATABASE_URL=… npx tsx scripts/report-figure-checks.ts [--deal <id>] [--quiet] [--limit 20]
 * DATABASE_URL comes from the environment (the local .env through the tools'
 * helpers) — never `railway run`, which would hand it the production AI key.
 */
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq, inArray, sql } from "drizzle-orm";
import * as schema from "../shared/schema";
import { anchorFigures } from "../shared/figure-anchors";
import { agrees } from "../shared/figure-compare";

/** A one-call AI pass reads ≤ 10 candidates (spec §9.8 prices). */
export function estimatedBuildCost(candidates: number): { calls: number; dollars: number } {
  if (candidates <= 0) return { calls: 0, dollars: 0 };
  const calls = Math.min(2, Math.ceil(candidates / 10));
  return { calls, dollars: calls === 1 ? 0.09 : 0.135 };
}

function rowsOf(r: unknown): any[] {
  if (Array.isArray(r)) return r;
  const rows = (r as { rows?: unknown })?.rows;
  return Array.isArray(rows) ? rows : [];
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const only = arg("--deal");
  const quiet = args.includes("--quiet");
  const limit = Number(arg("--limit") ?? 50);
  if (args.includes("--apply")) throw new Error("this report is read-only: there is no --apply");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");

  // Read-only at the server: any write would be refused by Postgres.
  const client = postgres(process.env.DATABASE_URL, { max: 2, connection: { default_transaction_read_only: "on" } as any });
  const ro = drizzle(client, { schema });
  const check = rowsOf(await ro.execute(sql`SHOW default_transaction_read_only`));
  if (String(check[0]?.default_transaction_read_only) !== "on") throw new Error("could not open a read-only connection — stopping");

  const { loadFigureRaw } = await import("../server/cim/figures/serve");
  const { buildChecks, mismatchMessage } = await import("../server/cim/figures/checks");
  const { locateValues } = await import("../server/cim/figures/locate");
  const { computedNotes } = await import("../server/cim/figures/computed");
  const { hintsFor } = await import("../server/cim/figures/hints");
  const { aiCandidates } = await import("../server/cim/figures/candidates");
  const { listDecisions } = await import("../server/cim/figures/store");

  const deals = rowsOf(await ro.execute(only
    ? sql`SELECT id, business_name FROM deals WHERE id = ${only}`
    : sql`SELECT d.id, d.business_name FROM deals d
           WHERE d.archived_at IS NULL
             AND EXISTS (SELECT 1 FROM cim_sections s WHERE s.deal_id = d.id)
             AND EXISTS (SELECT 1 FROM financial_analyses a WHERE a.deal_id = d.id)
           ORDER BY d.updated_at DESC LIMIT ${limit}`));
  if (deals.length === 0) console.log("No deal with CIM sections and a financial analysis.");

  let n = 0;
  for (const d of deals) {
    n++;
    const dealId = String(d.id);
    const title = quiet ? `Deal ${n} (${dealId.slice(0, 8)})` : `${d.business_name} (${dealId})`;
    console.log(`\n== ${title}`);
    const raw = await loadFigureRaw(dealId, ro);
    if (raw.noFigures) {
      console.log(raw.noFigures === "no_analysis" ? "  No completed financial analysis: nothing to check." : "  The financial analysis is out of date: run it again on the Financials tab.");
      continue;
    }
    const sections = rowsOf(await ro.execute(sql`SELECT id, section_title, layout_type, layout_data FROM cim_sections WHERE deal_id = ${dealId} AND is_visible IS NOT FALSE ORDER BY "order"`))
      .map((s) => ({ id: String(s.id), sectionTitle: String(s.section_title ?? ""), layoutType: String(s.layout_type), layoutData: s.layout_data }));
    const perSection = sections.map((s) => ({ s, anchors: anchorFigures(s, raw.registry) })).filter((x) => x.anchors.length > 0);
    const anchoredKeys = new Set(perSection.flatMap((x) => x.anchors.map((a) => a.figureKey)));
    console.log(`  Figures the CIM shows: ${anchoredKeys.size}, on ${perSection.length} of ${sections.length} sections`);
    if (!quiet) for (const x of perSection) console.log(`    · ${x.s.sectionTitle || x.s.layoutType}: ${x.anchors.length}`);

    // D11 in memory: locate what the stored state hasn't located yet (no write).
    const decisions = (await listDecisions(dealId, ro)).map((r) => ({
      checkKey: r.checkKey, state: r.state as "shown" | "left_out" | "corrected",
      correctedValue: r.correctedValue === null || r.correctedValue === undefined ? null : Number(r.correctedValue), valuesSnapshot: r.valuesSnapshot,
    }));
    const known = (raw.state?.located ?? {}) as Record<string, any>;
    const first = buildChecks({ registry: raw.registry, sources: raw.sources, located: known, decisions, figureKeys: anchoredKeys });
    const docIds = Array.from(new Set(first.toLocate.map((t) => t.documentId)));
    let located = known;
    if (docIds.length > 0) {
      const texts = await ro.select({ id: schema.documents.id, text: schema.documents.extractedText }).from(schema.documents)
        .where(and(eq(schema.documents.dealId, dealId), inArray(schema.documents.id, docIds)));
      const byId = new Map(texts.map((t) => [String(t.id), t.text as string | null]));
      located = { ...known, ...locateValues(first.toLocate, (id) => byId.get(id) ?? null, known) };
    }
    const checks = buildChecks({ registry: raw.registry, sources: raw.sources, located, decisions, figureKeys: anchoredKeys });
    const shown = checks.checks.filter((c) => !c.blank && anchoredKeys.has(c.figureKey) && c.kind !== "cim_statements");
    const by = { match: 0, regrouped: 0, differs: 0, needsChecking: 0, leftOut: 0 };
    for (const c of shown) {
      if (c.decision === "left_out") by.leftOut++;
      else if (!agrees(c.size) && !c.located) by.needsChecking++;
      else if (agrees(c.size)) by.match++;
      else if (c.regrouped) by.regrouped++;
      else by.differs++;
    }
    const others = raw.sources.filter((s) => s.kind !== "statements").length;
    console.log(others === 0
      ? "  No tax returns or other records on file to compare with."
      : `  Checks: ${shown.length} (match ${by.match} · grouped differently ${by.regrouped} · differ ${by.differs} · needs checking ${by.needsChecking} · left out ${by.leftOut})`);
    const fix = checks.mismatches.filter((w) => w.items.some((i) => anchoredKeys.has(i.figureKey)));
    if (fix.length > 0) {
      console.log(`  Fix first: ${fix.length} year(s) where the CIM differs from its statements`);
      for (const w of fix) console.log(quiet ? `    · FY${w.year}: ${w.items.length} figure(s)` : `    · ${mismatchMessage(w)}`);
    }
    const notLocated = checks.notLocated.filter((x) => anchoredKeys.has(x.figureKey));
    if (notLocated.length > 0) {
      console.log(`  Not found in the document's text (never shown until checked): ${notLocated.length}`);
      if (!quiet) for (const x of notLocated.slice(0, 10)) console.log(`    · ${x.figureKey}: $${Math.round(x.value).toLocaleString("en-US")} in the ${x.docWord}`);
    }
    const computed = computedNotes({ registry: raw.registry, checks: checks.checks, anchoredKeys });
    console.log(`  Worked-out notes: ${computed.length} (${computed.filter((c) => c.kind === "difference").length} differences, ${computed.filter((c) => c.kind === "movement").length} changes)`);
    if (!quiet) for (const c of computed.slice(0, 8)) console.log(`    · ${c.figureKey}: ${c.text}`);
    const hints = hintsFor(Array.from(anchoredKeys), raw.registry, raw.hintSentences);
    console.log(`  Analysis hints matched: ${Object.keys(hints).length}`);
    const candidates = aiCandidates({ registry: raw.registry, anchoredKeys, checks: checks.checks, notes: raw.notes, scope: "all", fingerprintFor: () => "report" });
    const cost = estimatedBuildCost(candidates.length);
    console.log(`  AI candidates: ${candidates.length} → ${cost.calls} call(s) ≈ $${cost.dollars.toFixed(2)} (+ ≈ $0.03 for the keep-out review if not cached) — never run by this report`);
    if (!quiet) for (const c of candidates.slice(0, 8)) console.log(`    · ${c.kind} ${c.lineLabel} FY${c.year}`);
    const stored = raw.notes.length;
    if (stored > 0) console.log(`  Notes on file: ${stored} (${raw.notes.filter((x) => x.status === "approved").length} shown to buyers, ${raw.notes.filter((x) => x.status === "suggested").length} waiting)`);
  }
  await client.end({ timeout: 5 });
}

if (process.argv[1] && /report-figure-checks/.test(process.argv[1])) {
  main().then(() => process.exit(0), (err) => { console.error(err?.message ?? err); process.exit(1); });
}
