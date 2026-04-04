# Industry Intelligence — Cimple Interview Agent

## Source of truth for industry-specific interview questions, buyer priorities, due diligence requirements, and jurisdiction-specific regulatory context.
## Coverage: Canada (Ontario primary, AB/BC secondary) and United States (all major states)
## This file is model-agnostic. It is loaded into the interview agent's system prompt at runtime.

---

# HOW TO USE THIS FILE

When a business type and location are identified early in the interview:
1. Match to the correct industry and sub-industry below
2. Load all fields marked [CRITICAL] — these must be covered in every interview for this type
3. Load fields marked [IMPORTANT] — cover these if time and seller knowledge allow
4. Load fields marked [JURISDICTION] — apply only if the business operates in that region
5. Use the "Common seller blind spots" section to know where to probe harder
6. Use the "Why it matters to buyers" explanations when a seller doesn't understand why you're asking
7. Use the "How to retrieve" instructions when a seller doesn't know where to find the information

## CROSS-INDUSTRY UNIVERSAL FIELDS

The following fields apply to virtually every business regardless of industry. The interview agent should always cover these in addition to the industry-specific fields below. Do NOT re-ask these if the seller has already provided the information.

**Business basics** [CRITICAL — all industries]
- Legal entity name and structure (sole proprietorship, partnership, corporation, LLC)
- Years in operation and brief history
- Current ownership structure (single owner, multiple partners, family-owned)
- Reason for selling and desired timeline
- Asking price or valuation expectation (if the seller has one)

**Financial overview** [CRITICAL — all industries]
- Last 3 years of revenue and net income (or EBITDA/SDE)
- Any add-backs or adjustments to normalize earnings
- Current debt obligations (loans, lines of credit, equipment financing)
- Tax status — are tax returns available and filed up to date?
- Any outstanding tax liabilities or CRA/IRS audits

**Lease and real estate** [CRITICAL — for any business operating from a physical location]
- Is the premises owned or leased?
- Lease term remaining, renewal options, monthly rent (base + additional)
- Does the lease require landlord consent for assignment/change of ownership?
- Personal guarantee status
- Any demolition, redevelopment, or termination clauses

**Owner involvement and transition** [CRITICAL — all industries]
- What does the owner do day-to-day? How many hours per week?
- Could the business run without the owner? For how long?
- Is the owner willing to stay for a transition period? How long?
- What training or handover would be provided to a buyer?

**Employees and HR** [IMPORTANT — all industries]
- Total headcount (full-time, part-time, casual, seasonal)
- Key employees without whom the business would struggle
- Are there written employment agreements?
- Are there any pending employment disputes, wrongful termination claims, or human rights complaints?
- Employee benefit programs (health, dental, retirement) and their costs
- Are employees aware the business is for sale?

**Insurance** [IMPORTANT — all industries]
- What insurance policies are in place (general liability, property, E&O, D&O, cyber, etc.)?
- What are the annual premiums?
- Are there any outstanding claims?
- Has coverage ever been non-renewed or restricted?

**Legal and compliance** [IMPORTANT — all industries]
- Are there any pending or threatened lawsuits?
- Are there any outstanding government orders, violations, or compliance issues?
- Are all business licenses and permits current?
- Are there any intellectual property issues (trademarks, patents, copyrights)?

**Technology and systems** [IMPORTANT — all industries]
- What core software systems are used (accounting, CRM, operations, POS)?
- Are any systems proprietary or custom-built?
- Is there an IT person or vendor who maintains systems?
- What is the data backup and disaster recovery situation?

---

---

# 1. BUILDING / CONSTRUCTION / PROPERTY MANAGEMENT

## Sub-industries covered:
- General Contracting (commercial and residential)
- Specialty Trades (electrical, plumbing, HVAC, roofing, painting, flooring, concrete, masonry)
- Civil / Municipal / Infrastructure
- Property Management
- Restoration and Remediation
- Landscaping and Snow Management
- Engineering Consultancy (building/structural/mechanical)

---

## 1A. GENERAL CONTRACTING & SPECIALTY TRADES

### Critical fields [CRITICAL]

**Licensing and certification**
- What contractor licenses does the business hold and in whose name?
- Are licenses held by the owner personally or by the company?
- What happens to those licenses when the owner exits?
- Are there journeyperson tickets or trade certifications held by key employees?
- For specialty trades: what specific trade certifications are held (e.g., Master Electrician, G1/G2 gas technician, 313A refrigeration)?

Why it matters: In most jurisdictions, contractor licenses are non-transferable. If the license is in the owner's name and the owner leaves, the buyer may not be able to operate legally until they obtain their own license — which can take months. This kills deals or causes massive price reductions.

How to retrieve: Check the license certificates in your office or with your provincial/state licensing body. In Ontario, check TSSA (for HVAC/gas), ESA (electrical), or the municipal building department. In the US, check the state contractor licensing board.

**Bonding and surety**
- Does the business carry a surety bond? What is the current bonding capacity (single project limit and aggregate limit)?
- Who is the surety company and what is the relationship history?
- Has the business ever had a bond claim made against it?
- What is the Work-in-Progress (WIP) schedule showing current bonded projects?
- What is the indemnity agreement structure — is the owner personally indemnifying the surety?

Why it matters: Bonding capacity directly determines what size contracts the business can bid on. A buyer acquiring a construction company to grow it needs to know the current bonding ceiling and whether it can be increased. A bond claim history can make it very difficult or expensive to obtain bonding after a sale. Personal indemnity obligations may need to be released or assumed by the buyer.

How to retrieve: Ask your surety broker or bonding company for a current capacity letter and claim history. The WIP schedule should be in your project management or accounting system.

**Bid pipeline and backlog**
- What is the current signed backlog (contracts signed but work not yet completed)? Provide dollar value.
- What is in the bid pipeline (proposals submitted, awaiting award)?
- What is the historical bid-to-win ratio?
- Are any major bids pending that could significantly change revenue?
- What is the average project duration and what does the completion timeline look like for current backlog?

Why it matters: Backlog is the most important forward-looking metric in construction. Buyers are buying future revenue, not just historical revenue. A business with $2M in revenue but $3M in signed backlog is much more valuable than one with $2M in revenue and an empty pipeline.

How to retrieve: Your project management software (Procore, Buildertrend, Jonas, Sage) should have a WIP and pipeline report. If you track it in a spreadsheet, pull that.

**Revenue by project type and customer**
- What percentage of revenue comes from commercial vs residential vs institutional vs industrial?
- What is the largest single customer as a percentage of total revenue?
- Are there any customers that represent more than 20% of revenue?
- Is revenue project-based (one-time) or does any of it recur (service contracts, maintenance agreements)?
- What is the geographic service area and are there any plans to expand or contract it?

Why it matters: Buyers heavily discount customer concentration. A business where one customer is 40% of revenue is high-risk — that customer could leave after a sale. Recurring service revenue is valued much higher than one-time project revenue.

**Holdbacks and receivables**
- What is the current holdback receivable balance?
- What is the typical holdback percentage on your contracts (5%? 10%)?
- What is the average time to release holdbacks after project completion?
- Are there any disputed or long-outstanding holdbacks?
- What is the total accounts receivable balance and aging breakdown (current, 30, 60, 90+ days)?

Why it matters: Holdbacks are cash tied up in completed work. A business with $500K in outstanding holdbacks has $500K in working capital tied up that the buyer needs to account for. Disputed holdbacks can indicate project quality issues or client relationship problems.

How to retrieve: Your accounting software (QuickBooks, Sage) should have a holdbacks receivable report. Ask your bookkeeper.

**Subcontractor relationships**
- What work is done by employees vs subcontractors?
- Are subcontractors consistent/repeat or hired project-by-project?
- Do you have written subcontractor agreements?
- Are there any key subcontractors that the business depends on and could not easily replace?
- Do you verify that subcontractors carry their own insurance and workers' compensation coverage?

Why it matters: If the business relies heavily on a few subcontractors who have a personal relationship with the owner, those subcontractors may not continue working with a new owner. Buyers need to assess this risk. Uninsured subcontractors create liability exposure for the general contractor.

**Equipment and assets**
- List all major equipment owned by the business (vehicles, heavy equipment, tools, trailers)
- What is owned outright vs financed vs leased?
- What is the current market value of owned equipment?
- What is the maintenance history and condition of major equipment?
- Are there any equipment leases that would need to be assigned to the buyer?
- Is there a vehicle/equipment GPS tracking system?

Why it matters: Equipment is often a significant part of construction business value. Buyers need to know what they're getting, what's paid off, and what ongoing lease obligations come with the business.

**Safety record**
- What is the company's EMR (Experience Modification Rate) for workers' compensation?
- Has the business had any workplace accidents, injuries, or fatalities in the last 5 years?
- Are there any outstanding WorkSafeBC, WSIB, or OSHA violations or orders?
- Does the business have a documented health and safety program?
- Is there a dedicated safety officer or committee?
- What is the lost-time injury frequency rate?

Why it matters: EMR directly affects insurance costs and can affect the ability to bid on certain contracts (many general contractors require subcontractors to have an EMR below 1.0). A poor safety record is a significant liability.

How to retrieve: Your workers' compensation insurer (WSIB in Ontario, WorkSafeBC in BC, WCB in Alberta, or state workers' comp in the US) can provide your EMR history.

**Union vs non-union**
- Is the workforce unionized? If so, which union(s)?
- What are the current collective agreement terms and when does it expire?
- Are there any ongoing labour disputes or grievances?
- If unionized, what are the pension and benefit trust fund obligations?

Why it matters: Union agreements transfer with the business. A buyer needs to understand wage scales, benefit obligations, pension trust contributions, and any upcoming contract renegotiations.

**Estimating and project management**
- Who handles estimating and what is the process?
- What project management methodology and software is used?
- Is the estimating/PM function owner-dependent or handled by staff?
- What is the historical margin accuracy (estimated margin vs actual margin on completed projects)?

Why it matters: If the owner is the sole estimator and walks away, the business loses its ability to accurately bid work — which is existential for a contractor. Historical margin accuracy tells buyers whether bids are reliable or if the business regularly under- or over-estimates costs.

### Important fields [IMPORTANT]

- Insurance: What is the current general liability coverage amount? Do you carry errors & omissions (for design-build work)?
- Warranty obligations: Are there outstanding warranty obligations on completed projects? What is the typical warranty period offered?
- Lien history: Have any construction liens been filed against the business or its projects in the last 5 years?
- Owner involvement: What does the owner do day-to-day? Can the business operate without them?
- Key employees: Are there project managers, estimators, or site supervisors who are critical to operations?
- Permits and approvals: Are there any projects currently held up by permitting or inspection issues?
- Seasonality: What is the revenue distribution across seasons? How does weather affect operations and cash flow?

### Jurisdiction-specific [JURISDICTION]

**Ontario, Canada**
- Electrical work requires ESA (Electrical Safety Authority) licensing. Is the business ESA-licensed and in whose name?
- Gas/HVAC work requires TSSA (Technical Standards and Safety Authority) licensing. G1, G2, and G3 classifications — what does the business hold?
- Plumbing requires a Certificate of Qualification from the Ontario College of Trades (now under Skilled Trades Ontario).
- Check for any liens registered on the business under the Construction Act (formerly Construction Lien Act).
- WSIB clearance certificates are required for most commercial contracts.
- New Home Warranty: If residential construction, is the business registered with Tarion? Any outstanding Tarion claims?
- Prompt Payment legislation (Construction Act amendments effective 2019): Is the business compliant with statutory payment timelines?

**Alberta, Canada**
- Contractor licensing is municipally controlled — verify licenses for each municipality where work is performed.
- WCB Alberta clearance required for most commercial work.
- Some trades require provincial certification (journeyperson certificates) through Alberta Apprenticeship and Industry Training.
- Safety Codes Officer designations for certain inspection work.
- Alberta New Home Warranty Program — registration required for residential builders.

**British Columbia, Canada**
- Homeowner Protection Office (HPO) registration required for new home construction.
- WorkSafeBC compliance certificates required for commercial contracts.
- Some trades require BC Industry Training Authority (ITA) certification.
- 2-5-10 new home warranty required under the Homeowner Protection Act.

**United States (General)**
- Contractor licensing varies dramatically by state. Some states license at state level (California, Florida), others at county/city level (Texas).
- Many states require separate licenses for general contracting, electrical, plumbing, HVAC.
- Davis-Bacon Act compliance required for federally-funded projects (prevailing wage requirements).
- OSHA compliance record — check for any citations or violations.
- Miller Act (federal) and Little Miller Act (state) bond requirements for public works projects.

**California**
- CSLB (Contractors State License Board) license required for projects over $500. License classifications matter (A, B, C).
- Cal/OSHA requirements are stricter than federal OSHA.
- Prevailing wage requirements apply to public works projects.
- DIR (Department of Industrial Relations) registration required for public works contractors.

**Florida**
- State-certified vs state-registered contractor distinction matters for license transferability.
- Hurricane mitigation requirements for roofing contractors.
- Building Code compliance — Florida Building Code is distinct from and often stricter than the IBC.

**Texas**
- No statewide general contractor license, but trades (electrical, plumbing, HVAC) are licensed at state level.
- TDLR (Texas Department of Licensing and Regulation) governs many trades.
- Local municipal licensing may be required in addition to state trade licenses.

**New York**
- NYC requires separate licensing for many trades — NYC DOB (Department of Buildings) governs.
- Prevailing wage requirements for public projects under NYS Labor Law Article 8.

### Common seller blind spots
- Owners often don't realize their license is personal and non-transferable
- Holdback balances are frequently underreported or forgotten
- Safety records (EMR) are rarely top of mind but critical to buyers
- Subcontractor dependency is often overlooked ("they'll stay, they like working with us")
- Pending bids are not included in backlog discussions even though they represent pipeline
- Estimating dependency on the owner is the most common owner-dependency issue in construction but rarely identified by sellers
- WIP schedule discrepancies between accounting and project management are common and concerning to buyers
- Outstanding warranty obligations from completed projects are forgotten
- Personal indemnity on surety bonds is not disclosed

---

## 1B. CIVIL / MUNICIPAL / INFRASTRUCTURE

### Critical fields [CRITICAL] (in addition to 1A fields)

**Government contract dependency**
- What percentage of revenue comes from government/municipal contracts?
- Are contracts awarded through competitive tender or sole-source?
- What is the typical contract length and renewal process?
- Are any major contracts up for renewal within the next 12 months?
- Are there any performance bonds or letters of credit outstanding on government work?

Why it matters: Government contracts are not guaranteed to transfer or renew with a new owner. Buyers need to understand the renewal risk and whether the relationship is with the company or the individual owner.

**Prequalification status**
- Is the business prequalified with any municipalities, provinces/states, or federal agencies?
- What prequalification categories and dollar limits apply?
- Does prequalification transfer to a new owner?
- What is the historical success rate on tenders submitted?

Why it matters: Prequalification takes time and a track record to obtain. If it's in the company name (not the owner personally), it may transfer. If it depends on the owner's personal history, it may not.

**Equipment and fleet**
- Detailed list of heavy equipment (excavators, loaders, graders, etc.) with age, hours, and condition
- Are any pieces of equipment due for major overhaul or replacement?
- What is the replacement cost of the fleet?
- Are there any equipment certifications required (e.g., crane operator certifications)?

**Environmental and permitting**
- Does the business hold any environmental permits for its operations (stockpiling, aggregate extraction, stormwater management)?
- Has the business performed any work requiring environmental remediation?
- Are there any outstanding environmental compliance issues?

---

## 1C. PROPERTY MANAGEMENT

### Critical fields [CRITICAL]

**Portfolio composition**
- How many properties/units are under management?
- What is the breakdown by property type (residential, commercial, industrial, mixed-use)?
- What is the total square footage or total units under management?
- What is the geographic concentration of the portfolio?
- Are there any properties that are particularly problematic (high maintenance, frequent tenant issues)?

**Contract structure**
- What are the typical contract terms (month-to-month vs multi-year)?
- What percentage of contracts are up for renewal in the next 12 months?
- What are the termination clauses — how much notice can a client give?
- Are there any contracts with change-of-ownership clauses (that allow termination if the management company is sold)?
- Are there any performance guarantees or Service Level Agreements (SLAs) in the contracts?

Why it matters: Property management revenue is only as sticky as the contracts. Month-to-month contracts mean a buyer could lose the portfolio quickly. Change-of-ownership clauses are particularly dangerous.

**Fee structure**
- What is the management fee percentage (typically 4-10% of gross rents)?
- Are there additional fees (leasing fees, maintenance markups, inspection fees)?
- What is the average revenue per door/unit per month?
- Are fees competitive with the market or above/below market rates?

**Staff and operations**
- How many staff are employed and what are their roles?
- Is maintenance handled in-house or outsourced?
- What property management software is used (Yardi, AppFolio, Buildium, etc.)?
- What is the vacancy rate across the managed portfolio?
- What is the average time to fill a vacancy?

**Owner concentration**
- What is the largest single property owner as a percentage of total managed units?
- Are there any owners who have a personal relationship with the current owner that could cause them to leave post-sale?
- Have any owners indicated any plans to self-manage or switch providers?

**Trust accounts**
- Does the business hold tenant deposits or rent in trust? What is the current trust account balance?
- Is the trust account properly segregated and compliant with provincial/state regulations?
- Are trust account records auditable?

Why it matters: Property management trust accounts are heavily regulated. Mishandling of trust funds is both a regulatory violation and a deal-killer. Buyers need to verify that trust accounts are properly maintained.

### Jurisdiction-specific [JURISDICTION]

**Ontario**
- Property managers dealing with condominiums must comply with CMRAO (Condominium Management Regulatory Authority of Ontario) licensing.
- CMRAO licensing is issued to individuals (general and limited licenses) — check whether key license holders plan to stay.
- Residential tenancy disputes governed by Landlord and Tenant Board (LTB).
- RECO (Real Estate Council of Ontario) registration required if managing properties and collecting rents in some contexts.
- Rent control rules apply to most residential units built before November 15, 2018 — understanding rent control exposure is critical.

**British Columbia**
- Property managers must be licensed through BCFSA (BC Financial Services Authority).
- Strata Management licensing required for managing strata corporations.
- Residential Tenancy Branch (RTB) governs landlord-tenant disputes.

**Alberta**
- Real Estate Act governs property management. Licensing through RECA (Real Estate Council of Alberta).
- Residential Tenancies Act governs landlord-tenant matters.

**United States**
- Many states require a real estate broker's license to manage properties for others.
- State-specific landlord-tenant laws govern lease terms, security deposits, eviction procedures.
- Fair Housing Act compliance must be documented.
- Trust account requirements vary by state — some require separate trust accounts for each property.

---

## 1D. LANDSCAPING AND SNOW MANAGEMENT

### Critical fields [CRITICAL]

**Revenue split and seasonality**
- What percentage of revenue is landscaping vs snow management vs other services (irrigation, hardscaping, tree care)?
- Is snow revenue contractual (seasonal contracts) or per-event billing?
- How does a low-snow year affect revenue? What was revenue in the lowest-snow year in the last 5 years?
- What is the revenue distribution by month? What is the lowest-revenue month vs the highest?

Why it matters: Snow management revenue is highly weather-dependent. Buyers will heavily scrutinize the downside scenario. Contractual snow revenue (flat-fee seasonal) is much more valuable than per-event billing.

**Contract base**
- How many active landscape maintenance contracts are there?
- What is the average contract value and length?
- What percentage of clients renew year over year (retention rate)?
- Are there any large commercial clients (property management companies, HOAs, municipalities) that represent significant concentration?
- Are snow contracts indemnified (does the landscaper carry liability for slip-and-fall on properties they service)?

Why it matters: Snow contracts with indemnification clauses transfer significant liability to the landscaping company. If a slip-and-fall lawsuit occurs on a property the company serviced, the company may be liable. This is a hidden liability that affects insurance costs.

**Equipment**
- Full equipment list with owned vs financed vs leased status
- For snow: How many plows, salters, loaders? What is the route capacity?
- Condition and age of major equipment
- What are the annual equipment maintenance and replacement costs?

**Chemical and pesticide licensing**
- Do any staff hold pesticide applicator licenses?
- Are those licenses in employee names or company name?
- Is the business licensed for commercial pesticide application?

**Slip-and-fall liability (snow)**
- What is the claims history for slip-and-fall incidents on properties serviced?
- What is the general liability insurance coverage and premium for snow operations?
- Have premiums increased significantly due to claims history?

### Jurisdiction-specific [JURISDICTION]

**Ontario**
- Pesticide applicators must be licensed under the Pesticides Act (Ministry of Environment).
- Some municipalities have pesticide bylaws that restrict certain chemicals.
- Ontario's cosmetic pesticide ban affects certain applications.
- Minimum Maintenance Standards for municipal roads and sidewalks — if the business holds municipal snow contracts, compliance with MMS is critical.

**United States**
- EPA pesticide applicator licensing required in most states.
- State-level landscape contractor licensing varies (required in some states, not others).
- H-2B visa program — many landscape companies rely on seasonal foreign workers. Understand visa dependencies.

---

## 1E. RESTORATION AND REMEDIATION

### Critical fields [CRITICAL]

**Insurance work dependency**
- What percentage of revenue comes from insurance-related claims (water damage, fire, mold)?
- Which insurance companies/TPAs (Third Party Administrators) refer work?
- Are those relationships with the company or with the owner personally?
- What is the typical payment cycle from insurers?
- Is the company on any insurance company's preferred vendor program? Are those agreements transferable?

**Certifications**
- Does the business hold IICRC (Institute of Inspection, Cleaning and Restoration Certification) certifications?
- Are certifications held by the company or individual technicians?
- What happens to certifications if key technicians leave?
- What specific certifications are held (WRT, AMRT, FSRT, etc.)?

**Hazardous materials**
- Does the business perform asbestos abatement, mold remediation, or lead paint removal?
- Are staff certified for hazardous materials handling?
- Are there any outstanding environmental orders or violations?
- What insurance coverage exists specifically for pollution/environmental liability?

**Emergency response capability**
- Does the business offer 24/7 emergency response?
- What is the response time SLA for emergency calls?
- How many emergency calls are received per month on average?
- What is the after-hours staffing arrangement?

Why it matters: 24/7 emergency response capability is a key competitive advantage and revenue driver in restoration. Insurance companies prefer vendors who can respond immediately. Loss of this capability post-sale could mean loss of preferred vendor status.

### Jurisdiction-specific [JURISDICTION]

**Ontario**
- Asbestos abatement governed by O. Reg. 278/05 under the Occupational Health and Safety Act.
- Ministry of Labour oversight for hazardous materials handling.
- WSIB requirements for restoration work — higher premiums for hazardous materials work.

**United States**
- EPA Lead Renovation, Repair, and Painting (RRP) Rule — firm certification required for lead paint work.
- AHERA (Asbestos Hazard Emergency Response Act) governs asbestos work.
- State-specific licensing for mold remediation (Texas, Florida, Louisiana, New York all require separate licenses).

---

---

# 2. HEALTHCARE

## Sub-industries covered:
- Medical Clinics (family practice, walk-in, specialist)
- Dental Practices
- Mental Health and Therapy Clinics
- Allied Health (physiotherapy, chiropractic, optometry, audiology)
- Med Spa and Aesthetics Clinics
- Specialty Clinics (cosmetic surgery, men's health, women's health, weight loss)
- Diagnostic Labs and Imaging
- Home Care and Personal Support Services
- Pharmacy

---

## 2A. MEDICAL CLINICS (Family Practice, Walk-In, Specialist)

### Critical fields [CRITICAL]

**Physician structure and billing**
- Are physicians employees, independent contractors, or owner-operators?
- How is physician compensation structured (salary, fee split, rent-a-chair)?
- Who holds the billing numbers — the clinic or the individual physicians?
- What happens to physician billing numbers if the ownership changes?
- How many physicians are currently practicing at the clinic and what are their specialties?

Why it matters: In Canada, OHIP billing numbers are issued to individual physicians, not to clinics. The clinic itself doesn't bill — the doctors do and the clinic takes a percentage. If doctors leave after a sale, the revenue leaves with them. This is the single most important issue in Canadian medical clinic transactions.

**Patient volume and demographics**
- How many active patients does the clinic serve (seen in last 24 months)?
- What is the daily/weekly patient visit volume?
- What is the patient demographic breakdown (age, complexity of care)?
- What is the new patient acceptance rate (is the practice accepting new patients)?
- What percentage of patients are rostered (enrolled) vs walk-in?

**Payer mix (US-specific)**
- What percentage of revenue comes from Medicare, Medicaid, private insurance, and self-pay?
- Which insurance plans are accepted?
- What are the in-network vs out-of-network billing arrangements?
- What is the average collection rate by payer type?
- What are the outstanding receivables by payer and aging?

Why it matters (US): Medicare and Medicaid reimbursement rates are set by government and tend to be lower than private insurance. A practice heavily dependent on government payers has lower revenue per visit and is valued differently.

**Regulatory and accreditation**
- Is the clinic accredited (CAAAC in Canada, JCAHO/NCQA in US)?
- Are there any outstanding College complaints (CPSO in Ontario, state medical board in US)?
- Has the clinic ever been subject to a billing audit? Outcome?
- Are there any MOH (Ministry of Health) funding agreements or special programs?
- Is the clinic compliant with accessibility requirements?

**Lease and facility**
- What are the lease terms (length, renewal options, rent)?
- Is the location medically zoned? Can it continue to operate as a medical clinic under a new owner?
- Does the landlord have any relationship requirements or right of approval for a change of ownership?
- What is the condition of the leasehold improvements and medical infrastructure (plumbing, HVAC for infection control)?

**Electronic Medical Records (EMR)**
- What EMR system is used (OSCAR, PS Suite, TELUS, Epic, Athena, etc.)?
- Who owns the patient data — the physicians or the clinic?
- What are the data transfer/migration implications of a sale?
- Are patient records complete and properly maintained?

**Physician retention**
- Have any physicians indicated they plan to leave?
- Are there written agreements with physicians (non-competes, notice periods)?
- What is the physician turnover history?
- Are there any ongoing recruitment efforts for additional physicians?

### Jurisdiction-specific [JURISDICTION]

**Ontario, Canada**
- OHIP (Ontario Health Insurance Plan) is the primary payer. Understand the clinic's OHIP billing volume and any shadow billing.
- Independent Health Facilities (IHF) license may be required for certain procedures (minor surgery, diagnostic imaging).
- CPSO (College of Physicians and Surgeons of Ontario) governs physician conduct.
- Physician ownership restrictions: In Ontario, only physicians can own a medical corporation that provides medical services. This significantly limits the buyer pool.
- IDA (Incorporation and Dispensing Arrangements) rules govern physician billing arrangements.
- Some clinics receive MOH funding for specific programs (mental health, addiction, etc.) — these agreements may not transfer.
- Ontario Health Teams (OHTs) — is the clinic part of an OHT and does that create any obligations or benefits?

**British Columbia**
- MSP (Medical Services Plan) billing governs physician revenue.
- College of Physicians and Surgeons of BC governs conduct.
- BC has similar physician ownership restrictions.
- Primary Care Networks (PCNs) — participation and implications.

**Alberta**
- AHC (Alberta Health Care Insurance Plan) governs physician billing.
- CPSA (College of Physicians and Surgeons of Alberta) governs conduct.
- Primary Care Networks — same considerations as BC.

**United States (General)**
- Corporate Practice of Medicine (CPOM) laws in many states restrict non-physicians from owning medical practices. Check state-specific rules.
- HIPAA compliance documentation required.
- Medicare/Medicaid enrollment — does it transfer or require re-enrollment?
- Stark Law and Anti-Kickback Statute compliance documentation.
- DEA registration for controlled substance prescribing — does not automatically transfer.
- Credentialing with insurance panels takes time and may not be immediate post-sale.
- MIPS (Merit-based Incentive Payment System) — what is the clinic's current score and how does it affect Medicare reimbursement?

**California**
- Strict CPOM laws — only physicians can own a medical practice. MSOs (Management Services Organizations) are commonly used to structure around this.
- Knox-Keene Act may apply if the practice takes on capitated risk.

**Florida, Texas, New York**
- Each has specific CPOM rules and physician ownership requirements. Always verify with local healthcare attorney.

### Common seller blind spots
- Physicians assume their billing relationships transfer automatically — they often don't
- Patient data ownership is frequently misunderstood
- Outstanding College complaints are not disclosed until asked directly
- Lease zoning for medical use is assumed but not verified
- Physician non-competes are often unwritten or unenforceable
- MOH/government funding agreements that may not survive a change of ownership
- Billing audit exposure — improper billing practices may not have been caught yet but represent significant risk

---

## 2B. DENTAL PRACTICES

### Critical fields [CRITICAL]

**Dentist structure**
- Is the selling dentist the sole practitioner or one of multiple dentists?
- Are associate dentists employees or independent contractors?
- Do associates have written agreements? What are the notice and non-compete terms?
- Is the selling dentist willing to stay on for a transition period? For how long?
- What percentage of total production is attributable to the selling dentist personally?

Why it matters: In dentistry, the relationship between the dentist and the patient is personal. Patient retention after a sale depends heavily on the transition — if the selling dentist leaves abruptly, patient attrition can be significant (20-40% is common in poor transitions).

**Patient base**
- How many active patients (seen in last 18-24 months)?
- What is the new patient flow per month (organic vs referred vs marketing)?
- What is the patient recall rate (percentage returning for hygiene appointments on schedule)?
- What is the average revenue per patient visit?
- What is the patient demographic (age skew matters — older patients have different treatment needs and longevity)?
- What is the treatment acceptance rate (percentage of proposed treatment that patients proceed with)?

**Revenue breakdown**
- What percentage of revenue is hygiene vs restorative vs cosmetic vs orthodontics vs other?
- Does the practice offer specialty services (implants, Invisalign, sedation dentistry)?
- What percentage of revenue is insured vs uninsured?
- For insured: which plans are accepted and what are the fee guides used?
- What is the production per operatory per day?

**Equipment and facility**
- How many operatories (chairs) are there and how many are in active use?
- What is the age and condition of major equipment (x-ray, CBCT, sterilization, chairs)?
- Is digital x-ray and digital charting in use?
- What is the current software system (Dentrix, Dolphin, Tracker, etc.)?
- Are there any operatories that could be activated to increase capacity?

**Regulatory and licensing**
- Is the practice incorporated under a Dental Professional Corporation?
- Are all dentists licensed with the provincial/state dental college?
- Are there any outstanding college complaints or disciplinary history?
- Is the facility compliant with infection control standards (IPAC)?
- When was the last regulatory inspection and what was the outcome?

**Hygiene department**
- How many hygienists are employed and are they full-time or part-time?
- What is the hygiene production as a percentage of total practice production?
- Are hygienists on consistent schedules with full books?
- What is the hygienist retention history?

Why it matters: A strong hygiene department provides steady, predictable, recurring revenue that is less dependent on the dentist. Practices with hygiene at 30-35% of production are healthier than those where the dentist drives everything.

### Jurisdiction-specific [JURISDICTION]

**Ontario**
- RCDSO (Royal College of Dental Surgeons of Ontario) governs licensing.
- Only dentists (or dental professionals) can own a dental practice — check ownership structure.
- ODA (Ontario Dental Association) fee guide is commonly referenced but not mandatory.
- OHIP covers very limited dental services (emergency, special needs) — most revenue is private insurance or self-pay.
- CDHO (College of Dental Hygienists of Ontario) governs hygienist licensing.

**Canada (General)**
- Dental ownership is provincially regulated. Most provinces restrict ownership to licensed dental professionals.
- New federal Canadian Dental Care Plan (CDCP) launched 2024 — understand if the practice is enrolled and what percentage of patients are using it. Monitor CDCP payment rates vs fee guide rates.

**United States**
- CPOM laws apply to dentistry in many states — verify ownership restrictions. DSO (Dental Service Organization) structures are used in states with CPOM restrictions.
- Delta Dental, Cigna, Aetna, MetLife are major dental insurers — understand which networks the practice participates in.
- In-network vs out-of-network status significantly affects revenue per procedure.
- Medicaid dental programs (CHIP for children) — participation affects patient demographics and reimbursement rates.
- OSHA compliance for dental offices (bloodborne pathogens, hazard communication).

---

## 2C. MENTAL HEALTH AND THERAPY CLINICS

### Critical fields [CRITICAL]

**Practitioner structure**
- How many therapists/psychologists/social workers practice at the clinic?
- Are they employees or independent contractors (rent-a-chair/room rental model)?
- Do practitioners bring their own patient lists or are patients assigned through the clinic?
- Do practitioners have non-compete or non-solicit agreements?
- What is the split or compensation structure for each practitioner?

Why it matters: Mental health practices are among the most practitioner-dependent businesses. If therapists are independent contractors who own their patient relationships, the clinic itself may have very little intrinsic value — the "business" walks out the door when the therapist does.

**Referral sources**
- Where do patients come from (family physician referrals, self-referral, insurance/EAP, online)?
- Are there formal referral agreements with any organizations?
- What is the EAP (Employee Assistance Program) contract situation — which EAPs refer to this clinic?
- Is there an intake coordinator or centralized booking system, or do practitioners manage their own bookings?

**Payer mix**
- What percentage of revenue is direct-pay vs insurance vs EAP vs OHIP/government-funded programs?
- Are there any OHIP-funded psychiatric services (Ontario) or state-funded mental health programs (US)?
- What are the reimbursement rates by payer type?
- What is the collections rate and outstanding receivables?

**Wait times and capacity**
- What is the current wait time for a new patient appointment?
- What is the average caseload per therapist?
- Is the clinic at capacity or is there room to grow?
- Are there any unfilled practitioner rooms that represent growth opportunity?

**Telehealth and virtual services**
- What percentage of sessions are conducted virtually vs in-person?
- What telehealth platform is used and is it compliant with privacy regulations?
- Has virtual care expanded the geographic reach of the practice?

Why it matters: Post-pandemic, telehealth has become a significant component of mental health service delivery. A practice with a mature virtual care offering can serve clients across larger geographies. However, licensing restrictions in some jurisdictions limit cross-border or cross-state virtual practice.

### Jurisdiction-specific [JURISDICTION]

**Ontario**
- Psychologists are regulated by CPO (College of Psychologists of Ontario).
- Social workers regulated by OCSWSSW (Ontario College of Social Workers and Social Service Workers).
- Psychotherapists regulated by CRPO (College of Registered Psychotherapists of Ontario).
- Most mental health therapy is not OHIP-covered — primarily private pay or insurance.
- Some clinics receive government funding through Ontario Health Teams, community mental health programs, or specific grants — these funding agreements may not transfer.

**United States**
- HIPAA compliance for patient records is critical.
- Telehealth licensing — therapists must be licensed in the state where the patient is located. PSYPACT (for psychologists) allows some interstate practice.
- Insurance credentialing (BCBS, Aetna, United, Cigna) — each requires individual therapist credentialing. After a sale, this must be re-credentialed which takes 60-120 days.
- Medicare/Medicaid mental health billing has specific rules. No Surprises Act compliance.

---

## 2D. ALLIED HEALTH (Physiotherapy, Chiropractic, Optometry, Audiology)

### Critical fields [CRITICAL]

**Practitioner dependency**
- Same questions as mental health re: employee vs contractor structure
- Are patient relationships with the clinic or with individual practitioners?
- What is the practitioner turnover history?
- Are any practitioners responsible for a disproportionate share of revenue?

**Revenue streams**
- What services are offered and what is revenue by service type?
- What is the insurance vs direct-pay split?
- For physiotherapy/chiro: Is there Motor Vehicle Accident (MVA) billing? WSIB billing? What percentage?
- Are there any ancillary revenue streams (product sales, equipment rental, orthotics)?

Why it matters: MVA and WSIB billing in Ontario (and equivalent in other provinces/states) has specific rules, payment schedules, and audit risks. Buyers need to understand this exposure.

**For Optometry specifically**
- What optical dispensary revenue exists vs professional services?
- What is the frame and lens inventory value?
- Are there any Vision Care plan (e.g., Green Shield, Manulife) agreements?
- Does the practice own its own optical lab or outsource?
- What is the contact lens revenue and subscription program (if any)?

**For Audiology specifically**
- What is the hearing aid revenue vs professional service revenue?
- Which hearing aid manufacturers are partnered with?
- What is the average hearing aid sale price and margin?
- What warranty and follow-up service obligations are outstanding?

### Jurisdiction-specific [JURISDICTION]

**Ontario**
- Physiotherapists: regulated by CPO (College of Physiotherapists of Ontario).
- Chiropractors: regulated by CCO (College of Chiropractors of Ontario).
- Optometrists: regulated by College of Optometrists of Ontario (COO). OAO (Ontario Association of Optometrists) is the professional association.
- Audiologists: regulated by CASLPO (College of Audiologists and Speech-Language Pathologists of Ontario).
- OHIP covers optometry exams for children under 20 and adults over 65 — understand the OHIP vs private split.
- WSIB billing for physiotherapy/chiro is significant in Ontario — understand outstanding WSIB receivables and audit risk.
- Auto insurance (MVA) billing through insurer-approved treatment plans — understand the administrative burden and collection cycle.

**United States**
- State-specific licensing for each allied health profession.
- Medicare Part B covers some services (PT, chiro, audiology) — understand enrollment and billing compliance.
- Out-of-network vs in-network status for major insurers.

---

## 2E. MED SPA AND AESTHETICS CLINICS

### Critical fields [CRITICAL]

**Medical Director and oversight**
- Who is the Medical Director and what are their oversight responsibilities?
- Is the Medical Director actively involved or nominally attached?
- What is the Medical Director agreement — compensation, term, termination provisions?
- Would the Medical Director stay through a transition?

Why it matters: In both Canada and the US, many aesthetic treatments (injectables, laser, prescription medications) require medical oversight. A Med Spa without a Medical Director cannot legally offer these services. If the Medical Director leaves, the business may be unable to perform its highest-margin services.

**Services and revenue breakdown**
- What services are offered (injectables/Botox/fillers, laser, body contouring, facials, IV therapy, etc.)?
- Revenue breakdown by service category?
- Which services require a licensed medical professional to perform?
- Which services can be delegated to aestheticians, nurses, or other staff?
- What is the average revenue per treatment and per client visit?

**Product and vendor relationships**
- Which injectable brands are used (Allergan/Botox, Galderma/Dysport, etc.)?
- Are there any volume-based pricing agreements with product suppliers?
- What is the current product inventory value?
- Are there any equipment lease/rental arrangements for laser or other devices?

**Equipment**
- What laser and IPL equipment is owned? Make, model, age, and condition?
- What is the replacement cost and expected useful life?
- Are there any equipment leases or financing arrangements?
- Are maintenance contracts in place for major equipment?

**Client base**
- How many active clients (seen in last 12 months)?
- What is the client retention rate?
- What is the average client spend per year (lifetime value)?
- What is the membership or package program (if any) and how many active members?
- What is the pre-sold treatment package liability (treatments paid for but not yet delivered)?

**Regulatory compliance**
- Is the facility compliant with health authority regulations for medical aesthetic services?
- Are all practitioners appropriately licensed for the services they perform?
- Is informed consent properly documented for all procedures?
- Are there any outstanding complaints with professional colleges?

### Jurisdiction-specific [JURISDICTION]

**Ontario**
- CPSO governs medical oversight requirements. Delegation of controlled acts must follow CPSO guidelines.
- Registered nurses can perform certain procedures under a Medical Directive — verify that Medical Directives are properly documented and current.
- Laser services may require compliance with CSA standards (Canadian Standards Association).
- Aestheticians performing non-medical treatments are not regulated provincially but may require municipal licensing.

**United States**
- CPOM laws apply — structure varies by state. MSO/management company structures are common.
- Nurse practitioners and physician assistants have varying scopes of practice by state — verify that all providers are operating within their scope.
- FDA regulations govern injectable products and medical devices.
- State medical board oversight applies to all medical aesthetic procedures.
- Many states require the Medical Director to have an active presence at the facility (not just nominal oversight).

### Common seller blind spots — Med Spa
- Medical Director relationship is nominal and may not survive a sale
- Pre-sold packages represent significant undelivered service liability
- Staff performing procedures beyond their legal scope (aestheticians injecting, for example)
- Product expiry dates and inventory that may need to be written down
- Equipment at end of useful life requiring imminent capital expenditure

---

## 2F. DIAGNOSTIC LABS AND IMAGING CENTRES

### Critical fields [CRITICAL]

**Accreditation and licensing**
- What accreditation does the facility hold (IQMH in Ontario, CAP or CLIA in US)?
- Is accreditation current and when was the last inspection?
- Are there any conditions or corrective actions outstanding?
- Who holds the laboratory license or facility license — the company or an individual?

Why it matters: Diagnostic labs and imaging centres cannot operate without proper accreditation. Loss of accreditation means the facility cannot bill for services. Accreditation processes are rigorous and time-consuming — a lapse post-sale can be catastrophic.

**Equipment and technology**
- What diagnostic equipment is owned (MRI, CT, X-ray, ultrasound, lab analyzers)?
- Age, condition, and remaining useful life of major equipment?
- Are there equipment service contracts and what are their terms?
- What is the replacement cost of the equipment suite?
- Is any equipment leased and are leases transferable?

**Revenue and referral sources**
- What is the referral base — family physicians, specialists, hospitals, clinics?
- Are referral relationships documented or informal?
- What is the payer mix (OHIP, insurance, self-pay, hospital contracts)?
- What is the volume trend over the last 3 years?

**Staff qualifications**
- What professional staff are employed (radiologists, lab technologists, medical physicists)?
- Are all staff properly credentialed with relevant professional colleges?
- Is there a staff member whose departure would make the facility unable to operate?

### Jurisdiction-specific [JURISDICTION]

**Ontario**
- IQMH (Institute for Quality Management in Healthcare) provides laboratory accreditation.
- Independent Health Facilities Act (IHFA) governs independent diagnostic facilities — IHF license required.
- IHF licenses may not be transferable — the buyer may need to apply for a new license.
- OHIP billing for diagnostic services has specific fee codes and requirements.

**United States**
- CLIA (Clinical Laboratory Improvement Amendments) certification required for all labs.
- CAP (College of American Pathologists) accreditation is the gold standard.
- Medicare enrollment required for billing — re-enrollment may be needed post-sale.
- Certificate of Need (CON) required in some states for certain imaging equipment (MRI, CT).
- Radiation safety compliance under state radiation control programs.

---

## 2G. HOME CARE AND PERSONAL SUPPORT SERVICES

### Critical fields [CRITICAL]

**Service model and revenue**
- What services are provided (personal support, nursing, homemaking, companionship, specialized care)?
- What is the revenue breakdown by service type?
- What percentage of revenue is government-funded vs private-pay?
- What is the average hourly rate charged and the average hourly cost (margin per hour)?

**Government contracts and funding**
- Does the business hold contracts with government home care programs (LHIN/Ontario Health in Ontario, VA or Medicaid Home Health in US)?
- What are the contract terms, duration, and renewal provisions?
- Are contracts transferable to a new owner?
- What percentage of revenue comes from government contracts?

Why it matters: Government-funded home care contracts are often the primary revenue source. These contracts may require reapplication by a new owner and are not guaranteed to continue post-sale.

**Staffing — the critical challenge**
- How many personal support workers (PSWs), nurses, and other care staff are employed?
- Are staff employees or independent contractors?
- What is the staff turnover rate? (Industry average is very high — 30-50%+ annually)
- What is the staffing capacity vs current demand — are there unfilled shifts?
- What are current wage rates and how do they compare to the market?

Why it matters: Home care is one of the most labour-challenged industries. Chronic staffing shortages mean that even businesses with strong demand cannot always fill all available shifts. A buyer needs to understand staffing capacity as a constraint on revenue.

**Client base and retention**
- How many active clients are served?
- What is the average hours of service per client per week?
- What is the client retention rate?
- Are there any clients who represent a disproportionate share of revenue?

**Compliance and quality**
- Is the business accredited (Accreditation Canada, Joint Commission in US)?
- What is the complaint history with regulatory authorities?
- Are there any outstanding compliance issues or inspection findings?
- What quality metrics are tracked (client satisfaction, incident reports)?

### Jurisdiction-specific [JURISDICTION]

**Ontario**
- Ontario Health (formerly LHINs) contracts are the primary government funding mechanism for home care.
- Service Accountability Agreements (SAAs) govern the relationship — these are with the operator and may require reapplication.
- PSW Registry (voluntary) — understanding of PSW training and certification requirements.
- Home Care and Community Services Act governs service delivery standards.

**United States**
- Medicare Home Health Agency certification required for Medicare billing.
- Medicaid Home and Community-Based Services (HCBS) waivers — state-specific programs.
- State licensing requirements for home health agencies vary significantly.
- OASIS (Outcome and Assessment Information Set) data reporting required for Medicare.

---

## 2H. PHARMACY

### Critical fields [CRITICAL]

**Dispensing volume**
- What is the total monthly prescription volume (number of Rxs filled)?
- What is the average revenue per Rx (professional fee + product margin)?
- What is the OTC (over-the-counter) and front-of-store revenue?
- What is the trend in prescription volume over the last 3 years?

**Payer mix**
- What percentage of prescriptions are paid by government drug programs vs private insurance vs self-pay?
- Ontario: What percentage is ODB (Ontario Drug Benefit)?
- US: What percentage is Medicaid, Medicare Part D, commercial insurance?
- What are the DIR fees (US Medicare Part D dispensing) — these significantly affect net revenue?
- What is the average reimbursement per Rx by payer type?

Why it matters (US): DIR (Direct and Indirect Remuneration) fees are retroactive fees clawed back by PBMs (Pharmacy Benefit Managers). They can be a significant hidden cost that dramatically reduces actual net revenue vs gross revenue.

**Accreditation and licensing**
- Is the pharmacy accredited (OCP in Ontario, state board of pharmacy in US)?
- Does the pharmacy compound medications? If so, is it PCAB accredited (or NAPRA compliant in Canada)?
- Are there any outstanding compliance issues or inspections?
- Is the pharmacy registered for specialty services (e.g., MedsCheck in Ontario, MTM in US)?

**Pharmacist structure**
- Is the owner the pharmacist-in-charge (PIC)?
- Are there additional pharmacists on staff? Are they employees?
- What are the pharmacist scheduling requirements to maintain the license?
- What pharmacy technicians are on staff and are they registered?

**Lease and location**
- What is the lease term and renewal options?
- Is there a clinic, medical building, or hospital nearby driving traffic?
- What are the proximity restrictions (some pharmacy licenses have geographic restrictions)?
- Is the location in a medical/professional building that generates prescription traffic?

**Clinical services**
- What clinical services does the pharmacy offer (vaccinations, medication reviews, prescribing authority for minor ailments)?
- What revenue comes from clinical services vs dispensing?
- Are pharmacists authorized and trained for expanded scope services?

Why it matters: Pharmacy revenue is increasingly coming from clinical services rather than just dispensing. Expanded scope (vaccinations, prescribing for minor ailments in Ontario and other provinces) is a growth area. A pharmacy with strong clinical service revenue is more valuable.

### Jurisdiction-specific [JURISDICTION]

**Ontario**
- OCP (Ontario College of Pharmacists) governs licensing.
- ODB (Ontario Drug Benefit) program — pharmacy must be enrolled. Enrollment transfers with the business if conditions are met.
- Pharmacy ownership: Only pharmacists can be majority owners in Ontario (Pharmacy Act ownership restrictions).
- MedsCheck and other OHIP-funded pharmacy programs — understand revenue from these programs.
- Expanded pharmacist scope (2023+): pharmacists can prescribe for 19 minor ailments — understand uptake and revenue.

**United States**
- PBM contracts (Express Scripts, CVS Caremark, OptumRx) are critical to review — these determine reimbursement rates and may not transfer automatically.
- DEA registration required for controlled substance dispensing — must be re-applied for by new owner.
- State board of pharmacy license — transferability varies by state.
- Medicare Part D: Pharmacy must be enrolled in PDPs. Enrollment required post-sale.
- 340B Drug Pricing Program — if the pharmacy participates, understand the eligibility requirements and revenue impact.

---

---

# 3. RESTAURANTS / FOOD SERVICE

## Sub-industries covered:
- Full-Service Restaurants (independent)
- Quick Service / Fast Casual
- Bars and Nightclubs
- Franchise Restaurants
- Catering
- Food Manufacturing / CPG
- Ghost Kitchens / Delivery-Only
- Bakeries and Specialty Food Retail

---

## 3A. FULL-SERVICE AND QUICK SERVICE RESTAURANTS

### Critical fields [CRITICAL]

**Lease terms**
- What is the current lease term (start date, end date, renewal options)?
- What is the current monthly base rent and any additional rent (CAM, TMI)?
- What is the rent-to-revenue ratio? (Healthy is typically under 8-10% of gross revenue)
- Does the lease have a personal guarantee? Who is the guarantor?
- Does the lease have a change-of-ownership clause that requires landlord consent?
- Has the landlord indicated any issues with assigning the lease to a buyer?
- Are there any demolition clauses or redevelopment risks?
- Is there exclusive use protection (no other restaurant of same type in the plaza)?

Why it matters: The lease is the single most important document in a restaurant transaction. A restaurant with great numbers but a lease expiring in 12 months with an uncooperative landlord is nearly unsellable. Buyers need comfort that they can operate the location for at least 5-10 years.

How to retrieve: Pull the original lease document plus any amendments from your files. If you don't have it, contact your landlord for a copy.

**Liquor license**
- Does the business have a liquor license? What type (beer/wine only, full spirits, patio)?
- Is the license in the name of the business or the individual owner?
- Is the license transferable or does the buyer need to apply for a new one?
- Have there been any liquor license violations, suspensions, or warnings?
- What is the seating capacity under the current license?
- What percentage of total revenue comes from alcohol sales?

Why it matters: In most jurisdictions, liquor licenses are highly regulated and can take months to transfer or obtain. Some licenses are not transferable at all. A restaurant where alcohol is 30%+ of revenue cannot operate profitably without the license during a transition.

How to retrieve: Contact the AGCO (Ontario), LCRB (BC), AGLC (Alberta), or your state liquor authority (ABC boards in California, SLA in New York, TABC in Texas, etc.).

**Revenue and traffic**
- What is the annual gross revenue? Broken down by dine-in, takeout, delivery, catering, bar?
- What is the average weekly/monthly revenue? Is there seasonal variation?
- What is the average transaction value (ATV or average check)?
- What are the daily/weekly covers (number of customers served)?
- What percentage of revenue comes from delivery apps (UberEats, DoorDash, SkipTheDishes) and what are the associated fees?
- What is the revenue trend over the last 3 years — growing, stable, or declining?

**Food and labour costs**
- What is the current food cost percentage of revenue? (Industry standard: 28-35%)
- What is the current labour cost percentage of revenue? (Industry standard: 30-35%)
- What is the combined COGS + labour as a percentage of revenue?
- Are there any supplier agreements or pricing contracts in place?
- What is the food waste percentage and how is waste managed?

Why it matters: Food and labour are the two largest costs in a restaurant. If combined they exceed 65-70% of revenue, the business is likely struggling to generate meaningful profit. Buyers will want to understand any cost-saving opportunities.

**Health and safety compliance**
- What is the current health inspection rating/score?
- Have there been any health inspection failures, closures, or critical violations in the last 3 years?
- Are there any outstanding orders from the health department?
- Do all food handlers have current food safety certification?

How to retrieve: Health inspection records are public in most jurisdictions. Check your regional public health unit or local health department.

**Equipment and kitchen**
- Is the kitchen equipment owned or leased?
- What is the age and condition of major equipment (hoods, fryers, refrigeration, dishwasher)?
- Are there any equipment that needs replacement in the near term?
- What is the replacement cost of the kitchen package?
- What is the grease trap maintenance schedule and compliance status?

**Staffing**
- How many staff are employed (FOH and BOH separately)?
- Are there any key employees — head chef, manager — without whom the business would struggle?
- What is the staff turnover rate?
- Does the owner work in the business? How many hours per week?
- Are there any Temporary Foreign Worker (TFW) program employees? What are the visa status and obligations?

**Online presence and reviews**
- What is the Google rating and number of reviews? Yelp? TripAdvisor?
- What are the social media follower counts and engagement?
- Is there an email list or loyalty program?
- What is the online ordering system and what are the technology costs?

**Recipes and intellectual property**
- Does the restaurant have proprietary recipes or menu items?
- Are recipes documented and transferable, or only in the head chef's memory?
- Is the restaurant name trademarked?

Why it matters: If the head chef knows all the recipes and leaves, the buyer may not be able to replicate the menu. Undocumented recipes are a significant key-person risk.

### Jurisdiction-specific [JURISDICTION]

**Ontario**
- AGCO (Alcohol and Gaming Commission of Ontario) governs liquor licensing.
- Liquor Sales License (LSL) — transferable if buyer meets requirements, but AGCO approval required.
- Food Handler Certification required for staff.
- Public Health Ontario governs food safety inspections — reports are public.
- DineSafe (Toronto) — inspection results publicly posted.
- ESA compliance for staff — tip pooling rules, hours of work, scheduling requirements.

**British Columbia**
- LCRB (Liquor and Cannabis Regulation Branch) governs liquor licensing.
- Liquor Primary vs Food Primary license distinction — affects what type of establishment can operate.

**Alberta**
- AGLC (Alberta Gaming, Liquor and Cannabis) governs licensing.
- Liquor licenses are transferable with AGLC approval.

**United States (General)**
- Liquor license types and transferability vary dramatically by state.
- Some states (Pennsylvania, Utah) have government-controlled liquor — very different rules.
- Health department inspections — records are public and buyers will review them.
- ADA (Americans with Disabilities Act) compliance for the physical space.
- Some cities have specific requirements (NYC fire suppression, LA seismic, etc.)
- Tip credit laws vary by state — affects true labour cost.

**California**
- ABC (Alcoholic Beverage Control) governs liquor licensing.
- Type 41 (beer/wine), Type 47 (full liquor with food) licenses — Type 47 is much more valuable.
- License transfer can take 45-90 days.
- Cal/OSHA specific requirements for restaurant workers.

**New York**
- SLA (State Liquor Authority) governs licensing.
- Restaurant Wine license vs Full On-Premises license — different rules.
- NYC DOH letter grading system — public and highly visible.

**Texas**
- TABC (Texas Alcoholic Beverage Commission) governs licensing.
- Mixed Beverage Permit (MB) is the main full-liquor license.
- Wet/dry county status matters significantly.

**Florida**
- DBPR (Department of Business and Professional Regulation) governs licensing.
- Special licenses for beach/resort areas.
- COP (Conditional Use Permit) and SRX (Special Restaurant Exception) licenses.

### Common seller blind spots
- Rent-to-revenue ratio is too high but seller doesn't recognize it
- Delivery app commission costs (15-30%) are not separated in financials
- Head chef dependency — recipes not documented
- Equipment end-of-life — major items due for replacement within 2 years
- Outstanding health code violations being "worked on"
- Personal use of the business (meals, groceries, entertainment) not properly added back
- TFW program obligations and visa renewal costs

---

## 3B. BARS AND NIGHTCLUBS

### Critical fields [CRITICAL] (in addition to 3A)

**License type and capacity**
- Is this a Liquor Primary license (bar/nightclub) vs Food Primary (restaurant)?
- What is the licensed capacity?
- Are there any noise complaints, neighbor disputes, or municipal orders outstanding?
- Are there any late-night operating hours restrictions?
- What is the patio capacity and is the patio license separate?

**Revenue concentration**
- What percentage of revenue is alcohol vs food vs cover charges vs events?
- Is there a regular events program (DJ nights, live music, themed events)?
- Are there any booking or entertainment contracts outstanding?
- What is the average spend per customer?

**Security and compliance**
- Is there a security company or in-house security?
- Have there been any incidents (fights, assaults) that resulted in police reports?
- Has the license ever been put on notice or had conditions imposed?
- What is the relationship with local law enforcement?

Why it matters: Nightclub liquor licenses are the most scrutinized by regulatory bodies. A history of incidents can result in conditions being placed on the license (reduced hours, security requirements) or non-renewal.

---

## 3C. FRANCHISE RESTAURANTS

### Critical fields [CRITICAL] (in addition to 3A)

**Franchise agreement**
- What is the remaining term on the franchise agreement?
- What are the renewal terms and fees?
- Does the franchisor have the right of first refusal to purchase the business?
- What are the transfer conditions and fees required by the franchisor?
- Has the franchisor approved the current owner/location for the remaining term?
- What is the initial franchise fee and is any portion still outstanding?

**Franchisor relationship**
- What is the current relationship with the franchisor?
- Are there any outstanding compliance issues, warnings, or notices from the franchisor?
- Has there been any recent remodel requirement issued by the franchisor?
- What is the franchisor's current financial health and system-wide performance?

Why it matters: Franchise agreements always require franchisor consent to transfer. Some franchisors are very buyer-friendly; others are restrictive. The franchisor can reject a buyer or impose significant conditions. Remodel requirements can cost $200K-$1M+ and must be disclosed.

**Royalty and marketing fees**
- What is the current royalty rate as a percentage of gross sales?
- What is the current marketing/advertising fund contribution?
- Are there any other required purchases (mandated suppliers, technology fees)?
- What are the total franchisor-related costs as a percentage of revenue?

---

## 3D. FOOD MANUFACTURING / CPG (Consumer Packaged Goods)

### Critical fields [CRITICAL]

**Products and SKUs**
- What products does the business manufacture? How many SKUs?
- Are products sold under the company's own brand, private label, or both?
- Are any products protected by patent, trademark, or proprietary recipe?
- What is the product lifecycle — are any products in decline?

**Sales channels**
- What percentage of revenue comes from: retail (grocery, specialty), foodservice (restaurants, institutions), direct-to-consumer (online, farmers markets), wholesale/distributor?
- Which specific retail chains carry the products?
- Are there any listing agreements or slotting arrangements with retailers?
- What are the trade promotion and marketing allowance costs?

Why it matters: Retail listings are not guaranteed to transfer. A new owner may need to re-pitch products to buyers at retail chains, and there is no guarantee of continued shelf space. Trade promotion costs (slotting fees, listing fees, promotional allowances) can be significant and are often not obvious in the P&L.

**Production capacity and facility**
- What certifications does the facility hold (SQF, BRC, HACCP, Kosher, Halal, Organic, etc.)?
- Is the facility owned or leased?
- What is the current production capacity vs actual production volume?
- Are there any co-packing or toll manufacturing arrangements?
- What is the facility's age and condition?

**Regulatory compliance**
- CFIA (Canadian Food Inspection Agency) compliance in Canada
- FDA (Food and Drug Administration) compliance in the US
- Are there any outstanding recalls, warnings, or enforcement actions?
- What allergen management protocols are in place?
- Are product labels compliant with current labeling requirements (Nutrition Facts, ingredient lists, allergen declarations)?

---

## 3E. CATERING COMPANIES

### Critical fields [CRITICAL]

**Revenue model and seasonality**
- What is the revenue breakdown by event type (corporate, weddings, social, institutional)?
- What is the seasonal revenue pattern? What percentage of revenue falls in Q4?
- What is the average event size and average revenue per event?
- What is the forward booking pipeline (signed contracts for upcoming events)?

**Client base and retention**
- Are there recurring corporate clients with ongoing contracts?
- What percentage of revenue comes from repeat clients vs one-time bookings?
- Are client relationships personal to the owner or to the company?
- Are there any exclusive venue partnerships or preferred caterer agreements?

Why it matters: Catering companies with strong corporate retainers and venue partnerships have much more predictable revenue than those dependent on one-time social events. Preferred caterer status at popular venues is a significant competitive moat.

**Kitchen facility and licensing**
- Does the business operate from a commercial kitchen? Is it owned or leased?
- Is the kitchen facility properly licensed for commercial food production?
- What is the kitchen capacity — can it handle current demand and growth?
- Is there commissary space for event prep and staging?

**Equipment and vehicles**
- What catering-specific equipment is owned (chafing dishes, serving equipment, linens)?
- Are there delivery/transport vehicles? Owned or leased?
- Is there any event rental equipment (tables, chairs, tents) owned by the business?

**Staff model**
- Are event staff full-time employees, part-time, or casual/on-call?
- Is the head chef an employee or contractor?
- Are there key staff (event managers, head chef) whose departure would significantly impact operations?

### Common seller blind spots — Restaurants/Food
- Catering deposit liabilities for future events are not disclosed
- Delivery app commissions eating into margins are hidden in COGS
- Kitchen equipment at end of life requiring near-term capital
- Seasonal cash flow challenges are minimized
- Recipes and menu IP in the head chef's head rather than documented
- Food safety certification lapses during transition periods

---

---

# 4. MANUFACTURING

## Sub-industries covered:
- General Manufacturing
- Metal Fabrication
- Plastics and Composites
- Food and Beverage Manufacturing (see 3D above)
- Industrial / B2B Manufacturing
- Custom / Job Shop Manufacturing
- Woodworking and Millwork
- Printing and Packaging

---

## 4A. GENERAL MANUFACTURING

### Critical fields [CRITICAL]

**Customer concentration**
- Who are the top 5 customers and what percentage of revenue does each represent?
- Are there any customers representing more than 20% of revenue?
- What is the nature of the relationship — long-term contracts, purchase orders, or spot buying?
- When do key customer contracts expire?
- Have any customers indicated they may reduce orders or leave?
- Are key customer relationships with the company or with the owner personally?

Why it matters: Customer concentration is the #1 risk buyers identify in manufacturing. A business where one customer is 50% of revenue is at serious risk if that customer leaves. Buyers will often require the top customers to sign letters confirming the relationship will continue post-sale, or they will escrow part of the purchase price against customer retention.

**Equipment**
- Complete list of all manufacturing equipment with age, condition, and replacement cost
- What is owned outright vs financed vs leased?
- Are there any pieces of equipment that are critical to production and have long lead times for replacement?
- What is the current equipment utilization rate (are machines running at capacity or underutilized)?
- Is any equipment approaching end-of-life that will require capital investment?
- What is the preventive maintenance program and schedule?

**Production capacity and backlog**
- What is the current monthly production capacity in units or dollars?
- What is the current production volume as a percentage of capacity?
- Is there a backlog of orders? What is it worth?
- What would it cost to expand capacity (new equipment, additional shifts, larger facility)?
- Are there any bottleneck processes that constrain output?

**Supply chain and raw materials**
- Who are the key suppliers for raw materials?
- Are there any single-source suppliers (only one source for a critical material)?
- What are current inventory levels and carrying costs?
- Have there been any recent supply chain disruptions?
- Are raw material prices fixed by contract or subject to market fluctuation?
- What is the lead time for critical materials?

**Quality certifications**
- What quality certifications does the business hold? (ISO 9001, AS9100, IATF 16949, etc.)
- What is the current certification status and when was the last audit?
- What is the customer return/defect rate?
- Is there a documented quality management system (QMS)?

Why it matters: In B2B manufacturing, certifications are often a requirement to supply certain customers. Losing a certification post-sale could mean losing the customers that require it.

**Intellectual property**
- Does the business own any patents, proprietary processes, or trade secrets?
- Are there any proprietary product designs or tooling?
- Are there any licensed technologies (royalties payable)?
- Does the business own tooling/dies/molds for customer products, or does the customer own them?

**Workforce**
- How many production employees are there?
- What is the union status?
- What are the skill requirements for production workers — how difficult are they to replace?
- What is the staff tenure and turnover rate?
- Are there any key engineers, programmers (CNC), or technicians who are critical?
- Are there any Temporary Foreign Worker (TFW) program dependencies?

**Facility**
- Is the facility owned or leased?
- What are the lease terms if leased?
- What is the size (square footage) and is there room to expand?
- What is the zoning designation? Is the current use compliant?
- Are there any environmental issues (contamination, underground storage tanks, hazardous materials)?
- What is the building condition — roof, HVAC, electrical capacity, loading docks?
- What is the power supply (single-phase vs three-phase) and is it adequate for current and future needs?

### Jurisdiction-specific [JURISDICTION]

**Ontario**
- TSSA (Technical Standards and Safety Authority) governs pressure vessels, boilers, elevating devices.
- Environmental Compliance Approvals (ECAs) from Ministry of Environment required for air emissions, water discharge.
- OHSA (Occupational Health and Safety Act) — check for any outstanding Ministry of Labour orders.
- Waste disposal — Environmental Compliance Approval required for certain waste streams.
- WSIB rate group classification — manufacturing classifications carry higher premiums.

**Alberta**
- AER (Alberta Energy Regulator) may apply for manufacturers in the energy sector.
- OHS (Occupational Health and Safety) Act — Alberta Employment and Immigration governs.
- Environmental Protection and Enhancement Act (EPEA) permits for air emissions.

**United States**
- OSHA compliance — check for any outstanding citations or penalties.
- EPA compliance — air permits (Title V or synthetic minor), water discharge permits (NPDES), hazardous waste generator status.
- State environmental regulations vary significantly — California, New York, New Jersey are most stringent.
- Export controls (ITAR, EAR) if manufacturing defense-related or dual-use products.
- FLSA (Fair Labor Standards Act) compliance for overtime, minimum wage.

### Common seller blind spots
- Equipment replacement costs are underestimated — "it still works" doesn't mean it's not obsolete
- Customer concentration risk is downplayed — "they've been with us for 20 years"
- Environmental compliance gaps (air emissions, waste disposal) not identified
- Single-source supplier dependencies not flagged as risks
- Key technical employees (CNC programmers, tool and die makers) who are irreplaceable
- Deferred maintenance on facility and equipment
- Tooling ownership disputes — customer-owned tooling mixed with company-owned

---

## 4B. METAL FABRICATION

### Critical fields [CRITICAL] (in addition to 4A)

**Equipment specifics**
- What cutting equipment is in use (laser, plasma, waterjet, saw)?
- What forming equipment (press brakes, rollers, stamping presses)?
- What welding capability (MIG, TIG, robotic welding)?
- What finishing equipment (painting, powder coating, sandblasting)?
- Are welders CWB (Canadian Welding Bureau) certified in Canada, or AWS (American Welding Society) certified in the US?
- What CNC equipment is in use and who programs it?

**Welding certifications**
- Does the business hold CWB (Canada) or AWS (US) certification?
- Are certifications company-held or individually held?
- Certain structural and pressure vessel work requires specific weld procedure specifications (WPS) — are these documented?
- What CSA W47.1 or W47.2 certification division does the business hold?

**Structural steel specific**
- Is the company a fabricator, erector, or both?
- What CISC (Canadian Institute of Steel Construction) certification is held?
- What AISC (American Institute of Steel Construction) certification is held (if US)?
- What tonnage capacity can the shop handle?

---

## 4C. WOODWORKING AND MILLWORK

### Critical fields [CRITICAL] (in addition to 4A)

**Specialization**
- What type of woodworking — architectural millwork, cabinetry, furniture, structural components?
- Is the work custom (project-based) or production (standard products)?
- What CNC routing and machining capability exists?

**Design and engineering**
- Is design done in-house or by customers?
- What CAD/CAM software is used (AutoCAD, SolidWorks, Cabinet Vision)?
- Who handles design — the owner or dedicated staff?

**Installation**
- Does the business do installation or shop fabrication only?
- If installation: are installers employees or subcontractors?
- What geographic area is served for installation?

**Dust collection and environmental**
- Is there a dust collection system? Is it compliant with fire code and environmental requirements?
- Are there any fire marshal orders or environmental orders related to wood dust?
- What finishing/coating systems are used and are VOC emissions permitted?

Why it matters: Wood dust is a combustible material and a regulated health hazard. Inadequate dust collection systems create fire risk and OSHA/MOL compliance issues. Finishing operations with VOC emissions may require environmental permits.

---

## 4D. PRINTING AND PACKAGING

### Critical fields [CRITICAL] (in addition to 4A)

**Equipment and technology**
- What printing technology is used (offset, digital, flexographic, wide-format)?
- Age and condition of presses and finishing equipment?
- What pre-press and design capabilities exist?
- Is there a CTP (computer-to-plate) system?

**Revenue model**
- What percentage of revenue is commercial print vs packaging vs specialty (labels, signage, large format)?
- Are there any long-term supply agreements with customers?
- What is the average job size and volume of jobs per month?

**Industry trends**
- Is revenue growing, stable, or declining? (Commercial print is in structural decline in many segments)
- What investments have been made in digital and specialty capabilities?
- Is there a web-to-print or e-commerce ordering capability?

Why it matters: The commercial printing industry has experienced significant structural decline due to digital alternatives. Buyers will scrutinize the revenue trend carefully. Businesses that have pivoted to packaging, labels, or specialty printing are valued more highly than traditional commercial printers.

---

---

# 5. PROFESSIONAL SERVICES FIRMS

## Sub-industries covered:
- Accounting and Bookkeeping Firms
- Legal Practices
- Engineering Firms
- Architecture Firms
- IT / Managed Services Providers (MSP)
- Marketing and Advertising Agencies
- HR and Staffing Firms
- Financial Advisory / Wealth Management

---

## 5A. ACCOUNTING AND BOOKKEEPING FIRMS

### Critical fields [CRITICAL]

**Client base and concentration**
- How many active clients?
- What is the revenue breakdown by client? What is the largest client as a percentage of revenue?
- What services does each major client receive (bookkeeping only, tax only, full-service accounting, audit)?
- How long has each major client been with the firm?
- Are there written engagement letters with all clients?
- What is the annual client attrition rate?

Why it matters: Professional service firms are relationship businesses. Clients often follow the accountant they know, not the firm. Buyers need to understand whether the client relationships are transferable — and this depends heavily on whether clients know the business owner personally.

**Revenue type**
- What percentage of revenue is recurring (monthly bookkeeping retainers, payroll, ongoing advisory) vs seasonal (tax preparation) vs one-time (transactions, audits)?
- What is the revenue per client per year?
- What is the fee realization rate (actual billed vs standard rates)?

Why it matters: Recurring revenue (retainers) is far more valuable than seasonal tax return revenue, which peaks in March-April and then drops off. Buyers will pay a premium for a firm with high recurring revenue.

**Staff and succession**
- How many professional staff are there (CPAs, CPBs, bookkeepers, clerks)?
- Are staff certified and in good standing with their professional body?
- Are key staff aware of the potential sale and are they expected to stay?
- Does the owner have a book of clients that is personal to them?
- What are staff billing rates and utilization rates?

**Owner involvement**
- What is the owner's role? Are they primarily a rainmaker (bringing in clients) or a service provider (doing the work)?
- If the owner is the primary client relationship, what happens to those clients when the owner leaves?
- What percentage of total billable hours does the owner personally produce?

**Practice management software**
- What software is used (TaxCycle, Profile, UFile, CCH, Drake, UltraTax, QuickBooks, Xero, etc.)?
- Are client records electronic and organized?
- What is the process for onboarding a new buyer to client files?
- Is the firm cloud-based or server-based?

### Jurisdiction-specific [JURISDICTION]

**Ontario**
- CPA Ontario governs accounting professionals.
- Public accounting (audit, review, compilation reports for third-party use) requires a Public Accounting License (PAL).
- Check if any PAL holders are key employees and whether they plan to stay.
- Only firms with PAL holders can issue audit/review reports — losing a PAL holder eliminates this revenue stream.

**Canada (General)**
- CPA designation is national but registration is provincial.
- Professional liability insurance is required by most CPA bodies.

**United States**
- CPA license is state-specific. Multi-state practice requires licenses in each state (or use of reciprocity).
- PCAOB oversight for public company auditors.
- Non-CPA accounting firms can provide bookkeeping and tax services without a CPA license in most states.
- Enrolled Agent (EA) status for tax practitioners — federal designation that doesn't require CPA.

---

## 5B. LEGAL PRACTICES

### Critical fields [CRITICAL]

**Practice areas and revenue**
- What areas of law are practiced (family, real estate, corporate, litigation, personal injury, immigration, criminal, estates)?
- What is the revenue breakdown by practice area?
- What is the contingency fee work vs hourly billing vs flat-fee breakdown?
- Are there any ongoing contingency cases with potentially large recoveries?

Why it matters: Different practice areas have very different risk profiles for buyers. A real estate and corporate practice with transactional recurring work is far more transferable than a litigation practice dependent on the lead litigator's courtroom reputation. Contingency fee cases represent both opportunity (large future fees) and risk (uncertain outcomes).

**Client base and referral sources**
- How many active clients?
- What is the client concentration — any single client more than 15% of revenue?
- Where do new clients come from (referrals, marketing, repeat)?
- Are client relationships with the firm or with individual lawyers?
- Are there any institutional clients on retainer?

**Lawyer structure**
- How many lawyers are in the firm (partners, associates, of counsel)?
- Are associates employees or independent contractors?
- What are the associate compensation structures?
- Do associates have non-compete or non-solicit agreements?
- Are there any partners planning to depart?

**Trust accounts**
- What is the current trust account balance?
- Is the trust account properly maintained and reconciled?
- Are there any outstanding Law Society compliance issues related to trust accounts?

Why it matters: Law society trust account requirements are among the most strictly regulated areas. Trust account irregularities can result in Law Society investigation, discipline, or license suspension. Buyers must verify trust account compliance before closing.

**Work in progress and receivables**
- What is the current WIP (time recorded but not yet billed)?
- What is the total accounts receivable and aging?
- What is the collection rate (percentage of billed fees actually collected)?
- What is the average time from billing to collection?

**Professional liability**
- Does the firm carry professional liability (errors & omissions) insurance?
- What is the coverage amount and premium?
- Are there any outstanding claims or reported incidents?
- Is there a claims history that would affect future premiums?

### Jurisdiction-specific [JURISDICTION]

**Ontario**
- Law Society of Ontario (LSO) governs all lawyers and paralegals.
- Professional Corporations allowed — only lawyers can be shareholders.
- LAWPRO (Lawyers' Professional Indemnity Company) provides mandatory E&O insurance.
- Trust account compliance governed by LSO By-Law 9.
- Paralegal licensing under LSO — understand if the firm employs licensed paralegals.

**Canada (General)**
- Each province has its own Law Society governing lawyers.
- Inter-provincial mobility exists through the National Mobility Agreement.
- Professional corporation rules vary by province.

**United States**
- State bar admission required for each state of practice.
- ABA (American Bar Association) accreditation standards for law firms.
- IOLTA (Interest on Lawyers' Trust Accounts) compliance.
- Multijurisdictional practice rules for lawyers licensed in other states.
- Non-lawyer ownership is prohibited in most states (exceptions: Arizona, Utah regulatory sandbox).

---

## 5C. IT / MANAGED SERVICES PROVIDERS (MSP)

### Critical fields [CRITICAL]

**Revenue composition**
- What percentage of revenue is Managed Services (monthly recurring) vs project-based vs time-and-materials?
- What is the total Monthly Recurring Revenue (MRR)?
- What is the Annual Recurring Revenue (ARR)?
- What is the average contract value and length for managed services agreements?
- What is the MRR growth rate over the last 12 months?

Why it matters: MSP businesses are valued almost entirely on the quality and stickiness of their recurring revenue. A pure MRR business with long contracts and high retention is worth 4-8x EBITDA. A project-heavy business with little recurring revenue is worth 1-2x.

**Client contracts**
- Do clients have written managed services agreements?
- What are the contract lengths (month-to-month vs 1-year vs 3-year)?
- What are the termination clauses?
- Do contracts have change-of-ownership clauses?
- What is the client retention rate year-over-year?
- What is the average revenue per managed client per month?

**Technical stack and tooling**
- What RMM (Remote Monitoring and Management) platform is used (ConnectWise, NinjaRMM, Datto, Kaseya)?
- What PSA (Professional Services Automation) software is used (ConnectWise Manage, Autotask, HaloPSA)?
- What backup and disaster recovery solutions are deployed?
- What security stack is offered (EDR, SIEM, SOC)?
- What is the monthly tooling cost per endpoint?

Why it matters: The tooling stack is often a significant asset. If the MSP has invested in sophisticated security tooling, that enables higher-margin security services.

**Vendor and partner relationships**
- What vendor partnerships does the business hold (Microsoft Partner status, Cisco, HP, Dell, etc.)?
- What is the partner tier level for key vendors?
- Do partnerships transfer with the business?
- Are there any co-managed arrangements with clients' internal IT?

**Technical staff**
- How many technical staff are there and what certifications do they hold?
- What is the ratio of technicians to managed endpoints?
- Are there any key technicians who have deep client relationships?
- What is the after-hours support model and on-call rotation?

**Cybersecurity and liability**
- Has the business ever had a security incident affecting a client?
- What cyber liability insurance is carried?
- Are there any outstanding claims or disputes with clients?
- Does the MSP have its own security practices documented (internal SOC 2, security policies)?

### Common seller blind spots — MSP
- MRR churn is understated because cancelled clients are replaced before month-end reporting
- Tooling costs are growing faster than MRR — margin compression
- Key technician departure risk not addressed with non-competes
- Cybersecurity liability exposure from client incidents
- Vendor partnership tiers may not transfer automatically

---

## 5D. ENGINEERING FIRMS

### Critical fields [CRITICAL]

**Billable utilization**
- What is the average billable utilization rate across professional staff?
- What is the average billing rate by staff level (junior, intermediate, senior, principal)?
- What is the revenue per employee?
- What is the fee realization rate?

**Project backlog**
- What is the current signed backlog (awarded contracts not yet billed)?
- What is in the pipeline (proposals submitted)?
- What is the historical bid-to-win ratio for proposals?

**Client concentration and retention**
- Repeat client revenue percentage
- Government vs private sector split
- Key client relationships — are they with the firm or with individual engineers?
- Are there any master service agreements (MSAs) with key clients?

**Licensing and professional liability**
- Are the principals and key staff licensed Professional Engineers (P.Eng in Canada, PE in US)?
- Are licenses in good standing with the provincial/state engineering association?
- Does the firm carry professional liability (errors & omissions) insurance?
- Has there ever been a professional liability claim?
- What is the claims history and current E&O premium?

### Jurisdiction-specific [JURISDICTION]

**Ontario**
- PEO (Professional Engineers Ontario) governs engineering licensing.
- Certificate of Authorization (C of A) required for the firm to offer engineering services to the public.
- C of A is company-held and should transfer with the business — verify with PEO.

**Canada (Other Provinces)**
- Each province has its own engineering association (APEGA in Alberta, Engineers and Geoscientists BC, etc.)
- Inter-provincial licensing (IPEA) exists but check whether the firm has clients in multiple provinces.

**United States**
- PE license is state-specific. Check whether key engineers are licensed in the states where the firm operates.
- NCEES provides a pathway for inter-state licensing.
- Many engineering disciplines have specific practice requirements (structural, geotechnical, environmental).

---

## 5E. ARCHITECTURE FIRMS

### Critical fields [CRITICAL]

**Project portfolio and backlog**
- What types of projects does the firm specialize in (residential, commercial, institutional, industrial)?
- What is the current signed backlog and pipeline?
- What is the average project size and duration?
- What is the revenue concentration by client?

**Licensing**
- Are the principals licensed architects (OAA in Ontario, AIA/state registration in US)?
- Is the firm registered with the relevant architectural association?
- Does firm registration transfer with a change of ownership?

**Design IP and portfolio**
- Does the firm own the design copyright for past projects?
- Are there any ongoing licensing arrangements for designs?
- Is the firm's design portfolio a marketable asset?

**Staff and key person**
- Who leads design — is it the selling principal?
- How many licensed architects vs interns/graduates are on staff?
- Are design relationships personal to the principal or to the firm brand?

Why it matters: Architecture firms are among the most principal-dependent professional services firms. If clients hire the firm because of the lead architect's design reputation and that person leaves, the firm's value can evaporate rapidly.

### Jurisdiction-specific [JURISDICTION]

**Ontario**
- OAA (Ontario Association of Architects) governs licensing. Certificate of Practice required for the firm.
- BCIN (Building Code Identification Number) — required for building permit applications. Check who holds the BCIN.

**United States**
- Architect Registration Examination (ARE) and state registration required.
- NCARB (National Council of Architectural Registration Boards) certification allows multi-state practice.
- Firm registration requirements vary by state.

---

## 5F. MARKETING AND ADVERTISING AGENCIES

### Critical fields [CRITICAL]

**Revenue model**
- What percentage of revenue is retainer-based vs project-based vs performance/commission?
- What is the average retainer value and duration?
- What is the client retention rate?
- What is the revenue per employee?

**Client concentration**
- Top clients by revenue and percentage
- Contract terms and termination clauses
- Change-of-ownership provisions
- Length of client relationships

**Services offered**
- What specific services does the agency provide (digital, SEO/SEM, social media, creative, media buying, PR, branding, web development)?
- Are services delivered in-house or subcontracted?
- Are there any subcontractors or freelancers critical to service delivery?
- What is the in-house vs outsourced ratio?

**Media buying**
- If the agency does media buying, what is the gross media spend under management?
- Are there any media buying agreements or agency of record contracts?
- What are the commission structures on media buys?

**Intellectual property**
- Who owns the creative work produced — the agency or the clients?
- Are there any ongoing royalty-generating IP assets?
- Are client contracts clear on IP ownership?

**Key person risk**
- Are client relationships held by the owner or by account managers?
- Could clients be retained if the owner departed?

---

## 5G. HR AND STAFFING FIRMS

### Critical fields [CRITICAL]

**Revenue model**
- What is the split between temporary staffing (contract/temp placements), permanent placement (direct hire), and HR consulting/outsourcing?
- For temporary staffing: what is the markup percentage on hourly rates?
- For permanent placement: what is the average fee (percentage of salary or flat fee)?
- What is the average fill rate (percentage of job orders successfully filled)?

Why it matters: Temporary staffing is recurring revenue with thin margins but high volume. Permanent placement is project-based with higher margins but less predictability. HR consulting/outsourcing can be retainer-based. Buyers value each differently.

**Client base and contracts**
- How many active clients?
- What are the top clients by revenue and their concentration?
- Are there written staffing agreements with key clients?
- What are the payment terms and average collection period?
- Are there any exclusivity arrangements with clients?

**Candidate pool**
- What is the size of the candidate database?
- What is the quality and freshness of the database (how many active candidates)?
- Are there any exclusive candidate relationships?
- What recruitment technology and ATS (Applicant Tracking System) is used?

**Compliance and risk**
- Are temporary workers employed by the staffing firm or by the client?
- What is the workers' compensation and employment liability exposure?
- Are there any outstanding employment claims (wrongful termination, discrimination)?
- Is the firm compliant with employment standards (ESA in Ontario, FLSA in US)?
- Are pay equity and anti-discrimination policies documented?

**Industry specialization**
- Is the firm specialized in specific industries or roles?
- Does specialization create a competitive moat or a concentration risk?

### Jurisdiction-specific [JURISDICTION]

**Ontario**
- Employment Standards Act (ESA) governs temporary worker rights including equal pay provisions.
- Temporary Help Agency licensing under the ESA — registration required with the Ministry of Labour.
- WSIB coverage required for all temporary workers.

**United States**
- EEOC compliance for all staffing activities.
- State-specific staffing agency licensing requirements.
- ACA (Affordable Care Act) compliance for temporary workers exceeding hour thresholds.
- Joint employment liability — both staffing firm and client may be considered employers.

---

## 5H. FINANCIAL ADVISORY / WEALTH MANAGEMENT

### Critical fields [CRITICAL]

**Assets Under Management (AUM)**
- What is the total AUM?
- What is the fee structure (fee-only, AUM-based, commission-based, hybrid)?
- What is the average fee as a percentage of AUM?
- What is the revenue per client?
- What is the AUM trend — growing, stable, or declining?

**Client demographics and retention**
- What is the average client age? (Older client base = higher near-term attrition risk due to estate distributions)
- What is the client retention rate?
- Are clients institutional or individual?
- Are clients tied to the advisor personally or to the firm?
- What is the average client relationship tenure?

**Regulatory and licensing**
- What registrations does the firm/advisor hold (in Canada: IIROC/CIRO, OSC registration; in US: SEC-registered RIA, FINRA-registered broker-dealer)?
- Are there any outstanding FINRA/CIRO complaints or disciplinary history?
- Are there any ongoing regulatory reviews?
- What compliance infrastructure is in place (Chief Compliance Officer, compliance software)?

**Book of business transferability**
- In a commission-based practice: Is the book of business owned by the advisor or the dealer?
- In a fee-only RIA (US): Client agreements typically allow transfer with client consent.
- What is the expected client attrition on a change of advisor?
- Are there any client agreements with change-of-control provisions?

### Jurisdiction-specific [JURISDICTION]

**Ontario/Canada**
- CIRO (Canadian Investment Regulatory Organization, formerly IIROC + MFDA merged) governs investment dealers and mutual fund dealers.
- OSC (Ontario Securities Commission) or provincial equivalent governs registration.
- Insurance-based products (segregated funds) — advisor must hold life insurance license through FSRA.
- Client Focused Reforms (CFR) — compliance with know-your-client and suitability requirements.

**United States**
- SEC-registered RIAs (over $100M AUM) vs state-registered RIAs.
- FINRA regulates broker-dealers.
- Form ADV (RIA disclosure document) — review for any regulatory issues.
- Series 65 (RIA), Series 7 (broker-dealer) licenses held by key advisors.
- DOL Fiduciary Rule — understanding of fiduciary obligations.

---

---

# 6. AUTOMOTIVE

## Sub-industries covered:
- Auto Dealerships (new and used)
- Auto Repair and Service Shops
- Auto Body and Collision Repair
- Tire and Wheel Shops
- Auto Parts and Accessories (retail and wholesale)
- Car Washes
- Auto Detailing
- Specialty Automotive (performance, restoration, fleet services)

---

## 6A. AUTO REPAIR AND SERVICE SHOPS

### Critical fields [CRITICAL]

**Licensing and certifications**
- Is the shop licensed as an auto repair facility with the provincial/state authority?
- Are mechanics Red Seal certified (Canada) or ASE certified (US)?
- How many licensed technicians are on staff and are certifications in their names or transferable?
- Does the shop hold any OEM (Original Equipment Manufacturer) certifications for specific brands?
- What specialty certifications exist (hybrid/EV, diesel, transmission, AC/refrigerant)?

Why it matters: In Ontario, auto repair facilities must be registered with OMVIC (Ontario Motor Vehicle Industry Council) and comply with the Motor Vehicle Repair Act. In the US, state-level licensing varies. OEM certifications (e.g., being a certified Toyota or Mercedes repair center) attract specific customers and may not transfer to a new owner without reapplication.

How to retrieve: Check your OMVIC registration certificate (Ontario) or state motor vehicle repair license. OEM certifications are documented through the manufacturer's dealer/service portal.

**Bay capacity and utilization**
- How many service bays does the shop have?
- What is the average number of vehicles serviced per day/week?
- What is the current utilization rate (bays in use vs available)?
- What is the average revenue per repair order (RO)?
- What is the mix of work — oil changes/maintenance vs major repairs vs diagnostics?
- What is the effective labour rate and how does it compare to posted rates?

Why it matters: Bay utilization and average RO value are the key operating metrics in auto repair. A shop with 8 bays averaging 4 vehicles per bay per day at $250/RO is generating very different revenue than one with 8 bays at 2 vehicles per day at $150/RO. Buyers need to understand the real throughput and pricing.

**Equipment**
- What diagnostic equipment is owned (scan tools, alignment machines, lifts, tire equipment)?
- Age and condition of major equipment?
- Are there any equipment leases that transfer to the buyer?
- What is the replacement cost of the full equipment package?
- Is there EV-specific equipment (high-voltage safety tools, EV diagnostic platforms)?

**Customer base**
- Is the customer base primarily retail walk-in, fleet accounts, or insurance work?
- Are there any fleet contracts? What are the terms and renewal dates?
- What is the repeat customer rate?
- Is there a customer database or DMS (Dealer Management System) with customer history?
- What is the average customer lifetime value?

**Parts and inventory**
- What is the current parts inventory value?
- Is inventory purchased from a distributor (NAPA, UAP, Worldpac) or through a franchise arrangement?
- Are there any parts consignment or return arrangements?
- What is the parts markup policy and average margin?

**Environmental compliance**
- Are oil, coolant, and other fluids being disposed of properly with documented carriers?
- Is there an underground storage tank (UST) on the property? What is its status?
- Are there any environmental orders or spill history?
- Are refrigerant handling procedures compliant (Section 608 in US, ODS regulations in Canada)?

Why it matters: Environmental contamination from auto repair operations (oil, solvents, fuel) is one of the most common sources of hidden liability in automotive transactions. Buyers and their lenders will require an environmental assessment. An undisclosed UST can kill a deal or result in significant price reduction.

**EV readiness**
- Is the shop equipped to service hybrid and electric vehicles?
- Do technicians have EV/high-voltage training and certification?
- Is there EV charging infrastructure on-site?

Why it matters: The shift to electric vehicles is transforming the auto repair industry. A shop with EV capability is future-proofed. A shop without it faces declining relevance as the vehicle fleet transitions. Buyers will increasingly value EV readiness.

### Jurisdiction-specific [JURISDICTION]

**Ontario, Canada**
- OMVIC (Ontario Motor Vehicle Industry Council) registration required for all auto repair facilities.
- Motor Vehicle Repair Act governs written estimates, authorization, and customer communication requirements.
- Ontario Regulation 455/07 governs the disposal of used oil, filters, and antifreeze.
- TSSA governs compressed gas equipment and underground storage tanks.
- Drive Clean emissions testing program was discontinued in 2019 but historical compliance records may be relevant.

**British Columbia**
- Motor Dealer Act and Vehicle Sales Authority (VSA) governance.
- AirCare program (Metro Vancouver) — emissions testing requirements for certain vehicles (program under review).

**Alberta**
- AMVIC (Alberta Motor Vehicle Industry Council) governs.
- Out-of-province inspections — shops performing OOP inspections need specific certification.

**United States — General**
- EPA regulations govern disposal of used oil, antifreeze, and hazardous waste (RCRA compliance).
- Underground Storage Tanks regulated under EPA LUST program — significant liability if not properly decommissioned.
- OSHA safety requirements for lift operation, compressed air, and chemical handling.
- State-level auto repair licensing varies — some states require no license, others require detailed registration.
- Clean Air Act Section 608 — technician certification required for refrigerant handling.

**California**
- BAR (Bureau of Automotive Repair) registration required.
- CARB (California Air Resources Board) regulations affect some repair operations.
- Strict hazardous waste disposal requirements (CalEPA).
- Smog Check program — if the shop is a smog check station, that license is separate and valuable.

**Texas**
- TxDMV and DPS govern vehicle inspection stations — if the shop does state inspections, that license is separately required.

### Common seller blind spots
- Environmental liability from improper disposal or old USTs is almost never disclosed proactively
- OEM certifications are assumed to transfer but often require reapplication by the new owner
- Fleet accounts that are based on personal relationships with the owner may not renew post-sale
- Parts inventory is often overvalued — aged/obsolete parts may have little recoverable value
- Technician certifications are personal and leave with the technician if they exit
- EV transition risk not considered — diminishing relevance for shops that can't service EVs

---

## 6B. AUTO BODY AND COLLISION REPAIR

### Critical fields [CRITICAL] (in addition to 6A fields)

**Insurance relationships (DRP agreements)**
- Does the shop have DRP (Direct Repair Program) agreements with any insurance companies?
- Which insurers and what are the terms of those agreements?
- What percentage of revenue comes from DRP work vs retail (non-insurance) customers?
- Are DRP agreements in the company's name and transferable, or are they personal to the owner?

Why it matters: DRP agreements are the lifeblood of a collision shop. They guarantee a steady flow of insurance-referred work. If the agreements are personal to the owner or require reapplication, a buyer could lose the majority of their revenue pipeline immediately after closing.

**I-CAR and OEM certifications**
- Does the shop hold I-CAR Gold Class certification?
- Are there any OEM collision repair certifications (Tesla, Aluminum-intensive vehicles, specific brands)?
- Are certifications current and what is required to maintain them?
- How many staff are I-CAR certified individually?

**Equipment specific to collision**
- Frame straightening equipment (make, model, capacity)?
- Welding equipment (MIG, aluminum welding, squeeze-type resistance spot welder)?
- Paint booth — ownership, age, compliance with environmental permits?
- Measuring systems (Celette, Car-O-Liner, etc.)?
- ADAS calibration equipment — can the shop perform Advanced Driver Assistance System calibration?

**Paint booth environmental permits**
- Does the paint booth have the required air quality permit?
- Are VOC (Volatile Organic Compound) emissions within permitted limits?
- Are inspection records current?
- What paint system is used — waterborne or solvent-based?

Why it matters: Paint booths require environmental air quality permits in most jurisdictions. An unpermitted or non-compliant paint booth is an immediate regulatory issue that a buyer must remedy — often at significant cost. Waterborne paint systems are increasingly required by regulation.

**ADAS calibration capability**
- Can the shop perform ADAS calibration (cameras, radar, lidar sensors)?
- What equipment is used for calibration?
- Is calibration done in-house or subcontracted?

Why it matters: Modern vehicles require ADAS calibration after windshield replacement and many collision repairs. Shops without this capability must subcontract the work, reducing margin. ADAS capability is increasingly required for OEM certification.

---

## 6C. CAR WASHES

### Critical fields [CRITICAL]

**Wash type and throughput**
- What type of car wash is it — full-service, express exterior, self-serve, or combination?
- What is the average daily car count?
- What is the average revenue per car?
- What are peak and off-peak periods?

**Membership/subscription revenue**
- Does the wash offer unlimited wash memberships?
- How many active memberships are there?
- What is the monthly recurring membership revenue (MRR)?
- What is the monthly membership churn rate?

Why it matters: Car wash businesses have undergone a fundamental shift to subscription membership models. A wash with 2,000 active memberships at $30/month has $60,000/month in guaranteed recurring revenue before a single retail customer arrives. This transforms the valuation significantly compared to a pure retail model. Buyers will pay a large premium for high membership counts with low churn.

**Equipment**
- Make, model, and age of the wash tunnel equipment
- What is the maintenance history and current condition?
- Are there any outstanding repair needs?
- What is the estimated replacement cost?
- Water reclaim system — is one in place and is it functioning?
- Chemical dispensing system — what chemicals are used and what are the costs?

**Site and facility**
- Is the real estate owned or leased?
- What are the lease terms if leased?
- Is the site on municipal water and sewer or on well/septic?
- Are there any water usage restrictions or surcharges?
- What is the stacking capacity (how many cars can queue)?
- What is the lot size and is there room for expansion?

**Environmental**
- Are wastewater discharge permits in place and current?
- What is the water reclaim percentage?
- Are chemical storage and handling procedures compliant?

### Jurisdiction-specific [JURISDICTION]

**Ontario**
- Municipal water and sewer bylaws govern discharge — car washes typically need an Industrial Pretreatment Agreement with the municipality.
- TSSA governs pressure equipment used in car washes.
- MECP (Ministry of Environment, Conservation and Parks) — potential ECA requirements for water discharge.

**United States**
- EPA Clean Water Act Section 402 (NPDES) governs wastewater discharge — car washes in many states require a stormwater or industrial discharge permit.
- State-specific water reclaim requirements — California requires 100% water reclaim in some municipalities.

---

## 6D. USED CAR DEALERSHIPS

### Critical fields [CRITICAL]

**Dealer license and registration**
- Is the dealership registered with the provincial/state motor vehicle authority?
- In whose name is the dealer license held?
- Is the license transferable to a new owner or does the buyer need to apply fresh?
- Are there any disciplinary history or complaints against the dealership license?

**Inventory**
- What is the current vehicle inventory (number of units and total wholesale value)?
- How is inventory financed — floor plan financing with a lender?
- Who is the floor plan lender and what are the terms?
- What is the average days-to-turn (how long vehicles sit before being sold)?
- What is the average gross profit per vehicle?
- What is the sourcing strategy (auctions, trade-ins, private purchases, lease returns)?

Why it matters: Floor plan financing is a revolving credit facility secured against the vehicle inventory. It transfers to the new owner only if the lender approves. If the lender does not continue the floor plan, the buyer must either arrange new financing or purchase the inventory outright at closing — which can be a significant capital requirement.

**Revenue streams**
- What percentage of gross profit comes from vehicle sales (front-end gross) vs F&I (finance and insurance products)?
- What are the F&I products offered (extended warranties, GAP insurance, credit life)?
- Is there a service department? What percentage of total revenue does service represent?
- What is the average F&I income per vehicle retailed?

**Reconditioning**
- Is reconditioning done in-house or outsourced?
- What is the average reconditioning cost per vehicle?

**Online presence and digital retail**
- What percentage of leads come from online sources?
- Is the dealership listed on major platforms (AutoTrader, Kijiji Autos, Cars.com, CarGurus)?
- What is the digital marketing spend and ROI?

### Jurisdiction-specific [JURISDICTION]

**Ontario**
- OMVIC registration is mandatory. The OMVIC Dealer Standards Act governs all aspects of used car dealer operations.
- OMVIC requires a surety bond and specific trust account requirements for deposits.
- OMVIC registration is not automatically transferable — the new owner must apply and be approved.

**United States**
- Dealer license is state-issued and not transferable — new owner must apply in their own name.
- FTC (Federal Trade Commission) Used Car Rule requires Buyers Guides on all vehicles.
- Dealer must be enrolled with DMV for title transfers.
- F&I compliance with CFPB (Consumer Financial Protection Bureau) regulations on credit products.
- TILA (Truth in Lending Act) compliance for in-house financing.

---

## 6E. AUTO DETAILING

### Critical fields [CRITICAL]

**Service model**
- Is the business fixed-location, mobile, or both?
- What services are offered (exterior wash, interior detail, paint correction, ceramic coating, PPF)?
- What is the average ticket per service?
- What is the daily/weekly job capacity?

**Revenue and client base**
- What is the split between retail consumers, dealership accounts, and fleet accounts?
- Are there recurring contracts (dealership reconditioning, fleet maintenance)?
- What is the repeat customer rate?

**Staff and training**
- Are detailers employees or contractors?
- What certifications or training do detailers hold?
- Is there key person dependency on a lead detailer?

**Equipment and products**
- What equipment is owned (pressure washers, polishers, extractors, steamers)?
- If mobile: what vehicles are in the fleet?
- What product lines are used and are there any product supplier agreements?

### Common seller blind spots — Automotive
- Environmental issues (USTs, improper waste disposal) are the #1 hidden liability
- DRP agreements may not survive a change of ownership
- Floor plan financing not continuing for a new owner
- Technician departure risk — certifications leave with the person
- EV transition creating obsolescence risk for shops without EV capability
- ADAS calibration gap becoming a competitive disadvantage

---

---

# 7. RETAIL

## Sub-industries covered:
- Independent Retail (general)
- Specialty Retail (apparel, home goods, sporting goods, pet, hobby)
- Franchise Retail
- Grocery and Convenience Stores
- Liquor Stores
- Vape and Cannabis Retail
- E-commerce / Online Retail

---

## 7A. INDEPENDENT AND SPECIALTY RETAIL

### Critical fields [CRITICAL]

**Lease terms**
- What is the current lease — term, renewal options, monthly rent (base + TMI/CAM)?
- What is the rent-to-revenue ratio? (Healthy retail: under 8-10% of gross revenue)
- Does the lease require landlord consent for a change of ownership?
- Are there any co-tenancy clauses (rent reduction or termination rights if an anchor tenant leaves)?
- Are there any exclusivity clauses that prevent the landlord from leasing nearby space to a competitor?
- What are the personal guarantee terms?
- What are the demolition/redevelopment clauses?

Why it matters: Retail is a location-dependent business. A great retail business in the wrong lease situation is a bad deal. Co-tenancy clauses can create significant revenue risk if a mall or plaza loses an anchor tenant. Exclusivity clauses can be a hidden asset that buyers value highly.

How to retrieve: Pull the original lease plus all amendments, side letters, and any correspondence with the landlord. Co-tenancy and exclusivity clauses are often buried in the lease schedules.

**Revenue and traffic**
- What is annual gross revenue?
- What is the seasonal revenue pattern — what percentage of annual revenue comes in Q4/holiday season?
- What is the average transaction value?
- How many transactions per day/week?
- What percentage of sales is in-store vs online?
- What is the foot traffic trend — has it changed in the last 3 years?

**Inventory**
- What is the current retail inventory value at cost?
- What is the inventory turn rate (how many times per year inventory sells through)?
- What is the aged/slow-moving inventory as a percentage of total?
- Are there any consignment arrangements?
- Are there any purchase commitments or open orders that transfer to a buyer?

Why it matters: Inventory is often included in a retail purchase price. Buyers need to know the true market value — not the retail value, not the original cost, but what it's actually worth. Aged inventory that hasn't moved in 12+ months may be worth significantly less than cost.

**Supplier relationships**
- Who are the key suppliers?
- Are there any exclusive distribution agreements?
- Are there any minimum purchase requirements?
- What are the payment terms with suppliers?
- Are there any supplier rebate programs and how are they structured?

Why it matters: Exclusive distribution agreements can be a significant source of value — or a liability if they come with minimum purchase obligations the buyer may not be able to meet.

**Staff**
- How many full-time vs part-time staff?
- What is the labour cost as a percentage of revenue?
- Is the owner working in the store? How many hours per week?
- Are there any key employees who are critical to operations (buyers, managers, visual merchandisers)?

**Online presence**
- Does the business have an e-commerce channel?
- What platforms (Shopify, WooCommerce, Amazon, Etsy)?
- What is the online revenue as a percentage of total?
- What is the social media following and engagement?
- Is the POS system integrated with e-commerce?

**Brand and intellectual property**
- Is the business name/brand trademarked?
- Are there any proprietary products or private label lines?
- What is the brand recognition in the local market?

### Common seller blind spots
- Co-tenancy and exclusivity clauses in the lease are rarely top of mind for sellers
- Inventory is overstated — sellers include aged and damaged stock at original cost
- Supplier exclusivity agreements come with minimum purchase obligations that sellers forget to mention
- Seasonal revenue concentration is downplayed — sellers quote annual revenue without flagging that 40% comes in 8 weeks
- Personal customer relationships (regulars who come because they know the owner) are treated as transferable when they may not be

---

## 7B. GROCERY AND CONVENIENCE STORES

### Critical fields [CRITICAL] (in addition to 7A)

**Lottery and gaming terminals**
- Does the store operate lottery terminals (OLG in Ontario, similar in other provinces/states)?
- How many lottery terminals and what is the monthly commission revenue?
- Are lottery terminal agreements transferable to a new owner?

Why it matters: Lottery terminal commissions can be a meaningful revenue stream (2-5% of gross lottery sales). Agreements are with the provincial lottery corporation and require new owner approval — this is not automatic.

**ATM**
- Is there an ATM in the store? Is it owned or operated by a third party?
- What is the monthly ATM revenue (surcharge income or commission)?
- Are ATM agreements transferable?

**Tobacco and vape compliance**
- Is the store compliant with all tobacco and vape display and sales regulations?
- Are there any outstanding tobacco compliance violations?
- What percentage of revenue comes from tobacco products?

**Fuel (if applicable)**
- Does the store have fuel pumps?
- Who is the fuel supplier and what are the supply agreement terms?
- Is the fuel supply agreement transferable?
- What is the fuel margin per litre/gallon?
- Are there any underground storage tanks and what is their compliance status?

**Product mix and margin**
- What is the gross margin by product category?
- What percentage of revenue is high-margin (prepared food, beverages) vs low-margin (tobacco, lottery)?
- What prepared food program exists and what are its margins?

### Jurisdiction-specific [JURISDICTION]

**Ontario**
- OLG (Ontario Lottery and Gaming) governs lottery terminal agreements — new owner must apply to OLG.
- AGCO governs alcohol sales if the store sells beer/wine/spirits under expanded retail alcohol rules (effective 2024 in Ontario).
- Ontario expanded alcohol retail: Convenience stores and grocery stores received expanded alcohol sales rights in 2024 — confirm if the store is authorized to sell alcohol and what that authorization is worth.
- Tobacco compliance governed by Ministry of Health — maximum display restrictions and age verification requirements.

**United States**
- Lottery terminal agreements are state-specific — transferability varies significantly.
- Fuel storage tanks subject to EPA UST regulations — must be registered and inspected.
- EBT (Electronic Benefits Transfer / food stamps) merchant agreement — must be re-applied for by new owner.
- Tobacco sales age verification compliance under FDA regulations.
- Beer/wine licensing varies by state for convenience stores and grocery.

---

## 7C. LIQUOR STORES

### Critical fields [CRITICAL]

**License type and value**
- What type of liquor retail license does the store hold?
- In jurisdictions with quota/limited licenses — what is the market value of the license itself?
- Is the license attached to the location or to the owner?
- What is the license transfer process and timeline?

Why it matters: In many US states (Florida, New York, New Jersey) and some Canadian provinces, liquor retail licenses are quota-limited. The license itself can be worth hundreds of thousands to millions of dollars independent of the business. This is a critical component of the purchase price that must be valued separately.

**Revenue and margin**
- What is annual gross revenue?
- What is the gross margin percentage? (Typically 20-30% for spirits, 25-35% for wine, 20-25% for beer)
- What is the product mix — spirits vs wine vs beer vs cider/coolers?
- Is there a premium/craft selection that commands higher margins?

**License compliance history**
- Have there been any liquor board violations, warnings, or suspensions?
- Are staff trained and certified in responsible alcohol service (Smart Serve in Ontario, TIPS in US)?
- Are there any outstanding compliance issues?

**Inventory**
- What is the current inventory value at cost?
- What is the inventory turn rate?
- Are there any aged, rare, or collectible bottles that have special value?

### Jurisdiction-specific [JURISDICTION]

**Ontario**
- LCBO (Liquor Control Board of Ontario) governs liquor retail. Private liquor stores operate under an LCBO authorization.
- Expanded alcohol retail rules (2024): Beer, wine, and spirits can now be sold in more retail formats. Understand the specific authorization the store holds.
- Smart Serve certification required for all staff involved in alcohol sales.

**Alberta**
- Alberta has fully privatized liquor retail since 1993. AGLC issues retail liquor store licenses.
- Licenses are transferable with AGLC approval.
- Alberta has one of the most open liquor retail environments in Canada.

**British Columbia**
- LCRB governs private wine stores, liquor stores, and other retail formats.
- License types include LRS (Liquor Retail Store), Wine Store, Rural Agency Store.
- Licenses require LCRB approval to transfer.

**United States**
- Liquor retail licensing is state-controlled and varies dramatically.
- Control states (Pennsylvania, Utah, others) have government-operated retail — private stores are not available.
- License states vary from very restricted quota systems (Florida, New Jersey) to relatively open systems (Texas, Nevada).
- In quota states, the license can be the most valuable asset in the transaction.

---

## 7D. VAPE AND CANNABIS RETAIL

### Critical fields [CRITICAL]

**License type and status**
- What type of retail license does the store hold (cannabis retail license, vape-only, or both)?
- Is the license in good standing with no outstanding violations?
- Is the license transferable to a new owner or does the buyer need to apply for a new one?
- In cannabis: Is the license issued to the individual or to a corporation?

Why it matters: Cannabis retail licenses are tightly controlled in Canada and in legal US states. They are not automatically transferable. In Ontario, the OCS (Ontario Cannabis Store) is the sole wholesale supplier — the retailer's relationship is with the OCS, not individual producers. A change of ownership requires AGCO approval and can take significant time.

**Revenue and margin**
- Annual gross revenue and trend (growing, stable, declining)?
- Gross margin percentage (cannabis retail margins are typically 20-30%)?
- Average transaction value and daily customer count?
- Product mix — flower vs pre-rolls vs edibles vs vape vs accessories?

**Location and competition**
- How many competing cannabis retailers are within 1km? 5km?
- Is the location in a high-traffic area?
- What are the minimum distance requirements from schools and other cannabis stores (jurisdiction-specific)?
- Has market saturation affected revenue trends?

**Compliance history**
- Have there been any compliance violations with the cannabis regulatory authority?
- Are all staff trained and certified as required (CannSell in Ontario)?
- Are there any pending enforcement actions?
- Is seed-to-sale tracking system compliant?

### Jurisdiction-specific [JURISDICTION]

**Ontario, Canada**
- AGCO (Alcohol and Gaming Commission of Ontario) governs cannabis retail licensing.
- OCS (Ontario Cannabis Store) is the sole authorized wholesale supplier.
- Change of ownership requires AGCO approval — the new owner must meet all eligibility requirements including the 9.9% passive investment rule.
- CannSell certification required for all staff involved in cannabis sales.
- Minimum distance requirements: 150 metres from a school.

**British Columbia**
- LCRB governs cannabis retail.
- Both government-operated (BC Cannabis Stores) and private retailers exist.
- License transfers require LCRB approval.

**Alberta**
- AGLC governs cannabis retail licensing.
- Fully private retail model — AGLC issues licenses to private operators.
- License transfer requires AGLC approval and background checks on new owner.

**United States (Legal States)**
- Cannabis retail licensing varies dramatically by state — some states allow license transfers, others require new applications.
- Social equity licensing programs in some states (California, Illinois, New York) create restrictions on who can own licenses.
- Multi-state operators (MSOs) face complex multi-jurisdiction compliance requirements.
- Federal illegality means cannabis businesses cannot use standard banking in many states — understand banking arrangements.
- Federal tax implications: IRS Section 280E prohibits cannabis businesses from deducting most business expenses — this significantly affects true profitability vs reported profitability. Buyers must understand the 280E impact. Note: SECURE Banking Act status should be monitored for potential changes.
- California: Bureau of Cannabis Control governs retail. Local permits required in addition to state license.
- Colorado: MED (Marijuana Enforcement Division) governs retail. License ownership restrictions apply.
- Michigan, Illinois, New York: Each has specific ownership transfer rules.

### Common seller blind spots — Cannabis/Vape/Retail
- Sellers don't disclose that the license is not automatically transferable
- 280E tax impact (US) is not explained, making reported financials misleading
- Compliance violations that were resolved are treated as non-issues by sellers but buyers still care about the history
- Rapidly changing competitive landscape (new store openings) is not disclosed
- Banking arrangements and cash handling procedures are informal and not documented
- Market oversaturation in many Canadian markets depressing margins
- Inventory shrinkage/loss tracking inadequate

---

---

# 8. WHOLESALE AND DISTRIBUTION

## Sub-industries covered:
- General Wholesale/Distribution
- Food and Beverage Distribution
- Industrial/B2B Distribution
- Consumer Products Distribution
- Specialty Distribution (medical, pharmaceutical, controlled goods)

---

## 8A. GENERAL WHOLESALE AND DISTRIBUTION

### Critical fields [CRITICAL]

**Customer concentration**
- Who are the top 10 customers and what percentage of revenue does each represent?
- Are there any customers representing more than 15-20% of revenue?
- What is the nature of relationships — long-term supply agreements, annual contracts, or spot/PO-by-PO?
- When do key contracts expire?
- Have any customers recently reduced orders or signaled they may change suppliers?

Why it matters: Distribution businesses are particularly vulnerable to customer concentration risk. Unlike manufacturing where switching costs are high, a distribution customer can often find an alternative supplier relatively quickly. A single large customer defection can be devastating to revenue.

**Supplier relationships and exclusivity**
- Who are the key suppliers/brands distributed?
- Are there any exclusive distribution agreements? For what territories?
- What are the terms and renewal conditions of exclusive agreements?
- Are exclusive agreements held by the company or by the owner personally?
- What are the minimum purchase requirements under any supply agreements?
- Are there any right-of-first-refusal or change-of-ownership provisions in supplier agreements?

Why it matters: Exclusive distribution rights are often the primary source of value in a distribution business. If the exclusivity agreement can be terminated by the supplier on a change of ownership, the business may be worth far less than it appears. This is the single most important diligence item in distribution M&A.

How to retrieve: Pull all supplier agreements from your files. Look specifically for sections titled "Assignment," "Change of Control," or "Termination." If you don't have written agreements, this is a significant issue that needs to be resolved before going to market.

**Gross margin and pricing**
- What is the gross margin percentage by product category or supplier?
- Has gross margin been stable, growing, or declining over the last 3 years?
- Are there any pricing pressures from suppliers (cost increases not passed to customers)?
- Is pricing fixed by contract or negotiated on each order?
- Are there any volume rebate programs from suppliers and how are they structured?

**Inventory and warehouse**
- What is the current inventory value at cost?
- What is the inventory turn rate?
- What is the warehouse square footage — owned or leased?
- What are the lease terms if leased?
- Is the warehouse temperature-controlled (required for food, pharmaceuticals, certain chemicals)?
- What WMS (Warehouse Management System) is used?
- Are there any slow-moving or obsolete inventory issues?

**Logistics and fleet**
- Does the business own or lease delivery vehicles?
- What is the fleet size, age, and condition?
- Is delivery done in-house or outsourced to third-party carriers?
- What are the fuel and logistics costs as a percentage of revenue?
- What is the geographic delivery area?

**Key personnel**
- Are there key salespeople who have personal relationships with major customers?
- If a salesperson left, would their customers likely follow?
- Are there written non-compete and non-solicit agreements with sales staff?

### Common seller blind spots
- Exclusivity agreements with change-of-ownership clauses are rarely disclosed upfront
- Supplier relationships that appear solid may be subject to renegotiation post-sale
- Key salespeople without non-competes represent significant customer retention risk
- Inventory is often overstated — slow-moving and damaged stock included at full cost
- Minimum purchase requirements under supply agreements are not flagged as potential obligations
- Volume rebate income may be at risk if post-sale volumes decline

---

## 8B. FOOD AND BEVERAGE DISTRIBUTION

### Critical fields [CRITICAL] (in addition to 8A)

**Temperature control and food safety**
- Is the warehouse and fleet equipped for required temperature zones (ambient, refrigerated, frozen)?
- What food safety certifications are held (HACCP, SQF, BRC, GFSI)?
- Are certifications current and what was the result of the last audit?
- Is the facility registered with CFIA (Canada) or FDA (US) as a food facility?
- What is the cold chain monitoring system?

Why it matters: Food safety certifications are required to service many retail and foodservice customers. Losing a certification post-sale can result in losing the customers that require it.

**Product liability and insurance**
- Does the business carry product liability insurance?
- Have there been any product recalls or food safety incidents in the last 5 years?
- What is the product recall process and has it ever been activated?

**Regulatory compliance**
- Canada: Is the facility SFCR (Safe Food for Canadians Regulations) compliant?
- US: Is the facility registered under FDA Food Safety Modernization Act (FSMA)?
- Are there any outstanding FDA/CFIA inspection findings?

---

## 8C. SPECIALTY DISTRIBUTION — MEDICAL AND PHARMACEUTICAL

### Critical fields [CRITICAL] (in addition to 8A)

**Licenses and permits**
- Does the business hold a drug establishment license (Health Canada) or drug distributor license (state pharmacy board in US)?
- Are licenses held by the company or by a key individual?
- What class of pharmaceutical products is the business authorized to distribute?
- Are there any controlled substance distribution authorizations (DEA in US, Health Canada in Canada)?

Why it matters: Pharmaceutical distribution licenses are issued to specific entities with specific compliance requirements. A change of ownership typically requires license reapplication — this takes time and requires significant compliance infrastructure. Controlled substance authorizations are even more strictly regulated.

**Cold chain integrity**
- Is there a documented cold chain management program?
- What is the temperature monitoring and logging system?
- Has the cold chain ever been compromised? What was the outcome?
- Are temperature excursion protocols documented?

**Traceability**
- Is there a full lot traceability system in place?
- Can the business trace any product from receipt to delivery?
- DSCSA (Drug Supply Chain Security Act) compliance in the US — is the business compliant with serialization requirements?

---

---

# 9. TRANSPORTATION AND LOGISTICS

## Sub-industries covered:
- Trucking (long-haul, regional, local)
- Courier and Last-Mile Delivery
- Freight Brokerage
- Moving Companies
- Charter Bus and Passenger Transportation
- Specialized Transport (hazmat, oversized, refrigerated, medical)
- Warehousing and 3PL (Third-Party Logistics)

---

## 9A. TRUCKING (Long-Haul, Regional, Local)

### Critical fields [CRITICAL]

**Operating authority and licenses**
- Does the company hold its own operating authority (US: MC number from FMCSA; Canada: CVOR from MTO in Ontario)?
- Is the operating authority in the company's name (transferable) or the owner's name?
- What is the current safety rating (US: FMCSA SafeStat/SMS; Canada: CVOR abstract)?
- Are there any out-of-service orders or safety violations on record?
- Does the company operate cross-border (Canada-US)? If so, what are the cross-border operating authorizations?

Why it matters: Operating authority and safety ratings are critical assets in trucking. A poor CVOR or FMCSA safety rating can result in increased insurance costs, roadside inspection frequency, and even suspension of operating authority. A company with a clean record is worth significantly more than one under safety scrutiny. Cross-border operating authority is a separate asset that requires additional compliance.

How to retrieve: The CVOR abstract is available from MTO (Ontario Ministry of Transportation). The FMCSA safety rating and SMS (Safety Measurement System) score are publicly available at safer.fmcsa.dot.gov.

**Fleet — owned, financed, leased**
- How many power units (tractors) and trailers in the fleet?
- What is the average age of the fleet?
- What is owned outright vs financed vs operating lease?
- What is the current market value of owned equipment?
- What is the maintenance history and condition of each unit?
- Are there any equipment leases that require lender/lessor consent to transfer?
- Are there any units approaching regulatory retirement age (emissions standards, safety requirements)?
- What is the annual fleet replacement capital requirement?

Why it matters: The fleet is often the primary asset in a trucking company. Buyers need to understand not just the current value but the upcoming capital requirements — older trucks need replacement. Operating lease obligations transfer to the buyer and represent a fixed future cash commitment.

**Revenue by customer and contract**
- Who are the top customers and what percentage of revenue does each represent?
- Are customers on long-term contracts or spot rate relationships?
- What is the rate per mile/kilometer by lane?
- Are rates indexed to fuel costs (fuel surcharge structure)?
- What are the load counts and revenue per truck per week?

**Driver situation**
- How many drivers are employed vs owner-operators (independent contractors)?
- What is the driver turnover rate? (Industry average is high — 90%+ annually for large carriers)
- Are owner-operator agreements written and compliant with employment classification rules?
- Are drivers properly licensed (AZ/DZ in Ontario, CDL in US)?
- Are there any driver shortage issues?
- What is the average driver tenure?

Why it matters: Driver shortage is one of the most significant operational challenges in trucking. A company with high turnover or an aging driver pool faces ongoing recruitment costs and potential revenue disruption. Owner-operator misclassification (treating employees as contractors) is also a significant legal risk.

**Fuel**
- What is the average fuel cost per mile/km?
- Does the company have fuel contracts or use spot pricing?
- Is there a fuel surcharge mechanism to pass fuel cost increases to customers?
- Does the company own fuel storage on-site?
- What fuel cards or fleet fueling programs are used?

**Insurance**
- What is the current commercial auto and cargo insurance coverage?
- What is the loss ratio history (claims vs premiums)?
- Are there any outstanding claims?
- What is the current insurance cost per unit?
- Has the company ever been non-renewed by an insurer?

Why it matters: Insurance is one of the largest expenses in trucking and directly tied to the safety record. A company with a poor claims history faces dramatically higher insurance costs, which can make the business financially unviable. Some carriers are "non-renewed" by insurers — meaning no one will insure them.

**Cross-border and regulatory compliance (US-Canada)**
- CTPAT (Customs-Trade Partnership Against Terrorism) certification?
- CSA (Customs Self Assessment) authorization (Canada)?
- ELD (Electronic Logging Device) compliance — are all trucks equipped with compliant ELDs?
- IFTA (International Fuel Tax Agreement) compliance?
- Are there any CBP or CBSA violations or holds?
- FAST (Free and Secure Trade) card enrollment for drivers?

### Jurisdiction-specific [JURISDICTION]

**Ontario, Canada**
- CVOR (Commercial Vehicle Operator's Registration) is mandatory for all commercial carriers. CVOR abstract is the key compliance document.
- MTO (Ministry of Transportation Ontario) governs commercial vehicle safety.
- HST/GST compliance for freight services.
- Employment Standards Act governs driver employment relationships — owner-operator classification scrutiny has increased.
- WSIB for employed drivers.

**Canada — Federal**
- Transport Canada governs cross-border and interprovincial transport.
- Federal regulations apply for carriers operating across provincial boundaries.
- Hours of Service (HOS) regulations under the National Safety Code.

**United States — Federal**
- FMCSA (Federal Motor Carrier Safety Administration) governs all commercial trucking.
- MC number (Motor Carrier operating authority) required for for-hire carriers.
- DOT number required for all commercial vehicles over 10,000 lbs GVWR.
- ELD mandate in effect — all carriers must use electronic logging devices.
- CSA (Compliance, Safety, Accountability) scores publicly available and scrutinized by shippers and insurers.
- IFTA (International Fuel Tax Agreement) required for carriers operating in multiple states.
- Hours of Service (HOS) regulations strictly enforced.

**California**
- CARB (California Air Resources Board) emissions standards are stricter than federal — older trucks may not be compliant and cannot operate in California.
- AB5 independent contractor classification law — significantly affects owner-operator arrangements.
- Advanced Clean Fleets regulation — zero-emission vehicle purchase requirements beginning 2024.

### Common seller blind spots
- CVOR/safety record issues are minimized or not disclosed
- Fleet age and upcoming replacement costs are not factored into asking price
- Owner-operator arrangements that may not survive regulatory scrutiny
- Customer relationships tied to the owner personally
- Insurance loss history that will affect buyer's insurance costs
- Cross-border authorization complexities and ongoing compliance costs
- California emissions compliance costs for out-of-state carriers

---

## 9B. COURIER AND LAST-MILE DELIVERY

### Critical fields [CRITICAL]

**Operating model**
- What is the delivery model — own fleet, contractor drivers, hybrid?
- What geographic area is served?
- What types of deliveries (parcels, documents, medical, same-day, scheduled routes)?

**Revenue and contracts**
- Are there contractual accounts (regular scheduled routes) or is it primarily on-demand?
- What are the terms of major customer contracts?
- What percentage of revenue is recurring vs spot?

**Driver/contractor classification**
- How are drivers classified — employees or independent contractors?
- Are contractor agreements written and compliant with jurisdiction-specific employment classification rules?
- What is the exposure if drivers are reclassified as employees (back-pay, benefits, source deductions)?

Why it matters: The gig economy delivery model is under significant legal scrutiny in both Canada and the US. Several court decisions have reclassified courier drivers as employees, resulting in massive back-pay and benefit obligations for operators. This is one of the most significant hidden liabilities in courier businesses.

**Technology**
- What dispatch, routing, and tracking software is used?
- Are there any proprietary technology assets?
- What is the customer portal and integration capability with major shippers?
- Is there real-time proof-of-delivery capability?

---

## 9C. FREIGHT BROKERAGE

### Critical fields [CRITICAL]

**Broker authority and bonding**
- Does the company hold an active freight broker authority (FMCSA Form OP-1 in US)?
- Is the required broker bond in place (currently $75,000 in the US)?
- Are there any revocations or suspensions in the authority history?

**Revenue and margin**
- What is the gross revenue (total freight charges)?
- What is the net revenue / gross margin (broker fee as a percentage of gross revenue)?
- What is the average margin per load?
- What is the load count per month and revenue per load?
- What TMS (Transportation Management System) is used?

**Customer concentration**
- Same as 8A — customer concentration is the primary risk in freight brokerage
- Are customer relationships with the company or with individual brokers/agents?

**Agent vs employee model**
- Are brokers employees or independent agents?
- Do agent agreements include non-competes and non-solicits?
- What happens to agent relationships and their books of customers in a sale?

Why it matters: In agent-based freight brokerages, each agent effectively runs their own mini-business within the brokerage. If agents leave post-sale, their customers leave with them. Non-compete enforcement is difficult and varies by jurisdiction.

---

## 9D. MOVING COMPANIES

### Critical fields [CRITICAL]

**Licensing**
- Is the company licensed for local, long-distance, and/or cross-border moves?
- US: FMCSA household goods carrier authority (IM or HHG designation)?
- Canada: Provincial transport authority license?
- Are there any complaints or enforcement actions from consumer protection authorities?

Why it matters: Moving companies generate a disproportionate number of consumer complaints. Regulatory authorities (BBB, consumer protection ministries/AGs) maintain records of complaints that buyers will find. A history of complaints affects reputation, insurance, and license renewability.

**Seasonal revenue and capacity**
- What is the revenue split by season? (Moving is highly seasonal — peak in summer)
- What is the revenue in the weakest quarter vs the peak quarter?
- Are there enough trucks and staff to handle peak season without subcontracting?

**Claims history**
- What is the claims history for damaged or lost goods?
- What cargo insurance is carried and what is the claims payout history?
- Are there any outstanding customer disputes or litigation?
- What is the declared value protection policy offered to customers?

**Equipment**
- Truck fleet inventory, age, and condition
- Are trucks owned, financed, or leased?
- Are trucks properly equipped (pads, dollies, straps, lifts)?
- What is the storage/warehouse capacity for moves requiring temporary storage?

---

## 9E. WAREHOUSING AND 3PL (Third-Party Logistics)

### Critical fields [CRITICAL]

**Customer contracts**
- Who are the major customers and what is each as a percentage of revenue?
- Are customers on long-term warehouse agreements or month-to-month?
- What are the termination provisions?
- Do any contracts have change-of-ownership provisions?

**Revenue model**
- What is the fee structure — per pallet, per square foot, per pick, per order, or flat monthly fee?
- What is the revenue per square foot of warehouse space?
- Is there a fulfillment/pick-and-pack component and what are its margins?
- Are there any value-added services (kitting, assembly, returns processing)?

**Facility**
- Is the warehouse owned or leased?
- What is the lease term and renewal options?
- What is the total square footage and what percentage is currently occupied?
- What is the clear height (relevant for racking and operations)?
- What is the dock door count and yard capacity?
- Is there temperature-controlled storage?
- What WMS (Warehouse Management System) is used?
- What automation/material handling equipment is in place?

**Labor model**
- Are warehouse workers employees or temp agency staff?
- What is the labour cost as a percentage of revenue?
- Are workers unionized?
- What is the turnover rate?

### Jurisdiction-specific [JURISDICTION]

**Ontario**
- WSIB compliance for all warehouse workers
- Ministry of Labour Orders for health and safety in warehouse environments
- ESA compliance for shift workers and overtime rules
- Fire Code compliance for warehouse storage (particularly flammable or hazardous materials)

**United States**
- OSHA compliance for warehouse safety (forklift operation, racking standards, fall protection)
- NLRA compliance if workforce is unionized or organizing
- Multi-state sales tax nexus implications if the warehouse stores goods for e-commerce sellers
- Customs bonded warehouse status (if applicable for international goods)

### Common seller blind spots — Transportation/Logistics
- Safety record issues that will spike the buyer's insurance costs
- Fleet capital requirements (upcoming replacements) not factored into asking price
- Driver/contractor classification risk not disclosed
- Customer concentration — one or two large accounts representing the majority of revenue
- Owner-dependent customer relationships without non-solicits on key sales staff
- Lease obligations on trailers and other equipment that must be assigned
- California emissions compliance requirements for national carriers

---

---

# 10. WELLNESS, FITNESS, AND LIFESTYLE

## Sub-industries covered:
- Gyms and Fitness Centres
- Yoga and Pilates Studios
- Personal Training Studios
- Spas and Day Spas
- Hair Salons and Barbershops
- Nail Salons
- Tattoo and Body Art Studios
- Tanning Salons
- Weight Loss and Nutrition Clinics
- Holistic Health and Alternative Medicine (naturopathy, acupuncture, TCM)

---

## 10A. GYMS AND FITNESS CENTRES

### Critical fields [CRITICAL]

**Membership base and recurring revenue**
- How many active members are there?
- What is the Monthly Recurring Revenue (MRR) from memberships?
- What is the membership breakdown by tier (monthly, annual prepaid, pay-as-you-go)?
- What is the monthly churn rate (members cancelling per month)?
- What is the average revenue per member per month?
- What is the member acquisition cost and primary acquisition channel?
- What is the net member growth trend over the last 12 months?

Why it matters: Gym businesses are valued almost entirely on the quality and stickiness of their membership base. High MRR with low churn is the key value driver. A gym with 800 members at $60/month = $48,000 MRR is a fundamentally different business than one with 800 members at 50% annual prepaid — the latter has revenue risk concentrated at renewal time.

How to retrieve: Your gym management software (Mindbody, Club Automation, ABC Fitness, Zen Planner, PushPress) will have member count, MRR, and churn reports. Ask your software provider if you don't know how to pull these.

**Member contracts and cancellation terms**
- Are members on month-to-month or fixed-term contracts?
- What are the cancellation terms?
- Are there any contracts that include change-of-ownership cancellation rights?
- What percentage of members are on annual prepaid contracts (revenue already collected)?
- What is the total deferred revenue liability from prepaid memberships?

Why it matters: Annual prepaid contracts represent deferred revenue — the gym has collected cash for future services. A buyer inherits the obligation to deliver those services without receiving the cash. This must be disclosed and typically requires a price adjustment.

**Lease**
- Lease term, renewal options, monthly rent?
- Rent as a percentage of revenue? (Healthy for gyms: 8-12%)
- Personal guarantee and assignment requirements?
- Are there any exclusive use clauses (preventing landlord from leasing to another gym)?

**Equipment**
- Full list of cardio and strength equipment with age and condition
- What is owned outright vs financed vs leased?
- Is any equipment approaching end-of-life?
- What is the replacement cost of the full equipment package?
- What is the annual equipment refresh budget?

**Staff and instructors**
- How many staff are employed vs independent contractors?
- Are personal trainers employees or independent contractors?
- Do instructors have client relationships that could follow them if they leave?
- Are there written agreements with key instructors?
- What is the personal training revenue and how is it structured?

**Classes and programming**
- What group fitness classes are offered?
- Are any classes or programs proprietary or licensed (franchise)?
- Are instructors certified through recognized bodies (CanFitPro, ACE, NASM)?
- What is the class utilization rate (attendance vs capacity)?

**Ancillary revenue**
- What other revenue streams exist (personal training, retail, supplements, tanning, juice bar)?
- What is the revenue and margin from each ancillary stream?
- Are there any subleased spaces within the gym (smoothie bar, physiotherapy clinic)?

### Jurisdiction-specific [JURISDICTION]

**Ontario, Canada**
- Consumer Protection Act governs gym membership agreements — specific rules on contract length (max 1 year), cancellation rights, and cooling-off periods (10 days).
- Gym memberships over a certain value require specific contract disclosures.
- Prepaid contracts subject to trust/escrow requirements in some cases.
- WSIB for all employed staff.

**United States**
- Many states have specific Health Club Services Acts governing membership contracts (California, New York, Florida, Texas all have specific rules).
- California: Health Studio Services Act limits prepaid contract terms and requires cancellation rights.
- New York: Health Club Law requires specific disclosures and cancellation terms.
- Some states require gym operators to post a bond to protect prepaid memberships.
- ADA (Americans with Disabilities Act) accessibility requirements for the facility.

### Common seller blind spots
- Deferred revenue from annual prepaid memberships is not disclosed as a liability
- Churn rate is understated or not tracked — sellers quote gross sign-ups not net member count
- Equipment financing obligations not included in seller's disclosure
- Instructor non-competes are absent or unenforceable
- Change-of-ownership cancellation rights in member contracts not disclosed
- Personal training revenue leaves with the trainer if they depart

---

## 10B. YOGA AND PILATES STUDIOS

### Critical fields [CRITICAL] (in addition to 10A)

**Instructor dependency**
- Is the studio's identity tied to one or two key instructors?
- Do clients follow specific instructors rather than the studio brand?
- If a key instructor left, what percentage of revenue would be at risk?
- Do lead instructors have ownership stakes or profit-sharing arrangements?

Why it matters: Yoga and pilates studios are among the most instructor-dependent businesses. In many small studios, the owner IS the brand. If the selling owner is the primary instructor and plans to leave, significant revenue may follow them. This is the single most important risk to assess.

**Class packages and credits**
- What is the outstanding balance of unused class packages and credits held by members?
- What is the total liability represented by pre-sold classes not yet delivered?
- What is the expiry policy on unused credits?

Why it matters: Pre-sold class packages represent a liability the buyer inherits — they must deliver those classes without receiving additional payment. This can be tens of thousands of dollars of obligation.

**Teacher training programs**
- Does the studio offer yoga/pilates teacher training programs?
- What is the revenue from teacher training?
- Are training programs accredited (Yoga Alliance, NCPT)?
- What is the schedule and enrollment for upcoming training cohorts?

Why it matters: Teacher training can be a significant and high-margin revenue stream for yoga and pilates studios. If it depends on the selling owner's reputation and teaching credentials, it may not transfer.

---

## 10C. SPAS AND DAY SPAS

### Critical fields [CRITICAL]

**Services and licensing**
- What services are offered (massage, facials, body treatments, waxing, lash, brow, etc.)?
- Are any services regulated (massage therapy is regulated in Ontario and many US states)?
- Are registered massage therapists (RMTs) employed or contracted?
- Do service providers hold the required licenses and are they current?

**Revenue by service and therapist**
- What is revenue by service type?
- Are any individual therapists responsible for a disproportionate share of revenue?
- What is the client retention rate per therapist?
- What happens to therapist client books if they leave?

**Retail products**
- What retail products are sold and what is the retail revenue?
- Are there any exclusive product distribution agreements?
- What is the current retail inventory value?

**Gift cards and prepaid packages**
- What is the total outstanding gift card liability?
- What is the outstanding prepaid package liability?
- What is the gift card redemption rate and breakage rate?

Why it matters: Gift cards and prepaid packages are often significant liabilities in spa businesses. The cash has been received but the services have not been delivered. This liability transfers to the buyer and must be quantified.

**RMT billing (Ontario)**
- Do clients use extended health benefits (Blue Cross, Manulife, Sun Life) for massage services?
- Is the business set up for direct billing to insurance?
- What percentage of massage revenue is insurance-funded vs self-pay?

Why it matters: RMT services in Ontario are covered under most extended health benefit plans. Direct billing capability is a significant competitive advantage. If the current RMTs leave post-sale, new RMTs must be enrolled with insurance providers — which takes time.

### Jurisdiction-specific [JURISDICTION]

**Ontario**
- RMTs (Registered Massage Therapists) regulated by CMTO (College of Massage Therapists of Ontario).
- Estheticians are not regulated in Ontario but may require municipal business licensing.
- Some municipalities require health inspections for personal care services.
- Personal service setting standards under Ontario Regulation 136/18 (Health Protection and Promotion Act).

**United States**
- Massage therapy licensing is state-specific — most states require licensure through a state massage therapy board.
- Estheticians are licensed by state cosmetology/esthetics boards.
- Nail technicians are licensed by state boards.
- OSHA requirements for chemical handling (waxing supplies, nail products, etc.).

---

## 10D. HAIR SALONS AND BARBERSHOPS

### Critical fields [CRITICAL]

**Chair rental vs employee model**
- Are stylists/barbers employees or chair renters (independent contractors)?
- If chair rental: what is the weekly chair rental income?
- If employees: what is the commission structure?
- Do stylists have their own client books that they own personally?

Why it matters: In a chair rental model, the buyer is essentially acquiring a real estate/facility business — the stylists own their client relationships and can leave any time. In an employee model, the client relationships belong more to the salon brand. These are fundamentally different businesses with different risk profiles.

**Client concentration per stylist**
- If a top stylist left, what percentage of revenue would be at risk?
- Are there any stylists with non-compete agreements?
- What is the stylist turnover history?
- How are walk-in clients distributed vs requested appointments?

**Lease and location**
- Lease terms, renewal options, monthly rent?
- Is the location in a high-traffic area that drives walk-in business?
- Is walk-in traffic significant or is the business primarily appointment-based?

**Licensing**
- Jurisdiction-specific cosmetology/barbering licenses for staff?
- Municipal business license for the salon?
- Health inspection compliance?

### Jurisdiction-specific [JURISDICTION]

**Ontario**
- No provincial license required for hairstylists in Ontario (deregulated in 2009).
- Municipal business license typically required.
- Public health inspections for personal service settings under local health unit authority.
- Personal service setting standards — infection prevention and control requirements.

**United States**
- Cosmetology and barbering are licensed at the state level through state boards.
- Licenses are personal to the individual — the salon license is separate from stylist licenses.
- Some states require the salon owner to hold a cosmetology license even if they don't practice.
- Booth rental vs employee classification — IRS and state labor boards scrutinize this.

---

## 10E. NAIL SALONS

### Critical fields [CRITICAL]

**Service model and revenue**
- What services are offered (manicure, pedicure, gel, acrylic, dip powder, nail art)?
- What is the average ticket per service?
- What is the daily/weekly client volume?
- Is there a retail product component?

**Licensing and health compliance**
- Are all nail technicians properly licensed (state board in US, municipal in Ontario)?
- Are health and safety protocols compliant (sanitation, chemical handling, ventilation)?
- What ventilation system is in place for chemical fumes (acrylic, gel)?
- When was the last health inspection and what was the outcome?

Why it matters: Nail salons have been subject to increased regulatory scrutiny in many jurisdictions due to health concerns (chemical exposure, infection control). A history of violations or inadequate ventilation can create significant compliance costs for a buyer.

**Staff model**
- Are technicians employees or booth renters?
- What is the compensation structure?
- Are there language/communication considerations for staff management?

**Competitive landscape**
- How many competing nail salons are within a 2km radius?
- What differentiates this salon (quality, specialty services, pricing, location)?

---

## 10F. TATTOO AND BODY ART STUDIOS

### Critical fields [CRITICAL]

**Artist model and client relationships**
- Are artists employees, booth renters, or independent contractors?
- Do artists own their client books?
- What is the revenue split between the studio and artists?
- If the lead artist left, what percentage of revenue would follow them?

Why it matters: Tattoo studios are among the most artist-dependent businesses. Clients book specific artists, not studios. If the lead artist(s) leave, the revenue follows them. A studio with a strong brand that attracts walk-ins and a reputation beyond any single artist is far more transferable.

**Licensing and health compliance**
- Is the studio licensed/registered with the local health authority?
- Are all artists compliant with bloodborne pathogen training?
- Is the studio compliant with infection control and sterilization requirements (autoclave testing records)?
- Are there any outstanding health inspection violations?

**Revenue mix**
- What is the split between custom tattoo work, flash/walk-in, piercings, and retail (aftercare products)?
- What is the average revenue per tattoo appointment?
- What is the booking lead time for custom work?

**Portfolio and reputation**
- What is the studio's online presence (Instagram followers, Google reviews)?
- Are there any artists with significant social media followings that drive clients?

### Jurisdiction-specific [JURISDICTION]

**Ontario**
- Regulated under the Health Protection and Promotion Act and local public health unit bylaws.
- Personal service setting standards apply — autoclave testing, sharps disposal, infection control.
- No provincial license for tattoo artists specifically — regulated at the municipal/public health level.

**United States**
- State and local regulations vary — some states require tattoo artist licensing, others regulate at the county/city level.
- Bloodborne pathogen training (OSHA) required for all artists.
- Age restrictions for clients (18+ in most states, parental consent requirements vary).

---

## 10G. TANNING SALONS

### Critical fields [CRITICAL]

**Equipment and compliance**
- How many tanning beds/booths and what types (UV, spray tan)?
- Age and condition of equipment — UV bulbs/lamps replacement schedule?
- Is equipment compliant with current health regulations (FDA in US, Health Canada)?
- Are there any outstanding compliance orders?

**Revenue model**
- What is the split between UV tanning, spray tan, and retail products?
- Is there a membership/subscription model? How many active members?
- What is the MRR from memberships?

**Regulatory landscape**
- Are there age restrictions on UV tanning in the jurisdiction?
- What consent and disclosure requirements apply?

Why it matters: Tanning salons face increasing regulatory restrictions in many jurisdictions. Some provinces and states have banned UV tanning for minors. Understanding the regulatory trajectory is important — additional restrictions could affect revenue.

### Jurisdiction-specific [JURISDICTION]

**Ontario**
- Skin Cancer Prevention Act (Tanning Beds) 2013 — prohibits UV tanning for anyone under 18.
- Compliance with O. Reg. 99/14 for tanning bed operation.

**United States**
- FDA regulates UV tanning devices. Warning labels and eye protection required.
- Many states prohibit minors from using UV tanning beds (California, Vermont, Oregon, and others have outright bans for minors).
- FTC enforcement of advertising claims about tanning safety.

---

## 10H. HOLISTIC HEALTH AND ALTERNATIVE MEDICINE

### Critical fields [CRITICAL]

**Practitioner type and regulation**
- What modalities are practiced (naturopathy, acupuncture, Traditional Chinese Medicine, homeopathy, osteopathy)?
- Are practitioners regulated in the jurisdiction? Which professional college governs them?
- Are all practitioners in good standing with their regulatory body?
- Is the business structure compliant with any ownership restrictions?

**Revenue and payer mix**
- What is the revenue by modality?
- What percentage of revenue is covered by extended health insurance?
- Is the clinic set up for direct insurance billing?
- What is the self-pay vs insurance split?

**Product sales**
- Does the clinic sell supplements, herbal products, or other health products?
- What is the retail revenue and margin?
- Are there any Health Canada or FDA compliance requirements for products sold?

Why it matters: Regulatory status of alternative health practitioners varies widely by jurisdiction. In Ontario, naturopaths (RNDP), acupuncturists, and Traditional Chinese Medicine practitioners are regulated health professionals. In other jurisdictions, they may be unregulated. Regulated status enables insurance billing, which significantly affects revenue.

### Jurisdiction-specific [JURISDICTION]

**Ontario**
- Naturopaths regulated by CNDO (College of Naturopaths of Ontario) — title protection and controlled acts.
- Traditional Chinese Medicine practitioners regulated by CTCMPAO.
- Acupuncturists regulated under the same college.
- Homeopaths — regulated as of 2015 under the College of Homeopaths of Ontario.
- Extended health plans (Green Shield, Manulife, Sun Life) cover many regulated alternative health services.

**United States**
- Naturopathic licensing varies dramatically — some states license NDs (naturopathic doctors) with prescribing authority, others have no regulation at all.
- Acupuncture is licensed in most states through state acupuncture licensing boards.
- Scope of practice varies significantly by state — check what services practitioners can legally perform.
- Insurance coverage for alternative medicine is limited but growing.

### Common seller blind spots — Wellness/Lifestyle
- Prepaid packages and gift card liabilities are not quantified
- Instructor/therapist/artist dependency — the "business" walks out when they do
- Contractor vs employee classification risk for booth renters and chair renters
- Health inspection compliance history not disclosed
- Equipment at end-of-life requiring significant capital refresh
- Change-of-ownership cancellation rights in membership contracts
- Insurance billing enrollment that must be re-established by new practitioners

---

---

# 11. EDUCATION

## Sub-industries covered:
- Private Schools (K-12)
- Tutoring and Learning Centres
- Language Schools and ESL
- Vocational/Trade Schools
- Test Preparation and Exam Centres
- Music, Art, and Performing Arts Schools
- Driving Schools
- Online/E-learning Businesses
- Corporate Training

---

## 11A. PRIVATE SCHOOLS (K-12)

### Critical fields [CRITICAL]

**Accreditation and licensing**
- Is the school accredited? By which body (provincially inspected in Canada; NAIS, state accreditation in US)?
- Is accreditation in good standing with no conditions or probationary status?
- What government oversight applies and what are the inspection/reporting requirements?
- Does the school have charitable status (registered charity in Canada, 501c3 in US)?

Why it matters: Private school accreditation and government inspection status is critical to enrollment — parents choose accredited schools. Loss of accreditation would be catastrophic to the business. Charitable status (if held) provides significant tax advantages and donor eligibility that a for-profit buyer may not retain.

**Enrollment and tuition**
- Current enrollment by grade level?
- What is the annual tuition per student?
- What is the enrollment trend over the last 3-5 years (growing, stable, declining)?
- What is the student retention rate year-over-year?
- What is the waitlist situation?
- What is the application-to-acceptance ratio?
- What is the geographic catchment area for students?

**Financial aid and bursaries**
- What percentage of students receive financial aid or bursaries?
- What is the total financial aid commitment outstanding?
- Are there any endowment funds and what are the restrictions on their use?
- What is the discount rate (financial aid as a percentage of gross tuition)?

**Staff**
- How many teachers are employed and what are their qualifications?
- Are teachers unionized?
- What is the teacher-to-student ratio?
- Are there any key staff whose departure would significantly affect enrollment?
- What is the teacher retention rate and average tenure?

**Facility**
- Is the building owned or leased?
- What are the lease/mortgage terms?
- What is the condition of the facility and are there any outstanding capital requirements?
- Is the facility zoned for educational use?
- Are there any planned expansion or renovation needs?

**Government funding (Canada)**
- Does the school receive any government grants or per-student funding?
- What conditions are attached to government funding?
- Would a change of ownership affect funding eligibility?

### Jurisdiction-specific [JURISDICTION]

**Ontario, Canada**
- Private schools must be registered with the Ministry of Education (Ontario).
- Inspected private schools that offer the Ontario Secondary School Diploma (OSSD) must be inspected by the Ministry.
- Non-inspected private schools have fewer restrictions but cannot grant OSSD credits.
- Teachers at inspected private schools must hold OCT (Ontario College of Teachers) certification.
- Charitable status (if held) is governed by CRA — a sale may trigger a review of charitable status.

**British Columbia**
- Independent schools classified under the Independent School Act (Group 1-4).
- Group 1 and 2 schools receive provincial funding — change of ownership affects funding eligibility.
- BC Ministry of Education oversight required.

**United States**
- Private school regulation is primarily at the state level.
- Accreditation bodies include regional accreditors (NEASC, AdvancED, Cognia, etc.) and religious accreditors.
- Title IV federal student financial aid (Pell Grants, student loans) — if the school participates, significant federal oversight applies.
- 501(c)(3) charitable status: a sale to a for-profit entity typically requires IRS approval and may involve cy-pres proceedings for restricted funds.

### Common seller blind spots
- Charitable status implications of a sale are not understood
- Enrollment decline trends are minimized or attributed to external factors
- Financial aid commitments outstanding are not disclosed as liabilities
- Teacher union agreements and upcoming negotiations are not mentioned
- Facility capital requirements (deferred maintenance on old buildings) are underestimated

---

## 11B. TUTORING AND LEARNING CENTRES

### Critical fields [CRITICAL]

**Revenue model**
- Is revenue primarily from individual session fees, packages, or monthly memberships?
- What is the average revenue per student per month?
- What is the student retention rate (how many re-enroll each session/semester)?
- What is the seasonality of revenue (academic year vs summer)?

**Franchise vs independent**
- Is this a franchise (Kumon, Sylvan, Oxford Learning, Mathnasium)?
- If franchise: remaining term, renewal terms, transfer fee, franchisor approval required?
- If independent: is the curriculum proprietary or using licensed materials?

**Instructor model**
- Are tutors employees or contractors?
- What qualifications are required for tutors?
- Are there any key tutors who have strong student relationships?

**Regulatory (tutoring)**
- Do tutors working with minors require police background checks (Vulnerable Sector Checks in Canada)?
- Are current background checks on file for all staff?

Why it matters: Tutoring businesses work exclusively with minors. Parents will ask about background check policies. A new owner who cannot demonstrate current background checks for all staff will face enrollment issues immediately.

---

## 11C. LANGUAGE SCHOOLS AND ESL

### Critical fields [CRITICAL]

**Designation and government approval**
- Is the school designated for international students (DLI — Designated Learning Institution in Canada)?
- What visa categories are students enrolled under?
- Are there any conditions on the DLI designation?

Why it matters: In Canada, a Designated Learning Institution (DLI) designation from IRCC (Immigration, Refugees and Citizenship Canada) is required to enroll international students on study permits. This designation is issued to the institution — not automatically transferable to a new owner. Loss of DLI status means the school cannot enroll new international students.

**Student mix and revenue**
- What is the breakdown of domestic vs international students?
- What countries do international students come from?
- What is the average course length and revenue per student?
- Is there significant revenue from government-funded programs (settlement services, LINC in Ontario)?

**LINC (Language Instruction for Newcomers to Canada)**
- Does the school deliver LINC (federally funded ESL for permanent residents)?
- What is the LINC funding amount per year?
- Is LINC funding subject to contract renewal? When does the current contract expire?
- Would a change of ownership require re-application for LINC funding?

Why it matters: LINC contracts with IRCC are significant revenue streams for many ESL schools. They are not guaranteed to transfer and require re-application by a new operator.

**Recruitment and agent relationships**
- How are international students recruited — direct marketing, education agents, or institutional partnerships?
- Are there agent agreements in place? What commission rates are paid?
- Are recruitment relationships with the school or with the owner personally?

### Jurisdiction-specific [JURISDICTION]

**Canada**
- IRCC governs DLI designation. New owners must apply to maintain DLI status.
- LINC programs funded through IRCC — contract continuity is not guaranteed post-sale.
- Provincial private career college acts may govern some language schools (PCCA in Ontario).
- Languages Canada accreditation (voluntary but widely recognized).

**United States**
- SEVIS (Student and Exchange Visitor Information System) — schools enrolling F-1 visa students must be SEVP (Student and Exchange Visitor Program) certified.
- SEVP certification must be maintained under new ownership — requires application and review.
- ACCET, CEA, or other ESL-specific accreditation bodies.
- I-20 issuance authority — critical for enrolling international students.

---

## 11D. VOCATIONAL AND TRADE SCHOOLS

### Critical fields [CRITICAL]

**Regulatory approval**
- Is the school registered under the provincial/state private career college or vocational school act?
- What programs are approved and by which authority?
- Is approval tied to specific programs, instructors, or facilities?

**Ontario: PCCA compliance**
- Is the school registered under the Private Career Colleges Act (PCCA) with MLTSD (Ministry of Labour, Training and Skills Development)?
- Are all offered programs approved under the PCCA?
- Is the school compliant with student protection fund requirements?

**Student funding**
- Do students access government grants or loans (OSAP in Ontario, federal/state student aid in US)?
- What percentage of students use government-funded loans/grants?
- Does the school's approval status affect student eligibility for funding?

Why it matters: If students lose access to government loans/grants because a new owner's approval status lapses, enrollment will collapse. This is a critical continuity issue in vocational school transactions.

**Job placement rates**
- What is the program completion rate?
- What is the job placement rate post-graduation?
- Are placement rates audited or self-reported?
- Are there any industry partnerships or employer relationships supporting placements?

**Regulatory risk**
- Has the school ever been subject to regulatory action, probation, or suspension?
- Are there any outstanding student complaints or regulatory reviews?
- What is the regulatory compliance history?

Why it matters: Vocational schools are subject to significant regulatory scrutiny. A history of compliance issues, even if resolved, affects the school's reputation and the new owner's ability to maintain approvals.

---

## 11E. DRIVING SCHOOLS

### Critical fields [CRITICAL]

**Licensing**
- Is the school registered with the provincial/state driver training authority?
- Are all instructors certified and licensed as driving instructors?
- Are vehicle certifications current (in-car dual controls, insurance)?

**Ontario: MTO approval**
- Is the school approved by the Ministry of Transportation Ontario (MTO)?
- Are all instructors MTO-certified?
- BDE (Beginner Driver Education) approval — does the school offer the MTO-approved BDE course that qualifies students for reduced insurance rates and faster licensing?

Why it matters: BDE approval from MTO is a significant competitive advantage — it allows students to qualify for insurance discounts and the graduated licensing fast track. Schools without BDE approval are at a competitive disadvantage. BDE approval is institution-specific and requires MTO application to transfer.

**Fleet**
- How many training vehicles in the fleet?
- Are they owned or financed?
- Age and condition?
- Are in-car safety controls (dual brakes) installed and certified?
- What is the insurance cost per vehicle?

---

## 11F. MUSIC, ART, AND PERFORMING ARTS SCHOOLS

### Critical fields [CRITICAL]

**Student enrollment and retention**
- How many active students?
- What is the monthly/term revenue per student?
- What is the student retention rate term-over-term?
- What is the age breakdown of students (children, teens, adults)?

**Instructor model**
- Are instructors employees or independent contractors?
- Do instructors have their own student relationships that could follow them?
- Are there non-compete or non-solicit agreements?
- What is the instructor turnover rate?

Why it matters: Music and arts schools are highly instructor-dependent. Students (and their parents) often choose a specific teacher rather than a school. If the popular piano teacher leaves, their students leave too.

**Revenue streams**
- What is the split between private lessons, group classes, performance programs, and retail (instruments, supplies)?
- Are there any recital or performance revenue streams?
- Are there summer camp or intensive programs?
- Is there rental income from studio space?

**Equipment and instruments**
- What instruments and equipment are owned by the school?
- What is the condition and value?
- Are there any instrument rental programs?

**Facility**
- Is the space acoustically treated?
- Are there any noise restrictions from neighbours or the lease?
- How many teaching studios/rooms are available?

---

## 11G. ONLINE/E-LEARNING BUSINESSES

### Critical fields [CRITICAL]

**Platform and content**
- What platform hosts the courses (Teachable, Thinkific, Kajabi, custom-built)?
- How many courses/programs are offered?
- Who created the content — the owner, employees, or contractors?
- Are there IP assignment agreements for content created by contractors?
- How often is content updated? Is any content becoming outdated?

**Revenue model**
- Is revenue from one-time course purchases, subscriptions, cohort-based programs, or a combination?
- What is the MRR/ARR if subscription-based?
- What is the average course price and completion rate?
- What is the refund rate?

**Student metrics**
- How many active students/subscribers?
- What is the student completion rate?
- What is the Net Promoter Score or student satisfaction metric?
- What is the repeat purchase rate (students buying multiple courses)?

**Marketing and acquisition**
- What is the primary student acquisition channel (SEO, paid ads, email, social, affiliates)?
- What is the customer acquisition cost (CAC)?
- What is the email list size and engagement?
- Are there any affiliate or partnership relationships driving enrollments?

**Key person dependency**
- Is the course creator/instructor the brand? Would students continue if the instructor changed?
- Are there video courses featuring the owner's face/voice that cannot easily be replaced?

Why it matters: Many e-learning businesses are built around a personal brand. If the owner IS the course content (their face, voice, expertise), the business may not survive a change of ownership without significant content recreation.

---

## 11H. CORPORATE TRAINING

### Critical fields [CRITICAL]

**Revenue model and clients**
- What is the split between in-person training, virtual training, and self-paced online?
- What are the top corporate clients by revenue?
- Are clients on annual training contracts or booking on a course-by-course basis?
- What is the average contract value and client retention rate?

**Curriculum and IP**
- Is the training content proprietary or licensed?
- Who owns the curriculum — the company or the trainers?
- Are there any accredited certifications or designations offered (HR certification prep, safety training, etc.)?

**Trainer model**
- Are trainers employees or contractors?
- Are key trainers associated with specific client relationships?
- Do trainers have non-compete agreements?

**Scalability**
- Can the training be delivered without the owner/founder?
- Is there a Train-the-Trainer model that allows scaling?
- What is the geographic reach — local, national, international?

---

## 11I. TEST PREPARATION AND EXAM CENTRES

### Critical fields [CRITICAL]

**Exam types and accreditation**
- What exams does the centre prepare for or administer (SAT, GMAT, LSAT, MCAT, professional certifications)?
- Is the centre an authorized testing site for any exam body (Pearson VUE, Prometric, ETS)?
- Are testing centre agreements transferable to a new owner?

**Revenue model**
- What is the split between test preparation courses and exam proctoring fees?
- What is the average revenue per student/exam?
- Is there a seasonal pattern aligned with exam schedules?

**Authorized testing site (if applicable)**
- What testing station agreements are in place?
- How many testing stations/seats are available?
- What are the technology and security requirements for maintaining authorization?

Why it matters: Authorized testing site agreements (Pearson VUE, Prometric) provide steady exam proctoring revenue. These agreements have specific facility, technology, and security requirements. Losing authorization means losing a guaranteed revenue stream.

---

---

# 12. CHILDCARE AND ENTERTAINMENT

## Sub-industries covered:
- Licensed Childcare Centres / Daycares
- Home Daycares (licensed)
- After-School and Camp Programs
- Children's Entertainment (party venues, play centres, activity centres)
- Family Entertainment Centres (FECs)
- Trampoline Parks
- Escape Rooms
- Bowling Alleys, Arcades, and Amusement Venues

---

## 12A. LICENSED CHILDCARE CENTRES / DAYCARES

### Critical fields [CRITICAL]

**License and capacity**
- Is the centre licensed? By which authority?
- What is the licensed capacity by age group (infant, toddler, preschool, school-age)?
- Is the centre currently operating at capacity?
- Is the license issued to the operator, the facility, or both?
- Does the license transfer to a new owner or require reapplication?

Why it matters: Licensed childcare is among the most heavily regulated businesses a broker will encounter. The license is the business — without it, the centre cannot operate. In most jurisdictions, a change of operator triggers a new license application process, not an automatic transfer. This can take months and requires inspections, background checks, and policy reviews.

**Subsidy and government funding**
- Does the centre participate in government subsidy programs?
- What percentage of enrolled children receive subsidized care?
- What is the subsidy revenue as a percentage of total revenue?
- In Ontario: Is the centre participating in the $10/day Canada-Wide Early Learning and Child Care (CWELCC) program?
- Would a change of ownership affect subsidy program participation?

Why it matters: In Ontario and across Canada, the federal CWELCC program ($10/day childcare) has transformed childcare economics. Centres enrolled in CWELCC receive significant government funding but agree to fee caps and staffing requirements. If a sale disrupts CWELCC participation, the centre loses funding AND may not be able to charge market rates — this can make the business temporarily unviable.

**Staffing and ratios**
- What is the current staff count by role (Early Childhood Educators, assistants, supervisors)?
- What are the staff-to-child ratios being maintained (by age group)?
- Are staffing levels compliant with regulated minimums?
- What ECE qualifications do staff hold (RECE in Ontario, equivalents elsewhere)?
- What is the staff turnover rate?
- Are wages competitive with the current market (particularly post-CWELCC wage enhancements)?

Why it matters: Licensed childcare has regulated minimum staff-to-child ratios. If staff leave post-sale and ratios cannot be maintained, the centre must reduce enrollment — directly reducing revenue. RECE (Registered Early Childhood Educator) shortages are a significant industry-wide issue.

**Waitlist and enrollment stability**
- Is there a waitlist? How long?
- What is the current enrollment by age group?
- What is the enrollment trend?
- What is the annual family retention rate?
- What is the infant space availability (infant spaces are the most scarce and valuable)?

**Parent communication and reputation**
- What is the centre's online reputation (Google, local parent groups)?
- Have there been any reportable incidents, licensing violations, or inspections with non-compliance?
- Are there any outstanding complaints with the licensing authority?
- What communication platform is used with parents (HiMama, Brightwheel, etc.)?

**Facility and playground**
- Is the facility owned or leased?
- Is the facility purpose-built for childcare or converted from another use?
- What is the condition of the playground and outdoor space?
- Are playground equipment inspections current?
- What capital improvements are needed in the near term?

### Jurisdiction-specific [JURISDICTION]

**Ontario, Canada**
- Licensed under the Child Care and Early Years Act (CCEYA), regulated by the Ministry of Education.
- A change of operator requires Ministry approval — the new operator must apply for a new license.
- RECE (Registered Early Childhood Educator) designation required for certain staff ratios (governed by the College of Early Childhood Educators).
- CWELCC ($10/day program): Centres enrolled receive substantial government funding but are subject to fee caps, wage requirements, and annual agreements with the municipality/Consolidated Municipal Service Manager.
- CWELCC participation is not automatically transferable — new operators must sign new agreements.
- Background check (Vulnerable Sector Check) required for all staff and volunteers.
- Ontario Regulation 137/15 sets specific ratios: infant (3:1), toddler (5:1), preschool (8:1), school-age (15:1).

**British Columbia**
- Licensed under the Child Care Licensing Regulation (CCLR), overseen by MCFD (Ministry of Children and Family Development).
- ChildCareBC subsidy program — participation requires separate application by operator.
- ECE certification required for staff.
- $10/day ChildCareBC program — similar dynamics to Ontario CWELCC.

**Alberta**
- Licensed under the Child Care Licensing Act, administered by CYFS (Children and Youth Family Services).
- Alberta Child Care Subsidy program.
- Federal CWELCC agreements administered through provincial government.

**United States**
- Licensed at the state level — each state has its own licensing authority (typically Dept. of Health and Human Services or equivalent).
- Child Care and Development Fund (CCDF) federal subsidy program — administered by states. Participation requires provider enrollment.
- Head Start programs (federally funded) have separate grant requirements and are not transferable.
- Background checks required for all staff — FBI, state criminal, and sex offender registry checks.
- ADA accessibility requirements for the facility.
- QRIS (Quality Rating and Improvement System) — participation may affect subsidy rates and enrollment.

### Common seller blind spots
- CWELCC participation not being transferable is not understood by sellers
- Licensing non-compliance history is minimized or not disclosed
- Staff ECE qualification levels are overstated — some staff may be in the process of obtaining qualifications
- Subsidy revenue that is tied to the current operator's participation agreements
- Deferred maintenance on childproofing, playground equipment, or facility safety features
- Staff wage obligations under CWELCC are not disclosed as ongoing commitments

---

## 12B. CHILDREN'S ENTERTAINMENT — PARTY VENUES, PLAY CENTRES, TRAMPOLINE PARKS

### Critical fields [CRITICAL]

**Safety certifications and inspections**
- What safety certifications or inspections apply to the equipment and facility?
- For trampoline parks: ASTM International standards compliance? Regular third-party safety inspections?
- For play structures: what is the age and condition of equipment? When was the last inspection?
- Are there any outstanding safety orders from the fire marshal or municipal inspectors?
- What is the incident/injury history?

Why it matters: Children's entertainment facilities carry significant liability. An injury history or outstanding safety orders is both a legal liability and an insurance issue. Buyers must understand the incident history and current insurance costs — premiums for trampoline parks in particular have increased dramatically.

**Insurance**
- What is the current general liability coverage amount and carrier?
- What is the premium history and current annual premium?
- Has coverage ever been non-renewed or restricted due to claims?
- Are there any outstanding liability claims?
- What is the umbrella/excess liability coverage?

Why it matters: Trampoline parks and similar high-activity venues are considered high-risk by insurers. Some carriers have exited this market entirely. A business with a poor claims history may be uninsurable or insurable only at prohibitive cost.

**Revenue model**
- What is the breakdown of revenue by source — open play, party bookings, memberships, food/beverage, retail?
- What is the average revenue per party and number of parties per week/month?
- Is there a membership component and what is the MRR?
- What is the seasonal revenue pattern?
- What is the corporate/group event revenue?

**Waiver and liability management**
- Is a liability waiver required for all participants?
- Is the waiver enforceable in the jurisdiction?
- How are waivers collected and stored?
- Has the waiver been reviewed by legal counsel in the last 2 years?

### Jurisdiction-specific [JURISDICTION]

**Ontario**
- Occupiers' Liability Act governs duty of care to visitors.
- Amusement devices (including some play equipment) may be regulated by TSSA.
- Fire code compliance and regular municipal inspections.
- Municipal business licensing requirements.

**United States**
- No federal standard for trampoline parks specifically, but ASTM International standards (F2970) are the industry benchmark.
- State-specific amusement ride regulations in many states (California, Florida, Texas, New Jersey).
- ADA accessibility requirements.
- State-specific waiver enforceability varies significantly.

---

## 12C. ESCAPE ROOMS

### Critical fields [CRITICAL]

**Revenue and capacity**
- How many rooms and what is the capacity per room?
- What is the average booking rate (percentage of available slots booked)?
- Average revenue per booking and per person?
- What is the split between individual bookings vs corporate/group bookings?
- Are corporate bookings growing as a percentage of revenue?

**IP and room design**
- Are room concepts original or licensed from a franchisor/IP holder?
- Are there any licensing fees payable?
- How old are the current room designs and when will they need refresh/replacement?
- What is the cost to design and build a new room?

Why it matters: Escape room content has a shelf life — regulars want new experiences and online reviews become stale. A business with rooms that haven't been refreshed in 3+ years may be facing declining bookings from repeat customers.

**Online reputation and reviews**
- What are the Google, TripAdvisor, and Yelp ratings and review counts?
- What is the online booking conversion rate?
- What is the marketing strategy for driving bookings?

**Franchise considerations (if applicable)**
- If franchised: remaining term, transfer fee, franchisor approval?

---

## 12D. BOWLING ALLEYS, ARCADES, AND AMUSEMENT VENUES

### Critical fields [CRITICAL]

**Revenue streams**
- What is the breakdown by revenue source (bowling, arcade, food/beverage, events/parties, leagues, pro shop)?
- What is the league revenue and how many active leagues?
- What is the arcade revenue and what is the game split (owned games vs revenue-share with operator)?
- What is the food and beverage revenue and margin?

**Equipment**
- What is the lane equipment (pinsetters, scoring systems, lane conditioning) — make, model, age, condition?
- What is the arcade game inventory and ownership (owned vs placed by an operator)?
- What is the replacement cost of lane equipment?
- What is the annual maintenance cost?

Why it matters: Bowling lane equipment (particularly pinsetters) is expensive and has long replacement cycles. Brunswick and AMF are the major manufacturers. A facility with aging pinsetters facing imminent replacement could require $500K+ in capital. Buyers need to understand this.

**Facility**
- Is the building owned or leased?
- What is the lease term and renewal options?
- How many lanes? What is the theoretical and actual lane utilization?
- Is the facility compliant with fire code, ADA, and health department requirements?
- What is the parking capacity?

**Liquor license**
- Does the venue hold a liquor license?
- What type and what are the terms?
- Is there a bar/lounge area that generates significant alcohol revenue?

**League and event programming**
- What leagues are active and what is the revenue from leagues?
- What percentage of revenue comes from corporate events and birthday parties?
- Is there a cosmic/glow bowling program?

### Common seller blind spots — Childcare/Entertainment
- Insurance premium increases (especially trampoline parks) not disclosed
- Safety inspection history and incident reports minimized
- Equipment replacement costs for aging infrastructure
- Seasonal revenue swings creating cash flow challenges
- License/permit transferability issues in childcare
- CWELCC/subsidy program participation transferability
- Waiver enforceability assumptions not verified by legal counsel

---

---

# 13. ADVERTISING, MEDIA, AND EVENTS

## Sub-industries covered:
- Advertising Agencies (see also Professional Services 5F)
- Print and Digital Media Companies
- Photography and Videography Studios
- Event Planning and Management Companies
- Event Venues
- Public Relations Firms
- Out-of-Home Advertising (billboards, signage)

---

## 13A. EVENT PLANNING AND MANAGEMENT COMPANIES

### Critical fields [CRITICAL]

**Revenue type and forward bookings**
- What is the split between recurring clients (annual events, corporate retainers) vs one-time event clients?
- What is the current forward booking pipeline (signed contracts for future events)?
- What is the dollar value of deposits held for future events?
- Are there any large events booked that could be cancelled if the business changes hands?

Why it matters: Event planning businesses live and die on their forward pipeline. Deposits held represent liabilities (services not yet delivered) as well as assets (cash received). A buyer needs to understand both the pipeline value and the liability. Client relationships in event planning are highly personal — corporate clients often book with the planner they know.

**Client relationships and retention**
- Are corporate clients under multi-year retainer agreements or booked event-by-event?
- Are major client relationships personal to the owner or to the company brand?
- What is the client retention rate year-over-year for corporate clients?
- Are there any exclusivity or preferred supplier agreements with corporate clients?

**Vendor and supplier relationships**
- What are the key vendor relationships (venues, caterers, AV companies, florists)?
- Are there any preferred supplier agreements that provide pricing advantages?
- Could these vendor relationships be maintained by a new owner?

**Staff**
- Are event coordinators employees or contractors?
- Are key staff capable of managing client relationships independently?
- Do any staff have relationships with major clients that could follow them if they leave?

**IP and proprietary assets**
- Are there any proprietary event concepts, formats, or branded events?
- Are there any annual events the company owns and produces?

---

## 13B. EVENT VENUES

### Critical fields [CRITICAL]

**Real estate — owned or leased**
- Is the venue property owned or leased?
- If leased: what are the terms, renewal options, and rent?
- Is the property zoned for event use (assembly occupancy)?
- Are there any noise restrictions, hours of operation limits, or neighbour disputes?

Why it matters: Event venue value is heavily tied to real estate. An owned venue with a strong location is a very different asset than a leased venue with a short lease. Zoning and noise restrictions can significantly limit the types of events that can be held and the hours of operation.

**Capacity and liquor license**
- What is the licensed occupancy capacity?
- Does the venue hold a liquor license? Type and transferability?
- Has the venue ever had conditions placed on the liquor license?

**Revenue breakdown**
- Revenue by event type — weddings, corporate, social, public events?
- Average revenue per event and number of events per year?
- Seasonal revenue distribution?
- Food and beverage revenue vs venue rental revenue?
- Are food and beverage services provided in-house or by third-party caterers?

**Bookings pipeline**
- What is the forward booking pipeline (signed contracts)?
- What is the total deposit liability held?
- Are any major bookings at risk if ownership changes?

**Exclusive vendor arrangements**
- Are there any exclusive caterer, bar service, or vendor arrangements?
- Do exclusive vendor arrangements generate referral fees or commissions?

---

## 13C. PHOTOGRAPHY AND VIDEOGRAPHY STUDIOS

### Critical fields [CRITICAL]

**Revenue model**
- What is the breakdown between commercial/corporate work vs consumer (weddings, portraits, events)?
- What percentage of revenue is recurring (retainer clients, ongoing commercial contracts) vs project-based?
- What is the forward booking pipeline?

**IP ownership**
- Who owns the copyright to work produced — the studio or the clients?
- Are there any ongoing licensing arrangements for images or video content?
- What is the archive of past work and does it generate any ongoing revenue?

**Equipment**
- Camera bodies, lenses, lighting, studio equipment — owned vs financed/leased?
- What is the replacement cost of the full equipment package?
- Is equipment current or approaching obsolescence?

**Key person dependency**
- Is the studio's reputation tied to the owner/lead photographer/videographer personally?
- Are clients booking the individual or the studio brand?
- What is the studio's Instagram/portfolio following and is it tied to the owner's personal brand?

Why it matters: Photography and videography studios are among the most owner-dependent businesses. If clients are booking the individual (and following them on Instagram), the "business" may not survive a change of ownership. A studio with multiple photographers, a strong brand, and commercial/corporate clients is far more transferable than a solo operator with a personal following.

---

## 13D. PRINT AND DIGITAL MEDIA COMPANIES

### Critical fields [CRITICAL]

**Revenue model and trends**
- What is the revenue breakdown between print advertising, digital advertising, subscriptions, events, sponsored content?
- What is the revenue trend over the last 3-5 years? (Many print media businesses are in structural decline)
- What is the digital revenue percentage and growth rate?
- What is the paid vs unpaid subscription model?

Why it matters: Print media businesses require honest analysis of the trajectory. A declining print advertising base with a growing digital offering may be a turnaround opportunity or a value trap. Buyers need a clear-eyed view of where revenue will be in 3-5 years, not just where it is today.

**Audience and reach**
- What is the readership/viewership/listenership?
- What are the digital metrics (unique monthly visitors, email subscribers, social following)?
- Are audience metrics verified by a third party (BPA, AAM)?

**Advertiser concentration**
- How many active advertisers?
- What is the largest advertiser as a percentage of revenue?
- Are advertisers on contracts or booking on a campaign-by-campaign basis?

**Content and IP**
- What content archives exist and do they have value?
- Are there any trademarks, mastheads, or branded properties?
- What content management system is used?

---

## 13E. PUBLIC RELATIONS FIRMS

### Critical fields [CRITICAL]

**Client base and retainers**
- How many active clients?
- What percentage of revenue is retainer-based vs project-based?
- What is the average retainer value and duration?
- What is the client retention rate?
- What are the top clients by revenue and their concentration?

**Services and capabilities**
- What services are offered (media relations, crisis communications, digital PR, event PR, government relations)?
- Is there a specialty (healthcare PR, tech PR, financial PR, government relations)?
- What is the in-house capability vs subcontracted?

**Media relationships**
- Are key media relationships held by the owner/principals or by staff?
- Is the firm's media contact database a transferable asset?

**Key person dependency**
- Are major client relationships personal to the owner?
- Could the firm retain clients if the owner departed?

Why it matters: PR firms are relationship-intensive businesses. The owner's personal Rolodex — their relationships with journalists, editors, producers, and influencers — is often the firm's primary asset. If that walks out the door, so does much of the firm's value.

---

## 13F. OUT-OF-HOME ADVERTISING (Billboards, Signage, Transit)

### Critical fields [CRITICAL]

**Inventory and locations**
- How many advertising structures/faces are in the inventory?
- What are the types (static billboards, digital billboards, transit shelters, mall displays, wallscapes)?
- Where are they located and what are the traffic/exposure counts?
- Are locations owned or leased? What are the lease terms for each location?

**Permits and zoning**
- Are all structures properly permitted with municipal authorities?
- Are there any non-conforming structures (grandfathered in under old zoning that current zoning would not allow)?
- Are there any outstanding municipal orders or violations?

Why it matters: Non-conforming billboard locations are often the most valuable asset in an OOH advertising business. If a billboard is grandfathered under old zoning and could not be rebuilt if removed, it has significant scarcity value. But it also carries risk — the municipality may eventually require removal.

**Advertiser base and contracts**
- Who are the major advertisers and what are the contract terms?
- What is the occupancy rate across the inventory?
- What is the average rate per face per month?
- What is the contract renewal rate?

**Digital vs static**
- What percentage of inventory is digital vs static?
- What is the revenue premium for digital vs static?
- What is the capital cost and age of digital displays?
- What is the content management system?

### Common seller blind spots — Advertising/Media/Events
- Key person dependency is the #1 risk across all these businesses — relationships leave with people
- Forward booking deposits are liabilities, not just assets
- Print media decline trajectory is understated
- Permit/zoning status of OOH structures not verified
- Exclusive vendor/venue arrangements at risk in a change of ownership
- Creative IP ownership unclear in client contracts

---

---

# 14. TECHNOLOGY AND ONLINE BUSINESS

## Sub-industries covered:
- SaaS (Software as a Service)
- E-commerce (see also Retail 7A for physical inventory context)
- Mobile Apps
- Digital Agencies and Dev Shops
- Marketplace Businesses
- Content and Media Websites
- Domain and Hosting Businesses
- Technology Products and Hardware

---

## 14A. SAAS (SOFTWARE AS A SERVICE)

### Critical fields [CRITICAL]

**Core SaaS metrics**
- What is the Monthly Recurring Revenue (MRR)?
- What is the Annual Recurring Revenue (ARR)?
- What is the monthly churn rate (percentage of MRR lost each month)?
- What is the Net Revenue Retention (NRR) — does revenue from existing customers grow or shrink over time?
- What is the Customer Acquisition Cost (CAC)?
- What is the Customer Lifetime Value (LTV)?
- What is the LTV:CAC ratio?
- What is the gross margin (revenue minus hosting and direct costs)?

Why it matters: SaaS businesses are valued almost entirely on these metrics. A business with $1M ARR and 2% monthly churn is worth dramatically less than one with $1M ARR and 0.5% monthly churn. Net Revenue Retention above 100% (customers expanding their usage) is the hallmark of a high-quality SaaS business. Buyers will model these metrics deeply.

How to retrieve: Your CRM or billing system (Stripe, Chargebee, Recurly, Baremetrics, ChartMogul) should have MRR, churn, and expansion revenue dashboards. If you don't have these dashboards set up, ask your developer to pull the data from your database.

**Customer contracts and concentration**
- Are customers on monthly or annual contracts?
- What is the breakdown of MRR by contract length?
- Are there any customers representing more than 10% of MRR?
- Are there any enterprise contracts with custom terms?
- Do contracts have change-of-ownership notification or approval requirements?
- What is the logo churn rate (number of customers lost) vs revenue churn?

**Product and technology**
- What technology stack is the product built on?
- What is the current state of the codebase — documented, clean, or technical debt-heavy?
- Are there any third-party API dependencies that are critical to product functionality?
- Are there any pending platform migrations or infrastructure changes?
- What is the current hosting infrastructure (AWS, GCP, Azure) and monthly cost?
- What is the deployment frequency and CI/CD process?
- Is there a staging/QA environment?

Why it matters: Technical debt and infrastructure costs are hidden liabilities in SaaS acquisitions. A product built on outdated technology may require a full rewrite. High AWS/cloud costs may compress margins. Buyers will conduct technical due diligence and will price these issues into their offer.

**Team and key person risk**
- How many engineering staff are employed?
- Is there a CTO or lead developer whose departure would be catastrophic?
- Is the codebase documented well enough that a new developer could maintain it?
- Are there written employment agreements with key technical staff?
- What is the bus factor (how many people could leave before the product can't be maintained)?

**IP ownership**
- Does the company own all the IP in the product?
- Were any contractors used in development? Are there signed IP assignment agreements from all contractors?
- Are there any open-source components with restrictive licenses (GPL, AGPL)?
- Are there any patent filings?

Why it matters: IP assignment is critical. If contractors built parts of the product without signed IP assignment agreements, ownership of that code may be disputed. GPL/AGPL open-source components can create "copyleft" obligations that affect the ability to sell the product commercially.

**Security and compliance**
- Has the product undergone security audits or penetration testing?
- What customer data is stored and how is it protected?
- What compliance certifications are held (SOC 2, ISO 27001, HIPAA, GDPR, PIPEDA)?
- Have there been any data breaches or security incidents?

Why it matters: Data breaches and non-compliance with privacy regulations (GDPR in Europe, PIPEDA in Canada, various US state laws) expose the buyer to significant liability. Enterprise buyers increasingly require SOC 2 certification. A breach history can affect both valuation and insurability.

### Jurisdiction-specific [JURISDICTION]

**Canada**
- PIPEDA (Personal Information Protection and Electronic Documents Act) governs collection and use of personal data by private-sector companies in most provinces.
- Quebec Law 25 (effective September 2023) has stricter requirements similar to GDPR including privacy impact assessments and mandatory breach reporting.
- If the business has any customers in Quebec, Law 25 compliance is mandatory.
- CASL (Canadian Anti-Spam Legislation) compliance for email communications.

**United States**
- No federal omnibus privacy law — state laws govern.
- CCPA/CPRA (California Consumer Privacy Act) — applies to any business with California customers meeting certain thresholds.
- State privacy laws in Virginia (CDPA), Colorado, Connecticut, Utah, Texas also in effect. More states adding laws annually.
- HIPAA applies if the software handles Protected Health Information (PHI).
- SOC 2 Type II certification is increasingly required by enterprise customers and should be in progress or completed.

**European Union**
- GDPR applies if the business has any EU/EEA customers or processes EU personal data.
- GDPR compliance is a significant diligence item for any buyer with EU market exposure.

### Common seller blind spots
- Churn rate is understated — sellers quote gross new MRR without netting out churned MRR
- Technical debt is minimized — "it works fine" is not the same as "it's well-built"
- IP assignment agreements with contractors may not exist
- AWS/cloud costs are growing faster than revenue
- Customer concentration in a few enterprise accounts is presented as a strength rather than a risk
- GDPR/CCPA compliance is assumed but not verified
- Security vulnerabilities that haven't been exploited yet but will be discovered in due diligence
- Open-source license compliance not reviewed

---

## 14B. E-COMMERCE BUSINESSES

### Critical fields [CRITICAL]

**Revenue and channel breakdown**
- What is the total annual revenue?
- Revenue breakdown by channel — own website (DTC), Amazon, other marketplaces, wholesale?
- What is the revenue trend over the last 3 years?
- Is revenue growing, stable, or declining?
- What is the gross margin by channel?

**Product and inventory**
- What products are sold and who manufactures them?
- Are products proprietary/branded or resale of other brands?
- Is inventory held or dropshipped?
- What is the current inventory value at cost?
- What is the inventory turn rate?
- Are there any purchase commitments or minimum order quantities?
- What is the return rate and how are returns handled?

**Platform and technology**
- What e-commerce platform is used (Shopify, WooCommerce, BigCommerce, custom)?
- What is the technology stack for any custom development?
- Are there any platform fees or app subscription costs that are material?
- What integrations are in place (ERP, 3PL, accounting)?

**Amazon-specific (if applicable)**
- What is the Amazon Seller Account status — Individual, Professional, Brand Registered?
- Are there any account health warnings, suspensions, or policy violations?
- What is the Amazon BSR (Best Seller Rank) for key products?
- Are there any Amazon-specific reviews and what is the rating?
- Are there any FBA (Fulfillment by Amazon) inventory storage fees?
- What is the advertising spend on Amazon (PPC) and the ACOS (Advertising Cost of Sales)?

Why it matters: An Amazon seller account cannot be transferred — the buyer must create a new account. Amazon reviews and seller history cannot be transferred either. A business heavily dependent on Amazon has a significant transition risk that buyers must understand.

**Customer acquisition and retention**
- What is the primary customer acquisition channel (SEO, paid social, email, influencer, etc.)?
- What is the customer acquisition cost (CAC)?
- What is the repeat purchase rate?
- What is the email list size and engagement rate?
- What are the social media follower counts?
- What is the monthly advertising spend and ROAS (Return on Ad Spend)?

**Supplier relationships**
- Who are the key suppliers/manufacturers?
- Are there exclusivity agreements?
- What are lead times and minimum order quantities?
- Are suppliers concentrated (single source for key products)?

**Intellectual property**
- Are trademarks registered for the brand name and logo?
- Are any products patented?
- Are there any copyright or trademark infringement issues?
- Are product listing images and copy original or stock?

**Fulfillment and logistics**
- What is the fulfillment model (in-house, 3PL, FBA)?
- What are the fulfillment costs per order?
- What 3PL contracts are in place and are they transferable?
- What is the average shipping cost and how is it handled (free shipping, customer-paid, threshold)?

### Jurisdiction-specific [JURISDICTION]

**Canada**
- Canadian Anti-Spam Legislation (CASL) governs email marketing — the email list must have been built with proper consent.
- HST/GST compliance and provincial sales tax for multi-province sales.
- Canadian customs and duties for imported products.
- CBSA compliance for regular importers.

**United States**
- Sales tax nexus — e-commerce sellers must collect and remit sales tax in states where they have nexus (following the South Dakota v. Wayfair Supreme Court decision, economic nexus applies in most states).
- FTC endorsement guidelines for influencer marketing.
- Consumer product safety regulations (CPSC) for physical products.
- State consumer protection laws for online retailers.

---

## 14C. MOBILE APPS

### Critical fields [CRITICAL]

**Revenue model**
- What is the monetization model — subscription, one-time purchase, freemium, advertising, in-app purchases?
- What is the MRR/ARR if subscription-based?
- What are the monthly and annual download numbers?
- What is the monthly active user (MAU) count?
- What is the Daily Active User / Monthly Active User (DAU/MAU) ratio?

**App store metrics**
- What is the App Store (iOS) and Google Play rating and number of reviews?
- Are there any App Store or Google Play policy violations?
- What is the app's current App Store ranking in its category?
- What is the App Store Optimization (ASO) strategy?

**Platform dependency risk**
- What percentage of revenue is generated through Apple App Store vs Google Play?
- Apple and Google each take 15-30% of subscription revenue — what is the effective net revenue after platform fees?
- Is the business at risk from App Store policy changes or removal?
- Is there a web-based alternative that bypasses app store fees?

Why it matters: Apps can be removed from the App Store or Google Play for policy violations — this is an existential risk. App Store review scores directly affect download rates. Platform fees of 15-30% significantly affect unit economics.

**Technical considerations**
- Is the app native (Swift/Kotlin) or cross-platform (React Native, Flutter)?
- What is the codebase quality and documentation?
- What are the backend infrastructure costs?
- What is the crash rate and performance metric history?

---

## 14D. DIGITAL AGENCIES AND DEV SHOPS

### Critical fields [CRITICAL]

**Revenue model**
- What is the split between project-based (fixed-fee), time-and-materials, and retainer revenue?
- What is the average project size and duration?
- What is the pipeline of signed but not yet started projects?
- What is the proposal-to-win ratio?

**Client concentration and retention**
- What are the top clients by revenue and what percentage of total does each represent?
- Are client relationships with the firm or with the owner/lead developer?
- What is the client retention rate?
- Are there any ongoing maintenance/support contracts generating recurring revenue?

**Team and capabilities**
- How many developers, designers, and project managers are on staff?
- Are key team members employees or contractors?
- What technology specializations does the team have?
- What is the staff utilization rate (billable hours as a percentage of available hours)?
- What is the revenue per employee?

**IP and deliverables**
- Who owns the code and designs produced for clients — the agency or the clients?
- Are there any internal tools, frameworks, or IP that the agency owns?
- Are there proper IP assignment agreements with employees and contractors?

**Key person risk**
- Is the owner the lead developer, designer, or project manager?
- Could the team deliver projects without the owner's involvement?
- What happens to client relationships if the owner departs?

Why it matters: Digital agencies and dev shops are heavily dependent on the technical and creative talent of the team. If the owner is the lead architect or primary client relationship, the business may not survive their departure.

---

## 14E. MARKETPLACE BUSINESSES

### Critical fields [CRITICAL]

**Two-sided marketplace metrics**
- What is the supply-side count (sellers, providers, listers)?
- What is the demand-side count (buyers, customers)?
- What is the take rate (commission percentage on transactions)?
- What is the Gross Merchandise Volume (GMV)?
- What is the net revenue (GMV × take rate)?
- What is the liquidity rate (percentage of listings that result in a transaction)?

**Network effects and defensibility**
- Is there a geographic or category focus?
- What is the competitive landscape — are there dominant players in this market?
- What are the barriers to entry for competitors?
- Is there a moat (network effects, data, brand, regulation)?

**Supply-side economics**
- What is the supply-side churn rate?
- What is the acquisition cost for new supply-side participants?
- Are there any exclusive or contracted supply-side relationships?

**Demand-side economics**
- What is the demand-side CAC?
- What is the repeat transaction rate?
- What is the average order value and frequency?

**Technology and operations**
- What is the technology stack?
- What is the customer support model and cost?
- Are there any regulatory considerations for the marketplace category?
- Is there any fraud or dispute resolution infrastructure?

Why it matters: Marketplace businesses are valued on GMV growth, take rate, and the strength of network effects. A marketplace with strong liquidity (supply meets demand efficiently) and low churn on both sides is significantly more valuable than one still trying to achieve product-market fit.

---

## 14F. CONTENT AND MEDIA WEBSITES

### Critical fields [CRITICAL]

**Traffic and SEO**
- What is the monthly organic traffic (Google Analytics or equivalent)?
- What is the traffic trend over the last 12-24 months?
- What percentage of traffic comes from organic search vs social vs direct vs paid?
- Has the site been affected by any Google algorithm updates? When and how severely?
- What is the domain authority and backlink profile?

Why it matters: Content websites are often heavily dependent on Google organic traffic. A single algorithm update can devastate traffic — and revenue — overnight. A site that recently recovered from a Google penalty may have volatility that doesn't show in trailing twelve months (TTM) revenue.

**Revenue breakdown**
- Display advertising (Mediavine, AdThrive, Google AdSense)?
- Affiliate commissions?
- Sponsored content?
- Digital products (courses, ebooks, downloads)?
- Email list monetization?
- What is the revenue per 1,000 sessions (RPM)?

**Content ownership and quality**
- Is all content original?
- Has any content been created by contractors? Are there IP assignment agreements?
- Is any content AI-generated and is this disclosed?
- Has the site had any DMCA takedown notices or copyright issues?
- How many total articles/pages and what is the content publication frequency?

**Email list**
- What is the email subscriber count?
- What is the open rate and click rate?
- Is the list built with proper consent (CASL in Canada, CAN-SPAM in US)?
- What email service provider is used (Mailchimp, ConvertKit, ActiveCampaign)?

**AI and algorithm risk**
- Has traffic been affected by AI-generated search results (Google SGE/AI Overviews)?
- What percentage of content is vulnerable to zero-click answers?
- What is the content differentiation strategy vs AI-generated alternatives?

Why it matters: The rise of AI in search (Google AI Overviews, ChatGPT, Perplexity) is reducing click-through rates for many content websites, particularly those that answer simple factual questions. Buyers are increasingly scrutinizing AI-related traffic risk.

---

## 14G. DOMAIN AND HOSTING BUSINESSES

### Critical fields [CRITICAL]

**Revenue and customer base**
- What is the total recurring revenue from domain registrations, hosting, and related services?
- How many active customers?
- What is the average revenue per customer?
- What is the monthly churn rate?
- What is the breakdown between shared hosting, VPS, dedicated servers, and managed hosting?

**Infrastructure**
- Are servers owned or rented from a data centre / cloud provider?
- What data centre(s) are used and where are they located?
- What is the server capacity vs current utilization?
- What is the uptime history (SLA performance)?
- What is the backup and disaster recovery infrastructure?

**Support model**
- What is the support model (ticket, phone, chat, 24/7)?
- What is the support cost per customer?
- Are there any SLAs with customers that guarantee response times or uptime?

**Registrar status**
- If domains are resold, what registrar agreements are in place (ICANN-accredited registrar, reseller through another registrar)?
- Are registrar agreements transferable?

---

## 14H. TECHNOLOGY PRODUCTS AND HARDWARE

### Critical fields [CRITICAL]

**Product portfolio**
- What hardware products are sold (networking, IoT devices, sensors, consumer electronics, industrial equipment)?
- Are products designed in-house or rebranded/white-labeled?
- What is the product lifecycle stage (growth, mature, decline)?
- What is the warranty program and outstanding warranty liability?

**Manufacturing and supply chain**
- Where are products manufactured — in-house or contract manufactured (CM)?
- Who are the CMs and what are the contract terms?
- Are there any single-source components or suppliers?
- What is the current inventory value and Bill of Materials (BOM) cost?

**Certifications and compliance**
- Do products require safety certifications (UL, CSA, FCC, CE, IC)?
- Are all certifications current and in the company's name?
- Are there any pending certification renewals or new product certifications in process?

Why it matters: Product safety certifications (UL, CSA, FCC) are issued to the company and must be maintained. If certifications lapse or need to be reapplied for by a new owner, products cannot legally be sold until new certifications are obtained — which can take months.

**IP and patents**
- What patents are held and what is their remaining term?
- Are there any pending patent applications?
- Are there any licensing agreements (inbound or outbound)?
- Are there any known IP infringement issues?

**Distribution channels**
- What is the channel strategy (direct, distributor, OEM, retail)?
- Are there any exclusive distribution agreements?
- What are the channel margins at each level?

### Common seller blind spots — Technology/Online
- Churn rate is understated — sellers quote gross new MRR without netting out churned MRR
- Technical debt is minimized — "it works fine" is not the same as "it's well-built"
- IP assignment agreements with contractors may not exist
- AWS/cloud costs are growing faster than revenue
- Customer concentration in a few enterprise accounts is presented as a strength rather than a risk
- GDPR/CCPA/PIPEDA compliance is assumed but not verified
- Security vulnerabilities that haven't been exploited yet but will be discovered in due diligence
- Open-source license compliance not reviewed
- Amazon account non-transferability not understood
- Google algorithm dependency not disclosed for content sites
- AI disruption risk to content-dependent businesses not acknowledged
- Product certification transfer requirements not understood for hardware businesses

---

---

*End of Industry Intelligence Database — All 14 industry groups covered*

*Coverage summary:*
*1. Building / Construction / Property Management (1A-1E)*
*2. Healthcare (2A-2H)*
*3. Restaurants / Food Service (3A-3E)*
*4. Manufacturing (4A-4D)*
*5. Professional Services (5A-5H)*
*6. Automotive (6A-6E)*
*7. Retail (7A-7D)*
*8. Wholesale and Distribution (8A-8C)*
*9. Transportation and Logistics (9A-9E)*
*10. Wellness, Fitness, and Lifestyle (10A-10H)*
*11. Education (11A-11I)*
*12. Childcare and Entertainment (12A-12D)*
*13. Advertising, Media, and Events (13A-13F)*
*14. Technology and Online Business (14A-14H)*

*Total sub-industries: 70+*
*Jurisdictions covered: Ontario (primary), British Columbia, Alberta, United States (federal + California, Florida, Texas, New York, and other key states)*
