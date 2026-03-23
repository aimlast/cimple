import { cn } from "@/lib/utils";
import { Bot, User } from "lucide-react";

interface ChatMessageProps {
  role: "ai" | "user";
  content: string;
  timestamp?: string;
}

export function ChatMessage({ role, content, timestamp }: ChatMessageProps) {
  return (
    <div
      className={cn(
        "flex gap-3 max-w-3xl mx-auto",
        role === "user" && "flex-row-reverse"
      )}
    >
      <div
        className={cn(
          "h-8 w-8 rounded-full flex items-center justify-center flex-shrink-0",
          role === "ai" ? "bg-primary text-primary-foreground" : "bg-muted"
        )}
      >
        {role === "ai" ? (
          <Bot className="h-4 w-4" />
        ) : (
          <User className="h-4 w-4" />
        )}
      </div>
      <div className={cn("flex-1", role === "user" && "flex flex-col items-end")}>
        <div
          className={cn(
            "rounded-lg px-4 py-3",
            role === "ai"
              ? "bg-card border border-card-border"
              : "bg-primary/10 border border-primary/20"
          )}
        >
          <p className="text-sm">{content}</p>
        </div>
        {timestamp && (
          <p className="text-xs text-muted-foreground mt-1">{timestamp}</p>
        )}
      </div>
    </div>
  );
}
