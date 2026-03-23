# Design Guidelines: AI-Powered CIM Platform

## Design Approach

**Selected Approach**: Design System - Linear/Notion-inspired with Material Design foundations

**Justification**: This is a complex B2B productivity tool requiring clarity, efficiency, and professional credibility. The Linear aesthetic (clean, typography-focused, subtle interactions) combined with Material Design's robust component patterns provides the perfect foundation for information-dense workflows while maintaining visual sophistication.

**Core Principles**:
- Professional trust: Clean, modern interface that conveys enterprise credibility
- Workflow efficiency: Clear information hierarchy, minimal cognitive load
- Progressive disclosure: Complex features revealed contextually
- Data clarity: Information-dense screens remain scannable and organized

## Color Palette

**Dark Mode (Primary)**:
- Background Primary: 220 15% 8%
- Background Secondary: 220 15% 12%
- Background Elevated: 220 15% 16%
- Text Primary: 220 10% 95%
- Text Secondary: 220 8% 70%
- Text Tertiary: 220 6% 50%
- Primary Brand: 215 85% 55% (professional blue)
- Primary Hover: 215 85% 48%
- Success: 145 65% 50%
- Warning: 35 90% 60%
- Error: 0 75% 55%
- Border: 220 10% 25%
- Border Subtle: 220 8% 18%

**Light Mode**:
- Background Primary: 0 0% 100%
- Background Secondary: 220 15% 98%
- Background Elevated: 220 15% 100%
- Text Primary: 220 15% 15%
- Text Secondary: 220 10% 40%
- Primary Brand: 215 85% 50%
- Border: 220 10% 88%

## Typography

**Font Families**:
- Primary: 'Inter' (Google Fonts) - body, UI elements
- Display: 'Inter' at larger weights - headings, emphasis
- Monospace: 'JetBrains Mono' (Google Fonts) - code, technical data

**Scale**:
- Display (H1): text-4xl font-semibold (36px)
- Heading (H2): text-2xl font-semibold (24px)
- Subheading (H3): text-xl font-medium (20px)
- Body Large: text-base font-normal (16px)
- Body: text-sm font-normal (14px)
- Caption: text-xs font-normal (12px)

## Layout System

**Spacing Primitives**: Use Tailwind units of 2, 4, 6, 8, 12, 16, 20, 24 for consistency
- Component padding: p-4, p-6, p-8
- Section spacing: space-y-6, space-y-8
- Card margins: m-4, m-6
- Grid gaps: gap-4, gap-6, gap-8

**Grid System**:
- Dashboard: 12-column grid (grid-cols-12)
- Content areas: max-w-7xl mx-auto
- Forms: max-w-2xl
- Sidebar: 240px fixed width (w-60)

## Component Library

### Navigation & Chrome
**Main Navigation** (Side Panel):
- Fixed left sidebar, dark background elevated
- Logo at top, navigation items with icons (Heroicons)
- Active state: subtle background highlight, border-l-2 accent
- Collapsible for space efficiency

**Top Bar**:
- Breadcrumbs (left), user profile + notifications (right)
- Search bar (center) with ⌘K shortcut indicator
- Background: elevated surface with subtle border-b

### Core UI Elements

**Cards**:
- Subtle rounded corners (rounded-lg)
- Background elevated with border
- Shadow: shadow-sm on hover
- Padding: p-6 for content cards

**Buttons**:
- Primary: Filled with brand color, medium font-weight
- Secondary: Outlined with border-2
- Ghost: Transparent with hover state
- Sizes: sm (h-8 px-3), md (h-10 px-4), lg (h-12 px-6)

**Forms**:
- Input fields: Background secondary, border subtle, focus ring with brand color
- Labels: text-sm font-medium above inputs
- Helper text: text-xs text-secondary below inputs
- Validation: Inline errors with error color, success checkmarks

**Tables**:
- Striped rows (alternate background)
- Sticky headers on scroll
- Hover state: subtle background change
- Action buttons: ghost style, appear on row hover

### Feature-Specific Components

**Conversational AI Interface**:
- Chat-style bubbles: AI (left-aligned, background secondary), User (right-aligned, brand background subtle)
- Input area: Fixed bottom, elevated background, auto-grow textarea
- Typing indicators: animated dots
- Message timestamps: text-xs text-tertiary

**Document Upload Zone**:
- Dashed border (border-dashed) with drag-active state
- Large dropzone area (min-h-48)
- File type icons (Heroicons: DocumentIcon, etc.)
- Progress bars for uploads: brand color fill

**Progress Tracker**:
- Vertical stepper for seller dashboard
- Completed: checkmark icon, brand color
- Current: outlined circle, brand color
- Pending: outlined circle, text-tertiary
- Connecting lines between steps

**CIM Preview Panel**:
- Split view: Source data (left) | Formatted output (right)
- PDF-style preview with zoom controls
- Section navigation sidebar
- Export button: prominent, top-right

**Missing Information Flags**:
- Warning cards with yellow-subtle background
- Icon: ExclamationTriangleIcon
- "AI attempting" status: animated pulse
- "Broker review needed": requires action indicator

## Key Screen Layouts

### Dashboard (Broker View)
- Grid: 3 columns of stat cards (grid-cols-3)
- Active projects table below
- Quick actions: floating action button (bottom-right)

### Seller Questionnaire
- Single-column form (max-w-2xl centered)
- Sticky progress bar (top)
- One question per screen with smooth transitions
- Previous/Next navigation (bottom)

### AI Conversation Interface
- Full-height panel (h-screen)
- Messages: max-w-3xl centered
- Context panel (collapsible right sidebar) showing extracted info

### CIM Review
- Three-column layout: Sections list (left 240px) | Content editor (flex-1) | Properties panel (right 320px)
- Toolbar: sticky top with formatting options
- Approval workflow: bottom action bar

## Visual Treatments

**Micro-interactions** (Minimal):
- Button hover: subtle scale (scale-105)
- Card hover: lift with shadow increase
- Smooth transitions: transition-all duration-200

**Loading States**:
- Skeleton screens matching content structure
- Spinner: brand color on critical actions
- Progress indicators for long operations

## Images

**Dashboard Hero** (Optional):
- Abstract gradient visualization of AI/data processing
- Placement: Top of empty states or onboarding
- Style: Soft, professional, non-literal

**Empty States**:
- Illustrated icons for "No projects yet", "No documents uploaded"
- Style: Line art, brand color accents
- Placement: Center of empty list views

**Brand Integration**:
- Client logo upload: displayed in generated CIM headers
- Firm branding: customizable accent colors override default brand color throughout

This design creates a sophisticated, efficient workspace that balances information density with visual clarity, positioning the platform as an enterprise-grade solution.