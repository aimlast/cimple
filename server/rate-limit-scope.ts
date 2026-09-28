/**
 * Which requests count against the per-IP AI limit.
 *
 * The AI limiter (60 / 5 min per IP) used to cover the whole /api/interview
 * prefix, so the Zoom/Meet/Teams notetaker's 2-second transcript poll
 * (GET …/call/bot/lines, 30 a minute) used it up after ~2 minutes of a live
 * call: the transcript froze silently and the next interview turn got a 429.
 *
 * The split is fail-closed: a request is on the roomy limit only when it is a
 * read (GET/HEAD/OPTIONS — none of the interview reads run the model) or one
 * of the named call-control posts below. Everything else under the prefix —
 * start, message, message/stream, end, the transcription-token mint (a paid
 * Deepgram key), and any route added later — stays on the AI limit. Matching
 * is case-insensitive because Express routing is: /Message/Stream reaches the
 * same model handler as /message/stream, so it must meet the same cap.
 */
import type { Express, RequestHandler } from "express";
import rateLimit from "express-rate-limit";

/** POSTs under /api/interview/:dealId/ that never run the model or mint a paid key. */
const INTERVIEW_CONTROL_POST =
  /^\/api\/interview\/[^/]+\/(reopen|call\/start|call\/end|call\/seller-link|call\/bot\/start|call\/bot\/stop)\/?$/i;

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function isAiInterviewRequest(method: string, fullPath: string): boolean {
  const m = method.toUpperCase();
  if (READ_METHODS.has(m)) return false;
  return !(m === "POST" && INTERVIEW_CONTROL_POST.test(fullPath));
}

/**
 * The buyer Q&A prefix: asking (POST) runs the model; reading the feed or
 * the broker's list (GET, polled by the chat widget) does not.
 */
export function isAiQuestionRequest(method: string): boolean {
  const m = method.toUpperCase();
  return m !== "GET" && m !== "HEAD";
}

/** AI-backed endpoints: a modest per-IP ceiling against cost abuse. */
export const AI_LIMIT = { windowMs: 5 * 60 * 1000, limit: 60 } as const;
/** Non-AI interview traffic: 3 requests a second for five minutes. */
export const INTERVIEW_POLL_LIMIT = { windowMs: 5 * 60 * 1000, limit: 900 } as const;

const TOO_MANY = { error: "Too many requests. Please slow down and try again shortly." };

/**
 * Mounts the interview + buyer-question limits. `aiLimiter` is shared with
 * the other AI routes (generate-*) so one IP's AI budget is one budget.
 */
export function applyInterviewRateLimits(app: Express, aiLimiter: RequestHandler): void {
  const interviewPollLimiter = rateLimit({
    ...INTERVIEW_POLL_LIMIT,
    standardHeaders: true,
    legacyHeaders: false,
    message: TOO_MANY,
  });
  app.use("/api/interview", (req, res, next) =>
    (isAiInterviewRequest(req.method, req.baseUrl + req.path) ? aiLimiter : interviewPollLimiter)(req, res, next),
  );
  app.use("/api/deals/:dealId/questions", (req, res, next) =>
    isAiQuestionRequest(req.method) ? aiLimiter(req, res, next) : next(),
  );
}
