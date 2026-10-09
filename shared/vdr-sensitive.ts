/**
 * Personal numbers in data-room documents (vdr spec §4.8, V6). Pure: used by
 * the render child (PDF lines, sheets, Word, office parts), the web process
 * (text views, page text) and the tests.
 *
 * Social insurance (Canada), social security (US), payment-card and labelled
 * bank-account numbers are ALWAYS covered for buyers — on page images, page
 * text, search, sheets, Word views and downloads. There is no switch.
 *
 * Matching runs on LINES, never on single text pieces, so a number split
 * across pieces ("SIN 046 454" + "286") or across Word runs is still found,
 * and a match covers every piece it touches (fail-safe).
 *
 *   SIN   a Luhn-valid 9-digit run written 3-3-3, comb-printed, or with
 *         SIN / social insurance / S.I.N / NAS within 40 characters on the same
 *         line or on the line above — but never a Business Number (a CRA
 *         program suffix "RT0001", or "BN" / "business number" just before it)
 *         and never an amount ("$").
 *   SSN   NNN-NN-NNNN (valid ranges), or a bare / comb 9-digit run near
 *         SSN / social security, or any value in an SSN column (sheets).
 *   card  13–19 digits, Luhn-valid, a card prefix (4, 51–55, 22–27, 34/37, 6011, 65).
 *   account  only when labelled: "account no. 1234567".
 * A "digit run" is 9 digits separated only by single spaces, hyphens or dots
 * on one line ("0 4 6 4 5 4 2 8 6" is a comb-printed run).
 */

export type PersonalKind = "sin" | "ssn" | "card" | "account";
export type PersonalMatch = { kind: PersonalKind; line: number; start: number; end: number };

/** Luhn check over the digits of `s` (separators ignored). */
export function luhn(s: string): boolean {
  const d = s.replace(/\D/g, "");
  if (d.length < 2) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = d.charCodeAt(d.length - 1 - i) - 48;
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

const digitsOf = (s: string) => s.replace(/\D/g, "");

// 9 digits, single separators between them, not part of a longer number.
const RUN9 = /(?<!\d[ .\-]?)\d(?:[ .\-]?\d){8}(?![ .\-]?\d)/g;
// 13–19 digits with optional single spaces / hyphens.
const CARD_RUN = /(?<!\d[ \-]?)\d(?:[ \-]?\d){12,18}(?![ \-]?\d)/g;
const SSN_FORMAT = /(?<![\d-])(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}(?![\d-])/g;
const ACCOUNT = /\b(?:account|acct)\.?\s*(?:no\.?|number|#)\s*[:#]?\s*(\d{5,12})\b/gi;

const SIN_LABEL = /\bSIN\b|\bS\.I\.N\b|\bNAS\b|social\s+insurance/;
const SIN_LABEL_I = /social\s+insurance/i;
const SSN_LABEL = /\bSSN\b|social\s+security/i;
const BN_BEFORE = /(\bBN\b|business\s+number|num[ée]ro\s+d['’]entreprise)/i;
const CRA_SUFFIX = /^\s?R[TCPMZ]\s?\d{4}/;

function hasLabel(re: RegExp, text: string): boolean {
  return re.test(text) || (re === SIN_LABEL && SIN_LABEL_I.test(text));
}

function near(line: string, start: number, end: number, above: string | undefined, re: RegExp): boolean {
  const before = line.slice(Math.max(0, start - 40), start);
  const after = line.slice(end, end + 40);
  return hasLabel(re, before) || hasLabel(re, after) || (above !== undefined && hasLabel(re, above));
}

function isComb(s: string): boolean {
  return /^\d( \d){8}$/.test(s);
}
function is333(s: string): boolean {
  return /^\d{3}([ .\-])\d{3}\1\d{3}$/.test(s);
}

function overlaps(list: PersonalMatch[], line: number, start: number, end: number): boolean {
  return list.some((m) => m.line === line && start < m.end && end > m.start);
}

/**
 * Every personal number in `lines` (each entry one line of text, in reading
 * order). Overlapping candidates are reported once (first kind wins:
 * SSN format, SIN, card, account).
 */
export function findPersonalNumbers(lines: ReadonlyArray<string>): PersonalMatch[] {
  const out: PersonalMatch[] = [];
  lines.forEach((line, li) => {
    if (!line || !/\d/.test(line)) return;
    const above = li > 0 ? lines[li - 1] : undefined;
    // SSN written NNN-NN-NNNN.
    for (const m of Array.from(line.matchAll(SSN_FORMAT))) {
      const start = m.index!, end = start + m[0].length;
      if (!overlaps(out, li, start, end)) out.push({ kind: "ssn", line: li, start, end });
    }
    // 9-digit runs: SIN, or SSN near its label.
    for (const m of Array.from(line.matchAll(RUN9))) {
      const s = m[0];
      const start = m.index!, end = start + s.length;
      if (overlaps(out, li, start, end)) continue;
      const before20 = line.slice(Math.max(0, start - 20), start);
      if (/\$\s?$/.test(line.slice(Math.max(0, start - 2), start))) continue; // an amount
      if (near(line, start, end, above, SSN_LABEL)) {
        out.push({ kind: "ssn", line: li, start, end });
        continue;
      }
      if (!luhn(s)) continue;
      if (CRA_SUFFIX.test(line.slice(end))) continue; // a Business Number's program account (123456789 RT0001)
      if (BN_BEFORE.test(before20)) continue;
      if (is333(s) || isComb(s) || near(line, start, end, above, SIN_LABEL)) {
        out.push({ kind: "sin", line: li, start, end });
      }
    }
    // Payment cards.
    for (const m of Array.from(line.matchAll(CARD_RUN))) {
      const s = m[0];
      const start = m.index!, end = start + s.length;
      if (overlaps(out, li, start, end)) continue;
      const d = digitsOf(s);
      if (d.length < 13 || d.length > 19) continue;
      if (!/^(4|5[1-5]|2[2-7]|3[47]|6011|65)/.test(d)) continue;
      if (!luhn(d)) continue;
      out.push({ kind: "card", line: li, start, end });
    }
    // Labelled bank accounts: only the digits are covered.
    for (const m of Array.from(line.matchAll(ACCOUNT))) {
      const digits = m[1];
      const start = m.index! + m[0].lastIndexOf(digits);
      const end = start + digits.length;
      if (overlaps(out, li, start, end)) continue;
      out.push({ kind: "account", line: li, start, end });
    }
  });
  return out.sort((a, b) => a.line - b.line || a.start - b.start);
}

/** "046 454 286" → "••• ••• 286": every digit but the last 3 becomes "•", separators kept. */
export function maskNumber(s: string): string {
  const total = digitsOf(s).length;
  let seen = 0;
  return s.replace(/\d/g, (d) => {
    seen += 1;
    return seen > total - 3 ? d : "•";
  });
}

/** Applies `matches` (from findPersonalNumbers over `lines`) to those lines. */
export function applyMasks(lines: ReadonlyArray<string>, matches: ReadonlyArray<PersonalMatch>): string[] {
  const out = lines.slice();
  const byLine = new Map<number, PersonalMatch[]>();
  for (const m of matches) byLine.set(m.line, [...(byLine.get(m.line) ?? []), m]);
  byLine.forEach((ms, li) => {
    let s = out[li];
    for (const m of ms.slice().sort((a, b) => b.start - a.start)) {
      s = s.slice(0, m.start) + maskNumber(s.slice(m.start, m.end)) + s.slice(m.end);
    }
    out[li] = s;
  });
  return out;
}

/** Text with every personal number masked (line by line, labels on the line above count). */
export function maskPersonalNumbers(text: string): string {
  const lines = text.split("\n");
  const matches = findPersonalNumbers(lines);
  return matches.length === 0 ? text : applyMasks(lines, matches).join("\n");
}

/** Counts by kind, for a VdrPrepared.personal entry. */
export function personalKinds(matches: ReadonlyArray<{ kind: PersonalKind }>): PersonalKind[] {
  return Array.from(new Set(matches.map((m) => m.kind)));
}

// ── PDF lines ──────────────────────────────────────────────────────────────

/** A text piece from a PDF page (pdf.js text item), in PDF units: baseline origin bottom-left. */
export type TextPiece = { str: string; x: number; y: number; w: number; h: number };
/** One assembled line; `refs[i]` is the piece the i-th character came from (null for an inserted space). */
export type AssembledLine = { text: string; refs: Array<number | null>; y: number };

/**
 * Groups pieces into lines by baseline (|Δy| ≤ 2 pt), top to bottom, sorted by
 * x inside a line, joined with their own strings; where two pieces are more
 * than 0.25 em apart with no space between them, a space is inserted.
 */
export function assembleLines(pieces: ReadonlyArray<TextPiece>): AssembledLine[] {
  const idx = pieces.map((_, i) => i).filter((i) => pieces[i].str.length > 0);
  idx.sort((a, b) => pieces[b].y - pieces[a].y || pieces[a].x - pieces[b].x);
  const groups: number[][] = [];
  for (const i of idx) {
    const g = groups.find((gr) => Math.abs(pieces[gr[0]].y - pieces[i].y) <= 2);
    if (g) g.push(i);
    else groups.push([i]);
  }
  groups.sort((a, b) => pieces[b[0]].y - pieces[a[0]].y);
  return groups.map((g) => {
    g.sort((a, b) => pieces[a].x - pieces[b].x);
    let text = "";
    const refs: Array<number | null> = [];
    let prevEnd: number | null = null;
    for (const i of g) {
      const p = pieces[i];
      if (prevEnd !== null && text.length > 0) {
        const gap = p.x - prevEnd;
        const em = Math.max(1, p.h);
        if (gap > 0.25 * em && !/\s$/.test(text) && !/^\s/.test(p.str)) {
          text += " ";
          refs.push(null);
        }
      }
      text += p.str;
      for (let k = 0; k < p.str.length; k++) refs.push(i);
      prevEnd = Math.max(prevEnd ?? -Infinity, p.x + p.w);
    }
    return { text, refs, y: pieces[g[0]].y };
  });
}

/** The pieces a match touches (every one of them is covered). */
export function piecesTouched(line: AssembledLine, start: number, end: number): number[] {
  const set = new Set<number>();
  for (let i = start; i < end && i < line.refs.length; i++) {
    const r = line.refs[i];
    if (r !== null && r !== undefined) set.add(r);
  }
  return Array.from(set);
}

// ── Spreadsheets ───────────────────────────────────────────────────────────

const ID_COLUMN = /\b(SIN|S\.I\.N\.?|social insurance|NAS|SSN|social security|tax id|TIN)\b/i;

/** Column indexes (as given) whose header — any of the first 5 rows — names a personal number. */
export function sinColumns(firstRows: ReadonlyArray<ReadonlyArray<unknown>>): number[] {
  const cols = new Set<number>();
  for (const row of firstRows.slice(0, 5)) {
    (row ?? []).forEach((cell, c) => {
      if (typeof cell === "string" && ID_COLUMN.test(cell)) cols.add(c);
      else if (cell != null && typeof cell !== "object" && ID_COLUMN.test(String(cell))) cols.add(c);
    });
  }
  return Array.from(cols).sort((a, b) => a - b);
}

/** A value in a SIN/SSN column: 8–9 digits with or without separators (a leading zero is often lost). */
export function isIdColumnValue(v: unknown): boolean {
  if (v == null) return false;
  const s = String(v).trim();
  if (!/^[\d .\-]+$/.test(s)) return false;
  const d = digitsOf(s);
  return d.length === 8 || d.length === 9;
}

// ── Office files (docx / xlsx / pptx): every XML part ─────────────────────

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function decodeXmlText(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** An XML part's text as lines: paragraph / row / cell ends become line breaks, runs inside a paragraph join. */
export function xmlPartLines(xml: string): string[] {
  const broken = xml
    .replace(/<\/(w:p|a:p|row|si|c|text:p|p)>/g, "\n")
    .replace(/<(w:br|w:cr|a:br)\b[^>]*\/?>/g, "\n")
    .replace(/<(w:tab)\b[^>]*\/?>/g, " ")
    .replace(/<[^>]+>/g, "");
  return decodeXmlText(broken).split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
}

/**
 * Scans every XML part of an office file (headers, footers, comments,
 * footnotes, hidden sheets — everything) before an ORIGINAL download is
 * allowed. Returns how many numbers were found and in which parts.
 */
export function scanOfficeParts(entries: ReadonlyArray<{ name: string; text: string }>): { count: number; parts: string[] } {
  let count = 0;
  const parts: string[] = [];
  for (const e of entries) {
    if (!/\.(xml|rels|vml)$/i.test(e.name)) continue;
    const n = findPersonalNumbers(xmlPartLines(e.text)).length;
    if (n > 0) {
      count += n;
      parts.push(e.name);
    }
  }
  return { count, parts };
}

// ── Staff or pay records ──────────────────────────────────────────────────

const RECORD_WORDS = [/\bsalar(y|ies)\b/i, /\bwages?\b/i, /\bpayroll\b/i, /\bhourly rate\b/i, /\bSIN\b/, /\bdate of birth\b/i, /\bT4\b/];

/** True for documents that are staff or pay records (folder, subcategory or ≥ 3 telling words). */
export function personalRecordsHint(doc: { folderKey?: string | null; subcategory?: string | null }, text: string): boolean {
  if (doc.folderKey === "people.staff" || doc.folderKey === "people.agreements" || doc.folderKey === "financial.gl") return true;
  if (doc.subcategory === "addback_support") return true;
  let hits = 0;
  for (const re of RECORD_WORDS) if (re.test(text)) hits++;
  return hits >= 3;
}
