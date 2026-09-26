/**
 * Round A (a-cim), ACC2-11 presentation:
 *  - body text in a table's title is drawn as a paragraph, never tracked
 *    capitals (the recorded Pacific Working Capital explainer), and an
 *    `intro` is drawn under a short caption;
 *  - the cover's "Prepared by" shows the deal's broker, with the brokerage
 *    name when there is one (the broker used to appear only on the last page).
 */
import "./react-global";
import assert from "node:assert/strict";
import React from "react";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { renderToStaticMarkup } from "react-dom/server";
import { ComparisonTableRenderer } from "../../client/src/components/cim/renderers/ComparisonTable";
import { CalloutListRenderer } from "../../client/src/components/cim/renderers/CalloutList";
import { CoverPageRenderer } from "../../client/src/components/cim/renderers/CoverPage";
import { CimDesignProvider, buildCimDesign } from "../../client/src/components/cim/CimDesignContext";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "cim");
const recorded = JSON.parse(fs.readFileSync(path.join(FIX, "pacific-acc2-sections.json"), "utf8"));
const wc = recorded.find((s: any) => s.sectionTitle === "Working Capital");
const section = { id: "s", dealId: "d", sectionTitle: "Working Capital", layoutType: "comparison_table" } as any;

// A paragraph stored in `title` (sections written before the tidy) reads as a paragraph.
const html = renderToStaticMarkup(React.createElement(ComparisonTableRenderer, { layoutData: wc.layoutData, content: "", branding: {} as any, section }));
assert.ok(!/<h3[^>]*uppercase[^>]*>The transaction will be structured/.test(html), "no tracked capitals for a paragraph");
assert.match(html, /<p class="text-sm leading-relaxed[^"]*">The transaction will be structured on a cash-free, debt-free basis/);

// A short caption stays a caption; `intro` is drawn under it.
const short = renderToStaticMarkup(
  React.createElement(ComparisonTableRenderer, {
    layoutData: { title: "As of December 31, 2024", intro: "Shown on a cash-free, debt-free basis — the same basis as the peg.", leftLabel: "Dec 31, 2024", rightLabel: "Peg", rows: [{ label: "Net working capital", left: "$2,538,000", right: "$2,400,000" }] },
    content: "",
    branding: {} as any,
    section,
  }),
);
assert.match(short, /<h3 class="[^"]*uppercase[^"]*">As of December 31, 2024<\/h3>/);
assert.match(short, /Shown on a cash-free, debt-free basis — the same basis as the peg\./);
const list = renderToStaticMarkup(
  React.createElement(CalloutListRenderer, { layoutData: { intro: "Three customers make up 36% of revenue.", items: [{ title: "A", description: "B" }] }, content: "", branding: {} as any, section: { ...section, layoutType: "callout_list" } }),
);
assert.match(list, /Three customers make up 36% of revenue\./, "intro on another renderer");

// Round 2: a title with an abbreviation is a caption, not a paragraph.
const abbr = renderToStaticMarkup(
  React.createElement(ComparisonTableRenderer, {
    layoutData: { title: "U.S. vs. Canadian Revenue", leftLabel: "FY2023", rightLabel: "FY2024", rows: [{ label: "U.S.", left: "$1,000", right: "$1,200" }] },
    content: "",
    branding: {} as any,
    section,
  }),
);
assert.match(abbr, /<h3 class="[^"]*uppercase[^"]*">U\.S\. vs\. Canadian Revenue<\/h3>/);
assert.ok(!/data-testid="block-intro"/.test(abbr), "no paragraph block");

// Cover: the broker's name with the brokerage, or alone.
const cover = (brokerage: Record<string, unknown>) =>
  renderToStaticMarkup(
    React.createElement(
      CimDesignProvider,
      { design: buildCimDesign({ brokerage }, "normal") },
      React.createElement(CoverPageRenderer, { layoutData: { businessName: "Pacific Coast Logistics Ltd.", date: "September 2026" }, content: "", branding: {} as any, section: { ...section, layoutType: "cover_page" } }),
    ),
  );
const both = cover({ firmName: "Brassline Advisory Partners", contactName: "Morgan Ellis" });
assert.match(both, /Prepared by/);
assert.match(both, /Brassline Advisory Partners/);
assert.match(both, /Morgan Ellis/);
const brokerOnly = cover({ contactName: "Morgan Ellis" });
assert.match(brokerOnly, /Prepared by[\s\S]*Morgan Ellis/, "a broker without a firm name still prepares the CIM");
assert.ok(!/Prepared by/.test(cover({})), "nothing to show → no line");

console.log("a-cim-render: ok");
