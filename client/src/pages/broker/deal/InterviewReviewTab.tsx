/**
 * InterviewReviewTab — Interview transcripts and coverage.
 */
import { useDeal } from "@/contexts/DealContext";
import { InterviewTranscriptPanel } from "@/components/deal/InterviewTranscriptPanel";

export function InterviewReviewTab() {
  const { dealId } = useDeal();

  return (
    <div className="max-w-4xl mx-auto px-6 py-6">
      <InterviewTranscriptPanel dealId={dealId} />
    </div>
  );
}
