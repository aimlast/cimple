/**
 * The renderer canary's built-in PDF (vdr spec §9.2, `/api/vdr/health`).
 *
 * Built in code (never a runtime data file: the esbuild bundle ships no data
 * files under server/vdr). One 300 × 200 pt page: a line of text in the
 * standard Helvetica font (so pdf.js must find its bundled standard fonts)
 * and a solid black box (so the rendered image must contain ink exactly
 * there). The xref offsets are computed, so the file is well-formed.
 */

export const CANARY_TEXT = "Cimple renderer check";

/** Page size in PDF points, and the black box's rectangle (PDF coordinates: origin bottom-left). */
export const CANARY_PAGE = { width: 300, height: 200 } as const;
export const CANARY_BOX = { x: 24, y: 40, w: 120, h: 60 } as const;
/** The baseline and size of the text line (PDF coordinates). */
export const CANARY_TEXT_POS = { x: 24, y: 150, size: 18 } as const;

export function canaryPdfBytes(): Uint8Array {
  const content = [
    `BT /F1 ${CANARY_TEXT_POS.size} Tf ${CANARY_TEXT_POS.x} ${CANARY_TEXT_POS.y} Td (${CANARY_TEXT}) Tj ET`,
    `0 0 0 rg ${CANARY_BOX.x} ${CANARY_BOX.y} ${CANARY_BOX.w} ${CANARY_BOX.h} re f`,
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${CANARY_PAGE.width} ${CANARY_PAGE.height}] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  // Every character is ASCII, so string offsets are byte offsets.
  return new TextEncoder().encode(out);
}

/** What the canary's measurements must show for the renderer to count as working. */
export type CanaryMeasurements = {
  pages: number;
  text: string;
  image: { width: number; height: number; bytes: number; magicOk: boolean };
  ink: { box: number; text: number; outside: number };
  modules: Record<string, string>;
};

/** "ok", or the first plain reason the canary failed. Pure (the web process judges what the child measured). */
export function judgeCanary(m: CanaryMeasurements): "ok" | string {
  if (m.pages !== 1) return `the test PDF opened with ${m.pages} pages instead of 1`;
  if (m.text.replace(/\s+/g, " ").trim() !== CANARY_TEXT) return "the test PDF's text didn't come out";
  if (!m.image.magicOk || m.image.bytes < 500) return "the page image wasn't a JPEG";
  if (m.image.width !== 700) return `the page image is ${m.image.width} px wide instead of 700`;
  if (!(m.ink.box >= 0.9)) return "the black box didn't render";
  if (!(m.ink.text >= 0.01)) return "the text didn't render (fonts missing?)";
  if (!(m.ink.outside <= 0.01)) return "ink where the page is blank";
  for (const [name, status] of Object.entries(m.modules)) if (status !== "ok") return status || `${name} failed`;
  return "ok";
}
