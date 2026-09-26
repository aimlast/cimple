/**
 * The Overview's "next step" card once the seller interview is complete.
 * While critical discrepancies are open it says so (and how many) instead
 * of "Ready to build the CIM" — generation is locked until they're handled.
 * Presentational: the Overview passes the gate state in.
 */
import { Button } from "@/components/ui/button";
import { AlertTriangle, ChevronRight, Loader2 } from "lucide-react";

export interface ReadyToBuildCtaProps {
  /** Open critical discrepancies (open / seller_responded). */
  criticalCount: number;
  /** The discrepancy list couldn't load — can't prove the gate is clear. */
  gateError?: boolean;
  pending?: boolean;
  onContinue: () => void;
  onReview: () => void;
  reviewing?: boolean;
}

export function ctaCopy(criticalCount: number, gateError = false): { title: string; body: string; blocked: boolean } {
  if (gateError) {
    return {
      title: "Interview done — checking discrepancies",
      body: "The discrepancy list didn't load, so we can't confirm nothing blocks the CIM yet.",
      blocked: true,
    };
  }
  if (criticalCount > 0) {
    const noun = `critical discrepanc${criticalCount === 1 ? "y" : "ies"}`;
    return {
      title: `Interview done — resolve ${criticalCount} ${noun} before generating`,
      body: `What the seller said conflicts with the documents on ${criticalCount === 1 ? "a point" : "points"} buyers will rely on. Resolve ${criticalCount === 1 ? "it" : "them"} (or ask the seller) — the CIM can't be generated until then.`,
      blocked: true,
    };
  }
  return {
    title: "Ready to build the CIM",
    body: "The interview is complete. Move to Content Creation to generate the CIM from everything you've collected.",
    blocked: false,
  };
}

export function ReadyToBuildCta({ criticalCount, gateError, pending, onContinue, onReview, reviewing }: ReadyToBuildCtaProps) {
  const copy = ctaCopy(criticalCount, gateError);
  return (
    <div
      className={`rounded-lg border p-5 flex flex-col sm:flex-row sm:items-center gap-3 justify-between ${
        copy.blocked ? "border-red-500/30 bg-red-500/5" : "border-teal/30 bg-teal/5"
      }`}
      data-testid="cta-ready-to-build"
    >
      <div className="flex items-start gap-2.5 min-w-0">
        {copy.blocked && <AlertTriangle className="h-4 w-4 text-red-400 mt-0.5 shrink-0" aria-hidden="true" />}
        <div className="min-w-0">
          <p className="text-sm font-medium">{copy.title}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{copy.body}</p>
        </div>
      </div>
      {copy.blocked ? (
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <Button
            className="bg-teal text-teal-foreground hover:bg-teal/90 gap-1.5"
            onClick={onReview}
            data-testid="button-review-discrepancies"
          >
            {reviewing ? "Hide discrepancies" : "Review discrepancies"}
          </Button>
          <Button variant="ghost" size="sm" className="text-xs gap-1" onClick={onContinue} disabled={pending} data-testid="button-advance-phase-3">
            {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <>Continue anyway <ChevronRight className="h-3.5 w-3.5" /></>}
          </Button>
        </div>
      ) : (
        <Button
          className="bg-teal text-teal-foreground hover:bg-teal/90 gap-1.5 shrink-0"
          onClick={onContinue}
          disabled={pending}
          data-testid="button-advance-phase-3"
        >
          {pending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <>
              Continue to Content Creation
              <ChevronRight className="h-3.5 w-3.5" />
            </>
          )}
        </Button>
      )}
    </div>
  );
}
