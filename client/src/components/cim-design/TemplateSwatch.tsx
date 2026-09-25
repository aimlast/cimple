/**
 * A tiny drawing of a template (cover colour, heading, chart colours) —
 * light enough to show many at once in pickers. Galleries use the real
 * renderers instead (TemplateThumbnail).
 */
import { fontStack, type ResolvedCimTheme } from "@shared/cim-theme";
import { cn } from "@/lib/utils";

export function TemplateSwatch({ theme, className }: { theme: ResolvedCimTheme; className?: string }) {
  const coverLight = theme.coverStyle === "light";
  return (
    <div
      className={cn("relative overflow-hidden rounded-md ring-1 ring-black/10 shrink-0", className)}
      style={{ backgroundColor: theme.paper }}
      aria-hidden
    >
      <div
        className="h-[42%] w-full flex flex-col justify-end px-1.5 pb-1"
        style={{ background: coverLight ? theme.paper : theme.coverBg, borderBottom: coverLight ? `1px solid ${theme.line}` : undefined }}
      >
        {coverLight && <div className="absolute left-0 top-0 h-[42%] w-[3px]" style={{ backgroundColor: theme.accent }} />}
        <div className="h-[3px] w-4 rounded-full mb-0.5" style={{ backgroundColor: theme.coverAccent }} />
        <div className="text-[7px] leading-none truncate" style={{ color: theme.coverInk, fontFamily: fontStack(theme.headingFont), fontWeight: 700 }}>
          Aa
        </div>
      </div>
      <div className="px-1.5 pt-1">
        {theme.headerStyle === "band" ? (
          <div className="h-[5px] w-full rounded-[1px]" style={{ backgroundColor: theme.accent }} />
        ) : (
          <div className="h-[4px] w-2/3 rounded-full" style={{ backgroundColor: theme.heading }} />
        )}
        <div className="flex items-end gap-[2px] mt-1.5 h-4">
          {theme.chart.slice(0, 4).map((c, i) => (
            <div key={i} className="flex-1 rounded-t-[1px]" style={{ backgroundColor: c, height: `${45 + i * 18}%` }} />
          ))}
        </div>
      </div>
    </div>
  );
}
