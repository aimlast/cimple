// Whole turns (mocked model — tests/interview/turn-harness.ts): what the
// seller reads after the round-V pass (reply-polish.ts), what the turn
// records, and a stored question re-polished on resume.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/interview/reply-polish-turn.test.ts
import assert from "node:assert/strict";
import { installHarness, baseDeal, ai, seller, type Harness } from "./turn-harness";
import { processTurn, startOrResumeSession } from "../../server/interview/session-manager";

let n = 0;
const ok = (name: string) => { n++; process.stdout.write(`✓ ${name}\n`); };
const has = (h: Harness, re: RegExp) => h.logs.some((l) => re.test(l));

(async () => {
  // ── 1. A Calgary turn with filler, two questions, US terms, no rationale and a wrong section ──
  {
    const h = installHarness(baseDeal(), { messages: [ai("How is the clinical team set up today?"), seller("Some of the physios are employees and some are contractors.")] });
    h.script.push({
      message: "That's helpful — so the team is a mix. How many are W-2 employees versus 1099 contractors? And do any of them have a 401(k) through the clinic?",
      suggestedAnswers: ["Mostly W-2", "Mostly 1099", "About half and half"],
      targetSection: "asking_price",
    });
    const t = await processTurn("deal-1", "sess-1", "Some are employees and some are contractors, it varies.");
    assert.equal(t.message, "How many are T4 employees versus independent contractors?");
    assert.deepEqual(t.suggestedAnswers, ["Mostly T4", "Mostly T4A", "About half and half"]);
    assert.ok(t.whyItMatters && t.whyItMatters.length > 20, "a question never ships without 'Why we ask this'");
    assert.equal(t.targetSection, "employees", "the section follows the question's words when the label call can't run");
    const stored = h.sessions[0].messages[h.sessions[0].messages.length - 1];
    assert.equal(stored.content, t.message, "what is saved is what is shown");
    assert.ok(has(h, /Reply polish \(filler, extra question dropped/));
    ok("a Calgary turn: filler cut, one question, Canadian terms in the message and chips, a rationale and the right section");
  }

  // ── 2. An add-back call is neither said nor recorded ──
  {
    const h = installHarness(baseDeal({ location: "Nisku, AB", businessName: "Ridgeline Metal Fabricators" }), { messages: [ai("What do you take out of the business each year?")] });
    const said = "Honestly, the two-sixty is what I take out, and all of it comes back. I pull one-eighty salary and about sixty in dividends — maybe another twenty in expenses. That's the add-back.";
    h.script.push({
      message: "That helps — so the $260K is your total compensation including the personal expenses, and all of it would be an add-back for a new owner. On the legal side: are there any pending lawsuits?",
      extractedFields: {
        ownerCompensationReconciled: { value: "Total owner compensation $260K: $180K salary + ~$60K dividends + ~$20K personal expenses. All $260K is add-back for new owner.", confidence: "confirmed" },
      },
      whyItMatters: "Pending litigation surfaces in diligence and shapes the reps and warranties a buyer asks for.",
      targetSection: "overview",
    });
    const t = await processTurn("deal-1", "sess-1", said);
    assert.doesNotMatch(t.message, /add-back for a new owner|all of it would be/);
    assert.match(t.message, /Your broker will confirm what gets added back/, "the seller raised it: the hand-off");
    assert.match(t.message, /are there any pending lawsuits\?$/);
    const info = h.deal.extractedInfo as Record<string, any>;
    assert.equal(info.ownerCompensationReconciled, "Total owner compensation $260K: $180K salary + ~$60K dividends + ~$20K personal expenses.");
    const notes = (info._brokerPrivateNotes ?? []) as Array<{ note: string }>;
    assert.ok(notes.some((x) => /All \$260K is add-back/.test(x.note) && /distributions/.test(x.note)), "the seller's view is on the broker's private notes");
    ok("Ridgeline: the add-back call is removed from the reply and the fact; the broker gets the seller's view");
  }

  // ── 2b. The seller asks "my dividends get added back too, right?" (live, round V) ──
  {
    const h = installHarness(baseDeal({ location: "Nisku, AB" }), { messages: [ai("Those two journeymen retiring — that's Walt and Henry, right?")] });
    h.script.push({
      message:
        "Dividends work differently — they're distributions from retained earnings, not an expense on the income statement, so there's nothing to \"add back\" for those.\n\nYour broker will confirm the full normalization against your actual statements, but the short answer is the $180K salary and the personal expenses flow through; the dividends don't need to because they're not hitting the P&L as a cost. Does that track with what Heather's told you?",
    });
    h.script.push({ message: "Your broker will confirm what gets added back when they normalize the numbers against your statements. Beyond Walt and Henry, is anyone else on the shop floor likely to retire in the next two years?" });
    const t = await processTurn("deal-1", "sess-1", "Quick one bud — my dividends get added back too, right? Same as the salary?");
    assert.match(h.calls[h.calls.length - 1], /never yours to state or explain/, "the corrective rewrite names the rule");
    assert.equal(t.message, "Your broker will confirm what gets added back when they normalize the numbers against your statements. Beyond Walt and Henry, is anyone else on the shop floor likely to retire in the next two years?");
    // A rewrite that still makes the call: the polish removes it, the hand-off stays.
    const h2 = installHarness(baseDeal({ location: "Nisku, AB" }), { messages: [ai("What do you take out each year?")] });
    h2.script.push({ message: "Your salary gets added back, and your dividends too. Who does the books?" });
    h2.script.push({ message: "Your salary gets added back in full. Who does the books?" });
    const t2 = await processTurn("deal-1", "sess-1", "Salary and dividends — those all get added back, right?");
    assert.doesNotMatch(t2.message, /gets added back in full|dividends too/);
    assert.match(t2.message, /Your broker will confirm what gets added back/);
    assert.match(t2.message, /Who does the books\?$/);
    ok("a seller's add-back question gets the hand-off, via one rewrite — never an explanation of what is or isn't added back");
  }

  // ── 3. Resume re-polishes a question stored by an earlier build ──
  {
    const stale = "That's helpful — having Dana confirm the ClinicNest ownership-transfer process before marketing would give buyers confidence there's no gap in booking or billing.\n\nOne more on this front: who actually owns the patient records — the clinic corporation, or the practitioners?";
    const h = installHarness(baseDeal(), {
      messages: [ai("Does ClinicNest transfer with the business?"), seller("Dana would know, she handles ClinicNest."), ai(stale, { whyItMatters: "Buyers need the patient records to stay with the clinic.", suggestedAnswers: ["The clinic owns them", "Not sure"] } as any)],
    });
    const r = await startOrResumeSession("deal-1", { resume: true } as any);
    assert.equal(r.message, "One more on this front: who actually owns the patient records — the clinic corporation, or the practitioners?");
    const stored = h.sessions[0].messages[h.sessions[0].messages.length - 1];
    assert.equal(stored.content, r.message, "the cleaned question replaces the stored one");
    assert.equal(stored.whyItMatters, "Buyers need the patient records to stay with the clinic.");
    assert.ok(has(h, /Resume: the stored question .* was re-polished \(filler\)/));
    ok("resume: a pre-fix stored question is shown (and saved) without its filler");
  }

  process.stdout.write(`\n${n} groups passed\n`);
  process.exit(0);
})().catch((err) => {
  process.stderr.write(`${err?.stack ?? err}\n`);
  process.exit(1);
});
