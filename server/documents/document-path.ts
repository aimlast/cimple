/**
 * Where a documents row's file lives on disk — the one resolver every reader
 * uses (ingest, re-read, cleanup).
 *
 * `fileUrl` is server-owned: the upload route and createAndIngestSource are
 * its only writers, and both write `/uploads/docs/<generated name>`. Anything
 * else (a "..", an absolute path, a sub-folder, an encoded separator) is
 * refused, and the resolved path must still sit inside the docs folder — a
 * row pointing at "/uploads/../../../proc/self/environ" once let a re-read
 * copy the server's environment into a document's text.
 */
import path from "path";

export const DOCS_URL_PREFIX = "/uploads/docs/";

export function uploadsRoot(): string {
  return process.env.UPLOADS_DIR || path.join(process.cwd(), "public", "uploads");
}

/** The generated file name of a well-formed docs URL, or null. */
export function docsFileName(fileUrl: string | null | undefined): string | null {
  if (typeof fileUrl !== "string" || !fileUrl.startsWith(DOCS_URL_PREFIX)) return null;
  const name = fileUrl.slice(DOCS_URL_PREFIX.length);
  if (!name || name === "." || name === ".." || name.includes("..")) return null;
  if (/[\/\\\0%]/.test(name)) return null;
  return name;
}

/** Absolute path of a row's file under the uploads volume, or null. */
export function resolveDocumentPath(
  doc: { fileUrl?: string | null },
  root: string = uploadsRoot(),
): string | null {
  const name = docsFileName(doc.fileUrl);
  if (!name) return null;
  const docsDir = path.resolve(root, "docs");
  const abs = path.resolve(docsDir, name);
  if (!abs.startsWith(docsDir + path.sep)) return null;
  return abs;
}
