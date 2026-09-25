/**
 * Decision reminder pipeline rules — no database, no email.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/unit/decision-reminders.test.ts
 */
import assert from "node:assert/strict";
import { reminderActionFor } from "../../server/reminders/decision-reminders";

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse("2026-09-25T12:00:00Z");
const ago = (d: number) => new Date(now - d * DAY);
const row = (o: Partial<Record<string, any>>) => ({
  firstViewedAt: ago(0),
  reminderStage: "none",
  decision: "under_review",
  revokedAt: null,
  expiresAt: null,
  lastReminderAt: null,
  ...o,
}) as any;

// Fresh view: nothing yet (day-0 breathing room).
assert.equal(reminderActionFor(row({ firstViewedAt: ago(1) }), now), "none");
// Day 3 → reminder; day 6 → warning.
assert.equal(reminderActionFor(row({ firstViewedAt: ago(4) }), now), "reminder");
assert.equal(reminderActionFor(row({ firstViewedAt: ago(4), reminderStage: "reminder_sent" }), now), "none");
assert.equal(reminderActionFor(row({ firstViewedAt: ago(6.5), reminderStage: "reminder_sent" }), now), "warning");

// Never lapse a buyer who was never warned: a 'none'-stage row 9 days old is WARNED.
assert.equal(reminderActionFor(row({ firstViewedAt: ago(9) }), now), "warning");
assert.equal(reminderActionFor(row({ firstViewedAt: ago(9), reminderStage: "reminder_sent" }), now), "warning");
// Warned, and the 48 hours are up → lapse. Warned an hour ago → wait.
assert.equal(reminderActionFor(row({ firstViewedAt: ago(9), reminderStage: "warning_sent", lastReminderAt: ago(3) }), now), "lapse");
assert.equal(reminderActionFor(row({ firstViewedAt: ago(9), reminderStage: "warning_sent", lastReminderAt: ago(0.05) }), now), "none");
assert.equal(reminderActionFor(row({ firstViewedAt: ago(7), reminderStage: "warning_sent", lastReminderAt: ago(1) }), now), "none");

// "Need more time" (new): decision under_review, firstViewedAt = now, stage none → fresh cycle.
const needMoreTime = row({ decision: "under_review", firstViewedAt: new Date(now), reminderStage: "none", lastReminderAt: null });
assert.equal(reminderActionFor(needMoreTime, now), "none");
assert.equal(reminderActionFor(needMoreTime, now + 4 * DAY), "reminder");
assert.equal(reminderActionFor({ ...needMoreTime, reminderStage: "reminder_sent" }, now + 6.5 * DAY), "warning");
// Legacy need-more-time rows (decision NULL) are still deciding.
assert.equal(reminderActionFor(row({ decision: null, firstViewedAt: ago(4) }), now), "reminder");

// Decided, revoked, expired or never viewed → never contacted.
for (const d of ["interested", "not_interested", "lapsed"]) {
  assert.equal(reminderActionFor(row({ decision: d, firstViewedAt: ago(9), reminderStage: "warning_sent" }), now), "none", d);
}
assert.equal(reminderActionFor(row({ revokedAt: ago(1), firstViewedAt: ago(4) }), now), "none");
assert.equal(reminderActionFor(row({ expiresAt: ago(1), firstViewedAt: ago(4) }), now), "none");
assert.equal(reminderActionFor(row({ firstViewedAt: null }), now), "none");
// A cycle is never started weeks late (links live 30 days).
assert.equal(reminderActionFor(row({ firstViewedAt: ago(79) }), now), "none");

console.log("decision-reminders: all assertions passed");
