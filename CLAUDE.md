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

**Railway build/deploy (`railway.toml`):** `buildCommand = "npm install --include=dev && npm run build"` — `--include=dev` is required since Railway's 2026-08-18 build-image change (otherwise `vite: not found`). `startCommand = "npm run db:push && NODE_ENV=production exec node dist/index.js"` — the `exec` is load-bearing: started via `npm run start`, the container-wide SIGTERM on redeploy killed the wrapper shell/npm (exit 143) and Railway emailed "Deployment crashed" on every deploy (diagnosed 2026-09-23 from Railway logs: `npm error signal SIGTERM`); `drizzle.config.ts` has `tablesFilter: ["!user_sessions"]` so `db:push` never tries to drop the runtime-owned session table (that prompt crashed deploys). SIGTERM handler closes all connections and exits within 2s. **`db:push` is guarded (2026-10-09):** `npm run db:push` = `scripts/safe-db-push.cjs` — it simulates drizzle-kit push read-only first, pushes only purely additive changes (new tables/indexes, nullable or defaulted columns), and otherwise SKIPS with a loud warning so the app still starts (a plain push would silently drop, or crash asking about, tables that unmerged branches added for testing); it shares a Postgres lock with the scratchpad `additive-ddl` tool; `npm run db:push:raw` = plain `drizzle-kit push`; `SAFE_DB_PUSH_STRICT=1` makes a failed check fail the start. **Railway CLI** is installed at `~/.npm-global/bin/railway`, logged in as the founder and linked (project luminous-caring / service cimple / production) — use `railway logs [--deployment <full-id>]`, `railway deployment list --json`, `railway variables --json` (never print values), `railway run <cmd>` to diagnose instead of guessing.

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

**QA practice**: a dedicated broker account `qa_cimgen` (email-less; credentials in `~/.claude/cimple-qa-broker.txt` on the founder's Mac, never in the repo) owns the deal "QA CIMGEN — Harbourline Dental" (74 extracted fields, interview flagged complete) for UI testing of CIM generation; run the app locally via `.claude/launch.json` ("Cimple Dev Server", port 5080, loads the local folder's `.env`; it `cd`s into the worktree first — launching from the main folder makes the `@shared/*` path alias resolve to the main folder's stale `shared/schema.ts` while relative imports come from the worktree, which silently drops new columns). Interview regressions are run as seller personas against the production build under the isolated `qa_interview` account (deals prefixed "QA REG —"); for big campaigns, run several local instances of the production build against the production DB to avoid the 60/5min rate limit. An E2E browser stress test (596 controls, 58 defects) and a 12-area app audit (100 defects) were run and all findings fixed.

**Design**: "Obsidian & Brass" — dark default (black/grey), light mode toggle in the sidebar footer, cream primaries, brass accent. The `--teal` CSS token keeps its name but holds brass. Black sidebar in both themes. The brand is the icon OR the wordmark, never both (2026-10): `CimpleMark` / `CimpleWordmark` (`client/src/components/brand/CimpleLogo.tsx`) — collapsed sidebar = icon; open sidebar, phone bar and every page = wordmark; favicons = icon; landing pages = wordmark only; `tests/unit/brand-lockup.test.ts` enforces it; `cimple-logo.png` removed; a missing static file is a plain 404 (`server/static-not-found.ts`). Dashboard rebuilt (stat cells, funnel, single "Needs your attention" card, activity rail).

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
- Deal Buyers tab = ONE pipeline (2026-09-28): four stages as tabs with live counts, one visible at a time, stage in the URL (`?stage=find|send|approval|have`): 1 Find new buyers (ExternalAcquirersPanel) → 2 Send it to next (SuggestedBuyersPanel; never shows buyers with access OR submitted for approval — `reachedBuyers(..., approvals)`) → 3 Waiting for approval (BuyerApprovalsPanel) → 4 Have the CIM (`client/src/components/deal/buyers/HaveCimStage.tsx`: Fit, decision, Reading — the reading tracker's status + page strip from `/api/deals/:id/engagement/buyers`, click-through to the Engagement tab — NDA & link, actions). Default stage: Have the CIM when live with buyers, else Send it to next. "Grant access" + "NDA terms" (dialog) sit at the top. Fit is automatic — `GET /api/deals/:id/buyer-fit` (`server/matching/access-fit.ts`, labels in `shared/buyer-fit.ts`) re-scores rule-based (never AI) whenever the buyer's profile criteria or the deal's facts changed (fingerprint in `match_breakdown._fit`), keeps an AI-inclusive score while fresh; the Fit dialog shows met/partly/unmet criteria and links to `/broker/buyers/:id` to edit criteria (or adds an unlisted buyer to the list first); "Check fit with AI" (`POST …/buyer-fit/:accessId/ai`, AI-rate-limited) is the only AI path. The old BuyerMatchingPanel / "Run Match" is gone (`POST /match-buyers` + `match-run.ts` remain, unused by the UI). Criteria typed on a deal's access row by that old editor (`buyer_access.buyer_criteria`; 24 broker_demo rows) are shown read-only in the Fit dialog; "Copy to their profile" (`POST …/buyer-fit/:accessId/copy-criteria`, `copyDealCriteriaToProfile`) gap-fills them into the broker's private overlay (never overwrites, never the buyer's own profile) — adding an unlisted buyer from the dialog brings them along. Lists refresh on stage change, window focus and every 30s (buyers + approvals); revoked buyers are listed (folded) under Have the CIM with "Give a new link"; the table shows at lg+ (cards below). The dashboard's "approve a buyer" row links to `?stage=approval`.
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
- **Reading analytics v2 (2026-09-29)**: the view room records exactly what each buyer was served (`cim_renditions`, `server/analytics/renditions.ts`) and a part-by-part reading tracker (`POST /api/view/:token/reading` → `buyer_visits` + `reading_rollups`, `server/analytics/reading-ingest.ts`; visits now count views, the GET only stamps firstViewedAt); broker side = the deal's Engagement tab (heat map on the served CIM, buyers to call first, journeys), Overview `BuyerPulseCard`, cross-deal call list (`server/engagement/*`, `server/routes/engagement*.ts`); regenerated sections continue their page history via `cim_sections.analytics_lineage` (`server/analytics/lineage.ts`, assigned in `persistDocument`). The four reading tables are in `DEAL_CHILD_TABLES` (deleted with the deal).
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

**Database schema (63 tables as of 2026-10; list below is the original 25 — see `shared/schema.ts`):**
`users`, `deals`, `documents`, `tasks`, `interviewSessions`, `cimSections`, `cimSectionOverrides`, `cims`, `engagementInsights`, `buyerQuestions`, `sellerInvites`, `buyerAccess`, `analyticsEvents`, `faqItems`, `brandingSettings`, `integrations`, `integrationEmails`, `dealKnowledgeSources`, `financialAnalyses`, `addbackVerifications`, `discrepancies`, `dealMembers`, `notifications`, `buyerApprovalRequests`, `buyerUsers`

---

## What is NOT built yet (known gaps)

- [ ] Call recording and transcription (mobile app or third-party integration)
- [ ] Email sync (OAuth infrastructure exists but no provider secrets configured)
- [ ] CRM integration (Salesforce, HubSpot — schema ready, implementation pending)
- [x] Proactive buyer-to-deal matching — **built** (`SuggestedBuyersPanel` on the deal's Buyers tab, `GET /api/deals/:dealId/suggested-buyers`): every buyer in the broker's contact list scored with the matching engine (`skipAI: true`, deterministic only) + composite qualified-lead score (tier, criteria matched, top dimensions, reasons); broker multi-selects → Sonnet drafts personalised outreach → broker edits and sends; already-contacted / already-has-access excluded. Buyer decisions (Interested / Not interested / Need more time) are captured in the view room and sync to the CRM, so no broker follow-up automation is needed. Remaining ideas (from the 2026-09-24 CIM-PRO competitor review): NDA form doubles as the buyer questionnaire (per buyer type: individual / strategic / financial) so every signed NDA builds a matchable buyer profile; optional AI "deeper check" on the top suggestions; external acquirer discovery.
- [ ] Comps API integration (stub exists, needs BizBuySell/DealStats API keys)
- [ ] UX iteration pass across all flows

### Open to-dos (refreshed 2026-09-29)
- [x] Seller-email fallback for Q&A approvals (shipped 2026-09-22): when a deal has no seller team member, the Q&A panel calls `GET /api/deals/:id/qa-approval-routing` first and shows a confirmation dialog — confirm the invite address, with a default-on checkbox that adds that person to the seller team as Owner (`POST /members` with `notifyMember:false`), or go to the Team tab. No seller email at all → explicit "nobody will be notified" prompt.
- [ ] Offered, not yet answered: a "Preview the seller intro" button (broker Settings or the deal's seller panel) so the founder can replay the seller intro animation.
- [ ] Landing page: founder paused iteration ("I'll come back to it later"); v1/v2/v3 comparison feedback pending. Feedback so far: motion must be visible but calm, layouts varied (not just rectangles and boxes); buyer matching is the flagship message; the three CIM types are Blind / Normal / Due Diligence.
- [ ] **Founder's next-feature list (2026-09-21, in suggested build order):**
  1. ~~CIM creation runs in the background~~ — **shipped 2026-09-22.** `server/cim/generation-jobs.ts`: `POST generate-content` / `generate-layout` return 202 at once and run as a server job (one per deal; 409 if already running); progress persisted on `deals.cimGeneration` (jsonb); `GET /api/deals/:id/cim-generation` (answers from memory while live) + `GET /api/broker/cim-generation`. Client: `useCimGeneration` hook (2s poll, invalidates CIM caches on finish), `CimGenerationProgress` (bar, sections done/total, ETA; compact variant in the Designer), `CimGenerationWatcher` in BrokerLayout (app-wide "CIM ready" toast with Open button). A server restart mid-run is reported as failed, never an endless spinner. Verified live: two real 17–20-section runs finished while the browser was on another page.
  2. ~~Importance labels on CIM sections and interview questions~~ — **shipped 2026-09-22.** Three levels (critical / important / helpful). Base ranking in `server/interview/data/section-importance.json`; `server/interview/section-importance.ts` re-ranks per deal for its industry with the supporting model (Sonnet, tool-forced JSON), stored on `deals.sectionImportance` (jsonb, keyed to the industry; base criticals are a floor — never demoted). Triggered in the background when the interview identifies the industry; `GET /api/deals/:id/section-importance` computes on demand. Coverage rows carry `importance` + `importanceReason`; the interview response schema has `importance` + `targetSection` per question (prompt block "Section priorities for this business" + conversation-rules "Priorities"); completion governance treats industry-critical sections like the base CRITICAL_SECTIONS. UI: chip beside "Why we ask this" ("Critical for buyers / Important / Helpful"), labels + "x/y critical sections have coverage" in the broker coverage panel. Not yet on the CIM Designer section list (layout keys ≠ interview section keys).
  3. ~~Information-quality rating~~ — **shipped 2026-09-22.** `shared/cim-readiness.ts` (pure, used by server and client): coverage weighted by section importance (critical 3 / important 2 / helpful 1; covered 1 / partial 0.5 / missing 0) → 0–100 score with label Thin (<35) / Developing / Solid (≥60) / Buyer-ready (≥85); a missing critical section caps the score at 79; top-5 gaps (critical first) + one-line summary. Surfaces: interview header badge + full card in the broker coverage panel (live per turn), Overview tab Phase 3 card (replaces the raw "N data fields" card; `GET /api/deals/:id/cim-readiness`), CIM Preview header badge, seller progress page (label + summary in the interview step; `/api/seller/:token/progress` returns `interview.readiness`), seller interview header shows the label next to the %.
  4. ~~Editable interview outline~~ — **shipped 2026-09-22.** `server/interview/outline.ts` + `deals.interviewOutline` (jsonb: customTopics with capture items, excludedSections, per-section emphasis notes, history). Broker types an instruction on the Overview tab's Phase 2 "Interview outline" card (`InterviewOutlineCard`); `POST …/interview-outline/propose` returns a reviewed proposal (Sonnet, tool-forced), `POST …/apply` saves it, `PATCH` handles direct remove/restore; base-critical sections can't be excluded (proposal lists the refusal). The interview agent gets a binding "BROKER'S INTERVIEW OUTLINE" block; excluded sections vanish from coverage, governance and readiness; custom topics are tracked via `coveredIndustryTopics`. Not yet fed into CIM generation as explicit sections.
  4b. **Industry data checklist in the outline — shipped 2026-09-23** (founder: "not just the sections but the specific data under each section — that's what differs by company type"). `server/interview/interview-plan.ts` turns the deal's industry playbook slice (`buildIndustryKnowledge`) into concrete data points per CIM section (Sonnet, tool-forced; ≤8 per section; `critical` from [CRITICAL]/MANDATORY PROBES; camelCase keys the interview records answers under), stored on `deals.interviewPlan` (keyed to the industry; built in the background from the interview and the outline GET, ~35s; failed builds retried at most hourly). Items already answered by facts on file get `answeredByKey` — proposed by the builder, then **individually verified in a strict second pass** (a false tick makes the interview skip a question), plus a numbers-need-digits guard. `coverageAdjustmentsForDeal()` feeds these + broker-added items − broker-removed items into `buildSectionCoverage` everywhere (interview prompt shows them as `key (label — CRITICAL)` with an instruction to record under that exact key; quality score; seller progress; outline). Outline card: "N data points · M on file", per-section expandable checklists with ✓/○, industry/critical/added tags and the fact on file; hover ✕ removes an item ("Not asking: … restore"); plain-language edits now support `addItems` / `removeItems` / `restoreItems` (asking price and annual revenue can't be removed). Dental QA deal: 32 industry items, 17 confirmed on file.
  5. **Broker-led / joint interview — decided 2026-09-22, in progress.** "Interview together" on the deal, two ways:
     - **In Cimple (suggested):** video call inside the interview page (Daily.co — video + transcription); broker sees the seller's video, the AI's next question + why-it-matters, and live coverage/quality; the seller's link opens a plain call. In-person mode = same screen on one laptop, no second participant.
     - **Zoom / Google Meet / Teams:** broker pastes the meeting link; a Cimple bot joins to transcribe (Recall.ai); the question panel pops into a small always-on-top, draggable window (Document Picture-in-Picture API — Chrome/Edge; fallback: compact separate window) so the broker never switches tabs.
     - In both: the AI extracts facts from the live transcript, updates coverage + readiness, queues the next question; broker can skip/rephrase/type notes. Founder's stated pain: old-school brokers won't juggle two platforms or remember to click "listen" — so no separate listen step. Vendor keys from the founder (accounts being created 2026-09-22): `DAILY_API_KEY` + `DAILY_DOMAIN` (Daily Video, not Pipecat Cloud), `RECALL_API_KEY` (Recall.ai, US region) — Railway env only. Founder decision: the bot **auto-joins** the external call when the broker clicks Start (named clearly, e.g. "Cimple Notetaker"), no manual admit. Build order: (1) mode + broker question panel + floating window + in-person mode (no keys) — **shipped 2026-09-22**: `/deal/:id/interview/together?via=person|zoom|meet|teams` (`TogetherInterview` page → shared `Interview mode="together"` → `AIConversationInterface variant="together"`); "Interview together" button + `TogetherSetupDialog` on the Overview Phase 2 card (Cimple-call option shown as coming soon); question card ("Ask the seller", why-it-matters, "Listen for" checklist), Capture answer (browser speech-to-text, interim), Skip question (sends a deferral message), Pop out = Document Picture-in-Picture (`client/src/lib/pip.ts`; Chrome/Edge only; failures toast; cannot be exercised in the embedded test browser — verify in real Chrome); server: `conductedBy: "broker_with_seller"` on start/stream → stored as session `_conductedBy` → `kb.conductedBy` → system-prompt "SESSION MODE: BROKER-LED" block (spoken one-sentence questions, transcription-tolerant extraction, broker-relayed skips are deferrals). (1b) **Hands-free + speaker-aware listening — shipped 2026-09-22/23**: `client/src/lib/live-transcription.ts` streams the mic to Deepgram live (`nova-3`, diarize) with a 15-min key minted by `POST /api/interview/:id/transcription-token` (`server/calls/deepgram.ts`; **the DEEPGRAM_API_KEY must have the Admin/Owner role** — a Member key gets 403 creating session keys); lines labelled by speaker, the broker = whoever reads the question aloud (echo match) or clicks a label; the exchange since the last question is sent after a 3s pause as "Broker: … / Seller: …" and the agent applies note-taker rules (seller agreement confirms a broker's statement; broker assertion with no seller response is never confirmed). Falls back to the browser's speech recognition (question-echo filter) when Deepgram isn't configured. (2) **In-Cimple call — shipped 2026-09-23 (needs live verification)**: `server/calls/daily.ts` (private room per deal, owner token for the broker, participant token for the seller; `deals.interviewCall` jsonb); `POST /api/interview/:id/call/start|end`, `GET /api/seller/:token/call`; broker's together page (`via=cimple`) uses Daily's headless call object (`client/src/lib/daily-call.ts`) with Cimple's own Meet/Zoom-style screen `client/src/components/call/CallStage.tsx` (`@daily-co/daily-react`; the other person full-bleed, your own tile picture-in-picture top-right, floating mic/camera/leave, name tags, initials when the camera is off, no prejoin card — replaced Daily Prebuilt 2026-09-24 after the founder objected to the "box inside a box" look; leaving keeps the room open and offers "Rejoin the call") and starts Daily transcription — lines arrive per participant (local = broker) and feed the same exchange pipeline; the seller joins at `/seller/:token/call` (auto-joins when the broker starts; "Join the call" banner on the seller progress page polls every 10s). Leaving the broker page ends the call and deletes the room. `GET /api/calls/status` gates the option in `TogetherSetupDialog`. **Exchange pipeline rules (2026-09-23, after the founder's first real call):** speech heard while the AI is still replying is HELD and sent after the reply (it used to be cleared then refused — lost); an exchange is sent 5s (was 3s) after the seller stops, and only once the seller has said ≥4 words; the question-echo filter applies to broker lines only; "Send now" under the live transcript forces it; Daily transcription uses nova-3 with nova-2 fallback. Testing tip: two devices in the same room double every line (each mic hears both people) — use headphones on one. (3) **Zoom/Meet/Teams notetaker — shipped 2026-09-23 (needs a live-call verification)**: `server/calls/recall.ts` creates a Recall.ai bot ("Cimple Notetaker", `recallai_streaming` low-latency, webhook realtime endpoint for `transcript.data` + participant join/leave) that auto-joins the pasted meeting link; `deals.interviewBot` jsonb; `POST /api/interview/:id/call/bot/start|stop`, `GET …/call/bot/lines?after=seq` (in-memory per-deal buffer, status refreshed from Recall while joining), public `POST /api/calls/recall/webhook/?token=…` (per-bot secret; token→deal map rebuilt from the DB after a restart). Broker screen (`via=zoom|meet|teams`): notetaker panel (paste link / status / "Send again"), lines polled every 2s and fed to the same labelled-exchange pipeline (broker = participant whose name matches the signed-in broker, else the host). Leaving the page makes the bot leave. `RECALL_API_KEY` + `RECALL_REGION=us-west-2` are set; the Recall auth header is tried as `Token` then `Bearer`.
- [x] **CRM buyer sync + NDA = buyer profile — shipped 2026-09-25** (founder: buyer profiles must fill themselves from the broker's CRM — asked for on 2026-04-09 — and "happy to make the NDA and buyer profile the same").
  - **Pipedrive → buyer profiles** (`server/crm/buyer-sync.ts`): Buyers page card (`CrmBuyerSyncCard`) → setup dialog "Which Pipedrive contacts are buyers?" (people on deals in chosen pipelines — recommended, buyer-ish pipelines pre-ticked / people with chosen labels / everyone) + "keep in sync" (6-hourly scheduler, `startBuyerSyncScheduler`). Per person: record, org, custom fields (names mapped from `/personFields`), notes, deals (= listings they enquired on) → Sonnet (tool-forced, batches of 5) extracts buyer type, background, liquid funds, proof of funds, industries, locations and `BUYER_CRITERIA_SECTIONS` criteria (+ `inferred` list). `GET/POST /api/integrations/pipedrive/buyer-sync` (202 background job, 409 if running; `?options=1` lists pipelines/labels). Unchanged records skipped via `crm_sync_key`. People without an email are skipped. **Privacy:** the extracted profile lives on the broker's own `broker_buyer_contacts.crm_profile` (+ `crm_provider/crm_record_id/crm_sync_key/crm_synced_at`), never on the global `buyer_users` row (the buyer sees that row; other brokers match on it); new `buyer_users` rows get contact basics only, `source='crm_imported'`, no password, **no email sent**. `mergeBuyerProfile()` (shared/schema) = buyer's own answers win, CRM fills gaps — used by the broker buyer list, buyer detail (shows a "From your Pipedrive · private to you" block with listings they asked about) and Suggested buyers. `PIPEDRIVE_API_BASE` env overrides the API host (tests use a local fake). HubSpot/Salesforce not yet.
  - **NDA = buyer profile** (`shared/nda-buyer-profile.ts`, `server/buyers/nda-profile.ts`, `client/src/components/buyer/NdaBuyerProfileGate.tsx`): the view-room NDA step first asks buyer type (individual / company-strategic / investor-financial) and a short type-specific form (background, what they want, price range, funding, proof of funds, timeline; individual: will you run it; strategic: fit; financial: investor kind, cheque size, platform/add-on), then the agreement. A returning buyer with a matchable profile on file just confirms ("Update my profile" to edit). `POST /api/view/:token/sign-nda` requires `{profile}` or `{confirmProfile:true}` (400 `profile_required` otherwise); answers go on the buyer's own profile + `buyer_access.nda_profile` (snapshot) and link the access to the buyer account + broker contact (`source='nda'`); the free-text "looking for" is turned into industries/locations/size ranges by Sonnet in the background. `GET /api/view/:token/buyer-profile` prefills (buyer-owned data only).
  - **Matching engine** (`server/matching/engine.ts`): `industryMatches` compares meaningful words across the deal's industry label + business type/name/description/summary, with parent families (a "Healthcare" buyer covers a dental practice; "home services" covers HVAC — but a specific HVAC buyer is not widened to plumbing); `locationMatches` understands province abbreviations, "Canada"/"US", GTA/Lower Mainland city lists and "southern/northern …" wording. A dental buyer from CRM notes went 2/4 → 4/4 on the dental QA deal.
  - **Blind CIM title leak fixed** (found while testing): titles were redacted with only `deal.businessName`, so a section titled with the company's full name ("Harbourline Dental Group") showed in the blind contents list. `shared/blind-identifiers.ts` (`blindIdentifiers` / `blindTitleRedactor`) now covers company/legal/trade/brand/DBA names, owner, website name, "X — Y" deal names and names minus Inc./Ltd./Group; used by the view room, the CIM Designer preview and the redaction engine's identifier list.
- [x] **BIG BATCH (founder, 2026-09-25) — shipped 2026-09-26** (built as 7 parallel workstreams + an adversarial 5-lens review, 43 confirmed findings fixed over 4 verified fix rounds). Items 2 (demo buyers) and 3 (deal clean-up + example deals) are the seeding step — see below.
  1. **Buyer profile page** `/broker/buyers/:buyerId` (`BuyerProfilePage`, `server/routes/buyer-profiles.ts`, `server/buyers/profile-*.ts`): every field with its source chip (buyer / NDA / CRM / CSV / you), fully editable via a broker-private overlay (`broker_buyer_contacts.broker_profile` + `_meta`; precedence broker overlay > buyer's own > CRM), all 49 criteria, tri-state proof of funds, activity timeline (access/views/sections/NDA/decisions/questions/outreach/approvals/edits; `buyer_access.access_events`), AI summary, interest tag, remove-from-list, "email this buyer" (broker sends; reply-to = broker; `buyer_emails` table). `buyer_users.field_sources` records who wrote each global field. Buyer list rows open the page.
  4. **Deal list** (`/broker/deals`, `GET /api/deals/list`, `shared/deal-progress.ts` = single source of phase labels + next step with owner): group/sort/filter/search, card or table, archive/restore (`deals.archived_at`; archived hidden from list + dashboard). `PATCH /api/deals/:id` now has a field allowlist and rejects backward phase moves unless `allowBackward`.
  5. **Information tab** (`InformationTab`, `server/routes/information.ts`, `server/information/*`): every fact by CIM section with its exact source (Provenance v2: kinds interview/call/video_call/questionnaire/email/document/crm/website/social/broker/system, ranks broker 7 > interview 6 > call/video 5 > questionnaire/email 4 > document 3 > crm 2 > website/social 1), edit/add/delete/restore/use-alternate, sources panel + "Add source" (paste/upload with kind, meta, visibility), website facts accept-into-facts, legacy facts traced to a source "(inferred)". `documents.source_kind/source_meta/visibility` ('broker_only' never reaches the seller or the interview). Ingestion in `server/documents/ingest.ts` (`createAndIngestSource`, `ingestDocument`), per-deal facts lock. The asking price is ONE value across the deal column and the fact (`server/information/deal-mirror.ts`).
  6. **CIM builder** (`CIMDesigner` + `client/src/components/cim-builder/*`, `server/routes/cim-builder.ts`, `shared/cim-layouts.ts` = the single layout registry): add (blank or AI-written) / delete / duplicate / drag-reorder / rename / change layout (AI convert) / AI rewrite with instructions + undo; per-section access tier (`cim_sections.access_tier` teaser|full; teaser buyers see full-tier sections as locked stubs); per-buyer access level select on the Buyers tab. Deal "CIM" tab (`CimTab`). **Blind safety is fail-closed**: `server/cim/blind-sync.ts` holds back any section whose blind version is stale or failed (per-section back-off, "Blind held back · Retry"), the redactor throws instead of falling back, and `shared/blind-guard.ts` (deterministic identity check; known identifiers always caught, conservative name heuristics, `tests/unit/blind-guard*.test.ts`) backs up every buyer path (`shared/cim-buyer-view.ts buildBuyerCim` is the only way sections reach buyers). Buyer Q&A is scoped (`buyer_questions.answer_scope`), chatbot respects the NDA gate, blind section keys are neutral.
  7–8. **Branding + templates** (`shared/cim-theme.ts`, `server/cim/templates.ts`, `server/routes/cim-templates.ts`, Settings → "Brand & templates"): 5 built-in templates (Classic Paper default, Modern Slate, Executive Navy, Minimal White, Bold Brand) + custom (`cim_templates`), brokerage brand (logo, colours/fonts gated by use-brand toggles, contact block, disclaimer + contact pages), per-deal template (`deals.design_template_id`) and business branding (`deals.business_branding`, never in Blind), "Match my existing CIM" (PDF → section outline the layout engine follows), print preview (broker side).
  9. **Media blocks**: location_map (Google Maps embed; blind = region only or hidden), video (YouTube/Vimeo/upload), image_gallery; `deal_media` table, private storage `<uploads>/private-media/` (never served statically), `GET /api/media/:id` gated (broker / buyer token / seller token; blind → blind-safe only).
  10. **CRM both sides**: seller side `server/crm/seller-import.ts` + `server/routes/crm-seller.ts` (link a deal to a Pipedrive deal/org/person, import fields/notes/activities/emails/files as broker-only sources; New Deal "Start from my CRM"; `deals.crm_link`, `deals.seller_contact`); buyer side CRM evidence per field. `server/crm/pipedrive.ts` honours `PIPEDRIVE_API_BASE` everywhere; fake: `scripts/fake-pipedrive.mjs`. Not yet tested on a real Pipedrive account.
  11. **Interview privacy**: the interview sees a seller-safe view (`server/interview/seller-view.ts`) — broker-only/CRM content, the broker's price and private EQ-profile categories never reach the prompt; learned patterns are de-identified; filler guard kept on question turns.
  Security fixes from the review: broker APIs never return raw `buyer_users` rows (reset tokens now stored hashed), tenancy checks on buyer ids, rate limits on the new AI endpoints.
  Tests: `tests/unit/*.test.ts`, `tests/information/*.test.ts`, `tests/crm/*` — run with `DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx <file>`. Local instances against the production DB must set `DISABLE_SCHEDULERS=1` (reminders/CRM sync off) and blank RESEND/TWILIO. `deals.demo_key` marks demo/QA deals — they're excluded from the industry-wide learning loops.
  Also from the CIM-PRO comparison, for the later one-by-one pass: simple per-deal automation switches (email the buyer a copy of the signed NDA, alert broker, manual vs automatic access approval, tier-upgrade notice); CIM access manager tabs (target list / NDA sent / NDA signed / has CIM / removed / denied); buyer-analytics map + days on market; AI listing advertisement/teaser writer + campaigns to target lists (broker sends); BizBuySell/listing-site enquiry → automatic NDA link; different NDA terms per buyer type; seller file room with preset folders; in-app help assistant + training videos; later: listing pipeline (Too small → Meeting → Proposal → Listed → Under offer → Sold), proposals/appraisals, contracts, data room.
- [x] **Demo data seeded (2026-09-26)** in the founder account `broker_demo`: kept real deals Amlin (+3 docs from its archived duplicate), SariKnotSari (new 30-section visual CIM; it had no old CIM), 180 Smoke Vape (blind "Project Meadow"); all 3 reprocessed with Provenance v2; 11 old deals ARCHIVED (restorable). 9 fictional example deals (all `deals.demo_key` set → excluded from industry learning) across stages: Maple & Main Café (phase 1, $185K), Northbeam Landscaping (docs in, $1.25M), Clearwater Physio (interview half-done, $2.4M), Ridgeline Metal (interview done, discrepancies open, $6.5M), Harborview MSP (CIM content awaiting review, $9M), Lakeshore Home Comfort (designed, Executive Navy + business branding, not live, $4.8M), Pacific Coast Logistics (LIVE, 13 buyers engaged, $18M), Beacon Pharmacy (LIVE + LOI buyer in due diligence, DD CIM, $3.2M), Great Lakes Plastics (US, interview done, CRM sources, $42M). 81 fictional buyers (.invalid emails; sources crm/nda/csv/manual/signup; CRM profiles with evidence; 8 broker overlays). Brand "Brassline Advisory Partners" (fictional), broker persona Morgan Ellis in the demo documents; users.name for broker_demo is still empty (CIM contact page shows no broker name). Content + generators: session scratchpad (seed/); fake documents all carry "Sample document — fictional business" footers. Demo deals were built as qa_cimgen then transferred (deals, media, outreach, contacts, field-source stamps).
- [x] **QA-harvest fix batch — shipped 2026-09-26** (the ~120 demo-seeding observations in `docs/qa/2026-09-26-demo-seeding-qa-harvest.md` → 67 issues; then a live verification of the merged build found 104 more, and a code review 13 more — all fixed; built as parallel streams in worktrees, independently checked, merged by intent). What changed, by area:
  - **Interview intent** (`server/interview/seller-intent.ts`): a Sonnet classifier reads each seller message IN PARALLEL with the Opus call (no added latency) → stop none/soft/firm, continue request, the seller's own question, retractions, corrections (old→new; the new value is kept), privacy requests ("keep that out of the book" → `_brokerPrivateNotes` + `_sellerKeepOut`, held out of CIM inputs and later turns; never deletes other facts). High-precision patterns in `turn-guard.ts` are the instant path/fallback; only an addressed/bare stop overrules the classifier; the model's endReason corroborates. First stop → at most one closing turn naming the most important gap; second stop ends. Date-fidelity guard (`fact-guards.ts`) never invents a year.
  - **Interview output**: filler guard cuts verdict clauses but keeps factual context; `normalisation-guard.ts` + `reply-guards.ts` stop SDE/add-back assertions; one question per turn; `question-rationale.ts` labels every question (whyItMatters + section); jurisdiction vocabulary (no W-2 for Canadian deals).
  - **Never re-ask**: `on-file-evidence.ts` (facts + document/transcript passages the agent is steered by), `reask-guard.ts` + `answer-check.ts` (hedged Sonnet check) before display, `live-claims.ts`/`claim-conflicts.ts` (seller figures checked against documents in the live turn), continuity across sessions, `task-writes.ts` (tasks deduped; undelivered document requests never closed).
  - **Interview privacy/UX**: broker-typed normalisation (recast SDE, add-backs) and settled private values are held from the seller view (`_heldByBroker`); stored source reviews/ledger re-filtered by current visibility; the reply is released only once approved (never shown then swapped); the seller can type while a turn saves (composer queue); openers stream progress.
  - **Facts** (`server/documents/merge-policy.ts`, `extraction-guard.ts`, `reprocess.ts`, `reprocess-jobs.ts`): founder decision A — document-authoritative fields (statement/balance-sheet lines, lease, registry, key people, owner salary, backlog, concentration) let a document outrank spoken/email/questionnaire values; specialist sources (org chart, WIP report, lease, statements vs tax returns) win for their facts; newer fiscal period wins; per-year provenance (`FieldSource.years[y]` = full source); headlines = latest full fiscal year (never YTD/ARR/interim); no computed metrics unless printed; placeholders dropped; broker-process info (referral, fees, prior approaches) → private notes; reprocess REPLACES a row's contribution (grounded-keep for printed values) and runs as a background job with progress. Material conflicts raise `source='merge'` discrepancies with a lifecycle (`merge-conflicts.ts`). Private notes consolidated by `private-notes-review.ts`.
  - **Discrepancies & analysis**: `factKey`/`factYear`/`sideSources` on every row; CIM generation runs the check first when stale (`generation-gate.ts`, `deals.discrepancy_checked_at`); deterministic backstop for like-for-like conflicts (`discrepancy-backstop.ts`); resolution writes headline + by-year consistently, proposes rewrites of stale narrative facts (`resolution-propagation.ts`), and reaches the writer as a RESOLVED block (`server/cim/resolved-block.ts`). Analysis: dividends are distributions (never add-backs), owner pay split into above-market add-back + market salary (broker overrides carried to both), peg = multi-period average, private-only add-backs need explicit broker approval.
  - **CIM truth**: `earnings-canon.ts` (one EBITDA/SDE across the CIM; a disagreeing bridge is withheld with a broker warning), `figure-check.ts` + `prose-check.ts` (every figure/rank/name traced; tables reconcile), `keep-out.ts` + `sensitive-facts.ts` (confidential/health items held with a warning), `fact-dates.ts` (no invented years; relative timelines anchored), `given-name-gender.ts`, `spoken-figures.ts`.
  - **Blind**: registry numbers (USDOT/NSC/BN/licences) and staff/customer/landlord names are identifiers; codename editable with validation (`codenames.ts`); guard fail-closed as before. Renderers: string chart values, waterfall labels, comparison-table overflow, org chart, scorecard, number wrapping.
  - **Misc**: tokens redacted from request logs (`server/log-redact.ts`); reminder emails use the blind codename for blind-access buyers; 'Need more time' never reverts a final decision; matching exclusions/NaN/AI scoring fixed; outside-buyer brief is blind and uses only non-private facts; research claims checked against cited text.
  - Tests: 82 files (`sh` over `tests/**/*.test.ts` with `DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx <file>`).
  - **Live acceptance test (2026-09-26, ~$35)**: facts/analysis/CIM/blind all passed (owner salary, backlog, headlines, peg, single EBITDA, 0 blind leaks over 66 identifiers, confidential RFP and health kept out); interview passed privacy, corrections, privacy requests and stop handling. **Round A (2026-09-26, offline fixes + a ~$15 live re-check) fixed:** the org-chart misread and most table/transcript re-asks (retention, licence roster, peg method), add-back lists to the seller + garbled guard rewrites (earnings/SDE questions now get an acknowledgement + broker hand-off; `server/interview/money-talk.ts`), the long unstreamed turns (worst case ~68s → ~25s; first text still ~10s median), the CIM Working Capital definition mismatch (cash-free/debt-free NWC vs the same-basis peg), cover "Prepared by", resume openers (fast, continuity), notes 35 → 27, analysis rows carry factKeys. **Still open:** occasional re-asks of figures on file (capex) and a rewrite that dropped the answer to the seller's own question; live-claims framing a shareholders'-agreement covenant as the sale non-compete; no retry when Opus is overloaded mid-turn (seller sees the degraded message); statement EBITDA printed with glued digits ("…income taxes1,398,000") is dropped by the extraction guard, so the headline comes from the call and the pre-generation check can raise a false conflict; a misread value survives re-reading via the grounded-keep rule; one false merge row (single-customer % vs top-3 %); private notes 27 (target ~15) with a few business facts; false figure-check warning on a correct multiple; location card renders a long lease-type as a badge; unsupported equipment figures can ship after a figure-check warning; financial-analysis notes that don't tie to their own table; one financial-extraction JSON parse failure; a long transcript's re-read can stall ~30 min on timeouts.
- **Security hotfix (2026-09-27)** — found by the free overnight code review: a broker could set a document's `fileUrl` (POST /api/deals/:dealId/documents, PATCH /api/documents/:id) and the re-read would read any server file (e.g. /proc/self/environ with the DB URL and API keys). Fixed: `server/documents/document-path.ts` (only `/uploads/docs/<name>`, confined to the docs folder; used by reprocess, ingest, cleanup) + `server/security/body-fields.ts` allowlists (documents, tasks, integrations — server-owned columns like fileUrl/dealId/brokerId/tokens are refused with 400); the unscoped legacy `/api/cims` routes removed. A read-only production check found every stored file path normal (no sign of use). Test: `tests/unit/security-hotfix.test.ts`.
- **Free overnight round + follow-ups (2026-09-27/28, $0 API; ~$4 live smoke test)** — a 6-area code-reading hunt (59 confirmed findings) + the 21 known leftovers, fixed offline and independently checked, then smoke-tested live. Highlights: buyer privacy (seller-approval emails and reminder emails blind-safe; the public seller-review link no longer returns the broker's Pipedrive record; unverified self-signups can't capture a buyer's access; buyers can't open unpublished CIMs; outreach replies go to the broker), the deal's broker now gets buyer-event emails (`server/notifications/service.ts`; demo deals never email), long sources read in parts instead of being cut at 60K characters (`extractor.ts`, part summaries combined, no fact ever dropped by the tidy-up), deleting a source can't resurrect or mis-promote facts, per-section approval before publishing (`shared/cim-approvals.ts`: any change to a shown section un-ticks it and withdraws the design approvals; publish needs every section approved; CIMs already live before 2026-09-29 count as approved), charts show stated totals (not renderer maths), failed sections never reach buyers, analysis matches conflicts by fiscal year and goes stale when documents change, broker-mode interview answers recorded as the broker's session notes (never the seller's), interview turns serialised per session, Cimple-call hang-up / short spoken answers / notetaker labels fixed, rate-limit split for call-control requests. Remaining low items: see the round reports in the session scratchpad. A real "Interview together" call test is still pending with the founder.
- **Security hotfix 2 (2026-09-29)** — found by the second free code review: the old documents check was mounted on the RAW path (`app.use("/uploads/docs")`) while the static server decodes/normalises, so `/uploads//docs/…`, `/uploads/%64ocs/…`, `/uploads/docs%2F…`, `./docs`, `x/../docs` served confidential documents with NO login (file names were guessable `doc_<ms timestamp>`). Fixed: `server/security/uploads-gate.ts` classifies every `/uploads` request on the decoded, posix-normalised path — documents go through the access check and are served by the gate (never static); private folders 404; only other files (logos) are public. New uploads get unguessable names (`newDocumentFileName` in `document-path.ts`, 128 random bits). Test: `tests/unit/uploads-gate.test.ts`.
- **Release 2026-09-29 — LIVE (main d002bfb, claude/zen-gauss 5b1f67c; $0 API — proved offline)** — what it adds:
  - **Review round 2** (second free code review, streams security / integrity / resilience / interview / cim / finance-facts / journeys): uploads gate, private buyer Q&A, one NDA signature, real deletes (`server/deals/delete-deal.ts` cascades `DEAL_CHILD_TABLES`; deleted deals take their files), email and bulk ceilings (`server/security/bulk-limits.ts`), broker session hygiene; AI outages never destroy work or lose buyer questions (fault notice + Continue, `shared/interview-fault.ts`); short breaks and returns read by the classifier ("take your time", `PAUSE_REPLY*` in `turn-guard.ts`); live CIMs serve only approved sections (`shared/cim-published.ts`); DD names/keep-out checks; equipment leases, add-back period, scaled figures; seller journeys (the seller's CIM review page `/seller/:token/review` — `server/routes/seller-review.ts`; follow-up window for routed questions — `server/interview/seller-followups.ts`; industry correction sticks; opt-out honoured).
  - **Buyers tab as one pipeline + automatic Fit** (see "Deal Buyers tab" under Core Platform).
  - **Staff-private keep-out** (`server/cim/staff-private.ts`, `held-private.ts`, `shared/staff-private.ts`): an employee's private matters (a stake ask, pay, possible departure, conduct, health/family, private talks) are held out of every CIM version by default, clause by clause, routed to the broker's notes upstream; CIM tab "Held back from the CIM" card with a per-item Include switch; sections still stating one are named.
  - **Live CIMs keep serving buyers during an update's review** (`server/cim/published-snapshot.ts`): regenerating a live CIM copies what buyers were served; every buyer path reads the kept copy until the broker publishes the update.
  - **Owner-pay attribution + earnings canon** (`server/financial/owner-pay-attribution.ts`, `normalization-rules.ts attributeOwnerPay`, `server/cim/earnings-canon.ts`): a several-shareholders pay line is cut to the selling owner's stated pay (or left for the broker to split — never added back whole); the broker's own/resolved adjusted EBITDA stands against a newer unreviewed analysis.
  - **Reading analytics v2 / Engagement tab** (see "Buyer Analytics"): heat map on the served CIM, who to call and why, buyer pulse, cross-deal call list.
  - **Security hotfix 2** (above).
  - **Final-review fixes (this release's last commit):** only the owner's seller link signs off the CIM or asks for changes — an accountant's/attorney's/representative's link reads only, and only the roles `qa_needs_approval` is routed to see buyer questions on the progress page (`shared/seller-link-rights.ts`); the CIM tab and builder flag a held staff matter buyers still read in the kept copy or a section's approved version, with "Hide from buyers" (`POST /api/deals/:id/cim-held-private/withdraw/:sectionId` for the kept copy); a stop is never turned into a "take your time" break (a break wins over the classifier's stop only when the message names it, or answers an offer of a break alone), and after a break the seller's return is never a second break; Continue after a fault is checked against the saved answer (no downgrade, no re-ask); a follow-up session can't end before the broker's routed questions are raised or deferred (the stop still wins); the owner/shareholders/management are never a held party name, and a held person's first name alone is matched only when nobody else on file shares it; "since 2015"-style pay is the current pay and an owner-pay line with no pay for the analysis years goes to the broker; revoked buyers are out of the call list and the pulse; the DD validator checks name–share pairings inside one `[[dd]]` span. Tests: `tests/unit/seller-link-rights.test.ts`, `held-private-served.test.ts`, `held-owner-name.test.ts`, `owner-pay-fail-closed.test.ts`, `engagement-revoked.test.ts`, `dd-span-pairing.test.ts`, `tests/interview/final-review-int-rc.test.ts`.
  - **Release-review follow-ups (release/candidate-2, $0 API — proved offline and on qa_cimgen clones):**
    - **Staff-private precision (F2-STAFF-5, `server/cim/staff-private.ts`):** a warning, reprimand or suspension issued by an authority (MTO/ministry/auditor/inspector/college/CRA/WSIB …) is the company's compliance history, never staff conduct; a customer's, supplier's or lender's person ("their buyer, Karen Holt", "Alderbrook's purchasing manager") and someone leaving ANOTHER organisation ("may leave Alderbrook") are not staff departures; customer/supplier facts (`customerConcentration` …) only hold a clause about a known staff member; a clause joined by "and"/"but" is cut at the join ("turnover is 18% a year and two drivers may leave" keeps the 18%); upstream routing (interview guard, document extraction — no Include switch there) moves a conduct matter to the private notes only when a named staff member is its subject (the CIM screen still holds the rest by default). Round 2 kept the recall: only a real authority clears a warning (a named external audit/inspection, a ministry, "the College of …"; never "after the (internal) audit", "the commission review", "at college"; after an authority's audit a named person's warning is still held), leaving a place is a departure (only a word the fact marks as another organisation counts), a customer fact holds anyone it marks as ours ("who manages the account for us", "held by Tom"), and "their pharmacist Daniel" is staff ("their" makes an outsider only with an outside role). Tests: `tests/unit/staff-private-precision.test.ts`, `staff-private-recall.test.ts`.
    - **Old-tracker reading survives regeneration (DEP-1, `server/engagement/legacy.ts`, `legacy-store.ts`):** every old section exit counts toward its visit; its page is placed at read time — the same key, the blind view's s_<id> key (also of the section a regeneration continued), the section continuing its lineage, else a renamed key's words (`matchLegacyKey`: key words 2, title words 1, same page role +1, a plainly different role −2; needs a telling word — Beacon's rebuilt CIM: 192/221 exits placed, was 66); reading on pages the current version doesn't have is reported on the Document view ("… of earlier reading was on pages this version doesn't show (History milestones …)"), never silently dropped. **A regeneration stores the old reading first** (`persistDocument` → `storeLegacyReading`, before the sections are replaced; idempotent, best-effort): rows keep the OLD key as page id + the lineage of the section read, so every later version finds its page; a visit already stored is never written again, so later stores (every regeneration, the backfill) can't double a blind-view page read under a since-renamed key (`unstoredRows`; test `engagement-legacy-store-idempotent.test.ts`) (clone proof: renamed + retitled pages all kept their reading; the one dropped page reported).
    - **Legacy backfill no longer blanks the Document view (DEP-2, `server/engagement/facts.ts`):** any legacy visit — stored or on the fly — draws on the CIM as served now when no version was stored (was: 0 pages after `--apply`); `scripts/backfill-legacy-reading.ts` now uses `legacy-store.ts` (dry run lists each old key → the page it lands on). Tests: `tests/unit/engagement-legacy-survives.test.ts`, `engagement-legacy-stored.test.ts`.
    - **Document requests already on file (DEP-3, `server/documents/requirements.ts`):** `planDocumentRequirements` credits a new request (backfill AND every interview opening / industry change) to the shared, readable document the deal already holds — the upload rule, uncategorised files included, a file already credited to another row allowed (Pacific's fleet list answers both) — so it starts "uploaded", never "missing". Matcher precision: "with/from/…" are no longer keywords, "practice/clinic/pharmacy/overview/profile" don't identify a document, printed e-mails ("… Mail - Re_ …") never count. Production dry run: 13 of 590 rows credited. Test: `tests/unit/doc-requirements-on-file.test.ts`.
    - **Questions routed before follow-up emails (DEP-4, `shared/discrepancy-gate.ts`):** every routing from this release on is stamped (`sideSources.routedAt`; the analysis and verification re-runs keep it); an UNSTAMPED routed row on a finished interview (TrueNorth's and SariKnotSari's "2024 Revenue", routed 2026-07-17) was never put to the seller, so it does not lock the CIM — the Overview and the discrepancy panel show it as "Never asked" with **Email the seller** (the broker's click only; `POST /api/deals/:id/discrepancies/email-seller-followups`; demo deals record, never email; stamps once someone was addressed — then a critical one locks until the seller answers) and **Resolve it yourself**. The lock message names the waiting rows; the seller's portal and the deal list count only stamped rows. Nothing is ever emailed automatically. Test: `tests/unit/followups-routed-before-release.test.ts`.
  - **Post-deploy (all optional, no AI; dry run first, in this order):**
    1. `scripts/backfill-industry-doc-requirements.ts` (dry run → review → `--apply`): adds the industry document requests older deals never got — dry run on 2026-09-29: 590 rows across 65 deals, 13 of them already on file (added as received, each listed as "already on file → … credited to …"), including broker_demo's Beacon, Pacific, Great Lakes, Harborview, Maple & Main, 180 Smoke Vape. Review the list first — it adds the industry's generic set, e.g. "Franchise Agreement" to non-franchises.
    2. `scripts/cleanup-orphaned-deal-data.ts` (rows left by deals deleted before the cascade — dry run: 753 rows, e.g. 109 documents, 115 buyer links; run `--apply` inside the Railway container so the files go too).
    3. `scripts/backfill-legacy-reading.ts --deal <id>` (dry run → `--apply --allow-real` for broker_demo deals): stores old-tracker reading permanently. Not needed for correctness (the tab reads it on the fly, and a regeneration now stores it first). **Done for Pacific on 2026-09-29** (370/370 exits placed, 31 visits stored) before its rebuild. Beacon was rebuilt before this release — its unplaced keys (history_milestones, where_we_operate, business_overview) are pages its new CIM doesn't have.
    No schema SQL: production already has every table and column (read-only comparison 2026-09-29).
  - **Needs a live check (costs AI):** the classifier's reading of a return after a break (`AFTER_PAUSE_NOTE`), and one real "take a few minutes, or stop here for today?" exchange.
  - **Demo CIM rebuild after the release (2026-09-29, $3.98 of the founder-approved ~$5; backups in `~/.claude/cimple-backups/demo-cim-{pacific,lakeshore}-before-rebuild-2026-09-29.json`):**
    - **Pacific:** financial analysis v3 (owner add-back $165K, adjusted EBITDA $3,936,200; v2's $4,222,200 was the owner-pay bug), new 30-section CIM + blind "Project Coastline" (30/30, 0 leaks at every access level). The CIM uses the broker's resolved $3,900,000 (4.6×); the analysis bridge is left out and no SDE is stated until the add-backs are reconciled on the Financials tab. Live buyers (13) keep the published copy until the founder approves and clicks "Publish update". Reading history kept: 26 of 29 served pages carry reading; 19 of the 30 new sections continue an old page's lineage. 13 broker warnings on the run (roadside-inspection counts that don't tie, 2022 net income not tying, 2023 debt figures, the RFP kept out as confidential, etc.) — real data-quality flags in the demo data for the founder to see.
    - **Lakeshore:** the one unapproved add-back ("Excess insurance (owner life insurance)", $9K, private evidence) was approved on the founder's behalf — it is in the demo's seed data — so the bridge ties to the resolved SDE $1,312,000 (adjusted EBITDA $1,202,000; 3.7× SDE / 4.0× EBITDA); the cover, key metrics, SDE waterfall and transaction-structure sections were regenerated (untick the add-back on the Financials tab to undo). Not live; no blind version yet.
    - **Beacon:** rebuilt earlier (2026-09-28); waiting for the founder to review, approve and publish (founder's choice A).
    - Cleanup: the buyers-pipeline checker's 8 test buyers (chkpipe-*@example.invalid, qa_cimgen) deleted; 174 clean leftover worktrees removed (branches kept).
- **October batch — LIVE 2026-10-10 (release/oct d133a67; built as 8 streams from specs in the session scratchpad `oct/`, each independently checked twice, then merged and reviewed; $0 API — proved offline)** — what it adds:
  - **Access levels**: Teaser · Blind CIM · Full CIM · Due diligence.
    - Stored keys: `teaser_only | blind | named | due_diligence`.
    - Legacy values stay readable: `teaser`/`full` → blind, `loi` → named.
    - `shared/access-levels.ts` is the only place levels are compared (`isTeaserOnly / seesCim / seesNamedCim / sameAccessLevel / cimModeForAccessLevel`). `access-level-literals.test.ts` fails the build on a level literal anywhere else.
    - Tidy-up: `scripts/migrate-access-levels.ts` (undo `rollback-access-levels.ts`). Per-section "Full access only" locks are retired.
  - **Teaser**: one `deal_teasers` row per deal, holding a draft and a published snapshot.
    - Templates: listing / one_page / two_page / investor, plus saved per broker (`teaser_templates`).
    - Written by Sonnet from the SERVED Blind CIM. Numbers come only from code, as bands (`shared/deal-bands.ts`).
    - Blind-guarded at save, publish and serve (fail closed per block). Publishing needs the confidentiality review or the broker's confirmation.
    - Teaser links are `teaser_only` access rows, served before every CIM gate (`server/teaser/serve.ts`).
    - "Ask for the CIM" flow: 6-digit email code (`buyer_link_email_checks`; skipped for demo deals and verified buyers) → profile + NDA → `buyer_approval_requests.source='teaser_request'` → Give access / Ask the seller first / Decline. Approval upgrades the same link in place.
    - Buyers tab pipeline: find · send · **teaser** · approval · have (`?stage=`). The CIM tab is a dashboard (`?view=attention|versions|teaser|numbers|design`).
  - **Heat map that always shows heat**:
    - Part tints, or a whole-page wash when only page totals exist (`DocumentPage.heat.basis`), plus a status line and a "Why?" popover.
    - Lineage v2 (`server/analytics/lineage.ts`): same key → same title → similar words → fixed layout. `scripts/repair-section-lineage.ts`.
    - Engagement draws on the version most buyers were given; each buyer's strip covers only their own version's pages.
    - Sample reading on the example deals (`scripts/seed-demo-reading.ts`, tag `demo-reading-v1`; columns `buyer_visits.demo_seed/superseded_by`, `cim_renditions.demo_seed`; `--remove` restores). Every reader of `buyer_visits` uses `cimVisitConditions`.
    - Acceptance check: `scripts/check-demo-heat.ts`.
  - **Analytics dashboards**: `/broker/analytics` and the deal's Engagement tab.
    - KPI strip (Needs you now / Buyers with a period control). Tabs: Who to call · Deals · Buyers · Activity · What buyers read most. State lives in the URL. Every number lists exactly who it counts.
    - One reader rule (`hasReadCim`, ≥ 3 s). Toronto dates. Server code in `server/analytics-dashboard/*`.
    - The old analytics endpoints are unused (remove next release).
  - **Interview together = live coverage board** (`/deal/:id/interview/together?via=person|cimple|zoom|meet|teams`, `?listen=0` = checklist mode, $0).
    - ONE coverage model: `shared/coverage-board.ts` + `server/interview/coverage-board.ts` + `client/src/components/coverage/*`. The board, the Overview, the AI-interview panel and the seller's view show the same numbers.
    - Sittings: `together_sittings/lines/chunks`, `coverage_marks`.
    - Live filing: chunker → Sonnet `file_answers` → capture guards → `mergeExtractionIntoDeal`, with undo. Costs ≈ $0.50/hour in production, capped at 400 calls per session. It never runs locally without the stub.
    - Phrasing pass: `askAs`, `whyItMatters`. The old question-by-question flow is gone. The legacy `call/bot/lines` and `together/leave` endpoints go next release.
  - **Data room (VDR)**, `/deal/:id/data-room`:
    - Broker side: preset folders, a sharing plan, nothing shared until the broker confirms.
    - Buyer side: `/view/:token/data-room` with a watermarked viewer (render child `dist/vdr/render-child.js`; health check `/api/vdr/health`).
    - One visibility rule: `shared/vdr.ts itemVisibility`. Broker-only, e-mail, call and CRM sources never enter the room. A document with an unticked needs-a-look flag is held. A tick given before preparation carries to the first prepared file (`VDR_TICK_BEFORE_PREPARED`).
    - Buyer teams (≤ 5). Every view is logged. Buyer descriptions: Sonnet, ≤ 60 per deal per day.
    - 10 `vdr_*` tables. `seller_document_request` routing sits behind `VDR_SELLER_DOCUMENT_REQUEST_KEY`, which is OFF.
    - Scripts: `vdr-local-fixtures.ts`, `seed-demo-data-room.ts`.
  - **Add-backs in the books (GL)**:
    - The seller uploads the ledger (CSV/XLSX: QBO, QBD, Xero, Sage, Wave, FreshBooks). It is read deterministically into `gl_transactions`.
    - Each approved add-back is traced to entries (proposed by rules, confirmed by the seller at `/seller/:token/books`), with a tie-out against the statements. The broker works in Financials › Add-backs in the books.
    - The DD CIM page `gl_evidence` ("Where each add-back is in the books"), masked at serve time. Owner pay shows the pay AND the part added back (pay less the market salary).
    - The gate `assertGlGate` holds only the DD CIM, unless the per-deal switch is set.
    - Tables `gl_ledgers`, `gl_transactions`, `gl_tracing`, `gl_addback_traces`, `gl_trace_links`. Notifications `seller_gl_request`/`gl_needs_broker` sit behind `GL_NOTIFICATION_ROUTING`, which is OFF.
    - Scripts: `seed-demo-gl.ts`, `read-legacy-ledgers.ts`, `report-legacy-addback-verifications.ts`.
  - **DD figure layer + notes on the CIM's numbers** ($0, deterministic; `server/cim/figures/*`):
    - The DD CIM shows CIM vs tax return / statements side by side. States: match ✓ / regrouped ✓ⓘ / explained / ask. Every figure cites its document, and the chip opens it in the data room. The page "How the figures check out" is the `dd_source_check` layout.
    - The Full and Blind CIMs get hover or tap "why" notes, with blind wording on the Blind CIM.
    - Nothing reaches buyers before the broker's "Review and show to buyers" (`POST /figures/publish`). "Fix first" holds a CIM figure that disagrees with its statements.
    - Seller questions live in `cim_figure_questions`. Auto-ask is on only for deals created after `AUTO_ASK_SINCE` / `FIGURES_AUTO_ASK_SINCE`.
    - The AI "why" pass: ≤ 4 per deal per day.
    - Tables `cim_figure_notes`, `dd_check_decisions`, `cim_figure_questions`, `cim_figure_state`. The broker works in CIM tab › Numbers & sources.
    - The DD reveal gating sits behind `DD_REVEAL_GATING=on` (off).
  - **Founder decisions applied (2026-10-09):** teaser always anonymous with money as ranges; buyer asks for the CIM from the teaser → 6-digit email code → broker chooses Blind/Full (optional per-deal auto Blind after NDA); Blind CIM buyers never get documents; DD differences reach buyers only after the broker's "Review and show to buyers"; the Full CIM gets "why" notes, not the tax-return comparison; GL = Excel/CSV only and only the DD CIM waits for it; links only — no file exports (Q8); new notification routing (Q21) shipped OFF behind `GL_NOTIFICATION_ROUTING` / `VDR_SELLER_DOCUMENT_REQUEST_KEY` until the founder says yes; demo set-up of ledgers/data rooms/AI notes (Q15) waits for the founder's yes (~$0.50).
  - **Pending founder confirmations:** (a) a live CIM's update now publishes on the broker's per-section approvals without a fresh seller design sign-off (UX-F2 fix) — confirm or ask for the stricter rule; (b) Q15; (c) Q21; (d) the live-AI check batch (~$3.65, `oct/RELEASE.md` §5); (e) real-call tests of the together modes.
  - **Deferred (founder, 2026-10-10, to save weekly usage) — run after the usage reset:** the cut release-review lenses — data & deploy depth; robustness/performance/regressions of existing flows (seller AI interview degrading, Q&A chatbot, approvals, payload sizes/N+1, render-child memory, the 200k-row GL parse, Node 20.18); per-screen empty/loading/error states; skeptic verification of each blocker/major; batched fixes (memory `project_deferred_oct_review`).
  - **Known follow-ups:** the deal Overview is still a long stacked page (needs the tabbed redesign: KPI strip, Next step card, tabs Progress · Documents & sources · Buyers); vdr × gl tick binding (fail-closed); CimTab Generate skips gl's confirm (server still holds with 409); print preview lacks GL marks; vdr drawer "Cited by the DD CIM" link target; dd Versions "0 figures have notes"; heads-up slot ranking; `data_room_diligence` insight and `vdrJourneyEvents` not wired; heatmap "named version" wording; `NEXT_STEP_WORDS` dedupe; teaser blind-guard false positive on Beacon ("Running packaging machines…"); sidebar hover-expand pushes the page; emails still teal; SheetJS 0.18.5 → 0.20.3; the generic upload route writes files before its auth check; remove the old analytics and together legacy endpoints next release; check Railway's memory limit (gl worker cap 900 MB, 2 render children).
- **Testing costs real money:** local test servers use the PRODUCTION Anthropic key (no auto-reload). Prove mechanical fixes offline; batch live AI checks into one capped run (see memory `feedback_api_credit_budget`). Live filing runs in production for every "Interview together" session (≈ $0.50/hour); local servers never file.
- [ ] **Buyer matching must become highly intelligent — founder wants to come back to this (2026-09-25).** The founder's thesis (in the pitch deck — don't re-litigate it): every existing and future platform can be assumed to have buyer profiles; what none of them have is consistent, in-depth CIM data. Other platforms' CIMs vary wildly (10 users → 10 quality levels; no information-collection system, no checklist of what must be covered, nothing verified), so they can match well to one CIM and badly to the next. Every Cimple CIM goes through the same rigorous, industry-tailored collection + verification, so Cimple can match with an intelligence and confidence no one else can — every buyer criterion is testable on every deal and scores mean the same thing across deals. Phasing (pitch deck): **Phase 1** = brokers match their own buyer lists against CIMs they've made (new or past); **Phase 2** = buyers pay to be matched to CIMs, once enough CIMs are on the platform. Engineering gap to close: the engine matches ~15 generic fields and doesn't yet use the industry-specific depth (checklist data) or buyers' industry-specific preferences; the AI deep check (2026-09-25) reads the full fact base but the structured side still needs the depth. A useful proof metric: "criteria testable per deal" + outcome metrics (reply rate, NDA→interested).
- [x] **AI deep check + outside buyers — shipped 2026-09-25** (from the CIM-PRO comparison; founder: deep-check *every* buyer who matches the CIM, not just the top 10).
  - **AI deep check** (`server/matching/deep-check.ts`, shared first-pass scoring in `server/matching/suggested.ts`): "AI deep check (N buyers)" button in Suggested buyers → `POST /api/deals/:id/buyer-deep-check` (202, background, progress polled). Every buyer passing the first pass (`passesFirstPass`: not an excluded industry; not 2+ testable criteria with none met; profile-only buyers included) is read by Sonnet in batches of 6 against the deal's FULL verified fact base (`dealBrief` = all non-`_` extractedInfo, prompt-cached) + the buyer's whole profile (own answers, criteria, broker-private CRM summary, listings enquired about). Output per buyer: verdict (strong/good/possible/unlikely), fit 0-100, specific why-fit, watch-outs, blind-safe outreach angle → `deals.buyer_deep_check` (cached per buyer/deal fingerprint; re-runs only re-check what changed). Suggested buyers ranks AI-checked buyers first (60% AI fit + 40% lead score) and shows verdict + reason + watch-outs; the outreach draft uses the angle. QA proof: on the dental deal it rated the owner-dentist 88 "strong", and marked a DSO that passed 3/3 rules "unlikely" because the CIM records the seller won't sell to a DSO, and flagged a non-dentist buyer (RCDSO ownership rule) — things rule matching can't see.
  - **Buyers outside your list** (`server/matching/external-acquirers.ts`, `ExternalAcquirersPanel` on the deal's Buyers tab): `POST/GET /api/deals/:id/external-acquirers`; Sonnet + Anthropic web search (≤8 searches, ≤1 continuation, 4-min cap, ~1 min typical) on a BLIND brief (industry, region, size bands, seller's buyer preferences — never the name/city), then a structuring pass. Anti-hallucination: sources must be URLs the search returned; a contact is kept only if it appears verbatim in cited text (never guessed); uncited entries dropped; organisations already in the broker's buyers are tagged. Seller's buyer preferences (`idealBuyer`) are binding unless the broker ticks "Include buyer types the seller ruled out". When few/none fit, a note explains why + up to 5 "ways to reach the buyers this seller prefers" (never other brokerages). Falls back to model knowledge (clearly labelled) if web search is unavailable. Results on `deals.external_acquirers`.
- [ ] Pipedrive buyer sync can't be tested on the founder's brokerage account yet — the founder lacks API-token permission; needs the brokerage owner to grant it (or to paste the token in Integrations).
- [ ] Tier-2 beta backlog: versioned migrations replacing `db:push`, buyer view-link email verification, mini admin panel, invite-token revoke/rotate, demo-deal reset script.

### Founder-side actions outstanding
- [ ] Create `support@cimple.ca` (Support page points there).
- [ ] Enable Anthropic API auto-reload — credits hit zero during testing and interviews degraded.
- [ ] Lawyer review of `legal/` drafts (fill legal entity name, address).
- [ ] Optional: Sentry DSN, uptime monitor on `/api/health`, confirm Railway Postgres backups.
- [ ] Set own passwords on the demo accounts (temporary passwords were set during testing).
- [x] Railway past-due balance paid; inert `ENABLE_DEV_SWITCHER` variable deleted; unused Deepgram keys removed (2026-09-23).
- [ ] Real-call tests of the three "Interview together" modes (founder, pending).
- [ ] Confirm GoDaddy DNS for www.cimple.ca → Railway and apex forwarding.

### Known issues
- **Runtime data files:** the esbuild bundle ships only `server/interview/prompts/` and `agent-config.json` (see the `build` script). Any other file read at runtime (JSON/MD under `server/`) must be embedded in code or added to the build copy step — a missing file crashed production on 2026-09-22.
- Two long-standing TypeScript errors are accepted as pre-existing (`server/interview/test-harness.ts` lines 358 and 432, Set iteration). New code must add none.
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

**3 — Proactive buyer matching + broker-approved new-deal notifications** (built: Suggested buyers panel with drafted, broker-sent outreach — see known gaps for what's left)
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
