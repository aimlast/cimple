/**
 * CalloutList renderer
 * Three styles: card, list, icon-row. Also handles icon_stat_row layoutType.
 */
import { cn } from "@/lib/utils";
import {
  TrendingUp, Shield, Users, Zap, Star, CheckCircle,
  Building, Globe, DollarSign, BarChart2, Award, Target,
  Layers, Clock, Key, Lock, Map, Phone, Mail,
} from "lucide-react";
import type { CimBranding } from "../CimBrandingContext";
import type { CimSection } from "@shared/schema";

interface CalloutItem {
  title: string;
  description?: string;
  icon?: string;
  highlight?: boolean;
  badge?: string;
}

interface CalloutListLayoutData {
  items?: CalloutItem[];
  columns?: 1 | 2 | 3;
  style?: "card" | "list" | "icon-row";
  title?: string;
}

interface RendererProps {
  layoutData: CalloutListLayoutData;
  content: string;
  branding: CimBranding;
  section: CimSection;
}

const ICON_MAP: Record<string, React.ElementType> = {
  TrendingUp, Shield, Users, Zap, Star, CheckCircle,
  Building, Globe, DollarSign, BarChart2, Award, Target,
  Layers, Clock, Key, Lock, Map, Phone, Mail,
};

function IconBox({ name, className }: { name?: string; className?: string }) {
  if (!name) return null;
  const Icon = ICON_MAP[name];
  if (!Icon) return null;
  return <Icon className={cn("w-4 h-4", className)} />;
}

function TealDot() {
  return <div className="w-2 h-2 rounded-full bg-teal flex-shrink-0 mt-1.5" />;
}

export function CalloutListRenderer({ layoutData, content, branding, section }: RendererProps) {
  const data: CalloutListLayoutData = layoutData && Object.keys(layoutData).length > 0 ? layoutData : {};
  const items = data.items || [];

  // icon_stat_row: horizontal row of icon + stat
  const isIconStatRow = section.layoutType === "icon_stat_row";

  if (items.length === 0) {
    if (!content) return null;
    return <p className="text-sm text-foreground/70 leading-relaxed">{content}</p>;
  }

  const cols = data.columns || (isIconStatRow ? 4 : items.length > 4 ? 2 : 1);
  const style = isIconStatRow ? "icon-row" : (data.style || "list");

  const gridClass = {
    1: "grid-cols-1",
    2: "grid-cols-1 sm:grid-cols-2",
    3: "grid-cols-1 sm:grid-cols-3",
    4: "grid-cols-2 sm:grid-cols-4",
  }[(style === "icon-row" ? Math.min(items.length, 4) : cols) as 1 | 2 | 3 | 4] || "grid-cols-1";

  // ── ICON-ROW style ──────────────────────────────────────────────────────────
  if (style === "icon-row") {
    return (
      <div>
        {data.title && (
          <h3 className="text-sm font-semibold text-foreground/60 uppercase tracking-widest mb-4">
            {data.title}
          </h3>
        )}
        <div className={cn("grid gap-4", gridClass)}>
          {items.map((item, i) => (
            <div key={i} className="flex flex-col items-center text-center gap-2 p-4 bg-card rounded-lg border border-card-border">
              {item.icon && ICON_MAP[item.icon] ? (
                <div className="w-10 h-10 rounded-lg bg-teal-muted flex items-center justify-center">
                  <IconBox name={item.icon} className="text-teal" />
                </div>
              ) : (
                <div className="w-2.5 h-2.5 rounded-full bg-teal" />
              )}
              <div>
                <p className="text-base font-semibold text-foreground leading-tight">{item.title}</p>
                {item.description && (
                  <p className="text-xs text-muted-foreground mt-0.5">{item.description}</p>
                )}
              </div>
              {item.badge && (
                <span className="text-2xs px-2 py-0.5 rounded-full bg-teal-muted text-teal-muted-foreground font-medium">
                  {item.badge}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ── CARD style ──────────────────────────────────────────────────────────────
  if (style === "card") {
    return (
      <div>
        {data.title && (
          <h3 className="text-sm font-semibold text-foreground/60 uppercase tracking-widest mb-4">
            {data.title}
          </h3>
        )}
        <div className={cn("grid gap-3", gridClass)}>
          {items.map((item, i) => (
            <div
              key={i}
              className={cn(
                "bg-card rounded-lg border p-4",
                item.highlight ? "border-teal/30" : "border-card-border"
              )}
            >
              <div className="flex items-start gap-3">
                {item.icon && ICON_MAP[item.icon] ? (
                  <div className={cn(
                    "w-8 h-8 rounded-md flex items-center justify-center flex-shrink-0",
                    item.highlight ? "bg-teal-muted" : "bg-muted"
                  )}>
                    <IconBox name={item.icon} className={item.highlight ? "text-teal" : "text-muted-foreground"} />
                  </div>
                ) : (
                  <TealDot />
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className={cn(
                      "text-sm leading-snug",
                      item.highlight ? "font-semibold text-foreground" : "font-medium text-foreground/90"
                    )}>
                      {item.title}
                    </p>
                    {item.badge && (
                      <span className="text-2xs px-2 py-0.5 rounded-full bg-teal-muted text-teal-muted-foreground font-medium">
                        {item.badge}
                      </span>
                    )}
                  </div>
                  {item.description && (
                    <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{item.description}</p>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ── LIST style (default) ────────────────────────────────────────────────────
  return (
    <div>
      {data.title && (
        <h3 className="text-sm font-semibold text-foreground/60 uppercase tracking-widest mb-4">
          {data.title}
        </h3>
      )}
      <div className="space-y-2">
        {items.map((item, i) => (
          <div
            key={i}
            className={cn(
              "flex items-start gap-3 pl-4 border-l-2 py-1",
              item.highlight ? "border-teal" : "border-border"
            )}
          >
            {item.icon && ICON_MAP[item.icon] ? (
              <IconBox name={item.icon} className="text-muted-foreground mt-0.5 flex-shrink-0" />
            ) : (
              <TealDot />
            )}
            <div className="flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <p className={cn(
                  "text-sm",
                  item.highlight ? "font-semibold text-foreground" : "font-medium text-foreground/80"
                )}>
                  {item.title}
                </p>
                {item.badge && (
                  <span className="text-2xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground font-medium">
                    {item.badge}
                  </span>
                )}
              </div>
              {item.description && (
                <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{item.description}</p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
