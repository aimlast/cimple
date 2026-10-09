/**
 * vdr spec §8 "Disk", §13: every data-room path is server-built and confined;
 * the two private folders are never served from /uploads in any spelling.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/vdr-paths.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyUploadsPath, PRIVATE_FOLDERS } from "../../server/security/uploads-gate";
import {
  cacheFile,
  cleanCopyPath,
  cleanCopyRelPath,
  newPrivateName,
  removeItemCache,
  resolveCleanCopy,
  servedFilePath,
  vdrCacheDir,
  vdrDealDirs,
  isSafeId,
  isForFile,
} from "../../server/vdr/files";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "vdr-paths-"));
const D = "3766a914-8500-4e2f-bb7f-85acfc2523f2";
const I = "f55ee52d-003d-49e6-bf1b-c46932c38c49";
const F = "0123456789abcdef";

// The uploads gate blocks both folders, however the path is spelled.
assert.ok(PRIVATE_FOLDERS.includes("private-vdr") && PRIVATE_FOLDERS.includes("private-vdr-cache"));
for (const p of [
  "/private-vdr/x/y.pdf", "//private-vdr/x/y.pdf", "/%70rivate-vdr/x/y.pdf", "/PRIVATE-VDR/x.pdf", "/./private-vdr/x.pdf", "/a/../private-vdr/x.pdf",
  "/private-vdr-cache/d/i/f/p1.webp", "//private-vdr-cache/d/i/f/p1.webp", "/%70rivate-vdr-cache/d/p1.webp", "/private-vdr%2Dcache/d/p1.webp", "/private-vdr-cache%2Fd%2Fp1.webp",
]) {
  assert.equal(classifyUploadsPath(p).kind, "blocked", p);
}
assert.equal(classifyUploadsPath("/private-vdr-cachex/a.png").kind, "public", "only the exact folder names");

// Ids and names are validated; nothing escapes its folder.
assert.equal(isSafeId(D), true);
for (const bad of ["..", "../x", "a/b", "a\\b", "", "x".repeat(65), "a\0b", "%2e%2e"]) assert.equal(isSafeId(bad), false, bad);
assert.equal(isForFile(F), true);
assert.equal(isForFile("../0123456789abc"), false);
assert.equal(isForFile("0123456789ABCDEF"), false);

const dir = vdrCacheDir(D, I, F, root)!;
assert.equal(dir, path.join(root, "private-vdr-cache", D, I, F));
assert.equal(vdrCacheDir("../x", I, F, root), null);
assert.equal(vdrCacheDir(D, "..", F, root), null);
assert.equal(vdrCacheDir(D, I, "../../etc", root), null);

assert.equal(cacheFile(dir, "p3.webp"), path.join(dir, "p3.webp"));
assert.equal(cacheFile(dir, "sheet-0-12.json"), path.join(dir, "sheet-0-12.json"));
for (const bad of ["../served.pdf", "p0.webp", "p1.png", "served.pdf/../../x", "doc.html.bak", "masks.json\0", "..", "/etc/passwd"]) {
  assert.equal(cacheFile(dir, bad), null, bad);
}

const name = newPrivateName(".PDF");
assert.match(name, /^[a-f0-9]{32}\.pdf$/);
assert.match(newPrivateName(".tar.gz/../x"), /^[a-f0-9]{32}$/, "a strange extension is dropped");
const rel = cleanCopyRelPath(D, name)!;
assert.equal(rel, `private-vdr/${D}/${name}`);
assert.equal(cleanCopyPath(D, name, root), path.join(root, "private-vdr", D, name));
assert.equal(resolveCleanCopy(rel, D, root), path.join(root, "private-vdr", D, name));
assert.equal(resolveCleanCopy(rel, "another-deal", root), null, "another deal's clean copy is never served");
for (const bad of [`private-vdr/${D}/../../docs/doc_x.pdf`, `private-vdr/${D}/x.pdf`, `/abs/private-vdr/${D}/${name}`, `private-media/${D}/${name}`, `private-vdr/${D}/${name}/x`, `private-vdr/../${D}/${name}`]) {
  assert.equal(resolveCleanCopy(bad, D, root), null, bad);
}

// The served file: the cleaned copy when there is one, else the document's own (confined) file.
assert.equal(servedFilePath({ dealId: D, cleanCopyPath: rel }, { fileUrl: "/uploads/docs/doc_a.pdf" }, root), path.join(root, "private-vdr", D, name));
assert.equal(servedFilePath({ dealId: D, cleanCopyPath: null }, { fileUrl: "/uploads/docs/doc_a.pdf" }, root), path.join(root, "docs", "doc_a.pdf"));
assert.equal(servedFilePath({ dealId: D, cleanCopyPath: null }, { fileUrl: "/uploads/../../etc/passwd" }, root), null);
assert.equal(servedFilePath({ dealId: D, cleanCopyPath: "private-vdr/x/../../y" }, { fileUrl: "/uploads/docs/doc_a.pdf" }, root), null, "a bad clean-copy path is refused, never falls back silently");

// Pruning: other versions go, the current one stays; then the whole item.
const other = vdrCacheDir(D, I, "fedcba9876543210", root)!;
fs.mkdirSync(dir, { recursive: true });
fs.mkdirSync(other, { recursive: true });
fs.writeFileSync(path.join(dir, "p1.webp"), "a");
fs.writeFileSync(path.join(other, "p1.webp"), "b");
assert.equal(await removeItemCache(D, I, F, root), 1);
assert.ok(fs.existsSync(dir) && !fs.existsSync(other));
await removeItemCache(D, I, null, root);
assert.ok(!fs.existsSync(path.join(root, "private-vdr-cache", D, I)));
assert.equal(await removeItemCache("../..", I, null, root), 0);

// The deal's folders (removed with the deal).
assert.deepEqual(vdrDealDirs(D, root), [path.join(root, "private-vdr", D), path.join(root, "private-vdr-cache", D)]);
assert.deepEqual(vdrDealDirs("../../", root), []);

fs.rmSync(root, { recursive: true, force: true });
console.log("vdr paths: ok");
