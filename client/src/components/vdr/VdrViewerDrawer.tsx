/**
 * VdrViewerDrawer — a data-room document beside the CIM (vdr spec §6.6).
 *
 * Opened by a citation chip (or a data-room link inside the CIM). A right
 * drawer at 62vw on desktop, a full-screen sheet on phones, holding the same
 * secure viewer as the room (watermarked pages, the buyer's own view and
 * trace), opened at the cited page — or the page that prints the cited
 * figure when there's no page — or the cited sheet and rows. "Open in the
 * data room" leaves the CIM for the room. A replaced document opens its new
 * version, labelled "Updated version", without the old page anchor.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, FileWarning, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { BuyerItemAbout } from "@shared/vdr-api";
import { vdrBuyerHref } from "@shared/vdr";
import { vdrFetch, type VdrRequestError, type VdrSource } from "@/hooks/useDataRoom";
import { VdrViewer } from "./VdrViewer";

export type DrawerTarget = {
  itemId: string;
  title: string | null;
  number: string | null;
  page: number | null;
  needle: string | null;
  sheet: string | null;
  rows: number[] | null;
  replaced: boolean;
};

function aboutUrl(token: string, t: DrawerTarget): string {
  const q = t.needle && !t.page ? `?needle=${encodeURIComponent(t.needle)}` : "";
  return `/api/view/${encodeURIComponent(token)}/data-room/items/${encodeURIComponent(t.itemId)}${q}`;
}

export function VdrViewerDrawer({ token, target, onClose }: { token: string; target: DrawerTarget | null; onClose: () => void }) {
  const source = useMemo<VdrSource>(() => ({ kind: "buyer", token }), [token]);
  const about = useQuery<BuyerItemAbout, VdrRequestError>({
    queryKey: ["/api/view", token, "data-room", "drawer", target?.itemId ?? null, target?.needle ?? null],
    queryFn: () => vdrFetch("GET", aboutUrl(token, target!)),
    enabled: !!target,
    retry: false,
    refetchInterval: (q) => ((q.state.data as BuyerItemAbout | undefined)?.manifest.status === "pending" ? 2000 : false),
  });
  const data = about.data;
  const title = data?.title ?? target?.title ?? "Document";
  const number = data?.number ?? target?.number ?? null;
  const page = target ? (target.replaced ? data?.focusPage ?? null : target.page ?? data?.focusPage ?? null) : null;
  const roomHref = target ? vdrBuyerHref({ token, itemId: target.itemId, page, sheet: target.sheet, rows: target.rows }) : "#";

  return (
    <Sheet open={!!target} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-none md:w-[62vw]" data-testid="vdr-drawer">
        <SheetHeader className="space-y-1 border-b border-border px-4 py-3 pr-12 text-left">
          <SheetTitle className="flex min-w-0 items-center gap-2 text-sm">
            {number && <span className="shrink-0 font-mono text-xs text-muted-foreground">{number}</span>}
            <span className="truncate">{title}</span>
            {target?.replaced && <span className="shrink-0 rounded-full border border-teal/40 bg-teal/10 px-2 py-0.5 text-[11px] font-normal text-teal" data-testid="vdr-drawer-updated">Updated version</span>}
          </SheetTitle>
          <SheetDescription className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span>From the data room{page ? ` · opened at page ${page}` : ""}. Your name is on every page.</span>
            {target && (
              <a href={roomHref} className="inline-flex items-center gap-1 text-foreground underline-offset-2 hover:underline" data-testid="vdr-drawer-room">
                Open in the data room <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {!target ? null : about.isLoading ? (
            <div className="flex min-h-[320px] items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : about.error || !data ? (
            <div className="flex min-h-[320px] flex-col items-center justify-center px-6 text-center" data-testid="vdr-drawer-error">
              <FileWarning className="h-6 w-6 text-muted-foreground" />
              <p className="mt-3 max-w-sm text-sm">
                {about.error?.status === 404 ? "This document isn't in your data room any more." : about.error?.status === 403 ? (String(about.error.body?.error ?? "") || "The data room isn't open to you.") : "This document couldn't be opened. Try again in a moment."}
              </p>
              <Button variant="outline" size="sm" className="mt-3" onClick={onClose}>Back to the CIM</Button>
            </div>
          ) : (
            <VdrViewer
              key={`${target.itemId}:${page ?? ""}`}
              source={source}
              itemId={target.itemId}
              manifest={data.manifest}
              openedFrom="cim"
              initialPage={page}
              initialSheet={target.sheet}
              highlightRows={target.rows}
              reader={data.reader ?? null}
              className="min-h-full"
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
