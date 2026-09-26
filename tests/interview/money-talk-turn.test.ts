// Whole turns (mocked model — tests/interview/turn-harness.ts) replaying the
// round-A Lakeshore acceptance run (SCR/harvest/acc-int/a2.json): the seller
// lists their add-backs and asks what SDE goes in the book. What the seller
// reads, what the turn records, and what the model was told.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/interview/money-talk-turn.test.ts
import assert from "node:assert/strict";
import { installHarness, baseDeal, ai, seller, type Harness } from "./turn-harness";
import { processTurn } from "../../server/interview/session-manager";

let n = 0;
const ok = (name: string) => { n++; process.stdout.write(`✓ ${name}\n`); };
const has = (h: Harness, re: RegExp) => h.logs.some((l) => re.test(l));

const T1 =
  "The SDE calculation is something Morgan finalizes directly with the financials — I don't have her working number to share. Are there any expenses in 2024 that were one-time or discretionary — things that wouldn't recur for a new owner?";
const S2 =
  "Okay, fair enough — yeah, I'll nail that down with Morgan. But listen, you're missing stuff. The twenty-eight thousand in owner vehicles — my RAM and Maria's Lexus lease, that's personal, that comes out. And here's a big one you didn't mention — we had a former employee, wrongful dismissal thing, settled it in July, cost us twenty-two thousand in legal fees that's buried in professional fees. That's one-time, that's gone, that should absolutely be an add-back. Denise has all this broken out, she gave it to Morgan. Are you guys not working off the same sheet here?";
const T2_DRAFT =
  "You're right — those items are in the documents Denise sent, I should have had them in front of me. I'll make sure the owner vehicles ($28K) and the $22K legal settlement are all flagged for Morgan's add-back review.\n\nOne quick item while we're on housekeeping: the financials show a $60,000 due to shareholder that's been sitting there with no fixed repayment terms. Is that something you'd expect to settle at closing, or would it stay on the books for the buyer to assume?";
const S6 = "Sal's been with me sixteen years, he's not going anywhere. But listen, at the end of the day this business clears about a million and a half a year, you know what I mean? Is that the number going in the book?";
const T6 = "Quick clarification: the staff roster shows Sal starting in 2009, which would be about sixteen years — so that tracks. On the retention question for the other licensed techs beyond Dave and Sal: is there anything you'd put in place to keep them through a transition?";

const statementsDoc = { id: "doc-fs", dealId: "deal-1", name: "Lakeshore FY2024 Financial Statements.pdf", category: "financial", status: "extracted", isProcessed: true, visibility: "seller_visible", sourceKind: "document", extractedData: { summary: "FY2024 statements" }, createdAt: new Date() };
const lakeshore = () =>
  baseDeal({
    businessName: "Lakeshore Home Comfort",
    location: "Hamilton, ON",
    extractedInfo: {
      netIncome: "$563,190 after tax (FY2024); FY2023 $482,930",
      risk: "one settled employment claim costing $22K all-in (wrongful dismissal, settled July 2024)",
      _fieldSources: {
        netIncome: { source: "document", documentId: "doc-fs" },
        risk: { source: "document", documentId: "doc-fs" },
      },
    },
  });

(async () => {
  // ── 1. The seller lists add-backs: nothing is agreed to, nothing reads broken, the items are kept as facts ──
  {
    const h = installHarness(lakeshore(), { messages: [ai(T1)], documents: [statementsDoc] });
    h.script.push({
      message: T2_DRAFT,
      extractedFields: {
        ownerVehicleAddback: { value: "$28,000 — owner's RAM and Maria's Lexus lease, personal use (add-back candidate)", confidence: "confirmed" },
        legalSettlementAddback: { value: "$22,000 one-time legal fees for wrongful dismissal settlement (July 2024)", confidence: "confirmed" },
      },
      whyItMatters: "Buyers and their lenders treat an open shareholder loan as a liability they may inherit.",
      targetSection: "financials",
    });
    // The corrective rewrite still agrees to the list — the polish pass has to finish the job cleanly.
    h.script.push({
      message: "You're right — I'll make sure the vehicles ($28K) and the settlement ($22K) are on the list. Is that $60,000 something you'd expect to settle at closing, or would it stay on the books for the buyer to assume?",
    });
    const t = await processTurn("deal-1", "sess-1", S2);
    assert.match(h.systems[0], /# THE SELLER RAISED EARNINGS \/ SDE \/ ADD-BACKS/, "the model is told how to answer before it drafts");
    assert.match(h.calls[1], /no list of items that are or might be added back/, "the corrective rewrite names the rule");
    assert.equal(
      t.message,
      "Your broker will confirm what gets added back when they normalize the numbers against your statements.\n\nOne quick item while we're on housekeeping: the financials show a $60,000 due to shareholder that's been sitting there with no fixed repayment terms. Is that something you'd expect to settle at closing, or would it stay on the books for the buyer to assume?",
    );
    const stored = h.sessions[0].messages[h.sessions[0].messages.length - 1];
    assert.equal(stored.content, t.message, "what is saved is what is shown");
    const info = h.deal.extractedInfo as Record<string, any>;
    assert.equal(info.ownerVehicle, "$28,000 — owner's RAM and Maria's Lexus lease, personal use");
    assert.match(info.legalSettlement, /July 2024/, "the question asked about 2024 — the settlement stays in July 2024 (it became July 2026 live)");
    assert.equal(info.ownerVehicleAddback, undefined);
    assert.equal(info.legalSettlementAddback, undefined);
    const notes = (info._brokerPrivateNotes ?? []) as Array<{ note: string }>;
    assert.ok(notes.filter((x) => /counts this as an add-back/.test(x.note)).length === 2, JSON.stringify(notes));
    assert.ok(!has(h, /Date-fidelity guard: legalSettlement[^\n]*resolved to 2026/));
    ok("Lakeshore T2 replay: the add-back list is neither agreed to nor shown broken; the items are facts, the treatment is the broker's");
  }

  // ── 2. "Is that the number going in the book?" — answered, not dodged ──
  {
    const h = installHarness(lakeshore(), { messages: [ai(T1), seller("Twenty-four vans."), ai("How many of your techs hold the 313A?")], documents: [statementsDoc] });
    h.script.push({ message: T6, whyItMatters: "Buyers want to know whether key licensed technicians will stay.", targetSection: "employees" });
    const t = await processTurn("deal-1", "sess-1", S6);
    assert.match(h.systems[0], /They stated \$1\.5M\. The statements on file \(seller-visible\) report net income of \$563,190 for FY2024 \(after tax\) — a different measure from theirs/);
    assert.equal(
      t.message,
      "On the $1.5M: the earnings figure that goes in the book is your broker's to walk you through, against your statements. For reference, the FY2024 statements on file report net income of $563,190 after tax, before any adjustments.\n\nOn the retention question for the other licensed techs beyond Dave and Sal: is there anything you'd put in place to keep them through a transition?",
    );
    assert.doesNotMatch(t.message, /so that tracks|add|SDE of|\$1,312,000/);
    const stored = h.sessions[0].messages[h.sessions[0].messages.length - 1];
    assert.equal(stored.content, t.message);
    assert.ok(t.suggestedAnswers.length > 0);
    ok("Lakeshore T6 replay: the earnings question gets the hand-off and the statements' own figure; the confirmation filler goes");
  }

  // ── 3. Broker-led ("together"): the broker's own words raise nothing; the seller's question is the broker's to answer ──
  {
    // The broker says the SDE out loud; the seller only talks about leases.
    const h = installHarness(lakeshore(), { messages: [ai("How are the service vans financed?")], documents: [statementsDoc], sessionMeta: { _conductedBy: "broker_with_seller" } });
    h.script.push({ message: "When do the Ford Credit leases end?", whyItMatters: "Buyers need to know the fleet commitments they take on.", targetSection: "operations" });
    const exchange = "Broker: And just so you know, your SDE is about $1.2M after the add-backs.\nSeller: Yeah, sounds right. The vans are all leased through Ford Credit.";
    const t = await processTurn("deal-1", "sess-1", exchange, undefined, { conductedBy: "broker_with_seller" });
    assert.doesNotMatch(h.systems[0], /# THE SELLER RAISED EARNINGS/, "the broker's line is not the seller raising it");
    assert.equal(t.message, "When do the Ford Credit leases end?", "no hand-off on the broker's question card");
    ok("together replay: the broker saying 'your SDE is about $1.2M' puts no earnings hand-off on the broker's card");
  }
  {
    // The seller asks; the broker is in the room — the card carries only the next question.
    const h = installHarness(lakeshore(), { messages: [ai("How are the service vans financed?")], documents: [statementsDoc], sessionMeta: { _conductedBy: "broker_with_seller" } });
    h.script.push({ message: "When do the Ford Credit leases end?", whyItMatters: "Buyers need to know the fleet commitments they take on.", targetSection: "operations" });
    const exchange = "Broker: How are the vans financed?\nSeller: Ford Credit leases, all of them. Hey — what's the SDE going in the book?";
    const t = await processTurn("deal-1", "sess-1", exchange, undefined, { conductedBy: "broker_with_seller" });
    assert.match(h.systems[0], /The broker is in the room and will answer this themselves/);
    assert.doesNotMatch(h.systems[0], /say plainly that the earnings figure/);
    assert.equal(t.message, "When do the Ford Credit leases end?");
    ok("together replay: the seller's SDE question is left to the broker in the room — no hand-off line read aloud");
  }

  process.stdout.write(`\n${n} groups passed\n`);
  process.exit(0);
})().catch((err) => {
  // (The harness routes console.* into its log; the failure goes to stderr directly.)
  process.stderr.write(`${err?.stack ?? err}\n${err?.actual !== undefined ? `actual: ${JSON.stringify(err.actual)}\n` : ""}`);
  process.exit(1);
});
