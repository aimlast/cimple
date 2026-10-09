import fs from "node:fs/promises";
import path from "node:path";
import { VDR_RENDER_LIMITS } from "./limits";
import { ChildJobError } from "./errors";

/**
 * Reads a file the web process has already confined. The child still refuses
 * anything that isn't an absolute path to a regular file, or is over the cap.
 */
export async function readJobFile(file: unknown): Promise<Uint8Array> {
  if (typeof file !== "string" || !path.isAbsolute(file) || file.includes("\0")) {
    throw new ChildJobError("file_missing", "no usable file path");
  }
  let st;
  try {
    st = await fs.stat(file);
  } catch {
    throw new ChildJobError("file_missing", "the file isn't there");
  }
  if (!st.isFile()) throw new ChildJobError("file_missing", "not a file");
  if (st.size > VDR_RENDER_LIMITS.maxFileBytes) throw new ChildJobError("too_large", `${st.size} bytes`);
  return new Uint8Array(await fs.readFile(file));
}
