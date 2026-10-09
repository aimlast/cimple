/**
 * The call sheet (⋯ → "Copy / print call sheet"): the open data points
 * grouped by section with their asks, critical first, then the documents
 * still needed. Built in the browser from the board — no AI. Honours the
 * audience it is given (the screen board when the seller can see it).
 */
import { useMemo } from "react";
import { Copy, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { callSheet, type CoverageBoard } from "@shared/coverage-board";

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** A stand-alone printable page (one column, 11 pt, checkboxes). */
export function callSheetHtml(board: CoverageBoard, businessName?: string): string {
  const sheet = callSheet(board, businessName);
  const groups = sheet.groups
    .map((g) => `<h2>${escapeHtml(g.section)}${g.critical ? " <small>critical</small>" : ""}</h2><ul>${g.items
      .map((i) => `<li><span class="box"></span><div><b>${escapeHtml(i.label)}</b>${i.critical ? " <small>critical</small>" : ""}${i.ask ? `<br/><i>${escapeHtml(i.ask)}</i>` : ""}</div></li>`)
      .join("")}</ul>`)
    .join("");
  const docs = sheet.documents.length
    ? `<h2>Documents still needed</h2><ul>${sheet.documents.map((d) => `<li><span class="box"></span><div>${escapeHtml(d.name)}${d.required ? "" : " <small>nice to have</small>"}</div></li>`).join("")}</ul>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"/><title>${escapeHtml(sheet.title)}</title><style>
body{font:11pt/1.45 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#111;margin:18mm;max-width:170mm}
h1{font-size:15pt;margin:0 0 4mm}h2{font-size:11.5pt;margin:6mm 0 2mm;border-bottom:1px solid #ccc;padding-bottom:1mm}
small{font-size:8pt;text-transform:uppercase;letter-spacing:.06em;color:#8a6d2f}
ul{list-style:none;padding:0;margin:0}li{display:flex;gap:3mm;margin:0 0 2.5mm;break-inside:avoid}
.box{flex:none;width:3.5mm;height:3.5mm;border:1px solid #333;margin-top:1mm}i{color:#444}
p.meta{color:#555;font-size:9pt;margin:0 0 4mm}
</style></head><body><h1>${escapeHtml(sheet.title)}</h1><p class="meta">${board.percentCollected}% of the CIM's information collected · ${board.totals.criticalOpen} critical still open</p>${groups}${docs}</body></html>`;
}

export function CallSheetDialog({ board, businessName, open, onOpenChange }: { board: CoverageBoard; businessName?: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { toast } = useToast();
  const sheet = useMemo(() => callSheet(board, businessName), [board, businessName]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(sheet.text);
      toast({ title: "Call sheet copied" });
    } catch {
      toast({ title: "Couldn't copy", description: "Your browser blocked the clipboard — select the text and copy it instead.", variant: "destructive" });
    }
  };
  const print = () => {
    const w = window.open("", "_blank", "width=820,height=900");
    if (!w) {
      toast({ title: "Couldn't open the print view", description: "Allow pop-ups for Cimple, then try again.", variant: "destructive" });
      return;
    }
    w.document.open();
    w.document.write(callSheetHtml(board, businessName));
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 250);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto grid-cols-1 [&>*]:min-w-0">
        <DialogHeader>
          <DialogTitle>Call sheet</DialogTitle>
          <DialogDescription>What's still open, with a way to ask each — critical first. Print it or copy it into your notes before the call.</DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" className="gap-1.5" onClick={copy} data-testid="button-copy-call-sheet"><Copy className="h-3.5 w-3.5" /> Copy</Button>
          <Button size="sm" variant="outline" className="gap-1.5" onClick={print} data-testid="button-print-call-sheet"><Printer className="h-3.5 w-3.5" /> Print</Button>
        </div>
        <div className="space-y-4 text-sm" data-testid="call-sheet">
          {sheet.groups.length === 0 && <p className="text-muted-foreground">Everything on the checklist is on file.</p>}
          {sheet.groups.map((g) => (
            <div key={g.section}>
              <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-1.5">{g.section}{g.critical && <span className="text-teal"> · Critical</span>}</h3>
              <ul className="space-y-1.5">
                {g.items.map((i) => (
                  <li key={i.label} className="flex gap-2">
                    <span className="mt-1 h-3 w-3 rounded-[3px] border border-border shrink-0" aria-hidden />
                    <span><span className="font-medium">{i.label}</span>{i.critical && <span className="ml-1.5 text-[9px] uppercase tracking-wider text-teal">Critical</span>}<span className="block text-xs text-muted-foreground">“{i.ask}”</span></span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {sheet.documents.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-1.5">Documents still needed</h3>
              <ul className="space-y-1">{sheet.documents.map((d) => <li key={d.name} className="flex gap-2"><span className="mt-1 h-3 w-3 rounded-[3px] border border-border shrink-0" aria-hidden />{d.name}{!d.required && <span className="text-xs text-muted-foreground"> · nice to have</span>}</li>)}</ul>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
