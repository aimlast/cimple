/**
 * task-writes — what an interview turn does to the deal's task list.
 *
 * Every aiResponse.newTasks item used to be inserted as-is, every turn:
 * Ridgeline ended with 28 task rows for 4 follow-ups, a request for the
 * Comfort Club report was created although the report was on file, tasks
 * never closed (a "get the change-of-control clause" task survived the
 * seller saying there is no such clause), and a document the seller offered
 * ("want me to have Morgan send the template agreement?") became a remark
 * instead of an upload request. This module plans the writes; the session
 * manager applies them. Pure.
 */
import type { Task, Document } from "@shared/schema";
import type { InterviewResponse } from "./response-schema";
import { stemsOf } from "./source-context";
import { topicsMatch } from "./deferral-ledger";

type NewTask = InterviewResponse["newTasks"][number];
type TaskLike = Pick<Task, "id" | "type" | "title" | "description" | "relatedField" | "status"> & Partial<Pick<Task, "createdBy" | "createdAt">>;
type DocLike = Pick<Document, "id" | "name" | "visibility"> & Partial<Pick<Document, "category" | "subcategory" | "isProcessed" | "status" | "sourceKind">>;

export interface TaskPlan {
  create: NewTask[];
  /** Existing pending tasks refreshed instead of duplicated. */
  update: { id: string; description: string }[];
  /** Existing tasks now done (answered, resolved by the agent, or the requested document arrived). */
  close: string[];
  /** Exact duplicates of another open interview task (earlier turns re-created them) — removed. */
  remove: string[];
  /** Document requests dropped because the document is already on file (task title → document name). */
  dropped: { title: string; documentName: string }[];
}

const open = (t: TaskLike) => t.status === "pending" || t.status === "in_progress";

/** Stem overlap measured on the smaller side (0..1). */
function similarity(a: string, b: string): number {
  const x = stemsOf(a);
  const y = stemsOf(b);
  if (x.size === 0 || y.size === 0) return 0;
  let n = 0;
  x.forEach((w) => { if (y.has(w)) n++; });
  return n / Math.min(x.size, y.size);
}

/** Words a request title adds that say nothing about which document it is. */
const REQUEST_NOISE = /\b(get|obtain|request|upload|send|provide|copy|copies|of|the|a|an|latest|current|full|seller'?s?|please|document|documents|file|files|over|from|for|to)\b/gi;

/** A processed, seller-visible document the request asks for, if any. */
export function documentOnFileFor(title: string, documents: DocLike[]): DocLike | null {
  const wanted = title.replace(REQUEST_NOISE, " ").replace(/\s+/g, " ").trim();
  const w = stemsOf(wanted);
  if (w.size === 0) return null;
  for (const d of documents) {
    if (d.visibility === "broker_only") continue;
    if (d.isProcessed === false && d.status !== "processed") continue;
    const n = stemsOf(d.name);
    let shared = 0;
    w.forEach((x) => { if (n.has(x)) shared++; });
    // Most of what the request names is in the document's name.
    if (shared >= 2 && shared / w.size >= 0.6) return d;
    if (w.size === 1 && shared === 1 && n.size <= 3) return d;
  }
  return null;
}

/**
 * The seller offering to send a document: "can I have Morgan send over the
 * template agreement?", "I'll email you the tooling spreadsheet". Returns
 * what was offered, or null.
 */
const DOCUMENT_NOUN_RE =
  /\b(list|report|spreadsheet|workbook|agreement|contract|statements?|file|schedule|copy|copies|document|letter|policy|roster|sheet|returns?|summary|invoices?|pdf|lease|plan|chart|deck|photos?|records|manifests?|certificates?|register|breakdown|export|minutes|bylaws|appraisal|quote|budget|forecast|p&l)\b/i;

export function detectDocumentOffer(sellerMessage: string): string | null {
  const m = sellerMessage.match(
    /\b(?:(?:can|could|shall|should)\s+(?:i|we)|(?:i|we)\s*(?:'ll|will|can|could)|want\s+me\s+to|happy\s+to|let\s+me)\s+(?:have\s+\w+\s+)?(?:send|upload|email|e-mail|pull|forward|dig\s+up|share|get\s+you)\s+(?:you\s+|over\s+|along\s+|it\s+)?(?:a\s+copy\s+of\s+)?((?:the|our|my|a|an|his|her|their)\s+[^.?!,;]{3,80})/i,
  );
  if (!m) return null;
  const what = m[1].replace(/\s+(?:over|along|to you|across|if (?:you|that)[^.?!]*|so you[^.?!]*|for you)$/i, "").trim();
  // Only a document is an upload ("the exact audit date from Mark" is an answer to follow up, not a file).
  if (!DOCUMENT_NOUN_RE.test(what)) return null;
  return what.length >= 3 ? what : null;
}

export function planTaskWrites(args: {
  newTasks: NewTask[];
  existing: TaskLike[];
  documents: DocLike[];
  /** Fact keys the seller answered THIS turn. */
  answeredKeys: ReadonlySet<string>;
  /** Topics the agent marked resolved this turn. */
  resolvedTopics: string[];
  sellerMessage: string;
}): TaskPlan {
  const plan: TaskPlan = { create: [], update: [], close: [], dropped: [], remove: [] };
  let pending = args.existing.filter(open);

  // Exact duplicates the interview created on earlier turns (same type and
  // title): keep the oldest, remove the rest.
  const seen = new Map<string, TaskLike>();
  const byAge = [...pending].sort((a, b) => new Date(String(a.createdAt ?? 0)).getTime() - new Date(String(b.createdAt ?? 0)).getTime());
  for (const t of byAge) {
    const k = `${t.type}|${t.title.trim().toLowerCase()}`;
    if (seen.has(k) && t.createdBy === "ai_interview" && seen.get(k)!.createdBy === "ai_interview") plan.remove.push(t.id);
    else if (!seen.has(k)) seen.set(k, t);
  }
  pending = pending.filter((t) => !plan.remove.includes(t.id));

  // Close: a follow-up whose field the seller answered this turn, anything
  // the agent resolved, or a document request whose document is now on file.
  // (A request stays open when only the field has a value — the document
  // itself hasn't arrived.)
  for (const t of pending) {
    const answered = t.type !== "document_request" && !!t.relatedField && args.answeredKeys.has(t.relatedField);
    const resolved = args.resolvedTopics.some((r) => r && (topicsMatch(r, t.title) || similarity(r, t.title) >= 0.8));
    const delivered = t.type === "document_request" && !!documentOnFileFor(t.title, args.documents);
    if (answered || resolved || delivered) plan.close.push(t.id);
  }
  const stillOpen = pending.filter((t) => !plan.close.includes(t.id));

  const consider = [...args.newTasks];
  // The seller offered a document and the agent created no request for it.
  const offered = detectDocumentOffer(args.sellerMessage);
  if (offered && !consider.some((t) => t.type === "document_request")) {
    consider.push({
      type: "document_request",
      title: `Upload ${offered.replace(/^(?:the|our|my|a|an|his|her|their)\s+/i, "the ")}`,
      description: `The seller offered to send this in the interview: "${args.sellerMessage.replace(/\s+/g, " ").slice(0, 200)}"`,
      relatedField: "",
      sellerExplanation: "You offered to send this — upload it on your documents page (or email it to your broker) when you have a moment.",
    });
  }

  for (const t of consider) {
    if (!t.title?.trim()) continue;
    if (t.type === "document_request") {
      const doc = documentOnFileFor(t.title, args.documents);
      if (doc) { plan.dropped.push({ title: t.title, documentName: doc.name }); continue; }
    }
    const dup = [...stillOpen, ...plan.create.map((c, i) => ({ ...c, id: `new:${i}`, status: "pending" }) as unknown as TaskLike)].find(
      (e) => e.type === t.type && ((!!t.relatedField && e.relatedField === t.relatedField) || similarity(e.title, t.title) >= 0.6),
    );
    if (dup) {
      if (!dup.id.startsWith("new:") && t.description && t.description !== dup.description) plan.update.push({ id: dup.id, description: t.description });
      continue;
    }
    plan.create.push(t);
  }
  return plan;
}
