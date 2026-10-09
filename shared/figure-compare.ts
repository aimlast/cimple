/**
 * figure-compare — the arithmetic behind the due-diligence checks and the
 * worked-out notes (stream "dd", spec D5–D7, D11). Pure; no AI, no I/O.
 *
 *   sizeOf                 how big a difference is (match / rounding / minor / material)
 *   reconcileByComponents  D6: a difference that equals 1–2 same-year lines (3 for known families), uniquely
 *   decomposeMovement      D7: the ≤ 3 lines that moved a total (≥ 70% of the change)
 *   locatedIn / pageAt     D11: a figure found in a document's text, with digit boundaries
 */

export type DiffSize = "match" | "rounding" | "minor" | "material";

/**
 * The difference `other − base`. Expenses compare as amounts (parentheses and
 * minus signs mean the same cost); `signed` lines — revenue, profits, net
 * income, other income, EBITDA — keep their sign, so a $50,000 loss never
 * "matches" a $50,000 profit (checker r2 R2-7).
 */
export function differenceOf(base: number, other: number, signed = false): number {
  return signed ? other - base : Math.abs(other) - Math.abs(base);
}

/**
 * D5 size of `other − base`: `match` within $1 or 0.05%; `rounding` within
 * $100 or 0.1%; `material` at least $2,500 AND (at least 1% of the figure or
 * 0.5% of that year's revenue); else `minor`. Signs don't matter for an
 * expense; for a `signed` line (not an expense) they do.
 */
export function sizeOf(base: number, other: number, revenueOfYear?: number | null, opts: { signed?: boolean } = {}): DiffSize {
  const d = Math.abs(differenceOf(base, other, !!opts.signed));
  const ref = Math.max(Math.abs(base), Math.abs(other));
  if (d <= 1 || (ref > 0 && d / ref <= 0.0005)) return "match";
  if (d <= 100 || (ref > 0 && d / ref <= 0.001)) return "rounding";
  const rev = Math.abs(revenueOfYear ?? 0);
  if (d >= 2500 && ((ref > 0 && d / ref >= 0.01) || (rev > 0 && d / rev >= 0.005))) return "material";
  return "minor";
}

/** Within rounding: the figures agree. */
export function agrees(size: DiffSize): boolean {
  return size === "match" || size === "rounding";
}

export interface ComponentLine {
  /** A figure key or line id. */
  id: string;
  label: string;
  /** The amount (sign ignored: components are summed as absolute amounts). */
  value: number;
}

export interface Reconciliation {
  components: ComponentLine[];
  /** True when the subset came from the known family (D6), else from the general search. */
  family: boolean;
}

/**
 * D6: |diff| equals, within $1, the sum of 1–2 lines of `pool` — or 1–3
 * lines of `familyPool` (the known families are tried first) — and that
 * subset is the ONLY one of its size that does. Null otherwise (no claim).
 */
export function reconcileByComponents(diff: number, pool: ComponentLine[], familyPool: ComponentLine[] = []): Reconciliation | null {
  const target = Math.abs(diff);
  if (target <= 1) return null;
  const fam = dedupe(familyPool);
  for (let size = 1; size <= Math.min(3, fam.length); size++) {
    const hits = subsetsSumming(fam, size, target);
    if (hits.length === 1) return { components: hits[0], family: true };
    if (hits.length > 1) return null; // ambiguous: claim nothing
  }
  const general = dedupe(pool).filter((l) => Math.abs(l.value) > 0);
  for (let size = 1; size <= Math.min(2, general.length); size++) {
    const hits = subsetsSumming(general, size, target);
    if (hits.length === 1) return { components: hits[0], family: false };
    if (hits.length > 1) return null;
  }
  return null;
}

function dedupe(lines: ComponentLine[]): ComponentLine[] {
  const seen = new Set<string>();
  return lines.filter((l) => Number.isFinite(l.value) && !seen.has(l.id) && (seen.add(l.id), true));
}

function subsetsSumming(lines: ComponentLine[], size: number, target: number): ComponentLine[][] {
  const out: ComponentLine[][] = [];
  const n = lines.length;
  const pick = (start: number, chosen: ComponentLine[], sum: number) => {
    if (out.length > 1) return; // two are enough to know it is ambiguous
    if (chosen.length === size) {
      if (Math.abs(sum - target) <= 1) out.push([...chosen]);
      return;
    }
    for (let i = start; i < n; i++) {
      chosen.push(lines[i]);
      pick(i + 1, chosen, sum + Math.abs(lines[i].value));
      chosen.pop();
    }
  };
  pick(0, [], 0);
  return out;
}

export interface MovementPart {
  id: string;
  label: string;
  from: number;
  to: number;
  /** to − from. */
  delta: number;
}

export interface MovementBreakdown {
  delta: number;
  /** ≤ 3 parts, largest change first, moving the same way as the total. */
  parts: MovementPart[];
  /** Share of the change the parts cover (0–1). */
  covered: number;
}

/**
 * D7: the components that moved a total — at most 3, covering ≥ 70% of the
 * change, largest change first (ties in the input's order), all moving the
 * same way as the total. Null when no such set exists (or nothing moved).
 * Expense components are given as positive amounts.
 */
export function decomposeMovement(total: { from: number; to: number }, components: Array<{ id: string; label: string; from: number; to: number }>): MovementBreakdown | null {
  const delta = total.to - total.from;
  if (Math.abs(delta) < 1) return null;
  const sign = Math.sign(delta);
  const parts = components
    .map((c, i) => ({ id: c.id, label: c.label, from: c.from, to: c.to, delta: c.to - c.from, i }))
    .filter((c) => Math.sign(c.delta) === sign && Math.abs(c.delta) >= 1)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.i - b.i);
  const chosen: MovementPart[] = [];
  let sum = 0;
  for (const p of parts) {
    if (chosen.length >= 3) break;
    chosen.push({ id: p.id, label: p.label, from: p.from, to: p.to, delta: p.delta });
    sum += Math.abs(p.delta);
    if (sum >= 0.7 * Math.abs(delta)) return { delta, parts: chosen, covered: Math.min(1, sum / Math.abs(delta)) };
  }
  return null;
}

// ── Located in the document's text (D11) ─────────────────────────────────

export interface Located {
  index: number;
  page: number | null;
  /** The text just before the figure on its line (the document's own line label), ≤ 60 chars; null when there is none. */
  sourceLabel: string | null;
}

/** The ways a whole-dollar amount can be printed. */
function spellings(value: number): string[] {
  const n = Math.round(Math.abs(value));
  const plain = String(n);
  const grouped = n.toLocaleString("en-US");
  return grouped === plain ? [plain] : [grouped, plain];
}

/** Text ending in a complete comma-grouped number ("…debt41,000"). */
const GLUED_BEFORE = /(?:^|[^\d,.])\d{1,3}(?:,\d{3})+$/;
/** Text starting with a complete comma-grouped number ("1,931,000\n"). */
const GLUED_AFTER = /^\d{1,3}(?:,\d{3})+(?![\d,]|\.\d)/;

/**
 * Where `value` is printed in `text`, with digit boundaries: "98,000" is
 * never found inside "1,398,000" or "98,0001", but "…charges86,000" and
 * "$341,010$297,642" are found. The first occurrence wins — the first one
 * `accept` takes, when given. Null = not found.
 */
export function locatedIn(text: string | null | undefined, value: number, accept?: (hit: Located) => boolean): Located | null {
  if (!text || !Number.isFinite(value) || Math.round(Math.abs(value)) === 0) return null;
  for (const needle of spellings(value)) {
    let from = 0;
    while (from <= text.length) {
      const i = text.indexOf(needle, from);
      if (i < 0) break;
      from = i + 1;
      const grouped = needle.includes(",");
      const before = text.slice(Math.max(0, i - 24), i);
      const after = text.slice(i + needle.length, i + needle.length + 24);
      // Part of a longer number on the left: "1,398,000" / "1398000" / "1.398". A
      // whole grouped figure glued before it (a statement's other column,
      // "…debt41,00029,000") is a separate number.
      if (/\d[,.]$/.test(before)) continue;
      if (/\d$/.test(before) && !(grouped && GLUED_BEFORE.test(before))) continue;
      // Part of a longer number on the right: "98,0001", "98,000,000", "98,000.5"; ".00" cents are fine.
      // A whole grouped figure glued after it ("2,048,0001,931,000") is the next column.
      if (/^,\d/.test(after)) continue;
      if (/^\d/.test(after) && !(grouped && GLUED_AFTER.test(after))) continue;
      if (/^\.\d/.test(after) && !/^\.00?(?!\d)/.test(after)) continue;
      const hit = { index: i, page: pageAt(text, i), sourceLabel: sourceLabelAt(text, i) };
      // `accept` (a figure the broker typed): only an occurrence on the right line counts.
      if (accept && !accept(hit)) continue;
      return hit;
    }
  }
  return null;
}

/**
 * The page a position falls on: from "Page N of M" footers (the page after
 * the last footer before it), else form feeds, else a "Page N" header line.
 * Null when the text carries no page marks.
 */
export function pageAt(text: string, index: number): number | null {
  const footers = Array.from(text.matchAll(/\bPage\s+(\d{1,3})\s+of\s+(\d{1,3})\b/gi));
  if (footers.length > 0) {
    let page = 1;
    let max = 0;
    for (const m of footers) {
      max = Math.max(max, Number(m[2]));
      if ((m.index ?? 0) < index) page = Number(m[1]) + 1;
    }
    return max > 0 ? Math.min(page, max) : page;
  }
  if (text.includes("\f")) {
    let page = 1;
    for (let i = text.indexOf("\f"); i >= 0 && i < index; i = text.indexOf("\f", i + 1)) page++;
    return page;
  }
  const headers = Array.from(text.matchAll(/^\s*(?:-+\s*)?page\s+(\d{1,3})\b/gim));
  if (headers.length > 0) {
    let page: number | null = null;
    for (const m of headers) if ((m.index ?? 0) <= index) page = Number(m[1]);
    return page ?? 1;
  }
  return null;
}

/**
 * The document's own label for the figure: the text before it on its line,
 * without a GIFI code glued to the front ("8710Interest and bank charges86,000"
 * → "Interest and bank charges"), cut at the first figure, ≤ 60 characters.
 */
export function sourceLabelAt(text: string, index: number): string | null {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  let line = text.slice(lineStart, index);
  line = line.replace(/^\s*(?:\d{3,4}|--)\s*(?=[A-Za-z])/, "");
  const m = line.match(/^[^$\d]*[A-Za-z][^$\d]*/);
  if (!m) return null;
  let label = m[0].replace(/[\s.:\-–—_|$(]+$/g, "").replace(/\s+/g, " ").trim();
  if (!/[A-Za-z]{2}/.test(label)) return null;
  if (label.length > 60) {
    const cut = label.slice(label.length - 60);
    const sp = cut.indexOf(" ");
    label = sp > 0 && sp < 20 ? cut.slice(sp + 1) : cut;
  }
  return label;
}

// ── Formatting ───────────────────────────────────────────────────────────

/** "$1,234,567" (no sign; callers add "+"/"−"). */
export function dollars(n: number): string {
  return `$${Math.round(Math.abs(n)).toLocaleString("en-US")}`;
}

/** "+$33,000" / "−$155,000". */
export function signedDollars(n: number): string {
  const r = Math.round(n);
  return `${r < 0 ? "−" : "+"}${dollars(r)}`;
}

/**
 * A share of `base`: differences read with one decimal ("12.3%"), changes
 * as whole percents ("33%"; one decimal under 1%). Null when base is 0.
 */
export function percentOf(part: number, base: number, style: "difference" | "change" = "difference"): string | null {
  if (!base) return null;
  const p = Math.abs(part / base) * 100;
  if (!Number.isFinite(p)) return null;
  if (style === "change" && p >= 1) return `${Math.round(p)}%`;
  return `${p.toFixed(1).replace(/\.0$/, "")}%`;
}
