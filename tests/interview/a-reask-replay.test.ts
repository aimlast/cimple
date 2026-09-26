// Round A (a-reask): every re-ask from the 2026-09-26 live acceptance test,
// replayed offline through the guard / evidence pipeline with the recorded
// source text, facts and transcripts (tests/interview/fixtures/
// a-reask-acceptance.json — fictional demo businesses) and MOCKED model
// verdicts. No network: the answer check, the live claim check and the
// interview model are all stubbed.
//
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/interview/a-reask-replay.test.ts
import assert from "node:assert/strict";
import fs from "fs";
import {
  findReasks,
  sureFindings,
  checkRewrite,
  applyReaskGuard,
  choiceAnsweredNow,
  relevantExcerpt,
  requestedDocumentCandidates,
  priorQAFromSessions,
  type PriorQA,
  type ReaskContext,
} from "../../server/interview/reask-guard";
import type { AnswerVerifier } from "../../server/interview/answer-check";
import { normaliseTableText, unglueLine } from "../../server/interview/table-text";
import { claimChunks, claimMaterial, claimSentences, checkLiveClaims, figureNear, claimWords } from "../../server/interview/live-claims";
import { searchSourcesFor } from "../../server/interview/source-context";
import { lastSittingOf, agreedNextTopic, openingContinuityIssues, olderSittingsText, renderLastSitting } from "../../server/interview/last-sitting";
import { revoiceSeller, sellerNamesFrom } from "../../server/interview/seller-voice";
import { fixSourceReferences } from "../../server/interview/source-wording";
import { polishMessage, type PolishContext } from "../../server/interview/reply-polish";
import { assembleKnowledgeBase, renderKnowledgeBaseForPrompt } from "../../server/interview/knowledge-base";
import { installHarness, baseDeal, toolInput } from "./turn-harness";
import { startOrResumeSession } from "../../server/interview/session-manager";

const fx = JSON.parse(fs.readFileSync("tests/interview/fixtures/a-reask-acceptance.json", "utf8"));
let n = 0;
const ok = (name: string) => { n++; process.stdout.write(`✓ ${name}\n`); };

type Turn = { role: "ai" | "seller"; text: string; opener?: boolean };
const GL: Turn[] = fx.transcripts.greatLakes;
const LK: Turn[] = fx.transcripts.lakeshore;
const CW: Turn[] = fx.transcripts.clearwater;
const withSources = (info: Record<string, string>, map: Record<string, { source: string; documentId?: string }>) => ({ ...info, _fieldSources: map });
const glInfo = withSources(fx.greatLakes.info, Object.fromEntries(Object.keys(fx.greatLakes.info).map((k) => [k, { source: "document", documentId: "gl-org" }])));
const cwInfo = withSources(fx.clearwater.info, {
  idealBuyer: { source: "video_call", documentId: "cw-zoom" },
  transitionPlan: { source: "video_call", documentId: "cw-zoom" },
  keyEmployees: { source: "video_call", documentId: "cw-zoom" },
  fullTimeCount: { source: "document", documentId: "cw-roster" },
  partTimeCount: { source: "document", documentId: "cw-roster" },
  permitsLicenses: { source: "document", documentId: "cw-roster" },
});
const cwSessions = fx.clearwater.sessions.map((s: any, i: number) => ({ ...s, lastActivityAt: s.startedAt, completedAt: s.startedAt, startedAt: new Date(s.startedAt), id: s.id ?? `cw-${i}` }));

/** The exchanges of a transcript before turn `upto` (the last one is the exchange being answered now). */
function sessionQA(turns: Turn[], upto: number, from = 0): PriorQA[] {
  const out: PriorQA[] = [];
  for (let i = from; i < upto - 1; i++) {
    if (turns[i].role === "ai" && turns[i + 1].role === "seller") out.push({ question: turns[i].text, answer: turns[i + 1].text, where: "earlier in this session" });
  }
  if (out.length > 0 && turns[upto - 1]?.role === "seller") out[out.length - 1].current = true;
  return out;
}
/** The re-ask context processTurn builds for the AI turn at index `i`. */
function ctxAt(turns: Turn[], i: number, base: { info: Record<string, unknown>; documents: any[]; earlier?: PriorQA[]; from?: number }): ReaskContext {
  return {
    sellerMessage: turns[i - 1]?.role === "seller" ? turns[i - 1].text : "",
    info: base.info,
    documents: base.documents,
    priorQA: [...(base.earlier ?? []), ...sessionQA(turns, i, base.from ?? 0)],
  };
}
/**
 * A mocked answer check: the supporting model "confirms" the items whose
 * text states the answer (the evidence the acceptance review named). It
 * sees exactly the candidate text the guard sends — so a candidate that
 * no longer carries the answer (a head-cut excerpt) is not confirmed.
 */
function grader(evidence: RegExp[]) {
  const calls: { question: string; items: string[] }[] = [];
  const verifier: AnswerVerifier = async (question, candidates) => {
    calls.push({ question, items: candidates.map((c) => c.text) });
    return new Set(candidates.filter((c) => evidence.some((re) => re.test(c.text))).map((c) => c.id));
  };
  return { verifier, calls };
}

(async () => {
  // ════ ACC-INT-1a: the flattened org chart (Great Lakes T3/T4) ════
  {
    const org = fx.greatLakes.documents[0].extractedText as string;
    const norm = normaliseTableText(org);
    assert.match(norm, /^Press operators & packers: 112 · 3 shifts/m);
    assert.match(norm, /^Setup & process technicians: 22$/m);
    assert.match(norm, /^Setup and process technicians: 22$/m, "the glued row 'technicians22' reads as its row");
    assert.match(norm, /^Material handling, shipping & receiving: 18$/m, "a label wrapped over two lines is joined first");
    assert.match(norm, /^Executive leadership \(CEO, VP Operations\): 2$/m);
    assert.match(norm, /^Tool room \(mold maintenance and repair\): 9$/m);
    assert.equal(unglueLine("Associate physiotherapist fees (contractors)1,018,300912,800"), "Associate physiotherapist fees (contractors): 1,018,300 912,800");
    assert.equal(unglueLine("E-104,Luis Fernandes,Senior HVAC Technician,HVAC,2009-08-17,15.6,313A,G1,Yes,41,85280"), "E-104,Luis Fernandes,Senior HVAC Technician,HVAC,2009-08-17,15.6,313A,G1,Yes,41,85280", "CSV rows and codes are left alone");
    assert.equal(unglueLine("ISO 13485 and IATF16949 since FY2019"), "ISO 13485 and IATF16949 since FY2019");
    // Every window the live claim check shows the model pairs each figure with its own label.
    const chunks = claimChunks(fx.greatLakes.documents);
    for (const c of chunks) {
      assert.ok(!/112 · 3 shifts \(24\/5 \+ weekend OT\) Setup & process technicians(?!:)/.test(c.text), `no window reads 112 as setup technicians: ${c.text}`);
    }
    assert.ok(chunks.some((c) => /Setup & process technicians: 22/.test(c.text)));
    const hit = searchSourcesFor("How many setup and process technicians do you have?", fx.greatLakes.documents);
    assert.ok(hit && /technicians:? 22/.test(hit.snippet), "the search quotes the row with its own figure");
    ok("table text: the org chart's figures sit on their own labels' lines (glued cells and label/figure lines alike)");
  }

  // The live claim check on T3/T4 (the model's recorded conflicts, replayed).
  {
    const docs = fx.greatLakes.documents;
    // T3 in the live run: "the seller just said 22 setup and process technicians, but passage from the org chart …" (112).
    const t4 = GL[5].text;
    const lastQ = GL[4].text;
    const material = claimMaterial({ sellerMessage: t4, lastQuestion: lastQ, info: {}, documents: docs }, claimSentences(t4));
    const with112 = material.find((m) => /packers: 112/.test(m.text));
    assert.ok(with112, "the 112 row is among the material");
    const replay = (raw: unknown[]) => checkLiveClaims({ sellerMessage: t4, lastQuestion: lastQ, info: {}, documents: docs }, { model: async () => raw });
    assert.deepEqual(await replay([{ said: "22 setup and process technicians", onFile: "112", materialId: with112!.id, topic: "setup technician count", key: "setupTechCount" }]), [], "22 vs the operators' 112 is no conflict");
    // T2: the shift headcounts against the same row.
    const t2 = GL[3].text;
    const m2 = claimMaterial({ sellerMessage: t2, lastQuestion: GL[2].text, info: {}, documents: docs }, claimSentences(t2));
    const m112 = m2.find((m) => /packers: 112/.test(m.text));
    if (m112) {
      const out = await checkLiveClaims({ sellerMessage: t2, lastQuestion: GL[2].text, info: {}, documents: docs }, { model: async () => [{ said: "First shift runs about 85 people", onFile: "112", materialId: m112.id, topic: "shift headcount", key: "shiftHeadcount" }] });
      assert.deepEqual(out, [], "a shift count against the operators' row is no conflict");
    }
    // A real difference on the same row still stands.
    const wrong = "We've got about 30 setup and process techs these days.";
    const m3 = claimMaterial({ sellerMessage: wrong, info: {}, documents: docs }, claimSentences(wrong));
    const row22 = m3.find((m) => /technicians: 22/.test(m.text))!;
    const kept = await checkLiveClaims({ sellerMessage: wrong, info: {}, documents: docs }, { model: async () => [{ said: "about 30 setup and process techs", onFile: "22", materialId: row22.id, topic: "setup technicians", key: "setupTechCount" }] });
    assert.equal(kept.length, 1, "30 vs the chart's 22 is raised");
    // …and so does the Lakeshore fleet (26 trucks said; the fleet list: 24 service vans).
    // (The recorded seller message is cut off mid-word; its sentence, as the seller wrote it.)
    const fleetMsg = "Honestly, the business clears about a million and a half, and we've got twenty-six trucks on the road every day.";
    // (In the live run the file's side was the broker-settled fleet size.)
    const settled = ["fleetSize: 24 service vans (11 financed, 13 owned); the owner's RAM and his wife's Lexus are excluded"];
    const mf = claimMaterial({ sellerMessage: fleetMsg, info: {}, documents: fx.lakeshore.documents, settled }, claimSentences(fleetMsg));
    const fleetRow = mf.find((m) => /24 service vans/.test(m.text));
    assert.ok(fleetRow, "the settled fleet size is material");
    const fleet = await checkLiveClaims({ sellerMessage: fleetMsg, info: {}, documents: fx.lakeshore.documents, settled }, { model: async () => [{ said: "twenty-six trucks on the road", onFile: "24 service vans", materialId: fleetRow!.id, topic: "fleet size", key: "fleetSize" }] });
    assert.equal(fleet.length, 1, "the fleet conflict the acceptance test praised still stands");
    assert.equal(figureNear("Press operators & packers: 112 · 3 shifts (24/5 + weekend OT) Setup & process technicians: 22", 112, claimWords("setup technicians")), false);
    assert.equal(figureNear("Press operators & packers: 112 · 3 shifts (24/5 + weekend OT) Setup & process technicians: 22", 22, claimWords("setup technicians")), true);
    ok("live claims (GL T3/T4 replayed): 22 setup techs is no longer 'contradicted' by the operators' 112; real differences (30 vs 22, 26 trucks vs 24 vans) still stand");
  }

  // ════ ACC-INT-1b: the peg method the seller had just given (GL T10) ════
  {
    const i = 20;
    const ctx = ctxAt(GL, i, { info: glInfo, documents: fx.greatLakes.documents });
    assert.equal(choiceAnsweredNow(GL[i].text, GL[i - 1].text), "trailing-twelve-month average");
    const found = findReasks(GL[i].text, ctx);
    const sure = sureFindings(found);
    assert.ok(sure.some((f) => f.kind === "prior_question" && /trailing-twelve average/.test(f.detail)), "a sure finding quotes what the seller just said");
    // The live T10 was a REWRITE (checked mechanically only). Now a rewrite gets the full check —
    // and this finding stands whatever the model says (it is not sent to it).
    const none: AnswerVerifier = async () => new Set();
    const timeout: AnswerVerifier = async () => null;
    for (const v of [none, timeout]) {
      const r = await checkRewrite(GL[i].text, ctx, 1, v);
      assert.ok(r.some((f) => /trailing-twelve average/.test(f.detail)), "the rewrite is stopped");
    }
    // A negated mention is no answer.
    assert.equal(choiceAnsweredNow(GL[i].text, "It's not a trailing-twelve average — we haven't decided."), null);
    // The borderline opener ("what's the annual budget for that press replacement program?")
    // now puts maintenanceCapexRun ("$1.6 million annually … press replacements") before the answer check.
    const opener = findReasks(GL[0].text, { sellerMessage: "", info: glInfo, documents: fx.greatLakes.documents, priorQA: [] });
    assert.ok(opener.some((f) => /^maintenanceCapexRun: .*press replacements/.test(f.detail)));
    ok("GL T10 replayed: 'trailing-twelve average, or a snapshot?' right after the seller said it is caught (sure, even on a rewrite)");
  }

  // ════ ACC-INT-1c: the 313A count and the per-tech breakdown (Lakeshore T4/T8) ════
  {
    const docs = fx.lakeshore.documents;
    const i = 8; // "…the staff roster lists your technicians' licences … How many of your techs hold the 313A?"
    const ctx = ctxAt(LK, i, { info: {}, documents: docs });
    const found = findReasks(LK[i].text, ctx);
    const src = found.filter((f) => f.kind === "source_text");
    assert.ok(src.some((f) => /6 x 313A|313A Refrigeration[^»]*,6/.test(f.detail)), `the licensing summary / roster count is a candidate: ${src.map((f) => f.detail.slice(0, 120)).join(" | ")}`);
    const g = grader([/6 x 313A/, /313A Refrigeration[^»]*,6/]);
    // The live T4 was a rewrite: the first rewrite now goes to the answer check…
    const r1 = await checkRewrite(LK[i].text, ctx, 1, g.verifier);
    assert.equal(g.calls.length, 1, "the rewrite was checked by the model");
    assert.ok(r1.some((f) => f.kind === "source_text"), "…which confirms the count on file");
    // …the last allowed rewrite is not (nothing could change it any more).
    const g2 = grader([/./]);
    await checkRewrite(LK[i].text, ctx, 2, g2.verifier);
    assert.equal(g2.calls.length, 0);

    const j = 16; // "Could Denise send over a breakdown showing each tech's name alongside their certifications…?"
    const ctx8 = ctxAt(LK, j, { info: {}, documents: docs });
    const req = requestedDocumentCandidates(`${LK[j].text}`, docs);
    assert.ok(req.some((c) => c.docName === "Staff roster with technician licences"), "the roster with technician licences is on file");
    const g8 = grader([/Staff roster with technician licences is already on file/]);
    const r8 = await checkRewrite(LK[j].text, ctx8, 1, g8.verifier);
    assert.ok(r8.some((f) => /already on file/.test(f.detail)), "asking Denise to send it is caught");
    ok("LK T4/T8 replayed: the 313A count and the per-tech licence breakdown are candidates (citing the roster is no licence to ask), and a rewrite gets the answer check");
  }

  // ════ ACC-INT-1d: Clearwater — T4 vs contractor (S1 T1), Bowmont (S2 opener), Leah (S2 T1) ════
  {
    const docs = fx.clearwater.documents;
    const earlierS1 = priorQAFromSessions([cwSessions[0]], "live");
    const t1 = findReasks(CW[2].text, ctxAt(CW, 2, { info: cwInfo, documents: docs, earlier: earlierS1 }));
    assert.ok(t1.some((f) => /8 employees on T4 payroll/.test(f.detail)), "the T4 payroll fact is a candidate");
    const gT1 = grader([/8 employees on T4 payroll/]);
    const { verifier: vT1 } = gT1;
    const confirmed = (await checkRewrite(CW[2].text, ctxAt(CW, 2, { info: cwInfo, documents: docs, earlier: earlierS1 }), 1, vT1));
    assert.ok(confirmed.some((f) => /T4 payroll/.test(f.detail)));

    // S2 opening (a new sitting: both earlier sessions are prior).
    const earlier = priorQAFromSessions(cwSessions, "s2");
    const opener = CW[11].text;
    const oc: ReaskContext = { sellerMessage: "", info: cwInfo, documents: docs, priorQA: earlier };
    const oFound = findReasks(opener, oc);
    const ideal = oFound.find((f) => /^idealBuyer:/.test(f.detail));
    assert.ok(ideal && /for emotional reasons/.test(ideal.detail), "the candidate carries the reason (a head-cut at 200 characters dropped it)");
    assert.ok(!String(cwInfo.idealBuyer).replace(/\s+/g, " ").slice(0, 200).includes("emotional"), "(the old head-cut really lost it)");
    assert.ok(oFound.some((f) => f.kind === "source_text" && /rather not sell to them/.test(f.detail)), "the Zoom line is found despite 'the call notes show' in the question");

    // The whole opening guard, with a fake interview model: the Bowmont draft is
    // confirmed a re-ask, rewritten once, and the rewrite is checked too.
    const g = grader([/for emotional reasons/, /rather not sell to them/]);
    const zoning = "Good to pick up where we left off. Are both clinic premises zoned for healthcare or therapy use?";
    const fakeCalls: string[] = [];
    const fake: any = { messages: { create: async (p: any) => { fakeCalls.push(String(p.messages[p.messages.length - 1].content)); return { content: [{ type: "tool_use", id: "t", name: "interview_response", input: toolInput({ message: zoning }) }], stop_reason: "tool_use" }; } } };
    const draft = toolInput({ message: opener }) as any;
    const guarded = await applyReaskGuard(fake, { model: "m", maxTokens: 100, temperature: 1, system: [], messages: [{ role: "user", content: "open" }] } as any, draft, oc, g.verifier);
    assert.equal(guarded.recalled, true);
    assert.equal(guarded.response.message, zoning);
    assert.match(fakeCalls[0], /SYSTEM CORRECTION[\s\S]*emotional reasons/, "the correction names what is on file");
    assert.equal(g.calls.length, 2, "draft checked, rewrite checked");

    // S2 T1 (a rewrite in the live run): Leah's retention.
    const i = 13;
    const s2 = ctxAt(CW, i, { info: cwInfo, documents: docs, earlier, from: 11 });
    const leah = findReasks(CW[i].text, s2);
    assert.ok(leah.some((f) => /^transitionPlan:.*Retention arrangements recommended for Leah and Dana/.test(f.detail)), "the retention plan on file is a candidate, excerpted at the part that answers");
    const gL = grader([/Retention arrangements recommended for Leah/]);
    const rL = await checkRewrite(CW[i].text, s2, 1, gL.verifier);
    assert.equal(gL.calls.length, 1);
    assert.ok(rL.some((f) => /Retention arrangements/.test(f.detail)));
    ok("CW replayed: T4-vs-contractor, the Bowmont reason (Zoom + idealBuyer) and Leah's retention are candidates carrying the answer; the opening's rewrite is checked too");
  }

  // ════ Legitimate follow-ups still pass ════
  {
    const glLegit = [2, 8, 10, 14, 16, 18, 22];
    for (const i of glLegit) {
      const ctx = ctxAt(GL, i, { info: glInfo, documents: fx.greatLakes.documents });
      assert.deepEqual(sureFindings(findReasks(GL[i].text, ctx)).map((f) => f.detail), [], `GL turn ${i} carries no sure finding: ${GL[i].text}`);
      assert.equal(choiceAnsweredNow(GL[i].text, ctx.sellerMessage), null);
    }
    for (const i of [6, 10]) {
      const ctx = ctxAt(LK, i, { info: {}, documents: fx.lakeshore.documents });
      assert.deepEqual(sureFindings(findReasks(LK[i].text, ctx)).map((f) => f.detail), [], `LK turn ${i}`);
    }
    const earlier = priorQAFromSessions(cwSessions, "s2");
    for (const i of [4, 6]) {
      const ctx = ctxAt(CW, i, { info: cwInfo, documents: fx.clearwater.documents, earlier: priorQAFromSessions([cwSessions[0]], "live") });
      assert.deepEqual(sureFindings(findReasks(CW[i].text, ctx)).map((f) => f.detail), [], `CW turn ${i}`);
    }
    for (const i of [15, 17]) {
      const ctx = ctxAt(CW, i, { info: cwInfo, documents: fx.clearwater.documents, earlier, from: 11 });
      assert.deepEqual(sureFindings(findReasks(CW[i].text, ctx)).map((f) => f.detail), [], `CW turn ${i}`);
      // …and with a model that confirms nothing, nothing stands.
      const r = await checkRewrite(CW[i].text, ctx, 1, async () => new Set());
      assert.deepEqual(r, []);
    }
    // Choice questions that are not re-asks.
    assert.equal(choiceAnsweredNow("And the six RMTs — are they all on signed contractor agreements, or are any on the older 2019 form like Hannah?", CW[3].text), null);
    assert.equal(choiceAnsweredNow("What's the practical path to adding those one or two associates at Seton — is it a recruiting pipeline issue, a space constraint, or something else?", "We'd want one or two associates at Seton."), null);
    assert.equal(choiceAnsweredNow("Is the $38.4K the full claim with the insurer handling it above your $10K deductible, or is there any portion still in dispute?", "about $38.4K, but it's insured above our $10K deductible"), null);
    assert.equal(choiceAnsweredNow("Are there referral sources that send you compounding or community prescriptions, and if so, how concentrated is that flow?", "we filled about sixty-two thousand community prescriptions in 2024"), null);
    assert.equal(choiceAnsweredNow("Is it one insurer or both giving you trouble on those older claims?", "This batch is with one insurer, Ridgecrest Mutual."), "one insurer", "a real re-ask found in the older transcripts");
    ok("legitimate follow-ups (GL 7, LK 2, CW 4 turns) carry no mechanical finding; the choice rule ignores ranges, joined questions and inner 'or's");
  }

  // ════ relevantExcerpt ════
  {
    const long = GL[19].text + " " + "Filler sentence about something else entirely. ".repeat(10);
    const ex = relevantExcerpt(long, "are you expecting the peg to be a trailing-twelve-month average?", 200);
    assert.match(ex, /trailing-twelve average/);
    assert.ok(ex.length <= 202);
    assert.equal(relevantExcerpt("short text", "anything", 100), "short text");
    ok("relevantExcerpt: the sentence that answers, not the first 200 characters");
  }

  // ════ ACC-INT-6: the resume opener ════
  {
    const ls = lastSittingOf(cwSessions, "s2")!;
    assert.equal(ls.number, 2);
    assert.ok(ls.covered.some((q) => /patient records/.test(q)) && ls.covered.some((q) => /T4 employees versus independent contractors/.test(q)), "the last sitting's own questions");
    assert.ok(ls.nextTopic && /zoning question/.test(ls.nextTopic) && /zoned for healthcare or therapy use/.test(ls.nextTopic), `agreed next item: ${ls.nextTopic}`);
    const older = olderSittingsText(cwSessions, "s2", ls);
    const bad = openingContinuityIssues(CW[11].text, ls, older);
    assert.ok(bad.misstated.includes("forwa plan"), `'the team's forward plans' came from the older sitting: ${bad.misstated}`);
    assert.equal(bad.missesNextTopic, true, "the Bowmont opener skipped the agreed zoning question");
    const good = openingContinuityIssues("Good to pick up where we left off — last time we went through record ownership and your contractor agreements. Are both clinic premises zoned for healthcare or therapy use?", ls, older);
    assert.deepEqual(good, { misstated: [], missesNextTopic: false });
    assert.match(renderLastSitting(ls), /agreed to start this sitting with: the zoning question/);
    // Great Lakes' resume opener had the same fault (not scored in the acceptance test):
    // "last time we got into the tool room, press fleet, and your medical pipeline" was session 1;
    // the last sitting (session 2) was quality, sales, capex and the wrap-up.
    const glSessions = fx.greatLakes.sessions.map((s: any) => ({ ...s, lastActivityAt: s.startedAt }));
    const glLast = lastSittingOf(glSessions, "new")!;
    const gl = openingContinuityIssues(GL[0].text, glLast, olderSittingsText(glSessions, "new", glLast));
    assert.ok(gl.misstated.includes("tool room") && gl.misstated.includes("medic pipel"), `${gl.misstated}`);
    assert.equal(gl.missesNextTopic, false, "no next item was agreed there");
    assert.equal(agreedNextTopic([{ role: "ai", content: "Anything else before we stop?", timestamp: "" }, { role: "user", content: "No, that's all.", timestamp: "" }] as any), null);
    // "your broker notes" never reaches the seller.
    const named = fixSourceReferences(CW[11].text);
    assert.doesNotMatch(named.message, /broker notes/i);
    assert.match(named.message, /came up on your calls with your broker/);
    assert.match(fixSourceReferences("The CRM notes show a 2019 union vote — how did it end?").message, /^What's on file shows a 2019 union vote/);
    ok("resume opener: the last sitting and its agreed next item (zoning) are known; the replayed opener is flagged (older sitting's topic, zoning skipped); 'broker notes' is renamed");
  }

  // …through startOrResumeSession, with a scripted model: the S2 opening as it went out is rewritten.
  {
    const docs = fx.clearwater.documents.map((d: any) => ({ ...d, dealId: "deal-1", category: "other", status: "processed", isProcessed: true, createdAt: new Date("2026-02-01") }));
    const deal = baseDeal({ extractedInfo: cwInfo, businessName: "Clearwater Physiotherapy & Wellness Inc." });
    const h = installHarness(deal, { documents: docs });
    // Newest first, as the database returns them.
    h.sessions.push(...[...cwSessions].reverse().map((s: any) => ({ ...s, dealId: "deal-1", extractedInfo: {}, questionsAsked: 5, questionsAnswered: 5, questionsSkipped: 0 })));
    const fixed = "Good to pick up where we left off — last time we went through record ownership and your contractor agreements. Are both clinic premises zoned for healthcare or therapy use?";
    h.script.push({ message: CW[11].text, importance: "important", targetSection: "buyer_profile" });
    h.script.push({ message: fixed, importance: "critical", targetSection: "real_estate" });
    const open = await startOrResumeSession("deal-1");
    assert.match(h.calls[0], /LAST SITTING \(session 2/);
    assert.match(h.calls[0], /agreed to start this sitting with: the zoning question/);
    assert.match(h.calls[1], /SYSTEM CORRECTION[\s\S]*zoning question/);
    assert.match(h.calls[1], /older sitting/);
    assert.equal(open.message, fixed);
    assert.ok(h.logs.some((l) => /opening names an older sitting's topic .* and skips the agreed next item — rewrite/.test(l)));
    ok("startOrResumeSession (scripted model): the S2 opener gets one rewrite that picks up the agreed zoning question");
  }

  // ════ ACC-INT-10: the seller as "you" ════
  {
    const names = sellerNamesFrom("Diane Kline-Morrow", "Diane Kline-Morrow (Chair, 40%) · Robert Kline (35%)");
    assert.deepEqual(names, ["Diane Kline-Morrow", "Diane"]);
    assert.match(revoiceSeller(GL[12].text, names).message, /^When your and Rob.s non-compete period ends after the sale/);
    assert.match(revoiceSeller(GL[14].text, names).message, /^On a related item: you and Rob have personally guaranteed/);
    assert.equal(revoiceSeller("Diane, how many presses run on third shift?", names).message, "Diane, how many presses run on third shift?", "a greeting keeps the name");
    assert.equal(revoiceSeller("Is that the plan for Diane after closing, Diane?", names).message, "Is that the plan for you after closing, Diane?");
    assert.equal(revoiceSeller("Diane's role after closing — how long will it run?", names).message, "Your role after closing — how long will it run?");
    // A first name someone else on file shares is left alone (only the full name is re-voiced).
    assert.deepEqual(sellerNamesFrom("Luis Herrera", "Luis Fernandes, Senior HVAC Technician"), ["Luis Herrera"]);
    assert.deepEqual(sellerNamesFrom("Anthony (Tony) Moretti", ""), ["Anthony Moretti", "Tony Moretti", "Anthony", "Tony"]);
    // Through the polish pass every message goes through.
    const ctx: PolishContext = { sellerMessage: GL[13].text, jurisdiction: null, location: "Toledo, OH", sellerText: GL[13].text, facts: [], today: new Date("2026-09-26"), sellerNames: names };
    const polished = polishMessage(GL[14].text, ctx);
    assert.match(polished.message, /you and Rob have personally guaranteed/);
    // The knowledge base tells the agent who it is talking to.
    const deal = baseDeal({ businessName: "Great Lakes Precision Plastics, Inc.", sellerContact: { name: "Diane Kline-Morrow", title: "President & CEO (40% shareholder)" }, extractedInfo: glInfo });
    const kb = assembleKnowledgeBase(deal, [], [], null, []);
    assert.deepEqual(kb.seller?.names, ["Diane Kline-Morrow", "Diane"]);
    assert.match(renderKnowledgeBaseForPrompt(kb), /You are talking to: Diane Kline-Morrow \(President & CEO \(40% shareholder\)\) — the seller/);
    ok("seller voice (GL T6/T7 replayed): 'Diane and Rob's non-compete' → 'your and Rob's', 'Diane and Rob have guaranteed' → 'you and Rob have'; greetings kept; the prompt names who the agent is talking to");
  }

  process.stdout.write(`\n${n} groups passed\n`);
  process.exit(0);
})().catch((err) => {
  process.stderr.write(`${err?.stack ?? err}\n`);
  process.exit(1);
});
