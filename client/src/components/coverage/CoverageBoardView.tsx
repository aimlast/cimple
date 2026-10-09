/**
 * THE coverage component (specs/together.md §8.1) — every surface that shows
 * interview coverage renders it, from one board (shared/coverage-board.ts):
 *
 *   live / checklist  "Interview together" (headline + rail + list + side column; phone: tabs)
 *   panel             the broker's AI-interview side panel (headline + collapsible sections)
 *   outline           the Overview's compact summary (headline, section rings, top 5 to ask)
 *   seller            the seller's "What we've covered" (sections and statuses — no values)
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "wouter";
import { ChevronDown, ChevronRight, Loader2, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DiscrepancyPanel } from "@/components/deal/DiscrepancyPanel";
import { useToast } from "@/hooks/use-toast";
import { boardRequest, invalidateCoverage, type BrokerAudience } from "@/hooks/useCoverageBoard";
import { CoverageHeadline } from "./CoverageHeadline";
import { CoverageRail } from "./CoverageRail";
import { CoverageItemRow, type RowMode } from "./CoverageItemRow";
import { DocumentsNeeded } from "./DocumentsNeeded";
import { RoutedQuestions } from "./RoutedQuestions";
import { SectionRing, StatusIcon } from "./StatusIcon";
import { useStableOrder } from "./useStableOrder";
import {
  VIEW_TITLE,
  checklistViewHeader,
  filterCounts,
  filterItems,
  orderedItems,
  orderedSections,
  rankOpenItems,
  sectionOnFile,
  viewHeader,
  type CoverageBoard,
  type CoverageFilter,
  type CoverageItem,
  type CoverageSection,
  type CoverageView,
  type ViewGroup,
} from "@shared/coverage-board";

export interface BoardState {
  view: CoverageView;
  filter: CoverageFilter;
  query: string;
  section?: string;
}

const FILTERS: Array<{ key: CoverageFilter; label: string; phone: string }> = [
  { key: "all", label: "All", phone: "All" },
  { key: "missing", label: "Missing", phone: "Missing" },
  { key: "partial", label: "Partial", phone: "Partial" },
  { key: "verify", label: "To verify", phone: "Verify" },
  { key: "critical", label: "Critical", phone: "Critical" },
];

function SectionHeader({ section, sticky = true }: { section: CoverageSection; sticky?: boolean }) {
  const { onFile, items } = sectionOnFile(section);
  return (
    <div className={`${sticky ? "sticky top-0 z-[1]" : ""} bg-background/95 backdrop-blur px-3 pt-4 pb-1.5 border-b border-border flex items-baseline gap-2`} data-testid={`group-${section.key}`}>
      <h3 className="text-sm font-semibold">{section.title}</h3>
      <span className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
        {section.importance === "critical" ? <span className="text-teal">Critical · </span> : null}
        {onFile} of {items} on file
      </span>
    </div>
  );
}

function ResolveDialog({ dealId, discrepancyId, onClose }: { dealId: string; discrepancyId: string | null; onClose: () => void }) {
  return (
    <Dialog open={!!discrepancyId} onOpenChange={(o) => { if (!o) { onClose(); invalidateCoverage(dealId); } }}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto grid-cols-1 [&>*]:min-w-0">
        <DialogHeader>
          <DialogTitle>Two sources disagree</DialogTitle>
          <DialogDescription>Pick the value that's right — it becomes the fact on file, and the other one is kept.</DialogDescription>
        </DialogHeader>
        {discrepancyId && <DiscrepancyPanel dealId={dealId} focusId={discrepancyId} hideRunCheck />}
      </DialogContent>
    </Dialog>
  );
}

function AddDataPoint({ dealId, sectionKey }: { dealId: string; sectionKey: string }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!label.trim()) return;
    setSaving(true);
    try {
      await boardRequest("PATCH", `/api/deals/${dealId}/interview-outline`, { addItem: { sectionKey, label: label.trim() } }, "Couldn't add it");
      invalidateCoverage(dealId);
      setLabel("");
      setOpen(false);
      toast({ title: "Added to the checklist" });
    } catch (e) {
      toast({ title: "Couldn't add it", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="m-3 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground" data-testid={`button-add-data-point-${sectionKey}`}>
        <Plus className="h-3.5 w-3.5" /> Add a data point
      </button>
    );
  }
  return (
    <div className="m-3 flex flex-wrap items-center gap-2">
      <Input autoFocus value={label} onChange={(e) => setLabel(e.target.value.slice(0, 90))} placeholder="e.g. Number of service vans" className="h-8 max-w-xs text-sm" onKeyDown={(e) => { if (e.key === "Enter") void save(); if (e.key === "Escape") setOpen(false); }} />
      <Button size="sm" className="h-8 text-xs" disabled={saving || !label.trim()} onClick={save}>{saving && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}Add</Button>
      <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => setOpen(false)}>Cancel</Button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// The board (live / checklist)
// ─────────────────────────────────────────────────────────────────────────

export function BoardList({
  dealId,
  board,
  audience,
  rowMode,
  state,
  onState,
  touch,
  sittingId,
  justFiled,
  checklist,
}: {
  dealId: string;
  board: CoverageBoard;
  audience: BrokerAudience;
  rowMode: RowMode;
  state: BoardState;
  onState: (patch: Partial<BoardState>) => void;
  touch?: boolean;
  sittingId?: string;
  justFiled?: ReadonlySet<string>;
  checklist?: boolean;
}) {
  const [resolving, setResolving] = useState<string | null>(null);
  const [unfolded, setUnfolded] = useState<Set<string>>(new Set());
  const searchRef = useRef<HTMLInputElement>(null);
  const isItemView = state.view !== "docs";
  const groups: ViewGroup[] = useMemo(
    () => (isItemView ? filterItems(board, { view: state.view, filter: state.filter, query: state.query, sectionKey: state.section, sittingId }) : []),
    [board, state.view, state.filter, state.query, state.section, sittingId, isItemView],
  );
  const orderKey = `${state.view}|${state.filter}|${state.query}|${state.section ?? ""}`;
  const stable = useStableOrder(board, groups, orderKey);
  const counts = useMemo(() => filterCounts(board, { view: state.view, query: state.query, sectionKey: state.section, sittingId }), [board, state.view, state.query, state.section, sittingId]);

  // "/" focuses the search (not while typing elsewhere).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const section = state.view === "section" ? board.sections.find((s) => s.key === state.section) : undefined;
  const title = state.view === "section" ? section?.title ?? "Section" : VIEW_TITLE[state.view];
  const nAsk = groups.reduce((n, g) => n + g.items.length, 0);
  const sub =
    state.view === "section"
      ? section ? `${sectionOnFile(section).onFile} of ${sectionOnFile(section).items} on file${section.importanceReason ? ` · ${section.importanceReason}` : ""}` : ""
      : checklist ? checklistViewHeader(state.view, nAsk) : viewHeader(state.view, nAsk);
  let index = 0;

  const renderGroup = (g: ViewGroup) => {
    const foldable = state.view === "all" && !state.query && state.filter === "all";
    const open = g.items.filter((i) => i.status !== "on_file");
    const onFile = g.items.filter((i) => i.status === "on_file");
    const showFolded = foldable && onFile.length > 0 && !unfolded.has(g.section.key);
    const rows = showFolded ? open : g.items;
    return (
      <section key={g.section.key} aria-label={g.section.title}>
        <SectionHeader section={g.section} />
        <div>
          {rows.map((item) => (
            <CoverageItemRow
              key={item.id}
              dealId={dealId}
              item={item}
              audience={audience}
              mode={rowMode}
              touch={touch}
              dataIndex={index++}
              justFiled={justFiled?.has(item.id)}
              onResolve={setResolving}
              onMenuOpenChange={stable.onMenuOpenChange}
            />
          ))}
          {showFolded && (
            <button type="button" className="w-full text-left px-3 py-2.5 text-xs text-muted-foreground hover:text-foreground border-b border-border/60" onClick={() => setUnfolded((s) => new Set(s).add(g.section.key))}>
              <StatusIcon status="on_file" size={12} className="inline mr-2 -mt-0.5" />{onFile.length} on file — show
            </button>
          )}
          {state.view === "section" && g.section.references.map((r) => (
            <div key={r.id} className="flex items-center gap-3 px-3 py-2.5 border-b border-border/60 text-xs text-muted-foreground">
              <span className="w-4" aria-hidden />
              <span className="flex-1">{r.label} — counted under {board.sections.find((s) => s.key === r.homeSectionKey)?.title ?? "another section"}</span>
              <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => onState({ view: "section", section: r.homeSectionKey, filter: "all", query: "" })}>Show</button>
            </div>
          ))}
        </div>
      </section>
    );
  };

  return (
    <div className="min-w-0 flex flex-col" data-testid="coverage-board-list">
      <div className={`${touch ? "px-4 pt-3" : "px-1 pt-1"} pb-2 space-y-3`}>
        {!touch && (
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-lg font-semibold" data-testid="coverage-view-title">{title}</h2>
              <p className="text-xs text-muted-foreground mt-0.5 max-w-xl">{sub}</p>
            </div>
            {isItemView && (
              <div className="relative w-full sm:w-64">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input ref={searchRef} value={state.query} onChange={(e) => onState({ query: e.target.value })} placeholder="Search data points  /" className="h-8 pl-8 text-sm" aria-label="Search data points" data-testid="input-coverage-search" />
              </div>
            )}
          </div>
        )}
        {isItemView && state.view !== "questions" && (
          <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Filter">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                role="tab"
                aria-selected={state.filter === f.key}
                onClick={() => onState({ filter: f.key })}
                className={`rounded-full border px-3 ${touch ? "py-1.5 text-[13px]" : "py-1 text-xs"} ${state.filter === f.key ? "border-teal/60 bg-teal/10 text-foreground" : "border-border text-muted-foreground hover:text-foreground"}`}
                data-testid={`chip-filter-${f.key}`}
              >
                {touch ? f.phone : f.label} <span className="tabular-nums">{counts[f.key]}</span>
              </button>
            ))}
          </div>
        )}
        {stable.parked >= 3 && (
          <button type="button" className="text-xs text-teal hover:underline underline-offset-2" onClick={stable.tidy} data-testid="button-tidy">
            Tidy the list ({stable.parked} filed)
          </button>
        )}
      </div>

      <div {...stable.listProps} className="min-w-0">
        {state.view === "docs" ? (
          <DocumentsNeeded dealId={dealId} documents={board.documents} />
        ) : (
          <>
            {stable.groups.map(renderGroup)}
            {state.view === "questions" && <RoutedQuestions routed={board.routed} onResolve={setResolving} />}
            {stable.groups.length === 0 && !(state.view === "questions" && board.routed.length > 0) && (
              <EmptyView view={state.view} filtered={state.filter !== "all" || !!state.query} onClear={() => onState({ filter: "all", query: "" })} checklist={checklist} />
            )}
            {state.view === "section" && state.section && audience === "broker" && rowMode !== "panel" && (
              <>
                {stable.groups.length === 0 && section && section.references.length > 0 && (
                  <div>{section.references.map((r) => <p key={r.id} className="px-3 py-2 text-xs text-muted-foreground">{r.label} — counted under {board.sections.find((s) => s.key === r.homeSectionKey)?.title}</p>)}</div>
                )}
                <AddDataPoint dealId={dealId} sectionKey={state.section} />
              </>
            )}
          </>
        )}
      </div>
      <ResolveDialog dealId={dealId} discrepancyId={resolving} onClose={() => setResolving(null)} />
    </div>
  );
}

function EmptyView({ view, filtered, onClear, checklist }: { view: CoverageView; filtered: boolean; onClear: () => void; checklist?: boolean }) {
  let text = "Nothing here.";
  if (filtered) text = "No data points match.";
  else if (view === "ask") text = checklist ? "Everything on the checklist is on file. Check the items marked 'to verify', or start an interview together." : "Everything on the checklist is on file. Use the time to check the items marked 'to verify', or end the session.";
  else if (view === "verify") text = "Nothing to verify — everything on file stands.";
  else if (view === "questions") text = "No open questions.";
  else if (view === "filed") text = "Nothing filed in this session yet.";
  return (
    <div className="px-3 py-10 text-center" data-testid="coverage-empty">
      <p className="text-sm text-muted-foreground max-w-md mx-auto">{text}</p>
      {filtered && <Button variant="ghost" size="sm" className="mt-2 text-xs" onClick={onClear}>Clear the filter</Button>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Panel (the broker's AI interview)
// ─────────────────────────────────────────────────────────────────────────

export function CoveragePanel({ dealId, board }: { dealId: string; board: CoverageBoard }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  return (
    <div data-testid="coverage-panel">
      <div className="p-3 border-b border-border">
        <CoverageHeadline board={board} variant="compact" />
        <Link href={`/deal/${dealId}/interview/together?listen=0`} className="mt-2 inline-flex items-center gap-1 text-xs text-teal hover:underline underline-offset-2" data-testid="link-open-checklist">
          Open the full checklist →
        </Link>
      </div>
      <ul>
        {orderedSections(board).map((s) => {
          const isOpen = open.has(s.key);
          const { onFile, items } = sectionOnFile(s);
          return (
            <li key={s.key} className="border-b border-border/60">
              <button
                type="button"
                onClick={() => setOpen((prev) => { const n = new Set(prev); if (n.has(s.key)) n.delete(s.key); else n.add(s.key); return n; })}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-accent/40"
                aria-expanded={isOpen}
                title={s.importanceReason || undefined}
              >
                {isOpen ? <ChevronDown className="h-3 w-3 text-muted-foreground" /> : <ChevronRight className="h-3 w-3 text-muted-foreground" />}
                <SectionRing counts={s.counts} size={12} />
                <span className="flex-1 min-w-0 truncate text-left">{s.title}</span>
                {s.importance === "critical" && <span className="text-[9px] uppercase tracking-wider text-teal">Critical</span>}
                <span className="tabular-nums text-muted-foreground">{onFile}/{items}</span>
              </button>
              {isOpen && (
                <div className="pb-1">
                  {orderedItems(s.items).map((i) => (
                    <CoverageItemRow key={i.id} dealId={dealId} item={i} audience="broker" mode="panel" />
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Outline (the Overview's compact summary)
// ─────────────────────────────────────────────────────────────────────────

export function CoverageOutline({ board, actions }: { board: CoverageBoard; actions?: ReactNode }) {
  const top = rankOpenItems(board).slice(0, 5);
  return (
    <div className="space-y-4" data-testid="coverage-outline">
      <CoverageHeadline board={board} variant="compact" />
      <ul className="grid grid-cols-2 lg:grid-cols-4 gap-x-4 gap-y-2" aria-label="CIM sections">
        {orderedSections(board).map((s) => {
          const { onFile, items } = sectionOnFile(s);
          return (
            <li key={s.key} className="flex items-center gap-2 min-w-0 text-xs" title={s.importanceReason || undefined}>
              <SectionRing counts={s.counts} size={14} />
              <span className="truncate flex-1 min-w-0 text-muted-foreground">{s.title}</span>
              <span className="tabular-nums shrink-0">{onFile}/{items}</span>
            </li>
          );
        })}
      </ul>
      {top.length > 0 && (
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground mb-1.5">Top {top.length} to ask</p>
          <ol className="space-y-1.5">
            {top.map((i) => (
              <li key={i.id} className="flex items-start gap-2 text-xs">
                <StatusIcon status={i.status} size={14} className="mt-px" />
                <span className="min-w-0">
                  <span className="font-medium">{i.label}</span>
                  {i.critical && <span className="ml-1.5 text-[9px] uppercase tracking-wider text-teal">Critical</span>}
                  <span className="block text-muted-foreground">“{i.ask}”</span>
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
      {actions}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Seller ("What we've covered")
// ─────────────────────────────────────────────────────────────────────────

export function CoverageSeller({ board }: { board: CoverageBoard }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  return (
    <div className="space-y-4" data-testid="coverage-seller">
      <CoverageHeadline board={board} variant="compact" />
      <p className="text-xs text-muted-foreground">What your business overview already covers, section by section. Nothing you've told us is shown here — only what's done and what's left.</p>
      <ul className="divide-y divide-border rounded-md border border-border">
        {[...board.sections].sort((a, b) => a.order - b.order).map((s) => {
          const { onFile, items } = sectionOnFile(s);
          const isOpen = open.has(s.key);
          const named = s.items.filter((i) => i.label);
          const hidden = s.items.length - named.length;
          return (
            <li key={s.key}>
              <button
                type="button"
                className="w-full flex items-center gap-2.5 px-3 py-2.5 text-sm hover:bg-accent/40"
                onClick={() => setOpen((prev) => { const n = new Set(prev); if (n.has(s.key)) n.delete(s.key); else n.add(s.key); return n; })}
                aria-expanded={isOpen}
                data-testid={`seller-section-${s.key}`}
              >
                {isOpen ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
                <SectionRing counts={s.counts} />
                <span className="flex-1 min-w-0 truncate text-left">{s.title}</span>
                <span className="text-xs text-muted-foreground tabular-nums">{onFile} of {items} on file</span>
              </button>
              {isOpen && (
                <ul className="px-3 pb-3 pl-10 space-y-1.5">
                  {named.map((i) => (
                    <li key={i.id} className="flex items-center gap-2 text-xs">
                      <StatusIcon status={i.status} size={13} />
                      <span className={i.status === "on_file" ? "text-muted-foreground" : ""}>{i.label}</span>
                    </li>
                  ))}
                  {hidden > 0 && <li className="text-[11px] text-muted-foreground">{hidden === 1 ? "1 more item your broker added" : `${hidden} more items your broker added`}</li>}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// One entry point
// ─────────────────────────────────────────────────────────────────────────

export function CoverageBoardView(
  props:
    | { variant: "panel"; dealId: string; board: CoverageBoard }
    | { variant: "outline"; board: CoverageBoard; actions?: ReactNode }
    | { variant: "seller"; board: CoverageBoard }
    | {
        variant: "live" | "checklist";
        dealId: string;
        board: CoverageBoard;
        audience: BrokerAudience;
        state: BoardState;
        onState: (patch: Partial<BoardState>) => void;
        touch?: boolean;
        sittingId?: string;
        justFiled?: ReadonlySet<string>;
      },
) {
  switch (props.variant) {
    case "panel":
      return <CoveragePanel dealId={props.dealId} board={props.board} />;
    case "outline":
      return <CoverageOutline board={props.board} actions={props.actions} />;
    case "seller":
      return <CoverageSeller board={props.board} />;
    default:
      return (
        <BoardList
          dealId={props.dealId}
          board={props.board}
          audience={props.audience}
          rowMode={props.variant === "live" ? "live" : "checklist"}
          state={props.state}
          onState={props.onState}
          touch={props.touch}
          sittingId={props.sittingId}
          justFiled={props.justFiled}
          checklist={props.variant === "checklist"}
        />
      );
  }
}

export { CoverageRail, CoverageHeadline };
export type { CoverageItem };
