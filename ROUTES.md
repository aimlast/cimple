# Route Map

Canonical route tree for Cimple. All internal navigation must use canonical paths.
Legacy paths redirect for external links and bookmarks only.

This file mirrors `client/src/App.tsx` (plus `SellerLayout.tsx` and
`BuyerLayout.tsx`). When you add or move a route, update both.

---

## Broker Routes (`/broker/*`)

All broker-facing pages live under the `/broker` prefix.
The sidebar, back buttons, and internal links use these canonical paths.

All broker pages require a broker session (`BrokerAuthGate` wraps
BrokerLayout and the broker fullscreen interview). Unauthenticated visitors
see the sign-in screen in place — deep links survive login. If the session
check itself fails (500 / network), the gate shows a "Couldn't verify your
session — Retry" panel and never renders the app without a session.

**There is no automatic or passwordless sign-in.** Every broker — including the shared demo account — signs in with a username and password. (The former dev role-switcher and `/api/dev/*` endpoints were removed on 2026-08-21.)

| Path | Component | Description |
|---|---|---|
| `/` | BrokerDashboard | Root landing (dashboard, no redirect) |
| `/broker` | BrokerDashboard | Broker dashboard — pipeline, actions, activity |
| `/broker/login` | BrokerLogin | Sign-in page, rendered **outside** the gate (Log out lands here; signed-in brokers are redirected to `/broker`) |
| `/broker/reset-password/:token` | BrokerResetPassword | Password reset from email, rendered **outside** the gate |
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

### Sidebar active state

`isNavActive()` in `client/src/components/app-sidebar.tsx` decides which item
is highlighted:

- **Dashboard** — `/` and `/broker` only
- **Deals** — `/broker/deals*`, every `/deal/:id/*` page, `/broker/cim/*`
  (designer) and `/broker/new-deal`
- everything else — exact path or `path/…`

Below the `md` breakpoint (768px) the sidebar is an off-canvas sheet;
`BrokerMobileHeader` (sticky bar with a hamburger `SidebarTrigger` + logo)
is the only way to open it. The sheet closes itself on navigation.

## Deal Routes (`/deal/*`)

Deal detail pages. Not prefixed with `/broker` because they're already namespaced.
All are broker-only and sit behind `BrokerAuthGate`. `GET /api/deals/:id`
answers 404 for deals the broker does not own; `DealProvider` renders a
"Deal not found or not in your account" state (with a link back to Deals)
for 404/403 and a retryable error state for everything else.

| Path | Component | Layout | Description |
|---|---|---|---|
| `/deal/:id` | DealShell | BrokerLayout | Deal detail (redirects to `/deal/:id/overview`) |
| `/deal/:id/:tab` | DealShell | BrokerLayout | Deal detail with tab (`overview`, `buyers`, `qa`, `team`, `financials`, `interview-review`). Unknown tabs fall back to overview. Document management lives inside the Overview tab — there is no separate `documents` tab. |
| `/deal/:dealId/design` | CIMDesigner | BrokerLayout | CIM designer for a deal |
| `/deal/:id/interview` | CIMInterview | FullscreenLayout (inside BrokerAuthGate) | Broker-mode AI interview (fullscreen) |

## Seller Routes (`/seller/*`, `/approve/*`, `/sign-nda/*`)

Token-based access. No login required. All seller pages (except `/approve/*`
and `/sign-nda/*`) live under `/seller/:token/*` with the invite token in
every path.

| Path | Component | Layout | Description |
|---|---|---|---|
| `/seller/:token` | SellerIntake | SellerLayout | Seller onboarding (multi-step intake) |
| `/seller/:token/interview` | SellerInterview | FullscreenLayout | AI interview (fullscreen, seller mode) |
| `/seller/:token/progress` | SellerProgress | SellerLayout | Seller progress dashboard |
| `/seller/:token/documents` | SellerDocuments | SellerLayout | Seller document upload |
| `/approve/:token` | SellerApprovalPage | FullscreenLayout | Seller approves Q&A answer (different token table) |
| `/sign-nda/:token` | SellerNdaPage | FullscreenLayout | Seller signs the engagement NDA electronically (standalone token page) |

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
| `/buyer/set-password/:token` | BuyerSetPassword | Auth | Set password from invite / reset email |
| `/buyer/dashboard` | BuyerDashboard | Nav | Buyer's deal dashboard |
| `/buyer/profile` | BuyerProfile | Nav | Buyer profile editor |
| `/view/:token` | BuyerViewRoom | Immersive | CIM viewing room (tokenized) |
| `/review/:token` | BuyerApprovalReviewPage | Immersive | Buyer profile review by seller (tokenized) |

## Layout Architecture

Four layouts (plus the logged-out broker branch), selected by `AppContent`
in this order — first match wins:

1. **FullscreenLayout** — `isFullscreen()` returns true:
   - Paths ending in `/interview` (broker + seller interviews). The broker
     one (`/deal/:id/interview`) is additionally wrapped in `BrokerAuthGate`.
   - Paths starting with `/invite/` (legacy seller redirect)
   - Paths starting with `/approve/` (seller Q&A approval)
   - Paths starting with `/sign-nda/` (seller NDA e-sign)
   - Sets RoleContext to "seller" for seller paths, "broker" otherwise
2. **SellerLayout** — path starts with `/seller/` (and not caught by fullscreen)
   - Minimal top bar (Cimple wordmark + deal name from invite token + stepped progress)
   - Sets RoleContext to "seller"
3. **BuyerLayout** — path starts with `/buyer/`, `/view/`, or `/review/`
   - Three visual modes: auth card, nav bar, immersive (handled by page components)
   - Sets RoleContext to "buyer"
4. **Logged-out broker pages** — `/broker/login` and
   `/broker/reset-password/:token` render outside `BrokerAuthGate`
   - Sets RoleContext to "broker"
5. **BrokerLayout** — everything else
   - `BrokerAuthGate` → collapsible sidebar (icon-only by default, hover or
     Cmd+B to expand; hamburger sheet below 768px) + scrolling `<main>`
   - Sets RoleContext to "broker"

Every layout's `<Switch>` ends in the shared `NotFound` page
(`client/src/pages/not-found.tsx`), which is theme-aware and offers a
role-appropriate way back (broker → dashboard/deals, seller → their progress
page when a token is in the URL, buyer → dashboard/sign-in).

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
| `/broker/templates` | `/broker/deals` |
| `/broker/new-cim` | `/broker/new-deal` |
| `/broker/cim/new-questionnaire` | `/broker/new-deal` |
| `/broker/cim/new-documents` | `/broker/new-deal` |
| `/broker/cim/new-interview` | `/broker/new-deal` |
| `/broker/cim/:id` | `/deal/:id` |
| `/broker/cim/:id/preview` | `/deal/:id` |

### Seller redirects

| Legacy Path | Redirects To |
|---|---|
| `/invite/:token` | `/seller/:token` |

## Token Route Decisions

| Route | Token Source | Purpose |
|---|---|---|
| `/seller/:token` | `sellerInvites.token` | Seller onboarding intake |
| `/seller/:token/interview` | `sellerInvites.token` | Seller fullscreen interview |
| `/sign-nda/:token` | seller NDA signing token (issued with the engagement NDA email) | Seller e-signs the NDA |
| `/view/:token` | `buyerAccess.token` | Buyer views a CIM in the secure viewing room |
| `/approve/:token` | `buyerQuestions.sellerApprovalToken` | Seller approves a Q&A answer |
| `/review/:token` | `buyerApprovalRequests.sellerReviewToken` | Seller reviews a buyer's profile for approval |
| `/buyer/set-password/:token` | `buyerUsers.resetToken` | Buyer sets/resets password from email |
| `/broker/reset-password/:token` | broker password-reset token | Broker resets password from email |
