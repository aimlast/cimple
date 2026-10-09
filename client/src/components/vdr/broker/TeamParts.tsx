/**
 * A buyer's team on the broker side (vdr spec §5.7, §6.8): add someone
 * (name, email, role → "Add and send the link" or "Add and copy the link"),
 * the team rows under a buyer (send again · copy a new link · remove), and
 * approving or declining a buyer's ask. The link goes out only on the
 * broker's click. Cimple keeps only a fingerprint of each link, so a copied
 * link is shown once; "Copy a new link" replaces the old one.
 */
import { useState } from "react";
import { Check, Copy, Loader2, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import type { RoomTeamRow } from "@shared/vdr-api";
import { invalidateRoom, roomBase, shortDate, vdrFetch } from "@/hooks/useDataRoom";
import { TEAM_ROLE_OPTIONS } from "../buyer/YourTeam";

type LinkResult = { link: string; emailed: { sent: boolean; demo: boolean } };

/** After adding/approving/renewing: the link to copy (shown once), or what happened to the email. */
export function TeamLinkDialog({ result, who, onClose }: { result: LinkResult | null; who: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  if (!result) return null;
  return (
    <Dialog open onOpenChange={(o) => { if (!o) { setCopied(false); onClose(); } }}>
      <DialogContent className="max-w-md grid-cols-[minmax(0,1fr)]" data-testid="team-link-dialog">
        <DialogHeader>
          <DialogTitle>{result.emailed.sent ? `Link sent to ${who}` : `${who}'s link`}</DialogTitle>
          <DialogDescription>
            {result.emailed.sent
              ? "They'll confirm confidentiality the first time they open it. You can also copy the link below."
              : result.emailed.demo
                ? "This is a demo deal, so nothing was emailed. Copy the link to try it."
                : "Copy it now and send it to them yourself. Cimple keeps only a fingerprint of the link, so it can't show it again. You can make a new one any time."}
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          <Input readOnly value={result.link} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} data-testid="team-link-value" />
          <Button size="sm" variant="outline" onClick={async () => { try { await navigator.clipboard.writeText(result.link); setCopied(true); } catch { /* the field is selectable */ } }}>
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          </Button>
        </div>
        <DialogFooter><Button onClick={onClose}>Done</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AddTeamMemberDialog({ dealId, accessId, buyerLabel, open, onOpenChange }: { dealId: string; accessId: string; buyerLabel: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("accountant");
  const [busy, setBusy] = useState<"send" | "copy" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<LinkResult | null>(null);
  const reset = () => { setName(""); setEmail(""); setRole("accountant"); setError(null); };
  const add = async (send: boolean) => {
    setBusy(send ? "send" : "copy");
    setError(null);
    try {
      const r = await vdrFetch<LinkResult & { id: string }>("POST", `${roomBase(dealId)}/buyers/${encodeURIComponent(accessId)}/team`, { name, email, role, send });
      await invalidateRoom(dealId);
      onOpenChange(false);
      if (send && r.emailed.sent) toast({ title: `${name} is on ${buyerLabel}'s team`, description: "Their link is on its way." });
      setResult(r);
    } catch (e: any) {
      setError(e?.message ?? "That didn't work.");
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
        <DialogContent className="max-w-md grid-cols-[minmax(0,1fr)]" data-testid="add-team-dialog">
          <DialogHeader>
            <DialogTitle className="pr-6">Add someone from {buyerLabel}'s team</DialogTitle>
            <DialogDescription>They get their own link to {buyerLabel}'s data room: the same documents, their own name on every page. No memorandum, no decisions. Up to 5 people per buyer.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <label className="block space-y-1"><span className="text-xs font-medium">Name</span><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoComplete="off" data-testid="add-team-name" /></label>
            <label className="block space-y-1"><span className="text-xs font-medium">Email</span><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={200} autoComplete="off" data-testid="add-team-email" /></label>
            <label className="block space-y-1">
              <span className="text-xs font-medium">Role</span>
              <Select value={role} onValueChange={setRole}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>{TEAM_ROLE_OPTIONS.map((r) => <SelectItem key={r.key} value={r.key}>{r.label}</SelectItem>)}</SelectContent>
              </Select>
            </label>
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
          <DialogFooter className="flex-col gap-2 sm:flex-row sm:gap-0">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button variant="outline" onClick={() => add(false)} disabled={!!busy || !name.trim() || !email.trim()} data-testid="add-team-copy">{busy === "copy" && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}Add and copy the link</Button>
            <Button onClick={() => add(true)} disabled={!!busy || !name.trim() || !email.trim()} data-testid="add-team-send">{busy === "send" && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}Add and send the link</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <TeamLinkDialog result={result} who={name || "Their"} onClose={() => { setResult(null); reset(); }} />
    </>
  );
}

/** One team action (approve · decline · remove · resend · new_link); returns the link when one was made. */
export function useTeamAction(dealId: string) {
  const { toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ r: LinkResult; who: string } | null>(null);
  const run = async (m: { id: string; name: string }, action: "approve" | "decline" | "remove" | "resend" | "new_link", send = false) => {
    setBusy(`${m.id}:${action}`);
    try {
      const r = await vdrFetch<{ ok: true } & Partial<LinkResult>>("PATCH", `${roomBase(dealId)}/team/${encodeURIComponent(m.id)}`, { action, send });
      await invalidateRoom(dealId);
      if (action === "decline") toast({ title: `Declined: ${m.name}` });
      else if (action === "remove") toast({ title: `${m.name} can't open the data room any more`, description: "Their link stopped working." });
      else if (r.link && r.emailed) {
        if (r.emailed.sent && action !== "new_link") toast({ title: `Link sent to ${m.name}`, description: action === "resend" ? "The link you sent before stopped working." : "They'll confirm confidentiality when they first open it." });
        else setResult({ r: { link: r.link, emailed: r.emailed }, who: m.name });
      }
    } catch (e: any) {
      toast({ title: "That didn't work", description: e?.message, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };
  const dialog = <TeamLinkDialog result={result?.r ?? null} who={result?.who ?? ""} onClose={() => setResult(null)} />;
  return { run, busy, dialog };
}

const roleWord = (r: string) => TEAM_ROLE_OPTIONS.find((x) => x.key === r)?.label.toLowerCase() ?? r;

export function teamStatusLine(m: RoomTeamRow): string {
  if (m.status === "requested") return "asked to be added";
  const opened = m.documentsOpened > 0 ? `opened ${m.documentsOpened} ${m.documentsOpened === 1 ? "document" : "documents"}` : m.acknowledgedAt ? "hasn't opened a document yet" : "hasn't opened the room yet";
  return `${opened}${m.lastVisitAt ? ` · ${shortDate(m.lastVisitAt)}` : ""}`;
}

/** Team rows under a buyer (desktop table rows or phone list items). */
export function TeamRows({ dealId, team, phone }: { dealId: string; team: RoomTeamRow[]; phone?: boolean }) {
  const act = useTeamAction(dealId);
  if (team.length === 0) return null;
  return (
    <div className={phone ? "space-y-1.5 border-l-2 border-border pl-3" : "space-y-1"} data-testid="team-rows">
      {team.map((m) => (
        <div key={m.id} className="flex flex-wrap items-center gap-2 text-xs" data-testid={`team-row-${m.id}`}>
          <span className="min-w-0 flex-1 truncate">
            <span className="font-medium text-foreground">{m.name}</span>
            <span className="text-muted-foreground"> · {roleWord(m.role)} · {m.email} · {teamStatusLine(m)}</span>
          </span>
          {m.status === "requested" ? (
            <span className="flex shrink-0 gap-1.5">
              <Button size="sm" className="h-7 text-xs" onClick={() => act.run(m, "approve", true)} disabled={!!act.busy} data-testid={`team-approve-${m.id}`}>Approve and send the link</Button>
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => act.run(m, "decline")} disabled={!!act.busy}>Decline</Button>
            </span>
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button size="icon" variant="ghost" className="h-6 w-6" aria-label={`More for ${m.name}`}><MoreHorizontal className="h-3.5 w-3.5" /></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => act.run(m, "resend", true)}>Send a new link</DropdownMenuItem>
                <DropdownMenuItem onClick={() => act.run(m, "new_link")}>Copy a new link</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-destructive" onClick={() => act.run(m, "remove")}>Remove from the room</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      ))}
      {act.dialog}
    </div>
  );
}
