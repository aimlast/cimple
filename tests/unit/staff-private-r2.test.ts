// Staff-private matters, round 2 (independent check of 2026-09-28): wordings
// the first screen missed, buyer-facing facts it wrongly held, the AI review
// widening the cut, include switches that didn't take, extraction routing
// that moved the owner's own plans, and a CIM written before the screen.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/staff-private-r2.test.ts
import assert from "node:assert/strict";
import {
  routeStaffPrivate,
  routeStaffPrivateChanges,
  splitStaffPrivate,
  staffContextFrom,
  staffPrivateId,
} from "../../server/cim/staff-private";
import { keepOutFromNotes, screenFactsForCim } from "../../server/cim/sensitive-facts";
import { keepOutFor, _setKeepOutModelForTests } from "../../server/cim/keep-out";
import { heldPrivateItems, sectionsShowingStaffPrivate } from "../../server/cim/held-private";
import { assembleKnowledgeBase } from "../../server/cim/layout-engine";
import { buildDdContext } from "../../server/cim/dd-enrichment";
import { mergeExtractedData, routeStaffPrivateToNotes } from "../../server/documents/extractor";
import { getPrivateNotes } from "../../server/interview/info-merger";
import { seedExtractedInfoFromQuestionnaire } from "../../server/interview/session-manager";
import { STAFF_PRIVATE_INCLUDED_KEY, type StaffPrivateItem } from "../../shared/staff-private";

const TODAY = new Date("2026-09-29T12:00:00Z");
const HVAC = {
  ownerName: "Linda Moreau",
  keyEmployees: "Raj Patel (service manager, 12 years); Jenna Brooks (office manager, since 2016); Marcus Chen (lead installer); Oksana Kovalenko (dispatcher)",
};
const ctx = staffContextFrom(HVAC);

// 1. Corpus, both directions — the checker's sentences plus new wordings.
{
  const HELD: Array<[string, string]> = [
    ["keyEmployees", "Raj has hinted he'd want a slice of ownership if the business changes hands."],
    ["keyEmployees", "Raj Patel, service manager for 12 years, runs all HVAC service calls, and last fall asked Linda whether he could buy a share of the company."],
    ["managementTeam", "Jenna mentioned to Linda over coffee that she might go back to school next year."],
    ["employees", "Marcus has been approached by a competitor offering more money."],
    ["keyEmployees", "Oksana is on stress leave since August."],
    ["employees", "Marcus got a final warning for no-shows in the spring."],
    ["staffNotes", "Jenna feels underpaid compared with the market."],
    ["keyEmployees", "Linda has thought about offering Raj phantom equity to keep him."],
    ["employees", "Raj's wife is ill and he has been working reduced hours."],
    ["keyEmployees", "Jenna asked for a 10% raise in January; Linda hasn't answered yet."],
    ["employees", "The lead installer told Linda in confidence that he is burned out."],
    ["keyEmployees", "Marcus is considering starting his own company."],
    ["keyPersonRisk", "Raj Patel is key to service; he has asked about becoming a partner."],
    ["employees", "The dispatcher is going through a divorce."],
    ["keyEmployees", "Raj would love to own part of the business one day."],
    ["employees", "Jenna has been looking at other jobs since the sale was mentioned."],
    ["keyEmployees", "Marcus asked for a $5,000 raise last month."],
    ["employees", "Oksana's mother is in the hospital and she has taken time off."],
    ["keyEmployees", "Jenna wants to buy a piece of the company when Linda retires."],
    ["keyEmployees", "Raj Patel gave his notice last week; Linda hasn't told the team yet."],
    ["keyEmployees", "Raj Patel: service manager since 2013; asked Linda about buying a stake last year."],
    ["keyEmployees", "Raj Patel (service manager, 12 years); asked the owner about an equity stake last year."],
    ["keyEmployees", "Raj Patel - service manager - 12 years - informally asked about equity"],
    ["keyEmployees", "Marcus Chen: lead installer. He was diagnosed with cancer in June."],
    ["employees", "A staff member asked for a raise after the busy season."],
    ["employees", "Two of our technicians have been approached by a competitor."],
    ["keyEmployees", "Jenna told Linda privately that she is expecting in the spring."],
  ];
  const PASS: Array<[string, string]> = [
    ["keyEmployees", "Raj Patel has resigned effective March 31; his replacement has been hired and trained."],
    ["employees", "Raj Patel is leaving on June 30 under an agreed transition; his successor Marcus is already in place and customers have been told."],
    ["employees", "Two technicians are currently on probation as new hires."],
    ["employees", "New hires complete a 90-day probationary period."],
    ["keyEmployees", "Jenna Brooks is retiring in December 2026 after 25 years; her successor is already in the role."],
    ["employees", "Two technicians resigned in 2023 and were replaced within a month."],
    ["keyEmployees", "Raj Patel owns 20% of the company and will sell his shares alongside Linda."],
    ["keyEmployees", "Raj Patel holds a 15% stake acquired in 2019."],
    ["dealStructure", "Management rollover agreed: Raj will roll his 15% into the buyer's entity."],
    ["succession", "Raj will take over as general manager after closing; this succession plan has been announced to staff."],
    ["employees", "Jenna's daughter works part-time in the office during summers."],
    ["compensation", "Technician wages were increased 4% across the board in 2025."],
    ["employees", "The company offers a profit-sharing bonus pool to all technicians."],
    ["customers", "Rideau Properties asked about a stake in the company in 2022; no talks followed."],
    ["keyEmployees", "Raj is performance-reviewed annually and has exceeded targets every year."],
    ["reasonForSale", "Linda Moreau is retiring after 28 years."],
    ["transitionPlan", "Linda will stay for 12 months; Raj stays on as service manager."],
    ["retention", "Every key employee has indicated they will stay through the transition."],
    ["employees", "32 employees; 8 licensed technicians; average tenure 7 years; no union."],
    ["keyEmployees", "Raj Patel, service manager, 12 years, holds the commercial maintenance contracts."],
    // Written demo CIMs (2026-09-29 sweep): the trade in general, and "privately" that isn't a conversation.
    ["Patient Base & Acquisition", "Harbourline Dental Group serves a diversified patient base, with approximately 70 percent of patients covered by employer-sponsored insurance plans and 30 percent paying privately. The team is stable."],
    ["Organization & Management Team", "Turnover is common in the MSP industry as entry-level technicians are recruited by larger enterprises, government, and financial institutions offering higher pay."],
    ["risks", "Key employees may leave after a change of ownership; retention agreements are recommended."],
    ["employees", "Staff have access to a privately funded pension plan."],
  ];
  const bad: string[] = [];
  for (const [key, text] of HELD) if (splitStaffPrivate(text, ctx, { key }).held.length === 0) bad.push(`NOT HELD [${key}] ${text}`);
  for (const [key, text] of PASS) {
    const r = splitStaffPrivate(text, ctx, { key });
    if (r.held.length > 0) bad.push(`WRONGLY HELD [${key}] ${text} → ${JSON.stringify(r.held)}`);
  }
  assert.deepEqual(bad, [], bad.join("\n"));
  // The business part of each sentence stays, in the sentence's own words.
  const keep = (text: string) => splitStaffPrivate(text, ctx, { key: "keyEmployees" }).kept;
  assert.equal(keep("Raj Patel: service manager since 2013; asked Linda about buying a stake last year."), "Raj Patel: service manager since 2013");
  assert.equal(keep("Raj Patel (service manager, 12 years); asked the owner about an equity stake last year."), "Raj Patel (service manager, 12 years)");
  assert.equal(keep("Raj Patel - service manager - 12 years - informally asked about equity"), "Raj Patel - service manager - 12 years");
  assert.equal(keep("Raj Patel, service manager for 12 years, runs all HVAC service calls, and last fall asked Linda whether he could buy a share of the company."), "Raj Patel, service manager for 12 years, runs all HVAC service calls.");
  console.log(`✓ corpus: ${HELD.length} staff-private sentences held, ${PASS.length} buyer-facing sentences pass (announced departures and new-hire probation pass)`);
}

// The Beacon facts (production, 2026-09-28).
const BEACON: Record<string, unknown> = {
  ownerName: "Dr. Helen Park",
  ownership: "Dr. Helen Park 100% shareholder; no holding company",
  keyEmployees:
    "Daniel Okafor: LTC lead pharmacist since 2014 (11 years), primary contact for long-term care homes, knows all resident med lists, approximately 1 year ago informally asked about buying equity stake. Mei-Lin: compounding pharmacist since 2018, manages 340-formula library.",
  danielRetentionRisk: "Seller views losing Daniel as 'a real problem'; believes buyer-offered equity roll-over or earn-in would secure his long-term commitment.",
  idealBuyer: "Buyer with capital and interest in Level C compounding expansion, capacity to add pharmacist headcount, and ability to structure management rollover/retention for Daniel.",
  annualRevenue: "$9,120,400",
};
const BUSINESS_PART = "Daniel Okafor: LTC lead pharmacist since 2014 (11 years), primary contact for long-term care homes, knows all resident med lists.";
/** A stand-in for the confidentiality review that flags every fact sentence naming equity — the whole sentence, as production sends it. */
const flagEquitySentences = {
  messages: {
    create: async (req: any) => {
      const holds: any[] = [];
      for (const line of (req.messages[0].content as string).split("\n")) {
        const m = /^(F\d+) \[(\w+)\]: (.*)$/.exec(line);
        if (m && m[2] !== "ownership" && /equity|buying/i.test(m[3])) holds.push({ ref: m[1], parties: [], kind: "staff_private", staffTopic: "equity", reason: "staff equity" });
      }
      return { content: [{ type: "tool_use", id: "x", name: "keep_out_review", input: { holds } }] };
    },
  },
} as any;

// 2. The AI review flags the whole sentence the rules already cut: the cut stays the rules' one.
{
  _setKeepOutModelForTests(flagEquitySentences);
  const ko = await keepOutFor("r2-a", BEACON);
  assert.ok((ko.staff?.aiClauses.length ?? 0) >= 1, "the review flagged the sentence");
  const r = screenFactsForCim(Object.entries(BEACON) as Array<[string, unknown]>, ko);
  const safe = Object.fromEntries(r.safe) as Record<string, string>;
  assert.ok(safe.keyEmployees.startsWith(BUSINESS_PART), safe.keyEmployees);
  assert.ok(!/equity|buying/i.test(safe.keyEmployees));
  // The generation's item is the one the CIM tab lists (same id, same words).
  const listed = heldPrivateItems(BEACON);
  const tab = listed.find((i) => i.key === "keyEmployees")!;
  const gen = r.staffPrivate.find((i) => i.key === "keyEmployees")!;
  assert.equal(gen.id, tab.id);
  assert.equal(gen.text, "approximately 1 year ago informally asked about buying equity stake");
  // Include it: the next generation (AI review running again) puts it back.
  const info = { ...BEACON, [STAFF_PRIVATE_INCLUDED_KEY]: [tab.id] };
  const ko2 = await keepOutFor("r2-a", info);
  const kb = assembleKnowledgeBase({ dealId: "r2-a", businessName: "Beacon", industry: "Pharmacy", extractedInfo: info, keepOut: ko2, today: TODAY });
  assert.ok(kb.text.includes("knows all resident med lists, approximately 1 year ago informally asked about buying equity stake"), "included → back in, with the AI review running");
  assert.ok(!/earn-in/.test(kb.text), "the other items stay held");
  const after = heldPrivateItems(info, kb.staffPrivate);
  assert.equal(after.find((i) => i.id === tab.id)?.included, true);
  _setKeepOutModelForTests(null);
  console.log("✓ the AI review flagging a whole sentence keeps the business part; Include works with the review running");
}

// 3. A sentence only the AI flags is cut where the private matter starts, not at its first comma.
{
  const info = {
    ownerName: "Linda Moreau",
    keyEmployees: "Raj Patel: service manager since 2013, runs all commercial service contracts, has been sounding out a hospital facilities role.",
  };
  const r = splitStaffPrivate(String(info.keyEmployees), staffContextFrom(info), {
    key: "keyEmployees",
    extraHeld: [{ text: String(info.keyEmployees), kind: "departure" }],
  });
  assert.equal(r.kept, "Raj Patel: service manager since 2013, runs all commercial service contracts.");
  assert.deepEqual(r.held, [{ text: "has been sounding out a hospital facilities role", kind: "departure", by: "ai" }]);
  console.log("✓ an AI-only sentence is cut at the private part");
}

// 4. Include ids match the listed words when the held part starts with "and".
{
  const info: Record<string, unknown> = {
    ownerName: "Linda Moreau",
    keyEmployees: "Raj Patel: service manager since 2013, runs all commercial service contracts, and informally asked Linda about buying a stake last year.",
  };
  const items = heldPrivateItems(info);
  assert.deepEqual(items.map((i) => i.text), ["informally asked Linda about buying a stake last year"]);
  assert.equal(items[0].id, staffPrivateId("informally asked Linda about buying a stake last year"));
  const withIt = { ...info, [STAFF_PRIVATE_INCLUDED_KEY]: [items[0].id] };
  const kb = assembleKnowledgeBase({ dealId: "r2-and", businessName: "X", industry: "HVAC", extractedInfo: withIt, today: TODAY });
  assert.ok(kb.text.includes("and informally asked Linda about buying a stake last year"), "the included words are back");
  assert.ok(buildDdContext({ extractedInfo: withIt }).knownText.includes("buying a stake"));
  console.log("✓ an included 'and …' part goes back into the writer and DD inputs");
}

// 5. Every passage a generation held is listed, even when its cut differs from today's rules.
{
  const lastRun: StaffPrivateItem[] = [
    { id: staffPrivateId("primary contact for long-term care homes, knows all resident med lists, approximately 1 year ago informally asked about buying equity stake"), key: "keyEmployees", kind: "equity", text: "primary contact for long-term care homes, knows all resident med lists, approximately 1 year ago informally asked about buying equity stake", description: "Daniel Okafor's interest in an ownership stake", person: "Daniel Okafor", by: "rules" },
  ];
  const listed = heldPrivateItems(BEACON, lastRun);
  assert.ok(listed.some((i) => i.id === lastRun[0].id), "the passage the last run held is shown");
  console.log("✓ the broker sees every passage a generation held");
}

// 6. Document extraction: the owner's own plans stay facts; staff matters move, with the deal's people known.
{
  const cases: Array<[Record<string, unknown>, Record<string, unknown>]> = [
    [{ reasonForSale: "Helen is thinking about retiring next year and wants to sell within 12 months." }, { reasonForSale: "Helen is thinking about retiring next year and wants to sell within 12 months." }],
    [{ sellerMotivation: "Tom wants to move on to spend time with his grandchildren." }, { sellerMotivation: "Tom wants to move on to spend time with his grandchildren." }],
    [{ transitionPlan: "Gord may stay on for up to a year after closing if the buyer wants." }, { transitionPlan: "Gord may stay on for up to a year after closing if the buyer wants." }],
    [{ keyEmployees: "Raj Patel has resigned effective March 31; his replacement has been hired and trained." }, { keyEmployees: "Raj Patel has resigned effective March 31; his replacement has been hired and trained." }],
    [{ employees: "Two technicians are currently on probation as new hires." }, { employees: "Two technicians are currently on probation as new hires." }],
  ];
  for (const [input, expected] of cases) {
    const d = JSON.parse(JSON.stringify(input));
    routeStaffPrivateToNotes(d);
    assert.deepEqual(d, expected, JSON.stringify(input));
  }
  // The staff member is known only from the deal's facts: routed at merge time.
  const deal = { ownerName: "Dr. Helen Park", keyEmployees: "Daniel Okafor: LTC lead pharmacist since 2014" };
  const merged = mergeExtractedData(deal, { summary: "Call notes", ltcContracts: "14 homes under contract; Daniel asked Helen about buying a stake last year." } as any, { documentId: "call1", source: "call", title: "Seller call" });
  assert.equal(merged.ltcContracts, "14 homes under contract", JSON.stringify(merged.ltcContracts));
  const notes = getPrivateNotes(merged);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].note, "Daniel asked Helen about buying a stake last year");
  assert.equal(notes[0].documentId, "call1");
  // An owner's own first-name plans on file stay the fact at merge time too.
  const m2 = mergeExtractedData({ ownerName: "Dr. Helen Park" }, { reasonForSale: "Helen is thinking about retiring next year." } as any, { documentId: "d2" });
  assert.equal(m2.reasonForSale, "Helen is thinking about retiring next year.");
  assert.equal(getPrivateNotes(m2).length, 0);
  console.log("✓ extraction: the owner's own plans and announced/new-hire facts stay facts; staff matters move with the deal's context");
}

// 7. The interview turn's guard (session-manager uses routeStaffPrivateChanges).
{
  const existing = { ownerName: "Dr. Helen Park", keyEmployees: "Daniel Okafor: LTC lead pharmacist since 2014" };
  const changes = [
    { fieldName: "keyEmployees", newValue: "Daniel Okafor: LTC lead pharmacist since 2014, primary contact for the homes; asked Helen about buying a stake last year.", confidence: "confirmed" },
    { fieldName: "reasonForSale", newValue: "Helen is thinking about retiring next year.", confidence: "confirmed" },
    { fieldName: "danielEquityInterest", newValue: "Daniel wants a small stake.", confidence: "confirmed" },
    { fieldName: "annualRevenue", newValue: "$9,120,400", confidence: "confirmed" },
  ];
  const r = routeStaffPrivateChanges(changes, existing);
  assert.deepEqual(r.routedKeys, ["keyEmployees", "danielEquityInterest"]);
  assert.deepEqual(r.droppedKeys, ["danielEquityInterest"]);
  assert.deepEqual(r.changes.map((c) => [c.fieldName, c.newValue]), [
    ["keyEmployees", "Daniel Okafor: LTC lead pharmacist since 2014, primary contact for the homes"],
    ["reasonForSale", "Helen is thinking about retiring next year."],
    ["annualRevenue", "$9,120,400"],
  ]);
  assert.deepEqual(r.notes.map((n) => n.note), ["Daniel Okafor — asked Helen about buying a stake last year", "Daniel wants a small stake."]);
  assert.ok(r.notes.every((n) => /kept out of the CIM/.test(n.reason)));
  assert.equal(r.changes[0].confidence, "confirmed", "the change keeps its other fields");
  console.log("✓ interview guard: private part → note, business part → fact, the owner's plans untouched");
}

// 8. Intake questionnaire: the staff matter becomes a private note, the rest the fact.
{
  const seeded = seedExtractedInfoFromQuestionnaire({
    questionnaireData: {
      ownerName: "Tom Reyes",
      keyEmployees: "Maria Lopez, shop foreman for 14 years, runs production, and has asked Tom about buying into the business.",
      reasonForSale: "Tom is retiring after 30 years.",
    },
    extractedInfo: {},
  });
  assert.ok(seeded);
  assert.equal(seeded!.keyEmployees, "Maria Lopez, shop foreman for 14 years, runs production.");
  assert.equal(seeded!.reasonForSale, "Tom is retiring after 30 years.");
  const notes = getPrivateNotes(seeded!);
  assert.ok(notes.some((n) => n.note === "Maria Lopez — has asked Tom about buying into the business" && n.questionnaire), JSON.stringify(notes));
  console.log("✓ intake answers: the staff matter is the broker's note, the business part the fact");
}

// 9. A CIM written before the screen: the sections that still state it are named, until regenerated or included.
{
  const info = { ...BEACON };
  const items = heldPrivateItems(info);
  const sections = [
    { id: "s1", sectionTitle: "Key Personnel", layoutData: { people: [{ name: "Daniel Okafor", role: "LTC Lead Pharmacist (11 years)", note: "Asked about equity stake approximately one year ago; seller believes buyer-offered equity roll-over or earn-in would secure long-term commitment." }] } },
    { id: "s2", sectionTitle: "Ideal Buyer Profile", layoutData: { body: "The ideal acquirer is a licensed Ontario pharmacist. Daniel informally expressed interest in an equity stake approximately one year ago. A buyer who can structure equity roll-over, earn-in, or long-term incentive compensation will secure the LTC relationships." } },
    { id: "s3", sectionTitle: "Financial Overview", layoutData: { body: "Revenue of $9.1M in FY2024." } },
    { id: "s4", sectionTitle: "Key Personnel (regenerated)", layoutData: { people: [{ name: "Daniel Okafor", role: "LTC Lead Pharmacist (11 years)", note: "Primary contact for all 14 homes." }] } },
  ];
  const showing = sectionsShowingStaffPrivate(sections, info, items);
  assert.deepEqual(showing.map((s) => s.id), ["s1", "s2"]);
  assert.ok(showing.every((s) => s.descriptions.includes("Daniel Okafor's interest in an ownership stake")), JSON.stringify(showing));
  // Included by the broker → meant to be there, no longer flagged.
  const all = items.map((i) => ({ ...i, included: true }));
  assert.deepEqual(sectionsShowingStaffPrivate(sections, info, all), []);
  // One item included: a section stating exactly that passage is fine; one stating another held item is still named.
  const one = items.map((i) => ({ ...i, included: i.key === "keyEmployees" }));
  const regenerated = [
    { id: "r1", sectionTitle: "Key Personnel", layoutData: { body: "Daniel Okafor: LTC lead pharmacist since 2014 (11 years), primary contact for long-term care homes, knows all resident med lists, approximately 1 year ago informally asked about buying equity stake." } },
    { id: "r2", sectionTitle: "Transition", layoutData: { body: "Daniel Okafor leads LTC. Seller believes buyer-offered equity roll-over or earn-in would secure his long-term commitment." } },
  ];
  assert.deepEqual(sectionsShowingStaffPrivate(regenerated, info, one).map((s) => s.id), ["r2"]);
  console.log("✓ sections still stating a held matter are named for regeneration; an included matter isn't flagged");
}
