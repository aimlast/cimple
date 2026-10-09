/**
 * SendToSellerDialog — "Ask {seller} to show these in their books" (gl spec
 * §3.4). Who receives it (owner and accountant, each with their own link),
 * the costs exactly as the seller will see them (a plain name, what to look
 * for, the proof asked for and the amount per year — never how an add-back
 * is treated), an optional message. Nothing is emailed until Send request.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ExternalLink, Loader2, Lock, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { sendJson, type BrokerGlData, type BrokerTrace } from "@/lib/gl-api";
import { invalidateGl } from "@/hooks/useGlStatus";
import { dollars } from "./gl-ui";

const ROLE: Record<string, string> = { owner: "Owner", accountant: "Accountant", representative: "Representative", attorney: "Attorney" };

function proofWords(t: BrokerTrace, docSlips: string): string {
  if (t.proof === "payroll") return `Their ${docSlips} (or the entries in the ledger)`;
  if (t.proof === "one_off") return "The ledger entry, plus the letter or invoice";
  return "The entries in their ledger";
}

export function SendToSellerDialog({ open, onOpenChange, dealId, data, previewHref }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  dealId: string;
  data: BrokerGlData;
  previewHref: string | null;
}) {
  const { toast } = useToast();
  const sendable = useMemo(() => (data.traces ?? []).filter((t) => t.proof !== "statement" && t.includeInCim), [data.traces]);
  const recipients = data.recipients ?? [];
  const [costs, setCosts] = useState<Set<string>>(new Set());
  const [people, setPeople] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (!open) return;
    setCosts(new Set(sendable.filter((t) => t.sentAt || !t.privateEvidence).map((t) => t.id)));
    setPeople(new Set(recipients.filter((r) => r.role === "owner" || r.role === "accountant").map((r) => r.id)));
    setMessage(data.tracing?.sellerMessage ?? "");
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const sellerFirst = (data.seller?.name ?? "").split(/\s+/)[0] || "the seller";
  const slips = data.payDoc?.slips ?? "year-end payroll summary";

  const send = useMutation({
    mutationFn: () => sendJson<{ ok: boolean; emailsSent: number; recipients: number; demo: boolean }>("POST", `/api/deals/${dealId}/gl/request`, {
      traceIds: Array.from(costs), recipients: Array.from(people), message,
    }),
    onSuccess: (r) => {
      invalidateGl(dealId);
      onOpenChange(false);
      toast({
        title: "Request sent",
        description: r.demo
          ? "This is a demo deal — nothing was emailed; the request is on the seller's page."
          : r.recipients > 0 ? `${sellerFirst} will see it on their page${r.emailsSent ? " and got an email" : ""}.` : "It's on the seller's page.",
      });
    },
    onError: (e: unknown) => toast({ title: "Couldn't send the request", description: e instanceof Error ? e.message : undefined, variant: "destructive" }),
  });

  const toggle = (set: Set<string>, id: string, on: boolean) => { const n = new Set(set); if (on) n.add(id); else n.delete(id); return n; };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto" data-testid="gl-send-dialog">
        <DialogHeader>
          <DialogTitle>Ask {data.seller?.name || "the seller"} to show these in their books</DialogTitle>
          <DialogDescription>They'll see each cost by a plain name with the amount per year — never how it's treated or your earnings figures.</DialogDescription>
        </DialogHeader>

        <section className="space-y-2">
          <p className="text-sm font-medium">Who receives it</p>
          {recipients.length === 0 ? (
            <p className="text-sm text-amber-600 dark:text-amber-400">Nobody on the seller side has a link yet — invite the seller from the Overview first. The request will still appear on their page once they have one.</p>
          ) : recipients.map((r) => (
            <label key={r.id} className="flex items-start gap-2 text-sm min-h-[32px]">
              <input type="checkbox" className="mt-1 h-4 w-4" checked={people.has(r.id)} onChange={(e) => setPeople(toggle(people, r.id, e.target.checked))} />
              <span className="min-w-0"><span className="font-medium">{r.name || r.email}</span> <span className="text-muted-foreground">· {ROLE[r.role] ?? r.role}{r.name ? ` · ${r.email}` : ""}{r.muted ? " · has email turned off" : ""}</span></span>
            </label>
          ))}
        </section>

        <section className="space-y-2">
          <p className="text-sm font-medium">The costs, as {sellerFirst} will see them</p>
          <ul className="space-y-2">
            {sendable.map((t) => (
              <li key={t.id} className="rounded-md border border-border px-3 py-2">
                <label className="flex items-start gap-2">
                  <input type="checkbox" className="mt-1 h-4 w-4" checked={costs.has(t.id)} disabled={!!t.sentAt} onChange={(e) => setCosts(toggle(costs, t.id, e.target.checked))} />
                  <span className="min-w-0 flex-1">
                    <span className="text-sm font-medium">{t.sellerLabel}</span>
                    {t.sentAt && <span className="text-2xs text-muted-foreground"> · already sent</span>}
                    {t.sellerHint && <span className="block text-xs text-muted-foreground">{t.sellerHint}</span>}
                    <span className="block text-xs text-muted-foreground">{proofWords(t, slips)} · {Object.keys(t.claims).filter((y) => /^\d{4}$/.test(y)).sort().map((y) => `${y}: ${dollars(t.claims[y])}`).join(" · ")}</span>
                    {t.privateEvidence && !t.sentAt && <span className="mt-0.5 flex items-center gap-1 text-2xs text-amber-600 dark:text-amber-400"><Lock className="h-2.5 w-2.5" /> From your private notes — not sent unless you tick it.</span>}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">To change a name or what they look for, open the add-back → More options.</p>
        </section>

        <section className="space-y-1.5">
          <Label htmlFor="gl-send-msg" className="text-sm">A message (optional)</Label>
          <Textarea id="gl-send-msg" rows={2} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={1000} placeholder={`e.g. Thanks ${sellerFirst} — this helps buyers trust the numbers.`} />
        </section>

        {data.demo && <p className="text-xs text-muted-foreground">This is a demo deal — nothing is emailed; the request appears on the seller's page.</p>}

        <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-between">
          {previewHref ? (
            <Button variant="ghost" size="sm" className="h-9 text-xs gap-1.5" onClick={() => window.open(previewHref, "_blank")}>
              <ExternalLink className="h-3.5 w-3.5" /> See what {sellerFirst} will see
            </Button>
          ) : <span />}
          <Button className="bg-teal text-teal-foreground hover:bg-teal/90 gap-1.5" disabled={send.isPending || costs.size === 0 || (recipients.length > 0 && people.size === 0)} onClick={() => send.mutate()} data-testid="gl-send-request">
            {send.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Send request
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
