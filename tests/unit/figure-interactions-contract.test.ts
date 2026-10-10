/**
 * The reading-tracker contract for dd's two interactions (spec §11.4,
 * INTEGRATION §2.14) — analytics / heatmap merge their words on top.
 *   npx tsx tests/unit/figure-interactions-contract.test.ts
 *
 *   - `figure_note` (detail = the opaque figure id) and `figure_compare`
 *     (detail = side_by_side | cim_only) are in READING_INTERACTIONS, so the
 *     ingest accepts them — including on the DD check page and in a chart
 *     point inside a column (block keys the reading tracker already uses);
 *   - the Engagement tab's interaction lines use heatmap's §2.14 words; the
 *     journey moments skip types without a moment (nothing is invented);
 *   - `financial_view` keeps meaning As Reported / Normalized.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run, test } from "./helpers/figure-test";
import { READING_INTERACTIONS, readingPayloadSchema } from "../../shared/analytics-v2";
import { interactionLines } from "../../client/src/components/engagement/document/viewer-model";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const payload = (events: any[]) => ({
  visitId: "6f1c1e36-3f1a-4d7e-9a8e-0a1b2c3d4e5f",
  renditionId: "0123456789abcdef0123456789abcdef",
  sentAt: new Date().toISOString(),
  device: { w: 1440, h: 900, touch: false, dpr: 2 },
  visit: { wallMs: 1000, activeMs: 1000, idleMs: 0, hiddenMs: 0, awayMs: 0, outsideMs: 0, maxPageIndex: 3 },
  blocks: {},
  path: { from: 0, entries: [] },
  events,
});

test("both interactions are reading interactions", () => {
  assert.ok((READING_INTERACTIONS as readonly string[]).includes("figure_note"));
  assert.ok((READING_INTERACTIONS as readonly string[]).includes("figure_compare"));
});

test("the ingest accepts them where the CIM records them", () => {
  const at = new Date().toISOString();
  const r = readingPayloadSchema.safeParse(payload([
    { seq: 1, type: "figure_note", pageId: "8a6f6c2e-1b9d-4c3e-a2f7-5d4e3c2b1a09", blockKey: "row:3", detail: "f_0123456789", at },
    { seq: 2, type: "figure_note", pageId: "dd-source-check", blockKey: "row:0", detail: "f_abcdef0123", at },
    { seq: 3, type: "figure_note", pageId: "8a6f6c2e-1b9d-4c3e-a2f7-5d4e3c2b1a09", blockKey: "left/chart/point:3", detail: "f_abcdef0123", at },
    { seq: 4, type: "figure_note", pageId: "8a6f6c2e-1b9d-4c3e-a2f7-5d4e3c2b1a09", blockKey: "chart", detail: "f_abcdef0123", at },
    { seq: 5, type: "figure_compare", pageId: "8a6f6c2e-1b9d-4c3e-a2f7-5d4e3c2b1a09", detail: "side_by_side", at },
  ]));
  assert.ok(r.success, JSON.stringify(r.success ? null : r.error.issues.slice(0, 3)));
});

test("heatmap's words for them (INTEGRATION §2.14, wired at the dd merge); journeys still skip types without moments", () => {
  const lines = interactionLines({ figure_note: 4, figure_compare: 1, financial_view: 2 } as any);
  assert.deepEqual(lines.map((l) => l.type), ["figure_note", "financial_view", "figure_compare"]);
  assert.equal(lines.find((l) => l.type === "figure_note")!.text, "Opened notes on figures · 4 times");
  assert.equal(lines.find((l) => l.type === "figure_compare")!.text, "Compared the figures with the tax returns");
  assert.equal(interactionLines({ figure_note: 1 } as any)[0].text, "Opened a note on a figure");
  const insights = readFileSync(join(ROOT, "server/engagement/insights.ts"), "utf8");
  assert.match(insights, /const make = EVENT_MOMENT\[e\.type\];\s*if \(!make\) continue;/, "journeys skip types without words");
});

test("financial_view keeps meaning As Reported / Normalized; the compare switch never records it", () => {
  const table = readFileSync(join(ROOT, "client/src/components/cim/renderers/FinancialTable.tsx"), "utf8");
  assert.ok(!table.includes('"financial_view"'));
  const toggle = readFileSync(join(ROOT, "client/src/components/cim/FinancialToggle.tsx"), "utf8");
  assert.match(toggle, /interaction\("financial_view"/);
});

await run("figure-interactions (analytics / heatmap contract)");
