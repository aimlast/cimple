import type { Express } from "express";
import { createServer, type Server } from "http";
import crypto from "crypto";
import path from "path";
import fs from "fs";
import { storage } from "./storage";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

async function generateSectionWithClaude(
  businessName: string,
  industry: string,
  sectionKey: string,
  extractedInfo: Record<string, any>
): Promise<string> {
  const sectionDescriptions: Record<string, string> = {
    executiveSummary: "Executive Summary — a compelling 2-3 paragraph overview of the business opportunity, highlighting what makes it attractive to buyers",
    companyOverview: "Company Overview — what the business does, its products/services, operating structure, technology, and licenses",
    historyMilestones: "History & Milestones — how the business was founded, how it grew, key achievements and turning points",
    uniqueSellingPropositions: "Competitive Advantages & USPs — specific differentiators that set this business apart from competitors",
    sourcesOfRevenue: "Revenue Sources — how the business makes money, revenue streams, customer mix, concentration",
    growthStrategies: "Growth Opportunities — concrete strategies a new owner could pursue to grow revenue",
    targetMarket: "Target Market & Customers — who buys from this business, demographics, repeat vs new ratio",
    permitsLicenses: "Permits, Licenses & Compliance — all required operating licenses and regulatory requirements",
    seasonality: "Seasonality — busy and slow periods, how the business manages cash flow through cycles",
    locationSite: "Location & Facilities — physical space, lease terms, equipment included in sale",
    employeeOverview: "Employee Overview — team structure, key roles, owner's involvement, transition plan",
    transactionOverview: "Transaction Overview — reason for sale, asking details, training offer, assets included, non-compete",
    financialOverview: "Financial Overview — revenue profile, SDE/EBITDA context, what financial documents are available",
  };

  const desc = sectionDescriptions[sectionKey] || sectionKey;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 600,
    system: `You are a professional business broker writer specializing in Confidential Business Overviews (CBOs) and Confidential Information Memorandums (CIMs). You write compelling, buyer-focused content that presents businesses in their best light while remaining factually accurate. Your writing is concise, professional, and persuasive — it reads like a premium investment document, not a generic template.

Style guidelines:
- 2-3 focused paragraphs per section
- Lead with the strongest point
- Use specific facts and figures whenever available
- Speak directly to a sophisticated buyer
- Use **bold** for key metrics or standout points
- Never use filler phrases like "proven track record" or "well-established" as openers
- Never mention that financials are "available upon NDA" in sections other than the Financial Overview`,
    messages: [
      {
        role: "user",
        content: `Write the "${desc}" section for this business CBO.

Business: ${businessName}
Industry: ${industry}

Collected information:
${JSON.stringify(extractedInfo, null, 2)}

Write only the section content — no section heading, no preamble.`,
      },
    ],
  });

  return (response.content[0] as { type: string; text: string }).text;
}

const SYSTEM_PROMPT = `You are an interviewer collecting specific business information from a seller to create a Confidential Information Memorandum (CIM). Your job is to extract the concrete facts a buyer needs to evaluate this business. Be friendly but direct — every question should target a specific piece of information.

**YOUR APPROACH:**
- Ask ONE direct question at a time
- Keep your responses short — brief acknowledgment (1 sentence max), then your next question
- Ask for SPECIFIC, CONCRETE information — lists, numbers, names, details
- If they give a vague answer, ask them to be more specific. Don't accept "good" or "great" — ask for the actual details
- Be warm but efficient — this is a structured information-gathering session, not a casual chat
- Vary your acknowledgments ("Got it." / "Thanks." / "Perfect." / "Noted.") — don't repeat the same one

**THE INFORMATION YOU MUST COLLECT (in this order):**

1. Products/Services: "List out your main products or services."
2. Owner's Role: "List ALL of your day-to-day responsibilities in the business."
3. Employees: "How many employees do you have? Break it down — full-time, part-time, contractors."
4. Employee Roles: "What does each key employee do? List their roles and responsibilities."
5. Customers: "Describe your typical customer — age range, location, business or consumer, how they find you."
6. Customer Mix: "What percentage of revenue comes from repeat customers vs. new ones? Is any single customer more than 10% of revenue?"
7. What Sets You Apart: "What specifically do you offer that your direct competitors don't? Be specific — not just 'better service.'"
8. Suppliers: "List your main suppliers or vendors. How long have you worked with each? Are there backup options?"
9. Lease/Property: "Do you lease or own your space? If leasing, what's the monthly rent and when does the lease expire?"
10. Equipment/Assets: "List the major equipment and assets included in the sale."
11. Technology: "What software, systems, or technology does the business run on? (POS, CRM, accounting, etc.)"
12. Licenses/Permits: "List all licenses, permits, and certifications required to operate the business."
13. Seasonality: "Does the business have busy and slow periods? Which months are peak and which are slowest?"
14. Growth Opportunities: "What are the top 2-3 specific things a new owner could do to grow revenue?"
15. Reason for Sale: "Why are you selling the business?"

You do NOT need to ask every single one if the information was already provided in earlier answers. Skip what's already been covered.

**HANDLING VAGUE ANSWERS:**

If they say something vague, push for specifics:
- "We have great service" → "What specifically do you do differently? Give me an example."
- "A few employees" → "How many exactly? And what does each person do?"
- "Good customer base" → "How many active customers roughly? What's the split between repeat and new?"
- "Standard equipment" → "Can you list the main pieces? I need specifics for the document."

If they say "I don't know" — accept it and move on. Don't dwell.

**RULES:**
- NEVER ask about revenue totals, profit, EBITDA, or financial statement figures — those come from documents
- You CAN ask about operational costs like rent, and about customer concentration percentages — those are operational facts, not financials
- NEVER ask multiple questions in one message
- NEVER ask fluff questions (what do you enjoy, what's your favorite part, etc.) — every question must target CIM-relevant data
- NEVER use bullet points in your questions — just ask directly
- If they want to stop, respect it immediately and wrap up

**WHEN TO FINISH:**
After collecting the key information above (or after 15+ questions), say: "I think I've got what I need. Is there anything else about the business you think a buyer should know?"

If they say no, wrap up: "Thanks — you've given me everything I need to put together a strong profile. Your broker will take it from here."`;

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

  // Chat endpoint for AI interview
  app.post("/api/chat", async (req, res) => {
    try {
      const { messages, extractedInfo, preliminaryData } = req.body;

      if (!messages || !Array.isArray(messages)) {
        return res.status(400).json({ error: "Messages array is required" });
      }

      // Check if user wants to stop the interview
      const lastUserMessage = messages.filter((m: any) => m.role === "user").slice(-1)[0];
      const stopPhrases = [
        "i'm done", "im done", "that's all", "thats all", "no more", 
        "stop asking", "stop", "enough", "i don't want to", "i dont want to",
        "finish", "complete", "i'm finished", "im finished", "nothing else",
        "nothing more", "that's it", "thats it", "end interview", "quit"
      ];
      
      if (lastUserMessage && stopPhrases.some(phrase => 
        lastUserMessage.content.toLowerCase().includes(phrase)
      )) {
        return res.json({
          message: "Absolutely, let's wrap up here. Thanks so much for sharing all of that — you've painted a really clear picture of the business. Your broker will take it from here!",
          extractedInfo: extractedInfo || {},
          shouldFinish: true
        });
      }

      // Build system prompt with preliminary data context
      let systemPrompt = SYSTEM_PROMPT;

      // Add preliminary questionnaire data context
      if (preliminaryData && Object.keys(preliminaryData).length > 0) {
        const businessName = preliminaryData["Business Name"] || preliminaryData["businessName"] || "this business";
        const industry = preliminaryData["Industry Type"] || preliminaryData["industry"] || "";

        const preliminaryInfo = Object.entries(preliminaryData)
          .filter(([_, value]) => value)
          .map(([key, value]) => `${key}: ${value}`)
          .join("\n");

        systemPrompt += `\n\n**CRITICAL - YOU ARE INTERVIEWING: ${businessName.toUpperCase()}**
${industry ? `This is a ${industry} business.` : ""}

**PRELIMINARY INFORMATION ALREADY COLLECTED:**
The seller has already answered these preliminary questions. DO NOT ask about these topics again:

${preliminaryInfo}

**IMPORTANT CONTEXT RULES:**
1. EVERY question you ask MUST be about "${businessName}" specifically
2. When extracting information, ALWAYS use the business name "${businessName}"
3. If the seller talks about a different business, politely redirect: "Just to confirm, we're discussing ${businessName}, correct?"
4. NEVER confuse this with any other business mentioned in conversation

You already know their:
- Location (city, state/province, country)
- Years in operation
- Business structure (incorporation type)
- Number of employees
- Real estate situation (owned/leased and details)

START the interview by asking about ${businessName}'s CORE BUSINESS OPERATIONS (what they do, products/services), NOT basic info you already have.`;
      }

      // Add already-extracted info as context
      if (extractedInfo && Object.keys(extractedInfo).length > 0) {
        const infoSummary = Object.entries(extractedInfo)
          .filter(([_, value]) => value)
          .map(([key, value]) => `${key}: ${value}`)
          .join("\n");

        systemPrompt += `\n\n**INFORMATION ALREADY EXTRACTED — DO NOT RE-ASK:**\n${infoSummary}\n\nFocus only on what's still missing.`;
      }

      // Build conversation messages for Anthropic (no system role in messages array)
      const conversationMessages = messages.map((msg: any) => ({
        role: msg.role === "ai" ? "assistant" as const : "user" as const,
        content: msg.content,
      }));

      const completion = await anthropic.messages.create({
        model: "claude-sonnet-4-5",
        max_tokens: 400,
        system: systemPrompt,
        messages: conversationMessages,
      });

      const aiResponse = (completion.content[0] as { type: string; text: string }).text;

      // Extract structured information from the full conversation
      const extractionResponse = await anthropic.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 1500,
        system: `Extract business information from this conversation. Return ONLY a valid JSON object with no markdown, no explanation, no code fences. Use null for any field not explicitly mentioned.

Fields to extract:
businessName, industry, keyProducts, ownerInvolvement, employees, employeeStructure, keyEmployees, targetMarket, customerConcentration, customerBase, competitiveAdvantage, uniqueSellingProposition, suppliers, supplyChain, leaseDetails, propertyInfo, assets, assetsIncluded, technologySystems, permitsLicenses, complianceRequirements, seasonality, peakPeriods, growthOpportunities, expansionPlans, reasonForSale, locations, yearsOperating, managementTeam`,
        messages: [
          {
            role: "user",
            content: `Extract business information from this conversation:\n\n${JSON.stringify(messages)}`,
          },
        ],
      });

      let updatedExtractedInfo = extractedInfo || {};
      try {
        const rawText = (extractionResponse.content[0] as { type: string; text: string }).text.trim();
        // Strip any accidental markdown code fences
        const jsonText = rawText.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
        const extracted = JSON.parse(jsonText);

        // Validate business name if we have preliminary data
        if (preliminaryData && preliminaryData["Business Name"]) {
          const expectedName = preliminaryData["Business Name"];
          if (extracted.businessName && extracted.businessName !== expectedName) {
            console.warn(`Business name mismatch! Expected: ${expectedName}, Got: ${extracted.businessName}`);
            extracted.businessName = expectedName;
          }
        }

        // Merge with existing info, preferring new non-null values
        updatedExtractedInfo = {
          ...updatedExtractedInfo,
          ...Object.fromEntries(
            Object.entries(extracted).filter(([_, v]) => v !== null)
          ),
        };
      } catch (e) {
        console.error("Failed to parse extracted info:", e);
      }

      res.json({
        message: aiResponse,
        extractedInfo: updatedExtractedInfo,
      });
    } catch (error: any) {
      console.error("Chat error:", error);
      res.status(500).json({ 
        error: "Failed to process chat message",
        details: error.message 
      });
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
      
      res.json({ access, deal });
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
      if (!deal) {
        return res.status(404).json({ error: "Deal not found" });
      }
      
      const { sectionKey } = req.body;
      const extractedInfo = deal.extractedInfo as Record<string, any> || {};
      const businessName = deal.businessName || "The Business";
      const industry = deal.industry || "a specialized industry";

      if (!sectionKey) {
        const sections = [
          "executiveSummary",
          "companyOverview",
          "historyMilestones",
          "uniqueSellingPropositions",
          "sourcesOfRevenue",
          "growthStrategies",
          "targetMarket",
          "permitsLicenses",
          "seasonality",
          "locationSite",
          "employeeOverview",
          "transactionOverview",
          "financialOverview",
        ];

        // Generate sections sequentially to avoid rate limits
        const cimContent: Record<string, string> = {};
        for (const key of sections) {
          try {
            cimContent[key] = await generateSectionWithClaude(businessName, industry, key, extractedInfo);
          } catch (e) {
            console.error(`Failed to generate ${key}:`, e);
          }
        }

        await storage.updateDeal(deal.id, {
          cimContent,
          phase: "phase3_content_creation",
        });

        res.json({ success: true, cimContent });
        return;
      }

      const content = await generateSectionWithClaude(businessName, industry, sectionKey, extractedInfo);
      res.json({ content });
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
  
  const httpServer = createServer(app);
  return httpServer;
}
