/**
 * note-figures.ts — balance-sheet figures in the analysis' own words,
 * checked against the balance sheet it reclassified.
 *
 * The model writes free-text notes and insights next to its tables, and a
 * figure there can come from the wrong column: Ridgeline's analysis said
 * "Debt: Long-term debt of $1,342,000 (Dec 31 2024)" — $1,342,000 is the
 * FY2022 balance; the 2024 balance is on the same table's row. A figure that
 * a note ties to a year, for a balance-sheet line whose row gives that very
 * figure for ANOTHER year (and a different one for the year named), is
 * corrected to the named year's figure — the note then says what the table
 * says. Nothing else is touched: a figure the table doesn't have, or a year
 * it doesn't cover, is left as written.
 *
 * Pure.
 */
import type { UiReclassifiedTable } from "./shape";

interface Line {
  /** How a note names the line. */
  note: RegExp;
  /** The balance-sheet rows that are the line. */
  row: RegExp;
  notRow?: RegExp;
}

const LINES: Line[] = [
  { note: /\blong[- ]term debt\b/i, row: /\blong[- ]term debt\b|\bterm loans?\b/i, notRow: /\bcurrent portion\b|\bdue within\b/i },
  { note: /\btotal debt\b/i, row: /^total debt\b/i },
  { note: /\bcurrent portion\b/i, row: /\bcurrent portion\b/i },
  { note: /\bcash(?: and (?:cash )?equivalents)?\b/i, row: /^cash\b/i },
  { note: /\baccounts receivable\b|\breceivables\b/i, row: /\breceivable/i, notRow: /\bdue from\b|\bshareholder\b/i },
  { note: /\binventor(?:y|ies)\b/i, row: /\binventor/i },
  { note: /\baccounts payable\b|\btrade payables\b/i, row: /\baccounts payable\b|\btrade payables\b/i },
  { note: /\bshareholders'? equity\b|\btotal equity\b/i, row: /\bequity\b/i },
  { note: /\btotal assets\b/i, row: /^total assets\b/i },
  { note: /\btotal liabilities\b/i, row: /^total liabilities\b/i },
];

const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
/** A year right after a figure: "(Dec 31 2024)", "(2024)", "as at December 31, 2024", "at year-end 2024", "for FY2024". */
const YEAR_AFTER_RE = new RegExp(String.raw`^\s*\(?\s*(?:as (?:at|of)\s+|at\s+(?:the\s+)?(?:fiscal\s+)?year[- ]end\s+|at\s+|for\s+|in\s+)?(?:${MONTH}\.?\s+\d{1,2},?\s+)?(?:FY\s?)?((?:19|20)\d{2})\b`, "i");

function money(raw: string): number | null {
  const m = raw.replace(/[$\s]/g, "").match(/^(\d[\d,]*(?:\.\d+)?)(k|m|mm|million|thousand)?$/i);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ""));
  const mult = /^(?:k|thousand)$/i.test(m[2] ?? "") ? 1e3 : m[2] ? 1e6 : 1;
  return Number.isFinite(n) ? n * mult : null;
}

const same = (a: number, b: number) => Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * 0.005 + 0.5;
const fmt = (n: number) => `$${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Math.round(n))}`;

/** Every balance-sheet row's values, by line (a line may have several rows). */
function histories(bs: UiReclassifiedTable | null | undefined): Array<{ line: Line; values: Record<string, number> }> {
  const out: Array<{ line: Line; values: Record<string, number> }> = [];
  for (const line of LINES) {
    for (const r of bs?.rows ?? []) {
      if (!line.row.test(r.name ?? "") || (line.notRow && line.notRow.test(r.name ?? ""))) continue;
      // Years keyed "2024" or "FY2024": by the calendar year.
      const values: Record<string, number> = {};
      for (const [k, v] of Object.entries(r.values ?? {})) {
        const y = k.match(/(?:19|20)\d{2}/g)?.pop();
        if (y && typeof v === "number") values[y] = v;
      }
      out.push({ line, values });
    }
  }
  return out;
}

export interface NoteFigureCorrection {
  stated: string;
  year: string;
  /** The year whose balance the stated figure is. */
  belongsTo: string;
  corrected: string;
}

/**
 * The text with every wrong-year balance-sheet figure corrected to the named
 * year's balance, and what was corrected.
 */
export function correctBalanceSheetFigures(text: string, bs: UiReclassifiedTable | null | undefined): { text: string; corrections: NoteFigureCorrection[] } {
  const hist = histories(bs);
  if (!text || hist.length === 0) return { text, corrections: [] };
  const corrections: NoteFigureCorrection[] = [];
  let out = text;
  for (const sentence of text.split(/(?<=[.!?;])\s+/)) {
    let fixed = sentence;
    for (const { line } of hist) {
      const named = sentence.match(line.note);
      if (!named || named.index === undefined) continue;
      // The first figure after the line's name (within the clause).
      const tail = sentence.slice(named.index + named[0].length);
      const fig = tail.match(/^[^.;$]{0,40}?(\$\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:k|m|mm|million|thousand)\b)?)/i);
      if (!fig) continue;
      const figText = fig[1];
      const figEnd = (fig.index ?? 0) + fig[0].length;
      const stated = money(figText);
      if (stated === null) continue;
      const year = tail.slice(figEnd).match(YEAR_AFTER_RE)?.[1] ?? sentence.slice(0, named.index).match(/\b(?:FY\s?)?((?:19|20)\d{2})\s*$/i)?.[1];
      if (!year) continue;
      const rows = hist.filter((h) => h.line === line);
      // Right as written for some row of the line: leave it.
      if (rows.some((h) => typeof h.values[year] === "number" && same(h.values[year], stated))) continue;
      const wrong = rows.find((h) => typeof h.values[year] === "number" && Object.entries(h.values).some(([y, v]) => y !== year && same(v, stated)));
      if (!wrong) continue;
      const belongsTo = Object.entries(wrong.values).find(([y, v]) => y !== year && same(v, stated))![0];
      const corrected = fmt(Math.abs(wrong.values[year]));
      fixed = fixed.replace(figText, corrected);
      corrections.push({ stated: figText.trim(), year, belongsTo, corrected });
    }
    if (fixed !== sentence) out = out.replace(sentence, fixed);
  }
  return { text: out, corrections };
}
