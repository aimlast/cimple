/**
 * Journey drawer — one buyer's visits, in order:
 *
 *   visits       date, device, reading time, pages reached (a gap of 30 min
 *                or more starts a new visit); pick one to see its path
 *   path strip   the pages in the order they were read, width = time spent;
 *                jumps via the contents or a link are marked; clicking a
 *                segment opens that page in "Where they read", filtered to
 *                this buyer
 *   key moments  "Went straight to the price after the cover", "Asked …",
 *                "Stopped at page 14 of 24" (computed by the intelligence
 *                stream, shown as a timeline)
 *   questions and decisions
 *
 * Right-side sheet on desktop, full screen on phones.
 */
import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight, CornerDownRight, Flag, MessageCircleQuestion, Monitor, Smartphone, Tablet } from "lucide-react";
import { formatReadingTime, type EngagementFilters, type JourneyVisit } from "@shared/analytics-v2";
import { brokerZoneLabel, dayHeading, timeOfDay } from "@shared/analytics-dashboard";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useBuyerJourney } from "@/hooks/useEngagement";
import { cn } from "@/lib/utils";
import { heatChrome } from "../heat";
import type { EngagementNav } from "../types";
import { PathStrip } from "./PathStrip";

const DEVICE_ICON = { desktop: Monitor, tablet: Tablet, phone: Smartphone } as const;
const DEVICE_WORD = { desktop: "Computer", tablet: "Tablet", phone: "Phone" } as const;
const DECISION_WORD: Record<string, string> = {
  interested: "Chose Interested",
  not_interested: "Chose Not interested",
  need_more_time: "Asked for more time",
  lapsed: "No decision (lapsed)",
  under_review: "Still deciding",
};

/** "Wed 23 Sept · 3:12 pm" — the broker's calendar and clock (Toronto), like every engagement screen. */
function when(iso: string): string {
  return `${dayHeading(iso)} · ${timeOfDay(iso)}`;
}

export function JourneyDrawer({
  dealId, accessId, filters, nav, onClose,
}: {
  dealId: string;
  accessId: string | null;
  filters?: Partial<EngagementFilters>;
  nav?: EngagementNav;
  onClose(): void;
}) {
  // Visits are the buyer's own: only the date and device filters apply.
  const { data, isLoading, error } = useBuyerJourney(dealId, accessId, { range: filters?.range, device: filters?.device });
  const visits = useMemo(() => [...(data?.visits ?? [])].sort((a, b) => b.startedAt.localeCompare(a.startedAt)), [data]);
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => setPicked(null), [accessId]);
  const visit = visits.find((v) => v.id === picked) ?? visits[0] ?? null;
  const maxActive = Math.max(0, ...visits.map((v) => v.activeMs));
  // "Toronto time" beside the visits when this computer's clock is elsewhere.
  const zone = useMemo(() => brokerZoneLabel(), []);

  return (
    <Sheet open={!!accessId} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg" data-testid="engagement-journey">
        <SheetHeader className="text-left">
          <SheetTitle className="flex items-center gap-2">{data?.name ?? "Visits"}{data?.sampleReading && <span className="rounded-full border border-border px-2 py-0.5 text-[10px] font-medium text-muted-foreground" title="This is an example deal: its buyers and their reading are made up." data-testid="journey-sample-chip">Sample</span>}</SheetTitle>
          <SheetDescription>
            {data?.company ? `${data.company} · ` : ""}
            {visits.length} visit{visits.length === 1 ? "" : "s"}
            {visits.length > 0 && ` · ${formatReadingTime(visits.reduce((s, v) => s + v.activeMs, 0))} reading in total`}
          </SheetDescription>
        </SheetHeader>

        {isLoading ? (
          <div className="mt-6 space-y-3"><Skeleton className="h-16" /><Skeleton className="h-16" /><Skeleton className="h-24" /></div>
        ) : error ? (
          <p className="mt-6 text-sm text-muted-foreground">Couldn't load this buyer's visits.</p>
        ) : visits.length === 0 ? (
          <p className="mt-6 text-sm text-muted-foreground">No visits recorded yet.</p>
        ) : (
          <div className="mt-5 space-y-6">
            {nav && accessId && (
              <button
                type="button"
                onClick={() => nav.openDocument({ accessId })}
                className="inline-flex items-center gap-1.5 rounded-md border border-teal/40 bg-teal/10 px-3 py-1.5 text-xs font-medium text-teal hover:bg-teal/15"
              >
                See where they read on the CIM <ArrowUpRight className="h-3.5 w-3.5" />
              </button>
            )}

            <section>
              <h4 className="mb-2 flex items-baseline gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Visits
                {zone && <span className="font-normal normal-case tracking-normal" title="Times are Toronto time." data-testid="journey-zone">{zone}</span>}
              </h4>
              <ul className="space-y-1.5">
                {visits.map((v, i) => {
                  const Icon = DEVICE_ICON[v.device] ?? Monitor;
                  const on = v.id === visit?.id;
                  return (
                    <li key={v.id}>
                      <button
                        type="button"
                        onClick={() => setPicked(v.id)}
                        className={cn("w-full rounded-md border px-3 py-2 text-left transition-colors", on ? "border-teal/50 bg-teal/10" : "border-border hover:bg-muted/40")}
                      >
                        <div className="flex items-center gap-2 text-sm">
                          <span className="font-medium">{when(v.startedAt)}</span>
                          {i === visits.length - 1 && visits.length > 1 && <span className="rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">first visit</span>}
                          <span className="ml-auto tabular-nums text-xs">{formatReadingTime(v.activeMs)}</span>
                        </div>
                        <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                          <Icon className="h-3 w-3" /> {DEVICE_WORD[v.device] ?? "Computer"}
                          <span>·</span>
                          <span>{v.pagesReached} page{v.pagesReached === 1 ? "" : "s"}</span>
                          {v.legacy && <><span>·</span><span>page-level only</span></>}
                          <span className="ml-auto h-1 w-20 overflow-hidden rounded-full bg-muted">
                            <span className="block h-full rounded-full" style={{ width: `${maxActive ? (v.activeMs / maxActive) * 100 : 0}%`, background: heatChrome(0.9) }} />
                          </span>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>

            {visit && <VisitDetail visit={visit} accessId={accessId!} nav={nav} />}

            {(data?.questions.length ?? 0) > 0 && (
              <section>
                <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Questions</h4>
                <ul className="space-y-2">
                  {data!.questions.map((q) => (
                    <li key={q.id} className="flex gap-2 text-sm">
                      <MessageCircleQuestion className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <div>
                        <p className="leading-snug">“{q.text}”</p>
                        <p className="text-[11px] text-muted-foreground">{when(q.askedAt)} · {q.answered ? "answered" : "waiting for your answer"}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {(data?.decisions.length ?? 0) > 0 && (
              <section>
                <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Decision</h4>
                <ul className="space-y-1 text-sm">
                  {data!.decisions.map((d) => (
                    <li key={`${d.decision}-${d.at}`} className="flex items-center gap-2">
                      <Flag className="h-3.5 w-3.5 text-teal" /> {DECISION_WORD[d.decision] ?? d.decision}
                      <span className="text-[11px] text-muted-foreground">{when(d.at)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function VisitDetail({ visit, accessId, nav }: { visit: JourneyVisit; accessId: string; nav?: EngagementNav }) {
  return (
    <>
      <section>
        <h4 className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">The path through the CIM</h4>
        <p className="mb-2 text-[11px] text-muted-foreground">Each block is a page, in the order they read them; wider means longer. Tap one to open it.</p>
        <PathStrip
          segments={visit.path}
          onOpen={nav ? (s) => nav.openDocument({ accessId, pageId: s.pageId, part: s.part }) : undefined}
        />
      </section>
      {visit.moments.length > 0 && (
        <section>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Key moments</h4>
          <ol className="relative space-y-3 border-l border-border pl-4">
            {visit.moments.map((m, i) => (
              <li key={`${m.at}-${i}`} className="relative">
                <span className="absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full border-2 border-background bg-teal" />
                <p className="text-sm leading-snug">
                  {m.text}
                  {m.pageRef && nav && (
                    <button
                      type="button"
                      onClick={() => nav.openDocument({ accessId, pageId: m.pageRef!.pageId, part: m.pageRef!.part })}
                      className="ml-1.5 inline-flex items-center gap-0.5 text-xs text-teal hover:underline"
                    >
                      <CornerDownRight className="h-3 w-3" /> page {m.pageRef.label}
                    </button>
                  )}
                </p>
                <p className="text-[11px] text-muted-foreground">{when(m.at)}</p>
              </li>
            ))}
          </ol>
        </section>
      )}
    </>
  );
}
