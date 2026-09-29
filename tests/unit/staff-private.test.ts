// Staff-private matters are held out of the CIM by default (founder,
// 2026-09-28: the rebuilt Beacon CIM printed the lead pharmacist's informal
// ask for an equity stake in Key Personnel and turned it into an Ideal Buyer
// Profile pitch — "I don't want to include it in the CIM").
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/staff-private.test.ts
import assert from "node:assert/strict";
import {
  screenStaffPrivatePairs,
  screenStaffPrivateText,
  splitStaffPrivate,
  staffContextFrom,
  staffPrivateId,
  staffPrivateTopic,
  includedStaffPrivate,
  staffPrivateWarning,
  STAFF_PRIVATE_INCLUDED_KEY,
} from "../../server/cim/staff-private";
import { screenFactsForCim, keepOutFromNotes } from "../../server/cim/sensitive-facts";

// The Beacon facts as they are on file (production, 2026-09-28), trimmed to what matters here.
const BEACON: Record<string, unknown> = {
  ownerName: "Dr. Helen Park",
  ownership: "Dr. Helen Park 100% shareholder; no holding company",
  ownerRole: "owner + DM pharmacist",
  reasonForSale: "Retirement after 19 years",
  keyEmployees:
    "Daniel Okafor: LTC lead pharmacist since 2014 (11 years), primary contact for long-term care homes, knows all resident med lists, approximately 1 year ago informally asked about buying equity stake. Mei-Lin: compounding pharmacist since 2018, rebuilt all master formulation records, manages 340-formula library, led successful College compounding assessment. Carol Whitfield: Billing & AR manager. Farah: pharmacist focused on minor ailment assessments. Sophie: manages weekly narcotics counts.",
  managementTeam: "Dr. Helen Park (owner/designated manager), Daniel Okafor (LTC lead pharmacist, since 2014, LTC relationship owner), Mei-Lin (compounding lead, since 2018), Carol Whitfield (Billing & AR)",
  danielRetentionRisk: "Seller views losing Daniel as 'a real problem'; believes buyer-offered equity roll-over or earn-in would secure his long-term commitment.",
  danielEquityInterest:
    "Daniel raised equity stake interest again in spring 2024 around Maplecrest renewal. Helen declined but kept door open. Daniel is ambitious and capable; seller believes a buyer-offered roll-over or earn-in would help retain him long-term.",
  pharmacistRetentionIntentions: "Daniel asked Helen about a year ago (half-joking) whether she would ever let him buy in; Helen believes if a buyer offered him a small stake, he would stay forever",
  pharmacistRetention:
    "Mei-Lin Tran (compounding lead): settled, built the formula library and the vet relationships; unlikely to leave. Farah Haddad: part-time (0.8 FTE) by choice, reliable and bilingual; may move to full-time. No departure signals from any pharmacist.",
  idealBuyer:
    "Strategic buyer anticipated (per broker). Buyer with capital and interest in Level C compounding expansion, capacity to add pharmacist headcount for minor ailments growth, and ability to structure management rollover/retention for Daniel.",
  staffingChallenges:
    "Pharmacists difficult to recruit in Ottawa market; 2024 agency recruitment cost $14,500 for pharmacist who left after 3 months; long-tenured core staff (Sophie since 2011, Carol since 2009); no union; competitive pay, benefits, and RRSP match offered",
  managementComment:
    "Pharmacy continuously accredited since 2006 with no discipline findings against the pharmacy or its designated manager. 2023 controlled-substance loss was employee theft matter reported to all required authorities; enhanced controls reviewed by pharmacy consultant.",
  cedarviewManorPipeline:
    "Cedarview Manor, 88-bed retirement home in Orléans. Executive director called in December, unhappy with current provider who has given notice ending June 30. Verbal commitment to move to Beacon (nothing signed).",
  transitionPlan: "Helen stays as Designated Manager until the buyer's DM is approved (up to 6 months), then 3 months of paid consulting.",
  dealStructure: "Share sale; seller open to a 10% vendor take-back over 3 years; seller will roll 5% equity if the buyer wants it.",
};

const ctx = staffContextFrom(BEACON);
const everything = (info: Record<string, unknown>) => JSON.stringify(info);
const EQUITY_WORDS = /equity|stake|buy in|buying|roll-?over|earn-?in|half-joking|door open|informally/i;

// 1. Beacon: the equity ask is gone from every fact; the rest of each fact stays.
{
  const pairs = Object.entries(BEACON) as Array<[string, unknown]>;
  const r = screenStaffPrivatePairs(pairs, { ctx });
  const safe = Object.fromEntries(r.safe) as Record<string, string>;
  // The founder's example, in both sections' source facts.
  for (const [k, v] of Object.entries(safe)) {
    if (k === "dealStructure") continue; // the owner's own roll-over — deal structure, stays
    assert.ok(!EQUITY_WORDS.test(String(v)), `${k} still carries the equity matter: ${v}`);
  }
  assert.equal(
    safe.keyEmployees.split(". ")[0],
    "Daniel Okafor: LTC lead pharmacist since 2014 (11 years), primary contact for long-term care homes, knows all resident med lists",
    "the business part of the key-person fact stays",
  );
  assert.ok(safe.keyEmployees.includes("Mei-Lin: compounding pharmacist since 2018"), "other staff untouched");
  assert.equal(safe.danielRetentionRisk, "Seller views losing Daniel as 'a real problem'", "key-person dependency stays");
  assert.ok(!("danielEquityInterest" in safe), "a fact whose label names the matter is held whole");
  assert.ok(!("pharmacistRetentionIntentions" in safe));
  assert.equal(
    safe.idealBuyer,
    "Strategic buyer anticipated (per broker). Buyer with capital and interest in Level C compounding expansion, capacity to add pharmacist headcount for minor ailments growth.",
  );
  // Legitimate buyer-facing facts pass untouched.
  for (const k of ["pharmacistRetention", "staffingChallenges", "managementComment", "cedarviewManorPipeline", "transitionPlan", "dealStructure", "reasonForSale", "managementTeam"]) {
    assert.equal(safe[k], BEACON[k], `${k} must pass unchanged`);
  }
  // Every held piece is listed for the broker, described plainly.
  assert.ok(r.items.length >= 5);
  assert.ok(r.items.every((i) => i.kind === "equity" && i.description === "Daniel Okafor's interest in an ownership stake"), JSON.stringify(r.items, null, 1));
  assert.ok(r.items.some((i) => i.key === "keyEmployees" && i.text === "approximately 1 year ago informally asked about buying equity stake"));
  console.log("✓ Beacon: the equity ask is held clause by clause; the key-person facts stay");
}

// 2. Through the CIM screen (every buyer-facing path: writer, DD, section regen, outreach angle).
{
  const r = screenFactsForCim(Object.entries(BEACON) as Array<[string, unknown]>, keepOutFromNotes(BEACON));
  assert.ok(!EQUITY_WORDS.test(JSON.stringify(r.safe.filter(([k]) => k !== "dealStructure"))));
  assert.ok(r.staffPrivate.length >= 5, "the held items come back for the broker");
  const w = staffPrivateWarning(r.staffPrivate);
  assert.ok(w && w.startsWith("Held back from the CIM: Daniel Okafor's interest in an ownership stake."), w ?? "");
  console.log("✓ screenFactsForCim holds staff-private clauses and reports them");
}

// 3. The broker's include switch puts exactly that item back.
{
  const first = screenStaffPrivatePairs(Object.entries(BEACON) as Array<[string, unknown]>, { ctx });
  const item = first.items.find((i) => i.key === "keyEmployees")!;
  const info = { ...BEACON, [STAFF_PRIVATE_INCLUDED_KEY]: [item.id] };
  assert.deepEqual(Array.from(includedStaffPrivate(info)), [item.id]);
  const r = screenFactsForCim(Object.entries(info).filter(([k]) => !k.startsWith("_")) as Array<[string, unknown]>, keepOutFromNotes(info));
  const safe = Object.fromEntries(r.safe) as Record<string, string>;
  assert.equal(safe.keyEmployees, BEACON.keyEmployees, "the included clause is back, verbatim");
  assert.ok(!("danielEquityInterest" in safe), "other items stay held");
  assert.ok(!r.staffPrivate.some((i) => i.id === item.id), "an included item is not reported as held");
  // Same words → same id (a regenerate, or the same clause in another fact).
  assert.equal(staffPrivateId("approximately 1 year ago informally asked about buying equity stake"), item.id);
  console.log("✓ an included item goes back into the inputs; the rest stay held");
}

// 4. The earlier AI drafts the writer reads (the founder's two live sentences).
{
  const drafts =
    "Daniel Okafor, LTC Lead Pharmacist, has been with the pharmacy for 11 years and is the primary contact for all 14 homes. Asked about equity stake approximately one year ago; seller believes buyer-offered equity roll-over or earn-in would secure long-term commitment.\n\n" +
    "The ideal acquirer is a licensed Ontario pharmacist or pharmacist-owned group. Daniel informally expressed interest in an equity stake approximately one year ago. A buyer who can structure equity roll-over, earn-in, or long-term incentive compensation will secure the LTC relationships.";
  const r = screenStaffPrivateText(drafts, ctx);
  assert.ok(!/equity|earn-in|roll-over/i.test(r.text), r.text);
  assert.ok(r.text.includes("has been with the pharmacy for 11 years"), "the key-person sentence stays");
  assert.ok(r.text.includes("licensed Ontario pharmacist or pharmacist-owned group"), "the buyer profile's opening stays");
  assert.equal(r.held.length, 4, JSON.stringify(r.held));
  assert.equal(r.text.split("\n\n")[0], "Daniel Okafor, LTC Lead Pharmacist, has been with the pharmacy for 11 years and is the primary contact for all 14 homes.");
  console.log("✓ earlier drafts: the equity sentences (and their follow-up) are cut");
}

// 5. Corpus — staff-private sentences are held; buyer-facing ones pass (both directions).
const OWNER_CTX = staffContextFrom({ ownerName: "Tom Reyes", keyEmployees: "Maria Lopez (shop foreman, 14 years); Kevin Tran (estimator); Priya Shah (office manager)" });
const HELD: Array<[string, string]> = [
  // equity
  ["keyEmployees", "Maria Lopez, shop foreman for 14 years, has asked about buying into the business."],
  ["keyEmployees", "Kevin asked Tom last spring whether he could get a piece of the business someday."],
  ["managementTeam", "Priya Shah wants a minority stake after the sale."],
  ["employees", "Tom thinks offering Kevin some equity would keep him long-term."],
  ["retentionNotes", "The foreman floated the idea of becoming a partner."],
  ["keyEmployees", "Maria would like an earn-in if a new owner comes in."],
  // pay
  ["employees", "Kevin has been pushing for a raise since January."],
  ["keyEmployees", "Maria is unhappy with her pay and has complained twice."],
  ["staffNotes", "There is an ongoing bonus dispute with the estimator."],
  // departure
  ["keyEmployees", "Kevin may leave if the new owner changes the commission plan."],
  ["employees", "Priya has been interviewing with a competitor."],
  ["retention", "The office manager is thinking about retiring next year."],
  ["keyEmployees", "Maria is a flight risk."],
  ["staff", "Kevin gave his notice last week."],
  // conduct
  ["employees", "Kevin received a written warning in March for attendance issues."],
  ["staff", "The office manager is on a performance improvement plan."],
  ["keyEmployees", "Maria was suspended for two days after a safety incident."],
  // personal
  ["employees", "Priya is on maternity leave until June."],
  ["staff", "Kevin is going through a divorce and has been distracted."],
  ["keyEmployees", "Maria has been caring for her sick mother and works reduced hours."],
  // conversation
  ["employees", "Kevin confided to Tom that he is burned out."],
  ["keyEmployees", "Maria told Tom privately that she hopes to run the shop one day."],
];
const PASS: Array<[string, string]> = [
  ["keyEmployees", "Maria Lopez, shop foreman, 14 years, runs production and holds the key customer relationships."],
  ["keyEmployees", "Kevin Tran signed a two-year retention agreement in 2025."],
  ["managementTeam", "Priya Shah owns 10% of the shares and will sell alongside the owner."],
  ["managementTeam", "Management rollover agreed: Maria will roll 5% of her proceeds into the new company."],
  ["dealStructure", "The seller will roll over 20% equity and is open to a vendor take-back."],
  ["reasonForSale", "Tom Reyes plans to retire after 30 years."],
  ["transitionPlan", "The owner will stay for 6 months of transition."],
  ["succession", "Disclosed succession plan: Maria takes over as general manager; announced to staff in 2024."],
  ["retention", "No key employee has indicated plans to leave."],
  ["retention", "Kevin is unlikely to leave and is committed to staying through the transition."],
  ["staffingHistory", "One estimator left in 2023 and was replaced within a month."],
  ["employeeBenefits", "Employees receive extended health benefits and a maternity leave top-up."],
  ["compensation", "Wages rose 3% in 2025 under the annual review; overtime is paid at 1.5x."],
  ["compliance", "No disciplinary findings against the company or its licensed staff."],
  ["confidentiality", "Staff are not aware of the sale."],
  ["customers", "Harbour Foods asked about an equity partnership in 2023 but the talks ended."],
  ["keyEmployees", "Priya handles payroll, AP and the bank reconciliations."],
  ["growth", "A buyer could add a second shift and hire two more estimators."],
  ["employees", "23 employees; average tenure 9 years; no union."],
  ["ownership", "Tom Reyes 100% shareholder."],
  ["keyEmployees", "Kevin has built a strong book of repeat commercial accounts."],
];
{
  const bad: string[] = [];
  for (const [key, text] of HELD) {
    const r = splitStaffPrivate(text, OWNER_CTX, { key });
    if (r.held.length === 0) bad.push(`NOT HELD [${key}] ${text}`);
  }
  for (const [key, text] of PASS) {
    const r = splitStaffPrivate(text, OWNER_CTX, { key });
    if (r.held.length > 0) bad.push(`WRONGLY HELD [${key}] ${text} → ${JSON.stringify(r.held)}`);
  }
  assert.deepEqual(bad, [], bad.join("\n"));
  console.log(`✓ corpus: ${HELD.length} staff-private sentences held, ${PASS.length} buyer-facing sentences pass`);
}

// 6. The topic alone is not enough: the same words about the owner or a buyer pass.
{
  assert.equal(staffPrivateTopic("Seller is willing to roll 10% equity into the buyer's company"), null);
  assert.equal(splitStaffPrivate("Tom may retire earlier if the right buyer appears.", OWNER_CTX, { key: "reasonForSale" }).held.length, 0);
  assert.equal(splitStaffPrivate("Harbour Foods asked about a stake in 2023.", OWNER_CTX, { key: "otherInterest" }).held.length, 0);
  console.log("✓ the owner's and outsiders' plans are not staff matters");
}

// 7. Nothing is held silently: every held piece carries a description.
{
  const r = screenStaffPrivatePairs([["keyEmployees", "Kevin Tran (estimator) may leave after the sale."]], { ctx: OWNER_CTX });
  assert.deepEqual(r.items.map((i) => i.description), ["Kevin Tran's possible departure"]);
  console.log("✓ each held item is described for the broker");
}

void everything;
