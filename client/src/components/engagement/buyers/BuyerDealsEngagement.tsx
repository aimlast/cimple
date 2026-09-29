/**
 * "Engagement on your deals" — the buyer profile page's reading block: one
 * row per deal THIS broker owns where the buyer has access, with the status
 * in words, why, the page strip and "See where they read". Each row reads
 * the deal's own engagement API (requireOwnedDeal), so engagement on other
 * brokers' deals can never appear, even though buyer accounts are global.
 */
import { useLocation } from "wouter";
import { useEngagementBuyers } from "@/hooks/useEngagement";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowUpRight, FileSearch } from "lucide-react";
import { formatReadingTime } from "@shared/analytics-v2";
import { PageStrip, StatusChip, agoText, stripScale } from "./parts";

export interface BuyerDealRef {
  dealId: string;
  businessName: string;
  accessId: string;
  status: "active" | "expired" | "revoked";
}

function DealRow({ d }: { d: BuyerDealRef }) {
  const [, setLocation] = useLocation();
  const { data, isLoading } = useEngagementBuyers(d.dealId, { buyers: [d.accessId] });
  const card = data?.buyers.find((b) => b.accessId === d.accessId) ?? null;
  const notOpened = data?.notOpened.find((b) => b.accessId === d.accessId) ?? null;
  const goDoc = () => setLocation(`/deal/${d.dealId}/engagement?view=document&buyers=${d.accessId}`);
  return (
    <li className="py-3 first:pt-0 last:pb-0" data-testid={`engagement-deal-${d.dealId}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <button type="button" onClick={() => setLocation(`/deal/${d.dealId}/engagement`)} className="group inline-flex min-w-0 items-center gap-1 text-sm font-medium text-foreground hover:text-teal">
          <span className="truncate">{d.businessName}</span>
          <ArrowUpRight className="h-3 w-3 shrink-0 opacity-50 group-hover:opacity-100" />
        </button>
        {card && <StatusChip status={card.status} label={card.statusLabel} />}
        {!card && notOpened && <StatusChip status="not_opened" label="Not opened yet" />}
        {d.status !== "active" && <span className="text-2xs text-muted-foreground">{d.status === "expired" ? "Link expired" : "Access revoked"}</span>}
        {card && <span className="ml-auto text-2xs text-muted-foreground tabular-nums">{formatReadingTime(card.activeMs)} · {agoText(card.lastSeenAt)}</span>}
      </div>
      {isLoading ? (
        <Skeleton className="mt-2 h-3 w-full" />
      ) : card ? (
        <>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{card.why}</p>
          <PageStrip cells={card.pageStrip} maxMs={stripScale([card.pageStrip])} size="sm" className="mt-2" onOpen={(c) => setLocation(`/deal/${d.dealId}/engagement?view=document&buyers=${d.accessId}&page=${encodeURIComponent(`${c.pageId}#${c.part}`)}`)} />
          {card.talkingPoints[0] && <p className="mt-1.5 text-xs text-foreground/85"><span className="text-muted-foreground">To say: </span>{card.talkingPoints[0].text}</p>}
          <button type="button" onClick={goDoc} className="mt-1.5 inline-flex items-center gap-1 text-xs text-teal hover:underline">
            <FileSearch className="h-3 w-3" />See where they read
          </button>
        </>
      ) : (
        <p className="mt-1 text-xs text-muted-foreground">{notOpened ? `Access given ${agoText(notOpened.grantedAt)} — hasn't opened the CIM yet.` : "No reading recorded."}</p>
      )}
    </li>
  );
}

export function BuyerDealsEngagement({ deals }: { deals: BuyerDealRef[] }) {
  if (deals.length === 0) return null;
  return (
    <section className="rounded-xl border border-border bg-card p-4 sm:p-5" data-testid="buyer-deals-engagement">
      <p className="mb-3 font-mono text-2xs uppercase tracking-[0.16em] text-muted-foreground">Engagement on your deals</p>
      <ul className="divide-y divide-border/60">
        {deals.map((d) => <DealRow key={d.accessId} d={d} />)}
      </ul>
    </section>
  );
}
