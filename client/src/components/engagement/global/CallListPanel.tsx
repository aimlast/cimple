/**
 * "Who to call today, across your deals" — the merged call list of the
 * broker's own non-archived deals (top 15), for /broker/analytics.
 *
 * Owned by the INTELLIGENCE stream; the VIEWER stream places it on the
 * reworked Analytics page. Base stub: names and why.
 */
import { useCallList } from "@/hooks/useEngagement";

export function CallListPanel() {
  const { data } = useCallList();
  if (!data || data.entries.length === 0) {
    return <p className="text-sm text-muted-foreground">When buyers read your CIMs, the ones to call first show here.</p>;
  }
  return (
    <ul className="space-y-2" data-testid="call-list">
      {data.entries.map((e) => (
        <li key={`${e.dealId}:${e.accessId}`} className="text-sm">
          <span className="font-medium">{e.name}</span> · {e.dealName} · <span className="text-muted-foreground">{e.statusLabel}</span>
        </li>
      ))}
    </ul>
  );
}
