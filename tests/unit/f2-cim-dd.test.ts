/**
 * Free round 2 — DD CIM (C2, C5).
 *
 * C2: a name the seller or broker asked to keep out of the CIM reached the
 * DD version through the add-back verification labels and the statement
 * lines, and the validator accepted it as "on file".
 * C5: the DD validator let an invented one-word customer ("Sysco") through
 * and accepted real names paired with the wrong shares.
 */
import assert from "node:assert/strict";
import { buildDdContext, enrichSection, financialsWithoutHeldNames, validateDdOverride, _setDdClientForTests } from "../../server/cim/dd-enrichment";
import { screenFactsForCim } from "../../server/cim/sensitive-facts";
import { buildCimFinancials } from "../../server/cim/cim-financials";

// ── C2: the recorded probe (scratchpad f2cim/ddheld.mts) ──
const extractedInfo: Record<string, unknown> = {
  businessName: "Harbourline Dental Group",
  ownerName: "Dr. Alan Chen",
  familyInvolvement: "Maria Chen (owner's wife) is paid $62,000 a year as office manager but does little day-to-day work.",
  _brokerPrivateNotes: [{ text: "Keep Maria Chen out of the CIM — the seller does not want his wife named to buyers." }],
};
const keepOut = { clauses: [], names: ["Maria Chen"], pairs: [] };
const screened = screenFactsForCim(Object.entries(extractedInfo).filter(([k]) => !k.startsWith("_")), keepOut);
assert.deepEqual(screened.heldNames, ["Maria Chen"], "the named CIM holds her");

const financials = buildCimFinancials({
  id: "fa", version: 1, status: "reviewed", brokerReviewedAt: new Date(),
  lineItems: [],
  normalization: {
    metric: "sde", years: ["2024"], netIncome: { "2024": 400000 },
    addbacks: [
      { id: "a", label: "Owner salary", category: "owner_comp", type: "sde", approved: true, amounts: { "2024": 150000 } },
      { id: "b", label: "Salary paid to Maria Chen (owner's wife)", category: "related_party", type: "sde", approved: true, amounts: { "2024": 62000 } },
    ],
  },
} as any);
const inputs = buildDdContext({
  extractedInfo,
  keepOut,
  financials,
  addbackVerification: {
    status: "complete",
    addbacks: [{ label: "Salary paid to Maria Chen (owner's wife)", verificationStatus: "verified", matchedTransactions: [1, 2, 3], yearAmounts: { "2024": 62000 } }],
  },
  documents: [
    { name: "FY2024 statements.pdf", category: "financials", visibility: "shared" },
    { name: "Maria Chen payroll 2024.xlsx", category: "financials", visibility: "shared" },
  ],
});
assert.ok(!/Maria Chen/.test(inputs.context), `DD context never names her:\n${inputs.context}`);
assert.ok(!/Maria Chen/.test(inputs.knownText), "nor the look-up text the validator trusts");
// (Worded by shared/addback-support addbackEvidenceLine — claimed vs what the ledger shows.)
assert.match(inputs.context, /- Salary paid \(owner's wife\): verified[^\n]*3 supporting transactions|- Salary paid: verified/, "the add-back stays, under a neutral label");
assert.match(inputs.context, /\+ Salary paid[^\n]*\$62,000/, "the bridge keeps its step");
assert.match(inputs.context, /FY2024 statements\.pdf/);
assert.deepEqual(inputs.heldNames, ["Maria Chen"]);

const base = { layoutData: { body: "Normalized SDE adds back $62,000 of non-working family wages." }, content: "" };
const leaked = { layoutData: { body: "Normalized SDE adds back $62,000 of non-working family wages ([[dd]]salary paid to Maria Chen, the owner's wife, verified against 3 payroll transactions[[/dd]])." }, contentOverride: "" };
const problems = validateDdOverride(base, leaked, inputs.knownText, inputs.heldNames);
assert.ok(problems.some((p) => /Maria Chen/.test(p)), `rejected: ${problems.join(" | ")}`);
// Even without the held list, a name that isn't on file is refused.
assert.ok(validateDdOverride(base, leaked, inputs.knownText).some((p) => /Maria Chen/.test(p)));

// enrichSection keeps the named version and says why.
_setDdClientForTests({ messages: { create: async () => ({ stop_reason: "tool_use", content: [{ type: "tool_use", name: "dd_section", input: { layoutData: leaked.layoutData, contentOverride: "" } }] }) } });
const kept = await enrichSection({ id: "s", dealId: "d", sectionKey: "fin", sectionTitle: "Normalization", order: 1, layoutType: "prose_highlight", layoutData: base.layoutData, aiDraftContent: "", brokerEditedContent: null } as any, inputs, { businessName: "Harbourline" });
_setDdClientForTests(null);
assert.deepEqual(kept.layoutData, base.layoutData);
assert.match(kept.warning ?? "", /kept as the named CIM/);

// A statement line naming her is neutral too (the bridge keeps the step's amount).
const fin2 = financialsWithoutHeldNames({ ...financials!, lines: [{ category: "Operating Expenses", name: "Wages — Maria Chen", values: { "2024": 62000 } }] } as any, ["Maria Chen"])!;
assert.equal(fin2.lines[0].name, "Wages");
assert.ok(fin2.bridge!.sdeOnly.concat(fin2.bridge!.addbacks).every((a) => !/Maria/.test(a.label)));

// ── C5: the recorded probe (scratchpad f2cim/dd.mts) ──
const ddBase = { layoutData: { data: [{ name: "Customer A", value: 31 }, { name: "Customer B", value: 18 }], unit: "%" }, content: "Customer A accounts for 31% of revenue." };
const known = "customerConcentration: Largest customer Acme Logistics 31%; second Brightway Foods 18%";
const swapped = validateDdOverride(ddBase, { layoutData: { data: [{ name: "Sysco", value: 31 }, { name: "Acme Logistics", value: 18 }], unit: "%" }, contentOverride: "[[dd]]Sysco[[/dd]] accounts for 31% of revenue." }, known);
assert.ok(swapped.some((p) => /"Sysco", which isn't on file/.test(p)), `invented one-word customer: ${swapped.join(" | ")}`);
assert.ok(swapped.some((p) => /"Acme Logistics" at 18.*31/.test(p)), `wrong share for a real name: ${swapped.join(" | ")}`);
const swapped2 = validateDdOverride(ddBase, { layoutData: { data: [{ name: "Sysco Canada", value: 31 }, { name: "Acme Logistics", value: 18 }], unit: "%" }, contentOverride: "x" }, known);
assert.ok(swapped2.some((p) => /Sysco Canada/.test(p)) && swapped2.some((p) => /Acme Logistics" at 18/.test(p)), swapped2.join(" | "));
// One-word name in prose, mid-sentence.
const prose = validateDdOverride(ddBase, { layoutData: ddBase.layoutData, contentOverride: "Customer A accounts for 31% of revenue, served under contract by [[dd]]Loblaws[[/dd]]." }, known);
assert.ok(prose.some((p) => /"Loblaws"/.test(p)), prose.join(" | "));

// The faithful reveal passes.
const right = validateDdOverride(ddBase, { layoutData: { data: [{ name: "Acme Logistics", value: 31 }, { name: "Brightway Foods", value: 18 }], unit: "%" }, contentOverride: "[[dd]]Acme Logistics[[/dd]] accounts for 31% of revenue." }, known);
assert.deepEqual(right, [], right.join(" | "));
// A legal ending and an aside in the label still match the file; ordinary capitals don't trip it.
const right2 = validateDdOverride(ddBase, {
  layoutData: { data: [{ name: "Acme Logistics Ltd. (MSA to 2027)", value: "31%" }, { name: "Brightway Foods", value: 18 }], unit: "%" },
  contentOverride: "Customer A accounts for 31% of revenue. [[dd]]Revenue from Acme Logistics[[/dd]] is verified against the Receivables ledger.",
}, `${known}\nreceivablesLedger: reconciled monthly`);
assert.deepEqual(right2, [], right2.join(" | "));
// A name the file mentions with no figure isn't second-guessed.
const noFig = validateDdOverride({ layoutData: { data: [{ name: "Customer A", value: 40 }] }, content: "" }, { layoutData: { data: [{ name: "Northway Freight", value: 40 }] }, contentOverride: "" }, "largestCustomer: Northway Freight (anchor account since 2011); largest customer share 40%");
assert.deepEqual(noFig, [], noFig.join(" | "));

console.log("f2-cim-dd: ok");
