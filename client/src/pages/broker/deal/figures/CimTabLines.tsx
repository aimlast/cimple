/**
 * The figure notes' lines on the CIM tab (spec §5.1; INTEGRATION §2.8 slots):
 *   FigureVersionLines      the Versions cards' extra lines — Full / Blind:
 *                           "9 figures have notes · 3 wait for your OK"; DD:
 *                           "27 figures checked · 3 differences (2 explained)",
 *                           "Review and show to buyers", a broker-only
 *                           "Fix first" line, and the way into Numbers & sources
 *   FigureNotesWaitingLine  the "Needs attention" row: "6 figure notes wait
 *                           for your OK · Review" (never blocks publishing)
 * INTEGRATOR: teaser's CimTab dashboard takes these through its tile,
 * Versions-card and attention slots, and registers NumbersWorkspace as the
 * `numbers` view in CIM_TAB_VIEWS (badge = notes waiting).
 */
import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Calculator } from "lucide-react";
import { nothingServedLine, publishTarget, type FiguresWorkspace } from "@shared/figure-workspace";
import { figuresKey, figuresRequest, type FiguresStatus } from "./useFigures";
import { ReviewSheet } from "./ReviewSheet";

function useWorkspace(dealId: string) {
  return useQuery<FiguresWorkspace>({ queryKey: figuresKey(dealId), queryFn: () => figuresRequest("GET", `/api/deals/${dealId}/figures`), staleTime: 30_000 });
}

function useFigureCounts(dealId: string) {
  return useQuery<FiguresStatus>({
    queryKey: [...figuresKey(dealId), "status", "counts"],
    queryFn: () => figuresRequest("GET", `/api/deals/${dealId}/figures/status?counts=1`),
    staleTime: 30_000,
  });
}

/** The badge count (notes waiting for the broker's OK), cheap. */
export function useFigureNotesWaiting(dealId: string): number {
  return useFigureCounts(dealId).data?.counts?.notesWaiting ?? 0;
}

export function FigureVersionLines({ dealId, mode }: { dealId: string; mode: "normal" | "blind" | "dd" }) {
  const [, navigate] = useLocation();
  const [review, setReview] = useState(false);
  const ws = useWorkspace(dealId);
  const d = ws.data;
  if (!d || !d.status.hasCim || d.status.noFigures) return null;
  const open = (tab?: string, filter?: string) => navigate(`/deal/${dealId}/cim?view=numbers${tab ? `&tab=${tab}` : ""}${filter ? `&filter=${filter}` : ""}`);
  // Counts read what buyers of each version are served now (the kept copy while an update waits) —
  // never the working copy alone (checker r1 F3). Without that (an error), the approved notes stand in.
  const sv = d.served;
  if (mode !== "dd") {
    const v = sv ? (mode === "blind" ? sv.blind : sv.normal) : null;
    const approved = [...d.moves.map((m) => m.note), ...d.otherNotes.map((o) => o.note)].filter((n) => n && n.status === "approved" && !n.staleReason);
    const n = v ? v.notes : mode === "blind" ? approved.filter((x) => x!.blindText).length : approved.length;
    // Not published yet (or held): buyers read nothing now — count what they read once it's published (checker r2 R2-2).
    const nothing = !!sv && (sv.notLive || sv.held);
    const what = publishTarget(sv);
    const later = v?.afterPublish ?? 0;
    return (
      <div className="space-y-0.5 text-[11px]" data-testid={`figure-lines-${mode}`}>
        <p className="text-muted-foreground">
          <Calculator className="mr-1 inline h-3 w-3" />
          {nothing ? (
            <>{later === 1 ? "1 figure has a note" : `${later} figures have notes`}{later > 0 && <> · <button type="button" className="text-teal hover:underline" onClick={() => open("moves", "publish")}>buyers read {later === 1 ? "it" : "them"} once you publish {what}</button></>}</>
          ) : (
            <>{n === 1 ? "1 figure has a note" : `${n} figures have notes`}
            {later > 0 && <> · <button type="button" className="text-teal hover:underline" onClick={() => open("moves", "publish")}>{later} more once you publish {what}</button></>}</>
          )}
          {d.kpis.waiting > 0 && <> · <button type="button" className="text-teal hover:underline" onClick={() => open("moves", "waiting")}>{d.kpis.waiting} wait for your OK</button></>}
        </p>
        {v?.dropped && (
          <p className="flex items-start gap-1 text-amber-500"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />Held back from the Blind CIM: {v.dropped}.</p>
        )}
      </div>
    );
  }
  // DD: the check page as due-diligence buyers read it (or would, once the checks are on).
  const s = sv ? sv.dd.summary ?? sv.dd.summaryIfOn : null;
  const checked = s ? s.checked : d.checks.filter((c) => c.decision !== "left_out").length;
  const differences = s ? s.regrouped + s.differing : d.kpis.differences;
  const explained = s ? s.regrouped + s.explained : d.kpis.differencesExplained;
  const pending = d.checks.filter((c) => c.group === "difference" && !c.shownToBuyers && c.onBuyerPage && !c.refusal && c.decision !== "left_out" && c.decision !== "shown").length;
  const mismatches = d.fixFirst.filter((f) => f.kind === "mismatch");
  return (
    <div className="space-y-1 text-[11px]" data-testid="figure-lines-dd">
      {d.status.hasOtherRecords ? (
        <p className="text-muted-foreground">
          <Calculator className="mr-1 inline h-3 w-3" />{checked} {checked === 1 ? "figure" : "figures"} checked · {differences} {differences === 1 ? "difference" : "differences"} ({explained === differences && differences > 0 ? "all explained" : `${explained} explained`})
          {pending > 0 && <> · <button type="button" className="text-teal hover:underline" onClick={() => open("checks")}>{pending} more {pending === 1 ? "waits" : "wait"} for your OK</button></>}
        </p>
      ) : (
        <p className="text-muted-foreground">No tax returns on file to compare with yet.</p>
      )}
      {nothingServedLine(sv) ? <p className="text-muted-foreground" data-testid="figure-lines-not-published">{nothingServedLine(sv)}</p>
        : sv?.keptCopy && <p className="text-muted-foreground">Buyers read the previous version until you publish the update.</p>}
      {!d.status.ddShownAt && d.status.hasOtherRecords && (
        <p className="text-foreground">Due-diligence buyers don't see these checks yet. <button type="button" className="text-teal hover:underline" onClick={() => setReview(true)}>Review and show to buyers</button></p>
      )}
      {mismatches.length > 0 && (
        <p className="flex items-start gap-1 text-amber-500"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />Fix first: {mismatches.length === 1 ? `CIM figures for FY${mismatches[0].year} differ` : `${mismatches.length} years of CIM figures differ`} from the statements.</p>
      )}
      <button type="button" className="text-teal hover:underline" onClick={() => open()} data-testid="link-numbers-sources">Numbers &amp; sources</button>
      <ReviewSheet dealId={dealId} open={review} onOpenChange={setReview} />
    </div>
  );
}

export function FigureNotesWaitingLine({ dealId }: { dealId: string }) {
  const [, navigate] = useLocation();
  const counts = useFigureCounts(dealId).data?.counts;
  const waiting = counts?.notesWaiting ?? 0;
  const flagged = counts?.ownerFlagged ?? 0;
  if (waiting === 0 && flagged === 0) return null;
  return (
    <div className="space-y-1.5">
      {flagged > 0 && (
        // The owner's "Change this" on their review page (D22): the note is hidden until the broker looks.
        <p className="flex flex-wrap items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs" data-testid="figure-notes-owner-flagged">
          <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
          <span>The owner asked for a change to {flagged === 1 ? "a note" : `${flagged} notes`} on the CIM's figures. Buyers don't see {flagged === 1 ? "it" : "them"} until you look.</span>
          <button type="button" className="text-teal hover:underline" onClick={() => navigate(`/deal/${dealId}/cim?view=numbers&tab=moves&filter=look`)}>Review</button>
        </p>
      )}
      {waiting > 0 && (
        <p className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-xs" data-testid="figure-notes-waiting">
          <Calculator className="h-3.5 w-3.5 text-teal" />
          <span>{waiting} figure {waiting === 1 ? "note waits" : "notes wait"} for your OK.</span>
          <button type="button" className="text-teal hover:underline" onClick={() => navigate(`/deal/${dealId}/cim?view=numbers&tab=moves&filter=waiting`)}>Review</button>
        </p>
      )}
    </div>
  );
}
