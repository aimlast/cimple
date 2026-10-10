/**
 * vdr spec §18 (P2): a .zip dropped into the data room is unpacked in the
 * broker's browser and its files upload like a dropped folder. No server, no
 * database, no AI.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/vdr-unzip.test.ts
 *
 *  - files land under a folder named after the zip, keeping its folders
 *  - unsafe paths ("..", absolute), a zip inside the zip, unknown types and
 *    files over 20 MB are skipped with plain reasons; system files silently
 *  - a file whose header lies about its size is cut off at 20 MB (never inflated whole)
 *  - more than 300 files, or more than 500 MB, is refused as a whole
 */
import assert from "node:assert/strict";
import JSZip from "jszip";

const { unzipEntries, safeZipPath } = await import("../../client/src/components/vdr/broker/unzip");

async function zipOf(files: Record<string, Uint8Array | string>, name = "Northgate docs.zip"): Promise<File> {
  const z = new JSZip();
  for (const [p, v] of Object.entries(files)) z.file(p, v, { createFolders: false });
  const bytes = await z.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  return new File([bytes], name, { type: "application/zip" });
}

// Paths.
assert.deepEqual(safeZipPath("Tax/2023/T2.pdf"), { dirs: ["Tax", "2023"], name: "T2.pdf" });
assert.deepEqual(safeZipPath("a\\b\\c.pdf"), { dirs: ["a", "b"], name: "c.pdf" });
assert.ok("skip" in safeZipPath("../../etc/passwd.pdf"));
assert.ok("skip" in safeZipPath("/abs/x.pdf"));
assert.ok("skip" in safeZipPath("C:/x.pdf"));
assert.ok("skip" in safeZipPath("__MACOSX/._T2.pdf"));
assert.ok("skip" in safeZipPath("Tax/.DS_Store"));

// A normal zip with folders, plus the things that are skipped.
const zip = await zipOf({
  "Tax returns/T2 2023.pdf": "%PDF-1.4 t2",
  "Statements/FY2023.pdf": "%PDF-1.4 fs",
  "Customers.xlsx": "PK fake",
  "notes.exe": "MZ",
  "inner.zip": "PK",
  "__MACOSX/._x": "junk",
  ".DS_Store": "junk",
});
const r = await unzipEntries(zip);
assert.ok(!("error" in r), JSON.stringify(r));
if (!("error" in r)) {
  const got = r.entries.map((e) => [e.dirs.join("/"), e.file.name, e.file.type]).sort();
  assert.deepEqual(got, [
    ["Northgate docs", "Customers.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["Northgate docs/Statements", "FY2023.pdf", "application/pdf"],
    ["Northgate docs/Tax returns", "T2 2023.pdf", "application/pdf"],
  ]);
  const reasons = Object.fromEntries(r.skipped.map((s) => [s.name, s.reason]));
  assert.match(reasons["notes.exe"], /can't go in the data room/);
  assert.match(reasons["inner.zip"], /zip inside the zip/);
  assert.ok(!Object.keys(reasons).some((k) => /MACOSX|DS_Store/.test(k)), "system files are skipped silently");
  const t2 = r.entries.find((e) => e.file.name === "T2 2023.pdf")!;
  assert.equal(Buffer.from(await t2.file.arrayBuffer()).toString(), "%PDF-1.4 t2");
}

// Too large: declared over the cap, and a header that lies (actual bytes over the cap) — both cut off.
const big = new Uint8Array(3000).fill(65);
const small = await unzipEntries(await zipOf({ "big.pdf": big }), { files: 300, totalBytes: 10_000_000, fileBytes: 1000 });
assert.ok(!("error" in small), JSON.stringify(small));
if (!("error" in small)) {
  assert.equal(small.entries.length, 0);
  assert.match(small.skipped[0].reason, /Too large/);
}
// The headers claim 10 bytes (local header offset 22, central directory offset 24); the data inflates to 3,000.
const liarBytes = new Uint8Array(await (await zipOf({ "liar.pdf": big })).arrayBuffer());
const dv = new DataView(liarBytes.buffer);
dv.setUint32(22, 10, true);
for (let i = liarBytes.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x02014b50) { dv.setUint32(i + 24, 10, true); break; }
const lied = await unzipEntries(new File([liarBytes], "liar.zip"), { files: 300, totalBytes: 10_000_000, fileBytes: 1000 });
assert.ok(!("error" in lied), JSON.stringify(lied));
if (!("error" in lied)) {
  assert.equal(lied.entries.length, 0, "inflated with a running count, cut at the cap");
  assert.match(lied.skipped[0].reason, /Too large/);
}

// Too many files / too much in all → refused as a whole.
const many: Record<string, string> = {};
for (let i = 0; i < 6; i++) many[`f${i}.pdf`] = "%PDF";
const tooMany = await unzipEntries(await zipOf(many), { files: 5, totalBytes: 10_000_000, fileBytes: 1000 });
assert.ok("error" in tooMany && /more than 5 files/.test(tooMany.error));
const tooBig = await unzipEntries(await zipOf({ "a.pdf": big, "b.pdf": big }), { files: 300, totalBytes: 5000, fileBytes: 4000 });
assert.ok("error" in tooBig && /500 MB/.test(tooBig.error));
const broken = await unzipEntries(new File([new Uint8Array([1, 2, 3])], "broken.zip"));
assert.ok("error" in broken && /couldn't be opened/.test(broken.error));
console.log("vdr-unzip: ok");
