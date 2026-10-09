/**
 * The deal's Buyers view, left side: a short ranked list in groups (from the
 * KPI response, computed on the same reading as the cards):
 *   Worth a call · Still reading, not yet a lead · No reading in this period
 *   (date filter only, folded) · Said no or didn't respond (folded) · Access
 *   removed (folded) · Not opened yet (open, with Nudge)
 * A row: rank, name, company, reading time · last seen, status, which CIM
 * version, and a small page strip. ↑ and ↓ move the selection.
 */
import { useState, type KeyboardEvent, type ReactNode } from "react";
import { ChevronDown, Copy, Mail } from "lucide-react";
import { formatReadingTime, type BuyerEngagementCard, type EngagementRange } from "@shared/analytics-v2";
import { dayMonth, rangeLabel, type BuyerGroups, type GroupRow } from "@shared/analytics-dashboard";
import { accessLevelLabel } from "@shared/access-levels";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PageStrip, StatusChip } from "./parts";
import { whenText } from "@/components/analytics/parts";

export type GroupKey = keyof BuyerGroups;

export const GROUP_ORDER: GroupKey[] = ["worthACall", "reading", "quietInRange", "declined", "revoked", "notOpened"];

/** Group headers (the "Worth a call" header names the period when a date filter is on). */
export function groupTitle(key: GroupKey, range: EngagementRange): string {
  switch (key) {
    case "worthACall": return range === "all" ? "Worth a call" : `Worth a call, from reading in the ${rangeLabel(range).replace(/^Last/, "last")}`;
    case "reading": return "Still reading, not yet a lead";
    case "quietInRange": return "No reading in this period";
    case "declined": return "Said no or didn't respond";
    case "revoked": return "Access removed";
    case "notOpened": return "Not opened yet";
  }
}

const FOLDED: Record<GroupKey, boolean> = { worthACall: false, reading: false, quietInRange: true, declined: true, revoked: true, notOpened: false };

/** Every row in list order (↑/↓ walk this). */
export function listOrder(groups: BuyerGroups, range: EngagementRange): GroupRow[] {
  return GROUP_ORDER.filter((k) => k !== "quietInRange" || range !== "all").flatMap((k) => groups[k]);
}

/** The buyer selected when none is chosen: the best lead, else the first still reading (never a folded group's row). */
export function defaultSelection(groups: BuyerGroups): GroupRow | null {
  return groups.worthACall[0] ?? groups.reading[0] ?? null;
}

/** Whether a group starts folded: the quiet group opens when nobody read in the period. */
function foldedByDefault(key: GroupKey, groups: BuyerGroups): boolean {
  if (key === "quietInRange") return groups.worthACall.length + groups.reading.length > 0;
  return FOLDED[key];
}

export interface BuyerListProps {
  groups: BuyerGroups;
  cards: Map<string, BuyerEngagementCard>;
  range: EngagementRange;
  selected: string | null;
  onSelect(accessId: string): void;
  maxMs: number;
  titles: Map<string, string>;
  blindTitles: Map<string, string>;
  /** The deal is live (Nudge applies; otherwise "CIM not live"). */
  live: boolean;
  /** Nudge an unopened buyer: "email" (their profile) or "copy" (their email); null hides the button. */
  nudgeMode(accessId: string): "email" | "copy" | null;
  onNudge(accessId: string): void;
  /** The list head (counts, the legacy chip). */
  head?: ReactNode;
}

export function BuyerList(props: BuyerListProps) {
  const { groups, range } = props;
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const order = listOrder(groups, range);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const i = order.findIndex((r) => r.accessId === props.selected);
    const next = order[Math.min(order.length - 1, Math.max(0, (i < 0 ? -1 : i) + (e.key === "ArrowDown" ? 1 : -1)))];
    if (next) {
      props.onSelect(next.accessId);
      (e.currentTarget.querySelector(`[data-access="${next.accessId}"]`) as HTMLElement | null)?.focus();
    }
  };
  let rank = 0;
  return (
    <div className="min-w-0 space-y-3" onKeyDown={onKey} data-testid="buyer-list">
      {props.head}
      {GROUP_ORDER.map((key) => {
        const rows = groups[key];
        if (key === "quietInRange" && range === "all") return null;
        if (rows.length === 0 && key !== "worthACall") return null;
        if (rows.length === 0 && key === "worthACall" && order.length === 0) return null;
        const folded = open[key] === undefined ? foldedByDefault(key, groups) : !open[key];
        const ranked = key === "worthACall" || key === "reading";
        return (
          <section key={key} data-testid={`group-${key}`}>
            <button
              type="button"
              onClick={() => setOpen((o) => ({ ...o, [key]: folded }))}
              aria-expanded={!folded}
              className="flex w-full items-center gap-2 border-b border-border/70 pb-1.5 text-left"
            >
              <span className="font-mono text-2xs uppercase tracking-[0.12em] text-muted-foreground">
                {groupTitle(key, range)} ({rows.length})
              </span>
              <ChevronDown className={cn("ml-auto h-3.5 w-3.5 text-muted-foreground transition-transform", folded && "-rotate-90")} />
            </button>
            {!folded && (
              rows.length === 0 ? (
                <p className="px-1 py-2 text-xs text-muted-foreground">{range === "all" ? "Nobody right now. Buyers show up here when they read closely, ask a question or say they're interested." : "Nobody in this period."}</p>
              ) : (
                <ol className="mt-1.5 space-y-1">
                  {rows.map((r) => {
                    if (ranked) rank++;
                    return (
                      <li key={r.accessId}>
                        <BuyerListRow
                          row={r}
                          group={key}
                          rank={ranked ? rank : null}
                          card={props.cards.get(r.accessId) ?? null}
                          selected={props.selected === r.accessId}
                          onSelect={() => props.onSelect(r.accessId)}
                          list={props}
                        />
                      </li>
                    );
                  })}
                </ol>
              )
            )}
          </section>
        );
      })}
    </div>
  );
}

export function BuyerListRow({ row, group, rank, card, selected, onSelect, list }: {
  row: GroupRow;
  group: GroupKey;
  rank: number | null;
  card: BuyerEngagementCard | null;
  selected: boolean;
  onSelect(): void;
  list: Pick<BuyerListProps, "maxMs" | "titles" | "blindTitles" | "live" | "nudgeMode" | "onNudge">;
}) {
  const plain = group === "notOpened" || group === "quietInRange" || !card;
  const mode = group === "notOpened" ? list.nudgeMode(row.accessId) : null;
  return (
    <div
      onClick={onSelect}
      className={cn(
        "group relative cursor-pointer rounded-lg border border-transparent transition-colors",
        selected ? "border-l-2 border-l-teal bg-teal/10" : "hover:bg-muted/30",
      )}
    >
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onSelect(); }}
        aria-current={selected || undefined}
        data-access={row.accessId}
        className="flex w-full items-start gap-2.5 px-2.5 py-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal"
        data-testid={`list-row-${row.accessId}`}
      >
        <span className="mt-0.5 w-4 shrink-0 text-right font-mono text-xs tabular-nums text-teal">{rank ?? ""}</span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="min-w-0 truncate text-sm font-medium text-foreground">{row.name}</span>
            {card && group !== "notOpened" && (
              <span className="ml-auto shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground">
                {formatReadingTime(card.activeMs)}{card.lastSeenAt ? ` · ${whenText(card.lastSeenAt)}` : ""}
              </span>
            )}
          </span>
          {row.company && <span className="block truncate text-xs text-muted-foreground">{row.company}</span>}
          {group === "notOpened" ? (
            <span className="mt-0.5 block text-xs text-muted-foreground">
              Access given {whenText(row.grantedAt)} · {row.ndaSigned ? "NDA signed" : "NDA not signed yet"}
            </span>
          ) : group === "quietInRange" ? (
            <span className="mt-0.5 block text-xs text-muted-foreground">{row.lastSeenAt ? `Last read ${dayMonth(row.lastSeenAt)}` : "No reading recorded"}</span>
          ) : !card ? (
            <span className="mt-0.5 block text-xs text-muted-foreground">No reading on this device</span>
          ) : (
            <span className="mt-1 flex flex-wrap items-center gap-1.5">
              <StatusChip status={card.status} label={card.statusLabel} />
              <span className="text-2xs text-muted-foreground">{accessLevelLabel(row.accessLevel)}</span>
            </span>
          )}
        </span>
      </button>
      {!plain && card && card.pageStrip.length > 0 && (
        // Outside the button (the strip has its own buttons); clicks pass through to the row.
        <div className="pointer-events-none px-2.5 pb-2 pl-9" aria-hidden>
          <PageStrip
            cells={card.pageStrip}
            titles={card.mode === "blind" ? list.blindTitles : list.titles}
            maxMs={list.maxMs}
            size="sm"
            caption={false}
          />
        </div>
      )}
      {group === "notOpened" && (
        <div className="px-2.5 pb-2 pl-9">
          {!list.live ? (
            <span className="text-xs text-muted-foreground" title="Buyers can't open it right now">CIM not live</span>
          ) : mode ? (
            <Button
              size="sm" variant="outline" className="h-7 text-xs"
              onClick={(e) => { e.stopPropagation(); list.onNudge(row.accessId); }}
              title={mode === "copy" ? "Copies their email: they don't have a Cimple profile yet" : "Write them a short email (you send it)"}
              data-testid={`nudge-${row.accessId}`}
            >
              {mode === "email" ? <Mail className="mr-1.5 h-3.5 w-3.5" /> : <Copy className="mr-1.5 h-3.5 w-3.5" />}Nudge
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}
