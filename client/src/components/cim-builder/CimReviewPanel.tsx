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
import { AlertTriangle, ChevronDown, ChevronUp, EyeOff, History, Info, Lock, ShieldAlert, X } from "lucide-react";
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

/** The last generation's notes were dismissed on this browser (the CIM tab's count leaves them out). */
export function notesDismissed(dealId: string, at: string | null | undefined): boolean {
  return readDismissed(dismissKey(dealId, at ?? null));
}

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
  /**
   * The CIM tab's "Needs attention": full-width rows instead of one card —
   * the publish hold, then the generation notes grouped by kind (each a
   * collapsible row with its count and a one-line summary), then private
   * staff matters. Facts changed are drawn apart (CimFactsChanged), last.
   */
  grouped?: boolean;
  /** Grouped: "Review and publish" on the publish-update row. */
  onReviewPublish?: () => void;
  /** Grouped: lines under the publish-update row (INTEGRATION §2.8 publishNotes). */
  publishNotes?: React.ReactNode[];
  /** The notes were dismissed (the CIM tab recounts). */
  onNotesDismissed?: () => void;
  className?: string;
}

export function CimReviewPanel({ dealId, review, sections, onOpenSection, compact = false, grouped = false, onReviewPublish, publishNotes, onNotesDismissed, className }: Props) {
  const warnings = useMemo(() => classifyGenerationWarnings(review?.warnings), [review?.warnings]);
  const key = dismissKey(dealId, review?.warningsAt ?? null);
  const [dismissed, setDismissed] = useState(() => readDismissed(key));
  useEffect(() => setDismissed(readDismissed(key)), [key]);
  const [open, setOpen] = useState(!compact);
  const byTitle = useMemo(() => new Map(sections.map((s) => [s.sectionTitle.trim().toLowerCase(), s])), [sections]);
  const stale = sections.filter((s) => (s.factsChanged?.length ?? 0) > 0);
  const privateStaff = sections.filter((s) => (s.privateStaff?.length ?? 0) > 0);

  if (!review) return null;
  const hold = review.heldFromBuyers;
  const facts = review.facts;
  const showNotes = warnings.length > 0 && !dismissed;
  const servedPrivate = review.privateStaffServed ?? [];
  if (!hold && !showNotes && !facts && review.placeholders === 0 && privateStaff.length === 0 && servedPrivate.length === 0) return null;

  const dismiss = () => {
    setDismissed(true);
    try { window.localStorage.setItem(key, "1"); } catch { /* per-viewer convenience only */ }
    onNotesDismissed?.();
  };
  const sectionFor = (title: string | null) => (title ? byTitle.get(title.trim().toLowerCase()) ?? null : null);

  if (grouped) {
    return (
      <GroupedReview
        review={review}
        sections={sections}
        warnings={showNotes ? warnings : []}
        privateStaff={privateStaff}
        servedPrivate={servedPrivate}
        sectionFor={sectionFor}
        onOpenSection={onOpenSection}
        onDismissNotes={showNotes && warnings.length > 0 ? dismiss : undefined}
        onReviewPublish={onReviewPublish}
        publishNotes={publishNotes}
        className={className}
      />
    );
  }
  const counts = [
    hold ? (hold.servingPublished ? "buyers see the previous version until you publish" : "held from buyers until you publish") : null,
    review.placeholders > 0 ? `${review.placeholders} section${review.placeholders === 1 ? "" : "s"} couldn't be written` : null,
    showNotes ? `${warnings.length} note${warnings.length === 1 ? "" : "s"} from the last generation` : null,
    servedPrivate.length > 0 ? `buyers are still reading a private staff matter in ${servedPrivate.length} section${servedPrivate.length === 1 ? "" : "s"}` : null,
    privateStaff.length > 0 ? `${privateStaff.length} section${privateStaff.length === 1 ? "" : "s"} still mention${privateStaff.length === 1 ? "s" : ""} a private staff matter` : null,
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
          {hold?.servingPublished && (
            <div className="flex gap-2.5" data-testid="cim-review-hold">
              <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5 text-amber-500" />
              <div className="min-w-0 space-y-0.5">
                <p className="font-medium">Buyers are seeing the previous version — review and publish the update</p>
                <p className="text-xs text-muted-foreground">
                  {heldReplacedText(hold)}
                  {" "}The deal stays live, and buyers keep reading the version you published until you review these sections, record the approvals on the Overview and publish the update.
                  {hold.ddCleared ? " This version has no due-diligence version yet — generate it before you publish, or due-diligence buyers will get the named CIM." : ""}
                </p>
              </div>
            </div>
          )}
          {hold && !hold.servingPublished && (
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

          {servedPrivate.length > 0 && (
            <div className="flex gap-2.5" data-testid="cim-review-private-staff-served">
              <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5 text-red-400" />
              <div className="min-w-0 space-y-1">
                <p className="font-medium">Buyers are still reading a private staff matter in the published version</p>
                <p className="text-xs text-muted-foreground">
                  {review.privateStaffServedFrom === "kept_copy"
                    ? "While you review the update, buyers read the version you published, and it still states this. Publish the update, or hide the section from buyers on the CIM tab (“Held back from the CIM”)."
                    : "These sections changed since you approved them, so buyers still read the approved version, which states this. Approve the updated section to publish it, or hide the section."}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {servedPrivate.map((s) => (
                    <SectionChip key={s.id} title={s.title} hint={s.descriptions.join("; ")} onClick={onOpenSection ? () => onOpenSection(s.id) : undefined} />
                  ))}
                </div>
              </div>
            </div>
          )}

          {privateStaff.length > 0 && (
            <div className="flex gap-2.5" data-testid="cim-review-private-staff">
              <Lock className="h-4 w-4 shrink-0 mt-0.5 text-amber-500" />
              <div className="min-w-0 space-y-1">
                <p className="font-medium">
                  {privateStaff.length === 1 ? "A section still mentions" : `${privateStaff.length} sections still mention`} a private staff matter
                </p>
                <p className="text-xs text-muted-foreground">
                  It is now held back from every version of the CIM, but the CIM as written still states it. Regenerate or edit these sections before buyers see them:
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {privateStaff.map((s) => (
                    <SectionChip key={s.id} title={s.sectionTitle} hint={s.privateStaff!.join("; ")} onClick={onOpenSection ? () => onOpenSection(s.id) : undefined} />
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
      <span className="truncate min-w-0 max-w-[220px]">{title}</span>
      {hint && <span className="text-muted-foreground truncate min-w-0 max-w-[160px]">· {hint}</span>}
    </>
  );
  return onClick ? (
    <button type="button" onClick={onClick} className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-md border border-border bg-background px-2 py-0.5 text-[11px] hover:border-teal/50 hover:text-teal">
      {body}
    </button>
  ) : (
    <span className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-md border border-border bg-background px-2 py-0.5 text-[11px]">{body}</span>
  );
}

// ── The CIM tab's grouped rows ("Needs attention") ─────────────────────────

const KIND_ORDER: CimWarningKind[] = ["placeholder", "hidden", "figures", "removed", "review"];
/** Groups that start open (the ones that keep a section from buyers). */
const OPEN_KINDS = new Set<CimWarningKind>(["placeholder", "hidden"]);

/** "3 sections: Fleet, Customers, Working capital" / "2 notes". */
export function groupSummary(items: Array<{ sectionTitle: string | null }>): string {
  const titles = Array.from(new Set(items.map((i) => i.sectionTitle).filter((t): t is string => !!t)));
  if (titles.length === 0) return `${items.length} note${items.length === 1 ? "" : "s"}`;
  const shown = titles.slice(0, 3).join(", ");
  const more = titles.length > 3 ? ` and ${titles.length - 3} more` : "";
  return `${titles.length} section${titles.length === 1 ? "" : "s"}: ${shown}${more}`;
}

/** The note groups the CIM tab shows (and counts): one per kind, in order; placeholders without a note get their own group. */
export function attentionNoteGroups(
  warnings: ReturnType<typeof classifyGenerationWarnings>,
  placeholderSections: Array<{ id: string; sectionTitle: string }>,
): Array<{ kind: CimWarningKind; items: Array<{ text: string; sectionTitle: string | null }> }> {
  const out: Array<{ kind: CimWarningKind; items: Array<{ text: string; sectionTitle: string | null }> }> = [];
  for (const kind of KIND_ORDER) {
    let items = warnings.filter((w) => w.kind === kind).map((w) => ({ text: w.text, sectionTitle: w.sectionTitle }));
    if (kind === "placeholder") {
      const named = new Set(items.map((i) => (i.sectionTitle ?? "").trim().toLowerCase()));
      for (const s of placeholderSections) {
        if (!named.has(s.sectionTitle.trim().toLowerCase())) items = [...items, { text: `“${s.sectionTitle}” couldn't be written by the AI. It's hidden from buyers until you regenerate it, write it yourself or delete it.`, sectionTitle: s.sectionTitle }];
      }
    }
    if (items.length > 0) out.push({ kind, items });
  }
  return out;
}

function GroupedReview({
  review, sections, warnings, privateStaff, servedPrivate, sectionFor, onOpenSection, onDismissNotes, onReviewPublish, publishNotes, className,
}: {
  review: CimReview;
  sections: BuilderSection[];
  warnings: ReturnType<typeof classifyGenerationWarnings>;
  privateStaff: BuilderSection[];
  servedPrivate: NonNullable<CimReview["privateStaffServed"]>;
  sectionFor: (title: string | null) => BuilderSection | null;
  onOpenSection?: (id: string) => void;
  onDismissNotes?: () => void;
  onReviewPublish?: () => void;
  publishNotes?: React.ReactNode[];
  className?: string;
}) {
  const hold = review.heldFromBuyers;
  const groups = attentionNoteGroups(warnings, sections.filter((s) => s.placeholder).map((s) => ({ id: s.id, sectionTitle: s.sectionTitle })));
  if (!hold && groups.length === 0 && privateStaff.length === 0 && servedPrivate.length === 0) return null;
  return (
    <div className={cn("space-y-2", className)} data-testid="cim-review-panel">
      {hold && (
        <Row tone="amber" icon={<ShieldAlert className="h-4 w-4 text-amber-500" />} title={hold.servingPublished ? "Buyers are seeing the previous version until you publish the update" : "Buyers can't see this CIM until you publish it again"} testId="cim-review-hold">
          <p className="text-xs text-muted-foreground">
            {heldReplacedText(hold)}{" "}
            {hold.servingPublished
              ? "The deal stays live, and buyers keep reading the version you published until you review these sections, record the approvals on the Overview and publish the update."
              : "They see a notice that the document is being updated. Review the sections, record the approvals on the Overview and publish when it's right."}
            {hold.ddCleared ? " The due-diligence version was cleared — generate it again for due-diligence buyers." : ""}
          </p>
          {(publishNotes ?? []).map((n, i) => <div key={i} className="text-xs">{n}</div>)}
          {onReviewPublish && (
            <Button size="sm" className="h-7 bg-teal text-xs text-teal-foreground hover:bg-teal/90" onClick={onReviewPublish} data-testid="button-review-and-publish">
              Review and publish
            </Button>
          )}
        </Row>
      )}
      {groups.map((g) => (
        <NoteGroup key={g.kind} kind={g.kind} items={g.items} sectionFor={sectionFor} onOpenSection={onOpenSection} />
      ))}
      {servedPrivate.length > 0 && (
        <Row tone="red" icon={<ShieldAlert className="h-4 w-4 text-red-400" />} title="Buyers are still reading a private staff matter in the published version" testId="cim-review-private-staff-served">
          <div className="flex flex-wrap gap-1.5">
            {servedPrivate.map((s) => <SectionChip key={s.id} title={s.title} hint={s.descriptions.join("; ")} onClick={onOpenSection ? () => onOpenSection(s.id) : undefined} />)}
          </div>
        </Row>
      )}
      {privateStaff.length > 0 && (
        <Row tone="amber" icon={<Lock className="h-4 w-4 text-amber-500" />} title={`${privateStaff.length === 1 ? "A section still mentions" : `${privateStaff.length} sections still mention`} a private staff matter`} testId="cim-review-private-staff">
          <div className="flex flex-wrap gap-1.5">
            {privateStaff.map((s) => <SectionChip key={s.id} title={s.sectionTitle} hint={s.privateStaff!.join("; ")} onClick={onOpenSection ? () => onOpenSection(s.id) : undefined} />)}
          </div>
        </Row>
      )}
      {onDismissNotes && (
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" className="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground" onClick={onDismissNotes} title="Hide the notes from the last generation (they stay on each section's figure check)">
            <X className="h-3 w-3" /> Dismiss the notes
          </Button>
        </div>
      )}
    </div>
  );
}

function Row({ tone, icon, title, children, testId }: { tone: "amber" | "red" | "blue"; icon: React.ReactNode; title: string; children?: React.ReactNode; testId?: string }) {
  return (
    <div
      className={cn(
        "flex gap-2.5 rounded-lg border px-3.5 py-3 text-sm",
        tone === "red" ? "border-red-500/30 bg-red-500/5" : tone === "blue" ? "border-blue-500/30 bg-blue-500/5" : "border-amber-500/30 bg-amber-500/5",
      )}
      data-testid={testId}
    >
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="font-medium">{title}</p>
        {children}
      </div>
    </div>
  );
}

function NoteGroup({
  kind, items, sectionFor, onOpenSection,
}: {
  kind: CimWarningKind;
  items: Array<{ text: string; sectionTitle: string | null }>;
  sectionFor: (title: string | null) => BuilderSection | null;
  onOpenSection?: (id: string) => void;
}) {
  const [open, setOpen] = useState(OPEN_KINDS.has(kind));
  const severe = kind === "placeholder" || kind === "hidden";
  const first = items.map((i) => sectionFor(i.sectionTitle)).find(Boolean) ?? null;
  return (
    <div className={cn("rounded-lg border text-sm", severe ? "border-red-500/30 bg-red-500/5" : "border-border bg-card")} data-testid={`cim-attention-group-${kind}`}>
      <button type="button" className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={cn("shrink-0 rounded px-1.5 py-px text-[10px] font-medium", severe ? "bg-red-500/10 text-red-400" : "bg-amber-500/10 text-amber-600 dark:text-amber-400")}>{KIND_LABEL[kind]}</span>
        <span className="shrink-0 rounded-full bg-muted px-1.5 text-[11px] font-semibold tabular-nums text-muted-foreground">{items.length}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{groupSummary(items)}</span>
        {first && onOpenSection && !open && (
          <span role="link" tabIndex={0} className="hidden shrink-0 text-xs text-teal hover:underline sm:inline" onClick={(e) => { e.stopPropagation(); onOpenSection(first.id); }} onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); onOpenSection(first.id); } }}>
            Open section
          </span>
        )}
        {open ? <ChevronUp className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
      </button>
      {open && (
        <ul className="space-y-1.5 border-t border-border/60 px-3.5 py-2.5">
          {items.map((w, i) => {
            const s = sectionFor(w.sectionTitle);
            return (
              <li key={i} className="break-words text-xs text-muted-foreground">
                {w.text}
                {s && onOpenSection && <button type="button" className="ml-1.5 text-teal hover:underline" onClick={() => onOpenSection(s.id)}>Open section</button>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Facts changed since the CIM was written (the CIM tab draws it last in "Needs attention"). */
export function CimFactsChanged({ review, sections, onOpenSection, className }: { review: CimReview | undefined; sections: BuilderSection[]; onOpenSection?: (id: string) => void; className?: string }) {
  const facts = review?.facts;
  if (!facts) return null;
  const stale = sections.filter((s) => (s.factsChanged?.length ?? 0) > 0);
  return (
    <div className={cn("flex gap-2.5 rounded-lg border border-blue-500/30 bg-blue-500/5 px-3.5 py-3 text-sm", className)} data-testid="cim-review-facts">
      <History className="mt-0.5 h-4 w-4 shrink-0 text-blue-400" />
      <div className="min-w-0 space-y-1">
        <p className="font-medium">Facts changed since this CIM was written</p>
        {facts.changes.length > 0 && (
          <ul className="space-y-0.5 text-xs text-muted-foreground">
            {facts.changes.map((c, i) => (
              <li key={i} className="break-words">
                <span className="text-foreground/80">{c.label}:</span>{" "}
                {c.before === null && c.after === null ? "changed" : `${c.before ?? "—"} → ${c.after ?? "removed"}`}
              </li>
            ))}
            {facts.more > 0 && <li>and {facts.more} more</li>}
          </ul>
        )}
        {facts.notesChanged && <p className="text-xs text-muted-foreground">Your private notes or the items held back from the CIM changed — regenerate or check the CIM follows them.</p>}
        {stale.length > 0 ? (
          <>
            <p className="text-xs text-muted-foreground">These sections still show an old value — regenerate or edit them:</p>
            <div className="flex flex-wrap gap-1.5">
              {stale.map((s) => <SectionChip key={s.id} title={s.sectionTitle} hint={s.factsChanged!.join(", ")} onClick={onOpenSection ? () => onOpenSection(s.id) : undefined} />)}
            </div>
          </>
        ) : facts.changes.length > 0 ? (
          <p className="text-xs text-muted-foreground">No section shows the old values. The asking price on the cover and key numbers always shows your listed price.</p>
        ) : null}
      </div>
    </div>
  );
}
