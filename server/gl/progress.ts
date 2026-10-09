/**
 * progress.ts — "Add-backs in the books" on the workflow surfaces (gl spec
 * §6.11): the deal list / dashboard next step and the Overview checklist
 * (DealProgressExtras.glTracing), and the seller's progress card
 * (GET /api/seller/:token/progress → glTracing).
 *
 * Reads the stored rows only (no sync, no AI) — cheap enough for a list of
 * deals. Before the release's db:push the tables don't exist: everything
 * here then answers "nothing to say" (null), never an error.
 */
import { inArray } from "drizzle-orm";
import { glAddbackTraces, glLedgers, glTracing, glTraceLinks, type GlAddbackTrace, type GlTracing, type DealMember, type SellerInvite } from "@shared/schema";
import type { DealProgressExtras } from "@shared/deal-progress";
import { gateFrom } from "./gate";
import { glStore } from "./store";
import { sellerGlState, sellerVisibleTraces, type SellerGlState } from "./seller-view";
import { sellerLinkRights } from "@shared/seller-link-rights";

type GlExtras = NonNullable<DealProgressExtras["glTracing"]>;

/** One deal's extras from its rows (pure). */
export function glExtrasFrom(tracing: GlTracing | undefined, traces: GlAddbackTrace[], ledgers: Array<{ status: string }>, confirmedLinks: number): GlExtras | null {
  const gate = gateFrom(tracing, traces, { confirmedLinks });
  if (gate.state === "not_needed" && ledgers.every((l) => l.status !== "needs_columns")) return null;
  const acc = tracing?.accountantRequest as { sentAt?: string; declinedAt?: string } | null | undefined;
  return {
    state: gate.state,
    toGo: gate.toGo,
    total: gate.total,
    needsColumns: ledgers.some((l) => l.status === "needs_columns"),
    accountantPending: !!acc && !acc.sentAt && !acc.declinedAt,
  };
}

/** The deal list's extras, many deals at once (pgStore only). Never throws. */
export async function glProgressForDeals(dealIds: string[]): Promise<Map<string, GlExtras>> {
  const out = new Map<string, GlExtras>();
  if (dealIds.length === 0) return out;
  try {
    const { db } = await import("../db");
    const { sql, and, eq } = await import("drizzle-orm");
    const [tracings, traces, ledgers, links] = await Promise.all([
      db.select().from(glTracing).where(inArray(glTracing.dealId, dealIds)),
      db.select().from(glAddbackTraces).where(inArray(glAddbackTraces.dealId, dealIds)),
      db.select({ dealId: glLedgers.dealId, status: glLedgers.status }).from(glLedgers).where(inArray(glLedgers.dealId, dealIds)),
      db.select({ dealId: glTraceLinks.dealId, n: sql<number>`count(*)::int` }).from(glTraceLinks).where(and(inArray(glTraceLinks.dealId, dealIds), eq(glTraceLinks.state, "confirmed"))).groupBy(glTraceLinks.dealId),
    ]);
    for (const id of dealIds) {
      const x = glExtrasFrom(
        tracings.find((t) => t.dealId === id),
        traces.filter((t) => t.dealId === id),
        ledgers.filter((l) => l.dealId === id),
        Number(links.find((l) => l.dealId === id)?.n ?? 0),
      );
      if (x) out.set(id, x);
    }
  } catch (err) {
    console.warn("[gl] add-backs progress for the deal list unavailable:", (err as Error)?.message ?? err);
  }
  return out;
}

/** One deal's extras (Overview / single-deal next step). Never throws. */
export async function glProgressForDeal(dealId: string): Promise<GlExtras | null> {
  try {
    const store = glStore();
    const [tracing, traces, ledgers, links] = await Promise.all([store.getTracing(dealId), store.listTraces(dealId), store.listLedgers(dealId), store.linksOfDeal(dealId)]);
    return glExtrasFrom(tracing, traces, ledgers, links.filter((k) => k.state === "confirmed").length);
  } catch {
    return null;
  }
}

export interface SellerGlProgress {
  state: SellerGlState;
  total: number;
  done: number;
  /** The first open question's cost and a short preview. */
  question: { costId: string; sellerLabel: string; text: string } | null;
  /** Costs the broker updated since the seller finished. */
  reopened: Array<{ costId: string; sellerLabel: string }>;
  accountantName: string | null;
  /** A seller-visible ledger is on file. */
  ledgerOnFile: boolean;
  firstLabel: string | null;
}

/** The seller's progress card — only for a link that may do this step (owner / accountant). Null otherwise or when not asked. */
export async function sellerGlProgress(invite: Pick<SellerInvite, "sellerEmail" | "dealId">, members: DealMember[]): Promise<SellerGlProgress | null> {
  try {
    if (!sellerLinkRights(invite, members).canTraceAddbacks) return null;
    const { loadGlContext } = await import("./context");
    const c = await loadGlContext(invite.dealId);
    if (!c.tracing.requestedAt || c.tracing.withdrawnAt) return null;
    const costs = sellerVisibleTraces(await glStore().listTraces(invite.dealId));
    if (costs.length === 0) return null;
    const state = sellerGlState(c.tracing, costs, c.sellerLedgerIds.size > 0);
    const q = costs.find((t) => t.question && !(t.question as { answer?: string }).answer);
    const acc = c.tracing.accountantRequest as { name?: string } | null;
    return {
      state,
      total: costs.length,
      done: costs.filter((t) => ["done", "not_in_ledger", "disputed"].includes(t.sellerStatus)).length,
      question: q ? { costId: q.id, sellerLabel: q.sellerLabel, text: String((q.question as { text: string }).text).slice(0, 120) } : null,
      reopened: costs.filter((t) => t.reopenedNote && t.sellerStatus !== "done").map((t) => ({ costId: t.id, sellerLabel: t.sellerLabel })),
      accountantName: acc?.name ?? null,
      ledgerOnFile: c.sellerLedgerIds.size > 0,
      firstLabel: costs[0]?.sellerLabel ?? null,
    };
  } catch (err) {
    console.warn(`[gl] seller progress for ${invite.dealId} unavailable:`, (err as Error)?.message ?? err);
    return null;
  }
}

// ── The interview's mention (gl spec §6.13) ──────────────────────────────

/** The block the seller's interview gets while the broker's request is open. Deterministic; no MANDATORY line. */
export const GL_INTERVIEW_BLOCK = [
  "# OPEN REQUEST FROM THE BROKER: COSTS IN THE BOOKS",
  "The broker has asked the seller to show, in their bookkeeping, where a few costs the broker listed are recorded (ledger entries, T4 slips or invoices). Mention it once, near the end of this session or when the seller brings up bookkeeping, payroll or the ledger: \"Your broker also asked you to show where a few costs sit in your books — it's on your progress page under 'Show us where a few costs are in your books'.\" Do not list the costs, their amounts or how they are treated, and do not discuss add-backs (boundaries rules).",
].join("\n");

/** The broker's request is open: sent, not withdrawn, the seller not finished. Never throws (false). */
export async function glRequestOpen(dealId: string): Promise<boolean> {
  try {
    const store = glStore();
    const tracing = await store.getTracing(dealId);
    if (!tracing?.requestedAt || tracing.withdrawnAt || tracing.sellerDoneAt) return false;
    return sellerVisibleTraces(await store.listTraces(dealId)).length > 0;
  } catch {
    return false;
  }
}
