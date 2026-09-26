/**
 * stream-head — reads the seller-facing "head" of an interview response
 * while the model is still writing the rest of it.
 *
 * The interview tool's fields come in schema order: the message, then what
 * the seller sees beside it (why we ask, importance, section, answer chips),
 * the end decision (shouldEnd, endReason — see endSoFar), then the long
 * bookkeeping tail — extracted facts, reasoning, industry context, tasks —
 * which is ~2.5–5K characters and 12–25s of Opus output. Everything the
 * seller needs to answer is in the head, so:
 *   - a streamed turn can unlock the seller's answer (chips included) as soon
 *     as the head is complete, while the tail is still being generated;
 *   - a corrective rewrite that only changes the wording (the output guards,
 *     the re-ask guard's re-call, an opening rewrite) can stop the model once
 *     the head is complete — its tail would be thrown away anyway.
 * Pure (no I/O).
 */

import type { InterviewResponse } from "./response-schema";

export const HEAD_KEYS =["message", "whyItMatters", "importance", "targetSection", "suggestedAnswers"] as const;
/** The model's end decision — right after the head in the schema (endSoFar). */
export const END_KEYS = ["shouldEnd", "endReason"] as const;

export interface StreamHead {
  message?: string;
  whyItMatters?: string;
  importance?: string;
  targetSection?: string;
  suggestedAnswers?: string[];
}

const isWs = (c: string | undefined) => c === " " || c === "\n" || c === "\r" || c === "\t";

/** End index (exclusive) of the JSON string starting at `i` (a quote), or -1 when it hasn't closed yet. */
function stringEnd(buf: string, i: number): number {
  let j = i + 1;
  while (j < buf.length) {
    const c = buf[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === '"') return j + 1;
    j++;
  }
  return -1;
}

/** End index (exclusive) of the object/array starting at `i`, or -1 when it hasn't closed yet. */
function nestedEnd(buf: string, i: number): number {
  let depth = 0;
  let j = i;
  while (j < buf.length) {
    const c = buf[j];
    if (c === '"') {
      const e = stringEnd(buf, j);
      if (e < 0) return -1;
      j = e;
      continue;
    }
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return j + 1;
    }
    j++;
  }
  return -1;
}

/**
 * The complete top-level entries of a partial JSON object, in order, and the
 * key whose value is still being written (null when between entries).
 * A scalar at the very end of the buffer is never taken as complete ("tru"
 * could still become "true") — only once a "," or "}" follows it.
 */
export function topLevelEntries(buf: string): { entries: Array<[string, unknown]>; open: string | null } {
  const entries: Array<[string, unknown]> = [];
  let i = 0;
  while (isWs(buf[i])) i++;
  if (buf[i] !== "{") return { entries, open: null };
  i++;
  for (;;) {
    while (isWs(buf[i]) || buf[i] === ",") i++;
    if (i >= buf.length || buf[i] === "}") return { entries, open: null };
    if (buf[i] !== '"') return { entries, open: null };
    const keyEnd = stringEnd(buf, i);
    if (keyEnd < 0) return { entries, open: null };
    let key: string;
    try {
      key = JSON.parse(buf.slice(i, keyEnd));
    } catch {
      return { entries, open: null };
    }
    i = keyEnd;
    while (isWs(buf[i])) i++;
    if (buf[i] !== ":") return { entries, open: i >= buf.length ? key : null };
    i++;
    while (isWs(buf[i])) i++;
    if (i >= buf.length) return { entries, open: key };
    const start = i;
    let end: number;
    const c = buf[i];
    if (c === '"') end = stringEnd(buf, i);
    else if (c === "{" || c === "[") end = nestedEnd(buf, i);
    else {
      let j = i;
      while (j < buf.length && buf[j] !== "," && buf[j] !== "}") j++;
      end = j < buf.length ? j : -1;
    }
    if (end < 0) return { entries, open: key };
    try {
      entries.push([key, JSON.parse(buf.slice(start, end))]);
    } catch {
      return { entries, open: key };
    }
    i = end;
  }
}

/**
 * The head of a partial interview response and whether it is complete: the
 * chips have closed, or the model has moved past the head (a later field has
 * started) — either way, nothing more of the head is coming. Needs the
 * message.
 */
export function headSoFar(buf: string): { head: StreamHead; complete: boolean } {
  const { entries, open } = topLevelEntries(buf);
  const head: StreamHead = {};
  // (The end decision sits beside the head in the schema — written before
  // the chips, it doesn't mean the head is over.)
  const beside = (k: string) => (HEAD_KEYS as readonly string[]).includes(k) || (END_KEYS as readonly string[]).includes(k);
  let pastHead = open !== null && !beside(open);
  for (const [k, v] of entries) {
    if (k === "message" && typeof v === "string") head.message = v;
    else if (k === "whyItMatters" && typeof v === "string") head.whyItMatters = v;
    else if (k === "importance" && typeof v === "string") head.importance = v;
    else if (k === "targetSection" && typeof v === "string") head.targetSection = v;
    else if (k === "suggestedAnswers" && Array.isArray(v)) head.suggestedAnswers = v.filter((s): s is string => typeof s === "string");
    else if (!beside(k)) pastHead = true;
  }
  const complete = head.message !== undefined && (head.suggestedAnswers !== undefined || pastHead);
  return { head, complete };
}

/**
 * The model's end decision, once it is in the stream: shouldEnd, and the
 * endReason when it follows. The schema puts both right after the chips
 * (response-schema.ts), so a goodbye's decision is known seconds after its
 * text instead of after the ~5K-character tail. `known` only once nothing
 * more of the decision is coming: shouldEnd is false, or its endReason has
 * closed, or the model has moved on to another field. A model that writes
 * shouldEnd last simply makes it known late. Pure.
 */
export function endSoFar(buf: string): { known: boolean; shouldEnd?: boolean; endReason?: string } {
  const { entries, open } = topLevelEntries(buf);
  const at = entries.findIndex(([k]) => k === "shouldEnd");
  if (at < 0 || typeof entries[at][1] !== "boolean") return { known: false };
  const shouldEnd = entries[at][1] as boolean;
  const reason = entries.find(([k]) => k === "endReason");
  const endReason = reason && typeof reason[1] === "string" ? (reason[1] as string) : undefined;
  if (!shouldEnd || endReason !== undefined) return { known: true, shouldEnd, endReason };
  const movedOn = entries.slice(at + 1).some(([k]) => k !== "endReason") || (open !== null && open !== "endReason");
  return movedOn ? { known: true, shouldEnd, endReason } : { known: false };
}

/**
 * A draft with a head-only rewrite's wording: the rewrite's message, why we
 * ask, importance, section and chips; everything else — what the turn
 * recorded, withdrew, kept private, deferred or tasked, and shouldEnd — is
 * the draft's (a wording rewrite never changes what the seller said).
 */
export function withRewrittenHead(draft: InterviewResponse, rewrite: InterviewResponse): InterviewResponse {
  return {
    ...draft,
    message: rewrite.message,
    whyItMatters: rewrite.whyItMatters,
    importance: rewrite.importance,
    targetSection: rewrite.targetSection,
    suggestedAnswers: rewrite.suggestedAnswers,
  };
}
