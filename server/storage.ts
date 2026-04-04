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
  users, cims, brandingSettings, deals, documents, tasks, sellerInvites, buyerAccess, cimSections, analyticsEvents, faqItems, buyerQuestions, engagementInsights
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
  updateSellerInvite(id: string, updates: Partial<InsertSellerInvite>): Promise<SellerInvite | undefined>;
  
  // Buyer access operations
  createBuyerAccess(access: InsertBuyerAccess): Promise<BuyerAccess>;
  getBuyerAccessByToken(token: string): Promise<BuyerAccess | undefined>;
  getBuyerAccessByDeal(dealId: string): Promise<BuyerAccess[]>;
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
  async updateSellerInvite(): Promise<SellerInvite | undefined> { return undefined; }
  async createBuyerAccess(): Promise<BuyerAccess> { throw new Error("Use DbStorage"); }
  async getBuyerAccessByToken(): Promise<BuyerAccess | undefined> { return undefined; }
  async getBuyerAccessByDeal(): Promise<BuyerAccess[]> { return []; }
  async updateBuyerAccess(): Promise<BuyerAccess | undefined> { return undefined; }
  async createCimSection(): Promise<CimSection> { throw new Error("Use DbStorage"); }
  async getCimSectionsByDeal(): Promise<CimSection[]> { return []; }
  async updateCimSection(): Promise<CimSection | undefined> { return undefined; }
  async deleteCimSectionsForDeal(): Promise<void> {}
  async createBuyerQuestion(): Promise<BuyerQuestion> { throw new Error("Use DbStorage"); }
  async getQuestionsByDeal(): Promise<BuyerQuestion[]> { return []; }
  async getPublishedQuestions(): Promise<BuyerQuestion[]> { return []; }
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
}

export const storage = new DbStorage();
