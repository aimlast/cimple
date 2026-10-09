/**
 * The coverage board (shared/coverage-board.ts + server/interview/coverage-board.ts)
 * — offline, no database, no AI. specs/together.md §3, §11.1:
 *  - groups of alternatives are one item; members carry their own labels;
 *    plan, broker-added and noted items are their own items;
 *  - every status rule (1–9), the "confirmed" override and its lapse;
 *  - the anchored non-answer rule; who holds the answer;
 *  - the seller audience (statuses only) and the screen audience (values
 *    from the seller-safe view, money talk hidden);
 *  - percent, headline, version; the ask tables cover every group/member;
 *  - the stable list order, "what to ask next", the call sheet.
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/coverage-board.test.ts
 */
import assert from "node:assert/strict";
import {
  NOT_KNOWN_RE,
  isNotKnownValue,
  percentCollected,
  headline,
  reasonText,
  stableOrder,
  nextToAsk,
  rankOpenItems,
  callSheet,
  filterItems,
  filterCounts,
  viewCounts,
  boardVersion,
  filedEntryText,
  filedThisSitting,
  type CoverageBoard,
  type CoverageItem,
} from "../../shared/coverage-board";
import {
  boardFromCoverage,
  coverageInputsFrom,
  confirmedKeys,
  isWritableMember,
  valueHash,
  type CoverageMarkLike,
} from "../../server/interview/coverage-board";
import { GENERIC_ASKS, MEMBER_LABELS, SHARED_KEY_HOME } from "../../server/interview/coverage-asks";
import { SECTION_FIELD_GROUPS } from "../../server/interview/knowledge-base";
import { brokerFactsView } from "../../server/information/facts";
import { BROKER_CALL_SOURCE_NOTE, BROKER_SESSION_SOURCE_NOTE, isBrokerCallNote, isBrokerSessionSource } from "../../server/interview/info-merger";
import { whoHoldsTheAnswer } from "../../server/interview/fact-guards";

let n = 0;
const ok = (name: string) => { n++; console.log("✓", name); };

type Facts = Record<string, [unknown, Record<string, unknown> | string]>;
function factsOf(f: Facts): Record<string, unknown> {
  const info: Record<string, unknown> = {};
  const sources: Record<string, unknown> = {};
  for (const [k, [v, s]] of Object.entries(f)) {
    info[k] = v;
    sources[k] = typeof s === "string" ? { source: s } : s;
  }
  info._fieldSources = sources;
  return info;
}
function mkDeal(info: Record<string, unknown>, extra: Record<string, unknown> = {}): any {
  return { id: "d1", brokerId: "b1", businessName: "Test Heating Ltd", industry: "", subIndustry: null, interviewPlan: null, interviewOutline: null, sectionImportance: null, interviewEvidence: null, extractedInfo: info, ...extra };
}
function build(
  deal: any,
  opts: { documents?: any[]; sessions?: any[]; disc?: any[]; marks?: CoverageMarkLike[]; reqs?: any[]; figureItems?: any[] } = {},
  audience: "broker" | "screen" | "seller" = "broker",
): CoverageBoard {
  const inputs = coverageInputsFrom({
    deal,
    documents: opts.documents ?? [],
    sessions: opts.sessions ?? [],
    openDiscrepancies: opts.disc ?? [],
    resolvedDiscrepancies: [],
    marks: opts.marks ?? [],
    requirements: opts.reqs ?? [],
    figureItems: opts.figureItems ?? [],
    brokerFacts: (brokerFactsView(deal).extractedInfo as Record<string, unknown>) || {},
  });
  return boardFromCoverage(inputs, audience);
}
const item = (b: CoverageBoard, id: string): CoverageItem => {
  const it = b.sections.flatMap((s) => s.items).find((i) => i.id === id);
  assert.ok(it, `item ${id} on the board`);
  return it!;
};
const session = (conf: Record<string, string> = {}, ledger: unknown[] = []) => [{ id: "s1", status: "completed", lastActivityAt: new Date().toISOString(), extractedInfo: { _confidenceLevels: conf, _deferralLedger: ledger } }];
const mark = (itemId: string, kind: string, extra: Partial<CoverageMarkLike> = {}): CoverageMarkLike => ({ itemId, kind, createdAt: new Date(), ...extra });

// ── Groups, members, ids ────────────────────────────────────────────────
{
  const b = build(mkDeal(factsOf({ seasonality: ["Busy June to August", "interview"], peakPeriods: ["Summer", "interview"] })));
  const season = b.sections.find((s) => s.key === "seasonality")!;
  assert.equal(season.items.length, 1, "seasonality / peak / slow periods are ONE item");
  assert.equal(season.items[0].id, "seasonality:seasonality");
  assert.deepEqual(season.items[0].members.map((m) => m.key), ["seasonality", "peakPeriods", "slowPeriods"]);
  assert.equal(season.items[0].members[1].label, "busiest months", "members carry their own labels");
  assert.equal(season.items[0].status, "on_file");
  assert.equal(season.items[0].ask, "Which months are your busiest, and which are the quietest?");
  const overview = b.sections.find((s) => s.key === "overview")!;
  assert.equal(overview.items.filter((i) => i.members.some((m) => m.key === "missionStatement")).length, 1, "brand / mission / values are one item");
  const ids = b.sections.flatMap((s) => s.items.map((i) => i.id));
  assert.equal(new Set(ids).size, ids.length, "ids unique");
  // Revenue keys live in Financial Summary; Revenue sources shows a reference row.
  const rev = b.sections.find((s) => s.key === "revenue_sources")!;
  assert.ok(!rev.items.some((i) => i.members.some((m) => m.key === "annualRevenue")), "annualRevenue not counted under revenue sources");
  assert.equal(rev.references.length, 1);
  assert.equal(rev.references[0].homeSectionKey, "financials");
  assert.equal(rev.references[0].homeItemId, "financials:annualRevenue");
  const counted = new Map<string, string>();
  for (const s of b.sections) for (const i of s.items) for (const m of i.members) {
    assert.ok(!counted.has(m.key), `${m.key} counted once (${counted.get(m.key)} and ${i.id})`);
    counted.set(m.key, i.id);
  }
  ok("groups of alternatives are one item; members keep their own labels; shared keys counted once with a reference row");
}

// Plan, broker-added and noted items are their own items.
{
  const plan = { industry: "Home Services", subIndustry: null, computedAt: new Date().toISOString(), status: "ready", rulesVersion: 2, items: [{ key: "emrRating", label: "WSIB experience rating (EMR)", sectionKey: "employees", critical: true, askAs: "Do you know your current WSIB experience rating?", whyItMatters: "A high rating raises a buyer's insurance cost." }] };
  const outline = { updatedAt: new Date().toISOString(), customTopics: [], excludedSections: [], emphasis: [], history: [], addedItems: [{ sectionKey: "operations", key: "vanCount", label: "Number of service vans", origin: "broker" }, { sectionKey: "operations", key: "fuelCards", label: "Fuel card program", origin: "noted" }] };
  const b = build(mkDeal(factsOf({ vanCount: ["24 vans", "call"] }), { industry: "Home Services", interviewPlan: plan, interviewOutline: outline }));
  const emr = item(b, "employees:emrRating");
  assert.equal(emr.origin, "industry");
  assert.equal(emr.critical, true);
  assert.equal(emr.ask, "Do you know your current WSIB experience rating?", "the phrasing pass's ask");
  assert.equal(emr.status, "missing");
  assert.equal(item(b, "operations:vanCount").origin, "broker");
  assert.equal(item(b, "operations:vanCount").status, "on_file");
  assert.equal(item(b, "operations:fuelCards").origin, "noted");
  assert.equal(item(b, "operations:fuelCards").ask, "Do you have a fuel card program?");
  assert.equal(b.totals.criticalItems, 1);
  assert.equal(b.totals.criticalOpen, 1);
  ok("industry, broker-added and noted items are their own items (ask from the phrasing pass, else the template)");
}

// ── Status rules ────────────────────────────────────────────────────────
// 1. Evidence only → partial (in_source), never on file.
{
  const evidence = { version: 2, status: "ready", fingerprint: "x", computedAt: new Date().toISOString(), checked: [], entries: { "field:reasonForSale": { answer: "Retiring after 30 years", source: "Call with the owner, 3 Sep", sourceKind: "call", sourceId: "doc-call" } } };
  const docs = [{ id: "doc-call", name: "Call with the owner", visibility: "shared", sourceKind: "call" }];
  const b = build(mkDeal(factsOf({}), { interviewEvidence: evidence }), { documents: docs });
  const it = item(b, "reason_for_sale:reasonForSale");
  assert.equal(it.status, "partial");
  assert.equal(it.reason?.code, "in_source");
  assert.equal(b.totals.on_file, build(mkDeal(factsOf({}))).totals.on_file, "evidence adds nothing on file");
  ok("rule 1: a passage on file with no recorded fact is Partial (in_source), never On file");
}
// 1. A not_known mark with no value → partial, who has it.
{
  const b = build(mkDeal(factsOf({})), { marks: [mark("reason_for_sale:reasonForSale", "not_known", { note: "the accountant" })] });
  const it = item(b, "reason_for_sale:reasonForSale");
  assert.equal(it.status, "partial");
  assert.deepEqual(it.reason, { code: "not_known", whoHasIt: "the accountant" });
  ok("rule 1: a 'not known' mark makes a missing item Partial with who has it");
}
// 2. A recorded non-answer.
{
  const b = build(mkDeal(factsOf({ ownerInvolvement: ["Owner does not know current EMR rating — Denise would have it", "interview"] })));
  const it = item(b, "employees:ownerInvolvement");
  assert.equal(it.status, "partial");
  assert.deepEqual(it.reason, { code: "not_known", whoHasIt: "Denise" });
  assert.equal(reasonText(it.reason, "broker"), "Partial — not known yet — Denise has it.");
  ok("rule 2: \"Owner does not know … Denise would have it\" → Partial, Denise has it");
}
// 3. Open discrepancies: conflict and routed.
{
  const deal = mkDeal(factsOf({ customerConcentration: ["Top customer about 30%", "call"], revenueByYear: [{ "2024": "$4.8M" }, "document"] }));
  const disc = [
    { id: "x1", dealId: "d1", status: "open", source: "merge", factKey: "customerConcentration", factYear: null, field: "Customer concentration", interviewValue: "30%", documentValue: "18%", sideSources: { interview: { kind: "call" }, document: { kind: "document", documentId: "doc1" } }, documentName: "2024 statements" },
    { id: "x2", dealId: "d1", status: "ask_seller", source: "merge", factKey: "revenueByYear", factYear: "2024", field: "2024 Revenue", interviewValue: "$4.8M", documentValue: "$4.6M", sideSources: null },
  ];
  const docs = [{ id: "doc1", name: "2024 statements", visibility: "shared", sourceKind: "document" }];
  const b = build(deal, { disc, documents: docs });
  const cc = item(b, "revenue_sources:customerConcentration");
  assert.equal(cc.status, "verify");
  assert.equal(cc.reason?.code, "conflict");
  assert.equal(cc.conflictId, "x1");
  assert.match(reasonText(cc.reason, "broker"), /two sources disagree: 30% \(Call\) and 18% \(Document · 2024 statements\)/);
  const rev = item(b, "financials:revenueByYear");
  assert.equal(rev.status, "verify");
  assert.equal(rev.reason?.code, "routed");
  assert.equal(b.routed.length, 0, "a routed conflict an item shows isn't listed again");
  ok("rule 3: an open conflict → To verify (sides labelled); a routed one → To verify (routed)");
}
// 3. A routed conflict no item shows → Open questions.
{
  const disc = [{ id: "x3", dealId: "d1", status: "ask_seller", source: "financial_analysis", factKey: "adjustedEbitdaByYear", factYear: "2024", field: "2024 adjusted EBITDA", interviewValue: "1", documentValue: "2", sideSources: null }];
  const b = build(mkDeal(factsOf({})), { disc });
  assert.equal(b.routed.length, 1);
  assert.equal(b.routed[0].discrepancyId, "x3");
  ok("rule 3: a routed conflict no item shows is listed under Open questions");
}
// 4. Lead. 5. Broker notes. 6. Guards. 7. Marked. 8. Estimate. 9. On file / your note.
{
  const deal = mkDeal(factsOf({
    customerConcentration: ["Top 5 customers 40%", "crm"],
    leaseDetails: ["Lease to 2029", { source: "broker", note: BROKER_SESSION_SOURCE_NOTE }],
    reasonForSale: ["Retiring", { source: "broker", note: BROKER_CALL_SOURCE_NOTE }],
    annualRevenue: ["$4.8M", "interview"],
    seasonality: ["Busy in summer", "interview"],
    idealBuyer: ["A strategic buyer", "interview"],
    growthOpportunities: ["Expand into commercial", { source: "call", documentId: "doc-call", verify: "date" }],
    competitiveAdvantage: ["Same-day service", "interview"],
  }));
  const sessions = session({ annualRevenue: "approximate", seasonality: "approximate" }, [{ id: "verify_annualrevenue", topic: "verify annualRevenue", reason: "", whereInfoLives: "", status: "open", createdAtTurn: 3 }]);
  const docs = [{ id: "doc-call", name: "Call with the owner", visibility: "shared", sourceKind: "call" }];
  const b = build(deal, { sessions, documents: docs, marks: [mark("buyer_profile:idealBuyer", "verify_later")] });
  assert.deepEqual(item(b, "revenue_sources:customerConcentration").reason, { code: "lead", leadKind: "crm" });
  assert.equal(item(b, "real_estate:leaseDetails").reason?.code, "broker_notes");
  const rfs = item(b, "reason_for_sale:reasonForSale");
  assert.equal(rfs.status, "on_file", "your call note counts on file");
  assert.equal(rfs.yourNote, true);
  assert.deepEqual(item(b, "financials:annualRevenue").reason, { code: "guard", detail: "number" }, "ledger 'verify annualRevenue' → guard");
  assert.deepEqual(item(b, "growth_potential:growthOpportunities").reason, { code: "guard", detail: "date" }, "FieldSource.verify date → guard");
  assert.equal(item(b, "buyer_profile:idealBuyer").reason?.code, "marked");
  const season = item(b, "seasonality:seasonality");
  assert.equal(season.status, "on_file", "an estimate on an everyday item stays on file");
  assert.equal(season.estimate, true);
  assert.equal(item(b, "strengths:competitiveAdvantage").status, "on_file");
  ok("rules 4–9: lead, your AI-session notes, guard (ledger and source), marked → To verify; your call note and an everyday estimate → On file");
}
{
  const b = build(mkDeal(factsOf({ annualRevenue: ["about $4.8M", "interview"] })), { sessions: session({ annualRevenue: "approximate" }) });
  assert.deepEqual(item(b, "financials:annualRevenue").reason, { code: "estimate" });
  ok("rule 8: an approximate revenue (high stakes) → To verify (the seller's estimate)");
}

// ── The confirmed override ──────────────────────────────────────────────
{
  const facts = factsOf({
    customerConcentration: ["Top 5 customers 40%", "crm"],
    leaseDetails: ["Lease to 2029", { source: "broker", note: BROKER_SESSION_SOURCE_NOTE }],
    annualRevenue: ["$4.8M", "interview"],
    growthOpportunities: ["Expand into commercial", { source: "call", documentId: "doc-call", verify: "date" }],
    idealBuyer: ["A strategic buyer", "interview"],
    revenueByYear: [{ "2024": "$4.8M" }, "document"],
    reasonForSale: ["Owner doesn't know yet", "interview"],
    leaseExpiry: ["2029", "interview"],
  });
  const deal = mkDeal(facts);
  const confirmedOf = (id: string, key: string, value: string) => mark(id, "confirmed", { note: key, valueHash: valueHash(value) });
  const sessions = session({ annualRevenue: "approximate" });
  const docs = [{ id: "doc-call", name: "Call", visibility: "shared", sourceKind: "call" }];
  const disc = [{ id: "x2", dealId: "d1", status: "ask_seller", source: "merge", factKey: "revenueByYear", factYear: "2024", field: "2024 Revenue", interviewValue: "a", documentValue: "b", sideSources: null }];
  const marks = [
    confirmedOf("revenue_sources:customerConcentration", "customerConcentration", "Top 5 customers 40%"),
    confirmedOf("real_estate:leaseDetails", "leaseDetails", "Lease to 2029"),
    confirmedOf("financials:annualRevenue", "annualRevenue", "$4.8M"),
    confirmedOf("growth_potential:growthOpportunities", "growthOpportunities", "Expand into commercial"),
    confirmedOf("buyer_profile:idealBuyer", "idealBuyer", "A strategic buyer"),
    mark("buyer_profile:idealBuyer", "verify_later"),
    confirmedOf("financials:revenueByYear", "revenueByYear", "2024: $4.8M"),
    confirmedOf("reason_for_sale:reasonForSale", "reasonForSale", "Owner doesn't know yet"),
  ];
  const b = build(deal, { sessions, documents: docs, disc, marks });
  for (const id of ["revenue_sources:customerConcentration", "real_estate:leaseDetails", "financials:annualRevenue", "growth_potential:growthOpportunities", "buyer_profile:idealBuyer"]) {
    const it = item(b, id);
    assert.equal(it.status, "on_file", `${id} confirmed → on file`);
    assert.equal(it.confirmedByYou, true);
  }
  assert.equal(item(b, "financials:revenueByYear").status, "verify", "a routed conflict needs Resolve, never a confirm");
  assert.equal(item(b, "reason_for_sale:reasonForSale").status, "partial", "a non-answer needs an answer, never a confirm");
  // The value changes → the confirmation lapses.
  const changed = { ...facts, annualRevenue: "$5.1M" };
  const b2 = build(mkDeal(changed), { sessions, documents: docs, disc, marks });
  assert.equal(item(b2, "financials:annualRevenue").status, "verify", "a changed value lapses the confirmation");
  assert.deepEqual(confirmedKeys(marks, changed).sort(), ["customerConcentration", "growthOpportunities", "idealBuyer", "leaseDetails", "reasonForSale", "revenueByYear"].sort());
  ok("the 'confirmed' override flips estimate, guard, your notes, a lead and 'come back later' — never a conflict, a routed question or a non-answer — and lapses when the value changes");
}

// ── Non-answers ─────────────────────────────────────────────────────────
{
  for (const v of ["Owner does not know current EMR rating — Denise would have it", "TBD", "tbc.", "I'll check with Denise", "The seller isn't sure", "N/A", "We need to check with the bank"]) {
    assert.ok(isNotKnownValue(v), `non-answer: ${v}`);
  }
  for (const v of ["Unknown Brewing Co.", "Renewal option not yet confirmed by landlord", "Vehicle loans believed assignable; owner to confirm with lender", "Busy in summer"]) {
    assert.ok(!isNotKnownValue(v), `a fact with a caveat stays a fact: ${v}`);
  }
  assert.ok(NOT_KNOWN_RE.test("unknown"));
  assert.equal(whoHoldsTheAnswer("Owner does not know current EMR rating — Denise would have it"), "Denise");
  assert.equal(whoHoldsTheAnswer("Maria has the payroll report"), "Maria");
  ok("the anchored non-answer rule; who holds the answer (\"Denise would have it\")");
}

// ── Audiences ───────────────────────────────────────────────────────────
{
  const facts = factsOf({
    reasonForSale: ["Retiring", "interview"],
    addbacks: ["$395K of owner costs", { source: "crm", documentId: "crm1", brokerOnly: true }],
    idealBuyer: ["Dave K. - retention plan needed", { source: "crm", documentId: "crm1", brokerOnly: true }],
    seasonality: ["Busy in summer", "interview"],
    sde: ["$1.3M", "broker"],
  });
  const docs = [{ id: "crm1", name: "CRM note - valuation meeting", visibility: "broker_only", sourceKind: "crm" }];
  const disc = [{ id: "p1", dealId: "d1", status: "open", source: "merge", factKey: "seasonality", factYear: null, field: "Seasonality", interviewValue: "summer", documentValue: "winter", sideSources: { interview: { kind: "interview" }, document: { kind: "crm", documentId: "crm1" } } }];
  const marks = [mark("seasonality:seasonality", "note", { note: "Ask about the dip in March" }), mark("reason_for_sale:reasonForSale", "verify_later")];
  const deal = mkDeal(facts);
  const seller = build(deal, { documents: docs, disc, marks }, "seller");
  for (const it of seller.sections.flatMap((s) => s.items)) {
    assert.equal(it.value, null, "seller: no values");
    assert.equal(it.source, null, "seller: no sources");
    assert.equal(it.reason, null, "seller: no reasons");
    assert.ok(!it.marks.some((m) => m.note), "seller: no notes");
  }
  assert.equal(item(seller, "reason_for_sale:reasonForSale").status, "on_file", "seller ignores 'come back later'");
  assert.equal(item(seller, "seasonality:seasonality").status, "on_file", "seller ignores a private-side conflict");
  assert.equal(item(seller, "buyer_profile:idealBuyer").status, "missing", "a broker-only fact doesn't count for the seller");
  assert.deepEqual(seller.routed, []);
  assert.deepEqual(seller.documents, []);
  assert.equal(seller.quality.score, undefined);
  const json = JSON.stringify(seller);
  assert.ok(!json.includes("395K") && !json.includes("Dave K."), "seller payload holds no private text");

  const screen = build(deal, { documents: docs, disc, marks }, "screen");
  const ib = item(screen, "buyer_profile:idealBuyer");
  assert.equal(ib.privateValue, true, "screen: a broker-only value reads 'On file — private to you'");
  assert.equal(ib.value, null);
  const ab = item(screen, "financials:addbacks");
  assert.equal(ab.moneyTalk, true);
  assert.equal(ab.value, null);
  assert.equal(ab.reason, null);
  assert.equal(item(screen, "seasonality:seasonality").status, "verify", "screen: statuses from the broker view");
  assert.deepEqual(item(screen, "seasonality:seasonality").reason, { code: "conflict", privateSide: true });
  assert.ok(!item(screen, "seasonality:seasonality").marks.some((m) => m.kind === "note"), "screen: no note marks");
  const sjson = JSON.stringify(screen);
  for (const secret of ["395K", "Dave K.", "Ask about the dip", "winter", "CRM note"]) assert.ok(!sjson.includes(secret), `screen payload never holds "${secret}"`);
  ok("seller audience: statuses only; screen audience: broker statuses, seller-safe values, money talk hidden, no private text anywhere in the payload");
}

// ── Percent, headline, version ─────────────────────────────────────────
{
  assert.equal(percentCollected({ items: 0, on_file: 0 }), 0);
  assert.equal(percentCollected({ items: 63, on_file: 55 }), 87);
  assert.equal(percentCollected({ items: 3, on_file: 2 }), 67);
  const h = headline({ totals: { items: 63, on_file: 55, partial: 1, verify: 4, missing: 3, criticalItems: 22, criticalOpen: 3 }, percentCollected: 87, quality: { label: "Solid" } });
  assert.equal(h.long, "87% of the CIM's information collected");
  assert.equal(h.short, "87% collected");
  assert.equal(h.critical, "3 critical still open");
  assert.deepEqual(h.counts.map((c) => c.label), ["55 on file", "1 partial", "4 to verify", "3 missing"]);
  assert.equal(h.quality, "Quality: Solid");
  assert.equal(headline({ totals: { items: 1, on_file: 1, partial: 0, verify: 0, missing: 0, criticalItems: 0, criticalOpen: 0 }, percentCollected: 100, quality: { label: "Solid" } }).critical, "Every critical data point is on file");
  const deal = mkDeal(factsOf({ seasonality: ["Busy in summer", "interview"] }));
  const v1 = build(deal).version;
  assert.equal(build(deal).version, v1, "the same board has the same version");
  assert.notEqual(build(mkDeal(factsOf({ seasonality: ["Busy in winter", "interview"] }))).version, v1, "a changed value changes the version");
  assert.equal(boardVersion([]), boardVersion([]));
  ok("percent rounding and the zero case; headline copy; the version changes only with content");
}

// ── The ask tables ─────────────────────────────────────────────────────
{
  for (const [section, groups] of Object.entries(SECTION_FIELD_GROUPS)) {
    for (const g of groups) {
      assert.ok(GENERIC_ASKS[`${section}:${g.keys[0]}`], `a hand-written ask for ${section}:${g.keys[0]}`);
      for (const k of g.keys) assert.ok(MEMBER_LABELS[k], `a member label for ${k}`);
      for (const k of g.keys) {
        const elsewhere = Object.entries(SECTION_FIELD_GROUPS).filter(([s, gs]) => s !== section && gs.some((x) => x.keys.includes(k) || (x.aliases ?? []).includes(k)));
        if (elsewhere.length > 0) assert.ok(SHARED_KEY_HOME[k], `${k} sits in two sections' groups — it needs a home`);
      }
    }
  }
  for (const a of Object.values(GENERIC_ASKS)) {
    assert.ok(a.why.split(/\s+/).length <= 20, `why ≤ 20 words: ${a.why}`);
    assert.ok(a.answers.split(/\s+/).length <= 12, `answers ≤ 12 words: ${a.answers}`);
    assert.ok(!/\d{2,}/.test(a.ask), "no figures in an ask");
  }
  assert.equal(isWritableMember("sde"), false);
  assert.equal(isWritableMember("adjustedEbitda"), false);
  assert.equal(isWritableMember("addbacks"), true, "the seller's own list of personal costs is writable");
  assert.equal(isWritableMember("netIncome"), true);
  assert.ok(isBrokerSessionSource({ source: "broker", note: BROKER_CALL_SOURCE_NOTE }) && isBrokerCallNote({ source: "broker", note: BROKER_CALL_SOURCE_NOTE }));
  assert.ok(isBrokerSessionSource({ source: "broker", note: BROKER_SESSION_SOURCE_NOTE }) && !isBrokerCallNote({ source: "broker", note: BROKER_SESSION_SOURCE_NOTE }));
  ok("GENERIC_ASKS and MEMBER_LABELS cover every group and member; shared keys have a home; writable members; call notes are broker notes");
}

// ── dd's questions about the numbers ───────────────────────────────────
{
  const fq = [{ id: "reasonRentChange2024", sectionKey: "financials", label: "Why did rent rise in 2024?", writeKey: "reasonRentChange2024", memberKeys: ["reasonRentChange2024"], critical: false, origin: "figures", ask: "Why did rent go up in 2024?", why: "Buyers will ask what drove this." }];
  const deal = mkDeal(factsOf({ annualRevenue: ["$4.8M", "document"] }));
  const broker = build(deal, { figureItems: fq });
  const before = build(deal);
  const q = item(broker, "financials:reasonRentChange2024");
  assert.equal(q.origin, "figures");
  assert.equal(q.status, "missing");
  assert.deepEqual(broker.totals, before.totals, "figure questions never count");
  assert.equal(broker.percentCollected, before.percentCollected);
  assert.equal(broker.sections.find((s) => s.key === "financials")!.figureQuestions, 1);
  assert.equal(viewCounts(broker).questions, 1);
  const seller = build(deal, { figureItems: fq }, "seller");
  assert.ok(!seller.sections.flatMap((s) => s.items).some((i) => i.origin === "figures"), "never in the seller's view");
  const filed = build(mkDeal(factsOf({ annualRevenue: ["$4.8M", "document"], reasonRentChange2024: ["The landlord's new lease", "call"] })), { figureItems: fq });
  assert.equal(item(filed, "financials:reasonRentChange2024").status, "on_file");
  ok("dd's questions about the numbers: Numbers items under Financial Summary, never counted, never for the seller");
}

// ── Views, filters, stable order ───────────────────────────────────────
{
  const deal = mkDeal(factsOf({ seasonality: ["Busy in summer", "interview"], reasonForSale: ["Retiring", "interview"] }));
  const b = build(deal);
  const ask = filterItems(b, { view: "ask" });
  assert.ok(ask.every((g) => g.items.every((i) => i.status !== "on_file")));
  assert.equal(ask[0].section.importance, "critical", "critical sections first");
  const counts = filterCounts(b, { view: "ask" });
  assert.equal(counts.all, ask.reduce((n, g) => n + g.items.length, 0));
  const searched = filterItems(b, { view: "all", query: "busiest" });
  assert.ok(searched.some((g) => g.items.some((i) => i.id === "seasonality:seasonality")), "search reads asks and member labels");

  const sectionOf: Record<string, string> = { a: "s1", b: "s1", c: "s2", d: "s1", e: "s3" };
  const exists = new Set(["a", "b", "c", "d", "e"]);
  let snap = stableOrder(null, { key: "ask|all", ids: ["a", "b", "c"] }, sectionOf, exists, 0);
  assert.deepEqual(snap.ids, ["a", "b", "c"]);
  // b is filed (no longer matches) — it stays where it is.
  snap = stableOrder(snap, { key: "ask|all", ids: ["a", "c"] }, sectionOf, exists, 60_000);
  assert.deepEqual(snap.ids, ["a", "b", "c"], "a filed row keeps its index");
  // d newly opens in s1 → appended at the end of s1's group; e in a new section → at the end.
  snap = stableOrder(snap, { key: "ask|all", ids: ["a", "c", "d", "e"] }, sectionOf, exists, 61_000);
  assert.deepEqual(snap.ids, ["a", "b", "d", "c", "e"]);
  // An item taken off the checklist leaves; a new view takes a fresh snapshot.
  snap = stableOrder(snap, { key: "ask|all", ids: ["a", "c"] }, sectionOf, new Set(["a", "c", "d", "e"]), 62_000);
  assert.deepEqual(snap.ids, ["a", "d", "c", "e"]);
  snap = stableOrder(snap, { key: "ask|missing", ids: ["c"] }, sectionOf, exists, 63_000);
  assert.deepEqual(snap.ids, ["c"]);
  ok("views, filters and search; the stable order keeps filed rows in place and appends new ones to their section");
}

// ── What to ask next, the call sheet ───────────────────────────────────
{
  const plan = { industry: "Home Services", subIndustry: null, computedAt: new Date().toISOString(), status: "ready", rulesVersion: 2, items: [{ key: "emrRating", label: "WSIB experience rating (EMR)", sectionKey: "employees", critical: true }] };
  const deal = mkDeal(factsOf({}), { industry: "Home Services", interviewPlan: plan });
  const b = build(deal, { reqs: [{ id: "r1", documentName: "General ledger", isRequired: true, status: "missing" }, { id: "r2", documentName: "Lease", isRequired: true, status: "uploaded" }] });
  const top = rankOpenItems(b);
  assert.equal(top[0].id, "employees:emrRating", "a critical item in a critical section ranks first");
  const now = Date.now();
  const sugg = nextToAsk(b, { now, followUp: { ask: "Which year was that?", at: now - 30_000, itemId: "financials:annualRevenue" }, topicSections: ["seasonality"] });
  assert.equal(sugg[0].kind, "follow_up");
  assert.equal(sugg[0].ask, "Which year was that?");
  assert.equal(sugg[1].kind, "same_topic");
  assert.equal(sugg[1].sectionKey, "seasonality");
  assert.equal(sugg[2].kind, "critical");
  assert.equal(sugg.length, 3);
  const asked = nextToAsk(b, { now, askedAt: { "employees:emrRating": now - 60_000 } });
  assert.ok(!asked.some((s) => s.itemId === "employees:emrRating" && s.kind === "critical"), "asked in the last 10 minutes drops down");
  assert.equal(b.documents.length, 1, "only open document requests");
  const sheet = callSheet(b, "Test Heating Ltd");
  assert.match(sheet.text, /WSIB experience rating \(EMR\) — CRITICAL/);
  assert.match(sheet.text, /Ask: What's your WSIB experience rating\?/);
  assert.match(sheet.text, /Documents still needed\n {2}\[ \] General ledger/);
  ok("'what to ask next' (follow-up, same topic, critical; recently asked drops) and the call sheet");
}

// ── A session's filings on an item's OTHER members (checker r2 R2-4) ──────
{
  const at1 = "2026-10-09T15:00:00.000Z";
  const at2 = "2026-10-09T15:02:00.000Z";
  const deal = mkDeal(factsOf({
    seasonality: ["Busy season requires 4 days/week in office", "interview"],
    peakPeriods: ["June through August, and December to February", { source: "call", documentId: "T1", excerpt: "June through August, and December to February", sittingId: "S1", chunkId: "C8", at: at1 }],
    slowPeriods: ["April and October", { source: "call", documentId: "T1", excerpt: "April and October are slow", sittingId: "S1", chunkId: "C9", at: at2 }],
    ownerInvolvement: ["Three days a week", { source: "interview" }],
  }));
  const docs = [{ id: "T1", name: "Interview together — 9 Oct 2026 (In person)", visibility: "shared", sourceKind: "call", sourceMeta: { recordType: "together_sitting" } }];
  const b = build(deal, { documents: docs });
  const season = item(b, "seasonality:seasonality");
  assert.equal(season.valueKey, "seasonality", "the row keeps showing the value already on file");
  assert.deepEqual(season.sessionFiled?.map((e) => e.key), ["slowPeriods", "peakPeriods"], "both members filed this session, newest first");
  assert.equal(season.filedInSittingId, "S1");
  assert.equal(season.filedByChunkId, "C9");
  assert.equal(season.sessionFiled?.[0].quote, "April and October are slow");
  assert.equal(filedEntryText(season, season.sessionFiled![0], season.sessionFiled!), "Quietest months: April and October");
  assert.ok(filedThisSitting(season, "S1") && !filedThisSitting(season, "S2"));
  assert.equal(viewCounts(b, "S1").filed, 1, "one data point answered this session (the header's 'N filed')");
  assert.deepEqual(filterItems(b, { view: "filed", sittingId: "S1" }).flatMap((g) => g.items.map((i) => i.id)), ["seasonality:seasonality"], "'Filed this session' shows it");
  assert.equal(item(b, "employees:ownerInvolvement").sessionFiled, undefined, "an untouched item has no session filings");
  // Screen: the seller's own words said aloud are shown; the seller audience carries none of it.
  const screen = build(deal, { documents: docs }, "screen");
  const sSeason = item(screen, "seasonality:seasonality");
  assert.deepEqual(sSeason.sessionFiled?.map((e) => [e.key, e.value, !!e.privateValue]), [["slowPeriods", "April and October", false], ["peakPeriods", "June through August, and December to February", false]]);
  const seller = build(deal, { documents: docs }, "seller");
  assert.equal(item(seller, "seasonality:seasonality").sessionFiled, undefined, "seller: no session filings");
  assert.ok(!JSON.stringify(seller).includes("April and October"));
  ok("a session's answer filed under an item's other member shows on that item (row, Filed this session, count), screen-safe, never to the seller");
}

// ── Screen: a fact the broker settled reads 'On file — private to you' (checker r2 R2-5) ──
{
  const deal = mkDeal(factsOf({
    workingCapital: ["Normalized net working capital $301,000 at Dec 31, 2024 (cash-free, debt-free)", { source: "broker", at: "2026-10-01T00:00:00Z" }],
  }));
  const broker = build(deal);
  assert.match(String(item(broker, "financials:workingCapital").value), /\$301,000/);
  const screen = build(deal, {}, "screen");
  const wc = item(screen, "financials:workingCapital");
  assert.equal(wc.value, null, "never the seller-safe view's stand-in '(on file — settled by the broker)'");
  assert.equal(wc.privateValue, true);
  assert.ok(!JSON.stringify(screen).includes("settled by the broker"));
  assert.ok(!JSON.stringify(screen).includes("301,000"));
  ok("screen: a fact the broker settled reads 'On file — private to you', never the stand-in text");
}

console.log(`\n${n} checks passed`);

// ── Template asks keep proper names ────────────────────────────────────
import("../../server/interview/coverage-asks").then(async ({ templateAsk }) => {
  assert.equal(templateAsk("WSIB experience rating (EMR)"), "What's your WSIB experience rating?", "an aside in brackets is dropped from the spoken ask");
  assert.equal(templateAsk("A/R aging"), "What does your A/R aging look like?", "two capitals in the first word: kept");
  assert.equal(templateAsk("Associate PT agreement terms"), "Can you walk me through the associate PT agreement terms?", "an acronym second word isn't a proper name");
  assert.equal(templateAsk("Canadian customs and duties compliance for imports"), "Where do things stand with Canadian customs and duties compliance for imports?");
  console.log("✓ template asks keep acronyms and proper names");
  // Until the phrasing pass has run, the labels the founder saw read as spoken questions (F4, checker r2 R2-2).
  const cases: Array<[string, string]> = [
    ["Revenue split: installations vs service/repair", "How does revenue break down between installations and service/repair?"],
    ["Gross margin: installs vs service vs plumbing", "How does gross margin break down between installs, service and plumbing?"],
    ["Commercial vs residential revenue split", "How does revenue break down between commercial and residential?"],
    ["Recurring vs project vs T&M revenue split", "How does revenue break down between recurring, project and T&M?"],
    ["In-store vs online sales percentage split", "How do sales break down between in-store and online?"],
    ["Comfort Club membership trend (last 3 years)", "How has Comfort Club membership trended over the last three years?"],
    ["Foot traffic level and trend (last 3 years)", "How has foot traffic trended over the last three years?"],
    ["PT and RMT turnover last 3 years", "What has your PT and RMT turnover been over the last three years?"],
    ["Fleet replacement capital required (next 24 months)", "How much fleet replacement capital will be required over the next 24 months?"],
    ["Workplace accidents/injuries (last 5 years)", "Have there been any workplace accidents/injuries over the last five years?"],
    ["Revenue breakdown (dry van, reefer, drayage, 3PL)", "How does revenue break down across dry van, reefer, drayage and 3PL?"],
    ["Product mix breakdown (vape vs tobacco vs accessories %)", "How does product mix break down across vape, tobacco and accessories?"],
    ["Compounding revenue as percentage of total", "What percentage of the total is compounding revenue?"],
    ["ODB (Ontario Drug Benefit) percentage of Rx revenue", "What percentage of Rx revenue comes from ODB?"],
    ["Largest single customer (% of revenue)", "What percentage of revenue comes from your largest single customer?"],
    ["Labour cost as percentage of revenue", "What's your labour cost as a percentage of revenue?"],
    ["Current cleanroom capacity utilization percentage", "What's your current cleanroom capacity utilization as a percentage?"],
    // "Number of X" → "How many X …?" (checker r2: "How many licensed pharmacists on staff?" was ungrammatical).
    ["Number of licensed pharmacists on staff", "How many licensed pharmacists do you have on staff?"],
    ["Number of registered pharmacy technicians", "How many registered pharmacy technicians do you have?"],
    ["Number of PTs rostered for dry needling", "How many PTs are rostered for dry needling?"],
    ["Number of competing vape/tobacco stores within 1km and 5km", "How many competing vape/tobacco stores are there within 1km and 5km?"],
    ["Number of setup technicians and average tenure", "How many setup technicians do you have, and what's their average tenure?"],
    ["Total LTC/retirement beds under contract", "How many LTC/retirement beds do you have under contract?"],
    ["Trailer count by type (dry van, reefer, chassis)", "How many trailers do you have, by type?"],
    ["Average driver tenure (years)", "What's your average driver tenure, in years?"],
    ["Average age of power units and trailers", "What's the average age of your power units and trailers?"],
    ["Current equipment utilization rate (%)", "What's your current equipment utilization rate?"],
    // "Any X" → "Are there any X?"
    ["Any lanes or accounts currently out for rebid", "Are there any lanes or accounts currently out for rebid?"],
    ["Any revocation or suspension in authority history", "Is there any revocation or suspension in authority history?"],
    ["Consignment inventory arrangements (if any)", "Are there any consignment inventory arrangements?"],
    // A rule never becomes a question asking the seller to state the law — it asks about their situation.
    ["Buyer must be licensed pharmacist (Ontario ownership restriction)", "How would the rule that the buyer must be a licensed pharmacist affect your sale?"],
    ["Physiotherapist-only ownership restriction (Alberta)", "How would the physiotherapist-only ownership restriction affect your sale?"],
    ["Lease assignment requires landlord consent", "Has the landlord said whether they'd need to consent to the lease assignment?"],
    ["Landlord consent required for share sale", "Has the landlord said whether they'd need to consent to the share sale?"],
    ["Does lease require landlord consent for ownership change", "Has the landlord said whether they'd need to consent to the ownership change?"],
    ["Equipment/trailer leases requiring lessor consent to assign", "Are there any equipment/trailer leases where the lessor would need to consent to a transfer?"],
    // Predicates and situations (checker r2 examples).
    ["All drivers properly licensed (AZ/DZ/CDL)", "Are all drivers properly licensed?"],
    ["Exposure if contractors reclassified as employees", "What would it cost the business if contractors were reclassified as employees?"],
    ["Premises medically zoned for pharmacy use", "Are the premises medically zoned for pharmacy use?"],
    ["Workforce unionized (yes/no and which union)", "Is the workforce unionized, and if so, which union?"],
    ["Retention plan for licensed technicians", "What's the retention plan for licensed technicians?"],
    ["Vehicle leases/loans assignable to buyer", "Can vehicle leases/loans be assigned to a buyer?"],
    ["TSSA gas license holder and transferability", "Who holds the TSSA gas license, and can it transfer to a buyer?"],
    ["License transferability on owner exit", "Can the license transfer to a buyer when you leave?"],
    ["Names of all master license holders", "Can you list all master license holders?"],
    ["CTPAT certification status", "Where do things stand with CTPAT certification?"],
    ["CISC certification status (if held)", "Do you have CISC certification, and where does it stand?"],
    ["Last RCDSO inspection date and outcome", "When was the last RCDSO inspection, and how did it go?"],
    ["ODB or private-payer billing audit history and outcome", "Have there been any ODB or private-payer billing audits, and how did they turn out?"],
    ["Who handles estimating for installations", "Who handles estimating for installations?"],
    // Bare noun phrases read as natural questions.
    ["Subcontractor usage and key dependencies", "Can you walk me through your subcontractor usage and key dependencies?"],
    ["Dispatch and scheduling software/process", "Can you walk me through your dispatch and scheduling software/process?"],
    ["Practice management software system", "What practice management software system do you use?"],
    ["Warehouse clear height", "What's your warehouse clear height?"],
    ["Supplier exclusivity agreements", "What supplier exclusivity agreements do you have?"],
    ["Documented health and safety program", "Do you have a documented health and safety program?"],
    ["In-house orthodontics opportunity", "How do you see the in-house orthodontics opportunity?"],
    ["Revenue/relationship dependency on Daniel (senior LTC pharmacist)", "How much does the business depend on Daniel?"],
    ["Warehouse workers (employees vs temp agency)", "Are your warehouse workers employees, or do they come through a temp agency?"],
    // Spoken TO the seller: the owner is "you" (never an owner-operator).
    ["Owner's personal share of total dispensing/clinical production", "What share of total dispensing/clinical production is your own?"],
    ["Revenue dependent on owner personally (regulars, expertise)", "How much revenue depends on you personally?"],
    ["Personal guarantee on lease by owner", "Have you personally guaranteed the lease?"],
    ["Owner-operator agreements written and compliant", "Are owner-operator agreements written and compliant?"],
  ];
  for (const [label, ask] of cases) assert.equal(templateAsk(label), ask, label);
  assert.equal(templateAsk("Revenue split: installations vs service/repair."), templateAsk("Revenue split: installations vs service/repair"), "a trailing full stop is ignored");
  // Every industry label on the three demo deals reads as a question — never "Can you tell me about …?".
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const fix = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "together", "fixtures");
  let n = 0;
  for (const f of ["lakeshore", "pacific", "beacon"]) {
    const d = JSON.parse(fs.readFileSync(path.join(fix, `deal-${f}.json`), "utf8"));
    for (const it of d.deal.interviewPlan?.items ?? []) {
      const ask = templateAsk(it.label);
      n++;
      assert.ok(/\?$/.test(ask) && !/^Can you tell me about/i.test(ask) && !/\(/.test(ask), `${it.label} → ${ask}`);
    }
  }
  assert.ok(n >= 100, `${n} labels`);
  console.log("✓ template asks read as spoken questions for the common label shapes; rules ask about the seller's situation; no 'Can you tell me about …?' on the demo deals");
});

// ── One primary button per row ─────────────────────────────────────────
import("../../client/src/components/coverage/CoverageItemRow").then(({ primaryActionFor }) => {
  const base: any = { id: "x:y", sectionKey: "x", label: "Y", members: [{ key: "y", label: "y", writable: true }], readKeys: ["y"], valueKey: null, critical: false, origin: "generic", status: "missing", reason: null, value: null, source: null, ask: "", why: "", marks: [] };
  assert.equal(primaryActionFor(base, "checklist"), "add");
  assert.equal(primaryActionFor({ ...base, status: "partial" }, "checklist"), "add");
  assert.equal(primaryActionFor({ ...base, status: "verify", reason: { code: "estimate" } }, "checklist"), "confirm");
  assert.equal(primaryActionFor({ ...base, status: "verify", reason: { code: "lead", leadKind: "crm" } }, "checklist"), "confirm");
  assert.equal(primaryActionFor({ ...base, status: "verify", reason: { code: "conflict", privateSide: false }, conflictId: "d1" }, "checklist"), "resolve");
  assert.equal(primaryActionFor({ ...base, status: "verify", reason: null, moneyTalk: true, conflictId: "d2" }, "checklist"), "resolve", "a hidden conflict still resolves");
  assert.equal(primaryActionFor({ ...base, status: "on_file" }, "checklist"), null);
  assert.equal(primaryActionFor({ ...base, members: [{ key: "sde", label: "SDE", writable: false }] }, "checklist"), null, "the broker's own calculation has no Add answer");
  assert.equal(primaryActionFor({ ...base }, "panel"), null, "the AI-interview panel is read-only");
  assert.equal(primaryActionFor({ ...base, suggestion: { value: "v", quote: "q", chunkId: "c", memberKey: "y" } }, "live"), "file_it", "a held possible answer: ✓ File it");
  assert.equal(primaryActionFor({ ...base, suggestion: { value: "v", quote: "q", chunkId: "c", memberKey: "y" } }, "checklist"), "add", "no File it outside a live session");
  console.log("✓ one context-aware primary button per row");
});

// Suggest next: an item someone else has the answer for ("Denise has the EMR") waits for them.
{
  const mk = (id: string, status: any, reason: any, critical = true) => ({ id, sectionKey: "employees", label: id, members: [], readKeys: [], valueKey: null, critical, origin: "generic", status, reason, value: null, source: null, ask: `Ask ${id}?`, why: "", marks: [] });
  const board: any = { sections: [{ key: "employees", title: "Employees", order: 9, importance: "critical", importanceReason: "", items: [mk("employees:emr", "partial", { code: "not_known", whoHasIt: "Denise" }), mk("employees:staff", "missing", null)], references: [], counts: { on_file: 0, partial: 1, verify: 0, missing: 1 }, figureQuestions: 0 }] };
  const ideas = nextToAsk(board, { now: 0 });
  assert.equal(ideas[0].itemId, "employees:staff");
  assert.ok(!ideas.some((i) => i.kind === "critical" && i.itemId === "employees:emr"), "never 'critical, not asked yet'");
  console.log("✓ Suggest next: 'someone else has it' items wait for that person");
}

