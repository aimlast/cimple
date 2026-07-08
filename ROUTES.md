# Route Map

Canonical route tree for Cimple. All internal navigation must use canonical paths.
Legacy paths redirect for external links and bookmarks only.

---

## Broker Routes (`/broker/*`)

All broker-facing pages live under the `/broker` prefix.
The sidebar, back buttons, and internal links use these canonical paths.

All broker pages require a broker session (`BrokerAuthGate` wraps
BrokerLayout). Unauthenticated visitors see the sign-in screen in place —
deep links survive login. In local dev (and on deploys with
`ENABLE_DEV_SWITCHER=true`) the gate auto-logs-in as the demo broker.

| Path | Component | Description |
|---|---|---|
| `/` | BrokerDashboard | Root landing (dashboard, no redirect) |
| `/broker` | BrokerDashboard | Broker dashboard — pipeline, actions, activity |
| `/broker/deals` | ActiveCIMs | Deals board (canonical) |
| `/broker/analytics` | Analytics | Cross-deal analytics dashboard |
| `/broker/buyers` | Buyers | Buyer CRM / directory |
| `/broker/integrations` | Integrations | CRM + email integrations |
| `/broker/settings` | Settings | Broker account settings (persisted per user) |
| `/broker/support` | Support | Help & support (in sidebar) |
| `/broker/new-deal` | NewDeal | Create a new deal (the ONLY creation flow) |
| `/broker/cim/:dealId/design` | CIMDesigner | CIM visual designer |

The legacy "New CIM" flow (`/broker/new-cim`, `/broker/cim/new-*`,
`/broker/cim/:id`, `/broker/cim/:id/preview`) and the mock Templates page
were removed 2026-07-08; those paths now redirect to `/broker/new-deal`,
`/deal/:id`, or `/broker/deals`.

## Deal Routes (`/deal/*`)

Deal detail pages. Not prefixed with `/broker` because they're already namespaced.

| Path | Component | Description |
|---|---|---|
| `/deal/:id` | DealShell | Deal detail (redirects to `/deal/:id/overview`) |
| `/deal/:id/:tab` | DealShell | Deal detail with tab (overview, buyers, qa, team, financials, interview-review). Unknown tabs fall back to overview. Document management lives inside the Overview tab — there is no separate documents tab. |
| `/deal/:dealId/design` | CIMDesigner | CIM designer for a deal |
| `/deal/:id/interview` | CIMInterview | Deal interview (fullscreen) |

## Seller Routes (`/seller/*`, `/approve/*`)

Token-based access. No login required. All seller pages (except `/approve/*`)
live under `/seller/:token/*` with the invite token in every path.

| Path | Component | Layout | Description |
|---|---|---|---|
| `/seller/:token` | SellerIntake | SellerLayout | Seller onboarding (multi-step intake) |
| `/seller/:token/interview` | SellerInterview | FullscreenLayout | AI interview (fullscreen, seller mode) |
| `/seller/:token/progress` | SellerProgress | SellerLayout | Seller progress dashboard |
| `/seller/:token/documents` | SellerDocuments | SellerLayout | Seller document upload |
| `/approve/:token` | SellerApprovalPage | FullscreenLayout | Seller approves Q&A answer (different token table) |

## Buyer Routes (`/buyer/*`, `/view/*`, `/review/*`)

Session-based auth (login) or token-based access. All buyer routes render
inside BuyerLayout with three visual modes:
- **Auth** (centered card): login, signup, set-password
- **Nav** (top navigation bar): dashboard, profile
- **Immersive** (no chrome): view room, approval review

| Path | Component | Mode | Description |
|---|---|---|---|
| `/buyer/login` | BuyerLogin | Auth | Buyer sign-in |
| `/buyer/signup` | BuyerSignup | Auth | Buyer registration |
| `/buyer/set-password/:token` | BuyerSetPassword | Auth | Set password from invite email |
| `/buyer/dashboard` | BuyerDashboard | Nav | Buyer's deal dashboard |
| `/buyer/profile` | BuyerProfile | Nav | Buyer profile editor |
| `/view/:token` | BuyerViewRoom | Immersive | CIM viewing room (tokenized) |
| `/review/:token` | BuyerApprovalReviewPage | Immersive | Buyer profile review by seller (tokenized) |

## Layout Architecture

Four layouts, selected by `AppContent` in order:

1. **FullscreenLayout** — `isFullscreen()` returns true:
   - Paths ending in `/interview` (broker + seller interviews)
   - Paths starting with `/invite/` (legacy seller redirect)
   - Paths starting with `/approve/` (seller Q&A approval)
2. **SellerLayout** — path starts with `/seller/` (and not caught by fullscreen)
   - Minimal top bar (Cimple wordmark + deal name from invite token)
   - Sets RoleContext to "seller"
3. **BuyerLayout** — path starts with `/buyer/`, `/view/`, or `/review/`
   - Three visual modes: auth card, nav bar, immersive (handled by page components)
   - Sets RoleContext to "buyer"
4. **BrokerLayout** — everything else
   - Collapsible sidebar (icon-only by default, Cmd+B to expand)
   - Sets RoleContext to "broker"

## Legacy Redirects

These old paths redirect to their canonical equivalents.
They exist only for external links and bookmarks. Internal navigation must never use them.

### Broker redirects

| Legacy Path | Redirects To |
|---|---|
| `/deals` | `/broker/deals` |
| `/cims` | `/broker/deals` |
| `/analytics` | `/broker/analytics` |
| `/buyers` | `/broker/buyers` |
| `/integrations` | `/broker/integrations` |
| `/settings` | `/broker/settings` |
| `/templates` | `/broker/deals` |
| `/support` | `/broker/support` |
| `/new-deal` | `/broker/new-deal` |
| `/new-cim` | `/broker/new-deal` |
| `/cim/new-questionnaire` | `/broker/new-deal` |
| `/cim/new-documents` | `/broker/new-deal` |
| `/cim/new-interview` | `/broker/new-deal` |
| `/cim/:id` | `/broker/cim/:id` → `/deal/:id` |
| `/cim/:id/preview` | `/broker/cim/:id/preview` → `/deal/:id` |
| `/cim/:dealId/design` | `/broker/cim/:dealId/design` |

### Seller redirects

| Legacy Path | Redirects To |
|---|---|
| `/invite/:token` | `/seller/:token` |

## Token Route Decisions

| Route | Token Source | Purpose |
|---|---|---|
| `/seller/:token` | `sellerInvites.token` | Seller onboarding intake |
| `/seller/:token/interview` | `sellerInvites.token` | Seller fullscreen interview |
| `/view/:token` | `buyerAccess.token` | Buyer views a CIM in the secure viewing room |
| `/approve/:token` | `buyerQuestions.sellerApprovalToken` | Seller approves a Q&A answer |
| `/review/:token` | `buyerApprovalRequests.sellerReviewToken` | Seller reviews a buyer's profile for approval |
