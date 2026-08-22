/**
 * InterviewReviewTab — Interview transcripts, coverage, and broker-private notes.
 */
import { useDeal } from "@/contexts/DealContext";
import { InterviewTranscriptPanel } from "@/components/deal/InterviewTranscriptPanel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ShieldAlert } from "lucide-react";

interface BrokerPrivateNote {
  note: string;
  reason?: string;
  turn?: number;
}

/**
 * Sensitive facts the interview agent recorded for the broker only — a seller
 * said "don't put that in writing" about something the broker genuinely needs
 * (health-driven sale, litigation detail, a staff departure). These are stored
 * outside every CIM-feeding path and shown nowhere else in the product.
 */
function BrokerPrivateNotesPanel({ notes }: { notes: BrokerPrivateNote[] }) {
  if (notes.length === 0) return null;
  return (
    <Card className="border-amber-600/30" data-testid="panel-broker-private-notes">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldAlert className="h-4 w-4 text-amber-500" />
          Broker-private notes
          <Badge variant="outline" className="ml-auto text-[10px] font-normal">
            Never appears in any CIM
          </Badge>
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Sensitive context the seller shared during the interview and asked to
          keep out of documents. Visible only to you — excluded from CIM
          generation, financial analysis, and buyer-facing content.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {notes.map((n, i) => (
          <div
            key={i}
            className="rounded-md border border-border bg-muted/40 px-3 py-2.5"
            data-testid={`private-note-${i}`}
          >
            <p className="text-sm">{n.note}</p>
            <p className="text-[11px] text-muted-foreground mt-1">
              {n.reason ? n.reason : "Recorded during the interview"}
              {typeof n.turn === "number" ? ` · turn ${n.turn}` : ""}
            </p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export function InterviewReviewTab() {
  const { dealId, deal } = useDeal();
  const privateNotes: BrokerPrivateNote[] = Array.isArray(
    (deal.extractedInfo as Record<string, unknown> | null)?._brokerPrivateNotes,
  )
    ? ((deal.extractedInfo as Record<string, unknown>)
        ._brokerPrivateNotes as BrokerPrivateNote[])
    : [];

  return (
    <div className="max-w-4xl mx-auto px-6 py-6 space-y-6">
      <BrokerPrivateNotesPanel notes={privateNotes} />
      <InterviewTranscriptPanel dealId={dealId} />
    </div>
  );
}
