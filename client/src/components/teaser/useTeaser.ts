/**
 * useTeaser — the full teaser state (Teaser tab, editor) and every action on
 * it. Mutations send the draft's `rev` and get the whole state back, which
 * replaces the cache (no optimistic edits except reorder). A 409 "stale"
 * carries the latest state: it replaces the cache with "This teaser changed
 * in another tab — showing the latest". Polls every 2 s while Cimple writes.
 */
import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { builderKey } from "@/components/cim-builder/api";
import {
  TeaserApiError,
  hasTeaser,
  teaserKey,
  teaserRequest,
  teaserSummaryKey,
  teaserTemplatesKey,
  type SavedTemplateItem,
  type TeaserRead,
  type TeaserState,
} from "./api";

export interface AddBlockInput {
  after: string | null;
  layoutType: string;
  title: string;
  mode: "blank" | "ai";
  brief?: string | null;
}

export interface BlockProposal {
  title: string;
  layoutType: string;
  layoutData: Record<string, unknown>;
  body: string | null;
  pinpoint: string[];
}

export const STALE_SENTENCE = "This teaser changed in another tab — showing the latest";

export function useTeaser(dealId: string) {
  const qc = useQueryClient();
  const { toast: rawToast } = useToast();
  const toast = useCallback(
    (t: Parameters<typeof rawToast>[0]) => rawToast({ duration: t.variant === "destructive" ? 7000 : 3000, ...t }),
    [rawToast],
  );

  const query = useQuery<TeaserRead>({
    queryKey: teaserKey(dealId),
    enabled: !!dealId,
    queryFn: () => teaserRequest<TeaserRead>("GET", `/api/deals/${dealId}/teaser`),
    refetchInterval: (q) => {
      const d = q.state.data as TeaserRead | undefined;
      const running = hasTeaser(d) ? d.teaser.generation?.status === "running" : d?.summary?.generation?.status === "running";
      return running ? 2000 : false;
    },
  });

  const state = hasTeaser(query.data) ? query.data : null;
  const rev = state?.teaser.draftRev ?? 0;

  const others = () => {
    qc.invalidateQueries({ queryKey: teaserSummaryKey(dealId) });
    qc.invalidateQueries({ queryKey: builderKey(dealId) });
    qc.invalidateQueries({ queryKey: ["/api/deals", dealId, "teaser", "preview"] });
  };
  const accept = (s: TeaserState) => {
    qc.setQueryData(teaserKey(dealId), s);
    others();
  };
  const refresh = () => {
    qc.invalidateQueries({ queryKey: teaserKey(dealId) });
    others();
  };

  /** One handler for every failure: stale → latest state; writing / refused → their sentence. */
  const fail = (title: string) => (err: unknown) => {
    if (err instanceof TeaserApiError && err.code === "stale") {
      if (err.body?.teaser) accept(err.body.teaser as TeaserState);
      else refresh();
      toast({ title: STALE_SENTENCE });
      return;
    }
    if (err instanceof TeaserApiError && err.code === "writing") {
      toast({ title: "Cimple is writing your teaser", description: err.message });
      refresh();
      return;
    }
    if (err instanceof TeaserApiError && err.code === "no_teaser") {
      refresh();
    }
    toast({ title, description: err instanceof Error ? err.message : undefined, variant: "destructive" });
  };

  const base = `/api/deals/${dealId}/teaser`;
  const stateMutation = <V,>(title: string, fn: (v: V) => Promise<TeaserState>, done?: (s: TeaserState, v: V) => void) =>
    useMutation<TeaserState, unknown, V>({
      mutationFn: fn,
      onSuccess: (s, v) => {
        accept(s);
        done?.(s, v);
      },
      onError: fail(title),
    });

  const generate = useMutation<unknown, unknown, { templateKey: string; replace?: boolean }>({
    mutationFn: (v) => teaserRequest("POST", `${base}/generate`, v),
    onSuccess: () => refresh(),
    // has_draft is asked about by the caller (it has the confirmation dialog).
    onError: (err) => {
      if (err instanceof TeaserApiError && (err.code === "has_draft" || err.code === "gate")) return;
      fail("Couldn't start writing the teaser")(err);
    },
  });
  const fromTemplate = useMutation<TeaserState, unknown, { templateKey: string; replace?: boolean }>({
    mutationFn: (v) => teaserRequest<TeaserState>("POST", `${base}/from-template`, v),
    onSuccess: (s) => accept(s),
    onError: (err) => {
      if (err instanceof TeaserApiError && (err.code === "has_draft" || err.code === "gate")) return;
      fail("Couldn't start the teaser")(err);
    },
  });

  const settings = stateMutation<Record<string, unknown>>("Couldn't save the settings", (patch) => teaserRequest("PATCH", `${base}/settings`, { rev, ...patch }));
  const header = stateMutation<{ label?: string; tagline?: string; chips?: string[] }>("Couldn't save the header", (patch) => teaserRequest("PATCH", `${base}/header`, { rev, ...patch }));
  const addBlock = useMutation<TeaserState & { warning?: string }, unknown, AddBlockInput>({
    mutationFn: (v) => teaserRequest("POST", `${base}/blocks`, { rev, after: v.after, layoutType: v.layoutType, title: v.title, mode: v.mode, brief: v.brief ?? null }),
    onSuccess: (s) => {
      accept(s);
      if (s.warning) toast({ title: "Check the new block", description: s.warning });
    },
    onError: fail("Couldn't add the block"),
  });
  const patchBlock = stateMutation<{ id: string; title?: string; layoutData?: Record<string, unknown>; body?: string | null; hidden?: boolean }>(
    "Couldn't save the block",
    ({ id, ...patch }) => teaserRequest("PATCH", `${base}/blocks/${id}`, { rev, ...patch }),
  );
  const patchCell = stateMutation<{ id: string; key: string; value?: string; reset?: boolean }>(
    "Couldn't save the key number",
    ({ id, key, value, reset }) => teaserRequest("PATCH", `${base}/blocks/${id}/cells/${encodeURIComponent(key)}`, reset ? { rev, reset: true } : { rev, value }),
  );
  const removeBlock = stateMutation<string>("Couldn't delete the block", (id) => teaserRequest("DELETE", `${base}/blocks/${id}?rev=${rev}`));
  const duplicate = stateMutation<string>("Couldn't duplicate the block", (id) => teaserRequest("POST", `${base}/blocks/${id}/duplicate`, { rev }));
  const reorder = useMutation<TeaserState, unknown, string[], { previous?: TeaserRead }>({
    mutationFn: (ids) => teaserRequest("POST", `${base}/reorder`, { rev, ids }),
    onMutate: (ids) => {
      const previous = qc.getQueryData<TeaserRead>(teaserKey(dealId));
      if (hasTeaser(previous)) {
        const byId = new Map(previous.teaser.draft.blocks.map((b) => [b.id, b]));
        const blocks = ids.map((id) => byId.get(id)).filter((b): b is NonNullable<typeof b> => !!b);
        qc.setQueryData<TeaserRead>(teaserKey(dealId), { ...previous, teaser: { ...previous.teaser, draft: { ...previous.teaser.draft, blocks } } });
      }
      return { previous };
    },
    onSuccess: (s) => accept(s),
    onError: (err, _v, ctx) => {
      if (ctx?.previous) qc.setQueryData(teaserKey(dealId), ctx.previous);
      fail("Couldn't move the blocks")(err);
    },
  });
  const setLayout = stateMutation<{ id: string; layoutType: string; convert: "blank" | "ai" }>(
    "Couldn't change the layout",
    ({ id, ...v }) => teaserRequest("PATCH", `${base}/blocks/${id}/layout`, { rev, ...v }),
  );
  const rewrite = useMutation<{ proposal: BlockProposal }, unknown, { id: string; instructions?: string | null; tones?: string[]; length?: string | null }>({
    mutationFn: ({ id, ...v }) => teaserRequest("POST", `${base}/blocks/${id}/rewrite`, v),
    onError: (err) => toast({ title: "Couldn't rewrite the block", description: err instanceof Error ? err.message : undefined, variant: "destructive" }),
  });
  const reset = useMutation<TeaserState | { proposal: BlockProposal }, unknown, string>({
    mutationFn: (id) => teaserRequest("POST", `${base}/blocks/${id}/reset`, { rev }),
    onSuccess: (r) => {
      if ("teaser" in r) accept(r);
    },
    onError: fail("Couldn't reset the block"),
  });
  const undo = useMutation<TeaserState, unknown, void>({
    mutationFn: () => teaserRequest("POST", `${base}/undo`, { rev }),
    onSuccess: (s) => {
      accept(s);
      toast({ title: "Undone" });
    },
    onError: (err) => {
      if (err instanceof TeaserApiError && err.code === "nothing_to_undo") {
        toast({ title: "There's nothing to undo." });
        return;
      }
      fail("Couldn't undo")(err);
    },
  });
  const confirmReview = stateMutation<void>("Couldn't save your confirmation", () => teaserRequest("POST", `${base}/confirm-review`, { rev }));
  const publish = useMutation<TeaserState, unknown, void>({
    mutationFn: () => teaserRequest("POST", `${base}/publish`, { rev }),
    onSuccess: (s) => {
      accept(s);
      toast({ title: "Teaser published", description: "Buyers with a teaser link see exactly this version." });
    },
    // cant_publish is shown by the caller (the publish dialog lists the problems).
    onError: (err) => {
      if (err instanceof TeaserApiError && err.code === "cant_publish") return;
      fail("Couldn't publish the teaser")(err);
    },
  });
  const unpublish = stateMutation<void>("Couldn't take the teaser offline", () => teaserRequest("POST", `${base}/unpublish`), () =>
    toast({ title: "The teaser is offline", description: "Buyers with a teaser link see “not available right now” until you publish it again." }),
  );
  const remove = useMutation<null, unknown, void>({
    mutationFn: () => teaserRequest("DELETE", base),
    onSuccess: () => {
      refresh();
      toast({ title: "Teaser deleted" });
    },
    onError: fail("Couldn't delete the teaser"),
  });
  const sellerCheck = stateMutation<void>("Couldn't send the teaser to the seller", () => teaserRequest("POST", `${base}/seller-check`, { rev }), () =>
    toast({ title: "Sent to the seller", description: "They'll see it on their review page. Nothing goes to buyers until you publish." }),
  );
  const saveTemplate = useMutation<{ template: SavedTemplateItem }, unknown, { name: string; makeDefault?: boolean }>({
    mutationFn: (v) => teaserRequest("POST", `${base}/save-template`, v),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: teaserTemplatesKey });
      qc.invalidateQueries({ queryKey: teaserKey(dealId) });
      toast({ title: `Saved “${r.template.name}”`, description: "It's in “Your templates” the next time you start a teaser." });
    },
    onError: (err) => toast({ title: "Couldn't save the template", description: err instanceof Error ? err.message : undefined, variant: "destructive" }),
  });

  return {
    query,
    state,
    rev,
    refresh,
    generate,
    fromTemplate,
    settings,
    header,
    addBlock,
    patchBlock,
    patchCell,
    removeBlock,
    duplicate,
    reorder,
    setLayout,
    rewrite,
    reset,
    undo,
    confirmReview,
    publish,
    unpublish,
    remove,
    sellerCheck,
    saveTemplate,
  };
}

export type TeaserApi = ReturnType<typeof useTeaser>;
