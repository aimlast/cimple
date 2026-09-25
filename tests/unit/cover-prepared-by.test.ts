/**
 * The cover's "Prepared by" is the brokerage from its brand settings — never
 * the AI's layoutData.preparedBy (Lakeshore, 2026-09-26: the seller's
 * accountant, on the normal AND blind covers). No brokerage name → no line.
 */
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CoverPageRenderer } from "../../client/src/components/cim/renderers/CoverPage";
import { buildBuyerCim } from "../../shared/cim-buyer-view";

// tsx compiles the app's JSX with the classic runtime (Vite uses the automatic one).
(globalThis as any).React = React;

const section = { id: "s1", dealId: "d", sectionTitle: "Cover", layoutType: "cover_page" } as any;
const render = (branding: Record<string, unknown>) =>
  renderToStaticMarkup(
    React.createElement(CoverPageRenderer, {
      layoutData: { businessName: "Lakeshore Home Comfort", preparedBy: "Bellamy & Rao LLP, Chartered Professional Accountants", date: "September 2026" },
      content: "",
      branding: branding as any,
      section,
    }),
  );

const none = render({});
assert.ok(!/Bellamy/.test(none), "the AI's preparedBy never renders");
assert.ok(!/Prepared by/.test(none), "no brokerage → no Prepared by line");

const withFirm = render({ firmName: "Brassline Advisory Partners" });
assert.match(withFirm, /Prepared by/);
assert.match(withFirm, /Brassline Advisory Partners/);
assert.ok(!/Bellamy/.test(withFirm));

// The buyer payload never carries the AI field either (normal, and DD).
const cover = {
  id: "c1", dealId: "d", sectionKey: "cover", sectionTitle: "Cover", order: 1, layoutType: "cover_page",
  layoutData: { businessName: "Lakeshore", preparedBy: "Bellamy & Rao LLP" }, isVisible: true, aiTask: null,
} as any;
for (const level of ["loi", "due_diligence"]) {
  const cim = buildBuyerCim({ deal: { id: "d", businessName: "Lakeshore" }, accessLevel: level, sections: [cover], overrides: [] });
  assert.equal(cim.sections.length, 1);
  assert.ok(!JSON.stringify(cim.sections[0].layoutData).includes("Bellamy"), `${level}: preparedBy stripped`);
}

console.log("cover-prepared-by: ok");
