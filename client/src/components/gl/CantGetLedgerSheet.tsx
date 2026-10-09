/**
 * CantGetLedgerSheet — "I can't get my ledger" (gl spec §3.3 A): a dialog on
 * a computer, a bottom sheet on a phone.
 *   My accountant has it   → their name and email; the broker sends them their
 *                            own link (nothing is sent until the broker does)
 *   I don't use accounting software → tell the broker (they'll find another way)
 *   Something else         → a note to the broker
 * Also: OtherCostsBox — "Anything else?" at the end of the seller's page.
 */
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import { sendJson, type SellerEntry } from "@/lib/gl-api";
import { LedgerSearch, entryKey } from "./EntryRow";

type Choice = "accountant" | "no_software" | "other" | null;

export function CantGetLedgerSheet({ token, open, onOpenChange, onDone, preview }: { token: string; open: boolean; onOpenChange: (o: boolean) => void; onDone: (what: "accountant" | "told") => void; preview?: boolean }) {
  const isMobile = useIsMobile();
  const [choice, setChoice] = useState<Choice>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const send = useMutation({
    mutationFn: () =>
      choice === "accountant"
        ? sendJson("POST", `/api/seller/${token}/gl/accountant`, { name, email })
        : sendJson("POST", `/api/seller/${token}/gl/cant-get-ledger`, { reason: choice, ...(choice === "other" ? { note } : {}) }),
    onSuccess: () => { onOpenChange(false); onDone(choice === "accountant" ? "accountant" : "told"); setChoice(null); },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : "That didn't go through — try again."),
  });
  const body = (
    <div className="space-y-3">
      {([
        ["accountant", "My accountant has it"],
        ["no_software", "I don't use accounting software"],
        ["other", "Something else"],
      ] as const).map(([k, l]) => (
        <button key={k} type="button" onClick={() => { setChoice(k); setError(null); }} aria-pressed={choice === k}
          className={cn("w-full text-left rounded-lg border px-4 py-3 text-sm min-h-[44px]", choice === k ? "border-teal bg-teal/5" : "border-border hover:bg-muted/30")}>{l}</button>
      ))}
      {choice === "accountant" && (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">Your broker will send them their own link for this step. Nothing is sent until your broker does.</p>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your accountant's name" className="h-10" maxLength={120} aria-label="Accountant's name" />
          <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Their email" type="email" className="h-10" maxLength={200} aria-label="Accountant's email" />
        </div>
      )}
      {choice === "no_software" && <p className="text-sm text-muted-foreground">Tell your broker — they'll find another way, like bank statements.</p>}
      {choice === "other" && <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={1000} placeholder="What's happening?" aria-label="What's happening" />}
      {error && <p className="text-xs text-red-600 dark:text-red-400" role="alert">{error}</p>}
      {choice && (
        <Button className="w-full h-11 bg-teal text-teal-foreground hover:bg-teal/90" disabled={preview || send.isPending || (choice === "accountant" && (!name.trim() || !email.trim())) || (choice === "other" && !note.trim())} onClick={() => send.mutate()}>
          {send.isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}{choice === "no_software" ? "Tell my broker" : "Send to my broker"}
        </Button>
      )}
      {preview && <p className="text-xs text-muted-foreground">Preview — nothing you do here is saved.</p>}
    </div>
  );
  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="bottom" className="max-h-[90vh] overflow-y-auto">
          <SheetHeader className="text-left"><SheetTitle>I can't get my ledger</SheetTitle><SheetDescription>Tell us what's happening — your broker decides what's next.</SheetDescription></SheetHeader>
          <div className="mt-4">{body}</div>
        </SheetContent>
      </Sheet>
    );
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>I can't get my ledger</DialogTitle><DialogDescription>Tell us what's happening — your broker decides what's next.</DialogDescription></DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  );
}

export function OtherCostsBox({ token, years, preview, onSent }: { token: string; years: string[]; preview?: boolean; onSent: () => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [attach, setAttach] = useState(false);
  const [entries, setEntries] = useState<SellerEntry[]>([]);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = useMutation({
    mutationFn: () => sendJson("POST", `/api/seller/${token}/gl/other-costs`, { text, entries: entries.map((e) => ({ ledgerId: e.ledgerId, rowNo: e.rowNo })) }),
    onSuccess: () => { setSent(true); setText(""); setEntries([]); setAttach(false); onSent(); },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : "That didn't go through — try again."),
  });
  return (
    <section className="rounded-lg border border-border bg-card" data-testid="other-costs">
      <button type="button" className="w-full text-left px-4 py-3 min-h-[44px]" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="text-sm font-medium">Anything else?</span> <span className="text-xs text-muted-foreground">(optional)</span>
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-3">
          <p className="text-sm text-muted-foreground">Does the business pay for anything else that's personal or one-off — like your phone, a family car or the cottage insurance? Tell your broker; they decide what counts.</p>
          {sent && <p className="text-sm text-success">Sent to your broker. You can add more.</p>}
          <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={2000} placeholder="e.g. My cell phone and my daughter's car insurance" aria-label="Other costs" />
          {!attach ? (
            <button type="button" className="text-xs text-teal hover:underline" onClick={() => setAttach(true)}>Attach entries from your ledger</button>
          ) : (
            <LedgerSearch searchUrl={`/api/seller/${token}/gl/search`} years={years} disabled={preview}
              isChecked={(e) => entries.some((x) => entryKey(x) === entryKey(e))}
              onAdd={(e, v) => setEntries(v ? [...entries.filter((x) => entryKey(x) !== entryKey(e)), e] : entries.filter((x) => entryKey(x) !== entryKey(e)))} />
          )}
          {entries.length > 0 && <p className="text-xs text-muted-foreground">{entries.length} entr{entries.length === 1 ? "y" : "ies"} attached.</p>}
          {error && <p className="text-xs text-red-600 dark:text-red-400" role="alert">{error}</p>}
          <Button variant="outline" className="h-10" disabled={preview || text.trim().length < 3 || send.isPending} onClick={() => send.mutate()}>
            {send.isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />} Send to my broker
          </Button>
        </div>
      )}
    </section>
  );
}
