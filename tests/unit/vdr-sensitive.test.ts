/**
 * vdr spec §4.8 / V6: personal numbers are always covered.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/vdr-sensitive.test.ts
 * 046 454 286 is a Luhn-valid TEST social insurance number (never a real person's).
 */
import assert from "node:assert/strict";
import {
  luhn,
  findPersonalNumbers,
  maskPersonalNumbers,
  maskNumber,
  assembleLines,
  piecesTouched,
  sinColumns,
  isIdColumnValue,
  scanOfficeParts,
  xmlPartLines,
  personalRecordsHint,
} from "../../shared/vdr-sensitive";

const kinds = (lines: string[]) => findPersonalNumbers(lines).map((m) => m.kind);

// Luhn
assert.equal(luhn("046 454 286"), true);
assert.equal(luhn("046454287"), false);
assert.equal(luhn("4111 1111 1111 1111"), true);

// SIN: 3-3-3 with separators, Luhn-valid → covered
assert.deepEqual(kinds(["Shareholder 046 454 286"]), ["sin"]);
assert.deepEqual(kinds(["046-454-286"]), ["sin"]);
// Luhn-invalid 3-3-3 (an amount like 123 456 789 without a label) → not covered
assert.deepEqual(kinds(["Total 123 456 789"]), []);
// Bare Luhn-valid 9 digits without a label → not covered (could be anything)
assert.deepEqual(kinds(["Ref 046454286"]), []);
// …with a label on the same line or the line above → covered
assert.deepEqual(kinds(["SIN: 046454286"]), ["sin"]);
assert.deepEqual(kinds(["Social insurance number", "046454286"]), ["sin"]);
assert.deepEqual(kinds(["NAS 046454286"]), ["sin"]);
// Comb-printed → covered
assert.deepEqual(kinds(["0 4 6 4 5 4 2 8 6"]), ["sin"]);
// Business Numbers: a CRA program suffix or a "BN" label → never covered
assert.deepEqual(kinds(["046 454 286 RT0001"]), []);
assert.deepEqual(kinds(["046454286RC0001"]), []);
assert.deepEqual(kinds(["Business number 046 454 286"]), []);
assert.deepEqual(kinds(["BN 046 454 286"]), []);
// Amounts and phone numbers are not personal numbers
assert.deepEqual(kinds(["Phone 416-555-0199"]), []);
assert.deepEqual(kinds(["Revenue $29,180,000"]), []);
assert.deepEqual(kinds(["$046 454 286"]), [], "a dollar amount is never a SIN");
// Not inside a longer grouped number
assert.deepEqual(kinds(["12 046 454 286 9"]), []);

// SSN
assert.deepEqual(kinds(["SSN 123-45-6789"]), ["ssn"]);
assert.deepEqual(kinds(["123-45-6789"]), ["ssn"]);
assert.deepEqual(kinds(["000-45-6789"]), [], "invalid area");
assert.deepEqual(kinds(["Social security: 123456789"]), ["ssn"], "bare under an SSN label");
assert.deepEqual(kinds(["SSN", "1 2 3 4 5 6 7 8 9"]), ["ssn"], "comb under a label on the line above");

// Cards (Luhn + prefix)
assert.deepEqual(kinds(["Visa 4111 1111 1111 1111"]), ["card"]);
assert.deepEqual(kinds(["5500-0000-0000-0004"]), ["card"]);
assert.deepEqual(kinds(["4111 1111 1111 1112"]), [], "Luhn fails");
assert.deepEqual(kinds(["9111 1111 1111 1111"]), [], "no card prefix");

// Accounts: only when labelled, only the digits
const acct = findPersonalNumbers(["Account no. 1234567 at RBC"]);
assert.equal(acct.length, 1);
assert.equal(acct[0].kind, "account");
assert.equal("Account no. 1234567 at RBC".slice(acct[0].start, acct[0].end), "1234567");
assert.deepEqual(kinds(["1234567"]), []);

// Masking keeps separators and the last 3 digits
assert.equal(maskNumber("046 454 286"), "••• ••• 286");
assert.equal(maskNumber("046-454-286"), "•••-•••-286");
assert.equal(maskPersonalNumbers("Owner SIN 046 454 286, born 1970"), "Owner SIN ••• ••• 286, born 1970");
assert.equal(maskPersonalNumbers("Account #: 987654321 (chequing)"), "Account #: ••••••321 (chequing)");
assert.equal(maskPersonalNumbers("No numbers here"), "No numbers here");

// Split across PDF text pieces: "SIN 046 454" + "286" (same baseline, a gap) → one line, both pieces touched
{
  const pieces = [
    { str: "SIN 046 454", x: 72, y: 700, w: 70, h: 12 },
    { str: "286", x: 146, y: 700.5, w: 20, h: 12 },
    { str: "Next line", x: 72, y: 680, w: 50, h: 12 },
  ];
  const lines = assembleLines(pieces);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].text, "SIN 046 454 286", "a space is inserted across the gap");
  const m = findPersonalNumbers(lines.map((l) => l.text));
  assert.equal(m.length, 1);
  assert.deepEqual(piecesTouched(lines[m[0].line], m[0].start, m[0].end).sort(), [0, 1], "the match covers every piece it touches");
  // Pieces that touch (no gap) are joined without a space
  const joined = assembleLines([{ str: "04", x: 10, y: 5, w: 10, h: 10 }, { str: "6", x: 20, y: 5, w: 5, h: 10 }]);
  assert.equal(joined[0].text, "046");
}

// Spreadsheet column rule: header in the first 5 rows; 8–9 digits, leading zero lost
assert.deepEqual(sinColumns([["Name", "Employee SIN", "Wage"], ["A", "46454286", "20"]]), [1]);
assert.deepEqual(sinColumns([["Title"], [], ["Name", "SSN"]]), [1]);
assert.deepEqual(sinColumns([["Name", "Sales"]]), []);
assert.equal(isIdColumnValue("46454286"), true);
assert.equal(isIdColumnValue("046 454 286"), true);
assert.equal(isIdColumnValue("12345"), false);
assert.equal(isIdColumnValue("John"), false);

// Office parts: runs inside a paragraph join (bold "046 454" + plain " 286"); headers and comments are scanned
{
  const docXml = '<w:document><w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>SIN 046 454</w:t></w:r><w:r><w:t xml:space="preserve"> 286</w:t></w:r></w:p><w:p><w:r><w:t>Nothing</w:t></w:r></w:p></w:body></w:document>';
  assert.deepEqual(xmlPartLines(docXml), ["SIN 046 454 286", "Nothing"]);
  const header = '<w:hdr><w:p><w:r><w:t>Employee 046-454-286</w:t></w:r></w:p></w:hdr>';
  const comments = '<w:comments><w:comment><w:p><w:r><w:t>card 4111 1111 1111 1111</w:t></w:r></w:p></w:comment></w:comments>';
  const r = scanOfficeParts([
    { name: "word/document.xml", text: docXml },
    { name: "word/header1.xml", text: header },
    { name: "word/comments.xml", text: comments },
    { name: "word/media/image1.png", text: "046 454 286" },
  ]);
  assert.equal(r.count, 3);
  assert.deepEqual(r.parts.sort(), ["word/comments.xml", "word/document.xml", "word/header1.xml"]);
  // A hidden sheet's shared strings (xlsx) are scanned the same way
  const ss = scanOfficeParts([{ name: "xl/sharedStrings.xml", text: "<sst><si><t>SIN 046454286</t></si></sst>" }]);
  assert.equal(ss.count, 1);
}

// Staff or pay records
assert.equal(personalRecordsHint({ folderKey: "people.staff" }, ""), true);
assert.equal(personalRecordsHint({ folderKey: "financial.gl" }, ""), true);
assert.equal(personalRecordsHint({ subcategory: "addback_support" }, ""), true);
assert.equal(personalRecordsHint({ folderKey: "financial.tax" }, "Salary and wages, payroll remittance, T4 slips"), true);
assert.equal(personalRecordsHint({ folderKey: "financial.tax" }, "Revenue and expenses"), false);

console.log("vdr sensitive: ok");
