/**
 * Resilience round 2 — the checker's follow-ups on round 1.
 *   R5  the DD run is followed to ITS result (dd-run.ts, keyed on the run's
 *       startedAt) — a run that fails before the first poll is announced
 *       too, and the builder no longer says "ready" on the 202;
 *   R1  key sections are the summary / statements / earnings build / deal
 *       terms by key and title — not every section the engine tagged
 *       "financials" or "transaction";
 *   R1  an AI error that retrying can't fix (credits out, a rejected key)
 *       never says "try again in a few minutes";
 *   R6  a very large source's tail is searched rarest word first;
 *   R4  a reminder Resend refused for good is not retried every 6 hours.
 * No database, no AI (stubbed clients, storage and fetch).
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/f2-resilience-r2.test.ts
 */
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { storage } from "../../server/storage";
import { describeAiFailure } from "../../server/ai-retry";
import { generationShortfall, isKeySection } from "../../server/cim/generation-shortfall";
import { generateCimLayout, _setAnthropicForTests } from "../../server/cim/layout-engine";
import { _setGeneratorForTests, getLiveCimGenerationStatus, startCimGeneration } from "../../server/cim/generation-jobs";
import { _setDdClientForTests, _setDdRunWriterForTests, DdUnavailableError, planDdRun, startFullDdGeneration } from "../../server/cim/dd-enrichment";
import { checkDdRun, ddRunToast, DD_LOST_AFTER_MS } from "../../client/src/components/cim-builder/dd-run";
import { searchSourcesFor, tailWindowStarts, CHUNKED_CHARS_PER_SOURCE } from "../../server/interview/source-context";
import {
  isPermanentRecipientRejection,
  processReminderForAccess,
  reminderActionFor,
  runDecisionReminders,
  ReminderEmailNotSentError,
  UNDELIVERABLE_STAGE,
} from "../../server/reminders/decision-reminders";
import { CIM_FALLBACK_REASONING } from "../../shared/cim-layouts";

let passed = 0;
const ok = (name: string) => { passed++; console.log(`  ✓ ${name}`); };
const origWarn = console.warn;
const origErr = console.error;
const origLog = console.log;
const quiet = () => { console.warn = () => {}; console.error = () => {}; };
const loud = () => { console.warn = origWarn; console.error = origErr; };

const apiError = (status: number, message: string) => Object.assign(new Error(message), { status });
const CREDITS = apiError(400, '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}');

// ── R5: the DD run's own result, however fast it fails ─────────────────────
{
  const startedAt = "2026-09-29T10:00:00.000Z";
  const pending = { startedAt, acceptedAt: 1_000_000 };
  const failedRun = { startedAt, finishedAt: "2026-09-29T10:00:00.400Z", error: "The AI service failed (the AI account is out of credits) while writing the due-diligence version (3 of 3 sections). Nothing was changed — trying again won't help until the AI credits are topped up.", written: 0, notWritten: 3, warnings: [] };
  // Credits out: the run failed in 0.4 s — the first poll already shows it
  // finished (running was never observed). It is still announced.
  const c1 = checkDdRun(pending, { running: false, lastRun: failedRun }, pending.acceptedAt + 200);
  assert.equal(c1.kind, "finished");
  const t1 = ddRunToast(c1 as any);
  assert.equal(t1.title, "Due-diligence version not updated");
  assert.equal(t1.variant, "destructive");
  assert.match(t1.description!, /won't help/);
  // An older run's result is never mistaken for this one.
  const older = { ...failedRun, startedAt: "2026-09-28T09:00:00.000Z", error: undefined, notWritten: 0 };
  assert.equal(checkDdRun(pending, { running: true, lastRun: older }, pending.acceptedAt + 5000).kind, "wait");
  assert.equal(checkDdRun(pending, { running: false, lastRun: older }, pending.acceptedAt + 100).kind, "wait", "a poll already in flight at the click");
  assert.equal(checkDdRun(pending, { running: false, lastRun: older }, pending.acceptedAt + DD_LOST_AFTER_MS).kind, "lost", "the server lost the run (restart)");
  assert.match(ddRunToast({ kind: "lost" }).description!, /Nothing was changed/);
  // Success and gaps.
  assert.equal(ddRunToast({ kind: "finished", run: { ...failedRun, error: undefined, written: 12, notWritten: 0 } }).title, "Due-diligence version ready");
  const gaps = ddRunToast({ kind: "finished", run: { ...failedRun, error: undefined, written: 10, notWritten: 2 } });
  assert.equal(gaps.title, "Due-diligence version written with gaps");
  assert.match(gaps.description!, /10 sections written · 2 couldn't be written/);
  ok("a DD run is announced from its own result — even one that failed before the first poll; never 'ready' early");

  // The server stamps each run with the startedAt the 202 returns.
  quiet();
  _setDdRunWriterForTests(async () => {});
  _setDdClientForTests({ messages: { create: async () => { throw CREDITS; } } });
  const at = new Date("2026-09-29T11:00:00.000Z");
  const sec = (id: string) => ({ id, dealId: "d-r2", sectionKey: id, sectionTitle: `Section ${id}`, layoutType: "prose_highlight", layoutData: { body: "x" }, aiDraftContent: "x", brokerEditedContent: null, ddStaleAt: null } as any);
  const summary = await startFullDdGeneration({ id: "d-r2", businessName: "B", industry: "I", extractedInfo: {} } as any, [sec("a"), sec("b")], { context: "", knownText: "" }, at).done;
  loud();
  assert.equal(summary.startedAt, at.toISOString());
  assert.match(summary.error!, /out of credits/);
  assert.match(summary.error!, /won't help until the AI credits are topped up/);
  assert.doesNotMatch(summary.error!, /few minutes/);
  const routes = fs.readFileSync(path.join(process.cwd(), "server", "routes.ts"), "utf8");
  const start = routes.indexOf('app.post("/api/deals/:dealId/generate-dd"');
  assert.ok(routes.slice(start, routes.indexOf("app.get(", start)).includes("startedAt: startedAt.toISOString()"), "the 202 carries the run's startedAt");
  _setDdRunWriterForTests(null);
  ok("each DD run carries its startedAt; a credits-out run says retrying won't help");

  // Both screens use the same follower; the builder no longer toasts "ready" on the 202.
  const designer = fs.readFileSync(path.join(process.cwd(), "client", "src", "pages", "CIMDesigner.tsx"), "utf8");
  const tab = fs.readFileSync(path.join(process.cwd(), "client", "src", "pages", "broker", "deal", "CimTab.tsx"), "utf8");
  assert.ok(designer.includes("useDdRun(") && tab.includes("useDdRun("));
  assert.ok(!designer.includes('"Due-diligence version ready"'), "the builder never says ready up front");
  assert.ok(!designer.includes("generate-${mode}"), "DD no longer goes through the synchronous blind mutation");
  assert.ok(designer.includes("disabled={ddBusy}"), "the builder's DD button stays busy while the run is written");
  assert.ok(!tab.includes("ddWasRunning"), "the CIM tab no longer depends on having seen 'running'");
  ok("the CIM tab and the builder follow the DD run the same way");
}

// ── R1: key sections by key and title only ─────────────────────────────────
{
  const key = (k: string, t: string, tags: string[] = []) => isKeySection({ sectionKey: k, sectionTitle: t, tags });
  // The spine of a CIM.
  for (const [k, t] of [
    ["executive_summary", "Executive Summary"],
    ["financial_performance", "Three-Year Financial Performance"],
    ["financial_summary", "Financial Summary"],
    ["financial_statements", "Summary Financial Statements"],
    ["financial_summary_table", "Three-Year Income Statement Summary"],
    ["sde_normalization", "Seller's Discretionary Earnings (SDE)"],
    ["ebitda_normalization", "EBITDA Normalization & Adjustments"],
    ["adjusted_ebitda", "Adjusted EBITDA Calculation"],
    ["sde_waterfall", "Adjusted SDE Build"],
    ["transaction_structure", "Transaction Overview"],
    ["deal_structure", "Proposed Transaction Structure"],
    ["asking_price_rationale", "Asking Price & Valuation"],
  ]) assert.ok(key(k, t), `${t} is key`);
  // Tagged "financials"/"transaction" by the engine, but not the spine (the checker's examples).
  for (const [k, t, tags] of [
    ["ideal_buyer_profile", "Ideal Buyer Profile", ["transaction", "buyer_profile"]],
    ["next_steps", "Next Steps & Contact", ["transaction"]],
    ["capex_fleet_replacement", "Capital Expenditures & Fleet Replacement", ["financials", "operations"]],
    ["seasonality_and_project_revenue", "Seasonality & Project Revenue", ["financials", "operations", "revenue"]],
    ["revenue_growth_trend", "Revenue Growth Trajectory", ["financials", "growth"]],
    ["sde_growth_visual", "SDE Growth Trajectory", ["financials", "sde", "growth"]],
    ["reason_for_sale", "Reason for Sale & Transition", ["transaction"]],
    ["balance_sheet_highlights", "Balance Sheet Highlights", ["financials"]],
  ] as Array<[string, string, string[]]>) assert.ok(!key(k, t, tags), `${t} is not key`);

  // A real 27-section CIM shape: one isolated non-key failure keeps the run.
  const sec = (k: string, t: string, tags: string[], failed = false) => ({ sectionKey: k, sectionTitle: t, tags, aiLayoutReasoning: failed ? CIM_FALLBACK_REASONING : "r" });
  const cim = [
    sec("cover_page", "Pacific Coast Logistics Ltd.", ["overview"]),
    sec("executive_summary", "Executive Summary", ["overview"]),
    sec("financial_performance", "Three-Year Financial Performance", ["financials"]),
    sec("ebitda_normalization", "EBITDA Normalization & Adjustments", ["financials"]),
    sec("transaction_structure", "Transaction Overview", ["transaction"]),
    sec("capex_fleet_replacement", "Capital Expenditures & Fleet Replacement", ["financials", "operations"], true),
    ...Array.from({ length: 21 }, (_, i) => sec(`s${i}`, `Section ${i}`, i % 2 ? ["financials"] : ["transaction"])),
  ];
  assert.equal(cim.filter(isKeySection).length, 4, "4 of 27 are key");
  assert.equal(generationShortfall(cim, { hasExistingCim: true }), null, "one failed capex section doesn't throw away the whole run");
  const keyDown = cim.map((s) => (s.sectionKey === "ebitda_normalization" ? { ...s, aiLayoutReasoning: CIM_FALLBACK_REASONING } : s));
  assert.match(generationShortfall(keyDown, { hasExistingCim: true })!.message, /including "EBITDA Normalization & Adjustments"/);
  ok("only the summary, statements, earnings build and deal terms are key — tags no longer make a third of the CIM key");
}

// ── R1: say "try again in a few minutes" only when it can help ─────────────
{
  assert.deepEqual(describeAiFailure(apiError(529, "overloaded")), { transient: true, reason: "overloaded", advice: "try again in a few minutes" });
  assert.equal(describeAiFailure(apiError(429, "rate")).reason, "rate limit");
  assert.equal(describeAiFailure(CREDITS).reason, "the AI account is out of credits");
  assert.match(describeAiFailure(CREDITS).advice, /won't help until the AI credits are topped up/);
  assert.equal(describeAiFailure(apiError(401, "invalid x-api-key")).transient, false);
  assert.match(describeAiFailure(apiError(401, "invalid x-api-key")).advice, /won't help; please contact support/);
  assert.match(describeAiFailure(apiError(404, "model not found")).reason, /error 404/);

  // The shortfall message uses the run's error when there is one.
  const five = ["a", "b", "c", "d", "e"].map((k) => ({ sectionKey: k, sectionTitle: k, aiLayoutReasoning: CIM_FALLBACK_REASONING }));
  const m1 = generationShortfall(five, { hasExistingCim: true, aiError: { status: 400, message: "Your credit balance is too low" } })!.message;
  assert.match(m1, /AI service failed \(the AI account is out of credits\) while writing all 5 sections\. Your current CIM was not changed\. Trying again won't help/);
  assert.match(generationShortfall(five, { hasExistingCim: true })!.message, /Try again in a few minutes\./, "no known cause: as before");
  ok("the AI failure is described plainly; credits out / a bad key never say 'try again in a few minutes'");

  // The layout engine's first-batch stop says why.
  const facts = JSON.parse(fs.readFileSync(path.join(process.cwd(), "tests", "fixtures", "cim", "pacific-acc2-facts.json"), "utf8"));
  const layouts = ["cover_page", "metric_grid", "prose_highlight", "bar_chart", "financial_table", "prose_highlight"];
  const engineWith = (err: Error) => _setAnthropicForTests({
    messages: {
      stream: (body: any) => ({
        finalMessage: async () => {
          if (body.tools[0].name === "cim_manifest") {
            return { stop_reason: "tool_use", content: [{ type: "tool_use", name: "cim_manifest", input: { sections: layouts.map((l, i) => ({ sectionKey: "s" + i, sectionTitle: "S" + i, order: i + 1, layoutType: l, tags: [], aiLayoutReasoning: "r", contentBrief: "b" })) } }] };
          }
          throw err;
        },
      }),
    },
  } as any, 1);
  const run = async () => {
    quiet();
    try {
      await generateCimLayout({ dealId: "d", businessName: "Pacific Coast Logistics Ltd.", industry: "Transportation", askingPrice: "$18,000,000", extractedInfo: facts, today: new Date() } as any);
      return null;
    } catch (err) {
      return err as Error;
    } finally {
      loud();
    }
  };
  engineWith(CREDITS);
  const e1 = await run();
  assert.match(e1!.message, /AI service failed \(the AI account is out of credits\) while writing the first 5 sections/);
  assert.match(e1!.message, /won't help until the AI credits are topped up/);
  engineWith(apiError(529, "overloaded_error"));
  const e2 = await run();
  assert.match(e2!.message, /\(overloaded\).*try again in a few minutes/);
  _setAnthropicForTests(null);
  ok("the layout engine's early stop names the cause and only suggests retrying when it can help");

  // The job's error when the planning call itself fails.
  const dealId = "deal-r2-job";
  const deal: any = { id: dealId, brokerId: "b1", businessName: "Q", industry: "I", askingPrice: "$1", extractedInfo: {}, isLive: false, phase: "phase4_design_finalization", cimLayoutVersion: 1, cimGeneration: null };
  const s = storage as any;
  s.getDeal = async (id: string) => (id === dealId ? structuredClone(deal) : undefined);
  s.updateDeal = async (_id: string, u: any) => Object.assign(deal, structuredClone(u));
  s.getDocumentsByDeal = async () => [];
  s.getResolvedDiscrepancies = async () => [];
  s.getBrandingByBroker = async () => undefined;
  s.getEngagementInsightsByIndustry = async () => [];
  s.getFinancialAnalysesByDeal = async () => [];
  s.getBuyerAccessByDeal = async () => [];
  s.getCimSectionOverrides = async () => [];
  s.getCimSectionsByDeal = async () => [{ id: "old" }];
  const waitDone = async () => {
    for (let i = 0; i < 300 && getLiveCimGenerationStatus(dealId)?.status === "running"; i++) await new Promise((r) => setTimeout(r, 10));
  };
  quiet();
  for (const [err, want, notWant] of [
    [CREDITS, /\(the AI account is out of credits\).*trying again won't help until the AI credits are topped up\./, /few minutes/],
    [apiError(401, "invalid x-api-key"), /\(the AI service refused Cimple's key\).*trying again won't help; please contact support\./, /few minutes/],
    [apiError(529, "overloaded"), /\(overloaded\).*try again in a few minutes\./, /won't help/],
  ] as Array<[Error, RegExp, RegExp]>) {
    _setGeneratorForTests(async () => { throw err; });
    await startCimGeneration(structuredClone(deal), "layout");
    await waitDone();
    const job = getLiveCimGenerationStatus(dealId)!;
    assert.equal(job.status, "failed");
    assert.match(job.error!, want);
    assert.doesNotMatch(job.error!, notWant);
  }
  loud();
  _setGeneratorForTests(null);
  ok("the CIM job's error for credits out / a rejected key says retrying won't help; an overload still says try again");

  // DD: the per-section refresh and the run's error carry the cause too.
  assert.match(new DdUnavailableError({ status: 400, message: "credit balance is too low" }).message, /out of credits.*Trying again won't help/);
  assert.match(new DdUnavailableError().message, /Try again in a few minutes/);
  const plan = planDdRun([{ cimSectionId: "a", layoutData: {}, contentOverride: "", failed: "api", aiError: { status: 529, message: "overloaded" } }], [{ id: "a", layoutType: "prose_highlight" } as any]);
  assert.match(plan.error!, /\(overloaded\).*try again in a few minutes/);
  ok("the DD errors name the cause the same way");
}

// ── R6: the tail of a very large source, rarest word first ─────────────────
{
  // Pure: a word on every row can't crowd out a rare word deep in the tail.
  const filler = "fuel card purchase row ".repeat(40_000); // ~920K chars, "fuel" everywhere
  const raw = "x".repeat(CHUNKED_CHARS_PER_SOURCE) + filler.slice(0, 500_000) + " the rebate is four cents " + filler.slice(0, 100_000);
  const rebateAt = raw.indexOf("rebate");
  const starts = tailWindowStarts(raw, ["fuel", "rebate", "card"], 40);
  assert.ok(starts.length <= 40);
  assert.ok(starts.some((st) => rebateAt >= st && rebateAt < st + 1000), "the rare word's passage is in the windows");
  assert.ok(starts.every((st) => st >= CHUNKED_CHARS_PER_SOURCE));
  assert.deepEqual(tailWindowStarts("short", ["fuel"]), []);
  ok("tail windows go to the rarest words first");

  // The checker's GL probe: a common word in the question ("fuel") no longer hides the deep passage.
  const accts = ["Office Supplies", "Fuel", "Repairs & Maintenance", "Wages Payable", "Accounts Receivable", "Sales Revenue", "Rent", "Insurance"];
  const lines = ["--- Sheet: GL Detail ---", "Date,Entry,Account,Memo,Debit,Credit,Balance"];
  const rows = 150_000;
  for (let i = 0; i < rows; i++) {
    lines.push(`2023-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")},JE ${10000 + i},${accts[i % accts.length]},Invoice ${i} Vendor ${i % 300},${(i * 7.13 % 5000).toFixed(2)},,${(i * 13.7).toFixed(2)}`);
    if (i === Math.floor(rows * 0.8)) lines.push("Note: the Petro-Canada fleet card program gives a rebate of 4 cents per litre on diesel fuel.");
  }
  const gl = { id: "gl-r2", name: "GL.xlsx", extractedText: lines.join("\n"), extractedData: {}, sourceKind: "document", visibility: "shared", category: "financials", isProcessed: true, updatedAt: "x" } as any;
  const t0 = Date.now();
  const hit = searchSourcesFor("What rebate does the fleet card give on fuel?", [gl]);
  const ms = Date.now() - t0;
  assert.ok(hit && /Petro-Canada/.test(hit.snippet), JSON.stringify(hit));
  assert.ok(ms < 2000, `${ms} ms`);
  ok(`a question with a word every GL row has still finds the deep passage (${ms} ms)`);
}

// ── R4: a reminder Resend refused for good ─────────────────────────────────
{
  process.env.RESEND_API_KEY = "test-resend-key";
  let reply: { status: number; body: string } = { status: 422, body: JSON.stringify({ statusCode: 422, name: "validation_error", message: "Invalid `to` field. The email address needs to follow the `email@example.com` or `Name <email@example.com>` format." }) };
  let calls = 0;
  globalThis.fetch = (async (url: any) => {
    if (!String(url).startsWith("https://api.resend.com/")) throw new Error(`blocked ${url}`);
    calls++;
    return new Response(reply.body, { status: reply.status });
  }) as any;
  assert.ok(isPermanentRecipientRejection(422, reply.body));
  assert.ok(isPermanentRecipientRejection(400, '{"message":"Invalid `to` field"}'));
  assert.ok(!isPermanentRecipientRejection(422, '{"message":"Invalid `from` field"}'), "a sender problem is configuration: retried");
  assert.ok(!isPermanentRecipientRejection(403, '{"message":"The cimple.ca domain is not verified"}'));
  assert.ok(!isPermanentRecipientRejection(500, "{}") && !isPermanentRecipientRejection(429, "{}"));

  const DAY = 86400000;
  const now = Date.now();
  const deal: any = { id: "d-rem2", businessName: "Pacific Coast Logistics", isLive: true, demoKey: null, ndaRequired: false, cimGeneration: null };
  const row = (over: any) => ({
    id: "r1", dealId: deal.id, accessToken: "tok", buyerEmail: "not-an-address", buyerName: "Pat", buyerCompany: null,
    accessLevel: "full", decision: "under_review", revokedAt: null, expiresAt: null, firstViewedAt: new Date(now - 6.5 * DAY),
    reminderStage: "reminder_sent", lastReminderAt: new Date(now - 3.5 * DAY), accessEvents: [{ type: "extended", at: "2026-09-01T00:00:00Z" }], ...over,
  });
  const updates: any[] = [];
  const s = storage as any;
  s.getDeal = async (id: string) => (id === deal.id ? { ...deal } : undefined);
  s.updateBuyerAccess = async (_id: string, u: any) => { updates.push(u); return u; };
  quiet();
  // Day 6 warning refused for good: recorded once, not thrown.
  assert.equal(await processReminderForAccess(row({}) as any, now, "https://app.test"), "undeliverable");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].reminderStage, UNDELIVERABLE_STAGE);
  assert.equal(updates[0].decision, "under_review", "never lapsed");
  assert.equal(updates[0].accessEvents.length, 2, "the broker's earlier events are kept");
  assert.deepEqual({ ...updates[0].accessEvents[1], at: "t" }, { type: "reminder_undeliverable", at: "t", stage: "warning", status: 422 });
  // …and never tried again, never lapsed.
  const after = row({ reminderStage: UNDELIVERABLE_STAGE, lastReminderAt: new Date(now) });
  for (const later of [now + 6 * 3600_000, now + 3 * DAY, now + 20 * DAY]) assert.equal(reminderActionFor(after as any, later, deal), "none");
  // Day 3 reminder refused for good: the same.
  updates.length = 0;
  assert.equal(await processReminderForAccess(row({ firstViewedAt: new Date(now - 3.5 * DAY), reminderStage: "none", lastReminderAt: null }) as any, now, "https://app.test"), "undeliverable");
  assert.equal(updates[0].accessEvents[1].stage, "reminder");
  // A sender/config refusal or an outage is still retried (not advanced).
  reply = { status: 422, body: '{"message":"Invalid `from` field."}' };
  updates.length = 0;
  await assert.rejects(() => processReminderForAccess(row({}) as any, now, "https://app.test"), ReminderEmailNotSentError);
  reply = { status: 500, body: "{}" };
  await assert.rejects(() => processReminderForAccess(row({}) as any, now, "https://app.test"), ReminderEmailNotSentError);
  assert.equal(updates.length, 0);
  // The run counts it apart from errors.
  reply = { status: 422, body: '{"message":"Invalid `to` field"}' };
  s.getBuyerAccessUnderReview = async () => [row({}), row({ id: "r2" })];
  console.log = () => {};
  const stats = await runDecisionReminders();
  console.log = origLog;
  loud();
  assert.equal(stats.undeliverable, 2);
  assert.equal(stats.errors, 0);
  assert.ok(calls > 0);
  // The broker sees it on the buyer's activity.
  const view = fs.readFileSync(path.join(process.cwd(), "server", "buyers", "profile-view.ts"), "utf8");
  assert.ok(view.includes('e.type === "reminder_undeliverable"') && view.includes("follow up with them yourself"));
  ok("a reminder Resend refused for good is recorded once for the broker, never retried and never lapses the buyer; outages still retry");
}

console.log(`f2-resilience-r2: ${passed} passed`);
process.exit(0);
