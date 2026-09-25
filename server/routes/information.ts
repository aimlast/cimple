/**
 * Deal Information tab: facts with provenance, broker edits, sources (workstream: information).
 * Registered from server/routes.ts (merge anchor) — keep this workstream's
 * new endpoints in this file.
 *
 *   GET    /api/deals/:dealId/information                              the whole view (shared/information.ts)
 *   PUT    /api/deals/:dealId/information/facts/:key                   {value} — broker edit
 *   POST   /api/deals/:dealId/information/facts                        {label, value, section} — new fact
 *   DELETE /api/deals/:dealId/information/facts/:key                   delete (suppressed, restorable)
 *   POST   /api/deals/:dealId/information/facts/:key/restore           undo a delete
 *   POST   /api/deals/:dealId/information/facts/:key/use-alternate     {index} — adopt another source's value
 *   POST   /api/deals/:dealId/information/website/:field/accept        scraped website value → fact
 *   POST   /api/deals/:dealId/information/sources                      {kind, title, text, meta?, visibility?, category?}
 *   GET    /api/deals/:dealId/information/sources/:docId/text          a source's text (email, transcript, note)
 *   PATCH  /api/deals/:dealId/information/sources/:docId               {title?, visibility?, meta?}
 *
 * Every route is broker-only and scoped to a deal the broker owns. Mutations
 * answer with the refreshed view so the tab updates in one round trip.
 */
import type { Express, Request, Response } from "express";
import { storage } from "../storage";
import { requireBroker, requireOwnedDeal } from "../broker-auth/routes.js";
import { buildInformationView } from "../information/view";
import {
  mutateDealInfo,
  brokerFactsView,
  editFact,
  addFact,
  deleteFact,
  restoreFact,
  useAlternate,
  acceptWebsiteFact,
  FactError,
} from "../information/facts";
import { isSourceKind } from "../interview/info-merger";
import { createAndIngestSource, cleanSourceMeta, defaultVisibilityForKind, documentKind } from "../documents/ingest";
import { CIM_SECTIONS } from "@shared/schema";

const FACT_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,80}(\.[A-Za-z0-9_ -]{1,40})?$/;
const MAX_SOURCE_TEXT = 400_000;

async function loadView(dealId: string) {
  const deal = await storage.getDeal(dealId);
  if (!deal) throw new FactError("Deal not found", 404);
  const { db } = await import("../db");
  const { interviewSessions } = await import("@shared/schema");
  const { eq } = await import("drizzle-orm");
  const [documents, sessions] = await Promise.all([
    storage.getDocumentsByDeal(dealId),
    db.select().from(interviewSessions).where(eq(interviewSessions.dealId, dealId)),
  ]);
  // Read-only: a deal whose asking-price copies drifted apart is shown lined
  // up (in memory); the broker's next change saves that.
  return buildInformationView({ deal: brokerFactsView(deal), documents, sessions });
}

function fail(res: Response, err: unknown, fallback: string) {
  if (err instanceof FactError) return res.status(err.status).json({ error: err.message });
  console.error(`[information] ${fallback}:`, err);
  return res.status(500).json({ error: fallback });
}

function factKeyParam(req: Request): string {
  const key = String(req.params.key || "");
  if (!FACT_KEY_RE.test(key) || key.startsWith("_")) throw new FactError("That isn't a fact key");
  return key;
}

export function registerInformationRoutes(app: Express): void {
  app.get("/api/deals/:dealId/information", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      // Read-only — opening the tab never writes to the deal.
      res.json(await loadView(req.params.dealId));
    } catch (err) {
      fail(res, err, "Couldn't load the collected information");
    }
  });

  app.put("/api/deals/:dealId/information/facts/:key", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const key = factKeyParam(req);
      if (key.includes(".")) throw new FactError("Edit the whole fact, not one part of it");
      const value = req.body?.value;
      if (value === undefined || value === null) throw new FactError("Enter a value");
      if (typeof value === "string" && value.length > 20_000) throw new FactError("That value is too long");
      await mutateDealInfo(req.params.dealId, (info) => editFact(info, key, value));
      res.json(await loadView(req.params.dealId));
    } catch (err) {
      fail(res, err, "Couldn't save the change");
    }
  });

  app.post("/api/deals/:dealId/information/facts", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const label = typeof req.body?.label === "string" ? req.body.label : "";
      const value = typeof req.body?.value === "string" ? req.body.value : "";
      if (value.length > 20_000) throw new FactError("That value is too long");
      const rawSection = typeof req.body?.section === "string" ? req.body.section : null;
      const section = rawSection && CIM_SECTIONS.some((s) => s.key === rawSection) ? rawSection : null;
      const key = await mutateDealInfo(req.params.dealId, (info) => addFact(info, label, value, section));
      res.json({ key, view: await loadView(req.params.dealId) });
    } catch (err) {
      fail(res, err, "Couldn't add the fact");
    }
  });

  app.delete("/api/deals/:dealId/information/facts/:key", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const key = factKeyParam(req);
      if (key.includes(".")) throw new FactError("Delete the whole fact, not one part of it");
      await mutateDealInfo(req.params.dealId, (info) => deleteFact(info, key));
      res.json(await loadView(req.params.dealId));
    } catch (err) {
      fail(res, err, "Couldn't delete the fact");
    }
  });

  app.post("/api/deals/:dealId/information/facts/:key/restore", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const key = factKeyParam(req);
      await mutateDealInfo(req.params.dealId, (info) => restoreFact(info, key));
      res.json(await loadView(req.params.dealId));
    } catch (err) {
      fail(res, err, "Couldn't restore the fact");
    }
  });

  app.post("/api/deals/:dealId/information/facts/:key/use-alternate", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const key = factKeyParam(req);
      const index = Number(req.body?.index);
      if (!Number.isInteger(index) || index < 0) throw new FactError("Pick one of the other values");
      await mutateDealInfo(req.params.dealId, (info) => useAlternate(info, key, index));
      res.json(await loadView(req.params.dealId));
    } catch (err) {
      fail(res, err, "Couldn't use that value");
    }
  });

  app.post("/api/deals/:dealId/information/website/:field/accept", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const field = String(req.params.field || "");
      const deal = await storage.getDeal(req.params.dealId);
      const scraped = ((deal?.scrapedData as Record<string, unknown> | null) || {})[field];
      if (typeof scraped !== "string" || !scraped.trim()) throw new FactError("That website item isn't available", 404);
      const result = await mutateDealInfo(req.params.dealId, (info) => acceptWebsiteFact(info, field, scraped.trim()));
      res.json({ ...result, view: await loadView(req.params.dealId) });
    } catch (err) {
      fail(res, err, "Couldn't accept that item");
    }
  });

  // Pasted sources (email, call / video-call transcript, CRM note, website or
  // social post, any text). File uploads go through
  // POST /api/deals/:dealId/documents/upload with sourceKind/sourceMeta/visibility.
  app.post("/api/deals/:dealId/information/sources", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const kind = isSourceKind(req.body?.kind) ? req.body.kind : null;
      if (!kind || kind === "broker" || kind === "system" || kind === "interview" || kind === "questionnaire") {
        throw new FactError("Choose what kind of source this is");
      }
      const text = typeof req.body?.text === "string" ? req.body.text : "";
      if (text.trim().length < 20) throw new FactError("Paste the text of the source (at least a sentence)");
      if (text.length > MAX_SOURCE_TEXT) throw new FactError("That text is too long — upload it as a file instead");
      const meta = cleanSourceMeta(req.body?.meta);
      const fallbackTitle: Record<string, string> = {
        email: meta?.subject ? `Email — ${meta.subject}` : "Email",
        call: "Call transcript",
        video_call: "Video-call transcript",
        crm: "CRM note",
        website: "Website page",
        social: "Social media post",
        document: "Pasted text",
      };
      const title = (typeof req.body?.title === "string" && req.body.title.trim()) || fallbackTitle[kind] || "Source";
      const visibility =
        req.body?.visibility === "broker_only" || req.body?.visibility === "shared" ? req.body.visibility : defaultVisibilityForKind(kind);
      const category = typeof req.body?.category === "string" && req.body.category.trim() ? req.body.category.trim() : undefined;
      const doc = await createAndIngestSource({
        dealId: req.params.dealId,
        kind,
        title,
        text,
        meta,
        visibility,
        category,
        uploadedBy: "broker",
        background: true,
      });
      res.json(doc);
    } catch (err) {
      fail(res, err, "Couldn't add the source");
    }
  });

  app.get("/api/deals/:dealId/information/sources/:docId/text", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const doc = await storage.getDocument(req.params.docId);
      if (!doc || doc.dealId !== req.params.dealId) throw new FactError("Source not found", 404);
      res.json({
        id: doc.id,
        title: doc.name,
        kind: documentKind(doc),
        meta: doc.sourceMeta ?? null,
        visibility: doc.visibility === "broker_only" ? "broker_only" : "shared",
        text: doc.extractedText ?? "",
        fileUrl: doc.fileUrl,
        mimeType: doc.mimeType,
        status: doc.status,
      });
    } catch (err) {
      fail(res, err, "Couldn't open the source");
    }
  });

  app.patch("/api/deals/:dealId/information/sources/:docId", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const doc = await storage.getDocument(req.params.docId);
      if (!doc || doc.dealId !== req.params.dealId) throw new FactError("Source not found", 404);
      const updates: Record<string, unknown> = {};
      if (typeof req.body?.title === "string" && req.body.title.trim()) updates.name = req.body.title.trim().slice(0, 200);
      if (req.body?.visibility === "broker_only" || req.body?.visibility === "shared") updates.visibility = req.body.visibility;
      if (req.body?.meta !== undefined) updates.sourceMeta = cleanSourceMeta(req.body.meta);
      if (Object.keys(updates).length === 0) throw new FactError("Nothing to change");
      await storage.updateDocument(doc.id, updates as any);
      res.json(await loadView(req.params.dealId));
    } catch (err) {
      fail(res, err, "Couldn't update the source");
    }
  });
}
