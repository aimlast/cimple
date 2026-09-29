/**
 * R5 — "Generate DD version" during an AI outage must not replace good DD
 * sections with plain named copies, mark them fresh and say "ready".
 *   - enrichSection tells an AI failure ("api"/"unusable") from a rule
 *     rejection ("rejected");
 *   - the full run: every section failing → nothing written, an honest
 *     error; some failing → only the written sections are replaced (and
 *     marked fresh), the others keep their DD version;
 *   - one DD run per deal (shared with the builder's Refresh DD);
 *   - the per-section refresh throws DdUnavailableError and touches nothing.
 * No database, no AI (stubbed client, storage and writer).
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/f2-resilience-dd.test.ts
 */
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { storage } from "../../server/storage";
import { db } from "../../server/db";
import {
  _setDdClientForTests,
  _setDdRunWriterForTests,
  _dbRunWriterForTests,
  DdUnavailableError,
  ddRunning,
  enrichSection,
  lastDdRun,
  planDdRun,
  refreshSectionDd,
  startFullDdGeneration,
} from "../../server/cim/dd-enrichment";

let passed = 0;
const ok = (name: string) => { passed++; console.log(`  ✓ ${name}`); };
const origWarn = console.warn;
const origErr = console.error;
console.warn = () => {};
console.error = () => {};

const sec = (id: string, layoutType = "prose_highlight", body = "Revenue is concentrated with Customer A.") =>
  ({ id, dealId: "d-dd", sectionKey: id, sectionTitle: `Section ${id}`, layoutType, layoutData: { body }, aiDraftContent: body, brokerEditedContent: null, ddStaleAt: null } as any);
const deal: any = { id: "d-dd", businessName: "Beacon Pharmacy", industry: "Pharmacy", extractedInfo: {} };
const inputs = { context: "Customer A is Sunnyside Retirement Residence.", knownText: "Sunnyside Retirement Residence" };
const outage = { messages: { create: async () => { const e: any = new Error("Your credit balance is too low"); e.status = 400; throw e; } } };
const goodFor = (failIds: Set<string>) => ({
  messages: {
    create: async (body: any) => {
      const id = /Title: Section (\w+)/.exec(body.messages[0].content)?.[1] ?? "";
      if (failIds.has(id)) { const e: any = new Error("overloaded"); e.status = 529; throw e; }
      return { stop_reason: "tool_use", content: [{ type: "tool_use", name: "dd_section", input: { layoutData: { body: "Revenue is concentrated with [[dd]]Sunnyside Retirement Residence[[/dd]]." }, contentOverride: "Revenue is concentrated with [[dd]]Sunnyside Retirement Residence[[/dd]]." } }] };
    },
  },
});

// Failure kinds.
{
  _setDdClientForTests(outage);
  const r = await enrichSection(sec("a"), inputs, deal);
  assert.equal(r.failed, "api");
  assert.match(r.warning!, /current DD version was kept/);
  _setDdClientForTests({ messages: { create: async () => ({ stop_reason: "max_tokens", content: [] }) } });
  assert.equal((await enrichSection(sec("a"), inputs, deal)).failed, "unusable");
  _setDdClientForTests({ messages: { create: async () => ({ stop_reason: "tool_use", content: [{ type: "tool_use", input: { layoutData: { body: "Revenue of $9,999,999 with Acme." }, contentOverride: "x" } }] }) } });
  assert.equal((await enrichSection(sec("a"), inputs, deal)).failed, "rejected");
  _setDdClientForTests(goodFor(new Set()));
  assert.equal((await enrichSection(sec("a"), inputs, deal)).failed, undefined);
  assert.equal((await enrichSection(sec("c", "cover_page"), inputs, deal)).failed, undefined, "covers are never sent to the model");
  ok("an AI failure is told apart from a rule rejection");
}

// Full run, total outage: nothing written, honest error.
{
  const writes: any[] = [];
  _setDdRunWriterForTests(async (_d, all, written) => { writes.push({ all, written }); });
  _setDdClientForTests(outage);
  const sections = [sec("cover", "cover_page"), sec("a"), sec("b"), sec("c")];
  const { done } = startFullDdGeneration(deal, sections, inputs, new Date());
  assert.ok(ddRunning.has(deal.id), "running");
  assert.throws(() => startFullDdGeneration(deal, sections, inputs, new Date()), /running/, "a second click is refused");
  const summary = await done;
  assert.equal(writes.length, 0, "the existing DD version is untouched");
  assert.match(summary.error!, /AI service failed .*\(3 of 3 sections\)\. Nothing was changed/);
  assert.equal(lastDdRun(deal.id)?.error, summary.error);
  assert.equal(ddRunning.has(deal.id), false);
  ok("a DD run during an outage changes nothing and says so");
}

// Partial outage: only written sections are replaced (and made fresh).
{
  const writes: any[] = [];
  _setDdRunWriterForTests(async (_d, all, written) => { writes.push({ all, written: written.map((w) => w.cimSectionId) }); });
  _setDdClientForTests(goodFor(new Set(["b"])));
  const sections = [sec("cover", "cover_page"), sec("a"), sec("b"), sec("c")];
  const summary = await startFullDdGeneration(deal, sections, inputs, new Date()).done;
  assert.equal(summary.error, undefined);
  assert.deepEqual(writes[0].written.sort(), ["a", "c", "cover"]);
  assert.deepEqual(writes[0].all, ["cover", "a", "b", "c"]);
  assert.equal(summary.notWritten, 1);
  assert.ok(summary.warnings.some((w) => /Section b.*kept/.test(w)));
  ok("a partial outage writes only the sections it could write; the rest keep their DD version");
}

// F2-FINAL-3: a section the AI couldn't write in a full re-run keeps its old
// DD version but is marked out of date, so the builder offers to refresh it
// and DD buyers read the current named content meanwhile.
{
  const calls: any[] = [];
  _setDdRunWriterForTests(async (_d, _all, written, _at, notWrittenIds) => { calls.push({ written: written.map((w) => w.cimSectionId).sort(), notWrittenIds }); });
  _setDdClientForTests(goodFor(new Set(["b"])));
  const startedAt = new Date("2026-09-29T10:00:00Z");
  await startFullDdGeneration(deal, [sec("a"), sec("b"), sec("c")], inputs, startedAt).done;
  assert.deepEqual(calls[0], { written: ["a", "c"], notWrittenIds: ["b"] }, "the writer is told which sections weren't written");

  // The database writer, against a recording transaction (no database).
  const log: Array<{ sql: string; params: unknown[] } | { insert: string[] }> = [];
  const rec = {
    update: (t: any) => ({ set: (v: any) => ({ where: (c: any) => { log.push(db.update(t).set(v).where(c).toSQL()); return Promise.resolve([]); } }) }),
    delete: (t: any) => ({ where: (c: any) => { log.push(db.delete(t).where(c).toSQL()); return Promise.resolve([]); } }),
    insert: (_t: any) => ({ values: (v: any[]) => { log.push({ insert: v.map((x) => x.cimSectionId) }); return Promise.resolve([]); } }),
  };
  const origTx = (db as any).transaction;
  (db as any).transaction = async (fn: (tx: any) => Promise<unknown>) => fn(rec);
  const w = (id: string) => ({ cimSectionId: id, layoutData: {}, contentOverride: "" });
  await _dbRunWriterForTests("d-dd", ["a", "b", "c"], [w("a"), w("c")], startedAt, ["b"]);
  (db as any).transaction = origTx;
  const updates = log.filter((l): l is { sql: string; params: unknown[] } => "sql" in l && /^update/.test(l.sql));
  const staleMark = updates.find((u) => u.params.includes("b"));
  assert.ok(staleMark, "the unwritten section is updated");
  assert.match(staleMark!.sql, /set "dd_stale_at" = \$1/);
  assert.match(staleMark!.sql, /"dd_stale_at" is null/, "an edit's own stale mark is kept");
  const stamp = staleMark!.params[0];
  assert.equal(new Date(stamp instanceof Date ? stamp : String(stamp).replace(" ", "T") + (/Z|[+-]\d\d:?\d\d$/.test(String(stamp)) ? "" : "Z")).getTime(), startedAt.getTime(), "stamped with the run's start");
  assert.ok(staleMark!.params.includes("d-dd"), "scoped to the deal");
  const fresh = updates.find((u) => /set "dd_stale_at" = \$1/.test(u.sql) && u.params[0] === null);
  assert.ok(fresh && fresh.params.includes("a") && fresh.params.includes("c") && !fresh.params.includes("b"), "only the written sections are marked fresh");
  assert.ok(log.every((l) => !("sql" in l) || !/^delete/.test(l.sql) || !(l.params as unknown[]).includes("b") || /not in/.test(l.sql)), "the unwritten section's DD row is not deleted");
  assert.deepEqual((log.find((l) => "insert" in l) as { insert: string[] }).insert, ["a", "c"]);

  // What that mark means downstream: DD buyers are served the named content.
  const { buildBuyerCim } = await import("../../shared/cim-buyer-view");
  const named = { ...sec("b"), dealId: "d-dd", sectionOrder: 1, isVisible: true, accessTier: "full" };
  const oldDd = { id: "o1", dealId: "d-dd", cimSectionId: "b", mode: "dd", layoutData: { body: "OLD enrichment with Sunnyside." }, contentOverride: "OLD enrichment with Sunnyside." } as any;
  const before = buildBuyerCim({ deal: { ...deal, cimContent: {} } as any, accessLevel: "due_diligence", sections: [named], overrides: [oldDd] } as any);
  const after = buildBuyerCim({ deal: { ...deal, cimContent: {} } as any, accessLevel: "due_diligence", sections: [{ ...named, ddStaleAt: startedAt }], overrides: [oldDd] } as any);
  assert.match(JSON.stringify(before.sections), /OLD enrichment/);
  assert.doesNotMatch(JSON.stringify(after.sections), /OLD enrichment/);
  ok("F2-FINAL-3: a section a full re-run couldn't write is marked DD out of date (refreshable; DD buyers see the named version), never shown as fresh");
}

// Pure plan: a rejection still writes the named version (the DD rules' fallback).
{
  const plan = planDdRun(
    [{ cimSectionId: "a", layoutData: {}, contentOverride: "", failed: "rejected" }, { cimSectionId: "b", layoutData: {}, contentOverride: "", failed: "api" }],
    [sec("a"), sec("b")],
  );
  assert.equal(plan.error, null);
  assert.deepEqual(plan.write.map((w) => w.cimSectionId), ["a"]);
  const covers = planDdRun([{ cimSectionId: "c", layoutData: {}, contentOverride: "" }], [sec("c", "cover_page")]);
  assert.equal(covers.error, null, "nothing attempted is not an outage");
  ok("rule rejections keep writing the named version; covers never count as failures");
}

// Per-section refresh during an outage: DdUnavailableError, nothing touched.
{
  const s = storage as any;
  s.getAddbackVerificationByDeal = async () => undefined;
  s.getFinancialAnalysesByDeal = async () => [];
  s.getDocumentsByDeal = async () => [];
  s.getResolvedDiscrepancies = async () => [];
  _setDdClientForTests(outage);
  await assert.rejects(() => refreshSectionDd({ ...sec("a"), ddStaleAt: new Date() }, deal), DdUnavailableError);
  ok("a per-section DD refresh during an outage keeps the old version and its stale mark");
}

// Routes: generate-dd runs in the background with the shared guard; the builder answers 503.
{
  const routes = fs.readFileSync(path.join(process.cwd(), "server", "routes.ts"), "utf8");
  const start = routes.indexOf('app.post("/api/deals/:dealId/generate-dd"');
  const body = routes.slice(start, routes.indexOf("app.get(", start));
  assert.ok(body.includes("startFullDdGeneration(") && body.includes("res.status(202)") && body.includes("ddRunning.has(dealId)"));
  assert.ok(!body.includes('deleteCimSectionOverrides(dealId, "dd")'), "never wipes every DD version up front");
  const builder = fs.readFileSync(path.join(process.cwd(), "server", "routes", "cim-builder.ts"), "utf8");
  assert.ok(builder.includes("const ddRefreshRunning = ddRunning;"));
  assert.ok(builder.includes("lastRun: lastDdRun(deal.id)"));
  assert.ok(builder.includes("err instanceof DdUnavailableError) return res.status(503)"));
  const tab = fs.readFileSync(path.join(process.cwd(), "client", "src", "pages", "broker", "deal", "CimTab.tsx"), "utf8");
  assert.ok(!/toast\(\{ title: mode === "blind" \? "Blind version ready" : "Due-diligence version ready" \}\)/.test(tab), "no 'ready' before the run finishes");
  assert.ok(tab.includes("dd-last-run"), "the last run's notes are shown on the card");
  ok("generate-dd runs in the background, shares the DD guard, and the CIM tab reports the real outcome");
}

console.warn = origWarn;
console.error = origErr;
_setDdClientForTests(null);
_setDdRunWriterForTests(null);
console.log(`f2-resilience-dd: ${passed} passed`);
process.exit(0);
