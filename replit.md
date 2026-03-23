# Cimple — AI-Powered CBO Platform

## Overview
Cimple is an AI-powered platform for generating Confidential Business Overviews (CBOs) and Confidential Information Memorandums (CIMs) for business brokers and sellers. The platform is branded as **Cimple** with a near-black background + cream text design language. The logo is served from `/cimple-logo.png` and also importable as `@assets/CIMPLE_Logo_full_stacked_1773847868992.png` via Vite.

The platform streamlines the traditional CIM creation process through AI-guided seller interviews, dynamic questionnaires, and document analysis — guiding sellers to capture industry-specific information and generating professional, buyer-ready CBOs with custom brokerage branding.

The platform supports two main user types:
- **Brokers**: Manage multiple deals, review AI-captured data, approve information, customize branding, and export documents.
- **Sellers**: Participate in AI-guided interviews, upload supporting documents, and track CBO creation progress.

## CBO/CIM Document Format
The platform generates documents following the **AR Business Brokers CBO format**:
- **Cover Page**: Logo + "CONFIDENTIAL BUSINESS OVERVIEW" + business name + broker name
- **Confidentiality & Disclaimer Page**: Customizable legal text stored in branding settings
- **Executive Summary Snapshot**: Key metrics grid (Industry, Location, Employees, Revenue, etc.)
- **Table of Contents**: Numbered sections with subsections
- **Company Overview Group**: Company Overview, History & Milestones, Unique Selling Propositions, Sources of Revenue, Growth Strategies, Target Market, Permits & Licenses, Seasonality, Location & Site, Employee Overview
- **Transaction Overview**: Deal structure, training, reason for sale, assets, non-compete
- **Financial Overview**: Balance sheet, income statement, SDE/EBITDA normalization info
- **Data Visualizations**: Charts and graphs captured as SVGs
- **Contact Us**: Broker information

CIM section keys are **camelCase**: `executiveSummary`, `companyOverview`, `historyMilestones`, `uniqueSellingPropositions`, `sourcesOfRevenue`, `growthStrategies`, `targetMarket`, `permitsLicenses`, `seasonality`, `locationSite`, `employeeOverview`, `transactionOverview`, `financialOverview`.

### Branding Customization
- **Logo Upload**: File upload via `/api/upload-logo` (base64 POST), stored in `public/uploads/`
- **Company Name**: Broker firm name for cover page and footers
- **Disclaimer**: Customizable confidentiality/legal text with pre-fill template
- **Footer Template**: Supports `{businessName}` placeholder for dynamic substitution
- JSON body limit set to 10MB in `server/index.ts` for logo uploads

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture
**Framework**: React with TypeScript, using Vite.
**UI Component System**: Shadcn/ui built on Radix UI, featuring a Linear/Notion-inspired design with Material Design foundations. The design prioritizes professional trust, workflow efficiency, and data clarity, with dark mode as the primary theme.
**Styling**: Tailwind CSS with custom design tokens (HSL color values, custom properties) for colors, typography (Inter for UI, JetBrains Mono for technical content), and spacing.
**Routing**: Wouter for client-side routing, implementing a two-layout system: Broker Layout (with sidebar) and Seller Layout (fullscreen, no sidebar). Layout switching is managed in `App.tsx`.
**State Management**: TanStack Query for server state, and React hooks for local component state.
**Key Design Patterns**: Component composition, responsive design (mobile-first), progressive disclosure, and interactive feedback.

### Backend Architecture
**Framework**: Express.js with TypeScript on Node.js.
**API Structure**: RESTful API, including a `/api/chat` endpoint for AI conversations. Middleware is used for logging and error handling.
**AI Integration**: OpenAI API is integrated to conduct emotionally intelligent, conversational interviews with sellers, designed to feel supportive rather than interrogative.
**Interview Philosophy**: The system asks direct, CIM-focused questions one at a time, requiring concrete details. It follows a strict 15-question sequence covering all CIM sections, adapting questions based on business type and location. Operational facts are allowed, but financial statements are not. The interview respects user's decision to stop at any point.
**Demo Mode**: A default demo mode uses `server/demo-interview.ts` for scripted responses; real OpenAI API usage is enabled by setting `USE_DEMO_MODE=false`.
**Session Management**: Configured for session handling.
**Data Validation**: Zod schemas are used for runtime type validation, integrated with Drizzle ORM.

### Data Storage
**Primary Database**: PostgreSQL via Neon serverless driver.
**ORM**: Drizzle ORM for type-safe database queries and schema management.
**Schema Design**: Includes `users` table for authentication, and structured JSON storage for conversation and extracted information (e.g., business name, industry, revenue, employees, market position, competitive advantages).
**In-Memory Fallback**: `MemStorage` class provides an in-memory storage option for development, implementing the same `IStorage` interface.

## External Dependencies

**AI Services**:
- OpenAI API (for conversational AI interviews and information extraction).

**Database**:
- Neon PostgreSQL.

**UI Component Libraries**:
- Radix UI (for accessible, unstyled components).
- Embla Carousel (for carousels).
- CMDK (for command palette).
- Lucide React (for iconography).

**Styling & Fonts**:
- Google Fonts (Inter, JetBrains Mono).
- Tailwind CSS with PostCSS.

**Form Management**:
- React Hook Form with `@hookform/resolvers`.
- Date-fns (for date formatting).

**Type Safety**:
- Zod (for runtime validation).
- Drizzle-Zod (for Drizzle schema validation).
- TypeScript.