/**
 * Buyer access levels — the registry (INTEGRATION §2.1).
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ CONTRACT COPY on the vdr branch. The teaser stream OWNS this file and    │
 * │ ships the real one; at the merge, TAKE TEASER'S FILE. vdr only imports    │
 * │ the names below, exactly as INTEGRATION §2.1 defines them, so it never   │
 * │ compares a level with a literal.                                          │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 *   teaser_only  Teaser         (buyer: Summary)   rank 0  mode blind (fail-closed)
 *   blind        Blind CIM                          rank 1  mode blind   legacy: teaser, full
 *   named        Full CIM                           rank 2  mode normal  legacy: loi
 *   due_diligence Due diligence                     rank 3  mode dd
 * Unknown / "" / null → teaser_only (least access).
 */

export type AccessLevel = "teaser_only" | "blind" | "named" | "due_diligence";
export const TEASER_ACCESS_LEVEL = "teaser_only",
  BLIND_ACCESS_LEVEL = "blind",
  NAMED_ACCESS_LEVEL = "named",
  DD_ACCESS_LEVEL = "due_diligence";
export const LEGACY_ACCESS_LEVELS = { teaser: "blind", full: "blind", loi: "named" } as const;

const ORDER: readonly AccessLevel[] = [TEASER_ACCESS_LEVEL, BLIND_ACCESS_LEVEL, NAMED_ACCESS_LEVEL, DD_ACCESS_LEVEL];

export function isAccessLevel(v: unknown): v is AccessLevel {
  return typeof v === "string" && (ORDER as readonly string[]).includes(v);
}

/** Request bodies and query params: a new OR a legacy key; anything else → null (→ 400). */
export function parseAccessLevelInput(v: unknown): AccessLevel | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (isAccessLevel(s)) return s;
  if (Object.prototype.hasOwnProperty.call(LEGACY_ACCESS_LEVELS, s)) return LEGACY_ACCESS_LEVELS[s as keyof typeof LEGACY_ACCESS_LEVELS];
  return null;
}

/** Any stored value → a key. Unknown / "" / null → teaser_only (least access). */
export function normalizeAccessLevel(v: unknown): AccessLevel {
  return parseAccessLevelInput(v) ?? TEASER_ACCESS_LEVEL;
}

/** Matching stored rows (legacy values live on until the tidy-up runs). */
export function sameAccessLevel(a: unknown, b: unknown): boolean {
  return normalizeAccessLevel(a) === normalizeAccessLevel(b);
}

export function accessLevelRank(v: unknown): 0 | 1 | 2 | 3 {
  return ORDER.indexOf(normalizeAccessLevel(v)) as 0 | 1 | 2 | 3;
}

export function accessLevelLabel(v: unknown): string {
  switch (normalizeAccessLevel(v)) {
    case TEASER_ACCESS_LEVEL: return "Teaser";
    case BLIND_ACCESS_LEVEL: return "Blind CIM";
    case NAMED_ACCESS_LEVEL: return "Full CIM";
    default: return "Due diligence";
  }
}

export function buyerFacingLevelLabel(v: unknown): string {
  return isTeaserOnly(v) ? "Summary" : accessLevelLabel(v);
}

export function seesCim(v: unknown): boolean {
  return accessLevelRank(v) >= 1;
}
export function seesNamedCim(v: unknown): boolean {
  return accessLevelRank(v) >= 2;
}
export function isTeaserOnly(v: unknown): boolean {
  return normalizeAccessLevel(v) === TEASER_ACCESS_LEVEL;
}

/** teaser_only → "blind" as a fail-closed second lock (check isTeaserOnly first). */
export function cimModeForAccessLevel(v: unknown): "blind" | "normal" | "dd" {
  const k = normalizeAccessLevel(v);
  if (k === DD_ACCESS_LEVEL) return "dd";
  if (k === NAMED_ACCESS_LEVEL) return "normal";
  return "blind";
}

export function renditionKindFor(v: unknown): { mode: "teaser" | "blind" | "normal" | "dd"; variant: "teaser" | "full" } {
  if (isTeaserOnly(v)) return { mode: "teaser", variant: "teaser" };
  return { mode: cimModeForAccessLevel(v), variant: "full" };
}

export function accessGrantPhrase(v: unknown): string {
  return `Given ${accessLevelLabel(v).replace(/^Due/, "due").replace(/^Teaser/, "teaser")} access`;
}

export function accessChangePhrase(v: unknown): string {
  return `Moved to ${accessLevelLabel(v).replace(/^Due/, "due").replace(/^Teaser/, "the teaser")}`;
}

/** Tidy-up only: a stored value → the key it means now (unknown values are left alone). */
export function mapLegacyLevelValue(v: string): string {
  return Object.prototype.hasOwnProperty.call(LEGACY_ACCESS_LEVELS, v) ? LEGACY_ACCESS_LEVELS[v as keyof typeof LEGACY_ACCESS_LEVELS] : v;
}
