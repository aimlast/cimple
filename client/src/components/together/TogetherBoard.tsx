/**
 * "Interview together" — the live coverage board's page shell
 * (specs/together.md §4). Full screen: a top bar, the KPI strip, then the
 * rail · the list · the side column at 1440, and tabs on a phone. URL
 * state: ?view=&section=&filter=&q=&tab= (and ?screen= in checklist mode).
 *
 * Checklist mode (?listen=0): the same board with no session and no
 * listening — the side column is "Start interview together" plus the
 * documents still needed. Opening it creates nothing and calls no model.
 *
 * Live mode (in person, a Cimple call, or Zoom / Meet / Teams with the
 * notetaker): a session together starts or resumes (no AI call), the side
 * column is the live panel (listening, who's who, the transcript, Suggest
 * next, what was filed, "Add what they said…"), the top bar carries the
 * listening pill, "Seller can see this screen" (on the session — the server
 * then only ever sends the seller-safe board), Pop out and End session.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation, useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, Eye, EyeOff, FileText, Loader2, MonitorSmartphone, MoreHorizontal, PictureInPicture2, RefreshCw, Sparkles, Users, Video, WifiOff } from "lucide-react";
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
import { TogetherSetupDialog, type Via } from "@/components/deal/TogetherSetupDialog";
import { CallSheetDialog } from "./CallSheet";
import { ConsentDialog } from "./ConsentDialog";
import { EndSessionDialog } from "./EndSessionDialog";
import { LivePanel, filedThisSession, suggestContext } from "./LivePanel";
import { ListeningPill } from "./ModeCards";
import { SuggestNext } from "./SuggestNext";
import { TogetherPip } from "./TogetherPip";
import { useTogetherSitting } from "@/hooks/useTogetherSitting";
import { useLiveListening } from "@/hooks/useLiveListening";
import { usePictureInPicture } from "@/lib/pip";
import { viewCounts, type CoverageBoard, type CoverageFilter, type CoverageView } from "@shared/coverage-board";
import { VIA_LABEL, listenCopy, listenIsActive, listenIsProblem, type TogetherVia } from "@shared/together";
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

function ChecklistSide({ dealId, board, onStart, onCallSheet }: { dealId: string; board: CoverageBoard; onStart: (via?: Via) => void; onCallSheet: () => void }) {
  const modes: Array<{ via: Via; label: string; hint: string; Icon: typeof Users }> = [
    { via: "person", label: "In person", hint: "Same room or on speaker — one laptop listens.", Icon: Users },
    { via: "cimple", label: "Cimple video call", hint: "One link for the seller; the checklist beside the video.", Icon: Video },
    { via: "zoom", label: "Zoom, Meet or Teams", hint: "Your own call — Cimple's notetaker joins it.", Icon: MonitorSmartphone },
  ];
  return (
    <div className="space-y-4" data-testid="checklist-side">
      <div className="rounded-lg border border-border bg-card p-4">
        <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">Start interview together</p>
        <p className="text-sm mt-1.5">Talk to the seller in any order. Cimple listens, files their answers into this checklist, and shows what's still missing.</p>
        <ul className="mt-3 space-y-1.5">
          {modes.map((m) => (
            <li key={m.via}>
              <button
                type="button"
                onClick={() => onStart(m.via)}
                className="w-full text-left rounded-md border border-border px-3 py-2 hover:border-teal/50 hover:bg-teal/5 transition-colors flex items-start gap-2.5"
                data-testid={`button-start-${m.via}`}
              >
                <m.Icon className="h-4 w-4 mt-0.5 text-teal shrink-0" />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{m.label}</span>
                  <span className="block text-[11px] text-muted-foreground">{m.hint}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        <Button variant="ghost" size="sm" className="mt-2 w-full gap-1.5 text-xs" onClick={onCallSheet} data-testid="button-call-sheet">
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

export function TogetherBoard({ dealId, listen = false, via = "person", meetingLink }: { dealId: string; listen?: boolean; via?: TogetherVia; meetingLink?: string }) {
  return listen ? <LiveBoard dealId={dealId} via={via} meetingLink={meetingLink} /> : <ChecklistBoard dealId={dealId} />;
}

function ChecklistBoard({ dealId }: { dealId: string }) {
  const [, setLocation] = useLocation();
  const isPhone = useIsMobile();
  const [state, setState] = useBoardUrlState();
  const audience: BrokerAudience = state.screen ? "screen" : "broker";
  const { data: deal } = useQuery<Deal>({ queryKey: ["/api/deals", dealId], enabled: !!dealId });
  const { data: board, isLoading, error, refetch, isFetching } = useCoverageBoard(dealId, audience);
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupVia, setSetupVia] = useState<Via | undefined>(undefined);
  // In person needs nothing more — straight in; the others pick in the dialog (a meeting link, the call).
  const startTogether = (via?: Via) => {
    if (via === "person") {
      setLocation(`/deal/${dealId}/interview/together?via=person`);
      return;
    }
    setSetupVia(via);
    setSetupOpen(true);
  };
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
          <Button size="sm" className="h-8 gap-1.5 bg-teal text-teal-foreground hover:bg-teal/90 lg:hidden" onClick={() => startTogether()} data-testid="button-topbar-start">
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
          {state.tab === "side" && <div className="p-4"><ChecklistSide dealId={dealId} board={board} onStart={startTogether} onCallSheet={() => setSheetOpen(true)} /></div>}
        </div>
        <div className="fixed bottom-0 inset-x-0 z-20 border-t border-border bg-card/95 backdrop-blur px-4 py-2.5 flex items-center gap-2" data-testid="board-bottom-bar">
          <span className="text-xs text-muted-foreground flex-1 min-w-0 truncate">{board.totals.criticalOpen > 0 ? `${board.totals.criticalOpen} critical still open` : "Every critical data point is on file"}</span>
          <Button size="sm" className="gap-1.5 bg-teal text-teal-foreground hover:bg-teal/90" onClick={() => startTogether()} data-testid="button-bottom-start"><Users className="h-3.5 w-3.5" /> Interview together</Button>
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
            <ChecklistSide dealId={dealId} board={board} onStart={startTogether} onCallSheet={() => setSheetOpen(true)} />
          </aside>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-background overflow-hidden" data-testid="together-board" data-audience={audience}>
      {topBar}
      {body}
      <TogetherSetupDialog dealId={dealId} open={setupOpen} onOpenChange={setSetupOpen} initialVia={setupVia} />
      {board && <CallSheetDialog board={board} businessName={deal?.businessName} open={sheetOpen} onOpenChange={setSheetOpen} />}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Live mode — a session together
// ─────────────────────────────────────────────────────────────────────────

const JUST_FILED_MS = 60_000;

function useNow(everyMs: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

function LiveBoard({ dealId, via, meetingLink }: { dealId: string; via: TogetherVia; meetingLink?: string }) {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const isPhone = useIsMobile();
  const [state, setState] = useBoardUrlState();
  const onState = useCallback((patch: Partial<BoardState>) => setState(patch), [setState]);
  const { data: deal } = useQuery<Deal>({ queryKey: ["/api/deals", dealId], enabled: !!dealId });
  const sit = useTogetherSitting(dealId, via, { enabled: true });
  const sitting = sit.sitting;
  const ended = sitting?.status === "ended";
  const audience: BrokerAudience = sitting?.sellerSeesScreen ? "screen" : "broker";
  const { data: board, isLoading, error, refetch, isFetching } = useCoverageBoard(dealId, audience, { sittingId: sitting?.id ?? null, enabled: !!sitting });

  // Consent (D15): the first start of listening asks first.
  const [consentOpen, setConsentOpen] = useState(false);
  const consentResolve = useRef<((ok: boolean) => void) | null>(null);
  const requestConsent = useCallback(() => new Promise<boolean>((resolve) => {
    consentResolve.current = resolve;
    setConsentOpen(true);
  }), []);
  const listening = useLiveListening({
    dealId,
    sittingId: sitting?.id ?? null,
    via: sitting?.via ?? via,
    consented: !!sitting?.consentAt,
    requestConsent,
    onLine: sit.postLine,
    notetakerState: sit.notetaker,
    sessionEnded: ended,
  });

  // "Pause listening" pauses the session too (the seller's own interview is
  // free while it's paused); listening again resumes it.
  const listenState = listening.state;
  const sittingStatus = sitting?.status;
  useEffect(() => {
    if (listenState === "paused" && sittingStatus === "live") void sit.pause().catch(() => undefined);
    else if (listenIsActive(listenState) && sittingStatus === "paused") void sit.resume().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listenState, sittingStatus]);

  const pip = usePictureInPicture({ width: 460, height: 600 });
  const [endOpen, setEndOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const now = useNow(5_000);
  // "Just filed" lasts a minute from when THIS page saw the filing (a slow
  // filing still glows for the broker); filings already on the board when
  // the page opened glow only if they are under a minute old.
  const seenFiled = useRef<Map<string, number> | null>(null);
  const justFiled = useMemo(() => {
    const out = new Set<string>();
    if (!board || !sitting) return out;
    const firstLoad = seenFiled.current === null;
    const seen = (seenFiled.current ??= new Map());
    const t = Date.now();
    for (const s of board.sections) for (const i of s.items) {
      if (i.filedInSittingId !== sitting.id || !i.filedAt) continue;
      const mark = `${i.id}@${i.filedByChunkId ?? i.filedAt}`;
      if (!seen.has(mark)) seen.set(mark, firstLoad ? new Date(i.filedAt).getTime() : t);
      if (t - (seen.get(mark) ?? 0) < JUST_FILED_MS) out.add(i.id);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board, sitting?.id, now]);
  const filedCount = useMemo(() => filedThisSession(board, sitting?.id).length, [board, sitting?.id]);

  const back = () => setLocation(`/deal/${dealId}/overview`);
  const showItem = useCallback((itemId: string, sectionKey?: string) => {
    const scroll = () => {
      const el = document.querySelector(`[data-item-id="${CSS.escape(itemId)}"]`) as HTMLElement | null;
      if (!el) return false;
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.classList.add("cov-row-flash");
      setTimeout(() => el.classList.remove("cov-row-flash"), 2_500);
      return true;
    };
    if (isPhone && state.tab !== "ask") setState({ tab: "ask" });
    if (!scroll() && sectionKey) {
      setState({ view: "section", section: sectionKey, filter: "all", query: "", ...(isPhone ? { tab: "ask" as const } : {}) });
      setTimeout(scroll, 120);
    }
  }, [isPhone, state.tab, setState]);

  const toggleScreen = async () => {
    if (!sitting) return;
    try {
      await sit.setScreen(!sitting.sellerSeesScreen);
    } catch (e) {
      toast({ title: "Couldn't change that", description: (e as Error).message, variant: "destructive" });
    }
  };
  const popOut = async () => {
    if (!pip.supported) {
      toast({ title: "Pop out needs Chrome or Edge", description: "Open Cimple in Chrome or Edge to float the checklist over your call." });
      return;
    }
    try {
      if (pip.isOpen) pip.close();
      else await pip.open();
    } catch {
      toast({ title: "Couldn't pop the checklist out", description: "Try again from a click on this page.", variant: "destructive" });
    }
  };

  const retryFiling = async () => {
    try {
      await sit.retry();
      toast({ title: "Trying again", description: "Parts waiting to be filed are being filed now." });
    } catch (e) {
      toast({ title: "Couldn't try again", description: (e as Error).message, variant: "destructive" });
    }
  };

  // The transcript was deleted: this session ends (nothing handed to the seller) and a new one starts.
  const startNewSession = async () => {
    try {
      if (sitting && !ended) await sit.end({ completeInterview: false, followUps: [], documents: [], addToNextSession: false });
      sit.retryStart();
    } catch (e) {
      toast({ title: "Couldn't start a new session", description: (e as Error).message, variant: "destructive" });
    }
  };
  const screenOn = !!sitting?.sellerSeesScreen;
  const pill = <ListeningPill state={listening.state} startedAt={listening.startedAt} compact={isPhone} />;
  const menu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="icon" className="h-8 w-8" aria-label="More" data-testid="button-board-menu"><MoreHorizontal className="h-4 w-4" /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        {isPhone && <DropdownMenuItem onSelect={() => void popOut()}>Pop out</DropdownMenuItem>}
        <DropdownMenuItem onSelect={() => setSheetOpen(true)}>Copy / print call sheet</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setLocation(`/deal/${dealId}/overview`)}>Change the checklist (on the Overview)</DropdownMenuItem>
        {board && !screenOn && <RemovedMenu dealId={dealId} board={board} />}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const topBar = (
    <header className="h-[52px] shrink-0 border-b border-border bg-card/50 flex items-center gap-2 sm:gap-3 px-3 sm:px-4" data-testid="together-topbar">
      <button type="button" onClick={back} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground shrink-0" aria-label="Back to the deal">
        <ArrowLeft className="h-4 w-4" />{!isPhone && "Back"}
      </button>
      <span className="text-sm font-semibold truncate min-w-0">{deal?.businessName ?? " "}</span>
      {!isPhone && <span className="text-xs text-muted-foreground shrink-0 hidden md:inline">· Interview together · {VIA_LABEL[sitting?.via ?? via]}</span>}
      <div className="ml-auto flex items-center gap-2 shrink-0">
        {sitting && !ended && pill}
        {sitting && !ended && (isPhone ? (
          <Button
            variant="outline"
            size="icon"
            className={`h-8 w-8 ${screenOn ? "border-teal/60 bg-teal/10 text-teal" : ""}`}
            aria-pressed={screenOn}
            aria-label={screenOn ? "Seller can see this screen — on" : "Seller can see this screen — off"}
            onClick={() => void toggleScreen()}
            data-testid="button-seller-sees-screen"
          >
            {screenOn ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
          </Button>
        ) : (
          <label className="hidden lg:inline-flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none" title="Shows only what the seller could see anyway — anything private to you reads 'On file — private to you'.">
            <Switch checked={screenOn} onCheckedChange={() => void toggleScreen()} aria-label="Seller can see this screen" data-testid="switch-seller-sees-screen" />
            Seller can see this screen
          </label>
        ))}
        {menu}
        {!isPhone && sitting && !ended && (
          <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={() => void popOut()} data-testid="button-pop-out">
            <PictureInPicture2 className="h-3.5 w-3.5" />{pip.isOpen ? "Pop back in" : "Pop out"}
          </Button>
        )}
        {!isPhone && sitting && !ended && (
          <Button size="sm" className="h-8 bg-teal text-teal-foreground hover:bg-teal/90" onClick={() => setEndOpen(true)} data-testid="button-end-session">End session</Button>
        )}
      </div>
    </header>
  );

  const banners = sitting && (
    <>
      {sit.connection === "offline" && (
        <p className="flex items-center gap-2 px-4 py-1.5 text-xs tg-warn-text tg-warn-bg border-b border-border" role="status" data-testid="banner-connection-lost">
          <WifiOff className="h-3.5 w-3.5 shrink-0" /> Connection lost — keeping what's said on this computer and sending it when you're back.{sit.unsent > 0 ? ` (${sit.unsent} waiting)` : ""}
        </p>
      )}
      {sitting.sourceDeleted && !ended && (
        <div className="flex flex-wrap items-center gap-2 px-4 py-2 text-xs tg-warn-bg border-b border-border" role="alert" data-testid="banner-source-deleted">
          <AlertTriangle className="h-3.5 w-3.5 tg-warn-text" /> This session's transcript was deleted, so Cimple has stopped filing from it. Start a new session to keep going.
          <Button size="sm" variant="outline" className="h-7 text-xs ml-auto" onClick={() => void startNewSession()} data-testid="button-new-session-deleted">Start a new session</Button>
        </div>
      )}
      {sitting.aiDown && !ended && !sitting.sourceDeleted && (
        <div className="flex items-start gap-2 px-4 py-2 text-xs tg-warn-bg border-b border-border" role="status" data-testid="banner-ai-down">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 tg-warn-text shrink-0" />
          <span className="min-w-0 flex-1">Cimple can't file answers right now. Everything said is being kept and will be filed as soon as it's back — keep talking.</span>
          <Button size="sm" variant="outline" className="h-7 text-xs shrink-0" onClick={() => void retryFiling()} data-testid="button-try-now">Try now</Button>
        </div>
      )}
      {sitting.longSession && !ended && !sitting.aiDown && (
        <p className="px-4 py-1.5 text-xs text-muted-foreground bg-muted/30 border-b border-border" role="status" data-testid="banner-long-session">
          This is a long session — Cimple now files answers every couple of minutes instead of after each answer.
        </p>
      )}
      {ended && (
        <div className="flex flex-wrap items-center gap-2 px-4 py-2 text-xs bg-muted/40 border-b border-border" role="status" data-testid="banner-ended">
          This session ended{sitting.endedAt ? ` at ${new Date(sitting.endedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}. Start a new session to keep going.
          <Button size="sm" variant="outline" className="h-7 text-xs ml-auto" onClick={() => sit.retryStart()} data-testid="button-new-session">Start a new session</Button>
          {sitting.summary && <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setEndOpen(true)}>View summary</Button>}
        </div>
      )}
    </>
  );

  const livePanel = sitting && board && (
    <LivePanel
      dealId={dealId}
      sitting={sitting}
      board={board}
      lines={sit.lines}
      listening={listening}
      meetingLink={meetingLink}
      onSetSpeaker={sit.setSpeaker}
      onTyped={(text) => sit.postLine({ speaker: "typed:broker", text, source: "typed" })}
      onShowItem={showItem}
      ended={ended}
      hideSuggest={isPhone}
      filing={sit.filing}
      brokerUnconfirmed={sit.brokerUnconfirmed}
      hints={sit.hints}
      onFileNow={sit.fileNow}
      onUndo={sit.undo}
      onRefile={sit.refile}
      onDismissUnconfirmed={sit.dismissUnconfirmed}
    />
  );
  const suggestCtx = board ? suggestContext(board, sit.hints, now) : undefined;

  let body: JSX.Element;
  if (sit.startError) {
    body = (
      <div className="p-8 text-center space-y-3" data-testid="board-start-error">
        <p className="text-sm">Couldn't start the session.</p>
        <p className="text-xs text-muted-foreground">{sit.startError}</p>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => sit.retryStart()}><RefreshCw className="h-3.5 w-3.5" /> Try again</Button>
      </div>
    );
  } else if (!sitting || isLoading || (!board && !error)) {
    body = (
      <div className="p-4 space-y-4" data-testid="board-loading">
        <div className="h-14 rounded-md bg-muted animate-pulse" />
        <div className="grid gap-4 lg:grid-cols-[248px_1fr_380px]">
          <div className="hidden lg:block h-96 rounded-md bg-muted animate-pulse" />
          <div className="h-96 rounded-md bg-muted animate-pulse" />
          <div className="hidden lg:block space-y-2"><div className="h-40 rounded-md bg-muted animate-pulse" /><p className="text-xs text-muted-foreground">Getting the checklist…</p></div>
        </div>
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
    const counts = viewCounts(board, sitting.id);
    const active = sit.filing.active && Date.now() - sit.filing.active.at < 120_000;
    const heldItems = board.sections.reduce((n, s) => n + s.items.filter((i) => i.suggestion).length, 0);
    const filingText = listenIsProblem(listening.state)
      ? listenCopy(listening.state)
      : sitting.aiDown
        ? "Filing paused — nothing is lost"
        : heldItems > 0 && !active
          ? `${heldItems} possible ${heldItems === 1 ? "answer" : "answers"} waiting`
        : active
          ? `Filing${sit.filing.active?.sectionTitle ? ` · ${sit.filing.active.sectionTitle}` : ""}…`
          : filedCount > 0 ? `${filedCount} filed this session` : "Cimple files answers as the seller talks";
    body = (
      <div className="flex-1 min-h-0 flex flex-col">
        {banners}
        <div className="px-4 py-3 border-b border-border" data-testid="board-kpi">
          <CoverageHeadline board={board} variant="phone" onFilter={(f) => setState({ view: "ask", filter: f, tab: "ask" })} activeFilter={state.filter} />
        </div>
        <div className="sticky top-0 z-10 bg-background border-b border-border grid grid-cols-3 text-sm" role="tablist">
          {([
            ["ask", `To ask ${counts.ask}`],
            ["sections", "Sections"],
            ["side", "Live"],
          ] as const).map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={state.tab === k} onClick={() => setState({ tab: k })} className={`py-2.5 ${state.tab === k ? "text-foreground border-b-2 border-teal" : "text-muted-foreground"}`} data-testid={`tab-${k}`}>
              {label}
            </button>
          ))}
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto pb-24">
          {state.tab === "ask" && (
            <>
              <div className="px-4 pt-3"><StatusBanner board={board} onRetry={() => refetch()} /></div>
              <CoverageBoardView variant="live" dealId={dealId} board={board} audience={audience} state={state} onState={onState} touch sittingId={sitting.id} justFiled={justFiled} />
            </>
          )}
          {state.tab === "sections" && (
            <div className="p-4">
              <CoverageRail board={board} view={state.view} sectionKey={state.section} live sittingId={sitting.id} fullWidth onSelect={(view, section) => setState({ view, section, filter: "all", query: "", tab: "ask" })} />
            </div>
          )}
          {state.tab === "side" && <div className="p-4">{livePanel}</div>}
        </div>
        <div className="fixed bottom-0 inset-x-0 z-20 border-t border-border bg-card/95 backdrop-blur px-4 py-2.5 flex items-center gap-2" data-testid="board-bottom-bar">
          <span className={`text-xs flex-1 min-w-0 truncate ${listenIsProblem(listening.state) ? "tg-warn-text" : "text-muted-foreground"}`}>{filingText}</span>
          <SuggestNext board={board} ctx={suggestCtx} onShow={showItem} size="sm" label="Suggest next" />
          {!ended && <Button size="sm" className="h-8 bg-teal text-teal-foreground hover:bg-teal/90" onClick={() => setEndOpen(true)} data-testid="button-bottom-end">End</Button>}
        </div>
      </div>
    );
  } else {
    body = (
      <div className="flex-1 min-h-0 flex flex-col">
        {banners}
        <div className="px-5 py-4 border-b border-border" data-testid="board-kpi">
          <CoverageHeadline board={board} variant="strip" sessionFiled={filedCount} onFilter={(f) => setState({ view: "ask", filter: f })} activeFilter={state.view === "ask" ? state.filter : undefined} />
        </div>
        <div className="flex-1 min-h-0 grid grid-cols-[220px_minmax(0,1fr)] lg:grid-cols-[248px_minmax(0,1fr)_340px] xl:grid-cols-[248px_minmax(0,1fr)_380px]">
          <aside className="border-r border-border overflow-y-auto p-3">
            <CoverageRail board={board} view={state.view} sectionKey={state.section} live sittingId={sitting.id} onSelect={(view, section) => setState({ view, section, filter: "all", query: "" })} />
          </aside>
          <main className="min-w-0 overflow-y-auto px-4 py-4" data-testid="board-center">
            <StatusBanner board={board} onRetry={() => refetch()} />
            {screenOn && <p className="mx-1 mb-3 text-[11px] text-muted-foreground" data-testid="screen-note">The seller can see this screen: anything only you can see reads “On file — private to you”.</p>}
            <CoverageBoardView variant="live" dealId={dealId} board={board} audience={audience} state={state} onState={onState} sittingId={sitting.id} justFiled={justFiled} />
          </main>
          <aside className="hidden lg:block border-l border-border overflow-y-auto p-4" data-testid="live-column">
            {livePanel}
          </aside>
        </div>
        {/* Below lg the live panel opens from here. */}
        <div className="lg:hidden fixed bottom-4 right-4 z-20">
          <Button size="sm" className="gap-1.5 bg-teal text-teal-foreground hover:bg-teal/90 shadow-lg" onClick={() => setState({ tab: "side" })}><Sparkles className="h-3.5 w-3.5" /> Live panel</Button>
        </div>
        {state.tab === "side" && (
          <div className="lg:hidden fixed inset-y-0 right-0 z-30 w-[360px] max-w-full border-l border-border bg-background overflow-y-auto p-4 shadow-xl">
            <div className="flex justify-end mb-2"><Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setState({ tab: "ask" })}>Close</Button></div>
            {livePanel}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-background overflow-hidden" data-testid="together-board" data-audience={audience} data-mode="live">
      {topBar}
      {body}
      <ConsentDialog
        open={consentOpen}
        onCancel={() => { setConsentOpen(false); consentResolve.current?.(false); consentResolve.current = null; }}
        onConfirm={async () => {
          await sit.consent();
          setConsentOpen(false);
          consentResolve.current?.(true);
          consentResolve.current = null;
        }}
      />
      {sitting && (
        <EndSessionDialog
          open={endOpen}
          onOpenChange={setEndOpen}
          dealId={dealId}
          sitting={sitting}
          loadSummary={sit.loadSummary}
          end={sit.end}
          onUndo={sit.undo}
          onRetry={sit.retry}
          onDone={() => { setEndOpen(false); pip.close(); setLocation(`/deal/${dealId}/overview`); }}
        />
      )}
      {board && <CallSheetDialog board={board} businessName={deal?.businessName} open={sheetOpen} onOpenChange={setSheetOpen} />}
      {pip.container && board && sitting && createPortal(
        <TogetherPip dealId={dealId} board={board} sitting={sitting} listenState={listening.state} startedAt={listening.startedAt} suggestCtx={suggestCtx} onShowItem={(id, sec) => { window.focus(); showItem(id, sec); }} />,
        pip.container,
      )}
    </div>
  );
}
