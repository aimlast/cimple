/**
 * One discrepancy's header line — severity, category, where it came from,
 * the readable subject and its state. Presentational (no data fetching) so
 * it renders the same everywhere and can be tested on its own.
 */
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, CheckCircle2, XCircle, MessageCircleQuestion, Lock } from "lucide-react";
import {
  discrepancyFieldLabel,
  discrepancyHasPrivateSide,
  isSettledDiscrepancy,
} from "@shared/discrepancy-sides";

export const SEVERITY_CONFIG = {
  critical:    { label: "Critical",    color: "bg-red-500/10 text-red-400 border-0",    icon: XCircle },
  significant: { label: "Significant", color: "bg-amber-500/10 text-amber-400 border-0", icon: AlertTriangle },
  minor:       { label: "Minor",       color: "bg-muted text-muted-foreground border-0", icon: AlertTriangle },
};

export const CATEGORY_LABELS: Record<string, string> = {
  financial: "Financial",
  operational: "Operational",
  legal: "Legal",
  factual: "Factual",
};

/** Where a row came from, when it isn't the verification check. */
export const SOURCE_BADGES: Record<string, string> = {
  financial_analysis: "Financial analysis",
  merge: "Sources disagree",
};

export interface DiscrepancyHeaderRow {
  field: string;
  factKey?: string | null;
  factYear?: string | null;
  severity: string;
  category: string;
  source?: string | null;
  status: string;
  interviewValue?: string | null;
  documentValue?: string | null;
  sideSources?: unknown;
}

export function DiscrepancyHeaderLine({ disc, showSource = true }: { disc: DiscrepancyHeaderRow; showSource?: boolean }) {
  const config = SEVERITY_CONFIG[disc.severity as keyof typeof SEVERITY_CONFIG] || SEVERITY_CONFIG.minor;
  const Icon = config.icon;
  const settled = isSettledDiscrepancy(disc);
  const routed = disc.status === "ask_seller";
  const priv = discrepancyHasPrivateSide(disc);
  const sourceBadge = showSource && disc.source ? SOURCE_BADGES[disc.source] : undefined;
  return (
    <div className="flex w-full items-start justify-between gap-2">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <Icon className={`h-3.5 w-3.5 shrink-0 ${config.color.split(" ")[1]}`} aria-hidden="true" />
        <Badge className={config.color}>{config.label}</Badge>
        <Badge variant="outline" className="text-2xs">{CATEGORY_LABELS[disc.category] || disc.category}</Badge>
        {sourceBadge && <Badge className="bg-teal/10 text-teal border-0 text-2xs">{sourceBadge}</Badge>}
        {(priv.interview || priv.document) && (
          <Badge variant="outline" className="text-2xs gap-1 text-muted-foreground" title="One side comes from your private notes — never shown to the seller">
            <Lock className="h-2.5 w-2.5" aria-hidden="true" /> Private
          </Badge>
        )}
        <span className="text-sm font-medium break-words" data-testid="discrepancy-label">{discrepancyFieldLabel(disc)}</span>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {routed && (
          <Badge className="bg-blue-500/10 text-blue-400 border-0 text-2xs gap-1">
            <MessageCircleQuestion className="h-2.5 w-2.5" /> Asked in interview
          </Badge>
        )}
        {settled && (
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" aria-label={disc.status === "accepted" ? "Accepted" : "Resolved"} data-testid="discrepancy-settled" />
        )}
      </div>
    </div>
  );
}
