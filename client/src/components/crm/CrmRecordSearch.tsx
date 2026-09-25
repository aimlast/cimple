/**
 * Search the broker's Pipedrive for the seller's deal / organisation / person
 * and pick one. Used by the deal's CRM card and by New Deal.
 */
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Building2, Handshake, Loader2, Search, User, X } from "lucide-react";
import type { CrmSearchResult } from "@shared/crm-seller";
import type { CrmRecordType } from "@shared/schema";
import { RECORD_TYPE_LABEL, useCrmSearch } from "./useCrm";

const TYPE_ICON: Record<CrmRecordType, typeof User> = { deal: Handshake, organization: Building2, person: User };

export function CrmRecordSearch({
  dealId,
  onPick,
  pickingId,
  placeholder = "Search Pipedrive for the seller's deal, company or name",
  autoFocus,
}: {
  dealId: string | null;
  onPick: (r: CrmSearchResult) => void;
  /** "<type>:<id>" of the result being linked (shows a spinner on it). */
  pickingId?: string | null;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [term, setTerm] = useState("");
  const search = useCrmSearch(dealId, term);
  const trimmed = term.trim();
  const results = search.data?.results ?? [];
  const showPanel = trimmed.length >= 2;

  return (
    <div className="space-y-1.5">
      <div className="relative">
        <Search className="h-3.5 w-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder={placeholder}
          className="h-9 pl-8 pr-8 bg-background"
          autoFocus={autoFocus}
          aria-label="Search Pipedrive"
          data-testid="input-crm-search"
        />
        {search.isFetching ? (
          <Loader2 className="h-3.5 w-3.5 absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-muted-foreground" />
        ) : term ? (
          <button type="button" onClick={() => setTerm("")} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" aria-label="Clear search">
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>

      {showPanel && (
        <div className="rounded-md border border-border bg-card overflow-hidden" role="listbox" aria-label="Pipedrive results">
          {search.isError ? (
            <p className="px-3 py-2.5 text-xs text-red-400">{(search.error as Error).message}</p>
          ) : search.data && !search.data.connected ? (
            <p className="px-3 py-2.5 text-xs text-muted-foreground">Pipedrive isn't connected.</p>
          ) : search.isLoading || (search.isFetching && results.length === 0) ? (
            <p className="px-3 py-2.5 text-xs text-muted-foreground">Searching Pipedrive…</p>
          ) : results.length === 0 ? (
            <p className="px-3 py-2.5 text-xs text-muted-foreground">Nothing in Pipedrive matches "{trimmed}".</p>
          ) : (
            <ul className="divide-y divide-border/60 max-h-72 overflow-y-auto">
              {results.map((r) => {
                const Icon = TYPE_ICON[r.type];
                const busy = pickingId === `${r.type}:${r.id}`;
                return (
                  <li key={`${r.type}:${r.id}`}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={false}
                      disabled={!!pickingId}
                      onClick={() => onPick(r)}
                      className="w-full flex items-start gap-2.5 px-3 py-2 text-left hover:bg-teal/5 disabled:opacity-60 transition-colors"
                      data-testid={`crm-result-${r.type}-${r.id}`}
                    >
                      <Icon className="h-3.5 w-3.5 mt-0.5 text-muted-foreground shrink-0" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm truncate">{r.title}</span>
                        {r.subtitle && <span className="block text-[11px] text-muted-foreground truncate">{r.subtitle}</span>}
                      </span>
                      {busy ? (
                        <Loader2 className="h-3.5 w-3.5 mt-0.5 animate-spin text-teal shrink-0" />
                      ) : (
                        <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70 mt-0.5 shrink-0">{RECORD_TYPE_LABEL[r.type]}</span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
