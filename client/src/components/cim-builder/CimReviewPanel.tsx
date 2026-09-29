/**
 * CimReviewPanel — what the broker must look at before the CIM goes to
 * buyers, in one place (the CIM tab, and a compact strip in the builder):
 *   - a regenerated CIM held from buyers until it is published again;
 *   - the last generation's notes (sections the AI couldn't write, figures
 *     it couldn't trace, things it took out or rebuilt) — each linked to its
 *     section, dismissible once read;
 *   - facts changed since the CIM was written, and the sections that still
 *     show the old value.
 * The notes used to reach only a toast that called every one "fell back to
 * a placeholder" — and a broker who wasn't watching saw nothing.
 */
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronUp, EyeOff, History, Info, ShieldAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { classifyGenerationWarnings, heldReplacedText, type CimWarningKind } from "@shared/cim-generation-warnings";
import type { BuilderSection, CimReview } from "./api";

const KIND_LABEL: Record<CimWarningKind, string> = {
  placeholder: "Couldn't be written",
  hidden: "Hidden from buyers",
  figures: "Check figures",
  removed: "Taken out",
  review: "Review",
};

const dismissKey = (dealId: string, at: string | null) => `cim-review-dismissed:${dealId}:${at ?? ""}`;

function readDismissed(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

interface Props {
  dealId: string;
  review: CimReview | undefined;
  sections: BuilderSection[];
  /** Open a section (the builder selects it; the CIM tab opens the builder on it). */
  onOpenSection?: (id: string) => void;
  /** The builder's strip: one line, expands on demand. */
  compact?: boolean;
  className?: string;
}

export function CimReviewPanel({ dealId, review, sections, onOpenSection, compact = false, className }: Props) {
  const warnings = useMemo(() => classifyGenerationWarnings(review?.warnings), [review?.warnings]);
  const key = dismissKey(dealId, review?.warningsAt ?? null);
  const [dismissed, setDismissed] = useState(() => readDismissed(key));
  useEffect(() => setDismissed(readDismissed(key)), [key]);
  const [open, setOpen] = useState(!compact);
  const byTitle = useMemo(() => new Map(sections.map((s) => [s.sectionTitle.trim().toLowerCase(), s])), [sections]);
  const stale = sections.filter((s) => (s.factsChanged?.length ?? 0) > 0);

  if (!review) return null;
  const hold = review.heldFromBuyers;
  const facts = review.facts;
  const showNotes = warnings.length > 0 && !dismissed;
  if (!hold && !showNotes && !facts && review.placeholders === 0) return null;

  const dismiss = () => {
    setDismissed(true);
    try { window.localStorage.setItem(key, "1"); } catch { /* per-viewer convenience only */ }
  };
  const sectionFor = (title: string | null) => (title ? byTitle.get(title.trim().toLowerCase()) ?? null : null);
  const counts = [
    hold ? "held from buyers until you publish" : null,
    review.placeholders > 0 ? `${review.placeholders} section${review.placeholders === 1 ? "" : "s"} couldn't be written` : null,
    showNotes ? `${warnings.length} note${warnings.length === 1 ? "" : "s"} from the last generation` : null,
    facts ? `facts changed since it was written${facts.sections ? ` (${facts.sections} section${facts.sections === 1 ? "" : "s"})` : ""}` : null,
  ].filter(Boolean) as string[];

  return (
    <div className={cn("rounded-lg border border-amber-500/30 bg-amber-500/5 text-sm", compact ? "px-3 py-2" : "p-4 space-y-3", className)} data-testid="cim-review-panel">
      {compact && (
        <button type="button" className="flex w-full items-center gap-2 text-left text-xs" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
          <span className="flex-1 min-w-0 truncate"><span className="font-medium">Before publishing:</span> {counts.join(" · ")}</span>
          {open ? <ChevronUp className="h-3.5 w-3.5 shrink-0" /> : <ChevronDown className="h-3.5 w-3.5 shrink-0" />}
        </button>
      )}

      {open && (
        <div className={cn("space-y-3", compact && "mt-2 max-h-[40vh] overflow-y-auto pr-1")}>
          {hold && (
            <div className="flex gap-2.5" data-testid="cim-review-hold">
              <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5 text-amber-500" />
              <div className="min-w-0 space-y-0.5">
                <p className="font-medium">Buyers can't see this CIM until you publish it again</p>
                <p className="text-xs text-muted-foreground">
                  {heldReplacedText(hold)}
                  They see a notice that the document is being updated. Review the sections, record the approvals on the Overview and publish when it's right.
                  {hold.ddCleared ? " The due-diligence version was cleared — generate it again for due-diligence buyers." : ""}
                </p>
              </div>
            </div>
          )}

          {review.placeholders > 0 && (
            <div className="flex gap-2.5">
              <EyeOff className="h-4 w-4 shrink-0 mt-0.5 text-red-400" />
              <div className="min-w-0 space-y-1">
                <p className="font-medium">{review.placeholders === 1 ? "One section" : `${review.placeholders} sections`} couldn't be written by the AI</p>
                <p className="text-xs text-muted-foreground">Each is hidden and never shown to buyers. Regenerate it, write it yourself or delete it — publishing waits until then.</p>
                <div className="flex flex-wrap gap-1.5">
                  {sections.filter((s) => s.placeholder).map((s) => (
                    <SectionChip key={s.id} title={s.sectionTitle} onClick={onOpenSection ? () => onOpenSection(s.id) : undefined} />
                  ))}
                </div>
              </div>
            </div>
          )}

          {facts && (
            <div className="flex gap-2.5" data-testid="cim-review-facts">
              <History className="h-4 w-4 shrink-0 mt-0.5 text-blue-400" />
              <div className="min-w-0 space-y-1">
                <p className="font-medium">Facts changed since this CIM was written</p>
                {facts.changes.length > 0 && (
                  <ul className="text-xs text-muted-foreground space-y-0.5">
                    {facts.changes.map((c, i) => (
                      <li key={i} className="break-words">
                        <span className="text-foreground/80">{c.label}:</span>{" "}
                        {c.before === null && c.after === null ? "changed" : `${c.before ?? "—"} → ${c.after ?? "removed"}`}
                      </li>
                    ))}
                    {facts.more > 0 && <li>and {facts.more} more</li>}
                  </ul>
                )}
                {facts.notesChanged && (
                  <p className="text-xs text-muted-foreground">Your private notes or the items held back from the CIM changed — regenerate or check the CIM follows them.</p>
                )}
                {stale.length > 0 ? (
                  <>
                    <p className="text-xs text-muted-foreground">These sections still show an old value — regenerate or edit them:</p>
                    <div className="flex flex-wrap gap-1.5">
                      {stale.map((s) => (
                        <SectionChip key={s.id} title={s.sectionTitle} hint={s.factsChanged!.join(", ")} onClick={onOpenSection ? () => onOpenSection(s.id) : undefined} />
                      ))}
                    </div>
                  </>
                ) : facts.changes.length > 0 ? (
                  <p className="text-xs text-muted-foreground">No section shows the old values. The asking price on the cover and key numbers always shows your listed price.</p>
                ) : null}
              </div>
            </div>
          )}

          {showNotes && (
            <div className="flex gap-2.5" data-testid="cim-review-notes">
              <Info className="h-4 w-4 shrink-0 mt-0.5 text-amber-500" />
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="flex items-start justify-between gap-2">
                  <p className="font-medium">Notes from the last generation</p>
                  <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[11px] text-muted-foreground gap-1 -mt-0.5 shrink-0" onClick={dismiss} title="Hide these notes (they stay on each section's figure check)">
                    <X className="h-3 w-3" /> Dismiss
                  </Button>
                </div>
                <ul className="space-y-1.5">
                  {warnings.map((w, i) => {
                    const s = sectionFor(w.sectionTitle);
                    return (
                      <li key={i} className="text-xs text-muted-foreground break-words">
                        <span className={cn("mr-1.5 inline-block rounded px-1.5 py-px text-[10px] font-medium", w.kind === "placeholder" || w.kind === "hidden" ? "bg-red-500/10 text-red-400" : "bg-amber-500/10 text-amber-600 dark:text-amber-400")}>
                          {KIND_LABEL[w.kind]}
                        </span>
                        {w.text}
                        {s && onOpenSection && (
                          <button type="button" className="ml-1.5 text-teal hover:underline" onClick={() => onOpenSection(s.id)}>Open section</button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SectionChip({ title, hint, onClick }: { title: string; hint?: string; onClick?: () => void }) {
  const body = (
    <>
      <span className="truncate max-w-[220px]">{title}</span>
      {hint && <span className="text-muted-foreground truncate max-w-[160px]">· {hint}</span>}
    </>
  );
  return onClick ? (
    <button type="button" onClick={onClick} className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-0.5 text-[11px] hover:border-teal/50 hover:text-teal">
      {body}
    </button>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-0.5 text-[11px]">{body}</span>
  );
}
