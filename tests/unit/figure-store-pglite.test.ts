/**
 * The figure store's SQL on a real (in-process) Postgres — PGlite, no network.
 *   npx tsx tests/unit/figure-store-pglite.test.ts
 *
 * Proves (spec §7.4, §9.6, D24):
 *   - the AI budget needs no prior row, refuses the 5th call of a day, resets
 *     the next day, and never exceeds 4 under concurrent charges;
 *   - a machine upsert updates a suggested row, but an approved / hidden /
 *     broker-written / edited row keeps its text and status and gains only a
 *     `proposal` (+ figures_changed when the values moved);
 *   - a row changed after it was read keeps the other writer's version;
 *   - state setters never clobber each other's columns;
 *   - broker writes compare-and-set on the version they read.
 */
import assert from "node:assert/strict";
import { figurePglite, run, test } from "./helpers/figure-test";
import {
  brokerUpdateNote, chargeFigureBudget, flagNoteBySeller, getFigureState, listNotes, mergeLocated, putDecision, listDecisions,
  setAutoAsk, setBuild, setDdShown, setKeepOut, setRefreshed, upsertBrokerNote, upsertMachineNote, type MachineNote,
} from "../../server/cim/figures/store";

const DEAL = "deal-1";
const note = (over: Partial<MachineNote> = {}): MachineNote => ({
  figureKey: "operatingExpenses|2023", kind: "movement", compareKey: "2022", origin: "computed",
  text: "Up $1,378,500 (33%) from FY2022, mostly facility rent (+$1,120,500).", blindText: "Up $1,378,500 (33%) from FY2022, mostly from one expense line.",
  sources: [{ kind: "computed" }], valuesSnapshot: { year: "2023", value: 5505500, fromYear: "2022", fromValue: 4127000 }, inputFingerprint: "fp1",
  ...over,
});

const { db } = await figurePglite();

test("budget: first call with no row → 1; the 5th call of a day is refused; a new day resets", async () => {
  assert.equal(await chargeFigureBudget(DEAL, "2026-10-09", db), 1);
  assert.equal(await chargeFigureBudget(DEAL, "2026-10-09", db), 2);
  assert.equal(await chargeFigureBudget(DEAL, "2026-10-09", db), 3);
  assert.equal(await chargeFigureBudget(DEAL, "2026-10-09", db), 4);
  assert.equal(await chargeFigureBudget(DEAL, "2026-10-09", db), null);
  assert.equal(await chargeFigureBudget(DEAL, "2026-10-09", db), null);
  assert.equal(await chargeFigureBudget(DEAL, "2026-10-10", db), 1);
});

test("budget: concurrent charges never exceed 4", async () => {
  const results = await Promise.all(Array.from({ length: 10 }, () => chargeFigureBudget("deal-c", "2026-10-09", db)));
  assert.equal(results.filter((r) => r !== null).length, 4);
  assert.deepEqual(results.filter((r) => r !== null).sort(), [1, 2, 3, 4]);
});

test("state setters each write their own column", async () => {
  await setDdShown("deal-s", new Date("2026-10-09T10:00:00Z"), "broker-1", db);
  await setBuild("deal-s", { status: "running", startedAt: "2026-10-09T10:01:00Z" }, db);
  await setAutoAsk("deal-s", true, db);
  await setKeepOut("deal-s", { names: ["Karen Holt"], at: "2026-10-09", by: "rules" }, db);
  await mergeLocated("deal-s", { "d1@x#86000": { index: 10, page: 3, sourceLabel: "Interest and bank charges" } }, db);
  await mergeLocated("deal-s", { "d1@x#301000": { missing: true } }, db);
  await setRefreshed("deal-s", "fp-r", db);
  let s = (await getFigureState("deal-s", db))!;
  assert.ok(s.ddShownAt, "DD switch kept after other setters");
  assert.equal(s.ddShownBy, "broker-1");
  assert.equal(s.build?.status, "running");
  assert.equal(s.autoAsk, true);
  assert.deepEqual(s.keepOut?.names, ["Karen Holt"]);
  assert.equal(Object.keys(s.located).length, 2, "located merges, never replaces");
  assert.equal(s.refreshedFingerprint, "fp-r");
  // Turning the checks off, then a build update: still off.
  await setDdShown("deal-s", null, null, db);
  await setBuild("deal-s", { status: "done", startedAt: "2026-10-09T10:01:00Z", finishedAt: "2026-10-09T10:02:00Z" }, db);
  s = (await getFigureState("deal-s", db))!;
  assert.equal(s.ddShownAt, null);
  assert.equal(s.build?.status, "done");
  assert.equal(s.autoAsk, true);
});

test("machine upsert: inserts, then updates a suggested row read with the same fingerprint", async () => {
  assert.equal(await upsertMachineNote(DEAL, note(), null, db), "written");
  let rows = await listNotes(DEAL, db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "suggested");
  assert.equal(await upsertMachineNote(DEAL, note({ text: "new wording", inputFingerprint: "fp2" }), "fp1", db), "written");
  rows = await listNotes(DEAL, db);
  assert.equal(rows[0].text, "new wording");
  assert.equal(rows[0].inputFingerprint, "fp2");
});

test("machine upsert: a row changed after it was read keeps the other version (proposal only)", async () => {
  // Someone else wrote fp3 meanwhile; this writer still thinks the row is at fp2.
  await upsertMachineNote(DEAL, note({ text: "writer A", inputFingerprint: "fp3" }), "fp2", db);
  assert.equal(await upsertMachineNote(DEAL, note({ text: "writer B (stale read)", inputFingerprint: "fp4" }), "fp2", db), "proposal");
  const [row] = await listNotes(DEAL, db);
  assert.equal(row.text, "writer A");
  assert.equal(row.proposal?.text, "writer B (stale read)");
});

test("machine upsert: approved / hidden / edited / broker rows keep text and status, gain a proposal and figures_changed", async () => {
  const keys = ["a", "b", "c"].map((k) => `line:${k}|2023`);
  for (const k of keys) await upsertMachineNote(DEAL, note({ figureKey: k }), null, db);
  const rows = await listNotes(DEAL, db);
  const byKey = (k: string) => rows.find((r) => r.figureKey === k)!;
  // approve a, hide b, edit c
  await brokerUpdateNote(DEAL, byKey(keys[0]).id, new Date(byKey(keys[0]).updatedAt as any).toISOString(), { action: "approve", by: "b1" }, db);
  await brokerUpdateNote(DEAL, byKey(keys[1]).id, new Date(byKey(keys[1]).updatedAt as any).toISOString(), { action: "hide", by: "b1" }, db);
  await brokerUpdateNote(DEAL, byKey(keys[2]).id, new Date(byKey(keys[2]).updatedAt as any).toISOString(), { text: "My own words.", by: "b1" }, db);
  const broker = await upsertBrokerNote(DEAL, { figureKey: "line:d|2023", kind: "movement", compareKey: "2022", text: "Broker wrote this.", blindText: null, sources: [], valuesSnapshot: { year: "2023", value: 1, fromYear: "2022", fromValue: 2 }, by: "b1" }, db);
  for (const k of [...keys, "line:d|2023"]) {
    const r = await upsertMachineNote(DEAL, note({ figureKey: k, text: "machine v2", inputFingerprint: "fp9", valuesSnapshot: { year: "2023", value: 6000000, fromYear: "2022", fromValue: 4127000 } }), "fp1", db);
    assert.equal(r, "proposal", k);
  }
  const after = await listNotes(DEAL, db);
  const a = after.find((r) => r.figureKey === keys[0])!;
  const b = after.find((r) => r.figureKey === keys[1])!;
  const c = after.find((r) => r.figureKey === keys[2])!;
  const dd = after.find((r) => r.id === broker.id)!;
  assert.equal(a.status, "approved"); assert.notEqual(a.text, "machine v2"); assert.equal(a.proposal?.text, "machine v2"); assert.equal(a.staleReason, "figures_changed");
  assert.equal(b.status, "hidden"); assert.notEqual(b.text, "machine v2");
  assert.equal(c.text, "My own words."); assert.ok(c.editedAt);
  assert.equal(dd.origin, "broker"); assert.equal(dd.text, "Broker wrote this."); assert.equal(dd.proposal?.text, "machine v2");
});

test("broker writes compare-and-set on the version read (stale → conflict)", async () => {
  await upsertMachineNote(DEAL, note({ figureKey: "line:cas|2024", inputFingerprint: "x" }), null, db);
  const [row] = (await listNotes(DEAL, db)).filter((r) => r.figureKey === "line:cas|2024");
  const v = new Date(row.updatedAt as any).toISOString();
  const ok = await brokerUpdateNote(DEAL, row.id, v, { action: "approve", by: "b1" }, db);
  assert.ok(typeof ok === "object" && ok.status === "approved");
  assert.equal(await brokerUpdateNote(DEAL, row.id, v, { action: "hide", by: "b1" }, db), "conflict");
  assert.equal(await brokerUpdateNote("other-deal", row.id, v, { action: "hide", by: "b1" }, db), "not_found");
});

test("the owner's Change this hides an approved note and keeps the comment", async () => {
  const [row] = (await listNotes(DEAL, db)).filter((r) => r.figureKey === "line:cas|2024");
  assert.equal(await flagNoteBySeller(DEAL, row.id, "That's not why — it was the new contract.", db), true);
  const [after] = (await listNotes(DEAL, db)).filter((r) => r.figureKey === "line:cas|2024");
  assert.equal(after.staleReason, "seller_flagged");
  assert.match(after.sellerComment ?? "", /new contract/);
  assert.equal(await flagNoteBySeller("other-deal", row.id, "x", db), false);
});

test("decisions upsert per check key", async () => {
  await putDecision(DEAL, { checkKey: "interest|2022~tax_return:t2", state: "shown", reason: null, correctedValue: null, valuesSnapshot: { base: 268000, other: 301000 }, by: "b1" }, db);
  await putDecision(DEAL, { checkKey: "interest|2022~tax_return:t2", state: "left_out", reason: "Filed late", correctedValue: null, valuesSnapshot: { base: 268000, other: 301000 }, by: "b1" }, db);
  const ds = await listDecisions(DEAL, db);
  assert.equal(ds.length, 1);
  assert.equal(ds[0].state, "left_out");
  assert.equal(ds[0].reason, "Filed late");
});

await run("figure store (PGlite)");
