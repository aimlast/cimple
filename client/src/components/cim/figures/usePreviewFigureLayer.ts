/**
 * usePreviewFigureLayer — the broker's preview of a buyer version's figure
 * layer (GET /api/deals/:id/figure-layer?level=…, spec D21): everything shown,
 * with marks on what buyers don't see yet, plus the DD check page to insert.
 * While the server refreshes the figures (a stale deal), it polls every 3 s.
 */
import { useQuery } from "@tanstack/react-query";
import type { FigureLayer } from "@shared/figure-layer";

export interface PreviewFigureLayer {
  layer: FigureLayer | null;
  extraSections: Array<{ afterId: string | null; section: any }>;
  refreshing: boolean;
  dropped?: string;
  noFigures?: "no_analysis" | "analysis_out_of_date" | null;
  hasOtherRecords?: boolean;
}

export function usePreviewFigureLayer(dealId: string | null | undefined, level: string | null | undefined) {
  const enabled = !!dealId && !!level && level !== "editor";
  const q = useQuery<PreviewFigureLayer>({
    queryKey: ["/api/deals", dealId, "figure-layer", level],
    enabled,
    queryFn: async () => {
      const res = await fetch(`/api/deals/${dealId}/figure-layer?level=${encodeURIComponent(String(level))}`, { credentials: "include" });
      if (!res.ok) throw new Error(`figure layer ${res.status}`);
      return res.json();
    },
    refetchInterval: (query) => ((query.state.data as PreviewFigureLayer | undefined)?.refreshing ? 3000 : false),
  });
  return {
    data: q.data ?? null,
    loading: enabled && q.isLoading,
    failed: enabled && q.isError,
  };
}

/** The sections with the preview's extra pages (DD "How the figures check out") inserted after their anchors. */
export function withPreviewExtras<T extends { id: string }>(sections: T[], extras: PreviewFigureLayer["extraSections"] | undefined): T[] {
  if (!extras || extras.length === 0) return sections;
  const out = [...sections];
  for (const x of extras) {
    if (out.some((s) => s.id === x.section.id)) continue;
    const i = x.afterId ? out.findIndex((s) => s.id === x.afterId) : -1;
    out.splice(i >= 0 ? i + 1 : out.length, 0, x.section as T);
  }
  return out;
}
