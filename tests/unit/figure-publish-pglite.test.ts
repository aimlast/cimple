/**
 * The review sheet's writes and the questions table on a real (in-process)
 * Postgres — PGlite, no network.
 *   npx tsx tests/unit/figure-publish-pglite.test.ts
 *
 * Proves: bulk approval approves suggested notes only, skips stale /
 * flagged / internal-only / changed-since-shown ones with a reason; the
 * publish transaction (approve + show + DD checks on) is all-or-nothing;
 * questions insert once per figure (ON CONFLICT DO NOTHING) and status
 * changes compare-and-set on the status read; counts for the CIM tab.
 */
import assert from "node:assert/strict";
import { figurePglite, run, test } from "./helpers/figure-test";
import {
  approveNotes, bulkApproveRefusal, figureCounts, getFigureState, inFigureTransaction, insertQuestionIfAbsent, listDecisions, listNotes, listQuestions,
  putDecision, setDdShown, updateQuestionIf, upsertMachineNote, flagNoteBySeller, type MachineNote,
} from "../../server/cim/figures/store";

const { db } = await figurePglite();
const DEAL = "deal-p";
const m = (over: Partial<MachineNote>): MachineNote => ({
  figureKey: "line:fuel|2023", kind: "movement", compareKey: "2022", origin: "ai", text: "A note.", blindText: null,
  sources: [{ kind: "document", documentId: "d1", quote: "the quote here" }], valuesSnapshot: { year: "2023", value: 1, fromYear: "2022", fromValue: 2 }, inputFingerprint: "fp", ...over,
});

await upsertMachineNote(DEAL, m({ figureKey: "a|2023", inputFingerprint: "fa" }), null, db);
await upsertMachineNote(DEAL, m({ figureKey: "b|2023", inputFingerprint: "fb", sources: [{ kind: "discrepancy", internal: true, quote: "my resolution note" }] }), null, db);
await upsertMachineNote(DEAL, m({ figureKey: "c|2023", inputFingerprint: "fc" }), null, db);
await upsertMachineNote(DEAL, m({ figureKey: "d|2023", inputFingerprint: "fd" }), null, db);

const byKey = async () => new Map((await listNotes(DEAL, db)).map((n) => [n.figureKey, n]));

test("bulk approval: suggested only; internal-only, changed-since-shown and missing notes are skipped with a reason", async () => {
  const notes = await byKey();
  assert.equal(bulkApproveRefusal(notes.get("b|2023")!), "based only on your internal note; check the wording first");
  const r = await approveNotes(DEAL, [
    { id: notes.get("a|2023")!.id },
    { id: notes.get("b|2023")!.id },
    { id: notes.get("c|2023")!.id, fingerprint: "an-older-version" },
    { id: "nope" },
  ], "broker-1", db);
  assert.deepEqual(r.approved, [notes.get("a|2023")!.id]);
  assert.deepEqual(r.skipped.map((x) => x.reason), ["based only on your internal note; check the wording first", "changed while you were reviewing", "not found"]);
  const after = await byKey();
  assert.equal(after.get("a|2023")!.status, "approved");
  assert.equal(after.get("a|2023")!.approvedBy, "broker-1");
  assert.equal(after.get("b|2023")!.status, "suggested");
  // Approving it again: already shown.
  const again = await approveNotes(DEAL, [{ id: notes.get("a|2023")!.id }], "broker-1", db);
  assert.deepEqual(again.skipped.map((x) => x.reason), ["already shown to buyers"]);
});

test("the review sheet may approve an internal-only note the broker ticked themselves", async () => {
  const notes = await byKey();
  const r = await approveNotes(DEAL, [{ id: notes.get("b|2023")!.id, fingerprint: "fb" }], "broker-1", db, { allowInternal: true });
  assert.equal(r.approved.length, 1);
});

test("a flagged note can't be bulk-approved", async () => {
  const notes = await byKey();
  await approveNotes(DEAL, [{ id: notes.get("d|2023")!.id }], "broker-1", db);
  assert.equal(await flagNoteBySeller(DEAL, notes.get("d|2023")!.id, "Please don't mention the supplier.", db), true);
  const flagged = (await byKey()).get("d|2023")!;
  assert.equal(bulkApproveRefusal({ ...flagged, status: "suggested" }), "the owner asked for a change");
});

test("publish is one transaction: everything or nothing", async () => {
  const notes = await byKey();
  await assert.rejects(inFigureTransaction(async (tx) => {
    await approveNotes(DEAL, [{ id: notes.get("c|2023")!.id }], "broker-1", tx);
    await putDecision(DEAL, { checkKey: "interest|2022~tax_return:t2", state: "shown", reason: null, correctedValue: null, valuesSnapshot: { base: 268000, other: 301000 }, by: "broker-1" }, tx);
    await setDdShown(DEAL, new Date(), "broker-1", tx);
    throw new Error("boom");
  }, db));
  assert.equal((await byKey()).get("c|2023")!.status, "suggested", "rolled back");
  assert.equal((await listDecisions(DEAL, db)).length, 0);
  assert.equal((await getFigureState(DEAL, db))?.ddShownAt ?? null, null);
  await inFigureTransaction(async (tx) => {
    await approveNotes(DEAL, [{ id: notes.get("c|2023")!.id }], "broker-1", tx);
    await putDecision(DEAL, { checkKey: "interest|2022~tax_return:t2", state: "shown", reason: null, correctedValue: null, valuesSnapshot: { base: 268000, other: 301000 }, by: "broker-1" }, tx);
    await setDdShown(DEAL, new Date(), "broker-1", tx);
  }, db);
  assert.equal((await byKey()).get("c|2023")!.status, "approved");
  assert.equal((await listDecisions(DEAL, db))[0].state, "shown");
  assert.ok((await getFigureState(DEAL, db))?.ddShownAt);
});

test("questions: one per figure; status changes compare-and-set on the status read", async () => {
  const q = { figureKey: "line:fuel|2023", kind: "movement" as const, compareKey: "2022", captureKey: "reasonFuelChange2023", question: "What was behind the drop in fuel in 2023?", valuesShown: { line: "fuel" }, status: "ask_seller" as const, routedBy: "auto" as const };
  const id = await insertQuestionIfAbsent(DEAL, q, db);
  assert.ok(id);
  assert.equal(await insertQuestionIfAbsent(DEAL, { ...q, question: "again" }, db), null, "never twice");
  const [row] = await listQuestions(DEAL, db);
  assert.equal(row.status, "ask_seller");
  assert.equal(row.routedBy, "auto");
  assert.ok(row.routedAt);
  assert.equal(await updateQuestionIf(DEAL, id!, ["suggested"], { status: "closed" }, db), false, "not from a status it isn't in");
  assert.equal(await updateQuestionIf(DEAL, id!, ["ask_seller"], { status: "answered", sessionId: "s1", raisedAt: new Date() }, db), true);
  assert.equal(await updateQuestionIf("another-deal", id!, ["answered"], { status: "closed" }, db), false, "scoped to the deal");
  const counts = await figureCounts(DEAL, db);
  assert.equal(counts.questionsWithSeller, 0);
  assert.ok(counts.notesShown >= 2);
});

await run("figure-publish-pglite");
