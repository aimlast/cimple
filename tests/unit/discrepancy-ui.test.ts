/**
 * Discrepancy UI pieces rendered to static markup: readable labels, the
 * settled check mark for "accepted", merge rows, and the Overview CTA that
 * names open critical discrepancies.
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/discrepancy-ui.test.ts
 */
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DiscrepancyHeaderLine } from "../../client/src/components/deal/DiscrepancyHeaderLine";
import { ReadyToBuildCta, ctaCopy } from "../../client/src/components/deal/ReadyToBuildCta";
import { checkNoticeText } from "../../client/src/components/deal/DiscrepancyCheckNotice";
import { humanizeFieldKey, discrepancySideHeading, discrepancySideValue } from "../../shared/discrepancy-sides";

// The client is built with the automatic JSX runtime; tsx compiles .tsx with the classic one.
(globalThis as any).React = React;
const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const base = { severity: "minor", category: "operational", source: "interview", interviewValue: "$8,000/month", documentValue: "$8,000/month" };

// ── A raw key reads as words; "accepted" shows the settled check ──
{
  const out = html(React.createElement(DiscrepancyHeaderLine, { disc: { ...base, field: "yardRentActual", status: "accepted" } }));
  assert.match(out, />Yard rent actual</);
  assert.match(out, /data-testid="discrepancy-settled"/);
  const open = html(React.createElement(DiscrepancyHeaderLine, { disc: { ...base, field: "driverCount", status: "open" } }));
  assert.match(open, />Driver count</);
  assert.doesNotMatch(open, /discrepancy-settled/);
  assert.equal(humanizeFieldKey("adjustedEBITDA2024"), "Adjusted EBITDA 2024");
  assert.equal(humanizeFieldKey("maritimeSmilesMRRPercentage"), "Maritime smiles MRR percentage");
  assert.equal(humanizeFieldKey("Alderbrook revenue percentage"), "Alderbrook revenue percentage");
}

// ── Merge rows (raised by the fact merge) ──
{
  const merge = {
    ...base,
    field: "leaseExpiry",
    factKey: "leaseExpiry",
    source: "merge",
    status: "open",
    severity: "significant",
    category: "legal",
    interviewValue: "about 2029",
    documentValue: "August 31, 2028",
    sideSources: { interview: { kind: "call", documentId: "c1" }, document: { kind: "document", documentId: "d1", label: "Premises lease" } },
  };
  const out = html(React.createElement(DiscrepancyHeaderLine, { disc: merge }));
  assert.match(out, /Sources disagree/);
  assert.match(out, />Lease expiry</);
  assert.equal(discrepancySideHeading(merge, "interview"), "Call said");
  assert.equal(discrepancySideHeading(merge, "document"), "Document shows");
  assert.equal(discrepancySideValue(merge, "document"), "August 31, 2028");
  // A private side is marked, and named as the broker's own notes.
  const priv = { ...merge, sideSources: { interview: { kind: "crm", brokerOnly: true }, document: merge.sideSources.document } };
  assert.match(html(React.createElement(DiscrepancyHeaderLine, { disc: priv })), /Private/);
  assert.equal(discrepancySideHeading(priv, "interview"), "Your private notes");
  // Financial-analysis values drop their " — source" label when accepted.
  assert.equal(discrepancySideValue({ source: "financial_analysis", interviewValue: "$1,950,000 — Seller interview" }, "interview"), "$1,950,000");
}

// ── Overview CTA: interview done + one open critical ──
{
  const out = html(React.createElement(ReadyToBuildCta, { criticalCount: 1, onContinue: () => {}, onReview: () => {} }));
  assert.match(out, /1 critical discrepancy/);
  assert.doesNotMatch(out, /Ready to build the CIM/);
  assert.match(out, /Review discrepancies/);
  assert.match(ctaCopy(2).title, /resolve 2 critical discrepancies before generating/);
  const clear = html(React.createElement(ReadyToBuildCta, { criticalCount: 0, onContinue: () => {}, onReview: () => {} }));
  assert.match(clear, /Ready to build the CIM/);
  assert.match(clear, /Continue to Content Creation/);
}

// ── "Check not run since N new sources" ──
{
  assert.equal(checkNoticeText({ canRun: true, checkedAt: "2026-09-20T00:00:00Z", stale: true, newSources: 2, claimsChanged: false }), "Discrepancy check not run since 2 new sources. Generating runs it first.");
  assert.match(checkNoticeText({ canRun: true, checkedAt: null, stale: true, newSources: 3, claimsChanged: false })!, /haven't been checked/);
  assert.equal(checkNoticeText({ canRun: true, checkedAt: "x", stale: false, newSources: 0, claimsChanged: false }), null);
  assert.equal(checkNoticeText({ canRun: false, checkedAt: null, stale: false, newSources: 0, claimsChanged: false }), null);
}

console.log("discrepancy-ui: ok");
