/**
 * Integration of the rebuild follow-ups (kept copy of a live CIM while a
 * regenerated one is reviewed) onto review round 2 (a live CIM serves each
 * section in its last APPROVED version — shared/cim-published.ts).
 *
 *  - The kept copy is what buyers were SERVED: an unapproved change is kept
 *    in its approved version (named, Blind and DD), a never-approved section
 *    is left out, and a section with no approved Blind version stays held
 *    back from Blind buyers.
 *  - buyerCimRows serves the kept copy as it stands (published: null — the
 *    records on file belong to the draft by then) and passes the live CIM's
 *    records otherwise.
 *  - Deleting a deal deletes its kept copy (DEAL_CHILD_TABLES).
 * Storage stubbed, copies in memory (no database, no AI).
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/integ-rebuild-staff.test.ts
 */
import assert from "node:assert/strict";
import { getTableConfig } from "drizzle-orm/pg-core";
import { storage } from "../../server/storage";
import { _setSnapshotStoreForTests, buyerCimRows, memorySnapshotStore, servedCopy, takePublishedSnapshot } from "../../server/cim/published-snapshot";
import { buildBuyerCim } from "../../shared/cim-buyer-view";
import { publishedOverrideOf, publishedSectionOf, PUBLISHED_BLIND_MODE, PUBLISHED_MODE } from "../../shared/cim-published";
import { DEAL_CHILD_TABLES } from "../../server/deals/delete-deal";

const dealId = "deal-integ";
const sec = (id: string, title: string, body: string, extra: Record<string, unknown> = {}): any => ({
  id, dealId, sectionKey: title.toLowerCase().replace(/\W+/g, "_"), sectionTitle: title, order: Number(id.replace(/\D/g, "")) || 1,
  layoutType: "prose_highlight", layoutData: { body }, aiDraftContent: body, brokerEditedContent: null, isVisible: true, accessTier: "teaser",
  blindStaleAt: null, ddStaleAt: null, aiTask: null, aiLayoutReasoning: "", brokerApproved: false, updatedAt: new Date().toISOString(), ...extra,
});
const ov = (id: string, sectionId: string, mode: string, layoutData: unknown): any => ({ id, dealId, cimSectionId: sectionId, mode, layoutData, contentOverride: null, createdAt: new Date() });

// A: approved as it stands. B: changed since approval (record on file, with
// its Blind version). C: never approved. D: changed, recorded named version
// only (its Blind version was stale when approved).
const approvedB = sec("s2", "Operations", "APPROVED operations text.");
const sections = [
  sec("s1", "Overview", "Approved overview.", { brokerApproved: true }),
  sec("s2", "Operations", "UNAPPROVED EDIT of operations."),
  sec("s3", "Brand new", "NEVER APPROVED section."),
  sec("s4", "Growth", "UNAPPROVED growth edit."),
];
const blind = [
  ov("b1", "s1", "blind", { body: "Blind overview." }),
  ov("b2", "s2", "blind", { body: "Blind UNAPPROVED edit." }),
  ov("b4", "s4", "blind", { body: "Blind UNAPPROVED growth." }),
];
const published = [
  ov("p2", "s2", PUBLISHED_MODE, publishedSectionOf(approvedB)),
  ov("p2b", "s2", PUBLISHED_BLIND_MODE, publishedOverrideOf({ layoutData: { body: "Blind APPROVED operations." }, contentOverride: null }, "Operations (blind)")),
  ov("p4", "s4", PUBLISHED_MODE, publishedSectionOf(sec("s4", "Growth", "APPROVED growth text."))),
];

const copy = servedCopy({ deal: { id: dealId, isLive: true }, sections, blindOverrides: blind, ddOverrides: [], published });
assert.deepEqual(copy.sections.map((s) => s.id), ["s1", "s2", "s4"], "the never-approved section is not kept");
const text = JSON.stringify(copy);
assert.doesNotMatch(text, /UNAPPROVED|NEVER APPROVED/, "no unapproved content is kept");
assert.match(text, /APPROVED operations text/);
assert.match(text, /Blind APPROVED operations/);
const s4 = copy.sections.find((s) => s.id === "s4")!;
assert.ok(s4.blindStaleAt, "no approved Blind version: held back from Blind buyers");
console.log("  ✓ the kept copy is what buyers were served (approved versions only)");

// Stored and served: the same as buyers had, no re-filtering of the copy.
const store = memorySnapshotStore();
_setSnapshotStoreForTests(store);
const st = storage as any;
st.getCimSectionsByDeal = async () => sections;
st.getCimSectionOverrides = async (_d: string, mode: string) => (mode === "blind" ? blind : mode.startsWith("published") ? published.filter((p) => p.mode === mode) : []);
const deal: any = { id: dealId, businessName: "Integ Co", blindCodename: "Project Integ", isLive: true, extractedInfo: {}, cimGeneration: null };
await takePublishedSnapshot(deal);
deal.cimGeneration = { status: "done", buyerHold: { since: "2026-09-29T00:00:00Z", wasLive: true, buyers: 2, ddCleared: false, servingPublished: true } };
const named = await buyerCimRows(deal, "loi");
assert.equal(named.fromSnapshot, true);
assert.equal(named.published, null, "the kept copy is served as it stands");
const namedCim = buildBuyerCim({ deal, accessLevel: "loi", sections: named.sections as any, overrides: named.overrides as any, media: [], published: named.published });
assert.deepEqual(namedCim.sections.map((s) => s.sectionTitle), ["Overview", "Operations", "Growth"]);
assert.doesNotMatch(JSON.stringify(namedCim.sections), /UNAPPROVED|NEVER APPROVED/);
const blindRows = await buyerCimRows(deal, "teaser");
const blindCim = buildBuyerCim({ deal, accessLevel: "teaser", sections: blindRows.sections as any, overrides: blindRows.overrides as any, media: [], published: blindRows.published });
assert.doesNotMatch(JSON.stringify(blindCim.sections), /UNAPPROVED/);
assert.equal(blindCim.sections.length, 2, "s4 held back from Blind buyers");
console.log("  ✓ buyers of a live CIM under review get the kept copy, never the draft or an unapproved change");

_setSnapshotStoreForTests(null);

// The deal delete covers the kept copy.
const tables = new Set(Object.values(DEAL_CHILD_TABLES).map((e) => getTableConfig(e.table as any).name));
assert.ok(tables.has("cim_published_snapshots"));
console.log("  ✓ deleting a deal deletes its kept copy");

console.log("integ-rebuild-staff: ok");
process.exit(0);
