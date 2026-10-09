/**
 * SellerProgress — "Here's your status" page for sellers.
 *
 * Route: /seller/:token/progress (rendered inside SellerLayout)
 * Shows current step with CTA, completed sections, what's coming next,
 * broker contact info, and estimated time remaining.
 */
import { useState } from "react";
import { useParams, Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  BookOpenCheck,
  ListTodo,
  Search,
  ShieldQuestion,
  Check,
  ChevronRight,
  Clock,
  FileText,
  Mail,
  MessageSquare,
  Pencil,
  PlayCircle,
  RefreshCw,
  Upload,
  Video,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SellerOnboarding } from "@/components/seller/SellerOnboarding";

interface ProgressStep {
  id: string;
  label: string;
  status: "completed" | "current" | "upcoming";
  pct?: number;
}

/** A CIM section of the seller's checklist: how many of its data points are on file (never a value). */
interface Section {
  key: string;
  title: string;
  onFile: number;
  items: number;
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
    /** Importance-weighted quality of the CIM with what's known so far. */
    readiness?: { score: number; label: string; summary: string };
  };
  documents: {
    requiredTotal: number;
    requiredUploaded: number;
    percentage: number;
    totalUploaded: number;
  };
  /** Intake pages saved (Business Basics, Systems, Key People). */
  intake?: { status: "not_started" | "in_progress" | "complete"; pagesDone: number; pagesTotal: number };
  /** What the conversation asked them to do: documents to upload, things to look up. */
  todo?: Array<{ id: string; kind: "document" | "follow_up"; title: string }>;
  /** Questions the broker sent back after the conversation ended. */
  followUpQuestions?: number;
  /** The CIM waiting for their review (shared/seller-portal sellerReviewStage). */
  cimReview?: { stage: "not_ready" | "content" | "design" | "waiting" | "approved"; canApprove?: boolean };
  pendingApprovals: number;
  /** Buyer questions whose answer waits on the seller — each with its review link. */
  pendingApprovalItems?: Array<{ id: string; question: string; href: string }>;
  broker: { name: string; email: string | null } | null;
}

/** To-dos shown before "Show all". */
const TODO_VISIBLE = 4;

const TIME_ESTIMATES: Record<string, string> = {
  intake: "~10 minutes",
  interview: "~15 minutes",
  documents: "~5 minutes",
  review: "~2 minutes",
};

export default function SellerProgress() {
  const { token } = useParams<{ token: string }>();
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showAllTodo, setShowAllTodo] = useState(false);

  const { data, isLoading, error, refetch, isFetching } = useQuery<SellerProgressData>({
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

  if (!token || error || !data) {
    // A 404 means the token is unknown or has been revoked/regenerated —
    // refreshing cannot help, the seller needs a new link from their broker.
    const isInvalidLink =
      !token || (error instanceof Error && /^404:/.test(error.message));
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <div className="rounded-lg border border-border bg-card p-8 text-center space-y-3">
          <AlertCircle className="h-8 w-8 mx-auto text-destructive/70" />
          {isInvalidLink ? (
            <>
              <h2 className="text-lg font-semibold">Invalid invite link</h2>
              <p className="text-sm text-muted-foreground">
                This invite link is not valid or has expired. Contact your broker for a new link.
              </p>
            </>
          ) : (
            <>
              <h2 className="text-lg font-semibold">Couldn't load your progress</h2>
              <p className="text-sm text-muted-foreground">
                {error instanceof Error
                  ? error.message.replace(/^\d{3}:\s*/, "")
                  : "Something went wrong while loading. Please try again."}
              </p>
              <Button
                variant="outline"
                size="sm"
                disabled={isFetching}
                onClick={() => refetch()}
                data-testid="button-retry-progress"
              >
                <RefreshCw className={`h-3.5 w-3.5 mr-2 ${isFetching ? "animate-spin" : ""}`} />
                Try again
              </Button>
            </>
          )}
        </div>
      </div>
    );
  }

  const { currentStep, steps, interview, documents, pendingApprovals, broker } = data;
  // Business Basics / Systems / Key People stay editable after intake — the
  // intake page redirects completed sellers to progress unless ?edit=1.
  const intakeComplete =
    steps.some((s) => s.id === "intake" && s.status === "completed") || currentStep !== "intake";
  const overallPct = Math.round(
    steps.reduce((sum, s) => sum + (s.status === "completed" ? 100 : (s.pct || 0)), 0) / steps.length,
  );

  if (showOnboarding) {
    return (
      <SellerOnboarding
        token={token!}
        replay
        onComplete={() => setShowOnboarding(false)}
      />
    );
  }

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

      {/* Things waiting on the seller right now, whatever step they're on */}
      {/* Only the owner's link signs off (an accountant's or attorney's link doesn't get the call to action). */}
      {(data.cimReview?.stage === "content" || data.cimReview?.stage === "design") && data.cimReview.canApprove !== false && (
        <CTACard
          title={data.cimReview.stage === "design" ? "Your CIM is ready for your sign-off" : "Your CIM is ready for your review"}
          description="Read the document buyers will see about your business, then approve it or tell your broker what should change. Nothing goes to buyers until you've signed off."
          icon={BookOpenCheck}
          buttonLabel="Review your CIM"
          href={`/seller/${token}/review`}
          testId="cta-cim-review"
        />
      )}
      {(data.followUpQuestions ?? 0) > 0 && (
        <CTACard
          title={`Your broker has ${data.followUpQuestions === 1 ? "a follow-up question" : `${data.followUpQuestions} follow-up questions`} for you`}
          description="A short conversation that picks up where you left off — nothing you already answered is asked again."
          icon={MessageSquare}
          buttonLabel="Answer now"
          href={`/seller/${token}/interview?followup=1`}
          testId="cta-follow-up-questions"
        />
      )}
      {(data.pendingApprovalItems?.length ?? 0) > 0 && (
        <div className="rounded-lg border border-teal/30 bg-teal/5 p-5" data-testid="card-pending-approvals">
          <div className="flex items-start gap-3">
            <div className="h-10 w-10 rounded-lg bg-teal/15 flex items-center justify-center shrink-0">
              <ShieldQuestion className="h-5 w-5 text-teal" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="font-medium">
                {data.pendingApprovalItems!.length === 1
                  ? "A buyer's question needs your OK"
                  : `${data.pendingApprovalItems!.length} buyer questions need your OK`}
              </h3>
              <p className="text-sm text-muted-foreground mt-1">
                Your broker drafted the answers. Check each one before it goes to the buyer.
              </p>
              <ul className="mt-3 space-y-2">
                {data.pendingApprovalItems!.map((q) => (
                  <li key={q.id} className="flex flex-col gap-2 rounded-md border border-border bg-card p-3 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-sm min-w-0 break-words">“{q.question}”</p>
                    <Button asChild size="sm" className="shrink-0 bg-teal text-teal-foreground hover:bg-teal/90" data-testid={`button-review-answer-${q.id}`}>
                      <a href={q.href}>Review answer</a>
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* Current step CTA */}
      {currentStep === "intake" && (
        <CTACard
          title={data.intake?.status === "in_progress" ? "Finish your business information" : "Complete your business information"}
          description={
            data.intake?.status === "in_progress"
              ? `${data.intake.pagesDone} of ${data.intake.pagesTotal} pages saved. Finish your systems and key people — it takes a few minutes.`
              : "Tell us about your business basics, systems, and team. This takes about 10 minutes."
          }
          icon={FileText}
          buttonLabel={data.intake?.status === "in_progress" ? "Continue where you left off" : "Continue Setup"}
          href={`/seller/${token}`}
        />
      )}
      <SellerCallBanner token={token!} />
      {currentStep === "interview" && (
        <CTACard
          title={interview.hasActiveSession ? "Continue your Business Overview" : "Start your Business Overview"}
          description={`Our AI advisor will chat with you about your business to build a complete profile. ${interview.percentage}% of the information collected so far${interview.readiness ? ` — quality: ${interview.readiness.label}.` : "."}`}
          icon={MessageSquare}
          buttonLabel={interview.hasActiveSession ? "Continue Overview" : "Start Overview"}
          href={`/seller/${token}/interview`}
        />
      )}
      {currentStep === "documents" && (
        <CTACard
          title="Upload your documents"
          description={`${documents.requiredUploaded} of ${documents.requiredTotal} required documents uploaded. Upload the rest — or tell your broker which ones you don't have.`}
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
              <h3 className="font-medium">{(data.todo?.length ?? 0) > 0 || (data.pendingApprovalItems?.length ?? 0) > 0 ? "Nearly there" : "Everything looks good"}</h3>
              <p className="text-sm text-muted-foreground mt-1">
                {data.cimReview?.stage === "approved"
                  ? "You've signed off your CIM. Your broker takes it from here."
                  : data.cimReview?.stage === "waiting"
                    ? "You approved the CIM content. Your broker is finishing the design and will send it back for your sign-off."
                    : "Your broker is reviewing your information and drafting your CIM. You'll be notified when it's ready for you to read."}
                {((data.todo?.length ?? 0) > 0 || (data.pendingApprovalItems?.length ?? 0) > 0) && " Meanwhile, a few things below still need you."}
                {pendingApprovals > 0 && !(data.pendingApprovalItems?.length) && (
                  <span className="block mt-2 text-teal">
                    You have {pendingApprovals} pending {pendingApprovals === 1 ? "approval" : "approvals"} — use the link in your email to review.
                  </span>
                )}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* The interview's to-dos: what it promised to "note so it doesn't get lost" */}
      {(data.todo?.length ?? 0) > 0 && (
        <div className="rounded-lg border border-border bg-card p-5" data-testid="card-seller-todo">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-medium flex items-center gap-2">
              <ListTodo className="h-4 w-4 text-teal" /> Your to-do
            </h2>
            <span className="text-xs text-muted-foreground tabular-nums">{data.todo!.length}</span>
          </div>
          <p className="text-xs text-muted-foreground mt-1">From your conversation — things you offered to send or look up.</p>
          <ul className="mt-3 divide-y divide-border">
            {(showAllTodo ? data.todo! : data.todo!.slice(0, TODO_VISIBLE)).map((t) => (
              <li key={t.id} className="py-2.5 flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-2 min-w-0">
                  {t.kind === "document" ? (
                    <Upload className="h-3.5 w-3.5 mt-0.5 text-muted-foreground shrink-0" />
                  ) : (
                    <Search className="h-3.5 w-3.5 mt-0.5 text-muted-foreground shrink-0" />
                  )}
                  <span className="text-sm break-words">{t.title}</span>
                </div>
                <Link href={t.kind === "document" ? `/seller/${token}/documents` : `/seller/${token}/interview`}>
                  <span className="text-xs text-teal hover:underline cursor-pointer shrink-0 pl-5 sm:pl-0">
                    {t.kind === "document" ? "Upload" : "Answer in your overview"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {data.todo!.length > TODO_VISIBLE && (
            <button
              type="button"
              className="mt-1 text-xs text-teal hover:underline"
              onClick={() => setShowAllTodo((v) => !v)}
            >
              {showAllTodo ? "Show fewer" : `Show all ${data.todo!.length}`}
            </button>
          )}
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

            {/* Conversation section detail: "x of y on file" per CIM section (no values) */}
            {step.id === "interview" && step.status === "current" && interview.sections.length > 0 && (
              <div className="mt-3 pl-9 space-y-2" data-testid="seller-progress-sections">
                <p className="text-xs text-muted-foreground"><span className="text-foreground font-medium">{interview.percentage}% collected</span>{interview.readiness ? ` · quality: ${interview.readiness.label}` : ""}</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5">
                  {interview.sections.map((s) => {
                    const done = s.items > 0 && s.onFile >= s.items;
                    return (
                      <div key={s.key} className="flex items-center gap-1.5 min-w-0">
                        {done ? (
                          <Check className="h-3 w-3 text-teal shrink-0" />
                        ) : s.onFile > 0 ? (
                          <div className="h-3 w-3 rounded-full border border-teal/60 shrink-0" style={{ background: `conic-gradient(hsl(var(--teal)) 0 ${Math.round((s.onFile / Math.max(1, s.items)) * 100)}%, transparent 0)` }} />
                        ) : (
                          <div className="h-3 w-3 rounded-full border border-border shrink-0" />
                        )}
                        <span className="text-xs text-muted-foreground truncate flex-1 min-w-0">{s.title}</span>
                        <span className="text-[11px] text-muted-foreground/80 tabular-nums shrink-0">{s.onFile} of {s.items}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Quick links — conversation is always available */}
      <div className={`grid grid-cols-2 gap-3 ${intakeComplete ? "sm:grid-cols-3" : ""}`}>
        <Link href={`/seller/${token}/interview`}>
          <div className="rounded-lg border border-border bg-card p-4 hover:border-teal/30 transition-colors cursor-pointer group">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <MessageSquare className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm">
                  {interview.completed
                    ? "Add or update details"
                    : interview.hasActiveSession
                      ? "Continue overview"
                      : "Start overview"}
                </span>
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
        {intakeComplete && (
          <Link href={`/seller/${token}?edit=1`}>
            <div
              className="rounded-lg border border-border bg-card p-4 hover:border-teal/30 transition-colors cursor-pointer group"
              data-testid="link-edit-business-details"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Pencil className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm">Edit business details</span>
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground/30 group-hover:text-teal/50" />
              </div>
            </div>
          </Link>
        )}
      </div>

      {/* Replay introduction */}
      <button
        onClick={() => setShowOnboarding(true)}
        className="flex items-center gap-2 text-xs text-muted-foreground hover:text-teal transition-colors"
      >
        <PlayCircle className="h-3.5 w-3.5" />
        Replay introduction
      </button>

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
  testId,
}: {
  title: string;
  description: string;
  icon: typeof FileText;
  buttonLabel: string;
  href: string;
  testId?: string;
}) {
  return (
    <Link href={href} className="block">
      <div className="rounded-lg border border-teal/30 bg-teal/5 p-5 hover:bg-teal/8 transition-colors cursor-pointer group" data-testid={testId} aria-label={buttonLabel}>
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


/** Shows the moment the broker opens a video call for this deal. */
function SellerCallBanner({ token }: { token: string }) {
  const [, navigate] = useLocation();
  const { data } = useQuery<{ active: boolean }>({
    queryKey: ["/api/seller", token, "call"],
    queryFn: async () => (await fetch(`/api/seller/${token}/call`)).json(),
    refetchInterval: 10000,
  });
  if (!data?.active) return null;
  return (
    <div className="rounded-lg border border-teal/40 bg-teal/10 p-4 flex items-center justify-between gap-3" data-testid="seller-call-banner">
      <div className="flex items-center gap-3">
        <Video className="h-5 w-5 text-teal shrink-0" />
        <div>
          <p className="text-sm font-medium">Your broker is in the video call</p>
          <p className="text-xs text-muted-foreground">Join to go through your Business Overview together.</p>
        </div>
      </div>
      <Button size="sm" className="bg-teal text-teal-foreground hover:bg-teal/90 shrink-0" onClick={() => navigate(`/seller/${token}/call`)}>
        Join the call
      </Button>
    </div>
  );
}
