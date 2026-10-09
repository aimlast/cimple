/**
 * NumbersWorkspace — "Numbers & sources", the CIM tab dashboard's fifth view
 * (spec §5.2, D17; INTEGRATION C12: /deal/:id/cim?view=numbers&tab=…&note=…).
 * What buyers read about the CIM's figures: why they moved, how they compare
 * with the tax returns, and the questions for the seller.
 *
 * A dashboard, not a stacked page: the status pill and its one action, a KPI
 * strip (each cell opens its tab, filtered), a one-line "Fix first", then
 * three tabs — one visible at a time, the tab and the open note in the URL.
 * At 390 the KPIs are a 2-column grid, the tabs a select, tables cards, and
 * the drawer and review sheet full screen.
 */
import { useMemo, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { ArrowLeft, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { moveCounts, nothingServedLine, publishTarget, type CheckGroup, type MoveFilter, type WorkspaceCheck, type WorkspaceMove, type WorkspaceQuestion } from "@shared/figure-workspace";
import { useDeal } from "@/contexts/DealContext";
import { figuresErrorText, useFigureActions, useFiguresWorkspace, FiguresError } from "./useFigures";
import { StatusPill } from "./StatusPill";
import { FixFirst } from "./FixFirst";
import { MovesTab } from "./MovesTab";
import { ChecksTab } from "./ChecksTab";
import { QuestionsTab } from "./QuestionsTab";
import { NoteDrawer, type NoteDrawerTarget } from "./NoteDrawer";
import { ReviewSheet } from "./ReviewSheet";
import { CheckDialogs, type CheckDialogState } from "./CheckDialogs";
import { AskSellerDialog, type AskTarget } from "./AskSellerDialog";

type TabKey = "moves" | "checks" | "questions";
const TAB_LABEL: Record<TabKey, string> = { moves: "Why figures moved", checks: "Statements vs tax returns", questions: "Questions for the seller" };
const MOVE_FILTERS: MoveFilter[] = ["needs", "all", "waiting", "none", "shown", "publish", "look", "hidden"];
const CHECK_GROUPS: CheckGroup[] = ["difference", "regrouped", "needs_checking", "match", "left_out"];

function aiFailureText(error: string | undefined): string {
  if (error === "interrupted") return "The last check stopped before it finished. Check again.";
  if (error === "daily_limit") return "Cimple has checked this deal's numbers 4 times today. You can still write reasons yourself or use Cimple's suggestions; checking again works tomorrow.";
  const [reason, ...rest] = String(error ?? "").split(/;\s*/);
  const advice = rest.join("; ");
  const a = advice ? advice.charAt(0).toUpperCase() + advice.slice(1) : "Try again in a few minutes";
  return `Cimple couldn't read for reasons (${reason || "no usable answer"}). Nothing changed. ${a}.`;
}

function Kpi({ label, value, sub, onClick, testId, className }: { label: string; value: string; sub?: string; onClick?: () => void; testId?: string; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn("flex min-w-0 flex-col items-start gap-0.5 rounded-lg border border-border bg-card px-3 py-2.5 text-left transition-colors hover:border-teal/50", className)}
      data-testid={testId}
    >
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className="text-lg font-semibold tabular-nums leading-tight">{value}</span>
      {sub && <span className="text-[11px] text-muted-foreground">{sub}</span>}
    </button>
  );
}

/** The group the checks tab opens on: the first with something in it (an empty "Differences (0)" told the broker nothing). */
function defaultCheckGroup(checks: Array<{ group: CheckGroup }>): CheckGroup {
  for (const g of ["difference", "needs_checking", "regrouped", "match", "left_out"] as CheckGroup[]) if (checks.some((c) => c.group === g)) return g;
  return "difference";
}

export function NumbersWorkspace() {
  const { dealId, deal } = useDeal();
  const [, navigate] = useLocation();
  const search = useSearch();
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const tab = (["moves", "checks", "questions"].includes(params.get("tab") ?? "") ? params.get("tab") : "moves") as TabKey;
  const noteId = params.get("note");
  const filterParam = MOVE_FILTERS.includes(params.get("filter") as MoveFilter) ? (params.get("filter") as MoveFilter) : null;
  const showAll = params.get("all") === "1";
  const groupParam = CHECK_GROUPS.includes(params.get("group") as CheckGroup) ? (params.get("group") as CheckGroup) : null;
  const setParams = (next: Record<string, string | null>) => {
    const p = new URLSearchParams(search);
    p.set("view", "numbers");
    for (const [k, v] of Object.entries(next)) {
      if (v === null) p.delete(k);
      else p.set(k, v);
    }
    navigate(`/deal/${dealId}/cim?${p.toString()}`, { replace: true });
  };

  const { toast } = useToast();
  const { ws, refresh, running, buildRunning } = useFiguresWorkspace(dealId);
  const actions = useFigureActions(dealId);
  const [newNote, setNewNote] = useState<NoteDrawerTarget | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [checkDialog, setCheckDialog] = useState<CheckDialogState>(null);
  const [askTarget, setAskTarget] = useState<AskTarget>(null);
  const [fixOpen, setFixOpen] = useState(false);
  const drawerTarget: NoteDrawerTarget | null = noteId ? { noteId } : newNote;

  const back = () => navigate(`/deal/${dealId}/cim`);
  const startBuild = async () => {
    try {
      await actions.build.mutateAsync("changed");
      toast({ title: "Checking the numbers again", description: "Reading the interview and documents for reasons. Usually under a minute." });
    } catch (e) {
      if (e instanceof FiguresError && e.status === 409) toast({ title: "Already checking", description: "Cimple is already reading for reasons on this deal." });
      else toast({ title: "Couldn't check again", description: figuresErrorText(e), variant: "destructive" });
    }
  };
  const fail = (title: string) => (e: unknown) => toast({ title, description: figuresErrorText(e), variant: "destructive" });

  const header = (
    <div className="space-y-1">
      <button type="button" onClick={back} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" data-testid="button-back-to-cim">
        <ArrowLeft className="h-3.5 w-3.5" /> CIM
      </button>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Numbers &amp; sources</h2>
          <p className="text-sm text-muted-foreground">What buyers read about the CIM's figures: why they moved, and how they compare with the tax returns.</p>
        </div>
        {ws.data && ws.data.status.hasCim && !ws.data.status.noFigures && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="sm" className="shrink-0 gap-1.5" onClick={startBuild} disabled={buildRunning || actions.build.isPending || ws.data.status.dailyLimit} data-testid="button-check-numbers-again">
                {buildRunning || actions.build.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Check the numbers again
              </Button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs text-xs">Reads the interview and documents again to find reasons. Takes about a minute.</TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );

  const shell = (body: React.ReactNode) => (
    <div className="mx-auto max-w-6xl space-y-4 px-4 py-6 sm:px-6" data-testid="numbers-workspace">
      {header}
      {body}
    </div>
  );

  if (ws.isLoading) {
    return shell(
      <div className="space-y-3">
        <Skeleton className="h-12 rounded-lg" />
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className={cn("h-16 rounded-lg", i === 4 && "col-span-2 sm:col-span-1")} />)}</div>
        {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-12 rounded-lg" />)}
      </div>,
    );
  }
  if (ws.error || !ws.data) {
    return shell(
      <div className="rounded-lg border border-border bg-card px-4 py-6 text-sm">
        <p>Couldn't load the numbers and sources.</p>
        <Button size="sm" variant="outline" className="mt-3" onClick={() => ws.refetch()}>Try again</Button>
      </div>,
    );
  }
  const data = ws.data;
  if (!data.status.hasCim) {
    return shell(<p className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground" data-testid="numbers-no-cim">Write the CIM first. Figures get their notes once the CIM shows them.</p>);
  }
  if (data.status.noFigures) {
    return shell(
      <div className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground" data-testid="numbers-no-analysis">
        <p>Run the financial analysis on the Financials tab first. Cimple explains and checks the analysed figures.</p>
        <Button size="sm" variant="outline" className="mt-3" onClick={() => navigate(`/deal/${dealId}/financials`)}>Open the Financials tab</Button>
      </div>,
    );
  }

  const build = data.status.build;
  const k = data.kpis;
  const interviewDone = !!deal?.interviewCompleted;

  const moveActions = {
    onOpenNote: (id: string) => setParams({ note: id }),
    onUseHint: (m: WorkspaceMove) => setNewNote({ figureKey: m.figureKey, kind: "movement", compareKey: m.fromYear ?? undefined, prefill: m.hint ?? undefined, fromHint: true }),
    onWrite: (m: WorkspaceMove) => setNewNote({ figureKey: m.figureKey, kind: "movement", compareKey: m.fromYear ?? undefined, prefill: m.answer?.text, ...(m.answer && m.question ? { fromQuestionId: m.question.id } : {}) }),
    onAsk: (m: WorkspaceMove) => setAskTarget(m.question ? { questionIds: [m.question.id] } : { figureKeys: [m.figureKey] }),
    onShow: (m: WorkspaceMove) => m.note && actions.patchNote.mutateAsync({ id: m.note.id, version: m.note.version, action: "approve" })
      .then(() => toast({ title: "Shown to buyers" })).catch(fail("Couldn't show that note")),
    onHide: (m: WorkspaceMove) => m.note && actions.patchNote.mutateAsync({ id: m.note.id, version: m.note.version, action: "hide" })
      .then(() => toast({ title: "Hidden from buyers" })).catch(fail("Couldn't hide that note")),
    onBulkShow: (ids: string[]) => actions.approveNotes.mutateAsync(ids)
      .then((r) => toast({ title: `${r.approved} ${r.approved === 1 ? "note" : "notes"} shown to buyers`, description: r.skipped.length > 0 ? `${r.skipped.length} changed meanwhile and ${r.skipped.length === 1 ? "was" : "were"} left as ${r.skipped.length === 1 ? "it was" : "they were"}.` : undefined }))
      .catch(fail("Couldn't show those notes")),
    bulkBusy: actions.approveNotes.isPending,
    onFixFirst: () => {
      setFixOpen(true);
      document.querySelector('[data-testid="figures-fix-first"]')?.scrollIntoView({ behavior: "smooth", block: "center" });
    },
  };
  // Opens on what needs the broker; when nothing does, on every change (never an empty list by default).
  const moveFilter: MoveFilter = filterParam ?? (moveCounts(data.moves, { all: showAll }).needs > 0 ? "needs" : "all");
  const checkActions = {
    onShow: (c: WorkspaceCheck) => actions.putCheck.mutateAsync({ checkKey: c.checkKey, state: "shown" })
      .then(() => toast({ title: data.status.ddShownAt ? "Shown to due-diligence buyers" : "Ready to show", description: data.status.ddShownAt ? undefined : "Due-diligence buyers see it once you turn the checks on." }))
      .catch(fail("Couldn't show that")),
    onLeaveOut: (c: WorkspaceCheck) => setCheckDialog({ kind: "leave_out", check: c }),
    onReadWrong: (c: WorkspaceCheck) => setCheckDialog({ kind: "read_wrong", check: c }),
    onAsk: (c: WorkspaceCheck) => {
      const q = data.questions.find((x) => x.figureKey === c.figureKey && x.status !== "closed");
      if (q) setAskTarget({ questionIds: [q.id] });
      else toast({ title: "No question for this difference yet", description: "Cimple suggests one when nothing on file explains it. Write the reason yourself, or check the numbers again." });
    },
    onWrite: (c: WorkspaceCheck) => setNewNote({ figureKey: c.figureKey, kind: "difference", compareKey: c.checkKey.split("~")[1] }),
    onOpenNote: (id: string) => setParams({ note: id }),
    onUndoLeaveOut: (c: WorkspaceCheck) => actions.putCheck.mutateAsync({ checkKey: c.checkKey, state: "shown" })
      .then(() => toast({ title: "Back in the checks" })).catch(fail("Couldn't change that")),
  };
  const questionActions = {
    onAsk: (ids: string[]) => setAskTarget({ questionIds: ids }),
    onWrite: (q: WorkspaceQuestion) => {
      const isDiff = q.figureKey && data.checks.some((c) => c.figureKey === q.figureKey) && /Difference\d{4}$/.test(q.captureKey);
      const compareKey = isDiff ? data.checks.find((c) => c.figureKey === q.figureKey)?.checkKey.split("~")[1] : data.moves.find((m) => m.figureKey === q.figureKey)?.fromYear ?? undefined;
      setNewNote({ figureKey: q.figureKey, kind: isDiff ? "difference" : "movement", compareKey: compareKey ?? undefined, prefill: q.answer?.text, fromQuestionId: q.id });
    },
    onNotNeeded: (q: WorkspaceQuestion) => actions.patchQuestion.mutateAsync({ id: q.id, action: "not_needed" }).then(() => toast({ title: "Closed" })).catch(fail("Couldn't close it")),
    onReopen: (q: WorkspaceQuestion) => actions.patchQuestion.mutateAsync({ id: q.id, action: "reopen" }).then(() => toast({ title: "Reopened" })).catch(fail("Couldn't reopen it")),
    onAutoAsk: (on: boolean) => actions.settings.mutateAsync({ autoAsk: on }).catch(fail("Couldn't change that setting")),
    autoAskBusy: actions.settings.isPending,
  };

  const counts = {
    moves: data.moves.filter((m) => m.status !== "hidden" && (showAll || !m.folded)).length,
    checks: data.checks.length,
    questions: data.questions.filter((q) => q.status !== "closed").length,
  };
  const tabTitle = (t: TabKey) => (t === "checks" && data.checks.some((c) => c.kind === "management") ? "Source checks" : TAB_LABEL[t]);

  return shell(
    <>
      {(running || buildRunning) && (
        <div className="h-0.5 w-full overflow-hidden rounded bg-muted" aria-hidden="true"><div className="h-full w-1/3 animate-pulse bg-teal" /></div>
      )}
      {buildRunning && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading the interview and documents for reasons… usually under a minute{build?.candidates ? ` · Explaining ${build.candidates} figures` : ""}
        </p>
      )}
      {!buildRunning && build?.status === "failed" && <p className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs" role="status">{aiFailureText(build.error)}</p>}
      {!buildRunning && build?.status === "done" && build.error === "daily_limit" && <p className="rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground" role="status">{aiFailureText("daily_limit")}</p>}
      {!buildRunning && (build?.skippedBecauseEdited ?? 0) > 0 && build?.status === "done" && (
        <p className="text-xs text-muted-foreground">You changed {build!.skippedBecauseEdited} {build!.skippedBecauseEdited === 1 ? "note" : "notes"} while Cimple was reading; your version was kept.</p>
      )}

      <StatusPill
        ddShownAt={data.status.ddShownAt}
        ddBuyers={data.status.ddBuyers}
        onReview={() => setReviewOpen(true)}
        onTurnOff={() => actions.settings.mutateAsync({ ddChecksOn: false }).then(() => toast({ title: "Checks turned off for due-diligence buyers" })).catch(fail("Couldn't turn the checks off"))}
        busy={actions.settings.isPending}
        toReview={k.waiting + data.checks.filter((c) => c.group === "difference" && !c.shownToBuyers && !c.refusal).length}
      />

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5" data-testid="figures-kpis">
        <Kpi
          label="Changes explained"
          value={`${k.changesExplained} of ${k.changesTotal}`}
          sub={k.changesAfterPublish > 0 ? `${k.changesAfterPublish} once you publish` : undefined}
          onClick={() => setParams({ tab: "moves", filter: k.changesExplained === 0 && k.changesAfterPublish > 0 ? "publish" : "shown", note: null })}
          testId="kpi-changes"
        />
        <Kpi
          label="Differences"
          value={`${k.differences}`}
          sub={k.differences === 0 ? "none found" : k.differencesExplained === k.differences ? "all explained" : `${k.differencesExplained} explained`}
          onClick={() => setParams({ tab: "checks", group: data.checks.some((c) => c.group === "difference") ? "difference" : data.checks.some((c) => c.group === "regrouped") ? "regrouped" : "difference", note: null })}
          testId="kpi-differences"
        />
        <Kpi label="Waiting for your OK" value={`${k.waiting}`} onClick={() => setParams({ tab: "moves", filter: "waiting", note: null })} testId="kpi-waiting" />
        <Kpi label="With the seller" value={`${k.withSeller}`} onClick={() => setParams({ tab: "questions", note: null })} testId="kpi-seller" />
        <Kpi label="Documents cited ↗" value={`${k.documentsCited}`} sub={k.documentsShared === null ? undefined : `${k.documentsShared} shared`} onClick={() => navigate(`/deal/${dealId}/information`)} testId="kpi-documents" className="col-span-2 sm:col-span-1" />
      </div>

      {nothingServedLine(data.served) && (
        <p className="rounded-lg border border-border bg-card px-3 py-2 text-xs text-muted-foreground" data-testid="figures-not-published">
          {nothingServedLine(data.served)}
        </p>
      )}
      {data.served?.keptCopy && !data.served.held && (
        <p className="rounded-lg border border-border bg-card px-3 py-2 text-xs text-muted-foreground" data-testid="figures-kept-copy">
          Buyers are reading the previous version of this CIM until you publish the update. “Shown to buyers” counts what they read now; notes only the update carries say “Shows once you publish the update”.
        </p>
      )}
      <FixFirst open={fixOpen} onOpenChange={setFixOpen} items={data.fixFirst} dealId={dealId} onNavigate={navigate} onCorrect={(key) => { const c = data.checks.find((x) => x.checkKey === key); if (c) setCheckDialog({ kind: "read_wrong", check: c }); }} />
      {data.oldDdWording && (
        <p className="text-xs text-muted-foreground">Refresh the due-diligence version's sections in the CIM builder to replace its old wording about checks.</p>
      )}

      {/* Tabs: a tab bar at sm+, a select on a phone. */}
      <div className="sm:hidden">
        <Select value={tab} onValueChange={(v) => setParams({ tab: v, note: null })}>
          <SelectTrigger aria-label="Show" data-testid="figures-tab-select"><span className="text-muted-foreground">Show:&nbsp;</span><SelectValue /></SelectTrigger>
          <SelectContent>
            {(Object.keys(TAB_LABEL) as TabKey[]).map((t) => <SelectItem key={t} value={t}>{tabTitle(t)} ({counts[t]})</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v, note: null })} className="hidden sm:block">
        <TabsList>
          {(Object.keys(TAB_LABEL) as TabKey[]).map((t) => <TabsTrigger key={t} value={t} data-testid={`figures-tab-${t}`}>{tabTitle(t)} ({counts[t]})</TabsTrigger>)}
        </TabsList>
      </Tabs>

      <div role="tabpanel" aria-label={tabTitle(tab)}>
        {tab === "moves" && (
          <MovesTab
            moves={data.moves}
            publishWhat={publishTarget(data.served)}
            filter={moveFilter}
            onFilter={(f) => setParams({ filter: f })}
            showAll={showAll}
            onShowAll={(all) => setParams({ all: all ? "1" : null })}
            actions={moveActions}
          />
        )}
        {tab === "checks" && <ChecksTab notPublished={!!data.served?.notLive} publishWhat={publishTarget(data.served)} checks={data.checks} group={groupParam ?? defaultCheckGroup(data.checks)} onGroup={(g) => setParams({ group: g })} actions={checkActions} hasOtherRecords={data.status.hasOtherRecords} />}
        {tab === "questions" && <QuestionsTab questions={data.questions} autoAsk={data.status.autoAsk} interviewDone={interviewDone} actions={questionActions} />}
      </div>

      <NoteDrawer dealId={dealId} target={drawerTarget} onClose={() => { setNewNote(null); if (noteId) setParams({ note: null }); }} />
      <ReviewSheet dealId={dealId} open={reviewOpen} onOpenChange={setReviewOpen} />
      <CheckDialogs dealId={dealId} state={checkDialog} onClose={() => setCheckDialog(null)} />
      <AskSellerDialog dealId={dealId} target={askTarget} onClose={() => setAskTarget(null)} />
    </>,
  );
}
