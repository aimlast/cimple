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
import { Loader2 } from "lucide-react";

export default function SellerInterview() {
  const { token } = useParams<{ token: string }>();
  const [, setLocation] = useLocation();
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);

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

  return (
    <Interview
      mode="seller"
      dealId={String(inviteData.deal.id)}
      businessName={inviteData.deal.businessName}
      onComplete={() => setLocation(`/seller/${token}/progress`)}
      onBack={() => setLocation(`/seller/${token}/progress`)}
    />
  );
}
