/**
 * BuyersTab — Active buyers, pending approvals, outreach & matching.
 */
import { useQuery } from "@tanstack/react-query";
import { useDeal } from "@/contexts/DealContext";
import { BuyerApprovalsPanel } from "@/components/deal/BuyerApprovalsPanel";
import { BuyerMatchingPanel } from "@/components/deal/BuyerMatchingPanel";
import { SuggestedBuyersPanel } from "@/components/deal/SuggestedBuyersPanel";
import {
  Eye,
  Clock,
  ThumbsUp,
  ThumbsDown,
  Timer,
} from "lucide-react";

export function BuyersTab() {
  const { dealId } = useDeal();

  const { data: buyerAccessList = [] } = useQuery<any[]>({
    queryKey: ["/api/deals", dealId, "buyers"],
    queryFn: async () => {
      const r = await fetch(`/api/deals/${dealId}/buyers`);
      return r.ok ? r.json() : [];
    },
  });

  const { data: buyerScores = [] } = useQuery<any[]>({
    queryKey: ["/api/deals", dealId, "analytics/buyer-scores"],
    queryFn: async () => {
      const r = await fetch(
        `/api/deals/${dealId}/analytics/buyer-scores`,
      );
      return r.ok ? r.json() : [];
    },
  });

  const activeBuyers = buyerAccessList.filter((b: any) => !b.revokedAt);
  const scoreMap = new Map(buyerScores.map((s: any) => [s.buyerId, s]));

  return (
    <div className="max-w-4xl mx-auto px-6 py-6 space-y-8">
      {/* Active Buyers — status + engagement */}
      <section>
        <div className="mb-3">
          <h2 className="text-base font-semibold">Active Buyers</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Buyers with CIM access — their decision status and engagement.
          </p>
        </div>
        {activeBuyers.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-6 text-center">
            <Eye className="h-5 w-5 mx-auto text-muted-foreground/40 mb-2" />
            <p className="text-sm text-muted-foreground">
              No buyers have access yet.
            </p>
            <p className="text-xs text-muted-foreground/60 mt-1">
              Approve a buyer below to grant CIM access.
            </p>
          </div>
        ) : (
          <div className="rounded-lg border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30">
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">
                    Buyer
                  </th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">
                    Status
                  </th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">
                    Engagement
                  </th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">
                    NDA
                  </th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">
                    Activity
                  </th>
                </tr>
              </thead>
              <tbody>
                {activeBuyers.map((buyer: any) => {
                  const decision = buyer.decision || "under_review";
                  const statusConfig: Record<
                    string,
                    {
                      label: string;
                      icon: any;
                      className: string;
                    }
                  > = {
                    under_review: {
                      label: "Under Review",
                      icon: Clock,
                      className: "text-amber-600 bg-amber-50",
                    },
                    interested: {
                      label: "Interested",
                      icon: ThumbsUp,
                      className: "text-emerald-600 bg-emerald-50",
                    },
                    not_interested: {
                      label: "Not Interested",
                      icon: ThumbsDown,
                      className: "text-red-500 bg-red-50",
                    },
                    lapsed: {
                      label: "Lapsed",
                      icon: Timer,
                      className: "text-muted-foreground bg-muted",
                    },
                  };
                  const status =
                    statusConfig[decision] || statusConfig.under_review;
                  const StatusIcon = status.icon;

                  const score = scoreMap.get(buyer.id);
                  const engagementScore = score?.engagementScore ?? 0;
                  const intent = score?.intent ?? "minimal";
                  const intentConfig: Record<
                    string,
                    { label: string; className: string }
                  > = {
                    high: {
                      label: "High",
                      className: "text-emerald-600",
                    },
                    medium: {
                      label: "Medium",
                      className: "text-amber-600",
                    },
                    low: {
                      label: "Low",
                      className: "text-muted-foreground",
                    },
                    minimal: {
                      label: "Minimal",
                      className: "text-muted-foreground/50",
                    },
                  };
                  const intentCfg =
                    intentConfig[intent] || intentConfig.minimal;

                  const views =
                    score?.viewCount ?? buyer.viewCount ?? 0;
                  const totalMin = Math.round(
                    (score?.totalTimeSeconds ??
                      buyer.totalTimeSeconds ??
                      0) / 60,
                  );
                  const timeLabel =
                    totalMin < 1 ? "<1m" : `${totalMin}m`;
                  const lastActive = buyer.lastAccessedAt
                    ? new Date(
                        buyer.lastAccessedAt,
                      ).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                      })
                    : "—";

                  return (
                    <tr
                      key={buyer.id}
                      className="border-b border-border last:border-0 hover:bg-muted/20 transition-colors"
                    >
                      <td className="px-4 py-3">
                        <div>
                          <p className="font-medium text-foreground">
                            {buyer.buyerName || buyer.buyerEmail}
                          </p>
                          {buyer.buyerCompany && (
                            <p className="text-xs text-muted-foreground mt-0.5">
                              {buyer.buyerCompany}
                            </p>
                          )}
                          {buyer.buyerName && (
                            <p className="text-xs text-muted-foreground/60">
                              {buyer.buyerEmail}
                            </p>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${status.className}`}
                        >
                          <StatusIcon className="h-3 w-3" />
                          {status.label}
                        </span>
                        {decision === "interested" &&
                          buyer.decisionNextStep && (
                            <p className="text-xs text-muted-foreground mt-1">
                              Next:{" "}
                              {buyer.decisionNextStep.replace(
                                /_/g,
                                " ",
                              )}
                            </p>
                          )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className="w-16 h-1.5 rounded-full bg-muted overflow-hidden">
                            <div
                              className="h-full rounded-full bg-teal transition-all"
                              style={{
                                width: `${Math.min(engagementScore, 100)}%`,
                              }}
                            />
                          </div>
                          <span className="text-xs tabular-nums text-muted-foreground">
                            {engagementScore}
                          </span>
                        </div>
                        <p
                          className={`text-xs mt-0.5 ${intentCfg.className}`}
                        >
                          {intentCfg.label} intent
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        {buyer.ndaSigned ? (
                          <span className="text-xs text-emerald-600 font-medium">
                            Signed
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            Pending
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <p className="text-xs text-muted-foreground">
                          {views} views · {timeLabel}
                        </p>
                        <p className="text-xs text-muted-foreground/60">
                          {lastActive}
                        </p>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Pending Approvals */}
      <section className="pt-4 border-t border-border">
        <div className="mb-3">
          <h2 className="text-base font-semibold">Pending Approvals</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Buyers awaiting broker and seller sign-off before CIM access.
          </p>
        </div>
        <BuyerApprovalsPanel dealId={dealId} />
      </section>

      {/* Outreach & Matching */}
      <section className="pt-4 border-t border-border">
        <div className="mb-3">
          <h2 className="text-base font-semibold">Outreach & Matching</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Find buyers by criteria match, then draft and send outreach
            emails.
          </p>
        </div>
        <div className="space-y-6">
          <SuggestedBuyersPanel dealId={dealId} />
          <BuyerMatchingPanel dealId={dealId} />
        </div>
      </section>
    </div>
  );
}
