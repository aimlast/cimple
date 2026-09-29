/**
 * Free round 2, stream "journeys" — the seller's and broker's journeys
 * through the real Express routes, with an in-memory storage, a captured
 * email provider and a stubbed model (no database, no AI, no email leaves
 * the process).
 *
 *   J1 the interview's to-dos reach the seller (progress + documents) and close on upload
 *   J2 routing a conflict after the interview emails the seller and keeps the CIM locked
 *   J3 the seller reviews and approves the CIM on their own page
 *   J4 "I don't have this" lets the seller finish; the broker verifies
 *   J6 FAQ entries answer buyers (knowledge base + feed), blind-safe
 *   J7 page 1 of the intake isn't "complete"
 *   J8 buyer questions waiting on the seller show on every step, with links
 *
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/unit/f2-journeys-routes.test.ts
 */
import assert from "node:assert/strict";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

process.env.RESEND_API_KEY = "test-resend-key"; // sends are captured below, never delivered
process.env.APP_URL = "https://app.test";
process.env.DISABLE_SCHEDULERS = "1";
process.env.UPLOADS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "f2-journeys-"));

type Sent = { to: string[]; subject: string; html: string };
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

let seq = 0;
const id = (p: string) => `${p}${++seq}`;
const T: Record<string, any[]> = {
  users: [], deals: [], invites: [], members: [], notifications: [], tasks: [], reqs: [], discs: [],
  sessions: [], questions: [], access: [], faqs: [], sections: [], documents: [], events: [],
};
const find = (t: string, pred: (r: any) => boolean) => T[t].find(pred);
const copy = (r: any) => (r ? { ...r } : undefined);
const upd = (t: string, rid: string, patch: any) => {
  const r = find(t, (x) => x.id === rid);
  if (!r) return undefined;
  Object.assign(r, patch, { updatedAt: new Date() });
  return { ...r };
};

async function main() {
  // The model is stubbed: every call is recorded and answered by `model`.
  const Anthropic = (await import("@anthropic-ai/sdk")).default as any;
  const modelCalls: any[] = [];
  let model: (req: any) => any = () => { throw new Error("test: no model call expected"); };
  Anthropic.Messages.prototype.create = async function (req: any) { modelCalls.push(req); return model(req); };
  Anthropic.Messages.prototype.stream = function () { throw new Error("test: no streamed model call expected"); };

  const { storage } = await import("../../server/storage");
  const { db } = await import("../../server/db");
  const { registerRoutes } = await import("../../server/routes");

  const S = storage as any;
  Object.assign(S, {
    getUser: async (uid: string) => copy(find("users", (u) => u.id === uid)),
    getUserByEmail: async () => undefined,
    getDeal: async (did: string) => copy(find("deals", (d) => d.id === did)),
    updateDeal: async (did: string, patch: any) => upd("deals", did, patch),
    getBrandingByBroker: async () => undefined,
    getSellerInviteByToken: async (tok: string) => copy(find("invites", (i) => i.token === tok && i.status !== "revoked")),
    getSellerInvitesByDealId: async (did: string) => T.invites.filter((i) => i.dealId === did && i.status !== "revoked").map(copy),
    getDealMembers: async (did: string) => T.members.filter((m) => m.dealId === did),
    createNotification: async (row: any) => { const r = { id: id("N"), createdAt: new Date(), ...row }; T.notifications.push(r); return r; },
    getNotificationsByDeal: async (did: string) => T.notifications.filter((n) => n.dealId === did).map(copy),
    getTasksByDeal: async (did: string) => T.tasks.filter((t) => t.dealId === did).map(copy),
    getTask: async (tid: string) => copy(find("tasks", (t) => t.id === tid)),
    createTask: async (row: any) => { const r = { id: id("T"), createdAt: new Date(), updatedAt: new Date(), ...row }; T.tasks.push(r); return { ...r }; },
    updateTask: async (tid: string, patch: any) => upd("tasks", tid, patch),
    getDocumentRequirementsByDeal: async (did: string) => T.reqs.filter((r) => r.dealId === did).map(copy),
    getDocumentRequirement: async (rid: string) => copy(find("reqs", (r) => r.id === rid)),
    updateDocumentRequirement: async (rid: string, patch: any) => upd("reqs", rid, patch),
    getDiscrepanciesByDeal: async (did: string) => T.discs.filter((d) => d.dealId === did).map(copy),
    getDiscrepancy: async (xid: string) => copy(find("discs", (d) => d.id === xid)),
    updateDiscrepancy: async (xid: string, patch: any) => upd("discs", xid, patch),
    getResolvedDiscrepancies: async (did: string) => T.discs.filter((d) => d.dealId === did && ["resolved", "accepted", "ask_seller"].includes(d.status)).map(copy),
    getDocumentsByDeal: async (did: string) => T.documents.filter((d) => d.dealId === did).map(copy),
    getDocument: async (xid: string) => copy(find("documents", (d) => d.id === xid)),
    createDocument: async (row: any) => { const r = { id: id("DOC"), createdAt: new Date(), updatedAt: new Date(), ...row }; T.documents.push(r); return { ...r }; },
    updateDocument: async (xid: string, patch: any) => upd("documents", xid, patch),
    getCimSectionsByDeal: async (did: string) => T.sections.filter((s) => s.dealId === did).map(copy),
    getCimSectionOverrides: async () => [],
    getFaqsByDeal: async (did: string) => T.faqs.filter((f) => f.dealId === did).map(copy),
    getQuestionsByDeal: async (did: string) => T.questions.filter((q) => q.dealId === did).map(copy),
    createBuyerQuestion: async (row: any) => { const r = { id: id("Q"), createdAt: new Date(), updatedAt: new Date(), ...row }; T.questions.push(r); return { ...r }; },
    getBuyerAccessByToken: async (tok: string) => copy(find("access", (a) => a.accessToken === tok)),
    getBuyerAccessByDeal: async (did: string) => T.access.filter((a) => a.dealId === did).map(copy),
    updateBuyerAccess: async (aid: string, patch: any) => upd("access", aid, patch),
    createAnalyticsEvent: async (row: any) => { T.events.push(row); return row; },
  });
  // Direct db reads on these paths: the seller progress (sessions, buyer
  // questions), deal media and templates (none).
  (db as any).select = () => {
    let table: any = null;
    const chain: any = new Proxy({}, {
      get(_t, prop) {
        if (prop === "from") return (tb: any) => { table = tb; return chain; };
        if (prop === "then") {
          return (res: any, rej: any) => {
            const name = table?.[Symbol.for("drizzle:Name")];
            const rows = name === "interview_sessions" ? T.sessions : name === "buyer_questions" ? T.questions : [];
            return Promise.resolve(rows.map(copy)).then(res, rej);
          };
        }
        return () => chain;
      },
    });
    return chain;
  };

  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.session = {
      brokerId: req.get("x-test-broker") || undefined,
      save: (cb: any) => cb?.(), regenerate: (cb: any) => cb?.(), destroy: (cb: any) => cb?.(),
    };
    next();
  });
  const server = await registerRoutes(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await realFetch(base + p, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* text */ }
    return { status: r.status, json, text };
  };
  const settle = () => new Promise((r) => setTimeout(r, 60));
  const broker = { "x-test-broker": "B1" };
  const TOKEN = "seller-token-f2";
  const seller = { "x-seller-token": TOKEN };

  // ── Fixtures: a Clearwater-like clinic ───────────────────────────────
  T.users.push({ id: "B1", role: "broker", username: "morgan", name: "Morgan Ellis", email: "morgan@brokerage.invalid", settings: {} });
  const deal: any = {
    id: "D1", brokerId: "B1", businessName: "Clearwater Physio", industry: "Healthcare", subIndustry: "Physiotherapy clinic",
    phase: "phase2_platform_intake", isLive: false, ndaRequired: false, demoKey: null,
    questionnaireData: { businessName: "Clearwater Physio", reasonForSelling: "Retiring" }, operationalSystems: null, employeeChart: null,
    interviewCompleted: false, extractedInfo: {}, blindCodename: "Project Tidewater",
    contentApprovedByBroker: false, contentApprovedBySeller: false, designApprovedByBroker: false, designApprovedBySeller: false,
    cimLayoutGeneratedAt: null, cimGeneration: null, askingPrice: null,
  };
  T.deals.push(deal);
  T.invites.push({ id: "I1", dealId: "D1", token: TOKEN, sellerEmail: "amrit@clearwater.invalid", sellerName: "Amrit", status: "accepted", acceptedAt: new Date(), sentAt: new Date(), createdAt: new Date(), expiresAt: null });
  const mkReq = (o: any) => { const r = { id: id("R"), dealId: "D1", isRequired: true, status: "missing", source: "auto", notes: null, uploadedFileId: null, uploadedBy: null, category: "financial", ...o }; T.reqs.push(r); return r; };
  const rStatements = mkReq({ documentName: "Financial Statements (3 Years)", status: "uploaded", uploadedBy: "seller" });
  const rLease = mkReq({ documentName: "Commercial Lease Agreement", category: "legal" });
  const rDebt = mkReq({ documentName: "Debt Obligations Summary" });
  const tIpac = { id: "T-ipac", dealId: "D1", type: "document_request", title: "Get IPAC inspection reports with exact dates", description: "Seller said Dana keeps them…", status: "pending", createdBy: "ai_interview", createdAt: new Date() };
  const tWcb = { id: "T-wcb", dealId: "D1", type: "follow_up", title: "Confirm WCB billing audit history", description: "WCB is 14% of revenue…", status: "pending", createdBy: "ai_interview", createdAt: new Date() };
  const tBroker = { id: "T-own", dealId: "D1", type: "follow_up", title: "Check the landlord's consent", status: "pending", createdBy: "ai_interview_broker", createdAt: new Date() };
  T.tasks.push(tIpac, tWcb, tBroker);
  T.questions.push({ id: "Q-lease", dealId: "D1", question: "Is the lease assignable?", status: "pending_seller", sellerApprovalToken: "appr-1", isPublished: false, buyerAccessId: null, createdAt: new Date(), updatedAt: new Date() });

  // ════ J7 + J8 + J1: the seller's progress ═══════════════════════════════
  let p = await call("GET", `/api/seller/${TOKEN}/progress`);
  assert.equal(p.status, 200, p.text);
  assert.equal(p.json.currentStep, "intake", "J7: page 1 only → still the intake step");
  assert.deepEqual(p.json.intake, { status: "in_progress", pagesDone: 1, pagesTotal: 3 });
  assert.deepEqual(p.json.pendingApprovalItems, [{ id: "Q-lease", question: "Is the lease assignable?", href: "/approve/appr-1" }], "J8: shown on every step, with its link");
  assert.deepEqual(p.json.todo.map((x: any) => [x.kind, x.title]), [["document", "IPAC inspection reports with exact dates"], ["follow_up", "Confirm WCB billing audit history"]], "J1: the seller's to-dos (never the broker's own)");
  assert.ok(!JSON.stringify(p.json.todo).includes("Dana keeps"), "J1: the broker-facing description never reaches the seller");
  console.log("  ok  J7/J8/J1 progress: intake in progress, approvals with links, the seller's to-dos");

  // Finish the intake (Key People) and the interview.
  Object.assign(deal, { operationalSystems: { accounting: "Jane App" }, employeeChart: [{ name: "Dana", role: "Clinic manager" }], interviewCompleted: true });
  p = await call("GET", `/api/seller/${TOKEN}/progress`);
  assert.equal(p.json.currentStep, "documents");
  assert.equal(p.json.documents.requiredUploaded, 1);

  // ════ J4: "I don't have this" ═══════════════════════════════════════════
  let r = await call("PATCH", `/api/deals/D1/document-requirements/${rLease.id}`, { status: "unavailable", reason: "We own the building" }, seller);
  assert.equal(r.status, 200, r.text);
  assert.equal(rLease.status, "unavailable");
  assert.match(rLease.notes, /Seller: I don't have this — We own the building/);
  assert.equal(rLease.uploadedBy, null, "J4: no file, no uploader");
  r = await call("PATCH", `/api/deals/D1/document-requirements/${rStatements.id}`, { status: "unavailable" }, seller);
  assert.equal(r.status, 409, "J4: a row with a file on it: remove the file first");
  r = await call("PATCH", `/api/deals/D1/document-requirements/${rDebt.id}`, { status: "verified" }, seller);
  assert.equal(r.status, 400, "J4: only the broker verifies");
  r = await call("PATCH", `/api/deals/D1/document-requirements/${rDebt.id}`, { status: "unavailable", reason: "No debt at all" }, seller);
  p = await call("GET", `/api/seller/${TOKEN}/progress`);
  assert.equal(p.json.documents.percentage, 100);
  assert.equal(p.json.documents.requiredUnavailable, 2);
  assert.equal(p.json.currentStep, "review", "J4: the clinic with no lease and no debt can finish");
  // The broker verifies the upload and asks again about the debt.
  r = await call("PATCH", `/api/deals/D1/document-requirements/${rStatements.id}`, { status: "verified" }, broker);
  assert.equal(r.status, 200, r.text);
  assert.equal(rStatements.status, "verified", "J4: 'Pending review' ends");
  r = await call("PATCH", `/api/deals/D1/document-requirements/${rDebt.id}`, { status: "missing" }, broker);
  assert.equal(rDebt.status, "missing");
  assert.equal(rDebt.notes, null, "J4: 'ask again' takes the seller's line off");
  r = await call("PATCH", `/api/deals/D1/document-requirements/${rLease.id}`, { isRequired: false }, broker);
  assert.equal(rLease.isRequired, false, "J4: not needed");
  console.log("  ok  J4 seller 'I don't have this' → finishes; broker verifies / asks again / not needed");

  // ════ J1: uploading a requested document closes the request ════════════
  const fd = new FormData();
  fd.append("file", new Blob(["IPAC inspection 2026-03-04: pass"], { type: "text/plain" }), "ipac-2026.txt");
  fd.append("taskId", tIpac.id);
  const up = await realFetch(`${base}/api/deals/D1/documents/upload`, { method: "POST", headers: seller, body: fd });
  const upJson = await up.json();
  assert.equal(up.status, 200, JSON.stringify(upJson));
  assert.deepEqual(upJson.satisfiedTask, { id: tIpac.id, title: tIpac.title });
  assert.equal(tIpac.status, "completed");
  assert.match(String((tIpac as any).brokerNotes), /The seller uploaded "ipac-2026.txt"/);
  const fd2 = new FormData();
  fd2.append("file", new Blob(["x"], { type: "text/plain" }), "x.txt");
  fd2.append("taskId", tWcb.id);
  const bad = await realFetch(`${base}/api/deals/D1/documents/upload`, { method: "POST", headers: seller, body: fd2 });
  assert.equal(bad.status, 400, "J1: a follow-up isn't closed by a file");
  p = await call("GET", `/api/seller/${TOKEN}/progress`);
  assert.deepEqual(p.json.todo.map((x: any) => x.id), ["T-wcb"], "J1: the document request is off the seller's list");
  await settle();
  console.log("  ok  J1 an upload against a requested document closes it; follow-ups can't be closed by a file");

  // ════ J2: routing a conflict after the interview ═══════════════════════
  const disc = { id: "X1", dealId: "D1", field: "2025 revenue", interviewValue: "$2.3M", documentValue: "$1.82M", severity: "critical", category: "financial", source: "interview", status: "open", sideSources: null, createdAt: new Date() };
  T.discs.push(disc);
  sent.length = 0;
  r = await call("PATCH", "/api/discrepancies/X1", { status: "ask_seller" }, broker);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(
    { finished: r.json.sellerFollowUp.interviewFinished, waiting: r.json.sellerFollowUp.waiting, emailed: r.json.sellerFollowUp.emailed },
    { finished: true, waiting: 1, emailed: 1 },
  );
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, ["amrit@clearwater.invalid"]);
  assert.ok(sent[0].html.includes(`/seller/${TOKEN}/interview?followup=1`), "J2: the seller's own link to the follow-up");
  assert.ok(!T.notifications.some((n) => String(n.actionUrl).includes(TOKEN)), "J2: the log never stores the seller's token");
  p = await call("GET", `/api/seller/${TOKEN}/progress`);
  assert.equal(p.json.followUpQuestions, 1, "J2: the progress page asks them back");
  // The CIM stays locked while it waits on the seller.
  r = await call("POST", "/api/deals/D1/generate-content", {}, broker);
  assert.equal(r.status, 409, "J2: a routed critical conflict still blocks generation after the interview");
  assert.equal(r.json.blockingDiscrepancies[0].id, "X1");
  // A second routing within the hour doesn't email again.
  T.discs.push({ ...disc, id: "X2", field: "Owner salary", status: "open" });
  sent.length = 0;
  r = await call("PATCH", "/api/discrepancies/X2", { status: "ask_seller" }, broker);
  assert.equal(r.json.sellerFollowUp.recentlyEmailed, true);
  assert.equal(sent.length, 0);
  // The CIM builder's AI writing obeys the same rule (it used to see only open/seller_responded).
  r = await call("POST", "/api/deals/D1/cim-sections", { title: "Growth plan", layoutType: "prose_highlight", mode: "ai" }, broker);
  assert.equal(r.status, 409, `r2: a critical routed after the interview blocks the builder's AI too (${r.status} ${r.text})`);
  assert.match(r.json.error, /Waiting on the seller to answer 2 critical questions/);
  assert.equal(modelCalls.length, 0, "r2: refused before any model call");
  // The seller came back (their follow-up session handed both back): a NEW
  // routing within the hour is a new request — emailed again, not "added" to
  // an email they already acted on.
  await new Promise((res) => setTimeout(res, 5));
  const back = { id: "SESS-back", dealId: "D1", lastActivityAt: new Date(), messages: [] };
  await new Promise((res) => setTimeout(res, 5));
  T.sessions.push(back);
  for (const x of T.discs) if (x.status === "ask_seller") x.status = "seller_responded";
  T.discs.push({ ...disc, id: "X4", field: "Lease term", status: "open" });
  sent.length = 0;
  r = await call("PATCH", "/api/discrepancies/X4", { status: "ask_seller" }, broker);
  assert.equal(r.json.sellerFollowUp.recentlyEmailed, undefined, "r2: not 'already emailed' once the seller came back");
  assert.equal(r.json.sellerFollowUp.emailed, 1);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, ["amrit@clearwater.invalid"]);
  // …and a burst right after that one is still a single email.
  T.discs.push({ ...disc, id: "X5", field: "Staff count", status: "open" });
  sent.length = 0;
  r = await call("PATCH", "/api/discrepancies/X5", { status: "ask_seller" }, broker);
  assert.equal(r.json.sellerFollowUp.recentlyEmailed, true);
  assert.equal(sent.length, 0);
  T.sessions.splice(T.sessions.indexOf(back), 1);
  // While the interview is running, routing is unchanged: no email, not blocking.
  Object.assign(deal, { interviewCompleted: false });
  T.discs.push({ ...disc, id: "X3", field: "Staff count", status: "open" });
  r = await call("PATCH", "/api/discrepancies/X3", { status: "ask_seller" }, broker);
  assert.equal(r.json.sellerFollowUp.interviewFinished, false);
  Object.assign(deal, { interviewCompleted: true });
  for (const d of T.discs) d.status = "resolved";
  console.log("  ok  J2 routed after the interview → seller emailed their own follow-up link, CIM stays locked");

  // ════ J3: the seller's CIM review ═══════════════════════════════════════
  T.sections.push(
    { id: "S1", dealId: "D1", sectionKey: "executiveSummary", sectionTitle: "Executive Summary", order: 1, layoutType: "prose_highlight", layoutData: { body: "Clearwater Physio is a three-clinic practice." }, isVisible: true, aiLayoutReasoning: "owner Amrit said…", createdAt: new Date(), updatedAt: new Date() },
    { id: "S2", dealId: "D1", sectionKey: "hidden", sectionTitle: "Hidden", order: 2, layoutType: "prose_highlight", layoutData: {}, isVisible: false, createdAt: new Date(), updatedAt: new Date() },
  );
  r = await call("GET", `/api/seller/${TOKEN}/cim-review`);
  assert.equal(r.json.stage, "not_ready");
  assert.deepEqual(r.json.sections, [], "J3: nothing before the broker approved it");
  r = await call("POST", "/api/deals/D1/seller-review/send", {}, broker);
  assert.equal(r.status, 409, "J3: the broker approves first");
  Object.assign(deal, { contentApprovedByBroker: true });
  sent.length = 0;
  r = await call("POST", "/api/deals/D1/seller-review/send", {}, broker);
  assert.equal(r.status, 200, r.text);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].html.includes(`/seller/${TOKEN}/review`), "J3: cim_ready carries the seller's own review link");
  r = await call("GET", `/api/seller/${TOKEN}/cim-review`);
  assert.equal(r.json.stage, "content");
  assert.deepEqual(r.json.sections.map((s: any) => s.id), ["S1"], "J3: the named CIM, hidden sections out");
  assert.ok(!JSON.stringify(r.json).includes("aiLayoutReasoning"), "J3: no AI notes");
  // The broker previewing the seller's link can't approve for them by accident.
  r = await call("POST", `/api/seller/${TOKEN}/cim-review/approve`, { stage: "content" }, broker);
  assert.equal(r.status, 403);
  // Changes, then approval.
  sent.length = 0;
  r = await call("POST", `/api/seller/${TOKEN}/cim-review/request-changes`, { note: "Please say three clinics, not two." });
  assert.equal(r.status, 200, r.text);
  const review = T.tasks.find((t) => t.createdBy === "seller_review");
  assert.ok(review && review.status === "pending", "J3: the request is an open item for the broker");
  assert.ok(sent.some((m) => m.to.includes("morgan@brokerage.invalid") && /asked for changes/.test(m.subject)));
  r = await call("POST", `/api/seller/${TOKEN}/cim-review/approve`, { stage: "design" });
  assert.equal(r.status, 409, "J3: a stale page can't approve a different stage");
  r = await call("POST", `/api/seller/${TOKEN}/cim-review/approve`, { stage: "content" });
  assert.equal(r.status, 200, r.text);
  assert.equal(deal.contentApprovedBySeller, true, "J3: the seller's own approval");
  assert.equal(review!.status, "completed", "J3: their change request is settled by the approval");
  const status = await call("GET", "/api/deals/D1/seller-review", undefined, broker);
  assert.equal(status.json.stage, "waiting");
  assert.ok(status.json.lastSentAt);
  // A critical conflict blocks the seller's approval like the broker's.
  Object.assign(deal, { designApprovedByBroker: true });
  T.discs.push({ ...disc, id: "X9", status: "open" });
  r = await call("POST", `/api/seller/${TOKEN}/cim-review/approve`, { stage: "design" });
  assert.equal(r.status, 409);
  assert.equal(deal.designApprovedBySeller, false);
  T.discs.pop();
  // The seller Owner turned email notifications off: recorded, never emailed —
  // and never sent to the invite address instead (r2).
  T.members.push({ id: "M-owner", dealId: "D1", teamType: "seller", role: "owner", name: "Amrit", email: "Amrit@Clearwater.invalid", inviteStatus: "accepted", emailNotifications: false });
  sent.length = 0;
  const before = T.notifications.length;
  r = await call("POST", "/api/deals/D1/seller-review/send", {}, broker);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.json.recipients, r.json.emailsSent, r.json.optedOut, r.json.via], [1, 0, 1, "members"]);
  assert.equal(sent.length, 0, "r2: an opted-out seller gets no email, not even at the invite address");
  const muted = T.notifications.slice(before);
  assert.equal(muted.length, 1);
  assert.equal(muted[0].metadata.emailSkipped, "opted_out");
  assert.equal(muted[0].emailSent, false);
  T.members.pop();
  console.log("  ok  J3 send → review → request changes → approve, gated like every approval");

  // ════ J6: FAQ answers buyers ════════════════════════════════════════════
  Object.assign(deal, { isLive: true, businessName: "Clearwater Physio" });
  T.faqs.push(
    { id: "F1", dealId: "D1", question: "How long is the lease?", answer: "Seven years left, with one five-year renewal.", isPublished: true, order: 0, createdAt: new Date(), updatedAt: new Date() },
    { id: "F2", dealId: "D1", question: "Does Clearwater Physio bill WCB directly?", answer: "Yes.", isPublished: true, order: 1, createdAt: new Date(), updatedAt: new Date() },
  );
  T.access.push({ id: "A1", dealId: "D1", accessToken: "buyer-tok", accessLevel: "teaser", ndaSigned: true, revokedAt: null, expiresAt: new Date(Date.now() + 86400000), buyerEmail: "sam@buyer.invalid" });
  const feed = await call("GET", "/api/deals/D1/questions/published?token=buyer-tok");
  assert.equal(feed.status, 200, feed.text);
  assert.deepEqual(feed.json.map((q: any) => q.question), ["How long is the lease?"], "J6: the FAQ is in the Blind buyer's feed — the one naming the business is not");
  model = (req) => {
    const kb = JSON.stringify(req.messages);
    assert.ok(kb.includes("Seven years left"), "J6: the FAQ answer is in the assistant's knowledge base");
    assert.ok(!kb.includes("bill WCB directly"), "J6: a business-naming FAQ never reaches a Blind buyer's assistant");
    return { content: [{ type: "text", text: "MATCH: Seven years left, with one five-year renewal." }] };
  };
  r = await call("POST", "/api/deals/D1/questions", { question: "What's the remaining lease term?", accessToken: "buyer-tok" });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.fromKnowledgeBase, true, "J6: answered on the spot — no escalation, no seller loop");
  assert.equal(modelCalls.length, 1);
  assert.deepEqual(T.questions.at(-1).similarQuestionIds, ["faq:F1"]);
  console.log("  ok  J6 FAQ in the buyer feed and the assistant's first step, blind-safe");

  server.close();
  console.log("f2-journeys routes: all passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
