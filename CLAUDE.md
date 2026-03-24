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
| Deployment | Railway.app (Nixpacks, NIXPACKS_NODE_VERSION=20) |
| Auth | Session-based |

**Live URL:** https://cimple-production.up.railway.app

**GitHub workflow:** Use GitHub Desktop for bulk pushes. Use the GitHub Contents API (browser) only for small single-file changes.

---

## What is already built

- Broker layout: sidebar with Dashboard, Deals, Analytics, Templates, Settings, Support
- Seller routes: Progress, Chat, Documents
- Buyer View Room (tokenized access)
- 4-phase deal workflow in DB schema: `phase1_info_collection` → `phase4_design_finalization`
- AI interview system (15-question sequence — **needs full rebuild**)
- CIM section generation via Claude API (**text-only, needs design rebuild**)
- Branding settings: logo upload, company name, disclaimer, footer
- Seller invite system
- Analytics event tracking
- Drizzle schema: `users`, `deals`, `documents`, `tasks`, `interviewSessions`, `cimSections`, `sellerInvites`, `buyerAccess`, `analyticsEvents`, `faqItems`, `brandingSettings`

**Design system:**
- Dark mode primary (near-black background, cream/light text)
- Linear/Notion-inspired aesthetic
- Shadcn/ui + Radix UI components
- Tailwind CSS with custom HSL design tokens
- Fonts: Inter (UI), JetBrains Mono (technical content)
- Primary brand color: professional blue

---

## What is NOT built yet (known gaps)

- [ ] AI interview intelligence — current version is not adaptive, needs full rebuild
- [ ] Call recording and transcription
- [ ] Email sync
- [ ] Document parsing / OCR
- [ ] Financial analysis module
- [ ] Internet scraping (public business data)
- [ ] Buyer analytics / heatmaps
- [ ] Buyer matching
- [ ] CIM design output — currently text-only, no charts, infographics, or dynamic layout

---

## Agent architecture

Cimple uses a multi-agent system. Each agent has a distinct role and system prompt. A manager layer in the interview system orchestrates between them.

### Agent 1 — Interview agent (most important)
**Role:** Conducts the seller interview. Adaptive, context-aware, probing.

**Behavior:**
- Starts with full knowledge of everything already collected (docs, emails, SQ, calls, internet data)
- Confirms known information rather than re-asking for it
- Identifies gaps and probes them conversationally
- If seller can't answer: rephrases, revisits later, explains why the information matters to buyers/banks/DD
- Uses the seller's operational baseline (accounting system, CRM, employee list) to give specific retrieval instructions
- Knows which documents are uploaded, outstanding, or promised — never asks for already-provided materials
- Flags unresolvable gaps to the broker with full context
- After interview: generates a dynamic to-do list for the seller

**Voice/tone:** Feels like a skilled business advisor helping the seller articulate their business — not a form, not a rigid chatbot.

**Do not ship** any version of this agent that feels like filling in text boxes.

### Agent 2 — Knowledge base agent
**Role:** Ingests all inputs and builds the structured business profile used by all other agents.

**Inputs:** Call transcripts, emails, seller questionnaire, uploaded documents, internet scrape data
**Output:** Structured JSON knowledge base mapped to CIM sections
**Behavior:** Continuously updates as new documents are added. Identifies conflicts and flags them. Categorizes uncategorized documents (identify → verify with uploader → categorize).

### Agent 3 — Financial analysis agent
**Role:** Handles all financial processing.

**Tasks:**
- Reclassifies P&L, Balance Sheet, Cash Flow, AR Aging
- Runs normalization exercise (SDE/EBITDA)
- Generates clarifying questions for red flags and anomalies
- Calculates working capital
- Pulls comps via API for preliminary Opinion of Value
- Produces financial insights (positive and negative) for CIM sections

### Agent 4 — CIM design agent
**Role:** Transforms approved content into a visually compelling CIM.

**Behavior:**
- Applies broker brand guidelines and selected aesthetic templates
- Makes section-level decisions: when to use charts vs tables vs paragraphs vs infographics
- White-label capable (applies other companies' brand identity)
- Output must be modern and dynamic — not walls of paragraph text
- Backend logic guides which content types should be visual and what format to use

---

## CIM document structure

**Section keys (camelCase):**
`executiveSummary`, `companyOverview`, `historyMilestones`, `uniqueSellingPropositions`, `sourcesOfRevenue`, `growthStrategies`, `targetMarket`, `permitsLicenses`, `seasonality`, `locationSite`, `employeeOverview`, `transactionOverview`, `financialOverview`

**Note:** The AI should be intelligent enough to add or remove sections based on the specific business. These keys are defaults, not a rigid template.

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

---

## User roles and flows

**Broker** — creates deals, invites sellers, reviews content, approves CIM, manages buyers
**Seller** — invited to platform, completes questionnaire, participates in AI interview, reviews draft
**Buyer** — receives tokenized CIM link with NDA, views in secure room, analytics tracked

**5-phase deal workflow:**
1. Info collection (pre-platform): calls, NDA, SQ, docs, valuation
2. Info collection (platform-driven): internet scrape, seller onboarding, AI interview
3. Copy/data: AI writes, broker reviews, seller reviews
4. Design: AI designs, broker reviews
5. Buyer analytics & matching: CIM goes live, buyers tracked, matching runs

---

## Build priority order

**1 — Rebuild the AI interview (most important)**
The current 15-question sequence is not intelligent enough. It needs to be replaced with a fully adaptive, context-aware system. This is the entire product.

**2 — Document parsing and knowledge base**
Nothing else works well without structured input. OCR, PDF parsing, email extraction all feed the knowledge base agent.

**3 — CIM design output**
Must produce visually dynamic output: charts, infographics, dynamic section layouts. Text-only output is not acceptable as a final state.

**4 — Call recording / transcription**
Mobile app or third-party integration. Transcripts feed directly into the knowledge base.

**5 — Financial analysis module**
Reclassification, normalization, comps pull, working capital calculation.

**6 — Buyer analytics and matching**
Heatmaps, time-per-page, buyer scoring, CRM integration.

---

## Key product rules (non-negotiable)

- **The interview must feel like a conversation with a skilled advisor**, not a form. If it feels like filling in text boxes, it is not ready.
- **CIM output must be visually compelling.** Charts, infographics, dynamic layouts. Text-only is a prototype, not a product.
- **Never re-ask for information already provided.** The knowledge base agent must be consulted before every interview question.
- **Design is a product feature**, not a skin. The CIM design agent must make intelligent layout decisions per section.
- **The AI model for the interview agent is `claude-opus-4-5`.** Do not downgrade this for the interview. Use `claude-sonnet-4-5` for supporting tasks.
- **Export strategy is TBD.** Do not build PDF export until this decision is made. Default to link-based viewing (preserves analytics).

---

## Security requirements

- Only pre-approved emails can view a CIM (link cannot be forwarded to access)
- Password protection as secondary layer
- Watermark on all printed and electronically viewed versions (traceable by source)
- CIM links auto-expire after 30 days unless extended by broker
- Firmex-style confidentiality: electronic NDA, role/permission controls, stage-based access (initial review → LOI → due diligence)
- Blind/sanitized CIM auto-generated on finalization (all identifying info replaced with fictitious placeholders)

---

## Integrations (current and planned)

| Integration | Purpose | Status |
|---|---|---|
| Anthropic Claude API | All AI functionality | Live |
| Railway.app | Hosting + PostgreSQL | Live |
| GitHub | Version control | Live |
| Email platforms | Seller communication sync | Planned |
| CRM platforms | Buyer matching, deal management | Planned |
| Accounting systems | Financial data extraction | Planned |
| Valuation software / comps API | Opinion of Value | Planned |
| Call recording (mobile/3rd party) | Transcript generation | Planned |

---

## What not to touch without explicit instruction

- The Drizzle schema migrations — always check before modifying existing tables
- The Railway deployment config (Nixpacks settings)
- The session-based auth system — do not replace without explicit approval
- The buyer tokenized access system — security-sensitive

---

## Definition of done

A feature is not done until:
- It works end-to-end in the Railway production environment
- It does not break any existing broker, seller, or buyer flows
- The AI behavior matches the quality standard described in this file (for interview features: feels like a skilled advisor, not a form)
- The founder has reviewed and approved the output
