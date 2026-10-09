/**
 * StatusLine — the one line between the page header and the colour switches:
 * a single sentence on how this page's reading is known (or which version
 * this is), and a "Why?" link that opens every note that applies (heat-map
 * spec §3.4). It replaces the stacked notes the view used to show (old
 * visits, reading on pages this version doesn't have, the blind note).
 *
 * "Why?" is a popover: click, Enter or tap opens it; Esc and an outside
 * click close it. The "Sample reading" chip is NOT here — it sits once in
 * the Engagement tab's view bar (analytics stream).
 */
import { Info } from "lucide-react";
import type { DocumentPage, EngagementDocumentResponse } from "@shared/analytics-v2";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { statusSentence, whyNotes, type StatusContext } from "./viewer-model";

export function StatusLine({
  page, doc, ctx, className,
}: {
  page: DocumentPage | null;
  doc: EngagementDocumentResponse;
  ctx: StatusContext;
  className?: string;
}) {
  const sentence = statusSentence(page, doc, ctx);
  const notes = whyNotes(page, doc, ctx);
  if (!sentence && notes.length === 0) return null;
  return (
    <p className={cn("text-xs leading-snug text-muted-foreground line-clamp-2", className)} data-testid="heat-status">
      {sentence && <span>{sentence} </span>}
      {notes.length > 0 && (
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="inline-flex items-center gap-0.5 rounded-sm font-medium text-teal underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal/60"
              data-testid="heat-status-why"
            >
              {sentence ? "Why?" : (<><Info className="h-3 w-3" aria-hidden /> About this reading</>)}
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-[min(22rem,calc(100vw-2rem))] space-y-3 p-4 text-xs" data-testid="heat-status-notes">
            {notes.map((n) => (
              <div key={n.key} className="space-y-0.5">
                <p className="font-semibold text-foreground">{n.title}</p>
                <p className="leading-relaxed text-muted-foreground">{n.text}</p>
              </div>
            ))}
          </PopoverContent>
        </Popover>
      )}
    </p>
  );
}
