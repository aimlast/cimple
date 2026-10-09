/**
 * TeaserRequestFlow — "Ask for the CIM" from the teaser (spec §5.5), a
 * full-screen sheet:
 *   0. Confirm your email (skipped when already confirmed, signed in to a
 *      verified account with that email, or on a demo deal)
 *   1. About you, 2. The NDA (NdaBuyerProfileGate, purpose "request") — the
 *      signature IS the request; on a deal without an NDA, step 1 sends it
 *   3. "Request sent" + an optional note for the broker — or, when the deal
 *      gives the CIM automatically and the CIM is live, "You're in" and the
 *      page reloads into the CIM on the same link.
 * A failure after signing keeps the signature and retries with /cim-request.
 */
import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { NdaBuyerProfileGate } from "./NdaBuyerProfileGate";
import { EmailCodeStep } from "./EmailCodeStep";

type Step = "email" | "profile" | "retrying" | "sent" | "in" | "error";

export interface TeaserRequestFlowProps {
  token: string;
  codename: string;
  firm: string;
  buyerEmail: string;
  buyerName: string | null;
  ndaRequired: boolean;
  emailCheck: { needed: boolean; maskedEmail: string | null; verified: boolean };
  onClose: () => void;
  /** The request's state changed (refetch the summary page). */
  onRequested: (autoGranted: boolean) => void;
}

export function TeaserRequestFlow(p: TeaserRequestFlowProps) {
  const [step, setStep] = useState<Step>(p.emailCheck.needed && !p.emailCheck.verified ? "email" : "profile");
  const [error, setError] = useState<string | null>(null);
  const firstName = p.buyerName?.trim().split(/\s+/)[0] || null;
  const [note, setNote] = useState("");
  const [noteState, setNoteState] = useState<"idle" | "sending" | "sent">("idle");

  // Escape closes (except while sending).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && step !== "retrying") p.onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, p]);

  const retryRequest = async () => {
    setStep("retrying");
    setError(null);
    try {
      const res = await fetch(`/api/view/${p.token}/cim-request`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmProfile: true }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (body?.code === "has_cim_link" || body?.code === "already_cim") throw new Error("You already have access to the CIM. Use the link your broker sent you.");
        if (body?.code === "email_check_required") { setStep("email"); return; }
        throw new Error(body.error || "Couldn't send your request. Try again.");
      }
      done(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't send your request. Try again.");
      setStep("error");
    }
  };

  const done = (body: Record<string, any> | undefined) => {
    if (body?.retry) { void retryRequest(); return; }
    const autoGranted = !!body?.autoGranted;
    setStep(autoGranted ? "in" : "sent");
    p.onRequested(autoGranted);
  };

  const sendNote = async () => {
    if (!note.trim()) return;
    setNoteState("sending");
    try {
      const res = await fetch(`/api/view/${p.token}/cim-request/note`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ note: note.trim() }) });
      if (!res.ok) throw new Error();
      setNoteState("sent");
    } catch {
      setNoteState("idle");
      setError("Couldn't send your note. Try again.");
    }
  };

  if (step === "profile") {
    return (
      <NdaBuyerProfileGate
        dealName={p.codename}
        token={p.token}
        purpose="request"
        skipNda={!p.ndaRequired}
        onCancel={p.onClose}
        onAccepted={(body) => done(body)}
      />
    );
  }

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-background" role="dialog" aria-modal="true" aria-label={`Ask for the CIM — ${p.codename}`} data-testid="teaser-request-flow">
      <div className="flex min-h-full items-start justify-center p-4 sm:items-center sm:p-6">
        <div className="relative w-full max-w-md space-y-5 rounded-xl border border-border bg-card p-5 shadow-lg sm:p-8">
          {(step === "email" || step === "error") && (
            <button type="button" onClick={p.onClose} className="absolute right-3 top-3 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Back to the summary">
              <X className="h-4 w-4" />
            </button>
          )}
          {step === "email" && (
            <>
              <p className="text-xs font-medium text-muted-foreground">Ask for the CIM — {p.codename}</p>
              <EmailCodeStep token={p.token} maskedEmail={p.emailCheck.maskedEmail} firm={p.firm} onVerified={() => setStep("profile")} />
            </>
          )}
          {step === "retrying" && (
            <div className="flex flex-col items-center gap-2 py-8 text-sm text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /> Sending your request…</div>
          )}
          {step === "error" && (
            <div className="space-y-3" role="alert">
              <h2 className="text-base font-semibold">Couldn't send your request</h2>
              <p className="text-sm text-muted-foreground">{error}</p>
              <p className="text-xs text-muted-foreground">If you signed the NDA, it stays signed.</p>
              <Button className="w-full bg-teal text-teal-foreground hover:bg-teal/90" onClick={retryRequest}>Try again</Button>
            </div>
          )}
          {step === "sent" && (
            <div className="space-y-4" data-testid="teaser-request-sent">
              <div className="flex items-start gap-3">
                <CheckCircle2 className="mt-0.5 h-6 w-6 shrink-0 text-success" />
                <div>
                  <h2 className="text-base font-semibold">Request sent</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Thanks{firstName ? `, ${firstName}` : ""}. {p.firm} will review your request and email you at <span className="text-foreground">{p.buyerEmail}</span>.
                  </p>
                </div>
              </div>
              {noteState === "sent" ? (
                <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">Your note is with {p.firm}.</p>
              ) : (
                <div className="space-y-1.5">
                  <label htmlFor="teaser-request-note" className="text-xs font-medium">Add a note for {p.firm} (optional)</label>
                  <Textarea id="teaser-request-note" value={note} onChange={(e) => setNote(e.target.value.slice(0, 1000))} rows={3} className="resize-none text-sm" placeholder="e.g. what you'd do with the business, or when you could talk" data-testid="input-teaser-request-note" />
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] tabular-nums text-muted-foreground">{note.length}/1,000</span>
                    <Button size="sm" variant="outline" onClick={sendNote} disabled={!note.trim() || noteState === "sending"} data-testid="button-send-teaser-note">
                      {noteState === "sending" && <Loader2 className="mr-1 h-3 w-3 animate-spin" />} Send note
                    </Button>
                  </div>
                  {error && <p className="text-xs text-destructive">{error}</p>}
                </div>
              )}
              <Button className="w-full" variant="secondary" onClick={p.onClose} data-testid="button-back-to-summary">Back to the summary</Button>
            </div>
          )}
          {step === "in" && (
            <div className="space-y-4 text-center" data-testid="teaser-request-in">
              <CheckCircle2 className="mx-auto h-8 w-8 text-success" />
              <h2 className="text-base font-semibold">You're in</h2>
              <p className="text-sm text-muted-foreground">{p.firm} shares the CIM with everyone who signs the NDA.</p>
              <Button className="w-full bg-teal text-teal-foreground hover:bg-teal/90" onClick={() => window.location.reload()} data-testid="button-open-the-cim">Open the CIM</Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
