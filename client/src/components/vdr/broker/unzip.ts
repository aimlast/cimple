/**
 * Unpacking a .zip the broker drops into the data room (vdr spec §18 P2) —
 * IN THE BROKER'S BROWSER, so a zip never reaches the server: every file
 * inside goes through the normal upload (the same type allowlist, size limit
 * and checks), into folders named after the zip's own folders.
 *
 * Limits (spec): ≤ 300 files, ≤ 500 MB unpacked in all, ≤ 20 MB per file,
 * no zips inside the zip, the same file types, safe paths only ("..",
 * absolute paths and hidden/system files are skipped with a plain reason).
 * A file is inflated with a running count and dropped the moment it passes
 * 20 MB, whatever its header claims (a "zip bomb" can't fill the browser).
 */
import { VDR_LIMITS, extensionOf } from "@shared/vdr";

export const ZIP_LIMITS = { files: 300, totalBytes: 500 * 1024 * 1024, fileBytes: VDR_LIMITS.uploadBytes };

export type UnzippedEntry = { file: File; dirs: string[] };
export type UnzipResult = { entries: UnzippedEntry[]; skipped: Array<{ name: string; reason: string }> } | { error: string };

const MIME: Record<string, string> = {
  ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xls": "application/vnd.ms-excel", ".csv": "text/csv",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".doc": "application/msword",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation", ".ppt": "application/vnd.ms-powerpoint",
  ".txt": "text/plain", ".md": "text/markdown",
};

/** A zip entry's path → safe folder names + file name, or why it's skipped. */
export function safeZipPath(raw: string): { dirs: string[]; name: string } | { skip: string } {
  const parts = raw.replace(/\\/g, "/").split("/");
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) return { skip: "Its path inside the zip isn't safe." };
  const clean = parts.filter((p) => p !== "" && p !== ".");
  if (clean.some((p) => p === "..")) return { skip: "Its path inside the zip isn't safe." };
  if (clean.length === 0) return { skip: "No file name." };
  if (clean[0] === "__MACOSX" || clean.some((p) => p.startsWith("."))) return { skip: "A system file (skipped)." };
  const name = clean[clean.length - 1].replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200);
  const dirs = clean.slice(0, -1).map((d) => d.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, VDR_LIMITS.folderName)).filter(Boolean);
  return { dirs, name };
}

function typeRefusal(name: string): string | null {
  const ext = extensionOf(name);
  if (ext === ".zip") return "A zip inside the zip: unzip it first.";
  if (ext === ".heic" || ext === ".heif") return ".heic (iPhone photo): share it as a JPEG.";
  if (!VDR_LIMITS.uploadExtensions.includes(ext)) return `${ext || "These"} files can't go in the data room.`;
  return null;
}

/** Inflates one entry, stopping the moment it passes `cap` bytes. */
async function inflateCapped(entry: any, cap: number): Promise<Uint8Array | null> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let n = 0;
    let done = false;
    const stream = entry.internalStream("uint8array");
    stream
      .on("data", (c: Uint8Array) => {
        if (done) return;
        n += c.length;
        if (n > cap) { done = true; stream.pause(); resolve(null); return; }
        chunks.push(c);
      })
      .on("error", (e: unknown) => { if (!done) { done = true; reject(e); } })
      .on("end", () => {
        if (done) return;
        done = true;
        const out = new Uint8Array(n);
        let at = 0;
        for (const c of chunks) { out.set(c, at); at += c.length; }
        resolve(out);
      })
      .resume();
  });
}

/** Unpacks a zip into upload entries under a folder named after the zip. */
export async function unzipEntries(zipFile: Blob & { name: string }, limits = ZIP_LIMITS): Promise<UnzipResult> {
  if (zipFile.size > limits.totalBytes) return { error: "This zip is larger than 500 MB. Split it into smaller zips." };
  const JSZip = (await import("jszip")).default;
  let zip: any;
  try {
    zip = await JSZip.loadAsync(zipFile);
  } catch {
    return { error: "This zip couldn't be opened. It may be damaged or password-protected." };
  }
  const files = Object.values(zip.files as Record<string, any>).filter((f) => !f.dir);
  if (files.length > limits.files) return { error: `This zip has more than ${limits.files} files. Split it, or unzip it and drop the folder.` };
  const declared = files.reduce((s, f) => s + (Number(f?._data?.uncompressedSize) || 0), 0);
  if (declared > limits.totalBytes) return { error: "This zip unpacks to more than 500 MB. Split it into smaller zips." };
  const top = zipFile.name.replace(/\.zip$/i, "").trim().slice(0, VDR_LIMITS.folderName) || "Unzipped";
  const entries: UnzippedEntry[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  let total = 0;
  for (const f of files) {
    // jszip already resolves "../" on load; the name as written in the zip decides (a zip-slip path is skipped, not flattened).
    const p = safeZipPath(String(f.unsafeOriginalName ?? f.name));
    if ("skip" in p) {
      if (p.skip !== "A system file (skipped).") skipped.push({ name: String(f.name).slice(0, 200), reason: p.skip });
      continue;
    }
    const shown = [...p.dirs, p.name].join("/");
    const refusal = typeRefusal(p.name);
    if (refusal) { skipped.push({ name: shown, reason: refusal }); continue; }
    if ((Number(f?._data?.uncompressedSize) || 0) > limits.fileBytes) { skipped.push({ name: shown, reason: "Too large (over 20 MB). Save a smaller copy or split it." }); continue; }
    let bytes: Uint8Array | null;
    try {
      bytes = await inflateCapped(f, limits.fileBytes);
    } catch {
      skipped.push({ name: shown, reason: "It couldn't be unpacked." });
      continue;
    }
    if (!bytes) { skipped.push({ name: shown, reason: "Too large (over 20 MB). Save a smaller copy or split it." }); continue; }
    total += bytes.length;
    if (total > limits.totalBytes) return { error: "This zip unpacks to more than 500 MB. Split it into smaller zips." };
    const file = new File([bytes], p.name, { type: MIME[extensionOf(p.name)] ?? "application/octet-stream" });
    entries.push({ file, dirs: [top, ...p.dirs] });
  }
  return { entries, skipped };
}
