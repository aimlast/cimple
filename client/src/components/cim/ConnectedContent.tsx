/**
 * ConnectedContent — Links related CIM sections together.
 *
 * When a section's layoutData includes `relatedSections: ["revenue_streams"]`,
 * this component adds a subtle "See also" link that smooth-scrolls to the
 * related section and briefly highlights it.
 *
 * Works with any section type — the AI decides which sections are related.
 */
import { useCallback } from "react";
import { ArrowDown } from "lucide-react";
import type { CimSection } from "@shared/schema";

interface ConnectedContentProps {
  section: CimSection;
  allSections: CimSection[];
  onNavigate?: (fromKey: string, toKey: string) => void;
}

export function ConnectedContent({
  section,
  allSections,
  onNavigate,
}: ConnectedContentProps) {
  const layoutData = (section.layoutData as any) || {};
  const relatedKeys = (layoutData.relatedSections || []) as string[];

  const relatedSections = relatedKeys
    .map((key) => allSections.find((s) => s.sectionKey === key))
    .filter(Boolean) as CimSection[];

  const scrollTo = useCallback(
    (target: CimSection) => {
      const el = document.getElementById(`section-${target.id}`);
      if (!el) return;

      // Smooth scroll
      const yOffset = -90;
      const y = el.getBoundingClientRect().top + window.scrollY + yOffset;
      window.scrollTo({ top: y, behavior: "smooth" });

      // Brief highlight pulse
      el.classList.add("ring-2", "ring-teal/30", "rounded-lg");
      setTimeout(() => {
        el.classList.remove("ring-2", "ring-teal/30", "rounded-lg");
      }, 2000);

      onNavigate?.(section.sectionKey, target.sectionKey);
    },
    [section.sectionKey, onNavigate],
  );

  if (relatedSections.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 mt-3 print:hidden">
      {relatedSections.map((rel) => (
        <button
          key={rel.id}
          onClick={() => scrollTo(rel)}
          className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground/60 hover:text-teal transition-colors"
        >
          <ArrowDown className="h-3 w-3" />
          <span>See {rel.sectionTitle}</span>
        </button>
      ))}
    </div>
  );
}
