/**
 * The buyer's room browser (vdr spec §6.2, §6.4): the search box, "New since
 * your last visit", "All documents", the numbered folder tree (desktop rail)
 * and the document list. On phones the rail becomes rows: a breadcrumb, the
 * folder's sub-folders and its documents.
 */
import { useMemo } from "react";
import { CheckCircle2, ChevronRight, Download, FileText, Folder, Loader2, Search, Star } from "lucide-react";
import { cn } from "@/lib/utils";
import type { BuyerRoomFolder, BuyerRoomItem, BuyerSearchHit } from "@shared/vdr-api";

export type RoomPlace = { kind: "all" } | { kind: "new" } | { kind: "folder"; id: string };

export function RoomRail(props: {
  folders: BuyerRoomFolder[];
  items: BuyerRoomItem[];
  place: RoomPlace;
  onPlace: (p: RoomPlace) => void;
  query: string;
  onQuery: (q: string) => void;
  canSearch: boolean;
}) {
  const newCount = props.items.filter((i) => i.isNew || i.isUpdated).length;
  const top = props.folders.filter((f) => !f.parentId);
  const kids = (id: string) => props.folders.filter((f) => f.parentId === id);
  const isOn = (p: RoomPlace) => JSON.stringify(p) === JSON.stringify(props.place);
  const row = "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors";
  const FolderRow = ({ f, depth }: { f: BuyerRoomFolder; depth: number }) => (
    <>
      <button
        className={cn(row, isOn({ kind: "folder", id: f.id }) ? "bg-teal/10 text-teal" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground")}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => props.onPlace({ kind: "folder", id: f.id })}
      >
        <span className="w-7 shrink-0 font-mono text-[11px] opacity-70">{f.number}</span>
        <span className="min-w-0 flex-1 truncate">{f.name}</span>
        <span className="text-[11px] tabular-nums opacity-60">{f.count}</span>
      </button>
      {kids(f.id).map((k) => <FolderRow key={k.id} f={k} depth={depth + 1} />)}
    </>
  );
  return (
    <div className="space-y-3">
      {props.canSearch && <SearchBox value={props.query} onChange={props.onQuery} />}
      <div className="space-y-0.5">
        <button className={cn(row, isOn({ kind: "new" }) ? "bg-teal/10 text-teal" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground")} onClick={() => props.onPlace({ kind: "new" })} data-testid="room-new">
          <Star className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1">New since your last visit</span>
          <span className="text-[11px] tabular-nums">{newCount}</span>
        </button>
        <button className={cn(row, isOn({ kind: "all" }) ? "bg-teal/10 text-teal" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground")} onClick={() => props.onPlace({ kind: "all" })}>
          <FileText className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1">All documents</span>
          <span className="text-[11px] tabular-nums">{props.items.length}</span>
        </button>
      </div>
      {top.length > 0 && (
        <div className="space-y-0.5 border-t border-border pt-3">
          {top.map((f) => <FolderRow key={f.id} f={f} depth={0} />)}
        </div>
      )}
    </div>
  );
}

export function SearchBox({ value, onChange, autoFocus }: { value: string; onChange: (q: string) => void; autoFocus?: boolean }) {
  return (
    <label className="relative block">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <input
        type="search"
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search names and contents"
        maxLength={100}
        className="h-9 w-full rounded-md border border-border bg-background pl-8 pr-2 text-sm placeholder:text-muted-foreground/70 focus:outline-none focus:ring-1 focus:ring-teal/50"
        data-testid="room-search"
        aria-label="Search the data room"
      />
    </label>
  );
}

export function ItemRow({ item, onOpen }: { item: BuyerRoomItem; onOpen: (id: string) => void }) {
  return (
    <button
      onClick={() => onOpen(item.id)}
      className="group flex w-full items-center gap-3 border-b border-border px-3 py-3 text-left transition-colors last:border-0 hover:bg-muted/40"
      data-testid={`room-item-${item.id}`}
    >
      <span className="w-10 shrink-0 font-mono text-[11px] text-muted-foreground sm:w-12">{item.number}</span>
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 block text-sm font-medium text-foreground group-hover:text-teal sm:line-clamp-1">{item.title}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{item.ready ? item.sizeLabel : "Getting it ready…"}</span>
      </span>
      {item.isNew && <span className="shrink-0 rounded bg-teal/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-teal">New</span>}
      {!item.isNew && item.isUpdated && <span className="shrink-0 rounded bg-teal/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-teal">Updated</span>}
      {item.opened && <span className="hidden shrink-0 items-center gap-1 text-[11px] text-muted-foreground sm:inline-flex"><CheckCircle2 className="h-3 w-3" /> opened</span>}
      {item.download.allowed && <Download className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-label="Can be downloaded" />}
      {!item.ready && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />}
    </button>
  );
}

/** The documents of a place, grouped under their folder headings. */
export function RoomList(props: {
  folders: BuyerRoomFolder[];
  items: BuyerRoomItem[];
  place: RoomPlace;
  onOpen: (id: string) => void;
  onPlace: (p: RoomPlace) => void;
  previousVisitAt: string | null;
}) {
  const byId = useMemo(() => new Map(props.folders.map((f) => [f.id, f])), [props.folders]);
  const descendants = (id: string): Set<string> => {
    const out = new Set<string>([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const f of props.folders) if (f.parentId && out.has(f.parentId) && !out.has(f.id)) { out.add(f.id); grew = true; }
    }
    return out;
  };
  let items = props.items;
  let subfolders: BuyerRoomFolder[] = [];
  if (props.place.kind === "new") items = items.filter((i) => i.isNew || i.isUpdated);
  if (props.place.kind === "folder") {
    const within = descendants(props.place.id);
    items = items.filter((i) => within.has(i.folderId));
    subfolders = props.folders.filter((f) => f.parentId === (props.place as { id: string }).id);
  }
  if (props.place.kind === "new" && items.length === 0) {
    return (
      <EmptyLine>
        {props.previousVisitAt ? `Nothing new since your last visit on ${new Date(props.previousVisitAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}.` : "Nothing new yet. New documents are marked here after your first visit."}
      </EmptyLine>
    );
  }
  // Group by the document's own folder, in index order.
  const groups = new Map<string, BuyerRoomItem[]>();
  for (const it of items) groups.set(it.folderId, [...(groups.get(it.folderId) ?? []), it]);
  const ordered = Array.from(groups.entries()).sort((a, b) => (byId.get(a[0])?.number ?? "").localeCompare(byId.get(b[0])?.number ?? "", undefined, { numeric: true }));
  return (
    <div className="space-y-5">
      {subfolders.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          {subfolders.map((f) => (
            <button key={f.id} onClick={() => props.onPlace({ kind: "folder", id: f.id })} className="flex w-full items-center gap-3 border-b border-border px-3 py-3 text-left last:border-0 hover:bg-muted/40">
              <Folder className="h-4 w-4 shrink-0 text-teal/80" />
              <span className="w-10 shrink-0 font-mono text-[11px] text-muted-foreground">{f.number}</span>
              <span className="min-w-0 flex-1 truncate text-sm">{f.name}</span>
              <span className="text-xs tabular-nums text-muted-foreground">{f.count}</span>
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            </button>
          ))}
        </div>
      )}
      {ordered.map(([folderId, list]) => {
        const f = byId.get(folderId);
        return (
          <section key={folderId}>
            {f && <h3 className="mb-1.5 px-1 text-xs font-semibold text-muted-foreground"><span className="mr-1.5 font-mono">{f.number}</span>{f.name}</h3>}
            <div className="overflow-hidden rounded-lg border border-border bg-card">
              {list.map((it) => <ItemRow key={it.id} item={it} onOpen={props.onOpen} />)}
            </div>
          </section>
        );
      })}
      {ordered.length === 0 && subfolders.length === 0 && <EmptyLine>This folder is empty.</EmptyLine>}
    </div>
  );
}

export function SearchResults({ q, hits, loading, error, onOpen }: { q: string; hits: BuyerSearchHit[] | undefined; loading: boolean; error: boolean; onOpen: (itemId: string, page: number) => void }) {
  if (loading) return <div className="flex items-center gap-2 px-1 py-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Searching…</div>;
  if (error) return <EmptyLine>Search isn't working right now. Try again in a moment.</EmptyLine>;
  if (!hits || hits.length === 0) return <EmptyLine>No documents match '{q}'.</EmptyLine>;
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card" data-testid="room-search-results">
      {hits.map((h, i) => (
        <button key={`${h.itemId}-${h.page}-${i}`} onClick={() => onOpen(h.itemId, h.page)} className="block w-full border-b border-border px-3 py-3 text-left last:border-0 hover:bg-muted/40">
          <span className="block text-sm font-medium"><span className="mr-1.5 font-mono text-[11px] text-muted-foreground">{h.number}</span>{h.title}<span className="font-normal text-muted-foreground">{h.label !== "Title" ? `, ${h.label.toLowerCase()}` : ""}</span></span>
          <span className="mt-1 block text-xs text-muted-foreground">
            {h.snippet.map((p, j) => (p.match ? <strong key={j} className="font-semibold text-foreground">{p.text}</strong> : <span key={j}>{p.text}</span>))}
          </span>
        </button>
      ))}
    </div>
  );
}

function EmptyLine({ children }: { children: React.ReactNode }) {
  return <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">{children}</p>;
}

