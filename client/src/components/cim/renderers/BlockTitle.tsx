/**
 * BlockTitle — the small caption a renderer prints above its content, and
 * the `intro` sentence(s) under it.
 *
 * A caption is short and drawn in tracked capitals. Body text that reached
 * the caption field (the writer once put a four-sentence working-capital
 * explainer there — unreadable in all-caps) is drawn as an ordinary
 * paragraph instead, whatever the stored data says (isParagraphTitle).
 */
import { isParagraphTitle } from "@shared/cim-layouts";
import { renderInline } from "../richText";
import { cn } from "@/lib/utils";
import { useBlockAttrs } from "../blocks";

interface BlockTitleProps {
  title?: unknown;
  intro?: unknown;
  /** Space under the block (renderers differ slightly). */
  spacing?: "mb-4" | "mb-5";
}

export function BlockTitle({ title, intro, spacing = "mb-4" }: BlockTitleProps) {
  const ba = useBlockAttrs();
  const t = typeof title === "string" ? title.trim() : "";
  const i = typeof intro === "string" ? intro.trim() : "";
  const paragraph = !!t && isParagraphTitle(t);
  if (!t && !i) return null;
  return (
    <>
      {t && !paragraph && (
        <h3 {...ba("caption")} className={cn("text-sm font-semibold text-foreground/60 uppercase tracking-widest", i ? "mb-2" : spacing)}>{t}</h3>
      )}
      {(paragraph || i) && (
        <div {...ba("intro")} className={cn("space-y-2 max-w-3xl", spacing)} data-testid="block-intro">
          {paragraph && <p className="text-sm leading-relaxed text-foreground/80">{renderInline(t, "bt")}</p>}
          {i && <p className="text-sm leading-relaxed text-foreground/80">{renderInline(i, "bi")}</p>}
        </div>
      )}
    </>
  );
}
