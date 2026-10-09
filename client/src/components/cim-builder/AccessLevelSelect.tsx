/**
 * AccessLevelSelect — what a buyer's link opens, on the deal's Buyers tab
 * (Teaser · Blind CIM · Full CIM · Due diligence — shared/access-levels.ts),
 * each with a one-line explanation. Saves through PATCH /api/buyers/:id
 * (validated server-side; legacy values show as the level they mean).
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { ACCESS_LEVELS, TEASER_ACCESS_LEVEL, accessLevelLabel, normalizeAccessLevel } from "@shared/access-levels";
import { builderRequest, errorText } from "./api";

interface Props {
  dealId: string;
  buyer: { id: string; accessLevel?: string | null; buyerName?: string | null; buyerEmail: string };
  /** Keeps test ids unique when the same buyer renders twice (table + phone card). */
  testIdSuffix?: string;
  /** A teaser is published, so "Teaser" can be chosen (the server refuses it otherwise). */
  teaserPublished?: boolean;
}

export function AccessLevelSelect({ dealId, buyer, testIdSuffix = "", teaserPublished = false }: Props) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const current = normalizeAccessLevel(buyer.accessLevel);
  const who = buyer.buyerName || buyer.buyerEmail;

  const save = useMutation({
    mutationFn: (accessLevel: string) => builderRequest("PATCH", `/api/buyers/${buyer.id}`, { accessLevel }),
    onSuccess: (_r, level) => {
      qc.invalidateQueries({ queryKey: ["/api/deals", dealId, "buyers"] });
      qc.invalidateQueries({ queryKey: ["/api/deals", dealId, "cim-builder"] });
      const meta = ACCESS_LEVELS.find((l) => l.key === normalizeAccessLevel(level));
      toast({
        title: `${who} now has ${meta?.grantNoun ?? accessLevelLabel(level)}`,
        description: meta?.description,
      });
    },
    onError: (e) => toast({ title: "Couldn't change access", description: errorText(e), variant: "destructive" }),
  });

  return (
    <Select value={current} onValueChange={(v) => v !== current && save.mutate(v)} disabled={save.isPending}>
      <SelectTrigger
        className="h-7 w-[124px] shrink-0 text-xs"
        aria-label={`What ${who} can see`}
        data-testid={`select-access-level-${buyer.id}${testIdSuffix}`}
      >
        {save.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
        {/* Only the label in the trigger — the items also carry an explanation. */}
        <SelectValue>{accessLevelLabel(current)}</SelectValue>
      </SelectTrigger>
      <SelectContent align="start" className="w-72">
        {ACCESS_LEVELS.map((l) => {
          const unavailable = l.key === TEASER_ACCESS_LEVEL && !teaserPublished && current !== TEASER_ACCESS_LEVEL;
          return (
            <SelectItem key={l.key} value={l.key} className="text-xs" disabled={unavailable} data-testid={`option-access-level-${l.key}${testIdSuffix}`}>
              <span className="block font-medium">{l.label}</span>
              <span className="block text-[11px] text-muted-foreground leading-snug whitespace-normal">
                {unavailable ? "Publish the teaser first." : l.description}
              </span>
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}
