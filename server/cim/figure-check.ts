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
export interface KnownFigures {
  money: Figure[];
  percent: Figure[];
  /** Normalised knowledge-base text, for name look-ups. */
  text: string;
}

export function normalizeForLookup(s: string): string {
  return ` ${s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim()} `;
}

export function knownFiguresFrom(kbText: string): KnownFigures {
  const figs = parseFigures(kbText);
  return {
    money: figs.filter((f) => f.kind !== "percent"),
    percent: figs.filter((f) => f.kind === "percent"),
    text: normalizeForLookup(kbText),
  };
}

function near(v: number, vTol: number, k: Figure): boolean {
  const a = Math.abs(v);
  const b = Math.abs(k.value);
  // Rounding in either direction, plus a hair for float noise.
  return Math.abs(a - b) <= Math.max(vTol, k.tolerance) + 1e-6 * Math.max(1, b);
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
        cells.push({ where: `"${str(it?.name)}"`, text: `${str(it?.value)}${typeof it?.value === "number" && /%/.test(str(d.unit)) ? "%" : ""}`, allowPlain: true });
        if (it?.secondaryValue !== undefined) cells.push({ where: `"${str(it?.name)}" (second value)`, text: str(it.secondaryValue), allowPlain: true });
      });
      if (d.centerValue) cells.push({ where: "centre figure", text: str(d.centerValue), allowPlain: false });
      break;
    case "line_chart": {
      const keys = asArr(d.series).map((s) => str(s?.key)).filter(Boolean);
      asArr(d.data).forEach((pt) =>
        keys.forEach((k) => pt && pt[k] !== undefined && cells.push({ where: `"${str(pt?.name)}" ${k}`, text: `${str(pt[k])}${/%/.test(str(d.unit)) ? "%" : ""}`, allowPlain: true })),
      );
      break;
    }
    case "metric_grid":
      asArr(d.metrics).forEach((m) => cells.push({ where: `metric "${str(m?.label)}"`, text: `${str(m?.value)}${/%/.test(str(m?.unit)) && !/%/.test(str(m?.value)) ? "%" : ""}`, allowPlain: false }));
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

function amount(text: string): number | null {
  const t = text.trim();
  if (!t || t === "—" || t === "-") return null;
  const negative = /^\(.*\)$/.test(t) || /^[-−–]/.test(t);
  const f = parseFigures(t.replace(/[()−–]/g, ""))[0];
  if (!f || f.kind === "percent") return null;
  return negative ? -Math.abs(f.value) : f.value;
}

const ROW_PATTERNS = {
  revenue: /^(total\s+)?(net\s+)?(revenue|sales|net sales|gross revenue)s?$/i,
  cogs: /^(total\s+)?(cost of (goods sold|sales|revenue)|cogs|direct (operating )?costs?)$/i,
  gross: /^gross (profit|margin \$)$/i,
  opex: /^(total\s+)?(operating expenses|opex|general (and|&) administrative( expenses)?|sg&a|overhead( expenses)?)$/i,
  ebitda: /^(reported\s+)?ebitda$/i,
};

function findRow(rows: any[], re: RegExp): any | null {
  const hits = rows.filter((r) => re.test(str(r?.label).replace(/\s*\(.*?\)\s*$/, "").trim()));
  return hits.length === 1 ? hits[0] : null;
}

/** Tables whose rows don't add up. Only checked where the rows are unambiguous. */
function reconcileTable(section: SectionLike): string[] {
  const d = (section.layoutData ?? {}) as Record<string, any>;
  const rows = asArr(d.rows);
  const headers = asArr(d.headers).map(str);
  const rev = findRow(rows, ROW_PATTERNS.revenue);
  const cogs = findRow(rows, ROW_PATTERNS.cogs);
  const gp = findRow(rows, ROW_PATTERNS.gross);
  const opex = findRow(rows, ROW_PATTERNS.opex);
  const ebitda = findRow(rows, ROW_PATTERNS.ebitda);
  const out: string[] = [];
  const cols = Math.max(0, headers.length - 1);
  const val = (r: any, i: number) => (r ? amount(str(asArr(r.values)[i])) : null);
  const off = (a: number, b: number) => Math.abs(a - b) > Math.max(1000, Math.abs(b) * 0.01);
  const opexIdx = opex ? rows.indexOf(opex) : -1;
  const ebitdaIdx = ebitda ? rows.indexOf(ebitda) : -1;
  for (let i = 0; i < cols; i++) {
    const col = headers[i + 1] || `column ${i + 1}`;
    const R = val(rev, i), C = val(cogs, i), G = val(gp, i), O = val(opex, i), E = val(ebitda, i);
    if (R !== null && C !== null && G !== null && off(R - Math.abs(C), G)) {
      out.push(`${col}: revenue − cost of sales (${Math.round(R - Math.abs(C)).toLocaleString("en-US")}) ≠ gross profit (${Math.round(G).toLocaleString("en-US")})`);
    }
    const gross = G ?? (R !== null && C !== null ? R - Math.abs(C) : null);
    if (gross !== null && O !== null && E !== null) {
      // Expense rows printed between operating expenses and EBITDA (one-time
      // costs, owner compensation) count too.
      const between = opexIdx >= 0 && ebitdaIdx > opexIdx
        ? rows.slice(opexIdx + 1, ebitdaIdx).filter((r) => !r?.isTotal && !r?.isSectionHeader).map((r) => val(r, i) ?? 0)
        : [];
      const plain = gross - Math.abs(O);
      const withBetween = plain - between.reduce((s, x) => s + Math.abs(x), 0);
      if (off(plain, E) && off(withBetween, E)) {
        out.push(`${col}: gross profit − operating expenses (${Math.round(plain).toLocaleString("en-US")}) ≠ EBITDA (${Math.round(E).toLocaleString("en-US")})`);
      }
    }
    if (R !== null && O !== null && Math.abs(O) > Math.abs(R)) out.push(`${col}: operating expenses exceed revenue`);
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

// ── Names ────────────────────────────────────────────────────────────────

const COMPANY_SUFFIX = /\b(inc|ltd|llc|llp|corp|corporation|co|co-op|cooperative|co-operative|limited|group|holdings|partners|lp|plc|gmbh)\b\.?/i;
const GENERIC_LABEL =
  /^(customer|client|supplier|vendor|account|payer|carrier)s?\s+[a-z0-9]{1,3}\b|\bothers?\b|\bremaining\b|\ball other|\brest of\b|\btop \d+|\bbalance\b|\blong tail\b|^\d+\+?\s|\bcustomers?\b$|\bclients?\b$|\bunnamed\b|\bconfidential\b|^(government|retail|wholesale|commercial|residential|industrial|institutional|online|direct|private)\b/i;
const PARTY_CONTEXT = /\b(customer|client|account|supplier|vendor|payer|concentration)s?\b/i;

/** Is a chart/table label that names a company on file? */
export function nameOnFile(label: string, known: KnownFigures): boolean {
  const norm = normalizeForLookup(label.replace(COMPANY_SUFFIX, " ")).trim();
  if (!norm) return true;
  if (known.text.includes(` ${norm} `)) return true;
  // "Alderbrook Grocery" when the file says "Alderbrook Grocery Distributors": the
  // first two distinctive words must appear together.
  const words = norm.split(" ").filter((w) => w.length >= 3);
  if (words.length === 0) return true;
  const head = words.slice(0, Math.min(2, words.length)).join(" ");
  return known.text.includes(` ${head} `);
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
    const label = raw.replace(/\s*\(.*?\)\s*$/, "").replace(/\s*[—–-]\s*\d.*$/, "").trim();
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
    ...(section.layoutType === "waterfall_chart" ? reconcileWaterfall(section) : []),
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
