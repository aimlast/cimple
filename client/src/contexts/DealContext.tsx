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
import { Loader2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLocation } from "wouter";
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
 * Wraps children with DealContext after fetching the deal.
 * Shows loading spinner or "not found" error if deal isn't available.
 */
export function DealProvider({
  dealId,
  children,
}: {
  dealId: string;
  children: ReactNode;
}) {
  const [, setLocation] = useLocation();

  const { data: deal, isLoading, error, refetch } = useQuery<Deal>({
    queryKey: ["/api/deals", dealId],
    enabled: !!dealId,
  });

  const invalidateDeal = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId] });
  };

  if (isLoading || !deal) {
    return (
      <div className="flex h-full items-center justify-center">
        {isLoading ? (
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        ) : error ? (
          // A failed fetch is NOT "deal not found" — offer a retry instead of
          // sending the broker away from a deal that exists.
          <div className="text-center">
            <AlertCircle className="h-8 w-8 text-amber-500/60 mx-auto mb-2" />
            <p className="text-sm font-medium">Couldn't load this deal</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              A loading problem occurred — the deal itself is safe.
            </p>
            <div className="flex items-center justify-center gap-2 mt-3">
              <Button variant="outline" size="sm" onClick={() => refetch()}>
                Try again
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setLocation("/broker/deals")}>
                Back to Deals
              </Button>
            </div>
          </div>
        ) : (
          <div className="text-center">
            <AlertCircle className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">Deal not found</p>
            <Button
              variant="ghost"
              size="sm"
              className="mt-2"
              onClick={() => setLocation("/broker/deals")}
            >
              Back to Deals
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <DealContext.Provider value={{ deal, dealId, invalidateDeal }}>
      {children}
    </DealContext.Provider>
  );
}
