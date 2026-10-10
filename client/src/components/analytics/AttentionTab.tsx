/**
 * Analytics → What buyers read most: what buyers read most closely across
 * your CIMs, to help shape the next one. All reading so far.
 *   By topic          per page role (Financials, Customers, Price & deal
 *                     terms …): works with page-level (old) reading too
 *   By kind           tables / charts / text …: only with part-by-part reading
 *                     (the old tracker can't tell), otherwise a plain note
 *   By layout         per CIM layout
 *   Other brokerages  anonymous, same industry, ≥ 5 deals behind a figure
 * "Closely" = reading time ÷ the time a careful read of that content takes,
 * so a few charts compare fairly with many paragraphs.
 */
import { formatReadingTime, READ_LABEL_TEXT, type LayoutAttention } from "@shared/analytics-v2";
import { readLabel, timesWord } from "@shared/cim-reading-model";
import { PAGE_ROLE_TEXT } from "@shared/cim-page-role";
import { plural, type AttentionResponse, type ExamplesMode, type RoleAttention } from "@shared/analytics-dashboard";
import { useAnalyticsAttention } from "@/hooks/useAnalyticsDashboard";
import { Skeleton } from "@/components/ui/skeleton";
import { PanelError } from "@/components/deal/PanelError";
import { AttentionByKind } from "@/components/engagement/AttentionByKind";
import { TabEmpty } from "./EmptyStates";

export const ATTENTION_COPY = {
  description: "What buyers read most closely across your CIMs, to help you shape the next one. All reading so far; not affected by the date range.",
  needsParts: "Needs part-by-part reading. Your buyers' reading so far was recorded page by page, so we can't yet tell whether tables, charts or text hold attention. This fills in as buyers read with the current tracker.",
  empty: "Nothing to compare yet. When buyers read your CIMs, this shows which topics and kinds of pages hold their attention.",
};

/** 2.1 → "twice their expected reading time"; 0.5 → "about half their expected reading time". */
function ratioWords(r: number): string {
  if (r >= 1.1) return `${timesWord(r)} their expected reading time`;
  if (r >= 0.9) return "about their expected reading time";
  if (r >= 0.6) return "about two-thirds of their expected reading time";
  if (r >= 0.4) return "about half their expected reading time";
  return "under half their expected reading time";
}

const ratio = (a: number, e: number) => (e > 0 ? a / e : 0);

/** "Buyers read your Financials pages most closely, twice the time their content needs." */
export function roleHeadline(rows: RoleAttention[]): string | null {
  const top = rows.filter((r) => r.expectedMs > 0).sort((a, b) => ratio(b.attentionMs, b.expectedMs) - ratio(a.attentionMs, a.expectedMs))[0];
  if (!top) return null;
  const r = ratio(top.attentionMs, top.expectedMs);
  return r >= 1.1
    ? `Buyers read your ${top.label} pages most closely, ${timesWord(r)} the time their content needs.`
    : `Buyers read your ${top.label} pages most closely.`;
}

function Panel({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) {
  return (
    <section className="min-w-0 rounded-xl border border-border bg-card p-4 sm:p-5" data-testid={testId}>
      <h3 className="mb-2 text-sm font-semibold text-foreground">{title}</h3>
      {children}
    </section>
  );
}

export function RoleBars({ rows }: { rows: RoleAttention[] }) {
  const per = rows
    .filter((r) => r.expectedMs > 0 && r.attentionMs > 0)
    .map((r) => ({ ...r, ratio: ratio(r.attentionMs, r.expectedMs) }))
    .sort((a, b) => b.ratio - a.ratio)
    .slice(0, 10);
  if (per.length === 0) return <p className="text-sm text-muted-foreground">No topic has reading yet.</p>;
  const max = Math.max(...per.map((r) => r.ratio), 1);
  const headline = roleHeadline(per);
  return (
    <div data-testid="attention-by-role">
      {headline && <p className="mb-3 text-sm text-foreground/90">{headline}</p>}
      <ul className="space-y-2">
        {per.map((r) => {
          const label = readLabel(r.attentionMs, r.expectedMs);
          const tip = `${formatReadingTime(r.attentionMs)} of reading on ${r.label} pages by ${plural(r.readers, "buyer")}, against ${formatReadingTime(r.expectedMs)} for a careful read of what they opened.`;
          return (
            <li key={r.role} className="grid grid-cols-[minmax(84px,150px)_1fr_auto] items-center gap-3 text-xs" title={tip}>
              <span className="truncate text-foreground/90">{r.label}</span>
              <span className="h-2.5 overflow-hidden rounded-full bg-muted">
                <span className="block h-full rounded-full bg-teal/75" style={{ width: `${Math.max(2, (r.ratio / max) * 100)}%` }} />
              </span>
              <span className="whitespace-nowrap text-right tabular-nums text-muted-foreground">
                <span className="text-foreground">{formatReadingTime(r.attentionMs)}</span>
                {label && <span className="ml-1.5 hidden sm:inline">· {READ_LABEL_TEXT[label]}</span>}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** By layout (moved here from the old "Your deals compared"). */
export function LayoutBars({ layouts }: { layouts: LayoutAttention[] }) {
  const per = layouts
    .filter((l) => l.pages > 0 && l.expectedMs > 0)
    .map((l) => ({ ...l, ratio: l.attentionMs / l.expectedMs }))
    .sort((a, b) => b.ratio - a.ratio)
    .slice(0, 8);
  if (per.length === 0) return <p className="text-sm text-muted-foreground">No layout has reading yet.</p>;
  const max = Math.max(...per.map((l) => l.ratio), 1);
  const top = per[0];
  return (
    <div className="min-w-0" data-testid="attention-by-layout">
      <p className="mb-3 text-sm text-foreground/90">
        {top.ratio >= 1.1
          ? `${top.label} pages are read most closely, ${timesWord(top.ratio)} the time their content needs.`
          : `${top.label} pages are read most closely.`}
      </p>
      <ul className="space-y-2">
        {per.map((l) => {
          const label = readLabel(l.attentionMs, l.expectedMs);
          return (
            <li key={l.layoutType} className="grid grid-cols-[minmax(84px,150px)_1fr_auto] items-center gap-3 text-xs">
              <span className="truncate text-foreground/90">{l.label}</span>
              <span className="h-2.5 overflow-hidden rounded-full bg-muted">
                <span className="block h-full rounded-full bg-teal/60" style={{ width: `${Math.max(2, (l.ratio / max) * 100)}%` }} />
              </span>
              <span className="whitespace-nowrap text-right tabular-nums text-muted-foreground">
                {label && <span className="text-foreground">{READ_LABEL_TEXT[label]}</span>}
                <span className="ml-1.5 hidden sm:inline">· {formatReadingTime(l.attentionMs)} on {plural(l.pages, "page")}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function AttentionPanels({ data }: { data: AttentionResponse }) {
  const empty = data.basis.buyers === 0 || (data.byRole.length === 0 && data.byLayout.length === 0);
  if (empty) return <TabEmpty title={ATTENTION_COPY.empty} testId="attention-empty" />;
  return (
    <div className="space-y-4" data-testid="attention-tab">
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="By topic" testId="panel-role"><RoleBars rows={data.byRole} /></Panel>
        <Panel title="By kind of content" testId="panel-kind">
          {data.partByPart && data.byKind.length > 0 ? (
            <AttentionByKind kinds={data.byKind} />
          ) : (
            <p className="text-sm text-muted-foreground" data-testid="needs-part-by-part">{ATTENTION_COPY.needsParts}</p>
          )}
        </Panel>
        <Panel title="By layout" testId="panel-layout"><LayoutBars layouts={data.byLayout} /></Panel>
        {data.benchmarks.length > 0 && (
          <Panel title="Other brokerages, same industry" testId="engagement-benchmarks">
            <p className="mb-2 text-xs text-muted-foreground">Anonymous. Shown only where at least five of their deals stand behind a figure.</p>
            <ul className="space-y-1.5 text-sm">
              {data.benchmarks.map((b) => (
                <li key={`${b.industry}:${b.role}`} className="text-foreground/90">
                  {b.industry}: buyers give <span className="font-medium">{PAGE_ROLE_TEXT[b.role]}</span> pages {ratioWords(b.medianStudyRatio)}
                  <span className="text-muted-foreground"> ({b.deals} deals)</span>
                </li>
              ))}
            </ul>
          </Panel>
        )}
      </div>
      <p className="text-xs text-muted-foreground" data-testid="attention-basis">
        Based on {plural(data.basis.buyers, "buyer")} across {plural(data.basis.deals, "deal")} · {formatReadingTime(data.basis.attentionMs)} of reading.
      </p>
    </div>
  );
}

export function AttentionTab({ examples }: { examples: ExamplesMode | null }) {
  const { data, isLoading, error, refetch } = useAnalyticsAttention(examples);
  if (isLoading) {
    return (
      <div className="grid gap-4 lg:grid-cols-2">
        {[0, 1, 2].map((i) => <Skeleton key={i} className="h-56 w-full rounded-xl" />)}
      </div>
    );
  }
  if (error || !data) return <PanelError what="what buyers read most" onRetry={() => refetch()} />;
  return <AttentionPanels data={data} />;
}
