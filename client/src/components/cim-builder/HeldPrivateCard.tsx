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
import { Button } from "@/components/ui/button";
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
  /** Sections buyers are still SERVED that state one (the kept copy, or a changed section's approved version). */
  servedShowing?: Array<{ id: string; title: string; descriptions: string[] }>;
  servedFrom?: "kept_copy" | "approved_version" | null;
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

  // Take a section away from buyers now: out of the kept copy while an
  // update waits for review, or hidden (a live CIM serves a hidden section to nobody).
  const hide = useMutation({
    mutationFn: async ({ id }: { id: string }) => {
      if (data?.servedFrom === "kept_copy") {
        return builderRequest<HeldPrivateState>("POST", `/api/deals/${dealId}/cim-held-private/withdraw/${id}`);
      }
      await builderRequest("PATCH", `/api/cim-sections/${id}`, { isVisible: false });
      return null;
    },
    onSuccess: (r) => {
      if (r) qc.setQueryData(heldPrivateKey(dealId), r);
      else qc.invalidateQueries({ queryKey: heldPrivateKey(dealId) });
      qc.invalidateQueries({ queryKey: ["/api/deals", dealId, "cim-builder"] });
      toast({ title: "Hidden from buyers", description: "Buyers no longer see that section." });
    },
    onError: (e) => toast({ title: "Couldn't hide it", description: errorText(e), variant: "destructive" }),
  });

  // One heading per matter; each held passage keeps its own switch.
  const groups = useMemo(() => {
    const map = new Map<string, StaffPrivateListItem[]>();
    for (const item of data?.items ?? []) map.set(item.description, [...(map.get(item.description) ?? []), item]);
    return Array.from(map.entries());
  }, [data?.items]);

  const showing = data?.showing ?? [];
  const served = data?.servedShowing ?? [];
  if (!data || (data.items.length === 0 && showing.length === 0 && served.length === 0)) return null;
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
      {served.length > 0 && (
        <div className="space-y-2 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs" data-testid="held-private-served">
          <div className="flex gap-2">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-red-400" />
            <p className="min-w-0 break-words leading-relaxed">
              <span className="font-medium">Buyers are still reading this in the published version.</span>{" "}
              {data.servedFrom === "kept_copy"
                ? "While you review the update, buyers read the version you published. Publish the update, or hide the section from buyers now."
                : "The section changed since you approved it, so buyers read the approved version. Approve the update to publish it, or hide the section from buyers now."}
            </p>
          </div>
          <ul className="space-y-1.5 pl-5">
            {served.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="min-w-0 break-words">
                  “{s.title}” — {s.descriptions.join("; ")}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  disabled={hide.isPending}
                  onClick={() => hide.mutate({ id: s.id })}
                  data-testid="button-hide-served-private"
                >
                  Hide from buyers
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
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
