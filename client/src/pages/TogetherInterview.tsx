/**
 * TogetherInterview — "Interview together": the live coverage board.
 *
 * The broker leads the conversation in any order; Cimple listens (in
 * person, on a Cimple video call, or with its notetaker in Zoom / Meet /
 * Teams), files the seller's answers into the CIM checklist, and shows
 * what's still missing (components/together/TogetherBoard.tsx).
 *
 * Route: /deal/:id/interview/together?via=person|cimple|zoom|meet|teams[&link=…]
 * Checklist mode (?listen=0): the same board with no session and no
 * listening — where "Open the checklist" lands from the Overview and the AI
 * interview's panel. Opening either makes no AI call.
 */
import { useParams, useSearch } from "wouter";
import { TogetherBoard } from "@/components/together/TogetherBoard";
import { isTogetherVia, type TogetherVia } from "@shared/together";

export default function TogetherInterview() {
  const params = useParams<{ id: string }>();
  const search = useSearch();
  const dealId = params?.id;
  const qs = new URLSearchParams(search);
  const viaParam = qs.get("via");
  const via: TogetherVia = isTogetherVia(viaParam) ? viaParam : "person";
  const meetingLink = qs.get("link") || undefined;
  if (!dealId) return null;
  return <TogetherBoard dealId={dealId} listen={qs.get("listen") !== "0"} via={via} meetingLink={meetingLink} />;
}
