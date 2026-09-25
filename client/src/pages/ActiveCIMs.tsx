/**
 * /broker/deals — the broker's deal list.
 *
 * Built on GET /api/deals/list (slim rows with next step, readiness, money,
 * counts and a real last-activity time). The broker chooses how to see it:
 * group (phase / whose move / industry / status), sort, filters, cards or a
 * compact table, and whether archived deals show. Choices are remembered in
 * this browser. `?phase=` deep links (dashboard pipeline) still filter.
 */
import { useEffect, useMemo, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertCircle, Archive, Building2, Plus, RefreshCw, SearchX, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ToastAction } from "@/components/ui/toast";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { DEAL_PHASES, isDealPhase } from "@shared/deal-progress";
import {
  filterDeals,
  groupDeals,
  loadPrefs,
  savePrefs,
  sortDeals,
  type DealListPrefs,
  type DealListRow,
} from "@/components/deals/deal-list-model";
import { DealCard, DealTableHeader, DealTableRow, type DealItemActions } from "@/components/deals/DealListItem";
import { ActiveFilterChips, DealListToolbar } from "@/components/deals/DealListToolbar";

// Archived rows are always fetched so "Show archived" and the Status group
// are instant; the server filters them for every other caller.
const LIST_KEY = ["/api/deals/list?includeArchived=1"];

function invalidateDealCaches() {
  queryClient.invalidateQueries({ queryKey: LIST_KEY });
  queryClient.invalidateQueries({ queryKey: ["/api/deals"] });
  queryClient.invalidateQueries({ queryKey: ["/api/broker/dashboard"] });
}

export default function ActiveCIMs() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const searchString = useSearch();
  const [search, setSearch] = useState("");
  const [prefs, setPrefs] = useState<DealListPrefs>(() => {
    const saved = loadPrefs();
    const deepPhase = new URLSearchParams(window.location.search).get("phase");
    return isDealPhase(deepPhase) ? { ...saved, phases: [deepPhase] } : saved;
  });
  const [pendingArchive, setPendingArchive] = useState<DealListRow | null>(null);

  // `?phase=` from the dashboard pipeline cells (also on in-app navigation
  // while this page is mounted). Unknown values are ignored.
  useEffect(() => {
    const deepPhase = new URLSearchParams(searchString).get("phase");
    if (isDealPhase(deepPhase)) {
      setPrefs((p) => (p.phases.length === 1 && p.phases[0] === deepPhase ? p : { ...p, phases: [deepPhase] }));
    }
  }, [searchString]);

  const updatePrefs = (patch: Partial<DealListPrefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      savePrefs(next);
      return next;
    });
    // Keep the URL honest: a single phase filter is shareable, anything else clears it.
    if (patch.phases) {
      const url = patch.phases.length === 1 ? `/broker/deals?phase=${encodeURIComponent(patch.phases[0])}` : "/broker/deals";
      if (url !== `/broker/deals${searchString ? `?${searchString}` : ""}`) setLocation(url, { replace: true });
    }
  };

  const { data: rows = [], isLoading, error, refetch, isFetching } = useQuery<DealListRow[]>({
    queryKey: LIST_KEY,
  });

  const archive = useMutation({
    mutationFn: async (deal: DealListRow) => {
      await apiRequest("POST", `/api/deals/${deal.id}/archive`);
      return deal;
    },
    onSuccess: (deal) => {
      invalidateDealCaches();
      setPendingArchive(null);
      toast({
        title: `Archived ${deal.businessName}`,
        description: prefs.showArchived ? undefined : "Turn on “Show archived” to see it again.",
        action: (
          <ToastAction altText="Undo archive" onClick={() => restore.mutate({ deal, quiet: true })}>
            Undo
          </ToastAction>
        ),
      });
    },
    onError: (e: Error) => toast({ title: "Couldn't archive the deal", description: e.message, variant: "destructive" }),
  });

  const restore = useMutation({
    mutationFn: async ({ deal }: { deal: DealListRow; quiet?: boolean }) => {
      await apiRequest("POST", `/api/deals/${deal.id}/unarchive`);
      return deal;
    },
    onSuccess: (deal, { quiet }) => {
      invalidateDealCaches();
      if (!quiet) toast({ title: `Restored ${deal.businessName}`, description: "It's back in your active deals." });
    },
    onError: (e: Error) => toast({ title: "Couldn't restore the deal", description: e.message, variant: "destructive" }),
  });

  const actions: DealItemActions = {
    onArchive: (deal) => setPendingArchive(deal),
    onRestore: (deal) => restore.mutate({ deal }),
  };

  /* ─── Derived ─── */
  const active = useMemo(() => rows.filter((d) => !d.archivedAt), [rows]);
  const archivedCount = rows.length - active.length;
  const liveCount = active.filter((d) => d.isLive).length;
  const yourMoveCount = active.filter((d) => d.nextStep.owner === "you").length;
  const phaseCounts = DEAL_PHASES.map((p) => ({ ...p, count: active.filter((d) => d.phase === p.key).length }));
  const industries = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of prefs.showArchived ? rows : active) if (d.industry) m.set(d.industry, (m.get(d.industry) ?? 0) + 1);
    // Keep a selected industry listed even if its only deals were archived.
    for (const i of prefs.industries) if (!m.has(i)) m.set(i, 0);
    return Array.from(m, ([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name));
  }, [rows, active, prefs.showArchived, prefs.industries]);

  const visible = useMemo(() => sortDeals(filterDeals(rows, prefs, search), prefs.sort), [rows, prefs, search]);
  const groups = useMemo(() => groupDeals(visible, prefs.groupBy), [visible, prefs.groupBy]);
  const filtering = !!search.trim() || prefs.phases.length > 0 || prefs.industries.length > 0 || prefs.liveOnly;

  const clearFilters = () => {
    setSearch("");
    updatePrefs({ phases: [], industries: [], liveOnly: false });
  };

  return (
    <div className="flex flex-col h-full min-h-screen">
      {/* ── Header ── */}
      <div className="px-4 sm:px-6 pt-6 pb-5 border-b border-border">
        <div className="flex items-start justify-between gap-4 mb-5">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight text-foreground">Deals</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              {isLoading
                ? "Loading…"
                : active.length === 0
                  ? archivedCount > 0 ? "No active deals" : "No deals yet"
                  : `${active.length} active deal${active.length !== 1 ? "s" : ""}${
                      yourMoveCount > 0 ? ` · ${yourMoveCount} waiting on you` : ""
                    }`}
            </p>
          </div>
          <Button
            size="sm"
            onClick={() => setLocation("/broker/new-deal")}
            className="h-8 text-xs bg-teal text-teal-foreground hover:bg-teal/90 gap-1.5 shadow-sm shrink-0"
            data-testid="button-new-deal"
          >
            <Plus className="h-3.5 w-3.5" />
            New Deal
          </Button>
        </div>

        {/* Pipeline strip — clicking a phase filters to it */}
        {/* Phones: a 3-column grid so every phase and Live stay visible;
            from sm, one row. */}
        <div className="grid grid-cols-3 gap-x-4 gap-y-4 sm:flex sm:items-end sm:gap-0 sm:overflow-x-auto scrollbar-hide sm:-mx-1 sm:px-1">
          {phaseCounts.map((p) => {
            const on = prefs.phases.length === 1 && prefs.phases[0] === p.key;
            return (
              <button
                key={p.key}
                type="button"
                onClick={() => updatePrefs({ phases: on ? [] : [p.key] })}
                aria-pressed={on}
                title={on ? "Show all phases" : `Show only ${p.label}`}
                className="flex min-w-0 flex-col items-start shrink-0 sm:pr-5 sm:mr-5 sm:border-r border-border text-left transition-opacity hover:opacity-80"
                data-testid={`stat-phase-${p.key}`}
              >
                <span className={`text-[10px] font-semibold uppercase tracking-[0.1em] mb-1 ${on ? "text-teal" : "text-muted-foreground/60"}`}>
                  {p.short}
                </span>
                <span className={`text-2xl font-semibold tabular-nums leading-none ${on ? "text-teal" : "text-foreground"}`}>
                  {isLoading ? "–" : p.count}
                </span>
                <span className="max-w-full truncate text-[11px] text-muted-foreground/70 mt-1.5 whitespace-nowrap">{p.label}</span>
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => updatePrefs({ liveOnly: !prefs.liveOnly })}
            aria-pressed={prefs.liveOnly}
            title={prefs.liveOnly ? "Show all deals" : "Show only live deals"}
            className="flex min-w-0 flex-col items-start shrink-0 text-left transition-opacity hover:opacity-80"
            data-testid="stat-live"
          >
            <span className="text-[10px] font-semibold uppercase tracking-[0.1em] mb-1 text-success/70">Live</span>
            <span className="text-2xl font-semibold tabular-nums leading-none text-success">{isLoading ? "–" : liveCount}</span>
            <span className={`text-[11px] mt-1.5 ${prefs.liveOnly ? "text-success" : "text-muted-foreground/70"}`}>
              {prefs.liveOnly ? "Showing live only" : "With buyers"}
            </span>
          </button>
        </div>
      </div>

      {/* ── Toolbar ── */}
      <div className="px-4 sm:px-6 py-3 border-b border-border space-y-2">
        <DealListToolbar
          prefs={prefs}
          onChange={updatePrefs}
          search={search}
          onSearch={setSearch}
          industries={industries}
          archivedCount={archivedCount}
        />
        <ActiveFilterChips prefs={prefs} onChange={updatePrefs} />
      </div>

      {/* ── List ── */}
      <div className="flex-1 overflow-auto scrollbar-thin">
        {isLoading ? (
          <LoadingState view={prefs.view} />
        ) : error ? (
          <ErrorState
            message={error instanceof Error ? error.message : undefined}
            retrying={isFetching}
            onRetry={() => refetch()}
          />
        ) : visible.length === 0 ? (
          <EmptyState
            kind={
              rows.length === 0 ? "none"
              : filtering ? "filtered"
              : active.length === 0 && !prefs.showArchived ? "allArchived"
              : "none"
            }
            archivedCount={archivedCount}
            onClear={clearFilters}
            onShowArchived={() => updatePrefs({ showArchived: true })}
            onNewDeal={() => setLocation("/broker/new-deal")}
          />
        ) : (
          <div className="px-4 sm:px-6 py-4 space-y-6">
            {filtering && (
              <p className="text-xs text-muted-foreground -mb-2">
                {visible.length} match{visible.length !== 1 ? "es" : ""}
              </p>
            )}
            {groups.map((g) => (
              <section key={g.key} aria-label={g.label || "Deals"}>
                {g.label && (
                  <div className="flex items-baseline gap-2 mb-2.5">
                    <h2 className="text-2xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">{g.label}</h2>
                    <span className="text-2xs tabular-nums text-muted-foreground/50">{g.rows.length}</span>
                    {g.hint && <span className="text-2xs text-muted-foreground/50 truncate hidden sm:inline">· {g.hint}</span>}
                  </div>
                )}
                {prefs.view === "cards" ? (
                  <div className="grid gap-3 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
                    {g.rows.map((d) => (
                      <DealCard key={d.id} deal={d} actions={actions} />
                    ))}
                  </div>
                ) : (
                  <div className="rounded-lg border border-border/70 overflow-hidden bg-card/40">
                    <DealTableHeader />
                    {g.rows.map((d) => (
                      <DealTableRow key={d.id} deal={d} actions={actions} />
                    ))}
                  </div>
                )}
              </section>
            ))}
          </div>
        )}
      </div>

      {/* ── Archive confirm ── */}
      <AlertDialog open={!!pendingArchive} onOpenChange={(o) => !o && !archive.isPending && setPendingArchive(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive {pendingArchive?.businessName}?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>
                  It leaves your deal list and dashboard. Nothing is deleted — documents, the interview and the CIM
                  stay as they are, and you can restore it any time from “Show archived”.
                </p>
                {pendingArchive?.isLive && (
                  <p className="rounded-md border border-teal/30 bg-teal/5 px-3 py-2 text-foreground/90">
                    This deal is live. Buyer links keep working, but new buyer questions and approvals for it won't
                    show on your dashboard while it's archived.
                  </p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={archive.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (pendingArchive) archive.mutate(pendingArchive);
              }}
              disabled={archive.isPending}
              data-testid="button-confirm-archive"
            >
              {archive.isPending ? "Archiving…" : "Archive deal"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/* ─── States ──────────────────────────────────────────────────────────── */

function LoadingState({ view }: { view: DealListPrefs["view"] }) {
  return (
    <div className="px-4 sm:px-6 py-4" aria-busy="true">
      {view === "cards" ? (
        <div className="grid gap-3 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-[178px] rounded-xl border border-border/60 bg-muted/30 animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="space-y-px">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="h-12 rounded-sm bg-muted/30 animate-pulse" />
          ))}
        </div>
      )}
    </div>
  );
}

function ErrorState({ message, retrying, onRetry }: { message?: string; retrying: boolean; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center px-6" role="alert" data-testid="deals-error">
      <div className="h-11 w-11 rounded-xl bg-destructive/10 border border-destructive/20 flex items-center justify-center mb-4">
        <AlertCircle className="h-5 w-5 text-destructive" />
      </div>
      <p className="text-sm font-medium text-foreground mb-1">Couldn't load your deals</p>
      <p className="text-xs text-muted-foreground max-w-[280px]">
        {message || "The server didn't respond. Check your connection and try again."}
      </p>
      <Button size="sm" variant="outline" onClick={onRetry} disabled={retrying} className="mt-5" data-testid="button-retry-deals">
        <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${retrying ? "animate-spin" : ""}`} />
        {retrying ? "Retrying..." : "Retry"}
      </Button>
    </div>
  );
}

function EmptyState({
  kind,
  archivedCount,
  onClear,
  onShowArchived,
  onNewDeal,
}: {
  kind: "none" | "filtered" | "allArchived";
  archivedCount: number;
  onClear: () => void;
  onShowArchived: () => void;
  onNewDeal: () => void;
}) {
  const content = {
    none: {
      icon: Building2,
      title: "No deals yet",
      body: "Create a deal, invite the seller, and Cimple takes it from questionnaire to a buyer-ready CIM.",
    },
    filtered: {
      icon: SearchX,
      title: "No deals match",
      body: "No deal fits what you've picked. Clear the search and filters to see every deal.",
    },
    allArchived: {
      icon: Archive,
      title: "All caught up",
      body: `Every deal is archived (${archivedCount}). Start a new one, or bring an archived deal back.`,
    },
  }[kind];
  const Icon = content.icon;
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center px-6" data-testid={`deals-empty-${kind}`}>
      <div className="h-11 w-11 rounded-xl bg-teal/8 border border-teal/15 flex items-center justify-center mb-4">
        <Icon className="h-5 w-5 text-teal/60" />
      </div>
      <p className="text-sm font-medium text-foreground mb-1">{content.title}</p>
      <p className="text-xs text-muted-foreground max-w-[300px]">{content.body}</p>
      <div className="mt-5 flex items-center gap-2">
        {kind === "filtered" ? (
          <Button size="sm" variant="outline" onClick={onClear} data-testid="button-clear-filters">
            <X className="h-3.5 w-3.5 mr-1.5" />
            Clear filters
          </Button>
        ) : (
          <>
            <Button size="sm" onClick={onNewDeal} className="bg-teal text-teal-foreground hover:bg-teal/90 shadow-sm">
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              New Deal
            </Button>
            {kind === "allArchived" && (
              <Button size="sm" variant="outline" onClick={onShowArchived}>
                Show archived
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
