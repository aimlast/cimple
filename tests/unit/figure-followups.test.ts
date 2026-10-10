/**
 * ONE follow-up path to the seller (spec §9.7, INTEGRATION §2.11, C15/C16).
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/figure-followups.test.ts
 *
 * Proves: Tab 3's "Ask the seller" and the Overview's never-asked rows go out
 * in ONE batch → one notifySellerPortal call (one notification per seller
 * link) listing both kinds; both are stamped (figure questions → ask_seller
 * by the broker; discrepancies → routed); the seller's progress count adds
 * the figure questions; a preview sends and stamps nothing; while the
 * interview runs nothing is emailed (the interview raises them); a demo deal
 * records and never emails; nobody to send to → nothing stamped.
 */
import assert from "node:assert/strict";
import { figurePglite, run, test } from "./helpers/figure-test";

delete process.env.RESEND_API_KEY;
const { storage } = await import("../../server/storage");
const { sendSellerFollowUps, emailNeverAskedFollowUps, figureQuestionsWithSeller, notifySellerOfFollowUps } = await import("../../server/interview/seller-followups");
const { _useFigureDbForTests, insertQuestionIfAbsent, listQuestions } = await import("../../server/cim/figures/store");
const { routedToSellerAt } = await import("../../shared/discrepancy-gate");

const { db } = await figurePglite();
_useFigureDbForTests(db);

const rows: any[] = [];
const notifications: any[] = [];
const deal: any = { id: "deal-f", businessName: "Pacific Coast Logistics Ltd.", interviewCompleted: true, demoKey: "pacific-qa" };
let invites: any[] = [{ id: "inv1", dealId: deal.id, token: "tok-test", sellerEmail: "seller@qa-oct.invalid", sellerName: "Test Seller", status: "sent", expiresAt: null }];
const s = storage as any;
s.getDeal = async () => deal;
s.getDiscrepanciesByDeal = async () => rows.map((r) => ({ ...r }));
s.getDiscrepancy = async (id: string) => rows.find((r) => r.id === id);
s.updateDiscrepancy = async (id: string, u: any) => Object.assign(rows.find((r) => r.id === id), u);
s.updateDiscrepancyIfStatus = async (id: string, statuses: string[], u: any) => {
  const r = rows.find((x) => x.id === id);
  return r && statuses.includes(r.status) ? Object.assign(r, u) : undefined;
};
s.getNotificationsByDeal = async () => notifications;
s.createNotification = async (n: any) => { const row = { id: `n${notifications.length}`, createdAt: new Date(), ...n }; notifications.push(row); return row; };
s.getDealMembers = async () => [];
s.getSellerInvitesByDealId = async () => invites;

const q = (figureKey: string, line: string) => ({
  figureKey, kind: "movement" as const, compareKey: "2022", captureKey: `reason${line.replace(/\W/g, "")}Change2023`,
  question: `What was behind the change in ${line} in 2023?`, valuesShown: { line }, status: "suggested" as const, routedBy: null,
});
const q1 = (await insertQuestionIfAbsent(deal.id, q("line:fuel|2023", "fuel")))!;
const q2 = (await insertQuestionIfAbsent(deal.id, q("operatingExpenses|2023", "operating expenses")))!;
rows.push({ id: "d1", dealId: deal.id, severity: "critical", status: "ask_seller", source: "financial_analysis", field: "2024 Revenue", sideSources: null });

test("a preview lists every follow-up waiting and sends nothing", async () => {
  const r = await sendSellerFollowUps(deal.id, { questionIds: [q1, q2], includeNeverAsked: true, preview: true });
  assert.equal(r.preview, true);
  assert.deepEqual(r.listed.map((x) => x.kind), ["figure", "figure", "discrepancy"]);
  assert.deepEqual(r.listed.map((x) => x.label), ["fuel 2023", "operating expenses 2023", "2024 Revenue"]);
  assert.equal(notifications.length, 0);
  assert.equal(routedToSellerAt(rows[0]), null);
  assert.ok((await listQuestions(deal.id)).every((x) => x.status === "suggested"));
});

test("one batch → ONE notification per seller link covering both kinds; both are stamped", async () => {
  const r = await sendSellerFollowUps(deal.id, { questionIds: [q1, q2], includeNeverAsked: true });
  assert.equal(notifications.length, 1, "one email (recorded: a demo deal never emails)");
  assert.equal(notifications[0].type, "seller_followup_questions");
  assert.equal(notifications[0].metadata.waiting, 3);
  assert.equal(notifications[0].metadata.figureQuestions, 2);
  assert.equal(notifications[0].emailSent, false, "demo deal: recorded, never emailed");
  assert.equal(r.stamped, 1);
  assert.equal(r.figuresRouted, 2);
  assert.ok(routedToSellerAt(rows[0]));
  const qs = await listQuestions(deal.id);
  assert.ok(qs.every((x) => x.status === "ask_seller" && x.routedBy === "broker" && x.routedAt));
});

test("the seller's follow-up count adds the figure questions with the seller", async () => {
  assert.equal(await figureQuestionsWithSeller(deal.id), 2);
  const notice = await notifySellerOfFollowUps(deal.id);
  assert.equal(notice.waiting, 3, "1 routed conflict + 2 figure questions");
});

test("the Overview's Email the seller is a thin wrapper of the same path", async () => {
  rows.push({ id: "d2", dealId: deal.id, severity: "significant", status: "ask_seller", source: "financial_analysis", field: "Employee count", sideSources: null });
  const sent = notifications.length;
  const r = await emailNeverAskedFollowUps(deal.id);
  assert.equal(r.neverAsked, 1);
  assert.equal(r.recentlyEmailed, true);
  assert.equal(r.stamped, 1);
  assert.equal(notifications.length, sent, "emailed within the hour already: added to that email, not sent again");
  assert.ok(!("listed" in r), "the Overview keeps its old response shape");
});

test("while the interview runs: nothing is emailed; the interview raises the figure questions", async () => {
  const running = { ...deal, id: "deal-run", interviewCompleted: false };
  s.getDeal = async () => running;
  const id = (await insertQuestionIfAbsent(running.id, q("line:fuel|2023", "fuel")))!;
  notifications.length = 0;
  const r = await sendSellerFollowUps(running.id, { questionIds: [id], includeNeverAsked: true });
  assert.equal(notifications.length, 0);
  assert.equal(r.interviewFinished, false);
  assert.equal(r.figuresRouted, 1);
  assert.equal((await listQuestions(running.id))[0].status, "ask_seller");
  s.getDeal = async () => deal;
});

test("nobody to send to: nothing is stamped", async () => {
  invites = [];
  const lone = { ...deal, id: "deal-lone" };
  s.getDeal = async () => lone;
  s.getNotificationsByDeal = async () => [];
  const id = (await insertQuestionIfAbsent(lone.id, q("line:fuel|2023", "fuel")))!;
  const r = await sendSellerFollowUps(lone.id, { questionIds: [id], includeNeverAsked: false });
  assert.equal(r.addressed, 0);
  assert.equal(r.figuresRouted, 0);
  assert.equal((await listQuestions(lone.id))[0].status, "suggested");
});

await run("figure-followups");
_useFigureDbForTests(null);
