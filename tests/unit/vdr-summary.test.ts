/**
 * vdr spec §9.8, V12: buyer descriptions — the data room's only model call —
 * proven with a STUBBED model (recorded tool outputs). No paid AI.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled DISABLE_SCHEDULERS=1 npx tsx tests/unit/vdr-summary.test.ts
 *
 *  - a clean draft is stored "drafted"; buyers still read the basic line until
 *    the broker accepts it
 *  - an invented figure, a held person's name, judgement words, or text over
 *    the caps → the basic line (source "basic"); a model failure → the basic
 *    line (source "unavailable")
 *  - the model's input never carries red flags, private notes, action items or
 *    seller concerns; a ledger is never sent
 *  - drafts are asked for only when a document never had one; the per-deal
 *    daily cap (60) leaves the rest pending until the next day; a restart
 *    resumes pending items once; a description the broker wrote meanwhile is
 *    never overwritten
 *  - no model on the server → the basic line at once, no call
 *  - "Draft again": one document, within the cap
 */
import assert from "node:assert/strict";

process.env.DISABLE_SCHEDULERS = "1";
process.env.ANTHROPIC_API_KEY = "disabled";

const { _setSummaryModelForTests, requestSummaries, runPendingSummaries, redraftOne, guardSummary, summaryInputFor, summaryAiConfigured, remainingToday } = await import("../../server/vdr/buyer-summary");
const { buyerDescriptionFor, basicDescription, VDR_LIMITS } = await import("../../shared/vdr");
const { fakeVdrStore } = await import("./vdr-fake-store");

let clock = new Date("2026-10-09T12:00:00Z");
const DOCS = ["t2", "fs", "staff", "long", "judge", "missing"];
const docs: any[] = DOCS.map((id) => ({
  id, dealId: "D", name: `Doc ${id}`, originalName: `${id}.pdf`, category: "financials", fileUrl: `/uploads/docs/${id}.pdf`, mimeType: "application/pdf", createdAt: clock, visibility: "shared", sourceKind: "document",
  extractedData: { _documentType: "T2 Corporation Income Tax Return", _periodEnd: "2023-12-31", summary: "The corporation's 2023 return.", keyFacts: "Revenue $29,180,000", redFlags: "SECRET-RED-FLAG", _privateNotes: "SECRET-PRIVATE-NOTE", actionItems: "SECRET-ACTION", sellerConcerns: "SECRET-CONCERN" },
}));
docs.push({ id: "gl", dealId: "D", name: "General ledger 2024", originalName: "gl.xlsx", subcategory: "general_ledger", category: "financials", fileUrl: "/uploads/docs/gl.xlsx", createdAt: clock, visibility: "shared", sourceKind: "document", extractedData: {} });
const f = fakeVdrStore({ documents: docs });
const deal: any = {
  id: "D", brokerId: "b1", businessName: "Beacon Test Pharmacy", extractedInfo: {
    revenue: "$29,180,000",
    netIncome: "$665,915",
    employees: "Key personnel: Daniel Okafor (LTC lead pharmacist) is thinking of leaving unless he gets a stake",
    _fieldSources: { revenue: { source: "document", documentId: "t2" }, netIncome: { source: "document", documentId: "t2" } },
    _brokerPrivateNotes: [{ note: "Daniel Okafor's equity ask — keep out of the CIM", documentId: "staff" }],
  },
};
await f.store.ensureRoom({ dealId: "D", setUpBy: "b1" });
for (const id of [...DOCS, "gl"]) {
  const it = await f.store.insertItem({ dealId: "D", folderId: "F", documentId: id, title: `Doc ${id}`, position: 1 });
  it!.prepared = { status: "ready", kind: id === "gl" ? "ledger_pending" : "pdf", forFile: "0123456789abcdef", pages: [{ w: 1, h: 1, hasText: true }, { w: 1, h: 1, hasText: true }] };
}
const item = (doc: string) => f.items.find((i) => i.documentId === doc)!;
await f.store.replacePageText({ dealId: "D", itemId: item("t2").id, forFile: "0123456789abcdef", rows: [{ page: 1, label: "Page 1", text: "T2 Corporation Income Tax Return. Total revenue 29,180,000. Net income 665,915." }] });
const deps = { store: f.store, getDeal: async () => deal, now: () => clock };

// ── Guards (pure) ──
const known = "Total revenue 29,180,000. Net income 665,915.";
assert.equal(guardSummary({ summary: "The 2023 corporate tax return, reporting revenue of $29,180,000.", keyPoints: ["Net income $665,915"] }, known, []).ok, true);
assert.match((guardSummary({ summary: "Revenue of $31,000,000.", keyPoints: [] }, known, []) as any).reason, /figure/);
assert.equal(guardSummary({ summary: "Revenue of $29.2 million.", keyPoints: [] }, known, []).ok, true, "a rounded figure of one printed traces");
assert.equal((guardSummary({ summary: "Signed by Daniel Okafor.", keyPoints: [] }, known, ["Daniel Okafor"]) as any).reason, "held person");
assert.equal((guardSummary({ summary: "An attractive return showing strong performance.", keyPoints: [] }, known, []) as any).reason, "judgement words");
assert.equal((guardSummary({ summary: Array.from({ length: 71 }, () => "word").join(" "), keyPoints: [] }, known, []) as any).reason, "too long");
assert.equal((guardSummary({ summary: "Fine.", keyPoints: ["a", "b", "c", "d", "e"] }, known, []) as any).reason, "too many points");
assert.equal((guardSummary({ summary: "Fine.", keyPoints: [Array.from({ length: 21 }, () => "w").join(" ")] }, known, []) as any).reason, "point too long");
assert.equal((guardSummary({ summary: "The owner's cancer diagnosis is discussed.", keyPoints: [] }, known, []) as any).ok, false, "sensitive detail");

// ── Inputs never carry broker-only words ──
const input = summaryInputFor(deal, item("t2"), docs[0], new Set(), ["Daniel Okafor"]);
const inputText = JSON.stringify(input);
for (const secret of ["SECRET-RED-FLAG", "SECRET-PRIVATE-NOTE", "SECRET-ACTION", "SECRET-CONCERN"]) assert.ok(!inputText.includes(secret), `${secret} never reaches the model`);
assert.deepEqual(input.facts.map((x) => x.label).sort(), ["Net income", "Revenue"]);
assert.equal(input.documentType, "T2 Corporation Income Tax Return");

// ── No model on this server → basic at once, no call ──
assert.equal(summaryAiConfigured(), false);
assert.equal(await requestSummaries(f.store, "D", [item("t2").id], clock), 0);
assert.deepEqual([item("t2").buyerSummaryStatus, item("t2").buyerSummarySource], ["failed", "unavailable"]);
assert.match((await redraftOne(deps, deal, item("fs").id)).message, /can't write descriptions on this server/);
// Reset for the model path.
Object.assign(item("t2"), { buyerSummaryStatus: null, buyerSummarySource: null, buyerSummaryAt: null });

// ── The stubbed model ──
const calls: any[] = [];
let respond: (docs: any[]) => any = (ds) => ({
  documents: ds.map((d: any) => {
    if (d.itemId === item("t2").id) return { itemId: d.itemId, summary: "The corporation's 2023 T2 return: revenue of $29,180,000 and the schedules filed.", keyPoints: ["Net income $665,915"] };
    if (d.itemId === item("fs").id) return { itemId: d.itemId, summary: "Statements showing revenue of $31,000,000.", keyPoints: [] };
    if (d.itemId === item("staff").id) return { itemId: d.itemId, summary: "Staff list including Daniel Okafor.", keyPoints: [] };
    if (d.itemId === item("long").id) return { itemId: d.itemId, summary: Array.from({ length: 80 }, () => "text").join(" "), keyPoints: [] };
    if (d.itemId === item("judge").id) return { itemId: d.itemId, summary: "We recommend reading this first.", keyPoints: [] };
    return null; // "missing": the model skipped it
  }).filter(Boolean),
});
_setSummaryModelForTests(async (i) => {
  const ds = JSON.parse(i.user.replace(/^<documents>\n/, "").replace(/\n<\/documents>$/, ""));
  calls.push(ds);
  return respond(ds);
});
assert.equal(summaryAiConfigured(), true);
const ids = [...DOCS, "gl"].map((d) => item(d).id);
assert.equal(await requestSummaries(f.store, "D", ids, clock), 7);
assert.ok(f.items.filter((i) => ids.includes(i.id)).every((i) => i.buyerSummaryStatus === "pending"));
// First pass: one batch of five (cap 60 is fine).
let n = await runPendingSummaries(deps);
assert.equal(n, 5);
assert.equal(calls.length, 1);
assert.ok(calls[0].length <= 5, "batches of five");
n = await runPendingSummaries(deps);
assert.equal(n, 2);
assert.equal(calls.length, 2, "the ledger never reached the model");
assert.ok(!calls.flat().some((d: any) => d.itemId === item("gl").id));
assert.ok(!JSON.stringify(calls).includes("SECRET"), "no broker-only words in any batch");
const t2 = item("t2");
assert.deepEqual([t2.buyerSummaryStatus, t2.buyerSummarySource], ["drafted", "ai"]);
assert.deepEqual(t2.buyerSummaryPoints, ["Net income $665,915"]);
// Buyers still read the basic line until the broker accepts it.
const basic = basicDescription(docs[0], t2.prepared);
assert.equal(buyerDescriptionFor(t2, basic).text, basic, "drafted → buyers see the basic line");
t2.buyerSummaryStatus = "accepted";
assert.match(buyerDescriptionFor(t2, basic).text, /\$29,180,000/, "accepted → buyers see it");
for (const id of ["fs", "staff", "long", "judge", "missing"]) assert.deepEqual([item(id).buyerSummaryStatus, item(id).buyerSummarySource, item(id).buyerSummary], ["failed", "basic", null], `${id}: basic line`);
assert.deepEqual([item("gl").buyerSummaryStatus, item("gl").buyerSummarySource], ["failed", "basic"], "a ledger gets gl's line, never the model's");
assert.equal(f.activity.filter((a) => a.action === "summary_drafted").length, 1);

// Asked for only once: a document that had one is never re-requested.
assert.equal(await requestSummaries(f.store, "D", [t2.id, item("fs").id], clock), 0);

// ── A model failure → basic ("unavailable") ──
const extra = await f.store.insertItem({ dealId: "D", folderId: "F", documentId: "t2b", title: "Another", position: 2 });
f.documents.push({ ...docs[0], id: "t2b" });
extra!.prepared = { status: "ready", kind: "pdf", forFile: "x", pages: [{ w: 1, h: 1, hasText: true }] };
respond = () => { throw Object.assign(new Error("overloaded"), { status: 529 }); };
await requestSummaries(f.store, "D", [extra!.id], clock);
await runPendingSummaries(deps);
assert.deepEqual([extra!.buyerSummaryStatus, extra!.buyerSummarySource], ["failed", "unavailable"]);

// ── Not prepared yet → waits (stays pending, no call) ──
const waiting = await f.store.insertItem({ dealId: "D", folderId: "F", documentId: "w", title: "Waiting", position: 3 });
f.documents.push({ ...docs[0], id: "w" });
waiting!.prepared = { status: "pending", kind: "pdf", forFile: "x" };
await requestSummaries(f.store, "D", [waiting!.id], clock);
const before = calls.length;
assert.equal(await runPendingSummaries(deps), 0);
assert.equal(calls.length, before);
assert.equal(waiting!.buyerSummaryStatus, "pending");

// ── The daily cap: the rest wait for tomorrow; a restart resumes them once ──
waiting!.prepared = { status: "ready", kind: "pdf", forFile: "x", pages: [{ w: 1, h: 1, hasText: true }] };
respond = (ds) => ({ documents: ds.map((d: any) => ({ itemId: d.itemId, summary: "A tax return.", keyPoints: [] })) });
const more: any[] = [];
for (let k = 0; k < 4; k++) {
  const it = await f.store.insertItem({ dealId: "D", folderId: "F", documentId: `m${k}`, title: `More ${k}`, position: 10 + k });
  f.documents.push({ ...docs[0], id: `m${k}` });
  it!.prepared = { status: "ready", kind: "pdf", forFile: "x", pages: [{ w: 1, h: 1, hasText: true }] };
  more.push(it);
}
await requestSummaries(f.store, "D", more.map((m) => m.id), clock);
await f.store.updateRoom("D", { summaryBudgetDay: "2026-10-09", summaryBudgetUsed: VDR_LIMITS.summaryDailyCap - 2 });
assert.equal(remainingToday(f.rooms.get("D"), clock), 2);
assert.equal(await runPendingSummaries(deps), 2);
assert.equal(await runPendingSummaries(deps), 0, "cap reached: the rest stay pending");
const stillPending = () => f.items.filter((i) => i.buyerSummaryStatus === "pending").length;
assert.equal(stillPending(), 3);
assert.match((await redraftOne(deps, deal, t2.id)).message, /today's descriptions/, "Draft again respects the cap");
// Next day (and a "restart": just another pass of the queue) → they're drafted, once.
clock = new Date("2026-10-10T08:00:00Z");
const c0 = calls.length;
assert.equal(await runPendingSummaries(deps), 3);
assert.equal(stillPending(), 0);
assert.equal(await runPendingSummaries(deps), 0, "nothing is drafted twice");
assert.equal(calls.length, c0 + 1);

// ── Never overwrite what the broker wrote meanwhile ──
const raced = await f.store.insertItem({ dealId: "D", folderId: "F", documentId: "r", title: "Raced", position: 20 });
f.documents.push({ ...docs[0], id: "r" });
raced!.prepared = { status: "ready", kind: "pdf", forFile: "x", pages: [{ w: 1, h: 1, hasText: true }] };
await requestSummaries(f.store, "D", [raced!.id], clock);
respond = (ds) => {
  Object.assign(raced!, { buyerSummary: "Written by the broker.", buyerSummarySource: "broker", buyerSummaryStatus: "accepted" });
  return { documents: ds.map((d: any) => ({ itemId: d.itemId, summary: "A tax return.", keyPoints: [] })) };
};
await runPendingSummaries(deps);
assert.deepEqual([raced!.buyerSummary, raced!.buyerSummarySource, raced!.buyerSummaryStatus], ["Written by the broker.", "broker", "accepted"]);

// ── Draft again ──
respond = (ds) => ({ documents: ds.map((d: any) => ({ itemId: d.itemId, summary: "The 2023 T2 return, reporting revenue of $29,180,000.", keyPoints: [] })) });
const re = await redraftOne(deps, deal, t2.id);
assert.equal(re.ok, true, re.message);
assert.deepEqual([t2.buyerSummaryStatus, t2.buyerSummarySource], ["drafted", "ai"]);

_setSummaryModelForTests(null);
console.log("vdr-summary: all passed");
