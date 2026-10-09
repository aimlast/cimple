/**
 * figure-explain — questions about the numbers as items on the "Interview
 * together" board (contract with stream "together", INTEGRATION §2.5,
 * dd spec §11.5).
 *
 * Every open question (suggested, with the seller, or asked without an
 * answer) becomes a board item under Financials, keyed by its capture key:
 * the note-taker files the seller's spoken explanation under that key, and
 * the next figure refresh offers it as the note's source. These items are
 * never counted in the board's percent (together's rule).
 *
 * Pure.
 */

export interface ExplainBoardItem {
  /** = the capture key. */
  id: string;
  sectionKey: "financials";
  /** The question, in the seller's wording. */
  label: string;
  writeKey: string;
  memberKeys: string[];
  critical: false;
  origin: "figures";
  ask: string;
  why: "Buyers will ask what drove this.";
}

export const EXPLAIN_WHY = "Buyers will ask what drove this." as const;

/** Statuses that put a question on the board. */
const ON_BOARD = new Set(["suggested", "ask_seller", "asked"]);

/** A line label → the capture key's middle ("Bad debts" → "BadDebts"). */
function pascalWords(label: string): string {
  const words = String(label ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w && !/^(?:and|of|the|incl|including)$/i.test(w))
    .slice(0, 5);
  const out = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join("");
  return out.slice(0, 40) || "Figure";
}

/** "reasonFuelChange2023" / "reasonInterestDifference2022". */
export function captureKeyFor(lineLabel: string, kind: "movement" | "difference", year: string): string {
  return `reason${pascalWords(lineLabel)}${kind === "movement" ? "Change" : "Difference"}${year}`;
}

/** Is a fact key one of these capture keys? */
export function isCaptureKey(key: string): boolean {
  return /^reason[A-Z][A-Za-z0-9]{0,40}(?:Change|Difference)\d{4}$/.test(key);
}

export function explainBoardItems(questions: ReadonlyArray<{ status: string; captureKey: string; question: string }>): ExplainBoardItem[] {
  const out: ExplainBoardItem[] = [];
  const seen = new Set<string>();
  for (const q of questions) {
    if (!ON_BOARD.has(q.status) || !q.captureKey || seen.has(q.captureKey)) continue;
    seen.add(q.captureKey);
    out.push({
      id: q.captureKey,
      sectionKey: "financials",
      label: q.question,
      writeKey: q.captureKey,
      memberKeys: [q.captureKey],
      critical: false,
      origin: "figures",
      ask: q.question,
      why: EXPLAIN_WHY,
    });
  }
  return out;
}
