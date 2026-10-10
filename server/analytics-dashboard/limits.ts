/**
 * The analytics dashboards' own rate limit (read-only routes; guards
 * against a runaway client, never a real broker: the page polls the
 * numbers every 2 min and "reading now" every 20–30 s). Applied from
 * server/index.ts next to the other limiters.
 */
import type { Express } from "express";
import rateLimit from "express-rate-limit";

export const ANALYTICS_LIMIT = { windowMs: 60_000, limit: 120 } as const;

/** The deal Engagement-tab paths this stream adds (the older engagement routes keep their own rules). */
export const DEAL_ANALYTICS_PATHS = ["kpis", "reading-now", "page-titles", "activity"] as const;

export function applyAnalyticsRateLimits(app: Express, limit: number = ANALYTICS_LIMIT.limit): void {
  const limiter = rateLimit({
    windowMs: ANALYTICS_LIMIT.windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests. Please slow down and try again shortly." },
  });
  app.use("/api/broker/analytics", limiter);
  for (const p of DEAL_ANALYTICS_PATHS) app.use(`/api/deals/:dealId/engagement/${p}`, limiter);
}
