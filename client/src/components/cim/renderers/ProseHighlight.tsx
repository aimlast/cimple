/**
 * ProseHighlight renderer
 * Left: prose body. Right: pull quote + highlights (if present).
 */
import { cn } from "@/lib/utils";
import type { CimBranding } from "../CimBrandingContext";
import type { CimSection } from "@shared/schema";

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

  const body = data.body || content || "";
  const hasRight = !!(data.pullQuote || (data.highlights && data.highlights.length > 0));

  if (!body && !hasRight) return null;

  return (
    <div className={cn("flex gap-8", hasRight ? "items-start" : "")}>
      {/* Left: prose */}
      <div className={cn("flex-1 min-w-0", hasRight && "max-w-[60%]")}>
        {data.subheading && (
          <p className="text-xs font-semibold text-teal uppercase tracking-widest mb-3">
            {data.subheading}
          </p>
        )}
        {body && (
          <div className="prose prose-sm max-w-none text-foreground/80 leading-relaxed">
            {body.split("\n\n").map((para, i) => (
              <p key={i} className="text-sm leading-relaxed mb-3 last:mb-0">
                {para}
              </p>
            ))}
          </div>
        )}
      </div>

      {/* Right: pull quote + highlights */}
      {hasRight && (
        <div className="w-[36%] flex-shrink-0 flex flex-col gap-4">
          {data.pullQuote && (
            <div className="relative pl-4 border-l-2 border-teal">
              <p className="text-base font-medium text-foreground/90 leading-snug italic">
                &ldquo;{data.pullQuote}&rdquo;
              </p>
            </div>
          )}
          {data.highlights && data.highlights.length > 0 && (
            <div className="space-y-2">
              {data.highlights.map((hl, i) => (
                <div key={i} className="flex items-start gap-2.5">
                  <div className="w-1.5 h-1.5 rounded-full bg-teal flex-shrink-0 mt-1.5" />
                  <p className="text-xs text-foreground/75 leading-relaxed">{hl}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
