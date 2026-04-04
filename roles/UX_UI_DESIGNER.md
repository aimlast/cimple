# Role: UX/UI Designer

## Purpose
Design and maintain all user-facing interfaces for Cimple — ensuring the platform is professional, intuitive, and appropriate for its B2B audience. Every design decision should reinforce trust, reduce friction, and match the expectations of brokers and M&A advisors who work with sophisticated buyers.

## Design System

### Visual Identity
- **Mode**: Dark mode primary
- **Background**: Near-black (`220 15% 8%`), elevated surfaces (`220 15% 12%`, `220 15% 16%`)
- **Text**: Near-white primary (`220 10% 95%`), muted secondary (`220 8% 70%`)
- **Brand color**: Professional blue (`215 85% 55%`)
- **Success / Warning / Error**: Green `145 65% 50%` / Amber `35 90% 60%` / Red `0 75% 55%`
- **Borders**: Subtle (`220 8% 18%`), standard (`220 10% 25%`)

### Typography
- **UI font**: Inter (Google Fonts)
- **Monospace / technical**: JetBrains Mono
- **Scale**: Display 36px → Heading 24px → Subheading 20px → Body 16px → Small 14px → Caption 12px

### Component Library
- Shadcn/ui + Radix UI as the base
- Tailwind CSS utility classes for all styling
- Linear/Notion-inspired aesthetic: clean, typography-driven, minimal chrome

## User Types & Their Needs

### Broker (Primary User)
- Needs an efficient command center: see all deals, their status, and what needs attention
- Wants to review and approve AI-generated content without being slowed down
- Expects the platform to feel like a serious professional tool — not a startup toy
- Key screens: Dashboard, Deal Pipeline, Deal Detail (with CIM sections), Analytics, Settings/Branding

### Seller (Invited User)
- Unfamiliar with the platform — onboarding must be frictionless
- May be nervous or uncertain about the process — the interface should feel guiding and supportive
- The AI chat interface is their primary experience — it must feel warm, conversational, and structured
- Key screens: Welcome/Onboarding, Progress Tracker, AI Chat, Document Upload, To-Do List

### Buyer (External Viewer)
- Arrives via secure link — should feel like accessing a private, professional data room
- Must sign NDA electronically before accessing the CIM
- CIM viewing experience should be clean, readable, and easy to navigate
- Key screens: NDA Signing, CIM Viewer (section navigation, annotations/questions)

## Layout Principles

### Broker Layout
- Fixed left sidebar (240px): logo, nav items with icons, active state with left border accent
- Top bar: breadcrumbs left, user profile + notifications right
- Content area: max-w-7xl, 12-column grid for dashboards, max-w-2xl for forms
- Cards: rounded-lg, elevated background, border, p-6, shadow on hover

### Seller Layout
- Full-screen, no sidebar — immersive experience
- Single-column, centered (max-w-2xl)
- Sticky progress bar at top showing interview/task completion
- One step at a time — progressive disclosure

### Buyer Layout
- Clean document viewer — focus entirely on content
- Left sidebar: section navigation
- Right panel (collapsible): questions/comments
- No distractions — professional and minimal

## Key Screen Specifications

### AI Chat Interface (Seller)
- Full-height chat panel
- AI messages: left-aligned, background secondary, subtle avatar
- Seller messages: right-aligned, brand background subtle
- Input: fixed bottom, auto-grow textarea, send button, microphone button (for dictation)
- Typing indicator: animated dots while AI is responding
- Message timestamps: text-xs, text-tertiary

### CIM Viewer (Buyer)
- PDF-quality rendering inside the browser — not an actual PDF
- Section navigation sidebar (left, fixed)
- Inline annotation: highlight text/image → comment bubble appears
- Progress bar showing how far through the document the buyer has read

### Dashboard (Broker)
- 3-column stat cards at top (Active Deals, Deals This Month, etc.)
- Deal pipeline table below: deal name, status, phase, last activity, actions
- Quick action: "New Deal" button prominent top-right

### Deal Detail (Broker)
- Tabbed layout: Overview | CIM Sections | Documents | Analytics | Settings
- CIM Sections tab: left nav (section list) | center (content editor/preview) | right panel (AI generation controls, approval status)

## UX Principles
- **Progressive disclosure**: Don't show everything at once — reveal complexity contextually
- **Zero dead ends**: Every empty state has a clear next action
- **Trust signals**: The interface must look like it was built for professionals, not consumers
- **Feedback on every action**: Loading states, success confirmations, error messages — never leave the user wondering if something worked
- **Minimal cognitive load**: Information-dense screens must still be scannable — use hierarchy, not clutter

## What to Avoid
- Walls of text anywhere in the UI
- Generic placeholder content in empty states ("No data available")
- Inconsistent spacing or component usage
- Consumer-app aesthetics (rounded everything, pastel colors, playful copy)
- Modal overuse — prefer inline interactions where possible
