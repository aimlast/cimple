/**
 * The brokerage's buyer NDA terms (shared/buyer-nda.ts).
 *
 *   GET  /api/broker/buyer-nda              brokerage default (+ the standard terms)
 *   PUT  /api/broker/buyer-nda              { terms: string | null } — null = standard terms
 *   GET  /api/deals/:dealId/buyer-nda       what buyers of this deal sign, and where it comes from
 *   PUT  /api/deals/:dealId/buyer-nda       { terms: string | null } — null = brokerage default
 *
 * Stored on the broker's own user row (settings.buyerNdaTerms and
 * settings.buyerNdaDealTerms[dealId]); written with a jsonb merge so a
 * concurrent Settings save never loses either.
 */
import type { Express } from "express";
import { z } from "zod";
import { sql, eq } from "drizzle-orm";
import { requireBroker, requireOwnedDeal } from "../broker-auth/routes.js";
import { storage } from "../storage";
import { db } from "../db";
import { users } from "@shared/schema";
import {
  BUYER_NDA_MAX_LENGTH, STANDARD_BUYER_NDA_TERMS, buyerNdaTemplateFor, cleanBuyerNdaTerms,
} from "@shared/buyer-nda";

const termsBody = z.object({
  terms: z.union([z.string().max(BUYER_NDA_MAX_LENGTH, `Keep the NDA under ${BUYER_NDA_MAX_LENGTH.toLocaleString()} characters`), z.null()]),
});

async function brokerSettings(brokerId: string): Promise<Record<string, unknown>> {
  const user = await storage.getUser(brokerId);
  return ((user?.settings as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
}

export function registerBuyerNdaRoutes(app: Express) {
  app.get("/api/broker/buyer-nda", requireBroker, async (req, res) => {
    try {
      const settings = await brokerSettings(req.session.brokerId!);
      res.json({ terms: cleanBuyerNdaTerms(settings.buyerNdaTerms), standardTerms: STANDARD_BUYER_NDA_TERMS });
    } catch (err) {
      console.error("[buyer-nda] read failed:", err);
      res.status(500).json({ error: "Couldn't load your NDA" });
    }
  });

  app.put("/api/broker/buyer-nda", requireBroker, async (req, res) => {
    const parsed = termsBody.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid NDA text" });
    try {
      const terms = cleanBuyerNdaTerms(parsed.data.terms);
      await db.update(users).set({
        settings: terms
          ? sql`coalesce(${users.settings}, '{}'::jsonb) || jsonb_build_object('buyerNdaTerms', ${terms}::text)`
          : sql`coalesce(${users.settings}, '{}'::jsonb) - 'buyerNdaTerms'`,
      }).where(eq(users.id, req.session.brokerId!));
      res.json({ terms });
    } catch (err) {
      console.error("[buyer-nda] save failed:", err);
      res.status(500).json({ error: "Couldn't save your NDA" });
    }
  });

  app.get("/api/deals/:dealId/buyer-nda", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const settings = await brokerSettings(req.session.brokerId!);
      const { template, source } = buyerNdaTemplateFor(settings, req.params.dealId);
      res.json({
        terms: template,
        source,
        dealTerms: source === "deal" ? template : null,
        brokerageTerms: cleanBuyerNdaTerms(settings.buyerNdaTerms),
        standardTerms: STANDARD_BUYER_NDA_TERMS,
      });
    } catch (err) {
      console.error("[buyer-nda] deal read failed:", err);
      res.status(500).json({ error: "Couldn't load this deal's NDA" });
    }
  });

  app.put("/api/deals/:dealId/buyer-nda", requireBroker, requireOwnedDeal, async (req, res) => {
    const parsed = termsBody.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid NDA text" });
    try {
      const dealId = req.params.dealId;
      const terms = cleanBuyerNdaTerms(parsed.data.terms);
      await db.update(users).set({
        settings: terms
          ? sql`jsonb_set(coalesce(${users.settings}, '{}'::jsonb), '{buyerNdaDealTerms}', coalesce(${users.settings}->'buyerNdaDealTerms', '{}'::jsonb) || jsonb_build_object(${dealId}::text, ${terms}::text))`
          : sql`jsonb_set(coalesce(${users.settings}, '{}'::jsonb), '{buyerNdaDealTerms}', coalesce(${users.settings}->'buyerNdaDealTerms', '{}'::jsonb) - ${dealId}::text)`,
      }).where(eq(users.id, req.session.brokerId!));
      const settings = await brokerSettings(req.session.brokerId!);
      const { template, source } = buyerNdaTemplateFor(settings, dealId);
      res.json({ terms: template, source });
    } catch (err) {
      console.error("[buyer-nda] deal save failed:", err);
      res.status(500).json({ error: "Couldn't save this deal's NDA" });
    }
  });
}
