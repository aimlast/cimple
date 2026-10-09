/**
 * TieOutPanel — "Does the ledger match the statements?" (gl spec §3.4
 * "Tie-out drawer", §6.6), shown as a tab of the panel: per fiscal year the
 * revenue and net income from the statements and from the ledger, the
 * difference and a likely reason in plain words. The broker can accept a
 * difference with a note (due-diligence buyers read it), ask for the
 * accountant's adjusting entries, or tell Cimple which unclassified accounts
 * are on the balance sheet.
 */
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { CheckCircle2, CircleHelp, Loader2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { sendJson, type BrokerGlData } from "@/lib/gl-api";
import { invalidateGl } from "@/hooks/useGlStatus";
import { Pill, dollars } from "./gl-ui";
import { accountPath } from "@shared/gl-copy";

export function TieOutPanel({ dealId, data, onUploadAdjustments }: { dealId: string; data: BrokerGlData; onUploadAdjustments: () => void }) {
  const years = data.tieOut?.years ?? [];
  if (!data.ledgers.some((l) => l.status === "ready")) {
    return <Empty text="Once a ledger is read, Cimple checks it against the financial statements, year by year." />;
  }
  if (years.length === 0) return <Empty text="Nothing to compare yet — the ledger's years and the analysis's years don't overlap." />;
  return (
    <div className="space-y-3" data-testid="gl-tieout">
      <p className="text-sm text-muted-foreground">"Found in the books" means little if the books don't match the statements. Cimple compares the ledger's revenue and net income with the financial statements for each year. Buyers only hear about years that match, or where you accepted the difference.</p>
      {years.map((y) => <YearCard key={y.year} dealId={dealId} y={y} onUploadAdjustments={onUploadAdjustments} />)}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="text-sm text-muted-foreground rounded-lg border border-dashed border-border px-4 py-6 text-center">{text}</p>;
}

type YearView = NonNullable<BrokerGlData["tieOut"]>["years"][number];

function YearCard({ dealId, y, onUploadAdjustments }: { dealId: string; y: YearView; onUploadAdjustments: () => void }) {
  const { toast } = useToast();
  const [note, setNote] = useState("");
  const [accepting, setAccepting] = useState(false);
  const [classes, setClasses] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => sendJson("PATCH", `/api/deals/${dealId}/gl/tie-out`, body),
    onSuccess: () => { invalidateGl(dealId); setAccepting(false); setNote(""); },
    onError: (e: unknown) => toast({ title: "That didn't work", description: e instanceof Error ? e.message : undefined, variant: "destructive" }),
  });
  const d = y.data;
  const tone = y.state === "agrees" || y.accepted ? "good" : y.state === "differs" ? "warn" : "muted";
  const Icon = tone === "good" ? CheckCircle2 : tone === "warn" ? TriangleAlert : CircleHelp;
  return (
    <div className="rounded-lg border border-border bg-card p-3 sm:p-4 space-y-3" data-testid={`gl-tieout-${y.year}`}>
      <div className="flex items-start gap-2">
        <Icon className={tone === "good" ? "h-4 w-4 text-success mt-0.5 shrink-0" : tone === "warn" ? "h-4 w-4 text-amber-500 mt-0.5 shrink-0" : "h-4 w-4 text-muted-foreground mt-0.5 shrink-0"} />
        <p className="text-sm flex-1">{y.words}</p>
        <Pill tone={tone}>{y.state === "agrees" ? "Matches" : y.accepted ? "Accepted" : y.state === "differs" ? "Differs" : "Can't check"}</Pill>
      </div>
      {(d.revenue || d.netIncome) && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs tabular-nums">
            <thead><tr className="text-muted-foreground text-left"><th className="py-1 font-normal" /><th className="py-1 font-normal text-right">Statements</th><th className="py-1 font-normal text-right">Ledger</th><th className="py-1 font-normal text-right">Difference</th></tr></thead>
            <tbody>
              {d.revenue && <Row label="Revenue" a={d.revenue.statements} b={d.revenue.ledger} />}
              {d.netIncome && <Row label="Net income" a={d.netIncome.statements} b={d.netIncome.ledger} />}
            </tbody>
          </table>
        </div>
      )}
      {y.state === "differs" && !y.accepted && (
        <div className="flex flex-col gap-2">
          {accepting ? (
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={600} placeholder="Why it differs — due-diligence buyers read this" className="h-9" />
              <Button size="sm" className="h-9 bg-teal text-teal-foreground hover:bg-teal/90 shrink-0" disabled={note.trim().length < 3 || save.isPending} onClick={() => save.mutate({ year: y.year, accept: { note } })}>
                {save.isPending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />} Accept this difference
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setAccepting(true)} data-testid="gl-tieout-accept">Accept this difference</Button>
              {d.likelyReason === "year_end_entries" && (
                <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={onUploadAdjustments}>Add the accountant's adjusting entries</Button>
              )}
            </div>
          )}
        </div>
      )}
      {y.accepted && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">Your note: "{y.accepted.note}"</span>
          <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={save.isPending} onClick={() => save.mutate({ year: y.year, accept: null })}>Undo</Button>
        </div>
      )}
      {d.likelyReason === "unclassified_accounts" && (d.unclassified?.length ?? 0) > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium">Tell Cimple which of these accounts are on the balance sheet</p>
          <ul className="space-y-1.5">
            {d.unclassified!.map((u) => (
              <li key={u.accountKey} className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3 text-xs">
                <span className="flex-1 min-w-0 break-words">{accountPath(u.account)} <span className="text-muted-foreground tabular-nums">· {dollars(u.netCents)}</span></span>
                <Select value={classes[u.accountKey] ?? ""} onValueChange={(v) => setClasses({ ...classes, [u.accountKey]: v })}>
                  <SelectTrigger className="h-8 sm:w-48 text-xs" aria-label={`Class of ${u.account}`}><SelectValue placeholder="Choose…" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="balance_sheet">On the balance sheet</SelectItem>
                    <SelectItem value="expense">An expense</SelectItem>
                    <SelectItem value="revenue">Revenue</SelectItem>
                  </SelectContent>
                </Select>
              </li>
            ))}
          </ul>
          <Button size="sm" variant="outline" className="h-8 text-xs" disabled={Object.keys(classes).length === 0 || save.isPending} onClick={() => save.mutate({ accountClasses: classes })}>Save and check again</Button>
        </div>
      )}
    </div>
  );
}

function Row({ label, a, b }: { label: string; a: number; b: number }) {
  const diff = b - a;
  return (
    <tr className="border-t border-border/60">
      <td className="py-1.5 pr-2">{label}</td>
      <td className="py-1.5 text-right">{dollars(a)}</td>
      <td className="py-1.5 text-right">{dollars(b)}</td>
      <td className="py-1.5 text-right">{diff === 0 ? "—" : `${diff < 0 ? "−" : "+"}${dollars(Math.abs(diff))}`}</td>
    </tr>
  );
}
