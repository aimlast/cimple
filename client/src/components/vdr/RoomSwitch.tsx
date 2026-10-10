/**
 * "Memorandum | Data room" — the two-way switch in the view room's sticky
 * header (vdr spec §6.1). At 1440 it sits in the header's centre; on phones
 * it is a second sticky row of two equal buttons (the caller places it).
 */
import { Link } from "wouter";
import { cn } from "@/lib/utils";

export function RoomSwitch({ token, active, newCount, className, full }: { token: string; active: "memo" | "room"; newCount?: number; className?: string; full?: boolean }) {
  const base = `/view/${encodeURIComponent(token)}`;
  const item = (on: boolean) =>
    cn(
      "inline-flex items-center justify-center gap-1.5 rounded-[5px] px-3 py-1.5 text-xs font-medium transition-colors",
      full && "flex-1",
      on ? "bg-teal/15 text-teal" : "text-muted-foreground hover:text-foreground",
    );
  return (
    <nav className={cn("inline-flex rounded-md border border-border bg-background p-0.5", full && "flex w-full", className)} aria-label="Memorandum or data room" data-testid="room-switch">
      <Link href={base} className={item(active === "memo")} aria-current={active === "memo" ? "page" : undefined}>Memorandum</Link>
      <Link href={`${base}/data-room`} className={item(active === "room")} aria-current={active === "room" ? "page" : undefined}>
        Data room
        {!!newCount && newCount > 0 && <span className="rounded-full bg-teal px-1.5 text-[10px] font-semibold leading-4 text-teal-foreground">{newCount} new</span>}
      </Link>
    </nav>
  );
}
