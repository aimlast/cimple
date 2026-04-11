import { sql } from "drizzle-orm";
import { pgTable, text, varchar, jsonb, timestamp, integer, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// =====================
// USER & AUTH
// =====================
export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
  role: text("role").notNull().default("broker"), // broker, seller, buyer
  email: text("email"),
  name: text("name"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;

// =====================
// DEALS - Main entity tracking business through all phases
// =====================
export const deals = pgTable("deals", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  brokerId: varchar("broker_id").notNull(),
  sellerId: varchar("seller_id"),
  
  // Business info
  businessName: text("business_name").notNull(),
  industry: text("industry").notNull(),
  subIndustry: text("sub_industry"),
  description: text("description"),
  
  // Deal lifecycle phase
  phase: text("phase").notNull().default("phase1_info_collection"),
  // Phases: phase1_info_collection, phase2_platform_intake, phase3_content_creation, phase4_design_finalization
  status: text("status").notNull().default("draft"),
  // Status within phase: draft, in_progress, pending_review, approved, completed
  
  // Phase 1 data
  ndaSigned: boolean("nda_signed").default(false),
  ndaSignedAt: timestamp("nda_signed_at"),
  sqCompleted: boolean("sq_completed").default(false),
  valuationCompleted: boolean("valuation_completed").default(false),
  askingPrice: text("asking_price"),
  engagementSent: boolean("engagement_sent").default(false),
  
  // Phase 2 data - Seller questionnaire responses
  questionnaireData: jsonb("questionnaire_data"),
  // EQ profiler — Seller Communication Profile (generated pre-interview, broker-editable)
  sellerProfile: jsonb("seller_profile"),
  // Operational systems info
  operationalSystems: jsonb("operational_systems"), // accounting, CRM, ERP, POS systems
  employeeChart: jsonb("employee_chart"), // employee list with roles
  
  // Public data scrape
  websiteUrl: text("website_url"),
  scrapedAt: timestamp("scraped_at"),
  scrapedData: jsonb("scraped_data"),   // Unverified public data — confirmed during AI interview
  scrapeSource: text("scrape_source"),  // "website" | "internet_search" | "website_and_internet"

  // AI Interview extracted info
  extractedInfo: jsonb("extracted_info"),
  interviewCompleted: boolean("interview_completed").default(false),
  
  // Phase 3 - CIM Content
  cimContent: jsonb("cim_content"), // AI-generated content by section
  contentApprovedByBroker: boolean("content_approved_broker").default(false),
  contentApprovedBySeller: boolean("content_approved_seller").default(false),
  
  // Phase 4 - Design
  designTemplateId: varchar("design_template_id"),
  cimDesignData: jsonb("cim_design_data"),
  designApprovedByBroker: boolean("design_approved_broker").default(false),
  designApprovedBySeller: boolean("design_approved_seller").default(false),

  // CIM layout manifest (bespoke, AI-generated)
  cimLayoutGeneratedAt: timestamp("cim_layout_generated_at"),
  cimLayoutVersion: integer("cim_layout_version").default(0),

  // Buyer access settings
  ndaRequired: boolean("nda_required").default(true),
  watermarkText: text("watermark_text"), // custom watermark; defaults to buyer name

  // Final CIM
  finalCimUrl: text("final_cim_url"),
  teaserUrl: text("teaser_url"),
  isLive: boolean("is_live").default(false),
  
  // Metadata
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertDealSchema = createInsertSchema(deals).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertDeal = z.infer<typeof insertDealSchema>;
export type Deal = typeof deals.$inferSelect;

// =====================
// DOCUMENTS - Categorized document storage
// =====================
export const documents = pgTable("documents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  dealId: varchar("deal_id").notNull(),
  uploadedBy: varchar("uploaded_by").notNull(),
  
  name: text("name").notNull(),
  originalName: text("original_name").notNull(),
  category: text("category").notNull(), // financials, legal, marketing, operations, minutebook, other
  subcategory: text("subcategory"), // pnl, balance_sheet, tax_returns, contracts, etc.
  
  fileUrl: text("file_url").notNull(),
  fileSize: integer("file_size"),
  mimeType: text("mime_type"),
  
  // AI processing
  isProcessed: boolean("is_processed").default(false),
  extractedText: text("extracted_text"),
  extractedData: jsonb("extracted_data"),
  
  // Document status
  status: text("status").notNull().default("pending"), // pending, processing, processed, failed
  isRequired: boolean("is_required").default(false),
  promisedAt: timestamp("promised_at"), // when seller promised to provide
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertDocumentSchema = createInsertSchema(documents).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertDocument = z.infer<typeof insertDocumentSchema>;
export type Document = typeof documents.$inferSelect;

// =====================
// TASKS - Outstanding items, follow-ups, skipped questions
// =====================
export const tasks = pgTable("tasks", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  dealId: varchar("deal_id").notNull(),
  assignedTo: varchar("assigned_to"), // seller_id or broker_id
  createdBy: varchar("created_by").notNull(),
  
  type: text("type").notNull(), // document_request, follow_up, skipped_question, broker_authorization
  title: text("title").notNull(),
  description: text("description"),
  
  // For skipped questions
  relatedField: text("related_field"),
  aiAttempts: integer("ai_attempts").default(0),
  aiExplanation: text("ai_explanation"),
  
  // Status
  status: text("status").notNull().default("pending"), // pending, in_progress, completed, authorized_skip
  priority: text("priority").notNull().default("medium"), // low, medium, high, critical
  
  // Broker authorization
  requiresBrokerAuth: boolean("requires_broker_auth").default(false),
  brokerAuthorized: boolean("broker_authorized"),
  brokerAuthAt: timestamp("broker_auth_at"),
  brokerNotes: text("broker_notes"),
  
  dueAt: timestamp("due_at"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertTaskSchema = createInsertSchema(tasks).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertTask = z.infer<typeof insertTaskSchema>;
export type Task = typeof tasks.$inferSelect;

// =====================
// INTERVIEW SESSIONS - Track AI conversations
// =====================
export const interviewSessions = pgTable("interview_sessions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  dealId: varchar("deal_id").notNull(),
  participantId: varchar("participant_id").notNull(),
  
  messages: jsonb("messages").notNull().default(sql`'[]'::jsonb`),
  extractedInfo: jsonb("extracted_info"),
  
  // Session tracking
  startedAt: timestamp("started_at").defaultNow().notNull(),
  lastActivityAt: timestamp("last_activity_at").defaultNow().notNull(),
  completedAt: timestamp("completed_at"),
  
  // Metrics
  questionsAsked: integer("questions_asked").default(0),
  questionsAnswered: integer("questions_answered").default(0),
  questionsSkipped: integer("questions_skipped").default(0),
  
  status: text("status").notNull().default("active"), // active, paused, completed
});

export const insertInterviewSessionSchema = createInsertSchema(interviewSessions).omit({
  id: true,
});

export type InsertInterviewSession = z.infer<typeof insertInterviewSessionSchema>;
export type InterviewSession = typeof interviewSessions.$inferSelect;

// =====================
// CIM SECTIONS - Content for each CIM section
// =====================
export const cimSections = pgTable("cim_sections", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  dealId: varchar("deal_id").notNull(),

  sectionKey: text("section_key").notNull(), // AI-generated, bespoke per deal
  sectionTitle: text("section_title").notNull(),
  order: integer("order").notNull(),

  // Layout engine output
  layoutType: text("layout_type").notNull().default("prose_highlight"),
  layoutData: jsonb("layout_data"),           // structured data for the renderer
  aiLayoutReasoning: text("ai_layout_reasoning"), // why this layout was chosen
  tags: jsonb("tags").default(sql`'[]'::jsonb`),

  // Content
  aiDraftContent: text("ai_draft_content"),
  brokerEditedContent: text("broker_edited_content"),
  sellerEditedContent: text("seller_edited_content"),
  finalContent: text("final_content"),

  // Approval & visibility
  brokerApproved: boolean("broker_approved").default(false),
  sellerApproved: boolean("seller_approved").default(false),
  isVisible: boolean("is_visible").default(true),
  layoutOverride: text("layout_override"), // set if broker changed AI's layout choice

  // Legacy visual elements
  charts: jsonb("charts"),
  images: jsonb("images"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// =====================
// ENGAGEMENT INSIGHTS - Aggregated learning data (learning loop)
// =====================
export const engagementInsights = pgTable("engagement_insights", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),

  // Dimensions
  industry: text("industry").notNull(),
  sectionType: text("section_type").notNull(),   // generic label, e.g. "revenue_breakdown"
  layoutType: text("layout_type").notNull(),

  // Aggregate metrics
  avgTimeSpentSeconds: integer("avg_time_spent_seconds").default(0),
  avgScrollDepthPercent: integer("avg_scroll_depth_percent").default(0),
  completionRate: integer("completion_rate").default(0),   // % (0–100)
  returnVisitRate: integer("return_visit_rate").default(0), // % (0–100)
  sampleCount: integer("sample_count").default(0),

  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// =====================
// INTERVIEW INSIGHTS - Learning loop for interview improvement
// =====================
export const interviewInsights = pgTable("interview_insights", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),

  // Dimensions — what kind of interview was this
  industry: text("industry").notNull(),
  communicationStyle: text("communication_style"),       // from seller profile
  sellingReason: text("selling_reason"),                  // from seller profile

  // Aggregate metrics (rolling averages)
  avgQuestionsAsked: integer("avg_questions_asked").default(0),
  avgQuestionsAnswered: integer("avg_questions_answered").default(0),
  avgSessionDurationMinutes: integer("avg_session_duration_minutes").default(0),
  avgCoveragePercent: integer("avg_coverage_percent").default(0),  // 0-100
  avgDeferredTopics: integer("avg_deferred_topics").default(0),

  // Qualitative insights (AI-generated after each interview)
  effectiveApproaches: jsonb("effective_approaches").default(sql`'[]'::jsonb`),   // string[]
  commonStickingPoints: jsonb("common_sticking_points").default(sql`'[]'::jsonb`), // string[]
  recommendedQuestionOrder: jsonb("recommended_question_order").default(sql`'[]'::jsonb`), // string[]
  topicsThatBuildTrust: jsonb("topics_that_build_trust").default(sql`'[]'::jsonb`), // string[]

  sampleCount: integer("sample_count").default(0),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type InterviewInsight = typeof interviewInsights.$inferSelect;

// =====================
// BUYER QUESTIONS - Q&A chatbot per deal
// =====================
export const buyerQuestions = pgTable("buyer_questions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  dealId: varchar("deal_id").notNull(),
  buyerAccessId: varchar("buyer_access_id"),

  question: text("question").notNull(),

  // Answer chain: AI → broker → seller approval
  aiAnswer: text("ai_answer"),
  brokerDraft: text("broker_draft"),
  sellerApproved: boolean("seller_approved").default(false),
  sellerApprovedAt: timestamp("seller_approved_at"),
  publishedAnswer: text("published_answer"), // final answer shown to buyer

  // Workflow status
  status: text("status").notNull().default("pending_ai"),
  // pending_ai | pending_broker | pending_seller | published | declined

  // Seller approval token — unique link for seller to approve/reject
  sellerApprovalToken: text("seller_approval_token").unique(),

  // Knowledge base
  addedToKnowledgeBase: boolean("added_to_knowledge_base").default(false),
  similarQuestionIds: jsonb("similar_question_ids").default(sql`'[]'::jsonb`),

  isPublished: boolean("is_published").default(false),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertCimSectionSchema = createInsertSchema(cimSections).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertCimSection = z.infer<typeof insertCimSectionSchema>;
export type CimSection = typeof cimSections.$inferSelect;

export const insertEngagementInsightSchema = createInsertSchema(engagementInsights).omit({
  id: true,
  updatedAt: true,
});

export type InsertEngagementInsight = z.infer<typeof insertEngagementInsightSchema>;
export type EngagementInsight = typeof engagementInsights.$inferSelect;

export const insertBuyerQuestionSchema = createInsertSchema(buyerQuestions).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertBuyerQuestion = z.infer<typeof insertBuyerQuestionSchema>;
export type BuyerQuestion = typeof buyerQuestions.$inferSelect;

// =====================
// SELLER INVITES - Invite tokens for sellers
// =====================
export const sellerInvites = pgTable("seller_invites", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  dealId: varchar("deal_id").notNull(),
  token: text("token").notNull().unique(),
  
  sellerEmail: text("seller_email"),
  sellerName: text("seller_name"),
  
  sentAt: timestamp("sent_at"),
  acceptedAt: timestamp("accepted_at"),
  expiresAt: timestamp("expires_at"),
  
  status: text("status").notNull().default("pending"), // pending, sent, accepted, expired
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertSellerInviteSchema = createInsertSchema(sellerInvites).omit({
  id: true,
  createdAt: true,
});

export type InsertSellerInvite = z.infer<typeof insertSellerInviteSchema>;
export type SellerInvite = typeof sellerInvites.$inferSelect;

// =====================
// BUYER ACCESS - CIM viewing permissions
// =====================
export const buyerAccess = pgTable("buyer_access", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  dealId: varchar("deal_id").notNull(),

  // Optional link to a buyer_users account. When set, the buyer can log in
  // and see this deal on their dashboard. When null, the buyer only has the
  // tokenized email link (backwards-compatible with pre-account flow).
  buyerUserId: varchar("buyer_user_id"),

  buyerEmail: text("buyer_email").notNull(),
  buyerName: text("buyer_name"),
  buyerCompany: text("buyer_company"),
  
  accessToken: text("access_token").notNull().unique(),
  accessLevel: text("access_level").notNull().default("teaser"), // teaser, full, loi, due_diligence
  
  // NDA
  ndaSigned: boolean("nda_signed").default(false),
  ndaSignedAt: timestamp("nda_signed_at"),
  
  // Access controls
  canDownload: boolean("can_download").default(false),
  watermarkEnabled: boolean("watermark_enabled").default(true),
  
  // Buyer profile (for matching)
  buyerType: text("buyer_type"), // individual, strategic, financial, search_fund, family_office, private_equity
  budgetMin: text("budget_min"),    // deprecated — use buyerCriteria
  budgetMax: text("budget_max"),    // deprecated — use buyerCriteria
  targetIndustries: jsonb("target_industries").default(sql`'[]'::jsonb`),  // deprecated
  targetLocations: jsonb("target_locations").default(sql`'[]'::jsonb`),   // deprecated
  acquisitionCriteria: text("acquisition_criteria"), // deprecated
  prequalified: boolean("prequalified").default(false),
  proofOfFunds: boolean("proof_of_funds").default(false),
  buyerNotes: text("buyer_notes"), // broker's internal notes

  // Deep buyer criteria (JSONB — see BUYER_CRITERIA_SECTIONS for structure)
  buyerCriteria: jsonb("buyer_criteria").default(sql`'{}'::jsonb`),

  // Analytics tracking
  viewCount: integer("view_count").default(0),
  totalTimeSeconds: integer("total_time_seconds").default(0),

  // NDA tracking
  ndaVersion: text("nda_version"),
  ndaSignedIp: text("nda_signed_ip"),

  // Matching score (auto-calculated)
  matchScore: integer("match_score"), // 0-100
  matchBreakdown: jsonb("match_breakdown"), // { criteria: score } detail

  // Buyer decision — captured from the view room
  // Defaults to "under_review" automatically. Buyer explicitly chooses interested / not_interested.
  // "lapsed" = auto-assigned after extended inactivity with no explicit response.
  decision: text("decision").default("under_review"), // under_review | interested | not_interested | lapsed
  decisionNextStep: text("decision_next_step"), // seller_call | site_visit | loi | management_meeting | other | null
  decisionReason: text("decision_reason"), // text — reason if not_interested, notes if interested
  decisionAt: timestamp("decision_at"),
  crmSyncStatus: text("crm_sync_status"), // pending | synced | failed | not_configured | null
  crmSyncError: text("crm_sync_error"),
  crmSyncedAt: timestamp("crm_synced_at"),

  // Decision prompt pacing — first visit is a breathing period (no prompt),
  // subsequent visits show the decision panel, reminder emails escalate.
  firstViewedAt: timestamp("first_viewed_at"),
  reminderStage: text("reminder_stage").default("none"), // none | reminder_sent | warning_sent
  lastReminderAt: timestamp("last_reminder_at"),

  expiresAt: timestamp("expires_at"),
  revokedAt: timestamp("revoked_at"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  lastAccessedAt: timestamp("last_accessed_at"),
});

export const insertBuyerAccessSchema = createInsertSchema(buyerAccess).omit({
  id: true,
  createdAt: true,
});

export type InsertBuyerAccess = z.infer<typeof insertBuyerAccessSchema>;
export type BuyerAccess = typeof buyerAccess.$inferSelect;

// =====================
// ANALYTICS EVENTS - Track buyer engagement
// =====================
export const analyticsEvents = pgTable("analytics_events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  dealId: varchar("deal_id").notNull(),
  buyerAccessId: varchar("buyer_access_id"),
  
  eventType: text("event_type").notNull(),
  // view, page_view, section_enter, section_exit, scroll, heat_map_sample,
  // element_hover, download_attempt, time_on_page, nda_signed, question_asked
  eventData: jsonb("event_data"),

  // Page/section tracking
  pageNumber: integer("page_number"),
  sectionKey: text("section_key"),

  // Time tracking
  timeSpentSeconds: integer("time_spent_seconds"),
  scrollDepthPercent: integer("scroll_depth_percent"),

  // Heat map (normalised 0–100 within viewport)
  heatMapX: integer("heat_map_x"),
  heatMapY: integer("heat_map_y"),
  viewportWidth: integer("viewport_width"),
  viewportHeight: integer("viewport_height"),

  // Element-level tracking
  elementId: text("element_id"), // data-track-id on CIM elements

  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertAnalyticsEventSchema = createInsertSchema(analyticsEvents).omit({
  id: true,
  createdAt: true,
});

export type InsertAnalyticsEvent = z.infer<typeof insertAnalyticsEventSchema>;
export type AnalyticsEvent = typeof analyticsEvents.$inferSelect;

// =====================
// FAQ ITEMS - Live FAQ for buyers
// =====================
export const faqItems = pgTable("faq_items", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  dealId: varchar("deal_id").notNull(),
  
  question: text("question").notNull(),
  answer: text("answer").notNull(),
  
  order: integer("order").notNull().default(0),
  isPublished: boolean("is_published").default(true),
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertFaqItemSchema = createInsertSchema(faqItems).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertFaqItem = z.infer<typeof insertFaqItemSchema>;
export type FaqItem = typeof faqItems.$inferSelect;

// =====================
// BRANDING SETTINGS
// =====================
export const brandingSettings = pgTable("branding_settings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  brokerId: varchar("broker_id"),
  
  companyName: text("company_name"),
  primaryColor: text("primary_color").notNull().default("218 70% 47%"),
  accentColor: text("accent_color").notNull().default("25 95% 53%"),
  backgroundColor: text("background_color").notNull().default("0 0% 100%"),
  cardColor: text("card_color").notNull().default("0 0% 100%"),
  textColor: text("text_color").notNull().default("224 71% 4%"),
  headingFont: text("heading_font").notNull().default("Inter"),
  bodyFont: text("body_font").notNull().default("Inter"),
  logoUrl: text("logo_url"),
  spacing: text("spacing").notNull().default("medium"),
  borderRadius: text("border_radius").notNull().default("medium"),
  
  // Additional branding
  headerTemplate: text("header_template"),
  footerTemplate: text("footer_template"),
  disclaimer: text("disclaimer"),
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertBrandingSettingsSchema = createInsertSchema(brandingSettings).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertBrandingSettings = z.infer<typeof insertBrandingSettingsSchema>;
export type BrandingSettings = typeof brandingSettings.$inferSelect;

// =====================
// INTEGRATIONS - OAuth connections to external services
// =====================
export const integrations = pgTable("integrations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  brokerId: varchar("broker_id").notNull(),

  provider: text("provider").notNull(), // gmail, outlook, salesforce, hubspot, zoom, otter, fireflies
  status: text("status").notNull().default("disconnected"), // connected, disconnected, error

  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  tokenExpiresAt: timestamp("token_expires_at"),

  config: jsonb("config"), // provider-specific config, e.g. { monitoredEmails: [...] }

  connectedAt: timestamp("connected_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertIntegrationSchema = createInsertSchema(integrations).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertIntegration = z.infer<typeof insertIntegrationSchema>;
export type Integration = typeof integrations.$inferSelect;

// =====================
// INTEGRATION EMAILS - Email addresses monitored per deal
// =====================
export const integrationEmails = pgTable("integration_emails", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  integrationId: varchar("integration_id").notNull(),
  dealId: varchar("deal_id").notNull(),

  emailAddress: text("email_address").notNull(),
  label: text("label"), // e.g. "Seller", "Accountant"

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertIntegrationEmailSchema = createInsertSchema(integrationEmails).omit({
  id: true,
  createdAt: true,
});

export type InsertIntegrationEmail = z.infer<typeof insertIntegrationEmailSchema>;
export type IntegrationEmail = typeof integrationEmails.$inferSelect;

// =====================
// DEAL KNOWLEDGE SOURCES - Ingested data from external sources
// =====================
export const dealKnowledgeSources = pgTable("deal_knowledge_sources", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  dealId: varchar("deal_id").notNull(),

  sourceType: text("source_type").notNull(), // email, crm, call_recording, document, scrape
  sourceProvider: text("source_provider"), // gmail, outlook, salesforce, etc.
  sourceRef: text("source_ref"), // email message ID, CRM record ID, etc.

  extractedText: text("extracted_text"),
  extractedData: jsonb("extracted_data"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertDealKnowledgeSourceSchema = createInsertSchema(dealKnowledgeSources).omit({
  id: true,
  createdAt: true,
});

export type InsertDealKnowledgeSource = z.infer<typeof insertDealKnowledgeSourceSchema>;
export type DealKnowledgeSource = typeof dealKnowledgeSources.$inferSelect;

// =====================
// FINANCIAL ANALYSES - Financial analysis results per deal
// =====================
export const financialAnalyses = pgTable("financial_analyses", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  dealId: varchar("deal_id").notNull(),
  version: integer("version").notNull().default(1),
  status: text("status").notNull().default("draft"), // draft, running, completed, failed, reviewed

  // Reclassified financial statements
  reclassifiedPnl: jsonb("reclassified_pnl"),
  reclassifiedBalanceSheet: jsonb("reclassified_balance_sheet"),
  reclassifiedCashFlow: jsonb("reclassified_cash_flow"),
  arAging: jsonb("ar_aging"),

  // Analysis outputs
  normalization: jsonb("normalization"), // SDE/EBITDA addback analysis
  workingCapital: jsonb("working_capital"),
  comps: jsonb("comps"), // comparable transactions

  // AI-generated content
  insights: jsonb("insights"), // positive and negative financial insights
  clarifyingQuestions: jsonb("clarifying_questions"), // red flag questions for seller/broker

  // Provenance
  sourceDocumentIds: jsonb("source_document_ids"), // array of document IDs used
  aiReasoning: text("ai_reasoning"), // AI explanation of its analysis approach
  brokerNotes: text("broker_notes"),

  // Review
  brokerReviewedAt: timestamp("broker_reviewed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertFinancialAnalysisSchema = createInsertSchema(financialAnalyses).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertFinancialAnalysis = z.infer<typeof insertFinancialAnalysisSchema>;
export type FinancialAnalysis = typeof financialAnalyses.$inferSelect;

// =====================
// ADDBACK VERIFICATIONS - Transaction-level addback corroboration
// =====================
export const addbackVerifications = pgTable("addback_verifications", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  dealId: varchar("deal_id").notNull(),
  financialAnalysisId: varchar("financial_analysis_id"), // nullable — may not exist in Workflow B
  workflow: text("workflow").notNull(), // 'provided' | 'from_scratch'
  status: text("status").notNull().default("pending_documents"),
  // pending_documents | analyzing | pending_seller_review | verified | failed

  addbacks: jsonb("addbacks").default(sql`'[]'::jsonb`), // array of addback verification objects
  uploadedTransactionData: jsonb("uploaded_transaction_data"), // parsed transaction data from GL/bank/QB
  sellerQuestions: jsonb("seller_questions").default(sql`'[]'::jsonb`), // AI questions with answers
  sourceDocumentIds: jsonb("source_document_ids").default(sql`'[]'::jsonb`), // string array of document IDs

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertAddbackVerificationSchema = createInsertSchema(addbackVerifications).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertAddbackVerification = z.infer<typeof insertAddbackVerificationSchema>;
export type AddbackVerification = typeof addbackVerifications.$inferSelect;

// =====================
// CIM SECTION OVERRIDES (blind/DD versions)
// =====================
export const cimSectionOverrides = pgTable("cim_section_overrides", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  dealId: varchar("deal_id").notNull(),
  cimSectionId: varchar("cim_section_id").notNull(),
  mode: text("mode").notNull(), // "blind" | "dd"
  layoutData: jsonb("layout_data"),
  contentOverride: text("content_override"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertCimSectionOverrideSchema = createInsertSchema(cimSectionOverrides).omit({
  id: true,
  createdAt: true,
});

export type InsertCimSectionOverride = z.infer<typeof insertCimSectionOverrideSchema>;
export type CimSectionOverride = typeof cimSectionOverrides.$inferSelect;

// =====================
// DISCREPANCIES (verification pass)
// =====================
export const discrepancies = pgTable("discrepancies", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  dealId: varchar("deal_id").notNull(),
  field: text("field").notNull(),
  interviewValue: text("interview_value"),
  documentValue: text("document_value"),
  documentId: varchar("document_id"),
  documentName: text("document_name"),
  severity: text("severity").notNull(), // "critical" | "significant" | "minor"
  category: text("category").notNull(), // "financial" | "operational" | "legal" | "factual"
  aiExplanation: text("ai_explanation"),
  suggestedResolution: text("suggested_resolution"),
  status: text("status").notNull().default("open"), // "open" | "seller_responded" | "resolved" | "accepted"
  sellerResponse: text("seller_response"),
  brokerNotes: text("broker_notes"),
  resolvedValue: text("resolved_value"),
  resolvedAt: timestamp("resolved_at"),
  resolvedBy: varchar("resolved_by"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertDiscrepancySchema = createInsertSchema(discrepancies).omit({
  id: true,
  createdAt: true,
});

export type InsertDiscrepancy = z.infer<typeof insertDiscrepancySchema>;
export type Discrepancy = typeof discrepancies.$inferSelect;

// =====================
// LEGACY - Keep for backward compatibility during migration
// =====================
export const cims = pgTable("cims", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  businessName: text("business_name").notNull(),
  industry: text("industry").notNull(),
  description: text("description"),
  questionnaireData: jsonb("questionnaire_data"),
  extractedInfo: jsonb("extracted_info"),
  status: text("status").notNull().default("draft"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertCimSchema = createInsertSchema(cims).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertCim = z.infer<typeof insertCimSchema>;
export type Cim = typeof cims.$inferSelect;

// =====================
// ZOD SCHEMAS FOR VALIDATION
// =====================
export const conversationMessageSchema = z.object({
  role: z.enum(["ai", "user"]),
  content: z.string(),
  timestamp: z.string(),
});

export const extractedInfoSchema = z.object({
  // Overview & Reputation
  businessName: z.string().optional(),
  industry: z.string().optional(),
  naicsCode: z.string().optional(),
  entityType: z.string().optional(),
  brandIdentity: z.string().optional(),
  missionStatement: z.string().optional(),
  coreValues: z.string().optional(),
  companyHistory: z.string().optional(),
  yearsOperating: z.string().optional(),
  ownershipHistory: z.string().optional(),
  industryPerception: z.string().optional(),
  customerPerception: z.string().optional(),
  accolades: z.string().optional(),
  
  // Strengths
  competitiveAdvantage: z.string().optional(),
  uniqueSellingProposition: z.string().optional(),
  strengths: z.string().optional(),
  
  // Growth Potential
  growthOpportunities: z.string().optional(),
  expansionPlans: z.string().optional(),
  
  // Target Market
  targetMarket: z.string().optional(),
  primaryMarket: z.string().optional(),
  secondaryMarket: z.string().optional(),
  b2bBreakdown: z.string().optional(),
  customerDemographics: z.string().optional(),
  
  // Permits & Licenses
  permitsLicenses: z.string().optional(),
  complianceRequirements: z.string().optional(),
  
  // Seasonality
  seasonality: z.string().optional(),
  peakPeriods: z.string().optional(),
  slowPeriods: z.string().optional(),
  
  // Revenue & Financials
  revenueStreams: z.string().optional(),
  keyProducts: z.string().optional(),
  customerConcentration: z.string().optional(),
  annualRevenue: z.string().optional(),
  revenueGrowth: z.string().optional(),
  operatingMargins: z.string().optional(),
  
  // Real Estate
  leaseDetails: z.string().optional(),
  propertyInfo: z.string().optional(),
  realEstateIncluded: z.string().optional(),
  
  // Employees
  employees: z.string().optional(),
  employeeStructure: z.string().optional(),
  keyEmployees: z.string().optional(),
  ownerInvolvement: z.string().optional(),
  
  // Operations
  suppliers: z.string().optional(),
  supplyChain: z.string().optional(),
  technologySystems: z.string().optional(),
  operationalSystems: z.string().optional(),
  
  // Buyer Profile & Transition
  idealBuyer: z.string().optional(),
  trainingSupport: z.string().optional(),
  transitionPlan: z.string().optional(),
  
  // Sale Details
  reasonForSale: z.string().optional(),
  askingPrice: z.string().optional(),
  saleType: z.string().optional(),
  assetsIncluded: z.string().optional(),
  inventory: z.string().optional(),
  workingCapital: z.string().optional(),
  debt: z.string().optional(),
  
  // Additional
  website: z.string().optional(),
  locations: z.string().optional(),
  customerBase: z.string().optional(),
  marketingChannels: z.string().optional(),
  assets: z.string().optional(),
  managementTeam: z.string().optional(),
});

export type ConversationMessage = z.infer<typeof conversationMessageSchema>;
export type ExtractedInfo = z.infer<typeof extractedInfoSchema>;

// CIM Section keys for content generation
export const CIM_SECTIONS = [
  { key: "overview", title: "Overview & Reputation", order: 1 },
  { key: "strengths", title: "Strengths", order: 2 },
  { key: "growth_potential", title: "Growth Potential & Opportunities", order: 3 },
  { key: "target_market", title: "Target Market", order: 4 },
  { key: "permits_licenses", title: "Permits & Licenses", order: 5 },
  { key: "seasonality", title: "Seasonality", order: 6 },
  { key: "revenue_sources", title: "Major Business Lines & Sources of Revenue", order: 7 },
  { key: "real_estate", title: "Real Estate & Property", order: 8 },
  { key: "employees", title: "Employee Overview", order: 9 },
  { key: "operations", title: "Operations & Systems", order: 10 },
  { key: "buyer_profile", title: "Buyer Profile", order: 11 },
  { key: "training_support", title: "Training & Support", order: 12 },
  { key: "reason_for_sale", title: "Reason for Sale", order: 13 },
  { key: "financials", title: "Financial Summary", order: 14 },
  { key: "asking_price", title: "Asking Price & Deal Terms", order: 15 },
] as const;

export type CimSectionKey = typeof CIM_SECTIONS[number]["key"];

// =====================
// DEAL MEMBERS — Unified team model (broker, seller, buyer teams)
// =====================
export const dealMembers = pgTable("deal_members", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  dealId: varchar("deal_id").notNull(),

  // Identity
  email: text("email").notNull(),
  name: text("name"),
  phone: text("phone"),

  // Team & role
  teamType: text("team_type").notNull(), // "broker" | "seller" | "buyer"
  role: text("role").notNull(),
  // Broker roles: "lead" | "associate" | "analyst" | "admin"
  // Seller roles: "owner" | "representative" | "accountant" | "attorney"
  // Buyer roles: "principal" | "analyst" | "advisor" | "attorney"

  // Permissions (computed from role but overridable)
  permissions: jsonb("permissions").default(sql`'[]'::jsonb`),
  // e.g. ["view_cim", "approve_qa", "upload_docs", "edit_deal", "manage_buyers"]

  // Invite & access
  inviteToken: text("invite_token").unique(),
  inviteStatus: text("invite_status").notNull().default("pending"),
  // "pending" | "sent" | "accepted" | "expired" | "revoked"
  invitedAt: timestamp("invited_at"),
  acceptedAt: timestamp("accepted_at"),
  lastActiveAt: timestamp("last_active_at"),

  // Buyer-specific fields (replaces buyerAccess)
  accessLevel: text("access_level"), // "teaser" | "full" | "loi" | "due_diligence"
  ndaSigned: boolean("nda_signed").default(false),
  ndaSignedAt: timestamp("nda_signed_at"),
  canDownload: boolean("can_download").default(false),
  watermarkEnabled: boolean("watermark_enabled").default(true),

  // Notification preferences
  emailNotifications: boolean("email_notifications").default(true),
  smsNotifications: boolean("sms_notifications").default(false),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertDealMemberSchema = createInsertSchema(dealMembers).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertDealMember = z.infer<typeof insertDealMemberSchema>;
export type DealMember = typeof dealMembers.$inferSelect;

// =====================
// NOTIFICATIONS — Event-driven alerts
// =====================
export const notifications = pgTable("notifications", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  dealId: varchar("deal_id").notNull(),
  recipientId: varchar("recipient_id").notNull(), // dealMember.id
  recipientEmail: text("recipient_email").notNull(),
  recipientPhone: text("recipient_phone"),

  // Content
  type: text("type").notNull(),
  // "qa_needs_approval" | "qa_published" | "cim_ready" | "document_uploaded"
  // | "nda_signed" | "buyer_question" | "deal_update" | "invite" | "reminder"
  title: text("title").notNull(),
  body: text("body").notNull(),
  actionUrl: text("action_url"), // deep link to relevant page
  metadata: jsonb("metadata").default(sql`'{}'::jsonb`),

  // Delivery status
  emailSent: boolean("email_sent").default(false),
  emailSentAt: timestamp("email_sent_at"),
  smsSent: boolean("sms_sent").default(false),
  smsSentAt: timestamp("sms_sent_at"),
  readAt: timestamp("read_at"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertNotificationSchema = createInsertSchema(notifications).omit({
  id: true,
  createdAt: true,
});

export type InsertNotification = z.infer<typeof insertNotificationSchema>;
export type Notification = typeof notifications.$inferSelect;

// =====================
// BUYER CRITERIA — deep M&A matching fields
// =====================
// Stored as JSONB on buyerAccess.buyerCriteria
// Each field is optional. Ranges use { min, max }. Arrays for multi-select.
export const BUYER_CRITERIA_SECTIONS = {
  financial: {
    label: "Financial Criteria",
    fields: {
      revenueMin:            { label: "Revenue minimum",               type: "currency" },
      revenueMax:            { label: "Revenue maximum",               type: "currency" },
      ebitdaMin:             { label: "EBITDA minimum",                type: "currency" },
      ebitdaMax:             { label: "EBITDA maximum",                type: "currency" },
      sdeMin:                { label: "SDE minimum",                   type: "currency" },
      sdeMax:                { label: "SDE maximum",                   type: "currency" },
      askingPriceMin:        { label: "Asking price minimum",          type: "currency" },
      askingPriceMax:        { label: "Asking price maximum",          type: "currency" },
      grossMarginMin:        { label: "Gross margin minimum (%)",      type: "percent" },
      ebitdaMarginMin:       { label: "EBITDA margin minimum (%)",     type: "percent" },
      revenueGrowthMin:      { label: "Revenue growth minimum (%)",    type: "percent" },
      recurringRevenueMin:   { label: "Recurring revenue minimum (%)", type: "percent" },
      maxCustomerConcentration: { label: "Max customer concentration (%)", type: "percent" },
      multipleMax:           { label: "Max asking multiple (x EBITDA)", type: "number" },
      workingCapitalPref:    { label: "Working capital preference",    type: "select", options: ["included", "excluded", "flexible"] },
      debtTolerance:         { label: "Debt tolerance",                type: "select", options: ["debt_free_only", "minimal_debt", "reasonable_debt", "any"] },
    },
  },
  operational: {
    label: "Operational Criteria",
    fields: {
      ownerInvolvementMax:   { label: "Max owner involvement (hrs/wk)", type: "number" },
      minEmployees:          { label: "Minimum employees",              type: "number" },
      maxEmployees:          { label: "Maximum employees",              type: "number" },
      managementTeamRequired: { label: "Management team in place",     type: "boolean" },
      employeeRetentionImportance: { label: "Employee retention importance", type: "select", options: ["critical", "important", "nice_to_have", "not_important"] },
      systemsMaturity:       { label: "Minimum systems/processes maturity", type: "select", options: ["advanced", "moderate", "basic", "any"] },
      realEstatePreference:  { label: "Real estate preference",        type: "select", options: ["owned_preferred", "leased_ok", "no_preference"] },
      leaseLengthMin:        { label: "Min lease remaining (years)",   type: "number" },
    },
  },
  business: {
    label: "Business Quality",
    fields: {
      targetIndustries:      { label: "Target industries",             type: "tags" },
      excludedIndustries:    { label: "Excluded industries",           type: "tags" },
      targetLocations:       { label: "Target locations",              type: "tags" },
      yearsInBusinessMin:    { label: "Min years in business",         type: "number" },
      customerDiversification: { label: "Customer diversification",   type: "select", options: ["highly_diversified", "moderately_diversified", "concentrated_ok", "any"] },
      supplierDiversification: { label: "Supplier diversification",   type: "select", options: ["highly_diversified", "moderately_diversified", "single_source_ok", "any"] },
      ipRequired:            { label: "IP / proprietary assets required", type: "boolean" },
      brandStrengthMin:      { label: "Min brand strength",            type: "select", options: ["market_leader", "well_known", "established", "any"] },
      competitiveMoat:       { label: "Competitive moat required",     type: "select", options: ["strong_moat", "moderate_moat", "any"] },
      licensingRequired:     { label: "Licenses/permits transferable", type: "boolean" },
    },
  },
  dealStructure: {
    label: "Deal Structure",
    fields: {
      acceptableReasons:     { label: "Acceptable reasons for sale",   type: "multiselect", options: ["retirement", "relocation", "health", "new_venture", "partner_dispute", "burnout", "estate_planning", "strategic_exit", "any"] },
      sellerFinancingRequired: { label: "Seller financing required",   type: "boolean" },
      sellerFinancingMin:    { label: "Min seller financing (%)",      type: "percent" },
      transitionPeriodMax:   { label: "Max transition period (months)", type: "number" },
      earnoutAcceptable:     { label: "Earnout acceptable",            type: "boolean" },
      assetVsSharePref:      { label: "Deal type preference",         type: "select", options: ["asset_only", "share_only", "either"] },
      nonCompeteRequired:    { label: "Non-compete required",          type: "boolean" },
    },
  },
  growth: {
    label: "Growth & Strategic",
    fields: {
      growthPotentialMin:    { label: "Min growth potential",           type: "select", options: ["high", "moderate", "stable", "any"] },
      scalabilityRequired:  { label: "Scalability required",           type: "boolean" },
      geographicExpansion:  { label: "Geographic expansion potential",  type: "boolean" },
      productExpansion:     { label: "Product/service expansion potential", type: "boolean" },
      addOnAcquisition:     { label: "Suitable as add-on acquisition", type: "boolean" },
      platformAcquisition:  { label: "Suitable as platform acquisition", type: "boolean" },
      industryTailwinds:    { label: "Industry tailwinds required",    type: "boolean" },
      techEnabled:          { label: "Technology-enabled preferred",   type: "boolean" },
    },
  },
} as const;

// Role permission mappings
export const TEAM_ROLES = {
  broker: {
    lead: {
      label: "Lead Broker",
      permissions: ["edit_deal", "manage_team", "manage_buyers", "approve_cim", "view_financials", "view_analytics", "approve_qa"],
    },
    associate: {
      label: "Associate",
      permissions: ["edit_deal", "manage_buyers", "view_financials", "view_analytics", "approve_qa"],
    },
    analyst: {
      label: "Analyst",
      permissions: ["view_financials", "view_analytics"],
    },
    admin: {
      label: "Admin",
      permissions: ["edit_deal", "manage_team", "manage_buyers", "approve_cim", "view_financials", "view_analytics", "approve_qa"],
    },
  },
  seller: {
    owner: {
      label: "Owner",
      permissions: ["approve_qa", "approve_cim", "upload_docs", "view_financials", "participate_interview"],
    },
    representative: {
      label: "Authorized Representative",
      permissions: ["approve_qa", "upload_docs", "participate_interview"],
    },
    accountant: {
      label: "Accountant",
      permissions: ["upload_docs", "view_financials"],
    },
    attorney: {
      label: "Attorney",
      permissions: ["approve_qa", "view_financials", "upload_docs"],
    },
  },
  buyer: {
    principal: {
      label: "Principal / Decision Maker",
      permissions: ["view_cim", "ask_questions", "submit_loi"],
    },
    analyst: {
      label: "Analyst",
      permissions: ["view_cim", "ask_questions"],
    },
    advisor: {
      label: "Advisor",
      permissions: ["view_cim", "ask_questions"],
    },
    attorney: {
      label: "Attorney",
      permissions: ["view_cim", "ask_questions"],
    },
  },
} as const;

// Notification event → which roles should receive it
export const NOTIFICATION_ROUTING: Record<string, { teams: string[]; roles?: string[] }> = {
  qa_needs_approval: { teams: ["seller"], roles: ["owner", "representative"] },
  qa_published: { teams: ["buyer"] },
  buyer_question: { teams: ["broker"], roles: ["lead", "associate"] },
  cim_ready: { teams: ["seller"], roles: ["owner", "representative"] },
  document_uploaded: { teams: ["broker"], roles: ["lead", "associate", "analyst"] },
  nda_signed: { teams: ["broker"], roles: ["lead", "associate"] },
  deal_update: { teams: ["broker", "seller"] },
  invite: { teams: ["broker", "seller", "buyer"] },
  loi_submitted: { teams: ["broker"], roles: ["lead"] },
  buyer_decision_interested: { teams: ["broker"], roles: ["lead", "associate"] },
  buyer_decision_not_interested: { teams: ["broker"], roles: ["lead", "associate"] },
  buyer_decision_lapsed: { teams: ["broker", "seller"], roles: ["lead", "associate", "owner", "representative"] },
  // Buyer approval workflow
  buyer_approval_requested: { teams: ["broker"], roles: ["lead"] },
  buyer_approval_broker_approved: { teams: ["seller"], roles: ["owner", "representative"] },
  buyer_approval_seller_approved: { teams: ["broker"], roles: ["lead", "associate"] },
  buyer_approval_rejected: { teams: ["broker"], roles: ["lead", "associate"] },
};

// Buyer decision next-step options (shown after "interested in moving forward")
export const BUYER_NEXT_STEPS = [
  { value: "seller_call", label: "Introductory call with the seller" },
  { value: "management_meeting", label: "Management meeting" },
  { value: "site_visit", label: "On-site visit / tour" },
  { value: "loi", label: "Submit a Letter of Intent (LOI)" },
  { value: "more_info", label: "Request additional information" },
  { value: "other", label: "Other — I'll describe below" },
] as const;

// CRM stage mapping config — stored on integrations.config
// e.g. { pipedrive: { pipelineId: 1, stageInterested: 5, stageLost: 99 } }
export interface CrmStageMapping {
  pipelineId?: number | string;
  stageInterested?: number | string;  // e.g. "Buyer/Seller Meeting"
  stageNotInterested?: number | string; // e.g. "Lost"
  stageLoi?: number | string;
  dealFieldMapping?: Record<string, string>;
}

// =====================
// BUYER APPROVAL WORKFLOW
// =====================
// Two-stage approval workflow: broker (any deal member) submits a prospective
// buyer → lead broker reviews → seller reviews → buyer is auto-granted CIM
// access. The sell-side broker, buy-side broker, and buyer are all CC'd on
// the final invite so everyone stays in sync.

export const BUYER_CATEGORIES = [
  // High risk — confidentiality-sensitive
  { value: "direct_competitor", label: "Direct Competitor", riskLevel: "high",
    description: "Competes directly on product/service in the same geography." },
  { value: "indirect_competitor", label: "Indirect Competitor", riskLevel: "high",
    description: "Serves the same customers with a different product, or competes in an adjacent segment." },

  // Medium risk — industry insiders, potentially strategic
  { value: "strategic_acquirer", label: "Strategic Acquirer (Adjacent)", riskLevel: "medium",
    description: "Operates in an adjacent or similar industry with clear synergy rationale." },
  { value: "pe_with_portfolio", label: "Private Equity — Portfolio in Space", riskLevel: "medium",
    description: "PE firm that already owns or previously owned businesses in this industry." },
  { value: "corporate_development", label: "Corporate Development (Non-Direct)", riskLevel: "medium",
    description: "Corp dev team from a large company exploring tangential M&A." },
  { value: "international", label: "International Acquirer", riskLevel: "medium",
    description: "Foreign buyer entering the domestic market." },

  // Lower risk — financial / unrelated
  { value: "pe_generalist", label: "Private Equity — Generalist", riskLevel: "low",
    description: "Generalist PE firm with no direct industry overlap." },
  { value: "family_office", label: "Family Office", riskLevel: "low",
    description: "Family office investing directly." },
  { value: "search_fund", label: "Search Fund / ETA Buyer", riskLevel: "low",
    description: "Individual or small team pursuing Entrepreneurship Through Acquisition." },
  { value: "individual_strategic", label: "Individual — Industry Operator", riskLevel: "low",
    description: "Individual buyer with operating experience in this or a related industry." },
  { value: "individual_financial", label: "Individual — Financial Buyer", riskLevel: "low",
    description: "Individual buyer with no industry operating background." },
  { value: "independent_sponsor", label: "Independent Sponsor", riskLevel: "low",
    description: "Independent sponsor / fundless sponsor raising capital deal-by-deal." },
  { value: "holdco", label: "Holding Company", riskLevel: "low",
    description: "Long-hold holdco or permanent capital vehicle." },
  { value: "other", label: "Other", riskLevel: "medium",
    description: "Doesn't fit the standard categories." },
] as const;

export type BuyerCategory = typeof BUYER_CATEGORIES[number]["value"];

// Financial capability structure stored as JSONB
export interface BuyerFinancialCapability {
  liquidFunds?: string;             // e.g. "$2M–$5M"
  annualIncome?: string;
  investmentSizeTarget?: string;    // e.g. "$5M–$20M"
  hasProofOfFunds?: boolean;
  sourceOfFunds?: string;           // e.g. "Personal savings + SBA loan"
  prequalifiedForFinancing?: boolean;
  notes?: string;
}

// A business partner (co-buyer) attached to a buyer approval request
export interface BuyerPartner {
  name: string;
  role?: string;                    // e.g. "Co-investor", "Operating partner"
  email?: string;
  phone?: string;
  company?: string;
  companyUrl?: string;
  linkedinUrl?: string;
  background?: string;
}

export const buyerApprovalRequests = pgTable("buyer_approval_requests", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  dealId: varchar("deal_id").notNull(),

  // Who submitted it (any broker team member on the deal)
  submittedBy: varchar("submitted_by").notNull(),       // dealMembers.id
  submittedByName: text("submitted_by_name"),
  submittedByRole: text("submitted_by_role"),           // lead | associate | analyst | admin

  // ── Buyer contact info ────────────────────────────────────────────
  buyerName: text("buyer_name").notNull(),
  buyerTitle: text("buyer_title"),
  buyerEmail: text("buyer_email").notNull(),
  buyerPhone: text("buyer_phone"),
  buyerCompany: text("buyer_company"),
  buyerCompanyUrl: text("buyer_company_url"),
  linkedinUrl: text("linkedin_url"),
  otherProfileUrls: jsonb("other_profile_urls").default(sql`'[]'::jsonb`), // string[]

  // ── Classification ────────────────────────────────────────────────
  category: text("category").notNull(),   // BuyerCategory
  riskLevel: text("risk_level").notNull(),// high | medium | low (auto-derived from category)

  // ── Background & diligence ────────────────────────────────────────
  background: text("background"),                       // free-form broker description
  financialCapability: jsonb("financial_capability"),   // BuyerFinancialCapability
  partners: jsonb("partners").default(sql`'[]'::jsonb`),// BuyerPartner[]
  isCompetitor: boolean("is_competitor").default(false),
  competitorDetails: text("competitor_details"),

  // ── NDA tracking ──────────────────────────────────────────────────
  ndaSigned: boolean("nda_signed").default(false),
  ndaDocumentId: varchar("nda_document_id"),            // optional link to documents table
  ndaNotes: text("nda_notes"),

  // ── CRM source ────────────────────────────────────────────────────
  crmSource: text("crm_source"),                        // pipedrive | hubspot | salesforce | manual
  crmRecordId: text("crm_record_id"),                   // original CRM record id
  crmRawData: jsonb("crm_raw_data"),                    // audit trail of what was imported

  // ── Workflow state ────────────────────────────────────────────────
  // pending_broker_review → approved_by_broker → pending_seller_review
  //  → approved_by_seller → access_granted
  //  (or: rejected_by_broker | rejected_by_seller at any point)
  status: text("status").notNull().default("pending_broker_review"),

  // Broker review (lead broker)
  brokerReviewedBy: varchar("broker_reviewed_by"),      // dealMembers.id
  brokerReviewedAt: timestamp("broker_reviewed_at"),
  brokerReviewNotes: text("broker_review_notes"),

  // Seller review (tokenized — no login)
  sellerReviewToken: text("seller_review_token").unique(),
  sellerReviewedBy: text("seller_reviewed_by"),         // email or member id
  sellerReviewedAt: timestamp("seller_reviewed_at"),
  sellerReviewNotes: text("seller_review_notes"),

  rejectionReason: text("rejection_reason"),

  // Once approved, this links to the granted buyerAccess row
  grantedBuyerAccessId: varchar("granted_buyer_access_id"),
  grantedAt: timestamp("granted_at"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertBuyerApprovalRequestSchema = createInsertSchema(buyerApprovalRequests).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertBuyerApprovalRequest = z.infer<typeof insertBuyerApprovalRequestSchema>;
export type BuyerApprovalRequest = typeof buyerApprovalRequests.$inferSelect;

// Helper to look up risk level for a category
export function riskLevelForCategory(category: string): "high" | "medium" | "low" {
  const match = BUYER_CATEGORIES.find((c) => c.value === category);
  return (match?.riskLevel as "high" | "medium" | "low") || "medium";
}

// =====================================================================
// BUYER USERS — buyer-side accounts for the self-serve buyer platform
// =====================================================================
// Buyers either sign up themselves (marketing-driven) or are created
// on-the-fly when a broker adds them to a deal (Firmex-style invite).
// Both paths end at the same account: email+password login, dashboard
// of CIMs they have access to, and an investment profile that drives
// match scoring.
export const buyerUsers = pgTable("buyer_users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash"),                 // null until set-password completed
  name: text("name").notNull(),
  phone: text("phone"),
  company: text("company"),
  title: text("title"),
  linkedinUrl: text("linkedin_url"),

  // Investment profile (drives match scoring — same shape as buyerAccess.buyerCriteria)
  buyerCriteria: jsonb("buyer_criteria").default(sql`'{}'::jsonb`),
  targetIndustries: jsonb("target_industries").default(sql`'[]'::jsonb`),  // string[]
  targetLocations: jsonb("target_locations").default(sql`'[]'::jsonb`),    // string[]
  buyerType: text("buyer_type"),                       // individual | strategic | financial | search_fund | family_office | private_equity
  background: text("background"),
  liquidFunds: text("liquid_funds"),
  hasProofOfFunds: boolean("has_proof_of_funds").default(false),

  // Profile completion tracking (drives "complete your profile" nudges)
  profileCompletionPct: integer("profile_completion_pct").default(0),

  // Account state
  emailVerified: boolean("email_verified").default(false),
  source: text("source").default("self_signup"),       // self_signup | broker_invited | crm_imported
  invitedByBroker: varchar("invited_by_broker"),       // user id of inviting broker
  invitedByDeal: varchar("invited_by_deal"),           // deal they were first invited to

  // Password reset / set-password tokens
  resetToken: text("reset_token"),
  resetTokenExpiresAt: timestamp("reset_token_expires_at"),

  lastLoginAt: timestamp("last_login_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertBuyerUserSchema = createInsertSchema(buyerUsers).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  lastLoginAt: true,
});
export type InsertBuyerUser = z.infer<typeof insertBuyerUserSchema>;
export type BuyerUser = typeof buyerUsers.$inferSelect;

// Public view of a buyer user (never expose passwordHash or resetToken)
export type PublicBuyerUser = Omit<BuyerUser, "passwordHash" | "resetToken" | "resetTokenExpiresAt">;

export function toPublicBuyerUser(user: BuyerUser): PublicBuyerUser {
  const { passwordHash, resetToken, resetTokenExpiresAt, ...rest } = user;
  return rest;
}

/**
 * Calculate buyer profile completion percentage (0-100) based on
 * which profile fields are populated. Drives the "complete your
 * profile" nudge on the buyer dashboard.
 */
export function calculateBuyerProfileCompletion(user: Partial<BuyerUser>): number {
  const checks: Array<[boolean, number]> = [
    [!!user.name, 10],
    [!!user.phone, 5],
    [!!user.company, 5],
    [!!user.title, 5],
    [!!user.buyerType, 10],
    [!!user.background && user.background.length > 20, 15],
    [!!user.liquidFunds, 10],
    [Array.isArray(user.targetIndustries) && user.targetIndustries.length > 0, 15],
    [Array.isArray(user.targetLocations) && user.targetLocations.length > 0, 10],
    [!!user.buyerCriteria && Object.keys(user.buyerCriteria as any).length >= 3, 15],
  ];
  return checks.reduce((sum, [ok, pts]) => sum + (ok ? pts : 0), 0);
}

// ────────────────────────────────────────────────────────────────────
// Broker Buyer Contacts
// ────────────────────────────────────────────────────────────────────
// A broker-specific overlay on top of `buyerUsers` — this is the broker's
// personal contact list of buyers. A buyer can be auto-populated from any
// deal they've been granted access to, manually added, imported via CSV,
// or pulled in from a CRM lookup. The same buyer can appear in multiple
// brokers' contact lists (buyerUsers is global, brokerBuyerContacts is
// per-broker).

export const brokerBuyerContacts = pgTable("broker_buyer_contacts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  brokerId: varchar("broker_id").notNull(),
  buyerUserId: varchar("buyer_user_id").notNull(),
  source: text("source").notNull().default("manual"),  // manual | csv | crm | deal | signup
  tags: jsonb("tags").default(sql`'[]'::jsonb`),       // string[]
  notes: text("notes"),
  addedAt: timestamp("added_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertBrokerBuyerContactSchema = createInsertSchema(brokerBuyerContacts).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertBrokerBuyerContact = z.infer<typeof insertBrokerBuyerContactSchema>;
export type BrokerBuyerContact = typeof brokerBuyerContacts.$inferSelect;

// ────────────────────────────────────────────────────────────────────
// Deal Outreach
// ────────────────────────────────────────────────────────────────────
// Tracks every broker-initiated outreach to a buyer for a specific deal.
//
// Two key product rules drive this table:
//   1. Cimple NEVER auto-sends outreach. A row is only created with
//      status = "sent" when the broker explicitly clicks send. Drafts
//      stay as status = "draft" until then.
//   2. Each row records the rendered subject + body so brokers can audit
//      what was actually sent (post-edit).
//
// Lifecycle: draft → sent → opened (optional) → clicked (optional) → replied (optional)

export const dealOutreach = pgTable("deal_outreach", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  dealId: varchar("deal_id").notNull(),
  brokerId: varchar("broker_id").notNull(),
  buyerUserId: varchar("buyer_user_id").notNull(),

  // Snapshot of buyer info at time of outreach (so history is stable
  // even if the buyer record changes later)
  buyerEmail: text("buyer_email").notNull(),
  buyerName: text("buyer_name").notNull(),

  // Match snapshot — captures why we suggested this buyer
  qualifiedScore: integer("qualified_score"),         // 0-100 composite at suggestion time
  matchScore: integer("match_score"),                  // 0-100 deep match at suggestion time
  topDimensions: jsonb("top_dimensions").default(sql`'[]'::jsonb`), // string[]

  // Email content
  channel: text("channel").notNull().default("email"),  // email | sms (future)
  subject: text("subject").notNull(),
  body: text("body").notNull(),

  // Lifecycle
  status: text("status").notNull().default("draft"),
  // draft | sent | opened | clicked | replied | bounced | failed
  sentAt: timestamp("sent_at"),
  openedAt: timestamp("opened_at"),
  clickedAt: timestamp("clicked_at"),
  repliedAt: timestamp("replied_at"),

  // Failure tracking
  errorMessage: text("error_message"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertDealOutreachSchema = createInsertSchema(dealOutreach).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertDealOutreach = z.infer<typeof insertDealOutreachSchema>;
export type DealOutreach = typeof dealOutreach.$inferSelect;
