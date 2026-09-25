/**
 * ImageGallery renderer — photos as an editorial grid or a slideshow, with
 * a full-screen lightbox. Uploaded photos load through /api/media/:id (the
 * view room adds its buyer token via CimMediaContext).
 *
 * Grid: 1 photo = a wide hero, 2 = a pair, 3 = one large + two stacked,
 * 4+ = an even grid (2–4 columns). Carousel: a large stage with arrows,
 * counter, swipe and a thumbnail strip; prints as a grid.
 * In the builder's editing view each photo carries a small chip saying
 * whether blind-CIM buyers see it.
 */
import { useState } from "react";
import { ChevronLeft, ChevronRight, EyeOff, ImageIcon, ImageOff, ShieldCheck } from "lucide-react";
import type { CimSection } from "@shared/schema";
import { normalizeGallery, type GalleryImage } from "@shared/cim-media";
import { cn } from "@/lib/utils";
import type { CimBranding } from "../CimBrandingContext";
import { useCimMedia } from "../CimMediaContext";
import { MediaLightbox, type LightboxImage } from "./MediaLightbox";

interface RendererProps {
  layoutData: Record<string, unknown>;
  content: string;
  branding: CimBranding;
  section: CimSection;
  brokerMode?: boolean;
}

interface Shown extends LightboxImage {
  key: string;
  mediaId?: string;
}

export function ImageGalleryRenderer({ layoutData, brokerMode }: RendererProps) {
  const media = useCimMedia();
  const data = normalizeGallery(layoutData);
  const [lightbox, setLightbox] = useState<number | null>(null);

  const images: Shown[] = data.images.map((img: GalleryImage, i) => ({
    key: `${img.mediaId ?? img.url}-${i}`,
    mediaId: img.mediaId,
    src: img.mediaId ? media.src(img.mediaId) : img.url!,
    caption: img.caption,
    alt: img.alt || img.caption || `Photo ${i + 1}`,
  }));

  if (images.length === 0) {
    return brokerMode ? (
      <div className="rounded-lg border border-dashed border-border bg-card/60 px-4 py-10 text-center">
        <ImageIcon className="mx-auto h-6 w-6 text-muted-foreground/60" />
        <p className="mt-2 text-sm text-muted-foreground">No photos yet</p>
        <p className="text-xs text-muted-foreground/70 mt-0.5">Add photos in the editor on the right.</p>
      </div>
    ) : null;
  }

  const badge = (img: Shown) => (brokerMode ? blindChip(img, media.assets) : null);
  // In the builder's editing view a click selects the section; buyers (and
  // buyer previews) get the full-screen viewer.
  const open = (i: number) => { if (!brokerMode) setLightbox(i); };

  return (
    <div>
      {data.title && (
        <h3 className="text-sm font-semibold text-foreground/60 uppercase tracking-widest mb-4">{data.title}</h3>
      )}
      {data.style === "carousel" && images.length > 1 ? (
        <>
          <Carousel images={images} onOpen={open} badge={badge} />
          <div className="hidden print:block">
            <Grid images={images} columns={data.columns} onOpen={open} badge={badge} />
          </div>
        </>
      ) : (
        <Grid images={images} columns={data.columns} onOpen={open} badge={badge} />
      )}
      <MediaLightbox images={images} index={lightbox} onIndexChange={setLightbox} />
    </div>
  );
}

/** Builder-only chip: does a blind-CIM buyer see this photo? */
function blindChip(img: Shown, assets: ReturnType<typeof useCimMedia>["assets"]) {
  const safe = img.mediaId ? !!assets?.get(img.mediaId)?.blindSafe : false;
  return (
    <span
      className={cn(
        "absolute left-2 top-2 z-10 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium shadow-sm backdrop-blur-sm",
        safe ? "bg-[#FEFDFB]/90 text-[#2E7D5B]" : "bg-[#201D18]/75 text-[#F5F1E6]",
      )}
      title={safe ? "Blind-CIM buyers see this photo" : "Blind-CIM buyers don't see this photo"}
    >
      {safe ? <ShieldCheck className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
      {safe ? "In blind CIM" : "Not in blind CIM"}
    </span>
  );
}

// ── Grid ────────────────────────────────────────────────────────────────

function Grid({
  images, columns, onOpen, badge,
}: { images: Shown[]; columns?: 2 | 3 | 4; onOpen: (i: number) => void; badge: (img: Shown) => React.ReactNode }) {
  if (images.length === 1) {
    return <Figure img={images[0]} onOpen={() => onOpen(0)} badge={badge(images[0])} frame="aspect-[16/9]" large />;
  }
  if (images.length === 3 && !columns) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-3 sm:grid-rows-2 gap-3">
        <div className="sm:col-span-2 sm:row-span-2">
          <Figure img={images[0]} onOpen={() => onOpen(0)} badge={badge(images[0])} frame="aspect-[4/3] sm:aspect-auto sm:h-full" fill large />
        </div>
        {images.slice(1).map((img, j) => (
          <Figure key={img.key} img={img} onOpen={() => onOpen(j + 1)} badge={badge(img)} frame="aspect-[4/3]" />
        ))}
      </div>
    );
  }
  const cols = columns ?? (images.length === 2 || images.length === 4 ? 2 : 3);
  return (
    <div
      className={cn(
        "grid gap-3",
        cols === 2 && "grid-cols-1 sm:grid-cols-2",
        cols === 3 && "grid-cols-2 sm:grid-cols-3",
        cols === 4 && "grid-cols-2 sm:grid-cols-4",
      )}
    >
      {images.map((img, i) => (
        <Figure key={img.key} img={img} onOpen={() => onOpen(i)} badge={badge(img)} frame="aspect-[4/3]" />
      ))}
    </div>
  );
}

function Figure({
  img, onOpen, badge, frame, large, fill,
}: { img: Shown; onOpen: () => void; badge: React.ReactNode; frame: string; large?: boolean; fill?: boolean }) {
  return (
    <figure className={cn("group", fill && "h-full flex flex-col")}>
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          "relative block w-full overflow-hidden rounded-lg border border-card-border bg-[#F2EEE3] focus:outline-none focus-visible:ring-2 focus-visible:ring-teal",
          frame,
          fill && "flex-1 min-h-0",
        )}
        aria-label={`Open photo${img.caption ? `: ${img.caption}` : ""}`}
      >
        {badge}
        <SafeImg src={img.src} alt={img.alt} className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]" />
      </button>
      {img.caption && (
        <figcaption className={cn("mt-2 text-muted-foreground leading-snug", large ? "text-sm" : "text-xs")}>{img.caption}</figcaption>
      )}
    </figure>
  );
}

function SafeImg({ src, alt, className }: { src: string; alt: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-[11px] text-muted-foreground">
        <ImageOff className="h-5 w-5 opacity-60" /> Photo unavailable
      </span>
    );
  }
  return <img src={src} alt={alt} loading="lazy" decoding="async" draggable={false} className={className} onError={() => setFailed(true)} />;
}

// ── Carousel ────────────────────────────────────────────────────────────

function Carousel({ images, onOpen, badge }: { images: Shown[]; onOpen: (i: number) => void; badge: (img: Shown) => React.ReactNode }) {
  const [i, setI] = useState(0);
  const [touchX, setTouchX] = useState<number | null>(null);
  const go = (d: number) => setI((x) => (x + d + images.length) % images.length);
  const img = images[i];
  return (
    <div className="print:hidden">
      <div
        className="group relative overflow-hidden rounded-lg border border-card-border bg-[#F2EEE3] aspect-[16/9]"
        onTouchStart={(e) => setTouchX(e.touches[0]?.clientX ?? null)}
        onTouchEnd={(e) => {
          const end = e.changedTouches[0]?.clientX;
          if (touchX != null && end != null && Math.abs(end - touchX) > 40) go(end < touchX ? 1 : -1);
          setTouchX(null);
        }}
      >
        {badge(img)}
        <button type="button" className="absolute inset-0 block w-full focus:outline-none" onClick={() => onOpen(i)} aria-label="Open photo full screen">
          <SafeImg key={img.key} src={img.src} alt={img.alt} className="absolute inset-0 h-full w-full object-cover animate-in fade-in duration-300" />
        </button>
        <StageButton side="left" onClick={() => go(-1)} />
        <StageButton side="right" onClick={() => go(1)} />
        <span className="absolute bottom-2 right-2 rounded-full bg-[#201D18]/70 px-2 py-0.5 text-[10px] font-medium tabular-nums text-[#F5F1E6]">
          {i + 1} / {images.length}
        </span>
      </div>
      <p className="mt-2 min-h-[1.25rem] text-sm text-muted-foreground leading-snug">{img.caption}</p>
      <div className="mt-2 flex gap-2 overflow-x-auto pb-1 scrollbar-thin" role="tablist" aria-label="Photos">
        {images.map((t, j) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={j === i}
            onClick={() => setI(j)}
            className={cn(
              "relative h-14 w-20 shrink-0 overflow-hidden rounded-md border-2 transition-opacity",
              j === i ? "border-teal opacity-100" : "border-transparent opacity-60 hover:opacity-100",
            )}
            aria-label={t.caption || `Photo ${j + 1}`}
          >
            <SafeImg src={t.src} alt="" className="absolute inset-0 h-full w-full object-cover" />
          </button>
        ))}
      </div>
    </div>
  );
}

function StageButton({ side, onClick }: { side: "left" | "right"; onClick: () => void }) {
  const Icon = side === "left" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "absolute top-1/2 -translate-y-1/2 flex h-9 w-9 items-center justify-center rounded-full bg-[#FEFDFB]/85 text-[#201D18] shadow-sm",
        "opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus:opacity-100 transition-opacity focus:outline-none focus-visible:ring-2 focus-visible:ring-teal",
        side === "left" ? "left-3" : "right-3",
      )}
      aria-label={side === "left" ? "Previous photo" : "Next photo"}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}
