/**
 * Data-room queries and requests (vdr spec §10). Query keys:
 *   ["/api/deals", dealId, "data-room", …]   the broker's tab
 *   ["/api/view", token, "data-room", …]     the buyer's room
 * Errors carry the server's plain words (never "500: {…}").
 */
import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import type {
  ActivityPayload,
  BrokerRoomPayload,
  BuyerItemAbout,
  BuyerRoomPayload,
  ItemNotesPayload,
  RoomBuyersPayload,
  RoomRequestsPayload,
  ShareAudience,
  SharingPlanPayload,
  VdrManifest,
  WaitingPayload,
} from "@shared/vdr-api";

export class VdrRequestError extends Error {
  constructor(message: string, readonly status: number, readonly body: Record<string, unknown>) {
    super(message);
  }
}

export async function vdrFetch<T = unknown>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: "include",
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = typeof json?.error === "string" ? json.error : res.status >= 500 ? "Something went wrong. Try again." : "That didn't work.";
    throw new VdrRequestError(msg, res.status, json ?? {});
  }
  return json as T;
}

export const roomKey = (dealId: string) => ["/api/deals", dealId, "data-room"] as const;
export const roomBase = (dealId: string) => `/api/deals/${encodeURIComponent(dealId)}/data-room`;

export function invalidateRoom(dealId: string) {
  return queryClient.invalidateQueries({ queryKey: roomKey(dealId) });
}

export function useRoom(dealId: string) {
  return useQuery<BrokerRoomPayload>({
    queryKey: roomKey(dealId),
    queryFn: () => vdrFetch("GET", roomBase(dealId)),
    // While documents are being prepared, look again every few seconds.
    refetchInterval: (q) => {
      const d = q.state.data as BrokerRoomPayload | undefined;
      return d?.items.some((i) => !i.removed && (!i.prepared || i.prepared.status === "pending")) ? 4000 : false;
    },
  });
}

export function usePlan(dealId: string, enabled: boolean) {
  return useQuery<SharingPlanPayload>({ queryKey: [...roomKey(dealId), "plan"], queryFn: () => vdrFetch("GET", `${roomBase(dealId)}/plan`), enabled });
}

export function useAudience(dealId: string, enabled = true) {
  return useQuery<ShareAudience>({ queryKey: [...roomKey(dealId), "audience"], queryFn: () => vdrFetch("GET", `${roomBase(dealId)}/audience`), enabled });
}

export function useRoomBuyers(dealId: string, enabled = true) {
  return useQuery<RoomBuyersPayload>({ queryKey: [...roomKey(dealId), "buyers"], queryFn: () => vdrFetch("GET", `${roomBase(dealId)}/buyers`), enabled });
}

export type ItemActivity = {
  buyers: Array<{ key: string; name: string | null; company: string | null; email: string; opens: number; activeMs: number; pagesRead: number[]; downloaded: boolean; lastAt: string }>;
  pages: Record<string, number>;
  pageCount: number;
};
export function useItemActivity(dealId: string, itemId: string | null) {
  return useQuery<ItemActivity>({
    queryKey: [...roomKey(dealId), "activity", itemId],
    queryFn: () => vdrFetch("GET", `${roomBase(dealId)}/activity?item=${encodeURIComponent(itemId!)}`),
    enabled: !!itemId,
  });
}

// ── Pass 3: To do, requests, notes, activity ──

export function useTodo(dealId: string, enabled = true) {
  return useQuery<WaitingPayload>({ queryKey: [...roomKey(dealId), "todo"], queryFn: () => vdrFetch("GET", `${roomBase(dealId)}/todo`), enabled });
}

export type RequestsPayload = RoomRequestsPayload & { sellerEmail: { lastAt: string | null; unsent: string[] } };
export function useRequests(dealId: string, enabled = true) {
  return useQuery<RequestsPayload>({ queryKey: [...roomKey(dealId), "requests"], queryFn: () => vdrFetch("GET", `${roomBase(dealId)}/requests`), enabled });
}

export function useItemNotes(dealId: string, itemId: string | null) {
  return useQuery<ItemNotesPayload>({
    queryKey: [...roomKey(dealId), "notes", itemId],
    queryFn: () => vdrFetch("GET", `${roomBase(dealId)}/items/${encodeURIComponent(itemId!)}/notes`),
    enabled: !!itemId,
    // While Cimple writes the description, look again now and then.
    refetchInterval: (q) => ((q.state.data as ItemNotesPayload | undefined)?.summary.running ? 5000 : false),
  });
}

export type ActivityParams = { view: "buyers" | "documents" | "log"; buyer?: string | null; person?: string | null; item?: string | null; action?: string | null; from?: string | null; to?: string | null; trace?: string | null };
export function activityQuery(p: Partial<ActivityParams>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v) q.set(k, String(v));
  return q.toString();
}
export function useActivityReport(dealId: string, p: ActivityParams) {
  const qs = activityQuery(p);
  return useQuery<ActivityPayload>({ queryKey: [...roomKey(dealId), "activity-report", qs], queryFn: () => vdrFetch("GET", `${roomBase(dealId)}/activity?${qs}`) });
}

// ── Where a viewer reads from: the buyer's link, or the broker (optionally as one buyer) ──

export type VdrSource =
  | { kind: "buyer"; token: string }
  | { kind: "broker"; dealId: string; asAccessId?: string | null };

export function sourceKey(s: VdrSource): readonly unknown[] {
  return s.kind === "buyer" ? ["/api/view", s.token, "data-room"] : [...roomKey(s.dealId), "as", s.asAccessId ?? "broker"];
}

export const vdrUrls = (s: VdrSource) => {
  if (s.kind === "buyer") {
    const b = `/api/view/${encodeURIComponent(s.token)}/data-room`;
    return {
      room: b,
      about: (id: string) => `${b}/items/${encodeURIComponent(id)}`,
      page: (id: string, n: number, w: number, viewId: string | null) => `${b}/items/${encodeURIComponent(id)}/pages/${n}?w=${w}${viewId ? `&v=${encodeURIComponent(viewId)}` : ""}`,
      sheet: (id: string, q: string) => `${b}/items/${encodeURIComponent(id)}/sheet?${q}`,
      html: (id: string) => `${b}/items/${encodeURIComponent(id)}/html`,
      text: (id: string) => `${b}/items/${encodeURIComponent(id)}/text`,
      download: (id: string, viewId: string | null) => `${b}/items/${encodeURIComponent(id)}/download${viewId ? `?v=${encodeURIComponent(viewId)}` : ""}`,
      search: (q: string) => `${b}/search?q=${encodeURIComponent(q)}`,
      index: `${b}/index.csv`,
      viewStart: `${b}/views/start`,
      beat: `${b}/views`,
    };
  }
  const b = roomBase(s.dealId);
  const as = s.asAccessId ? `as=${encodeURIComponent(s.asAccessId)}` : "";
  const join = (u: string, q: string) => (q ? `${u}${u.includes("?") ? "&" : "?"}${q}` : u);
  return {
    room: s.asAccessId ? `${b}/preview/${encodeURIComponent(s.asAccessId)}` : b,
    about: (id: string) => (s.asAccessId ? `${b}/preview/${encodeURIComponent(s.asAccessId)}/items/${encodeURIComponent(id)}` : `${b}/items/${encodeURIComponent(id)}/view`),
    page: (id: string, n: number, w: number) => join(`${b}/items/${encodeURIComponent(id)}/pages/${n}?w=${w}`, as),
    sheet: (id: string, q: string) => join(`${b}/items/${encodeURIComponent(id)}/sheet?${q}`, as),
    html: (id: string) => join(`${b}/items/${encodeURIComponent(id)}/html`, as),
    text: (id: string) => join(`${b}/items/${encodeURIComponent(id)}/text`, as),
    download: (id: string) => `${b}/items/${encodeURIComponent(id)}/download`,
    search: (_q: string) => "",
    index: "",
    viewStart: "",
    beat: "",
  };
};

/** The buyer's room (or the broker's preview of it). */
export function useBuyerRoom(source: VdrSource) {
  return useQuery<BuyerRoomPayload, VdrRequestError>({
    queryKey: [...sourceKey(source), "room"],
    queryFn: () => vdrFetch("GET", vdrUrls(source).room),
  });
}

/** One document's About card + manifest; polls while it's being prepared. */
export function useItemAbout(source: VdrSource, itemId: string | null) {
  return useQuery<BuyerItemAbout | (VdrManifest & { broker: true }), VdrRequestError>({
    queryKey: [...sourceKey(source), "item", itemId],
    queryFn: async () => {
      const r = await vdrFetch<any>("GET", vdrUrls(source).about(itemId!));
      return r && r.manifest ? r : { ...r, broker: true };
    },
    enabled: !!itemId,
    refetchInterval: (q) => {
      const d = q.state.data as any;
      const status = d?.manifest?.status ?? d?.status;
      return status === "pending" ? 2000 : false;
    },
  });
}

/** "11 min" · "40 s" · "1 h 5 min". */
export function durationLabel(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h${m % 60 ? ` ${m % 60} min` : ""}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Oct 9" (this year) or "Oct 9, 2025". */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${d.getFullYear() !== now.getFullYear() ? `, ${d.getFullYear()}` : ""}`;
}
