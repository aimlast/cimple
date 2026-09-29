/**
 * Live CIM under review, round 2 (checker findings):
 *  - buyers reading the kept copy keep its codename (a codename changed
 *    during the review applies with the update);
 *  - a section added / duplicated / created through the legacy route while
 *    buyers read the kept copy is part of the draft — it doesn't start
 *    hidden (it still does when buyers read the working copy);
 *  - old-style holds (not live) and live deals without a review behave as before.
 * Storage stubbed, copies in memory (no database, no AI).
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/published-snapshot-r2.test.ts
 */
import assert from "node:assert/strict";
import { storage } from "../../server/storage";
import { _setSnapshotStoreForTests, memorySnapshotStore, servedBlindCodename, takePublishedSnapshot } from "../../server/cim/published-snapshot";
import { buyersReadWorkingCopy } from "../../shared/cim-buyer-view";
import { legacySectionInsert } from "../../server/cim/approvals";

const store = memorySnapshotStore();
_setSnapshotStoreForTests(store);
const s = storage as any;
s.getCimSectionsByDeal = async () => [];
s.getCimSectionOverrides = async () => [];

const reviewing = { id: "d1", isLive: true, blindCodename: "Project Lantern", cimGeneration: { buyerHold: { servingPublished: true, since: "2026-09-29T00:00:00Z", buyers: 5, ddCleared: false } } };
const live = { id: "d1", isLive: true, blindCodename: "Project Lantern", cimGeneration: null };
const oldHold = { id: "d1", isLive: false, blindCodename: "Project Lantern", cimGeneration: { buyerHold: { since: "2026-09-27T00:00:00Z", buyers: 12 } } };
const draft = { id: "d1", isLive: false, blindCodename: null, cimGeneration: null };

// Who reads the working copy.
assert.equal(buyersReadWorkingCopy(live), true, "live, no review: new sections start hidden");
assert.equal(buyersReadWorkingCopy(reviewing), false, "buyers read the kept copy: the working copy is a draft");
assert.equal(buyersReadWorkingCopy(oldHold), false);
assert.equal(buyersReadWorkingCopy(draft), false);

// The legacy create route follows the same rule.
{
  const onLive = legacySectionInsert({ sectionTitle: "New" }, live as any);
  const onReview = legacySectionInsert({ sectionTitle: "New" }, reviewing as any);
  assert.ok(onLive.ok && onReview.ok);
  if (onLive.ok) assert.equal(onLive.fields.isVisible, false);
  if (onReview.ok) assert.equal(onReview.fields.isVisible, true);
}

(async () => {
  // The kept copy's codename is the one buyers keep.
  await takePublishedSnapshot({ id: "d1", blindCodename: "Project Lantern" });
  const renamed = { ...reviewing, blindCodename: "Project Harbour" };
  assert.equal(await servedBlindCodename(renamed), "Project Lantern", "renamed during the review: buyers keep the kept copy's codename");
  assert.equal(await servedBlindCodename({ ...renamed, cimGeneration: null }), null, "published: the deal's own codename");
  assert.equal(await servedBlindCodename({ ...renamed, isLive: false }), null);
  // A kept copy taken before any codename existed: the deal's own.
  await takePublishedSnapshot({ id: "d1", blindCodename: null });
  assert.equal(await servedBlindCodename(renamed), null);
  console.log("published-snapshot-r2: ok");
})().catch((e) => { console.error(e); process.exit(1); });
