/**
 * Reading ingest across the October 2026 access levels (server/analytics/reading-ingest.ts
 * planIngest): a NEW visit must be on what the link's level reads now —
 * renditionKindFor(level) — or, for a Blind CIM link, a {blind, teaser}
 * rendition recorded before the deploy (a legacy "teaser" link was served the
 * Blind CIM under that variant: same document); a visit CONTINUING on its own
 * rendition is accepted whatever the level is now. Visits store the
 * normalised level and the rendition's own mode. In-memory store; no DB, no AI.
 *
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/reading-ingest-levels.test.ts
 */
import assert from "node:assert/strict";
import { ingestReading, memoryReadingStore, renditionServesLevel, type IngestInput } from "../../server/analytics/reading-ingest";
import { buildPageIndex, renditionId } from "../../server/analytics/renditions";
import type { ReadingPayload } from "../../shared/analytics-v2";
import type { BuyerSection } from "../../shared/cim-buyer-view";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}`); throw e; }
}

const P1 = "11111111-1111-4111-8111-111111111111";
const sections: BuyerSection[] = [
  { id: P1, dealId: "deal1", sectionKey: `s_${P1}`, sectionTitle: "Overview", order: 0, layoutType: "prose_highlight", layoutData: { body: "x" }, aiDraftContent: "x", brokerEditedContent: null, isVisible: true },
];
const design = { template: { id: "classic", name: "", tokens: {} }, brokerage: { showDisclaimerPage: false, showContactPage: false }, business: null };
const T0 = new Date("2026-10-09T12:00:00Z");
const kinds = {
  blindFull: { mode: "blind", variant: "full" },
  blindLegacy: { mode: "blind", variant: "teaser" },
  normal: { mode: "normal", variant: "full" },
  dd: { mode: "dd", variant: "full" },
  teaser: { mode: "teaser", variant: "teaser" },
} as const;
const ids = Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, renditionId({ ...(v as any), design, sections })])) as Record<keyof typeof kinds, string>;

function store() {
  const s = memoryReadingStore();
  for (const [k, v] of Object.entries(kinds)) {
    s.renditions.set(ids[k as keyof typeof kinds], { id: ids[k as keyof typeof kinds], dealId: "deal1", ...v, createdAt: new Date(T0.getTime() - 3600_000), pageIndex: buildPageIndex(sections, design as any, []) });
  }
  return s;
}
let v = 0;
const payload = (renditionId: string, visitId = `aaaaaaaa-0000-4000-8000-${String(++v).padStart(12, "0")}`): ReadingPayload => ({
  visitId, renditionId, sentAt: T0.toISOString(),
  device: { w: 1440, h: 900, touch: false, dpr: 2 },
  visit: { wallMs: 30_000, activeMs: 20_000, idleMs: 0, hiddenMs: 0, awayMs: 0, outsideMs: 0, maxPageIndex: 0 },
  blocks: { [`${P1}|page`]: [10_000, 0, 10_000, 0] },
  path: { from: 0, entries: [[0, P1]] },
  events: [],
});
const input = (p: ReadingPayload, accessLevel: string, now = new Date(T0.getTime() + 31_000)): IngestInput =>
  ({ deal: { id: "deal1" }, access: { id: "acc1", dealId: "deal1", accessLevel }, payload: p, now, selfView: false, ipHash: null, uaFamily: null });

console.log("which rendition a new visit may be on");

await test("each level's own kind; legacy {blind, teaser} only for Blind CIM levels", () => {
  const ok: Array<[keyof typeof kinds, string]> = [
    ["blindFull", "blind"], ["blindFull", "full"], ["blindFull", "teaser"],
    ["blindLegacy", "blind"], ["blindLegacy", "full"], ["blindLegacy", "teaser"],
    ["normal", "named"], ["normal", "loi"], ["dd", "due_diligence"], ["teaser", "teaser_only"],
  ];
  for (const [k, level] of ok) assert.ok(renditionServesLevel(kinds[k], level), `${k} for ${level}`);
  const no: Array<[keyof typeof kinds, string]> = [
    ["normal", "blind"], ["blindFull", "named"], ["blindLegacy", "named"], ["blindLegacy", "teaser_only"],
    ["teaser", "blind"], ["teaser", "teaser"], ["blindFull", "teaser_only"], ["dd", "named"], ["normal", "junk"],
  ];
  for (const [k, level] of no) assert.ok(!renditionServesLevel(kinds[k], level), `${k} not for ${level}`);
});

await test("a tab opened before the deploy keeps recording: legacy {blind, teaser} stored for a blind link, mode blind, level normalised", async () => {
  const s = store();
  const p = payload(ids.blindLegacy);
  const r = await ingestReading(s, input(p, "teaser"));
  assert.equal(r.status, 204);
  const visit = s.visits.get(p.visitId)!;
  assert.equal(visit.mode, "blind");
  assert.equal((visit as any).accessLevel, "blind", "stored normalised (legacy teaser = blind)");
});

await test("a new visit on another version is refused (400); nothing stored", async () => {
  const s = store();
  for (const [rid, level] of [[ids.normal, "blind"], [ids.blindFull, "loi"], [ids.teaser, "full"], [ids.blindFull, "teaser_only"]] as const) {
    const p = payload(rid);
    assert.equal((await ingestReading(s, input(p, level))).status, 400, `${level} on another version`);
    assert.equal(s.visits.has(p.visitId), false);
  }
});

console.log("continuing visits");

await test("a visit keeps recording on its own rendition after the link's level changes", async () => {
  const s = store();
  const p = payload(ids.blindFull);
  assert.equal((await ingestReading(s, input(p, "blind"))).status, 204);
  // The broker moves the buyer to the Full CIM while the tab is still open.
  const more = { ...p, visit: { ...p.visit, wallMs: 60_000, activeMs: 40_000 }, sentAt: new Date(T0.getTime() + 61_000).toISOString() };
  const r = await ingestReading(s, input(more, "named", new Date(T0.getTime() + 62_000)));
  assert.equal(r.status, 204);
  assert.equal(s.visits.get(p.visitId)!.activeMs, 40_000);
  assert.equal(s.visits.get(p.visitId)!.mode, "blind", "the visit stays what was read");
  // …but a NEW visit at the new level must be on the named CIM.
  assert.equal((await ingestReading(s, input(payload(ids.blindFull), "named"))).status, 400);
});

await test("a teaser rendition is accepted for a Teaser link, stored as mode teaser", async () => {
  const s = store();
  const p = payload(ids.teaser);
  assert.equal((await ingestReading(s, input(p, "teaser_only"))).status, 204);
  assert.equal(s.visits.get(p.visitId)!.mode, "teaser");
  assert.equal((s.visits.get(p.visitId)! as any).accessLevel, "teaser_only");
});

console.log(`\n${passed} passed`);
