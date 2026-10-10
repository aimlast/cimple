/**
 * The seller's two data-room chips on their documents page (vdr spec §7):
 *  - "In the data room": the broker shared this file with buyers who signed
 *    an NDA (never who, never what they did);
 *  - "Needed by Oct 20": the date the broker set when asking for it.
 */
import { CalendarClock, FolderLock } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function neededByLabel(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : `Needed by ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

export function SellerRoomChips({ inDataRoom, neededBy, missing }: { inDataRoom?: boolean; neededBy?: string | null; missing: boolean }) {
  const needed = missing ? neededByLabel(neededBy) : null;
  if (!inDataRoom && !needed) return null;
  return (
    <span className="mt-1 flex flex-wrap gap-1.5">
      {needed && (
        <span className="inline-flex items-center gap-1 rounded-full border border-teal/40 bg-teal/10 px-2 py-0.5 text-[11px] text-teal" data-testid="seller-needed-by">
          <CalendarClock className="h-3 w-3" /> {needed}
        </span>
      )}
      {inDataRoom && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0} className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground" data-testid="seller-in-data-room">
              <FolderLock className="h-3 w-3" /> In the data room
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs text-xs">Your broker has shared this with buyers who signed an NDA.</TooltipContent>
        </Tooltip>
      )}
    </span>
  );
}
