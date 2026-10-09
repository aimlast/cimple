/**
 * A route harness for the teaser tests: the real Express routes
 * (registerRoutes) over in-memory storage, an in-memory teaser store, email
 * checks, saved templates, reading store and renditions, a captured email
 * provider and stubbed models. No database, no AI, no email leaves the
 * process.
 *
 * Import this FIRST in a test (it sets env and blocks outbound fetches).
 */
import express from "express";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";

process.env.RESEND_API_KEY = "test-resend-key"; // captured below, never delivered
process.env.APP_URL = "https://app.test";
process.env.DISABLE_SCHEDULERS = "1";
process.env.SESSION_SECRET = "test-session-secret";

export type Sent = { from: string; to: string[]; cc?: string[]; reply_to?: string[]; subject: string; html: string };
export const sent: Sent[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
  const u = String(url);
  if (u.startsWith("https://api.resend.com/")) {
    sent.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ id: "em" }), { status: 200 });
  }
  if (u.startsWith("http://127.0.0.1:")) return realFetch(url as string, init as RequestInit);
  throw new Error(`test: blocked outbound fetch to ${u}`);
}) as typeof fetch;

export const now = Date.now();
export const DAY = 86_400_000;
let seq = 0;
export const id = (p: string) => `${p}${++seq}`;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;
export const T: Record<string, Row[]> = {
  users: [], deals: [], access: [], buyers: [], members: [], invites: [], notifications: [], approvals: [],
  questions: [], sections: [], overrides: [], events: [], contacts: [], outreach: [], tasks: [], discrepancies: [],
};
export const find = (t: string, pred: (r: Row) => boolean) => T[t].find(pred);
const read = (t: string, pred: (r: Row) => boolean) => {
  const r = find(t, pred);
  return r ? { ...r } : undefined;
};
const upd = (t: string, rid: string, patch: Row) => {
  const r = find(t, (x) => x.id === rid);
  if (!r) return undefined;
  Object.assign(r, patch);
  return r;
};

export const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/teaser/${name}`, import.meta.url), "utf8"));
/** The recorded model output, written under the harness deal's codename. */
export const pacificWritten = () => JSON.parse(JSON.stringify(fixture("pacific-write_teaser.json")).split("Project Coastline").join("Project Meridian"));

export interface Harness {
  call: (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; json: Row; text: string }>;
  broker: Record<string, string>;
  /** The in-memory stores. */
  teasers: Awaited<ReturnType<typeof import("../../server/teaser/store").memoryTeaserStore>>;
  checks: ReturnType<typeof import("../../server/teaser/email-check").memoryEmailCheckStore>;
  reading: ReturnType<typeof import("../../server/analytics/reading-ingest").memoryReadingStore>;
  codes: Array<{ to: string; subject: string; html: string }>;
  modelPrompts: Array<{ system: string; user: string }>;
  modelReplies: Array<Record<string, unknown> | Error>;
  settle: () => Promise<void>;
  close: () => Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  const { storage } = await import("../../server/storage");
  const { db } = await import("../../server/db");
  const { registerRoutes } = await import("../../server/routes");
  const store = await import("../../server/teaser/store");
  const ec = await import("../../server/teaser/email-check");
  const ts = await import("../../server/teaser/templates-store");
  const gen = await import("../../server/teaser/generate");
  const { dbBriefDeps } = await import("../../server/teaser/brief");
  const keepOut = await import("../../server/cim/keep-out");
  const snap = await import("../../server/cim/published-snapshot");
  const ri = await import("../../server/analytics/reading-ingest");
  const { setReadingStore } = await import("../../server/routes/reading");
  const serve = await import("../../server/teaser/serve");
  const eng = await import("../../server/teaser/engagement");
  const summary = await import("../../server/teaser/summary");
  delete process.env.ANTHROPIC_API_KEY;

  const teasers = store.memoryTeaserStore();
  store._setTeaserStoreForTests(teasers);
  const checks = ec.memoryEmailCheckStore();
  ec._setEmailCheckStoreForTests(checks);
  const codes: Harness["codes"] = [];
  ec._setEmailSenderForTests(async (to, subject, html) => {
    codes.push({ to, subject, html });
    return true;
  });
  ts._setTemplatesStoreForTests(ts.memoryTemplatesStore());
  const settings: Record<string, Record<string, unknown>> = {};
  ts._setTeaserSettingsStoreForTests({ async get(b) { return settings[b] ?? null; }, async set(b, v) { settings[b] = v; } });
  snap._setSnapshotStoreForTests(snap.memorySnapshotStore());
  keepOut._setKeepOutModelForTests({ messages: { create: (async () => fixture("keep-out-nothing-held.json")) as never } } as never);
  const reading = ri.memoryReadingStore();
  setReadingStore(reading);
  serve._setTeaserRenditionWriterForTests({
    async insert(row) {
      reading.renditions.set(row.id, { id: row.id, dealId: row.dealId, mode: row.mode, variant: row.variant, pageIndex: row.pageIndex, createdAt: new Date(Date.now() - 3_600_000) } as never);
    },
  });
  // Teaser reading from the memory store.
  eng._setTeaserEngagementSourceForTests({
    links: async (dealId) => T.access.filter((a) => a.dealId === dealId).map((a) => ({ ...a })),
    requests: async (dealId) => T.approvals.filter((r) => r.dealId === dealId),
    visits: async (dealId) => Array.from(reading.visits.values()).filter((v) => v.dealId === dealId && (v.mode as string) === "teaser" && !v.selfView && !v.clamped)
      .map((v) => ({ accessId: v.buyerAccessId, renditionId: v.renditionId, startedAt: v.startedAt, lastSeenAt: v.lastSeenAt, activeMs: v.activeMs, maxPageIndex: v.maxPageIndex })),
    blockSums: async (dealId) => Array.from(reading.rollups.values()).filter((r) => r.dealId === dealId && (reading.visits.get(r.visitId)?.mode as string) === "teaser")
      .map((r) => ({ accessId: r.buyerAccessId, pageId: r.pageId, attentionMs: r.attentionMs })),
    pageIndexes: async (dealId) => new Map(Array.from(reading.renditions.values()).filter((r) => r.dealId === dealId && r.mode === ("teaser" as never)).map((r) => [r.id, r.pageIndex])),
  });
  summary._resetTeaserSummaryCacheForTests();

  const modelPrompts: Harness["modelPrompts"] = [];
  const modelReplies: Harness["modelReplies"] = [];
  gen._setTeaserModelForTests(async (req) => {
    modelPrompts.push({ system: req.system, user: req.user });
    const next = modelReplies.shift();
    if (!next) throw Object.assign(new Error("test: no model reply queued"), { status: 401 });
    if (next instanceof Error) throw next;
    return { input: next, usage: { input: 1000, output: 500 } };
  });
  gen._setTeaserBriefDepsForTests(dbBriefDeps);

  const S = storage as Row;
  Object.assign(S, {
    getUser: async (uid: string) => find("users", (u) => u.id === uid),
    getUserByEmail: async (e: string) => find("users", (u) => u.email?.toLowerCase() === e.toLowerCase()),
    getDeal: async (did: string) => read("deals", (d) => d.id === did),
    updateDeal: async (did: string, patch: Row) => upd("deals", did, patch),
    getAllDeals: async (bid?: string) => T.deals.filter((d) => !bid || d.brokerId === bid),
    getBrandingByBroker: async (bid: string) => ({ id: `BR-${bid}`, brokerId: bid, companyName: "Brassline Advisory Partners", firmEmail: "morgan@brassline.invalid", firmPhone: "604-555-0100", showDisclaimerPage: true, showContactPage: true, teaserSettings: settings[bid] ?? null }),
    getIntegrationsByBroker: async () => [],
    getDealMembers: async (did: string) => T.members.filter((m) => m.dealId === did),
    getDealMember: async (mid: string) => read("members", (m) => m.id === mid),
    getDealMemberByEmail: async (did: string, e: string) => find("members", (m) => m.dealId === did && m.email === e),
    getSellerInvitesByDealId: async (did: string) => T.invites.filter((i) => i.dealId === did),
    getSellerInviteByToken: async (tok: string) => read("invites", (i) => i.token === tok),
    createNotification: async (row: Row) => { const r = { id: id("N"), createdAt: new Date(), ...row }; T.notifications.push(r); return r; },
    getNotificationsByDeal: async (did: string) => T.notifications.filter((n) => n.dealId === did),
    getBuyerAccessByToken: async (tok: string) => read("access", (a) => a.accessToken === tok),
    getBuyerAccess: async (aid: string) => read("access", (a) => a.id === aid),
    getBuyerAccessByDeal: async (did: string) => T.access.filter((a) => a.dealId === did).map((a) => ({ ...a })),
    getBuyerAccessByBuyerUser: async (bid: string) => T.access.filter((a) => a.buyerUserId === bid).map((a) => ({ ...a })),
    createBuyerAccess: async (row: Row) => { const r = { id: id("A"), decision: "under_review", viewCount: 0, ndaSigned: false, createdAt: new Date(), revokedAt: null, ...row }; T.access.push(r); return { ...r }; },
    updateBuyerAccess: async (aid: string, patch: Row) => { const r = upd("access", aid, patch); return r ? { ...r } : r; },
    recordBuyerNdaSignature: async (aid: string, patch: Row) => {
      const a = find("access", (x) => x.id === aid);
      if (!a || a.ndaSigned) return undefined;
      const r = upd("access", aid, { ...patch, ndaSigned: true });
      return r ? { ...r } : r;
    },
    getBuyerUser: async (bid: string) => read("buyers", (b) => b.id === bid),
    getBuyerUserByEmail: async (e: string) => read("buyers", (b) => b.email === e.toLowerCase().trim()),
    createBuyerUser: async (row: Row) => { const r = { id: id("U"), ...row }; T.buyers.push(r); return r; },
    updateBuyerUser: async (bid: string, patch: Row) => { const r = upd("buyers", bid, patch); return r ? { ...r } : r; },
    upsertBrokerBuyerContact: async (row: Row) => { T.contacts.push(row); return row; },
    getBrokerBuyerContact: async () => undefined,
    createAnalyticsEvent: async (row: Row) => { const r = { id: id("E"), ...row }; T.events.push(r); return r; },
    getCimSectionsByDeal: async (did: string) => T.sections.filter((s) => s.dealId === did),
    getCimSectionOverrides: async (did: string, mode?: string) => T.overrides.filter((o) => o.dealId === did && (!mode || o.mode === mode)),
    getQuestionsByDeal: async (did: string) => T.questions.filter((q) => q.dealId === did),
    getFaqsByDeal: async () => [],
    getBuyerApprovalRequestsByDeal: async (did: string) => T.approvals.filter((r) => r.dealId === did).map((r) => ({ ...r })),
    getBuyerApprovalRequest: async (rid: string) => read("approvals", (r) => r.id === rid),
    getBuyerApprovalRequestByToken: async (tok: string) => read("approvals", (r) => r.sellerReviewToken === tok),
    createBuyerApprovalRequest: async (row: Row) => { const r = { id: id("R"), createdAt: new Date(), updatedAt: new Date(), ...row }; T.approvals.push(r); return { ...r }; },
    updateBuyerApprovalRequest: async (rid: string, patch: Row) => { const r = upd("approvals", rid, { ...patch, updatedAt: new Date() }); return r ? { ...r } : r; },
    createDealOutreach: async (row: Row) => { const r = { id: id("O"), ...row }; T.outreach.push(r); return r; },
    getDealOutreachByDeal: async (did: string) => T.outreach.filter((o) => o.dealId === did),
    getDiscrepanciesByDeal: async (did: string) => T.discrepancies.filter((d) => d.dealId === did),
    getResolvedDiscrepancies: async () => [],
    getFinancialAnalysesByDeal: async () => [],
    getDocumentsByDeal: async () => [],
    getTasksByDeal: async (did: string) => T.tasks.filter((t) => t.dealId === did),
    createTask: async (row: Row) => { const r = { id: id("TK"), createdAt: new Date(), ...row }; T.tasks.push(r); return r; },
    updateTask: async (tid: string, patch: Row) => upd("tasks", tid, patch),
  });
  // Direct db reads on these paths: deal media (none), the broker's buyer list (every buyer), renditions (none).
  (db as Row).select = () => {
    let table: Row = null;
    const chain: Row = {
      from(t: Row) { table = t; return chain; },
      where() { return chain; },
      orderBy() { return chain; },
      limit() { return chain; },
      then(res: Row, rej: Row) {
        const name = table?.[Symbol.for("drizzle:Name")];
        const rows = name === "buyer_users" ? T.buyers.map((b) => ({ id: b.id })) : [];
        return Promise.resolve(rows).then(res, rej);
      },
    };
    return chain;
  };
  (db as Row).execute = async () => [];

  const app = express();
  app.use(express.json());
  app.use((req: Row, _res, next) => {
    req.session = {
      brokerId: req.get("x-test-broker") || undefined,
      buyerId: req.get("x-test-buyer") || undefined,
      save: (cb: Row) => cb?.(), regenerate: (cb: Row) => cb?.(), destroy: (cb: Row) => cb?.(),
    };
    next();
  });
  // The production limiter mounts (server/index.ts "teaser limiters").
  const { applyTeaserRateLimits } = await import("../../server/routes/teaser");
  applyTeaserRateLimits(app, (_req, _res, next) => next());
  const server = await registerRoutes(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call: Harness["call"] = async (method, path, body, headers = {}) => {
    const r = await realFetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json: Row = null;
    try { json = JSON.parse(text); } catch { /* text */ }
    return { status: r.status, json, text };
  };
  return {
    call,
    broker: { "x-test-broker": "B1" },
    teasers,
    checks,
    reading,
    codes,
    modelPrompts,
    modelReplies,
    settle: () => new Promise((r) => setTimeout(r, 60)),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** The standard fixtures: broker B1 (+ B2), the Pacific deal (published CIM, NDA required, a Blind CIM). */
export function seedPacific(o: { isLive?: boolean; ndaRequired?: boolean; demoKey?: string | null } = {}): Row {
  const pac = fixture("pacific-deal.json");
  if (!T.users.some((u) => u.id === "B1")) {
    T.users.push({ id: "B1", role: "broker", username: "morgan", name: "Morgan Ellis", email: "morgan@brassline.invalid", settings: {} });
    T.users.push({ id: "B2", role: "broker", username: "other", name: "Other Broker", email: "other@x.invalid", settings: {} });
  }
  // (The real Pacific's "Project Coastline" shares its root with "Pacific Coast" — the codename check refuses to publish under it.)
  const deal = { ...pac, blindCodename: "Project Meridian", isLive: o.isLive ?? true, ndaRequired: o.ndaRequired ?? true, demoKey: o.demoKey ?? null, cimGeneration: null, designTemplateId: null, updatedAt: new Date(now - DAY), interviewCompleted: true };
  T.deals.push(deal);
  const sec = (sid: string, key: string, title: string, text: string) => ({
    id: sid, dealId: deal.id, sectionKey: key, sectionTitle: title, order: Number(sid.replace(/\D/g, "")), layoutType: "prose_highlight", layoutData: { body: text },
    aiDraftContent: text, brokerEditedContent: null, isVisible: true, brokerApproved: true, blindStaleAt: null, blindTitle: null,
  });
  T.sections.push(sec("S1", "executiveSummary", "Executive summary", "Pacific Coast Logistics Ltd. is a Surrey carrier."));
  T.overrides.push({ id: "OS1", dealId: deal.id, cimSectionId: "S1", mode: "blind", layoutData: { body: "Project Meridian is a regional refrigerated carrier in British Columbia." }, contentOverride: "Project Meridian is a regional refrigerated carrier in British Columbia.", createdAt: new Date() });
  return deal;
}

export function mkAccess(o: Row = {}): Row {
  const a = {
    id: id("A"), dealId: "D-PAC", accessToken: id("tok-"), buyerEmail: "natalie@cascaderidge.invalid", buyerName: "Natalie Vasconcelos",
    buyerCompany: "Cascade Ridge Capital", accessLevel: "teaser_only", ndaSigned: false, decision: "under_review", viewCount: 0,
    firstViewedAt: null, lastAccessedAt: null, revokedAt: null, expiresAt: null, reminderStage: "none", buyerUserId: null, ndaProfile: null,
    accessEvents: [{ type: "granted", at: new Date(now - 3 * DAY).toISOString(), accessLevel: "teaser_only" }], createdAt: new Date(now - 3 * DAY), ...o,
  };
  T.access.push(a);
  return a;
}

/** A valid NDA profile (shared/nda-buyer-profile.ts). */
export const PROFILE = {
  buyerType: "financial", financialKind: "private_equity", name: "Natalie Vasconcelos", phone: "604-555-0199", company: "Cascade Ridge Capital",
  background: "We run two carriers in Alberta and invest in logistics.", lookingFor: "A regional trucking platform in BC, $10M–$25M revenue.",
  priceMin: 10_000_000, priceMax: 25_000_000, funding: "fund", proofOfFunds: "yes", timeline: "3_6",
};
