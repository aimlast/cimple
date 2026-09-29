/**
 * R4 — a reminder or warning email that wasn't delivered must not advance
 * the buyer's stage: a Resend outage on the day-6 run used to mark the buyer
 * "warning_sent" and lapse them two days later, telling the broker they had
 * been warned. Resend (fetch) and storage are stubbed; nothing is sent.
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/f2-resilience-reminders.test.ts
 */
import assert from "node:assert/strict";
import { storage } from "../../server/storage";
import { processReminderForAccess, runDecisionReminders, ReminderEmailNotSentError } from "../../server/reminders/decision-reminders";

process.env.RESEND_API_KEY = "test-resend-key";
let passed = 0;
const ok = (name: string) => { passed++; console.log(`  ✓ ${name}`); };

let resend: "ok" | "500" | "429" | "throw" | "hang" = "500";
const sent: string[] = [];
globalThis.fetch = (async (url: any, init?: any) => {
  if (!String(url).startsWith("https://api.resend.com/")) throw new Error(`blocked ${url}`);
  if (resend === "throw") throw new TypeError("fetch failed");
  if (resend === "hang") {
    // Honour the abort signal like real fetch.
    // (AbortSignal.timeout's timer doesn't hold the process open — this does, like a real socket.)
    const keepAlive = setInterval(() => {}, 1000);
    return new Promise((_, reject) => init.signal.addEventListener("abort", () => { clearInterval(keepAlive); reject(init.signal.reason); }));
  }
  if (resend !== "ok") return new Response("{}", { status: Number(resend) });
  sent.push(JSON.parse(init.body).subject);
  return new Response(JSON.stringify({ id: "em" }), { status: 200 });
}) as any;

const DAY = 86400000;
const now = Date.now();
const deal: any = { id: "d-rem", businessName: "Pacific Coast Logistics", isLive: true, demoKey: null, ndaRequired: false, cimGeneration: null };
const row = (over: any) => ({
  id: "a1", dealId: deal.id, accessToken: "tok", buyerEmail: "buyer@example.invalid", buyerName: "Pat", buyerCompany: null,
  accessLevel: "full", decision: "under_review", revokedAt: null, expiresAt: null, firstViewedAt: new Date(now - 6.5 * DAY),
  reminderStage: "reminder_sent", lastReminderAt: new Date(now - 3.5 * DAY), ...over,
});
const updates: any[] = [];
const notified: string[] = [];
const s = storage as any;
s.getDeal = async (id: string) => (id === deal.id ? { ...deal } : undefined);
s.updateBuyerAccess = async (_id: string, u: any) => { updates.push(u); return u; };
s.getDealMembers = async () => [];
s.getBuyerAccess = async () => undefined;
s.createNotification = async (n: any) => { notified.push(n.type ?? n.title); return n; };
const origWarn = console.warn;
const origErr = console.error;
console.warn = () => {};
console.error = () => {};

// Day 6, Resend refuses (500, 429) or the network fails: not advanced.
for (const mode of ["500", "429", "throw"] as const) {
  resend = mode;
  updates.length = 0;
  await assert.rejects(() => processReminderForAccess(row({}) as any, now, "https://app.test"), ReminderEmailNotSentError);
  assert.equal(updates.length, 0, `${mode}: the stage stays reminder_sent`);
}
ok("an undelivered day-6 warning leaves the buyer at 'reminder_sent' (retried next run)");

// Same for the day-3 reminder.
resend = "500";
updates.length = 0;
await assert.rejects(() => processReminderForAccess(row({ firstViewedAt: new Date(now - 3.5 * DAY), reminderStage: "none", lastReminderAt: null }) as any, now, "https://app.test"), ReminderEmailNotSentError);
assert.equal(updates.length, 0);
ok("an undelivered day-3 reminder isn't recorded as sent");

// A hung Resend connection times out instead of stalling the run.
resend = "hang";
const t0 = Date.now();
const realTimeout = AbortSignal.timeout;
(AbortSignal as any).timeout = () => realTimeout.call(AbortSignal, 50);
await assert.rejects(() => processReminderForAccess(row({}) as any, now, "https://app.test"), ReminderEmailNotSentError);
(AbortSignal as any).timeout = realTimeout;
assert.ok(Date.now() - t0 < 5000);
ok("the email call has a timeout");

// The runner counts it as an error and moves on; nothing lapses.
resend = "500";
updates.length = 0;
s.getBuyerAccessUnderReview = async () => [row({}), row({ id: "a2" })];
const stats = await runDecisionReminders();
assert.equal(stats.errors, 2);
assert.equal(stats.warningSent, 0);
assert.equal(updates.length, 0);
ok("the run counts undelivered emails in stats.errors and advances nobody");

// Delivered: the warning is recorded; only then can the buyer lapse, 48h later.
resend = "ok";
updates.length = 0;
assert.equal(await processReminderForAccess(row({}) as any, now, "https://app.test"), "warning");
assert.equal(updates[0].reminderStage, "warning_sent");
assert.equal(sent.length, 1);
const warned = row({ firstViewedAt: new Date(now - 9 * DAY), reminderStage: "warning_sent", lastReminderAt: new Date(now - 2.1 * DAY) });
updates.length = 0;
resend = "500"; // the courtesy lapse email failing doesn't undo a lapse that was warned about
assert.equal(await processReminderForAccess(warned as any, now, "https://app.test"), "lapse");
assert.equal(updates[0].decision, "lapsed");
ok("a delivered warning is recorded, and only a warned buyer is lapsed");

console.warn = origWarn;
console.error = origErr;
console.log(`f2-resilience-reminders: ${passed} passed`);
process.exit(0);
