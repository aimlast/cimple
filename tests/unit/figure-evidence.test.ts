/**
 * What the AI pass may cite (spec §9.4). No AI, no DB.
 *   npx tsx tests/unit/figure-evidence.test.ts
 *
 * Proves: a keep-out request made after the statement cuts the I-ref; a
 * retracted value drops the message; a broker-led exchange yields only the
 * seller's side; seller-side facts come first (reason keys before others);
 * broker-only / CRM material, the broker's own session notes and a broker's
 * spoken line never become evidence; a resolution note is internal; a
 * private-side or CRM-merge conflict is left out; the digest moves when the
 * evidence does.
 */
import assert from "node:assert/strict";
import { run, test } from "./helpers/figure-test";
import { buildFigureEvidence, type EvidenceInput } from "../../server/cim/figures/evidence";
import { screenCtxFor } from "../../server/cim/figures/guards";
import { BROKER_SESSION_SOURCE_NOTE } from "../../server/interview/info-merger";

const targets = [
  { line: "line:fuel" as const, lineLabel: "Fuel", year: "2023", fromYear: "2022" },
  { line: "line:facility-rent-warehouse" as const, lineLabel: "Facility rent — warehouse", year: "2023", fromYear: "2022" },
];

function input(over: Partial<EvidenceInput> = {}): EvidenceInput {
  const facts: Record<string, unknown> = {
    reasonFuelChange2023: "We signed a fixed-price diesel contract in March 2023 and fuel dropped. Northern Fuels gave us the best rate.",
    fuelSurchargePolicy: "We pass fuel surcharges through to customers weekly.",
    brokerTypedFuel: "Fuel fell because of hedging",
    _fieldSources: {
      reasonFuelChange2023: { source: "interview", sessionId: "s1", turn: 4, excerpt: "fixed-price diesel contract in March 2023" },
      fuelSurchargePolicy: { source: "call", documentId: "call1", speaker: "Harjit Grewal (owner)" },
      brokerTypedFuel: { source: "broker", note: BROKER_SESSION_SOURCE_NOTE },
    },
    ownerName: "Harjit Grewal",
    keyEmployees: "Daniel Okafor (dispatcher)",
  };
  return {
    targets,
    facts,
    sessions: [
      {
        id: "s1", mode: "seller", retracted: [{ key: "fuelSavings", value: "saved $900,000" }],
        messages: [
          { role: "ai", content: "What happened with fuel in 2023?" },
          { role: "user", content: "Fuel went down in 2023 after the diesel contract." },
          { role: "user", content: "Actually we saved $900,000 on fuel that year." },
          { role: "user", content: "The weather was nice." },
        ],
      },
      {
        id: "s2", mode: "broker_with_seller", retracted: [],
        messages: [{ role: "user", content: "Broker: So the warehouse lease is why rent went up in 2023?\nSeller: Yes, we moved into the new warehouse in October 2022." }],
      },
      {
        id: "s3", mode: "broker", retracted: [],
        messages: [{ role: "user", content: "Rent rose in 2023 because of the warehouse — my notes." }],
      },
    ],
    documents: [
      { id: "lease", name: "Warehouse lease", citable: true, transcript: false, text: "LEASE. The Commencement Date is October 1, 2022. The Tenant shall pay base rent for the warehouse premises." },
      { id: "crm", name: "CRM note", citable: false, transcript: false, text: "Warehouse rent 2023 — the owner told me in confidence it is a family deal." },
    ],
    discrepancies: [
      { id: "r1", field: "Fuel 2023", status: "resolved", interviewValue: "$4.7M", documentValue: "$4,760,000", brokerNotes: "Rounded in the interview; fuel 2023 is $4,760,000.", sellerResponse: null, resolvedValue: "$4,760,000", privateSide: false, crmMerge: false },
      { id: "r2", field: "Fuel 2023", status: "resolved", interviewValue: "x", documentValue: "y", brokerNotes: "From my CRM notes", privateSide: true, crmMerge: false },
      { id: "r3", field: "Fuel 2023", status: "open", interviewValue: "x", documentValue: "y", brokerNotes: null, privateSide: false, crmMerge: false },
    ],
    screen: screenCtxFor(facts),
    hints: ["Warehouse lease commenced October 1, 2022, explaining the increase in facility rent in 2023.", "Bank charges were stable."],
    ...over,
  };
}

test("seller-side facts first: the reason key leads; the broker's own typing never counts", () => {
  const ev = buildFigureEvidence(input());
  const refs = Array.from(ev.refs.values());
  assert.equal(refs[0].id, "I1");
  assert.equal(refs[0].meta.factKey, "reasonFuelChange2023");
  assert.match(refs[0].text, /fixed-price diesel contract/);
  assert.ok(refs.some((r) => r.meta.factKey === "fuelSurchargePolicy" && r.kind === "transcript"), "an owner's call fact about fuel is cited as a conversation");
  assert.ok(!refs.some((r) => r.meta.factKey === "brokerTypedFuel"), "the broker's own session notes are not the seller's words");
});

test("a retracted value drops the message; off-topic messages are not evidence", () => {
  const texts = Array.from(buildFigureEvidence(input()).refs.values()).map((r) => r.text);
  assert.ok(texts.some((t) => /Fuel went down in 2023/.test(t)));
  assert.ok(!texts.some((t) => /\$900,000/.test(t)), "retracted");
  assert.ok(!texts.some((t) => /weather/.test(t)));
});

test("a broker-led exchange yields only the seller's side; broker-alone sessions give nothing", () => {
  const refs = Array.from(buildFigureEvidence(input()).refs.values());
  const together = refs.find((r) => r.meta.sessionId === "s2")!;
  assert.ok(together, "the seller's side is kept");
  assert.equal(together.text, "Yes, we moved into the new warehouse in October 2022.");
  assert.equal(together.meta.spoken, true);
  assert.ok(!refs.some((r) => r.meta.sessionId === "s3"));
  assert.ok(!refs.some((r) => /Broker:/.test(r.text)));
});

test("a keep-out request made after the statement cuts it", () => {
  const base = input();
  const before = Array.from(buildFigureEvidence(base).refs.values());
  assert.ok(before.some((r) => /Northern Fuels/.test(r.text)), "before the request it is evidence");
  const facts = { ...base.facts, _sellerKeepOut: [{ detail: "The diesel contract with Northern Fuels", terms: ["Northern Fuels"], at: "2026-10-05", turn: 9 }] };
  const after = Array.from(buildFigureEvidence({ ...base, facts, screen: screenCtxFor(facts) }).refs.values());
  assert.ok(!after.some((r) => /Northern Fuels/i.test(r.text)), "every passage carrying the kept-out detail is cut or dropped");
  assert.ok(after.some((r) => /fixed-price diesel contract/.test(r.text)), "the rest of the answer stays");
});

test("documents: shared ones give passages; broker-only material never", () => {
  const refs = Array.from(buildFigureEvidence(input()).refs.values());
  const lease = refs.find((r) => r.meta.documentId === "lease");
  assert.ok(lease && lease.kind === "document" && /Commencement Date is October 1, 2022/.test(lease.text));
  assert.ok(!refs.some((r) => r.meta.documentId === "crm"));
});

test("settled conflicts: the resolution note is internal; private sides and open rows are left out", () => {
  const refs = Array.from(buildFigureEvidence(input()).refs.values()).filter((r) => r.kind === "discrepancy");
  assert.equal(refs.length, 1);
  assert.equal(refs[0].meta.discrepancyId, "r1");
  assert.equal(refs[0].meta.internal, true);
});

test("hints are never refs; staff names in a message drop it; the digest follows the evidence", () => {
  const base = input();
  const ev = buildFigureEvidence(base);
  assert.ok(ev.hints.some((h) => /Warehouse lease commenced/.test(h)));
  assert.ok(!Array.from(ev.refs.values()).some((r) => /explaining the increase/.test(r.text)));
  const withStaff = input({
    sessions: [{ id: "s9", mode: "seller", retracted: [], messages: [{ role: "user", content: "Daniel Okafor renegotiated fuel in 2023." }] }],
  });
  assert.ok(!Array.from(buildFigureEvidence(withStaff).refs.values()).some((r) => /Okafor/.test(r.text)));
  const changed = buildFigureEvidence(input({ documents: [] }));
  assert.notEqual(changed.digest, ev.digest);
  assert.equal(buildFigureEvidence(input()).digest, ev.digest, "stable for the same evidence");
});

await run("figure-evidence");
