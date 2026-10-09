/**
 * The end of an "Interview together" session (specs/together.md §4.7, §7.3).
 *
 * "Session summary": what was filed (with the seller's words), what's still
 * to get (critical, "come back later" and "someone else has it" ticked by
 * default), the documents still needed, and what goes back to the seller —
 * in their next AI session (the outline's follow-ups: label and a screened
 * ask, never a note) and/or in a short email the broker previews and sends
 * (demo deals record it and never email).
 *
 * Ending always hands the broker's routed questions back (worded by whether
 * the conversation raised them) and refreshes the on-file evidence; it
 * completes the interview only when the broker ticks it (default ticked
 * only when no critical item is open). No "seller finished" email for a
 * broker-led session; no learning loop.
 */
import type { Deal, TogetherLine, TogetherSitting } from "@shared/schema";
import type { CoverageBoard, CoverageItem } from "@shared/coverage-board";
import {
  PRIVATE_ASK_MESSAGE,
  sittingDurationMin,
  type SittingSummary,
  type SpeakerMap,
  type SummaryDocRow,
  type SummaryFiledRow,
  type SummaryOpenRow,
  type TogetherVia,
} from "@shared/together";
import { lineRole } from "@shared/together-speakers";
import { storage } from "../storage";
import { BoardActionError } from "./errors";
import * as hub from "./hub";
import { sittingView, withSittingQueue } from "./sittings";
import { togetherStore } from "./store";
import { writeTranscriptText } from "./transcript";

// ─────────────────────────────────────────────────────────────────────────
// Screening what goes to the seller
// ─────────────────────────────────────────────────────────────────────────

export const ASK_MAX = 300;

export type ScreenResult = { ok: true; text: string } | { ok: false; reason: "empty" | "too_long" | "broker_work" | "keep_out" | "staff_private"; message: string };

/**
 * An ask the broker edited, before it reaches the seller's AI interview or
 * an email: refused when it carries the broker's normalisation work or
 * cites the broker's own material, names something the seller asked to
 * keep out, or holds a staff member's private matter.
 */
export async function screenAsk(text: string, deal: Pick<Deal, "extractedInfo">): Promise<ScreenResult> {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return { ok: false, reason: "empty", message: "Write the question first." };
  if (t.length > ASK_MAX) return { ok: false, reason: "too_long", message: `Keep it under ${ASK_MAX} characters.` };
  const { isBrokerWorkText } = await import("../interview/source-privacy");
  const { mentionsNormalisation } = await import("../interview/reply-guards");
  if (isBrokerWorkText(t) || mentionsNormalisation(t)) return { ok: false, reason: "broker_work", message: PRIVATE_ASK_MESSAGE };
  const facts = ((deal.extractedInfo ?? {}) as Record<string, unknown>);
  const { getSellerKeepOut, carriesPrivateDetail } = await import("../interview/seller-keep-out");
  if (getSellerKeepOut(facts).some((e) => carriesPrivateDetail(t, e))) return { ok: false, reason: "keep_out", message: PRIVATE_ASK_MESSAGE };
  const { screenStaffPrivateText, staffContextFrom } = await import("../cim/staff-private");
  const ctx = staffContextFrom(facts);
  if (screenStaffPrivateText(t, ctx).held.length > 0 || asksAboutStaffPrivate(t, ctx.staffNames, ctx.ownerNames)) {
    return { ok: false, reason: "staff_private", message: PRIVATE_ASK_MESSAGE };
  }
  return { ok: true, text: t };
}

/** A staff member's private matter, as the subject of a question (the CIM-side guard reads statements). */
const STAFF_TOPIC_RE = /\b(?:equity|stake|shares?|partnership|raise|pay rise|paid|pay|salary|salaries|wages?|bonus(?:es)?|leav(?:e|es|ing)|quit(?:ting)?|resign\w*|retir\w*|health|sick\w*|illness|medical|divorc\w*|family|pregnan\w*|maternity|paternity|warning|disciplin\w*|fired|let go|performance|complain\w*|lawsuit|grievance)\b/i;
const STAFF_WORD_RE = /\b(?:employee|staff member|technician|tech|manager|supervisor|foreman|bookkeeper|assistant|dispatcher|lead hand|installer|apprentice)s?\b/i;

export function asksAboutStaffPrivate(text: string, staffNames: string[], ownerNames: string[] = []): boolean {
  if (!STAFF_TOPIC_RE.test(text)) return false;
  const owner = new Set(ownerNames.map((w) => w.toLowerCase()));
  const words = new Set((text.toLowerCase().match(/[a-z\u00c0-\u024f'-]+/g) ?? []).map((w) => w.replace(/'s$/, "")));
  const namesStaff = staffNames.some((n) => n.split(/\s+/).some((w) => w.length >= 3 && !owner.has(w.toLowerCase()) && words.has(w.toLowerCase())));
  return namesStaff || STAFF_WORD_RE.test(text);
}

// ─────────────────────────────────────────────────────────────────────────
// The summary (pure, from the board)
// ─────────────────────────────────────────────────────────────────────────

function allItems(board: CoverageBoard): Array<{ item: CoverageItem; sectionTitle: string }> {
  const out: Array<{ item: CoverageItem; sectionTitle: string }> = [];
  for (const s of board.sections) for (const item of s.items) out.push({ item, sectionTitle: s.title });
  return out;
}

/**
 * The summary of a sitting from the board in its audience (`screen` while
 * "Seller can see this screen" is on — values the seller couldn't see read
 * "On file — private to you"). Pure.
 */
export function buildSittingSummary(args: {
  sitting: Pick<TogetherSitting, "id" | "via" | "startedAt" | "endedAt" | "lastLineAt" | "pausedAt" | "transcriptDocumentId" | "captureState">;
  board: CoverageBoard;
  facts: Record<string, unknown>;
  now?: number;
}): SittingSummary {
  const { sitting, board } = args;
  const filed: SummaryFiledRow[] = [];
  const open: SummaryOpenRow[] = [];
  let alsoNoted = 0;
  for (const { item, sectionTitle } of allItems(board)) {
    if (item.origin === "figures" && item.status !== "on_file") continue;
    if (item.filedInSittingId === sitting.id) {
      if (item.origin === "noted") alsoNoted++;
      filed.push({
        itemId: item.id,
        label: item.label,
        sectionKey: item.sectionKey,
        sectionTitle,
        value: item.privateValue ? null : item.value,
        quote: item.yourNote ? null : item.source?.excerpt ?? null,
        yourNote: !!item.yourNote,
        status: item.status,
        ...(item.filedByChunkId ? { chunkId: item.filedByChunkId } : {}),
        ...(item.valueKey ? { key: item.valueKey } : {}),
      });
      continue;
    }
    if (item.status === "on_file") continue;
    const later = item.marks.some((m) => m.kind === "verify_later");
    const notKnown = item.reason?.code === "not_known";
    open.push({
      itemId: item.id,
      label: item.label,
      sectionKey: item.sectionKey,
      sectionTitle,
      status: item.status,
      critical: item.critical,
      ask: item.ask,
      ticked: item.critical || later || notKnown,
    });
  }
  const docs: SummaryDocRow[] = board.documents.map((d) => ({
    requirementId: d.requirementId,
    name: d.name,
    required: d.required,
    promised: d.promised,
    ticked: d.promised || d.required,
  }));
  let privateNotes = 0;
  if (sitting.transcriptDocumentId) {
    const raw = args.facts._brokerPrivateNotes;
    if (Array.isArray(raw)) {
      for (const n of raw as Array<{ documentId?: string; alsoFrom?: Array<{ documentId?: string }> }>) {
        if (n?.documentId === sitting.transcriptDocumentId || (n?.alsoFrom ?? []).some((a) => a?.documentId === sitting.transcriptDocumentId)) privateNotes++;
      }
    }
  }
  const state = (sitting.captureState ?? {}) as { chunksWaiting?: number };
  return {
    sittingId: sitting.id,
    via: sitting.via as TogetherVia,
    startedAt: new Date(sitting.startedAt).toISOString(),
    endedAt: sitting.endedAt ? new Date(sitting.endedAt).toISOString() : null,
    durationMin: sittingDurationMin(sitting, args.now),
    filed,
    alsoNoted,
    privateNotes,
    toVerify: filed.filter((f) => f.status === "verify").length,
    stillToGet: open,
    criticalOpen: board.totals.criticalOpen,
    documents: docs,
    waiting: Number(state.chunksWaiting ?? 0),
    screen: board.audience === "screen",
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Ending
// ─────────────────────────────────────────────────────────────────────────

export interface EndBody {
  completeInterview: boolean;
  followUps: Array<{ itemId: string; ask: string }>;
  documents: string[];
  addToNextSession: boolean;
}

export function parseEndBody(body: unknown): EndBody | { error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const followUps = Array.isArray(b.followUps) ? b.followUps : [];
  if (followUps.length > 200) return { error: "Too many follow-ups." };
  const out: EndBody["followUps"] = [];
  for (const f of followUps as Array<Record<string, unknown>>) {
    if (typeof f?.itemId !== "string" || typeof f?.ask !== "string" || f.itemId.length > 140) return { error: "A follow-up isn't valid." };
    out.push({ itemId: f.itemId, ask: f.ask });
  }
  const documents = Array.isArray(b.documents) ? (b.documents as unknown[]).filter((d): d is string => typeof d === "string" && d.length <= 64).slice(0, 200) : [];
  return { completeInterview: b.completeInterview === true, followUps: out, documents, addToNextSession: b.addToNextSession !== false };
}

/** What the end of a sitting runs besides the summary — a seam for tests and for dd's hooks (§7.3). */
export interface SittingEndHooks {
  loadBoard(deal: Deal, audience: "broker" | "screen"): Promise<CoverageBoard>;
  handBackRouted(dealId: string, messages: Array<{ role: "ai" | "user"; content: string }>): Promise<unknown>;
  completeInterview(dealId: string, messages: Array<{ role: "ai" | "user"; content: string }>): Promise<void>;
  refreshEvidence(dealId: string): void;
  /** dd: the questions about the numbers raised on the call (optional until dd ships). */
  explainQuestionsRaised?(dealId: string, sittingId: string, messages: Array<{ role: "ai" | "user"; content: string }>): Promise<{ answered: number } | void>;
  scheduleFigureBuild?(dealId: string, reason: string): void;
  planExplainQuestions?(dealId: string): Promise<unknown> | void;
  /** How long the end waits for parts being filed (tests shorten it). */
  endWaitMs?: number;
}

const defaultHooks: SittingEndHooks = {
  async loadBoard(deal, audience) {
    const { buildCoverageBoard } = await import("../interview/coverage-board");
    return buildCoverageBoard(deal, { audience });
  },
  async handBackRouted(dealId, messages) {
    const { markRoutedDiscrepanciesRaised } = await import("../interview/session-manager");
    return markRoutedDiscrepanciesRaised(dealId, messages);
  },
  async completeInterview(dealId, messages) {
    const { completeDealInterview } = await import("../interview/session-manager");
    await completeDealInterview(dealId, { mode: "broker_with_seller", messages, skipHandBack: true });
  },
  refreshEvidence(dealId) {
    // (A model call — never from a local server with the key off.)
    if (process.env.ANTHROPIC_API_KEY === "disabled") return;
    void import("../interview/on-file-refresh").then(({ refreshOnFileEvidence }) => refreshOnFileEvidence(dealId, { currentSessionId: null })).catch(() => undefined);
  },
};

let hooks: SittingEndHooks = defaultHooks;

/** dd registers its end-of-sitting hooks here at merge time (they're optional until then). */
export function registerSittingEndHooks(extra: Pick<SittingEndHooks, "explainQuestionsRaised" | "scheduleFigureBuild" | "planExplainQuestions">): void {
  hooks = { ...hooks, ...extra };
}

export function _setSittingEndHooksForTests(h: Partial<SittingEndHooks> | null): void {
  hooks = h ? { ...defaultHooks, ...h } : defaultHooks;
}

/** The sitting's conversation as messages: the seller's lines as the seller's, everyone else's as the interviewer's. */
export function linesAsMessages(sitting: Pick<TogetherSitting, "speakers">, lines: TogetherLine[]): Array<{ role: "ai" | "user"; content: string }> {
  const speakers = (sitting.speakers ?? {}) as SpeakerMap;
  return lines
    .filter((l) => l.source !== "typed")
    .map((l) => ({ role: lineRole(speakers, { speaker: l.speaker, attested: !!l.attestedSellerAt }) === "seller" ? ("user" as const) : ("ai" as const), content: l.text }));
}

/** The summary as it stands now (the dialog before "Done"; also kept for a stale sitting). */
export async function currentSummary(sitting: TogetherSitting, deal: Deal): Promise<SittingSummary> {
  const audience = sitting.sellerSeesScreen ? "screen" : "broker";
  const board = await hooks.loadBoard(deal, audience);
  const { chunkCounts } = await import("./pipeline");
  const counts = chunkCounts(await togetherStore().listChunks(sitting.id).catch(() => []));
  return { ...buildSittingSummary({ sitting, board, facts: ((deal.extractedInfo ?? {}) as Record<string, unknown>) }), waiting: counts.waiting + counts.failed };
}

/**
 * Ends a sitting: follow-ups screened and added to the outline, the
 * transcript's text written, the summary stored, routed questions handed
 * back, dd's hooks run, the interview completed when the broker ticked it.
 */
export async function endSitting(sitting: TogetherSitting, deal: Deal, body: EndBody): Promise<{ sitting: TogetherSitting; summary: SittingSummary; followUpsAdded: number }> {
  if (sitting.status === "ended") throw new BoardActionError("This session has already ended.", 409, "ended");
  const audience = sitting.sellerSeesScreen ? "screen" : "broker";
  const board = await hooks.loadBoard(deal, audience);
  const items = new Map<string, CoverageItem>();
  for (const s of board.sections) for (const i of s.items) items.set(i.id, i);

  // Follow-ups: open items only, asks screened (nothing is written if one is refused).
  const followUps: Array<{ itemId: string; key: string; sectionKey: string; label: string; ask: string; sittingId: string }> = [];
  if (body.addToNextSession) {
    for (const f of body.followUps) {
      const item = items.get(f.itemId);
      if (!item || item.status === "on_file" || item.origin === "figures") continue;
      const screened = await screenAsk(f.ask, deal);
      if (!screened.ok) throw new BoardActionError(screened.message, 400, "private_ask", { itemId: f.itemId, label: item.label });
      const key = item.members.find((m) => m.writable)?.key ?? item.members[0]?.key ?? item.id.split(":")[1];
      followUps.push({ itemId: item.id, key, sectionKey: item.sectionKey, label: item.label, ask: screened.text, sittingId: sitting.id });
    }
  }

  // Whatever the seller was saying is filed first (≤ 20 s for what's in flight).
  {
    const { flush, waitForIdle } = await import("./pipeline");
    const current = (await togetherStore().getSitting(sitting.id)) ?? sitting;
    await flush(current, "end").catch(() => undefined);
    await waitForIdle(sitting.id, hooks.endWaitMs ?? 20_000).catch(() => false);
  }
  return withSittingQueue(sitting.id, async () => {
    const store = togetherStore();
    const fresh = (await store.getSitting(sitting.id)) ?? sitting;
    if (fresh.status === "ended") throw new BoardActionError("This session has already ended.", 409, "ended");
    if (followUps.length > 0) {
      const { addFollowUpItems } = await import("../interview/outline");
      await addFollowUpItems(deal.id, followUps);
    }
    const endedAt = new Date();
    await writeTranscriptText(fresh).catch((err) => console.warn(`[together] final transcript write failed (${fresh.id}):`, (err as Error).message));
    const lines = await store.allLines(fresh.id);
    const messages = linesAsMessages(fresh, lines);

    // Routed questions come back to the broker — always (complete or not).
    await hooks.handBackRouted(deal.id, messages).catch((err) => console.error(`[together] couldn't hand routed questions back on ${deal.id}:`, (err as Error).message));
    hooks.refreshEvidence(deal.id);
    // dd: questions about the numbers raised (optional until dd ships).
    try {
      const r = hooks.explainQuestionsRaised ? await hooks.explainQuestionsRaised(deal.id, fresh.id, messages) : undefined;
      if (r && typeof r === "object" && "answered" in r && r.answered > 0) hooks.scheduleFigureBuild?.(deal.id, "interview_answers");
      if (hooks.planExplainQuestions) void Promise.resolve(hooks.planExplainQuestions(deal.id)).catch(() => undefined);
    } catch (err) {
      console.warn(`[together] dd end-of-session hooks failed on ${deal.id}:`, (err as Error).message);
    }
    if (body.completeInterview) await hooks.completeInterview(deal.id, messages);

    // The summary from the board as it stands after the last filing.
    const finalDeal = (await storage.getDeal(deal.id)) ?? deal;
    const finalBoard = await hooks.loadBoard(finalDeal, audience);
    const chunks = await store.listChunks(fresh.id);
    const { chunkCounts, stopRunner } = await import("./pipeline");
    const counts = chunkCounts(chunks);
    const summary: SittingSummary = {
      ...buildSittingSummary({ sitting: { ...fresh, endedAt }, board: finalBoard, facts: ((finalDeal.extractedInfo ?? {}) as Record<string, unknown>) }),
      waiting: counts.waiting + counts.failed,
      completeInterview: body.completeInterview,
      followUpsAdded: followUps.length,
    };
    const row = (await store.updateSitting(fresh.id, { status: "ended", endedAt, summary, interviewCompleted: body.completeInterview })) ?? fresh;
    hub.publish(fresh.id, { type: "sitting", sitting: sittingView(row, { chunks }) });
    hub.closeSitting(fresh.id);
    // (Parts still waiting for the AI are filed later by the retry; nothing waits here.)
    if (counts.waiting + counts.failed === 0) stopRunner(fresh.id);
    return { sitting: row, summary, followUpsAdded: followUps.length };
  });
}

// ─────────────────────────────────────────────────────────────────────────
// "Email the seller this list…" (preview, then the broker's click)
// ─────────────────────────────────────────────────────────────────────────

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface FollowUpEmail {
  to: string | null;
  subject: string;
  html: string;
  text: string;
  asks: string[];
  documents: string[];
}

/** The email body (pure): the asks, the documents with a button to the seller's documents page, a button to their interview. */
export function followUpEmail(args: {
  businessName: string;
  sellerName?: string | null;
  brokerName?: string | null;
  asks: string[];
  documents: string[];
  interviewLink: string | null;
  documentsLink: string | null;
}): Omit<FollowUpEmail, "to"> {
  const subject = `${args.businessName}: a few things to finish your business overview`;
  const hi = args.sellerName ? `Hi ${esc(args.sellerName)},` : "Hi,";
  const button = (href: string, label: string) =>
    `<p><a href="${esc(href)}" style="display:inline-block;background:#B08D57;color:#151311;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600">${esc(label)}</a></p>`;
  const html = [
    `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#1a1815">`,
    `<p>${hi}</p>`,
    `<p>Thanks for the time today. A few things are still needed to finish your business overview.</p>`,
    args.asks.length ? `<p style="margin-bottom:4px"><strong>Questions to think about</strong></p><ul>${args.asks.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>` : "",
    args.asks.length && args.interviewLink ? button(args.interviewLink, "Answer them in your interview") : "",
    args.documents.length ? `<p style="margin-bottom:4px"><strong>Documents to send</strong></p><ul>${args.documents.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>` : "",
    args.documents.length && args.documentsLink ? button(args.documentsLink, "Upload your documents") : "",
    args.brokerName ? `<p>${esc(args.brokerName)}</p>` : "",
    `<p style="color:#6b655c;font-size:13px">Reply to this email if anything is unclear.</p>`,
    `</div>`,
  ].join("");
  const text = [
    hi,
    "",
    "Thanks for the time today. A few things are still needed to finish your business overview.",
    ...(args.asks.length ? ["", "Questions to think about:", ...args.asks.map((a) => `- ${a}`)] : []),
    ...(args.asks.length && args.interviewLink ? ["", `Answer them in your interview: ${args.interviewLink}`] : []),
    ...(args.documents.length ? ["", "Documents to send:", ...args.documents.map((d) => `- ${d}`)] : []),
    ...(args.documents.length && args.documentsLink ? ["", `Upload your documents: ${args.documentsLink}`] : []),
    ...(args.brokerName ? ["", args.brokerName] : []),
  ].join("\n");
  return { subject, html, text, asks: args.asks, documents: args.documents };
}

function appBase(): string {
  return (process.env.APP_URL || "https://app.cimple.ca").replace(/\/$/, "");
}

/**
 * Preview (default) or send the follow-up email — only on the broker's
 * click, only to the seller invite address on the deal. Demo deals record
 * the send on the sitting and never email. Until dd's one follow-up email
 * path merges, this is together's own (the integrator switches the call).
 */
export async function sendFollowUpEmail(args: {
  deal: Deal;
  sitting: TogetherSitting;
  itemIds: string[];
  documentIds: string[];
  /** The asks as the broker edited them in the summary (screened here again). */
  asks?: Record<string, string>;
  preview: boolean;
  brokerId: string;
  send?: (to: string, subject: string, html: string, opts: { replyTo?: string | null; fromName?: string | null }) => Promise<boolean>;
}): Promise<FollowUpEmail & { sent: boolean; recorded: boolean }> {
  const { deal, sitting } = args;
  const audience = sitting.sellerSeesScreen ? "screen" : "broker";
  const board = await hooks.loadBoard(deal, audience);
  const items = new Map<string, CoverageItem>();
  for (const s of board.sections) for (const i of s.items) items.set(i.id, i);
  const outline = (deal.interviewOutline ?? {}) as { followUpItems?: Array<{ itemId: string; ask: string }> };
  const asks: string[] = [];
  for (const id of args.itemIds.slice(0, 50)) {
    const item = items.get(id);
    if (!item || item.status === "on_file" || item.origin === "figures") continue;
    const edited = typeof args.asks?.[id] === "string" && args.asks[id].trim() ? args.asks[id] : null;
    const stored = outline.followUpItems?.find((f) => f.itemId === id)?.ask;
    const screened = await screenAsk(edited || stored || item.ask, deal);
    if (!screened.ok) throw new BoardActionError(screened.message, 400, "private_ask", { itemId: id, label: item.label });
    asks.push(screened.text);
  }
  const docNames: string[] = [];
  for (const id of args.documentIds.slice(0, 50)) {
    const d = board.documents.find((x) => x.requirementId === id);
    if (d) docNames.push(d.name);
  }
  if (asks.length === 0 && docNames.length === 0) throw new BoardActionError("Pick at least one question or document to send.", 400, "empty");

  const invites = await storage.getSellerInvitesByDealId(deal.id);
  const invite = invites.find((i) => i.status === "accepted" && i.sellerEmail) ?? invites.find((i) => i.status === "sent" && i.sellerEmail) ?? invites.find((i) => i.sellerEmail);
  const broker = await storage.getUser(args.brokerId).catch(() => undefined);
  const brokerName = (broker as { name?: string | null } | undefined)?.name ?? null;
  const email = followUpEmail({
    businessName: deal.businessName,
    sellerName: invite?.sellerName ?? null,
    brokerName,
    asks,
    documents: docNames,
    interviewLink: invite ? `${appBase()}/seller/${invite.token}/interview` : null,
    documentsLink: invite ? `${appBase()}/seller/${invite.token}/documents` : null,
  });
  const to = invite?.sellerEmail ?? null;
  if (args.preview) return { ...email, to, sent: false, recorded: false };
  if (!to) throw new BoardActionError("There's no email address for the seller on this deal — invite them from the Overview first.", 409, "no_seller_email");

  let sent = false;
  let recorded = false;
  if ((deal as { demoKey?: string | null }).demoKey) {
    // Demo and QA deals never email anyone: the send is recorded only.
    recorded = true;
  } else {
    const send = args.send ?? (async (t, subj, html, opts) => (await import("../notifications/service")).sendDirectEmail(t, subj, html, undefined, opts));
    sent = await send(to, email.subject, email.html, { replyTo: (broker as { email?: string | null } | undefined)?.email ?? null, fromName: brokerName ? `${brokerName} via Cimple` : null });
  }
  const summary = (sitting.summary ?? null) as SittingSummary | null;
  if (summary) {
    const row = await togetherStore().updateSitting(sitting.id, { summary: { ...summary, emailedAt: new Date().toISOString() } });
    if (row) hub.publish(sitting.id, { type: "sitting", sitting: sittingView(row) });
  }
  return { ...email, to, sent, recorded };
}
