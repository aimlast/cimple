/**
 * Starts (or joins) the on-file evidence build for a deal from anywhere —
 * the broker's Overview, the end of an interview session — loading what the
 * interview's knowledge base is built from. See on-file-evidence.ts.
 */
import { db } from "../db";
import { storage } from "../storage";
import { interviewSessions } from "@shared/schema";
import { eq } from "drizzle-orm";
import { assembleKnowledgeBase } from "./knowledge-base";
import { ensureOnFileEvidence, isEvidenceBuilding, type OnFileEvidence } from "./on-file-evidence";

const lastLook = new Map<string, number>();

/**
 * `currentSessionId`: the session in progress (its answers are left out of
 * the evidence); omitted → the deal's live session if there is one; null →
 * every session counts (a session that just ended).
 */
export async function refreshOnFileEvidence(
  dealId: string,
  opts: { currentSessionId?: string | null } = {},
): Promise<OnFileEvidence | null> {
  const started = await startOnFileEvidenceBuild(dealId, opts);
  return started ? started.run : null;
}

/**
 * Starts (or joins) the build and returns at once: `{ run }` holding the
 * running build's promise (wrapped — an async function returning a promise
 * would wait for the build), or null when the evidence is current (or the
 * deal was looked at moments ago). The broker's outline uses it to say that
 * the "on file" count is about to change, rather than having it shift
 * unexplained.
 */
export async function startOnFileEvidenceBuild(
  dealId: string,
  opts: { currentSessionId?: string | null } = {},
): Promise<{ run: Promise<OnFileEvidence | null> } | null> {
  // The Overview polls while a checklist builds: look at most every 20s
  // (a session that just ended always looks).
  const now = Date.now();
  if (opts.currentSessionId !== null && now - (lastLook.get(dealId) ?? 0) < 20_000) return null;
  lastLook.set(dealId, now);
  if (lastLook.size > 2000) lastLook.clear();
  const deal = await storage.getDeal(dealId);
  if (!deal) return null;
  const [documents, tasks, resolved, all] = await Promise.all([
    storage.getDocumentsByDeal(dealId),
    storage.getTasksByDeal(dealId),
    storage.getResolvedDiscrepancies(dealId),
    storage.getDiscrepanciesByDeal(dealId),
  ]);
  const sessions = await db.select().from(interviewSessions).where(eq(interviewSessions.dealId, dealId));
  const currentSessionId =
    opts.currentSessionId !== undefined
      ? opts.currentSessionId
      : (sessions.find((s) => s.status === "active" || s.status === "paused")?.id ?? null);
  const kb = assembleKnowledgeBase(deal, documents, tasks, null, resolved, {
    sessions,
    currentSessionId,
    openDiscrepancies: all.filter((d) => d.status === "open"),
  });
  const run = ensureOnFileEvidence(deal, {
    documents,
    sessions,
    currentSessionId,
    view: kb.extractedInfo as Record<string, unknown>,
    targets: kb.evidenceTargets ?? [],
  });
  run?.catch(() => {});
  return run ? { run } : null;
}

/** True while the deal's evidence build is running (see startOnFileEvidenceBuild). */
export { isEvidenceBuilding };
