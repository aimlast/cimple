/**
 * HeldPrivateCard — what the CIM holds back about the deal's staff (an
 * employee's interest in a stake, pay requests, possible departures,
 * performance, health or family, private talks with the owner), each with an
 * Include switch. Held by default in every version (Normal, Blind, Due
 * diligence); an included item goes back into the CIM's inputs the next time
 * it is generated. Nothing held is hidden from the broker: every item is
 * listed here, with the words on file and the fact they come from.
 * (server/cim/staff-private.ts, GET/POST /api/deals/:id/cim-held-private)
 */
import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Lock } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import type { StaffPrivateListItem } from "@shared/staff-private";
import { builderRequest, errorText } from "./api";

export const heldPrivateKey = (dealId: string) => ["/api/deals", dealId, "cim-held-private"] as const;

/** GET/POST …/cim-held-private: the held items, and the written sections that still state one. */
interface HeldPrivateState {
  items: StaffPrivateListItem[];
  showing?: Array<{ id: string; title: string; descriptions: string[] }>;
}

export function HeldPrivateCard({ dealId, className }: { dealId: string; className?: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data } = useQuery({
    queryKey: heldPrivateKey(dealId),
    queryFn: () => builderRequest<HeldPrivateState>("GET", `/api/deals/${dealId}/cim-held-private`),
  });
  const toggle = useMutation({
    mutationFn: ({ id, include }: { id: string; include: boolean }) =>
      builderRequest<HeldPrivateState>("POST", `/api/deals/${dealId}/cim-held-private/${id}`, { include }),
    onSuccess: (r, v) => {
      qc.setQueryData(heldPrivateKey(dealId), r);
      qc.invalidateQueries({ queryKey: ["/api/deals", dealId, "cim-builder"] });
      toast({
        title: v.include ? "Included in the CIM" : "Held back again",
        description: v.include ? "It goes into the CIM the next time you generate it." : "It stays out of every version of the CIM.",
      });
    },
    onError: (e) => toast({ title: "Couldn't save that choice", description: errorText(e), variant: "destructive" }),
  });

  // One heading per matter; each held passage keeps its own switch.
  const groups = useMemo(() => {
    const map = new Map<string, StaffPrivateListItem[]>();
    for (const item of data?.items ?? []) map.set(item.description, [...(map.get(item.description) ?? []), item]);
    return Array.from(map.entries());
  }, [data?.items]);

  const showing = data?.showing ?? [];
  if (!data || (data.items.length === 0 && showing.length === 0)) return null;
  const heldCount = data.items.filter((i) => !i.included).length;

  return (
    <section className={cn("rounded-lg border border-border bg-card p-4 space-y-3", className)} data-testid="cim-held-private">
      <div className="flex gap-2.5">
        <Lock className="h-4 w-4 shrink-0 mt-0.5 text-teal" />
        <div className="min-w-0 space-y-0.5">
          <h3 className="text-sm font-semibold">Held back from the CIM</h3>
          <p className="text-xs text-muted-foreground leading-relaxed">
            Private matters about the staff stay out of every version — Normal, Blind and Due diligence — unless you include them.
            {heldCount > 0 ? ` ${heldCount} passage${heldCount === 1 ? " is" : "s are"} held back.` : data.items.length > 0 ? " You've included everything listed." : ""}
            {" "}An included passage goes in the next time you generate the CIM.
          </p>
        </div>
      </div>
      {showing.length > 0 && (
        <div className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs" data-testid="held-private-showing">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-amber-500" />
          <p className="min-w-0 break-words leading-relaxed">
            <span className="font-medium">The CIM as written still mentions {showing.length === 1 ? "one of these" : "some of these"}</span>
            {" "}— in {showing.map((s) => `“${s.title}”`).join(", ")}. Regenerate {showing.length === 1 ? "that section" : "those sections"} (or the CIM) to take it out.
          </p>
        </div>
      )}
      <ul className="space-y-3">
        {groups.map(([description, items]) => (
          <li key={description} className="rounded-md border border-border/70">
            <p className="px-3 pt-2.5 pb-1.5 text-sm">
              <span className="text-muted-foreground">Held back from the CIM:</span>{" "}
              <span className="font-medium">{description}</span>
            </p>
            <ul className="divide-y divide-border/60">
              {items.map((item) => {
                const busy = toggle.isPending && toggle.variables?.id === item.id;
                const switchId = `held-private-${item.id}`;
                return (
                  <li key={`${item.key}:${item.id}`} className="flex items-start gap-3 px-3 py-2.5" data-testid="held-private-item">
                    <div className="min-w-0 flex-1 space-y-1">
                      <p className={cn("text-xs leading-relaxed break-words", item.included ? "text-foreground" : "text-muted-foreground")}>
                        “{item.text}”
                      </p>
                      <p className="text-[11px] text-muted-foreground/80">
                        From “{item.label}”
                        {item.by === "ai" ? " · found by the confidentiality review" : ""}
                        {item.included ? " · included — goes in on the next generation" : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 pt-0.5">
                      <label htmlFor={switchId} className="text-xs text-muted-foreground cursor-pointer select-none">Include</label>
                      <Switch
                        id={switchId}
                        checked={item.included}
                        disabled={busy}
                        onCheckedChange={(include) => toggle.mutate({ id: item.id, include })}
                        aria-label={`Include in the CIM: ${item.text}`}
                        data-testid="switch-include-held-private"
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}
