/**
 * The two dd scripts (spec §12), offline:
 *   - seed-figure-notes-fixtures: the recorded notes pass the same checks the
 *     AI pass applies (quotes found word for word, figures known, privacy
 *     guards, blind wording) or are skipped with the reason; it refuses any
 *     deal that isn't one of qa_cimgen's "QA OCT —" copies; --remove deletes
 *     only the rows it wrote;
 *   - report-figure-checks: read-only (its connection refuses writes; no
 *     --apply), cost estimate per the spec's prices.
 *   npx tsx tests/unit/figure-scripts.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureRaw, run, test } from "./helpers/figure-test";
import { prepareFixtureNotes, readFixtureNotes } from "../../scripts/seed-figure-notes-fixtures";
import { estimatedBuildCost } from "../../scripts/report-figure-checks";
import { guardBrokerText, normalizeQuote, sentenceCount, unknownFigure } from "../../server/cim/figures/guards";
import { guardCtxFor } from "../../server/cim/figures/build";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function ctxFor(name: "pacific" | "lakeshore", texts: Record<string, string> = {}) {
  const { fx, raw } = await fixtureRaw(name, { locate: false });
  const lineLabels = Object.values(raw.registry).filter((f) => String(f.line).startsWith("line:")).map((f) => f.lineLabel);
  const gctx = guardCtxFor(fx.deal as any, raw.info, [], lineLabels);
  return {
    fx,
    ctx: {
      registry: raw.registry as any,
      docs: fx.documents.map((d) => ({ id: d.id, name: d.name, citable: !!raw.docs.get(d.id)?.citable, text: texts[d.name] ?? d.extractedText, sourceKind: d.sourceKind, visibility: d.visibility })),
      facts: raw.info,
      guard: (text: string, blindText: string | null) => {
        const r = guardBrokerText(text, null, gctx);
        if (!r.ok) return { ok: false as const, why: r.message };
        const b = blindText ? guardBrokerText(text, blindText, gctx) : null;
        return { ok: true as const, blindText: b && b.ok ? blindText : null };
      },
      unknownFigure, normalize: normalizeQuote, sentenceCount,
    },
  };
}

test("Pacific: the warehouse notes are grounded (statements text + the lease's own facts)", async () => {
  const { ctx } = await ctxFor("pacific");
  const out = prepareFixtureNotes(readFixtureNotes("pacific"), ctx);
  const byKey = Object.fromEntries(out.map((p) => [p.ok ? p.note.figureKey : p.figureKey, p]));
  const threePl = byKey["line:3pl-warehousing-cross-dock-and-handling|2023"];
  assert.ok(threePl.ok, JSON.stringify(threePl));
  if (threePl.ok) {
    assert.equal(threePl.note.origin, "ai");
    assert.deepEqual(threePl.note.valuesSnapshot, { year: "2023", value: 6020000, fromYear: "2022", fromValue: 4960000 });
    assert.ok(threePl.note.sources.every((s) => s.kind === "document" && s.documentId));
    assert.match(threePl.note.inputFingerprint, /^fixture:[0-9a-f]{16}$/);
    assert.ok(threePl.note.blindText, "blind wording kept (nothing identifying)");
  }
  assert.ok(byKey["line:facility-rent-warehouse|2023"].ok);
});

test("Pacific: the transcript note is checked against the meeting's own words (skipped offline, kept with them)", async () => {
  const offline = prepareFixtureNotes(readFixtureNotes("pacific"), (await ctxFor("pacific")).ctx);
  const fees = offline.find((p) => !p.ok && p.figureKey === "line:professional-fees|2023");
  assert.ok(fees && !fees.ok && /quote isn't in/.test(fees.why), JSON.stringify(fees));
  const zoom = "[00:03:35] Manpreet Grewal: Honestly, we fixed the scheduling. We spent about fifty-eight thousand on labour lawyers that year, which I'd call one-time. … The Labour Board ordered a vote in August. It was 38 for, 51 against. So it failed.";
  const { fx, ctx } = await ctxFor("pacific", { [(await ctxFor("pacific")).fx.documents.find((d) => /^Zoom working session/.test(d.name))!.name]: zoom });
  void fx;
  const withText = prepareFixtureNotes(readFixtureNotes("pacific"), ctx).find((p) => p.ok && p.note.figureKey === "line:professional-fees|2023");
  assert.ok(withText && withText.ok);
  if (withText && withText.ok) assert.ok(withText.note.sources.every((s) => s.kind === "transcript"), "the owner's words, never a cited file");
});

test("a quote that isn't in its document, an unknown figure, a missing figure, CRM material: skipped with the reason", async () => {
  const { ctx } = await ctxFor("pacific");
  const out = prepareFixtureNotes({ notes: [
    { figureKey: "line:3pl-warehousing-cross-dock-and-handling|2023", kind: "movement", compareKey: "2022", text: "A new warehouse.", blindText: null, sources: [{ kind: "document", document: "^Financial statements FY2023", quote: "words that are not in the statements at all" }] },
    { figureKey: "line:3pl-warehousing-cross-dock-and-handling|2023", kind: "movement", compareKey: "2022", text: "Revenue rose by $999,999 because of the warehouse.", blindText: null, sources: [{ kind: "document", document: "^Financial statements FY2023", quote: "leases its 110,000 square foot warehouse and cross-dock facility" }] },
    { figureKey: "nope|2023", kind: "movement", compareKey: "2022", text: "x", blindText: null, sources: [] },
    { figureKey: "line:3pl-warehousing-cross-dock-and-handling|2023", kind: "movement", compareKey: "2022", text: "Growth came from the 110,000 square foot warehouse.", blindText: null, sources: [{ kind: "document", document: "^CRM note — Working session", quote: "normalization" }] },
  ] }, ctx);
  assert.deepEqual(out.map((p) => p.ok), [false, false, false, false]);
  assert.match((out[0] as any).why, /quote isn't in/);
  assert.match((out[1] as any).why, /999,999/);
  assert.match((out[2] as any).why, /isn't on this deal/);
  assert.match((out[3] as any).why, /can't be shown to buyers/, "CRM material is never cited");
});

test("the seeder refuses anything but qa_cimgen's QA OCT copies; --remove deletes only its own rows", () => {
  const src = readFileSync(join(ROOT, "scripts/seed-figure-notes-fixtures.ts"), "utf8");
  assert.match(src, /broker\?\.username !== "qa_cimgen" \|\| !\/\^QA OCT —\//);
  assert.match(src, /input_fingerprint LIKE 'fixture:%'/);
  assert.match(src, /ANTHROPIC_API_KEY=disabled/);
  assert.ok(!/anthropic\.messages|writeFigureNotes|runFigureBuild/.test(src), "never calls the AI");
});

test("the report is read-only and prices a build per the spec", () => {
  const src = readFileSync(join(ROOT, "scripts/report-figure-checks.ts"), "utf8");
  assert.match(src, /default_transaction_read_only: "on"/);
  assert.ok(!/\b(INSERT|UPDATE|DELETE)\b/.test(src.replace(/\/\*[\s\S]*?\*\//g, "")), "no write statements");
  assert.ok(!/upsertMachineNote|mergeLocated|setRefreshed|runFigureRefresh|runFigureBuild/.test(src));
  assert.deepEqual(estimatedBuildCost(0), { calls: 0, dollars: 0 });
  assert.deepEqual(estimatedBuildCost(7), { calls: 1, dollars: 0.09 });
  assert.deepEqual(estimatedBuildCost(16), { calls: 2, dollars: 0.135 });
});

test("Lakeshore: the Comfort Club notes need the membership report's own words", async () => {
  const report = "Active members Dec 31, 2022 / 2023 / 2024,2150 / 2520 / 2780\nMembers from July 2023 acquired book (Pembury Furnace Services) still active,262 of approx. 310 acquired";
  const base = await ctxFor("lakeshore");
  const name = base.fx.documents.find((d) => /^Comfort Club membership report/.test(d.name))!.name;
  const { ctx } = await ctxFor("lakeshore", { [name]: report });
  const out = prepareFixtureNotes(readFixtureNotes("lakeshore"), ctx);
  assert.ok(out.every((p) => p.ok), JSON.stringify(out.filter((p) => !p.ok)));
});

await run("figure-scripts");
