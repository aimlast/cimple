# CLAUDE.md — Cimple
## Read this at the start of every session. This is the source of truth.

---

## What Cimple is

Cimple is an AI-powered platform for business brokers and M&A advisors that solves the hardest part of creating CIMs (Confidential Information Memorandums): extracting high-quality, structured information from sellers.

**The core insight:** Writing CIMs will be commoditized by AI. Collecting the information will not. Cimple owns the information collection layer.

**The product is not** a writing assistant, template generator, or form builder. It is an intelligent system that interacts directly with sellers, asks adaptive questions, probes weak answers, explains why information is needed, and builds a complete structured business profile from fragmented inputs.

---

## Founder context

- Non-technical founder with deep domain expertise in sell-side M&A and business brokerage
- Do not ask technical questions. Present A/B options with a recommendation. Default to the recommendation if no response.
- Quality over speed. Never ship something that feels like a form masquerading as intelligence.

---

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | React + TypeScript + Vite |
| Backend | Express.js (ESM, compiled via esbuild) |
| Database | PostgreSQL via Railway + Drizzle ORM |
| AI | Anthropic Claude API — use `claude-opus-4-5` for the interview agent, `claude-sonnet-4-5` for supporting agents |
| Notifications | Resend (email) + Twilio (SMS) — graceful console fallback when credentials absent |
| Deployment | Railway.app (Nixpacks, NIXPACKS_NODE_VERSION=20) |
| Auth | Session-based (brokers + buyers via express-session/memorystore + bcryptjs), token-based (sellers, tokenized buyer view rooms) |

**Live URL:** https://cimple-production.up.railway.app

**GitHub workflow:** Use GitHub Desktop for bulk pushes. Use the GitHub Contents API (browser) only for small single-file changes.

---

## What is already built

### Core Platform
- Broker layout: sidebar with Dashboard, Deals, Analytics, Templates, Settings, Support
- Seller routes: Progress, Chat, Documents
- Buyer View Room (tokenized access with NDA signing, analytics tracking, heat maps)
- 4-phase deal workflow: `phase1_info_collection` → `phase4_design_finalization`
- Branding settings: logo upload, company name, disclaimer, footer, white-label support
- Seller invite system (token-based onboarding)
- Analytics event tracking (page views, scroll depth, heat maps, time-on-page)

### AI Interview System (fully rebuilt — adaptive, not a fixed sequence)
- Multi-turn conversational interview via Claude Opus 4.5
- Dynamic question generation based on knowledge base gaps (no fixed script)
- Industry-specific intelligence: 8,000+ lines covering 40+ industries with jurisdiction-specific fields
- Guided answer selection: 3-5 suggested answers per question, industry-tailored
- Coverage dashboard with section-by-section progress tracking (gamification)
- Confidence-based field merging (confirmed > inferred > approximate)
- Intelligent deferral with 6-step process for difficult questions
- Session resume across multiple interactions
- Deferred topics panel and real-time coverage metrics
- **Files:** `server/interview/` (session-manager, knowledge-base, system-prompt, response-schema, info-merger, prompts/, data/, config/)

### CIM Design & Generation (visual output — not text-only)
- AI-powered layout engine that produces bespoke visual sections per deal
- 21 layout types: cover page, metric grid, bar/line/pie/donut charts, financial tables, comparison tables, timelines, org charts, scorecards, stat callouts, prose highlights, two-column layouts, location cards, callout/numbered lists, dividers
- Recharts-based chart rendering in the frontend
- Three CIM versions: Normal, Blind (AI-redacted), DD (due diligence enriched)
- CIM Designer page for manual section arrangement and customization
- Learning loop: aggregates buyer engagement data to optimize future layout choices
- **Files:** `server/cim/` (layout-engine, layout-types, redaction-engine, dd-enrichment, discrepancy-engine, learning-loop)

### Document Parsing & Extraction
- PDF (pdf-parse), Excel .xlsx/.xls (xlsx), Word .docx/.doc (officeparser), PowerPoint .pptx/.ppt (officeparser), text/CSV/markdown (direct read)
- Claude-powered structured extraction: maps document text to M&A-relevant fields (financials, lease/legal, employees, operations)
- Call transcript extraction pipeline: ingests transcripts (paste/upload) and extracts to knowledge base
- Extracted data merged additively onto deal's `extractedInfo`
- **Files:** `server/documents/` (parser, extractor)

### Internet Scraping
- Public data scraper with fallback chain: provided URL → DuckDuckGo search → homepage + /about page
- Extracts: business description, year founded, locations, products, revenue streams, target market, competitive advantage, management team
- Scraped data stored separately as UNVERIFIED — interview agent confirms with seller before trusting
- **Files:** `server/scraper/index.ts`

### Financial Analysis
- Full pipeline: extract line items → reclassify into M&A categories → identify SDE/EBITDA addbacks → calculate working capital → generate clarifying questions → produce insights
- Addback verification workflow: seller confirms/rejects/modifies each line item
- Statement types: income statement, balance sheet, cash flow, AR aging
- Versioned analysis runs
- Comps integration stubbed (ready for BizBuySell/DealStats API)
- **Files:** `server/financial/` (analyzer, extractor, addback-verifier, comps)

### Discrepancy Resolution
- AI cross-references interview answers vs. document data
- Flags inconsistencies with severity (critical/significant/minor) and category (financial/operational/legal/factual)
- Resolution workflow: accept interview value, document value, or enter corrected value
- Critical discrepancies block CIM generation until resolved
- Resolved values feed back into knowledge base
- **Files:** `server/cim/discrepancy-engine.ts`, `client/src/components/deal/DiscrepancyPanel.tsx`

### Buyer Matching Engine (deep M&A criteria)
- 49 criteria across 5 categories: financial, operational, business quality, deal structure, growth/strategic
- Two-phase scoring: deterministic rule-based (60%) + AI qualitative via Claude Sonnet (40%)
- Deterministic: ranges (revenue, EBITDA, SDE, asking price), margins, growth, customer concentration, employees, lease length, industry/location fit
- AI qualitative: growth potential, competitive moat, management depth, brand strength, reason-for-sale alignment, ideal-buyer-profile fit
- Returns `criteriaMatched` count + per-dimension breakdown for positive framing on dashboards (never letter grades)
- `skipAI: true` option for fast batch matching (used by buyer dashboard + analytics)
- **Files:** `server/matching/engine.ts`

### Buyer Approval Workflow (Firmex-style two-stage review)
- Submit buyer dialog with CRM autocomplete (Pipedrive primary; HubSpot/Salesforce stubs) + existing-account search
- Pre-fill from CRM record + attached files via Claude extraction
- Lead broker review stage (approve/reject with notes)
- Tokenized seller review page (no login) — seller signs off before buyer gets access
- Auto-creates buyer access + invites buyer to set password if no Cimple account
- Risk levels (high/medium/low) based on competitor flags + financial verification
- **Files:** `client/src/components/deal/BuyerApprovalsPanel.tsx`, `client/src/pages/SellerBuyerApprovalPage.tsx`, `server/crm/buyer-prefill.ts`

### Buyer Self-Serve Accounts + Dashboard
- Two onboarding pathways: self-signup (marketed to buyers) and broker-invited (set-password email)
- Idempotent invite flow — `inviteBuyerUser` returns existing or creates new with reset token
- Profile editor with sections: basic info, targets (industries/locations), financial capability, deep M&A criteria
- Live profile completion bar with weighted scoring (`calculateBuyerProfileCompletion`)
- Buyer dashboard shows all accessible CIMs with industry/firm/sort filters
- **Positive match framing (non-negotiable):** raw criteria-matched count + top dimension chips, never letter grades or percentages
- Backwards compatible — `buyerUserId` is an optional FK on `buyerAccess`, tokenless email links still work
- **Files:** `server/buyer-auth/routes.ts`, `server/buyer-auth/dashboard.ts`, `client/src/pages/buyer/` (BuyerLogin, BuyerSignup, BuyerSetPassword, BuyerDashboard, BuyerProfile)

### Buyer Decision Capture + CRM Sync
- Buyers submit "Interested" / "Not interested" / "Need more time" decisions from the View Room
- Decision auto-syncs to broker's connected CRM (moves deal to next stage)
- Pipedrive: full implementation; HubSpot + Salesforce: stubs ready for credentials
- Configurable stage mapping per provider via `integrations.config` → `CrmStageMapping`
- Graceful degradation when no CRM connected (logs `not_configured`)
- **Files:** `server/crm/sync.ts`

### Delayed Decision Reminder Pipeline
- Anchored to `buyerAccess.firstViewedAt`
- Day 0 → no prompt (breathing room)
- Day 3 → polite reminder email
- Day 6 → warning email ("we will mark this as lapsed in 48 hours")
- Day 8 → auto-lapse: mark `decision=lapsed`, notify broker + seller team
- Idempotent via `reminderStage` field on `buyerAccess` — each email sent exactly once
- Direct buyer email (bypasses team notification routing)
- **Files:** `server/reminders/decision-reminders.ts`

### Buyer Q&A Chatbot
- Floating chat widget on Buyer View Room
- 2-step AI knowledge base check: (1) similarity match against published Q&A, (2) CIM content answer, (3) escalation to broker
- Escalation chain: AI → broker drafts answer → seller approves → published to buyer
- Persistent knowledge base per deal — learns from every answered question
- Token-based seller approval pages (no login required)
- **Files:** `client/src/components/buyer/BuyerChatbot.tsx`, `client/src/components/deal/BuyerQAPanel.tsx`, `client/src/pages/SellerApprovalPage.tsx`

### Deal Team Management (Firmex-style)
- Three team types: Broker, Seller, Buyer — each with role-based permissions
- Broker roles: Lead Broker, Associate, Analyst, Admin
- Seller roles: Owner, Representative, Accountant, Attorney
- Buyer roles: Principal, Analyst, Advisor, Attorney
- Each role has specific permissions (e.g., can_approve_content, can_view_financials, can_manage_team)
- Email + SMS notification preferences per member
- Invite status tracking: pending → sent → accepted
- **Files:** `client/src/components/deal/TeamPanel.tsx`, `server/notifications/service.ts`

### Notification System
- Event-driven notifications via Resend (email) and Twilio (SMS)
- Graceful degradation: logs to console when credentials not configured
- Smart routing via `NOTIFICATION_ROUTING` — maps event types to team/role recipients
- Dark-themed HTML email templates with Cimple branding
- Events: qa_needs_approval, buyer_question, discrepancy_found, phase_advanced, document_processed, interview_complete
- **Files:** `server/notifications/service.ts`

### Buyer Analytics
- Event tracking: view, page_view, section_enter/exit, scroll, heat_map_sample, element_hover, download_attempt, time_on_page, nda_signed, question_asked
- Heat map data collection (normalized x/y coordinates)
- Engagement insights aggregation (avg time, scroll depth, completion rate by industry/section/layout)
- Learning loop feeds insights back into CIM layout engine
- **Broker analytics dashboard live** at `client/src/pages/Analytics.tsx` — tabs for Overview, Buyer Activity, Section Engagement, Heat Map, Drop-off, Buyer Scores, Activity Timeline, Deal Comparison
- **Profile-aware:** Buyer Activity tab joins buyer Cimple accounts to show buyer type, profile completion, proof-of-funds, and per-deal match fit (criteria matched + top dimensions)
- **Qualified Interest insight:** Overview tab ranks buyers by `match-fit × engagement` — surfaces warmest leads that are both interested AND a good fit

**Design system:**
- Dark mode primary (near-black background, cream/light text)
- Linear/Notion-inspired aesthetic
- Shadcn/ui + Radix UI components (45+ primitives)
- Tailwind CSS with custom HSL design tokens
- Fonts: Inter (UI), JetBrains Mono (technical content)
- Primary brand color: teal
- Framer Motion for animations

**Database schema (25 tables):**
`users`, `deals`, `documents`, `tasks`, `interviewSessions`, `cimSections`, `cimSectionOverrides`, `cims`, `engagementInsights`, `buyerQuestions`, `sellerInvites`, `buyerAccess`, `analyticsEvents`, `faqItems`, `brandingSettings`, `integrations`, `integrationEmails`, `dealKnowledgeSources`, `financialAnalyses`, `addbackVerifications`, `discrepancies`, `dealMembers`, `notifications`, `buyerApprovalRequests`, `buyerUsers`

---

## What is NOT built yet (known gaps)

- [ ] Call recording and transcription (mobile app or third-party integration)
- [ ] Email sync (OAuth infrastructure exists but no provider secrets configured)
- [ ] CRM integration (Salesforce, HubSpot — schema ready, implementation pending)
- [ ] Proactive buyer-to-deal matching + new-deal notifications (matching engine + buyer dashboard live; auto-notify on new deal pending)
- [ ] Comps API integration (stub exists, needs BizBuySell/DealStats API keys)
- [ ] UX iteration pass across all flows

---

## Agent architecture

Cimple uses a multi-agent system. Each agent has a distinct role and system prompt. A manager layer in the interview system orchestrates between them.

### Agent 1 — Interview agent (live)
**Role:** Conducts the seller interview. Adaptive, context-aware, probing.
**Model:** `claude-opus-4-5` (4096 max tokens, temperature 1.0)

**Behavior:**
- Starts with full knowledge of everything already collected (docs, emails, SQ, calls, internet data)
- Confirms known information rather than re-asking for it
- Identifies gaps and probes them conversationally
- If seller can't answer: uses 6-step process (explain why it matters, locate the info source, give retrieval instructions, rephrase, defer with context, circle back)
- Uses the seller's operational baseline (accounting system, CRM, employee list) to give specific retrieval instructions
- Knows which documents are uploaded, outstanding, or promised — never asks for already-provided materials
- Flags unresolvable gaps to the broker with full context
- After interview: generates a dynamic to-do list for the seller
- Offers 3-5 guided answer suggestions per question, industry-tailored
- Tracks coverage by CIM section with real-time progress indicators

**Voice/tone:** Feels like a skilled business advisor helping the seller articulate their business — not a form, not a rigid chatbot.

### Agent 2 — Knowledge base agent (live)
**Role:** Ingests all inputs and builds the structured business profile used by all other agents.

**Inputs:** Call transcripts, emails, seller questionnaire, uploaded documents, internet scrape data
**Output:** Structured JSON knowledge base mapped to CIM sections
**Behavior:** Continuously updates as new documents are added. Identifies conflicts and flags them via discrepancy engine. Merges fields with confidence tracking (confirmed > inferred > approximate).

### Agent 3 — Financial analysis agent (live)
**Role:** Handles all financial processing.

**Tasks:**
- Reclassifies P&L, Balance Sheet, Cash Flow, AR Aging into standard M&A categories
- Runs normalization exercise (SDE/EBITDA) with addback verification workflow
- Generates clarifying questions for red flags and anomalies
- Calculates working capital
- Comps pull via API for preliminary Opinion of Value (stubbed — needs API keys)
- Produces financial insights (positive and negative) for CIM sections

### Agent 4 — CIM design agent (live)
**Role:** Transforms approved content into a visually compelling CIM.

**Behavior:**
- AI selects optimal layout type per section from 21 options (charts, tables, grids, timelines, etc.)
- Applies broker brand guidelines and selected aesthetic templates
- White-label capable (applies other companies' brand identity)
- Generates three versions: Normal, Blind (redacted), DD (enriched)
- Considers buyer engagement data (learning loop) to optimize layout choices
- Output rendered via Recharts and custom React components

---

## CIM document structure

**Section keys (camelCase):**
`executiveSummary`, `companyOverview`, `historyMilestones`, `uniqueSellingPropositions`, `sourcesOfRevenue`, `growthStrategies`, `targetMarket`, `permitsLicenses`, `seasonality`, `locationSite`, `employeeOverview`, `transactionOverview`, `financialOverview`

**Note:** The AI is intelligent enough to add or remove sections based on the specific business. These keys are defaults, not a rigid template.

**Standard CIM sections:**
1. Cover page — logo, "CONFIDENTIAL BUSINESS OVERVIEW", business name, broker name
2. Confidentiality & disclaimer page
3. Executive summary snapshot — key metrics grid
4. Table of contents
5. Company overview group (overview, history, USPs, revenue, growth, SWOT, competitive analysis, industry, target market, permits, seasonality, location, employees)
6. Transaction overview (deal structure, training, reason for sale, assets, non-compete)
7. Financial overview (balance sheet, income statement, SDE/EBITDA normalization)
8. Data visualizations (charts, graphs)
9. Contact page

**CIM versions:**
- **Blind** — AI-redacted: all identifying info (business name, location, employee names, customer names) replaced with fictitious placeholders. Financials preserved. Random project codename assigned.
- **Normal** — Standard CIM with all business information.
- **DD (Due Diligence)** — Enriched version: customer names revealed in charts, T2/bank comparison commentary, addback verification details inline, previously withheld info highlighted.

---

## User roles and flows

**Broker** — creates deals, invites sellers, manages deal teams, reviews content, approves CIM, manages buyers
**Seller** — invited to platform (token-based), completes questionnaire, participates in AI interview, reviews draft, approves Q&A answers
**Buyer** — receives tokenized CIM link, signs NDA, views in secure room, asks questions via chatbot, analytics tracked

**5-phase deal workflow:**
1. Info collection (pre-platform): calls, NDA, SQ, docs, valuation
2. Info collection (platform-driven): internet scrape, seller onboarding, AI interview, discrepancy resolution
3. Copy/data: AI writes, broker reviews, seller reviews
4. Design: AI designs with visual layouts, broker reviews
5. Buyer analytics & matching: CIM goes live, buyers tracked, Q&A chatbot active

---

## Build priority order (updated)

**1 — Call recording / transcription** (not started)
Mobile app or third-party integration. Transcripts feed directly into the knowledge base.

**2 — Email sync** (infrastructure ready, needs OAuth secrets)
Gmail and Outlook OAuth infrastructure exists. Needs provider credentials to activate. Parsed emails feed knowledge base.

**3 — Proactive buyer matching + broker-approved new-deal notifications** (engine + dashboards live)
Matching engine and buyer-side dashboard exist. Brokers see profile-aware analytics with `match-fit × engagement` ranking. Remaining: when a broker publishes a new deal, auto-match against all buyer profiles and **suggest** an email batch to qualifying buyers — broker reviews the suggested list, picks who to contact, edits the message if needed, and clicks send. **Never auto-send.** Positive framing ("X criteria matched"). Broker stays in control.

**4 — Buyer scoring composites** (foundation in place)
Composite engagement scoring exists in `BuyerComparison`. Next: incorporate match-fit + profile completeness + proof-of-funds into a single qualified-lead score per buyer.

**5 — CRM integration** (schema ready)
Salesforce, HubSpot — schema and token storage exist, implementation pending.

**6 — UX iteration** (ongoing)
Polish all flows, responsive design, error states, loading states.

---

## Key product rules (non-negotiable)

- **The interview must feel like a conversation with a skilled advisor**, not a form. If it feels like filling in text boxes, it is not ready.
- **CIM output must be visually compelling.** Charts, infographics, dynamic layouts. Text-only is a prototype, not a product.
- **Never re-ask for information already provided.** The knowledge base agent must be consulted before every interview question.
- **Design is a product feature**, not a skin. The CIM design agent must make intelligent layout decisions per section.
- **The AI model for the interview agent is `claude-opus-4-5`.** Do not downgrade this for the interview. Use `claude-sonnet-4-5` for supporting tasks.
- **Export strategy is TBD.** Do not build PDF export until this decision is made. Default to link-based viewing (preserves analytics).
- **Industry-specific interview intelligence (non-negotiable).** The interview agent must identify the business type, industry, and location early in every interview and use that to dynamically load industry-specific question areas on top of the standard CIM sections. Generic questions alone are not acceptable. The agent must know what information is uniquely important for each industry — for example: construction (bonding and surety, bid pipeline, current backlog, holdbacks, subcontractor relationships, licensing by trade), restaurants (lease terms, liquor licensing, health inspection history, food and labour costs), medical practices (insurance contracts, patient concentration, regulatory compliance), and so on across all industries a broker might encounter. The agent should also account for location-specific regulatory requirements (permits, licensing, compliance) that vary by province, state, or municipality. This is a core differentiator — brokers routinely miss industry-specific questions using standard templates. Cimple must not.
- **Broker stays in control of buyer outreach.** Cimple may suggest matched buyers, draft emails, and surface qualified leads, but the broker is always the one who reviews and clicks send. Never auto-send messages to buyers on the broker's behalf. The reminder pipeline (which emails buyers from Cimple directly) is the explicit exception — those are buyer-facing platform emails, not broker outreach.
- **Positive match framing for buyers (non-negotiable).** Matches shown to buyers must use raw criteria-matched counts and dimension chips ("3 criteria matched · Industry · Financials"). Never letter grades, never percentages, never ranks. A buyer with one match should not feel discouraged — they should see the strength they have, not the gap they don't.

---

## Security requirements

- Only pre-approved emails can view a CIM (link cannot be forwarded to access)
- Password protection as secondary layer
- Watermark on all printed and electronically viewed versions (traceable by source)
- CIM links auto-expire after 30 days unless extended by broker
- Firmex-style confidentiality: electronic NDA, role/permission controls, stage-based access (initial review → LOI → due diligence)
- Blind/sanitized CIM auto-generated on finalization (all identifying info replaced with fictitious placeholders)
- Deal team management with role-based permissions per team type (broker/seller/buyer)

---

## Integrations (current and planned)

| Integration | Purpose | Status |
|---|---|---|
| Anthropic Claude API | All AI functionality | Live |
| Railway.app | Hosting + PostgreSQL | Live |
| GitHub | Version control | Live |
| Resend | Email notifications | Ready (needs RESEND_API_KEY) |
| Twilio | SMS notifications | Ready (needs TWILIO_ACCOUNT_SID, AUTH_TOKEN, PHONE_NUMBER) |
| Gmail | Seller communication sync | Infrastructure ready (needs OAuth secrets) |
| Outlook | Seller communication sync | Infrastructure ready (needs OAuth secrets) |
| CRM platforms (Salesforce, HubSpot) | Buyer matching, deal management | Schema ready, not implemented |
| Accounting systems | Financial data extraction | Planned |
| Valuation software / comps API | Opinion of Value | Stubbed (needs API keys) |
| Call recording (mobile/3rd party) | Transcript generation | Planned |

---

## Environment variables

| Variable | Purpose | Required |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string | Yes |
| `ANTHROPIC_API_KEY` | Claude API access | Yes |
| `SESSION_SECRET` | Express session encryption | Yes |
| `RESEND_API_KEY` | Email delivery via Resend | No (falls back to console) |
| `RESEND_FROM_EMAIL` | Sender address | No (defaults to notifications@cimple.app) |
| `TWILIO_ACCOUNT_SID` | SMS delivery via Twilio | No (falls back to console) |
| `TWILIO_AUTH_TOKEN` | Twilio auth | No |
| `TWILIO_PHONE_NUMBER` | SMS sender number | No |
| `APP_URL` | Base URL for notification links | No (defaults to Railway URL) |

---

## What not to touch without explicit instruction

- The Drizzle schema migrations — always check before modifying existing tables
- The Railway deployment config (Nixpacks settings)
- The session-based auth system — do not replace without explicit approval
- The buyer tokenized access system — security-sensitive
- The notification routing config (`NOTIFICATION_ROUTING` in shared/schema.ts) — changes affect who gets notified

---

## Definition of done

A feature is not done until:
- It works end-to-end in the Railway production environment
- It does not break any existing broker, seller, or buyer flows
- The AI behavior matches the quality standard described in this file (for interview features: feels like a skilled advisor, not a form)
- The founder has reviewed and approved the output
