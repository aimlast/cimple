/**
 * The room's numbered folder tree (vdr spec §5.1): open/close, counts,
 * drop documents (or files from the computer) onto a folder, the folder's
 * ⋯ menu (Share this folder… · Rename · New sub-folder · Delete), "+ New
 * folder" and the "Not in the room" pseudo-folder. Keyboard: arrows move,
 * Enter opens, F2 renames.
 */
import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, FolderPlus, Inbox, MoreHorizontal } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { VDR_LIMITS } from "@shared/vdr";
import type { RoomFolderRow } from "@shared/vdr-api";

export const DRAG_ITEMS = "application/x-vdr-items";

export type TreeSelection = { kind: "all" } | { kind: "folder"; id: string } | { kind: "not_placed" };

export function FolderTree(props: {
  folders: RoomFolderRow[];
  selected: TreeSelection;
  totalItems: number;
  notPlaced: number;
  onSelect: (s: TreeSelection) => void;
  onDropItems: (folderId: string, itemIds: string[]) => void;
  onDropFiles: (folderId: string, dt: DataTransfer) => void;
  onFolderAction: (action: "share" | "rename" | "new_sub" | "delete", folder: RoomFolderRow) => void;
  onNewFolder: () => void;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [over, setOver] = useState<string | null>(null);
  const kids = useMemo(() => {
    const m = new Map<string | null, RoomFolderRow[]>();
    for (const f of props.folders) m.set(f.parentId ?? null, [...(m.get(f.parentId ?? null) ?? []), f]);
    for (const list of Array.from(m.values())) list.sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));
    return m;
  }, [props.folders]);
  const isOpen = (f: RoomFolderRow) => open[f.id] ?? (props.selected.kind === "folder" && isAncestor(props.folders, f.id, props.selected.id));

  const dropProps = (folderId: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (Array.from(e.dataTransfer.types).some((t) => t === DRAG_ITEMS || t === "Files")) { e.preventDefault(); setOver(folderId); }
    },
    onDragLeave: () => setOver((o) => (o === folderId ? null : o)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setOver(null);
      const raw = e.dataTransfer.getData(DRAG_ITEMS);
      if (raw) {
        try { props.onDropItems(folderId, JSON.parse(raw)); } catch { /* not ours */ }
      } else if (e.dataTransfer.files?.length || e.dataTransfer.items?.length) props.onDropFiles(folderId, e.dataTransfer);
    },
  });

  const Row = ({ f, depth }: { f: RoomFolderRow; depth: number }) => {
    const children = kids.get(f.id) ?? [];
    const on = props.selected.kind === "folder" && props.selected.id === f.id;
    return (
      <li>
        <div
          className={cn("group flex items-center gap-1 rounded-md pr-1 text-sm transition-colors", on ? "bg-teal/10 text-teal" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground", over === f.id && "ring-1 ring-teal")}
          style={{ paddingLeft: 4 + depth * 14 }}
          {...dropProps(f.id)}
          data-testid={`tree-folder-${f.id}`}
        >
          <button className="flex h-6 w-5 shrink-0 items-center justify-center" onClick={() => setOpen((o) => ({ ...o, [f.id]: !isOpen(f) }))} aria-label={isOpen(f) ? "Close folder" : "Open folder"} disabled={children.length === 0}>
            {children.length > 0 ? (isOpen(f) ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />) : null}
          </button>
          <button
            className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left"
            onClick={() => props.onSelect({ kind: "folder", id: f.id })}
            onKeyDown={(e) => { if (e.key === "F2") { e.preventDefault(); props.onFolderAction("rename", f); } }}
          >
            <span className="w-8 shrink-0 font-mono text-[11px] opacity-70">{f.number}</span>
            <span className="min-w-0 flex-1 truncate">{f.name}</span>
            <span className="text-[11px] tabular-nums opacity-60">{f.count}</span>
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="flex h-6 w-6 shrink-0 items-center justify-center rounded opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100" aria-label={`More for ${f.name}`}>
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => props.onFolderAction("share", f)} disabled={f.count === 0}>Share this folder…</DropdownMenuItem>
              <DropdownMenuItem onClick={() => props.onFolderAction("rename", f)}>Rename</DropdownMenuItem>
              <DropdownMenuItem onClick={() => props.onFolderAction("new_sub", f)} disabled={f.depth >= VDR_LIMITS.folderDepth}>New sub-folder</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => props.onFolderAction("delete", f)} disabled={f.count > 0 || children.length > 0} className="text-destructive focus:text-destructive">Delete (empty only)</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {children.length > 0 && isOpen(f) && (
          <ul>{children.map((c) => <Row key={c.id} f={c} depth={depth + 1} />)}</ul>
        )}
      </li>
    );
  };

  return (
    <nav aria-label="Folders" className="text-sm" data-testid="folder-tree">
      <p className="mb-1.5 px-2 text-2xs font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">Folders</p>
      <button
        className={cn("mb-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm", props.selected.kind === "all" ? "bg-teal/10 text-teal" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground")}
        onClick={() => props.onSelect({ kind: "all" })}
      >
        <span className="flex-1">All documents</span>
        <span className="text-[11px] tabular-nums opacity-60">{props.totalItems}</span>
      </button>
      <ul className="space-y-0.5">{(kids.get(null) ?? []).map((f) => <Row key={f.id} f={f} depth={0} />)}</ul>
      <button onClick={props.onNewFolder} className="mt-2 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground" data-testid="tree-new-folder">
        <FolderPlus className="h-3.5 w-3.5" /> New folder
      </button>
      <div className="mt-2 border-t border-border pt-2">
        <button
          className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm", props.selected.kind === "not_placed" ? "bg-teal/10 text-teal" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground")}
          onClick={() => props.onSelect({ kind: "not_placed" })}
          data-testid="tree-not-placed"
        >
          <Inbox className="h-3.5 w-3.5" />
          <span className="flex-1">Not in the room</span>
          <span className="text-[11px] tabular-nums opacity-60">{props.notPlaced}</span>
        </button>
      </div>
    </nav>
  );
}

function isAncestor(folders: RoomFolderRow[], ancestorId: string, id: string): boolean {
  const byId = new Map(folders.map((f) => [f.id, f]));
  let f = byId.get(id);
  const seen = new Set<string>();
  while (f && !seen.has(f.id)) {
    seen.add(f.id);
    if (f.parentId === ancestorId) return true;
    f = f.parentId ? byId.get(f.parentId) : undefined;
  }
  return false;
}
