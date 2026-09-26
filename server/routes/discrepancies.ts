/**
 * Discrepancy routes: run the verification check, list, resolve (writing
 * the resolved value into the fact it is about), pick the fact when none
 * maps, and carry a resolution through to other facts that still repeat
 * the ruled-out value.
 *
 * Every route is broker-only and scoped to the session broker's deals.
 */
import type { Express, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { storage } from "../storage";
import { requireBroker, requireOwnedDeal, getOwnedDeal } from "../broker-auth/routes";
import type { Discrepancy } from "@shared/schema";
import { discrepancyFieldLabel, discrepancySideValue, discrepancyHasPrivateSide, getSideSources } from "@shared/discrepancy-sides";
import { runAndPersistDiscrepancyCheck, getDiscrepancyCheckStatus } from "../cim/discrepancy-check";
import { settleMergeRowsQuietly } from "../documents/merge-conflicts";
import {
  applyDiscrepancyResolution,
  suggestFactTargets,
  mutateDealInfo,
  setBrokerFact,
  setBrokerMapEntry,
  addFact,
  markHiddenFromSeller,
  resolvedToPrivateSide,
  NEEDS_MAPPING,
  NARRATIVE_FACT,
  NO_FACT_KEY,
  resolutionTarget,
  factDisplayLabel,
  FactError,
} from "../information/facts";
import { findStaleFacts, proposeRewrites, type ResolutionSubject } from "../information/resolution-propagation";
import { planResolution, valueAtTarget, resolutionSourceExtras } from "../information/resolution-write";
import { isFactKey } from "../interview/info-merger";
import { numberTokens, tokensMatch } from "../cim/discrepancy-filter";
import { GENERIC_FIELD_LABELS } from "../interview/interview-plan";

// Same ceiling as the other AI endpoints (server/index.ts aiLimiter).
const aiLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please slow down and try again shortly." },
});

const DISCREPANCY_STATUSES = new Set(["open", "seller_responded", "resolved", "accepted", "ask_seller", "superseded"]);

/** The row, only when its deal belongs to the session broker. */
async function ownedDiscrepancy(req: Request): Promise<Discrepancy | null> {
  const row = await storage.getDiscrepancy(req.params.id);
  if (!row) return null;
  return (await getOwnedDeal(row.dealId, req.session.brokerId)) ? row : null;
}

/** What a resolution settled, for finding facts that still say the old value. */
export function resolutionSubject(d: Discrepancy): ResolutionSubject | null {
  const resolvedValue = (d.resolvedValue || "").trim();
  if (!resolvedValue) return null;
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  // The side the broker accepted isn't superseded — its headline figure is
  // the resolved one (its working, "$563,190 + $130K …", is not outdated).
  const lead = numberTokens(resolvedValue)[0];
  const superseded = [discrepancySideValue(d, "interview"), discrepancySideValue(d, "document")].filter((v) => {
    if (!v || norm(v) === norm(resolvedValue)) return false;
    const first = numberTokens(v)[0];
    return !(lead && first && tokensMatch({ ...lead, approx: false }, { ...first, approx: false }));
  });
  return {
    field: discrepancyFieldLabel(d),
    factKey: d.factKey && !d.factKey.startsWith("_") ? d.factKey : null,
    factYear: d.factYear || null,
    resolvedValue,
    supersededValues: superseded,
  };
}

/**
 * Facts that still say what a resolution ruled out — plus the resolution's
 * own fact when it is a description the value wasn't written into (it is
 * offered for a rewrite instead of being overwritten with a bare value).
 */
export function staleFactsForRow(info: Record<string, unknown>, d: Discrepancy, opts: { brokerChoseFact?: boolean } = {}) {
  const base = resolutionSubject(d);
  if (!base || d.status !== "resolved") return { subject: null, stale: [] as ReturnType<typeof findStaleFacts> };
  const target = resolutionTarget(info, d);
  let subject: ResolutionSubject = base;
  if (target && target !== NO_FACT_KEY) {
    if (!subject.factKey) subject = { ...subject, factKey: target.key, factYear: subject.factYear ?? target.sub ?? null };
    const cur = valueAtTarget(info, target);
    const written = typeof cur === "string" && cur.trim() === base.resolvedValue;
    if (!written && planResolution(info, target, d, opts).kind === "narrative") subject = { ...subject, includeTarget: target.key };
  }
  return { subject, stale: findStaleFacts(info, subject) };
}

async function staleFactsFor(d: Discrepancy, opts: { brokerChoseFact?: boolean } = {}) {
  const deal = await storage.getDeal(d.dealId);
  const info = ((deal?.extractedInfo as Record<string, unknown> | null) || {});
  return staleFactsForRow(info, d, opts);
}

function validFactKeyFor(info: Record<string, unknown>, key: string): boolean {
  return /^[a-z][A-Za-z0-9]*$/.test(key) && isFactKey(key) && (key in info || !!GENERIC_FIELD_LABELS[key] || key === "revenueByYear");
}

export function registerDiscrepancyRoutes(app: Express) {
  // Run the verification check (stamps the deal with what it compared).
  app.post("/api/deals/:dealId/run-discrepancy-check", requireBroker, requireOwnedDeal, aiLimiter, async (req, res) => {
    try {
      const result = await runAndPersistDiscrepancyCheck(req.params.dealId);
      res.json({
        success: true,
        count: result.count,
        refreshed: result.refreshed,
        cleared: result.cleared,
        dropped: result.dropped,
        discrepancies: result.created,
      });
    } catch (error: any) {
      if (error?.status === 400) return res.status(400).json({ error: error.message });
      console.error("Error running discrepancy check:", error);
      res.status(500).json({ error: error?.message || "Discrepancy check failed" });
    }
  });

  // When the check last ran, and whether sources changed since.
  app.get("/api/deals/:dealId/discrepancy-check-status", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      res.json(await getDiscrepancyCheckStatus(req.params.dealId));
    } catch (error: any) {
      res.status(500).json({ error: "Failed to read the discrepancy check status" });
    }
  });

  // Each resolved row says which fact it updated (or that it needs one
  // picked) and how many other facts still state the value it ruled out.
  app.get("/api/deals/:dealId/discrepancies", requireBroker, requireOwnedDeal, async (req, res) => {
    try {
      // Merge rows whose conflict no longer stands are superseded before the panel sees them.
      await settleMergeRowsQuietly(req.params.dealId, "discrepancies");
      const rows = await storage.getDiscrepanciesByDeal(req.params.dealId);
      const deal = await storage.getDeal(req.params.dealId);
      const info = ((deal?.extractedInfo as Record<string, unknown> | null) || {});
      res.json(
        rows.map((d) => {
          if (d.status !== "resolved" || !(d.resolvedValue || "").trim()) return d;
          const resolvedValue = (d.resolvedValue || "").trim();
          let target = resolutionTarget(info, d);
          let narrative = false;
          if (target && target !== NO_FACT_KEY) {
            // Written already (the fact holds the resolved value); otherwise
            // the same rules as the write decide: a fact that plainly isn't
            // this figure still needs a pick, a description gets a rewrite.
            const cur = valueAtTarget(info, target);
            const written = typeof cur === "string" && cur.trim() === resolvedValue;
            if (!written) {
              const plan = planResolution(info, target, d);
              if (plan.kind === "needs_mapping") target = null;
              else narrative = plan.kind === "narrative";
            }
          }
          const linkedFact =
            target && target !== NO_FACT_KEY && !narrative
              ? { key: target.sub ? `${target.key}.${target.sub}` : target.key, label: factDisplayLabel(info, target.key) + (target.sub ? ` (${target.sub})` : "") }
              : null;
          const staleFactCount = staleFactsForRow(info, d).stale.length;
          return { ...d, linkedFact, needsFactMapping: target === null, staleFactCount };
        }),
      );
    } catch (error: any) {
      res.status(500).json({ error: "Failed to fetch discrepancies" });
    }
  });

  // Update a discrepancy (resolve, respond, route, link to a fact).
  app.patch("/api/discrepancies/:id", requireBroker, async (req, res) => {
    try {
      const existingDisc = await ownedDiscrepancy(req);
      if (!existingDisc) return res.status(404).json({ error: "Discrepancy not found" });
      const { sellerResponse, brokerNotes, resolvedValue, status, factKey, factYear, newFactLabel } = req.body ?? {};
      if (status !== undefined && !DISCREPANCY_STATUSES.has(String(status))) {
        return res.status(400).json({ error: `Invalid status "${status}"` });
      }
      const updates: Record<string, unknown> = {};
      if (sellerResponse !== undefined) updates.sellerResponse = sellerResponse;
      if (brokerNotes !== undefined) updates.brokerNotes = brokerNotes;
      if (resolvedValue !== undefined) updates.resolvedValue = resolvedValue;
      if (status !== undefined) {
        updates.status = status;
        if (status === "resolved") updates.resolvedAt = new Date();
        // Routed to the seller's interview: a side that is (or names) the
        // broker's private material is flagged on the row itself, so the
        // interview never shows or quotes it — whatever the text says.
        if (status === "ask_seller") {
          const priv = discrepancyHasPrivateSide(existingDisc);
          if (priv.interview || priv.document) {
            const sides = getSideSources(existingDisc);
            updates.sideSources = {
              ...sides,
              ...(priv.interview ? { interview: { ...(sides.interview ?? { kind: "crm" }), brokerOnly: true } } : {}),
              ...(priv.document ? { document: { ...(sides.document ?? { kind: "crm" }), brokerOnly: true } } : {}),
            };
          }
        }
      }
      // "Which fact should this update?" — the broker's pick (or "none").
      if (factKey !== undefined) {
        const key = typeof factKey === "string" ? factKey.trim() : "";
        if (!key || key === NO_FACT_KEY) {
          updates.factKey = NO_FACT_KEY;
          updates.factYear = null;
        } else {
          const deal = await storage.getDeal(existingDisc.dealId);
          const info = ((deal?.extractedInfo as Record<string, unknown> | null) || {});
          if (!validFactKeyFor(info, key)) return res.status(400).json({ error: "That isn't a fact on this deal" });
          updates.factKey = key;
          updates.factYear = typeof factYear === "string" && factYear.trim() ? factYear.trim() : null;
        }
      }
      const updated = await storage.updateDiscrepancy(req.params.id, updates as any);
      if (!updated) return res.status(404).json({ error: "Discrepancy not found" });

      // The broker's resolution becomes the fact on file (source "broker"),
      // with the conflicting values kept as alternates. A resolution that
      // names no fact asks the broker which one it updates — never a silent
      // no-op.
      let factWrite:
        | { status: "written"; key: string }
        | { status: "narrative"; key: string }
        | { status: "needs_mapping" }
        | { status: "not_linked" }
        | null = null;
      let staleFacts: ReturnType<typeof findStaleFacts> = [];
      // "Save as a new fact": the resolution becomes a broker fact of its own.
      const newLabel = typeof newFactLabel === "string" ? newFactLabel.trim().slice(0, 120) : "";
      if (newLabel && updated.status === "resolved" && (updated.resolvedValue || "").trim()) {
        // Resolved to the broker's own material's value: the new fact is as
        // private to the seller interview as its source (see resolvedToPrivateSide).
        const brokerOnlyDocIds = new Set(
          (await storage.getDocumentsByDeal(updated.dealId)).filter((doc) => doc.visibility === "broker_only").map((doc) => doc.id),
        );
        const hidden = resolvedToPrivateSide(updated, String(updated.resolvedValue).trim(), brokerOnlyDocIds);
        const key = await mutateDealInfo(updated.dealId, (info) => {
          const k = addFact(info, newLabel, String(updated.resolvedValue).trim(), null);
          if (hidden) markHiddenFromSeller(info, k);
          return k;
        });
        const linked = (await storage.updateDiscrepancy(updated.id, { factKey: key, factYear: null } as any)) ?? updated;
        return res.json({ ...linked, factWrite: { status: "written", key }, staleFacts: (await staleFactsFor(linked)).stale });
      }
      const shouldWrite =
        updated.status === "resolved" &&
        typeof updated.resolvedValue === "string" &&
        updated.resolvedValue.trim() &&
        (status === "resolved" || resolvedValue !== undefined || factKey !== undefined);
      if (shouldWrite) {
        try {
          // A fact the broker just picked is trusted as is.
          const result = await applyDiscrepancyResolution(updated, { brokerChoseFact: factKey !== undefined });
          if (result === NEEDS_MAPPING) factWrite = { status: "needs_mapping" };
          else if (result === null) factWrite = { status: "not_linked" };
          else if (result === NARRATIVE_FACT) {
            // A description the figure is part of: offer its rewrite instead of overwriting it.
            const deal = await storage.getDeal(updated.dealId);
            const target = resolutionTarget(((deal?.extractedInfo as Record<string, unknown> | null) || {}), updated);
            factWrite = { status: "narrative", key: target && target !== NO_FACT_KEY ? target.key : "" };
            staleFacts = (await staleFactsFor(updated, { brokerChoseFact: factKey !== undefined })).stale;
          }
          else {
            factWrite = { status: "written", key: result };
            staleFacts = (await staleFactsFor(updated)).stale;
          }
        } catch (e) {
          console.warn("[discrepancies] couldn't write the resolution into the deal's facts:", e);
        }
      }
      res.json({ ...updated, factWrite, staleFacts });
    } catch (error: any) {
      res.status(500).json({ error: "Failed to update discrepancy" });
    }
  });

  // Facts a resolution could update — for the picker.
  app.get("/api/discrepancies/:id/fact-targets", requireBroker, async (req, res) => {
    try {
      const d = await ownedDiscrepancy(req);
      if (!d) return res.status(404).json({ error: "Discrepancy not found" });
      const deal = await storage.getDeal(d.dealId);
      const info = ((deal?.extractedInfo as Record<string, unknown> | null) || {});
      res.json(suggestFactTargets(info, d));
    } catch (error: any) {
      res.status(500).json({ error: "Failed to list facts" });
    }
  });

  // Other facts that still state the value this resolution ruled out.
  app.get("/api/discrepancies/:id/propagation", requireBroker, async (req, res) => {
    try {
      const d = await ownedDiscrepancy(req);
      if (!d) return res.status(404).json({ error: "Discrepancy not found" });
      const { stale } = await staleFactsFor(d);
      res.json({ staleFacts: stale });
    } catch (error: any) {
      res.status(500).json({ error: "Failed to check related facts" });
    }
  });

  // Suggested rewrites for those facts (the broker reviews before applying).
  app.post("/api/discrepancies/:id/propagation/propose", requireBroker, aiLimiter, async (req, res) => {
    try {
      const d = await ownedDiscrepancy(req);
      if (!d) return res.status(404).json({ error: "Discrepancy not found" });
      const { subject, stale } = await staleFactsFor(d);
      if (!subject || stale.length === 0) return res.json({ proposals: [] });
      res.json({ proposals: await proposeRewrites(stale, subject) });
    } catch (error: any) {
      console.error("Error proposing fact rewrites:", error);
      res.status(500).json({ error: "Couldn't suggest the updates" });
    }
  });

  // Apply the broker's reviewed rewrites as broker edits (old text kept as another value).
  app.post("/api/discrepancies/:id/propagation/apply", requireBroker, async (req, res) => {
    try {
      const d = await ownedDiscrepancy(req);
      if (!d) return res.status(404).json({ error: "Discrepancy not found" });
      const edits = Array.isArray(req.body?.edits) ? (req.body.edits as Array<{ key?: unknown; value?: unknown }>) : [];
      const clean = edits
        .filter((e) => typeof e?.key === "string" && typeof e?.value === "string" && e.value.trim())
        .map((e) => ({ key: String(e.key), value: String(e.value).trim() }));
      if (clean.length === 0) return res.status(400).json({ error: "Nothing to apply" });
      const label = discrepancyFieldLabel(d);
      // A rewrite that carries a figure the broker took from their own
      // private notes stays private from the seller, like the resolution.
      const extra = resolutionSourceExtras(d, (d.resolvedValue || "").trim());
      const applied = await mutateDealInfo(d.dealId, (info) => {
        const done: string[] = [];
        for (const e of clean) {
          // "revenueByYear.2024": one year of a by-year map.
          const dot = e.key.indexOf(".");
          const key = dot > 0 ? e.key.slice(0, dot) : e.key;
          const sub = dot > 0 ? e.key.slice(dot + 1) : "";
          if (!isFactKey(key) || key.startsWith("_") || info[key] === undefined || info[key] === null) continue;
          const note = `Updated to match the resolved ${label}`;
          if (sub) {
            const map = info[key];
            if (!map || typeof map !== "object" || Array.isArray(map) || !(sub in (map as Record<string, unknown>))) continue;
            if ((map as Record<string, unknown>)[sub] === e.value) continue;
            setBrokerMapEntry(info, key, sub, e.value, note, extra);
          } else {
            if (info[key] === e.value) continue;
            setBrokerFact(info, key, e.value, { note, ...extra });
          }
          done.push(e.key);
        }
        return done;
      });
      const { stale } = await staleFactsFor(d);
      res.json({ applied, staleFacts: stale });
    } catch (error: any) {
      if (error instanceof FactError) return res.status(error.status).json({ error: error.message });
      console.error("Error applying fact rewrites:", error);
      res.status(500).json({ error: "Couldn't update the facts" });
    }
  });
}
