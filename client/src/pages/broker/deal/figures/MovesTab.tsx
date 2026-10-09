/**
 * MovesTab — "Why figures moved" (spec §5.2 Tab 1): every change the CIM
 * shows or implies, what buyers read about it, what it rests on and its
 * state, with the actions (Show to buyers · Edit · Hide; for none: This is
 * right, use it · Ask the seller · Write a reason). A table at lg+, cards
 * below. Filters and the bulk bar on top.
 *
 * Opens on what needs the broker (a note waiting, one that needs a look, a
 * figure with a hint, a question or an answer to use). Derived totals and
 * tax lines with nothing to do (EBITDA, net income, income taxes…) are folded
 * behind "Show all figures" — they are not 18 problems. "Shown to buyers"
 * means some buyer reads it now; while buyers read the kept copy of a live
 * CIM, a note only the update carries says "Shows once you publish the update".
 */
import { useMemo } from "react";
import { CheckCircle2, CircleDashed, Clock, EyeOff, Lightbulb, MessageCircleQuestion, PauseCircle, AlertTriangle, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { moveCounts, moveMatches, moveNeedsYou, type MoveFilter, type MoveStatus, type WorkspaceMove } from "@shared/figure-workspace";
import { money, signedMoney } from "./useFigures";

/** "the CIM" while it isn't published yet, else "the update". */
type PublishWhat = "the CIM" | "the update";

const STATUS: Record<MoveStatus, { label: (m: WorkspaceMove, publishWhat: PublishWhat) => string; tone: string; Icon: typeof CheckCircle2 }> = {
  shown: { label: () => "Shown to buyers", tone: "text-success", Icon: CheckCircle2 },
  after_publish: { label: (_m, what) => `Shows once you publish ${what}`, tone: "text-sky-300", Icon: Clock },
  not_served: { label: () => "Approved · not on a page buyers read", tone: "text-muted-foreground", Icon: Clock },
  waiting: { label: () => "Waiting for your OK", tone: "text-amber-500", Icon: PauseCircle },
  none: { label: () => "No reason on file", tone: "text-muted-foreground", Icon: CircleDashed },
  hidden: { label: () => "Hidden", tone: "text-muted-foreground", Icon: EyeOff },
  stale_figures: { label: () => "Needs a look: the figures changed", tone: "text-amber-500", Icon: AlertTriangle },
  stale_seller: { label: () => "Needs a look: the owner asked for a change", tone: "text-amber-500", Icon: AlertTriangle },
  held: { label: (m) => `Held: FY${m.heldYear ?? ""} doesn't match the statements`, tone: "text-amber-500", Icon: AlertTriangle },
};

const STATUS_ORDER: Record<MoveStatus, number> = { waiting: 0, stale_seller: 1, stale_figures: 2, none: 3, held: 4, after_publish: 5, not_served: 6, shown: 7, hidden: 8 };

const FILTERS: Array<{ key: MoveFilter; label: string }> = [
  { key: "needs", label: "Needs you" },
  { key: "waiting", label: "Waiting for your OK" },
  { key: "none", label: "No reason on file" },
  { key: "shown", label: "Shown to buyers" },
  { key: "publish", label: "Not reaching buyers yet" },
  { key: "look", label: "Needs a look" },
  { key: "hidden", label: "Hidden" },
  { key: "all", label: "All" },
];

export interface MovesActions {
  onOpenNote(noteId: string): void;
  onUseHint(m: WorkspaceMove): void;
  onWrite(m: WorkspaceMove): void;
  onAsk(m: WorkspaceMove): void;
  onShow(m: WorkspaceMove): void;
  onHide(m: WorkspaceMove): void;
  onBulkShow(ids: string[]): void;
  /** A held row: open "Fix first" (the year that doesn't match the statements). */
  onFixFirst?(m: WorkspaceMove): void;
  bulkBusy?: boolean;
}

function Status({ m, publishWhat }: { m: WorkspaceMove; publishWhat: PublishWhat }) {
  const s = STATUS[m.status];
  return (
    <span className={cn("inline-flex items-start gap-1 text-xs", s.tone)}>
      <s.Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>
        {s.label(m, publishWhat)}
        {m.status === "not_served" && m.unservedWhy && <span className="block text-[11px] text-muted-foreground">{m.unservedWhy}</span>}
      </span>
    </span>
  );
}

function Reads({ m }: { m: WorkspaceMove }) {
  if (!m.note) {
    return (
      <div className="space-y-1 text-xs">
        {m.status === "held" ? (
          <p className="text-muted-foreground">Buyers see this figure without a note until FY{m.heldYear} matches the statements.</p>
        ) : m.hint ? (
          <p className="text-muted-foreground"><Lightbulb className="mr-1 inline h-3 w-3 text-teal" />Cimple's analysis suggests: “{m.hint}” <span className="opacity-80">(not checked)</span></p>
        ) : m.question ? (
          <p className="text-muted-foreground"><MessageCircleQuestion className="mr-1 inline h-3 w-3" />{questionWords(m.question.status)}</p>
        ) : (
          <p className="text-muted-foreground">Nothing on file explains this yet.</p>
        )}
        {m.answer && <p className="text-foreground">“{m.answer.text}” <span className="text-muted-foreground">— {m.answer.from}</span></p>}
      </div>
    );
  }
  const blind = m.note.blindText ? `Blind CIM: ${m.note.blindText}` : "Not shown in the Blind CIM";
  // Both lines clamp the same way; the full wording is in the note (Edit) and on hover.
  return (
    <div className="space-y-0.5 text-xs">
      <p className="line-clamp-3 text-foreground" title={m.note.text}>{m.note.text}</p>
      <p className="line-clamp-3 text-[11px] text-muted-foreground" title={blind}>{blind}</p>
    </div>
  );
}

function questionWords(status: string): string {
  switch (status) {
    case "suggested": return "A question for the seller is ready (Questions tab).";
    case "ask_seller": return "With the seller.";
    case "answered": return "The seller answered (below).";
    case "asked": return "Asked: no reason given.";
    default: return "";
  }
}

function Chips({ m }: { m: WorkspaceMove }) {
  if (!m.note) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      {m.note.chips.map((c) => (
        <span key={c.label} title={c.title} className="block max-w-full truncate whitespace-nowrap rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">{c.label}</span>
      ))}
    </div>
  );
}

function Actions({ m, a }: { m: WorkspaceMove; a: MovesActions }) {
  const n = m.note;
  if (m.status === "held") {
    // D9a: nothing measured from or to a figure that disagrees with the statements is offered for buyers.
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        {a.onFixFirst && <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => a.onFixFirst!(m)}>Fix FY{m.heldYear} first</Button>}
        {n && <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => a.onOpenNote(n.id)}>Open</Button>}
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {n && (n.status === "suggested" && !n.staleReason && !n.internalOnly) && (
        <Button size="sm" className="h-7 bg-teal px-2 text-xs text-teal-foreground hover:bg-teal/90" onClick={() => a.onShow(m)}>Show to buyers</Button>
      )}
      {n && <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => a.onOpenNote(n.id)}>{n.status === "hidden" ? "Open" : n.internalOnly || n.staleReason ? "Check it" : "Edit"}</Button>}
      {n && n.status !== "hidden" && <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-muted-foreground" onClick={() => a.onHide(m)}>Hide</Button>}
      {!n && m.hint && <Button size="sm" className="h-7 bg-teal px-2 text-xs text-teal-foreground hover:bg-teal/90" onClick={() => a.onUseHint(m)}>This is right, use it</Button>}
      {!n && m.askable && (!m.question || m.question.status === "suggested" || m.question.status === "asked") && (
        <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => a.onAsk(m)}>Ask the seller</Button>
      )}
      {!n && <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => a.onWrite(m)}>{m.answer ? "Use the seller's answer" : "Write a reason"}</Button>}
    </div>
  );
}

function where(m: WorkspaceMove): string {
  return m.place === "page" ? "" : m.place === "update_only" ? " · in the update (not published yet)" : " · inside a total";
}

export function MovesTab({
  moves, filter, onFilter, showAll, onShowAll, actions, publishWhat = "the update",
}: {
  moves: WorkspaceMove[];
  /** "the CIM" while it isn't published yet (its approved notes "show once you publish the CIM"). */
  publishWhat?: PublishWhat;
  filter: MoveFilter;
  onFilter: (f: MoveFilter) => void;
  showAll: boolean;
  onShowAll: (all: boolean) => void;
  actions: MovesActions;
}) {
  const counts = useMemo(() => moveCounts(moves, { all: showAll }), [moves, showAll]);
  const folded = useMemo(() => moves.filter((m) => m.folded).length, [moves]);
  // What needs the broker first: notes waiting for an OK, then the ones that need a look, then
  // figures with no reason, held years, what reaches buyers later, and what buyers already see.
  const rows = moves.filter((m) => moveMatches(m, filter, { all: showAll })).sort((a, b) =>
    STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0));
  // On "Needs you": the changes with nothing on file and nothing ready are one quiet line, not a wall of rows.
  const quietNone = filter === "needs" ? moves.filter((m) => moveMatches(m, "none", { all: showAll }) && !moveNeedsYou(m)).length : 0;
  const waiting = moves.filter((m) => m.note && m.note.status === "suggested" && !m.note.staleReason && m.status === "waiting");
  const bulk = waiting.filter((m) => !m.note!.internalOnly);
  const internal = waiting.length - bulk.length;

  if (moves.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground" data-testid="moves-empty">
        No figure changed enough to need a note. (Cimple suggests notes for changes of 8% or more. You can write a note on any figure from the CIM preview.)
      </p>
    );
  }
  const foldToggle = folded > 0 && (
    <button
      type="button"
      onClick={() => onShowAll(!showAll)}
      className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      aria-expanded={showAll}
      data-testid="moves-show-all"
    >
      {showAll ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
      {showAll ? "Hide totals and tax lines" : `Show all figures (+${folded} totals and tax lines with nothing to do)`}
    </button>
  );
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter">
        {FILTERS.filter((f) => f.key === filter || f.key === "needs" || f.key === "all" || counts[f.key] > 0).map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => onFilter(f.key)}
            className={cn("rounded-full border px-2.5 py-1 text-xs", filter === f.key ? "border-teal bg-teal/10 text-foreground" : "border-border text-muted-foreground hover:text-foreground")}
            aria-pressed={filter === f.key}
            data-testid={`moves-filter-${f.key}`}
          >
            {f.label} ({counts[f.key]})
          </button>
        ))}
      </div>

      {waiting.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-teal/30 bg-teal/5 px-3 py-2 text-xs" data-testid="moves-bulk-bar">
          <span className="text-foreground">
            {waiting.length} {waiting.length === 1 ? "note is" : "notes are"} waiting for your OK. Open any note to see what it's based on.
            {internal > 0 && <span className="text-muted-foreground"> {internal} {internal === 1 ? "note needs" : "notes need"} your own check first.</span>}
          </span>
          {bulk.length > 0 && (
            <Button size="sm" className="h-7 bg-teal text-xs text-teal-foreground hover:bg-teal/90" disabled={actions.bulkBusy} onClick={() => actions.onBulkShow(bulk.map((m) => m.note!.id))}>
              Show {bulk.length === 1 ? "this one" : `these ${bulk.length}`} to buyers
            </Button>
          )}
        </div>
      )}

      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-5 text-sm text-muted-foreground" data-testid="moves-nothing">
          {filter === "needs" ? "Nothing needs you here right now." : "Nothing here."}
          {filter !== "all" && <> <button type="button" className="text-teal hover:underline" onClick={() => onFilter("all")}>See every change</button></>}
        </p>
      ) : (
        <>
          {/* Table (lg+) */}
          <div className="hidden overflow-hidden rounded-lg border border-border lg:block">
            <table className="w-full table-fixed text-left">
              <thead className="bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="w-[15%] px-3 py-2 font-medium">Figure</th>
                  <th className="w-[9%] px-3 py-2 font-medium">Change</th>
                  <th className="px-3 py-2 font-medium">What buyers read</th>
                  <th className="w-[184px] px-3 py-2 font-medium">Based on</th>
                  <th className="w-[14%] px-3 py-2 font-medium">Status</th>
                  <th className="w-[16%] px-3 py-2 font-medium"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((m) => (
                  <tr key={m.figureKey} className="align-top" data-testid={`move-row-${m.figureKey}`}>
                    <td className="px-3 py-2.5">
                      <p className="text-sm font-medium leading-snug">{m.label}</p>
                      <p className="text-[11px] text-muted-foreground">{m.fromYear ? `FY${m.fromYear} → FY${m.year}` : `FY${m.year}`}{where(m)}</p>
                    </td>
                    <td className="px-3 py-2.5 text-xs tabular-nums">
                      <p>{signedMoney(m.delta)}</p>
                      <p className="text-muted-foreground">{m.pct ?? ""}</p>
                    </td>
                    <td className="px-3 py-2.5"><Reads m={m} /></td>
                    <td className="px-3 py-2.5"><Chips m={m} /></td>
                    <td className="px-3 py-2.5"><Status m={m} publishWhat={publishWhat} /></td>
                    <td className="px-3 py-2.5"><Actions m={m} a={actions} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* Cards (below lg) */}
          <div className="space-y-2 lg:hidden">
            {rows.map((m) => (
              <div key={m.figureKey} className="space-y-2 rounded-lg border border-border bg-card p-3" data-testid={`move-card-${m.figureKey}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium leading-snug">{m.label}</p>
                    <p className="text-[11px] text-muted-foreground tabular-nums">
                      {m.fromYear ? `FY${m.fromYear} ${money(m.from)} → FY${m.year} ${money(m.to)}` : `FY${m.year} ${money(m.to)}`}{where(m)}
                    </p>
                  </div>
                  <span className="shrink-0 text-right text-xs tabular-nums">{signedMoney(m.delta)}<br /><span className="text-muted-foreground">{m.pct ?? ""}</span></span>
                </div>
                <Reads m={m} />
                <div className="flex flex-wrap items-center justify-between gap-2"><Status m={m} publishWhat={publishWhat} /><Chips m={m} /></div>
                <Actions m={m} a={actions} />
              </div>
            ))}
          </div>
        </>
      )}
      {quietNone > 0 && (
        <p className="text-xs text-muted-foreground" data-testid="moves-quiet-none">
          {quietNone === 1 ? "1 other change has" : `${quietNone} other changes have`} no reason on file and nothing to suggest yet.{" "}
          <button type="button" className="text-teal hover:underline" onClick={() => onFilter("none")}>See {quietNone === 1 ? "it" : "them"}</button>
        </p>
      )}
      {foldToggle}
    </div>
  );
}
