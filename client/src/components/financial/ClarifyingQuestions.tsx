import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertTriangle, AlertCircle, Info, Check, X, Send, ChevronDown, ChevronUp
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
}

interface ClarifyingQuestionsProps {
  questions: ClarifyingQuestion[] | null;
  onUpdate?: (updated: ClarifyingQuestion[]) => void;
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
export function ClarifyingQuestions({ questions, onUpdate }: ClarifyingQuestionsProps) {
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

  const pending = questions.filter(q => q.status === "pending");
  const resolved = questions.filter(q => q.status !== "pending");

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
            <QuestionCard key={q.id} question={q} questions={questions} onUpdate={onUpdate} />
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
            <QuestionCard key={q.id} question={q} questions={questions} onUpdate={onUpdate} />
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
  onUpdate,
}: {
  question: ClarifyingQuestion;
  questions: ClarifyingQuestion[];
  onUpdate?: (updated: ClarifyingQuestion[]) => void;
}) {
  const [answerText, setAnswerText] = useState("");
  const [showAnswer, setShowAnswer] = useState(false);
  const [expanded, setExpanded] = useState(question.status === "pending");

  const sev = SEVERITY[question.severity] || SEVERITY.low;
  const SevIcon = sev.icon;
  const isPending = question.status === "pending";

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
    <Card className={`${isPending ? "" : "opacity-70"}`}>
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <SevIcon className={`h-4 w-4 ${sev.color} mt-0.5 shrink-0`} />

          <div className="flex-1 min-w-0">
            {/* Header */}
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <Badge className={`${sev.bg} ${sev.color} text-2xs`}>{sev.label}</Badge>
                  {question.status === "answered" && (
                    <Badge className="bg-success/10 text-success border-0 text-2xs gap-0.5">
                      <Check className="h-2.5 w-2.5" /> Answered
                    </Badge>
                  )}
                  {question.status === "dismissed" && (
                    <Badge className="bg-muted text-muted-foreground border-0 text-2xs">Dismissed</Badge>
                  )}
                  {question.status === "routed_to_seller" && (
                    <Badge className="bg-blue-500/10 text-blue-400 border-0 text-2xs gap-0.5">
                      <Send className="h-2.5 w-2.5" /> Sent to Seller
                    </Badge>
                  )}
                </div>
                <p className="text-sm">{question.question}</p>
              </div>
              <button
                onClick={() => setExpanded(!expanded)}
                className="text-muted-foreground/50 hover:text-muted-foreground p-0.5 shrink-0"
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

                {/* Answer */}
                {question.answer && (
                  <div className="mt-2 bg-success/5 border border-success/20 rounded px-3 py-2">
                    <p className="text-xs text-success/80 font-medium mb-0.5">Answer</p>
                    <p className="text-xs">{question.answer}</p>
                  </div>
                )}

                {/* Actions */}
                {isPending && onUpdate && (
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
                      <div className="flex items-center gap-2">
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
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 text-xs text-muted-foreground gap-1"
                          onClick={() => updateQuestion({ status: "routed_to_seller" })}
                        >
                          <Send className="h-3 w-3" /> Route to Seller
                        </Button>
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
