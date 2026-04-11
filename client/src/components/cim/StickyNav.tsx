/**
 * StickyNav — Minimal floating section navigation for CIM viewer.
 *
 * Appears after scrolling past the cover page. Shows the current section
 * highlighted and allows jumping to any section via smooth scroll.
 * On mobile: collapses into a floating button that opens a section list.
 *
 * Fires analytics events on every navigation click.
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { ChevronDown, ChevronUp, List } from "lucide-react";
import type { CimSection } from "@shared/schema";

interface StickyNavProps {
  sections: CimSection[];
  onNavigate?: (sectionKey: string, sectionTitle: string) => void;
}

export function StickyNav({ sections, onNavigate }: StickyNavProps) {
  const [visible, setVisible] = useState(false);
  const [activeSection, setActiveSection] = useState<string | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const navRef = useRef<HTMLDivElement>(null);

  // Filter to visible, non-cover, non-divider sections
  const navSections = sections.filter(
    (s) =>
      s.isVisible &&
      s.layoutType !== "cover_page" &&
      s.layoutType !== "divider",
  );

  const coverSection = sections.find(
    (s) => s.layoutType === "cover_page" && s.isVisible,
  );

  // Track which section is in view
  useEffect(() => {
    if (!navSections.length) return;

    // Wait for DOM to settle
    const timer = setTimeout(() => {
      const sectionEls = navSections
        .map((s) => document.getElementById(`section-${s.id}`))
        .filter(Boolean) as HTMLElement[];

      if (!sectionEls.length) return;

      observerRef.current = new IntersectionObserver(
        (entries) => {
          // Find the most visible section (highest intersection ratio)
          const visibleEntries = entries.filter((e) => e.isIntersecting);
          if (visibleEntries.length > 0) {
            // Pick the one closest to the top of the viewport
            const topEntry = visibleEntries.reduce((best, entry) =>
              entry.boundingClientRect.top < best.boundingClientRect.top
                ? entry
                : best,
            );
            const el = topEntry.target as HTMLElement;
            const sectionId = el.id.replace("section-", "");
            const section = navSections.find((s) => s.id === sectionId);
            if (section) {
              setActiveSection(section.sectionKey);
            }
          }
        },
        { threshold: [0.1, 0.3, 0.5], rootMargin: "-80px 0px -40% 0px" },
      );

      sectionEls.forEach((el) => observerRef.current!.observe(el));
    }, 300);

    return () => {
      clearTimeout(timer);
      observerRef.current?.disconnect();
    };
  }, [navSections.map((s) => s.id).join(",")]);

  // Show/hide nav based on cover page visibility
  useEffect(() => {
    if (!coverSection) {
      // No cover page — show nav immediately after a small scroll
      const handler = () => setVisible(window.scrollY > 120);
      window.addEventListener("scroll", handler, { passive: true });
      return () => window.removeEventListener("scroll", handler);
    }

    const coverEl = document.getElementById(`section-${coverSection.id}`);
    if (!coverEl) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        // Show nav when cover page scrolls out of view
        setVisible(!entry.isIntersecting);
      },
      { threshold: 0.1 },
    );

    observer.observe(coverEl);
    return () => observer.disconnect();
  }, [coverSection?.id]);

  // Close mobile menu on outside click
  useEffect(() => {
    if (!mobileOpen) return;
    const handler = (e: MouseEvent) => {
      if (navRef.current && !navRef.current.contains(e.target as Node)) {
        setMobileOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [mobileOpen]);

  const scrollToSection = useCallback(
    (section: CimSection) => {
      const el = document.getElementById(`section-${section.id}`);
      if (!el) return;

      // Smooth scroll with offset for sticky header
      const yOffset = -90;
      const y = el.getBoundingClientRect().top + window.scrollY + yOffset;
      window.scrollTo({ top: y, behavior: "smooth" });

      setActiveSection(section.sectionKey);
      setMobileOpen(false);

      // Fire analytics event
      onNavigate?.(section.sectionKey, section.sectionTitle);
    },
    [onNavigate],
  );

  if (!navSections.length) return null;

  const activeSectionData = navSections.find(
    (s) => s.sectionKey === activeSection,
  );

  return (
    <>
      {/* ── Desktop: Horizontal sticky nav bar ──────────────────────────── */}
      <div
        className={`fixed top-[53px] left-0 right-0 z-30 transition-all duration-300 hidden lg:block ${
          visible
            ? "opacity-100 translate-y-0"
            : "opacity-0 -translate-y-2 pointer-events-none"
        }`}
      >
        <div className="max-w-6xl mx-auto px-6">
          <nav className="flex items-center gap-1 bg-background/95 backdrop-blur-sm border-b border-border/50 px-3 py-1.5 overflow-x-auto scrollbar-hide">
            {navSections.map((section, idx) => {
              const isActive = section.sectionKey === activeSection;
              return (
                <button
                  key={section.id}
                  onClick={() => scrollToSection(section)}
                  className={`shrink-0 px-2.5 py-1 rounded text-[11px] font-medium transition-colors whitespace-nowrap ${
                    isActive
                      ? "bg-teal/10 text-teal"
                      : "text-muted-foreground/60 hover:text-foreground hover:bg-muted/50"
                  }`}
                >
                  {section.sectionTitle}
                </button>
              );
            })}
          </nav>
        </div>
      </div>

      {/* ── Mobile: Floating button + dropdown ──────────────────────────── */}
      <div
        ref={navRef}
        className={`fixed bottom-20 right-4 z-30 lg:hidden transition-all duration-300 ${
          visible
            ? "opacity-100 translate-y-0"
            : "opacity-0 translate-y-4 pointer-events-none"
        }`}
      >
        {/* Dropdown */}
        {mobileOpen && (
          <div className="absolute bottom-14 right-0 w-64 bg-background border border-border rounded-lg shadow-xl overflow-hidden mb-2">
            <div className="px-3 py-2 border-b border-border/50">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Sections
              </p>
            </div>
            <div className="max-h-[50vh] overflow-y-auto py-1">
              {navSections.map((section, idx) => {
                const isActive = section.sectionKey === activeSection;
                return (
                  <button
                    key={section.id}
                    onClick={() => scrollToSection(section)}
                    className={`w-full text-left px-3 py-2 text-xs transition-colors flex items-start gap-2 ${
                      isActive
                        ? "bg-teal/10 text-teal"
                        : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                    }`}
                  >
                    <span className="opacity-40 shrink-0 pt-px">
                      {idx + 1}.
                    </span>
                    <span className="leading-snug">{section.sectionTitle}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* FAB */}
        <button
          onClick={() => setMobileOpen(!mobileOpen)}
          className="flex items-center gap-2 bg-teal text-teal-foreground rounded-full px-4 py-2.5 shadow-lg hover:bg-teal/90 transition-colors"
        >
          <List className="h-4 w-4" />
          <span className="text-xs font-medium max-w-[140px] truncate">
            {activeSectionData?.sectionTitle || "Sections"}
          </span>
          {mobileOpen ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronUp className="h-3.5 w-3.5" />
          )}
        </button>
      </div>

      {/* Print: hide nav */}
      <style>{`@media print { .sticky-cim-nav { display: none !important; } }`}</style>
    </>
  );
}
