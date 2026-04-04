/**
 * Timeline renderer
 * Vertical timeline with connecting line, teal highlight dots.
 */
import { cn } from "@/lib/utils";
import type { CimBranding } from "../CimBrandingContext";
import type { CimSection } from "@shared/schema";

interface TimelineEvent {
  date?: string;
  year?: string;
  title: string;
  description?: string;
  highlight?: boolean;
  category?: string;
}

interface TimelineLayoutData {
  events?: TimelineEvent[];
  title?: string;
}

interface RendererProps {
  layoutData: TimelineLayoutData;
  content: string;
  branding: CimBranding;
  section: CimSection;
}

export function TimelineRenderer({ layoutData, content, branding, section }: RendererProps) {
  const data: TimelineLayoutData = layoutData && Object.keys(layoutData).length > 0 ? layoutData : {};
  const events = data.events || [];

  if (events.length === 0) {
    if (!content) return null;
    return <p className="text-sm text-foreground/70 leading-relaxed">{content}</p>;
  }

  return (
    <div>
      {data.title && (
        <h3 className="text-sm font-semibold text-foreground/60 uppercase tracking-widest mb-5">
          {data.title}
        </h3>
      )}
      <div className="relative">
        {/* Connecting line */}
        <div className="absolute left-[88px] top-2 bottom-2 w-px bg-border" />

        <div className="space-y-0">
          {events.map((event, i) => {
            const dateLabel = event.date || event.year || "";
            return (
              <div key={i} className="relative flex gap-0 group">
                {/* Date column */}
                <div className="w-[88px] flex-shrink-0 flex items-start justify-end pr-5 pt-[13px]">
                  {dateLabel && (
                    <span className={cn(
                      "text-xs font-medium tabular-nums leading-tight text-right",
                      event.highlight ? "text-teal" : "text-muted-foreground"
                    )}>
                      {dateLabel}
                    </span>
                  )}
                </div>

                {/* Dot */}
                <div className="flex-shrink-0 flex flex-col items-center" style={{ width: 1 }}>
                  <div className={cn(
                    "relative z-10 w-3 h-3 rounded-full border-2 mt-3 -ml-1.5",
                    event.highlight
                      ? "bg-teal border-teal"
                      : "bg-card border-border group-hover:border-teal/50 transition-colors"
                  )} />
                </div>

                {/* Content */}
                <div className={cn(
                  "flex-1 pb-6 pl-5",
                  i === events.length - 1 && "pb-0"
                )}>
                  <div className="flex items-start gap-2 flex-wrap">
                    <h4 className={cn(
                      "text-sm leading-snug mt-1",
                      event.highlight ? "font-semibold text-foreground" : "font-medium text-foreground/80"
                    )}>
                      {event.title}
                    </h4>
                    {event.category && (
                      <span className="text-2xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground mt-1.5 font-medium">
                        {event.category}
                      </span>
                    )}
                  </div>
                  {event.description && (
                    <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed max-w-lg">
                      {event.description}
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
