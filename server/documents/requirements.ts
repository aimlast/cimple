/**
 * Document Requirements — Auto-population from industry intelligence.
 *
 * Maps industry categories to the specific documents a deal needs.
 * Derived from server/interview/prompts/industry-intelligence.md.
 * CRITICAL fields → isRequired: true, IMPORTANT fields → isRequired: false.
 *
 * populateDocumentRequirements() is idempotent — safe to call multiple
 * times for the same deal (skips existing entries by documentName).
 */
import { storage } from "../storage";

interface DocRequirement {
  documentName: string;
  category: "financial" | "legal" | "operational" | "tax" | "compliance";
  isRequired: boolean;
}

// ─── Universal documents (every deal regardless of industry) ──────────
const UNIVERSAL_DOCS: DocRequirement[] = [
  // Financial — CRITICAL
  { documentName: "Financial Statements (3 Years)", category: "financial", isRequired: true },
  { documentName: "Balance Sheet (Current Year)", category: "financial", isRequired: true },
  { documentName: "Accounts Receivable Aging", category: "financial", isRequired: true },
  { documentName: "Debt Obligations Summary", category: "financial", isRequired: true },
  { documentName: "Bank Statements (3 Months)", category: "financial", isRequired: true },
  // Tax — CRITICAL
  { documentName: "Tax Returns (3 Years)", category: "tax", isRequired: true },
  // Legal — CRITICAL
  { documentName: "Commercial Lease Agreement", category: "legal", isRequired: true },
  { documentName: "Business Licenses and Permits", category: "compliance", isRequired: true },
  // Legal/HR — IMPORTANT
  { documentName: "Employment Agreements", category: "legal", isRequired: false },
  { documentName: "Insurance Policies Summary", category: "legal", isRequired: false },
  // Operational — IMPORTANT
  { documentName: "Asset and Equipment List", category: "operational", isRequired: false },
  { documentName: "Organizational Chart", category: "operational", isRequired: false },
];

// ─── Industry-specific document requirements ──────────────────────────
const INDUSTRY_DOCS: Record<string, DocRequirement[]> = {
  // ── Construction (Section 1) ──
  construction: [
    { documentName: "Contractor License Certificates", category: "compliance", isRequired: true },
    { documentName: "Trade Certifications (Key Employees)", category: "compliance", isRequired: true },
    { documentName: "Surety Bonding Capacity Letter", category: "financial", isRequired: true },
    { documentName: "Bond Claim History", category: "financial", isRequired: true },
    { documentName: "Work-in-Progress (WIP) Schedule", category: "financial", isRequired: true },
    { documentName: "Holdbacks Receivable Report", category: "financial", isRequired: true },
    { documentName: "Signed Backlog / Contract List", category: "operational", isRequired: true },
    { documentName: "Subcontractor Agreements", category: "legal", isRequired: true },
    { documentName: "Equipment List with Ownership Status", category: "operational", isRequired: true },
    { documentName: "WSIB/WCB Clearance Certificate", category: "compliance", isRequired: true },
    { documentName: "EMR (Experience Modification Rate) History", category: "compliance", isRequired: true },
    { documentName: "Health and Safety Program Documentation", category: "compliance", isRequired: true },
    { documentName: "Equipment Lease Agreements", category: "legal", isRequired: false },
    { documentName: "Service/Maintenance Contracts", category: "legal", isRequired: false },
  ],

  // ── Healthcare (Section 2) ──
  healthcare: [
    { documentName: "Physician/Practitioner Agreements", category: "legal", isRequired: true },
    { documentName: "Billing Number Documentation", category: "compliance", isRequired: true },
    { documentName: "Professional Licenses (All Practitioners)", category: "compliance", isRequired: true },
    { documentName: "Patient Volume Reports (12 Months)", category: "operational", isRequired: true },
    { documentName: "Insurance/Payer Contracts", category: "legal", isRequired: true },
    { documentName: "EMR System Documentation", category: "operational", isRequired: true },
    { documentName: "Regulatory Compliance Records", category: "compliance", isRequired: true },
    { documentName: "Professional Liability Insurance", category: "legal", isRequired: true },
    { documentName: "Equipment List with Service Records", category: "operational", isRequired: false },
    { documentName: "Patient Satisfaction Surveys", category: "operational", isRequired: false },
  ],

  // ── Restaurant & Food Service (Section 3) ──
  restaurant_food_service: [
    { documentName: "Liquor License Certificate", category: "compliance", isRequired: true },
    { documentName: "Health Inspection Records (2 Years)", category: "compliance", isRequired: true },
    { documentName: "Food Safety Certifications", category: "compliance", isRequired: true },
    { documentName: "Kitchen Equipment List (Owned/Leased)", category: "operational", isRequired: true },
    { documentName: "Lease Assignment/Consent Documentation", category: "legal", isRequired: true },
    { documentName: "POS System Sales Reports (12 Months)", category: "financial", isRequired: true },
    { documentName: "Grease Trap Maintenance Records", category: "compliance", isRequired: false },
    { documentName: "Supplier Agreements and Pricing", category: "operational", isRequired: false },
    { documentName: "Equipment Lease Agreements", category: "legal", isRequired: false },
    { documentName: "Franchise Agreement", category: "legal", isRequired: false },
  ],

  // ── Manufacturing (Section 4) ──
  manufacturing: [
    { documentName: "Quality Certifications (ISO, AS9100, etc.)", category: "compliance", isRequired: true },
    { documentName: "Customer Contracts (Top 5)", category: "legal", isRequired: true },
    { documentName: "Equipment List with Age and Condition", category: "operational", isRequired: true },
    { documentName: "Equipment Ownership/Financing Documentation", category: "legal", isRequired: true },
    { documentName: "Preventive Maintenance Program Records", category: "operational", isRequired: true },
    { documentName: "Environmental Permits and Approvals", category: "compliance", isRequired: true },
    { documentName: "IP Documentation (Patents, Trademarks)", category: "legal", isRequired: true },
    { documentName: "Raw Material Supply Agreements", category: "legal", isRequired: true },
    { documentName: "Tooling/Dies/Molds Ownership Records", category: "operational", isRequired: true },
    { documentName: "Inventory Records (Current)", category: "financial", isRequired: true },
    { documentName: "Union/Collective Agreements", category: "legal", isRequired: false },
    { documentName: "Building Condition Assessment", category: "operational", isRequired: false },
  ],

  // ── Professional Services (Section 5) ──
  professional_services: [
    { documentName: "Client List with Revenue Breakdown", category: "financial", isRequired: true },
    { documentName: "Client Engagement Letters/Contracts", category: "legal", isRequired: true },
    { documentName: "Professional License/Registration", category: "compliance", isRequired: true },
    { documentName: "Professional Liability Insurance (E&O)", category: "legal", isRequired: true },
    { documentName: "Work-in-Progress (WIP) Report", category: "financial", isRequired: true },
    { documentName: "Practice Management Software Records", category: "operational", isRequired: false },
    { documentName: "Staff Certifications and Credentials", category: "compliance", isRequired: false },
    { documentName: "Non-Compete/Non-Solicitation Agreements", category: "legal", isRequired: false },
  ],

  // ── Automotive (Section 6) ──
  automotive: [
    { documentName: "OMVIC/Dealer License", category: "compliance", isRequired: true },
    { documentName: "Environmental Compliance Records", category: "compliance", isRequired: true },
    { documentName: "Equipment and Lift Inspection Records", category: "operational", isRequired: true },
    { documentName: "Shop Equipment List with Condition", category: "operational", isRequired: true },
    { documentName: "Warranty Work Agreements (OEM)", category: "legal", isRequired: false },
    { documentName: "Parts Supplier Agreements", category: "operational", isRequired: false },
  ],

  // ── Retail (Section 7) ──
  retail: [
    { documentName: "POS System Sales Data (12 Months)", category: "financial", isRequired: true },
    { documentName: "Inventory Valuation (Current)", category: "financial", isRequired: true },
    { documentName: "Supplier/Vendor Agreements", category: "legal", isRequired: true },
    { documentName: "Franchise Agreement", category: "legal", isRequired: false },
    { documentName: "E-commerce Platform Analytics", category: "operational", isRequired: false },
    { documentName: "Loyalty Program Documentation", category: "operational", isRequired: false },
  ],

  // ── Wholesale & Distribution (Section 8) ──
  wholesale_distribution: [
    { documentName: "Exclusive Distribution Agreements", category: "legal", isRequired: true },
    { documentName: "Warehouse Lease Agreement", category: "legal", isRequired: true },
    { documentName: "Customer Contracts (Top 10)", category: "legal", isRequired: true },
    { documentName: "Inventory Management Records", category: "operational", isRequired: true },
    { documentName: "Fleet/Vehicle List and Ownership", category: "operational", isRequired: true },
    { documentName: "Supplier Credit Terms Documentation", category: "financial", isRequired: false },
  ],

  // ── Transportation & Logistics (Section 9) ──
  transportation_logistics: [
    { documentName: "Operating Authority (MC/DOT/CVOR)", category: "compliance", isRequired: true },
    { documentName: "Fleet List with Age and Condition", category: "operational", isRequired: true },
    { documentName: "Driver Abstracts and Licenses", category: "compliance", isRequired: true },
    { documentName: "Carrier Safety Rating/Profile", category: "compliance", isRequired: true },
    { documentName: "Customer Contracts", category: "legal", isRequired: true },
    { documentName: "Vehicle Maintenance Records", category: "operational", isRequired: true },
    { documentName: "Fleet Financing/Lease Agreements", category: "legal", isRequired: false },
    { documentName: "Cross-Border Permits (if applicable)", category: "compliance", isRequired: false },
  ],

  // ── Wellness, Fitness & Lifestyle (Section 10) ──
  wellness_fitness_lifestyle: [
    { documentName: "Membership Contracts and Terms", category: "legal", isRequired: true },
    { documentName: "Membership Database Export", category: "operational", isRequired: true },
    { documentName: "Equipment List with Age and Condition", category: "operational", isRequired: true },
    { documentName: "Instructor/Staff Certifications", category: "compliance", isRequired: true },
    { documentName: "Membership Churn/Retention Data (12 Months)", category: "financial", isRequired: true },
    { documentName: "Class/Appointment Booking Records", category: "operational", isRequired: false },
  ],

  // ── Education (Section 11) ──
  education: [
    { documentName: "Ministry/State Accreditation", category: "compliance", isRequired: true },
    { documentName: "Enrollment Records (3 Years)", category: "operational", isRequired: true },
    { documentName: "Curriculum Documentation", category: "operational", isRequired: true },
    { documentName: "Teacher/Instructor Credentials", category: "compliance", isRequired: true },
    { documentName: "Student Outcome/Completion Data", category: "operational", isRequired: false },
    { documentName: "Tuition Fee Schedule", category: "financial", isRequired: false },
  ],

  // ── Childcare & Entertainment (Section 12) ──
  childcare_entertainment: [
    { documentName: "Childcare License/Permit", category: "compliance", isRequired: true },
    { documentName: "Inspection Reports (2 Years)", category: "compliance", isRequired: true },
    { documentName: "Staff Certification Records (First Aid, ECE)", category: "compliance", isRequired: true },
    { documentName: "Parent/Client Contracts", category: "legal", isRequired: true },
    { documentName: "Enrollment/Waitlist Records", category: "operational", isRequired: true },
    { documentName: "Safety and Liability Insurance", category: "legal", isRequired: false },
  ],

  // ── Advertising, Media & Events (Section 13) ──
  advertising_media_events: [
    { documentName: "Client Contracts and Retainers", category: "legal", isRequired: true },
    { documentName: "Client Revenue Breakdown", category: "financial", isRequired: true },
    { documentName: "IP/Content Ownership Agreements", category: "legal", isRequired: true },
    { documentName: "Venue Contracts (if applicable)", category: "legal", isRequired: false },
    { documentName: "Freelancer/Contractor Agreements", category: "legal", isRequired: false },
  ],

  // ── Technology & Online (Section 14) ──
  technology_online: [
    { documentName: "Source Code Repository Access/Documentation", category: "operational", isRequired: true },
    { documentName: "SaaS Subscription/MRR Data (12 Months)", category: "financial", isRequired: true },
    { documentName: "Customer Contracts/Terms of Service", category: "legal", isRequired: true },
    { documentName: "IP Assignment Agreements", category: "legal", isRequired: true },
    { documentName: "Infrastructure/Hosting Documentation", category: "operational", isRequired: true },
    { documentName: "Security Audit/SOC2 Reports", category: "compliance", isRequired: false },
    { documentName: "Domain/Trademark Registrations", category: "legal", isRequired: false },
    { documentName: "Churn and Retention Analytics", category: "financial", isRequired: false },
  ],
};

/**
 * Populate document requirements for a deal based on its industry.
 *
 * Idempotent — skips any requirement whose documentName already exists
 * for this deal. Safe to call on deal creation and again if the industry
 * changes.
 *
 * @param dealId - The deal to populate requirements for
 * @param industryCategory - Industry key from industry-templates.json
 *   (e.g., "construction", "restaurant_food_service", "manufacturing")
 * @returns The number of new requirements created
 */
export async function populateDocumentRequirements(
  dealId: string,
  industryCategory: string,
): Promise<number> {
  // Get existing requirements to avoid duplicates
  const existing = await storage.getDocumentRequirementsByDeal(dealId);
  const existingNames = new Set(existing.map((r) => r.documentName));

  // Combine universal + industry-specific docs
  const industryDocs = INDUSTRY_DOCS[industryCategory] ?? [];
  const allDocs = [...UNIVERSAL_DOCS, ...industryDocs];

  let created = 0;
  for (let i = 0; i < allDocs.length; i++) {
    const doc = allDocs[i];
    if (existingNames.has(doc.documentName)) continue;

    await storage.createDocumentRequirement({
      dealId,
      documentName: doc.documentName,
      category: doc.category,
      isRequired: doc.isRequired,
      source: "auto",
      status: "missing",
      sortOrder: i,
    });
    created++;
  }

  return created;
}

/**
 * Get the list of supported industry categories for document requirements.
 */
export function getSupportedIndustries(): string[] {
  return Object.keys(INDUSTRY_DOCS);
}

// ─── Linking uploads to checklist rows ────────────────────────────────
//
// Checklist categories (financial / tax / legal / compliance / operational)
// are finer-grained than the document categories the parser understands
// (financials / legal / operations / marketing / transcripts / other). When
// an upload is matched to a checklist row we derive the parser category from
// the row so extraction runs with the right prompt instead of "other".

const REQUIREMENT_TO_DOC_CATEGORY: Record<string, string> = {
  financial: "financials",
  tax: "financials",
  legal: "legal",
  compliance: "legal",
  operational: "operations",
};

export function docCategoryForRequirement(requirementCategory: string): string {
  return REQUIREMENT_TO_DOC_CATEGORY[requirementCategory] ?? "other";
}

const NAME_STOPWORDS = new Set([
  "the", "and", "for", "years", "year", "months", "month", "current", "key",
  "list", "summary", "report", "copy", "copies", "pdf", "final", "draft",
]);

function keywords(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !NAME_STOPWORDS.has(w));
}

// How brokers and accountants actually name the files, mapped onto the
// words the checklist rows use. Applied to the file name only.
const FILE_ALIASES: Array<[RegExp, string[]]> = [
  [/\b(p\s*&\s*l|pnl|p\s*and\s*l|profit\s*(and|&)\s*loss|income\s*statement)s?\b/i, ["financial", "statements"]],
  [/\b(t1|t2|1120s?|1040|1065|tax\s*return)s?\b/i, ["tax", "returns"]],
  [/\b(ar|a\/r|a\.r\.|receivables?)\b/i, ["accounts", "receivable"]],
];

function fileKeywords(fileName: string): Set<string> {
  const words = new Set(keywords(fileName));
  for (const [pattern, extra] of FILE_ALIASES) {
    if (pattern.test(fileName)) extra.forEach((w) => words.add(w));
  }
  return words;
}

interface LinkableRequirement {
  id: string;
  documentName: string;
  category: string;
  status: string;
  sortOrder?: number | null;
}

/**
 * Best-effort match of an uploaded file to an open checklist row by the
 * words in the row's name, gated by category so a "statement" never lands
 * on a legal row. Returns nothing when the match is ambiguous — a wrong
 * credit is worse than no credit.
 */
export function findMatchingRequirement<T extends LinkableRequirement>(
  requirements: T[],
  fileName: string,
  docCategory: string,
): T | undefined {
  // Transcripts and marketing collateral are never checklist items.
  if (docCategory === "transcripts" || docCategory === "marketing") return undefined;
  const fileWords = fileKeywords(fileName);
  if (fileWords.size === 0) return undefined;

  const candidates = requirements.filter((r) => {
    if (r.status !== "missing") return false;
    if (docCategory === "other") return true;
    return docCategoryForRequirement(r.category) === docCategory;
  });

  const scored = candidates
    .map((r) => {
      const words = keywords(r.documentName);
      const hits = words.filter((w) => fileWords.has(w)).length;
      return { r, hits, total: words.length };
    })
    .filter((s) => s.hits > 0)
    .sort((a, b) => b.hits - a.hits || (a.r.sortOrder ?? 0) - (b.r.sortOrder ?? 0));

  const [best, second] = scored;
  if (!best) return undefined;
  // A single shared word ("statements") matching two rows is a coin flip.
  if (second && second.hits === best.hits && best.hits < 2) return undefined;
  return best.r;
}

/**
 * Link an upload to a specific checklist row (explicit requirementId) or to
 * the best keyword match when none was given. Returns the linked row, or
 * null when nothing matched. Never throws — a failed link must not fail
 * the upload that triggered it.
 */
export async function linkUploadToRequirement(opts: {
  dealId: string;
  docId: string;
  fileName: string;
  docCategory: string;
  uploadedBy: "broker" | "seller";
  requirementId?: string;
}): Promise<{ id: string; documentName: string; category: string } | null> {
  try {
    const requirements = await storage.getDocumentRequirementsByDeal(opts.dealId);
    const target = opts.requirementId
      ? requirements.find((r) => r.id === opts.requirementId)
      : findMatchingRequirement(requirements, opts.fileName, opts.docCategory);
    if (!target) return null;
    await storage.updateDocumentRequirement(target.id, {
      status: "uploaded",
      uploadedFileId: opts.docId,
      uploadedBy: opts.uploadedBy,
      uploadedAt: new Date(),
    });
    return { id: target.id, documentName: target.documentName, category: target.category };
  } catch (err) {
    console.warn(`[documents] could not link upload ${opts.docId} to a checklist row:`, err);
    return null;
  }
}
