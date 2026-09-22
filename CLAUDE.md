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
| Auth | Session-based (brokers: username/password via `/api/broker-auth/*` + `requireBroker` middleware with per-broker data scoping; buyers via `/api/buyer-auth/*`), token-based (sellers, tokenized buyer view rooms). SESSION_SECRET is mandatory in production. |

**Live URLs:** App: https://app.cimple.ca (also https://cimple-production.up.railway.app). Marketing landing: cimple.ca / www.cimple.ca, served by host-based middleware in `server/index.ts` from `server/landing/` (`index.html` = v3; `v1.html`/`v2.html` kept at `/landing/v1`, `/landing/v2` for comparison, at the founder's request).

**GitHub workflow:** Work happens on branch `claude/zen-gauss` (worktree `.claude/worktrees/zen-gauss`). Do NOT use the old `tmp-main` shortcut (it pushed to GitHub from inside the worktree and left the founder's local `main` 45 commits behind). Railway auto-deploys from `main`; confirm with the GitHub commit status (`api.github.com/repos/aimlast/cimple/commits/<sha>/status`) and a behavioural check that the new code is serving. **Ship without asking (founder, reconfirmed 2026-09-21):** edit in the worktree; after verifying (tsc + build + tests), commit, then in the local folder (`/Users/ik/Documents/GitHub/cimple`) `git pull --ff-only`, merge `claude/zen-gauss` into main, push, and confirm the Railway deploy. Keep the local folder current on every ship.

**Railway build/deploy (`railway.toml`):** `buildCommand = "npm install --include=dev && npm run build"` — `--include=dev` is required since Railway's 2026-08-18 build-image change (otherwise `vite: not found`). `startCommand = "npm run db:push && npm run start"`; `drizzle.config.ts` has `tablesFilter: ["!user_sessions"]` so `db:push` never tries to drop the runtime-owned session table (that prompt crashed deploys). SIGTERM handler closes all connections and exits within 2s so redeploys don't trigger false "Deploy Crashed" emails; a crash email that coincides with a deploy is usually that, a standalone one is real.

---

## What is already built

### Hardening pass (2026-07-08) — read this first
- **Broker auth + multi-tenancy**: every broker endpoint requires a session and scopes by `session.brokerId`; deal ownership is checked on read/write/delete. There is no dev/demo escape: the former `/api/dev/*` role-switcher endpoints and the auto-login were removed (2026-08-21). Every broker, including the shared demo account, signs in with a username and password; the demo account is isolated by the same per-broker scoping as any other.
- **View room integrity**: NDA is enforced server-side (sections withheld until signed when `deal.ndaRequired`); buyers receive a whitelisted deal payload (never `extractedInfo`/notes); teaser/full access levels serve the Blind CIM with auto-generation of redaction overrides on first view; new links expire in 30 days; `firstViewedAt`/`viewCount` are stamped on every view (drives the decision panel + day-3/6/8 reminder pipeline).
- **CIM layout engine is two-phase**: a manifest call plans sections, then each section generates in parallel batches with a shared cached prefix — immune to the old 16K-token truncation. Failures degrade to editable placeholders and surface in `document.warnings` + the broker toast.
- **Interview upgrades**: industry knowledge is sliced per deal + prompt-cached (~12K tokens vs ~62K); completion is governed (min-turn floor, critical-section coverage, seller stop always wins); malformed output recovers gracefully; intake answers seed extractedInfo (never re-ask); `whyItMatters` buyer-rationale per question; Enter-to-send UI with edit-previous-answer.
- **Document storage**: uploads live under `UPLOADS_DIR` (Railway volume `/data/uploads`) and survive redeploys; `/uploads/docs/*` requires the owning broker session or the deal's seller token.
- **Removed** (2026-07-08): the legacy "New CIM" flow (NewCIM/CIMQuestionnaire/CIMDocuments/BrokerReview/CIMPreview + `cims`-table UI), mock Templates page, dead root-level duplicate seller pages, and the components/examples folder. Deal creation is a single flow (`/broker/new-deal`).
- **Settings persist** per broker user (`users.settings` jsonb via `/api/broker-auth/settings`); Support page is honest and in the sidebar.

### Beta-prep work (2026-07-14 → 2026-08-22) — read this second
Goal throughout: get a few real brokerages into beta. Everything below is merged to `main` and live (last merge `2f3b764`, 2026-08-22).

**Platform / ops hardening**
- Sessions stored in Postgres (`connect-pg-simple`, table `user_sessions`) with an explicit `pg.Pool` + `.on("error")` handler — the missing handler caused ~4-hourly production crashes when Railway dropped idle connections.
- Broker password lifecycle: login, "Forgot password?" (username field → emailed single-use 1-hour token → `/broker/reset-password/:token`, always-200 so accounts can't be enumerated), change-password dialog in Settings, logout button in the sidebar.
- **Dev role switcher and passwordless demo entry removed entirely (2026-08-22)** at the founder's request — everyone signs in with a password. `ENABLE_DEV_SWITCHER` is inert. Separate accounts exist for the founder, a guest/demo broker (seeded showcase deal "TrueNorth HVAC", blind codename "Project Coastal"), and `qa_interview` (automated interview QA). Multi-tenancy isolates them, so guests can't touch the founder's data.
- Rate limits (`express-rate-limit`: auth 20/15min, AI endpoints 60/5min per IP), `helmet` headers (CSP off for the SPA), Sentry wired but gated on `SENTRY_DSN`, unknown `/api/*` paths return JSON 404.
- Security sweep: ownership check (`requireOwnedDeal` / `getOwnedDeal`) on every broker deal route; chatbot, analytics batch and published Q&A require a valid view-room token; interview + seller-document endpoints require the seller token (`canAccessDeal`: owning broker session OR matching `X-Seller-Token`); buyer search scoped to the broker's own contacts/deals; integrations API never returns access tokens to the browser. Cross-tenant probe passed 21/21.
- Email is live: Resend configured for `cimple.ca`, sender `notifications@cimple.ca`, `APP_URL` = app.cimple.ca.
- Legal drafts in `legal/` (privacy policy — PIPEDA; terms — Ontario law; pilot agreement template; security overview). All marked DRAFT with `[PLACEHOLDER]`s awaiting lawyer review. SOC 2 decision: not needed for a small beta; the security overview stands in until a customer's compliance team asks.

**Deal workflow**
- Overview tab is invite-first with per-step actor badges and undo; valuation is optional and un-markable; phase labels are consistent; "Continue to Content Creation" CTA appears once the interview is complete; Phase 4 publish flow is reachable.
- NDA supports both "send for e-signature" (`/nda/send`, public `/api/sign-nda/:token`) and "mark as signed".
- Seller invites actually email and track sent/accepted; broker "Preview seller view" doesn't stamp the invite accepted. Scraped data is viewable in a dialog. "Ongoing inputs" (docs, transcripts — paste or upload) available in every phase.
- Seller first visit plays a 5-screen "what a CIM is" intro once; "Replay introduction" on the seller progress page. Re-entering a finished interview shows a completion card ("Add more detail" / "Back to progress").
- Buyer access UI on the deal's Buyers tab: grant / copy link / extend / revoke.

**Data integrity (field provenance)**
- Every `extractedInfo` value records who asserted it; authority order is **seller in interview > intake questionnaire > document**. A transcript/document can never override the seller. Losing values are kept as alternates for the discrepancy engine. No newline-gluing of multi-source values; `revenueByYear` can't become garbage. Deleting a document removes the facts it contributed. Reprocess (`/documents/reprocess`) respects provenance and refuses to overwrite with a failed-extraction stub.
- Document extraction keys are canonicalised (`canonicalFieldName`) so coverage sees them.
- Discrepancy gate (open / seller_responded block) applies to content generation, layout generation, publish, approvals and phase advance, mirrored in the UI.

**Financial analysis (rebuilt 2026-07-17)**
- Uses ALL sources (financial docs in full, tax-doc keyword slices, extractedInfo, questionnaire) with a source-authority hierarchy; canonical UI shapes in `server/financial/shape.ts`; long Claude calls are streamed (non-streaming multi-minute calls timed out).
- Produces discrepancies (`source="financial_analysis"`); per item the broker chooses **ask the seller in the interview** (routed into the interview) or **resolve inline**, then finishes the analysis.

**CIM output**
- Blind CIM: persisted `deals.blindCodename`, section titles redacted, first viewer sees a "Preparing your confidential view" holding state (never raw content) while overrides generate; buyers receive only what the page renders (no AI layout notes, which had leaked owner names).
- CIM documents are theme-locked "paper" (`.cim-doc` scope: paper #FBF9F4, ink #201D18, brass #9E752E; Recharts explicit hex) — identical in dark and light app themes. Founder rule: CIMs must be beautiful AND extremely digestible.
- Broker-edited content renders in the CIM; pre-NDA outreach drafts are blind-safe (codename, industry, province, revenue/SDE bands, signed with the broker's real name).

**Interview (the crown jewel) — hardened through ~7 rounds + a 46-interview persona campaign**
- Streams token-by-token over SSE (`POST /api/interview/:dealId/message/stream`); streaming is display-only, the final message is authoritative.
- Tone rule (founder, 2026-08-22): **the reply IS the next question** — no recap of what the seller said, no praise ("buyers love that"), no grading. Only address the last answer when it needs clarification or conflicts with something. Enforced in prompts (conversation-rules rule 2, response-format, emotional-intelligence rule 6) and mechanically by `stripFillerPreamble` in `turn-guard.ts`.
- Mechanical guards backing the prompt rules: grounding guard (a dodged question records nothing — the most dangerous past failure was inventing "no customer >20%"), numeric-fidelity guard (numbers not actually said by the seller can't be "confirmed"; handles spelled numbers), doc-conflict reconcile (a spoken $2.3M vs P&L $1.82M is probed, document value survives), disclosure-persistence guard ("noted" must mean written), valuation/tax-figure guard (never gives valuations or tax advice), chip template-token filter.
- Never re-ask: an "ALREADY ANSWERED — DO NOT RE-ASK" block renders every known field with its source; the AI believes a seller who says "you already have it", apologises once, and never misrepresents its own prior questions.
- Durable deferral ledger (`deferral-ledger.ts`) persists across sessions for circle-backs; declined topics respected; retrieval instructions are addressed to the seller; offered documents become upload requests.
- Seller stop always wins: first stop → at most one closing question; second consecutive stop → server forces the end.
- Financial-core checkpoint by ~turn 8; no SDE/addback assertions (e.g. owner dividends are balance-sheet distributions, not addbacks); today's date in the dynamic prompt for relative dates.
- 14 industry sections in `prompts/industry-intelligence.md` now carry `## MANDATORY PROBES` checklists.
- Broker-private notes channel (`extractedInfo._brokerPrivateNotes`, shown on the Interview Review tab) for sensitive things that must not reach CIM fields (e.g. health details). `_`-prefixed keys are excluded from CIM/coverage consumers.
- Degraded path: if the Anthropic API fails (e.g. credits hit zero), the seller gets an honest message and what they said is recovered later.
- Opening message is ≤3 sentences.

**QA practice**: interview regressions are run as seller personas against the production build under the isolated `qa_interview` account (deals prefixed "QA REG —"); for big campaigns, run several local instances of the production build against the production DB to avoid the 60/5min rate limit. An E2E browser stress test (596 controls, 58 defects) and a 12-area app audit (100 defects) were run and all findings fixed.

**Design**: "Obsidian & Brass" — dark default (black/grey), light mode toggle in the sidebar footer, cream primaries, brass accent. The `--teal` CSS token keeps its name but holds brass. Black sidebar in both themes. Logos (mark + wordmark PNGs in `client/public/`) render cream, not green. Dashboard rebuilt (stat cells, funnel, single "Needs your attention" card, activity rail).

### Testing & safety rules (non-negotiable)
- **Never send email to anyone except aim.kitabi@gmail.com.** Test/demo people use unroutable `.invalid` addresses or no email. The SariKnotSari deal is a real business used for testing — never contact its real sellers; use aim.kitabi@gmail.com as seller email.
- Test buyers must end with a submitted decision so the day-3/6/8 reminder pipeline never emails them.
- Never write API keys, passwords or seller/buyer tokens into the repo (including this file).

### Core Platform
- Broker layout: collapsible icon sidebar with Deals, Buyers, Analytics, Integrations, Settings
- All broker pages under `/broker/*` namespace (see `ROUTES.md` for full route tree)
- Deal detail: `/deal/:id/:tab` with tabs for overview, buyers, qa, team, financials, interview-review (documents live inside the Overview tab, not as a separate tab)
- Seller routes: `/seller/:token` (intake), `/seller/:token/interview` (fullscreen), `/seller/:token/progress`, `/seller/:token/documents`, `/approve/:token`
- Buyer routes: `/buyer/login`, `/buyer/signup`, `/buyer/dashboard`, `/buyer/profile`, `/view/:token`, `/review/:token`. All render inside BuyerLayout with three modes: auth (centered card), nav (top bar), immersive (no chrome)
- Four-layout architecture: FullscreenLayout → SellerLayout → BuyerLayout → BrokerLayout (see `ROUTES.md`)
- Buyer View Room (tokenized access with NDA signing, analytics tracking, heat maps)
- 4-phase deal workflow: `phase1_info_collection` → `phase4_design_finalization`
- Branding settings: logo upload, company name, disclaimer, footer, white-label support
- Seller invite system (token-based onboarding)
- Analytics event tracking (page views, scroll depth, heat maps, time-on-page)
- RoleContext (`client/src/contexts/RoleContext.tsx`): holds current user role (`broker | seller | buyer`), set by layout components. No dealId/token — those come from `useParams()`
- DealContext (`client/src/contexts/DealContext.tsx`): provides deal data to DealShell tab components without prop drilling

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
- Shared Interview component (`client/src/components/shared/Interview.tsx`): mode="broker" (coverage panel, fields captured, "Return to Deal") vs mode="seller" (progress dots, no panel, auto-advance). CIMInterview and SellerInterview are thin wrappers.
- **Files:** `server/interview/` (session-manager, knowledge-base, system-prompt, response-schema, info-merger, prompts/, data/, config/), `client/src/components/shared/Interview.tsx`

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

**Design system ("Obsidian & Brass"):**
- Dark default (black/grey, sleek, "AI-style"), `.light` override for light mode
- Cream primaries (`42 26% 92%`), brass accent (the `--teal` token now holds brass: `38 42% 60%` dark / `38 55% 40%` light) — teal is no longer the brand color
- CIM documents are theme-locked paper (`.cim-doc`), never inverted
- Shadcn/ui + Radix UI components (45+ primitives)
- Tailwind CSS with custom HSL design tokens
- Fonts: Inter (UI), JetBrains Mono (technical content)
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

### Open to-dos (as of 2026-09-21)
- [x] Seller-email fallback for Q&A approvals (shipped 2026-09-22): when a deal has no seller team member, the Q&A panel calls `GET /api/deals/:id/qa-approval-routing` first and shows a confirmation dialog — confirm the invite address, with a default-on checkbox that adds that person to the seller team as Owner (`POST /members` with `notifyMember:false`), or go to the Team tab. No seller email at all → explicit "nobody will be notified" prompt.
- [ ] Offered, not yet answered: a "Preview the seller intro" button (broker Settings or the deal's seller panel) so the founder can replay the seller intro animation.
- [ ] Landing page: founder paused iteration ("I'll come back to it later"); v1/v2/v3 comparison feedback pending. Feedback so far: motion must be visible but calm, layouts varied (not just rectangles and boxes); buyer matching is the flagship message; the three CIM types are Blind / Normal / Due Diligence.
- [ ] **Founder's next-feature list (2026-09-21, in suggested build order):**
  1. CIM creation runs in the background — keep building after the broker leaves the page (currently fails if they navigate away), show a real progress bar (sections done / total, time estimate), notify on completion.
  2. Importance labels on CIM sections and interview questions (critical / important / nice-to-have), industry-dependent, visible to seller and broker.
  3. Information-quality rating — a CIM quality score based on how much is known about the business; show during/after the interview and after CIM generation to the broker (maybe seller).
  4. Editable CIM outline before the interview — broker sees the planned sections and adjusts them by telling the platform in plain language (AI restructures; no bulky manual section editor).
  5. Broker-led / joint interview mode — some sellers refuse to do it alone and some brokers insist on running it themselves. Options to design with the founder: shared screen on a video call where both see the questions; broker asks, seller answers by voice, audio is transcribed into the answers. Needs a design decision before building.
- [ ] Tier-2 beta backlog: versioned migrations replacing `db:push`, buyer view-link email verification, mini admin panel, invite-token revoke/rotate, demo-deal reset script.

### Founder-side actions outstanding
- [ ] Create `support@cimple.ca` (Support page points there).
- [ ] Enable Anthropic API auto-reload — credits hit zero during testing and interviews degraded.
- [ ] Lawyer review of `legal/` drafts (fill legal entity name, address).
- [ ] Optional: Sentry DSN, uptime monitor on `/api/health`, confirm Railway Postgres backups.
- [ ] Set own passwords on the demo accounts (temporary passwords were set during testing), and delete the inert `ENABLE_DEV_SWITCHER` Railway variable.
- [ ] Confirm GoDaddy DNS for www.cimple.ca → Railway and apex forwarding.

### Known issues
- `server/reminders/decision-reminders.ts` falls back to `notifications@cimple.app` while the rest of the app uses `@cimple.ca` — only matters if `RESEND_FROM_EMAIL` is unset.
- Four long-standing TypeScript errors are accepted as pre-existing (MemStorage interface in `server/storage.ts`, `App.tsx` forcedTheme, learning-loop/test-harness Set iteration). New code must add none.
- The founder's local `.env` Anthropic key has gone stale before (401s); refresh it from Railway when running locally.
- Background blind-CIM redaction takes ~30s+ on large deals; the first buyer sees the "preparing" state meanwhile (by design).
- The 60/5min AI rate limit is per IP — fine for real sellers, but a brokerage office sharing one IP running several interviews at once could hit it.

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

**Broker** — creates deals, invites sellers, manages deal teams, reviews content, approves CIM, manages buyers. All broker pages under `/broker/*`. See `ROUTES.md`.
**Seller** — invited to platform (token-based via `/seller/:token`), completes questionnaire, participates in AI interview, reviews draft, approves Q&A answers (via `/approve/:token`)
**Buyer** — receives tokenized CIM link (`/view/:token`), signs NDA, views in secure room, asks questions via chatbot, analytics tracked. Self-serve accounts at `/buyer/*`.

**Route architecture:** Three role-based namespaces (`/broker/*`, `/seller/*` + `/approve/*`, `/buyer/*` + `/view/*` + `/review/*`). Deal routes at `/deal/*` are broker-facing but unambiguous without a prefix. Four layout wrappers set RoleContext: FullscreenLayout (interviews, standalone approvals), SellerLayout, BuyerLayout, BrokerLayout. Full route tree documented in `ROUTES.md`.

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
| Resend | Email notifications | Live (cimple.ca domain) |
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
| `SESSION_SECRET` | Express session encryption | Yes (hard-fail in production if missing) |
| `UPLOADS_DIR` | Persistent uploads root (Railway volume `/data/uploads`) | Prod yes (falls back to `public/uploads`) |
| `RESEND_API_KEY` | Email delivery via Resend | Set in production (falls back to console) |
| `RESEND_FROM_EMAIL` | Sender address | No (defaults to notifications@cimple.ca) |
| `SENTRY_DSN` | Error monitoring | No (Sentry off when unset) |
| `REMINDER_CRON_SECRET` | Protects the reminder-cron endpoint | No |
| `TWILIO_ACCOUNT_SID` | SMS delivery via Twilio | No (falls back to console) |
| `TWILIO_AUTH_TOKEN` | Twilio auth | No |
| `TWILIO_PHONE_NUMBER` | SMS sender number | No |
| `APP_URL` | Base URL for notification links | Set to https://app.cimple.ca in production |

---

## Backups & recovery (where everything lives if the computer is lost)

| Thing | Lives in | Notes |
|---|---|---|
| Code | GitHub `aimlast/cimple`, branch `main` | Every push is a full copy. Do not sync the code folder via Google Drive (corrupts git). |
| Production secrets + database | Railway | Never on the Mac. Turn on Railway Postgres backups (founder to-do). |
| Product decisions, to-dos, known issues | this file | Source of truth — keep it updated on every ship. |
| Claude Code transcripts + memory files | Founder's Mac at `~/.claude/projects/-Users-ik-Documents-GitHub-cimple*/` (memory: `…/-Users-ik-Documents-GitHub-cimple/memory/`) | **Not in the cloud by default.** Backed up nightly (3:00 am) to Google Drive: `My Drive / Cimple Backups / claude-sessions/` (README.md there has restore steps). |

**Backup mechanism:** `~/.claude/backup-cimple-sessions.sh` (rsync of the two `~/.claude/projects/…cimple…` folders into the Drive folder, writes `LAST-BACKUP.txt`) run by launchd job `~/Library/LaunchAgents/com.cimple.claude-backup.plist` (daily 03:00, log `~/.claude/logs/cimple-backup.log`). Run by hand: `~/.claude/backup-cimple-sessions.sh`. Set up 2026-09-21.

**Restore on a new Mac:** clone the repo with GitHub Desktop to `~/Documents/GitHub/cimple` (same path — Claude's project folder names derive from it), install Google Drive, copy both `projects/…` folders from the Drive backup into `~/.claude/projects/`, then re-create the backup script + launchd job above. GitHub access needs a new fine-grained token (Contents read/write on `cimple` only), stored in the macOS keychain — never pasted into the remote URL or into this repo.

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
