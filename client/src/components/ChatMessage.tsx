import { cn } from "@/lib/utils";
import { Bot, User } from "lucide-react";
import { format } from "date-fns";

interface ChatMessageProps {
  role: "ai" | "user";
  content: string;
  timestamp?: string;
}

export function ChatMessage({ role, content, timestamp }: ChatMessageProps) {
  const isAI = role === "ai";

  const formattedTime = timestamp
    ? (() => { try { return format(new Date(timestamp), "h:mm a"); } catch { return ""; } })()
    : "";

  return (
    <div className={cn("flex gap-3 max-w-3xl mx-auto", !isAI && "flex-row-reverse")}>
      {/* Avatar */}
      <div className={cn(
        "h-7 w-7 rounded-full flex items-center justify-center shrink-0 mt-0.5",
        isAI ? "bg-teal text-teal-foreground" : "bg-muted"
      )}>
        {isAI
          ? <Bot className="h-3.5 w-3.5" />
          : <User className="h-3.5 w-3.5 text-muted-foreground" />}
      </div>

      {/* Bubble */}
      <div className={cn("flex-1 min-w-0", !isAI && "flex flex-col items-end")}>
        <div className={cn(
          "rounded-xl px-4 py-3 text-sm leading-relaxed",
          isAI
            ? "bg-card border border-border text-foreground"
            : "bg-teal/10 border border-teal/15 text-foreground"
        )}>
          {content.split("\n").map((line, i) => (
            <p key={i} className={cn(i > 0 && "mt-2")}>{line}</p>
          ))}
        </div>
        {formattedTime && (
          <p className="text-[10px] text-muted-foreground/50 mt-1 px-1">{formattedTime}</p>
        )}
      </div>
    </div>
  );
}
