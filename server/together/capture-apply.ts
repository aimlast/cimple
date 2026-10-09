/**
 * Writes the coverage board makes to the deal (specs/together.md §4.6, §5.7).
 *
 * Pass 1 (checklist mode): "✓ Confirmed" — the broker confirms, with the
 * seller, a value already on file that was marked to verify (a seller
 * estimate, a guard flag, a lead from the CRM notes or website, the broker's
 * own AI-session notes, a "come back later" mark). No text is copied
 * anywhere: it records a "confirmed" mark keyed to the hash of the current
 * value (the board's override — it lapses when the value changes) and, for
 * a lead, vouches for the lead's source (acceptedByBroker), as the
 * Information tab's accept does for a same-value lead. A conflict between
 * sources needs Resolve; a non-answer needs an answer.
 *
 * Live capture (applyCapture, undo, call notes) lands here in pass 3.
 */
import type { Deal } from "@shared/schema";
import type { CoverageBoard, CoverageItem } from "@shared/coverage-board";
import { boardFromCoverage, coverageValueText, loadCoverageInputs, valueHash, type CoverageLoaders } from "../interview/coverage-board";
import { getFieldSources, setFieldSource } from "../interview/info-merger";
import { mutateDealInfo } from "../information/facts";
import { clearMark, setMark } from "./marks";

const LEAD_KINDS = new Set(["crm", "website", "social"]);
const CONFIRMABLE = new Set(["estimate", "guard", "lead", "broker_notes", "marked"]);

export class BoardActionError extends Error {
  constructor(message: string, public status: number, public code: string, public details: Record<string, unknown> = {}) {
    super(message);
  }
}

function findItem(board: CoverageBoard, itemId: string): CoverageItem | undefined {
  for (const s of board.sections) for (const i of s.items) if (i.id === itemId) return i;
  return undefined;
}

/**
 * ✓ Confirmed (no live session). Returns the broker board after the write.
 */
export async function confirmItem(
  deal: Deal,
  itemId: string,
  brokerId: string,
  opts: { sittingId?: string | null; loaders?: Partial<CoverageLoaders>; reload?: () => Promise<Deal> } = {},
): Promise<CoverageBoard> {
  const inputs = await loadCoverageInputs(deal, opts.loaders);
  const board = boardFromCoverage(inputs, "broker");
  const item = findItem(board, itemId);
  if (!item) throw new BoardActionError("That data point isn't on the checklist any more.", 404, "not_found");
  if (item.status === "on_file") return board;
  const code = item.reason?.code;
  if (code === "conflict" || code === "routed") {
    throw new BoardActionError("Two sources disagree here — resolve it instead.", 409, "resolve", { discrepancyId: item.conflictId ?? null });
  }
  if (item.status !== "verify" || !code || !CONFIRMABLE.has(code) || !item.valueKey) {
    throw new BoardActionError("There's nothing on file to confirm yet — add the answer instead.", 409, "needs_answer");
  }
  const key = item.valueKey;
  const full = coverageValueText(inputs.brokerFacts[key]);
  if (full === null) throw new BoardActionError("There's nothing on file to confirm yet — add the answer instead.", 409, "needs_answer");

  if (code === "lead") {
    // The broker vouches for the lead's source — its real kind stays.
    await mutateDealInfo(deal.id, (info) => {
      const src = getFieldSources(info)[key];
      if (src && LEAD_KINDS.has(String(src.source)) && !src.acceptedByBroker) setFieldSource(info, key, { ...src, acceptedByBroker: true });
    });
  }
  await setMark({ dealId: deal.id, itemId, sectionKey: item.sectionKey, kind: "confirmed", note: key, valueHash: valueHash(full), sittingId: opts.sittingId ?? null, createdBy: brokerId });
  if (item.marks.some((m) => m.kind === "verify_later")) await clearMark(deal.id, itemId, "verify_later");

  const fresh = opts.reload ? await opts.reload() : deal;
  return boardFromCoverage(await loadCoverageInputs(fresh, opts.loaders), "broker");
}
