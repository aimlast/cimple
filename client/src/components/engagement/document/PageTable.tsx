/**
 * Every page in one table ("By page"): number, title, layout, buyers who read
 * it, time per reader, one careful read, how they read it, questions. Click a
 * row to open that page on the heat map. On a phone the less important
 * columns drop away.
 */
import { formatReadingTime, type DocumentPage } from "@shared/analytics-v2";
import { layoutLabel } from "@shared/cim-layouts";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { heatChrome } from "../heat";
import { ReadLabelChip } from "./PagePanel";
import { orderPages, perReaderMs, type PageOrder } from "./viewer-model";

function layoutWords(layoutType: string): string {
  if (layoutType === "disclaimer_page") return "Disclaimer";
  if (layoutType === "contact_page") return "Contact page";
  return layoutLabel(layoutType);
}

export function PageTable({ pages, order, openedBy, onOpen }: { pages: DocumentPage[]; order: PageOrder; openedBy: number; onOpen(index: number): void }) {
  const maxMs = Math.max(0, ...pages.map((p) => p.attentionMs));
  return (
    <div className="overflow-hidden rounded-lg border border-border" data-testid="engagement-page-table">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10 text-right">#</TableHead>
            <TableHead>Page</TableHead>
            <TableHead className="hidden md:table-cell">Layout</TableHead>
            <TableHead className="text-right">Read by</TableHead>
            <TableHead className="text-right">Reading time</TableHead>
            <TableHead className="hidden sm:table-cell text-right">Per buyer</TableHead>
            <TableHead className="hidden lg:table-cell text-right">Careful read</TableHead>
            <TableHead className="hidden sm:table-cell">How they read it</TableHead>
            <TableHead className="hidden md:table-cell text-right">Questions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {orderPages(pages, order).map((p) => {
            const per = perReaderMs(p);
            return (
              <TableRow key={`${p.pageId}#${p.part}`} className="cursor-pointer" onClick={() => onOpen(p.index)}>
                <TableCell className="text-right text-xs tabular-nums text-muted-foreground">{p.label}</TableCell>
                <TableCell className="max-w-[16rem]">
                  <p className="truncate text-sm">{p.title}</p>
                  {p.servedTitle && <p className="truncate text-[11px] italic text-muted-foreground">Buyer saw: “{p.servedTitle}”</p>}
                  <span className="mt-1 block h-1 w-full max-w-[10rem] overflow-hidden rounded-full bg-muted">
                    <span className="block h-full rounded-full" style={{ width: `${maxMs ? (p.attentionMs / maxMs) * 100 : 0}%`, background: heatChrome(maxMs ? p.attentionMs / maxMs : 0) }} />
                  </span>
                </TableCell>
                <TableCell className="hidden md:table-cell text-xs text-muted-foreground">{layoutWords(p.layoutType)}</TableCell>
                <TableCell className="text-right text-xs tabular-nums">{p.readers} of {Math.max(openedBy, p.readers)}</TableCell>
                <TableCell className="text-right text-xs tabular-nums">{p.attentionMs > 0 ? formatReadingTime(p.attentionMs) : "—"}</TableCell>
                <TableCell className="hidden sm:table-cell text-right text-xs tabular-nums">{per != null ? formatReadingTime(per) : "—"}</TableCell>
                <TableCell className="hidden lg:table-cell text-right text-xs tabular-nums text-muted-foreground">{formatReadingTime(p.expectedMs)}</TableCell>
                <TableCell className="hidden sm:table-cell">
                  {p.reachRecorded === false ? <span className="text-[11px] text-muted-foreground">No reading recorded</span> : <ReadLabelChip label={p.readLabel} />}
                </TableCell>
                <TableCell className="hidden md:table-cell text-right text-xs tabular-nums">{p.questions.length || "—"}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
