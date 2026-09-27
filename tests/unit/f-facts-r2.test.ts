// FREE round 2, stream "facts" (f-facts-r2): the checker's findings on the
// first FREE round, proved offline (no model call; an in-memory store).
//  known-4        Ridgeline's recorded 27 notes → 16 (the owner's premises and the seller's played-down risks fold)
//  other-year     "the claim is another year's figure" drops a row only when the model says it MATCHES that year
//  todo/disc      a to-do heading or a "differs" note is dropped only when it really is process / a dispute on file
//  concentration  one-customer vs top-N applies only to concentration facts (AR aging, retention, mix keep their conflicts)
//  heartbeat      a long read keeps its row fresh; a second read of a source being read is refused
//  checklist      a deleted source's checklist row moves to a matching document still on the deal; an unreadable upload says why
//  cost           reads across the server share a few slots; the shared instructions are marked for the prompt cache
//  combine        a long source's prose joins each item once
//  no-copy        "Read it again" on a never-read source with no copy records why, instead of doing nothing
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/f-facts-r2.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { storage } from "../../server/storage";
import { dropReason } from "../../server/cim/discrepancy-filter";
import { chatterReason, isProcessTodoList } from "../../server/documents/private-notes-classify";
import { falseConflictReason } from "../../server/documents/conflict-measures";
import { finalizeNotes } from "../../server/documents/private-notes-review";
import { getPrivateNotes, privateNoteSources } from "../../server/interview/info-merger";
import {
  combineExtractions,
  extractDocumentData,
  withReadSlot,
  _readsInFlightForTests,
  _setExtractionClientForTests,
  _setExtractionRetryDelaysForTests,
  type ExtractionClient,
} from "../../server/documents/extractor";
import { ingestDocument, isBeingRead, NO_COPY_REASON, startReadHeartbeat } from "../../server/documents/ingest";
import { reprocessDealDocuments } from "../../server/documents/reprocess";
import { releaseRequirementsFor, replacementDocumentFor, withUnreadableNote, withoutUnreadableNote, linkUploadToRequirement } from "../../server/documents/requirements";

const ok = (msg: string) => console.log(`✓ ${msg}`);
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "f-facts");
_setExtractionRetryDelaysForTests([1, 1, 1]);

// ── other-year: the model's "refers to FY2024, which matches…" ────────────────────
{
  const rec = { field: "EBITDA FY2023", factYear: "2023", interviewValue: "$1,398,000", documentValue: "$1,282,000", severity: "significant" };
  const conflicts = [
    "The seller's figure appears to refer to FY2024, but it does not match the FY2024 statements either ($1,250,000).",
    "The seller's figure appears to refer to FY2024, which matches neither year's statements.",
    "The seller's figure may refer to FY2024 but is inconsistent with the FY2024 statements too.",
    "Even if the seller's figure refers to FY2024, it doesn't match the FY2024 statements ($1,250,000).",
    "If the figure relates to 2024 it still conflicts, since FY2024 EBITDA matches $1,250,000 in the statements.",
    "The figure is not for 2024 (which matches $1,250,000); for FY2023 the seller's $1,398,000 conflicts with $1,282,000.",
    "The seller's figure appears to refer to FY2024, which matches the FY2022 statements rather than FY2023.",
  ];
  for (const t of conflicts) assert.equal(dropReason({ ...rec, aiExplanation: t }), null, `kept: ${t}`);
  const notConflicts = [
    "The seller's figure appears to refer to FY2024 (which matches the FY2024 statements), not FY2023.",
    "The $1,398,000 the seller cited likely refers to fiscal 2024, which is consistent with the FY2024 statements.",
  ];
  for (const t of notConflicts) assert.equal(dropReason({ ...rec, aiExplanation: t }), "not_a_conflict", `dropped: ${t}`);
  // Other fields: the match clause names nothing of the year → a real conflict.
  const rows = [
    { field: "Lease expiry", interviewValue: "2027", documentValue: "June 30, 2029", severity: "significant", aiExplanation: "The seller's date appears to refer to 2027, which matches the original lease's initial term; the amended lease runs to June 30, 2029." },
    { field: "Year founded", interviewValue: "1998", documentValue: "Incorporated 2001", severity: "minor", aiExplanation: "The seller's year likely refers to 1998, consistent with when the owner started as a sole proprietor; the corporation dates from 2001." },
    { field: "Customer concentration", interviewValue: "Larkspur about 30% of revenue", documentValue: "Larkspur 18.0% of FY2024 revenue", severity: "significant", aiExplanation: "The seller's 30% appears to refer to 2022, which matches nothing on file; FY2024 shows 18%." },
  ];
  for (const r of rows) assert.equal(dropReason(r), null, `kept: ${r.field}`);
  ok("other-year: a row is dropped as another year's figure only when the model says it matches THAT year — 'does not match', 'neither', 'nothing on file', 'even if' and a match on another year stay conflicts");
}

// ── todo/disc: private-note wording rules ────────────────────────────────────────
{
  const ctx = (oneFact: (a: number, b: number) => boolean = () => false) => ({
    docNames: [] as string[],
    figureOnRecord: () => true,
    figuresOf: (t: string) => Array.from(t.matchAll(/\$?\d[\d,.]*\s?(?:[kKmM]\b)?/g)).map((m) => {
      const raw = m[0].replace(/[$,\s]/g, "");
      const k = /[kK]$/.test(raw) ? 1e3 : /[mM]$/.test(raw) ? 1e6 : 1;
      return Number(raw.replace(/[kKmM]$/, "")) * k;
    }).filter((n) => !Number.isNaN(n) && !(n >= 1900 && n <= 2100)),
    substantive: () => true,
    oneFactHolds: oneFact,
  });
  const hk = () => false;
  for (const n of [
    "Next steps — Luis may leave if the buyer is a competitor.",
    "Action items: Gord wants to close by March before the busy season starts.",
    "Next steps: confirm whether the Larkspur contract renews in 2026; Gord unsure it will.",
    "To-do: verify Westlock purchase order cancellation risk with Luis.",
  ]) assert.equal(chatterReason(n, ctx(), hk), null, `kept: ${n}`);
  assert.equal(chatterReason("Broker's to-do list: seller interview in Cimple, run financial analysis, resolve discrepancies (backlog, owner add-back), then CIM.", ctx(), hk), "the broker's to-do list");
  assert.ok(isProcessTodoList("To-do: send NDA, book site visit, request T2s"));
  assert.ok(!isProcessTodoList("To-do: send NDA, ask whether Larkspur renews"));
  // A "differs" note naming two items, not one fact's two values: kept.
  assert.equal(chatterReason("Gord's add-back list differs from the accountant's: truck $14,000, cottage $9,000.", ctx(() => true), hk), null);
  // One figure set against another, both values of one fact on file: dropped.
  const backlog = "Backlog discrepancy to resolve: $3.1M per WIP report vs $4.2M mentioned by Gord";
  assert.equal(chatterReason(backlog, ctx((a, b) => [a, b].sort().join() === [3.1e6, 4.2e6].sort().join()), hk), "a discrepancy whose figures are both on file");
  // …but not when no one fact holds both (the dispute isn't on file).
  assert.equal(chatterReason(backlog, ctx(() => false), hk), null);
  ok("todo/disc: a to-do heading is chatter only when every item is a process step (a key-person risk or a closing date under 'Next steps' stays); a note is 'a discrepancy on file' only when it sets two values of one fact against each other");
}

// ── concentration: only concentration facts ─────────────────────────────────────
{
  const pairs: Array<[string, string, string]> = [
    ["accountsReceivableAging", "18% over 90 days", "Top 3 accounts are 55% of receivables; 9% over 90 days"],
    ["accountsReceivable", "AR $450,000; 12% past 90 days", "$450,000 receivables; top 5 accounts 70%"],
    ["customerRetentionRate", "92% annual retention", "Top 10 customers retained 100% since 2019"],
    ["clientBase", "Residential 60%, commercial 40%", "Top 5 clients 30% of sales"],
  ];
  for (const [k, a, b] of pairs) {
    const why = falseConflictReason(k, { value: a, kind: "call" } as any, { value: b, kind: "document" } as any);
    assert.ok(!why || !/groups of customers/.test(why), `${k}: ${why}`);
  }
  const why = falseConflictReason("customerConcentration", { value: "Larkspur 18% of revenue", kind: "call" } as any, { value: "Top 3 customers: 41% of revenue", kind: "document" } as any);
  assert.match(String(why), /groups of customers/);
  const why2 = falseConflictReason("largestCustomer", { value: "Larkspur 18% of revenue", kind: "call" } as any, { value: "Top 3 customers: 41%", kind: "document" } as any);
  assert.match(String(why2), /groups of customers/);
  ok("concentration: one customer's share vs the top few's is 'different groups' only for concentration facts; AR aging, receivables, retention and customer mix keep their conflicts");
}

// ── known-4: the recorded Ridgeline notes ───────────────────────────────────────
{
  const { info, docs: docList } = JSON.parse(fs.readFileSync(path.join(FIX, "ridgeline-notes-after-reprocess.json"), "utf8"));
  const byName = new Map<string, any>(docList.map((d: any) => [d.name, d]));
  const docs = new Map<string, any>(docList.map((d: any) => [d.id, d]));
  for (const n of info._brokerPrivateNotes) for (const s of [n, ...(n.alsoFrom ?? [])]) {
    const d = s.documentId && byName.get(String(s.reason).replace(/^From /, ""));
    if (d) docs.set(s.documentId, { ...d, id: s.documentId });
  }
  const first = finalizeNotes(info, docs);
  const settled = finalizeNotes(first.info, docs);
  const notes = getPrivateNotes(settled.info);
  assert.ok(notes.length <= 16, `27 → ${notes.length}`);
  assert.equal(getPrivateNotes(finalizeNotes(settled.info, docs).info).length, notes.length, "settled");
  const all = (n: any) => [n.note, ...privateNoteSources(n).map((s: any) => s.wording ?? "")].join("\n");
  // The owner's premises: one note (the holdco building, the related-party lease, the lease to 2026).
  const premises = notes.filter((n) => /holdco|related party lease|McAllister Properties/i.test(all(n)));
  assert.equal(premises.length, 1, premises.map((n) => n.note.slice(0, 60)).join(" | "));
  assert.match(all(premises[0]), /\$4\.1M sale or lease/);
  assert.match(all(premises[0]), /runs to end of 2026/);
  // Gord playing the Larkspur risk down: one note, every source's words kept.
  const downplayed = notes.filter((n) => /waved off|dismissive/i.test(all(n)));
  assert.equal(downplayed.length, 1);
  assert.match(all(downplayed[0]), /frame it proactively/);
  assert.match(all(downplayed[0]), /Luis contradicted Gord on Larkspur risk/);
  // Nothing sensitive is lost.
  for (const re of [/cardiac episode/, /floor\/negotiation strategy/, /Only 3 people know about sale/, /seller financing/, /Coldbrook \$38,000/, /fishing every August/])
    assert.ok(notes.some((n) => re.test(all(n))), `kept: ${re}`);
  ok(`known-4: Ridgeline's recorded 27 private notes settle at ${notes.length} (the holdco premises and the played-down Larkspur risk fold; nothing sensitive dropped)`);
}

// ── known-4 (older extractions): one matter, the owner called by role or by name ──
{
  const note = (text: string, id: string) => ({ note: text, reason: "From Phone call", documentId: id });
  const info = {
    ownerName: "Gord McAllister",
    _brokerPrivateNotes: [
      note("Seller had a cardiac event in October 2024 (stent placed), doctor advised him to slow down.", "c1"),
      note("Seller stated 'don't want it in any brochure' regarding health episode", "c2"),
      note("Luis had knee surgery in 2023 and is fully back at work", "c3"),
      note("Gord willing to carry 15-20% seller financing for 3 years but wants most cash at closing", "c4"),
      note("Seller personal negotiation position: will carry 15-20% financing but 'not half' - has seen others not get paid", "c5"),
      note("Gord's target timing: done by end of Q1 2026", "c6"),
      note("Owner wants out by early 2026", "c7"),
      note("Gord's floor: asking $6.5M, approached by Jackpine in 2023 at ~3x", "c8"),
      note("Competitor sniffed around a couple yrs ago with insulting number", "c9"),
      note("Extract marked confidential and prepared for corporation's advisers only", "c10"),
    ],
  };
  const docs = new Map<string, any>(["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9", "c10"].map((id) => [id, { id, name: "Phone call", visibility: "shared", sourceKind: "call" }]));
  const out = getPrivateNotes(finalizeNotes(info, docs).info);
  const find = (re: RegExp) => out.filter((n) => re.test([n.note, ...privateNoteSources(n).map((s: any) => s.wording ?? "")].join("\n")));
  assert.equal(find(/cardiac|brochure/).length, 1, "the owner's health: one note");
  assert.match(find(/cardiac/)[0].note, /brochure/);
  assert.equal(find(/knee surgery/).length, 1);
  assert.ok(!/cardiac/.test(find(/knee surgery/)[0].note), "Luis's health is his own matter");
  assert.equal(find(/15-20%/).length, 1, "seller financing: one note");
  assert.equal(find(/Q1 2026|wants out/).length, 1, "timing: one note");
  assert.equal(find(/Jackpine|sniffed around/).length, 1, "the earlier approach: one note");
  assert.equal(find(/Extract marked confidential/).length, 0, "a document's own label and audience: not a note");
  assert.equal(out.length, 5, out.map((n) => n.note.slice(0, 50)).join(" | "));
  ok("known-4: one matter noted by two passes in other words folds — the owner's health, seller financing, timing, the earlier approach — however each calls the owner ('Seller', 'Owner', 'Gord'); another person's health stays apart; a document's label line goes");
}

// ── combine: prose items once ────────────────────────────────────────────────────
{
  const c = combineExtractions([
    { summary: "Tax returns 2022.", redFlags: "Customer concentration", keyFacts: "Share sale; CCPC" } as any,
    { summary: "Tax returns 2023.", redFlags: "Customer concentration; tax arrears", keyFacts: "Share sale" } as any,
    { redFlags: "customer concentration; Tax arrears of $12,000" } as any,
  ]);
  assert.equal(c.redFlags, "Customer concentration; Tax arrears of $12,000");
  assert.equal(c.keyFacts, "Share sale; CCPC");
  assert.equal(c.summary, "Tax returns 2022. Tax returns 2023.");
  ok("combine: a long source's red flags and key facts join each item once (a fuller wording replaces the shorter)");
}

// ── cost: read slots and the cached instructions ─────────────────────────────────
{
  let peak = 0;
  const tasks = Array.from({ length: 12 }, (_, i) => withReadSlot(async () => {
    peak = Math.max(peak, _readsInFlightForTests());
    await new Promise((r) => setTimeout(r, 5 + (i % 3)));
    return i;
  }));
  const done = await Promise.all(tasks);
  assert.deepEqual(done, Array.from({ length: 12 }, (_, i) => i));
  assert.equal(peak, 4, "12 reads (4 sources × 3 parts) run at most 4 at a time");
  assert.equal(_readsInFlightForTests(), 0);
  // A failing read frees its slot.
  await assert.rejects(withReadSlot(async () => { throw new Error("x"); }));
  assert.equal(_readsInFlightForTests(), 0);

  // A long source's parts go through the slots, sharing one cached system prompt.
  const bodies: any[] = [];
  let inFlight = 0;
  let maxSeen = 0;
  const client: ExtractionClient = {
    messages: {
      stream(body) {
        bodies.push(body);
        inFlight++;
        maxSeen = Math.max(maxSeen, inFlight);
        return { finalMessage: async () => { await new Promise((r) => setTimeout(r, 10)); inFlight--; return { stop_reason: "tool_use", content: [{ type: "tool_use", input: { summary: "Part." } }] }; } };
      },
    },
  };
  _setExtractionClientForTests(client);
  const long = Array.from({ length: 5 }, (_, i) => `FY${2020 + i} return. ${"Line item 1,000. ".repeat(4200)}`).join("\n\f");
  await Promise.all([extractDocumentData(long, "financials"), extractDocumentData(long, "financials")]);
  assert.ok(bodies.length >= 6, `parts read: ${bodies.length}`);
  assert.ok(maxSeen <= 4, `at most 4 reads in flight (saw ${maxSeen})`);
  for (const b of bodies) {
    assert.ok(Array.isArray(b.system) && b.system[0].cache_control?.type === "ephemeral", "the shared instructions are cached");
  }
  _setExtractionClientForTests(null);
  ok(`cost: reads share ${4} slots server-wide (two long sources, ${bodies.length} parts, never more than ${maxSeen} at once) and every read marks the shared instructions for the prompt cache`);
}

// ── In-memory store ─────────────────────────────────────────────────────────────
let deal: any;
let docs: any[];
let reqs: any[];
let touches = 0;
const s = storage as any;
s.getDeal = async () => (deal ? JSON.parse(JSON.stringify(deal)) : undefined);
s.updateDeal = async (_id: string, patch: any) => { deal = { ...deal, ...JSON.parse(JSON.stringify(patch)) }; return deal; };
s.getDocumentsByDeal = async () => docs.map((d) => ({ ...d }));
s.getDocument = async (id: string) => { const d = docs.find((x) => x.id === id); return d ? { ...d } : undefined; };
s.updateDocument = async (id: string, patch: any) => {
  const d = docs.find((x) => x.id === id);
  if (!d) return undefined;
  if (Object.keys(patch).length === 0) touches++;
  Object.assign(d, JSON.parse(JSON.stringify(patch)), { updatedAt: new Date() });
  return { ...d };
};
s.getDiscrepanciesByDeal = async () => [];
s.createDiscrepancy = async (data: any) => data;
s.updateDiscrepancy = async () => undefined;
s.getDocumentRequirementsByDeal = async () => reqs.map((r) => ({ ...r }));
s.updateDocumentRequirement = async (id: string, u: any) => Object.assign(reqs.find((r) => r.id === id), u);
const doc = (id: string, over: any = {}) => ({ id, dealId: "D", name: id, originalName: `${id}.pdf`, category: "financials", subcategory: null, sourceKind: "document", visibility: "shared", extractedText: null, extractedData: null, fileUrl: null, mimeType: null, status: "extracted", sourceMeta: null, isProcessed: true, uploadedBy: "seller", createdAt: new Date(1), updatedAt: new Date(), ...over });
const reset = () => {
  deal = { id: "D", businessName: "Harbourline Dental", industry: "Dental", askingPrice: null, extractedInfo: {} };
  docs = [];
  reqs = [];
};

// ── checklist: releasing a row ───────────────────────────────────────────────────
{
  reset();
  // The draft is deleted; the final statements are still on the deal.
  docs = [doc("final", { name: "Final financial statements FY2024", createdAt: new Date(5) }), doc("call", { sourceKind: "call", name: "Call — financial statements walkthrough" })];
  reqs = [{ id: "fs", dealId: "D", documentName: "Financial Statements (3 Years)", category: "financial", status: "verified", uploadedFileId: "draft", uploadedBy: "seller", uploadedAt: new Date(), notes: null }];
  assert.equal(await releaseRequirementsFor("D", "draft"), 1);
  assert.deepEqual([reqs[0].status, reqs[0].uploadedFileId, reqs[0].uploadedBy], ["uploaded", "final", "seller"], "credited to the final statements (verified again by the broker)");

  // Nothing matching left (a call about it is not the document): missing again.
  reset();
  docs = [doc("call", { sourceKind: "call", name: "Call — lease walkthrough" }), doc("other-lease", { name: "Lease agreement", status: "failed" })];
  reqs = [{ id: "l", dealId: "D", documentName: "Commercial Lease Agreement", category: "legal", status: "uploaded", uploadedFileId: "lease", uploadedBy: "seller", uploadedAt: new Date(), notes: "Include all amendments" }];
  await releaseRequirementsFor("D", "lease");
  assert.deepEqual([reqs[0].status, reqs[0].uploadedFileId], ["missing", null]);
  assert.equal(reqs[0].notes, "Include all amendments", "a plain delete leaves the broker's note alone");

  // A document already credited to another row is not taken twice.
  const row = { id: "x", documentName: "Financial Statements (3 Years)", category: "financial" };
  assert.equal(replacementDocumentFor(row, [doc("fs24", { name: "Financial statements FY2024" })] as any[], new Set(["fs24"])), undefined);

  // An unreadable upload: the seller's row says why, and a new upload clears it.
  reset();
  docs = [doc("scan", { name: "Lease scan", originalName: "lease-scan.pdf", status: "pending", extractedText: "25 King William  " })];
  reqs = [{ id: "l", dealId: "D", documentName: "Commercial Lease Agreement", category: "legal", status: "uploaded", uploadedFileId: "scan", uploadedBy: "seller", uploadedAt: new Date(), notes: "Include all amendments" }];
  await ingestDocument("scan");
  assert.equal(reqs[0].status, "missing");
  assert.match(String(reqs[0].notes), /^We couldn't read "lease-scan\.pdf" \(.*scanned image.*\)\. Please upload a readable copy\. · Include all amendments$/);
  await linkUploadToRequirement({ dealId: "D", docId: "lease2", fileName: "Lease.pdf", docCategory: "legal", uploadedBy: "seller", requirementId: "l" });
  assert.deepEqual([reqs[0].status, reqs[0].uploadedFileId, reqs[0].notes], ["uploaded", "lease2", "Include all amendments"]);
  assert.equal(withoutUnreadableNote(withUnreadableNote(null, "a.pdf", "no text")), null);
  ok("checklist: a deleted source's row moves to a matching document still on the deal (never re-asked); with none it is missing again; an unreadable upload tells the seller why, and a new upload clears that line");
}

// ── heartbeat: long reads stay fresh; one read at a time ────────────────────────
{
  reset();
  docs = [doc("tr", { status: "pending", extractedText: "Call transcript. ".repeat(20) })];
  touches = 0;
  const stop = startReadHeartbeat("tr", (id) => s.updateDocument(id, {}), 5);
  await new Promise((r) => setTimeout(r, 32));
  stop();
  const after = touches;
  assert.ok(after >= 3, `touched ${after} times`);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(touches, after, "stopped");

  // A read in progress: a second ingest does nothing.
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => { release = r; });
  let calls = 0;
  _setExtractionClientForTests({
    messages: {
      stream() {
        calls++;
        return { finalMessage: async () => { await gate; return { stop_reason: "tool_use", content: [{ type: "tool_use", input: { summary: "Call.", employees: "12" } }] }; } };
      },
    },
  });
  const first = ingestDocument("tr");
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(isBeingRead("tr"));
  assert.equal((await ingestDocument("tr")).status, "busy");
  release();
  assert.equal((await first).status, "extracted");
  assert.equal(calls, 1, "one read");
  assert.ok(!isBeingRead("tr"));
  _setExtractionClientForTests(null);
  ok("heartbeat: a source being read has its row touched while the read runs (never 'stopped' at 30 minutes); a second read of it is refused");
}

// ── no-copy: "Read it again" on a legacy failed row ─────────────────────────────
{
  reset();
  docs = [doc("wsib", { name: "WSIB clearance", status: "failed", extractedText: null, extractedData: { summary: "Extraction failed", _confidence: "low" }, fileUrl: "/uploads/docs/gone.pdf" })];
  let calls = 0;
  _setExtractionClientForTests({ messages: { stream() { calls++; throw new Error("no call expected"); } } });
  const r = await reprocessDealDocuments("D", undefined, { onlyDocumentIds: ["wsib"] });
  assert.equal(calls, 0);
  assert.equal(docs[0].status, "failed");
  assert.equal(docs[0].sourceMeta?.readFailed?.reason, NO_COPY_REASON);
  assert.equal(docs[0].sourceMeta?.readFailed?.retryable, undefined, "not offered again");
  assert.ok(r.failedSources.some((f) => f.documentId === "wsib"));
  // A source read before (its extraction on file) with no copy left just keeps what it had.
  reset();
  docs = [doc("old", { status: "extracted", extractedText: null, extractedData: { summary: "Old.", employees: "9" } })];
  await reprocessDealDocuments("D", undefined, { onlyDocumentIds: ["old"] });
  assert.equal(docs[0].sourceMeta?.readFailed, undefined);
  _setExtractionClientForTests(null);
  ok("no-copy: re-reading a never-read source with no file or text left records why (not offered again) instead of changing nothing; a source read before keeps what it had");
}

console.log("f-facts-r2: all passed");
process.exit(0);
