/**
 * The dashboards' tab bar: Radix Tabs (arrow keys come free) styled as an
 * underline bar. The active tab is brass with a 2 px brass underline; counts
 * sit in a small pill ("·" while they load). Below 640 px each tab shows its
 * short label; if the bar still overflows it scrolls sideways with an edge
 * fade, and the active tab scrolls into view. An optional `right` slot holds
 * controls that belong to the bar (the deal tab's filters).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "@/lib/utils";

export interface DashboardTab {
  key: string;
  label: string;
  /** Below 640 px. */
  shortLabel?: string;
  /** A number, "loading" (shows "·") or undefined (no pill). */
  count?: number | "loading" | null;
  testId?: string;
}

export function DashboardTabBar({
  tabs, value, onChange, right, rightClassName, ariaLabel, sticky, children, className,
}: {
  tabs: DashboardTab[];
  value: string;
  onChange(key: string): void;
  right?: ReactNode;
  /** Where the right slot goes at each width (e.g. its own line below lg). */
  rightClassName?: string;
  ariaLabel: string;
  /** Stick to the top of the scrolling pane (the deal tab on phones). */
  sticky?: boolean;
  /** The active tab's content. */
  children?: ReactNode;
  className?: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  // The edge fade shows only when the tabs don't fit (never dims a tab that does).
  const [overflow, setOverflow] = useState(false);
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const check = () => setOverflow(list.scrollWidth > list.clientWidth + 1);
    check();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(check);
    ro.observe(list);
    return () => ro.disconnect();
  }, [tabs.length]);
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[data-state="active"]');
    el?.scrollIntoView?.({ inline: "nearest", block: "nearest" });
  }, [value]);
  return (
    <TabsPrimitive.Root value={value} onValueChange={onChange} className={className} activationMode="manual">
      <div
        className={cn(
          "flex flex-wrap items-end gap-x-4 gap-y-2 border-b border-border",
          sticky && "sticky top-0 z-20 -mx-4 bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:static sm:mx-0 sm:bg-transparent sm:px-0 sm:backdrop-blur-none",
        )}
      >
        <div className="relative min-w-0 flex-1">
          <TabsPrimitive.List
            ref={listRef}
            aria-label={ariaLabel}
            className={cn(
              "-mb-px flex min-w-0 items-end gap-0.5 overflow-x-auto sm:gap-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
              overflow && "[mask-image:linear-gradient(to_right,#000_calc(100%-20px),transparent)]",
            )}
            data-testid="dashboard-tabs"
          >
            {tabs.map((t) => (
              <TabsPrimitive.Trigger
                key={t.key}
                value={t.key}
                className={cn(
                  "group inline-flex shrink-0 items-center gap-1 whitespace-nowrap border-b-2 border-transparent px-1.5 py-2.5 text-[13px] font-medium text-muted-foreground transition-colors first:pl-0.5 sm:gap-1.5 sm:px-3 sm:text-sm",
                  "hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal",
                  "data-[state=active]:border-teal data-[state=active]:text-teal",
                )}
                data-testid={t.testId ?? `tab-${t.key}`}
              >
                {t.shortLabel ? (
                  <>
                    <span className="sm:hidden">{t.shortLabel}</span>
                    <span className="hidden sm:inline">{t.label}</span>
                  </>
                ) : (
                  <span>{t.label}</span>
                )}
                {t.count != null && (
                  <span
                    className={cn(
                      "rounded-full bg-muted px-1 text-[11px] leading-[18px] tabular-nums text-muted-foreground sm:px-1.5",
                      "group-data-[state=active]:bg-teal/15 group-data-[state=active]:text-teal",
                    )}
                  >
                    {t.count === "loading" ? "·" : t.count}
                  </span>
                )}
              </TabsPrimitive.Trigger>
            ))}
          </TabsPrimitive.List>
        </div>
        {right && <div className={cn("flex shrink-0 items-center gap-2 pb-1.5", rightClassName)}>{right}</div>}
      </div>
      {children != null && (
        <TabsPrimitive.Content value={value} className="focus-visible:outline-none" tabIndex={-1}>
          {children}
        </TabsPrimitive.Content>
      )}
    </TabsPrimitive.Root>
  );
}
