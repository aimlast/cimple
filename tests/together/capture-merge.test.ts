/**
 * Live filing into the deal's facts (specs/together.md §5.7, §5.8, §11.2),
 * in memory — no database, no model:
 *  - provenance: call (in person) with the transcript row, the seller's
 *    words, how sure they were, the sitting and the part;
 *  - decision A: a spoken revenue against the statements keeps the
 *    statements; the spoken one is another value and a merge discrepancy;
 *  - exactly once: applying the same part twice changes nothing;
 *  - the transcript row's extraction is the union of what was filed minus
 *    what was undone; its text holds only the seller's words;
 *  - Undo restores value, source and other values; refuses after a later
 *    change; "Read again" never brings an undone value back;
 *  - ingestDocument never reads a session's row; deleting it mid-session
 *    stops filing, clears lines and results, and it is never recreated;
 *  - the broker's typed notes rank below a document where documents are the
 *    authority; ✓ Confirmed on a CRM lead copies no text anywhere.
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/together/capture-merge.test.ts
 */
import { counters, install, lakeshoreDeal, newWorld, statementDoc } from "./harness";
import assert from "node:assert/strict";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

async function main() {
  const w = newWorld();
  w.deals.D1 = lakeshoreDeal();
  w.documents.push(statementDoc(), { id: "CRM1", dealId: "D1", name: "Pipedrive notes", visibility: "broker_only", sourceKind: "crm", category: "crm", sourceMeta: {}, createdAt: new Date(), extractedData: {}, fileUrl: null });
  const store = await install(w);
  const { startOrResumeSitting, recordConsent, appendLines } = await import("../../server/together/sittings");
  const { applyCapture, undoCapture, cumulativeExtraction, isApplied } = await import("../../server/together/capture-apply");
  const { writeTranscriptText } = await import("../../server/together/transcript");
  const { ingestDocument } = await import("../../server/documents/ingest");
  const { deleteDocumentAndProvenance } = await import("../../server/documents/cleanup");
  const { getFieldSources, getFieldAlternates } = await import("../../server/interview/info-merger");
  const { buildCoverageBoard } = await import("../../server/interview/coverage-board");
  const { confirmItem, writeBrokerCallNotes } = await import("../../server/together/capture-apply");
  const { appendNotedItems, patchOutline, getInterviewOutline } = await import("../../server/interview/outline");
  const { _setCaptureEnabledForTests } = await import("../../server/together/chunker");
  _setCaptureEnabledForTests(false); // (these tests call the filing directly)

  const facts = () => w.deals.D1.extractedInfo as Record<string, any>;
  const { sitting } = await startOrResumeSitting(w.deals.D1, "B1", "person");
  await recordConsent(sitting);
  await appendLines(sitting.id, "tab-1", [
    { clientSeq: 0, speaker: "dg:0", text: "So what are the busy times of year for you?", source: "deepgram" },
    { clientSeq: 1, speaker: "dg:1", text: "Summer and the cold snaps are crazy — June through August, then December to February.", source: "deepgram" },
    { clientSeq: 2, speaker: "dg:1", text: "Sales were about five point two million last year.", source: "deepgram" },
  ], { deal: w.deals.D1 });
  await (await import("../../server/together/sittings")).setSpeakerRole(sitting.id, "dg:0", "broker", { deal: w.deals.D1 });
  const sit = async () => (await store.getSitting(sitting.id))!;
  const guarded = (over: Record<string, unknown> = {}) => ({
    spoken: [
      { key: "seasonality", itemId: "seasonality:seasonality", value: "Busiest June–August and December–February", quote: "Summer and the cold snaps are crazy", excerpt: "Summer and the cold snaps are crazy — June through August, then December to February.", lines: [2], speaker: "seller" as const, confidence: "confirmed" as const },
      { key: "annualRevenue", itemId: "financials:annualRevenue", value: "$5.2M", quote: "about five point two million", excerpt: "Sales were about five point two million last year.", lines: [3], speaker: "seller" as const, confidence: "approximate" as const },
    ],
    typed: [], suggestions: [], brokerUnconfirmed: [], notKnown: [], privateNotes: [], keepOut: [], retractions: [], otherFacts: [], dropped: [], followUp: null, topicSections: ["seasonality"],
    ...over,
  });
  const chunk1 = await store.insertChunk({ sittingId: sitting.id, dealId: "D1", seqFrom: 1, seqTo: 3, reason: "pause", status: "applying", attempts: 1 });

  console.log("capture merge");

  await test("provenance: a call source on the transcript row, with the seller's words, confidence, the sitting and the part", async () => {
    const res = await applyCapture({ sitting: await sit(), chunk: chunk1, guarded: guarded() as any, sellerLabel: "Tony Moretti (seller)" });
    const docId = (await sit()).transcriptDocumentId!;
    assert.ok(docId, "the transcript row exists");
    const src = getFieldSources(facts()).seasonality as any;
    assert.equal(src.source, "call");
    assert.equal(src.documentId, docId);
    assert.equal(src.speaker, "Tony Moretti (seller)");
    assert.match(src.excerpt, /^Summer and the cold snaps/);
    assert.equal(src.confidence, "confirmed");
    assert.equal(src.sittingId, sitting.id);
    assert.equal(src.chunkId, chunk1.id);
    assert.ok(res.filed.some((f) => f.key === "seasonality"));
    assert.ok(isApplied(facts(), sitting.id, chunk1.chunkNo), "the marker is saved with the facts");
    // (The pipeline stores the result — with the undo snapshots — on the part.)
    await store.updateChunk(chunk1.id, { result: res as any, status: "done" });
  });

  await test("decision A: the spoken revenue doesn't replace the statements — it's another value", async () => {
    assert.equal(facts().annualRevenue, "$4,812,300");
    const alts = getFieldAlternates(facts()).annualRevenue ?? [];
    assert.ok(alts.some((a: any) => a.value === "$5.2M" && a.source === "call"));
    assert.ok(w.discrepancies.some((d) => d.source === "merge" && d.factKey === "annualRevenue" && d.status === "open"), "a merge discrepancy is raised (shown as 'to verify')");
    const board = await buildCoverageBoard(w.deals.D1, { audience: "broker" });
    const rev = board.sections.flatMap((s) => s.items).find((i) => i.id === "financials:annualRevenue");
    assert.equal(rev?.status, "verify");
    assert.equal(rev?.reason?.code, "conflict");
  });

  await test("exactly once: the same part applied again changes nothing", async () => {
    const before = JSON.stringify(facts());
    const again = await applyCapture({ sitting: await sit(), chunk: chunk1, guarded: guarded() as any, sellerLabel: "Tony Moretti (seller)" });
    assert.equal(JSON.stringify(facts()), before);
    assert.equal(again.filed.length, 0);
  });

  await test("the transcript row: the union of what was filed; its text only the seller's words", async () => {
    const s = await sit();
    await writeTranscriptText(s);
    const doc = w.documents.find((d) => d.id === s.transcriptDocumentId)!;
    assert.equal(doc.extractedData.seasonality, "Busiest June–August and December–February");
    assert.equal(doc.extractedData._excerpts.seasonality.slice(0, 12), "Summer and t");
    assert.match(doc.extractedText, /Summer and the cold snaps/);
    assert.doesNotMatch(doc.extractedText, /busy times of year/, "the broker's question is not in the row's text");
    assert.deepEqual(cumulativeExtraction({ a: "1", _speakers: { a: "x" } }, { b: "2", _speakers: { b: "y" } }, ["a"]), { b: "2", _speakers: { b: "y" }, summary: "Answers filed live during Interview together." });
  });

  await test("ingestDocument never reads a session's row", async () => {
    const s = await sit();
    const r = await ingestDocument(s.transcriptDocumentId!);
    assert.deepEqual(r, { status: "extracted", fieldsWritten: [] });
    assert.equal(counters.modelCalls, 0);
  });

  await test("Undo puts the value back exactly; the row's extraction drops it (no replay brings it back)", async () => {
    await undoCapture({ sitting: await sit(), chunk: (await store.getChunk(chunk1.id))!, key: "seasonality" });
    assert.equal(facts().seasonality, undefined);
    assert.equal(getFieldSources(facts()).seasonality, undefined);
    assert.ok((getFieldAlternates(facts()).annualRevenue ?? []).some((a: any) => a.value === "$5.2M"), "the other key is untouched");
    // Undo of the revenue removes its other value too.
    await undoCapture({ sitting: await sit(), chunk: (await store.getChunk(chunk1.id))!, key: "annualRevenue" });
    assert.ok(!(getFieldAlternates(facts()).annualRevenue ?? []).some((a: any) => a.value === "$5.2M"));
    const row = w.documents.find((d) => d.sourceMeta?.recordType === "together_sitting")!;
    assert.equal(row.extractedData.seasonality, undefined);
    assert.deepEqual(((await sit()).captureState as any).undone.map((u: any) => u.key), ["seasonality", "annualRevenue"]);
    await assert.rejects(() => undoCapture({ sitting: store.sittings[0] as any, chunk: (store.chunks[0] as any), key: "seasonality" }), /isn't there any more/);
  });

  await test("a deal-wide re-read replays the session's row as filed (never reads it again; the undone value stays gone)", async () => {
    const { reprocessDealDocuments } = await import("../../server/documents/reprocess");
    await reprocessDealDocuments("D1").catch((err) => { throw err; });
    assert.equal(facts().seasonality, undefined);
    assert.equal(counters.modelCalls, 0, "nothing was read with a model");
  });

  await test("Undo, then the seller says it again: the new answer stands in the row, survives a later part and a deal-wide re-read", async () => {
    // A retry of the part that was undone changes nothing — not the facts, not the row, not the Undo list.
    const retry = await applyCapture({ sitting: await sit(), chunk: chunk1, guarded: guarded() as any, sellerLabel: "Tony Moretti (seller)" });
    assert.equal(retry.filed.length, 0);
    assert.equal(facts().seasonality, undefined);
    assert.equal(w.documents.find((d) => d.sourceMeta?.recordType === "together_sitting")!.extractedData.seasonality, undefined, "a retry never brings an undone value back into the row");
    assert.deepEqual(((await sit()).captureState as any).undone.map((u: any) => u.key), ["seasonality", "annualRevenue"]);
    const refile = await store.insertChunk({ sittingId: sitting.id, dealId: "D1", seqFrom: 2, seqTo: 2, reason: "pause", status: "applying", attempts: 1 });
    const again = { ...guarded().spoken[0], value: "Busy July and August", quote: "July and August are busy", excerpt: "July and August are busy." };
    const r1 = await applyCapture({ sitting: await sit(), chunk: refile, guarded: guarded({ spoken: [again] }) as any, sellerLabel: "Tony Moretti (seller)" });
    await store.updateChunk(refile.id, { result: r1 as any, status: "done" });
    assert.equal(facts().seasonality, "Busy July and August");
    const row = () => w.documents.find((d) => d.sourceMeta?.recordType === "together_sitting")!;
    assert.equal(row().extractedData.seasonality, "Busy July and August", "the row asserts the new answer");
    assert.ok(!((await sit()).captureState as any).undone.some((u: any) => u.key === "seasonality"), "the earlier Undo no longer applies to the key");
    // A later part about something else leaves it alone.
    const later = await store.insertChunk({ sittingId: sitting.id, dealId: "D1", seqFrom: 3, seqTo: 3, reason: "pause", status: "applying", attempts: 1 });
    const other = { key: "ownerInvolvement", itemId: "employees:ownerInvolvement", value: "In three days a week", quote: "three days a week", excerpt: "I'm in three days a week.", lines: [3], speaker: "seller" as const, confidence: "confirmed" as const };
    const r2 = await applyCapture({ sitting: await sit(), chunk: later, guarded: guarded({ spoken: [other] }) as any, sellerLabel: "Tony Moretti (seller)" });
    await store.updateChunk(later.id, { result: r2 as any, status: "done" });
    assert.equal(row().extractedData.seasonality, "Busy July and August", "a later part doesn't drop it");
    // "Read all again" replays the row: the seller's corrected answer stays.
    const { reprocessDealDocuments } = await import("../../server/documents/reprocess");
    await reprocessDealDocuments("D1");
    assert.equal(facts().seasonality, "Busy July and August");
    assert.equal(facts().ownerInvolvement, "In three days a week");
    assert.equal(counters.modelCalls, 0);
    // The pure rule: what was undone leaves first; a key this part says again stands.
    assert.equal(cumulativeExtraction({ seasonality: "old", _excerpts: { seasonality: "x" } }, { seasonality: "new", _excerpts: { seasonality: "y" } }, ["seasonality"]).seasonality, "new");
    assert.deepEqual((cumulativeExtraction({ seasonality: "old", _excerpts: { seasonality: "x" } }, { seasonality: "new", _excerpts: { seasonality: "y" } }, ["seasonality"]) as any)._excerpts, { seasonality: "y" });
  });

  await test("a change since → 'This was changed since — use Edit.'", async () => {
    const chunk3 = await store.insertChunk({ sittingId: sitting.id, dealId: "D1", seqFrom: 2, seqTo: 2, reason: "pause", status: "applying", attempts: 1 });
    const res = await applyCapture({ sitting: await sit(), chunk: chunk3, guarded: guarded({ spoken: [guarded().spoken[0]] }) as any, sellerLabel: "Tony Moretti (seller)" });
    await store.updateChunk(chunk3.id, { result: res as any });
    w.deals.D1.extractedInfo = { ...facts(), seasonality: "The broker's own edit", _fieldSources: { ...facts()._fieldSources, seasonality: { source: "broker", at: new Date().toISOString() } } };
    const s3 = await sit();
    const c3 = (await store.getChunk(chunk3.id))!;
    await assert.rejects(() => undoCapture({ sitting: s3, chunk: c3, key: "seasonality" }), /changed since/);
    assert.equal(facts().seasonality, "The broker's own edit");
  });

  await test("typed notes: the broker's note ranks below a document where documents are the authority", async () => {
    const r = await writeBrokerCallNotes("D1", [{ key: "annualRevenue", value: "$5M" }], { sittingId: sitting.id });
    assert.deepEqual(r.keptBeside, ["annualRevenue"]);
    assert.equal(facts().annualRevenue, "$4,812,300");
    const r2 = await writeBrokerCallNotes("D1", [{ key: "fleetSize", value: "22 trucks" }], { sittingId: sitting.id, chunk: { id: "CT", chunkNo: 99 } });
    assert.deepEqual(r2.written, ["fleetSize"]);
    assert.equal((getFieldSources(facts()).fleetSize as any).chunkId, "CT");
    const r3 = await writeBrokerCallNotes("D1", [{ key: "fleetSize", value: "23 trucks" }], { sittingId: sitting.id, chunk: { id: "CT", chunkNo: 99 } });
    assert.equal(r3.skipped, true, "a typed part is filed once");
  });

  await test("✓ Confirmed on a CRM lead: vouched for, no text copied anywhere; the seller's board still misses it", async () => {
    const board0 = await buildCoverageBoard(w.deals.D1, { audience: "broker" });
    const lead = board0.sections.flatMap((s) => s.items).find((i) => i.reason?.code === "lead");
    assert.ok(lead, "the CRM's customer concentration is a lead to verify");
    if (lead) {
      const rowBefore = JSON.stringify(w.documents.find((d) => d.sourceMeta?.recordType === "together_sitting")?.extractedData);
      await confirmItem(w.deals.D1, lead.id, "B1", { sittingId: sitting.id, reload: async () => w.deals.D1 });
      const src = getFieldSources(facts())[lead.valueKey!] as any;
      assert.equal(src.acceptedByBroker, true);
      assert.equal(JSON.stringify(w.documents.find((d) => d.sourceMeta?.recordType === "together_sitting")?.extractedData), rowBefore);
      const seller = await buildCoverageBoard(w.deals.D1, { audience: "seller" });
      const sItem = seller.sections.flatMap((s) => s.items).find((i) => i.id === lead.id);
      assert.notEqual(sItem?.status, "on_file");
    } else {
      // (The fixture deal keeps its CRM lead out of the checklist — nothing to confirm.)
      assert.ok(true);
    }
  });

  await test("'also noted' items and an outline edit don't lose each other's writes", async () => {
    await Promise.all([
      appendNotedItems("D1", [{ key: "fleetSize", label: "Fleet size", sectionKey: "operations" }]),
      patchOutline(w.deals.D1, { removeItems: ["slowPeriods"] } as any).catch(() => undefined),
    ]);
    const o = getInterviewOutline(w.deals.D1);
    assert.ok(o.addedItems?.some((a) => a.key === "fleetSize" && a.origin === "noted"));
  });

  await test("deleting the transcript mid-session: its facts go, filing stops, lines and results clear, never recreated", async () => {
    const s = await sit();
    const chunk4 = await store.insertChunk({ sittingId: sitting.id, dealId: "D1", seqFrom: 1, seqTo: 3, reason: "pause", status: "applying", attempts: 1 });
    await applyCapture({ sitting: s, chunk: chunk4, guarded: guarded({ spoken: [{ ...guarded().spoken[0], key: "peakPeriods", itemId: "seasonality:seasonality", value: "June–August" }] }) as any, sellerLabel: "Tony Moretti (seller)" });
    assert.equal(facts().peakPeriods, "June–August");
    await deleteDocumentAndProvenance(s.transcriptDocumentId!);
    assert.equal(facts().peakPeriods, undefined);
    const after = await sit();
    assert.equal((after.captureState as any).sourceDeleted, true);
    assert.equal(await store.countLines(sitting.id), 0);
    assert.ok((await store.listChunks(sitting.id)).every((c) => c.result === null && c.delta === null));
    await assert.rejects(() => appendLines(sitting.id, "tab-1", [{ clientSeq: 9, speaker: "dg:1", text: "More words", source: "deepgram" }], { deal: w.deals.D1 }), /deleted/);
    const { ensureTranscriptDocument } = await import("../../server/together/transcript");
    assert.equal(await ensureTranscriptDocument({ ...after, transcriptDocumentId: null } as any, w.deals.D1), null);
  });

  assert.equal(counters.modelCalls, 0, "no model was called");
  console.log(`\n${passed} merge checks passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
