/**
 * GlLedgerViewer — the ledger's entries, 100 a page, read on the server
 * (gl spec §3.4 "Ledger viewer"). Broker mode: every entry, with hints for
 * employees' pay, personal entries and copies of an earlier file. Year and
 * account filters (with totals), search, "Jump to row". A table on wide
 * screens, two-line rows on a phone. (The buyer mode — masked rows, through
 * the data room — comes with the DD evidence.)
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Loader2, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getJson, glKeys, type LedgerRowsResponse } from "@/lib/gl-api";
import { formatCents, formatCount, formatDay, softwareLabel, formatPeriod } from "@shared/gl-copy";

const ALL = "__all__";

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const HINT_LABEL: Record<string, string> = {
  staff: "Employee pay",
  personal: "Personal",
};

export function GlLedgerViewer({ dealId, ledgerId, initialRow }: { dealId: string; ledgerId: string; initialRow?: number | null }) {
  const [fy, setFy] = useState<string>(ALL);
  const [account, setAccount] = useState<string>(ALL);
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const [around, setAround] = useState<number | null>(initialRow ?? null);
  const [jump, setJump] = useState("");
  const query = useDebounced(q.trim(), 300);

  // A new filter starts at the first page.
  useEffect(() => { setPage(0); }, [fy, account, query]);

  const params = useMemo(() => ({ fy: fy === ALL ? "" : fy, account: account === ALL ? "" : account, q: query, page, around }), [fy, account, query, page, around]);
  const { data, isLoading, isFetching, error, refetch } = useQuery<LedgerRowsResponse>({
    queryKey: glKeys.rows(dealId, ledgerId, params),
    queryFn: () => {
      const sp = new URLSearchParams();
      if (params.fy) sp.set("fy", params.fy);
      if (params.account) sp.set("account", params.account);
      if (params.q) sp.set("q", params.q);
      if (params.around) sp.set("around", String(params.around));
      else sp.set("page", String(params.page));
      return getJson<LedgerRowsResponse>(`/api/deals/${dealId}/gl/ledgers/${ledgerId}/rows?${sp.toString()}`);
    },
    placeholderData: keepPreviousData,
  });

  // After a jump, page through normally from where it landed.
  useEffect(() => {
    if (around && data && data.page !== page) {
      setPage(data.page);
    }
  }, [around, data, page]);

  const ledger = data?.ledger;
  const from = data ? data.page * data.pageSize + 1 : 0;
  const to = data ? Math.min(data.total, (data.page + 1) * data.pageSize) : 0;
  const lastPage = data ? Math.max(0, Math.ceil(data.total / data.pageSize) - 1) : 0;
  const goto = (p: number) => { setAround(null); setPage(Math.max(0, Math.min(lastPage, p))); };

  if (error && !data) {
    return (
      <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-sm flex flex-wrap items-center gap-3" data-testid="gl-viewer-error">
        <span className="flex-1 min-w-0">{(error as Error).message || "Couldn't load the entries."}</span>
        <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => refetch()}>Try again</Button>
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="gl-viewer">
      {ledger && (
        <div className="text-xs text-muted-foreground">
          {softwareLabel(ledger.software)} · {formatCount(ledger.rowCount)} entries
          {ledger.periodStart && ledger.periodEnd ? ` · ${formatPeriod(ledger.periodStart, ledger.periodEnd)}` : ""}
          {ledger.accountCount ? ` · ${formatCount(ledger.accountCount)} accounts` : ""}
        </div>
      )}

      {/* Filters */}
      <div className="grid grid-cols-2 gap-2 md:flex md:flex-wrap md:items-center">
        <Select value={fy} onValueChange={setFy}>
          <SelectTrigger className="h-9 text-xs md:w-36" aria-label="Fiscal year" data-testid="gl-viewer-year">
            <SelectValue placeholder="Every year" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL} className="text-xs">Every year</SelectItem>
            {(data?.years ?? []).map((y) => <SelectItem key={y} value={y} className="text-xs">Fiscal {y}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={account} onValueChange={setAccount}>
          <SelectTrigger className="h-9 text-xs md:w-72" aria-label="Account" data-testid="gl-viewer-account">
            <SelectValue placeholder="Every account" />
          </SelectTrigger>
          <SelectContent className="max-h-80">
            <SelectItem value={ALL} className="text-xs">Every account</SelectItem>
            {(data?.accounts ?? []).map((a) => (
              <SelectItem key={a.accountKey} value={a.accountKey} className="text-xs">
                {a.account} · {formatCount(a.lines)} · {formatCents(a.netCents, { whole: true })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="relative col-span-2 md:flex-1 md:min-w-[220px]">
          <Search className="h-3.5 w-3.5 text-muted-foreground absolute left-2.5 top-1/2 -translate-y-1/2" />
          <Input
            value={q}
            onChange={(e) => { setAround(null); setQ(e.target.value.slice(0, 100)); }}
            placeholder="Search by name, description or amount — e.g. Petro-Canada or 1150"
            className="h-9 pl-8 pr-8 text-xs"
            aria-label="Search the ledger"
            data-testid="gl-viewer-search"
          />
          {q && (
            <button className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" aria-label="Clear the search" onClick={() => setQ("")}>
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <form
          className="col-span-2 flex items-center gap-2 md:col-span-1"
          onSubmit={(e) => {
            e.preventDefault();
            const n = Number(jump.replace(/[^\d]/g, ""));
            if (n > 0) { setFy(ALL); setAccount(ALL); setQ(""); setAround(n); }
          }}
        >
          <Input value={jump} onChange={(e) => setJump(e.target.value)} inputMode="numeric" placeholder="Row" className="h-9 w-24 text-xs" aria-label="Jump to row" data-testid="gl-viewer-jump" />
          <Button type="submit" size="sm" variant="outline" className="h-9 text-xs">Jump to row</Button>
        </form>
      </div>

      {/* Entries */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12 text-sm text-muted-foreground gap-2" data-testid="gl-viewer-loading">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading the entries…
        </div>
      ) : !data || data.rows.length === 0 ? (
        <div className="rounded-lg border border-border bg-muted/20 p-8 text-center text-sm text-muted-foreground" data-testid="gl-viewer-empty">
          {query || fy !== ALL || account !== ALL ? "No entries match. Try another search or clear the filters." : "This ledger has no entries."}
        </div>
      ) : (
        <>
          {/* Wide screens: a table */}
          <div className="hidden md:block rounded-lg border border-border overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-muted/40 text-muted-foreground">
                <tr>
                  <th className="text-right font-medium px-3 py-2 w-16">Row</th>
                  <th className="text-left font-medium px-3 py-2 w-28">Date</th>
                  <th className="text-left font-medium px-3 py-2">Account</th>
                  <th className="text-left font-medium px-3 py-2">Paid to</th>
                  <th className="text-left font-medium px-3 py-2">Description</th>
                  <th className="text-right font-medium px-3 py-2 w-32">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.rows.map((r) => (
                  <tr key={r.rowNo} className={`${around === r.rowNo ? "bg-teal/10" : ""} ${r.duplicate ? "text-muted-foreground" : ""}`} data-testid={`gl-row-${r.rowNo}`}>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{formatCount(r.rowNo)}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{formatDay(r.date)}</td>
                    <td className="px-3 py-2 min-w-0">
                      <span className="break-words">{r.account}</span>
                      {r.accountNumber && <span className="text-muted-foreground"> · {r.accountNumber}</span>}
                    </td>
                    <td className="px-3 py-2 break-words">{r.name ?? ""}</td>
                    <td className="px-3 py-2 break-words">
                      {r.memo ?? ""}
                      <RowChips hint={r.hint} duplicate={r.duplicate} />
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">{formatCents(r.amountCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* Phones: two-line rows */}
          <ul className="md:hidden rounded-lg border border-border divide-y divide-border">
            {data.rows.map((r) => (
              <li key={r.rowNo} className={`px-3 py-2.5 ${around === r.rowNo ? "bg-teal/10" : ""}`} data-testid={`gl-row-m-${r.rowNo}`}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm min-w-0 break-words">{r.name || r.memo || r.account}</span>
                  <span className="text-sm tabular-nums shrink-0">{formatCents(r.amountCents)}</span>
                </div>
                <div className="text-xs text-muted-foreground mt-0.5 break-words">
                  {formatDay(r.date)} · {r.account}{r.name && r.memo ? ` · ${r.memo}` : ""} · row {formatCount(r.rowNo)}
                </div>
                <RowChips hint={r.hint} duplicate={r.duplicate} />
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span aria-live="polite">
              {isFetching ? "Loading…" : `Showing ${formatCount(from)}–${formatCount(to)} of ${formatCount(data.total)}`}
            </span>
            <div className="flex items-center gap-1">
              <Button size="sm" variant="outline" className="h-8 w-8 p-0" disabled={data.page === 0} onClick={() => goto(data.page - 1)} aria-label="Previous page">
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="px-2 tabular-nums">Page {formatCount(data.page + 1)} of {formatCount(lastPage + 1)}</span>
              <Button size="sm" variant="outline" className="h-8 w-8 p-0" disabled={data.page >= lastPage} onClick={() => goto(data.page + 1)} aria-label="Next page">
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function RowChips({ hint, duplicate }: { hint: string | null; duplicate: boolean }) {
  if (!hint && !duplicate) return null;
  return (
    <span className="inline-flex flex-wrap gap-1 ml-1.5 align-middle">
      {hint && HINT_LABEL[hint] && (
        <span className="rounded px-1.5 py-0.5 text-2xs bg-muted text-muted-foreground" title={hint === "staff" ? "Buyers never see employees' names" : "Withheld from buyers unless you choose to show it"}>
          {HINT_LABEL[hint]}
        </span>
      )}
      {duplicate && <span className="rounded px-1.5 py-0.5 text-2xs bg-muted text-muted-foreground" title="Also in an earlier file — counted once">Copy of an earlier file</span>}
    </span>
  );
}
