/**
 * The add-back list an add-back verification starts from ("provided"
 * workflow): the financial analysis's add-backs that count.
 *
 * Seeded before as every line in the normalization, it put in front of the
 * seller (and into the DD writer's context as "add-backs") lines the
 * analysis doesn't add back at all: dividends marked "Not an add-back",
 * lines the broker rejected, clawbacks the rules took out. And the owner's
 * pay arrived as two lines — the part above a market salary ($55,000) and
 * the market salary ($125,000) — so the matcher looked for a $55,000
 * payment that was never made and every owner-pay line came back "no
 * match". Now:
 *  - only approved lines are seeded (a line resting only on the broker's
 *    private notes only once the broker approved it themselves);
 *  - the owner-pay pair is one line at the owner's actual pay — the amount
 *    the payroll records show.
 * Pure.
 */
import type { UiAddback, UiNormalization } from "./shape";

export interface SeededAddback {
  id: string;
  label: string;
  description: string;
  category: string;
  annualAmount: number;
  amountYear: string | null;
  yearAmounts: Record<string, number>;
  verificationStatus: "unverified";
  matchedTransactions: [];
  sellerNotes: null;
  aiNotes: null;
}

const fmt = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

/** An add-back the analysis counts: approved, and a private-only one only on the broker's own approval. */
export function countsAsAddback(a: Pick<UiAddback, "approved" | "privateEvidence" | "approvedOverride"> | null | undefined): boolean {
  return !!a && a.approved === true && (!a.privateEvidence || a.approvedOverride === true);
}

const baseLabel = (label: string) => label.replace(/\s+—\s+market salary$/i, "");

export function seedAddbacksFromNormalization(norm: UiNormalization | null | undefined): SeededAddback[] {
  if (!norm || !Array.isArray(norm.addbacks)) return [];
  // The headline amount is the LATEST year's figure, not a multi-year
  // average — a $28,000 one-time renovation in 2024 is a $28,000 addback,
  // not $9,333. Years with no value for this addback are ignored; the full
  // per-year array is kept alongside for the matcher.
  const orderedYears: string[] = Array.isArray(norm.years) && norm.years.length > 0 ? norm.years.map(String) : [];
  const lines: Array<{ id: string; label: string; description: string; category: string; amounts: Record<string, number> }> = [];
  const all = norm.addbacks;
  const merged = new Set<UiAddback>();
  for (const a of all) {
    if (!a || merged.has(a)) continue;
    if (a.ownerCompPart) {
      // One owner-pay line at the owner's actual pay (excess + market salary).
      const excess = a.ownerCompPart === "excess" ? a : all.find((x) => x.ownerCompPart === "excess" && `${x.id}_market` === a.id);
      const market = a.ownerCompPart === "market" ? a : all.find((x) => x.ownerCompPart === "market" && x.id === `${a.id}_market`);
      const parts = [excess, market].filter((x): x is UiAddback => !!x);
      parts.forEach((x) => merged.add(x));
      if (!parts.some(countsAsAddback)) continue;
      const actual = excess?.ownerActualComp && Object.keys(excess.ownerActualComp).length > 0
        ? excess.ownerActualComp
        : Object.fromEntries(
            Array.from(new Set(parts.flatMap((x) => Object.keys(x.amounts ?? {})))).map((y) => [y, parts.reduce((s, x) => s + (Number(x.amounts?.[y]) || 0), 0)]),
          );
      const latest = Object.keys(actual).sort().pop();
      const ex = excess && latest !== undefined ? Number(excess.amounts?.[latest] ?? 0) : null;
      const m = market && latest !== undefined ? Number(market.amounts?.[latest] ?? 0) : null;
      const split = ex !== null && m !== null
        ? ` SDE adds back the full ${fmt(Number(actual[latest!]))}; adjusted EBITDA only the ${fmt(ex)} above a ${fmt(m)} market salary.`
        : "";
      lines.push({
        id: (excess ?? a).id,
        label: baseLabel((excess ?? a).label),
        description: `The owner's pay as the payroll records show it.${split}`,
        category: "owner_comp",
        amounts: Object.fromEntries(Object.entries(actual).map(([y, v]) => [y, Number(v)])),
      });
      continue;
    }
    if (!countsAsAddback(a)) continue;
    lines.push({ id: a.id, label: a.label || "", description: a.description || "", category: a.category || "other", amounts: a.amounts ?? {} });
  }
  return lines.map((a) => {
    const amounts: Record<string, number> = {};
    for (const [year, v] of Object.entries(a.amounts || {})) {
      const n = Number(v);
      if (Number.isFinite(n)) amounts[year] = n;
    }
    const years = Object.keys(amounts).sort((x, y) =>
      orderedYears.indexOf(x) === -1 || orderedYears.indexOf(y) === -1 ? x.localeCompare(y) : orderedYears.indexOf(x) - orderedYears.indexOf(y),
    );
    const latestWithValue = [...years].reverse().find((y) => amounts[y] !== 0) ?? years[years.length - 1];
    return {
      id: a.id || `ab_${Math.random().toString(36).slice(2, 8)}`,
      label: a.label,
      description: a.description,
      category: a.category,
      annualAmount: latestWithValue ? amounts[latestWithValue] : 0,
      amountYear: latestWithValue ?? null,
      yearAmounts: amounts,
      verificationStatus: "unverified" as const,
      matchedTransactions: [] as [],
      sellerNotes: null,
      aiNotes: null,
    };
  });
}

/**
 * Whether a verification line is an add-back of the analysis the CIM uses:
 * its label is one of the bridge's approved lines (an owner-pay line matches
 * either half of the split). Used by the DD writer, which must never present
 * a dividend or a rejected line as a verified add-back.
 */
export function isBridgeAddback(label: string, bridgeLabels: string[]): boolean {
  const norm = (s: string) => baseLabel(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const l = norm(label);
  return !!l && bridgeLabels.some((b) => norm(b) === l);
}
