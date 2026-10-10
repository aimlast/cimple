/**
 * TeaserSettings — the teaser's own settings (the Teaser tab's "Teaser
 * settings" row, and the editor's Settings sheet):
 *   Numbers: ranges ("$1M–$2M") or rounded figures ("$1.3M")
 *   Asking price: shown or "Price on request"
 *   Teaser links last: until the teaser is taken offline / 30 / 90 days
 *   When a buyer signs the NDA from the teaser: wait for me / Blind CIM / Full CIM automatically
 */
import { Loader2 } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BLIND_ACCESS_LEVEL, NAMED_ACCESS_LEVEL } from "@shared/access-levels";
import { cn } from "@/lib/utils";
import type { TeaserState } from "./api";
import type { TeaserApi } from "./useTeaser";

export const LINK_LIFETIME_LABEL: Record<string, string> = {
  until_offline: "Until you take the teaser offline",
  "30": "30 days",
  "90": "90 days",
};

export const AUTO_GRANT_LABEL: Record<string, string> = {
  off: "Wait for me",
  [BLIND_ACCESS_LEVEL]: "Give them the Blind CIM automatically",
  [NAMED_ACCESS_LEVEL]: "Give them the Full CIM automatically",
};

export function TeaserSettingsFields({ api, state, className }: { api: TeaserApi; state: TeaserState; className?: string }) {
  const t = state.teaser;
  const busy = api.settings.isPending;
  return (
    <div className={cn("space-y-4", className)} data-testid="teaser-settings">
      <div className="space-y-1.5">
        <Label className="text-xs">Numbers</Label>
        <div className="grid grid-cols-2 rounded-md border border-border bg-muted/30 p-0.5" role="radiogroup" aria-label="Numbers">
          {(["ranges", "rounded"] as const).map((n) => (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={t.numbers === n}
              disabled={busy}
              onClick={() => t.numbers !== n && api.settings.mutate({ numbers: n })}
              className={cn("rounded px-2 py-1.5 text-xs transition-colors", t.numbers === n ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
              data-testid={`teaser-numbers-${n}`}
            >
              {n === "ranges" ? "Ranges" : "Rounded figures"}
            </button>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground">Ranges say “$1M–$2M”; rounded figures say “$1.3M”, like a listing site.</p>
      </div>

      <label className="flex items-center justify-between gap-3">
        <span className="text-xs">
          Show the asking price
          <span className="block text-[11px] text-muted-foreground">Off: buyers read “Price on request”.</span>
        </span>
        <Switch checked={t.showAskingPrice} disabled={busy} onCheckedChange={(v) => api.settings.mutate({ showAskingPrice: v })} />
      </label>

      <div className="space-y-1.5">
        <Label className="text-xs">Teaser links last</Label>
        <Select value={t.linkLifetime} onValueChange={(v) => v !== t.linkLifetime && api.settings.mutate({ linkLifetime: v })} disabled={busy}>
          <SelectTrigger className="h-8 text-xs" data-testid="select-teaser-link-lifetime"><SelectValue /></SelectTrigger>
          <SelectContent>
            {Object.entries(LINK_LIFETIME_LABEL).map(([k, v]) => <SelectItem key={k} value={k} className="text-xs">{v}</SelectItem>)}
          </SelectContent>
        </Select>
        <p className="text-[11px] text-muted-foreground">For links you create from now on.</p>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">When a buyer signs the NDA from the teaser</Label>
        <Select value={t.autoGrant} onValueChange={(v) => v !== t.autoGrant && api.settings.mutate({ autoGrant: v })} disabled={busy}>
          <SelectTrigger className="h-8 text-xs" data-testid="select-teaser-auto-grant"><SelectValue /></SelectTrigger>
          <SelectContent>
            {Object.entries(AUTO_GRANT_LABEL).map(([k, v]) => <SelectItem key={k} value={k} className="text-xs">{v}</SelectItem>)}
          </SelectContent>
        </Select>
        <p className="text-[11px] text-muted-foreground">
          Automatic access only happens once the CIM is live, and never when the name on the NDA doesn't match the person you sent the link to.
        </p>
      </div>
      {busy && <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> Saving…</p>}
    </div>
  );
}
