/**
 * "Documents still needed": the deal's open document requests (the general
 * ledger request included), read-only — the board never changes a request's
 * status. "Seller will send it" is a board mark only (it ticks the document
 * in the end-of-session follow-ups).
 */
import { useState } from "react";
import { FileText, Loader2 } from "lucide-react";
import { Link } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { boardRequest, invalidateCoverage } from "@/hooks/useCoverageBoard";
import type { DocumentNeeded } from "@shared/coverage-board";

export function DocumentsNeeded({ dealId, documents, compact }: { dealId: string; documents: DocumentNeeded[]; compact?: boolean }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  if (documents.length === 0) {
    return <p className="text-sm text-muted-foreground px-1 py-6 text-center" data-testid="documents-needed-empty">Every document the CIM asks for is in. Nothing to chase.</p>;
  }
  const toggle = async (d: DocumentNeeded) => {
    setBusy(d.requirementId);
    try {
      const itemId = `doc:${d.requirementId}`;
      if (d.promised) await boardRequest("DELETE", `/api/deals/${dealId}/coverage-board/items/${itemId}/marks/doc_promised`);
      else await boardRequest("POST", `/api/deals/${dealId}/coverage-board/items/${itemId}/marks`, { kind: "doc_promised" });
      invalidateCoverage(dealId);
    } catch (e) {
      toast({ title: "That didn't save", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };
  const sorted = [...documents].sort((a, b) => Number(b.required) - Number(a.required));
  return (
    <div>
      <ul className="divide-y divide-border/60" data-testid="documents-needed">
        {(compact ? sorted.slice(0, 5) : sorted).map((d) => (
          <li key={d.requirementId} className={`flex items-start gap-3 ${compact ? "py-2" : "px-3 py-3"}`}>
            <FileText className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-sm">{d.name}</p>
              <p className="text-[11px] text-muted-foreground">
                {d.required ? "Needed for the CIM" : "Nice to have"}
                {d.sellerSaysNoCopy && " · The seller says they don't have it"}
                {d.buyerAsked && " · A buyer asked for it"}
                {d.neededBy && ` · Needed by ${new Date(d.neededBy).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`}
              </p>
            </div>
            {!compact && (
              <button
                type="button"
                onClick={() => void toggle(d)}
                disabled={busy === d.requirementId}
                aria-pressed={d.promised}
                className={`shrink-0 inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] ${d.promised ? "border-teal/50 bg-teal/10 text-teal" : "border-border text-muted-foreground hover:text-foreground"}`}
                data-testid={`button-promised-${d.requirementId}`}
              >
                {busy === d.requirementId && <Loader2 className="h-3 w-3 animate-spin" />}
                {d.promised ? "✓ Seller will send it" : "Seller will send it"}
              </button>
            )}
          </li>
        ))}
      </ul>
      {compact && documents.length > 5 && <p className="text-[11px] text-muted-foreground pt-1">+ {documents.length - 5} more</p>}
      {!compact && (
        <p className="px-3 pt-3 text-[11px] text-muted-foreground">
          Uploads land on the deal's <Link href={`/deal/${dealId}/overview`} className="underline underline-offset-2 hover:text-foreground">Overview</Link> — this list updates when they do.
        </p>
      )}
    </div>
  );
}
