/**
 * Free round 2 — the "cim" stream's round-2 fixes: what the independent
 * checker left open after round 1 (scratchpad harvest/chk-f2-cim/probe.mts
 * and probe3.mts replayed here).
 *
 * C5: the DD validator let an invented name through behind a generic label
 * ("Customer A (Sysco)", "Customer A – Sysco", "Customer A: Sysco") and real
 * names with the wrong shares ("Customer A (Brightway Foods)" at 31% when
 * the file gives 18%); it rejected a faithful dollar chart ("Acme at
 * 3,040,000" — the file gives Acme 31% AND $3,040,000), and ordinary words
 * opening a revealed span ("[[dd]]The largest customer …").
 * C2: a held person named by their first name only ("Wages paid to Maria
 * (owner's spouse)") reached the DD context and passed the check.
 * C7: with the listed price removed, "Asking Price / SDE 3.8x" and prose
 * stating the price stayed, so buyers could work the price back out.
 * C6: a line chart point with a note ("$1,850,000 (9 months YTD)") was
 * neither read nor flagged — the point silently became a gap.
 * C4: an AI answer the broker published as it stands counted as unreviewed
 * and was withdrawn on the next section change.
 * known-2: "Owned by the seller's holding company and leased to the
 * business …" drew an "Owned" pill on premises the business rents.
 */
import "./react-global";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildDdContext, validateDdOverride } from "../../server/cim/dd-enrichment";
import { mentionsHeldPerson, neutralBridgeLabel, screenConfidentialText, screenFactsForCim } from "../../server/cim/sensitive-facts";
import { scrubHeldNames } from "../../server/cim/layout-engine";
import { buildBuyerCim, withoutAskingPrice } from "../../shared/cim-buyer-view";
import { lineChartRows, normalizeChartValues } from "../../shared/cim-chart-values";
import { structuralFigureProblems } from "../../server/cim/figure-check";
import { LineChartRenderer } from "../../client/src/components/cim/renderers/LineChart";
import { answerStillHolds, endorsedDraftOnPublish, isUnreviewedAiAnswer } from "../../server/qa/cim-context";
import { splitLeaseType } from "../../shared/cim-location";

// ── C5: names behind a generic label ──
{
  const known = "customerConcentration: Largest customer Acme Logistics 31%; second Brightway Foods 18%";
  const base = { layoutData: { data: [{ name: "Customer A", value: 31 }, { name: "Customer B", value: 18 }], unit: "%" }, content: "Customer A accounts for 31% of revenue." };
  const run = (a: string, b: string, va = 31, vb = 18) =>
    validateDdOverride(base, { layoutData: { data: [{ name: a, value: va }, { name: b, value: vb }], unit: "%" }, contentOverride: base.content }, known);
  for (const [a, b] of [
    ["Customer A (Sysco)", "Customer B (Brightway Foods)"],
    ["Customer A – Sysco", "Customer B – Brightway Foods"],
    ["Customer A: Sysco", "Customer B: Brightway Foods"],
    ["Sysco / Customer A", "Customer B"],
    ["Customer A (Sysco Foods Ltd.)", "Customer B"],
  ]) {
    const p = run(a, b);
    assert.ok(p.some((x) => /named "Sysco( Foods)?", which isn't on file/.test(x)), `${a}: ${p.join(" | ")}`);
  }
  // Real names paired with the wrong shares.
  const swapped = run("Customer A (Brightway Foods)", "Customer B (Acme Logistics)");
  assert.ok(swapped.some((x) => /"Brightway Foods" at 31, but the file gives it 18/.test(x)), swapped.join(" | "));
  assert.ok(swapped.some((x) => /"Acme Logistics" at 18, but the file gives it 31/.test(x)), swapped.join(" | "));
  // A new name made of known words, in place of "Customer A", must be on file as a whole.
  const mixed = run("Customer A (Brightway Logistics)", "Customer B");
  assert.ok(mixed.some((x) => /"Brightway Logistics"/.test(x)), mixed.join(" | "));
  // …and so must one revealed in the prose.
  const proseMixed = validateDdOverride(base, { layoutData: base.layoutData, contentOverride: "[[dd]]Brightway Logistics[[/dd]] accounts for 31% of revenue." }, known);
  assert.ok(proseMixed.some((x) => /"Brightway Logistics"/.test(x)), proseMixed.join(" | "));
  assert.deepEqual(validateDdOverride(base, { layoutData: base.layoutData, contentOverride: "[[dd]]Acme Logistics Inc.[[/dd]] accounts for 31% of revenue." }, known), []);
  // The faithful reveals pass, in every format.
  for (const [a, b] of [
    ["Customer A (Acme Logistics)", "Customer B (Brightway Foods)"],
    ["Customer A – Acme Logistics Inc.", "Customer B: Brightway Foods"],
    ["Acme Logistics", "Brightway Foods Ltd."],
  ]) assert.deepEqual(run(a, b), [], `${a} / ${b}`);
  // An aside that describes (no name) is fine; one that names someone unknown isn't.
  assert.deepEqual(run("Acme Logistics (MSA to 2027)", "Brightway Foods (since 2019)"), []);
  const aside = run("Acme Logistics (served via Sysco)", "Brightway Foods");
  assert.ok(aside.some((x) => /"Sysco"/.test(x)), aside.join(" | "));
}

// ── C5: a name's every stated figure counts — but only its own ──
{
  const known = "customerConcentration: Largest customer Acme Logistics (31% of 2024 revenue, $3,040,000); second Brightway Foods 18%";
  const base = { layoutData: { data: [{ name: "Customer A", value: 3040000 }, { name: "Customer B", value: 1765000 }], unit: "$" }, content: "The largest customer is Customer A." };
  const dollars = validateDdOverride(base, { layoutData: { data: [{ name: "Acme Logistics", value: 3040000 }, { name: "Customer B", value: 1765000 }], unit: "$" }, contentOverride: "The largest customer is [[dd]]Acme Logistics[[/dd]]." }, known);
  assert.deepEqual(dollars, [], `a faithful dollar chart passes: ${dollars.join(" | ")}`);
  // One clause, two parties: Acme's window stops at Brightway (and at "others").
  const pShare = { layoutData: { data: [{ name: "Customer A", value: 31 }], unit: "%" }, content: "" };
  const oneClause = "customers: Acme Logistics 31%, Brightway Foods 18%, others 12%";
  assert.ok(validateDdOverride(pShare, { layoutData: { data: [{ name: "Acme Logistics", value: 18 }], unit: "%" }, contentOverride: "" }, oneClause).some((x) => /Acme Logistics" at 18/.test(x)));
  assert.ok(validateDdOverride(pShare, { layoutData: { data: [{ name: "Brightway Foods", value: 12 }], unit: "%" }, contentOverride: "" }, oneClause).some((x) => /Brightway Foods" at 12/.test(x)));
  assert.deepEqual(validateDdOverride(pShare, { layoutData: { data: [{ name: "Acme Logistics", value: 31 }], unit: "%" }, contentOverride: "" }, oneClause), []);
  const second = "customers: Largest customer Acme Logistics at 31% of revenue, second-largest customer 18%";
  assert.ok(validateDdOverride(pShare, { layoutData: { data: [{ name: "Acme Logistics", value: 18 }], unit: "%" }, contentOverride: "" }, second).some((x) => /at 18/.test(x)), "'second' starts the next party");
}

// ── C5: ordinary words and places don't read as invented names ──
{
  const known = "customerConcentration: Largest customer Acme Logistics 31%; second Brightway Foods 18%\npayroll: T4 summaries filed 2021-2024 reconcile to payroll\ntaxFilings: CRA";
  const dd = (text: string) => validateDdOverride({ layoutData: { body: "Revenue is documented." }, content: "" }, { layoutData: { body: `Revenue is documented. ${text}` }, contentOverride: "" }, known);
  for (const t of [
    "[[dd]]The largest customer is Acme Logistics at 31%.[[/dd]]",
    "[[dd]]These figures reconcile to the T4 summaries.[[/dd]]",
    "[[dd]]Our review found no exceptions.[[/dd]]",
    "[[dd]]Since 2021 payroll has reconciled.[[/dd]]",
    "[[dd]]Payroll records since March 2021 reconcile to the T4 summaries filed with the Canada Revenue Agency.[[/dd]]",
    "[[dd]]Filings in Ontario and British Columbia are current.[[/dd]]",
  ]) assert.deepEqual(dd(t), [], t);
  // An invented one-word name opening a revealed span is still caught.
  assert.ok(dd("[[dd]]Sysco supplies the kitchen.[[/dd]]").some((x) => /"Sysco"/.test(x)));
  // A new metric row described in words passes; a title-case heading made of everyday words too.
  const card = (label: string) => validateDdOverride(
    { layoutData: { metrics: [{ label: "SDE", value: "$640,000" }] }, content: "" },
    { layoutData: { metrics: [{ label: "SDE", value: "$640,000" }, { label, value: "3 of 3" }] }, contentOverride: "" },
    "addbacks: 3 add-backs, all verified to the general ledger; SDE $640,000",
  );
  assert.deepEqual(card("Add-backs verified"), []);
  assert.deepEqual(card("Verified Add-backs"), []);
  assert.ok(card("Verified by Sysco").some((x) => /"Sysco"/.test(x)));
}

// ── C2: a held person by first name only ──
{
  const held = ["Maria Chen"];
  assert.equal(mentionsHeldPerson("Wages paid to Maria (owner's spouse)", held), "Maria Chen");
  assert.equal(mentionsHeldPerson("Maria's salary is paid monthly.", held), "Maria Chen");
  assert.equal(mentionsHeldPerson("Maria Lopez runs the front desk.", held), null, "another Maria is someone else");
  assert.equal(mentionsHeldPerson("The Santa Maria Foods account", held), null, "a company that contains the name");
  assert.equal(mentionsHeldPerson("Harvest Lane Markets pays net 30.", ["Harvest Lane Markets"]), "Harvest Lane Markets");
  assert.equal(mentionsHeldPerson("The harvest was early.", ["Harvest Lane Markets"]), null, "a company has no first-name form");
  assert.equal(mentionsHeldPerson("Grace period of 30 days.", ["Grace Liu"]), null, "an everyday-word first name is never matched alone");
  assert.equal(mentionsHeldPerson("Dr. Maria spoke first.", ["Dr. Maria Chen"]), "Dr. Maria Chen");
  assert.equal(neutralBridgeLabel("Wages paid to Maria (owner's spouse)", held), "Wages paid (owner's spouse)");

  // The checker's probe: the DD context never carries her first name.
  const ctx = buildDdContext({
    extractedInfo: { businessName: "Harbourline Dental Group", ownerName: "Dr. Alan Chen" },
    keepOut: { clauses: [], names: held, pairs: [] } as any,
    financials: null,
    addbackVerification: { status: "complete", addbacks: [{ label: "Wages paid to Maria (owner's spouse)", verificationStatus: "verified", matchedTransactions: [1] }] },
    documents: [{ name: "Maria payroll 2024.xlsx", category: "financials", visibility: "shared" }],
  });
  assert.ok(!/Maria/.test(ctx.context), ctx.context);
  assert.match(ctx.context, /Wages paid \(owner's spouse\): verified/);
  // …and a DD version naming her by first name is rejected.
  const p = validateDdOverride(
    { layoutData: { body: "Normalized SDE adds back $62,000 of family wages." }, content: "" },
    { layoutData: { body: "Normalized SDE adds back $62,000 of family wages ([[dd]]paid to Maria, verified against payroll[[/dd]])." }, contentOverride: "" },
    `${ctx.knownText}\nwages: $62,000`,
    held,
  );
  assert.ok(p.some((x) => /whom the CIM must leave out/.test(x)), p.join(" | "));

  // The named CIM: facts and the section scrub drop the first-name form too; another Maria stays.
  const alone = screenFactsForCim([["staff", "Maria handles scheduling and billing"], ["owner", "Dr. Alan Chen"]], { clauses: [], names: held, pairs: [] } as any);
  assert.ok(!JSON.stringify(alone.safe).includes("Maria handles"), JSON.stringify(alone.safe));
  // (Final review F2-CIMTRUTH-1: with ANOTHER Maria on file, "Maria" alone
  // may be her — the given name alone is no longer matched; the full name is.)
  const screened = screenFactsForCim([["staff", "Maria handles scheduling and billing"], ["frontDesk", "Maria Lopez (receptionist, 6 years)"], ["payroll", "Maria Chen is paid $62,000"]], { clauses: [], names: held, pairs: [] } as any);
  assert.ok(JSON.stringify(screened.safe).includes("Maria handles"), JSON.stringify(screened.safe));
  assert.ok(!JSON.stringify(screened.safe).includes("Maria Chen"), JSON.stringify(screened.safe));
  assert.ok(JSON.stringify(screened.safe).includes("Maria Lopez"));
  assert.equal(screenConfidentialText("The office runs well. Maria keeps the books.", held), "The office runs well.");
  const scrubbed = scrubHeldNames({ layoutType: "prose_highlight", layoutData: { body: "Staff are long-tenured. Maria (owner's spouse) keeps the books." } }, held);
  assert.ok(scrubbed && !JSON.stringify(scrubbed.layoutData).includes("Maria"), JSON.stringify(scrubbed));
}

// ── C7: the removed price can't be worked back out ──
{
  const grid = { layoutType: "metric_grid", layoutData: { metrics: [{ label: "Asking Price", value: "$4,800,000" }, { label: "Asking Price / SDE", value: "3.8x" }, { label: "SDE", value: "$1,263,000" }, { label: "Price to EBITDA", value: "4.6x" }] } };
  assert.deepEqual((withoutAskingPrice(grid) as any).layoutData.metrics.map((m: any) => m.label), ["SDE"]);
  const prose = {
    layoutType: "prose_highlight",
    layoutData: { body: "The business is offered as a share sale. The asking price of $4.8M represents 3.8x SDE.\n\nThe seller will stay for six months.", callout: "Listed at $4,800,000" },
    aiDraftContent: "The asking price is $4,800,000, including inventory. Training is included.",
    brokerEditedContent: null,
  };
  const out = withoutAskingPrice(prose) as any;
  assert.equal(out.layoutData.body, "The business is offered as a share sale.\n\nThe seller will stay for six months.");
  assert.equal(out.layoutData.callout, "");
  assert.equal(out.aiDraftContent, "Training is included.");
  // Terms lists and table rows naming the price go; the rest of the table keeps its columns.
  const terms = withoutAskingPrice({ layoutType: "numbered_list", layoutData: { items: ["Asking price: $4,800,000", "Share sale", "Six-month transition"] } }) as any;
  assert.deepEqual(terms.layoutData.items, ["Share sale", "Six-month transition"]);
  const table = withoutAskingPrice({ layoutType: "financial_table", layoutData: { headers: ["", "Value"], rows: [{ label: "Purchase price", values: ["$4,800,000"] }, { label: "Inventory", values: ["$250,000"] }] } }) as any;
  assert.deepEqual(table.layoutData.rows.map((r: any) => r.label), ["Inventory"]);
  // Words about the price without a figure, and other multiples, stay.
  const words = { layoutType: "prose_highlight", layoutData: { body: "The asking price includes all equipment. Revenue grew 2.1x since 2019." } };
  assert.deepEqual(withoutAskingPrice(words), words);
  // Only when the listed price was removed: with one listed, or unknown, nothing is taken out.
  const s = { id: "s", dealId: "d", sectionKey: "t", sectionTitle: "Transaction", order: 1, layoutType: "prose_highlight", isVisible: true, brokerApproved: true, layoutData: prose.layoutData, aiDraftContent: prose.aiDraftContent, brokerEditedContent: null } as any;
  assert.ok(JSON.stringify(buildBuyerCim({ deal: { id: "d" }, accessLevel: "loi", sections: [s], overrides: [] }).sections).includes("3.8x"));
  assert.ok(!JSON.stringify(buildBuyerCim({ deal: { id: "d" }, accessLevel: "loi", sections: [s], overrides: [], askingPrice: null }).sections).includes("4.8M"));
}

// ── C6: line chart points with a note are read; unreadable ones are flagged and listed ──
{
  const series = [{ key: "revenue", label: "Revenue" }];
  const data = [{ name: "FY2023", revenue: "$1,600,000" }, { name: "FY2024", revenue: 1700000 }, { name: "FY2025", revenue: "$1,850,000 (9 months YTD)" }, { name: "FY2026", revenue: "TBD" }];
  const lines = lineChartRows(data, series, "$");
  assert.deepEqual(lines.rows.map((r) => [r.name, r.revenue]), [["FY2023", 1600000], ["FY2024", 1700000], ["FY2025 (9 months YTD)", 1850000], ["FY2026", null]]);
  assert.deepEqual(lines.unreadable, [{ name: "FY2026", value: "TBD" }]);
  const two = lineChartRows([{ name: "FY2026", revenue: "TBD", ebitda: "$1.1–1.2M" }], [...series, { key: "ebitda", label: "EBITDA" }], "$");
  assert.deepEqual(two.unreadable.map((u) => u.name), ["FY2026 · Revenue", "FY2026 · EBITDA"]);
  const saved = normalizeChartValues("line_chart", { data, series }) as any;
  assert.deepEqual(saved.data[2], { name: "FY2025 (9 months YTD)", revenue: 1850000 });
  assert.equal(saved.data[3].revenue, "TBD", "left as written");
  const flags = structuralFigureProblems({ sectionKey: "l", sectionTitle: "Trend", layoutType: "line_chart", layoutData: { data, series } } as any);
  assert.equal(flags.length, 1, flags.join(" | "));
  assert.match(flags[0], /"TBD" for "FY2026"/);
  const html = renderToStaticMarkup(React.createElement(LineChartRenderer, { layoutData: { data, series, unit: "$" }, content: "", branding: {} as any, section: {} as any }));
  assert.match(html, /chart-not-charted/);
  assert.match(html, /FY2026: <\/span>TBD/);
}

// ── C4: the broker's publish makes an AI answer theirs ──
{
  const q = { aiAnswer: "Revenue was $2.3M.", publishedAnswer: "Revenue was $2.3M.", brokerDraft: null, sellerApproved: false, status: "published" } as any;
  assert.equal(endorsedDraftOnPublish(q, { isPublished: true }), "Revenue was $2.3M.");
  const after = { ...q, brokerDraft: endorsedDraftOnPublish(q, { isPublished: true }), createdAt: new Date("2026-09-20"), updatedAt: new Date("2026-09-20") };
  assert.equal(isUnreviewedAiAnswer(after), false);
  assert.equal(answerStillHolds(after, { text: "", changedAt: new Date("2026-09-25"), held: false }), true, "an approval tick later doesn't withdraw it");
  assert.equal(endorsedDraftOnPublish(q, { isPublished: false }), null);
  assert.equal(endorsedDraftOnPublish(q, { isPublished: true, brokerDraft: "Mine" }), null, "an explicit draft is used as sent");
  assert.equal(endorsedDraftOnPublish({ ...q, brokerDraft: "Earlier draft" }, { isPublished: true }), null);
  assert.equal(endorsedDraftOnPublish({ ...q, status: "pending_broker" }, { isPublished: true }), null, "never a draft on a question back with the broker");
  assert.equal(endorsedDraftOnPublish(q, { isPublished: true, publishedAnswer: "Revenue was $2.3M in 2024." }), "Revenue was $2.3M in 2024.");
  // The auto-published AI answer is still unreviewed.
  assert.equal(isUnreviewedAiAnswer(q), true);
}

// ── known-2: premises owned by a related party and leased to the business ──
{
  assert.deepEqual(splitLeaseType("Owned by the seller's holding company and leased to the business at $8,000 per month"), {
    badge: "Leased",
    terms: "Owned by the seller's holding company and leased to the business at $8,000 per month",
  });
  assert.deepEqual(splitLeaseType("Owned by the seller's holding company"), { badge: null, terms: "Owned by the seller's holding company" });
  assert.deepEqual(splitLeaseType("Owned (leased back to the business)"), { badge: "Leased", terms: "Owned (leased back to the business)" });
  assert.equal(splitLeaseType("Owned").badge, "Owned");
  assert.equal(splitLeaseType("Owned by the company; no rent paid").badge, "Owned");
  assert.equal(splitLeaseType("Owned by the business, including the leasehold improvements").badge, "Owned");
  assert.equal(splitLeaseType("Rented month-to-month from the owner").badge, "Rented");
  assert.equal(splitLeaseType("Triple-net lease").badge, "Triple-net lease");
}

console.log("f2-cim-cont: ok");
