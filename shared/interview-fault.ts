/**
 * interview-fault — a turn the interview model couldn't answer (the API
 * overloaded for longer than the retries, or out of credits).
 *
 * The seller's message is saved with the fault notice (flagged `degraded`
 * on the AI message) and the next turn's RECOVERY NOTE reads it. The
 * seller is never asked to retype it: the client offers a Continue button,
 * which sends CONTINUE_AFTER_FAULT. Those presses — and any further
 * messages sent while the fault lasts — are not seller turns for pacing
 * (the financial-core checkpoint, the PACING nudge, the turn floor): an
 * outage used to inflate the count with every retry (review F2-INT-4).
 * Pure; shared by the server and the client.
 */

/** What the Continue button sends after a fault notice. */
export const CONTINUE_AFTER_FAULT = "Continue";

type Msg = { role: string; content: string; degraded?: boolean; [k: string]: unknown };

/** Is this seller message a Continue press after a fault notice? */
export function isContinueAfterFault(messages: Msg[], index: number): boolean {
  const m = messages[index];
  const prev = messages[index - 1];
  return !!m && m.role === "user" && !!prev && prev.role === "ai" && prev.degraded === true && m.content.trim().toLowerCase() === CONTINUE_AFTER_FAULT.toLowerCase();
}

/**
 * The seller turns that count: every seller message except a Continue
 * press after a fault notice, and a message sent while a fault was already
 * showing that met another fault (a retry during the outage), and a short
 * break answered with "take your time" (an AI message flagged `pause`). The
 * message the first fault left unprocessed still counts — the next turn
 * answers it.
 */
export function countedSellerTurns(messages: Msg[]): number {
  let n = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (isContinueAfterFault(messages, i)) continue;
    const prev = messages[i - 1];
    const next = messages[i + 1];
    if (prev?.role === "ai" && prev.degraded && next?.role === "ai" && next.degraded) continue;
    // ("Be right back", answered with "take your time": not a turn either.)
    if (next?.role === "ai" && next.pause === true) continue;
    n++;
  }
  return n;
}

/**
 * On a Continue press: the seller's saved answer the fault left
 * unprocessed — every seller message since the last AI reply that wasn't a
 * fault notice, in order, not counting Continue presses. "" when there is
 * none. `messages` is the transcript BEFORE the Continue press.
 *
 * The turn's checks read this, not "Continue" (final review INT-RC-2: the
 * grounding and numeric-fidelity guards saw a message with no figures, so
 * the saved "$2.4M … 30%" was downgraded to approximate and queued to be
 * verified — the seller told "no need to type it again" was asked again).
 */
export function savedAnswerText(messages: Msg[]): string {
  const parts: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "ai") {
      if (m.degraded) continue;
      break;
    }
    if (m.role !== "user" || isContinueAfterFault(messages, i)) continue;
    const text = m.content.trim();
    if (text) parts.unshift(text);
  }
  return parts.join("\n\n");
}
