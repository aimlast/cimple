/**
 * Decision reminder pipeline rules — no database, no email.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/unit/decision-reminders.test.ts
 */
import assert from "node:assert/strict";
import { reminderActionFor, buildReminderEmail, buyerFacingDealName, canSnoozeDecision } from "../../server/reminders/decision-reminders";
import { blindLeakTerms, isBlindSafe } from "../../shared/blind-guard";

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

// ── "Need more time" never reverts a final decision ──────────────────────
assert.equal(canSnoozeDecision("under_review"), true);
assert.equal(canSnoozeDecision(null), true, "legacy NULL = still deciding");
for (const d of ["interested", "not_interested", "lapsed"]) assert.equal(canSnoozeDecision(d), false, d);

// ── Email templates: blind buyers never learn the business's name ─────────
const deal = {
  id: "d1",
  businessName: "Pacific Coast Logistics Ltd.",
  blindCodename: "Project Tidewater",
  extractedInfo: { companyName: "Pacific Coast Logistics", ownerName: "Grant Whitaker", city: "Delta" },
} as any;
const url = "https://app.cimple.ca/view/tok";
const terms = blindLeakTerms(deal, { codename: deal.blindCodename });
for (const level of ["teaser", "full", null, "something_new"]) {
  for (const stage of ["reminder", "warning", "lapse"] as const) {
    const e = buildReminderEmail(stage, deal, { accessLevel: level, buyerName: "Sam Rivera" } as any, url);
    const all = `${e.subject}\n${e.html}`;
    assert.ok(!/Pacific Coast/i.test(all), `${level}/${stage}: business name leaked`);
    assert.ok(isBlindSafe(all, terms), `${level}/${stage}: identity check failed`);
    assert.ok(all.includes("Project Tidewater"), `${level}/${stage}: uses the codename`);
    assert.ok(!/Confidential Information Memorandum for/i.test(all), `${level}/${stage}: generic wording`);
    assert.ok(e.html.includes("Hi Sam,"));
  }
}
// Blind buyer, no codename yet → neutral wording, still no name.
for (const stage of ["reminder", "warning", "lapse"] as const) {
  const e = buildReminderEmail(stage, { ...deal, blindCodename: null }, { accessLevel: "teaser", buyerName: null } as any, url);
  const all = `${e.subject}\n${e.html}`;
  assert.ok(!/Pacific Coast/i.test(all), `no-codename ${stage}`);
  assert.ok(/confidential opportunity|opportunity you reviewed/i.test(all), `no-codename ${stage}: neutral wording`);
  assert.ok(e.html.includes("Hello,"));
}
assert.equal(buildReminderEmail("reminder", { ...deal, blindCodename: null }, { accessLevel: "full" } as any, url).subject, "Quick check-in on the opportunity you reviewed");
// LOI / due-diligence buyers read the named CIM → the email names the business.
for (const level of ["loi", "due_diligence"]) {
  const e = buildReminderEmail("reminder", deal, { accessLevel: level, buyerName: "Sam" } as any, url);
  assert.equal(e.subject, "Quick check-in — Pacific Coast Logistics Ltd.");
  assert.ok(e.html.includes("Confidential Information Memorandum for <strong>Pacific Coast Logistics Ltd.</strong>"));
}
assert.deepEqual(buyerFacingDealName(deal, { accessLevel: "teaser" } as any), { blind: true, name: "Project Tidewater" });
// Names are HTML-escaped.
const esc = buildReminderEmail("warning", { businessName: "A&B <Co>", blindCodename: null } as any, { accessLevel: "loi", buyerName: "<b>x" } as any, url);
assert.ok(esc.html.includes("A&amp;B &lt;Co&gt;") && !esc.html.includes("<b>x"));

console.log("decision-reminders: all assertions passed");
