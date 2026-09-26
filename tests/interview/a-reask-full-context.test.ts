// Round A (a-reask), round 2: the acceptance test's re-asks replayed with the
// FULL recorded context — every document, every fact on file and the real
// prior sessions of the three deals (tests/interview/fixtures/
// a-reask-full-context.json.gz, fictional demo businesses). The cut-down
// fixture of a-reask-replay.test.ts (a handful of facts, sliced documents)
// hid that the candidate cap cut the sources on real deals. No network: the
// answer check is a mocked verifier.
//
// Also: the choice-question check with an undecided seller, K/M figures,
// the live claim check's count rule on a bare figure, the seller re-voicing
// pass on names that aren't the seller, and the rewrite check's budget.
//
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/interview/a-reask-full-context.test.ts
import assert from "node:assert/strict";
import fs from "fs";
import zlib from "zlib";
import {
  findReasks,
  sureFindings,
  confirmFindings,
  checkRewrite,
  capCandidates,
  askClause,
  choiceAnsweredNow,
  figureTokens,
  priorQAFromSessions,
  rewriteCheckBudget,
  MAX_REWRITES,
  REWRITE_CHECK_DEADLINE_MS,
  REWRITE_CHECK_TIMEOUT_MS,
  type PriorQA,
  type ReaskContext,
  type ReaskFinding,
} from "../../server/interview/reask-guard";
import type { AnswerVerifier } from "../../server/interview/answer-check";
import { claimMaterial, claimSentences, validateLiveClaims, countTopic } from "../../server/interview/live-claims";
import { revoiceSeller, sellerNamesFrom } from "../../server/interview/seller-voice";

const fx = JSON.parse(zlib.gunzipSync(fs.readFileSync("tests/interview/fixtures/a-reask-full-context.json.gz")).toString("utf8"));
let n = 0;
const ok = (name: string) => { n++; process.stdout.write(`✓ ${name}\n`); };

// ── The recorded context, parsed as the checker's replay parsed it ──
function docs(text: string) {
  const out: any[] = [];
  let cur: any = null;
  let buf: string[] = [];
  let i = 0;
  for (const l of text.split("\n")) {
    const m = l.match(/^##### (.*) \| (\w+) \| (\w+)$/);
    if (m) {
      if (cur) out.push({ ...cur, extractedText: buf.join("\n").trim() });
      cur = { id: `d${i++}`, name: m[1], sourceKind: m[2], visibility: m[3] };
      buf = [];
    } else buf.push(l);
  }
  if (cur) out.push({ ...cur, extractedText: buf.join("\n").trim() });
  return out;
}
function info(text: string) {
  const out: Record<string, unknown> = {};
  let key: string | null = null;
  for (const l of text.split("\n")) {
    const m = l.match(/^([A-Za-z_][A-Za-z0-9_]*): (.*)$/);
    if (m) { key = m[1]; out[key] = m[2]; continue; }
    if (key) out[key] = `${out[key]}\n${l}`;
  }
  for (const [k, v] of Object.entries(out)) {
    const s = String(v);
    if (/^[\[{]/.test(s)) { try { out[k] = JSON.parse(s); } catch { /* cut */ } }
  }
  return out;
}
function sessions(text: string) {
  const out: any[] = [];
  let cur: any = null;
  let msg: any = null;
  for (const l of text.split("\n")) {
    const s = l.match(/^### SESSION (\S+) (\S+) (\S+)$/);
    if (s) { cur = { id: s[1], status: s[2], startedAt: s[3], messages: [] }; out.push(cur); msg = null; continue; }
    const m = l.match(/^\[(ai|user)\] (.*)$/);
    if (m) { msg = { role: m[1], content: m[2] }; cur.messages.push(msg); continue; }
    if (msg) msg.content += `\n${l}`;
  }
  for (const s of out) for (const m of s.messages) m.content = m.content.trim();
  return out;
}
type Turn = { role: string; text: string };
function ctxAt(T: Turn[], i: number, base: { info: any; documents: any[]; earlier: PriorQA[]; from?: number }): ReaskContext {
  const qa: PriorQA[] = [];
  for (let k = base.from ?? 0; k < i - 1; k++) if (T[k].role === "ai" && T[k + 1].role === "seller") qa.push({ question: T[k].text, answer: T[k + 1].text, where: "earlier in this session" });
  if (qa.length && T[i - 1]?.role === "seller") qa[qa.length - 1].current = true;
  return { sellerMessage: T[i - 1]?.role === "seller" ? T[i - 1].text : "", info: base.info, documents: base.documents, priorQA: [...base.earlier, ...qa] };
}

const GL = { D: docs(fx.gl.docs), I: info(fx.gl.info), S: sessions(fx.gl.sessions), T: fx.gl.turns as Turn[] };
const LK = { D: docs(fx.lk.docs), I: info(fx.lk.info), S: sessions(fx.lk.sessions), T: fx.lk.turns as Turn[] };
const CWD = docs(fx.cw.docs);
const CW = { I: info(fx.cw.info), Ia: info(fx.cw.infoAfter1), S: sessions(fx.cw.sessions), Sa: sessions(fx.cw.sessionsAfter1), T: fx.cw.turns as Turn[] };
const glCtx = (i: number) => ctxAt(GL.T, i, { info: GL.I, documents: GL.D, earlier: priorQAFromSessions(GL.S, "new") });
const lkCtx = (i: number) => ctxAt(LK.T, i, { info: LK.I, documents: LK.D, earlier: priorQAFromSessions(LK.S, "new") });
// Session 1 continues the base's second (open) sitting: its stored exchanges come first.
const cwStored: PriorQA[] = [];
{
  const m = CW.S[1].messages;
  for (let k = 0; k < m.length - 1; k++) if (m[k].role === "ai" && m[k + 1].role === "user") cwStored.push({ question: m[k].content, answer: m[k + 1].content, where: "earlier in this session" });
}
const cw1Ctx = (i: number) => ctxAt(CW.T, i, { info: CW.I, documents: CWD, earlier: [...priorQAFromSessions(CW.S, CW.S[1].id), ...cwStored] });
const cw2Ctx = (i: number) => ctxAt(CW.T, i, { info: CW.Ia, documents: CWD, earlier: priorQAFromSessions(CW.Sa, "s2"), from: 11 });

/** A mocked answer check that confirms the candidates stating the answer. */
const grader = (evidence: RegExp): AnswerVerifier => async (_q, candidates) => new Set(candidates.filter((c) => evidence.test(c.text)).map((c) => c.id));

(async () => {
  // Sanity: this is the full context, not the cut-down one.
  assert.ok(Object.keys(GL.I).length > 100 && Object.keys(LK.I).length > 100 && Object.keys(CW.Ia).length > 100, "every fact on file");
  assert.ok(GL.D.length > 15 && LK.D.length > 15 && CWD.length > 10, "every document");
  ok(`full recorded context: ${Object.keys(GL.I).length}/${Object.keys(LK.I).length}/${Object.keys(CW.Ia).length} facts, ${GL.D.length}/${LK.D.length}/${CWD.length} documents`);

  // ════ The candidates that carry the answer reach the answer check ════
  const cases: Array<{ label: string; turn: Turn; ctx: ReaskContext; want: RegExp }> = [
    // LK T8: "Could Denise send over a breakdown showing each tech's name alongside their certifications?" — the roster is on file.
    { label: "Lakeshore T8 (the roster the reply asks Denise to send)", turn: LK.T[16], ctx: lkCtx(16), want: /Staff roster with technician licences is already on file/ },
    // CW S2 T1: "is there any retention arrangement being discussed for her?" — on file and on the Zoom call.
    { label: "Clearwater S2 T1 (Leah's retention)", turn: CW.T[13], ctx: cw2Ctx(13), want: /Retention arrangements recommended for Leah|retention arrangement for Leah and Dana/ },
    // LK T4: the 313A count on the roster.
    { label: "Lakeshore T4 (the 313A count)", turn: LK.T[8], ctx: lkCtx(8), want: /313A Refrigeration & A\/C Systems Mechanic,6/ },
    // CW S1 T1: T4 vs contractor.
    { label: "Clearwater S1 T1 (T4 vs contractor)", turn: CW.T[2], ctx: cw1Ctx(2), want: /8 employees on T4 payroll|Employee \(T4\)/ },
    // CW S2 opener: the reason behind the Bowmont exclusion.
    { label: "Clearwater S2 opener (Bowmont)", turn: CW.T[11], ctx: cw2Ctx(11), want: /for emotional reasons|rather not sell to them/ },
    // GL opener: the press-replacement budget.
    { label: "Great Lakes opener (press replacements)", turn: GL.T[0], ctx: glCtx(0), want: /1\.6 million|press replacement/i },
  ];
  for (const c of cases) {
    const found = findReasks(c.turn.text, c.ctx);
    const verify = found.filter((f) => f.verify);
    assert.ok(verify.length <= 8, `${c.label}: at most 8 model-checked candidates`);
    assert.ok(verify.some((f) => c.want.test(f.detail)), `${c.label}: a candidate carrying the answer — got\n${verify.map((f) => `  ${f.kind}: ${f.detail.slice(0, 140)}`).join("\n")}`);
    // …and once the (mocked) check confirms it, the re-ask stands.
    const stands = await confirmFindings(found, c.turn.text, grader(c.want));
    assert.ok(stands.some((f) => c.want.test(f.detail)), `${c.label}: confirmed`);
  }
  // The cut the checker found: with the old kind-by-kind fill, 5 facts + 3 earlier exchanges left no slot for a source.
  {
    const lk8 = findReasks(LK.T[16].text, lkCtx(16)).filter((f) => f.verify);
    assert.ok(lk8.filter((f) => f.kind === "fact").length >= 2 && lk8.filter((f) => f.kind === "prior_question").length >= 2 && lk8.filter((f) => f.kind === "source_text").length >= 2, "every kind gets slots");
  }
  ok("full context: the answer-bearing candidate reaches the answer check on every acceptance re-ask (LK T4/T8, CW S1 T1, S2 opener/T1, GL opener)");

  // ════ No sure finding the recorded run didn't earn ════
  {
    const sure: string[] = [];
    GL.T.forEach((t, i) => { if (t.role === "ai" && i > 0) sureFindings(findReasks(t.text, glCtx(i))).forEach((f) => sure.push(`GL[${i}] ${f.kind}`)); });
    LK.T.forEach((t, i) => { if (t.role === "ai" && i > 0) sureFindings(findReasks(t.text, lkCtx(i))).forEach((f) => sure.push(`LK[${i}] ${f.kind}`)); });
    for (const i of [2, 4, 6, 8, 10]) sureFindings(findReasks(CW.T[i].text, cw1Ctx(i))).forEach((f) => sure.push(`CW1[${i}] ${f.kind}`));
    for (const i of [13, 15, 17]) sureFindings(findReasks(CW.T[i].text, cw2Ctx(i))).forEach((f) => sure.push(`CW2[${i}] ${f.kind}`));
    assert.deepEqual(sure, ["GL[20] prior_question"], "only the peg question the seller had just answered is sure");
    ok("full context: across all 31 acceptance turns the only sure finding is GL T10 (the peg method just given)");
  }

  // ════ capCandidates: kinds take turns ════
  {
    const mk = (kind: ReaskFinding["kind"], i: number, extra: Partial<ReaskFinding> = {}): ReaskFinding => ({ kind, detail: `${kind} ${i}`, verify: true, ...extra });
    const all = [
      ...[1, 2, 3, 4, 5].map((i) => mk("fact", i)),
      ...[1, 2, 3].map((i) => mk("prior_question", i)),
      ...[1, 2, 3].map((i) => mk("source_text", i)),
      mk("own_statement", 1),
      mk("fact", 9, { fallback: true }),
      { kind: "conflict", detail: "c" } as ReaskFinding,
    ];
    const kept = capCandidates(all, 8);
    assert.deepEqual(kept.map((f) => f.detail), ["c", "fact 9", "fact 1", "prior_question 1", "source_text 1", "own_statement 1", "fact 2", "prior_question 2", "source_text 2"]);
    assert.equal(capCandidates([mk("fact", 1), mk("fact", 2)], 8).length, 2);
    ok("capCandidates: sure findings kept, strong matches first, then each kind in turn");
  }

  // ════ askClause ════
  assert.equal(askClause(CW.T[13].text).startsWith("is there any retention arrangement"), true);
  assert.equal(askClause("How many presses run on third shift?"), "");
  assert.equal(askClause("Shifting to the team structure: of your 11 physiotherapists, how many are T4 employees versus independent contractors?"), "how many are T4 employees versus independent contractors?");
  ok("askClause: the clause that asks, without the lead-in");

  // ════ choiceAnsweredNow: an undecided seller has not answered ════
  {
    const none: [string, string][] = [
      ["Are you expecting the peg to be based on a trailing-twelve-month average, or a point-in-time snapshot at closing?", "Honestly I don't know if it'd be a trailing-twelve average or a snapshot — Tom would know."],
      ["Would you prefer a share sale, or an asset sale?", "My accountant keeps going back and forth between a share sale and an asset sale."],
      ["Is the building staying with you as a leaseback, or would you sell the real estate with the business?", "Karen wants to sell the real estate, Rob wants a leaseback, we haven't decided."],
      ["Is that the full-time headcount, or does it include part-time staff?", "That's 22 full-time, I think, maybe including part-time staff too, I'd have to check."],
      ["Are you leaning toward a trailing-twelve-month average, or a point-in-time snapshot?", "Probably a trailing-twelve-month average, but it depends on what the buyer's accountant says."],
    ];
    for (const [q, s] of none) assert.equal(choiceAnsweredNow(q, s), null, s);
    // Decided sellers still count — including one naming the other option only to deny it.
    assert.equal(choiceAnsweredNow(GL.T[20].text, GL.T[19].text), "trailing-twelve-month average", "GL T10 (the seller's 'probably … trailing-twelve average' hedges the amount, not the method)");
    assert.equal(choiceAnsweredNow("Would you prefer a share sale, or an asset sale?", "We want a share sale — not an asset sale, the capital gains exemption matters."), "share sale");
    assert.equal(choiceAnsweredNow("Would you prefer a share sale, or an asset sale?", "A share sale, for the exemption."), "share sale", "the word both options share doesn't make the seller undecided");
    ok("choiceAnsweredNow: a seller naming both options or saying they don't know is not treated as decided");
  }

  // ════ figureTokens: K/M/B suffixes and scale words ════
  assert.deepEqual(figureTokens("$1.6M a year"), ["1600000"]);
  assert.deepEqual(figureTokens("about $240K"), ["240000"]);
  assert.deepEqual(figureTokens("$1.6 million annually, $1,600,000 budgeted"), ["1600000", "1600000"]);
  assert.deepEqual(figureTokens("313A holders, G1, V-11, 12 months, 2 bedrooms"), ["12", "2"]);
  {
    // A passage whose figure the draft already cites (as "$1.6M") is what the question builds on — not a candidate.
    const doc = { id: "cap", name: "Capital plan", visibility: "seller_visible", sourceKind: "document", extractedText: "Press replacement program: about $1.6 million a year of maintenance capex covers press replacements across the fleet." };
    const draft = "With about $1.6M a year going to press replacements, which presses are next in line to be replaced?";
    const found = findReasks(draft, { sellerMessage: "ok", info: {}, documents: [doc as any], priorQA: [] });
    assert.ok(!found.some((f) => f.kind === "source_text" && /Capital plan/.test(f.detail)), "cited as $1.6M");
  }
  ok("figureTokens: '$1.6M' and '$240K' are the figures, so a passage the draft already cites is skipped");

  // ════ live claims: a bare figure ("22 of them") still meets the table-row rule ════
  {
    const t4 = GL.T[5].text;
    const material = claimMaterial({ sellerMessage: t4, lastQuestion: GL.T[4].text, info: GL.I, documents: GL.D }, claimSentences(t4));
    const org = material.filter((m) => /Organizational chart/.test(m.label) && /112/.test(m.text));
    assert.ok(org.length > 0);
    for (const m of org) {
      assert.equal(validateLiveClaims([{ said: "22 of them", onFile: "112", materialId: m.id, topic: "setup technicians" }], t4, material).length, 0, `dropped vs ${m.id}`);
      assert.equal(validateLiveClaims([{ said: "22 setup and process technicians", onFile: "112", materialId: m.id, topic: "setup technician count" }], t4, material).length, 0);
    }
    assert.deepEqual(Array.from(countTopic("22 of them", "", "We've got 22 setup techs on days.", [22])).length > 0, true, "the words around the figure");
    // The real conflicts still stand (Lakeshore: 26 trucks vs 24 vans; 30 licensed techs vs 22).
    const msg = "Honestly, the business clears about a million and a half, and we've got twenty-six trucks on the road every day.";
    const mat = claimMaterial({ sellerMessage: msg, info: LK.I, documents: LK.D }, claimSentences(msg));
    const fleet = mat.find((m) => /24 service vans/.test(m.text))!;
    assert.equal(validateLiveClaims([{ said: "twenty-six trucks on the road", onFile: "24", materialId: fleet.id, topic: "fleet size" }], msg, mat).length, 1);
    const msg2 = "We've got about 30 licensed techs in the field.";
    const mat2 = claimMaterial({ sellerMessage: msg2, info: LK.I, documents: LK.D }, claimSentences(msg2));
    const lic = mat2.filter((m) => /total,22|: 22|\b22 lice/.test(m.text));
    assert.ok(lic.length > 0 && lic.every((m) => validateLiveClaims([{ said: "about 30 licensed techs", onFile: "22", materialId: m.id, topic: "licensed technician count" }], msg2, mat2).length === 1));
    ok("live claims: '22 of them' vs the org chart's 112 operators is dropped; 26 trucks vs 24 vans and 30 vs 22 licensed techs stand");
  }

  // ════ seller-voice: only the seller becomes "you" ════
  {
    const tony = sellerNamesFrom("Tony Moretti", "");
    const diane = sellerNamesFrom("Diane Kline-Morrow", "Diane Kline-Morrow (Chair, 40%) · Robert Kline (35%)");
    const same = (names: string[], t: string) => assert.equal(revoiceSeller(t, names).message, t, t);
    same(tony, "How has Tony's Pizza grown since you opened the second location?");
    same(tony, "Does Tony's Heating & Cooling hold the TSSA registration, or does the numbered company?");
    same(tony, "Are the shares held by Tony Moretti Holdings Ltd. or by you personally?");
    same(diane, "Is there a retention plan for Diane Smith, your controller?");
    same(diane, "Would Diane Smith stay on after closing?");
    same(diane, 'The lease names the tenant as "Diane Kline-Morrow and Robert Kline" — is the company on it too?');
    same(sellerNamesFrom("May Chen", ""), "Could the renewal be signed by May 31, or is the landlord slower than that?");
    same(sellerNamesFrom("Victoria Hale", ""), "Victoria has the highest rent of the three sites — is that lease up for renewal?");
    assert.deepEqual(sellerNamesFrom("May Chen", ""), ["May Chen"], "an ambiguous given name is used only in full");
    assert.equal(revoiceSeller("Does May Chen still sign the payroll?", sellerNamesFrom("May Chen", "")).message, "Does May Chen still sign the payroll?");
    assert.equal(revoiceSeller("When Diane and Rob's non-compete period ends after the sale, are there any geographic restrictions?", diane).message, "When your and Rob's non-compete period ends after the sale, are there any geographic restrictions?");
    assert.equal(revoiceSeller("Diane and Rob have personally guaranteed the bank debt. What's your expectation at closing?", diane).message, "You and Rob have personally guaranteed the bank debt. What's your expectation at closing?");
    assert.equal(revoiceSeller("Rob mentioned Diane was the one who negotiated the Veridian agreement — who owns it day to day?", diane).message, "Rob mentioned you were the one who negotiated the Veridian agreement — who owns it day to day?");
    assert.equal(revoiceSeller("Tony's 313A crew — how many are on call on weekends?", tony).message, "Your 313A crew — how many are on call on weekends?");
    ok("seller-voice: business names, other people with the same first name, dates, places and quotations are left alone");
  }

  // ════ The rewrite check's budget ════
  {
    const t0 = 1_000_000;
    assert.equal(rewriteCheckBudget(1, t0, t0 + 12_000), REWRITE_CHECK_TIMEOUT_MS, "early in the turn: the full check");
    assert.equal(rewriteCheckBudget(1, t0, t0 + REWRITE_CHECK_DEADLINE_MS - 4_000), 4_000, "near the deadline: what is left");
    assert.equal(rewriteCheckBudget(1, t0, t0 + REWRITE_CHECK_DEADLINE_MS - 1_000), 0, "too little left: no model call");
    assert.equal(rewriteCheckBudget(MAX_REWRITES, t0, t0 + 1_000), 0, "the last rewrite: no model call");
    assert.equal(rewriteCheckBudget(1, undefined), REWRITE_CHECK_TIMEOUT_MS, "no turn start (the opening): the plain timeout");
    // Past the budget the rewrite goes out on its sure findings — the verifier is never called.
    let calls = 0;
    const counting: AnswerVerifier = async () => { calls++; return new Set(["1"]); };
    const ctx = { ...lkCtx(16), turnStartedAt: Date.now() - REWRITE_CHECK_DEADLINE_MS };
    const late = await checkRewrite(LK.T[16].text, ctx, 1, counting);
    assert.equal(calls, 0);
    assert.deepEqual(late, sureFindings(findReasks(LK.T[16].text, ctx)));
    const early = await checkRewrite(LK.T[16].text, { ...ctx, turnStartedAt: Date.now() }, 1, counting);
    assert.equal(calls, 1);
    assert.ok(early.length >= 1);
    ok("rewrite check: runs while the turn has time for another rewrite (≤30s), sure findings only after that");
  }

  console.log(`\n${n} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
