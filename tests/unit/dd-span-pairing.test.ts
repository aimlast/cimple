/**
 * F2-DD-4 (final review): the DD validator compares a revealed name with the
 * figure it is paired with even when both sit inside the same [[dd]] span.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/unit/dd-span-pairing.test.ts
 */
import assert from "node:assert/strict";
import { validateDdOverride } from "../../server/cim/dd-enrichment";

const known = `customerConcentration: Top customers 2024: Alderbrook Foods 31% ($3.04M), Sunrise Co-op 18%, Harvest Lane Markets 9%.
revenue2024: $9,800,000 (T2 Schedule 125 line 8299: $9,812,440).`;
const layoutData = { title: "Customer Concentration", data: [{ name: "Customer A", value: 31 }, { name: "Customer B", value: 18 }, { name: "Customer C", value: 9 }, { name: "All others", value: 42 }], unit: "%" };
const base = { layoutData, content: "The top three customers account for 58% of 2024 revenue." };
const check = (content: string) => validateDdOverride(base, { layoutData, contentOverride: content }, known);
const mispaired = (problems: string[]) => problems.some((p) => /shows "Sunrise Co-op" at 31/.test(p));

// The name alone in the span, the figure after it (already caught).
assert.ok(mispaired(check("The top three customers account for 58% of 2024 revenue. The largest, [[dd]]Sunrise Co-op[[/dd]], accounts for 31% of revenue.")));
// The whole sentence in one span — now caught.
assert.ok(mispaired(check("The top three customers account for 58% of 2024 revenue. [[dd]]Sunrise Co-op accounts for 31% of revenue.[[/dd]]")), "name and share in one span");
// Two names in one span: each keeps its own figure.
assert.ok(mispaired(check("The top three customers account for 58% of 2024 revenue. [[dd]]Sunrise Co-op accounts for 31% of revenue and Alderbrook Foods for 18% of revenue.[[/dd]]")), "the next name ends the window");
// True pairings pass.
assert.deepEqual(check("The top three customers account for 58% of 2024 revenue. [[dd]]Alderbrook Foods accounts for 31% of revenue.[[/dd]]"), []);
assert.deepEqual(check("The top three customers account for 58% of 2024 revenue. [[dd]]Alderbrook Foods accounts for 31% of revenue and Sunrise Co-op for 18% of revenue.[[/dd]]"), []);

console.log("dd-span-pairing: all assertions passed");
