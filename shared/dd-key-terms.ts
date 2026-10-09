/**
 * dd-key-terms — "From the documents" on a due-diligence page (spec D20, $0).
 *
 * On a DD page about the location, the customers, or (operations) permits and
 * licences, a strip lists up to 6 key terms from the deal's facts — the lease
 * expiry, renewal options, a contract's term, a licence — each linked to the
 * document it came from. A term is listed only when:
 *   - its winning source is a document (FieldSource.source "document" with a
 *     documentId) that may be cited (the caller passes `citable`);
 *   - its value, made concise, is ≤ 140 characters and passes the screens;
 *   - it is in the screened CIM fact view (the caller passes only those facts).
 * Contract terms the owner said on a call are honestly left out.
 *
 * Pure.
 */
import type { PageRole } from "./analytics-v2";

export type KeyTermFamily = "location" | "customers" | "permits";

interface TermRule {
  /** Fact keys (exact or a pattern on the key). */
  key: RegExp;
  label: string;
  /** For a by-year map: the latest year's value. */
  byYear?: boolean;
}

export const KEY_TERM_FAMILIES: Record<KeyTermFamily, TermRule[]> = {
  location: [
    { key: /^leaseExpiry$|^leaseExpir(?:y|ation)Date$|^leaseEndDate$/, label: "Lease expires" },
    { key: /^leaseRenewalOptions?$|^renewalOptions?$/, label: "Renewal options" },
    { key: /^leaseSqft$|^leaseSquareFe?et$|^premisesSqft$|^facilitySqft$/, label: "Space" },
    { key: /^monthlyRent$|^monthlyBaseRent$/, label: "Monthly rent" },
    { key: /^annualBaseRentByYear$/, label: "Base rent", byYear: true },
    { key: /^additionalRent$/, label: "Additional rent" },
    { key: /^leaseAssignment\w*$/, label: "Assignment" },
  ],
  customers: [
    { key: /ContractTerm/i, label: "Contract term" },
    { key: /ContractExpir/i, label: "Contract expires" },
    { key: /Msa(?:Term|Expiry|Renewal)?$|^msa\w*/, label: "Master services agreement" },
  ],
  permits: [
    { key: /Licen[cs]e(?!Compliance)/, label: "Licence" },
    { key: /Permit/, label: "Permit" },
    { key: /Certificat/, label: "Certificate" },
    { key: /^safetyRating$|^currentSafetyRating$/, label: "Safety rating" },
  ],
};

/** Which family a DD page shows, from its role and title. Null = no strip. */
export function keyTermFamilyFor(role: PageRole | string | null | undefined, title: string | null | undefined): KeyTermFamily | null {
  if (role === "location") return "location";
  if (role === "customers") return "customers";
  if (role === "operations" && /\b(permits?|licen[cs]es?|licensing|certificat|accreditation|registrations?)\b/i.test(title ?? "")) return "permits";
  // A compliance / regulatory page whose role reads as something else.
  if (/\b(permits?|licen[cs]es?|licensing|regulatory|compliance|accreditation)\b/i.test(title ?? "")) return "permits";
  return null;
}

export interface KeyTermSource {
  source?: string;
  documentId?: string;
  brokerOnly?: boolean;
  years?: Record<string, unknown>;
}

export interface KeyTerm {
  label: string;
  value: string;
  factKey: string;
  documentId: string;
  /** The excerpt to find in the document (≤ 80 characters). */
  needle: string;
}

/** A value as a key term: the first clause, without a long trailing aside. Null when still too long. */
export function conciseTerm(value: unknown): string | null {
  if (value === null || value === undefined || typeof value === "object") return null;
  let v = String(value).replace(/\s+/g, " ").trim();
  if (!v) return null;
  const semi = v.indexOf("; ");
  if (semi >= 8) v = v.slice(0, semi).trim();
  const paren = v.lastIndexOf(" (");
  if (paren >= 12 && v.endsWith(")") && v.length - paren > 14) v = v.slice(0, paren).trim();
  // An aside that was cut off by the extractor ("… (including approximately 8,500 sq ft of two-storey office and 22,000 sq ft to be improved by the Tenan").
  if (paren >= 12 && !v.slice(paren).includes(")") && v.length - paren > 14) v = v.slice(0, paren).trim();
  v = v.replace(/[.,;:\s]+$/, "");
  return v.length > 0 && v.length <= 140 ? v : null;
}

/**
 * The key terms for one page. `sources` = the facts' `_fieldSources`;
 * `citable(documentId)` = may this document be cited; `screen(text)` = the
 * D23 string pipeline (true = keep). At most 6, in the family's order.
 */
export function keyTermsFor(
  family: KeyTermFamily,
  facts: Record<string, unknown>,
  sources: Record<string, KeyTermSource | undefined>,
  citable: (documentId: string) => boolean,
  screen: (text: string) => boolean = () => true,
): KeyTerm[] {
  const out: KeyTerm[] = [];
  const used = new Set<string>();
  for (const rule of KEY_TERM_FAMILIES[family]) {
    for (const [key, raw] of Object.entries(facts)) {
      if (out.length >= 6) return out;
      if (key.startsWith("_") || used.has(key) || !rule.key.test(key)) continue;
      const src = sources[key];
      let value: unknown = raw;
      let documentId = src?.source === "document" ? src.documentId : undefined;
      if (rule.byYear) {
        if (!raw || typeof raw !== "object") continue;
        const years = Object.keys(raw as Record<string, unknown>).filter((y) => /^\d{4}$/.test(y)).sort();
        const latest = years[years.length - 1];
        if (!latest) continue;
        value = (raw as Record<string, unknown>)[latest];
        const ys = src?.years?.[latest];
        const yearSource = ys && typeof ys === "object" ? (ys as KeyTermSource) : typeof ys === "string" ? { source: "document", documentId: ys } : undefined;
        documentId = yearSource?.source === "document" ? yearSource.documentId : typeof ys === "string" ? ys : undefined;
        if (yearSource?.brokerOnly) documentId = undefined;
      }
      if (!documentId || src?.brokerOnly || !citable(documentId)) continue;
      const concise = conciseTerm(value);
      if (!concise) continue;
      const label = rule.byYear ? `${rule.label} (${latestYearOf(raw)})` : rule.label;
      if (!screen(label) || !screen(concise)) continue;
      used.add(key);
      out.push({ label, value: concise, factKey: key, documentId, needle: concise.slice(0, 80) });
    }
  }
  return out;
}

function latestYearOf(raw: unknown): string {
  const years = Object.keys((raw ?? {}) as Record<string, unknown>).filter((y) => /^\d{4}$/.test(y)).sort();
  return years[years.length - 1] ?? "";
}
