/**
 * PRIV-1 / PRIV-2 (final review): a seller-team member's link (accountant,
 * attorney, representative) can't give the owner's CIM sign-off, and only
 * the roles buyer-question approvals are routed to see those questions.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/unit/seller-link-rights.test.ts
 */
import assert from "node:assert/strict";
import express from "express";
import { sellerLinkRights } from "../../shared/seller-link-rights";
import { storage } from "../../server/storage";
import { registerSellerReviewRoutes } from "../../server/routes/seller-review";

const members: any[] = [
  { id: "m1", dealId: "d1", teamType: "seller", role: "owner", email: "Helen@x.invalid", permissions: ["approve_qa", "approve_cim"], inviteStatus: "sent" },
  { id: "m2", dealId: "d1", teamType: "seller", role: "accountant", email: "cpa@x.invalid", permissions: ["upload_docs", "view_financials"], inviteStatus: "sent" },
  { id: "m3", dealId: "d1", teamType: "seller", role: "attorney", email: "law@x.invalid", permissions: [], inviteStatus: "sent" },
  { id: "m4", dealId: "d1", teamType: "seller", role: "representative", email: "rep@x.invalid", permissions: ["approve_qa", "upload_docs", "participate_interview"], inviteStatus: "sent" },
  { id: "m5", dealId: "d1", teamType: "seller", role: "owner", email: "gone@x.invalid", permissions: ["approve_qa", "approve_cim"], inviteStatus: "revoked" },
  { id: "m6", dealId: "d1", teamType: "buyer", role: "principal", email: "seller@x.invalid", permissions: ["view_cim"], inviteStatus: "sent" },
];

// ── The pure resolver ──────────────────────────────────────────────────
{
  const owner = sellerLinkRights({ sellerEmail: "helen@x.invalid" }, members);
  assert.deepEqual([owner.role, owner.canApproveCim, owner.canApproveQa], ["owner", true, true], "owner member (email case-insensitive)");

  const cpa = sellerLinkRights({ sellerEmail: "cpa@x.invalid" }, members);
  assert.deepEqual([cpa.role, cpa.canApproveCim, cpa.canApproveQa], ["accountant", false, false], "accountant: no sign-off, no buyer questions");

  // Empty permissions fall back to the role's defaults; the attorney has
  // approve_qa on paper but qa_needs_approval is not routed to attorneys.
  const law = sellerLinkRights({ sellerEmail: "law@x.invalid" }, members);
  assert.deepEqual([law.canApproveCim, law.canApproveQa], [false, false], "attorney: neither");

  const rep = sellerLinkRights({ sellerEmail: "rep@x.invalid" }, members);
  assert.deepEqual([rep.canApproveCim, rep.canApproveQa], [false, true], "representative: buyer questions only");

  const revoked = sellerLinkRights({ sellerEmail: "gone@x.invalid" }, members);
  assert.deepEqual([revoked.canApproveCim, revoked.canApproveQa], [false, false], "revoked member: nothing");

  // The original seller invite with no seller-team row is the owner — also
  // when a BUYER-team row happens to share the email.
  const original = sellerLinkRights({ sellerEmail: "seller@x.invalid" }, members);
  assert.deepEqual([original.role, original.memberId, original.canApproveCim, original.canApproveQa], ["owner", null, true, true]);
  const noEmail = sellerLinkRights({ sellerEmail: null }, members);
  assert.equal(noEmail.canApproveCim, true, "an invite created without an email is the original seller's");
}

// ── The routes (stubbed storage — no DB, no AI) ────────────────────────
const deal: any = {
  id: "d1", brokerId: "b1", businessName: "Harbourline Dental", contentApprovedByBroker: true, contentApprovedBySeller: false,
  designApprovedByBroker: false, designApprovedBySeller: false, interviewCompleted: true, cimGeneration: null, isLive: false, demoKey: "probe",
};
const invites: any[] = [
  { id: "i1", dealId: "d1", token: "tok-owner", sellerEmail: "helen@x.invalid", sellerName: "Helen", status: "accepted" },
  { id: "i2", dealId: "d1", token: "tok-accountant", sellerEmail: "cpa@x.invalid", sellerName: "Pat (CPA)", status: "sent" },
];
const writes: any[] = [];
const tasks: any[] = [];
const s: any = storage;
s.getSellerInviteByToken = async (t: string) => invites.find((i) => i.token === t);
s.getDeal = async () => deal;
s.getDealMembers = async () => members;
s.getDiscrepanciesByDeal = async () => [];
s.getTasksByDeal = async () => tasks;
s.createTask = async (t: any) => { tasks.push({ ...t, id: `t${tasks.length}` }); return tasks[tasks.length - 1]; };
s.updateTask = async () => ({});
s.getCimSectionsByDeal = async () => [];
s.updateDeal = async (_id: string, patch: any) => { writes.push(patch); Object.assign(deal, patch); return deal; };
s.getNotificationsByDeal = async () => [];
s.createNotification = async () => ({});
s.getSellerInvitesByDealId = async () => invites;
s.getUser = async () => undefined;
s.getBrandingByBroker = async () => undefined;

const app = express();
app.use(express.json());
app.use((req: any, _res: any, next: any) => { req.session = {}; next(); });
registerSellerReviewRoutes(app);

const srv = app.listen(0);
await new Promise((r) => srv.once("listening", r));
const base = `http://127.0.0.1:${(srv.address() as any).port}`;
const post = (path: string, body: unknown) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

try {
  // The accountant's link: 403, nothing written.
  let r = await post("/api/seller/tok-accountant/cim-review/approve", { stage: "content" });
  assert.equal(r.status, 403, "accountant can't approve");
  assert.equal((await r.json()).code, "not_owner");
  assert.equal(writes.length, 0, "no approval written");
  assert.equal(deal.contentApprovedBySeller, false);

  r = await post("/api/seller/tok-accountant/cim-review/request-changes", { note: "Please change the revenue", stage: "content" });
  assert.equal(r.status, 403, "accountant can't file the seller's change request");
  assert.equal(tasks.length, 0);

  // The GET tells the page which buttons to show (read on the not-ready
  // path, which needs no media/design lookups).
  deal.contentApprovedByBroker = false;
  let g = await (await fetch(`${base}/api/seller/tok-accountant/cim-review`)).json();
  assert.equal(g.canApprove, false);
  g = await (await fetch(`${base}/api/seller/tok-owner/cim-review`)).json();
  assert.equal(g.canApprove, true);
  deal.contentApprovedByBroker = true;

  // The owner's link approves.
  r = await post("/api/seller/tok-owner/cim-review/approve", { stage: "content" });
  assert.equal(r.status, 200, "owner approves");
  assert.deepEqual(writes, [{ contentApprovedBySeller: true }]);
} finally {
  srv.close();
}

console.log("seller-link-rights: all assertions passed");
process.exit(0);
