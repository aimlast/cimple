/**
 * rank-ai.ts — Cimple's assistant suggests the entries behind an add-back
 * the rules couldn't settle (gl spec §7.4, D9). Installed as the proposal
 * run's ranker (setGlRanker) when this module loads; the run calls it only
 * for SENT add-backs the rules left unconfident, after the rules' own
 * proposals are saved.
 *
 * One forced tool call (pick_ledger_entries) per add-back, covering its
 * unsettled years: ≤40 candidate entries a year (≤120 in all) and ≤10
 * account summaries a year, referred to only as T… / A…. Entries come only
 * from ledgers the seller may see — a ledger private to the broker never
 * leaves the server for something the seller will be shown.
 *
 * Never trusted as is: a reference outside the shortlist is dropped; a
 * whole-account pick is expanded in code to that account's entries for the
 * year; totals and statuses are worked out in code (gl-reconcile), never
 * taken from the model; picks become PROPOSALS ("Cimple's assistant: …",
 * medium for "yes", low for "maybe") — never confirmed; an entry the seller
 * or broker already rejected is never proposed again. A malformed answer, no
 * tool call or an outage leaves the rules' proposals as they are and says so.
 * Budget reserved first (broker 12 / seller 8 a day). ≈ $0.022 a call.
 */
import { agentConfig } from "../interview/config/load-config";
import { describeAiFailure, withAiRetry } from "../ai-retry";
import type { GlAddbackTrace, GlTransaction, InsertGlTraceLink } from "@shared/schema";
import { targetCents } from "@shared/gl-reconcile";
import { formatCents } from "@shared/gl-copy";
import { glAiClient, reserveGlAi, toolInput } from "./ai";
import { glStore } from "./store";
import { withGlLock } from "./lock";
import { loadGlContext } from "./context";
import { entryKey, hintWords, termsFor } from "./match";
import { recomputeTraces, setGlRanker, type GlRanker } from "./match-run";

export const PICK_TOOL = {
  name: "pick_ledger_entries",
  description: "Pick the ledger entries (or whole accounts) that make up this add-back.",
  input_schema: {
    type: "object",
    properties: {
      picks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            ref: { type: "string", pattern: "^T\\d{1,3}$" },
            fit: { type: "string", enum: ["yes", "maybe"] },
            reason: { type: "string", maxLength: 80 },
          },
          required: ["ref", "fit"],
        },
      },
      wholeAccounts: {
        type: "array",
        items: {
          type: "object",
          properties: { ref: { type: "string", pattern: "^A\\d{1,2}$" }, fit: { type: "string", enum: ["yes", "maybe"] } },
          required: ["ref", "fit"],
        },
      },
      note: { type: "string", maxLength: 200 },
    },
    required: ["picks"],
  },
} as const;

const SYSTEM =
  "You help a business broker find which general-ledger entries make up an add-back — a cost the business paid that a new owner won't have. You get one add-back, the years to look at, and a short list of candidate entries from the ledger. Pick only entries that plausibly belong to this add-back. Refer to entries and accounts only by their references (T…, A…). If the add-back is a share of a cost (for example half of meals), pick the entries of the whole cost. Keep each reason under 12 words. Never invent entries.";

export const ASSISTANT_WORDS = {
  looking: "Cimple's assistant is looking…",
  budget: "Cimple's assistant has done its share for today — ask again tomorrow.",
  failed: "Cimple's assistant couldn't suggest more — search the ledger or tick entries yourself.",
  unavailable: "Cimple's assistant isn't available right now — search the ledger or tick entries yourself.",
  done: (n: number) => (n > 0 ? `Cimple's assistant suggested ${n} more entr${n === 1 ? "y" : "ies"}.` : "Cimple's assistant found nothing more."),
} as const;

export type AssistantState = { state: "looking" | "budget" | "failed" | "done" | "unavailable"; added: number; at: string };
const states = new Map<string, AssistantState>();

/** What the assistant is doing (or did) for an add-back — the broker's drawer and the seller's card read this. */
export function glAssistantState(traceId: string): AssistantState | null {
  return states.get(traceId) ?? null;
}

/** The line the broker's drawer shows (null = nothing to say). */
export function assistantWords(s: AssistantState | null): string | null {
  if (!s) return null;
  return s.state === "done" ? ASSISTANT_WORDS.done(s.added) : ASSISTANT_WORDS[s.state];
}
function setState(traceId: string, state: AssistantState["state"], added = 0): void {
  states.set(traceId, { state, added, at: new Date().toISOString() });
  if (states.size > 5000) states.delete(states.keys().next().value as string);
}

interface Shortlist {
  entries: Array<GlTransaction & { ref: string }>;
  accounts: Array<{ ref: string; fiscalYear: string; accountKey: string; account: string; lines: number; netCents: number }>;
  prompt: string;
}

const money = (c: number) => formatCents(c);

/** The shortlist and the prompt (≤40 entries and ≤10 accounts a year; seller-visible ledgers only). */
export async function buildShortlist(t: GlAddbackTrace, years: string[], sellerLedgerIds: string[], dealId: string, decided: ReadonlySet<string>): Promise<Shortlist> {
  const store = glStore();
  const mt = { label: t.label, category: t.category, proof: t.proof };
  const terms = termsFor(mt);
  const extra = hintWords(t.sellerHint, terms);
  const allTotals = sellerLedgerIds.length ? await store.dealAccountTotals(dealId, sellerLedgerIds) : [];
  const entries: Shortlist["entries"] = [];
  const accounts: Shortlist["accounts"] = [];
  const yearLines: string[] = [];
  const claims = (t.claims as Record<string, number>) ?? {};
  for (const y of years.slice(0, 3)) {
    const claim = Number(claims[y] ?? 0);
    const target = targetCents(claim, t.sharePct);
    const amounts = target ? [1, 2, 4, 12, 24, 26, 52].map((p) => Math.round(Math.abs(target) / p)) : [];
    const cands = sellerLedgerIds.length
      ? (await store.candidateRows({ dealId, fiscalYear: y, ledgerIds: sellerLedgerIds, accountKeys: [], terms: [...terms, ...extra], amounts, limit: 3000 }))
        .filter((r) => !decided.has(entryKey(r)))
      : [];
    const lowerTerms = [...terms, ...extra];
    const score = (r: GlTransaction) => {
      const text = `${r.account} ${r.name ?? ""} ${r.memo ?? ""}`.toLowerCase();
      const termHits = lowerTerms.filter((w) => text.includes(w)).length;
      const near = amounts.some((a) => a && Math.abs(Math.abs(r.amountCents) - a) <= Math.max(100, a * 0.02)) ? 1 : 0;
      return termHits * 2 + near;
    };
    const top = cands.sort((a, b) => score(b) - score(a) || a.rowNo - b.rowNo).slice(0, 40);
    for (const r of top) entries.push({ ...r, ref: `T${entries.length + 1}` });
    const used = new Map<string, number>();
    for (const r of top) used.set(r.accountKey, (used.get(r.accountKey) ?? 0) + 1);
    const yearAccounts = allTotals
      .filter((a) => a.fiscalYear === y && (used.has(a.accountKey) || lowerTerms.some((w) => a.account.toLowerCase().includes(w))))
      .sort((a, b) => (used.get(b.accountKey) ?? 0) - (used.get(a.accountKey) ?? 0))
      .slice(0, 10);
    for (const a of yearAccounts) accounts.push({ ref: `A${accounts.length + 1}`, fiscalYear: y, accountKey: a.accountKey, account: a.account, lines: a.lines, netCents: a.netCents });
    yearLines.push(`${y} (fiscal ${y}), claimed ${money(claim)} → entries should total about ${money(target)}`);
  }
  const share = t.sharePct && t.sharePct > 0 && t.sharePct < 100 ? `${t.sharePct}%` : "all of it";
  const prompt = [
    `Add-back: ${t.label}`,
    `What it is: ${t.sellerHint ?? "—"}`,
    `Kind: ${t.category ?? "other"}`,
    `Share added back: ${share}`,
    `Years: ${yearLines.join("; ")}`,
    "Accounts:",
    ...accounts.map((a) => `[${a.ref}] ${a.fiscalYear} · ${a.account} · ${a.lines} entries · ${money(a.netCents)}`),
    "Entries:",
    ...entries.map((e) => `[${e.ref}] ${e.txnDate} | ${e.account} | ${e.name ?? ""} | ${e.memo ?? ""} | ${(e.amountCents / 100).toFixed(2)}`),
  ].join("\n");
  return { entries, accounts, prompt };
}

/** The model's picks → proposal rows (pure; refs outside the shortlist dropped, accounts expanded by the caller's rows). */
export function picksToProposals(
  input: Record<string, unknown> | null,
  list: Pick<Shortlist, "entries" | "accounts">,
  accountRows: ReadonlyMap<string, GlTransaction[]>,
  t: Pick<GlAddbackTrace, "id" | "dealId">,
  skip: ReadonlySet<string>,
): InsertGlTraceLink[] {
  if (!input) return [];
  const byRef = new Map(list.entries.map((e) => [e.ref, e]));
  const accByRef = new Map(list.accounts.map((a) => [a.ref, a]));
  const out = new Map<string, InsertGlTraceLink>();
  const add = (r: GlTransaction, fit: string, reason: string) => {
    const k = entryKey(r);
    if (skip.has(k) || out.has(k)) return;
    out.set(k, {
      traceId: t.id, dealId: t.dealId, fiscalYear: r.fiscalYear, ledgerId: r.ledgerId, rowNo: r.rowNo,
      txnDate: r.txnDate, account: r.account, name: r.name, memo: r.memo, amountCents: Number(r.amountCents),
      state: "proposed", proposedBy: "ai", confidence: fit === "yes" ? "medium" : "low",
      reason: `Cimple's assistant: ${reason.replace(/\s+/g, " ").trim().slice(0, 80) || "looks like part of this cost"}`,
    } as InsertGlTraceLink);
  };
  const picks = Array.isArray(input.picks) ? input.picks : [];
  for (const p of picks) {
    const ref = String((p as { ref?: unknown })?.ref ?? "");
    const fit = (p as { fit?: unknown })?.fit;
    if (fit !== "yes" && fit !== "maybe") continue;
    const e = byRef.get(ref);
    if (!e) continue; // not on the shortlist — dropped
    add(e, fit, String((p as { reason?: unknown })?.reason ?? ""));
  }
  const whole = Array.isArray(input.wholeAccounts) ? input.wholeAccounts : [];
  for (const w of whole) {
    const fit = (w as { fit?: unknown })?.fit;
    const a = accByRef.get(String((w as { ref?: unknown })?.ref ?? ""));
    if (!a || (fit !== "yes" && fit !== "maybe")) continue;
    for (const r of (accountRows.get(`${a.fiscalYear}|${a.accountKey}`) ?? []).slice(0, 300)) add(r, fit, `the whole ${a.account} account`);
  }
  return Array.from(out.values());
}

/** The ranker the proposal run calls (match-run.ts). Never throws. */
export const rankWithAi: GlRanker = async ({ dealId, traceId, years, ai }) => {
  const client = glAiClient();
  if (!client) { setState(traceId, "unavailable"); return; }
  setState(traceId, "looking");
  try {
    if (!(await reserveGlAi(dealId, ai, "ranking"))) {
      setState(traceId, "budget");
      return;
    }
    const store = glStore();
    const [c, t, links] = await Promise.all([loadGlContext(dealId), store.getTrace(traceId), store.linksOfTrace(traceId)]);
    if (!t || t.removedAt || !t.sentAt) { states.delete(traceId); return; }
    const decided = new Set(links.filter((k) => k.ledgerId && (k.state === "confirmed" || k.state === "rejected")).map(entryKey));
    const sellerLedgers = Array.from(c.sellerLedgerIds);
    const list = await buildShortlist(t, years, sellerLedgers, dealId, decided);
    if (list.entries.length === 0 && list.accounts.length === 0) { setState(traceId, "done", 0); return; }
    let input: Record<string, unknown> | null = null;
    try {
      const res = await withAiRetry(() => client.messages.create({
        model: agentConfig.models.supportingAgents,
        max_tokens: 2000,
        temperature: 0,
        system: SYSTEM,
        tools: [PICK_TOOL],
        tool_choice: { type: "tool", name: PICK_TOOL.name },
        messages: [{ role: "user", content: list.prompt }],
      }), [5_000, 20_000]);
      input = toolInput(res, PICK_TOOL.name);
    } catch (err) {
      console.warn(`[gl] the assistant couldn't rank ${traceId} (${describeAiFailure(err).reason}); the rules' proposals stand`);
      setState(traceId, "failed");
      return;
    }
    if (!input || !Array.isArray(input.picks)) { setState(traceId, "failed"); return; }
    // Whole accounts expand in code to that account's entries for the year.
    const wanted = (Array.isArray(input.wholeAccounts) ? input.wholeAccounts : [])
      .map((w) => list.accounts.find((a) => a.ref === String((w as { ref?: unknown })?.ref ?? "")))
      .filter((a): a is Shortlist["accounts"][number] => !!a);
    const accountRows = new Map<string, GlTransaction[]>();
    for (const a of wanted) accountRows.set(`${a.fiscalYear}|${a.accountKey}`, await store.accountRows(dealId, sellerLedgers, a.fiscalYear, [a.accountKey]));
    const added = await withGlLock(dealId, async () => {
      // Re-read under the lock: a tick made while the assistant was thinking wins.
      const now = await store.linksOfTrace(traceId);
      const skip = new Set(now.filter((k) => k.ledgerId).map(entryKey));
      const rows = picksToProposals(input, list, accountRows, t, skip);
      if (rows.length) await store.replaceProposals(traceId, [], rows);
      await recomputeTraces(dealId, [traceId]);
      return rows.length;
    });
    setState(traceId, "done", added);
  } catch (err) {
    console.warn(`[gl] the assistant's ranking for ${traceId} failed:`, (err as Error).message);
    setState(traceId, "failed");
  }
};

setGlRanker(rankWithAi);
