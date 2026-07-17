/**
 * Financial Analysis — canonical (UI-native) data shapes + converters.
 *
 * WHY THIS EXISTS
 * The FinancialAnalysisCenter UI (ReclassifiedTable, NormalizationPanel,
 * WorkingCapitalPanel, ClarifyingQuestions, InsightsPanel, FinancialOverview)
 * renders these exact shapes and round-trips broker edits through
 * PATCH /financial-analysis/:id. An earlier version of the analyzer stored a
 * different "periods/sections" shape, which every panel silently rejected —
 * a completed analysis rendered as "No data available" everywhere. This module
 * defines the single canonical shape, coerces fresh AI output into it, and
 * converts legacy stored rows on read so old analyses render too.
 */

// ── Canonical shapes (what the client components consume) ──

export interface UiFinancialRow {
  id: string;
  name: string;
  category: string; // ReclassifiedTable category values ("Revenue", "COGS", ...)
  values: Record<string, number>; // year -> amount
}

export interface UiReclassifiedTable {
  years: string[];
  rows: UiFinancialRow[];
  notes?: string[];
}

export interface UiAddback {
  id: string;
  label: string;
  description?: string;
  category: string; // owner_comp | discretionary | non_recurring | one_time | other
  amounts: Record<string, number>;
  approved: boolean;
  /** "sde" addbacks only apply to SDE (owner-specific); "ebitda" apply to both. */
  type?: "sde" | "ebitda";
  confidence?: "high" | "medium" | "low";
}

export interface UiNormalization {
  metric: "sde" | "ebitda";
  years: string[];
  netIncome: Record<string, number>;
  addbacks: UiAddback[];
  notes?: string[];
}

export interface UiWorkingCapitalItem {
  name: string;
  amount: number;
}

export interface UiWorkingCapital {
  currentAssets: UiWorkingCapitalItem[];
  currentLiabilities: UiWorkingCapitalItem[];
  netWorkingCapital: number;
  pegAmount?: number | null;
  targetNwc?: number | null;
  asOfPeriod?: string;
  notes?: string[];
}

export interface UiClarifyingQuestion {
  id: string;
  severity: "high" | "medium" | "low";
  question: string;
  context?: string;
  answer?: string;
  status: "pending" | "answered" | "dismissed" | "routed_to_seller";
}

export interface UiInsight {
  id: string;
  type: "positive" | "negative" | "neutral";
  title: string;
  detail: string;
  cimSection?: string;
}

export interface UiInsights {
  positive: UiInsight[];
  negative: UiInsight[];
  neutral?: UiInsight[];
}

// ── Small helpers ──

let idCounter = 0;
function genId(prefix: string): string {
  idCounter = (idCounter + 1) % 1_000_000;
  return `${prefix}_${Date.now().toString(36)}_${idCounter}`;
}

function toNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/[$,\s]/g, "").replace(/^\((.*)\)$/, "-$1"));
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function numberMap(obj: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const n = toNumber(v);
      if (n !== undefined) out[k] = n;
    }
  }
  return out;
}

/** Map arbitrary AI/legacy section names to the ReclassifiedTable category set. */
function mapPnlCategory(raw: string): string {
  const s = (raw || "").toLowerCase();
  if (s.includes("other income") || (s.includes("income") && s.includes("non-operating"))) return "Other Income";
  if (s.includes("revenue") || s.includes("sales")) return "Revenue";
  if (s.includes("cogs") || s.includes("cost of goods") || s.includes("cost of sales") || s.includes("direct cost")) return "COGS";
  if (s.includes("depreciation") || s.includes("amortization")) return "Depreciation";
  if (s.includes("interest")) return "Interest";
  if (s.includes("tax")) return "Taxes";
  if (s.includes("owner") || s.includes("officer comp")) return "Owner Compensation";
  if (s.includes("non-recurring") || s.includes("nonrecurring") || s.includes("one-time") || s.includes("one time")) return "Non-Recurring";
  if (s.includes("other expense") || s.includes("non-operating expense")) return "Other Expense";
  if (s.includes("other income") || s.includes("non-operating")) return "Other Income";
  if (s.includes("expense") || s.includes("operating") || s.includes("overhead") || s.includes("sg&a") || s.includes("marketing") || s.includes("payroll") || s.includes("admin")) return "Operating Expenses";
  if (s.includes("gross profit") || s.includes("subtotal") || s.includes("total")) return "Excluded";
  return "Operating Expenses";
}

function mapBalanceCategory(raw: string): string {
  const s = (raw || "").toLowerCase();
  if (s.includes("current asset")) return "Current Assets";
  if (s.includes("fixed asset") || s.includes("property") || s.includes("pp&e") || s.includes("capital asset")) return "Fixed Assets";
  if (s.includes("asset")) return "Other Assets";
  if (s.includes("current liabilit")) return "Current Liabilities";
  if (s.includes("liabilit") || s.includes("long")) return "Long-Term Liabilities";
  if (s.includes("equity") || s.includes("retained")) return "Equity";
  return "Other Assets";
}

function mapAddbackCategory(label: string, type?: string): string {
  const s = (label || "").toLowerCase();
  if (s.includes("owner") || s.includes("officer") || s.includes("shareholder comp") || s.includes("salary above") || s.includes("compensation")) return "owner_comp";
  if (s.includes("personal") || s.includes("meals") || s.includes("travel") || s.includes("vehicle") || s.includes("donation") || s.includes("discretionary") || s.includes("membership")) return "discretionary";
  if (s.includes("one-time") || s.includes("one time") || s.includes("lawsuit") || s.includes("settlement") || s.includes("moving")) return "one_time";
  if (s.includes("non-recurring") || s.includes("grant") || s.includes("subsid") || s.includes("covid") || s.includes("forgiv")) return "non_recurring";
  if (type === "ebitda") return "other"; // D&A, interest, taxes
  return "other";
}

// ── Coercers: AI output (canonical-ish or legacy) -> canonical ──

/**
 * Coerce any P&L / balance-sheet payload into UiReclassifiedTable.
 * Accepts the canonical {years, rows} shape, or the legacy
 * {periods, sections:[{category, items:[{label, amounts}]}]} shape.
 */
export function coerceReclassifiedTable(
  raw: any,
  kind: "pnl" | "balance",
): UiReclassifiedTable | null {
  if (!raw || typeof raw !== "object") return null;
  const mapCat = kind === "pnl" ? mapPnlCategory : mapBalanceCategory;

  // Canonical shape already
  if (Array.isArray(raw.rows)) {
    const years: string[] = Array.isArray(raw.years) ? raw.years.map(String) : [];
    const rows: UiFinancialRow[] = raw.rows
      .filter((r: any) => r && (r.name || r.label))
      .map((r: any) => ({
        id: typeof r.id === "string" && r.id ? r.id : genId("row"),
        name: String(r.name ?? r.label),
        category: r.category ? String(r.category) : mapCat(""),
        values: numberMap(r.values ?? r.amounts),
      }));
    if (rows.length === 0) return null;
    const inferredYears = years.length > 0
      ? years
      : Array.from(new Set(rows.flatMap((r) => Object.keys(r.values)))).sort();
    return { years: inferredYears, rows, notes: Array.isArray(raw.notes) ? raw.notes.map(String) : undefined };
  }

  // Legacy sections shape
  if (Array.isArray(raw.sections)) {
    const years: string[] = Array.isArray(raw.periods) ? raw.periods.map(String) : [];
    const rows: UiFinancialRow[] = [];
    for (const section of raw.sections) {
      if (!section || !Array.isArray(section.items)) continue;
      const category = mapCat(String(section.category ?? ""));
      // Skip purely computed sections (e.g. "Gross Profit" with no items)
      if (category === "Excluded" && section.items.length === 0) continue;
      for (const item of section.items) {
        if (!item || !item.label) continue;
        rows.push({
          id: genId("row"),
          name: String(item.label),
          category,
          values: numberMap(item.amounts),
        });
      }
    }
    if (rows.length === 0) return null;
    return { years, rows, notes: Array.isArray(raw.notes) ? raw.notes.map(String) : undefined };
  }

  return null;
}

/** Coerce normalization payload (canonical or legacy) into UiNormalization. */
export function coerceNormalization(raw: any): UiNormalization | null {
  if (!raw || typeof raw !== "object") return null;

  const netIncomeSource = raw.netIncome ?? raw.reportedNetIncome;
  const netIncome = numberMap(netIncomeSource);
  const years: string[] = Array.isArray(raw.years)
    ? raw.years.map(String)
    : Array.isArray(raw.periods)
      ? raw.periods.map(String)
      : Object.keys(netIncome);

  const rawAddbacks = Array.isArray(raw.addbacks) ? raw.addbacks : [];
  const addbacks: UiAddback[] = rawAddbacks
    .filter((a: any) => a && a.label)
    .map((a: any) => {
      const type = a.type === "sde" || a.type === "ebitda" ? a.type : undefined;
      const confidence = ["high", "medium", "low"].includes(a.confidence) ? a.confidence : undefined;
      return {
        id: typeof a.id === "string" && a.id ? a.id : genId("ab"),
        label: String(a.label),
        description: a.description ? String(a.description) : a.rationale ? String(a.rationale) : undefined,
        category: a.category && typeof a.category === "string" && !["sde", "ebitda"].includes(a.category)
          ? a.category
          : mapAddbackCategory(String(a.label), type),
        amounts: numberMap(a.amounts),
        approved: typeof a.approved === "boolean" ? a.approved : confidence !== "low",
        type,
        confidence,
      };
    });

  if (years.length === 0 && addbacks.length === 0) return null;

  return {
    metric: raw.metric === "ebitda" ? "ebitda" : "sde",
    years,
    netIncome,
    addbacks,
    notes: Array.isArray(raw.notes) ? raw.notes.map(String) : undefined,
  };
}

/**
 * Coerce working-capital payload into UiWorkingCapital.
 * Legacy shape has per-year Record values — we take the latest period and, when
 * available, borrow the balance sheet's current asset/liability line items.
 */
export function coerceWorkingCapital(
  raw: any,
  balanceSheet?: UiReclassifiedTable | null,
): UiWorkingCapital | null {
  if (!raw || typeof raw !== "object") return null;

  // Canonical: item arrays + scalar NWC
  if (Array.isArray(raw.currentAssets) || Array.isArray(raw.currentLiabilities)) {
    const assets = (Array.isArray(raw.currentAssets) ? raw.currentAssets : [])
      .filter((i: any) => i && i.name)
      .map((i: any) => ({ name: String(i.name), amount: toNumber(i.amount) ?? 0 }));
    const liabilities = (Array.isArray(raw.currentLiabilities) ? raw.currentLiabilities : [])
      .filter((i: any) => i && i.name)
      .map((i: any) => ({ name: String(i.name), amount: toNumber(i.amount) ?? 0 }));
    const nwc = toNumber(raw.netWorkingCapital)
      ?? assets.reduce((s: number, i: UiWorkingCapitalItem) => s + i.amount, 0)
        - liabilities.reduce((s: number, i: UiWorkingCapitalItem) => s + i.amount, 0);
    return {
      currentAssets: assets,
      currentLiabilities: liabilities,
      netWorkingCapital: nwc,
      pegAmount: toNumber(raw.pegAmount) ?? toNumber(raw.targetNwc) ?? null,
      targetNwc: toNumber(raw.targetNwc) ?? null,
      asOfPeriod: raw.asOfPeriod ? String(raw.asOfPeriod) : undefined,
      notes: Array.isArray(raw.notes) ? raw.notes.map(String) : undefined,
    };
  }

  // Legacy: per-year maps
  const nwcByYear = numberMap(raw.netWorkingCapital);
  const assetsByYear = numberMap(raw.currentAssets);
  const liabilitiesByYear = numberMap(raw.currentLiabilities);
  const periods: string[] = Array.isArray(raw.periods)
    ? raw.periods.map(String)
    : Object.keys(nwcByYear);
  if (periods.length === 0) return null;
  const latest = periods[periods.length - 1];

  // Prefer real line items from the balance sheet's latest year
  const itemize = (category: string, fallbackName: string, fallbackAmount: number | undefined): UiWorkingCapitalItem[] => {
    const rows = balanceSheet?.rows.filter(
      (r) => r.category === category && r.values[latest] !== undefined,
    );
    if (rows && rows.length > 0) {
      return rows.map((r) => ({ name: r.name, amount: Math.abs(r.values[latest] ?? 0) }));
    }
    return fallbackAmount !== undefined ? [{ name: fallbackName, amount: Math.abs(fallbackAmount) }] : [];
  };

  const currentAssets = itemize("Current Assets", `Current Assets (as of ${latest})`, assetsByYear[latest]);
  const currentLiabilities = itemize("Current Liabilities", `Current Liabilities (as of ${latest})`, liabilitiesByYear[latest]);
  const nwc = nwcByYear[latest]
    ?? (assetsByYear[latest] !== undefined && liabilitiesByYear[latest] !== undefined
      ? assetsByYear[latest] - liabilitiesByYear[latest]
      : currentAssets.reduce((s, i) => s + i.amount, 0) - currentLiabilities.reduce((s, i) => s + i.amount, 0));

  return {
    currentAssets,
    currentLiabilities,
    netWorkingCapital: nwc,
    pegAmount: toNumber(raw.pegAmount) ?? toNumber(raw.targetNwc) ?? null,
    targetNwc: toNumber(raw.targetNwc) ?? null,
    asOfPeriod: latest,
    notes: Array.isArray(raw.notes) ? raw.notes.map(String) : undefined,
  };
}

/** Coerce clarifying questions (canonical or legacy priority-based) into UI shape. */
export function coerceClarifyingQuestions(raw: any): UiClarifyingQuestion[] | null {
  if (!Array.isArray(raw)) return null;
  const out: UiClarifyingQuestion[] = raw
    .filter((q: any) => q && q.question)
    .map((q: any) => {
      const priority = String(q.severity ?? q.priority ?? "medium").toLowerCase();
      const severity: "high" | "medium" | "low" =
        priority === "critical" || priority === "high" ? "high"
        : priority === "low" ? "low"
        : "medium";
      let context = q.context ? String(q.context) : undefined;
      if (Array.isArray(q.relatedLineItems) && q.relatedLineItems.length > 0) {
        context = `${context ? `${context} ` : ""}(Related line items: ${q.relatedLineItems.join(", ")})`;
      }
      return {
        id: typeof q.id === "string" && q.id ? q.id : genId("q"),
        severity,
        question: String(q.question),
        context,
        answer: q.answer ? String(q.answer) : undefined,
        status: ["pending", "answered", "dismissed", "routed_to_seller"].includes(q.status)
          ? q.status
          : "pending",
      };
    });
  return out.length > 0 ? out : null;
}

/** Coerce insights (canonical or legacy severity-based) into UI shape. */
export function coerceInsights(raw: any): UiInsights | null {
  if (!raw || typeof raw !== "object") return null;
  const coerceList = (list: any, type: "positive" | "negative" | "neutral"): UiInsight[] =>
    (Array.isArray(list) ? list : [])
      .filter((i: any) => i && i.title)
      .map((i: any) => ({
        id: typeof i.id === "string" && i.id ? i.id : genId("in"),
        type,
        title: String(i.title),
        detail: i.detail ? String(i.detail) : "",
        cimSection: i.cimSection ? String(i.cimSection) : undefined,
      }));

  const positive = coerceList(raw.positive, "positive");
  const negative = coerceList(raw.negative, "negative");
  const neutral = coerceList(raw.neutral, "neutral");
  if (positive.length === 0 && negative.length === 0 && neutral.length === 0) return null;
  return { positive, negative, neutral: neutral.length > 0 ? neutral : undefined };
}

// ── Row-level normalizer (applied on read so legacy rows render) ──

function isLegacyTable(v: any): boolean {
  return !!v && typeof v === "object" && !Array.isArray(v.rows) && Array.isArray(v.sections);
}

function isLegacyNormalization(v: any): boolean {
  return !!v && typeof v === "object" && (v.reportedNetIncome !== undefined || (!v.metric && Array.isArray(v.periods)));
}

function isLegacyWorkingCapital(v: any): boolean {
  return !!v && typeof v === "object"
    && !Array.isArray(v.currentAssets) && !Array.isArray(v.currentLiabilities)
    && (typeof v.netWorkingCapital === "object" || typeof v.currentAssets === "object");
}

function isLegacyQuestions(v: any): boolean {
  return Array.isArray(v) && v.length > 0 && v.some((q: any) => q && q.question && !q.status);
}

function isLegacyInsights(v: any): boolean {
  const lists = [v?.positive, v?.negative, v?.neutral].filter(Array.isArray).flat();
  return lists.length > 0 && lists.some((i: any) => i && i.title && !i.type);
}

/**
 * Normalize a stored financial_analyses row for the client. Rows written by
 * the current analyzer are already canonical (pass through untouched); rows
 * written by the legacy analyzer are converted so they render instead of
 * showing "No data available" in every panel.
 */
export function normalizeFinancialAnalysisRow<T extends Record<string, any>>(row: T): T {
  if (!row) return row;
  const out: Record<string, any> = { ...row };

  if (isLegacyTable(out.reclassifiedPnl)) {
    out.reclassifiedPnl = coerceReclassifiedTable(out.reclassifiedPnl, "pnl");
  }
  if (isLegacyTable(out.reclassifiedBalanceSheet)) {
    out.reclassifiedBalanceSheet = coerceReclassifiedTable(out.reclassifiedBalanceSheet, "balance");
  }
  if (isLegacyNormalization(out.normalization)) {
    out.normalization = coerceNormalization(out.normalization);
  }
  if (isLegacyWorkingCapital(out.workingCapital)) {
    out.workingCapital = coerceWorkingCapital(out.workingCapital, out.reclassifiedBalanceSheet ?? null);
  }
  if (isLegacyQuestions(out.clarifyingQuestions)) {
    out.clarifyingQuestions = coerceClarifyingQuestions(out.clarifyingQuestions);
  }
  if (isLegacyInsights(out.insights)) {
    out.insights = coerceInsights(out.insights);
  }

  return out as T;
}

// ── JSON parsing helper for AI responses ──

/**
 * Parse a Claude text response that should contain a single JSON value.
 * Strips markdown fences and trims to the outermost {...} or [...].
 */
export function parseJsonLoose<T = any>(text: string): T {
  const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // Fall back to the outermost JSON block
    const firstBrace = cleaned.search(/[{[]/);
    if (firstBrace === -1) throw new Error("No JSON found in AI response");
    const open = cleaned[firstBrace];
    const close = open === "{" ? "}" : "]";
    const lastClose = cleaned.lastIndexOf(close);
    if (lastClose <= firstBrace) throw new Error("Malformed JSON in AI response");
    return JSON.parse(cleaned.slice(firstBrace, lastClose + 1)) as T;
  }
}
