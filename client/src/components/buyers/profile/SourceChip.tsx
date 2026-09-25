/**
 * Small chip naming where a profile value came from (Buyer / NDA / Pipedrive
 * / CSV / Your edit …). Hover shows when, which deal, and — for CRM values —
 * the quote from the record it was read from.
 */
import type { MergedFieldSource } from "@shared/schema";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SOURCE_META, relTime, shortDate } from "./types";

export function SourceChip({
  source,
  dealNames,
  crmProvider,
  className = "",
}: {
  source: MergedFieldSource | null | undefined;
  dealNames?: Record<string, string>;
  crmProvider?: string | null;
  className?: string;
}) {
  if (!source) return null;
  const meta = SOURCE_META[source.source] ?? { label: source.source, chip: "border-border bg-muted/40 text-muted-foreground", describe: "" };
  const label = source.source === "crm" && crmProvider && crmProvider !== "pipedrive" ? crmProvider[0].toUpperCase() + crmProvider.slice(1) : meta.label;
  const deal = source.dealId && dealNames?.[source.dealId];
  const describe = source.source === "crm" && source.layer === "own" ? "Contact details copied from your CRM when they were imported" : meta.describe;
  return (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-2xs font-medium leading-4 whitespace-nowrap cursor-default ${meta.chip} ${className}`}
          data-testid={`source-chip-${source.source}`}
        >
          {label}
          {source.inferred && <span className="opacity-70">· inferred</span>}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs text-xs leading-relaxed">
        <p className="font-medium">{describe}{deal ? ` (${deal})` : ""}</p>
        {source.at && <p className="text-muted-foreground">{shortDate(source.at)} · {relTime(source.at)}</p>}
        {source.legacy && <p className="text-muted-foreground">Recorded before Cimple tracked sources — this is our best guess.</p>}
        {source.inferred && <p className="text-muted-foreground">Worked out from their CRM history rather than stated outright.</p>}
        {source.evidence && <p className="mt-1 italic text-foreground/90">“{source.evidence}”</p>}
      </TooltipContent>
    </Tooltip>
  );
}
