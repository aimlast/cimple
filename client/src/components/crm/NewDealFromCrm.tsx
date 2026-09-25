/**
 * New Deal → "Start from my CRM": search the broker's Pipedrive, pick the
 * seller's deal / organisation / person, and prefill the form. The picked
 * record is linked (and imported) right after the deal is created — see
 * NewDeal.tsx.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Database, Loader2, X } from "lucide-react";
import type { CrmPrefill, CrmSearchResult } from "@shared/crm-seller";
import { requestJson } from "@/components/information/useInformation";
import { CrmRecordSearch } from "./CrmRecordSearch";

export interface PickedCrmRecord {
  result: CrmSearchResult;
  prefill: CrmPrefill;
}

/** The New Deal industry list, matched from the CRM's own wording. */
const INDUSTRY_KEYWORDS: Array<[RegExp, string]> = [
  [/e-?commerce|online (store|shop)|shopify|amazon seller|dtc|direct[- ]to[- ]consumer/i, "E-commerce"],
  [/health|medical|dental|dentist|clinic|physio|chiropract|pharma|veterinar|optom|massage|therapy|care home|home care/i, "Healthcare"],
  [/restaurant|food|caf[eé]|coffee|bar\b|pub|catering|bakery|pizza|brewery/i, "Restaurant / Food Service"],
  [/software|saas|tech|it services|managed services|app\b|digital/i, "Technology / SaaS"],
  [/construct|contractor|roofing|plumb|electric|hvac|landscap|renovat|paving|excavat/i, "Construction"],
  [/manufactur|fabricat|machin|machine shop|plant|printing|packaging/i, "Manufacturing"],
  [/auto|car wash|mechanic|collision|dealership|tire|towing/i, "Automotive"],
  [/hotel|motel|hospitality|resort|\binn\b|campground|b&b/i, "Hospitality"],
  [/real estate|property management|realty/i, "Real Estate"],
  [/distribut|wholesale|logistics|import|supply/i, "Distribution / Wholesale"],
  [/retail|store|shop|boutique/i, "Retail"],
  [/accounting|bookkeep|legal|law firm|consult|agency|insurance|engineering firm|architect|staffing|professional/i, "Professional Services"],
];

export function industryFromCrm(text: string | null | undefined, options: string[]): string | null {
  if (!text) return null;
  const exact = options.find((o) => o.toLowerCase() === text.trim().toLowerCase());
  if (exact) return exact;
  for (const [re, option] of INDUSTRY_KEYWORDS) if (re.test(text) && options.includes(option)) return option;
  return options.includes("Other") ? "Other" : null;
}

export function NewDealFromCrm({
  picked,
  onPick,
  onClear,
}: {
  picked: PickedCrmRecord | null;
  onPick: (p: PickedCrmRecord) => void;
  onClear: () => void;
}) {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState<string | null>(null);

  const integrations = useQuery<Array<{ provider: string; status: string }>>({
    queryKey: ["/api/integrations"],
    queryFn: () => requestJson("GET", "/api/integrations"),
    staleTime: 60_000,
  });
  const connected = (integrations.data ?? []).some((i) => i.provider === "pipedrive" && i.status === "connected");

  if (integrations.isLoading) return null;

  if (!connected) {
    return (
      <p className="text-xs text-muted-foreground/70 mb-6">
        Keep sellers in Pipedrive?{" "}
        <button type="button" className="text-teal hover:underline" onClick={() => setLocation("/broker/integrations")}>
          Connect it
        </button>{" "}
        to start a deal from the seller's CRM record.
      </p>
    );
  }

  const pick = async (r: CrmSearchResult) => {
    setPicking(`${r.type}:${r.id}`);
    try {
      const prefill = await requestJson<CrmPrefill>("GET", `/api/crm/records/${r.type}/${encodeURIComponent(r.id)}/prefill`);
      onPick({ result: r, prefill });
      setOpen(false);
    } catch (e) {
      toast({ title: "Couldn't read that record", description: (e as Error).message, variant: "destructive" });
    } finally {
      setPicking(null);
    }
  };

  if (picked) {
    const c = picked.prefill.contact;
    return (
      <div className="mb-6 rounded-lg border border-teal/30 bg-teal/5 px-3.5 py-3 flex items-start gap-2.5" data-testid="crm-picked">
        <Database className="h-4 w-4 text-teal mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium break-words">{picked.result.title}</p>
          <p className="text-[11px] text-muted-foreground mt-0.5 leading-snug">
            Filled in from Pipedrive{c?.name ? ` · Seller: ${c.name}` : ""}. After you create the deal, Cimple links it and imports the
            record's notes, emails and files.
          </p>
        </div>
        <button type="button" onClick={onClear} className="text-muted-foreground hover:text-foreground p-0.5" aria-label="Don't use this CRM record">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div className="mb-6">
      {open ? (
        <div className="rounded-lg border border-border bg-card p-3.5 space-y-2">
          <div className="flex items-center gap-2">
            <Database className="h-3.5 w-3.5 text-teal" />
            <p className="text-xs font-medium flex-1">Start from my CRM</p>
            <button type="button" onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground" aria-label="Close">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <CrmRecordSearch dealId={null} onPick={pick} pickingId={picking} autoFocus />
          {picking && (
            <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
              <Loader2 className="h-3 w-3 animate-spin" /> Reading the record…
            </p>
          )}
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          className="w-full h-9 gap-2 text-sm border-dashed border-teal/40 text-teal hover:bg-teal/10"
          onClick={() => setOpen(true)}
          data-testid="button-start-from-crm"
        >
          <Database className="h-4 w-4" /> Start from my CRM
        </Button>
      )}
    </div>
  );
}
