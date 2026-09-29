/**
 * Divider renderer
 * Line, section-break, or page-break spacing.
 */
import { cn } from "@/lib/utils";
import type { CimBranding } from "../CimBrandingContext";
import type { CimSection } from "@shared/schema";
import { useBlockAttrs } from "../blocks";

interface DividerLayoutData {
  label?: string;
  style?: "line" | "section-break" | "page-break";
}

interface RendererProps {
  layoutData: DividerLayoutData;
  content: string;
  branding: CimBranding;
  section: CimSection;
}

export function DividerRenderer({ layoutData, content, branding, section }: RendererProps) {
  const ba = useBlockAttrs();
  const data: DividerLayoutData = layoutData && Object.keys(layoutData).length > 0 ? layoutData : {};
  const style = data.style || "line";

  if (style === "page-break") {
    return <div {...ba("page")} className="h-16" aria-hidden="true" />;
  }

  if (style === "section-break") {
    if (!data.label) {
      return <div {...ba("page")} className="h-px bg-border my-4" aria-hidden="true" />;
    }
    return (
      <div {...ba("page")} className="flex items-center gap-4 py-2">
        <div className="flex-1 h-px bg-border" />
        <span className="text-2xs font-medium text-muted-foreground uppercase tracking-widest px-1 flex-shrink-0">
          {data.label}
        </span>
        <div className="flex-1 h-px bg-border" />
      </div>
    );
  }

  // line (default)
  return <hr {...ba("page")} className="border-0 border-t border-border my-1" />;
}
