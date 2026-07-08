/**
 * PanelError — distinct error state for deal-panel data fetches.
 *
 * Several panels used to return [] from their queryFn on a failed response,
 * which made a server error indistinguishable from "no data yet" — a broker
 * couldn't tell an empty deal from a broken one. Panels render this instead
 * when their query errors, with a retry that refetches in place.
 */
import { AlertTriangle, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";

export function PanelError({
  what,
  onRetry,
}: {
  /** What failed to load, e.g. "buyers" — reads as "Couldn't load buyers" */
  what: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-10 text-center rounded-lg border border-dashed border-border bg-muted/10">
      <AlertTriangle className="h-6 w-6 text-amber-500/70 mb-2" />
      <p className="text-sm font-medium">Couldn't load {what}</p>
      <p className="text-xs text-muted-foreground mt-0.5 mb-3">
        This is a loading problem, not an empty list — your data is safe.
      </p>
      <Button variant="outline" size="sm" onClick={onRetry} data-testid="button-panel-retry">
        <RotateCw className="h-3.5 w-3.5 mr-1.5" />
        Try again
      </Button>
    </div>
  );
}
