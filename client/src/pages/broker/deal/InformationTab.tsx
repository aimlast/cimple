/**
 * InformationTab — everything collected about the business, by CIM section,
 * with the source of every fact. Always available, in every phase: the
 * broker can see what's on file, where each fact came from (which document,
 * which interview turn, which email / call / CRM note / website item, or
 * their own edit), fix it, add to it, remove it, and add new sources.
 */
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useDeal } from "@/contexts/DealContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { PanelError } from "@/components/deal/PanelError";
import { useToast } from "@/hooks/use-toast";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleDashed,
  Globe,
  Plus,
  RotateCcw,
  Search,
  X,
  Check,
  Loader2,
  History,
} from "lucide-react";
import type {
  FactSourceInfo,
  FactSourceKind,
  InformationFact,
  InformationSection,
  InformationSource,
  InformationView,
} from "@shared/information";
import { sourceCountText } from "@shared/information";
import { FactRow, AddFactForm, SourceChip } from "@/components/information/FactRow";
import { SourcesPanel, SourceViewer } from "@/components/information/SourcesPanel";
import { AddSourceDialog } from "@/components/information/AddSourceDialog";
import { FILTER_KINDS, KIND_META } from "@/components/information/source-kinds";
import { useInformation, useInformationAction } from "@/components/information/useInformation";
import { CrmLinkCard } from "@/components/crm/CrmLinkCard";
import { SellerContactCard } from "@/components/crm/SellerContactCard";

const LEVEL_TEXT = { critical: "Critical for buyers", important: "Important", helpful: "Helpful" } as const;
const STATUS_TEXT = { well_covered: "Covered", partial: "Partly covered", missing: "Nothing yet" } as const;
const READINESS_CLASS = { "Buyer-ready": "text-success", Solid: "text-teal", Developing: "text-foreground", Thin: "text-muted-foreground" } as const;

function StatusIcon({ status }: { status: InformationSection["status"] }) {
  if (status === "well_covered") return <CheckCircle2 className="h-4 w-4 text-success shrink-0" />;
  if (status === "partial") return <CircleDashed className="h-4 w-4 text-teal shrink-0" />;
  return <Circle className="h-4 w-4 text-muted-foreground/40 shrink-0" />;
}

function matchesSource(src: FactSourceInfo, sourceId: string): boolean {
  if (sourceId.startsWith("session:")) return src.sessionId === sourceId.slice("session:".length);
  if (sourceId === "questionnaire") return src.kind === "questionnaire";
  if (sourceId === "website") return src.kind === "website" && !src.documentId;
  if (sourceId === "broker") return src.kind === "broker";
  if (sourceId === "interview") return src.kind === "interview" && !src.sessionId && !src.documentId;
  // Pre-session call facts ("legacy:call" / "legacy:video_call" rows).
  if (sourceId.startsWith("legacy:")) return src.kind === sourceId.slice("legacy:".length) && !src.sessionId && !src.documentId;
  return src.documentId === sourceId;
}

function LoadingState() {
  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 space-y-4">
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-9 w-full" />
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_20rem] gap-6">
        <div className="space-y-3">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    </div>
  );
}

export function InformationTab() {
  const { dealId, deal } = useDeal();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const { data: view, isLoading, error, refetch } = useInformation(dealId);
  const action = useInformationAction(dealId);

  const [kindFilter, setKindFilter] = useState<FactSourceKind | "all">("all");
  const [sourceFilter, setSourceFilter] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showMissing, setShowMissing] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState<{ section: string | null; missingKey?: string; missingLabel?: string } | null>(null);
  const [addSourceOpen, setAddSourceOpen] = useState(false);
  const [viewing, setViewing] = useState<InformationSource | null>(null);
  const [showDeleted, setShowDeleted] = useState(false);

  const q = query.trim().toLowerCase();
  const filtering = kindFilter !== "all" || !!sourceFilter || !!q;
  const factVisible = useMemo(
    () => (f: InformationFact) =>
      (kindFilter === "all" || f.source.kind === kindFilter) &&
      (!sourceFilter || matchesSource(f.source, sourceFilter)) &&
      (!q || f.label.toLowerCase().includes(q) || f.displayValue.toLowerCase().includes(q) || f.source.label.toLowerCase().includes(q)),
    [kindFilter, sourceFilter, q],
  );

  if (isLoading) return <LoadingState />;
  if (error || !view) {
    return (
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6">
        <PanelError what="the collected information" onRetry={() => refetch()} />
      </div>
    );
  }

  const openSource = (src: FactSourceInfo) => {
    if (src.documentId) {
      const s = view.sources.find((x) => x.documentId === src.documentId);
      if (s) return setViewing(s);
      return toast({ title: "That source was deleted", description: "The fact stays on file until you change it." });
    }
    if (src.sessionId) {
      const turn = typeof src.turn === "number" ? `&turn=${src.turn}` : "";
      return setLocation(`/deal/${dealId}/interview-review?session=${src.sessionId}${turn}`);
    }
    if (src.kind === "website") document.getElementById("website-items")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const openListedSource = (s: InformationSource) => {
    if (s.documentId) return setViewing(s);
    if (s.sessionId) return setLocation(`/deal/${dealId}/interview-review?session=${s.sessionId}`);
    if (s.kind === "website") document.getElementById("website-items")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const readiness = view.readiness;
  // One wording with the Sources panel: "8 sources · 6 contributed facts".
  const sourcesText = sourceCountText(view.sources);
  const untracked = view.counts.unknown ?? 0;
  const inferredFacts = view.inferredFacts ?? 0;
  const activeSource = sourceFilter ? view.sources.find((s) => s.id === sourceFilter) : null;

  const sectionsShown = view.sections
    .map((s) => ({ section: s, facts: s.facts.filter(factVisible) }))
    .filter(({ section, facts }) => facts.length > 0 || (!filtering && (showMissing ? section.missing.length > 0 || section.facts.length > 0 : section.facts.length > 0)));
  const emptySections = !filtering && !showMissing ? view.sections.filter((s) => s.facts.length === 0) : [];
  const otherShown = view.other.filter(factVisible);
  const nothingMatches = filtering && sectionsShown.length === 0 && otherShown.length === 0;
  const missingCount = view.sections.reduce((n, s) => n + s.missing.length, 0);

  const toggleCollapsed = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });

  const acceptWebsite = (field: string) =>
    action.mutate(
      { method: "POST", path: `/website/${encodeURIComponent(field)}/accept` },
      {
        onSuccess: () => toast({ title: "Added to the facts", description: "Marked as from the website — the interview still confirms it with the seller." }),
        onError: (e) => toast({ title: "Couldn't add it", description: (e as Error).message, variant: "destructive" }),
      },
    );

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 space-y-4" data-testid="information-tab">
      {/* ── Header ── */}
      <div className="rounded-lg border border-border bg-card p-4 sm:p-5">
        <div className="flex flex-col sm:flex-row sm:items-start gap-4 sm:gap-8">
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold tracking-tight">Collected information</h2>
            <p className="text-sm text-muted-foreground mt-1">{readiness.summary}</p>
            <p className="text-xs text-muted-foreground/80 mt-2 tabular-nums">
              {/* "64 facts · 8 sources · 6 contributed facts · 35 earlier records" */}
              {view.totalFacts} fact{view.totalFacts === 1 ? "" : "s"}
              {view.sources.length > 0 && <>{" · "}{sourcesText}</>}
              {untracked > 0 && <>{" · "}{untracked} earlier record{untracked === 1 ? "" : "s"}</>}
              {missingCount > 0 && (
                <>
                  {" · "}
                  <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => setShowMissing(true)}>
                    {missingCount} still missing
                  </button>
                </>
              )}
            </p>
          </div>
          <div className="sm:w-56 shrink-0">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">CIM quality</span>
              <span className="text-sm tabular-nums">
                <span className={`font-semibold ${READINESS_CLASS[readiness.label]}`}>{readiness.label}</span>
                <span className="text-muted-foreground/70"> · {readiness.score}</span>
              </span>
            </div>
            <Progress value={readiness.score} className="h-1.5 mt-2" />
            <p className="text-[11px] text-muted-foreground mt-1.5 tabular-nums">
              {readiness.byLevel.critical.covered}/{readiness.byLevel.critical.total} critical sections covered
            </p>
          </div>
        </div>
      </div>

      {/* ── Who the seller is + their CRM record ── */}
      <div className="grid sm:grid-cols-2 gap-3">
        <SellerContactCard dealId={dealId} />
        <CrmLinkCard dealId={dealId} />
      </div>

      {/* ── Filters ── */}
      <div className="space-y-2.5">
        <div className="-mx-4 px-4 sm:mx-0 sm:px-0 overflow-x-auto scrollbar-thin">
          <div className="flex items-center gap-1.5 w-max sm:w-auto sm:flex-wrap pb-0.5" role="tablist" aria-label="Filter by source">
            <FilterChip label="All" count={view.totalFacts} active={kindFilter === "all"} onClick={() => setKindFilter("all")} />
            {FILTER_KINDS.map((k) => (
              <FilterChip
                key={k}
                kind={k}
                label={KIND_META[k].plural}
                count={view.counts[k] ?? 0}
                active={kindFilter === k}
                onClick={() => setKindFilter(kindFilter === k ? "all" : k)}
              />
            ))}
            {untracked > 0 && (
              <FilterChip kind="unknown" label={KIND_META.unknown.plural} count={untracked} active={kindFilter === "unknown"} onClick={() => setKindFilter(kindFilter === "unknown" ? "all" : "unknown")} />
            )}
          </div>
        </div>
        <div className="flex flex-col sm:flex-row sm:items-center gap-2.5">
          <div className="relative flex-1">
            <Search className="h-3.5 w-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search facts, values or sources"
              className="h-9 pl-8 pr-8"
              data-testid="input-information-search"
            />
            {query && (
              <button type="button" onClick={() => setQuery("")} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" aria-label="Clear search">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer shrink-0">
            <Switch checked={showMissing} onCheckedChange={setShowMissing} data-testid="switch-show-missing" />
            Show what's still missing
          </label>
        </div>
        {(untracked > 0 || inferredFacts > 0) && !activeSource && (
          // One calm explanation instead of a question mark on every row.
          <p className="flex items-start gap-2 rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground leading-relaxed" data-testid="note-earlier-records">
            <History className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>
              {inferredFacts > 0 && untracked > 0
                ? <>Some facts were collected before Cimple recorded where each one came from. {inferredFacts} of them {inferredFacts === 1 ? "matches" : "match"} a source on file and {inferredFacts === 1 ? "is" : "are"} marked <span className="italic">inferred</span>; the other {untracked} {untracked === 1 ? "is" : "are"} marked <span className="text-foreground/80">Earlier record</span>. Check those against your sources, or edit one to confirm it yourself.</>
                : inferredFacts > 0
                  ? <>{inferredFacts} fact{inferredFacts === 1 ? " was" : "s were"} collected before Cimple recorded where each one came from. {inferredFacts === 1 ? "It matches" : "Each matches"} a source on file, so {inferredFacts === 1 ? "it's" : "they're"} marked <span className="italic">inferred</span>.</>
                  : <>{untracked} fact{untracked === 1 ? " was" : "s were"} collected before Cimple recorded where each one came from, and {untracked === 1 ? "doesn't" : "don't"} match any source on file. {untracked === 1 ? "It's" : "They're"} marked <span className="text-foreground/80">Earlier record</span>. Check {untracked === 1 ? "it" : "them"} against your sources, or edit one to confirm it yourself.</>}
            </span>
          </p>
        )}
        {activeSource && (
          <div className="flex items-center gap-2 rounded-md border border-teal/30 bg-teal/5 px-3 py-2 text-xs">
            <span className="text-muted-foreground">Showing facts from</span>
            <span className="font-medium truncate">{activeSource.title}</span>
            <button type="button" className="ml-auto inline-flex items-center gap-1 text-muted-foreground hover:text-foreground" onClick={() => setSourceFilter(null)}>
              <X className="h-3 w-3" /> Clear
            </button>
          </div>
        )}
      </div>

      {/* ── Body ── */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_20rem] gap-6 items-start">
        <div className="space-y-3 min-w-0">
          {view.totalFacts === 0 && !filtering ? (
            <div className="rounded-lg border border-dashed border-border bg-muted/10 px-6 py-10 text-center">
              <p className="text-sm font-medium">Nothing collected yet</p>
              <p className="text-xs text-muted-foreground mt-1 max-w-md mx-auto">
                Facts appear here as the seller answers the interview and as you add documents, emails, call
                transcripts or notes. Each one shows where it came from.
              </p>
              <Button size="sm" className="mt-4 gap-1 bg-teal text-teal-foreground hover:bg-teal/90" onClick={() => setAddSourceOpen(true)}>
                <Plus className="h-3.5 w-3.5" /> Add a source
              </Button>
            </div>
          ) : nothingMatches ? (
            <div className="rounded-lg border border-dashed border-border px-6 py-10 text-center">
              <p className="text-sm font-medium">No facts match</p>
              <button
                type="button"
                className="text-xs text-teal mt-1 hover:underline"
                onClick={() => { setKindFilter("all"); setSourceFilter(null); setQuery(""); }}
              >
                Clear filters
              </button>
            </div>
          ) : null}

          {sectionsShown.map(({ section, facts }) => {
            const isCollapsed = collapsed.has(section.key);
            const addingHere = adding && adding.section === section.key;
            return (
              <section key={section.key} className="rounded-lg border border-border bg-card overflow-hidden" data-testid={`info-section-${section.key}`}>
                <button
                  type="button"
                  onClick={() => toggleCollapsed(section.key)}
                  className="w-full flex items-center gap-2.5 px-4 py-3 text-left hover:bg-muted/20 transition-colors"
                  aria-expanded={!isCollapsed}
                >
                  <StatusIcon status={section.status} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <h3 className="text-sm font-semibold">{section.title}</h3>
                      <span className={`text-[11px] ${section.importance === "critical" ? "text-teal" : "text-muted-foreground/70"}`}>
                        {LEVEL_TEXT[section.importance]}
                      </span>
                      {section.excluded && <span className="text-[11px] text-muted-foreground/60">· Left out of the interview</span>}
                    </div>
                  </div>
                  <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">
                    {filtering ? `${facts.length} of ${section.facts.length}` : section.facts.length} fact{section.facts.length === 1 ? "" : "s"}
                    <span className="hidden sm:inline"> · {STATUS_TEXT[section.status]}</span>
                  </span>
                  {isCollapsed ? <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" /> : <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />}
                </button>

                {!isCollapsed && (
                  <div className="border-t border-border/60">
                    {facts.map((f) => (
                      <FactRow key={f.key} dealId={dealId} fact={f} onOpenSource={openSource} />
                    ))}
                    {facts.length === 0 && !showMissing && (
                      <p className="px-4 py-3 text-xs text-muted-foreground">Nothing collected for this section yet.</p>
                    )}

                    {showMissing && !filtering && section.missing.length > 0 && (
                      <div className="border-t border-border/40 bg-muted/10">
                        <p className="px-4 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/70">Still missing</p>
                        <ul className="pb-2">
                          {section.missing.map((m) =>
                            adding?.missingKey === m.key ? (
                              <li key={m.key}>
                                <AddFactForm dealId={dealId} sectionKey={section.key} missingKey={m.key} missingLabel={m.label} onDone={() => setAdding(null)} />
                              </li>
                            ) : (
                              <li key={m.key} className="group flex items-center gap-2 px-4 py-1.5">
                                <CircleDashed className="h-3 w-3 text-muted-foreground/50 shrink-0" />
                                <span className="text-xs text-muted-foreground flex-1 min-w-0">
                                  {m.label}
                                  {m.critical && <span className="ml-1.5 text-[10px] uppercase tracking-wider text-teal">Critical</span>}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => setAdding({ section: section.key, missingKey: m.key, missingLabel: m.label })}
                                  className="text-[11px] text-teal hover:underline sm:opacity-0 sm:group-hover:opacity-100 focus:opacity-100 transition-opacity"
                                >
                                  Fill in
                                </button>
                              </li>
                            ),
                          )}
                        </ul>
                      </div>
                    )}

                    {addingHere && !adding?.missingKey ? (
                      <AddFactForm dealId={dealId} sectionKey={section.key} onDone={() => setAdding(null)} />
                    ) : (
                      <div className="border-t border-border/40 px-4 py-2">
                        <button
                          type="button"
                          onClick={() => setAdding({ section: section.key })}
                          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-teal transition-colors"
                          data-testid={`button-add-fact-${section.key}`}
                        >
                          <Plus className="h-3 w-3" /> Add a fact
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </section>
            );
          })}

          {emptySections.length > 0 && view.totalFacts > 0 && (
            <div className="rounded-lg border border-dashed border-border px-4 py-3 text-xs text-muted-foreground">
              <span className="font-medium text-foreground/80">Nothing collected yet for: </span>
              {emptySections.map((s) => s.title).join(" · ")}
              <button type="button" onClick={() => setShowMissing(true)} className="ml-2 text-teal hover:underline">
                See what's needed
              </button>
            </div>
          )}

          {otherShown.length > 0 && (
            <section className="rounded-lg border border-border bg-card overflow-hidden" data-testid="info-section-other">
              <button
                type="button"
                onClick={() => toggleCollapsed("__other")}
                className="w-full flex items-center gap-2.5 px-4 py-3 text-left hover:bg-muted/20 transition-colors"
              >
                <Circle className="h-4 w-4 text-muted-foreground/40 shrink-0" />
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-semibold">Other facts</h3>
                  <p className="text-[11px] text-muted-foreground">On file, but not part of a standard CIM section</p>
                </div>
                <span className="text-[11px] text-muted-foreground tabular-nums">{otherShown.length}</span>
                {collapsed.has("__other") ? <ChevronRight className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
              </button>
              {!collapsed.has("__other") && (
                <div className="border-t border-border/60">
                  {otherShown.map((f) => (
                    <FactRow key={f.key} dealId={dealId} fact={f} onOpenSource={openSource} />
                  ))}
                </div>
              )}
            </section>
          )}

          {/* Website data — public, unverified; the broker decides what goes in */}
          {view.website && view.website.items.length > 0 && !filtering && (
            <section id="website-items" className="rounded-lg border border-dashed border-border bg-card/60 overflow-hidden scroll-mt-4">
              <div className="flex items-start gap-2.5 px-4 py-3">
                <Globe className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-semibold">Found on the web — not verified</h3>
                  <p className="text-[11px] text-muted-foreground">
                    {view.website.url ? view.website.url.replace(/^https?:\/\//, "") : "Public search results"}
                    {" · "}Accept an item to put it on file; the interview still confirms it with the seller.
                  </p>
                </div>
              </div>
              <ul className="border-t border-border/50 divide-y divide-border/40">
                {view.website.items.map((w) => (
                  <li key={w.field} className="grid grid-cols-1 sm:grid-cols-[minmax(0,12.5rem)_minmax(0,1fr)_auto] gap-x-4 gap-y-1 px-4 py-2.5">
                    <p className="text-xs font-medium text-muted-foreground">{w.label}</p>
                    <p className="text-sm text-foreground/85 break-words line-clamp-3">{w.value}</p>
                    <div className="flex items-center">
                      {w.status === "accepted" ? (
                        <span className="inline-flex items-center gap-1 text-[11px] text-success"><Check className="h-3 w-3" /> In facts</span>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-[11px]"
                          disabled={action.isPending}
                          onClick={() => acceptWebsite(w.field)}
                          title={w.status === "on_file" ? "Another source already holds this fact — this adds the website's version as another value" : undefined}
                        >
                          {w.status === "on_file" ? "Add as another value" : "Accept into facts"}
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {view.deleted.length > 0 && !filtering && (
            <section className="rounded-lg border border-border/60 bg-card/40 overflow-hidden">
              <button type="button" onClick={() => setShowDeleted((v) => !v)} className="w-full flex items-center gap-2 px-4 py-2.5 text-left text-xs text-muted-foreground hover:text-foreground">
                {showDeleted ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                Deleted facts ({view.deleted.length})
              </button>
              {showDeleted && (
                <ul className="border-t border-border/40 divide-y divide-border/30">
                  {view.deleted.map((d) => (
                    <li key={d.key} className="flex items-start gap-3 px-4 py-2.5">
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium text-muted-foreground">{d.label}</p>
                        <p className="text-sm text-muted-foreground/80 line-through decoration-muted-foreground/40 break-words line-clamp-2">{d.displayValue}</p>
                        <div className="mt-1"><SourceChip source={d.source} size="xs" /></div>
                        {d.note && <p className="mt-1 text-[11px] text-muted-foreground/80">{d.note}</p>}
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-[11px] gap-1 shrink-0"
                        disabled={action.isPending}
                        onClick={() =>
                          action.mutate(
                            { method: "POST", path: `/facts/${encodeURIComponent(d.key)}/restore` },
                            { onError: (e) => toast({ title: "Couldn't restore", description: (e as Error).message, variant: "destructive" }) },
                          )
                        }
                      >
                        {action.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />} Restore
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>

        <aside className="lg:sticky lg:top-4 space-y-3">
          <SourcesPanel
            sources={view.sources}
            activeSourceId={sourceFilter}
            onFilterSource={(id) => { setSourceFilter(id); if (id) setKindFilter("all"); }}
            onOpen={openListedSource}
            onAdd={() => setAddSourceOpen(true)}
            untrackedFacts={untracked}
          />
          {deal.interviewCompleted && (
            <div className="rounded-lg border border-border/60 px-4 py-3 text-xs text-muted-foreground">
              The interview is complete.{" "}
              <button type="button" className="text-teal hover:underline" onClick={() => setLocation(`/deal/${dealId}/interview`)}>
                Add more detail
              </button>{" "}
              or{" "}
              <button type="button" className="text-teal hover:underline" onClick={() => setLocation(`/deal/${dealId}/interview-review`)}>
                read the transcript
              </button>
              .
            </div>
          )}
        </aside>
      </div>

      <AddSourceDialog dealId={dealId} open={addSourceOpen} onOpenChange={setAddSourceOpen} />
      <SourceViewer
        dealId={dealId}
        source={viewing ? view.sources.find((s) => s.id === viewing.id) ?? viewing : null}
        onClose={() => setViewing(null)}
        onShowFacts={(id) => { setSourceFilter(id); setKindFilter("all"); }}
      />
    </div>
  );
}

function FilterChip({
  label,
  count,
  active,
  onClick,
  kind,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  kind?: FactSourceKind;
}) {
  const Icon = kind ? KIND_META[kind].icon : null;
  const disabled = count === 0 && !active;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs whitespace-nowrap transition-colors ${
        active
          ? "border-teal/60 bg-teal/10 text-teal"
          : disabled
            ? "border-border/50 text-muted-foreground/40 cursor-default"
            : "border-border text-muted-foreground hover:text-foreground hover:border-teal/40"
      }`}
      data-testid={`filter-${kind ?? "all"}`}
    >
      {Icon && <Icon className="h-3 w-3" />}
      {label}
      <span className={`tabular-nums ${active ? "text-teal/80" : "text-muted-foreground/60"}`}>{count}</span>
    </button>
  );
}

