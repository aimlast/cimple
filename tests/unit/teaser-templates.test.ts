/**
 * Teaser templates (shared/teaser-templates.ts, server/teaser/key-numbers.ts,
 * server/teaser/templates-store.ts):
 *  - the Main-street listing hides rows with no fact (never a placeholder);
 *  - the FF&E / inventory / real-estate / sale-type classifiers;
 *  - employees and years are always ranges, whatever the number style;
 *  - a saved template keeps the block order, titles and the broker's own
 *    wording — never the deal's text; applying it reproduces them;
 *  - a 21st saved template is refused; another broker's template is not found.
 *
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/teaser-templates.test.ts
 */
import assert from "node:assert/strict";

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

async function main() {
  const { TEASER_TEMPLATES, LISTING_FIELDS, templateFromSaved, slotsFor } = await import("../../shared/teaser-templates");
  const kn = await import("../../server/teaser/key-numbers");
  const ts = await import("../../server/teaser/templates-store");
  const { assembleTeaserDoc } = await import("../../server/teaser/generate");

  const base = kn.figuresFrom({
    deal: { industry: "HVAC services" },
    info: {
      annualRevenue: "$4,800,000",
      sde: "$1,312,000",
      employees: "27 full-time employees",
      yearsOperating: "22 years",
      locationSite: "Barrie, Ontario",
      assetsIncluded: "Service vans, tools and equipment",
      realEstateIncluded: "Leased premises (5-year lease with renewal)",
    },
    canon: null,
    askingPrice: "$4,800,000",
  });

  await check("the listing template hides rows with no fact (no placeholders)", () => {
    const rows = kn.listingRowsFor(base, { numbers: "rounded", showAskingPrice: true }, { financing: null, supportTraining: "The owner stays for the handover", reasonForSale: "Retirement" });
    const keys = rows.map((r) => r.key);
    assert.deepEqual(keys, ["askingPrice", "cashFlow", "grossRevenue", "ffe", "realEstate", "employees", "established", "supportTraining", "reasonForSale"]);
    assert.ok(!keys.includes("inventory") && !keys.includes("financing"), "no fact → hidden");
    assert.equal(rows.find((r) => r.key === "askingPrice")!.value, "{price}", "price filled at serve time");
    assert.equal(rows.find((r) => r.key === "cashFlow")!.value, "$1.3M");
    assert.equal(rows.find((r) => r.key === "grossRevenue")!.value, "$4.8M");
    assert.equal(rows.find((r) => r.key === "ffe")!.value, "Included");
    assert.equal(rows.find((r) => r.key === "realEstate")!.value, "Leased");
    assert.ok(rows.every((r) => r.value !== "" && !/\[|—/.test(r.value)));
    assert.equal(LISTING_FIELDS.length, 11);
  });

  await check("FF&E / inventory / real estate / sale type classifiers", () => {
    assert.deepEqual(kn.ffeOf({ ffeValue: "$240,000" }), { value: 240_000, included: true });
    assert.deepEqual(kn.ffeOf({ assetsIncluded: "Furniture and fixtures" }), { value: null, included: true });
    assert.equal(kn.ffeOf({ assetsIncluded: "Customer list only" }), null);
    assert.deepEqual(kn.inventoryOf({ inventory: "Inventory of about $85,000 at cost, in addition to the price" }), { value: 85_000, included: "extra" });
    assert.deepEqual(kn.inventoryOf({ inventory: "Inventory included" }), { value: null, included: "included" });
    assert.equal(kn.inventoryOf({ inventory: "About $85,000 on hand" }), null, "says neither → hidden");
    assert.equal(kn.realEstateOf("The owner owns the building; it is included in the sale"), "Owned — included");
    assert.equal(kn.realEstateOf("Building owned by the seller, available for purchase separately"), "Owned — available separately");
    assert.equal(kn.realEstateOf("10-year lease with the landlord"), "Leased");
    assert.equal(kn.realEstateOf("Downtown premises"), null);
    assert.equal(kn.saleTypeOf("Share sale (recommended); cash-free"), "Share sale");
    assert.equal(kn.saleTypeOf("Asset sale"), "Asset sale");
    assert.equal(kn.saleTypeOf("Share or asset sale, buyer's choice"), null);
  });

  await check("employees and years are ranges in both number styles", () => {
    for (const numbers of ["ranges", "rounded"] as const) {
      const cells = kn.keyCellsFor("one_page", base, { numbers, showAskingPrice: true });
      assert.equal(cells.find((c) => c.key === "employees")!.value, "25–49 employees");
      const rows = kn.listingRowsFor(base, { numbers, showAskingPrice: true });
      assert.equal(rows.find((r) => r.key === "established")!.value, "20+ years");
      assert.ok(!rows.some((r) => /\b27\b|\b22\b/.test(r.value)), "never the exact headcount or years");
    }
    assert.deepEqual(kn.headerChips(base), ["HVAC services", "Ontario", "Established 20+ years"]);
  });

  await check("the investor brief adds the margin range; the trend needs three printed years", () => {
    const cells = kn.keyCellsFor("investor", base, { numbers: "ranges", showAskingPrice: true });
    assert.equal(cells.find((c) => c.key === "margin")!.value, "20–30%");
    assert.equal(kn.trendLayoutData(base), null);
    const withYears = { ...base, revenueByYear: { "2022": 4_000_000, "2023": 4_400_000, "2024": 4_800_000 } };
    const t = kn.trendLayoutData(withYears)!;
    assert.equal(t.indexed, true);
    assert.deepEqual((t.data as Array<{ index: number }>).map((p) => p.index), [100, 110, 120]);
  });

  _store: {
    const mem = ts.memoryTemplatesStore();
    ts._setTemplatesStoreForTests(mem);
    const settings: Record<string, unknown> = {};
    ts._setTeaserSettingsStoreForTests({ async get() { return settings; }, async set(_b, v) { Object.assign(settings, v); } });

    const def = TEASER_TEMPLATES.one_page;
    const doc = assembleTeaserDoc({ def, figures: base, numbers: "ranges", showAskingPrice: true, wording: {}, written: null });
    // The broker's own wording on the confidentiality block; deal text in a custom block.
    const conf = doc.blocks.find((b) => b.slot === "confidentiality")!;
    conf.origin = "broker";
    conf.body = "Brassline keeps this confidential. Ask us, not the business.";
    conf.layoutData = { body: conf.body };
    doc.blocks.push({ id: "cust-1", slot: "custom", title: "Why now", layoutType: "prose_highlight", layoutData: { body: "Barrie HVAC demand is surging." }, body: "Barrie HVAC demand is surging.", hidden: false, origin: "ai", facts: [], updatedAt: new Date().toISOString() });

    await check("a saved template keeps order, titles and the broker's wording — never the deal's text", async () => {
      const saved = await ts.saveTeaserTemplate("B1", { name: "Brassline house style", basedOn: "one_page", doc, settings: { numbers: "ranges", pageSize: "letter", showAskingPrice: true }, makeDefault: true });
      const row = mem.rows.find((r) => r.id === saved.id)!;
      const json = JSON.stringify(row.blocks);
      for (const dealText of ["4.8", "1.3", "$", "Barrie", "25–49", "surging", "{price}"]) assert.ok(!json.includes(dealText), `${dealText} leaked into the template`);
      assert.ok(json.includes("Brassline keeps this confidential"), "the broker's own wording travels");
      const applied = templateFromSaved({ id: row.id, name: row.name, basedOn: row.basedOn, blocks: row.blocks, settings: row.settings });
      assert.deepEqual(applied.slots.map((s) => s.slot).slice(0, 6), def.slots.map((s) => s.slot));
      assert.deepEqual(applied.slots.map((s) => s.title).slice(0, 6), def.slots.map((s) => s.title));
      assert.equal(applied.fixedText?.confidentiality, "Brassline keeps this confidential. Ask us, not the business.");
      const redoc = assembleTeaserDoc({ def: applied, figures: base, numbers: "ranges", showAskingPrice: true, wording: {}, written: null });
      assert.equal(redoc.blocks.find((b) => b.slot === "confidentiality")!.body, "Brassline keeps this confidential. Ask us, not the business.");
      assert.equal(settings.defaultTemplate, `saved:${saved.id}`);
      assert.deepEqual(slotsFor(saved.key, applied).map((s) => s.slot), applied.slots.map((s) => s.slot));
    });

    await check("a 21st template is refused; another broker's template is not found", async () => {
      for (let i = mem.rows.length; i < ts.TEMPLATE_LIMIT; i++) await ts.saveTeaserTemplate("B1", { name: `T${i}`, basedOn: "two_page", doc, settings: {} });
      await assert.rejects(ts.saveTeaserTemplate("B1", { name: "One too many", basedOn: null, doc, settings: {} }), ts.TemplateLimitError);
      assert.equal(await ts.renameTeaserTemplate("B2", mem.rows[0].id, { name: "Mine now" }), null);
      assert.equal(await ts.deleteTeaserTemplate("B2", mem.rows[0].id), false);
      assert.equal(await ts.savedTemplateDef(`saved:${mem.rows[0].id}`, "B2"), null);
      assert.ok(await ts.savedTemplateDef(`saved:${mem.rows[0].id}`, "B1"));
      // Deleting the default clears it.
      assert.equal(await ts.deleteTeaserTemplate("B1", mem.rows[0].id), true);
      assert.equal((await ts.getTeaserSettings("B1")).defaultTemplate, null);
    });
  }

  console.log(`\n${passed} checks passed`);
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
