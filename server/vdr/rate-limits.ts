/**
 * The data room's rate limits (vdr spec §9.3, §9.4), applied from
 * server/index.ts in one labelled block. Buyer routes are limited per LINK
 * (a hash of the token — never the token itself, never the IP), so a
 * brokerage office sharing one address isn't throttled together; the
 * broker's upload is limited per broker session.
 */
import type { Express, Request, RequestHandler } from "express";
import rateLimit from "express-rate-limit";
import { createHash } from "crypto";

const tokenKey = (prefix: string) => (req: Request) =>
  `vdr:${prefix}:${createHash("sha256").update(String(req.params.token ?? "")).digest("hex").slice(0, 32)}`;

function perToken(prefix: string, windowMs: number, limit: number) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: tokenKey(prefix),
    message: { error: "Too many requests. Please slow down and try again shortly." },
  });
}

const MIN = 60_000;
const HOUR = 60 * MIN;

export function applyVdrRateLimits(app: Express, aiLimiter?: RequestHandler): void {
  const B = "/api/view/:token/data-room";
  // Most specific first (express matches every app.use prefix that fits).
  app.use(`${B}/items/:itemId/pages/:n`, perToken("pages", MIN, 600));
  app.use(`${B}/items/:itemId/questions`, perToken("questions", HOUR, 20));
  app.use(`${B}/items/:itemId/download`, perToken("download", HOUR, 30));
  app.use(`${B}/index.csv`, perToken("index", HOUR, 10));
  app.use(`${B}/views/start`, perToken("start", MIN, 120));
  app.use(`${B}/search`, perToken("search", MIN, 30));
  app.use(`${B}/requests`, perToken("requests", HOUR, 20));
  app.use(`${B}/team`, perToken("team", 24 * HOUR, 5));
  app.use(`${B}/acknowledge`, perToken("ack", HOUR, 10));
  app.use(`${B}/resolve`, perToken("resolve", MIN, 120));
  app.use(`${B}/ledger`, perToken("ledger", MIN, 300));
  app.use((req, res, next) => {
    // A beat (POST …/views) has its own ceiling; everything else 300/min per link.
    if (/^\/api\/view\/[^/]+\/data-room\/views\/?$/.test(req.path) && req.method === "POST") return beats(req, res, next);
    if (/^\/api\/view\/[^/]+\/data-room\/items\/[^/]+\/pages\//.test(req.path)) return next();
    if (/^\/api\/view\/[^/]+\/data-room(\/|$)/.test(req.path)) return general(req, res, next);
    next();
  });
  // "Draft again" is the only model call in the data room (plus the per-deal daily cap).
  if (aiLimiter) app.use("/api/deals/:dealId/data-room/items/:itemId/summary", (req, res, next) => (req.method === "POST" && /\/summary\/?$/.test(req.originalUrl.split("?")[0]) ? aiLimiter(req, res, next) : next()));
  // Emails the broker sends from the data room: the same ceiling as "email this buyer".
  const emails = rateLimit({
    windowMs: 10 * MIN,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `vdr:email:${String((req as Request).session?.brokerId ?? "anon")}`,
    message: { error: "You've sent a lot of emails in a short time. Please wait a few minutes." },
  });
  app.use("/api/deals/:dealId/data-room/requests/email-seller", emails);
  app.use("/api/deals/:dealId/data-room/requests/:requestId/tell-buyer", (req, res, next) => (req.method === "POST" ? emails(req, res, next) : next()));
  app.use("/api/deals/:dealId/data-room/let-buyers-know", (req, res, next) => (req.method === "POST" && !/\/draft\/?$/.test(req.originalUrl.split("?")[0]) ? emails(req, res, next) : next()));
  // The broker's data-room upload: 300 files an hour per broker session.
  app.use("/api/deals/:dealId/data-room/upload", rateLimit({
    windowMs: HOUR,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
    // requireBroker runs on the route itself; an anonymous request is refused there.
    keyGenerator: (req) => `vdr:upload:${String((req as Request).session?.brokerId ?? "anon")}`,
    message: { error: "That's a lot of uploads at once. Wait a few minutes and try again." },
  }));
}

const beats = rateLimit({
  windowMs: MIN,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `vdr:beat:${createHash("sha256").update(String(req.path.split("/")[3] ?? "")).digest("hex").slice(0, 32)}`,
  message: { error: "Too many requests" },
});
const general = rateLimit({
  windowMs: MIN,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `vdr:room:${createHash("sha256").update(String(req.path.split("/")[3] ?? "")).digest("hex").slice(0, 32)}`,
  message: { error: "Too many requests. Please slow down and try again shortly." },
});
