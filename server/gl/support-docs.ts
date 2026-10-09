/**
 * support-docs.ts — the T4s, payroll summaries and invoices a seller
 * uploads for an add-back (documents.subcategory "addback_support",
 * source_meta.glTraceId). The file is read by the normal document reader;
 * when that finishes, the typed amount is looked for in its text (§6.8) and
 * the add-back's year follows. Deleting the document removes its links.
 */
import { storage } from "../storage";
import type { GlAddbackTrace } from "@shared/schema";
import { glStore } from "./store";
import { amountAppearsIn } from "./doc-check";
import { recomputeTraces } from "./match-run";

/** INTEGRATION §2.17 `finally` step 1: a support document was read — check the amounts typed against it. Never throws. */
export async function onGlSupportDocumentRead(documentId: string): Promise<void> {
  try {
    const doc = await storage.getDocument(documentId);
    if (!doc || doc.subcategory !== "addback_support") return;
    const store = glStore();
    const links = (await store.linksOfDeal(doc.dealId)).filter((k) => k.documentId === documentId);
    if (links.length === 0) return;
    const scanned = doc.status === "failed" && !(doc.extractedText ?? "").trim();
    for (const k of links) {
      const check = scanned ? "unreadable" : amountAppearsIn(doc.extractedText, Number(k.amountCents));
      if (check !== k.docAmountCheck) await store.updateLink(k.id, { docAmountCheck: check });
    }
    await recomputeTraces(doc.dealId, Array.from(new Set(links.map((k) => k.traceId))));
  } catch (err) {
    console.warn(`[gl] checking the amounts on support document ${documentId} failed:`, err);
  }
}

/** INTEGRATION §2.17 delete step 2: a support document was deleted — its links go, the add-backs follow. Never throws. */
export async function onGlSupportDocumentDeleted(doc: { id: string; dealId: string }): Promise<void> {
  try {
    const store = glStore();
    const traceIds = Array.from(new Set((await store.linksOfDeal(doc.dealId)).filter((k) => k.documentId === doc.id).map((k) => k.traceId)));
    await store.deleteDocLinks({ documentId: doc.id });
    if (traceIds.length) await recomputeTraces(doc.dealId, traceIds);
  } catch (err) {
    console.warn(`[gl] removing support document ${doc.id}'s links failed:`, err);
  }
}

/** The years and typed amounts of a support upload (pure): { "2024": "240,000" } → cents, only the add-back's claimed years. */
export function parseSupportAmounts(trace: Pick<GlAddbackTrace, "claims">, years: unknown, amounts: unknown): { years: Array<{ year: string; cents: number }> } | { error: string } {
  const claimed = new Set(Object.keys((trace.claims as Record<string, number>) ?? {}));
  const ys = Array.isArray(years) ? years.map(String) : typeof years === "string" ? years.split(",").map((s) => s.trim()) : [];
  let am: Record<string, unknown> = {};
  if (typeof amounts === "string") {
    try { am = JSON.parse(amounts); } catch { return { error: "Type the amount for each year." }; }
  } else if (amounts && typeof amounts === "object") am = amounts as Record<string, unknown>;
  const out: Array<{ year: string; cents: number }> = [];
  for (const y of Array.from(new Set(ys)).slice(0, 10)) {
    if (!/^\d{4}$/.test(y) || !claimed.has(y)) return { error: `Pick one of the years your broker asked about.` };
    const raw = String(am[y] ?? "").replace(/[$,\s]/g, "");
    const n = Number(raw);
    if (!raw || !Number.isFinite(n) || n <= 0 || n > 100_000_000) return { error: `Type the amount on the document for ${y}.` };
    out.push({ year: y, cents: Math.round(n * 100) });
  }
  if (out.length === 0) return { error: "Which year is this document for?" };
  return { years: out };
}
