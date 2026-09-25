/**
 * ExternalAcquirersPanel — likely acquirers who aren't in the broker's buyer
 * list yet, researched on the web with sources (server/matching/external-acquirers.ts).
 * Nothing is sent to anyone; the broker decides whom to approach.
 */
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { Globe, Loader2, ExternalLink, Search, Building2, Mail } from "lucide-react";

interface Acquirer {
  name: string;
  type: "strategic" | "private_equity" | "family_office" | "search_fund" | "other";
  headquarters?: string | null;
  website?: string | null;
  whyInterested: string;
  evidence?: string[];
  contact?: string | null;
  sources: string[];
  inYourList?: boolean;
}
interface SearchState {
  status: "none" | "running" | "done" | "failed";
  startedAt?: string;
  finishedAt?: string;
  mode?: "web" | "knowledge";
  results: Acquirer[];
  error?: string;
  note?: string | null;
  channels?: Array<{ name: string; how: string; url?: string | null }>;
  includeExcluded?: boolean;
}

const TYPE_LABELS: Record<Acquirer["type"], string> = {
  strategic: "Strategic",
  private_equity: "Private equity",
  family_office: "Family office",
  search_fund: "Search fund",
  other: "Investor",
};

const host = (u: string) => {
  try { return new URL(u.startsWith("http") ? u : `https://${u}`).hostname.replace(/^www\./, ""); } catch { return u; }
};

export function ExternalAcquirersPanel({ dealId }: { dealId: string }) {
  const { toast } = useToast();
  const key = ["/api/deals", dealId, "external-acquirers"];
  const { data } = useQuery<SearchState>({
    queryKey: key,
    queryFn: async () => {
      const r = await fetch(`/api/deals/${dealId}/external-acquirers`, { credentials: "include" });
      if (!r.ok) throw new Error("Couldn't load");
      return r.json();
    },
    refetchInterval: (q) => ((q.state.data as SearchState | undefined)?.status === "running" ? 4000 : false),
  });
  const running = data?.status === "running";
  const [includeExcluded, setIncludeExcluded] = useState(false);

  const start = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/deals/${dealId}/external-acquirers`, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ includeExcluded }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || "Couldn't start the research");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: key });
      toast({ description: "Researching likely acquirers — this takes a minute or two. You can leave this page." });
    },
    onError: (e: Error) => toast({ variant: "destructive", description: e.message }),
  });

  const results = data?.results ?? [];
  return (
    <div className="space-y-3" data-testid="external-acquirers">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Globe className="h-4 w-4 text-teal" />
            Buyers outside your list
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Companies and investors actively buying in this space, found on the web with sources. The search only uses the industry, region and size — never the business's name.
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Button size="sm" variant="outline" disabled={running || start.isPending} onClick={() => start.mutate()} data-testid="button-find-external">
            {running ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Search className="h-3 w-3 mr-1" />}
            {running ? "Researching…" : data?.status === "done" ? "Search again" : "Find outside buyers"}
          </Button>
          <label className="flex items-center gap-1.5 text-2xs text-muted-foreground cursor-pointer">
            <input type="checkbox" checked={includeExcluded} onChange={(e) => setIncludeExcluded(e.target.checked)} data-testid="checkbox-include-excluded" />
            Include buyer types the seller ruled out
          </label>
        </div>
      </div>

      {data?.status === "done" && data.note && (
        <p className="rounded-md border border-border bg-muted/10 px-3 py-2 text-xs text-foreground/80" data-testid="external-note">{data.note}</p>
      )}
      {data?.status === "done" && !!data.channels?.length && (
        <div className="rounded-md border border-border p-3 space-y-1.5" data-testid="external-channels">
          <p className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">Ways to reach the buyers this seller prefers</p>
          <ul className="space-y-1 text-xs">
            {data.channels.map((c, i) => (
              <li key={i}>
                <span className="font-medium">{c.name}</span>
                <span className="text-muted-foreground"> — {c.how}</span>
                {c.url && <a href={c.url} target="_blank" rel="noreferrer" className="ml-1 text-teal hover:underline inline-flex items-center gap-0.5">{host(c.url)} <ExternalLink className="h-2.5 w-2.5" /></a>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {data?.status === "failed" && <p className="text-xs text-red-400">{data.error || "The research didn't finish — try again."}</p>}
      {data?.mode === "knowledge" && results.length > 0 && (
        <p className="text-2xs text-amber-400">Web search was unavailable, so these come from the AI's general knowledge — check each one before reaching out.</p>
      )}
      {running && results.length === 0 && (
        <div className="rounded-md border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
          Searching for recent acquirers, PE platforms and family offices in this sector…
        </div>
      )}
      {data?.status === "done" && results.length === 0 && !data.note && (
        <p className="text-xs text-muted-foreground">No well-evidenced outside acquirers found this time.</p>
      )}

      <div className="space-y-2">
        {results.map((a, i) => (
          <div key={`${a.name}-${i}`} className="rounded-md border border-border bg-muted/10 p-3 space-y-1.5" data-testid={`external-acquirer-${i}`}>
            <div className="flex flex-wrap items-center gap-2">
              <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-sm font-medium">{a.name}</span>
              <Badge variant="outline" className="text-2xs font-normal">{TYPE_LABELS[a.type] ?? a.type}</Badge>
              {a.headquarters && <span className="text-2xs text-muted-foreground">{a.headquarters}</span>}
              {a.inYourList && <Badge variant="outline" className="text-2xs bg-teal/10 text-teal border-teal/30">Already in your buyers</Badge>}
              {a.website && (
                <a href={a.website.startsWith("http") ? a.website : `https://${a.website}`} target="_blank" rel="noreferrer" className="ml-auto text-2xs text-teal hover:underline inline-flex items-center gap-0.5">
                  {host(a.website)} <ExternalLink className="h-2.5 w-2.5" />
                </a>
              )}
            </div>
            <p className="text-xs text-foreground/85 leading-snug">{a.whyInterested}</p>
            {!!a.evidence?.length && (
              <ul className="list-disc pl-4 text-2xs text-muted-foreground space-y-0.5">
                {a.evidence.map((e, j) => <li key={j}>{e}</li>)}
              </ul>
            )}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground">
              {a.contact && (
                <span className="inline-flex items-center gap-1 text-foreground/80"><Mail className="h-2.5 w-2.5" /> {a.contact}</span>
              )}
              {a.sources.map((u, j) => (
                <a key={j} href={u} target="_blank" rel="noreferrer" className="hover:text-foreground hover:underline inline-flex items-center gap-0.5">
                  {host(u)} <ExternalLink className="h-2.5 w-2.5" />
                </a>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
