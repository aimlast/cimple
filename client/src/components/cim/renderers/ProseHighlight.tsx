/**
 * ProseHighlight renderer
 * Left: prose body. Right: pull quote + highlights (if present).
 *
 * Body resolution: brokerEditedContent → layoutData.body → content. The
 * broker's saved edit must always win over the AI's layoutData.body, or a
 * "Section saved" toast lies while buyers keep reading the old text.
 */
import { cn } from "@/lib/utils";
import type { CimBranding } from "../CimBrandingContext";
import type { CimSection } from "@shared/schema";
import { renderInline, renderProse, stripMarkup } from "../richText";

interface ProseHighlightLayoutData {
  body?: string;
  pullQuote?: string;
  highlights?: string[];
  subheading?: string;
}

interface RendererProps {
  layoutData: ProseHighlightLayoutData;
  content: string;
  branding: CimBranding;
  section: CimSection;
}

export function ProseHighlightRenderer({ layoutData, content, branding, section }: RendererProps) {
  const data: ProseHighlightLayoutData = layoutData && Object.keys(layoutData).length > 0 ? layoutData : {};

  const body = section.brokerEditedContent || data.body || content || "";
  const hasRight = !!(data.pullQuote || (data.highlights && data.highlights.length > 0));

  if (!body && !hasRight) return null;

  return (
    // Stacks on phones (prose, then the quote/highlights); side by side from md.
    <div className={cn("flex flex-col gap-6 md:flex-row md:gap-8", hasRight ? "md:items-start" : "")}>
      {/* Left: prose — capped measure so full-width text never becomes a wall */}
      <div className={cn("flex-1 min-w-0", hasRight ? "md:max-w-[60%]" : "max-w-prose")}>
        {data.subheading && (
          <p className="text-xs font-semibold text-teal uppercase tracking-widest mb-3">
            {stripMarkup(data.subheading)}
          </p>
        )}
        {body && (
          <div className="prose prose-sm max-w-none text-foreground/80 leading-relaxed">
            {renderProse(body)}
          </div>
        )}
      </div>

      {/* Right: pull quote + highlights */}
      {hasRight && (
        <div className="w-full md:w-[36%] md:flex-shrink-0 flex flex-col gap-4">
          {data.pullQuote && (
            <div className="relative pl-4 border-l-2 border-teal">
              <p className="text-base font-medium text-foreground/90 leading-snug italic">
                &ldquo;{renderInline(data.pullQuote, "pq")}&rdquo;
              </p>
            </div>
          )}
          {data.highlights && data.highlights.length > 0 && (
            <div className="space-y-2">
              {data.highlights.map((hl, i) => (
                <div key={i} className="flex items-start gap-2.5">
                  <div className="w-1.5 h-1.5 rounded-full bg-teal flex-shrink-0 mt-1.5" />
                  <p className="text-xs text-foreground/75 leading-relaxed">{renderInline(hl, `hl${i}`)}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
