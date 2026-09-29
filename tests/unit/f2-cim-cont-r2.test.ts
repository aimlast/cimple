/**
 * Free round 2, "cim" stream, continuation 2 — what the independent check of
 * e9a705c left open (scratchpad harvest/chk-f2-cim-cont/probe*.mts replayed).
 *
 * C5 (DD validator):
 *  - a name match ran across the end of a sentence ("Helen Park. The master
 *    agreement …" read as the name "Helen Park. The"), and across the lines
 *    of a table's headers, so faithful DD prose was rejected;
 *  - still open: a lower-case name behind a generic label, a wrong share in
 *    prose, an invented acronym in a revealed span, swapped column headers;
 *  - still rejected though faithful: "Customer A, Acme Logistics", a
 *    descriptive aside ("Anchor Client"), a share chart where the file gives
 *    only amounts, a figure the file rounds ("about $3.0M"), ordinary DD
 *    words ("Verified …", "December …", "Harmonized Sales Tax …").
 * C7: with the listed price removed, the multiples this app writes
 *  ("Revenue Multiple 1.45x", "SDE Multiple 5.2x", "Implied EV / EBITDA")
 *  and a stat_callout's "Asking Price / SDE 3.8x" stayed; ordinary prices
 *  ("priced at $189 per year", "the manufacturer's list price of $12,500")
 *  lost their sentences.
 * known-2: "Owned — the upper floor is rented to a tenant" and similar owned
 *  premises showed a "Leased" pill.
 */
import assert from "node:assert/strict";
import { validateDdOverride } from "../../server/cim/dd-enrichment";
import { withoutAskingPrice } from "../../shared/cim-buyer-view";
import { splitLeaseType } from "../../shared/cim-location";

// ── C5: sentence ends inside a revealed span ──
{
  const known = [
    "ownerName: Helen Park",
    "location: Ottawa, Ontario",
    "accountant: Dufresne & Kaur LLP, Chartered Professional Accountants",
    "keyCustomer: Maplecrest Senior Living (5 homes, 490 beds), contact Linda Chu",
    "bank: Laurentide Commons Credit Union term loan $140,000",
  ].join("\n");
  const base = { layoutData: { body: "The pharmacy serves long-term care homes." }, content: "" };
  const check = (span: string) =>
    validateDdOverride(base, { layoutData: { body: `The pharmacy serves long-term care homes. [[dd]]${span}[[/dd]]` }, contentOverride: "" }, known, []);
  for (const span of [
    "The owner is Helen Park. The master agreement renews in 2026.",
    "The pharmacy is located in Ottawa. The lease runs to 2028.",
    "Statements were prepared by Dufresne & Kaur LLP. The T2 returns reconcile.",
    "The term loan is with Laurentide Commons Credit Union. Monthly payments are current.",
    "The largest customer is Maplecrest Senior Living. Linda Chu manages the relationship.",
    "Serving Ontario. Contracts renew annually.",
    "Figures verified from the compiled statements. The returns agree.",
  ]) assert.deepEqual(check(span), [], span);
  // Still one name when a short form sits inside it.
  assert.ok(check("The landlord is St. Lawrence Holdings.").some((p) => p.includes("St. Lawrence Holdings")), "an invented 'St. Lawrence Holdings' is still one name");
  // An invented name right after a sentence end is still caught.
  assert.ok(check("The owner is Helen Park. Brightway Distribution supplies the pharmacy.").some((p) => p.includes("Brightway Distribution")));
}

// ── C5: labels, pairing, prose, acronyms, headers ──
{
  const known = "customerConcentration: Largest customer Acme Logistics 31%; second Brightway Foods 18%";
  const base = { layoutData: { data: [{ name: "Customer A", value: 31 }, { name: "Customer B", value: 18 }], unit: "%" }, content: "Customer A accounts for 31% of revenue." };
  const run = (a: string, b: string, va = 31, vb = 18, k = known) =>
    validateDdOverride(base, { layoutData: { data: [{ name: a, value: va }, { name: b, value: vb }], unit: "%" }, contentOverride: base.content }, k);

  // Faithful — pass.
  assert.deepEqual(run("Customer A, Acme Logistics", "Customer B, Brightway Foods"), []);
  assert.deepEqual(run("Customer A (Anchor Client)", "Customer B"), []);
  assert.deepEqual(run("Customer A (Largest Account)", "Customer B"), []);
  assert.deepEqual(run("Customer A (FY2024)", "Customer B"), []);
  // The file gives only amounts: a share chart can't be compared figure by figure, but its order must hold.
  const dollarsOnly = "customerConcentration: Largest customer Acme Logistics ($3,040,000 of 2024 revenue); second Brightway Foods ($1,765,000)";
  assert.deepEqual(run("Acme Logistics", "Brightway Foods", 31, 18, dollarsOnly), []);
  assert.ok(run("Brightway Foods", "Acme Logistics", 31, 18, dollarsOnly).some((p) => /below/.test(p)), "a swap is caught by order");
  // The file rounds: "about $3.0M" agrees with 3,040,000.
  const dbase = { layoutData: { data: [{ name: "Customer A", value: 3040000 }], unit: "$" }, content: "" };
  assert.deepEqual(validateDdOverride(dbase, { layoutData: { data: [{ name: "Acme Logistics", value: 3040000 }], unit: "$" }, contentOverride: "" }, "customers: Acme Logistics about $3.0M (31%)"), []);
  assert.ok(validateDdOverride(dbase, { layoutData: { data: [{ name: "Acme Logistics", value: 3400000 }], unit: "$" }, contentOverride: "" }, "customers: Acme Logistics about $3.0M (31%)").length > 0, "outside the rounding is still wrong");

  // Invented — rejected.
  assert.ok(run("Customer A (sysco)", "Customer B").some((p) => p.includes("sysco")), "lower-case name behind a generic label");
  assert.ok(run("Customer A, Sysco", "Customer B").some((p) => p.includes("Sysco")));
  // Prose: a real name with another party's share.
  const prose = (t: string) => validateDdOverride(base, { layoutData: base.layoutData, contentOverride: t }, known);
  assert.ok(prose("Customer A ([[dd]]Brightway Foods[[/dd]]) accounts for 31% of revenue.").some((p) => p.includes("Brightway Foods") && p.includes("18")));
  assert.deepEqual(prose("Customer A ([[dd]]Acme Logistics[[/dd]]) accounts for 31% of revenue."), []);
  assert.deepEqual(prose("Customer A accounts for 31% of revenue. [[dd]]The largest customer is Acme Logistics at 31%.[[/dd]]"), []);
  // Prose: an acronym customer the file doesn't know; finance acronyms stay ordinary.
  assert.ok(prose("Customer A ([[dd]]the LCBO[[/dd]]) accounts for 31% of revenue.").some((p) => p.includes("LCBO")));
  assert.deepEqual(prose("Customer A accounts for 31% of revenue. [[dd]]HST and T4 filings reconcile to the GL.[[/dd]]"), []);
  // Column headers: an invented or swapped name over a column.
  const cbase = { layoutData: { headers: ["", "Customer A", "Customer B"], rows: [{ label: "Share of revenue", values: ["31%", "18%"] }] }, content: "" };
  const cols = (h: string[]) => validateDdOverride(cbase, { layoutData: { headers: h, rows: [{ label: "Share of revenue", values: ["31%", "18%"] }] }, contentOverride: "" }, known);
  assert.ok(cols(["", "Sysco", "Customer B"]).some((p) => p === 'named "Sysco", which isn\'t on file'));
  assert.ok(cols(["", "Brightway Foods", "Acme Logistics"]).length === 2);
  assert.deepEqual(cols(["", "Acme Logistics", "Brightway Foods"]), []);
  // comparison_table columns.
  const cmp = { layoutData: { leftLabel: "Customer A", rightLabel: "Customer B", rows: [{ label: "Share of revenue", left: "31%", right: "18%" }] }, content: "" };
  assert.ok(validateDdOverride(cmp, { layoutData: { ...cmp.layoutData, leftLabel: "Brightway Foods", rightLabel: "Acme Logistics" }, contentOverride: "" }, known).length === 2);
  assert.deepEqual(validateDdOverride(cmp, { layoutData: { ...cmp.layoutData, leftLabel: "Acme Logistics", rightLabel: "Brightway Foods" }, contentOverride: "" }, known), []);

  // Ordinary DD wording.
  const pb = { layoutData: { body: "Revenue is documented." }, content: "" };
  for (const t of [
    "[[dd]]Verified against the Notice of Assessment for 2024.[[/dd]]",
    "[[dd]]Reviewed by the Controller, reconciled monthly.[[/dd]]",
    "[[dd]]Harmonized Sales Tax filings are current.[[/dd]]",
    "[[dd]]December year-end statements were reviewed.[[/dd]]",
    "[[dd]]Confirmed against bank deposits for 2022 to 2024.[[/dd]]",
  ]) assert.deepEqual(validateDdOverride(pb, { layoutData: { body: `Revenue is documented. ${t}` }, contentOverride: "" }, known), [], t);
  // An accounting firm or system the file never names is an unsupported claim — still rejected.
  assert.ok(validateDdOverride(pb, { layoutData: { body: "Revenue is documented. [[dd]]Statements prepared by MNP LLP were reviewed.[[/dd]]" }, contentOverride: "" }, known).length > 0);
}

// ── C7: multiples and ordinary prices with the price removed ──
{
  const hv = {
    layoutType: "metric_grid",
    layoutData: {
      metrics: [
        { label: "Asking Price", value: "$9,000,000" },
        { label: "Revenue Multiple", value: "1.45×", footnote: "Based on 2024 revenue of $6,212,400" },
        { label: "SDE Multiple", value: "5.2×", footnote: "Based on 2024 SDE of approximately $1,721,300" },
        { label: "EBITDA Multiple", value: "6.1x" },
        { label: "Implied EV / EBITDA", value: "6.1x" },
        { label: "Price to EBITDA", value: "4.6x" },
        { label: "2024 Revenue", value: "$6,212,400" },
        { label: "Industry SDE multiple range", value: "2.5–3.5x" },
        { label: "Debt / EBITDA", value: "1.2x" },
      ],
    },
  };
  const left = (withoutAskingPrice(hv) as any).layoutData.metrics.map((m: any) => m.label);
  assert.deepEqual(left, ["2024 Revenue", "Industry SDE multiple range", "Debt / EBITDA"]);
  const callout = (d: Record<string, unknown>) => (withoutAskingPrice({ layoutType: "stat_callout", layoutData: d }) as any).layoutData;
  assert.deepEqual(callout({ primaryLabel: "Asking Price / SDE", primaryValue: "3.8×", secondaryStats: [{ label: "SDE", value: "$1,263,000" }] }), { primaryLabel: "SDE", primaryValue: "$1,263,000", secondaryStats: [] });
  assert.equal(callout({ primaryLabel: "Implied SDE multiple", primaryValue: "3.8x" }).primaryValue, "Price on request");
  assert.equal(callout({ primaryLabel: "Asking price", primaryValue: "$4,800,000" }).primaryValue, "Price on request");
  assert.equal(callout({ primaryLabel: "Recurring revenue", primaryValue: "62%" }).primaryValue, "62%");
  const cmp = (withoutAskingPrice({ layoutType: "comparison_table", layoutData: { leftLabel: "This deal", rightLabel: "Industry", rows: [{ label: "SDE multiple", left: "3.8x", right: "2.5–3.5x" }, { label: "Revenue", left: "$9M", right: "" }] } }) as any).layoutData.rows;
  assert.deepEqual(cmp.map((r: any) => r.label), ["Revenue"]);

  const prose = (body: string) => (withoutAskingPrice({ layoutType: "prose_highlight", layoutData: { body } }) as any).layoutData.body;
  for (const keep of [
    "Comfort Club memberships are priced at $189 per year and renew automatically.",
    "Service calls are offered at $120 per hour, with a $79 diagnostic fee.",
    "Units sell at an average 8% discount to the manufacturer's list price of $12,500.",
    "The seller will provide vendor financing of 10% of the purchase price and the $250,000 of inventory is included.",
    "The 2012 purchase price of the building was $1.2 million.",
    "Offers should state the purchase price, and the working capital peg of $2.4M.",
    "The company was listed at #42 on the 2023 Growth 500 with revenue of $6.2M.",
    "Comparable HVAC businesses have sold at 3–4x SDE.",
  ]) assert.equal(prose(keep), keep, keep);
  for (const drop of [
    "The asking price is $9,000,000.",
    "The business is offered for sale at $4.8M.",
    "The purchase price of $4,800,000 is payable on closing.",
    "This represents an SDE multiple of 5.2x.",
    "The business trades at an implied 5.2x SDE.",
    "The business sold for 4.2x SDE in comparable transactions; the asking price reflects this.",
  ]) assert.equal(prose(drop), "", drop);
  // One sentence, even with "Ltd." inside it: nothing of it is left behind.
  assert.equal(prose("Pacific Coast Logistics Ltd. is being offered as a share sale at an asking price of $18,000,000. Trucks are owned."), "Trucks are owned.");
}

// ── known-2: owned premises with a lease word ──
{
  for (const [t, badge] of [
    ["Owned by the seller's holding company and leased to the business at $8,000 per month", "Leased"],
    ["Owned by the owner personally; the business pays rent of $4,000 per month", "Leased"],
    ["Owned by related party; leased back to the operating company", "Leased"],
    ["Owned — the upper floor is rented to a tenant at $2,000 per month", "Owned"],
    ["Owned; second unit leased to a dental practice for $3,500/month", "Owned"],
    ["Owned by the business; part of the building is sublet to a tenant", "Owned"],
    ["Owned (real estate available to the buyer by lease or purchase)", "Owned"],
    ["Owned, with rental income from two tenants", "Owned"],
    ["Owned (leasehold improvements included)", "Owned"],
    ["Owned by the company, no rent charged", "Owned"],
  ] as const) assert.equal(splitLeaseType(t).badge, badge, t);
  assert.equal(splitLeaseType("Owned by Grewal Family Holdings Ltd.").badge, null);
}

console.log("f2-cim-cont-r2: ok");
