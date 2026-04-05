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
  
  // Analytics tracking
  viewCount: integer("view_count").default(0),
  totalTimeSeconds: integer("total_time_seconds").default(0),

  // NDA tracking
  ndaVersion: text("nda_version"),
  ndaSignedIp: text("nda_signed_ip"),

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
