/**
 * The owner sees what buyers read about their figures, in their words, and
 * can ask for a change (spec D22, §6, §9.2 seller routes). No network, no AI:
 * an in-process Postgres (PGlite) for dd's tables, the Lakeshore fixture,
 * storage stubbed.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/figure-seller-flag.test.ts
 *
 * Proves:
 *   - the list = approved notes based on the owner or a conversation with the
 *     owner, served to buyers, under the section that shows the figure; never
 *     a suggested note, a worked-out or document-based note, hints, source
 *     quotes or another deal's notes;
 *   - the owner's link flags a note: hidden from buyers at once (the buyer
 *     layer no longer serves it), the comment kept for the broker, the broker
 *     told (cim_changes_requested, an existing event; a demo deal never emails);
 *   - an accountant's link → 403; a note of another deal → 404; an empty or
 *     over-long comment → 400; the deal's own broker → 403.
 */
import assert from "node:assert/strict";
import { fixtureRaw, figurePglite, run, test } from "./helpers/figure-test";

delete process.env.RESEND_API_KEY;
const { storage } = await import("../../server/storage");
const { _useFigureDbForTests, listNotes, getNote } = await import("../../server/cim/figures/store");
const { _setSellerFigureDepsForTests, sellerFigureNotes } = await import("../../server/cim/figures/seller");
const { figureInputsFor, _clearFigureRawCache } = await import("../../server/cim/figures/serve");
const { buildFigureLayer } = await import("../../shared/figure-layer");
const { registerSellerReviewRoutes } = await import("../../server/routes/seller-review");

const { db, pg } = await figurePglite();
_useFigureDbForTests(db);

const base = await fixtureRaw("lakeshore");
const DEAL = base.fx.deal.id;
const sections = base.fx.sections.map((s) => ({ ...s, isVisible: true, blindStaleAt: null, ddStaleAt: null, aiTask: null, aiDraftContent: null, brokerEditedContent: null, blindStatus: null })) as any[];

async function insertNote(over: Record<string, any>) {
  const n = {
    deal_id: DEAL, kind: "movement", compare_key: "2022", origin: "ai", status: "approved", blind_text: null,
    sources: [{ kind: "interview", sessionId: "s1", messageIndex: 4, quote: "We added two new install crews in 2023." }],
    input_fingerprint: "fp", history: [],
    ...over,
  };
  await pg.query(
    `INSERT INTO cim_figure_notes (id, deal_id, figure_key, kind, compare_key, origin, status, text, blind_text, sources, values_snapshot, input_fingerprint, history, approved_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())`,
    [n.id, n.deal_id, n.figure_key, n.kind, n.compare_key, n.origin, n.status, n.text, n.blind_text, JSON.stringify(n.sources), JSON.stringify(n.values_snapshot), n.input_fingerprint, JSON.stringify(n.history)],
  );
}
const REV = { year: "2023", value: 6840000, fromYear: "2022", fromValue: 6180000 };
await insertNote({ id: "owner-rev", figure_key: "revenue|2023", text: "Two new installation crews started in 2023, so more replacement jobs were completed.", values_snapshot: REV });
await insertNote({ id: "computed-cos", figure_key: "costOfSales|2023", origin: "computed", sources: [{ kind: "computed" }], text: "Up $334,000 (10%) from FY2022.", values_snapshot: { year: "2023", value: 3822000, fromYear: "2022", fromValue: 3488000 } });
await insertNote({ id: "owner-suggested", figure_key: "grossProfit|2023", status: "suggested", text: "Suggested only.", values_snapshot: { year: "2023", value: 3018000, fromYear: "2022", fromValue: 2692000 } });
await insertNote({ id: "other-deal", deal_id: "another-deal", figure_key: "revenue|2023", text: "Someone else's note.", values_snapshot: REV });

/** Raw inputs from the fixture + the notes in PGlite (as loadFigureRaw would read them). */
_setSellerFigureDepsForTests({ loadRaw: async () => (await fixtureRaw("lakeshore", { notes: await listNotes(DEAL) })).raw });

const deal: any = {
  id: DEAL, businessName: base.fx.deal.businessName, blindCodename: base.fx.deal.blindCodename, extractedInfo: base.fx.facts,
  contentApprovedByBroker: true, designApprovedByBroker: true, designApprovedBySeller: false, demoKey: "lakeshore-qa", brokerId: "broker-1",
};
const invites: Record<string, any> = {
  "owner-tok": { id: "i1", dealId: DEAL, token: "owner-tok", sellerEmail: "owner@qa-oct.invalid", sellerName: "Dana" },
  "acct-tok": { id: "i2", dealId: DEAL, token: "acct-tok", sellerEmail: "acct@qa-oct.invalid", sellerName: "Avi" },
};
const notifications: any[] = [];
const s = storage as any;
s.getSellerInviteByToken = async (t: string) => invites[t];
s.getDeal = async () => deal;
s.getDealMembers = async () => [{ id: "m1", teamType: "seller", role: "accountant", email: "acct@qa-oct.invalid", inviteStatus: "accepted", permissions: [] }];
s.getCimSectionsByDeal = async () => sections;
s.getTasksByDeal = async () => [];
s.getUser = async () => ({ id: "broker-1", email: "broker@qa-oct.invalid", settings: {} });
s.createNotification = async (n: any) => { notifications.push(n); return n; };

const handlers: Record<string, any[]> = {};
const app: any = {
  get: (p: string, ...h: any[]) => { handlers[`GET ${p}`] = h; },
  post: (p: string, ...h: any[]) => { handlers[`POST ${p}`] = h; },
};
registerSellerReviewRoutes(app);
const flagRoute = handlers["POST /api/seller/:token/cim-review/figure-notes/:noteId/flag"];

async function flag(token: string, noteId: string, body: any, session: any = {}) {
  let status = 200;
  let json: any = null;
  const res: any = { status(c: number) { status = c; return res; }, json(b: any) { json = b; return res; } };
  await flagRoute[flagRoute.length - 1]({ params: { token, noteId }, body, session }, res);
  return { status, json };
}

const buyerServes = async (noteId: string) => {
  _clearFigureRawCache();
  const raw = (await fixtureRaw("lakeshore", { notes: await listNotes(DEAL) })).raw;
  const layer = buildFigureLayer(sections, figureInputsFor(raw, { audience: "buyer", mode: "normal" }), "normal");
  return JSON.stringify(layer ?? {}).includes(`"id":"${noteId}"`);
};

test("the route is behind the seller-review rate limiter", () => {
  assert.ok(flagRoute.length >= 2, "limiter + handler");
});

test("the list: only approved owner-quoted notes buyers are served, under their section; nothing else", async () => {
  const list = await sellerFigureNotes(deal, sections);
  assert.deepEqual(list.map((n) => n.id), ["owner-rev"]);
  const n = list[0];
  assert.deepEqual(Object.keys(n).sort(), ["basisLabel", "id", "label", "sectionId", "sectionTitle", "text"]);
  assert.equal(n.label, "Revenue, 2023");
  assert.equal(n.basisLabel, "From what you told us");
  assert.ok(sections.some((sec) => sec.id === n.sectionId && sec.sectionTitle === n.sectionTitle));
  const json = JSON.stringify(list);
  for (const banned of ["Suggested only", "Someone else", "We added two new install crews", "sessionId", "hint", "Cimple's analysis"]) {
    assert.ok(!json.includes(banned), `no "${banned}" in the seller payload`);
  }
});

test("an accountant's link reads only: 403", async () => {
  const r = await flag("acct-tok", "owner-rev", { comment: "Wrong year." });
  assert.equal(r.status, 403);
  assert.equal(r.json.code, "not_owner");
  assert.equal((await getNote(DEAL, "owner-rev"))!.staleReason, null);
});

test("another deal's note, a suggested note or a worked-out note: 404", async () => {
  for (const id of ["other-deal", "owner-suggested", "computed-cos", "nope"]) {
    const r = await flag("owner-tok", id, { comment: "Please change." });
    assert.equal(r.status, 404, id);
  }
  assert.equal((await getNote("another-deal", "other-deal"))!.staleReason, null);
});

test("an empty or over-long comment: 400; the deal's own broker: 403", async () => {
  assert.equal((await flag("owner-tok", "owner-rev", { comment: "  " })).status, 400);
  assert.equal((await flag("owner-tok", "owner-rev", { comment: "x".repeat(501) })).status, 400);
  const asBroker = await flag("owner-tok", "owner-rev", { comment: "Hi" }, { brokerId: "broker-1" });
  assert.equal(asBroker.status, 403);
  assert.equal(asBroker.json.code, "broker_preview");
  assert.equal((await flag("unknown-tok", "owner-rev", { comment: "Hi" })).status, 404);
  assert.equal((await getNote(DEAL, "owner-rev"))!.staleReason, null);
});

test("the owner flags: hidden from buyers at once, comment kept for the broker, broker told (no email on a demo deal)", async () => {
  assert.ok(await buyerServes("owner-rev"), "served before");
  const r = await flag("owner-tok", "owner-rev", { comment: "The crews started in late 2022, not 2023." });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const row = (await getNote(DEAL, "owner-rev"))!;
  assert.equal(row.staleReason, "seller_flagged");
  assert.equal(row.sellerComment, "The crews started in late 2022, not 2023.");
  assert.ok((row.history as any[]).some((h) => h.by === "owner" && h.what === "flagged"));
  assert.equal(await buyerServes("owner-rev"), false, "hidden from buyers at once");
  assert.deepEqual((await sellerFigureNotes(deal, sections)).map((n) => n.id), [], "gone from the owner's list");
  await new Promise((r2) => setTimeout(r2, 50));
  const notice = notifications.find((n) => n.type === "cim_changes_requested");
  assert.ok(notice, "the broker is told");
  assert.equal(notice.emailSent, false, "a demo deal never emails");
  assert.match(notice.body, /Revenue, 2023/);
  assert.match(notice.actionUrl, /view=numbers&tab=moves&filter=look&note=owner-rev/);
  // A second flag on the same note: it isn't shown any more.
  assert.equal((await flag("owner-tok", "owner-rev", { comment: "Again." })).status, 404);
});

await run("figure-seller-flag (D22)");
