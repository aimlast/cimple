import { Check, Circle } from "lucide-react";
import { cn } from "@/lib/utils";

interface Step {
  id: string;
  title: string;
  status: "completed" | "current" | "pending";
}

interface ProgressTrackerProps {
  steps: Step[];
}

export function ProgressTracker({ steps }: ProgressTrackerProps) {
  return (
    <div className="space-y-4">
      {steps.map((step, index) => (
        <div key={step.id} className="flex gap-4">
          <div className="flex flex-col items-center">
            <div
              className={cn(
                "h-8 w-8 rounded-full flex items-center justify-center border-2",
                step.status === "completed" &&
                  "bg-primary border-primary text-primary-foreground",
                step.status === "current" &&
                  "border-primary text-primary bg-background",
                step.status === "pending" &&
                  "border-muted-foreground/30 text-muted-foreground"
              )}
            >
              {step.status === "completed" ? (
                <Check className="h-4 w-4" />
              ) : (
                <Circle className="h-3 w-3 fill-current" />
              )}
            </div>
            {index < steps.length - 1 && (
              <div
                className={cn(
                  "w-0.5 h-12 mt-1",
                  step.status === "completed"
                    ? "bg-primary"
                    : "bg-muted-foreground/20"
                )}
              />
            )}
          </div>
          <div className="flex-1 pt-1">
            <p
              className={cn(
                "text-sm font-medium",
                step.status === "completed" && "text-foreground",
                step.status === "current" && "text-primary font-semibold",
                step.status === "pending" && "text-muted-foreground"
              )}
            >
              {step.title}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}
