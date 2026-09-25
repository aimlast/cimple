/**
 * Previews of a CIM design drawn with the real renderers on the sample CIM:
 *   <CimPreview>        a live, full-size (or scaled) paper preview
 *   <TemplateThumbnail> two scaled "pages" (cover + a content page) for galleries
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { CimSection } from "@shared/schema";
import { CimDesignProvider, type CimDesign } from "@/components/cim/CimDesignContext";
import { CimSheet } from "@/components/cim/CimSheet";
import { CimSectionRenderer } from "@/components/cim/CimSectionRenderer";
import { CimContactPage, CimDisclaimerPage, withBrokeragePages } from "@/components/cim/CimFrontBackPages";
import { buildBranding } from "@/components/cim/CimBrandingContext";
import { cn } from "@/lib/utils";
import { SAMPLE_CHART, SAMPLE_CIM, SAMPLE_COVER, SAMPLE_METRICS } from "./sampleCim";

const SAMPLE_BRANDING = buildBranding(null, { businessName: "Northwind Mechanical", industry: "Commercial HVAC" });

/** Renders `children` at `baseWidth` px and scales it to fit the container width. */
export function Scaled({ baseWidth, height, children, className }: { baseWidth: number; height?: number; children: ReactNode; className?: string }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.25);
  const [innerHeight, setInnerHeight] = useState(0);
  useLayoutEffect(() => {
    const el = outer.current;
    if (!el) return;
    const update = () => {
      setScale(el.clientWidth / baseWidth);
      if (inner.current) setInnerHeight(inner.current.scrollHeight);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    if (inner.current) ro.observe(inner.current);
    return () => ro.disconnect();
  }, [baseWidth]);
  const h = height !== undefined ? height * scale : innerHeight * scale;
  return (
    <div ref={outer} className={cn("relative overflow-hidden", className)} style={{ height: h }}>
      <div
        ref={inner}
        className="absolute left-0 top-0 origin-top-left pointer-events-none select-none"
        style={{ width: baseWidth, transform: `scale(${scale})`, height: height }}
        aria-hidden
      >
        {children}
      </div>
    </div>
  );
}

/** The sample CIM (or some of it) in a design. */
export function CimPreview({
  design,
  sections = SAMPLE_CIM,
  brokeragePages = true,
  className,
}: {
  design: CimDesign;
  sections?: CimSection[];
  brokeragePages?: boolean;
  className?: string;
}) {
  const pages = withBrokeragePages(sections, {
    disclaimer: brokeragePages && design.brokerage.showDisclaimerPage !== false,
    contact: brokeragePages && design.brokerage.showContactPage !== false,
  });
  return (
    <CimDesignProvider design={design} sections={sections}>
      <CimSheet className={cn("px-5 py-6 sm:px-8 sm:py-9", className)}>
        {pages.map((item) =>
          item.kind === "disclaimer" ? (
            <CimDisclaimerPage key={item.key} />
          ) : item.kind === "contact" ? (
            <CimContactPage key={item.key} />
          ) : (
            <CimSectionRenderer key={item.key} section={item.section} branding={SAMPLE_BRANDING} />
          ),
        )}
      </CimSheet>
    </CimDesignProvider>
  );
}

const PAGE_W = 720;
const PAGE_H = 940;

/** Cover + a content page, scaled down side by side. */
export function TemplateThumbnail({ design, className }: { design: CimDesign; className?: string }) {
  return (
    <CimDesignProvider design={design} sections={[SAMPLE_COVER, SAMPLE_METRICS, SAMPLE_CHART]}>
      <div className={cn("grid grid-cols-2 gap-2", className)}>
        <Scaled baseWidth={PAGE_W} height={PAGE_H} className="rounded-sm shadow-sm ring-1 ring-black/5">
          <CimSheet flow={false} className="h-full !rounded-none !border-0 !shadow-none p-5">
            <div className="[&_.cim-print-cover]:!min-h-[898px]">
              <CimSectionRenderer section={SAMPLE_COVER} branding={SAMPLE_BRANDING} />
            </div>
          </CimSheet>
        </Scaled>
        <Scaled baseWidth={PAGE_W} height={PAGE_H} className="rounded-sm shadow-sm ring-1 ring-black/5">
          <CimSheet className="h-full !rounded-none !border-0 !shadow-none px-10 py-10">
            <CimSectionRenderer section={SAMPLE_METRICS} branding={SAMPLE_BRANDING} />
            <CimSectionRenderer section={SAMPLE_CHART} branding={SAMPLE_BRANDING} />
          </CimSheet>
        </Scaled>
      </div>
    </CimDesignProvider>
  );
}
