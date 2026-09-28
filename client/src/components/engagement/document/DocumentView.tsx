/**
 * Document view — the heat map on the real CIM: "How far buyers got", a
 * page rail (tiles / table), the selected page rendered from the rendition
 * the buyers saw (CimMediaProvider → CimDesignProvider → CimSheet →
 * CimSectionRenderer inside a <CimBlocksProvider> so every block carries
 * data-cim-block) with the brass heat overlay measured over those blocks,
 * and the "This page" panel.
 *
 * Owned by the VIEWER stream. Base stub: page list from the API.
 */
import { formatReadingTime } from "@shared/analytics-v2";
import { useEngagementDocument } from "@/hooks/useEngagement";
import { Skeleton } from "@/components/ui/skeleton";
import type { EngagementViewProps } from "../types";

export function DocumentView({ dealId, filters }: EngagementViewProps) {
  const { data, isLoading, error } = useEngagementDocument(dealId, filters);
  if (isLoading) return <Skeleton className="h-64 w-full" />;
  if (error || !data) return <p className="text-sm text-muted-foreground">Couldn't load reading by page.</p>;
  if (data.pages.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="engagement-document-empty">
        When buyers open the CIM, you'll see which pages and numbers they study.
      </p>
    );
  }
  return (
    <ol className="space-y-1" data-testid="engagement-document">
      {data.pages.map((p) => (
        <li key={`${p.pageId}#${p.part}`} className="flex justify-between text-sm">
          <span>{p.label} · {p.title}</span>
          <span className="text-muted-foreground">{formatReadingTime(p.attentionMs)}</span>
        </li>
      ))}
    </ol>
  );
}
