/**
 * "Last session together: 9 Oct · 24 min · 9 answers filed · View summary"
 * — one line on the Overview's checklist card (specs/together.md §4.7).
 * The summary opens read-only.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { EndSessionDialog } from "./EndSessionDialog";
import { shortDate, type SittingListRow, type SittingSummary, type TogetherSittingView } from "@shared/together";

export const sittingsKey = (dealId: string) => ["/api/deals", dealId, "together-sittings"] as const;

export function useSittings(dealId: string) {
  return useQuery<SittingListRow[]>({
    queryKey: sittingsKey(dealId),
    queryFn: async () => {
      const r = await fetch(`/api/deals/${dealId}/together/sittings`, { credentials: "include" });
      if (!r.ok) throw new Error("Couldn't load the sessions");
      return r.json();
    },
    staleTime: 30_000,
  });
}

export function LastSessionTogether({ dealId }: { dealId: string }) {
  const { data } = useSittings(dealId);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<TogetherSittingView | null>(null);
  const last = data?.[0];
  if (!last) return null;
  const openSummary = async () => {
    const r = await fetch(`/api/deals/${dealId}/together/sittings/${last.id}?afterSeq=999999999`, { credentials: "include" });
    if (!r.ok) return;
    const d = (await r.json()) as { sitting: TogetherSittingView };
    setView(d.sitting);
    setOpen(true);
  };
  const live = last.status !== "ended";
  return (
    <div className="text-[11px] text-muted-foreground" data-testid="last-session-together">
      {live ? "Session together in progress" : "Last session together"}: {shortDate(last.startedAt)} · {last.durationMin < 1 ? "under a minute" : `${last.durationMin} min`}
      {!live && <> · {last.filed} {last.filed === 1 ? "answer" : "answers"} filed · <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => void openSummary()} data-testid="button-view-summary">View summary</button></>}
      {view && (
        <EndSessionDialog
          open={open}
          onOpenChange={setOpen}
          dealId={dealId}
          sitting={view}
          loadSummary={async () => {
            const r = await fetch(`/api/deals/${dealId}/together/sittings/${view.id}/summary`, { credentials: "include" });
            if (!r.ok) throw new Error("Couldn't load the summary");
            return (await r.json()) as SittingSummary;
          }}
          end={async () => { throw new Error("This session has already ended."); }}
          onDone={() => setOpen(false)}
        />
      )}
    </div>
  );
}
