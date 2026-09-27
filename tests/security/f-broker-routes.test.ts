/**
 * Broker-app security review — the real routes (server/routes.ts), mounted on
 * an Express app with an in-memory storage stub (no database, no AI, no email:
 * RESEND/TWILIO unset → console only).
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/security/f-broker-routes.test.ts
 *
 * F-B1  a broker can't point a document at a server file (create/PATCH refuse
 *       fileUrl/mimeType; nothing reaches the parser)
 * F-B2  unpublished deals: no grant, no view room, no NDA/decision/Q&A;
 *       seller approval waits for publish; publishing grants it
 * F-B3  buyer decision on a deal with no team → the deal's broker is emailed
 * F-B5  PATCH carrying dealId / brokerId → 400, nothing written
 * F-B6  removing a seller-team member revokes the link minted for them
 * F-B7  team invite emails: no "get started" login link, blind buyer copy
 * F-B9  a buyer's question can't put a link into the broker's email
 * F-B10 /api/cims is gone
 * F-B11 a junk webhook token never loads the deals table
 */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.UPLOADS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "fb-uploads-"));
delete process.env.RESEND_API_KEY;
delete process.env.TWILIO_ACCOUNT_SID;
process.env.ANTHROPIC_API_KEY = "disabled";

const express = (await import("express")).default;
const { storage, DbStorage } = await import("../../server/storage");
const { registerRoutes } = await import("../../server/routes");

// ── In-memory storage stub ─────────────────────────────────────────────────
const calls: Record<string, unknown[][]> = {};
const record = (name: string, args: unknown[]) => { (calls[name] ||= []).push(args); };
const count = (name: string) => (calls[name] || []).length;
// Every method not stubbed below throws — no test can quietly hit a database.
for (const name of Object.getOwnPropertyNames(DbStorage.prototype)) {
  if (name === "constructor") continue;
  (storage as any)[name] = async (...args: unknown[]) => {
    record(name, args);
    throw new Error(`unstubbed storage.${name}`);
  };
}
const now = new Date();
const deals = new Map<string, any>([
  ["deal-draft", { id: "deal-draft", brokerId: "b1", businessName: "Harbourline Dental", industry: "Dental", isLive: false, ndaRequired: true, blindCodename: "Project Coastal", phase: "phase3_content_creation", interviewCompleted: false, designApprovedByBroker: true, designApprovedBySeller: true }],
  ["deal-live", { id: "deal-live", brokerId: "b1", businessName: "Beacon Pharmacy", industry: "Pharmacy", isLive: true, ndaRequired: true, blindCodename: "Project Harbor", phase: "phase4_design_finalization" }],
  ["deal-other", { id: "deal-other", brokerId: "b2", businessName: "Victim Co", industry: "HVAC", isLive: false, phase: "phase1_info_collection" }],
]);
const users = new Map<string, any>([
  ["b1", { id: "b1", role: "broker", email: "owner-b1@broker.invalid", username: "b1", settings: {} }],
  ["b2", { id: "b2", role: "broker", email: "owner-b2@broker.invalid", username: "b2", settings: {} }],
]);
const documents = new Map<string, any>([["doc-1", { id: "doc-1", dealId: "deal-draft", name: "P&L", fileUrl: "/uploads/docs/doc_1.pdf", mimeType: "application/pdf" }]]);
const tasks = new Map<string, any>([["task-1", { id: "task-1", dealId: "deal-draft", title: "t", type: "follow_up", status: "pending", createdBy: "b1" }]]);
const integrations = new Map<string, any>([["int-1", { id: "int-1", brokerId: "b1", provider: "pipedrive", status: "connected", accessToken: "secret", config: {} }]]);
const accessRows = new Map<string, any>([
  ["tok-draft", { id: "acc-draft", dealId: "deal-draft", accessToken: "tok-draft", buyerEmail: "buyer@x.invalid", accessLevel: "full", ndaSigned: true }],
  ["tok-live", { id: "acc-live", dealId: "deal-live", accessToken: "tok-live", buyerEmail: "buyer2@x.invalid", accessLevel: "full", ndaSigned: true }],
]);
const members = new Map<string, any>();
const invitedAt = new Date(now.getTime() - 60_000);
members.set("m-bk", { id: "m-bk", dealId: "deal-draft", teamType: "seller", role: "accountant", email: "books@acme.invalid", invitedAt, inviteStatus: "sent" });
members.set("m-owner", { id: "m-owner", dealId: "deal-draft", teamType: "seller", role: "owner", email: "owner@acme.invalid", invitedAt: new Date(now.getTime() - 5_000), inviteStatus: "sent" });
const invites = new Map<string, any>([
  ["inv-seller", { id: "inv-seller", dealId: "deal-draft", token: "seller-tok", sellerEmail: "owner@acme.invalid", sellerName: "Dana", status: "accepted", createdAt: new Date(now.getTime() - 86_400_000), sentAt: new Date(now.getTime() - 86_400_000) }],
  ["inv-bk", { id: "inv-bk", dealId: "deal-draft", token: "bk-tok", sellerEmail: "books@acme.invalid", sellerName: null, status: "accepted", createdAt: new Date(invitedAt.getTime() + 40), sentAt: null }],
]);
const approvals = new Map<string, any>([
  ["apr-1", { id: "apr-1", dealId: "deal-draft", status: "pending_seller_review", sellerReviewToken: "review-tok", buyerEmail: "newbuyer@x.invalid", buyerName: "Pat <b>Buyer</b>", buyerCompany: "Acme Capital", grantedBuyerAccessId: null }],
]);
const notificationsOut: any[] = [];
const createdAccess: any[] = [];

const stub = (name: string, fn: (...a: any[]) => any) => {
  (storage as any)[name] = async (...args: any[]) => { record(name, args); return fn(...args); };
};
stub("getDeal", (id) => deals.get(id));
stub("updateDeal", (id, u) => { const d = { ...deals.get(id), ...u }; deals.set(id, d); return d; });
stub("getUser", (id) => users.get(id));
stub("getUserByEmail", (email) => Array.from(users.values()).find((u) => u.email === email));
stub("getDocument", (id) => documents.get(id));
stub("updateDocument", (id, u) => ({ ...documents.get(id), ...u }));
stub("createDocument", (d) => ({ id: "doc-new", ...d }));
stub("getTask", (id) => tasks.get(id));
stub("updateTask", (id, u) => ({ ...tasks.get(id), ...u }));
stub("getIntegration", (id) => integrations.get(id));
stub("updateIntegration", (id, u) => ({ ...integrations.get(id), ...u }));
stub("getBuyerAccessByToken", (t) => accessRows.get(t));
stub("updateBuyerAccess", (id, u) => ({ id, ...u }));
stub("createBuyerAccess", (a) => { const row = { id: `acc-${createdAccess.length + 1}`, ...a }; createdAccess.push(row); return row; });
stub("getBuyerUserByEmail", () => undefined);
stub("getDealMember", (id) => members.get(id));
stub("getDealMembers", (dealId) => Array.from(members.values()).filter((m) => m.dealId === dealId));
stub("deleteDealMember", (id) => { members.delete(id); });
stub("getSellerInvitesByDealId", (dealId) => Array.from(invites.values()).filter((i) => i.dealId === dealId && i.status !== "revoked"));
stub("updateSellerInvite", (id, u) => { const i = { ...invites.get(id), ...u }; invites.set(id, i); return i; });
stub("createNotification", (n) => { notificationsOut.push(n); return { id: `n${notificationsOut.length}`, ...n }; });
stub("getBuyerApprovalRequestByToken", (t) => Array.from(approvals.values()).find((a) => a.sellerReviewToken === t));
stub("getBuyerApprovalRequestsByDeal", (dealId) => Array.from(approvals.values()).filter((a) => a.dealId === dealId));
stub("updateBuyerApprovalRequest", (id, u) => { const a = { ...approvals.get(id), ...u }; approvals.set(id, a); return a; });
stub("getDiscrepanciesByDeal", () => []);
stub("createAnalyticsEvent", (e) => e);
stub("getAllDeals", () => Array.from(deals.values()));
stub("updateBuyerUser", (id, u) => ({ id, ...u }));
stub("getBrandingByBroker", () => undefined);
stub("getIntegrationsByBroker", () => []);
stub("getDocumentsByDeal", () => []);

// inviteBuyerUser (buyer-auth) creates an account through storage.
stub("createBuyerUser", (u) => ({ id: "bu-1", ...u }));

// ── App ────────────────────────────────────────────────────────────────────
let sessionBroker: string | undefined = "b1";
const app = express();
app.use(express.json());
app.use((req, _res, next) => { (req as any).session = { brokerId: sessionBroker, save: (cb: any) => cb?.(), regenerate: (cb: any) => cb?.(), destroy: (cb: any) => cb?.() }; next(); });
const server = await registerRoutes(app as any);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
const req = async (method: string, url: string, body?: unknown) => {
  const r = await fetch(base + url, { method, headers: body !== undefined ? { "content-type": "application/json" } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: r.status, json, text };
};

const failures: string[] = [];
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (err: any) {
    failures.push(name);
    console.log(`FAIL ${name}: ${err?.message?.split("\n")[0]}`);
  }
}

try {
  // ── F-B1: fileUrl / mimeType are server-owned ────────────────────────────
  await check('F-B1  fileUrl / mimeType are server-owned', async () => {
    const create = await req("POST", "/api/deals/deal-draft/documents", {
      name: "x", originalName: "x", category: "other", uploadedBy: "broker",
      fileUrl: "/uploads/../../../proc/self/environ", mimeType: "text/plain",
    });
    assert.equal(create.status, 400, "create with fileUrl refused");
    assert.equal(count("createDocument"), 0);
    const patch = await req("PATCH", "/api/documents/doc-1", { fileUrl: "/uploads/../../../proc/self/environ", mimeType: "text/plain" });
    assert.equal(patch.status, 400, "PATCH fileUrl refused");
    assert.equal(count("updateDocument"), 0);
    const placeholder = await req("POST", "/api/deals/deal-draft/documents", { name: "2024 T2 return", category: "financials" });
    assert.equal(placeholder.status, 200, placeholder.text);
    assert.equal(placeholder.json.fileUrl, "", "a placeholder row has no file");
    assert.equal(placeholder.json.uploadedBy, "broker");
    const rename = await req("PATCH", "/api/documents/doc-1", { name: "P&L 2024" });
    assert.equal(rename.status, 200);
  });

  // ── F-B5: no cross-tenant moves ──────────────────────────────────────────
  await check('F-B5  no cross-tenant moves', async () => {
    const before = count("updateDocument");
    assert.equal((await req("PATCH", "/api/documents/doc-1", { dealId: "deal-other" })).status, 400);
    assert.equal((await req("PATCH", "/api/tasks/task-1", { dealId: "deal-other" })).status, 400);
    assert.equal(count("updateTask"), 0);
    assert.equal((await req("PATCH", "/api/integrations/int-1", { brokerId: "b2" })).status, 400);
    assert.equal((await req("PATCH", "/api/integrations/int-1", { accessToken: "x" })).status, 400);
    assert.equal(count("updateIntegration"), 0);
    assert.equal(count("updateDocument"), before);
    const ok = await req("PATCH", "/api/integrations/int-1", { config: { stageInterested: 5 } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.accessToken, undefined, "tokens never returned");
    assert.equal((await req("PATCH", "/api/tasks/task-1", { status: "completed" })).status, 200);
  });

  // ── F-B10: legacy /api/cims is gone ──────────────────────────────────────
  await check('F-B10  legacy /api/cims is gone', async () => {
    for (const [m, u] of [["GET", "/api/cims"], ["GET", "/api/cims/x"], ["PATCH", "/api/cims/x"], ["DELETE", "/api/cims/x"], ["POST", "/api/cims"]] as const) {
      const r = await req(m, u, m === "GET" || m === "DELETE" ? undefined : {});
      assert.equal(r.status, 404, `${m} ${u} is gone`);
    }
    assert.equal(count("getAllCims"), 0);
  });

  // ── F-B2: an unpublished CIM reaches no buyer ────────────────────────────
  await check('F-B2  an unpublished CIM reaches no buyer', async () => {
    const grant = await req("POST", "/api/deals/deal-draft/buyers", { buyerEmail: "b@x.invalid" });
    assert.equal(grant.status, 409);
    assert.equal(grant.json.code, "not_published");
    assert.equal(createdAccess.length, 0);

    const stampsBefore = count("updateBuyerAccess");
    const view = await req("GET", "/api/view/tok-draft");
    assert.equal(view.status, 403);
    assert.equal(view.json.code, "not_published");
    assert.ok(!view.text.includes("Harbourline"), "no business name to the buyer");
    assert.equal(count("updateBuyerAccess"), stampsBefore, "no view stamp (reminders don't start)");
    for (const [m, u, b] of [
      ["GET", "/api/view/tok-draft/buyer-profile", undefined],
      ["POST", "/api/view/tok-draft/sign-nda", { confirmProfile: true }],
      ["POST", "/api/view/tok-draft/decision", { decision: "interested" }],
      ["POST", "/api/buyer-access/tok-draft/events", { eventType: "view" }],
      ["POST", "/api/deals/deal-draft/questions", { question: "What is EBITDA?", accessToken: "tok-draft" }],
      ["GET", "/api/deals/deal-draft/questions/published?token=tok-draft", undefined],
    ] as const) {
      const r = await req(m, u, b);
      assert.equal(r.status, 403, `${m} ${u}`);
      assert.equal(r.json?.code, "not_published", `${m} ${u}`);
    }
    // A published deal passes the gate (and the grant goes through).
    const grantLive = await req("POST", "/api/deals/deal-live/buyers", { buyerEmail: "c@x.invalid" });
    assert.equal(grantLive.status, 200, grantLive.text);
    assert.equal(createdAccess.length, 1);

    // Seller approves a buyer while the CIM is unpublished → recorded, no access, no buyer email.
    const review = await req("POST", "/api/buyer-approval-review/review-tok", { action: "approve", reviewerName: "Dana" });
    assert.equal(review.status, 200, review.text);
    assert.equal(approvals.get("apr-1").status, "approved_by_seller");
    assert.equal(createdAccess.length, 1, "no access before publish");
    assert.equal(count("createBuyerUser"), 0, "no buyer account/email before publish");
    const waitingNote = notificationsOut.find((n) => n.type === "buyer_approval_seller_approved");
    assert.ok(waitingNote, "the broker is told it waits for publishing");
    assert.equal(waitingNote.recipientEmail, "owner-b1@broker.invalid", "…the deal's own broker (F-B3)");

    // Publishing grants it.
    const publish = await req("PATCH", "/api/deals/deal-draft", { isLive: true });
    assert.equal(publish.status, 200, publish.text);
    for (let i = 0; i < 50 && approvals.get("apr-1").status !== "access_granted"; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(approvals.get("apr-1").status, "access_granted", "granted at publish");
    assert.equal(createdAccess.length, 2);
    assert.equal(createdAccess[1].dealId, "deal-draft");
    const setPw = calls.createBuyerUser?.[0]?.[0] as any;
    assert.ok(setPw, "buyer account invited at publish");
    deals.set("deal-draft", { ...deals.get("deal-draft"), isLive: false });
  });

  // ── F-B3 + F-B9: buyer decision / question reach the deal's broker, escaped ──
  await check("F-B3  a buyer decision reaches the deal's own broker", async () => {
    const n0 = notificationsOut.length;
    stub("createBuyerQuestion", (q) => ({ id: "q1", ...q }));
    const origLog = console.log;
    const emailed: string[] = [];
    console.log = (...a: unknown[]) => { const s = a.join(" "); if (s.includes("[notify:email]")) emailed.push(s); origLog(...a); };
    // Decision on the live deal (no team members).
    stub("getBuyerAccessByToken", (t) => accessRows.get(t));
    const decision = await req("POST", "/api/view/tok-live/decision", { decision: "interested", nextStep: "seller_call" });
    console.log = origLog;
    assert.equal(decision.status, 200, decision.text);
    const toOwner = notificationsOut.slice(n0).filter((n) => n.recipientEmail === "owner-b1@broker.invalid");
    {
      assert.ok(toOwner.some((n) => n.type === "buyer_decision_interested"), "the deal's broker is notified of the decision");
      assert.ok(emailed.some((l) => l.includes("owner-b1@broker.invalid")), "an email was addressed to them");
    }
  });

  // ── F-B6: removing a seller-team member revokes their link ───────────────
  await check('F-B6  removing a seller-team member revokes their link', async () => {
    const r = await req("DELETE", "/api/members/m-bk");
    assert.equal(r.status, 200);
    assert.equal(r.json.linkRevoked, true);
    assert.equal(invites.get("inv-bk").status, "revoked");
    assert.equal(invites.get("inv-seller").status, "accepted", "the seller's own invite is untouched");
    const r2 = await req("DELETE", "/api/members/m-owner");
    assert.equal(r2.json.linkRevoked, false, "the seller's own (older) invite is never revoked");
    assert.equal(invites.get("inv-seller").status, "accepted");
  });

  // ── F-B7: team invite emails ─────────────────────────────────────────────
  await check('F-B7  team invite emails', async () => {
    stub("getDealMemberByEmail", () => undefined);
    let created: any = null;
    stub("createDealMember", (m) => { created = { id: "m-new", ...m }; members.set("m-new", created); return created; });
    const n0 = notificationsOut.length;
    const r = await req("POST", "/api/deals/deal-draft/members", { email: "advisor@buyer.invalid", teamType: "buyer", role: "advisor" });
    assert.equal(r.status, 200, r.text);
    const note = notificationsOut.slice(n0).find((n) => n.type === "invite");
    assert.ok(note, "invite recorded");
    assert.ok(!/Harbourline/.test(note.body) && !/Harbourline/.test(note.title), "blind: codename only");
    assert.equal(note.actionUrl, null, "no login link");
    members.delete("m-new");
    const n1 = notificationsOut.length;
    const rb = await req("POST", "/api/deals/deal-draft/members", { email: "assoc@broker.invalid", teamType: "broker", role: "associate" });
    assert.equal(rb.status, 200, rb.text);
    const nb = notificationsOut.slice(n1).find((n) => n.type === "invite");
    assert.ok(!/get started/i.test(nb.body), nb.body);
    assert.equal(nb.actionUrl, null);
  });

  // ── F-B11: junk webhook tokens never load every deal ─────────────────────
  await check('F-B11  junk webhook tokens never load every deal', async () => {
    const before = count("getAllDeals");
    for (let i = 0; i < 20; i++) {
      const r = await req("POST", `/api/calls/recall/webhook/?token=x${i}`, { event: "transcript.data" });
      assert.equal(r.status, 401);
    }
    assert.equal(count("getAllDeals"), before, "no full-table read");
  });

  // ── Sanity: another broker can't touch b1's rows ─────────────────────────
  await check("Sanity  another broker can't touch b1's rows", async () => {
    sessionBroker = "b2";
    assert.equal((await req("PATCH", "/api/documents/doc-1", { name: "x" })).status, 404);
    assert.equal((await req("PATCH", "/api/integrations/int-1", { config: {} })).status, 404);
  });

  if (failures.length) {
    console.error(`f-broker-routes: ${failures.length} FAILED: ${failures.join(" | ")}`);
    process.exitCode = 1;
  } else console.log("f-broker-routes: ok");
} finally {
  server.close();
  fs.rmSync(process.env.UPLOADS_DIR!, { recursive: true, force: true });
}
process.exit(process.exitCode ?? 0);
