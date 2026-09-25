/**
 * CimSummaryCard — the deal's CIM at a glance (sections, approvals, versions)
 * with the way into the builder. Used by the Overview's Phase 3 once a CIM
 * exists — the builder is the one place sections are edited.
 */
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { AlertTriangle, CheckCircle2, EyeOff, LayoutPanelLeft, Loader2, Lock, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { builderKey, builderRequest, type BuilderState } from "./api";

export function useBuilderState(dealId: string, opts: { poll?: boolean } = {}) {
  return useQuery<BuilderState>({
    queryKey: builderKey(dealId),
    enabled: !!dealId,
    queryFn: () => builderRequest<BuilderState>("GET", `/api/deals/${dealId}/cim-builder`),
    refetchInterval: (q) => {
      if (!opts.poll) return false;
      const s = q.state.data as BuilderState | undefined;
      return s && (s.blind.running || s.sections.some((x) => x.aiTask?.status === "running")) ? 4000 : false;
    },
  });
}

export function CimSummaryCard({ dealId }: { dealId: string }) {
  const [, navigate] = useLocation();
  const { data, isLoading, error } = useBuilderState(dealId);

  if (isLoading) return <Skeleton className="h-28 rounded-lg" />;
  if (error || !data) return null;

  const s = data.sections;
  const approved = s.filter((x) => x.brokerApproved).length;
  const hidden = s.filter((x) => x.isVisible === false).length;
  const full = s.filter((x) => x.accessTier === "full").length;

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3" data-testid="cim-summary-card">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
        <Stat value={s.length} label={s.length === 1 ? "section" : "sections"} />
        <Stat value={`${approved}/${s.length}`} label="approved" icon={<CheckCircle2 className="h-3.5 w-3.5 text-teal" />} />
        {hidden > 0 && <Stat value={hidden} label="hidden" icon={<EyeOff className="h-3.5 w-3.5 text-muted-foreground" />} />}
        {full > 0 && <Stat value={full} label="full-access only" icon={<Lock className="h-3.5 w-3.5 text-teal" />} />}
        <span className="text-xs text-muted-foreground">
          Blind version:{" "}
          {data.blind.generated
            ? data.blind.held > 0
              ? <span className="text-red-400 inline-flex items-center gap-1" title={data.blind.error ?? undefined}><AlertTriangle className="h-3 w-3" /> {data.blind.held} held back</span>
              : data.blind.updating > 0
                ? <span className="text-amber-500 inline-flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> updating {data.blind.updating}</span>
                : <span className="text-foreground">{data.blind.codename ?? "ready"}</span>
            : "not generated yet"}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" className="h-8 text-xs gap-1.5 bg-teal text-teal-foreground hover:bg-teal/90" onClick={() => navigate(`/deal/${dealId}/design`)} data-testid="button-open-cim-builder">
          <Wand2 className="h-3.5 w-3.5" /> Open CIM builder
        </Button>
        <Button size="sm" variant="outline" className="h-8 text-xs gap-1.5" onClick={() => navigate(`/deal/${dealId}/cim`)} data-testid="button-view-cim-tab">
          <LayoutPanelLeft className="h-3.5 w-3.5" /> View CIM tab
        </Button>
      </div>
    </div>
  );
}

function Stat({ value, label, icon }: { value: number | string; label: string; icon?: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {icon}
      <span className="font-semibold tabular-nums">{value}</span>
      <span className="text-muted-foreground text-xs">{label}</span>
    </span>
  );
}
