// The seller interview's knowledge base never carries the broker's listed
// asking price from the deal row (Valuation step / deal creation) — it keeps
// collecting the seller's own expectation, exactly as before the two copies
// of the price were kept as one value. Offline (no database, no AI).
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/information/interview-price-view.test.ts
import assert from "node:assert/strict";
import { assembleKnowledgeBase, renderKnowledgeBaseForPrompt } from "../../server/interview/knowledge-base";
import { MIRROR_NOTES } from "../../server/information/deal-mirror";

let n = 0;
const ok = (name: string) => { n++; console.log("✓", name); };

const baseDeal = {
  id: "d1", brokerId: "b1", businessName: "QA Price Co", industry: "Dental", subIndustry: null, description: null,
  location: "Toronto, ON", questionnaireData: null, operationalSystems: null, employeeChart: null, scrapedData: null,
  scrapeSource: null, sellerProfile: null, sectionImportance: null, interviewOutline: null, interviewPlan: null,
  askingPrice: "$2,750,000",
} as any;

// 1. Valuation price only → not on the interview's file; the prompt never shows it
{
  const deal = { ...baseDeal, extractedInfo: {
    annualRevenue: "$1.4M",
    askingPrice: "$2,750,000",
    _fieldSources: { annualRevenue: { source: "document" }, askingPrice: { source: "broker", note: MIRROR_NOTES.valuation } },
  } };
  const kb = assembleKnowledgeBase(deal, [], [], null, []);
  assert.equal((kb.extractedInfo as any).askingPrice, undefined);
  assert.equal((kb.extractedInfo as any).annualRevenue, "$1.4M");
  const prompt = renderKnowledgeBaseForPrompt(kb);
  assert.ok(!prompt.includes("2,750,000"), "the broker's price never reaches the prompt");
  assert.ok(prompt.includes("askingPrice: NOT YET CAPTURED"), "coverage shows the seller's expectation as a gap");
  assert.ok(!/askingPrice: \$/.test(prompt), "askingPrice is not listed as already answered");
  ok("Valuation-only price: the interview still asks the seller");
}

// 2. Valuation price + the seller's own answer → the seller's answer is what's on file
{
  const deal = { ...baseDeal, extractedInfo: {
    askingPrice: "$2,750,000",
    _fieldSources: { askingPrice: { source: "broker", note: MIRROR_NOTES.valuation } },
    _fieldAlternates: { askingPrice: [{ source: "interview", value: "$3M", turn: 6, at: "2026-09-20T00:00:00Z" }] },
  } };
  const kb = assembleKnowledgeBase(deal, [], [], null, []);
  assert.equal((kb.extractedInfo as any).askingPrice, "$3M");
  assert.equal(kb.factSourceLabels?.askingPrice, "from the seller in the interview");
  const prompt = renderKnowledgeBaseForPrompt(kb);
  assert.ok(prompt.includes("askingPrice: $3M  [from the seller in the interview]"), "never re-asked");
  assert.ok(!prompt.includes("2,750,000"));
  assert.equal((deal.extractedInfo as any).askingPrice, "$2,750,000", "the deal's own facts are untouched");
  ok("seller already answered: shown as the seller's answer, never re-asked");
}

// 3. A broker edit on the Information tab reaches the interview as before
{
  const deal = { ...baseDeal, extractedInfo: {
    askingPrice: "$2,900,000",
    _fieldSources: { askingPrice: { source: "broker", at: "2026-09-25T00:00:00Z" } },
  } };
  const kb = assembleKnowledgeBase(deal, [], [], null, []);
  assert.equal((kb.extractedInfo as any).askingPrice, "$2,900,000");
  assert.equal(kb.factSourceLabels?.askingPrice, "confirmed by the broker");
  ok("Information-tab broker facts behave as before");
}

console.log(`\n${n} groups passed`);
