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
  
  sectionKey: text("section_key").notNull(), // overview, strengths, growth_potential, target_market, etc.
  sectionTitle: text("section_title").notNull(),
  order: integer("order").notNull(),
  
  // Content
  aiDraftContent: text("ai_draft_content"),
  brokerEditedContent: text("broker_edited_content"),
  sellerEditedContent: text("seller_edited_content"),
  finalContent: text("final_content"),
  
  // Approval workflow
  brokerApproved: boolean("broker_approved").default(false),
  sellerApproved: boolean("seller_approved").default(false),
  
  // Visual elements
  charts: jsonb("charts"),
  images: jsonb("images"),
  
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});