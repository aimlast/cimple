/**
 * TwoColumn renderer
 * Two equal columns. Each side renders prose, list, or metric content.
 */
import { cn } from "@/lib/utils";
import type { CimBranding } from "../CimBrandingContext";
import type { CimSection } from "@shared/schema";

interface ColumnContent {
  title?: string;
  content: string;
  layoutType?: "prose" | "list" | "metric";
}

interface TwoColumnLayoutData {
  left?: ColumnContent;
  right?: ColumnContent;
  title?: string;
}

interface RendererProps {
  layoutData: TwoColumnLayoutData;
  content: string;
  branding: CimBranding;
  section: CimSection;
}

function parseMetricLines(text: string): Array<{ label: string; value: string }> {
  return text.split("\n").filter(Boolean).map((line) => {
    const idx = line.indexOf(":");
    if (idx === -1) return { label: line, value: "" };
    return { label: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() };
  });
}

function ColumnBlock({ col }: { col: ColumnContent }) {
  const type = col.layoutType || "prose";

  if (type === "list") {
    const lines = col.content.split("\n").filter(Boolean);
    return (
      <div>
        {col.title && (
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
            {col.title}
          </p>
        )}
        <ul className="space-y-1.5">
          {lines.map((line, i) => (
            <li key={i} className="flex items-start gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-teal flex-shrink-0 mt-1.5" />
              <span className="text-sm text-foreground/80 leading-relaxed">{line.replace(/^[-•*]\s*/, "")}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (type === "metric") {
    const pairs = parseMetricLines(col.content);
    return (
      <div>
        {col.title && (
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
            {col.title}
          </p>
        )}
        <div className="space-y-2">
          {pairs.map((pair, i) => (
            <div key={i} className="flex items-baseline justify-between gap-4 border-b border-border/40 pb-1.5 last:border-0">
              <span className="text-xs text-muted-foreground">{pair.label}</span>
              <span className="text-sm font-semibold tabular-nums text-foreground">{pair.value}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // prose (default)
  return (
    <div>
      {col.title && (
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
          {col.title}
        </p>
      )}
      <div className="space-y-2">
        {col.content.split("\n\n").filter(Boolean).map((para, i) => (
          <p key={i} className="text-sm text-foreground/80 leading-relaxed">{para}</p>
        ))}
      </div>
    </div>
  );
}

export function TwoColumnRenderer({ layoutData, content, branding, section }: RendererProps) {
  const data: TwoColumnLayoutData = layoutData && Object.keys(layoutData).length > 0 ? layoutData : {};

  if (!data.left && !data.right) {
    if (!content) return null;
    return <p className="text-sm text-foreground/70 leading-relaxed">{content}</p>;
  }

  const left = data.left || { content: "", layoutType: "prose" };
  const right = data.right || { content: "", layoutType: "prose" };

  return (
    <div>
      {data.title && (
        <h3 className="text-sm font-semibold text-foreground/60 uppercase tracking-widest mb-4">
          {data.title}
        </h3>
      )}
      <div className="grid grid-cols-2 gap-8">
        <div>
          <ColumnBlock col={left} />
        </div>
        <div className="border-l border-border pl-8">
          <ColumnBlock col={right} />
        </div>
      </div>
    </div>
  );
}
