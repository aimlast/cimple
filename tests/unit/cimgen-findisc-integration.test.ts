/**
 * Integration contract between the financial analysis (findisc: owner pay
 * split into an above-market part + a SDE-only market salary; canonical
 * EBITDA / SDE computed in code) and the CIM writer's financials block
 * (cimgen: cim-financials, which DD enrichment and the figure check also
 * read). The CIM must show exactly the analysis's canonical figures — in
 * both metrics — and a DD writer must still get adjusted EBITDA and SDE.
 */
import assert from "node:assert/strict";
import { applyAddbackRules, computeCanonicalEarnings } from "../../server/financial/normalization-rules";
import { analysisHeadlines, buildCimFinancials, knownBridges, renderCimFinancialsBlock } from "../../server/cim/cim-financials";
import { buildDdContext } from "../../server/cim/dd-enrichment";
import type { UiNormalization } from "../../server/financial/shape";

const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

function normalization(metric: "sde" | "ebitda"): UiNormalization {
  const raw = {
    metric,
    years: ["2023", "2024"],
    netIncome: { "2023": 410000, "2024": 452000 },
    addbacks: [
      { id: "da", label: "Depreciation & amortization", category: "depreciation", type: "ebitda", approved: true, amounts: { "2023": 61000, "2024": 64000 } },
      { id: "int", label: "Interest expense", category: "interest", type: "ebitda", approved: true, amounts: { "2023": 22000, "2024": 19000 } },
      {
        id: "own", label: "Owner salary (T4 wages)", category: "owner_comp", type: "sde", approved: true,
        amounts: { "2023": 175000, "2024": 180000 },
        ownerActualComp: { "2023": 175000, "2024": 180000 }, marketSalary: 165000,
      },
      { id: "perk", label: "Owner's personal vehicle", category: "discretionary", type: "ebitda", approved: true, amounts: { "2023": 12000, "2024": 12500 } },
      { id: "no", label: "Legal fees (not approved)", category: "one_time", type: "ebitda", approved: false, amounts: { "2024": 30000 } },
    ],
    notes: [],
  } as unknown as UiNormalization;
  return applyAddbackRules(raw)!;
}

for (const metric of ["sde", "ebitda"] as const) {
  const n = normalization(metric);
  // findisc's split really happened: an excess line (ebitda) + a market line (sde).
  assert.ok(n.addbacks.some((a) => a.ownerCompPart === "market" && a.type === "sde"), `${metric}: market-salary line`);
  const canon = computeCanonicalEarnings(n)!;
  const fin = buildCimFinancials({ id: "fa", version: 3, status: "completed", brokerReviewedAt: null, normalization: n } as any)!;
  const b = fin.bridge!;
  const block = renderCimFinancialsBlock(fin);
  const heads = analysisHeadlines(fin);
  const bridges = knownBridges(fin);
  for (const y of ["2023", "2024"]) {
    if (metric === "ebitda") {
      assert.equal(b.adjusted[y], canon.adjustedEbitda[y], `ebitda ${y}: bridge total = canonical adjusted EBITDA`);
      assert.equal(b.sde![y], canon.sde[y], `ebitda ${y}: SDE = canonical SDE`);
    } else {
      assert.equal(b.adjusted[y], canon.sde[y], `sde ${y}: bridge total = canonical SDE`);
      assert.equal(b.adjustedEbitda![y], canon.adjustedEbitda[y], `sde ${y}: subtotal = canonical adjusted EBITDA`);
    }
    // The block states both canonical figures, so the writer copies instead of computing.
    assert.ok(block.includes(`${y} ${money(canon.adjustedEbitda[y])}`), `${metric} ${y}: adjusted EBITDA in the block`);
    assert.ok(block.includes(`${y} ${money(canon.sde[y])}`), `${metric} ${y}: SDE in the block`);
    // A waterfall ending at either figure is a known bridge total.
    const kb = bridges.find((x) => x.year === y)!;
    assert.ok(kb.totals.includes(canon.adjustedEbitda[y]) && kb.totals.includes(canon.sde[y]), `${metric} ${y}: both totals known to the figure check`);
  }
  assert.equal(heads.find((h) => h.label === "EBITDA")?.value, canon.adjustedEbitda["2024"], `${metric}: EBITDA headline = canonical`);
  assert.equal([...heads].reverse().find((h) => h.label === "SDE")?.value, canon.sde["2024"], `${metric}: SDE headline = canonical`);
  assert.ok(!/not approved/.test(block), `${metric}: unapproved add-backs never reach the CIM`);

  if (metric === "sde") {
    // The subtotal sits between the EBITDA add-backs and the SDE-only market salary.
    const lines = block.split("\n");
    const sub = lines.findIndex((l) => l.startsWith("= Adjusted EBITDA (subtotal"));
    const market = lines.findIndex((l) => /market salary/.test(l) && l.startsWith("+ "));
    const perk = lines.findIndex((l) => l.startsWith("+ Owner's personal vehicle"));
    assert.ok(perk >= 0 && sub > perk && market > sub, "sde: EBITDA lines, then the subtotal, then the SDE-only line");
  }

  // DD enrichment (findisc wanted the canonical earnings there; cimgen gives
  // it the computed block instead of the analyzer's raw JSON).
  const dd = buildDdContext({ extractedInfo: {}, financials: fin });
  assert.ok(dd.context.includes(money(canon.adjustedEbitda["2024"])), `${metric}: DD sees adjusted EBITDA`);
  assert.ok(dd.context.includes(money(canon.sde["2024"])), `${metric}: DD sees SDE`);
  assert.ok(!/"addbacks"|ownerCompPart/.test(dd.context), `${metric}: no raw normalization JSON in DD`);
}

// No split (no SDE-only lines): the SDE bridge is unchanged — no subtotal.
{
  const n = { metric: "sde", years: ["2024"], netIncome: { "2024": 100000 }, addbacks: [{ id: "a", label: "Depreciation", category: "depreciation", type: "ebitda", approved: true, amounts: { "2024": 5000 } }] } as any;
  const fin = buildCimFinancials({ id: "fa", version: 1, status: "completed", normalization: n } as any)!;
  assert.equal(fin.bridge!.adjustedEbitda, null);
  assert.ok(!/subtotal/.test(renderCimFinancialsBlock(fin)));
  assert.deepEqual(analysisHeadlines(fin).map((h) => h.label), ["SDE"]);
}

console.log("cimgen-findisc integration: ok");
