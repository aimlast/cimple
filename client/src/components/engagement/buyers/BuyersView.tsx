/**
 * Buyers view — "who to call today": one card per buyer, best lead first
 * (status in words, the one-line why, the page strip, up to three talking
 * points with their evidence; See where they read / Their visits / Email /
 * Mark contacted / Summarise), then "Not opened yet".
 *
 * Owned by the INTELLIGENCE stream. The order is the call priority
 * (reading intent × fit × recency × openness — server/engagement/insights.ts);
 * the number itself is never shown. Email opens the existing broker email
 * dialog (the broker writes and sends; talking points are never inserted).
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatReadingTime, viewerPageKey, type BuyerStatus } from "@shared/analytics-v2";
import { useBuyerBrief, useEngagementBuyers, useEngagementDocument, useMarkContacted } from "@/hooks/useEngagement";
import { useToast } from "@/hooks/use-toast";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { EmailDialog } from "@/components/buyers/profile/ActionDialogs";
import { ChevronDown, ChevronUp, Copy, Mail, Users } from "lucide-react";
import { BuyerCard } from "./BuyerCard";
import { StripLegend, agoText, stripScale } from "./parts";
import type { EngagementViewProps } from "../types";

interface AccessRow { id: string; buyerEmail: string; buyerName: string | null; buyerUserId: string | null }

const SUMMARY_ORDER: Array<[BuyerStatus, string]> = [
  ["reading_now", "reading now"], ["hot", "hot"], ["interested", "interested"], ["warming", "warming up"],
  ["went_quiet", "went quiet"], ["skimmed", "only skimmed"],
];

/** "1 reading now · 1 hot · 2 interested · 1 went quiet" */
function statusSummary(statuses: BuyerStatus[]): string {
  return SUMMARY_ORDER.map(([s, w]) => [statuses.filter((x) => x === s).length, w] as const)
    .filter(([n]) => n > 0).map(([n, w]) => `${n} ${w}`).join(" · ");
}

export function EmptyReading({ published = true }: { published?: boolean }) {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed border-border px-6 py-10 text-center" data-testid="engagement-empty">
      <svg width="88" height="72" viewBox="0 0 88 72" aria-hidden="true" className="mb-4">
        <rect x="18" y="4" width="52" height="64" rx="4" fill="hsl(var(--card))" stroke="hsl(var(--border))" />
        <rect x="26" y="14" width="30" height="4" rx="2" fill="hsl(var(--muted-foreground) / 0.35)" />
        <rect x="26" y="24" width="36" height="10" rx="2" fill="hsl(var(--teal) / 0.55)" />
        <rect x="26" y="38" width="36" height="3" rx="1.5" fill="hsl(var(--muted-foreground) / 0.25)" />
        <rect x="26" y="45" width="28" height="3" rx="1.5" fill="hsl(var(--muted-foreground) / 0.25)" />
        <rect x="26" y="52" width="36" height="8" rx="2" fill="hsl(var(--teal) / 0.25)" />
      </svg>
      <p className="text-sm font-medium text-foreground">{published ? "No buyer has opened the CIM yet" : "The CIM isn't live yet"}</p>
      <p className="mt-1 max-w-sm text-xs text-muted-foreground">
        When buyers open the CIM, you'll see who to call first, which pages and numbers they study, and what to say.
      </p>
    </div>
  );
}

export function BuyersView({ dealId, filters, nav }: EngagementViewProps) {
  const { toast } = useToast();
  const { data, isLoading, error, refetch } = useEngagementBuyers(dealId, filters);
  // Real titles for the strip captions (shared cache with the Document view).
  const { data: doc } = useEngagementDocument(dealId, { rendition: filters.rendition });
  const { data: accessRows = [] } = useQuery<AccessRow[]>({
    queryKey: ["/api/deals", dealId, "buyers"],
    queryFn: async () => {
      const r = await fetch(`/api/deals/${dealId}/buyers`, { credentials: "include" });
      return r.ok ? r.json() : [];
    },
  });
  const contacted = useMarkContacted(dealId);
  const brief = useBuyerBrief(dealId);
  const [briefs, setBriefs] = useState<Record<string, { text: string; generatedAt: string }>>({});
  const [briefing, setBriefing] = useState<string | null>(null);
  const [emailFor, setEmailFor] = useState<AccessRow | null>(null);
  const [showUnopened, setShowUnopened] = useState(true);

  const titles = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of doc?.pages ?? []) m.set(viewerPageKey(p.pageId, p.part), p.title);
    return m;
  }, [doc]);
  const maxMs = useMemo(() => stripScale((data?.buyers ?? []).map((b) => b.pageStrip)), [data]);
  const byAccess = useMemo(() => new Map(accessRows.map((a) => [a.id, a])), [accessRows]);

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-5 w-72" />
        {[0, 1, 2].map((i) => <Skeleton key={i} className="h-48 w-full rounded-xl" />)}
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="rounded-xl border border-border p-6 text-center">
        <p className="text-sm text-muted-foreground">Couldn't load the buyers.</p>
        <Button size="sm" variant="outline" className="mt-3" onClick={() => refetch()}>Try again</Button>
      </div>
    );
  }

  const openEmail = (accessId: string) => {
    const row = byAccess.get(accessId);
    if (row?.buyerUserId) setEmailFor(row);
  };
  const markContacted = (accessId: string, name: string) =>
    contacted.mutate(accessId, {
      onSuccess: () => toast({ title: "Marked as contacted", description: `${name.split(" ")[0]} moves down the list for two days.` }),
      onError: (e: Error) => toast({ title: "Couldn't save that", description: e.message, variant: "destructive" }),
    });
  const askBrief = (accessId: string) => {
    setBriefing(accessId);
    brief.mutate(accessId, {
      onSuccess: (r) => setBriefs((b) => ({ ...b, [accessId]: { text: r.text, generatedAt: r.generatedAt } })),
      onError: (e: Error) => {
        let msg = e.message;
        try { msg = JSON.parse(msg).error ?? msg; } catch { /* plain text */ }
        toast({ title: "Couldn't write the summary", description: msg, variant: "destructive" });
      },
      onSettled: () => setBriefing(null),
    });
  };
  const copyEmail = async (email: string) => {
    try { await navigator.clipboard.writeText(email); toast({ title: "Email copied", description: email }); }
    catch { toast({ title: "Their email", description: email }); }
  };

  const summary = statusSummary(data.buyers.map((b) => b.status));
  const total = data.buyers.reduce((s, b) => s + b.activeMs, 0);

  return (
    <div className="space-y-4" data-testid="engagement-buyers">
      {data.buyers.length === 0 ? (
        <EmptyReading />
      ) : (
        <>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-foreground">Who to call first</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {data.buyers.length} buyer{data.buyers.length === 1 ? "" : "s"} read the CIM ({formatReadingTime(total)} in all){summary ? ` — ${summary}` : ""}. Best lead first: how closely they read, how well they fit, how recently, and whether you've already called.
              </p>
            </div>
            <StripLegend className="sm:shrink-0" />
          </div>
          {data.legacyOnly && (
            <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              Page-level only — this reading was recorded before detailed reading tracking.
            </p>
          )}
          <div className="space-y-3">
            {data.buyers.map((card, i) => {
              const row = byAccess.get(card.accessId);
              return (
                <BuyerCard
                  key={card.accessId}
                  card={card}
                  first={i === 0}
                  titles={titles}
                  maxMs={maxMs}
                  nav={nav}
                  onEmail={row?.buyerUserId ? () => openEmail(card.accessId) : row ? () => copyEmail(row.buyerEmail) : undefined}
                  emailDisabledReason={row && !row.buyerUserId ? "Copies their email — they don't have a Cimple profile yet" : null}
                  onContacted={() => markContacted(card.accessId, card.name)}
                  contacting={contacted.isPending && contacted.variables === card.accessId}
                  onBrief={() => askBrief(card.accessId)}
                  briefing={briefing === card.accessId}
                  brief={briefs[card.accessId] ?? null}
                  onCloseBrief={() => setBriefs((b) => { const n = { ...b }; delete n[card.accessId]; return n; })}
                />
              );
            })}
          </div>
        </>
      )}

      {data.notOpened.length > 0 && (
        <Collapsible open={showUnopened} onOpenChange={setShowUnopened}>
          <CollapsibleTrigger asChild>
            <button type="button" className="flex w-full items-center justify-between rounded-lg px-1 py-1.5 text-left" data-testid="toggle-not-opened">
              <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                <Users className="h-4 w-4 text-muted-foreground" />Not opened yet ({data.notOpened.length})
              </span>
              {showUnopened ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="divide-y divide-border/70 rounded-xl border border-border">
              {data.notOpened.map((b) => {
                const row = byAccess.get(b.accessId);
                return (
                  <li key={b.accessId} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between" data-testid={`not-opened-${b.accessId}`}>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground">{b.name}{b.company && <span className="ml-1.5 font-normal text-muted-foreground">{b.company}</span>}</p>
                      <p className="text-xs text-muted-foreground">Access given {agoText(b.grantedAt)} · {b.ndaSigned ? "NDA signed" : "NDA not signed yet"}</p>
                    </div>
                    {row && (
                      <Button
                        size="sm" variant="outline" className="h-8 self-start text-xs sm:self-auto"
                        onClick={() => (row.buyerUserId ? setEmailFor(row) : copyEmail(row.buyerEmail))}
                        title={row.buyerUserId ? undefined : "Copies their email — they don't have a Cimple profile yet"}
                      >
                        {row.buyerUserId ? <Mail className="h-3.5 w-3.5 mr-1.5" /> : <Copy className="h-3.5 w-3.5 mr-1.5" />}Nudge
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      )}

      {emailFor?.buyerUserId && (
        <EmailDialog
          open
          onOpenChange={(o) => { if (!o) setEmailFor(null); }}
          buyerId={emailFor.buyerUserId}
          buyerName={emailFor.buyerName || emailFor.buyerEmail}
          buyerEmail={emailFor.buyerEmail}
          defaultDealId={dealId}
        />
      )}
    </div>
  );
}
