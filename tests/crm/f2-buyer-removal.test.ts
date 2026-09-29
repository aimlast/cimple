// F2-DI-4: a buyer the broker removed from their list stays removed — the
// 6-hourly Pipedrive buyer sync used to re-create them (with a fresh CRM
// profile, the broker's own edits gone). Removal is now a soft delete the
// sync respects; adding the buyer back by hand restores the broker's edits.
// Round 2: a removal made WHILE a sync runs (runs take minutes; the removed
// list is read at the start) holds too — checked again right before a row is
// made, and once more after it.
// Pipedrive is a stubbed fetch; no model call (no API key → extraction skipped).
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/crm/f2-buyer-removal.test.ts
import assert from "node:assert/strict";

delete process.env.ANTHROPIC_API_KEY;
process.env.PIPEDRIVE_API_BASE = "http://pipedrive.invalid";
const { storage } = await import("../../server/storage");
const { startPipedriveBuyerSync, getLiveBuyerSyncStatus } = await import("../../server/crm/buyer-sync");

const people: Record<number, any> = {
  101: { id: 101, name: "Vendor Val", email: [{ value: "val@vendor.invalid", primary: true }] },   // removed (CRM person on the removed row)
  102: { id: 102, name: "Lender Lou", email: [{ value: "lou@lender.invalid", primary: true }] },   // removed (buyer account on the removed row)
  103: { id: 103, name: "Buyer Bea", email: [{ value: "bea@buyer.invalid", primary: true }] },    // a real new buyer
};
const personFetches: number[] = [];
let onPersonFetch: ((id: number) => void) | null = null;
globalThis.fetch = (async (input: any) => {
  const url = new URL(String(input));
  const p = url.pathname;
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  if (p === "/v1/persons") return json({ success: true, data: Object.values(people) });
  if (p === "/v1/personFields") return json({ success: true, data: [] });
  const m = p.match(/^\/v1\/persons\/(\d+)(\/deals)?$/);
  if (m && !m[2]) { personFetches.push(Number(m[1])); onPersonFetch?.(Number(m[1])); return json({ success: true, data: people[Number(m[1])] }); }
  if (m && m[2]) return json({ success: true, data: [] });
  if (p === "/v1/notes") return json({ success: true, data: [] });
  return new Response("not found", { status: 404 });
}) as any;

const B = "broker-1";
const buyers: any[] = [
  { id: "u-val", email: "val@vendor.invalid" },
  { id: "u-lou", email: "lou@lender.invalid" },
];
const contacts: any[] = [
  { id: "c-val", brokerId: B, buyerUserId: "u-val", source: "crm", crmProvider: "pipedrive", crmRecordId: "101", brokerProfile: { background: "My note: this is a vendor" }, removedAt: new Date() },
  { id: "c-lou", brokerId: B, buyerUserId: "u-lou", source: "crm", crmProvider: null, crmRecordId: null, brokerProfile: { background: "Lender, not a buyer" }, removedAt: new Date() },
];
const s = storage as any;
s.getIntegrationsByBroker = async () => [{ id: "i1", brokerId: B, provider: "pipedrive", status: "connected", accessToken: "tok", config: {} }];
s.updateIntegration = async () => undefined;
s.getRemovedBrokerBuyerContacts = async (brokerId: string) => contacts.filter((c) => c.brokerId === brokerId && c.removedAt);
s.getBuyerUserByEmail = async (email: string) => buyers.find((b) => b.email === email);
s.createBuyerUser = async (d: any) => { const b = { id: `u-${buyers.length + 1}`, ...d }; buyers.push(b); return b; };
s.updateBuyerUser = async (id: string, u: any) => Object.assign(buyers.find((b) => b.id === id), u);
s.getBrokerBuyerContact = async (brokerId: string, buyerUserId: string) => contacts.find((c) => c.brokerId === brokerId && c.buyerUserId === buyerUserId && !c.removedAt);
s.getRemovedBrokerBuyerContact = async (brokerId: string, buyerUserId: string) => contacts.find((c) => c.brokerId === brokerId && c.buyerUserId === buyerUserId && c.removedAt);
s.createBrokerBuyerContact = async (d: any) => { const c = { id: `c-${contacts.length + 1}`, removedAt: null, ...d }; contacts.push(c); return c; };
s.updateBrokerBuyerContact = async (id: string, u: any) => Object.assign(contacts.find((c) => c.id === id), u);
s.deleteBrokerBuyerContact = async (id: string) => { const i = contacts.findIndex((c) => c.id === id); if (i >= 0) contacts.splice(i, 1); };
const runSyncToEnd = async () => {
  const r = await startPipedriveBuyerSync(B, { mode: "all", auto: false });
  assert.equal(r.started, true);
  for (let i = 0; i < 200 && getLiveBuyerSyncStatus(B)?.state === "running"; i++) await new Promise((res) => setTimeout(res, 20));
  const st = getLiveBuyerSyncStatus(B)!;
  assert.equal(st.state, "done");
  return st;
};

const r = await startPipedriveBuyerSync(B, { mode: "all", auto: false });
assert.equal(r.started, true);
for (let i = 0; i < 200 && getLiveBuyerSyncStatus(B)?.state === "running"; i++) await new Promise((res) => setTimeout(res, 20));
const status = getLiveBuyerSyncStatus(B)!;
assert.equal(status.state, "done");
assert.equal(status.skippedRemoved, 2, "both removed people are left off");
assert.equal(contacts.filter((c) => c.buyerUserId === "u-val").length, 1, "the vendor is not re-created");
assert.equal(contacts.filter((c) => c.buyerUserId === "u-lou").length, 1, "the lender is not re-created");
assert.ok(contacts.find((c) => c.buyerUserId === "u-val").removedAt, "still removed");
assert.equal(contacts.find((c) => c.id === "c-val").brokerProfile.background, "My note: this is a vendor", "the broker's edits are kept");
assert.ok(!personFetches.includes(101), "a person removed by CRM id isn't even fetched");
const bea = buyers.find((b) => b.email === "bea@buyer.invalid");
assert.ok(bea && contacts.some((c) => c.buyerUserId === bea.id && !c.removedAt), "a new buyer is still added");
console.log("✓ the CRM buyer sync never re-creates a buyer the broker removed (by CRM person or by buyer account)");

// Adding a removed buyer back by hand (manual add, CSV, NDA, deal access) restores their row — the broker's edits with it.
const restored = await (storage as any).upsertBrokerBuyerContact({ brokerId: B, buyerUserId: "u-lou", source: "manual", tags: [], notes: null });
assert.equal(restored.id, "c-lou", "the same row comes back, not a second one");
assert.equal(restored.removedAt, null);
assert.equal(restored.brokerProfile.background, "Lender, not a buyer");
assert.equal(contacts.filter((c) => c.buyerUserId === "u-lou").length, 1);
console.log("✓ adding a removed buyer back restores their row and the broker's edits");

// ── Round 2: removed while the sync runs ──
// Dee is on the list only through deal access (an account, no contact row);
// the broker removes her after the sync started — while it fetches her record.
for (const k of Object.keys(people)) delete people[Number(k)];
people[104] = { id: 104, name: "Buyer Dee", email: [{ value: "dee@buyer.invalid", primary: true }] };
buyers.push({ id: "u-dee", email: "dee@buyer.invalid" });
onPersonFetch = (id) => {
  if (id === 104) contacts.push({ id: "c-dee-removed", brokerId: B, buyerUserId: "u-dee", source: "deal", removedAt: new Date() });
};
let st = await runSyncToEnd();
assert.equal(contacts.filter((c) => c.buyerUserId === "u-dee" && !c.removedAt).length, 0, "a buyer removed during the run isn't put back");
assert.equal(st.skippedRemoved, 1);
console.log("✓ a buyer removed while the sync runs isn't put back (checked right before a row is made)");

// The removal lands in the instant between that check and the new row.
delete people[104];
people[105] = { id: 105, name: "Buyer Eve", email: [{ value: "eve@buyer.invalid", primary: true }] };
buyers.push({ id: "u-eve", email: "eve@buyer.invalid" });
onPersonFetch = null;
const create = s.createBrokerBuyerContact;
s.createBrokerBuyerContact = async (d: any) => {
  const row = await create(d);
  if (d.buyerUserId === "u-eve") contacts.push({ id: "c-eve-removed", brokerId: B, buyerUserId: "u-eve", source: "deal", removedAt: new Date() });
  return row;
};
st = await runSyncToEnd();
assert.equal(contacts.filter((c) => c.buyerUserId === "u-eve" && !c.removedAt).length, 0, "the row made as the removal landed is taken back off");
assert.equal(st.skippedRemoved, 1);
assert.equal(st.created, 0);
console.log("✓ a removal landing as the sync makes the row takes it back off");

console.log("f2-buyer-removal: all passed");
process.exit(0);
