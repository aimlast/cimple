/**
 * levels.ts — how gl reads a buyer's access level (INTEGRATION §2.1, C4).
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ INTEGRATOR, at the gl merge (teaser's registry is merged by then):   │
 * │ replace this file's body with                                        │
 * │   export { isTeaserOnly, cimModeForAccessLevel } from                │
 * │     "@shared/access-levels";                                         │
 * │ tests/gl/evidence-levels.test.ts pins the same answers either way.   │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * Until then this mirrors the registry's table exactly, by lookup (no
 * literal comparisons): new keys and the legacy values a stored row may
 * still hold. Anything unknown, empty or null reads as the teaser (least
 * access) — gl then shows nothing.
 */
type Mode = "blind" | "normal" | "dd";

/** Stored value → the CIM it opens (null = the teaser only, no CIM). */
const MODE_OF: Readonly<Record<string, Mode | null>> = Object.freeze({
  teaser_only: null,
  blind: "blind",
  named: "normal",
  due_diligence: "dd",
  // Values stored before October 2026, read with their old meaning forever.
  teaser: "blind",
  full: "blind",
  loi: "normal",
});

function lookup(v: unknown): Mode | null {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(MODE_OF, v) ? MODE_OF[v] : null;
}

/** The link opens the teaser alone (or its level can't be read). */
export function isTeaserOnly(v: unknown): boolean {
  return lookup(v) === null;
}

/** Which CIM a level reads; the teaser maps to "blind" only as a fail-closed second lock — check isTeaserOnly first. */
export function cimModeForAccessLevel(v: unknown): Mode {
  return lookup(v) ?? "blind";
}
