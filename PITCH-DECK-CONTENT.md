# Cimple — Platform Overview for Fundraising

## What Cimple Is

Cimple is an AI-powered platform for business brokers and M&A advisors that automates the most time-consuming part of selling a business: creating the Confidential Information Memorandum (CIM).

**Core insight:** AI will commoditize CIM writing. Collecting the information will not. Cimple owns the information collection layer — the intelligent interaction between platform and seller that transforms fragmented business knowledge into a structured, investment-ready document.

**The problem it solves:** A broker typically spends 40-80 hours per deal gathering information from sellers — chasing documents, asking follow-up questions, reconciling inconsistencies, and formatting the CIM. Sellers are busy running their businesses and give incomplete, unstructured answers. Brokers use generic templates that miss industry-specific details. The result: weeks of back-and-forth and CIMs that undersell the business.

**What Cimple does differently:** An AI agent conducts the seller interview like a skilled business advisor — adaptive, probing, industry-aware. It knows what questions to ask a construction company vs. a restaurant vs. a medical practice. It cross-references documents against interview answers. It produces a visually compelling CIM with charts, infographics, and data visualizations — not just text.

---

## What's Built and Working (Production-Ready)

### 1. AI Interview System — The Core Product

A multi-turn conversational AI that interviews business sellers to extract everything needed for a CIM.

- **Adaptive questioning:** No fixed script. The AI identifies gaps in the knowledge base and asks the most important questions next.
- **Industry intelligence:** 8,000+ lines of industry-specific logic covering 40+ industries. A construction company gets questions about bonding capacity, bid pipeline, and subcontractor relationships. A restaurant gets questions about lease terms, liquor licensing, and food cost ratios. A medical practice gets questions about payer mix and regulatory compliance.
- **Guided answers:** Each question includes 3-5 suggested answers tailored to the industry, reducing seller effort.
- **Smart deferral:** When a seller can't answer, the AI explains why the information matters, tells them where to find it (based on their specific accounting system, CRM, etc.), and defers the topic for later.
- **Knowledge base awareness:** Never re-asks for information already provided via documents, questionnaires, or prior conversations.
- **Coverage dashboard:** Real-time progress tracking by CIM section with gamification elements to keep sellers engaged.
- **Model:** Claude Opus 4.5 (Anthropic's most capable model) — the interview quality is a core differentiator.

### 2. Multi-Source Document Ingestion

Accepts and intelligently parses business documents in any format:

- **Formats:** PDF, Excel (.xlsx/.xls), Word (.docx/.doc), PowerPoint (.pptx/.ppt), CSV, plain text, Markdown
- **AI extraction:** Each document is processed by Claude to extract structured M&A-relevant data — financials, lease terms, employee information, operational metrics
- **Call transcript ingestion:** Brokers can paste or upload call transcripts; the AI extracts key information and adds it to the knowledge base
- **Confidence tracking:** Every piece of extracted data is tagged with confidence level (confirmed > inferred > approximate) so the AI knows what to verify with the seller

### 3. Financial Analysis Pipeline

A full AI-powered financial analysis engine:

- **Automated reclassification:** P&L, balance sheet, cash flow, and AR aging statements are reclassified into standard M&A categories
- **SDE/EBITDA normalization:** AI identifies addback candidates (owner compensation, one-time expenses, personal expenses run through the business)
- **Addback verification workflow:** Each proposed addback is presented to the seller for confirmation, rejection, or modification
- **Working capital calculation:** Automated computation with supporting detail
- **Clarifying questions:** AI generates targeted questions about financial anomalies and red flags
- **Financial insights:** Both positive and negative insights generated for inclusion in the CIM
- **Versioned analysis runs:** Multiple analyses can be saved and compared

### 4. AI-Designed CIM Generation

Not a template — a bespoke visual document designed by AI for each business:

- **21 layout types:** Cover pages, metric grids, bar/line/pie/donut charts, financial tables, comparison tables, timelines, org charts, scorecards, stat callouts, prose highlights, two-column layouts, location cards, callout lists, numbered lists, dividers
- **AI selects the optimal visualization:** For each piece of content, the AI chooses the best visual format. Revenue trends get line charts. Customer concentration gets pie charts. Key metrics get stat grids. The company story gets prose highlights.
- **Three CIM versions generated automatically:**
  - **Normal CIM** — Full business information
  - **Blind CIM** — AI redacts all identifying information (business name, location, employee names, customer names) and replaces with fictitious placeholders. Random project codename assigned. Financials preserved.
  - **DD (Due Diligence) CIM** — Enriched version with previously withheld details, customer names revealed, bank comparison commentary, addback verification details
- **Broker branding:** White-label capable — applies the broker's company name, logo, and brand colors
- **Learning loop:** Aggregates buyer engagement data across deals to optimize layout choices for future CIMs (e.g., "buyers spend more time on bar charts than pie charts for revenue breakdowns in this industry")

### 5. Discrepancy Resolution Engine

AI-powered cross-referencing catches inconsistencies before the CIM goes out:

- **Automatic detection:** Cross-references interview answers vs. document data vs. scraped public information
- **Severity classification:** Critical (blocks CIM), Significant, Minor
- **Category tagging:** Financial, Operational, Legal, Factual
- **Resolution workflow:** For each discrepancy, the broker can accept the interview value, the document value, or enter a corrected value
- **Knowledge base integration:** Resolved values feed back into the knowledge base for CIM regeneration

### 6. Internet Scraping & Verification

Automatically gathers public information about the business:

- **Fallback chain:** Provided URL → DuckDuckGo search → homepage + /about page
- **Extracts:** Business description, year founded, locations, products, revenue streams, target market, competitive advantage, management team
- **Stored as UNVERIFIED:** The interview agent confirms scraped data with the seller before trusting it

### 7. Secure Buyer View Room (Firmex-style)

A secure, tokenized environment where approved buyers view the CIM:

- **Token-based access:** Pre-approved email addresses only — links cannot be forwarded
- **Electronic NDA:** Required before viewing
- **Auto-expiry:** Links expire after 30 days unless extended
- **Watermarking:** All viewed and printed versions are traceable
- **Three access stages:** Initial review → LOI → Due Diligence (each stage reveals more information)

### 8. Deep Buyer Matching Engine

49 criteria across 5 categories for sophisticated buyer-deal matching:

- **Financial criteria:** Revenue range, EBITDA, SDE, asking price, margins, growth rate
- **Operational criteria:** Employee count, location, industry, lease requirements
- **Business quality:** Customer concentration, management depth, brand strength
- **Deal structure:** Seller financing preferences, transition support, non-compete
- **Growth/Strategic:** Growth potential, competitive moat, acquisition synergies
- **Two-phase scoring:** 60% deterministic rule-based + 40% AI qualitative assessment via Claude
- **Positive framing (non-negotiable):** Buyers see "X criteria matched" with dimension chips — never letter grades or percentages that could discourage engagement

### 9. Buyer Self-Serve Platform

A complete buyer-side experience:

- **Two onboarding paths:** Self-signup (marketed to buyers) or broker-invited (set-password email)
- **Profile editor:** Targets (industries, locations), financial capability, deep M&A criteria
- **Live profile completion bar:** Weighted scoring encourages complete profiles
- **Buyer dashboard:** All accessible CIMs with industry/firm/sort filters and positive match framing
- **Idempotent invite flow:** Handles edge cases (existing accounts, re-invites)

### 10. Buyer Approval Workflow (Two-Stage Review)

Firmex-style approval before any buyer gets access:

- **Broker submits buyer:** With CRM autocomplete (Pipedrive primary), existing-account search, Claude-powered extraction from attached files
- **Lead broker review:** Approve/reject with notes, risk level assessment
- **Seller sign-off:** Tokenized page (no login required) — seller reviews and approves each buyer before access is granted
- **Risk classification:** High/Medium/Low based on competitor flags + financial verification

### 11. Buyer Q&A Chatbot

AI-powered Q&A in the View Room:

- **3-step answer pipeline:** (1) Check published Q&A knowledge base, (2) Answer from CIM content, (3) Escalate to broker
- **Escalation chain:** AI drafts answer → broker reviews → seller approves → published to buyer
- **Persistent knowledge base:** Every answered question improves future responses for that deal
- **Token-based seller approval:** No login required

### 12. Deal Team Management

Role-based access control modeled after Firmex:

- **Three team types:** Broker (Lead, Associate, Analyst, Admin), Seller (Owner, Representative, Accountant, Attorney), Buyer (Principal, Analyst, Advisor, Attorney)
- **Granular permissions:** can_approve_content, can_view_financials, can_manage_team, etc.
- **Notification preferences:** Email + SMS per member
- **Invite tracking:** Pending → Sent → Accepted

### 13. Buyer Analytics & Engagement Tracking

Deep analytics on how buyers interact with the CIM:

- **Event tracking:** Page views, scroll depth, heat maps, time-on-page, section enter/exit, element hover, download attempts
- **Heat map visualization:** Normalized x/y coordinate collection
- **Engagement insights aggregation:** Average time, scroll depth, completion rate by industry, section, and layout type
- **Broker analytics dashboard:** 8 tabs — Overview, Buyer Activity, Section Engagement, Heat Map, Drop-off, Buyer Scores, Activity Timeline, Deal Comparison
- **Qualified Interest scoring:** Ranks buyers by match-fit × engagement — surfaces warmest leads that are both interested AND a good fit
- **Profile-aware:** Joins buyer accounts to show buyer type, profile completion, proof-of-funds

### 14. Delayed Decision Reminder Pipeline

Automated buyer follow-up anchored to first view:

- Day 0: No prompt (breathing room)
- Day 3: Polite reminder
- Day 6: Warning ("will mark as lapsed in 48 hours")
- Day 8: Auto-lapse with broker + seller notification
- Idempotent: Each email sent exactly once

### 15. Buyer Decision Capture + CRM Sync

- Buyers submit Interested / Not Interested / Need More Time from the View Room
- Decision auto-syncs to broker's connected CRM (moves deal stage)
- Pipedrive: Full implementation. HubSpot + Salesforce: Stubs ready.

### 16. Notification System

- Event-driven via Resend (email) + Twilio (SMS)
- Smart routing: Maps event types to team/role recipients
- Dark-themed HTML email templates
- Graceful fallback to console when credentials not configured

### 17. 4-Phase Deal Workflow

1. **Phase 1 — Info Collection (Pre-Platform):** Calls, NDA, seller questionnaire, documents, valuation
2. **Phase 2 — Platform-Driven Collection:** Internet scrape, seller onboarding, AI interview, discrepancy resolution
3. **Phase 3 — Content Creation:** AI writes CIM, broker reviews, seller reviews
4. **Phase 4 — Design & Distribution:** AI designs visual CIM, buyer analytics go live

---

## Technology

| Layer | Technology |
|---|---|
| Frontend | React + TypeScript + Vite |
| Backend | Express.js (ESM) |
| Database | PostgreSQL (25 tables) via Drizzle ORM |
| AI | Anthropic Claude API — Opus 4.5 (interview), Sonnet 4.5 (supporting agents) |
| Notifications | Resend (email) + Twilio (SMS) |
| Hosting | Railway.app |
| Auth | Session-based (brokers/buyers), Token-based (sellers, buyer view rooms) |
| Design | Shadcn/ui + Radix UI (45+ components), Tailwind CSS, Framer Motion |

### Multi-Agent AI Architecture

| Agent | Role | Model |
|---|---|---|
| Interview Agent | Conducts adaptive seller interviews | Claude Opus 4.5 |
| Knowledge Base Agent | Ingests all inputs, builds structured business profile | Claude Sonnet 4.5 |
| Financial Analysis Agent | Reclassifies financials, normalizes SDE/EBITDA, generates insights | Claude Sonnet 4.5 |
| CIM Design Agent | Transforms data into visual CIM with optimal layout per section | Claude Sonnet 4.5 |

---

## Database Schema (25 Tables)

users, deals, documents, tasks, interviewSessions, cimSections, cimSectionOverrides, cims, engagementInsights, buyerQuestions, sellerInvites, buyerAccess, analyticsEvents, faqItems, brandingSettings, integrations, integrationEmails, dealKnowledgeSources, financialAnalyses, addbackVerifications, discrepancies, dealMembers, notifications, buyerApprovalRequests, buyerUsers

---

## Integrations

| Integration | Status |
|---|---|
| Anthropic Claude API | Live |
| Railway.app (Hosting + DB) | Live |
| Pipedrive CRM | Live (buyer submit, decision sync) |
| Resend (Email) | Ready |
| Twilio (SMS) | Ready |
| Gmail (OAuth email sync) | Infrastructure built, needs credentials |
| Outlook (OAuth email sync) | Infrastructure built, needs credentials |
| HubSpot CRM | Schema ready, stubs built |
| Salesforce CRM | Schema ready, stubs built |
| BizBuySell/DealStats (Comps) | Stub built, needs API keys |

---

## What's Not Built Yet (Roadmap)

1. **Call recording & transcription** — Mobile app or third-party integration. Transcripts feed the knowledge base.
2. **Proactive buyer matching notifications** — When a new deal is published, auto-match against buyer profiles and suggest an outreach batch for the broker to review and send.
3. **CRM integrations** — Salesforce + HubSpot full implementation (schema and stubs exist).
4. **Comps API** — Connect to BizBuySell/DealStats for automated comparable transaction data.
5. **Email sync** — Gmail/Outlook OAuth for automatic seller communication ingestion.

---

## Key Metrics / Proof Points

- **40+ industries** with deep, jurisdiction-specific interview intelligence
- **21 visual layout types** for CIM generation
- **49 buyer matching criteria** across 5 categories
- **25 database tables** — comprehensive data model
- **3 CIM versions** auto-generated (Normal, Blind, DD)
- **8-tab analytics dashboard** with heat maps and engagement scoring
- **4-agent AI architecture** with specialized roles
- Live at: https://cimple-production.up.railway.app
