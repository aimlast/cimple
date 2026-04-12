/**
 * CIMInterview — Broker-mode fullscreen interview page.
 *
 * Thin wrapper around the shared Interview component.
 * Resolves dealId from route params and provides broker-specific
 * callbacks (navigate back to deal, invalidate cache on complete).
 *
 * Routes: /deal/:id/interview, /broker/cim/:id/interview
 */
import { useParams, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { Interview } from "@/components/shared/Interview";
import type { Deal } from "@shared/schema";

export default function CIMInterview() {
  const [, setLocation] = useLocation();
  const params = useParams<{ id: string }>();
  const dealId = params?.id;

  const { data: deal } = useQuery<Deal>({
    queryKey: ["/api/deals", dealId],
    enabled: !!dealId,
  });

  if (!dealId) return null;

  return (
    <Interview
      mode="broker"
      dealId={dealId}
      businessName={deal?.businessName}
      onComplete={async () => {
        await queryClient.invalidateQueries({ queryKey: ["/api/deals"] });
        await queryClient.invalidateQueries({
          queryKey: ["/api/deals", dealId],
        });
        setLocation(`/deal/${dealId}`);
      }}
      onBack={() => setLocation(`/deal/${dealId}`)}
    />
  );
}
