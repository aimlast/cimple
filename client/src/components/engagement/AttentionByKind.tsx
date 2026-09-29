/**
 * "What holds attention" — reading time by kind of content (tables, text,
 * charts, highlight cards, key figures, lists, media), for one page or the
 * whole CIM, as direct-labelled horizontal bars with a one-sentence
 * headline ("Buyers read tables most closely — twice as long as text, for
 * the same amount of content"). Each bar also says how closely that kind
 * was read against the time its content needs (Studied / Read / Glanced /
 * Skipped — the same words as the page labels). Used by the Document view's
 * side panel and the global Analytics page.
 *
 * Owned by the INTELLIGENCE stream.
 */
import { formatReadingTime, READ_LABEL_TEXT, type KindAttention } from "@shared/analytics-v2";
import { kindMixHeadline, readLabel, studyRatio } from "@shared/cim-reading-model";
import { cn } from "@/lib/utils";

/**
 * The bars are sorted and sized by the same measure the headline uses:
 * reading time for the amount of content (reading time ÷ the time a careful
 * read of that content takes), so "charts are read most closely" sits over
 * the longest bar even when there are few charts. The seconds stay beside
 * each bar.
 */
export function AttentionByKind({ kinds, title, className, compact }: { kinds: KindAttention[]; title?: string; className?: string; compact?: boolean }) {
  const rows = kinds
    .filter((k) => k.group !== "other" && (k.attentionMs > 0 || k.expectedMs > 0))
    .map((k) => ({ ...k, closeness: studyRatio(k.attentionMs, k.expectedMs) }))
    .sort((a, b) => b.closeness - a.closeness || b.attentionMs - a.attentionMs);
  if (rows.length === 0) return null;
  const max = Math.max(...rows.map((k) => k.closeness), 0.0001);
  const headline = kindMixHeadline(rows);
  return (
    <div className={cn("min-w-0", className)} data-testid="attention-by-kind">
      {title && <p className="mb-1 text-xs font-medium text-muted-foreground">{title}</p>}
      {headline && <p className={cn("mb-3 text-foreground/90", compact ? "text-xs" : "text-sm")}>{headline}</p>}
      <ul className="space-y-2">
        {rows.map((k) => {
          const label = readLabel(k.attentionMs, k.expectedMs);
          return (
            <li key={k.group} className="grid grid-cols-[minmax(84px,120px)_1fr_auto] items-center gap-3 text-xs">
              <span className="truncate text-foreground/90">{k.label}</span>
              <span className="h-2.5 overflow-hidden rounded-full bg-muted">
                <span className="block h-full rounded-full bg-teal/75" style={{ width: `${Math.max(2, (k.closeness / max) * 100)}%` }} />
              </span>
              <span className="whitespace-nowrap text-right tabular-nums text-muted-foreground">
                <span className="text-foreground">{formatReadingTime(k.attentionMs)}</span>
                {label && k.expectedMs > 0 && <span className="ml-1.5 hidden sm:inline">· {READ_LABEL_TEXT[label]}</span>}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-2xs text-muted-foreground">Bar length: reading time for the amount of that content, so a few charts compare fairly with many paragraphs.</p>
    </div>
  );
}
