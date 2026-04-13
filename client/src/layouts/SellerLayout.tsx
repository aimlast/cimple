/**
 * SellerLayout — Layout wrapper for seller-facing pages.
 *
 * Provides a top bar with Cimple wordmark, deal name, and a stepped
 * progress indicator reflecting real completion state.
 *
 * All seller routes under /seller/:token/* render inside this layout,
 * EXCEPT /seller/:token/interview which is fullscreen (handled by
 * FullscreenLayout in App.tsx).
 */
import { Switch, Route, useLocation, Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useSetLayoutRole } from "@/contexts/RoleContext";
import { Check } from "lucide-react";
import SellerIntake from "@/pages/seller/SellerIntake";
import SellerProgress from "@/pages/seller/SellerProgress";
import SellerDocuments from "@/pages/seller/SellerDocuments";
import NotFound from "@/pages/not-found";

interface ProgressStep {
  id: string;
  label: string;
  status: "completed" | "current" | "upcoming";
  pct?: number;
}

interface SellerProgressData {
  businessName: string;
  currentStep: string;
  steps: ProgressStep[];
}

export default function SellerLayout() {
  useSetLayoutRole("seller");
  const [loc] = useLocation();

  // Extract token from /seller/:token or /seller/:token/sub-path
  const token = loc.match(/^\/seller\/([^/]+)/)?.[1] ?? null;

  // Invite data for deal name (fast, cached)
  const { data: inviteData } = useQuery<{ invite: any; deal: any }>({
    queryKey: ["/api/invites", token],
    enabled: !!token,
  });

  // Real progress data
  const { data: progress } = useQuery<SellerProgressData>({
    queryKey: [`/api/seller/${token}/progress`],
    enabled: !!token,
    refetchInterval: 30_000,
  });

  const businessName = progress?.businessName || inviteData?.deal?.businessName;
  const steps = progress?.steps;

  return (
    <div className="h-screen w-full flex flex-col bg-background overflow-hidden">
      {/* Top bar with progress */}
      <div className="border-b border-border bg-card/50 px-4 py-2.5 shrink-0">
        <div className="flex items-center justify-between max-w-5xl mx-auto">
          {/* Left: branding + deal name */}
          <div className="flex items-center gap-3 min-w-0">
            <Link href={`/seller/${token}/progress`}>
              <div
                role="img"
                aria-label="Cimple"
                className="h-4 w-16 cursor-pointer hover:opacity-80 transition-opacity"
                style={{
                  backgroundColor: "hsl(162, 65%, 38%)",
                  WebkitMaskImage: "url('/cimple-text.png')",
                  WebkitMaskSize: "contain",
                  WebkitMaskRepeat: "no-repeat",
                  maskImage: "url('/cimple-text.png')",
                  maskSize: "contain",
                  maskRepeat: "no-repeat",
                }}
              />
            </Link>
            {businessName && (
              <>
                <span className="text-muted-foreground/30">·</span>
                <span className="text-sm text-muted-foreground truncate">
                  {businessName}
                </span>
              </>
            )}
          </div>

          {/* Right: stepped progress */}
          {steps && steps.length > 0 && (
            <div className="hidden sm:flex items-center gap-1">
              {steps.map((step, i) => (
                <div key={step.id} className="flex items-center">
                  {i > 0 && (
                    <div
                      className={`w-6 h-px mx-1 ${
                        step.status === "completed" || step.status === "current"
                          ? "bg-teal/40"
                          : "bg-border"
                      }`}
                    />
                  )}
                  <div className="flex items-center gap-1.5">
                    {step.status === "completed" ? (
                      <div className="h-5 w-5 rounded-full bg-teal/15 flex items-center justify-center">
                        <Check className="h-3 w-3 text-teal" />
                      </div>
                    ) : step.status === "current" ? (
                      <div className="h-5 w-5 rounded-full border-2 border-teal flex items-center justify-center">
                        <div className="h-2 w-2 rounded-full bg-teal" />
                      </div>
                    ) : (
                      <div className="h-5 w-5 rounded-full border border-border" />
                    )}
                    <span
                      className={`text-xs ${
                        step.status === "current"
                          ? "text-foreground font-medium"
                          : step.status === "completed"
                            ? "text-teal/70"
                            : "text-muted-foreground/50"
                      }`}
                    >
                      {step.label}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        <Switch>
          <Route path="/seller/:token" component={SellerIntake} />
          <Route path="/seller/:token/progress" component={SellerProgress} />
          <Route path="/seller/:token/documents" component={SellerDocuments} />
          <Route component={NotFound} />
        </Switch>
      </div>
    </div>
  );
}
