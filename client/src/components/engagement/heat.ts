/**
 * The one heat scale of the engagement UI — a single-hue brass sequential
 * ramp (Obsidian & Brass; the old teal hsl(162…) grid is gone). Base
 * contract, shared by the viewer (overlay on the CIM paper) and the
 * intelligence UI (buyer strips). Never percent-of-max in words: the
 * legend reads in seconds.
 *
 *   heatPaper(t)  → an rgba for the overlay drawn ON the theme-locked paper
 *                   with mix-blend-mode: multiply (text stays readable):
 *                   transparent → pale brass → deep amber-red.
 *   heatChrome(t) → a colour for app chrome (strips, rails) that works on
 *                   both the dark and light app themes: the brass token at a
 *                   rising opacity.
 * t is 0–1 (the caller decides the scale: busiest block in the document,
 * or within the page). Values ≤ 0 are "no reading".
 */

/** Paper overlay stops (explicit hex: the CIM is theme-locked paper). */
export const HEAT_PAPER_STOPS = ["#F3E6C4", "#E7C27A", "#D18E3A", "#B4582A", "#8E2F1C"] as const;

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Overlay colour on paper for intensity t (0–1); null when there is nothing to draw. */
export function heatPaper(t: number): string | null {
  if (!(t > 0)) return null;
  const x = Math.min(1, t) * (HEAT_PAPER_STOPS.length - 1);
  const i = Math.min(HEAT_PAPER_STOPS.length - 2, Math.floor(x));
  const f = x - i;
  const [r1, g1, b1] = hexToRgb(HEAT_PAPER_STOPS[i]);
  const [r2, g2, b2] = hexToRgb(HEAT_PAPER_STOPS[i + 1]);
  const mix = (a: number, b: number) => Math.round(a + (b - a) * f);
  // Faint at the low end so light reading doesn't paint the whole page.
  const alpha = 0.18 + 0.62 * Math.min(1, t);
  return `rgba(${mix(r1, r2)}, ${mix(g1, g2)}, ${mix(b1, b2)}, ${alpha.toFixed(2)})`;
}

/** App-chrome colour for intensity t: the brass token (`--teal` holds brass) at a rising opacity. */
export function heatChrome(t: number): string {
  if (!(t > 0)) return "hsl(var(--muted))";
  return `hsl(var(--teal) / ${(0.15 + 0.85 * Math.min(1, t)).toFixed(2)})`;
}

/** Intensity of `ms` against the scale's maximum (0 when nothing was read). */
export function heatLevel(ms: number, maxMs: number): number {
  return maxMs > 0 && ms > 0 ? Math.min(1, ms / maxMs) : 0;
}
