/**
 * The broker's routes of "Add-backs in the books" (gl spec §6.7), pass 2:
 * the panel's data, the request to the seller (send / remind / withdraw),
 * reviewing, editing an add-back, the tie-out, the fiscal-year end, the
 * hold switch, going ahead without the ledger, the accountant hand-off,
 * ticking entries and searching the ledger.
 *
 * Every route: requireBroker + requireOwnedDeal; every id re-checked to
 * belong to :dealId (404 otherwise); bodies through allowlists — the
 * server-owned columns (deal, ledger, row, snapshots, computed, published,
 * AI counters) are refused with 400. Nothing is emailed unless the broker
 * clicked the button that says so; demo deals record, never email.
 */
import type { Express, Request, Response } from "express";
import { storage } from "../storage";
import { requireBroker, requireOwnedDeal } from "../broker-auth/routes";
import { TEAM_ROLES, type GlAddbackTrace, type GlTracing } from "@shared/schema";
import { normaliseFiscalYearEnd } from "@shared/fiscal-year";
import { glStore } from "./store";
import { withGlLock } from "./lock";
import { traceHasActivity } from "@shared/gl-reconcile";
import { loadGlContext } from "./context";
import { changeFiscalYearEnd, refreshGl } from "./service";
import { glRecipients } from "./broker-view";
import { proposeForTraces, proposeUnlocked, recomputeTraces } from "./match-run";
import { parseLinkWrite, writeLinks, confirmSummary } from "./links";
import { tieOutFor } from "./tie-out";
import { gateFrom } from "./gate";
import { glProgressForDeal } from "./progress";
import { remindGlRequest, sendGlRequest, sendTraceQuestion } from "./notify";
import { sellerEntry } from "./seller-view";
import { parseMoneyToCents } from "./text";
import { buildEvidence, buyerMaskBasics, evidenceChangeCount, publishEvidence, publishPreview, unpublishEvidence } from "./evidence";
import { maskForBuyer } from "./sensitive";
import { personsFor } from "./match-run";

const dealIdOf = (req: Request) => String(req.params.dealId);

/** Refuses a body carrying any key outside the allowlist (400 with the key's name). */
export function refuseUnknownKeys(body: unknown, allowed: readonly string[]): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const bad = Object.keys(body).find((k) => !allowed.includes(k));
  return bad ? `"${bad}" can't be set here` : null;
}

async function ownedTrace(req: Request, res: Response): Promise<GlAddbackTrace | null> {
  const t = await glStore().getTrace(String(req.params.traceId));
  if (!t || t.dealId !== dealIdOf(req) || t.removedAt) {
    res.status(404).json({ error: "Add-back not found" });
    return null;
  }
  return t;
}

const fail = (res: Response, what: string) => (err: unknown) => {
  const status = (err as { status?: number })?.status;
  if (status && status >= 400 && status < 500) return res.status(status).json({ error: (err as Error).message });
  console.error(`[gl] ${what} failed:`, err);
  if (!res.headersSent) res.status(500).json({ error: `Couldn't ${what} — try again.` });
};

const brokerName = async (req: Request) => {
  const u = req.session.brokerId ? await storage.getUser(req.session.brokerId) : undefined;
  return (u as { name?: string | null } | undefined)?.name ?? null;
};

/** After the broker reviews: the request-level "reviewed" stamp follows the add-backs. */
async function stampReviewed(dealId: string): Promise<void> {
  const store = glStore();
  const [tracing, traces] = await Promise.all([store.getTracing(dealId), store.listTraces(dealId)]);
  const gate = gateFrom(tracing, traces);
  const reviewed = gate.state === "done";
  if (reviewed !== !!tracing?.reviewedAt) await store.updateTracing(dealId, { reviewedAt: reviewed ? new Date() : null } as Partial<GlTracing>);
}

const TRACE_PATCH_KEYS = ["sellerLabel", "sellerHint", "proof", "sharePct", "shareBasis", "shareBasisDoc", "brokerNote", "brokerNoteShown", "sellerNoteShown", "buyerReason", "includeInCim", "leftOut", "links"] as const;

/** The broker's edit of one add-back → a patch, or a plain error (pure). */
export function tracePatchFrom(body: Record<string, unknown>, trace: Pick<GlAddbackTrace, "claims">): { patch: Partial<GlAddbackTrace>; links: Array<{ id: string; showDetails: boolean | null }> } | { error: string } {
  const patch: Partial<GlAddbackTrace> = {};
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : null);
  if (body.sellerLabel !== undefined) {
    const v = text(body.sellerLabel, 120);
    if (!v) return { error: "Give the cost a name the seller will recognise." };
    patch.sellerLabel = v;
  }
  if (body.sellerHint !== undefined) patch.sellerHint = text(body.sellerHint, 300) || null;
  if (body.proof !== undefined) {
    if (!["ledger", "payroll", "one_off", "statement"].includes(String(body.proof))) return { error: "Pick how this add-back is shown." };
    patch.proof = String(body.proof);
    patch.proofByBroker = true;
  }
  if (body.sharePct !== undefined) {
    if (body.sharePct === null) {
      patch.sharePct = null;
      patch.shareBasis = null;
      patch.shareBasisDoc = null;
    } else {
      const n = Number(body.sharePct);
      if (!Number.isInteger(n) || n < 1 || n > 100) return { error: "The share added back is a whole percentage from 1 to 100." };
      patch.sharePct = n === 100 ? null : n;
      if (n === 100) patch.shareBasis = null;
    }
  }
  if (body.shareBasis !== undefined) {
    if (body.shareBasis !== null && body.shareBasis !== "estimate" && body.shareBasis !== "documented") return { error: "Pick how the share is known." };
    patch.shareBasis = body.shareBasis as string | null;
  }
  if (body.shareBasisDoc !== undefined) patch.shareBasisDoc = text(body.shareBasisDoc, 200) || null;
  if (patch.shareBasis === "documented" && !(patch.shareBasisDoc ?? "").trim() && body.shareBasisDoc === undefined) return { error: "Name the document that shows the share." };
  if (body.brokerNote !== undefined) patch.brokerNote = text(body.brokerNote, 2000) || null;
  if (body.buyerReason !== undefined) patch.buyerReason = text(body.buyerReason, 1200) ?? "";
  for (const k of ["brokerNoteShown", "sellerNoteShown", "includeInCim"] as const) {
    if (body[k] !== undefined) {
      if (typeof body[k] !== "boolean") return { error: "That switch takes on or off." };
      (patch as any)[k] = body[k];
    }
  }
  if (body.leftOut !== undefined) {
    if (body.leftOut === null) patch.leftOut = null;
    else {
      const lo = body.leftOut as { years?: unknown; reason?: unknown };
      const years = Array.isArray(lo?.years) ? lo.years.map(String).filter((y) => /^\d{4}$/.test(y) && y in ((trace.claims as Record<string, number>) ?? {})) : [];
      const reason = text(lo?.reason, 300);
      if (years.length === 0) return { error: "Pick the year to leave out." };
      if (!reason) return { error: "Say why the year is left out." };
      patch.leftOut = { years, reason };
    }
  }
  const links: Array<{ id: string; showDetails: boolean | null }> = [];
  if (body.links !== undefined) {
    if (!Array.isArray(body.links) || body.links.length > 500) return { error: "Those entries couldn't be read." };
    for (const l of body.links) {
      const id = typeof (l as any)?.id === "string" ? (l as any).id : "";
      const sd = (l as any)?.showDetails;
      if (!id || (sd !== null && typeof sd !== "boolean")) return { error: "Those entries couldn't be read." };
      links.push({ id, showDetails: sd });
    }
  }
  return { patch, links };
}

export function registerGlBrokerRoutes(app: Express): void {
  const auth = [requireBroker, requireOwnedDeal] as const;

  // The workflow surfaces' small summary (Overview checklist, next step).
  app.get("/api/deals/:dealId/gl/progress", ...auth, async (req, res) => {
    const dealId = dealIdOf(req);
    let gate = null;
    try {
      // Synced with the analysis first (skipped when nothing changed) — the Overview and the CIM tab read this.
      await refreshGl(dealId);
      const store = glStore();
      const [tracing, traces, links] = await Promise.all([store.getTracing(dealId), store.listTraces(dealId), store.linksOfDeal(dealId)]);
      gate = gateFrom(tracing, traces, { confirmedLinks: links.filter((k) => k.state === "confirmed").length });
    } catch {
      gate = null;
    }
    res.json({ glTracing: await glProgressForDeal(dealId), gate });
  });

  app.patch("/api/deals/:dealId/gl/settings", ...auth, async (req, res) => {
    try {
      const dealId = dealIdOf(req);
      const bad = refuseUnknownKeys(req.body, ["requireBeforeCim", "fiscalYearEnd"]);
      if (bad) return res.status(400).json({ error: bad });
      await loadGlContext(dealId);
      if (typeof req.body?.requireBeforeCim === "boolean") await glStore().updateTracing(dealId, { requireBeforeCim: req.body.requireBeforeCim } as Partial<GlTracing>);
      if (req.body?.fiscalYearEnd !== undefined) {
        // "auto": the fiscal-year end follows the deal's facts and statements again.
        if (req.body.fiscalYearEnd !== "auto" && !normaliseFiscalYearEnd(req.body.fiscalYearEnd)) return res.status(400).json({ error: "Pick a valid fiscal year end (month and day)." });
        await changeFiscalYearEnd(dealId, String(req.body.fiscalYearEnd));
      }
      res.json({ ok: true });
    } catch (err) {
      fail(res, "change the settings")(err);
    }
  });

  app.patch("/api/deals/:dealId/gl/traces/:traceId", ...auth, async (req, res) => {
    try {
      const bad = refuseUnknownKeys(req.body, TRACE_PATCH_KEYS);
      if (bad) return res.status(400).json({ error: bad });
      const t = await ownedTrace(req, res);
      if (!t) return;
      const parsed = tracePatchFrom((req.body ?? {}) as Record<string, unknown>, t);
      if ("error" in parsed) return res.status(400).json({ error: parsed.error });
      const store = glStore();
      if (parsed.links.length) {
        const mine = new Set((await store.linksOfTrace(t.id)).map((k) => k.id));
        if (parsed.links.some((l) => !mine.has(l.id))) return res.status(404).json({ error: "Entry not found" });
        for (const v of [true, false, null] as const) {
          const ids = parsed.links.filter((l) => l.showDetails === v).map((l) => l.id);
          if (ids.length) await store.setLinkShowDetails(ids, v);
        }
      }
      if (Object.keys(parsed.patch).length) await store.updateTrace(t.id, parsed.patch);
      const matching = ["proof", "sharePct", "sellerHint", "leftOut"].some((k) => k in parsed.patch);
      if (matching) await proposeForTraces(t.dealId, [t.id], { ai: "none" });
      else await recomputeTraces(t.dealId, [t.id]);
      if ("includeInCim" in parsed.patch || "leftOut" in parsed.patch) await stampReviewed(t.dealId);
      res.json({ ok: true });
    } catch (err) {
      fail(res, "save the change")(err);
    }
  });

  app.post("/api/deals/:dealId/gl/traces/:traceId/review", ...auth, async (req, res) => {
    try {
      const bad = refuseUnknownKeys(req.body, ["verdict", "note", "undo"]);
      if (bad) return res.status(400).json({ error: bad });
      const t = await ownedTrace(req, res);
      if (!t) return;
      if (req.body?.undo === true) {
        await glStore().updateTrace(t.id, { reviewedAt: null, brokerVerdict: null } as Partial<GlAddbackTrace>);
      } else {
        const verdict = req.body?.verdict ?? (t.computed as { suggestedVerdict?: string } | null)?.suggestedVerdict ?? "not_found";
        if (!["found", "partly_found", "not_found"].includes(String(verdict))) return res.status(400).json({ error: "Pick found, partly found or not found." });
        const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 2000) : undefined;
        // Nothing asked or found yet: a review counts toward the due-diligence hold, so it needs the broker's reason (D16).
        if (!traceHasActivity(t as any) && (note ?? "").length < 3) {
          return res.status(409).json({
            code: "nothing_to_review",
            error: "Nothing has been asked or found for this add-back yet. Send it to the seller or tick the entries yourself — or write why you're marking it reviewed.",
          });
        }
        await glStore().updateTrace(t.id, { reviewedAt: new Date(), brokerVerdict: String(verdict), ...(note !== undefined ? { brokerNote: note || null } : {}) } as Partial<GlAddbackTrace>);
      }
      await stampReviewed(t.dealId);
      res.json({ ok: true });
    } catch (err) {
      fail(res, "mark it reviewed")(err);
    }
  });

  app.post("/api/deals/:dealId/gl/review-found", ...auth, async (req, res) => {
    try {
      const dealId = dealIdOf(req);
      const store = glStore();
      let n = 0;
      for (const t of await store.listTraces(dealId)) {
        if (t.removedAt || t.proof === "statement" || t.reviewedAt || !t.includeInCim) continue;
        const c = t.computed as { overall?: string; suggestedVerdict?: string } | null;
        if (c?.suggestedVerdict !== "found") continue;
        await store.updateTrace(t.id, { reviewedAt: new Date(), brokerVerdict: "found" } as Partial<GlAddbackTrace>);
        n++;
      }
      await stampReviewed(dealId);
      res.json({ ok: true, reviewed: n });
    } catch (err) {
      fail(res, "mark them reviewed")(err);
    }
  });

  // "Ask the seller…" — marks the costs sent and emails the ticked people (the broker's click).
  app.post("/api/deals/:dealId/gl/request", ...auth, async (req, res) => {
    try {
      const bad = refuseUnknownKeys(req.body, ["traceIds", "recipients", "message"]);
      if (bad) return res.status(400).json({ error: bad });
      const dealId = dealIdOf(req);
      const store = glStore();
      const ids: string[] = Array.isArray(req.body?.traceIds) ? req.body.traceIds.map(String) : [];
      const traces = (await store.listTraces(dealId)).filter((t) => !t.removedAt && t.proof !== "statement");
      const chosen = traces.filter((t) => ids.includes(t.id));
      if (chosen.length === 0 || chosen.length !== new Set(ids).size) return res.status(400).json({ error: "Pick the costs to send." });
      const people = await glRecipients(dealId);
      const to: string[] = Array.isArray(req.body?.recipients) ? req.body.recipients.map(String) : [];
      if (to.some((r) => !people.some((p) => p.id === r))) return res.status(400).json({ error: "Pick who receives the request." });
      if (people.length > 0 && to.length === 0) return res.status(400).json({ error: "Pick who receives the request." });
      const message = typeof req.body?.message === "string" ? req.body.message.trim().slice(0, 1000) : "";
      const now = new Date();
      const c = await loadGlContext(dealId);
      await withGlLock(dealId, async () => {
        for (const t of chosen) if (!t.sentAt) await store.updateTrace(t.id, { sentAt: now } as Partial<GlAddbackTrace>);
        await store.updateTracing(dealId, {
          requestedAt: c.tracing.requestedAt && !c.tracing.withdrawnAt ? c.tracing.requestedAt : now,
          requestedBy: req.session.brokerId ?? null,
          withdrawnAt: null,
          sellerDoneAt: null,
          recipients: to.map((id) => {
            const p = people.find((x) => x.id === id)!;
            return { memberId: p.via === "members" ? id : null, inviteId: p.via === "seller_invite" ? id : null, role: p.role };
          }),
          sellerMessage: message || null,
        } as Partial<GlTracing>);
      });
      const sent = await sendGlRequest(dealId, { recipientIds: to, brokerName: await brokerName(req), n: chosen.length + traces.filter((t) => t.sentAt && !ids.includes(t.id)).length, ledgerOnFile: c.sellerLedgerIds.size > 0, message });
      // Proposals for what was sent (rules now; the AI ranker within the broker's budget once installed).
      void proposeForTraces(dealId, chosen.map((t) => t.id), { ai: "broker" }).catch((err) => console.warn("[gl] proposals after the request failed:", err));
      res.json({ ok: true, ...sent });
    } catch (err) {
      fail(res, "send the request")(err);
    }
  });

  app.post("/api/deals/:dealId/gl/remind", ...auth, async (req, res) => {
    try {
      const dealId = dealIdOf(req);
      const store = glStore();
      const tracing = await store.getTracing(dealId);
      if (!tracing?.requestedAt || tracing.withdrawnAt) return res.status(409).json({ error: "There's no request to remind about." });
      if (tracing.lastRemindedAt && Date.now() - new Date(tracing.lastRemindedAt).getTime() < 24 * 3600_000) return res.status(409).json({ error: "Reminded today — you can remind again tomorrow." });
      const ids = ((tracing.recipients as Array<{ memberId: string | null; inviteId: string | null }> | null) ?? []).map((r) => r.memberId ?? r.inviteId).filter((x): x is string => !!x);
      await store.updateTracing(dealId, { lastRemindedAt: new Date() } as Partial<GlTracing>);
      res.json({ ok: true, ...(await remindGlRequest(dealId, ids)) });
    } catch (err) {
      fail(res, "send the reminder")(err);
    }
  });

  app.post("/api/deals/:dealId/gl/withdraw", ...auth, async (req, res) => {
    try {
      const dealId = dealIdOf(req);
      await loadGlContext(dealId);
      await glStore().updateTracing(dealId, { withdrawnAt: new Date() } as Partial<GlTracing>);
      res.json({ ok: true });
    } catch (err) {
      fail(res, "withdraw the request")(err);
    }
  });

  app.post("/api/deals/:dealId/gl/waive", ...auth, async (req, res) => {
    try {
      const bad = refuseUnknownKeys(req.body, ["reason"]);
      if (bad) return res.status(400).json({ error: bad });
      const reason = typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 1000) : "";
      if (reason.length < 3) return res.status(400).json({ error: "Write why — for your records; buyers don't see this." });
      const dealId = dealIdOf(req);
      await loadGlContext(dealId);
      await glStore().updateTracing(dealId, { waived: { reason, at: new Date().toISOString(), by: req.session.brokerId ?? "broker" } } as Partial<GlTracing>);
      res.json({ ok: true });
    } catch (err) {
      fail(res, "save that")(err);
    }
  });

  app.delete("/api/deals/:dealId/gl/waive", ...auth, async (req, res) => {
    try {
      await glStore().updateTracing(dealIdOf(req), { waived: null } as Partial<GlTracing>);
      res.json({ ok: true });
    } catch (err) {
      fail(res, "undo that")(err);
    }
  });

  // The accountant the seller named: the broker sends them their own link, or not.
  app.post("/api/deals/:dealId/gl/accountant/send", ...auth, async (req, res) => {
    try {
      const dealId = dealIdOf(req);
      const store = glStore();
      const tracing = await store.getTracing(dealId);
      const acc = tracing?.accountantRequest as { memberId: string; name: string; email: string; at: string; sentAt?: string; declinedAt?: string } | null;
      if (!acc || acc.sentAt || acc.declinedAt) return res.status(409).json({ error: "There's no accountant waiting for a link." });
      const member = await storage.getDealMember(acc.memberId);
      if (!member || member.dealId !== dealId) return res.status(404).json({ error: "The accountant isn't on this deal any more." });
      const { findOrCreateSellerInvite } = await import("../deals/seller-invites");
      const invite = await findOrCreateSellerInvite(dealId, member.email, member.name);
      await storage.updateDealMember(member.id, { inviteStatus: "sent", invitedAt: new Date() } as any);
      const deal = await storage.getDeal(dealId);
      const { teamInviteCopy } = await import("../notifications/team-invite-copy");
      const { notify } = await import("../notifications/service");
      const roleLabel = (TEAM_ROLES.seller as Record<string, { label: string }>).accountant?.label ?? "Accountant";
      const copy = teamInviteCopy({ teamType: "seller", roleLabel, businessName: deal?.businessName ?? null, blindCodename: deal?.blindCodename ?? null, accessLevel: null, hasSellerLink: true });
      // Demo deals never email (their people are fictional); the link exists either way.
      if (!deal?.demoKey) await notify(dealId, "invite", {
        title: copy.title,
        body: `${copy.body}\n\nYour client asked you to show where a few costs sit in the company's books: upload the general ledger and check the entries Cimple suggests.`,
        actionUrl: `/seller/${invite.token}/books`,
        businessName: copy.displayName,
        specificMemberIds: [member.id],
      });
      const recipients = ((tracing!.recipients as Array<{ memberId: string | null; inviteId: string | null; role: string }> | null) ?? []).filter((r) => r.memberId !== member.id);
      recipients.push({ memberId: member.id, inviteId: null, role: "accountant" });
      await store.updateTracing(dealId, { accountantRequest: { ...acc, sentAt: new Date().toISOString() }, recipients } as Partial<GlTracing>);
      res.json({ ok: true, demo: !!deal?.demoKey });
    } catch (err) {
      fail(res, "send the accountant their link")(err);
    }
  });

  app.post("/api/deals/:dealId/gl/accountant/decline", ...auth, async (req, res) => {
    try {
      const dealId = dealIdOf(req);
      const store = glStore();
      const tracing = await store.getTracing(dealId);
      const acc = tracing?.accountantRequest as { memberId: string; sentAt?: string; declinedAt?: string } | null;
      if (!acc || acc.sentAt || acc.declinedAt) return res.status(409).json({ error: "There's no accountant waiting for a link." });
      const member = await storage.getDealMember(acc.memberId);
      if (member && member.dealId === dealId && member.inviteStatus === "pending") await storage.deleteDealMember(member.id);
      await store.updateTracing(dealId, { accountantRequest: { ...(acc as object), declinedAt: new Date().toISOString() } } as Partial<GlTracing>);
      res.json({ ok: true });
    } catch (err) {
      fail(res, "save that")(err);
    }
  });

  app.post("/api/deals/:dealId/gl/traces/:traceId/question", ...auth, async (req, res) => {
    try {
      const bad = refuseUnknownKeys(req.body, ["text"]);
      if (bad) return res.status(400).json({ error: bad });
      const t = await ownedTrace(req, res);
      if (!t) return;
      const text = typeof req.body?.text === "string" ? req.body.text.trim().slice(0, 1000) : "";
      if (text.length < 3) return res.status(400).json({ error: "Type your question for the seller." });
      if (!t.sentAt) return res.status(409).json({ error: "Send this cost to the seller first." });
      await glStore().updateTrace(t.id, { question: { text, askedAt: new Date().toISOString() } } as Partial<GlAddbackTrace>);
      const tracing = await glStore().getTracing(t.dealId);
      const ids = ((tracing?.recipients as Array<{ memberId: string | null; inviteId: string | null }> | null) ?? []).map((r) => r.memberId ?? r.inviteId).filter((x): x is string => !!x);
      await sendTraceQuestion(t.dealId, t.sellerLabel, t.id, ids);
      res.json({ ok: true });
    } catch (err) {
      fail(res, "send the question")(err);
    }
  });

  // "Use what the ledger shows" (§6.10): ?dryRun=1 → the impact; else saved through the analysis PATCH's own code.
  app.post("/api/deals/:dealId/gl/traces/:traceId/apply-ledger-amount", ...auth, async (req, res) => {
    try {
      const bad = refuseUnknownKeys(req.body, ["fy"]);
      if (bad) return res.status(400).json({ error: bad });
      const t = await ownedTrace(req, res);
      if (!t) return;
      const fy = typeof req.body?.fy === "string" && /^\d{4}$/.test(req.body.fy) ? req.body.fy : "";
      if (!fy) return res.status(400).json({ error: "Pick the year." });
      const { ledgerAmountImpact, saveBrokerAnalysisEdit, LedgerAmountError } = await import("./analysis-edit");
      try {
        const r = await ledgerAmountImpact(t.dealId, t, fy);
        if (req.query.dryRun === "1") return res.json(r.impact);
        await saveBrokerAnalysisEdit(r.analysis, { normalization: r.normalization });
        await refreshGl(t.dealId);
        res.json({ ok: true, ...r.impact });
      } catch (err) {
        if (err instanceof LedgerAmountError) return res.status(err.status).json({ error: err.message });
        throw err;
      }
    } catch (err) {
      fail(res, "change the add-back")(err);
    }
  });

  app.post("/api/deals/:dealId/gl/traces/:traceId/look-again", ...auth, async (req, res) => {
    try {
      const t = await ownedTrace(req, res);
      if (!t) return;
      const r = await proposeForTraces(t.dealId, [t.id], { ai: "broker", force: true });
      res.json({ ok: true, unconfident: r.unconfident.includes(t.id) });
    } catch (err) {
      fail(res, "look again")(err);
    }
  });

  // "Move the ticked entries to…": an add-back renamed by a re-run of the analysis keeps the seller's work.
  app.post("/api/deals/:dealId/gl/traces/:traceId/move-links", ...auth, async (req, res) => {
    try {
      const bad = refuseUnknownKeys(req.body, ["fromTraceId"]);
      if (bad) return res.status(400).json({ error: bad });
      const t = await ownedTrace(req, res);
      if (!t) return;
      const from = await glStore().getTrace(String(req.body?.fromTraceId ?? ""));
      if (!from || from.dealId !== t.dealId || !from.removedAt) return res.status(404).json({ error: "Those entries couldn't be found." });
      const years = Object.keys((t.claims as Record<string, number>) ?? {});
      const moved = await withGlLock(t.dealId, async () => {
        const n = await glStore().moveDecidedLinks(from.id, t.id, years);
        const c = await loadGlContext(t.dealId);
        await proposeUnlocked(t.dealId, [t.id], { ai: "none", force: true }, c);
        await recomputeTraces(t.dealId, [t.id], c);
        return n;
      });
      res.json({ ok: true, moved });
    } catch (err) {
      fail(res, "move the entries")(err);
    }
  });

  app.put("/api/deals/:dealId/gl/traces/:traceId/links", ...auth, async (req, res) => {
    try {
      const bad = refuseUnknownKeys(req.body, ["fy", "add", "remove", "reject"]);
      if (bad) return res.status(400).json({ error: bad });
      const t = await ownedTrace(req, res);
      if (!t) return;
      const w = parseLinkWrite(req.body);
      if ("error" in w) return res.status(400).json({ error: w.error });
      const r = await writeLinks(t, w, { by: "broker", memberId: null }, await loadGlContext(t.dealId));
      if (!r.ok) return res.status(r.status).json({ error: r.error });
      res.json({ ok: true });
    } catch (err) {
      fail(res, "save the entries")(err);
    }
  });

  app.post("/api/deals/:dealId/gl/traces/:traceId/confirm-summary", ...auth, async (req, res) => {
    try {
      const t = await ownedTrace(req, res);
      if (!t) return;
      const n = await confirmSummary(t, { by: "broker", memberId: null }, await loadGlContext(t.dealId));
      res.json({ ok: true, confirmed: n });
    } catch (err) {
      fail(res, "tick the entries")(err);
    }
  });

  // One add-back's entries for the drawer: proposals, confirmed, rejected, with the year's numbers.
  app.get("/api/deals/:dealId/gl/traces/:traceId/entries", ...auth, async (req, res) => {
    try {
      const t = await ownedTrace(req, res);
      if (!t) return;
      const fy = typeof req.query.fy === "string" && /^\d{4}$/.test(req.query.fy) ? req.query.fy : null;
      const c = await loadGlContext(t.dealId);
      const links = (await glStore().linksOfTrace(t.id)).filter((k) => !fy || k.fiscalYear === fy);
      const docs = new Map(c.docs.map((d) => [d.id, d]));
      // How each entry would reach a due-diligence buyer by the rules (before the broker's per-entry choice).
      const basics = await buyerMaskBasics(c.deal);
      const parties = personsFor(t, basics.ownerText);
      const personal = t.category === "discretionary" || t.category === "owner_comp" || /\b(?:personal|owner|family|spouse|related)\b/i.test(t.label);
      const staffShown = new Map(c.ledgers.map((l) => [l.id, !!l.showStaffNames]));
      const buyerWithheld = (k: (typeof links)[number]) =>
        maskForBuyer({ account: k.account ?? "", name: k.name, memo: k.memo }, { staffNames: basics.staffNames, heldNames: basics.heldNames, parties, personalAddback: personal, showStaffNames: !!staffShown.get(k.ledgerId ?? "") }, null).withheld ?? null;
      res.json({
        entries: links.filter((k) => k.ledgerId).map((k) => ({
          id: k.id, ledgerId: k.ledgerId, rowNo: k.rowNo, fiscalYear: k.fiscalYear, date: k.txnDate, account: k.account, name: k.name, memo: k.memo,
          amountCents: k.amountCents, state: k.state, proposedBy: k.proposedBy, confidence: k.confidence, reason: k.reason, decidedBy: k.decidedBy,
          showDetails: k.showDetails, privateLedger: !!k.ledgerId && c.brokerOnlyLedgerIds.has(k.ledgerId),
          buyerWithheld: k.state === "confirmed" ? buyerWithheld(k) : null,
        })),
        documents: links.filter((k) => k.documentId).map((k) => ({
          id: k.id, documentId: k.documentId, fiscalYear: k.fiscalYear, amountCents: k.amountCents, check: k.docAmountCheck,
          name: docs.get(k.documentId!)?.originalName || docs.get(k.documentId!)?.name || "Document", fileUrl: docs.get(k.documentId!)?.fileUrl ?? null,
        })),
      });
    } catch (err) {
      fail(res, "load the entries")(err);
    }
  });

  app.get("/api/deals/:dealId/gl/search", ...auth, async (req, res) => {
    try {
      const dealId = dealIdOf(req);
      const q = (k: string) => (typeof req.query[k] === "string" ? String(req.query[k]) : "");
      const min = q("min") ? parseMoneyToCents(q("min")) : null;
      const max = q("max") ? parseMoneyToCents(q("max")) : null;
      if ((q("min") && min === null) || (q("max") && max === null)) return res.status(400).json({ error: "Type amounts as numbers, like 1150 or 1,150.00." });
      const c = await loadGlContext(dealId);
      const rows = await glStore().searchRows({
        dealId, ledgerIds: Array.from(c.readyIds), fiscalYears: /^\d{4}$/.test(q("fy")) ? [q("fy")] : null, q: q("q").slice(0, 100),
        minCents: min, maxCents: max, accountKey: q("account").slice(0, 300) || null, limit: 50,
      });
      res.json({ rows: rows.map(sellerEntry) });
    } catch (err) {
      fail(res, "search the ledger")(err);
    }
  });

  app.patch("/api/deals/:dealId/gl/tie-out", ...auth, async (req, res) => {
    try {
      const bad = refuseUnknownKeys(req.body, ["year", "accept", "accountClasses"]);
      if (bad) return res.status(400).json({ error: bad });
      const dealId = dealIdOf(req);
      const store = glStore();
      const c = await loadGlContext(dealId);
      const patch: Partial<GlTracing> = {};
      if (req.body?.accept !== undefined) {
        const year = String(req.body?.year ?? "");
        if (!/^\d{4}$/.test(year)) return res.status(400).json({ error: "Pick the year." });
        const accepted = { ...((c.tracing.tieOutAccepted as Record<string, unknown> | null) ?? {}) } as Record<string, { note: string; at: string; by: string }>;
        if (req.body.accept === null) delete accepted[year];
        else {
          const note = typeof req.body.accept?.note === "string" ? req.body.accept.note.trim().slice(0, 600) : "";
          if (note.length < 3) return res.status(400).json({ error: "Write a short note — due-diligence buyers see it." });
          accepted[year] = { note, at: new Date().toISOString(), by: req.session.brokerId ?? "broker" };
        }
        patch.tieOutAccepted = accepted;
      }
      if (req.body?.accountClasses !== undefined) {
        const raw = req.body.accountClasses;
        if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length > 400) return res.status(400).json({ error: "Those account choices couldn't be read." });
        const classes = { ...((c.tracing.accountClasses as Record<string, string> | null) ?? {}) };
        for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
          if (k.length > 300) return res.status(400).json({ error: "Those account choices couldn't be read." });
          if (v === null) delete classes[k];
          else if (v === "revenue" || v === "expense" || v === "balance_sheet") classes[k] = v;
          else return res.status(400).json({ error: "Each account is revenue, an expense or on the balance sheet." });
        }
        patch.accountClasses = classes as GlTracing["accountClasses"];
      }
      if (Object.keys(patch).length === 0) return res.status(400).json({ error: "Nothing to change" });
      await store.updateTracing(dealId, patch);
      if (patch.accountClasses) {
        await withGlLock(dealId, async () => {
          const fresh = await loadGlContext(dealId);
          await tieOutFor(dealId, fresh);
          await proposeUnlocked(dealId, null, { ai: "none" }, fresh);
        });
      }
      res.json({ ok: true });
    } catch (err) {
      fail(res, "save that")(err);
    }
  });

  // ── What buyers see (§8.1, D30) ──

  // The publish dialog: per-version defaults, the exact note texts, the warnings.
  app.get("/api/deals/:dealId/gl/publish-preview", ...auth, async (req, res) => {
    try {
      const dealId = dealIdOf(req);
      await refreshGl(dealId);
      res.json(await publishPreview(dealId));
    } catch (err) {
      fail(res, "load what buyers would see")(err);
    }
  });

  // "Show to buyers" / "Update what buyers see".
  app.post("/api/deals/:dealId/gl/publish", ...auth, async (req, res) => {
    try {
      const bad = refuseUnknownKeys(req.body, ["versions", "leaveOut"]);
      if (bad) return res.status(400).json({ error: bad });
      const v = req.body?.versions;
      if (!v || typeof v !== "object" || ["dd", "normal", "blind"].some((k) => typeof v[k] !== "boolean") || Object.keys(v).some((k) => !["dd", "normal", "blind"].includes(k))) {
        return res.status(400).json({ error: "Choose which versions show it." });
      }
      const leaveOut = req.body?.leaveOut ?? [];
      if (!Array.isArray(leaveOut) || leaveOut.length > 200 || leaveOut.some((k: unknown) => typeof k !== "string" || k.length > 200)) {
        return res.status(400).json({ error: "Those add-backs couldn't be read." });
      }
      const r = await publishEvidence(dealIdOf(req), { versions: { dd: v.dd, normal: v.normal, blind: v.blind }, leaveOut }, req.session.brokerId ?? null);
      res.json({ ok: true, ...r });
    } catch (err) {
      fail(res, "show it to buyers")(err);
    }
  });

  // "Stop showing it to buyers".
  app.delete("/api/deals/:dealId/gl/publish", ...auth, async (req, res) => {
    try {
      await unpublishEvidence(dealIdOf(req));
      res.json({ ok: true });
    } catch (err) {
      fail(res, "take it off what buyers see")(err);
    }
  });

  // Exactly what a buyer would get, for the broker: the live data or the published (tightened) snapshot.
  app.get("/api/deals/:dealId/gl/evidence", ...auth, async (req, res) => {
    try {
      const mode = String(req.query.mode ?? "dd");
      const source = String(req.query.source ?? "published");
      // "preview" (the CIM builder): what buyers see when it's published, else the live data marked as a preview.
      if (!["dd", "normal", "blind"].includes(mode) || !["live", "published", "preview"].includes(source)) return res.status(400).json({ error: "Pick a version." });
      const dealId = dealIdOf(req);
      const changes = await evidenceChangeCount(dealId);
      const from = source === "preview" ? (changes.publishedAt ? "published" : "live") : (source as "live" | "published");
      const payload = await buildEvidence(dealId, mode as "dd" | "normal" | "blind", from);
      res.json({ payload, publishedAt: changes.publishedAt, changes: changes.changes });
    } catch (err) {
      fail(res, "load the evidence")(err);
    }
  });

  app.post("/api/deals/:dealId/gl/suggestions/:id", ...auth, async (req, res) => {
    try {
      const bad = refuseUnknownKeys(req.body, ["status"]);
      if (bad) return res.status(400).json({ error: bad });
      const status = req.body?.status;
      if (status !== "added" && status !== "dismissed") return res.status(400).json({ error: "Add it or dismiss it." });
      const dealId = dealIdOf(req);
      const store = glStore();
      const tracing = await store.getTracing(dealId);
      const list = ((tracing?.sellerSuggestions as Array<{ id: string; status: string }> | null) ?? []);
      if (!list.some((s) => s.id === req.params.id)) return res.status(404).json({ error: "Not found" });
      await store.updateTracing(dealId, { sellerSuggestions: list.map((s) => (s.id === req.params.id ? { ...s, status } : s)) } as Partial<GlTracing>);
      res.json({ ok: true });
    } catch (err) {
      fail(res, "save that")(err);
    }
  });
}
