/**
 * QuestionsTab — "Questions for the seller" (spec §5.2 Tab 3, D13): the
 * questions Cimple suggests when nothing on file explains a big change or a
 * difference, with the auto-ask switch, their state, the seller's answer and
 * the actions (Ask the seller — several at once — · Write the reason
 * yourself · Not needed).
 */
import { useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { WorkspaceQuestion } from "@shared/figure-workspace";
import { shortDate } from "./useFigures";

export interface QuestionsActions {
  onAsk(ids: string[]): void;
  onWrite(q: WorkspaceQuestion): void;
  onNotNeeded(q: WorkspaceQuestion): void;
  onReopen(q: WorkspaceQuestion): void;
  onAutoAsk(on: boolean): void;
  autoAskBusy?: boolean;
}

function statusWords(q: WorkspaceQuestion, interviewDone: boolean): { label: string; tone: string } {
  switch (q.status) {
    case "suggested": return { label: "Suggested", tone: "text-muted-foreground" };
    case "ask_seller":
      return q.routedBy === "auto" || !interviewDone
        ? { label: "In the interview", tone: "text-teal" }
        : { label: `Waiting for the seller${q.routedAt ? ` (emailed ${shortDate(q.routedAt)})` : ""}`, tone: "text-amber-500" };
    case "answered": return { label: "Answered: note ready for your OK", tone: "text-success" };
    case "asked": return { label: "Asked: no reason given", tone: "text-muted-foreground" };
    case "closed": return { label: q.closedReason === "not_needed" ? "Not needed" : "Closed", tone: "text-muted-foreground" };
  }
}

export function QuestionsTab({ questions, autoAsk, interviewDone, actions }: { questions: WorkspaceQuestion[]; autoAsk: boolean; interviewDone: boolean; actions: QuestionsActions }) {
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const open = questions.filter((q) => q.status !== "closed");
  const closed = questions.filter((q) => q.status === "closed");
  const askable = (q: WorkspaceQuestion) => q.status === "suggested" || q.status === "asked";
  const ids = open.filter((q) => askable(q) && picked[q.id]).map((q) => q.id);
  return (
    <div className="space-y-4">
      <div className="space-y-3 rounded-lg border border-border bg-card p-3">
        <p className="text-xs text-muted-foreground">
          When nothing on file explains a big change or a difference, Cimple suggests a question for the seller. While the interview is running it asks during the interview; after that, you send the questions.
        </p>
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="auto-ask" className="text-sm">Ask during the interview automatically</Label>
          <Switch id="auto-ask" checked={autoAsk} disabled={actions.autoAskBusy} onCheckedChange={actions.onAutoAsk} />
        </div>
        <p className="text-[11px] text-muted-foreground">At most three, one at a time, never as an audit — and they never keep the interview open.</p>
      </div>

      {open.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground" data-testid="questions-empty">
          No questions for the seller right now. Cimple suggests one when a big change or a difference has nothing on file to explain it.
        </p>
      ) : (
        <>
          {open.some(askable) && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <Checkbox
                  checked={open.filter(askable).every((q) => picked[q.id])}
                  onCheckedChange={(v) => setPicked(Object.fromEntries(open.filter(askable).map((q) => [q.id, v === true])))}
                /> Select all
              </label>
              <Button size="sm" className="h-8 bg-teal text-xs text-teal-foreground hover:bg-teal/90" disabled={ids.length === 0} onClick={() => actions.onAsk(ids)} data-testid="button-ask-selected">
                Ask the seller{ids.length > 0 ? ` (${ids.length})` : ""}
              </Button>
            </div>
          )}
          <ul className="space-y-2">
            {open.map((q) => {
              const s = statusWords(q, interviewDone);
              return (
                <li key={q.id} className="space-y-2 rounded-lg border border-border bg-card p-3" data-testid={`question-${q.id}`}>
                  <div className="flex items-start gap-2.5">
                    {askable(q) ? (
                      <Checkbox className="mt-0.5" checked={!!picked[q.id]} onCheckedChange={(v) => setPicked((p) => ({ ...p, [q.id]: v === true }))} aria-label="Select this question" />
                    ) : <span className="w-4 shrink-0" />}
                    <div className="min-w-0 flex-1 space-y-1">
                      <p className="text-sm leading-snug">{q.display}</p>
                      <p className={cn("text-xs", s.tone)}>{s.label}</p>
                      {q.answer && (
                        <p className="rounded-md bg-muted/40 px-2 py-1.5 text-xs">“{q.answer.text}” <span className="text-muted-foreground">— {q.answer.from}</span></p>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1.5 pl-6">
                    {askable(q) && <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => actions.onAsk([q.id])}>Ask the seller</Button>}
                    <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => actions.onWrite(q)}>{q.answer ? "Write the note from the answer" : "Write the reason yourself"}</Button>
                    <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-muted-foreground" onClick={() => actions.onNotNeeded(q)}>Not needed</Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {closed.length > 0 && (
        <details className="rounded-lg border border-border px-3 py-2">
          <summary className="cursor-pointer text-xs text-muted-foreground">Closed ({closed.length})</summary>
          <ul className="mt-2 space-y-1.5">
            {closed.map((q) => (
              <li key={q.id} className="flex items-start justify-between gap-3 text-xs">
                <span className="text-muted-foreground">{q.question} · {statusWords(q, interviewDone).label}</span>
                {q.closedReason === "not_needed" && <button type="button" className="shrink-0 text-teal hover:underline" onClick={() => actions.onReopen(q)}>Reopen</button>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
