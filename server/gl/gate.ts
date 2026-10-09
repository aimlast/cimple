/**
 * gate.ts — "Add-backs in the books" before the CIM is written (gl spec
 * §6.9, D16; founder question F3/Q19 = recommended option A).
 *
 *   DD CIM     held until every add-back needing proof is reviewed by the
 *              broker (or all its years left out), or the broker went ahead
 *              without the ledger and wrote why ("waived").
 *   Full/Blind the broker confirms on the client; the server allows — unless
 *              the per-deal switch "Hold the whole CIM until this is done"
 *              is on (startCimGeneration then refuses too).
 *   Never      per-section rewrites and per-section DD refreshes.
 *
 * The gate is a workflow step, not a security check: if the GL tables can't
 * be read (before the release's db:push) it lets generation through.
 */
import type { Deal, GlAddbackTrace, GlTracing } from "@shared/schema";
import { claimedYears } from "@shared/gl-reconcile";

export type GlGateState = "not_needed" | "waived" | "done" | "not_requested" | "with_seller" | "with_broker";

export interface GlGate {
  state: GlGateState;
  /** Add-backs still to review. */
  toGo: number;
  /** Add-backs that need proof (not from the statements, in the CIM). */
  total: number;
  holdsDd: boolean;
  holdsCim: boolean;
  /** The hold switch is on. */
  holdAll: boolean;
  message: string | null;
}

type TracingLike = Pick<GlTracing, "requestedAt" | "withdrawnAt" | "sellerDoneAt" | "waived" | "requireBeforeCim"> | null | undefined;
type TraceLike = Pick<GlAddbackTrace, "removedAt" | "proof" | "includeInCim" | "reviewedAt" | "leftOut" | "claims" | "sentAt"> & { computed?: GlAddbackTrace["computed"] };

/** Every claimed year of the add-back is left out. */
function allYearsLeftOut(t: TraceLike): boolean {
  const years = claimedYears({ claims: (t.claims as Record<string, number>) ?? {} });
  const left = (t.leftOut as { years?: string[] } | null)?.years ?? [];
  return years.length > 0 && years.every((y) => left.includes(y));
}

export const DD_GATE_MESSAGE = (toGo: number, total: number) =>
  `The due-diligence CIM shows the ledger entries behind each add-back. Finish 'Add-backs in the books' first (${toGo} of ${total} to go), or go ahead without the ledger.`;
export const CIM_HOLD_MESSAGE = (toGo: number) =>
  `You asked to hold the CIM until the add-backs are shown in the books (${toGo} to go). Turn the hold off on Financials → Add-backs in the books, or finish the review.`;

/** The gate from the stored rows (pure). */
export function gateFrom(tracing: TracingLike, traces: TraceLike[], opts: { confirmedLinks?: number } = {}): GlGate {
  const relevant = traces.filter((t) => !t.removedAt && t.proof !== "statement" && t.includeInCim !== false);
  const total = relevant.length;
  const doneOne = (t: TraceLike) => !!t.reviewedAt || allYearsLeftOut(t);
  const toGo = relevant.filter((t) => !doneOne(t)).length;
  const holdAll = !!tracing?.requireBeforeCim;
  const base = { toGo, total, holdAll };
  let state: GlGateState;
  if (total === 0) state = "not_needed";
  else if (tracing?.waived) state = "waived";
  else if (toGo === 0) state = "done";
  else if (!relevant.some((t) => !!t.sentAt) && !tracing?.requestedAt && !(opts.confirmedLinks && opts.confirmedLinks > 0)) state = "not_requested";
  else if (tracing?.requestedAt && !tracing.withdrawnAt && !tracing.sellerDoneAt) state = "with_seller";
  else state = "with_broker";
  const holdsDd = state === "not_requested" || state === "with_seller" || state === "with_broker";
  const holdsCim = holdAll && holdsDd;
  return { state, ...base, holdsDd, holdsCim, message: holdsCim ? CIM_HOLD_MESSAGE(toGo) : holdsDd ? DD_GATE_MESSAGE(toGo, total) : null };
}

export class GlTraceRequiredError extends Error {
  readonly code = "gl_trace_required";
  readonly status = 409;
  constructor(message: string, readonly gate: GlGate) {
    super(message);
    this.name = "GlTraceRequiredError";
  }
}

export function isGlTraceRequiredError(err: unknown): err is GlTraceRequiredError {
  return !!err && typeof err === "object" && (err as { code?: unknown }).code === "gl_trace_required" && (err as { name?: unknown }).name === "GlTraceRequiredError";
}

/** The deal's gate now (syncs the add-backs first — fingerprint-skipped when nothing changed). Never throws: unreadable → not_needed. */
export async function glTraceGate(dealId: string): Promise<GlGate> {
  try {
    const { refreshGl } = await import("./service");
    await refreshGl(dealId);
    const { glStore } = await import("./store");
    const store = glStore();
    const [tracing, traces, links] = await Promise.all([store.getTracing(dealId), store.listTraces(dealId), store.linksOfDeal(dealId)]);
    return gateFrom(tracing, traces, { confirmedLinks: links.filter((k) => k.state === "confirmed").length });
  } catch (err) {
    console.warn(`[gl] couldn't read the add-backs gate for ${dealId} (letting generation through):`, (err as Error)?.message ?? err);
    return gateFrom(null, []);
  }
}

/**
 * Throws GlTraceRequiredError when the step holds this generation:
 * kind "dd" — a full due-diligence generation; kind "cim" — a full CIM
 * generation (only with the hold switch on).
 */
export async function assertGlGate(deal: Pick<Deal, "id">, kind: "cim" | "dd"): Promise<GlGate> {
  if (kind === "cim") {
    // Only the hold switch stops a full CIM: one row read; the full gate only when it's on.
    try {
      const { glStore } = await import("./store");
      if (!(await glStore().getTracing(deal.id))?.requireBeforeCim) return gateFrom(null, []);
    } catch {
      return gateFrom(null, []);
    }
  }
  const gate = await glTraceGate(deal.id);
  if (kind === "dd" && gate.holdsDd) throw new GlTraceRequiredError(DD_GATE_MESSAGE(gate.toGo, gate.total), gate);
  if (kind === "cim" && gate.holdsCim) throw new GlTraceRequiredError(CIM_HOLD_MESSAGE(gate.toGo), gate);
  return gate;
}

/** The 409 body routes answer with. */
export function glGateBody(err: GlTraceRequiredError) {
  return { code: "gl_trace_required" as const, error: err.message, gate: err.gate };
}
