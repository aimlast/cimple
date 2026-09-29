/**
 * Reading ingest (server/analytics/reading-ingest.ts, server/routes/reading.ts)
 * and renditions (server/analytics/renditions.ts): what the view room's
 * tracker sends is validated, clamped, merged idempotently and counted as
 * views per visit. In-memory store; no database, no AI.
 *
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/reading-ingest.test.ts
 */
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import {
  ingestReading, memoryReadingStore, planIngest, viewRoomStamp, networkKey, uaFamilyOf,
  type IngestInput, type MemoryReadingStore,
} from "../../server/analytics/reading-ingest";
import { buildPageIndex, recordRendition, renditionId, servedPageOrder, variantForAccessLevel, _resetRenditionCache } from "../../server/analytics/renditions";
import { withBrokeragePages } from "../../client/src/components/cim/CimFrontBackPages";
import type { ReadingPayload } from "../../shared/analytics-v2";
import type { BuyerSection } from "../../shared/cim-buyer-view";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}`); throw e; }
}

const S = (id: string, order: number, layoutType: string, sectionTitle: string, layoutData: unknown, extra: Partial<BuyerSection> = {}): BuyerSection => ({
  id, dealId: "deal1", sectionKey: `s_${id}`, sectionTitle, order, layoutType, layoutData, aiDraftContent: null, brokerEditedContent: null, isVisible: true, ...extra,
});
const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const P3 = "33333333-3333-4333-8333-333333333333";
const blindSections: BuyerSection[] = [
  S(P1, 0, "cover_page", "Project Coastal", { title: "Project Coastal" }),
  S(P2, 1, "financial_table", "Historical Financial Performance", { headers: ["", "2023", "2024"], rows: [{ label: "Revenue", values: ["$1.2M", "$1.4M"] }, { label: "Adjusted EBITDA", values: ["$300K", "$380K"] }] }),
  S(P3, 2, "metric_grid", "The Practice at a Glance", { metrics: [{ label: "Chairs", value: "9" }, { label: "Patients", value: "4,100" }] }),
];
const design = { template: { id: "classic", name: "", tokens: {} }, brokerage: { showDisclaimerPage: true, showContactPage: true }, business: null };

console.log("renditions");
await test("page order mirrors the view room (disclaimer after the cover, contact last)", () => {
  for (const [secs, d] of [
    [blindSections, design],
    [blindSections.slice(1), design],
    [blindSections, { brokerage: { showDisclaimerPage: false, showContactPage: true } }],
    [blindSections, { brokerage: { showDisclaimerPage: true, showContactPage: false } }],
    [[], design],
  ] as const) {
    const client = withBrokeragePages(secs as BuyerSection[], {
      disclaimer: (d as any).brokerage.showDisclaimerPage !== false, contact: (d as any).brokerage.showContactPage !== false,
    }).map((i) => (i.kind === "section" ? i.section.id : i.key));
    assert.deepEqual(servedPageOrder(secs as BuyerSection[], d as any), client);
  }
});
await test("page index: served titles, lineage, parts, blocks labelled from the SERVED data", () => {
  const idx = buildPageIndex(blindSections, design, [{ id: P2, analyticsLineage: "lin-fin" }]);
  assert.deepEqual(idx.map((p) => p.pageId), [P1, "cim-disclaimer", P2, P3, "cim-contact"]);
  assert.deepEqual(idx.map((p) => p.order), [0, 1, 2, 3, 4]);
  const fin = idx[2];
  assert.equal(fin.lineageId, "lin-fin");
  assert.equal(fin.lineageId !== fin.pageId, true);
  assert.equal(idx[3].lineageId, P3, "no lineage → its own id");
  assert.equal(fin.servedTitle, "Historical Financial Performance");
  assert.ok(fin.blocks.some((b) => b.key === "row:1" && b.label === "Row: Adjusted EBITDA"));
  assert.ok(fin.expectedMs > 0 && fin.parts === 1);
  const labels = JSON.stringify(idx);
  assert.ok(!/Harbourline/.test(labels), "nothing but the served (blind) words");
});
await test("identical servings share one id; any change is a new one; written once per process", async () => {
  _resetRenditionCache();
  const a = renditionId({ mode: "blind", variant: "full", design, sections: blindSections });
  assert.equal(a, renditionId({ mode: "blind", variant: "full", design: JSON.parse(JSON.stringify(design)), sections: JSON.parse(JSON.stringify(blindSections)) }));
  assert.notEqual(a, renditionId({ mode: "blind", variant: "teaser", design, sections: blindSections }));
  assert.match(a, /^[0-9a-f]{32}$/);
  const writes: string[] = [];
  const writer = { insert: async (r: { id: string }) => { writes.push(r.id); } };
  const input = { dealId: "deal1", mode: "blind" as const, variant: "full" as const, cimLayoutVersion: 3, sections: blindSections, design, live: [] };
  const r1 = await recordRendition(input, writer);
  const r2 = await recordRendition(input, writer);
  assert.equal(r1!.renditionId, a);
  assert.deepEqual(r1!.pageOrder, [P1, "cim-disclaimer", P2, P3, "cim-contact"]);
  assert.deepEqual(r2, r1);
  assert.equal(writes.length, 1);
  const failing = { insert: async () => { throw new Error("db down"); } };
  _resetRenditionCache();
  assert.equal(await recordRendition(input, failing), null, "a failure never breaks the view room");
  assert.equal(await recordRendition({ ...input, sections: [] }, writer), null);
});
await test("variants: teaser gets its own; every other level is full", () => {
  assert.equal(variantForAccessLevel("teaser"), "teaser");
  for (const l of ["full", "loi", "due_diligence"]) assert.equal(variantForAccessLevel(l), "full");
});

// ── Ingest ───────────────────────────────────────────────────────────────
console.log("ingest");
const T0 = new Date("2026-09-20T12:00:00Z");
const blindId = renditionId({ mode: "blind", variant: "full", design, sections: blindSections });
function freshStore(): MemoryReadingStore {
  const s = memoryReadingStore();
  s.renditions.set(blindId, { id: blindId, dealId: "deal1", mode: "blind", variant: "full", createdAt: new Date(T0.getTime() - 3600_000), pageIndex: buildPageIndex(blindSections, design, [{ id: P2, analyticsLineage: "lin-fin" }]) });
  s.renditions.set("f".repeat(32), { id: "f".repeat(32), dealId: "other", mode: "blind", variant: "full", createdAt: T0, pageIndex: [] });
  return s;
}
const V1 = "aaaaaaaa-0000-4000-8000-000000000001";
const payload = (over: Partial<ReadingPayload> = {}): ReadingPayload => ({
  visitId: V1,
  renditionId: blindId,
  sentAt: T0.toISOString(),
  device: { w: 1440, h: 900, touch: false, dpr: 2 },
  visit: { wallMs: 60_000, activeMs: 50_000, idleMs: 10_000, hiddenMs: 0, awayMs: 0, outsideMs: 2_000, maxPageIndex: 2 },
  blocks: { [`${P2}|row:1`]: [30_000, 2_000, 40_000, 5_000], [`${P2}|`]: [6_000, 0, 20_000, 0], [`${P1}|page`]: [10_000, 0, 10_000, 0] },
  path: { from: 0, entries: [[0, P1], [12, P2]] },
  events: [{ seq: 1, type: "financial_view", pageId: P2, detail: "normalized", at: T0.toISOString() }],
  ...over,
});
const access = { id: "acc1", dealId: "deal1", accessLevel: "full" };
const input = (p: ReadingPayload, now = new Date(T0.getTime() + 61_000), over: Partial<IngestInput> = {}): IngestInput =>
  ({ deal: { id: "deal1" }, access, payload: p, now, selfView: false, ipHash: "net1", uaFamily: "Chrome/Mac", ...over });

await test("a first send stores the visit, its parts (lineage) and events, and counts one view", async () => {
  const s = freshStore();
  const r = await ingestReading(s, input(payload()));
  assert.equal(r.status, 204);
  assert.equal(r.newVisit, true);
  assert.equal(r.viewCounted, true);
  assert.equal(s.viewCounts.get("acc1"), 1);
  const v = s.visits.get(V1)!;
  assert.equal(v.activeMs, 50_000);
  assert.equal(v.deviceClass, "desktop");
  assert.equal(v.maxPageIndex, 2);
  assert.deepEqual(v.path, [[0, P1], [12, P2]]);
  assert.equal(s.rollups.get(`${V1}|${P2}|row:1`)!.lineageId, "lin-fin");
  assert.equal(s.rollups.get(`${V1}|${P1}|page`)!.lineageId, P1);
  assert.equal(s.events.size, 1);
  assert.equal([...s.events.values()][0].detail, "normalized");
});

await test("resends, duplicates and out-of-order sends never double count (GREATEST)", async () => {
  const s = freshStore();
  const t1 = new Date(T0.getTime() + 61_000);
  const later = payload({
    visit: { ...payload().visit, wallMs: 80_000, activeMs: 70_000 },
    blocks: { [`${P2}|row:1`]: [45_000, 2_000, 55_000, 5_000] },
    path: { from: 2, entries: [[50, P3]] },
    events: [{ seq: 1, type: "financial_view", pageId: P2, detail: "normalized", at: T0.toISOString() }, { seq: 2, type: "expand", pageId: P3, at: T0.toISOString() }],
  });
  await ingestReading(s, input(payload(), t1));
  await ingestReading(s, input(later, new Date(t1.getTime() + 20_000)));
  await ingestReading(s, input(payload(), new Date(t1.getTime() + 21_000)));   // a late copy of the first send
  await ingestReading(s, input(later, new Date(t1.getTime() + 22_000)));       // a duplicate
  const row = s.rollups.get(`${V1}|${P2}|row:1`)!;
  assert.equal(row.attentionMs, 45_000);
  assert.equal(s.visits.get(V1)!.activeMs, 70_000);
  assert.deepEqual(s.visits.get(V1)!.path, [[0, P1], [12, P2], [50, P3]]);
  assert.equal(s.events.size, 2, "a repeated event seq is stored once");
  assert.equal(s.viewCounts.get("acc1"), 1, "one visit, one view");
});

await test("a foreign rendition, an unknown page and another buyer's visit are refused", async () => {
  const s = freshStore();
  assert.equal((await ingestReading(s, input(payload({ renditionId: "0".repeat(32) })))).status, 400, "unknown rendition");
  assert.equal((await ingestReading(s, input(payload({ renditionId: "f".repeat(32) })))).status, 400, "another deal's rendition");
  assert.equal((await ingestReading(s, input(payload(), undefined, { access: { ...access, accessLevel: "teaser" } }))).status, 400, "another version (teaser)");
  assert.equal((await ingestReading(s, input(payload(), undefined, { access: { ...access, accessLevel: "loi" } }))).status, 400, "another version (named)");
  assert.equal((await ingestReading(s, input(payload({ blocks: { "99999999-9999-4999-8999-999999999999|row:0": [1, 0, 0, 0] } })))).status, 400, "unknown page");
  assert.equal((await ingestReading(s, input(payload({ path: { from: 0, entries: [[0, "not-a-page"]] } })))).status, 400);
  assert.equal((await ingestReading(s, input(payload({ events: [{ seq: 1, type: "copy", pageId: "nope", at: "x" }] })))).status, 400);
  assert.equal(s.visits.size, 0, "nothing stored");
  assert.equal((await ingestReading(s, input(payload()))).status, 204);
  const other = await ingestReading(s, input(payload(), undefined, { access: { id: "acc2", dealId: "deal1", accessLevel: "full" } }));
  assert.equal(other.status, 409, "a visit id of another buyer link");
  assert.equal(s.visits.get(V1)!.buyerAccessId, "acc1");
});

await test("the clamp: never more active time than the server saw elapse, never more reading than active time", async () => {
  const s = freshStore();
  // First send claims 2 h of reading 5 s after the rendition was served.
  const r = await ingestReading(s, input(payload({
    visit: { wallMs: 7_200_000, activeMs: 7_200_000, idleMs: 0, hiddenMs: 0, awayMs: 0, outsideMs: 0, maxPageIndex: 2 },
    blocks: { [`${P2}|row:1`]: [7_000_000, 0, 7_200_000, 0] },
  }), new Date(T0.getTime() - 3600_000 + 5_000)));
  assert.equal(r.status, 204);
  assert.equal(r.clamped, true);
  const v = s.visits.get(V1)!;
  assert.ok(v.activeMs <= 25_000, `active ${v.activeMs}`);
  assert.ok(s.rollups.get(`${V1}|${P2}|row:1`)!.attentionMs <= v.activeMs);
  assert.equal(v.clamped, true);
  // Parts claiming more than the visit's active time are scaled down to it.
  const s2 = freshStore();
  await ingestReading(s2, input(payload({ blocks: { [`${P2}|row:1`]: [40_000, 0, 1, 0], [`${P3}|metric:0`]: [40_000, 0, 1, 0] } })));
  const sum = s2.rollups.get(`${V1}|${P2}|row:1`)!.attentionMs + s2.rollups.get(`${V1}|${P3}|metric:0`)!.attentionMs;
  assert.ok(sum <= 50_000, `${sum}`);
  assert.equal(s2.visits.get(V1)!.clamped, true);
});

await test("the clamp is anchored to the visit, not the version's age: a first send claiming 6 h gets at most 3 min", async () => {
  const s = freshStore();
  // The rendition has been live for an hour (T0 - 1 h); a 5-second-old visit claims 6 h.
  const sixH = 6 * 3_600_000;
  const r = await ingestReading(s, input(payload({
    visit: { wallMs: sixH, activeMs: sixH, idleMs: 0, hiddenMs: 0, awayMs: 0, outsideMs: 0, maxPageIndex: 2 },
    blocks: { [`${P2}|row:1`]: [sixH - 1000, 0, sixH, 0] },
  }), new Date(T0.getTime() + 5_000)));
  assert.equal(r.clamped, true);
  const v = s.visits.get(V1)!;
  assert.ok(v.activeMs <= 180_000, `active ${v.activeMs}`);
  assert.ok(s.rollups.get(`${V1}|${P2}|row:1`)!.attentionMs <= v.activeMs);
  assert.ok(s.rollups.get(`${V1}|${P2}|row:1`)!.visibleMs <= v.activeMs);
  // A later send may only add the time since the visit was last active.
  await ingestReading(s, input(payload({
    visit: { wallMs: sixH + 30_000, activeMs: sixH + 30_000, idleMs: 0, hiddenMs: 0, awayMs: 0, outsideMs: 0, maxPageIndex: 2 },
    blocks: { [`${P2}|row:1`]: [sixH + 20_000, 0, sixH, 0] },
  }), new Date(T0.getTime() + 35_000)));
  assert.ok(s.visits.get(V1)!.activeMs <= v.activeMs + 30_000 + 20_000, `${s.visits.get(V1)!.activeMs}`);
  // An honest visit is never clamped: 15 s sends that grow with real time.
  const h = freshStore();
  let t = T0.getTime();
  for (let k = 1; k <= 8; k++) {
    t += 15_000;
    const res = await ingestReading(h, input(payload({
      visitId: V1, events: [],
      visit: { wallMs: k * 15_000, activeMs: k * 15_000 - 200, idleMs: 0, hiddenMs: 0, awayMs: 0, outsideMs: 0, maxPageIndex: 2 },
      blocks: { [`${P2}|row:1`]: [k * 15_000 - 400, 0, k * 15_000 - 400, 0] },
      path: { from: 0, entries: [] },
    }), new Date(t + 300)));
    assert.equal(res.clamped, false, `send ${k}`);
  }
  assert.equal(h.visits.get(V1)!.activeMs, 8 * 15_000 - 200);
});

await test("last_seen_at is the last ACTIVE moment: idle or hidden time never moves it", async () => {
  const s = freshStore();
  const t1 = new Date(T0.getTime() + 61_000);
  await ingestReading(s, input(payload(), t1));
  assert.equal(s.visits.get(V1)!.lastSeenAt.getTime(), t1.getTime());
  // The buyer walked away: the beacon on hide brings idle + hidden time only.
  const idle = payload({ visit: { ...payload().visit, wallMs: 400_000, idleMs: 200_000, hiddenMs: 140_000 }, events: [], path: { from: 2, entries: [] } });
  await ingestReading(s, input(idle, new Date(t1.getTime() + 340_000)));
  const v = s.visits.get(V1)!;
  assert.equal(v.lastSeenAt.getTime(), t1.getTime(), "an idle tab is not 'reading now'");
  assert.equal(v.idleMs, 200_000);
  // Reading again moves it.
  const back = new Date(t1.getTime() + 400_000);
  await ingestReading(s, input(payload({ visit: { ...idle.visit, wallMs: 460_000, activeMs: 70_000 }, events: [], path: { from: 2, entries: [] } }), back));
  assert.equal(s.visits.get(V1)!.lastSeenAt.getTime(), back.getTime());
  // A visit whose first send has no active time at all: last active = its start.
  const s2 = freshStore();
  await ingestReading(s2, input(payload({ visit: { wallMs: 50_000, activeMs: 0, idleMs: 50_000, hiddenMs: 0, awayMs: 0, outsideMs: 0, maxPageIndex: 0 }, blocks: {}, path: { from: 0, entries: [] }, events: [] }), t1));
  assert.equal(s2.visits.get(V1)!.lastSeenAt.getTime(), t1.getTime() - 50_000);
});

await test("self views are stored as such and never count as a view", async () => {
  const s = freshStore();
  const r = await ingestReading(s, input(payload(), undefined, { selfView: true }));
  assert.equal(r.status, 204);
  assert.equal(s.visits.get(V1)!.selfView, true);
  assert.equal(s.viewCounts.get("acc1") ?? 0, 0);
});

await test("views: one per visit, and a new visit within 30 min of another is the same view", async () => {
  const s = freshStore();
  const v = (n: number) => `aaaaaaaa-0000-4000-8000-00000000000${n}`;
  await ingestReading(s, input(payload({ visitId: v(1) }), new Date(T0.getTime() + 61_000)));
  await ingestReading(s, input(payload({ visitId: v(2) }), new Date(T0.getTime() + 20 * 60_000)));      // a second tab / reload within 30 min
  await ingestReading(s, input(payload({ visitId: v(3) }), new Date(T0.getTime() + 3 * 3600_000)));     // back 3 h later
  await ingestReading(s, input(payload({ visitId: v(4) }), new Date(T0.getTime() + 26 * 3600_000)));    // the next day
  assert.equal(s.viewCounts.get("acc1"), 3);
});

await test("the plan never trusts page ids, only keys it can place; event details are structural", () => {
  const s = freshStore();
  const plan = planIngest(input(payload({ events: [{ seq: 1, type: "nav", pageId: P2, detail: `toc:${P3}`, at: "t" }, { seq: 2, type: "copy", pageId: P2, detail: "Harbourline Dental Group Inc", at: "t" }] })),
    s.renditions.get(blindId)!, null, []);
  assert.ok(plan.ok);
  if (plan.ok) {
    assert.equal(plan.events[0].detail, `toc:${P3}`);
    assert.equal(plan.events[1].detail, null, "free text in a detail is dropped");
  }
});

await test("no raw IP or user agent: a per-deal keyed hash and a browser family", () => {
  const a = networkKey("deal1", "203.0.113.9")!;
  assert.match(a, /^[0-9a-f]{24}$/);
  assert.notEqual(a, networkKey("deal2", "203.0.113.9"), "not linkable across deals");
  assert.ok(!a.includes("203"));
  assert.equal(networkKey("deal1", null), null);
  assert.equal(uaFamilyOf("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36"), "Chrome/Mac");
  assert.equal(uaFamilyOf("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1"), "Safari/iOS");
  assert.equal(uaFamilyOf(null), null);
});

await test("the view room GET still stamps firstViewedAt but no longer counts views", () => {
  const now = new Date("2026-09-20T12:00:00Z");
  const fresh = { firstViewedAt: null, lastAccessedAt: null, viewCount: 0 };
  assert.deepEqual(viewRoomStamp(fresh, true, now), { lastAccessedAt: now, firstViewedAt: now });
  assert.deepEqual(viewRoomStamp(fresh, false, now), { lastAccessedAt: now }, "NDA form / preparing: not a view");
  const seen = { firstViewedAt: new Date("2026-09-01"), lastAccessedAt: new Date("2026-09-01"), viewCount: 4 };
  assert.deepEqual(viewRoomStamp(seen, true, now), { lastAccessedAt: now }, "firstViewedAt never moves; no count");
});

// ── The route: gates, NDA, text/plain beacons ─────────────────────────────
console.log("route");
const deals: any[] = [{ id: "deal1", brokerId: "brokerA", isLive: true, ndaRequired: true }];
const accesses: any[] = [
  { id: "acc1", dealId: "deal1", accessToken: "tok1", accessLevel: "full", ndaSigned: true },
  { id: "acc2", dealId: "deal1", accessToken: "tok2", accessLevel: "full", ndaSigned: false },
];
const { storage } = await import("../../server/storage");
Object.assign(storage as any, {
  getDeal: async (id: string) => deals.find((d) => d.id === id),
  getBuyerAccessByToken: async (t: string) => accesses.find((a) => a.accessToken === t),
});
const { registerReadingRoutes, setReadingStore } = await import("../../server/routes/reading");
const store = freshStore();
setReadingStore(store);
const app = express();
app.use((req, _res, next) => { (req as any).session = { brokerId: req.headers["x-test-broker"] || undefined }; next(); });
registerReadingRoutes(app);
const server = app.listen(0);
const port = (server.address() as AddressInfo).port;
const post = async (token: string, body: unknown, headers: Record<string, string> = {}) =>
  (await fetch(`http://127.0.0.1:${port}/api/view/${token}/reading`, { method: "POST", headers: { "content-type": "text/plain", ...headers }, body: JSON.stringify(body) })).status;
try {
  await test("NDA required and not signed → 204 and nothing stored", async () => {
    assert.equal(await post("tok2", payload()), 204);
    assert.equal(store.visits.size, 0);
    assert.equal(store.rollups.size, 0);
  });
  await test("a signed buyer's beacon is stored; a foreign rendition is 400", async () => {
    assert.equal(await post("tok1", payload({ sentAt: new Date().toISOString() })), 204);
    assert.equal(store.visits.size, 1);
    assert.equal(await post("tok1", payload({ visitId: "aaaaaaaa-0000-4000-8000-0000000000ff", renditionId: "0".repeat(32) })), 400);
  });
  await test("the owning broker's preview is a self view", async () => {
    const id = "aaaaaaaa-0000-4000-8000-0000000000ee";
    assert.equal(await post("tok1", payload({ visitId: id }), { "x-test-broker": "brokerA" }), 204);
    assert.equal(store.visits.get(id)!.selfView, true);
    const id2 = "aaaaaaaa-0000-4000-8000-0000000000dd";
    assert.equal(await post("tok1", payload({ visitId: id2 }), { "x-test-broker": "brokerB" }), 204);
    assert.equal(store.visits.get(id2)!.selfView, false, "another broker's session is not the owner");
  });
} finally {
  server.close();
}

console.log(`\n${passed} passed`);
process.exit(0);
