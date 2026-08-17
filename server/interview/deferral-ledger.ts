import type { NewDeferral } from "./response-schema";

/**
 * Durable, server-side deferral ledger.
 *
 * The model's per-turn `reasoning.deferredTopics` used to be written wholesale
 * to the session, so the broker-facing deferral record flickered: entries
 * silently vanished mid-session, "not yet covered" planning items leaked in,
 * and unresolved deferrals were forgotten (so the agent never circled back).
 *
 * The ledger is append-only until resolved: the model reports NEW deferrals and
 * RESOLVED topics each turn (see response-schema), and the server maintains the
 * authoritative list. Open entries are rendered into the dynamic prompt block
 * each turn so the agent always sees its own outstanding items.
 */

export interface DeferralEntry {
  /** Stable id — slug of the topic at creation time */
  id: string;
  topic: string;
  reason: string;
  whereInfoLives: string;
  status: "open" | "resolved";
  /** Seller-turn number when the deferral was created */
  createdAtTurn: number;
  /** Seller-turn number when it was resolved, if resolved */
  resolvedAtTurn?: number;
}

/** Normalises a topic label for matching: lowercase, alphanumeric words only. */
function slugify(topic: string): string {
  return topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** True when two topic labels refer to the same deferral (exact or containment). */
function topicsMatch(a: string, b: string): boolean {
  const sa = slugify(a);
  const sb = slugify(b);
  if (!sa || !sb) return false;
  return sa === sb || sa.includes(sb) || sb.includes(sa);
}

/**
 * Applies one turn's deferral deltas to the ledger. Pure — returns a new array.
 *
 * Semantics:
 * - New deferrals are appended with stable ids; a topic matching an existing
 *   OPEN entry updates that entry's reason/whereInfoLives instead of
 *   duplicating; a topic matching a RESOLVED entry reopens it.
 * - Resolved topics are marked resolved (matched fuzzily on the label).
 * - Entries are NEVER deleted.
 */
export function updateDeferralLedger(
  existing: DeferralEntry[],
  newDeferrals: NewDeferral[],
  resolvedTopics: string[],
  turn: number,
): DeferralEntry[] {
  const ledger: DeferralEntry[] = existing.map((e) => ({ ...e }));

  // Resolve first — a topic both resolved and re-deferred in one turn ends open.
  for (const resolved of resolvedTopics) {
    for (const entry of ledger) {
      if (entry.status === "open" && topicsMatch(entry.topic, resolved)) {
        entry.status = "resolved";
        entry.resolvedAtTurn = turn;
      }
    }
  }

  for (const d of newDeferrals) {
    if (!d.topic || d.topic.trim() === "") continue;
    const match = ledger.find((e) => topicsMatch(e.topic, d.topic));
    if (match) {
      // Same topic again: refresh context; reopen if it had been resolved.
      if (d.reason) match.reason = d.reason;
      if (d.whereInfoLives) match.whereInfoLives = d.whereInfoLives;
      if (match.status === "resolved") {
        match.status = "open";
        delete match.resolvedAtTurn;
      }
    } else {
      ledger.push({
        id: `${slugify(d.topic) || "deferral"}_t${turn}`,
        topic: d.topic.trim(),
        reason: d.reason?.trim() ?? "",
        whereInfoLives: d.whereInfoLives?.trim() ?? "",
        status: "open",
        createdAtTurn: turn,
      });
    }
  }

  return ledger;
}

export function openDeferrals(ledger: DeferralEntry[]): DeferralEntry[] {
  return ledger.filter((e) => e.status === "open");
}

/**
 * The backwards-compatible string[] the client's deferred-topics panel reads.
 * Stable and append-only until resolved — no more per-turn flicker.
 */
export function deferralTopicStrings(ledger: DeferralEntry[]): string[] {
  return openDeferrals(ledger).map((e) =>
    e.reason ? `${e.topic} — ${e.reason}` : e.topic,
  );
}

/** Parses a persisted ledger from session metadata, tolerating old/missing shapes. */
export function parseLedger(raw: unknown): DeferralEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (e): e is DeferralEntry =>
      !!e &&
      typeof e === "object" &&
      typeof (e as DeferralEntry).topic === "string" &&
      ((e as DeferralEntry).status === "open" || (e as DeferralEntry).status === "resolved"),
  );
}
