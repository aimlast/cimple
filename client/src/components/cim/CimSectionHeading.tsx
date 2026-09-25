/**
 * CimSectionHeading — a section's title in the template's header style.
 *
 *   plain     bold title (Classic Paper — the original look)
 *   rule      title over a hairline rule with a short accent segment
 *   band      title on a solid accent band (Bold Brand)
 *   numbered  "01" chapter number beside the title (Executive Navy)
 *
 * Colours come from `--cim-*` variables (template), fonts from the
 * `.cim-heading` class (index.css). `number` is the chapter number from
 * CimDesignProvider; without one, "numbered" reads like "rule".
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useCimTheme } from "./CimDesignContext";

export function CimSectionHeading({
  title,
  number,
  aside,
  className,
}: {
  title: ReactNode;
  number?: number;
  /** Broker chrome shown at the right (e.g. "hidden"). */
  aside?: ReactNode;
  className?: string;
}) {
  const theme = useCimTheme();
  const style = theme.headerStyle;

  if (style === "band") {
    return (
      <div className={cn("mb-5 flex items-start justify-between gap-4", className)}>
        <h2
          className="cim-heading flex-1 min-w-0 rounded-md px-4 py-2.5 text-lg sm:text-xl tracking-tight leading-snug break-words"
          style={{ backgroundColor: theme.accent, color: theme.onAccent }}
        >
          {title}
        </h2>
        {aside}
      </div>
    );
  }

  if (style === "numbered" && number !== undefined) {
    return (
      <div className={cn("mb-5 flex items-start justify-between gap-4", className)}>
        <div className="flex items-baseline gap-3 sm:gap-4 min-w-0 flex-1 border-b pb-3" style={{ borderColor: theme.line }}>
          <span
            className="cim-display text-2xl sm:text-3xl leading-none tabular-nums shrink-0"
            style={{ color: theme.accent2, fontWeight: 400 }}
            aria-hidden
          >
            {String(number).padStart(2, "0")}
          </span>
          <h2 className="cim-heading text-xl sm:text-2xl tracking-tight leading-tight min-w-0 break-words">{title}</h2>
        </div>
        {aside}
      </div>
    );
  }

  if (style === "rule" || style === "numbered") {
    return (
      <div className={cn("mb-5 flex items-start justify-between gap-4", className)}>
        <div className="relative min-w-0 flex-1 pb-2.5">
          <h2 className="cim-heading text-xl tracking-tight leading-snug break-words">{title}</h2>
          <div className="absolute left-0 right-0 bottom-0 h-px" style={{ backgroundColor: theme.line }} />
          <div className="absolute left-0 bottom-0 h-[2px] w-12" style={{ backgroundColor: theme.accent }} />
        </div>
        {aside}
      </div>
    );
  }

  return (
    <div className={cn("mb-4 flex items-start justify-between gap-4", className)}>
      <h2 className="cim-heading text-xl tracking-tight">{title}</h2>
      {aside}
    </div>
  );
}
