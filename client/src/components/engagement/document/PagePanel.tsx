/**
 * "This page" — the side panel beside the heat map (a bottom sheet on phones):
 *
 *   totals        reading time, how many buyers read it, time per reader vs
 *                 one careful read, how they read it (Skipped / Glanced /
 *                 Read / Studied)
 *   buyers        who read it, with their seconds (click one → the whole view
 *                 shows only that buyer)
 *   parts         the parts of the page ranked by reading time, in words
 *                 ("Row: Adjusted EBITDA"); hovering one lights it up on the
 *                 page, clicking selects it
 *   what they did switched to Normalized, opened the section, played the video…
 *   questions     asked while on this page
 *   version note  "Changed since 2 buyers read it"
 *
 * A switch turns the panel to "What holds attention" (AttentionByKind, the
 * intelligence stream's component) for this page and the whole CIM.
 */
import { useMemo, useState } from "react";
import { History, Info, MessageCircleQuestion, MousePointerClick } from "lucide-react";
import {
  READ_LABEL_TEXT,
  formatReadingTime,
  type DocumentPage,
  type EngagementDocumentResponse,
  type KindAttention,
  type RenditionPage,
} from "@shared/analytics-v2";
import { KIND_GROUPS, kindGroupOf } from "@shared/cim-blocks";
import { AttentionByKind } from "../AttentionByKind";
import { heatChrome } from "../heat";
import { Segmented } from "../FilterBar";
import { expandCount, interactionLines, isUnread, pageInView, paintable, perReaderMs, readersText, type SectionView } from "./viewer-model";
import { Link } from "wouter";
import { cn } from "@/lib/utils";

export const READ_LABEL_HELP: Record<string, string> = {
  opened: "The cover, disclaimer or contact page: opened, not judged by reading time",
  skipped: "Most buyers scrolled past it",
  glanced: "Most buyers spent under half the time a careful read takes",
  read: "Most buyers spent about the time a careful read takes",
  studied: "Most buyers spent well over the time a careful read takes",
};

export function ReadLabelChip({ label, className }: { label: DocumentPage["readLabel"]; className?: string }) {
  if (!label) return null;
  const strong = label === "studied" || label === "read";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium",
        label === "studied" ? "bg-teal/20 text-teal" : strong ? "bg-teal/10 text-teal/90" : "bg-muted text-muted-foreground",
        className,
      )}
      title={READ_LABEL_HELP[label]}
    >
      {READ_LABEL_TEXT[label]}
    </span>
  );
}

/** This page's parts grouped by kind of content (tables, text, charts…). */
function pageKinds(page: DocumentPage, renditionPage: RenditionPage | undefined): KindAttention[] {
  const by = new Map<string, KindAttention>();
  for (const b of page.blocks) {
    if (!paintable(b) || b.kind === "heading") continue;
    const g = kindGroupOf(b.kind);
    if (g === "other") continue;
    const e = by.get(g) ?? { group: g, label: KIND_GROUPS.find((k) => k.key === g)?.label ?? g, attentionMs: 0, expectedMs: 0, blocks: 0 };
    e.attentionMs += b.attentionMs;
    e.expectedMs += renditionPage?.blocks.find((x) => x.key === b.key)?.expectedMs ?? 0;
    e.blocks += 1;
    by.set(g, e);
  }
  return Array.from(by.values()).sort((a, b) => b.attentionMs - a.attentionMs);
}

export function PagePanel({
  page, doc, dealId, renditionPage, selectedKey, onHoverKey, onSelectKey, onOnlyBuyer, filteredToOne, paint, className, sectionView = null,
}: {
  page: DocumentPage;
  doc: EngagementDocumentResponse;
  dealId: string;
  renditionPage: RenditionPage | undefined;
  selectedKey: string | null;
  onHoverKey(key: string | null): void;
  onSelectKey(key: string | null): void;
  onOnlyBuyer(accessId: string): void;
  filteredToOne: boolean;
  paint: boolean;
  className?: string;
  /** A collapsible section: the view drawn (the parts listed are that view's). */
  sectionView?: SectionView | null;
}) {
  const [mode, setMode] = useState<"page" | "kinds">("page");
  const [allParts, setAllParts] = useState(false);
  const parts = useMemo(
    () => pageInView(page, sectionView).blocks.filter((b) => paintable(b) && b.kind !== "heading").sort((a, b) => b.attentionMs - a.attentionMs),
    [page, sectionView],
  );
  const openedNobody = sectionView === "opened" && expandCount(page) === 0;
  const maxPart = parts[0]?.attentionMs ?? 0;
  const maxBuyer = page.buyers[0]?.attentionMs ?? 0;
  const perReader = perReaderMs(page);
  const did = interactionLines(page.interactions);
  const shownParts = allParts ? parts : parts.slice(0, 8);

  return (
    <div className={cn("space-y-5 text-sm", className)} data-testid="engagement-page-panel">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">This page</p>
        <Segmented<"page" | "kinds">
          label="Panel"
          size="xs"
          value={mode}
          onChange={setMode}
          options={[{ value: "page", label: "Details" }, { value: "kinds", label: "What holds attention" }]}
        />
      </div>

      {mode === "kinds" ? (
        <div className="space-y-6">
          <AttentionByKind kinds={pageKinds(page, renditionPage)} title="On this page" />
          <AttentionByKind kinds={doc.byKind} title="Across the whole CIM" />
          {pageKinds(page, renditionPage).length === 0 && doc.byKind.length === 0 && (
            <p className="text-xs text-muted-foreground">Nothing read yet.</p>
          )}
        </div>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-3">
            <Stat term="Reading time" value={formatReadingTime(page.attentionMs)} note="all buyers together" />
            <Stat term="Buyers who read it" value={readersText(page.readers, doc.openedBy)} note={`${page.reachedBy} got this far`} />
            <Stat
              term="Per buyer"
              value={perReader != null ? formatReadingTime(perReader) : "—"}
              note={page.expectedMs > 0 ? `careful read: ${formatReadingTime(page.expectedMs)}` : undefined}
            />
            <div>
              <dt className="text-[11px] text-muted-foreground">How they read it</dt>
              <dd className="mt-1">
                {page.readLabel ? <ReadLabelChip label={page.readLabel} className="text-[11px]" /> : <span className="text-muted-foreground">—</span>}
                {page.readLabel && <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{READ_LABEL_HELP[page.readLabel]}</p>}
              </dd>
            </div>
          </dl>

          {(page.changedSince != null || page.pageLevelOnly || !paint) && (
            <div className="flex gap-2 rounded-md border border-border bg-muted/30 p-2.5 text-xs text-muted-foreground">
              <History className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <div className="space-y-1">
                {page.changedSince != null && (
                  <p>Changed since {page.changedSince} buyer{page.changedSince === 1 ? "" : "s"} read it. The colours show reading on this version.</p>
                )}
                {(page.pageLevelOnly || !paint) && (
                  <p>Only page totals are available here: the layout differed between versions, or it was read before part-by-part tracking.</p>
                )}
              </div>
            </div>
          )}

          <section>
            <h4 className="mb-2 text-xs font-medium text-foreground/90">Buyers on this page</h4>
            {page.buyers.length === 0 ? (
              <p className="text-xs text-muted-foreground">Nobody has read this page yet.</p>
            ) : (
              <ul className="space-y-1.5">
                {page.buyers.map((b) => (
                  <li key={b.accessId}>
                    <button
                      type="button"
                      onClick={() => onOnlyBuyer(b.accessId)}
                      disabled={filteredToOne}
                      className="group grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 text-left disabled:cursor-default"
                      title={filteredToOne ? undefined : `Show only ${b.name}`}
                    >
                      <span className="truncate text-xs group-enabled:group-hover:text-teal">{b.name}</span>
                      <span className="text-xs tabular-nums text-muted-foreground">{formatReadingTime(b.attentionMs)}</span>
                      <span className="col-span-2 mt-0.5 h-1.5 overflow-hidden rounded-full bg-muted">
                        <span className="block h-full rounded-full" style={{ width: `${maxBuyer ? Math.max(3, (b.attentionMs / maxBuyer) * 100) : 0}%`, background: heatChrome(0.85) }} />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {parts.length > 0 && (
            <section>
              <h4 className="mb-2 text-xs font-medium text-foreground/90">
                Parts of this page{sectionView === "collapsed" ? " (collapsed, as buyers first see it)" : sectionView === "opened" ? " (opened)" : ""}
              </h4>
              {openedNobody ? (
                <p className="text-xs text-muted-foreground">Nobody has opened this section yet.</p>
              ) : !paint ? (
                <p className="text-xs text-muted-foreground">Part-by-part reading isn't available for this page.</p>
              ) : (
                <ul className="space-y-1" onMouseLeave={() => onHoverKey(null)}>
                  {shownParts.map((b) => (
                    <li key={b.key}>
                      <button
                        type="button"
                        onMouseEnter={() => onHoverKey(b.key)}
                        onFocus={() => onHoverKey(b.key)}
                        onClick={() => onSelectKey(b.key)}
                        className={cn(
                          "grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 rounded px-1.5 py-1 text-left transition-colors hover:bg-muted/50",
                          selectedKey === b.key && "bg-teal/10",
                        )}
                        data-part-key={b.key}
                      >
                        <span className="truncate text-xs" title={b.label}>{b.label}</span>
                        <span className="text-[11px] tabular-nums text-muted-foreground">
                          {b.attentionMs >= 1000 ? formatReadingTime(b.attentionMs) : isUnread(b) ? "not read" : `on screen ${formatReadingTime(b.visibleMs)}`}
                        </span>
                        <span className="col-span-2 mt-0.5 h-1.5 overflow-hidden rounded-full bg-muted">
                          <span
                            className="block h-full rounded-full"
                            style={{ width: `${maxPart ? (b.attentionMs / maxPart) * 100 : 0}%`, background: heatChrome(maxPart ? 0.35 + 0.65 * (b.attentionMs / maxPart) : 0) }}
                          />
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {paint && !openedNobody && parts.length > 8 && (
                <button type="button" onClick={() => setAllParts((v) => !v)} className="mt-1 text-xs text-teal hover:underline">
                  {allParts ? "Show the top 8" : `Show all ${parts.length} parts`}
                </button>
              )}
            </section>
          )}

          <section>
            <h4 className="mb-2 flex items-center gap-1.5 text-xs font-medium text-foreground/90">
              <MousePointerClick className="h-3.5 w-3.5 text-muted-foreground" /> What they did here
            </h4>
            {did.length === 0 ? (
              <p className="text-xs text-muted-foreground">Just reading — no clicks on this page.</p>
            ) : (
              <ul className="space-y-1 text-xs">
                {did.map((d) => <li key={d.type}>{d.text}</li>)}
              </ul>
            )}
          </section>

          {page.questions.length > 0 && (
            <section>
              <h4 className="mb-2 flex items-center gap-1.5 text-xs font-medium text-foreground/90">
                <MessageCircleQuestion className="h-3.5 w-3.5 text-muted-foreground" /> Questions asked on this page
              </h4>
              <ul className="space-y-2">
                {page.questions.map((q) => (
                  <li key={q.id} className="rounded-md border border-border p-2">
                    <p className="text-xs leading-snug">“{q.text}”</p>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {q.name} · {q.answered ? "answered" : <span className="text-amber-500">waiting for your answer</span>}
                    </p>
                  </li>
                ))}
              </ul>
              <Link href={`/deal/${dealId}/qa`} className="mt-1.5 inline-block text-xs text-teal hover:underline">Open Q&amp;A</Link>
            </section>
          )}

          {page.locked && (
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" /> Teaser buyers saw this page locked.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ term, value, note }: { term: string; value: string; note?: string }) {
  return (
    <div>
      <dt className="text-[11px] text-muted-foreground">{term}</dt>
      <dd className="mt-0.5 text-base font-semibold tabular-nums leading-tight">{value}</dd>
      {note && <p className="text-[11px] leading-snug text-muted-foreground">{note}</p>}
    </div>
  );
}
