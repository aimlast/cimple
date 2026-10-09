/**
 * To do › Buyer requests (vdr spec §5.8). One row per request; a pasted
 * list arrives grouped ("Northgate sent a list of 34 requests · Oct 7") with
 * "Ask the seller for the selected" and "Decline the selected".
 *
 * Per request: Share a document… · Ask the seller for it (a checklist row;
 * the seller never sees who asked; "Email the seller now" is the broker's
 * tick) · Decline (with a note the buyer sees) · Tell the buyer (after
 * sharing). Nothing is shared or emailed without the broker's click.
 */
import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Clock, FileQuestion, Inbox, KeyRound, Loader2, Mail, Search, Send, Share2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { queryClient } from "@/lib/queryClient";
import type { BrokerRoomPayload, EmailDraft, RoomItemRow, RoomRequestRow } from "@shared/vdr-api";
import { invalidateRoom, roomBase, shortDate, useRequests, vdrFetch, VdrRequestError } from "@/hooks/useDataRoom";
import { checklistKey } from "@/components/deal/SellerChecklistCard";
import { PanelError } from "@/components/deal/PanelError";
import { EmailDialog } from "./EmailDialog";
import { flagLabel } from "./parts";

const STATUS: Record<RoomRequestRow["status"], { label: string; cls: string; icon: typeof Clock }> = {
  open: { label: "Open", cls: "border-teal/40 bg-teal/10 text-teal", icon: Inbox },
  asked_seller: { label: "Asked the seller", cls: "border-border text-muted-foreground", icon: Clock },
  ready_to_share: { label: "Ready to share", cls: "border-teal/40 bg-teal/15 text-teal", icon: CheckCircle2 },
  shared: { label: "Shared", cls: "border-border text-muted-foreground", icon: Share2 },
  declined: { label: "Declined", cls: "border-border text-muted-foreground", icon: XCircle },
};

const who = (r: RoomRequestRow) => r.buyer.company || r.buyer.name || r.buyer.email;

export function RequestsView({ dealId, data, onOpenItem, onBuyer }: { dealId: string; data: BrokerRoomPayload; onOpenItem: (id: string) => void; onBuyer: (accessId: string) => void }) {
  const q = useRequests(dealId);
  const [ask, setAsk] = useState<RoomRequestRow[] | null>(null);
  const [decline, setDecline] = useState<RoomRequestRow[] | null>(null);
  const [share, setShare] = useState<RoomRequestRow | null>(null);
  const [tell, setTell] = useState<{ request: RoomRequestRow; draft: EmailDraft | null } | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const flow = useShareAndTell(dealId, (t, draft) => { const r = q.data?.requests.find((x) => x.id === t.requestId); if (r) setTell({ request: r, draft }); }, onOpenItem);
  const emailSeller = useEmailSeller(dealId);

  if (q.isLoading) return <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}</div>;
  if (q.error || !q.data) return <PanelError what="buyer requests" onRetry={() => q.refetch()} />;
  const { requests, lists, sellerEmail } = q.data;
  if (requests.length === 0) {
    return <p className="rounded-lg border border-dashed border-border px-6 py-12 text-center text-sm text-muted-foreground" data-testid="todo-requests-empty">No requests. Buyers can ask for a document from their data room.</p>;
  }
  const singles = requests.filter((r) => !r.listId);
  const grant = async (r: RoomRequestRow) => {
    try {
      await vdrFetch("PATCH", `${roomBase(dealId)}/requests/${r.id}`, { action: "grant_room" });
      invalidateRoom(dealId);
    } catch (e) {
      const err = e as VdrRequestError;
      if (err.body?.code === "blind" && typeof err.body.accessId === "string") onBuyer(err.body.accessId);
      flow.toast({ title: "Couldn't give them the data room", description: err.message, variant: "destructive" });
    }
  };
  const row = (r: RoomRequestRow, opts: { selectable?: boolean } = {}) => (
    <RequestRow
      key={r.id}
      r={r}
      selectable={opts.selectable}
      selected={!!selected[r.id]}
      onSelect={(v) => setSelected((s) => ({ ...s, [r.id]: v }))}
      busy={flow.pending === r.id}
      onShare={() => setShare(r)}
      onAsk={() => setAsk([r])}
      onDecline={() => setDecline([r])}
      onShareAndTell={() => flow.run({ requestId: r.id, label: who(r) })}
      onTell={() => setTell({ request: r, draft: null })}
      onGrant={() => grant(r)}
      onOpenItem={onOpenItem}
      onBuyer={onBuyer}
    />
  );
  return (
    <div className="space-y-4" data-testid="todo-requests">
      {sellerEmail.unsent.length > 0 && (
        <div className="flex flex-col gap-2 rounded-lg border border-teal/30 bg-teal/5 px-4 py-3 text-sm sm:flex-row sm:items-center">
          <Mail className="hidden h-4 w-4 shrink-0 text-teal sm:block" />
          <span className="flex-1">{sellerEmail.unsent.length === 1 ? "One document you asked the seller for isn't in an email to them yet." : `${sellerEmail.unsent.length} documents you asked the seller for aren't in an email to them yet.`}</span>
          <Button size="sm" variant="outline" onClick={() => emailSeller.mutate(sellerEmail.unsent)} disabled={emailSeller.isPending}>
            {emailSeller.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />} Email the seller
          </Button>
        </div>
      )}

      {lists.map((l) => {
        const rows = requests.filter((r) => r.listId === l.listId);
        const picked = rows.filter((r) => selected[r.id] && r.status === "open");
        const openRows = rows.filter((r) => r.status === "open");
        return (
          <section key={l.listId} className="overflow-hidden rounded-lg border border-border bg-card" data-testid="request-list">
            <div className="flex flex-col gap-2 border-b border-border bg-muted/20 px-4 py-2.5 sm:flex-row sm:items-center">
              <label className="flex min-w-0 flex-1 items-center gap-2.5 text-sm">
                <Checkbox
                  checked={openRows.length > 0 && openRows.every((r) => selected[r.id])}
                  onCheckedChange={(v) => setSelected((s) => ({ ...s, ...Object.fromEntries(openRows.map((r) => [r.id, v === true])) }))}
                  disabled={openRows.length === 0}
                  aria-label="Select every open request in this list"
                />
                <span className="font-medium">{l.buyerLabel} sent a list of {l.count} requests</span>
                <span className="text-xs text-muted-foreground">· {shortDate(l.createdAt)}{l.open < l.count ? ` · ${l.open} open` : ""}</span>
              </label>
              <div className="flex shrink-0 flex-wrap gap-2">
                <Button size="sm" variant="outline" disabled={picked.length === 0} onClick={() => setAsk(picked)}>Ask the seller for the selected{picked.length ? ` (${picked.length})` : ""}</Button>
                <Button size="sm" variant="ghost" disabled={picked.length === 0} onClick={() => setDecline(picked)}>Decline the selected</Button>
              </div>
            </div>
            <div>{rows.map((r) => row(r, { selectable: true }))}</div>
          </section>
        );
      })}

      {singles.length > 0 && <div className="overflow-hidden rounded-lg border border-border bg-card">{singles.map((r) => row(r))}</div>}

      <AskSellerDialog dealId={dealId} requests={ask} lastEmailAt={sellerEmail.lastAt} onClose={() => { setAsk(null); setSelected({}); }} />
      <DeclineDialog dealId={dealId} requests={decline} onClose={() => { setDecline(null); setSelected({}); }} />
      {flow.confirmRoom}
      <SharePickerDialog dealId={dealId} request={share} items={data.items} onClose={() => setShare(null)} onShared={(r, draft) => setTell({ request: r, draft })} onOpenItem={onOpenItem} />
      <EmailDialog
        open={!!tell}
        onOpenChange={(o) => { if (!o) setTell(null); }}
        title={tell ? `Tell ${who(tell.request)}` : ""}
        initial={tell?.draft ?? null}
        loadDraft={tell && !tell.draft ? () => vdrFetch<EmailDraft>("GET", `${roomBase(dealId)}/requests/${tell.request.id}/tell-buyer`) : undefined}
        send={async (subject, message) => {
          const r = await vdrFetch<{ sent: number; failed: number; demo: boolean }>("POST", `${roomBase(dealId)}/requests/${tell!.request.id}/tell-buyer`, { subject, message });
          invalidateRoom(dealId);
          return r;
        }}
      />
    </div>
  );
}

function RequestRow(p: {
  r: RoomRequestRow;
  selectable?: boolean;
  selected: boolean;
  onSelect: (v: boolean) => void;
  busy: boolean;
  onShare: () => void;
  onAsk: () => void;
  onDecline: () => void;
  onShareAndTell: () => void;
  onTell: () => void;
  onGrant: () => void;
  onOpenItem: (id: string) => void;
  onBuyer: (accessId: string) => void;
}) {
  const { r } = p;
  const st = STATUS[r.status];
  const Icon = st.icon;
  const asker = r.askedBy ? `${r.askedBy.name} (${who(r)}'s ${r.askedBy.role})` : who(r);
  return (
    <div className="flex flex-col gap-2 border-b border-border px-4 py-3 last:border-0 lg:flex-row lg:items-center" data-testid="request-row">
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        {p.selectable && <Checkbox checked={p.selected} disabled={r.status !== "open"} onCheckedChange={(v) => p.onSelect(v === true)} className="mt-0.5" aria-label="Select this request" />}
        {r.kind === "room_access" ? <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" /> : <FileQuestion className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />}
        <div className="min-w-0 flex-1">
          <p className="text-sm">{r.kind === "room_access" ? "Access to the data room" : `'${r.text}'`}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {asker} · {r.buyer.levelLabel} · {shortDate(r.createdAt)}
            {r.item && <> · about <button className="underline underline-offset-2 hover:text-foreground" onClick={() => p.onOpenItem(r.item!.id)}>{r.item.number} {r.item.title}</button></>}
            {r.citedDocument && <> · from the DD CIM ({r.citedDocument.name})</>}
          </p>
          {r.requirement && r.status === "asked_seller" && (
            <p className="mt-0.5 text-xs text-muted-foreground">On the seller's checklist as '{r.requirement.name}'{r.requirement.neededBy ? `, needed by ${shortDate(r.requirement.neededBy)}` : ""}. Waiting for the seller.</p>
          )}
          {r.status === "ready_to_share" && r.ready && <p className="mt-0.5 text-xs text-teal">The seller uploaded '{r.ready.name}'.</p>}
          {r.status === "declined" && <p className="mt-0.5 text-xs text-muted-foreground">You declined it{r.brokerNote ? `: '${r.brokerNote}'` : "."}</p>}
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 pl-6 lg:pl-0">
        <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]", st.cls)}><Icon className="h-3 w-3" />{st.label}</span>
        {r.status === "open" && r.kind === "document" && (
          <>
            <Button size="sm" variant="outline" onClick={p.onShare}>Share a document…</Button>
            <Button size="sm" variant="outline" onClick={p.onAsk}>Ask the seller for it</Button>
            <Button size="sm" variant="ghost" onClick={p.onDecline}>Decline</Button>
          </>
        )}
        {r.status === "open" && r.kind === "room_access" && (
          <>
            {r.buyer.rule === "never_blind" ? (
              <Button size="sm" variant="outline" onClick={() => p.onBuyer(r.buyer.accessId)}>Move to Full CIM…</Button>
            ) : (
              <Button size="sm" onClick={p.onGrant}>Give them the data room</Button>
            )}
            <Button size="sm" variant="ghost" onClick={p.onDecline}>Decline</Button>
          </>
        )}
        {r.status === "asked_seller" && <Button size="sm" variant="ghost" onClick={p.onShare}>Share a document instead…</Button>}
        {r.status === "ready_to_share" && (
          <Button size="sm" onClick={p.onShareAndTell} disabled={p.busy} data-testid="share-and-tell">
            {p.busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />} Share with {who(r)} and tell them
          </Button>
        )}
        {r.status === "shared" && r.kind === "document" && <Button size="sm" variant="outline" onClick={p.onTell}><Send className="mr-1.5 h-3.5 w-3.5" /> Tell the buyer</Button>}
      </div>
    </div>
  );
}

export type ShareTellTarget = { requestId: string; label: string };

/** "Share with Northgate and tell them" — asks before turning on their room; sends "check it first" to the document. */
export function useShareAndTell(dealId: string, onDraft: (t: ShareTellTarget, draft: EmailDraft) => void, onOpenItem: (id: string) => void) {
  const { toast } = useToast();
  const [pending, setPending] = useState<string | null>(null);
  const [needsRoom, setNeedsRoom] = useState<{ t: ShareTellTarget; message: string } | null>(null);
  const run = async (t: ShareTellTarget, extra: Record<string, unknown> = {}) => {
    setPending(t.requestId);
    try {
      const out = await vdrFetch<{ itemId: string; draft: EmailDraft }>("POST", `${roomBase(dealId)}/requests/${t.requestId}/share-and-tell`, extra);
      invalidateRoom(dealId);
      toast({ title: `Shared with ${t.label}` });
      onDraft(t, out.draft);
    } catch (e) {
      const err = e as VdrRequestError;
      if (err.body?.code === "no_room") {
        setNeedsRoom({ t, message: err.message });
      } else if (err.body?.code === "check_first" && typeof err.body.itemId === "string") {
        toast({ title: "Check it first", description: "Cimple couldn't check everything in this document. Open it, tick \"I've checked it\", then share." });
        onOpenItem(err.body.itemId);
      } else {
        toast({ title: "Couldn't share it", description: err.message, variant: "destructive" });
      }
    } finally {
      setPending(null);
    }
  };
  const confirmRoom = needsRoom ? (
    <Dialog open onOpenChange={(o) => { if (!o) setNeedsRoom(null); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">Give them the data room?</DialogTitle>
          <DialogDescription>{needsRoom.message} They'll get the data room and this document.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setNeedsRoom(null)}>Cancel</Button>
          <Button onClick={() => { const t = needsRoom.t; setNeedsRoom(null); void run(t, { turnOnRoom: true }); }}>Turn it on and share</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ) : null;
  return { run, pending, toast, confirmRoom };
}

function useEmailSeller(dealId: string) {
  const { toast } = useToast();
  return useMutation({
    mutationFn: (requirementIds: string[]) => vdrFetch<{ count: number; recipients: number; sent: number; demo: boolean }>("POST", `${roomBase(dealId)}/requests/email-seller`, { requirementIds }),
    onSuccess: (r) => {
      invalidateRoom(dealId);
      if (r.demo) toast({ title: "Recorded, not sent", description: "This is an example deal, so Cimple doesn't email the seller." });
      else if (r.recipients === 0) toast({ title: "Nobody to email", description: "The deal has no seller with their own link yet. Add the seller on the Team tab.", variant: "destructive" });
      else toast({ title: r.count === 1 ? "The seller was emailed about 1 document" : `The seller was emailed about ${r.count} documents` });
    },
    onError: (e: Error) => toast({ title: "Couldn't email the seller", description: e.message, variant: "destructive" }),
  });
}

const minutesAgo = (iso: string | null) => (iso ? Math.round((Date.now() - new Date(iso).getTime()) / 60_000) : null);

function AskSellerDialog({ dealId, requests, lastEmailAt, onClose }: { dealId: string; requests: RoomRequestRow[] | null; lastEmailAt: string | null; onClose: () => void }) {
  const { toast } = useToast();
  const many = (requests?.length ?? 0) > 1;
  const recent = minutesAgo(lastEmailAt);
  const emailedRecently = recent !== null && recent < 10;
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [neededBy, setNeededBy] = useState("");
  const [email, setEmail] = useState(true);
  const [busy, setBusy] = useState(false);
  const key = requests?.map((r) => r.id).join(",") ?? "";
  useEffect(() => {
    setName(requests && requests.length === 1 ? requests[0].text.slice(0, 200) : "");
    setNote("");
    setNeededBy("");
    setEmail(!emailedRecently);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const submit = async () => {
    if (!requests) return;
    setBusy(true);
    try {
      let ids: string[] = [];
      if (requests.length === 1) {
        const r = await vdrFetch<{ requirementIds: string[] }>("PATCH", `${roomBase(dealId)}/requests/${requests[0].id}`, { action: "ask_seller", requirementName: name, requirementNote: note || null, neededBy: neededBy || null });
        ids = r.requirementIds ?? [];
      } else {
        const r = await vdrFetch<{ requirementIds: string[] }>("POST", `${roomBase(dealId)}/requests/bulk`, { action: "ask_seller", requestIds: requests.map((x) => x.id), note: note || null, neededBy: neededBy || null });
        ids = r.requirementIds ?? [];
      }
      queryClient.invalidateQueries({ queryKey: checklistKey(dealId) });
      if (email && ids.length) {
        const e = await vdrFetch<{ count: number; recipients: number; demo: boolean }>("POST", `${roomBase(dealId)}/requests/email-seller`, { requirementIds: ids });
        toast({ title: ids.length === 1 ? "Added to the seller's checklist" : `${ids.length} documents added to the seller's checklist`, description: e.demo ? "Example deal: the email was recorded, not sent." : e.recipients === 0 ? "Nobody was emailed: the deal has no seller with their own link yet." : "The seller was emailed." });
      } else {
        toast({ title: ids.length === 1 ? "Added to the seller's checklist" : `${ids.length} documents added to the seller's checklist`, description: "You can email the seller from Buyer requests." });
      }
      invalidateRoom(dealId);
      onClose();
    } catch (e: any) {
      toast({ title: "Couldn't ask the seller", description: e?.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={!!requests} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[92vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">{many ? `Ask the seller for ${requests!.length} documents` : "Ask the seller for it"}</DialogTitle>
          <DialogDescription>It goes on the seller's document checklist. The seller sees the document's name, your note and the date. They never see which buyer asked.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          {many ? (
            <ul className="max-h-40 list-disc space-y-0.5 overflow-y-auto pl-5 text-foreground/90">{requests!.map((r) => <li key={r.id}>{r.text}</li>)}</ul>
          ) : (
            <div>
              <label className="text-xs font-medium text-muted-foreground" htmlFor="ask-name">Document name (the seller sees this)</label>
              <Input id="ask-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} className="mt-1" />
            </div>
          )}
          <div>
            <label className="text-xs font-medium text-muted-foreground" htmlFor="ask-note">A note for the seller (optional)</label>
            <Textarea id="ask-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={3} className="mt-1" placeholder="For example: the most recent month is enough." />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground" htmlFor="ask-by">Needed by (optional)</label>
            <Input id="ask-by" type="date" value={neededBy} onChange={(e) => setNeededBy(e.target.value)} className="mt-1 w-44" />
          </div>
          <label className="flex items-start gap-2.5 rounded-md border border-border bg-muted/20 p-3">
            <Checkbox checked={email} onCheckedChange={(v) => setEmail(v === true)} className="mt-0.5" data-testid="ask-email-now" />
            <span>
              <span className="font-medium">Email the seller now</span>
              <span className="block text-xs text-muted-foreground">
                {emailedRecently ? `You emailed the seller ${recent} ${recent === 1 ? "minute" : "minutes"} ago. Leave this off to add more first, then email them together from Buyer requests.` : "One email lists everything you've asked for in the last few minutes."}
              </span>
            </span>
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={busy || (!many && !name.trim())} data-testid="ask-seller-submit">{busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />} Add to the checklist</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeclineDialog({ dealId, requests, onClose }: { dealId: string; requests: RoomRequestRow[] | null; onClose: () => void }) {
  const { toast } = useToast();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!requests) return;
    setBusy(true);
    try {
      if (requests.length === 1) await vdrFetch("PATCH", `${roomBase(dealId)}/requests/${requests[0].id}`, { action: "decline", note: note || null });
      else await vdrFetch("POST", `${roomBase(dealId)}/requests/bulk`, { action: "decline", requestIds: requests.map((r) => r.id), note: note || null });
      invalidateRoom(dealId);
      toast({ title: requests.length === 1 ? "Request declined" : `${requests.length} requests declined` });
      setNote("");
      onClose();
    } catch (e: any) {
      toast({ title: "Couldn't decline", description: e?.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={!!requests} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">{requests && requests.length > 1 ? `Decline ${requests.length} requests?` : "Decline this request?"}</DialogTitle>
          <DialogDescription>The buyer sees your note beside their request in their data room.</DialogDescription>
        </DialogHeader>
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={3} placeholder="For example: the seller doesn't keep monthly reports. The year-end statements are in 1.1." />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="destructive" onClick={submit} disabled={busy}>{busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />} Decline</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SharePickerDialog({ dealId, request, items, onClose, onShared, onOpenItem }: { dealId: string; request: RoomRequestRow | null; items: RoomItemRow[]; onClose: () => void; onShared: (r: RoomRequestRow, draft: EmailDraft | null) => void; onOpenItem: (id: string) => void }) {
  const { toast } = useToast();
  const [q, setQ] = useState("");
  const [pick, setPick] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [needsRoom, setNeedsRoom] = useState<string | null>(null);
  const live = items.filter((i) => !i.removed && !i.isLedger);
  const shown = live.filter((i) => !q || `${i.number ?? ""} ${i.title}`.toLowerCase().includes(q.toLowerCase())).sort((a, b) => (a.number ?? "~").localeCompare(b.number ?? "~", undefined, { numeric: true }));
  const chosen = pick ? live.find((i) => i.id === pick) ?? null : request?.item ? live.find((i) => i.id === request.item!.id) ?? null : null;
  const reset = () => { setQ(""); setPick(null); setChecked(false); setNeedsRoom(null); };
  const submit = async (turnOnRoom = false) => {
    if (!request || !chosen) return;
    setBusy(true);
    try {
      await vdrFetch("PATCH", `${roomBase(dealId)}/requests/${request.id}`, { action: "share", itemId: chosen.id, turnOnRoom, checkedFlags: checked ? chosen.unchecked : [] });
      invalidateRoom(dealId);
      toast({ title: `Shared with ${who(request)}` });
      const draft = await vdrFetch<EmailDraft>("GET", `${roomBase(dealId)}/requests/${request.id}/tell-buyer`).catch(() => null);
      reset();
      onClose();
      if (draft) onShared(request, draft);
    } catch (e) {
      const err = e as VdrRequestError;
      if (err.body?.code === "no_room") setNeedsRoom(err.message);
      else toast({ title: "Couldn't share it", description: err.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={!!request} onOpenChange={(o) => { if (!o) { reset(); onClose(); } }}>
      <DialogContent className="max-h-[92vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">Share a document with {request ? who(request) : ""}</DialogTitle>
          <DialogDescription>{request ? `They asked for: '${request.text}'. Only they will get it.` : ""}</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a document in the room" className="pl-8" />
        </div>
        <div className="max-h-64 overflow-y-auto rounded-md border border-border">
          {shown.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">No document in the room matches. Ask the seller for it instead.</p>
          ) : shown.map((i) => (
            <button key={i.id} onClick={() => { setPick(i.id); setChecked(false); }} className={cn("flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left text-sm last:border-0 hover:bg-muted/30", chosen?.id === i.id && "bg-teal/10")}>
              <span className="w-12 shrink-0 font-mono text-[11px] text-muted-foreground">{i.number}</span>
              <span className="min-w-0 flex-1 truncate">{i.title}</span>
              {i.unchecked.length > 0 && <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-teal" aria-label="Needs your check" />}
            </button>
          ))}
        </div>
        {chosen && chosen.unchecked.length > 0 && (
          <label className="flex items-start gap-2.5 rounded-md border border-teal/30 bg-teal/5 p-3 text-sm">
            <Checkbox checked={checked} onCheckedChange={(v) => setChecked(v === true)} className="mt-0.5" />
            <span>
              {chosen.flags.filter((f) => chosen.unchecked.includes(f.key)).map((f) => flagLabel(f.key)).join(", ")}: {chosen.flags.filter((f) => chosen.unchecked.includes(f.key)).map((f) => f.copy).join(" ")}
              <span className="block font-medium">I've checked it. <button className="font-normal underline" onClick={(e) => { e.preventDefault(); onOpenItem(chosen.id); }}>Open it</button></span>
            </span>
          </label>
        )}
        {needsRoom && (
          <div className="rounded-md border border-teal/30 bg-teal/5 p-3 text-sm">
            <p>{needsRoom}</p>
            <Button size="sm" className="mt-2" onClick={() => submit(true)} disabled={busy}>Turn it on and share</Button>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => { reset(); onClose(); }}>Cancel</Button>
          <Button onClick={() => submit(false)} disabled={busy || !chosen || (chosen.unchecked.length > 0 && !checked)} data-testid="share-picker-submit">
            {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />} Share {chosen ? `'${chosen.title.length > 28 ? `${chosen.title.slice(0, 27)}…` : chosen.title}'` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
