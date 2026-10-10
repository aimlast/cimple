/**
 * The AI pass with a STUBBED model (spec D8, D19, §9.5–9.6). No network, no
 * cost: the model client is replaced (_setFigureNotesClientForTests) and the
 * store runs on an in-process Postgres (PGlite).
 *   npx tsx tests/unit/figure-notes-ai.test.ts
 *
 * Proves: the request (claude-sonnet-4-5, tool forced, temperature 0, the
 * evidence block prompt-cached, hints marked uncitable); recorded tool
 * outputs are stored as SUGGESTED notes with their quoted sources; a guard
 * failure or "no_reason_on_file" stores nothing and hands the figure to the
 * question planner; an API error changes nothing and records why; the daily
 * cap holds (4 calls; a 5th build is refused before any call); a second build
 * with nothing changed calls nothing; a note the broker edited while the
 * model was reading keeps the broker's version; the keep-out review is never
 * called from the broker-text guard or serving (spy), and counts against
 * the cap when the build runs it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { figurePglite, fixtureRaw, run, test } from "./helpers/figure-test";
import { _setFigureNotesClientForTests, figureNotesRequest, parseFigureReasons } from "../../server/cim/figures/ai";
import { _setBuildDepsForTests, _setKeepOutReviewForTests, runFigureBuild } from "../../server/cim/figures/build";
import { buildFigureEvidence } from "../../server/cim/figures/evidence";
import { _useFigureDbForTests, brokerUpdateNote, getFigureState, listNotes } from "../../server/cim/figures/store";
import { screenCtxFor } from "../../server/cim/figures/guards";
import { assembleFigureRaw } from "../../server/cim/figures/serve";

const { db } = await figurePglite();
_useFigureDbForTests(db);

const { fx, raw: baseRaw } = await fixtureRaw("pacific");
const DEAL = fx.deal.id;
const LEASE_TEXT = "WAREHOUSE LEASE (sample document — fictional business). The Commencement Date is October 1, 2022. The Term is fifteen (15) years.";

/** The raw inputs with the notes now on the PGlite store (as loadFigureRaw would read them). */
async function rawNow() {
  const notes = await listNotes(DEAL);
  return { ...baseRaw, notes };
}

let calls: any[] = [];
let mode: "answer" | "error" | "nothing" = "answer";
_setFigureNotesClientForTests({
  messages: {
    async create(req: any) {
      calls.push(req);
      if (mode === "error") throw Object.assign(new Error("overloaded"), { status: 529 });
      const text = req.messages[0].content.map((c: any) => c.text).join("\n");
      const ids = Array.from(text.matchAll(/^(C\d+): (.+)$/gm)).map((m: any) => ({ id: m[1], line: m[2] }));
      const notes = ids.map(({ id, line }) => {
        if (mode === "answer" && /^Facility rent/.test(line)) {
          return {
            candidateId: id, status: "explained",
            text: "The warehouse lease started on October 1, 2022, so the year carried a full year of rent.",
            blindText: "A new premises lease started late in the prior year, so the year carried a full year of rent.",
            sources: [{ ref: "D1", quote: "The Commencement Date is October 1, 2022." }],
          };
        }
        if (mode === "answer" && /^Fuel/.test(line)) {
          // A guard failure: the quote isn't in its source.
          return { candidateId: id, status: "explained", text: "Fuel fell after a supplier switch.", sources: [{ ref: "D1", quote: "We switched fuel suppliers in early 2023." }] };
        }
        return { candidateId: id, status: "no_reason_on_file" };
      });
      return { content: [{ type: "tool_use", name: "figure_reasons", input: { notes } }] };
    },
  },
});

let planned = 0;
let keepOutCalls = 0;
_setKeepOutReviewForTests(async () => { keepOutCalls++; return { names: [], by: "ai" }; });
_setBuildDepsForTests({
  refresh: async () => {},
  loadDeal: async () => ({ deal: { id: DEAL, businessName: fx.deal.businessName, extractedInfo: fx.facts, blindCodename: fx.deal.blindCodename }, sections: fx.sections }),
  loadRaw: async () => rawNow(),
  loadEvidence: async (_dealId, targets, ctx) => buildFigureEvidence({
    targets, facts: ctx.facts, sessions: [], discrepancies: [], screen: ctx.screen, hints: ctx.hints,
    documents: [{ id: "lease-doc", name: "Warehouse lease", citable: true, transcript: false, text: LEASE_TEXT }],
  }),
  plan: async () => { planned++; },
});

test("the request: Sonnet, tool forced, temperature 0, evidence block cached, hints marked uncitable", () => {
  const ev = buildFigureEvidence({
    targets: [{ line: "line:facility-rent-warehouse" as any, lineLabel: "Facility rent — warehouse", year: "2023", fromYear: "2022" }],
    facts: {}, sessions: [], discrepancies: [], screen: screenCtxFor({}), hints: ["Warehouse lease commenced October 1, 2022, explaining the increase in facility rent in 2023."],
    documents: [{ id: "lease-doc", name: "Warehouse lease", citable: true, transcript: false, text: LEASE_TEXT }],
  });
  const req = figureNotesRequest([{ id: "C1", key: "k", figureKey: "line:facility-rent-warehouse|2023", kind: "movement", compareKey: "2022", line: "line:facility-rent-warehouse" as any, lineLabel: "Facility rent — warehouse", year: "2023", value: 1420500, fromYear: "2022", fromValue: 300000, weight: 0, total: false, valuesFingerprint: "" }], ev);
  assert.equal(req.model, "claude-sonnet-4-5");
  assert.equal(req.temperature, 0);
  assert.deepEqual(req.tool_choice, { type: "tool", name: "figure_reasons" });
  const blocks = req.messages[0].content;
  assert.deepEqual(blocks[1].cache_control, { type: "ephemeral" });
  assert.match(blocks[1].text, /\[D1\] \(document: Warehouse lease\)/);
  assert.match(blocks[2].text, /C1: Facility rent — warehouse — FY2022 \$300,000 → FY2023 \$1,420,500/);
  assert.match(blocks[2].text, /you cannot cite these/);
  assert.ok(!/\[H|\[Warehouse lease commenced/.test(blocks[1].text), "hints never appear as evidence");
});

test("malformed output is dropped; a missing tool call is an error", () => {
  const out = parseFigureReasons([{ type: "tool_use", name: "figure_reasons", input: { notes: [{ candidateId: "C9", status: "explained" }, { candidateId: "C1", status: "weird" }, null] } }], new Set(["C1"]));
  assert.deepEqual(out.map((n) => [n.candidateId, n.status]), [["C1", "no_reason_on_file"]]);
  assert.throws(() => parseFigureReasons([{ type: "text" }], new Set(["C1"])));
});

test("a build stores the grounded note as SUGGESTED; guard failures and no-reasons store nothing", async () => {
  const r = await runFigureBuild(DEAL, { reason: "broker" });
  assert.equal(r.status, "done", JSON.stringify(r));
  assert.ok((r.candidates ?? 0) > 1);
  assert.equal(calls.length, Math.ceil((r.candidates ?? 0) / 10));
  const notes = await listNotes(DEAL);
  assert.equal(notes.length, 1, "only the grounded one");
  const n = notes[0];
  assert.match(n.figureKey, /^line:facility-rent/);
  assert.equal(n.status, "suggested");
  assert.equal(n.origin, "ai");
  assert.ok(n.blindText);
  assert.deepEqual(n.sources[0], { kind: "document", documentId: "lease-doc", page: null, quote: "The Commencement Date is October 1, 2022." });
  assert.ok((r.dropped ?? []).some((d) => /^Fuel FY2023: its quote isn't in D1/.test(d)), JSON.stringify(r.dropped));
  assert.ok((r.noReason ?? []).length > 0, "no-reasons are remembered");
  assert.equal(planned, 1, "the planner runs after the build (no-reason figures become questions)");
  const state = await getFigureState(DEAL);
  assert.equal(state?.build?.status, "done");
  assert.equal(keepOutCalls, 1, "the deal's private notes need the confidentiality review once");
  assert.equal(state?.budgetCalls, calls.length + keepOutCalls, "the review counts against the daily cap");
  assert.ok(state?.keepOut?.fp, "its result is kept for the next build");
});

test("nothing changed → the next build sends nothing to the model", async () => {
  const before = calls.length;
  const r = await runFigureBuild(DEAL, { reason: "broker" });
  assert.equal(r.status, "done");
  assert.equal(r.candidates, 0);
  assert.equal(calls.length, before);
});

test("an API failure changes nothing and records why", async () => {
  mode = "error";
  const before = await listNotes(DEAL);
  const r = await runFigureBuild(DEAL, { reason: "broker", scope: "all" });
  assert.equal(r.status, "failed");
  assert.match(r.error ?? "", /overloaded; try again in a few minutes/);
  assert.deepEqual((await listNotes(DEAL)).map((n) => [n.id, n.text, n.status]), before.map((n) => [n.id, n.text, n.status]));
  mode = "answer";
});

test("a note the broker edited while the model was reading keeps the broker's version", async () => {
  const { sql } = await import("drizzle-orm");
  await db.execute(sql`UPDATE cim_figure_state SET budget_calls = 0`); // a new day's budget
  const [n] = await listNotes(DEAL);
  // The broker edits between the read and the write: simulate by editing before a scope-all build whose loadRaw still shows the old row.
  const stale = await rawNow();
  _setBuildDepsForTests({
    refresh: async () => {},
    loadDeal: async () => ({ deal: { id: DEAL, businessName: fx.deal.businessName, extractedInfo: fx.facts, blindCodename: fx.deal.blindCodename }, sections: fx.sections }),
    loadRaw: async () => stale,
    loadEvidence: async (_d, targets, ctx) => {
      // The broker's edit lands while Cimple reads.
      await brokerUpdateNote(DEAL, n.id, new Date(n.updatedAt as any).toISOString(), { text: "The broker's own wording about the October 2022 lease.", by: "broker-1" });
      return buildFigureEvidence({ targets, facts: ctx.facts, sessions: [], discrepancies: [], screen: ctx.screen, hints: ctx.hints, documents: [{ id: "lease-doc", name: "Warehouse lease", citable: true, transcript: false, text: LEASE_TEXT + " Rent is payable monthly." }] });
    },
    plan: async () => {},
  });
  const r = await runFigureBuild(DEAL, { reason: "broker", scope: "all" });
  const after = (await listNotes(DEAL)).find((x) => x.id === n.id)!;
  assert.equal(after.text, "The broker's own wording about the October 2022 lease.");
  assert.ok((r.skippedBecauseEdited ?? 0) >= 1, JSON.stringify(r));
});

test("the daily cap: no 5th call; a build at the cap is refused before calling", async () => {
  const state = await getFigureState(DEAL);
  assert.ok((state?.budgetCalls ?? 0) <= 4);
  const { chargeFigureBudget } = await import("../../server/cim/figures/store");
  while ((await chargeFigureBudget(DEAL, new Date().toISOString().slice(0, 10))) !== null) { /* use up today's budget */ }
  const before = calls.length;
  const r = await runFigureBuild(DEAL, { reason: "broker", scope: "all" });
  assert.equal(calls.length, before, "no call past the cap");
  assert.ok((r.warnings ?? []).some((w) => /4 times today/.test(w)), JSON.stringify(r));
  const { dailyLimitReached } = await import("../../server/cim/figures/build");
  assert.equal(dailyLimitReached(await getFigureState(DEAL)), true);
});

test("the keep-out review: never from the broker-text guard or serving; counted when the build runs it", () => {
  for (const f of ["server/cim/figures/guards.ts", "server/cim/figures/serve.ts", "server/routes/figures.ts", "shared/figure-layer.ts"]) {
    assert.ok(!/keepOutFor\(/.test(readFileSync(f, "utf8")), `${f} never calls the paid keep-out review`);
  }
  const build = readFileSync("server/cim/figures/build.ts", "utf8");
  assert.match(build, /const charged = await chargeFigureBudget\(dealId, budgetDay\(\)\);[\s\S]*keepOutFor\(dealId, info\)/);
  assert.equal(keepOutCalls, 1, "reviewed once; later builds reuse the kept result (same notes → same fingerprint)");
});

test("serving after a build never shows a suggested AI note to buyers", async () => {
  const { figureInputsFor } = await import("../../server/cim/figures/serve");
  const raw = assembleFigureRaw(DEAL, {
    info: fx.facts, docs: fx.documents.map((d) => ({ ...d, extractedText: undefined })) as any, analyses: fx.analyses,
    notes: await listNotes(DEAL), questions: [], decisions: [], state: baseRaw.state,
  });
  const inputs = figureInputsFor(raw, { audience: "buyer", mode: "normal" });
  assert.ok(inputs && inputs.notes.every((n) => n.status === "approved"));
});

await run("figure-notes-ai");
_setFigureNotesClientForTests(null);
_setBuildDepsForTests(null);
_useFigureDbForTests(null);
