/**
 * SellerInterview — Fullscreen interview page for seller mode.
 *
 * Resolves the seller invite token to a dealId, then renders
 * the shared Interview component in seller mode.
 *
 * Route: /seller/:token/interview (rendered in FullscreenLayout)
 */
import { useParams, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Interview } from "@/components/shared/Interview";
import { Loader2 } from "lucide-react";

export default function SellerInterview() {
  const { token } = useParams<{ token: string }>();
  const [, setLocation] = useLocation();

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
          <span className="text-sm">Loading interview...</span>
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

  return (
    <Interview
      mode="seller"
      dealId={String(inviteData.deal.id)}
      businessName={inviteData.deal.businessName}
      onComplete={() => setLocation(`/seller/${token}`)}
      onBack={() => setLocation(`/seller/${token}`)}
    />
  );
}
