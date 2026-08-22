import { useState, useMemo, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Pencil, Check, X, Info } from "lucide-react";

/* ──────────────────────────────────────────────
   Types
─────────────────────────────────────────────── */
export interface FinancialRow {
  id: string;
  name: string;
  category: string;
  values: Record<string, number>; // year/period -> amount
  /** Broker reclassified this row — carried into the next analysis version. */
  categoryOverride?: boolean;
}

export interface ReclassifiedTableData {
  years: string[];
  rows: FinancialRow[];
  /** Analyzer notes (source mix, reconciliation warnings). */
  notes?: string[];
}

interface ReclassifiedTableProps {
  data: ReclassifiedTableData | null;
  title?: string;
  years?: string[];
  /** "pnl" (default) computes a Net Income total; "balance" groups balance-sheet categories. */
  mode?: "pnl" | "balance";
  onUpdate?: (updated: ReclassifiedTableData) => void;
  /**
   * Shown when there are no rows. Defaults to "run the analysis"; pass a
   * different message once the analysis has completed without this statement
   * (e.g. no balance sheet in the uploaded documents).
   */
  emptyMessage?: string;
}

/* ──────────────────────────────────────────────
   Category config
─────────────────────────────────────────────── */
const PNL_CATEGORIES = [
  { value: "Revenue",                label: "Revenue" },
  { value: "COGS",                   label: "Cost of Goods Sold" },
  { value: "Operating Expenses",     label: "Operating Expenses" },
  { value: "Other Income",           label: "Other Income" },
  { value: "Other Expense",          label: "Other Expense" },
  { value: "Owner Compensation",     label: "Owner Compensation" },
  { value: "Depreciation",           label: "Depreciation & Amortization" },
  { value: "Interest",               label: "Interest" },
  { value: "Taxes",                  label: "Taxes" },
  { value: "Non-Recurring",          label: "Non-Recurring" },
  { value: "Excluded",               label: "Excluded" },
];

const BALANCE_CATEGORIES = [
  { value: "Current Assets",         label: "Current Assets" },
  { value: "Fixed Assets",           label: "Fixed Assets" },
  { value: "Other Assets",           label: "Other Assets" },
  { value: "Current Liabilities",    label: "Current Liabilities" },
  { value: "Long-Term Liabilities",  label: "Long-Term Liabilities" },
  { value: "Equity",                 label: "Equity" },
  { value: "Excluded",               label: "Excluded" },
];

function getCategoryOrder(cat: string, order: string[]): number {
  const idx = order.indexOf(cat);
  return idx >= 0 ? idx : 999;
}

/* ──────────────────────────────────────────────
   Formatting
─────────────────────────────────────────────── */
function formatAmount(val: number | undefined | null): string {
  if (val == null) return "--";
  const abs = Math.abs(val);
  const formatted = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(abs);
  return val < 0 ? `(${formatted})` : formatted;
}

function amountColor(val: number | undefined | null, isTotal = false): string {
  if (val == null) return "text-muted-foreground/50";
  if (isTotal) return "text-foreground font-semibold";
  if (val < 0) return "text-red-400";
  return "text-foreground";
}

/* ──────────────────────────────────────────────
   Component
─────────────────────────────────────────────── */
export function ReclassifiedTable({ data, title = "Income Statement", years: yearsProp, mode = "pnl", onUpdate, emptyMessage }: ReclassifiedTableProps) {
  const [editingRowId, setEditingRowId] = useState<string | null>(null);
  const [editCategory, setEditCategory] = useState<string>("");

  const categories = mode === "balance" ? BALANCE_CATEGORIES : PNL_CATEGORIES;
  const categoryOrder = categories.map(c => c.value);

  // NOTE: all hooks must run before the empty-state return (data can flip
  // between null and loaded across renders — conditional hooks would crash).
  const rows = data?.rows ?? [];
  const years = yearsProp || data?.years || [];

  // Group rows by category
  const grouped = useMemo(() => {
    const groups: Record<string, FinancialRow[]> = {};
    for (const row of rows) {
      const cat = row.category || "Other";
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(row);
    }
    // Sort groups by category order
    const sorted = Object.entries(groups).sort(
      ([a], [b]) => getCategoryOrder(a, categoryOrder) - getCategoryOrder(b, categoryOrder)
    );
    return sorted;
  }, [rows, categoryOrder.join("|")]);

  // Calculate category subtotals
  const categoryTotals = useMemo(() => {
    const totals: Record<string, Record<string, number>> = {};
    for (const [cat, rows] of grouped) {
      totals[cat] = {};
      for (const year of years) {
        totals[cat][year] = rows.reduce((sum, r) => sum + (r.values[year] || 0), 0);
      }
    }
    return totals;
  }, [grouped, years]);

  // Grand total (Revenue + Other Income - everything else). Only meaningful in P&L mode.
  const grandTotals = useMemo(() => {
    const totals: Record<string, number> = {};
    for (const year of years) {
      let total = 0;
      for (const [cat, catTotal] of Object.entries(categoryTotals)) {
        if (cat === "Revenue" || cat === "Other Income") {
          total += catTotal[year] || 0;
        } else if (cat !== "Excluded") {
          total -= Math.abs(catTotal[year] || 0);
        }
      }
      totals[year] = total;
    }
    return totals;
  }, [categoryTotals, years]);

  const handleCategoryChange = useCallback((rowId: string, newCategory: string) => {
    if (!onUpdate || !data) return;
    const updatedRows = data.rows.map(r =>
      r.id === rowId ? { ...r, category: newCategory } : r
    );
    onUpdate({ ...data, rows: updatedRows });
    setEditingRowId(null);
  }, [data, onUpdate]);

  const startEditing = (rowId: string, currentCategory: string) => {
    setEditingRowId(rowId);
    setEditCategory(currentCategory);
  };

  if (!data || rows.length === 0) {
    const notes = data?.notes ?? [];
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{title}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground text-center py-8">
            {emptyMessage ?? "No data available. Run the financial analysis to populate this table."}
          </p>
          {notes.length > 0 && <AnalyzerNotes notes={notes} />}
        </CardContent>
      </Card>
    );
  }

  const notes = data.notes ?? [];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {notes.length > 0 && (
          <div className="px-4 pb-3">
            <AnalyzerNotes notes={notes} />
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground w-[280px]">
                  Account
                </th>
                {years.map(year => (
                  <th key={year} className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground w-[120px]">
                    {year}
                  </th>
                ))}
                {onUpdate && (
                  <th className="text-center px-3 py-2.5 text-xs font-medium text-muted-foreground w-[160px]">
                    Category
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {grouped.map(([category, rows]) => (
                <CategoryGroup
                  key={category}
                  category={category}
                  rows={rows}
                  years={years}
                  totals={categoryTotals[category]}
                  editingRowId={editingRowId}
                  editCategory={editCategory}
                  onEditCategory={setEditCategory}
                  onStartEditing={startEditing}
                  onCancelEditing={() => setEditingRowId(null)}
                  onSaveCategory={handleCategoryChange}
                  editable={!!onUpdate}
                  categories={categories}
                />
              ))}

              {/* Grand total — P&L only (balance sheets show per-category subtotals) */}
              {mode === "pnl" && (
                <tr className="border-t-2 border-border bg-muted/30">
                  <td className="px-4 py-3 font-semibold text-sm">Net Income</td>
                  {years.map(year => (
                    <td key={year} className={`text-right px-4 py-3 text-sm font-semibold ${
                      grandTotals[year] < 0 ? "text-red-400" : "text-teal"
                    }`}>
                      {formatAmount(grandTotals[year])}
                    </td>
                  ))}
                  {onUpdate && <td />}
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

/* ──────────────────────────────────────────────
   Analyzer notes — source mix, reconciliation warnings
─────────────────────────────────────────────── */
export function AnalyzerNotes({ notes }: { notes: string[] }) {
  if (notes.length === 0) return null;
  return (
    <div className="rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2 flex items-start gap-2">
      <Info className="h-3.5 w-3.5 text-amber-400 shrink-0 mt-0.5" />
      <ul className="space-y-1 text-xs text-muted-foreground min-w-0">
        {notes.map((note, i) => (
          <li key={i} className="leading-relaxed">{note}</li>
        ))}
      </ul>
    </div>
  );
}

/* ──────────────────────────────────────────────
   Category group sub-component
─────────────────────────────────────────────── */
interface CategoryGroupProps {
  category: string;
  rows: FinancialRow[];
  years: string[];
  totals: Record<string, number>;
  editingRowId: string | null;
  editCategory: string;
  onEditCategory: (val: string) => void;
  onStartEditing: (rowId: string, category: string) => void;
  onCancelEditing: () => void;
  onSaveCategory: (rowId: string, category: string) => void;
  editable: boolean;
  categories: Array<{ value: string; label: string }>;
}

function CategoryGroup({
  category,
  rows,
  years,
  totals,
  editingRowId,
  editCategory,
  onEditCategory,
  onStartEditing,
  onCancelEditing,
  onSaveCategory,
  editable,
  categories,
}: CategoryGroupProps) {
  return (
    <>
      {/* Category header */}
      <tr className="bg-muted/20">
        <td colSpan={years.length + (editable ? 2 : 1)} className="px-4 py-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {category}
          </span>
        </td>
      </tr>

      {/* Rows */}
      {rows.map(row => (
        <tr key={row.id} className="border-b border-border/50 hover:bg-accent/30 transition-colors group">
          <td className="px-4 py-2 pl-8 text-xs">
            {row.name}
            {row.categoryOverride && (
              <span className="ml-2 text-2xs text-teal/80" title="Reclassified by you — kept on re-run">edited</span>
            )}
          </td>
          {years.map(year => (
            <td key={year} className={`text-right px-4 py-2 text-xs tabular-nums ${amountColor(row.values[year])}`}>
              {formatAmount(row.values[year])}
            </td>
          ))}
          {editable && (
            <td className="px-3 py-1.5 text-center">
              {editingRowId === row.id ? (
                <div className="flex items-center gap-1">
                  <Select value={editCategory} onValueChange={onEditCategory}>
                    <SelectTrigger className="h-7 text-2xs w-[120px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {categories.map(c => (
                        <SelectItem key={c.value} value={c.value} className="text-xs">
                          {c.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 w-6 p-0"
                    onClick={() => onSaveCategory(row.id, editCategory)}
                    aria-label={`Save category for ${row.name}`}
                  >
                    <Check className="h-3 w-3 text-success" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 w-6 p-0"
                    onClick={onCancelEditing}
                    aria-label="Cancel reclassification"
                  >
                    <X className="h-3 w-3 text-muted-foreground" />
                  </Button>
                </div>
              ) : (
                <button
                  className="opacity-40 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-sm transition-opacity inline-flex items-center gap-1 text-2xs text-muted-foreground hover:text-foreground"
                  onClick={() => onStartEditing(row.id, row.category)}
                  aria-label={`Reclassify ${row.name}`}
                >
                  <Pencil className="h-2.5 w-2.5" />
                  Reclassify
                </button>
              )}
            </td>
          )}
        </tr>
      ))}

      {/* Category subtotal */}
      <tr className="border-b border-border">
        <td className="px-4 py-2 pl-8 text-xs font-medium text-muted-foreground">
          Total {category}
        </td>
        {years.map(year => (
          <td key={year} className={`text-right px-4 py-2 text-xs font-medium ${amountColor(totals[year], true)}`}>
            {formatAmount(totals[year])}
          </td>
        ))}
        {editable && <td />}
      </tr>
    </>
  );
}
