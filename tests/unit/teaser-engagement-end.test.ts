/**
 * Release review fixes on the teaser's reading (Pacific copy):
 *  UX-F11 — "Read to the end 0" and "stopped at Interested?" for a buyer who
 *    read every block and asked for the CIM: the end was the trailing
 *    one-line confidentiality note. Now the end is the last block before it,
 *    and asking for the CIM counts as reading to the end.
 *  UX-F4 — "Have the teaser 0 · 1 opened today" after that buyer moved on to
 *    the CIM: "opened today" now counts only links still at the teaser.
 * Pure (no DB, no AI).
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/teaser-engagement-end.test.ts
 */
import assert from "node:assert/strict";
import { computeTeaserEngagement, isTrailingFootnote } from "../../server/teaser/engagement";
import { teaserStageSubline } from "../../client/src/lib/buyer-pipeline";

const now = Date.parse("2026-10-10T12:00:00Z");
const DAY = 86_400_000;
const page = (pageId: string, order: number, servedTitle: string, layoutType: string, expectedMs: number) =>
  ({ pageId, lineageId: pageId, order, parts: 1, servedTitle, layoutType, locked: false, expectedMs, blockFingerprint: pageId, blocks: [] });
const rid = "t".repeat(32);
const pages = [
  page("teaser_header", 0, "Project Shoreline", "teaser_header", 4_000),
  page("b-overview", 1, "The business", "prose_highlight", 20_000),
  page("b-high", 2, "Highlights", "callout_list", 18_000),
  page("b-next", 3, "Interested?", "numbered_list", 6_000),
  page("b-conf", 4, "", "prose_highlight", 4_000),
];
const access = (id: string, accessLevel: string, grantedLevel = "teaser_only") => ({
  id, dealId: "D", buyerEmail: `${id}@x.invalid`, buyerName: id, accessLevel, revokedAt: null, expiresAt: new Date(now + 20 * DAY), createdAt: new Date(now - 3 * DAY),
  accessEvents: [{ type: "granted", at: new Date(now - 3 * DAY).toISOString(), accessLevel: grantedLevel }],
});
const visit = (accessId: string, maxPageIndex: number, hoursAgo: number) => ({
  accessId, renditionId: rid, startedAt: new Date(now - hoursAgo * 3_600_000 - 60_000), lastSeenAt: new Date(now - hoursAgo * 3_600_000), activeMs: 60_000, maxPageIndex,
});

assert.equal(isTrailingFootnote(pages[4] as any), true);
assert.equal(isTrailingFootnote(pages[3] as any), false, "the call to action is content");
assert.equal(isTrailingFootnote(pages[1] as any), false, "a titled prose block is content");

const links = [access("reachedCta", "teaser_only"), access("asked", "teaser_only"), access("stopped", "teaser_only"), access("upgraded", "blind")];
const requests = [{ id: "rq", dealId: "D", buyerAccessId: "asked", source: "teaser_request", status: "pending_broker_review", createdAt: new Date(now - 3_600_000), updatedAt: new Date(now - 3_600_000) }];
const e = computeTeaserEngagement({
  links: links as never,
  requests: requests as never,
  visits: [visit("reachedCta", 3, 30), visit("asked", 2, 2), visit("stopped", 1, 40), visit("upgraded", 4, 1)],
  blockSums: [],
  pageIndexes: new Map([[rid, pages as any]]),
  now,
});
const by = (id: string) => e.buyers.find((b) => b.accessId === id)!;
assert.equal(by("reachedCta").readToEnd, true, "reached 'Interested?' — the end (the confidentiality line isn't it)");
assert.equal(by("asked").readToEnd, true, "asked for the CIM — read to the end");
assert.equal(by("stopped").readToEnd, false);
assert.equal(by("stopped").furthestBlock, "The business");
assert.equal(e.funnel.readToEnd, 3, "reachedCta, asked, and the upgraded link (it reached the end too)");
// Opened today: the upgraded link (now Blind CIM) isn't a teaser-stage buyer.
assert.equal(e.openedToday, 1, "only 'asked' (still at the teaser) opened today");
assert.equal(teaserStageSubline({ openedToday: e.openedToday, worthACall: 0, freshLinkRequests: 0 }), "1 opened today");
const onlyUpgraded = computeTeaserEngagement({ links: [access("upgraded", "blind")] as never, requests: [], visits: [visit("upgraded", 4, 1)], blockSums: [], pageIndexes: new Map([[rid, pages as any]]), now });
assert.equal(onlyUpgraded.openedToday, 0, "no 'opened today' under an empty teaser stage");
console.log("teaser-engagement-end: ok");
