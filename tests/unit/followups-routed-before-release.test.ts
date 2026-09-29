// Release review DEP-4: critical conflicts routed to the seller BEFORE the
// follow-up rules shipped (TrueNorth and SariKnotSari each hold one, routed on
// 2026-07-17, interview finished) would have locked those CIMs the moment the
// release went live — and their sellers were never emailed (the email is sent
// only when a row is routed after the release; SariKnotSari's real sellers
// must never be contacted anyway). Now: every routing from the release on is
// stamped; an unstamped routed row doesn't lock the CIM, is shown to the
// broker as "never asked", and only the broker's own "Email the seller" click
// sends the follow-up and stamps it (then it locks until the seller answers).
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/followups-routed-before-release.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  discrepancyBlocksCim,
  keepRoutedStamp,
  routedButNeverAsked,
  routedToSellerAt,
  withRoutedStamp,
} from "../../shared/discrepancy-gate";

delete process.env.RESEND_API_KEY;
const { storage } = await import("../../server/storage");
const { emailNeverAskedFollowUps, notifySellerOfFollowUps } = await import("../../server/interview/seller-followups");

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}`); throw e; }
}

// TrueNorth's row as production holds it (read-only, 2026-09-29).
const legacy = { id: "d-legacy", severity: "critical", status: "ask_seller", source: "financial_analysis", field: "2024 Revenue", sideSources: null };
const stamped = { ...legacy, id: "d-new", sideSources: withRoutedStamp(null, new Date("2026-09-30T12:00:00Z")) };

console.log("the gate");
await test("a routing from before the follow-up rules doesn't lock a finished interview's CIM", () => {
  assert.equal(discrepancyBlocksCim(legacy, true), false);
  assert.equal(routedButNeverAsked(legacy, true), true);
});
await test("a routing under the rules still locks it until the seller answers (J2 unchanged)", () => {
  assert.equal(discrepancyBlocksCim(stamped, true), true);
  assert.equal(routedButNeverAsked(stamped, true), false);
  assert.equal(routedToSellerAt(stamped), "2026-09-30T12:00:00.000Z");
});
await test("while the interview runs, routed rows are handled either way; open and answered rows always block", () => {
  assert.equal(discrepancyBlocksCim(legacy, false), false);
  assert.equal(discrepancyBlocksCim(stamped, false), false);
  assert.equal(routedButNeverAsked(legacy, false), false);
  assert.equal(discrepancyBlocksCim({ ...legacy, status: "open" }, true), true);
  assert.equal(discrepancyBlocksCim({ ...legacy, status: "seller_responded" }, true), true);
  assert.equal(discrepancyBlocksCim({ ...stamped, severity: "significant" }, true), false);
});
await test("the stamp keeps a row's sides, and an engine's refresh keeps the stamp", () => {
  const sides = { interview: { kind: "crm", brokerOnly: true } };
  assert.deepEqual(withRoutedStamp(sides, new Date("2026-10-01T00:00:00Z")), { ...sides, routedAt: "2026-10-01T00:00:00.000Z" });
  const refreshed = keepRoutedStamp(stamped.sideSources, { document: { kind: "document", documentId: "x" } }) as Record<string, unknown>;
  assert.equal(refreshed.routedAt, "2026-09-30T12:00:00.000Z");
  assert.deepEqual(refreshed.document, { kind: "document", documentId: "x" });
  assert.deepEqual(keepRoutedStamp(null, { document: { kind: "document" } }), { document: { kind: "document" } });
});

console.log("every routing path stamps; engines keep the stamp (source)");
await test("PATCH ask_seller, the analysis question route, the analyzer and the verification check", () => {
  const patch = readFileSync("server/routes/discrepancies.ts", "utf8");
  assert.match(patch, /withRoutedStamp\(updates\.sideSources \?\? existingDisc\.sideSources\)/);
  const routes = readFileSync("server/routes.ts", "utf8");
  assert.match(routes, /sideSources: withRoutedStamp\(hadPrivate/);
  assert.match(routes, /status: "ask_seller", sideSources: withRoutedStamp\(discrepancy\.sideSources\)/);
  assert.match(readFileSync("server/financial/analyzer.ts", "utf8"), /sideSources: keepRoutedStamp\(openMatch\.sideSources, values\.sideSources\)/);
  assert.match(readFileSync("server/cim/discrepancy-check.ts", "utf8"), /sideSources: keepRoutedStamp\(openMatch\.sideSources, values\.sideSources\)/);
  // The deal list's "waiting on the seller" count and the seller's portal count only stamped rows.
  assert.match(readFileSync("server/routes/deal-list.ts", "utf8"), /sideSources\} ->> 'routedAt'\) is not null/);
  assert.match(routes, /d\.status === "ask_seller" && !!routedToSellerAt\(d\)\)\.length/);
});

console.log("“Email the seller” (the broker's click)");
const rows: any[] = [];
const notifications: any[] = [];
const deal: any = { id: "deal-tn", businessName: "TrueNorth HVAC Services Inc.", interviewCompleted: true, demoKey: "truenorth" };
let invites: any[] = [];
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

await test("nobody to send to: nothing is stamped and the row still doesn't lock the CIM", async () => {
  rows.push({ ...legacy, dealId: deal.id });
  const r = await emailNeverAskedFollowUps(deal.id);
  assert.equal(r.neverAsked, 1);
  assert.equal(r.addressed, 0);
  assert.equal(r.stamped, 0);
  assert.equal(discrepancyBlocksCim(rows[0], true), false);
});
await test("with a seller link: the follow-up goes out (a demo deal records it, never emails) and the row is stamped — now it locks", async () => {
  invites = [{ id: "inv1", dealId: deal.id, token: "tok-test", sellerEmail: "seller@truenorth.invalid", sellerName: "Test Seller", status: "sent", expiresAt: null }];
  const r = await emailNeverAskedFollowUps(deal.id);
  assert.equal(r.addressed, 1);
  assert.equal(r.emailed, 0, "demo deals never email");
  assert.equal(r.waiting, 1, "the email counts the question being sent");
  assert.equal(r.stamped, 1);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, "seller_followup_questions");
  assert.equal(notifications[0].metadata.emailSkipped, "demo_deal");
  assert.equal(discrepancyBlocksCim(rows[0], true), true);
  assert.equal(routedButNeverAsked(rows[0], true), false);
});
await test("a later routing's email counts only questions actually sent (never the never-asked ones)", async () => {
  notifications.length = 0;
  rows.push({ ...legacy, id: "d-legacy-2", dealId: deal.id, field: "2023 Revenue" });
  const r = await notifySellerOfFollowUps(deal.id);
  assert.equal(r.waiting, 1, "the stamped row only");
});
await test("nothing is ever sent on its own: only the broker's click and a routing call these", () => {
  const callers = ["server/routes/discrepancies.ts", "server/routes.ts", "server/interview/session-manager.ts", "server/index.ts"]
    .map((f) => [f, readFileSync(f, "utf8")] as const)
    .filter(([, src]) => /emailNeverAskedFollowUps\(/.test(src))
    .map(([f]) => f);
  assert.deepEqual(callers, ["server/routes/discrepancies.ts"]);
  assert.match(readFileSync("server/routes/discrepancies.ts", "utf8"), /app\.post\("\/api\/deals\/:dealId\/discrepancies\/email-seller-followups", requireBroker, requireOwnedDeal/);
});

console.log(`\n${passed} passed`);
