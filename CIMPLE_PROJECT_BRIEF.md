# CIMPLE — Project Brief
*This file is the source of truth for all product context. Read this at the start of every session.*

---

## Who Built This & Why

**Founder background**: Works in business brokerage and M&A, specifically on sell-side transactions. A major part of the work is creating CIMs (Confidential Information Memorandums) — the documents used to present a business for sale to qualified buyers.

**The problem experienced firsthand**: The hardest part of creating a strong CIM is not the writing. It is getting the right information out of the seller. Sellers hand over information in fragments — intake forms, emails, calls, Zoom interviews, financial statements, websites, scattered notes. Even cooperative sellers explain things vaguely, leave out key facts, don't know what buyers care about, and can't frame their own business effectively. This forces brokers to manually extract, interpret, organize, and rewrite everything. That process is slow, inconsistent, and skill-dependent.

**What triggered the idea**: After repeatedly building personal systems to solve this (intake documents, content guides, structured interview approaches, rewriting frameworks), it became clear that brokers don't just need better templates or writing tools — they need a system that collects the right information intelligently, the way an experienced broker would.

**Why Replit was abandoned**: A Replit prototype was built first but was unacceptable. The AI interview used the ChatGPT API but was not intelligent — it felt like filling in text boxes, not a real interview. Many buttons didn't work. The CIM generation was not truly integrated (no dynamic design, no infographics, no charts, just paragraph text). The overall quality was too low and the product wasn't heading in the right direction. Moved to Claude/Cowork for a complete rebuild.

---

## What Cimple Is

Cimple is an AI-powered platform that helps brokers and M&A advisors create CIMs by solving the hardest part of the workflow first: **extracting clear, structured, high-quality information from sellers**.

It is not a writing assistant, a template generator, or a form builder.

It is an intelligent dynamic system that:
- Interacts directly with sellers
- Asks smart, relevant, adaptive questions
- Probes deeper when answers are weak or vague
- Explains why information is needed
- Explains to sellers how to obtain the information if they don't know the information
- Identifies and fills gaps in information
- Structures messy input into usable business data
- Generates polished CIM content from that structured data

**Core insight**: Writing CIMs will be commoditized by AI. Collecting high-quality, structured business information will not. Cimple is built to own that layer.

---

## The Three USPs (In Priority Order)

### USP 1 — Intelligent Information Collection (Most Important)
This is the entire product. Everything else supports it.

The information collection includes:
- Phone/video call recordings, transcripts, and extracted data uploaded by the broker
- Emails synced or uploaded from the broker-seller communication thread
- All documents uploaded by broker or seller (financials, legal, marketing, operations, etc.)
- Public internet data scraped from the business's online presence (website, social, etc.)
- Seller questionnaire responses

All of this becomes the knowledge base. The AI uses this pre-loaded context to:
- Start the seller interview already knowing what it knows
- Verify and confirm known information
- Identify and probe gaps
- Know when to push deeper vs. when to move on vs. when to circle back and try again in a different manner
- Explain to seller why information is needed
- Explain to sellers how to obtain the information step by step if they don't know the information
- Understand what buyers, banks, and other advisors will care about

The interview must feel like a skilled business advisor is helping the seller articulate their business clearly — not a form, not a rigid chatbot, not a questionnaire.

**Why this is defensible**: The most important information about a business doesn't exist online or in structured documents. It exists in the seller's knowledge, employees, undocumented operational realities, and nuanced context. Generic AI tools can rewrite and summarize — but they can't replicate a structured, adaptive information extraction system that builds a complete business profile from scratch.

### USP 2 — Intelligent CIM Design
Even great information fails if presented poorly. The design component is critical.

The AI designs the CIM (not just writes it) based on:
- Broker brand guidelines and selected aesthetics
- Best practices for buyer readability and engagement
- Section-appropriate formatting decisions (when to use charts, infographics, tables, callouts, images vs. paragraphs)

The output must be modern, dynamic, and digestible — not walls of paragraph text. The system breaks content intelligently using headings, subheadings, bold/underline hierarchy, bullet structure, charts, graphs, and infographics. The backend guides the AI on which content types should be visual and how.

White-labeling capability: brokers can apply their own brand identity. This is the second most important feature.

### USP 3 — Buyer Analytics, Buyer Matching, and CIM Data
Three related components that are strategically significant:

**Buyer Analytics**: Tracks how buyers interact with the CIM inside the platform's viewing room — login timestamps, time per page, sections viewed, scroll/attention heatmaps, completion rates. This data helps brokers gauge buyer interest and helps the platform continuously improve how CIMs are written and structured based on what content actually drives engagement.

**Buyer Matching**:
- *Broker-side*: Because the platform connects to the broker's CRM, after a CIM is created, the platform matches the new listing against the broker's existing buyer database and the buyers' subsequent buyer profiles. Buyers are ranked (A+, A, B-, or 5 stars, 4 stars, or another grading system) based on how many criteria they match. Brokers immediately know who to call or email first. The platform can gather those buyer lists and send out the CIM through the CRM API or in the platform itself.
- *Market-side*: Buyers can create a buyer profile on the Cimple platform and pay to get matched to live listings that are also ranked based on fit to the buyer. Because Cimple has deep structured data from every CIM it's built, the matching is far more precise than what's publicly available on listing sites (which only show industry, revenue, and SDE/EBITDA). Brokers prioritize these matched, pre-vetted buyers.

**CIM Data / Industry Database** (not for public marketing): The structured data Cimple accumulates across all deals can eventually be sold to data companies (Valusource, IBISWorld, etc.). Legalities/consent framework TBD, but it's a long-term monetization layer.

---

## Industry Context

CIMs are used in business brokerage and lower middle market M&A to present a business for sale to qualified buyers. They explain what the business does, how it generates revenue, who its customers are, what makes it attractive, what risks and opportunities exist, and whether it's worth acquiring.

Despite their importance, CIM creation is still largely manual: questionnaires, calls, follow-ups, email exchanges, manual document review, and rewriting everything from scratch. This leads to inconsistent output quality across the industry.

**Critical hidden problem**: Key information is often discovered too late — after an LOI is signed, during due diligence. Because initial data collection is weak, material facts are missed, risks aren't surfaced early, and buyers uncover deal-breaking issues late. This causes deals to retrade or collapse.

Examples of commonly missed details:
- Licensing and regulatory requirements (e.g., AGCO licensing for cannabis businesses)
- Working capital requirements
- Key clauses in service or customer contracts
- Lease terms, assignments, landlord restrictions
- Operational dependencies or hidden risks
- There are many more than what is listed above

**Better upfront data collection directly leads to**: higher closing rates, faster time to market, better buyer qualification, improved financing outcomes, smoother legal prep, and reduced seller deal fatigue.

**Long-term strategic position**: Cimple is not just improving efficiency — it is redefining how information is collected and standardized across the M&A process. The goal is for Cimple to become the standard system brokers use to prepare businesses for sale, and the standard format buyers expect to review.

---

## Full Platform Features

### 1. Call Handling
Records calls, transcribes them, and organizes extracted information. Provides broker with templates for what to collect at each stage (initial call, pre-intake, etc.). Mobile app or third-party integration for recording phone calls.

### 2. Email Synchronization
Syncs with email platforms. Inputs seller's email to track all communication. Parses and extracts information from emails.

### 3. Seller Questionnaire & NDA
Sends the SQ (and possibly NDA) to the seller along with the required document list as an electronic form. Platform parses completed form for data.

### 4. Document Upload & Categorization
Documents uploaded by broker or seller into categorized sections (financials, legal/minutebook, marketing, operations, other). Platform continuously updates its knowledge base from uploaded documents. Automatically identifies and categorizes uncategorized documents (identify → verify with uploader → categorize). Additional documents can be added at any time and are incorporated immediately.

### 5. Financial Analysis & Valuation Intake
- Financial statement reclassification (P&L, Balance Sheet, Cash Flow, AR Aging)
- Manual input from broker/seller for context on financials
- Generates valuation intake form containing: normalization exercise chart, clarifying questions for red flags, trend analysis, items needing clarification
- Sends valuation intake to seller, broker, or valuation team
- Pulls comps via API for preliminary Opinion of Value

### 6. Financial Insights
Analyzes completed valuation intake, notes, and uploaded documents. Creates financial insights (positive and negative) for use in CIM sections (SWOT, Growth Opportunities, Financial Notes). Calculates working capital. Supports forecasts, projections, financial ratios, and benchmarking against comparable companies by industry and size.

### 7. Online Data Collection
Pulls online data provided in SQ (website, social media, etc.). Sends seller email requesting other digital locations. Scrubs public internet for business information. All collected info is validated with seller during the AI interview, with inconsistencies flagged and clarified.

### 8. Seller Onboarding to Platform
Seller is invited to join and contribute information. Before the AI interview, seller completes a manual information collection phase providing: accounting software, CRM/ERP/POS/payment systems, other operational platforms, and a complete employee chart (all employees/contractors + roles). This baseline allows the AI to understand business context upfront and provide precise instructions on how to retrieve needed information.

### 9. AI Chatbox Interview — MOST IMPORTANT FEATURE
Conducts an AI-driven conversational interview using all previously collected data, already mapped to CIM sections in the backend.

- Knows the required CIM information based on industry, business type, and location (licensing, permits, compliance)
- Confirms known information and collects what's missing through natural conversation
- If seller can't answer: restates the question differently, revisits it later, explains why it matters to buyers/banks/DD, uses operational baseline info to help seller locate answers (e.g., how to pull reports from their accounting system, which employee to ask)
- Knows which documents have been uploaded, which are outstanding, which have been promised — avoids asking for already-provided docs, re-confirms timelines, sends reminders when deadlines lapse
- Flags any information it cannot obtain after multiple attempts; broker receives notification, full interview summary, flagged items, and conversation context; broker can authorize skips or required follow-ups
- After the interview: AI sends seller a dynamic post-interview to-do list (items promised but not yet provided, broker-marked follow-ups) — this replaces manual offline requirements tracking and updates in real time
- Dictation feature: sellers can answer by voice instead of typing

### 10. Additional Data Collection
After the chatbox, AI collects supplementary data better captured through structured fields (customer concentration, revenue splits, flowchart inputs). If collected during interview, automatically generates charts, flowcharts, and infographics.

### 11. Final Content Review
AI compiles a content-only draft CIM for broker and seller review. Final check for consistency, flow, readability, and conciseness. Quality over quantity — content should drive engagement.

### 12. CIM Design — SECOND MOST IMPORTANT FEATURE
After content approval, broker initiates the design phase.

- AI designs the CIM based on brand guidelines, broker-selected aesthetics, and best practices for readability and buyer engagement
- White-label capability using other companies' brand/identity guides
- Breaks content into clear sections using headings, subheadings, bold/underline hierarchy, numbered lists, bullets
- Integrates charts, graphs, infographics, and images as appropriate per section
- Backend logic guides AI on which content types should be visual and what format to use
- Broker may choose from multiple design templates aligned with brand identity

### 13. Design Review
Broker and seller review the designed CIM.

### 14. CIM Finalization
Upon approval, CIM is finalized and uploaded to the platform's CIM Viewing Room.

### 15. CIM Viewing Room & Export — THIRD MOST IMPORTANT FEATURE
- CIM viewable inside the platform's secure viewing room
- Buyers can highlight sections, text, or images and ask questions (similar to Word comments); broker/seller notified by email; AI pre-populates answers to repeat questions from previous buyer interactions
- Export as file (TBD — may restrict exports to maintain link-based access and analytics tracking)
- Firmex-style confidentiality: buyer invitations with electronic NDA, role/permission controls, download restrictions (blocked or watermarked), stage-based permissions (initial review vs. LOI vs. due diligence)
- Automatically generates blind/sanitized CIM versions with all identifying information replaced by placeholder details for a fictitious company
- Advanced buyer analytics: which buyers viewed, login timestamps, time per page, heatmaps (scroll and attention behavior), sections skipped, read completion metrics
- Analytics dashboard helps brokers measure buyer interest and helps platform improve CIM writing over time
- Stores all CIM content and analytics in a growing internal database

### 16. API Integrations
Connects with valuation software, CRM platforms, accounting systems, deal rooms, and business intelligence/comps platforms. Can scan deal-room documents to extract and verify details.

### 17. Industry Database
Stores accumulated industry and business information. Potential future monetization: sell data to companies like Valusource, IBISWorld, etc. (legalities and consent framework TBD).

### 18. Teaser Creation
Generates business teasers using basic business information. Created and sent alongside the draft CIM.

### 19. Live FAQ Section
After the deal goes live, as buyers ask similar questions, the advisor can create a live FAQ that supplements the CIM for an efficient initial buyer experience.

### 20. Security
- Only pre-approved emails can view the CIM — link cannot be shared
- Password protection as additional layer
- Watermark on printed and electronically viewed versions (so leaks are traceable by source)
- CIM link auto-disables after 1 month unless extended by broker

### 21. Buyer Matching
Platform connects to broker's CRM to match the new listing against existing buyers. Buyers are ranked (A+, A, B, etc.) based on criteria match. Broker sees this immediately after CIM creation.

Market-facing: buyers can create a buyer profile on Cimple's website and pay to get matched to live listings. Matching is based on deep CIM data, not just the surface-level information on public listing sites (industry, revenue, SDE/EBITDA). Free tier tells buyers how many matches exist; paid tier reveals the listings.

---

## User Process / Action Flow

### Phase 1 — Info Collection (Pre-Platform)
1. Call with seller
2. NDA / Filled SQ / preliminary documents provided
3. Any follow-up calls for more documents
4. Valuation calls (valuation made from docs)
5. Present price
6. Send engagement letter

### Phase 2 — Info Collection (Platform-Driven)
1. Use all information from Phase 1 as knowledge base
2. Scrub internet for existing public information about the business
3. SQ / interview for CBO/CIM information
4. Ask for all outstanding / missing documents
5. Bring seller into the platform to add remaining information
6. Conduct the AI interview to extract CIM details
7. Broker reviews draft
8. Seller gets sent draft + next steps

### Phase 3 — Copy/Data for CIM
1. AI writes copy
2. Broker reviews copy
3. Seller reviews copy

### Phase 4 — Design
1. AI designs
2. Broker reviews

### Phase 5 — Buyer Analytics & Matching
(As described under USP 3 above)

---

## CIM Document Format

Based on the CIM format:
- **Cover Page**: Logo + "CONFIDENTIAL BUSINESS OVERVIEW" + business name + broker name
- **Confidentiality & Disclaimer Page**: Customizable legal text
- **Executive Summary Snapshot**: Key metrics grid (Industry, Location, Employees, Revenue, etc.)
- **Table of Contents**: Numbered sections with subsections
- **Company Overview Group**: Company Overview, History & Milestones, Unique Selling Propositions, Sources of Revenue, Growth Strategies, SWOT, Competitive Analysis, Industry Overview, Target Market, Permits & Licenses, Seasonality, Location & Site, Employee Overview
- **Transaction Overview**: Deal structure, training, reason for sale, assets, non-compete
- **Financial Overview**: Balance sheet, income statement, SDE/EBITDA normalization info
- **Data Visualizations**: Charts and graphs
- **Contact Us**: Broker information

CIM section keys (camelCase): `executiveSummary`, `companyOverview`, `historyMilestones`, `uniqueSellingPropositions`, `sourcesOfRevenue`, `growthStrategies`, `targetMarket`, `permitsLicenses`, `seasonality`, `locationSite`, `employeeOverview`, `transactionOverview`, `financialOverview`

**Important**: This is subject to change based on the specific business. The AI should be intelligent enough to know when new sections should be created and how detailed/long/how many sections a CIM should have given the business in question.

---

## Current Technical State

**Live URL**: `https://cimple-production.up.railway.app`

**Stack**:
- Frontend: React + TypeScript + Vite
- Backend: Express.js (ESM, compiled via esbuild)
- Database: PostgreSQL via Railway + Drizzle ORM
- AI: Anthropic Claude API (`claude-sonnet-4-5`)
- Deployment: Railway.app (Nixpacks, `NIXPACKS_NODE_VERSION=20`)
- Auth: Session-based

**What's built** (in the current deployed codebase):
- Broker layout with sidebar (Dashboard, Deals, Analytics, Templates, Settings, Support)
- Seller routes (Progress, Chat, Documents)
- Buyer View Room (tokenized access)
- 4-phase deal workflow in database schema (`phase1_info_collection` → `phase4_design_finalization`)
- AI interview system (15-question sequence covering all CIM sections)
- CIM section generation via Claude API
- Branding settings (logo upload, company name, disclaimer, footer)
- Seller invite system
- Analytics event tracking
- Full Drizzle schema: users, deals, documents, tasks, interviewSessions, cimSections, sellerInvites, buyerAccess, analyticsEvents, faqItems, brandingSettings

**Design system**:
- Dark mode primary (near-black background, cream/light text)
- Linear/Notion-inspired aesthetic
- Shadcn/ui + Radix UI components
- Tailwind CSS with custom HSL design tokens
- Inter (UI) + JetBrains Mono (technical content)
- Professional blue primary brand color

**Known issues / what needs work**:
- Current AI interview is not intelligent enough — needs to be fully rebuilt as an adaptive, context-aware system
- No call recording/transcription yet
- No email sync yet
- No document parsing/OCR yet
- No financial analysis module yet
- No internet scraping yet
- No buyer analytics / heatmaps yet
- No buyer matching yet
- CIM design output is text-only — no intelligent design, charts, infographics, or dynamic layout

---

## Product Vision

Cimple's goal is to become the standard platform brokers use to prepare businesses for sale and the standard format buyers expect to review. The competitive advantage is not in the writing — it is in the depth, quality, and structure of the information collected before any writing begins.

The platform must feel to sellers like: *"A smart advisor is helping me articulate my business clearly."*

It must feel to brokers like: *"I received everything I needed, organized exactly how I need it."*

---

## How Claude Should Operate

### Execution Mode
Claude operates as an autonomous AI product team. It is responsible for writing and executing code, managing the full build process, designing product/UX/system architecture, and iterating continuously. The founder is non-technical and will not guide implementation decisions.

### When to Proceed vs. When to Ask

Proceed without asking when:
- Implementing standard features
- Making technical decisions
- Fixing bugs
- Iterating on working components

Ask for approval only when:
- Choosing between multiple product directions
- Making UX decisions that significantly impact user experience
- Deciding what to prioritize next
- Tradeoffs involve: simplicity vs. power, automation vs. control, or speed vs. quality

Never:
- Ask technical questions the founder wouldn't understand
- Block progress waiting for input on implementation details

When asking, always: present clear A/B options, recommend one, and default to the recommendation if no response is given.

### Roles Claude Operates In
Claude switches between these roles as needed throughout the build process. Detailed role guides are in `/roles/`:

- **AI SaaS Architect** — system design, scalability, data architecture
- **Full-Stack Developer** — writing, debugging, and deploying all code
- **AI/LLM Systems Designer** — prompt engineering, interview logic, extraction systems
- **UX/UI Designer** — interface design, user flows, component decisions
- **Project Manager** — prioritization, build sequencing, progress tracking
- **QA Tester (Broker POV)** — testing from the broker's perspective
- **Seller Simulator (End User POV)** — testing the seller interview experience

### Build Loop
1. Plan next feature
2. Implement
3. Test functionality
4. Fix issues
5. Improve UX
6. Move forward

---

## Key Decisions & Constraints (Read Before Building)

- **Non-technical founder**: Do not ask technical questions. Present A/B options with a recommendation when decisions are needed. Default to the recommendation if no response.
- **Quality over speed**: The AI interview must be genuinely intelligent — adaptive, probing, context-aware. Do not ship a form masquerading as a conversation.
- **Design is a product feature**: CIM output must be visually compelling and digestible with charts, infographics, dynamic layouts — not walls of text.
- **Export strategy TBD**: Whether to allow CIM file export vs. link-only viewing is an open decision (link-only preserves analytics tracking).
- **AI model**: Currently using `claude-sonnet-4-5` — should be updated to latest available model for production.
- **GitHub workflow**: Use GitHub Desktop for bulk file pushes. Use browser GitHub Contents API only for small, targeted single-file changes.
