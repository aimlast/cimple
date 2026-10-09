/**
 * Teaser client logic with no DOM: pagination and the fit sentence, what the
 * editor draws (filled tokens, hidden blocks left out, stand-ins), the
 * buyer-facing request banners, the Have the teaser lines and filters, the
 * level-move questions, the CIM tab's grouped notes, the publish button's
 * reasons, and the template-picker samples (teaser-safe layouts only).
 *
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/teaser-client.test.ts
 */
import assert from "node:assert/strict";
import "./react-global";
import { TEASER_PAGE_SIZES, validateTeaserLayout, isTeaserLayout, type TeaserBlock, type TeaserDoc } from "../../shared/teaser";
import { TEASER_TEMPLATES } from "../../shared/teaser-templates";
import { pageBox, paginateTeaser, printedPageCount, fitSentence, linesFor } from "../../client/src/components/teaser/paginate";
import { blockName, checkSummary, draftSections, heldSentence, pinpointSentence, CHECK_LINE, FALLBACK_FILL } from "../../client/src/components/teaser/draft-view";
import { requestBanner } from "../../client/src/components/buyer/TeaserView";
import { matchesTeaserFilter, teaserNextLine, teaserReadLine, grantNoun } from "../../client/src/components/deal/buyers/HaveTeaserStage";
import { moveQuestion } from "../../client/src/components/cim-builder/AccessLevelSelect";
import { attentionNoteGroups, groupSummary } from "../../client/src/components/cim-builder/CimReviewPanel";
import { classifyGenerationWarnings } from "../../shared/cim-generation-warnings";
import { publishButtonState } from "../../client/src/components/teaser/TeaserPublishDialog";
import { sampleTeaser } from "../../client/src/components/teaser/samples";
import { printFooterText, sectionsForPaper } from "../../client/src/pages/TeaserPrintPreview";
import { chipsBesideTagline, fillTeaserTokens, teaserFill } from "../../shared/teaser-view";
import { tileLinesFor, CIM_TAB_VIEWS, EXTRA_CIM_TAB_VIEWS, useViewBadge } from "../../client/src/pages/broker/deal/cim-tab-slots";
import { blindTileDesc } from "../../client/src/pages/broker/deal/CimTab";
import { sellerTeaserBarLine } from "../../client/src/pages/seller/SellerReview";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}`); throw e; }
}

const block = (over: Partial<TeaserBlock>): TeaserBlock => ({
  id: over.id ?? "b1", slot: "custom", title: "", layoutType: "prose_highlight", layoutData: {}, body: null, hidden: false,
  origin: "broker", facts: [], updatedAt: "2026-10-09T00:00:00Z", ...over,
});

console.log("pages");

test("page boxes: Letter 816×1056 and A4 794×1123 with 48 px margins", () => {
  assert.deepEqual(pageBox("letter"), { width: 816, height: 1056, contentWidth: 720, contentHeight: 960 });
  assert.deepEqual(pageBox("a4"), { width: 794, height: 1123, contentWidth: 698, contentHeight: 1027 });
  assert.equal(TEASER_PAGE_SIZES.letter.width, 816);
});

test("greedy: blocks never split; the next page starts when one doesn't fit", () => {
  const p = paginateTeaser([200, 300, 300, 200], 960, 20);
  // 200 + 20+300 + 20+300 = 840; +20+200 = 1060 > 960 → page 2
  assert.deepEqual(p.pages, [[0, 1, 2], [3]]);
  assert.deepEqual(p.used, [840, 200]);
  assert.equal(printedPageCount(p, 960), 2);
});

test("a block taller than a page gets its own page and spills over (counted)", () => {
  const p = paginateTeaser([100, 1500, 100], 960, 20);
  assert.deepEqual(p.pages, [[0], [1], [2]]);
  assert.equal(printedPageCount(p, 960), 4);
});

test("nothing to draw is still one (empty) page", () => {
  assert.deepEqual(paginateTeaser([], 960, 20), { pages: [[]], used: [0] });
});

test("the fit sentence never blocks and says how far over", () => {
  assert.deepEqual(fitSentence({ pages: 1, targetPages: 1, lastPageUsed: 400 }), { text: "Fits on 1 page", over: false });
  assert.deepEqual(fitSentence({ pages: 2, targetPages: 2, lastPageUsed: 400 }), { text: "Fits on 2 pages", over: false });
  assert.equal(fitSentence({ pages: 2, targetPages: 1, lastPageUsed: 132 }).text, "Runs onto page 2 by about 6 lines — shorten a block or keep it longer, it's up to you");
  assert.equal(fitSentence({ pages: 3, targetPages: 2, lastPageUsed: 22 }).text, "Runs onto page 3 by about 1 line — shorten a block or keep it longer, it's up to you");
  assert.deepEqual(fitSentence({ pages: 3, targetPages: 1, lastPageUsed: 500 }), { text: "3 pages", over: true });
  assert.equal(linesFor(0), 1);
});

console.log("the editor's pages");

test("tokens filled like the buyer's; hidden blocks left out; stand-ins drawn", () => {
  const doc: TeaserDoc = {
    header: { label: "CONFIDENTIAL OPPORTUNITY", tagline: "A regional carrier", chips: [] },
    blocks: [
      block({ id: "k", slot: "key_numbers", origin: "fixed", layoutType: "metric_grid", layoutData: { cells: [{ key: "revenue", label: "Revenue", value: "$9M–$10M" }, { key: "askingPrice", label: "Asking price", value: "{price}" }] } }),
      block({ id: "h", title: "Hidden one", hidden: true, body: "x", layoutData: { body: "x" } }),
      block({ id: "p", title: "Highlights", layoutType: "callout_list", placeholder: true, hidden: true }),
      block({ id: "n", slot: "next_step", origin: "fixed", layoutType: "numbered_list", title: "Interested?", layoutData: { items: [{ title: "{firm} reviews your request" }, { title: "Questions? {contact}" }] } }),
    ],
  };
  const out = draftSections(doc, "d1", { price: "$8.5M", contact: "Morgan · m@x.invalid", firm: "Brassline" });
  assert.deepEqual(out.map((s) => s.id), ["k", "p", "n"]);
  const metrics = (out[0].layoutData as { metrics: Array<{ label: string; value: string }> }).metrics;
  assert.deepEqual(metrics.map((m) => m.value), ["$9M–$10M", "$8.5M"]);
  assert.equal(out[1].layoutType, "prose_highlight");
  assert.match(String((out[1].layoutData as { body: string }).body), /didn't write this block/);
  const items = (out[2].layoutData as { items: Array<{ title: string }> }).items;
  assert.equal(items[0].title, "Brassline reviews your request");
  assert.equal(items[1].title, "Questions? Morgan · m@x.invalid");
  // No fill (the server couldn't work it out): never a raw token.
  const fallback = draftSections(doc, "d1", null);
  assert.ok(!JSON.stringify(fallback).includes("{price}"));
  assert.ok(!JSON.stringify(fallback).includes("{firm}"));
  assert.equal(FALLBACK_FILL.price, "Price on request");
});

test("a line that starts with {firm} starts with a capital, even with no firm name on file", () => {
  const b = block({ id: "n", slot: "next_step", origin: "fixed", layoutType: "numbered_list", layoutData: { items: [{ title: "{firm} reviews your request" }, { title: "Ask {firm} for the CIM" }] } });
  const fill = teaserFill({ askingPrice: null, showAskingPrice: true, numbers: "ranges", contact: { firm: null, name: null, email: null, phone: null } }, []);
  assert.equal(fill.firm, "the broker");
  const items = (fillTeaserTokens(b, fill).layoutData as { items: Array<{ title: string }> }).items;
  assert.equal(items[0].title, "The broker reviews your request");
  assert.equal(items[1].title, "Ask the broker for the CIM");
});

test("block names: the title, else the slot's name", () => {
  assert.equal(blockName(block({ title: "Room to grow" })), "Room to grow");
  assert.equal(blockName(block({ slot: "key_numbers", layoutType: "metric_grid" })), "Key numbers");
  assert.equal(blockName(block({ slot: "confidentiality" })), "Confidentiality line");
});

test("the check wording: held / pinpoint / the check line", () => {
  assert.equal(heldSentence({ blockId: "b", held: true, reason: "it names “Surrey” (the town)", leaks: ["Surrey"], pinpoint: [], layoutProblem: null, sample: false }),
    "Buyers won't see this block: it names “Surrey” (the town). Reword it and save.");
  assert.equal(heldSentence({ blockId: "b", held: false, reason: null, leaks: [], pinpoint: ["the only"], layoutProblem: null, sample: false }), null);
  assert.equal(pinpointSentence("the only"), "“the only” may let someone recognise the business. Buyers will see it — reword it if it's too specific.");
  assert.equal(CHECK_LINE, "No names, places or contacts found");
  assert.ok(!/anonymous ✓/i.test(CHECK_LINE));
});

test("the Teaser tab's summary: the green tick only when nothing is held and the header is clean (never above a red line)", () => {
  const doc: TeaserDoc = { header: { label: "CONFIDENTIAL OPPORTUNITY", tagline: "HVAC", chips: [] }, blocks: [block({ id: "ov", slot: "overview", title: "The business" }), block({ id: "hl", slot: "highlights", title: "Highlights" })] };
  const ok = { blockId: "ov", held: false, reason: null, leaks: [], pinpoint: [], layoutProblem: null, sample: false };
  const clean = checkSummary(doc, [ok, { ...ok, blockId: "hl" }], null);
  assert.deepEqual([clean.clean, clean.header, clean.held], [true, null, null]);
  // The checker's case: a block naming the business — no tick, the red line leads and says why.
  const named = checkSummary(doc, [{ ...ok, held: true, reason: "it names “Lakeshore Home Comfort” (the business's name)", leaks: ["Lakeshore Home Comfort"] }, { ...ok, blockId: "hl" }], null);
  assert.equal(named.clean, false);
  assert.equal(named.held!.sentence, "1 block names something that could identify the business, so buyers won't see it: The business. Open it in the editor to reword.");
  // Sample text / a layout problem: held back, worded as such.
  const sample = checkSummary(doc, [ok, { ...ok, blockId: "hl", sample: true }], null);
  assert.equal(sample.clean, false);
  assert.match(sample.held!.sentence, /^1 block is held back from buyers: Highlights/);
  // The header naming the business: no tick either.
  const header = checkSummary(doc, [ok, { ...ok, blockId: "hl" }], "The header names “Lakeshore”.");
  assert.equal(header.clean, false);
  assert.match(header.header!, /buyers see a plain header instead/);
  // A hidden block the broker took off isn't counted.
  const hidden = checkSummary({ ...doc, blocks: [doc.blocks[0], { ...doc.blocks[1], hidden: true }] }, [ok, { ...ok, blockId: "hl", held: true, reason: "x" }], null);
  assert.equal(hidden.clean, true);
  // Checker r2 (R2-1): a codename problem stops publishing — no tick above it; the codename line leads and says where to fix it.
  const problem = "It shares “Coast” with “Pacific Coast Logistics Ltd.”.";
  const underReview = checkSummary(doc, [ok, { ...ok, blockId: "hl" }], null, { problem, served: "Project Coastline", dealCodename: "Project Shoreline" });
  assert.equal(underReview.clean, false, "no green tick above the codename problem");
  assert.equal(underReview.codename!.fixAt, "overview");
  assert.equal(underReview.codename!.text, `Blind buyers still read the published CIM under “Project Coastline”, which could point to the business: ${problem} Publish the CIM update on the Overview so they get “Project Shoreline”, then publish the teaser.`);
  const own = checkSummary(doc, [ok, { ...ok, blockId: "hl" }], null, { problem, served: "Project Coastline", dealCodename: "Project Coastline" });
  assert.equal(own.clean, false);
  assert.equal(own.codename!.fixAt, "versions");
  assert.match(own.codename!.text, /^The codename could point buyers to the business: .* Change it on the Versions tab \(Blind CIM card\) before publishing\.$/);
  const fine = checkSummary(doc, [ok, { ...ok, blockId: "hl" }], null, { problem: null, served: "Project Drift", dealCodename: "Project Drift" });
  assert.deepEqual([fine.clean, fine.codename], [true, null]);
  // Every combination: the tick and a problem line are never both shown.
  for (const cp of [null, problem]) for (const hp of [null, "x"]) for (const held of [false, true]) {
    const r = checkSummary(doc, [{ ...ok, held, reason: held ? "it names “X”" : null }, { ...ok, blockId: "hl" }], hp, { problem: cp, served: "Project A", dealCodename: "Project A" });
    assert.equal(r.clean, !r.codename && !r.header && !r.held, `tick xor problems (${cp}/${hp}/${held})`);
  }
});

test("on paper the 'ask from this page' step names the firm and its contact; the Questions line goes", () => {
  const sec = { id: "n", dealId: "D", sectionKey: "s_n", sectionTitle: "Interested?", order: 0, layoutType: "numbered_list", aiDraftContent: null, brokerEditedContent: null, isVisible: true,
    layoutData: { ordered: true, items: [{ title: "Ask for the CIM from this page" }, { title: "Confirm your email, tell us about you and sign the NDA online" }, { title: "Brassline reviews your request and opens the CIM for you" }], note: "Questions? Morgan Ellis · morgan@brassline.invalid" } } as never;
  const [p] = sectionsForPaper([sec], { firm: "Brassline Advisory Partners", name: "Morgan Ellis", email: "morgan@brassline.invalid", phone: null });
  const d = p.layoutData as { items: Array<{ title: string }>; note?: string };
  assert.equal(d.items[0].title, "Ask Brassline Advisory Partners for the CIM: Morgan Ellis · morgan@brassline.invalid");
  assert.equal(d.items.length, 3);
  assert.equal(d.note, undefined, "the contact is in the step now");
  // No contact on file: the firm only, and the Questions line stays as it was.
  const [q] = sectionsForPaper([sec], { firm: "Brassline Advisory Partners", name: null, email: null, phone: null });
  assert.equal((q.layoutData as { items: Array<{ title: string }> }).items[0].title, "Ask Brassline Advisory Partners for the CIM");
  assert.equal((q.layoutData as { note?: string }).note, "Questions? Morgan Ellis · morgan@brassline.invalid");
  // No firm name: ask the broker by name.
  const [r] = sectionsForPaper([sec], { firm: null, name: "Morgan Ellis", email: "morgan@brassline.invalid", phone: null });
  assert.equal((r.layoutData as { items: Array<{ title: string }> }).items[0].title, "Ask Morgan Ellis for the CIM: morgan@brassline.invalid");
  const [n] = sectionsForPaper([sec], { firm: null, name: "Morgan Ellis", email: null, phone: null });
  assert.equal((n.layoutData as { items: Array<{ title: string }> }).items[0].title, "Ask Morgan Ellis for the CIM");
  // Other lists are untouched.
  const other = { ...(sec as object), layoutData: { items: [{ title: "Add a second terminal" }] } } as never;
  assert.equal(sectionsForPaper([other], { firm: "X", name: null, email: null, phone: null })[0], other);
});

test("the header: a chip that only repeats the one-line description is dropped", () => {
  assert.deepEqual(chipsBesideTagline(["Home Services", "Ontario", "Established 20+ years"], "Home Services"), ["Ontario", "Established 20+ years"]);
  assert.deepEqual(chipsBesideTagline(["Home Services", "Ontario"], "A trusted HVAC contractor"), ["Home Services", "Ontario"]);
  assert.deepEqual(chipsBesideTagline(["Home Services"], ""), ["Home Services"]);
});

test("the Blind CIM tile names the codename blind buyers read (the kept copy's while an update is under review)", () => {
  assert.equal(blindTileDesc("Project Shoreline", "Project Coastline"), "Under “Project Coastline” until you publish the update");
  assert.equal(blindTileDesc("Project Shoreline", null), "Under “Project Shoreline”");
  assert.equal(blindTileDesc("Project Shoreline", "Project Shoreline"), "Under “Project Shoreline”");
  assert.equal(blindTileDesc(null, null), "Under a project codename");
});

test("CIM tab slots: CIM_TAB_VIEWS (INTEGRATION §2.8) is the same registry; badge as a number or a hook", () => {
  assert.equal(CIM_TAB_VIEWS, EXTRA_CIM_TAB_VIEWS);
  const C = () => null;
  assert.equal(useViewBadge({ key: "numbers", label: "Numbers & sources", badge: 3, Component: C }, "D"), 3);
  assert.equal(useViewBadge({ key: "numbers", label: "Numbers & sources", badge: (id) => (id === "D" ? 2 : 0), Component: C }, "D"), 2);
  assert.equal(useViewBadge({ key: "numbers", label: "Numbers & sources", useBadge: () => 5, badge: 1, Component: C }, "D"), 5);
  assert.equal(useViewBadge({ key: "numbers", label: "Numbers & sources", Component: C }, "D"), null);
});

test("the seller's teaser bar: never 'nothing goes to buyers' once a version is published", () => {
  assert.equal(sellerTeaserBarLine(true), "Buyers can already read this summary — tell your broker if anything should change.");
  assert.equal(sellerTeaserBarLine(false), "Nothing goes to buyers until your broker publishes it.");
});

console.log("buyers");

test("request banners (buyers see 'summary', the firm by name)", () => {
  assert.equal(requestBanner({ state: "none", at: null }, "Brassline"), null);
  assert.match(requestBanner({ state: "requested", at: "2026-10-09T12:00:00Z" }, "Brassline")!.text, /^You asked for the CIM on Oct 9\. Brassline will review your request and email you\. The CIM will open on this same page\.$/);
  assert.equal(requestBanner({ state: "approved_waiting", at: null }, "B")!.text, "Your request was approved. The CIM opens here as soon as it's ready.");
  assert.equal(requestBanner({ state: "declined", at: null }, "Brassline")!.text, "Brassline isn't sharing more on this opportunity right now. Thank you for your interest.");
  assert.match(requestBanner({ state: "requested", at: "2026-10-09T12:00:00Z" }, "the broker")!.text, /Oct 9\. The broker will review/);
});

const eb = (over: Record<string, unknown> = {}) => ({
  accessId: "a1", name: "Natalie V", company: "Cascade", email: "n@x.invalid", sentAt: "2026-10-07T00:00:00Z", via: "email" as const,
  firstOpenedAt: null as string | null, lastOpenedAt: null, activeMs: 0, furthestBlock: null as string | null, readToEnd: false,
  request: { state: "none" as const, at: null as string | null, level: null as string | null, grantedBy: null as string | null, requestId: null },
  passed: null as null | { at: string; reasons: string[]; note: string | null }, freshLinkRequestedAt: null as string | null,
  worthACall: false, active: true, expired: false, ...over,
});

test("the Read line", () => {
  assert.equal(teaserReadLine(eb()), "Not opened yet");
  assert.equal(teaserReadLine(eb({ firstOpenedAt: "2026-10-08T00:00:00Z", activeMs: 120_000, readToEnd: true })), "Opened · 2 min · read to the end");
  assert.equal(teaserReadLine(eb({ firstOpenedAt: "2026-10-08T00:00:00Z", activeMs: 40_000, furthestBlock: "Investment highlights" })), "Opened · 40 s · stopped at Investment highlights");
});

test("the Next line", () => {
  assert.deepEqual(teaserNextLine(eb()), { text: "—", action: null });
  assert.deepEqual(teaserNextLine(eb({ request: { state: "requested", at: "2026-10-09T10:00:00Z", level: null, grantedBy: null, requestId: "r" } })), { text: "Asked Oct 9 · waiting for you", action: "review" });
  assert.equal(teaserNextLine(eb({ request: { state: "granted", at: "2026-10-10T10:00:00Z", level: "blind", grantedBy: "auto", requestId: "r" } })).text, "Given the Blind CIM Oct 10 automatically");
  assert.equal(teaserNextLine(eb({ request: { state: "granted", at: "2026-10-10T10:00:00Z", level: "loi", grantedBy: "broker", requestId: "r" } })).text, "Given the Full CIM Oct 10");
  assert.equal(teaserNextLine(eb({ request: { state: "declined", at: "2026-10-10T10:00:00Z", level: null, grantedBy: null, requestId: "r" } })).text, "Declined Oct 10");
  assert.equal(teaserNextLine(eb({ passed: { at: "x", reasons: ["size", "price"], note: null } })).text, "Not for them · size, price");
  assert.deepEqual(teaserNextLine(eb({ freshLinkRequestedAt: "2026-10-09T10:00:00Z", expired: true })), { text: "Asked for a fresh link Oct 9", action: "fresh" });
  assert.equal(grantNoun("due_diligence"), "due-diligence access");
});

test("filters", () => {
  const rows = [eb({ worthACall: true, firstOpenedAt: "x" }), eb({ request: { state: "requested", at: "x", level: null, grantedBy: null, requestId: "r" } }), eb({ passed: { at: "x", reasons: [], note: null }, firstOpenedAt: "x" }), eb()];
  assert.deepEqual(["all", "call", "asked", "passed", "unopened"].map((f) => rows.filter((r) => matchesTeaserFilter(r as never, f as never)).length), [4, 1, 1, 1, 2]);
});

test("moving a buyer down or back to the teaser asks first; moving up doesn't", () => {
  assert.equal(moveQuestion("blind", "named", "Gurdeep Sandhu"), null);
  assert.equal(moveQuestion("teaser_only", "blind", "Gurdeep"), null);
  assert.deepEqual(moveQuestion("loi", "blind", "Gurdeep Sandhu"), { title: "Move Gurdeep to the Blind CIM?", body: "They've already seen the business's name — this only changes what they see from now on." });
  assert.equal(moveQuestion("due_diligence", "named", "Gurdeep")!.title, "Move Gurdeep to the Full CIM?");
  assert.match(moveQuestion("blind", "teaser_only", "Gurdeep")!.title, /^Move Gurdeep back to the teaser\?$/);
  assert.match(moveQuestion("blind", "teaser_only", "Gurdeep")!.body, /lose the CIM/);
});

console.log("the CIM tab");

test("notes grouped by kind, placeholders without a note get their own row", () => {
  const w = classifyGenerationWarnings([
    'Check the figures in "Fleet": $4.1M not traced',
    'Check the figures in "Customers": 22% not traced',
    '"Working capital" is hidden from buyers until reviewed',
    'Taken out: a confidential RFP',
  ]);
  const groups = attentionNoteGroups(w, [{ id: "s9", sectionTitle: "History" }]);
  assert.deepEqual(groups.map((g) => [g.kind, g.items.length]), [["placeholder", 1], ["hidden", 1], ["figures", 2], ["removed", 1]]);
  assert.equal(groupSummary(groups[2].items), "2 sections: Fleet, Customers");
  assert.equal(groupSummary([{ sectionTitle: null }, { sectionTitle: null }]), "2 notes");
  assert.equal(groupSummary(["A", "B", "C", "D", "E"].map((t) => ({ sectionTitle: t }))), "5 sections: A, B, C and 2 more");
});

test("tile lines: at most two per tile, in registry order", () => {
  const dd = { due_diligence: [{ key: "dd1", text: "+ figure checks · 3 differences shown" }] };
  const vdr = { due_diligence: [{ key: "v1", text: "+ data room · 12 documents shared" }, { key: "v2", text: "extra" }], named: [{ key: "v3", text: "+ data room for 2 buyers you chose" }] };
  assert.deepEqual(tileLinesFor("due_diligence", [dd, vdr]).map((l) => l.key), ["dd1", "v1"]);
  assert.deepEqual(tileLinesFor("named", [dd, vdr]).map((l) => l.key), ["v3"]);
  assert.deepEqual(tileLinesFor("teaser_only", [dd, vdr]), []);
});

console.log("publishing and printing");

const state = (over: { blocks?: TeaserBlock[]; checks?: unknown[]; status?: string; changed?: number; hasPublished?: boolean; running?: boolean; headerProblem?: string | null }) => ({
  teaser: {
    draft: { header: null, blocks: over.blocks ?? [block({ id: "a", body: "Text", layoutData: { body: "Text" } })] },
    checks: over.checks ?? [],
    headerProblem: over.headerProblem ?? null,
    hasPublished: !!over.hasPublished,
    generation: over.running ? { status: "running" } : null,
  },
  summary: { status: over.status ?? "draft", changedSincePublish: over.changed ?? 0 },
}) as never;

test("the publish button says why it can't", () => {
  assert.deepEqual(publishButtonState(state({})), { label: "Publish teaser", disabled: false, why: null });
  assert.equal(publishButtonState(state({ checks: [{ blockId: "a", held: true, reason: "it names x", leaks: [], pinpoint: [], layoutProblem: null, sample: false }] })).why, "Fix the 1 block that names the business first.");
  assert.equal(publishButtonState(state({ running: true })).disabled, true);
  assert.equal(publishButtonState(state({ headerProblem: "The header names the business" })).why, "Fix the header first — it names the business.");
  assert.deepEqual(publishButtonState(state({ status: "published", hasPublished: true })), { label: "Publish changes", disabled: true, why: "Buyers already see this version." });
  assert.equal(publishButtonState(state({ status: "published", hasPublished: true, changed: 2 })).disabled, false);
  assert.equal(publishButtonState(state({ status: "offline", hasPublished: true })).label, "Publish again");
  assert.equal(publishButtonState(state({ blocks: [block({ id: "a", hidden: true })] })).why, "Add a block buyers can read first.");
});

test("the print footer is buyer-safe: firm · Confidential · date", () => {
  assert.equal(printFooterText("Brassline Advisory Partners", new Date("2026-10-09T12:00:00Z")), "Brassline Advisory Partners · Confidential · Oct 9, 2026");
  assert.equal(printFooterText(null, new Date("2026-10-09T12:00:00Z")), "Confidential · Oct 9, 2026");
});

test("template-picker samples use teaser-safe layouts only (and pass the teaser layout check)", () => {
  for (const def of Object.values(TEASER_TEMPLATES)) {
    const s = sampleTeaser(def);
    assert.equal(s.sections.length, def.slots.length);
    for (const sec of s.sections) {
      assert.ok(isTeaserLayout(sec.layoutType), `${def.key}/${sec.layoutType}`);
      assert.equal(validateTeaserLayout({ layoutType: sec.layoutType as never, layoutData: sec.layoutData as Record<string, unknown> }), null, `${def.key}/${sec.sectionTitle}`);
    }
  }
});

console.log(`\n${passed} passed`);
