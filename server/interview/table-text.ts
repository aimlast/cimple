/**
 * table-text — a flattened PDF / spreadsheet table read the way a person
 * reads it: every figure next to ITS label.
 *
 * PDF text extraction flattens a table in two ways, and both misled the
 * interview (acceptance test, Great Lakes org chart):
 *
 *  1. a label and its figure glued into one word —
 *       "Press operators and packers112", "Setup and process technicians22";
 *  2. a label and its figure on separate lines —
 *       "Press operators & packers" / "112 · 3 shifts" /
 *       "Setup & process technicians" / "22".
 *
 * Every reader that shows the model a window of lines ("this line and the
 * next") then paired a figure with the NEXT row's label: the window
 * "112 · 3 shifts (24/5 + weekend OT) Setup & process technicians" became
 * "the org chart shows 112 setup and process technicians", the seller had to
 * correct it, and the correction (22) was then "checked" against the same
 * window and raised as a conflict ("the org chart didn't specify a count").
 *
 * normaliseTableText rewrites such text so each figure sits on the line of
 * its own label ("Press operators & packers: 112 · 3 shifts (24/5 + weekend
 * OT)", "Setup & process technicians: 22"). Ordinary prose passes through
 * unchanged. Pure.
 */

/** A figure at the start of a line: "112 · 3 shifts", "22", "$1,234", "(18)", "61.9%". */
const VALUE_LINE_RE = /^[($-]?\s?\$?\d[\d,]*(?:\.\d+)?\s*%?(?:\)|\b|$)/;
/** Words that end an unfinished label ("Material handling, shipping &" / "receiving"). */
const OPEN_TAIL_RE = /(?:[&,/(\-–]|\b(?:and|or|of|for|the|to|in|on|with|by|per|incl\.?|including))\s*$/i;

/** A label line: a short run of words with no figure, not a sentence. */
function isLabelLine(line: string): boolean {
  if (!line || line.length > 70) return false;
  if (!/^[A-Za-z(]/.test(line)) return false;
  // A figure outside parentheses makes it a row, not a label ("(CEO, VP" is fine).
  if (/\d/.test(line.replace(/\([^)]*\)?/g, ""))) return false;
  if (/[.!?:;]\s*$/.test(line)) return false;
  const words = line.split(/\s+/).filter(Boolean);
  return words.length >= 1 && words.length <= 10;
}

/** Parentheses opened and not closed ("Executive leadership (CEO, VP"). */
const unbalanced = (s: string) => (s.match(/\(/g) ?? []).length > (s.match(/\)/g) ?? []).length;

/**
 * Separates a label glued to its figure ("packers112" → "packers: 112",
 * "(contractors)1,018,300" → "(contractors): 1,018,300") and two figures
 * glued into one run ("1,018,300912,800" → "1,018,300 912,800").
 * Codes are left alone: an upper-case run with digits (ISO9001, G1, 313A,
 * FY2024, CEO34) is a code, not a label and a figure.
 */
export function unglueLine(line: string): string {
  return line
    // A lower-case word (3+ letters, not a code) or a closing parenthesis, then a figure.
    .replace(/(^|[^A-Za-z])([A-Za-z]*[a-z]{3,})(\$?\d[\d,]*(?:\.\d+)?%?)(?=$|[\s,;)·|–-])/g, "$1$2: $3")
    .replace(/\)(\$?\d[\d,]*(?:\.\d+)?%?)(?=$|[\s,;)·|–-])/g, "): $1")
    // Two comma-grouped figures glued into one run ("1,018,300912,800").
    // (Two or more groups: "35,72800" is two CSV cells, not a glued figure.)
    .replace(/(\d{1,3}(?:,\d{3}){2,})(?=\d)/g, "$1 ");
}

/**
 * The text with every table figure on its own label's line (see the module
 * comment). Lines are kept in order; only label lines directly followed by
 * a figure line are joined ("label: figure …"), with a label that wraps
 * over two or three lines joined first.
 */
export function normaliseTableText(text: string): string {
  if (!text) return text;
  const lines = text.replace(/\r/g, "").split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim());
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = unglueLine(lines[i]);
    if (!isLabelLine(line)) {
      out.push(line);
      continue;
    }
    // Gather a wrapped label ("Material handling, shipping &" + "receiving").
    let label = line;
    let j = i + 1;
    while (j < lines.length && j - i <= 2 && (OPEN_TAIL_RE.test(label) || unbalanced(label)) && isLabelLine(unglueLine(lines[j]))) {
      label = `${label} ${unglueLine(lines[j])}`;
      j++;
    }
    const next = j < lines.length ? unglueLine(lines[j]) : "";
    if (next && VALUE_LINE_RE.test(next)) {
      out.push(`${label.replace(/[\s:]+$/, "")}: ${next}`);
      i = j;
      continue;
    }
    // Not a label after all (a heading, a name): keep the lines as they were.
    out.push(line);
  }
  return out.join("\n");
}
