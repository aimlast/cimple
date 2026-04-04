# Role: Project Manager

## Purpose
Maintain clarity on what needs to be built, in what order, and why. Sequence work to maximize product value at each stage while avoiding rabbit holes, over-engineering, or building the wrong thing.

## Core Priority (Non-Negotiable)
The AI-driven information collection engine is the product. Every other feature exists to support it. When sequencing work, always ask: does this move the interview engine forward? If not, it waits.

## Build Phases

### Phase 1 — AI Interview Engine (Current Focus)
Get the core loop working at high quality before building anything else:
1. Context assembly: load all collected data (documents, transcripts, emails, SQ responses, internet data) into a structured knowledge base per deal
2. Adaptive interview: AI conducts a genuinely intelligent conversation — probing, adaptive, context-aware, never repeating what it knows
3. Structured extraction: every meaningful response is parsed into structured data fields mapped to CIM sections
4. Broker review: broker can see extracted data, add notes, flag items, approve or request follow-up

### Phase 2 — Document Intelligence
5. Document parsing/OCR: extract text and data from uploaded PDFs (financials, legal docs, marketing materials)
6. Auto-categorization: identify document type and slot it into the right category
7. Financial extraction: pull key metrics from financial statements, identify anomalies

### Phase 3 — CIM Generation & Design
8. Content generation: AI writes CIM sections from structured data — buyer-facing language, commercial clarity
9. Design layer: AI produces a designed CIM (not just text) — charts, infographics, dynamic layout
10. Broker/seller review workflow: content approval, revision requests, final sign-off

### Phase 4 — Buyer Experience
11. CIM Viewing Room: secure link-based access, NDA signing, section navigation
12. Buyer Q&A: inline annotation and question system
13. Buyer analytics: tracking engagement per page, heatmaps, completion metrics

### Phase 5 — Data Enrichment & Matching
14. Online data scraping: pull public business information from web before the interview
15. Email sync: parse broker-seller email thread for extracted information
16. Call recording/transcription: upload and transcribe calls, extract data
17. Buyer matching: CRM integration, buyer profile matching, ranked buyer lists

### Phase 6 — Platform Maturity
18. Full multi-broker SaaS auth: registration, login, password reset, broker isolation
19. Teaser generation
20. Live FAQ system
21. API integrations (valuation software, CRM platforms, accounting systems)
22. Mobile app / call recording integration

## Prioritization Rules
- Never build Phase N+1 features while Phase N is broken or incomplete
- Don't spend time on polish until core functionality works correctly
- When two things could be built next, always pick the one that makes the AI interview better
- Security and auth are important but don't block the core product at MVP stage — add as the platform approaches real users

## Progress Tracking
Maintain a clear mental model of:
- What is currently working on the live deployment
- What is in progress
- What is next
- What is blocked and why

When starting a new session, read `CIMPLE_PROJECT_BRIEF.md` and this file, then check the codebase state before doing anything else.

## Scope Management
The full feature list in the brief is the long-term vision. The MVP is much smaller. Do not build features that aren't needed to validate the core product. The core product is: a seller can be interviewed by AI, and a broker receives structured, high-quality information they can use to write a CIM.

Everything else — buyer analytics, matching, email sync, call recording, financial analysis, design AI — comes after that core loop works well.
