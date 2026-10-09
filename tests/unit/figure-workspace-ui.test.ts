/**
 * The Numbers & sources screens, server-rendered from the demo fixtures (no
 * browser, no DB, no AI): the tabs' rows and actions, the empty states, the
 * status pill and "Fix first" copy — plain language, the spec's words.
 *   npx tsx tests/unit/figure-workspace-ui.test.ts
 */
import "./react-global";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fixtureRaw, noteRow, run, test } from "./helpers/figure-test";
import { buildWorkspace } from "../../server/cim/figures/workspace";
import { MovesTab } from "../../client/src/pages/broker/deal/figures/MovesTab";
import { ChecksTab } from "../../client/src/pages/broker/deal/figures/ChecksTab";
import { QuestionsTab } from "../../client/src/pages/broker/deal/figures/QuestionsTab";
import { StatusPill } from "../../client/src/pages/broker/deal/figures/StatusPill";
import { FixFirst } from "../../client/src/pages/broker/deal/figures/FixFirst";

const h = React.createElement;
const noop = () => {};
const moveActions = { onOpenNote: noop, onUseHint: noop, onWrite: noop, onAsk: noop, onShow: noop, onHide: noop, onBulkShow: noop };
const checkActions = { onShow: noop, onLeaveOut: noop, onReadWrong: noop, onAsk: noop, onWrite: noop, onOpenNote: noop, onUndoLeaveOut: noop };
const questionActions = { onAsk: noop, onWrite: noop, onNotNeeded: noop, onReopen: noop, onAutoAsk: noop };

async function ws(name: "pacific" | "lakeshore", notes: any[] = [], questions: any[] = []) {
  const { fx, raw } = await fixtureRaw(name, { notes });
  return buildWorkspace({
    raw: { ...raw, questions }, sections: fx.sections, build: null, autoAsk: true, autoAskChosen: false, stale: false, ddBuyers: 1, dailyLimit: false, oldDdWording: false,
  });
}
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, " ");

test("Why figures moved: Cimple's hint with 'This is right, use it'; table and cards; the filters", async () => {
  const w = await ws("pacific");
  const html = renderToStaticMarkup(h(MovesTab, { moves: w.moves, filter: "all", onFilter: noop, actions: moveActions }));
  const t = text(html);
  assert.match(t, /Cimple's analysis suggests: “Warehouse lease commenced October 1, 2022/);
  assert.match(t, /\(not checked\)/);
  assert.match(t, /This is right, use it/);
  assert.match(t, /Ask the seller/);
  assert.match(t, /Write a reason/);
  assert.match(t, /No reason on file/);
  assert.ok(html.includes("lg:block") && html.includes("lg:hidden"), "a table at lg+, cards below");
});

test("waiting notes: the bulk bar counts them; an internal-only note needs the broker's own check", async () => {
  const { raw } = await fixtureRaw("pacific");
  const rent = Object.keys(raw.registry).find((k) => /^line:facility-rent/.test(k) && k.endsWith("|2023"))!;
  const fuel = "line:fuel|2023";
  const w = await ws("pacific", [
    noteRow({ id: "n1", figureKey: rent, kind: "movement", compareKey: "2022", origin: "ai", status: "suggested", text: "The warehouse lease started on October 1, 2022.", blindText: null, sources: [{ kind: "document", documentId: "x", quote: "The Commencement Date is October 1, 2022." }] }),
    noteRow({ id: "n2", figureKey: fuel, kind: "movement", compareKey: "2022", origin: "ai", status: "suggested", text: "From your note.", sources: [{ kind: "discrepancy", internal: true, quote: "my note" }] }),
  ]);
  const t = text(renderToStaticMarkup(h(MovesTab, { moves: w.moves, filter: "waiting", onFilter: noop, actions: moveActions })));
  assert.match(t, /2 notes are waiting for your OK\. Open any note to see what it's based on\./);
  assert.match(t, /1 note needs your own check first/);
  assert.match(t, /Show this one to buyers/);
  assert.match(t, /Not shown in the Blind CIM/);
});

test("Statements vs tax returns: grouped-differently rows with both figures and the reason; the empty state", async () => {
  const w = await ws("pacific");
  const t = text(renderToStaticMarkup(h(ChecksTab, { checks: w.checks, group: "regrouped", onGroup: noop, actions: checkActions, hasOtherRecords: true })));
  assert.match(t, /Due-diligence buyers see matches once the checks are on, and each difference once you show it\./);
  assert.match(t, /This CIM/);
  assert.match(t, /Tax return \(T2\)/);
  assert.match(t, /Grouped differently/);
  assert.match(t, /bank charges/);
  const empty = text(renderToStaticMarkup(h(ChecksTab, { checks: [], group: "difference", onGroup: noop, actions: checkActions, hasOtherRecords: false })));
  assert.match(empty, /No tax returns or other records to compare with yet\./);
});

test("Questions for the seller: the seller wording with the statements' figures, its state, the auto-ask switch", async () => {
  const q = { id: "q1", dealId: "d", figureKey: "line:fuel|2023", kind: "movement", compareKey: "2022", captureKey: "reasonFuelChange2023", question: "What was behind the drop in fuel in 2023?", valuesShown: { line: "fuel", fromYear: "2022", from: 5420000, year: "2023", value: 4760000 }, status: "ask_seller", routedAt: new Date("2026-10-09T00:00:00Z"), routedBy: "broker", raisedAt: null, sessionId: null, closedReason: null, createdAt: new Date(), updatedAt: new Date() };
  const w = await ws("pacific", [], [q]);
  const t = text(renderToStaticMarkup(h(QuestionsTab, { questions: w.questions, autoAsk: true, interviewDone: true, actions: questionActions })));
  assert.match(t, /What was behind the drop in fuel in 2023\? \(Your statements show \$5,420,000 in 2022 and \$4,760,000 in 2023\.\)/);
  assert.match(t, /Waiting for the seller \(emailed/);
  assert.match(t, /Ask during the interview automatically/);
  const none = text(renderToStaticMarkup(h(QuestionsTab, { questions: [], autoAsk: false, interviewDone: false, actions: questionActions })));
  assert.match(none, /No questions for the seller right now\./);
});

test("status pill and Fix first speak plainly", async () => {
  const off = text(renderToStaticMarkup(h(StatusPill, { ddShownAt: null, ddBuyers: 2, onReview: noop, onTurnOff: noop })));
  assert.match(off, /Due-diligence buyers: not seeing the checks yet/);
  assert.match(off, /Review and show to buyers/);
  const on = text(renderToStaticMarkup(h(StatusPill, { ddShownAt: "2026-10-10T12:00:00Z", ddBuyers: 2, onReview: noop, onTurnOff: noop })));
  assert.match(on, /seeing the checks since/);
  assert.match(on, /Turn off/);
  const w = await ws("pacific");
  const fix = text(renderToStaticMarkup(h(FixFirst, { items: w.fixFirst, dealId: "d", onCorrect: noop, onNavigate: noop })));
  assert.match(fix, /Fix first \(\d+\) — Your CIM's FY2022 figures don't match the statements\./);
});

await run("figure-workspace-ui");
