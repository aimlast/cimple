/**
 * SellerInterview — Fullscreen conversation page for seller mode.
 *
 * On first visit, shows the SellerOnboarding flow (5 animated screens
 * explaining CIMs). After onboarding completes, shows the Interview
 * component. Subsequent visits skip straight to the conversation.
 *
 * Route: /seller/:token/interview (rendered in FullscreenLayout)
 */
import { useState } from "react";
import { useParams, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Interview } from "@/components/shared/Interview";
import { SellerOnboarding } from "@/components/seller/SellerOnboarding";
import { Loader2, CheckCircle2, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function SellerInterview() {
  const { token } = useParams<{ token: string }>();
  const [, setLocation] = useLocation();
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);
  // A seller who already finished the interview lands on a completion card
  // instead of silently starting a fresh session (observed: the fullscreen
  // route skipped the card and opened a new conversation).
  const [continueRequested, setContinueRequested] = useState(false);

  const { data: inviteData, isLoading, error } = useQuery<{
    invite: any;
    deal: any;
  }>({
    queryKey: ["/api/invites", token],
    enabled: !!token,
  });

  if (isLoading) {
    return (
      <div className="h-screen flex items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="text-sm">Loading...</span>
        </div>
      </div>
    );
  }

  if (error || !inviteData?.deal) {
    return (
      <div className="h-screen flex items-center justify-center p-4">
        <div className="max-w-sm w-full text-center space-y-3">
          <h2 className="text-lg font-semibold">Invalid invite link</h2>
          <p className="text-sm text-muted-foreground">
            This invite link is not valid or has expired. Contact your broker for a new link.
          </p>
        </div>
      </div>
    );
  }

  // Show onboarding if not yet completed (and not dismissed this session)
  const needsOnboarding = !inviteData.invite.onboardingCompleted && !onboardingDismissed;

  if (needsOnboarding) {
    return (
      <SellerOnboarding
        token={token!}
        onComplete={() => setOnboardingDismissed(true)}
      />
    );
  }

  if (inviteData.deal.interviewCompleted && !continueRequested) {
    return (
      <div className="h-screen flex items-center justify-center p-4">
        <div className="max-w-sm w-full text-center space-y-4">
          <CheckCircle2 className="h-8 w-8 mx-auto text-primary" />
          <h2 className="text-lg font-semibold">Your conversation is complete</h2>
          <p className="text-sm text-muted-foreground">
            Everything you shared is saved. You can add more detail any time — the conversation picks up from what you've already covered.
          </p>
          <div className="flex flex-col gap-2">
            <Button onClick={() => setContinueRequested(true)}>Add more detail</Button>
            <Button variant="ghost" onClick={() => setLocation(`/seller/${token}/progress`)}>
              <ArrowLeft className="h-4 w-4 mr-2" /> Back to progress
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <Interview
      mode="seller"
      dealId={String(inviteData.deal.id)}
      businessName={inviteData.deal.businessName}
      sellerToken={token!}
      onComplete={() => setLocation(`/seller/${token}/progress`)}
      onBack={() => setLocation(`/seller/${token}/progress`)}
    />
  );
}
