/**
 * Buyer-facing flows (stream "buyers", findings F1–F11), exercised through
 * the real Express routes with an in-memory storage and a captured email
 * provider. No database, no AI, no email leaves the process.
 *
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/unit/f-buyers-routes.test.ts
 */
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";

process.env.RESEND_API_KEY = "test-resend-key"; // sends are captured below, never delivered
process.env.APP_URL = "https://app.test";
process.env.DISABLE_SCHEDULERS = "1";

// ── Captured email provider ────────────────────────────────────────────
type Sent = { from: string; to: string[]; cc?: string[]; reply_to?: string[]; subject: string; html: string };
const sent: Sent[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  const u = String(url);
  if (u.startsWith("https://api.resend.com/")) {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ id: "em" }), { status: 200 });
  }
  if (u.startsWith("http://127.0.0.1:")) return realFetch(url, init);
  throw new Error(`test: blocked outbound fetch to ${u}`);
}) as any;

// ── In-memory storage ──────────────────────────────────────────────────
const now = Date.now();
const DAY = 86400000;
let seq = 0;
const id = (p: string) => `${p}${++seq}`;
const T: Record<string, any[]> = {
  users: [], deals: [], access: [], buyers: [], members: [], invites: [], notifications: [],
  approvals: [], questions: [], sections: [], events: [], contacts: [], outreach: [],
};
const find = (t: string, pred: (r: any) => boolean) => T[t].find(pred);
/** Like the database: every read is a fresh copy, never the stored row itself. */
const read = (t: string, pred: (r: any) => boolean) => { const r = find(t, pred); return r ? { ...r } : undefined; };
const upd = (t: string, rid: string, patch: any) => {
  const r = find(t, (x) => x.id === rid);
  if (!r) return undefined;
  Object.assign(r, patch);
  return r;
};

async function main() {
  const { storage } = await import("../../server/storage");
  const { db } = await import("../../server/db");
  const { registerRoutes } = await import("../../server/routes");
  const { notify } = await import("../../server/notifications/service");
  const { processReminderForAccess } = await import("../../server/reminders/decision-reminders");
  // Background AI (criteria extraction) must never be reached.
  delete process.env.ANTHROPIC_API_KEY;

  const S = storage as any;
  Object.assign(S, {
    getUser: async (uid: string) => find("users", (u) => u.id === uid),
    getUserByEmail: async (e: string) => find("users", (u) => u.email?.toLowerCase() === e.toLowerCase()),
    getDeal: async (did: string) => find("deals", (d) => d.id === did),
    getBrandingByBroker: async () => undefined,
    getIntegrationsByBroker: async () => [],
    getDealMembers: async (did: string) => T.members.filter((m) => m.dealId === did),
    getDealMemberByEmail: async (did: string, e: string) => find("members", (m) => m.dealId === did && m.email === e),
    createDealMember: async (row: any) => { const r = { id: id("M"), ...row }; T.members.push(r); return r; },
    getSellerInvitesByDealId: async (did: string) => T.invites.filter((i) => i.dealId === did),
    createNotification: async (row: any) => { const r = { id: id("N"), ...row }; T.notifications.push(r); return r; },
    getBuyerAccessByToken: async (tok: string) => read("access", (a) => a.accessToken === tok),
    getBuyerAccess: async (aid: string) => read("access", (a) => a.id === aid),
    getBuyerAccessByDeal: async (did: string) => T.access.filter((a) => a.dealId === did),
    getBuyerAccessByBuyerUser: async (bid: string) => T.access.filter((a) => a.buyerUserId === bid),
    createBuyerAccess: async (row: any) => { const r = { id: id("A"), decision: "under_review", viewCount: 0, ndaSigned: false, ...row }; T.access.push(r); return r; },
    updateBuyerAccess: async (aid: string, patch: any) => { const r = upd("access", aid, patch); return r ? { ...r } : r; },
    // Like the database: records a signature only on a link that hasn't signed.
    recordBuyerNdaSignature: async (aid: string, patch: any) => {
      const a = find("access", (x) => x.id === aid);
      if (!a || a.ndaSigned) return undefined;
      const r = upd("access", aid, { ...patch, ndaSigned: true });
      return r ? { ...r } : r;
    },
    getBuyerUser: async (bid: string) => read("buyers", (b) => b.id === bid),
    getBuyerUserByEmail: async (e: string) => read("buyers", (b) => b.email === e.toLowerCase().trim()),
    createBuyerUser: async (row: any) => { const r = { id: id("U"), ...row }; T.buyers.push(r); return r; },
    updateBuyerUser: async (bid: string, patch: any) => { const r = upd("buyers", bid, patch); return r ? { ...r } : r; },
    upsertBrokerBuyerContact: async (row: any) => { T.contacts.push(row); return row; },
    getBrokerBuyerContact: async () => undefined,
    createAnalyticsEvent: async (row: any) => { const r = { id: id("E"), ...row }; T.events.push(r); return r; },
    getCimSectionsByDeal: async (did: string) => T.sections.filter((s) => s.dealId === did),
    getCimSectionOverrides: async () => [],
    getQuestionsByDeal: async (did: string) => T.questions.filter((q) => q.dealId === did),
    getBuyerQuestion: async (qid: string) => read("questions", (q) => q.id === qid),
    updateBuyerQuestion: async (qid: string, patch: any) => { const r = upd("questions", qid, patch); return r ? { ...r } : r; },
    getQuestionsByApprovalToken: async (tok: string) => read("questions", (q) => q.sellerApprovalToken === tok),
    getBuyerApprovalRequestByToken: async (tok: string) => read("approvals", (r) => r.sellerReviewToken === tok),
    updateBuyerApprovalRequest: async (rid: string, patch: any) => upd("approvals", rid, patch),
    createDealOutreach: async (row: any) => { const r = { id: id("O"), ...row }; T.outreach.push(r); return r; },
  });
  // The few direct db reads on these paths: deal media (none) and the
  // broker's buyer list (every buyer in the store).
  (db as any).select = () => {
    let table: any = null;
    const chain: any = {
      from(t: any) { table = t; return chain; },
      where() { return chain; },
      then(res: any, rej: any) {
        const name = table?.[Symbol.for("drizzle:Name")];
        const rows = name === "buyer_users" ? T.buyers.map((b) => ({ id: b.id })) : [];
        return Promise.resolve(rows).then(res, rej);
      },
    };
    return chain;
  };

  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.session = {
      brokerId: req.get("x-test-broker") || undefined,
      buyerId: req.get("x-test-buyer") || undefined,
      save: (cb: any) => cb?.(), regenerate: (cb: any) => cb?.(), destroy: (cb: any) => cb?.(),
    };
    next();
  });
  const server = await registerRoutes(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await realFetch(base + path, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* text */ }
    return { status: r.status, json, text };
  };
  const settle = () => new Promise((r) => setTimeout(r, 50));
  const broker = { "x-test-broker": "B1" };

  // ── Fixtures ─────────────────────────────────────────────────────────
  T.users.push({ id: "B1", role: "broker", username: "morgan", name: "Morgan Ellis", email: "morgan@brokerage.invalid", settings: {} });
  T.users.push({ id: "B2", role: "broker", username: "noemail", name: "No Email", email: null, settings: {} });
  const deal = {
    id: "D1", brokerId: "B1", businessName: "Harbour Point Dental Ltd", blindCodename: "Project Lighthouse",
    // Published: every buyer path is closed until then (shared/buyer-publish-gate.ts).
    isLive: true,
    industry: "Dental", ndaRequired: true, extractedInfo: { companyName: "Harbour Point Dental" }, designTemplateId: null,
  };
  const dealNoCode = { ...deal, id: "D2", businessName: "Seaside Plumbing Inc", blindCodename: null };
  T.deals.push(deal, dealNoCode);
  const mkAccess = (o: any = {}) => {
    const a = {
      id: id("A"), dealId: "D1", accessToken: id("tok-"), buyerEmail: "sam@buyer.invalid", buyerName: "Sam Rivera",
      buyerCompany: null, accessLevel: "full", ndaSigned: false, decision: "under_review", viewCount: 0,
      firstViewedAt: null, lastAccessedAt: null, revokedAt: null, expiresAt: new Date(now + 20 * DAY),
      reminderStage: "none", buyerUserId: null, ndaProfile: null, ...o,
    };
    T.access.push(a);
    return a;
  };
  const brokerEmails = () => sent.filter((m) => m.to.includes("morgan@brokerage.invalid"));
  const reset = () => { sent.length = 0; };
  const profile = {
    buyerType: "individual", name: "Sam Rivera", phone: "555-0100", company: null, companyWebsite: null, title: null,
    background: "Ran a dental lab for ten years.", lookingFor: "Dental practices in Ontario", priceMin: 1000000, priceMax: 3000000,
    funding: "bank_loan", proofOfFunds: "yes", timeline: "3_6", operateSelf: "yes", fitReason: null, dealRole: null,
    checkSize: null, appealedTo: null, bestTimeToContact: null, financialKind: null,
  };

  // ════ F1 — broker-routed events reach the owning broker ═══════════════
  reset();
  let r1 = await notify("D1", "buyer_decision_interested", { title: "Sam is interested", body: "x" });
  assert.equal(r1.recipients, 1, "F1: the owning broker is the fallback recipient");
  assert.equal(r1.via, "deal_owner");
  assert.equal(brokerEmails().length, 1, "F1: one email to the owning broker");
  const n1 = T.notifications.at(-1);
  assert.equal(n1.recipientId, "B1");
  assert.equal(n1.metadata.fallbackRecipient, "deal_owner");
  assert.equal(n1.emailSent, true);
  // Muted by the broker's own preference → recorded, not emailed.
  reset();
  T.users[0].settings = { notifications: { buyerDecisions: false } };
  r1 = await notify("D1", "buyer_decision_not_interested", { title: "t", body: "b" });
  assert.equal(brokerEmails().length, 0, "F1: preference respected");
  assert.equal(T.notifications.at(-1).metadata.emailMutedByPreference, true);
  T.users[0].settings = {};
  // A broker team member present → the member is emailed, and the deal's
  // owner too (they aren't on the team themselves — notifications/service.ts
  // ownerGetsEvent); once each.
  reset();
  T.members.push({ id: "M-lead", dealId: "D1", teamType: "broker", role: "lead", email: "lead@team.invalid", inviteStatus: "accepted", emailNotifications: true });
  r1 = await notify("D1", "buyer_question", { title: "q", body: "b" });
  assert.equal(r1.via, "members");
  assert.deepEqual(sent.map((m) => m.to[0]).sort(), ["lead@team.invalid", "morgan@brokerage.invalid"], "F1: the member and the owner, once each");
  // The owner on the team themselves: that row governs — one email, not two.
  reset();
  T.members.push({ id: "M-own", dealId: "D1", teamType: "broker", role: "lead", email: "Morgan@Brokerage.invalid", inviteStatus: "accepted", emailNotifications: true });
  await notify("D1", "buyer_question", { title: "q", body: "b" });
  assert.equal(brokerEmails().length + sent.filter((m) => m.to.includes("Morgan@Brokerage.invalid")).length, 1, "F1: an owner on the team gets one email");
  T.members.length = 0;
  // Broker + seller routed (lapse): seller invite AND the owning broker.
  reset();
  T.invites.push({ id: "I1", dealId: "D1", sellerEmail: "owner@seller.invalid", sellerName: "Pat", status: "sent", expiresAt: null });
  r1 = await notify("D1", "buyer_decision_lapsed", { title: "lapsed", body: "b" });
  assert.deepEqual(sent.map((m) => m.to[0]).sort(), ["morgan@brokerage.invalid", "owner@seller.invalid"], "F1: lapse reaches the seller invite and the owner");
  T.invites.length = 0;
  // An owning broker with no email: nothing to send, nothing recorded.
  reset();
  T.deals.push({ ...deal, id: "D3", brokerId: "B2" });
  r1 = await notify("D3", "buyer_approval_requested", { title: "t", body: "b" });
  assert.equal(r1.recipients, 0);
  assert.equal(sent.length, 0);

  // ════ F7 + F1 through the real decision route ═════════════════════════
  reset();
  const evil = mkAccess({ buyerName: `<a href="https://evil.example/login">Re-verify your Cimple session</a>`, ndaSigned: true, firstViewedAt: new Date(now - DAY) });
  let res = await call("POST", `/api/view/${evil.accessToken}/decision`, { decision: "interested", nextStep: "management_meeting", reason: "<img src=x>" });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  await settle();
  const decisionMail = brokerEmails()[0];
  assert.ok(decisionMail, "F1: the broker hears about the buyer's decision");
  assert.ok(!decisionMail.html.includes(`<a href="https://evil.example`), "F7: buyer-typed markup is not live in the email");
  assert.ok(decisionMail.html.includes("&lt;a href=&quot;https://evil.example/login&quot;&gt;"), "F7: shown as text");
  assert.ok(!decisionMail.html.includes("<img src=x>"), "F7: comment escaped");

  // Lapse email to the sell side escapes the buyer's typed name too.
  reset();
  const lapsing = mkAccess({ buyerName: `<b onmouseover=x>Eve</b>`, ndaSigned: true, firstViewedAt: new Date(now - 9 * DAY), reminderStage: "warning_sent", lastReminderAt: new Date(now - 3 * DAY) });
  assert.equal(await processReminderForAccess(lapsing as any, now, "https://app.test"), "lapse");
  const lapseMail = brokerEmails()[0];
  assert.ok(lapseMail && !lapseMail.html.includes("<b onmouseover"), "F7: lapse email escapes the buyer's name");

  // ════ F6 — the NDA gate is not a "view" ════════════════════════════════
  reset();
  const gated = mkAccess();
  res = await call("GET", `/api/view/${gated.accessToken}`);
  assert.equal(res.status, 200);
  assert.equal(res.json.ndaGate, true);
  assert.equal(gated.firstViewedAt, null, "F6: the gate does not start the reminder clock");
  assert.equal(gated.viewCount, 0, "F6: the gate is not counted as a view");
  assert.ok(gated.lastAccessedAt, "F6: the open is still recorded");
  // A row stamped at the gate before the fix: never reminded while unsigned.
  const oldGated = mkAccess({ firstViewedAt: new Date(now - 4 * DAY) });
  assert.equal(await processReminderForAccess(oldGated as any, now, "https://app.test"), "none", "F6: unsigned NDA → no reminder");
  assert.equal(sent.filter((m) => m.to.includes("sam@buyer.invalid")).length, 0);
  // Content served (LOI buyer, named CIM, NDA signed) → counted once.
  // (Approved: on a live CIM only approved content reaches buyers — shared/cim-published.ts.)
  T.sections.push({ id: "S1", dealId: "D1", sectionKey: "executiveSummary", sectionTitle: "Summary", order: 0, layoutType: "prose_highlight", layoutData: {}, aiDraftContent: "A practice.", brokerEditedContent: null, isVisible: true, brokerApproved: true });
  const served = mkAccess({ accessLevel: "loi", ndaSigned: true });
  res = await call("GET", `/api/view/${served.accessToken}`);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.sections.length, 1);
  assert.ok(served.firstViewedAt, "F6: first served view starts the clock");
  assert.equal(served.viewCount, 1);
  res = await call("GET", `/api/view/${served.accessToken}`);
  assert.equal(served.viewCount, 1, "same session is one view");

  // ════ F10 — the brokerage's NDA, typed signature, stored record ═══════
  reset();
  const signer = mkAccess();
  res = await call("GET", `/api/view/${signer.accessToken}/buyer-profile`);
  assert.equal(res.status, 200);
  const nda = res.json.nda;
  assert.ok(nda?.text?.includes("Project Lighthouse"), "F10: standard terms name the deal by its codename");
  assert.ok(!/Harbour Point/i.test(nda.text), "F10: never the business name for a blind buyer");
  assert.match(nda.hash, /^sha256:[0-9a-f]{64}$/);
  res = await call("POST", `/api/view/${signer.accessToken}/sign-nda`, { profile, termsHash: nda.hash });
  assert.equal(res.status, 400, "F10: a typed name is required");
  assert.equal(res.json.code, "signer_name_required");
  res = await call("POST", `/api/view/${signer.accessToken}/sign-nda`, { profile, signerName: "Sam Rivera", termsHash: "sha256:stale" });
  assert.equal(res.status, 409, "F10: signing text that wasn't shown is refused");
  assert.equal(signer.ndaSigned, false);
  res = await call("POST", `/api/view/${signer.accessToken}/sign-nda`, { profile, signerName: "  Sam   Rivera ", termsHash: nda.hash });
  assert.equal(res.status, 200, res.text);
  assert.equal(signer.ndaSigned, true);
  assert.equal(signer.ndaVersion, nda.hash);
  assert.equal(signer.ndaProfile.signature.signerName, "Sam Rivera");
  assert.equal(signer.ndaProfile.signature.termsText, nda.text);
  assert.equal(signer.ndaProfile.signature.termsHash, nda.hash);
  assert.equal(signer.ndaProfile.lookingFor, profile.lookingFor, "F10: the NDA answers are kept alongside");
  res = await call("GET", `/api/view/${signer.accessToken}/nda.txt`);
  assert.equal(res.status, 200);
  assert.ok(res.text.includes("Accepted electronically by: Sam Rivera") && res.text.includes(nda.hash), "F10: the buyer's copy");
  // The brokerage's own terms, then a per-deal override, are what buyers sign.
  T.users[0].settings = { buyerNdaTerms: "BROKERAGE TERMS for {opportunity} with {firm}. No contact with staff. Governed by Ontario law." };
  res = await call("GET", `/api/view/${mkAccess().accessToken}/buyer-profile`);
  assert.ok(res.json.nda.text.startsWith("BROKERAGE TERMS for Project Lighthouse"), "F10: brokerage terms");
  T.users[0].settings = { ...T.users[0].settings, buyerNdaDealTerms: { D1: "DEAL TERMS for {opportunity}." } };
  res = await call("GET", `/api/view/${mkAccess().accessToken}/buyer-profile`);
  assert.equal(res.json.nda.text, "DEAL TERMS for Project Lighthouse.", "F10: per-deal override");
  res = await call("GET", "/api/deals/D1/buyer-nda", undefined, broker);
  assert.equal(res.json.source, "deal");
  T.users[0].settings = {};

  // ════ F4 — an unverified self-signup never captures the link ══════════
  reset();
  const attacker = { id: "U-att", email: "target@pe-firm.invalid", passwordHash: "hash", emailVerified: false, name: "Attacker", source: "self_signup", buyerCriteria: {} };
  T.buyers.push(attacker);
  const victim = mkAccess({ buyerEmail: "target@pe-firm.invalid", buyerName: "Real Buyer" });
  res = await call("GET", `/api/view/${victim.accessToken}/buyer-profile`);
  assert.equal(res.json.onFile.name, "Real Buyer", "F4: the attacker's profile never prefills the form");
  const tNda = res.json.nda;
  res = await call("POST", `/api/view/${victim.accessToken}/sign-nda`, { profile: { ...profile, name: "Real Buyer" }, signerName: "Real Buyer", termsHash: tNda.hash });
  assert.equal(res.status, 200, res.text);
  assert.equal(victim.buyerUserId ?? null, null, "F4: the access is not linked to the unverified account");
  assert.equal(attacker.name, "Attacker", "F4: the buyer's NDA answers are not written onto it");
  assert.equal(victim.ndaProfile.name, "Real Buyer", "F4: the answers stay on the access row");
  // A link wrongly linked before the fix: the dashboard shows nothing.
  mkAccess({ buyerEmail: "target@pe-firm.invalid", buyerUserId: "U-att" });
  res = await call("GET", "/api/buyer-auth/dashboard", undefined, { "x-test-buyer": "U-att" });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.deals.length, 0, "F4: an unverified account's dashboard lists no deals (and no tokens)");
  assert.equal(res.json.emailUnverified, true);
  // A verified account is linked as before.
  T.buyers.push({ id: "U-ok", email: "real@buyer.invalid", passwordHash: "h", emailVerified: true, name: "Real", buyerCriteria: {} });
  const good = mkAccess({ buyerEmail: "real@buyer.invalid" });
  res = await call("GET", `/api/view/${good.accessToken}/buyer-profile`);
  await call("POST", `/api/view/${good.accessToken}/sign-nda`, { profile: { ...profile, name: "Real" }, signerName: "Real Person", termsHash: res.json.nda.hash });
  assert.equal(good.buyerUserId, "U-ok", "F4: verified accounts are still linked");

  // ════ F2 / F4 / F8 — seller approval emails ═══════════════════════════
  const mkApproval = (o: any = {}) => {
    const r = {
      id: id("R"), dealId: "D1", sellerReviewToken: id("rev-"), status: "pending_seller_review",
      buyerName: "Casey Buyer", buyerEmail: "casey@new.invalid", buyerPhone: null, buyerCompany: "Casey Capital",
      buyerTitle: null, linkedinUrl: null, category: "search_fund", riskLevel: "low", partners: [], otherProfileUrls: [],
      crmSource: "pipedrive", crmRecordId: "pd-991", crmRawData: { person: { name: "Casey" }, notes: [{ content: "lowballed us on the Smith listing" }] },
      brokerReviewNotes: "internal: slow payer", ndaNotes: "nda on file", ...o,
    };
    T.approvals.push(r);
    return r;
  };
  // F3 — the seller's review page gets only what it renders.
  const ap0 = mkApproval();
  res = await call("GET", `/api/buyer-approval-review/${ap0.sellerReviewToken}`);
  assert.equal(res.status, 200);
  const payloadText = JSON.stringify(res.json.request);
  for (const leak of ["crmRawData", "crmRecordId", "pd-991", "lowballed", "brokerReviewNotes", "slow payer", "sellerReviewToken", ap0.sellerReviewToken, "ndaNotes"]) {
    assert.ok(!payloadText.includes(leak), `F3: seller review payload must not carry ${leak}`);
  }
  assert.equal(res.json.request.buyerName, "Casey Buyer");
  assert.equal(res.json.request.category, "search_fund");

  // New buyer: set-password invitation + approval email, both blind.
  reset();
  res = await call("POST", `/api/buyer-approval-review/${ap0.sellerReviewToken}`, { action: "approve", reviewerName: "Pat" });
  assert.equal(res.status, 200, res.text);
  const toCasey = sent.filter((m) => m.to.includes("casey@new.invalid"));
  assert.equal(toCasey.length, 2, "set-password + approval email");
  for (const m of toCasey) {
    assert.ok(!/Harbour Point/i.test(m.subject + m.html), `F2: no business name to a blind buyer (${m.subject})`);
    assert.ok((m.subject + m.html).includes("Project Lighthouse"), "F2: the codename instead");
  }
  const grant = T.access.at(-1);
  assert.ok(toCasey.every((m) => m.html.includes(`/view/${grant.accessToken}`)), "F8: both emails carry the view link");
  assert.ok(toCasey.some((m) => m.html.includes("/buyer/set-password/")));
  // No broker team: the owner isn't CC'd — they get the "granted access"
  // notice instead (one email, honouring their notification settings).
  assert.ok(!toCasey.some((m) => m.cc?.length), "no CC when there's no broker team");
  assert.equal(brokerEmails().length, 1, "the owning broker gets one email about the grant");

  // No codename yet → neutral wording, still no name.
  reset();
  const apNo = mkApproval({ dealId: "D2", buyerEmail: "drew@new.invalid" });
  res = await call("POST", `/api/buyer-approval-review/${apNo.sellerReviewToken}`, { action: "approve" });
  assert.equal(res.status, 200, res.text);
  for (const m of sent.filter((x) => x.to.includes("drew@new.invalid"))) {
    assert.ok(!/Seaside Plumbing/i.test(m.subject + m.html), "F2: neutral wording without a codename");
  }

  // F8: an existing passwordless (CRM-imported) account gets a set-password link.
  reset();
  T.buyers.push({ id: "U-crm", email: "crm@buyer.invalid", passwordHash: null, emailVerified: false, name: "Crm Person", source: "crm_imported", buyerCriteria: {} });
  const apCrm = mkApproval({ buyerEmail: "crm@buyer.invalid" });
  res = await call("POST", `/api/buyer-approval-review/${apCrm.sellerReviewToken}`, { action: "approve" });
  assert.equal(res.status, 200, res.text);
  const crmMails = sent.filter((m) => m.to.includes("crm@buyer.invalid"));
  assert.ok(crmMails.some((m) => m.html.includes("/buyer/set-password/")), "F8: a set-password link, not 'sign in'");
  assert.ok(crmMails.every((m) => !/Sign in to your Cimple account/i.test(m.html)));
  const crmUser = find("buyers", (b) => b.id === "U-crm");
  assert.ok(crmUser.resetToken && !crmMails.some((m) => m.html.includes(crmUser.resetToken)), "F8: the token is stored hashed");
  assert.equal(T.access.at(-1).buyerUserId, "U-crm", "a passwordless account is safe to link");

  // F4: the approval flow never links an unverified self-signup account.
  reset();
  const apAtt = mkApproval({ buyerEmail: "target@pe-firm.invalid" });
  res = await call("POST", `/api/buyer-approval-review/${apAtt.sellerReviewToken}`, { action: "approve" });
  assert.equal(res.status, 200, res.text);
  const attGrant = T.access.at(-1);
  assert.equal(attGrant.buyerUserId, null, "F4: approval leaves the access unlinked");
  const attMail = sent.find((m) => m.to.includes("target@pe-firm.invalid"));
  assert.ok(attMail?.html.includes(`/view/${attGrant.accessToken}`), "the real buyer still gets their link by email");

  // F2: buyer-team member invite (default "full" = blind).
  reset();
  res = await call("POST", "/api/deals/D1/members", { email: "analyst@buyerco.invalid", name: "Ana", teamType: "buyer", role: "analyst" }, broker);
  assert.equal(res.status, 200, res.text);
  const teamMail = sent.find((m) => m.to.includes("analyst@buyerco.invalid"));
  assert.ok(teamMail, "invite sent");
  assert.ok(!/Harbour Point/i.test(teamMail!.subject + teamMail!.html), "F2: buyer-team invite never names the business");
  assert.ok(teamMail!.html.includes("Project Lighthouse"));

  // ════ F5 — outreach replies reach the broker ══════════════════════════
  reset();
  T.buyers.push({ id: "U-out", email: "lead@acquirer.invalid", name: "Lee", passwordHash: null, emailVerified: false, buyerCriteria: {} });
  res = await call("POST", "/api/deals/D1/send-outreach", { outreach: [{ buyerUserId: "U-out", subject: "A dental practice", body: "Hi Lee,\n\nJust reply." }] }, broker);
  assert.equal(res.status, 200, res.text);
  const out = sent.find((m) => m.to.includes("lead@acquirer.invalid"))!;
  assert.deepEqual(out.reply_to, ["morgan@brokerage.invalid"], "F5: Reply-To is the broker");
  assert.ok(out.from.startsWith("Morgan Ellis via Cimple <"), "F5: sent in the broker's name");
  // A broker with no email: refused, nothing sent.
  reset();
  T.deals.push({ ...deal, id: "D4", brokerId: "B2" });
  res = await call("POST", "/api/deals/D4/send-outreach", { outreach: [{ buyerUserId: "U-out", subject: "s", body: "b" }] }, { "x-test-broker": "B2" });
  assert.equal(res.status, 400);
  assert.equal(res.json.code, "no_reply_to");
  assert.equal(sent.length, 0);

  // ════ F9 — the buyer hears their question was answered ════════════════
  reset();
  const asker = mkAccess({ buyerEmail: "asker@buyer.invalid", ndaSigned: true });
  const q = { id: "Q1", dealId: "D1", buyerAccessId: asker.id, question: "Is the landlord open to a lease extension?", status: "pending_broker", publishedAnswer: null, aiAnswer: null, brokerDraft: null };
  T.questions.push(q);
  res = await call("PATCH", "/api/questions/Q1", { status: "published", publishedAnswer: "Yes, 5 more years.", isPublished: false }, broker);
  assert.equal(res.status, 200, res.text);
  await settle();
  let notice = sent.filter((m) => m.to.includes("asker@buyer.invalid"));
  assert.equal(notice.length, 1, "F9: one notice to the asker");
  assert.ok(notice[0].html.includes(`/view/${asker.accessToken}`));
  assert.ok(!/Harbour Point/i.test(notice[0].subject + notice[0].html), "F9: blind naming");
  assert.ok(!notice[0].html.includes("5 more years"), "F9: the answer itself stays in the view room");
  res = await call("PATCH", "/api/questions/Q1", { publishedAnswer: "Yes, five more years." }, broker);
  await settle();
  assert.equal(sent.filter((m) => m.to.includes("asker@buyer.invalid")).length, 1, "F9: sent once");
  // Seller approval path.
  reset();
  T.questions.push({ id: "Q2", dealId: "D1", buyerAccessId: asker.id, question: "Why is the owner selling?", status: "pending_seller", sellerApprovalToken: "apv-1", brokerDraft: "Retirement.", aiAnswer: null, publishedAnswer: null });
  res = await call("POST", "/api/approve/apv-1", { approved: true });
  assert.equal(res.status, 200, res.text);
  await settle();
  notice = sent.filter((m) => m.to.includes("asker@buyer.invalid"));
  assert.equal(notice.length, 1, "F9: seller approval notifies the asker");

  // ════ F11 — expired links do nothing ══════════════════════════════════
  reset();
  const expired = mkAccess({ expiresAt: new Date(now - DAY), ndaSigned: true, ndaProfile: { signature: { signerName: "X", signedAt: new Date().toISOString(), termsText: "t", termsHash: "h" } } });
  res = await call("POST", `/api/view/${expired.accessToken}/decision`, { decision: "not_interested" });
  assert.equal(res.status, 403, "F11: decision refused");
  assert.equal(expired.decision, "under_review");
  res = await call("POST", `/api/view/${expired.accessToken}/sign-nda`, { confirmProfile: true, signerName: "X Y", termsHash: "h" });
  assert.equal(res.status, 403, "F11: NDA refused");
  res = await call("GET", `/api/view/${expired.accessToken}/buyer-profile`);
  assert.equal(res.status, 403, "F11: profile refused");
  res = await call("POST", `/api/buyer-access/${expired.accessToken}/events`, { eventType: "view" });
  assert.equal(res.status, 403, "F11: analytics refused");
  res = await call("POST", `/api/deals/D1/analytics/batch`, { accessToken: expired.accessToken, events: [{ eventType: "scroll" }] });
  assert.equal(res.status, 401, "F11: batch analytics refused");
  res = await call("GET", `/api/view/${expired.accessToken}/nda.txt`);
  assert.equal(res.status, 403);
  const revoked = mkAccess({ revokedAt: new Date() });
  res = await call("POST", `/api/view/${revoked.accessToken}/decision`, { decision: "interested" });
  assert.equal(res.status, 403);
  await settle();
  assert.equal(sent.length, 0, "F11: no broker email from a dead link");

  // ═══════════════════════════ Round 2 ═══════════════════════════════════
  const { hashResetToken } = await import("../../server/buyer-auth/reset-token");
  Object.assign(S, {
    getBuyerUserByResetToken: async (tok: string) => read("buyers", (b) => b.resetToken === hashResetToken(tok) || b.resetToken === tok),
    // Same rule as the SQL: only a verified account, only unlinked rows, email match.
    linkBuyerAccessToVerifiedBuyer: async (bid: string) => {
      const b = find("buyers", (x) => x.id === bid);
      if (!b?.emailVerified) return 0;
      let n = 0;
      for (const a of T.access) {
        if (a.buyerUserId == null && String(a.buyerEmail).toLowerCase() === String(b.email).toLowerCase()) { a.buyerUserId = b.id; n++; }
      }
      return n;
    },
  });

  // ════ R2-F5 — From line never carries the login username ══════════════
  reset();
  T.users.push({ id: "B3", role: "broker", username: "morgan_login", name: "  ", email: "desk@brassline.invalid", settings: {} });
  T.users.push({ id: "B5", role: "broker", username: "solo_login", name: null, email: "solo@broker.invalid", settings: {} });
  T.deals.push({ ...deal, id: "D5", brokerId: "B3" }, { ...deal, id: "D6", brokerId: "B5" });
  const realBranding = S.getBrandingByBroker;
  S.getBrandingByBroker = async (bid: string) => (bid === "B3" ? { companyName: "Brassline Advisory Partners" } : undefined);
  res = await call("POST", "/api/deals/D5/send-outreach", { outreach: [{ buyerUserId: "U-out", subject: "s", body: "Hi,\n\nJust reply." }] }, { "x-test-broker": "B3" });
  assert.equal(res.status, 200, res.text);
  let outMail = sent.find((m) => m.to.includes("lead@acquirer.invalid"))!;
  assert.ok(outMail.from.startsWith("Brassline Advisory Partners via Cimple <"), `R2-F5: no display name → the brokerage (${outMail.from})`);
  assert.ok(!/morgan_login/.test(JSON.stringify(outMail)), "R2-F5: the username appears nowhere in the email");
  // Neither a display name nor a brokerage → the plain Cimple sender.
  reset();
  res = await call("POST", "/api/deals/D6/send-outreach", { outreach: [{ buyerUserId: "U-out", subject: "s", body: "b" }] }, { "x-test-broker": "B5" });
  assert.equal(res.status, 200, res.text);
  outMail = sent.find((m) => m.to.includes("lead@acquirer.invalid"))!;
  assert.equal(outMail.from, "Cimple <notifications@cimple.ca>", "R2-F5: default sender");
  assert.ok(!/solo_login/.test(JSON.stringify(outMail)));
  // The buyer-profile "email this buyer" send follows the same rule.
  const realSelect = (db as any).select;
  (db as any).select = () => {
    const chain: any = { from() { return chain; }, where() { return chain; }, limit() { return chain; },
      then(res2: any, rej: any) { return Promise.resolve([{ id: "U-out" }]).then(res2, rej); } };
    return chain;
  };
  const realInsert = (db as any).insert;
  (db as any).insert = () => ({ values: (row: any) => ({ returning: async () => [{ id: "BE1", ...row }] }) });
  reset();
  res = await call("POST", "/api/broker/buyers/U-out/email", { subject: "Hello", body: "A note." }, { "x-test-broker": "B3" });
  assert.equal(res.status, 200, res.text);
  outMail = sent.find((m) => m.to.includes("lead@acquirer.invalid"))!;
  assert.ok(outMail.from.startsWith("Brassline Advisory Partners via Cimple <"), `R2-F5: buyer-profile email From (${outMail.from})`);
  assert.ok(!/morgan_login/.test(JSON.stringify(outMail)), "R2-F5: buyer-profile email never shows the username");
  (db as any).select = realSelect;
  (db as any).insert = realInsert;
  S.getBrandingByBroker = realBranding;
  const { outreachFromName, brokerDisplayName } = await import("../../server/buyers/outreach-reply");
  assert.equal(outreachFromName({ name: "Morgan Ellis" }, "Brassline"), "Morgan Ellis via Cimple");
  assert.equal(outreachFromName({ name: "" }, "Brassline"), "Brassline via Cimple");
  assert.equal(outreachFromName({ name: null }, " "), null);
  assert.equal(brokerDisplayName({ name: "   " }), null);

  // ════ R2 — demo deals are never automated by the reminder pipeline ═══
  reset();
  T.deals.push({ ...deal, id: "D-demo", demoKey: "pacific-coast-logistics" });
  const demoRow = mkAccess({ dealId: "D-demo", ndaSigned: true, ndaSignedAt: new Date(now - 20 * DAY), firstViewedAt: new Date(now - 9 * DAY), reminderStage: "warning_sent", lastReminderAt: new Date(now - 3 * DAY), decision: null });
  assert.equal(await processReminderForAccess(demoRow as any, now, "https://app.test"), "none", "R2: a demo deal's buyer is not lapsed");
  assert.equal(demoRow.decision, null, "R2: the showcase row is untouched");
  assert.equal(sent.length, 0, "R2: nobody is emailed about a fictional buyer");
  // The same row on a real deal would lapse (the pipeline itself still works).
  const realRow = mkAccess({ ndaSigned: true, ndaSignedAt: new Date(now - 20 * DAY), firstViewedAt: new Date(now - 9 * DAY), reminderStage: "warning_sent", lastReminderAt: new Date(now - 3 * DAY), decision: null });
  assert.equal(await processReminderForAccess(realRow as any, now, "https://app.test"), "lapse");

  // ════ R2 — a decision needs the NDA first ═════════════════════════════
  reset();
  const unsignedDecider = mkAccess({ buyerEmail: "early@buyer.invalid" });
  res = await call("POST", `/api/view/${unsignedDecider.accessToken}/decision`, { decision: "interested" });
  assert.equal(res.status, 403, "R2: no decision before a required NDA");
  assert.equal(res.json.code, "nda_required");
  assert.equal(unsignedDecider.decision, "under_review", "R2: nothing recorded");
  res = await call("POST", `/api/view/${unsignedDecider.accessToken}/decision`, { decision: "need_more_time" });
  assert.equal(res.status, 403, "R2: 'need more time' also needs the NDA");
  await settle();
  assert.equal(sent.length, 0, "R2: the broker is not told a gate-only visitor 'finished reviewing'");
  assert.equal(T.events.filter((e) => e.buyerAccessId === unsignedDecider.id && e.eventType === "decision").length, 0);
  // No NDA required on the deal → decisions work without one.
  T.deals.push({ ...deal, id: "D-open", ndaRequired: false });
  const openDecider = mkAccess({ dealId: "D-open", buyerEmail: "open@buyer.invalid", firstViewedAt: new Date(now - DAY) });
  res = await call("POST", `/api/view/${openDecider.accessToken}/decision`, { decision: "not_interested" });
  assert.equal(res.status, 200, res.text);

  // ════ R2 — legacy gate stamps don't start the reminder clock ═══════════
  reset();
  // Signed yesterday, stamped at the gate a week ago (before the gate fix):
  // the clock runs from the signature, so no day-6 "final follow-up" now.
  const legacy = mkAccess({ ndaSigned: true, ndaSignedAt: new Date(now - 1 * DAY), firstViewedAt: new Date(now - 7 * DAY), reminderStage: "none", decision: null });
  assert.equal(await processReminderForAccess(legacy as any, now, "https://app.test"), "none", "R2: clock starts at the signature");
  assert.equal(sent.length, 0);
  const { reminderActionFor, reminderClockStart } = await import("../../server/reminders/decision-reminders");
  assert.equal(reminderActionFor(legacy as any, now + 3.5 * DAY, { ndaRequired: true }), "reminder", "R2: day 3 after signing → reminder");
  assert.equal(reminderActionFor(legacy as any, now + 5.5 * DAY, { ndaRequired: true }), "warning", "R2: day 6 after signing → warning");
  assert.equal(reminderClockStart(legacy as any, { ndaRequired: false }), new Date(legacy.firstViewedAt).getTime(), "R2: no NDA required → the first view");
  // Signing now clears a gate stamp so the first real view restarts the clock.
  const gateStamped = mkAccess({ accessLevel: "loi", firstViewedAt: new Date(now - 4 * DAY), viewCount: 3, reminderStage: "reminder_sent" });
  res = await call("GET", `/api/view/${gateStamped.accessToken}/buyer-profile`);
  res = await call("POST", `/api/view/${gateStamped.accessToken}/sign-nda`, { profile, signerName: "Sam Rivera", termsHash: res.json.nda.hash });
  assert.equal(res.status, 200, res.text);
  assert.equal(gateStamped.firstViewedAt, null, "R2: the gate stamp is cleared at signing");
  assert.equal(gateStamped.viewCount, 0);
  assert.equal(gateStamped.reminderStage, "none");
  res = await call("GET", `/api/view/${gateStamped.accessToken}`);
  assert.equal(res.status, 200, res.text);
  assert.ok(gateStamped.firstViewedAt && now - new Date(gateStamped.firstViewedAt).getTime() < 60_000, "R2: the first real view starts the clock");
  assert.equal(gateStamped.viewCount, 1);

  // ════ R2-F4 — confirming the email brings the shared deal to the dashboard
  reset();
  const rawTok = "confirm-token-123";
  T.buyers.push({ id: "U-late", email: "late@buyer.invalid", passwordHash: "h", emailVerified: false, name: "Late", source: "self_signup", buyerCriteria: {}, resetToken: hashResetToken(rawTok), resetTokenExpiresAt: new Date(now + DAY) });
  const lateGrant = mkAccess({ buyerEmail: "Late@Buyer.invalid", ndaSigned: true, buyerUserId: null });
  res = await call("GET", "/api/buyer-auth/dashboard", undefined, { "x-test-buyer": "U-late" });
  assert.equal(res.json.deals.length, 0, "R2-F4: unverified → nothing yet");
  assert.equal(lateGrant.buyerUserId, null, "R2-F4: and nothing is linked while unverified");
  res = await call("POST", `/api/buyer-auth/set-password/${rawTok}`, { password: "a-good-password" });
  assert.equal(res.status, 200, res.text);
  assert.equal(lateGrant.buyerUserId, "U-late", "R2-F4: confirming the email links the shared deal");
  res = await call("GET", "/api/buyer-auth/dashboard", undefined, { "x-test-buyer": "U-late" });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.deals.length, 1, "R2-F4: the dashboard lists it");
  assert.equal(res.json.emailUnverified, false);
  // A verified account opening its dashboard picks up a link left unlinked.
  const laterGrant = mkAccess({ dealId: "D2", buyerEmail: "late@buyer.invalid", ndaSigned: true });
  res = await call("GET", "/api/buyer-auth/dashboard", undefined, { "x-test-buyer": "U-late" });
  assert.equal(laterGrant.buyerUserId, "U-late", "R2-F4: self-heals on the dashboard");
  assert.equal(res.json.deals.length, 2);

  // ════ R2 — the broker isn't emailed about their own actions ════════════
  reset();
  const r2a = await notify("D1", "buyer_approval_requested", { title: "t", body: "b", actorUserId: "B1" });
  assert.equal(r2a.recipients, 0, "R2: the owner submitted it — no email to themselves");
  assert.equal(sent.length, 0);
  // Someone else's action still reaches the owner.
  const r2b = await notify("D1", "buyer_approval_requested", { title: "t", body: "b", actorUserId: "B-other" });
  assert.equal(r2b.via, "deal_owner");
  assert.equal(brokerEmails().length, 1);
  // A broker-team member who is the actor is skipped; other members still hear.
  reset();
  T.members.push(
    { id: "M-self", dealId: "D1", teamType: "broker", role: "lead", email: "MORGAN@brokerage.invalid", inviteStatus: "accepted", emailNotifications: true },
    { id: "M-assoc", dealId: "D1", teamType: "broker", role: "associate", email: "assoc@team.invalid", inviteStatus: "accepted", emailNotifications: true },
  );
  await notify("D1", "buyer_approval_rejected", { title: "t", body: "b", actorUserId: "B1" });
  assert.deepEqual(sent.map((m) => m.to[0]), ["assoc@team.invalid"], "R2: the acting broker is skipped, the associate is told");
  T.members.length = 0;
  // Through the real routes: submitting and rejecting a buyer as the owner sends no self-email.
  reset();
  const createdApproval: any[] = [];
  S.createBuyerApprovalRequest = async (row: any) => { const r = { id: id("R"), ...row }; T.approvals.push(r); createdApproval.push(r); return r; };
  S.getBuyerApprovalRequest = async (rid: string) => read("approvals", (r) => r.id === rid);
  res = await call("POST", "/api/deals/D1/buyer-approvals", { buyerName: "Quinn Buyer", buyerEmail: "quinn@buyer.invalid", category: "individual" }, broker);
  assert.equal(res.status, 200, res.text);
  assert.equal(brokerEmails().length, 0, "R2: no email to the owner about their own submission");
  res = await call("POST", `/api/buyer-approvals/${createdApproval[0].id}/broker-review`, { action: "reject", notes: "Not a fit" }, broker);
  assert.equal(res.status, 200, res.text);
  assert.equal(brokerEmails().length, 0, "R2: no email to the owner about their own rejection");

  server.close();
  console.log("f-buyers routes: all assertions passed");
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
