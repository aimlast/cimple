// The Ridgeline clone's private notes after the acceptance-test reprocess
// (2026-09-26, 35 notes), rebuilt from the recorded artefacts: each note's
// text and every source's own words as the run stored them, and the facts on
// file that bear on them. Fictional business (demo seed).

export const RIDGE_DOCS = new Map<string, any>([
  ["crm1", { id: "crm1", name: "CRM note — referral & first call", visibility: "broker_only", sourceKind: "crm" }],
  ["emailUsa", { id: "emailUsa", name: "Email thread — USA / ROFR waiver, Luis's equity", visibility: "shared", sourceKind: "email" }],
  ["call", { id: "call", name: "Phone call — Morgan Ellis & Gord McAllister (discovery deep-dive)", visibility: "shared", sourceKind: "call" }],
  ["crmSite", { id: "crmSite", name: "CRM note — site visit", visibility: "broker_only", sourceKind: "crm" }],
  ["emailDocs", { id: "emailDocs", name: "Email thread — document request & Gord's add-backs", visibility: "shared", sourceKind: "email" }],
  ["fs2024", { id: "fs2024", name: "Compiled financial statements FY2024", visibility: "shared", sourceKind: "document" }],
  ["crmTeams", { id: "crmTeams", name: "CRM note — after Teams call", visibility: "broker_only", sourceKind: "crm" }],
  ["minute", { id: "minute", name: "Minute book extract (articles, by-laws, resolutions)", visibility: "shared", sourceKind: "document" }],
  ["teams", { id: "teams", name: "Teams video call — Morgan Ellis, Gord McAllister & Luis Ortega (operations)", visibility: "shared", sourceKind: "video_call" }],
  ["lease", { id: "lease", name: "Related-party industrial lease — McAllister Properties Ltd.", visibility: "shared", sourceKind: "document" }],
  ["t2", { id: "t2", name: "T2 corporate tax return 2024 (client copy)", visibility: "shared", sourceKind: "document" }],
  ["emailAcct", { id: "emailAcct", name: "Email thread — accountant Heather Kwan", visibility: "shared", sourceKind: "email" }],
  ["wip", { id: "wip", name: "WIP & backlog report as of May 31, 2025 (+ open quotes)", visibility: "shared", sourceKind: "document" }],
]);

const bo = (documentId: string, wording?: string) => ({ documentId, brokerOnly: true, ...(wording ? { wording } : {}) });
const sh = (documentId: string, wording?: string) => ({ documentId, ...(wording ? { wording } : {}) });
const note = (text: string, first: Record<string, unknown>, ...also: Array<Record<string, unknown>>) =>
  ({ note: text, ...first, ...(also.length > 0 ? { alsoFrom: also } : {}) });

export const RIDGE_NOTES = [
  note("Seller wants out by early 2026 / done by end of Q1 2026.", bo("crm1", "Owner wants out by early 2026"),
    sh("emailUsa", "Gord's target timing: done by end of Q1 2026"), sh("emailUsa", "Gord's personal timeline: wants to be done by end of Q1 2026 (next year)")),
  note("Seller's daughter and 2 grandchildren live in Kelowna BC; seller's wife Donna wants to relocate there.", bo("crm1", "Grandkids in Kelowna"),
    sh("call", "Seller's daughter and two grandchildren live in Kelowna BC, seller's wife Donna wants to relocate there")),
  note("Acquisition interest: Jackpine (competitor, 60+ employees) approached seller 2 years ago with offer around 3x earnings. Seller declined due to concern about shop closure and employee impact. Indicates strategic buyer interest in market", sh("call"),
    bo("crm1", "Competitor sniffed around a couple yrs ago with insulting number")),
  note("Luis Ortega confirmed 15% ownership stake.", bo("crmSite", "Luis confirmed 15% ownership stake")),
  note("Donna McAllister (Gord's wife) does books part-time; was out at their daughter's for a week in late May 2025.", bo("crmSite", "Gord's wife Donna does books part-time"),
    sh("emailDocs", "Donna McAllister (Gord's wife or family member) was out at their daughter's for a week"), sh("emailDocs", "Gord and Donna's daughter mentioned - Donna was out at daughter's for a week around late May")),
  note("Devin P. (chief estimator) — no employment contract, need to check / needs verification.", bo("crmSite", "No employment contract for key estimator Devin P. - needs verification"),
    bo("crmSite", "Devin P. (chief estimator) — no employment contract, need to check.")),
  note("Gord references 'my truck + personal stuff through the company' suggesting personal use of business assets.", sh("emailDocs")),
  note("Seller wants to use capital gains exemption via share sale (tax planning); Heather (accountant) says he can use capital gains exemption on share sale.",
    sh("emailUsa", "Gord's tax planning: Heather (presumably accountant/advisor) says he can use capital gains exemption on share sale")),
  note("Seller willing to carry 15-20% seller financing for 3 years but wants most cash at closing ('not half' - has seen others not get paid).",
    sh("emailUsa", "Gord willing to carry 15-20% seller financing for 3 years but wants most cash at closing"),
    sh("emailUsa", "Gord's negotiation position: wants most of purchase price at closing, would carry 15-20%"),
    sh("call", "Seller personal negotiation position: will carry 15-20% financing but 'not half'")),
  note("Building owned by Gord's holdco McAllister Properties Ltd., majority shareholder controls McAllister Properties Ltd. which owns the leased property, wants real estate kept separate from $6.5M business price.",
    sh("emailUsa", "Building owned by Gord's holdco McAllister Properties, wants real estate kept separate from $6.5M business price"),
    sh("fs2024", "Majority shareholder controls McAllister Properties Ltd. which owns the leased property")),
  note("Broker's negotiation notes: Ask 6.5M; buyer universe includes strategic fabricators (Jackpine approached in 2023 at ~3x) and PE industrial platforms; Gord's floor/negotiation strategy: Asking $6.5M, approached by Jackpine in 2023 at ~3x (broker noting for pricing context)",
    bo("crmTeams", "Gord's floor/negotiation strategy: Asking $6.5M, approached by Jackpine in 2023 at ~3x (broker noting for pricing context)"),
    bo("crmTeams", "Broker's negotiation notes: Ask 6.5M; buyer universe includes strategic fabricators (Jackpine approached in 2023 at ~3x) and PE industrial platforms")),
  note("Gord (owner/seller) had cardiac episode last October (October 2024), stent placed, back to work in 2 weeks, doctor advised to slow down — this is partial motivation/real trigger for the sale timeline. Gord explicitly asked this stay out of the CIM and any marketing materials: 'I don't want that in a brochure'",
    bo("crmTeams", "Owner (Gord) had cardiac episode last Oct — marked PRIVATE, do not put in CIM"),
    sh("call", "Seller had heart episode October 2024, stent placed, back to work in 2 weeks, doctor advised to slow down"),
    { turn: 4, wording: "Seller had a cardiac event in October 2024 (stent placed), doctor advised him to slow down" },
    sh("call", "Seller stated 'don't want it in any brochure' regarding the heart episode")),
  note("Broker's strategy note: Better to frame Larkspur vendor consolidation proactively rather than let buyer DD find it.", bo("crmTeams")),
  note("Class D dividend of $60,000 declared December 16, 2024 payable only to Gord McAllister (100 Class D shares), no dividend to Class A shareholders", sh("minute")),
  note("Financial statements are unaudited compilation - no audit or review procedures performed", sh("fs2024")),
  note("Luis Ortega personal: came to Canada from Mexico in 1999, age 47, married (needs to consult wife about equity retention post-sale)", sh("teams"),
    sh("teams", "Luis Ortega is 47 years old"), sh("teams", "Luis would need to consult with his wife before deciding on retaining equity stake")),
  note("Gord appears dismissive of operational concerns raised by Luis (Westlock PO, Larkspur consolidation, Devin retention) while Luis provides more realistic operational assessment.", sh("teams"),
    sh("teams", "Gord McAllister confident/dismissive of Larkspur consolidation risk and Westlock PO timing")),
  note("Seller's grandson played on Leduc junior hockey team (context for $12k sponsorship).", sh("call")),
  note("Seller is 64 years old", sh("call")),
  note("Coldbrook $38k receivable dispute is source of stress for seller ('don't want to make a big deal of it').", sh("call")),
  note("Seller confidentiality concern: only Luis, Donna, and Heather know about sale; Devin and other key staff not yet informed.", sh("call")),
  note("Shareholder agreement amended November 2024: Luis waives first refusal if Gord sells 100% to outside buyer, receives same price per share or can retain shares if buyer agrees, 80% vote forces sale — this is a company transaction matter, recorded in business fields.", sh("teams")),
  note("Morgan Ellis (broker) positioning for buyer diligence, will follow up on shareholder agreement and building in writing — process notes, recorded in actionItems/followUpNeeded.", sh("teams")),
  note("Minute book extract prepared June 2025 for corporation's advisers; marked confidential", sh("minute")),
  note("Market rent opinion by Harlan & Voss Appraisals Ltd.; (Dec 6, 2021) based on five comparable crane-served industrial building leases (20,000-40,000 sq ft) in Nisku/Leduc executed 2020-2021 supports fair market net rent range of $11.25-$11.75/sq ft as at Jan 1, 2022, with customary escalations of 4-5% at renewal", sh("lease")),
  note("Morgan Ellis: Brassline engaged by Ridgeline per board resolution April 7, 2025 to advise on potential sale — deal process detail, not a business fact; Broker (Morgan Ellis) engagement terms and fee structure under discussion - engagement paper to be signed per March 19 message",
    sh("emailDocs", "Broker (Morgan Ellis) engagement terms and fee structure under discussion - engagement paper to be signed per March 19 message"),
    sh("emailAcct", "Morgan Ellis: Brassline engaged by Ridgeline per board resolution April 7, 2025 to advise on potential sale — deal process detail, not a business fact"),
    bo("crmSite", "Engagement letter signed; board resolution Apr 7 confirms Brassline as broker.")),
  note("Seller wants buyers looking at 1.8 adjusted EBITDA figure, believes entire $260k salary comes back as it all goes to him.",
    sh("emailDocs", "Gord's negotiation position: wants buyers looking at 1.8 adjusted EBITDA figure, believes entire $260k salary comes back")),
  note("Gord McAllister owns 85% voting common shares, SIN redacted", sh("t2")),
  note("Luis Ortega owns 15% voting common shares, SIN redacted", sh("t2")),
  note("Associated with McAllister Properties Ltd. (BN 74388 1052 RC0001) — business limit allocation: Ridgeline $500,000, McAllister Properties $0", sh("t2")),
  note("Corporate-owned buy-sell life insurance policies in place (premiums $15,000)", sh("t2")),
  note("Email dated May 20, 23, 27, 2025 and June 2, 2025 — contact/process timeline only", sh("emailAcct")),
  note("FY24 comp statements done Mar 28. Heather to send FY22-24 + T2s once Gord OKs", bo("crmSite")),
  note("Gord keeps saying 'four million in the backlog' — need to ask for WIP report to verify.", bo("crmSite")),
  note("Owner wants to spend time with grandkids in Kelowna", { questionnaire: true }),
];

export const RIDGE_FACTS: Record<string, unknown> = {
  ownerName: "Gord McAllister",
  ownerAge: "64",
  entityType: "Alberta private corporation. Class A voting: Gord McAllister 85%, Luis Ortega 15%. Class D discretionary dividend shares: Gord 100%. Real estate held in McAllister Properties Ltd.",
  shareholders: "Gord McAllister: 850 Class A (85.0%) + 100 Class D; Luis Ortega: 150 Class A (15.0%)",
  auditStatus: "Heather Kwan (accountant): Compiled financial statements for FY2022, FY2023, FY2024. Compilation does not include review of cost-to-complete estimates.",
  engagementType: "Compilation (CSRS 4200)",
  accountant: "Heather Kwan at Kwan & Brodeur",
  dividends: "$40,000 declared and paid on Class D shares in both 2022 and 2021",
  dividendsPaid: "$60,000",
  dividendsDeclaredByYear: { "2024": "$60,000" },
  resolutions: "November 18, 2024: Approved First Amending Agreement to Unanimous Shareholder Agreement; December 16, 2024: Declared $60,000 dividend on Class D shares; March 3, 2025: Approved the engagement of an adviser",
  legalNotes: "Shareholder agreement amended November 18, 2024. Amendment: Luis's right of first refusal switched off for sale of 100% of shares to arm's-length buyer closing before November 18, 2026.",
  insurance: "Insurance: $94,000 (2024), $88,000 (2023)",
  insuranceExpense: "$94,000 general insurance plus $16,000 non-deductible life insurance premiums for corporate-owned buy-sell policies",
  lifeInsurance: "Gord McAllister: $1,500,000; Luis Ortega: $500,000",
  reasonForSale: "Owner retirement (seller age 64, daughter and grandchildren in Kelowna, BC, spouse Donna wants to relocate)",
  advisors: "Brassline Advisory Partners (Morgan Ellis, Senior Advisor) - engaged April 2025 to advise on potential sale",
  backlog: "$3,100,000",
  managementTeam: "Luis (operations manager, 15% owner), Mark (welding supervisor), Devin Pritchard (chief estimator since 2012), Tanya (project manager). Owner Gord handles all sales.",
  companyHistory: "Luis Ortega hired by Gord McAllister in 2004 as journeyman welder, became lead hand then foreman 2010, purchased 15% equity in 2016.",
  saleType: "Preference for share sale to utilize capital gains exemption. Seller willing to carry 15-20% seller financing (not 50%).",
  leaseDetails: "Five-year term January 1, 2022 to December 31, 2026. Basic Rent: Years 1-2 $11.50/sq ft per annum ($322,000 annually, $26,833.33 monthly); Years 3-5 $12.00/sq ft.",
  _fieldSources: {
    backlog: { source: "document", documentId: "wip", specialist: true },
  },
  _fieldAlternates: {
    backlog: [
      { value: "~four million", source: "crm", documentId: "crmSite", brokerOnly: true },
      { value: "$4.2M as of end of May 2025 (best level since 2014)", source: "call", documentId: "call" },
    ],
  },
};

export function ridgeInfo(): Record<string, unknown> {
  return JSON.parse(JSON.stringify({ ...RIDGE_FACTS, _brokerPrivateNotes: RIDGE_NOTES }));
}
