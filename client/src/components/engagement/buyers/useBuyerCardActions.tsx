/**
 * What a broker can do from a buyer card, in one place (the deal's Buyers
 * view, Analytics → Who to call, Analytics → Buyers): Email (the broker's own
 * email dialog; nothing is ever sent automatically), copy their email when
 * they have no Cimple profile, Nudge an unopened buyer, Mark contacted,
 * Copy their link, and "Summarise for my call" (the existing AI brief).
 *
 *   useBuyerCardActions(dealId)  one deal: reads the deal's access rows
 *   useNudge()                   across deals: takes the buyer's details directly
 */
import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { BuyerEngagementCard } from "@shared/analytics-v2";
import { useBuyerBrief, useMarkContacted } from "@/hooks/useEngagement";
import { useToast } from "@/hooks/use-toast";
import { EmailDialog } from "@/components/buyers/profile/ActionDialogs";
import type { BuyerCardProps } from "./BuyerCard";

export interface DealAccessRow {
  id: string;
  buyerEmail: string;
  buyerName: string | null;
  buyerUserId: string | null;
  accessToken?: string | null;
}

export const NO_PROFILE_EMAIL_HINT = "Copies their email: they don't have a Cimple profile yet";

interface EmailTarget { buyerUserId: string; name: string; email: string; dealId: string }

function useCopy() {
  const { toast } = useToast();
  return async (text: string, title: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title, description: text.length > 80 ? undefined : text });
    } catch {
      toast({ title: "Copy this", description: text });
    }
  };
}

function emailDialog(target: EmailTarget | null, close: () => void): ReactNode {
  if (!target) return null;
  return (
    <EmailDialog
      open
      onOpenChange={(o) => { if (!o) close(); }}
      buyerId={target.buyerUserId}
      buyerName={target.name}
      buyerEmail={target.email}
      defaultDealId={target.dealId}
    />
  );
}

/** Nudge across deals (Analytics → Buyers): the broker's email dialog, or their email copied. Nothing is sent automatically. */
export function useNudge() {
  const copy = useCopy();
  const [emailFor, setEmailFor] = useState<EmailTarget | null>(null);
  return {
    nudge(row: { buyerUserId: string | null; email: string; name: string; dealId: string }) {
      if (row.buyerUserId) setEmailFor({ buyerUserId: row.buyerUserId, name: row.name || row.email, email: row.email, dealId: row.dealId });
      else void copy(row.email, "Email copied");
    },
    dialogs: emailDialog(emailFor, () => setEmailFor(null)),
  };
}

export function useBuyerCardActions(dealId: string) {
  const { toast } = useToast();
  const copy = useCopy();
  const { data: accessRows = [] } = useQuery<DealAccessRow[]>({
    queryKey: ["/api/deals", dealId, "buyers"],
    queryFn: async () => {
      const r = await fetch(`/api/deals/${dealId}/buyers`, { credentials: "include" });
      return r.ok ? r.json() : [];
    },
    enabled: !!dealId,
  });
  const contacted = useMarkContacted(dealId);
  const brief = useBuyerBrief(dealId);
  const [briefs, setBriefs] = useState<Record<string, { text: string; generatedAt: string }>>({});
  const [briefing, setBriefing] = useState<string | null>(null);
  const [emailFor, setEmailFor] = useState<EmailTarget | null>(null);
  const byAccess = useMemo(() => new Map(accessRows.map((a) => [a.id, a])), [accessRows]);

  const openEmailOrCopy = (accessId: string) => {
    const row = byAccess.get(accessId);
    if (!row) return;
    if (row.buyerUserId) setEmailFor({ buyerUserId: row.buyerUserId, name: row.buyerName || row.buyerEmail, email: row.buyerEmail, dealId });
    else void copy(row.buyerEmail, "Email copied");
  };

  const markContacted = (accessId: string, name: string) =>
    contacted.mutate(accessId, {
      onSuccess: () => toast({ title: "Marked as contacted", description: `${name.split(" ")[0]} moves down the list for two days.` }),
      onError: (e: Error) => toast({ title: "Couldn't save that", description: e.message, variant: "destructive" }),
    });

  const askBrief = (accessId: string) => {
    setBriefing(accessId);
    brief.mutate(accessId, {
      onSuccess: (r) => setBriefs((b) => ({ ...b, [accessId]: { text: r.text, generatedAt: r.generatedAt } })),
      onError: (e: Error) => {
        let msg = e.message;
        try { msg = JSON.parse(msg).error ?? msg; } catch { /* plain text */ }
        toast({ title: "Couldn't write the summary", description: msg, variant: "destructive" });
      },
      onSettled: () => setBriefing(null),
    });
  };

  type ActionProps = Pick<BuyerCardProps, "onEmail" | "emailDisabledReason" | "onContacted" | "contacting" | "onBrief" | "briefing" | "brief" | "onCloseBrief">;

  return {
    /** The action props for one card. */
    propsFor(card: Pick<BuyerEngagementCard, "accessId" | "name">): ActionProps {
      const row = byAccess.get(card.accessId);
      return {
        onEmail: row ? () => openEmailOrCopy(card.accessId) : undefined,
        emailDisabledReason: row && !row.buyerUserId ? NO_PROFILE_EMAIL_HINT : null,
        onContacted: () => markContacted(card.accessId, card.name),
        contacting: contacted.isPending && contacted.variables === card.accessId,
        onBrief: () => askBrief(card.accessId),
        briefing: briefing === card.accessId,
        brief: briefs[card.accessId] ?? null,
        onCloseBrief: () => setBriefs((b) => { const n = { ...b }; delete n[card.accessId]; return n; }),
      };
    },
    /** Whether Nudge can email (a Cimple profile) or only copy their email; null when the row isn't loaded. */
    nudgeMode(accessId: string): "email" | "copy" | null {
      const row = byAccess.get(accessId);
      return row ? (row.buyerUserId ? "email" : "copy") : null;
    },
    nudge: openEmailOrCopy,
    /** Copy the buyer's own view-room link (the broker's deal; the same link the Buyers tab copies). */
    copyLink(accessId: string): boolean {
      const row = byAccess.get(accessId);
      if (!row?.accessToken) return false;
      void copy(`${window.location.origin}/view/${row.accessToken}`, "Link copied");
      return true;
    },
    hasLink: (accessId: string) => !!byAccess.get(accessId)?.accessToken,
    dialogs: emailDialog(emailFor, () => setEmailFor(null)),
  };
}

export type BuyerCardActions = ReturnType<typeof useBuyerCardActions>;
