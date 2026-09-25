// Tracing facts collected before provenance existed — offline checks.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/information/infer-sources.test.ts
import assert from "node:assert/strict";
import { inferFieldSources, sameValue, numericValue } from "../../server/information/infer-sources";
import { buildInformationView } from "../../server/information/view";
import type { Deal, Document, InterviewSession } from "../../shared/schema";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`✓ ${name}`);
}

const doc = (id: string, extractedData: Record<string, unknown>, extra: Partial<Document> = {}): Document =>
  ({ id, dealId: "d1", name: `${id}.pdf`, extractedData, createdAt: new Date("2026-01-01"), sourceKind: "document", status: "processed", ...extra } as unknown as Document);
const session = (id: string, conf: Record<string, string>, userTurns: string[], startedAt = "2026-02-01"): InterviewSession =>
  ({
    id,
    dealId: "d1",
    status: "completed",
    startedAt: new Date(startedAt),
    lastActivityAt: new Date(startedAt),
    extractedInfo: { _confidenceLevels: conf },
    messages: userTurns.flatMap((t) => [{ role: "ai", content: "Question?" }, { role: "user", content: t }]),
  } as unknown as InterviewSession);

test("value comparison", () => {
  assert.equal(numericValue("$1,750,000"), 1750000);
  assert.equal(numericValue("1.75M"), 1750000);
  assert.ok(sameValue("$1,750,000", 1750000));
  assert.ok(sameValue("Kitchener, Ontario", "kitchener ontario"));
  assert.ok(!sameValue("Kitchener", "Waterloo"));
  assert.ok(!sameValue("", ""));
});

test("untracked facts are traced to interview / questionnaire / document / website, marked inferred", () => {
  const info = {
    annualRevenue: "$2,013,000",
    yearFounded: "2011",
    leaseSqft: "2,650 sq ft",
    businessDescription: "Family dental practice",
    ownerName: "Dr. Patel",
    mystery: "Something nobody wrote down",
  };
  const out = inferFieldSources({
    info,
    sources: {},
    factKeys: Object.keys(info),
    documents: [doc("lease", { leaseSqft: "2,650 sq ft" }), doc("pnl", { annualRevenue: 2013000 })],
    sessions: [session("s1", { yearFounded: "confirmed", ownerName: "confirmed" }, ["We opened in 2011 in Kitchener.", "I'm Dr. Patel."])],
    sessionKind: () => "interview",
    questionnaire: { questionnaireData: { yearFounded: "2011" } },
    scraped: { businessDescription: "Family dental practice" },
  });
  // Interview captured the key and the seller said it: interview wins over the questionnaire.
  assert.deepEqual(out.yearFounded, { source: "interview", sessionId: "s1", turn: 1, inferred: true });
  assert.equal(out.annualRevenue.source, "document");
  assert.equal(out.annualRevenue.documentId, "pnl");
  assert.equal(out.leaseSqft.documentId, "lease");
  assert.equal(out.businessDescription.source, "website");
  // Captured by the interview, value not in the seller's words: still the session.
  assert.equal(out.ownerName.sessionId, "s1");
  assert.ok(out.ownerName.inferred);
  assert.equal(out.mystery, undefined);
});

test("recorded sources are kept; interview facts without a session get linked, not marked inferred", () => {
  const info = { annualRevenue: "$2M", staffCount: "12" };
  const out = inferFieldSources({
    info,
    sources: { annualRevenue: { source: "broker", at: "2026-03-01" }, staffCount: { source: "interview" } },
    factKeys: Object.keys(info),
    documents: [],
    sessions: [session("s1", {}, ["hi"], "2026-01-01"), session("s2", { staffCount: "confirmed" }, ["we have 12 people"], "2026-02-01")],
    sessionKind: () => "interview",
    questionnaire: {},
    scraped: null,
  });
  assert.deepEqual(out.annualRevenue, { source: "broker", at: "2026-03-01" });
  assert.equal(out.staffCount.sessionId, "s2");
  assert.equal(out.staffCount.inferred, undefined);
  assert.equal(out.staffCount.sessionLinked, true);
});

test("maps are traced per year across documents", () => {
  const info = { revenueByYear: { "2023": "$1.75M", "2024": "$1.89M" } };
  const out = inferFieldSources({
    info,
    sources: {},
    factKeys: ["revenueByYear"],
    documents: [doc("a", { revenueByYear: { "2023": "1,750,000" } }), doc("b", { revenueByYear: { "2024": "$1,890,000" } })],
    sessions: [],
    sessionKind: () => "interview",
    questionnaire: {},
    scraped: null,
  });
  assert.equal(out.revenueByYear.documentId, "a");
  assert.deepEqual(out.revenueByYear.years, { "2023": "a", "2024": "b" });
});

test("view: per-source fact counts, inferred counts, earlier records", () => {
  const deal = {
    id: "d1",
    businessName: "X",
    extractedInfo: { annualRevenue: "$2,013,000", leaseSqft: "2,650 sq ft", mystery: "zzz qqq www" },
    questionnaireData: null,
    scrapedData: null,
  } as unknown as Deal;
  const v = buildInformationView({
    deal,
    documents: [doc("pnl", { annualRevenue: "2013000" }), doc("lease", { leaseSqft: "2650 sq ft" }), doc("empty", {})],
    sessions: [],
  });
  const by = Object.fromEntries(v.sources.map((s) => [s.id, s]));
  assert.equal(by.pnl.factCount, 1);
  assert.equal(by.pnl.inferredFactCount, 1);
  assert.equal(by.lease.factCount, 1);
  assert.equal(by.empty.factCount, 0);
  assert.equal(v.counts.document, 2);
  assert.equal(v.counts.unknown, 1);
  assert.equal(v.inferredFacts, 2);
  const facts = [...v.sections.flatMap((s) => s.facts), ...v.other];
  const rev = facts.find((f) => f.key === "annualRevenue")!;
  assert.equal(rev.source.inferred, true);
  assert.match(rev.source.label, /\(inferred\)$/);
});

test("a recorded interview fact is never linked to a session of another kind", () => {
  const info = { ownerName: "Dr. Patel", staffCount: "12" };
  const sessions = [session("call1", { ownerName: "confirmed", staffCount: "confirmed" }, ["I'm Dr. Patel, we have 12 people"])];
  const out = inferFieldSources({
    info,
    sources: { ownerName: { source: "interview" }, staffCount: { source: "call" } },
    factKeys: Object.keys(info),
    documents: [],
    sessions,
    sessionKind: () => "call",
    questionnaire: {},
    scraped: null,
  });
  // Only call sessions exist: the "interview" fact stays unlinked…
  assert.deepEqual(out.ownerName, { source: "interview" });
  // …while a recorded "call" fact is linked to the call session.
  assert.equal(out.staffCount.sessionId, "call1");
  assert.equal(out.staffCount.sessionLinked, true);

  // The view counts each fact under a row of its own kind.
  const deal = { id: "d1", businessName: "X", extractedInfo: { ...info, _fieldSources: { ownerName: { source: "interview" }, staffCount: { source: "call" } } }, questionnaireData: null, scrapedData: null } as unknown as Deal;
  const callSession = { ...sessions[0], extractedInfo: { _confidenceLevels: {}, _conductedBy: "broker_with_seller", _conductedVia: "person" } } as unknown as InterviewSession;
  const v = buildInformationView({ deal, documents: [], sessions: [callSession] });
  const by = Object.fromEntries(v.sources.map((s) => [s.id, s]));
  assert.equal(by["session:call1"].kind, "call");
  assert.equal(by["session:call1"].factCount, 1, "only the call fact is counted under the call session");
  assert.equal(by.interview.factCount, 1, "the interview fact is counted under the AI interview row");
  const facts = [...v.sections.flatMap((s) => s.facts), ...v.other];
  const owner = facts.find((f) => f.key === "ownerName")!;
  assert.equal(owner.source.kind, "interview");
  assert.equal(owner.source.sessionId, undefined);
});

test("a legacy call fact with no call session is listed under its own kind, not as an AI interview", () => {
  const info = { staffCount: "12", _fieldSources: { staffCount: { source: "video_call" } } };
  const deal = { id: "d1", businessName: "X", extractedInfo: info, questionnaireData: null, scrapedData: null } as unknown as Deal;
  const v = buildInformationView({ deal, documents: [], sessions: [session("ai1", {}, ["hello"])] });
  const by = Object.fromEntries(v.sources.map((s) => [s.id, s]));
  assert.equal(by.interview, undefined);
  assert.equal(by["legacy:video_call"].kind, "video_call");
  assert.equal(by["legacy:video_call"].factCount, 1);
});

test("a legacy fact traced to the questionnaire / a document keeps the interview's confidence label", () => {
  const deal = {
    id: "d1",
    businessName: "X",
    extractedInfo: { annualRevenue: "$2,013,000", leaseSqft: "2,650 sq ft", staffCount: "12" },
    questionnaireData: { annualRevenue: "$2,013,000" },
    scrapedData: null,
  } as unknown as Deal;
  const v = buildInformationView({
    deal,
    documents: [doc("lease", { leaseSqft: "2,650 sq ft" })],
    // In the confidence map, but the seller never said these values.
    sessions: [session("s1", { annualRevenue: "approximate", leaseSqft: "confirmed" }, ["hello there"])],
  });
  const facts = Object.fromEntries([...v.sections.flatMap((s) => s.facts), ...v.other].map((f) => [f.key, f]));
  assert.equal(facts.annualRevenue.source.kind, "questionnaire");
  assert.equal(facts.annualRevenue.source.inferred, true);
  assert.equal(facts.annualRevenue.confidence, "approximate");
  assert.equal(facts.leaseSqft.source.documentId, "lease");
  assert.equal(facts.leaseSqft.confidence, "confirmed");
  // Not in the map: a traced fact still reads as inferred.
  assert.equal(facts.staffCount.confidence, "inferred");
});

console.log(`\n${passed} checks passed`);
