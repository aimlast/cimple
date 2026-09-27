/**
 * FREE round, stream "cim": a Ridgeline generation replayed with a scripted
 * model (no paid call) that writes exactly what the live acceptance run
 * wrote on 2026-09-26 — on the first write AND on the figure-check rewrite
 * (the live rewrite kept the untraced figures). Checks:
 *   known-1  the correct 4.2× adjusted-EBITDA multiple is not flagged;
 *   known-3  the untraced equipment figures ($1,633,000 / $806,000) never
 *            reach the saved section — the sentence is taken out and the
 *            broker is told;
 *   known-4  the financial summary copied from the analysis's reclassified
 *            lines says so in a footnote;
 *   F8       a section the model can't write becomes a HIDDEN placeholder.
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/f-cim-replay.test.ts
 */
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { buildCimFinancials } from "../../server/cim/cim-financials";
import { generateCimLayout, _setAnthropicForTests } from "../../server/cim/layout-engine";
import { CIM_FALLBACK_REASONING } from "../../shared/cim-layouts";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "cim");
const read = (f: string) => JSON.parse(fs.readFileSync(path.join(FIX, f), "utf8"));
const facts = read("ridgeline-acc-facts.json");
const analysis = read("ridgeline-acc-analysis.json");
const recorded: Array<{ sectionKey: string; sectionTitle: string; order: number; layoutType: string; layoutData: any; aiDraftContent: string | null }> = read("ridgeline-acc-sections.json");
const pick = ["Ridgeline Metal Fabrication Inc.", "Equipment & Assets", "Transaction Overview", "Historical Financial Performance", "Facility"];
const planned = recorded.filter((s) => pick.includes(s.sectionTitle));
assert.equal(planned.length, pick.length);
const FAILING = "Key Customer Relationships";

_setAnthropicForTests(
  {
    messages: {
      stream: (body: any) => ({
        finalMessage: async () => {
          if (body.tools[0].name === "cim_manifest") {
            const sections = [...planned, { sectionKey: "key_customers", sectionTitle: FAILING, layoutType: "callout_list" }];
            return { stop_reason: "tool_use", content: [{ type: "tool_use", name: "cim_manifest", input: { sections: sections.map((s, i) => ({ sectionKey: s.sectionKey, sectionTitle: s.sectionTitle, order: i + 1, layoutType: s.layoutType, tags: [], aiLayoutReasoning: "r", contentBrief: `${s.sectionTitle} brief` })) } }] };
          }
          const text = JSON.stringify(body.messages);
          // One planned section the model never manages to write.
          if (text.includes("(sectionKey: key_customers)")) return { stop_reason: "max_tokens", content: [] };
          const s = planned.find((p) => text.includes(`(sectionKey: ${p.sectionKey})`));
          if (!s) throw new Error("unplanned section");
          return { stop_reason: "tool_use", content: [{ type: "tool_use", name: "cim_section", input: { layoutData: s.layoutData, ...(s.aiDraftContent ? { aiDraftContent: s.aiDraftContent } : {}) } }] };
        },
      }),
    },
  },
  1,
);

const doc = await generateCimLayout({
  dealId: "d",
  businessName: "Ridgeline Metal Fabrication Inc.",
  industry: "Manufacturing",
  askingPrice: "$6,500,000",
  extractedInfo: facts,
  financials: buildCimFinancials(analysis, [analysis]),
  today: new Date("2026-09-26T12:00:00Z"),
});
_setAnthropicForTests(null);

const warnings = doc.warnings ?? [];
const byTitle = (t: string) => doc.sections.find((s) => s.sectionTitle === t)!;
let passed = 0;
const ok = (name: string) => { passed++; console.log(`  ✓ ${name}`); };

// known-1 — "3.8× FY2024 SDE of $1,717,000 and 4.2× FY2024 Adjusted EBITDA of $1,552,000" is right.
assert.ok(!warnings.some((w) => /4\.2× is not the CIM's multiple/.test(w)), warnings.join("\n"));
assert.ok(!(byTitle("Transaction Overview").figureWarnings ?? []).some((w) => /is not the CIM's multiple/.test(w)));
ok("known-1: the 4.2× adjusted-EBITDA multiple is not flagged");

// known-3 — the untraced equipment figures are taken out, not shipped.
const equip = byTitle("Equipment & Assets");
const equipText = JSON.stringify(equip.layoutData);
assert.ok(!equipText.includes("$1,633,000") && !equipText.includes("$806,000"), equipText.slice(0, 400));
assert.ok(equipText.includes("CNC plasma tables"), "the rest of the card stays");
assert.notEqual(equip.isVisible, false, "repaired, so still shown");
assert.ok(!(equip.figureWarnings ?? []).some((w) => /\$1,633,000|\$806,000/.test(w)));
assert.ok(warnings.some((w) => /^Taken out of "Equipment & Assets" because no source on file has the figure: .*\$1,633,000/.test(w)), warnings.join("\n"));
ok("known-3: untraced figures are taken out of the section, and the broker is told");

// known-4 — the reclassified statement lines say so.
const fin = byTitle("Historical Financial Performance");
const notes: string[] = (fin.layoutData as any).footnotes ?? [];
// Its operating expenses ($1,613,000) are the "incl. one-time items" line: the
// footnote says the crane rebuild is left out of cost of sales and counted in
// operating expenses — never "shown apart from … operating expenses", which
// contradicted the table and the writer's own footnote beside it.
assert.ok(
  notes.some((n) => /^Figures as reclassified in the financial analysis: cost of sales leaves out the one-time item Crane rebuild \(FY2024 \$64,000\), which is counted in operating expenses with the other one-time items/.test(n)),
  notes.join("\n"),
);
assert.ok(!notes.some((n) => /shown apart from cost of sales and operating expenses/.test(n)), notes.join("\n"));
assert.ok(notes.some((n) => /^Operating expenses for FY2024 include \$82,000 in one-time expenses/.test(n)), "the writer's own footnote stays");
assert.ok(notes.some((n) => /^Compiled financial statements \(CSRS 4200\).*, as reclassified in the financial analysis \(see note\)\.$/.test(n)), "the source line is qualified");
assert.equal(notes.filter((n) => /^Figures as reclassified/.test(n)).length, 1);
ok("known-4: the financial summary's footnote describes the lines it shows (crane rebuild out of cost of sales, into operating expenses)");

// F8 — the section the model couldn't write is a hidden placeholder.
const ph = byTitle(FAILING);
assert.equal(ph.aiLayoutReasoning, CIM_FALLBACK_REASONING);
assert.equal(ph.isVisible, false);
assert.ok(warnings.some((w) => /Section "Key Customer Relationships" could not be generated\. It was saved as a hidden placeholder/.test(w)));
ok("F8: an unwritten section is saved hidden, with a clear note");

console.log(`f-cim-replay: ${passed} passed`);
