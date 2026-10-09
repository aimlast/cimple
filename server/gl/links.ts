/**
 * links.ts — ticking and unticking ledger entries for an add-back, by the
 * seller or the broker (gl spec §9.4). Every entry is resolved against the
 * deal's own READY ledger (seller-visible only, for a seller), and must sit
 * in one of the add-back's claimed fiscal years — else the whole request is
 * refused (400) and nothing is written. The snapshot (date, account, name,
 * memo, amount) is copied from the stored entry, never from the request.
 * Each write is one upsert (no lock); the add-back's numbers follow.
 */
import type { GlAddbackTrace, GlTraceLink } from "@shared/schema";
import { claimedYears } from "@shared/gl-reconcile";
import { glStore } from "./store";
import type { GlDealContext } from "./context";
import { recomputeTraces } from "./match-run";

export interface EntryRef { ledgerId: string; rowNo: number }
export interface LinkWrite { fy?: string; add?: EntryRef[]; remove?: EntryRef[]; reject?: EntryRef[] }

export const MAX_LINK_ITEMS = 500;

/** The request's entries, or a plain error (pure). */
export function parseLinkWrite(body: unknown): LinkWrite | { error: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const list = (v: unknown): EntryRef[] | null => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) return null;
    const out: EntryRef[] = [];
    for (const x of v) {
      const ledgerId = typeof (x as any)?.ledgerId === "string" ? (x as any).ledgerId : "";
      const rowNo = Number((x as any)?.rowNo);
      if (!ledgerId || ledgerId.length > 64 || !Number.isInteger(rowNo) || rowNo < 1) return null;
      out.push({ ledgerId, rowNo });
    }
    return out;
  };
  const add = list(b.add), remove = list(b.remove), reject = list(b.reject);
  if (!add || !remove || !reject) return { error: "Those entries couldn't be read — reload and try again." };
  if (add.length + remove.length + reject.length === 0) return { error: "Nothing to change" };
  if (add.length + remove.length + reject.length > MAX_LINK_ITEMS) return { error: "Too many entries at once — tick fewer and try again." };
  const fy = typeof b.fy === "string" && /^\d{4}$/.test(b.fy) ? b.fy : undefined;
  return { fy, add, remove, reject };
}

export type LinkWriteResult = { ok: true; links: GlTraceLink[] } | { ok: false; status: 400 | 404; error: string };

/** Ticks (add), unticks (remove) and "not part of it" (reject) for one add-back. */
export async function writeLinks(
  trace: GlAddbackTrace,
  w: LinkWrite,
  who: { by: "seller" | "broker"; memberId: string | null },
  c: GlDealContext,
): Promise<LinkWriteResult> {
  const store = glStore();
  const all = [...(w.add ?? []), ...(w.remove ?? []), ...(w.reject ?? [])];
  const rows = await store.rowsForKeys(c.dealId, all);
  const byKey = new Map(rows.map((r) => [`${r.ledgerId}:${r.rowNo}`, r]));
  const allowedLedgers = who.by === "seller" ? c.sellerLedgerIds : c.readyIds;
  const years = new Set(claimedYears({ claims: (trace.claims as Record<string, number>) ?? {} }));
  for (const ref of all) {
    const row = byKey.get(`${ref.ledgerId}:${ref.rowNo}`);
    if (!row || row.dealId !== c.dealId || !allowedLedgers.has(row.ledgerId)) return { ok: false, status: 400, error: "One of those entries isn't in a ledger you can use here." };
    if (!years.has(row.fiscalYear)) return { ok: false, status: 400, error: `That entry is in ${row.fiscalYear}, which isn't one of the years for this cost.` };
  }
  const at = new Date();
  const decide = async (ref: EntryRef, state: "confirmed" | "rejected") => {
    const r = byKey.get(`${ref.ledgerId}:${ref.rowNo}`)!;
    await store.decideEntryLink({
      traceId: trace.id, dealId: c.dealId, fiscalYear: r.fiscalYear, ledgerId: r.ledgerId, rowNo: r.rowNo,
      txnDate: r.txnDate, account: r.account, name: r.name, memo: r.memo, amountCents: r.amountCents,
      state, proposedBy: who.by === "seller" ? "seller_search" : "broker",
      decidedBy: who.by, decidedByMember: who.memberId, decidedAt: at,
    } as any);
  };
  for (const ref of w.add ?? []) await decide(ref, "confirmed");
  for (const ref of w.reject ?? []) await decide(ref, "rejected");
  for (const ref of w.remove ?? []) await store.removeEntryLink(trace.id, ref.ledgerId, ref.rowNo);
  if (who.by === "seller" && trace.sellerStatus === "not_started") await store.updateTrace(trace.id, { sellerStatus: "in_progress" } as Partial<GlAddbackTrace>);
  await recomputeTraces(c.dealId, [trace.id], c);
  return { ok: true, links: await store.linksOfTrace(trace.id) };
}

/** "Yes, that's right": every high-confidence proposed entry of the cost, every claimed year, confirmed in one go. */
export async function confirmSummary(trace: GlAddbackTrace, who: { by: "seller" | "broker"; memberId: string | null }, c: GlDealContext): Promise<number> {
  const store = glStore();
  const allowed = who.by === "seller" ? c.sellerLedgerIds : c.readyIds;
  const left = (trace.leftOut as { years?: string[] } | null)?.years ?? [];
  const props = (await store.linksOfTrace(trace.id)).filter((k) => k.state === "proposed" && k.confidence === "high" && k.ledgerId && allowed.has(k.ledgerId) && !left.includes(k.fiscalYear));
  const at = new Date();
  for (const k of props) {
    await store.decideEntryLink({
      traceId: trace.id, dealId: c.dealId, fiscalYear: k.fiscalYear, ledgerId: k.ledgerId!, rowNo: k.rowNo!,
      txnDate: k.txnDate, account: k.account, name: k.name, memo: k.memo, amountCents: k.amountCents,
      state: "confirmed", proposedBy: k.proposedBy, confidence: k.confidence, reason: k.reason,
      decidedBy: who.by, decidedByMember: who.memberId, decidedAt: at,
    } as any);
  }
  if (who.by === "seller") await store.updateTrace(trace.id, { sellerStatus: "done", reopenedNote: null, notInLedger: null } as Partial<GlAddbackTrace>);
  await recomputeTraces(c.dealId, [trace.id], c);
  return props.length;
}
