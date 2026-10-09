/**
 * "Your team" in the buyer's data room (vdr spec §6.8): the people the
 * buyer works with (accountant, lawyer, lender, adviser, colleague), each
 * with their own link from the broker. The buyer asks to add someone; the
 * broker approves and sends the link (never automatic). Up to 5.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, UserPlus, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import type { BuyerTeamRow } from "@shared/vdr-api";
import { vdrFetch } from "@/hooks/useDataRoom";

export const TEAM_ROLE_OPTIONS = [
  { key: "accountant", label: "Accountant" },
  { key: "lawyer", label: "Lawyer" },
  { key: "lender", label: "Lender" },
  { key: "adviser", label: "Adviser" },
  { key: "colleague", label: "Colleague" },
];

function statusLine(m: BuyerTeamRow): string {
  if (m.status === "requested") return "Waiting for your broker";
  return m.acknowledged ? "Has access" : "Has access · hasn't opened it yet";
}

export function YourTeam({ token, team, canInvite }: { token: string; team: BuyerTeamRow[]; canInvite: boolean }) {
  const [open, setOpen] = useState(false);
  if (team.length === 0 && !canInvite) return null;
  return (
    <section className="space-y-2" data-testid="your-team">
      <h3 className="flex items-center gap-1.5 px-1 text-xs font-semibold text-muted-foreground"><Users className="h-3.5 w-3.5" /> Your team</h3>
      {team.length === 0 ? (
        <p className="px-1 text-xs text-muted-foreground">Your accountant, lawyer or lender can have their own access to these documents.</p>
      ) : (
        <ul className="space-y-1.5">
          {team.map((m) => (
            <li key={m.id} className="rounded-md border border-border bg-card px-2.5 py-2 text-xs">
              <p className="truncate font-medium">{m.name} <span className="font-normal text-muted-foreground">· {m.role}</span></p>
              <p className="text-muted-foreground">{statusLine(m)}</p>
            </li>
          ))}
        </ul>
      )}
      {canInvite && (
        <Button size="sm" variant="outline" className="w-full" onClick={() => setOpen(true)} data-testid="team-invite">
          <UserPlus className="mr-1.5 h-3.5 w-3.5" /> Invite someone from my team
        </Button>
      )}
      <InviteDialog token={token} open={open} onOpenChange={setOpen} />
    </section>
  );
}

function InviteDialog({ token, open, onOpenChange }: { token: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("accountant");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reset = () => { setName(""); setEmail(""); setRole("accountant"); setError(null); };
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await vdrFetch("POST", `/api/view/${encodeURIComponent(token)}/data-room/team`, { name, email, role });
      await qc.invalidateQueries({ queryKey: ["/api/view", token, "data-room"] });
      toast({ title: "Sent to your broker", description: `Your broker will send ${name.split(" ")[0] || "them"} their own link.` });
      reset();
      onOpenChange(false);
    } catch (e: any) {
      setError(e?.message ?? "That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
      <DialogContent className="max-w-md grid-cols-[minmax(0,1fr)]">
        <DialogHeader>
          <DialogTitle>Invite someone from your team</DialogTitle>
          <DialogDescription>Your broker approves it and sends them their own link. They see the same documents as you, with their own name on every page. They can't see the memorandum.</DialogDescription>
        </DialogHeader>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <label className="block space-y-1"><span className="text-xs font-medium">Name</span><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoComplete="off" data-testid="team-invite-name" /></label>
          <label className="block space-y-1"><span className="text-xs font-medium">Email</span><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={200} autoComplete="off" data-testid="team-invite-email" /></label>
          <label className="block space-y-1">
            <span className="text-xs font-medium">Role</span>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger className="h-9" data-testid="team-invite-role"><SelectValue /></SelectTrigger>
              <SelectContent>{TEAM_ROLE_OPTIONS.map((r) => <SelectItem key={r.key} value={r.key}>{r.label}</SelectItem>)}</SelectContent>
            </Select>
          </label>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy || !name.trim() || !email.trim()} data-testid="team-invite-send">{busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />} Ask my broker</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
