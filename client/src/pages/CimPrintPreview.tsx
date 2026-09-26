/**
 * CimPrintPreview — /deal/:dealId/print?version=normal|blind|dd (broker only).
 *
 * A print-friendly version of the CIM exactly as that version's buyers get
 * it (the same buildBuyerCim rules as the view room: hidden sections out,
 * Blind needs its redacted versions, no business branding in Blind), laid
 * out for paper: the cover and the front pages each on their own page,
 * sections kept whole, everything expanded. A watermark prints on every
 * page. Link-based viewing stays the default for buyers — this is for the
 * broker's own printing and review.
 */
import { useMemo, useState } from "react";
import { useLocation, useParams } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, Loader2, Printer } from "lucide-react";
import type { CimSection, CimSectionOverride, Deal } from "@shared/schema";
import { buildBuyerCim } from "@shared/cim-buyer-view";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { builderRequest, errorText } from "@/components/cim-builder/api";
import { useBuilderState } from "@/components/cim-builder/CimSummaryCard";
import { useMediaLibrary } from "@/components/cim-builder/media/api";
import { useDealDesign } from "@/components/cim-design/api";
import { buildBranding } from "@/components/cim/CimBrandingContext";
import { CimDesignProvider, buildCimDesign } from "@/components/cim/CimDesignContext";
import { CimMediaProvider } from "@/components/cim/CimMediaContext";
import { CimSheet } from "@/components/cim/CimSheet";
import { CimSectionRenderer } from "@/components/cim/CimSectionRenderer";
import { CimContactPage, CimDisclaimerPage, withBrokeragePages } from "@/components/cim/CimFrontBackPages";

type Version = "normal" | "blind" | "dd";
const VERSIONS: Array<{ key: Version; label: string; accessLevel: string }> = [
  { key: "normal", label: "Named CIM", accessLevel: "loi" },
  { key: "blind", label: "Blind CIM", accessLevel: "full" },
  { key: "dd", label: "Due diligence", accessLevel: "due_diligence" },
];

function Watermark({ text }: { text: string }) {
  if (!text.trim()) return null;
  return (
    <div className="cim-watermark fixed inset-0 pointer-events-none z-40 overflow-hidden opacity-[0.06]" aria-hidden>
      <div className="absolute inset-[-20%] flex flex-wrap content-center items-center justify-center gap-x-28 gap-y-24 -rotate-[30deg]">
        {Array.from({ length: 30 }).map((_, i) => (
          <span key={i} className="text-lg font-bold whitespace-nowrap select-none" style={{ color: "#3a3a3a" }}>{text}</span>
        ))}
      </div>
    </div>
  );
}

export default function CimPrintPreview() {
  const { dealId = "" } = useParams<{ dealId: string }>();
  const [, navigate] = useLocation();
  const [version, setVersion] = useState<Version>(() => {
    const v = new URLSearchParams(window.location.search).get("version");
    return v === "blind" || v === "dd" ? v : "normal";
  });
  const meta = VERSIONS.find((v) => v.key === version)!;

  const dealQuery = useQuery<Deal>({
    queryKey: ["/api/deals", dealId],
    queryFn: () => builderRequest<Deal>("GET", `/api/deals/${dealId}`),
    enabled: !!dealId,
  });
  const deal = dealQuery.data;
  const builder = useBuilderState(dealId);
  const media = useMediaLibrary(dealId);
  const design = useDealDesign(dealId);
  const overrideMode = version === "normal" ? null : version;
  const overrides = useQuery<CimSectionOverride[]>({
    queryKey: ["/api/deals", dealId, "cim-overrides", overrideMode ?? "none", "print"],
    queryFn: () => builderRequest<CimSectionOverride[]>("GET", `/api/deals/${dealId}/cim-overrides/${overrideMode}`),
    enabled: !!dealId && !!overrideMode,
  });

  const defaultMark = useMemo(() => {
    const date = new Date().toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    return `${deal?.watermarkText?.trim() || "CONFIDENTIAL"} · ${date}`;
  }, [deal?.watermarkText]);
  const [mark, setMark] = useState<string | null>(null);
  const watermark = mark ?? defaultMark;

  const loading = dealQuery.isLoading || builder.isLoading || design.isLoading || (!!overrideMode && overrides.isLoading);
  const error = dealQuery.error || builder.error || design.error || overrides.error;

  const view = useMemo(() => {
    if (!deal || !builder.data) return null;
    return buildBuyerCim({
      deal,
      accessLevel: meta.accessLevel,
      sections: builder.data.sections as unknown as CimSection[],
      overrides: overrideMode ? overrides.data ?? [] : [],
      media: media.refs,
    });
  }, [deal, builder.data, meta.accessLevel, overrideMode, overrides.data, media.refs]);

  const cimDesign = buildCimDesign(
    design.data ? { template: design.data.template, brokerage: design.data.brokerage, business: design.data.business } : null,
    version,
  );
  const branding = buildBranding(null, deal ?? null);
  const shown = (view?.sections ?? []) as unknown as CimSection[];
  const pages = withBrokeragePages(shown, {
    disclaimer: cimDesign.brokerage.showDisclaimerPage !== false,
    contact: cimDesign.brokerage.showContactPage !== false,
  });

  return (
    <div className="min-h-screen bg-muted/30 print:bg-white">
      {/* ── Toolbar (never printed) ── */}
      <div className="print:hidden sticky top-0 z-50 border-b border-border bg-background/95 backdrop-blur">
        <div className="max-w-[900px] mx-auto px-3 sm:px-6 py-2.5 flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => navigate(`/deal/${dealId}/design`)} aria-label="Back to the CIM builder">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold truncate">{deal?.businessName ?? "CIM"}</p>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Print preview · broker only</p>
          </div>
          <div className="flex rounded-md border border-border p-0.5 bg-muted/30" role="tablist">
            {VERSIONS.map((v) => (
              <button
                key={v.key}
                role="tab"
                aria-selected={version === v.key}
                onClick={() => setVersion(v.key)}
                className={cn("rounded px-2.5 py-1 text-[11px]", version === v.key ? "bg-background text-foreground shadow-sm font-medium" : "text-muted-foreground hover:text-foreground")}
              >
                {v.label}
              </button>
            ))}
          </div>
          <Button size="sm" className="h-8 gap-1.5 bg-teal text-teal-foreground hover:bg-teal/90" onClick={() => window.print()} disabled={loading || shown.length === 0} data-testid="button-print">
            <Printer className="h-3.5 w-3.5" /> Print
          </Button>
        </div>
        <div className="max-w-[900px] mx-auto px-3 sm:px-6 pb-2.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          <span>Watermark on every page:</span>
          <Input value={watermark} onChange={(e) => setMark(e.target.value)} className="h-7 w-64 max-w-full text-xs" maxLength={80} data-testid="input-print-watermark" />
          <span className="hidden sm:inline">Tip: turn on “Background graphics” in the print dialog for the cover colours.</span>
        </div>
      </div>

      <Watermark text={watermark} />

      <div className="cim-print-root max-w-[900px] mx-auto px-3 py-6 sm:px-6 sm:py-8 print:p-0 print:max-w-none">
        {loading ? (
          <Skeleton className="h-[80vh] rounded-xl" />
        ) : error ? (
          <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-6 text-center">
            <AlertTriangle className="h-6 w-6 mx-auto text-red-400 mb-2" />
            <p className="text-sm">Couldn't load the CIM.</p>
            <p className="text-xs text-muted-foreground mt-1">{errorText(error)}</p>
          </div>
        ) : view?.preparing ? (
          <div className="rounded-lg border border-border bg-card p-8 text-center text-sm text-muted-foreground">
            The blind version hasn't been generated yet. Generate it in the CIM builder (Preview as a teaser buyer), then print.
          </div>
        ) : shown.length === 0 ? (
          <div className="rounded-lg border border-border bg-card p-8 text-center text-sm text-muted-foreground">Nothing to print yet.</div>
        ) : (
          <CimMediaProvider value={{}}>
            <CimDesignProvider design={cimDesign} sections={shown}>
              {version === "blind" && view && view.heldBack > 0 && (() => {
                // Held back for good (the redaction keeps failing) vs. still being redacted.
                const held = (builder.data?.sections ?? []).filter((s) => s.blindStatus === "held" && s.isVisible !== false);
                const waiting = Math.max(0, view.heldBack - held.length);
                return (
                  <div className="print:hidden mb-3 space-y-1 text-xs">
                    {held.length > 0 && (
                      <p className="text-red-400 flex items-start gap-1.5">
                        <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                        <span>
                          Left out of the blind version: {held.map((s) => `“${s.sectionTitle}”`).join(", ")}
                          {held[0].blindError ? ` — ${held[0].blindError}` : ""}. Use “Redo blind version” on the section in the CIM builder.
                        </span>
                      </p>
                    )}
                    {waiting > 0 && (
                      <p className="text-amber-500 flex items-center gap-1.5">
                        <Loader2 className="h-3 w-3 animate-spin" /> {waiting} section{waiting === 1 ? " is" : "s are"} still being redacted and left out.
                      </p>
                    )}
                  </div>
                );
              })()}
              <CimSheet className="px-5 py-6 sm:px-12 sm:py-12">
                {pages.map((item, i) => {
                  const next = pages[i + 1];
                  // Cover and front pages end their page; the contact page starts one.
                  const breakAfter =
                    (item.kind === "section" && item.section.layoutType === "cover_page") ||
                    item.kind === "disclaimer" ||
                    next?.kind === "contact";
                  return (
                    <div key={item.key} className={cn(breakAfter && "cim-print-page-break")}>
                      {item.kind === "disclaimer" ? (
                        <CimDisclaimerPage />
                      ) : item.kind === "contact" ? (
                        <CimContactPage />
                      ) : (
                        <CimSectionRenderer section={item.section} branding={branding} />
                      )}
                    </div>
                  );
                })}
              </CimSheet>
            </CimDesignProvider>
          </CimMediaProvider>
        )}
      </div>
    </div>
  );
}
