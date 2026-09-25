/**
 * What an interview turn result may carry to the SELLER's browser.
 *
 * processTurn / startOrResumeSession return values meant for the broker
 * views too: `captured.changes` holds each updated field's previous and new
 * value, and deferral strings carry the guard's reason (e.g. "differs from the
 * value already on record ($1.82M)"). The previous value can come from a
 * broker_only source — a CRM note, a private email — which must never reach
 * the seller. The seller UI only reads field counts/names and never shows
 * deferrals, so for a seller the values and reasons are simply dropped.
 * Pure — the interview's behaviour is unchanged; only the response is trimmed.
 */
interface TurnLike {
  captured?: { changes?: Array<{ fieldName: string }> } & Record<string, unknown>;
  deferredTopics?: string[];
}

/** " — " is the separator deferralTopicStrings puts between topic and reason. */
const REASON_SEP = " — ";

export function sellerSafeTurnResult<T extends TurnLike>(result: T): T {
  if (!result || typeof result !== "object") return result;
  const out: any = { ...result };
  if (result.captured && Array.isArray(result.captured.changes)) {
    out.captured = { ...result.captured, changes: result.captured.changes.map((c) => ({ fieldName: c.fieldName })) };
  }
  if (Array.isArray(result.deferredTopics)) {
    out.deferredTopics = result.deferredTopics.map((t) => {
      const i = typeof t === "string" ? t.indexOf(REASON_SEP) : -1;
      return i > 0 ? t.slice(0, i) : t;
    });
  }
  return out as T;
}
