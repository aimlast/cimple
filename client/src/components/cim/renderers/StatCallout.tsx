/**
 * StatCallout renderer
 * Hero stat block with large primary value and optional secondary stats.
 */
import { cn } from "@/lib/utils";
import type { CimBranding } from "../CimBrandingContext";
import type { CimSection } from "@shared/schema";

interface SecondaryStat {
  label: string;
  value: string;
}

interface StatCalloutLayoutData {
  primaryValue?: string;
  primaryLabel?: string;
  secondaryStats?: SecondaryStat[];
  description?: string;
  accentColor?: string;
}

interface RendererProps {
  layoutData: StatCalloutLayoutData;
  content: string;
  branding: CimBranding;
  section: CimSection;
}

export function StatCalloutRenderer({ layoutData, content, branding, section }: RendererProps) {
  const data: StatCalloutLayoutData = layoutData && Object.keys(layoutData).length > 0 ? layoutData : {};

  if (!data.primaryValue && !content) return null;

  const accentHex = data.accentColor || branding.accentHex || branding.primaryHex || "#2dc88e";

  if (!data.primaryValue) {
    return <p className="text-sm text-foreground/70 leading-relaxed">{content}</p>;
  }

  return (
    <div className="bg-card border border-card-border rounded-lg p-8 text-center relative overflow-hidden">
      {/* Subtle background accent */}
      <div
        className="absolute inset-0 opacity-[0.03] pointer-events-none"
        style={{
          background: `radial-gradient(circle at 50% 0%, ${accentHex} 0%, transparent 70%)`
        }}
      />

      <div className="relative z-10">
        {/* Primary value */}
        <div
          className="text-6xl font-semibold tracking-tight leading-none mb-2"
          style={{ color: accentHex }}
        >
          {data.primaryValue}
        </div>

        {/* Primary label */}
        {data.primaryLabel && (
          <p className="text-sm font-medium text-muted-foreground uppercase tracking-widest mt-3">
            {data.primaryLabel}
          </p>
        )}

        {/* Secondary stats */}
        {data.secondaryStats && data.secondaryStats.length > 0 && (
          <div className="flex items-center justify-center gap-8 mt-6 pt-5 border-t border-border flex-wrap">
            {data.secondaryStats.map((stat, i) => (
              <div key={i} className="flex flex-col items-center gap-0.5">
                <span className="text-xl font-semibold tabular-nums text-foreground">{stat.value}</span>
                <span className="text-2xs text-muted-foreground uppercase tracking-wide">{stat.label}</span>
              </div>
            ))}
          </div>
        )}

        {/* Description */}
        {data.description && (
          <p className="text-sm text-muted-foreground mt-5 max-w-lg mx-auto leading-relaxed">
            {data.description}
          </p>
        )}
      </div>
    </div>
  );
}
