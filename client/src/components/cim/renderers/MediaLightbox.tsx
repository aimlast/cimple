/**
 * MediaLightbox — full-screen photo viewer for CIM galleries.
 * Esc closes, ← / → move, swipe on touch screens. Rendered in a portal so
 * the paper sheet's overflow never clips it.
 */
import { useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, X } from "lucide-react";

export interface LightboxImage {
  src: string;
  caption?: string;
  alt: string;
}

interface Props {
  images: LightboxImage[];
  index: number | null;
  onIndexChange: (i: number | null) => void;
}

export function MediaLightbox({ images, index, onIndexChange }: Props) {
  const open = index !== null && index >= 0 && index < images.length;
  const closeRef = useRef<HTMLButtonElement>(null);
  const touchX = useRef<number | null>(null);

  const go = useCallback(
    (delta: number) => {
      if (index === null || images.length < 2) return;
      onIndexChange((index + delta + images.length) % images.length);
    },
    [index, images.length, onIndexChange],
  );

  useEffect(() => {
    if (!open) return;
    const prevFocus = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onIndexChange(null);
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      prevFocus?.focus?.();
    };
  }, [open, go, onIndexChange]);

  if (!open || index === null) return null;
  const img = images[index];

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={img.caption || "Photo"}
      className="fixed inset-0 z-[45] flex flex-col text-[#F5F1E6] print:hidden"
      style={{ backgroundColor: "rgba(14, 13, 11, 0.96)" }}
      onClick={() => onIndexChange(null)}
      onTouchStart={(e) => { touchX.current = e.touches[0]?.clientX ?? null; }}
      onTouchEnd={(e) => {
        const start = touchX.current;
        touchX.current = null;
        const end = e.changedTouches[0]?.clientX;
        if (start == null || end == null || Math.abs(end - start) < 50) return;
        go(end < start ? 1 : -1);
      }}
    >
      <div className="flex items-center justify-between gap-3 px-4 py-3 shrink-0" onClick={(e) => e.stopPropagation()}>
        <span className="text-xs tabular-nums text-[#F5F1E6]/60">
          {images.length > 1 ? `${index + 1} / ${images.length}` : ""}
        </span>
        <button
          ref={closeRef}
          type="button"
          onClick={() => onIndexChange(null)}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 hover:bg-white/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#C9A45C]"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="relative flex-1 min-h-0 flex items-center justify-center px-2 sm:px-16">
        <img
          src={img.src}
          alt={img.alt}
          className="max-h-full max-w-full object-contain select-none rounded-sm shadow-2xl"
          onClick={(e) => e.stopPropagation()}
          draggable={false}
        />
        {images.length > 1 && (
          <>
            <NavButton side="left" onClick={() => go(-1)} />
            <NavButton side="right" onClick={() => go(1)} />
          </>
        )}
      </div>
      <div className="shrink-0 px-6 py-4 min-h-[56px] text-center" onClick={(e) => e.stopPropagation()}>
        {img.caption && <p className="text-sm text-[#F5F1E6]/85 max-w-2xl mx-auto leading-relaxed">{img.caption}</p>}
      </div>
    </div>,
    document.body,
  );
}

function NavButton({ side, onClick }: { side: "left" | "right"; onClick: () => void }) {
  const Icon = side === "left" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className={`absolute top-1/2 -translate-y-1/2 ${side === "left" ? "left-2 sm:left-4" : "right-2 sm:right-4"} flex h-11 w-11 items-center justify-center rounded-full bg-white/10 hover:bg-white/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#C9A45C]`}
      aria-label={side === "left" ? "Previous photo" : "Next photo"}
    >
      <Icon className="h-5 w-5" />
    </button>
  );
}
