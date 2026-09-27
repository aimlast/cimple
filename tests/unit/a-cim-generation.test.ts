/**
 * Round A (a-cim): a whole generation with a scripted model (no paid call)
 * that writes the Pacific acceptance run's sections exactly as recorded —
 * including on the rewrite. The Working Capital section must still reach
 * the broker on the peg's basis (rebuilt from the analysis in code), the
 * true customer ranks must pass, and every other recorded slip must be named.
 */
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildCimFinancials } from "../../server/cim/cim-financials";
import { generateCimLayout, _setAnthropicForTests } from "../../server/cim/layout-engine";
import { resolvedNotes } from "../../server/cim/resolved-block";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "cim");
const read = (f: string) => JSON.parse(fs.readFileSync(path.join(FIX, f), "utf8"));
const facts = read("pacific-acc2-facts.json");
const analysis = read("pacific-acc2-analysis.json");
const recorded: Array<{ sectionKey: string; sectionTitle: string; order: number; layoutType: string; layoutData: any }> = read("pacific-acc2-sections.json");
const resolved = read("pacific-acc2-resolved.json");
const pick = ["Working Capital", "Key Customer Relationships", "Safety & Compliance", "Transaction Structure", "Financial Summary"];
const planned = recorded.filter((s) => pick.includes(s.sectionTitle));

const bodies: any[] = [];
_setAnthropicForTests(
  {
    messages: {
      stream: (body: any) => ({
        finalMessage: async () => {
          bodies.push(body);
          if (body.tools[0].name === "cim_manifest") {
            return { stop_reason: "tool_use", content: [{ type: "tool_use", name: "cim_manifest", input: { sections: planned.map((s, i) => ({ sectionKey: s.sectionKey, sectionTitle: s.sectionTitle, order: i + 1, layoutType: s.layoutType, tags: [], aiLayoutReasoning: "r", contentBrief: s.sectionTitle })) } }] };
          }
          // Every write — first and rewrite — returns what the live model wrote.
          const text = JSON.stringify(body.messages);
          const s = planned.find((p) => text.includes(`"${p.sectionTitle}"`) || text.includes(p.sectionTitle)) ?? planned[0];
          return { stop_reason: "tool_use", content: [{ type: "tool_use", name: "cim_section", input: { layoutData: s.layoutData } }] };
        },
      }),
    },
  },
  1,
);

const doc = await generateCimLayout({
  dealId: "d",
  businessName: "Pacific Coast Logistics Ltd.",
  industry: "Transportation & Logistics",
  askingPrice: "$18,000,000",
  extractedInfo: facts,
  resolvedDiscrepancies: resolvedNotes(resolved),
  financials: buildCimFinancials(analysis, [analysis]),
  today: new Date("2026-09-26T12:00:00Z"),
});
_setAnthropicForTests(null);

const byTitle = (t: string) => doc.sections.find((s) => s.sectionTitle === t)!;
const warnings = doc.warnings ?? [];

// The writer was told the rules and given the cash-free figures.
const system = JSON.stringify(bodies[0].system);
assert.match(system, /26\. WORKING CAPITAL IS CASH-FREE AND DEBT-FREE/);
assert.match(system, /Net working capital \(cash-free, debt-free\): \$2,538,000/);
assert.doesNotMatch(system, /Working Capital: \$1,022,999 net working capital/);

// ACC2-01: rebuilt on the peg's basis; nothing about a shortfall reaches a buyer.
const wc = byTitle("Working Capital");
assert.equal(wc.layoutType, "comparison_table");
const rows = (wc.layoutData as any).rows as Array<{ label: string; left: string; right: string }>;
assert.deepEqual(rows.map((r) => r.label), ["Accounts receivable", "Inventory — fuel, parts and tires", "Prepaid expenses", "Accounts payable and accrued liabilities", "Net working capital"]);
assert.deepEqual(rows.at(-1), { label: "Net working capital", left: "$2,538,000", right: "$2,400,000", highlight: true } as any);
assert.ok(!JSON.stringify(wc.layoutData).includes("1,022,999"));
assert.ok(!/shortfall/i.test(JSON.stringify(wc.layoutData)));
assert.equal((wc.layoutData as any).leftLabel, "December 31, 2024");
assert.deepEqual(wc.figureWarnings ?? [], []);
assert.ok(warnings.some((w) => /"Working Capital" set net working capital beside the peg on a different basis; it was rebuilt/.test(w)), warnings.join("\n"));

// ACC2-10: the true ranks pass.
assert.ok(!warnings.some((w) => /no such ranking/.test(w)), "no rank false positives");

// ACC2-09: the other slips are named for the broker (the rewrite kept them).
assert.ok(warnings.some((w) => /Check the figures in "Transaction Structure"[^]*\$7,570,000 is the 2023 year-end term debt/.test(w)), "debt year");
// (FREE round, known-3: the misread count has no source on file, so it is
// now taken out of the section — never shipped beside its warning.)
assert.ok(
  warnings.some((w) => /Check the figures in "Safety & Compliance"[^]*counts don't match the rate/.test(w)) ||
    warnings.some((w) => /^Taken out of "Safety & Compliance" because no source on file has the figure: "Roadside Inspections: 646"/.test(w)),
  "counts vs rate",
);
assert.ok(!/\b646\b/.test(JSON.stringify(byTitle("Safety & Compliance").layoutData)), "the misread count never reaches a buyer");
assert.ok(warnings.some((w) => /Check the figures in "Key Customer Relationships"[^]*"evergreen" for "Kestrel Building Supply"/.test(w)), "evergreen");
assert.ok(warnings.some((w) => /Counts that don't add up were left out of the CIM/.test(w)));
assert.ok(warnings.some((w) => /Left out of the CIM: "Working Capital" \(\$1,022,999\)/.test(w)));
assert.ok(!warnings.some((w) => /Check the figures in "Financial Summary"/.test(w)), "the financial summary stays clean");

console.log("a-cim-generation: ok");
