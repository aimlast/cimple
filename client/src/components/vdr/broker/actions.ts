/**
 * The broker's data-room actions (vdr spec §9.2) as one hook: every action
 * refreshes the tab and reports plain words on failure.
 */
import { useMutation } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { invalidateRoom, roomBase, vdrFetch } from "@/hooks/useDataRoom";

export function useRoomActions(dealId: string) {
  const { toast } = useToast();
  const base = roomBase(dealId);
  const run = useMutation({
    mutationFn: async (a: { method: string; url: string; body?: unknown; done?: string; fail: string }) => vdrFetch("" + a.method, a.url, a.body),
    onSuccess: (_r, a) => {
      invalidateRoom(dealId);
      if (a.done) toast({ title: a.done });
    },
    onError: (e: Error, a) => toast({ title: a.fail, description: e.message, variant: "destructive" }),
  });
  const act = (method: string, path: string, body: unknown, done: string | undefined, fail: string) => run.mutateAsync({ method, url: `${base}${path}`, body, done, fail }).catch(() => undefined);
  return {
    pending: run.isPending,
    setUp: (mode: "auto" | "empty") => act("POST", "/setup", { mode }, undefined, "Couldn't set up the data room"),
    place: (documentId: string, folderId?: string | null) => act("POST", "/items", { documentId, folderId: folderId ?? null }, "Put in the room", "Couldn't put it in the room"),
    move: (itemIds: string[], folderId: string, beforeItemId?: string | null) => act("POST", "/items/move", { itemIds, folderId, beforeItemId: beforeItemId ?? null }, itemIds.length > 1 ? `Moved ${itemIds.length} documents` : "Moved", "Couldn't move them"),
    rename: (itemId: string, title: string) => act("PATCH", `/items/${itemId}`, { title }, "Renamed in the room", "Couldn't rename it"),
    setDownloadable: (itemId: string, downloadable: boolean) => act("PATCH", `/items/${itemId}`, { downloadable }, downloadable ? "Buyers can download it" : "View only", "Couldn't change downloads"),
    setOriginal: (itemId: string, on: boolean) => act("PATCH", `/items/${itemId}`, { downloadOriginal: on }, on ? "The original file is offered" : "Buyers get the page copy", "Couldn't change it"),
    saveSummary: (itemId: string, text: string) => act("PATCH", `/items/${itemId}`, { buyerSummary: text }, "Description saved", "Couldn't save the description"),
    acceptSummary: (itemId: string) => act("PATCH", `/items/${itemId}`, { acceptSummary: true }, "Buyers will read this description", "Couldn't save it"),
    hideSummary: (itemId: string, hidden: boolean) => act("PATCH", `/items/${itemId}`, { buyerSummaryHidden: hidden }, hidden ? "Buyers see the basic line" : "Buyers see the description", "Couldn't change it"),
    check: (itemId: string, flags?: string[]) => act("POST", `/items/${itemId}/checked`, { flags }, "Marked as checked", "Couldn't save the check"),
    takeOut: (itemId: string) => act("DELETE", `/items/${itemId}`, undefined, "Taken out of the room", "Couldn't take it out"),
    restore: (itemId: string) => act("POST", `/items/${itemId}/restore`, {}, "Put back in the room", "Couldn't put it back"),
    shareLikeReplaced: (itemId: string) => act("POST", `/items/${itemId}/share-like-replaced`, {}, "Shared with the same people", "Couldn't share it"),
    retry: (itemId: string) => act("POST", `/items/${itemId}/prepare`, {}, "Trying again", "Couldn't try again"),
    removeCleanCopy: (itemId: string) => act("DELETE", `/items/${itemId}/clean-copy`, undefined, "Cleaned copy removed", "Couldn't remove it"),
    bulk: (body: unknown, done: string) => act("POST", "/shares/bulk", body, done, "Couldn't change sharing"),
    newFolder: (name: string, parentId: string | null) => act("POST", "/folders", { name, parentId }, "Folder added", "Couldn't add the folder"),
    renameFolder: (folderId: string, name: string) => act("PATCH", `/folders/${folderId}`, { name }, "Folder renamed", "Couldn't rename the folder"),
    deleteFolder: (folderId: string) => act("DELETE", `/folders/${folderId}`, undefined, "Folder deleted", "Couldn't delete the folder"),
    settings: (body: { status?: "open" | "closed"; autoAddNew?: boolean }, done: string) => act("PATCH", "/settings", body, done, "Couldn't save the settings"),
    buyer: (accessId: string, body: { roomAccess?: "auto" | "on" | "off"; allowDownloads?: boolean }, done: string) => act("PATCH", `/buyers/${accessId}`, body, done, "Couldn't change the buyer's access"),
  };
}

/** Uploads a cleaned copy for an item. */
export async function uploadCleanCopy(dealId: string, itemId: string, file: File): Promise<void> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch(`${roomBase(dealId)}/items/${itemId}/clean-copy`, { method: "POST", body: fd, credentials: "include" });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof json?.error === "string" ? json.error : "Upload failed.");
  await invalidateRoom(dealId);
}
