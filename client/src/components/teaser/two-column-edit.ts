/**
 * The teaser editor's plain-language view of a two-column block's columns
 * (pure; no DOM). A broker never sees the raw keys ("left", "content") or
 * the column's layout type: a column is a heading plus, by what it holds,
 *   - text          (a paragraph),
 *   - points        (one line per point — "Who it suits"),
 *   - figures       (label + value lines — "Label: value"),
 *   - highlights    (title + detail cards),
 *   - other         (anything else: only its content is editable).
 * What the column holds never changes here (the server would refuse a chart
 * or a table in a teaser column), and every key the editor doesn't show is
 * kept as it was. Blank rows are dropped when written back, so adding an
 * empty row and leaving it doesn't change the block.
 */

export type ColumnKind = "text" | "points" | "figures" | "highlights" | "other";

export interface ColumnView {
  kind: ColumnKind;
  heading: string;
  text: string;
  points: string[];
  figures: Array<{ label: string; value: string }>;
  highlights: Array<{ title: string; detail: string }>;
}

type Json = Record<string, any>;
const isRec = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

/** Where a column's figures / highlights live inside an object content. */
const FIGURE_KEYS = ["stats", "metrics"] as const;

function emptyView(heading: string, kind: ColumnKind): ColumnView {
  return { kind, heading, text: "", points: [], figures: [], highlights: [] };
}

function parseFigureLine(line: string): { label: string; value: string } {
  const i = line.indexOf(":");
  return i < 0 ? { label: line.trim(), value: "" } : { label: line.slice(0, i).trim(), value: line.slice(i + 1).trim() };
}

function highlightOf(x: Json): { title: string; detail: string } {
  return { title: str(x.title ?? x.label), detail: str(x.description ?? x.detail) };
}

/** A column as the broker edits it. */
export function columnView(raw: unknown): ColumnView {
  const col = isRec(raw) ? raw : {};
  const heading = str(col.title);
  const type = typeof col.layoutType === "string" ? col.layoutType.trim() : "";
  const c = col.content;
  if (Array.isArray(c)) {
    if (c.every((x) => typeof x === "string")) return { ...emptyView(heading, "points"), points: c as string[] };
    if (c.every(isRec) && c.every((x) => typeof x.title === "string" || typeof x.label === "string")) {
      return { ...emptyView(heading, "highlights"), highlights: (c as Json[]).map(highlightOf) };
    }
    return emptyView(heading, "other");
  }
  if (isRec(c)) {
    if (Array.isArray(c.items) && c.items.every(isRec)) return { ...emptyView(heading, "highlights"), highlights: (c.items as Json[]).map(highlightOf) };
    for (const k of FIGURE_KEYS) {
      if (Array.isArray(c[k]) && (c[k] as unknown[]).every(isRec)) {
        return { ...emptyView(heading, "figures"), figures: (c[k] as Json[]).map((x) => ({ label: str(x.label), value: str(x.value) })) };
      }
    }
    return emptyView(heading, "other");
  }
  const text = typeof c === "string" ? c : c == null ? "" : String(c);
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  if (type === "list") return { ...emptyView(heading, "points"), points: lines };
  if (type === "metric") return { ...emptyView(heading, "figures"), figures: lines.map(parseFigureLine) };
  if (!type || type === "prose") return { ...emptyView(heading, "text"), text };
  return emptyView(heading, "other");
}

/** The column written back from the broker's view: same kind, same shape, the other keys kept, blank rows dropped. */
export function columnWith(raw: unknown, view: ColumnView): Json {
  const col: Json = isRec(raw) ? { ...raw } : {};
  if (view.heading.trim() || typeof col.title === "string") col.title = view.heading.trim();
  const c = col.content;
  switch (view.kind) {
    case "text":
      col.content = view.text;
      break;
    case "points": {
      const points = view.points.map((p) => p.trim()).filter(Boolean);
      col.content = Array.isArray(c) ? points : points.join("\n");
      break;
    }
    case "figures": {
      const rows = view.figures.map((f) => ({ label: f.label.trim(), value: f.value.trim() })).filter((f) => f.label || f.value);
      const key = isRec(c) ? FIGURE_KEYS.find((k) => Array.isArray(c[k])) : undefined;
      if (isRec(c) && key) {
        const orig = c[key] as Json[];
        col.content = { ...c, [key]: rows.map((f, i) => ({ ...(isRec(orig[i]) ? orig[i] : {}), label: f.label, value: f.value })) };
      } else {
        col.content = rows.map((f) => (f.value ? `${f.label}: ${f.value}` : f.label)).join("\n");
      }
      break;
    }
    case "highlights": {
      const rows = view.highlights.map((h) => ({ title: h.title.trim(), detail: h.detail.trim() })).filter((h) => h.title || h.detail);
      const orig: Json[] = Array.isArray(c) ? (c as Json[]) : isRec(c) && Array.isArray(c.items) ? (c.items as Json[]) : [];
      const items = rows.map((h, i) => {
        const o: Json = isRec(orig[i]) ? { ...orig[i] } : {};
        if (typeof o.label === "string" && typeof o.title !== "string") o.label = h.title;
        else o.title = h.title;
        if (typeof o.detail === "string" && typeof o.description !== "string") o.detail = h.detail;
        else o.description = h.detail;
        return o;
      });
      col.content = Array.isArray(c) ? items : { ...(isRec(c) ? c : {}), items };
      break;
    }
    case "other":
      break;
  }
  return col;
}

/** How many rows a broker may add to a column (a teaser column stays short). */
export const MAX_COLUMN_ROWS = 8;

/** The broker's label for a column: its saved heading, else which side it is. */
export function columnLabel(raw: unknown, side: "left" | "right", sides: number): string {
  const h = isRec(raw) ? str(raw.title).trim() : "";
  if (h) return h;
  if (sides === 1) return "The other column";
  return side === "left" ? "Left column" : "Right column";
}
