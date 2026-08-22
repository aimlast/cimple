import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { Discrepancy } from "@shared/schema";
import {
  AlertTriangle, AlertCircle, Info, Check, X, Send, ChevronDown, ChevronUp, Loader2, Undo2
} from "lucide-react";

/* ──────────────────────────────────────────────
   Types
─────────────────────────────────────────────── */
export interface ClarifyingQuestion {
  id: string;
  severity: "high" | "medium" | "low";
  question: string;
  context?: string;
  answer?: string;
  status: "pending" | "answered" | "dismissed" | "routed_to_seller";
  /** Set by the server when routed — the ask_seller discrepancy the interview reads. */
  discrepancyId?: string;
  /** Set by a re-run that carried this question over from an earlier analysis version. */
  carriedFromVersion?: number;
}

/** The subset of a discrepancy row the cards need to reflect real routing state. */
export type LinkedDiscrepancy = Pick<Discrepancy, "id" | "status" | "resolvedValue" | "sellerResponse">;

interface ClarifyingQuestionsProps {
  questions: ClarifyingQuestion[] | null;
  onUpdate?: (updated: ClarifyingQuestion[]) => void;
  /**
   * Routes a question to the AI seller interview. This must go through the
   * server (it creates an ask_seller discrepancy the interview actually reads);
   * flipping the status locally would only paint a misleading badge. When this
   * is not provided the Route button is hidden rather than faked.
   */
  onRouteToSeller?: (question: ClarifyingQuestion) => void;
  /** Id of the question currently being routed (shows a spinner on that card). */
  routingQuestionId?: string | null;
  /**
   * The deal's discrepancies. A routed question is linked to one by
   * `discrepancyId`; its live status (ask_seller / resolved / un-routed) is what
   * the card shows, so the badge never claims "asked in interview" after the
   * broker resolved or took it back in the Discrepancies tab.
   */
  discrepancies?: LinkedDiscrepancy[];
}

/* ──────────────────────────────────────────────
   Routing state — derived from the linked discrepancy
─────────────────────────────────────────────── */
type RoutedState = "with_seller" | "answered" | "unrouted";

function routedState(q: ClarifyingQuestion, linked: LinkedDiscrepancy | undefined): RoutedState | null {
  if (q.status !== "routed_to_seller") return null;
  if (!linked) return "with_seller";
  if (linked.status === "resolved" || linked.status === "accepted") return "answered";
  if (linked.status === "open" || linked.status === "seller_responded") return "unrouted";
  return "with_seller";
}

function indexLinked(discrepancies?: LinkedDiscrepancy[]): Record<string, LinkedDiscrepancy> {
  const map: Record<string, LinkedDiscrepancy> = {};
  for (const d of discrepancies ?? []) map[d.id] = d;
  return map;
}

/** Still needs the broker: pending, or routed and then taken back from the interview. */
function needsAction(q: ClarifyingQuestion, linked: LinkedDiscrepancy | undefined): boolean {
  return q.status === "pending" || routedState(q, linked) === "unrouted";
}

/** Count used by the Questions tab badge — same rule as the "Pending" group below. */
export function countPendingQuestions(
  questions: ClarifyingQuestion[] | null | undefined,
  discrepancies?: LinkedDiscrepancy[],
): number {
  if (!questions) return 0;
  const map = indexLinked(discrepancies);
  return questions.filter((q) => needsAction(q, q.discrepancyId ? map[q.discrepancyId] : undefined)).length;
}

/* ──────────────────────────────────────────────
   Severity config
─────────────────────────────────────────────── */
const SEVERITY: Record<string, { icon: React.ElementType; color: string; bg: string; label: string }> = {
  high:   { icon: AlertTriangle, color: "text-red-400",    bg: "bg-red-500/10 border-0",    label: "High" },
  medium: { icon: AlertCircle,   color: "text-amber-400",  bg: "bg-amber-500/10 border-0",  label: "Medium" },
  low:    { icon: Info,          color: "text-blue-400",   bg: "bg-blue-500/10 border-0",   label: "Low" },
};

/* ──────────────────────────────────────────────
   Component
─────────────────────────────────────────────── */
export function ClarifyingQuestions({
  questions,
  onUpdate,
  onRouteToSeller,
  routingQuestionId,
  discrepancies,
}: ClarifyingQuestionsProps) {
  if (!questions || questions.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Clarifying Questions</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground text-center py-8">
            No questions generated yet. The AI will identify anomalies during analysis.
          </p>
        </CardContent>
      </Card>
    );
  }

  const linkedById = indexLinked(discrepancies);
  const linkedFor = (q: ClarifyingQuestion) => (q.discrepancyId ? linkedById[q.discrepancyId] : undefined);

  const pending = questions.filter(q => needsAction(q, linkedFor(q)));
  const resolved = questions.filter(q => !needsAction(q, linkedFor(q)));

  return (
    <div className="space-y-4">
      {/* Summary */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-full bg-amber-500/10 flex items-center justify-center">
                <AlertCircle className="h-4 w-4 text-amber-400" />
              </div>
              <div>
                <p className="text-sm font-medium">{pending.length} question{pending.length !== 1 ? "s" : ""} pending</p>
                <p className="text-2xs text-muted-foreground">
                  {resolved.length} resolved
                </p>
              </div>
            </div>
            <div className="flex gap-2 ml-auto">
              {(["high", "medium", "low"] as const).map(sev => {
                const count = questions.filter(q => q.severity === sev).length;
                if (count === 0) return null;
                const cfg = SEVERITY[sev];
                return (
                  <Badge key={sev} className={`${cfg.bg} ${cfg.color} text-2xs gap-1`}>
                    {count} {cfg.label}
                  </Badge>
                );
              })}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Pending questions */}
      {pending.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider px-1">
            Pending
          </p>
          {pending.map(q => (
            <QuestionCard
              key={q.id}
              question={q}
              questions={questions}
              linked={linkedFor(q)}
              onUpdate={onUpdate}
              onRouteToSeller={onRouteToSeller}
              isRouting={routingQuestionId === q.id}
            />
          ))}
        </div>
      )}

      {/* Resolved questions */}
      {resolved.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider px-1">
            Resolved
          </p>
          {resolved.map(q => (
            <QuestionCard
              key={q.id}
              question={q}
              questions={questions}
              linked={linkedFor(q)}
              onUpdate={onUpdate}
              onRouteToSeller={onRouteToSeller}
              isRouting={routingQuestionId === q.id}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ──────────────────────────────────────────────
   Question card sub-component
─────────────────────────────────────────────── */
function QuestionCard({
  question,
  questions,
  linked,
  onUpdate,
  onRouteToSeller,
  isRouting,
}: {
  question: ClarifyingQuestion;
  questions: ClarifyingQuestion[];
  linked?: LinkedDiscrepancy;
  onUpdate?: (updated: ClarifyingQuestion[]) => void;
  onRouteToSeller?: (question: ClarifyingQuestion) => void;
  isRouting?: boolean;
}) {
  const routing = routedState(question, linked);
  const isActionable = needsAction(question, linked);

  const [answerText, setAnswerText] = useState("");
  const [showAnswer, setShowAnswer] = useState(false);
  const [expanded, setExpanded] = useState(isActionable);

  const sev = SEVERITY[question.severity] || SEVERITY.low;
  const SevIcon = sev.icon;

  const updateQuestion = (updates: Partial<ClarifyingQuestion>) => {
    if (!onUpdate) return;
    const updated = questions.map(q =>
      q.id === question.id ? { ...q, ...updates } : q
    );
    onUpdate(updated);
  };

  const submitAnswer = () => {
    if (!answerText.trim()) return;
    updateQuestion({ answer: answerText.trim(), status: "answered" });
    setAnswerText("");
    setShowAnswer(false);
  };

  return (
    <Card className={`${isActionable ? "" : "opacity-70"}`}>
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <SevIcon className={`h-4 w-4 ${sev.color} mt-0.5 shrink-0`} />

          <div className="flex-1 min-w-0">
            {/* Header */}
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <Badge className={`${sev.bg} ${sev.color} text-2xs`}>{sev.label}</Badge>
                  {question.status === "answered" && (
                    <Badge className="bg-success/10 text-success border-0 text-2xs gap-0.5">
                      <Check className="h-2.5 w-2.5" /> Answered
                    </Badge>
                  )}
                  {question.status === "dismissed" && (
                    <Badge className="bg-muted text-muted-foreground border-0 text-2xs">Dismissed</Badge>
                  )}
                  {question.carriedFromVersion !== undefined && (
                    <Badge
                      className="bg-muted text-muted-foreground border-0 text-2xs"
                      title="Carried over from an earlier analysis version — answers and routing are kept across re-runs"
                    >
                      From v{question.carriedFromVersion}
                    </Badge>
                  )}
                  {routing === "with_seller" && (
                    <Badge className="bg-blue-500/10 text-blue-400 border-0 text-2xs gap-0.5">
                      <Send className="h-2.5 w-2.5" /> Asked in seller interview
                    </Badge>
                  )}
                  {routing === "answered" && (
                    <Badge className="bg-success/10 text-success border-0 text-2xs gap-0.5">
                      <Check className="h-2.5 w-2.5" /> Answered via interview
                    </Badge>
                  )}
                  {routing === "unrouted" && (
                    <Badge className="bg-amber-500/10 text-amber-400 border-0 text-2xs gap-0.5">
                      <Undo2 className="h-2.5 w-2.5" /> Taken back from interview
                    </Badge>
                  )}
                </div>
                <p className="text-sm">{question.question}</p>
              </div>
              <button
                onClick={() => setExpanded(!expanded)}
                className="text-muted-foreground/50 hover:text-muted-foreground p-0.5 shrink-0"
                aria-label={expanded ? "Collapse question" : "Expand question"}
              >
                {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              </button>
            </div>

            {expanded && (
              <>
                {/* Context */}
                {question.context && (
                  <p className="text-xs text-muted-foreground mt-2 bg-muted/30 rounded px-3 py-2">
                    {question.context}
                  </p>
                )}

                {/* Answer typed by the broker */}
                {question.answer && (
                  <div className="mt-2 bg-success/5 border border-success/20 rounded px-3 py-2">
                    <p className="text-xs text-success/80 font-medium mb-0.5">Answer</p>
                    <p className="text-xs">{question.answer}</p>
                  </div>
                )}

                {/* Answer captured through the interview / Discrepancies tab */}
                {!question.answer && routing === "answered" && (
                  <div className="mt-2 bg-success/5 border border-success/20 rounded px-3 py-2">
                    <p className="text-xs text-success/80 font-medium mb-0.5">Answer from the seller interview</p>
                    <p className="text-xs">{linked?.resolvedValue || "Resolved"}</p>
                    {linked?.sellerResponse && (
                      <p className="text-2xs text-muted-foreground mt-1">{linked.sellerResponse}</p>
                    )}
                  </div>
                )}

                {routing === "unrouted" && (
                  <p className="text-xs text-amber-400 mt-2">
                    This question was taken back from the seller interview. Answer it here, dismiss it, or send it to the interview again.
                  </p>
                )}

                {/* Dismissed by mistake — put it back in the pending list */}
                {question.status === "dismissed" && onUpdate && (
                  <div className="mt-3">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs text-muted-foreground gap-1"
                      onClick={() => updateQuestion({ status: "pending" })}
                    >
                      <Undo2 className="h-3 w-3" /> Restore
                    </Button>
                  </div>
                )}

                {/* Actions */}
                {isActionable && onUpdate && (
                  <div className="mt-3">
                    {showAnswer ? (
                      <div className="space-y-2">
                        <Textarea
                          placeholder="Type your answer..."
                          value={answerText}
                          onChange={e => setAnswerText(e.target.value)}
                          className="text-xs min-h-[60px] resize-none"
                        />
                        <div className="flex items-center gap-2">
                          <Button
                            size="sm"
                            className="h-7 text-xs bg-teal text-teal-foreground hover:bg-teal/90 gap-1"
                            onClick={submitAnswer}
                            disabled={!answerText.trim()}
                          >
                            <Check className="h-3 w-3" /> Submit
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 text-xs text-muted-foreground"
                            onClick={() => { setShowAnswer(false); setAnswerText(""); }}
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 flex-wrap">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs gap-1"
                          onClick={() => setShowAnswer(true)}
                        >
                          Answer
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 text-xs text-muted-foreground gap-1"
                          onClick={() => updateQuestion({ status: "dismissed" })}
                        >
                          <X className="h-3 w-3" /> Dismiss
                        </Button>
                        {onRouteToSeller && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 text-xs text-muted-foreground gap-1"
                            onClick={() => onRouteToSeller(question)}
                            disabled={isRouting}
                          >
                            {isRouting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
                            {routing === "unrouted" ? "Ask seller again" : "Ask seller in interview"}
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
