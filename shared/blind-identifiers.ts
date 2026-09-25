/**
 * Names that must never appear in a Blind CIM.
 *
 * Section titles are not part of the AI redaction overrides (those hold the
 * content), so titles are redacted by replacing known identifiers with the
 * codename. Using only deal.businessName leaked the real name whenever a
 * title used the company's full/legal name — e.g. the deal "Harbourline
 * Dental" with a section titled "Harbourline Dental Group" (found 2026-09-25).
 * This collects every name variant we know about. Pure; used by the view
 * room (server), the CIM Designer preview (client) and the redaction engine.
 */

const NAME_KEYS = [
  "companyName", "legalName", "legalEntityName", "businessLegalName", "corporateName", "operatingName",
  "dbaName", "dba", "tradeName", "brandName", "businessName", "ownerName", "owners", "locations",
];
const LEGAL_SUFFIX = /[\s,]+(inc|incorporated|ltd|limited|llc|l\.l\.c|corp|corporation|co|company|group|holdings|enterprises|ulc|lp|llp|pllc|pc)\.?$/i;

function text(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (v && typeof v === "object" && "value" in (v as Record<string, unknown>)) return text((v as Record<string, unknown>).value);
  return null;
}

export function blindIdentifiers(deal: { businessName?: string | null; extractedInfo?: Record<string, any> | null }): string[] {
  const info = deal.extractedInfo || {};
  const raw: string[] = [];
  if (deal.businessName) raw.push(deal.businessName);
  for (const k of NAME_KEYS) {
    const v = info[k];
    if (Array.isArray(v)) v.forEach((x) => { const t = text(x); if (t) raw.push(t); });
    else { const t = text(v); if (t) raw.push(t); }
  }
  const website = text(info.website) || text(info.websiteUrl) || text(info.companyWebsite);
  if (website) {
    const host = website.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split(/[/?#]/)[0];
    if (host) { raw.push(host); const stem = host.split(".")[0]; if (stem.length >= 5) raw.push(stem); }
  }

  const out = new Set<string>();
  for (const r of raw) {
    const name = r.replace(/\s+/g, " ").trim();
    if (name.length < 3 || name.length > 120) continue;
    out.add(name);
    // "QA CIMGEN — Harbourline Dental" → "Harbourline Dental"
    const afterDash = name.split(/\s[—–-]\s/).pop();
    if (afterDash && afterDash !== name && afterDash.length >= 4) out.add(afterDash.trim());
    // "Harbourline Dental Group Inc." → "Harbourline Dental Group" → "Harbourline Dental"
    let core = name;
    for (let i = 0; i < 3 && LEGAL_SUFFIX.test(core); i++) {
      core = core.replace(LEGAL_SUFFIX, "").trim();
      if (core.length >= 4) out.add(core);
    }
  }
  // Longest first so "Harbourline Dental Group" wins over "Harbourline Dental".
  return Array.from(out).sort((a, b) => b.length - a.length);
}

/** Title redactor for a blind view; identity when there's no codename. */
export function blindTitleRedactor(
  deal: { businessName?: string | null; extractedInfo?: Record<string, any> | null },
  codename: string | null | undefined,
): (t: string) => string {
  const ids = blindIdentifiers(deal);
  if (!codename || ids.length === 0) return (t) => t;
  const re = new RegExp(ids.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gi");
  return (t) => t.replace(re, codename);
}
