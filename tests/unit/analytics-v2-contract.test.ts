/**
 * The analytics-v2 contract (feat/analytics-base): the block registry, the
 * ingest payload schema, filters, labels, roles, and the broker/buyer route
 * stubs' auth and tenancy. No database, no AI.
 *
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/analytics-v2-contract.test.ts
 */
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import type { AddressInfo } from "node:net";
import {
  BLOCK_KEY_RE, blockFingerprint, blockLabel, blocksOf, chartOfPoint, chartPointKey, expectedMsOf, isValidBlockKey,
  joinBlockKey, kindGroupOf, paginate, partCount, topSegment, BLOCK_KINDS,
} from "../../shared/cim-blocks";
import {
  deviceClassOf, engagementFiltersQuery, formatReadingTime, parseEngagementFilters, readingPayloadSchema, splitBlockId,
  viewerPagesOf, blockId, READING_RULES,
} from "../../shared/analytics-v2";
import { groupReadLabel, readLabel } from "../../shared/cim-reading-model";
import { pageRole } from "../../shared/cim-page-role";
import { pulseSentence } from "../../server/engagement/insights";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    throw err;
  }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, "..", "fixtures", "cim");
const realSections = ["ridgeline-acc-sections.json", "pacific-acc2-sections.json", "pacific-v-sections.json"]
  .flatMap((f) => JSON.parse(fs.readFileSync(path.join(FIX, f), "utf8")) as any[])
  .map((s, i) => ({ id: `s${i}`, ...s }));

// ── Block keys never carry CIM text ──────────────────────────────────────
console.log("block keys");
/** Every name a key segment may have. Anything else would be text leaking into a key. */
const SEGMENT_NAMES = new Set([
  "heading", "caption", "intro", "metric", "primary", "stat", "desc", "item", "event", "row", "nrow", "head", "foot",
  "chart", "point", "para", "quote", "highlight", "left", "right", "tags", "node", "loc", "gallery", "video", "map",
  "page", "locked", "summary",
]);
await test("every key of 74 real sections is structural (fixed names + indexes only)", () => {
  let n = 0;
  for (const s of realSections) {
    for (const b of blocksOf(s)) {
      n++;
      assert.ok(isValidBlockKey(b.key), `invalid ${b.key}`);
      for (const seg of b.key.split("/")) {
        const name = seg.split(":")[0];
        assert.ok(SEGMENT_NAMES.has(name), `segment "${name}" in ${b.key} (${s.sectionTitle})`);
      }
      assert.ok((BLOCK_KINDS as readonly string[]).includes(b.kind));
    }
  }
  assert.ok(n > 500, `only ${n} blocks`);
});
await test("isValidBlockKey accepts structure and rejects text, depth and length", () => {
  for (const k of ["", "heading", "row:3", "left/para:12", "left/chart/point:4", "nrow:999"]) assert.ok(isValidBlockKey(k), k);
  for (const k of ["Revenue", "row:3a", "row:1000", "a/b/c/d", "left/", "x".repeat(41), "row 1", "ROW:1", "harbourline dental", null, 7]) {
    assert.ok(!isValidBlockKey(k), String(k));
  }
  assert.ok(BLOCK_KEY_RE.test("page"));
});
await test("key helpers", () => {
  assert.equal(joinBlockKey("", "row:1"), "row:1");
  assert.equal(joinBlockKey("left", "row:1"), "left/row:1");
  assert.equal(chartPointKey("left/chart", 4), "left/chart/point:4");
  assert.equal(chartOfPoint("left/chart/point:4"), "left/chart");
  assert.equal(chartOfPoint("row:4"), null);
  assert.equal(topSegment("left/row:3"), "left");
  assert.equal(kindGroupOf("table"), "tables");
  assert.equal(kindGroupOf("point"), "charts");
});

// ── Pagination, labels, fingerprints ─────────────────────────────────────
console.log("pages and labels");
const longProse = { id: "p", layoutType: "prose_highlight", sectionTitle: "Market", layoutData: { body: Array.from({ length: 14 }, (_, i) => `Paragraph ${i} ${"word ".repeat(110)}`).join("\n\n"), pullQuote: "Q", highlights: ["h1", "h2"] } };
await test("a long section splits into printed parts at block boundaries, stably", () => {
  const a = blocksOf(longProse);
  const b = blocksOf(longProse);
  assert.deepEqual(a.map((x) => x.part), b.map((x) => x.part));
  assert.ok(partCount(a) >= 2, `parts ${partCount(a)}`);
  assert.equal(a.find((x) => x.key === "heading")!.part, 0);
  assert.equal(a.find((x) => x.key === "para:0")!.part, 0);
  assert.equal(a.find((x) => x.key === "quote")!.part, 0, "the quote sits beside the first part");
  const parts = a.filter((x) => x.key.startsWith("para:")).map((x) => x.part);
  assert.deepEqual(parts, [...parts].sort((x, y) => x - y), "parts only move forward");
});
await test("short sections are one part; side-by-side columns never split apart", () => {
  for (const s of realSections.filter((x) => x.layoutType !== "prose_highlight")) {
    const bl = blocksOf(s);
    if (s.layoutType === "two_column") {
      const l = bl.find((x) => x.key === "left");
      const r = bl.find((x) => x.key === "right");
      if (l && r) assert.equal(l.part, r.part, s.sectionTitle);
    }
  }
  assert.equal(partCount(blocksOf(realSections[0])), 1);
  assert.deepEqual(paginate([{ key: "heading", height: 50 }, { key: "row:0", height: 40 }]), [0, 0]);
});
await test("labels are broker words from the served data; unknown keys fall back neutrally", () => {
  const ft = { id: "f", layoutType: "financial_table", sectionTitle: "Income Statement", layoutData: { headers: ["", "2024"], rows: [{ label: "Adjusted EBITDA", values: ["$1.7M"] }] } };
  assert.equal(blockLabel(ft, "row:0"), "Row: Adjusted EBITDA");
  assert.equal(blockLabel(ft, "head"), "Table header");
  assert.equal(blockLabel(ft, ""), "Elsewhere on this page");
  assert.equal(blockLabel(ft, "row:9"), "Part of this page");
  const bar = { id: "b", layoutType: "bar_chart", sectionTitle: "Revenue", layoutData: { data: [{ name: "2023", value: 1 }, { name: "2024", value: 2 }] } };
  assert.equal(blockLabel(bar, "chart/point:1"), "2024");
  assert.ok(blocksOf(bar).find((x) => x.key === "chart/point:1")!.virtual);
});
await test("fingerprints change with block structure, not with words", () => {
  const a = { layoutType: "metric_grid", sectionTitle: "Key figures", layoutData: { metrics: [{ label: "Revenue", value: "$1" }, { label: "EBITDA", value: "$2" }] } };
  const renamed = { ...a, layoutData: { metrics: [{ label: "Sales", value: "$9" }, { label: "Profit", value: "$8" }] } };
  const more = { ...a, layoutData: { metrics: [...a.layoutData.metrics, { label: "Staff", value: "4" }] } };
  const fp = (s: any) => blockFingerprint(s.layoutType, blocksOf(s).filter((x) => !x.virtual && !x.when));
  assert.equal(fp(a), fp(renamed));
  assert.notEqual(fp(a), fp(more));
});
await test("expected reading time: sums the default view, per part", () => {
  const bl = blocksOf(longProse);
  const total = expectedMsOf(bl);
  assert.ok(total > 60_000, `${total}`);
  assert.equal(total, Array.from({ length: partCount(bl) }, (_, p) => expectedMsOf(bl, p)).reduce((s, x) => s + x, 0));
});
await test("viewer pages number sections and letter their parts", () => {
  const pages = viewerPagesOf([{ pageId: "c", parts: 1, order: 0 }, { pageId: "m", parts: 3, order: 2 }, { pageId: "d", parts: 1, order: 1 }]);
  assert.deepEqual(pages.map((p) => p.label), ["1", "2", "3a", "3b", "3c"]);
  assert.deepEqual(pages.map((p) => p.index), [0, 1, 2, 3, 4]);
  assert.equal(pages[3].pageId, "m");
  assert.equal(pages[3].part, 1);
});

// ── Ingest payload ───────────────────────────────────────────────────────
console.log("reading payload");
const good = () => ({
  visitId: "4f7c1c3e-8a1b-4c2d-9e3f-0a1b2c3d4e5f",
  renditionId: "0123456789abcdef0123456789abcdef",
  sentAt: new Date().toISOString(),
  device: { w: 1440, h: 900, touch: false, dpr: 2 },
  visit: { wallMs: 60000, activeMs: 50000, idleMs: 5000, hiddenMs: 0, awayMs: 0, outsideMs: 1000, maxPageIndex: 3 },
  blocks: { "0f0e0d0c-aaaa-4bbb-8ccc-111122223333|row:3": [12000, 800, 15000, 3000], "cim-contact|page": [2000, 0, 2000, 0], "0f0e0d0c-aaaa-4bbb-8ccc-111122223333|": [500, 0, 0, 0] },
  path: { from: 0, entries: [[0, "0f0e0d0c-aaaa-4bbb-8ccc-111122223333"], [42, "cim-contact"]] },
  events: [{ seq: 1, type: "financial_view", pageId: "0f0e0d0c-aaaa-4bbb-8ccc-111122223333", detail: "normalized", at: new Date().toISOString() }],
});
await test("a well-formed payload validates", () => {
  const r = readingPayloadSchema.safeParse(good());
  assert.ok(r.success, JSON.stringify(!r.success && r.error.issues));
});
await test("malformed payloads are rejected", () => {
  const bad: Array<[string, (p: any) => void]> = [
    ["text in a block key", (p) => { p.blocks["x|Harbourline Dental"] = [1, 0, 0, 0]; }],
    ["page id with spaces", (p) => { p.blocks["Harbourline Dental|row:1"] = [1, 0, 0, 0]; }],
    ["negative ms", (p) => { p.visit.activeMs = -1; }],
    ["fractional ms", (p) => { p.blocks["cim-contact|page"] = [1.5, 0, 0, 0]; }],
    ["bad visit id", (p) => { p.visitId = "abc"; }],
    ["bad rendition id", (p) => { p.renditionId = "not-hex"; }],
    ["unknown event", (p) => { p.events[0].type = "mouse_wiggle"; }],
    ["too many blocks", (p) => { for (let i = 0; i <= READING_RULES.maxBlockRows; i++) p.blocks[`pg${i}|row:1`] = [1, 0, 0, 0]; }],
    ["long detail", (p) => { p.events[0].detail = "x".repeat(81); }],
  ];
  for (const [what, mutate] of bad) {
    const p = good();
    mutate(p);
    assert.ok(!readingPayloadSchema.safeParse(p).success, what);
  }
});
await test("helpers: block ids, device class", () => {
  assert.deepEqual(splitBlockId(blockId("abc", "left/row:1")), ["abc", "left/row:1"]);
  assert.deepEqual(splitBlockId("abc|"), ["abc", ""]);
  assert.equal(deviceClassOf({ w: 390, touch: true }), "phone");
  assert.equal(deviceClassOf({ w: 1024, touch: true }), "tablet");
  assert.equal(deviceClassOf({ w: 1440, touch: false }), "desktop");
});

// ── Filters, labels, roles, wording ──────────────────────────────────────
console.log("filters, labels, roles");
await test("filters parse leniently and round-trip through the query string", () => {
  const f = parseEngagementFilters({ range: "7d", device: "phone", buyers: "a1,b2,<script>", segment: "type:private_equity", rendition: "0123456789abcdef0123456789abcdef" });
  assert.deepEqual(f, { range: "7d", device: "phone", buyers: ["a1", "b2"], segment: "type:private_equity", rendition: "0123456789abcdef0123456789abcdef" });
  const back = parseEngagementFilters(Object.fromEntries(new URLSearchParams(engagementFiltersQuery(f).slice(1))));
  assert.deepEqual(back, f);
  assert.deepEqual(parseEngagementFilters({ range: "1y", device: "fridge", segment: "rich" }), { range: "all", device: "all", buyers: [], segment: "all", rendition: null });
  assert.equal(engagementFiltersQuery({ range: "all" }), "");
});
await test("read labels against expected time", () => {
  assert.equal(readLabel(500, 10000), "skipped");
  assert.equal(readLabel(3000, 10000), "glanced");
  assert.equal(readLabel(10000, 10000), "read");
  assert.equal(readLabel(16000, 10000), "studied");
  assert.equal(readLabel(0, 10000, false), null);
  assert.equal(groupReadLabel(["studied", "glanced", "read", null]), "read");
  assert.equal(groupReadLabel([null]), null);
});
await test("page roles from layout, title and legacy keys", () => {
  assert.equal(pageRole({ layoutType: "cover_page", title: "Pacific" }), "front_matter");
  assert.equal(pageRole({ layoutType: "waterfall_chart", title: "Anything" }), "normalization");
  assert.equal(pageRole({ layoutType: "financial_table", title: "Historical Financial Performance" }), "financials");
  assert.equal(pageRole({ layoutType: "two_column", title: "Customer Concentration & Relationships" }), "customers");
  assert.equal(pageRole({ layoutType: "prose_highlight", title: "Reason for Sale" }), "owner_transition");
  assert.equal(pageRole({ layoutType: "callout_list", title: "Blah", sectionKey: "growthStrategies" }), "growth");
  assert.equal(pageRole({ layoutType: "metric_grid", title: "Zzz" }), "other");
});
await test("reading time is said in seconds and minutes", () => {
  assert.equal(formatReadingTime(48_000), "48 s");
  assert.equal(formatReadingTime(160_000), "2 min 40 s");
  assert.equal(formatReadingTime(120_000), "2 min");
  assert.equal(formatReadingTime(3_900_000), "1 h 5 min");
  assert.equal(formatReadingTime(null), "0 s");
  assert.equal(pulseSentence({ granted: 13, opened: 9, readThisWeek: 4, readingNow: 2 }), "9 of 13 buyers have opened the CIM · 4 read it this week · 2 reading now");
  assert.equal(pulseSentence({ granted: 0, opened: 0, readThisWeek: 0, readingNow: 0 }), "No buyers have been given access yet.");
});

// ── Routes: auth, tenancy, gates ─────────────────────────────────────────
console.log("routes");
const deals: any[] = [
  { id: "dealA", brokerId: "brokerA", businessName: "Deal A", isLive: true, ndaRequired: true },
  { id: "dealB", brokerId: "brokerB", businessName: "Deal B", isLive: true, ndaRequired: false },
  { id: "dealC", brokerId: "brokerA", businessName: "Draft C", isLive: false, ndaRequired: false },
];
const accesses: any[] = [
  { id: "accA1", dealId: "dealA", accessToken: "tokA1", buyerEmail: "a1@x.invalid", buyerName: "Jordan", accessLevel: "teaser", ndaSigned: true, decision: "interested", createdAt: new Date() },
  { id: "accA2", dealId: "dealA", accessToken: "tokA2", buyerEmail: "a2@x.invalid", accessLevel: "loi", ndaSigned: false, decision: "not_interested", createdAt: new Date() },
  { id: "accB1", dealId: "dealB", accessToken: "tokB1", buyerEmail: "b1@x.invalid", accessLevel: "full", ndaSigned: false, decision: "interested", createdAt: new Date() },
  { id: "accA3", dealId: "dealA", accessToken: "tokA3", buyerEmail: "a3@x.invalid", accessLevel: "teaser", ndaSigned: true, decision: "interested", revokedAt: new Date(), createdAt: new Date() },
  { id: "accC1", dealId: "dealC", accessToken: "tokC1", buyerEmail: "c1@x.invalid", accessLevel: "teaser", ndaSigned: true, decision: "interested", createdAt: new Date() },
];
const { storage } = await import("../../server/storage");
Object.assign(storage as any, {
  getDeal: async (id: string) => deals.find((d) => d.id === id),
  getAllDeals: async (brokerId?: string) => deals.filter((d) => d.brokerId === brokerId),
  getBuyerAccess: async (id: string) => accesses.find((a) => a.id === id),
  getBuyerAccessByDeal: async (dealId: string) => accesses.filter((a) => a.dealId === dealId),
  getBuyerAccessByToken: async (t: string) => accesses.find((a) => a.accessToken === t),
  updateBuyerAccess: async (id: string, patch: any) => { const a = accesses.find((x) => x.id === id); Object.assign(a, patch); return a; },
  getCimSectionsByDeal: async () => [],
});
const { registerEngagementRoutes } = await import("../../server/routes/engagement");
const { registerEngagementInsightRoutes } = await import("../../server/routes/engagement-insights");
const { registerReadingRoutes, setReadingStore } = await import("../../server/routes/reading");
// Capture: reading is stored/read in memory here (no database in this test).
const { memoryReadingStore } = await import("../../server/analytics/reading-ingest");
const { memoryReadingSource } = await import("../../server/engagement/queries");
const { setReadingSource } = await import("../../server/engagement/facts");
const memStore = memoryReadingStore();
memStore.renditions.set("0123456789abcdef0123456789abcdef", {
  id: "0123456789abcdef0123456789abcdef", dealId: "dealA", mode: "blind", variant: "teaser", createdAt: new Date(Date.now() - 3600_000),
  pageIndex: ["0f0e0d0c-aaaa-4bbb-8ccc-111122223333", "cim-contact"].map((pageId, order) => ({ pageId, lineageId: pageId, order, parts: 1, servedTitle: pageId, layoutType: "prose_highlight", locked: false, expectedMs: 1000, blockFingerprint: "", blocks: [] })),
});
setReadingStore(memStore);
setReadingSource(memoryReadingSource(memStore));
const app = express();
app.use(express.json());
app.use((req, _res, next) => { (req as any).session = { brokerId: req.headers["x-test-broker"] || undefined }; next(); });
registerReadingRoutes(app);
registerEngagementRoutes(app);
registerEngagementInsightRoutes(app);
const server = app.listen(0);
const port = (server.address() as AddressInfo).port;
const call = async (method: string, url: string, broker?: string, body?: unknown, type = "application/json") => {
  const res = await fetch(`http://127.0.0.1:${port}${url}`, {
    method,
    headers: { ...(broker ? { "x-test-broker": broker } : {}), ...(body !== undefined ? { "content-type": type } : {}) },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

try {
  const brokerRoutes: Array<[string, string]> = [
    ["GET", "/api/deals/dealA/engagement/summary"],
    ["GET", "/api/deals/dealA/engagement/buyers?range=7d"],
    ["GET", "/api/deals/dealA/engagement/document"],
    ["GET", "/api/deals/dealA/engagement/buyers/accA1/journey"],
    ["POST", "/api/deals/dealA/engagement/buyers/accA1/contacted"],
    ["GET", "/api/deals/dealA/engagement/renditions/0123456789abcdef0123456789abcdef"],
    ["POST", "/api/deals/dealA/engagement/buyers/accA1/brief"],
  ];
  await test("every broker route needs a session (401)", async () => {
    for (const [m, u] of [...brokerRoutes, ["GET", "/api/broker/engagement/call-list"], ["GET", "/api/broker/engagement/compare"]] as Array<[string, string]>) {
      assert.equal((await call(m, u)).status, 401, `${m} ${u}`);
    }
  });
  await test("another broker gets 404 on every deal route (never learns the deal exists)", async () => {
    for (const [m, u] of brokerRoutes) assert.equal((await call(m, u, "brokerB")).status, 404, `${m} ${u}`);
  });
  await test("a buyer of another deal is 404 even on your own deal", async () => {
    assert.equal((await call("GET", "/api/deals/dealA/engagement/buyers/accB1/journey", "brokerA")).status, 404);
    assert.equal((await call("POST", "/api/deals/dealA/engagement/buyers/accB1/contacted", "brokerA")).status, 404);
    assert.ok(!(accesses[2].accessEvents?.length), "nothing written on the other deal's buyer");
    assert.equal((await call("POST", "/api/deals/dealA/engagement/buyers/accB1/brief", "brokerA")).status, 404);
  });
  await test("the owner gets typed results", async () => {
    const s = await call("GET", "/api/deals/dealA/engagement/summary", "brokerA");
    assert.equal(s.status, 200);
    assert.equal(s.body.pulse.granted, 3);
    assert.equal(typeof s.body.pulse.sentence, "string");
    assert.equal(s.body.published, true);
    const b = await call("GET", "/api/deals/dealA/engagement/buyers", "brokerA");
    assert.equal(b.status, 200);
    assert.deepEqual(b.body.buyers, []);
    assert.equal(b.body.notOpened.length, 3);
    const d = await call("GET", "/api/deals/dealA/engagement/document", "brokerA");
    assert.equal(d.status, 200);
    assert.ok(Array.isArray(d.body.pages) && d.body.pages.every((p: any) => p.readers === 0), "pages of the served version, nobody read yet");
    const j = await call("GET", "/api/deals/dealA/engagement/buyers/accA1/journey", "brokerA");
    assert.equal(j.status, 200);
    assert.equal(j.body.accessId, "accA1");
    const r = await call("GET", "/api/deals/dealA/engagement/renditions/not-an-id", "brokerA");
    assert.equal(r.status, 404);
  });
  await test("Mark contacted appends to the access row's history", async () => {
    const r = await call("POST", "/api/deals/dealA/engagement/buyers/accA1/contacted", "brokerA");
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(accesses[0].accessEvents.at(-1).type, "contacted");
    const facts = await call("GET", "/api/deals/dealA/engagement/buyers", "brokerA");
    assert.equal(facts.status, 200);
  });
  await test("global routes list only the broker's own deals", async () => {
    const c = await call("GET", "/api/broker/engagement/compare", "brokerA");
    assert.equal(c.status, 200);
    assert.deepEqual(c.body.deals.map((d: any) => d.dealId).sort(), ["dealA", "dealC"]);
    const l = await call("GET", "/api/broker/engagement/call-list", "brokerB");
    assert.equal(l.status, 200);
    assert.deepEqual(l.body.entries, []);
  });

  const payload = JSON.stringify(good());
  await test("reading: a signed buyer's beacon (text/plain) is accepted with 204", async () => {
    assert.equal((await call("POST", "/api/view/tokA1/reading", undefined, payload, "text/plain;charset=UTF-8")).status, 204);
    assert.equal((await call("POST", "/api/view/tokA1/reading", undefined, JSON.parse(payload))).status, 204);
  });
  await test("reading: NDA not signed → 204 and nothing stored; bad links and drafts → 404; junk → 400", async () => {
    assert.equal((await call("POST", "/api/view/tokA2/reading", undefined, payload, "text/plain")).status, 204);
    assert.equal((await call("POST", "/api/view/tokA3/reading", undefined, payload, "text/plain")).status, 404, "revoked");
    assert.equal((await call("POST", "/api/view/nope/reading", undefined, payload, "text/plain")).status, 404);
    assert.equal((await call("POST", "/api/view/tokC1/reading", undefined, payload, "text/plain")).status, 404, "unpublished");
    assert.equal((await call("POST", "/api/view/tokA1/reading", undefined, "{not json", "text/plain")).status, 400);
    const leaky = good();
    (leaky.blocks as any)["x|Harbourline"] = [1, 0, 0, 0];
    assert.equal((await call("POST", "/api/view/tokA1/reading", undefined, JSON.stringify(leaky), "text/plain")).status, 400);
  });
  await test("reading: a body over 64 KB is refused", async () => {
    const big = good();
    (big as any).sentAt = "x".repeat(70 * 1024);
    const r = await fetch(`http://127.0.0.1:${port}/api/view/tokA1/reading`, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify(big) });
    assert.equal(r.status, 413);
  });
} finally {
  server.close();
}

console.log(`\n${passed} passed`);
process.exit(0);
