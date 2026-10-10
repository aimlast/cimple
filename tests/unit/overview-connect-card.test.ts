/**
 * Release review UX-F13 (the cheap part; the Overview's tabbed redesign is a
 * follow-up): "Connect your data sources … before the interview" showed on
 * live Phase-4 deals. It now shows only while information is being collected
 * (phases 1–2). Source check + the phase order it relies on. No DB, no AI.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/overview-connect-card.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { phaseIndex } from "../../shared/deal-progress";

const src = readFileSync(new URL("../../client/src/pages/broker/deal/OverviewTab.tsx", import.meta.url), "utf8");
const at = src.indexOf("<IntegrationPromptCard");
assert.ok(at > 0);
const before = src.slice(Math.max(0, at - 300), at);
assert.match(before, /currentPhaseIdx <= getPhaseIndex\("phase2_platform_intake"\) && \(/, "gated to phases 1–2");
assert.equal(phaseIndex("phase2_platform_intake"), 1);
assert.ok(phaseIndex("phase4_design_finalization") > phaseIndex("phase2_platform_intake"), "a Phase-4 deal never shows it");
assert.ok(phaseIndex("phase1_info_collection") < phaseIndex("phase2_platform_intake"));
console.log("overview-connect-card: ok");
