/**
 * Writing the teaser (server/teaser/generate.ts, brief.ts) with STUBBED
 * models only — the teaser model (_setTeaserModelForTests), the
 * confidentiality review (_setKeepOutModelForTests) and the Blind CIM's
 * redaction engine (setRedactionModelForTests). The brief runs on the real
 * database-backed code paths with storage stubbed in memory.
 *
 *  (a) a clean output → the doc per template, fixed blocks filled, basis blind_cim
 *  (b) a highlight naming a customer → dropped, with a warning
 *  (c) the overview naming the town → one retry → clean → used
 *  (d) the retry leaks again → a hidden placeholder
 *  (e) an output with a figure → that field fails
 *  (f) the prompt has no identity term, no keep-out clause, no private note, no figure
 *  (g) the model throws → a template draft + the error sentence
 *  (h) the gate: no revenue or earnings → the copy
 *  (i) one run per deal
 *  (j) the review fails → no teaser model call, template draft, reviewFailed
 *  (k) no Blind CIM → the facts go through the redaction engine (an unknown
 *      customer never reaches the prompt); a throwing redaction → template
 *  (l) with a Blind CIM → narrative from the served blind sections only
 *  (m) pinpointing in the overview → one retry → still there → kept, warned
 *  (n) the discrepancy gate in the teaser's number style
 *
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/teaser-generate.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.DISABLE_SCHEDULERS = "1";
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: unknown) => {
  throw new Error(`test: blocked outbound fetch to ${String(url)}`);
}) as never;
void realFetch;

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/teaser/${name}`, import.meta.url), "utf8"));
const pacific = fixture("pacific-deal.json");
const written = fixture("pacific-write_teaser.json");

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

async function main() {
  const { storage } = await import("../../server/storage");
  const gen = await import("../../server/teaser/generate");
  const store = await import("../../server/teaser/store");
  const keepOut = await import("../../server/cim/keep-out");
  const redaction = await import("../../server/cim/redaction-engine");
  const snap = await import("../../server/cim/published-snapshot");
  const { dbBriefDeps } = await import("../../server/teaser/brief");
  const { TEASER_TEMPLATES } = await import("../../shared/teaser-templates");

  snap._setSnapshotStoreForTests(snap.memorySnapshotStore());
  const mem = store.memoryTeaserStore();
  store._setTeaserStoreForTests(mem);

  // ── Storage in memory ──
  const deals = new Map<string, Record<string, unknown>>();
  const sections = new Map<string, unknown[]>();
  const overrides = new Map<string, unknown[]>();
  const discrepancies = new Map<string, unknown[]>();
  Object.assign(storage as never, {
    getDeal: async (id: string) => deals.get(id),
    getResolvedDiscrepancies: async () => [],
    getDiscrepanciesByDeal: async (id: string) => discrepancies.get(id) ?? [],
    getFinancialAnalysesByDeal: async () => [],
    getDocumentsByDeal: async () => [],
    getCimSectionsByDeal: async (id: string) => sections.get(id) ?? [],
    getCimSectionOverrides: async (id: string) => overrides.get(id) ?? [],
    getBrandingByBroker: async () => undefined,
    updateDeal: async () => undefined,
  });

  // The stubbed models.
  let keepOutCalls = 0;
  let keepOutFails = false;
  keepOut._setKeepOutModelForTests({
    messages: {
      create: (async () => {
        keepOutCalls++;
        if (keepOutFails) throw Object.assign(new Error("overloaded"), { status: 529 });
        return fixture("keep-out-nothing-held.json");
      }) as never,
    },
  } as never);
  let redactionReply: (() => Promise<{ text: string; stopReason: string }>) | null = null;
  redaction.setRedactionModelForTests(async () => {
    if (!redactionReply) throw new Error("no redaction expected");
    return redactionReply();
  });
  const prompts: Array<{ system: string; user: string }> = [];
  let replies: Array<Record<string, unknown> | Error> = [];
  gen._setTeaserModelForTests(async (req) => {
    prompts.push({ system: req.system, user: req.user });
    const next = replies.shift();
    if (!next) throw new Error("test: no reply queued");
    if (next instanceof Error) throw next;
    return { input: next, usage: { input: 4200, output: 900 } };
  });
  gen._setTeaserBriefDepsForTests(dbBriefDeps);

  // ── A deal with a Blind CIM ──
  const pac = {
    ...pacific,
    isLive: false,
    cimGeneration: null,
    extractedInfo: { ...pacific.extractedInfo, _brokerPrivateNotes: [{ text: "Keep the Alderbrook RFP out of the CIM — confidential to buyers", at: "2026-09-01" }] },
  };
  deals.set(pac.id, pac);
  const sec = (id: string, key: string, title: string, layoutType: string, text: string, extra: Record<string, unknown> = {}) => ({
    id, dealId: pac.id, sectionKey: key, sectionTitle: title, order: Number(id.slice(1)), layoutType, layoutData: layoutType === "prose_highlight" ? { body: text } : { rows: [] },
    aiDraftContent: text, brokerEditedContent: null, isVisible: true, brokerApproved: true, blindStaleAt: null, blindTitle: null, ...extra,
  });
  sections.set(pac.id, [
    sec("S1", "executiveSummary", "Executive summary", "prose_highlight", "Pacific Coast Logistics Ltd. is a Surrey carrier owned by Harjit Sandhu with 112 trucks and $31.02M revenue."),
    sec("S2", "financialPerformance", "Financial performance", "financial_table", ""),
    sec("S3", "customers", "Customers", "prose_highlight", "Alderbrook Foods is 22% of revenue.", { blindStaleAt: new Date() }),
    sec("S4", "growthStrategies", "Growth", "prose_highlight", "Open a terminal in Calgary."),
  ]);
  const ov = (sid: string, text: string) => ({ id: `O${sid}`, dealId: pac.id, cimSectionId: sid, mode: "blind", layoutData: { body: text }, contentOverride: text, createdAt: new Date() });
  overrides.set(pac.id, [
    ov("S1", "Project Coastline is a regional refrigerated carrier in British Columbia with a modern terminal, a fleet of over 100 trucks and revenue above $30M since 2019."),
    ov("S3", "Customer A is a large share of revenue."),
    ov("S4", "Room to add a second terminal in a neighbouring province."),
  ]);

  const run = async (dealId: string, templateKey = "one_page", mode: "ai" | "template" = "ai") => {
    const d = deals.get(dealId)! as never;
    const started = await gen.startTeaserGeneration(d, { templateKey, mode });
    assert.deepEqual(started, { started: true });
    return (await gen.waitForTeaser(dealId))!;
  };
  // The words buyers could read (block ids are random uuids — "…62112c" once tripped the "112" check).
  const textOf = (row: Awaited<ReturnType<typeof run>>) => JSON.stringify(row.draft, (k, v) => (k === "id" ? undefined : v));

  await check("(a) a clean output: the One-page doc, fixed blocks from code, basis blind_cim", async () => {
    replies = [written];
    const row = await run(pac.id);
    assert.equal(row.generation!.status, "done");
    assert.equal(row.generation!.basis, "blind_cim");
    assert.equal(row.generation!.error, null);
    assert.deepEqual(row.draft.blocks.map((b) => b.slot), TEASER_TEMPLATES.one_page.slots.map((s) => s.slot));
    const key = row.draft.blocks.find((b) => b.slot === "key_numbers")!;
    const cells = key.layoutData.cells as Array<{ key: string; value: string }>;
    assert.deepEqual(cells.map((c) => [c.key, c.value]), [["revenue", "$30M–$35M"], ["earnings", "$3M–$4M"], ["askingPrice", "{price}"], ["employees", "100–249"]]);
    assert.equal(row.draft.header!.label, "CONFIDENTIAL OPPORTUNITY");
    assert.equal(row.draft.header!.tagline, written.tagline);
    assert.deepEqual(row.draft.header!.chips, ["Transportation & Logistics", "British Columbia", "Established 30+ years"]);
    assert.equal((row.draft.blocks.find((b) => b.slot === "highlights")!.layoutData.items as unknown[]).length, 5);
    assert.equal(row.codenameUsed, "Project Coastline");
    assert.equal(row.draftRev, 1);
    assert.ok(row.history.length >= 1, "undoable");
  });

  await check("(f) the prompt: no identity term, no keep-out clause, no private note, no figure", () => {
    const p = prompts[prompts.length - 1];
    const all = `${p.system}\n${p.user}`;
    for (const t of ["Pacific Coast", "Surrey", "Harjit", "Sandhu", "Manpreet", "Alderbrook", "RFP", "2847193", "harjit@"]) assert.ok(!all.includes(t), `${t} reached the prompt`);
    const user = p.user.replace(/"allowedPhrases": \[[^\]]*\]/, "");
    assert.ok(!/\$\s?\d|\d+%|\b(?:19|20)\d{2}\b/.test(user), `a figure reached the prompt: ${user}`);
    assert.ok(user.includes("[number]") || user.includes("[amount]"), "figures replaced by stand-ins");
  });

  await check("(l) with a Blind CIM: served blind sections only; a held section and financial tables left out", () => {
    const user = prompts[prompts.length - 1].user;
    assert.ok(user.includes("regional refrigerated carrier"), "the blind executive summary");
    assert.ok(user.includes("second terminal"), "the blind growth section");
    assert.ok(!user.includes("Customer A is a large share"), "the held (stale) blind section is not served, so not read");
    assert.ok(!user.includes("Financial performance"), "financial tables skipped");
    const narrative = JSON.parse(user.split("\n\n")[0]).narrative as Array<{ text: string }>;
    assert.ok(narrative.reduce((n, x) => n + x.text.length, 0) <= 9000);
  });

  await check("(b) a highlight naming a customer is dropped, with a warning; (e) a figure fails the field", async () => {
    const out = JSON.parse(JSON.stringify(written));
    out.highlights[0] = { title: "Anchor customer", detail: "Alderbrook Foods ships every week." };
    out.highlights[1] = { title: "Big fleet", detail: "Over 112 trucks on the road." };
    replies = [out];
    const row = await run(pac.id);
    const items = row.draft.blocks.find((b) => b.slot === "highlights")!.layoutData.items as Array<{ title: string }>;
    assert.equal(items.length, 3);
    assert.ok(!textOf(row).includes("Alderbrook") && !textOf(row).includes("112"));
    assert.equal(row.generation!.warnings.filter((w) => /One highlight was left out/.test(w)).length, 2);
  });

  await check("(c) the overview naming the town → one retry → clean → used", async () => {
    const bad = { ...written, overview: "Project Coastline runs its terminal in Surrey for food distributors." };
    const retry = { ...written, overview: "Project Coastline runs a modern terminal in British Columbia for food distributors." };
    replies = [bad, retry];
    const n = prompts.length;
    const row = await run(pac.id);
    assert.equal(prompts.length, n + 2, "one retry");
    assert.match(prompts[prompts.length - 1].user, /Rewrite only these fields: overview/);
    assert.match(prompts[prompts.length - 1].user, /Don't mention: the town/);
    assert.ok(!prompts[prompts.length - 1].user.includes("Surrey"), "the retry never echoes the term");
    const over = row.draft.blocks.find((b) => b.slot === "overview")!;
    assert.equal(over.body, retry.overview);
    assert.equal(over.hidden, false);
  });

  await check("(d) the retry leaks again → the overview becomes a hidden placeholder the broker writes", async () => {
    const bad = { ...written, overview: "A carrier owned by Harjit Sandhu." };
    replies = [bad, bad];
    const row = await run(pac.id);
    const over = row.draft.blocks.find((b) => b.slot === "overview")!;
    assert.equal(over.placeholder, true);
    assert.equal(over.hidden, true);
    assert.ok(!textOf(row).includes("Harjit"));
    assert.ok(row.generation!.warnings.some((w) => /business overview couldn't be written/.test(w)));
  });

  await check("(m) pinpointing in the overview → one retry → still there → kept, with a warning", async () => {
    const pin = { ...written, overview: "Project Coastline is the only cross-border reefer carrier in its valley." };
    replies = [pin, pin];
    const row = await run(pac.id);
    assert.equal(row.draft.blocks.find((b) => b.slot === "overview")!.body, pin.overview);
    assert.ok(row.generation!.warnings.some((w) => /may describe the business too precisely/.test(w)));
  });

  await check("(g) the model throws → a template draft and the plain sentence", async () => {
    replies = [Object.assign(new Error("invalid x-api-key"), { status: 401 })];
    const row = await run(pac.id);
    assert.equal(row.generation!.status, "done");
    assert.equal(row.generation!.basis, "template");
    assert.match(row.generation!.error!, /AI isn't available right now/);
    const over = row.draft.blocks.find((b) => b.slot === "overview")!;
    assert.equal(over.placeholder, true);
    assert.equal(row.draft.blocks.find((b) => b.slot === "key_numbers")!.hidden, false, "fixed blocks still filled");
  });

  await check("(j) the confidentiality review fails → no teaser model call, a template draft, reviewFailed", async () => {
    keepOut._setKeepOutModelForTests({ messages: { create: (async () => { keepOutCalls++; throw Object.assign(new Error("overloaded"), { status: 529 }); }) as never } } as never);
    const n = prompts.length;
    const row = await run(pac.id);
    assert.equal(prompts.length, n, "the teaser model was never called");
    assert.equal(row.generation!.reviewFailed, true);
    assert.match(row.generation!.error!, /confidentiality check couldn't run/);
    assert.equal(row.reviewConfirmed, null);
    keepOut._setKeepOutModelForTests({ messages: { create: (async () => { keepOutCalls++; return fixture("keep-out-nothing-held.json"); }) as never } } as never);
    void keepOutFails;
  });

  await check("(i) one run per deal", async () => {
    replies = [written];
    const d = deals.get(pac.id)! as never;
    const a = await gen.startTeaserGeneration(d, { templateKey: "one_page" });
    const b = await gen.startTeaserGeneration(d, { templateKey: "one_page" });
    assert.deepEqual(a, { started: true });
    assert.deepEqual(b, { busy: true });
    await gen.waitForTeaser(pac.id);
  });

  await check("template start (no AI): fixed blocks filled, AI slots placeholders, no review call, no model call", async () => {
    const k = keepOutCalls;
    const n = prompts.length;
    const row = await run(pac.id, "two_page", "template");
    assert.equal(keepOutCalls, k);
    assert.equal(prompts.length, n);
    assert.equal(row.generation!.basis, "template");
    assert.ok(row.draft.blocks.filter((b) => b.placeholder).every((b) => b.hidden));
    assert.equal(row.draft.blocks.find((b) => b.slot === "operations")!.hidden, false);
  });

  // ── A deal with no Blind CIM: the facts go through the redaction engine ──
  const harb = {
    id: "D-HARB", brokerId: "B1", businessName: "Harbourline Dental Group", industry: "Dental practice", blindCodename: "Project Lighthouse", isLive: false, cimGeneration: null,
    extractedInfo: {
      companyName: "Harbourline Dental Group", locationSite: "Kitchener, Ontario", ownerName: "Dr. Priya Raman",
      annualRevenue: "$2,040,000", sde: "$628,000", employees: "14", yearsOperating: "19 years",
      businessDescription: "Harbourline Dental Group is a general and cosmetic practice in Kitchener with a loyal patient base.",
      customerBase: "Families and seniors, including residents of Maplecrest Senior Living down the street.",
      growthOpportunities: "Add orthodontic services; extend evening hours.",
      reasonForSale: "Dr. Raman is retiring.",
      transitionPlan: "Dr. Raman offers a 6-month handover.",
    },
  };
  deals.set(harb.id, harb);

  await check("(k) no Blind CIM: the redaction engine runs first; an unknown customer never reaches the prompt", async () => {
    const redactionIn: string[] = [];
    redactionReply = async () => ({ text: JSON.stringify(fixture("harbourline-redaction.json")), stopReason: "end_turn" });
    redaction.setRedactionModelForTests(async (prompt) => {
      redactionIn.push(prompt);
      return redactionReply!();
    });
    replies = [{ ...written, tagline: "An established dental practice", overview: "Project Lighthouse is a general and cosmetic dental practice in Ontario with a loyal patient base.", highlights: [{ title: "Loyal patients", detail: "Families return year after year." }], growth: [], whoItSuits: ["A dentist ready to own a practice"], managementNote: null }];
    const row = await run(harb.id);
    assert.equal(row.generation!.basis, "redacted_facts");
    assert.equal(redactionIn.length, 1);
    assert.ok(redactionIn[0].includes("Maplecrest"), "the redaction engine (not the teaser model) sees the raw facts");
    const user = prompts[prompts.length - 1].user;
    assert.ok(!user.includes("Maplecrest") && !user.includes("Kitchener") && !user.includes("Raman") && !user.includes("Harbourline"), user);
    assert.ok(user.includes("Customer A"));
  });

  await check("(k) a redaction that throws → a template draft with the redaction sentence, no teaser model call", async () => {
    redaction.setRedactionModelForTests(async () => ({ text: "not json", stopReason: "end_turn" }));
    const n = prompts.length;
    const row = await run(harb.id);
    assert.equal(prompts.length, n);
    assert.equal(row.generation!.basis, "template");
    assert.match(row.generation!.error!, /couldn't make an anonymous version/);
  });

  await check("(h) the gate: no revenue or earnings, no region → the plain copy", async () => {
    const { figuresFrom } = await import("../../server/teaser/key-numbers");
    const f = figuresFrom({ deal: { industry: "Retail" }, info: {}, canon: null, askingPrice: null });
    const g = await gen.teaserGate({ id: "D-NONE" } as never, f, "ranges");
    assert.equal(g.ok, false);
    assert.deepEqual(g.reasons, ["Add the industry and the province or state on the Information tab first.", "Add the revenue or earnings on the Information tab first."]);
  });

  await check("(n) the discrepancy gate in the teaser's number style", () => {
    const row = (iv: string, dv: string, factKey = "annualRevenue") => ({ field: "Revenue", factKey, status: "open", interviewValue: iv, documentValue: dv });
    let g = gen.discrepancyGateFor([row("$18.2M", "$19.1M")], "ranges");
    assert.deepEqual(g.reasons, []);
    assert.match(g.notes[0], /same range \(\$17\.5M–\$20M\)/);
    g = gen.discrepancyGateFor([row("$17.4M", "$17.6M")], "ranges");
    assert.equal(g.reasons.length, 1);
    assert.match(g.reasons[0], /Revenue has an open question that changes what the teaser shows/);
    g = gen.discrepancyGateFor([row("$18.2M", "$18.24M")], "rounded");
    assert.deepEqual(g.reasons, []);
    g = gen.discrepancyGateFor([row("$18.2M", "$18.3M")], "rounded");
    assert.equal(g.reasons.length, 1);
    g = gen.discrepancyGateFor([row("about 140 people", "148", "employees")], "ranges");
    assert.deepEqual(g.reasons, [], "both 100–249");
    g = gen.discrepancyGateFor([{ ...row("$1", "$2"), status: "resolved" }], "ranges");
    assert.deepEqual(g.reasons, [], "only open / seller-responded rows block");
    g = gen.discrepancyGateFor([row("$5M", "$9M", "inventoryValue")], "ranges");
    assert.deepEqual(g.reasons, [], "facts the teaser doesn't print never block");
  });

  console.log(`\n${passed} checks passed`);
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
