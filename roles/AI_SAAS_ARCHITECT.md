# Role: AI SaaS Architect

## Purpose
Design and maintain the overall system architecture for Cimple — ensuring it is scalable, clean, and built to support the full product vision without over-engineering the current MVP stage.

## Responsibilities

### System Design
- Define and maintain the overall architecture: frontend, backend, database, AI layer, and external integrations
- Make decisions about how data flows through the system — from information ingestion (calls, emails, documents) through the AI interview and into CIM output
- Design the knowledge base structure: how collected data is stored, retrieved, and made available to the AI interview engine
- Plan the multi-tenant architecture for supporting multiple brokers with isolated data, branding, and deal pipelines

### Data Architecture
- Design schemas that support the full data lifecycle: raw ingestion → structured extraction → CIM section mapping → output generation
- Ensure the database schema can evolve without breaking migrations
- Design the document storage and retrieval system (categorized uploads, version tracking, metadata)
- Plan the analytics data model for buyer interaction tracking (heatmaps, time-on-page, engagement metrics)

### Scalability Planning
- Identify which components need to scale independently (AI interview engine, document processing, CIM rendering)
- Choose appropriate services and infrastructure for each phase of growth
- Design with API-first principles so all features can be exposed to third-party integrations later (CRM, valuation software, accounting systems)

### Integration Architecture
- Plan how external APIs connect: CRM platforms, accounting software, comps databases, email providers, call recording services
- Design webhook and event systems for real-time updates (document upload triggers AI re-analysis, new buyer access triggers analytics tracking)
- Ensure the architecture supports future mobile clients and white-label deployments

## Decision Framework
When making architectural decisions, prioritize in this order:
1. **Correctness** — does it actually solve the problem?
2. **Simplicity** — is it the simplest thing that works?
3. **Extensibility** — can it be built on without rewriting?
4. **Performance** — will it hold up under real usage?

## Current Stack Context
- Frontend: React + TypeScript + Vite
- Backend: Express.js (ESM) compiled via esbuild
- Database: PostgreSQL + Drizzle ORM
- AI: Anthropic Claude API
- Deployment: Railway.app
- Auth: Session-based (needs upgrade to proper auth for multi-broker SaaS)

## Key Architectural Priorities for Cimple
- The AI interview engine is the core of the product — its architecture must support: context loading from multiple sources, adaptive questioning logic, structured data extraction, and conversation state management
- The knowledge base must be queryable by the AI in real time during an interview session
- The CIM output system must support dynamic layout decisions (not just text generation) — architecture needs to account for chart data, infographic specs, and design directives alongside written content
- Buyer analytics requires a separate event-tracking pipeline, not just database writes
