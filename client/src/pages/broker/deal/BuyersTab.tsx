/**
 * BuyersTab — one buyer pipeline, four stages in the order a buyer moves:
 *
 *   1. Find new buyers      — outside acquirers found on the web (ExternalAcquirersPanel)
 *   2. Send it to next      — people in the broker's list without this CIM (SuggestedBuyersPanel)
 *   3. Waiting for approval — submitted buyers, broker then seller sign-off (BuyerApprovalsPanel)
 *   4. Have the CIM         — access holders: fit, decision, engagement, link actions (HaveCimStage)
 *
 * One stage shows at a time; the stage lives in the URL (?stage=) so links
 * and Back work. Every change that moves a buyer refreshes all four lists
 * (invalidateBuyerPipeline), so a buyer granted access or approved moves on
 * by itself. "Grant access" and the deal's NDA terms sit at the top of the
 * tab, whatever the stage.
 */
import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation, useSearch } from "wouter";
import { PanelError } from "@/components/deal/PanelError";
import { useDeal } from "@/contexts/DealContext";
import { BuyerApprovalsPanel } from "@/components/deal/BuyerApprovalsPanel";
import { SuggestedBuyersPanel } from "@/components/deal/SuggestedBuyersPanel";
import { ExternalAcquirersPanel } from "@/components/deal/ExternalAcquirersPanel";
import { BuyerNdaTermsCard } from "@/components/deal/BuyerNdaTermsCard";
import { HaveCimStage, copyToClipboard, viewLinkFor } from "@/components/deal/buyers/HaveCimStage";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { UserPlus, Loader2, Copy, FileSignature, Lock, Globe, Send, Hourglass, FileCheck2 } from "lucide-react";
import {
  BUYER_STAGES, WAITING_APPROVAL_STATUSES, defaultBuyerStage, invalidateBuyerPipeline, isBuyerStage, revokedWithoutNewLink,
  type BuyerStage,
} from "@/lib/buyer-pipeline";

/** Read the server's JSON error body, falling back to a readable default. */
async function readError(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => null);
  return (body && typeof body.error === "string" && body.error) || fallback;
}

const STAGE_ICONS: Record<BuyerStage, typeof Globe> = {
  find: Globe,
  send: Send,
  approval: Hourglass,
  have: FileCheck2,
};

export function BuyersTab() {
  const { dealId, deal } = useDeal();
  // Buyers can only open a published CIM (the server enforces it too).
  const published = !!deal?.isLive;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [location, setLocation] = useLocation();
  const search = useSearch();

  const [grantOpen, setGrantOpen] = useState(false);
  const [grantForm, setGrantForm] = useState({ email: "", name: "", company: "" });
  const [grantResult, setGrantResult] = useState<{ url: string; email: string } | null>(null);
  const [ndaOpen, setNdaOpen] = useState(false);

  // ── The four lists (shared cache with the panels, so counts and lists agree) ──
  // Other people move buyers too (the seller approving through their link, a
  // buyer deciding in the view room), so the lists refresh when the broker
  // comes back to the window, on every stage change, and — for the two cheap
  // lists that change most — every 30s while the page is open.
  const LIVE = { refetchOnWindowFocus: true } as const;
  const { data: buyerAccessList, error: buyersError, refetch: refetchBuyers } = useQuery<any[]>({
    queryKey: ["/api/deals", dealId, "buyers"],
    queryFn: async () => {
      const r = await fetch(`/api/deals/${dealId}/buyers`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load buyers");
      return r.json();
    },
    ...LIVE,
    refetchInterval: 30_000,
  });
  const { data: suggested } = useQuery<{ suggested: Array<{ alreadyHasAccess: boolean; inApproval?: boolean; excluded?: boolean }> }>({
    queryKey: ["/api/deals", dealId, "suggested-buyers"],
    ...LIVE,
  });
  const { data: approvals } = useQuery<Array<{ status: string }>>({
    queryKey: [`/api/deals/${dealId}/buyer-approvals`],
    ...LIVE,
    refetchInterval: 30_000,
  });
  const { data: outside } = useQuery<{ status: string; results?: Array<{ inYourList?: boolean }> }>({
    queryKey: ["/api/deals", dealId, "external-acquirers"],
    ...LIVE,
  });

  const allAccess = buyerAccessList ?? [];
  const activeBuyers = allAccess.filter((b: any) => !b.revokedAt);
  // Revoked links stay findable (under "Have the CIM") unless the buyer has since been given a new one.
  const revokedBuyers = revokedWithoutNewLink(allAccess);
  // "Find" has no count until a search has run (0 would read as "found nobody").
  const searched = !!outside && outside.status !== "none";
  const counts: Record<BuyerStage, number | null | undefined> = {
    find: !outside ? null : searched ? (outside.results ?? []).filter((a) => !a.inYourList).length : undefined,
    send: suggested ? suggested.suggested.filter((b) => !b.alreadyHasAccess && !b.inApproval && !b.excluded).length : null,
    approval: approvals ? approvals.filter((r) => WAITING_APPROVAL_STATUSES.has(r.status)).length : null,
    have: buyerAccessList ? activeBuyers.length : null,
  };

  // ── Stage: from the URL, else a sensible default once buyers have loaded ──
  const urlStage = new URLSearchParams(search).get("stage");
  const stage: BuyerStage | null = isBuyerStage(urlStage)
    ? urlStage
    : buyerAccessList ? defaultBuyerStage(published, activeBuyers.length) : null;
  const goTo = (s: BuyerStage) => {
    if (s !== stage) setLocation(`${location}?stage=${s}`);
  };
  // Settle the default into the URL (replace, so Back doesn't bounce here).
  useEffect(() => {
    if (!isBuyerStage(urlStage) && stage) setLocation(`${location}?stage=${stage}`, { replace: true });
  }, [urlStage, stage, location, setLocation]);

  // Opening another stage shows it as it is now, not as it was when the page loaded.
  const lastStage = useRef<BuyerStage | null>(null);
  useEffect(() => {
    if (!stage) return;
    if (lastStage.current && lastStage.current !== stage) {
      invalidateBuyerPipeline(queryClient, dealId);
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "external-acquirers"] });
    }
    lastStage.current = stage;
  }, [stage, dealId, queryClient]);

  // ── Grant access directly (no email — the broker shares the link) ──
  const grant = useMutation({
    mutationFn: async (form: { email: string; name: string; company: string }) => {
      const res = await fetch(`/api/deals/${dealId}/buyers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          buyerEmail: form.email.trim(),
          buyerName: form.name.trim() || null,
          buyerCompany: form.company.trim() || null,
        }),
      });
      if (!res.ok) throw new Error(await readError(res, "Couldn't grant access"));
      return res.json();
    },
    onSuccess: (access) => {
      invalidateBuyerPipeline(queryClient, dealId);
      setGrantResult({ url: viewLinkFor(access.accessToken), email: access.buyerEmail });
      toast({ title: "Access granted", description: `Share the secure link with ${access.buyerEmail}.` });
    },
    onError: (err: Error) =>
      toast({ title: "Couldn't grant access", description: err.message, variant: "destructive" }),
  });

  const copyLink = async (url: string) => {
    const ok = await copyToClipboard(url);
    toast(ok
      ? { title: "Link copied", description: "Paste it into your own email to the buyer." }
      : { title: "Copy the link manually", description: url });
  };

  const openGrant = (prefill?: { buyerEmail?: string | null; buyerName?: string | null; buyerCompany?: string | null }) => {
    setGrantForm({ email: prefill?.buyerEmail ?? "", name: prefill?.buyerName ?? "", company: prefill?.buyerCompany ?? "" });
    setGrantResult(null);
    setGrantOpen(true);
  };
  const closeGrant = (open: boolean) => {
    setGrantOpen(open);
    // A new link means a buyer who has the CIM — show them there.
    if (!open && grantResult) goTo("have");
  };

  if (buyersError) {
    return (
      <div className="p-6">
        <PanelError what="buyers" onRetry={() => refetchBuyers()} />
      </div>
    );
  }

  const current = BUYER_STAGES.find((s) => s.key === stage);

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 space-y-5">
      {/* Header — what this tab is, plus the two actions that apply to every stage */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">Buyers</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Every buyer for this deal, from first finding them to having the CIM.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            size="sm"
            variant="outline"
            className="h-9 gap-1.5"
            onClick={() => setNdaOpen(true)}
            data-testid="button-nda-terms"
          >
            <FileSignature className="h-3.5 w-3.5" /> NDA terms
          </Button>
          <Button
            size="sm"
            className="h-9 gap-1.5 bg-teal text-teal-foreground hover:bg-teal/90"
            onClick={() => openGrant()}
            disabled={!published}
            title={published ? "Give a buyer a secure link to the CIM" : "Publish the CIM first — buyers can only open a published CIM"}
            data-testid="button-grant-access"
          >
            <UserPlus className="h-3.5 w-3.5" /> Grant access
          </Button>
        </div>
      </div>

      {!published && (
        <div className="flex items-start gap-2.5 rounded-lg border border-border bg-muted/30 px-3.5 py-2.5" data-testid="notice-not-published">
          <Lock className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
          <p className="text-xs text-muted-foreground leading-relaxed">
            <span className="font-medium text-foreground">The CIM isn&apos;t published yet.</span>{" "}
            You can line up buyers now. Nobody can open it until you publish it from the Overview tab — buyers the seller approves before then get it automatically when you do.
          </p>
        </div>
      )}

      {/* The pipeline — four stages, one visible at a time */}
      <nav aria-label="Buyer stages" className="grid grid-cols-2 gap-2 md:grid-cols-4" data-testid="buyer-stages">
        {BUYER_STAGES.map((s) => {
          const Icon = STAGE_ICONS[s.key];
          const active = s.key === stage;
          const count = counts[s.key];
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => goTo(s.key)}
              aria-current={active ? "step" : undefined}
              className={`relative flex min-h-[64px] items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                active
                  ? "border-teal/60 bg-teal/10"
                  : "border-border bg-card hover:border-foreground/20 hover:bg-muted/30"
              }`}
              data-testid={`stage-${s.key}`}
            >
              <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${active ? "text-teal" : "text-muted-foreground"}`} />
              <span className="min-w-0 flex-1">
                <span className={`block text-[11px] ${active ? "text-teal" : "text-muted-foreground"}`}>Step {s.step}</span>
                <span className={`block text-sm font-medium leading-tight ${active ? "text-foreground" : "text-foreground/85"}`}>{s.label}</span>
              </span>
              {count !== undefined && (
                <span
                  className={`ml-1 shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums ${
                    active ? "bg-teal text-teal-foreground" : "bg-muted text-muted-foreground"
                  }`}
                  data-testid={`stage-count-${s.key}`}
                >
                  {count === null ? "·" : count}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {current && (
        <p className="text-sm text-muted-foreground -mt-1" data-testid="stage-explain">{current.explain}</p>
      )}

      <section aria-live="polite">
        {!stage ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : stage === "find" ? (
          <ExternalAcquirersPanel dealId={dealId} embedded />
        ) : stage === "send" ? (
          <SuggestedBuyersPanel dealId={dealId} embedded />
        ) : stage === "approval" ? (
          <BuyerApprovalsPanel dealId={dealId} embedded onShowHaveCim={() => goTo("have")} />
        ) : (
          <HaveCimStage
            dealId={dealId}
            published={published}
            buyers={activeBuyers}
            revokedBuyers={revokedBuyers}
            onGrant={openGrant}
            onGoToSend={() => goTo("send")}
          />
        )}
      </section>

      {/* NDA terms — what buyers sign before the CIM opens */}
      <Dialog open={ndaOpen} onOpenChange={setNdaOpen}>
        <DialogContent className="max-w-2xl max-h-[88vh] overflow-y-auto p-0">
          <DialogHeader className="sr-only">
            <DialogTitle>NDA terms</DialogTitle>
            <DialogDescription>What buyers of this deal sign before the CIM opens.</DialogDescription>
          </DialogHeader>
          <BuyerNdaTermsCard scope="deal" dealId={dealId} bare />
        </DialogContent>
      </Dialog>

      {/* Grant access dialog */}
      <Dialog open={grantOpen} onOpenChange={closeGrant}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Grant CIM access</DialogTitle>
            <DialogDescription>
              Creates a secure view link for this buyer. Nothing is emailed —
              you share the link yourself. The link expires in 30 days unless
              you extend it.
            </DialogDescription>
          </DialogHeader>
          {grantResult ? (
            <div className="space-y-3 py-1">
              <p className="text-sm text-muted-foreground">
                Link for <span className="text-foreground">{grantResult.email}</span>
              </p>
              <div className="flex items-center gap-2">
                <Input readOnly value={grantResult.url} className="h-9 text-xs font-mono" />
                <Button
                  size="sm"
                  variant="outline"
                  className="h-9 gap-1.5 shrink-0"
                  onClick={() => copyLink(grantResult.url)}
                  data-testid="button-copy-granted-link"
                >
                  <Copy className="h-3.5 w-3.5" /> Copy
                </Button>
              </div>
              <div className="flex justify-end">
                <Button size="sm" onClick={() => closeGrant(false)}>
                  Done
                </Button>
              </div>
            </div>
          ) : (
            <form
              className="space-y-3 py-1"
              onSubmit={(e) => {
                e.preventDefault();
                if (!grantForm.email.trim() || grant.isPending) return;
                grant.mutate(grantForm);
              }}
            >
              <div className="space-y-1.5">
                <Label htmlFor="grant-email" className="text-xs">Buyer email</Label>
                <Input
                  id="grant-email"
                  type="email"
                  required
                  placeholder="buyer@example.com"
                  value={grantForm.email}
                  onChange={(e) => setGrantForm((f) => ({ ...f, email: e.target.value }))}
                  className="h-9"
                  data-testid="input-grant-email"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="grant-name" className="text-xs">Name</Label>
                  <Input
                    id="grant-name"
                    placeholder="Optional"
                    value={grantForm.name}
                    onChange={(e) => setGrantForm((f) => ({ ...f, name: e.target.value }))}
                    className="h-9"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="grant-company" className="text-xs">Company</Label>
                  <Input
                    id="grant-company"
                    placeholder="Optional"
                    value={grantForm.company}
                    onChange={(e) => setGrantForm((f) => ({ ...f, company: e.target.value }))}
                    className="h-9"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <Button type="button" variant="outline" size="sm" onClick={() => closeGrant(false)}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  className="bg-teal text-teal-foreground hover:bg-teal/90 gap-1.5"
                  disabled={!grantForm.email.trim() || grant.isPending}
                  data-testid="button-grant-access-confirm"
                >
                  {grant.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserPlus className="h-3.5 w-3.5" />}
                  {grant.isPending ? "Creating link…" : "Create link"}
                </Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
