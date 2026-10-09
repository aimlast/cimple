/**
 * Small pieces of the broker's Data room tab: the KPI strip (§5.1), flag
 * chips (§4.9), the sharing and download chips (§5.3) and the opened line.
 */
import { AlertTriangle, ArrowDownToLine, Check, EyeOff, FileText, Info, Lock, Users } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { RoomItemRow, RoomKpis as Kpis } from "@shared/vdr-api";
import type { VdrFlag } from "@shared/vdr";
import { durationLabel, shortDate } from "@/hooks/useDataRoom";

export type RoomView = "documents" | "buyers" | "todo" | "activity";

export function RoomKpis({ kpis, onGo }: { kpis: Kpis; onGo: (view: RoomView, extra?: Record<string, string>) => void }) {
  const cells: Array<{ key: string; value: string; label: string; sub?: string; go: () => void; wide?: boolean }> = [
    { key: "room", value: String(kpis.inRoom), label: "In the room", sub: `${kpis.shared} shared`, go: () => onGo("documents") },
    { key: "buyers", value: String(kpis.buyersWithAccess), label: "Buyers with access", go: () => onGo("buyers") },
    { key: "opened", value: String(kpis.openedThisWeek.documents), label: "Opened this week", sub: `${kpis.openedThisWeek.documents === 1 ? "document" : "documents"} · ${kpis.openedThisWeek.buyers} ${kpis.openedThisWeek.buyers === 1 ? "buyer" : "buyers"}`, go: () => onGo("activity") },
    { key: "waiting", value: String(kpis.waiting), label: "Waiting on you", go: () => onGo("todo", { todo: "waiting" }) },
    { key: "missing", value: String(kpis.missingRequired), label: "Missing", sub: "required, from the seller's checklist", go: () => onGo("todo", { todo: "checklist" }), wide: true },
  ];
  return (
    // Phones: a compact 3 + 2 grid (labels only), so the documents start on the first screen.
    <div className="grid grid-cols-3 gap-px overflow-hidden rounded-xl border border-border/70 bg-border/70 md:grid-cols-5" data-testid="room-kpis">
      {cells.map((c) => (
        // Top-aligned: a cell without a sub-line lines up with its neighbours (checker r2 R2-4).
        <button key={c.key} onClick={c.go} className={cn("group relative flex flex-col items-stretch justify-start bg-card px-3 py-2.5 text-left transition-colors hover:bg-muted/30 md:px-4 md:py-4", c.wide && "col-span-2 md:col-span-1")} data-testid={`room-kpi-${c.key}`}>
          <p className="text-[10px] font-medium uppercase leading-tight tracking-[0.1em] text-muted-foreground/70 md:text-2xs md:tracking-[0.14em]">{c.label}</p>
          <p className="mt-1.5 font-mono text-xl font-medium leading-none tabular-nums md:mt-2 md:text-2xl">{c.value}</p>
          {c.sub && <p className="mt-1.5 hidden truncate text-xs text-muted-foreground md:block">{c.sub}</p>}
          <div className="absolute bottom-0 left-4 right-4 h-px bg-teal/0 transition-colors group-hover:bg-teal/40" />
        </button>
      ))}
    </div>
  );
}

const FLAG_LABEL: Record<string, string> = {
  scanned: "Scanned",
  staff_records: "Staff or pay records",
  hidden_words: "Hidden words",
  private_matters: "Private matters",
  file_missing: "File missing",
  personal_covered: "Personal numbers covered",
  form_fields: "Form fields",
  comments_removed: "Comments removed",
  private_notes: "Notes only you see",
};

export function flagLabel(key: string): string {
  return FLAG_LABEL[key] ?? key;
}

/** One flag chip: brass when it needs a look, muted once checked or when it's a note. */
export function FlagChip({ flag, checked }: { flag: VdrFlag; checked?: string | null }) {
  const look = flag.look && !checked;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] leading-4",
            look ? "border-teal/40 bg-teal/10 text-teal" : "border-border text-muted-foreground",
          )}
          data-testid={`flag-${flag.key}`}
        >
          {look ? <AlertTriangle className="h-3 w-3" /> : flag.look ? <Check className="h-3 w-3" /> : <Info className="h-3 w-3" />}
          {flagLabel(flag.key)}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-xs leading-relaxed">
        {flag.copy}
        {checked && <span className="mt-1 block text-muted-foreground">Checked by you on {checked}.</span>}
      </TooltipContent>
    </Tooltip>
  );
}

export function ItemFlags({ item, max = 3 }: { item: RoomItemRow; max?: number }) {
  const checkedOn = item.checked ? shortDate(item.checked.at) : null;
  const shown = item.flags.filter((f) => f.key !== "private_notes");
  if (shown.length === 0) return null;
  const list = shown.slice(0, max);
  return (
    <span className="flex flex-wrap gap-1">
      {list.map((f) => <FlagChip key={f.key} flag={f} checked={f.look && !item.unchecked.includes(f.key) ? checkedOn : null} />)}
      {shown.length > max && <span className="text-[11px] text-muted-foreground">+{shown.length - max}</span>}
    </span>
  );
}

export function SharingChip({ item }: { item: RoomItemRow }) {
  const s = item.sharing;
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs", s.shared ? "text-foreground" : "text-muted-foreground")} data-testid="sharing-chip">
      {s.shared ? <Users className="h-3 w-3 text-teal" /> : <EyeOff className="h-3 w-3" />}
      {s.label}
    </span>
  );
}

export function DownloadChip({ item }: { item: RoomItemRow }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      {item.downloadable ? <ArrowDownToLine className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
      {item.downloadLabel}
    </span>
  );
}

export function OpenedLine({ item }: { item: RoomItemRow }) {
  if (!item.opened.buyers) return <span className="text-xs text-muted-foreground">Not opened yet</span>;
  return <span className="text-xs text-muted-foreground">{item.opened.buyers} {item.opened.buyers === 1 ? "buyer" : "buyers"} · {durationLabel(item.opened.activeMs)}</span>;
}

/** What a document is, in a few words ("FY2023 · PDF · 6 pages"). */
export function ItemMeta({ item }: { item: RoomItemRow }) {
  const bits = [item.doc?.periodLabel, item.sizeLabel].filter(Boolean);
  return <span className="text-xs text-muted-foreground">{bits.join(" · ")}</span>;
}

export function DocIcon({ className }: { className?: string }) {
  return <FileText className={cn("h-4 w-4 shrink-0 text-muted-foreground", className)} />;
}
