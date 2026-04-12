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
