/**
 * TagCloud renderer — short keyword chips (services, markets, certifications).
 * `weight` (1–5) nudges size; tags with a `category` are grouped under it.
 */
import type { CimBranding } from "../CimBrandingContext";
import type { CimSection } from "@shared/schema";
import { ProseFallback, stripMarkup } from "../richText";

interface Tag {
  label?: string;
  weight?: number;
  category?: string;
}

interface RendererProps {
  layoutData: { tags?: Tag[]; title?: string };
  content: string;
  branding: CimBranding;
  section: CimSection;
}

const SIZE = ["text-xs", "text-xs", "text-sm", "text-sm", "text-base", "text-base"];

export function TagCloudRenderer({ layoutData, content }: RendererProps) {
  const tags = (Array.isArray(layoutData?.tags) ? layoutData.tags : []).filter(
    (t): t is Tag => !!t && typeof t.label === "string" && t.label.trim().length > 0,
  );
  if (tags.length === 0) return <ProseFallback content={content} />;

  const groups = new Map<string, Tag[]>();
  for (const t of tags) {
    const key = t.category?.trim() || "";
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }

  return (
    <div className="space-y-4">
      {layoutData.title && (
        <p className="text-xs font-semibold text-teal uppercase tracking-widest">{stripMarkup(layoutData.title)}</p>
      )}
      {Array.from(groups.entries()).map(([category, items]) => (
        <div key={category || "_"}>
          {category && <p className="text-2xs font-medium text-muted-foreground uppercase tracking-wider mb-2">{category}</p>}
          <div className="flex flex-wrap gap-2">
            {items.map((t, i) => {
              const w = Math.max(1, Math.min(5, Math.round(Number(t.weight) || 2)));
              return (
                <span
                  key={`${t.label}-${i}`}
                  className={`${SIZE[w]} inline-flex items-center rounded-full border px-3 py-1 font-medium ${
                    w >= 4 ? "border-teal/50 bg-teal/10 text-foreground" : "border-border bg-card text-foreground/80"
                  }`}
                >
                  {stripMarkup(t.label!)}
                </span>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
