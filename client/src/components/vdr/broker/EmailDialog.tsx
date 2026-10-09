/**
 * The email the broker reads, edits and sends from the data room (vdr spec
 * V15): "Tell the buyer", "Let them know?". Never sent automatically: the
 * broker's Send is the only way out. Each buyer's own data-room link is
 * added at the end; replies go to the broker. Example deals record and never
 * send — the dialog says so.
 */
import { useEffect, useState } from "react";
import { Loader2, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import type { EmailDraft } from "@shared/vdr-api";

export function EmailDialog({
  open,
  onOpenChange,
  title,
  loadDraft,
  send,
  initial,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  /** Loads the prefilled email when the dialog opens (unless `initial` is given). */
  loadDraft?: () => Promise<EmailDraft>;
  initial?: EmailDraft | null;
  send: (subject: string, message: string) => Promise<{ sent: number; failed: number; demo: boolean }>;
}) {
  const { toast } = useToast();
  const [draft, setDraft] = useState<EmailDraft | null>(initial ?? null);
  const [subject, setSubject] = useState(initial?.subject ?? "");
  const [message, setMessage] = useState(initial?.message ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (initial) {
      setDraft(initial);
      setSubject(initial.subject);
      setMessage(initial.message);
      return;
    }
    if (!loadDraft) return;
    let live = true;
    setLoading(true);
    setError(null);
    loadDraft()
      .then((d) => { if (!live) return; setDraft(d); setSubject(d.subject); setMessage(d.message); })
      .catch((e: Error) => { if (live) setError(e.message); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    setSending(true);
    try {
      const r = await send(subject.trim(), message.trim());
      if (r.demo) toast({ title: "Recorded, not sent", description: "This is an example deal, so Cimple doesn't email anyone." });
      else if (r.failed > 0 && r.sent === 0) toast({ title: "The email didn't go out", description: "Email isn't working right now. Try again later.", variant: "destructive" });
      else toast({ title: r.sent === 1 ? "Email sent" : `Sent to ${r.sent} buyers`, description: r.failed ? `${r.failed} didn't go out.` : undefined });
      onOpenChange(false);
    } catch (e: any) {
      toast({ title: "Couldn't send the email", description: e?.message, variant: "destructive" });
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">{title}</DialogTitle>
          <DialogDescription>You can change anything before you send it. Nothing goes out until you click Send.</DialogDescription>
        </DialogHeader>
        {loading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Preparing the email…</div>
        ) : error ? (
          <p className="py-4 text-sm text-destructive">{error}</p>
        ) : draft ? (
          <div className="space-y-3 text-sm">
            <div>
              <p className="text-xs font-medium text-muted-foreground">To</p>
              <p className="mt-0.5">{draft.to.length ? draft.to.join(", ") : "Nobody can open these documents right now."}</p>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground" htmlFor="vdr-email-subject">Subject</label>
              <Input id="vdr-email-subject" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} className="mt-1" />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground" htmlFor="vdr-email-message">Message</label>
              <Textarea id="vdr-email-message" value={message} onChange={(e) => setMessage(e.target.value)} maxLength={2000} rows={7} className="mt-1" />
              <p className="mt-1 text-xs text-muted-foreground">Each buyer's own data-room link is added at the end. Replies come to you.</p>
            </div>
            {draft.demo && <p className="rounded-md border border-teal/30 bg-teal/5 px-3 py-2 text-xs">This is an example deal: Cimple records the email and doesn't send it.</p>}
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={sending || loading || !draft || !draft.to.length || !subject.trim() || !message.trim()} data-testid="vdr-email-send">
            {sending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Mail className="mr-1.5 h-3.5 w-3.5" />} Send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
