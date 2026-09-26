import assert from "node:assert/strict";
import { resolvedNotes, overlayResolvedFacts, renderResolvedBlock } from "../../server/cim/resolved-block";

const row = (o: Record<string, unknown>) => ({ id: "x", dealId: "d", severity: "critical", category: "financial", source: "financial_analysis", status: "resolved", createdAt: new Date(), ...o }) as any;

// A descriptive label never becomes a pseudo-fact key; it only reaches the block.
const notes = resolvedNotes([
  row({ field: "Alderbrook revenue percentage", interviewValue: "about 18%", documentValue: "22.0%", resolvedValue: "22.0%" }),
  row({ field: "annualRevenue", interviewValue: "$2.3M", documentValue: "$1,820,000", resolvedValue: "$1,820,000" }),
  row({ field: "Revenue FY2023", factKey: "revenueByYear", factYear: "2023", documentValue: "$1.1M", interviewValue: "$1.2M", resolvedValue: "$1.1M" }),
  row({ field: "ignored — unresolved", resolvedValue: null }),
]);
assert.equal(notes.length, 3);
assert.equal(notes[0].factKey, null);
assert.deepEqual(notes[0].supersededValues, ["about 18%"]);
const facts = overlayResolvedFacts({ annualRevenue: "$2.3M", revenueByYear: { "2023": "$1.2M", "2022": "$1.0M" } }, notes);
assert.equal(facts.annualRevenue, "$1,820,000");
assert.deepEqual(facts.revenueByYear, { "2023": "$1.1M", "2022": "$1.0M" });
assert.ok(!Object.keys(facts).some((k) => /\s/.test(k)), "no label-named keys");
const block = renderResolvedBlock(notes);
assert.match(block, /Alderbrook revenue percentage: 22\.0% \(final — earlier, different figures for this are wrong\)/);
assert.doesNotMatch(block, /about 18%/, "ruled-out values are never quoted to the writer");
assert.match(block, /Revenue FY2023: \$1\.1M/); // the year once, not "Revenue FY2023 (2023)"
assert.equal(renderResolvedBlock([]), "");
console.log("resolved-block: ok");
