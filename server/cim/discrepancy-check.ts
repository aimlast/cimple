/**
 * Running the verification check and remembering what it ran against.
 *
 * The check used to be manual only ("Run Verification Check"), and the CIM
 * gate blocked only on rows that already existed — so a deal nobody checked
 * had no rows and generated straight from unverified claims (Harborview).
 * Now every run stamps the deal with when it ran and a fingerprint of the
 * sources it compared (deals.discrepancyCheckedAt / discrepancyCheckSources).
 * A full CIM generation runs the check first whenever it is missing or
 * stale, and stops at the normal gate when a critical conflict appears.
 *
 * Fingerprint = the shared documents it compared + a hash of the seller-side
 * claims (interview, calls, emails, questionnaire). A new document or a new
 * or changed seller answer makes the check stale; a broker edit doesn't.
 */
import { createHash } from "crypto";
import { storage, type IStorage } from "../storage";
import type { Deal, Discrepancy } from "@shared/schema";
import {
  runDiscrepancyCheck,
  isSameDiscrepancy,
  buildDiscrepancyInput,
  isEvidenceDocument,
  type CheckDocument,
} from "./discrepancy-engine";
import { dropReason } from "./discrepancy-filter";
import { settleMergeRowsQuietly } from "../documents/merge-conflicts";

type DocRow = CheckDocument & { isProcessed?: boolean | null };

function processedDocs<T extends DocRow>(docs: T[]): T[] {
  return docs.filter((d) => d.isProcessed && (d.extractedText || d.extractedData));
}

export interface CheckFingerprint {
  v: 1;
  docs: string[];
  claims: string;
}

/** What the check compares, as a stable fingerprint. Pure. */
export function checkFingerprint(info: Record<string, unknown>, documents: DocRow[]): CheckFingerprint {
  const docs = processedDocs(documents).filter(isEvidenceDocument).map((d) => d.id).sort();
  const input = buildDiscrepancyInput(info, processedDocs(documents));
  const claimRefs = new Set(input.refs.filter((r) => r.cls === "claim" || r.cls === "private").map((r) => r.ref));
  const lines = new Set<string>();
  for (const e of [...input.claims, ...input.privateClaims]) lines.add(`${e.key}${e.year ? `.${e.year}` : ""}=${e.value.toLowerCase().replace(/\s+/g, " ")}`);
  // Losing seller-side values are claims too (a call figure a broker later corrected is still what the seller said).
  for (const c of input.candidates) if (claimRefs.has(c.claim.ref)) lines.add(`${c.factKey}${c.factYear ? `.${c.factYear}` : ""}=${c.claim.value.toLowerCase().replace(/\s+/g, " ")}`);
  const claims = createHash("sha1").update(Array.from(lines).sort().join("\n")).digest("hex").slice(0, 16);
  return { v: 1, docs, claims };
}

function parseFingerprint(raw: string | null | undefined): CheckFingerprint | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw);
    return p && p.v === 1 && Array.isArray(p.docs) && typeof p.claims === "string" ? p : null;
  } catch {
    return null;
  }
}

export interface DiscrepancyCheckStatus {
  /** There are shared documents to compare against. */
  canRun: boolean;
  checkedAt: string | null;
  /** Never run, or the sources changed since. */
  stale: boolean;
  /** Documents added since the last run. */
  newSources: number;
  /** The seller said something new (or changed an answer) since the last run. */
  claimsChanged: boolean;
}

/** Pure: compare the deal's current sources with the fingerprint of the last run. */
export function computeCheckStatus(
  deal: Pick<Deal, "extractedInfo" | "discrepancyCheckedAt" | "discrepancyCheckSources">,
  documents: DocRow[],
): DiscrepancyCheckStatus {
  const now = checkFingerprint((deal.extractedInfo as Record<string, unknown>) || {}, documents);
  const canRun = now.docs.length > 0;
  const prev = parseFingerprint(deal.discrepancyCheckSources);
  const checkedAt = deal.discrepancyCheckedAt ? new Date(deal.discrepancyCheckedAt).toISOString() : null;
  if (!prev || !checkedAt) return { canRun, checkedAt, stale: canRun, newSources: now.docs.length, claimsChanged: false };
  const before = new Set(prev.docs);
  const newSources = now.docs.filter((id) => !before.has(id)).length;
  const claimsChanged = prev.claims !== now.claims;
  return { canRun, checkedAt, stale: canRun && (newSources > 0 || claimsChanged), newSources, claimsChanged };
}

export async function getDiscrepancyCheckStatus(dealId: string): Promise<DiscrepancyCheckStatus | null> {
  const deal = await storage.getDeal(dealId);
  if (!deal) return null;
  return computeCheckStatus(deal, await storage.getDocumentsByDeal(dealId));
}

export interface CheckRunResult {
  count: number;
  refreshed: number;
  cleared: number;
  dropped: number;
  created: Discrepancy[];
}

const running = new Map<string, Promise<CheckRunResult>>();

/**
 * Run the check for a deal and write its findings: new conflicts become rows
 * (with factKey / factYear / sideSources), open rows it re-found are
 * refreshed in place, open rows it cleared — or that were never conflicts
 * (equal values, a missing document) — are superseded, settled rows are
 * never re-raised. Stamps the deal. One run per deal at a time.
 */
export function runAndPersistDiscrepancyCheck(dealId: string): Promise<CheckRunResult> {
  const inflight = running.get(dealId);
  if (inflight) return inflight;
  const task = (async () => {
    const deal = await storage.getDeal(dealId);
    if (!deal) throw new Error("Deal not found");
    const allDocs = await storage.getDocumentsByDeal(dealId);
    const docs = processedDocs(allDocs);
    const fingerprint = checkFingerprint((deal.extractedInfo as Record<string, unknown>) || {}, allDocs);
    if (fingerprint.docs.length === 0) {
      throw Object.assign(new Error("No processed documents to cross-reference. Upload and process documents first."), { status: 400 });
    }

    // Merge rows that no longer stand go first, so the check never refreshes or matches them.
    await settleMergeRowsQuietly(dealId, "discrepancy-check");
    const existing = (await storage.getDiscrepanciesByDeal(dealId)).filter((d) => d.status !== "superseded");
    const { items, clearedIds, dropped } = await runDiscrepancyCheck(
      {
        id: dealId,
        businessName: deal.businessName,
        industry: deal.industry,
        extractedInfo: (deal.extractedInfo as Record<string, any>) || {},
        questionnaireData: deal.questionnaireData as Record<string, any> | null,
      },
      docs.map((d) => ({
        id: d.id,
        name: d.name,
        category: d.category,
        extractedText: d.extractedText,
        extractedData: d.extractedData,
        sourceKind: d.sourceKind,
        visibility: d.visibility,
      })),
      existing,
    );

    const settled = existing.filter((d) => d.status === "resolved" || d.status === "accepted");
    const unsettled = existing.filter((d) => d.status !== "resolved" && d.status !== "accepted");
    const touched = new Set<string>();
    const created: Discrepancy[] = [];
    let refreshed = 0;
    for (const item of items) {
      const referenced = item.existingId ? existing.find((d) => d.id === item.existingId) : undefined;
      if ((referenced && settled.includes(referenced)) || settled.some((d) => isSameDiscrepancy(item, d))) continue;
      const openMatch = referenced && unsettled.includes(referenced)
        ? referenced
        : unsettled.find((d) => !touched.has(d.id) && isSameDiscrepancy(item, d));
      const values = {
        interviewValue: item.interviewValue,
        documentValue: item.documentValue,
        documentId: item.documentId || null,
        documentName: item.documentName || null,
        severity: item.severity,
        category: item.category,
        aiExplanation: item.aiExplanation,
        suggestedResolution: item.suggestedResolution,
        factKey: item.factKey,
        factYear: item.factYear,
        sideSources: item.sideSources as any,
      };
      if (openMatch) {
        touched.add(openMatch.id);
        // Rows raised by the fact merge or the financial analysis are theirs
        // to rewrite; a verification row keeps the broker's routing/status and
        // its original field name and gets fresh evidence.
        if (openMatch.source === "interview" || !openMatch.source) {
          await storage.updateDiscrepancy(openMatch.id, {
            ...values,
            // Keep a fact key the broker already linked.
            factKey: openMatch.factKey || values.factKey,
            factYear: openMatch.factKey ? openMatch.factYear : values.factYear,
          });
          refreshed++;
        }
        continue;
      }
      const disc = await storage.createDiscrepancy({ dealId, field: item.field, ...values, source: "interview", status: "open" });
      created.push(disc);
    }

    // Open rows the model found consistent, and this check's own open rows
    // that were never conflicts (equal values, a missing document — raised
    // before the filter existed). Rows the broker routed to the seller stay
    // with the seller; the merge's rows are its own to settle.
    let cleared = 0;
    const toClear = new Set(clearedIds);
    for (const row of unsettled) {
      if (row.status === "open" && (row.source === "interview" || !row.source) && dropReason(row) !== null) toClear.add(row.id);
    }
    for (const id of Array.from(toClear)) {
      const row = existing.find((d) => d.id === id);
      if (!row || touched.has(id) || (row.status !== "open" && row.status !== "seller_responded")) continue;
      if (row.source === "merge") continue;
      await storage.updateDiscrepancy(id, { status: "superseded" });
      cleared++;
    }

    // One conflict, one row: an open row of this check that the financial
    // analysis or the fact merge also raised gives way to theirs.
    cleared += await supersedeCheckDuplicates(dealId);

    await storage.updateDeal(dealId, {
      discrepancyCheckedAt: new Date(),
      discrepancyCheckSources: JSON.stringify(fingerprint),
    } as any);

    return { count: created.length, refreshed, cleared, dropped, created };
  })().finally(() => running.delete(dealId));
  running.set(dealId, task);
  return task;
}

/**
 * One conflict, one row. The verification check and the financial analysis
 * (or the fact merge) can raise the same conflict under different names —
 * Ridgeline's "westlockProjectStatus" (check) and "Signed backlog (May
 * 2025)" (analysis) were two open criticals for the one $1.1M Westlock
 * award counted in the $4.2M backlog. The other engine's row carries the
 * better fact key and its own lifecycle, so an OPEN check row that matches
 * one of theirs (live or settled — isSameDiscrepancy: fact key, field, or
 * the same two figures and a distinctive word) is superseded. Rows the
 * broker routed to the seller or answered are left alone. Runs after
 * every check and every analysis. Returns how many rows it superseded.
 */
export async function supersedeCheckDuplicates(
  dealId: string,
  store: Pick<IStorage, "getDiscrepanciesByDeal" | "updateDiscrepancy"> = storage,
): Promise<number> {
  const live = (await store.getDiscrepanciesByDeal(dealId)).filter((d) => d.status !== "superseded");
  const others = live.filter((d) => d.source && d.source !== "interview");
  let n = 0;
  for (const own of live) {
    if ((own.source && own.source !== "interview") || own.status !== "open") continue;
    if (!others.some((o) => isSameDiscrepancy(own, o))) continue;
    await store.updateDiscrepancy(own.id, { status: "superseded" });
    n++;
  }
  return n;
}

// ── Gate before a full CIM generation ──

export const BLOCKING_DISCREPANCY_STATUSES = new Set(["open", "seller_responded"]);

export function blockingCritical(rows: Pick<Discrepancy, "severity" | "status">[]): boolean {
  return rows.some((d) => d.severity === "critical" && BLOCKING_DISCREPANCY_STATUSES.has(d.status));
}

export class DiscrepancyGateError extends Error {
  constructor(
    public readonly blocking: Array<{ id: string; field: string }>,
    /** "critical" = must be resolved; "new" = the check just found conflicts the broker hasn't seen. */
    public readonly reason: "critical" | "new" = "critical",
  ) {
    const n = blocking.length;
    const fields = blocking.map((b) => b.field).join(", ");
    super(
      reason === "critical"
        ? `Stopped before writing: ${n} critical discrepanc${n === 1 ? "y" : "ies"} must be resolved first (${fields}).`
        : `Stopped before writing: the check found ${n} new conflict${n === 1 ? "" : "s"} between what the seller said and the documents (${fields}). Review ${n === 1 ? "it" : "them"}, then generate again.`,
    );
    this.name = "DiscrepancyGateError";
  }
}

/** New findings this important stop the run once, so the broker sees them before anything is written. */
const REVIEW_BEFORE_WRITING = new Set(["critical", "significant"]);

/**
 * Before any section is written: run the check when it is missing or stale,
 * then stop if a critical conflict is open — or if this run just found new
 * critical/significant conflicts (shown once; generating again proceeds,
 * since the check is then current and only criticals block). Throws
 * DiscrepancyGateError (stopped) or the check's own error (couldn't verify —
 * never generate from an unverified state).
 */
export async function ensureDiscrepancyGate(
  dealId: string,
  onChecking?: () => void,
): Promise<{ ranCheck: boolean }> {
  const status = await getDiscrepancyCheckStatus(dealId);
  let ranCheck = false;
  let created: Discrepancy[] = [];
  if (status?.canRun && status.stale) {
    onChecking?.();
    try {
      created = (await runAndPersistDiscrepancyCheck(dealId)).created;
    } catch (err: any) {
      throw new Error(`Couldn't check the documents against what the seller said (${err?.message || "unknown error"}). Try again, or run the check from the Discrepancies panel.`);
    }
    ranCheck = true;
  }
  // A merge row whose conflict no longer stands never blocks.
  await settleMergeRowsQuietly(dealId, "discrepancy-gate");
  const rows = await storage.getDiscrepanciesByDeal(dealId);
  const blocking = rows.filter((d) => d.severity === "critical" && BLOCKING_DISCREPANCY_STATUSES.has(d.status));
  if (blocking.length > 0) throw new DiscrepancyGateError(blocking.map((d) => ({ id: d.id, field: d.field })));
  const fresh = created.filter((d) => REVIEW_BEFORE_WRITING.has(d.severity));
  if (fresh.length > 0) throw new DiscrepancyGateError(fresh.map((d) => ({ id: d.id, field: d.field })), "new");
  return { ranCheck };
}
