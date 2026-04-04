import type { Express } from "express";
import { createServer, type Server } from "http";
import crypto from "crypto";
import path from "path";
import fs from "fs";
import { storage } from "./storage";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { startOrResumeSession, processTurn, getSessionHistory } from "./interview";
import { generateCimLayout } from "./cim/layout-engine.js";
import { aggregateEngagementInsights } from "./cim/learning-loop.js";

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
  }
): Promise<string> {
  const desc = CIM_SECTION_PROMPTS[sectionKey] || sectionKey;

  // Build a structured context block so the model can find relevant data
  const contextParts: string[] = [];

  if (data.description) {
    contextParts.push(`=== BROKER NOTES ===\n${data.description}`);
  }

  const confirmed = Object.entries(data.extractedInfo).filter(([, v]) => v);
  if (confirmed.length > 0) {
    contextParts.push(
      `=== CONFIRMED (from seller interview) ===\n` +
      confirmed.map(([k, v]) => `${k}: ${v}`).join("\n")
    );
  }

  if (data.questionnaireData && Object.keys(data.questionnaireData).length > 0) {
    const qEntries = Object.entries(data.questionnaireData).filter(([, v]) => v);
    if (qEntries.length > 0) {
      contextParts.push(
        `=== FROM QUESTIONNAIRE ===\n` +
        qEntries.map(([k, v]) => `${k}: ${v}`).join("\n")
      );
    }
  }

  if (data.scrapedData && Object.keys(data.scrapedData).length > 0) {
    const sEntries = Object.entries(data.scrapedData).filter(([, v]) => v);
    if (sEntries.length > 0) {
      contextParts.push(
        `=== PUBLICLY FOUND (treat as supporting context only) ===\n` +
        sEntries.map(([k, v]) => `${k}: ${v}`).join("\n")
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
- Prioritize "CONFIRMED (from seller interview)" data above all other sources`,
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
  // Serve uploaded files
  const uploadsDir = path.join(process.cwd(), "public", "uploads");
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }
  app.use("/uploads", (await import("express")).default.static(uploadsDir));

  // Logo upload endpoint (base64 from frontend)
  app.post("/api/upload-logo", async (req, res) => {
    try {
      const { data, filename } = req.body;
      if (!data || !filename) {
        return res.status(400).json({ error: "Missing data or filename" });
      }
      const ext = path.extname(filename).toLowerCase() || ".png";
      const allowed = [".png", ".jpg", ".jpeg", ".svg", ".webp", ".gif"];
      if (!allowed.includes(ext)) {
        return res.status(400).json({ error: "Invalid file type. Allowed: PNG, JPG, SVG, WebP, GIF" });
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
  // NEW: Adaptive AI Interview endpoints
  // =====================

  // Start or resume an interview session for a deal
  app.post("/api/interview/:dealId/start", async (req, res) => {
    try {
      const { dealId } = req.params;
      const result = await startOrResumeSession(dealId);
      res.json(result);
    } catch (error: any) {
      console.error("Interview start error:", error);
      res.status(500).json({ error: error.message || "Failed to start interview" });
    }
  });

  // Send a message in an interview session
  app.post("/api/interview/:dealId/message", async (req, res) => {
    try {
      const { dealId } = req.params;
      const { message, sessionId } = req.body;

      if (!message || typeof message !== "string") {
        return res.status(400).json({ error: "Message string is required" });
      }
      if (!sessionId || typeof sessionId !== "string") {
        return res.status(400).json({ error: "Session ID is required" });
      }

      const result = await processTurn(dealId, sessionId, message);
      res.json(result);
    } catch (error: any) {
      console.error("Interview message error:", error);
      res.status(500).json({ error: error.message || "Failed to process message" });
    }
  });

  // Get conversation history for a session (used when resuming on the frontend)
  app.get("/api/interview/session/:sessionId/history", async (req, res) => {
    try {
      const { sessionId } = req.params;
      const result = await getSessionHistory(sessionId);
      res.json(result);
    } catch (error: any) {
      console.error("Interview history error:", error);
      res.status(500).json({ error: error.message || "Failed to get session history" });
    }
  });

  // CIM CRUD endpoints
  app.get("/api/cims", async (req, res) => {
    try {
      const cims = await storage.getAllCims();
      res.json(cims);
    } catch (error: any) {
      console.error("Error fetching CIMs:", error);
      res.status(500).json({ error: "Failed to fetch CIMs" });
    }
  });

  app.get("/api/cims/:id", async (req, res) => {
    try {
      const cim = await storage.getCim(req.params.id);
      if (!cim) {
        return res.status(404).json({ error: "CIM not found" });
      }
      res.json(cim);
    } catch (error: any) {
      console.error("Error fetching CIM:", error);
      res.status(500).json({ error: "Failed to fetch CIM" });
    }
  });

  app.post("/api/cims", async (req, res) => {
    try {
      const cim = await storage.createCim(req.body);
      res.json(cim);
    } catch (error: any) {
      console.error("Error creating CIM:", error);
      res.status(500).json({ error: "Failed to create CIM" });
    }
  });

  app.patch("/api/cims/:id", async (req, res) => {
    try {
      // If updating extractedInfo, ensure businessName is included
      if (req.body.extractedInfo && typeof req.body.extractedInfo === 'object' && !Array.isArray(req.body.extractedInfo)) {
        const existingCim = await storage.getCim(req.params.id);
        if (existingCim) {
          const questionnaireData = existingCim.questionnaireData as Record<string, any> || {};
          const businessName = questionnaireData["Business Name"] || existingCim.businessName;
          
          // Clone extractedInfo to avoid mutating original request body
          const extractedInfo = { ...req.body.extractedInfo };
          
          // Ensure businessName is in extracted info
          if (businessName && !extractedInfo.businessName) {
            extractedInfo.businessName = businessName;
          }
          
          // Update request body with modified extractedInfo
          req.body = { ...req.body, extractedInfo };
        }
      }
      
      const cim = await storage.updateCim(req.params.id, req.body);
      if (!cim) {
        return res.status(404).json({ error: "CIM not found" });
      }
      res.json(cim);
    } catch (error: any) {
      console.error("Error updating CIM:", error);
      res.status(500).json({ error: "Failed to update CIM" });
    }
  });

  app.delete("/api/cims/:id", async (req, res) => {
    try {
      await storage.deleteCim(req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      console.error("Error deleting CIM:", error);
      res.status(500).json({ error: "Failed to delete CIM" });
    }
  });

  // Branding Settings Routes
  app.get("/api/branding", async (req, res) => {
    try {
      const settings = await storage.getBrandingSettings();
      res.json(settings);
    } catch (error: any) {
      console.error("Error fetching branding settings:", error);
      res.status(500).json({ error: "Failed to fetch branding settings" });
    }
  });

  app.post("/api/branding", async (req, res) => {
    try {
      const { insertBrandingSettingsSchema } = await import("@shared/schema");
      const validatedData = insertBrandingSettingsSchema.parse(req.body);
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

  app.patch("/api/branding/:id", async (req, res) => {
    try {
      const { insertBrandingSettingsSchema } = await import("@shared/schema");
      const validatedData = insertBrandingSettingsSchema.partial().parse(req.body);
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
  
  app.get("/api/deals", async (req, res) => {
    try {
      const { brokerId } = req.query;
      const deals = await storage.getAllDeals(brokerId as string | undefined);
      res.json(deals);
    } catch (error: any) {
      console.error("Error fetching deals:", error);
      res.status(500).json({ error: "Failed to fetch deals" });
    }
  });

  app.get("/api/deals/:id", async (req, res) => {
    try {
      const deal = await storage.getDeal(req.params.id);
      if (!deal) {
        return res.status(404).json({ error: "Deal not found" });
      }
      res.json(deal);
    } catch (error: any) {
      console.error("Error fetching deal:", error);
      res.status(500).json({ error: "Failed to fetch deal" });
    }
  });

  app.post("/api/deals", async (req, res) => {
    try {
      const { insertDealSchema } = await import("@shared/schema");
      const validatedData = insertDealSchema.parse(req.body);
      const deal = await storage.createDeal(validatedData);
      res.json(deal);
    } catch (error: any) {
      if (error.name === "ZodError") {
        return res.status(400).json({ error: "Invalid deal data", details: error.errors });
      }
      console.error("Error creating deal:", error);
      res.status(500).json({ error: "Failed to create deal" });
    }
  });

  // ── Public data scrape ──
  app.post("/api/deals/:dealId/scrape", async (req, res) => {
    try {
      const { dealId } = req.params;
      const { websiteUrl } = req.body as { websiteUrl?: string };
      const { scrapeDeal } = await import("./scraper/index");
      const result = await scrapeDeal(dealId, websiteUrl || undefined);
      res.json(result);
    } catch (error: any) {
      console.error("Scrape error:", error);
      res.status(500).json({ error: error.message || "Failed to scrape website" });
    }
  });

  app.patch("/api/deals/:id", async (req, res) => {
    try {
      const { insertDealSchema } = await import("@shared/schema");
      const validatedData = insertDealSchema.partial().parse(req.body);
      const deal = await storage.updateDeal(req.params.id, validatedData);
      if (!deal) {
        return res.status(404).json({ error: "Deal not found" });
      }
      res.json(deal);
    } catch (error: any) {
      if (error.name === "ZodError") {
        return res.status(400).json({ error: "Invalid deal data", details: error.errors });
      }
      console.error("Error updating deal:", error);
      res.status(500).json({ error: "Failed to update deal" });
    }
  });

  app.delete("/api/deals/:id", async (req, res) => {
    try {
      await storage.deleteDeal(req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      console.error("Error deleting deal:", error);
      res.status(500).json({ error: "Failed to delete deal" });
    }
  });

  // =============================
  // DOCUMENT ROUTES
  // =============================
  
  app.get("/api/deals/:dealId/documents", async (req, res) => {
    try {
      const documents = await storage.getDocumentsByDeal(req.params.dealId);
      res.json(documents);
    } catch (error: any) {
      console.error("Error fetching documents:", error);
      res.status(500).json({ error: "Failed to fetch documents" });
    }
  });

  app.post("/api/deals/:dealId/documents", async (req, res) => {
    try {
      const { insertDocumentSchema } = await import("@shared/schema");
      const validatedData = insertDocumentSchema.parse({
        ...req.body,
        dealId: req.params.dealId,
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

  app.patch("/api/documents/:id", async (req, res) => {
    try {
      const { insertDocumentSchema } = await import("@shared/schema");
      const validatedData = insertDocumentSchema.partial().parse(req.body);
      const document = await storage.updateDocument(req.params.id, validatedData);
      if (!document) {
        return res.status(404).json({ error: "Document not found" });
      }
      res.json(document);
    } catch (error: any) {
      console.error("Error updating document:", error);
      res.status(500).json({ error: "Failed to update document" });
    }
  });

  app.delete("/api/documents/:id", async (req, res) => {
    try {
      await storage.deleteDocument(req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      console.error("Error deleting document:", error);
      res.status(500).json({ error: "Failed to delete document" });
    }
  });

  // =============================
  // TASK ROUTES
  // =============================
  
  app.get("/api/deals/:dealId/tasks", async (req, res) => {
    try {
      const tasks = await storage.getTasksByDeal(req.params.dealId);
      res.json(tasks);
    } catch (error: any) {
      console.error("Error fetching tasks:", error);
      res.status(500).json({ error: "Failed to fetch tasks" });
    }
  });

  app.post("/api/deals/:dealId/tasks", async (req, res) => {
    try {
      const { insertTaskSchema } = await import("@shared/schema");
      const validatedData = insertTaskSchema.parse({
        ...req.body,
        dealId: req.params.dealId,
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

  app.patch("/api/tasks/:id", async (req, res) => {
    try {
      const { insertTaskSchema } = await import("@shared/schema");
      const validatedData = insertTaskSchema.partial().parse(req.body);
      const task = await storage.updateTask(req.params.id, validatedData);
      if (!task) {
        return res.status(404).json({ error: "Task not found" });
      }
      res.json(task);
    } catch (error: any) {
      console.error("Error updating task:", error);
      res.status(500).json({ error: "Failed to update task" });
    }
  });

  app.delete("/api/tasks/:id", async (req, res) => {
    try {
      await storage.deleteTask(req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      console.error("Error deleting task:", error);
      res.status(500).json({ error: "Failed to delete task" });
    }
  });

  // =============================
  // SELLER INVITE ROUTES
  // =============================
  
  app.post("/api/deals/:dealId/invites", async (req, res) => {
    try {
      const { insertSellerInviteSchema } = await import("@shared/schema");
      const token = crypto.randomUUID();
      const validatedData = insertSellerInviteSchema.parse({
        ...req.body,
        dealId: req.params.dealId,
        token,
      });
      const invite = await storage.createSellerInvite(validatedData);
      res.json(invite);
    } catch (error: any) {
      if (error.name === "ZodError") {
        return res.status(400).json({ error: "Invalid invite data", details: error.errors });
      }
      console.error("Error creating invite:", error);
      res.status(500).json({ error: "Failed to create invite" });
    }
  });

  app.get("/api/invites/:token", async (req, res) => {
    try {
      const invite = await storage.getSellerInviteByToken(req.params.token);
      if (!invite) {
        return res.status(404).json({ error: "Invite not found or expired" });
      }
      
      // Get the associated deal
      const deal = await storage.getDeal(invite.dealId);
      if (!deal) {
        return res.status(404).json({ error: "Associated deal not found" });
      }
      
      res.json({ invite, deal });
    } catch (error: any) {
      console.error("Error fetching invite:", error);
      res.status(500).json({ error: "Failed to fetch invite" });
    }
  });

  app.patch("/api/invites/:id", async (req, res) => {
    try {
      const invite = await storage.updateSellerInvite(req.params.id, req.body);
      if (!invite) {
        return res.status(404).json({ error: "Invite not found" });
      }
      res.json(invite);
    } catch (error: any) {
      console.error("Error updating invite:", error);
      res.status(500).json({ error: "Failed to update invite" });
    }
  });

  // =============================
  // BUYER ACCESS ROUTES
  // =============================
  
  app.get("/api/deals/:dealId/buyers", async (req, res) => {
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

  app.post("/api/deals/:dealId/buyers", async (req, res) => {
    try {
      const accessToken = crypto.randomUUID();
      const body = { ...req.body };
      if (body.expiresAt && typeof body.expiresAt === 'string') {
        body.expiresAt = new Date(body.expiresAt);
      }
      const validatedData = {
        dealId: req.params.dealId,
        accessToken,
        buyerEmail: body.buyerEmail,
        buyerName: body.buyerName || null,
        buyerCompany: body.buyerCompany || null,
        expiresAt: body.expiresAt || null,
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

  app.get("/api/view/:token", async (req, res) => {
    try {
      const access = await storage.getBuyerAccessByToken(req.params.token);
      if (!access) {
        return res.status(404).json({ error: "Access denied or link expired" });
      }
      
      // Check expiration
      if (access.expiresAt && new Date(access.expiresAt) < new Date()) {
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
      
      // Update last accessed
      await storage.updateBuyerAccess(access.id, {
        lastAccessedAt: new Date(),
      });

      // Enrich with sections, branding, published Q&A
      const [sections, publishedQuestions, branding] = await Promise.all([
        storage.getCimSectionsByDeal(deal.id),
        storage.getPublishedQuestions(deal.id),
        deal.brokerId ? storage.getBrandingByBroker(deal.brokerId) : Promise.resolve(undefined),
      ]);

      res.json({ access, deal, sections, publishedQuestions, branding: branding ?? null });
    } catch (error: any) {
      console.error("Error fetching buyer access:", error);
      res.status(500).json({ error: "Failed to verify access" });
    }
  });

  app.patch("/api/buyers/:id", async (req, res) => {
    try {
      const access = await storage.updateBuyerAccess(req.params.id, req.body);
      if (!access) {
        return res.status(404).json({ error: "Buyer access not found" });
      }
      res.json(access);
    } catch (error: any) {
      console.error("Error updating buyer access:", error);
      res.status(500).json({ error: "Failed to update buyer access" });
    }
  });

  app.delete("/api/buyer-access/:id", async (req, res) => {
    try {
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
  
  app.get("/api/deals/:dealId/sections", async (req, res) => {
    try {
      const sections = await storage.getCimSectionsByDeal(req.params.dealId);
      res.json(sections);
    } catch (error: any) {
      console.error("Error fetching sections:", error);
      res.status(500).json({ error: "Failed to fetch sections" });
    }
  });

  app.post("/api/deals/:dealId/sections", async (req, res) => {
    try {
      const { insertCimSectionSchema } = await import("@shared/schema");
      const validatedData = insertCimSectionSchema.parse({
        ...req.body,
        dealId: req.params.dealId,
      });
      const section = await storage.createCimSection(validatedData);
      res.json(section);
    } catch (error: any) {
      if (error.name === "ZodError") {
        return res.status(400).json({ error: "Invalid section data", details: error.errors });
      }
      console.error("Error creating section:", error);
      res.status(500).json({ error: "Failed to create section" });
    }
  });

  app.patch("/api/sections/:id", async (req, res) => {
    try {
      const section = await storage.updateCimSection(req.params.id, req.body);
      if (!section) {
        return res.status(404).json({ error: "Section not found" });
      }
      res.json(section);
    } catch (error: any) {
      console.error("Error updating section:", error);
      res.status(500).json({ error: "Failed to update section" });
    }
  });

  // =============================
  // AI CONTENT GENERATION ROUTES
  // =============================
  
  app.post("/api/deals/:dealId/generate-content", async (req, res) => {
    try {
      const deal = await storage.getDeal(req.params.dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });

      const { sectionKey } = req.body;

      const businessName = deal.businessName || "The Business";
      const industry = deal.industry || "a specialized industry";

      // All available data — interview data takes priority, but we pass everything
      const sectionData = {
        extractedInfo: (deal.extractedInfo as Record<string, any>) || {},
        questionnaireData: deal.questionnaireData as Record<string, any> | null,
        scrapedData: (deal as any).scrapedData as Record<string, any> | null,
        description: deal.description,
        askingPrice: deal.askingPrice,
      };

      if (sectionKey) {
        // Single-section regeneration — generate and save back to deal
        if (!CIM_SECTION_PROMPTS[sectionKey]) {
          return res.status(400).json({ error: `Unknown section key: ${sectionKey}` });
        }
        const content = await generateSectionWithClaude(businessName, industry, sectionKey, sectionData);
        const existingContent = (deal.cimContent as Record<string, string>) || {};
        const updated = { ...existingContent, [sectionKey]: content };
        await storage.updateDeal(deal.id, { cimContent: updated });
        res.json({ sectionKey, content });
        return;
      }

      // Generate all sections using CIM_SECTIONS keys
      const { CIM_SECTIONS } = await import("@shared/schema");
      const cimContent: Record<string, string> = {};

      for (const section of CIM_SECTIONS) {
        try {
          cimContent[section.key] = await generateSectionWithClaude(
            businessName, industry, section.key, sectionData
          );
        } catch (e) {
          console.error(`Failed to generate ${section.key}:`, e);
          cimContent[section.key] = "";
        }
      }

      await storage.updateDeal(deal.id, {
        cimContent,
        phase: "phase3_content_creation",
      });

      res.json({ success: true, cimContent });
    } catch (error: any) {
      console.error("Error generating content:", error);
      res.status(500).json({ error: "Failed to generate content" });
    }
  });

  // Generate blind CIM (sanitized version)
  app.post("/api/deals/:dealId/generate-blind", async (req, res) => {
    try {
      const deal = await storage.getDeal(req.params.dealId);
      if (!deal) {
        return res.status(404).json({ error: "Deal not found" });
      }
      
      const cimContent = deal.cimContent as Record<string, string> | null;
      if (!cimContent) {
        return res.status(400).json({ error: "Generate CIM content first" });
      }
      
      const businessName = deal.businessName || "The Business";
      const blindContent: Record<string, string> = {};
      
      for (const [key, content] of Object.entries(cimContent)) {
        let sanitized = content;
        sanitized = sanitized.replace(new RegExp(businessName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '[Company Name]');
        const extractedInfo = deal.extractedInfo as Record<string, any> || {};
        if (extractedInfo.locations) {
          sanitized = sanitized.replace(new RegExp(extractedInfo.locations.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '[Location]');
        }
        blindContent[key] = sanitized;
      }
      
      res.json({ blindContent, blindBusinessName: "[Confidential Business]" });
    } catch (error: any) {
      console.error("Error generating blind CIM:", error);
      res.status(500).json({ error: "Failed to generate blind CIM" });
    }
  });

  // Generate teaser
  app.post("/api/deals/:dealId/generate-teaser", async (req, res) => {
    try {
      const deal = await storage.getDeal(req.params.dealId);
      if (!deal) {
        return res.status(404).json({ error: "Deal not found" });
      }
      
      const extractedInfo = deal.extractedInfo as Record<string, any> || {};
      const businessName = deal.businessName || "The Business";
      const industry = deal.industry || "Business";
      
      const teaser = {
        headline: `${industry} Business Opportunity`,
        summary: `Well-established ${industry.toLowerCase()} business with a strong market position and proven track record. ${extractedInfo.competitiveAdvantage ? `Key differentiator: ${extractedInfo.competitiveAdvantage}.` : ''} ${extractedInfo.employees ? `Team of ${extractedInfo.employees} employees in place.` : ''} ${extractedInfo.growthOpportunities ? `Growth opportunities include: ${extractedInfo.growthOpportunities}.` : ''}`,
        highlights: [
          extractedInfo.yearsOperating ? `${extractedInfo.yearsOperating} years in operation` : `Established ${industry.toLowerCase()} business`,
          extractedInfo.employees ? `${extractedInfo.employees} employees` : "Experienced team in place",
          extractedInfo.competitiveAdvantage || "Strong competitive position",
          extractedInfo.targetMarket ? `Target market: ${extractedInfo.targetMarket}` : "Established customer base",
          extractedInfo.growthOpportunities ? `Growth opportunity: ${extractedInfo.growthOpportunities.substring(0, 80)}` : "Significant growth potential",
        ],
        askingPrice: deal.askingPrice || "Contact for details",
        industry: industry,
        location: extractedInfo.locations || "Contact for details",
      };
      
      res.json(teaser);
    } catch (error: any) {
      console.error("Error generating teaser:", error);
      res.status(500).json({ error: "Failed to generate teaser" });
    }
  });

  // Flag missing info after interview
  app.post("/api/deals/:dealId/flag-missing", async (req, res) => {
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
  app.get("/api/deals/:dealId/faq", async (req, res) => {
    try {
      const faqs = await storage.getFaqsByDeal(req.params.dealId);
      res.json(faqs);
    } catch (error: any) {
      console.error("Error fetching FAQs:", error);
      res.status(500).json({ error: "Failed to fetch FAQs" });
    }
  });

  app.post("/api/deals/:dealId/faq", async (req, res) => {
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

  app.patch("/api/faq/:id", async (req, res) => {
    try {
      const faq = await storage.updateFaq(req.params.id, req.body);
      if (!faq) {
        return res.status(404).json({ error: "FAQ not found" });
      }
      res.json(faq);
    } catch (error: any) {
      console.error("Error updating FAQ:", error);
      res.status(500).json({ error: "Failed to update FAQ" });
    }
  });

  app.delete("/api/faq/:id", async (req, res) => {
    try {
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
      
      if (!buyerAccess) {
        return res.status(404).json({ error: "Access not found" });
      }
      
      const eventSchema = z.object({
        eventType: z.enum(["view", "page_view", "scroll", "download_attempt", "time_on_page"]),
        pageNumber: z.number().optional(),
        sectionKey: z.string().optional(),
        timeSpentSeconds: z.number().optional(),
        scrollDepthPercent: z.number().optional(),
        eventData: z.any().optional(),
      });
      
      const eventData = eventSchema.parse(req.body);
      
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
      
      // Increment view count if it's a view event
      if (eventData.eventType === "view") {
        const currentViewCount = buyerAccess.viewCount || 0;
        await storage.updateBuyerAccess(buyerAccess.id, {
          viewCount: currentViewCount + 1,
          lastAccessedAt: new Date(),
        });
      }
      
      res.json({ success: true, eventId: event.id });
    } catch (error: any) {
      console.error("Error tracking event:", error);
      res.status(400).json({ error: error.message || "Failed to track event" });
    }
  });
  
  // Get analytics summary (broker-wide or per deal)
  app.get("/api/analytics/summary", async (req, res) => {
    try {
      const dealId = req.query.dealId as string | undefined;
      const summary = await storage.getAnalyticsSummary(dealId);
      res.json(summary);
    } catch (error: any) {
      console.error("Error getting analytics:", error);
      res.status(500).json({ error: "Failed to get analytics" });
    }
  });
  
  // Get analytics events for a deal
  app.get("/api/deals/:dealId/analytics", async (req, res) => {
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
  app.get("/api/deals/:dealId/analytics/computed", async (req, res) => {
    try {
      const { dealId } = req.params;
      const [events, buyers, questions] = await Promise.all([
        storage.getAnalyticsByDeal(dealId),
        storage.getBuyerAccessByDeal(dealId),
        storage.getQuestionsByDeal(dealId),
      ]);

      // ── Section engagement ──────────────────────────────────────────────
      // Sum timeSpentSeconds from section_exit events, grouped by sectionKey
      const sectionTime: Record<string, { totalSeconds: number; count: number; title: string }> = {};
      for (const e of events) {
        if (e.eventType === "section_exit" && e.sectionKey && e.timeSpentSeconds) {
          if (!sectionTime[e.sectionKey]) sectionTime[e.sectionKey] = { totalSeconds: 0, count: 0, title: e.sectionKey };
          sectionTime[e.sectionKey].totalSeconds += e.timeSpentSeconds;
          sectionTime[e.sectionKey].count += 1;
        }
      }
      const sectionEngagement = Object.entries(sectionTime)
        .map(([key, v]) => ({
          sectionKey: key,
          avgSeconds: Math.round(v.totalSeconds / v.count),
          totalSeconds: v.totalSeconds,
          viewerCount: v.count,
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
      const buyerBreakdown = buyers.map(b => ({
        ...b,
        totalTimeSeconds: buyerStats[b.id]?.totalSeconds ?? 0,
        sectionsViewedCount: buyerStats[b.id]?.sectionsEntered.size ?? 0,
        maxScrollDepth: buyerStats[b.id]?.maxScrollDepth ?? 0,
        questionCount: buyerStats[b.id]?.questionCount ?? 0,
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
  
  // ════════════════════════════════════════════════════════════
  // PHASE 4 — CIM LAYOUT ENGINE
  // ════════════════════════════════════════════════════════════

  // Generate bespoke CIM layout for a deal
  app.post("/api/deals/:dealId/generate-layout", async (req, res) => {
    try {
      const { dealId } = req.params;
      const deal = await storage.getDeal(dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });

      const [branding, insights] = await Promise.all([
        storage.getBrandingByBroker(deal.brokerId),
        deal.industry ? storage.getEngagementInsightsByIndustry(deal.industry) : Promise.resolve([]),
      ]);

      const document = await generateCimLayout({
        dealId,
        businessName: deal.businessName,
        industry: deal.industry,
        askingPrice: deal.askingPrice,
        extractedInfo: (deal.extractedInfo as Record<string, unknown>) || {},
        scrapedData: (deal.scrapedData as Record<string, unknown>) || null,
        questionnaireData: (deal.questionnaireData as Record<string, unknown>) || null,
        operationalSystems: (deal.operationalSystems as Record<string, unknown>) || null,
        employeeChart: (deal.employeeChart as unknown[]) || null,
        cimContent: (deal.cimContent as Record<string, string>) || null,
        brokerBranding: branding ? {
          companyName: branding.companyName || undefined,
          primaryColor: branding.primaryColor,
        } : null,
        engagementInsights: insights.length > 0 ? insights.map(i => ({
          sectionType: i.sectionType,
          layoutType: i.layoutType,
          avgTimeSpentSeconds: i.avgTimeSpentSeconds ?? 0,
          sampleCount: i.sampleCount ?? 0,
        })) : null,
      });

      // Persist sections to DB — delete old layout sections first, then insert new ones
      await storage.deleteCimSectionsForDeal(dealId);
      for (const section of document.sections) {
        await storage.createCimSection({
          dealId,
          sectionKey: section.sectionKey,
          sectionTitle: section.sectionTitle,
          order: section.order,
          layoutType: section.layoutType,
          layoutData: section.layoutData as any,
          aiLayoutReasoning: section.aiLayoutReasoning,
          tags: section.tags as any,
          aiDraftContent: section.aiDraftContent || null,
          isVisible: section.isVisible,
          brokerApproved: false,
        });
      }

      // Mark layout as generated on the deal
      await storage.updateDeal(dealId, {
        cimLayoutGeneratedAt: new Date(),
        cimLayoutVersion: (deal.cimLayoutVersion || 0) + 1,
      } as any);

      res.json({ sectionCount: document.sections.length, generatedAt: document.generatedAt });
    } catch (error: any) {
      console.error("Layout generation error:", error);
      res.status(500).json({ error: error.message || "Layout generation failed" });
    }
  });

  // Get all CIM layout sections for a deal
  app.get("/api/deals/:dealId/layout", async (req, res) => {
    try {
      const { dealId } = req.params;
      const sections = await storage.getCimSectionsByDeal(dealId);
      res.json(sections);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to get layout" });
    }
  });

  // Update a single CIM section (broker edit, format override, approve)
  app.patch("/api/cim-sections/:sectionId", async (req, res) => {
    try {
      const { sectionId } = req.params;
      const { brokerEditedContent, layoutOverride, layoutData, isVisible, brokerApproved, sectionTitle } = req.body;

      const updated = await storage.updateCimSection(sectionId, {
        ...(brokerEditedContent !== undefined && { brokerEditedContent }),
        ...(layoutOverride !== undefined && { layoutOverride }),
        ...(layoutData !== undefined && { layoutData }),
        ...(isVisible !== undefined && { isVisible }),
        ...(brokerApproved !== undefined && { brokerApproved }),
        ...(sectionTitle !== undefined && { sectionTitle }),
      });
      res.json(updated);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to update section" });
    }
  });

  // Reorder sections
  app.post("/api/deals/:dealId/layout/reorder", async (req, res) => {
    try {
      const { dealId } = req.params;
      const { order }: { order: Array<{ id: string; order: number }> } = req.body;
      for (const item of order) {
        await storage.updateCimSection(item.id, { order: item.order } as any);
      }
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: "Failed to reorder sections" });
    }
  });

  // ════════════════════════════════════════════════════════════
  // PHASE 4 — BUYER Q&A
  // ════════════════════════════════════════════════════════════

  // Buyer submits a question
  app.post("/api/deals/:dealId/questions", async (req, res) => {
    try {
      const { dealId } = req.params;
      const { question, buyerAccessId } = req.body;
      if (!question?.trim()) return res.status(400).json({ error: "Question required" });

      // Check if AI can answer from existing CIM sections
      const sections = await storage.getCimSectionsByDeal(dealId);
      const cimText = sections.map(s => `${s.sectionTitle}: ${s.brokerEditedContent || s.aiDraftContent || ""}`).join("\n\n");

      const aiResponse = await anthropic.messages.create({
        model: "claude-sonnet-4-5",
        max_tokens: 500,
        system: `You are answering buyer questions about a business for sale based strictly on the CIM document provided.
If the answer is clearly in the CIM, answer concisely and professionally.
If the answer is NOT in the CIM, respond with exactly: ESCALATE
Do not speculate or add information not in the CIM.`,
        messages: [{ role: "user", content: `CIM CONTENT:\n${cimText}\n\nBUYER QUESTION: ${question}` }],
      });

      const aiAnswer = aiResponse.content[0].type === "text" ? aiResponse.content[0].text : null;
      const needsEscalation = !aiAnswer || aiAnswer.trim() === "ESCALATE";

      const saved = await storage.createBuyerQuestion({
        dealId,
        buyerAccessId: buyerAccessId || null,
        question,
        aiAnswer: needsEscalation ? null : aiAnswer,
        status: needsEscalation ? "pending_broker" : "published",
        isPublished: !needsEscalation,
        publishedAnswer: needsEscalation ? null : aiAnswer,
        addedToKnowledgeBase: false,
      } as any);

      res.json({
        id: saved.id,
        answer: needsEscalation ? null : aiAnswer,
        status: needsEscalation ? "pending_broker" : "published",
        message: needsEscalation
          ? "Great question — your broker will respond shortly."
          : aiAnswer,
      });
    } catch (error: any) {
      res.status(500).json({ error: "Failed to process question" });
    }
  });

  // Get published Q&A for a deal (buyer-facing)
  app.get("/api/deals/:dealId/questions/published", async (req, res) => {
    try {
      const { dealId } = req.params;
      const questions = await storage.getPublishedQuestions(dealId);
      res.json(questions);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to get questions" });
    }
  });

  // Get all questions for broker dashboard
  app.get("/api/deals/:dealId/questions", async (req, res) => {
    try {
      const { dealId } = req.params;
      const questions = await storage.getQuestionsByDeal(dealId);
      res.json(questions);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to get questions" });
    }
  });

  // Broker drafts/updates answer
  app.patch("/api/questions/:questionId", async (req, res) => {
    try {
      const { questionId } = req.params;
      const { brokerDraft, status, publishedAnswer, isPublished } = req.body;

      const updated = await storage.updateBuyerQuestion(questionId, {
        ...(brokerDraft !== undefined && { brokerDraft }),
        ...(status !== undefined && { status }),
        ...(publishedAnswer !== undefined && { publishedAnswer }),
        ...(isPublished !== undefined && { isPublished }),
      } as any);
      res.json(updated);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to update question" });
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

      const ip = req.ip || req.socket.remoteAddress || null;
      const ua = req.headers["user-agent"] || null;

      for (const event of events) {
        await storage.createAnalyticsEvent({
          dealId,
          buyerAccessId: event.buyerAccessId || null,
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
          ipAddress: ip,
          userAgent: ua,
        } as any);
      }

      res.json({ received: events.length });

      // Fire-and-forget: aggregate section_exit events into engagementInsights
      aggregateEngagementInsights(dealId, events, storage).catch(err =>
        console.warn("[learning-loop] aggregation error:", err)
      );
    } catch (error: any) {
      res.status(500).json({ error: "Failed to record events" });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}
