/**
 * Overview checklist step title — a finished step is never "Waiting on seller".
 * Server-rendered, no browser, no database.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/unit/overview-onboarding-badge.test.ts
 *
 * The bug (QA harvest 2026-09-26): "Seller onboarding" was struck through as
 * done and still carried the amber "Waiting on seller" badge.
 */
import "./react-global";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChecklistStepTitle, ActorBadge } from "../../client/src/components/deal/ChecklistStepTitle";

const html = (props: Parameters<typeof ChecklistStepTitle>[0]) => renderToStaticMarkup(React.createElement(ChecklistStepTitle, props));
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

// Seller onboarding, questionnaire received → struck through, no badge.
const done = html({ label: "Seller onboarding", done: true, who: "seller" });
assert.match(done, /line-through/);
assert.doesNotMatch(text(done), /Waiting on seller/);
assert.doesNotMatch(done, /actor-badge/);

// Still open → not struck through, badge shown.
const open = html({ label: "Seller onboarding", done: false, who: "seller" });
assert.doesNotMatch(open, /line-through/);
assert.match(text(open), /Seller onboarding Waiting on seller/);
assert.match(open, /data-testid="actor-badge-seller"/);

// Same rule for the broker's own steps and automatic ones, and "optional".
for (const who of ["broker", "auto"] as const) {
  assert.doesNotMatch(html({ label: "Send NDA", done: true, who, optional: true }), /actor-badge|optional/);
  const o = html({ label: "Send NDA", done: false, who, optional: true });
  assert.match(o, new RegExp(`actor-badge-${who}`));
  assert.match(text(o), /optional/);
}
assert.equal(text(renderToStaticMarkup(React.createElement(ActorBadge, { who: "broker" }))), "You");
assert.equal(text(renderToStaticMarkup(React.createElement(ActorBadge, { who: "auto" }))), "Automatic");

console.log("overview-onboarding-badge: all assertions passed");
