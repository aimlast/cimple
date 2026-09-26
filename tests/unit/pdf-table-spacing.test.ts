/**
 * Round A, round 2 (a-cim, ACC2-09 root): PDF table cells on one line were
 * glued together by the parser — Pacific's safety summary row
 * "2024 | 64 | 6 | 1 | 5 | 9.4%" read "2024646159.4%", which the extractor
 * turned into "646 inspections, 1 driver OOS, 5 vehicle OOS, 9.4% OOS rate".
 * Items on one line with a visible gap are now joined with a space.
 * Offline: the recorded sample PDF (fictional business) and synthetic items.
 */
import assert from "node:assert/strict";
import path from "path";
import { fileURLToPath } from "url";
import { extractTextFromFile, joinPdfTextItems } from "../../server/documents/parser";

const item = (str: string, x: number, width: number, y = 700, size = 10) => ({ str, transform: [size, 0, 0, size, x, y], width });

// Cells with gaps get a space; letters of one word (no gap) don't; a new y is a new line.
assert.equal(
  joinPdfTextItems([item("2024", 50, 22), item("64", 120, 11), item("6", 190, 6), item("1", 260, 6), item("5", 330, 6), item("9.4%", 400, 20)]),
  "2024 64 6 1 5 9.4%",
);
assert.equal(joinPdfTextItems([item("Sa", 50, 11), item("fety", 61, 19)]), "Safety", "kerned pieces of a word stay together");
assert.equal(joinPdfTextItems([item("Cash", 50, 20), item("1,022,999", 300, 45), item("Accounts receivable", 50, 90, 686), item("4,380,000", 300, 45, 686)]), "Cash 1,022,999\nAccounts receivable 4,380,000");
assert.equal(joinPdfTextItems([item("Our ", 50, 20), item("review", 70.5, 30)]), "Our review", "no double space after a space");
assert.equal(joinPdfTextItems([item("A", 50, 6), item("", 56, 0), item("B", 80, 6)]), "A B", "an empty item doesn't hide the gap");

// The real document: every inspection row reads as separate cells.
const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "documents");
const text = await extractTextFromFile(path.join(FIX, "pacific-safety-summary.pdf"), "application/pdf");
assert.match(text, /\n2022 58 9 3 6 15\.5% 8,420,000\n/);
assert.match(text, /\n2023 71 12 5 7 16\.9% 8,610,000\n/);
assert.match(text, /\n2024 64 6 1 5 9\.4% 8,930,000\n/);
assert.match(text, /National Safety Code \(BC\) NSC BC 20-487-316/);
assert.doesNotMatch(text, /2024646159\.4%/);
assert.match(text, /Prepared by Tanya Beaulieu, Safety & Compliance Manager/, "ordinary text unchanged");

console.log("pdf-table-spacing: ok");
