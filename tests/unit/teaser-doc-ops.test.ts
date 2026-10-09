/**
 * Editing the teaser (server/teaser/doc-ops.ts + server/teaser/store.ts):
 *  - every op, the rev conflict (409 "stale"), the "writing" lock;
 *  - limits; layouts outside TEASER_LAYOUTS refused; two_column with a
 *    financial_table column refused; a line chart without `indexed` refused;
 *  - the undo stack is ≤ 20;
 *  - key-number edit, reset, and recompute skipping edited cells;
 *  - "Deal at a glance": what the broker types in the column is kept (applied
 *    to the lines, never redrawn over); lines can be added and taken off and
 *    survive a refresh from the facts; the template start fills the lines the
 *    facts say plainly (sale type, reason, handover, financing) in fixed words;
 *  - the publish problems list (incl. the confidentiality review state);
 *  - the staleness diff;
 *  - a codename rename carries into the draft, the published doc and the
 *    seller-check doc.
 *
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/teaser-doc-ops.test.ts
 */
import assert from "node:assert/strict";
import type { TeaserDoc } from "../../shared/teaser";

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

async function main() {
  const ops = await import("../../server/teaser/doc-ops");
  const store = await import("../../server/teaser/store");
  const kn = await import("../../server/teaser/key-numbers");
  const { assembleTeaserDoc } = await import("../../server/teaser/generate");
  const { TEASER_TEMPLATES } = await import("../../shared/teaser-templates");
  const { validateTeaserLayout } = await import("../../shared/teaser");

  const f = kn.figuresFrom({
    deal: { industry: "Specialty pharmacy" },
    info: { annualRevenue: "$9,400,000", ebitda: "$1,150,000 adjusted EBITDA", employees: "41", yearsOperating: "26 years", locationSite: "Halifax, Nova Scotia", saleType: "Share sale" },
    canon: null,
    askingPrice: "$3,200,000",
  });
  const s = { numbers: "ranges" as const, showAskingPrice: true };
  const written = {
    out: { tagline: "An established specialty pharmacy", overview: "A specialty pharmacy serving long-term care homes.", highlights: [{ title: "Recurring care-home contracts", detail: "Most revenue repeats every month." }], growth: [], whoItSuits: ["A pharmacy group adding a region"], reasonForSale: "Retirement", transition: "A 6-month handover", managementNote: null, operationsNotes: [], listingPhrases: { financing: null, supportTraining: null, reasonForSale: null } },
    failed: new Set<never>(), pinpoint: new Map(), warnings: [],
  };
  const base: TeaserDoc = assembleTeaserDoc({ def: TEASER_TEMPLATES.one_page, figures: f, numbers: "ranges", showAskingPrice: true, wording: {}, written: written as never });
  base.header = { label: "CONFIDENTIAL OPPORTUNITY", tagline: "An established specialty pharmacy", chips: ["Specialty pharmacy", "Nova Scotia"] };
  const id = (slot: string) => base.blocks.find((b) => b.slot === slot)!.id;

  await check("patch a block; limits; the layout stays a teaser layout; editing marks it the broker's", () => {
    const d = ops.patchBlock(base, id("overview"), { body: "A specialty pharmacy serving long-term care." });
    const b = d.blocks.find((x) => x.id === id("overview"))!;
    assert.equal(b.body, "A specialty pharmacy serving long-term care.");
    assert.equal((b.layoutData as { body: string }).body, b.body, "body mirrored");
    assert.equal(b.origin, "broker");
    assert.throws(() => ops.patchBlock(base, id("overview"), { title: "x".repeat(121) }), /under 120/);
    assert.throws(() => ops.patchBlock(base, id("overview"), { body: "y".repeat(4001) }), /under 4,000/);
    assert.throws(() => ops.patchBlock(base, "nope", { title: "A" }), (e: { status?: number }) => e.status === 404);
  });

  await check("layouts outside TEASER_LAYOUTS refused; two_column with a financial_table refused; line chart needs indexed", () => {
    assert.throws(() => ops.addBlock(base, { layoutType: "financial_table", title: "P&L" }), /can't be used in a teaser/);
    assert.throws(() => ops.setLayout(base, id("overview"), "org_chart"), /can't be used in a teaser/);
    assert.throws(
      () => ops.patchBlock(base, id("opportunity"), { layoutData: { left: { title: "P&L", layoutType: "financial_table", content: { rows: [{ label: "Revenue", values: { "2024": 9400000 } }] } }, right: { title: "", content: "x", layoutType: "list" } } }),
      /not a chart or a table/,
    );
    assert.match(validateTeaserLayout({ layoutType: "line_chart", layoutData: { data: [{ name: "2024", revenue: 9400000 }] } })!, /as an index/);
    assert.equal(validateTeaserLayout({ layoutType: "line_chart", layoutData: { indexed: true, data: [{ name: "2022", index: 100 }, { name: "2024", index: 118 }] } }), null);
    assert.match(validateTeaserLayout({ layoutType: "line_chart", layoutData: { indexed: true, data: [{ name: "2024", index: "$9.4M" }] } })!, /as an index/);
  });

  await check("add (blank), duplicate, remove, reorder (a permutation only), same-family layout switch keeps content", () => {
    let d = ops.addBlock(base, { after: id("overview"), layoutType: "callout_list", title: "Why now" }).doc;
    const added = d.blocks[d.blocks.findIndex((b) => b.id === id("overview")) + 1];
    assert.equal(added.title, "Why now");
    assert.equal(added.slot, "custom");
    d = ops.duplicateBlock(d, id("highlights")).doc;
    assert.equal(d.blocks.filter((b) => b.slot === "highlights" || (b.slot === "custom" && b.title === "Investment highlights")).length, 2);
    d = ops.removeBlock(d, added.id);
    assert.ok(!d.blocks.some((b) => b.id === added.id));
    const ids = d.blocks.map((b) => b.id).reverse();
    assert.deepEqual(ops.reorder(d, ids).blocks.map((b) => b.id), ids);
    assert.throws(() => ops.reorder(d, ids.slice(1)), (e: { status?: number; code?: string }) => e.status === 409 && e.code === "stale");
    const swapped = ops.setLayout(base, id("highlights"), "numbered_list");
    const h = swapped.blocks.find((b) => b.id === id("highlights"))!;
    assert.equal(h.layoutType, "numbered_list");
    assert.equal((h.layoutData.items as unknown[]).length, 1, "content kept within the family");
    let many: TeaserDoc = base;
    while (many.blocks.length < 30) many = ops.addBlock(many, { layoutType: "divider", title: "" }).doc;
    assert.throws(() => ops.addBlock(many, { layoutType: "divider", title: "" }), /up to 30/);
  });

  await check("key numbers: typed over (Edited by you), reset from the facts, recompute skips edited cells", () => {
    const key = id("key_numbers");
    let d = ops.patchCell(base, key, "revenue", "About $9 million");
    let cells = d.blocks.find((b) => b.id === key)!.layoutData.cells as Array<{ key: string; value: string; edited?: boolean }>;
    assert.equal(cells.find((c) => c.key === "revenue")!.value, "About $9 million");
    assert.equal(cells.find((c) => c.key === "revenue")!.edited, true);
    assert.equal((d.blocks.find((b) => b.id === key)!.layoutData.metrics as Array<{ value: string }>)[0].value, "About $9 million", "metrics follow the cells");
    assert.throws(() => ops.patchCell(base, key, "revenue", "x".repeat(41)), /under 40/);
    // Switch numbers to rounded: unedited cells recompute, the edited one stays.
    const rounded = ops.recomputeFixed(d, "one_page", f, { numbers: "rounded", showAskingPrice: true });
    cells = rounded.doc.blocks.find((b) => b.id === key)!.layoutData.cells as typeof cells;
    assert.equal(cells.find((c) => c.key === "revenue")!.value, "About $9 million");
    assert.equal(cells.find((c) => c.key === "earnings")!.value, "$1.2M");
    // Reset the cell from the facts.
    const fresh = ops.freshCellsFor("key_numbers", "one_page", f, s);
    d = ops.patchCell(d, key, "revenue", null, fresh!);
    cells = d.blocks.find((b) => b.id === key)!.layoutData.cells as typeof cells;
    assert.equal(cells.find((c) => c.key === "revenue")!.value, "$9M–$10M");
    assert.ok(!cells.find((c) => c.key === "revenue")!.edited);
  });

  await check("Deal at a glance: the broker's column edit is kept (applied to the lines), never silently redrawn", () => {
    const opp = base.blocks.find((b) => b.slot === "opportunity")!;
    const right = (opp.layoutData.right as { content: string }).content;
    assert.ok(right.includes("Sale type: Share sale"), right);
    // The checker's case: typed into the right column → 200 and then thrown away. Now it's kept.
    const typed = "Sale type: Share sale\nReason for sale: Owner retiring after a long career\nTraining: Two weeks on site";
    const d = ops.patchBlock(base, opp.id, { layoutData: { ...opp.layoutData, right: { title: "Deal at a glance", layoutType: "metric", content: typed } } });
    const b = d.blocks.find((x) => x.id === opp.id)!;
    assert.equal((b.layoutData.right as { content: string }).content, "Sale type: Share sale\nReason for sale: Owner retiring after a long career\nTraining: Two weeks on site");
    const cells = b.layoutData.cells as Array<{ key: string; label: string; value: string; edited?: boolean; added?: boolean; removed?: boolean }>;
    assert.equal(cells.find((c) => c.key === "reasonForSale")!.edited, true);
    const added = cells.find((c) => c.label === "Training")!;
    assert.ok(added.key.startsWith("line_") && added.added && added.edited);
    const transition = cells.find((c) => c.key === "transition")!;
    assert.deepEqual([transition.removed, transition.value], [true, ""], "a fact line left out of the typed column is taken off");
    // A refresh from the facts keeps all of it (edited, added and taken-off lines).
    const re = ops.recomputeFixed(d, "one_page", f, s);
    assert.equal(((re.doc.blocks.find((x) => x.id === opp.id)!.layoutData.right) as { content: string }).content, (b.layoutData.right as { content: string }).content);
    // Not "Label: value": refused in plain words, never accepted and dropped.
    assert.throws(() => ops.patchBlock(base, opp.id, { layoutData: { ...opp.layoutData, right: { title: "Deal at a glance", layoutType: "metric", content: "Share sale. Owner retiring." } } }), /Label: value/);
    // An edit of the left column alone leaves the lines exactly as they were.
    const left = ops.patchBlock(base, opp.id, { layoutData: { ...opp.layoutData, left: { title: "Who it suits", layoutType: "list", content: "A regional pharmacy group" } } });
    assert.deepEqual(left.blocks.find((x) => x.id === opp.id)!.layoutData.cells, opp.layoutData.cells);
  });

  await check("Deal at a glance: add a line, take one off (a fact line comes back with Reset), limits", () => {
    const opp = base.blocks.find((b) => b.slot === "opportunity")!;
    const a = ops.addCellLine(base, opp.id, "Training", "Four weeks, plus phone support");
    let b = a.doc.blocks.find((x) => x.id === opp.id)!;
    assert.ok((b.layoutData.right as { content: string }).content.endsWith("Training: Four weeks, plus phone support"));
    assert.throws(() => ops.addCellLine(base, opp.id, "", "x"), /label and a value/);
    assert.throws(() => ops.addCellLine(base, opp.id, "Note: x", "y"), /colon/);
    assert.throws(() => ops.addCellLine(base, id("overview"), "Training", "x"), /Deal at a glance/);
    // Take off the broker's line: gone. Take off a fact line: hidden, and a refresh doesn't bring it back.
    let d = ops.removeCellLine(a.doc, opp.id, a.key);
    b = d.blocks.find((x) => x.id === opp.id)!;
    assert.ok(!(b.layoutData.cells as Array<{ key: string }>).some((c) => c.key === a.key));
    d = ops.removeCellLine(d, opp.id, "saleType");
    b = d.blocks.find((x) => x.id === opp.id)!;
    assert.ok(!(b.layoutData.right as { content: string }).content.includes("Sale type"));
    const re = ops.recomputeFixed(d, "one_page", f, s);
    assert.ok(!((re.doc.blocks.find((x) => x.id === opp.id)!.layoutData.right) as { content: string }).content.includes("Sale type"), "a refresh doesn't bring it back");
    const fresh = ops.freshCellsFor("opportunity", "one_page", f, s, b)!;
    const back = ops.patchCell(d, opp.id, "saleType", null, fresh);
    assert.ok(((back.blocks.find((x) => x.id === opp.id)!.layoutData.right) as { content: string }).content.includes("Sale type: Share sale"), "Reset from the facts brings it back");
    // At most 8 lines.
    let many = base;
    for (let i = 0; i < 8; i++) { try { many = ops.addCellLine(many, opp.id, `Line ${i}`, "x").doc; } catch { /* full */ } }
    assert.throws(() => ops.addCellLine(many, opp.id, "One more", "x"), /8 lines/);
  });

  await check("template start (no AI): the facts' lines in fixed words, and an empty column can be given lines", () => {
    const facts = kn.figuresFrom({
      deal: { industry: "HVAC services" },
      info: {
        annualRevenue: "$4,800,000", sde: "$1,312,000", locationSite: "Barrie, Ontario",
        reasonForSale: "Owner Gord Ellison is retiring after 22 years",
        transitionPlan: "Gord will stay on for a 6-month handover; the service manager stays",
        sellerFinancing: "Vendor take-back of up to 20% considered",
      },
      canon: null,
      askingPrice: "$4,800,000",
    });
    assert.deepEqual(facts.phrases, { reasonForSale: "Owner retiring", transition: "6-month handover", financing: "Vendor financing available", supportTraining: "6-month handover" });
    const doc = assembleTeaserDoc({ def: TEASER_TEMPLATES.one_page, figures: facts, numbers: "ranges", showAskingPrice: true, wording: {}, written: null });
    const opp = doc.blocks.find((b) => b.slot === "opportunity")!;
    assert.equal(opp.hidden, false);
    assert.equal((opp.layoutData.right as { content: string }).content, "Reason for sale: Owner retiring\nOwner transition: 6-month handover");
    assert.ok(!JSON.stringify(opp).includes("Gord"), "never the facts' own words");
    const listing = assembleTeaserDoc({ def: TEASER_TEMPLATES.listing, figures: facts, numbers: "rounded", showAskingPrice: true, wording: {}, written: null });
    const rows = (listing.blocks.find((b) => b.slot === "listing_facts")!.layoutData.cells as Array<{ key: string; value: string }>);
    assert.equal(rows.find((r) => r.key === "financing")!.value, "Vendor financing available");
    assert.equal(rows.find((r) => r.key === "reasonForSale")!.value, "Owner retiring");
    assert.equal(rows.find((r) => r.key === "supportTraining")!.value, "6-month handover");
    const inv = assembleTeaserDoc({ def: TEASER_TEMPLATES.investor, figures: facts, numbers: "ranges", showAskingPrice: true, wording: {}, written: null });
    assert.equal(((inv.blocks.find((b) => b.slot === "deal_structure")!.layoutData.left) as { content: string }).content, "Owner transition: 6-month handover. Reason for sale: Owner retiring");
    // Sensitive reasons are never stated; nothing plain → no line, and the broker adds one.
    assert.equal(kn.reasonForSalePhrase("Owner's health — a recent diagnosis; retiring early"), null);
    assert.equal(kn.reasonForSalePhrase("Partners in a dispute"), null);
    assert.equal(kn.financingPhrase("No vendor financing"), null);
    assert.equal(kn.transitionPhrase("Owner will not stay on"), null);
    const bare = kn.figuresFrom({ deal: { industry: "HVAC services" }, info: { annualRevenue: "$4,800,000" }, canon: null, askingPrice: null });
    const empty = assembleTeaserDoc({ def: TEASER_TEMPLATES.one_page, figures: bare, numbers: "ranges", showAskingPrice: true, wording: {}, written: null });
    const eo = empty.blocks.find((b) => b.slot === "opportunity")!;
    assert.equal(eo.hidden, true, "nothing to show yet");
    const added = ops.addCellLine(empty, eo.id, "Sale type", "Asset sale").doc.blocks.find((b) => b.id === eo.id)!;
    assert.equal(added.hidden, false, "shown once it has a line");
    assert.ok(!added.placeholder);
    assert.equal((added.layoutData.right as { content: string }).content, "Sale type: Asset sale");
  });

  await check("header patch: limits on the tagline and chips", () => {
    const d = ops.patchHeader(base, { tagline: "A care-home pharmacy", chips: ["Pharmacy", "Nova Scotia"] });
    assert.equal(d.header!.tagline, "A care-home pharmacy");
    assert.throws(() => ops.patchHeader(base, { tagline: "z".repeat(141) }), /under 140/);
    assert.throws(() => ops.patchHeader(base, { chips: ["a", "b", "c", "d", "e", "f"] }), /up to 5/);
  });

  await check("publish problems: header, ≥ 2 visible blocks, held/placeholder/sample blocks, the review, discrepancies, the codename", () => {
    const ok = ops.publishProblems(base, { codenameProblem: null, checks: [], headerProblem: null, reviewOk: true, discrepancyReasons: [] });
    assert.deepEqual(ok, []);
    const noReview = ops.publishProblems(base, { codenameProblem: null, checks: [], headerProblem: null, reviewOk: false, discrepancyReasons: [] });
    assert.ok(noReview.some((p) => /confidentiality check couldn't run/.test(p)));
    const held = ops.publishProblems(base, { codenameProblem: "It contains “Halifax”.", checks: [{ blockId: id("overview"), held: true, reason: "it names “Halifax” (the town)", layoutProblem: null, sample: false }], headerProblem: null, reviewOk: true, discrepancyReasons: ["Revenue has an open question that changes what the teaser shows."] });
    assert.equal(held.length, 3);
    assert.ok(held.some((p) => /Halifax/.test(p) && /Reword it/.test(p)));
    const thin: TeaserDoc = { header: base.header, blocks: base.blocks.map((b, i) => ({ ...b, hidden: i > 0 })) };
    assert.ok(ops.publishProblems(thin, { codenameProblem: null, checks: [], headerProblem: null, reviewOk: true, discrepancyReasons: [] }).some((p) => /at least two/.test(p)));
    const visiblePlaceholder: TeaserDoc = { header: base.header, blocks: base.blocks.map((b) => (b.slot === "overview" ? { ...b, placeholder: true } : b)) };
    assert.ok(ops.publishProblems(visiblePlaceholder, { codenameProblem: null, checks: [], headerProblem: null, reviewOk: true, discrepancyReasons: [] }).some((p) => /still empty/.test(p)));
    const snap = ops.publishedSnapshot({ header: base.header, blocks: [...base.blocks, { ...base.blocks[1], id: "hid", hidden: true }] });
    assert.ok(!snap.blocks.some((b) => b.id === "hid"), "the snapshot holds visible blocks only");
  });

  await check("staleness: facts changed since publishing (edited cells skipped)", () => {
    const later = { ...f, revenue: 12_600_000 };
    const st = ops.teaserStaleness(base, "one_page", later, s);
    assert.deepEqual(st.filter((x) => x.label === "Revenue"), [{ label: "Revenue", published: "$9M–$10M", now: "$12.5M–$15M" }]);
    const edited = ops.patchCell(base, id("key_numbers"), "revenue", "Around $9M");
    assert.deepEqual(ops.teaserStaleness(edited, "one_page", later, s).filter((x) => x.label === "Revenue"), []);
  });

  // ── The store: rev conflicts, the writing lock, undo ≤ 20, background writers ──
  const mem = store.memoryTeaserStore();
  store._setTeaserStoreForTests(mem);
  await mem.create("D1", { draft: base });

  await check("saveDraft: a stale rev → 409 stale; a full rewrite running → 409 writing; owned blocks locked", async () => {
    await assert.rejects(store.saveDraft("D1", 5, (doc) => ({ doc, reason: "x" })), (e: { code?: string }) => e.code === "stale");
    const r = await store.saveDraft("D1", 0, (doc) => ({ doc: ops.patchBlock(doc, id("overview"), { body: "First edit." }), reason: "Edited a block" }), [id("overview")]);
    assert.equal(r.draftRev, 1);
    assert.equal(r.history.length, 1);
    await store.setGeneration("D1", { status: "running", startedAt: new Date().toISOString(), warnings: [], ownedBlockIds: [], fullRewrite: true });
    await assert.rejects(store.saveDraft("D1", 1, (doc) => ({ doc, reason: "x" }), []), (e: { code?: string }) => e.code === "writing");
    await store.setGeneration("D1", { status: "running", startedAt: new Date().toISOString(), warnings: [], ownedBlockIds: [id("highlights")], fullRewrite: false });
    await assert.rejects(store.saveDraft("D1", 1, (doc) => ({ doc, reason: "x" }), [id("highlights")]), (e: { code?: string }) => e.code === "writing");
    const ok = await store.saveDraft("D1", 1, (doc) => ({ doc: ops.patchBlock(doc, id("overview"), { body: "Second edit." }), reason: "Edited a block" }), [id("overview")]);
    assert.equal(ok.draftRev, 2);
    // A run older than 3 minutes reads as interrupted.
    await store.setGeneration("D1", { status: "running", startedAt: new Date(Date.now() - 4 * 60_000).toISOString(), warnings: [], ownedBlockIds: [], fullRewrite: true });
    const row = await store.getDealTeaser("D1");
    assert.equal(row!.generation!.status, "failed");
    assert.match(row!.generation!.error!, /Interrupted/);
  });

  await check("history keeps at most 20 drafts (undo)", async () => {
    let row = (await store.getDealTeaser("D1"))!;
    for (let i = 0; i < 25; i++) row = await store.saveDraft("D1", row.draftRev, (doc) => ({ doc: ops.patchBlock(doc, id("overview"), { body: `Edit ${i}` }), reason: "Edited a block" }), [id("overview")]);
    assert.equal(row.history.length, store.HISTORY_MAX);
    const u = ops.undoDoc(row.history)!;
    assert.equal(u.doc.blocks.find((b) => b.id === id("overview"))!.body, "Edit 23");
    assert.equal(ops.undoDoc([]), null);
  });

  await check("background writer: a broker edit made during the run wins; other owned blocks are filled; rev bumped once", async () => {
    const startedAt = new Date(Date.now() - 1000).toISOString();
    const row0 = (await store.getDealTeaser("D1"))!;
    // The broker edits highlights after the run started.
    await store.setGeneration("D1", null);
    const edited = await store.saveDraft("D1", row0.draftRev, (doc) => ({ doc: ops.patchBlock(doc, id("highlights"), { title: "My highlights" }), reason: "Edited a block" }), [id("highlights")]);
    const incoming = edited.draft.blocks.filter((b) => b.id === id("highlights") || b.id === id("overview")).map((b) => ({ ...b, body: "AI text", title: "AI title", origin: "ai" as const, updatedAt: new Date().toISOString() }));
    // overview: placeholder → the run fills it
    await mem.update("D1", (r) => ({ draft: { ...r.draft, blocks: r.draft.blocks.map((b) => (b.id === id("overview") ? { ...b, placeholder: true, updatedAt: startedAt } : b)) } }));
    const before = (await store.getDealTeaser("D1"))!.draftRev;
    const r = await store.saveOwnedBlocks("D1", { startedAt, ownedBlockIds: [id("highlights"), id("overview")] }, incoming);
    assert.deepEqual(r.skipped, [id("highlights")]);
    assert.deepEqual(r.written, [id("overview")]);
    assert.equal(r.row!.draftRev, before + 1);
    assert.equal(r.row!.draft.blocks.find((b) => b.id === id("highlights"))!.title, "My highlights");
    assert.equal(r.row!.draft.blocks.find((b) => b.id === id("overview"))!.title, "AI title");
  });

  await check("a codename rename carries into the draft, the published doc and the seller-check doc", async () => {
    const withName = (d: TeaserDoc): TeaserDoc => ({ ...d, header: { ...d.header!, tagline: "Project Harbour — a care-home pharmacy" } });
    await mem.update("D1", (r) => ({ draft: withName(r.draft), published: withName(base), sellerCheck: { status: "sent", sentAt: new Date().toISOString(), sentRev: r.draftRev, doc: withName(base) } }));
    const re = /Project Harbour/g;
    const n = await store.renameTeaserCodename("D1", (t) => t.replace(re, "Project Meridian"), "Project Meridian");
    assert.equal(n, 3);
    const row = (await store.getDealTeaser("D1"))!;
    for (const d of [row.draft, row.published!, row.sellerCheck!.doc]) assert.equal(d.header!.tagline, "Project Meridian — a care-home pharmacy");
    assert.equal(row.codenameUsed, "Project Meridian");
  });

  console.log(`\n${passed} checks passed`);
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
