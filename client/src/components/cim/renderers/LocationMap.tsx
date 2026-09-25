/**
 * LocationMap renderer — an interactive Google map (keyless embed, lazy
 * loaded) with the address cards beside it; clicking a card moves the map.
 *
 * Blind CIM: the server has already reduced every location to its
 * province/state (`regionOnly`), so the map shows the region at a wide zoom
 * and the cards say so. The exact address never reaches a blind buyer.
 */
import { useState } from "react";
import { ExternalLink, Lock, MapPin } from "lucide-react";
import type { CimSection } from "@shared/schema";
import { REGION_ZOOM, clampZoom, mapEmbedUrl, mapLinkUrl, normalizeLocationMap, type MapLocation } from "@shared/cim-media";
import { cn } from "@/lib/utils";
import type { CimBranding } from "../CimBrandingContext";

interface RendererProps {
  layoutData: Record<string, unknown>;
  content: string;
  branding: CimBranding;
  section: CimSection;
  brokerMode?: boolean;
}

export function LocationMapRenderer({ layoutData, brokerMode }: RendererProps) {
  const raw = (layoutData || {}) as Record<string, unknown>;
  const regionOnly = raw.regionOnly === true;
  const data = normalizeLocationMap(raw);
  // Read the rows directly: blind rows carry `region` and may have no label.
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const locations: MapLocation[] = (Array.isArray(raw.locations) ? raw.locations : [])
    .filter((l): l is Record<string, unknown> => !!l && typeof l === "object")
    .map((l) => ({ label: text(l.label), address: text(l.address), note: text(l.note), region: text(l.region) }))
    .filter((l) => (regionOnly ? !!l.region : !!l.address));
  const [active, setActive] = useState(0);

  if (locations.length === 0) {
    return brokerMode ? (
      <div className="rounded-lg border border-dashed border-border bg-card/60 px-4 py-10 text-center">
        <MapPin className="mx-auto h-6 w-6 text-muted-foreground/60" />
        <p className="mt-2 text-sm text-muted-foreground">No address yet</p>
        <p className="text-xs text-muted-foreground/70 mt-0.5">Add the premises' address in the editor to show the map.</p>
      </div>
    ) : null;
  }

  const current = locations[Math.min(active, locations.length - 1)];
  const query = regionOnly ? current.region! : current.address!;
  const zoom = regionOnly ? REGION_ZOOM : clampZoom(data.zoom);

  return (
    <div>
      {data.title && (
        <h3 className="text-sm font-semibold text-foreground/60 uppercase tracking-widest mb-4">{data.title}</h3>
      )}
      <div className="grid gap-4 md:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="relative overflow-hidden rounded-lg border border-card-border bg-[#F2EEE3] aspect-[4/3] md:aspect-auto md:min-h-[320px]">
          <iframe
            key={`${query}-${zoom}`}
            src={mapEmbedUrl(query, zoom)}
            title={regionOnly ? `Map of ${query}` : `Map of ${current.label || query}`}
            loading="lazy"
            referrerPolicy="strict-origin-when-cross-origin"
            className="absolute inset-0 h-full w-full border-0 print:hidden"
            allowFullScreen
          />
          <div className="hidden print:flex absolute inset-0 items-center justify-center text-xs text-muted-foreground">
            <MapPin className="h-4 w-4 mr-1" /> Interactive map in the online CIM
          </div>
        </div>

        <div className="flex flex-col gap-2.5">
          {locations.map((loc, i) => {
            const selected = i === active;
            const Tag = locations.length > 1 ? "button" : "div";
            return (
              <Tag
                key={i}
                {...(locations.length > 1 ? { type: "button", onClick: () => setActive(i), "aria-pressed": selected } : {})}
                className={cn(
                  "w-full text-left rounded-lg border bg-card p-4 transition-colors",
                  selected && locations.length > 1 ? "border-teal/60 shadow-sm" : "border-card-border",
                  locations.length > 1 && "hover:border-teal/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal",
                )}
              >
                <div className="flex items-start gap-3">
                  <span className={cn(
                    "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
                    selected ? "bg-teal text-white" : "bg-[#F2EEE3] text-teal",
                  )}>
                    <MapPin className="h-3.5 w-3.5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    {loc.label && <p className="text-[11px] font-semibold uppercase tracking-wider text-teal">{loc.label}</p>}
                    <p className="text-sm font-medium text-foreground leading-snug mt-0.5">
                      {regionOnly ? loc.region : loc.address}
                    </p>
                    {loc.note && <p className="mt-1.5 text-xs text-muted-foreground leading-snug">{loc.note}</p>}
                    {!regionOnly && selected && (
                      <a
                        href={mapLinkUrl(loc.address!)}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-teal hover:underline print:hidden"
                      >
                        Open in Google Maps <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </div>
                </div>
              </Tag>
            );
          })}
          {regionOnly && (
            <p className="flex items-start gap-1.5 px-1 text-[11px] text-muted-foreground leading-snug">
              <Lock className="h-3 w-3 mt-0.5 shrink-0" />
              General area only. The exact location is shared later in the process.
            </p>
          )}
        </div>
      </div>
      {data.caption && <p className="mt-3 text-xs text-muted-foreground leading-snug">{data.caption}</p>}
    </div>
  );
}
