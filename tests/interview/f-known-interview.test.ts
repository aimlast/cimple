// FREE round, stream "interview": the round A re-check's open interview
// items, replayed offline from the recorded turns (SCR/harvest/acc-a/r1.json,
// r2.json) through the real pure functions, with a stubbed model client for
// the retry — no model calls.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/interview/f-known-interview.test.ts
import assert from "node:assert/strict";
import { findReasks, reaskCorrection, withTermAliases, yearsWithFigures } from "../../server/interview/reask-guard";
import { checkLiveClaims } from "../../server/interview/live-claims";
import { detectAlternateConflicts, spokenFigureConflicts } from "../../server/interview/source-context";
import { documentTermNotDealTerm, isDealTermKey } from "../../server/interview/deal-terms";
import { callInterviewWithRecovery, TRANSIENT_RETRY, isTransientModelError, stripFillerPreamble } from "../../server/interview/turn-guard";
import { candidateListStatements } from "../../server/interview/money-talk";
import { polishMessage, type PolishContext } from "../../server/interview/reply-polish";
import { toolInput } from "./turn-harness";

let n = 0;
const ok = (name: string) => { n++; process.stdout.write(`✓ ${name}\n`); };

(async () => {
  // ── known-1: capex asked for three years with two on file (R1 T2) ──
  {
    const draft = "Shifting to the financials: what did your capital expenditure look like over the past three years — 2022, 2023, and 2024?";
    const info = {
      capexRequirements: "$2,960,000 in 2024; $3,420,000 in 2023",
      _fieldSources: { capexRequirements: { source: "document", documentId: "fs" } },
    };
    const documents = [{ id: "fs", name: "Reviewed financial statements FY2022-2024", visibility: "shared" }] as any;
    const ctx = { sellerMessage: "It was wage compression — we fixed it right after the vote.", info, documents, priorQA: [] } as any;
    const found = findReasks(draft, ctx);
    const partial = found.find((f) => f.kind === "fact" && /capexRequirements/.test(f.detail));
    assert.ok(partial, "the capex on file is found (it shares no word with 'capital expenditure')");
    assert.equal(partial!.verify, undefined, "sure — not left to the answer check that let it through");
    assert.match(partial!.detail, /on file for 2023 and 2024; ask ONLY for 2022/);
    // The rewrite that cites the two years and asks for 2022 is left alone.
    const rewrite = "I have 2024 at $2.96 million and 2023 at $3.42 million from Tom's package — what did capex come to in 2022?";
    assert.equal(findReasks(rewrite, ctx).some((f) => /ask ONLY for 2022/.test(f.detail)), false);
    // A question about one year that is on file is the ordinary rule's (not this one).
    assert.equal(findReasks("What was capex in 2024 and 2023?", ctx).some((f) => /ask ONLY/.test(f.detail)), false, "both years on file: not a partial");
    assert.deepEqual(Array.from(yearsWithFigures("$2,960,000 in 2024; $3,420,000 in 2023")).sort(), [2023, 2024]);
    assert.deepEqual(Array.from(yearsWithFigures({ 2022: "$1.1M", 2023: "", 2024: "$1.3M" })).sort(), [2022, 2024]);
    assert.equal(yearsWithFigures("Founded in 2009 by the Kline family").size, 0, "a year with no figure is not a figure for it");
    // The lien question now reaches the debt note (Note 5: "secured by equipment").
    assert.match(withTermAliases("What's the lien status on your equipment — is it a blanket security interest?"), /secured/);
    ok("known-1: a multi-year question with some years on file asks only for the missing ones (sure finding); capex ↔ capital expenditure; lien ↔ secured");
  }

  // ── known-2: a rewrite never drops the seller's own question (R2 T1, R1 T8) ──
  {
    const licences = "Yeah, Denise already sent you the fleet list — we've got 24 service vans plus my truck and Maria's Lexus. We replace three, four vans a year, you know what I mean?\n\nListen, who on my team holds which licences — do you have that, or do I need to get Denise to send you something?";
    const findings = [{ kind: "source_text" as const, detail: "Staff roster with technician licences already says (a quoted passage…): «Sal Moretti — 313A, G1; Dave …»", quote: "Sal Moretti — 313A, G1", verify: true }];
    const c = reaskCorrection(findings, { sellerMessage: licences });
    assert.match(c, /THE SELLER ASKED YOU: "[^"]*who on my team holds which licences/);
    assert.match(c, /must still answer it, first/);
    assert.match(c, /Never drop it to change the topic/);
    const guarantees = "I'd sign whatever is standard — I'd expect about five years, and injection molding in the region is fine with me.\n\nWhat happens to those at closing — does the buyer just pay off the debt and I'm done, or is there some release I need to get before we close?";
    assert.match(reaskCorrection([{ kind: "conflict", detail: "x" }], { sellerMessage: guarantees }), /THE SELLER ASKED YOU: "What happens to those at closing/);
    // No question from the seller: the correction is as before.
    assert.doesNotMatch(reaskCorrection(findings, { sellerMessage: "We lease it." }), /THE SELLER ASKED/);
    assert.match(reaskCorrection(findings), /^\[SYSTEM CORRECTION:\nA source on file already answers it/);
    ok("known-2: every re-ask/conflict rewrite carries the seller's own question and must answer it first");
  }

  // ── known-3 / known-8: a shareholders' agreement covenant is not the sale's non-compete (R1 T8) ──
  {
    const T8 = "I'd sign whatever is standard — I'd expect about five years, and injection molding in the region is fine with me. I'm not looking to work in plastics again.\n\nWhat I'm tired of is signing personal guarantees at the bank. We've had them on everything with First Maumee since day one. What happens to those at closing — does the buyer just pay off the debt and I'm done, or is there some release I need to get before we close?";
    const sha = { id: "sha", name: "Operating agreement summary", visibility: "shared", sourceKind: "document", extractedText: "Non-compete: 2 years for Diane Kline-Morrow and Robert Kline following the end of employment." };
    const info = { nonCompetePeriod: "2 years for Diane Kline-Morrow and Robert Kline", _fieldSources: { nonCompetePeriod: { source: "document", documentId: "sha" } } };
    // The recorded conflict the model raised, replayed against the material the check builds.
    const recorded = (material: any[]) => {
      const m = material.find((x) => /nonCompetePeriod/.test(x.label)) ?? material[0];
      return [{ said: "about five years", onFile: m.text, materialId: m.id, topic: "non-compete period", key: "nonCompetePeriod" }];
    };
    const run = (docs: any[], inf: any) =>
      checkLiveClaims(
        { sellerMessage: T8, lastQuestion: "What terms would you expect on a post-sale non-compete?", info: inf, documents: docs },
        { model: async (_m, _q, material) => recorded(material) },
      );
    assert.deepEqual(await run([sha], info), [], "the SHA covenant vs the sale non-compete is not a conflict");
    // …but a letter of intent's term IS the deal's: a conflict there stands.
    const loi = { ...sha, id: "loi", name: "Letter of intent - Great Lakes Plastics" };
    const loiInfo = { nonCompetePeriod: "2 years", _fieldSources: { nonCompetePeriod: { source: "document", documentId: "loi" } } };
    assert.equal((await run([loi], loiInfo)).length, 1, "an LOI's non-compete vs what the seller now says is a conflict");
    // …and the seller's own earlier words about the sale can conflict with what they say now.
    const said = { nonCompetePeriod: "3 years", _fieldSources: { nonCompetePeriod: { source: "interview" } } };
    assert.equal((await run([], said)).length, 1);

    // The pre-turn alternates check: seller's five years won over the SHA's two.
    const alt = {
      nonCompetePeriod: "about 5 years, injection molding in the region",
      _fieldSources: { nonCompetePeriod: { source: "interview", sessionId: "s", turn: 8 } },
      _fieldAlternates: { nonCompetePeriod: [{ value: "2 years for Diane Kline-Morrow and Robert Kline", source: "document", documentId: "sha" }] },
    };
    assert.equal(detectAlternateConflicts(alt, [sha] as any).length, 0);
    const altLoi = { ...alt, _fieldAlternates: { nonCompetePeriod: [{ value: "2 years", source: "document", documentId: "loi" }] } };
    assert.equal(detectAlternateConflicts(altLoi, [loi] as any).length, 1, "an LOI's term still conflicts");
    // A non-deal fact keeps conflicting as before (a lease term vs what the seller said).
    const lease = { id: "ls", name: "Lease - 2240 7A Street", visibility: "shared", sourceKind: "document" };
    const leaseInfo = {
      leaseExpiry: "2031",
      _fieldSources: { leaseExpiry: { source: "interview" } },
      _fieldAlternates: { leaseExpiry: [{ value: "2027", source: "document", documentId: "ls" }] },
    };
    assert.equal(detectAlternateConflicts(leaseInfo, [lease] as any).length, 1);
    // The mechanical spoken-figure check doesn't compare the sale's terms with the SHA either.
    const shaDoc = { ...sha, extractedText: "Restrictive covenants. Each shareholder agrees to a non-compete of 2 years following the end of employment with the Corporation." };
    assert.equal(spokenFigureConflicts("For the non-compete I'd expect about five years post-sale.", [shaDoc] as any).length, 0);

    assert.equal(isDealTermKey("nonCompetePeriod"), true);
    assert.equal(isDealTermKey("revenue2024"), false);
    assert.equal(documentTermNotDealTerm({ key: "transitionPeriod", docName: "Employment agreement - Diane" }), true);
    assert.equal(documentTermNotDealTerm({ key: "transitionPeriod", docName: "Term sheet v2" }), false);
    assert.equal(documentTermNotDealTerm({ key: "annualRevenue", docName: "Operating agreement summary" }), false);
    ok("known-3/8: a document's own term (SHA covenant) never forces a reconcile against the sale's term; LOI terms and the seller's own words still do");
  }

  // ── known-4: a transient overload is retried before the seller sees the fault notice ──
  {
    const saved = TRANSIENT_RETRY.delaysMs;
    TRANSIENT_RETRY.delaysMs = [1, 1];
    const reply = { message: "How many presses run on second shift?", suggestedAnswers: ["All 40", "About half", "Not sure"] };
    const json = JSON.stringify(toolInput(reply));
    const overloaded = Object.assign(new Error('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'), { name: "APIConnectionError" });
    const makeClient = (plan: Array<"overload" | "overload-after-text" | "billing" | "ok">) => {
      let calls = 0;
      const client: any = {
        messages: {
          stream: () => {
            const step = plan[calls++] ?? "ok";
            return {
              async *[Symbol.asyncIterator]() {
                if (step === "overload") throw overloaded;
                if (step === "billing") throw Object.assign(new Error("Your credit balance is too low to access the Anthropic API."), { status: 400 });
                for (let i = 0; i < json.length; i += 20) {
                  if (step === "overload-after-text" && i > json.length / 2) throw overloaded;
                  yield { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: json.slice(i, i + 20) } };
                }
              },
              on: () => undefined,
              abort: () => undefined,
              finalMessage: async () => ({ content: [{ type: "tool_use", id: "t", name: "interview_response", input: JSON.parse(json) }], stop_reason: "tool_use" }),
            };
          },
          create: async () => {
            const step = plan[calls++] ?? "ok";
            if (step === "overload") throw Object.assign(new Error("529 overloaded"), { status: 529 });
            return { content: [{ type: "tool_use", id: "t", name: "interview_response", input: JSON.parse(json) }], stop_reason: "tool_use" };
          },
        },
      };
      return { client, calls: () => calls };
    };
    const params = { model: "m", maxTokens: 100, temperature: 1, system: [], messages: [{ role: "user" as const, content: "We run three shifts." }] };

    // R1 T4: overloaded before any text → retried, the seller gets the question.
    const a = makeClient(["overload", "ok"]);
    let shown = "";
    const ra = await callInterviewWithRecovery(a.client, params, (d) => { shown += d; });
    assert.equal(ra.degraded, false);
    assert.equal(ra.response.message, reply.message);
    assert.equal(shown, reply.message, "the retry streams the question once");
    assert.equal(a.calls(), 2);
    // Overloaded for longer than the retries: the honest fault notice.
    const b = makeClient(["overload", "overload", "overload"]);
    const rb = await callInterviewWithRecovery(b.client, params, () => {});
    assert.equal(rb.degraded, true);
    assert.equal(b.calls(), 3, "two retries, then the notice");
    // Text already on screen: never restarted (it would be shown twice).
    const c = makeClient(["overload-after-text", "ok"]);
    const rc = await callInterviewWithRecovery(c.client, params, () => {});
    assert.equal(rc.degraded, true);
    assert.equal(c.calls(), 1);
    // A billing failure is not retried.
    const d = makeClient(["billing", "ok"]);
    const rd = await callInterviewWithRecovery(d.client, params, () => {});
    assert.equal(rd.degraded, true);
    assert.equal(d.calls(), 1);
    // The plain (non-streamed) call: a 529 status is retried too.
    const e = makeClient(["overload", "ok"]);
    const re = await callInterviewWithRecovery(e.client, params);
    assert.equal(re.degraded, false);
    assert.equal(e.calls(), 2);
    assert.equal(isTransientModelError(overloaded), true);
    assert.equal(isTransientModelError({ status: 503 }), true);
    assert.equal(isTransientModelError({ status: 400, message: "invalid_request_error: messages: text content blocks must be non-empty" }), false);
    TRANSIENT_RETRY.delaysMs = saved;
    ok("known-4: an overloaded/5xx model call is retried with backoff before anything is shown; never after text is on screen; billing errors aren't retried");
  }

  // ── known-5: no implied add-back list inside the earnings hand-off (R2 T6) ──
  {
    const seller = "Listen, honestly, you keep dancing around the number — Morgan's gonna put a million-five in the book or not? Because that's what the business makes when you take out me and Maria and the personal stuff. I need to know what you're putting in front of buyers.";
    const reply =
      "The earnings figure that goes in the CIM is your broker Morgan's call, worked out against your actual statements. What I can tell you is that everything you've told me about your compensation, Maria's salary, and the vehicle costs is captured and goes to her for that calculation.\n\nOn something I can help with: you mentioned Maria handles the Comfort Club renewal calls — roughly how many hours a week does that take her versus the other admin work she does?";
    const list = candidateListStatements(reply, seller);
    assert.equal(list.length, 1);
    assert.match(list[0], /captured and goes to her for that calculation/);
    const ctx: PolishContext = {
      sellerMessage: seller, jurisdiction: "CA", location: "Hamilton, ON", sellerText: seller, sellerUtterances: [seller], facts: [],
      today: new Date("2026-09-26T12:00:00Z"), priorAiText: "",
      statements: null,
    };
    const out = polishMessage(reply, ctx).message;
    assert.doesNotMatch(out, /compensation, Maria's salary, and the vehicle costs/);
    assert.match(out, /broker/, "the hand-off stays");
    assert.match(out, /how many hours a week/);
    // Not money talk, or a question: untouched.
    assert.deepEqual(candidateListStatements("Maria's salary and the vehicle lease both run through the company. How many vans are leased?", "We lease six vans."), []);
    assert.deepEqual(candidateListStatements("Does your compensation or the vehicle costs go into that calculation?", seller), []);
    ok("known-5: items routed into 'that calculation' (no figures) are an add-back list and are cut; the hand-off and question stay");
  }

  // ── known-6: "you mentioned …" played back before the next question (R2 T2) ──
  {
    const seller = "No, never been an issue — we treat people right, they stay. Listen, the business clears about a million and a half when you add it all back — is that the number in the book?";
    const reply =
      "On the $1.5M: the earnings figure that goes in the book is your broker's to walk you through, against your statements.\n\nOn the employment agreements: you mentioned it's never been an issue. With the one claim that settled last year, did that experience change your thinking at all about putting agreements in place going forward, or is the plan to leave that to the buyer?";
    const out = stripFillerPreamble(reply, { sellerMessage: seller });
    assert.doesNotMatch(out, /you mentioned it's never been an issue/);
    assert.match(out, /^On the \$1\.5M: the earnings figure/, "the answer to the seller's question stays");
    assert.match(out, /did that experience change your thinking/);
    // Outside question mode too.
    const plain = stripFillerPreamble("You mentioned settling it at closing. What's the current balance on the shareholder loan?", { sellerMessage: "We'll settle it at closing — Denise has the exact number." });
    assert.equal(plain, "What's the current balance on the shareholder loan?");
    // Kept: context from an earlier turn the question builds on; a contrast with the file; a leaning question.
    const brake = "On the equipment side, you mentioned the 110-ton brake is leaking and needs replacement at around $180K. Beyond that, is there any other major equipment near end of life?";
    assert.equal(stripFillerPreamble(brake, { sellerMessage: "We have nine presses." }), brake);
    const contrast = "You mentioned 14 staff, but the roster lists 16. Which is right?";
    assert.equal(stripFillerPreamble(contrast, { sellerMessage: "We have 14 staff." }), contrast);
    ok("known-6: the seller's last answer played back as 'you mentioned …' is cut; earlier context and contrasts with the file stay");
  }

  process.stdout.write(`\n${n} groups passed\n`);
  process.exit(0);
})().catch((err) => {
  process.stderr.write(`${err?.stack ?? err}\n`);
  process.exit(1);
});
