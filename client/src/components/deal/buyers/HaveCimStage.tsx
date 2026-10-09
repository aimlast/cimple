/**
 * Buyers tab, stage 4 — "Have the CIM". Everyone who can open the CIM:
 * fit (how well the business matches what they want), their decision,
 * reading (how they read the CIM — the reading tracker's status in words
 * and a strip of the pages they read, the same judgement as the Engagement
 * tab; click through to where they read), NDA and link, with link actions
 * (copy / extend / revoke) and the CIM version they see.
 *
 * Fit comes from GET /api/deals/:dealId/buyer-fit and is kept current by the
 * server on every load (server/matching/access-fit.ts).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { formatReadingTime } from "@shared/analytics-v2";
import { useEngagementBuyers } from "@/hooks/useEngagement";
import { PageStrip, StatusChip, stripScale } from "@/components/engagement/buyers/parts";
import { AccessLevelSelect } from "@/components/cim-builder/AccessLevelSelect";
import { useDdRoomNudge } from "@/components/vdr/cim-slots";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import {
  Clock, ThumbsUp, ThumbsDown, Timer, MoreHorizontal, Link2, CalendarPlus, Ban, UserPlus, Send, Lock, Target,
  ChevronDown, ChevronRight,
  FolderLock,
} from "lucide-react";
import type { AccessFit } from "@shared/buyer-fit";
import { invalidateBuyerPipeline } from "@/lib/buyer-pipeline";
import { BuyerFitDialog, FitChip } from "./BuyerFit";

/** Read the server's JSON error body, falling back to a readable default. */
async function readError(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => null);
  return (body && typeof body.error === "string" && body.error) || fallback;
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function viewLinkFor(accessToken: string): string {
  return `${window.location.origin}/view/${accessToken}`;
}

export function shortDate(value: string | Date | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const EXTEND_DAYS = 30;

const DECISIONS: Record<string, { label: string; icon: typeof Clock; className: string }> = {
  under_review: { label: "Still deciding", icon: Clock, className: "text-amber-600 bg-amber-500/10" },
  interested: { label: "Interested", icon: ThumbsUp, className: "text-success-muted-foreground bg-success-muted" },
  not_interested: { label: "Not interested", icon: ThumbsDown, className: "text-red-500 bg-destructive/10" },
  lapsed: { label: "Lapsed", icon: Timer, className: "text-muted-foreground bg-muted" },
};

type GrantPrefill = { buyerEmail?: string | null; buyerName?: string | null; buyerCompany?: string | null };

interface Props {
  dealId: string;
  published: boolean;
  buyers: any[];
  /** Buyers whose link was revoked (and who haven't been given a new one). */
  revokedBuyers?: any[];
  onGrant: (prefill?: GrantPrefill) => void;
  onGoToSend: () => void;
}

/**
 * Buyers whose access was revoked — listed apart, folded away, so a revoked
 * buyer never simply vanishes from the pipeline. "Give a new link" opens
 * Grant access for them (the old link stays dead).
 */
function RevokedList({ buyers, published, onGrant }: { buyers: any[]; published: boolean; onGrant: (prefill?: GrantPrefill) => void }) {
  const [open, setOpen] = useState(false);
  if (!buyers.length) return null;
  const sorted = [...buyers].sort((a, b) => new Date(b.revokedAt).getTime() - new Date(a.revokedAt).getTime());
  return (
    <div className="rounded-lg border border-border" data-testid="revoked-buyers">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-xs text-muted-foreground hover:text-foreground"
        aria-expanded={open}
        data-testid="button-toggle-revoked"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        {buyers.length === 1 ? "1 buyer" : `${buyers.length} buyers`} whose access you revoked
      </button>
      {open && (
        <ul className="border-t border-border divide-y divide-border">
          {sorted.map((b) => (
            <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5" data-testid={`revoked-buyer-${b.id}`}>
              <div className="min-w-0">
                <p className="text-sm text-foreground truncate">{b.buyerName || b.buyerEmail}</p>
                {(b.buyerCompany || b.buyerName) && (
                  <p className="text-xs text-muted-foreground truncate">
                    {[b.buyerCompany, b.buyerName ? b.buyerEmail : null].filter(Boolean).join(" · ")}
                  </p>
                )}
                <p className="text-xs text-muted-foreground/70">Revoked {shortDate(b.revokedAt)}</p>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1.5"
                disabled={!published}
                title={published ? "Creates a new secure link — the old one stays switched off" : "Publish the CIM first"}
                onClick={() => onGrant({ buyerEmail: b.buyerEmail, buyerName: b.buyerName, buyerCompany: b.buyerCompany })}
                data-testid={`button-regrant-${b.id}`}
              >
                <UserPlus className="h-3.5 w-3.5" /> Give a new link
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function HaveCimStage({ dealId, published, buyers, revokedBuyers = [], onGrant, onGoToSend }: Props) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [revokeTarget, setRevokeTarget] = useState<any | null>(null);
  const [fitFor, setFitFor] = useState<any | null>(null);
  // vdr §5.12: a buyer moved to due diligence → "N documents the DD CIM points to aren't shared yet · Share them".
  useDdRoomNudge(dealId, buyers);

  // How each buyer read the CIM (the reading tracker — the same judgement
  // as the Engagement tab). Enriches the table but isn't essential: degrades quietly.
  const { data: engagement } = useEngagementBuyers(dealId);
  const [, setLocation] = useLocation();
  const cardByAccess = useMemo(() => new Map((engagement?.buyers ?? []).map((c) => [c.accessId, c])), [engagement]);
  const stripMax = useMemo(() => stripScale((engagement?.buyers ?? []).map((c) => c.pageStrip)), [engagement]);
  const { data: fitData, isLoading: fitLoading, refetch: refetchFit } = useQuery<{ fits: AccessFit[] }>({
    queryKey: ["/api/deals", dealId, "buyer-fit"],
    enabled: buyers.length > 0,
    refetchOnWindowFocus: true,
  });
  // A buyer who arrived from elsewhere (the seller approved them through their
  // link, a colleague granted a link) gets a fit without a reload.
  const idsKey = buyers.map((b: any) => b.id).sort().join(",");
  const lastIds = useRef(idsKey);
  useEffect(() => {
    if (lastIds.current !== idsKey && buyers.length > 0) refetchFit();
    lastIds.current = idsKey;
  }, [idsKey, buyers.length, refetchFit]);
  const fitMap = new Map((fitData?.fits ?? []).map((f) => [f.accessId, f]));

  const extend = useMutation({
    mutationFn: async (buyer: any) => {
      const base = buyer.expiresAt ? new Date(buyer.expiresAt) : new Date();
      const from = base.getTime() > Date.now() ? base : new Date();
      const expiresAt = new Date(from.getTime() + EXTEND_DAYS * 24 * 60 * 60 * 1000);
      const res = await fetch(`/api/buyers/${buyer.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ expiresAt: expiresAt.toISOString() }),
      });
      if (!res.ok) throw new Error(await readError(res, "Couldn't extend access"));
      return res.json();
    },
    onSuccess: (access) => {
      invalidateBuyerPipeline(qc, dealId);
      toast({ title: "Access extended", description: `Link now expires ${shortDate(access.expiresAt)}.` });
    },
    onError: (err: Error) => toast({ title: "Couldn't extend access", description: err.message, variant: "destructive" }),
  });

  // Server soft-revokes — the row stays for the audit trail.
  const revoke = useMutation({
    mutationFn: async (buyer: any) => {
      const res = await fetch(`/api/buyer-access/${buyer.id}`, { method: "DELETE", credentials: "include" });
      if (!res.ok) throw new Error(await readError(res, "Couldn't revoke access"));
      return res.json();
    },
    onSuccess: (_data, buyer) => {
      invalidateBuyerPipeline(qc, dealId);
      setRevokeTarget(null);
      toast({ title: "Access revoked", description: `${buyer.buyerName || buyer.buyerEmail} can no longer open the CIM.` });
    },
    onError: (err: Error) => toast({ title: "Couldn't revoke access", description: err.message, variant: "destructive" }),
  });

  const copyLink = async (url: string) => {
    const ok = await copyToClipboard(url);
    toast(ok
      ? { title: "Link copied", description: "Paste it into your own email to the buyer." }
      : { title: "Copy the link manually", description: url });
  };

  if (buyers.length === 0) {
    return (
      <div className="space-y-3">
      <div className="rounded-lg border border-dashed border-border p-8 text-center" data-testid="empty-have-cim">
        {published ? <Target className="h-5 w-5 mx-auto text-muted-foreground/50 mb-2" /> : <Lock className="h-5 w-5 mx-auto text-muted-foreground/50 mb-2" />}
        <p className="text-sm text-foreground">No buyers have the CIM yet</p>
        <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">
          {published
            ? "Send it to your best matches, or give someone a link yourself."
            : "Publish the CIM first (Overview tab). Buyers the seller approves before then get it automatically when you publish."}
        </p>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          <Button size="sm" variant="outline" className="gap-1.5" onClick={onGoToSend} data-testid="button-empty-go-send">
            <Send className="h-3.5 w-3.5" /> See who to send it to
          </Button>
          {published && (
            <Button size="sm" className="gap-1.5 bg-teal text-teal-foreground hover:bg-teal/90" onClick={() => onGrant()}>
              <UserPlus className="h-3.5 w-3.5" /> Grant access
            </Button>
          )}
        </div>
      </div>
      <RevokedList buyers={revokedBuyers} published={published} onGrant={onGrant} />
      </div>
    );
  }

  // Everything one row shows, worked out once for the table and the phone cards.
  const rows = buyers.map((buyer: any) => {
    const decision = DECISIONS[buyer.decision || "under_review"] || DECISIONS.under_review;
    const card = cardByAccess.get(buyer.id) ?? null;
    // Visits are counted by the reading tracker (the access row's counter
    // follows it; a card can lag a moment behind) — show the larger.
    const views = Math.max(card?.visits ?? 0, buyer.viewCount ?? 0);
    const expiresAt = buyer.expiresAt ? new Date(buyer.expiresAt) : null;
    return {
      buyer,
      name: buyer.buyerName || buyer.buyerEmail,
      decision,
      nextStep: buyer.decision === "interested" && buyer.decisionNextStep ? String(buyer.decisionNextStep).replace(/_/g, " ") : null,
      card,
      readMs: card?.activeMs ?? 0,
      activity: views === 0 && !card
        ? (buyer.firstViewedAt ? "Opened" : "Not opened yet")
        : `${views} visit${views === 1 ? "" : "s"} · ${card ? formatReadingTime(card.activeMs) : "no reading yet"}`,
      lastActive: buyer.lastAccessedAt ? `Last ${shortDate(buyer.lastAccessedAt)}` : null,
      expiresAt,
      expired: !!expiresAt && expiresAt.getTime() < Date.now(),
      viewUrl: buyer.accessToken ? viewLinkFor(buyer.accessToken) : null,
      fit: fitMap.get(buyer.id),
    };
  });
  // Warmest first: interested, then still deciding, then the rest — best fit first within each.
  const DECISION_ORDER: Record<string, number> = { interested: 0, under_review: 1, lapsed: 2, not_interested: 3 };
  rows.sort((a, b) =>
    (DECISION_ORDER[a.buyer.decision || "under_review"] ?? 1) - (DECISION_ORDER[b.buyer.decision || "under_review"] ?? 1)
    || (b.fit?.score ?? -1) - (a.fit?.score ?? -1)
    || b.readMs - a.readMs
    || String(a.name).localeCompare(String(b.name)));

  const actions = (r: (typeof rows)[number], testIdSuffix = "") => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground"
          aria-label={`Actions for ${r.name}`}
          data-testid={`button-buyer-actions-${r.buyer.id}${testIdSuffix}`}
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem disabled={!r.viewUrl} onClick={() => r.viewUrl && copyLink(r.viewUrl)}>
          <Link2 className="h-3.5 w-3.5 mr-2" /> Copy view link
        </DropdownMenuItem>
        <DropdownMenuItem disabled={extend.isPending} onClick={() => extend.mutate(r.buyer)}>
          <CalendarPlus className="h-3.5 w-3.5 mr-2" /> Extend {EXTEND_DAYS} days
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setFitFor(r.buyer)}>
          <Target className="h-3.5 w-3.5 mr-2" /> Why this fit?
        </DropdownMenuItem>
        {/* Data room (vdr §5.12): this buyer's room access, downloads and what they can see. */}
        <DropdownMenuItem onClick={() => setLocation(`/deal/${dealId}/data-room?view=buyers&buyer=${encodeURIComponent(r.buyer.id)}`)} data-testid={`menu-data-room-${r.buyer.id}${testIdSuffix}`}>
          <FolderLock className="h-3.5 w-3.5 mr-2" /> Data room access…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-red-500 focus:text-red-500" onClick={() => setRevokeTarget(r.buyer)}>
          <Ban className="h-3.5 w-3.5 mr-2" /> Revoke access
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const decisionPill = (r: (typeof rows)[number]) => {
    const Icon = r.decision.icon;
    return (
      <span className={`inline-flex items-center gap-1.5 whitespace-nowrap px-2 py-0.5 rounded-full text-xs font-medium ${r.decision.className}`}>
        <Icon className="h-3 w-3" /> {r.decision.label}
      </span>
    );
  };

  const readingCell = (r: (typeof rows)[number], testIdSuffix = "") => {
    const card = r.card;
    if (!card) {
      return <span className="text-xs text-muted-foreground">{r.buyer.firstViewedAt ? "Opened" : "Not opened yet"}</span>;
    }
    const open = () => setLocation(`/deal/${dealId}/engagement?view=document&buyers=${r.buyer.id}`);
    return (
      <div
        role="link"
        tabIndex={0}
        className="block w-full cursor-pointer text-left"
        onClick={open}
        onKeyDown={(e) => { if (e.key === "Enter") open(); }}
        title="See where they read"
        data-testid={`reading-${r.buyer.id}${testIdSuffix}`}
      >
        {/* The decision already shows under Decision: here, how they read. */}
        {["interested", "not_interested", "lapsed"].includes(card.status)
          ? <span className="text-xs text-muted-foreground">Scrolled through {card.pagesReached} of {card.totalPages} pages</span>
          : <StatusChip status={card.status} label={card.statusLabel} />}
        <PageStrip cells={card.pageStrip} maxMs={stripMax} size="sm" caption={false} className="mt-1.5 w-36 max-w-full" />
      </div>
    );
  };

  const linkCell = (r: (typeof rows)[number]) => (
    <div className="text-xs">
      <p className={r.buyer.ndaSigned ? "text-success-muted-foreground" : "text-muted-foreground"}>
        {r.buyer.ndaSigned ? "NDA signed" : "NDA not signed"}
      </p>
      {r.expiresAt ? (
        <p className={r.expired ? "text-red-500" : "text-muted-foreground/80"}>
          {r.expired ? "Link expired" : "Link expires"} {shortDate(r.expiresAt)}
        </p>
      ) : (
        <p className="text-muted-foreground/60">Link never expires</p>
      )}
    </div>
  );

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        <span className="text-foreground/80 font-medium">Fit</span> = how well this business matches what the buyer wants.{" "}
        <span className="text-foreground/80 font-medium">Reading</span> = how they&apos;ve read the CIM. Click a fit to see why, or their reading to see where they read.
      </p>

      {/* Wide screens: one table. Below lg it doesn't fit beside the sidebar
          (the NDA column and row menu were cut off at ~820px) — cards instead. */}
      <div className="hidden lg:block rounded-lg border border-border overflow-x-auto">
        <table className="w-full text-sm" data-testid="table-have-cim">
          <thead>
            <tr className="border-b border-border bg-muted/30 text-left">
              <th className="px-4 py-2.5 text-xs font-medium text-muted-foreground">Buyer</th>
              <th className="px-3 py-2.5 text-xs font-medium text-muted-foreground" title="How well this business matches the buyer's criteria">Fit</th>
              <th className="px-3 py-2.5 text-xs font-medium text-muted-foreground">Decision</th>
              <th className="px-3 py-2.5 text-xs font-medium text-muted-foreground" title="How they've read the CIM">Reading</th>
              <th className="hidden xl:table-cell px-3 py-2.5 text-xs font-medium text-muted-foreground">Activity</th>
              <th className="px-3 py-2.5 text-xs font-medium text-muted-foreground">NDA &amp; link</th>
              <th className="px-2 py-2.5"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.buyer.id} className="border-b border-border last:border-0 align-top hover:bg-muted/20 transition-colors" data-testid={`row-have-cim-${r.buyer.id}`}>
                <td className="px-4 py-3 min-w-[180px]">
                  <p className="font-medium text-foreground">{r.name}</p>
                  {r.buyer.buyerCompany && <p className="text-xs text-muted-foreground mt-0.5">{r.buyer.buyerCompany}</p>}
                  {r.buyer.buyerName && <p className="text-xs text-muted-foreground/60">{r.buyer.buyerEmail}</p>}
                  {/* Which CIM version this buyer sees (teaser → blind with locked
                      sections, full → blind, LOI → named, DD → named + DD detail). */}
                  <div className="mt-1.5 flex items-center gap-1.5">
                    <span className="text-[11px] text-muted-foreground whitespace-nowrap">Sees</span>
                    <AccessLevelSelect dealId={dealId} buyer={r.buyer} />
                  </div>
                </td>
                <td className="px-3 py-3"><FitChip fit={r.fit} loading={fitLoading} onOpen={() => setFitFor(r.buyer)} /></td>
                <td className="px-3 py-3">
                  {decisionPill(r)}
                  {r.nextStep && <p className="text-xs text-muted-foreground mt-1">Next: {r.nextStep}</p>}
                </td>
                <td className="px-3 py-3 min-w-[170px]">
                  {readingCell(r)}
                  <p className="xl:hidden mt-1 text-[11px] text-muted-foreground whitespace-nowrap">{r.activity}</p>
                </td>
                <td className="hidden xl:table-cell px-3 py-3">
                  <p className="text-xs text-muted-foreground whitespace-nowrap">{r.activity}</p>
                  {r.lastActive && <p className="text-xs text-muted-foreground/60">{r.lastActive}</p>}
                </td>
                <td className="px-3 py-3">{linkCell(r)}</td>
                <td className="px-2 py-3 text-right">{actions(r)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Phones and tablets: one card per buyer (two across on tablets) */}
      <div className="lg:hidden grid gap-2.5 md:grid-cols-2" data-testid="cards-have-cim">
        {rows.map((r) => (
          <div key={r.buyer.id} className="min-w-0 rounded-lg border border-border bg-card p-3.5 space-y-3" data-testid={`card-have-cim-${r.buyer.id}`}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-medium text-foreground truncate">{r.name}</p>
                <p className="text-xs text-muted-foreground truncate">
                  {[r.buyer.buyerCompany, r.buyer.buyerName ? r.buyer.buyerEmail : null].filter(Boolean).join(" · ")}
                </p>
              </div>
              {actions(r, "-card")}
            </div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-3">
              <div>
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">Fit</p>
                <FitChip fit={r.fit} loading={fitLoading} onOpen={() => setFitFor(r.buyer)} testIdSuffix="-card" />
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">Decision</p>
                {decisionPill(r)}
                {r.nextStep && <p className="text-[11px] text-muted-foreground mt-1">Next: {r.nextStep}</p>}
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">Reading</p>
                {readingCell(r, "-card")}
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">Activity</p>
                <p className="text-xs text-muted-foreground">{r.activity}</p>
                {r.lastActive && <p className="text-[11px] text-muted-foreground/60">{r.lastActive}</p>}
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2.5">
              {linkCell(r)}
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] text-muted-foreground">Sees</span>
                <AccessLevelSelect dealId={dealId} buyer={r.buyer} testIdSuffix="-card" />
              </div>
            </div>
          </div>
        ))}
      </div>

      <RevokedList buyers={revokedBuyers} published={published} onGrant={onGrant} />

      <BuyerFitDialog
        dealId={dealId}
        buyer={fitFor}
        fit={fitFor ? fitMap.get(fitFor.id) : undefined}
        open={!!fitFor}
        onOpenChange={(o) => !o && setFitFor(null)}
      />

      <AlertDialog open={!!revokeTarget} onOpenChange={(open) => !open && setRevokeTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke access?</AlertDialogTitle>
            <AlertDialogDescription>
              {revokeTarget?.buyerName || revokeTarget?.buyerEmail} will no longer be able to
              open the CIM. Their activity history is kept. You can grant a new link later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoke.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={revoke.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (revokeTarget) revoke.mutate(revokeTarget);
              }}
              data-testid="button-revoke-access-confirm"
            >
              {revoke.isPending ? "Revoking…" : "Revoke access"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
