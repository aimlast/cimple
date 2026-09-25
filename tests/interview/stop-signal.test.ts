// Stop-signal detection and completion governance — offline (QA harvest,
// Clearwater: "a lot of them come back later or refer someone" was read as a
// request to stop, and the interview ended at 6 of the 10-turn minimum).
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/interview/stop-signal.test.ts
import assert from "node:assert/strict";
import { detectStopSignal, governCompletion, sellerDeclinedWrapUp } from "../../server/interview/turn-guard";

let n = 0;
const ok = (name: string) => { n++; console.log("✓", name); };

// A 60+ word ordinary answer that carries the sentence somewhere inside it.
const inAnswer = (sentence: string, where: "middle" | "end" = "middle") => {
  const before =
    "Honestly, the clinic has been steady for years. We see a lot of the same families, our team is stable, and the physicians nearby keep sending people our way. Marketing is mostly Google and word of mouth, and Dana handles the reports every quarter.";
  const after = "That's just how the business runs day to day, and it has worked for us for a long time now.";
  return where === "middle" ? `${before} ${sentence} ${after}` : `${before} ${after} ${sentence}`;
};

// ── 1. Ordinary sentences are not stops (the harvest's exact phrases) ──
{
  const ordinary = [
    "What I do know is that the lifetime value is strong, and a lot of them come back later or refer someone.",
    "I'm leaving the business once the transition is done, but I'll stay on clinically.",
    "The HVAC rebate alone is almost enough — that's enough to cover payroll for two months.",
    "In the summer we're done installing by 3pm most days.",
    "The landlord said they have to get back to us on the renewal terms.",
    "We keep a hard stop on credit at 60 days for every commercial account.",
    "Customers talk later about it on Google, which is where most reviews come from.",
    "Patients often continue later with maintenance visits once the acute phase is over.",
  ];
  for (const s of ordinary) {
    const msg = inAnswer(s);
    assert.ok(msg.split(/\s+/).length >= 60, "answer is 60+ words");
    assert.equal(detectStopSignal(msg), false, `not a stop (middle): ${s}`);
    assert.equal(detectStopSignal(inAnswer(s, "end")), false, `not a stop (end): ${s}`);
  }
  // The exact Clearwater seller turn 5.
  const clearwaterTurn5 =
    "Honestly, I don't track it as closely as I probably should. Dana pulls some reports from Google Ads every quarter, but we've never really nailed down a true cost-per-acquisition number. It's one of those things where I know we spend about $4,000 a month on marketing — call it $50k a year — and we brought in roughly 2,150 new patients in FY2024, so back-of-the-envelope that's maybe $23 per new patient across all channels.\n\nWhat I *do* know is that the lifetime value is strong. A new patient who comes in for physio usually stays for 6-8 visits on average, sometimes way more if it's a chronic issue, and a lot of them come back later or refer someone. So even at $75 to acquire them, it pencils out pretty well.";
  assert.equal(detectStopSignal(clearwaterTurn5), false, "Clearwater turn 5 is an answer");
  // Short answers that merely contain the words.
  assert.equal(detectStopSignal("We're done installing by 3pm."), false);
  assert.equal(detectStopSignal("Hard stop on credit at 60 days."), false);
  assert.equal(detectStopSignal("I have to run the numbers with Tom first."), false);
  assert.equal(detectStopSignal("I have to go through the files to check."), false);
  ok("ordinary answers containing 'come back later', 'that's enough', 'hard stop', 'we're done'… are not stops");
}

// ── 2. Real stops still win ──
{
  const stops = [
    "Can we pick this up tomorrow?",
    "I have to run, let's continue later",
    "That's all for today",
    "Let's stop here for now.",
    "I really have to go.",
    "That's everything from me.",
    "Sorry — gotta run.",
    "I'm out of time.",
    "Can we wrap up?",
    "I need to head out, sorry.",
    "Let's call it a day.",
    "No more questions for today please.",
    "I'd like to end the interview now.",
  ];
  for (const s of stops) assert.equal(detectStopSignal(s), true, `stop: ${s}`);
  // …also at the end of a long answer.
  assert.equal(detectStopSignal(inAnswer("Anyway, I'm out of time.", "end")), true);
  assert.equal(detectStopSignal(inAnswer("I have to run — let's continue later.", "end")), true);
  assert.equal(detectStopSignal(inAnswer("Can we pick this up tomorrow?", "middle")), true);
  // Completion acceptance after an interview-scoped wrap offer still counts.
  assert.equal(detectStopSignal("That covers it.", "Before we wrap up, is there anything else you'd like to add?"), true);
  assert.equal(detectStopSignal("Nothing else on the lease, the landlord handles maintenance.", "Anything else about the lease?"), false);
  ok("real stops ('Can we pick this up tomorrow?', 'I have to run, let's continue later', 'That's all for today') are detected");
}

// ── 3. A declined wrap-up offer doesn't carry an earlier stop forward ──
{
  const offer =
    "Amrit, we've covered a lot of ground — your market position, referral channels, team stability, and customer acquisition. Is there anything you feel buyers should know that we haven't touched on, or shall we wrap up for today?";
  const kept =
    "You know, I think we've covered the mechanics pretty well. If I had to add one thing buyers should understand... it's that this business runs on trust and continuity, not flash. We're not the biggest, we're not the cheapest, we don't have the fanciest equipment. What we have is a team that shows up, patients who feel cared for, and a reputation we've earned one appointment at a time over 16 years.";
  assert.equal(sellerDeclinedWrapUp(offer, kept), true, "kept talking about the business = declined");
  assert.equal(sellerDeclinedWrapUp(offer, "No, let's wrap up."), false);
  assert.equal(sellerDeclinedWrapUp(offer, "That covers it, thanks."), false);
  assert.equal(sellerDeclinedWrapUp("Who holds the lease — you or the company?", kept), false, "a content closing question answered = the stop stands");
  ok("a seller who keeps talking after '…or shall we wrap up?' has declined the wrap-up");
}

// ── 4. Governance: the model's endReason is never a bypass ──
{
  const coverage = [{ key: "overview", status: "partial" as const }];
  const blocked = governCompletion({
    shouldEnd: true,
    endReason: "Seller wants to stop — seller requested to end",
    sellerMessage: "We have a hard stop on credit at 60 days for every commercial account, and it's worked well.",
    userTurnCount: 6,
    sectionCoverage: coverage,
    deferredTopics: [],
    minTurnsBeforeEnd: 10,
    sellerStopDetected: false,
  });
  assert.equal(blocked.allowEnd, false);
  assert.match(blocked.blockReason!, /only 6 of a minimum 10 turns/);
  assert.match(blocked.continuationInstruction!, /no acknowledgement, no recap/);
  assert.doesNotMatch(blocked.continuationInstruction!, /briefly acknowledge/);
  const allowed = governCompletion({
    shouldEnd: true,
    sellerMessage: "I have to run, let's continue later",
    userTurnCount: 3,
    sectionCoverage: [{ key: "overview", status: "missing" }],
    deferredTopics: [],
    minTurnsBeforeEnd: 10,
  });
  assert.equal(allowed.allowEnd, true, "a real stop always wins");
  ok("governance: endReason can't skip the floor; a real stop still ends; continuation asks for no recap");
}

console.log(`\n${n} groups passed`);
