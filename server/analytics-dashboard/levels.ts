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

import { ACCESS_LEVELS, normalizeAccessLevel, renditionKindFor, TEASER_ACCESS_LEVEL } from "@shared/access-levels";

/** The rendition mode a teaser link is served ("teaser"), from the registry. */
export const TEASER_RENDITION_MODE: string = renditionKindFor(TEASER_ACCESS_LEVEL).mode;

/** "the teaser" | "the Blind CIM" | "the Full CIM" | "due-diligence access" (activity sentences). */
export function grantNounOf(level: unknown): string {
  const key = normalizeAccessLevel(level);
  return ACCESS_LEVELS.find((l) => l.key === key)?.grantNoun ?? "the CIM";
}
