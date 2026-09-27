/**
 * What the seller's public buyer-review page (/review/:token) receives.
 *
 * The page is opened by the seller with a token — no login — so the payload
 * is a whitelist of exactly the fields the page renders. The approval row
 * also carries broker-private material that must never reach the seller:
 * `crmRawData` (the broker's whole Pipedrive person record: internal notes,
 * other listings the buyer enquired on, custom fields, file names),
 * `crmRecordId`/`crmSource`, the broker's review notes, NDA notes, the
 * review token itself and internal ids.
 */
import type { BuyerApprovalRequest } from "@shared/schema";

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

function financialCapability(v: unknown) {
  if (!v || typeof v !== "object") return null;
  const f = v as Record<string, unknown>;
  return {
    liquidFunds: str(f.liquidFunds),
    annualIncome: str(f.annualIncome),
    investmentSizeTarget: str(f.investmentSizeTarget),
    hasProofOfFunds: bool(f.hasProofOfFunds),
    sourceOfFunds: str(f.sourceOfFunds),
    prequalifiedForFinancing: bool(f.prequalifiedForFinancing),
    notes: str(f.notes),
  };
}

function partners(v: unknown) {
  if (!Array.isArray(v)) return [];
  return v
    .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
    .map((p) => ({
      name: str(p.name) ?? "",
      role: str(p.role),
      email: str(p.email),
      phone: str(p.phone),
      company: str(p.company),
      linkedinUrl: str(p.linkedinUrl),
      background: str(p.background),
    }))
    .filter((p) => p.name);
}

export function sellerReviewPayload(r: BuyerApprovalRequest) {
  return {
    id: r.id,
    buyerName: r.buyerName,
    buyerTitle: r.buyerTitle ?? null,
    buyerEmail: r.buyerEmail,
    buyerPhone: r.buyerPhone ?? null,
    buyerCompany: r.buyerCompany ?? null,
    buyerCompanyUrl: r.buyerCompanyUrl ?? null,
    linkedinUrl: r.linkedinUrl ?? null,
    otherProfileUrls: Array.isArray(r.otherProfileUrls) ? (r.otherProfileUrls as unknown[]).filter((u): u is string => typeof u === "string") : [],
    category: r.category,
    riskLevel: r.riskLevel,
    background: r.background ?? null,
    financialCapability: financialCapability(r.financialCapability),
    partners: partners(r.partners),
    isCompetitor: !!r.isCompetitor,
    competitorDetails: r.competitorDetails ?? null,
    ndaSigned: !!r.ndaSigned,
    status: r.status,
    submittedByName: r.submittedByName ?? null,
    sellerReviewedBy: r.sellerReviewedBy ?? null,
    sellerReviewedAt: r.sellerReviewedAt ?? null,
  };
}
