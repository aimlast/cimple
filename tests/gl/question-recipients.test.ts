/**
 * Fixer round 1 (GL-R1-11): "Ask the seller about this" with no recipients
 * on record goes to the owner only — never to everyone the event routes to
 * (under the Q21 fallback event a representative is routed, and a
 * representative can't open the books page) — else to nobody. Memory
 * storage; the deal is a demo deal, so nothing is emailed.
 */
import assert from "node:assert/strict";
import { test, done } from "./_harness";
import { fakeWorld, fakeDeal, cleanup } from "./_fake-storage";
import { storage } from "../../server/storage";
import { sendTraceQuestion, _setGlNotificationRoutingForTests } from "../../server/gl/notify";
import { glRecipients } from "../../server/gl/broker-view";
import { NOTIFICATION_ROUTING } from "../../shared/schema";

const w = fakeWorld();
const notes: any[] = [];
(storage as any).createNotification = async (n: any) => { notes.push(n); return { id: `n${notes.length}`, ...n }; };
(storage as any).getSellerInvitesByDealId = async (id: string) => w.invites.filter((i) => i.dealId === id);
const deal = fakeDeal(w, { demoKey: "qa-demo" } as any);
w.invites.push(
  { id: "i-own", dealId: deal.id, token: "tok-own", sellerEmail: "owner@x.invalid", sellerName: "Dan", status: "accepted", createdAt: new Date("2025-01-01") } as any,
  { id: "i-rep", dealId: deal.id, token: "tok-rep", sellerEmail: "rep@x.invalid", sellerName: "Rae", status: "accepted", createdAt: new Date("2025-01-02") } as any,
);
w.members.push(
  { id: "m-own", dealId: deal.id, teamType: "seller", role: "owner", email: "owner@x.invalid", name: "Dan", inviteStatus: "accepted", emailNotifications: true } as any,
  { id: "m-rep", dealId: deal.id, teamType: "seller", role: "representative", email: "rep@x.invalid", name: "Rae", inviteStatus: "accepted", emailNotifications: true } as any,
);

await test("under the fallback event (routing lines removed) a question with no stored recipients reaches the owner only", async () => {
  const saved = (NOTIFICATION_ROUTING as any).seller_gl_request;
  delete (NOTIFICATION_ROUTING as any).seller_gl_request;
  try {
    await sendTraceQuestion(deal.id, "Golf club dues", "t1", []);
  } finally {
    (NOTIFICATION_ROUTING as any).seller_gl_request = saved;
  }
  assert.deepEqual(notes.map((n) => n.recipientId), ["m-own"], "never the representative");
  assert.equal(notes[0].type, "seller_followup_questions");
});

await test("Q21 off (as shipped): 'Ask the seller…' offers only people whose link opens the books — the owner, never the representative", async () => {
  const people = await glRecipients(deal.id);
  assert.ok(people.length >= 1);
  assert.ok(people.every((p) => p.role === "owner" || p.role === "accountant"), JSON.stringify(people.map((p) => p.role)));
  assert.ok(!people.some((p) => p.role === "representative"));
});

await test("(switched on — Q21's yes) stored recipients are used as they are; no owner on the deal → nobody is emailed", async () => {
  _setGlNotificationRoutingForTests(true);
  notes.length = 0;
  await sendTraceQuestion(deal.id, "Golf club dues", "t1", ["m-own"]);
  assert.deepEqual(notes.map((n) => n.recipientId), ["m-own"]);
  notes.length = 0;
  // The owner's own link (no member row) still counts as the owner…
  w.members = w.members.filter((m) => m.role !== "owner");
  await sendTraceQuestion(deal.id, "Golf club dues", "t1", []);
  assert.deepEqual(notes.map((n) => n.recipientId), ["i-own"]);
  // …only the representative left → nobody is emailed (the question waits on the page).
  notes.length = 0;
  w.invites = w.invites.filter((i) => i.id !== "i-own");
  await sendTraceQuestion(deal.id, "Golf club dues", "t1", []);
  assert.equal(notes.length, 0);
  _setGlNotificationRoutingForTests(null);
});

cleanup(w);
done("question recipients");
