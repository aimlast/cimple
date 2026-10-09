/**
 * SellerCostCard — one cost on the seller's "Costs to show" list (gl spec
 * §3.3 B). By what the broker asked for:
 *   ledger, Cimple confident  "We found these in your books: Vehicle – Owner
 *                             account, 2022–2024, $78,000 in total."
 *                             → Yes, that's right / Let me check the entries
 *   ledger, not confident     the hint, the year chips, Check the entries
 *   pay                       "Your T4 slips show this best." → Upload your
 *                             T4 slips; or find the pay entries in the ledger
 *   one-off                   the payment and the letter or invoice
 * Year chips are words ("2024 · Done", "2023 · Almost — $160 short").
 */
import { Check, ChevronRight, Loader2, MessageSquare, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { SellerCost } from "@/lib/gl-api";
import { accountPath, yearsWords } from "@shared/gl-copy";
import { Pill, dollars, statusTone } from "./gl-ui";

const DONE = new Set(["done", "not_in_ledger", "disputed"]);

export function SellerCostCard({ cost, payDoc, onOpen, onConfirmSummary, onUpload, confirming, preview }: {
  cost: SellerCost;
  payDoc: { slips: string; short: string; box: string | null };
  onOpen: (year?: string) => void;
  onConfirmSummary: () => void;
  onUpload: () => void;
  confirming?: boolean;
  preview?: boolean;
}) {
  const done = DONE.has(cost.sellerStatus);
  const years = cost.years.map((y) => y.year);
  const openQuestion = cost.question && !cost.question.answer;
  const owner = cost.sellerLabel === "Your pay as owner";
  const who = cost.sellerLabel.replace(/'s pay$/, "").split(/\s+/)[0];
  return (
    <div className={cn("rounded-lg border bg-card p-4 flex flex-col gap-3", done ? "border-success/30" : openQuestion || cost.reopenedNote ? "border-teal/40" : "border-border")} data-testid={`cost-${cost.id}`}>
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold break-words">{cost.sellerLabel}</h3>
          {cost.sellerHint && cost.proof !== "payroll" && <p className="text-xs text-muted-foreground mt-0.5">{cost.sellerHint}</p>}
          {cost.shareWords && <p className="text-xs text-muted-foreground mt-0.5">{cost.shareWords}</p>}
        </div>
        {done && <Pill tone="good"><Check className="h-3 w-3" /> {cost.sellerStatus === "done" ? "Done" : cost.sellerStatus === "disputed" ? "Note sent" : "Not in the ledger"}</Pill>}
      </div>

      {openQuestion && (
        <button type="button" onClick={() => onOpen()} className="text-left rounded-md border border-teal/30 bg-teal/5 px-3 py-2 text-sm flex items-start gap-2">
          <MessageSquare className="h-4 w-4 text-teal mt-0.5 shrink-0" /><span>Your broker asks: "{cost.question!.text}" <span className="text-teal">Answer</span></span>
        </button>
      )}
      {cost.reopenedNote && !done && (
        <p className="rounded-md border border-teal/30 bg-teal/5 px-3 py-2 text-sm flex items-start gap-2"><RotateCcw className="h-4 w-4 text-teal mt-0.5 shrink-0" />{cost.reopenedNote}</p>
      )}

      {!done && cost.proof === "ledger" && cost.summary && (
        <div className="space-y-3" data-testid="cost-summary">
          <p className="text-sm">We found these in your books: <strong>{cost.summary.accounts.map(accountPath).join(", ")}</strong> account{cost.summary.accounts.length === 1 ? "" : "s"}, {yearsWords(cost.summary.years)}, <strong>{dollars(cost.summary.totalCents)}</strong> in total. Is that right?</p>
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <Button className="h-11 sm:h-9 bg-teal text-teal-foreground hover:bg-teal/90" disabled={confirming || preview} onClick={onConfirmSummary} data-testid="cost-confirm-summary">
              {confirming && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />} Yes, that's right
            </Button>
            <Button variant="outline" className="h-11 sm:h-9" onClick={() => onOpen()}>Let me check the entries</Button>
          </div>
        </div>
      )}

      {!done && cost.proof === "payroll" && (
        <div className="space-y-2">
          <p className="text-sm">{owner ? "Your" : `${who}'s`} {payDoc.slips === "year-end payroll summary" ? "year-end payroll summary shows" : `${payDoc.slips} show`} this best{payDoc.slips === "year-end payroll summary" ? "" : " (or the year-end payroll summary)"}.</p>
          <div className="flex flex-col items-start gap-2">
            <Button className="h-auto min-h-11 sm:min-h-9 py-2 whitespace-normal text-left bg-teal text-teal-foreground hover:bg-teal/90" onClick={onUpload} data-testid="cost-upload-slips">Upload {owner ? "your" : `${who}'s`} {payDoc.slips} ({yearsWords(years)})</Button>
            <button type="button" className="text-xs text-teal hover:underline text-left min-h-8" onClick={() => onOpen()}>Or find the pay entries in your ledger</button>
          </div>
        </div>
      )}

      {!done && cost.proof === "one_off" && (
        <div className="space-y-2">
          <p className="text-sm">The payment in your ledger, and the letter or invoice if you have it — buyers will ask for both.</p>
          <Button variant="outline" className="h-11 sm:h-9" onClick={() => onOpen()}>Check the entries</Button>
        </div>
      )}

      {!done && cost.proof === "ledger" && !cost.summary && (
        <Button variant="outline" className="h-11 sm:h-9 self-start" onClick={() => onOpen()} data-testid="cost-check">Check the entries</Button>
      )}

      {cost.assistantLooking && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground" aria-live="polite" data-testid="cost-assistant-looking">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Cimple's assistant is looking for more entries…
        </p>
      )}
      <div className="flex flex-wrap gap-1.5">
        {cost.years.map((y) => (
          <button key={y.year} type="button" onClick={() => onOpen(y.year)} className="min-h-[32px]">
            <Pill tone={statusTone(y.status)}>{y.chip}</Pill>
          </button>
        ))}
      </div>
      {done && (
        <button type="button" className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 self-start" onClick={() => onOpen()}>
          Review or change <ChevronRight className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}
