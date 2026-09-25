/**
 * Section keys for sections the broker adds in the CIM builder. Pure (no DB)
 * so it can be unit-tested. A key must be unique within a deal: duplicates
 * broke regenerate, relatedSections links, analytics and the legacy
 * cimContent map.
 */

function slug(title: string): string {
  const s = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32)
    .replace(/_+$/g, "");
  return s || "section";
}

/** A sectionKey no other section of the deal uses. */
export function uniqueSectionKey(title: string, taken: Iterable<string>): string {
  const used = new Set(Array.from(taken));
  const base = slug(title);
  if (!used.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const k = `${base}_${n}`;
    if (!used.has(k)) return k;
  }
  return `${base}_${Date.now().toString(36)}`;
}
