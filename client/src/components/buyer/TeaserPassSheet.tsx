/**
 * TeaserPassSheet — "Not for me" on the teaser: a small sheet with reason
 * chips (too small or large · location · industry · price · timing ·
 * something else) and an optional note (500 characters). It is recorded for
 * the broker as an event; nothing is emailed. The buyer can still ask for
 * the CIM afterwards.
 */
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { TEASER_PASS_REASONS, type TeaserPassReason } from "@shared/teaser";
import { cn } from "@/lib/utils";

export const PASS_REASON_LABELS: Record<TeaserPassReason, string> = {
  size: "Too small or large",
  location: "Location",
  industry: "Industry",
  price: "Price",
  timing: "Timing",
  other: "Something else",
};

export function TeaserPassSheet({
  token, firm, open, onOpenChange, onSent,
}: {
  token: string;
  firm: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSent: () => void;
}) {
  const [reasons, setReasons] = useState<TeaserPassReason[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/view/${token}/teaser-pass`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reasons, note: note.trim() || null }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Couldn't send that. Try again.");
      }
      onSent();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't send that. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="teaser-pass-sheet">
        <DialogHeader>
          <DialogTitle>Not for you?</DialogTitle>
          <DialogDescription>It helps {firm} send you better matches.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Why it isn't for you">
            {TEASER_PASS_REASONS.map((r) => {
              const on = reasons.includes(r);
              return (
                <button
                  key={r}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setReasons(on ? reasons.filter((x) => x !== r) : [...reasons, r])}
                  className={cn("rounded-full border px-3 py-1 text-xs transition-colors", on ? "border-teal bg-teal/15 text-foreground" : "border-border text-muted-foreground hover:border-teal/50 hover:text-foreground")}
                  data-testid={`teaser-pass-${r}`}
                >
                  {PASS_REASON_LABELS[r]}
                </button>
              );
            })}
          </div>
          <div className="space-y-1">
            <Textarea value={note} onChange={(e) => setNote(e.target.value.slice(0, 500))} rows={3} placeholder="Anything else? (optional)" className="resize-none text-sm" data-testid="input-teaser-pass-note" />
            <p className="text-right text-[10px] tabular-nums text-muted-foreground">{note.length}/500</p>
          </div>
          {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
        </div>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button className="bg-teal text-teal-foreground hover:bg-teal/90" onClick={send} disabled={busy} data-testid="button-send-teaser-pass">
            {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />} Send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
