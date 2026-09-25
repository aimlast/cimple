/**
 * MapEditor — the location map's inspector: addresses (label, address,
 * note), a live map preview of the location being edited, zoom, caption,
 * and what the blind CIM shows (province/state only, or no map). Each
 * address says exactly what a blind buyer will see.
 */
import { useEffect, useState } from "react";
import { EyeOff, MapPin, Plus, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { MEDIA_LIMITS, clampZoom, mapEmbedUrl, regionFromAddress } from "@shared/cim-media";
import { cn } from "@/lib/utils";
import { FieldLabel, RowActions, Segmented, moveItem } from "./parts";
import type { MediaDraftChange } from "./api";

interface Loc { label?: string; address?: string; note?: string }

const ZOOMS = [
  { key: "17", label: "Street" },
  { key: "14", label: "Area" },
  { key: "12", label: "Town" },
  { key: "9", label: "Region" },
];

interface Props {
  value: Record<string, any>;
  onChange: MediaDraftChange;
  disabled?: boolean;
}

export function MapEditor({ value, onChange, disabled }: Props) {
  const locations: Loc[] = Array.isArray(value.locations) ? value.locations : [];
  const setLocations = (next: Loc[]) => onChange({ ...value, locations: next });
  const [focus, setFocus] = useState(0);
  const zoom = clampZoom(value.zoom);
  const zoomKey = ZOOMS.reduce((best, z) => (Math.abs(+z.key - zoom) < Math.abs(+best.key - zoom) ? z : best), ZOOMS[1]).key;
  const blindHide = value.blindMap === "hide";

  // Preview follows the address being edited, after typing pauses.
  const target = locations[Math.min(focus, Math.max(0, locations.length - 1))]?.address?.trim() || "";
  const [preview, setPreview] = useState(target);
  useEffect(() => {
    const t = setTimeout(() => setPreview(target), 700);
    return () => clearTimeout(t);
  }, [target]);

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <FieldLabel>Preview</FieldLabel>
        <div className="relative aspect-[4/3] overflow-hidden rounded-md border border-border bg-muted/40">
          {preview ? (
            <iframe
              key={`${preview}-${zoom}`}
              src={mapEmbedUrl(preview, zoom)}
              title="Map preview"
              loading="lazy"
              referrerPolicy="strict-origin-when-cross-origin"
              className="absolute inset-0 h-full w-full border-0"
            />
          ) : (
            <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-xs text-muted-foreground">
              <MapPin className="h-5 w-5 opacity-60" /> Type an address to see the map
            </span>
          )}
        </div>
        <Segmented value={zoomKey} options={ZOOMS} onChange={(z) => onChange({ ...value, zoom: Number(z) })} disabled={disabled} />
      </div>

      <div className="space-y-2">
        <FieldLabel>Locations</FieldLabel>
        {locations.map((loc, i) => {
          const region = regionFromAddress(loc.address);
          const update = (patch: Partial<Loc>) => setLocations(locations.map((x, j) => (j === i ? { ...x, ...patch } : x)));
          return (
            <div
              key={i}
              className={cn("rounded-lg border p-2 space-y-1.5", focus === i ? "border-teal/50" : "border-border")}
              onFocusCapture={() => setFocus(i)}
            >
              <div className="flex items-center gap-2">
                <Input value={loc.label ?? ""} maxLength={MEDIA_LIMITS.titleChars} disabled={disabled} onChange={(e) => update({ label: e.target.value })} placeholder="Label, e.g. Main clinic" className="h-8 text-xs flex-1 min-w-0" />
                <RowActions index={i} count={locations.length} noun="location" disabled={disabled} onMove={(a, b) => { setLocations(moveItem(locations, a, b)); setFocus(b); }} onRemove={() => setLocations(locations.filter((_, j) => j !== i))} />
              </div>
              <Textarea
                value={loc.address ?? ""}
                maxLength={MEDIA_LIMITS.addressChars}
                disabled={disabled}
                rows={2}
                onChange={(e) => update({ address: e.target.value })}
                placeholder="Street address, city, province/state, postal code"
                className="text-xs min-h-0 resize-none"
                data-testid={`input-map-address-${i}`}
              />
              <Input value={loc.note ?? ""} maxLength={MEDIA_LIMITS.captionChars} disabled={disabled} onChange={(e) => update({ note: e.target.value })} placeholder="Note (optional), e.g. 2,400 sq ft, leased to 2031" className="h-8 text-xs" />
              {loc.address?.trim() && (
                <p className={cn("flex items-start gap-1 text-[11px] leading-snug", blindHide ? "text-muted-foreground" : region ? "text-emerald-500" : "text-amber-500")}>
                  {blindHide ? <EyeOff className="h-3 w-3 mt-px shrink-0" /> : <ShieldCheck className="h-3 w-3 mt-px shrink-0" />}
                  {blindHide
                    ? "Blind CIM: the map is hidden."
                    : region
                      ? `Blind CIM shows only: ${region}`
                      : "We can't tell the province or state from this address, so blind buyers won't see this location. Add it (e.g. “ON”)."}
                </p>
              )}
            </div>
          );
        })}
        {locations.length < MEDIA_LIMITS.locations && (
          <Button type="button" size="sm" variant="outline" className="h-7 text-xs gap-1" disabled={disabled} onClick={() => { setLocations([...locations, { label: "", address: "" }]); setFocus(locations.length); }}>
            <Plus className="h-3.5 w-3.5" /> Add a location
          </Button>
        )}
      </div>

      <div className="space-y-1.5">
        <FieldLabel>Caption</FieldLabel>
        <Input value={value.caption ?? ""} maxLength={MEDIA_LIMITS.captionChars} disabled={disabled} onChange={(e) => onChange({ ...value, caption: e.target.value })} placeholder="Optional, e.g. Minutes from Highway 403" className="h-8 text-xs" />
      </div>

      <div className="space-y-1.5">
        <FieldLabel>In the blind CIM</FieldLabel>
        <Segmented
          value={blindHide ? "hide" : "region"}
          options={[{ key: "region", label: "Province/state only" }, { key: "hide", label: "Hide the map" }]}
          onChange={(v) => onChange({ ...value, blindMap: v })}
          disabled={disabled}
        />
        <p className="text-[11px] text-muted-foreground leading-snug">
          Blind buyers never see the street address or city. {blindHide ? "This map is left out of the blind CIM." : "They see a wide map of the province or state, marked “general area only”."}
        </p>
      </div>
    </div>
  );
}
