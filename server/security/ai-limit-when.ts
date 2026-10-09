/**
 * The AI limiter only for requests that run a model. `app.use` can't look at
 * a body, so "POST …/teaser/blocks with mode: 'ai'" or "PATCH …/layout with
 * convert: 'ai'" are mounted with a predicate (this runs after express.json).
 * runLimiter applies a limiter inline, for routes that learn only after a
 * lookup whether they will call the model (resetting an AI-written block).
 */
import type { Request, RequestHandler, Response } from "express";

export function aiLimiterWhen(limiter: RequestHandler, when: (req: Request) => boolean): RequestHandler {
  return (req, res, next) => (when(req) ? limiter(req, res, next) : next());
}

/** Apply `limiter` now: true = allowed; false = it already answered 429. */
export function runLimiter(limiter: RequestHandler | null, req: Request, res: Response): Promise<boolean> {
  if (!limiter) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (!done) {
        done = true;
        resolve(ok);
      }
    };
    res.once("finish", () => finish(false));
    try {
      const r = limiter(req, res, (err?: unknown) => finish(!err));
      Promise.resolve(r).then(() => {
        if (res.headersSent) finish(false);
      }).catch(() => finish(false));
    } catch {
      finish(false);
    }
  });
}

let teaserAi: RequestHandler | null = null;
/** server/index.ts hands the teaser routes the shared AI limiter (applyTeaserRateLimits). */
export function setTeaserAiLimiter(l: RequestHandler | null): void {
  teaserAi = l;
}
export function teaserAiLimiter(): RequestHandler | null {
  return teaserAi;
}
