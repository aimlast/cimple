/**
 * gl spec §12.1 test 31 (extends tests/unit/uploads-gate.test.ts): a general
 * ledger or an add-back's support file opens only for the owning broker and
 * the owner's or accountant's seller link — never an attorney's, a
 * representative's or a revoked member's; other documents are unchanged.
 */
import assert from "node:assert/strict";
import { test, done } from "./_harness";
import { mayOpenDocument } from "../../server/security/uploads-gate";
import { sellerLinkRights } from "../../shared/seller-link-rights";

const members = [
  { id: "m1", teamType: "seller", role: "accountant", email: "books@acme.invalid", inviteStatus: "sent" },
  { id: "m2", teamType: "seller", role: "attorney", email: "law@acme.invalid", inviteStatus: "sent", permissions: ["view_cim", "view_financials"] },
  { id: "m3", teamType: "seller", role: "representative", email: "rep@acme.invalid", inviteStatus: "sent" },
  { id: "m4", teamType: "seller", role: "owner", email: "gone@acme.invalid", inviteStatus: "revoked" },
  { id: "m5", teamType: "seller", role: "owner", email: "co-owner@acme.invalid", inviteStatus: "accepted" },
];
const invites: Record<string, { dealId: string; sellerEmail: string }> = {
  owner: { dealId: "d1", sellerEmail: "owner@acme.invalid" },
  acct: { dealId: "d1", sellerEmail: "books@acme.invalid" },
  atty: { dealId: "d1", sellerEmail: "law@acme.invalid" },
  rep: { dealId: "d1", sellerEmail: "rep@acme.invalid" },
  revoked: { dealId: "d1", sellerEmail: "gone@acme.invalid" },
  coowner: { dealId: "d1", sellerEmail: "co-owner@acme.invalid" },
};
const deps = {
  getDocumentsByFileUrl: async () => [],
  getDeal: async (id: string) => (id === "d1" ? { id: "d1", brokerId: "b1" } : undefined),
  getSellerInviteByToken: async (t: string) => invites[t],
  getDealMembers: async () => members,
};

await test("canTraceAddbacks by role: owner and accountant yes; attorney (even with view_financials), representative, revoked no", () => {
  const r = (email: string) => sellerLinkRights({ sellerEmail: email }, members).canTraceAddbacks;
  assert.equal(r("owner@acme.invalid"), true, "the original seller invite is the owner");
  assert.equal(r("co-owner@acme.invalid"), true);
  assert.equal(r("books@acme.invalid"), true);
  assert.equal(r("law@acme.invalid"), false);
  assert.equal(r("rep@acme.invalid"), false);
  assert.equal(r("gone@acme.invalid"), false);
});

await test("ledger and support files: owner/accountant links and the broker only", async () => {
  for (const subcategory of ["general_ledger", "addback_support"]) {
    const doc = { dealId: "d1", subcategory };
    assert.equal(await mayOpenDocument(deps, doc, { brokerId: "b1" }), true, "broker");
    assert.equal(await mayOpenDocument(deps, doc, { sellerToken: "owner" }), true, "owner");
    assert.equal(await mayOpenDocument(deps, doc, { sellerToken: "coowner" }), true, "co-owner");
    assert.equal(await mayOpenDocument(deps, doc, { sellerToken: "acct" }), true, "accountant");
    for (const t of ["atty", "rep", "revoked"]) assert.equal(await mayOpenDocument(deps, doc, { sellerToken: t }), false, `${subcategory} ${t}`);
    // Without the team lookup, nobody but the broker.
    assert.equal(await mayOpenDocument({ ...deps, getDealMembers: undefined }, doc, { sellerToken: "owner" }), false);
    // A broker-only ledger: never to the seller.
    assert.equal(await mayOpenDocument(deps, { ...doc, visibility: "broker_only" }, { sellerToken: "owner" }), false);
  }
});

await test("any other document: every seller link of the deal, as before", async () => {
  for (const t of ["owner", "acct", "atty", "rep"]) assert.equal(await mayOpenDocument(deps, { dealId: "d1", subcategory: "pnl" }, { sellerToken: t }), true, t);
});

done("uploads-gate-gl");
