/**
 * dd's "questions about the numbers" on the coverage board (INTEGRATION.md
 * §2.5; dd.md §11.5). dd provides `figureQuestionsForBoard(dealId)` and
 * `explainBoardItems(questions)`; the board shows each as a "Numbers" item
 * under Financial Summary (broker and screen audiences only, never counted).
 *
 * Until dd merges this seam returns []. dd (or the integrator at the dd
 * merge) registers its loader once at start-up:
 *
 *   registerFigureBoardLoader(async (dealId) =>
 *     explainBoardItems(await figureQuestionsForBoard(dealId)));
 *
 * No file of this stream needs editing when dd lands.
 */
import type { ExplainBoardItem } from "../interview/coverage-board";

type Loader = (dealId: string) => Promise<ExplainBoardItem[]>;

let loader: Loader | null = null;

export function registerFigureBoardLoader(fn: Loader | null): void {
  loader = fn;
}

/** dd's open questions about the numbers, shaped as board items ([] until dd registers). */
export async function loadFigureBoardItems(dealId: string): Promise<ExplainBoardItem[]> {
  if (!loader) return [];
  try {
    const items = await loader(dealId);
    return Array.isArray(items) ? items.filter((i) => i && typeof i.writeKey === "string" && i.writeKey && typeof i.label === "string") : [];
  } catch (err) {
    console.warn(`[coverage-board] questions about the numbers unavailable for deal ${dealId}: ${(err as Error).message}`);
    return [];
  }
}
