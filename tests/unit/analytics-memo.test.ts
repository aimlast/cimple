/**
 * The dashboards' stale-while-revalidate memo (server/analytics-dashboard/memo.ts)
 * and the access fingerprint that drops a deal's cached facts on any
 * change to its links (load.ts).
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/analytics-memo.test.ts
 */
import assert from "node:assert/strict";
import { _memoSize, _resetMemo, _setMemoClock, dropMemo, swr } from "../../server/analytics-dashboard/memo";
import { _resetFingerprints, _setLoaderDeps, accessFingerprint, checkAccessFingerprints, type AccessRow } from "../../server/analytics-dashboard/load";
import { accessOf, ago } from "./fixtures/analytics-fixtures";

const tick = () => new Promise((r) => setTimeout(r, 0));

async function main() {
  let clock = 1_000_000;
  _setMemoClock(() => clock);
  const OPTS = { freshMs: 30_000, staleMs: 600_000 };

  // Fresh hit.
  _resetMemo();
  let loads = 0;
  const load = async () => ++loads;
  assert.equal(await swr("k", OPTS, load), 1);
  assert.equal(await swr("k", OPTS, load), 1, "fresh: no reload");
  assert.equal(loads, 1);

  // Stale: returned at once, refreshed once in the background.
  clock += 31_000;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const slow = async () => { await gate; return ++loads; };
  assert.equal(await swr("k", OPTS, slow), 1, "stale value returned at once (never waits)");
  assert.equal(await swr("k", OPTS, slow), 1, "a second stale call doesn't start another refresh");
  release();
  await gate; await tick(); await tick();
  assert.equal(loads, 2, "exactly one background refresh");
  assert.equal(await swr("k", OPTS, load), 2, "the refreshed value is now fresh");
  assert.equal(loads, 2);

  // Expired: awaited.
  clock += 700_000;
  assert.equal(await swr("k", OPTS, load), 3, "older than staleMs: loaded and awaited");

  // Concurrent misses share one load.
  _resetMemo();
  loads = 0;
  const [a, b, c] = await Promise.all([swr("m", OPTS, load), swr("m", OPTS, load), swr("m", OPTS, load)]);
  assert.deepEqual([a, b, c], [1, 1, 1]);
  assert.equal(loads, 1, "one load for three callers");

  // A version change (a reading flush) is stale-while-revalidate too.
  assert.equal(await swr("m", OPTS, load, 7), 1, "new version: the old value at once");
  await tick(); await tick();
  assert.equal(loads, 2, "and a background refresh");
  assert.equal(await swr("m", OPTS, load, 7), 2);

  // A failed load is never remembered.
  _resetMemo();
  await assert.rejects(swr("f", OPTS, async () => { throw new Error("boom"); }));
  assert.equal(_memoSize(), 0);
  assert.equal(await swr("f", OPTS, async () => 42), 42);

  // dropMemo by prefix.
  _resetMemo();
  await swr("f:d1", OPTS, load);
  await swr("d:d1|x", OPTS, load);
  await swr("f:d2", OPTS, load);
  dropMemo("f:d1");
  assert.equal(_memoSize(), 2);
  dropMemo("d:d1|");
  assert.equal(_memoSize(), 1);
  _setMemoClock(null);

  // ── Access fingerprints ──
  const invalidated: string[] = [];
  _setLoaderDeps({ invalidateFacts: (id) => invalidated.push(id) });
  _resetFingerprints();
  const base = (): AccessRow[] => [accessOf("d1", { id: "a", name: "Ann" }), accessOf("d1", { id: "b", name: "Ben" })];
  const other = [accessOf("d2", { id: "c", name: "Cy" })];
  const fpBase = accessFingerprint(base());
  assert.equal(accessFingerprint(base()), fpBase, "stable");
  checkAccessFingerprints(["d1", "d2"], [...base(), ...other]);
  assert.deepEqual(invalidated, [], "first sight: nothing to drop");

  const changes: Array<[string, (rows: AccessRow[]) => void]> = [
    ["revoke", (r) => { r[0].revokedAt = ago(0); }],
    ["extend", (r) => { r[0].expiresAt = ago(-30); }],
    ["level change", (r) => { r[0].accessLevel = "due_diligence"; }],
    ["decision", (r) => { r[0].decision = "interested"; r[0].decisionAt = ago(0); }],
    ["NDA", (r) => { r[1].ndaSignedAt = ago(0); }],
    ["a new access event", (r) => { r[1].accessEvents = [{ type: "contacted", at: ago(0).toISOString() }]; }],
    ["a new link", (r) => { r.push(accessOf("d1", { id: "new", name: "New" })); }],
  ];
  for (const [what, change] of changes) {
    _resetFingerprints();
    checkAccessFingerprints(["d1", "d2"], [...base(), ...other]);
    invalidated.length = 0;
    const rows = base();
    change(rows);
    assert.notEqual(accessFingerprint(rows), fpBase, `${what} changes the fingerprint`);
    const changed = checkAccessFingerprints(["d1", "d2"], [...rows, ...other]);
    assert.deepEqual(changed, ["d1"], `${what}: only that deal`);
    assert.deepEqual(invalidated, ["d1"], `${what}: its cached facts are dropped`);
    assert.deepEqual(checkAccessFingerprints(["d1", "d2"], [...rows, ...other]), [], `${what}: once`);
  }
  _setLoaderDeps(null);

  console.log("analytics-memo: all assertions passed");
}

main().catch((err) => { console.error(err); process.exit(1); });
