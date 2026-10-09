/**
 * Teaser reading (spec §4.10, E1/E12):
 *  - the reading route stores a teaser visit on a deal whose NDA is unsigned
 *    and whose CIM isn't live; the same link with the teaser offline → 404;
 *    a Blind CIM link on that deal is still 404 (CIM not live) as before;
 *  - a teaser rendition is accepted for teaser_only and refused for a NEW
 *    Blind CIM visit, and vice versa; a CONTINUING teaser visit is accepted
 *    after the link was upgraded; the legacy {blind, teaser} rendition is
 *    accepted for blind / full / teaser rows;
 *  - a teaser visit never bumps view_count, and a CIM visit 5 minutes after a
 *    teaser visit still counts (countView ignores teaser visits);
 *  - the engagement queries exclude teaser visits by default and include them
 *    with kind "teaser";
 *  - teaserEngagement: the funnel, worthACall and openedToday.
 *
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/reading-ingest-teaser.test.ts
 */
import { T, now, DAY, mkAccess, seedPacific, startHarness, pacificWritten } from "../utils/teaser-harness";
import assert from "node:assert/strict";
import type { ReadingPayload } from "../../shared/analytics-v2";

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

let vseq = 0;
const vid = () => `bbbbbbbb-0000-4000-8000-${String(++vseq).padStart(12, "0")}`;

function payload(renditionId: string, pages: string[], visitId = vid(), over: Partial<ReadingPayload> = {}): ReadingPayload {
  return {
    visitId,
    renditionId,
    sentAt: new Date().toISOString(),
    device: { w: 1440, h: 900, touch: false, dpr: 2 },
    visit: { wallMs: 40_000, activeMs: 30_000, idleMs: 5_000, hiddenMs: 0, awayMs: 0, outsideMs: 0, maxPageIndex: pages.length - 1 },
    // Realistic: the parts' reading adds up to no more than the active time (else the visit is clamped).
    blocks: Object.fromEntries(pages.map((p, i) => [`${p}|${i === 0 ? "heading" : ""}`, [3_000, 0, 4_000, 0]])),
    path: { from: 0, entries: pages.map((p, i) => [i * 5, p] as [number, string]) },
    events: [],
    ...over,
  } as ReadingPayload;
}

async function main() {
  const h = await startHarness();
  const { call, broker } = h;
  const deal = seedPacific({ isLive: false, ndaRequired: true });
  h.modelReplies.push(pacificWritten());
  await call("POST", "/api/deals/D-PAC/teaser/generate", { templateKey: "one_page" }, broker);
  const { waitForTeaser } = await import("../../server/teaser/generate");
  const row = (await waitForTeaser("D-PAC"))!;
  assert.equal((await call("POST", "/api/deals/D-PAC/teaser/publish", { rev: row.draftRev }, broker)).status, 200);

  const teaserLink = mkAccess({ buyerEmail: "reader@buyer.invalid" });
  const view = await call("GET", `/api/view/${teaserLink.accessToken}`);
  assert.equal(view.status, 200, view.text);
  const rid: string = view.json.reading.renditionId;
  const pages: string[] = view.json.reading.pageOrder;

  await check("the reading route stores a teaser visit while the CIM isn't live and the NDA isn't signed", async () => {
    const r = await call("POST", `/api/view/${teaserLink.accessToken}/reading`, payload(rid, pages));
    assert.equal(r.status, 204, r.text);
    const visits = Array.from(h.reading.visits.values()).filter((v) => v.buyerAccessId === teaserLink.id);
    assert.equal(visits.length, 1);
    assert.equal(visits[0].mode as string, "teaser");
    assert.equal(visits[0].accessLevel, "teaser_only");
    assert.equal(h.reading.viewCounts.get(teaserLink.id) ?? 0, 0, "a teaser visit is never a CIM view");
    assert.equal(T.access.find((a) => a.id === teaserLink.id).viewCount, 0);
  });

  await check("a Blind CIM link on the same deal: still 404 (the CIM isn't live)", async () => {
    const blind = mkAccess({ accessLevel: "blind", buyerEmail: "blind@buyer.invalid" });
    const r = await call("POST", `/api/view/${blind.accessToken}/reading`, payload(rid, pages));
    assert.equal(r.status, 404);
  });

  await check("a Blind CIM link can't record on the teaser rendition (a new visit); the teaser link can't on a CIM one", async () => {
    deal.isLive = true;
    const blind = mkAccess({ accessLevel: "blind", buyerEmail: "blind2@buyer.invalid", ndaSigned: true });
    const r = await call("POST", `/api/view/${blind.accessToken}/reading`, payload(rid, pages));
    assert.equal(r.status, 400, "a new Blind CIM visit on a teaser rendition");
    const cimRid = "c".repeat(32);
    h.reading.renditions.set(cimRid, { id: cimRid, dealId: "D-PAC", mode: "blind", variant: "full", createdAt: new Date(now - 3600_000), pageIndex: [{ pageId: "p1", lineageId: "p1", order: 0, parts: 1, servedTitle: "Overview", layoutType: "prose_highlight", locked: false, expectedMs: 5000, blockFingerprint: "x", blocks: [{ key: "heading", kind: "heading", label: "Heading", expectedMs: 1000, part: 0 }] }] } as never);
    const t = await call("POST", `/api/view/${teaserLink.accessToken}/reading`, payload(cimRid, ["p1"]));
    assert.equal(t.status, 400, "a teaser link on a CIM rendition");
    const ok = await call("POST", `/api/view/${blind.accessToken}/reading`, payload(cimRid, ["p1"]));
    assert.equal(ok.status, 204, ok.text);
    deal.isLive = false;
  });

  await check("the teaser taken offline: its link's reading → 404", async () => {
    await call("POST", "/api/deals/D-PAC/teaser/unpublish", {}, broker);
    const r = await call("POST", `/api/view/${teaserLink.accessToken}/reading`, payload(rid, pages));
    assert.equal(r.status, 404);
    const t = (await h.teasers.get("D-PAC"))!;
    await h.teasers.update("D-PAC", () => ({ unpublishedAt: null }));
    void t;
  });

  const ri = await import("../../server/analytics/reading-ingest");
  await check("planIngest: a continuing teaser visit is accepted after the upgrade; a new one isn't", async () => {
    const s = h.reading;
    const visitId = vid();
    const base = { deal: { id: "D-PAC" }, payload: payload(rid, pages, visitId), now: new Date(), selfView: false, ipHash: null, uaFamily: null };
    assert.equal((await ri.ingestReading(s, { ...base, access: { id: teaserLink.id, dealId: "D-PAC", accessLevel: "teaser_only" } })).status, 204);
    const cont = { ...base, payload: payload(rid, pages, visitId, { visit: { ...payload(rid, pages).visit, wallMs: 60_000, activeMs: 45_000 } }), now: new Date(Date.now() + 20_000) };
    assert.equal((await ri.ingestReading(s, { ...cont, access: { id: teaserLink.id, dealId: "D-PAC", accessLevel: "blind" } })).status, 204, "continuing on its own rendition");
    const fresh = { ...base, payload: payload(rid, pages) };
    assert.equal((await ri.ingestReading(s, { ...fresh, access: { id: teaserLink.id, dealId: "D-PAC", accessLevel: "blind" } })).status, 400, "a NEW visit at the Blind CIM must be on a CIM rendition");
  });

  await check("the legacy {blind, teaser} rendition is accepted for blind / full / teaser rows", () => {
    const legacy = { mode: "blind", variant: "teaser" } as const;
    for (const l of ["blind", "full", "teaser"]) assert.equal(ri.renditionServesLevel(legacy, l), true, l);
    assert.equal(ri.renditionServesLevel(legacy, "named"), false);
    assert.equal(ri.renditionServesLevel(legacy, "teaser_only"), false);
    assert.equal(ri.renditionServesLevel({ mode: "teaser", variant: "teaser" } as never, "teaser_only"), true);
    assert.equal(ri.renditionServesLevel({ mode: "teaser", variant: "teaser" } as never, "blind"), false);
  });

  await check("a CIM visit 5 minutes after a teaser visit still counts as a view", async () => {
    const s = ri.memoryReadingStore();
    const t0 = new Date(now);
    s.renditions.set(rid, h.reading.renditions.get(rid)!);
    const cimRid = "d".repeat(32);
    s.renditions.set(cimRid, { ...h.reading.renditions.get("c".repeat(32))!, id: cimRid, createdAt: new Date(now - 3600_000) });
    const acc = { id: "acc-up", dealId: "D-PAC", accessLevel: "teaser_only" };
    await ri.ingestReading(s, { deal: { id: "D-PAC" }, access: acc, payload: payload(rid, pages), now: t0, selfView: false, ipHash: null, uaFamily: null });
    assert.equal(s.viewCounts.get("acc-up") ?? 0, 0);
    const r = await ri.ingestReading(s, { deal: { id: "D-PAC" }, access: { ...acc, accessLevel: "blind" }, payload: payload(cimRid, ["p1"]), now: new Date(now + 5 * 60_000), selfView: false, ipHash: null, uaFamily: null });
    assert.equal(r.viewCounted, true);
    assert.equal(s.viewCounts.get("acc-up"), 1);
  });

  await check("engagement queries: teaser visits excluded by default, included with kind 'teaser'", async () => {
    const { memoryReadingSource } = await import("../../server/engagement/queries");
    const src = memoryReadingSource(h.reading);
    const q = { dealId: "D-PAC", since: null, device: "all" as const, accessIds: null };
    const cim = await src.visits(q);
    const teaser = await src.visits({ ...q, kind: "teaser" });
    assert.ok(cim.every((v) => v.renditionId !== rid), "no teaser visit in CIM numbers");
    assert.ok(teaser.length >= 2 && teaser.every((v) => v.renditionId === rid));
    assert.ok((await src.renditions("D-PAC")).every((r) => r.mode !== "teaser"));
    assert.ok((await src.renditions("D-PAC", "teaser")).every((r) => r.mode === "teaser"));
    assert.ok((await src.blockSums(q)).every((b) => b.renditionId !== rid));
    const { cimVisitConditions } = await import("../../server/engagement/queries");
    const { PgDialect } = await import("drizzle-orm/pg-core");
    const sqlText = new PgDialect().sqlToQuery(cimVisitConditions("v")).sql;
    assert.match(sqlText, /v\.mode IS DISTINCT FROM 'teaser'/);
    assert.match(new PgDialect().sqlToQuery(cimVisitConditions("vv", { kind: "teaser" })).sql, /vv\.mode = 'teaser'/);
  });

  await check("teaserEngagement: the funnel, worth a call, opened today", async () => {
    const { computeTeaserEngagement } = await import("../../server/teaser/engagement");
    const links = [
      { ...mkAccess({ buyerEmail: "a@x.invalid" }), id: "L-a", createdAt: new Date(now - 5 * DAY) },
      { ...mkAccess({ buyerEmail: "b@x.invalid" }), id: "L-b" },
      { ...mkAccess({ buyerEmail: "c@x.invalid", accessEvents: [{ type: "granted", at: new Date(now - 4 * DAY).toISOString(), accessLevel: "teaser_only" }, { type: "teaser_passed", at: new Date(now - DAY).toISOString(), reasons: ["size"] }] }), id: "L-c" },
      { ...mkAccess({ buyerEmail: "d@x.invalid", accessLevel: "blind", accessEvents: [{ type: "granted", at: new Date(now - 6 * DAY).toISOString(), accessLevel: "teaser_only" }] }), id: "L-d" },
      { ...mkAccess({ buyerEmail: "e@x.invalid", accessLevel: "blind", accessEvents: [{ type: "granted", at: new Date(now - DAY).toISOString(), accessLevel: "blind" }] }), id: "L-e" },
    ];
    const pageIndex = h.reading.renditions.get(rid)!.pageIndex;
    const last = pageIndex.length - 1;
    const visits = [
      { accessId: "L-a", renditionId: rid, startedAt: new Date(now - 3 * DAY), lastSeenAt: new Date(now - 3 * DAY), activeMs: 120_000, maxPageIndex: last },
      { accessId: "L-b", renditionId: rid, startedAt: new Date(now - 2 * 3600_000), lastSeenAt: new Date(now - 3600_000), activeMs: 40_000, maxPageIndex: 2 },
      { accessId: "L-c", renditionId: rid, startedAt: new Date(now - 3 * DAY), lastSeenAt: new Date(now - 3 * DAY), activeMs: 20_000, maxPageIndex: 1 },
      { accessId: "L-d", renditionId: rid, startedAt: new Date(now - 5 * DAY), lastSeenAt: new Date(now - 5 * DAY), activeMs: 60_000, maxPageIndex: last },
    ];
    const requests = [{ id: "RQ-d", dealId: "D-PAC", buyerAccessId: "L-d", source: "teaser_request", status: "access_granted", grantAccessLevel: "blind", grantedBy: "auto", grantedAt: new Date(now - 4 * DAY), createdAt: new Date(now - 4 * DAY), updatedAt: new Date(now - 4 * DAY) }];
    const blockSums = [{ accessId: "L-a", pageId: pageIndex[1].pageId, attentionMs: 30_000 }, { accessId: "L-b", pageId: pageIndex[1].pageId, attentionMs: 10_000 }];
    const e = computeTeaserEngagement({ links: links as never, requests: requests as never, visits, blockSums, pageIndexes: new Map([[rid, pageIndex]]), now });
    assert.deepEqual(e.funnel, { sent: 4, opened: 4, readToEnd: 2, asked: 1, granted: 1, passed: 1 });
    const by = (id: string) => e.buyers.find((b) => b.accessId === id)!;
    assert.equal(by("L-a").worthACall, true, "opened 3 days ago, didn't ask, didn't pass");
    assert.equal(by("L-b").worthACall, false, "opened today");
    assert.equal(by("L-c").worthACall, false, "said not for me");
    assert.equal(by("L-d").request.state, "granted");
    assert.equal(by("L-d").request.grantedBy, "auto");
    assert.equal(by("L-b").furthestBlock, pageIndex[2].servedTitle);
    assert.equal(e.openedToday, 1);
    assert.ok(!e.buyers.some((b) => b.accessId === "L-e"), "never a teaser link");
    assert.deepEqual(e.blocks.map((b) => [b.readers, b.attentionMs, b.avgMs]), [[2, 40_000, 20_000]]);
  });

  await h.close();
  console.log(`\n${passed} checks passed`);
  process.exit(0);
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
