/**
 * figure-check — every figure a CIM section shows must come from the deal.
 *
 * After a section is written, its currency amounts and percentages (in
 * financial tables, bridges, charts, key-number grids and the cover) are
 * matched against the numbers in the knowledge base the writer was given —
 * the facts, the resolved discrepancies and the computed AUTHORITATIVE
 * FINANCIALS block. A figure with no source is named in a warning ("row
 * 'Operating expenses', 2024: $26,480,000"), as is a table that doesn't add
 * up (revenue − cost of sales − operating expenses ≠ EBITDA), a bridge whose
 * steps don't reach its total, and a customer/supplier chart naming a
 * company that isn't on file.
 *
 * Rounding is allowed both ways ("$3.9M" matches 3,897,000), at the
 * precision the figure is written with. Pure: no database, no AI.
 */

export interface Figure {
  value: number;
  /** Half the unit of the last written digit, in the figure's own scale. */
  tolerance: number;
  kind: "money" | "percent" | "plain";
  text: string;
}

const SCALE: Record<string, number> = {
  k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9,
};

// $1,234,567 · $3.9M · 3.9 million · 22.0% · (78,000) · $1.1–1.2M (range: the suffix applies to both)
const FIGURE_RE =
  /(?:(\$|CA\$|US\$|C\$)\s?)?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?:\s?(?:-|–|—|to)\s?\$?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?))?(?:\s?(%)|([kKmMbB]{1,2}|bn)\b|\s(thousand|million|billion)\b)?/g;

function one(numText: string, currency: boolean, pctSign: string | undefined, suffix: string | undefined, raw: string): Figure {
  const clean = numText.replace(/,/g, "");
  const decimals = clean.includes(".") ? clean.split(".")[1].length : 0;
  const scale = suffix ? SCALE[suffix.toLowerCase()] ?? 1 : 1;
  const value = Number(clean) * scale;
  const tolerance = (Math.pow(10, -decimals) * scale) / 2;
  const kind: Figure["kind"] = pctSign ? "percent" : currency || suffix ? "money" : "plain";
  return { value, tolerance, kind, text: raw.trim() };
}

/** Every number written in a piece of text, with its scale and precision. */
export function parseFigures(text: string): Figure[] {
  const out: Figure[] = [];
  if (!text) return out;
  for (const m of Array.from(text.matchAll(FIGURE_RE))) {
    const [raw, cur, a, b, pctSign, sfx, word] = m;
    // Part of a word or an identifier ("Q4", "H2O", "B2B", "484110"-style codes are kept as plain).
    const before = m.index! > 0 ? text[m.index! - 1] : "";
    if (/[A-Za-z_]/.test(before)) continue;
    const suffix = sfx || word;
    out.push(one(a, !!cur, pctSign, suffix, raw));
    if (b) out.push(one(b, !!cur, pctSign, suffix, raw));
  }
  return out;
}

/** The numbers a section may use: everything written in the knowledge base. */
/** One year of the analysis's EBITDA/SDE bridge: a waterfall starting at its net income must use its lines. */
export interface KnownBridge {
  year: string;
  /** "Adjusted EBITDA" / "SDE". */
  label: string;
  /** Net income, where the bridge starts. */
  start: number;
  /** Every approved add-back / deduction amount for the year (SDE-only ones too). */
  steps: number[];
  /** The totals a bar may show: the adjusted metric, and SDE when there is one. */
  totals: number[];
}

export interface KnownFigures {
  money: Figure[];
  percent: Figure[];
  /** Normalised knowledge-base text, for name look-ups. */
  text: string;
  /** The analysis bridge, year by year (when the deal has one). */
  bridges?: KnownBridge[];
}

export function normalizeForLookup(s: string): string {
  return ` ${s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim()} `;
}

export function knownFiguresFrom(kbText: string, bridges?: KnownBridge[]): KnownFigures {
  const figs = parseFigures(kbText);
  return {
    money: figs.filter((f) => f.kind !== "percent"),
    percent: figs.filter((f) => f.kind === "percent"),
    text: normalizeForLookup(kbText),
    bridges: bridges && bridges.length > 0 ? bridges : undefined,
  };
}

/**
 * Does the knowledge-base figure `k` round to the written figure (value `v`,
 * written to precision `vTol`)? Only the written figure's precision counts:
 * "$3.9M" traces to 3,897,000, but "$3,910,000" does not trace to "$3.9M" —
 * a vague figure on file never vouches for a precise one written from it
 * (a "$5M" fact used to validate an invented $5,440,500 subtotal, and
 * "$4.4M"-style facts let invented EBITDA figures through).
 */
function near(v: number, vTol: number, k: Figure): boolean {
  const a = Math.abs(v);
  const b = Math.abs(k.value);
  // Rounding of the written figure, plus a hair for float noise.
  return Math.abs(a - b) <= vTol + 1e-6 * Math.max(1, b);
}

/**
 * Is this written figure backed by a number in the knowledge base? Plain
 * numbers in tables and charts may be written in $000s or $M, so those try
 * each scale.
 */
export function isKnownFigure(f: Figure, known: KnownFigures, opts: { scaleVariants?: boolean } = {}): boolean {
  if (f.kind === "percent") return known.percent.some((k) => near(f.value, f.tolerance, k));
  const scales = f.kind === "plain" && opts.scaleVariants ? [1, 1e3, 1e6] : [1];
  return scales.some((s) => known.money.some((k) => near(f.value * s, f.tolerance * s, k)));
}

/** Figures worth checking: money and percentages; plain numbers only when big enough to be amounts. */
function checkable(f: Figure, allowPlain: boolean): boolean {
  if (f.kind === "percent") return true;
  if (f.kind === "money") return f.value !== 0;
  if (!allowPlain) return false;
  // A bare year or a small count (trucks, staff, days) is not an amount.
  if (Number.isInteger(f.value) && f.value >= 1900 && f.value <= 2100 && !f.text.includes(",")) return false;
  return Math.abs(f.value) >= 1000 || f.text.includes(",");
}

// ── Section walkers ──────────────────────────────────────────────────────

interface SectionLike {
  sectionKey?: string;
  sectionTitle: string;
  layoutType: string;
  layoutData: unknown;
  tags?: unknown;
}

type Cell = { where: string; text: string; allowPlain: boolean };

const asArr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
/** A unit saying the values are percentages ("%", "(%)", "% of revenue") — not a note like "8.6% margin". */
const PERCENT_UNIT = /(?:^|[^\d.])%/;
const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

function cellsOf(section: SectionLike): Cell[] {
  const d = (section.layoutData ?? {}) as Record<string, any>;
  const cells: Cell[] = [];
  switch (section.layoutType) {
    case "financial_table": {
      const headers = asArr(d.headers).map(str);
      const rowsOf = (rows: any[], tag: string) =>
        rows.forEach((r) =>
          asArr(r?.values).forEach((v, i) =>
            cells.push({ where: `${tag}row "${str(r?.label)}"${headers[i + 1] ? `, ${headers[i + 1]}` : ""}`, text: str(v), allowPlain: true }),
          ),
        );
      rowsOf(asArr(d.rows), "");
      rowsOf(asArr(d.normalizedRows), "normalized ");
      break;
    }
    case "waterfall_chart":
      asArr(d.items).forEach((it) => cells.push({ where: `bar "${str(it?.label)}"`, text: str(it?.value), allowPlain: true }));
      break;
    case "bar_chart":
    case "horizontal_bar_chart":
    case "pie_chart":
    case "donut_chart":
      asArr(d.data).forEach((it) => {
        cells.push({ where: `"${str(it?.name)}"`, text: `${str(it?.value)}${typeof it?.value === "number" && PERCENT_UNIT.test(str(d.unit)) ? "%" : ""}`, allowPlain: true });
        if (it?.secondaryValue !== undefined) cells.push({ where: `"${str(it?.name)}" (second value)`, text: str(it.secondaryValue), allowPlain: true });
      });
      if (d.centerValue) cells.push({ where: "centre figure", text: str(d.centerValue), allowPlain: false });
      break;
    case "line_chart": {
      const keys = asArr(d.series).map((s) => str(s?.key)).filter(Boolean);
      asArr(d.data).forEach((pt) =>
        keys.forEach((k) => pt && pt[k] !== undefined && cells.push({ where: `"${str(pt?.name)}" ${k}`, text: `${str(pt[k])}${PERCENT_UNIT.test(str(d.unit)) ? "%" : ""}`, allowPlain: true })),
      );
      break;
    }
    case "metric_grid":
      asArr(d.metrics).forEach((m) => cells.push({ where: `metric "${str(m?.label)}"`, text: `${str(m?.value)}${PERCENT_UNIT.test(str(m?.unit)) && !/[%$]/.test(str(m?.value)) ? "%" : ""}`, allowPlain: false }));
      break;
    case "stat_callout":
      cells.push({ where: `"${str(d.primaryLabel)}"`, text: str(d.primaryValue), allowPlain: false });
      asArr(d.secondaryStats).forEach((s) => cells.push({ where: `"${str(s?.label)}"`, text: str(s?.value), allowPlain: false }));
      break;
    case "cover_page":
      for (const k of ["askingPrice", "revenue", "ebitda", "sde"]) if (d[k]) cells.push({ where: `cover ${k}`, text: str(d[k]), allowPlain: true });
      break;
    case "two_column":
      // A column may hold a structured layout of its own (a metric grid, a chart).
      for (const side of ["left", "right"] as const) {
        const col = d[side];
        if (col && typeof col.content === "object" && col.content && typeof col.layoutType === "string") {
          for (const c of cellsOf({ sectionTitle: section.sectionTitle, layoutType: col.layoutType, layoutData: col.content })) {
            cells.push({ ...c, where: `${side} column ${c.where}` });
          }
        }
      }
      break;
    default:
      break;
  }
  return cells;
}

/** A value written in a chart may be in the chart's unit ("$M", "$000s"): make the scale explicit. */
function withChartUnit(text: string, unit: string): string {
  if (!/^\s*-?\d[\d,]*(\.\d+)?\s*$/.test(text)) return text;
  if (/\$?\s*m(illions?)?\b|\$mm/i.test(unit)) return `$${text.trim()}M`;
  if (/000s|thousands|\$k\b/i.test(unit)) return `$${text.trim()}K`;
  return text;
}

/** Figures in the section that the knowledge base doesn't back. */
function unknownFigures(section: SectionLike, known: KnownFigures): string[] {
  const d = (section.layoutData ?? {}) as Record<string, any>;
  const unit = str(d.unit || d.currency || d.yLabel || d.caption);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const cell of cellsOf(section)) {
    const text = section.layoutType === "financial_table" ? cell.text : withChartUnit(cell.text, unit);
    for (const f of parseFigures(text)) {
      if (!checkable(f, cell.allowPlain)) continue;
      if (isKnownFigure(f, known, { scaleVariants: cell.allowPlain })) continue;
      const msg = `${cell.where}: ${f.text}`;
      if (!seen.has(msg)) {
        seen.add(msg);
        out.push(msg);
      }
    }
  }
  return out;
}

// ── Reconciliation ───────────────────────────────────────────────────────

interface Amount {
  value: number;
  /** Rounding of the written figure, in the table's own scale. */
  tol: number;
}

function amountOf(text: string): Amount | null {
  const t = text.trim();
  if (!t || t === "—" || t === "-") return null;
  const negative = /^\(.*\)$/.test(t) || /^[-−–]/.test(t);
  const f = parseFigures(t.replace(/[()−–]/g, ""))[0];
  if (!f || f.kind === "percent") return null;
  return { value: negative ? -Math.abs(f.value) : f.value, tol: f.tolerance };
}

function amount(text: string): number | null {
  return amountOf(text)?.value ?? null;
}

const ROW_PATTERNS = {
  revenue: /^(total\s+)?(net\s+)?(revenue|sales|net sales|gross revenue)s?$/i,
  cogs: /^(total\s+)?(cost of (goods sold|sales|revenue|services)|cogs|direct (operating )?costs?)$/i,
  gross: /^gross (profit|margin \$)$/i,
  opex: /^(total\s+)?(operating expenses|opex|general (and|&) administrative( expenses)?|sg&a|overhead( expenses)?)$/i,
  ebitda: /^(reported\s+)?ebitda$/i,
};
/** A row that states the sum of the lines above it ("Total Operating Expenses", "Subtotal"). */
const SUM_LABEL = /^(sub)?total\b|\btotal$/i;
/** Statement rows that are results, not lines of a subtotal (revenue, gross profit, EBITDA, net income). */
const STATEMENT_ROW =
  /^(net\s+)?(revenue|sales|gross revenue)s?$|^(cost of (goods sold|sales|revenue|services)|cogs)$|^gross (profit|margin \$)$|^(reported\s+|adjusted\s+)?ebitda$|^(net (income|profit|earnings)|(income|earnings) before (income )?tax(es)?|operating (income|profit)|ebit)$/i;
/** A breakdown of the line above ("of which owner compensation"), not a line of its own. */
const BREAKDOWN_LABEL = /^(of which|incl(uding|\.)?|includes)\b/i;
/** Lines that add to earnings rather than cost (other income, a gain on sale). */
const INCOME_LABEL = /\b(income|gain|recover(y|ies)|rebate)\b/i;

interface TableRow {
  label: string;
  /** The label without a trailing "(…)" note. */
  bare: string;
  amounts: Array<Amount | null>;
  /** A heading row with no amounts ("Operating Expenses" over its lines). */
  header: boolean;
  /** A heading that carries its group's amounts ("Revenue $6,212,400" over the service lines). */
  headTotal: boolean;
  total: boolean;
  /** A result row (revenue, gross profit, EBITDA, net income) — never a line of a subtotal. */
  statement: boolean;
}

function tableRows(d: Record<string, any>, cols: number): TableRow[] {
  const out: TableRow[] = [];
  for (const r of asArr(d.rows)) {
    const label = str(r?.label).trim();
    const values = asArr(r?.values).map(str);
    // Percentage rows (margins, growth) are not amounts.
    if (values.some((v) => /%/.test(v))) continue;
    const amounts = Array.from({ length: cols }, (_, i) => amountOf(values[i] ?? ""));
    const has = amounts.some(Boolean);
    const bare = label.replace(/\s*\(.*?\)\s*$/, "").trim();
    const headTotal = !!r?.isSectionHeader && has;
    out.push({
      label,
      bare,
      amounts,
      header: !has,
      headTotal,
      total: headTotal || !!r?.isTotal || SUM_LABEL.test(label),
      statement: STATEMENT_ROW.test(bare) && !SUM_LABEL.test(label),
    });
  }
  return out;
}

/** The row a pattern names; with several (a "Revenue" line and "Total Revenue"), the last total, else the last. */
function pickRow(rows: TableRow[], re: RegExp): TableRow | null {
  const hits = rows.filter((r) => !r.header && re.test(r.bare));
  if (hits.length <= 1) return hits[0] ?? null;
  const totals = hits.filter((r) => r.total);
  const pool = totals.length > 0 ? totals : hits;
  return pool[pool.length - 1];
}

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

/**
 * Tables whose rows don't add up: a "Total …" row that isn't the sum of the
 * lines above it, revenue − cost of sales ≠ gross profit, and an EBITDA that
 * isn't gross profit less the expenses printed between them. Heading rows
 * ("Operating Expenses" over its lines), margin rows and a "Revenue" heading
 * beside "Total Revenue" no longer switch the check off — the writer's
 * normal style used to disable it (Pacific 2026-09-25: an invented
 * "Total Operating Expenses (recurring)" went unflagged).
 */
function reconcileTable(section: SectionLike): string[] {
  const d = (section.layoutData ?? {}) as Record<string, any>;
  const headers = asArr(d.headers).map(str);
  const cols = headers.length > 1 ? headers.length - 1 : Math.max(0, ...asArr(d.rows).map((r) => asArr(r?.values).length));
  const rows = tableRows(d, cols);
  const out: string[] = [];
  const colName = (i: number) => headers[i + 1] || `column ${i + 1}`;
  // Written rounding of every figure involved, else 0.5% of the target.
  const off = (a: number, b: number, tol: number) => Math.abs(a - b) > Math.max(tol, Math.abs(b) * 0.005) + 1e-6;
  const tolOf = (xs: Array<Amount | null | undefined>) => xs.reduce((s, a) => s + (a?.tol ?? 0), 0);

  // 1. Subtotals: "Total X" = the lines since the previous total or heading,
  //    or those lines plus the group's earlier subtotals ("Total assets" after
  //    "Total current assets" and the non-current lines).
  //    A heading that carries amounts must equal the lines under it.
  const checkSum = (T: TableRow, block: TableRow[], prior: TableRow[], where: "above" | "under") => {
    for (let i = 0; i < cols; i++) {
      const t = T.amounts[i];
      const parts = block.map((l) => l.amounts[i]).filter((a): a is Amount => !!a);
      if (!t || parts.length === 0) continue;
      const before = prior.map((g) => g.amounts[i]).filter((a): a is Amount => !!a);
      const abs = parts.reduce((s, p) => s + Math.abs(p.value), 0);
      const signed = Math.abs(parts.reduce((s, p) => s + p.value, 0));
      const withPrior = abs + before.reduce((s, p) => s + Math.abs(p.value), 0);
      const target = Math.abs(t.value);
      const tol = t.tol + tolOf(parts) + tolOf(before);
      if ([abs, signed, withPrior].every((c) => off(c, target, tol))) {
        out.push(`${colName(i)}: "${T.label}" shows ${fmt(target)} but the lines ${where} it add up to ${fmt(abs)}`);
      }
    }
  };
  let lines: TableRow[] = [];
  let groupTotals: TableRow[] = [];
  let openHead: TableRow | null = null;
  const closeHead = () => {
    if (openHead && lines.length > 0) checkSum(openHead, lines, [], "under");
    openHead = null;
  };
  for (const r of rows) {
    if (r.header || r.headTotal || r.statement) {
      // A new group (or a result row, which no subtotal includes).
      closeHead();
      lines = [];
      groupTotals = [];
      if (r.headTotal) openHead = r;
      continue;
    }
    if (!r.total) {
      if (!BREAKDOWN_LABEL.test(r.bare)) lines.push(r);
      continue;
    }
    closeHead();
    if (SUM_LABEL.test(r.label) && lines.length > 0) checkSum(r, lines, groupTotals, "above");
    groupTotals.push(r);
    lines = [];
  }
  closeHead();

  // 2. Revenue − cost of sales = gross profit; expenses never exceed revenue.
  const ebitdaRow = rows.find((r) => !r.header && ROW_PATTERNS.ebitda.test(r.bare)) ?? null;
  const upTo = ebitdaRow ? rows.slice(0, rows.indexOf(ebitdaRow)) : rows;
  const rev = pickRow(upTo, ROW_PATTERNS.revenue);
  const cogs = pickRow(upTo, ROW_PATTERNS.cogs);
  const gp = pickRow(upTo, ROW_PATTERNS.gross);
  const opex = pickRow(upTo, ROW_PATTERNS.opex);
  for (let i = 0; i < cols; i++) {
    const R = rev?.amounts[i] ?? null, C = cogs?.amounts[i] ?? null, G = gp?.amounts[i] ?? null, O = opex?.amounts[i] ?? null;
    if (R && C && G && off(R.value - Math.abs(C.value), G.value, tolOf([R, C, G]))) {
      out.push(`${colName(i)}: revenue − cost of sales (${fmt(R.value - Math.abs(C.value))}) ≠ gross profit (${fmt(G.value)})`);
    }
    if (R && O && Math.abs(O.value) > Math.abs(R.value)) out.push(`${colName(i)}: operating expenses exceed revenue`);
  }

  // 3. EBITDA = gross profit less the expense rows printed between them.
  if (ebitdaRow) {
    const anchor = gp ?? cogs;
    const from = anchor ? rows.indexOf(anchor) + 1 : 0;
    const between = rows.slice(from, rows.indexOf(ebitdaRow)).filter((r) => !r.header && !BREAKDOWN_LABEL.test(r.bare));
    const leaves = between.filter((r) => !r.total);
    const last = between[between.length - 1];
    const lastTotalIdx = between.map((r) => r.total).lastIndexOf(true);
    for (let i = 0; i < cols; i++) {
      const E = ebitdaRow.amounts[i];
      // No expense figures printed for this year: a blank is allowed (never a guess).
      if (!E || !between.some((r) => r.amounts[i])) continue;
      const G = gp?.amounts[i] ?? null;
      const R = rev?.amounts[i] ?? null, C = cogs?.amounts[i] ?? null;
      const gross = G ? G.value : R && C ? R.value - Math.abs(C.value) : null;
      if (gross === null) continue;
      // An expense reduces EBITDA; other income / a gain adds to it.
      const cost = (r: TableRow) => {
        const a = r.amounts[i];
        if (!a) return 0;
        return INCOME_LABEL.test(r.bare) && !/expense|cost/i.test(r.bare) ? -Math.abs(a.value) : Math.abs(a.value);
      };
      const tol = E.tol + (G ? G.tol : tolOf([R, C])) + tolOf(between.map((r) => r.amounts[i]));
      const lastAmt = last?.amounts[i] ?? null;
      if (last?.total && lastAmt) {
        // The expense total printed right above EBITDA: a reader takes
        // gross profit − that total = EBITDA, so it has to hold as printed.
        const v = gross - Math.abs(lastAmt.value);
        if (off(v, E.value, E.tol + lastAmt.tol + (G ? G.tol : tolOf([R, C])))) {
          out.push(`${colName(i)}: gross profit − operating expenses ("${last.label}": ${fmt(v)}) ≠ EBITDA (${fmt(E.value)})`);
        }
        continue;
      }
      // Every line listed; or the totals only (a heading "Operating Expenses
      // $1,484,800" over its lines); or the last total plus what follows it.
      const candidates = [
        gross - leaves.reduce((s, r) => s + cost(r), 0),
        gross - leaves.reduce((s, r) => s + Math.abs(r.amounts[i]?.value ?? 0), 0),
        gross - between.filter((r) => r.total).reduce((s, r) => s + Math.abs(r.amounts[i]?.value ?? 0), 0),
      ];
      if (lastTotalIdx >= 0) {
        const t = between[lastTotalIdx].amounts[i];
        if (t) candidates.push(gross - Math.abs(t.value) - between.slice(lastTotalIdx + 1).reduce((s, r) => s + cost(r), 0));
      }
      if (candidates.every((c) => off(c, E.value, tol))) {
        out.push(`${colName(i)}: gross profit − operating expenses (${fmt(candidates[0])}) ≠ EBITDA (${fmt(E.value)})`);
      }
    }
  }
  return out;
}

/** A bridge (waterfall) whose steps don't reach its total. */
function reconcileWaterfall(section: SectionLike): string[] {
  const items = asArr((section.layoutData as any)?.items);
  if (items.length < 3) return [];
  const unit = str((section.layoutData as any)?.unit);
  let running: number | null = null;
  const out: string[] = [];
  for (const it of items) {
    const v = amount(withChartUnit(str(it?.value), unit));
    if (v === null) continue;
    const type = str(it?.type) || (running === null ? "start" : "add");
    if (type === "start") running = v;
    else if (type === "total") {
      if (running !== null && Math.abs(running - v) > Math.max(1000, Math.abs(v) * 0.01)) {
        out.push(`"${str(it?.label)}" shows ${Math.round(v).toLocaleString("en-US")} but the steps add up to ${Math.round(running).toLocaleString("en-US")}`);
      }
      running = v;
    } else if (running !== null) {
      running += type === "subtract" ? -Math.abs(v) : v;
    }
  }
  return out;
}

/**
 * A waterfall that starts at a net income the analysis bridges from must use
 * that year's bridge lines. A figure that is on file under another label
 * (Pacific: "Interest and bank charges $433,000" shown as the interest
 * add-back, where the bridge has $395,000) traces as a number but is not a
 * line of the bridge.
 */
function bridgeLines(section: SectionLike, known: KnownFigures): string[] {
  if (!known.bridges?.length) return [];
  const d = (section.layoutData ?? {}) as Record<string, any>;
  const unit = str(d.unit);
  const items = asArr(d.items)
    .map((it) => ({ label: str(it?.label), type: str(it?.type), a: amountOf(withChartUnit(str(it?.value), unit)) }))
    .filter((it) => it.a);
  const first = items[0];
  if (!first || (first.type && first.type !== "start")) return [];
  const within = (x: number, a: Amount) => Math.abs(Math.abs(x) - Math.abs(a.value)) <= a.tol + 1e-6 * Math.max(1, Math.abs(x));
  const bridge = known.bridges.find((b) => within(b.start, first.a!));
  if (!bridge) return [];
  // A bar may group neighbouring lines ("One-time items" = two one-time costs).
  const sums: number[] = [];
  for (let i = 0; i < bridge.steps.length; i++) {
    let s = 0;
    for (let j = i; j < bridge.steps.length; j++) {
      s += bridge.steps[j];
      sums.push(s);
    }
  }
  const out: string[] = [];
  for (const it of items.slice(1)) {
    if (it.type === "total") {
      if (!bridge.totals.some((t) => within(t, it.a!))) {
        out.push(`"${it.label}" (${fmt(Math.abs(it.a!.value))}) is not the ${bridge.label} total for ${bridge.year} (${bridge.totals.map((t) => fmt(t)).join(" / ")})`);
      }
    } else if (!sums.some((s) => within(s, it.a!))) {
      out.push(`bar "${it.label}" (${fmt(Math.abs(it.a!.value))}) is not a line of the ${bridge.label} bridge for ${bridge.year}`);
    }
  }
  return out;
}

// ── Names ────────────────────────────────────────────────────────────────

const COMPANY_SUFFIX = /\b(inc|ltd|llc|llp|corp|corporation|co|co-op|cooperative|co-operative|limited|group|holdings|partners|lp|plc|gmbh)\b\.?/i;
const GENERIC_LABEL =
  /^(customer|client|supplier|vendor|account|payer|carrier)s?\s+[a-z0-9]{1,3}\b|\bothers?\b|\bremaining\b|\ball other|\brest of\b|\btop \d+|\bbalance\b|\blong tail\b|^\d+\+?\s|\bcustomers?\b$|\bclients?\b$|\bunnamed\b|\bconfidential\b|^(government|retail|wholesale|commercial|residential|industrial|institutional|online|direct|private)\b/i;
const PARTY_CONTEXT = /\b(customer|client|account|supplier|vendor|payer|concentration)s?\b/i;

// Legal / corporate endings dropped before the look-up ("Kestrel Building Supply Ltd."
// is on file as "Kestrel Building Supply"). "co-op" before "co", so the ending goes whole.
const LEGAL_ENDING = /\b(co-op|co-operative|cooperative|incorporated|inc|ltd|limited|llc|llp|lp|plc|gmbh|corp|corporation|company|co|the)\b\.?/gi;

/**
 * Is a chart/table label a company on file? The whole name (legal endings
 * aside) must appear as written in the knowledge base: "Alderbrook Grocery"
 * is on file when the file says "Alderbrook Grocery Distributors", but
 * "Fraser Valley Dairy Co-op" is not just because the history mentions
 * "Fraser Valley farms" — matching only the first two words let exactly
 * that invented customer through.
 */
export function nameOnFile(label: string, known: KnownFigures): boolean {
  const norm = normalizeForLookup(label.replace(LEGAL_ENDING, " ")).trim();
  if (!norm) return true;
  return known.text.includes(` ${norm} `);
}

function unknownNames(section: SectionLike, known: KnownFigures): string[] {
  const d = (section.layoutData ?? {}) as Record<string, any>;
  const context = `${section.sectionTitle} ${str(d.title)} ${str(d.caption)} ${asArr(section.tags).join(" ")}`;
  const partySection = PARTY_CONTEXT.test(context);
  const labels: string[] = [];
  if (["bar_chart", "horizontal_bar_chart", "pie_chart", "donut_chart"].includes(section.layoutType)) {
    asArr(d.data).forEach((it) => labels.push(str(it?.name)));
  } else if (section.layoutType === "financial_table" || section.layoutType === "comparison_table") {
    asArr(d.rows).forEach((r) => labels.push(str(r?.label)));
  }
  const out: string[] = [];
  for (const raw of labels) {
    // "Alderbrook Grocery (MSA to 2027)", "Kestrel — 8%", "Alderbrook: anchor account" → the name.
    const label = raw
      .replace(/\s*\(.*?\)\s*$/, "")
      .replace(/\s*[—–-]\s*\d.*$/, "")
      .replace(/\s+[—–]\s.*$|\s+-\s.*$|:\s.*$/, "")
      .trim();
    if (!label || GENERIC_LABEL.test(label)) continue;
    const looksLikeCompany = COMPANY_SUFFIX.test(label) || (partySection && /^[A-Z][\w'&.-]*(\s+[A-Z&][\w'&.-]*)+/.test(label));
    if (!looksLikeCompany) continue;
    if (!nameOnFile(label, known)) out.push(`"${label}" is not a name on file`);
  }
  return out;
}

// ── Entry points ─────────────────────────────────────────────────────────

/** Warnings for one section (empty = every figure traced). */
export function checkSectionFigures(section: SectionLike, known: KnownFigures): string[] {
  const issues = [
    ...unknownFigures(section, known).map((m) => `no source for ${m}`),
    ...(section.layoutType === "financial_table" ? reconcileTable(section) : []),
    ...(section.layoutType === "waterfall_chart" ? [...reconcileWaterfall(section), ...bridgeLines(section, known)] : []),
    ...unknownNames(section, known),
  ];
  return issues;
}

/** One broker-facing warning line per flagged section. */
export function figureWarningText(sectionTitle: string, issues: string[]): string {
  const shown = issues.slice(0, 6).join("; ");
  const more = issues.length > 6 ? `; and ${issues.length - 6} more` : "";
  return `Check the figures in "${sectionTitle}" before publishing — ${shown}${more}.`;
}
