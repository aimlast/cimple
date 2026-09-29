// Staff-private matters across every path (founder decision 2026-09-28):
// the CIM writer's knowledge base, the DD context, the AI keep-out review,
// the broker's held-back list with its include switch, the interview and
// document extraction routing, and the CIM staleness fingerprint.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/staff-private-paths.test.ts
import assert from "node:assert/strict";
import { assembleKnowledgeBase } from "../../server/cim/layout-engine";
import { buildDdContext } from "../../server/cim/dd-enrichment";
import { keepOutFor, _setKeepOutModelForTests } from "../../server/cim/keep-out";
import { keepOutFromNotes, screenFactsForCim } from "../../server/cim/sensitive-facts";
import { heldPrivateItems } from "../../server/cim/held-private";
import { routeStaffPrivate, staffContextFrom, splitStaffPrivate, STAFF_PRIVATE_NOTE_REASON } from "../../server/cim/staff-private";
import { routeStaffPrivateToNotes } from "../../server/documents/extractor";
import { factsSnapshotOf } from "../../server/cim/cim-staleness";
import { classifyGenerationWarning } from "../../shared/cim-generation-warnings";
import { STAFF_PRIVATE_INCLUDED_KEY } from "../../shared/staff-private";

const BEACON: Record<string, unknown> = {
  businessName: "Beacon Specialty Pharmacy Inc.",
  ownerName: "Dr. Helen Park",
  ownership: "Dr. Helen Park 100% shareholder; no holding company",
  keyEmployees:
    "Daniel Okafor: LTC lead pharmacist since 2014 (11 years), primary contact for long-term care homes, knows all resident med lists, approximately 1 year ago informally asked about buying equity stake. Mei-Lin: compounding pharmacist since 2018, manages 340-formula library.",
  danielRetentionRisk: "Seller views losing Daniel as 'a real problem'; believes buyer-offered equity roll-over or earn-in would secure his long-term commitment.",
  danielEquityInterest: "Daniel raised equity stake interest again in spring 2024 around Maplecrest renewal. Helen declined but kept door open.",
  pharmacistRetention: "Mei-Lin Tran (compounding lead): settled; unlikely to leave. Farah Haddad: part-time (0.8 FTE) by choice; sounding out a hospital pharmacy role closer to home.",
  idealBuyer: "Buyer with capital and interest in Level C compounding expansion, capacity to add pharmacist headcount, and ability to structure management rollover/retention for Daniel.",
  annualRevenue: "$9,120,400",
};
const EQUITY = /equity|stake|buying|roll-?over|earn-in|door open|informally/i;

// 1. The writer's knowledge base (Normal CIM; the Blind CIM is redacted from its sections).
{
  const kb = assembleKnowledgeBase({ dealId: "d", businessName: "Beacon Specialty Pharmacy Inc.", industry: "Pharmacy", extractedInfo: BEACON, today: new Date("2026-09-28T12:00:00Z") });
  assert.ok(!EQUITY.test(kb.text), kb.text);
  assert.ok(kb.text.includes("Daniel Okafor: LTC lead pharmacist since 2014 (11 years), primary contact for long-term care homes, knows all resident med lists."), "the key-person fact stays");
  assert.ok(kb.warnings.some((w) => w.startsWith("Held back from the CIM: Daniel Okafor's interest in an ownership stake")), kb.warnings.join("\n"));
  assert.equal(classifyGenerationWarning(kb.warnings.find((w) => w.startsWith("Held back"))!).kind, "removed");
  assert.ok(kb.staffPrivate.length >= 4);
  // The writer is told never to build on one.
  console.log("✓ the CIM writer's knowledge base holds the equity matter out and warns the broker");
}

// 2. Earlier AI drafts (the founder's two live sentences) are screened too.
{
  const kb = assembleKnowledgeBase({
    dealId: "d",
    businessName: "Beacon Specialty Pharmacy Inc.",
    industry: "Pharmacy",
    extractedInfo: BEACON,
    cimContent: {
      keyPersonnel: "Daniel Okafor, LTC Lead Pharmacist (11 years). Asked about equity stake approximately one year ago; seller believes buyer-offered equity roll-over or earn-in would secure long-term commitment.",
      idealBuyerProfile: "Daniel informally expressed interest in an equity stake approximately one year ago. A buyer who can structure equity roll-over, earn-in, or long-term incentive compensation will secure the LTC relationships.",
    },
    today: new Date("2026-09-28T12:00:00Z"),
  });
  assert.ok(!EQUITY.test(kb.text), kb.text);
  console.log("✓ earlier drafts reach the writer without the equity sentences");
}

// 3. The DD writer's context.
{
  const dd = buildDdContext({ extractedInfo: BEACON });
  assert.ok(!EQUITY.test(dd.knownText), dd.knownText);
  console.log("✓ the due-diligence context holds it out too");
}

// 4. The AI review adds what the rules can't read, as an includable staff item.
{
  _setKeepOutModelForTests({
    messages: {
      create: async (req: any) => {
        const prompt = req.messages[0].content as string;
        assert.match(req.system, /STAFF-PRIVATE/);
        const holds: any[] = [];
        for (const line of prompt.split("\n")) {
          const m = /^(F\d+) \[pharmacistRetention\]: (.*)$/.exec(line);
          if (m && /sounding out/.test(m[2])) holds.push({ ref: m[1], parties: [], kind: "staff_private", staffTopic: "departure", reason: "a possible departure" });
        }
        return { content: [{ type: "tool_use", id: "x", name: "keep_out_review", input: { holds } }] };
      },
    },
  } as any);
  const ko = await keepOutFor("beacon-ai", BEACON);
  assert.equal(ko.by, "ai");
  assert.deepEqual(ko.names, [], "a staff matter never holds a party");
  assert.equal(ko.staff?.aiClauses.length, 1);
  const r = screenFactsForCim(Object.entries(BEACON) as Array<[string, unknown]>, ko);
  const safe = Object.fromEntries(r.safe) as Record<string, string>;
  assert.ok(!/sounding out/.test(safe.pharmacistRetention), safe.pharmacistRetention);
  assert.ok(safe.pharmacistRetention.includes("unlikely to leave"), "the rest of the fact stays");
  const aiItem = r.staffPrivate.find((i) => i.by === "ai");
  assert.ok(aiItem && aiItem.kind === "departure" && aiItem.description === "Farah Haddad's possible departure", JSON.stringify(r.staffPrivate));
  // The broker's list keeps showing it after the run (from cimGeneration.heldPrivate)…
  const listed = heldPrivateItems(BEACON, r.staffPrivate);
  assert.ok(listed.some((i) => i.id === aiItem!.id && i.by === "ai" && !i.included));
  // …and switching it on puts the words back into the inputs.
  const info = { ...BEACON, [STAFF_PRIVATE_INCLUDED_KEY]: [aiItem!.id] };
  const ko2 = await keepOutFor("beacon-ai", info);
  const again = Object.fromEntries(screenFactsForCim(Object.entries(info).filter(([k]) => !k.startsWith("_")) as Array<[string, unknown]>, ko2).safe) as Record<string, string>;
  assert.ok(/sounding out/.test(again.pharmacistRetention), "included → back in");
  _setKeepOutModelForTests(null);
  console.log("✓ the AI review holds a staff matter the rules miss; it is listed and includable");
}

// 5. The broker's list: every held item, with its include switch and the fact's label.
{
  const items = heldPrivateItems({ ...BEACON, [STAFF_PRIVATE_INCLUDED_KEY]: [] });
  assert.ok(items.length >= 4);
  assert.ok(items.every((i) => i.included === false && i.label && i.description));
  const first = items.find((i) => i.key === "keyEmployees")!;
  const withOne = heldPrivateItems({ ...BEACON, [STAFF_PRIVATE_INCLUDED_KEY]: [first.id] });
  assert.equal(withOne.find((i) => i.id === first.id)?.included, true, "an included item stays listed, switched on");
  assert.equal(withOne.length, items.length);
  // An AI item from the last run whose words are gone from the facts is not listed.
  const gone = heldPrivateItems(BEACON, [{ id: "spzzzzzz1", key: "pharmacistRetention", kind: "departure", text: "wants to open a competing store", description: "x", by: "ai" }]);
  assert.ok(!gone.some((i) => i.id === "spzzzzzz1"));
  console.log("✓ the held-back list shows every item with its switch; stale AI items drop off");
}

// 6. Upstream: the interview and document extraction keep the business part as the fact.
{
  const ctx = staffContextFrom(BEACON);
  const r = routeStaffPrivate("keyEmployees", "Daniel Okafor: LTC lead pharmacist, 11 years, key relationship holder, asked Helen about buying a stake last year", ctx);
  assert.equal(r.kept, "Daniel Okafor: LTC lead pharmacist, 11 years, key relationship holder");
  assert.deepEqual(r.notes, ["Daniel Okafor — asked Helen about buying a stake last year"]);
  assert.match(STAFF_PRIVATE_NOTE_REASON, /kept out of the CIM/);
  const clean = routeStaffPrivate("keyEmployees", "Daniel Okafor: LTC lead pharmacist, 11 years", ctx);
  assert.deepEqual(clean, { kept: "Daniel Okafor: LTC lead pharmacist, 11 years", notes: [] });

  const extraction: Record<string, unknown> = {
    ownerName: "Tom Reyes",
    keyEmployees: "Maria Lopez (shop foreman, 14 years); Kevin Tran (estimator) has been interviewing with a competitor",
    summary: "Seller call covering staff; Kevin may leave.",
    _privateNotes: ["Owner's wife diagnosed in 2024"],
  };
  routeStaffPrivateToNotes(extraction);
  assert.equal(extraction.keyEmployees, "Maria Lopez (shop foreman, 14 years)");
  assert.deepEqual(extraction._privateNotes, ["Owner's wife diagnosed in 2024", "Kevin Tran (estimator) has been interviewing with a competitor"]);
  assert.equal(extraction.summary, "Seller call covering staff; Kevin may leave.", "the source's own summary is left alone");
  console.log("✓ interview and extraction: private part → broker note, business part → fact");
}

// 7. Include switches mark the CIM stale — without disturbing CIMs written before them.
{
  const before = factsSnapshotOf({ annualRevenue: "$1" }, null).notesKey;
  const same = factsSnapshotOf({ annualRevenue: "$1", [STAFF_PRIVATE_INCLUDED_KEY]: [] }, null).notesKey;
  const changed = factsSnapshotOf({ annualRevenue: "$1", [STAFF_PRIVATE_INCLUDED_KEY]: ["spabc1234"] }, null).notesKey;
  assert.equal(before, same);
  assert.notEqual(before, changed);
  console.log("✓ an include switch flags the CIM for regeneration");
}

// 8. Precision on real demo facts (2026-09-28): these are business facts a buyer should read.
{
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ managementTeam: "Dr. Amrit Sandhu (owner, Clinical Director, PhD rehab science 2008)", reasonForSale: "Owner retiring from management role. Spouse Harjit also wants to retire (has done books since 2009)." }, "reasonForSale"],
    [{ managementTeam: "Dr. Amrit Sandhu (owner, Clinical Director, age 51, Master's physio 1999, PhD rehab science 2008)" }, "managementTeam"],
    [{ ownerName: "Gord McAllister", managementTeam: "Luis Ortega - operations manager and 15% shareholder, 21 years with company (hired 2004, foreman 2010, equity partner 2016), age 47, wants to stay post-sale and run shop as operations manager" }, "managementTeam"],
    [{ ownerName: "Gord McAllister", reasonForSale: "Owner retirement (seller age 64, daughter and grandchildren in Kelowna, BC, spouse Donna wants to relocate)" }, "reasonForSale"],
    [{ legalNotes: "Wrongful dismissal settlement 2024: dispatcher fired for cause, settled for $55K + ~$29K legal fees" }, "legalNotes"],
    [{ hygienistDetails: "Two hygienists: Priya (7 years tenure), Sam (2 years tenure). Neither has indicated plans to leave." }, "hygienistDetails"],
    [{ toolRoomSuccession: "Greg Tomczak (tool room manager, 61 years old) plans to retire in 2027. Leading internal candidate is Nate Szymanski." }, "toolRoomSuccession"],
    [{ acquisitionInterest: "Jackpine (competitor, 60+ employees) approached seller 2 years ago with offer around 3x earnings. Seller declined due to concern about shop closure and employee impact." }, "acquisitionInterest"],
    [{ staffingChallenges: "2024 agency recruitment cost $14,500 for pharmacist who left after 3 months; long-tenured core staff; no union" }, "staffingChallenges"],
  ];
  for (const [info, key] of cases) {
    const r = splitStaffPrivate(String(info[key]), staffContextFrom(info), { key });
    assert.deepEqual(r.held, [], `${key}: ${info[key]} → ${JSON.stringify(r.held)}`);
  }
  // …and these are staff-private.
  const held: Array<[Record<string, unknown>, string]> = [
    [{ keyRisks: "Larkspur vendor consolidation 2026; Devin flight risk; equipment replacement needs" }, "keyRisks"],
    [{ ownerName: "Tony Russo", daveEquityInterest: "Dave asked Tony about getting equity in the business, Tony told him it's up to new owner but would put in good word, Tony open to buyer giving Dave 5-10%" }, "daveEquityInterest"],
  ];
  for (const [info, key] of held) {
    const r = splitStaffPrivate(String(info[key]), staffContextFrom(info), { key });
    assert.ok(r.held.length > 0, `${key} should be held: ${info[key]}`);
  }
  const risks = splitStaffPrivate("Larkspur vendor consolidation 2026; Devin flight risk; equipment replacement needs", staffContextFrom({}), { key: "keyRisks" });
  assert.equal(risks.kept, "Larkspur vendor consolidation 2026; equipment replacement needs", "only the private part of a risk list goes");
  console.log("✓ precision on real demo facts: 9 buyer-facing facts pass, 2 staff matters held");
}

void keepOutFromNotes;
