/**
 * ChecksTab — "Statements vs tax returns" (spec §5.2 Tab 2; "Source checks"
 * when management accounts are compared too): each figure the CIM shows
 * beside the company's other records. A segmented filter (Differences ·
 * Grouped differently · Needs checking · Matches · Left out); difference rows
 * with both figures, the tax-return line, why, and the actions; "needs
 * checking" rows say what Cimple couldn't find; matches as a compact grid.
 */
import { useMemo } from "react";
import { Check, ExternalLink, HelpCircle, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { checkCounts, type CheckGroup, type WorkspaceCheck } from "@shared/figure-workspace";
import { money, signedMoney } from "./useFigures";

const GROUPS: Array<{ key: CheckGroup; label: string }> = [
  { key: "difference", label: "Differences" },
  { key: "regrouped", label: "Grouped differently" },
  { key: "needs_checking", label: "Needs checking" },
  { key: "match", label: "Matches" },
  { key: "left_out", label: "Left out" },
];

export interface ChecksActions {
  onShow(c: WorkspaceCheck): void;
  onLeaveOut(c: WorkspaceCheck): void;
  onReadWrong(c: WorkspaceCheck): void;
  onAsk(c: WorkspaceCheck): void;
  onWrite(c: WorkspaceCheck): void;
  onOpenNote(noteId: string): void;
  onUndoLeaveOut(c: WorkspaceCheck): void;
}

function StatePill({ c }: { c: WorkspaceCheck }) {
  const map: Record<string, { label: string; cls: string; Icon: typeof Check }> = {
    regrouped: { label: "Grouped differently", cls: "border-success/40 text-success", Icon: Info },
    explained: { label: "Reason given", cls: "border-sky-400/40 text-sky-300", Icon: Info },
    ask: { label: "No reason yet", cls: "border-amber-500/50 text-amber-500", Icon: HelpCircle },
    match: { label: "Matches", cls: "border-success/40 text-success", Icon: Check },
  };
  const s = map[c.state];
  return <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]", s.cls)}><s.Icon className="h-3 w-3" />{s.label}</span>;
}

function shownWords(c: WorkspaceCheck): string {
  if (c.decision === "left_out") return `Left out: ${c.leftOutReason ?? "no reason given"}`;
  if (c.shownToBuyers) return "Shown to due-diligence buyers";
  if (c.decision === "shown") return "Ready: shown once the checks are on";
  return "Not shown yet";
}

function DocLink({ doc }: { doc: WorkspaceCheck["otherDocument"] }) {
  if (!doc) return null;
  return doc.href ? (
    <a href={doc.href} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-0.5 truncate text-[11px] text-teal hover:underline" title={doc.name}>
      <span className="truncate">{doc.name}</span><ExternalLink className="h-3 w-3 shrink-0" />
    </a>
  ) : <span className="block truncate text-[11px] text-muted-foreground" title={doc.name}>{doc.name}</span>;
}

function DifferenceRow({ c, a }: { c: WorkspaceCheck; a: ChecksActions }) {
  const why = c.state === "regrouped" ? c.regroupedText : c.note?.text ?? null;
  return (
    <div className="grid gap-3 rounded-lg border border-border bg-card p-3 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.6fr)]" data-testid={`check-row-${c.checkKey}`}>
      <div className="min-w-0">
        <p className="text-sm font-medium">{c.label} · FY{c.year}</p>
        <p className="text-[11px] text-muted-foreground">{shownWords(c)}</p>
      </div>
      <div className="min-w-0 text-xs tabular-nums">
        <p className="text-muted-foreground">This CIM</p>
        <p className="text-sm">{money(c.thisCim)}</p>
        {c.base !== c.thisCim && <p className="text-[11px] text-muted-foreground">Statements as issued {money(c.base)}</p>}
        <DocLink doc={c.baseDocument} />
      </div>
      <div className="min-w-0 text-xs tabular-nums">
        <p className="text-muted-foreground">{c.otherLabel}</p>
        <p className="text-sm">{money(c.other)}</p>
        {c.sourceLabel && <p className="truncate text-[11px] text-muted-foreground" title={c.sourceLabel}>“{c.sourceLabel}”</p>}
        <DocLink doc={c.otherDocument} />
      </div>
      <div className="min-w-0 space-y-1.5 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <span className="tabular-nums">{signedMoney(c.difference)}{c.pct ? ` (${c.pct})` : ""}</span>
          <StatePill c={c} />
        </div>
        <p className={why ? "text-foreground" : "text-muted-foreground"}>{why ?? "No reason on file"}</p>
        <div className="flex flex-wrap gap-1.5">
          {c.decision === "left_out" ? (
            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => a.onUndoLeaveOut(c)}>Show it again</Button>
          ) : (
            <>
              {!c.shownToBuyers && c.decision !== "shown" && !c.refusal && (
                <Button size="sm" className="h-7 bg-teal px-2 text-xs text-teal-foreground hover:bg-teal/90" onClick={() => a.onShow(c)}>Show to buyers</Button>
              )}
              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => a.onLeaveOut(c)}>Leave out…</Button>
              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => a.onReadWrong(c)}>Cimple read it wrong</Button>
              {c.state === "ask" && <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => a.onAsk(c)}>Ask the seller</Button>}
              {c.state !== "regrouped" && (c.note ? (
                <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => a.onOpenNote(c.note!.id)}>Edit the reason</Button>
              ) : (
                <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => a.onWrite(c)}>Write a reason</Button>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function NeedsCheckingRow({ c, a }: { c: WorkspaceCheck; a: ChecksActions }) {
  return (
    <div className="space-y-2 rounded-lg border border-[#9B4A3A]/50 bg-card p-3" data-testid={`check-needs-${c.checkKey}`}>
      <p className="text-sm font-medium">{c.label} · FY{c.year} <span className="font-normal text-muted-foreground">· {money(c.thisCim)} vs {money(c.other)}</span></p>
      <p className="text-xs text-foreground">{c.notLocatedMessage ?? "Cimple couldn't find this figure in the document's text. Check the document before showing this."}</p>
      <div className="flex flex-wrap gap-1.5">
        {c.otherDocument?.href && (
          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" asChild>
            <a href={c.otherDocument.href} target="_blank" rel="noreferrer">Open document</a>
          </Button>
        )}
        <Button size="sm" className="h-7 bg-teal px-2 text-xs text-teal-foreground hover:bg-teal/90" onClick={() => a.onReadWrong(c)}>Correct it</Button>
        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => a.onLeaveOut(c)}>Leave out…</Button>
      </div>
      <p className="text-[11px] text-muted-foreground">Once you correct the figure, Cimple checks it again; a figure it can't find in the document is never shown to buyers.</p>
    </div>
  );
}

function MatchGrid({ checks }: { checks: WorkspaceCheck[] }) {
  const years = Array.from(new Set(checks.map((c) => c.year))).sort();
  const labels = Array.from(new Set(checks.map((c) => c.label)));
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-left text-xs">
        <thead className="bg-muted/40 text-[11px] text-muted-foreground">
          <tr><th className="px-3 py-2 font-medium">Figure</th>{years.map((y) => <th key={y} className="px-3 py-2 text-center font-medium">FY{y}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-border">
          {labels.map((l) => (
            <tr key={l}>
              <td className="px-3 py-1.5">{l}</td>
              {years.map((y) => {
                const c = checks.find((x) => x.label === l && x.year === y);
                return <td key={y} className="px-3 py-1.5 text-center">{c ? <Check className="mx-auto h-3.5 w-3.5 text-success" aria-label={`${l} FY${y} matches`} /> : <span className="text-muted-foreground">·</span>}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ChecksTab({ checks, group, onGroup, actions, hasOtherRecords }: { checks: WorkspaceCheck[]; group: CheckGroup; onGroup: (g: CheckGroup) => void; actions: ChecksActions; hasOtherRecords: boolean }) {
  const counts = useMemo(() => checkCounts(checks), [checks]);
  if (!hasOtherRecords || checks.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground" data-testid="checks-empty">
        No tax returns or other records to compare with yet. Ask the seller for them in their document checklist on the Overview.
      </p>
    );
  }
  const rows = checks.filter((c) => c.group === group);
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">Due-diligence buyers see matches once the checks are on, and each difference once you show it.</p>
      <div className="flex flex-wrap gap-1 rounded-lg border border-border p-1" role="tablist" aria-label="Show">
        {GROUPS.map((g) => (
          <button
            key={g.key}
            type="button"
            role="tab"
            aria-selected={group === g.key}
            onClick={() => onGroup(g.key)}
            className={cn("rounded-md px-2.5 py-1 text-xs", group === g.key ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground")}
          >
            {g.label} ({counts[g.key]})
          </button>
        ))}
      </div>
      {rows.length === 0 ? (
        <p className="px-1 py-4 text-sm text-muted-foreground">Nothing here.</p>
      ) : group === "match" ? (
        <MatchGrid checks={rows} />
      ) : group === "needs_checking" ? (
        <div className="space-y-2">{rows.map((c) => <NeedsCheckingRow key={c.checkKey} c={c} a={actions} />)}</div>
      ) : (
        <div className="space-y-2">{rows.map((c) => <DifferenceRow key={c.checkKey} c={c} a={actions} />)}</div>
      )}
    </div>
  );
}
