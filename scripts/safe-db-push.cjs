#!/usr/bin/env node
// `npm run db:push` — runs at every deploy AND every container restart (railway.toml startCommand:
// `npm run db:push && NODE_ENV=production exec node dist/index.js`).
//
// The plain `drizzle-kit push` makes the database equal to this build's schema. If the database has a
// table this build doesn't (another branch's new table), push DROPS it — silently when it is empty —
// and when it has rows push stops to ask a question, which in a non-interactive start is a crash, so
// the app never starts. This wrapper:
//   1. simulates the push READ-ONLY, with drizzle-kit's own code (scripts/safe-db-push/sim.cjs);
//   2. decides (scripts/safe-db-push/decide.cjs):
//        noop → prints "db:push: no changes"
//        push → every statement is purely additive and push asks nothing: runs the REAL
//               `drizzle-kit push` (non-interactive), then simulates again to verify nothing is left
//        skip → runs NOTHING and prints a loud warning listing exactly what was held back and why
//   3. always exits 0 so the app starts — unless SAFE_DB_PUSH_STRICT=1, which makes a failure to
//      check the schema exit 1 (the old behaviour: no start).
// The old behaviour stays available, deliberately, as `npm run db:push:raw`.
//
// Options: --dry-run (simulate + decide, never push). Env: DATABASE_URL (required),
// SAFE_DB_PUSH_STRICT=1, SAFE_DB_PUSH_TIMEOUT_MS (real push, default 45000),
// SAFE_DB_PUSH_SIM_TIMEOUT_MS (each simulation, default 40000).
"use strict";
const { spawn } = require("child_process");
const { decide, formatSkip, formatPush } = require("./safe-db-push/decide.cjs");

/** Remove anything that looks like a connection string (pg errors can echo host/user). */
function scrub(text, env) {
  let s = String(text == null ? "" : text);
  const url = env && env.DATABASE_URL;
  if (url) s = s.split(url).join("<DATABASE_URL>");
  return s.replace(/postgres(?:ql)?:\/\/[^\s"'`]+/gi, "<DATABASE_URL>");
}

function withTimeout(promise, ms, what) {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} took longer than ${ms} ms`)), ms); }),
  ]);
}

/** Run the real `drizzle-kit push`: no TTY (any question fails instead of waiting), no --force. */
function runRealPush({ binPath, env, timeoutMs, log, cwd }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [binPath, "push", "--verbose"], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const relay = (chunk) => {
      for (const line of scrub(chunk.toString(), env).split(/\r?\n/)) {
        const clean = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trimEnd();
        if (clean.trim()) log(`  drizzle-kit | ${clean}`);
      }
    };
    child.stdout.on("data", relay);
    child.stderr.on("data", relay);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000).unref();
    }, timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: null, error: e.message, timedOut }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, timedOut }); });
  });
}

/**
 * The whole flow, with its effects injected (tests pass fakes).
 * deps: { argv, env, log, warn, simulate(): Promise<sim>, push(sim): Promise<{code, timedOut?, error?}>,
 *         lock(): Promise<{release()} | null> }
 * Returns the exit code.
 */
async function run(deps) {
  const { argv = [], env = {}, log, warn } = deps;
  const strict = env.SAFE_DB_PUSH_STRICT === "1";
  const dryRun = argv.includes("--dry-run");
  const simMs = Number(env.SAFE_DB_PUSH_SIM_TIMEOUT_MS) || 40000;
  const fail = (what, e) => {
    warn(
      `db:push SKIPPED — could not ${what}: ${scrub(e && e.message ? e.message : e, env)}\n` +
        `Nothing was changed in the database. ${strict ? "SAFE_DB_PUSH_STRICT=1: failing the start." : "The app starts normally (set SAFE_DB_PUSH_STRICT=1 to fail the start instead)."}`,
    );
    return strict ? 1 : 0;
  };

  let lock = null;
  try {
    if (!dryRun && deps.lock) {
      try {
        lock = await withTimeout(deps.lock(), simMs, "taking the schema-change lock");
      } catch (e) {
        return fail("take the schema-change lock", e);
      }
      if (!lock) {
        warn("db:push SKIPPED — another schema change holds the lock (a db:push in another container, or a branch applying its tables). Nothing was changed; the app starts normally.");
        return 0;
      }
    }

    let sim;
    try {
      sim = await withTimeout(deps.simulate(), simMs, "checking the database schema");
    } catch (e) {
      return fail("check the database schema", e);
    }
    const result = decide(sim);

    if (result.action === "noop") {
      log("db:push: no changes");
      return 0;
    }
    if (result.action === "skip") {
      warn(formatSkip(result));
      return 0;
    }

    // push: only additive statements, no questions
    log(formatPush(result));
    if (dryRun) {
      log("db:push: --dry-run, so drizzle-kit push was NOT run.");
      return 0;
    }
    log("db:push: running drizzle-kit push (non-interactive)…");
    const res = await deps.push(sim);
    if (res.timedOut) warn(`db:push: drizzle-kit push took too long and was stopped.`);
    else if (res.error) warn(`db:push: drizzle-kit push could not start: ${scrub(res.error, env)}`);
    else if (res.code !== 0) warn(`db:push: drizzle-kit push exited with code ${res.code}.`);

    // verify: the simulation must now be clean
    let after;
    try {
      after = decide(await withTimeout(deps.simulate(), simMs, "re-checking the database schema"));
    } catch (e) {
      warn(`db:push: could not verify after the push: ${scrub(e && e.message ? e.message : e, env)}. The app starts normally.`);
      return 0;
    }
    if (after.action === "noop") {
      log("db:push: done — verified, the database now matches this build's schema.");
    } else {
      const left = [...after.additive.map((a) => `  + ${a.label}`), ...after.blocked.map((b) => `  ✗ ${b.label}: ${b.reason}`)];
      warn(`db:push: after the push, the database still differs from this build's schema:\n${left.join("\n")}\nThe app starts normally; check the drizzle-kit output above.`);
    }
    return 0;
  } catch (e) {
    return fail("finish", e);
  } finally {
    if (lock) await lock.release().catch(() => {});
  }
}

async function main() {
  const sim = require("./safe-db-push/sim.cjs");
  const env = process.env;
  const root = sim.REPO_ROOT;
  const log = (s) => process.stdout.write(s + "\n");
  const warn = (s) => process.stderr.write(s + "\n");
  const code = await run({
    argv: process.argv.slice(2),
    env,
    log,
    warn,
    simulate: () => sim.simulate({ root, connectionString: env.DATABASE_URL }),
    lock: () => sim.acquireLock(root, env.DATABASE_URL),
    push: (s) =>
      runRealPush({
        binPath: s.binPath,
        env,
        cwd: root,
        timeoutMs: Number(env.SAFE_DB_PUSH_TIMEOUT_MS) || 45000,
        log,
      }),
  });
  process.exit(code);
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`db:push SKIPPED — unexpected error: ${scrub(e && e.message ? e.message : e, process.env)}\nNothing was changed.\n`);
    process.exit(process.env.SAFE_DB_PUSH_STRICT === "1" ? 1 : 0);
  });
}

module.exports = { run, scrub, runRealPush };
