/**
 * MediaLibrary — every photo and video uploaded for the deal, reusable in
 * any section. Two uses:
 *   - "manage" (the builder's Media library drawer): upload, caption,
 *     blind-safe switch, where it's used, delete.
 *   - "pick" (from a gallery/video editor): tick files and add them.
 */
import { useEffect, useState } from "react";
import { Check, Film, ImageIcon, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { BlindSafeExplainer, BlindSafeSwitch } from "./BlindSafe";
import { UploadDropzone } from "./UploadDropzone";
import { formatBytes, type MediaItem, type MediaLibraryApi } from "./api";

interface Props {
  dealId: string;
  library: MediaLibraryApi;
  mode: "manage" | "pick";
  /** pick mode: which kind to offer, what's already in the section, and the result. */
  kind?: "image" | "video";
  exclude?: string[];
  onPick?: (items: MediaItem[]) => void;
}

export function MediaLibrary({ dealId, library, mode, kind, exclude = [], onPick }: Props) {
  const [filter, setFilter] = useState<"all" | "image" | "video">(kind ?? "all");
  const [picked, setPicked] = useState<string[]>([]);
  const [toDelete, setToDelete] = useState<MediaItem | null>(null);
  const items = library.items.filter((m) => (filter === "all" ? true : m.kind === filter));
  const pickable = (m: MediaItem) => !exclude.includes(m.id) && (!kind || m.kind === kind);

  return (
    <div className="space-y-4">
      <UploadDropzone
        dealId={dealId}
        kind={kind}
        onUploaded={(item) => {
          library.addUploaded(item);
          if (mode === "pick" && pickable(item)) setPicked((p) => [...p, item.id]);
        }}
      />
      {mode === "manage" && <BlindSafeExplainer />}

      {!kind && library.items.length > 0 && (
        <div className="flex gap-1 rounded-md border border-border p-0.5 bg-muted/30 w-fit" role="tablist">
          {(["all", "image", "video"] as const).map((f) => (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={filter === f}
              onClick={() => setFilter(f)}
              className={cn("rounded px-2.5 py-1 text-[11px]", filter === f ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
            >
              {f === "all" ? `All (${library.items.length})` : f === "image" ? `Photos (${library.items.filter((m) => m.kind === "image").length})` : `Videos (${library.items.filter((m) => m.kind === "video").length})`}
            </button>
          ))}
        </div>
      )}

      {library.query.isLoading ? (
        <div className="grid grid-cols-2 gap-3">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="aspect-[4/3] rounded-lg" />)}</div>
      ) : library.query.isError ? (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-xs">
          <p className="text-red-400">Couldn't load the media library.</p>
          <Button size="sm" variant="outline" className="h-7 text-xs mt-2" onClick={() => library.query.refetch()}>Try again</Button>
        </div>
      ) : items.length === 0 ? (
        <p className="text-center text-xs text-muted-foreground py-6">
          {library.items.length === 0 ? "Nothing uploaded for this deal yet." : "Nothing of this kind yet."}
        </p>
      ) : (
        <div className={cn("grid gap-3", mode === "pick" ? "grid-cols-2 sm:grid-cols-3" : "grid-cols-1 sm:grid-cols-2")}>
          {items.map((m) =>
            mode === "pick" ? (
              <PickCard
                key={m.id}
                item={m}
                disabled={!pickable(m)}
                selected={picked.includes(m.id)}
                onToggle={() => setPicked((p) => (p.includes(m.id) ? p.filter((x) => x !== m.id) : [...p, m.id]))}
              />
            ) : (
              <ManageCard key={m.id} item={m} library={library} onDelete={() => setToDelete(m)} />
            ),
          )}
        </div>
      )}

      {mode === "pick" && (
        <div className="flex justify-end gap-2 border-t border-border pt-3">
          <Button
            size="sm"
            className="bg-teal text-teal-foreground hover:bg-teal/90"
            disabled={picked.length === 0}
            onClick={() => onPick?.(library.items.filter((m) => picked.includes(m.id)))}
            data-testid="button-add-picked-media"
          >
            {picked.length === 0 ? "Choose files" : `Add ${picked.length} ${kind === "video" ? (picked.length === 1 ? "video" : "videos") : picked.length === 1 ? "photo" : "photos"}`}
          </Button>
        </div>
      )}

      <AlertDialog open={!!toDelete} onOpenChange={(o) => !o && setToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this {toDelete?.kind === "video" ? "video" : "photo"}?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                {toDelete && toDelete.usedIn.length > 0 ? (
                  <>
                    <p>It's used in {toDelete.usedIn.length === 1 ? "this section" : "these sections"} and will be removed from {toDelete.usedIn.length === 1 ? "it" : "them"}:</p>
                    <ul className="list-disc pl-5">{toDelete.usedIn.map((u) => <li key={u.sectionId}>{u.sectionTitle}</li>)}</ul>
                  </>
                ) : (
                  <p>It isn't used in any section.</p>
                )}
                <p>The file is deleted for good.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => { if (toDelete) library.remove.mutate({ id: toDelete.id, detach: toDelete.usedIn.length > 0 }); setToDelete(null); }}
              data-testid="button-confirm-delete-media"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export function MediaThumb({ item, className }: { item: Pick<MediaItem, "kind" | "url">; className?: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className={cn("relative overflow-hidden bg-muted/50", className)}>
      {failed ? (
        <span className="absolute inset-0 flex items-center justify-center text-muted-foreground"><ImageIcon className="h-5 w-5 opacity-50" /></span>
      ) : item.kind === "image" ? (
        <img src={item.url} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" onError={() => setFailed(true)} />
      ) : (
        <>
          <video src={`${item.url}#t=0.5`} preload="metadata" muted playsInline className="absolute inset-0 h-full w-full object-cover" onError={() => setFailed(true)} />
          <span className="absolute bottom-1 left-1 inline-flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white"><Film className="h-3 w-3" /> Video</span>
        </>
      )}
    </div>
  );
}

function PickCard({ item, disabled, selected, onToggle }: { item: MediaItem; disabled: boolean; selected: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onToggle}
      aria-pressed={selected}
      className={cn(
        "group relative rounded-lg border text-left overflow-hidden transition-colors disabled:opacity-40 disabled:cursor-not-allowed",
        selected ? "border-teal ring-2 ring-teal/40" : "border-border hover:border-teal/40",
      )}
      title={disabled ? "Already in this section" : item.originalName ?? undefined}
    >
      <MediaThumb item={item} className="aspect-[4/3]" />
      <span className={cn(
        "absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full border",
        selected ? "bg-teal border-teal text-teal-foreground" : "bg-black/40 border-white/70 text-transparent",
      )}>
        <Check className="h-3 w-3" />
      </span>
      <span className="block truncate px-2 py-1 text-[10px] text-muted-foreground">{item.caption || item.originalName || "Untitled"}</span>
    </button>
  );
}

function ManageCard({ item, library, onDelete }: { item: MediaItem; library: MediaLibraryApi; onDelete: () => void }) {
  const [caption, setCaption] = useState(item.caption);
  useEffect(() => setCaption(item.caption), [item.caption]);
  const saveCaption = () => {
    const c = caption.replace(/\s+/g, " ").trim();
    if (c !== item.caption) library.patch.mutate({ id: item.id, caption: c || null });
  };
  const deleting = library.remove.isPending && library.remove.variables?.id === item.id;
  return (
    <div className="rounded-lg border border-border overflow-hidden bg-card" data-testid={`media-card-${item.id}`}>
      <a href={item.url} target="_blank" rel="noreferrer" className="block" title="Open the full file">
        <MediaThumb item={item} className="aspect-[16/10]" />
      </a>
      <div className="p-2.5 space-y-2">
        <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
          <span className="truncate" title={item.originalName ?? undefined}>{item.originalName || (item.kind === "video" ? "Video" : "Photo")}</span>
          <span className="shrink-0 tabular-nums">
            {item.width && item.height ? `${item.width}×${item.height} · ` : ""}{formatBytes(item.size)}
          </span>
        </div>
        <Input
          value={caption}
          maxLength={300}
          onChange={(e) => setCaption(e.target.value)}
          onBlur={saveCaption}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          placeholder="Default caption (optional)"
          className="h-7 text-xs"
        />
        <BlindSafeSwitch
          id={`lib-blind-${item.id}`}
          checked={item.blindSafe}
          onChange={(v) => library.patch.mutate({ id: item.id, blindSafe: v })}
        />
        <div className="flex items-center justify-between gap-2 pt-0.5">
          <span className="text-[10px] text-muted-foreground truncate">
            {item.usedIn.length === 0 ? "Not used yet" : `Used in: ${item.usedIn.map((u) => u.sectionTitle).join(", ")}`}
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-1.5 text-[11px] text-red-500 hover:text-red-500 hover:bg-red-500/10 shrink-0"
            onClick={onDelete}
            disabled={deleting}
            aria-label="Delete file"
          >
            {deleting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
          </Button>
        </div>
      </div>
    </div>
  );
}
