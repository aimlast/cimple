/**
 * SellerProgress — "Here's your status" page for sellers.
 *
 * Route: /seller/:token/progress (rendered inside SellerLayout)
 * Shows current step with CTA, completed sections, what's coming next,
 * broker contact info, and estimated time remaining.
 */
import { useParams, Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  Check,
  ChevronRight,
  Clock,
  FileText,
  Mail,
  MessageSquare,
  Upload,
} from "lucide-react";

interface ProgressStep {
  id: string;
  label: string;
  status: "completed" | "current" | "upcoming";
  pct?: number;
}

interface Section {
  key: string;
  title: string;
  status: "well_covered" | "partial" | "missing";
}

interface SellerProgressData {
  businessName: string;
  industry: string;
  currentStep: string;
  steps: ProgressStep[];
  interview: {
    completed: boolean;
    hasActiveSession: boolean;
    percentage: number;
    sections: Section[];
  };
  documents: {
    requiredTotal: number;
    requiredUploaded: number;
    percentage: number;
    totalUploaded: number;
  };
  pendingApprovals: number;
  broker: { name: string; email: string | null } | null;
}

const TIME_ESTIMATES: Record<string, string> = {
  intake: "~10 minutes",
  interview: "~15 minutes",
  documents: "~5 minutes",
  review: "~2 minutes",
};

export default function SellerProgress() {
  const { token } = useParams<{ token: string }>();

  const { data, isLoading } = useQuery<SellerProgressData>({
    queryKey: [`/api/seller/${token}/progress`],
    enabled: !!token,
    refetchInterval: 30_000,
  });

  if (isLoading) {
    return (
      <div className="p-6 max-w-3xl mx-auto space-y-6">
        <div className="h-8 w-48 bg-muted animate-pulse rounded" />
        <div className="h-32 bg-muted animate-pulse rounded-lg" />
        <div className="h-48 bg-muted animate-pulse rounded-lg" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <p className="text-muted-foreground">Unable to load your progress. Please try refreshing.</p>
      </div>
    );
  }

  const { currentStep, steps, interview, documents, pendingApprovals, broker } = data;
  const overallPct = Math.round(
    steps.reduce((sum, s) => sum + (s.status === "completed" ? 100 : (s.pct || 0)), 0) / steps.length,
  );

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Your Progress</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {data.businessName} — {data.industry}
        </p>
      </div>

      {/* Overall progress bar */}
      <div className="rounded-lg border border-border bg-card p-5">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium">{overallPct}% complete</span>
          {currentStep !== "review" && (
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {TIME_ESTIMATES[currentStep]} remaining for this step
            </span>
          )}
        </div>
        <div className="h-2 bg-muted rounded-full overflow-hidden">
          <div
            className="h-full bg-teal rounded-full transition-all duration-500"
            style={{ width: `${overallPct}%` }}
          />
        </div>
      </div>

      {/* Current step CTA */}
      {currentStep === "intake" && (
        <CTACard
          title="Complete your business information"
          description="Tell us about your business basics, systems, and team. This takes about 10 minutes."
          icon={FileText}
          buttonLabel="Continue Setup"
          href={`/seller/${token}`}
        />
      )}
      {currentStep === "interview" && (
        <CTACard
          title={interview.hasActiveSession ? "Continue your interview" : "Start your interview"}
          description={`Our AI advisor will ask about your business to build a complete profile. ${interview.percentage}% of sections covered so far.`}
          icon={MessageSquare}
          buttonLabel={interview.hasActiveSession ? "Continue Interview" : "Start Interview"}
          href={`/seller/${token}/interview`}
        />
      )}
      {currentStep === "documents" && (
        <CTACard
          title="Upload your documents"
          description={`${documents.requiredUploaded} of ${documents.requiredTotal} required documents uploaded. Upload the rest to move forward.`}
          icon={Upload}
          buttonLabel="Upload Documents"
          href={`/seller/${token}/documents`}
        />
      )}
      {currentStep === "review" && (
        <div className="rounded-lg border border-teal/30 bg-teal/5 p-5">
          <div className="flex items-start gap-3">
            <Check className="h-5 w-5 text-teal mt-0.5" />
            <div>
              <h3 className="font-medium">Everything looks good</h3>
              <p className="text-sm text-muted-foreground mt-1">
                Your broker is reviewing your information. You'll be notified if anything else is needed.
                {pendingApprovals > 0 && (
                  <span className="block mt-2 text-teal">
                    You have {pendingApprovals} pending {pendingApprovals === 1 ? "approval" : "approvals"} to review.
                  </span>
                )}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Steps detail */}
      <div className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Steps</h2>
        {steps.map((step) => (
          <div
            key={step.id}
            className={`rounded-lg border p-4 ${
              step.status === "current"
                ? "border-teal/30 bg-teal/5"
                : step.status === "completed"
                  ? "border-border bg-card"
                  : "border-border/50 bg-card/50"
            }`}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                {step.status === "completed" ? (
                  <div className="h-6 w-6 rounded-full bg-teal/15 flex items-center justify-center">
                    <Check className="h-3.5 w-3.5 text-teal" />
                  </div>
                ) : step.status === "current" ? (
                  <div className="h-6 w-6 rounded-full border-2 border-teal flex items-center justify-center">
                    <div className="h-2.5 w-2.5 rounded-full bg-teal" />
                  </div>
                ) : (
                  <div className="h-6 w-6 rounded-full border border-border/50" />
                )}
                <span
                  className={`text-sm ${
                    step.status === "current"
                      ? "font-medium"
                      : step.status === "upcoming"
                        ? "text-muted-foreground/60"
                        : ""
                  }`}
                >
                  {step.label}
                </span>
              </div>
              {step.status === "completed" && (
                <span className="text-xs text-teal/70">Done</span>
              )}
              {step.status === "current" && step.pct !== undefined && (
                <span className="text-xs text-muted-foreground">{step.pct}%</span>
              )}
            </div>

            {/* Interview section detail */}
            {step.id === "interview" && step.status === "current" && interview.sections.length > 0 && (
              <div className="mt-3 pl-9 grid grid-cols-2 gap-1.5">
                {interview.sections.map((s) => (
                  <div key={s.key} className="flex items-center gap-1.5">
                    {s.status === "well_covered" ? (
                      <Check className="h-3 w-3 text-teal shrink-0" />
                    ) : s.status === "partial" ? (
                      <div className="h-3 w-3 rounded-full border border-amber-400 shrink-0" />
                    ) : (
                      <div className="h-3 w-3 rounded-full border border-border shrink-0" />
                    )}
                    <span className="text-xs text-muted-foreground truncate">{s.title}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Quick links */}
      <div className="grid grid-cols-2 gap-3">
        <Link href={`/seller/${token}/interview`}>
          <div className="rounded-lg border border-border bg-card p-4 hover:border-teal/30 transition-colors cursor-pointer group">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <MessageSquare className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm">Interview</span>
              </div>
              <ChevronRight className="h-4 w-4 text-muted-foreground/30 group-hover:text-teal/50" />
            </div>
          </div>
        </Link>
        <Link href={`/seller/${token}/documents`}>
          <div className="rounded-lg border border-border bg-card p-4 hover:border-teal/30 transition-colors cursor-pointer group">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Upload className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm">Documents</span>
              </div>
              <ChevronRight className="h-4 w-4 text-muted-foreground/30 group-hover:text-teal/50" />
            </div>
          </div>
        </Link>
      </div>

      {/* Broker contact */}
      {broker && (
        <div className="rounded-lg border border-border bg-card/50 p-4">
          <p className="text-xs text-muted-foreground uppercase tracking-wide mb-2">Your broker</p>
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-full bg-teal/10 flex items-center justify-center">
              <span className="text-xs font-medium text-teal">
                {broker.name.charAt(0).toUpperCase()}
              </span>
            </div>
            <div>
              <p className="text-sm font-medium">{broker.name}</p>
              {broker.email && (
                <a
                  href={`mailto:${broker.email}`}
                  className="text-xs text-muted-foreground hover:text-teal flex items-center gap-1"
                >
                  <Mail className="h-3 w-3" />
                  {broker.email}
                </a>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CTACard({
  title,
  description,
  icon: Icon,
  buttonLabel,
  href,
}: {
  title: string;
  description: string;
  icon: typeof FileText;
  buttonLabel: string;
  href: string;
}) {
  return (
    <Link href={href}>
      <div className="rounded-lg border border-teal/30 bg-teal/5 p-5 hover:bg-teal/8 transition-colors cursor-pointer group">
        <div className="flex items-start gap-4">
          <div className="h-10 w-10 rounded-lg bg-teal/15 flex items-center justify-center shrink-0">
            <Icon className="h-5 w-5 text-teal" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-medium">{title}</h3>
            <p className="text-sm text-muted-foreground mt-1">{description}</p>
          </div>
          <ChevronRight className="h-5 w-5 text-teal/40 group-hover:text-teal mt-1 shrink-0" />
        </div>
      </div>
    </Link>
  );
}
