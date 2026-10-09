/**
 * CimTab — the deal's CIM as a dashboard (spec §5.1, INTEGRATION §2.8).
 *
 *   Header: sections · approved · last generated, Open CIM builder, Regenerate all.
 *   "What each buyer sees": four tiles — Teaser · Blind CIM · Full CIM · Due
 *     diligence — each with its status, how many buyers have it and Preview.
 *   Tabs (state in the URL, ?view=): Needs attention (n) · Versions · Teaser ·
 *     Design, plus views other streams register (dd: Numbers & sources).
 *     Default: Needs attention when anything needs it, else Versions; Teaser
 *     when there is no CIM yet.
 *
 * Other streams add only through the slots in ./cim-tab-slots.tsx — tile
 * lines, tabs, Versions-card extras, attention rows, publish notes.
 */
import { useEffect, useMemo, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, CheckCircle2, Eye, EyeOff, FileText, Loader2, Lock, Megaphone, RefreshCw, ShieldAlert, ShieldCheck, Sparkles, Wand2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useDeal } from "@/contexts/DealContext";
import { useToast } from "@/hooks/use-toast";
import { useCimGeneration, cimGenerationKey } from "@/hooks/useCimGeneration";
import { useCimGenerationGate } from "@/hooks/useCimGenerationGate";
import { CimGenerationProgress } from "@/components/deal/CimGenerationProgress";
import { PanelError } from "@/components/deal/PanelError";
import { DiscrepancyPanel } from "@/components/deal/DiscrepancyPanel";
import {
  ACCESS_LEVELS, BLIND_ACCESS_LEVEL, DD_ACCESS_LEVEL, NAMED_ACCESS_LEVEL, TEASER_ACCESS_LEVEL, type AccessLevel,
} from "@shared/access-levels";
import { PREVIEW_PARAM } from "@/components/cim-builder/CimCanvas";
import { useBuilderState } from "@/components/cim-builder/CimSummaryCard";
import { useAiGate } from "@/components/cim-builder/useAiGate";
import { builderRequest, errorText, type BuilderState } from "@/components/cim-builder/api";
import { useDdRun } from "@/components/cim-builder/useDdRun";
import { CimFactsChanged, CimReviewPanel, attentionNoteGroups, notesDismissed } from "@/components/cim-builder/CimReviewPanel";
import { HeldPrivateCard, heldPrivateKey } from "@/components/cim-builder/HeldPrivateCard";
import { classifyGenerationWarnings, regenerateBuyerImpact, reviewingUpdate } from "@shared/cim-generation-warnings";
import { cn } from "@/lib/utils";
import { CimDesignCard } from "@/components/cim-design/CimDesignCard";
import { TeaserPanel } from "@/components/teaser/TeaserPanel";
import { useTeaserSummary } from "@/components/teaser/useTeaserSummary";
import { shortDay, type TeaserSummary } from "@/components/teaser/api";
import type { CimSection } from "@shared/schema";
import {
  ACCESS_TILE_LINES, ATTENTION_GROUPS, CIM_PUBLISH_NOTES, EXTRA_CIM_TAB_VIEWS, VERSION_CARD_EXTRAS, tileLinesFor,
  type CimTabViewProps, type TileLine,
} from "./cim-tab-slots";

function when(v: string | Date | null | undefined): string {
  if (!v) return "—";
  const d = new Date(v);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) +
    " at " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

type BaseView = "attention" | "versions" | "teaser" | "design";
const BASE_VIEWS: Array<{ key: BaseView; label: string }> = [
  { key: "attention", label: "Needs attention" },
  { key: "versions", label: "Versions" },
  { key: "teaser", label: "Teaser" },
  { key: "design", label: "Design" },
];
/** View params a view may keep in the URL (dd's Numbers & sources: tab, note). */
const PASS_THROUGH = ["tab", "note"];

interface HeldPrivateLite {
  showing?: unknown[];
  servedShowing?: unknown[];
}

export function CimTab() {
  const { deal, dealId } = useDeal();
  const [location, navigate] = useLocation();
  const search = useSearch();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data, isLoading, error, refetch, dataUpdatedAt } = useBuilderState(dealId, { poll: true });
  const generation = useCimGeneration(dealId);
  const gate = useAiGate(dealId);
  // Enough information to write the CIM? The same rule as the Overview, the
  // builder, the deal list and the server (shared/deal-progress).
  const infoGate = useCimGenerationGate(dealId, deal.interviewCompleted);
  const generateBlockedReason = gate.blockedReason ?? (infoGate.allowed ? null : infoGate.reason);
  const [regenOpen, setRegenOpen] = useState(false);
  const [dismissTick, setDismissTick] = useState(0);
  const teaserSummaryQ = useTeaserSummary(dealId);
  const { data: heldPrivate } = useQuery<HeldPrivateLite>({
    queryKey: heldPrivateKey(dealId),
    queryFn: () => builderRequest<HeldPrivateLite>("GET", `/api/deals/${dealId}/cim-held-private`),
  });

  // Slot contributions (hooks, in registry order — fixed at import time).
  const tileLineMaps = ACCESS_TILE_LINES.map((src) => src.useLines(dealId));
  const tileTooltipMaps = ACCESS_TILE_LINES.map((src) => src.useTooltips?.(dealId) ?? {});
  const versionExtras = VERSION_CARD_EXTRAS.map((src) => src.useExtras(dealId));
  const extraGroups = ATTENTION_GROUPS.map((src) => src.useGroup(dealId)).filter((g): g is NonNullable<typeof g> => !!g);
  const publishNotes = CIM_PUBLISH_NOTES.flatMap((src) => src.useNotes(dealId));
  const extraBadges = EXTRA_CIM_TAB_VIEWS.map((v) => v.useBadge?.(dealId) ?? null);

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
    mutationFn: () => builderRequest("POST", `/api/deals/${dealId}/generate-blind`),
    onSuccess: () => {
      refetch();
      qc.invalidateQueries({ queryKey: ["/api/deals", dealId] });
      toast({ title: "Blind version ready" });
    },
    onError: (e) => toast({ title: "Couldn't generate that version", description: errorText(e), variant: "destructive" }),
  });
  // The DD version is written in the background; its real outcome is
  // announced when this run's result arrives (useDdRun), never "ready" up front.
  const ddRun = useDdRun(dealId, { dd: data?.dd, fetchedAt: dataUpdatedAt, refetch });
  // Held-back blind sections: clear their back-off and redo them now.
  const retryBlind = useMutation({
    mutationFn: () => builderRequest("POST", `/api/deals/${dealId}/cim-blind/refresh`),
    onSuccess: () => {
      refetch();
      toast({ title: "Retrying the blind version", description: "Blind buyers get those sections as soon as they're redacted." });
    },
    onError: (e) => toast({ title: "Couldn't retry the blind version", description: errorText(e), variant: "destructive" }),
  });

  const teaser: TeaserSummary | null = teaserSummaryQ.data ?? (data as (BuilderState & { teaser?: TeaserSummary }) | undefined)?.teaser ?? null;

  // ── What needs attention (and how many groups) ─────────────────────────
  const attention = useMemo(() => {
    if (!data) return { count: 0, teaserHeld: [] as TeaserSummary["heldBlocks"] };
    const review = data.review;
    const warnings = review && !notesDismissed(dealId, review.warningsAt) ? classifyGenerationWarnings(review.warnings) : [];
    const groups = attentionNoteGroups(warnings, data.sections.filter((s) => s.placeholder).map((s) => ({ id: s.id, sectionTitle: s.sectionTitle })));
    const privateStaff = data.sections.some((s) => (s.privateStaff?.length ?? 0) > 0);
    const served = (review?.privateStaffServed?.length ?? 0) > 0;
    const heldPrivateProblems = ((heldPrivate?.servedShowing?.length ?? 0) > 0 ? 1 : 0);
    const teaserHeld = teaser?.heldBlocks ?? [];
    const count = (review?.heldFromBuyers ? 1 : 0) + groups.length + (privateStaff ? 1 : 0) + (served ? 1 : 0) + heldPrivateProblems
      + teaserHeld.length + (review?.facts ? 1 : 0) + extraGroups.filter((g) => g.counts).length;
    return { count, teaserHeld };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, teaser, heldPrivate, dealId, dismissTick, extraGroups.length]);

  // ── The view (URL) ─────────────────────────────────────────────────────
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const urlView = params.get("view");
  const allKeys = [...BASE_VIEWS.map((v) => v.key as string), ...EXTRA_CIM_TAB_VIEWS.map((v) => v.key)];
  const defaultView: string = !data ? "versions" : !hasSections ? "teaser" : attention.count > 0 ? "attention" : "versions";
  const view = urlView && allKeys.includes(urlView) ? urlView : defaultView;
  const setView = (key: string, extra?: Record<string, string>) => {
    const q = new URLSearchParams();
    q.set("view", key);
    for (const [k, v] of Object.entries(extra ?? {})) q.set(k, v);
    navigate(`${location.split("?")[0]}?${q.toString()}`);
  };
  // Settle the default into the URL once the data is in (replace: Back doesn't bounce).
  useEffect(() => {
    if (!data || (urlView && allKeys.includes(urlView))) return;
    const q = new URLSearchParams(search);
    q.set("view", defaultView);
    for (const k of Array.from(q.keys())) if (k !== "view" && !PASS_THROUGH.includes(k)) q.delete(k);
    navigate(`${location.split("?")[0]}?${q.toString()}`, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!data, urlView]);

  if (isLoading) {
    return (
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 space-y-4" data-testid="cim-tab-loading">
        <Skeleton className="h-10 w-64 rounded-lg" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-32 rounded-lg" />)}</div>
        <Skeleton className="h-9 w-full max-w-md rounded-lg" />
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
  const running = generation.isRunning || generate.isPending;
  const openBuilder = (preview?: string) => navigate(`/deal/${dealId}/design${preview ? `?preview=${preview}` : ""}`);
  // What "Regenerate all" does to buyers who can open the CIM now.
  const regenImpact = regenerateBuyerImpact({
    isLive: deal.isLive,
    openBuyers: data.buyers.total,
    approved: !!(deal.contentApprovedByBroker || deal.contentApprovedBySeller || deal.designApprovedByBroker || deal.designApprovedBySeller),
  });
  const byLevel = (l: AccessLevel) => data.buyers.byLevel[l] ?? 0;
  // Made, but buyers can't open it until the CIM is published.
  const readyWord: TileModel["status"] = deal.isLive ? { text: "Ready", tone: "ok" } : { text: "Ready · not live yet", tone: "amber" };
  const ddStatusWord = ddRun.busy ? "Writing" : !data.dd.generated ? "Not made yet" : (data.dd.outOfDate ?? 0) > 0 ? `${data.dd.outOfDate} section${data.dd.outOfDate === 1 ? "" : "s"} out of date` : "Ready";

  // ── The four tiles ─────────────────────────────────────────────────────
  const tiles: TileModel[] = [
    {
      level: TEASER_ACCESS_LEVEL,
      status: !teaser || teaser.status === "none" ? { text: "Not written yet", tone: "muted" }
        : teaser.status === "published" ? { text: `Published ${shortDay(teaser.publishedAt)}`, tone: "ok" }
        : teaser.status === "offline" ? { text: "Offline", tone: "muted" }
        : teaser.generation?.status === "running" ? { text: "Writing…", tone: "amber" }
        : { text: "Draft — not shared yet", tone: "amber" },
      count: teaser?.counts.links ?? byLevel(TEASER_ACCESS_LEVEL),
      sub: teaser && teaser.counts.openedToday > 0 ? `${teaser.counts.openedToday} opened today` : null,
      desc: "Short, anonymous, no NDA",
      amber: teaser && teaser.heldBlocks.length > 0 ? `${teaser.heldBlocks.length} block${teaser.heldBlocks.length === 1 ? "" : "s"} hidden from buyers` : null,
      onOpen: () => setView("teaser"),
      onPreview: teaser && teaser.status !== "none" ? () => navigate(`/deal/${dealId}/teaser?preview=1`) : null,
    },
    {
      level: BLIND_ACCESS_LEVEL,
      status: !hasSections ? { text: "No CIM yet", tone: "muted" }
        : !data.blind.generated ? { text: "Not made yet", tone: "amber" }
        : data.blind.held > 0 ? { text: `${data.blind.held} section${data.blind.held === 1 ? "" : "s"} held back`, tone: "red" }
        : data.blind.updating > 0 ? { text: `Updating ${data.blind.updating}`, tone: "amber" }
        : readyWord,
      count: byLevel(BLIND_ACCESS_LEVEL),
      desc: data.blind.codename ? `Under “${data.blind.codename}”` : "Under a project codename",
      onOpen: () => setView("versions"),
      onPreview: hasSections ? () => openBuilder(PREVIEW_PARAM[BLIND_ACCESS_LEVEL]) : null,
    },
    {
      level: NAMED_ACCESS_LEVEL,
      status: !hasSections ? { text: "No CIM yet", tone: "muted" } : readyWord,
      count: byLevel(NAMED_ACCESS_LEVEL),
      desc: "Name, people and places shown",
      onOpen: () => setView("versions"),
      onPreview: hasSections ? () => openBuilder(PREVIEW_PARAM[NAMED_ACCESS_LEVEL]) : null,
    },
    {
      level: DD_ACCESS_LEVEL,
      status: !hasSections ? { text: "No CIM yet", tone: "muted" } : ddStatusWord === "Ready" ? readyWord : { text: ddStatusWord, tone: ddRun.busy ? "amber" : (data.dd.outOfDate ?? 0) > 0 ? "blue" : "muted" },
      count: byLevel(DD_ACCESS_LEVEL),
      desc: "+ DD detail and the data room",
      onOpen: () => setView("versions"),
      onPreview: hasSections ? () => openBuilder(PREVIEW_PARAM[DD_ACCESS_LEVEL]) : null,
    },
  ];
  for (const t of tiles) {
    t.lines = tileLinesFor(t.level, tileLineMaps);
    t.tooltip = tileTooltipMaps.map((m) => m[t.level]).find(Boolean) ?? null;
  }

  const tabs = [
    ...BASE_VIEWS.map((v) => ({ key: v.key as string, label: v.label, badge: v.key === "attention" ? attention.count : null })),
    ...EXTRA_CIM_TAB_VIEWS.map((v, i) => ({ key: v.key, label: v.label, badge: extraBadges[i] })),
  ];
  const ExtraView = EXTRA_CIM_TAB_VIEWS.find((v) => v.key === view)?.Component;
  const viewProps: CimTabViewProps = { dealId, setView };
  const ddExtras = versionExtras.map((m) => m.dd).filter(Boolean);
  const blindExtras = versionExtras.map((m) => m.blind).filter(Boolean);
  const namedExtras = versionExtras.map((m) => m.named).filter(Boolean);

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 space-y-5" data-testid="cim-tab">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold tracking-tight">CIM</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            {hasSections
              ? `${sections.length} sections · ${approved} approved${hidden ? ` · ${hidden} hidden` : ""} · last generated ${when(data.deal.cimLayoutGeneratedAt)}`
              : "No CIM yet — generate one from the deal's information, then shape it in the builder."}
          </p>
          {deal.isLive && (reviewingUpdate(deal)
            ? <p className="text-xs text-amber-500 mt-1 flex items-center gap-1" data-testid="cim-tab-reviewing-update"><Eye className="h-3.5 w-3.5 shrink-0" /> Published — buyers are seeing the previous version until you publish the update</p>
            : <p className="text-xs text-success mt-1 flex items-center gap-1"><CheckCircle2 className="h-3.5 w-3.5" /> Published — buyers with access can open it</p>)}
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

      {/* What each buyer sees */}
      <section className="space-y-2" aria-labelledby="what-each-buyer-sees">
        <div className="flex items-end justify-between gap-3">
          <h3 id="what-each-buyer-sees" className="text-sm font-semibold">What each buyer sees</h3>
          <button type="button" className="text-xs text-teal hover:underline" onClick={() => navigate(`/deal/${dealId}/buyers`)}>Manage buyer access →</button>
        </div>
        <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4" data-testid="access-strip">
          {tiles.map((t) => <AccessTile key={t.level} tile={t} />)}
        </div>
      </section>

      {/* Tabs */}
      <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <div role="tablist" aria-label="CIM" className="inline-flex min-w-full gap-1 rounded-lg border border-border bg-muted/30 p-1 sm:min-w-0" data-testid="cim-tab-views">
          {tabs.map((t) => (
            <button
              key={t.key}
              role="tab"
              type="button"
              aria-selected={view === t.key}
              onClick={() => setView(t.key)}
              className={cn(
                "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition-colors",
                view === t.key ? "bg-background text-foreground shadow-sm font-medium" : "text-muted-foreground hover:text-foreground",
              )}
              data-testid={`cim-view-${t.key}`}
            >
              {t.label}
              {!!t.badge && t.badge > 0 && (
                <span className={cn("rounded-full px-1.5 text-[11px] font-semibold tabular-nums", view === t.key ? "bg-teal text-teal-foreground" : "bg-amber-500/15 text-amber-500")}>{t.badge}</span>
              )}
            </button>
          ))}
        </div>
      </div>

      <section role="tabpanel" aria-live="polite">
        {view === "attention" ? (
          <div className="space-y-2" data-testid="cim-attention">
            {hasSections && !generation.isRunning && (
              <CimReviewPanel
                dealId={dealId}
                review={data.review}
                sections={sections}
                grouped
                publishNotes={publishNotes}
                onReviewPublish={reviewingUpdate(deal) ? () => navigate(`/deal/${dealId}/overview`) : undefined}
                onNotesDismissed={() => setDismissTick((n) => n + 1)}
                onOpenSection={(id) => navigate(`/deal/${dealId}/design?section=${id}`)}
              />
            )}
            {/* Private staff matters held out of every version — each with an Include switch. */}
            <HeldPrivateCard dealId={dealId} />
            {attention.teaserHeld.map((h) => (
              <div key={h.blockId} className="flex flex-wrap items-start gap-2.5 rounded-lg border border-red-500/30 bg-red-500/5 px-3.5 py-3 text-sm" data-testid="cim-attention-teaser-held">
                <Megaphone className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
                <p className="min-w-0 flex-1">
                  <span className="font-medium">Your teaser's {h.title} block is hidden from buyers:</span>{" "}
                  <span className="text-muted-foreground">{h.reason.replace(/^it /, "it ")}.</span>
                </p>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => navigate(`/deal/${dealId}/teaser?block=${h.blockId}`)}>Open it</Button>
              </div>
            ))}
            {extraGroups.map((g) => <div key={g.key}>{g.node}</div>)}
            <CimFactsChanged review={data.review} sections={sections} onOpenSection={(id) => navigate(`/deal/${dealId}/design?section=${id}`)} />
            {attention.count === 0 && (
              <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border py-10 text-center" data-testid="cim-attention-empty">
                <CheckCircle2 className="h-6 w-6 text-success" />
                <p className="text-sm">Nothing needs your attention.</p>
                <p className="text-xs text-muted-foreground">Notes from the next generation, held-back sections and facts that change will show here.</p>
              </div>
            )}
          </div>
        ) : view === "versions" ? (
          hasSections ? (
            <div className="space-y-3" data-testid="cim-versions">
              <div className="grid gap-3 md:grid-cols-3">
                <VersionCard
                  icon={<Lock className="h-4 w-4" />}
                  title="Blind CIM"
                  who="Blind CIM buyers"
                  status={
                    !data.blind.generated ? <span className="text-amber-500">Not generated yet</span>
                      : data.blind.held > 0 ? <span className="text-red-400 inline-flex items-center gap-1" title={data.blind.error ?? undefined}><AlertTriangle className="h-3 w-3" /> {data.blind.held} section{data.blind.held === 1 ? "" : "s"} held back</span>
                      : data.blind.updating > 0 ? <span className="text-amber-500 inline-flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Updating {data.blind.updating} section{data.blind.updating === 1 ? "" : "s"}</span>
                      : <span className="text-success">Ready</span>
                  }
                  detail={data.blind.codename ? `Shown as “${data.blind.codename}”. Names, places and people are redacted.` : "Names, places and people redacted under a project codename."}
                  extra={
                    <>
                      {data.blind.codenameProblem && (
                        <p className="text-[11px] text-amber-500 leading-snug flex items-start gap-1" role="alert" data-testid="codename-problem">
                          <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                          <span>This codename could point buyers to the business: {data.blind.codenameProblem} Change it before sending the blind CIM to anyone new.</span>
                        </p>
                      )}
                      <CodenameEditor dealId={dealId} codename={data.blind.codename} onSaved={() => { refetch(); qc.invalidateQueries({ queryKey: ["/api/deals", dealId] }); }} />
                      {blindExtras}
                    </>
                  }
                  onPreview={() => openBuilder(PREVIEW_PARAM[BLIND_ACCESS_LEVEL])}
                  action={!data.blind.generated
                    ? { label: "Generate", busy: version.isPending, onClick: () => version.mutate() }
                    : data.blind.held > 0
                      ? { label: "Retry", busy: retryBlind.isPending, onClick: () => retryBlind.mutate() }
                      : undefined}
                />
                <VersionCard
                  icon={<FileText className="h-4 w-4" />}
                  title="Full CIM"
                  who="Full CIM buyers — the named CIM"
                  status={<span className="text-success">Ready</span>}
                  detail="The named CIM — business name, people and places shown."
                  extra={namedExtras.length ? <>{namedExtras}</> : undefined}
                  onPreview={() => openBuilder(PREVIEW_PARAM[NAMED_ACCESS_LEVEL])}
                />
                <VersionCard
                  icon={<ShieldCheck className="h-4 w-4" />}
                  title="Due diligence"
                  who="Due-diligence buyers"
                  status={ddRun.busy
                    ? <span className="text-amber-500 inline-flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Writing</span>
                    : !data.dd.generated
                      ? <span className="text-muted-foreground">Not generated</span>
                      : (data.dd.outOfDate ?? 0) > 0
                        ? <span className="text-blue-400">{data.dd.outOfDate} section{data.dd.outOfDate === 1 ? "" : "s"} out of date</span>
                        : <span className="text-success">Ready</span>}
                  detail="The Full CIM plus customer names and verification notes."
                  extra={(
                    <>
                      {!ddRun.busy && data.dd.lastRun && (data.dd.lastRun.error || data.dd.lastRun.warnings.length > 0) ? (
                        <div className="text-[11px] text-amber-500 leading-snug space-y-1" role="status" data-testid="dd-last-run">
                          {data.dd.lastRun.error
                            ? <p className="flex items-start gap-1"><AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" /><span>{data.dd.lastRun.error}</span></p>
                            : data.dd.lastRun.warnings.slice(0, 4).map((w, i) => (
                              <p key={i} className="flex items-start gap-1"><AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" /><span>{w}</span></p>
                            ))}
                          {!data.dd.lastRun.error && data.dd.lastRun.warnings.length > 4 && <p>…and {data.dd.lastRun.warnings.length - 4} more.</p>}
                        </div>
                      ) : null}
                      {ddExtras}
                    </>
                  )}
                  onPreview={() => openBuilder(PREVIEW_PARAM[DD_ACCESS_LEVEL])}
                  action={{
                    label: data.dd.generated ? "Refresh" : "Generate",
                    busy: ddRun.busy,
                    onClick: ddRun.start,
                  }}
                />
              </div>
              {hidden > 0 && (
                <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                  <EyeOff className="h-3.5 w-3.5" /> {hidden} hidden section{hidden === 1 ? " is" : "s are"} never sent to any buyer.
                </p>
              )}
            </div>
          ) : (
            <NoCimYet />
          )
        ) : view === "teaser" ? (
          <TeaserPanel dealId={dealId} />
        ) : view === "design" ? (
          hasSections ? (
            <CimDesignCard
              dealId={dealId}
              deal={deal}
              cover={(sections.find((s) => s.layoutType === "cover_page" && s.isVisible !== false) as unknown as CimSection) ?? null}
              onOpenDesign={() => navigate(`/deal/${dealId}/design?design=1`)}
            />
          ) : (
            <NoCimYet />
          )
        ) : ExtraView ? (
          <ExtraView {...viewProps} />
        ) : null}
      </section>

      <AlertDialog open={regenOpen} onOpenChange={setRegenOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Regenerate the whole CIM?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>Every section is rebuilt from scratch. These are discarded and can't be undone:</p>
                <ul className="list-disc pl-5 space-y-1">
                  <li>Sections you added, edited, rewrote or reordered</li>
                  <li>Approvals and hidden sections</li>
                  <li>The blind and due-diligence versions</li>
                </ul>
                <p>To redo one section, open the builder and regenerate just that section. Your teaser isn't changed.</p>
                {regenImpact && <p className="text-foreground" data-testid="text-regenerate-buyer-impact">{regenImpact}</p>}
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

function NoCimYet() {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border py-10 text-center">
      <Wand2 className="h-6 w-6 text-teal/60" />
      <p className="text-sm">No CIM yet</p>
      <p className="max-w-sm text-xs text-muted-foreground">Generate it from the deal's information with “Generate CIM” above. You can write the teaser now — it doesn't wait for the CIM.</p>
    </div>
  );
}

// ── The access tiles ─────────────────────────────────────────────────────
interface TileModel {
  level: AccessLevel;
  status: { text: string; tone: "ok" | "amber" | "red" | "blue" | "muted" };
  count: number;
  sub?: string | null;
  desc: string;
  amber?: string | null;
  onOpen: () => void;
  onPreview: (() => void) | null;
  lines?: TileLine[];
  tooltip?: string | null;
}

const TONE: Record<TileModel["status"]["tone"], string> = {
  ok: "text-success",
  amber: "text-amber-500",
  red: "text-red-400",
  blue: "text-blue-400",
  muted: "text-muted-foreground",
};

function AccessTile({ tile }: { tile: TileModel }) {
  const def = ACCESS_LEVELS.find((l) => l.key === tile.level)!;
  const body = (
    <div
      role="button"
      tabIndex={0}
      onClick={tile.onOpen}
      onKeyDown={(e) => { if (e.key === "Enter") tile.onOpen(); }}
      className="group relative flex h-full min-w-0 cursor-pointer flex-col gap-1 rounded-lg border border-border bg-card p-3 text-left transition-colors hover:border-teal/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal/60"
      data-testid={`access-tile-${tile.level}`}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{def.label}</p>
        {tile.onPreview && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); tile.onPreview?.(); }}
            className="-mr-1 -mt-1 inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={`Preview what a ${def.label} buyer sees`}
            data-testid={`access-tile-preview-${tile.level}`}
          >
            <Eye className="h-3.5 w-3.5" /> <span className="hidden lg:inline">Preview</span>
          </button>
        )}
      </div>
      <p className={cn("text-sm font-medium leading-snug", TONE[tile.status.tone])}>{tile.status.text}</p>
      <p className="text-xs text-foreground/80">
        <span className="tabular-nums">{tile.count}</span> buyer{tile.count === 1 ? "" : "s"}
        {tile.sub && <span className="text-teal"> · {tile.sub}</span>}
      </p>
      {tile.amber && <p className="flex items-center gap-1 text-[11px] text-amber-500"><ShieldAlert className="h-3 w-3 shrink-0" /> {tile.amber}</p>}
      <p className="mt-auto pt-1 text-[11px] leading-snug text-muted-foreground line-clamp-2">{tile.desc}</p>
      {(tile.lines ?? []).map((l) => (
        <p key={l.key} className={cn("text-[11px] leading-snug", l.tone === "amber" ? "text-amber-500" : "text-muted-foreground")}>
          {l.href ? <a href={l.href} onClick={(e) => e.stopPropagation()} className="hover:underline">{l.text}</a> : l.text}
        </p>
      ))}
    </div>
  );
  if (!tile.tooltip) return body;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{body}</TooltipTrigger>
      <TooltipContent>{tile.tooltip}</TooltipContent>
    </Tooltip>
  );
}

function VersionCard({
  icon, title, who, status, detail, extra, onPreview, action,
}: {
  icon: React.ReactNode;
  title: string;
  who: string;
  status: React.ReactNode;
  detail: string;
  extra?: React.ReactNode;
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
      {extra}
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

/**
 * The Blind CIM's project codename: what pre-NDA buyers know the deal by
 * (the blind cover, outreach, the view room). The server refuses a name that
 * would identify the business or that another of the broker's deals uses,
 * and carries a rename through the blind version and unsent outreach drafts.
 */
function CodenameEditor({ dealId, codename, onSaved }: { dealId: string; codename: string | null; onSaved: () => void }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(codename ?? "");
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (next: string) => builderRequest<{ codename: string; updated: number }>("PATCH", `/api/deals/${dealId}/codename`, { codename: next }),
    onSuccess: (r) => {
      setOpen(false);
      onSaved();
      toast({
        title: `Codename set to “${r.codename}”`,
        description: r.updated > 0 ? "The blind CIM and unsent outreach drafts now use it." : "Blind buyers will see the deal under this name.",
      });
    },
    onError: (e) => setError(errorText(e)),
  });
  const openDialog = () => {
    setValue(codename ?? "");
    setError(null);
    setOpen(true);
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    save.mutate(value);
  };
  return (
    <>
      <button type="button" className="self-start text-[11px] text-teal hover:underline" onClick={openDialog} data-testid="button-change-codename">
        {codename ? "Change codename" : "Choose a codename"}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={submit} className="space-y-4">
            <DialogHeader>
              <DialogTitle>Project codename</DialogTitle>
              <DialogDescription>
                Buyers who haven't signed an NDA know the deal by this name — on the blind CIM's cover, in outreach and in their view room. Use a neutral word: nothing that points to the business, its owner or its town.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5">
              <Input
                value={value}
                onChange={(e) => { setValue(e.target.value); setError(null); }}
                placeholder="Project Coastline"
                maxLength={60}
                autoFocus
                aria-invalid={!!error}
                data-testid="input-codename"
              />
              {error ? (
                <p className="text-xs text-red-400" role="alert">{error}</p>
              ) : (
                <p className="text-[11px] text-muted-foreground">Changing it updates the blind CIM and any outreach drafts you haven't sent. Emails already sent keep the old name.</p>
              )}
            </div>
            <DialogFooter className="gap-2 sm:gap-0">
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" className="bg-teal text-teal-foreground hover:bg-teal/90" disabled={save.isPending || !value.trim() || value.trim() === codename} data-testid="button-save-codename">
                {save.isPending && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />} Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
