/**
 * What the analytics merge wires into the heat map's screens (integrator,
 * merge step 4; INTEGRATION §2.9, §2.14, C11 and analytics ship notes
 * integrator steps 2, 5 and 8):
 *   - "Opened a data-room document" in a part's interaction lines (vdr_open);
 *   - ONE reader rule: the Document view's "with reading recorded" uses the
 *     dashboards' hasReadCim (≥ 3 s active), not a copy of it;
 *   - ONE date rule: the buyer cards' "4 days ago / 23 Sept" and the visit
 *     list's day and time follow the broker's calendar (Toronto), never the
 *     browser's "Sep 24".
 * No database, no AI.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/analytics-heatmap-wiring.test.ts
 */
import "./react-global";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { READING_INTERACTIONS, READING_RULES } from "../../shared/analytics-v2";
import { dayMonth, hasReadCim, whenWords } from "../../shared/analytics-dashboard";
import { interactionLines } from "../../client/src/components/engagement/document/viewer-model";
import { agoText } from "../../client/src/components/engagement/buyers/parts";
import { withReading } from "../../server/engagement/responses";

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
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

test("vdr_open is a reading interaction with words on the heat map (§2.14)", () => {
  assert.ok((READING_INTERACTIONS as readonly string[]).includes("vdr_open"));
  assert.deepEqual(interactionLines({ vdr_open: 1 }).map((l) => l.text), ["Opened a data-room document"]);
  assert.deepEqual(interactionLines({ vdr_open: 3 }).map((l) => l.text), ["Opened data-room documents · 3 times"]);
});

test("one reader rule: the Document view's readers = hasReadCim (C11)", () => {
  const just = { visits: [{ activeMs: READING_RULES.readerMinMs }] };
  const short = { visits: [{ activeMs: READING_RULES.readerMinMs - 1 }, { activeMs: 0 }] };
  for (const b of [just, short, { visits: [] }]) assert.equal(withReading(b as never), hasReadCim(b), JSON.stringify(b));
  assert.match(read("../../server/engagement/responses.ts"), /export const withReading = \(b: BuyerReadingFacts\) => hasReadCim\(b\);/);
});

test("one date rule on the heat map's buyer cards (agoText = whenWords)", () => {
  const now = Date.parse("2026-10-09T16:00:00Z");
  for (const at of ["2026-10-09T15:59:30Z", "2026-10-09T15:20:00Z", "2026-10-09T09:00:00Z", "2026-10-08T12:00:00Z", "2026-10-05T12:00:00Z", "2026-09-24T03:30:00Z"]) {
    assert.equal(agoText(at, now), whenWords(at, now), at);
  }
  // 03:30 UTC on 24 Sept is still 23 Sept in Toronto — the date every other analytics screen shows.
  assert.equal(agoText("2026-09-24T03:30:00Z", now), "23 Sept");
  assert.equal(agoText("2026-09-24T03:30:00Z", now), dayMonth("2026-09-24T03:30:00Z"));
  assert.equal(agoText(null, now), "");
});

test("one date rule in the visit list (Toronto day and clock, labelled when the viewer's clock differs)", () => {
  const src = read("../../client/src/components/engagement/journey/JourneyDrawer.tsx");
  assert.match(src, /return `\$\{dayHeading\(iso\)\} · \$\{timeOfDay\(iso\)\}`;/);
  assert.doesNotMatch(src, /toLocaleString\(undefined/);
  assert.match(src, /brokerZoneLabel\(\)/);
  assert.match(src, /data-testid="journey-zone"/);
});

console.log(`\nanalytics-heatmap-wiring: ${passed} passed`);
