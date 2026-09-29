/**
 * Small pieces shared by the engagement buyer UIs (Buyers view, Buyer pulse,
 * Buyers tab, buyer profile, call list): the status chip and the one-line
 * "mini document" strip — one block per CIM page, darker where the buyer
 * spent more reading time (the ONE heat scale, heatChrome), hatched where
 * they never got to.
 */
import { useMemo, useState } from "react";
import {
  formatReadingTime,
  READ_LABEL_TEXT,
  viewerPageKey,
  type BuyerStatus,
  type PageStripCell,
} from "@shared/analytics-v2";
import { cn } from "@/lib/utils";
import { heatChrome } from "../heat";
import { PhoneCall } from "lucide-react";

// ── Status chip ──────────────────────────────────────────────────────────

const STATUS_CLS: Record<BuyerStatus, string> = {
  reading_now: "border-success-muted-foreground/40 bg-success-muted text-success-muted-foreground",
  hot: "border-teal/50 bg-teal/15 text-teal",
  interested: "border-success-muted-foreground/30 bg-success-muted text-success-muted-foreground",
  warming: "border-teal/25 bg-teal/[0.06] text-teal/90",
  went_quiet: "border-amber-500/30 bg-amber-500/10 text-amber-500",
  skimmed: "border-border bg-muted/50 text-muted-foreground",
  opened: "border-border bg-muted/50 text-muted-foreground",
  not_opened: "border-dashed border-border text-muted-foreground",
  not_interested: "border-border text-muted-foreground/80",
  lapsed: "border-border text-muted-foreground/80",
};

/** "Hot", "Reading now" (pulsing), "Contacted today" (phone icon)… */
export function StatusChip({ status, label, className }: { status: BuyerStatus; label: string; className?: string }) {
  const contacted = /^Contacted\b/.test(label);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4",
        contacted ? "border-sky-500/30 bg-sky-500/10 text-sky-400" : STATUS_CLS[status],
        className,
      )}
      data-testid={`status-${status}`}
    >
      {status === "reading_now" && (
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success-muted-foreground opacity-60" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success-muted-foreground" />
        </span>
      )}
      {contacted && <PhoneCall className="h-3 w-3" />}
      {label}
    </span>
  );
}

// ── Page strip ───────────────────────────────────────────────────────────

const HATCH = "repeating-linear-gradient(135deg, hsl(var(--muted-foreground) / 0.22) 0 1.5px, transparent 1.5px 4px)";

/** The reading time that counts as "full colour" for a set of strips (their 90th percentile, so one marathon page doesn't wash out the rest). */
export function stripScale(strips: PageStripCell[][]): number {
  const all = strips.flat().map((c) => c.attentionMs).filter((x) => x > 0).sort((a, b) => a - b);
  if (all.length === 0) return 0;
  return all[Math.min(all.length - 1, Math.floor(all.length * 0.9))];
}

/** Colour intensity of one cell (square-root, so short reads still show). */
function level(ms: number, max: number): number {
  return max > 0 && ms > 0 ? Math.sqrt(Math.min(1, ms / max)) : 0;
}

export interface PageStripProps {
  cells: PageStripCell[];
  /** Real page titles, by viewerPageKey (broker side). */
  titles?: Map<string, string>;
  /** Full-colour reading time (shared across strips on one screen). */
  maxMs: number;
  size?: "sm" | "md";
  /** Click a page → e.g. open the Document view there. */
  onOpen?: (cell: PageStripCell) => void;
  /** Show the caption line under the strip (hovered page, else the page read most). */
  caption?: boolean;
  className?: string;
}

export function PageStrip({ cells, titles, maxMs, size = "md", onOpen, caption = true, className }: PageStripProps) {
  const [hover, setHover] = useState<number | null>(null);
  const top = useMemo(() => cells.reduce<PageStripCell | null>((m, c) => (c.attentionMs > (m?.attentionMs ?? 0) ? c : m), null), [cells]);
  if (cells.length === 0) return null;
  const titleOf = (c: PageStripCell) => titles?.get(viewerPageKey(c.pageId, c.part)) ?? (c as PageStripCell & { title?: string }).title ?? null;
  const describe = (c: PageStripCell) => {
    const t = titleOf(c);
    const head = `Page ${c.label}${t ? ` · ${t}` : ""}`;
    if (!c.reached) return `${head} · not reached`;
    return `${head} · ${formatReadingTime(c.attentionMs)}${c.readLabel ? ` · ${READ_LABEL_TEXT[c.readLabel]}` : ""}`;
  };
  const shown = hover != null ? cells[hover] : null;
  return (
    <div className={cn("min-w-0", className)}>
      <div
        className={cn("flex w-full gap-[2px]", size === "sm" ? "h-2" : "h-3")}
        onMouseLeave={() => setHover(null)}
        role="list"
        aria-label="Reading time by page"
      >
        {cells.map((c, i) => {
          const t = level(c.attentionMs, maxMs);
          return (
            <button
              key={`${c.pageId}#${c.part}`}
              type="button"
              role="listitem"
              title={describe(c)}
              aria-label={describe(c)}
              onMouseEnter={() => setHover(i)}
              onFocus={() => setHover(i)}
              onClick={(e) => { e.stopPropagation(); setHover(i); onOpen?.(c); }}
              className={cn(
                "min-w-[3px] flex-1 first:rounded-l-[3px] last:rounded-r-[3px] transition-[filter,outline] outline-offset-1",
                hover === i && "outline outline-1 outline-foreground/60",
                onOpen ? "cursor-pointer" : "cursor-default",
              )}
              style={{ background: !c.reached ? HATCH : t > 0 ? heatChrome(t) : "hsl(var(--muted))" }}
              data-testid="strip-cell"
            />
          );
        })}
      </div>
      {caption && (
        <p className="mt-1 truncate text-2xs text-muted-foreground tabular-nums" aria-live="polite">
          {shown ? describe(shown) : top ? <>Most time on <span className="text-foreground/80">{titleOf(top) ?? `page ${top.label}`}</span> · {formatReadingTime(top.attentionMs)}</> : "No reading time recorded yet"}
        </p>
      )}
    </div>
  );
}

/** A tiny legend for strips: faint → strong brass, hatched = not reached. */
export function StripLegend({ className }: { className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground", className)}>
      <span className="inline-flex items-center gap-1.5">
        Less
        <span className="flex h-2 w-16 overflow-hidden rounded-[2px]">
          {[0.15, 0.35, 0.55, 0.75, 1].map((t) => <span key={t} className="flex-1" style={{ background: heatChrome(t) }} />)}
        </span>
        More reading time
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="h-2 w-3 rounded-[2px]" style={{ background: HATCH }} />
        Not reached
      </span>
    </div>
  );
}

// ── Words ────────────────────────────────────────────────────────────────

/** "just now", "12 min ago", "3 h ago", "yesterday", "4 days ago", "12 Sep". */
export function agoText(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!t) return "";
  const s = Math.max(0, (now - t) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 20 * 3600) return `${Math.round(s / 3600)} h ago`;
  const days = Math.round(s / 86400);
  if (days <= 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

const TYPE_WORDS: Record<string, string> = {
  individual: "Individual",
  strategic: "Strategic",
  financial: "Investor",
  private_equity: "Private equity",
  family_office: "Family office",
  search_fund: "Search fund",
};
export function buyerTypeWord(t: string | null | undefined): string | null {
  if (!t) return null;
  return TYPE_WORDS[t] ?? t.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export function initials(name: string): string {
  const parts = name.replace(/^(dr|mr|mrs|ms)\.?\s+/i, "").trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}
