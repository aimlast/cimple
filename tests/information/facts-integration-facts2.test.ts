// Integration of facts1 (by-year structure, merge policy) with facts2 (the
// extraction guard): the guard reads the values as the model wrote them —
// including the model's byYear block — before the structure moves year
// figures onto maps; mergeExtractedData's own re-normalisation never
// re-guards (it has no source text); reprocess drops calculated years of a
// derived map but keeps the years the broker set.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/information/facts-integration-facts2.test.ts
import assert from "node:assert/strict";
import { normaliseExtraction, mergeExtractedData } from "../../server/documents/extractor";
import { guardExtraction, STATED_METRIC_NOTE } from "../../server/documents/extraction-guard";
import { overlayExistingFacts } from "../../server/documents/reprocess";
import { getFieldSources } from "../../server/interview/info-merger";

let n = 0;
const ok = (name: string) => { n++; console.log("✓", name); };

const STATEMENTS = `Statement of income, years ended December 31
                         2024        2023
Revenue             4,210,000   3,980,500
EBITDA                612,300     575,000
Net income            301,400     288,900`;

(async () => {
  // ── 1. The model's byYear block is guarded year by year ──
  {
    const out = normaliseExtraction({
      byYear: {
        revenue: { "2024": "$4,210,000", "2023": "$3,980,500" },
        ebitda: { "2024": "$612,300", "2023": "$575,000", "2022": "$540,000" }, // 2022 is not printed
        sde: { "2024": "$790,000" }, // the statements never say SDE
        netIncome: { "2024": "$301,400" },
      },
      periodEnd: "2024-12-31",
    }, STATEMENTS) as Record<string, unknown>;
    assert.deepEqual(out.ebitdaByYear, { "2024": "$612,300", "2023": "$575,000" }, "only the printed EBITDA years");
    assert.equal(out.ebitda, "$612,300", "the headline is the latest printed year");
    assert.equal(out.sdeByYear, undefined);
    assert.equal(out.sde, undefined);
    assert.deepEqual(out.revenueByYear, { "2024": "$4,210,000", "2023": "$3,980,500" });
    assert.equal(out._statedMetrics, "byYear.ebitda");
    // The fact says it was stated, on the map and on its headline.
    const merged = mergeExtractedData({}, out as any, { documentId: "fs-2024", source: "document" });
    assert.equal(getFieldSources(merged).ebitdaByYear?.note, STATED_METRIC_NOTE);
    assert.equal(getFieldSources(merged).ebitda?.note, STATED_METRIC_NOTE);
    assert.equal(merged._statedMetrics, undefined, "bookkeeping never becomes a fact");
  }
  ok("byYear block: printed EBITDA years kept and flagged, unprinted years and SDE dropped");

  // ── 2. A suffixed calculated metric never reaches a map through the structure ──
  {
    const out = normaliseExtraction({ ebitda2023: "$550,870 (calculated as income before taxes $470,679 + amortization $67,000 + interest $13,191)", netIncome2023: "$414,656" }, "Net income 414,656") as Record<string, unknown>;
    assert.equal(out.ebitdaByYear, undefined);
    assert.equal(out.ebitda, undefined);
    assert.deepEqual(out.netIncomeByYear, { "2023": "$414,656" });
  }
  ok("a calculated ebitda2023 is dropped before it can become an ebitdaByYear year");

  // ── 3. mergeExtractedData re-normalises without re-guarding (no source text there) ──
  {
    const guarded = normaliseExtraction({ sde: "$845,252" }, "Seller's discretionary earnings (SDE) 2024: $845,252");
    assert.equal(guarded.sde, "$845,252");
    const merged = mergeExtractedData({}, guarded, { documentId: "recast", source: "document" });
    assert.equal(merged.sde, "$845,252", "a stated SDE survives the merge");
    assert.equal(getFieldSources(merged).sde?.note, STATED_METRIC_NOTE);
    // Structure-only when no text is passed: facts1's contract.
    const structured = normaliseExtraction({ sde2024: "$690,000" }) as Record<string, unknown>;
    assert.deepEqual(structured.sdeByYear, { "2024": "$690,000" });
  }
  ok("merge keeps a guarded, stated SDE; one-argument normalise is structure only");

  // ── 4. Guarding an already structured (stored) extraction is idempotent ──
  {
    const first = normaliseExtraction({ byYear: { ebitda: { "2024": "$612,300" } }, netIncome: "$301,400" }, STATEMENTS);
    const again = normaliseExtraction(first as Record<string, unknown>, STATEMENTS);
    assert.deepEqual(again.ebitdaByYear, first.ebitdaByYear);
    assert.equal(again.ebitda, first.ebitda);
    assert.deepEqual(String(again._statedMetrics).split(",").sort(), ["ebitda", "ebitdaByYear"]);
    const noText = guardExtraction(first as Record<string, unknown>, null).data;
    assert.equal(noText.ebitdaByYear, undefined, "without text a stored EBITDA can't be checked");
    assert.equal(noText._statedMetrics, undefined, "stale bookkeeping isn't carried");
  }
  ok("a stored structured extraction replays through the guard unchanged");

  // ── 5. Reprocess: calculated years of a derived map go; the broker's year stays ──
  {
    const existing: Record<string, unknown> = {
      sdeByYear: { "2024": "$845,252", "2023": "$730,870", "2022": "$640,000" },
      _fieldSources: {
        sdeByYear: {
          source: "document", documentId: "fy24",
          years: {
            "2024": { source: "document", documentId: "fy24" },
            "2023": { source: "document", documentId: "fy24" },
            "2022": { source: "broker", at: "2026-09-20T00:00:00Z" },
          },
        },
      },
    };
    const fresh = mergeExtractedData({}, { netIncome: "$496,728" } as any, { documentId: "fy24", source: "document" });
    const rebuilt = overlayExistingFacts(fresh, existing);
    assert.deepEqual(rebuilt.sdeByYear, { "2022": "$640,000" }, "only the broker's year is left");
    assert.equal(getFieldSources(rebuilt).sdeByYear?.source, "broker");

    // All years from the rows → the map goes.
    const docOnly: Record<string, unknown> = {
      ebitdaByYear: { "2024": "$660,252" },
      _fieldSources: { ebitdaByYear: { source: "document", documentId: "fy24", years: { "2024": { source: "document", documentId: "fy24" } } } },
    };
    assert.equal(overlayExistingFacts(fresh, docOnly).ebitdaByYear, undefined);

    // The fresh extraction still yields a map: the rows' years it no longer yields go.
    const freshMap = mergeExtractedData({}, normaliseExtraction({ byYear: { ebitda: { "2024": "$612,300" } } }, STATEMENTS), { documentId: "fy24", source: "document" });
    const withOld: Record<string, unknown> = {
      ebitdaByYear: { "2024": "$612,300", "2021": "$480,000" },
      _fieldSources: { ebitdaByYear: { source: "document", documentId: "fy24", years: { "2024": { source: "document", documentId: "fy24" }, "2021": { source: "document", documentId: "fy24" } } } },
    };
    assert.deepEqual(overlayExistingFacts(freshMap, withOld).ebitdaByYear, { "2024": "$612,300" });
  }
  ok("reprocess: a derived map keeps only what the rows still print plus the broker's years");

  console.log(`\n${n} facts1 × facts2 integration checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
