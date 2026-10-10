/**
 * EmailCodeStep — "Confirm your email" before a buyer asks for the CIM from
 * the teaser (spec §5.5 step 0). A 6-digit code goes to the address the
 * broker sent the link to, so a forwarded link can be read but only the
 * original recipient can ask for the CIM.
 *
 *   [Send the code] → six boxes (paste fills all six; one-time-code autofill)
 *   → [Confirm]; "Didn't get it? Send again (in 60 s)".
 * Errors: wrong code (tries left), expired, too many codes sent.
 */
import { useEffect, useRef, useState } from "react";
import { AlertCircle, Loader2, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

async function post(url: string, body?: unknown): Promise<{ ok: boolean; status: number; json: any }> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

export const RESEND_SECONDS = 60;

export function EmailCodeStep({
  token, maskedEmail, firm, onVerified,
}: {
  token: string;
  maskedEmail: string | null;
  firm: string;
  onVerified: () => void;
}) {
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [digits, setDigits] = useState<string[]>(["", "", "", "", "", ""]);
  const [error, setError] = useState<string | null>(null);
  const [wait, setWait] = useState(0);
  const [shownEmail, setShownEmail] = useState(maskedEmail);
  const boxes = useRef<Array<HTMLInputElement | null>>([]);

  useEffect(() => {
    if (wait <= 0) return;
    const t = window.setTimeout(() => setWait((w) => w - 1), 1000);
    return () => window.clearTimeout(t);
  }, [wait]);

  const send = async () => {
    setSending(true);
    setError(null);
    try {
      const r = await post(`/api/view/${token}/email-check`);
      if (r.ok && r.json?.skipped) { onVerified(); return; }
      if (r.ok) {
        setSent(true);
        setWait(RESEND_SECONDS);
        if (r.json?.maskedEmail) setShownEmail(r.json.maskedEmail);
        setDigits(["", "", "", "", "", ""]);
        window.setTimeout(() => boxes.current[0]?.focus(), 50);
        return;
      }
      if (r.status === 429) setError(`Too many codes sent. Try again in an hour or contact ${firm}.`);
      else setError(r.json?.error || "Couldn't send the code. Try again.");
    } catch {
      setError("Couldn't send the code. Check your connection and try again.");
    } finally {
      setSending(false);
    }
  };

  const verify = async (code: string) => {
    if (code.length !== 6) return;
    setVerifying(true);
    setError(null);
    try {
      const r = await post(`/api/view/${token}/email-check/verify`, { code });
      if (r.ok && r.json?.verified) { onVerified(); return; }
      if (r.json?.code === "wrong_code") setError(`That code isn't right — ${r.json.triesLeft} ${r.json.triesLeft === 1 ? "try" : "tries"} left.`);
      else if (r.json?.code === "expired") setError("That code has expired. Send a new one.");
      else if (r.json?.code === "locked") setError("Too many tries. Send a new code.");
      else if (r.status === 429) setError(`Too many tries. Try again in an hour or contact ${firm}.`);
      else setError(r.json?.error || "Couldn't check the code. Try again.");
      setDigits(["", "", "", "", "", ""]);
      window.setTimeout(() => boxes.current[0]?.focus(), 50);
    } catch {
      setError("Couldn't check the code. Check your connection and try again.");
    } finally {
      setVerifying(false);
    }
  };

  const setDigit = (i: number, raw: string) => {
    const only = raw.replace(/\D/g, "");
    if (only.length > 1) {
      // Paste (or one-time-code autofill) fills from this box on.
      const next = [...digits];
      for (let k = 0; k < only.length && i + k < 6; k++) next[i + k] = only[k];
      setDigits(next);
      const filled = next.join("");
      if (filled.length === 6) verify(filled);
      else boxes.current[Math.min(5, i + only.length)]?.focus();
      return;
    }
    const next = [...digits];
    next[i] = only;
    setDigits(next);
    if (only && i < 5) boxes.current[i + 1]?.focus();
    if (next.join("").length === 6) verify(next.join(""));
  };

  return (
    <div className="space-y-4" data-testid="email-code-step">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-teal/10"><Mail className="h-5 w-5 text-teal" /></div>
        <div className="min-w-0">
          <h2 className="text-base font-semibold">Confirm your email</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            So only you can ask for this CIM, we'll send a 6-digit code to <span className="font-medium text-foreground">{shownEmail ?? "your email"}</span>.
          </p>
        </div>
      </div>

      {!sent ? (
        <Button className="w-full bg-teal text-teal-foreground hover:bg-teal/90" onClick={send} disabled={sending} data-testid="button-send-email-code">
          {sending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />} Send the code
        </Button>
      ) : (
        <div className="space-y-3">
          <div className="flex justify-between gap-2" role="group" aria-label="The 6-digit code">
            {digits.map((d, i) => (
              <input
                key={i}
                ref={(el) => { boxes.current[i] = el; }}
                value={d}
                inputMode="numeric"
                autoComplete={i === 0 ? "one-time-code" : "off"}
                maxLength={i === 0 ? 6 : 1}
                aria-label={`Digit ${i + 1}`}
                disabled={verifying}
                onChange={(e) => setDigit(i, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Backspace" && !digits[i] && i > 0) boxes.current[i - 1]?.focus();
                  if (e.key === "Enter") verify(digits.join(""));
                }}
                onPaste={(e) => { e.preventDefault(); setDigit(i, e.clipboardData.getData("text")); }}
                className={cn(
                  "h-12 w-full max-w-[52px] rounded-md border bg-background text-center text-lg font-semibold tabular-nums outline-none focus:border-teal focus:ring-2 focus:ring-teal/30",
                  error ? "border-destructive/60" : "border-input",
                )}
                data-testid={`input-email-code-${i}`}
              />
            ))}
          </div>
          <Button className="w-full bg-teal text-teal-foreground hover:bg-teal/90" onClick={() => verify(digits.join(""))} disabled={verifying || digits.join("").length !== 6} data-testid="button-confirm-email-code">
            {verifying && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />} Confirm
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            Didn't get it?{" "}
            <button type="button" className="text-teal underline-offset-2 hover:underline disabled:text-muted-foreground disabled:no-underline" onClick={send} disabled={wait > 0 || sending} data-testid="button-resend-email-code">
              {wait > 0 ? `Send again (in ${wait} s)` : "Send again"}
            </button>
          </p>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert" data-testid="text-email-code-error">
          <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" /> <span>{error}</span>
        </div>
      )}
      <p className="text-[11px] text-muted-foreground">Not your email? This link was sent to someone else — ask {firm} for your own.</p>
    </div>
  );
}
