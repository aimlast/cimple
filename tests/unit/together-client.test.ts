/**
 * Interview together — the board page's pure rules (no DOM, no fetch):
 *  - LineBuffer: page line numbers from 0, batches of ≤ 50, a failed send
 *    keeps the same numbers (the server de-duplicates the retry), up to
 *    10 minutes / 2,000 lines kept while the connection is lost;
 *  - microphone and recognition errors as listening states; Daily speaker
 *    ids; the silence watchdog;
 *  - the live row's one button is ✓ Answered (the checklist's is Add answer).
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/together-client.test.ts
 */
import assert from "node:assert/strict";
import {
  BATCH_MAX,
  LineBuffer,
  dailySpeaker,
  isSilent,
  listenStateForError,
  listenStateForRecognitionError,
} from "../../client/src/components/together/line-buffer";

let n = 0;
const ok = (name: string) => { n++; console.log("✓", name); };

{
  const b = new LineBuffer();
  const t0 = 1_000_000;
  const a = b.add({ speaker: "dg:0", text: " Hello ", source: "deepgram" }, t0);
  const c = b.add({ speaker: "dg:1", text: "Hi", source: "deepgram" }, t0 + 10);
  assert.equal(a.clientSeq, 0, "numbers start at 0 on every page load");
  assert.equal(c.clientSeq, 1);
  assert.equal(a.text, "Hello");
  const batch = b.take();
  assert.deepEqual(batch.map((x) => x.clientSeq), [0, 1]);
  assert.equal(b.take().length, 0, "lines being sent aren't taken twice");
  b.release([0, 1]);
  const retry = b.take();
  assert.deepEqual(retry.map((x) => x.clientSeq), [0, 1], "a failed send retries with the same numbers");
  b.ack([0]);
  b.release([1]);
  assert.equal(b.size, 1);
  b.ack([1]);
  assert.equal(b.size, 0);
  const big = new LineBuffer();
  for (let i = 0; i < 120; i++) big.add({ speaker: "dg:0", text: `line ${i}`, source: "deepgram" }, t0);
  assert.equal(big.take().length, BATCH_MAX, "at most 50 per request");
  ok("lines wait with their page numbers until the server has them; retries keep the numbers");
}
{
  const b = new LineBuffer({ maxAgeMs: 10 * 60_000, maxLines: 5 });
  const t0 = 5_000_000;
  for (let i = 0; i < 8; i++) b.add({ speaker: "dg:0", text: `l${i}`, source: "deepgram" }, t0);
  assert.equal(b.size, 5, "the cap keeps the newest");
  assert.equal(b.take()[0].text, "l3");
  const old = new LineBuffer();
  old.add({ speaker: "dg:0", text: "old", source: "deepgram" }, t0);
  assert.equal(old.prune(t0 + 10 * 60_000 + 1), 1, "older than 10 minutes is dropped");
  ok("offline: up to 10 minutes / 2,000 lines are kept");
}
{
  assert.equal(listenStateForError({ name: "NotAllowedError" }), "mic_blocked");
  assert.equal(listenStateForError({ name: "NotFoundError" }), "no_mic");
  assert.equal(listenStateForError(new Error("socket closed")), "stopped");
  assert.equal(listenStateForRecognitionError("not-allowed"), "mic_blocked");
  assert.equal(listenStateForRecognitionError("audio-capture"), "no_mic");
  assert.equal(listenStateForRecognitionError("no-speech"), null, "a pause isn't a problem");
  assert.equal(dailySpeaker(true, "abc"), "daily:local");
  assert.equal(dailySpeaker(false, "f00-ba9 /x"), "daily:f00-ba9x");
  assert.ok(isSilent(null, 0, 60_000));
  assert.ok(!isSilent(30_000, 0, 60_000));
  assert.ok(!isSilent(null, null, 999_999), "not listening yet");
  ok("microphone problems as plain states; Daily speaker ids; a minute of silence");
}

import("../../client/src/components/coverage/CoverageItemRow").then(({ primaryActionFor }) => {
  const base: any = { id: "seasonality:seasonality", sectionKey: "seasonality", label: "Busy and slow months", members: [{ key: "seasonality", label: "busy and slow months", writable: true }], readKeys: ["seasonality"], valueKey: null, critical: false, origin: "generic", status: "missing", reason: null, value: null, source: null, ask: "Which months?", why: "", marks: [] };
  assert.equal(primaryActionFor(base, "live"), "answered", "live: ✓ Answered");
  assert.equal(primaryActionFor({ ...base, status: "partial" }, "live"), "answered");
  assert.equal(primaryActionFor(base, "checklist"), "add", "checklist: Add answer (no conversation)");
  assert.equal(primaryActionFor({ ...base, status: "verify", reason: { code: "estimate" } }, "live"), "confirm");
  assert.equal(primaryActionFor({ ...base, members: [{ key: "sde", label: "SDE", writable: false }] }, "live"), null);
  ok("the live row's one button: ✓ Answered; verify → ✓ Confirm; the broker's own calculation → none");
  console.log(`\n${n} checks passed`);
}).catch((e) => { console.error(e); process.exit(1); });

// Release review UX-F12: one action label for "confirm" on every screen ("✓ Confirmed" read like a status on desktop; the phone said "Confirm").
import("../../client/src/components/coverage/CoverageItemRow").then(async ({ PRIMARY_LABEL }) => {
  const fs = await import("node:fs");
  assert.equal(PRIMARY_LABEL.confirm, "✓ Confirm");
  const live = fs.readFileSync(new URL("../../client/src/components/together/LivePanel.tsx", import.meta.url), "utf8");
  assert.ok(!live.includes("✓ Confirmed") && live.includes("{PRIMARY_LABEL.confirm}"), "the live panel uses the same label");
  console.log("UX-F12: one Confirm label — ok");
}).catch((e) => { console.error(e); process.exit(1); });
