/**
 * broker-view.ts — what the broker's "Add-backs in the books" panel shows
 * (gl spec §3.4): the add-backs with their per-year cells in words, the
 * tie-out in words, the request and the seller's progress, the gate, the
 * seller's other costs and the accounts Cimple noticed. Everything the panel
 * needs in one payload; the broker sees all (private ledgers flagged).
 */
import { storage } from "../storage";
import type { GlAddbackTrace, GlTracing, GlTraceLink, DealMember, SellerInvite } from "@shared/schema";
import type { GlTieOutYear, GlTraceComputed, GlSellerSuggestion } from "@shared/gl-types";
import { brokerCellWords, payDocWords, PROOF_LABEL, type GlProofKind } from "@shared/gl-copy";
import { glStore } from "./store";
import { gateFrom, type GlGate } from "./gate";
import { tieOutWords, tieOutSummary } from "./tie-out";
import { possibleAddbacks, type PossibleAddback } from "./discover";
import type { GlDealContext } from "./context";
import { glSellerEvent } from "./notify";

export interface BrokerTraceView {
  id: string;
  addbackKey: string;
  label: string;
  category: string | null;
  proof: GlProofKind;
  proofLabel: string;
  proofByBroker: boolean;
  sharePct: number | null;
  shareBasis: string | null;
  shareBasisDoc: string | null;
  claims: Record<string, number>;
  yearLabels: Record<string, string>;
  sellerLabel: string;
  sellerHint: string | null;
  privateEvidence: boolean;
  sentAt: string | null;
  sellerStatus: string;
  reopenedNote: string | null;
  sellerNote: string | null;
  sellerNoteShown: boolean;
  notInLedger: { reason: string; at: string; years?: string[] } | null;
  question: { text: string; askedAt: string; answer?: string; answeredAt?: string } | null;
  brokerVerdict: string | null;
  reviewedAt: string | null;
  brokerNote: string | null;
  brokerNoteShown: boolean;
  buyerReason: string | null;
  leftOut: { years: string[]; reason: string } | null;
  includeInCim: boolean;
  computed: GlTraceComputed | null;
  /** Per year, the grid's words. */
  cells: Record<string, { words: string; status: string; tone: "good" | "close" | "warn" | "muted" }>;
  /** Cimple found likely entries (proposals) for these years. */
  proposedYears: string[];
}

export interface GlRecipient { id: string; name: string | null; email: string; role: string; via: "members" | "seller_invite"; muted: boolean }

export interface BrokerGlView {
  analysis: { present: boolean };
  tracing: {
    fiscalYearEnd: string;
    requestedAt: string | null;
    recipients: Array<{ memberId: string | null; inviteId: string | null; role: string }>;
    sellerMessage: string | null;
    lastRemindedAt: string | null;
    withdrawnAt: string | null;
    sellerDoneAt: string | null;
    sellerConfirmation: GlTracing["sellerConfirmation"];
    cantGetLedger: GlTracing["cantGetLedger"];
    accountantRequest: GlTracing["accountantRequest"];
    waived: GlTracing["waived"];
    reviewedAt: string | null;
    requireBeforeCim: boolean;
    publishedAt: string | null;
  };
  traces: BrokerTraceView[];
  tieOut: { years: Array<{ year: string; state: GlTieOutYear["state"]; words: string; accepted: { note: string; at: string } | null; data: GlTieOutYear }>; summary: { tone: "good" | "warn" | "muted"; text: string } };
  gate: GlGate;
  seller: { name: string | null; email: string | null } | null;
  sellerLastActiveAt: string | null;
  recipients: GlRecipient[];
  suggestions: GlSellerSuggestion[];
  possible: PossibleAddback[];
  payDoc: { slips: string; short: string; box: string | null };
  demo: boolean;
  /** What buyers see now (the broker's published snapshot) and what changed since. */
  buyers: { publishedAt: string | null; versions: { dd: boolean; normal: boolean; blind: boolean } | null; changes: string[] };
}

const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);

const TONE: Record<string, "good" | "close" | "warn" | "muted"> = {
  found: "good", document: "good", close: "close", short: "warn", over: "warn", not_started: "muted", not_in_ledger: "muted", statement: "muted", left_out: "muted",
};

export function brokerTraceView(t: GlAddbackTrace, links: GlTraceLink[], docShort: string): BrokerTraceView {
  const computed = (t.computed as GlTraceComputed | null) ?? null;
  const cells: BrokerTraceView["cells"] = {};
  for (const [y, c] of Object.entries(computed?.byYear ?? {})) {
    cells[y] = { words: c.status === "left_out" && c.reason ? `Left out — ${c.reason}` : brokerCellWords(c, docShort), status: c.status, tone: TONE[c.status] ?? "muted" };
  }
  const proposedYears = Array.from(new Set(links.filter((k) => k.traceId === t.id && k.state === "proposed").map((k) => k.fiscalYear))).sort();
  const proof = (["ledger", "payroll", "one_off", "statement"].includes(t.proof) ? t.proof : "ledger") as GlProofKind;
  return {
    id: t.id, addbackKey: t.addbackKey, label: t.label, category: t.category, proof, proofLabel: PROOF_LABEL[proof], proofByBroker: t.proofByBroker,
    sharePct: t.sharePct, shareBasis: t.shareBasis, shareBasisDoc: t.shareBasisDoc,
    claims: (t.claims as Record<string, number>) ?? {}, yearLabels: (t.yearLabels as Record<string, string>) ?? {},
    sellerLabel: t.sellerLabel, sellerHint: t.sellerHint, privateEvidence: t.privateEvidence, sentAt: iso(t.sentAt), sellerStatus: t.sellerStatus,
    reopenedNote: t.reopenedNote, sellerNote: t.sellerNote, sellerNoteShown: t.sellerNoteShown, notInLedger: (t.notInLedger as any) ?? null,
    question: (t.question as any) ?? null, brokerVerdict: t.brokerVerdict, reviewedAt: iso(t.reviewedAt), brokerNote: t.brokerNote, brokerNoteShown: t.brokerNoteShown,
    buyerReason: t.buyerReason, leftOut: (t.leftOut as any) ?? null, includeInCim: t.includeInCim, computed, cells, proposedYears,
  };
}

/** Who "Ask the seller…" can reach, each with their own link (never the token itself). */
export async function glRecipients(dealId: string, members?: DealMember[], invites?: SellerInvite[]): Promise<GlRecipient[]> {
  const { sellerPortalRecipients } = await import("../notifications/service");
  const ms = members ?? (await storage.getDealMembers(dealId));
  const inv = invites ?? (await storage.getSellerInvitesByDealId(dealId));
  return sellerPortalRecipients(glSellerEvent(), ms, inv).map((r) => {
    const m = ms.find((x) => x.id === r.recipientId);
    return { id: r.recipientId, name: r.name, email: r.email, role: m?.role ?? "owner", via: r.via, muted: !!r.muted };
  });
}

/** The panel's payload (needs the deal's context; syncing is the caller's step). */
export async function buildBrokerView(c: GlDealContext): Promise<BrokerGlView> {
  const store = glStore();
  const [traces, links, tracing, members, invites, analyses] = await Promise.all([
    store.listTraces(c.dealId),
    store.linksOfDeal(c.dealId),
    store.getTracing(c.dealId),
    storage.getDealMembers(c.dealId),
    storage.getSellerInvitesByDealId(c.dealId),
    storage.getFinancialAnalysesByDeal(c.dealId),
  ]);
  const tr = tracing ?? c.tracing;
  const live = traces.filter((t) => !t.removedAt);
  const { jurisdictionOf } = await import("../interview/reply-guards");
  const pay = payDocWords(jurisdictionOf(c.deal?.location ?? null));
  const accepted = (tr.tieOutAccepted as Record<string, { note: string; at: string; by: string }> | null) ?? {};
  const tieOut = (tr.tieOut as Record<string, GlTieOutYear> | null) ?? {};
  const years = Object.keys(tieOut).sort().map((y) => ({
    year: y, state: tieOut[y].state, words: tieOutWords(y, tieOut[y], accepted[y] ?? null), accepted: accepted[y] ? { note: accepted[y].note, at: accepted[y].at } : null, data: tieOut[y],
  }));
  const primary = invites.filter((i) => i.status !== "revoked").sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt))[0];
  const sellerActs = links.filter((k) => k.decidedBy === "seller" && k.decidedAt).map((k) => +new Date(k.decidedAt!));
  const traceActs = live.filter((t) => t.sentAt && t.sellerStatus !== "not_started").map((t) => +new Date(t.updatedAt));
  const last = Math.max(0, ...sellerActs, ...traceActs);
  const covered = new Set(links.filter((k) => k.state === "confirmed" || k.state === "proposed").map((k) => k.account ?? "").filter(Boolean));
  const totals = c.ready.length ? await store.dealAccountTotals(c.dealId, Array.from(c.readyIds)) : [];
  const pub = tr.published as { v?: number; versions?: { dd: boolean; normal: boolean; blind: boolean } } | null;
  let buyers: BrokerGlView["buyers"] = { publishedAt: null, versions: null, changes: [] };
  if (pub && pub.v === 1) {
    const { evidenceChangeCount } = await import("./evidence");
    const ch = await evidenceChangeCount(c.dealId).catch(() => ({ publishedAt: iso(tr.publishedAt), changes: [] as string[] }));
    buyers = { publishedAt: ch.publishedAt, versions: pub.versions ?? null, changes: ch.changes };
  }
  return {
    analysis: { present: analyses.some((a) => a.status === "completed" || a.status === "reviewed") },
    tracing: {
      fiscalYearEnd: tr.fiscalYearEnd,
      requestedAt: iso(tr.requestedAt),
      recipients: (tr.recipients as BrokerGlView["tracing"]["recipients"]) ?? [],
      sellerMessage: tr.sellerMessage,
      lastRemindedAt: iso(tr.lastRemindedAt),
      withdrawnAt: iso(tr.withdrawnAt),
      sellerDoneAt: iso(tr.sellerDoneAt),
      sellerConfirmation: tr.sellerConfirmation,
      cantGetLedger: tr.cantGetLedger,
      accountantRequest: tr.accountantRequest,
      waived: tr.waived,
      reviewedAt: iso(tr.reviewedAt),
      requireBeforeCim: tr.requireBeforeCim,
      publishedAt: iso(tr.publishedAt),
    },
    traces: live.map((t) => brokerTraceView(t, links, pay.short)),
    tieOut: { years, summary: tieOutSummary(tieOut, accepted) },
    gate: gateFrom(tr, traces, { confirmedLinks: links.filter((k) => k.state === "confirmed").length }),
    seller: primary ? { name: primary.sellerName ?? null, email: primary.sellerEmail ?? null } : null,
    sellerLastActiveAt: last ? new Date(last).toISOString() : null,
    recipients: await glRecipients(c.dealId, members, invites),
    suggestions: ((tr.sellerSuggestions as GlSellerSuggestion[] | null) ?? []).filter((s) => s.status === "new"),
    possible: possibleAddbacks(totals, covered),
    payDoc: pay,
    demo: !!c.deal?.demoKey,
    buyers,
  };
}
