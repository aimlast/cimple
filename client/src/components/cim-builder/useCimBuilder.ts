/**
 * useCimBuilder — the builder's state and every action on it.
 *
 * Polls every 2s while the AI is working on a section or a blind version is
 * catching up, and toasts when background work finishes (a rewrite proposal
 * is ready, a new section was written, a conversion failed…).
 */
import { useCallback, useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import type { CimSectionAiTask } from "@shared/schema";
import {
  TASK_LABEL,
  builderKey,
  builderRequest,
  errorText,
  type BuilderSection,
  type BuilderState,
} from "./api";

export interface AddSectionInput {
  title: string;
  layoutType: string;
  mode: "blank" | "ai";
  brief?: string;
  afterSectionId?: string | null;
  position?: "start" | "end";
  accessTier?: "teaser" | "full";
}

export function useCimBuilder(dealId: string) {
  const qc = useQueryClient();
  const { toast: rawToast } = useToast();
  // Toasts sit top-right, over the builder's toolbar — keep confirmations
  // brief (errors stay longer).
  const toast = useCallback(
    (t: Parameters<typeof rawToast>[0]) => rawToast({ duration: t.variant === "destructive" ? 7000 : 3000, ...t }),
    [rawToast],
  );

  const query = useQuery<BuilderState>({
    queryKey: builderKey(dealId),
    enabled: !!dealId,
    queryFn: () => builderRequest<BuilderState>("GET", `/api/deals/${dealId}/cim-builder`),
    refetchInterval: (q) => {
      const s = q.state.data as BuilderState | undefined;
      if (!s) return false;
      const busy =
        s.sections.some((x) => x.aiTask?.status === "running") ||
        s.blind.running ||
        // Held-back sections aren't counted in `updating`; stop polling only
        // on a whole-run failure (an error with nothing held back).
        (s.blind.generated && s.blind.updating > 0 && !(s.blind.error && !s.blind.held));
      return busy ? 2000 : false;
    },
  });

  // ── Completion toasts: compare each section's task with the last poll ──
  const prevTasks = useRef<Map<string, CimSectionAiTask | null> | null>(null);
  useEffect(() => {
    const sections = query.data?.sections;
    if (!sections) return;
    const prev = prevTasks.current;
    if (prev) {
      for (const s of sections) {
        const before = prev.get(s.id);
        if (before?.status !== "running") continue;
        const now = s.aiTask;
        if (!now || now.id !== before.id) {
          toast({ title: `${TASK_LABEL[before.kind]} finished`, description: `“${s.sectionTitle}” is updated. Undo is available in the editor.` });
        } else if (now.status === "ready") {
          toast({ title: "Rewrite ready", description: `Preview it on “${s.sectionTitle}”, then apply or discard.` });
        } else if (now.status === "failed") {
          toast({ title: `${TASK_LABEL[now.kind]} didn't finish`, description: now.error || "Please try again.", variant: "destructive" });
        }
      }
    }
    prevTasks.current = new Map(sections.map((s) => [s.id, s.aiTask]));
  }, [query.data?.sections, toast]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: builderKey(dealId) });
    // Other screens that show this CIM (Overview, CIM tab) read these.
    qc.invalidateQueries({ queryKey: ["/api/deals", dealId, "cim-sections"] });
    qc.invalidateQueries({ queryKey: ["/api/deals", dealId, "cim-overrides"] });
  };

  /** A mutation that refreshes the builder and toasts the server's error. */
  function useAction<V, R = any>(fn: (v: V) => Promise<R>, failTitle: string, onDone?: (r: R, v: V) => void) {
    return useMutation({
      mutationFn: fn,
      onSuccess: (r, v) => {
        refresh();
        onDone?.(r, v);
      },
      onError: (e) => {
        refresh();
        toast({ title: failTitle, description: errorText(e), variant: "destructive" });
      },
    });
  }

  const patch = useAction(
    ({ id, ...body }: { id: string } & Record<string, unknown>) => builderRequest("PATCH", `/api/cim-sections/${id}`, body),
    "Couldn't save",
  );

  // Optimistic: the list moves immediately, the server confirms.
  const reorder = useMutation({
    mutationFn: (orderedIds: string[]) =>
      builderRequest("POST", `/api/deals/${dealId}/cim-sections/reorder`, { orderedIds }),
    onMutate: async (orderedIds) => {
      await qc.cancelQueries({ queryKey: builderKey(dealId) });
      const before = qc.getQueryData<BuilderState>(builderKey(dealId));
      if (before) {
        const byId = new Map(before.sections.map((s) => [s.id, s]));
        const next = orderedIds.map((id, i) => ({ ...byId.get(id)!, order: i })).filter((s) => s.id);
        qc.setQueryData<BuilderState>(builderKey(dealId), { ...before, sections: next });
      }
      return { before };
    },
    onError: (e, _v, ctx) => {
      if (ctx?.before) qc.setQueryData(builderKey(dealId), ctx.before);
      toast({ title: "Couldn't save the new order", description: errorText(e), variant: "destructive" });
    },
    onSettled: refresh,
  });

  const add = useAction(
    (input: AddSectionInput) =>
      builderRequest<{ section: BuilderSection; startedHidden?: boolean }>("POST", `/api/deals/${dealId}/cim-sections`, input),
    "Couldn't add the section",
    (r, v) =>
      toast({
        title: v.mode === "ai" ? "Writing your new section" : "Section added",
        description: [
          v.mode === "ai" ? "The AI is drafting it from the deal's information — about 20-40 seconds." : "",
          r.startedHidden ? "It starts hidden because this CIM is live — show it to buyers when it's ready." : "",
        ].filter(Boolean).join(" ") || undefined,
      }),
  );

  const remove = useAction(
    (id: string) => builderRequest("DELETE", `/api/cim-sections/${id}`),
    "Couldn't delete the section",
    () => toast({ title: "Section deleted" }),
  );

  const duplicate = useAction(
    (id: string) => builderRequest<{ section: BuilderSection; startedHidden?: boolean }>("POST", `/api/cim-sections/${id}/duplicate`),
    "Couldn't duplicate the section",
    (r) => toast({ title: "Section duplicated", description: r.startedHidden ? "The copy starts hidden because this CIM is live." : undefined }),
  );

  const setLayout = useAction(
    ({ id, layoutType, convert }: { id: string; layoutType: string; convert: "ai" | "blank" }) =>
      builderRequest("PATCH", `/api/cim-sections/${id}/layout`, { layoutType, convert }),
    "Couldn't change the layout",
    (_r, v) =>
      toast({
        title: v.convert === "ai" ? "Converting with AI" : "Layout changed",
        description: v.convert === "ai" ? "Your content is being moved into the new layout — about 20-40 seconds." : "Undo brings the previous layout back.",
      }),
  );

  const rewrite = useAction(
    ({ id, ...body }: { id: string; instructions: string; tones: string[]; length: string }) =>
      builderRequest("POST", `/api/cim-sections/${id}/rewrite`, body),
    "Couldn't start the rewrite",
  );

  const applyRewrite = useAction(
    (id: string) => builderRequest("POST", `/api/cim-sections/${id}/apply-rewrite`),
    "Couldn't apply the rewrite",
    () => toast({ title: "Rewrite applied", description: "Undo brings the previous version back." }),
  );

  const discardTask = useAction(
    (id: string) => builderRequest("POST", `/api/cim-sections/${id}/discard-task`),
    "Couldn't discard",
  );

  const undo = useAction(
    (id: string) => builderRequest("POST", `/api/cim-sections/${id}/undo`),
    "Couldn't undo",
    () => toast({ title: "Previous version restored" }),
  );

  const regenerate = useAction(
    ({ id, brief }: { id: string; brief?: string }) => builderRequest("POST", `/api/cim-sections/${id}/regenerate`, { brief }),
    "Couldn't start regenerating",
    () => toast({ title: "Regenerating from the deal's information", description: "About 20-40 seconds. The current version is kept for undo." }),
  );

  const refreshBlind = useAction(
    () => builderRequest("POST", `/api/deals/${dealId}/cim-blind/refresh`),
    "Couldn't retry the blind version",
  );

  return { query, refresh, patch, reorder, add, remove, duplicate, setLayout, rewrite, applyRewrite, discardTask, undo, regenerate, refreshBlind };
}

export type CimBuilderApi = ReturnType<typeof useCimBuilder>;
