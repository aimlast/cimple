/**
 * The period line under the numbers, only when it applies:
 *   automatic range → all time:  "Nothing happened in the last 30 days, so this
 *                                 shows all time. Last activity: 23 Sept, Gurdeep
 *                                 Randhawa read Pacific Coast Logistics." [Last 30 days]
 *   an explicit empty period:    "Nothing in the last 7 days. Last activity: 23 Sept." [Show all time]
 * One line on a phone (ellipsis), the button stays visible.
 */
import { Info } from "lucide-react";
import { dayMonth, rangeLabel, type DashboardRange } from "@shared/analytics-dashboard";
import { Button } from "@/components/ui/button";

export interface RangeNoteProps {
  range: DashboardRange;
  rangeAuto: boolean;
  /** Whether anything happened in the period shown (from the period numbers). */
  anyInRange: boolean;
  lastActivity: { at: string; text: string } | null;
  onPick(range: DashboardRange): void;
}

/** The note's words and button, or null when there is nothing to say (exported for tests). */
export function rangeNoteContent(p: Omit<RangeNoteProps, "onPick">): { text: string; short: string; button: string; pick: DashboardRange } | null {
  const last = p.lastActivity;
  if (p.rangeAuto && p.range === "all") {
    if (!last) return null;
    return {
      text: `Nothing happened in the last 30 days, so this shows all time. Last activity: ${dayMonth(last.at)}, ${last.text}.`,
      short: "No activity in 30 days: showing all time",
      button: "Last 30 days",
      pick: "30d",
    };
  }
  if (!p.rangeAuto && p.range !== "all" && !p.anyInRange) {
    const period = rangeLabel(p.range).replace(/^Last /, "last ");
    return {
      text: last ? `Nothing in the ${period}. Last activity: ${dayMonth(last.at)}.` : `Nothing in the ${period}.`,
      short: last ? `Nothing in the ${period} · last ${dayMonth(last.at)}` : `Nothing in the ${period}`,
      button: "Show all time",
      pick: "all",
    };
  }
  return null;
}

export function RangeNote(props: RangeNoteProps) {
  const c = rangeNoteContent(props);
  if (!c) return null;
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground sm:text-sm" data-testid="range-note">
      <Info className="h-3.5 w-3.5 shrink-0 text-teal/80" />
      <p className="min-w-0 flex-1 truncate" title={c.text}>
        <span className="sm:hidden">{c.short}</span>
        <span className="hidden sm:inline">{c.text}</span>
      </p>
      <Button size="sm" variant="ghost" className="h-7 shrink-0 px-2 text-xs text-teal hover:text-teal" onClick={() => props.onPick(c.pick)} data-testid="range-note-button">
        {c.button}
      </Button>
    </div>
  );
}
