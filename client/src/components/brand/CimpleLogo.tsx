/**
 * The Cimple brand is two separate pieces that are NEVER shown side by side
 * (founder, 2026-10-09):
 *   CimpleMark      the icon — only on the collapsed broker sidebar rail
 *                   (the tab icons are static files: client/public/favicon*.{svg,png})
 *   CimpleWordmark  the word "cimple" — everywhere the name has room
 * There is deliberately no combined lockup component. tests/unit/brand-lockup.test.ts fails if
 * any file other than app-sidebar.tsx (where the two swap by state) renders both, if anything
 * else renders the mark, or if /cimple-icon.png or /cimple-text.png is used outside this file.
 *
 * Both are display:block (no line-box strut, so a link around one is exactly as tall as the
 * logo) and max-w-none (never squeezed by a narrow parent). Set the height with an h-* class;
 * the width follows from the artwork's proportions.
 *
 * The PNG artwork is cream #FCF8EB with its edge smoothing baked in for black backgrounds.
 *   CimpleMark                   → the artwork itself (only ever on the black rail)
 *   CimpleWordmark tone="cream"  → the artwork itself, for surfaces that are black in both
 *                                  themes (the broker sidebar and its phone bar)
 *   CimpleWordmark tone="auto"   → the artwork as a mask filled with the surrounding text colour
 *                                  (cream on dark pages, ink on light pages). The default.
 */
import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

const MARK_SRC = "/cimple-icon.png"; // 167×213
const WORDMARK_SRC = "/cimple-text.png"; // 517×144
const IMG_BASE = "block w-auto max-w-none shrink-0 select-none";

interface BrandProps {
  className?: string;
  /** true when a surrounding link already names it ("Cimple — dashboard") */
  decorative?: boolean;
}

export function CimpleMark({ className, decorative }: BrandProps) {
  return (
    <img
      src={MARK_SRC}
      alt={decorative ? "" : "Cimple"}
      aria-hidden={decorative || undefined}
      draggable={false}
      data-brand="mark"
      className={cn(IMG_BASE, className)}
    />
  );
}

export function CimpleWordmark({
  className,
  decorative,
  tone = "auto",
}: BrandProps & { tone?: "auto" | "cream" }) {
  if (tone === "cream") {
    return (
      <img
        src={WORDMARK_SRC}
        alt={decorative ? "" : "Cimple"}
        aria-hidden={decorative || undefined}
        draggable={false}
        data-brand="wordmark"
        className={cn(IMG_BASE, className)}
      />
    );
  }
  const a11y = decorative
    ? { "aria-hidden": true as const }
    : { role: "img", "aria-label": "Cimple" };
  const style: CSSProperties = {
    aspectRatio: "517 / 144",
    backgroundColor: "currentColor",
    WebkitMaskImage: `url('${WORDMARK_SRC}')`,
    maskImage: `url('${WORDMARK_SRC}')`,
    WebkitMaskSize: "contain",
    maskSize: "contain",
    WebkitMaskRepeat: "no-repeat",
    maskRepeat: "no-repeat",
    WebkitMaskPosition: "center",
    maskPosition: "center",
  };
  return (
    <span
      data-brand="wordmark"
      {...a11y}
      className={cn("block max-w-none shrink-0 select-none text-foreground", className)}
      style={style}
    />
  );
}
