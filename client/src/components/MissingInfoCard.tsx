import { AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

interface MissingInfoCardProps {
  field: string;
  description: string;
  status: "pending" | "ai_attempting" | "review_needed";
  onAuthorizeSkip?: () => void;
  onRetry?: () => void;
}

export function MissingInfoCard({
  field,
  description,
  status,
  onAuthorizeSkip,
  onRetry,
}: MissingInfoCardProps) {
  return (
    <Card className="border-warning/30 bg-warning/5">
      <CardContent className="p-4">
        <div className="flex gap-3">
          <div className="flex-shrink-0">
            {status === "ai_attempting" ? (
              <Loader2 className="h-5 w-5 text-warning animate-spin" />
            ) : (
              <AlertTriangle className="h-5 w-5 text-warning" />
            )}
          </div>
          <div className="flex-1 space-y-2">
            <div>
              <h4 className="text-sm font-semibold">{field}</h4>
              <p className="text-sm text-muted-foreground mt-1">
                {description}
              </p>
            </div>
            {status === "ai_attempting" && (
              <p className="text-xs text-warning">
                AI is attempting to gather this information...
              </p>
            )}
            {status === "review_needed" && (
              <div className="flex gap-2 flex-wrap">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={onRetry}
                  data-testid="button-retry"
                >
                  Retry Collection
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={onAuthorizeSkip}
                  data-testid="button-skip"
                >
                  Authorize Skip
                </Button>
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
