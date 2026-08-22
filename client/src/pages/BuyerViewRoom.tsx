/**
 * BuyerViewRoom
 *
 * Buyer-facing CIM viewer. Renders all CimSections in sequence via
 * CimSectionRenderer. Tracks analytics: section enter/exit, heat map,
 * scroll depth — batched and flushed every 8 seconds.
 *
 * Falls back to legacy cimContent text if no AI sections exist yet.
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { useParams } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Building, Clock, Lock, AlertCircle, FileText,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Deal, CimSection, BrandingSettings, BuyerQuestion } from "@shared/schema";
import { CIM_SECTIONS } from "@shared/schema";
import { buildBranding } from "@/components/cim/CimBrandingContext";
import { StickyNav } from "@/components/cim/StickyNav";
import { ExpandableSection } from "@/components/cim/ExpandableSection";
import { SectionBoundary } from "@/components/cim/SectionBoundary";
import { ConnectedContent } from "@/components/cim/ConnectedContent";
import { BuyerChatbot } from "@/components/buyer/BuyerChatbot";
import { BuyerDecisionPanel } from "@/components/buyer/BuyerDecisionPanel";

type BuyerDecision = "under_review" | "interested" | "not_interested" | "lapsed";

/**
 * The whitelisted access object GET /api/view/:token returns. Buyers never
 * receive the raw buyerAccess row (broker notes, match scoring, tokens).
 */
interface ViewAccess {
  id: string;
  dealId: string;
  buyerEmail: string;
  buyerName: string | null;
  accessLevel: string;
  ndaSigned: boolean | null;
  ndaSignedAt: string | null;
  canDownload: boolean | null;
  watermarkEnabled: boolean | null;
  firstViewedAt: string | null;
  viewCount: number | null;
  decision: BuyerDecision | null;
  decisionAt: string | null;
  expiresAt: string | null;
}

interface ViewData {
  access: ViewAccess;
  deal: Deal;
  sections: CimSection[];
  publishedQuestions: BuyerQuestion[];
  branding: BrandingSettings | null;
  /** True when the server is withholding CIM content until the NDA is signed */
  ndaGate?: boolean;
  /** True when the blind (redacted) version is still being prepared */
  preparing?: boolean;
}

/** Parse an error body defensively — proxies return HTML during deploys. */
async function readErrorBody(res: Response): Promise<{ error?: string }> {
  return res.json().catch(() => ({}));
}

// ── Watermark ──────────────────────────────────────────────────────────────
// Ink-colored literal (not a theme token) so it stays visible-but-subtle on
// the paper document surface in BOTH app themes.
function Watermark({ email }: { email: string }) {
  return (
    <div className="fixed inset-0 pointer-events-none z-50 overflow-hidden opacity-[0.05]">
      <div className="absolute inset-0 flex flex-wrap items-center justify-center gap-24 -rotate-45">
        {Array.from({ length: 24 }).map((_, i) => (
          <span
            key={i}
            className="text-xl font-bold whitespace-nowrap select-none"
            style={{ color: "#46423B" }}
          >
            {email}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── NDA Gate ───────────────────────────────────────────────────────────────
function NdaGate({ deal, token, onAccepted }: { deal: Deal; token: string; onAccepted: () => void }) {
  const [signing, setSigning] = useState(false);
  const [signError, setSignError] = useState<string | null>(null);

  const sign = async () => {
    setSigning(true);
    setSignError(null);
    try {
      const res = await fetch(`/api/view/${token}/sign-nda`, { method: "POST" });
      if (!res.ok) {
        const body = await readErrorBody(res);
        throw new Error(body.error || "Could not record your signature — please try again.");
      }
      // Only unlock the document once the server has actually recorded the
      // signature; otherwise the refetch would just re-render this gate.
      onAccepted();
    } catch (err) {
      setSignError(
        err instanceof Error && err.message
          ? err.message
          : "Could not record your signature — please try again.",
      );
    } finally {
      setSigning(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-background flex items-center justify-center p-6">
      <div className="max-w-lg w-full border border-border rounded-xl p-8 shadow-lg space-y-5 bg-card">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-teal/10 flex items-center justify-center">
            <Lock className="h-5 w-5 text-teal" />
          </div>
          <div>
            <h2 className="font-semibold text-base">Non-Disclosure Agreement</h2>
            <p className="text-xs text-muted-foreground">{deal.businessName} — Confidential Information Memorandum</p>
          </div>
        </div>
        <Separator />
        <p className="text-sm text-muted-foreground leading-relaxed">
          By proceeding, you agree to keep all information contained in this Confidential
          Information Memorandum strictly confidential. You agree not to disclose, reproduce, or
          use this information except for the purpose of evaluating this business opportunity.
          This agreement is legally binding.
        </p>
        <Button
          className="w-full bg-teal text-teal-foreground hover:bg-teal/90"
          onClick={sign}
          disabled={signing}
          data-testid="button-sign-nda"
        >
          {signing ? "Signing…" : "I agree — View the CIM"}
        </Button>
        {signError && (
          <div
            className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            role="alert"
            data-testid="text-nda-error"
          >
            <AlertCircle className="h-3.5 w-3.5 mt-px shrink-0" />
            <span>{signError}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Analytics hook ─────────────────────────────────────────────────────────
function useAnalytics(dealId: string | undefined, accessId: string | undefined, accessToken?: string) {
  const queueRef = useRef<object[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const enqueue = useCallback((event: object) => {
    queueRef.current.push(event);
  }, []);

  const flush = useCallback(async () => {
    if (!dealId || !accessToken || queueRef.current.length === 0) return;
    const batch = queueRef.current.splice(0);
    try {
      await fetch(`/api/deals/${dealId}/analytics/batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accessToken,
          events: batch.map(e => ({ ...e, buyerAccessId: accessId })),
        }),
      });
    } catch {
      // Non-blocking — analytics failure should never interrupt the viewer
    }
  }, [dealId, accessId, accessToken]);

  // Flush every 8 seconds + on unmount
  useEffect(() => {
    if (!dealId) return;
    flushTimerRef.current = setInterval(flush, 8000);
    return () => {
      if (flushTimerRef.current) clearInterval(flushTimerRef.current);
      flush();
    };
  }, [dealId, flush]);

  // Section enter/exit via IntersectionObserver
  const attachObserver = useCallback(() => {
    const sectionEls = document.querySelectorAll("[data-track-section]");
    if (!sectionEls.length) return;

    const enterTimes: Record<string, number> = {};

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach(entry => {
          const key = (entry.target as HTMLElement).dataset.trackSection!;
          if (entry.isIntersecting) {
            enterTimes[key] = Date.now();
            enqueue({ eventType: "section_enter", sectionKey: key });
          } else if (enterTimes[key]) {
            const timeSpentSeconds = Math.round((Date.now() - enterTimes[key]) / 1000);
            enqueue({ eventType: "section_exit", sectionKey: key, timeSpentSeconds });
            delete enterTimes[key];
          }
        });
      },
      { threshold: 0.3 }
    );

    sectionEls.forEach(el => observer.observe(el));
    return () => observer.disconnect();
  }, [enqueue]);

  // Heat map sampling — throttled to 200ms
  const heatMapThrottle = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (heatMapThrottle.current) return;
      heatMapThrottle.current = setTimeout(() => {
        heatMapThrottle.current = null;
      }, 200);
      enqueue({
        eventType: "heat_map_sample",
        heatMapX: Math.round((e.clientX / window.innerWidth) * 100),
        heatMapY: Math.round((e.clientY / window.innerHeight) * 100),
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      });
    };
    window.addEventListener("mousemove", handler, { passive: true });
    return () => window.removeEventListener("mousemove", handler);
  }, [enqueue]);

  // Scroll depth
  const lastDepth = useRef(0);
  useEffect(() => {
    const handler = () => {
      const doc = document.documentElement;
      const depth = Math.round((window.scrollY / (doc.scrollHeight - doc.clientHeight)) * 100);
      if (depth > lastDepth.current + 5) {
        lastDepth.current = depth;
        enqueue({ eventType: "scroll_depth", scrollDepthPercent: depth });
      }
    };
    window.addEventListener("scroll", handler, { passive: true });
    return () => window.removeEventListener("scroll", handler);
  }, [enqueue]);

  return { attachObserver, enqueue };
}

// ── Main component ─────────────────────────────────────────────────────────
export default function BuyerViewRoom() {
  const { token } = useParams<{ token: string }>();
  const queryClient = useQueryClient();
  const [timeOnPage, setTimeOnPage] = useState(0);
  const [localDecision, setLocalDecision] = useState<BuyerDecision | null>(null);
  const startTimeRef = useRef(Date.now());

  const { data, isLoading, error } = useQuery<ViewData>({
    queryKey: ["/api/view", token],
    enabled: !!token,
    queryFn: async () => {
      const res = await fetch(`/api/view/${token}`);
      if (!res.ok) {
        const body = await readErrorBody(res);
        throw new Error(body.error || "Access denied");
      }
      return res.json();
    },
    // While the redacted version is being prepared, poll until it's ready.
    refetchInterval: (query) =>
      (query.state.data as ViewData | undefined)?.preparing ? 4000 : false,
  });

  // The analytics endpoint authenticates every batch with the view-room
  // token — without it the server rejects the batch and nothing is recorded.
  const { attachObserver, enqueue } = useAnalytics(data?.deal?.id, data?.access?.id, token);

  // Timer
  useEffect(() => {
    const interval = setInterval(() => {
      setTimeOnPage(Math.floor((Date.now() - startTimeRef.current) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Attach section observer once sections load
  useEffect(() => {
    if (!data?.sections?.length) return;
    // Small delay for DOM to settle after render
    const timer = setTimeout(attachObserver, 500);
    return () => clearTimeout(timer);
  }, [data?.sections, attachObserver]);

  // Track initial view — once per mount, only once real content is served
  // (the NDA gate and "preparing" holding states are not views).
  const viewTracked = useRef(false);
  useEffect(() => {
    if (!data?.deal?.id || !data?.access?.id) return;
    if (data.ndaGate || data.preparing || viewTracked.current) return;
    viewTracked.current = true;
    enqueue({ eventType: "view" });
  }, [data?.deal?.id, data?.access?.id, data?.ndaGate, data?.preparing, enqueue]);

  const formatTime = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, "0")}`;

  // ── Loading / error states ────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="min-h-screen bg-background p-8 space-y-4 max-w-4xl mx-auto">
        <Skeleton className="h-12 w-48" />
        <Skeleton className="h-[500px] w-full" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <div className="max-w-sm text-center space-y-3" data-testid="view-room-error">
          <AlertCircle className="h-8 w-8 mx-auto text-destructive/60" />
          <h2 className="text-lg font-semibold">Access denied</h2>
          <p className="text-sm text-muted-foreground">
            {error instanceof Error ? error.message : "This link is invalid or has expired."}
          </p>
          <p className="text-xs text-muted-foreground/60">Contact your broker for a new access link.</p>
        </div>
      </div>
    );
  }

  const { access, deal, sections = [], publishedQuestions = [], branding: brandingSettings } = data;
  const currentDecision: BuyerDecision = localDecision || access.decision || "under_review";

  // NDA gate — the server withholds sections until the NDA is signed, so
  // after signing we refetch to receive the actual CIM content.
  if (data.ndaGate) {
    return (
      <NdaGate
        deal={deal}
        token={token!}
        onAccepted={() => queryClient.invalidateQueries({ queryKey: ["/api/view", token] })}
      />
    );
  }

  // Blind version still being prepared — show a holding state (the query is
  // polling in the background) rather than the un-redacted document.
  if (data.preparing) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <div className="max-w-sm text-center space-y-3">
          <div className="flex justify-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-teal/50 animate-bounce" />
            <span className="h-2 w-2 rounded-full bg-teal/50 animate-bounce" style={{ animationDelay: "0.15s" }} />
            <span className="h-2 w-2 rounded-full bg-teal/50 animate-bounce" style={{ animationDelay: "0.3s" }} />
          </div>
          <h2 className="text-lg font-semibold">Preparing your confidential view</h2>
          <p className="text-sm text-muted-foreground">
            We're finalizing the secure version of this document. This only
            takes a moment — it will open automatically.
          </p>
        </div>
      </div>
    );
  }

  const brandingCtx = buildBranding(brandingSettings, deal);

  // Decide what to render: AI sections or legacy text fallback
  const visibleSections = sections.filter(s => s.isVisible);
  const hasAiSections = visibleSections.length > 0;

  // Legacy fallback
  const cimContent = deal.cimContent as Record<string, string> | null;
  const legacySections = CIM_SECTIONS.filter(s => cimContent?.[s.key]);

  return (
    <div className="min-h-screen bg-background">
      {access.watermarkEnabled && <Watermark email={access.buyerEmail} />}

      {/* ── Sticky header ──────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur-sm">
        <div className="max-w-6xl mx-auto px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-md bg-teal flex items-center justify-center shrink-0">
              <Building className="h-4 w-4 text-teal-foreground" />
            </div>
            <div>
              <h1 className="font-semibold text-sm leading-tight">{deal.businessName}</h1>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
                Confidential Information Memorandum
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <p className="text-xs text-muted-foreground hidden sm:block">{access.buyerEmail}</p>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground border border-border rounded-full px-2.5 py-1">
              <Clock className="h-3 w-3" />
              {formatTime(timeOnPage)}
            </span>
          </div>
        </div>
      </header>

      {/* ── Sticky section nav (appears after scrolling past cover) ────── */}
      {hasAiSections && (
        <StickyNav
          sections={visibleSections}
          onNavigate={(sectionKey, sectionTitle) => {
            enqueue({
              eventType: "nav_click",
              sectionKey,
              eventData: { sectionTitle },
            });
          }}
        />
      )}

      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex gap-8">

          {/* ── Left TOC ────────────────────────────────────────────────────── */}
          <aside className="hidden lg:block w-[200px] shrink-0">
            <div className="sticky top-20">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2 px-1">Contents</p>
              <nav className="space-y-0.5">
                {hasAiSections
                  ? visibleSections.map((s, idx) => (
                      <a
                        key={s.id}
                        href={`#section-${s.id}`}
                        className="flex items-start gap-1.5 px-2 py-1.5 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors leading-snug"
                      >
                        <span className="opacity-40 shrink-0 pt-px">{idx + 1}.</span>
                        <span>{s.sectionTitle}</span>
                      </a>
                    ))
                  : legacySections.map((s, idx) => (
                      <a
                        key={s.key}
                        href={`#legacy-${s.key}`}
                        className="flex items-start gap-1.5 px-2 py-1.5 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
                      >
                        <span className="opacity-40 shrink-0">{idx + 1}.</span>
                        <span>{s.title}</span>
                      </a>
                    ))
                }
              </nav>
              <Separator className="my-3" />
              <div className="px-1 space-y-1.5 text-xs">
                <div className="flex justify-between text-muted-foreground">
                  <span>Access</span>
                  <Badge variant="outline" className="text-[9px] h-4 capitalize">{access.accessLevel}</Badge>
                </div>
                {access.canDownload === false && (
                  <div className="flex items-center gap-1 text-muted-foreground/60">
                    <Lock className="h-3 w-3" /> No downloads
                  </div>
                )}
              </div>
            </div>
          </aside>

          {/* ── Main CIM content ─────────────────────────────────────────────── */}
          <main className="flex-1 min-w-0">
            {hasAiSections ? (
              /* The document itself: one continuous theme-locked paper sheet.
                 App chrome around it (header, TOC, decision panel) keeps app tokens. */
              <div className="cim-doc cim-sheet px-5 py-6 sm:px-10 sm:py-12 space-y-10">
                {visibleSections.map(section => (
                  <div key={section.id} id={`section-${section.id}`}>
                    <SectionBoundary sectionTitle={section.sectionTitle}>
                    <ExpandableSection
                      section={section}
                      branding={brandingCtx}
                      brokerMode={false}
                      onToggle={(sectionKey, expanded) => {
                        enqueue({
                          eventType: expanded ? "section_expand" : "section_collapse",
                          sectionKey,
                        });
                      }}
                    />
                    <ConnectedContent
                      section={section}
                      allSections={visibleSections}
                      onNavigate={(fromKey, toKey) => {
                        enqueue({
                          eventType: "connected_nav",
                          sectionKey: fromKey,
                          eventData: { targetSection: toKey },
                        });
                      }}
                    />
                    </SectionBoundary>
                  </div>
                ))}
              </div>
            ) : legacySections.length > 0 ? (
              // Legacy text fallback — same theme-locked paper sheet
              <div className="cim-doc cim-sheet px-5 py-6 sm:px-10 sm:py-12 space-y-10">
                {legacySections.map(section => (
                  <div key={section.key} id={`legacy-${section.key}`} data-track-section={section.key}>
                    <h2 className="text-xl font-bold tracking-tight mb-4" style={{ color: brandingCtx.headingColor }}>
                      {section.title}
                    </h2>
                    <div className="prose prose-sm max-w-prose text-sm leading-[1.7]">
                      <div dangerouslySetInnerHTML={{
                        __html: (cimContent?.[section.key] || "").replace(/\n/g, "<br />"),
                      }} />
                    </div>
                    <Separator className="mt-8" />
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-24 text-center">
                <FileText className="h-10 w-10 mb-4 opacity-20" />
                <p className="text-sm font-medium">CIM not yet available</p>
                <p className="text-xs text-muted-foreground mt-1">Check back soon — the broker is finalizing the document.</p>
              </div>
            )}

            {/* ── Buyer decision panel — visible once CIM content exists ─── */}
            {(hasAiSections || legacySections.length > 0) && (
              <BuyerDecisionPanel
                token={token!}
                currentDecision={currentDecision}
                businessName={deal.businessName}
                viewCount={access.viewCount ?? 0}
                firstViewedAt={access.firstViewedAt ?? null}
                onUpdated={(d) => setLocalDecision(d)}
              />
            )}

          </main>
        </div>
      </div>

      {/* ── Floating Q&A Chatbot ─────────────────────────────────────── */}
      <BuyerChatbot
        dealId={deal.id}
        buyerAccessId={access.id}
        accessToken={token!}
        businessName={deal.businessName}
        publishedQuestions={publishedQuestions}
      />

      {/* ── Footer ──────────────────────────────────────────────────────────── */}
      <footer className="border-t border-border mt-16 py-8">
        <div className="max-w-6xl mx-auto px-6 text-center space-y-1">
          {brandingCtx.disclaimer && (
            <p className="text-xs text-muted-foreground/70">{brandingCtx.disclaimer}</p>
          )}
          <p className="text-xs text-muted-foreground/50">
            This document is confidential and intended solely for the named recipient.
            Unauthorized distribution or reproduction is strictly prohibited.
          </p>
          {brandingCtx.firmName && (
            <p className="text-xs text-muted-foreground/40 mt-2">Prepared by {brandingCtx.firmName}</p>
          )}
        </div>
      </footer>
    </div>
  );
}
