/**
 * The analytics dashboards' ONE import of the access-level registry
 * (shared/access-levels.ts, owned by the teaser stream). No analytics file
 * compares a level to a string literal — every CIM number is filtered with
 * seesCim, teaser-only links with isTeaserOnly, words come from the
 * registry — so the teaser stream's literal scan passes over this code.
 */
export {
  ACCESS_LEVELS,
  accessLevelLabel,
  accessLevelRank,
  isTeaserOnly,
  normalizeAccessLevel,
  seesCim,
} from "@shared/access-levels";

import { ACCESS_LEVELS, normalizeAccessLevel } from "@shared/access-levels";

/** "the teaser" | "the Blind CIM" | "the Full CIM" | "due-diligence access" (activity sentences). */
export function grantNounOf(level: unknown): string {
  const key = normalizeAccessLevel(level);
  return ACCESS_LEVELS.find((l) => l.key === key)?.grantNoun ?? "the CIM";
}
