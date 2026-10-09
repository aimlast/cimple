/**
 * cim-text — the percentages the CIM prints, for the broker-text guard
 * (checker r2 R2-3): a broker's note may quote a margin the CIM itself shows
 * ("EBITDA margin 13.2%") without a false "isn't in the CIM's figures"
 * warning. Only percentages: an amount the broker writes is still checked
 * against the figure's own numbers and the quoted sources.
 *
 *   printedPercents(sections)   pure
 *   cimPrintedPercents(deal)    the working copy + the kept copy buyers read (IO)
 */
import type { Deal } from "@shared/schema";

const PERCENT = /[-−]?\d{1,3}(?:\.\d+)?\s?%/g;

/** Every percentage printed in these sections' content, as one text the figure guard can read. */
export function printedPercents(sections: ReadonlyArray<{ layoutData?: unknown }>): string {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      for (const m of v.match(PERCENT) ?? []) out.add(m.replace(/\s+/g, "").replace("−", "-"));
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x);
    } else if (v && typeof v === "object") {
      for (const x of Object.values(v as Record<string, unknown>)) walk(x);
    }
  };
  for (const s of sections) walk(s.layoutData);
  return Array.from(out).join(" · ");
}

/** The percentages the CIM prints: the working copy and, while buyers read it, the kept copy. Never throws. */
export async function cimPrintedPercents(deal: Pick<Deal, "id" | "isLive" | "cimGeneration">): Promise<string> {
  try {
    const [{ storage }, { getPublishedSnapshot }, { servesPublishedSnapshot }] = await Promise.all([
      import("../../storage"),
      import("../published-snapshot"),
      import("@shared/cim-buyer-view"),
    ]);
    const sections = (await storage.getCimSectionsByDeal(deal.id)) as Array<{ layoutData?: unknown }>;
    const kept = servesPublishedSnapshot(deal) ? (await getPublishedSnapshot(deal.id))?.sections ?? [] : [];
    return printedPercents([...sections, ...(kept as Array<{ layoutData?: unknown }>)]);
  } catch {
    return "";
  }
}
