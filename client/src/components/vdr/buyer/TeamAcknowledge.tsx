/**
 * A team member's first visit (vdr spec §6.8): no buyer-profile form — one
 * short confidentiality step with their full name. Stored with the time and
 * a keyed hash of their network address; then the buyer's room opens with
 * their own watermark.
 */
import { useState } from "react";
import { Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { vdrFetch } from "@/hooks/useDataRoom";

const ROLE: Record<string, string> = { accountant: "accountant", lawyer: "lawyer", lender: "lender", adviser: "adviser", colleague: "colleague" };

export function ackCopy(company: string, role: string): string {
  return `${company} signed a confidentiality agreement with the seller. You're opening their data room as their ${ROLE[role] ?? "adviser"}. By continuing, you agree to keep everything here confidential and to use it only to advise ${company} on this purchase.`;
}

export function TeamAcknowledge({ token, principalCompany, role, name, firmName, onDone }: { token: string; principalCompany: string | null; role: string | null; name: string | null; firmName?: string | null; onDone: () => void }) {
  const company = principalCompany || "The buyer";
  const [fullName, setFullName] = useState(name ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await vdrFetch("POST", `/api/view/${encodeURIComponent(token)}/data-room/acknowledge`, { name: fullName });
      onDone();
    } catch (e: any) {
      setError(e?.message ?? "That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4 sm:p-6">
      <form
        className="w-full max-w-md space-y-4 rounded-xl border border-border bg-card p-6 shadow-sm"
        onSubmit={(e) => { e.preventDefault(); if (fullName.trim().length >= 2) void submit(); }}
        data-testid="team-acknowledge"
      >
        {firmName && <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Shared by {firmName}</p>}
        <div className="flex items-start gap-2">
          <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-teal" />
          <h1 className="text-base font-semibold">{company}'s data room</h1>
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">{ackCopy(company, role ?? "adviser")}</p>
        <label className="block space-y-1.5">
          <span className="text-xs font-medium">Your full name</span>
          <Input value={fullName} onChange={(e) => setFullName(e.target.value)} autoComplete="name" maxLength={120} data-testid="team-ack-name" />
        </label>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <Button type="submit" className="w-full" disabled={busy || fullName.trim().length < 2} data-testid="team-ack-continue">
          {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />} Continue
        </Button>
        <p className="text-[11px] text-muted-foreground">Every page you open carries your name. The broker can see which documents you open.</p>
      </form>
    </div>
  );
}
