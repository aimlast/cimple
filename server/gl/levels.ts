/**
 * levels.ts — how gl reads a buyer's access level (INTEGRATION §2.1, C4).
 *
 * Since the gl merge (step 7) this is teaser's registry itself: a Teaser
 * link (or a level that can't be read) is `isTeaserOnly` → gl shows nothing;
 * the legacy values read with their old meaning (teaser/full → Blind CIM,
 * loi → Full CIM). tests/gl/evidence.test.ts pins the same answers it pinned
 * against gl's interim mirror.
 */
export { isTeaserOnly, cimModeForAccessLevel } from "@shared/access-levels";
