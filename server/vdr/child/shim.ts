/**
 * pdf.js 5.4.296 calls `process.getBuiltinModule` (Node ≥ 20.16 / 22.3) while
 * it loads, to reach `require` for the canvas and `fs` for its fonts. On an
 * older Node 20 the call throws, pdf.js can't polyfill DOMMatrix/Path2D and
 * every render breaks. The render child installs this shim FIRST, before it
 * imports pdf.js (which it only ever imports dynamically, so the bundle can't
 * hoist it above the shim).
 *
 * Returns true when the shim was installed (the native function was missing).
 */
import { createRequire } from "node:module";

export function installGetBuiltinModuleShim(): boolean {
  const proc = process as unknown as { getBuiltinModule?: (id: string) => unknown };
  if (typeof proc.getBuiltinModule === "function") return false;
  const req = createRequire(import.meta.url);
  proc.getBuiltinModule = (id: string) => {
    const name = id.startsWith("node:") ? id : `node:${id}`;
    try {
      return req(name);
    } catch {
      return undefined; // the native function returns undefined for an unknown id
    }
  };
  return true;
}
