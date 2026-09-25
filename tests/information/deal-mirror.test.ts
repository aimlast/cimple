// Deal columns that mirror facts (asking price) + the shared "can the CIM be
// written yet?" rule — offline checks (no database, no AI).
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/information/deal-mirror.test.ts
import assert from "node:assert/strict";
import {
  reconcileMirroredFacts, columnPatchAfterChange, listedAskingPrice, effectiveAskingPrice, sameValue, MIRROR_NOTES,
  interviewFactView, isDealRowFact,
} from "../../server/information/deal-mirror";
import { setBrokerFact, editFact, deleteFact, restoreFact, useAlternate, applyResolutionToInfo } from "../../server/information/facts";
import { getFieldSources, getFieldAlternates } from "../../server/interview/info-merger";
import { cimGenerationGate, computeNextStep, phaseChecklist, CIM_GENERATION_MIN_READINESS } from "../../shared/deal-progress";

let n = 0;
const ok = (name: string) => { n++; console.log("✓", name); };
type Info = Record<string, unknown>;

/** What mutateDealInfo does, minus the database: returns the saved deal. */
function mutate(deal: { askingPrice: string | null; extractedInfo: Info }, fn: (info: Info) => void) {
  const info = structuredClone(deal.extractedInfo);
  const { columnPatch } = reconcileMirroredFacts(deal, info, setBrokerFact);
  const before = structuredClone(info);
  fn(info);
  const after = columnPatchAfterChange({ ...deal, ...columnPatch }, before, info);
  return { ...deal, ...columnPatch, ...after, extractedInfo: info };
}

// sameValue: formatting doesn't count as a disagreement
assert.ok(sameValue("$1,850,000", "1850000"));
assert.ok(sameValue("$1.85M", "$1,850,000"));
assert.ok(!sameValue("$1,850,000", "$2,400,000"));
assert.ok(sameValue(null, null) && !sameValue("$1", null));
ok("sameValue compares amounts, not formatting");

// 1. Information-tab edit → the column follows (the reported bug)
let deal = mutate({ askingPrice: "$1,850,000", extractedInfo: {} }, () => undefined);
assert.equal((deal.extractedInfo as Info).askingPrice, "$1,850,000", "column becomes the broker fact on first touch");
assert.equal(getFieldSources(deal.extractedInfo).askingPrice.source, "broker");
deal = mutate(deal, (info) => editFact(info, "askingPrice", "$2,400,000"));
assert.equal(deal.askingPrice, "$2,400,000");
assert.equal(listedAskingPrice(deal), "$2,400,000");
assert.equal(effectiveAskingPrice(deal), "$2,400,000");
assert.ok(getFieldAlternates(deal.extractedInfo).askingPrice?.some((a) => a.value === "$1,850,000"), "old value kept as alternate");
ok("broker edit on the Information tab writes deals.askingPrice");

// 2. Delete → column cleared; restore → back
deal = mutate(deal, (info) => deleteFact(info, "askingPrice"));
assert.equal(deal.askingPrice, null);
assert.equal(listedAskingPrice(deal), null);
// a later mutation must not resurrect it from anywhere
deal = mutate(deal, () => undefined);
assert.equal(deal.askingPrice, null);
assert.equal((deal.extractedInfo as Info).askingPrice, undefined);
deal = mutate(deal, (info) => restoreFact(info, "askingPrice"));
assert.equal(deal.askingPrice, "$2,400,000");
ok("delete clears the column, restore brings it back");

// 3. Chosen alternate and discrepancy resolution follow too
deal = mutate(deal, (info) => {
  const alts = getFieldAlternates(info).askingPrice ?? [];
  const idx = alts.findIndex((a) => a.value === "$1,850,000");
  useAlternate(info, "askingPrice", idx);
});
assert.equal(deal.askingPrice, "$1,850,000");
deal = mutate(deal, (info) => applyResolutionToInfo(info, {
  field: "Asking price", resolvedValue: "$2,000,000", interviewValue: "$2.2M", documentValue: null, documentId: null, source: "interview",
} as any));
assert.equal(deal.askingPrice, "$2,000,000");
ok("chosen alternate + resolved discrepancy update the column");

// 4. Valuation step (column write) → broker fact; seller's figure stays an alternate
let d2 = { askingPrice: null as string | null, extractedInfo: {
  askingPrice: "$3M", _fieldSources: { askingPrice: { source: "interview", turn: 9 } },
} as Info };
d2 = mutate(d2, (info) => setBrokerFact(info, "askingPrice", "$2,750,000", { note: MIRROR_NOTES.valuation }));
assert.equal(d2.askingPrice, "$2,750,000");
assert.equal(getFieldSources(d2.extractedInfo).askingPrice.note, MIRROR_NOTES.valuation);
assert.ok(getFieldAlternates(d2.extractedInfo).askingPrice?.some((a) => a.value === "$3M" && a.source === "interview"));
ok("Valuation price becomes the broker fact; the seller's figure is kept as an alternate");

// 5. Legacy drift: column vs a seller fact → column wins as the broker's entry
let d3 = { askingPrice: "$900,000", extractedInfo: {
  askingPrice: "$1.1M", _fieldSources: { askingPrice: { source: "interview" } },
} as Info };
d3 = mutate(d3, () => undefined);
assert.equal((d3.extractedInfo as Info).askingPrice, "$900,000");
assert.equal(getFieldSources(d3.extractedInfo).askingPrice.source, "broker");
assert.equal(d3.askingPrice, "$900,000");
// Legacy drift: broker fact vs a stale column → the broker fact wins
let d4 = { askingPrice: "$1,850,000", extractedInfo: {
  askingPrice: "$2,400,000", _fieldSources: { askingPrice: { source: "broker", at: "2026-09-25T10:00:00Z" } },
} as Info };
assert.equal(listedAskingPrice(d4), "$2,400,000", "readers prefer the broker fact even before reconciling");
d4 = mutate(d4, () => undefined);
assert.equal(d4.askingPrice, "$2,400,000");
// No column + a seller figure → nothing written to the column; readers fall back only where allowed
const d5 = { askingPrice: null, extractedInfo: { askingPrice: "$3M", _fieldSources: { askingPrice: { source: "interview" } } } as Info };
assert.deepEqual(mutate(d5, () => undefined).askingPrice, null);
assert.equal(listedAskingPrice(d5), null, "a seller's expectation is never the listed price");
assert.equal(effectiveAskingPrice(d5), "$3M", "broker-facing figures fall back to it");
// Same amount, different formatting → no churn
const d6 = { askingPrice: "1850000", extractedInfo: { askingPrice: "$1,850,000", _fieldSources: { askingPrice: { source: "document" } } } as Info };
const r6 = reconcileMirroredFacts(d6, structuredClone(d6.extractedInfo), setBrokerFact);
assert.equal(r6.infoChanged, false);
assert.deepEqual(r6.columnPatch, {});
// An unrelated edit doesn't touch the column
const d7 = mutate({ askingPrice: "$1M", extractedInfo: { askingPrice: "$1M", _fieldSources: { askingPrice: { source: "broker" } } } }, (info) => editFact(info, "annualRevenue", "$4M"));
assert.equal(d7.askingPrice, "$1M");
ok("drifted copies reconcile by authority; formatting and unrelated edits cause no churn");

// 6. Delete + restore of a seller's figure never makes it the listed price
//    (round-2 review: the restored "$3,000,000" landed in deals.askingPrice)
let d8 = { askingPrice: null as string | null, extractedInfo: {
  askingPrice: "$3,000,000", _fieldSources: { askingPrice: { source: "interview", turn: 4 } },
} as Info };
d8 = mutate(d8, (info) => deleteFact(info, "askingPrice"));
assert.equal(d8.askingPrice, null);
d8 = mutate(d8, (info) => restoreFact(info, "askingPrice"));
assert.equal((d8.extractedInfo as Info).askingPrice, "$3,000,000", "the fact is back");
assert.equal(getFieldSources(d8.extractedInfo).askingPrice.source, "interview", "with its own source");
assert.equal(d8.askingPrice, null, "…but never on the deal row");
assert.equal(listedAskingPrice(d8), null);
assert.equal(effectiveAskingPrice(d8), "$3,000,000");
d8 = mutate(d8, () => undefined);
assert.equal(d8.askingPrice, null, "and a later reconcile doesn't promote it either");
assert.equal(getFieldSources(d8.extractedInfo).askingPrice.source, "interview");
// A broker price replaced by a non-broker value (not a current flow, but the
// rule holds): the column is cleared, not left pointing at the old price.
const d9 = { askingPrice: "$2M", extractedInfo: { askingPrice: "$2M", _fieldSources: { askingPrice: { source: "broker" } } } as Info };
const before9 = structuredClone(d9.extractedInfo);
const after9 = { ...before9, askingPrice: "$2.5M", _fieldSources: { askingPrice: { source: "document" } } };
assert.deepEqual(columnPatchAfterChange(d9, before9, after9), { askingPrice: null });
// Same amount from another source keeps the column (legacy equal copies)
assert.deepEqual(columnPatchAfterChange(d9, before9, { ...after9, askingPrice: "2000000" }), {});
// Restoring a deleted BROKER price still brings the column back (group 2)
ok("only a broker value reaches the column — a restored seller figure doesn't");

// 7. The seller interview never sees the deal-row price
const valuation = mutate(
  { askingPrice: null, extractedInfo: { askingPrice: "$3M", _fieldSources: { askingPrice: { source: "interview", turn: 9, at: "2026-09-20T00:00:00Z" } } } as Info },
  (info) => setBrokerFact(info, "askingPrice", "$2,750,000", { note: MIRROR_NOTES.valuation }),
);
assert.ok(isDealRowFact(valuation.extractedInfo, "askingPrice"));
let seen = interviewFactView(valuation.extractedInfo);
assert.equal(seen.askingPrice, "$3M", "the interview sees the seller's own expectation");
assert.equal(getFieldSources(seen).askingPrice.source, "interview");
assert.equal((valuation.extractedInfo as Info).askingPrice, "$2,750,000", "the stored fact is untouched");
// Only the Valuation price on file → the interview still asks the seller
const onlyValuation = mutate({ askingPrice: null, extractedInfo: {} }, (info) => setBrokerFact(info, "askingPrice", "$1.2M", { note: MIRROR_NOTES.valuation }));
seen = interviewFactView(onlyValuation.extractedInfo);
assert.equal(seen.askingPrice, undefined);
assert.equal(getFieldSources(seen).askingPrice, undefined);
// Created with a price, and a price lined up from the column: hidden too
const created = mutate({ askingPrice: "$800,000", extractedInfo: {} }, () => undefined);
assert.equal(getFieldSources(created.extractedInfo).askingPrice.note, MIRROR_NOTES.reconciled);
assert.equal(interviewFactView(created.extractedInfo).askingPrice, undefined);
// The newest seller figure wins over an older one; a document is below the seller
const alts = { askingPrice: "$2M", _fieldSources: { askingPrice: { source: "broker", note: MIRROR_NOTES.valuation } },
  _fieldAlternates: { askingPrice: [
    { source: "document", value: "$1.9M", at: "2026-09-25T00:00:00Z" },
    { source: "interview", value: "$2.6M", at: "2026-09-10T00:00:00Z" },
    { source: "interview", value: "$2.4M", at: "2026-09-22T00:00:00Z" },
    { source: "broker", value: "$2.1M", at: "2026-09-24T00:00:00Z" },
  ] } } as Info;
assert.equal(interviewFactView(alts).askingPrice, "$2.4M");
// A broker edit on the Information tab reaches the interview as before
const tabEdit = mutate(valuation, (info) => editFact(info, "askingPrice", "$2,900,000"));
assert.equal(isDealRowFact(tabEdit.extractedInfo, "askingPrice"), false);
assert.equal(interviewFactView(tabEdit.extractedInfo), tabEdit.extractedInfo, "nothing hidden → same object");
ok("interview view hides the deal-row price and shows the seller-side value");

// ── CIM generation gate ──────────────────────────────────────────────
assert.deepEqual(cimGenerationGate({ interviewCompleted: true }, null), { allowed: true, pending: false, reason: null });
assert.equal(cimGenerationGate({ interviewCompleted: false }, undefined).pending, true);
assert.equal(cimGenerationGate({ interviewCompleted: false }, CIM_GENERATION_MIN_READINESS).allowed, true);
const thin = cimGenerationGate({ interviewCompleted: false }, 12);
assert.equal(thin.allowed, false);
assert.match(thin.reason ?? "", /12\/100/);
assert.match(thin.reason ?? "", /Information tab/);
ok("gate: interview complete OR enough information from any source");

const base = {
  id: "d1", phase: "phase3_content_creation", isLive: false, ndaSigned: true, ndaSentAt: null, sqCompleted: true,
  valuationCompleted: false, interviewCompleted: false, contentApprovedByBroker: false, contentApprovedBySeller: false,
  designApprovedByBroker: false, designApprovedBySeller: false, cimLayoutGeneratedAt: null, scrapedAt: null,
  questionnaireData: {}, cimContent: null, cimDesignData: null,
} as any;
assert.equal(computeNextStep(base, { invited: true, readinessScore: 20 }).owner, "seller", "thin + no interview → waiting on the interview");
assert.deepEqual(computeNextStep(base, { invited: false, readinessScore: 20 }), { label: "add information or invite the seller", owner: "you", href: "/deal/d1/information" });
assert.deepEqual(computeNextStep(base, { invited: true, readinessScore: 50 }), { label: "generate the CIM", owner: "you", href: "/deal/d1/overview" });
assert.equal(computeNextStep(base, { invited: true, readinessScore: 50, openCriticalDiscrepancies: 2 }).label, "resolve 2 conflicting facts");
assert.equal(computeNextStep(base, { invited: true, hasCimSections: true }).label, "review the CIM content", "a builder-only CIM is a draft");
assert.equal(phaseChecklist("phase3_content_creation", base, { hasCimSections: true })[0].done, true);
ok("next step + checklist follow the same rule");

console.log(`\n${n} groups passed`);
