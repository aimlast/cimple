/**
 * The deal's media library (server/routes/cim-media.ts): list, upload with
 * progress, caption / blind-safe, delete.
 */
import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import type { CimMediaAssetInfo } from "@/components/cim/CimMediaContext";
import type { MediaAssetRef } from "@shared/cim-media";
import { BuilderApiError, builderKey, builderRequest, errorText } from "../api";

export interface MediaItem {
  id: string;
  dealId: string;
  kind: "image" | "video";
  mimeType: string;
  size: number;
  width: number | null;
  height: number | null;
  caption: string;
  blindSafe: boolean;
  originalName: string | null;
  createdAt: string;
  url: string;
  usedIn: Array<{ sectionId: string; sectionTitle: string }>;
}

/** Draft updates: a new value, or a function of the latest draft (for uploads that finish later). */
export type MediaDraftChange = (next: Record<string, any> | ((cur: Record<string, any>) => Record<string, any>)) => void;

export const mediaKey = (dealId: string) => ["/api/deals", dealId, "media"] as const;

export const IMAGE_ACCEPT = "image/jpeg,image/png,image/webp,image/gif";
export const VIDEO_ACCEPT = "video/mp4,video/webm,video/quicktime,.mov";

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** Quick client-side check before sending (the server re-checks the bytes). */
export function precheckFile(file: File, want?: "image" | "video"): string | null {
  const isImage = /^image\/(jpeg|png|webp|gif)$/.test(file.type);
  const isVideo = /^video\/(mp4|webm|quicktime)$/.test(file.type) || /\.(mp4|mov|webm)$/i.test(file.name);
  if (file.type === "image/svg+xml" || /\.svg$/i.test(file.name)) return `${file.name}: SVG files can't be used — export it as a PNG.`;
  if (want === "image" && !isImage) return `${file.name}: use a JPG, PNG, WebP or GIF photo.`;
  if (want === "video" && !isVideo) return `${file.name}: use an MP4, MOV or WebM video.`;
  if (!isImage && !isVideo) return `${file.name}: use a JPG, PNG, WebP or GIF photo, or an MP4, MOV or WebM video.`;
  if (isImage && file.size > 15 * 1024 * 1024) return `${file.name} is ${formatBytes(file.size)} — photos can be up to 15 MB.`;
  if (isVideo && file.size > 150 * 1024 * 1024) return `${file.name} is ${formatBytes(file.size)} — videos can be up to 150 MB.`;
  return null;
}

/** Upload one file; resolves with the new library item. */
export function uploadMediaFile(dealId: string, file: File, onProgress: (fraction: number) => void): { promise: Promise<MediaItem>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<MediaItem>((resolve, reject) => {
    xhr.open("POST", `/api/deals/${encodeURIComponent(dealId)}/media`);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let body: any = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300 && body?.id) return resolve(body as MediaItem);
      const msg = body?.error || (xhr.status === 401 ? "Your session has ended — sign in again." : "The upload didn't finish. Please try again.");
      reject(new BuilderApiError(msg, xhr.status));
    };
    xhr.onerror = () => reject(new BuilderApiError("The upload was interrupted — check your connection and try again.", 0));
    xhr.onabort = () => reject(new BuilderApiError("Upload cancelled", 0));
    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  });
  return { promise, abort: () => xhr.abort() };
}

export function useMediaLibrary(dealId: string) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const query = useQuery<MediaItem[]>({
    queryKey: mediaKey(dealId),
    enabled: !!dealId,
    queryFn: () => builderRequest<MediaItem[]>("GET", `/api/deals/${dealId}/media`),
  });
  const items = query.data ?? [];

  const refresh = () => {
    qc.invalidateQueries({ queryKey: mediaKey(dealId) });
  };

  const patch = useMutation({
    mutationFn: ({ id, ...body }: { id: string; caption?: string | null; blindSafe?: boolean }) =>
      builderRequest<MediaItem>("PATCH", `/api/deals/${dealId}/media/${id}`, body),
    onMutate: async ({ id, ...body }) => {
      await qc.cancelQueries({ queryKey: mediaKey(dealId) });
      const prev = qc.getQueryData<MediaItem[]>(mediaKey(dealId));
      if (prev) qc.setQueryData(mediaKey(dealId), prev.map((m) => (m.id === id ? { ...m, ...body, caption: body.caption ?? m.caption } : m)));
      return { prev };
    },
    onError: (err, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(mediaKey(dealId), ctx.prev);
      toast({ title: "Couldn't update the file", description: errorText(err), variant: "destructive" });
    },
    onSettled: refresh,
  });

  const remove = useMutation({
    mutationFn: ({ id, detach }: { id: string; detach?: boolean }) =>
      builderRequest("DELETE", `/api/deals/${dealId}/media/${id}${detach ? "?detach=1" : ""}`),
    onSuccess: (r: any) => {
      toast({
        title: "File deleted",
        description: r?.detachedFrom ? `Also removed from ${r.detachedFrom} section${r.detachedFrom === 1 ? "" : "s"}.` : undefined,
        duration: 3000,
      });
      refresh();
      if (r?.detachedFrom) qc.invalidateQueries({ queryKey: builderKey(dealId) });
    },
    onError: (err) => toast({ title: "Couldn't delete the file", description: errorText(err), variant: "destructive" }),
  });

  /** For the renderers' blind chips. */
  const assets = useMemo(
    () => new Map<string, CimMediaAssetInfo>(items.map((m) => [m.id, { kind: m.kind, blindSafe: m.blindSafe, width: m.width, height: m.height }])),
    [items],
  );
  /** For buyer previews (the same rules as the server). */
  const refs = useMemo<MediaAssetRef[]>(() => items.map((m) => ({ id: m.id, kind: m.kind, blindSafe: m.blindSafe })), [items]);

  const addUploaded = (item: MediaItem) => {
    qc.setQueryData<MediaItem[]>(mediaKey(dealId), (prev) => (prev ? [...prev.filter((m) => m.id !== item.id), item] : [item]));
  };

  return { query, items, assets, refs, patch, remove, refresh, addUploaded };
}

export type MediaLibraryApi = ReturnType<typeof useMediaLibrary>;
