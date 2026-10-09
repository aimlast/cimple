/**
 * The interview's optional block for questions about the numbers (stream dd,
 * spec §6, INTEGRATION §2.12). No AI, no DB.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/interview/explain-block.test.ts
 *
 * Proves: the block renders on its own, after the conflicts, with the
 * capture keys and the statements' figures, and with no add-back / SDE /
 * EBITDA wording; the system prompt gains NO "MANDATORY … discrepanc" line
 * when only explain questions are routed (the count of MANDATORY lines is
 * unchanged); completionBlockers takes nothing from them (a session with
 * only explain questions can end normally).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assembleKnowledgeBase, renderExplainRequests, renderKnowledgeBaseForPrompt } from "../../server/interview/knowledge-base";
import { completionBlockers } from "../../server/interview/completion-gaps";
import type { ExplainRequest } from "../../server/cim/figures/requests";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}`); throw e; }
}

const deal: any = {
  id: "d1", brokerId: "b1", businessName: "Pacific Coast Logistics Ltd.", industry: "Transportation", subIndustry: "Trucking", location: "Delta, BC",
  description: null, questionnaireData: null, operationalSystems: null, employeeChart: null, scrapedData: null, scrapeSource: null,
  sellerProfile: null, sectionImportance: null, interviewOutline: null, interviewPlan: null, askingPrice: null, extractedInfo: {}, interviewSourceReview: null,
};
const requests: ExplainRequest[] = [
  { captureKey: "reasonFuelChange2023", kind: "movement", line: "fuel", year: "2023", fromYear: "2022", from: 5420000, value: 4760000 },
  { captureKey: "reasonBadDebtsChange2023", kind: "movement", line: "bad debts", year: "2023", fromYear: "2022", from: 35000, value: 61000 },
  { captureKey: "reasonInterestDifference2022", kind: "difference", line: "interest", year: "2022", statements: 268000, other: 301000, otherKind: "tax return" },
  { captureKey: "reasonPortDrayageChange2024", kind: "movement", line: "Port of Vancouver container drayage", year: "2024" },
];

console.log("the explain block");
await test("renders its own optional block with the capture keys and the statements' figures", () => {
  const block = renderExplainRequests(requests);
  assert.match(block, /^## THE BROKER WOULD LIKE THE STORY BEHIND THESE NUMBERS \(optional — never hold the interview open for these\)/);
  assert.match(block, /- reasonFuelChange2023: fuel \$5,420,000 \(2022\) → \$4,760,000 \(2023\), from the financial statements/);
  assert.match(block, /- reasonBadDebtsChange2023: bad debts \$35,000 \(2022\) → \$61,000 \(2023\), from the financial statements/);
  assert.match(block, /- reasonInterestDifference2022: interest for 2022 — the financial statements show \$268,000 and the tax return shows \$301,000/);
  assert.match(block, /- reasonPortDrayageChange2024: what drove the change in Port of Vancouver container drayage in 2024/);
  assert.match(block, /never mention add-backs, SDE, EBITDA/);
  // Only that one prohibition line mentions them — nothing else frames these as earnings work.
  const lines = block.split("\n").filter((l) => /add-back|addback|\bSDE\b|EBITDA|normali[sz]/i.test(l));
  assert.equal(lines.length, 1);
  assert.ok(!/MANDATORY|discrepanc|problem/i.test(block.replace(/never call it a problem or a discrepancy/, "")));
  assert.equal(renderExplainRequests([]), "");
});

await test("in the knowledge base it comes after the conflicts block, never inside the PRIORITY one", () => {
  const kb = assembleKnowledgeBase(deal, [], [], null, []);
  kb.sourceConflicts = [{ key: "employeeCount", critical: false, values: [{ value: "41", source: "a call" }, { value: "38", source: "the payroll" }] }] as any;
  kb.explainRequests = requests;
  const text = renderKnowledgeBaseForPrompt(kb);
  const iConflicts = text.indexOf("CONFLICTS TO RECONCILE");
  const iExplain = text.indexOf("THE BROKER WOULD LIKE THE STORY BEHIND THESE NUMBERS");
  assert.ok(iConflicts >= 0 && iExplain > iConflicts, "after the conflicts");
  assert.ok(!text.includes("PRIORITY: DISCREPANCIES"), "explain questions are never routed discrepancies");
  const none = assembleKnowledgeBase(deal, [], [], null, []);
  assert.ok(!renderKnowledgeBaseForPrompt(none).includes("STORY BEHIND THESE NUMBERS"));
});

console.log("never MANDATORY, never a blocker");
await test("system-prompt.ts counts only routed discrepancies for its MANDATORY line (source)", () => {
  const src = readFileSync("server/interview/system-prompt.ts", "utf8");
  assert.match(src, /const askSellerCount = \(kb\.askSellerDiscrepancies \?\? \[\]\)\.length;/);
  assert.ok(!/explainRequests/.test(src), "the system prompt never reads the explain questions");
  const mandatory = src.match(/MANDATORY/g) ?? [];
  assert.equal(mandatory.length, 1, "still exactly one MANDATORY directive, for routed discrepancies");
});

await test("completionBlockers takes no explain questions: a session with only those can end", () => {
  const kb = assembleKnowledgeBase(deal, [], [], null, []);
  kb.explainRequests = requests;
  const inputs = {
    sectionCoverage: [], criticalSections: new Set<string>(), info: {}, ledger: [], exchanges: [], conflicts: [], risks: [], onFileTopics: [],
  } as any;
  const without = completionBlockers(inputs);
  const withExplain = completionBlockers({ ...inputs, explainRequests: requests } as any);
  assert.deepEqual(withExplain, without);
  const src = readFileSync("server/interview/completion-gaps.ts", "utf8");
  assert.ok(!/explainRequests|cim_figure_questions/.test(src));
  const sm = readFileSync("server/interview/session-manager.ts", "utf8");
  // The block is set per turn and never fed to the wrap-up check.
  assert.ok(/kb\.explainRequests = await explainRequestsFor\(dealId, conductedBy\);/.test(sm));
  assert.ok(!/completionBlockers\(\{[^}]*explain/s.test(sm));
});

await test("the hand-back runs next to the routed discrepancies' (AI ending and manual ending)", () => {
  const sm = readFileSync("server/interview/session-manager.ts", "utf8");
  const n = sm.match(/markExplainQuestionsRaised\(dealId, sessionId,/g) ?? [];
  assert.equal(n.length, 2);
  assert.equal((sm.match(/scheduleFigureBuild\(dealId, "interview_answers"\)/g) ?? []).length, 2);
});

console.log(`\n${passed} passed`);
