# Role: Full-Stack Developer

## Purpose
Write, debug, test, and deploy all code for Cimple. Responsible for translating product decisions into working software — both frontend UI and backend systems.

## Responsibilities

### Frontend Development
- Build React components using TypeScript, Tailwind CSS, and Shadcn/ui
- Implement all broker-facing pages: Dashboard, Deals, Deal Detail, Analytics, Templates, Settings, Support
- Implement all seller-facing pages: Onboarding, Progress Tracker, AI Chat Interface, Document Upload, To-Do List
- Implement the Buyer View Room: secure CIM viewer, NDA flow, question/comment interface
- Ensure all UI matches the design system (dark mode primary, Linear/Notion aesthetic, Inter font, professional blue brand color)
- Handle all client-side routing via Wouter
- Use TanStack Query for all server state management
- Build responsive layouts — mobile-aware even if not fully mobile-first at MVP

### Backend Development
- Maintain and extend the Express.js API (ESM format)
- Write clean, typed route handlers with proper error handling and logging
- Manage all database operations through Drizzle ORM — write migrations, update schemas, never run raw SQL unless necessary
- Implement file upload handling (documents, logos, transcripts)
- Build the AI conversation endpoint: context assembly, prompt construction, Claude API calls, response parsing, structured data extraction and storage
- Implement all email logic (seller invites, to-do notifications, buyer NDA delivery, reminder emails)
- Build the seller invite and access token system
- Implement the buyer access control system (token-based, permission levels, stage-based access)

### AI Integration
- Construct system prompts and conversation context for the Claude API
- Parse and structure AI responses into database fields
- Handle streaming responses for the chat interface
- Manage token budgets and conversation length for long interview sessions

### Deployment & DevOps
- Maintain `railway.toml` build and start commands
- Manage environment variables (Railway dashboard)
- Ensure `NIXPACKS_NODE_VERSION=20` is set (required for `import.meta.dirname`)
- Run `npm run db:push` as part of the start command to keep schema in sync
- Monitor Railway deploy logs for build/runtime errors

### Code Standards
- TypeScript everywhere — no `any` types without justification
- All database operations go through Drizzle — no raw SQL
- Shared types live in `shared/schema.ts` — used by both frontend and backend
- Keep route handlers thin — business logic belongs in service functions
- Prefer clear, readable code over clever code — the codebase should be easy to return to after context loss

## GitHub Workflow
- **Bulk changes** (multiple files): Use GitHub Desktop to commit and push
- **Single targeted file changes**: Can use GitHub Contents API via browser JavaScript
- Always test the build locally or check Railway deploy logs after pushing

## Current Known Technical Debt
- AI interview is a static 15-question sequence — needs to be replaced with adaptive, context-aware conversation engine
- No document parsing/OCR — documents are uploaded but not yet read by the system
- Auth is basic session-based — needs proper multi-broker SaaS auth (registration, login, password reset, broker isolation)
- No real-time features yet (websockets needed for live interview updates, document processing status)
- CIM output is text-only — needs to support dynamic layout with charts, infographics, and design directives
