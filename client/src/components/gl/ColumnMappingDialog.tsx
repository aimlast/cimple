/**
 * ColumnMappingDialog — "Set the columns myself" for a ledger Cimple couldn't
 * read on its own (gl spec §3.4): plain questions, each a list of the file's
 * columns ("Column B — "Date" (e.g. 03/01/2024)"), a live preview of the
 * first entries those choices give, then "Read the ledger with these
 * columns". The easier fix — export the standard General Ledger report — is
 * said first.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { getJson, sendJson, type LedgerSample } from "@/lib/gl-api";
import { invalidateGl } from "@/hooks/useGlStatus";
import { ledgerDate, money } from "./gl-ui";
import type { GlLayout, GlRole } from "@shared/gl-types";

const NONE = "__none";
const letter = (i: number) => (i < 26 ? String.fromCharCode(65 + i) : `${String.fromCharCode(64 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`);

export function ColumnMappingDialog({ dealId, ledgerId, fileName, open, onOpenChange }: { dealId: string; ledgerId: string; fileName: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { toast } = useToast();
  const sample = useQuery<LedgerSample>({
    queryKey: ["/api/deals", dealId, "gl", "ledgers", ledgerId, "sample"],
    queryFn: () => getJson<LedgerSample>(`/api/deals/${dealId}/gl/ledgers/${ledgerId}/sample`),
    enabled: open,
  });
  const [headerRow, setHeaderRow] = useState(0);
  const [roles, setRoles] = useState<Partial<Record<"date" | "account" | "amount" | "debit" | "credit" | "name" | "memo", number>>>({});
  const [headings, setHeadings] = useState(false);
  const [split, setSplit] = useState(false);
  const [dateOrder, setDateOrder] = useState<"ymd" | "mdy" | "dmy">("mdy");

  useEffect(() => {
    const g = sample.data?.guess;
    if (!g) return;
    setHeaderRow(Math.max(0, g.headerRow));
    const r: typeof roles = {};
    for (const c of g.columns) if (["date", "account", "amount", "debit", "credit", "name", "memo"].includes(c.role)) (r as any)[c.role] = c.index;
    setRoles(r);
    setHeadings(g.accountMode === "heading_rows");
    setSplit(g.amountMode === "debit_credit");
    setDateOrder(g.dateOrder);
  }, [sample.data?.guess]);

  const rows = sample.data?.rows ?? [];
  const header = rows[headerRow]?.cells ?? [];
  const example = (i: number) => rows.slice(headerRow + 1).map((r) => r.cells[i]).find((c) => c && c.trim()) ?? "";
  const width = Math.max(0, ...rows.map((r) => r.cells.length));
  const columns = useMemo(() => Array.from({ length: width }, (_, i) => ({ i, label: `Column ${letter(i)}${header[i] ? ` — "${header[i]}"` : ""}${example(i) ? ` (e.g. ${example(i).slice(0, 24)})` : ""}` })), [width, headerRow, rows]); // eslint-disable-line react-hooks/exhaustive-deps

  const layout = (): GlLayout | null => {
    if (roles.date === undefined) return null;
    const cols: GlLayout["columns"] = [];
    const add = (role: GlRole, i: number | undefined) => { if (i !== undefined && !cols.some((c) => c.index === i)) cols.push({ index: i, role, header: header[i] ?? "" }); };
    add("date", roles.date);
    if (!headings) add("account", roles.account);
    if (split) { add("debit", roles.debit); add("credit", roles.credit); } else add("amount", roles.amount);
    add("name", roles.name);
    add("memo", roles.memo);
    return { headerRow, columns: cols, accountMode: headings ? "heading_rows" : "column", dateOrder, amountMode: split ? "debit_credit" : "single", sheet: sample.data?.sheet ?? null };
  };

  const l = layout();
  const preview = useQuery<{ entries: Array<{ date: string; account: string; name: string | null; memo: string | null; amountCents: number }>; count: number }>({
    queryKey: ["/api/deals", dealId, "gl", "ledgers", ledgerId, "preview", JSON.stringify(l)],
    queryFn: () => sendJson("POST", `/api/deals/${dealId}/gl/ledgers/${ledgerId}/columns?preview=1`, l),
    enabled: open && !!l,
    retry: false,
  });
  const apply = useMutation({
    mutationFn: () => sendJson("POST", `/api/deals/${dealId}/gl/ledgers/${ledgerId}/columns`, l),
    onSuccess: () => { invalidateGl(dealId); onOpenChange(false); toast({ title: "Reading the ledger with your columns" }); },
    onError: (e: unknown) => toast({ title: "That didn't work", description: e instanceof Error ? e.message : undefined, variant: "destructive" }),
  });

  const pick = (key: keyof typeof roles, label: string) => (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Select value={roles[key] === undefined ? NONE : String(roles[key])} onValueChange={(v) => setRoles({ ...roles, [key]: v === NONE ? undefined : Number(v) })}>
        <SelectTrigger className="h-9 text-xs"><SelectValue placeholder="Choose a column" /></SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>None</SelectItem>
          {columns.map((c) => <SelectItem key={c.i} value={String(c.i)} className="text-xs">{c.label}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto" data-testid="gl-columns-dialog">
        <DialogHeader>
          <DialogTitle>Which column is which?</DialogTitle>
          <DialogDescription>{fileName}. The easiest fix is usually to export the standard "General Ledger" report instead — but you can set the columns here.</DialogDescription>
        </DialogHeader>
        {sample.isLoading ? (
          <p className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Opening the file…</p>
        ) : sample.error ? (
          <p className="text-sm text-red-500">{(sample.error as Error).message}</p>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs">Which row has the column headings?</Label>
              <Select value={String(headerRow)} onValueChange={(v) => setHeaderRow(Number(v))}>
                <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {rows.slice(0, 15).map((r, i) => <SelectItem key={i} value={String(i)} className="text-xs">Row {r.rowNo}: {r.cells.filter(Boolean).slice(0, 4).join(" · ").slice(0, 70)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {pick("date", "Which column has the date?")}
            <div className="flex items-center gap-2">
              <Checkbox id="gl-headings" checked={headings} onCheckedChange={(v) => setHeadings(v === true)} />
              <Label htmlFor="gl-headings" className="text-xs font-normal">The account names are written as headings above each group</Label>
            </div>
            {!headings && pick("account", "Which column has the account?")}
            <div className="flex items-center gap-2">
              <Checkbox id="gl-split" checked={split} onCheckedChange={(v) => setSplit(v === true)} />
              <Label htmlFor="gl-split" className="text-xs font-normal">The amount is split into money in / money out (debit and credit)</Label>
            </div>
            {split ? <div className="grid gap-3 sm:grid-cols-2">{pick("debit", "Money out (debit)")}{pick("credit", "Money in (credit)")}</div> : pick("amount", "Which column has the amount?")}
            <div className="grid gap-3 sm:grid-cols-2">{pick("name", "Who was paid? (optional)")}{pick("memo", "The description? (optional)")}</div>
            <div className="space-y-1">
              <Label className="text-xs">How are dates written?</Label>
              <Select value={dateOrder} onValueChange={(v) => setDateOrder(v as typeof dateOrder)}>
                <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ymd">2024-03-01</SelectItem>
                  <SelectItem value="mdy">03/01/2024 meaning March 1</SelectItem>
                  <SelectItem value="dmy">01/03/2024 meaning March 1</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="rounded-md border border-border">
              <p className="px-3 py-2 text-xs font-medium border-b border-border">What Cimple reads with these columns</p>
              {!l ? <p className="px-3 py-2 text-xs text-muted-foreground">Pick the date column first.</p>
                : preview.isLoading ? <p className="px-3 py-2 text-xs text-muted-foreground flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" /> Reading…</p>
                : preview.error ? <p className="px-3 py-2 text-xs text-amber-600 dark:text-amber-400">{(preview.error as Error).message}</p>
                : (preview.data?.entries.length ?? 0) === 0 ? <p className="px-3 py-2 text-xs text-amber-600 dark:text-amber-400">No entries with these choices — try other columns.</p>
                : (
                  <ul className="divide-y divide-border">
                    {preview.data!.entries.map((e, i) => (
                      <li key={i} className="px-3 py-1.5 text-xs flex gap-2"><span className="tabular-nums text-muted-foreground shrink-0">{ledgerDate(e.date)}</span><span className="flex-1 min-w-0 truncate">{e.account}{e.name ? ` · ${e.name}` : ""}{e.memo ? ` · ${e.memo}` : ""}</span><span className="tabular-nums">{money(e.amountCents)}</span></li>
                    ))}
                  </ul>
                )}
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button className="bg-teal text-teal-foreground hover:bg-teal/90" disabled={!l || apply.isPending || !(preview.data?.entries.length)} onClick={() => apply.mutate()}>
            {apply.isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />} Read the ledger with these columns
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
