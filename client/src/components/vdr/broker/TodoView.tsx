/**
 * To do (vdr spec §5.8), segmented: Waiting on you · Buyer requests · Seller
 * checklist (?todo=waiting|requests|checklist). Every waiting item has its
 * own one-click action. Nothing is shared or emailed without the broker's
 * click: "Tell them" opens an email the broker edits and sends.
 */
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { AlertTriangle, CalendarClock, FileClock, FileQuestion, FilePlus2, FileX2, Inbox, ListChecks, Loader2, MessageSquare, PenLine, ShieldAlert, Sparkles, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { queryClient } from "@/lib/queryClient";
import type { BrokerRoomPayload, EmailDraft, WaitingItem } from "@shared/vdr-api";
import { invalidateRoom, roomBase, useRequests, useRoomBuyers, useTodo, vdrFetch } from "@/hooks/useDataRoom";
import { SellerChecklistCard, checklistKey } from "@/components/deal/SellerChecklistCard";
import { PanelError } from "@/components/deal/PanelError";
import { flagLabel } from "./parts";
import { useRoomActions } from "./actions";
import { RequestsView, useShareAndTell } from "./RequestsView";
import { DescriptionsReview } from "./DescriptionsReview";
import { EmailDialog } from "./EmailDialog";
import { useTeamAction } from "./TeamParts";

export type TodoSegment = "waiting" | "requests" | "checklist";

export function TodoView({ dealId, data, segment, onSegment, onOpenItem, onBuyer, onDocuments, onPlan }: {
  dealId: string;
  data: BrokerRoomPayload;
  segment: TodoSegment;
  onSegment: (s: TodoSegment) => void;
  onOpenItem: (id: string) => void;
  onBuyer: (accessId: string) => void;
  onDocuments: (filter: string) => void;
  /** Opens "Who sees what" (set-up step 2). */
  onPlan: () => void;
}) {
  const requests = useRequests(dealId);
  const openRequests = (requests.data?.requests ?? []).filter((r) => r.status === "open" || r.status === "ready_to_share").length;
  return (
    <div className="space-y-4">
      <div className="flex max-w-full overflow-x-auto rounded-md border border-border p-0.5 text-xs sm:inline-flex" role="tablist" aria-label="To do">
        {(["waiting", "requests", "checklist"] as TodoSegment[]).map((s) => (
          <button key={s} role="tab" aria-selected={segment === s} onClick={() => onSegment(s)} className={cn("shrink-0 rounded-[5px] px-3 py-1.5", segment === s ? "bg-teal/15 text-teal" : "text-muted-foreground hover:text-foreground")} data-testid={`todo-seg-${s}`}>
            {/* Phones: shorter words, so all three fit without a clipped label. */}
            <span className="hidden sm:inline">{s === "waiting" ? `Waiting on you (${data.kpis.waiting})` : s === "requests" ? `Buyer requests${openRequests ? ` (${openRequests} open)` : ""}` : `Seller checklist${data.kpis.missingRequired ? ` (${data.kpis.missingRequired} missing)` : ""}`}</span>
            <span className="sm:hidden">{s === "waiting" ? `Waiting (${data.kpis.waiting})` : s === "requests" ? `Requests${openRequests ? ` (${openRequests})` : ""}` : `Checklist${data.kpis.missingRequired ? ` (${data.kpis.missingRequired} missing)` : ""}`}</span>
          </button>
        ))}
      </div>
      {segment === "waiting" && <Waiting dealId={dealId} data={data} onOpenItem={onOpenItem} onRequests={() => onSegment("requests")} onDocuments={onDocuments} onPlan={onPlan} />}
      {segment === "requests" && <RequestsView dealId={dealId} data={data} onOpenItem={onOpenItem} onBuyer={onBuyer} />}
      {segment === "checklist" && <SellerChecklistCard dealId={dealId} variant="room" roomItems={data.items} onOpenItem={onOpenItem} />}
    </div>
  );
}

const ICON: Record<WaitingItem["kind"], typeof Inbox> = {
  plan: ListChecks,
  request: Inbox,
  request_ready: FilePlus2,
  question: MessageSquare,
  new_version: FileClock,
  hinted: FilePlus2,
  flag: AlertTriangle,
  dd_cited: FileQuestion,
  team_request: UserPlus,
  descriptions: Sparkles,
  link_ending: CalendarClock,
  seller_removed: FileX2,
};

function Waiting({ dealId, data, onOpenItem, onRequests, onDocuments, onPlan }: { dealId: string; data: BrokerRoomPayload; onOpenItem: (id: string) => void; onRequests: () => void; onDocuments: (filter: string) => void; onPlan: () => void }) {
  const todo = useTodo(dealId);
  const actions = useRoomActions(dealId);
  const { data: buyers } = useRoomBuyers(dealId);
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [busy, setBusy] = useState<string | null>(null);
  const [review, setReview] = useState(false);
  const [tell, setTell] = useState<{ requestId: string; label: string; draft: EmailDraft } | null>(null);

  const extend = useMutation({
    mutationFn: async (accessId: string) => {
      const b = buyers?.eligible.find((x) => x.accessId === accessId);
      const from = Math.max(Date.now(), b?.expiresAt ? new Date(b.expiresAt).getTime() : 0);
      return vdrFetch("PATCH", `/api/buyers/${accessId}`, { expiresAt: new Date(from + 30 * 86_400_000).toISOString() });
    },
    onSuccess: () => { invalidateRoom(dealId); toast({ title: "Link extended by 30 days" }); },
    onError: (e: Error) => toast({ title: "Couldn't extend the link", description: e.message, variant: "destructive" }),
  });

  const step = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    try {
      await fn();
      await invalidateRoom(dealId);
      if (done) toast({ title: done });
    } catch (e: any) {
      toast({ title: "That didn't work", description: e?.message, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  const flow = useShareAndTell(dealId, (t, draft) => setTell({ requestId: t.requestId, label: t.label, draft }), onOpenItem);
  const team = useTeamAction(dealId);

  if (todo.isLoading) return <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}</div>;
  if (todo.error || !todo.data) return <PanelError what="your to-do list" onRetry={() => todo.refetch()} />;
  const items = todo.data.items;
  if (items.length === 0) {
    return <p className="rounded-lg border border-dashed border-border px-6 py-12 text-center text-sm text-muted-foreground" data-testid="todo-waiting-empty">Nothing is waiting on you.</p>;
  }

  const render = (w: WaitingItem) => {
    const Icon = w.kind === "flag" && w.shared ? ShieldAlert : ICON[w.kind];
    let text: React.ReactNode = w.text;
    let buttons: React.ReactNode = null;
    const b = busy === w.key;
    switch (w.kind) {
      case "plan":
        buttons = (
          <>
            <Button size="sm" onClick={onPlan} data-testid="todo-plan-choose">Choose</Button>
            <Button size="sm" variant="ghost" onClick={() => step(w.key, () => vdrFetch("POST", `${roomBase(dealId)}/todo/dismiss`, { key: "plan" }))} disabled={b}>Not now</Button>
          </>
        );
        break;
      case "request":
        buttons = <Button size="sm" variant="outline" onClick={onRequests}>Open</Button>;
        break;
      case "team_request": {
        const who = { id: w.teamMemberId!, name: w.teamMemberName ?? "them" };
        buttons = (
          <>
            <Button size="sm" onClick={() => team.run(who, "approve", true)} disabled={!!team.busy} data-testid="todo-team-approve">Approve and send the link</Button>
            <Button size="sm" variant="ghost" onClick={() => team.run(who, "decline")} disabled={!!team.busy}>Decline</Button>
          </>
        );
        break;
      }
      case "request_ready":
        buttons = (
          <Button size="sm" onClick={() => flow.run({ requestId: w.requestId!, label: w.buyerLabel ?? "the buyer" })} disabled={flow.pending === w.requestId} data-testid="todo-share-and-tell">
            {flow.pending === w.requestId && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />} Share with {w.buyerLabel ?? "them"} and tell them
          </Button>
        );
        break;
      case "question":
        buttons = <Button size="sm" variant="outline" onClick={() => setLocation(`/deal/${dealId}/qa`)}><PenLine className="mr-1.5 h-3.5 w-3.5" /> Answer</Button>;
        break;
      case "new_version":
        buttons = <Button size="sm" onClick={() => actions.shareLikeReplaced(w.itemId!)}>Share with the same people</Button>;
        break;
      case "hinted":
        buttons = (
          <>
            <Button size="sm" onClick={() => step(w.key, () => vdrFetch("POST", `${roomBase(dealId)}/shares/bulk`, { itemIds: [w.itemId], add: { levels: w.levels ?? [], allow: [] } }).then((r: any) => { if (r?.skipped?.length) throw new Error(r.skipped[0].reason === "Needs your check first." ? "Check it first: open it and tick \"I've checked it\"." : r.skipped[0].reason); }), "Shared like the rest of the folder")} disabled={b}>Share</Button>
            <Button size="sm" variant="ghost" onClick={() => step(w.key, () => vdrFetch("POST", `${roomBase(dealId)}/todo/dismiss`, { key: w.key }))} disabled={b}>Not now</Button>
          </>
        );
        break;
      case "flag": {
        const words = (w.flags ?? []).map((f) => flagLabel(f.key).toLowerCase()).join(", ");
        text = <>{w.text}: {words}{w.shared ? <span className="text-teal">. Shared, but held back from buyers until you check it.</span> : null}</>;
        buttons = (
          <>
            <Button size="sm" variant="outline" onClick={() => onOpenItem(w.itemId!)}>Open</Button>
            <Button size="sm" variant="ghost" onClick={() => actions.check(w.itemId!, (w.flags ?? []).map((f) => f.key))}>I've checked it</Button>
          </>
        );
        break;
      }
      case "dd_cited":
        buttons = (
          <>
            <Button size="sm" onClick={() => onDocuments("dd_cited")}>Review</Button>
            <Button size="sm" variant="ghost" onClick={() => step(w.key, () => vdrFetch("POST", `${roomBase(dealId)}/todo/dismiss`, { key: "dd_cited" }))} disabled={b}>Not now</Button>
          </>
        );
        break;
      case "descriptions":
        buttons = <Button size="sm" onClick={() => setReview(true)}>Review</Button>;
        break;
      case "link_ending":
        buttons = <Button size="sm" variant="outline" onClick={() => extend.mutate(w.accessId!)} disabled={extend.isPending}>Extend 30 days</Button>;
        break;
      case "seller_removed":
        buttons = (
          <>
            <Button size="sm" variant="outline" onClick={() => step(w.key, async () => {
              const it = data.items.find((i) => i.id === w.itemId);
              const preset = data.folders.find((f) => f.id === it?.folderId)?.presetKey ?? "";
              const category = preset === "financial.tax" ? "tax" : preset.startsWith("financial") ? "financial" : preset === "compliance" ? "compliance" : preset.startsWith("legal") ? "legal" : "operational";
              await vdrFetch("POST", `/api/deals/${dealId}/document-requirements`, { documentName: (it?.title ?? "A document the seller removed").slice(0, 200), category, isRequired: true });
              await queryClient.invalidateQueries({ queryKey: checklistKey(dealId) });
              await vdrFetch("DELETE", `${roomBase(dealId)}/items/${w.itemId}`);
            }, "Added to the seller's checklist")} disabled={b}>Ask the seller for it</Button>
            <Button size="sm" variant="ghost" onClick={() => step(w.key, () => vdrFetch("DELETE", `${roomBase(dealId)}/items/${w.itemId}`), "Dismissed")} disabled={b}>Dismiss</Button>
          </>
        );
        break;
    }
    return (
      <div key={w.key} className="flex flex-col gap-2 border-b border-border px-4 py-3 last:border-0 sm:flex-row sm:items-center" data-testid={`todo-${w.kind}`}>
        <div className="flex min-w-0 flex-1 items-start gap-2.5"><Icon className="mt-0.5 h-4 w-4 shrink-0 text-teal" /><p className="text-sm">{text}</p></div>
        <div className="flex shrink-0 flex-wrap gap-2 pl-6 sm:pl-0">{buttons}</div>
      </div>
    );
  };

  return (
    <>
      <div className="overflow-hidden rounded-lg border border-border bg-card" data-testid="todo-waiting">{items.map(render)}</div>
      <DescriptionsReview dealId={dealId} items={data.items} open={review} onOpenChange={setReview} onEdit={onOpenItem} />
      <EmailDialog
        open={!!tell}
        onOpenChange={(o) => { if (!o) setTell(null); }}
        title={tell ? `Tell ${tell.label}` : ""}
        initial={tell?.draft ?? null}
        send={async (subject, message) => {
          const r = await vdrFetch<{ sent: number; failed: number; demo: boolean }>("POST", `${roomBase(dealId)}/requests/${tell!.requestId}/tell-buyer`, { subject, message });
          invalidateRoom(dealId);
          return r;
        }}
      />
      {flow.confirmRoom}
      {team.dialog}
    </>
  );
}
