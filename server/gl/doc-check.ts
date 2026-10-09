/**
 * doc-check.ts — is the amount the seller typed on their T4 / payroll
 * summary / invoice actually written on it? (gl spec §6.8). Deterministic:
 * the document's text (read by the normal document reader) is scanned for
 * the number. Never a reading of the form itself: anything not found is
 * left for the broker to check.
 */
import { parseFigures } from "../cim/figure-check";

export type DocAmountCheck = "found_in_document" | "not_found" | "unreadable";

/** "found_in_document" when the typed amount (cents) is written in the text, with or without cents; "unreadable" when there's no text to look in. */
export function amountAppearsIn(text: string | null | undefined, cents: number): DocAmountCheck {
  const t = (text ?? "").trim();
  if (t.replace(/[^a-z0-9]/gi, "").length < 12) return "unreadable";
  const dollars = Math.abs(cents) / 100;
  const wanted = [dollars, Math.round(dollars)];
  const close = (v: number) => wanted.some((w) => Math.abs(v - w) < 0.005);
  for (const f of parseFigures(t)) {
    if (f.kind === "percent") continue;
    if (close(f.value)) return "found_in_document";
  }
  // Box-style printing: "240000 00" or "240 000.00" (spaces as thousands separators).
  const squashed = t.replace(/(\d)[  ](?=\d{3}\b)/g, "$1");
  for (const m of Array.from(squashed.matchAll(/\b(\d{1,9})(?:[.,\s](\d{2}))?\b/g))) {
    const v = Number(m[1]) + (m[2] ? Number(m[2]) / 100 : 0);
    if (close(v)) return "found_in_document";
  }
  return "not_found";
}
