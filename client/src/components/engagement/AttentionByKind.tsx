/**
 * "What holds attention" — reading time by kind of content (tables, text,
 * charts, highlight cards, key figures, lists, media), for one page or the
 * whole CIM, as direct-labelled horizontal bars with a one-sentence
 * headline ("Buyers spend twice as long on tables as on text in this CIM").
 * Used by the Document view's side panel and the global Analytics page.
 *
 * Owned by the INTELLIGENCE stream. Base stub: a plain list.
 */
import { formatReadingTime, type KindAttention } from "@shared/analytics-v2";

export function AttentionByKind({ kinds, title }: { kinds: KindAttention[]; title?: string }) {
  if (kinds.length === 0) return null;
  return (
    <div data-testid="attention-by-kind">
      {title && <p className="text-xs font-medium text-muted-foreground mb-2">{title}</p>}
      <ul className="space-y-1 text-sm">
        {kinds.map((k) => (
          <li key={k.group} className="flex justify-between">
            <span>{k.label}</span>
            <span className="text-muted-foreground">{formatReadingTime(k.attentionMs)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
