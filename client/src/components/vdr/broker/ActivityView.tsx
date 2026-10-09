/**
 * Activity (vdr spec §5.9), segmented: By buyer · By document · Full log
 * (?activity=buyers|documents|log, ?buyer=<accessId>). Who opened what, for
 * how long, which pages, downloads; each person on a buyer's team; the full
 * log with filters, CSV export and "Find who a page belongs to" (the trace
 * code printed on every page a buyer sees). The broker's own previews never
 * count.
 */
import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Download, Eye, Fingerprint, ListFilter, Loader2, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { ActivityBuyerRow, ActivityDocRow, BrokerRoomPayload } from "@shared/vdr-api";
import { activityQuery, durationLabel, roomBase, shortDate, useActivityReport, type ActivityParams } from "@/hooks/useDataRoom";
import { PanelError } from "@/components/deal/PanelError";

export type ActivitySegment = "buyers" | "documents" | "log";
const SEGMENTS: Array<{ key: ActivitySegment; label: string }> = [
  { key: "buyers", label: "By buyer" },
  { key: "documents", label: "By document" },
  { key: "log", label: "Full log" },
];

export function ActivityView({ dealId, data, segment, onSegment, buyer, onBuyer, onOpenItem, onViewAs }: {
  dealId: string;
  data: BrokerRoomPayload;
  segment: ActivitySegment;
  onSegment: (s: ActivitySegment) => void;
  buyer: string | null;
  onBuyer: (accessId: string | null) => void;
  onOpenItem: (id: string) => void;
  onViewAs: (accessId: string) => void;
}) {
  return (
    <div className="space-y-4" data-testid="activity-view">
      <div className="flex max-w-full overflow-x-auto rounded-md border border-border p-0.5 text-xs sm:inline-flex" role="tablist" aria-label="Activity">
        {SEGMENTS.map((s) => (
          <button key={s.key} role="tab" aria-selected={segment === s.key} onClick={() => onSegment(s.key)} className={cn("shrink-0 rounded-[5px] px-3 py-1.5", segment === s.key ? "bg-teal/15 text-teal" : "text-muted-foreground hover:text-foreground")} data-testid={`activity-seg-${s.key}`}>
            {s.label}
          </button>
        ))}
      </div>
      {segment === "buyers" && <ByBuyer dealId={dealId} onOpenItem={onOpenItem} onViewAs={onViewAs} onLog={(id) => { onBuyer(id); onSegment("log"); }} />}
      {segment === "documents" && <ByDocument dealId={dealId} onOpenItem={onOpenItem} />}
      {segment === "log" && <Log dealId={dealId} buyer={buyer} onBuyer={onBuyer} onOpenItem={onOpenItem} />}
    </div>
  );
}

function Empty() {
  return <p className="rounded-lg border border-dashed border-border px-6 py-12 text-center text-sm text-muted-foreground" data-testid="activity-empty">Nothing yet. Activity appears here as soon as a buyer opens the data room.</p>;
}

function Loading() {
  return <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}</div>;
}

function dateTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return `${shortDate(iso)}, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function pageList(pages: number[]): string {
  if (pages.length === 0) return "";
  const ps = pages.slice().sort((a, b) => a - b);
  const runs: string[] = [];
  let start = ps[0];
  let prev = ps[0];
  for (const p of [...ps.slice(1), Infinity]) {
    if (p === prev + 1) { prev = p; continue; }
    runs.push(start === prev ? `${start}` : `${start}–${prev}`);
    start = p;
    prev = p;
  }
  return `${ps.length === 1 ? "page" : "pages"} ${runs.slice(0, 4).join(", ")}${runs.length > 4 ? "…" : ""}`;
}

const ROLE: Record<string, string> = { principal: "the buyer", accountant: "accountant", lawyer: "lawyer", lender: "lender", adviser: "adviser", colleague: "colleague" };

function ByBuyer({ dealId, onOpenItem, onViewAs, onLog }: { dealId: string; onOpenItem: (id: string) => void; onViewAs: (accessId: string) => void; onLog: (accessId: string) => void }) {
  const q = useActivityReport(dealId, { view: "buyers" });
  const [open, setOpen] = useState<string | null>(null);
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <PanelError what="the activity" onRetry={() => q.refetch()} />;
  const rows = q.data.buyers;
  if (rows.length === 0) return <Empty />;
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card" data-testid="activity-buyers">
      {rows.map((b) => <BuyerRow key={b.key} b={b} open={open === b.key} onToggle={() => setOpen(open === b.key ? null : b.key)} onOpenItem={onOpenItem} onViewAs={onViewAs} onLog={onLog} />)}
    </div>
  );
}

function BuyerRow({ b, open, onToggle, onOpenItem, onViewAs, onLog }: { b: ActivityBuyerRow; open: boolean; onToggle: () => void; onOpenItem: (id: string) => void; onViewAs: (accessId: string) => void; onLog: (accessId: string) => void }) {
  return (
    <div className="border-b border-border last:border-0">
      <button onClick={onToggle} className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-muted/30" aria-expanded={open}>
        {open ? <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-col gap-0.5 lg:flex-row lg:items-center lg:gap-4">
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{b.label}</span>
            <span className="text-xs text-muted-foreground">opened {b.openedDocs} of {b.canSee} {b.canSee === 1 ? "document" : "documents"} · {durationLabel(b.activeMs)}{b.downloads ? ` · ${b.downloads} ${b.downloads === 1 ? "download" : "downloads"}` : ""}</span>
            <span className="text-xs text-muted-foreground">{b.lastAt ? `last visit ${dateTime(b.lastAt)}` : "no visit yet"}</span>
          </div>
          {b.top.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {b.top.map((t) => <span key={t.itemId} className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">{t.number} {t.title.length > 34 ? `${t.title.slice(0, 33)}…` : t.title} · {durationLabel(t.activeMs)}</span>)}
            </div>
          )}
        </div>
      </button>
      {open && (
        <div className="space-y-3 border-t border-border bg-muted/10 px-4 py-3 pl-11 text-sm">
          {b.people.length > 0 && (
            <p className="text-xs text-muted-foreground">{b.people.map((p) => `${p.name} (${ROLE[p.role] ?? p.role}) ${durationLabel(p.activeMs)}`).join(" · ")}</p>
          )}
          {b.newNotOpened > 0 && <p className="text-xs text-teal">New for them, not opened yet: {b.newNotOpened}</p>}
          {b.documents.length === 0 ? (
            <p className="text-xs text-muted-foreground">They haven't opened a document yet.</p>
          ) : (
            <div className="space-y-1.5">
              {b.documents.map((d) => (
                <div key={d.itemId} className="flex flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-3">
                  <button onClick={() => onOpenItem(d.itemId)} className="min-w-0 flex-1 truncate text-left text-sm hover:underline"><span className="mr-1.5 font-mono text-[11px] text-muted-foreground">{d.number}</span>{d.title}</button>
                  <span className="text-xs text-muted-foreground">{durationLabel(d.activeMs)} · {d.opens} {d.opens === 1 ? "open" : "opens"}{d.pages.length ? ` · ${pageList(d.pages)}` : ""}{d.downloads ? " · downloaded" : ""}{d.fromCim ? " · from the DD CIM" : ""}</span>
                </div>
              ))}
            </div>
          )}
          {b.accessId && (
            <div className="flex flex-wrap gap-2 pt-1">
              <Button size="sm" variant="outline" onClick={() => onViewAs(b.accessId!)}><Eye className="mr-1.5 h-3.5 w-3.5" /> View as this buyer</Button>
              <Button size="sm" variant="ghost" onClick={() => onLog(b.accessId!)}><ListFilter className="mr-1.5 h-3.5 w-3.5" /> Their full log</Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PageStrip({ d }: { d: ActivityDocRow }) {
  if (d.pageCount <= 1) return null;
  const max = Math.max(1, ...Object.values(d.pages));
  return (
    <div className="mt-1.5 flex flex-wrap gap-0.5" data-testid="activity-page-strip">
      {Array.from({ length: Math.min(d.pageCount, 120) }, (_, i) => {
        const ms = d.pages[String(i + 1)] ?? 0;
        return <span key={i} title={`Page ${i + 1} · ${ms ? durationLabel(ms) : "not read"}`} className="h-4 w-2.5 rounded-[2px] border border-border" style={{ background: ms ? `hsl(var(--teal) / ${0.15 + 0.85 * (ms / max)})` : undefined }} />;
      })}
    </div>
  );
}

function ByDocument({ dealId, onOpenItem }: { dealId: string; onOpenItem: (id: string) => void }) {
  const q = useActivityReport(dealId, { view: "documents" });
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <PanelError what="the activity" onRetry={() => q.refetch()} />;
  const rows = q.data.documents;
  if (rows.length === 0 || rows.every((d) => d.readers === 0)) return <Empty />;
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card" data-testid="activity-documents">
      {rows.map((d) => (
        <button key={d.itemId} onClick={() => onOpenItem(d.itemId)} className="block w-full border-b border-border px-4 py-3 text-left last:border-0 hover:bg-muted/30">
          <div className="flex flex-col gap-0.5 lg:flex-row lg:items-center lg:gap-4">
            <span className="min-w-0 flex-1 truncate text-sm"><span className="mr-1.5 font-mono text-[11px] text-muted-foreground">{d.number}</span>{d.title}</span>
            <span className="text-xs text-muted-foreground">{d.readers ? `opened by ${d.readers} of ${d.canSee} ${d.canSee === 1 ? "buyer" : "buyers"} who can see it · ${durationLabel(d.activeMs)} in total` : d.canSee ? `${d.canSee} ${d.canSee === 1 ? "buyer" : "buyers"} can see it · not opened yet` : "Not shared with anyone who has the room"}{d.downloads ? ` · ${d.downloads} ${d.downloads === 1 ? "download" : "downloads"}` : ""}</span>
          </div>
          <PageStrip d={d} />
        </button>
      ))}
    </div>
  );
}

const ALL = "__all";

function Log({ dealId, buyer, onBuyer, onOpenItem }: { dealId: string; buyer: string | null; onBuyer: (accessId: string | null) => void; onOpenItem: (id: string) => void }) {
  const [person, setPerson] = useState<string | null>(null);
  const [item, setItem] = useState<string | null>(null);
  const [action, setAction] = useState<string | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [traceInput, setTraceInput] = useState("");
  const [trace, setTrace] = useState<string | null>(null);
  useEffect(() => { setPerson(null); }, [buyer]);
  const params: ActivityParams = { view: "log", buyer, person, item, action, from: from || null, to: to || null, trace };
  const q = useActivityReport(dealId, params);
  const filters = q.data?.filters;
  const csv = `${roomBase(dealId)}/activity.csv?${activityQuery({ buyer, person, item, action, from: from || null, to: to || null })}`;
  const anyFilter = !!(buyer || person || item || action || from || to);
  return (
    <div className="space-y-3">
      <form
        className="flex flex-col gap-2 rounded-lg border border-border bg-card px-3 py-3 sm:flex-row sm:items-center"
        onSubmit={(e) => { e.preventDefault(); const t = traceInput.trim().toUpperCase(); setTrace(t || null); }}
      >
        <Fingerprint className="hidden h-4 w-4 shrink-0 text-muted-foreground sm:block" />
        <label className="text-sm font-medium sm:w-56" htmlFor="vdr-trace">Find who a page belongs to</label>
        <Input id="vdr-trace" value={traceInput} onChange={(e) => setTraceInput(e.target.value.slice(0, 12))} placeholder="The 6-letter code on a page, e.g. 7F3K2Q" className="font-mono sm:max-w-[260px]" data-testid="trace-input" />
        <Button type="submit" size="sm" variant="outline"><Search className="mr-1.5 h-3.5 w-3.5" /> Find</Button>
        {trace && <Button type="button" size="sm" variant="ghost" onClick={() => { setTrace(null); setTraceInput(""); }}><X className="mr-1 h-3.5 w-3.5" /> Clear</Button>}
      </form>
      {q.data?.trace && (
        <div className="rounded-lg border border-teal/30 bg-teal/5 px-4 py-3 text-sm" data-testid="trace-result">
          {q.data.trace.hits.length === 0 ? (
            <p>No page in this data room carries the code {q.data.trace.query.toUpperCase()}. Check the letters (the code uses A–Z and 2–7).</p>
          ) : q.data.trace.hits.map((h, i) => (
            <p key={i}><span className="font-mono">{h.trace}</span> was shown to <span className="font-medium">{h.person ? `${h.person}, for ${h.buyerLabel}` : h.buyerLabel}</span> ({h.email}) on {dateTime(h.at)}, reading <button className="underline underline-offset-2" onClick={() => onOpenItem(h.itemId)}>{h.number} {h.title}</button>.</p>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <FilterSelect label="All buyers" value={buyer} options={filters?.buyers.map((b) => ({ value: b.key, label: b.label })) ?? []} onChange={onBuyer} />
        <FilterSelect label="Everyone on their team" value={person} options={filters?.people.map((p) => ({ value: p.id, label: p.label })) ?? []} onChange={setPerson} />
        <FilterSelect label="All documents" value={item} options={filters?.items.map((p) => ({ value: p.id, label: p.label })) ?? []} onChange={setItem} />
        <FilterSelect label="Everything" value={action} options={filters?.actions.map((p) => ({ value: p.key, label: p.label })) ?? []} onChange={setAction} />
        <label className="flex items-center gap-1 text-xs text-muted-foreground">From <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="h-8 w-[140px]" /></label>
        <label className="flex items-center gap-1 text-xs text-muted-foreground">To <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="h-8 w-[140px]" /></label>
        {anyFilter && <Button size="sm" variant="ghost" onClick={() => { onBuyer(null); setPerson(null); setItem(null); setAction(null); setFrom(""); setTo(""); }}>Clear filters</Button>}
        <Button asChild size="sm" variant="outline" className="ml-auto"><a href={csv} data-testid="activity-csv"><Download className="mr-1.5 h-3.5 w-3.5" /> Export CSV</a></Button>
      </div>

      {q.isLoading ? <Loading /> : q.error || !q.data ? <PanelError what="the activity log" onRetry={() => q.refetch()} /> : q.data.log.length === 0 ? (
        anyFilter ? <p className="rounded-lg border border-dashed border-border px-6 py-10 text-center text-sm text-muted-foreground">Nothing matches these filters.</p> : <Empty />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card" data-testid="activity-log">
          {q.data.log.map((r) => (
            <div key={r.id} className={cn("border-b border-border px-4 py-2 text-sm last:border-0", r.actorKind === "buyer" || r.actorKind === "team" ? "" : "text-muted-foreground")}>
              {r.itemId ? <button className="text-left hover:underline" onClick={() => onOpenItem(r.itemId!)}>{r.text}</button> : r.text}
            </div>
          ))}
          {q.data.logTotal > q.data.log.length && <p className="px-4 py-2 text-center text-xs text-muted-foreground">Showing the newest {q.data.log.length} of {q.data.logTotal}. Export the CSV for everything.</p>}
        </div>
      )}
      {q.isFetching && !q.isLoading && <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> Updating…</p>}
    </div>
  );
}

function FilterSelect({ label, value, options, onChange }: { label: string; value: string | null; options: Array<{ value: string; label: string }>; onChange: (v: string | null) => void }) {
  return (
    <Select value={value ?? ALL} onValueChange={(v) => onChange(v === ALL ? null : v)}>
      <SelectTrigger className="h-8 w-auto min-w-[140px] max-w-[220px] text-xs"><SelectValue placeholder={label} /></SelectTrigger>
      <SelectContent className="max-h-72">
        <SelectItem value={ALL} className="text-xs">{label}</SelectItem>
        {options.map((o) => <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}
