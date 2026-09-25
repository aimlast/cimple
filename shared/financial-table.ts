/**
 * financial-table — one reading of a financial_table's `headers` / `rows`,
 * shared by the CIM renderer (every view: builder, previews, buyer view room)
 * and the buyer Q&A context, so a figure is always paired with the right year.
 *
 * The documented shape (AI spec, registry default, every table on file) puts
 * the LABEL column's header first: `headers: ["", "FY2023", "FY2024", "FY2025"]`
 * (or `["Line Item", …]`) with 3-value rows. Older/odd tables sometimes leave
 * the label header out (`["2023", "2024", "2025"]`), have more headers than
 * values (a year with no figures yet) or rows shorter than the year list.
 * `normalizeFinancialTable` resolves all of these into:
 *   - `labelHeader`: text for the first (label) column header — the table's own
 *     label header, else "" (the renderer adds the currency);
 *   - `columns`: one header per value column (padded with "" when rows carry
 *     more values than there are headers);
 *   - each row's `cells`: exactly `columns.length` entries, `null` where the
 *     table has no figure for that column.
 */

export interface FinancialTableRowInput {
  label?: unknown;
  values?: unknown;
  isTotal?: boolean;
  isSectionHeader?: boolean;
  indent?: number;
  bold?: boolean;
  [k: string]: unknown;
}

export interface NormalizedFinancialRow {
  label: string;
  /** One entry per value column; null = no figure for that column. */
  cells: (string | null)[];
  isTotal: boolean;
  isSectionHeader: boolean;
  indent: number;
  bold: boolean;
}

export interface NormalizedFinancialTable {
  labelHeader: string;
  columns: string[];
  rows: NormalizedFinancialRow[];
  /** True when the table carried a header for the label column. */
  hadLabelHeader: boolean;
}

function text(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "string") return v;
  return String(v);
}

/**
 * Header text that names a period or value column (a year, fiscal year,
 * TTM/LTM/YTD, a quarter, "Current", "Projected"…) rather than the label column.
 */
export function isPeriodHeader(h: string): boolean {
  const s = h.trim();
  if (!s) return false;
  if (/\b(19|20)\d{2}\b/.test(s)) return true;
  if (/^(fy|cy)\s*'?\d{2}/i.test(s)) return true;
  return /^(ttm|ltm|ytd|q[1-4]\b|h[12]\b|current|prior|projected|forecast|budget|actual|est\.?\b|estimate|\d+\s*-?\s*(yr|year)s?\b)/i.test(s);
}

export function normalizeFinancialTable(data: { headers?: unknown; rows?: unknown } | null | undefined): NormalizedFinancialTable {
  const headers: string[] = Array.isArray(data?.headers) ? (data!.headers as unknown[]).map(text) : [];
  const rawRows: FinancialTableRowInput[] = Array.isArray(data?.rows)
    ? (data!.rows as unknown[]).filter((r): r is FinancialTableRowInput => !!r && typeof r === "object")
    : [];

  const valueLists = rawRows.map((r) => (Array.isArray(r.values) ? (r.values as unknown[]).map(text) : []));
  // Section-header rows usually carry no values; they never decide the width.
  const maxValues = Math.max(
    0,
    ...rawRows.map((r, i) => (r.isSectionHeader && valueLists[i].every((v) => !v.trim()) ? 0 : valueLists[i].length)),
  );

  let hadLabelHeader = false;
  if (headers.length > 0) {
    const h0 = headers[0];
    if (!h0.trim()) hadLabelHeader = true; // a blank first header is the label column
    else if (isPeriodHeader(h0)) hadLabelHeader = false; // "2023", "FY2023", "TTM"…
    else if (headers.length > maxValues) hadLabelHeader = true; // "Line Item", "Equipment"…
    else hadLabelHeader = false; // e.g. ["Revenue", "Margin"] over 2-value rows
  }

  const labelHeader = hadLabelHeader ? headers[0].trim() : "";
  const valueHeaders = hadLabelHeader ? headers.slice(1) : headers.slice();
  const columnCount = Math.max(valueHeaders.length, maxValues);
  const columns = Array.from({ length: columnCount }, (_, i) => (valueHeaders[i] ?? "").trim());

  const rows: NormalizedFinancialRow[] = rawRows.map((r, i) => {
    const vals = valueLists[i];
    return {
      label: text(r.label),
      cells: Array.from({ length: columnCount }, (_, j) => {
        const v = (vals[j] ?? "").trim();
        return v ? v : null;
      }),
      isTotal: !!r.isTotal,
      isSectionHeader: !!r.isSectionHeader,
      indent: typeof r.indent === "number" && Number.isFinite(r.indent) ? Math.max(0, Math.min(4, r.indent)) : 0,
      bold: !!r.bold,
    };
  });

  return { labelHeader, columns, rows, hadLabelHeader };
}

/**
 * Header for the label column: the table's own label header plus the currency
 * when the header doesn't already name it — "(CAD)", "Line item (CAD)".
 */
export function financialLabelHeader(labelHeader: string, currency?: unknown): string {
  const cur = text(currency).trim();
  if (!cur) return labelHeader;
  if (!labelHeader) return `(${cur})`;
  if (labelHeader.toLowerCase().includes(cur.toLowerCase())) return labelHeader;
  return `${labelHeader} (${cur})`;
}
