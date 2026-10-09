/**
 * "What the eye can't see doesn't get through" (vdr spec V19, §9.5): text a
 * PDF still carries but no reader can see — words under a black box drawn
 * in a PDF editor, white-on-white text — is found from the RENDERED page and
 * left out of page text, search and located figures.
 *
 * For a box on the rendered page (measured BEFORE Cimple draws its own
 * covers): the share of dark pixels (luminance < 60) and light pixels
 * (> 200). Covered: dark ≥ 98% and light ≤ 1%. Invisible: light ≥ 99.5%.
 * (Spike: text under a drawn box 100% / 0%; white text on a dark header band
 * 76% / 15% — correctly not hidden; normal text 13.5% dark; white-on-white
 * 0% / 100%.) Pure over an RGBA buffer, so it is unit-testable.
 */

export type PixelBox = { x0: number; y0: number; x1: number; y1: number };

export function boxShares(data: Uint8ClampedArray | Uint8Array, width: number, height: number, box: PixelBox): { dark: number; light: number; n: number } {
  const x0 = Math.max(0, Math.floor(Math.min(box.x0, box.x1)));
  const x1 = Math.min(width, Math.ceil(Math.max(box.x0, box.x1)));
  const y0 = Math.max(0, Math.floor(Math.min(box.y0, box.y1)));
  const y1 = Math.min(height, Math.ceil(Math.max(box.y0, box.y1)));
  let dark = 0, light = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    let i = (y * width + x0) * 4;
    for (let x = x0; x < x1; x++, i += 4) {
      const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      n++;
      if (lum < 60) dark++;
      else if (lum > 200) light++;
    }
  }
  return n === 0 ? { dark: 0, light: 0, n: 0 } : { dark: dark / n, light: light / n, n };
}

export function isHiddenBox(data: Uint8ClampedArray | Uint8Array, width: number, height: number, box: PixelBox): boolean {
  const s = boxShares(data, width, height, box);
  if (s.n < 4) return false;
  return (s.dark >= 0.98 && s.light <= 0.01) || s.light >= 0.995;
}

/** Non-space characters in a string. */
export function visibleChars(s: string): number {
  return s.replace(/\s/g, "").length;
}

/**
 * Which parts of one text piece can't be seen. The whole piece first; if it
 * is visible as a whole, each word of 3+ characters is checked on its own
 * (positions estimated proportionally, narrowed by 15% each side so a
 * neighbouring word's pixels don't count), so a box over a name in the middle
 * of a sentence still drops that name. Returns the visible text (hidden words
 * removed) and how many hidden spans were dropped.
 */
export function visiblePart(
  str: string,
  box: PixelBox,
  data: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): { text: string; hiddenSpans: number } {
  if (visibleChars(str) < 3) return { text: str, hiddenSpans: 0 };
  if (isHiddenBox(data, width, height, box)) return { text: "", hiddenSpans: 1 };
  const len = str.length;
  if (len < 2) return { text: str, hiddenSpans: 0 };
  const w = box.x1 - box.x0;
  const out: string[] = [];
  let spans = 0;
  let inHidden = false;
  const re = /\S+|\s+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(str))) {
    const word = m[0];
    if (/^\s+$/.test(word) || visibleChars(word) < 3) {
      out.push(word);
      if (!/^\s+$/.test(word)) inHidden = false;
      continue;
    }
    const a = box.x0 + (w * m.index) / len;
    const b = box.x0 + (w * (m.index + word.length)) / len;
    const pad = (b - a) * 0.15;
    const hidden = isHiddenBox(data, width, height, { x0: a + pad, x1: b - pad, y0: box.y0, y1: box.y1 });
    if (hidden) {
      if (!inHidden) spans++;
      inHidden = true;
    } else {
      inHidden = false;
      out.push(word);
    }
  }
  if (spans === 0) return { text: str, hiddenSpans: 0 };
  return { text: out.join("").replace(/\s{2,}/g, " "), hiddenSpans: spans };
}
