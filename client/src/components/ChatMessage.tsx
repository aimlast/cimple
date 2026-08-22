import { useState } from "react";
import { cn } from "@/lib/utils";
import { Sparkles, User, Pencil, HelpCircle, ChevronUp, CornerUpLeft } from "lucide-react";
import { format } from "date-fns";

interface ChatMessageProps {
  role: "ai" | "user";
  content: string;
  timestamp?: string;
  /** Buyer-rationale for the question asked — rendered behind "Why we ask this" */
  whyItMatters?: string;
  /** User messages: this message corrects an earlier answer */
  correctionOf?: { timestamp?: string; content: string };
  /** User messages: a later message corrected this one */
  superseded?: boolean;
  /** User messages: this answer is currently loaded in the composer for editing */
  isEditing?: boolean;
  /** When provided (user messages only), shows an edit affordance on hover */
  onEdit?: () => void;
}

export function ChatMessage({
  role,
  content,
  timestamp,
  whyItMatters,
  correctionOf,
  superseded,
  isEditing,
  onEdit,
}: ChatMessageProps) {
  const isAI = role === "ai";
  const [showWhy, setShowWhy] = useState(false);

  const formattedTime = timestamp
    ? (() => { try { return format(new Date(timestamp), "h:mm a"); } catch { return ""; } })()
    : "";

  return (
    <div className={cn("group flex gap-3 max-w-3xl mx-auto", !isAI && "flex-row-reverse")}>
      {/* Avatar — the AI presents as an advisor, not a bot */}
      <div className={cn(
        "h-7 w-7 rounded-full flex items-center justify-center shrink-0 mt-0.5",
        isAI
          ? "bg-gradient-to-br from-teal to-teal/70 text-teal-foreground shadow-sm"
          : "bg-muted"
      )}>
        {isAI
          ? <Sparkles className="h-3.5 w-3.5" />
          : <User className="h-3.5 w-3.5 text-muted-foreground" />}
      </div>

      {/* Bubble */}
      <div className={cn("flex-1 min-w-0", !isAI && "flex flex-col items-end")}>
        {/* A correction replaces an earlier answer — say so, and keep the
            replaced text one hover away */}
        {!isAI && correctionOf && (
          <p
            className="mb-1 px-1 inline-flex items-center gap-1 text-[10px] font-medium text-teal"
            title={`Replaces: ${correctionOf.content}`}
            data-testid="label-corrected-answer"
          >
            <CornerUpLeft className="h-2.5 w-2.5" />
            Corrected answer
          </p>
        )}
        <div className={cn(
          "rounded-xl px-4 py-3 text-sm leading-relaxed transition-opacity",
          isAI
            ? "bg-card border border-border text-foreground"
            : "bg-teal/10 border border-teal/15 text-foreground",
          superseded && "opacity-60",
          isEditing && "ring-1 ring-teal/50"
        )}>
          {content.split("\n").map((line, i) => (
            <p key={i} className={cn(i > 0 && "mt-2")}>{line}</p>
          ))}
        </div>

        {/* Why we ask this — reveals the buyer-rationale on demand */}
        {isAI && whyItMatters && (
          <div className="mt-1.5">
            <button
              onClick={() => setShowWhy((v) => !v)}
              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground/70 hover:text-teal transition-colors px-1"
              data-testid="button-why-we-ask"
            >
              {showWhy
                ? <ChevronUp className="h-3 w-3" />
                : <HelpCircle className="h-3 w-3" />}
              Why we ask this
            </button>
            {showWhy && (
              <p className="mt-1 ml-1 pl-3 border-l-2 border-teal/30 text-xs text-muted-foreground leading-relaxed max-w-prose">
                {whyItMatters}
              </p>
            )}
          </div>
        )}

        <div className={cn("flex items-center gap-2 mt-1 px-1", !isAI && "flex-row-reverse")}>
          {formattedTime && (
            <p className="text-[10px] text-muted-foreground/50">{formattedTime}</p>
          )}
          {!isAI && superseded && (
            <span className="text-[10px] text-muted-foreground/50" data-testid="label-superseded-answer">
              Corrected below
            </span>
          )}
          {!isAI && isEditing && (
            <span className="inline-flex items-center gap-1 text-[10px] text-teal" data-testid="label-editing-answer">
              <Pencil className="h-2.5 w-2.5" />
              Editing
            </span>
          )}
          {/* Edit — lets the seller correct an earlier answer; the re-send is
              flagged as a correction so the agent updates the earlier fact */}
          {!isAI && onEdit && !isEditing && !superseded && (
            <button
              onClick={onEdit}
              className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/0 group-hover:text-muted-foreground/60 hover:!text-teal transition-colors"
              title="Correct this answer"
              data-testid="button-edit-answer"
            >
              <Pencil className="h-2.5 w-2.5" />
              Edit
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
