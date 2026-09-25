/**
 * CimDesignCard — the CIM tab's "Design" block: the deal's template, its
 * branding at a glance, and small previews of the real cover and the
 * brokerage pages (disclaimer / contact) as the named CIM shows them.
 */
import { Palette, Printer } from "lucide-react";
import type { CimSection } from "@shared/schema";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { buildBranding } from "@/components/cim/CimBrandingContext";
import { CimDesignProvider, buildCimDesign } from "@/components/cim/CimDesignContext";
import { CimMediaProvider } from "@/components/cim/CimMediaContext";
import { CimSheet } from "@/components/cim/CimSheet";
import { CimSectionRenderer } from "@/components/cim/CimSectionRenderer";
import { CimContactPage, CimDisclaimerPage } from "@/components/cim/CimFrontBackPages";
import { useDealDesign } from "./api";
import { Scaled } from "./CimPreview";

export function CimDesignCard({
  dealId,
  deal,
  cover,
  onOpenDesign,
}: {
  dealId: string;
  deal: { businessName: string; industry?: string | null };
  cover: CimSection | null;
  onOpenDesign: () => void;
}) {
  const q = useDealDesign(dealId);
  if (q.isLoading) return <Skeleton className="h-48 rounded-lg" />;
  if (q.isError || !q.data) return null;
  const d = q.data;
  const design = buildCimDesign({ template: d.template, brokerage: d.brokerage, business: d.business }, "normal");
  const branding = buildBranding(null, deal);
  const b = d.business;
  const businessBits = [b.logoMediaId && "logo", b.coverPhotoMediaId && "cover photo", b.useBusinessColors && "colours"].filter(Boolean);
  const pages = [
    cover && { key: "cover", label: "Cover", node: <CimSectionRenderer section={cover} branding={branding} /> },
    design.brokerage.showDisclaimerPage && { key: "disclaimer", label: "Disclaimer page", node: <CimDisclaimerPage /> },
    design.brokerage.showContactPage && { key: "contact", label: "Contact page", node: <CimContactPage /> },
  ].filter(Boolean) as Array<{ key: string; label: string; node: React.ReactNode }>;

  return (
    <section className="space-y-3" data-testid="cim-design-card">
      <div className="flex items-end justify-between gap-3">
        <h3 className="text-sm font-semibold">Design</h3>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" className="h-7 text-xs gap-1" onClick={() => window.open(`/deal/${dealId}/print?version=normal`, "_blank", "noopener")}>
            <Printer className="h-3.5 w-3.5" /> Print preview
          </Button>
          <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={onOpenDesign} data-testid="button-change-design">
            <Palette className="h-3.5 w-3.5" /> Change design
          </Button>
        </div>
      </div>
      <div className="rounded-lg border border-border bg-card p-4 space-y-4">
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
          <p><span className="text-muted-foreground">Template: </span><span className="font-medium">{d.template.name}</span>{d.templateId === null && <span className="text-muted-foreground"> (your default)</span>}</p>
          <p><span className="text-muted-foreground">Business branding: </span>{businessBits.length ? businessBits.join(", ") : "none"} <span className="text-muted-foreground">· never in the blind CIM</span></p>
          <p><span className="text-muted-foreground">Brokerage: </span>{d.brokerage.firmName || "no firm name yet"}</p>
        </div>
        <CimMediaProvider value={{}}>
          <CimDesignProvider design={design}>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {pages.map((p) => (
                <div key={p.key} className="space-y-1.5">
                  <Scaled baseWidth={760} height={1000} className="rounded-md ring-1 ring-border bg-muted/40">
                    <CimSheet flow={false} className="h-full !rounded-none !border-0 !shadow-none p-8 [&_.cim-print-cover]:!min-h-[936px]">
                      {p.node}
                    </CimSheet>
                  </Scaled>
                  <p className="text-[11px] text-muted-foreground text-center">{p.label}</p>
                </div>
              ))}
            </div>
          </CimDesignProvider>
        </CimMediaProvider>
      </div>
    </section>
  );
}
