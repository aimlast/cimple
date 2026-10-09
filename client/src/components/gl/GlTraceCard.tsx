/**
 * The "Add-backs in the books" step outside Financials (gl spec §3.5):
 *
 *   GlAddbackChip  beside each add-back on the Normalization tab: Found /
 *                  Partly / Not found / Shown by T4 / Statements (nothing
 *                  while the seller hasn't been asked); the tooltip says what
 *                  was found ("In the books: 26 entries, $27,840 of $28,000
 *                  (2024)"); it opens the add-back on "Add-backs in the books".
 *   GlTraceCard    on the Overview from the moment kept add-backs need proof:
 *                  one status line and one action.
 */
import { useLocation } from "wouter";
import { ArrowRight, BookCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useBrokerGl, useGlProgress } from "@/hooks/useGlStatus";
import { addbackKeyFor, formatCount } from "@shared/gl-copy";
import { Pill, dollars, type GlTone } from "./gl-ui";

export function GlAddbackChip({ dealId, label }: { dealId: string; label: string }) {
  const { data } = useBrokerGl(dealId);
  const [, navigate] = useLocation();
  const t = (data?.traces ?? []).find((x) => x.addbackKey === addbackKeyFor(label));
  if (!t) return null;
  let words: string | null = null;
  let tone: GlTone = "muted";
  if (t.proof === "statement") words = "Statements";
  else if (t.reviewedAt && t.brokerVerdict) {
    words = t.brokerVerdict === "found" ? "Found" : t.brokerVerdict === "partly_found" ? "Partly" : "Not found";
    tone = t.brokerVerdict === "found" ? "good" : t.brokerVerdict === "partly_found" ? "close" : "warn";
  } else {
    const o = t.computed?.overall;
    if (o === "found" || o === "close") { words = "Found"; tone = "good"; }
    else if (o === "document") { words = `Shown by ${data?.payDoc?.short ?? "a document"}`; tone = "good"; }
    else if (o === "short" || o === "over") { words = "Partly"; tone = "close"; }
    else if (o === "not_in_ledger") { words = "Not found"; tone = "warn"; }
    else if (t.sentAt) words = "With the seller";
  }
  if (!words) return null;
  const years = Object.keys(t.computed?.byYear ?? {}).sort();
  const latest = years[years.length - 1];
  const y = latest ? t.computed!.byYear[latest] : null;
  const tip = t.proof === "statement"
    ? "Comes straight from the financial statements — nothing to find in the books."
    : y ? `In the books: ${formatCount(y.confirmed)} entr${y.confirmed === 1 ? "y" : "ies"}, ${dollars(y.foundCents + y.documentCents)} of ${dollars(y.targetCents)} (${latest})` : "Add-backs in the books";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" className="shrink-0" onClick={() => navigate(`/deal/${dealId}/financials?fin=books&addback=${t.id}`)} data-testid="gl-normalization-chip" aria-label={`In the books: ${words}. ${tip}`}>
          <Pill tone={tone}><BookCheck className="h-2.5 w-2.5" /> {words}</Pill>
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-xs">{tip}</TooltipContent>
    </Tooltip>
  );
}

const STATE_LINE: Record<string, string> = {
  not_requested: "The seller hasn't been asked yet.",
  with_seller: "With the seller — they're finding the entries.",
  with_broker: "Your turn: review what the seller found.",
  done: "Every add-back is reviewed.",
  waived: "You went ahead without the ledger.",
};

export function GlTraceCard({ dealId }: { dealId: string }) {
  const { data } = useGlProgress(dealId);
  const [, navigate] = useLocation();
  const gl = data?.glTracing;
  const gate = data?.gate;
  if (!gl || !gate || gate.state === "not_needed") return null;
  const books = `/deal/${dealId}/financials?fin=books`;
  let line = STATE_LINE[gate.state] ?? "";
  let action = gate.state === "not_requested" ? "Ask the seller" : gate.state === "with_broker" ? "Review" : "Open";
  if (gl.needsColumns) { line = "The ledger needs its columns checked."; action = "Check the columns"; }
  else if (gl.accountantPending) { line = "The seller asked to bring in their accountant — send them their link."; action = "Send it"; }
  const progress = gate.total ? ` ${gate.total - gate.toGo} of ${gate.total} reviewed.` : "";
  return (
    <div className="rounded-lg border border-border bg-card p-4 flex flex-col gap-3 sm:flex-row sm:items-center" data-testid="gl-trace-card">
      <div className="h-9 w-9 rounded-lg bg-teal/10 flex items-center justify-center shrink-0">
        <BookCheck className="h-4 w-4 text-teal" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium">Add-backs in the books</p>
        <p className="text-xs text-muted-foreground mt-0.5">{line}{gate.state === "done" || gate.state === "waived" ? "" : progress} Needed for the due-diligence CIM.</p>
      </div>
      <Button size="sm" variant={gate.state === "with_broker" || gate.state === "not_requested" || gl.needsColumns || gl.accountantPending ? "default" : "outline"}
        className="h-8 text-xs gap-1 shrink-0 self-start sm:self-auto" onClick={() => navigate(books)}>
        {action} <ArrowRight className="h-3 w-3" />
      </Button>
    </div>
  );
}
