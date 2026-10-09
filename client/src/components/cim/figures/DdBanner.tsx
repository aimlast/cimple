/**
 * DdBanner — the due-diligence version's key, inside the paper under the
 * cover page (not a page of its own, so the reading tracker isn't affected).
 * Buyers see it once the checks are on and at least one figure is checked;
 * the broker's preview always, dashed, "Not shown to buyers yet".
 */
import { DD_SOURCE_CHECK_PAGE_ID } from "@shared/figure-layer";
import {
  BROKER_NOT_SHOWN, DD_BANNER_DOCS, DD_BANNER_LINK, DD_BANNER_POINTER, DD_BANNER_TITLE, DD_BANNER_TOUCH, KEY_HAS_NOTE,
} from "@shared/figure-copy";
import { STATE_PAINT } from "@shared/figure-states";
import { useFigureLayer } from "./FigureLayerContext";
import { StateIcon } from "./figurePaint";
import { useCoarse } from "./FigureValue";

export function DdBanner() {
  const ctx = useFigureLayer();
  const coarse = useCoarse();
  if (!ctx || ctx.layer.mode !== "dd") return null;
  const broker = ctx.layer.audience === "broker";
  const checked = ctx.layer.summary?.checked ?? 0;
  if (!broker && (!ctx.layer.ddChecksOn || checked === 0)) return null;
  const notShown = broker && !ctx.layer.ddChecksOn;
  const hasPage = !!ctx.layer.sourceCheck;
  return (
    <aside
      aria-label="Due-diligence version"
      className={`fig-dd-banner my-6 rounded-lg border px-4 py-3 text-xs leading-relaxed text-[hsl(var(--cim-ink-soft))] ${notShown ? "border-dashed border-[#8A8170] bg-[hsl(var(--cim-card))]" : "border-[hsl(var(--cim-line))] bg-[hsl(var(--cim-card))]"}`}
    >
      <p>
        <strong className="text-[hsl(var(--cim-ink))]">{DD_BANNER_TITLE}</strong> {coarse ? DD_BANNER_TOUCH : DD_BANNER_POINTER} {DD_BANNER_DOCS}{" "}
        {hasPage && (
          <a href={`#section-${DD_SOURCE_CHECK_PAGE_ID}`} className="font-medium text-[hsl(var(--cim-brass))] underline-offset-2 hover:underline">{DD_BANNER_LINK}</a>
        )}
        {notShown && <span className="ml-2 text-[10px] text-[#8A8170]">{BROKER_NOT_SHOWN}</span>}
      </p>
      <ul className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]" aria-label="Colour key">
        <li className="inline-flex items-center gap-1"><StateIcon state="match" /> Matches</li>
        <li className="inline-flex items-center gap-1">
          <span aria-hidden className="inline-flex h-3.5 items-center rounded-sm px-0.5" style={{ backgroundColor: STATE_PAINT.regrouped.tint, boxShadow: `inset 1px 0 0 ${STATE_PAINT.regrouped.rule}` }}><StateIcon state="regrouped" /></span> Same amounts, grouped differently
        </li>
        <li className="inline-flex items-center gap-1">
          <span aria-hidden className="inline-block h-3 w-4 rounded-sm" style={{ backgroundColor: STATE_PAINT.explained.tint, boxShadow: `inset 1px 0 0 ${STATE_PAINT.explained.rule}` }} /> Differs, reason given
        </li>
        <li className="inline-flex items-center gap-1">
          <span aria-hidden className="inline-block h-3 w-4 rounded-sm" style={{ backgroundColor: STATE_PAINT.ask.tint, boxShadow: `inset 2px 0 0 ${STATE_PAINT.ask.rule}` }} /> Differs, ask the broker
        </li>
        <li className="inline-flex items-center gap-1">
          <span aria-hidden className="underline decoration-dotted underline-offset-2" style={{ textDecorationColor: "#8A8170" }}>1,234</span> {KEY_HAS_NOTE}
        </li>
      </ul>
    </aside>
  );
}
