/**
 * NumberedList renderer
 * Large teal numbers, bold title, muted description below.
 */
import { cn } from "@/lib/utils";
import type { CimBranding } from "../CimBrandingContext";
import type { CimSection } from "@shared/schema";

interface ListItem {
  title: string;
  description?: string;
}

interface NumberedListLayoutData {
  items?: ListItem[];
  title?: string;
  ordered?: boolean;
}

interface RendererProps {
  layoutData: NumberedListLayoutData;
  content: string;
  branding: CimBranding;
  section: CimSection;
}

export function NumberedListRenderer({ layoutData, content, branding, section }: RendererProps) {
  const data: NumberedListLayoutData = layoutData && Object.keys(layoutData).length > 0 ? layoutData : {};
  const items = data.items || [];
  const ordered = data.ordered !== false; // default true

  if (items.length === 0) {
    if (!content) return null;
    return <p className="text-sm text-foreground/70 leading-relaxed">{content}</p>;
  }

  return (
    <div>
      {data.title && (
        <h3 className="text-sm font-semibold text-foreground/60 uppercase tracking-widest mb-4">
          {data.title}
        </h3>
      )}
      <div className="space-y-4">
        {items.map((item, i) => (
          <div key={i} className="flex items-start gap-4">
            {/* Number / Bullet */}
            <div className="flex-shrink-0 w-8 flex items-start justify-center pt-0.5">
              {ordered ? (
                <span className="text-xl font-semibold tabular-nums text-teal leading-none">
                  {String(i + 1).padStart(2, "0")}
                </span>
              ) : (
                <div className="w-2 h-2 rounded-full bg-teal mt-1.5" />
              )}
            </div>
            {/* Content */}
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-foreground leading-snug">{item.title}</p>
              {item.description && (
                <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{item.description}</p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
