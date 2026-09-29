/**
 * F2-ANALYTICS-3 (final review): a buyer whose access was revoked is never
 * on the call list or the pulse's top buyers — their reading still counts,
 * and they stay listed (labelled) in the Buyers view.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/unit/engagement-revoked.test.ts
 */
import assert from "node:assert/strict";
import { assembleFacts } from "../../server/engagement/facts";
import { buildCallList } from "../../server/routes/engagement-insights";
import { buildBuyersResponse, buildSummaryResponse } from "../../server/engagement/responses";
import { DEFAULT_ENGAGEMENT_FILTERS } from "../../shared/analytics-v2";

const now = new Date("2026-09-28T16:00:00Z");
const R = "r".repeat(32);
const page = (id: string, order: number, title: string, layoutType = "prose_highlight") => ({
  pageId: id, lineageId: id, order, parts: 1, servedTitle: title, layoutType, locked: false, expectedMs: 30_000, blockFingerprint: "fp" + id,
  blocks: [{ key: "para:0", kind: "text", label: "Paragraph 1", expectedMs: 30_000, part: 0 }],
});
const pages = [page("exec", 0, "Executive Summary"), page("fin", 1, "Income Statement", "financial_table"), page("deal", 2, "Transaction Overview")];
const access = (id: string, name: string, revokedAt: Date | null) => ({
  id, dealId: "d1", buyerName: name, buyerEmail: `${id}@x.invalid`, buyerCompany: "Co", accessLevel: "loi", createdAt: new Date(now.getTime() - 10 * 86400e3),
  firstViewedAt: new Date(now.getTime() - 2 * 86400e3), revokedAt, decision: "under_review", accessEvents: [],
}) as any;
const visit = (id: string, accessId: string) => ({
  id, accessId, renditionId: R, startedAt: new Date(now.getTime() - 3 * 3600e3), lastSeenAt: new Date(now.getTime() - 2 * 3600e3),
  wallMs: 1_800_000, activeMs: 1_500_000, deviceClass: "desktop", uaFamily: "Chrome", maxPageIndex: 2, path: [[0, "exec"], [60, "fin"], [900, "deal"]], legacy: false, ipHash: null,
});
const sums = (accessId: string) => pages.map((p) => ({ accessId, renditionId: R, lineageId: p.pageId, pageId: p.pageId, blockKey: "para:0", attentionMs: p.pageId === "fin" ? 400_000 : 90_000, skimMs: 0, visibleMs: 500_000, pointerMs: 0, firstAt: now, lastAt: now }));
const revokedAt = new Date(now.getTime() - 3600e3);
const facts = assembleFacts({
  deal: { id: "d1", businessName: "Deal", buyerDeepCheck: null } as any, filters: DEFAULT_ENGAGEMENT_FILTERS, now,
  accesses: [access("revoked1", "Competitor Co buyer", revokedAt), access("ok1", "Active buyer", null)],
  live: [], renditions: [{ id: R, mode: "normal", variant: "full", createdAt: now, visits: 2 }], chosen: { id: R, mode: "normal", variant: "full", createdAt: now, visits: 2 } as any,
  indexes: new Map([[R, pages as any]]), visits: [visit("v1", "revoked1"), visit("v2", "ok1")] as any, sums: [...sums("revoked1"), ...sums("ok1")] as any,
  visitPages: [], events: [], questions: [], decisions: [],
} as any);

assert.equal(facts.buyers.find((b) => b.accessId === "revoked1")?.revokedAt, revokedAt.toISOString(), "revokedAt reaches the facts");
assert.deepEqual(buildCallList([{ deal: { id: "d1", businessName: "Deal" }, facts }]).map((e) => e.name), ["Active buyer"], "the revoked buyer is not a call");
assert.deepEqual(buildSummaryResponse(facts, true, "Deal").top.map((e) => e.name), ["Active buyer"], "nor a top buyer on the pulse");
const card = buildBuyersResponse(facts).buyers.find((b) => b.accessId === "revoked1");
assert.ok(card, "still listed in the Buyers view");
assert.equal(card!.statusLabel, "Access revoked");

console.log("engagement-revoked: all assertions passed");
