/**
 * TogetherInterview — broker-led interview page ("Interview together").
 *
 * The broker runs the AI interview with the seller on a call or in person:
 * the AI's question is on the broker's screen to read aloud, the seller's
 * spoken answer is captured (mic) or typed, and everything else — extraction,
 * coverage, quality score, next question — works exactly as in the seller's
 * own interview. `via` records how the call is happening (in person, Zoom,
 * Meet, Teams, Cimple) and drives the floating question window.
 *
 * Route: /deal/:id/interview/together?via=person|zoom|meet|teams|cimple&link=…
 */
import { useParams, useLocation, useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { Interview, type TogetherVia } from "@/components/shared/Interview";
import type { Deal } from "@shared/schema";

const VIAS: TogetherVia[] = ["person", "zoom", "meet", "teams", "cimple"];

export default function TogetherInterview() {
  const [, setLocation] = useLocation();
  const params = useParams<{ id: string }>();
  const search = useSearch();
  const dealId = params?.id;
  const qs = new URLSearchParams(search);
  const viaParam = qs.get("via") as TogetherVia | null;
  const via: TogetherVia = viaParam && VIAS.includes(viaParam) ? viaParam : "person";
  const meetingLink = qs.get("link") || undefined;

  const { data: deal } = useQuery<Deal>({
    queryKey: ["/api/deals", dealId],
    enabled: !!dealId,
  });

  if (!dealId) return null;

  return (
    <Interview
      mode="together"
      via={via}
      meetingLink={meetingLink}
      dealId={dealId}
      businessName={deal?.businessName}
      onComplete={async () => {
        await queryClient.invalidateQueries({ queryKey: ["/api/deals"] });
        await queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId] });
        setLocation(`/deal/${dealId}`);
      }}
      onBack={() => setLocation(`/deal/${dealId}`)}
    />
  );
}
