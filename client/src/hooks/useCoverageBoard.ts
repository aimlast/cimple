/**
 * The coverage board (shared/coverage-board.ts) for the broker's screens and
 * the seller's "What we've covered".
 *
 * Audience safety: when "Seller can see this screen" switches the board to
 * the `screen` audience, the broker board is removed from the cache, so a
 * private value is not in the page at all (specs/together.md D10).
 */
import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import type { CoverageBoard, CoverageItemDetail } from "@shared/coverage-board";

export type BrokerAudience = "broker" | "screen";

export const coverageBoardKey = (dealId: string, audience: BrokerAudience) => ["/api/deals", dealId, "coverage-board", audience] as const;
export const sellerCoverageKey = (token: string) => ["/api/seller", token, "coverage"] as const;

async function readJson<T>(r: Response, fallback: string): Promise<T> {
  if (!r.ok) {
    const body = await r.json().catch(() => null);
    throw new Error((body && typeof body.error === "string" && body.error) || fallback);
  }
  return r.json() as Promise<T>;
}

/** How long a "plan building" board keeps polling before it stops (the build takes ~30–60 s). */
const PLAN_POLL_MS = 5_000;
const PLAN_POLL_FOR_MS = 3 * 60_000;

export function useCoverageBoard(dealId: string | undefined, audience: BrokerAudience = "broker", opts: { enabled?: boolean } = {}) {
  const firstBuildingAt = useRef<number | null>(null);
  const query = useQuery<CoverageBoard>({
    queryKey: coverageBoardKey(dealId ?? "", audience),
    enabled: !!dealId && opts.enabled !== false,
    queryFn: async () => readJson<CoverageBoard>(
      await fetch(`/api/deals/${dealId}/coverage-board?audience=${audience}`, { credentials: "include" }),
      "Couldn't load the checklist",
    ),
    refetchInterval: (q) => {
      if (q.state.data?.plan.status !== "building") {
        firstBuildingAt.current = null;
        return false;
      }
      firstBuildingAt.current ??= Date.now();
      return Date.now() - firstBuildingAt.current < PLAN_POLL_FOR_MS ? PLAN_POLL_MS : false;
    },
  });
  // Switching to the seller-safe screen drops the broker board from memory.
  const prevAudience = useRef(audience);
  useEffect(() => {
    if (!dealId) return;
    if (prevAudience.current !== audience) {
      queryClient.removeQueries({ queryKey: coverageBoardKey(dealId, prevAudience.current) });
      prevAudience.current = audience;
    }
  }, [dealId, audience]);
  return query;
}

/** Re-read every audience of the board, and what the board's numbers feed. */
export function invalidateCoverage(dealId: string) {
  queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "coverage-board"] });
  queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "cim-readiness"] });
  queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "interview-outline"] });
  queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "information"] });
}

export function useSellerCoverage(token: string | undefined, opts: { enabled?: boolean } = {}) {
  return useQuery<CoverageBoard>({
    queryKey: sellerCoverageKey(token ?? ""),
    enabled: !!token && opts.enabled !== false,
    queryFn: async () => readJson<CoverageBoard>(
      await fetch(`/api/seller/${token}/coverage`, { credentials: "include" }),
      "Couldn't load your progress",
    ),
  });
}

export async function fetchItemDetail(dealId: string, itemId: string, audience: BrokerAudience): Promise<CoverageItemDetail> {
  return readJson<CoverageItemDetail>(
    await fetch(`/api/deals/${dealId}/coverage-board/items/${encodeURIComponent(itemId)}?audience=${audience}`, { credentials: "include" }),
    "Couldn't load that data point",
  );
}

/** POST/PUT/PATCH/DELETE with a plain-language error. */
export async function boardRequest<T = unknown>(method: string, url: string, body?: unknown, fallback = "That didn't work"): Promise<T> {
  const r = await fetch(url, {
    method,
    credentials: "include",
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return readJson<T>(r, fallback);
}
