/**
 * Ceilings for the broker's bulk actions (draft outreach, send outreach,
 * match buyers). One click on "select all" used to fire one Sonnet call per
 * buyer all at once — 81 simultaneous requests could hit the organisation's
 * Sonnet rate limit and make live interviews' parallel checks fail — and
 * send-outreach took any number of emails from Cimple's domain with no cap.
 */
import type { Express, RequestHandler } from "express";
import rateLimit from "express-rate-limit";

/** Most buyers one draft / send request may cover. */
export const BULK_OUTREACH_MAX = 50;
/** Model calls a bulk action runs at once. */
export const BULK_AI_CONCURRENCY = 4;

/** Like Promise.all(items.map(fn)), at most `limit` running at once; results keep their order. */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Outreach emails: the same ceiling as "email this buyer" (routes/buyer-profiles.ts). */
export const OUTREACH_EMAIL_LIMIT = { windowMs: 10 * 60 * 1000, limit: 30 } as const;

/**
 * Mounts the per-IP limits: the AI limit on drafting and on AI matching
 * (match-buyers with ?skipAI=true runs no model and stays free), and the
 * email limit on sending.
 */
export function applyBulkRateLimits(app: Express, aiLimiter: RequestHandler): void {
  const emailLimiter = rateLimit({
    ...OUTREACH_EMAIL_LIMIT,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "You've sent a lot of emails in a short time. Please wait a few minutes." },
  });
  app.use("/api/deals/:dealId/draft-outreach", aiLimiter);
  app.use("/api/deals/:dealId/match-buyers", (req, res, next) =>
    req.query.skipAI === "true" ? next() : aiLimiter(req, res, next),
  );
  app.use("/api/deals/:dealId/send-outreach", emailLimiter);
}
