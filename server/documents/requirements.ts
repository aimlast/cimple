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
import { matchIndustrySection } from "../interview/industry-loader";
import { withoutSellerUnavailableNote } from "@shared/seller-portal";

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

// ─── Which industry list a deal gets ──────────────────────────────────
//
// Deals carry the New Deal label ("Restaurant / Food Service", "Healthcare"),
// a CRM's free text, or what the interview identified — never these keys.
// Looking the label up directly found nothing, so every deal got only the
// universal rows (production, 2026-09-28: Maple & Main, Clearwater, Great
// Lakes… all exactly 12). The interview's own industry matcher
// (industry-loader.ts, corpus sections 1–14) resolves the text; its section
// number is industry-templates.json's mdSection for the same key.
const SECTION_TO_INDUSTRY_KEY: Record<number, string> = {
  1: "construction",
  2: "healthcare",
  3: "restaurant_food_service",
  4: "manufacturing",
  5: "professional_services",
  6: "automotive",
  7: "retail",
  8: "wholesale_distribution",
  9: "transportation_logistics",
  10: "wellness_fitness_lifestyle",
  11: "education",
  12: "childcare_entertainment",
  13: "advertising_media_events",
  14: "technology_online",
};

/** The INDUSTRY_DOCS key for a deal's industry (a key itself, a New Deal label, CRM or interview text), or null. */
export function industryDocsKey(industry: string | null | undefined, subIndustry?: string | null): string | null {
  const text = (industry ?? "").trim();
  if (text && INDUSTRY_DOCS[text]) return text;
  // The industry itself decides; the sub-industry only when the industry
  // says nothing ("Other", "Home Services"). Read together, a manufacturer
  // "for commercial construction" or "medical device components", or an MSP
  // "for dental practices", matched the wrong list first.
  // A store that sells products online is asked for sales, inventory and
  // supplier records (the retail list, which has e-commerce analytics) —
  // not source code and MRR (the software list the playbook files it with).
  const both = `${text} ${subIndustry ?? ""}`;
  if (/e-?commerce|online (?:store|shop|retail)|amazon|shopify|\bfba\b|direct[- ]to[- ]consumer|\bdtc\b/i.test(both) && !/\bsaas\b|software|\bapps?\b|marketplace platform/i.test(both)) {
    return "retail";
  }
  const section = matchIndustrySection(text, null) ?? matchIndustrySection(subIndustry ?? null, null);
  return section != null ? SECTION_TO_INDUSTRY_KEY[section] ?? null : null;
}

/** The universal rows plus the industry's own. */
export function requirementsForIndustry(industry: string | null | undefined, subIndustry?: string | null): DocRequirement[] {
  const key = industryDocsKey(industry, subIndustry);
  return [...UNIVERSAL_DOCS, ...(key ? INDUSTRY_DOCS[key] : [])];
}

const populating = new Map<string, Promise<number>>();
/** deal|industry key pairs already populated by this process (the interview asks every turn). */
const populated = new Set<string>();

/**
 * Adds the industry's rows once the deal's industry is known or changes
 * (New Deal, the broker's edit, the interview identifying it). Idempotent,
 * one run per deal at a time, never throws. Resolves to the rows added.
 */
export function ensureIndustryDocumentRequirements(
  dealId: string,
  industry: string | null | undefined,
  subIndustry?: string | null,
): Promise<number> {
  const key = industryDocsKey(industry, subIndustry);
  const memo = `${dealId}|${key ?? ""}`;
  if (populated.has(memo)) return Promise.resolve(0);
  const prev = populating.get(dealId) ?? Promise.resolve(0);
  const run = prev
    .catch(() => 0)
    .then(async () => {
      const n = await populateDocumentRequirements(dealId, industry, subIndustry);
      populated.add(memo);
      return n;
    })
    .catch((err) => {
      console.warn(`[requirements] couldn't add the industry's document requests on deal ${dealId}:`, err);
      return 0;
    });
  populating.set(dealId, run);
  void run.finally(() => {
    if (populating.get(dealId) === run) populating.delete(dealId);
  });
  return run;
}

/**
 * Populate document requirements for a deal based on its industry.
 *
 * Idempotent — skips any requirement whose documentName already exists
 * for this deal. Safe to call on deal creation and again if the industry
 * changes.
 *
 * @param dealId - The deal to populate requirements for
 * @param industryCategory - The deal's industry: a key from
 *   industry-templates.json ("construction") or the deal's own text
 *   ("Restaurant / Food Service") — resolved by industryDocsKey
 * @returns The number of new requirements created
 */
export async function populateDocumentRequirements(
  dealId: string,
  industryCategory: string | null | undefined,
  subIndustry?: string | null,
): Promise<number> {
  // Get existing requirements to avoid duplicates
  const existing = await storage.getDocumentRequirementsByDeal(dealId);
  const existingNames = new Set(existing.map((r) => r.documentName));

  // Combine universal + industry-specific docs
  const allDocs = requirementsForIndustry(industryCategory, subIndustry);

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
 * Rows another industry's list added that nobody has touched: auto-added,
 * still missing, no file, no note, and not on the deal's list now. When the
 * broker corrects the industry (a construction deal that is really a
 * restaurant), these stop being asked for; anything the seller uploaded to,
 * marked, or the broker annotated stays. Pure.
 */
export function untouchedOtherIndustryRows<
  T extends { id: string; documentName: string; source?: string | null; status?: string | null; uploadedFileId?: string | null; notes?: string | null },
>(rows: T[], industry: string | null | undefined, subIndustry?: string | null): T[] {
  const keep = new Set(requirementsForIndustry(industry, subIndustry).map((r) => r.documentName));
  const industryNames = new Set(Object.values(INDUSTRY_DOCS).flat().map((r) => r.documentName));
  return rows.filter(
    (r) =>
      r.source === "auto" &&
      r.status === "missing" &&
      !r.uploadedFileId &&
      !(r.notes ?? "").trim() &&
      industryNames.has(r.documentName) &&
      !keep.has(r.documentName),
  );
}

/**
 * The broker changed the deal's industry: the old industry's untouched
 * requests go, the new one's are added. (Only on the broker's own edit —
 * the interview's identification only ever adds.) Never throws.
 */
export async function switchIndustryDocumentRequirements(
  dealId: string,
  industry: string | null | undefined,
  subIndustry?: string | null,
): Promise<{ removed: number; added: number }> {
  let removed = 0;
  try {
    const stale = untouchedOtherIndustryRows(await storage.getDocumentRequirementsByDeal(dealId), industry, subIndustry);
    for (const r of stale) {
      await storage.deleteDocumentRequirement(r.id);
      removed++;
    }
  } catch (err) {
    console.warn(`[requirements] couldn't clear the old industry's document requests on deal ${dealId}:`, err);
  }
  // (Switching back later must add the rows again — forget what was added.)
  for (const memo of Array.from(populated)) if (memo.startsWith(`${dealId}|`)) populated.delete(memo);
  const added = await ensureIndustryDocumentRequirements(dealId, industry, subIndustry);
  return { removed, added };
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

/**
 * The category an upload keeps once it is linked to a checklist row: an
 * uncategorised one ("other" — "2024 P&L.pdf" dropped outside the
 * checklist, matched to "Financial Statements" by its name) takes the
 * row's; an upload the broker or seller already categorised keeps its own.
 */
export function categoryAfterLink(category: string, linked: { category: string } | null | undefined): string {
  if (!linked || (category && category !== "other")) return category;
  const derived = docCategoryForRequirement(linked.category);
  return derived !== "other" ? derived : category;
}

const NAME_STOPWORDS = new Set([
  "the", "and", "for", "years", "year", "months", "month", "current", "key",
  "list", "summary", "report", "copy", "copies", "pdf", "final", "draft",
]);

/**
 * One spelling per word, so a file and a checklist row meet however each is
 * written: "licence"/"licenses" → "license", "statements" → "statement",
 * "policies" → "policy".
 */
function normWord(w: string): string {
  let x = w.replace(/^licen[cs]/, "licens");
  if (x.length > 5 && x.endsWith("ies")) x = x.slice(0, -3) + "y";
  else if (/(?:x|ch|sh|ss)es$/.test(x)) x = x.slice(0, -2);
  else if (x.length > 4 && x.endsWith("s") && !/(?:ss|us)$/.test(x)) x = x.slice(0, -1);
  return x.replace(/^licens(e|ing)?$/, "license");
}

function keywords(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !NAME_STOPWORDS.has(w))
    .map(normWord);
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
    if (pattern.test(fileName)) extra.forEach((w) => words.add(normWord(w)));
  }
  return words;
}

/**
 * Words too common in document names to identify a checklist row on their
 * own: "Financial statements FY2023" shares "statements" with "Bank
 * Statements (3 Months)". A match needs two shared words, or one
 * distinguishing word. ("Lease" and "licence" do identify a row: any lease
 * file is the lease. An e-mail about a yard lease is kept out by its kind —
 * only documents are matched by name.)
 */
const GENERIC_NAME_WORDS = new Set([
  "statement", "statements", "financial", "financials", "agreement", "agreements", "report", "reports",
  "document", "documents", "records", "record", "schedule", "schedules", "contract",
  "contracts", "details", "detail", "information", "info", "business", "company", "file", "files", "data",
  "tax", "taxes", "return", "returns", "form", "forms", "letter", "letters", "notes", "policy", "policies",
  "plan", "plans", "email", "thread", "call", "transcript", "renewal", "annual", "monthly", "quarterly", "bank",
].map(normWord));

/** Only a document upload is matched to a checklist row by name (no kind = an older caller: a document). */
export function autoLinkableKind(sourceKind: string | null | undefined): boolean {
  return !sourceKind || sourceKind === "document";
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
  // Correspondence about a document is not the document ("Email thread -
  // yard lease renewal", "RE: lease", a printed e-mail uploaded as a file).
  if (/\b(?:e-?mails?|thread|correspondence)\b|^\s*(?:re|fwd?)\s*:/i.test(fileName)) return undefined;
  const fileWords = fileKeywords(fileName);
  if (fileWords.size === 0) return undefined;

  // The category must match. An upload with no category ("other" — a
  // seller dropping "Lease.pdf" outside the checklist) may match any row,
  // but only on a word that identifies it, or on every word of the row's
  // name ("Financial statements FY2023" → "Financial Statements (3 Years)").
  const uncategorised = docCategory === "other";
  const candidates = requirements.filter(
    (r) => (r.status === "missing" || r.status === "unavailable") && (uncategorised || docCategoryForRequirement(r.category) === docCategory),
  );

  const scored = candidates
    .map((r) => {
      const words = Array.from(new Set(keywords(r.documentName)));
      const shared = words.filter((w) => fileWords.has(w));
      const distinguishing = shared.filter((w) => !GENERIC_NAME_WORDS.has(w)).length;
      return { r, hits: shared.length, distinguishing, total: words.length };
    })
    // Two shared words, or one word that actually identifies the row.
    .filter((s) => s.distinguishing >= 1 || (s.hits >= 2 && (!uncategorised || s.hits === s.total)))
    .sort((a, b) => b.hits - a.hits || b.distinguishing - a.distinguishing || (a.r.sortOrder ?? 0) - (b.r.sortOrder ?? 0));

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
  /** What kind of source the upload is — only a document is matched to a row by its name. */
  sourceKind?: string;
}): Promise<{ id: string; documentName: string; category: string } | null> {
  try {
    // An email, a call transcript or a CRM note is never the requested
    // document itself ("Email thread — yard lease renewal" is not the lease).
    // An explicit row choice still counts.
    if (!opts.requirementId && !autoLinkableKind(opts.sourceKind)) return null;
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
      // (A new copy replaces the one that couldn't be read: that line goes.)
      // (Nor does a "Seller: I don't have this" line — they found it.)
      ...("notes" in target ? { notes: withoutSellerUnavailableNote(withoutUnreadableNote((target as { notes?: string | null }).notes)) } : {}),
    });
    return { id: target.id, documentName: target.documentName, category: target.category };
  } catch (err) {
    console.warn(`[documents] could not link upload ${opts.docId} to a checklist row:`, err);
    return null;
  }
}

/**
 * Takes a source off every checklist row it was credited to (the row goes
 * back to "missing", with no file): used when the source is deleted — by the
 * broker or the seller — and when it turns out to have no readable text (a
 * scanned image, a .doc file). The seller's document count then shows the
 * gap and the seller is asked again; a row the broker had verified can take
 * a replacement upload. Never throws.
 */
export async function releaseRequirementsFor(
  dealId: string,
  docId: string,
  /** Set when the source turned out to have no readable text: the seller's row says so. */
  unreadable?: { fileName: string; reason: string },
): Promise<number> {
  try {
    const requirements = await storage.getDocumentRequirementsByDeal(dealId);
    const released = requirements.filter((r) => r.uploadedFileId === docId);
    if (released.length === 0) return 0;
    // Another source on the deal that is this document (the final statements
    // after the draft was deleted): the row is credited to it instead of
    // going back to "missing" — never ask the seller for a document the deal holds.
    const remaining = (await storage.getDocumentsByDeal(dealId)).filter((d) => d.id !== docId);
    const credited = new Set(requirements.filter((r) => r.uploadedFileId && r.uploadedFileId !== docId).map((r) => r.uploadedFileId as string));
    let n = 0;
    for (const r of released) {
      const stand = replacementDocumentFor(r, remaining, credited);
      if (stand) {
        credited.add(stand.id);
        await storage.updateDocumentRequirement(r.id, {
          status: "uploaded",
          uploadedFileId: stand.id,
          uploadedBy: stand.uploadedBy === "seller" ? "seller" : "broker",
          uploadedAt: stand.createdAt ? new Date(stand.createdAt) : new Date(),
          notes: withoutUnreadableNote(r.notes),
        } as any);
      } else {
        await storage.updateDocumentRequirement(r.id, {
          status: "missing",
          uploadedFileId: null,
          uploadedBy: null,
          uploadedAt: null,
          ...(unreadable ? { notes: withUnreadableNote(r.notes, unreadable.fileName, unreadable.reason) } : {}),
        } as any);
      }
      n++;
    }
    return n;
  } catch (err) {
    console.warn(`[documents] could not release checklist rows for ${docId}:`, err);
    return 0;
  }
}

/** The document categories the parser files sources under. */
const KNOWN_DOC_CATEGORIES = new Set(["financials", "legal", "operations", "marketing", "transcripts", "other"]);

/** A source row as the checklist sees it. */
interface ChecklistSource {
  id: string;
  name: string;
  category?: string | null;
  sourceKind?: string | null;
  status?: string | null;
  uploadedBy?: string | null;
  createdAt?: Date | string | null;
}

/**
 * The remaining source that is the checklist row's document, or undefined:
 * a document (not an e-mail or a call about it), readable (not failed), not
 * already credited to another row, and one the row's own name would match
 * on upload (findMatchingRequirement, the same rule). The newest wins.
 */
export function replacementDocumentFor<T extends ChecklistSource>(
  row: Pick<LinkableRequirement, "id" | "documentName" | "category">,
  remaining: T[],
  credited: ReadonlySet<string> = new Set(),
): T | undefined {
  const asOpen = { ...row, status: "missing" };
  // (A category the parser doesn't use is read as none — then every word of the row's name must match.)
  const docCategory = (c: string | null | undefined) => (c && KNOWN_DOC_CATEGORIES.has(c) ? c : "other");
  const fits = remaining.filter((d) =>
    autoLinkableKind(d.sourceKind) && d.status !== "failed" && !credited.has(d.id) &&
    findMatchingRequirement([asOpen], d.name, docCategory(d.category)) !== undefined);
  return fits.sort((a, b) => +new Date(b.createdAt ?? 0) - +new Date(a.createdAt ?? 0))[0];
}

/** The line a checklist row carries when its upload couldn't be read. */
const UNREADABLE_NOTE_RE = /^We couldn't read [^\n]*?Please upload a readable copy\.(?: · )?/;

export function withUnreadableNote(notes: string | null | undefined, fileName: string, reason: string): string {
  const rest = withoutUnreadableNote(notes);
  const line = `We couldn't read "${fileName}" (${reason.replace(/[.\s]+$/, "")}). Please upload a readable copy.`;
  return rest ? `${line} · ${rest}` : line;
}

export function withoutUnreadableNote(notes: string | null | undefined): string | null {
  const rest = (notes ?? "").replace(UNREADABLE_NOTE_RE, "").trim();
  return rest || null;
}
