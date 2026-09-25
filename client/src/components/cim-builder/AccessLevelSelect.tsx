/**
 * AccessLevelSelect — a buyer's CIM access level on the deal's Buyers tab
 * (Teaser · Full · LOI · Due diligence), each with a one-line explanation.
 * Saves through PATCH /api/buyers/:id (validated server-side).
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { BUYER_ACCESS_LEVELS } from "@shared/cim-layouts";
import { builderRequest, errorText } from "./api";

interface Props {
  dealId: string;
  buyer: { id: string; accessLevel?: string | null; buyerName?: string | null; buyerEmail: string };
}

export function AccessLevelSelect({ dealId, buyer }: Props) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const current = BUYER_ACCESS_LEVELS.some((l) => l.key === buyer.accessLevel) ? buyer.accessLevel! : "teaser";

  const save = useMutation({
    mutationFn: (accessLevel: string) => builderRequest("PATCH", `/api/buyers/${buyer.id}`, { accessLevel }),
    onSuccess: (_r, level) => {
      qc.invalidateQueries({ queryKey: ["/api/deals", dealId, "buyers"] });
      qc.invalidateQueries({ queryKey: ["/api/deals", dealId, "cim-builder"] });
      const meta = BUYER_ACCESS_LEVELS.find((l) => l.key === level);
      toast({
        title: `${buyer.buyerName || buyer.buyerEmail} now has ${meta?.label ?? level} access`,
        description: meta?.description,
      });
    },
    onError: (e) => toast({ title: "Couldn't change access", description: errorText(e), variant: "destructive" }),
  });

  return (
    <Select value={current} onValueChange={(v) => v !== current && save.mutate(v)} disabled={save.isPending}>
      <SelectTrigger
        className="h-7 w-[124px] text-xs"
        aria-label={`CIM access for ${buyer.buyerName || buyer.buyerEmail}`}
        data-testid={`select-access-level-${buyer.id}`}
      >
        {save.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
        {/* Only the label in the trigger — the items also carry an explanation. */}
        <SelectValue>{BUYER_ACCESS_LEVELS.find((l) => l.key === current)?.label}</SelectValue>
      </SelectTrigger>
      <SelectContent align="start" className="w-72">
        {BUYER_ACCESS_LEVELS.map((l) => (
          <SelectItem key={l.key} value={l.key} className="text-xs">
            <span className="block font-medium">{l.label}</span>
            <span className="block text-[11px] text-muted-foreground leading-snug whitespace-normal">{l.description}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
