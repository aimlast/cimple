/**
 * AddbackGrid — the add-backs × years grid of "Add-backs in the books" (gl
 * spec §3.4). Each cell says where the year stands in words, with the amount
 * ("Adds up · $28,140", "Close — $400 short", "$12,000 of $26,000",
 * "Not started", "Shown by the T4"); each row ends with "Mark reviewed"
 * (Cimple's suggestion pre-selected) or the verdict. Wide screens: a table;
 * below md: one card per add-back with its year chips. A row opens the
 * add-back's drawer.
 */
import { CheckCircle2, ChevronRight, Lock, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { BrokerTrace } from "@/lib/gl-api";
import { Pill, dollars, statusTone } from "./gl-ui";
import { VERDICT_WORDS, yearsWords } from "@shared/gl-copy";

const verdictTone = (v: string | null) => (v === "found" ? "good" : v === "partly_found" ? "close" : "warn") as "good" | "close" | "warn";

function yearsOf(traces: BrokerTrace[]): string[] {
  const ys = new Set<string>();
  for (const t of traces) for (const y of Object.keys(t.claims)) if (/^\d{4}$/.test(y)) ys.add(y);
  return Array.from(ys).sort();
}

export function AddbackGrid({ traces, onOpen, onReview, busy }: {
  traces: BrokerTrace[];
  onOpen: (t: BrokerTrace, year?: string) => void;
  onReview: (t: BrokerTrace) => void;
  busy?: boolean;
}) {
  const years = yearsOf(traces);
  return (
    <>
      {/* Wide screens: the grid */}
      <div className="hidden md:block rounded-lg border border-border overflow-x-auto" data-testid="gl-grid">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/30 text-left">
              <th className="px-3 py-2 text-xs font-medium text-muted-foreground">Add-back</th>
              {years.map((y) => <th key={y} className="px-3 py-2 text-xs font-medium text-muted-foreground whitespace-nowrap">{y}</th>)}
              <th className="px-3 py-2 text-xs font-medium text-muted-foreground text-right">Review</th>
            </tr>
          </thead>
          <tbody>
            {traces.map((t) => (
              <tr key={t.id} className="border-b border-border/60 last:border-0 hover:bg-muted/20" data-testid={`gl-row-${t.id}`}>
                <td className="px-3 py-2.5 align-top min-w-[14rem]">
                  <button type="button" className="text-left group" onClick={() => onOpen(t)} data-testid="gl-row-open">
                    <span className="font-medium group-hover:text-teal">{t.label}</span>
                    <span className="mt-1 flex flex-wrap items-center gap-1.5">
                      <Pill tone="muted">{t.proofLabel}</Pill>
                      {t.sharePct ? <Pill tone="muted">{t.sharePct}% added back</Pill> : null}
                      {t.privateEvidence && <Pill tone="warn"><Lock className="h-2.5 w-2.5" /> Private notes</Pill>}
                      {!t.includeInCim && <Pill tone="muted">Left out of the CIM</Pill>}
                      {t.question && !t.question.answer && <Pill tone="brass">Question sent</Pill>}
                      {t.question?.answer && <Pill tone="brass">Seller answered</Pill>}
                      {t.sellerNote && <Pill tone="brass">Seller's note</Pill>}
                    </span>
                  </button>
                </td>
                {years.map((y) => {
                  const cell = t.cells[y];
                  return (
                    <td key={y} className="px-3 py-2.5 align-top">
                      {cell ? (
                        <button type="button" onClick={() => onOpen(t, y)} className="text-left">
                          <Pill tone={statusTone(cell.status)} testId={`gl-cell-${y}`}>{cell.words}</Pill>
                          {t.proposedYears.includes(y) && cell.status === "not_started" && (
                            <span className="mt-1 flex items-center gap-1 text-2xs text-muted-foreground"><Search className="h-2.5 w-2.5" /> Likely entries found</span>
                          )}
                        </button>
                      ) : <span className="text-xs text-muted-foreground/50">—</span>}
                    </td>
                  );
                })}
                <td className="px-3 py-2.5 align-top text-right whitespace-nowrap">
                  <ReviewCell t={t} onReview={onReview} busy={busy} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Phones: one card per add-back */}
      <ul className="md:hidden space-y-2" data-testid="gl-cards">
        {traces.map((t) => (
          <li key={t.id} className="rounded-lg border border-border bg-card">
            <button type="button" onClick={() => onOpen(t)} className="w-full text-left px-3 pt-3 pb-2 flex items-start gap-2 min-h-[44px]">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium break-words">{t.label}</p>
                <p className="text-2xs text-muted-foreground mt-0.5">{t.proofLabel}{t.sharePct ? ` · ${t.sharePct}% added back` : ""}{t.privateEvidence ? " · From your private notes" : ""}</p>
                {t.proposedYears.length > 0 && Object.values(t.cells).some((c) => c.status === "not_started") && (
                  <p className="text-2xs text-teal mt-0.5 flex items-center gap-1"><Search className="h-2.5 w-2.5" /> Cimple found likely entries for {yearsWords(t.proposedYears)}</p>
                )}
              </div>
              <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
            </button>
            <div className="px-3 pb-2 flex flex-wrap gap-1.5">
              {Object.keys(t.cells).sort().map((y) => (
                <Pill key={y} tone={statusTone(t.cells[y].status)}>{y} · {t.cells[y].words}</Pill>
              ))}
            </div>
            <div className="px-3 pb-3 flex justify-end">
              <ReviewCell t={t} onReview={onReview} busy={busy} />
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

function ReviewCell({ t, onReview, busy }: { t: BrokerTrace; onReview: (t: BrokerTrace) => void; busy?: boolean }) {
  if (t.reviewedAt && t.brokerVerdict) {
    return (
      <span className="inline-flex items-center gap-1 text-xs" data-testid="gl-verdict">
        <CheckCircle2 className={cn("h-3.5 w-3.5", t.brokerVerdict === "found" ? "text-success" : "text-teal")} />
        <Pill tone={verdictTone(t.brokerVerdict)}>{VERDICT_WORDS[t.brokerVerdict]}</Pill>
      </span>
    );
  }
  const suggestion = t.computed?.suggestedVerdict ?? "not_found";
  return (
    <Button size="sm" variant="outline" className="h-8 text-xs" disabled={busy} onClick={() => onReview(t)} data-testid="gl-mark-reviewed" title={`Cimple suggests: ${VERDICT_WORDS[suggestion]}`}>
      Mark reviewed
    </Button>
  );
}

/** The amounts per year, as the drawer and the send dialog show them. */
export function claimLine(t: Pick<BrokerTrace, "claims" | "yearLabels">): string {
  return Object.keys(t.claims).filter((y) => /^\d{4}$/.test(y)).sort().map((y) => `${t.yearLabels[y] ?? y}: ${dollars(t.claims[y])}`).join(" · ");
}
