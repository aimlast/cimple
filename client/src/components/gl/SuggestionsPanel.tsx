/**
 * SuggestionsPanel — two lists side by side (gl spec D20, P1): "Other costs
 * the seller mentioned" (the seller's optional note at the end of their
 * page, with any entries they attached) and "Possible add-backs we noticed
 * in the ledger" (owner, shareholder, donation, club accounts no add-back
 * covers). Never added on their own: "Add as an add-back" opens the
 * Normalization tab, where the broker adds a custom add-back.
 */
import { useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { sendJson, type BrokerGlData } from "@/lib/gl-api";
import { invalidateGl } from "@/hooks/useGlStatus";
import { dollars, ledgerDate, money, shortDate } from "./gl-ui";
import { accountPath } from "@shared/gl-copy";

export function SuggestionsPanel({ dealId, data }: { dealId: string; data: BrokerGlData }) {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const set = useMutation({
    mutationFn: ({ id, status }: { id: string; status: "added" | "dismissed" }) => sendJson("POST", `/api/deals/${dealId}/gl/suggestions/${id}`, { status }),
    onSuccess: () => invalidateGl(dealId),
    onError: (e: unknown) => toast({ title: "That didn't work", description: e instanceof Error ? e.message : undefined, variant: "destructive" }),
  });
  const toNormalization = () => navigate(`/deal/${dealId}/financials?fin=normalization`);
  const suggestions = data.suggestions ?? [];
  const possible = data.possible ?? [];
  return (
    <div className="grid gap-4 lg:grid-cols-2" data-testid="gl-suggestions">
      <section className="rounded-lg border border-border bg-card p-3 sm:p-4 space-y-3">
        <div>
          <h4 className="text-sm font-medium">Other costs the seller mentioned</h4>
          <p className="text-xs text-muted-foreground mt-0.5">At the end of their page the seller can tell you about other personal or one-off costs the business pays. You decide what counts.</p>
        </div>
        {suggestions.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nothing yet.</p>
        ) : suggestions.map((s) => (
          <div key={s.id} className="rounded-md border border-border px-3 py-2 space-y-2">
            <p className="text-sm whitespace-pre-wrap break-words">{s.text}</p>
            <p className="text-2xs text-muted-foreground">{shortDate(s.at)}{s.entries.length ? ` · ${s.entries.length} entr${s.entries.length === 1 ? "y" : "ies"} attached` : ""}</p>
            {s.entries.length > 0 && (
              <ul className="text-xs space-y-0.5">
                {s.entries.slice(0, 6).map((e) => (
                  <li key={`${e.ledgerId}:${e.rowNo}`} className="flex gap-2"><span className="flex-1 min-w-0 truncate">{ledgerDate(e.txnDate)} · {e.name ?? accountPath(e.account)}</span><span className="tabular-nums">{money(e.amountCents)}</span></li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" className="h-8 text-xs gap-1" onClick={() => { set.mutate({ id: s.id, status: "added" }); toNormalization(); }}><Plus className="h-3.5 w-3.5" /> Add as an add-back</Button>
              <Button size="sm" variant="ghost" className="h-8 text-xs gap-1" onClick={() => set.mutate({ id: s.id, status: "dismissed" })}><X className="h-3.5 w-3.5" /> Dismiss</Button>
            </div>
          </div>
        ))}
      </section>
      <section className="rounded-lg border border-border bg-card p-3 sm:p-4 space-y-3">
        <div>
          <h4 className="text-sm font-medium">Possible add-backs we noticed in the ledger</h4>
          <p className="text-xs text-muted-foreground mt-0.5">Accounts that often hold the owner's own costs and that no add-back covers yet.</p>
        </div>
        {possible.length === 0 ? (
          <p className="text-xs text-muted-foreground">{data.ledgers.some((l) => l.status === "ready") ? "Nothing stands out." : "Once a ledger is read, Cimple looks for them."}</p>
        ) : possible.map((p) => (
          <div key={p.accountKey} className="rounded-md border border-border px-3 py-2 space-y-1.5">
            <p className="text-sm font-medium break-words">{accountPath(p.account)}</p>
            <p className="text-xs text-muted-foreground">{p.why} · {Object.keys(p.years).sort().map((y) => `${y}: ${dollars(p.years[y])}`).join(" · ")}</p>
            <Button size="sm" variant="outline" className="h-8 text-xs gap-1" onClick={toNormalization}><Plus className="h-3.5 w-3.5" /> Add as an add-back</Button>
          </div>
        ))}
      </section>
    </div>
  );
}
