import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Minus } from "lucide-react";

/* ──────────────────────────────────────────────
   Types
─────────────────────────────────────────────── */
export interface WorkingCapitalItem {
  name: string;
  amount: number;
}

export interface WorkingCapitalData {
  currentAssets: WorkingCapitalItem[];
  currentLiabilities: WorkingCapitalItem[];
  netWorkingCapital: number;
  pegAmount?: number | null;
}

interface WorkingCapitalPanelProps {
  data: WorkingCapitalData | null;
}

/* ──────────────────────────────────────────────
   Formatting
─────────────────────────────────────────────── */
function formatAmount(val: number | undefined | null): string {
  if (val == null) return "--";
  const abs = Math.abs(val);
  const formatted = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(abs);
  return val < 0 ? `(${formatted})` : formatted;
}

/* ──────────────────────────────────────────────
   Component
─────────────────────────────────────────────── */
export function WorkingCapitalPanel({ data }: WorkingCapitalPanelProps) {
  if (!data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Working Capital</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground text-center py-8">
            No working capital data. Run the analysis first.
          </p>
        </CardContent>
      </Card>
    );
  }

  const { currentAssets, currentLiabilities, netWorkingCapital, pegAmount } = data;

  const totalAssets = currentAssets.reduce((sum, item) => sum + item.amount, 0);
  const totalLiabilities = currentLiabilities.reduce((sum, item) => sum + item.amount, 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        {/* Current Assets */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Current Assets</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <tbody>
                {currentAssets.map((item, i) => (
                  <tr key={i} className="border-b border-border/50">
                    <td className="px-4 py-2 text-xs">{item.name}</td>
                    <td className="text-right px-4 py-2 text-xs tabular-nums">{formatAmount(item.amount)}</td>
                  </tr>
                ))}
                <tr className="border-t border-border bg-muted/20">
                  <td className="px-4 py-2.5 text-xs font-semibold">Total Current Assets</td>
                  <td className="text-right px-4 py-2.5 text-xs font-semibold tabular-nums">
                    {formatAmount(totalAssets)}
                  </td>
                </tr>
              </tbody>
            </table>
          </CardContent>
        </Card>

        {/* Current Liabilities */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Current Liabilities</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <tbody>
                {currentLiabilities.map((item, i) => (
                  <tr key={i} className="border-b border-border/50">
                    <td className="px-4 py-2 text-xs">{item.name}</td>
                    <td className="text-right px-4 py-2 text-xs tabular-nums text-red-400">
                      {formatAmount(item.amount)}
                    </td>
                  </tr>
                ))}
                <tr className="border-t border-border bg-muted/20">
                  <td className="px-4 py-2.5 text-xs font-semibold">Total Current Liabilities</td>
                  <td className="text-right px-4 py-2.5 text-xs font-semibold tabular-nums text-red-400">
                    {formatAmount(totalLiabilities)}
                  </td>
                </tr>
              </tbody>
            </table>
          </CardContent>
        </Card>
      </div>

      {/* Net Working Capital */}
      <Card className="border-teal/30">
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <tbody>
              <tr>
                <td className="px-4 py-2.5 text-xs">Total Current Assets</td>
                <td className="text-right px-4 py-2.5 text-xs tabular-nums">{formatAmount(totalAssets)}</td>
              </tr>
              <tr className="border-t border-border/50">
                <td className="px-4 py-2.5 text-xs flex items-center gap-1">
                  <Minus className="h-3 w-3 text-muted-foreground" />
                  Total Current Liabilities
                </td>
                <td className="text-right px-4 py-2.5 text-xs tabular-nums text-red-400">
                  {formatAmount(totalLiabilities)}
                </td>
              </tr>
              <tr className="border-t-2 border-teal/30 bg-teal/5">
                <td className="px-4 py-3 text-sm font-semibold text-teal">
                  Net Working Capital
                </td>
                <td className={`text-right px-4 py-3 text-sm font-semibold tabular-nums ${
                  netWorkingCapital < 0 ? "text-red-400" : "text-teal"
                }`}>
                  {formatAmount(netWorkingCapital)}
                </td>
              </tr>
              {pegAmount != null && (
                <tr className="border-t border-border/50">
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">
                    Working Capital Peg
                  </td>
                  <td className="text-right px-4 py-2.5 text-xs tabular-nums text-muted-foreground">
                    {formatAmount(pegAmount)}
                  </td>
                </tr>
              )}
              {pegAmount != null && (
                <tr className="border-t border-border/50 bg-muted/20">
                  <td className="px-4 py-2.5 text-xs font-medium">
                    Surplus / (Deficit) vs Peg
                  </td>
                  <td className={`text-right px-4 py-2.5 text-xs font-medium tabular-nums ${
                    netWorkingCapital - pegAmount < 0 ? "text-red-400" : "text-success"
                  }`}>
                    {formatAmount(netWorkingCapital - pegAmount)}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
