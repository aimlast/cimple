/**
 * The seller's look-up to-dos after a session together (checker r2 R2-7):
 * when the seller answers a data point aloud and it is filed, the
 * interview's open follow-up for it ("Get gross margin by division from
 * Denise") is done — the same rule the AI interview applies to an answer
 * given in a turn (task-writes.ts planTaskWrites: a follow-up whose field
 * was answered closes; a DOCUMENT request stays open until the document is
 * on file; counsel checks and the broker's own follow-ups are never closed
 * by an answer). The broker's typed notes never close one (the broker's
 * word, not the seller's). Undo of the filing reopens what it closed.
 */
import type { Task } from "@shared/schema";
import { planTaskWrites } from "../interview/task-writes";
import { storage } from "../storage";
import type { FiledRow } from "./capture-apply";

export interface TaskClosed { key: string; taskId: string }

/** Keys a filing answered (spoken / also noted — never typed), with the item's own key (Pure). */
export function answeredKeysOf(filed: Array<Pick<FiledRow, "key" | "itemId" | "kind" | "undoneAt">>, readKeysOf?: (itemId: string) => string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of filed) {
    if (f.undoneAt || f.kind === "typed") continue;
    out.set(f.key, f.key);
    if (f.itemId) {
      const own = f.itemId.split(":")[1];
      if (own && !out.has(own)) out.set(own, f.key);
      for (const k of readKeysOf?.(f.itemId) ?? []) if (!out.has(k)) out.set(k, f.key);
    }
  }
  return out;
}

/**
 * Closes the interview's open follow-ups the filing answered. Returns, per
 * task closed, the filed key that answered it (kept on the part's result —
 * its Undo reopens them). Never throws (a to-do list is never worth a
 * failed filing).
 */
export async function closeAnsweredLookups(dealId: string, filed: FiledRow[], readKeysOf?: (itemId: string) => string[]): Promise<TaskClosed[]> {
  try {
    const answered = answeredKeysOf(filed, readKeysOf);
    if (answered.size === 0) return [];
    const tasks = (await storage.getTasksByDeal(dealId)) as Task[];
    const plan = planTaskWrites({ newTasks: [], existing: tasks, documents: [], answeredKeys: new Set(answered.keys()), resolvedTopics: [], sellerMessage: "" });
    const out: TaskClosed[] = [];
    for (const id of plan.close) {
      const t = tasks.find((x) => x.id === id);
      if (!t?.relatedField || t.type === "document_request") continue;
      await storage.updateTask(id, { status: "completed", completedAt: new Date() } as never);
      out.push({ key: answered.get(t.relatedField) ?? t.relatedField, taskId: id });
    }
    if (out.length > 0) console.log(`[together] ${out.length} look-up to-do(s) done on ${dealId} (answered in the session)`);
    return out;
  } catch (err) {
    console.warn(`[together] couldn't close answered to-dos on ${dealId}:`, (err as Error).message);
    return [];
  }
}

/** Undo of a filing: the to-dos it closed are open again (only those still marked done). */
export async function reopenLookups(closed: TaskClosed[] | undefined, key: string): Promise<number> {
  let n = 0;
  for (const c of (closed ?? []).filter((x) => x.key === key)) {
    try {
      const t = await storage.getTask(c.taskId);
      if (t && t.status === "completed") {
        await storage.updateTask(c.taskId, { status: "pending", completedAt: null } as never);
        n++;
      }
    } catch {
      /* the to-do list is never worth a failed Undo */
    }
  }
  return n;
}
