/**
 * DealContext — Shared deal state for the DealShell tab layout.
 *
 * Holds the deal object, dealId, and an invalidation helper.
 * Each tab fetches its own tab-specific data (buyers, FAQs, etc.)
 * via React Query — this context only carries what every tab needs.
 */
import { createContext, useContext, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { Loader2, AlertCircle, SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Link } from "wouter";
import type { Deal } from "@shared/schema";

interface DealContextValue {
  deal: Deal;
  dealId: string;
  invalidateDeal: () => void;
}

const DealContext = createContext<DealContextValue | null>(null);

export function useDeal(): DealContextValue {
  const ctx = useContext(DealContext);
  if (!ctx) {
    throw new Error("useDeal() must be used within a <DealProvider>");
  }
  return ctx;
}

/**
 * The default queryFn throws `"<status>: <body>"`. GET /api/deals/:id answers
 * 404 both for a deleted deal and for a deal owned by another broker (the
 * server never reveals which), and 403 would mean the same thing to the
 * user — neither is a transient failure worth retrying.
 */
function isNotFoundError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error ?? "");
  return /^(404|403)\b/.test(msg);
}

function errorDetail(error: unknown): string | null {
  const msg = error instanceof Error ? error.message : "";
  // Strip the "500: " prefix and unwrap a JSON { error } body when present.
  const body = msg.replace(/^\d{3}:\s*/, "");
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed.error === "string") return parsed.error;
  } catch { /* plain text */ }
  return body || null;
}

/**
 * Wraps children with DealContext after fetching the deal.
 * Shows loading spinner, a "not found" state (404/403 — deleted or not in
 * this broker's account), or a retryable error state for real failures.
 */
export function DealProvider({
  dealId,
  children,
}: {
  dealId: string;
  children: ReactNode;
}) {
  const { data: deal, isLoading, error, refetch, isFetching } = useQuery<Deal>({
    queryKey: ["/api/deals", dealId],
    enabled: !!dealId,
  });

  const invalidateDeal = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId] });
  };

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error && isNotFoundError(error)) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="text-center max-w-sm" data-testid="state-deal-not-found">
          <SearchX className="h-8 w-8 text-muted-foreground/40 mx-auto mb-2" />
          <p className="text-sm font-medium text-foreground">Deal not found or not in your account</p>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
            This link may point to a deal that was deleted, or to one that belongs to another
            broker. Check with the deal's lead broker if you expected access.
          </p>
          <Link href="/broker/deals">
            <Button variant="outline" size="sm" className="mt-4" data-testid="button-back-to-deals">
              Back to Deals
            </Button>
          </Link>
        </div>
      </div>
    );
  }

  if (error || !deal) {
    const detail = errorDetail(error);
    return (
      <div className="flex h-full items-center justify-center px-6">
        {/* A failed fetch is NOT "deal not found" — offer a retry instead of
            sending the broker away from a deal that exists. */}
        <div className="text-center max-w-sm" data-testid="state-deal-error">
          <AlertCircle className="h-8 w-8 text-amber-500/60 mx-auto mb-2" />
          <p className="text-sm font-medium text-foreground">Couldn't load this deal</p>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
            {detail || "A loading problem occurred — the deal itself is safe."}
          </p>
          <div className="flex items-center justify-center gap-2 mt-4">
            <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching} data-testid="button-retry-deal">
              {isFetching ? "Retrying…" : "Try again"}
            </Button>
            <Link href="/broker/deals">
              <Button variant="ghost" size="sm">Back to Deals</Button>
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <DealContext.Provider value={{ deal, dealId, invalidateDeal }}>
      {children}
    </DealContext.Provider>
  );
}
