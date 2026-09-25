/**
 * CimGenerationProgress — inline progress for a running CIM generation.
 * Shows a real bar (sections done / planned), the section just finished and
 * a time estimate, in place of the old "Designing CIM..." spinner.
 */
import { Loader2, AlertCircle } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { formatEta, type CimGenerationView } from "@/hooks/useCimGeneration";

interface Props {
  view: CimGenerationView;
  className?: string;
  /** Compact variant for toolbars (Designer). */
  compact?: boolean;
}

export function CimGenerationProgress({ view, className = "", compact = false }: Props) {
  const { job, isRunning, percent, etaSeconds, label } = view;
  if (!job) return null;

  if (job.status === "failed" && !isRunning && job.stoppedBy === "discrepancies") {
    const n = job.blockingDiscrepancies?.length ?? 0;
    const fields = n > 0 ? `: ${job.blockingDiscrepancies!.map((b) => b.field).join(", ")}` : "";
    if (job.stoppedReason === "new") {
      return (
        <div className={`flex items-start gap-2 rounded border border-amber-500/30 bg-amber-500/5 p-2.5 text-xs text-left ${className}`} data-testid="cim-generation-stopped">
          <AlertCircle className="h-3.5 w-3.5 text-amber-400 mt-0.5 shrink-0" />
          <div className="min-w-0">
            <p className="font-medium text-amber-400">
              Stopped before writing — {n} new conflict{n === 1 ? "" : "s"} to review
            </p>
            <p className="text-muted-foreground break-words">
              Before writing, Cimple checked the documents against what the seller said and found{fields}. Resolve {n === 1 ? "it" : "them"} or ask the seller, so the CIM uses the right figure{n === 1 ? "" : "s"}. Generating again goes ahead — only critical conflicts block. Nothing was written.
            </p>
          </div>
        </div>
      );
    }
    return (
      <div className={`flex items-start gap-2 rounded border border-amber-500/30 bg-amber-500/5 p-2.5 text-xs text-left ${className}`} data-testid="cim-generation-stopped">
        <AlertCircle className="h-3.5 w-3.5 text-amber-400 mt-0.5 shrink-0" />
        <div className="min-w-0">
          <p className="font-medium text-amber-400">
            Stopped before writing — {n > 0 ? `${n} critical discrepanc${n === 1 ? "y" : "ies"} to resolve` : "a critical discrepancy to resolve"}
          </p>
          <p className="text-muted-foreground break-words">
            The check found {n === 1 ? "a conflict" : "conflicts"} between what the seller said and the documents
            {n > 0 ? `: ${job.blockingDiscrepancies!.map((b) => b.field).join(", ")}` : ""}. Resolve {n === 1 ? "it" : "them"} in the Discrepancies panel, then generate again. Nothing was written.
          </p>
        </div>
      </div>
    );
  }

  if (job.status === "failed" && !isRunning) {
    return (
      <div className={`flex items-start gap-2 rounded border border-red-500/30 bg-red-500/5 p-2.5 text-xs ${className}`} data-testid="cim-generation-failed">
        <AlertCircle className="h-3.5 w-3.5 text-red-400 mt-0.5 shrink-0" />
        <div className="min-w-0">
          <p className="font-medium text-red-400">CIM generation failed</p>
          <p className="text-muted-foreground break-words">{job.error || "Try again."}</p>
        </div>
      </div>
    );
  }

  if (!isRunning) return null;

  const eta = formatEta(etaSeconds);
  if (compact) {
    return (
      <div className={`flex items-center gap-2 min-w-[220px] ${className}`} data-testid="cim-generation-progress">
        <Loader2 className="h-3 w-3 animate-spin text-teal shrink-0" />
        <div className="flex-1 min-w-0">
          <Progress value={percent} className="h-1.5" />
          <p className="text-[10px] text-muted-foreground truncate mt-1">
            {label}{eta ? ` · ${eta}` : ""}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={`rounded-lg border border-teal/30 bg-teal/5 p-4 text-left ${className}`} data-testid="cim-generation-progress">
      <div className="flex items-center justify-between gap-3 mb-2">
        <p className="text-sm font-medium flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin text-teal" />
          Designing your CIM
        </p>
        <p className="text-xs text-muted-foreground tabular-nums">
          {job.total > 0 ? `${job.done}/${job.total}` : ""}{eta ? ` · ${eta}` : ""}
        </p>
      </div>
      <Progress value={percent} className="h-2" />
      <p className="text-xs text-muted-foreground mt-2 truncate">{label}</p>
      <p className="text-[11px] text-muted-foreground/80 mt-1">
        This keeps running on the server — you can leave this page. You'll be notified when it's done.
      </p>
    </div>
  );
}
