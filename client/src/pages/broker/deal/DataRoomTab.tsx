/**
 * DataRoomTab — the deal's data room (/deal/:id/data-room; vdr spec §5).
 *
 * A dashboard, not a stacked page (memory rule): the KPI strip on top (in the
 * room · buyers with access · opened this week · waiting on you · missing),
 * then four tabs, one visible at a time — Documents · Buyers · To do ·
 * Activity. Everything is in the URL:
 *   ?view=documents|buyers|todo|activity  &folder= &item= (drawer) &open= (viewer)
 *   &q= &filter=all|shared|not_shared|new|attention|dd_cited  &todo=waiting|requests|checklist
 *   &dd=1 ("Share what the DD CIM cites" dialog)
 *   &activity=buyers|documents  &buyer=<accessId>  &as=<accessId> (View as a buyer)  &plan=1
 *
 * Before set-up: the "Set up the data room" card (and the deal's documents),
 * then step 2 "Who sees what". Nothing is shared until the broker confirms.
 */
import { useCallback, useMemo, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { Download, Eye, Settings2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useDeal } from "@/contexts/DealContext";
import { PanelError } from "@/components/deal/PanelError";
import { invalidateRoom, useAudience, useItemAbout, useRoom, vdrUrls, type VdrSource } from "@/hooks/useDataRoom";
import type { VdrManifest } from "@shared/vdr-api";
import { RoomKpis, type RoomView } from "@/components/vdr/broker/parts";
import { DocumentsView, type DocFilter } from "@/components/vdr/broker/DocumentsView";
import type { TreeSelection } from "@/components/vdr/broker/FolderTree";
import { DocumentDrawer } from "@/components/vdr/broker/DocumentDrawer";
import { ShareDialog, type ShareTarget } from "@/components/vdr/broker/ShareDialog";
import { UploadPanel, useRoomUploads } from "@/components/vdr/broker/UploadPanel";
import { BuyersView } from "@/components/vdr/broker/BuyersView";
import { TodoView, type TodoSegment } from "@/components/vdr/broker/TodoView";
import { ActivityView, type ActivitySegment } from "@/components/vdr/broker/ActivityView";
import { RoomSettingsDialog } from "@/components/vdr/broker/RoomSettingsDialog";
import { SetUpCard, SharingPlan } from "@/components/vdr/broker/SetUp";
import { DdCitedDialog } from "@/components/vdr/broker/DdCitedDialog";
import { useRoomActions } from "@/components/vdr/broker/actions";
import { VdrViewer } from "@/components/vdr/VdrViewer";
import { BuyerDataRoom } from "@/pages/buyer/BuyerDataRoom";

const VIEWS: RoomView[] = ["documents", "buyers", "todo", "activity"];
const VIEW_LABEL: Record<RoomView, string> = { documents: "Documents", buyers: "Buyers", todo: "To do", activity: "Activity" };
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const okId = (v: string | null | undefined) => (v && ID.test(v) ? v : null);

export function DataRoomTab() {
  const { dealId } = useDeal();
  const search = useSearch();
  const [, setLocation] = useLocation();
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const view: RoomView = (VIEWS as string[]).includes(params.get("view") ?? "") ? (params.get("view") as RoomView) : "documents";
  const folder = params.get("folder");
  const selection: TreeSelection = folder === "not_placed" ? { kind: "not_placed" } : okId(folder) ? { kind: "folder", id: folder! } : { kind: "all" };
  const itemId = okId(params.get("item"));
  const openId = okId(params.get("open"));
  const asId = okId(params.get("as"));
  const buyerFocus = okId(params.get("buyer"));
  const q = (params.get("q") ?? "").slice(0, 100);
  const filter = (["all", "shared", "not_shared", "new", "attention", "dd_cited"].includes(params.get("filter") ?? "") ? params.get("filter") : "all") as DocFilter;
  const todo = (["waiting", "requests", "checklist"].includes(params.get("todo") ?? "") ? params.get("todo") : "waiting") as TodoSegment;
  const activity = (params.get("activity") === "documents" ? "documents" : params.get("activity") === "log" ? "log" : "buyers") as ActivitySegment;
  const showPlan = params.get("plan") === "1";
  const showDdCited = params.get("dd") === "1";

  const go = useCallback((patch: Record<string, string | null>, opts: { push?: boolean } = {}) => {
    const next = new URLSearchParams(search);
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === "" || (k === "view" && v === "documents") || (k === "filter" && v === "all")) next.delete(k);
      else next.set(k, v);
    }
    const qs = next.toString();
    setLocation(`/deal/${dealId}/data-room${qs ? `?${qs}` : ""}`, { replace: !opts.push });
  }, [dealId, search, setLocation]);

  const room = useRoom(dealId);
  const audience = useAudience(dealId, !!room.data?.room);
  const actions = useRoomActions(dealId);
  const uploads = useRoomUploads(dealId);
  const [share, setShare] = useState<ShareTarget | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  if (room.isLoading) {
    return (
      <div className="space-y-4 p-4 sm:p-6">
        {/* The same grid as the strip (3 on phones, 5 from md) so nothing jumps when it loads (checker r2 R2-4). */}
        <div className="grid grid-cols-3 gap-px overflow-hidden rounded-xl border border-border md:grid-cols-5">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-[72px] rounded-none md:h-[88px]" />)}</div>
        <div className="flex gap-5">
          <div className="hidden w-[260px] space-y-2 lg:block">{Array.from({ length: 9 }).map((_, i) => <Skeleton key={i} className="h-7 w-full" />)}</div>
          <div className="flex-1 space-y-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
        </div>
      </div>
    );
  }
  if (room.error || !room.data) return <div className="p-4 sm:p-6"><PanelError what="data room" onRetry={() => room.refetch()} /></div>;
  const data = room.data;

  if (!data.room) {
    return (
      <div className="p-4 sm:p-6" data-testid="data-room-tab">
        <SetUpCard dealId={dealId} data={data} onSetUp={async (mode) => { await actions.setUp(mode); await invalidateRoom(dealId); if (mode === "auto") go({ plan: "1" }); }} />
      </div>
    );
  }

  if (showPlan) {
    return (
      <div className="p-4 sm:p-6" data-testid="data-room-tab">
        <SharingPlan dealId={dealId} data={data} onDone={() => go({ plan: null })} />
      </div>
    );
  }

  const roomBuyers = (audience.data?.buyers ?? []).filter((b) => b.hasRoom);
  const asBuyer = asId ? (audience.data?.buyers ?? []).find((b) => b.accessId === asId) : null;
  const drawerItem = itemId ? data.items.find((i) => i.id === itemId) ?? null : null;
  const viewAsMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline" className="gap-1.5" data-testid="view-as-buyer"><Eye className="h-3.5 w-3.5" /> View as a buyer</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">See exactly what one buyer sees</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {roomBuyers.length === 0 ? (
          <DropdownMenuItem disabled className="text-xs">No buyer has the data room yet.</DropdownMenuItem>
        ) : (
          roomBuyers.map((b) => <DropdownMenuItem key={b.accessId} onClick={() => go({ as: b.accessId, item: null, open: null })} className="text-xs">{b.company || b.name || b.email} <span className="ml-1 text-muted-foreground">· {b.levelLabel}</span></DropdownMenuItem>)
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  if (asId) {
    const source: VdrSource = { kind: "broker", dealId, asAccessId: asId };
    return (
      <div data-testid="data-room-tab">
        <div className="sticky top-0 z-30 flex flex-wrap items-center gap-2 border-b border-teal/40 bg-teal/15 px-4 py-2 text-sm sm:px-6" data-testid="view-as-banner">
          <Eye className="h-4 w-4 text-teal" />
          <span className="min-w-0 flex-1">You're seeing what {asBuyer ? asBuyer.company || asBuyer.name || asBuyer.email : "this buyer"} sees. Nothing you do here is logged.</span>
          <Button size="sm" variant="outline" className="h-7" onClick={() => go({ as: null })}><X className="mr-1 h-3.5 w-3.5" /> Exit preview</Button>
        </div>
        <BuyerDataRoom key={asId} source={source} embedded />
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4 sm:p-6" data-testid="data-room-tab">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-start">
        <div className="min-w-0 flex-1">
          <RoomKpis kpis={data.kpis} onGo={(v, extra) => go({ view: v, ...(extra ?? {}) }, { push: true })} />
        </div>
        <div className="flex shrink-0 gap-2 xl:flex-col">
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setSettingsOpen(true)} data-testid="room-settings"><Settings2 className="h-3.5 w-3.5" /> Room settings</Button>
          {viewAsMenu}
        </div>
      </div>

      {data.room.status === "closed" && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-teal/40 bg-teal/10 px-4 py-3 text-sm" data-testid="room-closed-banner">
          <span className="flex-1">The data room is closed. Buyers and their teams can't open it.</span>
          <Button size="sm" onClick={() => actions.settings({ status: "open" }, "The data room is open")}>Reopen</Button>
        </div>
      )}
      {!data.deal.everLive && (
        <p className="rounded-lg border border-border bg-muted/20 px-4 py-2.5 text-sm text-muted-foreground" data-testid="room-never-live">Buyers get links once the CIM is live. You can prepare the room now.</p>
      )}

      <div className="flex overflow-x-auto border-b border-border" role="tablist" aria-label="Data room">
        {VIEWS.map((v) => (
          <button
            key={v}
            role="tab"
            aria-selected={view === v}
            onClick={() => go({ view: v, item: null }, { push: true })}
            className={cn("shrink-0 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors", view === v ? "border-teal text-teal" : "border-transparent text-muted-foreground hover:text-foreground")}
            data-testid={`room-view-${v}`}
          >
            {VIEW_LABEL[v]}{v === "todo" && data.kpis.waiting > 0 ? ` (${data.kpis.waiting})` : ""}
          </button>
        ))}
      </div>

      {view === "documents" && !data.room.planAppliedAt && data.kpis.inRoom > 0 && data.kpis.shared === 0 && (
        <div className="flex flex-col gap-2 rounded-lg border border-teal/40 bg-teal/10 px-4 py-2.5 text-sm sm:flex-row sm:items-center" data-testid="room-plan-banner">
          <span className="min-w-0 flex-1">Nothing is shared with buyers yet. Choose who sees each folder.</span>
          <Button size="sm" className="self-start sm:self-auto" onClick={() => go({ plan: "1" })}>Choose who sees what</Button>
        </div>
      )}
      {view === "documents" && (
        <DocumentsView
          dealId={dealId}
          data={data}
          selection={selection}
          onSelection={(s) => go({ folder: s.kind === "folder" ? s.id : s.kind === "not_placed" ? "not_placed" : null })}
          q={q}
          onQ={(v) => go({ q: v })}
          filter={filter}
          onFilter={(f) => go({ filter: f })}
          onOpenItem={(id) => go({ item: id }, { push: true })}
          onOpenViewer={(id) => go({ open: id }, { push: true })}
          onShare={setShare}
          onViewAs={() => { if (roomBuyers.length === 1) go({ as: roomBuyers[0].accessId }); else go({ view: "buyers" }, { push: true }); }}
          onUpload={(entries, folderId) => uploads.start(entries, folderId, data.folders)}
          onDdCited={() => go({ dd: "1" }, { push: true })}
        />
      )}
      {view === "buyers" && <BuyersView dealId={dealId} focusAccessId={buyerFocus} onViewAs={(id) => go({ as: id }, { push: true })} />}
      {view === "todo" && <TodoView dealId={dealId} data={data} segment={todo} onSegment={(s) => go({ todo: s })} onOpenItem={(id) => go({ view: "documents", item: id }, { push: true })} onBuyer={(id) => go({ view: "buyers", buyer: id }, { push: true })} onDocuments={(f) => (f === "dd_cited" ? go({ dd: "1" }, { push: true }) : go({ view: "documents", filter: f }, { push: true }))} onPlan={() => go({ plan: "1" }, { push: true })} />}
      {view === "activity" && <ActivityView dealId={dealId} data={data} segment={activity} onSegment={(s) => go({ activity: s })} buyer={buyerFocus} onBuyer={(id) => go({ buyer: id })} onOpenItem={(id) => go({ view: "documents", item: id }, { push: true })} onViewAs={(id) => go({ as: id }, { push: true })} />}

      <DocumentDrawer dealId={dealId} item={drawerItem} onClose={() => go({ item: null })} onOpenViewer={(id) => go({ open: id }, { push: true })} onViewAs={() => { if (roomBuyers.length > 0) go({ as: roomBuyers[0].accessId, item: null }); else go({ view: "buyers", item: null }); }} />
      <ShareDialog dealId={dealId} target={share} open={!!share} onOpenChange={(o) => { if (!o) setShare(null); }} />
      <BrokerViewerDialog dealId={dealId} itemId={openId} title={openId ? data.items.find((i) => i.id === openId)?.title ?? "" : ""} number={openId ? data.items.find((i) => i.id === openId)?.number ?? null : null} onClose={() => go({ open: null })} onRetry={(id) => actions.retry(id)} />
      <RoomSettingsDialog dealId={dealId} room={data.room} open={settingsOpen} onOpenChange={setSettingsOpen} onPlan={() => go({ plan: "1" })} />
      <UploadPanel jobs={uploads.jobs} onClose={uploads.clear} question={uploads.question} />
      <DdCitedDialog dealId={dealId} open={showDdCited} onOpenChange={(o) => { if (!o) go({ dd: null }); }} />
    </div>
  );
}

/** The broker's own view of a document (no watermark; "Download original"). */
function BrokerViewerDialog({ dealId, itemId, title, number, onClose, onRetry }: { dealId: string; itemId: string | null; title: string; number: string | null; onClose: () => void; onRetry: (id: string) => void }) {
  const source = useMemo<VdrSource>(() => ({ kind: "broker", dealId }), [dealId]);
  const about = useItemAbout(source, itemId);
  const manifest = (about.data ?? null) as VdrManifest | null;
  return (
    <Dialog open={!!itemId} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="flex h-[94vh] max-w-[min(1200px,98vw)] flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="flex-row items-center gap-3 space-y-0 border-b border-border px-4 py-3 pr-12">
          <DialogTitle className="min-w-0 flex-1 truncate text-sm"><span className="mr-2 font-mono text-xs text-muted-foreground">{number}</span>{title}</DialogTitle>
          <DialogDescription className="sr-only">The document as it is in the data room. Buyers see their own name on every page.</DialogDescription>
          {itemId && (
            <Button asChild size="sm" variant="outline" className="shrink-0">
              <a href={vdrUrls(source).download(itemId, null)}><Download className="mr-1.5 h-3.5 w-3.5" /> Download original</a>
            </Button>
          )}
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {itemId && <VdrViewer source={source} itemId={itemId} manifest={manifest} loading={about.isLoading} onRetry={() => onRetry(itemId)} className="min-h-full" />}
        </div>
      </DialogContent>
    </Dialog>
  );
}
