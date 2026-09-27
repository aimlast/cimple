/**
 * HTML safety for Cimple's emails.
 *
 * Notification bodies are built by string interpolation, and several carry
 * text typed by people outside the brokerage — a buyer's question, a
 * seller's typed signature, a buyer's name or background. Interpolated raw,
 * a buyer could put a working link ("Your Cimple session expired — sign in")
 * inside an email sent from notifications@cimple.ca.
 *
 *   escapeHtml(text)            — for any single interpolated value.
 *   sanitizeEmailFragment(html) — for a whole notify() body: keeps only the
 *     plain formatting tags our templates use (<strong>, <em>, <br/>, …,
 *     with no attributes) and shows everything else as text. It backs up
 *     every notify() caller, including ones that forget to escape.
 */

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const SAFE_TAG = /^<\s*(\/?)\s*(strong|em|b|i|u|br|p|ul|ol|li)\s*(\/?)\s*>$/i;

export function sanitizeEmailFragment(html: string): string {
  return String(html ?? "")
    .split(/(<[^<>]*>)/g)
    .map((part) => {
      if (!part) return part;
      const tag = part.match(SAFE_TAG);
      if (tag) return `<${tag[1]}${tag[2].toLowerCase()}${tag[3] ? "/" : ""}>`;
      // Text (or a tag we don't allow): shown literally. Existing entities
      // (&amp; from callers that escaped) are left as they are.
      return part.replace(/</g, "&lt;").replace(/>/g, "&gt;");
    })
    .join("");
}
