/**
 * richText — the small text pass every CIM renderer runs free text through.
 *
 * The layout engine is told to emit plain text, but models still slip in
 * markdown ("**Lease Term:**", inline "•" bullets, "## Heading"), and the DD
 * enrichment engine marks newly revealed spans with a sentinel pair
 * (`[[dd]]…[[/dd]]`). Buyers must never see either literally, so:
 *
 *   renderInline(text)  → bold / DD-highlight aware inline nodes
 *   renderProse(text)   → paragraphs, bullet lists, numbered lists, headings
 *   stripMarkup(text)   → plain string for labels, values, chart names
 *   sanitizeLayoutData  → deep-walk a section's layoutData: prose fields keep
 *                         their markup (renderers highlight it), every other
 *                         string is flattened to plain text so nothing raw
 *                         leaks into a chart label or metric value.
 *
 * DD highlight: spans wrapped in `[[dd]]…[[/dd]]` render as a brass-tinted
 * <mark> so a buyer on the due-diligence version can see what is new. The
 * legacy literal "[DD]" prefix (older overrides) is stripped.
 */
import { Fragment, type ReactNode } from "react";

export const DD_OPEN = "[[dd]]";
export const DD_CLOSE = "[[/dd]]";

/** Keys whose string values are free text a renderer passes through renderInline/renderProse. */
const PROSE_KEYS = new Set([
  "body", "description", "caption", "footnote", "footnotes", "notes", "pullQuote",
  "highlights", "summary", "tagline", "content", "normalizedCaption", "normalizedFootnotes",
  "ownerDependency",
]);

const LEGACY_DD_TAG = /\[DD\]\s*/g;
const DD_MARK = /\[\[\/?dd\]\]/g;
const BOLD = /\*\*(.+?)\*\*|__(.+?)__/g;
const INLINE_BULLET = /\s+[•·]\s+/;
const BULLET_LINE = /^\s*(?:[-*•·–]|•)\s+/;
const NUMBERED_LINE = /^\s*\d+[.)]\s+/;
const HEADING_LINE = /^\s*#{1,6}\s+/;

/** Plain text: markdown markers and DD sentinels removed, legacy [DD] tags dropped. */
export function stripMarkup(text: string): string {
  if (!text) return "";
  return text
    .replace(LEGACY_DD_TAG, "")
    .replace(DD_MARK, "")
    .replace(BOLD, (_m, a, b) => a ?? b ?? "")
    .replace(HEADING_LINE, "");
}

export function hasDdMarkers(text: string | null | undefined): boolean {
  return !!text && text.includes(DD_OPEN);
}

/** Inline pass: DD-highlight spans + bold. Returns nodes safe to drop into any element. */
export function renderInline(text: string | null | undefined, keyPrefix = "t"): ReactNode {
  if (!text) return null;
  const cleaned = text.replace(LEGACY_DD_TAG, "");
  if (!cleaned.includes(DD_OPEN) && !/\*\*.+?\*\*|__.+?__/.test(cleaned)) {
    return cleaned;
  }

  // Split on DD sentinels first so a highlight can contain bold and vice versa.
  const parts: ReactNode[] = [];
  const segments = cleaned.split(/(\[\[dd\]\]|\[\[\/dd\]\])/);
  let inDd = false;
  segments.forEach((seg, i) => {
    if (seg === DD_OPEN) { inDd = true; return; }
    if (seg === DD_CLOSE) { inDd = false; return; }
    if (!seg) return;
    const boldNodes = renderBold(seg, `${keyPrefix}-${i}`);
    parts.push(
      inDd ? (
        <mark
          key={`${keyPrefix}-dd-${i}`}
          className="cim-dd-new rounded-sm bg-teal/15 px-0.5 text-foreground ring-1 ring-teal/30"
          title="Revealed in the due diligence version"
        >
          {boldNodes}
        </mark>
      ) : (
        <Fragment key={`${keyPrefix}-f-${i}`}>{boldNodes}</Fragment>
      ),
    );
  });
  return parts;
}

function renderBold(text: string, keyPrefix: string): ReactNode {
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  const re = new RegExp(BOLD.source, "g");
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<strong key={`${keyPrefix}-b-${m.index}`} className="font-semibold text-foreground">{m[1] ?? m[2]}</strong>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out.length === 1 ? out[0] : out;
}

type Block =
  | { kind: "p"; text: string }
  | { kind: "h"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] };

/** Turn free text into blocks: blank-line paragraphs, bullet/numbered lists, headings, inline "•" runs. */
export function parseProseBlocks(text: string): Block[] {
  if (!text) return [];
  const blocks: Block[] = [];
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
    let list: Block | null = null;
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

interface ProseOptions {
  paragraphClassName?: string;
  listClassName?: string;
  headingClassName?: string;
}

/** Block pass: paragraphs, lists and headings. Wrap the result in a block container. */
export function renderProse(text: string | null | undefined, opts: ProseOptions = {}): ReactNode {
  if (!text) return null;
  const {
    paragraphClassName = "text-sm leading-[1.7] mb-3 last:mb-0",
    listClassName = "space-y-1.5 mb-3 last:mb-0",
    headingClassName = "text-xs font-semibold uppercase tracking-widest text-foreground/70 mt-4 mb-2 first:mt-0",
  } = opts;
  return parseProseBlocks(text).map((block, i) => {
    switch (block.kind) {
      case "h":
        return <p key={i} className={headingClassName}>{renderInline(block.text, `h${i}`)}</p>;
      case "ul":
      case "ol":
        return (
          <ul key={i} className={listClassName}>
            {block.items.map((item, j) => (
              <li key={j} className="flex items-start gap-2.5 text-sm leading-relaxed">
                {block.kind === "ol" ? (
                  <span className="text-xs font-semibold tabular-nums text-teal flex-shrink-0 mt-0.5 w-4">{j + 1}.</span>
                ) : (
                  <span className="w-1.5 h-1.5 rounded-full bg-teal flex-shrink-0 mt-2" />
                )}
                <span className="min-w-0">{renderInline(item, `l${i}-${j}`)}</span>
              </li>
            ))}
          </ul>
        );
      default:
        return <p key={i} className={paragraphClassName}>{renderInline(block.text, `p${i}`)}</p>;
    }
  });
}

/** Shared fallback used by every structured renderer when its data is empty but prose exists. */
export function ProseFallback({ content }: { content: string }) {
  if (!content) return null;
  return (
    <div className="text-sm text-foreground/70 leading-relaxed max-w-prose">
      {renderProse(content)}
    </div>
  );
}

/**
 * Deep-walk a section's layoutData. Strings under prose keys keep their
 * markup (the renderer highlights them); every other string is flattened to
 * plain text so chart labels, metric values and table cells never show a
 * literal "**", "[[dd]]" or "[DD]".
 */
export function sanitizeLayoutData<T>(value: T, parentKey = "", depth = 0): T {
  if (depth > 8 || value == null) return value;
  if (typeof value === "string") {
    return (PROSE_KEYS.has(parentKey) ? value.replace(LEGACY_DD_TAG, "") : stripMarkup(value)) as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeLayoutData(v, parentKey, depth + 1)) as T;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeLayoutData(v, k, depth + 1);
    }
    return out as T;
  }
  return value;
}
