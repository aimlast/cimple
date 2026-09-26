// PRIV-V-6: the deep check's outreach angle (the opening of a pre-NDA email
// to a buyer) must not draw on an item kept from buyers. Before the fix it
// was checked for identity only, so angles naming or describing Pacific's
// confidential Harvest Lane RFP passed isBlindSafe / findBlindLeaks.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/rv-outreach-angle.test.ts
import assert from "node:assert/strict";
import { outreachAngleGuard, angleKeepsOut } from "../../server/matching/angle-keep-out";

const info: Record<string, unknown> = {
  businessDescription: "Regional less-than-truckload and warehousing carrier serving grocery, building supply and retail customers across the Lower Mainland and Vancouver Island.",
  customerBase: "Over 300 customers; largest is Alderbrook Grocery Distributors (about 18% of revenue, contract to 2027).",
  growthOpportunities: "Cold-chain expansion into the Fraser Valley. Potential new contract with Harvest Lane Markets, a 26-store independent grocery chain, could add $2-2.5M a year (RFP shortlist, confidential).",
  fleet: "112 power units, 240 trailers, average age 5.1 years",
  _brokerPrivateNotes: [{ note: "Seller asked that the Harvest Lane RFP stays out of the CIM." }],
};

const guard = outreachAngleGuard(info);
assert.ok(guard.clauses.some((c) => /Harvest Lane/.test(c)), "the confidential clause is held");

for (const angle of [
  "A regional carrier with a pending shortlist position for a major regional grocery-chain contract.",
  "Shortlisted in an RFP with a 26-store independent grocery chain, which could add $2M+ a year.",
  "Shortlisted for a Harvest Lane Markets contract, a strong fit for your distribution platform.",
]) {
  assert.equal(angleKeepsOut(angle, guard), false, `held: ${angle}`);
}
console.log("✓ angles naming or describing the confidential RFP are dropped");

for (const angle of [
  "A profitable regional LTL and warehousing carrier with a young fleet and a diversified grocery and building-supply customer base.",
  "A confidential opportunity: an established West Coast carrier with cold-chain growth in the Fraser Valley.",
]) {
  assert.equal(angleKeepsOut(angle, guard), true, `kept: ${angle}`);
}
console.log("✓ ordinary angles still pass");

// The AI review's holds count too (a clause the rules can't read).
{
  const info2 = { growthOpportunities: "Talks with Northshore Foods about a dedicated lane (seller would rather buyers not hear about this yet)", fleet: "40 trucks" };
  const g2 = outreachAngleGuard(info2, { clauses: [{ key: "growthOpportunities", text: "Talks with Northshore Foods about a dedicated lane (seller would rather buyers not hear about this yet)" }], names: ["Northshore Foods"], pairs: [] });
  assert.equal(angleKeepsOut("In talks about a dedicated lane with a large food distributor.", g2), false);
  assert.equal(angleKeepsOut("A 40-truck regional carrier with steady contract revenue.", g2), true);
  console.log("✓ the AI review's holds are applied to the angle");
}

// Paraphrases that share no word with the clause: its figures, or a pending
// new contract/customer when the only one on file is held. On the live
// Pacific wording (one long growth clause naming Harvest Lane) every one of
// these passed the word check.
{
  const live = {
    businessDescription: "Regional LTL and warehousing carrier; long-term contracts with grocery distributors; 20+ years in business.",
    growthOpportunities: "Cooler expansion (15,000 sq ft, ~$1.1–1.2M capex, sub-three-year payback), Alberta cross-dock opportunity (Calgary, 25–30K sq ft, to capture freight currently given to other carriers), electric day cab deployment (two battery-electric units on order mid-2026 with provincial incentive), potential Harvest Lane Markets contract ($2–2.5M annual starting late 2026)",
    fleet: "112 power units, 240 trailers",
  };
  const g = outreachAngleGuard(live, { clauses: [], names: ["Harvest Lane Markets", "Harvest Lane"], pairs: [] });
  assert.equal(g.heldProspect, true);
  for (const angle of [
    "Close to landing a new supermarket customer that could add $2-2.5M a year from late 2026.",
    "In the running for a large new retail account in the Fraser Valley.",
    "The business is close to winning a large new grocery retailer, a near-term upside for a buyer.",
    "Pending new retail-chain customer could lift revenue by roughly a tenth.",
    "Upside includes a potential new contract worth $2-2.5M a year starting late 2026.",
    "A carrier that could add $2.5M of annual revenue next year.",
  ]) {
    assert.equal(angleKeepsOut(angle, g), false, `held: ${angle}`);
  }
  for (const angle of [
    "A profitable West Coast LTL and warehousing carrier with a young fleet - a clean add-on for your logistics platform.",
    "An established regional trucking business with 20+ years of history and a management team that stays on.",
    "A logistics company with long-term contracts with grocery distributors and a strong safety record.",
    "A 112-unit fleet serving long-term grocery distribution contracts.",
  ]) {
    assert.equal(angleKeepsOut(angle, g), true, `kept: ${angle}`);
  }
  // A pending contract buyers MAY hear about: the prospect rule steps aside.
  const open = { ...live, growthPipeline: "Pending renewal and a potential new contract with a national retailer (shared with buyers)." };
  const g2 = outreachAngleGuard(open, { clauses: [], names: ["Harvest Lane Markets", "Harvest Lane"], pairs: [] });
  assert.equal(g2.heldProspect, false);
  assert.equal(angleKeepsOut("A potential new contract with a national retailer adds upside.", g2), true);
  console.log("✓ figures and pending-deal paraphrases of a held item are dropped; ordinary angles pass");
}

console.log("rv-outreach-angle: all passed");
