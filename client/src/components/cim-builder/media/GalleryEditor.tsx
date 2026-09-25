/**
 * GalleryEditor — the photo gallery's inspector: upload (drag & drop with
 * progress), pick from the deal's library, add from a web address, reorder,
 * caption, and the per-photo "Safe to show in the blind CIM" switch.
 *
 * Edits go into the section draft (the page previews them at once); the
 * blind-safe switch belongs to the photo itself, so it saves immediately
 * and applies wherever that photo is used.
 */
import { useState } from "react";
import { Globe, Images, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { MEDIA_LIMITS, safeHttpsUrl } from "@shared/cim-media";
import { BlindSafeExplainer, BlindSafeSwitch } from "./BlindSafe";
import { MediaLibrary, MediaThumb } from "./MediaLibrary";
import { UploadDropzone } from "./UploadDropzone";
import { FieldLabel, RowActions, Segmented, moveItem } from "./parts";
import type { MediaDraftChange, MediaItem, MediaLibraryApi } from "./api";

interface Img { mediaId?: string; url?: string; caption?: string; alt?: string }

interface Props {
  dealId: string;
  value: Record<string, any>;
  onChange: MediaDraftChange;
  library: MediaLibraryApi;
  disabled?: boolean;
}

export function GalleryEditor({ dealId, value, onChange, library, disabled }: Props) {
  const images: Img[] = Array.isArray(value.images) ? value.images : [];
  const setImages = (next: Img[]) => onChange({ ...value, images: next });
  const [pickOpen, setPickOpen] = useState(false);
  const [webOpen, setWebOpen] = useState(false);
  const full = images.length >= MEDIA_LIMITS.galleryImages;

  const addFromLibrary = (items: MediaItem[]) => {
    const have = new Set(images.map((i) => i.mediaId).filter(Boolean));
    const add = items.filter((m) => m.kind === "image" && !have.has(m.id)).map((m) => ({ mediaId: m.id, caption: m.caption || undefined }));
    setImages([...images, ...add].slice(0, MEDIA_LIMITS.galleryImages));
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <FieldLabel>Style</FieldLabel>
        <Segmented
          value={value.style === "carousel" ? "carousel" : "grid"}
          options={[{ key: "grid", label: "Grid" }, { key: "carousel", label: "Slideshow" }]}
          onChange={(style) => onChange({ ...value, style })}
          disabled={disabled}
        />
        {value.style !== "carousel" && images.length > 3 && (
          <Segmented
            value={String(value.columns ?? "auto")}
            options={[{ key: "auto", label: "Auto" }, { key: "2", label: "2 across" }, { key: "3", label: "3 across" }, { key: "4", label: "4 across" }]}
            onChange={(c) => onChange({ ...value, columns: c === "auto" ? undefined : Number(c) })}
            disabled={disabled}
          />
        )}
      </div>

      <div className="space-y-2">
        <FieldLabel>Photos ({images.length})</FieldLabel>
        {!full && (
          <UploadDropzone
            dealId={dealId}
            kind="image"
            compact={images.length > 0}
            disabled={disabled}
            onUploaded={(item) => {
              library.addUploaded(item);
              // Uploads finish later, after other edits — append to the latest draft.
              onChange((cur) => ({ ...cur, images: [...(Array.isArray(cur.images) ? cur.images : []), { mediaId: item.id }].slice(0, MEDIA_LIMITS.galleryImages) }));
            }}
          />
        )}
        <div className="flex flex-wrap gap-1.5">
          <Button type="button" size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => setPickOpen(true)} disabled={disabled || full}>
            <Images className="h-3.5 w-3.5" /> Choose from library
          </Button>
          <Button type="button" size="sm" variant="ghost" className="h-7 text-xs gap-1 text-muted-foreground" onClick={() => setWebOpen((o) => !o)} disabled={disabled || full}>
            <Globe className="h-3.5 w-3.5" /> From a web address
          </Button>
        </div>
        {webOpen && <WebImageInput onAdd={(url) => { setImages([...images, { url }]); setWebOpen(false); }} />}
      </div>

      {images.length > 0 && (
        <>
          <BlindSafeExplainer />
          <ul className="space-y-2">
            {images.map((img, i) => {
              const item = img.mediaId ? library.items.find((m) => m.id === img.mediaId) : undefined;
              const thumbSrc = img.mediaId ? `/api/media/${img.mediaId}` : img.url!;
              return (
                <li key={`${img.mediaId ?? img.url}-${i}`} className="rounded-lg border border-border p-2 space-y-2">
                  <div className="flex items-center gap-2">
                    <MediaThumb item={{ kind: "image", url: thumbSrc }} className="h-12 w-16 shrink-0 rounded" />
                    <p className="flex-1 min-w-0 truncate text-[11px] text-muted-foreground" title={item?.originalName ?? img.url}>
                      {img.mediaId ? item?.originalName || `Photo ${i + 1}` : `From ${safeHost(img.url)}`}
                    </p>
                    <RowActions index={i} count={images.length} noun="photo" disabled={disabled} onMove={(a, b) => setImages(moveItem(images, a, b))} onRemove={() => setImages(images.filter((_, j) => j !== i))} />
                  </div>
                  <Input
                    value={img.caption ?? ""}
                    maxLength={MEDIA_LIMITS.captionChars}
                    disabled={disabled}
                    onChange={(e) => setImages(images.map((x, j) => (j === i ? { ...x, caption: e.target.value } : x)))}
                    placeholder="Caption (optional)"
                    className="h-8 text-xs"
                    aria-label={`Caption for photo ${i + 1}`}
                  />
                  {img.mediaId ? (
                    item ? (
                      <BlindSafeSwitch id={`gal-blind-${i}`} checked={item.blindSafe} onChange={(v) => library.patch.mutate({ id: item.id, blindSafe: v })} disabled={disabled} />
                    ) : library.query.isLoading ? (
                      <p className="flex items-center gap-1 text-[11px] text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> Loading…</p>
                    ) : (
                      <p className="text-[11px] text-amber-500">This photo was deleted from the library — remove it here.</p>
                    )
                  ) : (
                    <BlindSafeSwitch id={`gal-blind-${i}`} checked={false} disabledReason="A photo from a web address is never shown in the blind CIM — its address can name the business. Upload it instead." />
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
            <DialogTitle>Add photos from the library</DialogTitle>
            <DialogDescription>Everything uploaded for this deal. Pick the photos for this section, or upload new ones.</DialogDescription>
          </DialogHeader>
          <MediaLibrary
            dealId={dealId}
            library={library}
            mode="pick"
            kind="image"
            exclude={images.map((i) => i.mediaId).filter((x): x is string => !!x)}
            onPick={(items) => { addFromLibrary(items); setPickOpen(false); }}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function safeHost(url?: string): string {
  try { return url ? new URL(url).hostname.replace(/^www\./, "") : "the web"; } catch { return "the web"; }
}

function WebImageInput({ onAdd }: { onAdd: (url: string) => void }) {
  const [url, setUrl] = useState("");
  const [state, setState] = useState<"idle" | "checking" | "bad">("idle");
  const check = () => {
    const safe = safeHttpsUrl(url);
    if (!safe) return setState("bad");
    setState("checking");
    const img = new Image();
    img.onload = () => { setState("idle"); setUrl(""); onAdd(safe); };
    img.onerror = () => setState("bad");
    img.src = safe;
  };
  return (
    <div className="space-y-1">
      <div className="flex gap-1.5">
        <Input value={url} onChange={(e) => { setUrl(e.target.value); setState("idle"); }} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), check())} placeholder="https://…/photo.jpg" className="h-8 text-xs" />
        <Button type="button" size="sm" className="h-8 text-xs" onClick={check} disabled={!url.trim() || state === "checking"}>
          {state === "checking" ? <Loader2 className="h-3 w-3 animate-spin" /> : "Add"}
        </Button>
      </div>
      <p className={state === "bad" ? "text-[11px] text-red-400" : "text-[11px] text-muted-foreground"}>
        {state === "bad" ? "That address didn't load as an image. Use a full https:// link to the picture itself." : "Shown in the named CIM only — never in the blind CIM."}
      </p>
    </div>
  );
}
