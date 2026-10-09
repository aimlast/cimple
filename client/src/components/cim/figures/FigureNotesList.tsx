/**
 * FigureNotesList — "Notes on these figures (n)" under a section (spec §4.5).
 * Collapsed by default; expanded in print. On a phone this is the main way
 * in. Choosing a line scrolls to the figure and opens its note.
 */
import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { NOTES_LIST_TITLE } from "@shared/figure-copy";
import type { FigureView } from "@shared/figure-layer";
import { useFigureLayer, usePageFigures } from "./FigureLayerContext";

function lineFor(f: FigureView, blind: boolean): string {
  const parts = [`FY${f.year}`];
  if (!blind && f.label) parts.push(f.label);
  if (f.change) parts.push(`${f.change.delta.startsWith("−") ? "down" : "up"} ${f.change.pct ?? f.change.delta.replace(/^[+−]/, "")}`);
  return parts.join(" · ");
}

export function FigureNotesList({ pageId }: { pageId: string }) {
  const ctx = useFigureLayer();
  const figures = usePageFigures(pageId).filter((f) => !!f.why);
  const [open, setOpen] = useState(false);
  if (!ctx || figures.length === 0) return null;
  const blind = ctx.layer.mode === "blind";
  const go = (id: string) => {
    const el = document.querySelector<HTMLElement>(`[data-cim-page="${CSS.escape(pageId)}"] [data-fig="${CSS.escape(id)}"], #section-${CSS.escape(pageId)} [data-fig="${CSS.escape(id)}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    window.setTimeout(() => el.click(), 350);
  };
  return (
    <div className="fig-notes mt-4 rounded-lg border border-[hsl(var(--cim-line))] bg-[hsl(var(--cim-card))]" data-print-expand="">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs font-medium text-[hsl(var(--cim-ink-soft))] print:hidden"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span>{NOTES_LIST_TITLE(figures.length)}</span>
        <ChevronDown aria-hidden className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      <p className="hidden px-3 pt-2 text-xs font-medium text-[hsl(var(--cim-ink-soft))] print:block">{NOTES_LIST_TITLE(figures.length)}</p>
      <ul className={`${open ? "block" : "hidden"} print:block space-y-1.5 px-3 pb-3`}>
        {figures.map((f) => (
          <li key={f.id} className="text-xs leading-snug text-[hsl(var(--cim-ink-soft))]">
            <button type="button" className="text-left hover:underline print:no-underline" onClick={() => go(f.id)}>
              <span className="font-medium text-[hsl(var(--cim-ink))]">{lineFor(f, blind)}:</span> {f.why!.text}
              <span className="text-[hsl(var(--cim-ink-muted))]"> {f.why!.basisLabel}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
