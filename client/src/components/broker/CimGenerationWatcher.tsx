/**
 * CimGenerationWatcher — app-wide "your CIM is ready" notification.
 *
 * Mounted once in the broker layout. Polls the broker's live generation jobs
 * (fast while any is running, slowly otherwise so a job started before a
 * page refresh is still picked up) and toasts when one finishes, with a
 * button to open the deal. Also refreshes that deal's CIM caches so an open
 * Overview/Designer shows the new sections without a manual reload.
 */
import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { invalidateCimCaches } from "@/hooks/useCimGeneration";
import type { CimGenerationStatus } from "@shared/schema";
import { generationSummary } from "@shared/cim-generation-warnings";

interface BrokerJob extends CimGenerationStatus {
  dealId: string;
  businessName: string;
}

export function CimGenerationWatcher() {
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  const { data } = useQuery<BrokerJob[]>({
    queryKey: ["/api/broker/cim-generation"],
    queryFn: async () => {
      const r = await fetch("/api/broker/cim-generation", { credentials: "include" });
      if (!r.ok) return [];
      const body = await r.json();
      return Array.isArray(body?.jobs) ? body.jobs : [];
    },
    refetchInterval: (query) =>
      (query.state.data ?? []).some((j) => j.status === "running") ? 4000 : 20000,
    refetchIntervalInBackground: true,
  });

  // dealId → "<startedAt>:<status>" last seen. A job is announced once, on
  // the transition from running to done/failed that we actually observed.
  const seen = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    if (!data) return;
    for (const job of data) {
      const key = `${job.startedAt}:${job.status}`;
      const prev = seen.current.get(job.dealId);
      seen.current.set(job.dealId, key);
      if (prev === key) continue;
      const wasRunning = prev?.startsWith(`${job.startedAt}:running`);
      if (!wasRunning || job.status === "running") continue;

      invalidateCimCaches(job.dealId);
      const open = (
        <ToastAction altText="Open deal" onClick={() => setLocation(`/deal/${job.dealId}/${job.status === "done" ? "cim" : "overview"}`)}>
          Open
        </ToastAction>
      );
      if (job.status === "done") {
        const n = job.sectionCount ?? job.done;
        // Placeholders are counted apart from the other notes (every warning
        // used to be called "fell back to a placeholder").
        const summary = generationSummary(n, job.warnings);
        toast({
          // "Ready" only when every section was written — a run with
          // placeholders says so in the title, not just the description.
          title: summary.attention ? `CIM written with gaps — ${job.businessName}` : `CIM ready — ${job.businessName}`,
          description: job.buyerHold
            ? `${summary.text} Buyers don't see it until you publish it again.`
            : summary.text,
          variant: summary.attention ? "destructive" : undefined,
          duration: 12000,
          action: open,
        });
      } else if (job.stoppedBy === "discrepancies") {
        toast({
          title: job.stoppedReason === "new" ? `New conflicts to review — ${job.businessName}` : `Resolve discrepancies first — ${job.businessName}`,
          description: job.error || "The check found a critical conflict. Nothing was written.",
          duration: 12000,
          action: open,
        });
      } else {
        toast({
          title: `CIM generation failed — ${job.businessName}`,
          description: job.error || "Try again from the deal.",
          variant: "destructive",
          duration: 12000,
          action: open,
        });
      }
    }
  }, [data, toast, setLocation]);

  return null;
}
