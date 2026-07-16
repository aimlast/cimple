# Cimple — Security Overview

> **DRAFT — for review.** Share with prospective pilot brokerages after review.
> Every statement below reflects what the platform actually does as of July 2026.

Cimple is a confidential information management platform for business brokers.
We treat your clients' information the way you do: as the most sensitive asset
in a transaction.

## How your data is protected

**Access control**
- Every brokerage has its own isolated account. Your deals, sellers, buyers,
  and analytics are scoped to your brokerage — no other Cimple customer can
  see them.
- Broker access requires username/password sign-in (passwords stored hashed
  with bcrypt, never in plain text). Login endpoints are rate-limited against
  brute-force attempts.
- Sellers and buyers never receive accounts with broad access — they interact
  through single-purpose, unguessable secure links scoped to one deal.

**Confidentiality controls built for M&A**
- Buyer links expire automatically after 30 days unless you extend them, and
  can be revoked instantly.
- NDA gating is enforced on the server: when a deal requires an NDA, no CIM
  content leaves our servers until the buyer has signed. Signature timestamp
  and IP are recorded.
- Early-stage buyers see the Blind CIM: business name, people, and locations
  are replaced with a project codename across the entire document — including
  page titles and navigation.
- Every CIM view is watermarked with the viewing buyer's email address.
- Uploaded documents (financial statements, tax returns, leases) are not
  publicly accessible: downloads require the deal-owning brokerage's session
  or the seller's own secure link.

**Infrastructure**
- All traffic is encrypted in transit (TLS/HTTPS, with HSTS enforced).
- Data is stored in a managed PostgreSQL database with encryption at rest,
  hosted on Railway's cloud infrastructure.
- Application security headers (content sniffing protection, clickjacking
  protection) are enforced on every response.
- Errors and availability are monitored continuously.

**AI processing**
- Cimple uses Anthropic's Claude models for the seller interview, document
  extraction, and CIM generation. Under Anthropic's commercial API terms,
  data submitted via the API is not used to train their models.
- AI-generated content is a draft for broker review — brokers approve all
  content before buyers see it.

## Sub-processors

| Provider | Purpose |
|---|---|
| Railway | Application hosting and managed PostgreSQL database |
| Anthropic | AI processing (interview, extraction, document generation) |
| Resend | Transactional email delivery |

## Data ownership and retention

- Your brokerage owns its data. Cimple processes it solely to provide the
  service.
- On termination, we will export your data on request and delete it from
  production systems.

## Questions

Security questions or disclosure reports: **security@cimple.ca** *(or
support@cimple.ca)*.

---
*Cimple is an early-stage product. We do not yet hold a SOC 2 attestation;
our security roadmap includes SOC 2 Type I as the platform matures. This
overview is provided for transparency and will be updated as controls evolve.*
