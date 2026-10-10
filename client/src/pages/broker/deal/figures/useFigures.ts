/**
 * useFigures — the Numbers & sources workspace's data (spec §5.2, §10.1):
 * GET /api/deals/:id/figures, a deterministic refresh once when the
 * workspace opens, a 2 s poll of the read-only /figures/status while a
 * refresh or the AI pass runs, and every broker action. Every mutation
 * invalidates the workspace and the builder's figure-layer previews.
 */
import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { FiguresWorkspace } from "@shared/figure-workspace";
import type { FigureBuildStatus } from "@shared/schema";

/** An error the server answered with (status + its JSON body). */
export class FiguresError extends Error {
  status: number;
  body: any;
  constructor(status: number, body: any) {
    super(typeof body?.message === "string" ? body.message : typeof body?.error === "string" ? body.error : `Request failed (${status})`);
    this.status = status;
    this.body = body;
  }
}

export async function figuresRequest<T = any>(method: string, url: string, data?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: data !== undefined ? { "Content-Type": "application/json" } : {},
    body: data !== undefined ? JSON.stringify(data) : undefined,
    credentials: "include",
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { error: text };
  }
  if (!res.ok) throw new FiguresError(res.status, body);
  return body as T;
}

export function figuresKey(dealId: string) {
  return ["/api/deals", dealId, "figures"] as const;
}

export interface FiguresStatus {
  build: FigureBuildStatus | null;
  refreshedAt: string | null;
  version: string | null;
  ddShownAt: string | null;
  counts?: { notesWaiting: number; notesApproved: number; ownerFlagged?: number; questionsSuggested: number; questionsWithSeller: number };
}

/** Invalidate everything that shows the figures (workspace, status, the builder's previews, the CIM tab lines). */
export function useInvalidateFigures(dealId: string) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: figuresKey(dealId) });
    qc.invalidateQueries({ queryKey: ["/api/deals", dealId, "figure-layer"] });
  };
}

export function useFiguresWorkspace(dealId: string) {
  const qc = useQueryClient();
  const invalidate = useInvalidateFigures(dealId);
  const ws = useQuery<FiguresWorkspace>({
    queryKey: figuresKey(dealId),
    queryFn: () => figuresRequest("GET", `/api/deals/${dealId}/figures`),
  });
  // A deterministic refresh once when the workspace opens ($0; the server joins a running one).
  const refreshed = useRef(false);
  const refresh = useMutation({
    mutationFn: () => figuresRequest("POST", `/api/deals/${dealId}/figures/refresh`),
    onSettled: () => invalidate(),
  });
  useEffect(() => {
    if (refreshed.current) return;
    refreshed.current = true;
    refresh.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dealId]);

  const running = ws.data?.status.build?.status === "running" || refresh.isPending || !!ws.data?.status.stale;
  // Poll the read-only status (never the workspace itself) while something runs.
  const status = useQuery<FiguresStatus>({
    queryKey: [...figuresKey(dealId), "status"],
    queryFn: () => figuresRequest("GET", `/api/deals/${dealId}/figures/status`),
    enabled: running,
    refetchInterval: running ? 2000 : false,
  });
  const lastSeen = useRef<string | null>(null);
  useEffect(() => {
    const v = `${status.data?.version ?? ""}|${status.data?.build?.status ?? ""}`;
    if (!status.data) return;
    if (lastSeen.current !== null && lastSeen.current !== v) qc.invalidateQueries({ queryKey: figuresKey(dealId) });
    lastSeen.current = v;
  }, [status.data, qc, dealId]);

  return { ws, refresh, running, buildRunning: ws.data?.status.build?.status === "running" || status.data?.build?.status === "running" };
}

export function useFigureActions(dealId: string) {
  const invalidate = useInvalidateFigures(dealId);
  const base = `/api/deals/${dealId}/figures`;
  const opts = { onSuccess: () => invalidate() };
  return {
    build: useMutation({ mutationFn: (scope?: "changed" | "all") => figuresRequest("POST", `${base}/build`, { scope: scope ?? "changed" }), ...opts }),
    patchNote: useMutation({
      mutationFn: (v: { id: string; version: string; action?: "approve" | "hide" | "restore" | "use_proposal"; text?: string; blindText?: string | null }) =>
        figuresRequest<{ note: any; warnings: Array<{ field: string; message: string }> }>("PATCH", `${base}/notes/${encodeURIComponent(v.id)}`, {
          version: v.version, ...(v.action ? { action: v.action } : {}), ...(v.text !== undefined ? { text: v.text } : {}), ...(v.blindText !== undefined ? { blindText: v.blindText } : {}),
        }),
      ...opts,
    }),
    approveNotes: useMutation({ mutationFn: (ids: string[]) => figuresRequest<{ approved: number; skipped: Array<{ id: string; reason: string }> }>("POST", `${base}/notes/approve`, { ids }), ...opts }),
    writeNote: useMutation({
      mutationFn: (v: { figureKey: string; kind: "movement" | "difference" | "context"; compareKey?: string; text: string; blindText?: string | null; fromHint?: boolean; fromQuestionId?: string }) =>
        figuresRequest<{ note: any; warnings: Array<{ field: string; message: string }> }>("POST", `${base}/notes`, v),
      ...opts,
    }),
    putCheck: useMutation({
      mutationFn: (v: { checkKey: string; state: "shown" | "left_out" | "corrected"; reason?: string; correctedValue?: number }) => figuresRequest("PUT", `${base}/checks`, v),
      ...opts,
    }),
    showChecks: useMutation({ mutationFn: (keys: string[]) => figuresRequest<{ shown: number; refused: Array<{ key: string; reason: string }> }>("POST", `${base}/checks/show`, { keys }), ...opts }),
    publish: useMutation({
      mutationFn: (v: { notes: Array<{ id: string; fingerprint?: string }>; checkKeys: string[]; leaveOut?: string[]; turnOnChecks: boolean }) =>
        figuresRequest<{ approved: number; shown: number; leftOut: number; checksOn: boolean; refused: Array<{ key: string; reason: string }>; skippedNotes: Array<{ id: string; reason: string }> }>("POST", `${base}/publish`, v),
      ...opts,
    }),
    settings: useMutation({ mutationFn: (v: { autoAsk?: boolean; ddChecksOn?: boolean }) => figuresRequest("PUT", `${base}/settings`, v), ...opts }),
    ask: useMutation({
      mutationFn: (v: { questionIds?: string[]; figureKeys?: string[]; preview?: boolean }) =>
        figuresRequest<AskResult>("POST", `${base}/questions/ask${v.preview ? "?preview=1" : ""}`, { questionIds: v.questionIds ?? [], figureKeys: v.figureKeys ?? [] }),
      onSuccess: (_r, v) => { if (!v.preview) invalidate(); },
    }),
    patchQuestion: useMutation({ mutationFn: (v: { id: string; action: "not_needed" | "reopen" }) => figuresRequest("PATCH", `${base}/questions/${encodeURIComponent(v.id)}`, { action: v.action }), ...opts }),
  };
}

export interface AskResult {
  interviewFinished: boolean;
  waiting: number;
  emailed: number;
  addressed: number;
  recentlyEmailed?: boolean;
  listed: Array<{ kind: "figure" | "discrepancy" | "item" | "document"; label: string }>;
  neverAsked: number;
  stamped: number;
  figureQuestions: number;
  figuresRouted: number;
  preview?: boolean;
  questionIds: string[];
  /** Figures the seller is never asked about (earnings, taxes, pay, a year to fix first), with why. */
  refused?: Array<{ figureKey: string; reason: string }>;
}

/** The plain-language toast text for an error from these routes. */
export function figuresErrorText(e: unknown): string {
  if (e instanceof FiguresError) return e.message;
  return "Something went wrong. Try again in a moment.";
}

/** Money as the broker reads it ("$1,378,500"). */
export function money(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return `${n < 0 ? "−" : ""}$${Math.round(Math.abs(n)).toLocaleString("en-US")}`;
}

/** "+$1,378,500" / "−$660,000". */
export function signedMoney(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : "−"}$${Math.round(Math.abs(n)).toLocaleString("en-US")}`;
}

/** "Oct 9". */
export function shortDate(v: string | null | undefined): string {
  if (!v) return "";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
