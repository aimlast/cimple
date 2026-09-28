/**
 * Final review (FREE round): the broker's notes from their own AI interview
 * session are not a broker edit, and the listed price never skips the Blind
 * identity check.
 *   F1 — the discrepancy check, the seller interview's source labels and the
 *        "broker = final" readers treat a session note as a claim (rank 4).
 *   F2 — a price typed in the broker's session is never the listed price
 *        buyers see, and never reaches the seller interview.
 *   F3 — the listed price is applied before the Blind guard; a price the
 *        broker typed as identifying words is never injected into the Blind CIM.
 *
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/final-broker-session-notes.test.ts
 */
import assert from "node:assert/strict";
import { buildDiscrepancyInput, type CheckDocument } from "../../server/cim/discrepancy-engine";
import { BROKER_SESSION_SOURCE_NOTE } from "../../server/interview/info-merger";
import { buildFactSourceLabels } from "../../server/interview/knowledge-base";
import { isBrokerSettledSource } from "../../server/interview/source-privacy";
import { sellerInterviewView } from "../../server/interview/seller-view";
import {
  listedAskingPrice,
  interviewFactView,
  isInterviewHiddenFact,
  reconcileMirroredFacts,
  columnPatchAfterChange,
} from "../../server/information/deal-mirror";
import { buildInformationView } from "../../server/information/view";
import { discrepancyForConflict } from "../../server/documents/merge-conflicts";
import { discrepancySideHeading, BROKER_SESSION_SIDE_LABEL } from "../../shared/discrepancy-sides";
import { buildBuyerCim } from "../../shared/cim-buyer-view";

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    throw err;
  }
}

const AT = "2026-09-26T10:00:00Z";
const session = { source: "broker", sessionId: "s-b", turn: 2, at: AT, note: BROKER_SESSION_SOURCE_NOTE };
const edit = { source: "broker", at: AT };
const doc = (o: Partial<CheckDocument> & { id: string }): CheckDocument =>
  ({ name: o.id, category: "hr", extractedText: "Payroll register: 16 employees on payroll.", extractedData: {}, sourceKind: "document", visibility: "shared", ...o }) as CheckDocument;

console.log("F1 — the broker's session notes are checked, not final");

// Scenario from the review: the payroll register says 16, the broker typed
// "about 12 staff" in their own session and it became the fact on file.
const payroll = doc({ id: "pay", name: "Payroll register 2025" });
const infoWith = (src: Record<string, unknown>) => ({
  employeeCount: "about 12 staff",
  _fieldSources: { employeeCount: src },
  _fieldAlternates: { employeeCount: [{ value: "16", source: "document", documentId: "pay", at: AT }] },
});

test("a broker-session value against a document is a conflict candidate (like the seller's)", () => {
  const input = buildDiscrepancyInput(infoWith(session), [payroll]);
  assert.equal(input.settled.length, 0, "nothing settled");
  assert.equal(input.candidates.length, 1, "the conflict is raised");
  assert.equal(input.candidates[0].factKey, "employeeCount");
  const ref = input.refs.find((r) => r.ref === input.candidates[0].claim.ref)!;
  assert.equal(ref.cls, "claim");
  assert.equal(ref.kind, "broker");
  assert.match(ref.label, /notes/i);
  assert.doesNotMatch(ref.label, /edit/i);
  // The same value from the seller interview — the same outcome.
  const seller = buildDiscrepancyInput(infoWith({ source: "interview", sessionId: "s1", turn: 3, at: AT }), [payroll]);
  assert.equal(seller.candidates.length, 1);
});

test("a deliberate broker edit is still final (never a candidate)", () => {
  const input = buildDiscrepancyInput(infoWith(edit), [payroll]);
  assert.equal(input.candidates.length, 0);
  assert.deepEqual(input.settled.map((e) => e.key), ["employeeCount"]);
  assert.ok(input.refs.some((r) => r.cls === "settled" && r.label === "Broker edit"));
});

test("a session note and an edit on one deal get separate refs", () => {
  const input = buildDiscrepancyInput(
    {
      employeeCount: "about 12 staff",
      leaseExpiry: "2031",
      _fieldSources: { employeeCount: session, leaseExpiry: edit },
      _fieldAlternates: { employeeCount: [{ value: "16", source: "document", documentId: "pay", at: AT }] },
    },
    [payroll],
  );
  const kinds = input.refs.filter((r) => r.kind === "broker").map((r) => r.cls).sort();
  assert.deepEqual(kinds, ["claim", "settled"]);
  assert.equal(input.candidates.length, 1);
});

test("the seller interview is told to confirm a session note, not that the broker confirmed it", () => {
  const labels = buildFactSourceLabels({ employeeCount: "about 12 staff", _fieldSources: { employeeCount: session } }, [], undefined);
  assert.match(labels.employeeCount, /broker's notes/);
  assert.match(labels.employeeCount, /confirm with the seller/);
  assert.doesNotMatch(labels.employeeCount, /confirmed by the broker/);
  const edited = buildFactSourceLabels({ employeeCount: "14", _fieldSources: { employeeCount: edit } }, [], undefined);
  assert.equal(edited.employeeCount, "confirmed by the broker");
});

test("source-privacy: only a broker edit (or a system record) is settled", () => {
  assert.equal(isBrokerSettledSource(session as any), false);
  assert.equal(isBrokerSettledSource(edit as any), true);
});

test("the Information tab: a session note is not 'broker edited' and not 'confirmed'", () => {
  const deal: any = {
    id: "d",
    extractedInfo: { employeeCount: "about 12 staff", leaseExpiry: "2031", _fieldSources: { employeeCount: session, leaseExpiry: edit } },
    interviewPlan: null,
    interviewOutline: null,
  };
  const view = buildInformationView({ deal, documents: [], sessions: [] } as any);
  const facts = view.sections.flatMap((s: any) => s.facts);
  const note = facts.find((f: any) => f.key === "employeeCount");
  const ed = facts.find((f: any) => f.key === "leaseExpiry");
  assert.ok(note && ed);
  assert.equal(note.brokerEdited, false);
  assert.notEqual(note.confidence, "confirmed");
  assert.equal(ed.brokerEdited, true);
  assert.equal(ed.confidence, "confirmed");
});

test("a merge conflict names the session notes as notes, not 'your edit'", () => {
  const row = discrepancyForConflict(
    {
      factKey: "employeeCount",
      winner: { value: "about 12 staff", src: session as any },
      loser: { value: "16", src: { source: "document", documentId: "pay", at: AT } as any },
    } as any,
    () => "Payroll register 2025",
  );
  const sides = row.sideSources as any;
  const side = sides.interview?.kind === "broker" ? "interview" : "document";
  assert.equal(sides[side].label, BROKER_SESSION_SIDE_LABEL);
  assert.equal(discrepancySideHeading(row as any, side), "Your session notes said");
  assert.doesNotMatch(String(row.aiExplanation ?? ""), /your edit/);
  // A real broker edit keeps "Your edit".
  assert.equal(discrepancySideHeading({ sideSources: { interview: { kind: "broker" } } } as any, "interview"), "Your edit");
});

console.log("F2 — a price typed in the broker's session is not the listed price");

const sessionPriceInfo = () => ({
  askingPrice: "$4,200,000",
  _fieldSources: { askingPrice: { ...session } },
  _fieldAlternates: { askingPrice: [{ value: "$3,900,000", source: "interview", sessionId: "s1", turn: 9, at: AT }] },
});

test("listedAskingPrice ignores a session price (the deal column stands, or none)", () => {
  assert.equal(listedAskingPrice({ askingPrice: null, extractedInfo: sessionPriceInfo() } as any), null);
  assert.equal(listedAskingPrice({ askingPrice: "$3,750,000", extractedInfo: sessionPriceInfo() } as any), "$3,750,000");
  // A deliberate broker edit is still the listed price.
  assert.equal(
    listedAskingPrice({ askingPrice: null, extractedInfo: { askingPrice: "$4,000,000", _fieldSources: { askingPrice: edit } } } as any),
    "$4,000,000",
  );
});

test("a session price is never copied onto the deal row", () => {
  const info: Record<string, unknown> = sessionPriceInfo();
  const setBrokerFact = () => assert.fail("the session price must not be promoted to a broker fact without a column");
  const r = reconcileMirroredFacts({ askingPrice: null }, info, setBrokerFact);
  assert.deepEqual(r.columnPatch, {});
  const before = { askingPrice: "$3,900,000", _fieldSources: { askingPrice: { source: "interview", at: AT } } };
  assert.deepEqual(columnPatchAfterChange({ askingPrice: null }, before, sessionPriceInfo()), {});
});

test("the buyer's CIM never shows a session price as the asking price", () => {
  const info = sessionPriceInfo();
  const deal = { id: "d", businessName: "X Co", extractedInfo: info, askingPrice: null } as any;
  const cover: any = { id: "c", dealId: "d", sectionKey: "cover", sectionTitle: "Cover", order: 0, layoutType: "cover_page", isVisible: true,
    layoutData: { businessName: "X Co", askingPrice: "Contact broker" } };
  const metrics: any = { id: "m", dealId: "d", sectionKey: "k", sectionTitle: "Key numbers", order: 1, layoutType: "metric_grid", isVisible: true,
    layoutData: { metrics: [{ label: "Asking Price", value: "$3,900,000" }] } };
  const cim = buildBuyerCim({ deal, accessLevel: "loi", sections: [cover, metrics], overrides: [], askingPrice: listedAskingPrice(deal) });
  assert.equal((cim.sections[0].layoutData as any).askingPrice, "Contact broker");
  assert.equal((cim.sections[1].layoutData as any).metrics[0].value, "$3,900,000");
});

test("the seller interview never sees a price from the broker's session (or the deal row)", () => {
  const view = interviewFactView(sessionPriceInfo() as Record<string, unknown>);
  assert.equal(view.askingPrice, "$3,900,000", "the seller's own expectation is shown in its place");
  assert.equal((view._fieldSources as any).askingPrice.source, "interview");
  const seller = sellerInterviewView(sessionPriceInfo() as Record<string, unknown>, []);
  assert.equal(seller.askingPrice, "$3,900,000");
  // No seller-side value → nothing shown at all.
  const none = sellerInterviewView({ askingPrice: "$4,200,000", _fieldSources: { askingPrice: session } } as Record<string, unknown>, []);
  assert.equal(none.askingPrice, undefined);
  // (A price the broker typed on the Information tab reaches the interview
  // as before — tests/information/interview-price-view.test.ts.)
  const edited = sellerInterviewView({ askingPrice: "$4,000,000", _fieldSources: { askingPrice: edit } } as Record<string, unknown>, []);
  assert.equal(edited.askingPrice, "$4,000,000");
  assert.equal(isInterviewHiddenFact({ askingPrice: "$1", _fieldSources: { askingPrice: session } }, "askingPrice"), true);
  // Other broker facts still reach the interview (as the broker's).
  assert.equal(isInterviewHiddenFact({ employeeCount: "12", _fieldSources: { employeeCount: session } }, "employeeCount"), false);
});

console.log("F3 — the listed price goes through the Blind guard");

const blindDeal = { id: "d", businessName: "Harbourline Dental Group", blindCodename: "Project Tidewater", extractedInfo: { businessName: "Harbourline Dental Group" } } as any;
const coverSection: any = { id: "c1", dealId: "d", sectionKey: "cover", sectionTitle: "Cover", order: 0, layoutType: "cover_page", isVisible: true,
  layoutData: { businessName: "Harbourline Dental Group", askingPrice: "$2,000,000" }, blindStaleAt: null };
const coverOverride: any = { id: "o1", cimSectionId: "c1", mode: "blind", layoutData: { businessName: "Project Tidewater", askingPrice: "$2,000,000" }, contentOverride: null };

test("a Blind cover never receives a listed price that names the business", () => {
  const cim = buildBuyerCim({
    deal: blindDeal,
    accessLevel: "teaser",
    sections: [coverSection],
    overrides: [coverOverride],
    askingPrice: "$2.1M plus Harbourline Dental Group's building",
  });
  assert.equal(cim.sections.length, 1, "the cover is still served (its own redacted price)");
  assert.equal((cim.sections[0].layoutData as any).askingPrice, "$2,000,000");
  assert.ok(!JSON.stringify(cim.sections).includes("Harbourline"));
  assert.deepEqual(cim.leaked, []);
});

test("a plain listed price still reaches the Blind cover", () => {
  const cim = buildBuyerCim({ deal: blindDeal, accessLevel: "teaser", sections: [coverSection], overrides: [coverOverride], askingPrice: "2100000" });
  assert.equal((cim.sections[0].layoutData as any).askingPrice, "$2,100,000");
});

test("the Normal CIM uses the broker's text as written", () => {
  const cim = buildBuyerCim({ deal: blindDeal, accessLevel: "loi", sections: [coverSection], overrides: [], askingPrice: "$2.1M plus Harbourline Dental Group's building" });
  assert.equal((cim.sections[0].layoutData as any).askingPrice, "$2.1M plus Harbourline Dental Group's building");
});

test("the Blind guard sees the final values (the price is applied before the check)", () => {
  // A redacted metric grid whose price label is rewritten: what the guard
  // reads is the rewritten value (a placeholder price is held back, never served).
  const grid: any = { id: "g1", dealId: "d", sectionKey: "k", sectionTitle: "Key numbers", order: 1, layoutType: "metric_grid", isVisible: true,
    layoutData: { metrics: [{ label: "Asking Price", value: "$2,000,000" }] }, blindStaleAt: null };
  const gridOverride: any = { id: "o2", cimSectionId: "g1", mode: "blind", layoutData: { metrics: [{ label: "Asking Price", value: "$2,000,000" }] }, contentOverride: null };
  const cim = buildBuyerCim({ deal: blindDeal, accessLevel: "teaser", sections: [grid], overrides: [gridOverride], askingPrice: "$2,100,000 [Province/State] basis" });
  // The placeholder text is refused before injection — the section keeps its own price.
  assert.equal((cim.sections[0].layoutData as any).metrics[0].value, "$2,000,000");
});

console.log(`final-broker-session-notes: ${passed} passed`);
