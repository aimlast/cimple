/**
 * Location-card wording shared by the renderer (client/src/components/cim/
 * renderers/LocationCard.tsx) and the buyer chatbot's CIM context
 * (server/qa/cim-context.ts), so what a buyer reads on the card and what the
 * chatbot says about it agree: a per-square-foot rate is base rent, never
 * "annual rent $12.00 per sq ft".
 */

/**
 * "2,650 sq ft" — the unit is added only to a bare number. A value that
 * names its own unit ("4 acres", "1.2 ha", "450 m²") or is words ("4 acres
 * with shop facility") is shown as written — never "4 acres sq ft".
 */
export function formatSqft(v: unknown): string {
  if (typeof v === "number") return Number.isFinite(v) ? `${v.toLocaleString("en-US")} sq ft` : "";
  const t = String(v ?? "").trim();
  if (!t) return "";
  const bare = t.match(/^~?\s*(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?$/);
  if (!bare) return t;
  const n = Number(`${bare[1].replace(/,/g, "")}${bare[2] ?? ""}`);
  return Number.isFinite(n) ? `${t.startsWith("~") ? "~" : ""}${n.toLocaleString("en-US")} sq ft` : t;
}

/** A lease kind short enough for a badge ("Triple-net lease", "Owned", "Month-to-month"). */
const SHORT_LEASE_TYPE = (t: string) => t.length <= 32 && t.split(/\s+/).length <= 5;

/**
 * The lease type as a short badge plus, when the writer put a paragraph in
 * it, the rest as a "Lease terms" line: "Triple-net lease (fully net and
 * carefree to Landlord: Tenant pays realty taxes, …)" drew a pill that
 * overlapped the facility's name and squeezed the address to one word per
 * line (Ridgeline, 2026-09-26).
 */
export function splitLeaseType(v: unknown): { badge: string | null; terms: string | null } {
  const t = String(v ?? "").trim();
  if (!t) return { badge: null, terms: null };
  if (SHORT_LEASE_TYPE(t)) return { badge: t, terms: null };
  const m = t.match(/^([^(:;—–]+?)\s*(?:\(|:|;|—|–|\s-\s)\s*([\s\S]+?)\)?\s*$/);
  const head = m?.[1]?.trim() ?? "";
  if (head && SHORT_LEASE_TYPE(head)) {
    const rest = (m?.[2] ?? "").trim();
    return { badge: head, terms: rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : null };
  }
  return { badge: null, terms: t };
}

/**
 * The label a rent figure is shown under: "Annual Rent" / "Monthly Rent"
 * only when the value is that — a per-square-foot rate ("$12.00 per sq ft
 * (Years 3-5)") is "Base Rent", never an annual amount. The first unit the
 * value itself names decides, and a bracketed aside never does: "$28,000 per
 * month ($336,000 per annum)" is a monthly rent (it was labelled "Annual
 * Rent" because any "per annum" won), and "$336,000 ($28,000 per month)" in
 * the annual field is annual. A value that names no unit outside brackets
 * keeps its field's label.
 */
const RENT_UNITS: Array<[string, RegExp]> = [
  ["Base Rent", /(?:\bper|\/)\s*(?:sq\.?\s*(?:ft|feet|foot|m)|square\s+(?:foot|feet|metre|meter)|m²|m2)\b|\bpsf\b|\bper\s+(?:rentable|usable)\b/],
  ["Monthly Rent", /(?:\bper|\/|\ba)\s*(?:month|mo)\b|\bmonthly\b/],
  ["Annual Rent", /(?:\bper|\/|\ba)\s*(?:year|yr|annum)\b|\bannual(?:ly)?\b|\bp\.?a\.?(?:\s|$)/],
];

export function rentLabel(field: "annualRent" | "monthlyRent", value: unknown): string {
  const t = String(value ?? "").toLowerCase().replace(/\([^()]*\)|\[[^\[\]]*\]/g, " ");
  let best: { label: string; at: number } | null = null;
  for (const [label, re] of RENT_UNITS) {
    const m = re.exec(t);
    if (m && (!best || m.index < best.at)) best = { label, at: m.index };
  }
  if (best) return best.label;
  return field === "annualRent" ? "Annual Rent" : "Monthly Rent";
}
