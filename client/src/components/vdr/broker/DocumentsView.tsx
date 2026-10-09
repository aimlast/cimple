/**
 * Documents (vdr spec §5.1–§5.3): the folder tree beside the documents of the
 * selected folder — a table at ≥ lg, cards below — with search, filters
 * (All · Shared · Not shared · New · Needs a look), "Share what the DD CIM
 * cites", Upload, a bulk bar, drag to move or reorder, files dropped on a
 * folder, each row's ⋯ menu, deleted-file rows and "Not in the room".
 */
import { useMemo, useRef, useState } from "react";
import { ArrowDownToLine, ChevronRight, FileUp, Folder, GripVertical, Loader2, MoreHorizontal, Search, Share2, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { DATA_ROOM_LEVELS, VDR_LIMITS } from "@shared/vdr";
import { accessLevelLabel } from "@shared/access-levels";
import type { BrokerRoomPayload, RoomFolderRow, RoomItemRow } from "@shared/vdr-api";
import { shortDate } from "@/hooks/useDataRoom";
import { DRAG_ITEMS, FolderTree, type TreeSelection } from "./FolderTree";
import { DownloadChip, ItemFlags, ItemMeta, OpenedLine, SharingChip } from "./parts";
import { useRoomActions, uploadCleanCopy } from "./actions";
import type { ShareTarget } from "./ShareDialog";
import { UPLOAD_ACCEPT, droppedEntries, type UploadEntry } from "./UploadPanel";

export type DocFilter = "all" | "shared" | "not_shared" | "new" | "attention" | "dd_cited";

export type DocumentsViewProps = {
  dealId: string;
  data: BrokerRoomPayload;
  selection: TreeSelection;
  onSelection: (s: TreeSelection) => void;
  q: string;
  onQ: (q: string) => void;
  filter: DocFilter;
  onFilter: (f: DocFilter) => void;
  onOpenItem: (itemId: string) => void;
  onOpenViewer: (itemId: string) => void;
  onShare: (t: ShareTarget) => void;
  onViewAs: () => void;
  onUpload: (entries: UploadEntry[], folderId: string) => void;
  onDdCited: () => void;
};

const WEEK = 7 * 86_400_000;
const needsALook = (i: RoomItemRow) => i.unchecked.length > 0 || !!i.newVersion || i.prepared?.status === "failed";

export function DocumentsView(p: DocumentsViewProps) {
  const { data, dealId } = p;
  const actions = useRoomActions(dealId);
  const { toast } = useToast();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<null | { kind: "rename_item"; item: RoomItemRow } | { kind: "rename_folder"; folder: RoomFolderRow } | { kind: "new_folder"; parentId: string | null } | { kind: "move"; itemIds: string[] } | { kind: "take_out"; items: RoomItemRow[] } | { kind: "delete_folder"; folder: RoomFolderRow } | { kind: "original"; item: RoomItemRow }>(null);
  const cleanInput = useRef<HTMLInputElement>(null);
  const cleanFor = useRef<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [overList, setOverList] = useState(false);

  const live = data.items.filter((i) => !i.removed);
  const folderIds = useMemo(() => {
    if (p.selection.kind !== "folder") return null;
    const out = new Set<string>([p.selection.id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const f of data.folders) if (f.parentId && out.has(f.parentId) && !out.has(f.id)) { out.add(f.id); grew = true; }
    }
    return out;
  }, [p.selection, data.folders]);
  const currentFolder = p.selection.kind === "folder" ? data.folders.find((f) => f.id === (p.selection as { id: string }).id) ?? null : null;
  const uploadFolder = currentFolder ?? data.folders.find((f) => f.presetKey === "other") ?? data.folders[0] ?? null;

  const q = p.q.trim().toLowerCase();
  const rows = data.items
    .filter((i) => (folderIds ? folderIds.has(i.folderId) : true))
    .filter((i) => !q || i.title.toLowerCase().includes(q) || (i.number ?? "").startsWith(q))
    .filter((i) => {
      if (i.removed) return p.filter === "all" && !q;
      switch (p.filter) {
        case "shared": return i.sharing.shared;
        case "not_shared": return !i.sharing.shared;
        case "new": return Date.now() - new Date(i.addedAt).getTime() < WEEK;
        case "attention": return needsALook(i);
        case "dd_cited": return !!i.ddCited;
        default: return true;
      }
    })
    .sort((a, b) => (a.number ?? "~").localeCompare(b.number ?? "~", undefined, { numeric: true }));
  const attention = live.filter(needsALook).length;
  const selItems = live.filter((i) => selected.has(i.id));
  const toggle = (id: string, on: boolean) => setSelected((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });

  const dropFiles = async (folderId: string, dt: DataTransfer) => {
    const entries = await droppedEntries(dt);
    if (entries.length) p.onUpload(entries, folderId);
  };

  const rowMenu = (i: RoomItemRow) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={`More for ${i.title}`} onClick={(e) => e.stopPropagation()}><MoreHorizontal className="h-4 w-4" /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuItem onClick={() => p.onOpenViewer(i.id)}>Open</DropdownMenuItem>
        <DropdownMenuItem onClick={() => p.onShare({ kind: "item", item: i })}>Share…</DropdownMenuItem>
        <DropdownMenuItem onClick={() => setDialog({ kind: "move", itemIds: [i.id] })}>Move to…</DropdownMenuItem>
        <DropdownMenuItem onClick={() => setDialog({ kind: "rename_item", item: i })}>Rename in the room</DropdownMenuItem>
        <DropdownMenuSeparator />
        {!i.isLedger && <DropdownMenuItem onClick={() => actions.setDownloadable(i.id, !i.downloadable)}>{i.downloadable ? "Make view-only" : "Let buyers download it"}</DropdownMenuItem>}
        {i.prepared?.kind === "pdf" && <DropdownMenuItem onClick={() => (i.downloadOriginal ? actions.setOriginal(i.id, false) : setDialog({ kind: "original", item: i }))}>{i.downloadOriginal ? "Offer the page copy instead" : "Offer the original file…"}</DropdownMenuItem>}
        {i.cleanCopy ? (
          <DropdownMenuItem onClick={() => actions.removeCleanCopy(i.id)}>Remove the cleaned copy</DropdownMenuItem>
        ) : (
          <DropdownMenuItem onClick={() => { cleanFor.current = i.id; cleanInput.current?.click(); }}>Upload a cleaned copy…</DropdownMenuItem>
        )}
        {i.unchecked.length > 0 && <DropdownMenuItem onClick={() => actions.check(i.id, i.unchecked)}>I've checked it</DropdownMenuItem>}
        <DropdownMenuItem onClick={p.onViewAs}>View as a buyer</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => setDialog({ kind: "take_out", items: [i] })}>Take out of the room</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const statusLine = (i: RoomItemRow) => {
    if (!i.prepared || i.prepared.status === "pending") return <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> Getting it ready…</span>;
    if (i.prepared.status === "failed") return (
      <span className="text-xs text-amber-600 dark:text-amber-400">
        Couldn't prepare a preview: {i.prepared.error ?? "Too large or damaged to preview."} Buyers can't open it yet.{" "}
        <button className="underline" onClick={(e) => { e.stopPropagation(); actions.retry(i.id); }}>Try again</button>
      </span>
    );
    if (i.isLedger && i.prepared.kind === "ledger_pending") return <span className="text-xs text-muted-foreground">General ledger: waiting for Cimple to read it</span>;
    if (i.isLedger) return <span className="text-xs text-muted-foreground">General ledger: due diligence buyers only</span>;
    return null;
  };

  const newVersionLine = (i: RoomItemRow) =>
    i.newVersion ? (
      <span className="text-xs text-teal">
        New version from the seller. Not shared yet.{" "}
        {i.newVersion.oldWasShared && <button className="underline" onClick={(e) => { e.stopPropagation(); actions.shareLikeReplaced(i.id); }}>Share with the same people</button>}
      </span>
    ) : null;

  const tombstone = (i: RoomItemRow) => {
    const r = i.removed!;
    const when = shortDate(r.at);
    const words = r.reason === "made_private" ? `Made broker-only on ${when}` : r.reason === "seller_removed" ? `The seller removed this file on ${when}` : `This file was deleted on ${when}`;
    return (
      <div key={i.id} className="flex items-center gap-3 border-b border-border px-3 py-2.5 opacity-60 last:border-0" data-testid={`row-removed-${i.id}`}>
        <span className="w-14 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm line-through">{i.title}</span>
          <span className="text-xs text-muted-foreground">{words}{r.wasShared ? ` · it was shared${r.buyersCouldOpen ? ` (${r.buyersCouldOpen} ${r.buyersCouldOpen === 1 ? "buyer" : "buyers"} opened it)` : ""}` : ""}</span>
        </span>
        {r.reason === "made_private" ? (
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => actions.restore(i.id)} disabled={i.doc?.visibility === "broker_only"} title={i.doc?.visibility === "broker_only" ? "Share it on the Information tab first" : undefined}>Put back</Button>
        ) : (
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => actions.takeOut(i.id)}>Remove from the list</Button>
        )}
      </div>
    );
  };

  return (
    <div className="flex gap-5">
      <aside className="hidden w-[260px] shrink-0 lg:block">
        <div className="sticky top-2 max-h-[calc(100vh-180px)] overflow-y-auto pr-1 scrollbar-thin">
          <FolderTree
            folders={data.folders}
            selected={p.selection}
            totalItems={live.length}
            notPlaced={data.notPlaced.length}
            onSelect={(s) => { p.onSelection(s); setSelected(new Set()); }}
            onDropItems={(folderId, ids) => actions.move(ids, folderId)}
            onDropFiles={dropFiles}
            onFolderAction={(a, f) => {
              if (a === "share") p.onShare({ kind: "folder", folder: f, items: live.filter((i) => isInside(data.folders, f.id, i.folderId)) });
              if (a === "rename") setDialog({ kind: "rename_folder", folder: f });
              if (a === "new_sub") setDialog({ kind: "new_folder", parentId: f.id });
              if (a === "delete") setDialog({ kind: "delete_folder", folder: f });
            }}
            onNewFolder={() => setDialog({ kind: "new_folder", parentId: null })}
          />
        </div>
      </aside>

      <section className="min-w-0 flex-1 space-y-3">
        {/* Phones: where you are + folder picker */}
        <PhoneFolderBar data={data} selection={p.selection} onSelection={(s) => { p.onSelection(s); setSelected(new Set()); }} />

        <div className="flex flex-wrap items-center gap-2">
          <label className="relative min-w-[180px] flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={p.q} onChange={(e) => p.onQ(e.target.value)} placeholder="Search the room" className="h-8 pl-8 text-sm" data-testid="room-doc-search" />
          </label>
          <div className="flex max-w-full overflow-x-auto rounded-md border border-border p-0.5 text-xs" role="tablist" aria-label="Filter">
            {(["all", "shared", "not_shared", "new", "attention", ...(data.ddCited.available ? ["dd_cited"] : [])] as DocFilter[]).map((f) => (
              <button key={f} role="tab" aria-selected={p.filter === f} onClick={() => p.onFilter(f)} className={cn("shrink-0 rounded-[5px] px-2.5 py-1", p.filter === f ? "bg-teal/15 text-teal" : "text-muted-foreground hover:text-foreground")} data-testid={`room-filter-${f}`}>
                {f === "all" ? "All" : f === "shared" ? "Shared" : f === "not_shared" ? "Not shared" : f === "new" ? "New" : f === "dd_cited" ? "In the DD CIM" : `Needs a look (${attention})`}
              </button>
            ))}
          </div>
          <div className="ml-auto hidden items-center gap-2 sm:flex">
            <DdCitedButton data={data} onClick={p.onDdCited} />
            <Button size="sm" onClick={() => fileInput.current?.click()} disabled={!uploadFolder} data-testid="room-upload"><Upload className="mr-1.5 h-3.5 w-3.5" /> Upload</Button>
          </div>
        </div>

        {selItems.length > 0 && (
          <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-lg border border-teal/30 bg-card px-3 py-2 text-sm shadow-sm" data-testid="bulk-bar">
            <span className="font-medium">{selItems.length} selected</span>
            <Button size="sm" variant="outline" onClick={() => p.onShare({ kind: "items", items: selItems })}><Share2 className="mr-1.5 h-3.5 w-3.5" /> Share…</Button>
            <Button size="sm" variant="ghost" onClick={() => actions.bulk({ itemIds: selItems.map((i) => i.id), remove: { levels: [...DATA_ROOM_LEVELS], allow: [] } }, "Stopped sharing by level")}>Stop sharing</Button>
            <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: "move", itemIds: selItems.map((i) => i.id) })}>Move to…</Button>
            <Button size="sm" variant="ghost" onClick={() => Promise.all(selItems.filter((i) => !i.isLedger).map((i) => actions.setDownloadable(i.id, true)))}>Allow downloads</Button>
            <Button size="sm" variant="ghost" onClick={() => Promise.all(selItems.map((i) => actions.setDownloadable(i.id, false)))}>Make view-only</Button>
            <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setDialog({ kind: "take_out", items: selItems })}>Take out of the room</Button>
            <Button size="icon" variant="ghost" className="ml-auto h-7 w-7" onClick={() => setSelected(new Set())} aria-label="Clear the selection"><X className="h-4 w-4" /></Button>
          </div>
        )}

        {p.selection.kind === "not_placed" ? (
          <NotPlaced data={data} onPlace={(id) => actions.place(id)} />
        ) : (
          <div
            className={cn("overflow-hidden rounded-lg border border-border bg-card", overList && "ring-1 ring-teal")}
            onDragOver={(e) => { if (currentFolder && Array.from(e.dataTransfer.types).includes("Files")) { e.preventDefault(); setOverList(true); } }}
            onDragLeave={() => setOverList(false)}
            onDrop={(e) => { setOverList(false); if (currentFolder && e.dataTransfer.files?.length) { e.preventDefault(); dropFiles(currentFolder.id, e.dataTransfer); } }}
            data-testid="room-doc-list"
          >
            {currentFolder && (
              <div className="flex items-center gap-2 border-b border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                <Folder className="h-3.5 w-3.5 text-teal/80" />
                <span className="font-mono">{currentFolder.number}</span>
                <span className="font-medium text-foreground">{currentFolder.name}</span>
                {currentFolder.shareHint?.levels.length ? <span>· planned for {currentFolder.shareHint.levels.length > 1 ? "every buyer with the room" : `${accessLevelLabel(currentFolder.shareHint.levels[0])} buyers`}</span> : null}
              </div>
            )}
            {rows.length === 0 ? (
              <p className="px-6 py-12 text-center text-sm text-muted-foreground">
                {q || p.filter !== "all" ? "No documents match." : currentFolder ? "Drop files here, or move documents in." : "No documents in the room yet. Upload some, or put documents in from \"Not in the room\"."}
              </p>
            ) : (
              <>
                {/* ≥ lg: the table */}
                <table className="hidden w-full text-sm lg:table">
                  <thead>
                    <tr className="border-b border-border text-left text-2xs uppercase tracking-[0.12em] text-muted-foreground/70">
                      <th className="w-8 px-3 py-2"><Checkbox checked={rows.filter((r) => !r.removed).length > 0 && rows.filter((r) => !r.removed).every((r) => selected.has(r.id))} onCheckedChange={(v) => setSelected(v === true ? new Set(rows.filter((r) => !r.removed).map((r) => r.id)) : new Set())} aria-label="Select all" /></th>
                      <th className="px-2 py-2 font-medium">Document</th>
                      <th className="px-2 py-2 font-medium">Who can see it</th>
                      <th className="px-2 py-2 font-medium">Opened</th>
                      <th className="w-10" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((i) => i.removed ? (
                      <tr key={i.id}><td colSpan={5} className="p-0">{tombstone(i)}</td></tr>
                    ) : (
                      <tr
                        key={i.id}
                        className="group cursor-pointer border-b border-border last:border-0 hover:bg-muted/30"
                        draggable
                        onDragStart={(e) => { e.dataTransfer.setData(DRAG_ITEMS, JSON.stringify(selected.has(i.id) ? Array.from(selected) : [i.id])); e.dataTransfer.effectAllowed = "move"; }}
                        onDragOver={(e) => { if (Array.from(e.dataTransfer.types).includes(DRAG_ITEMS)) e.preventDefault(); }}
                        onDrop={(e) => { const raw = e.dataTransfer.getData(DRAG_ITEMS); if (raw) { e.preventDefault(); e.stopPropagation(); try { actions.move(JSON.parse(raw), i.folderId, i.id); } catch { /* not ours */ } } }}
                        onClick={() => p.onOpenItem(i.id)}
                        data-testid={`room-row-${i.id}`}
                      >
                        <td className="px-3 py-2.5 align-top" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center gap-1">
                            <GripVertical className="h-3.5 w-3.5 cursor-grab text-muted-foreground/40 opacity-0 group-hover:opacity-100" />
                            <Checkbox checked={selected.has(i.id)} onCheckedChange={(v) => toggle(i.id, v === true)} aria-label={`Select ${i.title}`} />
                          </div>
                        </td>
                        <td className="px-2 py-2.5 align-top">
                          <div className="flex items-baseline gap-2">
                            <span className="w-12 shrink-0 font-mono text-[11px] text-muted-foreground">{i.number}</span>
                            <div className="min-w-0 space-y-1">
                              <p className="truncate font-medium text-foreground group-hover:text-teal">{i.title}</p>
                              <ItemMeta item={i} />
                              <ItemFlags item={i} />
                              {statusLine(i)}
                              {newVersionLine(i)}
                            </div>
                          </div>
                        </td>
                        <td className="px-2 py-2.5 align-top"><div className="space-y-1"><SharingChip item={i} /><div><DownloadChip item={i} /></div></div></td>
                        <td className="px-2 py-2.5 align-top"><OpenedLine item={i} /></td>
                        <td className="px-2 py-2.5 align-top">{rowMenu(i)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {/* < lg: cards */}
                <div className="lg:hidden">
                  {rows.map((i) => i.removed ? tombstone(i) : (
                    <div key={i.id} className="flex gap-2.5 border-b border-border px-3 py-3 last:border-0" data-testid={`room-card-${i.id}`}>
                      <Checkbox checked={selected.has(i.id)} onCheckedChange={(v) => toggle(i.id, v === true)} aria-label={`Select ${i.title}`} className="mt-1" />
                      <button className="min-w-0 flex-1 space-y-1 text-left" onClick={() => p.onOpenItem(i.id)}>
                        <p className="text-sm font-medium"><span className="mr-1.5 font-mono text-[11px] text-muted-foreground">{i.number}</span>{i.title}</p>
                        <ItemMeta item={i} />
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1"><SharingChip item={i} /><OpenedLine item={i} /></div>
                        <ItemFlags item={i} max={2} />
                        {statusLine(i)}
                        {newVersionLine(i)}
                      </button>
                      {rowMenu(i)}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
        {/* Phones: the actions as a bottom bar */}
        <div className="sticky bottom-0 z-10 -mx-4 flex gap-2 border-t border-border bg-background/95 px-4 py-2 backdrop-blur sm:hidden">
          <Button size="sm" className="flex-1" onClick={() => fileInput.current?.click()} disabled={!uploadFolder}><Upload className="mr-1.5 h-3.5 w-3.5" /> Upload</Button>
          <DdCitedButton data={data} onClick={p.onDdCited} className="flex-1" />
        </div>
        <p className="text-xs text-muted-foreground">Emails, call notes and CRM notes are your working material and stay out of the data room. Private files (broker-only) can't be shared.</p>
      </section>

      <input
        ref={fileInput}
        type="file"
        multiple
        accept={UPLOAD_ACCEPT}
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length && uploadFolder) p.onUpload(files.map((file) => ({ file, dirs: [] })), uploadFolder.id);
        }}
      />
      <input
        ref={cleanInput}
        type="file"
        accept={UPLOAD_ACCEPT}
        className="hidden"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file || !cleanFor.current) return;
          try {
            await uploadCleanCopy(dealId, cleanFor.current, file);
            toast({ title: "Cleaned copy uploaded", description: "Buyers see the cleaned copy. It's never read for the CIM's facts." });
          } catch (err: any) {
            toast({ title: "Couldn't upload the cleaned copy", description: err.message, variant: "destructive" });
          }
        }}
      />

      <NameDialog
        open={dialog?.kind === "rename_item" || dialog?.kind === "rename_folder" || dialog?.kind === "new_folder"}
        title={dialog?.kind === "rename_item" ? "Rename in the room" : dialog?.kind === "rename_folder" ? "Rename the folder" : "New folder"}
        description={dialog?.kind === "rename_item" ? "Buyers see this name. The document itself keeps its own name in the deal." : undefined}
        initial={dialog?.kind === "rename_item" ? dialog.item.title : dialog?.kind === "rename_folder" ? dialog.folder.name : ""}
        max={dialog?.kind === "rename_item" ? VDR_LIMITS.title : VDR_LIMITS.folderName}
        onClose={() => setDialog(null)}
        onSave={async (name) => {
          if (dialog?.kind === "rename_item") await actions.rename(dialog.item.id, name);
          if (dialog?.kind === "rename_folder") await actions.renameFolder(dialog.folder.id, name);
          if (dialog?.kind === "new_folder") await actions.newFolder(name, dialog.parentId);
          setDialog(null);
        }}
      />
      <MoveToDialog
        open={dialog?.kind === "move"}
        folders={data.folders}
        onClose={() => setDialog(null)}
        onMove={async (folderId) => { if (dialog?.kind === "move") await actions.move(dialog.itemIds, folderId); setSelected(new Set()); setDialog(null); }}
      />
      <AlertDialog open={dialog?.kind === "take_out"} onOpenChange={(o) => { if (!o) setDialog(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Take {dialog?.kind === "take_out" && dialog.items.length > 1 ? `${dialog.items.length} documents` : "this document"} out of the room?</AlertDialogTitle>
            <AlertDialogDescription>Buyers lose access at once. The document stays in the deal (and in its facts); you can put it back from "Not in the room".</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={async () => { if (dialog?.kind === "take_out") { for (const i of dialog.items) await actions.takeOut(i.id); } setSelected(new Set()); setDialog(null); }}>Take it out</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={dialog?.kind === "delete_folder"} onOpenChange={(o) => { if (!o) setDialog(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete the folder "{dialog?.kind === "delete_folder" ? dialog.folder.name : ""}"?</AlertDialogTitle>
            <AlertDialogDescription>It's empty. The numbers of the folders after it move up for everyone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={async () => { if (dialog?.kind === "delete_folder") await actions.deleteFolder(dialog.folder.id); p.onSelection({ kind: "all" }); setDialog(null); }}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={dialog?.kind === "original"} onOpenChange={(o) => { if (!o) setDialog(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Offer the original file?</AlertDialogTitle>
            <AlertDialogDescription>
              Buyers who may download it get the PDF itself (comments, attachments and file details removed, their name stamped on every page) instead of page images. The original file can still contain words hidden under black boxes and anything you can't see on the page.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep page images</AlertDialogCancel>
            <AlertDialogAction onClick={async () => { if (dialog?.kind === "original") await actions.setOriginal(dialog.item.id, true); setDialog(null); }}>Offer the original</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function isInside(folders: RoomFolderRow[], folderId: string, itemFolderId: string): boolean {
  const byId = new Map(folders.map((f) => [f.id, f]));
  let f = byId.get(itemFolderId);
  const seen = new Set<string>();
  while (f && !seen.has(f.id)) {
    if (f.id === folderId) return true;
    seen.add(f.id);
    f = f.parentId ? byId.get(f.parentId) : undefined;
  }
  return false;
}

function DdCitedButton({ data, onClick, className }: { data: BrokerRoomPayload; onClick: () => void; className?: string }) {
  const n = data.ddCited.notShared;
  const btn = (
    <Button size="sm" variant="outline" onClick={onClick} disabled={!data.ddCited.available || n === 0} className={className} data-testid="room-dd-cited">
      <Share2 className="mr-1.5 h-3.5 w-3.5" /> Share what the DD CIM cites{data.ddCited.available ? ` (${n})` : ""}
    </Button>
  );
  if (data.ddCited.available && n > 0) return btn;
  return (
    <Tooltip>
      <TooltipTrigger asChild><span className={cn("inline-flex", className)} tabIndex={0}>{btn}</span></TooltipTrigger>
      <TooltipContent className="text-xs">{data.ddCited.available ? "Everything the DD CIM points to is shared with due diligence buyers." : "Generate the due-diligence CIM first."}</TooltipContent>
    </Tooltip>
  );
}

function PhoneFolderBar({ data, selection, onSelection }: { data: BrokerRoomPayload; selection: TreeSelection; onSelection: (s: TreeSelection) => void }) {
  const current = selection.kind === "folder" ? data.folders.find((f) => f.id === selection.id) ?? null : null;
  const children = data.folders.filter((f) => (f.parentId ?? null) === (current?.id ?? null));
  const trail: RoomFolderRow[] = [];
  let f = current;
  while (f) { trail.unshift(f); f = f.parentId ? data.folders.find((x) => x.id === f!.parentId) ?? null : null; }
  return (
    <div className="space-y-2 lg:hidden">
      <nav className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground" aria-label="Where you are">
        <button onClick={() => onSelection({ kind: "all" })} className={cn(selection.kind === "all" && "font-medium text-foreground")}>Data room</button>
        {trail.map((t) => <span key={t.id} className="flex items-center gap-1"><ChevronRight className="h-3 w-3" /><button onClick={() => onSelection({ kind: "folder", id: t.id })}>{t.number} {t.name}</button></span>)}
        <span className="flex items-center gap-1"><ChevronRight className="h-3 w-3" /><button onClick={() => onSelection({ kind: "not_placed" })} className={cn(selection.kind === "not_placed" && "font-medium text-foreground")}>Not in the room ({data.notPlaced.length})</button></span>
      </nav>
      {selection.kind !== "not_placed" && children.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          {children.map((c) => (
            <button key={c.id} onClick={() => onSelection({ kind: "folder", id: c.id })} className="flex w-full items-center gap-3 border-b border-border px-3 py-2.5 text-left text-sm last:border-0">
              <Folder className="h-4 w-4 shrink-0 text-teal/80" />
              <span className="w-9 font-mono text-[11px] text-muted-foreground">{c.number}</span>
              <span className="min-w-0 flex-1 truncate">{c.name}</span>
              <span className="text-xs tabular-nums text-muted-foreground">{c.count}</span>
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function NotPlaced({ data, onPlace }: { data: BrokerRoomPayload; onPlace: (documentId: string) => void }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card" data-testid="not-placed">
      <div className="border-b border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">Deal documents that aren't in the data room. Putting one in shares nothing.</div>
      {data.notPlaced.length === 0 ? (
        <p className="px-6 py-10 text-center text-sm text-muted-foreground">Every document of this deal is in the room.</p>
      ) : (
        data.notPlaced.map((d) => (
          <div key={d.documentId} className="flex items-center gap-3 border-b border-border px-3 py-2.5 last:border-0">
            <FileUp className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">{d.name}</span>
              <span className="text-xs text-muted-foreground">{[d.typeLabel, d.uploadedBy === "seller" ? "from the seller" : "uploaded by you", shortDate(d.createdAt), d.suggestedFolder ? `goes in ${d.suggestedFolder}` : null].filter(Boolean).join(" · ")}</span>
            </span>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => onPlace(d.documentId)}><ArrowDownToLine className="mr-1 h-3 w-3" /> Put in the room</Button>
          </div>
        ))
      )}
      <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">Emails, call notes and CRM notes are your working material and stay out of the data room. To share an email, save it as a PDF and upload it.</p>
    </div>
  );
}

function NameDialog({ open, title, description, initial, max, onClose, onSave }: { open: boolean; title: string; description?: string; initial: string; max: number; onClose: () => void; onSave: (name: string) => Promise<void> }) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const key = `${open}:${initial}`;
  const [lastKey, setLastKey] = useState(key);
  if (key !== lastKey) { setLastKey(key); setName(initial); }
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : <DialogDescription className="sr-only">{title}</DialogDescription>}
        </DialogHeader>
        <Input value={name} maxLength={max} onChange={(e) => setName(e.target.value)} autoFocus onKeyDown={async (e) => { if (e.key === "Enter" && name.trim()) { setBusy(true); await onSave(name.trim()); setBusy(false); } }} />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={!name.trim() || busy} onClick={async () => { setBusy(true); await onSave(name.trim()); setBusy(false); }}>{busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />} Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MoveToDialog({ open, folders, onClose, onMove }: { open: boolean; folders: RoomFolderRow[]; onClose: () => void; onMove: (folderId: string) => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[85vh] max-w-sm overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Move to…</DialogTitle>
          <DialogDescription>Moving renumbers the documents for everyone. Sharing doesn't change.</DialogDescription>
        </DialogHeader>
        <div className="space-y-0.5">
          {folders.map((f) => (
            <button key={f.id} disabled={!!busy} onClick={async () => { setBusy(f.id); await onMove(f.id); setBusy(null); }} className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted/50" style={{ paddingLeft: 8 + (f.depth - 1) * 16 }}>
              <span className="w-10 font-mono text-[11px] text-muted-foreground">{f.number}</span>
              <span className="flex-1 truncate">{f.name}</span>
              {busy === f.id && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
