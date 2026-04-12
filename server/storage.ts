import {
  type User, type InsertUser,
  type Cim, type InsertCim,
  type BrandingSettings, type InsertBrandingSettings,
  type Deal, type InsertDeal,
  type Document, type InsertDocument,
  type Task, type InsertTask,
  type SellerInvite, type InsertSellerInvite,
  type BuyerAccess, type InsertBuyerAccess,
  type CimSection, type InsertCimSection,
  type AnalyticsEvent, type InsertAnalyticsEvent,
  type FaqItem, type InsertFaqItem,
  type BuyerQuestion, type InsertBuyerQuestion,
  type EngagementInsight,
  type Integration, type InsertIntegration,
  type IntegrationEmail, type InsertIntegrationEmail,
  type FinancialAnalysis, type InsertFinancialAnalysis,
  type AddbackVerification, type InsertAddbackVerification,
  type CimSectionOverride, type InsertCimSectionOverride,
  type Discrepancy, type InsertDiscrepancy,
  type DealMember, type InsertDealMember,
  type Notification, type InsertNotification,
  type BuyerApprovalRequest, type InsertBuyerApprovalRequest,
  type BuyerUser, type InsertBuyerUser,
  type BrokerBuyerContact, type InsertBrokerBuyerContact,
  type DealOutreach, type InsertDealOutreach,
  users, cims, brandingSettings, deals, documents, tasks, sellerInvites, buyerAccess, cimSections, analyticsEvents, faqItems, buyerQuestions, engagementInsights,
  integrations, integrationEmails, financialAnalyses, addbackVerifications,
  cimSectionOverrides, discrepancies,
  dealMembers, notifications, buyerApprovalRequests, buyerUsers, brokerBuyerContacts, dealOutreach
} from "@shared/schema";
import { randomUUID } from "crypto";
import { db } from "./db";
import { eq, desc, sql, count, avg, sum } from "drizzle-orm";

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  
  // CIM operations (legacy)
  createCim(cim: InsertCim): Promise<Cim>;
  getCim(id: string): Promise<Cim | undefined>;
  updateCim(id: string, updates: Partial<InsertCim>): Promise<Cim | undefined>;
  getAllCims(): Promise<Cim[]>;
  deleteCim(id: string): Promise<void>;
  
  // Deal operations
  createDeal(deal: InsertDeal): Promise<Deal>;
  getDeal(id: string): Promise<Deal | undefined>;
  updateDeal(id: string, updates: Partial<InsertDeal>): Promise<Deal | undefined>;
  getAllDeals(brokerId?: string): Promise<Deal[]>;
  deleteDeal(id: string): Promise<void>;
  
  // Document operations
  createDocument(doc: InsertDocument): Promise<Document>;
  getDocument(id: string): Promise<Document | undefined>;
  getDocumentsByDeal(dealId: string): Promise<Document[]>;
  updateDocument(id: string, updates: Partial<InsertDocument>): Promise<Document | undefined>;
  deleteDocument(id: string): Promise<void>;
  
  // Task operations
  createTask(task: InsertTask): Promise<Task>;
  getTask(id: string): Promise<Task | undefined>;
  getTasksByDeal(dealId: string): Promise<Task[]>;
  updateTask(id: string, updates: Partial<InsertTask>): Promise<Task | undefined>;
  deleteTask(id: string): Promise<void>;
  
  // Seller invite operations
  createSellerInvite(invite: InsertSellerInvite): Promise<SellerInvite>;
  getSellerInviteByToken(token: string): Promise<SellerInvite | undefined>;
  getSellerInvitesByDealId(dealId: string): Promise<SellerInvite[]>;
  updateSellerInvite(id: string, updates: Partial<InsertSellerInvite>): Promise<SellerInvite | undefined>;
  
  // Buyer access operations
  createBuyerAccess(access: InsertBuyerAccess): Promise<BuyerAccess>;
  getBuyerAccessByToken(token: string): Promise<BuyerAccess | undefined>;
  getBuyerAccessByDeal(dealId: string): Promise<BuyerAccess[]>;
  getBuyerAccessUnderReview(): Promise<BuyerAccess[]>;
  updateBuyerAccess(id: string, updates: Partial<InsertBuyerAccess>): Promise<BuyerAccess | undefined>;
  
  // CIM section operations
  createCimSection(section: InsertCimSection): Promise<CimSection>;
  getCimSectionsByDeal(dealId: string): Promise<CimSection[]>;
  updateCimSection(id: string, updates: Partial<InsertCimSection>): Promise<CimSection | undefined>;
  deleteCimSectionsForDeal(dealId: string): Promise<void>;

  // Buyer Q&A operations
  createBuyerQuestion(question: InsertBuyerQuestion): Promise<BuyerQuestion>;
  getQuestionsByDeal(dealId: string): Promise<BuyerQuestion[]>;
  getPublishedQuestions(dealId: string): Promise<BuyerQuestion[]>;
  getQuestionsByApprovalToken(token: string): Promise<BuyerQuestion | undefined>;
  updateBuyerQuestion(id: string, updates: Partial<BuyerQuestion>): Promise<BuyerQuestion | undefined>;

  // Branding operations
  getBrandingSettings(): Promise<BrandingSettings | undefined>;
  getBrandingByBroker(brokerId: string): Promise<BrandingSettings | undefined>;
  createBrandingSettings(settings: InsertBrandingSettings): Promise<BrandingSettings>;
  updateBrandingSettings(id: string, updates: Partial<InsertBrandingSettings>): Promise<BrandingSettings | undefined>;
  
  // Analytics operations
  createAnalyticsEvent(event: InsertAnalyticsEvent): Promise<AnalyticsEvent>;
  getAnalyticsByDeal(dealId: string): Promise<AnalyticsEvent[]>;
  getAnalyticsSummary(dealId?: string): Promise<{
    totalViews: number;
    uniqueBuyers: number;
    avgTimeSpent: number;
    totalTimeSpent: number;
    recentViews: { date: string; count: number }[];
  }>;
  deleteBuyerAccess(id: string): Promise<void>;

  // Engagement insights (learning loop)
  getEngagementInsightsByIndustry(industry: string): Promise<EngagementInsight[]>;
  upsertEngagementInsight(
    industry: string,
    sectionType: string,
    layoutType: string,
    metrics: { timeSeconds: number; scrollDepth?: number }
  ): Promise<void>;

  // FAQ operations
  getFaqsByDeal(dealId: string): Promise<FaqItem[]>;
  createFaq(faq: InsertFaqItem): Promise<FaqItem>;
  updateFaq(id: string, updates: Partial<InsertFaqItem>): Promise<FaqItem | undefined>;
  deleteFaq(id: string): Promise<void>;

  // Integration operations
  getIntegrationsByBroker(brokerId: string): Promise<Integration[]>;
  getAllIntegrations(): Promise<Integration[]>;
  getIntegration(id: string): Promise<Integration | undefined>;
  createIntegration(data: InsertIntegration): Promise<Integration>;
  updateIntegration(id: string, updates: Partial<InsertIntegration>): Promise<Integration | undefined>;
  deleteIntegration(id: string): Promise<void>;

  // Integration email operations
  getIntegrationEmailsByDeal(dealId: string): Promise<IntegrationEmail[]>;
  createIntegrationEmail(data: InsertIntegrationEmail): Promise<IntegrationEmail>;
  deleteIntegrationEmail(id: string): Promise<void>;

  // Financial analysis operations
  createFinancialAnalysis(data: InsertFinancialAnalysis): Promise<FinancialAnalysis>;
  getFinancialAnalysis(id: string): Promise<FinancialAnalysis | undefined>;
  getFinancialAnalysesByDeal(dealId: string): Promise<FinancialAnalysis[]>;
  getLatestFinancialAnalysis(dealId: string): Promise<FinancialAnalysis | undefined>;
  updateFinancialAnalysis(id: string, updates: Partial<InsertFinancialAnalysis>): Promise<FinancialAnalysis | undefined>;

  // Addback verification operations
  createAddbackVerification(data: InsertAddbackVerification): Promise<AddbackVerification>;
  getAddbackVerification(id: string): Promise<AddbackVerification | undefined>;
  getAddbackVerificationByDeal(dealId: string): Promise<AddbackVerification | undefined>;
  updateAddbackVerification(id: string, updates: Partial<InsertAddbackVerification>): Promise<AddbackVerification | undefined>;

  // CIM section overrides (blind/DD versions)
  createCimSectionOverride(data: InsertCimSectionOverride): Promise<CimSectionOverride>;
  getCimSectionOverrides(dealId: string, mode: string): Promise<CimSectionOverride[]>;
  deleteCimSectionOverrides(dealId: string, mode: string): Promise<void>;

  // Discrepancies
  createDiscrepancy(data: InsertDiscrepancy): Promise<Discrepancy>;
  getDiscrepanciesByDeal(dealId: string): Promise<Discrepancy[]>;
  updateDiscrepancy(id: string, updates: Partial<InsertDiscrepancy>): Promise<Discrepancy | undefined>;
  getResolvedDiscrepancies(dealId: string): Promise<Discrepancy[]>;

  // Deal members (team management)
  createDealMember(data: InsertDealMember): Promise<DealMember>;
  getDealMembers(dealId: string): Promise<DealMember[]>;
  getDealMembersByTeam(dealId: string, teamType: string): Promise<DealMember[]>;
  getDealMemberByToken(token: string): Promise<DealMember | undefined>;
  getDealMemberByEmail(dealId: string, email: string): Promise<DealMember | undefined>;
  updateDealMember(id: string, updates: Partial<DealMember>): Promise<DealMember | undefined>;
  deleteDealMember(id: string): Promise<void>;

  // Notifications
  createNotification(data: InsertNotification): Promise<Notification>;
  getNotificationsByRecipient(recipientId: string): Promise<Notification[]>;
  getNotificationsByDeal(dealId: string): Promise<Notification[]>;
  markNotificationRead(id: string): Promise<void>;

  // Buyer approval workflow
  createBuyerApprovalRequest(data: InsertBuyerApprovalRequest): Promise<BuyerApprovalRequest>;
  getBuyerApprovalRequest(id: string): Promise<BuyerApprovalRequest | undefined>;
  getBuyerApprovalRequestByToken(token: string): Promise<BuyerApprovalRequest | undefined>;
  getBuyerApprovalRequestsByDeal(dealId: string): Promise<BuyerApprovalRequest[]>;
  updateBuyerApprovalRequest(id: string, updates: Partial<InsertBuyerApprovalRequest>): Promise<BuyerApprovalRequest | undefined>;

  // Buyer users (accounts)
  createBuyerUser(data: InsertBuyerUser): Promise<BuyerUser>;
  getBuyerUser(id: string): Promise<BuyerUser | undefined>;
  getBuyerUserByEmail(email: string): Promise<BuyerUser | undefined>;
  getBuyerUserByResetToken(token: string): Promise<BuyerUser | undefined>;
  updateBuyerUser(id: string, updates: Partial<BuyerUser>): Promise<BuyerUser | undefined>;
  searchBuyerUsers(query: string): Promise<BuyerUser[]>;
  getBuyerAccessByBuyerUser(buyerUserId: string): Promise<any[]>;

  // Deal outreach (broker-controlled buyer notifications)
  createDealOutreach(data: InsertDealOutreach): Promise<DealOutreach>;
  getDealOutreach(id: string): Promise<DealOutreach | undefined>;
  getDealOutreachByDeal(dealId: string): Promise<DealOutreach[]>;
  getDealOutreachForBuyer(dealId: string, buyerUserId: string): Promise<DealOutreach[]>;
  updateDealOutreach(id: string, updates: Partial<DealOutreach>): Promise<DealOutreach | undefined>;
}

export class MemStorage implements IStorage {
  private users: Map<string, User>;
  private cims: Map<string, Cim>;
  private brandingSettings: BrandingSettings | undefined;

  constructor() {
    this.users = new Map();
    this.cims = new Map();
    this.brandingSettings = undefined;
  }

  async getUser(id: string): Promise<User | undefined> {
    return this.users.get(id);
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find(
      (user) => user.username === username,
    );
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const id = randomUUID();
    const user: User = { 
      ...insertUser, 
      id,
      role: "broker",
      email: null,
      name: null,
      createdAt: new Date(),
    };
    this.users.set(id, user);
    return user;
  }

  async createCim(insertCim: InsertCim): Promise<Cim> {
    const id = randomUUID();
    const now = new Date();
    const cim: Cim = {
      id,
      businessName: insertCim.businessName,
      industry: insertCim.industry,
      description: insertCim.description ?? null,
      questionnaireData: insertCim.questionnaireData ?? null,
      extractedInfo: insertCim.extractedInfo ?? null,
      status: insertCim.status ?? "draft",
      createdAt: now,
      updatedAt: now,
    };
    this.cims.set(id, cim);
    return cim;
  }

  async getCim(id: string): Promise<Cim | undefined> {
    return this.cims.get(id);
  }

  async updateCim(id: string, updates: Partial<InsertCim>): Promise<Cim | undefined> {
    const cim = this.cims.get(id);
    if (!cim) return undefined;

    const updatedCim: Cim = {
      ...cim,
      ...updates,
      updatedAt: new Date(),
    };
    this.cims.set(id, updatedCim);
    return updatedCim;
  }

  async getAllCims(): Promise<Cim[]> {
    return Array.from(this.cims.values()).sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
    );
  }

  async deleteCim(id: string): Promise<void> {
    this.cims.delete(id);
  }

  async getBrandingSettings(): Promise<BrandingSettings | undefined> {
    return this.brandingSettings;
  }

  async createBrandingSettings(insertSettings: InsertBrandingSettings): Promise<BrandingSettings> {
    const id = randomUUID();
    const now = new Date();
    const settings: BrandingSettings = {
      id,
      brokerId: insertSettings.brokerId ?? null,
      companyName: insertSettings.companyName ?? null,
      primaryColor: insertSettings.primaryColor ?? "218 70% 47%",
      accentColor: insertSettings.accentColor ?? "25 95% 53%",
      backgroundColor: insertSettings.backgroundColor ?? "0 0% 100%",
      cardColor: insertSettings.cardColor ?? "0 0% 100%",
      textColor: insertSettings.textColor ?? "224 71% 4%",
      headingFont: insertSettings.headingFont ?? "Inter",
      bodyFont: insertSettings.bodyFont ?? "Inter",
      logoUrl: insertSettings.logoUrl ?? null,
      spacing: insertSettings.spacing ?? "medium",
      borderRadius: insertSettings.borderRadius ?? "medium",
      headerTemplate: insertSettings.headerTemplate ?? null,
      footerTemplate: insertSettings.footerTemplate ?? null,
      disclaimer: insertSettings.disclaimer ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.brandingSettings = settings;
    return settings;
  }

  async updateBrandingSettings(id: string, updates: Partial<InsertBrandingSettings>): Promise<BrandingSettings | undefined> {
    if (!this.brandingSettings || this.brandingSettings.id !== id) {
      return undefined;
    }
    
    const updatedSettings: BrandingSettings = {
      ...this.brandingSettings,
      ...updates,
      updatedAt: new Date(),
    };
    this.brandingSettings = updatedSettings;
    return updatedSettings;
  }

  async createDeal(): Promise<Deal> { throw new Error("Use DbStorage"); }
  async getDeal(): Promise<Deal | undefined> { return undefined; }
  async updateDeal(): Promise<Deal | undefined> { return undefined; }
  async getAllDeals(): Promise<Deal[]> { return []; }
  async deleteDeal(): Promise<void> {}
  async createDocument(): Promise<Document> { throw new Error("Use DbStorage"); }
  async getDocument(): Promise<Document | undefined> { return undefined; }
  async getDocumentsByDeal(): Promise<Document[]> { return []; }
  async updateDocument(): Promise<Document | undefined> { return undefined; }
  async deleteDocument(): Promise<void> {}
  async createTask(): Promise<Task> { throw new Error("Use DbStorage"); }
  async getTask(): Promise<Task | undefined> { return undefined; }
  async getTasksByDeal(): Promise<Task[]> { return []; }
  async updateTask(): Promise<Task | undefined> { return undefined; }
  async deleteTask(): Promise<void> {}
  async createSellerInvite(): Promise<SellerInvite> { throw new Error("Use DbStorage"); }
  async getSellerInviteByToken(): Promise<SellerInvite | undefined> { return undefined; }
  async getSellerInvitesByDealId(): Promise<SellerInvite[]> { return []; }
  async updateSellerInvite(): Promise<SellerInvite | undefined> { return undefined; }
  async createBuyerAccess(): Promise<BuyerAccess> { throw new Error("Use DbStorage"); }
  async getBuyerAccessByToken(): Promise<BuyerAccess | undefined> { return undefined; }
  async getBuyerAccessByDeal(): Promise<BuyerAccess[]> { return []; }
  async getBuyerAccessUnderReview(): Promise<BuyerAccess[]> { return []; }
  async updateBuyerAccess(): Promise<BuyerAccess | undefined> { return undefined; }
  async createCimSection(): Promise<CimSection> { throw new Error("Use DbStorage"); }
  async getCimSectionsByDeal(): Promise<CimSection[]> { return []; }
  async updateCimSection(): Promise<CimSection | undefined> { return undefined; }
  async deleteCimSectionsForDeal(): Promise<void> {}
  async createBuyerQuestion(): Promise<BuyerQuestion> { throw new Error("Use DbStorage"); }
  async getQuestionsByDeal(): Promise<BuyerQuestion[]> { return []; }
  async getPublishedQuestions(): Promise<BuyerQuestion[]> { return []; }
  async getQuestionsByApprovalToken(): Promise<BuyerQuestion | undefined> { return undefined; }
  async updateBuyerQuestion(): Promise<BuyerQuestion | undefined> { return undefined; }
  async getBrandingByBroker(): Promise<BrandingSettings | undefined> { return undefined; }
  async createAnalyticsEvent(): Promise<AnalyticsEvent> { throw new Error("Use DbStorage"); }
  async getAnalyticsByDeal(): Promise<AnalyticsEvent[]> { return []; }
  async getAnalyticsSummary(): Promise<any> { return { totalViews: 0, uniqueBuyers: 0, avgTimeSpent: 0, totalTimeSpent: 0, recentViews: [] }; }
  async getEngagementInsightsByIndustry(): Promise<EngagementInsight[]> { return []; }
  async upsertEngagementInsight(): Promise<void> {}
  async deleteBuyerAccess(): Promise<void> {}
  async getFaqsByDeal(): Promise<FaqItem[]> { return []; }
  async createFaq(): Promise<FaqItem> { throw new Error("Use DbStorage"); }
  async updateFaq(): Promise<FaqItem | undefined> { return undefined; }
  async deleteFaq(): Promise<void> {}
  async getIntegrationsByBroker(): Promise<Integration[]> { return []; }
  async getAllIntegrations(): Promise<Integration[]> { return []; }
  async getIntegration(): Promise<Integration | undefined> { return undefined; }
  async createIntegration(): Promise<Integration> { throw new Error("Use DbStorage"); }
  async updateIntegration(): Promise<Integration | undefined> { return undefined; }
  async deleteIntegration(): Promise<void> {}
  async getIntegrationEmailsByDeal(): Promise<IntegrationEmail[]> { return []; }
  async createIntegrationEmail(): Promise<IntegrationEmail> { throw new Error("Use DbStorage"); }
  async deleteIntegrationEmail(): Promise<void> {}
  async createFinancialAnalysis(): Promise<FinancialAnalysis> { throw new Error("Use DbStorage"); }
  async getFinancialAnalysis(): Promise<FinancialAnalysis | undefined> { return undefined; }
  async getFinancialAnalysesByDeal(): Promise<FinancialAnalysis[]> { return []; }
  async getLatestFinancialAnalysis(): Promise<FinancialAnalysis | undefined> { return undefined; }
  async updateFinancialAnalysis(): Promise<FinancialAnalysis | undefined> { return undefined; }
  async createAddbackVerification(): Promise<AddbackVerification> { throw new Error("Use DbStorage"); }
  async getAddbackVerification(): Promise<AddbackVerification | undefined> { return undefined; }
  async getAddbackVerificationByDeal(): Promise<AddbackVerification | undefined> { return undefined; }
  async updateAddbackVerification(): Promise<AddbackVerification | undefined> { return undefined; }
  async createCimSectionOverride(): Promise<CimSectionOverride> { throw new Error("Use DbStorage"); }
  async getCimSectionOverrides(): Promise<CimSectionOverride[]> { return []; }
  async deleteCimSectionOverrides(): Promise<void> {}
  async createDiscrepancy(): Promise<Discrepancy> { throw new Error("Use DbStorage"); }
  async getDiscrepanciesByDeal(): Promise<Discrepancy[]> { return []; }
  async updateDiscrepancy(): Promise<Discrepancy | undefined> { return undefined; }
  async getResolvedDiscrepancies(): Promise<Discrepancy[]> { return []; }

  // Deal members stubs
  async createDealMember(): Promise<DealMember> { throw new Error("Not implemented"); }
  async getDealMembers(): Promise<DealMember[]> { return []; }
  async getDealMembersByTeam(): Promise<DealMember[]> { return []; }
  async getDealMemberByToken(): Promise<DealMember | undefined> { return undefined; }
  async getDealMemberByEmail(): Promise<DealMember | undefined> { return undefined; }
  async updateDealMember(): Promise<DealMember | undefined> { return undefined; }
  async deleteDealMember(): Promise<void> {}

  // Notification stubs
  async createNotification(): Promise<Notification> { throw new Error("Not implemented"); }
  async getNotificationsByRecipient(): Promise<Notification[]> { return []; }
  async getNotificationsByDeal(): Promise<Notification[]> { return []; }
  async markNotificationRead(): Promise<void> {}

  // Buyer approval stubs
  async createBuyerApprovalRequest(): Promise<BuyerApprovalRequest> { throw new Error("Not implemented"); }
  async getBuyerApprovalRequest(): Promise<BuyerApprovalRequest | undefined> { return undefined; }
  async getBuyerApprovalRequestByToken(): Promise<BuyerApprovalRequest | undefined> { return undefined; }
  async getBuyerApprovalRequestsByDeal(): Promise<BuyerApprovalRequest[]> { return []; }
  async updateBuyerApprovalRequest(): Promise<BuyerApprovalRequest | undefined> { return undefined; }
  async createBuyerUser(): Promise<BuyerUser> { throw new Error("Not implemented"); }
  async getBuyerUser(): Promise<BuyerUser | undefined> { return undefined; }
  async getBuyerUserByEmail(): Promise<BuyerUser | undefined> { return undefined; }
  async getBuyerUserByResetToken(): Promise<BuyerUser | undefined> { return undefined; }
  async updateBuyerUser(): Promise<BuyerUser | undefined> { return undefined; }
  async searchBuyerUsers(): Promise<BuyerUser[]> { return []; }
  async getBuyerAccessByBuyerUser(): Promise<any[]> { return []; }

  // Deal outreach (stubs — DbStorage is the real implementation)
  async createDealOutreach(): Promise<DealOutreach> { throw new Error("Not implemented"); }
  async getDealOutreach(): Promise<DealOutreach | undefined> { return undefined; }
  async getDealOutreachByDeal(): Promise<DealOutreach[]> { return []; }
  async getDealOutreachForBuyer(): Promise<DealOutreach[]> { return []; }
  async updateDealOutreach(): Promise<DealOutreach | undefined> { return undefined; }
}

export class DbStorage implements IStorage {
  async getUser(id: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.id, id));
    return result[0];
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const result = await db.select().from(users).where(eq(users.username, username));
    return result[0];
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const result = await db.insert(users).values(insertUser).returning();
    return result[0];
  }

  // Legacy CIM operations
  async createCim(insertCim: InsertCim): Promise<Cim> {
    const result = await db.insert(cims).values(insertCim).returning();
    return result[0];
  }

  async getCim(id: string): Promise<Cim | undefined> {
    const result = await db.select().from(cims).where(eq(cims.id, id));
    return result[0];
  }

  async updateCim(id: string, updates: Partial<InsertCim>): Promise<Cim | undefined> {
    const result = await db.update(cims)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(cims.id, id))
      .returning();
    return result[0];
  }

  async getAllCims(): Promise<Cim[]> {
    const result = await db.select().from(cims).orderBy(cims.createdAt);
    return result.reverse();
  }

  async deleteCim(id: string): Promise<void> {
    await db.delete(cims).where(eq(cims.id, id));
  }

  // Deal operations
  async createDeal(insertDeal: InsertDeal): Promise<Deal> {
    const result = await db.insert(deals).values(insertDeal).returning();
    return result[0];
  }

  async getDeal(id: string): Promise<Deal | undefined> {
    const result = await db.select().from(deals).where(eq(deals.id, id));
    return result[0];
  }

  async updateDeal(id: string, updates: Partial<InsertDeal>): Promise<Deal | undefined> {
    const result = await db.update(deals)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(deals.id, id))
      .returning();
    return result[0];
  }

  async getAllDeals(brokerId?: string): Promise<Deal[]> {
    if (brokerId) {
      const result = await db.select().from(deals).where(eq(deals.brokerId, brokerId)).orderBy(desc(deals.updatedAt));
      return result;
    }
    const result = await db.select().from(deals).orderBy(desc(deals.updatedAt));
    return result;
  }

  async deleteDeal(id: string): Promise<void> {
    await db.delete(deals).where(eq(deals.id, id));
  }

  // Document operations
  async createDocument(insertDoc: InsertDocument): Promise<Document> {
    const result = await db.insert(documents).values(insertDoc).returning();
    return result[0];
  }

  async getDocument(id: string): Promise<Document | undefined> {
    const result = await db.select().from(documents).where(eq(documents.id, id));
    return result[0];
  }

  async getDocumentsByDeal(dealId: string): Promise<Document[]> {
    const result = await db.select().from(documents).where(eq(documents.dealId, dealId)).orderBy(desc(documents.createdAt));
    return result;
  }

  async updateDocument(id: string, updates: Partial<InsertDocument>): Promise<Document | undefined> {
    const result = await db.update(documents)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(documents.id, id))
      .returning();
    return result[0];
  }

  async deleteDocument(id: string): Promise<void> {
    await db.delete(documents).where(eq(documents.id, id));
  }

  // Task operations
  async createTask(insertTask: InsertTask): Promise<Task> {
    const result = await db.insert(tasks).values(insertTask).returning();
    return result[0];
  }

  async getTask(id: string): Promise<Task | undefined> {
    const result = await db.select().from(tasks).where(eq(tasks.id, id));
    return result[0];
  }

  async getTasksByDeal(dealId: string): Promise<Task[]> {
    const result = await db.select().from(tasks).where(eq(tasks.dealId, dealId)).orderBy(desc(tasks.createdAt));
    return result;
  }

  async updateTask(id: string, updates: Partial<InsertTask>): Promise<Task | undefined> {
    const result = await db.update(tasks)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(tasks.id, id))
      .returning();
    return result[0];
  }

  async deleteTask(id: string): Promise<void> {
    await db.delete(tasks).where(eq(tasks.id, id));
  }

  // Seller invite operations
  async createSellerInvite(insertInvite: InsertSellerInvite): Promise<SellerInvite> {
    const result = await db.insert(sellerInvites).values(insertInvite).returning();
    return result[0];
  }

  async getSellerInviteByToken(token: string): Promise<SellerInvite | undefined> {
    const result = await db.select().from(sellerInvites).where(eq(sellerInvites.token, token));
    return result[0];
  }

  async getSellerInvitesByDealId(dealId: string): Promise<SellerInvite[]> {
    return db.select().from(sellerInvites)
      .where(eq(sellerInvites.dealId, dealId))
      .orderBy(desc(sellerInvites.createdAt));
  }

  async updateSellerInvite(id: string, updates: Partial<InsertSellerInvite>): Promise<SellerInvite | undefined> {
    const result = await db.update(sellerInvites)
      .set(updates)
      .where(eq(sellerInvites.id, id))
      .returning();
    return result[0];
  }

  // Buyer access operations
  async createBuyerAccess(insertAccess: InsertBuyerAccess): Promise<BuyerAccess> {
    const result = await db.insert(buyerAccess).values(insertAccess).returning();
    return result[0];
  }

  async getBuyerAccessByToken(token: string): Promise<BuyerAccess | undefined> {
    const result = await db.select().from(buyerAccess).where(eq(buyerAccess.accessToken, token));
    return result[0];
  }

  async getBuyerAccessByDeal(dealId: string): Promise<BuyerAccess[]> {
    const result = await db.select().from(buyerAccess).where(eq(buyerAccess.dealId, dealId));
    return result;
  }

  async getBuyerAccessUnderReview(): Promise<BuyerAccess[]> {
    // Active buyers who have viewed the CIM but not yet made a decision.
    // Used by the decision-reminder pipeline to escalate outreach.
    const result = await db.select().from(buyerAccess).where(eq(buyerAccess.decision, "under_review"));
    return result.filter(b => !b.revokedAt && b.firstViewedAt);
  }

  async updateBuyerAccess(id: string, updates: Partial<InsertBuyerAccess>): Promise<BuyerAccess | undefined> {
    const result = await db.update(buyerAccess)
      .set(updates)
      .where(eq(buyerAccess.id, id))
      .returning();
    return result[0];
  }

  // CIM section operations
  async createCimSection(insertSection: InsertCimSection): Promise<CimSection> {
    const result = await db.insert(cimSections).values(insertSection).returning();
    return result[0];
  }

  async getCimSectionsByDeal(dealId: string): Promise<CimSection[]> {
    const result = await db.select().from(cimSections).where(eq(cimSections.dealId, dealId)).orderBy(cimSections.order);
    return result;
  }

  async updateCimSection(id: string, updates: Partial<InsertCimSection>): Promise<CimSection | undefined> {
    const result = await db.update(cimSections)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(cimSections.id, id))
      .returning();
    return result[0];
  }

  // Branding operations
  async getBrandingSettings(): Promise<BrandingSettings | undefined> {
    const result = await db.select().from(brandingSettings).limit(1);
    return result[0];
  }

  async createBrandingSettings(insertSettings: InsertBrandingSettings): Promise<BrandingSettings> {
    const result = await db.insert(brandingSettings).values(insertSettings).returning();
    return result[0];
  }

  async updateBrandingSettings(id: string, updates: Partial<InsertBrandingSettings>): Promise<BrandingSettings | undefined> {
    const result = await db.update(brandingSettings)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(brandingSettings.id, id))
      .returning();
    return result[0];
  }

  // Analytics operations
  async createAnalyticsEvent(insertEvent: InsertAnalyticsEvent): Promise<AnalyticsEvent> {
    const result = await db.insert(analyticsEvents).values(insertEvent).returning();
    return result[0];
  }

  async getAnalyticsByDeal(dealId: string): Promise<AnalyticsEvent[]> {
    const result = await db.select()
      .from(analyticsEvents)
      .where(eq(analyticsEvents.dealId, dealId))
      .orderBy(desc(analyticsEvents.createdAt));
    return result;
  }

  async getAnalyticsSummary(dealId?: string): Promise<{
    totalViews: number;
    uniqueBuyers: number;
    avgTimeSpent: number;
    totalTimeSpent: number;
    recentViews: { date: string; count: number }[];
  }> {
    let viewsQuery = db.select({ count: count() })
      .from(analyticsEvents)
      .where(sql`${analyticsEvents.eventType} = 'view'`);
    
    let uniqueBuyersQuery = db.select({ 
      count: sql<number>`COUNT(DISTINCT ${analyticsEvents.buyerAccessId})` 
    })
      .from(analyticsEvents)
      .where(sql`${analyticsEvents.eventType} = 'view'`);
    
    let timeQuery = db.select({
      avg: sql<number>`COALESCE(AVG(${analyticsEvents.timeSpentSeconds}), 0)`,
      total: sql<number>`COALESCE(SUM(${analyticsEvents.timeSpentSeconds}), 0)`
    })
      .from(analyticsEvents)
      .where(sql`${analyticsEvents.eventType} = 'time_on_page'`);

    if (dealId) {
      viewsQuery = db.select({ count: count() })
        .from(analyticsEvents)
        .where(sql`${analyticsEvents.dealId} = ${dealId} AND ${analyticsEvents.eventType} = 'view'`);
      
      uniqueBuyersQuery = db.select({ 
        count: sql<number>`COUNT(DISTINCT ${analyticsEvents.buyerAccessId})` 
      })
        .from(analyticsEvents)
        .where(sql`${analyticsEvents.dealId} = ${dealId} AND ${analyticsEvents.eventType} = 'view'`);
      
      timeQuery = db.select({
        avg: sql<number>`COALESCE(AVG(${analyticsEvents.timeSpentSeconds}), 0)`,
        total: sql<number>`COALESCE(SUM(${analyticsEvents.timeSpentSeconds}), 0)`
      })
        .from(analyticsEvents)
        .where(sql`${analyticsEvents.dealId} = ${dealId} AND ${analyticsEvents.eventType} = 'time_on_page'`);
    }

    const [viewsResult, buyersResult, timeResult] = await Promise.all([
      viewsQuery,
      uniqueBuyersQuery,
      timeQuery
    ]);

    const recentViewsResult = await db.select({
      date: sql<string>`DATE(${analyticsEvents.createdAt})`,
      count: count()
    })
      .from(analyticsEvents)
      .where(dealId 
        ? sql`${analyticsEvents.dealId} = ${dealId} AND ${analyticsEvents.eventType} = 'view' AND ${analyticsEvents.createdAt} > NOW() - INTERVAL '30 days'`
        : sql`${analyticsEvents.eventType} = 'view' AND ${analyticsEvents.createdAt} > NOW() - INTERVAL '30 days'`
      )
      .groupBy(sql`DATE(${analyticsEvents.createdAt})`)
      .orderBy(sql`DATE(${analyticsEvents.createdAt})`);

    return {
      totalViews: viewsResult[0]?.count || 0,
      uniqueBuyers: Number(buyersResult[0]?.count) || 0,
      avgTimeSpent: Number(timeResult[0]?.avg) || 0,
      totalTimeSpent: Number(timeResult[0]?.total) || 0,
      recentViews: recentViewsResult.map(r => ({ date: String(r.date), count: r.count }))
    };
  }

  async deleteBuyerAccess(id: string): Promise<void> {
    await db.delete(buyerAccess).where(eq(buyerAccess.id, id));
  }

  async getFaqsByDeal(dealId: string): Promise<FaqItem[]> {
    const result = await db.select()
      .from(faqItems)
      .where(eq(faqItems.dealId, dealId))
      .orderBy(faqItems.order);
    return result;
  }

  async createFaq(insertFaq: InsertFaqItem): Promise<FaqItem> {
    const result = await db.insert(faqItems).values(insertFaq).returning();
    return result[0];
  }

  async updateFaq(id: string, updates: Partial<InsertFaqItem>): Promise<FaqItem | undefined> {
    const result = await db.update(faqItems)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(faqItems.id, id))
      .returning();
    return result[0];
  }

  async deleteFaq(id: string): Promise<void> {
    await db.delete(faqItems).where(eq(faqItems.id, id));
  }

  async deleteCimSectionsForDeal(dealId: string): Promise<void> {
    await db.delete(cimSections).where(eq(cimSections.dealId, dealId));
  }

  async getBrandingByBroker(brokerId: string): Promise<BrandingSettings | undefined> {
    const result = await db.select().from(brandingSettings)
      .where(eq(brandingSettings.brokerId, brokerId))
      .limit(1);
    return result[0] ?? undefined;
  }

  async createBuyerQuestion(question: InsertBuyerQuestion): Promise<BuyerQuestion> {
    const result = await db.insert(buyerQuestions).values(question).returning();
    return result[0];
  }

  async getQuestionsByDeal(dealId: string): Promise<BuyerQuestion[]> {
    return db.select().from(buyerQuestions)
      .where(eq(buyerQuestions.dealId, dealId))
      .orderBy(buyerQuestions.createdAt);
  }

  async getPublishedQuestions(dealId: string): Promise<BuyerQuestion[]> {
    return db.select().from(buyerQuestions)
      .where(eq(buyerQuestions.dealId, dealId))
      .orderBy(buyerQuestions.createdAt);
  }

  async getQuestionsByApprovalToken(token: string): Promise<BuyerQuestion | undefined> {
    const result = await db.select().from(buyerQuestions)
      .where(eq(buyerQuestions.sellerApprovalToken, token))
      .limit(1);
    return result[0];
  }

  async updateBuyerQuestion(id: string, updates: Partial<BuyerQuestion>): Promise<BuyerQuestion | undefined> {
    const result = await db.update(buyerQuestions)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(buyerQuestions.id, id))
      .returning();
    return result[0];
  }

  async getEngagementInsightsByIndustry(industry: string): Promise<EngagementInsight[]> {
    return db.select()
      .from(engagementInsights)
      .where(eq(engagementInsights.industry, industry))
      .orderBy(desc(engagementInsights.avgTimeSpentSeconds));
  }

  async upsertEngagementInsight(
    industry: string,
    sectionType: string,
    layoutType: string,
    metrics: { timeSeconds: number; scrollDepth?: number }
  ): Promise<void> {
    // Query-then-update: no unique constraint, use rolling weighted average
    const existing = await db.select()
      .from(engagementInsights)
      .where(
        sql`${engagementInsights.industry} = ${industry}
          AND ${engagementInsights.sectionType} = ${sectionType}
          AND ${engagementInsights.layoutType} = ${layoutType}`
      )
      .limit(1);

    if (existing.length > 0) {
      const row = existing[0];
      const n = (row.sampleCount ?? 0) + 1;
      const newAvgTime = Math.round(((row.avgTimeSpentSeconds ?? 0) * (n - 1) + metrics.timeSeconds) / n);
      const newAvgScroll = metrics.scrollDepth != null
        ? Math.round(((row.avgScrollDepthPercent ?? 0) * (n - 1) + metrics.scrollDepth) / n)
        : row.avgScrollDepthPercent;
      await db.update(engagementInsights)
        .set({
          avgTimeSpentSeconds: newAvgTime,
          avgScrollDepthPercent: newAvgScroll ?? 0,
          sampleCount: n,
          updatedAt: new Date(),
        })
        .where(eq(engagementInsights.id, row.id));
    } else {
      await db.insert(engagementInsights).values({
        industry,
        sectionType,
        layoutType,
        avgTimeSpentSeconds: metrics.timeSeconds,
        avgScrollDepthPercent: metrics.scrollDepth ?? 0,
        completionRate: 0,
        returnVisitRate: 0,
        sampleCount: 1,
      });
    }
  }

  // ── Integration operations ──

  async getIntegrationsByBroker(brokerId: string): Promise<Integration[]> {
    return db.select().from(integrations)
      .where(eq(integrations.brokerId, brokerId))
      .orderBy(desc(integrations.createdAt));
  }

  async getAllIntegrations(): Promise<Integration[]> {
    return db.select().from(integrations).orderBy(desc(integrations.createdAt));
  }

  async getIntegration(id: string): Promise<Integration | undefined> {
    const result = await db.select().from(integrations).where(eq(integrations.id, id));
    return result[0];
  }

  async createIntegration(data: InsertIntegration): Promise<Integration> {
    const result = await db.insert(integrations).values(data).returning();
    return result[0];
  }

  async updateIntegration(id: string, updates: Partial<InsertIntegration>): Promise<Integration | undefined> {
    const result = await db.update(integrations)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(integrations.id, id))
      .returning();
    return result[0];
  }

  async deleteIntegration(id: string): Promise<void> {
    await db.delete(integrationEmails).where(eq(integrationEmails.integrationId, id));
    await db.delete(integrations).where(eq(integrations.id, id));
  }

  async getIntegrationEmailsByDeal(dealId: string): Promise<IntegrationEmail[]> {
    return db.select().from(integrationEmails)
      .where(eq(integrationEmails.dealId, dealId))
      .orderBy(integrationEmails.createdAt);
  }

  async createIntegrationEmail(data: InsertIntegrationEmail): Promise<IntegrationEmail> {
    const result = await db.insert(integrationEmails).values(data).returning();
    return result[0];
  }

  async deleteIntegrationEmail(id: string): Promise<void> {
    await db.delete(integrationEmails).where(eq(integrationEmails.id, id));
  }

  // ── Financial analysis operations ──

  async createFinancialAnalysis(data: InsertFinancialAnalysis): Promise<FinancialAnalysis> {
    const result = await db.insert(financialAnalyses).values(data).returning();
    return result[0];
  }

  async getFinancialAnalysis(id: string): Promise<FinancialAnalysis | undefined> {
    const result = await db.select().from(financialAnalyses).where(eq(financialAnalyses.id, id));
    return result[0];
  }

  async getFinancialAnalysesByDeal(dealId: string): Promise<FinancialAnalysis[]> {
    return db.select().from(financialAnalyses)
      .where(eq(financialAnalyses.dealId, dealId))
      .orderBy(desc(financialAnalyses.version));
  }

  async getLatestFinancialAnalysis(dealId: string): Promise<FinancialAnalysis | undefined> {
    const result = await db.select().from(financialAnalyses)
      .where(eq(financialAnalyses.dealId, dealId))
      .orderBy(desc(financialAnalyses.version))
      .limit(1);
    return result[0];
  }

  async updateFinancialAnalysis(id: string, updates: Partial<InsertFinancialAnalysis>): Promise<FinancialAnalysis | undefined> {
    const result = await db.update(financialAnalyses)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(financialAnalyses.id, id))
      .returning();
    return result[0];
  }

  // ── Addback verification operations ──

  async createAddbackVerification(data: InsertAddbackVerification): Promise<AddbackVerification> {
    const result = await db.insert(addbackVerifications).values(data).returning();
    return result[0];
  }

  async getAddbackVerification(id: string): Promise<AddbackVerification | undefined> {
    const result = await db.select().from(addbackVerifications).where(eq(addbackVerifications.id, id));
    return result[0];
  }

  async getAddbackVerificationByDeal(dealId: string): Promise<AddbackVerification | undefined> {
    const result = await db.select().from(addbackVerifications)
      .where(eq(addbackVerifications.dealId, dealId))
      .orderBy(desc(addbackVerifications.updatedAt))
      .limit(1);
    return result[0];
  }

  async updateAddbackVerification(id: string, updates: Partial<InsertAddbackVerification>): Promise<AddbackVerification | undefined> {
    const result = await db.update(addbackVerifications)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(addbackVerifications.id, id))
      .returning();
    return result[0];
  }

  // ── CIM Section Overrides ──

  async createCimSectionOverride(data: InsertCimSectionOverride): Promise<CimSectionOverride> {
    const result = await db.insert(cimSectionOverrides).values(data).returning();
    return result[0];
  }

  async getCimSectionOverrides(dealId: string, mode: string): Promise<CimSectionOverride[]> {
    const { and } = await import("drizzle-orm");
    return db.select().from(cimSectionOverrides)
      .where(and(
        eq(cimSectionOverrides.dealId, dealId),
        eq(cimSectionOverrides.mode, mode),
      ));
  }

  async deleteCimSectionOverrides(dealId: string, mode: string): Promise<void> {
    const { and } = await import("drizzle-orm");
    await db.delete(cimSectionOverrides)
      .where(and(
        eq(cimSectionOverrides.dealId, dealId),
        eq(cimSectionOverrides.mode, mode),
      ));
  }

  // ── Discrepancies ──

  async createDiscrepancy(data: InsertDiscrepancy): Promise<Discrepancy> {
    const result = await db.insert(discrepancies).values(data).returning();
    return result[0];
  }

  async getDiscrepanciesByDeal(dealId: string): Promise<Discrepancy[]> {
    return db.select().from(discrepancies)
      .where(eq(discrepancies.dealId, dealId))
      .orderBy(desc(discrepancies.createdAt));
  }

  async updateDiscrepancy(id: string, updates: Partial<InsertDiscrepancy>): Promise<Discrepancy | undefined> {
    const result = await db.update(discrepancies)
      .set(updates)
      .where(eq(discrepancies.id, id))
      .returning();
    return result[0];
  }

  async getResolvedDiscrepancies(dealId: string): Promise<Discrepancy[]> {
    const { and } = await import("drizzle-orm");
    return db.select().from(discrepancies)
      .where(and(
        eq(discrepancies.dealId, dealId),
        eq(discrepancies.status, "resolved"),
      ));
  }

  // ── Deal Members ─────────────────────────────────────────────────────

  async createDealMember(data: InsertDealMember): Promise<DealMember> {
    const result = await db.insert(dealMembers).values(data).returning();
    return result[0];
  }

  async getDealMembers(dealId: string): Promise<DealMember[]> {
    return db.select().from(dealMembers)
      .where(eq(dealMembers.dealId, dealId))
      .orderBy(dealMembers.createdAt);
  }

  async getDealMembersByTeam(dealId: string, teamType: string): Promise<DealMember[]> {
    const { and } = await import("drizzle-orm");
    return db.select().from(dealMembers)
      .where(and(
        eq(dealMembers.dealId, dealId),
        eq(dealMembers.teamType, teamType),
      ))
      .orderBy(dealMembers.createdAt);
  }

  async getDealMemberByToken(token: string): Promise<DealMember | undefined> {
    const result = await db.select().from(dealMembers)
      .where(eq(dealMembers.inviteToken, token))
      .limit(1);
    return result[0];
  }

  async getDealMemberByEmail(dealId: string, email: string): Promise<DealMember | undefined> {
    const { and } = await import("drizzle-orm");
    const result = await db.select().from(dealMembers)
      .where(and(
        eq(dealMembers.dealId, dealId),
        eq(dealMembers.email, email),
      ))
      .limit(1);
    return result[0];
  }

  async updateDealMember(id: string, updates: Partial<DealMember>): Promise<DealMember | undefined> {
    const result = await db.update(dealMembers)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(dealMembers.id, id))
      .returning();
    return result[0];
  }

  async deleteDealMember(id: string): Promise<void> {
    await db.delete(dealMembers).where(eq(dealMembers.id, id));
  }

  // ── Notifications ────────────────────────────────────────────────────

  async createNotification(data: InsertNotification): Promise<Notification> {
    const result = await db.insert(notifications).values(data).returning();
    return result[0];
  }

  async getNotificationsByRecipient(recipientId: string): Promise<Notification[]> {
    return db.select().from(notifications)
      .where(eq(notifications.recipientId, recipientId))
      .orderBy(desc(notifications.createdAt));
  }

  async getNotificationsByDeal(dealId: string): Promise<Notification[]> {
    return db.select().from(notifications)
      .where(eq(notifications.dealId, dealId))
      .orderBy(desc(notifications.createdAt));
  }

  async markNotificationRead(id: string): Promise<void> {
    await db.update(notifications)
      .set({ readAt: new Date() })
      .where(eq(notifications.id, id));
  }

  // ── Buyer approval workflow ────────────────────────────────────────
  async createBuyerApprovalRequest(data: InsertBuyerApprovalRequest): Promise<BuyerApprovalRequest> {
    const result = await db.insert(buyerApprovalRequests).values(data).returning();
    return result[0];
  }

  async getBuyerApprovalRequest(id: string): Promise<BuyerApprovalRequest | undefined> {
    const result = await db.select().from(buyerApprovalRequests).where(eq(buyerApprovalRequests.id, id));
    return result[0];
  }

  async getBuyerApprovalRequestByToken(token: string): Promise<BuyerApprovalRequest | undefined> {
    const result = await db.select().from(buyerApprovalRequests).where(eq(buyerApprovalRequests.sellerReviewToken, token));
    return result[0];
  }

  async getBuyerApprovalRequestsByDeal(dealId: string): Promise<BuyerApprovalRequest[]> {
    return db.select().from(buyerApprovalRequests)
      .where(eq(buyerApprovalRequests.dealId, dealId))
      .orderBy(desc(buyerApprovalRequests.createdAt));
  }

  async updateBuyerApprovalRequest(id: string, updates: Partial<InsertBuyerApprovalRequest>): Promise<BuyerApprovalRequest | undefined> {
    const result = await db.update(buyerApprovalRequests)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(buyerApprovalRequests.id, id))
      .returning();
    return result[0];
  }

  // ── Buyer users (accounts) ─────────────────────────────────────────
  async createBuyerUser(data: InsertBuyerUser): Promise<BuyerUser> {
    const result = await db.insert(buyerUsers).values(data as any).returning();
    return result[0];
  }

  async getBuyerUser(id: string): Promise<BuyerUser | undefined> {
    const result = await db.select().from(buyerUsers).where(eq(buyerUsers.id, id));
    return result[0];
  }

  async getBuyerUserByEmail(email: string): Promise<BuyerUser | undefined> {
    const result = await db.select().from(buyerUsers).where(eq(buyerUsers.email, email));
    return result[0];
  }

  async getBuyerUserByResetToken(token: string): Promise<BuyerUser | undefined> {
    const result = await db.select().from(buyerUsers).where(eq(buyerUsers.resetToken, token));
    return result[0];
  }

  async updateBuyerUser(id: string, updates: Partial<BuyerUser>): Promise<BuyerUser | undefined> {
    const result = await db.update(buyerUsers)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(buyerUsers.id, id))
      .returning();
    return result[0];
  }

  async searchBuyerUsers(query: string): Promise<BuyerUser[]> {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    // Case-insensitive partial match on email OR name
    const result = await db.select().from(buyerUsers).where(
      sql`LOWER(${buyerUsers.email}) LIKE ${`%${q}%`} OR LOWER(${buyerUsers.name}) LIKE ${`%${q}%`}`
    );
    return result;
  }

  async getBuyerAccessByBuyerUser(buyerUserId: string): Promise<any[]> {
    return db.select().from(buyerAccess)
      .where(eq(buyerAccess.buyerUserId, buyerUserId))
      .orderBy(desc(buyerAccess.lastAccessedAt));
  }

  // ── Broker buyer contacts (broker's personal contact list) ────────
  async createBrokerBuyerContact(data: InsertBrokerBuyerContact): Promise<BrokerBuyerContact> {
    const result = await db.insert(brokerBuyerContacts).values(data as any).returning();
    return result[0];
  }

  async getBrokerBuyerContact(brokerId: string, buyerUserId: string): Promise<BrokerBuyerContact | undefined> {
    const result = await db.select().from(brokerBuyerContacts).where(
      sql`${brokerBuyerContacts.brokerId} = ${brokerId} AND ${brokerBuyerContacts.buyerUserId} = ${buyerUserId}`
    );
    return result[0];
  }

  async upsertBrokerBuyerContact(data: InsertBrokerBuyerContact): Promise<BrokerBuyerContact> {
    // If a row already exists for this (broker, buyer) pair, return it unchanged.
    // Otherwise insert a new one. This is how auto-population (via deal access)
    // stays idempotent with manual additions and CSV imports.
    const existing = await this.getBrokerBuyerContact(data.brokerId, data.buyerUserId);
    if (existing) return existing;
    return this.createBrokerBuyerContact(data);
  }

  async updateBrokerBuyerContact(
    id: string,
    updates: Partial<BrokerBuyerContact>,
  ): Promise<BrokerBuyerContact | undefined> {
    const result = await db.update(brokerBuyerContacts)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(brokerBuyerContacts.id, id))
      .returning();
    return result[0];
  }

  async deleteBrokerBuyerContact(id: string): Promise<void> {
    await db.delete(brokerBuyerContacts).where(eq(brokerBuyerContacts.id, id));
  }

  /**
   * Returns the broker's full contact list. Aggregates three sources:
   *   1. Explicit entries in brokerBuyerContacts (manual, csv, crm)
   *   2. buyerUsers linked to any buyerAccess row on one of the broker's deals
   *   3. buyerUsers invited via invitedByBroker = this broker
   *
   * Deduplicated by buyerUserId. Returns buyer profile + contact metadata
   * + quick stats (number of deals with access, last activity).
   */
  async getBrokerBuyerContactList(brokerId: string): Promise<Array<{
    buyerUser: BuyerUser;
    contact: BrokerBuyerContact | null;
    dealCount: number;
    lastActivityAt: Date | null;
  }>> {
    // Step 1: broker's deals
    const brokerDeals = await db.select({ id: deals.id }).from(deals).where(eq(deals.brokerId, brokerId));
    const brokerDealIds = brokerDeals.map(d => d.id);

    const seen = new Map<string, { lastActivityAt: Date | null; dealCount: number }>();

    // Step 2: buyers who have access to broker's deals
    if (brokerDealIds.length > 0) {
      const accesses = await db.select({
        buyerUserId: buyerAccess.buyerUserId,
        lastAccessedAt: buyerAccess.lastAccessedAt,
        dealId: buyerAccess.dealId,
      })
        .from(buyerAccess)
        .where(sql`${buyerAccess.buyerUserId} IS NOT NULL AND ${buyerAccess.dealId} IN (${sql.join(brokerDealIds.map(id => sql`${id}`), sql`, `)})`);

      for (const a of accesses) {
        if (!a.buyerUserId) continue;
        const entry = seen.get(a.buyerUserId) ?? { lastActivityAt: null, dealCount: 0 };
        entry.dealCount += 1;
        if (a.lastAccessedAt && (!entry.lastActivityAt || a.lastAccessedAt > entry.lastActivityAt)) {
          entry.lastActivityAt = a.lastAccessedAt;
        }
        seen.set(a.buyerUserId, entry);
      }
    }

    // Step 3: manually added contacts (may include buyers with zero deal access yet)
    const contacts = await db.select().from(brokerBuyerContacts).where(eq(brokerBuyerContacts.brokerId, brokerId));
    const contactMap = new Map<string, BrokerBuyerContact>();
    for (const c of contacts) {
      contactMap.set(c.buyerUserId, c);
      if (!seen.has(c.buyerUserId)) {
        seen.set(c.buyerUserId, { lastActivityAt: null, dealCount: 0 });
      }
    }

    // Step 4: buyers invited by this broker (inviteBuyerUser path)
    const invitedBuyers = await db.select().from(buyerUsers).where(eq(buyerUsers.invitedByBroker, brokerId));
    for (const b of invitedBuyers) {
      if (!seen.has(b.id)) {
        seen.set(b.id, { lastActivityAt: null, dealCount: 0 });
      }
    }

    // Step 5: load all buyer user rows at once
    const buyerIds = Array.from(seen.keys());
    if (buyerIds.length === 0) return [];
    const buyers = await db.select().from(buyerUsers).where(
      sql`${buyerUsers.id} IN (${sql.join(buyerIds.map(id => sql`${id}`), sql`, `)})`
    );

    return buyers.map(b => {
      const stats = seen.get(b.id)!;
      return {
        buyerUser: b,
        contact: contactMap.get(b.id) ?? null,
        dealCount: stats.dealCount,
        lastActivityAt: stats.lastActivityAt,
      };
    });
  }

  // ── Deal outreach ────────────────────────────────────────────────────────
  async createDealOutreach(data: InsertDealOutreach): Promise<DealOutreach> {
    const result = await db.insert(dealOutreach).values(data).returning();
    return result[0];
  }

  async getDealOutreach(id: string): Promise<DealOutreach | undefined> {
    const result = await db.select().from(dealOutreach).where(eq(dealOutreach.id, id));
    return result[0];
  }

  async getDealOutreachByDeal(dealId: string): Promise<DealOutreach[]> {
    return await db.select().from(dealOutreach)
      .where(eq(dealOutreach.dealId, dealId))
      .orderBy(desc(dealOutreach.createdAt));
  }

  async getDealOutreachForBuyer(dealId: string, buyerUserId: string): Promise<DealOutreach[]> {
    return await db.select().from(dealOutreach).where(
      sql`${dealOutreach.dealId} = ${dealId} AND ${dealOutreach.buyerUserId} = ${buyerUserId}`
    );
  }

  async updateDealOutreach(id: string, updates: Partial<DealOutreach>): Promise<DealOutreach | undefined> {
    const result = await db.update(dealOutreach)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(dealOutreach.id, id))
      .returning();
    return result[0];
  }
}

export const storage = new DbStorage();
