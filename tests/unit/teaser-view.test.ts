/**
 * Serving the teaser (shared/teaser-view.ts, server/teaser/summary.ts):
 *  - every block is re-checked with the CURRENT identity terms at serve: a
 *    block that names a fact added after publishing is held back (fail
 *    closed) and reported for the broker;
 *  - the header's chips and tagline are re-checked (a failing chip dropped);
 *  - blocks carry neutral keys (no slugs);
 *  - {price} / {contact} / {firm} filled in both number styles;
 *  - the codename blind buyers are served is used, the stored one swapped;
 *  - teaserSummary reports held blocks, and its cache follows published_rev
 *    and the deal's updatedAt.
 *
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/teaser-view.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { TeaserBlock, TeaserDoc } from "../../shared/teaser";

const deal0 = JSON.parse(readFileSync(new URL("../fixtures/teaser/pacific-deal.json", import.meta.url), "utf8"));
let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}
const at = new Date().toISOString();
const blk = (o: Partial<TeaserBlock> & { id: string }): TeaserBlock => ({
  slot: "custom", title: "", layoutType: "prose_highlight", layoutData: {}, body: null, hidden: false, origin: "ai", facts: [], updatedAt: at, ...o,
});

function doc(codename = "Project Coastline"): TeaserDoc {
  return {
    header: { label: "CONFIDENTIAL OPPORTUNITY", tagline: `${codename} — an established refrigerated carrier`, chips: ["Transportation & Logistics", "British Columbia", "Established 30+ years"] },
    blocks: [
      blk({ id: "b-key", slot: "key_numbers", origin: "fixed", layoutType: "metric_grid", layoutData: { cells: [
        { key: "revenue", label: "Revenue", value: "$30M–$35M" },
        { key: "askingPrice", label: "Asking price", value: "{price}" },
      ], columns: 2 } }),
      blk({ id: "b-over", slot: "overview", title: "The business", body: `${codename} runs refrigerated cross-border lanes for food distributors.`, layoutData: { body: `${codename} runs refrigerated cross-border lanes for food distributors.` } }),
      blk({ id: "b-high", slot: "highlights", title: "Investment highlights", layoutType: "callout_list", layoutData: { items: [{ title: "Long customer relationships", description: "Most revenue comes from repeat shippers." }], style: "list" } }),
      blk({ id: "b-next", slot: "next_step", title: "Interested?", origin: "fixed", layoutType: "numbered_list", layoutData: { items: [{ title: "Ask for the CIM from this page" }, { title: "{firm} reviews your request and opens the CIM for you" }, { title: "Questions? {contact}" }], ordered: true } }),
      blk({ id: "b-hidden", slot: "growth", title: "Room to grow", hidden: true, placeholder: true, layoutType: "callout_list", layoutData: { items: [] } }),
    ],
  };
}

async function main() {
  const { buildBuyerTeaser, teaserDocDiff, priceForTeaser, teaserTerms } = await import("../../shared/teaser-view");
  const contact = { firm: "Brassline Advisory Partners", name: "Morgan Ellis", email: "morgan@brassline.invalid", phone: "604-555-0100" };
  const input = (o: Partial<Parameters<typeof buildBuyerTeaser>[0]> = {}) => ({
    deal: deal0, doc: doc(), codename: "Project Coastline", codenameUsed: "Project Coastline",
    askingPrice: "$18,000,000", showAskingPrice: true, numbers: "ranges" as const, contact, ...o,
  });

  await check("a clean teaser serves its visible blocks with neutral keys and the tokens filled", () => {
    const t = buildBuyerTeaser(input());
    assert.deepEqual(t.leaked, []);
    assert.equal(t.blocks.length, 4, "the hidden placeholder isn't served");
    for (const b of t.blocks) assert.match(b.sectionKey, /^s_[0-9a-z]+$/, "neutral key");
    const all = JSON.stringify(t.blocks);
    assert.ok(all.includes("$17.5M–$20M"), "price as a range");
    assert.ok(all.includes("Brassline Advisory Partners reviews your request"), "firm filled");
    assert.ok(all.includes("Morgan Ellis · morgan@brassline.invalid · 604-555-0100"), "contact filled");
    assert.ok(!/\{price\}|\{firm\}|\{contact\}/.test(all));
    assert.equal(t.header.codename, "Project Coastline");
    assert.deepEqual(t.header.chips, ["Transportation & Logistics", "British Columbia", "Established 30+ years"]);
  });

  await check("price: rounded style, hidden → 'Price on request', none → the cell is dropped, identity in the text → on request", () => {
    let t = buildBuyerTeaser(input({ numbers: "rounded" }));
    assert.ok(JSON.stringify(t.blocks).includes("$18M"));
    t = buildBuyerTeaser(input({ showAskingPrice: false }));
    assert.ok(JSON.stringify(t.blocks).includes("Price on request"));
    t = buildBuyerTeaser(input({ askingPrice: null }));
    const key = t.blocks.find((b) => b.id === "b-key")!;
    assert.equal(((key.layoutData as { metrics: unknown[] }).metrics).length, 1, "no price cell");
    const terms = teaserTerms(deal0, "Project Coastline");
    assert.equal(priceForTeaser("$18M including the Surrey terminal", { show: true, numbers: "ranges", terms }), "Price on request");
  });

  await check("a fact added after publishing holds the block that now names it (fail closed)", () => {
    const deal = { ...deal0, extractedInfo: { ...deal0.extractedInfo, keyCustomers: "Fraserway Foods (since 2009)" } };
    const d = doc();
    d.blocks[1] = { ...d.blocks[1], body: "Project Coastline serves Fraserway Foods and other distributors.", layoutData: { body: "Project Coastline serves Fraserway Foods and other distributors." } };
    const t = buildBuyerTeaser(input({ deal, doc: d }));
    assert.deepEqual(t.leaked, ["b-over"]);
    assert.match(t.leakReasons["b-over"], /Fraserway/);
    assert.ok(!JSON.stringify(t.blocks).includes("Fraserway"));
  });

  await check("header: a chip naming the town is dropped; a tagline naming the business falls back to the industry", () => {
    const d = doc();
    d.header = { label: "CONFIDENTIAL OPPORTUNITY", tagline: "Pacific Coast Logistics — a strong carrier", chips: ["Surrey", "British Columbia"] };
    const t = buildBuyerTeaser(input({ doc: d }));
    assert.deepEqual(t.header.chips, ["British Columbia"]);
    assert.equal(t.header.tagline, "Transportation & Logistics");
  });

  await check("the served codename is used; the stored one is swapped", () => {
    const t = buildBuyerTeaser(input({ codename: "Project Meridian", codenameUsed: "Project Coastline" }));
    const all = JSON.stringify(t);
    assert.ok(!all.includes("Coastline"));
    assert.ok(all.includes("Project Meridian runs refrigerated"));
    assert.equal(t.header.codename, "Project Meridian");
    const none = buildBuyerTeaser(input({ codename: null }));
    assert.equal(none.header.codename, "Confidential Opportunity");
  });

  await check("teaserDocDiff counts changed, added, removed blocks", () => {
    const a = doc();
    const b = doc();
    b.blocks[1] = { ...b.blocks[1], body: "Changed." };
    b.blocks.push(blk({ id: "b-new", body: "New" }));
    const d = teaserDocDiff(b, { header: a.header, blocks: a.blocks.filter((x) => !x.hidden) });
    assert.equal(d.changed, 1);
    assert.equal(d.added, 1);
    assert.equal(d.removed, 0);
  });

  // teaserSummary: held blocks reach the broker; cache follows published_rev / updatedAt.
  const store = await import("../../server/teaser/store");
  const summary = await import("../../server/teaser/summary");
  const snap = await import("../../server/cim/published-snapshot");
  snap._setSnapshotStoreForTests(snap.memorySnapshotStore());
  const mem = store.memoryTeaserStore();
  store._setTeaserStoreForTests(mem);
  await mem.create("D-PAC", { draft: doc(), published: doc(), publishedRev: 1, publishedAt: new Date(), codenameUsed: "Project Coastline" });
  await check("teaserSummary: held blocks with current terms; the cache key follows published_rev and the deal's updatedAt", async () => {
    summary._resetTeaserSummaryCacheForTests();
    const dealA = { ...deal0, isLive: false, updatedAt: new Date("2026-10-01T00:00:00Z") };
    const s1 = await summary.teaserSummary(dealA as never, await store.getDealTeaser("D-PAC"), { counts: false });
    assert.equal(s1.status, "published");
    assert.deepEqual(s1.heldBlocks, []);
    // A new staff name on the facts: the published overview now names them.
    await mem.update("D-PAC", (r) => ({ published: { ...r.published!, blocks: r.published!.blocks.map((b) => (b.id === "b-over" ? { ...b, body: "Dispatch is run by Priya Natarajan.", layoutData: { body: "Dispatch is run by Priya Natarajan." } } : b)) } }));
    const s2 = await summary.teaserSummary(dealA as never, await store.getDealTeaser("D-PAC"), { counts: false });
    assert.deepEqual(s2.heldBlocks, [], "cached: same published_rev, draft_rev and updatedAt");
    const dealB = { ...dealA, updatedAt: new Date("2026-10-02T00:00:00Z"), extractedInfo: { ...deal0.extractedInfo, keyEmployees: `${deal0.extractedInfo.keyEmployees}; Priya Natarajan (Dispatch)` } };
    const s3 = await summary.teaserSummary(dealB as never, await store.getDealTeaser("D-PAC"), { counts: false });
    assert.equal(s3.heldBlocks.length, 1);
    assert.equal(s3.heldBlocks[0].title, "The business");
    assert.match(s3.heldBlocks[0].reason, /Priya Natarajan/);
    await mem.update("D-PAC", (r) => ({ publishedRev: r.publishedRev + 1, published: doc() }));
    const s4 = await summary.teaserSummary(dealB as never, await store.getDealTeaser("D-PAC"), { counts: false });
    assert.deepEqual(s4.heldBlocks, [], "republished clean: a new key");
  });

  console.log(`\n${passed} checks passed`);
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
