/**
 * cim-prose — how CIM free text splits into paragraphs, lists and headings.
 *
 * Pure (server + client). The renderers draw these blocks (client
 * richText.renderProse) and the reading registry (shared/cim-blocks.ts)
 * names them ("para:0", "para:1"…), so both must split text the same way —
 * which is why the parser lives here and richText re-exports it.
 */

const LEGACY_DD_TAG = /\[DD(?::\s*[^\]]*)?\]\s*/g;
const INLINE_BULLET = /\s+[•·]\s+/;
const BULLET_LINE = /^\s*(?:[-*•·–]|•)\s+/;
const NUMBERED_LINE = /^\s*\d+[.)]\s+/;
const HEADING_LINE = /^\s*#{1,6}\s+/;

export type ProseBlock =
  | { kind: "p"; text: string }
  | { kind: "h"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] };

/** Turn free text into blocks: blank-line paragraphs, bullet/numbered lists, headings, inline "•" runs. */
export function parseProseBlocks(text: string): ProseBlock[] {
  if (!text) return [];
  const blocks: ProseBlock[] = [];
  const chunks = text.replace(LEGACY_DD_TAG, "").replace(/\r\n/g, "\n").split(/\n\s*\n/);
  for (const chunk of chunks) {
    const lines = chunk.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim().length > 0);
    if (lines.length === 0) continue;
    let para: string[] = [];
    const flushPara = () => {
      if (para.length === 0) return;
      const joined = para.join(" ");
      // "Point one • Point two • Point three" inside one paragraph → bullets.
      // "Key points: • A • B" keeps the intro as its own line above the list.
      const inlineParts = joined.split(INLINE_BULLET).map((s) => s.trim()).filter(Boolean);
      if (inlineParts.length >= 3) {
        const [first, ...rest] = inlineParts;
        if (/[:：]$/.test(first)) {
          blocks.push({ kind: "p", text: first });
          blocks.push({ kind: "ul", items: rest });
        } else {
          blocks.push({ kind: "ul", items: inlineParts });
        }
      } else {
        blocks.push({ kind: "p", text: joined.replace(/^\s*[•·]\s*/, "") });
      }
      para = [];
    };
    let list: ProseBlock | null = null;
    const flushList = () => { if (list) { blocks.push(list); list = null; } };
    for (const line of lines) {
      if (HEADING_LINE.test(line)) {
        flushPara(); flushList();
        blocks.push({ kind: "h", text: line.replace(HEADING_LINE, "").trim() });
      } else if (BULLET_LINE.test(line)) {
        flushPara();
        if (!list || list.kind !== "ul") { flushList(); list = { kind: "ul", items: [] }; }
        list.items.push(line.replace(BULLET_LINE, "").trim());
      } else if (NUMBERED_LINE.test(line)) {
        flushPara();
        if (!list || list.kind !== "ol") { flushList(); list = { kind: "ol", items: [] }; }
        list.items.push(line.replace(NUMBERED_LINE, "").trim());
      } else {
        flushList();
        para.push(line.trim());
      }
    }
    flushPara(); flushList();
  }
  return blocks;
}

/** Plain words of a prose block (for reading-time estimates and labels). */
export function proseBlockText(block: ProseBlock): string {
  return block.kind === "p" || block.kind === "h" ? block.text : block.items.join(" ");
}
