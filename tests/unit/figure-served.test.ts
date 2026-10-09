/**
 * "Shown to buyers" reads what buyers are actually served (checker r1 F3;
 * spec §4.8: a live CIM's kept copy is anchored on its own sections).
 *
 * Pacific, live, buyers reading the kept copy while the update waits. In the
 * kept copy the income statement's opex and income-tax rows are labelled
 * "General & administrative expenses" / "Taxes on income", so they anchor
 * nothing there: a note approved on FY2023 income taxes reaches buyers only
 * once the update is published — the workspace says so and doesn't count it
 * as explained; a note on a figure both copies show is "Shown to buyers".
 *   npx tsx tests/unit/figure-served.test.ts
 */
import assert from "node:assert/strict";
import { fixtureRaw, noteRow, run, test } from "./helpers/figure-test";
import { buildWorkspace } from "../../server/cim/figures/workspace";
import { levelServing, servedFiguresOf, servedSummary, type ServedRows } from "../../server/cim/figures/served";
import { cimModeForAccessLevel as servedModeOf } from "../../shared/cim-layouts";
import { moveCounts, reviewItems } from "../../shared/figure-workspace";

const relabel = (sections: any[]) => sections.map((s) => s.sectionKey !== "financial_performance" ? s : {
  ...s,
  layoutData: {
    ...s.layoutData,
    rows: s.layoutData.rows.map((r: any) => /^operating expenses$/i.test(r.label) ? { ...r, label: "General & administrative expenses" }
      : /^income taxes$/i.test(String(r.label).trim()) ? { ...r, label: "Taxes on income" } : r),
  },
});

async function setup(opts: { ddShownAt?: Date | null } = {}) {
  const taxNote = noteRow({ id: "n-tax", figureKey: "incomeTaxes|2023", kind: "movement", compareKey: "2022", origin: "broker", status: "approved",
    text: "Lower taxable income after the warehouse move.", blindText: "Lower taxable income after a facility move.",
    valuesSnapshot: { year: "2023", value: 175685, fromYear: "2022", fromValue: 423900 } });
  const revNote = noteRow({ id: "n-rev", figureKey: "revenue|2024", kind: "context", compareKey: "", origin: "broker", status: "approved",
    text: "FY2024 includes a full year of the cold-chain contract.", blindText: "FY2024 includes a full year of a new contract.",
    valuesSnapshot: { year: "2024", value: 31020000 } });
  const { fx, raw } = await fixtureRaw("pacific", { notes: [taxNote, revNote], ddShownAt: opts.ddShownAt ?? null });
  const kept = relabel(fx.sections);
  const deal = { ...fx.deal, extractedInfo: fx.facts, isLive: true, cimGeneration: { buyerHold: { servingPublished: true } } } as any;
  const v = (sections: any[]) => ({ sections, overrides: [], published: null });
  const rows: ServedRows = {
    keptCopy: true, keptCodename: null, askingPrice: undefined,
    now: { normal: v(kept), blind: v(kept), dd: v(kept) },
    update: { normal: v(fx.sections), blind: v(fx.sections), dd: v(fx.sections) },
  };
  const served = servedFiguresOf(deal, raw, rows);
  const ws = buildWorkspace({ raw, sections: fx.sections, build: null, autoAsk: false, autoAskChosen: false, stale: false, ddBuyers: 1, dailyLimit: false, oldDdWording: false, served });
  return { fx, raw, served, ws };
}

test("levelServing: a level buildBuyerCim reads as each version (no literals, either side of the merge)", () => {
  for (const mode of ["normal", "blind", "dd"] as const) assert.equal(servedModeOf(levelServing(mode)), mode, mode);
});

test("the kept copy's pages decide what buyers read: income taxes FY2023 isn't on them", async () => {
  const { served } = await setup();
  assert.ok(!served.now.normal.anchored.has("incomeTaxes|2023"));
  assert.ok(served.afterPublish!.normal.anchored.has("incomeTaxes|2023"));
  assert.ok(served.now.normal.noteIds.has("n-rev"), "revenue FY2024 is on a page both copies show");
  assert.ok(!served.now.normal.noteIds.has("n-tax"));
  assert.ok(served.afterPublish!.normal.noteIds.has("n-tax"));
});

test("the workspace: 'Shows once you publish the update', not 'Shown to buyers'; not counted as explained", async () => {
  const { ws } = await setup();
  const tax = ws.moves.find((m) => m.figureKey === "incomeTaxes|2023")!;
  assert.equal(tax.status, "after_publish");
  assert.equal(tax.place, "update_only");
  assert.equal(tax.shown, false);
  const rev = ws.moves.find((m) => m.figureKey === "revenue|2024")!;
  assert.equal(rev.status, "shown");
  assert.equal(ws.kpis.changesExplained, ws.moves.filter((m) => m.status === "shown" && !m.folded).length);
  assert.ok(!ws.moves.some((m) => m.status === "shown" && m.figureKey === "incomeTaxes|2023"));
  assert.equal(moveCounts(ws.moves, { all: true }).publish >= 1, true);
  assert.equal(ws.served!.keptCopy, true);
  assert.equal(ws.served!.normal.notes, 1, "Full CIM buyers read one note now");
  assert.equal(ws.served!.normal.afterPublish, 1, "and one more once the update is published");
});

test("DD checks: shown only when DD buyers are served them; the opex rows of the kept copy carry none", async () => {
  const { ws, served } = await setup({ ddShownAt: new Date() });
  const opex = ws.checks.filter((c) => c.figureKey === "operatingExpenses|2023");
  assert.ok(opex.length > 0);
  for (const c of opex) {
    assert.equal(c.shownToBuyers, false, c.checkKey);
    assert.equal(c.onBuyerPage, false);
    assert.equal(c.afterPublish, c.state === "match" || c.state === "regrouped");
  }
  for (const c of ws.checks) assert.equal(c.shownToBuyers, served.now.dd.checkKeys.has(c.checkKey));
  // The review sheet says which differences only show after publishing.
  const later = reviewItems(ws).differences.filter((d) => /shows once you publish the update/.test(d.label));
  assert.ok(later.length >= 1, JSON.stringify(reviewItems(ws).differences));
  // The CIM tab's DD line reads the check page DD buyers are served.
  const s = servedSummary(served);
  assert.ok(s.dd.summary && s.dd.summary.checked === served.now.dd.checkKeys.size, JSON.stringify(s.dd));
});

test("buyers read the working copy (not live): everything as before", async () => {
  const { fx, raw } = await fixtureRaw("pacific", { notes: [noteRow({ id: "n-rev", figureKey: "revenue|2024", kind: "context", status: "approved", origin: "broker", text: "A note.", valuesSnapshot: { year: "2024", value: 31020000 } })] });
  const v = { sections: fx.sections as any[], overrides: [], published: null };
  const served = servedFiguresOf({ ...fx.deal, extractedInfo: fx.facts, isLive: false } as any, raw, { keptCopy: false, keptCodename: null, askingPrice: undefined, now: { normal: v, blind: v, dd: v }, update: null });
  const ws = buildWorkspace({ raw, sections: fx.sections, build: null, autoAsk: false, autoAskChosen: false, stale: false, ddBuyers: 0, dailyLimit: false, oldDdWording: false, served });
  assert.equal(ws.moves.find((m) => m.figureKey === "revenue|2024")!.status, "shown");
  assert.equal(ws.served!.keptCopy, false);
  assert.equal(ws.served!.normal.afterPublish, 0);
});

test("a CIM held from every buyer serves nothing", async () => {
  const { fx, raw } = await fixtureRaw("pacific", { notes: [noteRow({ id: "n-rev", figureKey: "revenue|2024", kind: "context", status: "approved", origin: "broker", text: "A note.", valuesSnapshot: { year: "2024", value: 31020000 } })] });
  const v = { sections: fx.sections as any[], overrides: [], published: null };
  const served = servedFiguresOf({ ...fx.deal, extractedInfo: fx.facts, isLive: true, cimGeneration: { buyerHold: { servingPublished: false } } } as any, raw, { keptCopy: false, keptCodename: null, askingPrice: undefined, now: { normal: v, blind: v, dd: v }, update: null });
  assert.equal(served.held, true);
  assert.equal(served.now.normal.noteIds.size, 0);
});

await run("figure-served (what buyers actually read)");
