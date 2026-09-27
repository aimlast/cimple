/**
 * Which requests count against the per-IP AI limit.
 *
 * The AI limiter (60 / 5 min per IP) used to cover the whole /api/interview
 * prefix, so the Zoom/Meet/Teams notetaker's 2-second transcript poll
 * (GET …/call/bot/lines, 30 a minute) used it up after ~2 minutes of a live
 * call: the transcript froze silently and the next interview turn got a 429.
 * Only requests that actually run the model count now; the polls, call
 * control, transcription tokens and history get their own generous limit.
 */
import type { Express, RequestHandler } from "express";
import rateLimit from "express-rate-limit";

/** POST /api/interview/:dealId/(start|message|message/stream|end) — the model runs. */
const AI_INTERVIEW_PATH = /^\/api\/interview\/[^/]+\/(start|message|message\/stream|end)\/?$/;

export function isAiInterviewRequest(method: string, fullPath: string): boolean {
  return method.toUpperCase() === "POST" && AI_INTERVIEW_PATH.test(fullPath);
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
