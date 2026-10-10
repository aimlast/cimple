/**
 * useDdRun — start the full due-diligence run (POST generate-dd, answered
 * 202) and announce its real outcome once it ends (dd-run.ts): written,
 * written with gaps, or not updated and why. Used by the CIM tab and the
 * CIM builder; the pending run is kept per deal outside React, so moving
 * between the two while it runs still announces it once.
 */
import { useEffect, useReducer } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { builderKey, builderRequest, errorText, type BuilderState } from "./api";
import { checkDdRun, ddRunToast, type PendingDdRun } from "./dd-run";

const pendingRuns = new Map<string, PendingDdRun>();

export function useDdRun(
  dealId: string,
  state: { dd: BuilderState["dd"] | undefined; fetchedAt: number; refetch: () => unknown },
) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const pending = pendingRuns.get(dealId) ?? null;

  const start = useMutation({
    mutationFn: () => builderRequest<{ startedAt?: string }>("POST", `/api/deals/${dealId}/generate-dd`),
    onSuccess: (r) => {
      if (r?.startedAt) pendingRuns.set(dealId, { startedAt: r.startedAt, acceptedAt: Date.now() });
      rerender();
      qc.invalidateQueries({ queryKey: builderKey(dealId) });
      toast({ title: "Writing the due-diligence version", description: "This runs in the background — you can leave this page." });
    },
    onError: (e) => {
      // "Add-backs in the books" may have held it (409 gl_trace_required): the notices follow.
      qc.invalidateQueries({ queryKey: ["/api/deals", dealId, "gl"] });
      toast({ title: "Couldn't generate the due-diligence version", description: errorText(e), variant: "destructive" });
    },
  });

  // Announce once, when this run's result is in the builder state.
  const { dd, fetchedAt } = state;
  useEffect(() => {
    const p = pendingRuns.get(dealId);
    if (!p) return;
    const check = checkDdRun(p, dd, fetchedAt);
    if (check.kind === "wait") return;
    pendingRuns.delete(dealId);
    rerender();
    toast(ddRunToast(check));
    qc.invalidateQueries({ queryKey: builderKey(dealId) });
    qc.invalidateQueries({ queryKey: ["/api/deals", dealId, "cim-overrides"] });
  }, [dealId, dd, fetchedAt, toast, qc]);

  // Keep the state fresh until then (the builder's own poll stops when the
  // run is no longer running — including a run that ended before its first poll).
  const { refetch } = state;
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => void refetch(), 2000);
    return () => clearInterval(t);
  }, [pending?.startedAt, refetch]);

  return {
    start: () => start.mutate(),
    /** Starting, writing, or waiting for this run's result. */
    busy: start.isPending || !!pending || !!dd?.running,
  };
}
