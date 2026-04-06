import { useState, useMemo, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Pencil, Check, X } from "lucide-react";

/* ──────────────────────────────────────────────
   Types
─────────────────────────────────────────────── */
export interface FinancialRow {
  id: string;
  name: string;
  category: string;
  values: Record<string, number>; // year/period -> amount
}

export interface ReclassifiedTableData {
  years: string[];
  rows: FinancialRow[];
}

interface ReclassifiedTableProps {
  data: ReclassifiedTableData | null;
  title?: string;
  years?: string[];
  onUpdate?: (updated: ReclassifiedTableData) => void;
}

/* ──────────────────────────────────────────────
   Category config
─────────────────────────────────────────────── */
const CATEGORIES = [
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

const CATEGORY_ORDER = CATEGORIES.map(c => c.value);

function getCategoryOrder(cat: string): number {
  const idx = CATEGORY_ORDER.indexOf(cat);
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
export function ReclassifiedTable({ data, title = "Income Statement", years: yearsProp, onUpdate }: ReclassifiedTableProps) {
  const [editingRowId, setEditingRowId] = useState<string | null>(null);
  const [editCategory, setEditCategory] = useState<string>("");

  if (!data || !data.rows || data.rows.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{title}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground text-center py-8">
            No data available. Run the financial analysis to populate this table.
          </p>
        </CardContent>
      </Card>
    );
  }

  const years = yearsProp || data.years || [];

  // Group rows by category
  const grouped = useMemo(() => {
    const groups: Record<string, FinancialRow[]> = {};
    for (const row of data.rows) {
      const cat = row.category || "Other";
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(row);
    }
    // Sort groups by category order
    const sorted = Object.entries(groups).sort(
      ([a], [b]) => getCategoryOrder(a) - getCategoryOrder(b)
    );
    return sorted;
  }, [data.rows]);

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

  // Grand total (Revenue - everything else)
  const grandTotals = useMemo(() => {
    const totals: Record<string, number> = {};
    for (const year of years) {
      let total = 0;
      for (const [cat, catTotal] of Object.entries(categoryTotals)) {
        if (cat === "Revenue") {
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
    if (!onUpdate) return;
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

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
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
                />
              ))}

              {/* Grand total */}
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
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
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
                      {CATEGORIES.map(c => (
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
                  >
                    <Check className="h-3 w-3 text-success" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 w-6 p-0"
                    onClick={onCancelEditing}
                  >
                    <X className="h-3 w-3 text-muted-foreground" />
                  </Button>
                </div>
              ) : (
                <button
                  className="opacity-0 group-hover:opacity-100 transition-opacity inline-flex items-center gap-1 text-2xs text-muted-foreground hover:text-foreground"
                  onClick={() => onStartEditing(row.id, row.category)}
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
