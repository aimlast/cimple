/**
 * Video renderer — YouTube / Vimeo in their privacy-enhanced players
 * (youtube-nocookie, Vimeo "do not track"), or an uploaded video played
 * from /api/media/:id. One video fills the width; several sit two-up.
 */
import { EyeOff, Film, PlayCircle, ShieldCheck } from "lucide-react";
import type { CimSection } from "@shared/schema";
import { normalizeVideo, parseVideoUrl, type VideoItem } from "@shared/cim-media";
import { cn } from "@/lib/utils";
import type { CimBranding } from "../CimBrandingContext";
import { useCimMedia } from "../CimMediaContext";

interface RendererProps {
  layoutData: Record<string, unknown>;
  content: string;
  branding: CimBranding;
  section: CimSection;
  brokerMode?: boolean;
}

export function VideoRenderer({ layoutData, brokerMode }: RendererProps) {
  const media = useCimMedia();
  const data = normalizeVideo(layoutData);

  if (data.items.length === 0) {
    return brokerMode ? (
      <div className="rounded-lg border border-dashed border-border bg-card/60 px-4 py-10 text-center">
        <Film className="mx-auto h-6 w-6 text-muted-foreground/60" />
        <p className="mt-2 text-sm text-muted-foreground">No video yet</p>
        <p className="text-xs text-muted-foreground/70 mt-0.5">Paste a YouTube or Vimeo link, or upload a video, in the editor.</p>
      </div>
    ) : null;
  }

  const blindSafe = (it: VideoItem) =>
    it.source === "upload" ? (it.mediaId ? !!media.assets?.get(it.mediaId)?.blindSafe : false) : it.blindSafe === true;

  return (
    <div>
      {data.title && (
        <h3 className="text-sm font-semibold text-foreground/60 uppercase tracking-widest mb-4">{data.title}</h3>
      )}
      <div className={cn("grid gap-6", data.items.length > 1 && "sm:grid-cols-2")}>
        {data.items.map((it, i) => (
          <figure key={`${it.mediaId ?? it.url}-${i}`} className="min-w-0">
            {it.title && <p className="mb-2 text-sm font-semibold text-foreground leading-snug">{it.title}</p>}
            <div className="relative overflow-hidden rounded-lg border border-card-border bg-[#191713] aspect-video">
              {brokerMode && <BlindChip safe={blindSafe(it)} />}
              <Player item={it} src={it.mediaId ? media.src(it.mediaId) : undefined} />
            </div>
            {it.caption && <figcaption className="mt-2 text-xs text-muted-foreground leading-snug">{it.caption}</figcaption>}
            <p className="hidden print:block mt-1 text-[11px] text-muted-foreground">Video — watch it in the online CIM.</p>
          </figure>
        ))}
      </div>
    </div>
  );
}

function Player({ item, src }: { item: VideoItem; src?: string }) {
  if (item.source === "upload") {
    if (!src) return null;
    return (
      <video
        controls
        preload="metadata"
        playsInline
        controlsList="nodownload"
        className="absolute inset-0 h-full w-full bg-black object-contain print:hidden"
        src={src}
      >
        Your browser can't play this video.
      </video>
    );
  }
  const parsed = parseVideoUrl(item.url);
  if (!parsed) {
    return (
      <span className="absolute inset-0 flex items-center justify-center text-xs text-[#F5F1E6]/60">
        <PlayCircle className="h-5 w-5 mr-1.5" /> Video unavailable
      </span>
    );
  }
  return (
    <iframe
      src={parsed.embedUrl}
      title={item.title || (parsed.source === "youtube" ? "YouTube video" : "Vimeo video")}
      loading="lazy"
      // Helmet's page-wide no-referrer breaks YouTube's player (error 153).
      referrerPolicy="strict-origin-when-cross-origin"
      allow="accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen"
      allowFullScreen
      className="absolute inset-0 h-full w-full border-0 print:hidden"
    />
  );
}

function BlindChip({ safe }: { safe: boolean }) {
  return (
    <span
      className={cn(
        "absolute left-2 top-2 z-10 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium shadow-sm pointer-events-none",
        safe ? "bg-[#FEFDFB]/90 text-[#2E7D5B]" : "bg-[#201D18]/80 text-[#F5F1E6]",
      )}
    >
      {safe ? <ShieldCheck className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
      {safe ? "In blind CIM" : "Not in blind CIM"}
    </span>
  );
}
