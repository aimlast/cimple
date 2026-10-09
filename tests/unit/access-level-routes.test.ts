/**
 * Access levels through the real Express routes (in-memory storage; no DB,
 * no AI, no email leaves the process):
 *   - granting a link takes a level (new keys or a stale tab's legacy value,
 *     stored normalised; Teaser refused until a teaser is published);
 *   - changing a level stores it normalised and logs a change only when the
 *     level really changes ("loi" → "named" is the same Full CIM);
 *   - a Teaser link (teaser_only) never reaches anything CIM-derived: the view
 *     room, the decision, Q&A, the feed, the legacy analytics endpoints;
 *   - buyer-side team seats default to the Blind CIM;
 *   - per-section access tiers are retired (400 with a refresh hint);
 *   - the old un-redacted generate-teaser stub is gone.
 *
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/access-level-routes.test.ts
 */
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";

process.env.APP_URL = "https://app.test";
process.env.DISABLE_SCHEDULERS = "1";
delete process.env.RESEND_API_KEY;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  const u = String(url);
  if (u.startsWith("http://127.0.0.1:")) return realFetch(url, init);
  throw new Error(`test: blocked outbound fetch to ${u}`);
}) as any;

const now = Date.now();
const DAY = 86400000;
let seq = 0;
const id = (p: string) => `${p}${++seq}`;
const T: Record<string, any[]> = { users: [], deals: [], access: [], members: [], sections: [], events: [], questions: [] };
const find = (t: string, pred: (r: any) => boolean) => T[t].find(pred);
const read = (t: string, pred: (r: any) => boolean) => { const r = find(t, pred); return r ? { ...r } : undefined; };
const upd = (t: string, rid: string, patch: any) => { const r = find(t, (x) => x.id === rid); if (!r) return undefined; Object.assign(r, patch); return r; };

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    throw err;
  }
}

async function main() {
  const { storage } = await import("../../server/storage");
  const { db } = await import("../../server/db");
  const { registerRoutes } = await import("../../server/routes");
  // No teaser on these deals (in memory — no DB).
  const { _setTeaserStoreForTests, memoryTeaserStore } = await import("../../server/teaser/store");
  _setTeaserStoreForTests(memoryTeaserStore());
  delete process.env.ANTHROPIC_API_KEY;

  const S = storage as any;
  Object.assign(S, {
    getUser: async (uid: string) => find("users", (u) => u.id === uid),
    getDeal: async (did: string) => find("deals", (d) => d.id === did),
    getBrandingByBroker: async () => undefined,
    getIntegrationsByBroker: async () => [],
    getDealMembers: async (did: string) => T.members.filter((m) => m.dealId === did),
    getDealMember: async (mid: string) => read("members", (m) => m.id === mid),
    getDealMemberByEmail: async (did: string, e: string) => find("members", (m) => m.dealId === did && m.email === e),
    createDealMember: async (row: any) => { const r = { id: id("M"), ...row }; T.members.push(r); return r; },
    updateDealMember: async (mid: string, patch: any) => { const r = upd("members", mid, patch); return r ? { ...r } : r; },
    getSellerInvitesByDealId: async () => [],
    createNotification: async (row: any) => row,
    getBuyerAccessByToken: async (tok: string) => read("access", (a) => a.accessToken === tok),
    getBuyerAccess: async (aid: string) => read("access", (a) => a.id === aid),
    getBuyerAccessByDeal: async (did: string) => T.access.filter((a) => a.dealId === did),
    createBuyerAccess: async (row: any) => { const r = { id: id("A"), decision: "under_review", viewCount: 0, ndaSigned: false, createdAt: new Date(), ...row }; T.access.push(r); return r; },
    updateBuyerAccess: async (aid: string, patch: any) => { const r = upd("access", aid, patch); return r ? { ...r } : r; },
    getBuyerUserByEmail: async () => undefined,
    createAnalyticsEvent: async (row: any) => { const r = { id: id("E"), ...row }; T.events.push(r); return r; },
    getCimSectionsByDeal: async (did: string) => T.sections.filter((s) => s.dealId === did),
    getCimSectionOverrides: async () => [],
    getQuestionsByDeal: async (did: string) => T.questions.filter((q) => q.dealId === did),
    getFaqsByDeal: async () => [],
  });
  // Direct db reads on these paths: the section PATCH loads its row; media and buyer lists are empty.
  (db as any).select = () => {
    let table: any = null;
    const chain: any = {
      from(t: any) { table = t; return chain; },
      where() { return chain; },
      then(res: any, rej: any) {
        const name = table?.[Symbol.for("drizzle:Name")];
        const rows = name === "cim_sections" ? T.sections.map((s) => ({ ...s })) : [];
        return Promise.resolve(rows).then(res, rej);
      },
    };
    return chain;
  };

  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.session = { brokerId: req.get("x-test-broker") || undefined, save: (cb: any) => cb?.(), regenerate: (cb: any) => cb?.(), destroy: (cb: any) => cb?.() };
    next();
  });
  const server = await registerRoutes(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await realFetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json, text };
  };
  const broker = { "x-test-broker": "B1" };

  T.users.push({ id: "B1", role: "broker", username: "morgan", name: "Morgan Ellis", email: null, settings: {} });
  T.deals.push({
    id: "D1", brokerId: "B1", businessName: "Harbour Point Dental Ltd", blindCodename: "Project Lighthouse", isLive: true,
    industry: "Dental", ndaRequired: false, extractedInfo: { companyName: "Harbour Point Dental" }, designTemplateId: null, demoKey: "test",
  });
  T.deals.push({ id: "D9", brokerId: "B1", businessName: "Not Live Co", isLive: false, industry: "Retail", ndaRequired: false, extractedInfo: {} });
  T.sections.push({ id: "S1", dealId: "D1", sectionKey: "executiveSummary", sectionTitle: "Summary", order: 0, layoutType: "prose_highlight", layoutData: {}, aiDraftContent: "Harbour Point Dental is a practice.", brokerEditedContent: null, isVisible: true, brokerApproved: true, accessTier: "teaser" });
  const mkAccess = (o: any = {}) => {
    const a = { id: id("A"), dealId: "D1", accessToken: id("tok-"), buyerEmail: "sam@buyer.invalid", buyerName: "Sam Rivera", buyerCompany: null,
      accessLevel: "blind", ndaSigned: false, decision: "under_review", viewCount: 0, firstViewedAt: null, lastAccessedAt: null, revokedAt: null,
      expiresAt: new Date(now + 20 * DAY), reminderStage: "none", buyerUserId: null, accessEvents: null, createdAt: new Date(), ...o };
    T.access.push(a);
    return a;
  };

  console.log("granting links");
  await check("POST /buyers: no level = the Blind CIM (an old tab), recorded as granted", async () => {
    const r = await call("POST", "/api/deals/D1/buyers", { buyerEmail: "A@x.invalid" }, broker);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.accessLevel, "blind");
    assert.equal(r.json.accessEvents[0].type, "granted");
    assert.equal(r.json.accessEvents[0].accessLevel, "blind");
  });
  await check("POST /buyers: new keys stored as sent; a stale tab's legacy value stored as the level it means", async () => {
    for (const [sent, stored] of [["named", "named"], ["due_diligence", "due_diligence"], ["blind", "blind"], ["loi", "named"], ["full", "blind"], ["teaser", "blind"]]) {
      const r = await call("POST", "/api/deals/D1/buyers", { buyerEmail: `${sent}@x.invalid`, accessLevel: sent }, broker);
      assert.equal(r.status, 200, `${sent}: ${r.text}`);
      assert.equal(r.json.accessLevel, stored, sent);
    }
  });
  await check("POST /buyers: junk → 400 with the four choices; Teaser → 409 until a teaser is published", async () => {
    const bad = await call("POST", "/api/deals/D1/buyers", { buyerEmail: "j@x.invalid", accessLevel: "admin" }, broker);
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /Teaser, Blind CIM, Full CIM or Due diligence/);
    const teaser = await call("POST", "/api/deals/D1/buyers", { buyerEmail: "t@x.invalid", accessLevel: "teaser_only" }, broker);
    assert.equal(teaser.status, 409);
    assert.equal(teaser.json.code, "teaser_not_published");
    assert.ok(!T.access.some((a) => a.buyerEmail === "t@x.invalid" || a.buyerEmail === "j@x.invalid"), "nothing created");
  });
  await check("POST /buyers: a CIM level still needs a published CIM", async () => {
    const r = await call("POST", "/api/deals/D9/buyers", { buyerEmail: "n@x.invalid", accessLevel: "named" }, broker);
    assert.equal(r.status, 409);
  });

  console.log("changing a level");
  await check("PATCH: stored normalised; a change logged only when the level really changes", async () => {
    const a = mkAccess({ accessLevel: "loi" });
    let r = await call("PATCH", `/api/buyers/${a.id}`, { accessLevel: "named" }, broker);
    assert.equal(r.status, 200, r.text);
    assert.equal(find("access", (x) => x.id === a.id).accessLevel, "named");
    assert.equal((find("access", (x) => x.id === a.id).accessEvents ?? []).length, 0, "loi → named is the same Full CIM: no change logged");
    r = await call("PATCH", `/api/buyers/${a.id}`, { accessLevel: "full" }, broker);
    assert.equal(find("access", (x) => x.id === a.id).accessLevel, "blind", "a stale tab's Full is the Blind CIM — never named");
    const ev = find("access", (x) => x.id === a.id).accessEvents;
    assert.deepEqual([ev.at(-1).type, ev.at(-1).accessLevel], ["level_changed", "blind"]);
  });
  await check("PATCH: junk → 400; Teaser refused on the server until a teaser is published", async () => {
    const a = mkAccess();
    assert.equal((await call("PATCH", `/api/buyers/${a.id}`, { accessLevel: "LOI" }, broker)).status, 400);
    const r = await call("PATCH", `/api/buyers/${a.id}`, { accessLevel: "teaser_only" }, broker);
    assert.equal(r.status, 409);
    assert.equal(r.json.code, "teaser_not_published");
    assert.equal(find("access", (x) => x.id === a.id).accessLevel, "blind");
  });

  console.log("a Teaser link never reaches the CIM");
  const teaserLink = mkAccess({ accessLevel: "teaser_only", ndaSigned: true });
  await check("the view room: 403 'not available', never a section, never a view stamp", async () => {
    const r = await call("GET", `/api/view/${teaserLink.accessToken}`);
    assert.equal(r.status, 403);
    assert.equal(r.json.code, "not_published");
    assert.ok(!/Harbour|sections/.test(r.text));
    assert.equal(find("access", (x) => x.id === teaserLink.id).firstViewedAt, null);
  });
  await check("a Full CIM link (legacy loi) is served the named CIM, its level sent normalised", async () => {
    const a = mkAccess({ accessLevel: "loi" });
    const r = await call("GET", `/api/view/${a.accessToken}`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.cimMode, "normal");
    assert.equal(r.json.access.accessLevel, "named");
    assert.equal(r.json.sections.length, 1);
  });
  await check("decision → 409 'Ask for the CIM first'", async () => {
    const r = await call("POST", `/api/view/${teaserLink.accessToken}/decision`, { decision: "interested" });
    assert.equal(r.status, 409);
    assert.equal(r.json.code, "teaser_only");
    assert.equal(find("access", (x) => x.id === teaserLink.id).decision, "under_review");
  });
  await check("questions (the chatbot) → 403; the Q&A feed → []", async () => {
    const q = await call("POST", "/api/deals/D1/questions", { question: "What is the revenue?", accessToken: teaserLink.accessToken });
    assert.equal(q.status, 403);
    assert.equal(q.json.code, "teaser_only");
    assert.equal(T.questions.length, 0);
    const f = await call("GET", `/api/deals/D1/questions/published?token=${teaserLink.accessToken}`);
    assert.equal(f.status, 200);
    assert.deepEqual(f.json, []);
  });
  await check("legacy analytics endpoints store nothing for a Teaser link", async () => {
    const before = T.events.length;
    const e = await call("POST", `/api/buyer-access/${teaserLink.accessToken}/events`, { eventType: "view" });
    assert.equal(e.status, 204);
    const b = await call("POST", "/api/deals/D1/analytics/batch", { accessToken: teaserLink.accessToken, events: [{ eventType: "view" }] });
    assert.equal(b.status, 200);
    assert.equal(b.json.received, 0);
    assert.equal(T.events.length, before);
  });

  console.log("team seats");
  await check("a buyer-side seat defaults to the Blind CIM; a legacy value is stored normalised; junk refused", async () => {
    let r = await call("POST", "/api/deals/D1/members", { email: "p@buyer.invalid", teamType: "buyer", role: "principal", notifyMember: false }, broker);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.accessLevel, "blind");
    r = await call("POST", "/api/deals/D1/members", { email: "q@buyer.invalid", teamType: "buyer", role: "analyst", accessLevel: "loi", notifyMember: false }, broker);
    assert.equal(r.json.accessLevel, "named");
    r = await call("POST", "/api/deals/D1/members", { email: "z@buyer.invalid", teamType: "buyer", role: "analyst", accessLevel: "boss", notifyMember: false }, broker);
    assert.equal(r.status, 400);
    r = await call("POST", "/api/deals/D1/members", { email: "s@seller.invalid", teamType: "broker", role: "analyst", notifyMember: false }, broker);
    assert.equal(r.json.accessLevel, null, "other teams have no level");
    const seat = find("members", (m) => m.email === "p@buyer.invalid");
    r = await call("PATCH", `/api/members/${seat.id}`, { accessLevel: "full" }, broker);
    assert.equal(r.status, 200, r.text);
    assert.equal(find("members", (m) => m.id === seat.id).accessLevel, "blind");
    assert.equal((await call("PATCH", `/api/members/${seat.id}`, { accessLevel: "x" }, broker)).status, 400);
  });

  console.log("section locks retired");
  await check("the bulk tiers route and a section PATCH with accessTier → 400 with a refresh hint; nothing written", async () => {
    const t = await call("POST", "/api/deals/D1/cim-sections/tiers", { accessTier: "full", sectionIds: ["S1"] }, broker);
    assert.equal(t.status, 400);
    assert.match(t.json.error, /aren't locked by access level any more\. Refresh the page/);
    const p = await call("PATCH", "/api/cim-sections/S1", { accessTier: "full" }, broker);
    assert.equal(p.status, 400);
    assert.match(p.json.error, /Refresh the page/);
    assert.equal(find("sections", (s) => s.id === "S1").accessTier, "teaser");
  });

  console.log("dead code");
  await check("the old generate-teaser stub (it returned the un-redacted location) is gone", async () => {
    const r = await call("POST", "/api/deals/D1/generate-teaser", {}, broker);
    assert.equal(r.status, 404);
  });

  server.close();
  console.log(`\n${passed} passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
