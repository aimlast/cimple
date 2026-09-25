/**
 * CimTab — the deal's CIM at a glance: status and generation progress, the
 * three versions (Normal / Blind / Due diligence) with previews, the design
 * (template, branding, cover and brokerage pages), what each kind of buyer
 * sees, and the way into the CIM builder. Generate / regenerate
 * follow the same discrepancy gate as everywhere else.
 */
import { useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, CheckCircle2, Eye, EyeOff, FileText, Loader2, Lock, RefreshCw, ShieldCheck, Sparkles, Users, Wand2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useDeal } from "@/contexts/DealContext";
import { useToast } from "@/hooks/use-toast";
import { useCimGeneration, cimGenerationKey } from "@/hooks/useCimGeneration";
import { useCimGenerationGate } from "@/hooks/useCimGenerationGate";
import { CimGenerationProgress } from "@/components/deal/CimGenerationProgress";
import { PanelError } from "@/components/deal/PanelError";
import { DiscrepancyPanel } from "@/components/deal/DiscrepancyPanel";
import { BUYER_ACCESS_LEVELS } from "@shared/cim-layouts";
import { useBuilderState } from "@/components/cim-builder/CimSummaryCard";
import { useAiGate } from "@/components/cim-builder/useAiGate";
import { builderRequest, errorText } from "@/components/cim-builder/api";
import { cn } from "@/lib/utils";
import { CimDesignCard } from "@/components/cim-design/CimDesignCard";
import type { CimSection } from "@shared/schema";

function when(v: string | Date | null | undefined): string {
  if (!v) return "—";
  const d = new Date(v);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) +
    " at " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function CimTab() {
  const { deal, dealId } = useDeal();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data, isLoading, error, refetch } = useBuilderState(dealId, { poll: true });
  const generation = useCimGeneration(dealId);
  const gate = useAiGate(dealId);
  // Enough information to write the CIM? The same rule as the Overview, the
  // builder, the deal list and the server (shared/deal-progress).
  const infoGate = useCimGenerationGate(dealId, deal.interviewCompleted);
  const generateBlockedReason = gate.blockedReason ?? (infoGate.allowed ? null : infoGate.reason);
  const [regenOpen, setRegenOpen] = useState(false);

  const hasSections = (data?.sections.length ?? 0) > 0;
  const generate = useMutation({
    mutationFn: () => builderRequest("POST", `/api/deals/${dealId}/${hasSections ? "generate-layout" : "generate-content"}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: cimGenerationKey(dealId) });
      toast({ title: "Generating the CIM", description: "This runs in the background — you can leave this page." });
    },
    onError: (e) => {
      qc.invalidateQueries({ queryKey: ["/api/deals", dealId, "discrepancies"] });
      toast({ title: "Couldn't start generating", description: errorText(e), variant: "destructive" });
    },
  });
  const version = useMutation({
    mutationFn: (mode: "blind" | "dd") => builderRequest("POST", `/api/deals/${dealId}/generate-${mode}`),
    onSuccess: (_r, mode) => {
      refetch();
      qc.invalidateQueries({ queryKey: ["/api/deals", dealId] });
      toast({ title: mode === "blind" ? "Blind version ready" : "Due-diligence version ready" });
    },
    onError: (e) => toast({ title: "Couldn't generate that version", description: errorText(e), variant: "destructive" }),
  });

  if (isLoading) {
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 space-y-4">
        <Skeleton className="h-24 rounded-lg" />
        <Skeleton className="h-40 rounded-lg" />
      </div>
    );
  }
  if (error || !data) {
    return <div className="p-6"><PanelError what="the CIM" onRetry={() => refetch()} /></div>;
  }

  const sections = data.sections;
  const approved = sections.filter((s) => s.brokerApproved).length;
  const hidden = sections.filter((s) => s.isVisible === false).length;
  const fullOnly = sections.filter((s) => s.accessTier === "full" && s.isVisible !== false);
  const running = generation.isRunning || generate.isPending;
  const openBuilder = (preview?: string) => navigate(`/deal/${dealId}/design${preview ? `?preview=${preview}` : ""}`);

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">CIM</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            {hasSections
              ? `${sections.length} sections · ${approved} approved${hidden ? ` · ${hidden} hidden` : ""} · last generated ${when(data.deal.cimLayoutGeneratedAt)}`
              : "No CIM yet — generate one from the deal's information, then shape it in the builder."}
          </p>
          {deal.isLive && <p className="text-xs text-success mt-1 flex items-center gap-1"><CheckCircle2 className="h-3.5 w-3.5" /> Published — buyers with access can open it</p>}
        </div>
        <div className="flex flex-wrap gap-2 shrink-0">
          <Button className="bg-teal text-teal-foreground hover:bg-teal/90 gap-1.5" onClick={() => openBuilder()} data-testid="button-open-cim-builder-tab">
            <Wand2 className="h-4 w-4" /> Open CIM builder
          </Button>
          {hasSections ? (
            <Button variant="outline" className="gap-1.5" onClick={() => setRegenOpen(true)} disabled={running || !!gate.blockedReason || !infoGate.allowed} title={generateBlockedReason ?? undefined}>
              <RefreshCw className={cn("h-4 w-4", running && "animate-spin")} /> Regenerate all
            </Button>
          ) : (
            <Button variant="outline" className="gap-1.5" onClick={() => generate.mutate()} disabled={running || !!gate.blockedReason || !infoGate.allowed} title={generateBlockedReason ?? undefined} data-testid="button-generate-cim-tab">
              {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Generate CIM
            </Button>
          )}
        </div>
      </div>

      {(generation.isRunning || generation.job?.status === "failed") && <CimGenerationProgress view={generation} />}
      {gate.blockedReason && (
        <div className="space-y-3">
          <p className="text-xs text-red-400 flex items-center gap-1.5"><AlertTriangle className="h-3.5 w-3.5" /> {gate.blockedReason}</p>
          {gate.blockingCount > 0 && <DiscrepancyPanel dealId={dealId} />}
        </div>
      )}
      {!gate.blockedReason && !infoGate.allowed && infoGate.reason && (
        <p className="text-xs text-amber-500" data-testid="text-cim-needs-information">{infoGate.reason}</p>
      )}
      {!hasSections && !gate.blockedReason && infoGate.allowed && !deal.interviewCompleted && (
        <p className="text-xs text-muted-foreground" data-testid="text-cim-without-interview">
          The seller interview isn't finished — the CIM will be written from what you've collected so far.
        </p>
      )}

      {hasSections && (
        <>
          {/* Versions */}
          <section className="space-y-3">
            <h3 className="text-sm font-semibold">Versions</h3>
            <div className="grid gap-3 sm:grid-cols-3">
              <VersionCard
                icon={<FileText className="h-4 w-4" />}
                title="Normal"
                who="LOI buyers"
                status={<span className="text-success">Ready</span>}
                detail="The named CIM — business name, people and places shown."
                onPreview={() => openBuilder("loi")}
              />
              <VersionCard
                icon={<Lock className="h-4 w-4" />}
                title="Blind"
                who="Teaser and Full buyers"
                status={
                  !data.blind.generated ? <span className="text-amber-500">Not generated yet</span>
                    : data.blind.updating > 0 ? <span className="text-amber-500 inline-flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Updating {data.blind.updating} section{data.blind.updating === 1 ? "" : "s"}</span>
                    : <span className="text-success">Ready</span>
                }
                detail={data.blind.codename ? `Shown as “${data.blind.codename}”. Names, places and people are redacted.` : "Names, places and people redacted under a project codename."}
                onPreview={() => openBuilder("teaser")}
                action={!data.blind.generated
                  ? { label: "Generate", busy: version.isPending && version.variables === "blind", onClick: () => version.mutate("blind") }
                  : undefined}
              />
              <VersionCard
                icon={<ShieldCheck className="h-4 w-4" />}
                title="Due diligence"
                who="Due-diligence buyers"
                status={data.dd.generated ? <span className="text-success">Ready</span> : <span className="text-muted-foreground">Not generated</span>}
                detail="The named CIM plus customer names and verification notes."
                onPreview={() => openBuilder("due_diligence")}
                action={{
                  label: data.dd.generated ? "Refresh" : "Generate",
                  busy: version.isPending && version.variables === "dd",
                  onClick: () => version.mutate("dd"),
                }}
              />
            </div>
          </section>

          {/* Design: template, branding, cover + brokerage pages */}
          <CimDesignCard
            dealId={dealId}
            deal={deal}
            cover={(sections.find((s) => s.layoutType === "cover_page" && s.isVisible !== false) as unknown as CimSection) ?? null}
            onOpenDesign={() => navigate(`/deal/${dealId}/design?design=1`)}
          />

          {/* Access */}
          <section className="space-y-3">
            <div className="flex items-end justify-between gap-3">
              <h3 className="text-sm font-semibold">What each buyer sees</h3>
              <button type="button" className="text-xs text-teal hover:underline" onClick={() => navigate(`/deal/${dealId}/buyers`)}>Manage buyer access</button>
            </div>
            <div className="rounded-lg border border-border divide-y divide-border">
              {BUYER_ACCESS_LEVELS.map((l) => (
                <div key={l.key} className="flex items-center gap-3 px-4 py-3">
                  <Users className="h-4 w-4 text-muted-foreground shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">{l.label}</p>
                    <p className="text-xs text-muted-foreground">
                      {l.key === "teaser" && fullOnly.length > 0
                        ? `Blind CIM; ${fullOnly.length} section${fullOnly.length === 1 ? " is" : "s are"} locked (Full access only).`
                        : l.description}
                    </p>
                  </div>
                  <span className="text-xs text-muted-foreground tabular-nums shrink-0">
                    {data.buyers.byLevel[l.key] ?? 0} buyer{(data.buyers.byLevel[l.key] ?? 0) === 1 ? "" : "s"}
                  </span>
                  <Button variant="ghost" size="sm" className="h-7 text-xs gap-1 shrink-0" onClick={() => openBuilder(l.key)}>
                    <Eye className="h-3.5 w-3.5" /> Preview
                  </Button>
                </div>
              ))}
            </div>
            {fullOnly.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                Full access only: {fullOnly.map((s) => `“${s.sectionTitle}”`).join(", ")}.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Every section is visible to teaser buyers. In the builder, mark a section “Full access only” to show it locked until you upgrade a buyer.
              </p>
            )}
            {hidden > 0 && (
              <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                <EyeOff className="h-3.5 w-3.5" /> {hidden} hidden section{hidden === 1 ? " is" : "s are"} never sent to any buyer.
              </p>
            )}
          </section>
        </>
      )}

      <AlertDialog open={regenOpen} onOpenChange={setRegenOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Regenerate the whole CIM?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>Every section is rebuilt from scratch. These are discarded and can't be undone:</p>
                <ul className="list-disc pl-5 space-y-1">
                  <li>Sections you added, edited, rewrote or reordered</li>
                  <li>Approvals, hidden sections and access settings</li>
                  <li>The blind and due-diligence versions</li>
                </ul>
                <p>To redo one section, open the builder and regenerate just that section.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep my CIM</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => { setRegenOpen(false); generate.mutate(); }}>
              Discard and regenerate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function VersionCard({
  icon, title, who, status, detail, onPreview, action,
}: {
  icon: React.ReactNode;
  title: string;
  who: string;
  status: React.ReactNode;
  detail: string;
  onPreview: () => void;
  action?: { label: string; busy: boolean; onClick: () => void };
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-teal">{icon}</span>
        <p className="text-sm font-semibold">{title}</p>
        <span className="ml-auto text-[11px]">{status}</span>
      </div>
      <p className="text-[11px] text-muted-foreground">For {who}</p>
      <p className="text-xs text-muted-foreground leading-relaxed flex-1">{detail}</p>
      <div className="flex gap-2 pt-1">
        <Button size="sm" variant="outline" className="h-7 text-xs gap-1 flex-1" onClick={onPreview}>
          <Eye className="h-3 w-3" /> Preview
        </Button>
        {action && (
          <Button size="sm" variant="ghost" className="h-7 text-xs gap-1" onClick={action.onClick} disabled={action.busy}>
            {action.busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            {action.label}
          </Button>
        )}
      </div>
    </div>
  );
}
