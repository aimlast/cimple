/**
 * related-sections — a section's `relatedSections` links point at sections
 * that exist in THIS CIM.
 *
 * Why (smoke test 2026-09-27, Pacific): regenerating the "Revenue by Service
 * Line" donut wrote relatedSections ["business_model", "revenue_growth",
 * "customer_diversification"] — keys the writer made up from the section
 * titles. The CIM's real keys are business_overview ("Business Model &
 * Service Lines"), revenue_trend ("Revenue Growth Trajectory") and
 * customer_concentration ("Customer Diversification"), so the buyer's
 * "related" links silently vanished (the viewer drops keys it can't find).
 *
 * Each key is kept when it is real, mapped to the one section whose key and
 * title share the most words with it when that match is unambiguous, and
 * dropped otherwise (never a guess between two sections, never a link to
 * itself). Pure.
 */

export interface RelatedSectionTarget {
  sectionKey: string;
  sectionTitle?: string | null;
}

type AnyRecord = Record<string, unknown>;
const isRecord = (v: unknown): v is AnyRecord => !!v && typeof v === "object" && !Array.isArray(v);

const STOP = new Set(["and", "the", "of", "a", "an", "to", "for", "in", "on", "by", "with", "section", "our", "its"]);

function words(text: string | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const raw of String(text ?? "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)) {
    if (!raw || STOP.has(raw)) continue;
    // "customers" ~ "customer", "services" ~ "service"
    out.add(raw.length > 3 && raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw);
  }
  return out;
}

/** The real section key a (possibly invented) key refers to, or null. */
export function resolveRelatedKey(key: string, sections: RelatedSectionTarget[], selfKey?: string): string | null {
  if (key === selfKey) return null;
  const candidates = sections.filter((s) => s.sectionKey && s.sectionKey !== selfKey);
  if (candidates.some((s) => s.sectionKey === key)) return key;
  const want = words(key);
  if (want.size === 0) return null;
  // At least half of the key's words must be the section's ("revenue_growth"
  // → "Revenue Growth Trajectory"), never one shared word of three.
  const needed = Math.ceil(want.size / 2);
  let best: string | null = null;
  let bestScore = 0;
  let tie = false;
  for (const s of candidates) {
    const have = new Set([...Array.from(words(s.sectionKey)), ...Array.from(words(s.sectionTitle))]);
    let score = 0;
    want.forEach((w) => { if (have.has(w)) score++; });
    if (score > bestScore) {
      best = s.sectionKey;
      bestScore = score;
      tie = false;
    } else if (score === bestScore && score > 0 && s.sectionKey !== best) {
      tie = true;
    }
  }
  return bestScore >= needed && !tie ? best : null;
}

/**
 * layoutData with its relatedSections pointing at real sections of the CIM
 * (mapped, de-duplicated, self-links and unknown keys dropped). Returned
 * unchanged when there is nothing to check. Two-column sections are checked
 * column by column as well.
 */
export function reconcileRelatedSections<T>(layoutData: T, sections: RelatedSectionTarget[], selfKey?: string): T {
  if (!isRecord(layoutData)) return layoutData;
  let out: AnyRecord = layoutData;
  if (Array.isArray(layoutData.relatedSections)) {
    const mapped: string[] = [];
    for (const k of layoutData.relatedSections as unknown[]) {
      if (typeof k !== "string" || !k.trim()) continue;
      const real = resolveRelatedKey(k.trim(), sections, selfKey);
      if (real && !mapped.includes(real)) mapped.push(real);
    }
    out = { ...out };
    if (mapped.length > 0) out.relatedSections = mapped;
    else delete out.relatedSections;
  }
  for (const side of ["left", "right"] as const) {
    const col = out[side];
    if (isRecord(col) && isRecord(col.content) && Array.isArray(col.content.relatedSections)) {
      out = { ...out, [side]: { ...col, content: reconcileRelatedSections(col.content, sections, selfKey) } };
    }
  }
  return out as T;
}
