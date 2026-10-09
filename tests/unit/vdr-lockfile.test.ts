/**
 * vdr Wave 0: the render dependencies are exact-pinned, the lockfile carries
 * the LINUX native canvas binary (Railway builds on linux-x64 with glibc, from
 * a lockfile written on a Mac), and the build produces the render child as a
 * second esbuild entry without dropping any existing build step.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/vdr-lockfile.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
const lp = lock.packages as Record<string, any>;

// 1. The five render dependencies (+ the sanitize-html types) are exact versions, the same in the lockfile.
const RUNTIME = { "pdfjs-dist": "5.4.296", "@napi-rs/canvas": "0.1.80", "pdf-lib": "1.17.1", mammoth: "1.8.0", "sanitize-html": "2.13.1" };
for (const [name, version] of Object.entries(RUNTIME)) {
  assert.equal(pkg.dependencies[name], version, `${name} must be pinned exactly to ${version} in dependencies`);
  assert.equal(lp[`node_modules/${name}`]?.version, version, `lockfile: ${name}@${version}`);
  assert.ok(!lp[`node_modules/${name}`]?.dev, `${name} must not be a dev-only package (production needs it)`);
}
assert.equal(pkg.devDependencies["@types/sanitize-html"], "2.13.0");
assert.equal(lock.lockfileVersion, 3, "lockfile v3 records every platform's optional packages");

// 2. The Linux native canvas binary is recorded, with the fields npm needs to pick it on Railway.
const linux = lp["node_modules/@napi-rs/canvas-linux-x64-gnu"];
assert.ok(linux, "package-lock.json must list node_modules/@napi-rs/canvas-linux-x64-gnu");
assert.equal(linux.version, RUNTIME["@napi-rs/canvas"], "the Linux binary matches the canvas version");
assert.equal(linux.optional, true);
assert.deepEqual(linux.os, ["linux"]);
assert.deepEqual(linux.cpu, ["x64"]);
assert.deepEqual(linux.libc, ["glibc"]);
assert.match(linux.resolved, /^https:\/\/registry\.npmjs\.org\/@napi-rs\/canvas-linux-x64-gnu\/-\/canvas-linux-x64-gnu-0\.1\.80\.tgz$/);
assert.match(linux.integrity, /^sha512-/);
// The canvas package declares it (npm installs only what a parent asks for).
assert.equal(lp["node_modules/@napi-rs/canvas"].optionalDependencies["@napi-rs/canvas-linux-x64-gnu"], RUNTIME["@napi-rs/canvas"]);
// Every platform binary the canvas lists is in the lockfile (a Mac-written lockfile that dropped them would break Linux installs).
for (const dep of Object.keys(lp["node_modules/@napi-rs/canvas"].optionalDependencies)) {
  assert.ok(lp[`node_modules/${dep}`], `lockfile lists ${dep}`);
}
// pdf.js loads the SAME canvas (no second, nested copy with its own native binary).
assert.equal(lp["node_modules/pdfjs-dist"].optionalDependencies?.["@napi-rs/canvas"] !== undefined, true);
assert.ok(!lp["node_modules/pdfjs-dist/node_modules/@napi-rs/canvas"], "pdfjs-dist must use the top-level canvas");
// The other Linux natives Railway already relies on are still there.
for (const k of ["node_modules/@rollup/rollup-linux-x64-gnu", "node_modules/@esbuild/linux-x64", "node_modules/lightningcss-linux-x64-gnu"]) {
  assert.ok(lp[k], `lockfile still lists ${k}`);
}

// 3. The build: the render child is a second esbuild entry; every earlier step is kept.
const build: string = pkg.scripts.build;
assert.ok(build.startsWith("vite build && "), "vite build first");
assert.match(build, /esbuild server\/index\.ts server\/vdr\/render-child\.ts --platform=node --packages=external --bundle --format=esm --outdir=dist/);
assert.ok(build.includes("cp -r server/interview/prompts dist/prompts"), "prompts are still copied");
assert.ok(build.includes("cp server/interview/config/agent-config.json dist/agent-config.json"), "agent config is still copied");
assert.ok(!/--splitting/.test(build), "no code splitting: each entry is one self-contained file");
assert.equal(pkg.scripts.start, "NODE_ENV=production node dist/index.js", "start unchanged");

// 4. railway.toml is untouched by this change (install + build + start commands).
const railway = fs.readFileSync(path.join(root, "railway.toml"), "utf8");
assert.ok(railway.includes('buildCommand = "npm install --include=dev && npm run build"'));
assert.ok(railway.includes('startCommand = "npm run db:push && NODE_ENV=production exec node dist/index.js"'));

console.log("vdr lockfile: ok");
