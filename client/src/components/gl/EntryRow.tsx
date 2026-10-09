/**
 * EntryRow / EntryGroup / LedgerSearch — ledger entries on the seller's page
 * (gl spec §3.3 C): a real checkbox with a full label ("Tick: Mar 1, 2024 ·
 * Lexus Financial · $1,150.00"); date · paid to · description · amount; a
 * reason chip ("Same account", "Names Lexus", "Monthly $1,150"). On phones
 * two lines and the whole row is the tap target (≥ 44 px). Grouped by
 * account with "Tick all / Untick all". The search finds entries Cimple
 * missed (by name, description or amount; ≤ 50 results).
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getJson, type SellerEntry } from "@/lib/gl-api";
import { accountPath } from "@shared/gl-copy";
import { ledgerDate, money } from "./gl-ui";

export const entryKey = (e: { ledgerId: string; rowNo: number }) => `${e.ledgerId}:${e.rowNo}`;

export function EntryRow({ e, checked, onChange, disabled, showAccount = false, hideReason = false }: { e: SellerEntry; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; showAccount?: boolean; hideReason?: boolean }) {
  const id = `entry-${e.ledgerId}-${e.rowNo}`;
  return (
    <label htmlFor={id} className={cn("flex items-start gap-3 px-3 py-2.5 min-h-[44px] cursor-pointer hover:bg-muted/30", disabled && "opacity-60 cursor-default")} data-testid="entry-row">
      <input id={id} type="checkbox" className="mt-1 h-4 w-4 shrink-0" checked={checked} disabled={disabled} onChange={(ev) => onChange(ev.target.checked)}
        aria-label={`Tick: ${ledgerDate(e.date)} · ${e.name ?? accountPath(e.account)} · ${money(e.amountCents)}`} />
      <span className="flex-1 min-w-0">
        <span className="flex flex-wrap items-baseline gap-x-2 text-sm">
          <span className="text-muted-foreground tabular-nums text-xs">{ledgerDate(e.date)}</span>
          <span className="font-medium break-words">{e.name || "—"}</span>
        </span>
        <span className="block text-xs text-muted-foreground break-words">{e.memo || ""}{showAccount ? `${e.memo ? " · " : ""}${accountPath(e.account)}` : ""}</span>
        {e.reason && e.state === "proposed" && !hideReason && <span className="mt-0.5 inline-block rounded bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">{e.reason}</span>}
      </span>
      <span className="text-sm tabular-nums font-medium shrink-0">{money(e.amountCents)}</span>
    </label>
  );
}

export function EntryGroup({ account, entries, isChecked, onToggle, onAll, disabled }: {
  account: string;
  entries: SellerEntry[];
  isChecked: (e: SellerEntry) => boolean;
  onToggle: (e: SellerEntry, v: boolean) => void;
  onAll: (v: boolean) => void;
  disabled?: boolean;
}) {
  const total = entries.reduce((s, e) => s + e.amountCents, 0);
  const allOn = entries.every(isChecked);
  // One reason for the whole group ("The whole Vehicle – Owner account") is said once, in the header.
  const reasons = Array.from(new Set(entries.map((e) => e.reason).filter(Boolean)));
  const common = reasons.length === 1 && entries.every((e) => e.reason === reasons[0]) ? reasons[0]! : null;
  return (
    <div className="rounded-lg border border-border bg-card" data-testid="entry-group">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 border-b border-border bg-muted/20">
        <div className="min-w-0">
          <p className="text-sm font-medium break-words">{accountPath(account)} <span className="font-normal text-muted-foreground">· {entries.length} entr{entries.length === 1 ? "y" : "ies"} · {money(total)}</span></p>
          {common && <p className="text-2xs text-muted-foreground">{common}</p>}
        </div>
        <Button size="sm" variant="ghost" className="h-8 text-xs" disabled={disabled} onClick={() => onAll(!allOn)}>{allOn ? "Untick all" : "Tick all"}</Button>
      </div>
      <div className="divide-y divide-border">
        {entries.map((e) => <EntryRow key={entryKey(e)} e={e} checked={isChecked(e)} onChange={(v) => onToggle(e, v)} disabled={disabled} hideReason={!!common} />)}
      </div>
    </div>
  );
}

export function LedgerSearch({ searchUrl, years, onAdd, isChecked, disabled }: {
  /** The search endpoint (seller or broker). */
  searchUrl: string;
  years: string[];
  onAdd: (e: SellerEntry, v: boolean) => void;
  isChecked: (e: SellerEntry) => boolean;
  disabled?: boolean;
}) {
  const [q, setQ] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [fy, setFy] = useState(years.length === 1 ? years[0] : "");
  const params = new URLSearchParams();
  if (submitted) params.set("q", submitted);
  if (fy) params.set("fy", fy);
  const r = useQuery<{ rows: SellerEntry[] }>({
    queryKey: [searchUrl, submitted, fy],
    queryFn: () => getJson<{ rows: SellerEntry[] }>(`${searchUrl}?${params.toString()}`),
    enabled: submitted.length > 0,
  });
  return (
    <div className="space-y-2" data-testid="ledger-search">
      <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(e) => { e.preventDefault(); setSubmitted(q.trim()); }}>
        <Input value={q} onChange={(e) => setQ(e.target.value)} maxLength={100} placeholder="Search by name, description or amount — e.g. Petro-Canada or 1150" className="h-10" aria-label="Search your ledger" />
        {years.length > 1 && (
          <select value={fy} onChange={(e) => setFy(e.target.value)} className="h-10 rounded-md border border-input bg-background px-2 text-sm" aria-label="Year">
            <option value="">All years</option>
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        )}
        <Button type="submit" variant="outline" className="h-10 gap-1.5" disabled={!q.trim()}><Search className="h-4 w-4" /> Search</Button>
      </form>
      {r.isFetching && <p className="text-xs text-muted-foreground flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" /> Searching…</p>}
      {r.error && <p className="text-xs text-red-500">{(r.error as Error).message}</p>}
      {r.data && (r.data.rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nothing found for "{submitted}".</p>
      ) : (
        <div className="rounded-lg border border-border divide-y divide-border">
          {r.data.rows.map((e) => <EntryRow key={entryKey(e)} e={e} showAccount checked={isChecked(e)} onChange={(v) => onAdd(e, v)} disabled={disabled} />)}
          {r.data.rows.length >= 50 && <p className="px-3 py-2 text-xs text-muted-foreground">Showing the first 50 — narrow your search.</p>}
        </div>
      ))}
    </div>
  );
}
