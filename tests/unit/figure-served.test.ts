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
import { moveCounts, nothingServedLine, publishTarget, reviewItems } from "../../shared/figure-workspace";

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

test("live, buyers read the working copy: everything as before", async () => {
  const { fx, raw } = await fixtureRaw("pacific", { notes: [noteRow({ id: "n-rev", figureKey: "revenue|2024", kind: "context", status: "approved", origin: "broker", text: "A note.", valuesSnapshot: { year: "2024", value: 31020000 } })] });
  const v = { sections: fx.sections as any[], overrides: [], published: null };
  const served = servedFiguresOf({ ...fx.deal, extractedInfo: fx.facts, isLive: true } as any, raw, { keptCopy: false, keptCodename: null, askingPrice: undefined, now: { normal: v, blind: v, dd: v }, update: { normal: v, blind: v, dd: v } });
  const ws = buildWorkspace({ raw, sections: fx.sections, build: null, autoAsk: false, autoAskChosen: false, stale: false, ddBuyers: 0, dailyLimit: false, oldDdWording: false, served });
  assert.equal(ws.moves.find((m) => m.figureKey === "revenue|2024")!.status, "shown");
  assert.equal(ws.served!.keptCopy, false);
  assert.equal(ws.served!.notLive, false);
  assert.equal(ws.served!.normal.afterPublish, 0);
  assert.equal(nothingServedLine(ws.served), null);
});

/** A CIM no buyer can read yet: the view room serves nothing (not live), the rows are the working copy. */
async function unpublished(dealOver: Record<string, unknown>, ddShownAt: Date | null = null) {
  const depreciation = noteRow({ id: "n-da", figureKey: "amortization|2024", kind: "movement", compareKey: "2023", origin: "broker", status: "approved",
    text: "Two new trailers were bought in 2024.", blindText: "New equipment was bought in 2024.", valuesSnapshot: { year: "2024", value: 0, fromYear: "2023", fromValue: 0 } });
  const { fx, raw } = await fixtureRaw("pacific", { notes: [depreciation], ddShownAt });
  // The note's snapshot must hold the figures it was approved on.
  const fig = raw.registry["amortization|2024"]!;
  const prev = raw.registry["amortization|2023"]!;
  depreciation.valuesSnapshot = { year: "2024", value: fig.value, fromYear: "2023", fromValue: prev.value };
  const v = { sections: fx.sections as any[], overrides: [], published: [] as any[] };
  const deal = { ...fx.deal, extractedInfo: fx.facts, ...dealOver } as any;
  // loadServedRows builds the working copy as the update whenever buyers are served nothing; the
  // pure function stands in for it when the rows don't carry one.
  const served = servedFiguresOf(deal, raw, { keptCopy: false, keptCodename: null, askingPrice: undefined, now: { normal: v, blind: v, dd: v }, update: null });
  const ws = buildWorkspace({ raw, sections: fx.sections, build: null, autoAsk: false, autoAskChosen: false, stale: false, ddBuyers: 0, dailyLimit: false, oldDdWording: false, served });
  return { fx, raw, served, ws };
}

test("checker r2: a held CIM that was never live — an approved note 'Shows once you publish the CIM', counted as such", async () => {
  const { served, ws } = await unpublished({ isLive: false, cimGeneration: { buyerHold: { servingPublished: false } } });
  assert.equal(served.held, true);
  assert.equal(served.notLive, true);
  for (const v of ["normal", "blind", "dd"] as const) assert.equal(served.now[v].noteIds.size, 0, `${v}: nothing is served now`);
  assert.ok(served.afterPublish, "the working copy stands for 'once you publish'");
  assert.ok(served.afterPublish!.normal.noteIds.has("n-da"));
  const m = ws.moves.find((x) => x.figureKey === "amortization|2024")!;
  assert.equal(m.status, "after_publish", "never 'Approved · not on a page buyers read'");
  assert.equal(m.place, "page", "on a page of the CIM buyers will read");
  assert.equal(m.unservedWhy, undefined);
  assert.equal(ws.kpis.changesExplained, 0);
  assert.equal(ws.kpis.changesAfterPublish, 1, "the KPI counts it as 'once you publish'");
  assert.equal(ws.served!.normal.notes, 0);
  assert.equal(ws.served!.normal.afterPublish, 1, "the CIM tab line: 1 figure has a note · buyers read it once you publish the CIM");
  assert.equal(publishTarget(ws.served), "the CIM");
  assert.equal(nothingServedLine(ws.served), "This CIM isn't published yet — buyers see these once you publish it.");
});

test("not live and not held: the same (the view room serves nothing until the CIM is published)", async () => {
  const { served, ws } = await unpublished({ isLive: false, cimGeneration: null });
  assert.equal(served.held, false);
  assert.equal(served.notLive, true);
  assert.equal(served.now.normal.noteIds.size, 0, "never 'Shown to buyers' on a CIM nobody can open");
  assert.equal(ws.moves.find((x) => x.figureKey === "amortization|2024")!.status, "after_publish");
});

test("not published, DD checks on: checks are on the CIM's pages, 'shows once you publish', and the CIM tab's DD count reads the pages buyers will read", async () => {
  const { served, ws } = await unpublished({ isLive: false, cimGeneration: { buyerHold: { servingPublished: false } } }, new Date());
  assert.equal(served.now.dd.checkKeys.size, 0);
  assert.ok(served.afterPublish!.dd.checkKeys.size > 0);
  assert.ok(served.ddIfOn && served.ddIfOn.checked > 0, "the would-be check page is counted");
  const onPage = ws.checks.filter((c) => c.onBuyerPage);
  assert.ok(onPage.length > 0, "the checks sit on pages of the CIM");
  for (const c of ws.checks) assert.equal(c.shownToBuyers, false, c.checkKey);
  assert.ok(ws.checks.some((c) => c.afterPublish));
  assert.ok(!reviewItems(ws).differences.some((d) => /publish the update/.test(d.label)), "never 'the update' on a CIM that was never published");
});

test("live and held (an update failed its checks): nothing served now; 'once you publish the update'", async () => {
  const { served, ws } = await unpublished({ isLive: true, cimGeneration: { buyerHold: { servingPublished: false } } });
  assert.equal(served.held, true);
  assert.equal(served.notLive, false);
  assert.equal(ws.moves.find((x) => x.figureKey === "amortization|2024")!.status, "after_publish");
  assert.equal(publishTarget(ws.served), "the update");
  assert.match(nothingServedLine(ws.served) ?? "", /can't read this CIM right now/);
});

await run("figure-served (what buyers actually read)");
