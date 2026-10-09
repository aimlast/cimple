/**
 * The DD reveal pass (dd spec D15; stubbed model, no AI):
 *   - the prompt no longer asks for verification notes ("Do not add notes on
 *     how figures were checked; that is shown separately."); the reveal rules
 *     are unchanged (only names from the DD context, markers, hard rules);
 *   - P2 reveal gating: off by default (today's behaviour — every section goes
 *     to the model); on (DD_REVEAL_GATING=on), a section with nothing
 *     anonymised keeps its named version with NO model call, one with
 *     "Customer A" / "our largest customer" / "a national retailer" still goes;
 *   - on the Beacon fixture, gating would skip most sections (the saving).
 *   npx tsx tests/unit/dd-enrichment-prompt.test.ts
 */
import assert from "node:assert/strict";
import { fixture, run, test } from "./helpers/figure-test";
import {
  _setDdClientForTests, _setDdRevealGatingForTests, ddRevealGatingOn, enrichSection, holdsAnonymisedReferences, INTERNAL_WORDING,
} from "../../server/cim/dd-enrichment";

const origWarn = console.warn;
console.warn = () => {};

const sec = (id: string, body: string, layoutType = "prose_highlight") =>
  ({ id, dealId: "d", sectionKey: id, sectionTitle: `Section ${id}`, layoutType, layoutData: { body }, aiDraftContent: body, brokerEditedContent: null, ddStaleAt: null } as any);
const inputs = { context: "Customer A is Maplecrest Senior Living.", knownText: "Maplecrest Senior Living" };
const deal = { businessName: "Beacon Specialty Pharmacy Inc.", industry: "Pharmacy" };

let prompts: string[] = [];
const stub = {
  messages: {
    create: async (body: any) => {
      prompts.push(String(body.messages[0].content));
      return { stop_reason: "tool_use", content: [{ type: "tool_use", name: "dd_section", input: { layoutData: { body: "Revenue is concentrated with [[dd]]Maplecrest Senior Living[[/dd]]." }, contentOverride: "Revenue is concentrated with [[dd]]Maplecrest Senior Living[[/dd]]." } }] };
    },
  },
};

test("the prompt: no verification notes; the reveal rules are unchanged", async () => {
  _setDdClientForTests(stub);
  prompts = [];
  await enrichSection(sec("a", "Revenue is concentrated with Customer A."), inputs, deal);
  const p = prompts[0];
  assert.ok(p, "the model was called");
  assert.ok(p.includes("Do not add notes on how figures were checked; that is shown separately."));
  assert.ok(!/verification notes|how the figures were verified|add a short inline note/i.test(p), "never asks for verification prose");
  assert.ok(!/signed an LOI/.test(p));
  assert.ok(p.includes("ONLY names listed in the DD context below"));
  assert.ok(p.includes("MARK WHAT IS NEW"));
  assert.ok(p.includes("NEVER change, round, re-derive or remove any figure"));
  assert.ok(p.includes("Never describe how this document was prepared"));
  _setDdClientForTests(null);
});

test("the internal-wording guard still rejects process words", () => {
  assert.ok(INTERNAL_WORDING.test("per the broker, revenue grew"));
  assert.ok(INTERNAL_WORDING.test("confirmed facts show"));
});

test("anonymised references: what counts", () => {
  const yes = [
    "Revenue is concentrated with Customer A.",
    "Supplier 2 provides 40% of inventory.",
    "Our largest customer accounts for 31% of sales.",
    "The company supplies a national grocery retailer under a three-year agreement.",
    "Two regional long-term care operators make up most of the volume.",
    "The facility is leased from the landlord on a net basis.",
    "Top 5 customers",
    "An undisclosed institutional client",
  ];
  const no = [
    "Revenue grew 11% to $6,840,000 in FY2023.",
    "Customer service is handled by a team of six.",
    "The pharmacy dispenses compounded medications from its own lab.",
    "Account management software is cloud-based.",
  ];
  for (const t of yes) assert.ok(holdsAnonymisedReferences(sec("x", t)), t);
  for (const t of no) assert.ok(!holdsAnonymisedReferences(sec("x", t)), t);
  // Inside a table or chart label too.
  assert.ok(holdsAnonymisedReferences({ layoutData: { rows: [{ label: "Customer B", values: ["$1"] }] }, aiDraftContent: "", brokerEditedContent: null } as any));
});

test("gating is off by default: every section still goes to the model", async () => {
  _setDdRevealGatingForTests(null);
  const saved = process.env.DD_REVEAL_GATING;
  delete process.env.DD_REVEAL_GATING;
  assert.equal(ddRevealGatingOn(), false);
  _setDdClientForTests(stub);
  prompts = [];
  await enrichSection(sec("b", "Revenue grew 11% in FY2023."), inputs, deal);
  assert.equal(prompts.length, 1);
  process.env.DD_REVEAL_GATING = "on";
  assert.equal(ddRevealGatingOn(), true);
  if (saved === undefined) delete process.env.DD_REVEAL_GATING; else process.env.DD_REVEAL_GATING = saved;
  _setDdClientForTests(null);
});

test("gating on: nothing anonymised → named version kept, no model call; anonymised → model call", async () => {
  _setDdRevealGatingForTests(true);
  _setDdClientForTests(stub);
  prompts = [];
  const plain = sec("c", "Revenue grew 11% in FY2023.");
  const kept = await enrichSection(plain, inputs, deal);
  assert.equal(prompts.length, 0, "no model call");
  assert.deepEqual(kept.layoutData, plain.layoutData);
  assert.equal(kept.contentOverride, plain.aiDraftContent);
  assert.equal(kept.failed, undefined);
  assert.equal(kept.warning, undefined);
  const named = await enrichSection(sec("d", "Revenue is concentrated with Customer A."), inputs, deal);
  assert.equal(prompts.length, 1);
  assert.match(String((named.layoutData as any).body), /Maplecrest/);
  _setDdRevealGatingForTests(null);
  _setDdClientForTests(null);
});

test("on the Beacon fixture, gating sends only the sections that hold anonymised references", () => {
  const fx = fixture("beacon");
  const sections = fx.sections.filter((s) => !["cover_page", "divider"].includes(s.layoutType));
  const sent = sections.filter((s) => holdsAnonymisedReferences({ layoutData: s.layoutData, aiDraftContent: null, brokerEditedContent: null } as any));
  console.log(`    Beacon: ${sent.length} of ${sections.length} sections would go to the model (${sent.map((s) => s.sectionKey).join(", ")})`);
  assert.ok(sent.length < sections.length, "gating saves calls");
});

await run("dd-enrichment-prompt (D15)");
console.warn = origWarn;
