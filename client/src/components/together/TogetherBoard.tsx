/**
 * "Interview together" — the live coverage board's page shell
 * (specs/together.md §4). Full screen: a top bar, the KPI strip, then the
 * rail · the list · the side column at 1440, and tabs (To ask · Sections ·
 * Start) on a phone. URL state: ?view=&section=&filter=&q=&screen=.
 *
 * Checklist mode (?listen=0, pass 1): the same board with no session and no
 * listening — the side column is "Start interview together" plus the
 * documents still needed. Opening it creates nothing and calls no model.
 */
import { useCallback, useMemo, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Eye, EyeOff, FileText, Loader2, MoreHorizontal, RefreshCw, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { useIsMobile } from "@/hooks/use-mobile";
import { boardRequest, invalidateCoverage, useCoverageBoard, type BrokerAudience } from "@/hooks/useCoverageBoard";
import { CoverageBoardView, type BoardState } from "@/components/coverage/CoverageBoardView";
import { CoverageHeadline } from "@/components/coverage/CoverageHeadline";
import { CoverageRail } from "@/components/coverage/CoverageRail";
import { DocumentsNeeded } from "@/components/coverage/DocumentsNeeded";
import { TogetherSetupDialog } from "@/components/deal/TogetherSetupDialog";
import { CallSheetDialog } from "./CallSheet";
import { viewCounts, type CoverageBoard, type CoverageFilter, type CoverageView } from "@shared/coverage-board";
import type { Deal } from "@shared/schema";

const VIEWS: CoverageView[] = ["ask", "all", "filed", "verify", "questions", "docs", "section"];
const FILTERS: CoverageFilter[] = ["all", "missing", "partial", "verify", "critical"];
type PhoneTab = "ask" | "sections" | "side";

function useBoardUrlState(): [BoardState & { screen: boolean; tab: PhoneTab }, (patch: Partial<BoardState & { screen: boolean; tab: PhoneTab }>) => void] {
  const search = useSearch();
  const [location, setLocation] = useLocation();
  const qs = useMemo(() => new URLSearchParams(search), [search]);
  const viewRaw = qs.get("view") as CoverageView | null;
  const filterRaw = qs.get("filter") as CoverageFilter | null;
  const tabRaw = qs.get("tab") as PhoneTab | null;
  const state = {
    view: viewRaw && VIEWS.includes(viewRaw) ? viewRaw : "ask",
    filter: filterRaw && FILTERS.includes(filterRaw) ? filterRaw : "all",
    query: qs.get("q") ?? "",
    section: qs.get("section") ?? undefined,
    screen: qs.get("screen") === "1",
    tab: tabRaw === "sections" || tabRaw === "side" ? tabRaw : "ask",
  } as BoardState & { screen: boolean; tab: PhoneTab };
  const set = useCallback(
    (patch: Partial<BoardState & { screen: boolean; tab: PhoneTab }>) => {
      const next = new URLSearchParams(search);
      const apply = (k: string, v: string | undefined | null, dflt?: string) => {
        if (v === undefined) return;
        if (v === null || v === "" || v === dflt) next.delete(k);
        else next.set(k, v);
      };
      if (patch.view !== undefined) {
        apply("view", patch.view, "ask");
        if (patch.view !== "section") next.delete("section");
      }
      if (patch.section !== undefined) apply("section", patch.section);
      if (patch.filter !== undefined) apply("filter", patch.filter, "all");
      if (patch.query !== undefined) apply("q", patch.query);
      if (patch.screen !== undefined) apply("screen", patch.screen ? "1" : null);
      if (patch.tab !== undefined) apply("tab", patch.tab, "ask");
      const path = location.split("?")[0];
      setLocation(`${path}?${next.toString()}`, { replace: true });
    },
    [search, location, setLocation],
  );
  return [state, set];
}

function StatusBanner({ board, onRetry }: { board: CoverageBoard; onRetry: () => void }) {
  const p = board.plan;
  if (p.status === "building") {
    return (
      <div className="mx-1 mb-3 rounded-md border border-teal/30 bg-teal/5 px-3 py-2 text-xs flex items-start gap-2" data-testid="banner-plan-building">
        <Loader2 className="h-3.5 w-3.5 mt-px animate-spin text-teal shrink-0" />
        <span>Building the {p.industry ?? "industry"} checklist — the standard CIM data points are below; the {p.industry ?? "industry"}-specific ones appear in about a minute.</span>
        <button type="button" onClick={onRetry} className="ml-auto underline underline-offset-2 text-muted-foreground hover:text-foreground shrink-0">Check again</button>
      </div>
    );
  }
  if (p.status === "no_industry") {
    return <div className="mx-1 mb-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs" data-testid="banner-no-industry">Add the business's industry on the deal to get its industry checklist.</div>;
  }
  if (p.status === "unavailable") {
    return <div className="mx-1 mb-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground" data-testid="banner-plan-unavailable">Standard checklist — no industry playbook matched this business yet.</div>;
  }
  return null;
}

function ChecklistSide({ dealId, board, onStart, onCallSheet }: { dealId: string; board: CoverageBoard; onStart: () => void; onCallSheet: () => void }) {
  return (
    <div className="space-y-4" data-testid="checklist-side">
      <div className="rounded-lg border border-border bg-card p-4">
        <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">Interview together</p>
        <p className="text-sm mt-1.5">Talk to the seller in any order. Cimple listens, files their answers into this checklist, and shows what's still missing.</p>
        <p className="text-xs text-muted-foreground mt-1.5">In person, on a Cimple video call, or with Cimple's notetaker in Zoom, Meet or Teams.</p>
        <Button className="mt-3 w-full gap-1.5 bg-teal text-teal-foreground hover:bg-teal/90" onClick={onStart} data-testid="button-start-together">
          <Users className="h-4 w-4" /> Start interview together
        </Button>
        <Button variant="ghost" size="sm" className="mt-1.5 w-full gap-1.5 text-xs" onClick={onCallSheet} data-testid="button-call-sheet">
          <FileText className="h-3.5 w-3.5" /> Copy or print a call sheet
        </Button>
      </div>
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-baseline justify-between">
          <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">Documents still needed</p>
          <span className="text-xs tabular-nums text-muted-foreground">{board.documents.length}</span>
        </div>
        <div className="mt-1.5"><DocumentsNeeded dealId={dealId} documents={board.documents} compact /></div>
      </div>
    </div>
  );
}

function RemovedMenu({ dealId, board }: { dealId: string; board: CoverageBoard }) {
  const { toast } = useToast();
  const removed = board.removed;
  if (!removed || (removed.items.length === 0 && removed.sections.length === 0)) return null;
  const restore = async (body: Record<string, unknown>) => {
    try {
      await boardRequest("PATCH", `/api/deals/${dealId}/interview-outline`, body, "Couldn't bring it back");
      invalidateCoverage(dealId);
    } catch (e) {
      toast({ title: "Couldn't bring it back", description: (e as Error).message, variant: "destructive" });
    }
  };
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel className="text-[11px] text-muted-foreground font-normal">Removed from the checklist ({removed.items.length + removed.sections.length})</DropdownMenuLabel>
      {removed.items.map((i) => (
        <DropdownMenuItem key={i.key} onSelect={() => void restore({ restoreItems: [i.key] })}>Bring back: {i.label}</DropdownMenuItem>
      ))}
      {removed.sections.map((s) => (
        <DropdownMenuItem key={s.key} onSelect={() => void restore({ restoreSection: s.key })}>Bring back section: {s.title}</DropdownMenuItem>
      ))}
    </>
  );
}

export function TogetherBoard({ dealId }: { dealId: string }) {
  const [, setLocation] = useLocation();
  const isPhone = useIsMobile();
  const [state, setState] = useBoardUrlState();
  const audience: BrokerAudience = state.screen ? "screen" : "broker";
  const { data: deal } = useQuery<Deal>({ queryKey: ["/api/deals", dealId], enabled: !!dealId });
  const { data: board, isLoading, error, refetch, isFetching } = useCoverageBoard(dealId, audience);
  const [setupOpen, setSetupOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const onState = useCallback((patch: Partial<BoardState>) => setState(patch), [setState]);

  const back = () => setLocation(`/deal/${dealId}/overview`);
  const screenToggle = (
    <label className="inline-flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none" title="Shows only what the seller could see anyway — anything private to you reads 'On file — private to you'.">
      <Switch checked={state.screen} onCheckedChange={(v) => setState({ screen: v })} aria-label="Seller can see this screen" data-testid="switch-seller-sees-screen" />
      Seller can see this screen
    </label>
  );
  const menu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" className="h-8 w-8" aria-label="More" data-testid="button-board-menu"><MoreHorizontal className="h-4 w-4" /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuItem onSelect={() => setSheetOpen(true)}>Copy / print call sheet</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setLocation(`/deal/${dealId}/overview`)}>Change the checklist (on the Overview)</DropdownMenuItem>
        {board && !state.screen && <RemovedMenu dealId={dealId} board={board} />}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  // ── Top bar ──
  const topBar = (
    <header className="h-[52px] shrink-0 border-b border-border bg-card/50 flex items-center gap-3 px-4" data-testid="together-topbar">
      <button type="button" onClick={back} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground" aria-label="Back to the deal">
        <ArrowLeft className="h-4 w-4" />{!isPhone && "Back"}
      </button>
      <span className="text-sm font-semibold truncate min-w-0">{deal?.businessName ?? " "}</span>
      {!isPhone && <span className="text-xs text-muted-foreground shrink-0">· Interview together · Checklist</span>}
      <div className="ml-auto flex items-center gap-2 shrink-0">
        {isPhone ? (
          <Button
            variant="outline"
            size="icon"
            className={`h-8 w-8 ${state.screen ? "border-teal/60 bg-teal/10 text-teal" : ""}`}
            aria-pressed={state.screen}
            aria-label={state.screen ? "Seller can see this screen — on" : "Seller can see this screen — off"}
            onClick={() => setState({ screen: !state.screen })}
            data-testid="button-seller-sees-screen"
          >
            {state.screen ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
          </Button>
        ) : (
          screenToggle
        )}
        {menu}
        {!isPhone && (
          <Button size="sm" className="h-8 gap-1.5 bg-teal text-teal-foreground hover:bg-teal/90" onClick={() => setSetupOpen(true)} data-testid="button-topbar-start">
            <Users className="h-3.5 w-3.5" /> Start interview together
          </Button>
        )}
      </div>
    </header>
  );

  let body: JSX.Element;
  if (isLoading || (!board && !error)) {
    body = (
      <div className="p-4 space-y-4" data-testid="board-loading">
        <div className="h-14 rounded-md bg-muted animate-pulse" />
        <div className="grid gap-4 lg:grid-cols-[248px_1fr_380px]">
          <div className="hidden lg:block h-96 rounded-md bg-muted animate-pulse" />
          <div className="h-96 rounded-md bg-muted animate-pulse" />
          <div className="hidden lg:block h-64 rounded-md bg-muted animate-pulse" />
        </div>
        <p className="text-xs text-muted-foreground">Getting the checklist…</p>
      </div>
    );
  } else if (error || !board) {
    body = (
      <div className="p-8 text-center space-y-3" data-testid="board-error">
        <p className="text-sm">Couldn't load the checklist.</p>
        <p className="text-xs text-muted-foreground">{(error as Error)?.message}</p>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => refetch()} disabled={isFetching}><RefreshCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} /> Try again</Button>
      </div>
    );
  } else if (isPhone) {
    const counts = viewCounts(board);
    body = (
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="px-4 py-3 border-b border-border" data-testid="board-kpi">
          <CoverageHeadline board={board} variant="phone" onFilter={(f) => setState({ view: "ask", filter: f, tab: "ask" })} activeFilter={state.filter} />
        </div>
        <div className="sticky top-0 z-10 bg-background border-b border-border grid grid-cols-3 text-sm" role="tablist">
          {([
            ["ask", `To ask ${counts.ask}`],
            ["sections", "Sections"],
            ["side", "Start"],
          ] as const).map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={state.tab === k} onClick={() => setState({ tab: k })} className={`py-2.5 ${state.tab === k ? "text-foreground border-b-2 border-teal" : "text-muted-foreground"}`} data-testid={`tab-${k}`}>
              {label}
            </button>
          ))}
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto pb-20">
          {state.tab === "ask" && (
            <>
              <div className="px-4 pt-3"><StatusBanner board={board} onRetry={() => refetch()} /></div>
              <CoverageBoardView variant="checklist" dealId={dealId} board={board} audience={audience} state={state} onState={onState} touch />
            </>
          )}
          {state.tab === "sections" && (
            <div className="p-4">
              <CoverageRail board={board} view={state.view} sectionKey={state.section} fullWidth onSelect={(view, section) => setState({ view, section, filter: "all", query: "", tab: "ask" })} />
            </div>
          )}
          {state.tab === "side" && <div className="p-4"><ChecklistSide dealId={dealId} board={board} onStart={() => setSetupOpen(true)} onCallSheet={() => setSheetOpen(true)} /></div>}
        </div>
        <div className="fixed bottom-0 inset-x-0 z-20 border-t border-border bg-card/95 backdrop-blur px-4 py-2.5 flex items-center gap-2" data-testid="board-bottom-bar">
          <span className="text-xs text-muted-foreground flex-1 min-w-0 truncate">{board.totals.criticalOpen > 0 ? `${board.totals.criticalOpen} critical still open` : "Every critical data point is on file"}</span>
          <Button size="sm" className="gap-1.5 bg-teal text-teal-foreground hover:bg-teal/90" onClick={() => setSetupOpen(true)} data-testid="button-bottom-start"><Users className="h-3.5 w-3.5" /> Interview together</Button>
        </div>
      </div>
    );
  } else {
    body = (
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="px-5 py-4 border-b border-border" data-testid="board-kpi">
          <CoverageHeadline board={board} variant="strip" onFilter={(f) => setState({ view: "ask", filter: f })} activeFilter={state.view === "ask" ? state.filter : undefined} />
        </div>
        <div className="flex-1 min-h-0 grid grid-cols-[220px_minmax(0,1fr)] lg:grid-cols-[248px_minmax(0,1fr)_340px] xl:grid-cols-[248px_minmax(0,1fr)_380px]">
          <aside className="border-r border-border overflow-y-auto p-3">
            <CoverageRail board={board} view={state.view} sectionKey={state.section} onSelect={(view, section) => setState({ view, section, filter: "all", query: "" })} />
          </aside>
          <main className="min-w-0 overflow-y-auto px-4 py-4" data-testid="board-center">
            <StatusBanner board={board} onRetry={() => refetch()} />
            {state.screen && <p className="mx-1 mb-3 text-[11px] text-muted-foreground" data-testid="screen-note">The seller can see this screen: anything only you can see reads “On file — private to you”.</p>}
            <CoverageBoardView variant="checklist" dealId={dealId} board={board} audience={audience} state={state} onState={onState} />
          </main>
          <aside className="hidden lg:block border-l border-border overflow-y-auto p-4">
            <ChecklistSide dealId={dealId} board={board} onStart={() => setSetupOpen(true)} onCallSheet={() => setSheetOpen(true)} />
          </aside>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-background overflow-hidden" data-testid="together-board" data-audience={audience}>
      {topBar}
      {body}
      <TogetherSetupDialog dealId={dealId} open={setupOpen} onOpenChange={setSetupOpen} />
      {board && <CallSheetDialog board={board} businessName={deal?.businessName} open={sheetOpen} onOpenChange={setSheetOpen} />}
    </div>
  );
}
