/**
 * The reading tracker's "paused" option (the vdr contract, analytics.md
 * §11.2): while the data room's document drawer is open over the CIM,
 * seconds are AWAY (never reading), so the visit's reading time stops
 * growing and it leaves "Reading now" within 90 s; "vdr_open" is a valid
 * interaction recorded on the page being read.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/reading-paused.test.ts
 */
import assert from "node:assert/strict";
import { READING_INTERACTIONS, readingPayloadSchema, type ReadingPayload } from "../../shared/analytics-v2";
import { activityState, type ActivityInput } from "../../shared/reading-allocator";
import { ingestReading, memoryReadingStore, type IngestInput } from "../../server/analytics/reading-ingest";
import { buildPageIndex, renditionId } from "../../server/analytics/renditions";
import { interactionPageId } from "../../client/src/lib/cim-reading";
import type { BuyerSection } from "../../shared/cim-buyer-view";

async function main() {
  // ── activityState ──
  const now = 1_000_000;
  const active: ActivityInput = { now, visible: true, focused: true, lastInputAt: now - 1_000, lastPointerAt: now - 1_000, idleLimitMs: 60_000, peers: [] };
  assert.equal(activityState(active), "active");
  assert.equal(activityState({ ...active, paused: false }), "active");
  assert.equal(activityState({ ...active, paused: true }), "away", "paused seconds are away, never reading");
  assert.equal(activityState({ ...active, paused: true, visible: false }), "hidden", "a hidden tab is still hidden");

  // ── the payload accepts vdr_open, still refuses unknown types ──
  assert.ok((READING_INTERACTIONS as readonly string[]).includes("vdr_open"));
  const P1 = "11111111-1111-4111-8111-111111111111";
  const P2 = "22222222-2222-4222-8222-222222222222";
  const sections: BuyerSection[] = [
    { id: P1, dealId: "deal1", sectionKey: "s1", sectionTitle: "Executive Summary", order: 0, layoutType: "prose_highlight", layoutData: { content: "x" }, aiDraftContent: null, brokerEditedContent: null, isVisible: true } as BuyerSection,
    { id: P2, dealId: "deal1", sectionKey: "s2", sectionTitle: "Financials", order: 1, layoutType: "financial_table", layoutData: { headers: ["", "2024"], rows: [{ label: "Revenue", values: ["$1M"] }] }, aiDraftContent: null, brokerEditedContent: null, isVisible: true } as BuyerSection,
  ];
  const design = { template: { id: "classic", name: "", tokens: {} }, brokerage: { showDisclaimerPage: false, showContactPage: false }, business: null };
  const rid = renditionId({ mode: "normal", variant: "full", design, sections });
  const T0 = new Date("2026-10-09T12:00:00Z");
  const V = "aaaaaaaa-0000-4000-8000-0000000000aa";
  const payload = (over: Partial<ReadingPayload> = {}): ReadingPayload => ({
    visitId: V, renditionId: rid, sentAt: T0.toISOString(), device: { w: 1440, h: 900, touch: false, dpr: 2 },
    visit: { wallMs: 60_000, activeMs: 50_000, idleMs: 0, hiddenMs: 0, awayMs: 10_000, outsideMs: 0, maxPageIndex: 1 },
    blocks: { [`${P2}|row:0`]: [30_000, 0, 30_000, 0] },
    path: { from: 0, entries: [[0, P1], [10, P2]] },
    events: [],
    ...over,
  });
  const withVdr = payload({ events: [{ seq: 1, type: "vdr_open", pageId: P2, detail: "doc:item-123", at: T0.toISOString() }] });
  assert.equal(readingPayloadSchema.safeParse(withVdr).success, true, "vdr_open is accepted");
  assert.equal(readingPayloadSchema.safeParse(payload({ events: [{ seq: 1, type: "telepathy" as never, pageId: P2, at: T0.toISOString() }] })).success, false, "unknown types are still refused");

  // ── a paused visit's last active second doesn't move (so it leaves "Reading now") ──
  const store = memoryReadingStore();
  store.renditions.set(rid, { id: rid, dealId: "deal1", mode: "normal", variant: "full", createdAt: new Date(T0.getTime() - 3_600_000), pageIndex: buildPageIndex(sections, design, []) });
  const input = (p: ReadingPayload, at: Date): IngestInput =>
    ({ deal: { id: "deal1" }, access: { id: "acc1", dealId: "deal1", accessLevel: "loi" }, payload: p, now: at, selfView: false, ipHash: null, uaFamily: "Chrome/Mac" } as IngestInput);
  const t1 = new Date(T0.getTime() + 61_000);
  assert.equal((await ingestReading(store, input(withVdr, t1))).status, 204, "a send carrying vdr_open is stored");
  const first = store.visits.get(V)!.lastSeenAt.getTime();
  assert.equal(first, t1.getTime());
  // 2 minutes in the data room: the beacon carries more away time, no new active time.
  const paused = payload({ visit: { ...payload().visit, wallMs: 180_000, awayMs: 130_000 }, events: [] });
  const t2 = new Date(t1.getTime() + 120_000);
  assert.equal((await ingestReading(store, input(paused, t2))).status, 204);
  assert.equal(store.visits.get(V)!.lastSeenAt.getTime(), first, "no new active time: last_seen_at unchanged");
  assert.equal(store.visits.get(V)!.activeMs, 50_000, "reading time stopped growing");
  assert.ok(t2.getTime() - first > 90_000, "so it is out of 'Reading now' (90 s)");
  assert.equal(Array.from(store.events.values()).filter((e) => e.eventType === "vdr_open").length, 1);

  // ── vdr_open is recorded on the page being read ──
  assert.equal(interactionPageId(null, P2, [P1, P2]), P2, "the current page");
  assert.equal(interactionPageId(null, null, [P1, P2]), P1, "else the first page");
  assert.equal(interactionPageId(P1, P2, [P1, P2]), P1, "a page given wins");
  assert.equal(interactionPageId(null, null, []), null, "nothing to record on");
  assert.equal(interactionPageId("not a page id!", null, [P1]), null, "never an invalid id");

  console.log("reading-paused: all assertions passed");
}

main().catch((err) => { console.error(err); process.exit(1); });
