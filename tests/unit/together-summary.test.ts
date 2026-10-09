/**
 * Interview together — the end of a session (specs/together.md §4.7, §7.6):
 *  - screening of asks before they reach the seller (the broker's
 *    normalisation work or material, a detail the seller asked to keep out,
 *    a staff member's private matter);
 *  - follow-ups on the outline: one per item, label + ask only; answered
 *    ones drop out of the prompt; the wrap-up check knows which were raised;
 *  - the summary's defaults (critical, "come back later", "someone else has
 *    it" ticked; required or promised documents ticked), filed rows, the
 *    private-notes count, the screen flag;
 *  - the email body escapes what it prints.
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/together-summary.test.ts
 */
import assert from "node:assert/strict";
import { screenAsk, buildSittingSummary, followUpEmail } from "../../server/together/summary";
import { followUpItemsRaised, getInterviewOutline, openFollowUpItems, outlineWithFollowUps, renderOutlineForPrompt } from "../../server/interview/outline";
import type { CoverageBoard, CoverageItem } from "../../shared/coverage-board";

let n = 0;
const ok = (name: string) => { n++; console.log("✓", name); };

async function main() {
  // ── Screening ──
  const deal: any = {
    extractedInfo: {
      keyEmployees: "Dave Kowalski — service manager, 14 years",
      ownerName: "Tony Moretti",
      _sellerKeepOut: [{ detail: "Dave's divorce settlement", terms: ["divorce"] }],
    },
  };
  assert.equal((await screenAsk("Which months are your busiest, and which are the quietest?", deal)).ok, true);
  for (const bad of [
    "Which add-backs should we include?",
    "What do you think the SDE is?",
    "Per the broker's notes, is revenue $4.8M?",
    "What's in the CRM notes about the lease?",
    "Is the business worth 4x EBITDA?",
  ]) {
    const r = await screenAsk(bad, deal);
    assert.equal(r.ok, false, bad);
    if (!r.ok) assert.equal(r.reason, "broker_work", bad);
  }
  const ko = await screenAsk("How is Dave's divorce affecting his work?", deal);
  assert.equal(ko.ok, false);
  if (!ko.ok) {
    assert.equal(ko.reason, "keep_out");
    assert.match(ko.message, /private to you — reword it before it goes to the seller/);
  }
  const staff = await screenAsk("Has Dave asked you for equity in the business?", deal);
  assert.equal(staff.ok, false, "a staff member's private matter");
  const { GENERIC_ASKS } = await import("../../server/interview/coverage-asks");
  for (const [k, a] of Object.entries(GENERIC_ASKS)) assert.equal((await screenAsk(a.ask, deal)).ok, true, `the suggested ask for ${k} goes through`);
  assert.equal((await screenAsk("Who are the key people, and would they stay on after a sale?", deal)).ok, true, "a retention question without a private matter is fine");
  assert.equal((await screenAsk("How much is Dave paid?", deal)).ok, false, "one employee's pay");
  assert.equal((await screenAsk("Is your service manager thinking of leaving?", deal)).ok, false);
  assert.equal((await screenAsk("   ", deal)).ok, false);
  assert.equal((await screenAsk("x".repeat(301), deal)).ok, false);
  ok("asks are screened: broker work and material, keep-out details, staff-private matters, empty or too long");

  // ── Follow-ups on the outline ──
  const base = getInterviewOutline({ interviewOutline: null } as any);
  const o1 = outlineWithFollowUps(base, [
    { itemId: "seasonality:seasonality", key: "seasonality", sectionKey: "seasonality", label: "Busy and slow months", ask: "Which months are busiest?", sittingId: "S1" },
    { itemId: "operations:suppliers", key: "suppliers", sectionKey: "operations", label: "Suppliers", ask: "Who are your main suppliers?" },
  ]);
  const o2 = outlineWithFollowUps(o1, [{ itemId: "seasonality:seasonality", key: "seasonality", sectionKey: "seasonality", label: "Busy and slow months", ask: "Which months are quietest?" }]);
  assert.equal(o2.followUpItems?.length, 2, "one per item");
  assert.equal(o2.followUpItems?.find((f) => f.itemId === "seasonality:seasonality")?.ask, "Which months are quietest?", "a newer ask replaces the older");
  for (const f of o2.followUpItems ?? []) assert.ok(!("note" in f), "never a note");
  assert.equal(openFollowUpItems(o2, (k) => k === "seasonality").length, 1, "an answered follow-up drops out");
  const prompt = renderOutlineForPrompt(o2, (k) => k === "seasonality");
  assert.match(prompt, /Suppliers — Who are your main suppliers\?/);
  assert.doesNotMatch(prompt, /quietest/, "the answered one isn't raised again");
  const raised = followUpItemsRaised(o2.followUpItems!, [
    { role: "ai", content: "Who supplies your equipment — and could you switch suppliers if you had to?" },
    { role: "user", content: "Mostly Carrier." },
  ]);
  assert.deepEqual(raised.map((r) => r.discussed), [false, true]);
  ok("follow-ups: one per item, label + ask only, answered ones drop out, the wrap-up check sees which were raised");

  // ── The summary ──
  const item = (over: Partial<CoverageItem>): CoverageItem => ({
    id: "x:y", sectionKey: "x", label: "Label", members: [{ key: "y", label: "y", writable: true }], readKeys: ["y"], valueKey: null,
    critical: false, origin: "generic", status: "missing", reason: null, value: null, source: null, ask: "Ask?", why: "", marks: [], ...over,
  });
  const board: CoverageBoard = {
    dealId: "D", audience: "broker", generatedAt: new Date().toISOString(), version: "v",
    sections: [
      {
        key: "seasonality", title: "Seasonality", order: 1, importance: "important", importanceReason: "", references: [], figureQuestions: 0,
        counts: { on_file: 1, partial: 1, verify: 0, missing: 2 },
        items: [
          item({ id: "seasonality:seasonality", sectionKey: "seasonality", label: "Busy and slow months", status: "on_file", value: "Summer", yourNote: true, filedInSittingId: "S1", filedAt: new Date().toISOString() }),
          item({ id: "seasonality:a", sectionKey: "seasonality", label: "Critical one", critical: true }),
          item({ id: "seasonality:b", sectionKey: "seasonality", label: "Later one", marks: [{ kind: "verify_later", at: new Date().toISOString() }] }),
          item({ id: "seasonality:c", sectionKey: "seasonality", label: "Plain one" }),
          item({ id: "seasonality:d", sectionKey: "seasonality", label: "Denise has it", status: "partial", reason: { code: "not_known", whoHasIt: "Denise" } }),
        ],
      },
    ],
    totals: { items: 5, on_file: 1, partial: 1, verify: 0, missing: 3, criticalItems: 1, criticalOpen: 1 },
    percentCollected: 20,
    quality: { label: "Developing" },
    routed: [],
    documents: [
      { requirementId: "R1", name: "General ledger", required: true, sellerSaysNoCopy: false, promised: false },
      { requirementId: "R2", name: "Lease", required: false, sellerSaysNoCopy: false, promised: true },
      { requirementId: "R3", name: "Org chart", required: false, sellerSaysNoCopy: false, promised: false },
    ],
    plan: { status: "no_industry", industry: null },
  } as CoverageBoard;
  const started = new Date(Date.now() - 24 * 60_000);
  const s = buildSittingSummary({
    sitting: { id: "S1", via: "person", startedAt: started, endedAt: new Date(), lastLineAt: null, pausedAt: null, transcriptDocumentId: "DOC9", captureState: { chunksWaiting: 2 } } as any,
    board,
    facts: { _brokerPrivateNotes: [{ note: "a", documentId: "DOC9" }, { note: "b", documentId: "OTHER", alsoFrom: [{ documentId: "DOC9" }] }, { note: "c", documentId: "OTHER" }] },
  });
  assert.equal(s.durationMin, 24);
  assert.equal(s.filed.length, 1);
  assert.equal(s.filed[0].yourNote, true);
  assert.equal(s.filed[0].quote, null, "your note has no seller quote");
  const ticked = Object.fromEntries(s.stillToGet.map((r) => [r.label, r.ticked]));
  assert.deepEqual(ticked, { "Critical one": true, "Later one": true, "Plain one": false, "Denise has it": true });
  assert.deepEqual(s.documents.map((d) => d.ticked), [true, true, false], "required or promised documents start ticked");
  assert.equal(s.privateNotes, 2);
  assert.equal(s.waiting, 2);
  assert.equal(s.criticalOpen, 1);
  assert.equal(s.screen, false);
  const screenS = buildSittingSummary({ sitting: { id: "S1", via: "person", startedAt: started, endedAt: null, lastLineAt: null, pausedAt: null, transcriptDocumentId: null, captureState: {} } as any, board: { ...board, audience: "screen" }, facts: {} });
  assert.equal(screenS.screen, true);
  ok("summary: defaults ticked (critical, come back later, someone else has it; required/promised documents), filed rows, notes count");

  // ── The email body ──
  const e = followUpEmail({ businessName: "A & B <Ltd>", sellerName: "Tony", brokerName: "Morgan", asks: ["What about <script>?"], documents: ["Lease & renewals"], interviewLink: "https://app.cimple.ca/seller/t/interview", documentsLink: "https://app.cimple.ca/seller/t/documents" });
  assert.equal(e.subject, "A & B <Ltd>: a few things to finish your business overview");
  assert.doesNotMatch(e.html, /<script>/, "escaped");
  assert.match(e.html, /What about &lt;script&gt;\?/);
  assert.match(e.html, /Lease &amp; renewals/);
  assert.match(e.html, /Answer them in your interview/);
  assert.match(e.html, /Upload your documents/);
  assert.match(e.text, /Upload your documents: https:\/\/app\.cimple\.ca\/seller\/t\/documents/);
  ok("the email: escaped, with a button to the interview and to the documents");

  console.log(`\n${n} checks passed`);
}

main().catch((err) => { console.error(err); process.exit(1); });
