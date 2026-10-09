/**
 * Buyers tab, stage 3 — "Have the teaser" (spec §5.6). Everyone with a
 * teaser link: when it was sent, how they read it (not opened · opened ·
 * read to the end · where they stopped, and a brass "Worth a call" when they
 * read it but didn't ask), and what happened next (asked for the CIM ·
 * given the CIM · declined · not for them · asked for a fresh link).
 *
 * Filters: All · Worth a call · Asked for the CIM · Not for them · Not opened.
 * A table at ≥ 1024 px, cards below. Actions: Copy link · Give the CIM… ·
 * Remove access. Data: GET /api/deals/:id/teaser/engagement.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Ban, Link2, Loader2, MoreHorizontal, PhoneCall, Send, UserPlus, Megaphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PanelError } from "@/components/deal/PanelError";
import { useToast } from "@/hooks/use-toast";
import { formatReadingTime } from "@shared/analytics-v2";
import { ACCESS_LEVELS, BLIND_ACCESS_LEVEL, DD_ACCESS_LEVEL, NAMED_ACCESS_LEVEL, TEASER_ACCESS_LEVEL, normalizeAccessLevel, type AccessLevel } from "@shared/access-levels";
import { TEASER_PASS_REASON_WORDS, type TeaserEngagement, type TeaserEngagementBuyer, type TeaserPassReason } from "@shared/teaser";
import { invalidateBuyerPipeline } from "@/lib/buyer-pipeline";
import { cn } from "@/lib/utils";
import { teaserEngagementKey, teaserRequest } from "@/components/teaser/api";
import { copyToClipboard, shortDate, viewLinkFor } from "./HaveCimStage";
import { LevelRadio, LEVEL_TERMS } from "./LevelRadio";

export type TeaserFilter = "all" | "call" | "asked" | "passed" | "unopened";
export const TEASER_FILTERS: Array<{ key: TeaserFilter; label: string }> = [
  { key: "all", label: "All" },
  { key: "call", label: "Worth a call" },
  { key: "asked", label: "Asked for the CIM" },
  { key: "passed", label: "Not for them" },
  { key: "unopened", label: "Not opened" },
];

export function matchesTeaserFilter(b: TeaserEngagementBuyer, f: TeaserFilter): boolean {
  switch (f) {
    case "call": return b.worthACall;
    case "asked": return b.request.state !== "none";
    case "passed": return !!b.passed;
    case "unopened": return !b.firstOpenedAt;
    default: return true;
  }
}

/** "Not opened yet" / "Opened · 2 min · read to the end" / "Opened · 40 s · stopped at Investment highlights". */
export function teaserReadLine(b: Pick<TeaserEngagementBuyer, "firstOpenedAt" | "activeMs" | "readToEnd" | "furthestBlock">): string {
  if (!b.firstOpenedAt) return "Not opened yet";
  const parts = ["Opened", formatReadingTime(b.activeMs)];
  if (b.readToEnd) parts.push("read to the end");
  else if (b.furthestBlock) parts.push(`stopped at ${b.furthestBlock}`);
  return parts.join(" · ");
}

/** "the Blind CIM" / "the Full CIM" / "due-diligence access". */
export function grantNoun(level: string | null | undefined): string {
  return ACCESS_LEVELS.find((l) => l.key === normalizeAccessLevel(level))?.grantNoun ?? "the CIM";
}

/** What happened next, in words (the Next column). */
export function teaserNextLine(b: Pick<TeaserEngagementBuyer, "request" | "passed" | "freshLinkRequestedAt" | "expired">): { text: string; action: "review" | "fresh" | null } {
  const r = b.request;
  if (r.state === "requested") return { text: `Asked ${shortDate(r.at)} · waiting for you`, action: "review" };
  if (r.state === "approved_waiting") return { text: `Approved — gets ${r.level ? grantNoun(r.level) : "the CIM"} when the CIM goes live`, action: null };
  if (r.state === "granted") return { text: `Given ${r.level ? grantNoun(r.level) : "the CIM"} ${shortDate(r.at)}${r.grantedBy === "auto" ? " automatically" : ""}`, action: null };
  if (r.state === "declined") return { text: `Declined ${shortDate(r.at)}`, action: null };
  if (b.freshLinkRequestedAt && b.expired) return { text: `Asked for a fresh link ${shortDate(b.freshLinkRequestedAt)}`, action: "fresh" };
  if (b.passed) {
    const why = b.passed.reasons.map((x) => TEASER_PASS_REASON_WORDS[x as TeaserPassReason] ?? x).join(", ");
    return { text: `Not for them${why ? ` · ${why}` : ""}`, action: null };
  }
  return { text: "—", action: null };
}

interface AccessRow { id: string; accessToken?: string; accessLevel?: string | null; revokedAt?: string | null }

export function HaveTeaserStage({
  dealId, published, cimLive, accessRows, onGoToApproval, onGoToTeaser, onGrantTeaser,
}: {
  dealId: string;
  /** A teaser is published (links can be given). */
  published: boolean;
  cimLive: boolean;
  /** /api/deals/:id/buyers rows (for the link tokens). */
  accessRows: AccessRow[];
  onGoToApproval: () => void;
  onGoToTeaser: () => void;
  /** Open "Give access" with the Teaser chosen. */
  onGrantTeaser: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [filter, setFilter] = useState<TeaserFilter>("all");
  const [giveFor, setGiveFor] = useState<TeaserEngagementBuyer | null>(null);
  const [removeFor, setRemoveFor] = useState<TeaserEngagementBuyer | null>(null);
  const q = useQuery<TeaserEngagement>({
    queryKey: teaserEngagementKey(dealId),
    queryFn: () => teaserRequest("GET", `/api/deals/${dealId}/teaser/engagement`),
    refetchOnWindowFocus: true,
    refetchInterval: 30_000,
  });
  const tokenOf = useMemo(() => new Map(accessRows.map((a) => [a.id, a.accessToken])), [accessRows]);

  const fresh = useMutation({
    mutationFn: (b: TeaserEngagementBuyer) => teaserRequest("POST", `/api/deals/${dealId}/buyers`, { accessLevel: TEASER_ACCESS_LEVEL, buyerEmail: b.email, buyerName: b.name, buyerCompany: b.company }),
    onSuccess: async (access: { accessToken: string; buyerEmail: string }) => {
      invalidateBuyerPipeline(qc, dealId);
      const ok = await copyToClipboard(viewLinkFor(access.accessToken));
      toast({ title: "New teaser link created", description: ok ? `Copied — paste it into your email to ${access.buyerEmail}.` : `Copy it from the buyer's menu and send it to ${access.buyerEmail}.` });
    },
    onError: (e) => toast({ title: "Couldn't create the link", description: e instanceof Error ? e.message : undefined, variant: "destructive" }),
  });
  const remove = useMutation({
    mutationFn: (b: TeaserEngagementBuyer) => teaserRequest("DELETE", `/api/buyer-access/${b.accessId}`),
    onSuccess: (_r, b) => {
      invalidateBuyerPipeline(qc, dealId);
      setRemoveFor(null);
      toast({ title: "Access removed", description: `${b.name || b.email} can no longer open the summary.` });
    },
    onError: (e) => toast({ title: "Couldn't remove access", description: e instanceof Error ? e.message : undefined, variant: "destructive" }),
  });

  if (q.isLoading) {
    return <div className="space-y-2"><Skeleton className="h-8 w-80" /><Skeleton className="h-40 w-full" /></div>;
  }
  if (q.error || !q.data) return <PanelError what="who has the teaser" onRetry={() => q.refetch()} />;

  const buyers = q.data.buyers;
  if (buyers.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-8 text-center" data-testid="empty-have-teaser">
        <Megaphone className="mx-auto mb-2 h-5 w-5 text-muted-foreground/50" />
        {published ? (
          <>
            <p className="text-sm text-foreground">No teasers sent yet</p>
            <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
              Draft emails to suggested buyers in step 2 — each one gets their own teaser link — or give someone a teaser link with Give access.
            </p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <Button size="sm" className="gap-1.5 bg-teal text-teal-foreground hover:bg-teal/90" onClick={onGrantTeaser}><UserPlus className="h-3.5 w-3.5" /> Give a teaser link</Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-foreground">Publish a teaser first</p>
            <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">The teaser is the short anonymous summary buyers read before the NDA. Write it on the CIM tab.</p>
            <Button size="sm" variant="outline" className="mt-4" onClick={onGoToTeaser} data-testid="button-go-to-teaser">Go to the teaser</Button>
          </>
        )}
      </div>
    );
  }

  const counts = Object.fromEntries(TEASER_FILTERS.map((f) => [f.key, buyers.filter((b) => matchesTeaserFilter(b, f.key)).length])) as Record<TeaserFilter, number>;
  const shown = buyers
    .filter((b) => matchesTeaserFilter(b, filter))
    .sort((a, b) => Number(b.worthACall) - Number(a.worthACall) || Number(b.request.state === "requested") - Number(a.request.state === "requested") || (b.activeMs - a.activeMs));

  const actions = (b: TeaserEngagementBuyer, suffix = "") => {
    const token = tokenOf.get(b.accessId);
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" aria-label={`Actions for ${b.name || b.email}`} data-testid={`button-teaser-buyer-actions-${b.accessId}${suffix}`}>
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem
            disabled={!token || !b.active}
            onClick={async () => {
              if (!token) return;
              const ok = await copyToClipboard(viewLinkFor(token));
              toast(ok ? { title: "Link copied", description: "Paste it into your own email to the buyer." } : { title: "Copy the link manually", description: viewLinkFor(token) });
            }}
          >
            <Link2 className="mr-2 h-3.5 w-3.5" /> Copy link
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!b.active} onClick={() => setGiveFor(b)}>
            <Send className="mr-2 h-3.5 w-3.5" /> Give the CIM…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="text-red-500 focus:text-red-500" disabled={!b.active} onClick={() => setRemoveFor(b)}>
            <Ban className="mr-2 h-3.5 w-3.5" /> Remove access
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  };

  const readCell = (b: TeaserEngagementBuyer) => (
    <div className="space-y-1">
      <p className={cn("text-xs", b.firstOpenedAt ? "text-foreground/85" : "text-muted-foreground")}>{teaserReadLine(b)}</p>
      {b.worthACall && (
        <span className="inline-flex items-center gap-1 rounded-full bg-teal/15 px-2 py-0.5 text-[11px] font-medium text-teal" data-testid={`chip-worth-a-call-${b.accessId}`}>
          <PhoneCall className="h-3 w-3" /> Worth a call
        </span>
      )}
    </div>
  );
  const nextCell = (b: TeaserEngagementBuyer) => {
    const n = teaserNextLine(b);
    return (
      <div className="space-y-1">
        <p className={cn("text-xs", n.text === "—" ? "text-muted-foreground" : "text-foreground/85")}>{n.text}</p>
        {n.action === "review" && <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onGoToApproval}>Review</Button>}
        {n.action === "fresh" && (
          <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" disabled={fresh.isPending || !published} onClick={() => fresh.mutate(b)}>
            {fresh.isPending && <Loader2 className="h-3 w-3 animate-spin" />} Give a new link
          </Button>
        )}
      </div>
    );
  };
  const sentLine = (b: TeaserEngagementBuyer) => (b.sentAt ? `${shortDate(b.sentAt)} · ${b.via === "email" ? "by email" : "link"}` : "—");

  return (
    <div className="space-y-3">
      <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0" role="group" aria-label="Show" data-testid="teaser-filters">
        {TEASER_FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            aria-pressed={filter === f.key}
            onClick={() => setFilter(f.key)}
            className={cn(
              "shrink-0 rounded-full border px-3 py-1 text-xs transition-colors",
              filter === f.key ? "border-teal bg-teal/15 text-foreground" : "border-border text-muted-foreground hover:border-teal/40 hover:text-foreground",
            )}
            data-testid={`teaser-filter-${f.key}`}
          >
            {f.label} <span className="tabular-nums text-muted-foreground">{counts[f.key]}</span>
          </button>
        ))}
      </div>
      {!published && (
        <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          The teaser is offline, so these links show “not available right now”. <button type="button" className="text-teal hover:underline" onClick={onGoToTeaser}>Go to the teaser</button>
        </p>
      )}

      {shown.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-xs text-muted-foreground">Nobody here yet.</p>
      ) : (
        <>
          <div className="hidden overflow-x-auto rounded-lg border border-border lg:block">
            <table className="w-full text-sm" data-testid="table-have-teaser">
              <thead>
                <tr className="border-b border-border bg-muted/30 text-left">
                  <th className="px-4 py-2.5 text-xs font-medium text-muted-foreground">Buyer</th>
                  <th className="px-3 py-2.5 text-xs font-medium text-muted-foreground">Sent</th>
                  <th className="px-3 py-2.5 text-xs font-medium text-muted-foreground">Read</th>
                  <th className="px-3 py-2.5 text-xs font-medium text-muted-foreground">Next</th>
                  <th className="px-2 py-2.5"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((b) => (
                  <tr key={b.accessId} className={cn("border-b border-border align-top last:border-0", !b.active && "opacity-70")} data-testid={`row-have-teaser-${b.accessId}`}>
                    <td className="min-w-[200px] px-4 py-3">
                      <p className="font-medium text-foreground">{b.name || b.email}</p>
                      {b.company && <p className="mt-0.5 text-xs text-muted-foreground">{b.company}</p>}
                      {b.name && <p className="text-xs text-muted-foreground/60">{b.email}</p>}
                      {b.signedBy && <p className="mt-0.5 text-[11px] text-amber-500" data-testid={`text-teaser-signed-by-${b.accessId}`}>Signed by {b.signedBy}</p>}
                      {b.expired && b.active && <p className="mt-0.5 text-[11px] text-amber-500">Link expired</p>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-xs text-muted-foreground">{sentLine(b)}</td>
                    <td className="min-w-[200px] px-3 py-3">{readCell(b)}</td>
                    <td className="min-w-[200px] px-3 py-3">{nextCell(b)}</td>
                    <td className="px-2 py-3 text-right">{actions(b)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="grid gap-2.5 md:grid-cols-2 lg:hidden" data-testid="cards-have-teaser">
            {shown.map((b) => (
              <div key={b.accessId} className={cn("min-w-0 space-y-2.5 rounded-lg border border-border bg-card p-3.5", !b.active && "opacity-70")} data-testid={`card-have-teaser-${b.accessId}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{b.name || b.email}</p>
                    <p className="truncate text-xs text-muted-foreground">{[b.company, b.name ? b.email : null].filter(Boolean).join(" · ")}</p>
                    {b.signedBy && <p className="truncate text-[11px] text-amber-500">Signed by {b.signedBy}</p>}
                  </div>
                  {actions(b, "-card")}
                </div>
                <p className="text-[11px] text-muted-foreground">Sent {sentLine(b)}</p>
                {readCell(b)}
                {nextCell(b)}
              </div>
            ))}
          </div>
        </>
      )}

      {giveFor && (
        <GiveCimDialog
          buyer={giveFor}
          cimLive={cimLive}
          onClose={() => setGiveFor(null)}
          onDone={() => { setGiveFor(null); invalidateBuyerPipeline(qc, dealId); }}
          onSeeHaveCim={() => navigate(`/deal/${dealId}/buyers?stage=have`)}
        />
      )}
      <AlertDialog open={!!removeFor} onOpenChange={(o) => !o && setRemoveFor(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removeFor?.name || removeFor?.email}'s access?</AlertDialogTitle>
            <AlertDialogDescription>Their teaser link stops working. What they read is kept. You can give them a new link later.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" disabled={remove.isPending} onClick={(e) => { e.preventDefault(); if (removeFor) remove.mutate(removeFor); }}>
              {remove.isPending ? "Removing…" : "Remove access"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** "Give the CIM…" for a teaser reader: the level, then the same link opens the CIM (30 days from today). */
function GiveCimDialog({ buyer, cimLive, onClose, onDone, onSeeHaveCim }: { buyer: TeaserEngagementBuyer; cimLive: boolean; onClose: () => void; onDone: () => void; onSeeHaveCim: () => void }) {
  const { toast } = useToast();
  const [level, setLevel] = useState<AccessLevel>(BLIND_ACCESS_LEVEL);
  const who = buyer.name?.split(/\s+/)[0] || buyer.email;
  const give = useMutation({
    mutationFn: () => teaserRequest("PATCH", `/api/buyers/${buyer.accessId}`, { accessLevel: level }),
    onSuccess: () => {
      toast({
        title: `${who} now has ${grantNoun(level)}`,
        description: cimLive ? "Their teaser link now opens the CIM. Let them know — nothing was emailed." : "They'll see the CIM on the same link once you publish it.",
      });
      onDone();
      onSeeHaveCim();
    },
    onError: (e) => toast({ title: "Couldn't give the CIM", description: e instanceof Error ? e.message : undefined, variant: "destructive" }),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Give {who} the CIM</DialogTitle>
          <DialogDescription>Their teaser link opens the CIM instead. Nothing is emailed — you tell them.</DialogDescription>
        </DialogHeader>
        <LevelRadio
          name="Give the CIM"
          columns={1}
          value={level}
          onChange={setLevel}
          options={[BLIND_ACCESS_LEVEL, NAMED_ACCESS_LEVEL, DD_ACCESS_LEVEL].map((l) => ({ level: l, line: LEVEL_TERMS[l] }))}
        />
        <p className="text-xs text-muted-foreground">{cimLive ? "Their link will then last 30 days from today." : "The CIM isn't live yet — they'll get it when you publish it."}</p>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button className="bg-teal text-teal-foreground hover:bg-teal/90" disabled={give.isPending} onClick={() => give.mutate()} data-testid="button-give-cim-confirm">
            {give.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />} Give the CIM
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
