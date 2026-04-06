import { useState, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Plus, Check, X, TrendingUp, TrendingDown, Minus
} from "lucide-react";

/* ──────────────────────────────────────────────
   Types
─────────────────────────────────────────────── */
export interface Addback {
  id: string;
  label: string;
  description?: string;
  category: string; // owner_comp, discretionary, non_recurring, one_time, other
  amounts: Record<string, number>; // year -> amount
  approved: boolean;
}

export interface NormalizationData {
  metric: "sde" | "ebitda";
  years: string[];
  netIncome: Record<string, number>; // year -> net income
  addbacks: Addback[];
}

interface NormalizationPanelProps {
  data: NormalizationData | null;
  onUpdate?: (updated: NormalizationData) => void;
}

/* ──────────────────────────────────────────────
   Category badges
─────────────────────────────────────────────── */
const ADDBACK_CATEGORIES: Record<string, { label: string; color: string }> = {
  owner_comp:     { label: "Owner Comp",     color: "bg-blue-500/10 text-blue-400 border-0" },
  discretionary:  { label: "Discretionary",  color: "bg-purple-500/10 text-purple-400 border-0" },
  non_recurring:  { label: "Non-Recurring",  color: "bg-amber-500/10 text-amber-400 border-0" },
  one_time:       { label: "One-Time",       color: "bg-orange-500/10 text-orange-400 border-0" },
  other:          { label: "Other",          color: "bg-muted text-muted-foreground border-0" },
};

/* ──────────────────────────────────────────────
   Formatting
─────────────────────────────────────────────── */
function formatAmount(val: number | undefined | null): string {
  if (val == null) return "--";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(val);
}

function YoYTrend({ current, previous }: { current?: number; previous?: number }) {
  if (current == null || previous == null || previous === 0) return null;
  const pct = ((current - previous) / Math.abs(previous)) * 100;
  const isUp = pct > 0;
  const Icon = pct > 0 ? TrendingUp : pct < 0 ? TrendingDown : Minus;
  return (
    <span className={`inline-flex items-center gap-0.5 text-2xs ${isUp ? "text-success" : "text-red-400"}`}>
      <Icon className="h-3 w-3" />
      {Math.abs(pct).toFixed(1)}%
    </span>
  );
}

/* ──────────────────────────────────────────────
   Component
─────────────────────────────────────────────── */
export function NormalizationPanel({ data, onUpdate }: NormalizationPanelProps) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newAmounts, setNewAmounts] = useState<Record<string, string>>({});

  if (!data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">SDE / EBITDA Normalization</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground text-center py-8">
            No normalization data. Run the analysis first.
          </p>
        </CardContent>
      </Card>
    );
  }

  const { metric, years, netIncome, addbacks } = data;
  const metricLabel = metric === "ebitda" ? "EBITDA" : "SDE";

  // Toggle metric
  const toggleMetric = () => {
    if (!onUpdate) return;
    onUpdate({ ...data, metric: metric === "sde" ? "ebitda" : "sde" });
  };

  // Toggle addback approval
  const toggleApproval = (addbackId: string) => {
    if (!onUpdate) return;
    const updatedAddbacks = addbacks.map(a =>
      a.id === addbackId ? { ...a, approved: !a.approved } : a
    );
    onUpdate({ ...data, addbacks: updatedAddbacks });
  };

  // Calculate adjusted totals per year (only approved addbacks)
  const adjustedTotals = useMemo(() => {
    const totals: Record<string, number> = {};
    for (const year of years) {
      let total = netIncome[year] || 0;
      for (const ab of addbacks) {
        if (ab.approved) {
          total += ab.amounts[year] || 0;
        }
      }
      totals[year] = total;
    }
    return totals;
  }, [years, netIncome, addbacks]);

  // Add custom addback
  const addCustomAddback = () => {
    if (!onUpdate || !newLabel.trim()) return;
    const amounts: Record<string, number> = {};
    for (const year of years) {
      amounts[year] = parseFloat(newAmounts[year] || "0") || 0;
    }
    const newAddback: Addback = {
      id: `custom_${Date.now()}`,
      label: newLabel.trim(),
      description: newDesc.trim() || undefined,
      category: "other",
      amounts,
      approved: true,
    };
    onUpdate({ ...data, addbacks: [...addbacks, newAddback] });
    setNewLabel("");
    setNewDesc("");
    setNewAmounts({});
    setShowAddForm(false);
  };

  return (
    <div className="space-y-4">
      {/* Metric toggle */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Base Metric</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {metric === "sde"
                  ? "Seller's Discretionary Earnings (includes owner compensation)"
                  : "Earnings Before Interest, Taxes, Depreciation & Amortization"}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Label className={`text-xs ${metric === "sde" ? "text-teal font-medium" : "text-muted-foreground"}`}>
                SDE
              </Label>
              <Switch
                checked={metric === "ebitda"}
                onCheckedChange={toggleMetric}
                disabled={!onUpdate}
              />
              <Label className={`text-xs ${metric === "ebitda" ? "text-teal font-medium" : "text-muted-foreground"}`}>
                EBITDA
              </Label>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Normalization table */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">{metricLabel} Normalization</CardTitle>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs gap-1"
              onClick={() => setShowAddForm(!showAddForm)}
              disabled={!onUpdate}
            >
              <Plus className="h-3 w-3" /> Add Addback
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground w-[260px]">
                    Item
                  </th>
                  {years.map(year => (
                    <th key={year} className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground w-[120px]">
                      {year}
                    </th>
                  ))}
                  {onUpdate && (
                    <th className="text-center px-3 py-2.5 text-xs font-medium text-muted-foreground w-[80px]">
                      Status
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {/* Net income row */}
                <tr className="border-b border-border bg-muted/20">
                  <td className="px-4 py-2.5 text-xs font-medium">
                    Net Income (as reported)
                  </td>
                  {years.map(year => (
                    <td key={year} className={`text-right px-4 py-2.5 text-xs tabular-nums font-medium ${
                      (netIncome[year] || 0) < 0 ? "text-red-400" : "text-foreground"
                    }`}>
                      {formatAmount(netIncome[year])}
                    </td>
                  ))}
                  {onUpdate && <td />}
                </tr>

                {/* Addback rows */}
                {addbacks.map(ab => {
                  const catCfg = ADDBACK_CATEGORIES[ab.category] || ADDBACK_CATEGORIES.other;
                  return (
                    <tr key={ab.id} className={`border-b border-border/50 transition-colors ${
                      ab.approved ? "hover:bg-accent/30" : "opacity-50 hover:bg-accent/20"
                    }`}>
                      <td className="px-4 py-2.5 pl-6">
                        <div className="flex items-start gap-2">
                          <div className="flex-1 min-w-0">
                            <p className={`text-xs ${ab.approved ? "" : "line-through text-muted-foreground"}`}>
                              {ab.label}
                            </p>
                            {ab.description && (
                              <p className="text-2xs text-muted-foreground mt-0.5 truncate">{ab.description}</p>
                            )}
                          </div>
                          <Badge className={`${catCfg.color} text-2xs shrink-0`}>
                            {catCfg.label}
                          </Badge>
                        </div>
                      </td>
                      {years.map(year => (
                        <td key={year} className={`text-right px-4 py-2.5 text-xs tabular-nums ${
                          ab.approved ? "text-success" : "text-muted-foreground"
                        }`}>
                          {ab.approved ? `+${formatAmount(ab.amounts[year])}` : formatAmount(ab.amounts[year])}
                        </td>
                      ))}
                      {onUpdate && (
                        <td className="text-center px-3 py-2.5">
                          <button
                            onClick={() => toggleApproval(ab.id)}
                            className={`inline-flex items-center justify-center h-6 w-6 rounded-full transition-colors ${
                              ab.approved
                                ? "bg-success/10 text-success hover:bg-success/20"
                                : "bg-muted text-muted-foreground hover:bg-muted/80"
                            }`}
                          >
                            {ab.approved ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}

                {/* Add custom addback form */}
                {showAddForm && (
                  <tr className="border-b border-border bg-teal/5">
                    <td className="px-4 py-3 pl-6">
                      <div className="space-y-1.5">
                        <Input
                          placeholder="Addback name"
                          value={newLabel}
                          onChange={e => setNewLabel(e.target.value)}
                          className="h-7 text-xs"
                        />
                        <Input
                          placeholder="Description (optional)"
                          value={newDesc}
                          onChange={e => setNewDesc(e.target.value)}
                          className="h-7 text-xs"
                        />
                      </div>
                    </td>
                    {years.map(year => (
                      <td key={year} className="px-4 py-3">
                        <Input
                          type="number"
                          placeholder="0"
                          value={newAmounts[year] || ""}
                          onChange={e => setNewAmounts({ ...newAmounts, [year]: e.target.value })}
                          className="h-7 text-xs text-right"
                        />
                      </td>
                    ))}
                    {onUpdate && (
                      <td className="text-center px-3 py-3">
                        <div className="flex items-center gap-1 justify-center">
                          <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={addCustomAddback}>
                            <Check className="h-3 w-3 text-success" />
                          </Button>
                          <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={() => setShowAddForm(false)}>
                            <X className="h-3 w-3 text-muted-foreground" />
                          </Button>
                        </div>
                      </td>
                    )}
                  </tr>
                )}

                {/* Adjusted total */}
                <tr className="border-t-2 border-teal/30 bg-teal/5">
                  <td className="px-4 py-3 font-semibold text-sm text-teal">
                    Adjusted {metricLabel}
                  </td>
                  {years.map((year, i) => (
                    <td key={year} className="text-right px-4 py-3">
                      <div className="flex items-center justify-end gap-2">
                        <span className="text-sm font-semibold text-teal tabular-nums">
                          {formatAmount(adjustedTotals[year])}
                        </span>
                        {i > 0 && (
                          <YoYTrend
                            current={adjustedTotals[year]}
                            previous={adjustedTotals[years[i - 1]]}
                          />
                        )}
                      </div>
                    </td>
                  ))}
                  {onUpdate && <td />}
                </tr>
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
