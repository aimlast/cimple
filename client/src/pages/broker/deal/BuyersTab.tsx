/**
 * BuyersTab — Active buyers, pending approvals, outreach & matching.
 *
 * Active Buyers is actionable, not read-only: the broker can grant CIM access
 * directly (no email is sent — they share the link themselves), copy a
 * buyer's /view link, extend the link's expiry, or revoke access.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PanelError } from "@/components/deal/PanelError";
import { useDeal } from "@/contexts/DealContext";
import { BuyerApprovalsPanel } from "@/components/deal/BuyerApprovalsPanel";
import { BuyerMatchingPanel } from "@/components/deal/BuyerMatchingPanel";
import { SuggestedBuyersPanel } from "@/components/deal/SuggestedBuyersPanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import {
  Eye,
  Clock,
  ThumbsUp,
  ThumbsDown,
  Timer,
  MoreHorizontal,
  Link2,
  CalendarPlus,
  Ban,
  UserPlus,
  Loader2,
  Copy,
} from "lucide-react";

/** Read the server's JSON error body, falling back to a readable default. */
async function readError(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => null);
  return (body && typeof body.error === "string" && body.error) || fallback;
}

/**
 * Clipboard writes reject when the document isn't focused or the context
 * isn't secure. Returns whether the copy succeeded so the caller can show
 * the link itself instead of a false "copied" toast.
 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function viewLinkFor(accessToken: string): string {
  return `${window.location.origin}/view/${accessToken}`;
}

function shortDate(value: string | Date | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const EXTEND_DAYS = 30;

export function BuyersTab() {
  const { dealId } = useDeal();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [grantOpen, setGrantOpen] = useState(false);
  const [grantForm, setGrantForm] = useState({ email: "", name: "", company: "" });
  const [grantResult, setGrantResult] = useState<{ url: string; email: string } | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<any | null>(null);

  const buyersKey = ["/api/deals", dealId, "buyers"];

  const { data: buyerAccessList = [], error: buyersError, refetch: refetchBuyers } = useQuery<any[]>({
    queryKey: buyersKey,
    queryFn: async () => {
      const r = await fetch(`/api/deals/${dealId}/buyers`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load buyers");
      return r.json();
    },
  });

  const { data: buyerScores = [] } = useQuery<any[]>({
    queryKey: ["/api/deals", dealId, "analytics/buyer-scores"],
    queryFn: async () => {
      const r = await fetch(
        `/api/deals/${dealId}/analytics/buyer-scores`,
        { credentials: "include" },
      );
      // Scores enrich the table but aren't essential — degrade quietly
      return r.ok ? r.json() : [];
    },
  });

  const invalidateBuyers = () => {
    queryClient.invalidateQueries({ queryKey: buyersKey });
    queryClient.invalidateQueries({ queryKey: ["/api/broker/buyers"] });
  };

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
      invalidateBuyers();
      setGrantResult({ url: viewLinkFor(access.accessToken), email: access.buyerEmail });
      toast({ title: "Access granted", description: `Share the secure link with ${access.buyerEmail}.` });
    },
    onError: (err: Error) =>
      toast({ title: "Couldn't grant access", description: err.message, variant: "destructive" }),
  });

  // ── Extend expiry by 30 days from the later of now / current expiry ──
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
      invalidateBuyers();
      toast({ title: "Access extended", description: `Link now expires ${shortDate(access.expiresAt)}.` });
    },
    onError: (err: Error) =>
      toast({ title: "Couldn't extend access", description: err.message, variant: "destructive" }),
  });

  // ── Revoke (server soft-revokes — the row stays for the audit trail) ──
  const revoke = useMutation({
    mutationFn: async (buyer: any) => {
      const res = await fetch(`/api/buyer-access/${buyer.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error(await readError(res, "Couldn't revoke access"));
      return res.json();
    },
    onSuccess: (_data, buyer) => {
      invalidateBuyers();
      setRevokeTarget(null);
      toast({ title: "Access revoked", description: `${buyer.buyerName || buyer.buyerEmail} can no longer open the CIM.` });
    },
    onError: (err: Error) =>
      toast({ title: "Couldn't revoke access", description: err.message, variant: "destructive" }),
  });

  const copyLink = async (url: string) => {
    const ok = await copyToClipboard(url);
    toast(
      ok
        ? { title: "Link copied", description: "Paste it into your own email to the buyer." }
        : { title: "Copy the link manually", description: url },
    );
  };

  const activeBuyers = buyerAccessList.filter((b: any) => !b.revokedAt);
  const scoreMap = new Map(buyerScores.map((s: any) => [s.buyerId, s]));

  const openGrant = () => {
    setGrantForm({ email: "", name: "", company: "" });
    setGrantResult(null);
    setGrantOpen(true);
  };

  if (buyersError) {
    return (
      <div className="p-6">
        <PanelError what="buyers" onRetry={() => refetchBuyers()} />
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-6 py-6 space-y-8">
      {/* Active Buyers — status + engagement */}
      <section>
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Active Buyers</h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              Buyers with CIM access — their decision status and engagement.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-xs gap-1.5 border-teal/30 text-teal hover:bg-teal/10 shrink-0"
            onClick={openGrant}
            data-testid="button-grant-access"
          >
            <UserPlus className="h-3.5 w-3.5" />
            Grant access
          </Button>
        </div>
        {activeBuyers.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-6 text-center">
            <Eye className="h-5 w-5 mx-auto text-muted-foreground/40 mb-2" />
            <p className="text-sm text-muted-foreground">
              No buyers have access yet.
            </p>
            <p className="text-xs text-muted-foreground/60 mt-1">
              Approve a buyer below, or grant access directly and share the link yourself.
            </p>
          </div>
        ) : (
          <div className="rounded-lg border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30">
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">
                    Buyer
                  </th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">
                    Status
                  </th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">
                    Engagement
                  </th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">
                    NDA
                  </th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">
                    Activity
                  </th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">
                    Link
                  </th>
                  <th className="px-2 py-2.5">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {activeBuyers.map((buyer: any) => {
                  const decision = buyer.decision || "under_review";
                  const statusConfig: Record<
                    string,
                    {
                      label: string;
                      icon: any;
                      className: string;
                    }
                  > = {
                    under_review: {
                      label: "Under Review",
                      icon: Clock,
                      className: "text-amber-600 bg-amber-500/10",
                    },
                    interested: {
                      label: "Interested",
                      icon: ThumbsUp,
                      className: "text-success-muted-foreground bg-success-muted",
                    },
                    not_interested: {
                      label: "Not Interested",
                      icon: ThumbsDown,
                      className: "text-red-500 bg-destructive/10",
                    },
                    lapsed: {
                      label: "Lapsed",
                      icon: Timer,
                      className: "text-muted-foreground bg-muted",
                    },
                  };
                  const status =
                    statusConfig[decision] || statusConfig.under_review;
                  const StatusIcon = status.icon;

                  const score = scoreMap.get(buyer.id);
                  const engagementScore = score?.engagementScore ?? 0;
                  const intent = score?.intent ?? "minimal";
                  const intentConfig: Record<
                    string,
                    { label: string; className: string }
                  > = {
                    high: {
                      label: "High",
                      className: "text-success-muted-foreground",
                    },
                    medium: {
                      label: "Medium",
                      className: "text-amber-600",
                    },
                    low: {
                      label: "Low",
                      className: "text-muted-foreground",
                    },
                    minimal: {
                      label: "Minimal",
                      className: "text-muted-foreground/50",
                    },
                  };
                  const intentCfg =
                    intentConfig[intent] || intentConfig.minimal;

                  const views =
                    score?.viewCount ?? buyer.viewCount ?? 0;
                  const totalMin = Math.round(
                    (score?.totalTimeSeconds ??
                      buyer.totalTimeSeconds ??
                      0) / 60,
                  );
                  const timeLabel =
                    totalMin < 1 ? "<1m" : `${totalMin}m`;
                  const lastActive = buyer.lastAccessedAt
                    ? shortDate(buyer.lastAccessedAt)
                    : "—";

                  const expiresAt = buyer.expiresAt ? new Date(buyer.expiresAt) : null;
                  const expired = !!expiresAt && expiresAt.getTime() < Date.now();
                  const viewUrl = buyer.accessToken ? viewLinkFor(buyer.accessToken) : null;

                  return (
                    <tr
                      key={buyer.id}
                      className="border-b border-border last:border-0 hover:bg-muted/20 transition-colors"
                    >
                      <td className="px-4 py-3">
                        <div>
                          <p className="font-medium text-foreground">
                            {buyer.buyerName || buyer.buyerEmail}
                          </p>
                          {buyer.buyerCompany && (
                            <p className="text-xs text-muted-foreground mt-0.5">
                              {buyer.buyerCompany}
                            </p>
                          )}
                          {buyer.buyerName && (
                            <p className="text-xs text-muted-foreground/60">
                              {buyer.buyerEmail}
                            </p>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${status.className}`}
                        >
                          <StatusIcon className="h-3 w-3" />
                          {status.label}
                        </span>
                        {decision === "interested" &&
                          buyer.decisionNextStep && (
                            <p className="text-xs text-muted-foreground mt-1">
                              Next:{" "}
                              {buyer.decisionNextStep.replace(
                                /_/g,
                                " ",
                              )}
                            </p>
                          )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className="w-16 h-1.5 rounded-full bg-muted overflow-hidden">
                            <div
                              className="h-full rounded-full bg-teal transition-all"
                              style={{
                                width: `${Math.min(engagementScore, 100)}%`,
                              }}
                            />
                          </div>
                          <span className="text-xs tabular-nums text-muted-foreground">
                            {engagementScore}
                          </span>
                        </div>
                        <p
                          className={`text-xs mt-0.5 ${intentCfg.className}`}
                        >
                          {intentCfg.label} intent
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        {buyer.ndaSigned ? (
                          <span className="text-xs text-success-muted-foreground font-medium">
                            Signed
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            Pending
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <p className="text-xs text-muted-foreground">
                          {views} views · {timeLabel}
                        </p>
                        <p className="text-xs text-muted-foreground/60">
                          {lastActive}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        {expiresAt ? (
                          <p className={`text-xs ${expired ? "text-red-500" : "text-muted-foreground"}`}>
                            {expired ? "Expired" : "Expires"} {shortDate(expiresAt)}
                          </p>
                        ) : (
                          <p className="text-xs text-muted-foreground/60">No expiry</p>
                        )}
                      </td>
                      <td className="px-2 py-3 text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-muted-foreground"
                              aria-label={`Actions for ${buyer.buyerName || buyer.buyerEmail}`}
                              data-testid={`button-buyer-actions-${buyer.id}`}
                            >
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-48">
                            <DropdownMenuItem
                              disabled={!viewUrl}
                              onClick={() => viewUrl && copyLink(viewUrl)}
                            >
                              <Link2 className="h-3.5 w-3.5 mr-2" /> Copy view link
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={extend.isPending}
                              onClick={() => extend.mutate(buyer)}
                            >
                              <CalendarPlus className="h-3.5 w-3.5 mr-2" /> Extend {EXTEND_DAYS} days
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              className="text-red-500 focus:text-red-500"
                              onClick={() => setRevokeTarget(buyer)}
                            >
                              <Ban className="h-3.5 w-3.5 mr-2" /> Revoke access
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Pending Approvals */}
      <section className="pt-4 border-t border-border">
        <div className="mb-3">
          <h2 className="text-base font-semibold">Pending Approvals</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Buyers awaiting broker and seller sign-off before CIM access.
          </p>
        </div>
        <BuyerApprovalsPanel dealId={dealId} />
      </section>

      {/* Outreach & Matching */}
      <section className="pt-4 border-t border-border">
        <div className="mb-3">
          <h2 className="text-base font-semibold">Outreach & Matching</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Find buyers by criteria match, then draft and send outreach
            emails.
          </p>
        </div>
        <div className="space-y-6">
          <SuggestedBuyersPanel dealId={dealId} />
          <BuyerMatchingPanel dealId={dealId} />
        </div>
      </section>

      {/* Grant access dialog */}
      <Dialog open={grantOpen} onOpenChange={setGrantOpen}>
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
                <Button size="sm" onClick={() => setGrantOpen(false)}>
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
                <Button type="button" variant="outline" size="sm" onClick={() => setGrantOpen(false)}>
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

      {/* Revoke confirmation */}
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
