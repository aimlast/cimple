/**
 * BuyerNdaTermsCard — the NDA buyers accept at the view-room NDA step.
 *
 * scope="brokerage" (Settings → Deal defaults): the brokerage's own terms
 * for every deal; empty = Cimple's standard terms.
 * scope="deal" (deal → Buyers tab): which terms this deal's buyers sign, with
 * an override for this deal only.
 *
 * Terms may use {firm} (the brokerage's name) and {opportunity} (the deal as
 * the buyer may see it — the codename on the Blind CIM). What each buyer
 * saw, and the name they typed, is kept with their signature.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { FileSignature, Loader2 } from "lucide-react";

type Source = "deal" | "brokerage" | "standard";
interface DealNda { terms: string; source: Source; dealTerms: string | null; brokerageTerms: string | null; standardTerms: string }
interface BrokerageNda { terms: string | null; standardTerms: string }

async function readError(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => null);
  return (body && typeof body.error === "string" && body.error) || fallback;
}

const SOURCE_LABEL: Record<Source, string> = {
  deal: "Custom NDA for this deal",
  brokerage: "Your brokerage NDA",
  standard: "Cimple's standard NDA",
};

const PLACEHOLDER_HINT = "Use {firm} for your brokerage's name and {opportunity} for the deal — on the Blind CIM that is the project codename, never the business name.";

async function putTerms(url: string, terms: string | null) {
  const r = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ terms }),
  });
  if (!r.ok) throw new Error(await readError(r, "Couldn't save the NDA"));
  return r.json();
}

export function BuyerNdaTermsCard(props: { scope: "brokerage" } | { scope: "deal"; dealId: string }) {
  const scope = props.scope;
  const dealId = props.scope === "deal" ? props.dealId : null;
  const { toast } = useToast();
  const qc = useQueryClient();
  const url = scope === "deal" ? `/api/deals/${dealId}/buyer-nda` : "/api/broker/buyer-nda";
  const { data, isLoading, error } = useQuery<DealNda | BrokerageNda>({
    queryKey: [url],
    queryFn: async () => {
      const r = await fetch(url, { credentials: "include" });
      if (!r.ok) throw new Error(await readError(r, "Couldn't load the NDA"));
      return r.json();
    },
  });

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const current = scope === "deal"
    ? (data as DealNda | undefined)?.terms ?? ""
    : (data as BrokerageNda | undefined)?.terms ?? (data as BrokerageNda | undefined)?.standardTerms ?? "";
  useEffect(() => { if (open) setDraft(current); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useMutation({
    mutationFn: (terms: string | null) => putTerms(url, terms),
    onSuccess: (_r, terms) => {
      qc.invalidateQueries({ queryKey: [url] });
      if (scope === "brokerage") qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0] ?? "").endsWith("/buyer-nda") });
      setOpen(false);
      toast({
        title: "NDA saved",
        description: terms === null
          ? scope === "deal" ? "This deal's buyers now sign your brokerage NDA." : "Buyers now sign Cimple's standard NDA."
          : "Buyers who sign from now on accept these terms. Signatures already recorded keep the terms they accepted.",
      });
    },
    onError: (e: Error) => toast({ title: "Couldn't save the NDA", description: e.message, variant: "destructive" }),
  });

  const source: Source | null = data
    ? scope === "deal" ? (data as DealNda).source : (data as BrokerageNda).terms ? "brokerage" : "standard"
    : null;
  const standard = data?.standardTerms ?? "";
  const resetLabel = scope === "deal" ? "Use my brokerage NDA" : "Use Cimple's standard NDA";
  const canReset = scope === "deal" ? source === "deal" : source === "brokerage";

  return (
    <Card data-testid={`card-buyer-nda-${scope}`}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FileSignature className="h-4 w-4" />
          Buyer NDA
        </CardTitle>
        <CardDescription>
          {scope === "deal"
            ? "What buyers of this deal read and sign before the CIM opens. They type their full name to sign, and can download a copy."
            : "The NDA buyers sign before any of your CIMs open. You can still change it for a single deal on that deal's Buyers tab."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…</div>
        ) : error ? (
          <p className="text-xs text-destructive">{(error as Error).message}</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="text-2xs font-normal" data-testid="badge-nda-source">{source ? SOURCE_LABEL[source] : ""}</Badge>
            </div>
            <div className="max-h-40 overflow-y-auto rounded-md border border-border bg-muted/20 p-3 text-xs leading-relaxed text-muted-foreground whitespace-pre-line" data-testid="text-nda-preview">
              {current}
            </div>
            {/\{firm\}|\{opportunity\}/.test(current) && (
              <p className="text-2xs text-muted-foreground">
                {"{firm}"} and {"{opportunity}"} are filled in for each buyer — a buyer on the Blind CIM sees the project codename, never the business name.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => setOpen(true)} data-testid="button-edit-nda">
                {scope === "deal" ? "Edit for this deal" : "Edit NDA"}
              </Button>
              {canReset && (
                <Button size="sm" variant="ghost" onClick={() => save.mutate(null)} disabled={save.isPending} data-testid="button-reset-nda">
                  {resetLabel}
                </Button>
              )}
            </div>
          </>
        )}
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{scope === "deal" ? "NDA for this deal" : "Your brokerage NDA"}</DialogTitle>
            <DialogDescription>{PLACEHOLDER_HINT}</DialogDescription>
          </DialogHeader>
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="min-h-[320px] text-xs leading-relaxed"
            data-testid="textarea-nda-terms"
          />
          <DialogFooter className="gap-2 sm:justify-between">
            <Button variant="ghost" size="sm" onClick={() => setDraft(standard)} disabled={!standard}>
              Start from the standard NDA
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
              <Button
                size="sm"
                className="bg-teal text-teal-foreground hover:bg-teal/90"
                onClick={() => save.mutate(draft.trim() ? draft : null)}
                disabled={save.isPending || draft.trim().length < 50}
                data-testid="button-save-nda"
              >
                {save.isPending ? "Saving…" : "Save NDA"}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
