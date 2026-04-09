/**
 * BuyerDecisionPanel
 *
 * Shown on the Buyer View Room (at the bottom of the CIM). The buyer's
 * status automatically starts as "Under Review" when they are granted
 * access. From there, they can explicitly move to:
 *
 *   - Interested in moving forward (+ pick a next step + optional comment)
 *   - Not interested (+ optional reason)
 *
 * On submission, the broker is notified by email/SMS and the deal is
 * automatically moved to the correct stage in the broker's connected
 * CRM (Pipedrive / HubSpot / Salesforce).
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { CheckCircle2, XCircle, Clock, Loader2, ThumbsUp, ThumbsDown } from "lucide-react";

const NEXT_STEPS = [
  { value: "seller_call", label: "Introductory call with the seller" },
  { value: "management_meeting", label: "Management meeting" },
  { value: "site_visit", label: "On-site visit / tour" },
  { value: "loi", label: "Submit a Letter of Intent (LOI)" },
  { value: "more_info", label: "Request additional information" },
  { value: "other", label: "Other — I'll describe below" },
] as const;

type Decision = "under_review" | "interested" | "not_interested" | "lapsed";
type Mode = "interested" | "not_interested" | null;

interface Props {
  token: string;
  currentDecision: Decision;
  businessName: string;
  viewCount: number;
  firstViewedAt: string | null;
  onUpdated: (decision: Decision) => void;
}

// The buyer needs room to breathe on their very first session — no prompt
// shown immediately. The panel appears on the second visit or after the
// buyer has spent meaningful time with the CIM on the first session.
const BREATHING_MS = 2 * 60 * 60 * 1000; // 2 hours

function shouldShowActivePanel(viewCount: number, firstViewedAt: string | null): boolean {
  if (viewCount >= 2) return true;
  if (!firstViewedAt) return false;
  const elapsed = Date.now() - new Date(firstViewedAt).getTime();
  return elapsed >= BREATHING_MS;
}

export function BuyerDecisionPanel({ token, currentDecision, businessName, viewCount, firstViewedAt, onUpdated }: Props) {
  const [mode, setMode] = useState<Mode>(null);
  const [nextStep, setNextStep] = useState<string>("seller_call");
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const status = currentDecision || "under_review";
  const isFinal = status === "interested" || status === "not_interested" || status === "lapsed";
  const showActive = status === "under_review" && shouldShowActivePanel(viewCount, firstViewedAt);

  async function submit() {
    if (!mode) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/view/${token}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision: mode,
          nextStep: mode === "interested" ? nextStep : null,
          reason: comment.trim() || null,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to submit decision");
      }
      onUpdated(mode);
      setMode(null);
      setComment("");
    } catch (err: any) {
      setError(err.message || "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  // ── Final state display ──────────────────────────────────────────────
  if (isFinal) {
    const iconBg = status === "interested" ? "bg-emerald-500/10" : status === "lapsed" ? "bg-muted/40" : "bg-rose-500/10";
    const iconColor = status === "interested" ? "text-emerald-500" : status === "lapsed" ? "text-muted-foreground" : "text-rose-500";
    const Icon = status === "interested" ? CheckCircle2 : status === "lapsed" ? Clock : XCircle;
    const title = status === "interested"
      ? "Thank you — the broker has been notified"
      : status === "lapsed"
      ? "This opportunity has lapsed"
      : "Thank you for letting us know";
    const body = status === "interested"
      ? `You have indicated that you are interested in moving forward with ${businessName}. The broker has been notified and will reach out shortly to coordinate next steps.`
      : status === "lapsed"
      ? `Because no decision was recorded within the review window, this opportunity has been marked as lapsed. If you'd still like to explore ${businessName}, please reach out to the broker directly.`
      : `You have indicated that ${businessName} is not a fit at this time. We appreciate your time and consideration.`;

    return (
      <div className="max-w-3xl mx-auto my-12 p-8 rounded-xl border border-border bg-card">
        <div className="flex items-start gap-4">
          <div className={`h-12 w-12 rounded-full ${iconBg} flex items-center justify-center shrink-0`}>
            <Icon className={`h-6 w-6 ${iconColor}`} />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-foreground">{title}</h3>
            <p className="text-sm text-muted-foreground mt-1 leading-relaxed">{body}</p>
          </div>
        </div>
      </div>
    );
  }

  // ── Breathing room on first visit — no prompt shown ───────────────────
  if (!showActive) {
    return null;
  }

  // ── Default "under review" state ──────────────────────────────────────
  return (
    <>
      <div className="max-w-3xl mx-auto my-12 p-8 rounded-xl border border-border bg-card">
        <div className="flex flex-col sm:flex-row sm:items-start gap-5">
          <div className="h-12 w-12 rounded-full bg-amber-500/10 flex items-center justify-center shrink-0">
            <Clock className="h-6 w-6 text-amber-500" />
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1">
              <h3 className="text-lg font-semibold text-foreground">Your decision</h3>
              <Badge variant="outline" className="border-amber-500/30 text-amber-500 bg-amber-500/5">
                Under Review
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground leading-relaxed mb-5">
              Take your time reviewing the opportunity. When you're ready, let the broker know
              whether you'd like to move forward — they'll be notified automatically and will
              coordinate the next step with you.
            </p>
            <div className="flex flex-col sm:flex-row gap-3">
              <Button
                size="lg"
                className="bg-emerald-600 hover:bg-emerald-700 text-white"
                onClick={() => setMode("interested")}
                data-testid="button-interested"
              >
                <ThumbsUp className="h-4 w-4 mr-2" />
                Interested in moving forward
              </Button>
              <Button
                size="lg"
                variant="outline"
                onClick={() => setMode("not_interested")}
                data-testid="button-not-interested"
              >
                <ThumbsDown className="h-4 w-4 mr-2" />
                Not interested
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* ── Decision dialog ─────────────────────────────────────────────── */}
      <Dialog open={mode !== null} onOpenChange={(open) => !open && setMode(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {mode === "interested" ? "Move forward with this opportunity" : "Decline this opportunity"}
            </DialogTitle>
            <DialogDescription>
              {mode === "interested"
                ? "Let the broker know which next step you'd prefer. They'll reach out to coordinate."
                : "Your decision will be shared with the broker. A brief reason is appreciated but optional."}
            </DialogDescription>
          </DialogHeader>

          {mode === "interested" && (
            <div className="space-y-4 py-2">
              <div>
                <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2 block">
                  Preferred next step
                </Label>
                <RadioGroup value={nextStep} onValueChange={setNextStep} className="space-y-2">
                  {NEXT_STEPS.map((step) => (
                    <div key={step.value} className="flex items-center gap-3 p-3 rounded-md border border-border hover:bg-accent/30 cursor-pointer" onClick={() => setNextStep(step.value)}>
                      <RadioGroupItem value={step.value} id={`step-${step.value}`} />
                      <Label htmlFor={`step-${step.value}`} className="cursor-pointer flex-1 text-sm font-normal">
                        {step.label}
                      </Label>
                    </div>
                  ))}
                </RadioGroup>
              </div>
              <div>
                <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2 block">
                  Notes (optional)
                </Label>
                <Textarea
                  placeholder="Share any context, questions, or scheduling constraints..."
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  rows={3}
                  className="resize-none"
                />
              </div>
            </div>
          )}

          {mode === "not_interested" && (
            <div className="space-y-3 py-2">
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide block">
                Reason (optional)
              </Label>
              <Textarea
                placeholder="e.g. Outside of target industry, financials don't fit criteria, timing not right..."
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                rows={4}
                className="resize-none"
              />
              <p className="text-xs text-muted-foreground">
                Your feedback helps the broker refine future opportunities for you.
              </p>
            </div>
          )}

          {error && (
            <div className="text-xs text-rose-500 bg-rose-500/10 border border-rose-500/20 rounded-md p-2">
              {error}
            </div>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setMode(null)} disabled={submitting}>
              Cancel
            </Button>
            <Button
              onClick={submit}
              disabled={submitting}
              className={mode === "interested" ? "bg-emerald-600 hover:bg-emerald-700 text-white" : ""}
              variant={mode === "not_interested" ? "destructive" : "default"}
              data-testid="button-submit-decision"
            >
              {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {mode === "interested" ? "Confirm — I'm interested" : "Confirm — not interested"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
