/**
 * Merge step 8 (feat/oct-dd into release/oct): the integrator's wiring of dd
 * into vdr, gl, together, teaser and heatmap (INTEGRATION §6 #8, §2.2–2.14,
 * C12/C13/C15/C16). No AI, no database (PGlite for dd's figure tables, stubs
 * for the rest), no email.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/dd-merge-wiring.test.ts
 */
import "./react-global";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { figurePglite, run, test } from "./helpers/figure-test";

process.env.ANTHROPIC_API_KEY = "disabled";
process.env.DISABLE_SCHEDULERS = "1";
delete process.env.RESEND_API_KEY;
// dd's figure tables in PGlite — started before the browser stub below (PGlite reads `window` to pick its runtime).
const { db } = await figurePglite();
(globalThis as any).window ??= { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), setTimeout, clearTimeout, location: { href: "http://x/" }, innerWidth: 1440, addEventListener() {}, removeEventListener() {} };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = (p: string) => readFileSync(join(ROOT, p), "utf8");

const { storage } = await import("../../server/storage");
const { _useFigureDbForTests, insertQuestionIfAbsent } = await import("../../server/cim/figures/store");
const { loadFigureBoardItems, registerFigureBoardLoader } = await import("../../server/together/figure-board");
const { registerDdTogetherWiring, _resetDdTogetherWiringForTests } = await import("../../server/routes/dd-together-wiring");
const { sendFollowUpEmail, _setFollowUpPathForTests, _setSittingEndHooksForTests } = await import("../../server/together/summary");
const { followUpNoticeText } = await import("../../server/interview/seller-followups");
const adapter = await import("../../server/vdr/dd-adapter");
const { citationLabel, citableDocument } = await import("../../shared/vdr");
const { figureCitationLabel, figureCitableDocument } = await import("../../shared/figure-layer");
const slots = await import("../../client/src/pages/broker/deal/cim-tab-slots");
const lines = await import("../../client/src/pages/broker/deal/figures/CimTabLines");
const { BLIND_ACCESS_LEVEL, DD_ACCESS_LEVEL, NAMED_ACCESS_LEVEL } = await import("../../shared/access-levels");

_useFigureDbForTests(db);

// ── together × dd ─────────────────────────────────────────────────────────
test("the coverage board's 'Numbers' items come from dd once the wiring runs (together's seam, §2.5)", async () => {
  await insertQuestionIfAbsent("deal-b", {
    figureKey: "line:fuel|2023", kind: "movement", compareKey: "2022", captureKey: "reasonFuelChange2023",
    question: "What was behind the drop in fuel costs in 2023?", valuesShown: { line: "fuel" }, status: "suggested", routedBy: null,
  } as any);
  registerFigureBoardLoader(null);
  assert.deepEqual(await loadFigureBoardItems("deal-b"), [], "no loader → nothing");
  _resetDdTogetherWiringForTests();
  registerDdTogetherWiring();
  const items = await loadFigureBoardItems("deal-b");
  assert.equal(items.length, 1);
  assert.equal(items[0].origin, "figures");
  assert.equal(items[0].sectionKey, "financials");
  assert.equal(items[0].writeKey, "reasonFuelChange2023");
  assert.equal(items[0].critical, false);
  // Registered once, at start-up, right after dd's routes.
  const routes = src("server/routes.ts");
  assert.ok(routes.indexOf("registerFigureRoutes(app);") < routes.indexOf("registerDdTogetherWiring();"));
  const wiring = src("server/routes/dd-together-wiring.ts");
  assert.match(wiring, /registerSittingEndHooks\(\{[\s\S]*explainQuestionsRaised:[\s\S]*markExplainQuestionsRaised[\s\S]*scheduleFigureBuild[\s\S]*planExplainQuestions/);
});

// The end-of-sitting email (C15): one path once the interview is finished.
const board: any = {
  dealId: "deal-e", audience: "broker", sections: [{ key: "financials", items: [{ id: "financials:fleetAge", label: "Average age of the fleet", status: "missing", ask: "How old are the trucks, on average?", origin: "industry" }] }],
  documents: [{ requirementId: "req-1", name: "Fleet list" }],
};
_setSittingEndHooksForTests({ loadBoard: async () => board });
const s = storage as any;
s.getSellerInvitesByDealId = async () => [{ id: "inv", dealId: "deal-e", token: "tok-e", sellerEmail: "seller@qa-oct.invalid", sellerName: "Sam", status: "sent" }];
s.getUser = async () => ({ id: "b1", name: "Morgan Broker", email: "broker@qa-oct.invalid" });
const calls: any[] = [];
const direct: any[] = [];
let nextResult: any = { interviewFinished: true, emailed: 1, addressed: 1 };
_setFollowUpPathForTests({
  async words(_dealId, extra) { return followUpNoticeText(2 + extra.items, extra.documents); },
  async send(dealId, opts) { calls.push({ dealId, ...opts }); return nextResult; },
});
const sitting: any = { id: "sit-1", dealId: "deal-e", sellerSeesScreen: false, summary: null };
const deal = (over: any = {}): any => ({ id: "deal-e", businessName: "Pacific Coast Logistics Ltd.", interviewCompleted: true, demoKey: null, extractedInfo: {}, interviewOutline: null, ...over });
const send = async (to: string, subject: string) => { direct.push({ to, subject }); return true; };
const args = (d: any, preview: boolean) => ({ deal: d, sitting, itemIds: ["financials:fleetAge"], documentIds: ["req-1", "req-unknown"], preview, brokerId: "b1", send });

test("finished interview: the preview is the one follow-up email's own words; the send goes through dd's sendSellerFollowUps", async () => {
  calls.length = 0; direct.length = 0;
  const p = await sendFollowUpEmail(args(deal(), true));
  assert.equal(p.subject, followUpNoticeText(3, 1).title, "2 already waiting + this ask");
  assert.match(p.html, /They'd also like one document from you/);
  assert.equal(calls.length + direct.length, 0, "a preview sends nothing");
  const r = await sendFollowUpEmail(args(deal(), false));
  assert.equal(r.sent, true);
  assert.equal(direct.length, 0, "never a second, separate email");
  assert.deepEqual(calls, [{ dealId: "deal-e", extraItems: ["How old are the trucks, on average?"], documents: ["req-1"] }]);
});

test("finished interview, a follow-up email in the last hour: added to it, never a second email", async () => {
  calls.length = 0; direct.length = 0;
  nextResult = { interviewFinished: true, emailed: 0, addressed: 0, recentlyEmailed: true };
  const r = await sendFollowUpEmail(args(deal(), false));
  assert.equal(r.sent, false);
  assert.equal(r.alreadyEmailed, true);
  assert.equal(calls.length, 1);
  assert.equal(direct.length, 0);
  nextResult = { interviewFinished: true, emailed: 1, addressed: 1 };
});

test("interview still running: dd's path never emails then, so the sitting's own email lists the asks (still one email)", async () => {
  calls.length = 0; direct.length = 0;
  const p = await sendFollowUpEmail(args(deal({ interviewCompleted: false }), true));
  assert.match(p.subject, /a few things to finish your business overview/);
  assert.ok(p.html.includes("How old are the trucks, on average?"));
  const r = await sendFollowUpEmail(args(deal({ interviewCompleted: false }), false));
  assert.equal(r.sent, true);
  assert.equal(calls.length, 0);
  assert.equal(direct.length, 1);
});

test("a demo deal records the send and never emails, on either path", async () => {
  calls.length = 0; direct.length = 0;
  for (const interviewCompleted of [true, false]) {
    const r = await sendFollowUpEmail(args(deal({ demoKey: "pacific-qa", interviewCompleted }), false));
    assert.equal(r.recorded, true);
    assert.equal(r.sent, false);
  }
  assert.equal(calls.length + direct.length, 0);
});

test("the seller's follow-up count adds dd's figure questions and together's open items, each once (§2.11 / C16)", () => {
  const routes = src("server/routes.ts");
  assert.match(routes, /allDiscrepanciesForProgress\.filter\(\(d\) => d\.status === "ask_seller" && !!routedToSellerAt\(d\)\)\.length\s*\+ \(await figureQuestionsWithSeller\(deal\.id\)\)[^\n]*\n\s*\+ followUpItemsOpen/);
});

test("a seller ending the session: together's completeDealInterview, then dd's hand-back of the questions about the numbers", () => {
  const sm = src("server/interview/session-manager.ts");
  const end = sm.slice(sm.indexOf("export async function endSessionManually"), sm.indexOf("export async function reopenInterview"));
  const iComplete = end.indexOf("await completeDealInterview(dealId, { mode, messages, byDealBroker });");
  const iExplain = end.indexOf("await markExplainQuestionsRaised(dealId, sessionId, messages, { completedInterview: true });");
  assert.ok(iComplete > 0 && iExplain > iComplete);
});

// ── vdr × dd ──────────────────────────────────────────────────────────────
test("dd's document helpers ARE vdr's (§2.6): the neutral label and the citable rule", () => {
  for (const ref of [{ kind: "tax_return", period: "2023" }, { kind: "financial_statements", period: "2024-06" }, { kind: "lease", period: "garbage" }, { kind: "other", period: null }] as any[]) {
    assert.equal(figureCitationLabel(ref), citationLabel(ref));
  }
  assert.equal(figureCitationLabel({ kind: "financial_statements", period: "2024-06" } as any), "Financial statements Jun 2024");
  const docs: any[] = [
    { visibility: "broker_only", sourceKind: "document", fileUrl: "/uploads/docs/a", category: "financial", subcategory: null },
    { visibility: null, sourceKind: "document", fileUrl: "/uploads/docs/b", category: "email", subcategory: null },
    { visibility: null, sourceKind: "crm", fileUrl: "/uploads/docs/c", category: "financial", subcategory: null },
    { visibility: null, sourceKind: null, fileUrl: null, category: "financial", subcategory: null },
    { visibility: null, sourceKind: "document", fileUrl: "/uploads/docs/e", category: "financial", subcategory: "tax_return" },
  ];
  for (const d of docs) assert.equal(figureCitableDocument(d), citableDocument(d));
  assert.deepEqual(docs.map((d) => figureCitableDocument(d)), [false, false, false, false, true]);
  const chip = src("client/src/components/cim/figures/FigureCitation.tsx");
  assert.match(chip, /<VdrCitationChip docRef=\{docRef\}/);
});

test("the data room's 'what the DD CIM cites' reads dd's registry: null without a CIM, [] when nothing is cited, unique ids", async () => {
  const deps = (rows: any[], hasCim: boolean) => ({ cited: async () => rows, hasCim: async () => hasCim });
  assert.equal(await adapter.ddCitedDocumentIds("d1", deps([], false)), null);
  assert.deepEqual(await adapter.ddCitedDocumentIds("d1", deps([], true)), []);
  assert.deepEqual(await adapter.ddCitedDocumentIds("d1", deps([{ documentId: "t2", sectionId: "s1" }, { documentId: "t2", sectionId: "dd-source-check" }, { documentId: "fs", sectionId: "s1" }], true)), ["t2", "fs"]);
  const sections = async () => [{ id: "s1", sectionTitle: "Financial overview", isVisible: true }, { id: "s2", sectionTitle: "Hidden", isVisible: false }];
  const cited = await adapter.ddCitedSections("d1", "t2", {
    ...deps([{ documentId: "t2", sectionId: "s1", page: 3 }, { documentId: "t2", sectionId: "dd-source-check" }, { documentId: "t2", sectionId: "s2" }, { documentId: "fs", sectionId: "s1" }], true),
    sections,
  });
  assert.deepEqual(cited, [{ sectionId: "s1", title: "Financial overview", page: 3 }, { sectionId: "dd-source-check", title: "How the figures check out", page: null }]);
});

test("document checks: buyers read what DD buyers are served; the broker falls back to the discrepancy checks when dd has none", async () => {
  (storage as any).getDeal = async () => undefined;
  assert.deepEqual(await adapter.ddDocumentChecks("nope", "doc"), []);
  assert.equal(await adapter.ddDocumentChecks("nope", "doc", { audience: "broker" }), null);
  assert.match(src("server/routes/data-room.ts"), /ddDocumentChecks\(deal\.id, doc\.id, \{ audience: "broker" \}\)/);
});

// ── gl × dd and the providers ─────────────────────────────────────────────
test("providers: the view room and the builder preview put the figure layer inside the data room's links, with gl's marks", () => {
  const room = src("client/src/pages/BuyerViewRoom.tsx");
  const iV = room.indexOf("<VdrLinkProvider source={{ kind: \"buyer\"");
  const iG = room.indexOf("<GlRoomLinkProvider>");
  const iF = room.indexOf("<FigureLayerProvider layer={data.figureLayer ?? null}");
  const iM = room.indexOf("<GlMarksProvider marks={glMarkedLineIds(visibleSections)}>");
  assert.ok(iV > 0 && iV < iG && iG < iF && iF < iM, "Vdr → GlRoom → FigureLayer → GlMarks (§2.4)");
  const canvas = src("client/src/components/cim-builder/CimCanvas.tsx");
  const cV = canvas.indexOf("<VdrLinkProvider source={{ kind: \"broker\", dealId: deal.id }}>");
  const cG = canvas.indexOf("<GlRoomLinkProvider>");
  const cM = canvas.indexOf("<GlMarksProvider marks={glMarkedLineIds(shown)}>");
  const cF = canvas.indexOf("<FigureLayerProvider layer={fig.data?.layer ?? null} broker={figActions.hooks}>");
  assert.ok(cV > 0 && cV < cG && cG < cM && cM < cF, "broker preview: Vdr(broker) → GlRoom → GlMarks → FigureLayer");
});

test("an indexed chart (the teaser's trend) carries no figures (§2.7 rule 4)", () => {
  assert.match(src("client/src/components/cim/renderers/LineChart.tsx"), /figFor=\{indexed \? undefined : figFor\}/);
});

// ── teaser's CIM tab slots (§2.8, C12, C13) ──────────────────────────────
test("CIM tab: Numbers & sources is the fifth view; dd's lines go first in every slot", () => {
  assert.deepEqual(slots.EXTRA_CIM_TAB_VIEWS.map((v) => [v.key, v.label]), [["numbers", "Numbers & sources"]]);
  assert.equal(slots.EXTRA_CIM_TAB_VIEWS[0].useBadge, lines.useFigureNotesWaiting);
  assert.deepEqual(slots.ACCESS_TILE_LINES.map((x) => x.key), ["dd", "vdr"]);
  assert.deepEqual(slots.VERSION_CARD_EXTRAS.map((x) => x.key), ["dd", "gl"]);
  assert.deepEqual(slots.ATTENTION_GROUPS.map((x) => x.key), ["dd"]);
  const tab = src("client/src/pages/broker/deal/CimTab.tsx");
  assert.ok(!/view === "numbers"\) return <NumbersWorkspace/.test(tab), "no separate switch: the dashboard's slot is the only way in");
  assert.match(tab, /detail=\{DD_VERSION_DETAIL\}/);
  assert.ok(!/verification notes/.test(tab));
  assert.match(tab, /const PASS_THROUGH = \["tab", "note", "filter", "group", "all"\];/);
});

test("tile lines: notes per version, the DD checks shown or not yet — never more than vdr's two-line budget allows", () => {
  const sum = (o: any) => ({ checked: 27, matching: 21, regrouped: 4, differing: 2, explained: 2, ...o });
  const ws = (served: any, status: any = {}) => ({ status: { hasCim: true, noFigures: null, hasOtherRecords: true, ...status }, served } as any);
  const v = (notes: number, afterPublish = 0) => ({ notes, afterPublish, dropped: null });
  const live = lines.figureTileLinesOf(ws({ keptCopy: false, held: false, notLive: false, normal: v(9), blind: v(1), dd: { ...v(9), summary: sum({}), summaryIfOn: sum({}) } }), "D");
  assert.deepEqual(live[NAMED_ACCESS_LEVEL]!.map((l) => l.text), ["+ notes on 9 figures"]);
  assert.deepEqual(live[BLIND_ACCESS_LEVEL]!.map((l) => l.text), ["+ notes on 1 figure"]);
  assert.deepEqual(live[DD_ACCESS_LEVEL]!.map((l) => l.text), ["+ figure checks · 6 differences shown"]);
  const off = lines.figureTileLinesOf(ws({ keptCopy: false, held: false, notLive: true, normal: v(0, 3), blind: v(0), dd: { ...v(0), summary: null, summaryIfOn: sum({}) } }), "D");
  assert.deepEqual(off[NAMED_ACCESS_LEVEL]!.map((l) => l.text), ["+ notes on 3 figures once published"]);
  assert.deepEqual(off[BLIND_ACCESS_LEVEL], []);
  assert.deepEqual(off[DD_ACCESS_LEVEL]!.map((l) => l.text), ["+ figure checks (not shown yet)"]);
  assert.deepEqual(lines.figureTileLinesOf(ws(null), "D"), {});
  assert.deepEqual(lines.figureTileLinesOf(ws({ normal: v(1), blind: v(1), dd: { ...v(1), summary: null, summaryIfOn: null } }, { noFigures: "no_analysis" }), "D"), {});
  const noT2 = lines.figureTileLinesOf(ws({ keptCopy: false, held: false, notLive: false, normal: v(0), blind: v(0), dd: { ...v(0), summary: null, summaryIfOn: null } }, { hasOtherRecords: false }), "D");
  assert.equal(noT2[DD_ACCESS_LEVEL], undefined, "no tax returns on file: no DD line");
  assert.ok(slots.tileLinesFor(DD_ACCESS_LEVEL, [live, { [DD_ACCESS_LEVEL]: [{ key: "a", text: "vdr 1" }, { key: "b", text: "vdr 2" }] }]).length === 2);
});

// ── buildBuyerCim with both extras (INTEGRATION §2.2 steps 3–7, §6 "after wave 3") ──
test("buildBuyerCim with BOTH extras: gl's page after the bridge, dd's check page after its table; one anchor reads anchor → check → gl; none outside DD", async () => {
  const { fixtureRaw: fxRaw } = await import("./helpers/figure-test");
  const { figureInputsFor } = await import("../../server/cim/figures/serve");
  const { buildBuyerCim } = await import("../../shared/cim-buyer-view");
  const { DD_SOURCE_CHECK_PAGE_ID } = await import("../../shared/figure-layer");
  const { glEvidenceAnchor } = await import("../../shared/gl-evidence");
  const { fx, raw } = await fxRaw("lakeshore", { ddShownAt: new Date() });
  const sections = fx.sections.map((x) => ({ ...x, isVisible: true, aiDraftContent: null, brokerEditedContent: null })) as any[];
  const glEvidence: any = {
    mode: "dd", publishedAt: "2026-10-01T00:00:00.000Z", pageId: "glsec_0123456789ab",
    summary: { total: 1, found: 1, partly: 0, notFound: 0, document: 0, statement: 0 }, note: null,
    lines: [{ lineId: "aaaaaaaaaaaa", status: "found", mark: true, label: "Owner vehicles", years: [] }],
  };
  const dd = buildBuyerCim({ deal: fx.deal as any, accessLevel: DD_ACCESS_LEVEL, sections, overrides: [], figures: figureInputsFor(raw, { audience: "buyer", mode: "dd" }), glEvidence });
  const ids = dd.sections.map((x) => x.id);
  const iCheck = ids.indexOf(DD_SOURCE_CHECK_PAGE_ID);
  const iGl = ids.indexOf(glEvidence.pageId);
  assert.ok(iCheck > 0 && iGl > 0, "both pages are served to a due-diligence buyer");
  assert.ok(dd.figureLayer && dd.glEvidence === glEvidence);
  assert.equal(dd.figureLayerDropped, null);
  assert.ok(["financial_table", "comparison_table"].includes(dd.sections[iCheck - 1].layoutType), "the check page follows its table");
  const glAnchorId = sections[glEvidenceAnchor(sections)].id;
  const before = dd.sections[iGl - 1];
  assert.ok(before.id === glAnchorId || (before.id === DD_SOURCE_CHECK_PAGE_ID && dd.sections[iGl - 2].id === glAnchorId), "gl's page follows its anchor (or the check page on the same anchor)");
  // Orders stay strictly increasing (renderers and the reading tracker sort by them).
  for (let k = 1; k < dd.sections.length; k++) assert.ok(dd.sections[k].order > dd.sections[k - 1].order, `order rises at ${k}`);
  // Full CIM: neither page; Teaser: nothing at all.
  const full = buildBuyerCim({ deal: fx.deal as any, accessLevel: NAMED_ACCESS_LEVEL, sections, overrides: [], figures: figureInputsFor(raw, { audience: "buyer", mode: "normal" }), glEvidence });
  assert.ok(!full.sections.some((x) => x.id === DD_SOURCE_CHECK_PAGE_ID || x.id === glEvidence.pageId));
  const teaser = buildBuyerCim({ deal: fx.deal as any, accessLevel: "teaser_only", sections, overrides: [], figures: figureInputsFor(raw, { audience: "buyer", mode: "dd" }), glEvidence });
  assert.deepEqual([teaser.sections.length, teaser.figureLayer, teaser.glEvidence], [0, null, null]);
});

await run("dd-merge-wiring");
_setFollowUpPathForTests(null);
_setSittingEndHooksForTests(null);
process.exit(0);
