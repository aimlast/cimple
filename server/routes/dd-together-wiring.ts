/**
 * dd × Interview together (INTEGRATION §2.5, §2.11, §6 step 8, C15) — the
 * integrator's one composition point, so neither stream imports the other's
 * internals:
 *
 *  1. The coverage board's "Numbers" items: dd's open questions about the
 *     numbers (`figureQuestionsForBoard`, already shaped by
 *     `explainBoardItems`), shown under Financial Summary to the broker and
 *     the screen only, never counted (together's `registerFigureBoardLoader`).
 *  2. The end of a sitting: the questions about the numbers raised on the
 *     call are handed back (answered / asked), answers feed the next figure
 *     build, and new questions are planned — dd's
 *     `markExplainQuestionsRaised`, `scheduleFigureBuild`,
 *     `planExplainQuestions` (together's `registerSittingEndHooks`).
 *
 * The follow-up email (C15) is switched inside together's
 * `sendFollowUpEmail` (server/together/summary.ts): once the interview is
 * finished it goes through dd's one path, `sendSellerFollowUps`.
 */
import { registerFigureBoardLoader } from "../together/figure-board";
import { registerSittingEndHooks } from "../together/summary";
import { figureQuestionsForBoard, markExplainQuestionsRaised, planExplainQuestions } from "../cim/figures/requests";
import { scheduleFigureBuild, type BuildReason } from "../cim/figures/build";

const BUILD_REASONS: ReadonlySet<string> = new Set<BuildReason>(["cim_generated", "dd_generated", "broker", "interview_answers"]);

let wired = false;

export function registerDdTogetherWiring(): void {
  if (wired) return;
  wired = true;
  registerFigureBoardLoader((dealId) => figureQuestionsForBoard(dealId));
  registerSittingEndHooks({
    explainQuestionsRaised: (dealId, sittingId, messages) => markExplainQuestionsRaised(dealId, sittingId, messages),
    scheduleFigureBuild: (dealId, reason) => scheduleFigureBuild(dealId, (BUILD_REASONS.has(reason) ? reason : "interview_answers") as BuildReason),
    planExplainQuestions: (dealId) => planExplainQuestions(dealId),
  });
}

/** Test hook: wire again (after a test replaced the seams). */
export function _resetDdTogetherWiringForTests(): void {
  wired = false;
}
