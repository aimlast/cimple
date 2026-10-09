/**
 * The due-diligence additions under a page (spec §4.5): "From the documents"
 * (DdKeyTerms: lease, contract and licence terms, each linked to its
 * document) and "Sources for this page" (DdSectionSources). DD only; buyers
 * see them once the broker turned the checks on, the broker's preview always
 * (dashed, "Not shown to buyers yet").
 */
import { BROKER_NOT_SHOWN, KEY_TERMS_TITLE, MORE_COUNT, PAGE_SOURCES_TITLE } from "@shared/figure-copy";
import { useFigureLayer, usePageFigures } from "./FigureLayerContext";
import { FigureCitation } from "./FigureCitation";

function useDdExtras() {
  const ctx = useFigureLayer();
  if (!ctx || ctx.layer.mode !== "dd") return null;
  const broker = ctx.layer.audience === "broker";
  if (!broker && !ctx.layer.ddChecksOn) return null;
  return { layer: ctx.layer, notShown: broker && !ctx.layer.ddChecksOn };
}

function NotShown() {
  return <span className="ml-2 text-[10px] font-normal normal-case tracking-normal text-[#8A8170]">{BROKER_NOT_SHOWN}</span>;
}

export function DdKeyTerms({ pageId }: { pageId: string }) {
  const x = useDdExtras();
  const terms = x?.layer.keyTerms?.[pageId] ?? [];
  if (!x || terms.length === 0) return null;
  return (
    <div className={`fig-key-terms mt-4 rounded-lg border bg-[hsl(var(--cim-card))] px-3 py-2.5 ${x.notShown ? "border-dashed border-[#8A8170]" : "border-[hsl(var(--cim-line))]"}`}>
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-[hsl(var(--cim-ink-muted))]">
        {KEY_TERMS_TITLE}{x.notShown && <NotShown />}
      </p>
      <ul className="space-y-1">
        {terms.map((t, i) => (
          <li key={i} className="text-xs leading-snug text-[hsl(var(--cim-ink-soft))]">
            <span className="font-medium text-[hsl(var(--cim-ink))]">{t.label}:</span> {t.value} <FigureCitation docRef={t.citation} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Tables whose side-by-side view already lists their statements and tax returns under the table. */
const COMPARE_TABLES = new Set(["financial_table", "comparison_table"]);

export function DdSectionSources({ pageId, layoutType }: { pageId: string; layoutType?: string }) {
  const x = useDdExtras();
  const figures = usePageFigures(pageId);
  const all = x?.layer.pageSources?.[pageId] ?? [];
  // Under a side-by-side table the statements and tax returns are already listed right above
  // ("Statements: … Tax returns: …"): list only what else the page cites, never the same chips twice.
  const inTable = new Set<string>();
  if (layoutType && COMPARE_TABLES.has(layoutType)) {
    for (const f of figures) {
      if (!(f.checks?.length)) continue;
      for (const r of f.citations ?? []) inTable.add(r.documentId);
      for (const c of f.checks ?? []) {
        if (c.citation) inTable.add(c.citation.documentId);
        if (c.baseCitation) inTable.add(c.baseCitation.documentId);
      }
    }
  }
  const refs = all.filter((r) => !inTable.has(r.documentId));
  if (!x || refs.length === 0) return null;
  const shown = refs.slice(0, 6);
  return (
    <div className={`fig-page-sources mt-3 flex flex-wrap items-center gap-1 text-[11px] text-[hsl(var(--cim-ink-muted))] ${x.notShown ? "rounded-md border border-dashed border-[#8A8170] px-2 py-1" : ""}`}>
      <span>{PAGE_SOURCES_TITLE}</span>
      {shown.map((r) => <FigureCitation key={r.documentId} docRef={r} />)}
      {refs.length > shown.length && <span>{MORE_COUNT(refs.length - shown.length)}</span>}
      {x.notShown && <NotShown />}
    </div>
  );
}
