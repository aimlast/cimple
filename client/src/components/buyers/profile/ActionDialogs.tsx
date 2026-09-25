/**
 * Buyer profile actions: email this buyer (AI draft → broker edits → broker
 * clicks Send), give access to a deal (existing grant endpoint), remove from
 * my list.
 */
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles, Send, Copy, Check, AlertTriangle, KeyRound, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { requestJson } from "./types";

const NO_DEAL = "__none";

interface DealOption { id: string; businessName: string; archivedAt?: string | null }

function useMyDeals(enabled: boolean) {
  return useQuery<DealOption[]>({
    queryKey: ["/api/deals"],
    queryFn: () => requestJson("GET", "/api/deals"),
    enabled,
    select: (rows) => (rows || []).filter((d: any) => !d.archivedAt).map((d: any) => ({ id: d.id, businessName: d.businessName })),
  });
}

export function EmailDialog({
  open, onOpenChange, buyerId, buyerName, buyerEmail, defaultDealId,
}: {
  open: boolean; onOpenChange: (o: boolean) => void; buyerId: string; buyerName: string; buyerEmail: string; defaultDealId?: string | null;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const deals = useMyDeals(open);
  const [dealId, setDealId] = useState<string>(defaultDealId || NO_DEAL);
  const [instructions, setInstructions] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [replyTo, setReplyTo] = useState<string | null | undefined>(undefined);
  const [blindSafe, setBlindSafe] = useState(false);

  useEffect(() => {
    if (open) { setDealId(defaultDealId || NO_DEAL); setInstructions(""); setSubject(""); setBody(""); setBlindSafe(false); }
  }, [open, defaultDealId]);

  const draft = useMutation({
    mutationFn: () => requestJson<{ subject: string; body: string; replyTo: string | null; blindSafe: boolean }>(
      "POST", `/api/broker/buyers/${buyerId}/email/draft`, { dealId: dealId === NO_DEAL ? null : dealId, instructions: instructions.trim() || null }),
    onSuccess: (d) => { setSubject(d.subject); setBody(d.body); setReplyTo(d.replyTo); setBlindSafe(d.blindSafe); },
    onError: (e: Error) => toast({ title: "Couldn't draft the email", description: e.message, variant: "destructive" }),
  });
  const send = useMutation({
    mutationFn: () => requestJson<{ status: string; error: string | null }>(
      "POST", `/api/broker/buyers/${buyerId}/email`, { subject, body, dealId: dealId === NO_DEAL ? null : dealId }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["/api/broker/buyers", buyerId] });
      if (r.status === "sent") {
        toast({ title: "Email sent", description: `To ${buyerEmail}` });
        onOpenChange(false);
      } else {
        toast({ title: "Not delivered", description: r.error || "The email couldn't be sent.", variant: "destructive" });
      }
    },
    onError: (e: Error) => toast({ title: "Couldn't send", description: e.message, variant: "destructive" }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Email {buyerName.split(" ")[0]}</DialogTitle>
          <DialogDescription>Nothing is sent until you click Send.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs">About</Label>
              <Select value={dealId} onValueChange={setDealId}>
                <SelectTrigger className="h-9" data-testid="select-email-deal"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_DEAL}>No specific listing</SelectItem>
                  {(deals.data ?? []).map((d) => <SelectItem key={d.id} value={d.id}>{d.businessName}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">To</Label>
              <Input value={buyerEmail} readOnly className="h-9 text-muted-foreground" />
            </div>
          </div>
          <div className="rounded-lg border border-dashed border-border p-3 space-y-2">
            <Label className="text-xs">Draft it for me (optional)</Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="e.g. follow up on their questions, invite a call next week" className="h-9" data-testid="input-email-instructions" />
              <Button type="button" variant="outline" size="sm" className="h-9 shrink-0" onClick={() => draft.mutate()} disabled={draft.isPending} data-testid="button-draft-email">
                {draft.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5 mr-1.5" />}
                {subject || body ? "Redraft" : "Draft with AI"}
              </Button>
            </div>
            {dealId !== NO_DEAL && <p className="text-2xs text-muted-foreground">About a listing, the draft is blind-safe: codename, industry, region and ranges only — never the business name or city.</p>}
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Subject</Label>
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} className="h-9" data-testid="input-email-subject" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Message</Label>
            <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={10} className="text-sm leading-relaxed" data-testid="input-email-body" />
          </div>
          {replyTo === null && (
            <p className="flex items-start gap-1.5 text-2xs text-amber-400"><AlertTriangle className="h-3 w-3 mt-px shrink-0" />Your account has no email address, so replies can't reach you. Add one in Settings.</p>
          )}
          {replyTo && <p className="text-2xs text-muted-foreground">Replies go to {replyTo}.{blindSafe ? " Draft checked for the business name." : ""}</p>}
        </div>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => send.mutate()} disabled={!subject.trim() || !body.trim() || send.isPending} data-testid="button-send-email">
            {send.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Send className="h-3.5 w-3.5 mr-1.5" />} Send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function GrantAccessDialog({
  open, onOpenChange, buyerId, buyerName, buyerEmail, buyerCompany, existingDealIds,
}: {
  open: boolean; onOpenChange: (o: boolean) => void; buyerId: string; buyerName: string; buyerEmail: string; buyerCompany: string | null; existingDealIds: string[];
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const deals = useMyDeals(open);
  const [dealId, setDealId] = useState<string>("");
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (open) { setDealId(""); setLink(null); setCopied(false); } }, [open]);
  const available = (deals.data ?? []).filter((d) => !existingDealIds.includes(d.id));

  const grant = useMutation({
    mutationFn: () => requestJson<{ accessToken: string }>("POST", `/api/deals/${dealId}/buyers`, { buyerEmail, buyerName, buyerCompany }),
    onSuccess: (a) => {
      setLink(`${window.location.origin}/view/${a.accessToken}`);
      qc.invalidateQueries({ queryKey: ["/api/broker/buyers", buyerId] });
      qc.invalidateQueries({ queryKey: ["/api/deals", dealId, "buyers"] });
    },
    onError: (e: Error) => toast({ title: "Couldn't give access", description: e.message, variant: "destructive" }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Give {buyerName.split(" ")[0]} access to a deal</DialogTitle>
          <DialogDescription>Creates their secure CIM link. Nothing is emailed — you share the link.</DialogDescription>
        </DialogHeader>
        {link ? (
          <div className="space-y-2">
            <Label className="text-xs">Secure link for {buyerEmail}</Label>
            <div className="flex gap-2">
              <Input value={link} readOnly className="h-9 font-mono text-xs" data-testid="input-grant-link" />
              <Button size="sm" variant="outline" className="h-9" onClick={async () => { try { await navigator.clipboard.writeText(link); setCopied(true); } catch { /* manual copy */ } }}>
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              </Button>
            </div>
            <p className="text-2xs text-muted-foreground">They'll be asked to sign the NDA before the CIM opens. Manage the link on the deal's Buyers tab.</p>
          </div>
        ) : (
          <div className="space-y-1">
            <Label className="text-xs">Deal</Label>
            <Select value={dealId} onValueChange={setDealId}>
              <SelectTrigger className="h-9" data-testid="select-grant-deal"><SelectValue placeholder={deals.isLoading ? "Loading your deals…" : "Choose a deal"} /></SelectTrigger>
              <SelectContent>
                {available.map((d) => <SelectItem key={d.id} value={d.id}>{d.businessName}</SelectItem>)}
              </SelectContent>
            </Select>
            {!deals.isLoading && available.length === 0 && <p className="text-2xs text-muted-foreground">They already have access to all of your deals.</p>}
          </div>
        )}
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>{link ? "Done" : "Cancel"}</Button>
          {!link && (
            <Button onClick={() => grant.mutate()} disabled={!dealId || grant.isPending} data-testid="button-confirm-grant">
              <KeyRound className="h-3.5 w-3.5 mr-1.5" /> Create link
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RemoveBuyerDialog({ open, onOpenChange, buyerId, buyerName }: { open: boolean; onOpenChange: (o: boolean) => void; buyerId: string; buyerName: string }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, setLocation] = useLocation();
  const remove = useMutation({
    mutationFn: () => requestJson<{ stillListed: boolean; reason: string | null }>("DELETE", `/api/broker/buyers/${buyerId}`),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["/api/broker/buyers"] });
      onOpenChange(false);
      if (r.stillListed) {
        toast({ title: "Notes and edits removed", description: r.reason ?? undefined });
        qc.invalidateQueries({ queryKey: ["/api/broker/buyers", buyerId] });
      } else {
        toast({ title: `${buyerName} removed from your buyers` });
        setLocation("/broker/buyers");
      }
    },
    onError: (e: Error) => toast({ title: "Couldn't remove", description: e.message, variant: "destructive" }),
  });
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {buyerName} from your buyers?</AlertDialogTitle>
          <AlertDialogDescription>
            Your notes, tags, interest label and edits to their profile are deleted. Their own Cimple account and anything they
            told you on an NDA stay as they are. If they have access to one of your deals they'll stay listed until you revoke it.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep</AlertDialogCancel>
          <AlertDialogAction onClick={(e) => { e.preventDefault(); remove.mutate(); }} className="bg-destructive text-destructive-foreground hover:bg-destructive/90" data-testid="button-confirm-remove">
            {remove.isPending ? "Removing…" : "Remove"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
