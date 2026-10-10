/**
 * Small pieces the "Add-backs in the books" screens share: status pills in
 * words (colour only as a second signal), the proof chip, money, dates and
 * "2 h ago". Obsidian & Brass tokens only.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { formatCents } from "@shared/gl-copy";

export type GlTone = "good" | "close" | "warn" | "muted" | "bad" | "brass";

const TONE: Record<GlTone, string> = {
  good: "bg-success/10 text-success",
  close: "bg-teal/10 text-teal",
  brass: "bg-teal/10 text-teal",
  warn: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  bad: "bg-red-500/10 text-red-600 dark:text-red-400",
  muted: "bg-muted text-muted-foreground",
};

export function Pill({ tone = "muted", children, className, testId }: { tone?: GlTone; children: ReactNode; className?: string; testId?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-medium whitespace-nowrap", TONE[tone], className)} data-testid={testId}>
      {children}
    </span>
  );
}

/** A year status → its tone. */
export function statusTone(status: string | undefined | null): GlTone {
  switch (status) {
    case "found":
    case "document":
      return "good";
    case "close":
      return "close";
    case "short":
    case "over":
      return "warn";
    default:
      return "muted";
  }
}

/** Whole dollars from cents: "$28,000". */
export const dollars = (cents: number) => formatCents(Math.round(cents / 100) * 100, { whole: true });
/** Dollars and cents: "$1,150.00". */
export const money = (cents: number) => formatCents(cents);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Oct 9" (this year) / "Oct 9, 2025". */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const thisYear = d.getFullYear() === new Date().getFullYear();
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${thisYear ? "" : `, ${d.getFullYear()}`}`;
}
/** A ledger date "2024-03-01" → "Mar 1, 2024" (no time zone shift). */
export function ledgerDate(iso: string | null | undefined): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return iso ?? "";
  return `${MONTHS[+iso.slice(5, 7) - 1]} ${+iso.slice(8, 10)}, ${iso.slice(0, 4)}`;
}
/** "2 h ago", "3 days ago". */
export function ago(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

/** One KPI cell (a button when it opens something). */
export function KpiCell({ label, children, sub, onClick, tone = "muted", testId, className }: {
  label: string; children: ReactNode; sub?: ReactNode; onClick?: () => void; tone?: GlTone; testId?: string; className?: string;
}) {
  const body = (
    <>
      <p className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className={cn("mt-1 text-sm font-medium leading-snug break-words", tone === "good" && "text-success", tone === "warn" && "text-amber-600 dark:text-amber-400", tone === "bad" && "text-red-600 dark:text-red-400")}>{children}</div>
      {sub ? <div className="mt-0.5 text-xs text-muted-foreground leading-snug break-words">{sub}</div> : null}
    </>
  );
  const cls = cn("min-w-0 rounded-lg border border-border bg-card px-3 py-2.5 text-left", className);
  return onClick ? (
    <button type="button" onClick={onClick} className={cn(cls, "hover:border-teal/40 hover:bg-muted/30 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal/40")} data-testid={testId}>
      {body}
    </button>
  ) : (
    <div className={cls} data-testid={testId}>{body}</div>
  );
}
