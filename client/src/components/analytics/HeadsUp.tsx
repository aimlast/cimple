/**
 * The heads-up lines under the numbers (at most two, only when they apply):
 * a registered source's line first (the data room), then buyer links running
 * out within 7 days, then buyers who haven't opened 3 days after you gave
 * access. Each has "See them" → the Buyers tab showing exactly the buyers
 * the line counted (`?notice=<id>`; the line's number = the rows).
 *
 * On a computer: one line each, the full sentence and "See them".
 * On a phone: ONE row for all of them, at least 44 px tall, where the whole
 * row (or, with two lines, each half of it) is the link — a phone has no
 * hover, so nothing depends on a tooltip, and the tabs stay near the top.
 */
import { Link } from "wouter";
import { ChevronRight, Flag } from "lucide-react";
import { HEADS_UP_MAX, TEASER_HEADS_UP_ID, type HeadsUp as HeadsUpLine } from "@shared/analytics-dashboard";

/** The phone's words when a line has the row to itself (the full sentence shows on a computer). */
export function headsUpShort(h: HeadsUpLine): string {
  const n = h.count;
  if (h.id === "expiring") return `${n} link${n === 1 ? " runs" : "s run"} out this week`;
  if (h.id === "not_opened") return `${n} buyer${n === 1 ? " hasn't" : "s haven't"} opened after 3 days`;
  if (h.id === TEASER_HEADS_UP_ID) return `${n} read the teaser but didn't ask`;
  return h.text;
}

/** The phone's words when two lines share the row ("1 link runs out · 1 not opened"). */
export function headsUpTiny(h: HeadsUpLine): string {
  const n = h.count;
  if (h.id === "expiring") return `${n} link${n === 1 ? " runs" : "s run"} out`;
  if (h.id === "not_opened") return `${n} not opened`;
  if (h.id === TEASER_HEADS_UP_ID) return `${n} teaser, no ask`;
  return h.text;
}

export function HeadsUp({ lines, linkFor }: {
  lines: HeadsUpLine[];
  /** "See them" for a built-in line: the Buyers tab showing exactly its buyers (keeps the page's period and example setting). */
  linkFor?(h: HeadsUpLine): string;
}) {
  const shown = lines.slice(0, HEADS_UP_MAX);
  if (shown.length === 0) return null;
  const hrefOf = (h: HeadsUpLine) => (h.ids && linkFor?.(h)) || h.link;
  const shared = shown.length > 1;
  return (
    <div data-testid="heads-up">
      {/* Phone: one row, every part of it a 44 px link. */}
      <div
        className="flex min-h-11 items-stretch overflow-hidden rounded-md border border-amber-500/30 bg-amber-500/5 text-sm sm:hidden"
        data-testid="heads-up-phone"
      >
        <span className="flex shrink-0 items-center pl-3" aria-hidden>
          <Flag className="h-3.5 w-3.5 text-amber-500" />
        </span>
        {shown.map((h, i) => (
          <Link
            key={h.id}
            href={hrefOf(h)}
            aria-label={h.text}
            className={
              "flex min-h-11 min-w-0 flex-1 items-center gap-1 px-2.5 text-foreground/90 active:bg-amber-500/10 "
              + (i > 0 ? "border-l border-amber-500/25" : "")
            }
            data-testid={`heads-up-phone-${h.id}`}
          >
            <span className="min-w-0 flex-1 truncate">{shared ? headsUpTiny(h) : headsUpShort(h)}</span>
            <ChevronRight className="h-4 w-4 shrink-0 text-teal" />
          </Link>
        ))}
      </div>
      {/* Computer: the full sentence per line, with "See them". */}
      <div className="hidden space-y-1.5 sm:block">
        {shown.map((h) => (
          <div key={h.id} className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm">
            <Flag className="h-3.5 w-3.5 shrink-0 text-amber-500" />
            <p className="min-w-0 flex-1 truncate text-foreground/90" title={h.text}>{h.text}</p>
            <Link href={hrefOf(h)} className="inline-flex shrink-0 items-center gap-0.5 text-xs font-medium text-teal hover:underline" data-testid={`heads-up-${h.id}`}>
              See them
              <ChevronRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        ))}
      </div>
    </div>
  );
}
