/**
 * VideoEditor — paste a YouTube/Vimeo link (checked, with a live preview
 * before adding), upload a video, or reuse one from the library; title,
 * caption, order and the blind-safe switch per video.
 */
import { useState } from "react";
import { AlertTriangle, Film, Images, Link2, Youtube } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { MEDIA_LIMITS, parseVideoUrl } from "@shared/cim-media";
import { BlindSafeExplainer, BlindSafeSwitch } from "./BlindSafe";
import { MediaLibrary, MediaThumb } from "./MediaLibrary";
import { UploadDropzone } from "./UploadDropzone";
import { FieldLabel, RowActions, moveItem } from "./parts";
import type { MediaDraftChange, MediaItem, MediaLibraryApi } from "./api";

interface Vid { source?: string; url?: string; mediaId?: string; title?: string; caption?: string; blindSafe?: boolean }

interface Props {
  dealId: string;
  value: Record<string, any>;
  onChange: MediaDraftChange;
  library: MediaLibraryApi;
  disabled?: boolean;
}

export function VideoEditor({ dealId, value, onChange, library, disabled }: Props) {
  const items: Vid[] = Array.isArray(value.items) ? value.items : [];
  const setItems = (next: Vid[]) => onChange({ ...value, items: next });
  const [link, setLink] = useState("");
  const [pickOpen, setPickOpen] = useState(false);
  const parsed = link.trim() ? parseVideoUrl(link) : null;
  const linkError = link.trim().length > 6 && !parsed;
  const full = items.length >= MEDIA_LIMITS.videos;

  const addLink = () => {
    if (!parsed) return;
    setItems([...items, { source: parsed.source, url: parsed.watchUrl }]);
    setLink("");
  };
  const addFromLibrary = (picked: MediaItem[]) => {
    const have = new Set(items.map((i) => i.mediaId).filter(Boolean));
    const add = picked.filter((m) => m.kind === "video" && !have.has(m.id)).map((m) => ({ source: "upload", mediaId: m.id, caption: m.caption || undefined }));
    setItems([...items, ...add].slice(0, MEDIA_LIMITS.videos));
  };

  return (
    <div className="space-y-4">
      {!full && (
        <div className="space-y-2">
          <FieldLabel>Add a video</FieldLabel>
          <div className="flex gap-1.5">
            <div className="relative flex-1 min-w-0">
              <Link2 className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={link}
                disabled={disabled}
                onChange={(e) => setLink(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addLink(); } }}
                placeholder="Paste a YouTube or Vimeo link"
                className="h-8 pl-7 text-xs"
                aria-invalid={linkError}
                data-testid="input-video-url"
              />
            </div>
            <Button type="button" size="sm" className="h-8 text-xs bg-teal text-teal-foreground hover:bg-teal/90" disabled={!parsed || disabled} onClick={addLink} data-testid="button-add-video-url">
              Add
            </Button>
          </div>
          {linkError && (
            <p className="flex items-start gap-1 text-[11px] text-red-400">
              <AlertTriangle className="h-3 w-3 mt-px shrink-0" /> That isn't a YouTube or Vimeo video link. Copy the address from the video's page or its Share button.
            </p>
          )}
          {parsed && (
            <div className="space-y-1">
              <p className="text-[11px] text-muted-foreground">Preview — {parsed.source === "youtube" ? "YouTube" : "Vimeo"} (privacy-enhanced player)</p>
              <div className="relative aspect-video overflow-hidden rounded-md border border-border bg-black">
                <iframe
                  src={parsed.embedUrl}
                  title="Video preview"
                  referrerPolicy="strict-origin-when-cross-origin"
                  allow="encrypted-media; picture-in-picture; fullscreen"
                  className="absolute inset-0 h-full w-full border-0"
                />
              </div>
            </div>
          )}
          <UploadDropzone
            dealId={dealId}
            kind="video"
            multiple={false}
            compact
            disabled={disabled}
            onUploaded={(item) => {
              library.addUploaded(item);
              onChange((cur) => ({ ...cur, items: [...(Array.isArray(cur.items) ? cur.items : []), { source: "upload", mediaId: item.id }].slice(0, MEDIA_LIMITS.videos) }));
            }}
          />
          {library.items.some((m) => m.kind === "video") && (
            <Button type="button" size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => setPickOpen(true)} disabled={disabled}>
              <Images className="h-3.5 w-3.5" /> Choose from library
            </Button>
          )}
        </div>
      )}

      {items.length > 0 && (
        <>
          <BlindSafeExplainer video />
          <ul className="space-y-2">
            {items.map((it, i) => {
              const upload = it.source === "upload" || (!it.url && !!it.mediaId);
              const lib = upload && it.mediaId ? library.items.find((m) => m.id === it.mediaId) : undefined;
              const p = !upload ? parseVideoUrl(it.url) : null;
              const update = (patch: Partial<Vid>) => setItems(items.map((x, j) => (j === i ? { ...x, ...patch } : x)));
              return (
                <li key={`${it.mediaId ?? it.url}-${i}`} className="rounded-lg border border-border p-2 space-y-2">
                  <div className="flex items-center gap-2">
                    {upload && it.mediaId ? (
                      <MediaThumb item={{ kind: "video", url: `/api/media/${it.mediaId}` }} className="h-10 w-16 shrink-0 rounded" />
                    ) : (
                      <span className="flex h-10 w-16 shrink-0 items-center justify-center rounded bg-muted/60 text-muted-foreground">
                        {p?.source === "youtube" ? <Youtube className="h-4 w-4" /> : <Film className="h-4 w-4" />}
                      </span>
                    )}
                    <p className="flex-1 min-w-0 truncate text-[11px] text-muted-foreground" title={it.url}>
                      {upload ? lib?.originalName || "Uploaded video" : p ? `${p.source === "youtube" ? "YouTube" : "Vimeo"} · ${p.id}` : "Link not recognised"}
                    </p>
                    <RowActions index={i} count={items.length} noun="video" disabled={disabled} onMove={(a, b) => setItems(moveItem(items, a, b))} onRemove={() => setItems(items.filter((_, j) => j !== i))} />
                  </div>
                  <Input value={it.title ?? ""} maxLength={MEDIA_LIMITS.titleChars} disabled={disabled} onChange={(e) => update({ title: e.target.value })} placeholder="Title (optional), e.g. “A walk through the clinic”" className="h-8 text-xs" />
                  <Input value={it.caption ?? ""} maxLength={MEDIA_LIMITS.captionChars} disabled={disabled} onChange={(e) => update({ caption: e.target.value })} placeholder="Caption (optional)" className="h-8 text-xs" />
                  {upload ? (
                    lib ? (
                      <BlindSafeSwitch id={`vid-blind-${i}`} checked={lib.blindSafe} onChange={(v) => library.patch.mutate({ id: lib.id, blindSafe: v })} disabled={disabled} />
                    ) : !library.query.isLoading ? (
                      <p className="text-[11px] text-amber-500">This video was deleted from the library — remove it here.</p>
                    ) : null
                  ) : (
                    <BlindSafeSwitch id={`vid-blind-${i}`} checked={it.blindSafe === true} onChange={(v) => update({ blindSafe: v || undefined })} disabled={disabled} />
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}

      <Dialog open={pickOpen} onOpenChange={setPickOpen}>
        <DialogContent className="max-w-2xl w-[calc(100vw-2rem)] max-h-[88vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add a video from the library</DialogTitle>
            <DialogDescription>Videos uploaded for this deal.</DialogDescription>
          </DialogHeader>
          <MediaLibrary
            dealId={dealId}
            library={library}
            mode="pick"
            kind="video"
            exclude={items.map((i) => i.mediaId).filter((x): x is string => !!x)}
            onPick={(picked) => { addFromLibrary(picked); setPickOpen(false); }}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
