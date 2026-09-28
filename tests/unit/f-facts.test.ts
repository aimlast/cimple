// FREE round, stream "facts" (f-facts): the facts pipeline's open items after
// round A, proved offline on recorded source text and recorded values.
//  known-1  statement EBITDA whose PDF text glues label and digits is kept
//           ("…income taxes1,398,0001,282,000") — the headline comes from the
//           statements, not the call, so no false "EBITDA FY2023" conflict.
//  known-2  a misread value is not "grounded" by glued table digits
//           ("589 inspections, 36 OOS" from "20225893615.5%8,420,000").
//  known-3  one customer's share and the top three's share are not one fact disputed.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/f-facts.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { guardExtraction, groundedInSource, ungluedGroupedFigures } from "../../server/documents/extraction-guard";
import { mergeExtractedData, normaliseExtraction } from "../../server/documents/extractor";
import { getFieldSources } from "../../server/interview/info-merger";
import { overlayExistingFacts } from "../../server/documents/reprocess";
import { concentrationMeasures, falseConflictReason } from "../../server/documents/conflict-measures";
import { dropReason } from "../../server/cim/discrepancy-filter";
import type { MergeConflict } from "../../server/documents/merge-policy";
import { finalizeNotes } from "../../server/documents/private-notes-review";
import { getPrivateNotes, privateNoteSources } from "../../server/interview/info-merger";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "f-facts");
const read = (f: string) => fs.readFileSync(path.join(FIX, f), "utf8");
const ok = (msg: string) => console.log(`✓ ${msg}`);

// ── known-1: glued statement columns ──────────────────────────────────────────
{
  // The FY2024 compiled statements' text as stored (fictional sample business).
  const FS24 = read("ridgeline-fy2024-statements.txt");
  assert.match(FS24, /Earnings before interest, amortization and income taxes1,398,0001,282,000/);
  assert.equal(ungluedGroupedFigures("taxes1,398,0001,282,000"), "taxes1,398,000 1,282,000");
  assert.equal(ungluedGroupedFigures("Cash642,130431,720"), "Cash642,130 431,720");
  assert.equal(ungluedGroupedFigures("35,72800"), "35,72800", "two CSV cells stay as they are");
  assert.equal(ungluedGroupedFigures("20225893615.5%8,420,000"), "20225893615.5%8,420,000", "bare glued digits can't be split");
  assert.equal(ungluedGroupedFigures("Revenue $1,234,567 in 2024"), "Revenue $1,234,567 in 2024");

  // The model's reading of that line (recorded: "ebitda $1,398,000", byYear 2024/2023).
  const raw = { ebitda: "$1,398,000", byYear: { ebitda: { "2024": "$1,398,000", "2023": "$1,282,000" } }, periodEnd: "2024-12-31", revenue: "$9,815,000" };
  const g = guardExtraction(raw, FS24, { document: true });
  assert.deepEqual(g.dropped.filter((d) => /ebitda/i.test(d.key)), [], `nothing EBITDA dropped: ${JSON.stringify(g.dropped)}`);
  assert.equal(g.data.ebitda, "$1,398,000");
  assert.ok(g.stated.includes("ebitda") && g.stated.includes("byYear.ebitda"));
  // A figure the statements don't print is still dropped.
  const worked = guardExtraction({ ebitda: "$1,710,000" }, FS24, { document: true });
  assert.equal(worked.data.ebitda, undefined, "an EBITDA the statements don't print is still dropped");
  // …and a figure that is only the glued run's middle ("398,0001") never counts.
  assert.equal(guardExtraction({ ebitda: "$398,000" }, FS24, { document: true }).data.ebitda, undefined);

  // End to end: the call (broker's line, attributed to the seller) says $1,398,000 for
  // FY2024; then the FY2024 statements are read. EBITDA is the statements'.
  let info: Record<string, unknown> = {};
  info = mergeExtractedData(info, normaliseExtraction({ ebitda: "$1,398,000", byYear: { ebitda: { "2024": "$1,398,000" } } }, "Morgan: EBITDA was one million three ninety-eight, $1,398,000, right? Gord: yes.", "call"),
    { documentId: "call", source: "call", dated: "2025-06-05" });
  const conflicts: MergeConflict[] = [];
  const stmts = normaliseExtraction(raw, FS24, "document");
  info = mergeExtractedData(info, stmts, { documentId: "fs24", source: "document", title: "Compiled financial statements FY2024", dated: "2025-03-28" }, { conflicts });
  const src = getFieldSources(info);
  assert.equal(src.ebitda?.documentId, "fs24", `the EBITDA headline is the statements' (was the call's): ${JSON.stringify(src.ebitda)}`);
  const years = (src.ebitdaByYear as any)?.years ?? {};
  assert.equal(years["2024"]?.documentId, "fs24", "FY2024 EBITDA is the statements'");
  assert.equal(years["2023"]?.documentId, "fs24", "FY2023 EBITDA is the statements'");
  assert.equal((info.ebitdaByYear as any)["2023"], "$1,282,000");
  // The call's FY2024 figure agrees with the statements' FY2024 — no conflict at all, and nothing pairs it with FY2023.
  assert.deepEqual(conflicts.filter((c) => /ebitda/i.test(c.factKey)), [], JSON.stringify(conflicts));
  // The pre-generation check's recorded row (Ridgeline clone, row 384ae074): the call's
  // FY2024 figure paired with the FY2023 statements, the model's own explanation saying
  // it is FY2024's — dropped as not a conflict (it blocked CIM generation).
  const recorded = { field: "EBITDA FY2023", factYear: "2023", interviewValue: "$1,398,000", documentValue: "$1,282,000", severity: "significant",
    aiExplanation: "The seller's figure appears to refer to FY2024 (which matches the FY2024 statements), not FY2023." };
  assert.equal(dropReason(recorded), "not_a_conflict");
  // A real disagreement for the disputed year still stands.
  assert.equal(dropReason({ ...recorded, aiExplanation: "The seller's figure for FY2023 does not match the FY2023 statements." }), null);
  assert.equal(dropReason({ ...recorded, aiExplanation: "It does not appear to refer to FY2024 either, which matches nothing on file." }), null);
  ok("known-1: statement EBITDA printed with glued columns is kept; the headline and both years are the statements'; no false FY2023 conflict (and the recorded false row is filtered)");
}

// ── known-2: glued table digits never ground a misread ───────────────────────
{
  const SAFETY = read("pacific-safety-summary.txt");
  assert.match(SAFETY, /\n20225893615\.5%8,420,000\n/);
  for (const [v, why] of [
    ["589 inspections, 36 out-of-service, 15.5% OOS rate", "2022 misread"],
    ["711 inspections, 25 driver OOS, 7 vehicle OOS, 16.9% OOS rate", "2023 misread"],
    ["646 inspections, 1 driver OOS, 5 vehicle OOS, 9.4% OOS rate", "2024 misread"],
  ] as const) assert.ok(!groundedInSource("roadsideInspectionsByYear", v, SAFETY), `not grounded: ${why}`);
  // What the source does print word for word stays grounded.
  assert.ok(groundedInSource("nscRating", "Satisfactory", SAFETY));
  assert.ok(groundedInSource("kmTravelled2022", "8,420,000 km", SAFETY) || groundedInSource("operationsNotes", "8,420,000 km travelled in 2022", SAFETY));

  // Replay of the recorded re-read (Pacific clone, safety PDF): the fresh read filed
  // cvsaInspectionsByYear 58/71/64; the misread roadsideInspectionsByYear years go.
  const existing: Record<string, unknown> = {
    roadsideInspectionsByYear: {
      "2022": "589 inspections, 36 out-of-service, 15.5% OOS rate",
      "2023": "711 inspections, 25 driver OOS, 7 vehicle OOS, 16.9% OOS rate",
      "2024": "646 inspections, 1 driver OOS, 5 vehicle OOS, 9.4% OOS rate",
    },
    _fieldSources: { roadsideInspectionsByYear: { source: "document", documentId: "safety", period: "2024-12-31" } },
  };
  let fresh: Record<string, unknown> = {};
  fresh = mergeExtractedData(fresh, { cvsaInspectionsByYear: { "2022": "58", "2023": "71", "2024": "64" } } as any, { documentId: "safety", source: "document" });
  const report = { dropped: [] as any[], kept: [] as any[] };
  const rebuilt = overlayExistingFacts(fresh, existing, {}, { rows: new Map([["safety", { text: SAFETY, kind: "document" as const }]]), report });
  assert.equal(rebuilt.roadsideInspectionsByYear, undefined, `the misread is gone: ${JSON.stringify(rebuilt.roadsideInspectionsByYear)}`);
  assert.equal(report.kept.length, 0, JSON.stringify(report.kept));
  assert.equal(report.dropped.length, 3);
  assert.deepEqual(rebuilt.cvsaInspectionsByYear, { "2022": "58", "2023": "71", "2024": "64" });
  ok("known-2: a re-read drops the glued-row misread (58|9|3|6 read as 589/36) instead of keeping it as 'stated'");
}

// ── known-3: one customer's share vs the top three's ─────────────────────────
{
  const iv = "Larkspur 18% of revenue";
  const dv = "Top 3 customers: 35.0% FY2022, 39.0% FY2023, 41.0% FY2024. Top 10 customers: 62.0% FY2024";
  assert.deepEqual(Array.from(concentrationMeasures(iv)), [1]);
  assert.deepEqual(Array.from(concentrationMeasures(dv)).sort((a, b) => a - b), [3, 10]);
  assert.ok(falseConflictReason("customerConcentration", { value: iv, kind: "video_call" }, { value: dv, kind: "document", title: "Customer concentration FY2022-FY2024" }));
  // The same slice disputed is still a conflict.
  assert.equal(falseConflictReason("customerConcentration", { value: "Top 3 customers about 25% of sales", kind: "call" }, { value: dv, kind: "document" }), null);
  assert.equal(falseConflictReason("customerConcentration", { value: "Largest customer is 30% of revenue", kind: "call" }, { value: "Largest customer (Larkspur) 18.0% of FY2024 revenue", kind: "document" }), null);
  // "Our three biggest clients are 60%" is a top-3 share.
  assert.deepEqual(Array.from(concentrationMeasures("Our three biggest clients are about 60% of sales")), [3]);
  // Another fact key is untouched.
  assert.equal(falseConflictReason("grossMargin", { value: "30%", kind: "call" }, { value: "top 3 lines 45%", kind: "document" }), null);
  ok("known-3: a single customer's share against the top-3 share raises no merge discrepancy; the same slice disputed still does");
}

// ── known-4: private notes — business facts and near-duplicates (recorded Ridgeline notes) ──
{
  const { info, docs: docList } = JSON.parse(read("ridgeline-notes-after-reprocess.json"));
  // The notes carry the clone's document ids; the rows are matched by name as the review does by id.
  const byName = new Map<string, any>(docList.map((d: any) => [d.name, d]));
  const docs = new Map<string, any>(docList.map((d: any) => [d.id, d]));
  for (const n of info._brokerPrivateNotes) for (const s of [n, ...(n.alsoFrom ?? [])]) {
    const d = s.documentId && byName.get(String(s.reason).replace(/^From /, ""));
    if (d) docs.set(s.documentId, { ...d, id: s.documentId });
  }
  assert.equal(info._brokerPrivateNotes.length, 27, "as recorded after the reprocess");
  const { info: out, report } = finalizeNotes(info, docs);
  const notes = getPrivateNotes(out);
  const texts = notes.map((n) => n.note);
  const has = (re: RegExp) => texts.some((t) => re.test(t));
  assert.ok(notes.length <= 19, `27 → ${notes.length}`);
  // Business facts the facts already hold, and no-notes, are gone.
  assert.ok(!has(/^Class D dividend of \$60,000/), "the dividend the minute book records as a fact");
  assert.ok(report.covered.some((c) => /Class D dividend/.test(c.note) && /dividend/i.test(c.key)), JSON.stringify(report.covered));
  assert.ok(!has(/^Minute book extract prepared June 2025/), "the minute book's own confidentiality stamp");
  assert.ok(!has(/^Broker's to-do list/), "the broker's to-do list");
  assert.ok(!has(/^Revenue and EBITDA figures to be confirmed/), "a TBC placeholder");
  assert.ok(!has(/^Backlog discrepancy to resolve/), "a discrepancy both of whose figures are on file");
  // Near-duplicates fold, every source's words kept.
  const kelowna = notes.filter((n) => /Kelowna/.test(n.note) || privateNoteSources(n).some((s) => /Kelowna/.test(s.wording ?? "")));
  assert.equal(kelowna.length, 1, "Kelowna / grandkids: one note");
  const luis = notes.filter((n) => /Luis Ortega/.test(n.note) && /roll/i.test(n.note));
  assert.equal(luis.length, 1, "Luis's equity rollover: one note");
  assert.match(luis[0].note, /consult with (?:his )?wife/);
  assert.match(luis[0].note, /rolling some or all of his 15%/);
  const lease = notes.filter((n) => /related party lease|lease is with holdco/i.test(n.note));
  assert.equal(lease.length, 1, "the related-party lease: one note");
  // Nothing sensitive is dropped.
  for (const re of [/cardiac episode/, /floor\/negotiation strategy/, /Only 3 people know about sale/, /seller financing/, /Coldbrook \$38,000/]) assert.ok(has(re), `kept: ${re}`);
  // Every source wording on file before is still on a note (or its note went as a whole).
  const gone = new Set([...report.chatter, ...report.covered].map((x) => x.note));
  for (const n of getPrivateNotes(info)) {
    if (gone.has(n.note)) continue;
    const all = notes.flatMap((m) => [m.note, ...privateNoteSources(m).map((s) => s.wording ?? "")]).join("\n");
    assert.ok(all.includes(n.note.slice(0, 40)) || privateNoteSources(n).some((s) => s.wording && all.includes(s.wording.slice(0, 40))), `kept: ${n.note.slice(0, 60)}`);
  }
  // Settles: a later review run folds at most once more (which names are
  // rare changes once twins fold — Luis's stake joins his rollover note), then nothing moves.
  const second = finalizeNotes(out, docs).info;
  const third = finalizeNotes(second, docs).info;
  assert.equal(JSON.stringify(third._brokerPrivateNotes), JSON.stringify(second._brokerPrivateNotes));
  const settled = getPrivateNotes(second).length;
  assert.ok(settled <= notes.length);
  ok(`known-4: Ridgeline's 27 private notes → ${notes.length} (→ ${settled} on the next review; dividend fact, stamp, to-do, TBC, settled discrepancy out; rollover, lease and Kelowna notes folded; nothing sensitive lost)`);
}

console.log("f-facts: all passed");
