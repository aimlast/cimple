/**
 * Buyer access levels — the ONE place level strings are compared
 * (buyer_access.access_level, buyer_visits.access_level, deal_members.access_level).
 *
 *   Teaser         teaser_only    the short anonymous summary only (no CIM)
 *   Blind CIM      blind          the whole CIM under the codename
 *   Full CIM       named          the whole named CIM
 *   Due diligence  due_diligence  the named CIM + the due-diligence layer
 *
 * Fresh keys, never reused. The values stored before October 2026 stay
 * readable forever with their old meaning (LEGACY_ACCESS_LEVELS):
 *   "teaser" → blind   (the Blind CIM with "Full access" sections locked —
 *                       no section was ever locked, so it is the Blind CIM)
 *   "full"   → blind   (the Blind CIM with every section unlocked)
 *   "loi"    → named   (the named CIM)
 * No stored value ever changes meaning, so old code, new code, a stale tab,
 * the column default ('teaser') and a half-run tidy-up all read every row
 * correctly — or with less access, never more.
 *
 * Anything unknown, empty or null reads as teaser_only (least access).
 *
 * Rules for every caller (tests/unit/access-level-literals.test.ts scans for them):
 *  - compare only through these helpers, never a string literal;
 *  - store only normalizeAccessLevel(...) output;
 *  - match stored rows with sameAccessLevel (legacy values live until the tidy-up);
 *  - validate request inputs with parseAccessLevelInput (accepts legacy values a stale tab sends);
 *  - check isTeaserOnly(level) FIRST before keying on cimModeForAccessLevel —
 *    teaser_only maps to "blind" only as a fail-closed second lock.
 * The post-deploy tidy-up (scripts/migrate-access-levels.ts) is the only
 * access-level data migration.
 */

export type AccessLevel = "teaser_only" | "blind" | "named" | "due_diligence";

export const TEASER_ACCESS_LEVEL = "teaser_only" as const;
export const BLIND_ACCESS_LEVEL = "blind" as const;
export const NAMED_ACCESS_LEVEL = "named" as const;
export const DD_ACCESS_LEVEL = "due_diligence" as const;

export interface AccessLevelDef {
  key: AccessLevel;
  /** Broker-facing label. */
  label: string;
  rank: 0 | 1 | 2 | 3;
  document: "teaser" | "cim";
  /** The CIM version served; null for the teaser (no CIM at all). */
  cimMode: "blind" | "normal" | "dd" | null;
  /** One line, broker-facing. */
  description: string;
  /** "the teaser" | "the Blind CIM" | "the Full CIM" | "due-diligence access" */
  grantNoun: string;
  /** What a BUYER sees: "Summary" | "Blind CIM" | "Full CIM" | "Due diligence". */
  buyerLabel: string;
}

export const ACCESS_LEVELS: ReadonlyArray<AccessLevelDef> = [
  {
    key: TEASER_ACCESS_LEVEL, label: "Teaser", rank: 0, document: "teaser", cimMode: null,
    description: "A short, anonymous summary. No NDA. They can ask you for the CIM.",
    grantNoun: "the teaser", buyerLabel: "Summary",
  },
  {
    key: BLIND_ACCESS_LEVEL, label: "Blind CIM", rank: 1, document: "cim", cimMode: "blind",
    description: "The whole CIM under the codename. No business name, people or places.",
    grantNoun: "the Blind CIM", buyerLabel: "Blind CIM",
  },
  {
    key: NAMED_ACCESS_LEVEL, label: "Full CIM", rank: 2, document: "cim", cimMode: "normal",
    description: "The whole CIM with the business's name, people and places.",
    grantNoun: "the Full CIM", buyerLabel: "Full CIM",
  },
  {
    key: DD_ACCESS_LEVEL, label: "Due diligence", rank: 3, document: "cim", cimMode: "dd",
    description: "The Full CIM plus due-diligence detail and the data room.",
    grantNoun: "due-diligence access", buyerLabel: "Due diligence",
  },
];

/** The 400 a request gets for a level it can't read. */
export const ACCESS_LEVEL_INPUT_ERROR = "Choose Teaser, Blind CIM, Full CIM or Due diligence.";

/** Values stored before October 2026 → the level they always meant. Forever. */
export const LEGACY_ACCESS_LEVELS = { teaser: "blind", full: "blind", loi: "named" } as const;

const BY_KEY: ReadonlyMap<string, AccessLevelDef> = new Map(ACCESS_LEVELS.map((l) => [l.key, l]));
const LEGACY: Readonly<Record<string, AccessLevel>> = LEGACY_ACCESS_LEVELS;

/** New keys only (not the legacy values). */
export function isAccessLevel(v: unknown): v is AccessLevel {
  return typeof v === "string" && BY_KEY.has(v);
}

/**
 * A request body or query value: a new key or a legacy value (a stale tab may
 * send "full" meaning the Blind CIM) → the normalised level; anything else → null (400).
 */
export function parseAccessLevelInput(v: unknown): AccessLevel | null {
  if (typeof v !== "string") return null;
  if (BY_KEY.has(v)) return v as AccessLevel;
  if (Object.prototype.hasOwnProperty.call(LEGACY, v)) return LEGACY[v];
  return null;
}

/** Any stored value → its level. Unknown, empty or null → teaser_only (least access). */
export function normalizeAccessLevel(v: unknown): AccessLevel {
  return parseAccessLevelInput(v) ?? TEASER_ACCESS_LEVEL;
}

function def(v: unknown): AccessLevelDef {
  return BY_KEY.get(normalizeAccessLevel(v))!;
}

/**
 * Two stored values mean the same level ("loi" and "named"). Junk never matches
 * anything — not even itself — so an unreadable row can't be mistaken for a level.
 */
export function sameAccessLevel(a: unknown, b: unknown): boolean {
  const x = parseAccessLevelInput(a);
  return x !== null && x === parseAccessLevelInput(b);
}

export function accessLevelRank(v: unknown): 0 | 1 | 2 | 3 {
  return def(v).rank;
}

/** Broker-facing label: "Teaser" | "Blind CIM" | "Full CIM" | "Due diligence". */
export function accessLevelLabel(v: unknown): string {
  return def(v).label;
}

/** Buyer-facing label: the teaser is a "Summary" to buyers. */
export function buyerFacingLevelLabel(v: unknown): string {
  return def(v).buyerLabel;
}

/** The link opens a CIM (Blind, Full or DD) — not the teaser alone. */
export function seesCim(v: unknown): boolean {
  return accessLevelRank(v) >= 1;
}

/** The link opens the named CIM (Full CIM or due diligence). */
export function seesNamedCim(v: unknown): boolean {
  return accessLevelRank(v) >= 2;
}

export function isTeaserOnly(v: unknown): boolean {
  return normalizeAccessLevel(v) === TEASER_ACCESS_LEVEL;
}

/**
 * Which CIM version a level reads. teaser_only → "blind": a fail-closed second
 * lock only — buildBuyerCim serves a teaser link nothing at all. Callers keyed
 * on "the buyer's CIM mode" check isTeaserOnly first.
 */
export function cimModeForAccessLevel(v: unknown): "blind" | "normal" | "dd" {
  return def(v).cimMode ?? "blind";
}

/** What a rendition of this level is recorded as (reading analytics). */
export function renditionKindFor(v: unknown): { mode: "teaser" | "blind" | "normal" | "dd"; variant: "teaser" | "full" } {
  if (isTeaserOnly(v)) return { mode: "teaser", variant: "teaser" };
  return { mode: cimModeForAccessLevel(v), variant: "full" };
}

/** Timeline wording when a link is created: "Sent the teaser", "Given the Blind CIM", … */
export function accessGrantPhrase(v: unknown): string {
  const d = def(v);
  return d.key === TEASER_ACCESS_LEVEL ? "Sent the teaser" : `Given ${d.grantNoun}`;
}

/** Timeline wording when a link's level changes: "Moved to the Full CIM", "Moved back to the teaser". */
export function accessChangePhrase(v: unknown): string {
  const d = def(v);
  return d.key === TEASER_ACCESS_LEVEL ? "Moved back to the teaser" : `Moved to ${d.grantNoun}`;
}

/** The tidy-up's mapping: teaser/full → blind, loi → named, anything else unchanged. */
export function mapLegacyLevelValue(v: string): string {
  return Object.prototype.hasOwnProperty.call(LEGACY, v) ? LEGACY[v] : v;
}
