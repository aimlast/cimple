/**
 * Publishing is the gate for buyers.
 *
 * `deals.isLive` is set only by the publish step, which the server refuses
 * until critical discrepancies are resolved and both design approvals are
 * recorded. Every buyer path (view room, NDA, decisions, Q&A, media,
 * analytics, the buyer dashboard) checks this one rule, so a link granted
 * before publishing — or a deal taken back offline — shows a neutral
 * "not available yet" instead of a draft the seller never approved.
 *
 * Access rows may still exist on an unpublished deal (a seller-approved
 * buyer waits for publish); they simply don't open until then.
 */

export const NOT_PUBLISHED_CODE = "not_published" as const;

/** What a buyer sees — neutral: no business name, no phase, no reason. */
export const NOT_PUBLISHED_MESSAGE =
  "This CIM isn't available yet. Your broker will let you know as soon as it is.";

/** What the broker is told when trying to hand out a link too early. */
export const NOT_PUBLISHED_BROKER_MESSAGE =
  "Publish the CIM before giving buyers access — buyers can only open a published CIM.";

export function dealPublishedForBuyers(deal: { isLive?: boolean | null } | null | undefined): boolean {
  return !!deal?.isLive;
}

export function notPublishedBody(): { error: string; code: typeof NOT_PUBLISHED_CODE } {
  return { error: NOT_PUBLISHED_MESSAGE, code: NOT_PUBLISHED_CODE };
}
