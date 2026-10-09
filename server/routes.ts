import type { Express, Request, Response, NextFunction } from "express";
import { createServer, type Server } from "http";
import crypto from "crypto";
import { newDocumentFileName } from "./documents/document-path";
import { BULK_AI_CONCURRENCY, BULK_DRAFT_CONCURRENCY, BULK_OUTREACH_MAX, mapWithConcurrency } from "./security/bulk-limits";
import path from "path";
import fs from "fs";
import { storage } from "./storage";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { startOrResumeSession, processTurn, getSessionHistory, parseCorrectionOf, parseConductedVia, turnPrecheck } from "./interview";
import { callerMode, contextSessions, parseAnsweringAt, sellerSideTasks, sessionFinishedInterview, sessionModeOf, stalledSellerSessions, TurnConflictError, type ConductedBy } from "./interview/session-mode";
import { sellerSafeTurnResult } from "./interview/seller-safe-turn";
import { regenerateCimSection } from "./cim/layout-engine.js";
import { overlayResolvedFacts, resolvedNotes } from "./cim/resolved-block.js";
import { startCimGeneration, getCimGenerationStatus, getLiveCimGenerationStatus, listBrokerCimGeneration, CimGenerationRunningError, buildLayoutParams } from "./cim/generation-jobs.js";
import { getSectionImportance, computeSectionImportance } from "./interview/section-importance.js";
import { getInterviewOutline, proposeOutlineChanges, applyOutlineProposal, patchOutline } from "./interview/outline.js";
import { coverageAdjustmentsForDeal, ensureInterviewPlan, getInterviewPlan, isPlanBuilding, fieldLabel, planSubIndustry } from "./interview/interview-plan.js";
import { ensureSourceReview } from "./interview/source-review.js";
import { storedEvidence, isEvidenceBuilding } from "./interview/on-file-evidence.js";
import { startOnFileEvidenceBuild } from "./interview/on-file-refresh.js";
import { buildSectionCoverage as buildCoverageForOutline, SECTION_FIELD_MAP } from "./interview/knowledge-base.js";
import { isDeepgramConfigured, createTemporaryKey } from "./calls/deepgram.js";
import { isDailyConfigured, createRoom, createMeetingToken, deleteRoom } from "./calls/daily.js";
import type { InterviewCall, InterviewBot } from "@shared/schema";
import { ndaBuyerProfileSchema, hasMatchableProfile } from "@shared/nda-buyer-profile";
import { isRecallConfigured, isSupportedMeetingUrl, newWebhookToken, createBot, getBot, leaveCall, latestStatus, pushBotLine, setBotStatus, readBotLines, clearBotBuffer, lineFromWebhook } from "./calls/recall.js";
import { computeCimReadiness } from "@shared/cim-readiness";
import { DEAL_PHASES, isDealPhase, phaseIndex } from "@shared/deal-progress";
import { stripDdMarkers } from "./cim/dd-enrichment.js";
import { aggregateEngagementInsights } from "./cim/learning-loop.js";
import { buildBuyerCim, cimHeldFromBuyers, ndaBlocksBuyer, realSectionKeyMap } from "@shared/cim-buyer-view";
import { dealPublishedForBuyers, notPublishedBody, NOT_PUBLISHED_BROKER_MESSAGE, NOT_PUBLISHED_CODE } from "@shared/buyer-publish-gate";
import { askerScope, MAX_BUYER_QUESTION_CHARS } from "@shared/buyer-qa-scope";
import { blindLeakTerms, findBlindLeaks } from "@shared/blind-guard";
import { invalidateBlind, redoLeakedBlind, regenerateAllBlind, regenerateAllBlindInBackground, scheduleBlindRefresh } from "./cim/blind-sync.js";
import { patchCimSection, reorderDealSections } from "./cim/section-ops.js";
import { hasSampleData, isCimFallbackSection } from "@shared/cim-layouts";
import { ACCESS_LEVEL_INPUT_ERROR, BLIND_ACCESS_LEVEL, accessGrantPhrase, cimModeForAccessLevel, isTeaserOnly, normalizeAccessLevel, parseAccessLevelInput, renditionKindFor, sameAccessLevel } from "@shared/access-levels";
import { withApprovalRuleMark } from "@shared/cim-approvals";
import multer from "multer";
import { registerDealListRoutes, loadDealSideFacts, moneyValue, dealNextStep } from "./routes/deal-list.js";
import { registerInformationRoutes } from "./routes/information.js";
import { listedAskingPrice } from "./information/deal-mirror";
import { brokerFactsView } from "./information/facts";
import { withoutFactsSnapshot } from "./cim/cim-staleness";
import { checkCimGenerationGate, computeDealReadiness } from "./cim/generation-gate";
import { registerCrmSellerRoutes } from "./routes/crm-seller.js";
import { registerBuyerProfileRoutes } from "./routes/buyer-profiles.js";
import { registerCimBuilderRoutes } from "./routes/cim-builder.js";
import { registerCimHeldPrivateRoutes } from "./routes/cim-held-private.js";
import { registerDiscrepancyRoutes } from "./routes/discrepancies.js";
import { ensureDiscrepancyGate } from "./cim/discrepancy-check.js";
import { settleMergeRowsQuietly } from "./documents/merge-conflicts.js";
import { registerCimMediaRoutes } from "./routes/cim-media.js";
import { loadMediaAssets } from "./cim/media-store.js";
import { registerCimTemplateRoutes } from "./routes/cim-templates.js";
import { registerEngagementRoutes } from "./routes/engagement.js";
import { registerEngagementInsightRoutes } from "./routes/engagement-insights.js";
import { registerAnalyticsDashboardRoutes } from "./routes/analytics-dashboard.js";
import { registerAnalyticsExtraSources } from "./routes/analytics-extra-sources.js";
import { questionWaitingOn } from "@shared/analytics-dashboard";
import { registerTeaserRoutes } from "./routes/teaser.js";
import { registerTogetherRoutes } from "./routes/together.js";
import { registerFigureRoutes } from "./routes/figures.js";
import { figureQuestionsWithSeller } from "./interview/seller-followups";
import { buyerCimExtras } from "./cim/buyer-extras.js";
import { registerDataRoomRoutes } from "./routes/data-room.js";
import { registerDataRoomBuyerRoutes } from "./routes/data-room-buyer.js";
import { registerGlRoutes } from "./routes/gl.js";
import { registerGlDataRoomWiring } from "./routes/gl-data-room-wiring.js";
import { registerReadingRoutes } from "./routes/reading.js";
import { recordRendition } from "./analytics/renditions.js";
import { viewRoomStamp } from "./analytics/reading-ingest.js";
import { notify, previewRecipients, sendDirectEmail } from "./notifications/service.js";
import { escapeHtml } from "./notifications/email-escape";
import { teamInviteCopy } from "./notifications/team-invite-copy";
import { sellerLinkOnRemoval, REVOKED_INVITE_STATUS, type SellerLinkOnRemoval } from "@shared/seller-invite-revocation";
import { createWebhookTokenResolver, dealIdForWebhookToken } from "./calls/webhook-lookup";
import { prefillBuyerFromCrm, searchBuyersInCrm } from "./crm/buyer-prefill.js";
import { registerBuyerAuthRoutes, inviteBuyerUser, reinviteBuyerWithoutPassword } from "./buyer-auth/routes.js";
import { buildApprovalInviteEmail, type ApprovalEmailVariant } from "./buyers/approval-emails.js";
import { sellerReviewPayload } from "./buyers/seller-review-payload.js";
import { outreachReplyTo, outreachFromName, brokerDisplayName } from "./buyers/outreach-reply.js";
import { answerBuyerQuestion } from "./buyers/question-answer.js";
import { mapWithLimit, withAiRetry } from "./ai-retry.js";
import { answerNoticeDue, notifyBuyerQuestionAnswered } from "./qa/answer-notice.js";
import { buyerNdaFor, signedNdaCopy, type BuyerNdaSignature } from "./buyers/buyer-nda.js";
import { validSignerName } from "@shared/buyer-nda";
import { registerBuyerNdaRoutes } from "./routes/buyer-nda.js";
import { registerSellerReviewRoutes } from "./routes/seller-review.js";
import { registerBuyerDashboardRoutes } from "./buyer-auth/dashboard.js";
import { typedNumericValues } from "./interview/info-merger";
import { splitFactsForCim, factValueText, CIM_LEADS_HEADING } from "./information/cim-facts";
import { keepOutFromNotes, screenFactsForCim, screenText, type KeepOut } from "./cim/sensitive-facts";
import { screenStaffPrivateText, staffContextFrom } from "./cim/staff-private";
import { keepOutFor } from "./cim/keep-out";
import { registerBrokerAuthRoutes, requireBroker, requireOwnedDeal, getOwnedDeal, canAccessDeal, sellerTokenMatchesDeal, isDealOwnerSession } from "./broker-auth/routes.js";
import {
  pickBodyFields,
  DOCUMENT_CREATE_FIELDS, DOCUMENT_PATCH_FIELDS, DOCUMENT_SERVER_OWNED,
  TASK_PATCH_FIELDS, TASK_SERVER_OWNED,
  INTEGRATION_CREATE_FIELDS, INTEGRATION_CREATE_SERVER_OWNED, INTEGRATION_PATCH_FIELDS, INTEGRATION_SERVER_OWNED, INTEGRATION_STATUSES,
} from "./security/body-fields";
import { syncDealToCrm, describeCrmAction, crmProviderLabel, getConnectedCrmProvider } from "./crm/sync.js";
import { runDecisionReminders, canSnoozeDecision, buyerFacingDealName } from "./reminders/decision-reminders.js";
import { buildAnswerContext, buildBuyerQuestionFeed, publishedQuestionsFor, type AnswerSection } from "./qa/cim-context.js";
import { TEAM_ROLES, BUYER_NEXT_STEPS, BUYER_CATEGORIES, riskLevelForCategory, insertBuyerApprovalRequestSchema, type BuyerUser, type InsertDealDocumentRequirement, CIM_SECTIONS, mergeBuyerProfile, type CrmBuyerProfile, type BuyerDeepCheck } from "@shared/schema";
import { withFieldSources, initialFieldSources, type BrokerBuyerOverlay, type BuyerAccessEvent } from "@shared/schema";
import { isBuyerInBrokerList, filterBuyersInBrokerList } from "./buyers/profile-data.js";
import { unsupportedFormatReason } from "./documents/parser.js";
import { viewLinkProblem, viewLinkError, viewStampFor, isLinkableBuyerAccount } from "./buyers/view-access.js";
import { ndaProfileAccount } from "./buyers/nda-profile.js";
import { discrepancyBlocksCim, routedToSellerAt, withRoutedStamp } from "@shared/discrepancy-gate";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Maps CIM_SECTIONS keys to human-readable descriptions used in generation prompts
const CIM_SECTION_PROMPTS: Record<string, string> = {
  overview:         "Company Overview & Reputation — what the business does, its history, how it has evolved, brand identity, and how customers and the broader market perceive it",
  strengths:        "Competitive Strengths & Unique Selling Propositions — the specific, concrete advantages that make this business valuable, defensible, and differentiated from competitors",
  growth_potential: "Growth Opportunities — specific, realistic strategies a new owner could pursue to grow revenue, expand markets, add product lines, or increase margins",
  target_market:    "Target Market & Customer Base — who the customers are, B2B vs B2C split, demographics, customer concentration, loyalty and repeat rates, how customers find the business",
  permits_licenses: "Permits, Licenses & Regulatory Compliance — every operating license, certification, and regulatory requirement the business holds or must maintain, including jurisdiction-specific requirements",
  seasonality:      "Seasonality & Revenue Patterns — peak and slow periods, how the business manages cash flow through cycles, any meaningful year-over-year trends",
  revenue_sources:  "Revenue Streams & Major Business Lines — how the business makes money, breakdown of revenue sources, top products or services, pricing model, recurring vs project revenue",
  real_estate:      "Location, Facilities & Real Estate — physical premises, lease terms and expiry, whether real estate is included, equipment and fixtures included in the sale",
  employees:        "Team & Employee Overview — team size and structure, key roles, owner dependency and involvement level, key man risk, management team quality and tenure",
  operations:       "Operations & Systems — day-to-day operations, key processes, supplier and vendor relationships, technology infrastructure, operational efficiency",
  buyer_profile:    "Ideal Buyer Profile — who the right acquirer is, what background or experience matters, what they would be acquiring and why it suits strategic or individual buyers",
  training_support: "Training & Transition Support — what the seller will provide during transition, timeline, scope of knowledge transfer, ongoing availability",
  reason_for_sale:  "Reason for Sale & Transaction Overview — why the seller is exiting, deal structure, what assets are included, any non-compete, preferred timeline",
  financials:       "Financial Summary — revenue profile, profitability context, SDE or EBITDA framing, growth trend over recent years, what financial documentation is available for due diligence",
  asking_price:     "Asking Price & Deal Terms — asking price, deal structure options, financing considerations, inventory and working capital position, key terms",
};

// Simple CSV parser — handles quoted fields, commas inside quotes, escaped
// double quotes ("" → "), and Windows/Unix line endings. Not RFC-perfect
// but good enough for broker contact imports.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const src = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        row.push(field);
        field = "";
      } else if (c === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else {
        field += c;
      }
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter(r => r.length > 0);
}

async function generateSectionWithClaude(
  businessName: string,
  industry: string,
  sectionKey: string,
  data: {
    extractedInfo: Record<string, any>;
    questionnaireData?: Record<string, any> | null;
    scrapedData?: Record<string, any> | null;
    description?: string | null;
    askingPrice?: string | null;
    /** Items that must not reach buyers (keep-out.ts keepOutFor). */
    keepOut?: KeepOut | null;
  }
): Promise<string> {
  const desc = CIM_SECTION_PROMPTS[sectionKey] || sectionKey;

  // Build a structured context block so the model can find relevant data
  const contextParts: string[] = [];

  if (data.description) {
    contextParts.push(`=== BROKER NOTES ===\n${data.description}`);
  }

  // Facts split by provenance: CRM notes / website / social claims are
  // leads, never presented as confirmed; per-source notes and "_" keys are
  // never CIM input.
  const split = splitFactsForCim(data.extractedInfo);
  // Personal details and clauses the facts mark confidential never reach CIM text.
  const keepOut = data.keepOut ?? keepOutFromNotes(data.extractedInfo);
  const confirmed = screenFactsForCim(split.confirmed, keepOut).safe;
  const leads = screenFactsForCim(split.leads, keepOut).safe;
  // Free text (the raw questionnaire, the scrape): health details and staff-private sentences out too.
  const staffCtx = keepOut.staff?.ctx ?? staffContextFrom(data.extractedInfo);
  const staffIncluded = new Set(keepOut.staff?.included ?? []);
  const screenFree = (v: unknown) => screenStaffPrivateText(screenText(String(v)), staffCtx, staffIncluded).text;
  if (confirmed.length > 0) {
    contextParts.push(
      `=== CONFIRMED (seller interview, broker, documents, questionnaire) ===\n` +
      confirmed.map(([k, v]) => `${k}: ${factValueText(v)}`).join("\n")
    );
  }
  if (leads.length > 0) {
    contextParts.push(`=== ${CIM_LEADS_HEADING} ===\n` + leads.map(([k, v]) => `${k}: ${factValueText(v)}`).join("\n"));
  }

  if (data.questionnaireData && Object.keys(data.questionnaireData).length > 0) {
    const qEntries = Object.entries(data.questionnaireData).filter(([, v]) => v);
    if (qEntries.length > 0) {
      contextParts.push(
        `=== FROM QUESTIONNAIRE ===\n` +
        qEntries.map(([k, v]) => `${k}: ${screenFree(v)}`).filter((l) => !/: $/.test(l)).join("\n")
      );
    }
  }

  if (data.scrapedData && Object.keys(data.scrapedData).length > 0) {
    const sEntries = Object.entries(data.scrapedData).filter(([, v]) => v);
    if (sEntries.length > 0) {
      contextParts.push(
        `=== PUBLICLY FOUND (treat as supporting context only) ===\n` +
        sEntries.map(([k, v]) => `${k}: ${screenFree(v)}`).filter((l) => !/: $/.test(l)).join("\n")
      );
    }
  }

  if (data.askingPrice) {
    contextParts.push(`=== ASKING PRICE ===\n${data.askingPrice}`);
  }

  const context = contextParts.join("\n\n") || "No data collected yet.";

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 1000,
    system: `You are a professional business broker writer specializing in Confidential Business Overviews (CBOs) and Confidential Information Memorandums (CIMs). You write compelling, buyer-focused content that presents businesses in their best light while remaining factually accurate. Your writing is concise, professional, and persuasive — it reads like a premium investment document, not a generic template.

Style guidelines:
- 2–3 focused paragraphs per section
- Lead with the strongest, most compelling point
- Use specific facts, numbers, and names whenever available in the data
- Write directly to a sophisticated acquirer evaluating this as an investment
- Use **bold** for key metrics, standout facts, or deal highlights
- Never open with clichés like "proven track record", "well-established", "thriving", or "exciting opportunity"
- If a section has very little data, write what you can and note clearly what information is pending — do not fabricate
- Prioritize "CONFIRMED" data above all other sources; never state an "UNCONFIRMED LEADS" item as fact`,
    messages: [
      {
        role: "user",
        content: `Write the "${desc}" section for this business CIM/CBO.

Business Name: ${businessName}
Industry: ${industry}

${context}

Write only the section body — no section heading, no intro preamble like "Here is the section:". Just the content.`,
      },
    ],
  });

  return (response.content[0] as { type: string; text: string }).text;
}

export async function registerRoutes(app: Express): Promise<Server> {
  // Deploy healthcheck — public by design, returns no data. (The previous
  // healthcheck path /api/cims broke when broker auth landed: Railway got
  // 401s and marked otherwise-healthy deploys as failed.)
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  // Ownership check for by-id routes (documents, tasks, sections, members…):
  // the entity's parent deal must belong to the session broker.
  const ownsDeal = async (req: Request, dealId: string | null | undefined): Promise<boolean> =>
    !!dealId && !!(await getOwnedDeal(dealId, req.session.brokerId));

  // A view link can be read: a CIM link once the CIM is published; a teaser
  // link while the teaser is published and online (server/teaser/serve.ts).
  const linkReadable = async (access: NonNullable<Awaited<ReturnType<typeof storage.getBuyerAccessByToken>>>): Promise<boolean> => {
    const linkDeal = await storage.getDeal(access.dealId);
    if (!linkDeal) return false;
    if (!isTeaserOnly(access.accessLevel)) return dealPublishedForBuyers(linkDeal);
    const { getDealTeaser } = await import("./teaser/store");
    const { linkOpenForBuyer } = await import("./teaser/serve");
    return linkOpenForBuyer(linkDeal, access, await getDealTeaser(linkDeal.id));
  };

  // Product rule: unresolved CRITICAL discrepancies block every CIM-producing
  // step (content, layout, publish). "ask_seller" counts as handled while
  // the interview runs (shared/discrepancy-gate.ts discrepancyBlocksCim).
  const blockingCriticalDiscrepancies = async (dealId: string) => {
    // A merge row whose conflict no longer stands (its source deleted, its facts moved on) never blocks.
    await settleMergeRowsQuietly(dealId, "discrepancy-gate");
    const gateDeal = await storage.getDeal(dealId);
    return (await storage.getDiscrepanciesByDeal(dealId)).filter((d) => discrepancyBlocksCim(d, gateDeal?.interviewCompleted));
  };
  const discrepancyBlockResponse = (res: Response, open: { id: string; field: string }[], verb: string) =>
    res.status(409).json({
      error: `${open.length} critical discrepanc${open.length === 1 ? "y" : "ies"} must be resolved before ${verb}`,
      blockingDiscrepancies: open.map((d) => ({ id: d.id, field: d.field })),
    });

  // Broker's configured default buyer-link expiry (Settings → Deal Defaults),
  // falling back to the 30-day security default. Previously saved but never read.
  const brokerLinkExpiry = async (brokerId: string | undefined): Promise<Date> => {
    let days = 30;
    if (brokerId) {
      const user = await storage.getUser(brokerId).catch(() => undefined);
      const configured = Number((user?.settings as any)?.dealDefaults?.expirationDays);
      if (Number.isFinite(configured) && configured >= 1 && configured <= 365) days = configured;
    }
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  };

  // Uploaded files live under UPLOADS_DIR — on Railway this is a persistent
  // volume (e.g. /data/uploads) so documents and logos survive redeploys.
  // Locally it falls back to public/uploads.
  const uploadsDir = process.env.UPLOADS_DIR || path.join(process.cwd(), "public", "uploads");
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  // Confidential documents (tax returns, financials, leases) are NOT public:
  // access requires the broker session that owns the deal, or the deal's
  // seller invite token (?token= / X-Seller-Token). CIM photos/videos
  // (private-media/) are never served statically — only through
  // GET /api/media/:id. Everything else under /uploads (branding logos)
  // stays public. The gate classifies the DECODED, normalised path — the
  // one the static server resolves — so "//docs", "%64ocs" or "docs%2F"
  // can't slip past it (server/security/uploads-gate.ts).
  const { registerUploadsGate } = await import("./security/uploads-gate.js");
  const expressStatic = (await import("express")).default.static;
  registerUploadsGate(app, uploadsDir, {
    getDocumentsByFileUrl: (u) => storage.getDocumentsByFileUrl(u) as any,
    getDeal: (id) => storage.getDeal(id) as any,
    getSellerInviteByToken: (t) => storage.getSellerInviteByToken(t) as any,
    // gl: a ledger / add-back support file opens only for the owner's or accountant's link.
    getDealMembers: (id) => storage.getDealMembers(id) as any,
  }, (root) => expressStatic(root));

  // ── Broker + buyer authentication, buyer dashboard ────────────────────
  registerBrokerAuthRoutes(app);
  registerBuyerAuthRoutes(app);
  registerBuyerDashboardRoutes(app);

  // Broker-side: search existing buyer accounts by email/name (for the
  // "add buyer" autocomplete — hits before falling through to CRM)
  app.get("/api/buyer-users/search", requireBroker, async (req, res) => {
    try {
      const q = String(req.query.q || "");
      if (q.length < 2) return res.json({ results: [] });
      const users = await storage.searchBuyerUsers(q, req.session.brokerId!);
      res.json({
        results: users.map(u => ({
          id: u.id,
          email: u.email,
          name: u.name,
          company: u.company,
          phone: u.phone,
          buyerType: u.buyerType,
          profileCompletionPct: u.profileCompletionPct,
          source: "existing_account",
        })),
      });
    } catch (err: any) {
      console.error("Buyer user search error:", err);
      res.status(500).json({ error: "Search failed" });
    }
  });

  // ────────────────────────────────────────────────────────────────────
  // Broker Buyer Contacts — the broker's personal contact list
  // ────────────────────────────────────────────────────────────────────

  // List all buyer contacts for a broker
  app.get("/api/broker/buyers", requireBroker, async (req, res) => {
    try {
      // Merged profile (broker overlay > buyer's own > CRM) with engagement on
      // the broker's deals feeding the score — see server/buyers/profile-view.ts.
      const { buildBrokerBuyerList } = await import("./buyers/profile-view.js");
      res.json({ buyers: await buildBrokerBuyerList(req.session.brokerId!) });
    } catch (err: any) {
      console.error("Error fetching broker buyer list:", err);
      res.status(500).json({ error: "Failed to fetch buyer list" });
    }
  });

  // Get details for a single buyer (for detail drawer)
  app.get("/api/broker/buyers/:buyerId", requireBroker, async (req, res) => {
    try {
      const brokerId = req.session.brokerId!;
      // Only buyers already on this broker's list — never any buyer by id.
      if (!(await isBuyerInBrokerList(brokerId, req.params.buyerId))) return res.status(404).json({ error: "Buyer not found" });
      const ownProfile = await storage.getBuyerUser(req.params.buyerId);
      if (!ownProfile) return res.status(404).json({ error: "Buyer not found" });

      const contact = await storage.getBrokerBuyerContact(brokerId, ownProfile.id);
      // Same broker view as the profile page: 3-layer merge, self-entered
      // funds as a range, never the raw buyer_users row.
      const { brokerBuyerCard } = await import("./buyers/profile-view.js");
      const { loadBrokerScope } = await import("./buyers/provenance-scope.js");
      const buyer = brokerBuyerCard(ownProfile, contact, await loadBrokerScope(brokerId));

      // List all buyerAccess rows for this buyer, then filter to those
      // on the broker's deals.
      const allAccesses = await storage.getBuyerAccessByBuyerUser(buyer.id);
      const dealsWithAccess: Array<{ dealId: string; businessName: string; lastAccessedAt: Date | null; viewCount: number | null; decision: string | null; }> = [];
      for (const a of allAccesses) {
        const deal = await storage.getDeal(a.dealId);
        if (!deal || deal.brokerId !== brokerId) continue;
        dealsWithAccess.push({
          dealId: deal.id,
          businessName: deal.businessName,
          lastAccessedAt: a.lastAccessedAt,
          viewCount: a.viewCount ?? 0,
          decision: a.decision ?? null,
        });
      }

      res.json({
        buyer,
        contact: contact ? {
          id: contact.id,
          tags: contact.tags,
          notes: contact.notes,
          source: contact.source,
          addedAt: contact.addedAt,
          crmProvider: contact.crmProvider ?? null,
          crmSyncedAt: contact.crmSyncedAt ?? null,
          crmProfile: contact.crmProfile ?? null,
        } : null,
        deals: dealsWithAccess,
      });
    } catch (err: any) {
      console.error("Error fetching buyer detail:", err);
      res.status(500).json({ error: "Failed to fetch buyer detail" });
    }
  });

  // Manually add a single buyer (form flow)
  app.post("/api/broker/buyers", requireBroker, async (req, res) => {
    try {
      const schema = z.object({
        brokerId: z.string().optional(), // ignored — session broker is authoritative
        email: z.string().email(),
        name: z.string().min(1),
        phone: z.string().optional().nullable(),
        company: z.string().optional().nullable(),
        title: z.string().optional().nullable(),
        linkedinUrl: z.string().optional().nullable(),
        buyerType: z.string().optional().nullable(),
        targetIndustries: z.array(z.string()).optional(),
        targetLocations: z.array(z.string()).optional(),
        liquidFunds: z.string().optional().nullable(),
        hasProofOfFunds: z.boolean().optional(),
        notes: z.string().optional().nullable(),
        tags: z.array(z.string()).optional(),
        sendInvite: z.boolean().default(false),
      });
      const body = schema.parse(req.body);
      body.brokerId = req.session.brokerId!; // never trust client-supplied broker

      const normalizedEmail = body.email.toLowerCase().trim();
      let buyerUser = await storage.getBuyerUserByEmail(normalizedEmail);

      if (buyerUser) {
        // Existing buyer — update profile fields only if they're empty (don't overwrite)
        const updates: Partial<BuyerUser> = {};
        if (!buyerUser.phone && body.phone) updates.phone = body.phone;
        if (!buyerUser.company && body.company) updates.company = body.company;
        if (!buyerUser.title && body.title) updates.title = body.title;
        if (!buyerUser.linkedinUrl && body.linkedinUrl) updates.linkedinUrl = body.linkedinUrl;
        if (!buyerUser.buyerType && body.buyerType) updates.buyerType = body.buyerType;
        if (!buyerUser.liquidFunds && body.liquidFunds) updates.liquidFunds = body.liquidFunds;
        if (body.targetIndustries && body.targetIndustries.length > 0 && (!buyerUser.targetIndustries || (buyerUser.targetIndustries as string[]).length === 0)) {
          updates.targetIndustries = body.targetIndustries as any;
        }
        if (body.targetLocations && body.targetLocations.length > 0 && (!buyerUser.targetLocations || (buyerUser.targetLocations as string[]).length === 0)) {
          updates.targetLocations = body.targetLocations as any;
        }
        if (Object.keys(updates).length > 0) {
          buyerUser = await storage.updateBuyerUser(buyerUser.id, withFieldSources(buyerUser, updates, "broker_import", null, body.brokerId));
        }
      } else if (body.sendInvite) {
        // Create via invite flow (sends set-password email)
        const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol || "https";
        const host = (req.headers["x-forwarded-host"] as string) || req.get("host");
        const baseUrl = process.env.APP_URL || `${proto}://${host}`;
        const invited = await inviteBuyerUser({
          email: normalizedEmail,
          name: body.name,
          phone: body.phone ?? null,
          company: body.company ?? null,
          title: body.title ?? null,
          linkedinUrl: body.linkedinUrl ?? null,
          invitedByBroker: body.brokerId,
          baseUrl,
        });
        buyerUser = invited.user;
        // Backfill any extra fields the invite path doesn't set
        const extraUpdates: Partial<BuyerUser> = {};
        if (body.buyerType) extraUpdates.buyerType = body.buyerType;
        if (body.liquidFunds) extraUpdates.liquidFunds = body.liquidFunds;
        if (body.hasProofOfFunds !== undefined) extraUpdates.hasProofOfFunds = body.hasProofOfFunds;
        if (body.targetIndustries && body.targetIndustries.length > 0) extraUpdates.targetIndustries = body.targetIndustries as any;
        if (body.targetLocations && body.targetLocations.length > 0) extraUpdates.targetLocations = body.targetLocations as any;
        if (Object.keys(extraUpdates).length > 0) {
          buyerUser = await storage.updateBuyerUser(buyerUser.id, extraUpdates);
        }
        if (buyerUser && invited.isNew) {
          buyerUser = (await storage.updateBuyerUser(buyerUser.id, { fieldSources: initialFieldSources(buyerUser, "broker_import", null, body.brokerId) } as any)) || buyerUser;
        }
      } else {
        // Create a buyer row without sending an invite email
        buyerUser = await storage.createBuyerUser({
          email: normalizedEmail,
          passwordHash: null,
          name: body.name,
          phone: body.phone ?? null,
          company: body.company ?? null,
          title: body.title ?? null,
          linkedinUrl: body.linkedinUrl ?? null,
          buyerCriteria: {},
          targetIndustries: (body.targetIndustries ?? []) as any,
          targetLocations: (body.targetLocations ?? []) as any,
          buyerType: body.buyerType ?? null,
          background: null,
          liquidFunds: body.liquidFunds ?? null,
          hasProofOfFunds: body.hasProofOfFunds ?? false,
          profileCompletionPct: 0, // placeholder — storage.createBuyerUser derives the real value
          emailVerified: false,
          source: "broker_invited",
          invitedByBroker: body.brokerId,
          invitedByDeal: null,
          resetToken: null,
          resetTokenExpiresAt: null,
        } as any);
        buyerUser = (await storage.updateBuyerUser(buyerUser.id, { fieldSources: initialFieldSources(buyerUser, "broker_import", null, body.brokerId) } as any)) || buyerUser;
      }

      if (!buyerUser) {
        return res.status(500).json({ error: "Failed to create or find buyer" });
      }

      const contact = await storage.upsertBrokerBuyerContact({
        brokerId: body.brokerId,
        buyerUserId: buyerUser.id,
        source: "manual",
        tags: (body.tags ?? []) as any,
        notes: body.notes ?? null,
      });

      // Never the raw row: buyer_users carries the password hash, any pending
      // set-password/reset token and the buyer's exact self-entered funds.
      const { brokerBuyerCard } = await import("./buyers/profile-view.js");
      const { loadBrokerScope } = await import("./buyers/provenance-scope.js");
      res.json({ buyerUser: brokerBuyerCard(buyerUser, contact, await loadBrokerScope(body.brokerId)), contact });
    } catch (err: any) {
      if (err.name === "ZodError") {
        return res.status(400).json({ error: "Invalid buyer data", details: err.errors });
      }
      console.error("Error creating broker buyer contact:", err);
      res.status(500).json({ error: "Failed to create buyer" });
    }
  });

  // Bulk import via CSV
  app.post("/api/broker/buyers/import-csv", requireBroker, async (req, res) => {
    try {
      const schema = z.object({
        brokerId: z.string().optional(), // ignored — session broker is authoritative
        csv: z.string().min(1),
        sendInvites: z.boolean().default(false),
      });
      const body = schema.parse(req.body);
      body.brokerId = req.session.brokerId!; // never trust client-supplied broker

      // Parse CSV — naive but handles quoted fields
      const rows = parseCsv(body.csv);
      if (rows.length === 0) {
        return res.status(400).json({ error: "CSV is empty" });
      }
      const header = rows[0].map(h => h.trim().toLowerCase().replace(/[\s_-]/g, ""));
      const emailIdx = header.findIndex(h => h === "email" || h === "emailaddress");
      if (emailIdx === -1) {
        return res.status(400).json({ error: "CSV must include an 'email' column" });
      }
      const col = (name: string) => header.findIndex(h => h === name);
      const idx = {
        email: emailIdx,
        name: col("name") !== -1 ? col("name") : col("fullname"),
        phone: col("phone"),
        company: col("company"),
        title: col("title"),
        linkedinUrl: col("linkedinurl") !== -1 ? col("linkedinurl") : col("linkedin"),
        buyerType: col("buyertype") !== -1 ? col("buyertype") : col("type"),
        targetIndustries: col("targetindustries") !== -1 ? col("targetindustries") : col("industries"),
        targetLocations: col("targetlocations") !== -1 ? col("targetlocations") : col("locations"),
        liquidFunds: col("liquidfunds"),
        hasProofOfFunds: col("hasproofoffunds") !== -1 ? col("hasproofoffunds") : col("proofoffunds"),
        notes: col("notes"),
        tags: col("tags"),
      };

      const accepted: Array<{ email: string; name: string; status: "created" | "updated"; buyerUserId: string }> = [];
      const rejected: Array<{ row: number; reason: string; raw: string[] }> = [];

      const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol || "https";
      const host = (req.headers["x-forwarded-host"] as string) || req.get("host");
      const baseUrl = process.env.APP_URL || `${proto}://${host}`;

      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (row.length === 0 || row.every(c => !c.trim())) continue;

        const rawEmail = (row[idx.email] || "").trim().toLowerCase();
        if (!rawEmail || !rawEmail.includes("@")) {
          rejected.push({ row: i + 1, reason: "Missing or invalid email", raw: row });
          continue;
        }

        const name = (idx.name !== -1 && row[idx.name]?.trim()) || rawEmail.split("@")[0];
        const phone = idx.phone !== -1 ? (row[idx.phone]?.trim() || null) : null;
        const company = idx.company !== -1 ? (row[idx.company]?.trim() || null) : null;
        const title = idx.title !== -1 ? (row[idx.title]?.trim() || null) : null;
        const linkedinUrl = idx.linkedinUrl !== -1 ? (row[idx.linkedinUrl]?.trim() || null) : null;
        const buyerType = idx.buyerType !== -1 ? (row[idx.buyerType]?.trim().toLowerCase() || null) : null;
        const liquidFunds = idx.liquidFunds !== -1 ? (row[idx.liquidFunds]?.trim() || null) : null;
        const notes = idx.notes !== -1 ? (row[idx.notes]?.trim() || null) : null;

        const splitList = (s: string | undefined) => s
          ? s.split(/[;|]/).map(x => x.trim()).filter(Boolean)
          : [];
        const targetIndustries = splitList(idx.targetIndustries !== -1 ? row[idx.targetIndustries] : "");
        const targetLocations = splitList(idx.targetLocations !== -1 ? row[idx.targetLocations] : "");
        const tagsList = splitList(idx.tags !== -1 ? row[idx.tags] : "");

        const parseBool = (v: string | undefined) => {
          if (!v) return false;
          const s = v.trim().toLowerCase();
          return s === "yes" || s === "y" || s === "true" || s === "1";
        };
        const hasProofOfFunds = idx.hasProofOfFunds !== -1 ? parseBool(row[idx.hasProofOfFunds]) : false;

        try {
          let buyerUser = await storage.getBuyerUserByEmail(rawEmail);
          let status: "created" | "updated" = "updated";

          if (buyerUser) {
            // Fill in any missing fields without overwriting
            const updates: Partial<BuyerUser> = {};
            if (!buyerUser.phone && phone) updates.phone = phone;
            if (!buyerUser.company && company) updates.company = company;
            if (!buyerUser.title && title) updates.title = title;
            if (!buyerUser.linkedinUrl && linkedinUrl) updates.linkedinUrl = linkedinUrl;
            if (!buyerUser.buyerType && buyerType) updates.buyerType = buyerType;
            if (!buyerUser.liquidFunds && liquidFunds) updates.liquidFunds = liquidFunds;
            if (Object.keys(updates).length > 0) {
              buyerUser = await storage.updateBuyerUser(buyerUser.id, withFieldSources(buyerUser, updates, "csv", null, body.brokerId));
            }
          } else if (body.sendInvites) {
            const invited = await inviteBuyerUser({
              email: rawEmail,
              name,
              phone,
              company,
              title,
              linkedinUrl,
              invitedByBroker: body.brokerId,
              baseUrl,
            });
            buyerUser = invited.user;
            const extra: Partial<BuyerUser> = {};
            if (buyerType) extra.buyerType = buyerType;
            if (liquidFunds) extra.liquidFunds = liquidFunds;
            if (hasProofOfFunds) extra.hasProofOfFunds = hasProofOfFunds;
            if (targetIndustries.length > 0) extra.targetIndustries = targetIndustries as any;
            if (targetLocations.length > 0) extra.targetLocations = targetLocations as any;
            if (Object.keys(extra).length > 0) {
              buyerUser = await storage.updateBuyerUser(buyerUser.id, extra);
            }
            if (buyerUser && invited.isNew) {
              buyerUser = (await storage.updateBuyerUser(buyerUser.id, { fieldSources: initialFieldSources(buyerUser, "csv", null, body.brokerId) } as any)) || buyerUser;
            }
            status = "created";
          } else {
            buyerUser = await storage.createBuyerUser({
              email: rawEmail,
              passwordHash: null,
              name,
              phone,
              company,
              title,
              linkedinUrl,
              buyerCriteria: {},
              targetIndustries: targetIndustries as any,
              targetLocations: targetLocations as any,
              buyerType,
              background: null,
              liquidFunds,
              hasProofOfFunds,
              profileCompletionPct: 0, // placeholder — storage.createBuyerUser derives the real value
              emailVerified: false,
              source: "broker_invited",
              invitedByBroker: body.brokerId,
              invitedByDeal: null,
              resetToken: null,
              resetTokenExpiresAt: null,
            } as any);
            buyerUser = (await storage.updateBuyerUser(buyerUser.id, { fieldSources: initialFieldSources(buyerUser, "csv", null, body.brokerId) } as any)) || buyerUser;
            status = "created";
          }

          if (!buyerUser) {
            rejected.push({ row: i + 1, reason: "Failed to create buyer record", raw: row });
            continue;
          }

          await storage.upsertBrokerBuyerContact({
            brokerId: body.brokerId,
            buyerUserId: buyerUser.id,
            source: "csv",
            tags: tagsList as any,
            notes,
          });

          accepted.push({ email: rawEmail, name, status, buyerUserId: buyerUser.id });
        } catch (rowErr: any) {
          rejected.push({ row: i + 1, reason: rowErr.message || "Unknown error", raw: row });
        }
      }

      res.json({
        accepted,
        rejected,
        totalRows: rows.length - 1,
      });
    } catch (err: any) {
      if (err.name === "ZodError") {
        return res.status(400).json({ error: "Invalid import data", details: err.errors });
      }
      console.error("CSV import error:", err);
      res.status(500).json({ error: err.message || "Failed to import CSV" });
    }
  });

  // Update a contact (tags, notes)
  app.patch("/api/broker/buyers/:buyerId", requireBroker, async (req, res) => {
    try {
      const brokerId = req.session.brokerId!;
      const schema = z.object({
        tags: z.array(z.string()).optional(),
        notes: z.string().nullable().optional(),
      });
      const updates = schema.parse(req.body);
      if (!(await isBuyerInBrokerList(brokerId, req.params.buyerId))) return res.status(404).json({ error: "Buyer not found" });

      // A row so tags/notes can be set on buyers first seen via deal access.
      // A buyer the broker removed (still listed through access) starts fresh:
      // the notes and edits the removal set aside don't quietly come back.
      const { ensureContact } = await import("./buyers/profile-data.js");
      const contact = await ensureContact(brokerId, req.params.buyerId);

      const updated = await storage.updateBrokerBuyerContact(contact.id, {
        ...(updates.tags !== undefined ? { tags: updates.tags as any } : {}),
        ...(updates.notes !== undefined ? { notes: updates.notes } : {}),
      });
      res.json(updated);
    } catch (err: any) {
      if (err.name === "ZodError") {
        return res.status(400).json({ error: "Invalid update", details: err.errors });
      }
      console.error("Error updating buyer contact:", err);
      res.status(500).json({ error: "Failed to update contact" });
    }
  });

  // ════════════════════════════════════════════════════════════
  // SUGGESTED BUYERS + BROKER-CONTROLLED OUTREACH
  // ════════════════════════════════════════════════════════════
  // Product rule: Cimple NEVER auto-sends outreach. The broker reviews
  // suggested buyers, picks who to contact, edits the AI-drafted message,
  // and clicks send. The broker is always the one who initiates contact.

  // Suggested buyers for a deal — runs match engine + composite scoring
  // against the broker's full buyer contact list, ranked.
  app.get("/api/deals/:dealId/suggested-buyers", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const { dealId } = req.params;
      const { scoreBuyersForDeal, topDimensions, passesFirstPass, reachedBuyers, suggestionPools, isExcludedBuyer } = await import("./matching/suggested.js");
      const { isDeepCheckRunning } = await import("./matching/deep-check.js");
      // Read "is it running" BEFORE the deal: the job writes its final state
      // and only then stops running, so a stored "running" with no live job
      // is a real failure — checked the other way round, a check that just
      // finished read as failed.
      const deepRunning = isDeepCheckRunning(dealId);
      const deal = await storage.getDeal(dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });

      const [scoredRaw, existingOutreach, existingAccess, approvals] = await Promise.all([
        scoreBuyersForDeal(deal),
        storage.getDealOutreachByDeal(dealId),
        storage.getBuyerAccessByDeal(dealId),
        storage.getBuyerApprovalRequestsByDeal(dealId),
      ]);
      // Matched on account id AND email: access rows aren't linked to the
      // buyer's account until they verify, so id-only missed them. Buyers
      // submitted for approval are further along the pipeline too.
      const reached = reachedBuyers(existingOutreach, existingAccess, approvals);
      const deep = (deal.buyerDeepCheck as BuyerDeepCheck | null) || null;
      // One definition of who is suggested / deep-checked (suggestionPools),
      // shared with the deep-check job so every count agrees.
      const pools = suggestionPools(scoredRaw, reached);
      const inPool = new Set(pools.pool.map((s) => s.buyer.id));

      const scored = scoredRaw.map((s) => {
        const { buyer: buyerUser, contact, breakdown, score, lastActivityAt } = s;
        // A verdict is shown only for a buyer the list still suggests (an
        // older check may hold results for buyers who since got access).
        const aiCheck = inPool.has(buyerUser.id) ? deep?.results?.[buyerUser.id] ?? null : null;
        const { alreadyHasAccess, alreadyContacted, inApproval } = reached(buyerUser);
        const excluded = isExcludedBuyer(s);
        // With an AI verdict, rank on it (60%) blended with the lead score.
        const rankScore = aiCheck ? Math.round(aiCheck.fitScore * 0.6 + score.total * 0.4) : score.total;
        return {
          buyerUserId: buyerUser.id,
          name: buyerUser.name,
          email: buyerUser.email,
          company: buyerUser.company,
          title: buyerUser.title,
          buyerType: buyerUser.buyerType,
          hasProofOfFunds: buyerUser.hasProofOfFunds,
          profileCompletionPct: buyerUser.profileCompletionPct,
          targetIndustries: buyerUser.targetIndustries,
          source: contact?.source ?? "deal",
          tags: contact?.tags ?? [],
          alreadyHasAccess,
          alreadyContacted,
          inApproval,
          passesFirstPass: passesFirstPass(s),
          excluded,
          excludedBy: excluded ? (breakdown?.excludedBy ?? null) : null,
          // An exclusion that may not apply (a market the business serves, a narrower slice): the broker checks.
          exclusionCaution: !excluded ? (breakdown?.exclusionCaution?.note ?? null) : null,
          match: breakdown ? {
            criteriaMatched: breakdown.criteriaMatched,
            criteriaTested: breakdown.criteriaTested,
            deterministicScore: breakdown.deterministicScore,
            topDimensions: topDimensions(breakdown),
          } : null,
          qualifiedScore: {
            total: score.total,
            tier: score.tier,
            reasons: score.reasons,
            breakdown: score.breakdown,
          },
          aiCheck: aiCheck ? {
            verdict: aiCheck.verdict,
            fitScore: aiCheck.fitScore,
            whyFit: aiCheck.whyFit,
            watchOuts: aiCheck.watchOuts,
            checkedAt: aiCheck.checkedAt,
          } : null,
          rankScore,
          lastActivityAt,
        };
      });

      // AI-checked buyers first (by blended rank), then the rest by lead score.
      scored.sort((a, b) => {
        if (!!a.aiCheck !== !!b.aiCheck) return a.aiCheck ? -1 : 1;
        if (b.rankScore !== a.rankScore) return b.rankScore - a.rankScore;
        return (b.match?.criteriaMatched ?? 0) - (a.match?.criteriaMatched ?? 0);
      });

      res.json({
        dealId,
        businessName: deal.businessName,
        industry: deal.industry,
        suggested: scored,
        totalCandidates: scored.length,
        deepCheck: deep ? {
          status: deepRunning ? "running" : deep.status === "running" ? "failed" : deep.status,
          total: deep.total, done: deep.done, skipped: deep.skipped ?? 0,
          startedAt: deep.startedAt, finishedAt: deep.finishedAt ?? null, error: deep.error ?? null,
        } : null,
        firstPassCount: pools.candidates.length,
        counts: {
          suggested: pools.pool.length,
          deepCheckable: pools.candidates.length,
          excluded: pools.excluded.length,
          withAccess: pools.withAccess.length,
        },
      });
    } catch (err: any) {
      console.error("Error fetching suggested buyers:", err);
      res.status(500).json({ error: "Failed to fetch suggested buyers" });
    }
  });

  // Likely acquirers from outside the broker's list (web research, cited).
  app.get("/api/deals/:dealId/external-acquirers", requireBroker, requireOwnedDeal, async (req, res) => {
    const { isExternalSearchRunning } = await import("./matching/external-acquirers.js");
    const searchRunning = isExternalSearchRunning(req.params.dealId); // before the read — see suggested-buyers
    const deal = await storage.getDeal(req.params.dealId);
    if (!deal) return res.status(404).json({ error: "Deal not found" });
    const s = (deal.externalAcquirers as any) || null;
    if (s && s.status === "running" && !searchRunning) s.status = "failed";
    res.json(s ?? { status: "none", results: [] });
  });
  app.post("/api/deals/:dealId/external-acquirers", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const { startExternalAcquirerSearch } = await import("./matching/external-acquirers.js");
      const r = await startExternalAcquirerSearch(req.params.dealId, { includeExcluded: req.body?.includeExcluded === true });
      if (!r.started) return res.status(r.reason === "already_running" ? 409 : 400).json({ error: r.reason === "already_running" ? "Already researching" : "AI is unavailable right now" });
      res.status(202).json({ started: true });
    } catch (err) {
      console.error("[external-acquirers] start failed:", err);
      res.status(500).json({ error: "Couldn't start the research" });
    }
  });

  // Fit of every buyer who has the CIM (Buyers tab → "Have the CIM"). Kept
  // current automatically: re-scored by the rule-based engine whenever the
  // buyer's criteria or the deal's facts changed since the stored score
  // (server/matching/access-fit.ts). Never calls the AI.
  app.get("/api/deals/:dealId/buyer-fit", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const deal = await storage.getDeal(req.params.dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });
      const { loadDealBuyerFits } = await import("./matching/access-fit.js");
      const { fits } = await loadDealBuyerFits(deal);
      res.json({ fits });
    } catch (err) {
      console.error("[buyer-fit] load failed:", err);
      res.status(500).json({ error: "Couldn't work out buyer fit" });
    }
  });

  // The broker's "Check fit with AI" on one buyer (uses the AI; rate-limited
  // in server/index.ts). The AI-inclusive score is kept until the buyer's
  // criteria or the deal's facts change.
  app.post("/api/deals/:dealId/buyer-fit/:accessId/ai", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const deal = await storage.getDeal(req.params.dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });
      const access = await storage.getBuyerAccess(req.params.accessId);
      if (!access || access.dealId !== deal.id || access.revokedAt) return res.status(404).json({ error: "Buyer not found" });
      const { loadDealBuyerFits } = await import("./matching/access-fit.js");
      const { fits, aiUnavailable } = await loadDealBuyerFits(deal, { withAIFor: access.id });
      const fit = fits.find((f) => f.accessId === access.id) ?? null;
      res.json({ fit, aiUnavailable: aiUnavailable ?? null });
    } catch (err) {
      console.error("[buyer-fit] AI check failed:", err);
      res.status(500).json({ error: "Couldn't check fit with AI" });
    }
  });

  // "Copy to their profile" (Fit dialog): criteria saved on this deal's access
  // row by the old per-deal editor go into the broker's private edits of the
  // buyer's profile — gap-fill only, never the buyer's own profile. No AI.
  app.post("/api/deals/:dealId/buyer-fit/:accessId/copy-criteria", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const deal = await storage.getDeal(req.params.dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });
      const { copyDealCriteriaToProfile } = await import("./matching/access-fit.js");
      const r = await copyDealCriteriaToProfile(deal, req.params.accessId);
      if (!r.ok) return res.status(r.status).json({ error: r.error, ...(r.code ? { code: r.code } : {}) });
      res.json({ buyerId: r.buyerId, copied: r.copied });
    } catch (err) {
      console.error("[buyer-fit] copy criteria failed:", err);
      res.status(500).json({ error: "Couldn't copy these criteria" });
    }
  });

  // AI deep check of every buyer who passes the first-pass match (background).
  app.post("/api/deals/:dealId/buyer-deep-check", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const { startBuyerDeepCheck } = await import("./matching/deep-check.js");
      const r = await startBuyerDeepCheck(req.params.dealId);
      if (!r.started) {
        return res.status(r.reason === "already_running" ? 409 : 400).json({
          error: r.reason === "already_running" ? "A deep check is already running" : r.reason === "no_ai" ? "AI is unavailable right now" : "Deal not found",
        });
      }
      res.status(202).json({ started: true });
    } catch (err) {
      console.error("[deep-check] start failed:", err);
      res.status(500).json({ error: "Couldn't start the deep check" });
    }
  });

  // Draft outreach emails for selected buyers (AI-generated, never sent automatically).
  // Returns drafts in-memory; the broker reviews and edits before calling /send-outreach.
  // Drafts are written a few at a time (the bulk ceiling in
  // server/security/bulk-limits.ts); a rate-limited or overloaded draft is retried.
  const OUTREACH_DRAFTS_AT_ONCE = BULK_DRAFT_CONCURRENCY;
  const OUTREACH_RETRY_DELAYS_MS = [2_000, 8_000];
  app.post("/api/deals/:dealId/draft-outreach", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const { dealId } = req.params;
      const schema = z.object({
        buyerUserIds: z.array(z.string().max(100)).min(1),
        template: z.string().max(4000).optional(),  // optional broker template / instructions
      });
      const parsed = schema.parse(req.body);
      const buyerUserIds = Array.from(new Set(parsed.buyerUserIds));
      const { template } = parsed;
      if (buyerUserIds.length > BULK_OUTREACH_MAX) {
        return res.status(400).json({ error: `Draft up to ${BULK_OUTREACH_MAX} buyers at a time — select fewer and draft the rest next.`, code: "too_many_buyers" });
      }

      const deal = await storage.getDeal(dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });

      const branding = await storage.getBrandingByBroker(deal.brokerId);
      const brokerCompany = (branding as any)?.companyName || "";

      // PRE-NDA outreach must be blind-safe: no business name, no city, no
      // exact figures (observed leak: "Harbourline Dental Group… Kitchener…
      // $2M revenue, $628K SDE" in a cold email). Bands + region only.
      const { blindDealSummary } = await import("./buyers/blind-deal-summary.js");
      const brokerUser = deal.brokerId ? await storage.getUser(deal.brokerId).catch(() => undefined) : undefined;
      const brokerName = brokerDisplayName(brokerUser) || "Your broker";
      const dealSummary = blindDealSummary(deal);
      // Deterministic identity check on every draft (and on the deep-check
      // hook fed into it): a draft naming the business, owner, staff, city,
      // street or contacts is discarded for the blind-safe template.
      const outreachTerms = blindLeakTerms(deal, { codename: deal.blindCodename });
      // …and the hook never draws on an item kept from buyers (an angle stored before this check included).
      const { outreachAngleGuard, angleKeepsOut } = await import("./matching/angle-keep-out.js");
      const { keepOutFor } = await import("./cim/keep-out.js");
      const dealInfo = ((deal.extractedInfo as Record<string, unknown>) || {});
      const angleGuard = outreachAngleGuard(dealInfo, await keepOutFor(deal.id, dealInfo));
      // Only buyers on this broker's own list can be drafted to.
      const listed = await filterBuyersInBrokerList(req.session.brokerId!, buyerUserIds);
      // A published teaser: each draft carries the buyer's own link, filled in at send.
      const { getDealTeaser, teaserPublished } = await import("./teaser/store");
      const { TEASER_LINK_TOKEN, TEASER_LINK_LINE, TEASER_NEXT_STEP, withTeaserLink } = await import("./teaser/outreach");
      const teaserLink = await getDealTeaser(deal.id).then(teaserPublished).catch((err) => {
        console.warn("[outreach] teaser state unavailable:", (err as Error)?.message);
        return false;
      });

      // A few drafts at a time, each retried on a rate limit or overload:
      // one parallel call per selected buyer (81 at once) tripped the rate
      // limit and quietly turned most drafts into the generic template.
      const drafts = await mapWithLimit(buyerUserIds, OUTREACH_DRAFTS_AT_ONCE, async (buyerUserId) => {
        if (!listed.has(buyerUserId)) return null;
        const ownBuyer = await storage.getBuyerUser(buyerUserId);
        if (!ownBuyer) return null;
        // The broker's effective view of the buyer (their edits > buyer's own > CRM).
        const contactRow = await storage.getBrokerBuyerContact(req.session.brokerId!, buyerUserId);
        const buyer = mergeBuyerProfile(ownBuyer, contactRow?.crmProfile as CrmBuyerProfile | null, contactRow?.brokerProfile as BrokerBuyerOverlay | null);

        const buyerProfile = {
          name: buyer.name,
          company: buyer.company,
          buyerType: buyer.buyerType,
          targetIndustries: buyer.targetIndustries,
          targetLocations: buyer.targetLocations,
        };
        // The AI deep check's blind-safe hook for this buyer, when there is one.
        const deepResult = ((deal as any).buyerDeepCheck as BuyerDeepCheck | null)?.results?.[buyerUserId];
        const rawAngle = deepResult?.outreachAngle || null;
        const outreachAngle = rawAngle && findBlindLeaks(rawAngle, outreachTerms).length === 0 && angleKeepsOut(rawAngle, angleGuard) ? rawAngle : null;

        // Try to use Claude Sonnet to personalise; fall back to a deterministic
        // template if the API is unavailable or the draft isn't blind-safe.
        const defaultSubject = `Confidential opportunity: ${deal.industry}${dealSummary.region ? ` — ${dealSummary.region}` : ""}`;
        // First name, past a title ("Dr. Priya Raman" → Priya, never "Hi Dr.,").
        const firstName = buyer.name.replace(/^\s*(?:dr|mr|mrs|ms|mx|prof)\.?\s+/i, "").split(" ")[0] || buyer.name;
        const templateBody = () => `Hi ${firstName},\n\nI'm reaching out because a ${deal.industry} business${dealSummary.region ? ` in ${dealSummary.region}` : ""} just came to market and it looks like a strong fit for your acquisition criteria${buyer.targetIndustries && (buyer.targetIndustries as string[]).length > 0 ? ` in ${(buyer.targetIndustries as string[]).slice(0, 2).join(" / ")}` : ""}.\n\nQuick highlights:\n• Industry: ${deal.industry}${dealSummary.subIndustry ? ` (${dealSummary.subIndustry})` : ""}\n${dealSummary.revenueBand ? `• Revenue: ${dealSummary.revenueBand}\n` : ""}${dealSummary.tenure ? `• ${dealSummary.tenure}\n` : ""}\n${teaserLink ? `${TEASER_LINK_LINE}\n\n${TEASER_NEXT_STEP}` : "If you'd like a closer look, just reply and I'll set up secure access to the full confidential overview."}\n\nNo pressure either way — happy to answer questions if it's a fit.\n\nBest,\n${brokerName}${brokerCompany ? `\n${brokerCompany}` : ""}`;
        let subject = defaultSubject;
        let body = "";
        // Why this draft is the generic template (shown on its card), if it is.
        let templateReason: "ai_unavailable" | "identifying_details" | "unusable_draft" | null = null;

        try {
          const aiResp = await withAiRetry(() => anthropic.messages.create({
            model: "claude-sonnet-4-5",
            max_tokens: 600,
            system: `You are an M&A broker drafting a personalised, low-pressure outreach email to a qualified buyer about a new business-for-sale opportunity. This email goes out BEFORE an NDA: it must be impossible to identify the business from it. Never state the business name, owner, street, city, or exact figures — refer to it by its codename or "a ${deal.industry} business", use only the region and the ranges provided. The tone is professional, warm, and concise — not salesy. Always include a clear, no-pressure invitation to learn more. Return ONLY a JSON object: {"subject": "...", "body": "..."}.`,
            messages: [{
              role: "user",
              content: `Draft an outreach email for this buyer about this deal.

DEAL:
${JSON.stringify(dealSummary, null, 2)}

BUYER PROFILE:
${JSON.stringify(buyerProfile, null, 2)}

BROKER FIRM: ${brokerCompany || "(none — sign with the broker's name only)"}

${template ? `BROKER NOTES / TEMPLATE GUIDANCE:\n${template}` : ""}
${outreachAngle ? `WHY THIS BUYER FITS (use as the opening angle, in your own words; still never name the business, city or exact figures):\n${outreachAngle}\n` : ""}

Requirements:
- Subject line: under 70 chars, mentions the industry and a key signal (size, location, or growth)
- Body: 4–6 short paragraphs max, ~150 words
- Reference 1–2 specific things from the buyer's profile (their target industry/location/buyer type)
- Mention 2–3 deal highlights using ONLY the bands/region given (e.g. "revenue in the $1M–$2M range", "10+ years established", "${dealSummary.region || "the region"}")
- NEVER name the business, the city, the owner, or any exact dollar figure — this is pre-NDA
${teaserLink
  ? `- Include this line exactly, on its own line: "${TEASER_LINK_LINE}" (keep ${TEASER_LINK_TOKEN} exactly as written — the system puts the buyer's own link there)
- Then the next step: "${TEASER_NEXT_STEP}"`
  : `- Include a clear next-step invitation: "If you'd like a closer look, just reply and I'll set up secure access to the full confidential overview"`}
- DO NOT include an asking price
- DO NOT make up financial figures
- DO NOT promise exclusivity or discounts
- Sign off as "${brokerName}"${brokerCompany ? ` of ${brokerCompany}` : ""} — never a placeholder

Return JSON only.`,
            }],
          }), OUTREACH_RETRY_DELAYS_MS);

          const raw = aiResp.content[0]?.type === "text" ? aiResp.content[0].text : "";
          let parsed: { subject?: unknown; body?: unknown } = {};
          try {
            parsed = JSON.parse(raw.replace(/```json\s*/gi, "").replace(/```/g, "").trim());
          } catch {
            templateReason = "unusable_draft";
          }
          const aiSubject = typeof parsed.subject === "string" ? parsed.subject.trim() : "";
          const aiBody = typeof parsed.body === "string" ? parsed.body.trim() : "";
          const leaks = findBlindLeaks(`${aiSubject}\n${aiBody}`, outreachTerms);
          if (aiBody && leaks.length === 0) {
            if (aiSubject) subject = aiSubject;
            body = aiBody;
          } else if (leaks.length > 0) {
            templateReason = "identifying_details";
            console.warn("[outreach] AI draft named identifying details — discarded for the blind-safe template");
          } else {
            templateReason = templateReason ?? "unusable_draft";
          }
        } catch (aiErr: any) {
          templateReason = "ai_unavailable";
          console.warn("[outreach] AI draft failed for", buyer.email, `(${aiErr?.status ?? aiErr?.message}) — falling back to template`);
        }
        if (!body) {
          subject = defaultSubject;
          body = templateBody();
        }
        // The teaser line is always there when a teaser is published (appended before the sign-off if the draft left it out).
        if (teaserLink) body = withTeaserLink(body, brokerName);

        return {
          buyerUserId: buyer.id,
          buyerName: buyer.name,
          buyerEmail: buyer.email,
          subject,
          body,
          teaserLink,
          /** False = the generic template (templateReason says why) — the card says so. */
          personalised: templateReason === null,
          templateReason,
        };
      });

      const validDrafts = drafts.filter((d): d is NonNullable<typeof d> => !!d);
      // Where buyers' replies will land (the drafts say "just reply").
      res.json({ drafts: validDrafts, replyTo: outreachReplyTo(brokerUser) });
    } catch (err: any) {
      if (err.name === "ZodError") {
        return res.status(400).json({ error: "Invalid request", details: err.errors });
      }
      console.error("Error drafting outreach:", err);
      res.status(500).json({ error: "Failed to draft outreach" });
    }
  });

  // Send approved outreach — broker has reviewed and edited; now actually
  // dispatch via Resend and record in dealOutreach.
  app.post("/api/deals/:dealId/send-outreach", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const { dealId } = req.params;
      const schema = z.object({
        outreach: z.array(z.object({
          buyerUserId: z.string().max(100),
          subject: z.string().min(1).max(300),
          body: z.string().min(1).max(20000),
          // Optional snapshot data captured at suggestion time
          qualifiedScore: z.number().optional(),
          matchScore: z.number().optional(),
          topDimensions: z.array(z.string().max(80)).max(20).optional(),
        })).min(1),
      });
      const parsedOutreach = schema.parse(req.body).outreach;
      // One email per buyer per send, and a ceiling per request.
      const seenBuyers = new Set<string>();
      const outreach = parsedOutreach.filter((o) => !seenBuyers.has(o.buyerUserId) && !!seenBuyers.add(o.buyerUserId));
      if (outreach.length > BULK_OUTREACH_MAX) {
        return res.status(400).json({ error: `Send to up to ${BULK_OUTREACH_MAX} buyers at a time — send the rest in a second batch.`, code: "too_many_buyers" });
      }

      const deal = await storage.getDeal(dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });

      const branding = await storage.getBrandingByBroker(deal.brokerId);
      const brokerCompany = (branding as any)?.companyName || "Cimple";
      // The drafts end "just reply and I'll set up secure access": replies
      // must reach the broker's own inbox, never Cimple's unmonitored sender.
      // Without an email on the broker's account there is nowhere for them
      // to go — refuse rather than send emails whose replies are lost.
      const brokerUser = await storage.getUser(req.session.brokerId!).catch(() => undefined);
      const replyTo = outreachReplyTo(brokerUser);
      if (!replyTo) {
        return res.status(400).json({
          error: "Your account has no email address on file, so buyers' replies to these emails would reach no one. Ask Cimple support to add your email before sending.",
          code: "no_reply_to",
        });
      }
      // Never the login username on the From line: the display name, else the brokerage.
      const fromName = outreachFromName(brokerUser, (branding as any)?.companyName);
      // Emails that link to the teaser need it published — refused before anything is sent.
      const { getDealTeaser, teaserPublished } = await import("./teaser/store");
      const { hasTeaserToken, ensureTeaserLinkFor, paragraphHtml } = await import("./teaser/outreach");
      const wantsTeaser = outreach.some((o) => hasTeaserToken(o.body));
      const teaserRow = wantsTeaser ? await getDealTeaser(dealId) : null;
      if (wantsTeaser && !teaserPublished(teaserRow)) {
        return res.status(409).json({ code: "teaser_not_published", error: "Publish the teaser before sending — the emails link to it." });
      }
      const appBase = process.env.APP_URL || `${req.protocol}://${req.get("host")}`;
      // Only buyers on this broker's own list can be emailed from here.
      const listed = await filterBuyersInBrokerList(req.session.brokerId!, outreach.map((o) => o.buyerUserId));
      const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

      const results = await mapWithConcurrency(outreach, BULK_AI_CONCURRENCY, async (item) => {
        const buyer = listed.has(item.buyerUserId) ? await storage.getBuyerUser(item.buyerUserId) : undefined;
        if (!buyer) {
          return { buyerUserId: item.buyerUserId, status: "failed", error: "Buyer not found" };
        }

        // The buyer's own teaser link where the email says {teaser link}
        // (their existing link on this deal, else a new Teaser link).
        let teaserUrl: string | null = null;
        let teaserAccessId: string | null = null;
        if (hasTeaserToken(item.body) && teaserRow) {
          const link = await ensureTeaserLinkFor(deal, teaserRow, { email: buyer.email, name: buyer.name, company: buyer.company, id: buyer.id, emailVerified: buyer.emailVerified });
          teaserUrl = `${appBase}/view/${link.access.accessToken}`;
          teaserAccessId = link.access.id;
        }
        // Render plain-text body into a simple HTML wrapper (escaped — the
        // broker's text is never interpreted as HTML; the link is a link).
        const htmlBody = item.body
          .split("\n\n")
          .map(p => `<p style="margin:0 0 16px 0;color:#333;font-size:14px;line-height:1.6;">${paragraphHtml(p, teaserUrl, esc)}</p>`)
          .join("");
        const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:24px;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#fff;padding:32px 28px;border-radius:8px;border:1px solid #e5e5e5;">
    ${htmlBody}
  </div>
  <p style="text-align:center;color:#999;font-size:11px;margin-top:16px;">
    Sent via Cimple on behalf of ${esc(brokerCompany)}
  </p>
</body>
</html>`;

        const sent = await sendDirectEmail(buyer.email, item.subject, html, undefined, {
          replyTo,
          fromName,
        });

        // Record the outreach regardless of email success — we want full audit
        const record = await storage.createDealOutreach({
          dealId,
          brokerId: deal.brokerId,
          buyerUserId: buyer.id,
          buyerEmail: buyer.email,
          buyerName: buyer.name,
          qualifiedScore: item.qualifiedScore ?? null,
          matchScore: item.matchScore ?? null,
          topDimensions: (item.topDimensions ?? []) as any,
          channel: "email",
          subject: item.subject,
          // The audit keeps what was sent, with the link's place marked (never the token itself).
          body: item.body,
          teaserAccessId,
          status: sent ? "sent" : "failed",
          sentAt: sent ? new Date() : null,
          openedAt: null,
          clickedAt: null,
          repliedAt: null,
          errorMessage: sent ? null : "Email delivery failed (check Resend configuration)",
        });

        return {
          outreachId: record.id,
          buyerUserId: buyer.id,
          buyerName: buyer.name,
          buyerEmail: buyer.email,
          status: record.status,
        };
      });

      const sent = results.filter(r => r.status === "sent").length;
      res.json({
        sent,
        total: results.length,
        results,
      });
    } catch (err: any) {
      if (err.name === "ZodError") {
        return res.status(400).json({ error: "Invalid request", details: err.errors });
      }
      console.error("Error sending outreach:", err);
      res.status(500).json({ error: "Failed to send outreach" });
    }
  });

  // Outreach history for a deal — every email the broker has sent
  app.get("/api/deals/:dealId/outreach-history", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const { dealId } = req.params;
      const history = await storage.getDealOutreachByDeal(dealId);
      res.json({ history });
    } catch (err: any) {
      console.error("Error fetching outreach history:", err);
      res.status(500).json({ error: "Failed to fetch outreach history" });
    }
  });

  // Logo upload endpoint (base64 from frontend)
  app.post("/api/upload-logo", requireBroker, async (req, res) => {
    try {
      const { data, filename } = req.body;
      if (!data || !filename) {
        return res.status(400).json({ error: "Missing data or filename" });
      }
      const ext = path.extname(filename).toLowerCase() || ".png";
      // No SVG: /uploads is served from the app origin with CSP off, so an
      // SVG logo could run script. New uploads use POST /api/cim-templates/brand-logo.
      const allowed = [".png", ".jpg", ".jpeg", ".webp", ".gif"];
      if (!allowed.includes(ext)) {
        return res.status(400).json({ error: "Invalid file type. Allowed: PNG, JPG, WebP, GIF" });
      }
      const base64Data = data.replace(/^data:image\/[^;]+;base64,/, "");
      const buffer = Buffer.from(base64Data, "base64");
      if (buffer.length > 5 * 1024 * 1024) {
        return res.status(400).json({ error: "File too large. Maximum 5MB." });
      }
      const safeName = `logo_${Date.now()}${ext}`;
      const filePath = path.join(uploadsDir, safeName);
      fs.writeFileSync(filePath, buffer);
      res.json({ url: `/uploads/${safeName}` });
    } catch (error) {
      console.error("Error uploading logo:", error);
      res.status(500).json({ error: "Failed to upload logo" });
    }
  });

  // =====================
  // =====================
  // Seller EQ Profile endpoints
  // =====================

  // Generate or refresh the seller communication profile
  app.post("/api/deals/:dealId/seller-profile/generate", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const { dealId } = req.params;
      const { generateSellerProfile, saveRegeneratedSellerProfile } = await import("./interview/eq-profiler");
      // The broker's own notes and corrections survive a regenerate — as they
      // are when it lands (a note saved while it ran is kept).
      const profile = await saveRegeneratedSellerProfile(dealId, await generateSellerProfile(dealId));
      res.json(profile);
    } catch (error: any) {
      console.error("[EQ profiler] Generation failed:", error);
      // The AI service failed: the current profile was not touched.
      if (error?.name === "SellerProfileUnavailableError") {
        return res.status(503).json({ error: "The AI service is unavailable — your current profile was kept. Try again in a few minutes." });
      }
      res.status(500).json({ error: error.message || "Failed to generate seller profile" });
    }
  });

  // Get the current seller profile
  app.get("/api/deals/:dealId/seller-profile", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const deal = await storage.getDeal(req.params.dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });
      const profile = (deal.sellerProfile as Record<string, any> | null) || null;
      // Notes saved before the PATCH fix below landed one level too deep
      // (brokerOverrides.brokerOverrides.brokerNotes). Lift them on read so
      // the broker still sees what they wrote; the next save stores them flat.
      const nested = profile?.brokerOverrides?.brokerOverrides;
      if (profile && nested?.brokerNotes && !profile.brokerOverrides?.brokerNotes) {
        return res.json({
          ...profile,
          brokerOverrides: { ...profile.brokerOverrides, brokerNotes: nested.brokerNotes },
        });
      }
      res.json(profile);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Broker overrides — update specific fields on the profile
  app.patch("/api/deals/:dealId/seller-profile", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const deal = await storage.getDeal(req.params.dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });

      const existingProfile = (deal.sellerProfile as Record<string, any>) || {};
      const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, any>;

      // The client sends either flat profile fields ({ communicationStyle: "..." })
      // or a { brokerOverrides: { brokerNotes } } wrapper for broker-only fields.
      // Spreading the wrapper straight into brokerOverrides nested it one level
      // too deep (brokerOverrides.brokerOverrides.brokerNotes), so notes vanished
      // on reload. Unwrap it and merge at the correct level; also drop any
      // stale nested copy left behind by earlier saves.
      const { brokerOverrides: wrapped, ...fieldOverrides } = body;
      const { brokerOverrides: _staleNested, ...priorOverrides } =
        (existingProfile.brokerOverrides && typeof existingProfile.brokerOverrides === "object"
          ? existingProfile.brokerOverrides
          : {}) as Record<string, any>;
      const { brokerOverrides: _nestedInWrapper, ...wrappedOverrides } =
        (wrapped && typeof wrapped === "object" ? wrapped : {}) as Record<string, any>;

      // Merge overrides into existing profile, tracking what the broker changed
      const brokerOverrides = {
        ...priorOverrides,
        ...fieldOverrides,
        ...wrappedOverrides,
        updatedAt: new Date().toISOString(),
      };
      const updatedProfile = { ...existingProfile, ...fieldOverrides, brokerOverrides };

      await storage.updateDeal(req.params.dealId, { sellerProfile: updatedProfile } as any);
      res.json(updatedProfile);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // NEW: Adaptive AI Interview endpoints
  // =====================

  // List all interview sessions for a deal (broker transcript view)
  app.get("/api/deals/:dealId/sessions", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const { dealId } = req.params;
      const { interviewSessions: sessionsTable } = await import("@shared/schema");
      const { eq, desc } = await import("drizzle-orm");
      const { db } = await import("./db");

      const sessions = await db
        .select()
        .from(sessionsTable)
        .where(eq(sessionsTable.dealId, dealId))
        .orderBy(desc(sessionsTable.startedAt));

      const result = sessions.map((s) => {
        const msgs = (s.messages as any[]) || [];
        const startTime = new Date(s.startedAt).getTime();
        const endTime = s.completedAt
          ? new Date(s.completedAt).getTime()
          : new Date(s.lastActivityAt).getTime();
        const durationMinutes = Math.round((endTime - startTime) / 60000);

        return {
          id: s.id,
          status: s.status,
          startedAt: s.startedAt,
          lastActivityAt: s.lastActivityAt,
          completedAt: s.completedAt,
          questionsAsked: s.questionsAsked ?? 0,
          questionsAnswered: s.questionsAnswered ?? 0,
          questionsSkipped: s.questionsSkipped ?? 0,
          messages: msgs,
          messageCount: msgs.length,
          durationMinutes,
          // (The broker's own sessions and "Interview together" are labelled as such.)
          conductedBy: sessionModeOf(s),
        };
      });

      res.json(result);
    } catch (error: any) {
      console.error("Error fetching deal sessions:", error);
      res.status(500).json({ error: "Failed to fetch interview sessions" });
    }
  });

  // Start or resume an interview session for a deal
  // Interview responses: the owning broker gets the full turn result; a
  // seller (admitted by their token) gets field names without values or
  // guard reasons — those can quote broker-only sources (CRM notes, private
  // emails). See server/interview/seller-safe-turn.ts.
  const brokerOwnsInterview = async (req: Request, dealId: string) =>
    !!req.session.brokerId && !!(await getOwnedDeal(dealId, req.session.brokerId));
  const interviewResultFor = async <T extends object>(req: Request, dealId: string, result: T): Promise<T> =>
    (await brokerOwnsInterview(req, dealId)) ? result : sellerSafeTurnResult(result as any);
  // Who is calling, from the credential — never from the session or the
  // body alone: the seller's invite token is always the seller (even when
  // the browser also holds a broker session — "Preview seller view");
  // otherwise it is the owning broker, running "Interview together" when
  // asked, else their own session (session-mode.ts).
  const interviewCallerMode = async (req: Request, dealId: string): Promise<ConductedBy> =>
    callerMode(await sellerTokenMatchesDeal(req, dealId), req.body?.conductedBy);
  /** A refused turn (session closed, someone else's, out of step) → 409 with what the client needs to re-sync. */
  const turnConflictBody = (err: TurnConflictError) => ({ error: err.message, code: err.code });

  app.post("/api/interview/:dealId/start", async (req, res) => {
    try {
      const { dealId } = req.params;
      if (!(await canAccessDeal(req, dealId))) {
        return res.status(401).json({ error: "Not authorized for this interview" });
      }
      const conductedBy = await interviewCallerMode(req, dealId);
      // A website nobody has read yet is read now, in the background (later
      // turns use it; the opening doesn't wait).
      {
        const scrapeDealRow = await storage.getDeal(dealId);
        if (scrapeDealRow) {
          const { scrapeInBackground } = await import("./scraper/auto-scrape");
          scrapeInBackground(scrapeDealRow, "interview started");
        }
      }
      // A finished interview is continued only on an explicit request
      // ("Continue interview" / "Add more detail") — loading the page alone
      // returns its finished state and starts nothing.
      const startOpts = {
        conductedBy,
        conductedVia: parseConductedVia(req.body?.conductedVia),
        resume: req.body?.resume === true,
      };
      // stream: true → Server-Sent Events: "status" events while a new
      // session's opening is prepared (reading the file, checking the
      // sources, writing the first question — it can take half a minute),
      // then "done" with the same result as the JSON response.
      if (req.body?.stream === true) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders?.();
        const send = (obj: unknown) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };
        try {
          const result = await startOrResumeSession(dealId, {
            ...startOpts,
            onProgress: (stage) => send({ type: "status", stage }),
            // The opening's text as soon as it is final (its label and the
            // session save follow): the seller starts reading meanwhile.
            onOpeningText: (text) => send({ type: "opening", text }),
          });
          send({ type: "done", result: await interviewResultFor(req, dealId, result) });
        } catch (err: any) {
          console.error("Interview start error:", err);
          send({ type: "error", error: err.message || "Failed to start interview" });
        }
        res.end();
        return;
      }
      const result = await startOrResumeSession(dealId, startOpts);
      res.json(await interviewResultFor(req, dealId, result));
    } catch (error: any) {
      console.error("Interview start error:", error);
      res.status(500).json({ error: error.message || "Failed to start interview" });
    }
  });

  // Broker: reopen a finished interview (e.g. one that ended too early) —
  // the deal shows the interview in progress again and the seller's link
  // opens the conversation instead of the "complete" card.
  app.post("/api/interview/:dealId/reopen", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const { reopenInterview } = await import("./interview/session-manager");
      await reopenInterview(req.params.dealId);
      res.json({ ok: true });
    } catch (error: any) {
      console.error("Interview reopen error:", error);
      res.status(500).json({ error: "Couldn't reopen the interview" });
    }
  });

  // Short-lived Deepgram key so the browser can stream the room's audio for
  // speaker-separated live transcription (in-person broker-led mode). The
  // real key stays on the server; this one expires in minutes.
  app.post("/api/interview/:dealId/transcription-token", async (req, res) => {
    try {
      const { dealId } = req.params;
      if (!(await canAccessDeal(req, dealId))) return res.status(401).json({ error: "Not authorized for this interview" });
      if (!isDeepgramConfigured()) return res.status(503).json({ error: "not_configured" });
      res.json({ provider: "deepgram", ...(await createTemporaryKey(`deal ${dealId}`)) });
    } catch (error: any) {
      console.error("[transcription] token failed:", error);
      // Say what Deepgram answered — a 403 here almost always means the
      // account key lacks permission to create keys (needs Admin/Owner role).
      const status = typeof error?.status === "number" ? error.status : undefined;
      const hint = status === 403 || status === 401
        ? "Deepgram refused to create a session key — the DEEPGRAM_API_KEY needs the Admin (or Owner) role, not Member."
        : status ? `Deepgram answered ${status}.` : "Couldn't reach Deepgram.";
      res.status(500).json({ error: `Couldn't start live transcription. ${hint}`, deepgramStatus: status });
    }
  });

  // ── In-Cimple video call (Daily) for broker-led interviews ──
  const activeCall = (deal: any): InterviewCall | null => {
    const c = deal?.interviewCall as InterviewCall | null | undefined;
    if (!c || c.endedAt) return null;
    if (c.expiresAt && new Date(c.expiresAt).getTime() < Date.now()) return null;
    return c;
  };

  // Broker starts (or rejoins) the deal's call. Returns an owner token so the
  // broker's browser can start transcription.
  app.post("/api/interview/:dealId/call/start", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      if (!isDailyConfigured()) return res.status(503).json({ error: "not_configured" });
      const deal = await storage.getDeal(req.params.dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });
      const broker = await storage.getUser(deal.brokerId);
      let call = activeCall(deal);
      if (!call) {
        const room = await createRoom(deal.id);
        call = { roomName: room.name, roomUrl: room.url, startedAt: new Date().toISOString(), expiresAt: room.expiresAt };
        await storage.updateDeal(deal.id, { interviewCall: call } as any);
      }
      const token = await createMeetingToken(call.roomName, brokerDisplayName(broker) || "Broker", true);
      res.json({ roomUrl: call.roomUrl, token, startedAt: call.startedAt, expiresAt: call.expiresAt });
    } catch (error: any) {
      console.error("[call] start failed:", error);
      res.status(500).json({ error: "Couldn't start the video call" });
    }
  });

  // The seller's link to join the call. Reuses the deal's seller invite
  // (creating one from the broker-supplied email if the deal has none) and,
  // only when the broker asks, emails the link to the seller.
  app.get("/api/interview/:dealId/call/seller-link", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const invites = await storage.getSellerInvitesByDealId(req.params.dealId);
      const primary = invites.find((i) => i.status === "accepted") ?? invites.find((i) => i.status === "sent") ?? invites[0];
      if (!primary) return res.json({ link: null });
      res.json({ link: `${appBase(req)}/seller/${primary.token}/call`, sellerName: primary.sellerName, sellerEmail: primary.sellerEmail });
    } catch (error: any) {
      res.status(500).json({ error: "Couldn't load the seller's link" });
    }
  });

  app.post("/api/interview/:dealId/call/seller-link", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const deal = await storage.getDeal(req.params.dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });
      const email = typeof req.body?.sellerEmail === "string" ? req.body.sellerEmail.trim() : "";
      const name = typeof req.body?.sellerName === "string" ? req.body.sellerName.trim() : "";
      const send = req.body?.send === true;
      if (send && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "Enter the seller's email address to send the link" });
      const existing = await storage.getSellerInvitesByDealId(deal.id);
      const primary = existing.find((i) => i.status === "accepted") ?? existing.find((i) => i.status === "sent") ?? existing[0];
      const invite = email
        ? await findOrCreateSellerInvite(deal.id, email, name || null)
        : primary ?? await findOrCreateSellerInvite(deal.id, "", name || null);
      const link = `${appBase(req)}/seller/${invite.token}/call`;
      let emailSent = false;
      if (send) {
        const who = invite.sellerName || name;
        emailSent = await sendDirectEmail(
          email,
          `${deal.businessName}: join the video call with your broker`,
          `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#1a1815">
            <p>${who ? `Hi ${who.replace(/</g, "&lt;")},` : "Hi,"}</p>
            <p>Your broker is ready to go through your business overview with you on a video call.</p>
            <p><a href="${link}" style="display:inline-block;background:#B08D57;color:#151311;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600">Join the call</a></p>
            <p style="color:#6b655c;font-size:13px">The link opens in your browser — nothing to install. If your broker hasn't started yet, the page waits and joins you automatically.</p>
          </div>`,
        );
        if (emailSent && invite.status !== "accepted") await storage.updateSellerInvite(invite.id, { sentAt: new Date(), status: "sent" as const });
      }
      res.json({ link, sellerName: invite.sellerName, sellerEmail: invite.sellerEmail, emailSent });
    } catch (error: any) {
      console.error("[call] seller link failed:", error);
      res.status(500).json({ error: "Couldn't create the seller's link" });
    }
  });

  app.post("/api/interview/:dealId/call/end", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const deal = await storage.getDeal(req.params.dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });
      const call = activeCall(deal);
      if (call) {
        await storage.updateDeal(deal.id, { interviewCall: { ...call, endedAt: new Date().toISOString() } } as any);
        void deleteRoom(call.roomName);
      }
      res.json({ ended: true });
    } catch (error: any) {
      res.status(500).json({ error: "Couldn't end the call" });
    }
  });

  // The broker left the "Interview together" page (any way of running it —
  // in person, a Cimple call, a Zoom/Meet/Teams notetaker): the sitting is
  // marked left, so the seller's own link opens straight away instead of
  // "your broker is going through this with you now" for half an hour.
  // Nothing is closed; coming back resumes it.
  app.post("/api/interview/:dealId/together/leave", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const { parkTogetherSessions } = await import("./interview/session-manager");
      const parked = await parkTogetherSessions(req.params.dealId);
      res.json({ parked });
    } catch (error: any) {
      res.status(500).json({ error: "Couldn't update the sitting" });
    }
  });

  // Seller side: is the broker waiting in a call? If so, a participant token.
  app.get("/api/seller/:token/call", async (req, res) => {
    try {
      const invite = await storage.getSellerInviteByToken(req.params.token);
      if (!invite) return res.status(404).json({ error: "Invite not found" });
      const deal = await storage.getDeal(invite.dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });
      const call = activeCall(deal);
      if (!call || !isDailyConfigured()) return res.json({ active: false, businessName: deal.businessName });
      // "Cimple is taking notes" (D15): an Interview together sitting on this
      // call, after the broker confirmed the seller knows.
      const { liveSittingFor } = await import("./together/sittings");
      const sitting = await liveSittingFor(deal.id).catch(() => null);
      const notetaking = !!sitting && sitting.via === "cimple" && !!sitting.consentAt;
      // (?status=1: the in-call check of the badge — no new meeting token.)
      if (req.query.status === "1") return res.json({ active: true, notetaking });
      const token = await createMeetingToken(call.roomName, invite.sellerName || "Seller", false);
      res.json({ active: true, roomUrl: call.roomUrl, token, startedAt: call.startedAt, businessName: deal.businessName, notetaking });
    } catch (error: any) {
      console.error("[call] seller lookup failed:", error);
      res.status(500).json({ error: "Couldn't check the call" });
    }
  });

  // ── Notetaker bot for the broker's own Zoom / Meet / Teams call (Recall.ai) ──
  const webhookTokens = new Map<string, string>(); // token → dealId (rebuilt lazily after a restart)
  const resolveWebhookToken = createWebhookTokenResolver(webhookTokens, dealIdForWebhookToken);
  const activeBot = (deal: any): InterviewBot | null => {
    const b = deal?.interviewBot as InterviewBot | null | undefined;
    return b && !b.endedAt ? b : null;
  };
  const appUrl = () => (process.env.APP_URL || "https://app.cimple.ca").replace(/\/$/, "");

  app.post("/api/interview/:dealId/call/bot/start", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      if (!isRecallConfigured()) return res.status(503).json({ error: "not_configured" });
      const meetingUrl = typeof req.body?.meetingUrl === "string" ? req.body.meetingUrl.trim() : "";
      if (!isSupportedMeetingUrl(meetingUrl)) return res.status(400).json({ error: "Paste a Zoom, Google Meet or Microsoft Teams meeting link (https://…)" });
      const deal = await storage.getDeal(req.params.dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });
      // Interview together: the notetaker joins only for a sitting whose
      // broker confirmed the seller knows Cimple is taking notes (D15), and
      // the bot is recorded on that sitting (its lines go only there).
      const { sittingForDeal } = await import("./together/sittings");
      const { togetherStore } = await import("./together/store");
      const { watchNotetaker } = await import("./together/notetaker");
      const sittingId = typeof req.body?.sittingId === "string" ? req.body.sittingId : "";
      const sitting = sittingId ? await sittingForDeal(deal.id, sittingId) : null;
      if (!sitting || sitting.status === "ended") return res.status(409).json({ error: "Start the session together first.", code: "no_sitting" });
      if (!sitting.consentAt) return res.status(409).json({ error: "Let the seller know Cimple is taking notes first.", code: "consent_required" });
      const existing = activeBot(deal);
      if (existing && existing.meetingUrl === meetingUrl) {
        webhookTokens.set(existing.webhookToken, deal.id);
        if (sitting.botId !== existing.botId) await togetherStore().updateSitting(sitting.id, { botId: existing.botId });
        watchNotetaker(sitting.id, existing.botId);
        return res.json({ botId: existing.botId, startedAt: existing.startedAt, status: readBotLines(deal.id, 0).status });
      }
      if (existing) void leaveCall(existing.botId);
      const webhookToken = newWebhookToken();
      // Recall wants a trailing slash before the query string.
      const bot = await createBot(meetingUrl, `${appUrl()}/api/calls/recall/webhook/?token=${webhookToken}`);
      const record: InterviewBot = { botId: bot.id, meetingUrl, webhookToken, startedAt: new Date().toISOString() };
      await storage.updateDeal(deal.id, { interviewBot: record } as any);
      webhookTokens.set(webhookToken, deal.id);
      clearBotBuffer(deal.id);
      setBotStatus(deal.id, latestStatus(bot) || "joining_call");
      await togetherStore().updateSitting(sitting.id, { botId: bot.id });
      watchNotetaker(sitting.id, bot.id);
      res.json({ botId: bot.id, startedAt: record.startedAt, status: latestStatus(bot) || "joining_call" });
    } catch (error: any) {
      console.error("[recall] bot start failed:", error);
      const status = typeof error?.status === "number" ? error.status : undefined;
      res.status(500).json({ error: `Couldn't send the notetaker to the call${status ? ` (Recall answered ${status})` : ""}.` });
    }
  });

  app.post("/api/interview/:dealId/call/bot/stop", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const deal = await storage.getDeal(req.params.dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });
      const bot = activeBot(deal);
      if (bot) {
        await leaveCall(bot.botId);
        await storage.updateDeal(deal.id, { interviewBot: { ...bot, endedAt: new Date().toISOString() } } as any);
        webhookTokens.delete(bot.webhookToken);
        const { togetherStore } = await import("./together/store");
        const { stopNotetakerWatch } = await import("./together/notetaker");
        for (const st of await togetherStore().openSittings(deal.id)) {
          if (st.botId !== bot.botId) continue;
          stopNotetakerWatch(st.id);
          const { publish } = await import("./together/hub");
          publish(st.id, { type: "listen", state: "notetaker_ended" });
        }
      }
      res.json({ stopped: true });
    } catch (error: any) {
      res.status(500).json({ error: "Couldn't stop the notetaker" });
    }
  });

  // New transcript lines since `after` (a sequence number) + the bot's status.
  app.get("/api/interview/:dealId/call/bot/lines", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const after = Number(req.query.after) || 0;
      const out = readBotLines(req.params.dealId, after);
      // Refresh the status from Recall every so often while nothing has arrived
      // yet (joining can take 30–60s; a fatal join failure must not spin forever).
      if (!out.status || out.status === "joining_call" || out.status === "in_waiting_room") {
        const deal = await storage.getDeal(req.params.dealId);
        const bot = deal ? activeBot(deal) : null;
        if (bot) {
          try {
            const s = latestStatus(await getBot(bot.botId));
            if (s) { setBotStatus(req.params.dealId, s); out.status = s; }
          } catch { /* keep last known */ }
        }
      }
      res.json(out);
    } catch (error: any) {
      res.status(500).json({ error: "Couldn't read the transcript" });
    }
  });

  // Recall posts transcript / participant events here. Public, but every
  // request must carry the per-bot token from the URL we registered.
  app.post("/api/calls/recall/webhook/", async (req, res) => {
    try {
      const token = typeof req.query.token === "string" ? req.query.token : "";
      // After a restart the map is empty: the resolver finds the owning deal
      // with a one-row query (never the whole deals table), refuses tokens
      // that can't be ours, and remembers misses briefly.
      const dealId = await resolveWebhookToken(token);
      if (!dealId) return res.status(401).end();
      const event = req.body?.event;
      if (event === "transcript.data") {
        const line = lineFromWebhook(req.body);
        if (line) pushBotLine(dealId, line);
        setBotStatus(dealId, "in_call_recording");
        // Interview together: the line joins the live sitting whose bot this is.
        if (line) {
          const { togetherLineFromWebhook, appendRecallLine } = await import("./together/recall-lines");
          const tl = togetherLineFromWebhook(req.body);
          if (tl) await appendRecallLine(dealId, token, tl).catch((err) => console.warn("[recall] together line failed:", (err as Error).message));
        }
      } else if (event === "participant_events.join" || event === "participant_events.leave") {
        setBotStatus(dealId, "in_call_recording");
        const { recallParticipantEvent } = await import("./together/recall-lines");
        await recallParticipantEvent(dealId, token, req.body).catch(() => undefined);
      }
      res.status(200).json({ ok: true });
    } catch (error: any) {
      console.error("[recall] webhook error:", error);
      res.status(200).json({ ok: false });
    }
  });

  // Which call/transcription services are configured — drives the UI's options.
  app.get("/api/calls/status", requireBroker, (_req, res) => {
    res.json({
      deepgram: isDeepgramConfigured(),
      daily: !!process.env.DAILY_API_KEY,
      recall: !!process.env.RECALL_API_KEY,
    });
  });

  // Send a message in an interview session
  app.post("/api/interview/:dealId/message", async (req, res) => {
    try {
      const { dealId } = req.params;
      if (!(await canAccessDeal(req, dealId))) {
        return res.status(401).json({ error: "Not authorized for this interview" });
      }
      const { message, sessionId } = req.body;

      if (!message || typeof message !== "string") {
        return res.status(400).json({ error: "Message string is required" });
      }
      if (!sessionId || typeof sessionId !== "string") {
        return res.status(400).json({ error: "Session ID is required" });
      }

      const result = await processTurn(dealId, sessionId, message, undefined, {
        correctionOf: parseCorrectionOf(req.body.correctionOf),
        conductedBy: await interviewCallerMode(req, dealId),
        conductedVia: parseConductedVia(req.body?.conductedVia),
        answeringAt: parseAnsweringAt(req.body?.answeringAt),
        byDealBroker: await isDealOwnerSession(req, dealId),
      });
      res.json(await interviewResultFor(req, dealId, result));
    } catch (error: any) {
      if (error instanceof TurnConflictError) return res.status(409).json(turnConflictBody(error));
      console.error("Interview message error:", error);
      res.status(500).json({ error: error.message || "Failed to process message" });
    }
  });

  // Streaming variant of the message endpoint — Server-Sent Events. The AI
  // message streams token-by-token for a live, conversational feel; a final
  // "done" event carries the authoritative structured turn result (coverage,
  // suggestions, etc.). Falls back to the plain /message endpoint if a client
  // can't use SSE.
  app.post("/api/interview/:dealId/message/stream", async (req, res) => {
    try {
      const { dealId } = req.params;
      if (!(await canAccessDeal(req, dealId))) {
        return res.status(401).json({ error: "Not authorized for this interview" });
      }
      const { message, sessionId } = req.body;
      if (!message || typeof message !== "string") {
        return res.status(400).json({ error: "Message string is required" });
      }
      if (!sessionId || typeof sessionId !== "string") {
        return res.status(400).json({ error: "Session ID is required" });
      }
      const conductedBy = await interviewCallerMode(req, dealId);
      const answeringAt = parseAnsweringAt(req.body?.answeringAt);
      // Refused before the stream opens when it is already clear (the
      // session closed, isn't the caller's, or has moved on and nothing is
      // running on it) — a plain 409 the client re-syncs from. A turn still
      // running on the session is waited for inside processTurn.
      const pre = await turnPrecheck(sessionId, { dealId, mode: conductedBy, answeringAt });
      if (pre) return res.status(409).json(turnConflictBody(pre));

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();
      // (A reply still being typed out when the turn failed must not write
      // after the response has ended.)
      const send = (obj: unknown) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };

      try {
        const result = await processTurn(
          dealId,
          sessionId,
          message,
          (chunk) => send({ type: "delta", text: chunk }),
          {
            correctionOf: parseCorrectionOf(req.body.correctionOf),
            conductedBy,
            conductedVia: parseConductedVia(req.body?.conductedVia),
            answeringAt,
            byDealBroker: await isDealOwnerSession(req, dealId),
            // The question on screen is final and its chips are ready: the
            // seller can answer while the turn finishes saving.
            onReady: (ready) => send({ type: "ready", ...ready }),
            // The goodbye on screen ends the interview: the answer box closes
            // while the turn saves.
            onEnding: () => send({ type: "ending" }),
          },
        );
        send({ type: "done", result: await interviewResultFor(req, dealId, result) });
      } catch (err: any) {
        if (err instanceof TurnConflictError) {
          send({ type: "error", ...turnConflictBody(err) });
        } else {
          console.error("Interview stream error:", err);
          send({ type: "error", error: err.message || "Failed to process message" });
        }
      }
      res.end();
    } catch (error: any) {
      console.error("Interview stream setup error:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: error.message || "Failed to process message" });
      } else {
        res.end();
      }
    }
  });

  // Seller explicitly ends the interview ("End Overview" button). Marks the
  // session completed and the deal's interview done so progress advances and
  // the next visit doesn't resume a conversation the seller already closed.
  app.post("/api/interview/:dealId/end", async (req, res) => {
    try {
      const { dealId } = req.params;
      if (!(await canAccessDeal(req, dealId))) {
        return res.status(401).json({ error: "Not authorized for this interview" });
      }
      const { sessionId } = req.body;
      if (!sessionId || typeof sessionId !== "string") {
        return res.status(400).json({ error: "Session ID is required" });
      }
      const { endSessionManually } = await import("./interview/session-manager");
      const result = await endSessionManually(dealId, sessionId, {
        mode: await interviewCallerMode(req, dealId),
        byDealBroker: await isDealOwnerSession(req, dealId),
      });
      res.json(result);
    } catch (error: any) {
      if (error instanceof TurnConflictError) return res.status(409).json(turnConflictBody(error));
      console.error("Interview end error:", error);
      res.status(500).json({ error: error.message || "Failed to end interview" });
    }
  });

  // Get conversation history for a session (used when resuming on the frontend)
  app.get("/api/interview/session/:sessionId/history", async (req, res) => {
    try {
      const { sessionId } = req.params;
      // Resolve the session's deal so we can authorize against it — the
      // sessionId alone is not proof of access.
      const { getSessionDealId } = await import("./interview/session-manager");
      const dealId = await getSessionDealId(sessionId);
      if (!dealId || !(await canAccessDeal(req, dealId))) {
        return res.status(401).json({ error: "Not authorized for this session" });
      }
      // The seller reads only their own sessions — never the broker's own
      // session (it can hold broker-private notes typed as answers) or a
      // broker-led room transcript.
      const viaSellerToken = await sellerTokenMatchesDeal(req, dealId);
      const result = await getSessionHistory(sessionId, { forSeller: viaSellerToken });
      if (!result) return res.status(403).json({ error: "This conversation isn't available here" });
      res.json(result);
    } catch (error: any) {
      console.error("Interview history error:", error);
      res.status(500).json({ error: error.message || "Failed to get session history" });
    }
  });

  // (The legacy /api/cims CRUD routes are gone: they had no tenant scoping —
  // any broker could list, edit or delete every row — and their UI was
  // removed on 2026-07-08. Unknown /api paths answer a JSON 404.)

  // Branding Settings Routes
  app.get("/api/branding", requireBroker, async (req, res) => {
    try {
      const settings = await storage.getBrandingByBroker(req.session.brokerId!);
      res.json(settings ?? null);
    } catch (error: any) {
      console.error("Error fetching branding settings:", error);
      res.status(500).json({ error: "Failed to fetch branding settings" });
    }
  });

  // One row per broker: POST creates it the first time and updates it after.
  app.post("/api/branding", requireBroker, async (req, res) => {
    try {
      const { insertBrandingSettingsSchema } = await import("@shared/schema");
      const { cleanBrandingWrite } = await import("./cim/templates");
      const cleaned = await cleanBrandingWrite(req.session.brokerId!, req.body || {});
      if (!cleaned.ok) return res.status(400).json({ error: cleaned.error });
      const existing = await storage.getBrandingByBroker(req.session.brokerId!);
      if (existing) {
        const updates = insertBrandingSettingsSchema.partial().parse(cleaned.data);
        const settings = await storage.updateBrandingSettings(existing.id, updates);
        return res.json(settings);
      }
      const validatedData = insertBrandingSettingsSchema.parse({
        ...cleaned.data,
        brokerId: req.session.brokerId,
      });
      const settings = await storage.createBrandingSettings(validatedData);
      res.json(settings);
    } catch (error: any) {
      if (error.name === "ZodError") {
        return res.status(400).json({ error: "Invalid branding settings data", details: error.errors });
      }
      console.error("Error creating branding settings:", error);
      res.status(500).json({ error: "Failed to create branding settings" });
    }
  });

  app.patch("/api/branding/:id", requireBroker, async (req, res) => {
    try {
      const own = await storage.getBrandingByBroker(req.session.brokerId!);
      if (!own || own.id !== req.params.id) {
        return res.status(404).json({ error: "Branding settings not found" });
      }
      const { insertBrandingSettingsSchema } = await import("@shared/schema");
      const { cleanBrandingWrite } = await import("./cim/templates");
      const cleaned = await cleanBrandingWrite(req.session.brokerId!, req.body || {});
      if (!cleaned.ok) return res.status(400).json({ error: cleaned.error });
      const validatedData = insertBrandingSettingsSchema.partial().parse(cleaned.data);
      const settings = await storage.updateBrandingSettings(req.params.id, validatedData);
      if (!settings) {
        return res.status(404).json({ error: "Branding settings not found" });
      }
      res.json(settings);
    } catch (error: any) {
      if (error.name === "ZodError") {
        return res.status(400).json({ error: "Invalid branding settings data", details: error.errors });
      }
      console.error("Error updating branding settings:", error);
      res.status(500).json({ error: "Failed to update branding settings" });
    }
  });

  // =============================
  // DEAL ROUTES
  // =============================
  
  app.get("/api/deals", requireBroker, async (req, res) => {
    try {
      // Scope is ALWAYS the session broker — never a client-supplied param.
      // Archived deals are left out (the deal list's /api/deals/list can show them).
      const deals = (await storage.getAllDeals(req.session.brokerId)).filter((d) => !d.archivedAt);
      // Drifted asking-price copies lined up in memory (one value everywhere;
      // reading never writes — see information/deal-mirror.ts).
      res.json(deals.map((d) => withoutFactsSnapshot(brokerFactsView(d))));
    } catch (error: any) {
      console.error("Error fetching deals:", error);
      res.status(500).json({ error: "Failed to fetch deals" });
    }
  });

  app.get("/api/deals/:id", requireBroker, async (req, res, next) => {
    // GET /api/deals/list lives in routes/deal-list.ts, registered after this.
    if (req.params.id === "list") return next();
    try {
      const deal = await getOwnedDeal(req.params.id, req.session.brokerId);
      if (!deal) {
        return res.status(404).json({ error: "Deal not found" });
      }
      // The Overview (Valuation input included) shows the same asking price
      // as the Information tab, deal list, readiness and CIM: drifted copies
      // from before the one-value rule are lined up in memory, never saved
      // on read (the broker's next change saves them — deal-mirror.ts).
      res.json(withoutFactsSnapshot(brokerFactsView(deal)));
    } catch (error: any) {
      console.error("Error fetching deal:", error);
      res.status(500).json({ error: "Failed to fetch deal" });
    }
  });

  app.post("/api/deals", requireBroker, async (req, res) => {
    try {
      const { insertDealSchema } = await import("@shared/schema");
      // Owner is always the logged-in broker — a client-supplied brokerId is ignored.
      // demoKey marks seeded demo/QA deals (kept out of the industry-wide
      // learning loops) — set only by the seeding code, never by a client.
      const { demoKey: _demoKey, ...body } = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
      const validatedData = insertDealSchema.parse({
        ...body,
        brokerId: req.session.brokerId,
      });
      let deal = await storage.createDeal(validatedData);
      // The name, industry and asking price entered at creation become the
      // broker's facts too (one value with the Information tab — see
      // information/deal-mirror.ts); a document's NAICS text or a CRM note
      // never takes the industry or the name over.
      try {
        const { setMirroredDealFacts } = await import("./information/facts");
        const { MIRROR_NOTES } = await import("./information/deal-mirror");
        await setMirroredDealFacts(
          deal.id,
          {
            businessName: deal.businessName,
            industry: deal.industry,
            ...(deal.subIndustry ? { subIndustry: deal.subIndustry } : {}),
            ...(deal.askingPrice ? { askingPrice: deal.askingPrice } : {}),
          },
          MIRROR_NOTES.created,
        );
        deal = (await storage.getDeal(deal.id)) ?? deal;
      } catch (e) {
        console.warn("[deals] deal-detail facts not recorded:", e);
      }

      // Auto-populate document requirements from industry intelligence (the
      // label "Restaurant / Food Service" is resolved to its industry list).
      // Non-fatal — the deal is created either way.
      {
        const { ensureIndustryDocumentRequirements } = await import("./documents/requirements");
        await ensureIndustryDocumentRequirements(deal.id, deal.industry, deal.subIndustry);
      }
      // A website entered at creation is read in the background, so the
      // interview starts informed (New Deal promises it).
      {
        const { scrapeInBackground } = await import("./scraper/auto-scrape");
        scrapeInBackground(deal, "deal created");
      }

      res.json(deal);
    } catch (error: any) {
      if (error.name === "ZodError") {
        return res.status(400).json({ error: "Invalid deal data", details: error.errors });
      }
      console.error("Error creating deal:", error);
      res.status(500).json({ error: "Failed to create deal" });
    }
  });

  // ── Broker dashboard ──────────────────────────────────────────────────
  app.get("/api/broker/dashboard", requireBroker, async (req, res) => {
    try {
      // Archived deals are out of the dashboard entirely (pipeline, stats,
      // attention list and activity) — the broker put them away.
      const allDeals = (await storage.getAllDeals(req.session.brokerId)).filter((d) => !d.archivedAt);
      // "$2.5M" must count as 2,500,000 (the old digit-strip read it as 2.5).
      const askingValue = (d: { askingPrice: string | null; extractedInfo: unknown }) => moneyValue(listedAskingPrice(d as never)) ?? 0;

      // ─ Pipeline snapshot: group deals by phase (labels: shared/deal-progress) ─
      const pipeline = DEAL_PHASES.map(({ key: phase, label }) => {
        const phaseDeals = allDeals.filter((d) => d.phase === phase);
        const totalAskingPrice = phaseDeals.reduce((sum, d) => sum + askingValue(d), 0);
        return {
          phase,
          label,
          dealCount: phaseDeals.length,
          totalAskingPrice,
          deals: phaseDeals.map((d) => ({
            id: d.id,
            businessName: d.businessName,
            industry: d.industry,
            updatedAt: d.updatedAt,
          })),
        };
      });

      // ─ Quick stats ─
      const activeDeals = allDeals.filter((d) => d.status !== "completed");
      const totalPipelineValue = activeDeals.reduce((sum, d) => sum + askingValue(d), 0);
      const avgDaysInPhase = activeDeals.length > 0
        ? Math.round(
            activeDeals.reduce((sum, d) => {
              const daysSince = (Date.now() - new Date(d.updatedAt).getTime()) / (1000 * 60 * 60 * 24);
              return sum + daysSince;
            }, 0) / activeDeals.length,
          )
        : 0;

      // Fetch cross-deal data in parallel (all deals at once, not serial)
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      const perDealData = await Promise.all(
        allDeals.map(async (deal) => {
          const [access, approvals, questions] = await Promise.all([
            storage.getBuyerAccessByDeal(deal.id),
            storage.getBuyerApprovalRequestsByDeal(deal.id),
            storage.getQuestionsByDeal(deal.id),
          ]);
          return { deal, access, approvals, questions };
        }),
      );

      let newBuyersThisWeek = 0;
      const pendingApprovals: Array<{ dealId: string; dealName: string; buyerName: string; buyerCompany: string | null; submittedAt: string; source: string | null }> = [];
      // The teaser: a published block now held back from buyers, a buyer asking for a fresh teaser link.
      const teaserAttention: Array<{ dealId: string; dealName: string; kind: "held_block" | "fresh_link"; title: string; detail: string | null; count: number }> = [];
      const unansweredQuestions: Array<{ dealId: string; dealName: string; questionPreview: string; askedAt: string }> = [];

      for (const { deal, access, approvals, questions } of perDealData) {
        // New buyers this week
        newBuyersThisWeek += access.filter((a) => new Date(a.createdAt) > sevenDaysAgo).length;

        // Pending buyer approvals
        for (const a of approvals) {
          if (a.status === "pending_broker_review") {
            pendingApprovals.push({
              dealId: deal.id,
              dealName: deal.businessName,
              buyerName: a.buyerName,
              buyerCompany: a.buyerCompany,
              submittedAt: a.createdAt?.toISOString?.() ?? new Date(a.createdAt).toISOString(),
              // "teaser_request" = the buyer asked for the CIM from the teaser.
              source: (a as { source?: string | null }).source ?? null,
            });
          }
        }

        // Fresh teaser links asked for (expired teaser links; the broker decides).
        // (Answered once the same address has a usable link on the deal again.)
        const usable = new Set(access.filter((a) => !viewLinkProblem(a)).map((a) => a.buyerEmail.trim().toLowerCase()));
        const freshAsks = access.filter((a) => isTeaserOnly(a.accessLevel) && !a.revokedAt && a.expiresAt && new Date(a.expiresAt) < new Date()
          && !usable.has(a.buyerEmail.trim().toLowerCase())
          && (((a as any).accessEvents as BuyerAccessEvent[] | null) ?? []).some((e) => e.type === "fresh_link_requested"));
        if (freshAsks.length > 0) {
          teaserAttention.push({ dealId: deal.id, dealName: deal.businessName, kind: "fresh_link", title: freshAsks.length === 1 ? "A buyer asked for a fresh teaser link" : `${freshAsks.length} buyers asked for a fresh teaser link`, detail: null, count: freshAsks.length });
        }

        // Unanswered Q&A
        for (const q of questions) {
          if (questionWaitingOn(q.status, !!q.publishedAnswer) === "broker") {
            unansweredQuestions.push({
              dealId: deal.id,
              dealName: deal.businessName,
              questionPreview: q.question.slice(0, 120),
              askedAt: q.createdAt?.toISOString?.() ?? new Date(q.createdAt).toISOString(),
            });
          }
        }
      }

      // Deals whose next step is the broker's — the same definition the deal
      // list uses (shared/deal-progress computeNextStep), so the dashboard and
      // the list never disagree about whose move it is. (Replaces the old
      // pendingReviewCIMs, keyed off deals.status, which nothing ever set.)
      const sideFacts = await loadDealSideFacts(allDeals, { confidence: true });
      const yourMove = allDeals
        .map((deal) => {
          const facts = sideFacts.get(deal.id);
          const step = dealNextStep(deal, facts);
          return { deal, step, lastActivityMs: facts?.lastActivityMs ?? new Date(deal.createdAt).getTime() };
        })
        .filter(({ step }) => step.owner === "you")
        .sort((a, b) => b.lastActivityMs - a.lastActivityMs)
        .map(({ deal, step, lastActivityMs }) => ({
          dealId: deal.id,
          dealName: deal.businessName,
          label: step.label,
          href: step.href ?? `/deal/${deal.id}/overview`,
          lastActivity: new Date(lastActivityMs).toISOString(),
        }));

      // Stalled interviews (active sessions with no activity in 3+ days)
      const { db } = await import("./db");
      const { interviewSessions, dealDocumentRequirements, analyticsEvents: eventsTable } = await import("@shared/schema");
      const { and, lt, gt, eq: eqOp, desc: descOp, inArray } = await import("drizzle-orm");
      const dealMap = new Map(allDeals.map((d) => [d.id, d.businessName]));
      // Every query below is scoped to THIS broker's deals — they previously
      // ran platform-wide and surfaced other brokerages' activity as "Unknown".
      const ownDealIds = allDeals.map((d) => d.id);
      const emptyScope = ownDealIds.length === 0;

      const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      const stalledRows = emptyScope ? [] : await db
        .select()
        .from(interviewSessions)
        .where(
          and(
            inArray(interviewSessions.dealId, ownDealIds),
            eqOp(interviewSessions.status, "active"),
            lt(interviewSessions.lastActivityAt, threeDaysAgo),
          ),
        );

      // Shown as "Waiting on the seller": only the seller's own interview, one
      // row per deal (session-mode.ts stalledSellerSessions).
      const stalledInterviews = stalledSellerSessions(stalledRows).map((s) => ({
        dealId: s.dealId,
        dealName: dealMap.get(s.dealId) || "Unknown",
        lastActivity: s.lastActivityAt.toISOString(),
        daysSinceActivity: Math.floor((Date.now() - s.lastActivityAt.getTime()) / (1000 * 60 * 60 * 24)),
      }));

      // Document requirements — missing required docs per deal
      const allReqs = emptyScope ? [] : await db.select().from(dealDocumentRequirements).where(inArray(dealDocumentRequirements.dealId, ownDealIds));
      const missingByDeal = new Map<string, number>();
      for (const r of allReqs) {
        if (r.status === "missing" && r.isRequired) {
          missingByDeal.set(r.dealId, (missingByDeal.get(r.dealId) || 0) + 1);
        }
      }
      const pendingDocuments = Array.from(missingByDeal.entries())
        .map(([dealId, count]) => ({
          dealId,
          dealName: dealMap.get(dealId) || "Unknown",
          count,
        }))
        // Shown as "Waiting on the seller", so only where a seller has been
        // invited and the deal isn't live yet (an uninvited deal already
        // reads "Your move: invite the seller").
        .filter((d) => d.count > 0 && sideFacts.get(d.dealId)?.extras.invited && !allDeals.find((x) => x.id === d.dealId)?.isLive);

      // ─ Recent activity feed (last 48 hours, cap at 20) ─
      const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
      const activityItems: Array<{
        type: string;
        dealId: string;
        dealName: string;
        description: string;
        timestamp: string;
      }> = [];

      // Analytics events (buyer views, NDA signs)
      const recentEvents = emptyScope ? [] : await db
        .select()
        .from(eventsTable)
        .where(and(inArray(eventsTable.dealId, ownDealIds), gt(eventsTable.createdAt, twoDaysAgo)))
        .orderBy(descOp(eventsTable.createdAt));

      for (const evt of recentEvents) {
        if (evt.eventType === "view" || evt.eventType === "nda_signed") {
          const dn = dealMap.get(evt.dealId) || "Unknown";
          activityItems.push({
            type: evt.eventType === "nda_signed" ? "nda_signed" : "buyer_view",
            dealId: evt.dealId,
            dealName: dn,
            description: evt.eventType === "nda_signed" ? "Buyer signed NDA" : "Buyer viewed CIM",
            timestamp: evt.createdAt.toISOString(),
          });
        }
      }

      // Recent Q&A, document uploads, and approval submissions (use already-fetched data)
      for (const { deal, approvals, questions } of perDealData) {
        for (const q of questions) {
          const qDate = new Date(q.createdAt);
          if (qDate > twoDaysAgo) {
            activityItems.push({
              type: "question_asked",
              dealId: deal.id,
              dealName: deal.businessName,
              description: `Buyer asked: "${q.question.slice(0, 60)}..."`,
              timestamp: qDate.toISOString(),
            });
          }
        }

        for (const a of approvals) {
          const aDate = new Date(a.createdAt);
          if (aDate > twoDaysAgo) {
            activityItems.push({
              type: "approval_submitted",
              dealId: deal.id,
              dealName: deal.businessName,
              description: `Buyer submitted for approval: ${a.buyerName}`,
              timestamp: aDate.toISOString(),
            });
          }
        }
      }

      // Document uploads — need separate fetch (not in perDealData)
      const docResults = await Promise.all(
        allDeals.map(async (deal) => ({
          deal,
          docs: await storage.getDocumentsByDeal(deal.id),
        })),
      );
      for (const { deal, docs } of docResults) {
        for (const doc of docs) {
          const dDate = new Date(doc.createdAt);
          if (dDate > twoDaysAgo) {
            activityItems.push({
              type: "document_uploaded",
              dealId: deal.id,
              dealName: deal.businessName,
              description: `Document uploaded: ${doc.name || doc.originalName}`,
              timestamp: dDate.toISOString(),
            });
          }
        }
      }

      // Sort by timestamp desc, cap at 20
      activityItems.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      const activity = activityItems.slice(0, 20);

      res.json({
        stats: {
          activeDeals: activeDeals.length,
          totalPipelineValue,
          avgDaysInPhase,
          newBuyersThisWeek,
        },
        pipeline,
        actions: {
          pendingApprovals,
          teaserAttention: await (async () => {
            // Published teasers with a block that now names the business (held back from buyers).
            try {
              const { teaserStore, teaserPublished } = await import("./teaser/store");
              const { teaserSummary } = await import("./teaser/summary");
              const rows = await teaserStore().listByDeals(allDeals.map((d) => d.id));
              for (const row of rows) {
                if (!teaserPublished(row)) continue;
                const d = allDeals.find((x) => x.id === row.dealId);
                if (!d) continue;
                const sum = await teaserSummary(d, row, { counts: false });
                if (sum.heldBlocks.length === 0) continue;
                const first = sum.heldBlocks[0];
                teaserAttention.push({ dealId: d.id, dealName: d.businessName, kind: "held_block", title: "Fix the teaser — a block is hidden from buyers", detail: `${first.title}: ${first.reason}`, count: sum.heldBlocks.length });
              }
            } catch (err) {
              console.warn("[dashboard] teaser attention skipped:", (err as Error)?.message);
            }
            return teaserAttention;
          })(),
          unansweredQuestions,
          stalledInterviews,
          yourMove,
          pendingDocuments,
        },
        activity,
      });
    } catch (error: any) {
      console.error("Error loading broker dashboard:", error);
      res.status(500).json({ error: "Failed to load dashboard data" });
    }
  });

  // ── Document requirements (per-deal checklist) ──

  // GET — full checklist with upload status (broker session or seller token)
  app.get("/api/deals/:dealId/document-requirements", async (req, res) => {
    try {
      if (!(await canAccessDeal(req, req.params.dealId))) {
        return res.status(401).json({ error: "Not authorized" });
      }
      const requirements = await storage.getDocumentRequirementsByDeal(req.params.dealId);
      res.json(requirements);
    } catch (error: any) {
      console.error("Error fetching document requirements:", error);
      res.status(500).json({ error: "Failed to fetch document requirements" });
    }
  });

  // POST — broker adds a manual requirement
  app.post("/api/deals/:dealId/document-requirements", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const { insertDealDocumentRequirementSchema } = await import("@shared/schema");
      const validatedData = insertDealDocumentRequirementSchema.parse({
        ...req.body,
        dealId: req.params.dealId,
        source: "manual",
      });
      const requirement = await storage.createDocumentRequirement(validatedData);
      res.json(requirement);
    } catch (error: any) {
      if (error.name === "ZodError") {
        return res.status(400).json({ error: "Invalid requirement data", details: error.errors });
      }
      console.error("Error creating document requirement:", error);
      res.status(500).json({ error: "Failed to create document requirement" });
    }
  });

  // PATCH — update status, link upload, add notes (broker session or seller token)
  app.patch("/api/deals/:dealId/document-requirements/:reqId", async (req, res) => {
    try {
      if (!(await canAccessDeal(req, req.params.dealId))) {
        return res.status(401).json({ error: "Not authorized" });
      }
      const existing = await storage.getDocumentRequirement(req.params.reqId);
      if (!existing) {
        return res.status(404).json({ error: "Document requirement not found" });
      }
      if (existing.dealId !== req.params.dealId) {
        return res.status(403).json({ error: "Requirement does not belong to this deal" });
      }

      // Whitelist patchable fields. A broker session may edit the checklist
      // row itself; a seller token may only link an upload. Timestamps arrive
      // from the client as ISO strings — coerce into Date before they reach
      // drizzle's timestamp column (which calls .toISOString() on the value).
      const body = (req.body ?? {}) as Record<string, unknown>;
      // "Broker" here means the broker who OWNS this deal. canAccessDeal also
      // admits a seller token, so a broker session opening another firm's
      // seller link must get the seller allowlist, not the checklist editor.
      const isBrokerSession =
        !!req.session.brokerId && !!(await getOwnedDeal(req.params.dealId, req.session.brokerId));
      // The general-ledger row (gl spec E21) updates itself when the ledger is
      // read: a seller can't change it at all, the broker only its note,
      // whether it's required and its place in the list.
      const { isGlRequirement } = await import("./documents/requirements");
      if (isGlRequirement(existing)) {
        const glKeys = ["notes", "isRequired", "sortOrder"];
        const touched = Object.keys(body).filter((k) => body[k] !== undefined && k !== "reason");
        if (!isBrokerSession || touched.some((k) => !glKeys.includes(k))) {
          return res.status(409).json({ error: "This item updates itself when the ledger is read." });
        }
      }
      const allowedKeys = isBrokerSession
        ? ["status", "uploadedFileId", "uploadedBy", "uploadedAt", "notes", "isRequired", "documentName", "category", "sortOrder"]
        : ["status", "uploadedFileId", "uploadedBy"];
      const updates: Record<string, unknown> = {};
      for (const key of allowedKeys) {
        if (body[key] !== undefined) updates[key] = body[key];
      }

      const { REQUIREMENT_STATUSES, SELLER_REQUIREMENT_STATUSES, withSellerUnavailableNote, withoutSellerUnavailableNote } = await import("@shared/seller-portal");
      if (updates.status !== undefined) {
        // A seller may link an upload, take their own upload back off a
        // row, or say they don't have the document; only the broker verifies.
        const validStatuses: readonly string[] = isBrokerSession ? REQUIREMENT_STATUSES : SELLER_REQUIREMENT_STATUSES;
        if (typeof updates.status !== "string" || !validStatuses.includes(updates.status)) {
          return res.status(400).json({ error: `Invalid status. Expected one of: ${validStatuses.join(", ")}` });
        }
      }
      // "I don't have this — tell my broker": the row stops counting against
      // the seller and the reason is left for the broker (who decides: not
      // needed, or ask again). Only an empty row — a file on it is removed first.
      if (updates.status === "unavailable") {
        if (existing.status === "uploaded") {
          return res.status(409).json({ error: "Remove the file on this item first" });
        }
        const reason = typeof body.reason === "string" ? body.reason : "";
        updates.notes = withSellerUnavailableNote(typeof updates.notes === "string" ? updates.notes : existing.notes, reason);
        updates.uploadedFileId = null;
        updates.uploadedBy = null;
        updates.uploadedAt = null;
      } else if (updates.status !== undefined && existing.status === "unavailable") {
        // Asked again, or the seller found it after all: the "I don't have it" line goes.
        updates.notes = withoutSellerUnavailableNote(typeof updates.notes === "string" ? updates.notes : existing.notes);
      }
      if (updates.uploadedFileId !== undefined && updates.uploadedFileId !== null && typeof updates.uploadedFileId !== "string") {
        return res.status(400).json({ error: "uploadedFileId must be a string" });
      }
      // A linked file must be one of this deal's documents — a seller token
      // must not be able to point a checklist row at another deal's upload.
      let linkedDoc: Awaited<ReturnType<typeof storage.getDocument>> | undefined;
      if (typeof updates.uploadedFileId === "string") {
        linkedDoc = await storage.getDocument(updates.uploadedFileId);
        if (!linkedDoc || linkedDoc.dealId !== req.params.dealId) {
          return res.status(400).json({ error: "uploadedFileId must reference a document on this deal" });
        }
      }
      if (!isBrokerSession && updates.uploadedBy !== undefined && updates.status !== "unavailable") {
        updates.uploadedBy = "seller";
      }
      if (!isBrokerSession && existing.status === "verified" && (updates.status !== undefined || updates.uploadedFileId !== undefined)) {
        return res.status(409).json({ error: "Your broker has already verified this document — ask them before changing it" });
      }

      if (updates.uploadedAt !== undefined && updates.uploadedAt !== null) {
        const parsed = new Date(updates.uploadedAt as string | number | Date);
        if (Number.isNaN(parsed.getTime())) {
          return res.status(400).json({ error: "uploadedAt must be a valid date" });
        }
        updates.uploadedAt = parsed;
      }
      // Stamp the upload time server-side whenever a row transitions to uploaded.
      if (updates.status === "uploaded" && updates.uploadedAt === undefined) {
        updates.uploadedAt = new Date();
      }
      if (!isBrokerSession && updates.status === "missing" && existing.uploadedBy && existing.uploadedBy !== "seller") {
        return res.status(403).json({ error: "Your broker attached this document — ask them to change it" });
      }
      if (updates.status === "missing") {
        updates.uploadedAt = null;
        updates.uploadedFileId = null;
        updates.uploadedBy = null;
      }

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: "No updatable fields provided" });
      }

      const requirement = await storage.updateDocumentRequirement(
        req.params.reqId,
        updates as Partial<InsertDealDocumentRequirement>,
      );

      // Data room: linking a file to a row a buyer's request created makes that request "Ready to share".
      if (linkedDoc) {
        const { onRequirementFulfilled } = await import("./vdr/requests");
        await onRequirementFulfilled(existing.id, linkedDoc.id);
      }

      // Linking a file that was uploaded without a category gives it the
      // row's category so the broker's list shows "financials", not "other".
      if (linkedDoc && (linkedDoc.category === "other" || !linkedDoc.category)) {
        const { docCategoryForRequirement } = await import("./documents/requirements");
        const derived = docCategoryForRequirement(existing.category);
        if (derived !== "other") {
          await storage.updateDocument(linkedDoc.id, { category: derived } as any).catch(() => {});
        }
      }

      // A seller removing or replacing their own upload takes the old file
      // with it — they have no other way to get a mistaken upload off the
      // deal. Broker uploads are never touched from the seller side.
      const previousFileId = existing.uploadedFileId;
      const unlinkedBySeller =
        !isBrokerSession &&
        previousFileId &&
        (updates.status === "missing" || (typeof updates.uploadedFileId === "string" && updates.uploadedFileId !== previousFileId));
      if (unlinkedBySeller) {
        const previous = await storage.getDocument(previousFileId);
        if (previous && previous.dealId === req.params.dealId && previous.uploadedBy === "seller") {
          // Data room: a replacement takes the old file's place (not shared); a
          // file buyers could open, simply removed by the seller, goes to the broker's To do.
          const { markReplacement, onSourceDeleted } = await import("./vdr/setup");
          if (typeof updates.uploadedFileId === "string") await markReplacement(previous.id, updates.uploadedFileId);
          else await onSourceDeleted(previous, { bySeller: true });
          const { deleteDocumentAndProvenance } = await import("./documents/cleanup");
          await deleteDocumentAndProvenance(previous.id).catch((e) => console.warn("[documents] seller unlink cleanup failed:", e));
        }
      }

      res.json(requirement);
    } catch (error: any) {
      console.error("Error updating document requirement:", error);
      res.status(500).json({ error: "Failed to update document requirement" });
    }
  });

  // DELETE — broker removes a requirement (only source: "manual")
  app.delete("/api/deals/:dealId/document-requirements/:reqId", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const existing = await storage.getDocumentRequirement(req.params.reqId);
      if (!existing) {
        return res.status(404).json({ error: "Document requirement not found" });
      }
      if (existing.dealId !== req.params.dealId) {
        return res.status(403).json({ error: "Requirement does not belong to this deal" });
      }
      if (existing.source !== "manual") {
        return res.status(400).json({ error: "Can only delete manually-added requirements. Auto-populated requirements can be hidden by setting isRequired to false." });
      }
      await storage.deleteDocumentRequirement(req.params.reqId);
      res.json({ success: true });
    } catch (error: any) {
      console.error("Error deleting document requirement:", error);
      res.status(500).json({ error: "Failed to delete document requirement" });
    }
  });

  // POST — trigger auto-population from industry intelligence
  app.post("/api/deals/:dealId/document-requirements/populate", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const deal = await storage.getDeal(req.params.dealId);
      if (!deal) {
        return res.status(404).json({ error: "Deal not found" });
      }
      const industryCategory = (req.body.industryCategory as string) || deal.industry;
      if (!industryCategory) {
        return res.status(400).json({ error: "No industry set on deal and no industryCategory provided" });
      }
      const { populateDocumentRequirements } = await import("./documents/requirements");
      const created = await populateDocumentRequirements(deal.id, industryCategory, req.body.industryCategory ? null : deal.subIndustry);
      const requirements = await storage.getDocumentRequirementsByDeal(deal.id);
      res.json({ created, total: requirements.length, requirements });
    } catch (error: any) {
      console.error("Error populating document requirements:", error);
      res.status(500).json({ error: "Failed to populate document requirements" });
    }
  });

  // ── Re-run document extraction with the current pipeline ──
  // Re-reads every source with the current prompt and rebuilds the facts
  // (see reprocess.ts). A deal with many sources takes 10–15 minutes, so it
  // runs as a background job: POST starts it (202, or 409 with the running
  // job), GET reports its progress and, when done, what changed.
  app.post("/api/deals/:dealId/documents/reprocess", requireBroker, async (req, res) => {
    try {
      const deal = await getOwnedDeal(req.params.dealId, req.session.brokerId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });
      const { startReprocessJob } = await import("./documents/reprocess-jobs");
      const { job, started } = startReprocessJob(deal.id, async (dealId) => {
        // Intake answers are re-seeded too — split for privacy, so an answer
        // seeded before the split existed loses its personal detail.
        const { seedQuestionnaireFacts } = await import("./interview/session-manager");
        await seedQuestionnaireFacts(dealId);
      });
      res.status(started ? 202 : 409).json(job);
    } catch (error: any) {
      console.error("Reprocess error:", error);
      res.status(500).json({ error: error.message || "Failed to reprocess documents" });
    }
  });

  // Re-read ONE source (a source whose re-read failed — the job's
  // failedSources, or "Read again" on the Information tab): every other
  // source keeps what it had. Same background job and polling as above.
  app.post("/api/deals/:dealId/documents/:documentId/reprocess", requireBroker, async (req, res) => {
    try {
      const deal = await getOwnedDeal(req.params.dealId, req.session.brokerId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });
      const doc = await storage.getDocument(req.params.documentId);
      if (!doc || doc.dealId !== deal.id) return res.status(404).json({ error: "Source not found" });
      // An "Interview together" transcript is filed live and never read again (§5.8).
      const { isTogetherSitting } = await import("./together/transcript");
      if (isTogetherSitting(doc)) return res.status(409).json({ status: "together", error: "Answers from a session together are filed live and can't be read again. Edit them on the board or in Information.", message: "Answers from a session together are filed live and can't be read again. Edit them on the board or in Information." });
      // Its first read is still running (a long source read in parts): never a second, concurrent read.
      const { isBeingRead } = await import("./documents/ingest");
      if (isBeingRead(doc.id)) return res.status(409).json({ status: "running", message: "Cimple is still reading this source. It will show its facts when it's done." });
      // A data-room file stored without reading: asking for this one source to be
      // read is the broker changing their mind (vdr; "read all" still skips the others).
      const { clearStoredOnly } = await import("./documents/reprocess");
      const cleared = clearStoredOnly((doc as { sourceMeta?: Parameters<typeof clearStoredOnly>[0] }).sourceMeta ?? null);
      if (cleared) await storage.updateDocument(doc.id, { sourceMeta: cleared } as any);
      const { startReprocessJob } = await import("./documents/reprocess-jobs");
      const { job, started } = startReprocessJob(deal.id, undefined, undefined, { onlyDocumentIds: [doc.id] });
      res.status(started ? 202 : 409).json(job);
    } catch (error: any) {
      console.error("Reprocess source error:", error);
      res.status(500).json({ error: error.message || "Failed to re-read the source" });
    }
  });

  app.get("/api/deals/:dealId/documents/reprocess", requireBroker, async (req, res) => {
    try {
      const deal = await getOwnedDeal(req.params.dealId, req.session.brokerId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });
      const { reprocessJobFor } = await import("./documents/reprocess-jobs");
      res.json(reprocessJobFor(deal.id) ?? { dealId: deal.id, status: "idle" });
    } catch (error: any) {
      console.error("Reprocess status error:", error);
      res.status(500).json({ error: "Failed to read reprocess status" });
    }
  });

  // ── Public data scrape ──
  app.post("/api/deals/:dealId/scrape", requireBroker, async (req, res) => {
    try {
      const { dealId } = req.params;
      const owned = await getOwnedDeal(dealId, req.session.brokerId);
      if (!owned) return res.status(404).json({ error: "Deal not found" });
      const { websiteUrl } = req.body as { websiteUrl?: string };
      const { scrapeDeal } = await import("./scraper/index");
      const result = await scrapeDeal(dealId, websiteUrl || undefined);
      res.json(result);
    } catch (error: any) {
      console.error("Scrape error:", error);
      res.status(500).json({ error: error.message || "Failed to scrape website" });
    }
  });

  // Dual-auth PATCH: a broker session can update the broker-editable fields
  // below on a deal they own; a seller (identified by their invite token in
  // the X-Seller-Token header) can update only the intake fields on the deal
  // their token maps to. Everyone else gets 401/404.
  const SELLER_PATCHABLE_FIELDS = new Set([
    "questionnaireData",
    "operationalSystems",
    "employeeChart",
  ]);
  // What the broker UI actually sends (Overview checklist, approvals, publish,
  // phase advance; the intake wizard when a broker previews the seller view),
  // plus the plain deal-detail fields. Everything else has its own endpoint:
  // ownership (brokerId) never moves, extractedInfo is written only through
  // provenance-aware paths, archive via /archive, generation state by jobs.
  const BROKER_PATCHABLE_FIELDS = new Set([
    ...Array.from(SELLER_PATCHABLE_FIELDS),
    "businessName", "industry", "subIndustry", "location", "description", "websiteUrl",
    "askingPrice", "ndaSigned", "sqCompleted", "valuationCompleted", "engagementSent",
    "phase", "isLive",
    "contentApprovedByBroker", "contentApprovedBySeller",
    "designApprovedByBroker", "designApprovedBySeller",
    "designTemplateId", "ndaRequired", "watermarkText",
  ]);
  app.patch("/api/deals/:id", async (req, res) => {
    try {
      const { insertDealSchema } = await import("@shared/schema");

      let allowedBody: Record<string, unknown> | null = null;
      // The industry before this edit (a real change re-scopes the seller's document checklist).
      let industryBefore: { industry: string | null; subIndustry: string | null } | null = null;

      if (req.session.brokerId) {
        const owned = await getOwnedDeal(req.params.id, req.session.brokerId);
        if (!owned) return res.status(404).json({ error: "Deal not found" });
        industryBefore = { industry: owned.industry ?? null, subIndustry: owned.subIndustry ?? null };
        const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
        const { allowBackward, ...fields } = body;
        if ("brokerId" in fields || "id" in fields) {
          return res.status(400).json({ error: "A deal's id and owner can't be changed" });
        }
        const rejected = Object.keys(fields).filter((k) => !BROKER_PATCHABLE_FIELDS.has(k));
        if (rejected.length > 0) {
          return res.status(400).json({ error: `These fields can't be changed here: ${rejected.join(", ")}` });
        }
        // Phases only move forward unless the caller deliberately asks to
        // move back. An earlier phase's "Advance" button on an expanded
        // accordion used to silently drag a phase-4 deal back to phase 2.
        if (fields.phase !== undefined) {
          if (!isDealPhase(fields.phase)) {
            return res.status(400).json({ error: "Unknown phase" });
          }
          if (phaseIndex(fields.phase) < phaseIndex(owned.phase) && allowBackward !== true) {
            return res.status(409).json({
              error: `This deal is already past that step — it's in ${DEAL_PHASES[phaseIndex(owned.phase)]?.label ?? "a later phase"}.`,
              code: "phase_backward",
            });
          }
        }
        allowedBody = fields;
      } else {
        const sellerToken = req.headers["x-seller-token"];
        if (typeof sellerToken === "string" && sellerToken.length > 0) {
          const invite = await storage.getSellerInviteByToken(sellerToken);
          if (invite && invite.dealId === req.params.id) {
            allowedBody = Object.fromEntries(
              Object.entries(req.body as Record<string, unknown>).filter(([k]) =>
                SELLER_PATCHABLE_FIELDS.has(k),
              ),
            );
          }
        }
      }

      if (!allowedBody) {
        return res.status(401).json({ error: "Not authenticated" });
      }

      const validatedData = insertDealSchema.partial().parse(allowedBody);
      // Every step that moves a CIM toward buyers is gated on unresolved
      // critical discrepancies — not just generation. Without this, a CIM
      // with open critical conflicts could be approved, advanced to design
      // and published while only the Generate button was locked.
      const dealPatch = validatedData as Record<string, unknown>;
      const gatedVerb =
        dealPatch.isLive === true ? "publishing the CIM"
        : dealPatch.phase === "phase4_design_finalization" ? "advancing to Design & Finalization"
        : dealPatch.contentApprovedByBroker === true || dealPatch.contentApprovedBySeller === true ? "approving the content"
        : dealPatch.designApprovedByBroker === true || dealPatch.designApprovedBySeller === true ? "approving the design"
        : null;
      if (gatedVerb) {
        const openCritical = await blockingCriticalDiscrepancies(req.params.id);
        if (openCritical.length > 0) return discrepancyBlockResponse(res, openCritical, gatedVerb);
      }
      // Going live needs both design approvals — the UI hides Publish until
      // then, and the server now holds the same line. The broker can still
      // record the seller's approval on their behalf (same request or before).
      if (dealPatch.isLive === true) {
        const current = await storage.getDeal(req.params.id);
        const approved = (k: "designApprovedByBroker" | "designApprovedBySeller") =>
          dealPatch[k] === true || (dealPatch[k] === undefined && current?.[k] === true);
        const missing = [
          !approved("designApprovedByBroker") ? "broker" : null,
          !approved("designApprovedBySeller") ? "seller" : null,
        ].filter((m): m is string => !!m);
        if (missing.length > 0) {
          return res.status(409).json({
            error: "Both design approvals are needed before publishing",
            code: "needs_design_approvals",
            missing,
          });
        }
        // A section the AI couldn't write is a placeholder of instructions to
        // the broker: it is never served, and the CIM doesn't go live with a
        // hole in it until each one is written, regenerated or deleted.
        const publishSections = await storage.getCimSectionsByDeal(req.params.id);
        const placeholders = publishSections.filter(isCimFallbackSection);
        if (placeholders.length > 0) {
          return res.status(409).json({
            error: `${placeholders.length === 1 ? "One section" : `${placeholders.length} sections`} couldn't be written by the AI (${placeholders.slice(0, 3).map((p) => `"${p.sectionTitle}"`).join(", ")}). Regenerate, write or delete ${placeholders.length === 1 ? "it" : "them"} in the CIM builder before publishing.`,
            code: "cim_placeholders",
            sections: placeholders.map((p) => ({ id: p.id, title: p.sectionTitle })),
          });
        }
        // A blank layout's sample data ("Category A 60 / B 40") reads to a
        // buyer as real figures: a shown section still holding it blocks
        // publishing like a placeholder does.
        const sample = publishSections.filter((s) => s.isVisible !== false && hasSampleData(s));
        if (sample.length > 0) {
          return res.status(409).json({
            error: `${sample.length === 1 ? "One section still shows" : `${sample.length} sections still show`} the layout's sample data (${sample.slice(0, 3).map((p) => `"${p.sectionTitle}"`).join(", ")}). Replace it with the business's own figures, or hide or delete ${sample.length === 1 ? "the section" : "them"}, before publishing.`,
            code: "cim_sample_data",
            sections: sample.map((p) => ({ id: p.id, title: p.sectionTitle })),
          });
        }
        // Every shown section approved as it stands (shared/cim-approvals.ts)
        // — a section regenerated or edited since the approvals were given
        // never goes live unseen. The broker's design approval in this same
        // request approves them.
        if (dealPatch.designApprovedByBroker !== true) {
          const { sectionsBlockingPublish, sectionsNeedApprovalResponse } = await import("./cim/approvals");
          const awaiting = await sectionsBlockingPublish(req.params.id);
          if (awaiting.length > 0) return res.status(409).json(sectionsNeedApprovalResponse(awaiting));
        }
      }
      // A seller finishing the intake wizard completes the questionnaire
      // step — this flag drove broker checklists but was never set. The
      // wizard autosaves each step; only the final save carries
      // employeeChart, so a half-finished intake doesn't read as "done".
      if (
        !req.session.brokerId &&
        allowedBody.questionnaireData && typeof allowedBody.questionnaireData === "object" &&
        allowedBody.employeeChart !== undefined
      ) {
        const filled = Object.values(allowedBody.questionnaireData as Record<string, unknown>).some((v) => typeof v === "string" ? v.trim() !== "" : !!v);
        if (filled) (validatedData as any).sqCompleted = true;
      }
      // NDA lifecycle is server-stamped: trust the server clock on sign,
      // clear the signature details on undo.
      if (validatedData.ndaSigned === true && !validatedData.ndaSignedAt) {
        validatedData.ndaSignedAt = new Date();
        // Signed through this endpoint = the broker marked it manually; the
        // seller e-sign route stamps "seller" itself.
        (validatedData as any).ndaSignedBy = "broker";
      } else if (validatedData.ndaSigned === false) {
        validatedData.ndaSignedAt = null;
        validatedData.ndaSignerName = null;
        validatedData.ndaSignedIp = null;
        (validatedData as any).ndaSignedBy = null;
      }
      // The asking price is one value with the fact on the Information tab:
      // it's written as the broker's fact and the column follows (see
      // server/information/deal-mirror.ts) — never the column alone.
      const askingPriceSet = req.session.brokerId && "askingPrice" in (validatedData as Record<string, unknown>);
      const askingPrice = (validatedData as Record<string, unknown>).askingPrice;
      if (askingPriceSet) delete (validatedData as Record<string, unknown>).askingPrice;
      let deal = await storage.updateDeal(req.params.id, validatedData);
      if (!deal) {
        return res.status(404).json({ error: "Deal not found" });
      }
      // The broker's design approval approves every shown section as it
      // stands (the builder's ticks follow; see shared/cim-approvals.ts).
      if (req.session.brokerId && dealPatch.designApprovedByBroker === true) {
        const { approveSectionsWithDesign } = await import("./cim/approvals");
        await approveSectionsWithDesign(req.params.id);
      }
      // Publishing opens the CIM to buyers the seller approved while it was
      // unpublished (their access + invite email were held until now).
      if (dealPatch.isLive === true && req.session.brokerId) {
        const baseUrl = process.env.APP_URL || `${req.protocol}://${req.get("host")}`;
        grantWaitingApprovals(req.params.id, baseUrl).catch((err) => console.error("[approvals] publish grants failed:", err));
        // What goes live is the approved version buyers keep through later,
        // unapproved changes (shared/cim-published.ts) — recorded now for any
        // section approved before those records existed.
        const { recordPublishedVersions } = await import("./cim/published-versions");
        const shown = (await storage.getCimSectionsByDeal(req.params.id)).filter((s) => s.isVisible !== false && s.brokerApproved);
        await recordPublishedVersions(shown.map((s) => s.id));
      }
      if (askingPriceSet) {
        const { setMirroredDealFact } = await import("./information/facts");
        const { MIRROR_NOTES } = await import("./information/deal-mirror");
        await setMirroredDealFact(req.params.id, "askingPrice", askingPrice, MIRROR_NOTES.valuation);
        deal = (await storage.getDeal(req.params.id)) ?? deal;
      }
      // The broker renaming the deal or changing its industry: the facts follow
      // (the column was written above; the fact is the broker's own value).
      const identityPatch = Object.fromEntries(
        (["businessName", "industry", "subIndustry"] as const)
          .filter((k) => req.session.brokerId && k in (validatedData as Record<string, unknown>))
          .map((k) => [k, (validatedData as Record<string, unknown>)[k]]),
      );
      if (Object.keys(identityPatch).length > 0) {
        const { setMirroredDealFacts } = await import("./information/facts");
        const { MIRROR_NOTES } = await import("./information/deal-mirror");
        await setMirroredDealFacts(req.params.id, identityPatch, MIRROR_NOTES.edited);
        deal = (await storage.getDeal(req.params.id)) ?? deal;
      }
      // A changed industry brings its own document requests, and the old
      // industry's untouched ones go (the broker corrected it). An edit that
      // re-sends the same industry changes nothing.
      if (
        industryBefore &&
        ("industry" in identityPatch || "subIndustry" in identityPatch) &&
        ((deal.industry ?? null) !== industryBefore.industry || (deal.subIndustry ?? null) !== industryBefore.subIndustry)
      ) {
        const { switchIndustryDocumentRequirements } = await import("./documents/requirements");
        const { removed, added } = await switchIndustryDocumentRequirements(deal.id, deal.industry, deal.subIndustry);
        if (removed || added) console.log(`[requirements] industry changed on deal ${deal.id}: ${added} request(s) added, ${removed} untouched one(s) removed`);
      }
      // A website added later is read in the background too.
      if (req.session.brokerId && "websiteUrl" in (validatedData as Record<string, unknown>)) {
        const { scrapeInBackground } = await import("./scraper/auto-scrape");
        scrapeInBackground(deal, "website added");
      }
      // Intake answers become facts (source "questionnaire") as soon as the
      // seller saves them — the broker's Information tab and the readiness
      // score shouldn't wait for the interview to start.
      if (["questionnaireData", "operationalSystems", "employeeChart"].some((k) => (validatedData as Record<string, unknown>)[k] !== undefined)) {
        try {
          const { seedQuestionnaireFacts } = await import("./interview/session-manager");
          if ((await seedQuestionnaireFacts(req.params.id)).length > 0) deal = (await storage.getDeal(req.params.id)) ?? deal;
        } catch (e) {
          console.warn("[intake] questionnaire seeding failed:", e);
        }
      }
      // Published: a regenerated CIM held for review reaches buyers again.
      if (req.session.brokerId && dealPatch.isLive === true) {
        const { releaseBuyerHold } = await import("./cim/generation-jobs");
        await releaseBuyerHold(req.params.id);
        deal = (await storage.getDeal(req.params.id)) ?? deal;
      }
      if (!req.session.brokerId) {
        // A seller-token save gets the seller-visible fields only.
        const { sellerSafeDeal } = await import("./seller-safe-deal");
        return res.json(sellerSafeDeal(deal));
      }
      res.json(withoutFactsSnapshot(brokerFactsView(deal)));
    } catch (error: any) {
      if (error.name === "ZodError") {
        return res.status(400).json({ error: "Invalid deal data", details: error.errors });
      }
      console.error("Error updating deal:", error);
      res.status(500).json({ error: "Failed to update deal" });
    }
  });

  app.delete("/api/deals/:id", requireBroker, async (req, res) => {
    try {
      const deal = await getOwnedDeal(req.params.id, req.session.brokerId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });
      // Everything: every row carrying the deal's id, its documents' files
      // and its private media (server/deals/delete-deal.ts). The list-page
      // "Archive" is the reversible option.
      const { deleteDealEverywhere } = await import("./deals/delete-deal.js");
      await deleteDealEverywhere(req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      console.error("Error deleting deal:", error);
      res.status(500).json({ error: "Failed to delete deal" });
    }
  });

  // =============================
  // DOCUMENT ROUTES
  // =============================
  
  app.get("/api/deals/:dealId/documents", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      // Without the extracted text (never shown, and polled every 2.5 s
      // while a document is being read) — see documents/document-list.ts.
      const { listDocumentsForBroker } = await import("./documents/document-list");
      res.json(await listDocumentsForBroker(req.params.dealId));
    } catch (error: any) {
      console.error("Error fetching documents:", error);
      res.status(500).json({ error: "Failed to fetch documents" });
    }
  });

  // A placeholder row (a document that's expected but not uploaded yet).
  // Files only ever arrive through /documents/upload or the source ingest,
  // which own fileUrl, mimeType, extraction and status — see body-fields.ts.
  app.post("/api/deals/:dealId/documents", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const picked = pickBodyFields(req.body, DOCUMENT_CREATE_FIELDS, DOCUMENT_SERVER_OWNED);
      if (!picked.ok) return res.status(400).json({ error: picked.error, field: picked.field });
      const { insertDocumentSchema } = await import("@shared/schema");
      const validatedData = insertDocumentSchema.parse({
        ...picked.data,
        originalName: picked.data.originalName ?? picked.data.name,
        dealId: req.params.dealId,
        uploadedBy: "broker",
        fileUrl: "",
        status: "pending",
      });
      const document = await storage.createDocument(validatedData);
      res.json(document);
    } catch (error: any) {
      if (error.name === "ZodError") {
        return res.status(400).json({ error: "Invalid document data", details: error.errors });
      }
      console.error("Error creating document:", error);
      res.status(500).json({ error: "Failed to create document" });
    }
  });

  app.patch("/api/documents/:id", requireBroker, async (req, res) => {
    try {
      const existingDoc = await storage.getDocument(req.params.id);
      if (!existingDoc || !(await ownsDeal(req, existingDoc.dealId))) return res.status(404).json({ error: "Document not found" });
      // Rename / re-file only: the deal, the file and its extraction are
      // server-owned (a broker-set fileUrl read files off the server; a
      // broker-set dealId moved the row into another brokerage's deal).
      const picked = pickBodyFields(req.body, DOCUMENT_PATCH_FIELDS, DOCUMENT_SERVER_OWNED);
      if (!picked.ok) return res.status(400).json({ error: picked.error, field: picked.field });
      const { insertDocumentSchema } = await import("@shared/schema");
      const validatedData = insertDocumentSchema.partial().parse(picked.data);
      const document = await storage.updateDocument(req.params.id, validatedData);
      if (!document) {
        return res.status(404).json({ error: "Document not found" });
      }
      res.json(document);
    } catch (error: any) {
      if (error.name === "ZodError") {
        return res.status(400).json({ error: "Invalid document data", details: error.errors });
      }
      console.error("Error updating document:", error);
      res.status(500).json({ error: "Failed to update document" });
    }
  });

  app.delete("/api/documents/:id", requireBroker, async (req, res) => {
    try {
      const existingDoc = await storage.getDocument(req.params.id);
      if (!existingDoc || !(await ownsDeal(req, existingDoc.dealId))) return res.status(404).json({ error: "Document not found" });
      // The dialog promises "any data extracted from it will be removed":
      // the row, the facts it contributed (field provenance) AND the file on
      // disk — deleting used to leave the PDF on the volume, still servable.
      const { deleteDocumentAndProvenance } = await import("./documents/cleanup");
      const removed = await deleteDocumentAndProvenance(existingDoc.id);
      res.json({ success: true, removedFields: removed });
    } catch (error: any) {
      console.error("Error deleting document:", error);
      res.status(500).json({ error: "Failed to delete document" });
    }
  });

  // =============================
  // DOCUMENT UPLOAD + PARSING
  // =============================

  // Multer/busboy decodes multipart filenames as latin1, so UTF-8 names
  // arrive mojibake'd ("—" → "â"). Round-trip back to UTF-8; keep the raw
  // value when the round-trip produces replacement chars (genuine latin1).
  const decodeUploadName = (raw: string): string => {
    try {
      const decoded = Buffer.from(raw, "latin1").toString("utf8");
      return decoded.includes("�") ? raw : decoded;
    } catch {
      return raw;
    }
  };

  const docUpload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        const dir = path.join(uploadsDir, "docs");
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (req, file, cb) => {
        // Unguessable name (the old doc_<timestamp> could be enumerated).
        cb(null, newDocumentFileName("doc", path.extname(file.originalname)));
      },
    }),
    limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
    fileFilter: (req, file, cb) => {
      // (.doc and .ppt — the old binary Office formats — can't be read: rejected with what to do instead.)
      const allowed = [".pdf", ".txt", ".csv", ".md", ".xlsx", ".xls", ".pptx", ".docx"];
      const ext = path.extname(file.originalname).toLowerCase();
      if (!allowed.includes(ext)) {
        // Mark the rejection so the route can explain instead of a generic 400
        const reason = unsupportedFormatReason(file.originalname);
        (req as any).fileRejectionReason = reason
          ? `"${decodeUploadName(file.originalname)}": ${reason}.`
          : `"${decodeUploadName(file.originalname)}" is a ${ext || "file"} — that format isn't supported.`;
      }
      cb(null, allowed.includes(ext));
    },
  });

  // Parse + extract + merge with provenance — see server/documents/ingest.ts.
  // Fire-and-forget: the row's status flips pending → parsing → extracted/failed.
  function parseDocumentAsync(docId: string) {
    import("./documents/ingest")
      .then(({ ingestDocument }) => ingestDocument(docId))
      .catch((err) => console.error(`[parser] failed for doc ${docId}:`, err));
  }

  // Who may upload is checked BEFORE multer writes the file (it used to be
  // written first and deleted on refusal); the body is the shared
  // createUploadedDocument (server/documents/upload.ts), which the data
  // room's own upload uses too.
  const uploadAllowed = async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!(await canAccessDeal(req, req.params.dealId))) return res.status(401).json({ error: "Not authorized" });
      next();
    } catch (err) {
      console.error("Upload auth error:", err);
      res.status(500).json({ error: "Upload failed" });
    }
  };
  app.post("/api/deals/:dealId/documents/upload", uploadAllowed, docUpload.single("file"), async (req, res) => {
    try {
      if (!(await canAccessDeal(req, req.params.dealId))) {
        if (req.file?.path) fs.unlink(req.file.path, () => {});
        return res.status(401).json({ error: "Not authorized" });
      }
      if (!req.file) {
        return res.status(400).json({
          error: (req as any).fileRejectionReason || "No file uploaded",
        });
      }
      // Attribute the upload by the credential that carried it, not by
      // whatever session cookie happens to be in the browser: the seller
      // pages always send X-Seller-Token, so a broker previewing the seller
      // view (or a seller whose browser also holds a broker session) is
      // still a seller upload. canAccessDeal already admitted the request.
      const viaSellerToken = await sellerTokenMatchesDeal(req, req.params.dealId);
      const { createUploadedDocument } = await import("./documents/upload");
      const out = await createUploadedDocument({
        dealId: req.params.dealId,
        file: req.file,
        uploadedBy: viaSellerToken ? "seller" : "broker",
        body: req.body ?? {},
        // gl: the general-ledger row checks the seller link's rights (owner / accountant only).
        sellerToken: viaSellerToken ? ((req.headers["x-seller-token"] as string | undefined) || (typeof req.query.token === "string" ? req.query.token : "")) : undefined,
      });
      if (!out.ok) return res.status(out.status).json({ error: out.error });
      res.json({ ...out.doc, linkedRequirement: out.linkedRequirement, satisfiedTask: out.satisfiedTask });
    } catch (error: any) {
      console.error("Upload error:", error);
      res.status(500).json({ error: "Upload failed" });
    }
  });

  app.post("/api/documents/:id/parse", requireBroker, async (req, res) => {
    try {
      const doc = await storage.getDocument(req.params.id);
      if (!doc || !(await ownsDeal(req, doc.dealId))) return res.status(404).json({ error: "Document not found" });
      parseDocumentAsync(doc.id);
      res.json({ status: "parsing" });
    } catch (error: any) {
      res.status(500).json({ error: "Parse failed" });
    }
  });

  app.get("/api/deals/:dealId/extracted-info", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const deal = await storage.getDeal(req.params.dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });
      res.json(deal.extractedInfo || {});
    } catch (error: any) {
      res.status(500).json({ error: "Failed to fetch extracted info" });
    }
  });

  // =============================
  // INTEGRATION ROUTES
  // =============================

  // Integrations hold OAuth/CRM credentials — always broker-scoped.
  const getOwnedIntegration = async (id: string, brokerId: string | undefined) => {
    if (!brokerId) return null;
    const integration = await storage.getIntegration(id);
    if (!integration || integration.brokerId !== brokerId) return null;
    return integration;
  };

  app.get("/api/integrations", requireBroker, async (req, res) => {
    try {
      const list = await storage.getIntegrationsByBroker(req.session.brokerId!);
      // Never ship stored OAuth/API tokens to the browser
      res.json(list.map(({ accessToken: _a, refreshToken: _r, ...rest }) => rest));
    } catch (error: any) {
      res.status(500).json({ error: "Failed to fetch integrations" });
    }
  });

  app.post("/api/integrations", requireBroker, async (req, res) => {
    try {
      // Tokens only ever come from a connect flow (e.g. pipedrive/connect,
      // which validates them) — never from a raw create body.
      const picked = pickBodyFields(req.body, INTEGRATION_CREATE_FIELDS, INTEGRATION_CREATE_SERVER_OWNED);
      if (!picked.ok) return res.status(400).json({ error: picked.error, field: picked.field });
      if (typeof picked.data.provider !== "string" || !picked.data.provider.trim()) {
        return res.status(400).json({ error: "A provider is required" });
      }
      if (picked.data.status !== undefined && !(INTEGRATION_STATUSES as readonly unknown[]).includes(picked.data.status)) {
        return res.status(400).json({ error: "Unknown status" });
      }
      const integration = await storage.createIntegration({
        ...(picked.data as { provider: string }),
        brokerId: req.session.brokerId!,
      });
      const { accessToken: _a, refreshToken: _r, ...safe } = (integration || {}) as any;
      res.json(safe);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to create integration" });
    }
  });

  // Validate a Pipedrive API token server-side, then upsert the integration —
  // a bad token must never land as "connected".
  app.post("/api/integrations/pipedrive/connect", requireBroker, async (req, res) => {
    try {
      const apiToken =
        typeof req.body.apiToken === "string" ? req.body.apiToken.trim() : "";
      if (!apiToken) return res.status(400).json({ error: "API token is required" });

      const { validatePipedriveToken } = await import("./crm/pipedrive.js");
      try {
        if (!(await validatePipedriveToken(apiToken))) {
          return res
            .status(400)
            .json({ error: "Pipedrive rejected that token — double-check it and try again." });
        }
      } catch {
        return res
          .status(400)
          .json({ error: "Could not reach Pipedrive to validate the token. Try again shortly." });
      }

      const existing = (
        await storage.getIntegrationsByBroker(req.session.brokerId!)
      ).find((i) => i.provider === "pipedrive");
      const integration = existing
        ? await storage.updateIntegration(existing.id, {
            accessToken: apiToken,
            status: "connected",
            connectedAt: new Date(),
          } as any)
        : await storage.createIntegration({
            provider: "pipedrive",
            status: "connected",
            accessToken: apiToken,
            connectedAt: new Date(),
            brokerId: req.session.brokerId,
          } as any);

      // Never echo the token (or any credential) back to the browser.
      const { accessToken: _token, refreshToken: _refresh, ...safeIntegration } = (integration ?? {}) as Record<string, unknown>;
      res.json({ ok: true, integration: safeIntegration });
    } catch (error: any) {
      console.error("Pipedrive connect error:", error);
      res.status(500).json({ error: "Failed to connect Pipedrive" });
    }
  });

  // ── CRM buyer sync: the broker's CRM buyer contacts → matchable buyer
  // profiles (private to the broker; nobody is emailed). See server/crm/buyer-sync.ts.
  app.get("/api/integrations/pipedrive/buyer-sync", requireBroker, async (req, res) => {
    try {
      const { getPipedriveIntegration, effectiveBuyerSyncStatus, getPipedriveBuyerSyncOptions } = await import("./crm/buyer-sync.js");
      const brokerId = req.session.brokerId!;
      const integration = await getPipedriveIntegration(brokerId);
      if (!integration) return res.json({ connected: false });
      const saved = ((integration.config as any) || {}).buyerSync || {};
      let options: any = null;
      if (req.query.options === "1") {
        options = await getPipedriveBuyerSyncOptions(integration.accessToken!).catch((err) => {
          console.error("[buyer-sync] options failed:", err);
          return { pipelines: [], labels: [], error: "Couldn't read your Pipedrive pipelines — try again shortly." };
        });
      }
      const contacts = (await storage.getBrokerBuyerContacts(brokerId)).filter((c) => c.crmProfile);
      res.json({
        connected: true,
        settings: saved.settings ?? null,
        status: effectiveBuyerSyncStatus(brokerId, saved.status),
        lastSuccessAt: saved.lastSuccessAt ?? null,
        syncedCount: contacts.length,
        options,
      });
    } catch (err) {
      console.error("[buyer-sync] status failed:", err);
      res.status(500).json({ error: "Couldn't read the buyer sync status" });
    }
  });

  app.post("/api/integrations/pipedrive/buyer-sync", requireBroker, async (req, res) => {
    try {
      const body = z.object({
        mode: z.enum(["pipelines", "labels", "all"]),
        pipelineIds: z.array(z.number().int()).optional(),
        labelIds: z.array(z.number().int()).optional(),
        auto: z.boolean().default(true),
      }).parse(req.body);
      if (body.mode === "pipelines" && !body.pipelineIds?.length) return res.status(400).json({ error: "Pick at least one pipeline" });
      if (body.mode === "labels" && !body.labelIds?.length) return res.status(400).json({ error: "Pick at least one label" });
      const { startPipedriveBuyerSync } = await import("./crm/buyer-sync.js");
      const result = await startPipedriveBuyerSync(req.session.brokerId!, body);
      if (!result.started) {
        return res.status(result.reason === "already_running" ? 409 : 400).json({
          error: result.reason === "already_running" ? "A sync is already running" : "Connect Pipedrive first",
        });
      }
      res.status(202).json({ started: true });
    } catch (err: any) {
      if (err?.name === "ZodError") return res.status(400).json({ error: "Invalid sync settings" });
      console.error("[buyer-sync] start failed:", err);
      res.status(500).json({ error: "Couldn't start the sync" });
    }
  });

  app.patch("/api/integrations/:id", requireBroker, async (req, res) => {
    try {
      const owned = await getOwnedIntegration(req.params.id, req.session.brokerId);
      if (!owned) return res.status(404).json({ error: "Integration not found" });
      // Settings only: a brokerId in the body used to hand this broker's
      // CRM connection to another broker (their buyer sync then ran on it).
      const picked = pickBodyFields(req.body, INTEGRATION_PATCH_FIELDS, INTEGRATION_SERVER_OWNED);
      if (!picked.ok) return res.status(400).json({ error: picked.error, field: picked.field });
      if (picked.data.status !== undefined && !(INTEGRATION_STATUSES as readonly unknown[]).includes(picked.data.status)) {
        return res.status(400).json({ error: "Unknown status" });
      }
      if (Object.keys(picked.data).length === 0) {
        const { accessToken: _a, refreshToken: _r, ...unchanged } = owned as any;
        return res.json(unchanged);
      }
      const integration = await storage.updateIntegration(req.params.id, picked.data as any);
      if (!integration) return res.status(404).json({ error: "Integration not found" });
      const { accessToken: _a, refreshToken: _r, ...safe } = (integration || {}) as any;
      res.json(safe);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to update integration" });
    }
  });

  app.delete("/api/integrations/:id", requireBroker, async (req, res) => {
    try {
      const owned = await getOwnedIntegration(req.params.id, req.session.brokerId);
      if (!owned) return res.status(404).json({ error: "Integration not found" });
      await storage.deleteIntegration(req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: "Failed to delete integration" });
    }
  });

  app.get("/api/integrations/:id/emails", requireBroker, async (req, res) => {
    try {
      const integration = await getOwnedIntegration(req.params.id, req.session.brokerId);
      if (!integration) return res.status(404).json({ error: "Integration not found" });
      const emails = await storage.getIntegrationEmailsByDeal(req.params.id);
      res.json(emails);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to fetch integration emails" });
    }
  });

  app.post("/api/integrations/:id/emails", requireBroker, async (req, res) => {
    try {
      const integration = await getOwnedIntegration(req.params.id, req.session.brokerId);
      if (!integration) return res.status(404).json({ error: "Integration not found" });
      // The deal must be this broker's too — an address attached to another
      // brokerage's deal would feed that deal's seller profiling.
      const dealId = typeof req.body?.dealId === "string" ? req.body.dealId : "";
      const emailAddress = typeof req.body?.emailAddress === "string" ? req.body.emailAddress.trim() : "";
      if (!emailAddress) return res.status(400).json({ error: "An email address is required" });
      if (!dealId || !(await getOwnedDeal(dealId, req.session.brokerId))) return res.status(404).json({ error: "Deal not found" });
      const email = await storage.createIntegrationEmail({
        dealId,
        emailAddress,
        label: typeof req.body?.label === "string" ? req.body.label : null,
        integrationId: req.params.id,
      });
      res.json(email);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to add email" });
    }
  });

  app.delete("/api/integration-emails/:id", requireBroker, async (req, res) => {
    try {
      const email = await storage.getIntegrationEmail(req.params.id);
      const owned = email ? await getOwnedIntegration(email.integrationId, req.session.brokerId) : null;
      if (!email || !owned) return res.status(404).json({ error: "Email not found" });
      await storage.deleteIntegrationEmail(req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: "Failed to delete email" });
    }
  });

  // OAuth callback placeholder — real flows require Google/Microsoft app registration
  app.get("/api/auth/:provider", async (req, res) => {
    const { provider } = req.params;
    if (!["gmail", "outlook"].includes(provider)) {
      return res.status(400).json({ error: "Unsupported provider" });
    }
    // TODO: Replace with real OAuth redirect when credentials are configured
    res.status(501).json({
      error: "OAuth not yet configured",
      message: `To connect ${provider}, set up OAuth credentials in your environment variables. See the Integrations page for details.`,
      requiredEnvVars: provider === "gmail"
        ? ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]
        : ["MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET"],
    });
  });

  // =============================
  // FINANCIAL ANALYSIS ROUTES
  // =============================

  // Trigger a new financial analysis run (fire-and-forget)
  app.post("/api/deals/:dealId/financial-analysis", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const deal = await storage.getDeal(req.params.dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });

      // Create the "running" placeholder BEFORE responding so the client's
      // invalidation refetch always sees the new version and starts polling.
      // The heavy work runs in the background; one run per deal at a time.
      const { startFinancialAnalysis } = await import("./financial/analyzer");
      const placeholder = await startFinancialAnalysis(req.params.dealId, storage);

      res.json({ message: "Financial analysis started", dealId: req.params.dealId, analysisId: placeholder.id, version: placeholder.version });
    } catch (error: any) {
      if (error?.status === 409) return res.status(409).json({ error: error.message });
      console.error("Error starting financial analysis:", error);
      res.status(500).json({ error: "Failed to start financial analysis" });
    }
  });

  // A "running" row nobody has touched in 15 minutes is a crashed run (server
  // restart mid-analysis, a throw the analyzer's catch never saw, …). Serve it
  // as failed — with a note — so the client stops polling and re-enables
  // Re-run, and persist that so the row doesn't flip back on the next fetch.
  // A genuinely slow run that later finishes still overwrites this with
  // "completed", so nothing is lost.
  const STALE_ANALYSIS_MS = 15 * 60 * 1000;
  const reconcileStaleRunningAnalysis = async <
    T extends { id: string; status: string; createdAt: Date | null; updatedAt: Date | null; aiReasoning: string | null },
  >(row: T): Promise<T> => {
    if (row.status !== "running") return row;
    const touched = Math.max(
      row.updatedAt ? new Date(row.updatedAt).getTime() : 0,
      row.createdAt ? new Date(row.createdAt).getTime() : 0,
    );
    if (!touched || Date.now() - touched < STALE_ANALYSIS_MS) return row;
    const aiReasoning =
      "Analysis did not finish — it was still marked as running after 15 minutes, which usually means the server restarted mid-run. Re-run the analysis.";
    await storage.updateFinancialAnalysis(row.id, { status: "failed", aiReasoning }).catch((err: any) => {
      console.error(`Could not mark stale financial analysis ${row.id} as failed:`, err);
    });
    return { ...row, status: "failed", aiReasoning };
  };

  // Whether a finished analysis's source documents are still the deal's
  // (a deleted statement, or one added since) — the "re-run" banner.
  const financialSourceStatus = async (analysis: { dealId: string; status: string; sourceDocumentIds: unknown }) => {
    if (analysis.status !== "completed" && analysis.status !== "reviewed") return null;
    const { analysisSourceStatus } = await import("./financial/source-status");
    const status = analysisSourceStatus(analysis, await storage.getDocumentsByDeal(analysis.dealId));
    return status.message ? status : null;
  };

  // Get the latest financial analysis for a deal
  app.get("/api/deals/:dealId/financial-analysis", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const latest = await storage.getLatestFinancialAnalysis(req.params.dealId);
      if (!latest) return res.status(404).json({ error: "No financial analysis found" });
      const analysis = await reconcileStaleRunningAnalysis(latest);
      // Convert legacy-shaped rows so they render in the UI (see financial/shape.ts)
      const { normalizeFinancialAnalysisRow } = await import("./financial/shape");
      res.json({ ...normalizeFinancialAnalysisRow(analysis), sourceStatus: await financialSourceStatus(analysis) });
    } catch (error: any) {
      console.error("Error fetching financial analysis:", error);
      res.status(500).json({ error: "Failed to fetch financial analysis" });
    }
  });

  // List every analysis version for the deal (newest first) — drives the
  // version switcher so a re-run never makes the previous run unreachable.
  // Registered before "/:id" so the literal segment is not captured as an id.
  app.get("/api/deals/:dealId/financial-analysis/versions", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const rows = await storage.getFinancialAnalysesByDeal(req.params.dealId);
      const versions = await Promise.all(
        rows.map(async (row) => {
          const reconciled = await reconcileStaleRunningAnalysis(row);
          return {
            id: reconciled.id,
            version: reconciled.version,
            status: reconciled.status,
            createdAt: reconciled.createdAt,
            updatedAt: reconciled.updatedAt,
            brokerReviewedAt: reconciled.brokerReviewedAt,
          };
        }),
      );
      res.json(versions);
    } catch (error: any) {
      console.error("Error listing financial analysis versions:", error);
      res.status(500).json({ error: "Failed to list financial analysis versions" });
    }
  });

  // Get a specific financial analysis version
  app.get("/api/deals/:dealId/financial-analysis/:id", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const row = await storage.getFinancialAnalysis(req.params.id);
      if (!row || row.dealId !== req.params.dealId) {
        return res.status(404).json({ error: "Financial analysis not found" });
      }
      const analysis = await reconcileStaleRunningAnalysis(row);
      const { normalizeFinancialAnalysisRow } = await import("./financial/shape");
      res.json({ ...normalizeFinancialAnalysisRow(analysis), sourceStatus: await financialSourceStatus(analysis) });
    } catch (error: any) {
      console.error("Error fetching financial analysis:", error);
      res.status(500).json({ error: "Failed to fetch financial analysis" });
    }
  });

  // Broker edits (notes, manual comps, addback adjustments, etc.)
  app.patch("/api/deals/:dealId/financial-analysis/:id", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const existing = await storage.getFinancialAnalysis(req.params.id);
      if (!existing || existing.dealId !== req.params.dealId) {
        return res.status(404).json({ error: "Financial analysis not found" });
      }

      // Broker decisions marked for re-runs, EBITDA/SDE recomputed, and
      // everything computed from an edited table computed again (working
      // capital from the balance sheet; notes and insights from the add-backs).
      // (Factored out unchanged — "Use what the ledger shows" saves through it too.)
      const { saveBrokerAnalysisEdit } = await import("./gl/analysis-edit");
      const updated = await saveBrokerAnalysisEdit(existing, req.body ?? {});
      res.json(updated);
    } catch (error: any) {
      console.error("Error updating financial analysis:", error);
      res.status(500).json({ error: "Failed to update financial analysis" });
    }
  });

  // Re-run analysis (creates a new version)
  app.post("/api/deals/:dealId/financial-analysis/:id/rerun", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const existing = await storage.getFinancialAnalysis(req.params.id);
      if (!existing || existing.dealId !== req.params.dealId) {
        return res.status(404).json({ error: "Financial analysis not found" });
      }

      const { startFinancialAnalysis } = await import("./financial/analyzer");
      const placeholder = await startFinancialAnalysis(req.params.dealId, storage);

      res.json({ message: "Financial re-analysis started", dealId: req.params.dealId, analysisId: placeholder.id, version: placeholder.version });
    } catch (error: any) {
      if (error?.status === 409) return res.status(409).json({ error: error.message });
      console.error("Error re-running financial analysis:", error);
      res.status(500).json({ error: "Failed to re-run financial analysis" });
    }
  });

  // Route a clarifying question to the seller interview.
  //
  // Previously the client only flipped the question's status to
  // "routed_to_seller" inside the clarifyingQuestions blob — nothing consumed
  // that. The interview knowledge base reads discrepancies with status
  // "ask_seller", so routing now creates a real discrepancies row (source
  // "financial_analysis") and links it back to the question.
  app.post("/api/deals/:dealId/financial-analysis/:id/questions/:questionId/route-to-seller", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const existing = await storage.getFinancialAnalysis(req.params.id);
      if (!existing || existing.dealId !== req.params.dealId) {
        return res.status(404).json({ error: "Financial analysis not found" });
      }

      // Match against the same normalized shape the client was served (legacy
      // rows without ids/status get deterministic ids from the coercer), and
      // persist that normalized list below so ids stay stable from here on.
      const { normalizeFinancialAnalysisRow } = await import("./financial/shape");
      const normalizedRow = normalizeFinancialAnalysisRow(existing);
      const questions = Array.isArray(normalizedRow.clarifyingQuestions)
        ? (normalizedRow.clarifyingQuestions as any[])
        : [];
      const question = questions.find((q) => q && q.id === req.params.questionId);
      if (!question) return res.status(404).json({ error: "Clarifying question not found" });
      if (!question.question || typeof question.question !== "string") {
        return res.status(400).json({ error: "Question has no text to route" });
      }
      if (question.status === "answered" || question.status === "dismissed") {
        return res.status(409).json({ error: `Question is already ${question.status}` });
      }

      // Idempotent: if this question already has a live routed discrepancy, reuse it
      let discrepancy = question.discrepancyId
        ? await storage.getDiscrepancy(question.discrepancyId)
        : undefined;
      if (discrepancy && (discrepancy.dealId !== req.params.dealId || discrepancy.status === "superseded")) {
        discrepancy = undefined;
      }

      // Second idempotency layer: the question text is what becomes the
      // discrepancy's `field`. A question re-routed after a stale client copy
      // dropped its discrepancyId (or re-issued with a fresh id by a re-run)
      // must reuse the live routed row, not create a duplicate the interview
      // would then raise twice. Compare the same sliced text the create path
      // stores, normalized for whitespace and case.
      const normalizeField = (s: unknown) => String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
      // The interview reads this row: a sentence that quotes the broker's
      // private material (a CRM note, "per broker recast") is dropped, and
      // the row is flagged so the interview asks neutrally.
      // A sentence that quotes a figure only the broker's private material
      // holds goes too, whether or not it names the source ("The owner's
      // $185K isn't in the statements" when only a CRM note says $185K).
      const { mentionsPrivateSource } = await import("@shared/discrepancy-sides");
      const { loadDealFigureIndex, privateOnlyFigures } = await import("./financial/private-figures");
      const figureIndex = await loadDealFigureIndex(req.params.dealId, storage);
      const isPrivateSentence = (sentence: string) => mentionsPrivateSource(sentence) || privateOnlyFigures(sentence, figureIndex).length > 0;
      const keptQuestion = String(question.question)
        .split(/(?<=[.?!])\s+/)
        .filter((sentence) => !isPrivateSentence(sentence))
        .join(" ")
        .trim();
      // What is left after a cut must still stand as a question ("Can you
      // confirm what is booked there?" alone asks nothing) — otherwise the
      // broker resolves it here.
      const cut = keptQuestion !== String(question.question).trim();
      const publicQuestion = cut && keptQuestion.split(/\s+/).filter(Boolean).length < 8 ? "" : keptQuestion;
      const routedField = normalizeField(publicQuestion.slice(0, 200));
      if (!discrepancy) {
        const existingRouted = (await storage.getDiscrepanciesByDeal(req.params.dealId)).find(
          (d) =>
            d.source === "financial_analysis" &&
            d.status === "ask_seller" &&
            normalizeField(d.field) === routedField,
        );
        if (existingRouted) discrepancy = existingRouted;
      }

      if (!discrepancy) {
        // "high" maps to "significant" (not "critical") on purpose: an unanswered
        // question should not block CIM generation the way a critical value conflict does.
        const severity = question.severity === "low" ? "minor" : "significant";
        if (!publicQuestion) {
          return res.status(409).json({
            error: "This question quotes your private notes (a source or a figure only they hold), so it can't be sent to the seller as written. Resolve it here instead.",
            code: "private_question",
          });
        }
        const rawContext = typeof question.context === "string" && question.context.trim() ? question.context.trim() : null;
        const privateContext = !!rawContext && isPrivateSentence(rawContext);
        const context = privateContext ? null : rawContext;
        const hadPrivate = privateContext || publicQuestion !== String(question.question).trim();
        discrepancy = await storage.createDiscrepancy({
          dealId: req.params.dealId,
          // (Stamped as routed under the follow-up rules — shared/discrepancy-gate.ts.)
          sideSources: withRoutedStamp(hadPrivate ? { interview: { kind: "crm", brokerOnly: true } } : null) as any,
          field: publicQuestion.slice(0, 200),
          interviewValue: context,
          documentValue: null,
          documentId: null,
          documentName: null,
          severity,
          category: "financial",
          source: "financial_analysis",
          aiExplanation: context
            ? `Clarifying question from the financial analysis. ${context}`
            : "Clarifying question raised by the financial analysis.",
          suggestedResolution: "Ask the seller to clarify during the interview and capture their answer as the confirmed value.",
          status: "ask_seller",
        });
      } else if (discrepancy.status !== "ask_seller") {
        discrepancy = (await storage.updateDiscrepancy(discrepancy.id, { status: "ask_seller", sideSources: withRoutedStamp(discrepancy.sideSources) as any })) || discrepancy;
      }

      const updatedQuestions = questions.map((q) =>
        q && q.id === req.params.questionId
          ? { ...q, status: "routed_to_seller", discrepancyId: discrepancy!.id }
          : q,
      );
      const updated = await storage.updateFinancialAnalysis(req.params.id, {
        clarifyingQuestions: updatedQuestions,
      });

      // A seller who already finished the interview is told to come back
      // (nothing would raise it otherwise).
      const { notifySellerOfFollowUps } = await import("./interview/seller-followups");
      const sellerFollowUp = await notifySellerOfFollowUps(req.params.dealId);
      res.json({ analysis: updated, discrepancy, sellerFollowUp });
    } catch (error: any) {
      console.error("Error routing clarifying question to seller:", error);
      res.status(500).json({ error: "Failed to route question to the seller interview" });
    }
  });

  // =============================
  // ADDBACK VERIFICATION ROUTES
  // =============================

  const ADDBACK_VERIFICATION_STATUSES = ["pending_documents", "analyzing", "pending_seller_review", "verified", "failed"];

  /** Seed the initial addback list for a workflow ("provided" pulls from the financial analysis). */
  async function seedAddbacksForWorkflow(
    workflow: "provided" | "from_scratch",
    financialAnalysisId: string | null | undefined,
    dealId: string,
  ): Promise<any[]> {
    if (workflow !== "provided" || !financialAnalysisId) return [];
    const fa = await storage.getFinancialAnalysis(financialAnalysisId);
    if (!fa || fa.dealId !== dealId || !fa.normalization) return [];
    // Only the add-backs the analysis counts, with the owner's pay as one
    // line at what payroll shows (financial/addback-seed.ts).
    const { seedAddbacksFromNormalization } = await import("./financial/addback-seed");
    const { normalizeFinancialAnalysisRow } = await import("./financial/shape");
    return seedAddbacksFromNormalization((normalizeFinancialAnalysisRow(fa) as any).normalization);
  }

  // Start addback verification for a deal
  app.post("/api/deals/:dealId/addback-verification", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const { dealId } = req.params;
      const { workflow, financialAnalysisId } = req.body;

      if (!workflow || !["provided", "from_scratch"].includes(workflow)) {
        return res.status(400).json({ error: "workflow must be 'provided' or 'from_scratch'" });
      }

      const deal = await storage.getDeal(dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });

      // Guard against accidental duplicates: the newest row by updatedAt shadows
      // all others, so a second POST would silently hide prior seller confirmations.
      const current = await storage.getAddbackVerificationByDeal(dealId);
      if (current) {
        return res.status(409).json({
          error: "An addback verification already exists for this deal. Use 'Start over' to switch workflow.",
          verification: current,
        });
      }

      const initialAddbacks = await seedAddbacksForWorkflow(workflow, financialAnalysisId, dealId);

      const verification = await storage.createAddbackVerification({
        dealId,
        financialAnalysisId: financialAnalysisId || null,
        workflow,
        status: "pending_documents",
        addbacks: initialAddbacks,
        uploadedTransactionData: null,
        sellerQuestions: [],
        sourceDocumentIds: [],
      });

      res.json(verification);
    } catch (error: any) {
      console.error("Error creating addback verification:", error);
      res.status(500).json({ error: "Failed to create addback verification" });
    }
  });

  // Get latest addback verification for a deal
  app.get("/api/deals/:dealId/addback-verification", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const verification = await storage.getAddbackVerificationByDeal(req.params.dealId);
      if (!verification) return res.status(404).json({ error: "No addback verification found" });
      res.json(verification);
    } catch (error: any) {
      console.error("Error fetching addback verification:", error);
      res.status(500).json({ error: "Failed to fetch addback verification" });
    }
  });

  // Update addback verification (seller answers, manual edits, status)
  app.patch("/api/deals/:dealId/addback-verification/:id", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const existing = await storage.getAddbackVerification(req.params.id);
      if (!existing || existing.dealId !== req.params.dealId) {
        return res.status(404).json({ error: "Addback verification not found" });
      }

      const updates: any = {};
      if (req.body.addbacks !== undefined) updates.addbacks = req.body.addbacks;
      if (req.body.sellerQuestions !== undefined) updates.sellerQuestions = req.body.sellerQuestions;
      if (req.body.status !== undefined) {
        if (!ADDBACK_VERIFICATION_STATUSES.includes(req.body.status)) {
          return res.status(400).json({ error: `status must be one of: ${ADDBACK_VERIFICATION_STATUSES.join(", ")}` });
        }
        updates.status = req.body.status;
      }
      if (req.body.sourceDocumentIds !== undefined) updates.sourceDocumentIds = req.body.sourceDocumentIds;

      const updated = await storage.updateAddbackVerification(req.params.id, updates);
      res.json(updated);
    } catch (error: any) {
      console.error("Error updating addback verification:", error);
      res.status(500).json({ error: "Failed to update addback verification" });
    }
  });

  // Start over / switch workflow. Resets the existing row in place (never
  // creates a second row — the newest row by updatedAt is the one the UI
  // shows, so duplicates would hide prior work). Re-seeds addbacks for the
  // chosen workflow and clears analysis output.
  app.post("/api/deals/:dealId/addback-verification/:id/reset", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const existing = await storage.getAddbackVerification(req.params.id);
      if (!existing || existing.dealId !== req.params.dealId) {
        return res.status(404).json({ error: "Addback verification not found" });
      }

      const { workflow, financialAnalysisId } = req.body || {};
      if (!workflow || !["provided", "from_scratch"].includes(workflow)) {
        return res.status(400).json({ error: "workflow must be 'provided' or 'from_scratch'" });
      }
      if (existing.status === "analyzing") {
        return res.status(409).json({ error: "Analysis is still running. Wait for it to finish before starting over." });
      }

      const faId = financialAnalysisId || existing.financialAnalysisId || null;
      const addbacks = await seedAddbacksForWorkflow(workflow, faId, req.params.dealId);

      const updated = await storage.updateAddbackVerification(req.params.id, {
        workflow,
        financialAnalysisId: faId,
        status: "pending_documents",
        addbacks,
        uploadedTransactionData: null,
        sellerQuestions: [],
        sourceDocumentIds: [],
      });
      res.json(updated);
    } catch (error: any) {
      console.error("Error resetting addback verification:", error);
      res.status(500).json({ error: "Failed to reset addback verification" });
    }
  });

  // Trigger AI analysis after documents uploaded
  app.post("/api/deals/:dealId/addback-verification/:id/analyze", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const verification = await storage.getAddbackVerification(req.params.id);
      if (!verification || verification.dealId !== req.params.dealId) {
        return res.status(404).json({ error: "Addback verification not found" });
      }

      const deal = await storage.getDeal(req.params.dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });

      // Optional: targeted re-analysis for a single addback with a seller hint
      const { hint, targetAddbackId } = req.body || {};

      // Mark as analyzing
      await storage.updateAddbackVerification(req.params.id, { status: "analyzing" });

      // Run analysis in background
      (async () => {
        try {
          const { parseTransactionDataWithCoverage, matchAddbacksToTransactions, identifyAddbacksFromTransactions, generateSellerQuestions } = await import("./financial/addback-verifier");

          // Gather source documents — look for GL, bank statements, QB exports
          const allDocs = await storage.getDocumentsByDeal(req.params.dealId);
          const sourceDocIds = (verification.sourceDocumentIds as string[]) || [];
          const sourceDocs = sourceDocIds.length > 0
            ? allDocs.filter((d) => sourceDocIds.includes(d.id))
            : allDocs.filter((d) =>
                d.isProcessed &&
                d.extractedText &&
                (d.subcategory === "general_ledger" ||
                 d.subcategory === "bank_statement" ||
                 d.subcategory === "quickbooks_export" ||
                 d.subcategory === "pnl_detail" ||
                 d.category === "financials"),
              );

          if (sourceDocs.length === 0) {
            await storage.updateAddbackVerification(req.params.id, {
              status: "failed",
              addbacks: verification.addbacks as any,
            });
            return;
          }

          // Parse all transaction data
          let allTransactions: any[] = [];
          // Sources read only in part (a very long PDF statement): said on every add-back.
          const partlyRead: string[] = [];
          for (const doc of sourceDocs) {
            if (!doc.extractedText) continue;
            const sourceType = doc.subcategory === "bank_statement"
              ? "bank"
              : doc.subcategory === "quickbooks_export" || doc.subcategory === "pnl_detail"
              ? "quickbooks"
              : "gl";
            const { transactions: parsed, readChars, totalChars } = await parseTransactionDataWithCoverage(doc.extractedText, sourceType as any, doc.id);
            if (readChars < totalChars) {
              partlyRead.push(`"${doc.name}" (the first ${Math.round((100 * readChars) / Math.max(1, totalChars))}% was read)`);
            }
            if (parsed.length === 0) {
              console.warn(`[addback-verification] No transactions could be read from "${doc.name}" (${doc.id}, ${sourceType}, ${doc.extractedText.length} chars)`);
            }
            allTransactions = allTransactions.concat(parsed.map((t) => ({ ...t, documentId: doc.id })));
          }

          // Nothing parsed from any source is a failure the broker must see —
          // not a silent "No Match" on every addback. sourceDocumentIds records
          // which documents were checked so the UI can name them.
          if (allTransactions.length === 0) {
            console.error(`[addback-verification] 0 transactions parsed across ${sourceDocs.length} document(s): ${sourceDocs.map((d) => d.name).join(", ")}`);
            await storage.updateAddbackVerification(req.params.id, {
              status: "failed",
              addbacks: verification.addbacks as any,
              sourceDocumentIds: sourceDocs.map((d) => d.id),
            });
            return;
          }

          let updatedAddbacks: any[];
          let questions: any[];
          const partlyReadNote = partlyRead.length > 0 ? `Only part of ${partlyRead.join(", ")} could be read for matching.` : "";

          if (verification.workflow === "provided") {
            // Workflow A — match existing addbacks
            const currentAddbacks = (verification.addbacks as any[]) || [];

            // If hint + targetAddbackId provided, only re-match that specific addback
            const addbacksToMatch = targetAddbackId && hint
              ? currentAddbacks.filter((ab) => ab.id === targetAddbackId).map((ab) => ({
                  ...ab,
                  description: `${ab.description || ""}\n\nSeller hint: ${hint}`,
                }))
              : currentAddbacks;

            const matchResults = await matchAddbacksToTransactions(
              addbacksToMatch,
              allTransactions,
              deal.industry,
              sourceDocs[0]?.id || "",
            );

            updatedAddbacks = currentAddbacks.map((ab) => {
              const match = matchResults.find((m) => m.addbackId === ab.id);
              if (!match) return ab;
              // A partial match stays partial ("Partly supported"), with what the
              // linked transactions actually add up to — worked out in code.
              const coverage = [match.coverageNote, partlyReadNote].filter(Boolean).join(" ");
              return {
                ...ab,
                verificationStatus: partlyReadNote && match.verificationStatus === "no_match" ? "unverified" : match.verificationStatus,
                matchedTransactions: match.matchedTransactions,
                totalMatchedAmount: match.totalMatchedAmount,
                claimedAmount: match.claimedAmount,
                aiNotes: match.aiNotes,
                coverageNote: coverage || null,
              };
            });

            questions = await generateSellerQuestions(
              updatedAddbacks.map((ab) => ({
                ...ab,
                verificationStatus: ab.verificationStatus,
                matchedTransactions: ab.matchedTransactions,
              })),
              allTransactions,
              [],
            );
          } else {
            // Workflow B — discover addbacks from scratch
            const identified = await identifyAddbacksFromTransactions(
              allTransactions,
              deal.industry,
              {
                businessName: deal.businessName,
                askingPrice: listedAskingPrice(deal) || undefined,
              },
            );

            updatedAddbacks = identified.map((ab) => ({
              ...ab,
              coverageNote: [ab.coverageNote, partlyReadNote].filter(Boolean).join(" ") || null,
              sellerNotes: null,
            }));

            questions = await generateSellerQuestions(
              updatedAddbacks as any,
              allTransactions,
              [],
            );
          }

          await storage.updateAddbackVerification(req.params.id, {
            status: "pending_seller_review",
            addbacks: updatedAddbacks,
            uploadedTransactionData: allTransactions.slice(0, 5000), // cap stored transactions
            sellerQuestions: questions,
            sourceDocumentIds: sourceDocs.map((d) => d.id),
          });
        } catch (err: any) {
          console.error("Addback verification analysis failed:", err);
          await storage.updateAddbackVerification(req.params.id, {
            status: "failed",
          });
        }
      })();

      res.json({ message: "Analysis started", id: req.params.id });
    } catch (error: any) {
      console.error("Error starting addback analysis:", error);
      res.status(500).json({ error: "Failed to start analysis" });
    }
  });

  // Seller confirms matches
  app.post("/api/deals/:dealId/addback-verification/:id/confirm", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const verification = await storage.getAddbackVerification(req.params.id);
      if (!verification || verification.dealId !== req.params.dealId) {
        return res.status(404).json({ error: "Addback verification not found" });
      }

      const addbacks = (verification.addbacks as any[]) || [];
      const allConfirmed = addbacks.every(
        (ab) => ab.verificationStatus === "seller_confirmed" || ab.verificationStatus === "disputed",
      );

      const updated = await storage.updateAddbackVerification(req.params.id, {
        status: allConfirmed ? "verified" : "pending_seller_review",
        addbacks: addbacks,
      });

      res.json(updated);
    } catch (error: any) {
      console.error("Error confirming addbacks:", error);
      res.status(500).json({ error: "Failed to confirm addbacks" });
    }
  });

  // =============================
  // TASK ROUTES
  // =============================

  app.get("/api/deals/:dealId/tasks", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const tasks = await storage.getTasksByDeal(req.params.dealId);
      res.json(tasks);
    } catch (error: any) {
      console.error("Error fetching tasks:", error);
      res.status(500).json({ error: "Failed to fetch tasks" });
    }
  });

  app.post("/api/deals/:dealId/tasks", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const { insertTaskSchema } = await import("@shared/schema");
      const validatedData = insertTaskSchema.parse({
        ...req.body,
        dealId: req.params.dealId,
        createdBy: req.session.brokerId,
      });
      const task = await storage.createTask(validatedData);
      res.json(task);
    } catch (error: any) {
      if (error.name === "ZodError") {
        return res.status(400).json({ error: "Invalid task data", details: error.errors });
      }
      console.error("Error creating task:", error);
      res.status(500).json({ error: "Failed to create task" });
    }
  });

  app.patch("/api/tasks/:id", requireBroker, async (req, res) => {
    try {
      const existingTask = await storage.getTask(req.params.id);
      if (!existingTask || !(await ownsDeal(req, existingTask.dealId))) return res.status(404).json({ error: "Task not found" });
      // Never the deal or the author: a task moved by dealId landed in
      // another brokerage's deal.
      const picked = pickBodyFields(req.body, TASK_PATCH_FIELDS, TASK_SERVER_OWNED);
      if (!picked.ok) return res.status(400).json({ error: picked.error, field: picked.field });
      const { insertTaskSchema } = await import("@shared/schema");
      const validatedData = insertTaskSchema.partial().parse(picked.data);
      // Closed from the broker's open-items list: stamped by the server clock.
      if ((validatedData.status === "completed" || validatedData.status === "authorized_skip") && !validatedData.completedAt) {
        (validatedData as Record<string, unknown>).completedAt = new Date();
      }
      const task = await storage.updateTask(req.params.id, validatedData);
      if (!task) {
        return res.status(404).json({ error: "Task not found" });
      }
      res.json(task);
    } catch (error: any) {
      if (error.name === "ZodError") {
        return res.status(400).json({ error: "Invalid task data", details: error.errors });
      }
      console.error("Error updating task:", error);
      res.status(500).json({ error: "Failed to update task" });
    }
  });

  app.delete("/api/tasks/:id", requireBroker, async (req, res) => {
    try {
      const existingTask = await storage.getTask(req.params.id);
      if (!existingTask || !(await ownsDeal(req, existingTask.dealId))) return res.status(404).json({ error: "Task not found" });
      await storage.deleteTask(req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      console.error("Error deleting task:", error);
      res.status(500).json({ error: "Failed to delete task" });
    }
  });

  // ── Early-access requests from the cimple.ca landing page ──
  app.post("/api/early-access", async (req, res) => {
    try {
      const email = typeof req.body.email === "string" ? req.body.email.trim() : "";
      const firm = typeof req.body.firm === "string" ? req.body.firm.trim() : "";
      if (!email || !/.+@.+\..+/.test(email)) {
        return res.status(400).json({ error: "A valid email is required" });
      }
      console.log(`[early-access] ${email}${firm ? ` (${firm})` : ""}`);
      // Best-effort notify — the visitor always gets a friendly yes.
      sendDirectEmail(
        "aim.kitabi@gmail.com",
        `Early access request: ${email}`,
        `
    <div style="font-family: Inter, system-ui, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; background: #0a0a0b; color: #e5e5e5;">
      <h2 style="color: #c9a86a; margin-bottom: 16px;">New early-access request</h2>
      <p><strong>Email:</strong> ${email.replace(/</g, "&lt;")}</p>
      ${firm ? `<p><strong>Brokerage:</strong> ${firm.replace(/</g, "&lt;")}</p>` : ""}
      <p style="color: #888; font-size: 12px;">Submitted via cimple.ca ${new Date().toLocaleString()}</p>
    </div>
  `,
      ).catch(() => {});
      res.json({ ok: true });
    } catch (error: any) {
      console.error("Early-access error:", error);
      res.status(500).json({ error: "Something went wrong" });
    }
  });

  // =============================
  // SELLER INVITE ROUTES
  // =============================
  
  // Prefer APP_URL; fall back to the requesting host so non-production
  // deploys never email links pointing at the production URL.
  const appBase = (req: Request) =>
    process.env.APP_URL || `${req.protocol}://${req.get("host")}`;

  // One invite per seller email per deal — both the questionnaire invite and
  // the NDA flow share the same token. Validates through the insert schema.
  // (Moved to server/deals/seller-invites.ts unchanged — "Add-backs in the books" uses it too.)
  const { findOrCreateSellerInvite } = await import("./deals/seller-invites");

  const sellerInviteEmailHtml = (
    sellerName: string | null,
    businessName: string,
    inviteUrl: string,
  ) => `
    <div style="font-family: Inter, system-ui, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; background: #0a0a0a; color: #e5e5e5;">
      <h2 style="color: #14b8a6; margin-bottom: 16px;">Let's tell the story of ${escapeHtml(businessName)}</h2>
      <p>Hello${sellerName ? ` ${escapeHtml(sellerName)}` : ""},</p>
      <p>Your broker is preparing the confidential sale materials for <strong>${escapeHtml(businessName)}</strong> and has set up a secure workspace for you on Cimple.</p>
      <p>One link covers everything: a short questionnaire, document uploads, and a guided interview with an AI advisor that helps you present the business at its best.</p>
      <p style="margin: 32px 0;">
        <a href="${inviteUrl}" style="background: #14b8a6; color: #0a0a0a; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">Start your business profile</a>
      </p>
      <p style="color: #888; font-size: 12px;">This is your personal secure link — please don't forward it. You can stop and resume any time; your progress is saved.</p>
    </div>
  `;

  // Creates (or re-sends) the seller's invite. One invite per seller email —
  // repeat sends reuse the same token instead of minting new live links.
  app.post("/api/deals/:dealId/invites", requireBroker, async (req, res) => {
    try {
      const deal = await getOwnedDeal(req.params.dealId, req.session.brokerId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });

      const sellerEmail =
        typeof req.body.sellerEmail === "string" ? req.body.sellerEmail.trim() : "";
      const sellerName =
        typeof req.body.sellerName === "string" ? req.body.sellerName.trim() : "";

      let invite = await findOrCreateSellerInvite(deal.id, sellerEmail, sellerName);

      const inviteUrl = `${appBase(req)}/seller/${invite.token}`;
      let emailSent = false;
      if (sellerEmail) {
        emailSent = await sendDirectEmail(
          sellerEmail,
          `${deal.businessName}: start your business profile`,
          sellerInviteEmailHtml(invite.sellerName ?? null, deal.businessName, inviteUrl),
        );
        if (emailSent) {
          const updated = await storage.updateSellerInvite(invite.id, {
            sentAt: new Date(),
            // Never regress an accepted invite back to "sent".
            ...(invite.status === "accepted" ? {} : { status: "sent" as const }),
          });
          if (updated) invite = updated;
        }
      }

      res.json({ ...invite, inviteUrl, emailSent });
    } catch (error: any) {
      if (error.name === "ZodError") {
        return res.status(400).json({ error: "Invalid invite data", details: error.errors });
      }
      console.error("Error creating invite:", error);
      res.status(500).json({ error: "Failed to create invite" });
    }
  });

  // Broker-facing invite list — powers the invite status card + copy-link UI.
  app.get("/api/deals/:dealId/invites", requireBroker, async (req, res) => {
    try {
      const deal = await getOwnedDeal(req.params.dealId, req.session.brokerId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });
      const invites = await storage.getSellerInvitesByDealId(deal.id);
      res.json(invites);
    } catch (error: any) {
      console.error("Error listing invites:", error);
      res.status(500).json({ error: "Failed to list invites" });
    }
  });

  // ── Seller NDA e-sign (optional flow — brokers can also mark signed manually) ──
  app.post("/api/deals/:dealId/nda/send", requireBroker, async (req, res) => {
    try {
      const deal = await getOwnedDeal(req.params.dealId, req.session.brokerId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });

      const sellerEmail =
        typeof req.body.sellerEmail === "string" ? req.body.sellerEmail.trim() : "";
      const ndaText = typeof req.body.ndaText === "string" ? req.body.ndaText.trim() : "";
      if (!sellerEmail) return res.status(400).json({ error: "Seller email is required" });
      if (!ndaText) return res.status(400).json({ error: "Agreement text is required" });

      // Record the pending-signature state so the broker can see it went
      // out (and to whom) instead of guessing and double-sending.
      await storage.updateDeal(deal.id, { ndaText, ndaSentAt: new Date(), ndaSentTo: sellerEmail } as any);

      // Reuse the seller's existing invite token so one link identity covers
      // the whole engagement; create one if the seller was never invited.
      const invite = await findOrCreateSellerInvite(
        deal.id,
        sellerEmail,
        typeof req.body.sellerName === "string" ? req.body.sellerName.trim() : null,
      );

      const url = `${appBase(req)}/sign-nda/${invite.token}`;
      const emailSent = await sendDirectEmail(
        sellerEmail,
        `Signature requested: confidentiality agreement for ${deal.businessName}`,
        `
    <div style="font-family: Inter, system-ui, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; background: #0a0a0a; color: #e5e5e5;">
      <h2 style="color: #14b8a6; margin-bottom: 16px;">Signature requested</h2>
      <p>Hello${invite.sellerName ? ` ${escapeHtml(invite.sellerName)}` : ""},</p>
      <p>Your broker has requested your signature on a confidentiality agreement for <strong>${escapeHtml(deal.businessName)}</strong>. It takes under a minute — review the agreement and sign by typing your name.</p>
      <p style="margin: 32px 0;">
        <a href="${url}" style="background: #14b8a6; color: #0a0a0a; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">Review &amp; sign</a>
      </p>
      <p style="color: #888; font-size: 12px;">This is your personal secure link — please don't forward it.</p>
    </div>
  `,
      );

      res.json({ ok: true, url, emailSent });
    } catch (error: any) {
      console.error("Error sending NDA:", error);
      res.status(500).json({ error: "Failed to send NDA" });
    }
  });

  app.get("/api/sign-nda/:token", async (req, res) => {
    try {
      const invite = await storage.getSellerInviteByToken(req.params.token);
      if (!invite) return res.status(404).json({ error: "Signing link not found or expired" });
      const deal = await storage.getDeal(invite.dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });
      if (!deal.ndaText) {
        return res.status(404).json({ error: "No agreement is pending for this link" });
      }
      const broker = deal.brokerId ? await storage.getUser(deal.brokerId) : null;
      res.json({
        businessName: deal.businessName,
        brokerName: brokerDisplayName(broker),
        ndaText: deal.ndaText,
        ndaSigned: !!deal.ndaSigned,
        ndaSignedAt: deal.ndaSignedAt,
        signerName: deal.ndaSignerName || null,
        // "broker" when marked signed manually, "seller" when e-signed here.
        // Legacy rows predate the column: a signer name means seller e-sign.
        signedBy: (deal as any).ndaSignedBy || (deal.ndaSignerName ? "seller" : deal.ndaSigned ? "broker" : null),
        // The same token is the seller's portal link (findOrCreateSellerInvite
        // reuses it), so the page can send them back to their portal.
        sellerPortalPath: `/seller/${invite.token}`,
      });
    } catch (error: any) {
      console.error("Error loading NDA:", error);
      res.status(500).json({ error: "Failed to load agreement" });
    }
  });

  app.post("/api/sign-nda/:token", async (req, res) => {
    try {
      const invite = await storage.getSellerInviteByToken(req.params.token);
      if (!invite) return res.status(404).json({ error: "Signing link not found or expired" });
      const deal = await storage.getDeal(invite.dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });
      if (deal.ndaSigned) {
        // Already signed by someone — report the signer of record instead of
        // letting a second signer believe their signature was recorded.
        return res.json({
          ok: true,
          alreadySigned: true,
          signerName: deal.ndaSignerName || null,
          ndaSignedAt: deal.ndaSignedAt,
        });
      }

      const signerName =
        typeof req.body.signerName === "string" ? req.body.signerName.trim() : "";
      if (!signerName) return res.status(400).json({ error: "Please type your full name to sign" });

      await storage.updateDeal(deal.id, {
        ndaSigned: true,
        ndaSignedAt: new Date(),
        ndaSignerName: signerName,
        ndaSignedIp: req.ip || null,
        ndaSignedBy: "seller",
      } as any);

      // Let the broker know — best-effort, never blocks the signature.
      const broker = deal.brokerId ? await storage.getUser(deal.brokerId) : null;
      if (broker?.email) {
        sendDirectEmail(
          broker.email,
          `NDA signed: ${deal.businessName}`,
          `
    <div style="font-family: Inter, system-ui, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; background: #0a0a0a; color: #e5e5e5;">
      <h2 style="color: #14b8a6; margin-bottom: 16px;">NDA signed</h2>
      <p><strong>${escapeHtml(signerName)}</strong> just signed the confidentiality agreement for <strong>${escapeHtml(deal.businessName)}</strong>.</p>
      <p style="color: #888; font-size: 12px;">Signed ${new Date().toLocaleString()} — recorded with timestamp and IP in the deal.</p>
    </div>
  `,
        ).catch(() => {});
      }

      res.json({ ok: true });
    } catch (error: any) {
      console.error("Error signing NDA:", error);
      res.status(500).json({ error: "Failed to record signature" });
    }
  });

  app.get("/api/invites/:token", async (req, res) => {
    try {
      let invite = await storage.getSellerInviteByToken(req.params.token);
      if (!invite) {
        return res.status(404).json({ error: "Invite not found or expired" });
      }

      // First open = accepted; powers the broker's "seller in progress" status.
      // The deal's own broker previewing the seller view must not trip it.
      const isOwningBroker =
        !!req.session?.brokerId &&
        (await storage.getDeal(invite.dealId))?.brokerId === req.session.brokerId;
      if (!invite.acceptedAt && !isOwningBroker) {
        const stamped = await storage.updateSellerInvite(invite.id, {
          acceptedAt: new Date(),
          status: "accepted",
        });
        if (stamped) invite = stamped;
      }

      // Get the associated deal
      const deal = await storage.getDeal(invite.dealId);
      if (!deal) {
        return res.status(404).json({ error: "Associated deal not found" });
      }

      // Seller-visible fields only — never the broker's facts, CRM link,
      // notes, seller profile or call/bot secrets.
      const { sellerSafeDeal } = await import("./seller-safe-deal");
      res.json({ invite, deal: sellerSafeDeal(deal) });
    } catch (error: any) {
      console.error("Error fetching invite:", error);
      res.status(500).json({ error: "Failed to fetch invite" });
    }
  });

  // ── Seller progress (token-based, no login) ──
  app.get("/api/seller/:token/progress", async (req, res) => {
    try {
      const invite = await storage.getSellerInviteByToken(req.params.token);
      if (!invite) return res.status(404).json({ error: "Invite not found" });

      const deal = await storage.getDeal(invite.dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });

      // Interview sessions
      const { db } = await import("./db");
      const { interviewSessions, buyerQuestions } = await import("@shared/schema");
      const { eq: eqOp, desc: descOp } = await import("drizzle-orm");
      // (The seller's own and broker-led sessions — the broker's own sessions
      // are not the seller's progress: session-mode.ts.)
      const sessions = contextSessions(
        await db.select().from(interviewSessions)
          .where(eqOp(interviewSessions.dealId, deal.id))
          .orderBy(descOp(interviewSessions.lastActivityAt)),
      );

      // Interview coverage — built exactly as the interview header builds it
      // (the seller-safe knowledge base: nothing a broker-only source
      // asserted, not the broker's listed price, the session's confidence
      // labels, resolved discrepancies), so the seller never sees two
      // different quality labels. The RECORDED coverage, as the interview
      // header shows it: what the file merely states somewhere (on-file
      // evidence) steers the interview's questions but is not a recorded
      // fact — counting it here showed "Buyer-ready 94" beside the
      // header's "Solid 60".
      const { assembleKnowledgeBase } = await import("./interview/knowledge-base");
      const kbDocuments = await storage.getDocumentsByDeal(deal.id);
      const sellerTasks = sellerSideTasks(await storage.getTasksByDeal(deal.id));
      const progressKb = assembleKnowledgeBase(
        deal,
        kbDocuments,
        sellerTasks,
        sessions[0] ?? null,
        await storage.getResolvedDiscrepancies(deal.id),
      );
      const sectionCoverage = progressKb.recordedCoverage ?? progressKb.sectionCoverage;
      const readiness = computeCimReadiness(sectionCoverage);
      // The coverage board's seller numbers (shared/coverage-board.ts): the
      // same items, statuses and "% collected" as the seller's interview
      // header and "What we've covered", and the broker's board. Statuses
      // and counts only — never a value. (Replaces the old section formula.)
      const allDiscrepanciesForProgress = await storage.getDiscrepanciesByDeal(deal.id);
      const { boardFromCoverage, coverageInputsFrom, activeMarksForDeal } = await import("./interview/coverage-board");
      const sellerBoard = boardFromCoverage(
        coverageInputsFrom({
          deal,
          documents: kbDocuments,
          sessions,
          openDiscrepancies: allDiscrepanciesForProgress,
          resolvedDiscrepancies: await storage.getResolvedDiscrepancies(deal.id),
          marks: await activeMarksForDeal(deal.id),
          brokerFacts: {},
        }),
        "seller",
      );
      const interviewPct = sellerBoard.percentCollected;
      const hasActiveSession = sessions.some((s) => s.status === "active");
      // A session the broker reopened no longer counts as the interview being done.
      // (Not one the broker reopened, nor one closed because "Interview
      // together" took over — session-mode.ts sessionFinishedInterview.)
      const hasCompletedSession = sessions.some((s) => sessionFinishedInterview(s));
      const interviewCompleted = !!(deal as any).interviewCompleted || hasCompletedSession;

      // Document requirements. A row the seller says they don't have stops
      // counting against them until the broker decides (shared/seller-portal).
      const { checklistCounts, sellerIntakeState, sellerSteps, sellerTodoItems, sellerReviewStage } = await import("@shared/seller-portal");
      const docReqs = await storage.getDocumentRequirementsByDeal(deal.id);
      const docCounts = checklistCounts(docReqs);
      const docPct = docCounts.percentage;

      // Uploaded documents — broker-only sources (CRM notes, private emails)
      // never reach the seller.
      // (An "Interview together" transcript is shared with the interview,
      // but never listed among the seller's own documents — §7.5.)
      const { isTogetherSitting } = await import("./together/transcript");
      const allDocs = kbDocuments.filter((d) => (d as any).visibility !== "broker_only" && !isTogetherSitting(d));
      const sellerRoomDocs = await (await import("./vdr/seller-chips")).sellerRoomDocumentIds(deal.id);

      // Buyer questions waiting on the seller's approval — each with its own
      // review link, on every step (the approval email can land in spam).
      const pendingQuestions = await db.select().from(buyerQuestions)
        .where(eqOp(buyerQuestions.dealId, deal.id));
      // Only for a link whose holder approves buyer answers (the roles
      // qa_needs_approval is routed to) — an accountant's or attorney's link
      // never gets the buyer's question, the broker's draft or the publish
      // link (shared/seller-link-rights.ts).
      const { sellerLinkRights } = await import("@shared/seller-link-rights");
      const linkRights = sellerLinkRights(invite, await storage.getDealMembers(deal.id));
      const pendingSeller = linkRights.canApproveQa
        ? pendingQuestions.filter((q) => q.status === "pending_seller")
        : [];

      // The interview's to-dos: documents it asked for and things to look up.
      const todo = sellerTodoItems(sellerTasks);

      // Questions the broker routed back to the seller after the interview
      // (a conflict to clear up). Only the count — the rows are the broker's.
      // (Plus the data points the broker asked to raise next at the end of an
      // "Interview together" session, while they aren't on file.)
      const { getInterviewOutline: outlineOf, openFollowUpItems } = await import("./interview/outline");
      const boardItemStatus = new Map(sellerBoard.sections.flatMap((s) => s.items.map((i) => [i.id, i.status] as const)));
      const followUpItemsOpen = openFollowUpItems(outlineOf(deal)).filter((f) => boardItemStatus.get(f.itemId) !== "on_file").length;
      const followUpQuestions = interviewCompleted
        // INTEGRATION §2.11 (C16): routed discrepancies + dd's figure questions
        // with the seller + together's open follow-up data points, each counted once.
        ? allDiscrepanciesForProgress.filter((d) => d.status === "ask_seller" && !!routedToSellerAt(d)).length
          + (await figureQuestionsWithSeller(deal.id)) // dd: questions about the figures with the seller
          + followUpItemsOpen
        : 0;

      // Step status. Intake is complete when the last intake page (Key
      // People) is saved — page 1 alone used to count.
      const intake = sellerIntakeState(deal);
      const { currentStep, steps } = sellerSteps({ intake, interviewCompleted, interviewPct, docPct });
      const reviewStage = sellerReviewStage(deal);

      // Broker contact (their display name, else the brokerage — never the login username)
      const broker = await storage.getUser(deal.brokerId);
      const sellerBrokerCompany = broker ? ((await storage.getBrandingByBroker(deal.brokerId).catch(() => undefined)) as any)?.companyName?.trim() || null : null;

      res.json({
        businessName: deal.businessName,
        industry: deal.industry,
        currentStep,
        steps,
        interview: {
          completed: interviewCompleted,
          hasActiveSession,
          percentage: interviewPct,
          readiness,
          // Per CIM section: how many of its data points are on file (no values).
          sections: sellerBoard.sections.map((s) => {
            const counted = s.items.filter((i) => i.origin !== "figures");
            return { key: s.key, title: s.title, onFile: counted.filter((i) => i.status === "on_file").length, items: counted.length };
          }),
          totals: sellerBoard.totals,
        },
        intake,
        documents: {
          requiredTotal: docCounts.requiredTotal,
          requiredUploaded: docCounts.requiredUploaded,
          requiredUnavailable: docCounts.requiredUnavailable,
          percentage: docPct,
          totalUploaded: allDocs.length,
          requirements: docReqs.map((r) => {
            const linked = r.uploadedFileId ? allDocs.find((d) => d.id === r.uploadedFileId) : undefined;
            return {
              id: r.id,
              name: r.documentName,
              category: r.category,
              isRequired: r.isRequired,
              status: r.status,
              notes: r.notes,
              uploadedFileId: linked?.id ?? null,
              uploadedFileName: linked?.name ?? null,
              uploadedBy: r.uploadedBy ?? null,
              uploadedAt: r.uploadedAt ?? null,
              // vdr §7: shared with buyers who signed an NDA (never who, never activity); the broker's "needed by".
              inDataRoom: !!linked && sellerRoomDocs.has(linked.id),
              neededBy: (r as any).neededBy ?? null,
            };
          }),
        },
        todo,
        followUpQuestions,
        cimReview: { stage: reviewStage, canApprove: linkRights.canApproveCim },
        // "Show us where a few costs are in your books" (gl) — only for a link that may do it (owner / accountant).
        glTracing: linkRights.canTraceAddbacks
          ? await (await import("./gl/progress")).sellerGlProgress(invite, await storage.getDealMembers(deal.id))
          : null,
        pendingApprovals: pendingSeller.length,
        pendingApprovalItems: pendingSeller
          .filter((q) => !!q.sellerApprovalToken)
          .map((q) => ({ id: q.id, question: q.question, href: `/approve/${q.sellerApprovalToken}` })),
        broker: broker ? { name: brokerDisplayName(broker) || sellerBrokerCompany || "Your broker", email: broker.email } : null,
      });
    } catch (error: any) {
      console.error("Error fetching seller progress:", error);
      res.status(500).json({ error: "Failed to fetch seller progress" });
    }
  });

  app.patch("/api/invites/:id", requireBroker, async (req, res) => {
    try {
      const existingInvite = await storage.getSellerInvite(req.params.id);
      if (!existingInvite || !(await ownsDeal(req, existingInvite.dealId))) return res.status(404).json({ error: "Invite not found" });
      const { dealId: _d, token: _t, id: _i, ...inviteUpdates } = req.body || {};
      const invite = await storage.updateSellerInvite(req.params.id, inviteUpdates);
      if (!invite) {
        return res.status(404).json({ error: "Invite not found" });
      }
      res.json(invite);
    } catch (error: any) {
      console.error("Error updating invite:", error);
      res.status(500).json({ error: "Failed to update invite" });
    }
  });

  // Mark onboarding as completed (token-based, used by SellerOnboarding)
  app.post("/api/seller/:token/onboarding-complete", async (req, res) => {
    try {
      const invite = await storage.getSellerInviteByToken(req.params.token);
      if (!invite) return res.status(404).json({ error: "Invite not found" });
      const updated = await storage.updateSellerInvite(invite.id, { onboardingCompleted: true });
      res.json({ success: true, invite: updated });
    } catch (error: any) {
      console.error("Error marking onboarding complete:", error);
      res.status(500).json({ error: "Failed to update onboarding status" });
    }
  });

  // =============================
  // BUYER ACCESS ROUTES
  // =============================
  
  app.get("/api/deals/:dealId/buyers", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const buyers = await storage.getBuyerAccessByDeal(req.params.dealId);
      // Normalize response for frontend
      const normalizedBuyers = buyers.map(buyer => ({
        ...buyer,
        isActive: !buyer.revokedAt,
        viewCount: buyer.viewCount || 0,
      }));
      res.json(normalizedBuyers);
    } catch (error: any) {
      console.error("Error fetching buyers:", error);
      res.status(500).json({ error: "Failed to fetch buyers" });
    }
  });

  app.post("/api/deals/:dealId/buyers", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      // What the link opens (shared/access-levels.ts). Omitted = the Blind
      // CIM, which is what every link created before levels were picked here
      // opened (an old tab sends nothing).
      const accessLevel = req.body?.accessLevel === undefined ? BLIND_ACCESS_LEVEL : parseAccessLevelInput(req.body.accessLevel);
      if (!accessLevel) return res.status(400).json({ error: ACCESS_LEVEL_INPUT_ERROR });
      // A teaser link needs a published (online) teaser; it lasts as the
      // teaser's link-lifetime setting says (until it's taken offline, or 30 / 90 days).
      let teaserExpiry: Date | null | undefined;
      if (isTeaserOnly(accessLevel)) {
        const { getDealTeaser, teaserPublished } = await import("./teaser/store");
        const teaser = await getDealTeaser(req.params.dealId);
        if (!teaserPublished(teaser)) return res.status(409).json({ code: "teaser_not_published", error: "Publish the teaser first." });
        teaserExpiry = teaser!.linkLifetime === "until_offline" ? null : new Date(Date.now() + Number(teaser!.linkLifetime) * 86_400_000);
      } else if (!dealPublishedForBuyers(await storage.getDeal(req.params.dealId))) {
        // A link handed out before publishing would open a draft the seller
        // never approved (the publish step holds those gates).
        return res.status(409).json({ error: NOT_PUBLISHED_BROKER_MESSAGE, code: NOT_PUBLISHED_CODE });
      }
      const accessToken = crypto.randomUUID();
      const body = { ...req.body };
      if (body.expiresAt && typeof body.expiresAt === 'string') {
        body.expiresAt = new Date(body.expiresAt);
      }
      const buyerEmail = typeof body.buyerEmail === "string" ? body.buyerEmail.trim().toLowerCase() : "";
      if (!buyerEmail || !buyerEmail.includes("@")) {
        return res.status(400).json({ error: "A valid buyer email is required" });
      }
      const expiresAt = body.expiresAt instanceof Date && !isNaN(body.expiresAt.getTime())
        ? body.expiresAt
        : teaserExpiry !== undefined ? teaserExpiry : await brokerLinkExpiry(req.session.brokerId);
      // Link to the buyer's Cimple account when one exists for this email —
      // the same identity rule the approval flow uses. Without it the Buyers
      // page showed dealCount 0 / no activity for a buyer who had signed the
      // NDA and made a decision. Never creates an account or sends email.
      // Link only an account that has proven it owns the inbox — self-signup
      // is unverified, so an attacker registering the buyer's address must
      // never inherit a link the broker meant to hand over personally.
      const foundAccount = await storage.getBuyerUserByEmail(buyerEmail);
      const existingAccount = foundAccount?.emailVerified ? foundAccount : undefined;
      const validatedData = {
        dealId: req.params.dealId,
        buyerUserId: existingAccount?.id ?? null,
        accessToken,
        buyerEmail,
        buyerName: body.buyerName || existingAccount?.name || null,
        buyerCompany: body.buyerCompany || existingAccount?.company || null,
        accessLevel,
        // Security spec: links auto-expire after 30 days unless the broker
        // sets a different expiry (they can extend from the buyers panel).
        expiresAt,
        accessEvents: [{ type: "granted", at: new Date().toISOString(), accessLevel }] satisfies BuyerAccessEvent[],
      };
      const access = await storage.createBuyerAccess(validatedData);
      res.json(access);
    } catch (error: any) {
      if (error.name === "ZodError") {
        return res.status(400).json({ error: "Invalid buyer access data", details: error.errors });
      }
      console.error("Error creating buyer access:", error);
      res.status(500).json({ error: "Failed to create buyer access" });
    }
  });

  // Auto-generate blind overrides in the background the first time a
  // blind-mode link is opened before the broker ran "Generate blind CIM".
  // In-flight guard prevents a stampede of redaction runs per deal.
  // In-flight guard + codename reuse live in server/cim/blind-sync.ts.
  function ensureBlindOverridesInBackground(deal: { id: string }) {
    regenerateAllBlindInBackground(deal.id);
  }

  /** Blind view rooms use neutral section keys — map them back to the real ones. */
  async function translateBlindSectionKeys(dealId: string, events: Array<{ sectionKey?: string | null }>): Promise<void> {
    if (!events.some((e) => typeof e?.sectionKey === "string" && /^s_[0-9a-z]{12}$/.test(e.sectionKey))) return;
    // (While a regenerated CIM waits for review, buyers read the kept copy — its sections count too.)
    const { buyerSectionsForAnalytics } = await import("./cim/published-snapshot");
    const deal = await storage.getDeal(dealId);
    const map = realSectionKeyMap(deal ? await buyerSectionsForAnalytics(deal) : await storage.getCimSectionsByDeal(dealId));
    for (const e of events) {
      if (typeof e?.sectionKey === "string" && map.has(e.sectionKey)) e.sectionKey = map.get(e.sectionKey)!;
    }
  }

  app.get("/api/view/:token", async (req, res) => {
    try {
      const access = await storage.getBuyerAccessByToken(req.params.token);
      if (!access) {
        // Data room (vdr): a buyer's team member's link opens their data room, never the CIM.
        const { teamLinkRedirect } = await import("./vdr/team-link");
        const redirect = await teamLinkRedirect(req.params.token);
        if (redirect) return res.status(404).json({ code: "team_link", redirect });
        return res.status(404).json({ error: "Access denied or link expired" });
      }

      // Check expiration
      if (access.expiresAt && new Date(access.expiresAt) < new Date()) {
        // An expired (not revoked) teaser link: the buyer can ask for a fresh one.
        if (!access.revokedAt && isTeaserOnly(access.accessLevel)) {
          const { expiredTeaserBody } = await import("./teaser/serve");
          return res.status(403).json(await expiredTeaserBody(await storage.getDeal(access.dealId)));
        }
        return res.status(403).json({ error: "Link has expired" });
      }

      // Check if revoked
      if (access.revokedAt) {
        return res.status(403).json({ error: "Access has been revoked" });
      }

      // Get the associated deal
      const deal = await storage.getDeal(access.dealId);
      if (!deal) {
        return res.status(404).json({ error: "Deal not found" });
      }

      // A Teaser link reads the teaser only — never the CIM, whatever the
      // CIM's state (server/teaser/serve.ts: published and online, before
      // any CIM-published, NDA or view-stamp step; nothing CIM-derived).
      if (isTeaserOnly(access.accessLevel)) {
        const { serveTeaser } = await import("./teaser/serve");
        return serveTeaser(req, res, access, deal);
      }

      // Nothing reaches a buyer until the CIM is published (the publish step
      // holds the discrepancy + approval gates). Not a view either: no stamp,
      // so the decision reminders don't start on a CIM nobody could read.
      if (!dealPublishedForBuyers(deal)) {
        // Data room (vdr): a buyer in due diligence keeps the room when the CIM is taken offline.
        const { viewRoomDataRoom } = await import("./routes/data-room-buyer");
        const dataRoom = await viewRoomDataRoom(req.params.token);
        return res.status(403).json({ ...notPublishedBody(), ...(dataRoom?.available ? { dataRoom } : {}) });
      }

      // Stamp the view: firstViewedAt anchors the decision-reminder pipeline
      // and viewCount drives the decision panel. Only a fetch that actually
      // serves CIM content counts (viewStampFor) — the NDA gate and the
      // "preparing" state only move lastAccessedAt. Every return below goes
      // through stampAndBuild so the payload and the row agree.
      // Views (viewCount) are now counted by the reading tracker, one per
      // visit (server/analytics/reading-ingest.ts: a new visit with none on
      // this link in the last 30 min); the GET still stamps firstViewedAt,
      // which the reminders need even when a blocker stops the tracker.
      const now = new Date();
      const stampAndBuild = async (served: boolean) => {
        const viewStamp = viewRoomStamp(access, served, now);
        await storage.updateBuyerAccess(access.id, viewStamp as any);
        return { ...access, ...viewStamp };
      };
      // Buyers receive only what the view room needs — never the broker's
      // private notes, match scoring, or internal criteria.
      const accessPayload = (fullAccess: typeof access) => ({
        id: fullAccess.id,
        dealId: fullAccess.dealId,
        buyerEmail: fullAccess.buyerEmail,
        buyerName: fullAccess.buyerName,
        accessLevel: normalizeAccessLevel(fullAccess.accessLevel),
        ndaSigned: fullAccess.ndaSigned,
        ndaSignedAt: fullAccess.ndaSignedAt,
        canDownload: fullAccess.canDownload,
        watermarkEnabled: fullAccess.watermarkEnabled,
        firstViewedAt: fullAccess.firstViewedAt,
        viewCount: fullAccess.viewCount,
        decision: (fullAccess as any).decision ?? null,
        decisionAt: (fullAccess as any).decisionAt ?? null,
        expiresAt: fullAccess.expiresAt,
        // A copy of the signed NDA can be downloaded (signatures recorded since typed names).
        ndaCopyAvailable: !!fullAccess.ndaSigned && !!((fullAccess.ndaProfile as Record<string, unknown> | null)?.signature),
      });

      // Determine CIM mode from buyer's access level (shared/access-levels.ts:
      // Blind CIM → blind, Full CIM → normal, due diligence → dd).
      const cimMode = cimModeForAccessLevel(access.accessLevel);

      // In blind mode the buyer must never see the real business name — not
      // in the header, the NDA card, or section titles. Use the persisted
      // project codename (falls back to a neutral label if redaction hasn't
      // run yet, in which case we serve the "preparing" state below).
      const blindMode = cimMode === "blind";
      // While buyers read the kept copy of an update under review, the deal
      // keeps the codename that copy was redacted under.
      const { servedBlindCodename } = await import("./cim/published-snapshot");
      const keptCodename = await servedBlindCodename(deal);
      const servedDeal = keptCodename ? { ...deal, blindCodename: keptCodename } : deal;
      const codename = servedDeal.blindCodename || null;
      const displayName = blindMode ? (codename || "Confidential Opportunity") : deal.businessName;

      // Buyers get a minimal whitelisted deal payload — never the raw deal
      // record (extractedInfo, broker notes, valuation data). Legacy
      // cimContent (the pre-builder prose map) is added below only where the
      // page renders it: named CIM, NDA passed, and no CIM sections at all.
      // It holds every section's text — hidden ones included — so it never
      // ships alongside sections, and never before the NDA.
      const publicDeal: { id: string; businessName: string; industry: string; cimContent: unknown } = {
        id: deal.id,
        businessName: displayName,
        industry: deal.industry,
        cimContent: null,
      };

      // Branding is whitelisted (never the settings row). The design payload
      // carries the template, the brokerage brand (fine in Blind) and the
      // business's own branding — only in Normal/DD, and only past the NDA.
      const { designPayload } = await import("./cim/templates");
      const design = await designPayload(deal, cimMode);
      const gatedDesign = { ...design, template: { ...design.template, name: "" }, business: null };
      const branding = {
        companyName: design.brokerage.firmName,
        logoUrl: design.brokerage.logoUrl,
        disclaimer: design.brokerage.disclaimer,
      };

      // NDA gate — enforced server-side. Until the NDA is signed, no CIM
      // sections or Q&A leave the server (previously the full payload
      // shipped and the gate was a client-side render decision). The same
      // rule guards the chatbot, the Q&A feed and media (ndaBlocksBuyer).
      if (ndaBlocksBuyer(deal, access)) {
        return res.json({
          access: accessPayload(await stampAndBuild(false)),
          deal: publicDeal,
          sections: [],
          publishedQuestions: [],
          branding,
          design: gatedDesign,
          cimMode,
          ndaGate: true,
        });
      }

      // A regenerated CIM is held from every buyer until the broker reviews
      // and publishes it (server/cim/generation-jobs.ts). On a live deal the
      // buyers keep the version last published (buyerCimRows serves the kept
      // copy); on a deal that wasn't live nothing is served meanwhile.
      // A CIM held for the broker's review isn't viewed yet (not served):
      // the decision reminders, anchored to the first view, wait until it is
      // published.
      if (cimHeldFromBuyers(deal)) {
        return res.json({
          access: accessPayload(await stampAndBuild(false)),
          deal: publicDeal,
          sections: [],
          publishedQuestions: [],
          branding,
          design: gatedDesign,
          cimMode,
          updating: true,
        });
      }

      // Q&A feed: published answers plus this buyer's own pending questions
      // (whitelisted fields — never the seller-approval token or broker draft).
      const { buyerCimRows } = await import("./cim/published-snapshot");
      const [rows, publishedQuestions] = await Promise.all([
        buyerCimRows(deal, access.accessLevel),
        buildBuyerQuestionFeed(deal, { id: access.id, accessLevel: access.accessLevel }),
      ]);
      // Serving a kept copy that isn't there: nothing (fail closed) — the same
      // "being updated" state as a held CIM.
      if (rows.missing) {
        console.error(`[view] deal ${deal.id} serves the previously published CIM but no copy is on file — holding`);
        return res.json({
          access: accessPayload(await stampAndBuild(false)),
          deal: publicDeal,
          sections: [],
          publishedQuestions: [],
          branding,
          design: gatedDesign,
          cimMode,
          updating: true,
        });
      }
      const baseSections = rows.sections;
      if (cimMode === "normal" && baseSections.length === 0 && !rows.fromSnapshot) publicDeal.cimContent = deal.cimContent ?? null;

      // Which sections this buyer may receive, in which form — hidden
      // sections, per-section access tiers and blind freshness are all
      // enforced here (shared/cim-buyer-view.ts). Buyers get only what
      // the renderer needs: never aiLayoutReasoning (internal AI notes that
      // name the owners), seller edits, approval flags or AI task state.
      // Media blocks: only this deal's uploads, blind-safe ones in blind mode.
      const media = await loadMediaAssets(deal.id);
      const overrides = rows.overrides;
      // A live CIM's changes wait for the broker's approval: the approved
      // versions are served meanwhile (shared/cim-published.ts; rows.published
      // — [] after a failed read, so nothing unapproved is served). The kept
      // copy of an update under review is already what buyers were served
      // (published: null).
      // The extra layers (gl's add-back evidence; dd's figure notes / checks)
      // come only through buyerCimExtras — the same helper servedCimFor uses.
      const extras = await buyerCimExtras(servedDeal, access.accessLevel, access.id);
      const buyerCim = buildBuyerCim({ deal: servedDeal, accessLevel: access.accessLevel, sections: baseSections, overrides, media, askingPrice: listedAskingPrice(deal), published: rows.published, ...extras });
      // A Blind CIM figure layer that still named something is dropped (fail
      // closed) — logged for the broker, never treated as a leaked section
      // (that would schedule a paid re-redaction on every view).
      if (buyerCim.figureLayerDropped) console.warn(`[view] figure notes withheld on deal ${deal.id}: ${buyerCim.figureLayerDropped}`);
      if (buyerCim.preparing) {
        // No redacted version exists yet. Do NOT serve the real, un-redacted
        // sections — that would leak identity to the first viewer. Serve a
        // "preparing" holding state and generate; the client polls back.
        // (A kept copy is never re-redacted: the draft is not what buyers see.)
        if (!rows.fromSnapshot) ensureBlindOverridesInBackground(deal);
        return res.json({
          access: accessPayload(await stampAndBuild(false)),
          deal: publicDeal,
          sections: [],
          publishedQuestions: [],
          branding,
          design: gatedDesign,
          cimMode,
          preparing: true,
        });
      }
      // Sections whose blind version is behind their content (just added or
      // edited) are held back until re-redacted — make sure that is running.
      // A blind section that still names something identifying is withheld
      // too, and its redaction is redone.
      if (rows.fromSnapshot) {
        // The kept copy is served as it was: a section held back stays back.
        if (buyerCim.leaked.length > 0) console.warn(`[view] withheld ${buyerCim.leaked.length} blind section(s) of the kept CIM on deal ${deal.id} that still named identifying details`);
      } else if (buyerCim.leaked.length > 0) {
        console.warn(`[view] withheld ${buyerCim.leaked.length} blind section(s) on deal ${deal.id} that still named identifying details — re-redacting`);
        redoLeakedBlind(deal.id, buyerCim.leaked, buyerCim.leakReasons).catch((err) => console.error("[view] blind redo failed:", err));
      } else if (buyerCim.heldBack > 0) scheduleBlindRefresh(deal.id, 0);
      // Every section held back (blind versions still being refreshed) is
      // the same as "preparing" for the buyer: nothing to read yet.
      const served = buyerCim.sections.length > 0 || publicDeal.cimContent != null;
      // Reading analytics: record exactly what this buyer is served (the heat
      // map is drawn on it) and hand the tracker its opaque id + page order.
      // Not for the owning broker previewing the room (their reading isn't a buyer's).
      const ownerPreview = !!req.session?.brokerId && req.session.brokerId === deal.brokerId;
      const reading = buyerCim.sections.length > 0 && !ownerPreview
        ? await recordRendition({
            dealId: deal.id, mode: cimMode, variant: renditionKindFor(access.accessLevel).variant,
            cimLayoutVersion: deal.cimLayoutVersion ?? null, sections: buyerCim.sections, design, live: baseSections,
          })
        : null;
      // Data room (vdr): the header's "Memorandum | Data room" switch and the downloads line.
      const { viewRoomDataRoom } = await import("./routes/data-room-buyer");
      const dataRoom = await viewRoomDataRoom(req.params.token);
      res.json({
        access: accessPayload(await stampAndBuild(served)),
        deal: publicDeal,
        sections: buyerCim.sections,
        pendingSections: buyerCim.heldBack,
        publishedQuestions,
        branding,
        design,
        cimMode,
        ...(reading ? { reading } : {}),
        ...(dataRoom ? { dataRoom } : {}),
        figureLayer: buyerCim.figureLayer,
      });
    } catch (error: any) {
      console.error("Error fetching buyer access:", error);
      res.status(500).json({ error: "Failed to verify access" });
    }
  });

  // Buyer signs NDA
  // The buyer profile step of the NDA: what's already on file for this buyer
  // (their own profile only — never the broker's private CRM notes).
  app.get("/api/view/:token/buyer-profile", async (req, res) => {
    try {
      const access = await storage.getBuyerAccessByToken(req.params.token);
      const problem = viewLinkProblem(access);
      if (problem || !access) { const e = viewLinkError(problem ?? "not_found"); return res.status(e.status).json({ error: e.error }); }
      if (!(await linkReadable(access))) return res.status(403).json(isTeaserOnly(access.accessLevel) ? { code: "not_published", error: "This summary isn't available right now." } : notPublishedBody());
      const ndaDeal = await storage.getDeal(access.dealId);
      if (!ndaDeal) return res.status(404).json({ error: "Deal not found" });
      // A teaser link is mailed in bulk and still opens when forwarded: the
      // recipient's details (email, phone, budget, proof of funds) are only
      // shown once the link's own address is confirmed (the 6-digit code).
      if (isTeaserOnly(access.accessLevel)) {
        const { emailCheckState } = await import("./teaser/email-check");
        const state = await emailCheckState(access, ndaDeal, req.session?.buyerId ?? null);
        if (!state.verified) return res.status(400).json({ error: "Confirm your email first.", code: "email_check_required", maskedEmail: state.maskedEmail });
      }
      const buyer = await ndaProfileAccount(access);
      const c = (buyer?.buyerCriteria as Record<string, any>) || {};
      // The brokerage's own NDA, exactly as this buyer will sign it.
      const nda = await buyerNdaFor(ndaDeal, access);
      res.json({
        email: access.buyerEmail,
        nda: { text: nda.text, hash: nda.hash },
        complete: !!buyer && hasMatchableProfile(buyer),
        onFile: buyer ? {
          name: buyer.name || access.buyerName || "",
          phone: buyer.phone || "",
          company: buyer.company || access.buyerCompany || "",
          title: buyer.title || "",
          buyerType: buyer.buyerType || null,
          background: buyer.background || "",
          lookingFor: c.lookingFor || "",
          targetIndustries: buyer.targetIndustries || [],
          targetLocations: buyer.targetLocations || [],
          priceMin: c.askingPriceMin ? Number(c.askingPriceMin) : null,
          priceMax: c.askingPriceMax ? Number(c.askingPriceMax) : null,
          hasProofOfFunds: !!buyer.hasProofOfFunds,
        } : { name: access.buyerName || "", company: access.buyerCompany || "" },
      });
    } catch (err) {
      console.error("[nda-profile] read failed:", err);
      res.status(500).json({ error: "Couldn't load your profile" });
    }
  });

  app.post("/api/view/:token/sign-nda", async (req, res) => {
    try {
      const access = await storage.getBuyerAccessByToken(req.params.token);
      const problem = viewLinkProblem(access);
      if (problem || !access) { const e = viewLinkError(problem ?? "not_found"); return res.status(e.status).json({ error: e.error }); }
      if (!(await linkReadable(access))) return res.status(403).json(isTeaserOnly(access.accessLevel) ? { code: "not_published", error: "This summary isn't available right now." } : notPublishedBody());
      // Signing from a teaser link asks for the CIM: only the address the
      // broker sent the link to can do that (a 6-digit code, server/teaser/email-check.ts).
      let teaserEmailCheck: "code" | "account" | "demo" | null = null;
      if (isTeaserOnly(access.accessLevel)) {
        const { requireEmailCheck } = await import("./teaser/email-check");
        const checkDeal = await storage.getDeal(access.dealId);
        const check = checkDeal ? await requireEmailCheck(access, checkDeal, req.session?.buyerId ?? null) : { ok: false as const };
        if (!check.ok) return res.status(400).json({ error: "Confirm your email first.", code: "email_check_required" });
        teaserEmailCheck = check.method;
      }
      // A signature is a record: who agreed to which terms, when, from where.
      // Signing again used to overwrite it (and re-ran the AI criteria read).
      if (access.ndaSigned) {
        return res.status(409).json({ error: "You've already signed the NDA for this business.", code: "nda_already_signed", alreadySigned: true });
      }

      // Signing the NDA and giving us your buyer profile are one step: either
      // a new/updated profile, or a confirmation of the one already on file.
      let profile = null;
      if (req.body?.profile) {
        const parsed = ndaBuyerProfileSchema.safeParse(req.body.profile);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          return res.status(400).json({ error: issue?.message || "Please complete the form", field: issue?.path?.[0] ?? null });
        }
        profile = parsed.data;
      } else {
        const buyer = await ndaProfileAccount(access);
        if (!req.body?.confirmProfile || !buyer || !hasMatchableProfile(buyer)) {
          return res.status(400).json({ error: "Please tell us a little about yourself first", code: "profile_required" });
        }
      }
      // The signature: a typed full name against the exact terms shown.
      const signerName = validSignerName(req.body?.signerName);
      if (!signerName) {
        return res.status(400).json({ error: "Type your full name to sign the NDA", field: "signerName", code: "signer_name_required" });
      }
      const ndaDeal = await storage.getDeal(access.dealId);
      if (!ndaDeal) return res.status(404).json({ error: "Deal not found" });
      const nda = await buyerNdaFor(ndaDeal, access);
      if (req.body?.termsHash !== nda.hash) {
        // Changed since the page loaded (or an old page): show the current terms first.
        return res.status(409).json({ error: "The NDA terms have been updated. Please read the current version and sign again.", code: "nda_terms_changed" });
      }

      const { applyNdaProfile, ndaAccessFields } = await import("./buyers/nda-profile.js");

      const signedAt = new Date();
      const ip = req.ip || req.socket.remoteAddress || null;
      const signature: BuyerNdaSignature = {
        signerName,
        signedAt: signedAt.toISOString(),
        ip,
        termsHash: nda.hash,
        termsText: nda.text,
        termsSource: nda.source,
      };
      // On a deal that requires the NDA nothing was served before this
      // signature, so a view stamp already on the row came from the gate
      // (rows stamped before the gate stopped counting): clear it, and the
      // first real view that follows starts the reminder clock afresh.
      const gateStamped = !!ndaDeal.ndaRequired && !access.ndaSigned && !!access.firstViewedAt;
      // The claim comes first and carries the answers with the signature:
      // a concurrent second signing (both passed the ndaSigned check above)
      // loses here and writes nothing — not to this row, not to the buyer's
      // account — so it can't replace the signature record.
      const accessFields = ndaAccessFields(access, profile, signature as unknown as Record<string, unknown>);
      // A teaser link stays under the name and company the broker sent it to
      // (a colleague may sign): the signer lives in nda_profile and on the request.
      if (teaserEmailCheck) {
        delete accessFields.buyerName;
        delete accessFields.buyerCompany;
      }
      const recorded = await storage.recordBuyerNdaSignature(access.id, {
        ndaSigned: true,
        ndaSignedAt: signedAt,
        ndaSignedIp: ip,
        ndaVersion: nda.hash,
        ...accessFields,
        ...(gateStamped ? { firstViewedAt: null, viewCount: 0, reminderStage: "none", lastReminderAt: null } : {}),
      } as any);
      // A concurrent signing got there first: that signature stands.
      if (!recorded) {
        return res.status(409).json({ error: "You've already signed the NDA for this business.", code: "nda_already_signed", alreadySigned: true });
      }
      // The signature is on record; the buyer's account and the broker's
      // buyer list follow. A failure there doesn't undo the signing.
      try {
        await applyNdaProfile(recorded, profile);
      } catch (err) {
        console.error("[nda-profile] applying the signed NDA's profile failed:", err);
      }
      storage.createAnalyticsEvent({
        dealId: access.dealId, buyerAccessId: access.id, eventType: "nda_signed", sectionKey: null,
      } as any).catch(() => {});

      // From a teaser link: the signature IS the request for the CIM. A
      // failure here is logged and the client retries with /cim-request.
      if (teaserEmailCheck) {
        try {
          const { ensureTeaserRequest } = await import("./teaser/requests");
          const { getDealTeaser } = await import("./teaser/store");
          const teaserRow = await getDealTeaser(ndaDeal.id);
          const baseUrl = process.env.APP_URL || `${req.protocol}://${req.get("host")}`;
          const result = await ensureTeaserRequest(recorded, ndaDeal, { profile, signerName, emailCheck: teaserEmailCheck, linkName: access.buyerName ?? null }, {
            autoGrantLevel: teaserRow?.autoGrant ?? "off",
            autoGrant: async (request, level) => {
              await grantApprovedBuyer(request, ndaDeal, baseUrl, {}, { grantedBy: "auto", notifyBuyer: false, level });
            },
          });
          return res.json({ success: true, request: { state: result.state }, autoGranted: result.autoGranted });
        } catch (err) {
          console.error("[teaser] request after the NDA failed:", err);
          return res.json({ success: true, request: { state: "none" }, retry: true });
        }
      }

      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: "Failed to sign NDA" });
    }
  });

  // The buyer's own copy of the NDA they signed (typed name, date, the exact
  // terms). Only for a live link that has signed.
  app.get("/api/view/:token/nda.txt", async (req, res) => {
    try {
      const access = await storage.getBuyerAccessByToken(req.params.token);
      const problem = viewLinkProblem(access);
      if (problem || !access) { const e = viewLinkError(problem ?? "not_found"); return res.status(e.status).json({ error: e.error }); }
      const sig = ((access.ndaProfile as Record<string, unknown> | null)?.signature ?? null) as BuyerNdaSignature | null;
      if (!access.ndaSigned || !sig?.termsText) return res.status(404).json({ error: "No signed NDA on file for this link" });
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="signed-nda.txt"');
      res.setHeader("Cache-Control", "no-store");
      res.send(signedNdaCopy(sig, access.buyerEmail));
    } catch (err) {
      console.error("[nda] copy failed:", err);
      res.status(500).json({ error: "Couldn't prepare your copy" });
    }
  });

  app.patch("/api/buyers/:id", requireBroker, async (req, res) => {
    try {
      const existingAccess = await storage.getBuyerAccess(req.params.id);
      if (!existingAccess || !(await ownsDeal(req, existingAccess.dealId))) return res.status(404).json({ error: "Buyer access not found" });
      // Only what a broker may change on a link. Everything else on the row —
      // buyerUserId (the account link, which also decides "on your buyer
      // list"), NDA, decision, reminder and view state — is written only by
      // the server flows that earn it (grant, approval, NDA signing, view room).
      const parsed = z.object({
        accessLevel: z.string().optional(),
        expiresAt: z.union([z.string(), z.null()]).optional(),
        buyerName: z.string().trim().max(200).nullable().optional(),
        buyerCompany: z.string().trim().max(200).nullable().optional(),
      }).strip().safeParse(req.body ?? {});
      if (!parsed.success) return res.status(400).json({ error: "Invalid update" });
      const accessUpdates: Record<string, any> = {};
      for (const [k, v] of Object.entries(parsed.data)) if (v !== undefined) accessUpdates[k] = v;
      if (Object.keys(accessUpdates).length === 0) {
        // Nothing a broker may change was sent. An empty body is a no-op;
        // a body carrying only server-owned fields (buyerUserId, NDA, decision…)
        // is refused so the caller knows it was not applied.
        const sent = Object.keys(req.body && typeof req.body === "object" ? req.body : {});
        if (sent.length > 0) {
          return res.status(400).json({ error: "Only the access level, expiry date, buyer name and company can be changed here" });
        }
        return res.json(existingAccess);
      }
      if (typeof accessUpdates.expiresAt === "string") {
        accessUpdates.expiresAt = new Date(accessUpdates.expiresAt);
        if (isNaN(accessUpdates.expiresAt.getTime())) return res.status(400).json({ error: "Invalid expiry date" });
      }
      // Access level decides what the buyer reads (shared/access-levels.ts):
      // a new key or a legacy value from a stale tab ("full" = the Blind CIM)
      // is accepted and stored normalised; anything else is refused.
      if (accessUpdates.accessLevel !== undefined) {
        const level = parseAccessLevelInput(accessUpdates.accessLevel);
        if (!level) return res.status(400).json({ error: ACCESS_LEVEL_INPUT_ERROR });
        // Back to the teaser only when a teaser is there to read — refused on
        // the server, not just greyed out in the UI.
        if (isTeaserOnly(level) && !isTeaserOnly(existingAccess.accessLevel)) {
          const { getDealTeaser, teaserPublished } = await import("./teaser/store");
          if (!teaserPublished(await getDealTeaser(existingAccess.dealId))) {
            return res.status(409).json({ code: "teaser_not_published", error: "Publish the teaser first." });
          }
        }
        accessUpdates.accessLevel = level;
      }
      // A teaser link given the CIM: the link now follows the CIM's rule
      // (30 days from today, or later if it already lasts longer), unless the
      // broker set the expiry in this same change.
      const upgradedFromTeaser = typeof accessUpdates.accessLevel === "string" && isTeaserOnly(existingAccess.accessLevel) && !isTeaserOnly(accessUpdates.accessLevel);
      if (upgradedFromTeaser && accessUpdates.expiresAt === undefined) {
        const cimExpiry = await brokerLinkExpiry(req.session.brokerId);
        const current = existingAccess.expiresAt ? new Date(existingAccess.expiresAt) : null;
        if (!current || current.getTime() < cimExpiry.getTime()) accessUpdates.expiresAt = cimExpiry;
      }
      // Keep a short history of broker actions on the link (buyer profile timeline).
      const history = [...(((existingAccess as any).accessEvents as BuyerAccessEvent[] | null) ?? [])];
      const nowIso = new Date().toISOString();
      if (accessUpdates.expiresAt instanceof Date && !isNaN(accessUpdates.expiresAt.getTime())
        && (!existingAccess.expiresAt || accessUpdates.expiresAt.getTime() > new Date(existingAccess.expiresAt).getTime())) {
        history.push({ type: "extended", at: nowIso, expiresAt: accessUpdates.expiresAt.toISOString(), ...(upgradedFromTeaser ? { by: "upgrade" } : {}) });
      }
      if (typeof accessUpdates.accessLevel === "string" && !sameAccessLevel(accessUpdates.accessLevel, existingAccess.accessLevel)) {
        history.push({ type: "level_changed", at: nowIso, accessLevel: accessUpdates.accessLevel });
      }
      if (history.length !== (((existingAccess as any).accessEvents as unknown[] | null) ?? []).length) accessUpdates.accessEvents = history.slice(-50);
      const access = await storage.updateBuyerAccess(req.params.id, accessUpdates);
      if (!access) {
        return res.status(404).json({ error: "Buyer access not found" });
      }
      // The buyer's open "Ask for the CIM" request is answered by this change.
      if (upgradedFromTeaser) {
        const { closeRequestOnLevelChange } = await import("./teaser/requests");
        await closeRequestOnLevelChange(access, accessUpdates.accessLevel).catch((err) => console.warn("[teaser] closing the request failed:", err));
      }
      res.json(access);
    } catch (error: any) {
      console.error("Error updating buyer access:", error);
      res.status(500).json({ error: "Failed to update buyer access" });
    }
  });

  // =====================
  // Buyer decision — "Interested / Not interested / Under review"
  // =====================
  // Called from the Buyer View Room. Records the decision, notifies the
  // broker via email/SMS, and (when a CRM is connected) automatically
  // updates the deal's pipeline stage in Pipedrive / HubSpot / Salesforce.
  app.post("/api/view/:token/decision", async (req, res) => {
    try {
      const access = await storage.getBuyerAccessByToken(req.params.token);
      const problem = viewLinkProblem(access);
      if (problem || !access) { const e = viewLinkError(problem ?? "not_found"); return res.status(e.status).json({ error: e.error }); }
      // A Teaser reader hasn't seen the CIM, so there is no CIM decision to
      // record ("Not for me" on the teaser is its own, separate record).
      if (isTeaserOnly(access.accessLevel)) return res.status(409).json({ code: "teaser_only", error: "Ask for the CIM first." });

      const decisionSchema = z.object({
        decision: z.enum(["interested", "not_interested", "need_more_time"]),
        nextStep: z.enum(["seller_call", "management_meeting", "site_visit", "loi", "more_info", "other"]).optional().nullable(),
        reason: z.string().max(2000).optional().nullable(),
      });
      const { decision, nextStep, reason } = decisionSchema.parse(req.body);

      const deal = await storage.getDeal(access.dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });
      if (!dealPublishedForBuyers(deal)) return res.status(403).json(notPublishedBody());
      // A buyer who hasn't signed a required NDA has never seen the CIM: a
      // decision from them would move the broker's CRM and tell the broker
      // they "finished reviewing" it. The view room shows no decision panel
      // before the NDA; the API refuses too.
      if (ndaBlocksBuyer(deal, access)) {
        return res.status(403).json({ error: "Please sign the NDA before sharing your decision.", code: "nda_required" });
      }

      // Every decision (including "need more time") lands in the analytics
      // stream so it shows up in the broker's activity timeline.
      const recordDecisionEvent = (d: string) =>
        storage.createAnalyticsEvent({
          dealId: deal.id,
          buyerAccessId: access.id,
          eventType: "decision",
          sectionKey: null,
          eventData: { decision: d, nextStep: nextStep || null },
        } as any).catch(() => {});

      // "Need more time" isn't a terminal decision — it resets the reminder
      // clock (fresh day-3/6/8 cycle) and leaves the buyer under review.
      if (decision === "need_more_time") {
        // Only while still deciding: it never reverts a final decision
        // (an "interested" already synced to the CRM, or a lapse).
        if (!canSnoozeDecision(access.decision)) {
          return res.status(409).json({
            error: "Your decision is already recorded. To change it, contact the broker.",
            decision: access.decision,
          });
        }
        await storage.updateBuyerAccess(access.id, {
          // Still deciding: back under review, so the reminder pipeline
          // picks it up again (a NULL decision was never selected).
          decision: "under_review",
          decisionAt: null,
          firstViewedAt: new Date(),
          reminderStage: "none",
          lastReminderAt: null,
        } as any);
        await recordDecisionEvent("need_more_time");
        return res.json({ success: true, decision: "need_more_time" });
      }

      // Record the decision
      await storage.updateBuyerAccess(access.id, {
        decision,
        decisionNextStep: nextStep || null,
        decisionReason: reason || null,
        decisionAt: new Date(),
        crmSyncStatus: "pending",
      } as any);
      await recordDecisionEvent(decision);

      // Try CRM sync (gracefully handles not_configured)
      let syncResult = await syncDealToCrm(deal, decision);

      await storage.updateBuyerAccess(access.id, {
        crmSyncStatus: syncResult.status,
        crmSyncError: syncResult.status === "failed" ? syncResult.error : null,
        crmSyncedAt: syncResult.status === "synced" ? new Date() : null,
      } as any);

      // Build broker-facing notification
      const buyerLabel = access.buyerName
        ? `${access.buyerName}${access.buyerCompany ? ` (${access.buyerCompany})` : ""}`
        : access.buyerEmail;

      const decisionTitle = decision === "interested"
        ? `${buyerLabel} is interested in moving forward`
        : `${buyerLabel} has declined to move forward`;

      const nextStepLabel = nextStep
        ? (BUYER_NEXT_STEPS.find(s => s.value === nextStep)?.label || nextStep)
        : null;

      const crmProvider = await getConnectedCrmProvider(deal.brokerId);
      const crmMessage = syncResult.status === "synced"
        ? describeCrmAction(syncResult.provider, decision)
        : syncResult.status === "failed"
        ? `CRM auto-update failed (${crmProviderLabel(syncResult.provider)}): ${syncResult.error}. Please update your pipeline manually.`
        : syncResult.reason
        ? syncResult.reason
        : crmProvider
        ? `${crmProviderLabel(crmProvider)} is connected, but nothing was changed in it for this decision.`
        : "No CRM is connected — connect Pipedrive, HubSpot or Salesforce in Settings to enable automatic pipeline updates.";

      // Compose email body
      const bodyParts: string[] = [];
      // Every value below that the buyer (or a CRM) typed is escaped — a
      // buyer's "name" must never become a live link in the broker's inbox.
      bodyParts.push(
        `<strong>${escapeHtml(buyerLabel)}</strong> has finished reviewing the ${escapeHtml(deal.businessName)} CIM and has shared their decision.`,
      );
      if (decision === "interested") {
        bodyParts.push(
          `<br/><br/><strong>Decision:</strong> Interested in moving forward.`,
        );
        if (nextStepLabel) {
          bodyParts.push(`<br/><strong>Requested next step:</strong> ${escapeHtml(nextStepLabel)}`);
        }
      } else {
        bodyParts.push(
          `<br/><br/><strong>Decision:</strong> Not interested in moving forward.`,
        );
      }
      if (reason) {
        bodyParts.push(`<br/><br/><em>Buyer comment:</em> &ldquo;${escapeHtml(reason)}&rdquo;`);
      }
      bodyParts.push(`<br/><br/><strong>CRM update:</strong> ${escapeHtml(crmMessage)}`);

      const eventType = decision === "interested"
        ? "buyer_decision_interested"
        : "buyer_decision_not_interested";

      await notify(deal.id, eventType, {
        title: decisionTitle,
        body: bodyParts.join(""),
        actionUrl: `/deal/${deal.id}`,
        businessName: deal.businessName,
        metadata: {
          buyerAccessId: access.id,
          decision,
          nextStep,
          crmSyncStatus: syncResult.status,
          crmProvider: syncResult.status !== "not_configured" ? (syncResult as any).provider : null,
        },
      });

      res.json({
        success: true,
        decision,
        nextStep,
        crmSync: syncResult,
        crmMessage,
      });
    } catch (error: any) {
      console.error("Error recording buyer decision:", error);
      res.status(400).json({ error: error.message || "Failed to record decision" });
    }
  });

  // Admin endpoint — manually run the reminder pipeline. Also safe to hit
  // from an external cron (Railway scheduled jobs) once per day.
  // Protect with REMINDER_CRON_SECRET env var if set.
  app.post("/api/admin/run-decision-reminders", async (req, res) => {
    try {
      const secret = process.env.REMINDER_CRON_SECRET;
      if (secret) {
        const provided = req.headers["x-cron-secret"] || req.query.secret;
        if (provided !== secret) return res.status(401).json({ error: "Unauthorized" });
      } else if (!req.session.brokerId) {
        // No cron secret configured: only a logged-in broker may trigger it
        return res.status(401).json({ error: "Unauthorized" });
      }
      const stats = await runDecisionReminders();
      res.json({ success: true, stats });
    } catch (error: any) {
      console.error("Error running reminder pipeline:", error);
      res.status(500).json({ error: error.message || "Failed to run reminders" });
    }
  });

  // =====================================================================
  // BUYER APPROVAL WORKFLOW
  // =====================================================================
  // Any broker with deal access can submit a prospective buyer profile.
  // Flow: submit → lead broker review → seller review (tokenized) →
  //       buyerAccess auto-created + invite emailed (CC both brokers).
  // CRM search/prefill feeds into the submit dialog UI.

  // Category list (for UI dropdowns)
  app.get("/api/buyer-categories", async (_req, res) => {
    res.json(BUYER_CATEGORIES);
  });

  // CRM autocomplete search — returns multiple lightweight results
  app.get("/api/deals/:dealId/buyer-search", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const deal = await storage.getDeal(req.params.dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });
      const q = String(req.query.q || "");
      const results = await searchBuyersInCrm(deal.brokerId, q);
      res.json({ results });
    } catch (error: any) {
      console.error("Error searching CRM buyers:", error);
      res.status(500).json({ error: "Failed to search CRM" });
    }
  });

  // CRM deep prefill — single record, full Claude-parsed profile + files
  app.post("/api/deals/:dealId/buyer-prefill", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const deal = await storage.getDeal(req.params.dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });
      const query = String(req.body?.query || req.body?.recordId || "");
      if (!query) return res.status(400).json({ error: "query or recordId required" });
      const recordId = req.body?.recordId != null ? String(req.body.recordId) : null;
      const result = await prefillBuyerFromCrm(deal.brokerId, query, recordId);
      res.json(result);
    } catch (error: any) {
      console.error("Error prefilling buyer:", error);
      res.status(500).json({ error: "Failed to prefill buyer" });
    }
  });

  // List approval requests for a deal
  app.get("/api/deals/:dealId/buyer-approvals", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const requests = await storage.getBuyerApprovalRequestsByDeal(req.params.dealId);
      res.json(requests);
    } catch (error: any) {
      console.error("Error listing buyer approvals:", error);
      res.status(500).json({ error: "Failed to list buyer approvals" });
    }
  });

  // Get one approval request
  app.get("/api/buyer-approvals/:id", requireBroker, async (req, res) => {
    try {
      const request = await storage.getBuyerApprovalRequest(req.params.id);
      if (!request || !(await ownsDeal(req, request.dealId))) return res.status(404).json({ error: "Not found" });
      res.json(request);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to fetch buyer approval" });
    }
  });

  // Submit a new buyer approval request
  app.post("/api/deals/:dealId/buyer-approvals", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const deal = await storage.getDeal(req.params.dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });

      const body = req.body || {};
      const category = body.category || "other";
      const isCompetitor = body.isCompetitor ?? (category === "direct_competitor" || category === "indirect_competitor");
      // Risk is the highest of: the category's baseline (or an explicit
      // override), competitor flag → high, no proof of funds → medium. It
      // used to derive from category alone, so a competitor-flagged family
      // office still showed "low".
      const RISK_RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };
      const requested = typeof body.riskLevel === "string" && body.riskLevel in RISK_RANK ? body.riskLevel : null;
      const hasProofOfFunds = !!(body.financialCapability && body.financialCapability.hasProofOfFunds);
      const riskLevel = ([
        requested || riskLevelForCategory(category),
        isCompetitor ? "high" : "low",
        hasProofOfFunds ? "low" : "medium",
      ] as Array<"high" | "medium" | "low">).reduce((a, b) => (RISK_RANK[b] > RISK_RANK[a] ? b : a));
      const sellerReviewToken = crypto.randomUUID();

      const validated = insertBuyerApprovalRequestSchema.parse({
        dealId: req.params.dealId,
        submittedBy: body.submittedBy || "manual",
        submittedByName: body.submittedByName || null,
        submittedByRole: body.submittedByRole || null,
        buyerName: body.buyerName,
        buyerTitle: body.buyerTitle || null,
        buyerEmail: body.buyerEmail,
        buyerPhone: body.buyerPhone || null,
        buyerCompany: body.buyerCompany || null,
        buyerCompanyUrl: body.buyerCompanyUrl || null,
        linkedinUrl: body.linkedinUrl || null,
        otherProfileUrls: body.otherProfileUrls || [],
        category,
        riskLevel,
        background: body.background || null,
        financialCapability: body.financialCapability || null,
        partners: body.partners || [],
        isCompetitor,
        competitorDetails: body.competitorDetails || null,
        ndaSigned: !!body.ndaSigned,
        ndaDocumentId: body.ndaDocumentId || null,
        ndaNotes: body.ndaNotes || null,
        crmSource: body.crmSource || null,
        crmRecordId: body.crmRecordId || null,
        crmRawData: body.crmRawData || null,
        status: "pending_broker_review",
        sellerReviewToken,
      });

      const request = await storage.createBuyerApprovalRequest(validated);

      // Notify lead broker
      const categoryLabel = BUYER_CATEGORIES.find(c => c.value === category)?.label || category;
      await notify(deal.id, "buyer_approval_requested", {
        title: `Buyer approval requested — ${categoryLabel}`,
        body:
          `<strong>${escapeHtml(request.buyerName)}</strong>` +
          (request.buyerCompany ? ` of <strong>${escapeHtml(request.buyerCompany)}</strong>` : "") +
          ` has been submitted for approval on the ${escapeHtml(deal.businessName)} deal.` +
          `<br/><br/><strong>Category:</strong> ${escapeHtml(categoryLabel)}` +
          `<br/><strong>Risk level:</strong> ${escapeHtml(riskLevel)}` +
          (request.submittedByName ? `<br/><strong>Submitted by:</strong> ${escapeHtml(request.submittedByName)}` : "") +
          (request.background ? `<br/><br/>${escapeHtml(request.background)}` : ""),
        actionUrl: `/deal/${deal.id}?approval=${request.id}`,
        businessName: deal.businessName,
        metadata: { approvalRequestId: request.id, category, riskLevel },
        // The broker who submitted it isn't emailed about their own request.
        actorUserId: req.session.brokerId ?? null,
      });

      res.json(request);
    } catch (error: any) {
      if (error.name === "ZodError") {
        return res.status(400).json({ error: "Invalid approval request", details: error.errors });
      }
      console.error("Error creating buyer approval:", error);
      res.status(500).json({ error: "Failed to create buyer approval" });
    }
  });

  // Lead broker review — approve or reject
  app.post("/api/buyer-approvals/:id/broker-review", requireBroker, async (req, res) => {
    try {
      const request = await storage.getBuyerApprovalRequest(req.params.id);
      if (!request || !(await ownsDeal(req, request.dealId))) return res.status(404).json({ error: "Not found" });

      const { action, reviewerName, reviewerId, notes } = req.body || {};
      if (!["approve", "reject", "grant"].includes(action)) {
        return res.status(400).json({ error: "action must be approve, reject or grant" });
      }
      const fromTeaser = (request as { source?: string | null }).source === "teaser_request";

      const deal = await storage.getDeal(request.dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });

      // What the buyer gets (Blind CIM / Full CIM / Due diligence — never the
      // teaser). Default: the deal's automatic level when set, else the Blind CIM.
      let grantLevel: string = BLIND_ACCESS_LEVEL;
      if (req.body?.grantLevel !== undefined && req.body?.grantLevel !== null) {
        const parsedLevel = parseAccessLevelInput(req.body.grantLevel);
        if (!parsedLevel || isTeaserOnly(parsedLevel)) return res.status(400).json({ error: "Choose Blind CIM, Full CIM or Due diligence." });
        grantLevel = parsedLevel;
      } else {
        const { getDealTeaser } = await import("./teaser/store");
        const t = await getDealTeaser(deal.id).catch(() => null);
        const { autoGrantLevel } = await import("@shared/teaser");
        const auto = autoGrantLevel(t?.autoGrant);
        if (auto) grantLevel = auto;
      }
      const notifyBuyer = typeof req.body?.notifyBuyer === "boolean" ? req.body.notifyBuyer : (action === "reject" ? fromTeaser : true);

      if (action === "grant") {
        if (request.status === "access_granted" || request.status === "rejected") {
          return res.status(409).json({ error: "This request has already been answered." });
        }
        const review = { brokerReviewedBy: reviewerId || null, brokerReviewedAt: new Date(), brokerReviewNotes: notes || null };
        if (dealPublishedForBuyers(deal)) {
          const baseUrl = process.env.APP_URL || `${req.protocol}://${req.get("host")}`;
          const granted = await grantApprovedBuyer(request, deal, baseUrl, review, { grantedBy: "broker", notifyBuyer, level: grantLevel });
          return res.json(granted.request);
        }
        // Not live yet: approved by the broker, given at publish.
        const updated = await storage.updateBuyerApprovalRequest(request.id, {
          status: "approved_waiting_publish",
          ...review,
          grantAccessLevel: grantLevel,
          grantedBy: "broker",
        } as any);
        return res.json(updated);
      }

      if (action === "reject") {
        const updated = await storage.updateBuyerApprovalRequest(request.id, {
          status: "rejected",
          brokerReviewedBy: reviewerId || null,
          brokerReviewedAt: new Date(),
          brokerReviewNotes: notes || null,
          rejectionReason: notes || "Rejected by broker",
        } as any);
        // A short, polite email to the buyer (no reason given) — the broker's choice.
        if (notifyBuyer) {
          const { buildTeaserDeclinedEmail } = await import("./buyers/approval-emails");
          const { brokerageBrand } = await import("./cim/templates");
          const firm = (await brokerageBrand(deal.brokerId).catch(() => null))?.firmName ?? null;
          const label = buyerFacingDealName(deal, { accessLevel: BLIND_ACCESS_LEVEL });
          const email = buildTeaserDeclinedEmail({ buyerName: request.buyerName, firm, dealLabel: label });
          if (!deal.demoKey) await sendDirectEmail(request.buyerEmail, email.subject, email.html).catch(() => false);
        }

        await notify(deal.id, "buyer_approval_rejected", {
          title: `Buyer approval rejected — ${request.buyerName}`,
          body: `The buyer approval request for <strong>${escapeHtml(request.buyerName)}</strong> was rejected by the lead broker.` +
            (notes ? `<br/><br/><em>Reason:</em> ${escapeHtml(notes)}` : ""),
          actionUrl: `/deal/${deal.id}`,
          businessName: deal.businessName,
          metadata: { approvalRequestId: request.id },
          // The rejecting broker isn't emailed about their own rejection.
          actorUserId: req.session.brokerId ?? null,
        });

        return res.json(updated);
      }

      // Approve → send to seller (the level the broker chose is given when the seller approves)
      const updated = await storage.updateBuyerApprovalRequest(request.id, {
        status: "pending_seller_review",
        brokerReviewedBy: reviewerId || null,
        brokerReviewedAt: new Date(),
        brokerReviewNotes: notes || null,
        grantAccessLevel: grantLevel,
        grantedBy: "seller",
      } as any);

      const baseUrl = process.env.APP_URL || `${req.protocol}://${req.get("host")}`;
      const sellerReviewUrl = `${baseUrl}/review/${request.sellerReviewToken}`;
      const categoryLabel = BUYER_CATEGORIES.find(c => c.value === request.category)?.label || request.category;

      await notify(deal.id, "buyer_approval_broker_approved", {
        title: `Action needed: approve buyer for ${deal.businessName}`,
        body:
          `A new buyer has been approved by your broker and needs your final review before gaining access to the CIM.` +
          `<br/><br/><strong>Buyer:</strong> ${escapeHtml(request.buyerName)}` +
          (request.buyerCompany ? ` (${escapeHtml(request.buyerCompany)})` : "") +
          `<br/><strong>Type:</strong> ${escapeHtml(categoryLabel)}` +
          `<br/><strong>Risk level:</strong> ${escapeHtml(request.riskLevel)}` +
          `<br/><br/>Click the link below to review the full profile and approve or decline.`,
        actionUrl: sellerReviewUrl,
        businessName: deal.businessName,
        metadata: { approvalRequestId: request.id, reviewToken: request.sellerReviewToken },
      });

      res.json(updated);
    } catch (error: any) {
      console.error("Error in broker review:", error);
      res.status(500).json({ error: "Failed to process broker review" });
    }
  });

  // Public tokenized endpoint — seller fetches request for review (no login)
  app.get("/api/buyer-approval-review/:token", async (req, res) => {
    try {
      const request = await storage.getBuyerApprovalRequestByToken(req.params.token);
      if (!request) return res.status(404).json({ error: "Invalid or expired link" });
      if (request.status !== "pending_seller_review" && request.status !== "approved_by_seller" && request.status !== "access_granted") {
        return res.status(403).json({ error: "This approval link is no longer active" });
      }
      const deal = await storage.getDeal(request.dealId);
      const branding = deal?.brokerId ? await storage.getBrandingByBroker(deal.brokerId) : null;
      res.json({
        // Only what the seller's review page renders — never the broker's raw
        // CRM record (crmRawData: Pipedrive notes, custom fields, file names),
        // the CRM ids, the broker's review notes or internal ids.
        request: sellerReviewPayload(request),
        deal: deal ? { id: deal.id, businessName: deal.businessName } : null,
        // Whitelisted — never the settings row (ids, broker id, templates).
        branding: branding ? { companyName: branding.companyName ?? null, logoUrl: branding.logoUrl ?? null } : null,
      });
    } catch (error: any) {
      res.status(500).json({ error: "Failed to load review" });
    }
  });

  /**
   * An approved buyer gets access (the broker's "Give access", the seller's
   * approval, or the deal's automatic access after a teaser NDA): link or
   * invite their Cimple account, create the access row, email the buyer
   * (broker team CC'd) and tell the broker team.
   *
   * The level is the request's (`grant_access_level`; Blind CIM when unset)
   * — never the teaser. A teaser request is UPGRADED IN PLACE: the buyer's
   * teaser link (request.buyerAccessId) moves to the level, keeps its token,
   * and follows the CIM's expiry rule from today. Every email names the deal
   * the way the view room does (buyerFacingDealName): the codename for the
   * Blind CIM, the business only for the Full CIM / DD. With notifyBuyer
   * false no buyer email goes out (the broker shares the link; auto-grant
   * shows the CIM in place).
   */
  async function grantApprovedBuyer(
    request: NonNullable<Awaited<ReturnType<typeof storage.getBuyerApprovalRequest>>>,
    deal: NonNullable<Awaited<ReturnType<typeof storage.getDeal>>>,
    baseUrl: string,
    review: Record<string, unknown> = {},
    opts: { grantedBy?: "broker" | "seller" | "auto"; notifyBuyer?: boolean; level?: string } = {},
  ) {
    const reqTeaser = request as typeof request & { buyerAccessId?: string | null; grantAccessLevel?: string | null; grantedBy?: string | null; source?: string | null };
    const grantedLevel = normalizeAccessLevel(opts.level ?? reqTeaser.grantAccessLevel ?? BLIND_ACCESS_LEVEL);
    if (isTeaserOnly(grantedLevel)) throw new Error("An approval opens a CIM, never the teaser");
    const grantedBy = opts.grantedBy ?? ((reqTeaser.grantedBy === "broker" || reqTeaser.grantedBy === "auto") ? reqTeaser.grantedBy : "seller");
    const notifyBuyer = opts.notifyBuyer ?? true;
    const dealLabel = buyerFacingDealName(deal, { accessLevel: grantedLevel });
    const levelWords = accessGrantPhrase(grantedLevel).replace(/^Given /, "");
    const brokerNotice = async (accessId: string, sentTo: string | null, extra = "") => {
      const who = request.buyerName || request.buyerEmail;
      const title = grantedBy === "broker"
        ? `You gave ${who} ${levelWords}`
        : grantedBy === "auto"
          ? `${who} was given ${levelWords} automatically after signing the NDA`
          : `Buyer approved & granted access — ${request.buyerName}`;
      const body = grantedBy === "seller"
        ? `The seller has approved <strong>${escapeHtml(request.buyerName)}</strong>` +
          (request.buyerCompany ? ` of <strong>${escapeHtml(request.buyerCompany)}</strong>` : "") +
          (sentTo ? `. An email with their personal view link has been sent to ${escapeHtml(sentTo)}.` : ". No email was sent — share their link yourself.") + extra
        : `<strong>${escapeHtml(who)}</strong>` + (request.buyerCompany ? ` (${escapeHtml(request.buyerCompany)})` : "") +
          ` now has ${escapeHtml(levelWords)}.` +
          (sentTo ? ` An email with their link was sent to ${escapeHtml(sentTo)}.` : " No email was sent — the CIM opens on the link they already have.") + extra;
      await notify(deal.id, "buyer_approval_seller_approved", {
        title,
        body,
        actionUrl: `/deal/${deal.id}/buyers?stage=have`,
        businessName: deal.businessName,
        metadata: { approvalRequestId: request.id, buyerAccessId: accessId, grantedBy },
      });
    };

    // ── A teaser request: upgrade the buyer's own link in place ──
    if (reqTeaser.buyerAccessId) {
      const link = await storage.getBuyerAccess(reqTeaser.buyerAccessId);
      if (link && link.dealId === deal.id && !viewLinkProblem(link)) {
        const nowIso = new Date().toISOString();
        const cimExpiry = await brokerLinkExpiry(deal.brokerId ?? undefined);
        const current = link.expiresAt ? new Date(link.expiresAt) : null;
        const expiresAt = !current || current.getTime() < cimExpiry.getTime() ? cimExpiry : current;
        const events = [...((link.accessEvents as BuyerAccessEvent[] | null) ?? [])];
        if (!sameAccessLevel(link.accessLevel, grantedLevel)) events.push({ type: "level_changed", at: nowIso, accessLevel: grantedLevel });
        if (!current || expiresAt.getTime() !== current.getTime()) events.push({ type: "extended", at: nowIso, expiresAt: expiresAt.toISOString(), by: "upgrade" });
        const upgraded = await storage.updateBuyerAccess(link.id, { accessLevel: grantedLevel, expiresAt, accessEvents: events.slice(-50) } as any);
        const updated = await storage.updateBuyerApprovalRequest(request.id, {
          status: "access_granted",
          ...review,
          grantedBuyerAccessId: link.id,
          grantedAt: new Date(),
          grantAccessLevel: grantedLevel,
          grantedBy,
        } as any);
        let sentTo: string | null = null;
        if (notifyBuyer) {
          const { buildCimReadyEmail } = await import("./buyers/approval-emails");
          const { brokerageBrand } = await import("./cim/templates");
          const firm = (await brokerageBrand(deal.brokerId).catch(() => null))?.firmName ?? null;
          const email = buildCimReadyEmail({ buyerName: link.buyerName ?? request.buyerName, firm, dealLabel, viewUrl: `${baseUrl}/view/${link.accessToken}` });
          // Always the link's own address (the person the broker sent the teaser to).
          if (await sendDirectEmail(link.buyerEmail, email.subject, email.html)) sentTo = link.buyerEmail;
        }
        await brokerNotice(link.id, sentTo);
        return { request: updated, access: upgraded ?? link };
      }
    }

    const accessToken = crypto.randomUUID();
    const viewUrl = `${baseUrl}/view/${accessToken}`;
    const dashboardUrl = `${baseUrl}/buyer/dashboard`;

    // Link to an existing account only when that account can't belong to
    // someone else: verified, or never claimed (no password yet). An
    // unverified self-signup under the buyer's address gets nothing — the
    // buyer receives their own link and the access stays unlinked.
    const existingAccount = await storage.getBuyerUserByEmail(request.buyerEmail.toLowerCase().trim());
    let buyerUserId: string | null = null;
    let variant: ApprovalEmailVariant;

    if (existingAccount && isLinkableBuyerAccount(existingAccount)) {
      buyerUserId = existingAccount.id;
      if (existingAccount.passwordHash) {
        variant = "existing_account";
      } else if (notifyBuyer) {
        // Nobody can sign in to it yet (CRM import, NDA-created, expired
        // invite): send a fresh set-password invitation.
        await reinviteBuyerWithoutPassword(existingAccount, { businessName: dealLabel.name, viewUrl, baseUrl });
        variant = "set_password";
      } else {
        variant = "link_only";
      }
    } else if (existingAccount || !notifyBuyer) {
      // (No buyer email at all: no account is created or invited either.)
      variant = "link_only";
    } else {
      // Create new account + send set-password email
      const invited = await inviteBuyerUser({
        email: request.buyerEmail,
        name: request.buyerName,
        phone: request.buyerPhone,
        company: request.buyerCompany,
        title: request.buyerTitle,
        linkedinUrl: request.linkedinUrl,
        invitedByBroker: deal.brokerId,
        invitedByDeal: deal.id,
        businessName: dealLabel.name,
        viewUrl,
        baseUrl,
      });
      buyerUserId = invited.user.id;
      variant = "set_password";
      if (invited.isNew) {
        await storage.updateBuyerUser(buyerUserId, { fieldSources: initialFieldSources(invited.user, "approval", deal.id, deal.brokerId) } as any).catch(() => {});
      }
    }

    const buyerAccess = await storage.createBuyerAccess({
      dealId: deal.id,
      buyerUserId,
      accessToken,
      buyerEmail: request.buyerEmail,
      buyerName: request.buyerName || null,
      buyerCompany: request.buyerCompany || null,
      accessLevel: grantedLevel,
      expiresAt: await brokerLinkExpiry(deal.brokerId ?? undefined), // broker's configured default (30 days unless changed)
      accessEvents: [{ type: "granted", at: new Date().toISOString(), accessLevel: grantedLevel }] satisfies BuyerAccessEvent[],
    } as any);

    const updated = await storage.updateBuyerApprovalRequest(request.id, {
      status: "access_granted",
      ...review,
      grantedBuyerAccessId: buyerAccess.id,
      grantedAt: new Date(),
      grantAccessLevel: grantedLevel,
      grantedBy,
    } as any);

    let sentTo: string | null = null;
    let copied: string[] = [];
    if (notifyBuyer) {
      // CC the broker team. The deal's own broker (when not on the team) is
      // told by the notice below instead — one email, honouring their
      // Settings → Notifications switch — never both a CC and a notice.
      const members = await storage.getDealMembers(deal.id);
      const brokerEmails = members.filter(m => m.teamType === "broker" && m.email).map(m => m.email as string);
      const ccList = Array.from(new Set(brokerEmails.map((e) => e.trim().toLowerCase())));
      copied = ccList.filter((e) => e !== request.buyerEmail.trim().toLowerCase());

      const invite = buildApprovalInviteEmail({
        variant,
        buyerName: (variant === "existing_account" ? existingAccount?.name : null) || request.buyerName,
        dealLabel,
        viewUrl,
        dashboardUrl,
      });
      await sendDirectEmail(request.buyerEmail, invite.subject, invite.html, copied);
      sentTo = request.buyerEmail;
    }

    // Also notify broker team that access was granted
    await brokerNotice(
      buyerAccess.id,
      sentTo,
      (sentTo && copied.length ? " Your broker team was copied." : "") +
        (variant === "link_only" && existingAccount
          ? " An unconfirmed Cimple account already uses this email, so the access was not added to that account's dashboard."
          : ""),
    );

    return { request: updated, access: buyerAccess };
  }

  /** At publish: buyers the seller approved while the CIM was unpublished get their access now. */
  const grantingWaiting = new Set<string>();
  async function grantWaitingApprovals(dealId: string, baseUrl: string): Promise<number> {
    if (grantingWaiting.has(dealId)) return 0;
    grantingWaiting.add(dealId);
    try {
      const deal = await storage.getDeal(dealId);
      if (!deal || !dealPublishedForBuyers(deal)) return 0;
      // Approved by the seller, or given by the broker while the CIM wasn't live (approved_waiting_publish).
      const { waitingForPublish } = await import("./teaser/requests");
      const waiting = (await storage.getBuyerApprovalRequestsByDeal(dealId)).filter(waitingForPublish);
      let granted = 0;
      for (const request of waiting) {
        try {
          await grantApprovedBuyer(request, deal, baseUrl, {}, { grantedBy: request.status === "approved_waiting_publish" ? "broker" : "seller", notifyBuyer: true });
          granted++;
        } catch (err) {
          console.error(`[approvals] couldn't grant waiting approval ${request.id} at publish:`, err);
        }
      }
      return granted;
    } finally {
      grantingWaiting.delete(dealId);
    }
  }

  // Seller review — approve or reject (tokenized, public)
  app.post("/api/buyer-approval-review/:token", async (req, res) => {
    try {
      const request = await storage.getBuyerApprovalRequestByToken(req.params.token);
      if (!request) return res.status(404).json({ error: "Invalid token" });
      if (request.status !== "pending_seller_review") {
        return res.status(403).json({ error: "This request is no longer pending review" });
      }

      const { action, reviewerName, notes } = req.body || {};
      if (!["approve", "reject"].includes(action)) {
        return res.status(400).json({ error: "action must be approve or reject" });
      }

      const deal = await storage.getDeal(request.dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });

      if (action === "reject") {
        const updated = await storage.updateBuyerApprovalRequest(request.id, {
          status: "rejected",
          sellerReviewedBy: reviewerName || null,
          sellerReviewedAt: new Date(),
          sellerReviewNotes: notes || null,
          rejectionReason: notes || "Declined by seller",
        } as any);

        await notify(deal.id, "buyer_approval_rejected", {
          title: `Seller declined buyer — ${request.buyerName}`,
          body: `The seller has declined the buyer approval for <strong>${escapeHtml(request.buyerName)}</strong>.` +
            (notes ? `<br/><br/><em>Reason:</em> ${escapeHtml(notes)}` : ""),
          actionUrl: `/deal/${deal.id}`,
          businessName: deal.businessName,
          metadata: { approvalRequestId: request.id },
        });

        return res.json(updated);
      }

      const review = {
        sellerReviewedBy: reviewerName || null,
        sellerReviewedAt: new Date(),
        sellerReviewNotes: notes || null,
      };
      const baseUrl = process.env.APP_URL || `${req.protocol}://${req.get("host")}`;

      // Not published yet: the seller's approval is recorded and the buyer
      // waits — access (and the buyer's email) goes out when the broker
      // publishes, so nobody opens a draft the seller hasn't signed off.
      if (!dealPublishedForBuyers(deal)) {
        const updated = await storage.updateBuyerApprovalRequest(request.id, {
          status: "approved_by_seller",
          ...review,
        } as any);
        await notify(deal.id, "buyer_approval_seller_approved", {
          title: `Seller approved ${request.buyerName || "a buyer"} — access waits for publishing`,
          body:
            `The seller has approved <strong>${escapeHtml(request.buyerName)}</strong>` +
            (request.buyerCompany ? ` of <strong>${escapeHtml(request.buyerCompany)}</strong>` : "") +
            `. The CIM isn't published yet, so they haven't been sent anything. They get access and an invite email automatically when you publish.`,
          actionUrl: `/deal/${deal.id}`,
          businessName: deal.businessName,
          metadata: { approvalRequestId: request.id, waitingForPublish: true },
        });
        return res.json(updated);
      }

      const granted = await grantApprovedBuyer(request, deal, baseUrl, review, { grantedBy: "seller", notifyBuyer: true });
      res.json(granted.request);
    } catch (error: any) {
      console.error("Error in seller review:", error);
      res.status(500).json({ error: "Failed to process seller review" });
    }
  });

  app.delete("/api/buyer-access/:id", requireBroker, async (req, res) => {
    try {
      const existingAccess = await storage.getBuyerAccess(req.params.id);
      if (!existingAccess || !(await ownsDeal(req, existingAccess.dealId))) return res.status(404).json({ error: "Buyer access not found" });
      // Revoke access instead of hard delete
      const access = await storage.updateBuyerAccess(req.params.id, {
        revokedAt: new Date(),
      });
      if (!access) {
        return res.status(404).json({ error: "Buyer access not found" });
      }
      res.json({ success: true, message: "Access revoked" });
    } catch (error: any) {
      console.error("Error revoking buyer access:", error);
      res.status(500).json({ error: "Failed to revoke buyer access" });
    }
  });

  // =============================
  // CIM SECTION ROUTES
  // =============================
  
  app.get("/api/deals/:dealId/sections", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      // A live CIM approved before the per-section rule: its untouched
      // sections are ticked (server/cim/approvals.ts).
      const { backfillLegacyLiveApprovals } = await import("./cim/approvals");
      const sections = await backfillLegacyLiveApprovals(res.locals.deal);
      res.json(sections);
    } catch (error: any) {
      console.error("Error fetching sections:", error);
      res.status(500).json({ error: "Failed to fetch sections" });
    }
  });

  // Legacy create — the same rule as the builder's "Add section"
  // (server/cim/approvals.ts legacySectionInsert): never approved on
  // arrival, held back from blind buyers until redacted, hidden on a live
  // CIM, and a new shown section withdraws the approvals it voids.
  app.post("/api/deals/:dealId/sections", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const { legacySectionInsert, withdrawApprovalsAfterChange } = await import("./cim/approvals");
      const { insertSectionAt } = await import("./cim/section-ops");
      const { scheduleBlindRefresh } = await import("./cim/blind-sync");
      const parsed = legacySectionInsert(req.body, res.locals.deal);
      if (!parsed.ok) return res.status(400).json({ error: parsed.error });
      const created = await insertSectionAt(req.params.dealId, parsed.fields, {});
      if (created.isVisible !== false) await withdrawApprovalsAfterChange(req.params.dealId);
      scheduleBlindRefresh(req.params.dealId);
      res.json(created);
    } catch (error: any) {
      console.error("Error creating section:", error);
      res.status(500).json({ error: "Failed to create section" });
    }
  });

  // Legacy alias — same whitelisted, blind-safe update as /api/cim-sections/:id
  // (it used to accept ANY column, including blind-freshness state).
  app.patch("/api/sections/:id", requireBroker, patchCimSection);

  // ── CIM-SECTIONS ALIASES (used by CIMDesigner) ──

  app.get("/api/deals/:dealId/cim-sections", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      // A live CIM approved before the per-section rule: its untouched
      // sections are ticked (server/cim/approvals.ts).
      const { backfillLegacyLiveApprovals } = await import("./cim/approvals");
      const sections = await backfillLegacyLiveApprovals(res.locals.deal);
      res.json(sections);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to fetch sections" });
    }
  });

  app.post("/api/deals/:dealId/cim-sections/reorder", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      // Every id must belong to this deal (the old loop wrote any id it was
      // given — a cross-tenant write); one transaction, 0-based.
      const result = await reorderDealSections(req.params.dealId, req.body?.orderedIds);
      if (!result.ok) return res.status(result.status).json({ error: result.error });
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: "Failed to reorder sections" });
    }
  });

  // =============================
  // AI CONTENT GENERATION ROUTES
  // =============================
  
  app.post("/api/deals/:dealId/generate-content", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const { dealId } = req.params;
      const deal = await storage.getDeal(dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });

      // Product rule: critical discrepancies block CIM generation until handled.
      // The client disabled the first "Generate" button but not "Regenerate";
      // the server is now the authority. "open" and "seller_responded" block.
      // "ask_seller" means the broker routed it to the seller interview, which
      // counts as handled while the interview runs; when it ends, session-
      // manager flips ask_seller → seller_responded so the broker reviews the
      // transcript before generating. Routed after the interview had finished,
      // it blocks until the seller answers the follow-up (shared/discrepancy-gate.ts;
      // OverviewTab's gate mirrors this rule).
      const openCritical = await blockingCriticalDiscrepancies(dealId);
      if (openCritical.length > 0) return discrepancyBlockResponse(res, openCritical, "generating the CIM");

      const { sectionKey, sectionId } = req.body;

      // ── Single-section regeneration (visual CIM) ──
      // Rebuilds one stored section through the layout engine with the rest
      // of the document as context. Nothing else is touched; the section's
      // blind/DD overrides are dropped because they described the old content.
      if (sectionId) {
        const target = await storage.getCimSection(String(sectionId));
        if (!target || target.dealId !== dealId) {
          return res.status(404).json({ error: "Section not found" });
        }
        const existingSections = await storage.getCimSectionsByDeal(dealId);
        // Same knowledge base as a full generation (resolved values, the
        // financial analysis, privacy screening) — see generation-jobs.
        const layoutParams = await buildLayoutParams(deal, "content");
        const refs = existingSections.map(s => ({
          sectionKey: s.sectionKey,
          sectionTitle: s.sectionTitle,
          order: s.order,
          layoutType: s.layoutType,
          tags: s.tags,
          aiLayoutReasoning: s.aiLayoutReasoning,
        }));
        const regenerated = await regenerateCimSection(
          layoutParams,
          refs,
          refs.find(r => r.sectionKey === target.sectionKey)!,
          { layoutType: target.layoutType, brief: typeof req.body.brief === "string" ? req.body.brief : undefined },
        );
        // A live CIM's buyers keep the approved version until this is approved (shared/cim-published.ts).
        {
          const { keepPublishedBeforeChange } = await import("./cim/published-versions");
          await keepPublishedBeforeChange(target, deal);
        }
        const updatedSection = await storage.updateCimSection(String(target.id), {
          // Usually unchanged; a scorecard of words comes back as highlight cards.
          layoutType: regenerated.layoutType,
          layoutData: regenerated.layoutData as any,
          aiDraftContent: regenerated.aiDraftContent || null,
          figureWarnings: regenerated.figureWarnings?.length ? regenerated.figureWarnings : null,
          // The figure check hid it (untraced figures it couldn't take out, or nothing left).
          ...(regenerated.isVisible === false ? { isVisible: false } : {}),
          brokerEditedContent: null,
          brokerApproved: false,
          // Un-ticked under the per-section approval rule (shared/cim-approvals).
          contentHistory: withApprovalRuleMark(target.contentHistory),
          // Written now: no longer a placeholder (placeholders never reach buyers).
          ...(isCimFallbackSection(target) ? { aiLayoutReasoning: "Regenerated from the deal's information." } : {}),
        });
        // The section's overrides now describe content that no longer exists:
        // drop them, mark the section stale and re-redact in the background
        // under the existing codename. The view room holds a stale section
        // back from blind buyers until then (it is never served un-redacted).
        await invalidateBlind(dealId, [String(target.id)]);
        // New content the deal's approvals never covered (shared/cim-approvals.ts).
        if (updatedSection?.isVisible !== false) {
          const { withdrawApprovalsAfterChange } = await import("./cim/approvals");
          await withdrawApprovalsAfterChange(dealId);
        }
        if (regenerated.aiDraftContent) {
          const existingContent = (deal.cimContent as Record<string, string>) || {};
          await storage.updateDeal(deal.id, { cimContent: { ...existingContent, [target.sectionKey]: regenerated.aiDraftContent } });
        }
        return res.json({ success: true, section: updatedSection });
      }

      // ── Single-section regeneration (legacy text keys) ──
      if (sectionKey) {
        const businessName = deal.businessName || "The Business";
        const industry = deal.industry || "a specialized industry";
        const sectionData = {
          extractedInfo: (deal.extractedInfo as Record<string, any>) || {},
          questionnaireData: deal.questionnaireData as Record<string, any> | null,
          scrapedData: (deal as any).scrapedData as Record<string, any> | null,
          description: deal.description,
          askingPrice: listedAskingPrice(deal),
          keepOut: await keepOutFor(deal.id, (deal.extractedInfo as Record<string, unknown>) || {}),
        };
        if (!CIM_SECTION_PROMPTS[sectionKey]) {
          return res.status(400).json({ error: `Unknown section key: ${sectionKey}` });
        }
        const content = await generateSectionWithClaude(businessName, industry, sectionKey, sectionData);
        const existingContent = (deal.cimContent as Record<string, string>) || {};
        const updated = { ...existingContent, [sectionKey]: content };
        await storage.updateDeal(deal.id, { cimContent: updated });

        // Also update the matching CIM section if one exists
        const existingSections = await storage.getCimSectionsByDeal(dealId);
        const matchingSection = existingSections.find(s => s.sectionKey === sectionKey);
        if (matchingSection) {
          const { keepPublishedBeforeChange } = await import("./cim/published-versions");
          await keepPublishedBeforeChange(matchingSection, deal);
          await storage.updateCimSection(String(matchingSection.id), {
            aiDraftContent: content,
            brokerApproved: false,
            // Un-ticked under the per-section approval rule (shared/cim-approvals).
            contentHistory: withApprovalRuleMark(matchingSection.contentHistory),
          });
        }
        // Rewritten content the deal's approvals never covered.
        {
          const { withdrawApprovalsAfterChange } = await import("./cim/approvals");
          await withdrawApprovalsAfterChange(dealId);
        }

        res.json({ sectionKey, content });
        return;
      }

      // ── Full CIM generation — runs as a background job ──
      // Returns 202 immediately; the client follows progress via
      // GET /api/deals/:dealId/cim-generation. The job keeps running if the
      // broker leaves the page (the old single request was dropped with it).
      // Enough information to write from? A completed interview, or a
      // readiness score of "Developing" or better from any mix of sources
      // (calls, CRM, documents, the Information tab) — the same rule the
      // Overview, CIM tab and builder show (shared/deal-progress).
      const infoGate = await checkCimGenerationGate(deal);
      if (!infoGate.allowed) {
        return res.status(409).json({ error: infoGate.reason, code: "needs_information", readiness: infoGate.readiness });
      }
      try {
        const job = await startCimGeneration(deal, "content", { beforeWriting: (onChecking) => ensureDiscrepancyGate(dealId, onChecking) });
        return res.status(202).json({ started: true, job });
      } catch (err) {
        if (err instanceof CimGenerationRunningError) {
          return res.status(409).json({ error: "CIM generation is already running for this deal", job: err.job });
        }
        // The broker's hold on "Add-backs in the books" (gl spec §6.9).
        const glGate = await import("./gl/gate");
        if (glGate.isGlTraceRequiredError(err)) return res.status(409).json(glGate.glGateBody(err));
        throw err;
      }
    } catch (error: any) {
      console.error("Error generating content:", error);
      res.status(500).json({ error: error.message || "Failed to generate content" });
    }
  });

  // Generate blind CIM (AI-powered redaction of all identifying info)
  app.post("/api/deals/:dealId/generate-blind", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const { dealId } = req.params;
      const deal = await storage.getDeal(dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });

      const sections = await storage.getCimSectionsByDeal(dealId);
      if (sections.length === 0) {
        return res.status(400).json({ error: "Generate CIM content first" });
      }

      // Rebuilds every section's blind version under the deal's EXISTING
      // codename (a new, brokerage-unique one only if it never had one) —
      // outreach already sent under the codename keeps matching the CIM.
      // Sections whose redaction fails are held back from blind buyers
      // (never served un-redacted) and reported here.
      const { codename, count, failed } = await regenerateAllBlind(dealId);
      res.json({ success: true, overrideCount: count, failedCount: failed, codename });
    } catch (error: any) {
      console.error("Error generating blind CIM:", error);
      res.status(500).json({ error: error.message || "Failed to generate blind CIM" });
    }
  });

  // Generate DD (Due Diligence) enriched CIM
  app.post("/api/deals/:dealId/generate-dd", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const { dealId } = req.params;
      const deal = await storage.getDeal(dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });

      const sections = await storage.getCimSectionsByDeal(dealId);
      if (sections.length === 0) {
        return res.status(400).json({ error: "Generate CIM content first" });
      }
      // Same gate as every other CIM-writing step (generate-content, layout,
      // the builder's per-section DD refresh): DD commentary written from a
      // disputed figure would reach due-diligence buyers straight away.
      const openCritical = await blockingCriticalDiscrepancies(dealId);
      if (openCritical.length > 0) return discrepancyBlockResponse(res, openCritical, "generating the due-diligence CIM");
      // The due-diligence CIM shows the ledger entries behind each add-back: it waits for
      // "Add-backs in the books" (reviewed, or gone ahead without the ledger) — gl spec §6.9.
      {
        const glGate = await import("./gl/gate");
        try {
          await glGate.assertGlGate(deal, "dd");
        } catch (err) {
          if (glGate.isGlTraceRequiredError(err)) return res.status(409).json(glGate.glGateBody(err));
          throw err;
        }
      }

      // DD context: shared documents only, CIM-safe facts, the computed
      // financial analysis (never the analyzer's raw JSON or its internal
      // questions) — see dd-enrichment buildDdContext.
      const { loadDdInputs, startFullDdGeneration, ddRunning } = await import("./cim/dd-enrichment");
      // One DD run per deal (shared with the builder's "Refresh DD").
      if (ddRunning.has(dealId)) return res.status(409).json({ error: "The due-diligence version is already being written." });
      const startedAt = new Date();
      const inputs = await loadDdInputs(deal);
      // Runs in the background (the CIM tab polls the builder state for
      // dd.running / dd.lastRun). A section the AI couldn't write keeps its
      // current DD version; a run that wrote nothing changes nothing.
      try {
        startFullDdGeneration(deal, sections, inputs, startedAt);
      } catch (err: any) {
        if (err?.message === "running") return res.status(409).json({ error: "The due-diligence version is already being written." });
        throw err;
      }
      // startedAt identifies this run: the page announces the dd.lastRun
      // whose startedAt matches — even one that failed before its first poll.
      // (The run records the approved sections' DD versions when it writes —
      // dd-enrichment dbRunWriter → recordPublishedDd.)
      res.status(202).json({ started: true, sections: sections.length, startedAt: startedAt.toISOString() });
    } catch (error: any) {
      console.error("Error generating DD CIM:", error);
      if (error?.name === "StaleFinancialAnalysisError") return res.status(409).json({ error: error.message });
      res.status(500).json({ error: error.message || "Failed to generate DD CIM" });
    }
  });

  // Get CIM section overrides for a specific mode
  app.get("/api/deals/:dealId/cim-overrides/:mode", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const overrides = await storage.getCimSectionOverrides(req.params.dealId, req.params.mode);
      res.json(overrides);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to fetch overrides" });
    }
  });

  // Flag missing info after interview
  app.post("/api/deals/:dealId/flag-missing", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const deal = await storage.getDeal(req.params.dealId);
      if (!deal) {
        return res.status(404).json({ error: "Deal not found" });
      }
      
      const extractedInfo = deal.extractedInfo as Record<string, any> || {};
      
      const criticalFields = [
        { key: "keyProducts", label: "Products/Services" },
        { key: "ownerInvolvement", label: "Owner's Day-to-Day Responsibilities" },
        { key: "employees", label: "Employee Count" },
        { key: "employeeStructure", label: "Employee Roles & Structure" },
        { key: "targetMarket", label: "Customer Demographics" },
        { key: "customerConcentration", label: "Customer Concentration" },
        { key: "competitiveAdvantage", label: "Competitive Differentiators" },
        { key: "suppliers", label: "Suppliers & Vendors" },
        { key: "leaseDetails", label: "Lease/Property Details" },
        { key: "assets", label: "Equipment & Assets" },
        { key: "technologySystems", label: "Technology & Systems" },
        { key: "permitsLicenses", label: "Licenses & Permits" },
        { key: "seasonality", label: "Seasonality" },
        { key: "growthOpportunities", label: "Growth Opportunities" },
        { key: "reasonForSale", label: "Reason for Sale" },
      ];
      
      const missingFields = criticalFields.filter(f => !extractedInfo[f.key]);
      
      const existingTasks = await storage.getTasksByDeal(deal.id);
      const existingMissingTitles = new Set(
        existingTasks.filter(t => t.type === "missing_info").map(t => t.title)
      );
      
      const tasks = [];
      for (const field of missingFields) {
        const title = `Missing: ${field.label}`;
        if (existingMissingTitles.has(title)) continue;
        const task = await storage.createTask({
          dealId: deal.id,
          type: "missing_info",
          title,
          description: `This information was not captured during the AI interview and is needed for the CIM.`,
          status: "pending",
          assignedTo: "seller",
          createdBy: "system",
          requiresBrokerAuth: false,
        });
        tasks.push(task);
      }
      
      res.json({ 
        missingCount: missingFields.length,
        capturedCount: criticalFields.length - missingFields.length,
        totalFields: criticalFields.length,
        tasks 
      });
    } catch (error: any) {
      console.error("Error flagging missing info:", error);
      res.status(500).json({ error: "Failed to flag missing info" });
    }
  });

  // FAQ Routes
  app.get("/api/deals/:dealId/faq", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const faqs = await storage.getFaqsByDeal(req.params.dealId);
      res.json(faqs);
    } catch (error: any) {
      console.error("Error fetching FAQs:", error);
      res.status(500).json({ error: "Failed to fetch FAQs" });
    }
  });

  app.post("/api/deals/:dealId/faq", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const { question, answer } = req.body;
      if (!question || typeof question !== 'string' || !question.trim()) {
        return res.status(400).json({ error: "Question is required" });
      }
      if (!answer || typeof answer !== 'string' || !answer.trim()) {
        return res.status(400).json({ error: "Answer is required" });
      }
      const faq = await storage.createFaq({
        question: question.trim(),
        answer: answer.trim(),
        dealId: req.params.dealId,
        isPublished: true,
      });
      res.json(faq);
    } catch (error: any) {
      console.error("Error creating FAQ:", error);
      res.status(500).json({ error: "Failed to create FAQ" });
    }
  });

  app.patch("/api/faq/:id", requireBroker, async (req, res) => {
    try {
      const existingFaq = await storage.getFaq(req.params.id);
      if (!existingFaq || !(await ownsDeal(req, existingFaq.dealId))) return res.status(404).json({ error: "FAQ not found" });
      const { dealId: _d, id: _i, ...faqUpdates } = req.body || {};
      const faq = await storage.updateFaq(req.params.id, faqUpdates);
      if (!faq) {
        return res.status(404).json({ error: "FAQ not found" });
      }
      res.json(faq);
    } catch (error: any) {
      console.error("Error updating FAQ:", error);
      res.status(500).json({ error: "Failed to update FAQ" });
    }
  });

  app.delete("/api/faq/:id", requireBroker, async (req, res) => {
    try {
      const existingFaq = await storage.getFaq(req.params.id);
      if (!existingFaq || !(await ownsDeal(req, existingFaq.dealId))) return res.status(404).json({ error: "FAQ not found" });
      await storage.deleteFaq(req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      console.error("Error deleting FAQ:", error);
      res.status(500).json({ error: "Failed to delete FAQ" });
    }
  });

  // =====================
  // Analytics API
  // =====================
  
  // Track analytics event from buyer viewer
  app.post("/api/buyer-access/:token/events", async (req, res) => {
    try {
      const { token } = req.params;
      const buyerAccess = await storage.getBuyerAccessByToken(token);
      const problem = viewLinkProblem(buyerAccess);
      if (problem || !buyerAccess) {
        const e = viewLinkError(problem ?? "not_found");
        return res.status(e.status).json({ error: e.error });
      }
      // The teaser page sends only the reading tracker; nothing from a Teaser
      // link is stored as CIM analytics.
      if (isTeaserOnly(buyerAccess.accessLevel)) return res.status(204).end();
      if (!dealPublishedForBuyers(await storage.getDeal(buyerAccess.dealId))) return res.status(403).json(notPublishedBody());

      const eventSchema = z.object({
        eventType: z.enum(["view", "page_view", "scroll", "download_attempt", "time_on_page"]),
        pageNumber: z.number().optional(),
        sectionKey: z.string().optional(),
        timeSpentSeconds: z.number().optional(),
        scrollDepthPercent: z.number().optional(),
        eventData: z.any().optional(),
      });
      
      const eventData = eventSchema.parse(req.body);
      await translateBlindSectionKeys(buyerAccess.dealId, [eventData]);
      
      const event = await storage.createAnalyticsEvent({
        dealId: buyerAccess.dealId,
        buyerAccessId: buyerAccess.id,
        eventType: eventData.eventType,
        pageNumber: eventData.pageNumber,
        sectionKey: eventData.sectionKey,
        timeSpentSeconds: eventData.timeSpentSeconds,
        scrollDepthPercent: eventData.scrollDepthPercent,
        eventData: eventData.eventData,
        ipAddress: req.ip || null,
        userAgent: req.get("User-Agent") || null,
      });
      
      // A view event counts as a view — but never before a required NDA is
      // signed (firstViewedAt starts the reminder clock; see viewStampFor).
      if (eventData.eventType === "view") {
        const eventDeal = await storage.getDeal(buyerAccess.dealId);
        const served = !!eventDeal && !ndaBlocksBuyer(eventDeal, buyerAccess);
        await storage.updateBuyerAccess(buyerAccess.id, viewStampFor(buyerAccess, served) as any);
      }
      
      res.json({ success: true, eventId: event.id });
    } catch (error: any) {
      console.error("Error tracking event:", error);
      res.status(400).json({ error: error.message || "Failed to track event" });
    }
  });
  
  // Get analytics summary (broker-wide or per deal)
  app.get("/api/analytics/summary", requireBroker, async (req, res) => {
    try {
      const dealId = req.query.dealId as string | undefined;
      if (dealId) {
        const owned = await getOwnedDeal(dealId, req.session.brokerId);
        if (!owned) return res.status(404).json({ error: "Deal not found" });
        return res.json(await storage.getAnalyticsSummary(dealId));
      }
      // "All CIMs" — aggregate only across this broker's deals
      const deals = await storage.getAllDeals(req.session.brokerId);
      const summary = await storage.getAnalyticsSummaryForDeals(deals.map((d) => d.id));
      res.json(summary);
    } catch (error: any) {
      console.error("Error getting analytics:", error);
      res.status(500).json({ error: "Failed to get analytics" });
    }
  });
  
  // Get analytics events for a deal
  app.get("/api/deals/:dealId/analytics", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const { dealId } = req.params;
      const events = await storage.getAnalyticsByDeal(dealId);
      res.json(events);
    } catch (error: any) {
      console.error("Error getting deal analytics:", error);
      res.status(500).json({ error: "Failed to get analytics" });
    }
  });

  // Computed analytics — aggregated server-side so we don't ship raw events to client
  app.get("/api/deals/:dealId/analytics/computed", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const { dealId } = req.params;
      const { matchBuyerToDeal } = await import("./matching/engine.js");
      const { calculateQualifiedLeadScore } = await import("./scoring/buyer-score.js");
      const [events, buyers, questions] = await Promise.all([
        storage.getAnalyticsByDeal(dealId),
        storage.getBuyerAccessByDeal(dealId),
        storage.getQuestionsByDeal(dealId),
      ]);

      // ── Section engagement ──────────────────────────────────────────────
      // Sum timeSpentSeconds from section_exit events, grouped by sectionKey
      const sectionTime: Record<string, { totalSeconds: number; count: number; title: string; viewers: Set<string> }> = {};
      for (const e of events) {
        if (e.eventType === "section_exit" && e.sectionKey && e.timeSpentSeconds) {
          if (!sectionTime[e.sectionKey]) sectionTime[e.sectionKey] = { totalSeconds: 0, count: 0, title: e.sectionKey, viewers: new Set() };
          sectionTime[e.sectionKey].totalSeconds += e.timeSpentSeconds;
          sectionTime[e.sectionKey].count += 1;
          if (e.buyerAccessId) sectionTime[e.sectionKey].viewers.add(e.buyerAccessId);
        }
      }
      const sectionEngagement = Object.entries(sectionTime)
        .map(([key, v]) => ({
          sectionKey: key,
          avgSeconds: Math.round(v.totalSeconds / v.count),
          totalSeconds: v.totalSeconds,
          // Unique buyers, not exit events (one buyer re-entering six times is one viewer)
          viewerCount: v.viewers.size || v.count,
        }))
        .sort((a, b) => b.avgSeconds - a.avgSeconds);

      // ── Per-buyer stats ─────────────────────────────────────────────────
      const buyerStats: Record<string, { totalSeconds: number; sectionsEntered: Set<string>; maxScrollDepth: number; questionCount: number }> = {};
      for (const e of events) {
        const bid = e.buyerAccessId;
        if (!bid) continue;
        if (!buyerStats[bid]) buyerStats[bid] = { totalSeconds: 0, sectionsEntered: new Set(), maxScrollDepth: 0, questionCount: 0 };
        if (e.eventType === "section_exit" && e.timeSpentSeconds) buyerStats[bid].totalSeconds += e.timeSpentSeconds;
        if (e.eventType === "section_enter" && e.sectionKey) buyerStats[bid].sectionsEntered.add(e.sectionKey);
        if (e.eventType === "scroll_depth" && (e.scrollDepthPercent ?? 0) > buyerStats[bid].maxScrollDepth) {
          buyerStats[bid].maxScrollDepth = e.scrollDepthPercent ?? 0;
        }
      }
      for (const q of questions) {
        const bid = q.buyerAccessId;
        if (bid && buyerStats[bid]) buyerStats[bid].questionCount += 1;
      }
      // Reading time per buyer comes from the reading rollups (2026-09
      // tracker; the broker's own previews excluded), falling back to the old
      // events only for access rows with no measured visit: the same numbers
      // as the Engagement tab and the buyer profile. Intent feeds the score.
      const { engagementByAccess, readingIntentByAccess } = await import("./buyers/profile-data.js");
      const [reading, intents] = await Promise.all([
        engagementByAccess(buyers.map((b) => b.id)).catch(() => new Map() as Awaited<ReturnType<typeof engagementByAccess>>),
        readingIntentByAccess(buyers.map((b) => ({ id: b.id, dealId: b.dealId }))).catch(() => new Map<string, number>()),
      ]);
      const questionsBy: Record<string, number> = {};
      for (const q of questions) if (q.buyerAccessId) questionsBy[q.buyerAccessId] = (questionsBy[q.buyerAccessId] ?? 0) + 1;
      // For each buyer, look up their Cimple account (if linked) and compute
      // match fit against this deal. Match fit uses the SAME positive framing
      // as the buyer-side dashboard: raw criteria-matched count + dimension
      // chips, never letter grades. This lets brokers see "which engaged
      // buyers are also good-fit buyers" — the signal that actually matters.
      const deal = await storage.getDeal(dealId);
      const ANALYTICS_DIMENSION_LABELS: Record<string, string> = {
        financialFit: "Financials",
        industryFit: "Industry",
        locationFit: "Location",
        operationalFit: "Operations",
        dealStructureFit: "Deal structure",
        qualificationFit: "Qualification",
      };
      const topDimsFromBreakdown = (bd: any): string[] => {
        if (!bd) return [];
        const entries: Array<[string, number]> = [];
        for (const key of Object.keys(ANALYTICS_DIMENSION_LABELS)) {
          const cat = bd[key];
          if (cat && cat.max > 0) {
            const pct = (cat.score / cat.max) * 100;
            if (pct >= 60) entries.push([ANALYTICS_DIMENSION_LABELS[key], pct]);
          }
        }
        entries.sort((a, b) => b[1] - a[1]);
        return entries.slice(0, 3).map((e) => e[0]);
      };

      const buyerBreakdown = await Promise.all(buyers.map(async (b) => {
        // Pull profile if buyer has a Cimple account
        let profile: any = null;
        let buyerUser: any = null;
        if (b.buyerUserId) {
          try {
            buyerUser = await storage.getBuyerUser(b.buyerUserId);
            if (buyerUser) {
              // Same effective profile as Suggested buyers (broker edits > own > CRM).
              const contactRow = await storage.getBrokerBuyerContact(req.session.brokerId!, buyerUser.id);
              buyerUser = mergeBuyerProfile(buyerUser, contactRow?.crmProfile as CrmBuyerProfile | null, contactRow?.brokerProfile as BrokerBuyerOverlay | null);
              profile = {
                buyerType: buyerUser.buyerType,
                profileCompletionPct: buyerUser.profileCompletionPct,
                hasProofOfFunds: buyerUser.hasProofOfFunds,
                company: buyerUser.company,
              };
            }
          } catch {}
        }

        // Compute match fit if we have a profile + deal data
        let match: { criteriaMatched: number; criteriaTested: number; topDimensions: string[] } | null = null;
        let fullBreakdown: any = null;
        if (buyerUser && deal) {
          try {
            const criteria: any = {
              ...(buyerUser.buyerCriteria as any || {}),
              targetIndustries: buyerUser.targetIndustries || [],
              targetLocations: buyerUser.targetLocations || [],
            };
            fullBreakdown = await matchBuyerToDeal(
              criteria,
              {
                industry: deal.industry || "",
                subIndustry: (deal as any).subIndustry,
                askingPrice: (deal as any).askingPrice,
                description: (deal as any).description ?? null,
                extractedInfo: (deal as any).extractedInfo || {},
              },
              { skipAI: true },
            );
            match = {
              criteriaMatched: fullBreakdown.criteriaMatched,
              criteriaTested: fullBreakdown.criteriaTested,
              topDimensions: topDimsFromBreakdown(fullBreakdown),
            };
          } catch {}
        }

        // ── Composite qualified-lead score ─────────────────────────────────
        // Combines match-fit + profile completeness + engagement + proof of
        // funds into one broker-facing 0-100 score with hot/warm/cool/cold tier.
        const stats = buyerStats[b.id];
        const read = reading.get(b.id);
        const totalTimeSeconds = read ? read.seconds : stats?.totalSeconds ?? 0;
        const sectionsViewedCount = read ? read.sectionsViewed : stats?.sectionsEntered.size ?? 0;
        const questionCount = questionsBy[b.id] ?? 0;
        const qualifiedScore = buyerUser ? calculateQualifiedLeadScore({
          buyer: buyerUser,
          match: fullBreakdown,
          engagement: read || stats ? {
            intent: intents.get(b.id) ?? null,
            viewCount: b.viewCount ?? 0,
            sectionsViewed: sectionsViewedCount,
            totalTimeSeconds,
            questionCount,
            ndaSigned: !!b.ndaSignedAt,
          } : null,
        }) : null;

        return {
          ...b,
          totalTimeSeconds,
          sectionsViewedCount,
          maxScrollDepth: stats?.maxScrollDepth ?? 0,
          questionCount,
          hasAccount: !!b.buyerUserId,
          profile,
          match,
          qualifiedScore: qualifiedScore ? {
            total: qualifiedScore.total,
            tier: qualifiedScore.tier,
            reasons: qualifiedScore.reasons,
          } : null,
        };
      }));

      // ── Heat map grid (20×10) ───────────────────────────────────────────
      const COLS = 20; const ROWS = 10;
      const grid: number[][] = Array.from({ length: ROWS }, () => Array(COLS).fill(0));
      let heatTotal = 0;
      for (const e of events) {
        if (e.eventType === "heat_map_sample" && e.heatMapX != null && e.heatMapY != null) {
          const col = Math.min(Math.floor((e.heatMapX / 100) * COLS), COLS - 1);
          const row = Math.min(Math.floor((e.heatMapY / 100) * ROWS), ROWS - 1);
          grid[row][col]++;
          heatTotal++;
        }
      }

      // ── Scroll depth distribution (buckets of 10%) ──────────────────────
      const scrollBuckets: Record<number, number> = {};
      for (let i = 0; i <= 100; i += 10) scrollBuckets[i] = 0;
      for (const e of events) {
        if (e.eventType === "scroll_depth" && e.scrollDepthPercent != null) {
          const bucket = Math.floor(e.scrollDepthPercent / 10) * 10;
          scrollBuckets[bucket] = (scrollBuckets[bucket] ?? 0) + 1;
        }
      }
      const scrollDistribution = Object.entries(scrollBuckets)
        .map(([pct, count]) => ({ pct: Number(pct), count }))
        .sort((a, b) => a.pct - b.pct);

      // ── Recent activity (last 30 days) ──────────────────────────────────
      const viewsByDay: Record<string, number> = {};
      for (const e of events) {
        if (e.eventType === "view" && e.createdAt) {
          const day = new Date(e.createdAt).toISOString().slice(0, 10);
          viewsByDay[day] = (viewsByDay[day] ?? 0) + 1;
        }
      }

      res.json({
        sectionEngagement,
        buyerBreakdown,
        heatGrid: { grid, cols: COLS, rows: ROWS, total: heatTotal },
        scrollDistribution,
        viewsByDay,
        totalEvents: events.length,
      });
    } catch (error: any) {
      console.error("Error computing analytics:", error);
      res.status(500).json({ error: "Failed to compute analytics" });
    }
  });

  // Activity timeline — chronological feed of buyer events
  app.get("/api/deals/:dealId/analytics/timeline", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const { dealId } = req.params;
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const offset = Number(req.query.offset) || 0;

      const [events, buyers] = await Promise.all([
        storage.getAnalyticsByDeal(dealId),
        storage.getBuyerAccessByDeal(dealId),
      ]);

      const buyerMap = new Map(buyers.map(b => [b.id, b]));

      // Filter to meaningful events only (not heat_map_sample which is noise)
      const meaningful = events
        .filter(e => ["view", "nda_signed", "section_enter", "scroll_depth", "question_asked", "download_attempt", "decision"].includes(e.eventType))
        .sort((a, b) => new Date(b.createdAt!).getTime() - new Date(a.createdAt!).getTime())
        .slice(offset, offset + limit);

      const timeline = meaningful.map(e => {
        const buyer = e.buyerAccessId ? buyerMap.get(e.buyerAccessId) : null;
        return {
          id: e.id,
          eventType: e.eventType,
          buyerName: buyer?.buyerName || "Unknown buyer",
          buyerEmail: buyer?.buyerEmail || null,
          sectionKey: e.sectionKey,
          scrollDepthPercent: e.scrollDepthPercent,
          timeSpentSeconds: e.timeSpentSeconds,
          // Decision events carry { decision, nextStep } so the feed can say which
          eventData: e.eventType === "decision" ? (e.eventData ?? null) : null,
          createdAt: e.createdAt,
        };
      });

      res.json({ timeline, total: events.filter(e => ["view", "nda_signed", "section_enter", "scroll_depth", "question_asked", "download_attempt", "decision"].includes(e.eventType)).length });
    } catch (error: any) {
      console.error("Error getting timeline:", error);
      res.status(500).json({ error: "Failed to get timeline" });
    }
  });

  // Per-deal analytics summary (lightweight — for embedding in deal detail page)
  app.get("/api/deals/:dealId/analytics/summary", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const { dealId } = req.params;
      const [events, buyers, questions] = await Promise.all([
        storage.getAnalyticsByDeal(dealId),
        storage.getBuyerAccessByDeal(dealId),
        storage.getQuestionsByDeal(dealId),
      ]);

      const views = events.filter(e => e.eventType === "view").length;
      const uniqueBuyerIds = new Set(events.filter(e => e.buyerAccessId).map(e => e.buyerAccessId));
      const sectionExits = events.filter(e => e.eventType === "section_exit" && e.timeSpentSeconds);
      const totalTime = sectionExits.reduce((s, e) => s + (e.timeSpentSeconds ?? 0), 0);
      const avgTime = sectionExits.length > 0 ? Math.round(totalTime / uniqueBuyerIds.size) : 0;

      // Most engaged section
      const sectionTime: Record<string, number> = {};
      for (const e of sectionExits) {
        if (e.sectionKey) sectionTime[e.sectionKey] = (sectionTime[e.sectionKey] ?? 0) + (e.timeSpentSeconds ?? 0);
      }
      const topSection = Object.entries(sectionTime).sort((a, b) => b[1] - a[1])[0];

      // Scroll completion rate — % of buyers who reached 75%+
      const buyerMaxScroll: Record<string, number> = {};
      for (const e of events) {
        if (e.eventType === "scroll_depth" && e.buyerAccessId && e.scrollDepthPercent) {
          buyerMaxScroll[e.buyerAccessId] = Math.max(buyerMaxScroll[e.buyerAccessId] ?? 0, e.scrollDepthPercent);
        }
      }
      const completedCount = Object.values(buyerMaxScroll).filter(v => v >= 75).length;
      const completionRate = uniqueBuyerIds.size > 0 ? Math.round((completedCount / uniqueBuyerIds.size) * 100) : 0;

      // NDA signed count
      const ndaSigned = buyers.filter(b => b.ndaSignedAt).length;

      res.json({
        totalViews: views,
        uniqueBuyers: uniqueBuyerIds.size,
        avgTimePerBuyer: avgTime,
        totalTime,
        totalQuestions: questions.length,
        ndaSigned,
        completionRate,
        topSection: topSection ? { key: topSection[0], seconds: topSection[1] } : null,
        activeBuyers: buyers.filter(b => !b.revokedAt && (!b.expiresAt || new Date(b.expiresAt) > new Date())).length,
      });
    } catch (error: any) {
      console.error("Error getting deal analytics summary:", error);
      res.status(500).json({ error: "Failed to get analytics summary" });
    }
  });

  // All-deals analytics comparison (for dashboard)
  app.get("/api/analytics/deals-comparison", requireBroker, async (req, res) => {
    try {
      const deals = await storage.getAllDeals(req.session.brokerId);
      const comparison = await Promise.all(deals.map(async (deal: any) => {
        const [events, buyers, questions] = await Promise.all([
          storage.getAnalyticsByDeal(deal.id),
          storage.getBuyerAccessByDeal(deal.id),
          storage.getQuestionsByDeal(deal.id),
        ]);

        const views = events.filter(e => e.eventType === "view").length;
        const uniqueBuyerIds = new Set(events.filter(e => e.buyerAccessId).map(e => e.buyerAccessId));
        const sectionExits = events.filter(e => e.eventType === "section_exit" && e.timeSpentSeconds);
        const totalTime = sectionExits.reduce((s, e) => s + (e.timeSpentSeconds ?? 0), 0);
        const avgTime = uniqueBuyerIds.size > 0 ? Math.round(totalTime / uniqueBuyerIds.size) : 0;

        // Last activity
        const lastEvent = events.length > 0
          ? events.sort((a, b) => new Date(b.createdAt!).getTime() - new Date(a.createdAt!).getTime())[0]
          : null;

        return {
          dealId: deal.id,
          businessName: deal.businessName,
          industry: deal.industry,
          phase: deal.phase,
          isLive: deal.isLive,
          totalViews: views,
          uniqueBuyers: uniqueBuyerIds.size,
          avgTimePerBuyer: avgTime,
          totalQuestions: questions.length,
          ndaSigned: buyers.filter(b => b.ndaSignedAt).length,
          activeBuyers: buyers.filter(b => !b.revokedAt && (!b.expiresAt || new Date(b.expiresAt) > new Date())).length,
          lastActivity: lastEvent?.createdAt ?? null,
        };
      }));

      // Only include deals that are live or have any analytics events
      const relevant = comparison.filter((d: any) => d.isLive || d.totalViews > 0);
      res.json(relevant.sort((a: any, b: any) => b.totalViews - a.totalViews));
    } catch (error: any) {
      console.error("Error getting deals comparison:", error);
      res.status(500).json({ error: "Failed to get deals comparison" });
    }
  });

  // Buyer engagement scoring (for buyer comparison)
  app.get("/api/deals/:dealId/analytics/buyer-scores", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const { dealId } = req.params;
      const [events, buyers, questions] = await Promise.all([
        storage.getAnalyticsByDeal(dealId),
        storage.getBuyerAccessByDeal(dealId),
        storage.getQuestionsByDeal(dealId),
      ]);

      const scores = buyers.map(buyer => {
        const buyerEvents = events.filter(e => e.buyerAccessId === buyer.id);
        const sectionExits = buyerEvents.filter(e => e.eventType === "section_exit" && e.timeSpentSeconds);
        const totalTime = sectionExits.reduce((s, e) => s + (e.timeSpentSeconds ?? 0), 0);
        const sectionsViewed = new Set(buyerEvents.filter(e => e.eventType === "section_enter" && e.sectionKey).map(e => e.sectionKey)).size;
        const maxScroll = Math.max(0, ...buyerEvents.filter(e => e.eventType === "scroll_depth").map(e => e.scrollDepthPercent ?? 0));
        const questionCount = questions.filter(q => q.buyerAccessId === buyer.id).length;
        // Sessions, not fetches — the same deduped count the Buyers tab shows
        // (buyerAccess.viewCount is stamped once per 30-minute session). Raw
        // view events only back-fill records from before the stamp existed.
        const rawViews = buyerEvents.filter(e => e.eventType === "view").length;
        const viewCount = buyer.viewCount != null && buyer.viewCount > 0 ? buyer.viewCount : rawViews;
        const ndaSigned = !!buyer.ndaSignedAt;

        // Engagement score (0-100): weighted composite
        // Time weight: 30, Scroll: 20, Sections: 20, Questions: 15, Return visits: 10, NDA: 5
        const timeScore = Math.min(totalTime / 300, 1) * 30;        // 5 min = full score
        const scrollScore = (maxScroll / 100) * 20;
        const sectionScore = Math.min(sectionsViewed / 10, 1) * 20;  // 10 sections = full
        const questionScore = Math.min(questionCount / 3, 1) * 15;   // 3 questions = full
        const returnScore = Math.min(Math.max((viewCount - 1) / 2, 0), 1) * 10; // 3 visits = full
        const ndaScore = ndaSigned ? 5 : 0;
        const engagementScore = Math.round(timeScore + scrollScore + sectionScore + questionScore + returnScore + ndaScore);

        // Intent signal
        let intent: "high" | "medium" | "low" | "minimal" = "minimal";
        if (engagementScore >= 65) intent = "high";
        else if (engagementScore >= 40) intent = "medium";
        else if (engagementScore >= 15) intent = "low";

        return {
          buyerId: buyer.id,
          buyerName: buyer.buyerName || "Unknown",
          buyerEmail: buyer.buyerEmail,
          status: buyer.revokedAt ? "revoked" : buyer.expiresAt && new Date(buyer.expiresAt) < new Date() ? "expired" : "active",
          ndaSigned,
          totalTimeSeconds: totalTime,
          sectionsViewed,
          maxScrollDepth: maxScroll,
          questionCount,
          viewCount,
          engagementScore,
          intent,
          lastSeen: buyer.lastAccessedAt,
          firstSeen: buyer.createdAt,
        };
      });

      scores.sort((a, b) => b.engagementScore - a.engagementScore);
      res.json(scores);
    } catch (error: any) {
      console.error("Error computing buyer scores:", error);
      res.status(500).json({ error: "Failed to compute buyer scores" });
    }
  });

  // ════════════════════════════════════════════════════════════
  // BUYER MATCHING — deep M&A criteria matching
  // ════════════════════════════════════════════════════════════

  // Run deep match scoring for all buyers on a deal
  app.post("/api/deals/:dealId/match-buyers", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const { dealId } = req.params;
      const deal = await storage.getDeal(dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });

      const buyers = await storage.getBuyerAccessByDeal(dealId);
      const latestFA = await storage.getLatestFinancialAnalysis(dealId);

      const { matchBuyerDealRow } = await import("./matching/match-run.js");
      const dealForMatch = {
        industry: deal.industry,
        subIndustry: deal.subIndustry,
        askingPrice: deal.askingPrice,
        description: deal.description ?? null,
        extractedInfo: (deal.extractedInfo || {}) as Record<string, any>,
        financialAnalysis: latestFA ? {
          reclassifiedPnl: latestFA.reclassifiedPnl,
          normalization: latestFA.normalization,
          workingCapital: latestFA.workingCapital,
        } : undefined,
      };
      // One buyer failing (odd criteria, an AI hiccup, a write error) never
      // fails the batch — that buyer comes back with an error instead.
      // A few buyers at a time: with AI on, each is a model call.
      const results = await mapWithConcurrency(buyers.filter((b: any) => !b.revokedAt), BULK_AI_CONCURRENCY, (buyer: any) =>
        matchBuyerDealRow(buyer, dealForMatch, {
          skipAI: req.query.skipAI === "true",
          persist: (id, patch) => storage.updateBuyerAccess(id, patch as any).then(() => undefined),
        }),
      );

      results.sort((a, b) => (b.matchScore ?? -1) - (a.matchScore ?? -1));
      res.json(results);
    } catch (error: any) {
      console.error("Error matching buyers:", error);
      res.status(500).json({ error: "Failed to match buyers" });
    }
  });

  // Update buyer profile and criteria
  app.patch("/api/buyers/:id/profile", requireBroker, async (req, res) => {
    try {
      const { id } = req.params;
      const existingAccess = await storage.getBuyerAccess(id);
      if (!existingAccess || !(await ownsDeal(req, existingAccess.dealId))) return res.status(404).json({ error: "Buyer access not found" });
      const { buyerType, prequalified, proofOfFunds, buyerNotes, buyerCriteria } = req.body;
      const updates: any = {};
      if (buyerType !== undefined) updates.buyerType = buyerType;
      if (prequalified !== undefined) updates.prequalified = prequalified;
      if (proofOfFunds !== undefined) updates.proofOfFunds = proofOfFunds;
      if (buyerNotes !== undefined) updates.buyerNotes = buyerNotes;
      if (buyerCriteria !== undefined) {
        updates.buyerCriteria = buyerCriteria;
        // A stored match score describes the *previous* criteria. Once the
        // criteria change it is stale, so clear it until the broker re-runs
        // the match rather than showing a number that no longer applies.
        const before = JSON.stringify(existingAccess.buyerCriteria ?? {});
        const after = JSON.stringify(buyerCriteria ?? {});
        if (before !== after) {
          updates.matchScore = null;
          updates.matchBreakdown = null;
        }
      }

      const updated = await storage.updateBuyerAccess(id, updates);
      if (!updated) return res.status(404).json({ error: "Buyer not found" });
      res.json(updated);
    } catch (error: any) {
      console.error("Error updating buyer profile:", error);
      res.status(500).json({ error: "Failed to update buyer profile" });
    }
  });

  // ════════════════════════════════════════════════════════════
  // PHASE 4 — CIM LAYOUT ENGINE
  // ════════════════════════════════════════════════════════════

  // Generate bespoke CIM layout for a deal
  app.post("/api/deals/:dealId/generate-layout", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const { dealId } = req.params;
      const deal = await storage.getDeal(dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });
      const openCritical = await blockingCriticalDiscrepancies(dealId);
      if (openCritical.length > 0) return discrepancyBlockResponse(res, openCritical, "generating the layout");
      // Enough information to write from? A completed interview, or a
      // readiness score of "Developing" or better from any mix of sources
      // (calls, CRM, documents, the Information tab) — the same rule the
      // Overview, CIM tab and builder show (shared/deal-progress).
      const infoGate = await checkCimGenerationGate(deal);
      if (!infoGate.allowed) {
        return res.status(409).json({ error: infoGate.reason, code: "needs_information", readiness: infoGate.readiness });
      }

      // Background job — see generation-jobs.ts. 202 now, progress via GET
      // /api/deals/:dealId/cim-generation.
      try {
        const job = await startCimGeneration(deal, "layout", { beforeWriting: (onChecking) => ensureDiscrepancyGate(dealId, onChecking) });
        return res.status(202).json({ started: true, job });
      } catch (err) {
        if (err instanceof CimGenerationRunningError) {
          return res.status(409).json({ error: "CIM generation is already running for this deal", job: err.job });
        }
        // The broker's hold on "Add-backs in the books" (gl spec §6.9).
        const glGate = await import("./gl/gate");
        if (glGate.isGlTraceRequiredError(err)) return res.status(409).json(glGate.glGateBody(err));
        throw err;
      }
    } catch (error: any) {
      console.error("Layout generation error:", error);
      res.status(500).json({ error: error.message || "Layout generation failed" });
    }
  });

  // ── Interview outline — what the interview will cover, editable in plain language ──
  const outlineView = (deal: any, extra: { evidenceBuilding?: boolean } = {}) => {
    const outline = getInterviewOutline(deal);
    const importance = getSectionImportance(deal);
    // Kick off the industry checklist if it's missing (background, ~20–40s).
    // The deal's own sub-industry counts: "Home Services" alone matches no
    // playbook, "Landscaping and snow & ice management" does.
    ensureInterviewPlan(deal);
    const plan = getInterviewPlan(deal);
    // (A build that just failed waits an hour before retrying — don't spin meanwhile.)
    const lastBuildFailed = (deal.interviewPlan as { status?: string } | null)?.status === "failed";
    const playbookMatches = planSubIndustry(deal).matched && !lastBuildFailed;
    // Data points per section with on-file status — the same coverage the
    // interview and the quality score use (excluded sections kept here so a
    // removed section still shows what it would have covered).
    // (Items a source or an earlier session already answers show as on file,
    // with where — the interview won't ask them.)
    const onFile: Record<string, { answer: string; source: string; partial?: boolean; missing?: string }> = {};
    for (const [id, e] of Object.entries(storedEvidence(deal)?.entries ?? {})) {
      if (id.startsWith("field:")) onFile[id.slice(6)] = { answer: e.answer, source: e.source, ...(e.partial ? { partial: true, missing: e.missing } : {}) };
    }
    const adjustments = { ...coverageAdjustmentsForDeal(deal), onFile };
    const coverage = buildCoverageForOutline((deal.extractedInfo || {}) as any, undefined, importance, [], adjustments);
    const byKey = new Map(coverage.map((c) => [c.key, c]));
    // Every key that belongs to a section (generic + industry + broker-added),
    // with labels — used to list removed items under their section.
    const itemLabels = new Map<string, string>();
    for (const list of Object.values(adjustments.add ?? {})) for (const x of list) itemLabels.set(x.key, x.label);
    const sectionItemKeys = (sectionKey: string) =>
      new Set([...(SECTION_FIELD_MAP[sectionKey] ?? []), ...(adjustments.add?.[sectionKey] ?? []).map((x) => x.key)]);
    return {
      outline,
      plan: {
        status: plan ? "ready" : isPlanBuilding(deal.id) ? "building" : !deal.industry ? "no_industry" : playbookMatches ? "building" : "unavailable",
        // The playbook it came from ("Landscaping and snow…" rather than "Home Services").
        industry: plan ? (plan.subIndustry || plan.industry) : deal.industry ?? null,
        itemCount: plan?.items.length ?? 0,
        // A change to the checklist no broker made (new checklist rules).
        revision: plan?.revision ?? null,
      },
      // The file being read for answers already on file: the "on file"
      // count changes when it lands — said on the card, not a silent shift.
      evidence: {
        status: extra.evidenceBuilding || isEvidenceBuilding(deal.id) ? "building" : storedEvidence(deal) ? "ready" : "none",
        checkedAt: storedEvidence(deal)?.computedAt ?? null,
      },
      sections: CIM_SECTIONS.map((s) => ({
        key: s.key,
        title: s.title,
        order: s.order,
        importance: importance.sections[s.key]?.level ?? "important",
        importanceReason: importance.sections[s.key]?.reason ?? "",
        excluded: outline.excludedSections.includes(s.key),
        note: outline.emphasis.find((e) => e.key === s.key)?.note ?? null,
        items: (byKey.get(s.key)?.fields ?? []).map((f) => ({
          key: f.fieldName,
          label: f.label ?? fieldLabel(f.fieldName),
          onFile: f.value !== null,
          value: f.value ? String(f.value).slice(0, 140) : null,
          onFileIn: f.onFile ?? null,
          industrySpecific: !!f.industrySpecific,
          critical: !!f.critical,
          addedByBroker: (outline.addedItems ?? []).some((a) => a.key === f.fieldName),
        })),
        // Checklist items the broker removed from this section, so they can be restored.
        removedItems: (outline.removedItems ?? [])
          .filter((k) => sectionItemKeys(s.key).has(k))
          .map((k) => ({ key: k, label: itemLabels.get(k) ?? fieldLabel(k) })),
      })),
    };
  };
  app.get("/api/deals/:dealId/interview-outline", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const deal = await storage.getDeal(req.params.dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });
      // Review the sources for conflicts in the background, so the
      // interview can open on them. A no-op while the stored review matches
      // the current sources; a source added since gets reviewed now, before
      // the seller's next session.
      storage.getDocumentsByDeal(deal.id).then((docs) => ensureSourceReview(deal, docs)).catch(() => {});
      // …and what the file already answers among the interview's open items,
      // so the seller's next session never asks it (background; a no-op
      // while current). Started before the reply, so the card can say it is
      // reading the file (and poll) instead of its count shifting later.
      const evidenceRun = await startOnFileEvidenceBuild(deal.id).catch(() => null);
      res.json(outlineView(deal, { evidenceBuilding: !!evidenceRun }));
    } catch (error: any) {
      res.status(500).json({ error: "Failed to load interview outline" });
    }
  });
  // Turn a plain-language instruction into a concrete proposal (nothing is saved).
  app.post("/api/deals/:dealId/interview-outline/propose", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const instruction = typeof req.body?.instruction === "string" ? req.body.instruction.trim() : "";
      if (!instruction) return res.status(400).json({ error: "Tell Cimple what to change first" });
      const deal = await storage.getDeal(req.params.dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });
      res.json({ instruction, proposal: await proposeOutlineChanges(deal, instruction) });
    } catch (error: any) {
      console.error("[outline] propose failed:", error);
      res.status(500).json({ error: "Couldn't work out the change — try rephrasing" });
    }
  });
  // Apply a proposal the broker reviewed.
  app.post("/api/deals/:dealId/interview-outline/apply", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const { proposal, instruction } = req.body ?? {};
      if (!proposal || typeof proposal !== "object") return res.status(400).json({ error: "Nothing to apply" });
      const deal = await storage.getDeal(req.params.dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });
      await applyOutlineProposal(deal, proposal, typeof instruction === "string" ? instruction : "");
      res.json(outlineView(await storage.getDeal(deal.id)));
    } catch (error: any) {
      console.error("[outline] apply failed:", error);
      res.status(500).json({ error: "Couldn't apply the change" });
    }
  });
  // Direct edits without the agent: remove/restore a section, drop a topic, clear a note.
  app.patch("/api/deals/:dealId/interview-outline", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const deal = await storage.getDeal(req.params.dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });
      const { excludeSection, restoreSection, removeTopic, clearEmphasis, removeItem, restoreItem, removeItems, restoreItems, addItem } = req.body ?? {};
      // (The coverage board takes an item off with all its members at once —
      // removeItems — and adds a data point to a section — addItem.)
      const result = await patchOutline(deal, {
        excludeSection, restoreSection, removeTopic, clearEmphasis, removeItem, restoreItem,
        removeItems: Array.isArray(removeItems) ? removeItems.slice(0, 12) : undefined,
        restoreItems: Array.isArray(restoreItems) ? restoreItems.slice(0, 12) : undefined,
        addItem: addItem && typeof addItem === "object" ? { sectionKey: String(addItem.sectionKey ?? ""), label: String(addItem.label ?? "") } : undefined,
      });
      if (result.refused) return res.status(409).json({ error: result.refused });
      res.json(outlineView(await storage.getDeal(deal.id)));
    } catch (error: any) {
      res.status(500).json({ error: "Couldn't update the outline" });
    }
  });

  // CIM information quality for the deal — coverage weighted by section
  // importance, with the gaps holding the score down (see shared/cim-readiness).
  app.get("/api/deals/:dealId/cim-readiness", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const deal = await storage.getDeal(req.params.dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });
      // Same computation the CIM generation gate checks (cim/generation-gate).
      const { readiness, sections } = await computeDealReadiness(deal);
      res.json({
        readiness,
        sections: sections.map((s) => ({ key: s.key, title: s.title, status: s.status, importance: s.importance, importanceReason: s.importanceReason })),
      });
    } catch (error: any) {
      res.status(500).json({ error: "Failed to compute CIM readiness" });
    }
  });

  // Buyer importance of each CIM section for this deal. Computes the
  // industry ranking on demand when the deal has an industry but no ranking.
  app.get("/api/deals/:dealId/section-importance", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const deal = await storage.getDeal(req.params.dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });
      let map = getSectionImportance(deal);
      if (map.source === "base" && deal.industry) map = await computeSectionImportance(deal);
      res.json({
        ...map,
        sections: CIM_SECTIONS.map((s) => ({ key: s.key, title: s.title, order: s.order, ...map.sections[s.key] })),
      });
    } catch (error: any) {
      res.status(500).json({ error: "Failed to get section importance" });
    }
  });

  // Progress/result of the deal's CIM generation job (null if never run).
  app.get("/api/deals/:dealId/cim-generation", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      // Polled every 2s while running — answer from memory when a job is
      // live and only read the (large) deal row for the persisted record.
      const live = getLiveCimGenerationStatus(req.params.dealId);
      if (live) return res.json({ job: live });
      const deal = await storage.getDeal(req.params.dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });
      res.json({ job: getCimGenerationStatus(deal) });
    } catch (error: any) {
      res.status(500).json({ error: "Failed to get generation status" });
    }
  });

  // Live/recent generation jobs across the signed-in broker's deals — drives
  // the app-wide "CIM ready" notification wherever the broker is.
  app.get("/api/broker/cim-generation", requireBroker, (req, res) => {
    res.json({ jobs: listBrokerCimGeneration(req.session.brokerId!) });
  });

  // Get all CIM layout sections for a deal
  app.get("/api/deals/:dealId/layout", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const { dealId } = req.params;
      const sections = await storage.getCimSectionsByDeal(dealId);
      res.json(sections);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to get layout" });
    }
  });

  // Update a single CIM section (broker edit, format override, approve)
  // Whitelisted + validated (title, content, data, layout, visibility,
  // approval, access tier); content edits push an undo snapshot and refresh
  // the section's blind version — see server/cim/section-ops.ts.
  app.patch("/api/cim-sections/:sectionId", requireBroker, patchCimSection);

  // Reorder sections ({ order: [{ id, order }] }) — same rules as
  // /cim-sections/reorder: ids must belong to the deal, one transaction.
  app.post("/api/deals/:dealId/layout/reorder", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const order = Array.isArray(req.body?.order) ? req.body.order : null;
      if (!order || order.some((o: any) => !o || typeof o.id !== "string" || typeof o.order !== "number")) {
        return res.status(400).json({ error: "order must be a list of { id, order }" });
      }
      const orderedIds = [...order].sort((a: any, b: any) => a.order - b.order).map((o: any) => o.id);
      const result = await reorderDealSections(req.params.dealId, orderedIds);
      if (!result.ok) return res.status(result.status).json({ error: result.error });
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: "Failed to reorder sections" });
    }
  });

  // ════════════════════════════════════════════════════════════
  // DISCREPANCY RESOLUTION
  // ════════════════════════════════════════════════════════════

  // Run the check, list, resolve, link a resolution to its fact and carry
  // it through to other facts: server/routes/discrepancies.ts.
  registerDiscrepancyRoutes(app);

  // ════════════════════════════════════════════════════════════
  // DEAL TEAMS — Members, roles, notifications
  // ════════════════════════════════════════════════════════════

  // Get all members for a deal (grouped by team)
  app.get("/api/deals/:dealId/members", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const members = await storage.getDealMembers(req.params.dealId);
      res.json(members);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to get members" });
    }
  });

  // Get members by team type
  app.get("/api/deals/:dealId/members/:teamType", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const members = await storage.getDealMembersByTeam(req.params.dealId, req.params.teamType);
      res.json(members);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to get team members" });
    }
  });

  // Add a member to a deal
  app.post("/api/deals/:dealId/members", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const { dealId } = req.params;
      const { email, name, phone, teamType, role, accessLevel } = req.body;
      // notifyMember=false skips the "added to a deal" email — used when the
      // person already holds this deal's seller invite link (same link, so a
      // second email would only be noise).
      const notifyMember = req.body.notifyMember !== false;

      if (!email?.trim() || !teamType || !role) {
        return res.status(400).json({ error: "Email, team type, and role are required" });
      }

      // Check if member already exists
      const existing = await storage.getDealMemberByEmail(dealId, email.trim().toLowerCase());
      if (existing) {
        return res.status(409).json({ error: "This person is already on the deal" });
      }

      // Validate role for team type
      const teamRoles = (TEAM_ROLES as any)[teamType];
      if (!teamRoles) return res.status(400).json({ error: "Invalid team type" });
      const roleConfig = teamRoles[role];
      if (!roleConfig) return res.status(400).json({ error: "Invalid role for this team" });

      // A buyer-side seat reads like a buyer link (shared/access-levels.ts):
      // the Blind CIM unless the broker chose another level. Other teams
      // have no access level.
      let memberLevel: string | null = null;
      if (teamType === "buyer") {
        memberLevel = accessLevel == null || accessLevel === "" ? BLIND_ACCESS_LEVEL : parseAccessLevelInput(accessLevel);
        if (!memberLevel) return res.status(400).json({ error: ACCESS_LEVEL_INPUT_ERROR });
      }

      const inviteToken = crypto.randomUUID();
      const deal = await storage.getDeal(dealId);

      const member = await storage.createDealMember({
        dealId,
        email: email.trim().toLowerCase(),
        name: name || null,
        phone: phone || null,
        teamType,
        role,
        permissions: roleConfig.permissions as any,
        inviteToken,
        inviteStatus: "sent",
        invitedAt: new Date(),
        accessLevel: memberLevel,
        emailNotifications: true,
        smsNotifications: !!phone,
      } as any);

      // Send invite notification — honest about what the person gets.
      // Seller-team members get a real seller invite (the seller workspace).
      // Broker- and buyer-team members get email updates only: there is no
      // colleague sign-in or buyer access behind a team seat yet, so their
      // email promises neither (it used to send them to a login they had no
      // account for). A buyer-side person on a Blind deal never sees the
      // business's name.
      let actionUrl: string | undefined;
      if (teamType === "seller") {
        try {
          const sellerInvite = await findOrCreateSellerInvite(dealId, email.trim().toLowerCase(), name || null);
          actionUrl = `/seller/${sellerInvite.token}`;
        } catch (e) { console.warn("[members] could not create seller invite for team member:", e); }
      }
      if (notifyMember) {
        const copy = teamInviteCopy({
          teamType,
          roleLabel: roleConfig.label,
          businessName: deal?.businessName ?? null,
          blindCodename: deal?.blindCodename ?? null,
          accessLevel: member.accessLevel ?? null,
          hasSellerLink: !!actionUrl,
        });
        await notify(dealId, "invite", {
          title: copy.title,
          body: copy.body,
          actionUrl,
          businessName: copy.displayName,
          specificMemberIds: [member.id],
        });
      }

      res.json(member);
    } catch (error: any) {
      console.error("Error adding member:", error);
      res.status(500).json({ error: "Failed to add member" });
    }
  });

  // Update a member (role, permissions, notification prefs)
  app.patch("/api/members/:memberId", requireBroker, async (req, res) => {
    try {
      const existingMember = await storage.getDealMember(req.params.memberId);
      if (!existingMember || !(await ownsDeal(req, existingMember.dealId))) return res.status(404).json({ error: "Member not found" });
      // Whitelist — the previous pass-through allowed mass-assignment of any column
      const allowed = ["name", "phone", "role", "permissions", "accessLevel", "emailNotifications", "smsNotifications", "canDownload", "watermarkEnabled", "inviteStatus"] as const;
      const memberUpdates: Record<string, unknown> = {};
      for (const k of allowed) if (req.body?.[k] !== undefined) memberUpdates[k] = req.body[k];
      // Stored normalised (a stale tab may send a legacy value); only a buyer seat has a level.
      if (memberUpdates.accessLevel !== undefined) {
        if (existingMember.teamType !== "buyer") {
          if (memberUpdates.accessLevel !== null) return res.status(400).json({ error: "Only buyer-side team members have an access level" });
        } else {
          const level = parseAccessLevelInput(memberUpdates.accessLevel);
          if (!level) return res.status(400).json({ error: ACCESS_LEVEL_INPUT_ERROR });
          memberUpdates.accessLevel = level;
        }
      }
      // A role change must be a real role for this member's team, and it
      // carries that role's permissions with it (unless the caller set
      // permissions explicitly) — otherwise the badge changes but the
      // member keeps the old role's access.
      if (memberUpdates.role !== undefined) {
        const teamRoles = (TEAM_ROLES as any)[existingMember.teamType];
        const roleConfig = teamRoles?.[String(memberUpdates.role)];
        if (!roleConfig) return res.status(400).json({ error: "Invalid role for this team" });
        if (memberUpdates.permissions === undefined) memberUpdates.permissions = roleConfig.permissions;
      }
      const updated = await storage.updateDealMember(req.params.memberId, memberUpdates as any);
      if (!updated) return res.status(404).json({ error: "Member not found" });
      res.json(updated);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to update member" });
    }
  });

  // Remove a member
  app.delete("/api/members/:memberId", requireBroker, async (req, res) => {
    try {
      const existingMember = await storage.getDealMember(req.params.memberId);
      if (!existingMember || !(await ownsDeal(req, existingMember.dealId))) return res.status(404).json({ error: "Member not found" });
      // A seller-team member's own seller link stops working with them
      // (a removed bookkeeper could otherwise still open every financial).
      // The seller's own invite, if this was the seller, is left alone. The
      // confirm dialog shows the broker which case this is (the same
      // sellerLinkOnRemoval) and lets them keep a link they handed to the
      // seller: ?keepLink=1.
      const keepLink = req.query.keepLink === "1" || req.query.keepLink === "true";
      let linkRevoked = false;
      let link: SellerLinkOnRemoval = { kind: "none" };
      if (existingMember.teamType === "seller") {
        link = sellerLinkOnRemoval(existingMember, await storage.getSellerInvitesByDealId(existingMember.dealId));
        if (link.kind === "own_link" && !keepLink) {
          await storage.updateSellerInvite(link.inviteId, { status: REVOKED_INVITE_STATUS });
          linkRevoked = true;
        }
      }
      await storage.deleteDealMember(req.params.memberId);
      const linkOutcome =
        link.kind === "own_link" ? (linkRevoked ? "revoked" : "kept") : link.kind; // "seller_invite" | "none"
      res.json({ success: true, linkRevoked, linkOutcome });
    } catch (error: any) {
      res.status(500).json({ error: "Failed to remove member" });
    }
  });

  // Get notifications for a deal
  app.get("/api/deals/:dealId/notifications", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const notifs = await storage.getNotificationsByDeal(req.params.dealId);
      res.json(notifs);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to get notifications" });
    }
  });

  // Mark notification as read
  app.patch("/api/notifications/:id/read", requireBroker, async (req, res) => {
    try {
      const existingNotif = await storage.getNotification(req.params.id);
      if (!existingNotif || !(await ownsDeal(req, existingNotif.dealId))) return res.status(404).json({ error: "Notification not found" });
      await storage.markNotificationRead(req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: "Failed to mark as read" });
    }
  });

  // ════════════════════════════════════════════════════════════
  // PHASE 4 — BUYER Q&A
  // ════════════════════════════════════════════════════════════

  // Buyer submits a question
  app.post("/api/deals/:dealId/questions", async (req, res) => {
    try {
      const { dealId } = req.params;
      const { question, accessToken } = req.body;
      if (typeof question !== "string" || !question.trim()) return res.status(400).json({ error: "Question required" });
      // A question is a question: a page of text would ride into every
      // later model call (and was once shown to every other buyer).
      if (question.length > MAX_BUYER_QUESTION_CHARS) {
        return res.status(400).json({ error: `Please keep your question under ${MAX_BUYER_QUESTION_CHARS.toLocaleString("en-US")} characters.`, code: "question_too_long" });
      }
      // Reading analytics: the page the buyer was on (a section id they were
      // served) and the version — only well-formed ids, never text.
      const askedOn = {
        sectionId: typeof req.body?.sectionId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(req.body.sectionId) ? req.body.sectionId : null,
        renditionId: typeof req.body?.renditionId === "string" && /^[0-9a-f]{32}$/.test(req.body.renditionId) ? req.body.renditionId : null,
      };

      // The buyer proves access with their view-room token. Previously this
      // endpoint was unauthenticated and answered from the UNREDACTED CIM —
      // a blind-mode buyer could learn the business identity by asking.
      const access = typeof accessToken === "string" ? await storage.getBuyerAccessByToken(accessToken) : undefined;
      if (!access || access.dealId !== dealId || access.revokedAt || (access.expiresAt && new Date(access.expiresAt) < new Date())) {
        return res.status(401).json({ error: "A valid view-room link is required to ask questions" });
      }
      // A Teaser reader asks for the CIM, not questions about it (the answers
      // come from the CIM they can't see).
      if (isTeaserOnly(access.accessLevel)) return res.status(403).json({ code: "teaser_only", error: "Ask for the CIM first." });
      const deal = await storage.getDeal(dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });
      if (!dealPublishedForBuyers(deal)) return res.status(403).json(notPublishedBody());
      // Same NDA rule as the view room: nothing CIM-derived (answers or the
      // shared Q&A) before a required NDA is signed.
      if (ndaBlocksBuyer(deal, access)) {
        return res.status(403).json({ error: "Sign the NDA to ask questions about this business", code: "nda_required" });
      }
      const buyerAccessId = access.id;
      // Who may later read this answer: a Blind CIM buyer's answer → every
      // CIM buyer; a named-CIM answer (Full CIM, due diligence) → the asker only.
      const scope = askerScope(access.accessLevel);
      // An answer the AI gives on its own is the asker's alone: the buyer's
      // own words (who they are, their strategy, or text planted for other
      // bidders) never reach another buyer or the knowledge base without a
      // person approving them. The broker can share it from the Q&A tab
      // (it then counts as the broker's answer); escalated questions are
      // shared once the seller approves (shared/buyer-qa-scope.ts).
      const reader = { id: access.id, accessLevel: access.accessLevel };

      // The CIM this buyer gets now (their version, the sections they may
      // open, a live CIM's approved versions) — what earlier answers are
      // checked against and what a new answer is written from. The SAME
      // version of the CIM the buyer is allowed to see: Blind buyers get the
      // redacted overrides; if redaction hasn't run yet, escalate rather than
      // leak identity. Structured layoutData (metric grids, location cards,
      // financial tables, two-column blocks) carries most of the facts in a
      // bespoke CIM, so it is flattened into the context alongside the prose
      // — otherwise "what is the monthly rent?" escalated even though the
      // Facility section shows it. Same authority as the view room
      // (shared/cim-buyer-view.ts): hidden and not-yet-redacted sections
      // never feed the answer. A CIM held for
      // the broker's review answers nothing, not even from earlier answers
      // (it escalates).
      // (While a regenerated CIM waits for review, the kept copy buyers read
      // — published-snapshot.ts buyerCimRows — with the codename it was
      // redacted under; a kept copy that isn't there answers nothing.)
      let held = cimHeldFromBuyers(deal);
      let chatBaseSections: Array<{ updatedAt?: Date | string | null }> = [];
      let chatSections: ReturnType<typeof buildBuyerCim>["sections"] = [];
      // A question asked from a figure's note (dd, D18): the figure's opaque
      // id, resolved below against this buyer's own version — a blind buyer
      // can't probe the named figures. It goes straight to the broker.
      const { figureIdOf, figureQuestionText } = await import("./cim/figures/ask");
      const figureId = figureIdOf(req.body);
      let chatLayer: ReturnType<typeof buildBuyerCim>["figureLayer"] = null;
      if (!held) {
        const { buyerCimRows, servedBlindCodename } = await import("./cim/published-snapshot");
        const [chatRows, chatMedia, chatCodename] = await Promise.all([
          buyerCimRows(deal, access.accessLevel),
          loadMediaAssets(dealId),
          servedBlindCodename(deal),
        ]);
        if (chatRows.missing) {
          held = true;
        } else {
          chatBaseSections = chatRows.sections;
          const chatDeal = chatCodename ? { ...deal, blindCodename: chatCodename } : deal;
          // One extras helper for every buyer path (INTEGRATION §2.2): gl's add-back evidence, and
          // dd's figure layer — a question about a figure resolves against this buyer's own layer,
          // and its approved notes join the answer context (so answers agree with the notes; P2).
          // A failure leaves the extras out; the CIM still answers.
          const chatExtras = await buyerCimExtras(chatDeal, access.accessLevel, access.id).catch(() => null);
          const chatCim = buildBuyerCim({ deal: chatDeal, accessLevel: access.accessLevel, sections: chatRows.sections, overrides: chatRows.overrides, media: chatMedia, askingPrice: listedAskingPrice(deal), published: chatRows.published, ...(chatExtras ?? {}) });
          chatSections = chatCim.sections.filter((s) => s.layoutType !== "dd_source_check");
          chatLayer = chatCim.figureLayer;
        }
      }
      const figureText = figureQuestionText(chatLayer, chatSections, figureId, question, MAX_BUYER_QUESTION_CHARS);
      if (figureText) {
        // No AI: the broker answers, privately to this buyer (as today).
        const text = figureText;
        const saved = await storage.createBuyerQuestion({
          dealId, buyerAccessId, question: text, aiAnswer: null, status: "pending_broker", isPublished: false,
          publishedAnswer: null, addedToKnowledgeBase: false, answerScope: scope, ...askedOn,
        } as any);
        storage.createAnalyticsEvent({
          dealId, buyerAccessId, eventType: "question_asked", sectionKey: null, pageId: askedOn.sectionId,
          eventData: { question: text.slice(0, 200), figure: true },
        } as any).catch(() => {});
        notify(dealId, "buyer_question", {
          title: "New buyer question needs your response",
          body: `A buyer asked: &ldquo;${escapeHtml(text.slice(0, 100))}${text.length > 100 ? "..." : ""}&rdquo;`,
          actionUrl: `/deal/${dealId}`,
          businessName: deal.businessName,
        }).catch(() => {});
        return res.json({ id: saved.id, answer: null, status: "pending_broker", message: "Sent to the broker. The answer will appear in Questions." });
      }
      const answerSections: AnswerSection[] = chatSections
        .filter(s => !s.locked)
        .map(s => ({
          title: s.sectionTitle,
          body: s.brokerEditedContent || s.aiDraftContent || "",
          layoutType: s.layoutType,
          layoutData: s.layoutData,
        }));
      // DD overrides carry [[dd]] highlight sentinels for the renderer — plain text for the model.
      const { figureNotesContext } = await import("./cim/figures/qa-context");
      const cimText = stripDdMarkers(buildAnswerContext(answerSections)) + figureNotesContext(chatLayer, chatSections);
      const changedAt = chatBaseSections.reduce<Date | null>((m, s) => (s.updatedAt && (!m || new Date(s.updatedAt) > m) ? new Date(s.updatedAt) : m), null);

      // 1. a published answer this buyer may read (scope + identity check —
      // a Blind CIM buyer never gets a named-CIM answer; an AI
      // answer nobody reviewed is reused only while it still holds for this
      // CIM — qa/cim-context answerStillHolds — never after the CIM changed,
      // and never from a held CIM);
      // 2. the CIM the buyer can see; 3. the broker. Each AI step fails soft
      // (server/buyers/question-answer.ts): an AI outage forwards the
      // question to the broker instead of losing it.
      const result = await answerBuyerQuestion({
        question,
        published: held ? [] : await publishedQuestionsFor(deal, reader, { text: cimText, changedAt, held }),
        ask: async ({ system, user, maxTokens }) => {
          const r = await anthropic.messages.create({ model: "claude-sonnet-4-5", max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] });
          return r.content[0]?.type === "text" ? r.content[0].text : "";
        },
        loadCimText: async () => cimText,
      });

      const needsEscalation = result.kind === "escalate";
      const aiAnswer = result.kind === "escalate" ? null : result.answer;

      // Answered for the asker only (see above). answer_scope still records
      // what fed the answer, for when a person shares it later.
      const saved = await storage.createBuyerQuestion({
        dealId,
        buyerAccessId: buyerAccessId || null,
        question,
        aiAnswer,
        status: needsEscalation ? "pending_broker" : "published",
        isPublished: false,
        publishedAnswer: needsEscalation ? null : aiAnswer,
        addedToKnowledgeBase: false,
        answerScope: scope,
        ...(result.kind === "knowledge_base" ? { similarQuestionIds: result.matchedId ? [result.matchedId] : [] } : {}),
        ...askedOn,
      } as any);
      // Counted only once the question exists (a lost question used to be counted).
      storage.createAnalyticsEvent({
        dealId, buyerAccessId, eventType: "question_asked", sectionKey: null, pageId: askedOn.sectionId,
        eventData: { question: String(question).slice(0, 200) },
      } as any).catch(() => {});

      // Notify broker when question needs manual response
      if (needsEscalation) {
        notify(dealId, "buyer_question", {
          title: "New buyer question needs your response",
          body: `A buyer asked: &ldquo;${escapeHtml(question.slice(0, 100))}${question.length > 100 ? "..." : ""}&rdquo;`,
          actionUrl: `/deal/${dealId}`,
          businessName: deal.businessName,
        }).catch(() => {});
      }

      res.json({
        id: saved.id,
        answer: aiAnswer,
        status: needsEscalation ? "pending_broker" : "published",
        message: needsEscalation ? "Forwarded to your broker." : aiAnswer,
        ...(result.kind === "knowledge_base" ? { fromKnowledgeBase: true } : {}),
      });
    } catch (error: any) {
      console.error("[buyer-qa] Failed to process question:", error);
      res.status(500).json({ error: "Failed to process question" });
    }
  });

  // Get published Q&A for a deal (buyer-facing)
  app.get("/api/deals/:dealId/questions/published", async (req, res) => {
    try {
      const { dealId } = req.params;
      const tok = (req.headers["x-buyer-token"] as string | undefined) || (typeof req.query.token === "string" ? req.query.token : undefined);
      const access = tok ? await storage.getBuyerAccessByToken(tok) : undefined;
      if (!access || access.dealId !== dealId || access.revokedAt || (access.expiresAt && new Date(access.expiresAt) < new Date())) return res.status(401).json({ error: "A valid view-room link is required" });
      // A Teaser link reads no Q&A (the answers come from the CIM).
      if (isTeaserOnly(access.accessLevel)) return res.json([]);
      const deal = await storage.getDeal(dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });
      if (!dealPublishedForBuyers(deal)) return res.status(403).json(notPublishedBody());
      // Same NDA rule as the view room, which withholds this feed too.
      if (ndaBlocksBuyer(deal, access)) {
        return res.status(403).json({ error: "Sign the NDA to see questions and answers", code: "nda_required" });
      }
      // Published answers this buyer may read plus their own questions, so
      // the chat survives a reload and the poll can pick up the broker's answer.
      res.json(await buildBuyerQuestionFeed(deal, { id: access.id, accessLevel: access.accessLevel }));
    } catch (error: any) {
      res.status(500).json({ error: "Failed to get questions" });
    }
  });

  // Where a "send to seller for approval" would be emailed right now. When
  // the deal has no seller team member the UI must ask the broker to confirm
  // the invite address (and suggest adding a seller team member) — never
  // silently mail a real seller.
  app.get("/api/deals/:dealId/qa-approval-routing", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      res.json(await previewRecipients(req.params.dealId, "qa_needs_approval"));
    } catch (error: any) {
      res.status(500).json({ error: "Failed to check approval routing" });
    }
  });

  // Get all questions for broker dashboard
  app.get("/api/deals/:dealId/questions", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const { dealId } = req.params;
      const questions = await storage.getQuestionsByDeal(dealId);
      res.json(questions);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to get questions" });
    }
  });

  // Broker drafts/updates answer — generates approval token when sending to seller
  app.patch("/api/questions/:questionId", requireBroker, async (req, res) => {
    try {
      const { questionId } = req.params;
      const existingQ = await storage.getBuyerQuestion(questionId);
      if (!existingQ || !(await ownsDeal(req, existingQ.dealId))) return res.status(404).json({ error: "Question not found" });
      const { brokerDraft, status, publishedAnswer, isPublished } = req.body;

      const updates: Record<string, any> = {};
      if (brokerDraft !== undefined) updates.brokerDraft = brokerDraft;
      if (status !== undefined) updates.status = status;
      if (publishedAnswer !== undefined) updates.publishedAnswer = publishedAnswer;
      if (isPublished !== undefined) updates.isPublished = isPublished;
      // Data room (vdr spec §9.9): a question about a document stays with the
      // buyer who asked ("private") unless the broker shows it to the
      // document's other readers ("room") — never "all".
      const vdrShare = typeof req.body?.shareWithDocumentReaders === "boolean" ? req.body.shareWithDocumentReaders : undefined;
      if (existingQ.vdrItemId) {
        const { vdrAnswerScope } = await import("@shared/buyer-qa-scope");
        updates.answerScope = vdrAnswerScope(existingQ.answerScope, vdrShare);
      }
      // Published by the broker on purpose → for every buyer (a Blind buyer
      // still never sees it if it names the business — buyer-qa-scope.ts).
      if (isPublished === true) {
        // (A data-room question keeps the scope set above — never "all".)
        if (!existingQ.vdrItemId) updates.answerScope = "all";
        // Sharing an AI answer makes it the broker's answer: recorded as
        // their draft, which is what lets other buyers read it
        // (approvedForSharing in shared/buyer-qa-scope.ts) — and it no
        // longer counts as an unreviewed AI answer (qa/cim-context
        // isUnreviewedAiAnswer / endorsedDraftOnPublish).
        const adopted = (typeof brokerDraft === "string" && brokerDraft.trim()) || existingQ.brokerDraft
          || (typeof publishedAnswer === "string" && publishedAnswer.trim()) || existingQ.publishedAnswer || existingQ.aiAnswer;
        if (!adopted) return res.status(400).json({ error: "There is no answer to share yet" });
        // Only on a published answer: a draft on a question back with the
        // broker reads as "sent back by the seller" (endorsedDraftOnPublish).
        const effectiveStatus = typeof status === "string" ? status : existingQ.status;
        if (effectiveStatus === "published" && !existingQ.brokerDraft && brokerDraft === undefined) updates.brokerDraft = adopted;
        if (!existingQ.publishedAnswer && publishedAnswer === undefined) updates.publishedAnswer = adopted;
        // A data-room answer feeds the knowledge base only when shown to the document's readers.
        updates.addedToKnowledgeBase = existingQ.vdrItemId ? updates.answerScope === "room" : true;
      } else if (existingQ.vdrItemId) {
        updates.addedToKnowledgeBase = updates.answerScope === "room" && !!existingQ.isPublished && isPublished !== false;
      }

      // Generate approval token when sending to seller
      if (status === "pending_seller") {
        updates.sellerApprovalToken = crypto.randomUUID();
      }

      const updated = await storage.updateBuyerQuestion(questionId, updates as any);

      // Published by the broker → the buyer who asked is told (once).
      if (answerNoticeDue(existingQ, updated)) {
        void notifyBuyerQuestionAnswered(updated!, process.env.APP_URL || `${req.protocol}://${req.get("host")}`);
      }

      // Notify the seller when a question needs approval. Awaited so the
      // broker learns whether anyone actually received the link — when the
      // seller team has no owner/representative, notify() falls back to the
      // seller invite email; if even that is missing, the response says so
      // and the broker must share the approval link by hand.
      let sellerNotified: boolean | undefined;
      let sellerNotifiedVia: string | undefined;
      if (status === "pending_seller" && updated) {
        const deal = await storage.getDeal(updated.dealId);
        try {
          const result = await notify(updated.dealId, "qa_needs_approval", {
            title: "A buyer question needs your approval",
            body: `Question: &ldquo;${escapeHtml(updated.question.slice(0, 100))}${updated.question.length > 100 ? "..." : ""}&rdquo;`,
            actionUrl: `/approve/${updated.sellerApprovalToken}`,
            businessName: deal?.businessName,
          });
          sellerNotified = result.recipients > 0;
          sellerNotifiedVia = result.via;
        } catch {
          sellerNotified = false;
        }
      }

      res.json({
        ...updated,
        approvalLink: updated?.sellerApprovalToken
          ? `/approve/${updated.sellerApprovalToken}`
          : undefined,
        sellerNotified,
        sellerNotifiedVia,
      });
    } catch (error: any) {
      res.status(500).json({ error: "Failed to update question" });
    }
  });

  // ── Seller approval via token (no login required) ──

  // Get question details by approval token
  app.get("/api/approve/:token", async (req, res) => {
    try {
      const questions = await storage.getQuestionsByApprovalToken(req.params.token);
      if (!questions) return res.status(404).json({ error: "Invalid or expired approval link" });

      const deal = await storage.getDeal(questions.dealId);
      res.json({
        question: questions,
        businessName: deal?.businessName || "Unknown",
      });
    } catch (error: any) {
      res.status(500).json({ error: "Failed to load approval" });
    }
  });

  // Seller approves or rejects via token
  app.post("/api/approve/:token", async (req, res) => {
    try {
      const question = await storage.getQuestionsByApprovalToken(req.params.token);
      if (!question) return res.status(404).json({ error: "Invalid or expired approval link" });
      if (question.status !== "pending_seller") {
        return res.status(400).json({ error: "This question has already been processed" });
      }

      const { approved, revision } = req.body;

      if (approved) {
        const publishedAnswer = revision || question.brokerDraft || question.aiAnswer || "";
        // A data-room question keeps the scope the broker chose ("private" / "room", vdr §9.9).
        const { approvalScope } = await import("@shared/buyer-qa-scope");
        const published = await storage.updateBuyerQuestion(question.id, {
          sellerApproved: true,
          sellerApprovedAt: new Date(),
          status: "published",
          isPublished: true,
          publishedAnswer,
          ...approvalScope(question),
        } as any);
        if (answerNoticeDue(question, published)) {
          void notifyBuyerQuestionAnswered(published!, process.env.APP_URL || `${req.protocol}://${req.get("host")}`);
        }
        res.json({ success: true, status: "published" });
      } else {
        await storage.updateBuyerQuestion(question.id, {
          sellerApproved: false,
          status: "pending_broker",
        } as any);
        // The broker must hear about a send-back — the pending_seller
        // transition notifies, but a rejection silently reappeared as a new
        // escalation with no reason attached.
        try {
          const dealForNotify = await storage.getDeal(question.dealId);
          await notify(question.dealId, "buyer_question", {
            title: "Seller sent a Q&A answer back for revision",
            body:
              `The seller asked for changes to the answer for: &ldquo;${escapeHtml(String(question.question).slice(0, 120))}&rdquo;` +
              (revision ? ` — their note: &ldquo;${escapeHtml(String(revision).slice(0, 200))}&rdquo;` : ""),
            actionUrl: `/deal/${question.dealId}/qa`,
            businessName: dealForNotify?.businessName,
          });
        } catch (e) {
          console.warn("[approve] send-back notification failed:", e);
        }
        res.json({ success: true, status: "sent_back" });
      }
    } catch (error: any) {
      res.status(500).json({ error: "Failed to process approval" });
    }
  });

  // Legacy ID-based seller approve (for in-app use)
  app.post("/api/questions/:questionId/seller-approve", requireBroker, async (req, res) => {
    try {
      const { questionId } = req.params;
      const existingQ = await storage.getBuyerQuestion(questionId);
      if (!existingQ || !(await ownsDeal(req, existingQ.dealId))) return res.status(404).json({ error: "Question not found" });
      const { approved, revision } = req.body;

      if (approved) {
        // A data-room question keeps the scope the broker chose ("private" / "room", vdr §9.9).
        const { approvalScope } = await import("@shared/buyer-qa-scope");
        const question = await storage.updateBuyerQuestion(questionId, {
          sellerApproved: true,
          sellerApprovedAt: new Date(),
          status: "published",
          isPublished: true,
          publishedAnswer: revision || undefined,
          ...approvalScope(existingQ),
        } as any);

        if (!question) return res.status(404).json({ error: "Question not found" });

        if (!revision && question.brokerDraft && !question.publishedAnswer) {
          await storage.updateBuyerQuestion(questionId, {
            publishedAnswer: question.brokerDraft,
          } as any);
        }
        if (answerNoticeDue(existingQ, question)) {
          void notifyBuyerQuestionAnswered(question, process.env.APP_URL || `${req.protocol}://${req.get("host")}`);
        }
        res.json({ success: true, question });
      } else {
        const updated = await storage.updateBuyerQuestion(questionId, {
          sellerApproved: false,
          status: "pending_broker",
        } as any);
        res.json({ success: true, question: updated });
      }
    } catch (error: any) {
      res.status(500).json({ error: "Failed to process seller approval" });
    }
  });

  // Get pending seller approval questions for a deal
  app.get("/api/deals/:dealId/questions/pending-seller", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const questions = await storage.getQuestionsByDeal(req.params.dealId);
      const pending = questions.filter(q => q.status === "pending_seller");
      res.json(pending);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to get pending questions" });
    }
  });

  // ════════════════════════════════════════════════════════════
  // PHASE 4 — ANALYTICS (heat map + section events)
  // ════════════════════════════════════════════════════════════

  // Batch analytics events (client sends batches every 5s)
  app.post("/api/deals/:dealId/analytics/batch", async (req, res) => {
    try {
      const { dealId } = req.params;
      const { events } = req.body as {
        events: Array<{
          eventType: string;
          sectionKey?: string;
          timeSpentSeconds?: number;
          scrollDepthPercent?: number;
          heatMapX?: number;
          heatMapY?: number;
          viewportWidth?: number;
          viewportHeight?: number;
          elementId?: string;
          buyerAccessId?: string;
          eventData?: Record<string, unknown>;
        }>;
      };

      // Authenticate with the buyer's view-room token; attribute every event
      // to THAT access row (never a caller-supplied id); validate types; cap size.
      const batchToken = (req.body as any)?.accessToken;
      const batchAccess = typeof batchToken === "string" ? await storage.getBuyerAccessByToken(batchToken) : undefined;
      if (!batchAccess || batchAccess.dealId !== dealId || viewLinkProblem(batchAccess)) return res.status(401).json({ error: "Invalid access token" });
      // Nothing from a Teaser link is CIM analytics (the teaser page sends only the reading tracker).
      if (isTeaserOnly(batchAccess.accessLevel)) return res.json({ received: 0 });
      const batchDeal = await storage.getDeal(dealId);
      if (!dealPublishedForBuyers(batchDeal)) return res.status(403).json(notPublishedBody());
      // Nothing is recorded before a required NDA is signed (the old client
      // sampled the NDA form too).
      if (ndaBlocksBuyer(batchDeal!, batchAccess)) return res.json({ received: 0 });
      // The old tracker (replaced by POST /api/view/:token/reading) is still
      // accepted from cached tabs until LEGACY_BATCH_UNTIL; after that only
      // the few events nothing else records.
      const LEGACY_BATCH_UNTIL = Date.parse("2026-10-13T00:00:00Z");
      const ALLOWED_EVENTS = new Set(Date.now() < LEGACY_BATCH_UNTIL
        ? ["view", "page_view", "section_enter", "section_exit", "scroll", "scroll_depth", "heat_map_sample", "element_hover", "download_attempt", "time_on_page", "nav_click"]
        : ["view", "download_attempt"]);
      if (!Array.isArray(events)) return res.status(400).json({ error: "events must be an array" });
      const accepted = events.filter(e => e && ALLOWED_EVENTS.has(String(e.eventType))).slice(0, 200);
      // Blind views send neutral section keys (s_<id>); record the real key
      // so section analytics and the learning loop line up across versions.
      await translateBlindSectionKeys(dealId, accepted);

      for (const event of accepted) {
        await storage.createAnalyticsEvent({
          dealId,
          buyerAccessId: batchAccess.id,
          eventType: event.eventType,
          sectionKey: event.sectionKey || null,
          timeSpentSeconds: event.timeSpentSeconds || null,
          scrollDepthPercent: event.scrollDepthPercent || null,
          heatMapX: event.heatMapX ?? null,
          heatMapY: event.heatMapY ?? null,
          viewportWidth: event.viewportWidth ?? null,
          viewportHeight: event.viewportHeight ?? null,
          elementId: event.elementId || null,
          eventData: event.eventData || null,
          // No raw network address or user agent on new rows.
          ipAddress: null,
          userAgent: null,
        } as any);
      }

      res.json({ received: events.length });

      // Fire-and-forget: aggregate section_exit events into engagementInsights
      aggregateEngagementInsights(dealId, accepted, storage).catch(err =>
        console.warn("[learning-loop] aggregation error:", err)
      );
    } catch (error: any) {
      res.status(500).json({ error: "Failed to record events" });
    }
  });

  // ── Workstream route modules (merge anchors — each workstream fills its own file) ──
  registerDealListRoutes(app);
  registerInformationRoutes(app);
  registerCrmSellerRoutes(app);
  registerBuyerProfileRoutes(app);
  registerCimBuilderRoutes(app);
  registerCimHeldPrivateRoutes(app);
  registerCimMediaRoutes(app);
  registerCimTemplateRoutes(app);
  registerBuyerNdaRoutes(app);
  registerSellerReviewRoutes(app);
  // Buyer reading analytics v2 (shared/analytics-v2.ts): capture → broker
  // engagement APIs (capture stream) and cross-deal insights (intelligence stream).
  registerReadingRoutes(app);
  registerEngagementRoutes(app);
  registerEngagementInsightRoutes(app);
  registerAnalyticsDashboardRoutes(app);
  registerAnalyticsExtraSources(); // teaser's and vdr's activity + heads-up lines, INTEGRATION §2.9
  registerTogetherRoutes(app);
  registerTeaserRoutes(app, { grant: (request, deal, baseUrl, review, opts) => grantApprovedBuyer(request as any, deal, baseUrl, review, opts) });
  // Data room (vdr): the broker's room + the renderer canary (GET /api/vdr/health), then the buyer's room.
  registerDataRoomRoutes(app);
  registerDataRoomBuyerRoutes(app);
  // Add-backs in the books (gl): ledgers, traces, the seller's books page.
  registerGlRoutes(app);
  // gl × the data room: ledger status changes re-prepare room items; the room's per-buyer deny reaches gl's DD page.
  await registerGlDataRoomWiring();
  // Notes on the CIM's figures + the due-diligence checks (dd).
  registerFigureRoutes(app);

  const httpServer = createServer(app);
  return httpServer;
}
