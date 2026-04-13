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
import multer from "multer";
import { extractTextFromFile } from "./documents/parser.js";
import { extractDocumentData, mergeExtractedData } from "./documents/extractor.js";
import { notify, sendDirectEmail } from "./notifications/service.js";
import { prefillBuyerFromCrm, searchBuyersInCrm } from "./crm/buyer-prefill.js";
import { registerBuyerAuthRoutes, inviteBuyerUser } from "./buyer-auth/routes.js";
import { registerBuyerDashboardRoutes } from "./buyer-auth/dashboard.js";
import { syncDealToCrm, describeCrmAction, crmProviderLabel, getConnectedCrmProvider } from "./crm/sync.js";
import { runDecisionReminders } from "./reminders/decision-reminders.js";
import { TEAM_ROLES, BUYER_NEXT_STEPS, BUYER_CATEGORIES, riskLevelForCategory, insertBuyerApprovalRequestSchema, type BuyerUser } from "@shared/schema";

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

  // ── Buyer authentication + dashboard ─────────────────────────────────
  registerBuyerAuthRoutes(app);
  registerBuyerDashboardRoutes(app);

  // Broker-side: search existing buyer accounts by email/name (for the
  // "add buyer" autocomplete — hits before falling through to CRM)
  app.get("/api/buyer-users/search", async (req, res) => {
    try {
      const q = String(req.query.q || "");
      if (q.length < 2) return res.json({ results: [] });
      const users = await storage.searchBuyerUsers(q);
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
  app.get("/api/broker/buyers", async (req, res) => {
    try {
      const brokerId = String(req.query.brokerId || "default-broker");
      const list = await storage.getBrokerBuyerContactList(brokerId);
      const { calculateQualifiedLeadScore } = await import("./scoring/buyer-score.js");

      res.json({
        buyers: list.map(({ buyerUser, contact, dealCount, lastActivityAt }) => {
          // Profile-only composite score (no deal context — match-fit weight
          // is redistributed across profile/engagement/proofOfFunds).
          const score = calculateQualifiedLeadScore({ buyer: buyerUser });
          return {
            id: buyerUser.id,
            email: buyerUser.email,
            name: buyerUser.name,
            phone: buyerUser.phone,
            company: buyerUser.company,
            title: buyerUser.title,
            linkedinUrl: buyerUser.linkedinUrl,
            buyerType: buyerUser.buyerType,
            background: buyerUser.background,
            liquidFunds: buyerUser.liquidFunds,
            hasProofOfFunds: buyerUser.hasProofOfFunds,
            targetIndustries: buyerUser.targetIndustries,
            targetLocations: buyerUser.targetLocations,
            profileCompletionPct: buyerUser.profileCompletionPct,
            source: contact?.source ?? buyerUser.source ?? "deal",
            tags: contact?.tags ?? [],
            notes: contact?.notes ?? null,
            contactId: contact?.id ?? null,
            addedAt: contact?.addedAt ?? buyerUser.createdAt,
            dealCount,
            lastActivityAt,
            qualifiedScore: {
              total: score.total,
              tier: score.tier,
              reasons: score.reasons,
            },
          };
        }),
      });
    } catch (err: any) {
      console.error("Error fetching broker buyer list:", err);
      res.status(500).json({ error: "Failed to fetch buyer list" });
    }
  });

  // Get details for a single buyer (for detail drawer)
  app.get("/api/broker/buyers/:buyerId", async (req, res) => {
    try {
      const brokerId = String(req.query.brokerId || "default-broker");
      const buyer = await storage.getBuyerUser(req.params.buyerId);
      if (!buyer) return res.status(404).json({ error: "Buyer not found" });

      const contact = await storage.getBrokerBuyerContact(brokerId, buyer.id);

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
        buyer: {
          id: buyer.id,
          email: buyer.email,
          name: buyer.name,
          phone: buyer.phone,
          company: buyer.company,
          title: buyer.title,
          linkedinUrl: buyer.linkedinUrl,
          buyerType: buyer.buyerType,
          background: buyer.background,
          liquidFunds: buyer.liquidFunds,
          hasProofOfFunds: buyer.hasProofOfFunds,
          targetIndustries: buyer.targetIndustries,
          targetLocations: buyer.targetLocations,
          buyerCriteria: buyer.buyerCriteria,
          profileCompletionPct: buyer.profileCompletionPct,
          source: contact?.source ?? buyer.source,
          createdAt: buyer.createdAt,
          lastLoginAt: buyer.lastLoginAt,
        },
        contact: contact ? {
          id: contact.id,
          tags: contact.tags,
          notes: contact.notes,
          source: contact.source,
          addedAt: contact.addedAt,
        } : null,
        deals: dealsWithAccess,
      });
    } catch (err: any) {
      console.error("Error fetching buyer detail:", err);
      res.status(500).json({ error: "Failed to fetch buyer detail" });
    }
  });

  // Manually add a single buyer (form flow)
  app.post("/api/broker/buyers", async (req, res) => {
    try {
      const schema = z.object({
        brokerId: z.string().default("default-broker"),
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
          buyerUser = await storage.updateBuyerUser(buyerUser.id, updates);
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
          profileCompletionPct: 0,
          emailVerified: false,
          source: "broker_invited",
          invitedByBroker: body.brokerId,
          invitedByDeal: null,
          resetToken: null,
          resetTokenExpiresAt: null,
        } as any);
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

      res.json({ buyerUser, contact });
    } catch (err: any) {
      if (err.name === "ZodError") {
        return res.status(400).json({ error: "Invalid buyer data", details: err.errors });
      }
      console.error("Error creating broker buyer contact:", err);
      res.status(500).json({ error: "Failed to create buyer" });
    }
  });

  // Bulk import via CSV
  app.post("/api/broker/buyers/import-csv", async (req, res) => {
    try {
      const schema = z.object({
        brokerId: z.string().default("default-broker"),
        csv: z.string().min(1),
        sendInvites: z.boolean().default(false),
      });
      const body = schema.parse(req.body);

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
              buyerUser = await storage.updateBuyerUser(buyerUser.id, updates);
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
              profileCompletionPct: 0,
              emailVerified: false,
              source: "broker_invited",
              invitedByBroker: body.brokerId,
              invitedByDeal: null,
              resetToken: null,
              resetTokenExpiresAt: null,
            } as any);
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
  app.patch("/api/broker/buyers/:buyerId", async (req, res) => {
    try {
      const brokerId = String(req.query.brokerId || "default-broker");
      const schema = z.object({
        tags: z.array(z.string()).optional(),
        notes: z.string().nullable().optional(),
      });
      const updates = schema.parse(req.body);

      let contact = await storage.getBrokerBuyerContact(brokerId, req.params.buyerId);
      if (!contact) {
        // Auto-upsert so tags/notes can be set on buyers first seen via deal access
        contact = await storage.upsertBrokerBuyerContact({
          brokerId,
          buyerUserId: req.params.buyerId,
          source: "deal",
          tags: [],
          notes: null,
        });
      }

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
  app.get("/api/deals/:dealId/suggested-buyers", async (req, res) => {
    try {
      const { dealId } = req.params;
      const deal = await storage.getDeal(dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });

      const { matchBuyerToDeal } = await import("./matching/engine.js");
      const { calculateQualifiedLeadScore } = await import("./scoring/buyer-score.js");

      // Pull the broker's full buyer contact list (deal-access + manual + invited)
      const list = await storage.getBrokerBuyerContactList(deal.brokerId);

      // For "exclude already contacted" filter
      const existingOutreach = await storage.getDealOutreachByDeal(dealId);
      const contactedBuyerIds = new Set(existingOutreach.map(o => o.buyerUserId));

      // Already-granted access (don't suggest re-contacting)
      const existingAccess = await storage.getBuyerAccessByDeal(dealId);
      const accessBuyerIds = new Set(
        existingAccess.filter(a => a.buyerUserId).map(a => a.buyerUserId as string),
      );

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

      // Score every buyer in parallel (skipAI for speed; broker can request
      // a deeper rescore for the top N later if desired)
      const scored = await Promise.all(list.map(async ({ buyerUser, contact, lastActivityAt }) => {
        const criteria: any = {
          ...(buyerUser.buyerCriteria as any || {}),
          targetIndustries: buyerUser.targetIndustries || [],
          targetLocations: buyerUser.targetLocations || [],
        };

        let breakdown: any = null;
        try {
          breakdown = await matchBuyerToDeal(
            criteria,
            {
              industry: deal.industry || "",
              subIndustry: (deal as any).subIndustry,
              askingPrice: (deal as any).askingPrice,
              extractedInfo: (deal as any).extractedInfo || {},
            },
            { skipAI: true },
          );
        } catch {}

        const score = calculateQualifiedLeadScore({
          buyer: buyerUser,
          match: breakdown,
        });

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
          alreadyHasAccess: accessBuyerIds.has(buyerUser.id),
          alreadyContacted: contactedBuyerIds.has(buyerUser.id),
          match: breakdown ? {
            criteriaMatched: breakdown.criteriaMatched,
            criteriaTested: breakdown.criteriaTested,
            deterministicScore: breakdown.deterministicScore,
            topDimensions: topDimsFromBreakdown(breakdown),
          } : null,
          qualifiedScore: {
            total: score.total,
            tier: score.tier,
            reasons: score.reasons,
            breakdown: score.breakdown,
          },
          lastActivityAt,
        };
      }));

      // Sort: highest qualifiedScore first; ties broken by criteriaMatched
      scored.sort((a, b) => {
        if (b.qualifiedScore.total !== a.qualifiedScore.total) {
          return b.qualifiedScore.total - a.qualifiedScore.total;
        }
        return (b.match?.criteriaMatched ?? 0) - (a.match?.criteriaMatched ?? 0);
      });

      res.json({
        dealId,
        businessName: deal.businessName,
        industry: deal.industry,
        suggested: scored,
        totalCandidates: scored.length,
      });
    } catch (err: any) {
      console.error("Error fetching suggested buyers:", err);
      res.status(500).json({ error: "Failed to fetch suggested buyers" });
    }
  });

  // Draft outreach emails for selected buyers (AI-generated, never sent automatically).
  // Returns drafts in-memory; the broker reviews and edits before calling /send-outreach.
  app.post("/api/deals/:dealId/draft-outreach", async (req, res) => {
    try {
      const { dealId } = req.params;
      const schema = z.object({
        buyerUserIds: z.array(z.string()).min(1),
        template: z.string().optional(),  // optional broker template / instructions
      });
      const { buyerUserIds, template } = schema.parse(req.body);

      const deal = await storage.getDeal(dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });

      const branding = await storage.getBrandingByBroker(deal.brokerId);
      const brokerCompany = (branding as any)?.companyName || "your broker";

      const extracted: any = (deal as any).extractedInfo || {};
      const dealSummary = {
        businessName: deal.businessName,
        industry: deal.industry,
        subIndustry: (deal as any).subIndustry,
        askingPrice: (deal as any).askingPrice,
        revenue: extracted.annualRevenue,
        ebitda: extracted.ebitda || extracted.adjustedEbitda,
        sde: extracted.sde,
        location: extracted.locationSite || extracted.location,
        description: extracted.executiveSummary || (deal as any).description,
        yearsOperating: extracted.yearsOperating,
      };

      // Draft each email in parallel
      const drafts = await Promise.all(buyerUserIds.map(async (buyerUserId) => {
        const buyer = await storage.getBuyerUser(buyerUserId);
        if (!buyer) return null;

        const buyerProfile = {
          name: buyer.name,
          company: buyer.company,
          buyerType: buyer.buyerType,
          targetIndustries: buyer.targetIndustries,
          targetLocations: buyer.targetLocations,
        };

        // Try to use Claude Sonnet to personalise; fall back to a deterministic
        // template if the API is unavailable.
        let subject = `New opportunity: ${deal.businessName} (${deal.industry})`;
        let body = "";

        try {
          const aiResp = await anthropic.messages.create({
            model: "claude-sonnet-4-5",
            max_tokens: 600,
            system: `You are an M&A broker drafting a personalised, low-pressure outreach email to a qualified buyer about a new business-for-sale opportunity. The tone is professional, warm, and concise — not salesy. Always include a clear, no-pressure invitation to learn more. The broker reviews and sends, so you're drafting on their behalf, but they will edit. Return ONLY a JSON object: {"subject": "...", "body": "..."}.`,
            messages: [{
              role: "user",
              content: `Draft an outreach email for this buyer about this deal.

DEAL:
${JSON.stringify(dealSummary, null, 2)}

BUYER PROFILE:
${JSON.stringify(buyerProfile, null, 2)}

BROKER FIRM: ${brokerCompany}

${template ? `BROKER NOTES / TEMPLATE GUIDANCE:\n${template}` : ""}

Requirements:
- Subject line: under 70 chars, mentions the industry and a key signal (size, location, or growth)
- Body: 4–6 short paragraphs max, ~150 words
- Reference 1–2 specific things from the buyer's profile (their target industry/location/buyer type)
- Mention 2–3 deal highlights (revenue, growth, location, size)
- Include a clear next-step invitation: "If you'd like a closer look, just reply and I'll set up secure access to the full overview"
- DO NOT include the asking price unless it's clearly listed
- DO NOT make up financial figures
- DO NOT promise exclusivity or discounts
- Sign off as the broker (use placeholder "[Broker name]")

Return JSON only.`,
            }],
          });

          const raw = aiResp.content[0].type === "text" ? aiResp.content[0].text : "";
          const parsed = JSON.parse(raw.replace(/```json\s*/gi, "").replace(/```/g, "").trim());
          if (parsed.subject) subject = parsed.subject;
          if (parsed.body) body = parsed.body;
        } catch (aiErr) {
          console.warn("[outreach] AI draft failed for", buyer.email, "— falling back to template");
          // Deterministic fallback
          body = `Hi ${buyer.name.split(" ")[0]},\n\nI'm reaching out because ${deal.businessName} just came to market and it looks like a strong fit for your acquisition criteria${buyer.targetIndustries && (buyer.targetIndustries as string[]).length > 0 ? ` in ${(buyer.targetIndustries as string[]).slice(0, 2).join(" / ")}` : ""}.\n\nQuick highlights:\n• Industry: ${deal.industry}${dealSummary.subIndustry ? ` (${dealSummary.subIndustry})` : ""}\n${dealSummary.revenue ? `• Revenue: ${dealSummary.revenue}\n` : ""}${dealSummary.location ? `• Location: ${dealSummary.location}\n` : ""}\nIf you'd like a closer look, just reply and I'll set up secure access to the full confidential overview.\n\nNo pressure either way — happy to answer questions if it's a fit.\n\nBest,\n[Broker name]\n${brokerCompany}`;
        }

        return {
          buyerUserId: buyer.id,
          buyerName: buyer.name,
          buyerEmail: buyer.email,
          subject,
          body,
        };
      }));

      const validDrafts = drafts.filter((d): d is NonNullable<typeof d> => !!d);
      res.json({ drafts: validDrafts });
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
  app.post("/api/deals/:dealId/send-outreach", async (req, res) => {
    try {
      const { dealId } = req.params;
      const schema = z.object({
        outreach: z.array(z.object({
          buyerUserId: z.string(),
          subject: z.string().min(1),
          body: z.string().min(1),
          // Optional snapshot data captured at suggestion time
          qualifiedScore: z.number().optional(),
          matchScore: z.number().optional(),
          topDimensions: z.array(z.string()).optional(),
        })).min(1),
      });
      const { outreach } = schema.parse(req.body);

      const deal = await storage.getDeal(dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });

      const branding = await storage.getBrandingByBroker(deal.brokerId);
      const brokerCompany = (branding as any)?.companyName || "Cimple";

      const results = await Promise.all(outreach.map(async (item) => {
        const buyer = await storage.getBuyerUser(item.buyerUserId);
        if (!buyer) {
          return { buyerUserId: item.buyerUserId, status: "failed", error: "Buyer not found" };
        }

        // Render plain-text body into a simple HTML wrapper
        const htmlBody = item.body
          .split("\n\n")
          .map(p => `<p style="margin:0 0 16px 0;color:#333;font-size:14px;line-height:1.6;">${p.replace(/\n/g, "<br/>")}</p>`)
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
    Sent via Cimple on behalf of ${brokerCompany}
  </p>
</body>
</html>`;

        const sent = await sendDirectEmail(buyer.email, item.subject, html);

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
          body: item.body,
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
      }));

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
  app.get("/api/deals/:dealId/outreach-history", async (req, res) => {
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
  // =====================
  // Seller EQ Profile endpoints
  // =====================

  // Generate or refresh the seller communication profile
  app.post("/api/deals/:dealId/seller-profile/generate", async (req, res) => {
    try {
      const { dealId } = req.params;
      const { generateSellerProfile } = await import("./interview/eq-profiler");
      const profile = await generateSellerProfile(dealId);
      // Store on deal record
      await storage.updateDeal(dealId, { sellerProfile: profile } as any);
      res.json(profile);
    } catch (error: any) {
      console.error("[EQ profiler] Generation failed:", error);
      res.status(500).json({ error: error.message || "Failed to generate seller profile" });
    }
  });

  // Get the current seller profile
  app.get("/api/deals/:dealId/seller-profile", async (req, res) => {
    try {
      const deal = await storage.getDeal(req.params.dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });
      res.json(deal.sellerProfile || null);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Broker overrides — update specific fields on the profile
  app.patch("/api/deals/:dealId/seller-profile", async (req, res) => {
    try {
      const deal = await storage.getDeal(req.params.dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });

      const existingProfile = (deal.sellerProfile as Record<string, any>) || {};
      const overrides = req.body;

      // Merge overrides into existing profile, tracking what the broker changed
      const brokerOverrides = { ...(existingProfile.brokerOverrides || {}), ...overrides, updatedAt: new Date().toISOString() };
      const updatedProfile = { ...existingProfile, ...overrides, brokerOverrides };

      await storage.updateDeal(req.params.dealId, { sellerProfile: updatedProfile } as any);
      res.json(updatedProfile);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // NEW: Adaptive AI Interview endpoints
  // =====================

  // List all interview sessions for a deal (broker transcript view)
  app.get("/api/deals/:dealId/sessions", async (req, res) => {
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
        };
      });

      res.json(result);
    } catch (error: any) {
      console.error("Error fetching deal sessions:", error);
      res.status(500).json({ error: "Failed to fetch interview sessions" });
    }
  });

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

      // Auto-populate document requirements from industry intelligence
      if (deal.industry) {
        try {
          const { populateDocumentRequirements } = await import("./documents/requirements");
          await populateDocumentRequirements(deal.id, deal.industry);
        } catch (e) {
          // Non-fatal — deal still created, requirements can be populated later
          console.warn("Auto-populate document requirements failed:", e);
        }
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
  app.get("/api/broker/dashboard", async (req, res) => {
    try {
      const allDeals = await storage.getAllDeals();

      // ─ Pipeline snapshot: group deals by phase ─
      const phaseLabels: Record<string, string> = {
        phase1_info_collection: "Info Collection",
        phase2_platform_intake: "Platform Intake",
        phase3_content_creation: "Content Creation",
        phase4_design_finalization: "Design Finalization",
      };
      const phaseKeys = Object.keys(phaseLabels);
      const pipeline = phaseKeys.map((phase) => {
        const phaseDeals = allDeals.filter((d) => d.phase === phase);
        const totalAskingPrice = phaseDeals.reduce((sum, d) => {
          const price = parseFloat((d.askingPrice || "0").replace(/[^0-9.]/g, ""));
          return sum + (isNaN(price) ? 0 : price);
        }, 0);
        return {
          phase,
          label: phaseLabels[phase],
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
      const totalPipelineValue = activeDeals.reduce((sum, d) => {
        const price = parseFloat((d.askingPrice || "0").replace(/[^0-9.]/g, ""));
        return sum + (isNaN(price) ? 0 : price);
      }, 0);
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
      const pendingApprovals: Array<{ dealId: string; dealName: string; buyerName: string; buyerCompany: string | null; submittedAt: string }> = [];
      const unansweredQuestions: Array<{ dealId: string; dealName: string; questionPreview: string; askedAt: string }> = [];
      const pendingReviewCIMs: Array<{ dealId: string; dealName: string }> = [];

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
            });
          }
        }

        // Unanswered Q&A
        for (const q of questions) {
          if (q.status === "pending_broker") {
            unansweredQuestions.push({
              dealId: deal.id,
              dealName: deal.businessName,
              questionPreview: q.question.slice(0, 120),
              askedAt: q.createdAt?.toISOString?.() ?? new Date(q.createdAt).toISOString(),
            });
          }
        }

        // CIMs ready for broker review
        if (deal.status === "pending_review") {
          pendingReviewCIMs.push({ dealId: deal.id, dealName: deal.businessName });
        }
      }

      // Stalled interviews (active sessions with no activity in 3+ days)
      const { db } = await import("./db");
      const { interviewSessions, dealDocumentRequirements, analyticsEvents: eventsTable } = await import("@shared/schema");
      const { and, lt, gt, eq: eqOp, desc: descOp } = await import("drizzle-orm");
      const dealMap = new Map(allDeals.map((d) => [d.id, d.businessName]));

      const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      const stalledRows = await db
        .select()
        .from(interviewSessions)
        .where(
          and(
            eqOp(interviewSessions.status, "active"),
            lt(interviewSessions.lastActivityAt, threeDaysAgo),
          ),
        );

      const stalledInterviews = stalledRows.map((s) => ({
        dealId: s.dealId,
        dealName: dealMap.get(s.dealId) || "Unknown",
        lastActivity: s.lastActivityAt.toISOString(),
        daysSinceActivity: Math.floor((Date.now() - s.lastActivityAt.getTime()) / (1000 * 60 * 60 * 24)),
      }));

      // Document requirements — missing required docs per deal
      const allReqs = await db.select().from(dealDocumentRequirements);
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
        .filter((d) => d.count > 0);

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
      const recentEvents = await db
        .select()
        .from(eventsTable)
        .where(gt(eventsTable.createdAt, twoDaysAgo))
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
          unansweredQuestions,
          stalledInterviews,
          pendingReviewCIMs,
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

  // GET — full checklist with upload status
  app.get("/api/deals/:dealId/document-requirements", async (req, res) => {
    try {
      const requirements = await storage.getDocumentRequirementsByDeal(req.params.dealId);
      res.json(requirements);
    } catch (error: any) {
      console.error("Error fetching document requirements:", error);
      res.status(500).json({ error: "Failed to fetch document requirements" });
    }
  });

  // POST — broker adds a manual requirement
  app.post("/api/deals/:dealId/document-requirements", async (req, res) => {
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

  // PATCH — update status, link upload, add notes
  app.patch("/api/deals/:dealId/document-requirements/:reqId", async (req, res) => {
    try {
      const existing = await storage.getDocumentRequirement(req.params.reqId);
      if (!existing) {
        return res.status(404).json({ error: "Document requirement not found" });
      }
      if (existing.dealId !== req.params.dealId) {
        return res.status(403).json({ error: "Requirement does not belong to this deal" });
      }
      const requirement = await storage.updateDocumentRequirement(req.params.reqId, req.body);
      res.json(requirement);
    } catch (error: any) {
      console.error("Error updating document requirement:", error);
      res.status(500).json({ error: "Failed to update document requirement" });
    }
  });

  // DELETE — broker removes a requirement (only source: "manual")
  app.delete("/api/deals/:dealId/document-requirements/:reqId", async (req, res) => {
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
  app.post("/api/deals/:dealId/document-requirements/populate", async (req, res) => {
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
      const created = await populateDocumentRequirements(deal.id, industryCategory);
      const requirements = await storage.getDocumentRequirementsByDeal(deal.id);
      res.json({ created, total: requirements.length, requirements });
    } catch (error: any) {
      console.error("Error populating document requirements:", error);
      res.status(500).json({ error: "Failed to populate document requirements" });
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
  // DOCUMENT UPLOAD + PARSING
  // =============================

  const docUpload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        const dir = path.join(process.cwd(), "public", "uploads", "docs");
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
      },
      filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, `doc_${Date.now()}${ext}`);
      },
    }),
    limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
    fileFilter: (req, file, cb) => {
      const allowed = [".pdf", ".txt", ".csv", ".md", ".xlsx", ".xls", ".pptx", ".ppt", ".docx", ".doc"];
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, allowed.includes(ext));
    },
  });

  async function parseDocumentAsync(
    docId: string,
    filePath: string,
    mimeType: string | null,
    category: string,
    subcategory: string | null,
    dealId: string
  ) {
    try {
      await storage.updateDocument(docId, { status: "parsing" } as any);
      const text = await extractTextFromFile(filePath, mimeType);
      const extracted = await extractDocumentData(text, category, subcategory);
      await storage.updateDocument(docId, {
        status: "extracted",
        extractedText: text,
        extractedData: extracted,
        isProcessed: true,
      } as any);
      const deal = await storage.getDeal(dealId);
      if (deal) {
        const merged = mergeExtractedData((deal.extractedInfo as Record<string, unknown>) || {}, extracted);
        await storage.updateDeal(dealId, { extractedInfo: merged } as any);
      }
    } catch (err) {
      console.error(`[parser] failed for doc ${docId}:`, err);
      await storage.updateDocument(docId, { status: "failed" } as any).catch(() => {});
    }
  }

  app.post("/api/deals/:dealId/documents/upload", docUpload.single("file"), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });
      const { category = "other", subcategory } = req.body;
      const doc = await storage.createDocument({
        dealId: req.params.dealId,
        uploadedBy: "broker",
        name: req.file.originalname,
        originalName: req.file.originalname,
        category,
        subcategory: subcategory || null,
        fileUrl: `/uploads/docs/${req.file.filename}`,
        status: "pending",
      } as any);
      parseDocumentAsync(doc.id, req.file.path, req.file.mimetype, category, subcategory || null, req.params.dealId);
      res.json(doc);
    } catch (error: any) {
      console.error("Upload error:", error);
      res.status(500).json({ error: "Upload failed" });
    }
  });

  app.post("/api/documents/:id/parse", async (req, res) => {
    try {
      const doc = await storage.getDocument(req.params.id);
      if (!doc) return res.status(404).json({ error: "Document not found" });
      const filePath = path.join(process.cwd(), "public", doc.fileUrl || "");
      parseDocumentAsync(doc.id, filePath, null, doc.category || "other", doc.subcategory || null, doc.dealId);
      res.json({ status: "parsing" });
    } catch (error: any) {
      res.status(500).json({ error: "Parse failed" });
    }
  });

  app.get("/api/deals/:dealId/extracted-info", async (req, res) => {
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

  app.get("/api/integrations", async (req, res) => {
    try {
      const all = await storage.getAllIntegrations();
      res.json(all);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to fetch integrations" });
    }
  });

  app.post("/api/integrations", async (req, res) => {
    try {
      const integration = await storage.createIntegration(req.body);
      res.json(integration);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to create integration" });
    }
  });

  app.patch("/api/integrations/:id", async (req, res) => {
    try {
      const integration = await storage.updateIntegration(req.params.id, req.body);
      if (!integration) return res.status(404).json({ error: "Integration not found" });
      res.json(integration);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to update integration" });
    }
  });

  app.delete("/api/integrations/:id", async (req, res) => {
    try {
      await storage.deleteIntegration(req.params.id);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: "Failed to delete integration" });
    }
  });

  app.get("/api/integrations/:id/emails", async (req, res) => {
    try {
      const integration = await storage.getIntegration(req.params.id);
      if (!integration) return res.status(404).json({ error: "Integration not found" });
      const emails = await storage.getIntegrationEmailsByDeal(req.params.id);
      res.json(emails);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to fetch integration emails" });
    }
  });

  app.post("/api/integrations/:id/emails", async (req, res) => {
    try {
      const email = await storage.createIntegrationEmail({
        ...req.body,
        integrationId: req.params.id,
      });
      res.json(email);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to add email" });
    }
  });

  app.delete("/api/integration-emails/:id", async (req, res) => {
    try {
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
  app.post("/api/deals/:dealId/financial-analysis", async (req, res) => {
    try {
      const deal = await storage.getDeal(req.params.dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });

      // Fire-and-forget: start analysis in background
      const { runFinancialAnalysis } = await import("./financial/analyzer");
      runFinancialAnalysis(req.params.dealId, storage).catch((err: any) => {
        console.error("Background financial analysis failed:", err);
      });

      // Return immediately — client can poll GET for status
      res.json({ message: "Financial analysis started", dealId: req.params.dealId });
    } catch (error: any) {
      console.error("Error starting financial analysis:", error);
      res.status(500).json({ error: "Failed to start financial analysis" });
    }
  });

  // Get the latest financial analysis for a deal
  app.get("/api/deals/:dealId/financial-analysis", async (req, res) => {
    try {
      const analysis = await storage.getLatestFinancialAnalysis(req.params.dealId);
      if (!analysis) return res.status(404).json({ error: "No financial analysis found" });
      res.json(analysis);
    } catch (error: any) {
      console.error("Error fetching financial analysis:", error);
      res.status(500).json({ error: "Failed to fetch financial analysis" });
    }
  });

  // Get a specific financial analysis version
  app.get("/api/deals/:dealId/financial-analysis/:id", async (req, res) => {
    try {
      const analysis = await storage.getFinancialAnalysis(req.params.id);
      if (!analysis || analysis.dealId !== req.params.dealId) {
        return res.status(404).json({ error: "Financial analysis not found" });
      }
      res.json(analysis);
    } catch (error: any) {
      console.error("Error fetching financial analysis:", error);
      res.status(500).json({ error: "Failed to fetch financial analysis" });
    }
  });

  // Broker edits (notes, manual comps, addback adjustments, etc.)
  app.patch("/api/deals/:dealId/financial-analysis/:id", async (req, res) => {
    try {
      const existing = await storage.getFinancialAnalysis(req.params.id);
      if (!existing || existing.dealId !== req.params.dealId) {
        return res.status(404).json({ error: "Financial analysis not found" });
      }

      const allowedFields = [
        "brokerNotes", "normalization", "comps", "insights",
        "clarifyingQuestions", "reclassifiedPnl", "reclassifiedBalanceSheet",
        "reclassifiedCashFlow", "workingCapital",
      ];
      const updates: Record<string, any> = {};
      for (const field of allowedFields) {
        if (req.body[field] !== undefined) {
          updates[field] = req.body[field];
        }
      }

      if (req.body.brokerReviewed) {
        updates.brokerReviewedAt = new Date();
        updates.status = "reviewed";
      }

      const updated = await storage.updateFinancialAnalysis(req.params.id, updates);
      res.json(updated);
    } catch (error: any) {
      console.error("Error updating financial analysis:", error);
      res.status(500).json({ error: "Failed to update financial analysis" });
    }
  });

  // Re-run analysis (creates a new version)
  app.post("/api/deals/:dealId/financial-analysis/:id/rerun", async (req, res) => {
    try {
      const existing = await storage.getFinancialAnalysis(req.params.id);
      if (!existing || existing.dealId !== req.params.dealId) {
        return res.status(404).json({ error: "Financial analysis not found" });
      }

      const { runFinancialAnalysis } = await import("./financial/analyzer");
      runFinancialAnalysis(req.params.dealId, storage).catch((err: any) => {
        console.error("Background financial re-analysis failed:", err);
      });

      res.json({ message: "Financial re-analysis started", dealId: req.params.dealId });
    } catch (error: any) {
      console.error("Error re-running financial analysis:", error);
      res.status(500).json({ error: "Failed to re-run financial analysis" });
    }
  });

  // =============================
  // ADDBACK VERIFICATION ROUTES
  // =============================

  // Start addback verification for a deal
  app.post("/api/deals/:dealId/addback-verification", async (req, res) => {
    try {
      const { dealId } = req.params;
      const { workflow, financialAnalysisId } = req.body;

      if (!workflow || !["provided", "from_scratch"].includes(workflow)) {
        return res.status(400).json({ error: "workflow must be 'provided' or 'from_scratch'" });
      }

      const deal = await storage.getDeal(dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });

      // If workflow is "provided", pull addbacks from financial analysis
      let initialAddbacks: any[] = [];
      if (workflow === "provided" && financialAnalysisId) {
        const fa = await storage.getFinancialAnalysis(financialAnalysisId);
        if (fa?.normalization) {
          const norm = fa.normalization as any;
          initialAddbacks = (norm.addbacks || []).map((a: any) => ({
            id: a.id || `ab_${Math.random().toString(36).slice(2, 8)}`,
            label: a.label || "",
            description: a.description || "",
            category: a.category || "other",
            annualAmount: Object.values(a.amounts || {}).reduce((sum: number, v: any) => sum + (Number(v) || 0), 0) / Math.max(Object.keys(a.amounts || {}).length, 1),
            yearAmounts: a.amounts || {},
            verificationStatus: "unverified",
            matchedTransactions: [],
            sellerNotes: null,
            aiNotes: null,
          }));
        }
      }

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
  app.get("/api/deals/:dealId/addback-verification", async (req, res) => {
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
  app.patch("/api/deals/:dealId/addback-verification/:id", async (req, res) => {
    try {
      const existing = await storage.getAddbackVerification(req.params.id);
      if (!existing || existing.dealId !== req.params.dealId) {
        return res.status(404).json({ error: "Addback verification not found" });
      }

      const updates: any = {};
      if (req.body.addbacks !== undefined) updates.addbacks = req.body.addbacks;
      if (req.body.sellerQuestions !== undefined) updates.sellerQuestions = req.body.sellerQuestions;
      if (req.body.status !== undefined) updates.status = req.body.status;
      if (req.body.sourceDocumentIds !== undefined) updates.sourceDocumentIds = req.body.sourceDocumentIds;

      const updated = await storage.updateAddbackVerification(req.params.id, updates);
      res.json(updated);
    } catch (error: any) {
      console.error("Error updating addback verification:", error);
      res.status(500).json({ error: "Failed to update addback verification" });
    }
  });

  // Trigger AI analysis after documents uploaded
  app.post("/api/deals/:dealId/addback-verification/:id/analyze", async (req, res) => {
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
          const { parseTransactionData, matchAddbacksToTransactions, identifyAddbacksFromTransactions, generateSellerQuestions } = await import("./financial/addback-verifier");

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
          for (const doc of sourceDocs) {
            if (!doc.extractedText) continue;
            const sourceType = doc.subcategory === "bank_statement"
              ? "bank"
              : doc.subcategory === "quickbooks_export" || doc.subcategory === "pnl_detail"
              ? "quickbooks"
              : "gl";
            const parsed = await parseTransactionData(doc.extractedText, sourceType as any, doc.id);
            allTransactions = allTransactions.concat(parsed);
          }

          let updatedAddbacks: any[];
          let questions: any[];

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
              return {
                ...ab,
                verificationStatus: match.verificationStatus === "matched" ? "matched" : match.verificationStatus === "partial_match" ? "matched" : "no_match",
                matchedTransactions: match.matchedTransactions,
                aiNotes: match.aiNotes,
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
                askingPrice: deal.askingPrice || undefined,
              },
            );

            updatedAddbacks = identified.map((ab) => ({
              ...ab,
              verificationStatus: "matched",
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
  app.post("/api/deals/:dealId/addback-verification/:id/confirm", async (req, res) => {
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

  // ── Seller progress (token-based, no login) ──
  app.get("/api/seller/:token/progress", async (req, res) => {
    try {
      const invite = await storage.getSellerInviteByToken(req.params.token);
      if (!invite) return res.status(404).json({ error: "Invite not found" });

      const deal = await storage.getDeal(invite.dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });

      // Interview coverage
      const { buildSectionCoverage } = await import("./interview/knowledge-base");
      const extractedInfo = (deal.extractedInfo || {}) as Record<string, unknown>;
      const sectionCoverage = buildSectionCoverage(extractedInfo as any);
      const wellCovered = sectionCoverage.filter((s) => s.status === "well_covered").length;
      const partial = sectionCoverage.filter((s) => s.status === "partial").length;
      const interviewPct = sectionCoverage.length > 0
        ? Math.round(((wellCovered + partial * 0.4) / sectionCoverage.length) * 100)
        : 0;

      // Interview sessions
      const { db } = await import("./db");
      const { interviewSessions, buyerQuestions } = await import("@shared/schema");
      const { eq: eqOp, desc: descOp } = await import("drizzle-orm");
      const sessions = await db.select().from(interviewSessions)
        .where(eqOp(interviewSessions.dealId, deal.id))
        .orderBy(descOp(interviewSessions.lastActivityAt));
      const hasActiveSession = sessions.some((s) => s.status === "active");
      const hasCompletedSession = sessions.some((s) => s.status === "completed");
      const interviewCompleted = !!(deal as any).interviewCompleted || hasCompletedSession;

      // Document requirements
      const docReqs = await storage.getDocumentRequirementsByDeal(deal.id);
      const requiredDocs = docReqs.filter((r) => r.isRequired);
      const uploadedRequired = requiredDocs.filter((r) => r.status !== "missing").length;
      const totalRequired = requiredDocs.length;
      const docPct = totalRequired > 0 ? Math.round((uploadedRequired / totalRequired) * 100) : 0;

      // Uploaded documents
      const allDocs = await storage.getDocumentsByDeal(deal.id);

      // Pending seller approvals
      const pendingQuestions = await db.select().from(buyerQuestions)
        .where(eqOp(buyerQuestions.dealId, deal.id));
      const pendingSeller = pendingQuestions.filter((q) => q.status === "pending_seller");

      // Step status
      const intakeCompleted = !!(deal as any).questionnaireData;
      type StepStatus = "completed" | "current" | "upcoming";
      let currentStep: "intake" | "interview" | "documents" | "review" = "intake";
      if (intakeCompleted && !interviewCompleted) currentStep = "interview";
      else if (interviewCompleted && docPct < 100) currentStep = "documents";
      else if (interviewCompleted && docPct >= 100) currentStep = "review";

      const steps: Array<{ id: string; label: string; status: StepStatus; pct?: number }> = [
        { id: "intake", label: "Business Info", status: intakeCompleted ? "completed" : currentStep === "intake" ? "current" : "upcoming" },
        { id: "interview", label: "Conversation", status: interviewCompleted ? "completed" : currentStep === "interview" ? "current" : "upcoming", pct: interviewPct },
        { id: "documents", label: "Documents", status: docPct >= 100 ? "completed" : currentStep === "documents" ? "current" : "upcoming", pct: docPct },
        { id: "review", label: "Review", status: currentStep === "review" ? "current" : "upcoming" },
      ];

      // Broker contact
      const broker = await storage.getUser(deal.brokerId);

      res.json({
        businessName: deal.businessName,
        industry: deal.industry,
        currentStep,
        steps,
        interview: {
          completed: interviewCompleted,
          hasActiveSession,
          percentage: interviewPct,
          sections: sectionCoverage.map((s) => ({
            key: s.key,
            title: s.title,
            status: s.status,
          })),
        },
        documents: {
          requiredTotal: totalRequired,
          requiredUploaded: uploadedRequired,
          percentage: docPct,
          totalUploaded: allDocs.length,
          requirements: docReqs.map((r) => ({
            id: r.id,
            name: r.documentName,
            category: r.category,
            isRequired: r.isRequired,
            status: r.status,
            notes: r.notes,
          })),
        },
        pendingApprovals: pendingSeller.length,
        broker: broker ? { name: broker.name || broker.username, email: broker.email } : null,
      });
    } catch (error: any) {
      console.error("Error fetching seller progress:", error);
      res.status(500).json({ error: "Failed to fetch seller progress" });
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
      const [baseSections, publishedQuestions, branding] = await Promise.all([
        storage.getCimSectionsByDeal(deal.id),
        storage.getPublishedQuestions(deal.id),
        deal.brokerId ? storage.getBrandingByBroker(deal.brokerId) : Promise.resolve(undefined),
      ]);

      // Determine CIM mode from buyer's access level
      const cimMode = (() => {
        switch (access.accessLevel) {
          case "due_diligence": return "dd";
          case "loi": return "normal";
          default: return "blind"; // teaser, full → blind by default
        }
      })();

      // Apply overrides if not normal mode
      let sections = baseSections;
      if (cimMode !== "normal" && baseSections.length > 0) {
        const overrides = await storage.getCimSectionOverrides(deal.id, cimMode);
        if (overrides.length > 0) {
          const overrideMap = new Map(overrides.map(o => [o.cimSectionId, o]));
          sections = baseSections.map(s => {
            const override = overrideMap.get(String(s.id));
            if (!override) return s;
            return {
              ...s,
              layoutData: override.layoutData || s.layoutData,
              aiDraftContent: override.contentOverride || s.aiDraftContent,
              brokerEditedContent: override.contentOverride || s.brokerEditedContent,
            };
          });
        }
      }

      res.json({ access, deal, sections, publishedQuestions, branding: branding ?? null, cimMode });
    } catch (error: any) {
      console.error("Error fetching buyer access:", error);
      res.status(500).json({ error: "Failed to verify access" });
    }
  });

  // Buyer signs NDA
  app.post("/api/view/:token/sign-nda", async (req, res) => {
    try {
      const access = await storage.getBuyerAccessByToken(req.params.token);
      if (!access) return res.status(404).json({ error: "Invalid token" });

      await storage.updateBuyerAccess(access.id, {
        ndaSigned: true,
        ndaSignedAt: new Date(),
        ndaSignedIp: req.ip || req.socket.remoteAddress || null,
      } as any);

      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: "Failed to sign NDA" });
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

  // =====================
  // Buyer decision — "Interested / Not interested / Under review"
  // =====================
  // Called from the Buyer View Room. Records the decision, notifies the
  // broker via email/SMS, and (when a CRM is connected) automatically
  // updates the deal's pipeline stage in Pipedrive / HubSpot / Salesforce.
  app.post("/api/view/:token/decision", async (req, res) => {
    try {
      const access = await storage.getBuyerAccessByToken(req.params.token);
      if (!access) return res.status(404).json({ error: "Invalid token" });
      if (access.revokedAt) return res.status(403).json({ error: "Access revoked" });

      const decisionSchema = z.object({
        decision: z.enum(["interested", "not_interested"]),
        nextStep: z.enum(["seller_call", "management_meeting", "site_visit", "loi", "more_info", "other"]).optional().nullable(),
        reason: z.string().max(2000).optional().nullable(),
      });
      const { decision, nextStep, reason } = decisionSchema.parse(req.body);

      const deal = await storage.getDeal(access.dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });

      // Record the decision
      await storage.updateBuyerAccess(access.id, {
        decision,
        decisionNextStep: nextStep || null,
        decisionReason: reason || null,
        decisionAt: new Date(),
        crmSyncStatus: "pending",
      } as any);

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
        : crmProvider
        ? describeCrmAction(crmProvider, decision)
        : "No CRM is connected — connect Pipedrive, HubSpot or Salesforce in Settings to enable automatic pipeline updates.";

      // Compose email body
      const bodyParts: string[] = [];
      bodyParts.push(
        `<strong>${buyerLabel}</strong> has finished reviewing the ${deal.businessName} CIM and has shared their decision.`,
      );
      if (decision === "interested") {
        bodyParts.push(
          `<br/><br/><strong>Decision:</strong> Interested in moving forward.`,
        );
        if (nextStepLabel) {
          bodyParts.push(`<br/><strong>Requested next step:</strong> ${nextStepLabel}`);
        }
      } else {
        bodyParts.push(
          `<br/><br/><strong>Decision:</strong> Not interested in moving forward.`,
        );
      }
      if (reason) {
        const safeReason = reason.replace(/</g, "&lt;").replace(/>/g, "&gt;");
        bodyParts.push(`<br/><br/><em>Buyer comment:</em> &ldquo;${safeReason}&rdquo;`);
      }
      bodyParts.push(`<br/><br/><strong>CRM update:</strong> ${crmMessage}`);

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
  app.get("/api/deals/:dealId/buyer-search", async (req, res) => {
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
  app.post("/api/deals/:dealId/buyer-prefill", async (req, res) => {
    try {
      const deal = await storage.getDeal(req.params.dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });
      const query = String(req.body?.query || req.body?.recordId || "");
      if (!query) return res.status(400).json({ error: "query or recordId required" });
      const result = await prefillBuyerFromCrm(deal.brokerId, query);
      res.json(result);
    } catch (error: any) {
      console.error("Error prefilling buyer:", error);
      res.status(500).json({ error: "Failed to prefill buyer" });
    }
  });

  // List approval requests for a deal
  app.get("/api/deals/:dealId/buyer-approvals", async (req, res) => {
    try {
      const requests = await storage.getBuyerApprovalRequestsByDeal(req.params.dealId);
      res.json(requests);
    } catch (error: any) {
      console.error("Error listing buyer approvals:", error);
      res.status(500).json({ error: "Failed to list buyer approvals" });
    }
  });

  // Get one approval request
  app.get("/api/buyer-approvals/:id", async (req, res) => {
    try {
      const request = await storage.getBuyerApprovalRequest(req.params.id);
      if (!request) return res.status(404).json({ error: "Not found" });
      res.json(request);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to fetch buyer approval" });
    }
  });

  // Submit a new buyer approval request
  app.post("/api/deals/:dealId/buyer-approvals", async (req, res) => {
    try {
      const deal = await storage.getDeal(req.params.dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });

      const body = req.body || {};
      const category = body.category || "other";
      const riskLevel = body.riskLevel || riskLevelForCategory(category);
      const isCompetitor = body.isCompetitor ?? (category === "direct_competitor" || category === "indirect_competitor");
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
          `<strong>${request.buyerName}</strong>` +
          (request.buyerCompany ? ` of <strong>${request.buyerCompany}</strong>` : "") +
          ` has been submitted for approval on the ${deal.businessName} deal.` +
          `<br/><br/><strong>Category:</strong> ${categoryLabel}` +
          `<br/><strong>Risk level:</strong> ${riskLevel}` +
          (request.submittedByName ? `<br/><strong>Submitted by:</strong> ${request.submittedByName}` : "") +
          (request.background ? `<br/><br/>${request.background}` : ""),
        actionUrl: `/deal/${deal.id}?approval=${request.id}`,
        businessName: deal.businessName,
        metadata: { approvalRequestId: request.id, category, riskLevel },
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
  app.post("/api/buyer-approvals/:id/broker-review", async (req, res) => {
    try {
      const request = await storage.getBuyerApprovalRequest(req.params.id);
      if (!request) return res.status(404).json({ error: "Not found" });

      const { action, reviewerName, reviewerId, notes } = req.body || {};
      if (!["approve", "reject"].includes(action)) {
        return res.status(400).json({ error: "action must be approve or reject" });
      }

      const deal = await storage.getDeal(request.dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });

      if (action === "reject") {
        const updated = await storage.updateBuyerApprovalRequest(request.id, {
          status: "rejected",
          brokerReviewedBy: reviewerId || null,
          brokerReviewedAt: new Date(),
          brokerReviewNotes: notes || null,
          rejectionReason: notes || "Rejected by broker",
        } as any);

        await notify(deal.id, "buyer_approval_rejected", {
          title: `Buyer approval rejected — ${request.buyerName}`,
          body: `The buyer approval request for <strong>${request.buyerName}</strong> was rejected by the lead broker.` +
            (notes ? `<br/><br/><em>Reason:</em> ${notes}` : ""),
          actionUrl: `/deal/${deal.id}`,
          businessName: deal.businessName,
          metadata: { approvalRequestId: request.id },
        });

        return res.json(updated);
      }

      // Approve → send to seller
      const updated = await storage.updateBuyerApprovalRequest(request.id, {
        status: "pending_seller_review",
        brokerReviewedBy: reviewerId || null,
        brokerReviewedAt: new Date(),
        brokerReviewNotes: notes || null,
      } as any);

      const baseUrl = process.env.APP_URL || `${req.protocol}://${req.get("host")}`;
      const sellerReviewUrl = `${baseUrl}/review/${request.sellerReviewToken}`;
      const categoryLabel = BUYER_CATEGORIES.find(c => c.value === request.category)?.label || request.category;

      await notify(deal.id, "buyer_approval_broker_approved", {
        title: `Action needed: approve buyer for ${deal.businessName}`,
        body:
          `A new buyer has been approved by your broker and needs your final review before gaining access to the CIM.` +
          `<br/><br/><strong>Buyer:</strong> ${request.buyerName}` +
          (request.buyerCompany ? ` (${request.buyerCompany})` : "") +
          `<br/><strong>Type:</strong> ${categoryLabel}` +
          `<br/><strong>Risk level:</strong> ${request.riskLevel}` +
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
        request,
        deal: deal ? { id: deal.id, businessName: deal.businessName } : null,
        branding: branding ?? null,
      });
    } catch (error: any) {
      res.status(500).json({ error: "Failed to load review" });
    }
  });

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
          body: `The seller has declined the buyer approval for <strong>${request.buyerName}</strong>.` +
            (notes ? `<br/><br/><em>Reason:</em> ${notes}` : ""),
          actionUrl: `/deal/${deal.id}`,
          businessName: deal.businessName,
          metadata: { approvalRequestId: request.id },
        });

        return res.json(updated);
      }

      // Approve → either link to existing buyer account or create one
      //          + create buyerAccess + send invite email (Firmex-style)
      const baseUrl = process.env.APP_URL || `${req.protocol}://${req.get("host")}`;

      // Check if a buyer account already exists for this email
      const existingAccount = await storage.getBuyerUserByEmail(request.buyerEmail.toLowerCase().trim());
      let buyerUserId: string;
      let isNewAccount = false;

      if (existingAccount) {
        buyerUserId = existingAccount.id;
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
          businessName: deal.businessName,
          baseUrl,
        });
        buyerUserId = invited.user.id;
        isNewAccount = invited.isNew;
      }

      const accessToken = crypto.randomUUID();
      const buyerAccess = await storage.createBuyerAccess({
        dealId: deal.id,
        buyerUserId,
        accessToken,
        buyerEmail: request.buyerEmail,
        buyerName: request.buyerName || null,
        buyerCompany: request.buyerCompany || null,
        accessLevel: "full",
        expiresAt: null,
      } as any);

      const updated = await storage.updateBuyerApprovalRequest(request.id, {
        status: "access_granted",
        sellerReviewedBy: reviewerName || null,
        sellerReviewedAt: new Date(),
        sellerReviewNotes: notes || null,
        grantedBuyerAccessId: buyerAccess.id,
        grantedAt: new Date(),
      } as any);

      // Gather broker emails for CC (lead + submitter)
      const members = await storage.getDealMembers(deal.id);
      const brokerEmails = members
        .filter(m => m.teamType === "broker" && m.email)
        .map(m => m.email as string);
      const ccList = Array.from(new Set(brokerEmails));

      // For existing accounts: send "added to deal" email pointing to dashboard.
      // For brand-new accounts: inviteBuyerUser already sent a set-password email,
      //   but we still want to CC brokers and mention this specific deal.
      const dashboardUrl = `${baseUrl}/buyer/dashboard`;
      const viewUrl = `${baseUrl}/view/${accessToken}`;
      const inviteHtml = isNewAccount
        ? `
        <div style="font-family: Inter, system-ui, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; background: #0a0a0a; color: #e5e5e5;">
          <h2 style="color: #14b8a6; margin-bottom: 16px;">You've been invited to view a confidential business overview</h2>
          <p>Hello${request.buyerName ? ` ${request.buyerName}` : ""},</p>
          <p>You've been approved to view the confidential information memorandum for <strong>${deal.businessName}</strong>.</p>
          <p>You should have received a separate email asking you to set your password and create your Cimple account. Once you're signed in, this deal will appear on your dashboard along with any other deals matched to your profile.</p>
          <p style="color: #888; font-size: 12px; margin-top: 32px;">If you'd prefer to skip creating an account for now, you can view this single CIM via the secure link below (NDA required):</p>
          <p><a href="${viewUrl}" style="color: #14b8a6;">${viewUrl}</a></p>
        </div>
        `
        : `
        <div style="font-family: Inter, system-ui, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; background: #0a0a0a; color: #e5e5e5;">
          <h2 style="color: #14b8a6; margin-bottom: 16px;">A new CIM has been added to your Cimple dashboard</h2>
          <p>Hello ${existingAccount?.name || request.buyerName},</p>
          <p>You've been granted access to <strong>${deal.businessName}</strong>. Sign in to your Cimple account to view it.</p>
          <p style="margin: 32px 0;">
            <a href="${dashboardUrl}" style="background: #14b8a6; color: #0a0a0a; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">Go to dashboard</a>
          </p>
          <p style="color: #888; font-size: 12px;">You'll be asked to sign an NDA before accessing the full document.</p>
        </div>
        `;

      await sendDirectEmail(
        request.buyerEmail,
        isNewAccount
          ? `You've been invited to ${deal.businessName} on Cimple`
          : `New CIM added to your Cimple dashboard: ${deal.businessName}`,
        inviteHtml,
        ccList,
      );

      // Also notify broker team that access was granted
      await notify(deal.id, "buyer_approval_seller_approved", {
        title: `Buyer approved & granted access — ${request.buyerName}`,
        body:
          `The seller has approved <strong>${request.buyerName}</strong>` +
          (request.buyerCompany ? ` of <strong>${request.buyerCompany}</strong>` : "") +
          `. An invite email has been sent to ${request.buyerEmail} with both brokers CC'd.`,
        actionUrl: `/deal/${deal.id}`,
        businessName: deal.businessName,
        metadata: { approvalRequestId: request.id, buyerAccessId: buyerAccess.id },
      });

      res.json(updated);
    } catch (error: any) {
      console.error("Error in seller review:", error);
      res.status(500).json({ error: "Failed to process seller review" });
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

  // ── CIM-SECTIONS ALIASES (used by CIMDesigner) ──

  app.get("/api/deals/:dealId/cim-sections", async (req, res) => {
    try {
      const sections = await storage.getCimSectionsByDeal(req.params.dealId);
      res.json(sections);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to fetch sections" });
    }
  });

  app.post("/api/deals/:dealId/cim-sections/reorder", async (req, res) => {
    try {
      const { orderedIds } = req.body;
      if (Array.isArray(orderedIds)) {
        for (let i = 0; i < orderedIds.length; i++) {
          await storage.updateCimSection(String(orderedIds[i]), { order: i } as any);
        }
      }
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: "Failed to reorder sections" });
    }
  });

  // =============================
  // AI CONTENT GENERATION ROUTES
  // =============================
  
  app.post("/api/deals/:dealId/generate-content", async (req, res) => {
    try {
      const { dealId } = req.params;
      const deal = await storage.getDeal(dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });

      const { sectionKey } = req.body;

      // ── Single-section regeneration ──
      if (sectionKey) {
        const businessName = deal.businessName || "The Business";
        const industry = deal.industry || "a specialized industry";
        const sectionData = {
          extractedInfo: (deal.extractedInfo as Record<string, any>) || {},
          questionnaireData: deal.questionnaireData as Record<string, any> | null,
          scrapedData: (deal as any).scrapedData as Record<string, any> | null,
          description: deal.description,
          askingPrice: deal.askingPrice,
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
          await storage.updateCimSection(String(matchingSection.id), {
            aiDraftContent: content,
          });
        }

        res.json({ sectionKey, content });
        return;
      }

      // ── Full CIM generation — use the visual layout engine ──

      // Apply resolved discrepancy values to extractedInfo
      const resolvedDiscrepancies = await storage.getResolvedDiscrepancies(dealId);
      const extractedInfo = { ...(deal.extractedInfo as Record<string, unknown> || {}) };
      for (const d of resolvedDiscrepancies) {
        if (d.resolvedValue && d.field) {
          extractedInfo[d.field] = d.resolvedValue;
        }
      }

      const [branding, insights] = await Promise.all([
        storage.getBrandingByBroker(deal.brokerId),
        deal.industry ? storage.getEngagementInsightsByIndustry(deal.industry) : Promise.resolve([]),
      ]);

      const document = await generateCimLayout({
        dealId,
        businessName: deal.businessName,
        industry: deal.industry,
        askingPrice: deal.askingPrice,
        extractedInfo,
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

      // Persist visual sections to DB
      await storage.deleteCimSectionsForDeal(dealId);
      const cimContent: Record<string, string> = {};

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
        // Also store text fallback for backward compat
        if (section.aiDraftContent) {
          cimContent[section.sectionKey] = section.aiDraftContent;
        }
      }

      await storage.updateDeal(dealId, {
        cimContent,
        phase: "phase3_content_creation",
        cimLayoutGeneratedAt: new Date(),
        cimLayoutVersion: (deal.cimLayoutVersion || 0) + 1,
      } as any);

      res.json({
        success: true,
        sectionCount: document.sections.length,
        generatedAt: document.generatedAt,
        cimContent,
      });
    } catch (error: any) {
      console.error("Error generating content:", error);
      res.status(500).json({ error: error.message || "Failed to generate content" });
    }
  });

  // Generate blind CIM (AI-powered redaction of all identifying info)
  app.post("/api/deals/:dealId/generate-blind", async (req, res) => {
    try {
      const { dealId } = req.params;
      const deal = await storage.getDeal(dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });

      const sections = await storage.getCimSectionsByDeal(dealId);
      if (sections.length === 0) {
        return res.status(400).json({ error: "Generate CIM content first" });
      }

      const { generateBlindOverrides } = await import("./cim/redaction-engine");
      const overrides = await generateBlindOverrides(sections, {
        businessName: deal.businessName,
        industry: deal.industry,
        extractedInfo: deal.extractedInfo as Record<string, any> | null,
      });

      // Delete old blind overrides and insert new ones
      await storage.deleteCimSectionOverrides(dealId, "blind");
      for (const override of overrides) {
        await storage.createCimSectionOverride({
          dealId,
          cimSectionId: override.cimSectionId,
          mode: "blind",
          layoutData: override.layoutData,
          contentOverride: override.contentOverride,
        });
      }

      res.json({ success: true, overrideCount: overrides.length });
    } catch (error: any) {
      console.error("Error generating blind CIM:", error);
      res.status(500).json({ error: error.message || "Failed to generate blind CIM" });
    }
  });

  // Generate DD (Due Diligence) enriched CIM
  app.post("/api/deals/:dealId/generate-dd", async (req, res) => {
    try {
      const { dealId } = req.params;
      const deal = await storage.getDeal(dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });

      const sections = await storage.getCimSectionsByDeal(dealId);
      if (sections.length === 0) {
        return res.status(400).json({ error: "Generate CIM content first" });
      }

      // Gather DD context
      const [addbackVerification, financialAnalyses, allDocs] = await Promise.all([
        storage.getAddbackVerificationByDeal(dealId),
        storage.getFinancialAnalysesByDeal(dealId),
        storage.getDocumentsByDeal(dealId),
      ]);

      const { generateDdOverrides } = await import("./cim/dd-enrichment");
      const overrides = await generateDdOverrides(sections, {
        businessName: deal.businessName,
        industry: deal.industry,
        extractedInfo: deal.extractedInfo as Record<string, any> | null,
      }, {
        addbackVerification,
        financialAnalysis: financialAnalyses[0] || null,
        documents: allDocs.map(d => ({
          name: d.name,
          category: d.category || "other",
          extractedText: d.extractedText,
        })),
      });

      // Delete old DD overrides and insert new ones
      await storage.deleteCimSectionOverrides(dealId, "dd");
      for (const override of overrides) {
        await storage.createCimSectionOverride({
          dealId,
          cimSectionId: override.cimSectionId,
          mode: "dd",
          layoutData: override.layoutData,
          contentOverride: override.contentOverride,
        });
      }

      res.json({ success: true, overrideCount: overrides.length });
    } catch (error: any) {
      console.error("Error generating DD CIM:", error);
      res.status(500).json({ error: error.message || "Failed to generate DD CIM" });
    }
  });

  // Get CIM section overrides for a specific mode
  app.get("/api/deals/:dealId/cim-overrides/:mode", async (req, res) => {
    try {
      const overrides = await storage.getCimSectionOverrides(req.params.dealId, req.params.mode);
      res.json(overrides);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to fetch overrides" });
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
        const updates: any = {
          viewCount: currentViewCount + 1,
          lastAccessedAt: new Date(),
        };
        // Stamp firstViewedAt on the very first view — anchors the reminder schedule
        if (!buyerAccess.firstViewedAt) {
          updates.firstViewedAt = new Date();
        }
        await storage.updateBuyerAccess(buyerAccess.id, updates);
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
      const { matchBuyerToDeal } = await import("./matching/engine.js");
      const { calculateQualifiedLeadScore } = await import("./scoring/buyer-score.js");
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
        const qualifiedScore = buyerUser ? calculateQualifiedLeadScore({
          buyer: buyerUser,
          match: fullBreakdown,
          engagement: stats ? {
            viewCount: b.viewCount ?? 0,
            sectionsViewed: stats.sectionsEntered.size,
            totalTimeSeconds: stats.totalSeconds,
            questionCount: stats.questionCount,
            ndaSigned: !!b.ndaSignedAt,
          } : null,
        }) : null;

        return {
          ...b,
          totalTimeSeconds: stats?.totalSeconds ?? 0,
          sectionsViewedCount: stats?.sectionsEntered.size ?? 0,
          maxScrollDepth: stats?.maxScrollDepth ?? 0,
          questionCount: stats?.questionCount ?? 0,
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
  app.get("/api/deals/:dealId/analytics/timeline", async (req, res) => {
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
        .filter(e => ["view", "nda_signed", "section_enter", "scroll_depth", "question_asked", "download_attempt"].includes(e.eventType))
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
          createdAt: e.createdAt,
        };
      });

      res.json({ timeline, total: events.filter(e => ["view", "nda_signed", "section_enter", "scroll_depth", "question_asked", "download_attempt"].includes(e.eventType)).length });
    } catch (error: any) {
      console.error("Error getting timeline:", error);
      res.status(500).json({ error: "Failed to get timeline" });
    }
  });

  // Per-deal analytics summary (lightweight — for embedding in deal detail page)
  app.get("/api/deals/:dealId/analytics/summary", async (req, res) => {
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
  app.get("/api/analytics/deals-comparison", async (req, res) => {
    try {
      const deals = await storage.getAllDeals();
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
  app.get("/api/deals/:dealId/analytics/buyer-scores", async (req, res) => {
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
        const viewCount = buyerEvents.filter(e => e.eventType === "view").length;
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
  app.post("/api/deals/:dealId/match-buyers", async (req, res) => {
    try {
      const { dealId } = req.params;
      const deal = await storage.getDeal(dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });

      const buyers = await storage.getBuyerAccessByDeal(dealId);
      const latestFA = await storage.getLatestFinancialAnalysis(dealId);

      const { matchBuyerToDeal } = await import("./matching/engine.js");

      const results = await Promise.all(buyers.filter((b: any) => !b.revokedAt).map(async (buyer: any) => {
        const criteria = (buyer.buyerCriteria || {}) as any;
        const hasCriteria = Object.keys(criteria).length > 0;

        if (!hasCriteria) {
          return {
            buyerId: buyer.id,
            buyerName: buyer.buyerName || "Unknown",
            buyerEmail: buyer.buyerEmail,
            buyerCompany: buyer.buyerCompany,
            buyerType: buyer.buyerType,
            matchScore: null,
            breakdown: null,
            noCriteria: true,
          };
        }

        const breakdown = await matchBuyerToDeal(
          criteria,
          {
            industry: deal.industry,
            subIndustry: deal.subIndustry,
            askingPrice: deal.askingPrice,
            extractedInfo: (deal.extractedInfo || {}) as Record<string, any>,
            financialAnalysis: latestFA ? {
              reclassifiedPnl: latestFA.reclassifiedPnl,
              normalization: latestFA.normalization,
              workingCapital: latestFA.workingCapital,
            } : undefined,
          },
          { skipAI: req.query.skipAI === "true" }
        );

        // Persist score
        await storage.updateBuyerAccess(buyer.id, {
          matchScore: breakdown.finalScore,
          matchBreakdown: breakdown as any,
        });

        return {
          buyerId: buyer.id,
          buyerName: buyer.buyerName || "Unknown",
          buyerEmail: buyer.buyerEmail,
          buyerCompany: buyer.buyerCompany,
          buyerType: buyer.buyerType,
          prequalified: buyer.prequalified,
          proofOfFunds: buyer.proofOfFunds,
          matchScore: breakdown.finalScore,
          breakdown,
        };
      }));

      results.sort((a, b) => (b.matchScore ?? -1) - (a.matchScore ?? -1));
      res.json(results);
    } catch (error: any) {
      console.error("Error matching buyers:", error);
      res.status(500).json({ error: "Failed to match buyers" });
    }
  });

  // Update buyer profile and criteria
  app.patch("/api/buyers/:id/profile", async (req, res) => {
    try {
      const { id } = req.params;
      const { buyerType, prequalified, proofOfFunds, buyerNotes, buyerCriteria } = req.body;
      const updates: any = {};
      if (buyerType !== undefined) updates.buyerType = buyerType;
      if (prequalified !== undefined) updates.prequalified = prequalified;
      if (proofOfFunds !== undefined) updates.proofOfFunds = proofOfFunds;
      if (buyerNotes !== undefined) updates.buyerNotes = buyerNotes;
      if (buyerCriteria !== undefined) updates.buyerCriteria = buyerCriteria;

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
  // DISCREPANCY RESOLUTION
  // ════════════════════════════════════════════════════════════

  // Run discrepancy check
  app.post("/api/deals/:dealId/run-discrepancy-check", async (req, res) => {
    try {
      const { dealId } = req.params;
      const deal = await storage.getDeal(dealId);
      if (!deal) return res.status(404).json({ error: "Deal not found" });

      const allDocs = await storage.getDocumentsByDeal(dealId);
      const processedDocs = allDocs.filter(d => d.isProcessed && (d.extractedText || d.extractedData));

      if (processedDocs.length === 0) {
        return res.status(400).json({ error: "No processed documents to cross-reference. Upload and process documents first." });
      }

      const { runDiscrepancyCheck } = await import("./cim/discrepancy-engine");
      const items = await runDiscrepancyCheck(
        {
          id: dealId,
          businessName: deal.businessName,
          industry: deal.industry,
          extractedInfo: (deal.extractedInfo as Record<string, any>) || {},
          questionnaireData: deal.questionnaireData as Record<string, any> | null,
        },
        processedDocs.map(d => ({
          id: d.id,
          name: d.name,
          category: d.category,
          extractedText: d.extractedText,
          extractedData: d.extractedData,
        })),
      );

      // Store discrepancies
      const created = [];
      for (const item of items) {
        const disc = await storage.createDiscrepancy({
          dealId,
          field: item.field,
          interviewValue: item.interviewValue,
          documentValue: item.documentValue,
          documentId: item.documentId,
          documentName: item.documentName,
          severity: item.severity,
          category: item.category,
          aiExplanation: item.aiExplanation,
          suggestedResolution: item.suggestedResolution,
          status: "open",
        });
        created.push(disc);
      }

      res.json({ success: true, count: created.length, discrepancies: created });
    } catch (error: any) {
      console.error("Error running discrepancy check:", error);
      res.status(500).json({ error: error.message || "Discrepancy check failed" });
    }
  });

  // Get discrepancies for a deal
  app.get("/api/deals/:dealId/discrepancies", async (req, res) => {
    try {
      const discrepancies = await storage.getDiscrepanciesByDeal(req.params.dealId);
      res.json(discrepancies);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to fetch discrepancies" });
    }
  });

  // Update a discrepancy (resolve, respond, etc.)
  app.patch("/api/discrepancies/:id", async (req, res) => {
    try {
      const { sellerResponse, brokerNotes, resolvedValue, status } = req.body;
      const updates: any = {};
      if (sellerResponse !== undefined) updates.sellerResponse = sellerResponse;
      if (brokerNotes !== undefined) updates.brokerNotes = brokerNotes;
      if (resolvedValue !== undefined) updates.resolvedValue = resolvedValue;
      if (status !== undefined) {
        updates.status = status;
        if (status === "resolved") {
          updates.resolvedAt = new Date();
        }
      }
      const updated = await storage.updateDiscrepancy(req.params.id, updates);
      if (!updated) return res.status(404).json({ error: "Discrepancy not found" });
      res.json(updated);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to update discrepancy" });
    }
  });

  // ════════════════════════════════════════════════════════════
  // DEAL TEAMS — Members, roles, notifications
  // ════════════════════════════════════════════════════════════

  // Get all members for a deal (grouped by team)
  app.get("/api/deals/:dealId/members", async (req, res) => {
    try {
      const members = await storage.getDealMembers(req.params.dealId);
      res.json(members);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to get members" });
    }
  });

  // Get members by team type
  app.get("/api/deals/:dealId/members/:teamType", async (req, res) => {
    try {
      const members = await storage.getDealMembersByTeam(req.params.dealId, req.params.teamType);
      res.json(members);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to get team members" });
    }
  });

  // Add a member to a deal
  app.post("/api/deals/:dealId/members", async (req, res) => {
    try {
      const { dealId } = req.params;
      const { email, name, phone, teamType, role, accessLevel } = req.body;

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
        accessLevel: accessLevel || (teamType === "buyer" ? "full" : null),
        emailNotifications: true,
        smsNotifications: !!phone,
      } as any);

      // Send invite notification
      const teamLabel = teamType.charAt(0).toUpperCase() + teamType.slice(1);
      await notify(dealId, "invite", {
        title: `You've been added to a deal`,
        body: `You've been added as ${roleConfig.label} (${teamLabel} team) for ${deal?.businessName || "a business"}. Click below to get started.`,
        actionUrl: teamType === "buyer"
          ? `/view/${inviteToken}`
          : `/seller/${inviteToken}`,
        businessName: deal?.businessName,
        specificMemberIds: [member.id],
      });

      res.json(member);
    } catch (error: any) {
      console.error("Error adding member:", error);
      res.status(500).json({ error: "Failed to add member" });
    }
  });

  // Update a member (role, permissions, notification prefs)
  app.patch("/api/members/:memberId", async (req, res) => {
    try {
      const updated = await storage.updateDealMember(req.params.memberId, req.body);
      if (!updated) return res.status(404).json({ error: "Member not found" });
      res.json(updated);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to update member" });
    }
  });

  // Remove a member
  app.delete("/api/members/:memberId", async (req, res) => {
    try {
      await storage.deleteDealMember(req.params.memberId);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: "Failed to remove member" });
    }
  });

  // Get notifications for a deal
  app.get("/api/deals/:dealId/notifications", async (req, res) => {
    try {
      const notifs = await storage.getNotificationsByDeal(req.params.dealId);
      res.json(notifs);
    } catch (error: any) {
      res.status(500).json({ error: "Failed to get notifications" });
    }
  });

  // Mark notification as read
  app.patch("/api/notifications/:id/read", async (req, res) => {
    try {
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
      const { question, buyerAccessId } = req.body;
      if (!question?.trim()) return res.status(400).json({ error: "Question required" });

      // ── Step 1: Check knowledge base — has a similar question been answered before? ──
      const publishedQs = await storage.getPublishedQuestions(dealId);
      if (publishedQs.length > 0) {
        const kbContext = publishedQs
          .map(q => `Q: ${q.question}\nA: ${q.publishedAnswer}`)
          .join("\n\n");

        const similarityCheck = await anthropic.messages.create({
          model: "claude-sonnet-4-5",
          max_tokens: 600,
          system: `You are a Q&A similarity matcher for a business CIM. Given a buyer's question and a knowledge base of previously answered questions, determine if any existing answer adequately addresses the new question.

If an existing answer covers the question (even if worded differently), respond with:
MATCH: <the existing answer, optionally rephrased to directly address the new question>

If no existing answer covers it, respond with exactly: NO_MATCH`,
          messages: [{
            role: "user",
            content: `KNOWLEDGE BASE:\n${kbContext}\n\nNEW QUESTION: ${question}`,
          }],
        });

        const matchText = similarityCheck.content[0].type === "text" ? similarityCheck.content[0].text : "";
        if (matchText.startsWith("MATCH:")) {
          const matchedAnswer = matchText.slice(6).trim();
          // Find the matched Q ID for linking
          const matchedQ = publishedQs.find(q =>
            matchedAnswer.includes(q.publishedAnswer?.slice(0, 50) || "___none___")
          );

          const saved = await storage.createBuyerQuestion({
            dealId,
            buyerAccessId: buyerAccessId || null,
            question,
            aiAnswer: matchedAnswer,
            status: "published",
            isPublished: true,
            publishedAnswer: matchedAnswer,
            addedToKnowledgeBase: true,
            similarQuestionIds: matchedQ ? [matchedQ.id] : [],
          } as any);

          return res.json({
            id: saved.id,
            answer: matchedAnswer,
            status: "published",
            message: matchedAnswer,
            fromKnowledgeBase: true,
          });
        }
      }

      // ── Step 2: Try to answer from CIM content ──
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
        addedToKnowledgeBase: !needsEscalation,
      } as any);

      // Notify broker when question needs manual response
      if (needsEscalation) {
        const deal = await storage.getDeal(dealId);
        notify(dealId, "buyer_question", {
          title: "New buyer question needs your response",
          body: `A buyer asked: "${question.slice(0, 100)}${question.length > 100 ? "..." : ""}"`,
          actionUrl: `/deal/${dealId}`,
          businessName: deal?.businessName,
        }).catch(() => {});
      }

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

  // Broker drafts/updates answer — generates approval token when sending to seller
  app.patch("/api/questions/:questionId", async (req, res) => {
    try {
      const { questionId } = req.params;
      const { brokerDraft, status, publishedAnswer, isPublished } = req.body;

      const updates: Record<string, any> = {};
      if (brokerDraft !== undefined) updates.brokerDraft = brokerDraft;
      if (status !== undefined) updates.status = status;
      if (publishedAnswer !== undefined) updates.publishedAnswer = publishedAnswer;
      if (isPublished !== undefined) updates.isPublished = isPublished;

      // Generate approval token when sending to seller
      if (status === "pending_seller") {
        updates.sellerApprovalToken = crypto.randomUUID();
      }

      const updated = await storage.updateBuyerQuestion(questionId, updates as any);

      // Auto-notify seller team when question needs approval
      if (status === "pending_seller" && updated) {
        const deal = await storage.getDeal(updated.dealId);
        notify(updated.dealId, "qa_needs_approval", {
          title: "A buyer question needs your approval",
          body: `Question: "${updated.question.slice(0, 100)}${updated.question.length > 100 ? "..." : ""}"`,
          actionUrl: `/approve/${updated.sellerApprovalToken}`,
          businessName: deal?.businessName,
        }).catch(() => {}); // fire-and-forget
      }

      res.json({
        ...updated,
        approvalLink: updated?.sellerApprovalToken
          ? `/approve/${updated.sellerApprovalToken}`
          : undefined,
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
        await storage.updateBuyerQuestion(question.id, {
          sellerApproved: true,
          sellerApprovedAt: new Date(),
          status: "published",
          isPublished: true,
          publishedAnswer,
          addedToKnowledgeBase: true,
        } as any);
        res.json({ success: true, status: "published" });
      } else {
        await storage.updateBuyerQuestion(question.id, {
          sellerApproved: false,
          status: "pending_broker",
        } as any);
        res.json({ success: true, status: "sent_back" });
      }
    } catch (error: any) {
      res.status(500).json({ error: "Failed to process approval" });
    }
  });

  // Legacy ID-based seller approve (for in-app use)
  app.post("/api/questions/:questionId/seller-approve", async (req, res) => {
    try {
      const { questionId } = req.params;
      const { approved, revision } = req.body;

      if (approved) {
        const question = await storage.updateBuyerQuestion(questionId, {
          sellerApproved: true,
          sellerApprovedAt: new Date(),
          status: "published",
          isPublished: true,
          publishedAnswer: revision || undefined,
          addedToKnowledgeBase: true,
        } as any);

        if (!question) return res.status(404).json({ error: "Question not found" });

        if (!revision && question.brokerDraft && !question.publishedAnswer) {
          await storage.updateBuyerQuestion(questionId, {
            publishedAnswer: question.brokerDraft,
          } as any);
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
  app.get("/api/deals/:dealId/questions/pending-seller", async (req, res) => {
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

  /* ══════════════════════════════════════════════
     Token lookup for role switcher (gated by ?switcher=1 on frontend)
  ══════════════════════════════════════════════ */
  {
    app.get("/api/dev/role-tokens", async (_req, res) => {
      try {
        const allDeals = await storage.getAllDeals();
        if (allDeals.length === 0) {
          return res.json({ sellerToken: null, buyerToken: null, dealId: null });
        }

        // Search up to 5 recent deals for tokens
        let sellerToken: string | null = null;
        let buyerToken: string | null = null;
        let dealId: string | null = null;
        let dealName: string | null = null;

        for (const deal of allDeals.slice(0, 5)) {
          if (!sellerToken) {
            const invites = await storage.getSellerInvitesByDealId(deal.id);
            if (invites.length > 0) {
              sellerToken = invites[0].token;
              if (!dealId) { dealId = deal.id; dealName = deal.businessName; }
            }
          }
          if (!buyerToken) {
            const access = await storage.getBuyerAccessByDeal(deal.id);
            if (access.length > 0) {
              buyerToken = access[0].accessToken;
              if (!dealId) { dealId = deal.id; dealName = deal.businessName; }
            }
          }
          if (sellerToken && buyerToken) break;
        }

        // Fallback dealId to first deal
        if (!dealId) { dealId = allDeals[0].id; dealName = allDeals[0].businessName; }

        res.json({ dealId, dealName, sellerToken, buyerToken });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });
  }

  const httpServer = createServer(app);
  return httpServer;
}
