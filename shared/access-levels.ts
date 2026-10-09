/**
 * Buyer access levels — the registry (teaser stream; the ONLY place level
 * strings are compared). Pure, no dependencies.
 *
 *   Teaser         teaser_only     a short anonymous summary, no NDA to read it
 *   Blind CIM      blind           the whole CIM under the codename   (legacy: teaser, full)
 *   Full CIM       named           the whole named CIM                (legacy: loi)
 *   Due diligence  due_diligence   the Full CIM + due-diligence layer
 *
 * Legacy values stay readable forever (LEGACY_ACCESS_LEVELS): the tidy-up
 * script only ever turns a legacy value into its equivalent new key, so a
 * row read before, during or after it means the same thing. Anything
 * unknown, empty or null reads as the least access (teaser_only).
 *
 * Written by the analytics stream from teaser.md §3.3 / INTEGRATION.md §2.1
 * because the teaser branch hadn't committed it yet; at integration the
 * teaser stream's version of this file is taken.
 */

export type AccessLevel = "teaser_only" | "blind" | "named" | "due_diligence";

export const TEASER_ACCESS_LEVEL = "teaser_only",
  BLIND_ACCESS_LEVEL = "blind",
  NAMED_ACCESS_LEVEL = "named",
  DD_ACCESS_LEVEL = "due_diligence";

export const ACCESS_LEVELS: ReadonlyArray<{
  key: AccessLevel;
  label: string;
  rank: 0 | 1 | 2 | 3;
  document: "teaser" | "cim";
  cimMode: "blind" | "normal" | "dd" | null;
  /** One line, broker-facing. */
  description: string;
  /** "the teaser" | "the Blind CIM" | "the Full CIM" | "due-diligence access" */
  grantNoun: string;
  /** What a BUYER sees. */
  buyerLabel: string;
}> = [
  { key: "teaser_only", label: "Teaser", rank: 0, document: "teaser", cimMode: null, description: "A short, anonymous summary. No NDA. They can ask you for the CIM.", grantNoun: "the teaser", buyerLabel: "Summary" },
  { key: "blind", label: "Blind CIM", rank: 1, document: "cim", cimMode: "blind", description: "The whole CIM under the codename. No business name, people or places.", grantNoun: "the Blind CIM", buyerLabel: "Blind CIM" },
  { key: "named", label: "Full CIM", rank: 2, document: "cim", cimMode: "normal", description: "The whole CIM with the business's name, people and places.", grantNoun: "the Full CIM", buyerLabel: "Full CIM" },
  { key: "due_diligence", label: "Due diligence", rank: 3, document: "cim", cimMode: "dd", description: "The Full CIM plus due-diligence detail and the data room.", grantNoun: "due-diligence access", buyerLabel: "Due diligence" },
];

/** Legacy stored values and the key each one means (kept forever). */
export const LEGACY_ACCESS_LEVELS = { teaser: "blind", full: "blind", loi: "named" } as const;

const BY_KEY = new Map(ACCESS_LEVELS.map((l) => [l.key, l]));

/** New keys only. */
export function isAccessLevel(v: unknown): v is AccessLevel {
  return typeof v === "string" && BY_KEY.has(v as AccessLevel);
}

function legacyAlias(v: unknown): AccessLevel | null {
  if (typeof v !== "string") return null;
  return Object.prototype.hasOwnProperty.call(LEGACY_ACCESS_LEVELS, v)
    ? (LEGACY_ACCESS_LEVELS[v as keyof typeof LEGACY_ACCESS_LEVELS] as AccessLevel)
    : null;
}

/** New key → itself; legacy → its alias; anything else → "teaser_only" (least access). */
export function normalizeAccessLevel(v: unknown): AccessLevel {
  if (isAccessLevel(v)) return v;
  return legacyAlias(v) ?? TEASER_ACCESS_LEVEL;
}

/** Request bodies and query params: a new OR legacy value → normalised; anything else → null (answer 400). */
export function parseAccessLevelInput(v: unknown): AccessLevel | null {
  if (isAccessLevel(v)) return v;
  return legacyAlias(v);
}

/** Normalised equality (matching stored rows while legacy values live on). */
export function sameAccessLevel(a: unknown, b: unknown): boolean {
  return normalizeAccessLevel(a) === normalizeAccessLevel(b);
}

function entry(v: unknown) {
  return BY_KEY.get(normalizeAccessLevel(v))!;
}

export function accessLevelRank(v: unknown): 0 | 1 | 2 | 3 {
  return entry(v).rank;
}

/** Broker-facing label: "Teaser", "Blind CIM", "Full CIM", "Due diligence". */
export function accessLevelLabel(v: unknown): string {
  return entry(v).label;
}

/** Buyer-facing label: teaser_only → "Summary". */
export function buyerFacingLevelLabel(v: unknown): string {
  return entry(v).buyerLabel;
}

/** The link opens a CIM (Blind, Full or Due diligence). */
export function seesCim(v: unknown): boolean {
  return accessLevelRank(v) >= 1;
}

/** The link opens the named CIM (Full or Due diligence). */
export function seesNamedCim(v: unknown): boolean {
  return accessLevelRank(v) >= 2;
}

export function isTeaserOnly(v: unknown): boolean {
  return normalizeAccessLevel(v) === TEASER_ACCESS_LEVEL;
}

/** Which CIM version a level sees. teaser_only → "blind" (a fail-closed second lock; check isTeaserOnly first). */
export function cimModeForAccessLevel(v: unknown): "blind" | "normal" | "dd" {
  return entry(v).cimMode ?? "blind";
}

/** The rendition a level is served: teaser_only → {teaser, teaser}; else {cimMode, full}. */
export function renditionKindFor(v: unknown): { mode: "teaser" | "blind" | "normal" | "dd"; variant: "teaser" | "full" } {
  const e = entry(v);
  return e.cimMode ? { mode: e.cimMode, variant: "full" } : { mode: "teaser", variant: "teaser" };
}

/** "Sent the teaser" | "Given the Blind CIM" | "Given the Full CIM" | "Given due-diligence access". */
export function accessGrantPhrase(v: unknown): string {
  const e = entry(v);
  return e.document === "teaser" ? `Sent ${e.grantNoun}` : `Given ${e.grantNoun}`;
}

/** "Moved to the Full CIM" | "Moved back to the teaser". */
export function accessChangePhrase(v: unknown): string {
  const e = entry(v);
  return e.document === "teaser" ? `Moved back to ${e.grantNoun}` : `Moved to ${e.grantNoun}`;
}

/** The tidy-up's mapping: teaser/full → blind, loi → named, anything else unchanged. */
export function mapLegacyLevelValue(v: string): string {
  return legacyAlias(v) ?? v;
}
