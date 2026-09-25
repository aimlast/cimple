/**
 * Seller-side CRM import: link a deal to CRM records, pull notes/emails/files (workstream: crm-seller).
 * Registered from server/routes.ts (merge anchor) — keep this workstream's
 * new endpoints in this file.
 *
 *   GET    /api/crm/search?q=                           New Deal: search the broker's Pipedrive
 *   GET    /api/crm/records/:type/:id/prefill           New Deal: what a picked record can fill in
 *   GET    /api/deals/:dealId/crm/search?q=             search Pipedrive to link this deal
 *   GET    /api/deals/:dealId/crm/status                link + last import + the seller's contact
 *   POST   /api/deals/:dealId/crm/link                  {type, id, startImport?} — link (fills the seller contact)
 *   DELETE /api/deals/:dealId/crm/link                  unlink (imported sources stay)
 *   POST   /api/deals/:dealId/crm/import                202 — background import (409 while one runs)
 *   PUT    /api/deals/:dealId/seller-contact            {name?, email?, phone?, title?} — broker edit
 *
 * Every route is broker-only; deal routes are scoped to a deal the broker
 * owns, and Pipedrive is only ever called with the broker's own token.
 * See server/crm/seller-import.ts for what an import does.
 */
import type { Express, Request, Response } from "express";
import { storage } from "../storage";
import { requireBroker, requireOwnedDeal } from "../broker-auth/routes.js";
import { getPipedriveIntegration } from "../crm/pipedrive";
import {
  searchPipedrive,
  resolvePipedriveLink,
  startCrmImport,
  isImportRunning,
  buildCrmStatus,
  pipedriveErrorResponse,
  mayReplaceSellerContact,
  sellerContactFromCrm,
  CrmImportError,
} from "../crm/seller-import";
import type { CrmRecordType, Deal, DealCrmLink, DealSellerContact } from "@shared/schema";
import type { CrmSearchResponse } from "@shared/crm-seller";

const RECORD_TYPES: readonly CrmRecordType[] = ["deal", "organization", "person"];

function fail(res: Response, err: unknown, context: string) {
  const { status, error } = pipedriveErrorResponse(err);
  if (status >= 500) console.error(`[crm-seller] ${context}:`, err);
  return res.status(status).json({ error });
}

async function statusFor(dealId: string, brokerId: string) {
  const [deal, integration] = await Promise.all([storage.getDeal(dealId), getPipedriveIntegration(brokerId)]);
  if (!deal) throw new CrmImportError("Deal not found", 404);
  return buildCrmStatus(deal, !!integration);
}

async function search(req: Request, res: Response) {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.slice(0, 120) : "";
    const integration = await getPipedriveIntegration(req.session.brokerId!);
    if (!integration) return res.json({ connected: false, provider: null, results: [] } satisfies CrmSearchResponse);
    const results = await searchPipedrive(integration.accessToken, q);
    res.json({ connected: true, provider: "pipedrive", results } satisfies CrmSearchResponse);
  } catch (err) {
    fail(res, err, "search");
  }
}

function cleanText(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim().replace(/\s+/g, " ");
  return t ? t.slice(0, max) : undefined;
}

export function registerCrmSellerRoutes(app: Express): void {
  app.get("/api/crm/search", requireBroker, search);

  app.get("/api/crm/records/:type/:id/prefill", requireBroker, async (req, res) => {
    try {
      const type = req.params.type as CrmRecordType;
      if (!RECORD_TYPES.includes(type)) throw new CrmImportError("Pick a deal, organisation or person");
      const integration = await getPipedriveIntegration(req.session.brokerId!);
      if (!integration) throw new CrmImportError("Connect Pipedrive in Integrations first");
      const { prefill } = await resolvePipedriveLink(integration.accessToken, type, String(req.params.id));
      res.json(prefill);
    } catch (err) {
      fail(res, err, "prefill");
    }
  });

  app.get("/api/deals/:dealId/crm/search", requireBroker, requireOwnedDeal, search);

  app.get("/api/deals/:dealId/crm/status", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      res.json(await statusFor(req.params.dealId, req.session.brokerId!));
    } catch (err) {
      fail(res, err, "status");
    }
  });

  app.post("/api/deals/:dealId/crm/link", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const type = req.body?.type as CrmRecordType;
      const id = req.body?.id != null ? String(req.body.id) : "";
      if (!RECORD_TYPES.includes(type) || !/^\d+$/.test(id)) throw new CrmImportError("Pick a deal, organisation or person to link");
      if (isImportRunning(req.params.dealId)) throw new CrmImportError("Wait for the current import to finish before changing the link", 409);
      const integration = await getPipedriveIntegration(req.session.brokerId!);
      if (!integration) throw new CrmImportError("Connect Pipedrive in Integrations first");

      const resolved = await resolvePipedriveLink(integration.accessToken, type, id);
      const deal = res.locals.deal as Deal;
      const previous = (deal.crmLink as DealCrmLink | null) ?? null;
      // Re-linking the same records keeps what was already imported (so a
      // re-import skips it); a different record starts a fresh map — sources
      // already on the deal are still recognised by their CRM ids.
      const sameRecords =
        !!previous && previous.dealId === resolved.link.dealId && previous.orgId === resolved.link.orgId && previous.personId === resolved.link.personId;
      const link: DealCrmLink = {
        ...resolved.link,
        ...(sameRecords ? { imported: previous!.imported, lastImportAt: previous!.lastImportAt, lastImportStatus: previous!.lastImportStatus } : {}),
      };
      const updates: Record<string, unknown> = { crmLink: link };
      if (resolved.contact && mayReplaceSellerContact(deal.sellerContact as DealSellerContact | null)) {
        updates.sellerContact = sellerContactFromCrm(resolved.contact);
      }
      await storage.updateDeal(req.params.dealId, updates as any);

      if (req.body?.startImport) await startCrmImport(req.params.dealId, integration.accessToken);
      res.json(await statusFor(req.params.dealId, req.session.brokerId!));
    } catch (err) {
      fail(res, err, "link");
    }
  });

  app.delete("/api/deals/:dealId/crm/link", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      if (isImportRunning(req.params.dealId)) throw new CrmImportError("Wait for the current import to finish before unlinking", 409);
      await storage.updateDeal(req.params.dealId, { crmLink: null } as any);
      res.json(await statusFor(req.params.dealId, req.session.brokerId!));
    } catch (err) {
      fail(res, err, "unlink");
    }
  });

  app.post("/api/deals/:dealId/crm/import", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const integration = await getPipedriveIntegration(req.session.brokerId!);
      if (!integration) throw new CrmImportError("Connect Pipedrive in Integrations first");
      await startCrmImport(req.params.dealId, integration.accessToken);
      res.status(202).json(await statusFor(req.params.dealId, req.session.brokerId!));
    } catch (err) {
      fail(res, err, "import");
    }
  });

  app.put("/api/deals/:dealId/seller-contact", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      const name = cleanText(req.body?.name, 120);
      const email = cleanText(req.body?.email, 200)?.toLowerCase();
      const phone = cleanText(req.body?.phone, 60);
      const title = cleanText(req.body?.title, 120);
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new CrmImportError("That email address doesn't look right");
      const contact: DealSellerContact | null =
        name || email || phone || title ? { name, email, phone, title, source: "broker", updatedAt: new Date().toISOString() } : null;
      await storage.updateDeal(req.params.dealId, { sellerContact: contact } as any);
      res.json(await statusFor(req.params.dealId, req.session.brokerId!));
    } catch (err) {
      fail(res, err, "seller contact");
    }
  });
}
