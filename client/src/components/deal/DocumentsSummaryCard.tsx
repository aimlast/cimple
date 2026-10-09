/**
 * The Overview's one-line documents summary (vdr spec §5.12, V21): the Data
 * room is the home for files, so the Overview no longer lists them. It says
 * how many documents and sources the deal has, how many are in the data room
 * (and shared), how many are working notes, and how the seller's checklist
 * stands — with "Open the data room" and "See every source".
 */
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { ArrowRight, FolderTree, Library } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiRequest } from "@/lib/queryClient";
import { checklistCounts } from "@shared/seller-portal";
import type { DealDocumentRequirement } from "@shared/schema";
import { useRoom } from "@/hooks/useDataRoom";
import { checklistKey } from "./SellerChecklistCard";

export function DocumentsSummaryCard({ dealId }: { dealId: string }) {
  const [, setLocation] = useLocation();
  const { data, isLoading, error } = useRoom(dealId);
  const { data: rows = [] } = useQuery<DealDocumentRequirement[]>({
    queryKey: checklistKey(dealId),
    queryFn: async () => (await apiRequest("GET", `/api/deals/${dealId}/document-requirements`)).json(),
  });
  const counts = checklistCounts(rows);
  const total = data?.documents.length ?? 0;
  const working = data ? data.documents.filter((d) => !d.roomMaterial).length : 0;
  return (
    <div className="rounded-lg border border-border bg-card p-4" data-testid="card-documents-summary">
      <div className="flex items-start gap-3">
        <FolderTree className="mt-0.5 h-[1.125rem] w-[1.125rem] shrink-0 text-teal" />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-medium">Documents</p>
          {isLoading ? (
            <Skeleton className="h-4 w-72 max-w-full" />
          ) : error || !data ? (
            <p className="text-xs text-muted-foreground">Couldn't load the documents summary.</p>
          ) : data.room ? (
            <p className="text-xs text-muted-foreground">
              {total} {total === 1 ? "document and source" : "documents and sources"} · {data.kpis.inRoom} in the data room ({data.kpis.shared} shared) · {working} working {working === 1 ? "note" : "notes"} (emails, calls, CRM)
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              {total} {total === 1 ? "document and source" : "documents and sources"} ·{" "}
              <button className="text-teal underline-offset-2 hover:underline" onClick={() => setLocation(`/deal/${dealId}/data-room`)}>Set up the data room to organise and share them →</button>
            </p>
          )}
          {rows.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Seller checklist: {counts.requiredUploaded} of {counts.requiredTotal} received{counts.requiredUnavailable ? ` · ${counts.requiredUnavailable} they don't have` : ""}
            </p>
          )}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2 pl-[1.875rem]">
        <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={() => setLocation(`/deal/${dealId}/data-room`)} data-testid="button-open-data-room">
          Open the data room <ArrowRight className="h-3 w-3" />
        </Button>
        {rows.length > 0 && (
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setLocation(`/deal/${dealId}/data-room?view=todo&todo=checklist`)}>Seller checklist</Button>
        )}
        <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={() => setLocation(`/deal/${dealId}/information`)}>
          <Library className="h-3 w-3" /> See every source
        </Button>
      </div>
    </div>
  );
}
