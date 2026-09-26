/**
 * Dates on the Information tab's sources and facts.
 *
 * A source's own date is often date-only ("2026-09-09" — the day of the call,
 * the lease's signing date). `new Date("2026-09-09")` reads that as midnight
 * UTC, which is the previous evening anywhere in the Americas, so every such
 * date showed one day early ("Sep 8"). Date-only values are read as that
 * calendar day in the viewer's own time zone; full timestamps (when a fact
 * was recorded) still convert as before.
 *
 * Plain module (no React) so it can be unit-tested directly.
 */

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A source or fact date as a Date: "2026-09-09" → Sep 9 local; timestamps as-is. Null when unreadable. */
export function parseSourceDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const trimmed = value.trim();
  const m = trimmed.match(DATE_ONLY);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(trimmed);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Sort key (ms) for a source date; 0 when there is none. */
export function sourceDateValue(value: string | null | undefined): number {
  return parseSourceDate(value)?.getTime() ?? 0;
}

/** "today", "yesterday", "Sep 9", or "Sep 9, 2025" (other years, or withYear). */
export function formatShortDate(value: string | null | undefined, withYear = false, now: Date = new Date()): string | null {
  const d = parseSourceDate(value);
  if (!d) return null;
  if (d.toDateString() === now.toDateString()) return "today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "yesterday";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(withYear || d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
}
