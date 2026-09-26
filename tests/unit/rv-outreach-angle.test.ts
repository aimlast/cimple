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

console.log("rv-outreach-angle: all passed");
