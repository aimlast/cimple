/**
 * "Your deals compared" (opened, reading this week, median reading time per
 * buyer, reached the end, NDA → Interested) and "What works in your CIMs"
 * (reading time by content kind and layout, your deals only; plus the
 * anonymous cross-brokerage benchmark when enough deals stand behind it).
 *
 * Owned by the INTELLIGENCE stream; placed by the VIEWER stream on
 * /broker/analytics. Base stub: the deal rows.
 */
import { useEngagementCompare } from "@/hooks/useEngagement";

export function ComparePanel() {
  const { data } = useEngagementCompare();
  if (!data) return null;
  return (
    <ul className="space-y-1 text-sm" data-testid="engagement-compare">
      {data.deals.map((d) => (
        <li key={d.dealId} className="flex justify-between">
          <span>{d.dealName}</span>
          <span className="text-muted-foreground">{d.opened} of {d.granted} opened</span>
        </li>
      ))}
    </ul>
  );
}
