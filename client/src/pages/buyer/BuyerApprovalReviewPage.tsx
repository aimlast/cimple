/**
 * BuyerApprovalReviewPage — Standalone page for seller to review and
 * approve/reject a prospective buyer who's been cleared by the lead broker.
 *
 * No login required — the sellerReviewToken IS the auth. One page, rich
 * profile view, two actions: Approve (→ buyer gets CIM access + invite email
 * CC'ing both brokers) or Decline (→ request closed, brokers notified).
 */
import { useState } from "react";
import { fundsToRange } from "@/lib/funds";
import { useParams } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { readErrorBody } from "./shared";
import {
  CheckCircle2, XCircle, Loader2, AlertCircle, Shield, Building2,
  User, Mail, Phone, Linkedin, ExternalLink, DollarSign, Users,
} from "lucide-react";

interface BuyerPartner {
  name: string;
  role?: string | null;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  linkedinUrl?: string | null;
  background?: string | null;
}

interface FinancialCapability {
  liquidFunds?: string | null;
  annualIncome?: string | null;
  investmentSizeTarget?: string | null;
  hasProofOfFunds?: boolean | null;
  sourceOfFunds?: string | null;
  prequalifiedForFinancing?: boolean | null;
  notes?: string | null;
}

interface ApprovalRequest {
  id: string;
  buyerName: string;
  buyerTitle?: string | null;
  buyerEmail: string;
  buyerPhone?: string | null;
  buyerCompany?: string | null;
  buyerCompanyUrl?: string | null;
  linkedinUrl?: string | null;
  otherProfileUrls?: string[];
  category: string;
  riskLevel: "high" | "medium" | "low";
  background?: string | null;
  financialCapability?: FinancialCapability | null;
  partners?: BuyerPartner[];
  isCompetitor?: boolean;
  competitorDetails?: string | null;
  ndaSigned?: boolean;
  ndaNotes?: string | null;
  /** pending_seller_review | approved_by_seller | access_granted | rejected | ... */
  status: string;
  submittedByName?: string | null;
  sellerReviewedBy?: string | null;
  sellerReviewedAt?: string | null;
}

interface ReviewData {
  request: ApprovalRequest;
  deal: { id: string; businessName: string } | null;
  branding: any;
  /** Optional server hint; we also derive it from request.status */
  alreadyReviewed?: boolean;
}

const RISK_COLORS: Record<string, string> = {
  high: "bg-red-500/10 text-red-400 border-red-500/30",
  medium: "bg-amber-500/10 text-amber-400 border-amber-500/30",
  low: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
};

type Decision = "approve" | "reject";

export default function BuyerApprovalReviewPage() {
  const { token } = useParams<{ token: string }>();
  const { toast } = useToast();
  const [reviewerName, setReviewerName] = useState("");
  const [notes, setNotes] = useState("");
  const [done, setDone] = useState<Decision | null>(null);
  const [showRejectUi, setShowRejectUi] = useState(false);

  const { data, isLoading, error } = useQuery<ReviewData>({
    queryKey: ["/api/buyer-approval-review", token],
    enabled: !!token,
    queryFn: async () => {
      const res = await fetch(`/api/buyer-approval-review/${token}`);
      if (!res.ok) {
        const body = await readErrorBody(res);
        throw new Error(body.error || "Invalid link");
      }
      return res.json();
    },
  });

  const submit = useMutation({
    mutationFn: async ({ action }: { action: Decision }) => {
      const res = await fetch(`/api/buyer-approval-review/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, reviewerName, notes }),
      });
      if (!res.ok) {
        const body = await readErrorBody(res);
        throw new Error(
          body.error
            || (action === "approve"
              ? "Could not approve this buyer. Please try again."
              : "Could not record your decision. Please try again."),
        );
      }
      return res.json();
    },
    onSuccess: (_d, vars) => setDone(vars.action),
    onError: (e: Error, vars) => {
      toast({
        title: vars.action === "approve" ? "Approval failed" : "Decline failed",
        description: e.message,
        variant: "destructive",
      });
    },
  });

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-6">
        <Card className="max-w-md w-full">
          <CardContent className="p-8 text-center space-y-3" data-testid="approval-review-error">
            <AlertCircle className="h-10 w-10 text-destructive mx-auto" />
            <h2 className="text-xl font-semibold">Link unavailable</h2>
            <p className="text-sm text-muted-foreground">
              {(error as any)?.message || "This approval link is no longer valid."}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // A link that has already been decided (seller re-opens the approval
  // email) renders the decided state instead of a live form whose submit
  // the server would reject.
  const alreadyDecided: Decision | null = (() => {
    const status = data.request.status;
    if (status === "pending_seller_review" && !data.alreadyReviewed) return null;
    if (status === "rejected" || status === "declined") return "reject";
    return "approve";
  })();
  const outcome: Decision | null = done ?? alreadyDecided;

  if (outcome) {
    const justNow = done !== null;
    const reviewedAt = data.request.sellerReviewedAt
      ? new Date(data.request.sellerReviewedAt).toLocaleDateString()
      : null;
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-6">
        <Card className="max-w-md w-full">
          <CardContent className="p-8 text-center space-y-3" data-testid="approval-review-done">
            {outcome === "approve" ? (
              <>
                <CheckCircle2 className="h-12 w-12 text-emerald-500 mx-auto" />
                <h2 className="text-2xl font-semibold">
                  {justNow ? "Buyer approved" : "Already approved"}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {justNow
                    ? `${data.request.buyerName} has been granted access to the CIM. An invite email has been sent and both brokers have been notified.`
                    : `You already approved ${data.request.buyerName}${reviewedAt ? ` on ${reviewedAt}` : ""}. They have been granted access to the CIM and no further action is needed.`}
                </p>
              </>
            ) : (
              <>
                <XCircle className="h-12 w-12 text-muted-foreground mx-auto" />
                <h2 className="text-2xl font-semibold">
                  {justNow ? "Buyer declined" : "Already declined"}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {justNow
                    ? "Your brokers have been notified. This buyer will not receive access."
                    : `You already declined ${data.request.buyerName}${reviewedAt ? ` on ${reviewedAt}` : ""}. This buyer will not receive access.`}
                </p>
              </>
            )}
            {!justNow && (
              <p className="text-xs text-muted-foreground/70">
                Changed your mind? Contact your broker — decisions can't be reversed from this link.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  const r = data.request;
  const fc = r.financialCapability;
  const partners = r.partners || [];
  const submitError = submit.error ? (submit.error as Error).message : null;

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-3xl mx-auto px-4 py-10 space-y-6">
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
            Buyer approval requested
          </div>
          <h1 className="text-3xl font-semibold">
            {data.deal?.businessName || "Your business"}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Your lead broker has cleared this buyer. Please review the profile below and confirm
            whether to grant them access to your confidential business overview.
          </p>
        </div>

        <Card>
          <CardContent className="p-6 space-y-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-lg font-semibold flex items-center gap-2">
                  <User className="h-4 w-4 text-muted-foreground" />
                  {r.buyerName}
                </div>
                {r.buyerTitle && (
                  <div className="text-sm text-muted-foreground">{r.buyerTitle}</div>
                )}
                {r.buyerCompany && (
                  <div className="text-sm flex items-center gap-1 mt-1">
                    <Building2 className="h-3 w-3 text-muted-foreground" />
                    {r.buyerCompany}
                    {r.buyerCompanyUrl && (
                      <a href={r.buyerCompanyUrl} target="_blank" rel="noreferrer"
                         className="text-primary hover:underline inline-flex items-center">
                        <ExternalLink className="h-3 w-3 ml-1" />
                      </a>
                    )}
                  </div>
                )}
              </div>
              <div className="flex flex-col items-end gap-1">
                <Badge variant="outline" className="capitalize">
                  {(r.category || "buyer").replace(/_/g, " ")}
                </Badge>
                <Badge className={RISK_COLORS[r.riskLevel] || ""}>
                  {r.riskLevel} risk
                </Badge>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
              <div className="flex items-center gap-2">
                <Mail className="h-3 w-3 text-muted-foreground" />
                <a href={`mailto:${r.buyerEmail}`} className="text-primary hover:underline">{r.buyerEmail}</a>
              </div>
              {r.buyerPhone && (
                <div className="flex items-center gap-2">
                  <Phone className="h-3 w-3 text-muted-foreground" />
                  {r.buyerPhone}
                </div>
              )}
              {r.linkedinUrl && (
                <div className="flex items-center gap-2">
                  <Linkedin className="h-3 w-3 text-muted-foreground" />
                  <a href={r.linkedinUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline truncate">
                    LinkedIn profile
                  </a>
                </div>
              )}
              {r.ndaSigned && (
                <div className="flex items-center gap-2 text-emerald-500">
                  <Shield className="h-3 w-3" />
                  NDA signed
                </div>
              )}
            </div>

            {r.background && (
              <div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Background</div>
                <p className="text-sm whitespace-pre-wrap">{r.background}</p>
              </div>
            )}

            {fc && (fc.liquidFunds || fc.sourceOfFunds || fc.investmentSizeTarget || fc.hasProofOfFunds) && (
              <div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-1">
                  <DollarSign className="h-3 w-3" />
                  Financial capability
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
                  {fc.liquidFunds && <div><span className="text-muted-foreground">Liquid funds:</span> {fundsToRange(fc.liquidFunds)}</div>}
                  {fc.investmentSizeTarget && <div><span className="text-muted-foreground">Target size:</span> {fc.investmentSizeTarget}</div>}
                  {fc.sourceOfFunds && <div><span className="text-muted-foreground">Source:</span> {fc.sourceOfFunds}</div>}
                  {fc.hasProofOfFunds && <div className="text-emerald-500">Proof of funds on file</div>}
                  {fc.prequalifiedForFinancing && <div className="text-emerald-500">Pre-qualified for financing</div>}
                </div>
                {fc.notes && <p className="text-xs text-muted-foreground mt-2">{fc.notes}</p>}
              </div>
            )}

            {partners.length > 0 && (
              <div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-1">
                  <Users className="h-3 w-3" />
                  Business partners ({partners.length})
                </div>
                <div className="space-y-2">
                  {partners.map((p, i) => (
                    <div key={i} className="text-sm border border-border rounded-md p-2">
                      <div className="font-medium">{p.name}{p.role ? ` — ${p.role}` : ""}</div>
                      {p.company && <div className="text-xs text-muted-foreground">{p.company}</div>}
                      {p.background && <div className="text-xs mt-1">{p.background}</div>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {r.isCompetitor && (
              <div className="border border-amber-500/30 bg-amber-500/10 rounded-md p-3">
                <div className="text-sm font-medium text-amber-400 flex items-center gap-1">
                  <AlertCircle className="h-3 w-3" />
                  Competitor flag
                </div>
                {r.competitorDetails && <p className="text-xs text-muted-foreground mt-1">{r.competitorDetails}</p>}
              </div>
            )}

            {r.submittedByName && (
              <div className="text-xs text-muted-foreground pt-2 border-t border-border">
                Submitted by {r.submittedByName}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6 space-y-4">
            <div className="text-sm font-medium">Your decision</div>
            <Input
              placeholder="Your name (optional)"
              value={reviewerName}
              onChange={(e) => setReviewerName(e.target.value)}
              data-testid="input-reviewer-name"
            />
            {showRejectUi && (
              <Textarea
                placeholder="Reason for declining (optional — helps your broker follow up)"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                data-testid="input-decline-notes"
              />
            )}
            <div className="flex gap-3">
              {!showRejectUi ? (
                <>
                  <Button
                    onClick={() => submit.mutate({ action: "approve" })}
                    disabled={submit.isPending}
                    className="flex-1"
                    data-testid="button-approve-buyer"
                  >
                    {submit.isPending && submit.variables?.action === "approve" ? (
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    ) : (
                      <CheckCircle2 className="h-4 w-4 mr-2" />
                    )}
                    Approve & grant access
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => setShowRejectUi(true)}
                    disabled={submit.isPending}
                    data-testid="button-decline-buyer"
                  >
                    Decline
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    variant="destructive"
                    onClick={() => submit.mutate({ action: "reject" })}
                    disabled={submit.isPending}
                    className="flex-1"
                    data-testid="button-confirm-decline"
                  >
                    {submit.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    ) : (
                      <XCircle className="h-4 w-4 mr-2" />
                    )}
                    Confirm decline
                  </Button>
                  <Button variant="outline" onClick={() => setShowRejectUi(false)} disabled={submit.isPending}>
                    Cancel
                  </Button>
                </>
              )}
            </div>
            {submitError && (
              <div
                className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
                role="alert"
                data-testid="text-submit-error"
              >
                <AlertCircle className="h-3.5 w-3.5 mt-px shrink-0" />
                <span>{submitError}</span>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Approving will send the buyer a secure CIM link (they'll sign an NDA before accessing).
              Both brokers will be CC'd on the invite.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
