/**
 * FigureNotesReview — "What buyers will read about your figures" on the
 * seller's CIM review page (dd spec D22, §6).
 *
 * Lists the approved notes that quote the owner (from the interview or a
 * conversation), under the CIM section they attach to. The owner's link can
 * click "Change this": a short box ("What should change?", ≤ 500 characters)
 * and "Send to my broker". The note is hidden from buyers at once and the
 * broker is told why. Other seller-team links read only.
 */
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Loader2, MessageSquareQuote } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";

export interface SellerFigureNoteRow {
  id: string;
  sectionId: string;
  sectionTitle: string;
  label: string;
  text: string;
  basisLabel: string;
}

const MAX = 500;

async function readError(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => ({}));
  return (body && typeof body.error === "string" && body.error) || fallback;
}

export function FigureNotesReview({
  token, notes, canChange, onChanged,
}: { token: string; notes: SellerFigureNoteRow[]; canChange: boolean; onChanged: () => void }) {
  if (notes.length === 0) return null;
  const groups: Array<{ sectionId: string; title: string; notes: SellerFigureNoteRow[] }> = [];
  for (const n of notes) {
    const g = groups.find((x) => x.sectionId === n.sectionId);
    if (g) g.notes.push(n);
    else groups.push({ sectionId: n.sectionId, title: n.sectionTitle, notes: [n] });
  }
  return (
    <section className="rounded-lg border border-border bg-card p-4 sm:p-5 space-y-4" data-testid="seller-figure-notes" aria-labelledby="seller-figure-notes-title">
      <div className="flex items-start gap-3">
        <MessageSquareQuote className="h-5 w-5 text-teal shrink-0 mt-0.5" aria-hidden />
        <div className="min-w-0">
          <h2 id="seller-figure-notes-title" className="text-base font-semibold">What buyers will read about your figures</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            When a buyer points at one of these numbers in your CIM, they see this note, in your words.
            {canChange
              ? " If one isn't right, click Change this: buyers stop seeing it straight away and your broker is told."
              : " The business owner can ask for a change."}
          </p>
        </div>
      </div>
      {groups.map((g) => (
        <div key={g.sectionId} className="space-y-2">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{g.title}</p>
          <ul className="space-y-2">
            {g.notes.map((n) => <NoteRow key={n.id} token={token} note={n} canChange={canChange} onChanged={onChanged} />)}
          </ul>
        </div>
      ))}
    </section>
  );
}

function NoteRow({ token, note, canChange, onChanged }: { token: string; note: SellerFigureNoteRow; canChange: boolean; onChanged: () => void }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState("");
  const send = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/seller/${token}/cim-review/figure-notes/${encodeURIComponent(note.id)}/flag`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Seller-Token": token },
        body: JSON.stringify({ comment: comment.trim() }),
      });
      if (!res.ok) throw new Error(await readError(res, "Couldn't send your note"));
      return res.json();
    },
    onSuccess: () => {
      setOpen(false);
      setComment("");
      toast({ title: "Sent to your broker", description: "Buyers won't see that note until your broker has looked at it." });
      onChanged();
    },
    onError: (e: Error) => toast({ title: "Couldn't send it", description: e.message, variant: "destructive" }),
  });
  const left = MAX - comment.length;
  return (
    <li className="rounded-md border border-border/70 bg-background/40 p-3" data-testid={`seller-figure-note-${note.id}`}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 text-sm">
          <p className="font-medium">{note.label}</p>
          <p className="mt-0.5 break-words">“{note.text}”</p>
          <p className="mt-1 text-xs text-muted-foreground">{note.basisLabel}</p>
        </div>
        {canChange && !open && (
          <Button variant="outline" size="sm" className="shrink-0 self-start" onClick={() => setOpen(true)} data-testid={`button-change-figure-note-${note.id}`}>
            Change this
          </Button>
        )}
      </div>
      {open && (
        <div className="mt-3 space-y-2">
          <label htmlFor={`figure-note-change-${note.id}`} className="text-xs font-medium">What should change?</label>
          <Textarea
            id={`figure-note-change-${note.id}`}
            value={comment}
            onChange={(e) => setComment(e.target.value.slice(0, MAX))}
            rows={3}
            maxLength={MAX}
            placeholder="For example: “The lease started in November 2022, not October.”"
            className="text-sm"
            data-testid={`input-figure-note-change-${note.id}`}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className={left < 40 ? "text-xs text-amber-500" : "text-xs text-muted-foreground"}>{left} characters left</span>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => { setOpen(false); setComment(""); }}>Cancel</Button>
              <Button
                size="sm"
                className="bg-teal text-teal-foreground hover:bg-teal/90"
                disabled={comment.trim().length < 1 || send.isPending}
                onClick={() => send.mutate()}
                data-testid={`button-send-figure-note-change-${note.id}`}
              >
                {send.isPending && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
                Send to my broker
              </Button>
            </div>
          </div>
        </div>
      )}
    </li>
  );
}
