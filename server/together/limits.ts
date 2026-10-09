/**
 * Interview together — limits (specs/together.md §5.3, §7.2).
 *
 * Request ceilings per broker session (falling back to the IP), mounted from
 * server/index.ts in the "together limiters" block. The sitting start, the
 * focused capture ("✓ Answered" / "✓ Confirmed" in auto mode), "Re-file"
 * and "Try now" also count against the shared per-IP AI limiter.
 */
import type { Express, Request, RequestHandler } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";

const TOO_MANY = { error: "Too many requests. Please slow down and try again shortly." };

/** Per broker session id, else per IP. */
function brokerKey(req: Request): string {
  const brokerId = (req.session as { brokerId?: string } | undefined)?.brokerId;
  return brokerId ? `b:${brokerId}` : `ip:${ipKeyGenerator(req.ip ?? "")}`;
}

function limiter(windowMs: number, limit: number, scope: string): RequestHandler {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `${scope}:${brokerKey(req)}`,
    message: TOO_MANY,
  });
}

const MIN = 60_000;

/** Pause, caps and sizes of live capture (pass 3 reads these too). */
export const TOGETHER_LIMITS = {
  /** Lines per POST …/lines request. */
  linesPerRequest: 50,
  lineTextMax: 2000,
  /** A sitting resumes within this long; after it a new one starts. */
  resumeWithinMs: 2 * 60 * MIN,
  /** Soft cap of capture calls per rolling hour per sitting; hard cap per sitting. */
  softCallsPerHour: 90,
  hardCallsPerSitting: 400,
  pauseMs: 2_500,
  longAnswerMs: 60_000,
  longAnswerWords: 350,
  leaseMs: 30_000,
  leaseRenewMs: 10_000,
} as const;

/**
 * Mounts the together route ceilings. `aiLimiter` is the shared per-IP AI
 * budget (server/index.ts) — model-running requests count against it too.
 */
export function applyTogetherRateLimits(app: Express, aiLimiter: RequestHandler): void {
  // Coverage board item actions (marks, confirm, answer, file a held answer).
  const itemActions = limiter(MIN, 120, "cov-item");
  app.use("/api/deals/:dealId/coverage-board/items/:itemId/marks", itemActions);
  app.use("/api/deals/:dealId/coverage-board/items/:itemId/file-suggestion", itemActions);
  app.use("/api/deals/:dealId/coverage-board/items/:itemId/confirm", itemActions);
  app.use("/api/deals/:dealId/coverage-board/items/:itemId/answer", itemActions);
  // A focused capture runs the model: the AI budget too (auto mode only —
  // a typed note or a confirm with no live session never calls a model).
  const aiWhenAuto: RequestHandler = (req, res, next) =>
    req.method === "POST" && (req.body?.mode === "auto" || (typeof req.body?.sittingId === "string" && req.body.sittingId)) ? aiLimiter(req, res, next) : next();
  app.use("/api/deals/:dealId/coverage-board/items/:itemId/answer", aiWhenAuto);
  app.use("/api/deals/:dealId/coverage-board/items/:itemId/confirm", aiWhenAuto);

  // Sittings (pass 2): start 30 / 15 min + AI; lines 240 / min; SSE 30 connects / min…
  app.post("/api/deals/:dealId/together/sittings", limiter(15 * MIN, 30, "tg-start"), aiLimiter);
  app.use("/api/deals/:dealId/together/sittings/:sittingId/events", limiter(MIN, 30, "tg-sse"));
  app.use("/api/deals/:dealId/together/sittings/:sittingId/state", limiter(MIN, 60, "tg-state"));
  app.use("/api/deals/:dealId/together/sittings/:sittingId/consent", limiter(MIN, 30, "tg-consent"));
  app.use("/api/deals/:dealId/together/sittings/:sittingId/lines", limiter(MIN, 240, "tg-lines"));
  app.use("/api/deals/:dealId/together/sittings/:sittingId/speakers", limiter(MIN, 60, "tg-speakers"));
  app.use("/api/deals/:dealId/together/sittings/:sittingId/file-now", limiter(MIN, 30, "tg-filenow"));
  app.use("/api/deals/:dealId/together/sittings/:sittingId/pause", limiter(MIN, 60, "tg-pause"));
  app.use("/api/deals/:dealId/together/sittings/:sittingId/resume", limiter(MIN, 60, "tg-resume"));
  app.use("/api/deals/:dealId/together/sittings/:sittingId/end", limiter(15 * MIN, 10, "tg-end"));
  app.use("/api/deals/:dealId/together/sittings/:sittingId/follow-up-email", limiter(15 * MIN, 10, "tg-email"));
  app.use("/api/deals/:dealId/together/sittings/:sittingId/captures/:chunkId/undo", limiter(MIN, 60, "tg-undo"));
  app.use("/api/deals/:dealId/together/sittings/:sittingId/refile", limiter(15 * MIN, 5, "tg-refile"), aiLimiter);
  app.use("/api/deals/:dealId/together/sittings/:sittingId/retry", limiter(15 * MIN, 10, "tg-retry"), aiLimiter);
}
