/**
 * BuyerViewRoom
 *
 * Buyer-facing CIM viewer. Renders all CimSections in sequence via
 * CimSectionRenderer. Reading time per page part (a table row, a chart, a
 * paragraph) is measured by useCimReading (client/src/lib/cim-reading.ts)
 * once real content is on screen — never on the NDA or holding screens.
 *
 * Falls back to legacy cimContent text if no AI sections exist yet.
 */
import { useState, useEffect, useRef } from "react";
import { Link, useLocation, useParams } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Building, Clock, Lock, AlertCircle, FileText,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Deal, CimSection } from "@shared/schema";
import { CIM_SECTIONS } from "@shared/schema";
import { buyerAccessLabel } from "@shared/cim-layouts";
import { buildBranding } from "@/components/cim/CimBrandingContext";
import { CimDesignProvider, buildCimDesign, type CimDesignPayload } from "@/components/cim/CimDesignContext";
import { CimSheet } from "@/components/cim/CimSheet";
import { CimSectionHeading } from "@/components/cim/CimSectionHeading";
import { CimContactPage, CimDisclaimerPage, withBrokeragePages } from "@/components/cim/CimFrontBackPages";
import { StickyNav } from "@/components/cim/StickyNav";
import { ExpandableSection } from "@/components/cim/ExpandableSection";
import { CimMediaProvider } from "@/components/cim/CimMediaContext";
import { SectionBoundary } from "@/components/cim/SectionBoundary";
import { ConnectedContent } from "@/components/cim/ConnectedContent";
import { BuyerChatbot, type BuyerQuestionFeedItem } from "@/components/buyer/BuyerChatbot";
import { BuyerDecisionPanel } from "@/components/buyer/BuyerDecisionPanel";
import { NdaBuyerProfileGate } from "@/components/buyer/NdaBuyerProfileGate";
import { CimBlockScope, CimBlocksProvider } from "@/components/cim/blocks";
import { READING_SHEET_ATTR, useCimReading } from "@/lib/cim-reading";
import type { ViewRoomReading } from "@shared/analytics-v2";
import type { ViewRoomDataRoom } from "@shared/vdr-api";
import { RoomSwitch } from "@/components/vdr/RoomSwitch";
import { VdrLinkProvider } from "@/components/vdr/VdrLinkContext";

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
  ndaCopyAvailable?: boolean;
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
  /** Published Q&A plus this buyer's own pending questions (whitelisted) */
  publishedQuestions: BuyerQuestionFeedItem[];
  /** Whitelisted brokerage name / logo / disclaimer (never the settings row). */
  branding: { companyName: string | null; logoUrl: string | null; disclaimer: string | null } | null;
  /** Template + brokerage brand; business branding only in the named versions. */
  design?: CimDesignPayload | null;
  cimMode?: "blind" | "normal" | "dd";
  /** True when the server is withholding CIM content until the NDA is signed */
  ndaGate?: boolean;
  /** True when the blind (redacted) version is still being prepared */
  preparing?: boolean;
  /** True while the broker reviews an updated CIM before publishing it again */
  updating?: boolean;
  /** Sections held back until their redacted version is ready (just added/edited). */
  pendingSections?: number;
  /** Reading analytics: the served version's opaque id + page order (content branch only). */
  reading?: ViewRoomReading;
  /** The data room (vdr): the header switch and the downloads line. */
  dataRoom?: ViewRoomDataRoom;
}

/** A section the buyer's access level doesn't open yet (server sends title only). */
const isLocked = (s: CimSection) => (s as CimSection & { locked?: boolean }).locked === true;

/** Parse an error body defensively — proxies return HTML during deploys. */
async function readErrorBody(res: Response): Promise<{ error?: string; code?: string; [k: string]: any }> {
  return res.json().catch(() => ({}));
}

/** A load failure that carries the server's reason code (e.g. not_published). */
class ViewRoomError extends Error {
  constructor(message: string, readonly code?: string, readonly body: Record<string, any> = {}) {
    super(message);
  }
}

// ── Watermark ──────────────────────────────────────────────────────────────
// Ink-colored literal (not a theme token) so it stays visible-but-subtle on
// the paper document surface in BOTH app themes.
function Watermark({ email }: { email: string }) {
  // `cim-watermark` keeps it on printed pages (index.css print rules).
  return (
    <div className="cim-watermark fixed inset-0 pointer-events-none z-50 overflow-hidden opacity-[0.05]">
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

// ── Main component ─────────────────────────────────────────────────────────
export default function BuyerViewRoom() {
  const { token } = useParams<{ token: string }>();
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const [timeOnPage, setTimeOnPage] = useState(0);
  const [localDecision, setLocalDecision] = useState<BuyerDecision | null>(null);
  // A data-room document open beside the CIM (VdrViewerDrawer). INTEGRATOR (analytics' `paused`, INTEGRATION §2.4):
  // pass `paused: roomDrawerOpen` to useCimReading below and record "vdr_open" when it opens.
  const [roomDrawerOpen, setRoomDrawerOpen] = useState(false);
  const startTimeRef = useRef(Date.now());

  const { data, isLoading, error } = useQuery<ViewData>({
    queryKey: ["/api/view", token],
    enabled: !!token,
    queryFn: async () => {
      const res = await fetch(`/api/view/${token}`);
      if (!res.ok) {
        const body = await readErrorBody(res);
        throw new ViewRoomError(body.error || "Access denied", body.code, body);
      }
      return res.json();
    },
    // While the redacted version is being prepared, poll until it's ready;
    // more slowly while a few freshly edited sections catch up.
    refetchInterval: (query) => {
      const d = query.state.data as ViewData | undefined;
      if (d?.preparing) return 4000;
      if (d?.updating) return 60000;
      return d?.pendingSections ? 10000 : false;
    },
  });

  // Reading analytics: starts only once real CIM content is on screen — not
  // on the NDA form or the preparing/updating screens — and only when the
  // server sent a `reading` block (it doesn't for the owning broker).
  const hasContent = !!data?.sections?.some((s) => s.isVisible);
  const tracker = useCimReading({
    token,
    accessId: data?.access?.id,
    reading: data?.reading ?? null,
    enabled: hasContent && !data?.ndaGate && !data?.preparing && !data?.updating,
  });

  // Timer
  useEffect(() => {
    const interval = setInterval(() => {
      setTimeOnPage(Math.floor((Date.now() - startTimeRef.current) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, []);


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

  // A buyer's team member's link: their data room (never the memorandum).
  if (error instanceof ViewRoomError && error.code === "team_link" && typeof error.body.redirect === "string" && error.body.redirect.startsWith("/view/")) {
    setTimeout(() => setLocation(error.body.redirect, { replace: true }), 0);
    return null;
  }

  // Not published yet (or taken offline): a calm holding card, not an error.
  if (error instanceof ViewRoomError && error.code === "not_published") {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <div className="max-w-sm text-center space-y-3" data-testid="view-room-not-published">
          <Clock className="h-8 w-8 mx-auto text-muted-foreground/60" />
          <h2 className="text-lg font-semibold">Not available yet</h2>
          <p className="text-sm text-muted-foreground">Your broker will let you know as soon as this CIM is ready to view.</p>
          {error.body?.dataRoom?.available && (
            <div className="pt-2">
              <Button asChild size="sm" data-testid="view-room-open-data-room">
                <Link href={`/view/${token}/data-room`}>Open the data room</Link>
              </Button>
            </div>
          )}
        </div>
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
      <NdaBuyerProfileGate
        dealName={deal.businessName}
        token={token!}
        onAccepted={() => queryClient.invalidateQueries({ queryKey: ["/api/view", token], exact: true })}
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

  // The broker is reviewing an updated version before publishing it again.
  if (data.updating) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <div className="max-w-sm text-center space-y-3" data-testid="view-room-updating">
          <FileText className="h-8 w-8 mx-auto text-teal/60" />
          <h2 className="text-lg font-semibold">This document is being updated</h2>
          <p className="text-sm text-muted-foreground">
            The broker is finalizing a new version. It opens here as soon as it's published — your access stays the same.
          </p>
        </div>
      </div>
    );
  }

  const brandingCtx = buildBranding(brandingSettings as any, deal);
  // The CIM's design for this buyer's version (the server already dropped
  // the business's branding for Blind buyers; buildCimDesign drops it again).
  const cimMode = data.cimMode ?? "blind";
  const design = buildCimDesign(data.design ?? null, cimMode);
  const firmName = design.brokerage.firmName || brandingCtx.firmName;
  const firmLogo = design.brokerage.logoUrl;
  const disclaimerText = design.brokerage.disclaimer || brandingCtx.disclaimer;

  // Decide what to render: AI sections or legacy text fallback
  const visibleSections = sections.filter(s => s.isVisible);
  const hasAiSections = visibleSections.length > 0;

  // Legacy fallback
  const cimContent = deal.cimContent as Record<string, string> | null;
  const legacySections = CIM_SECTIONS.filter(s => cimContent?.[s.key]);

  /** A section id from a section key (the sticky strip and "See …" links speak keys). */
  const pageIdOfKey = (key: string) => visibleSections.find((s) => s.sectionKey === key)?.id ?? null;

  return (
    <div className="min-h-screen bg-background">
      {access.watermarkEnabled && <Watermark email={access.buyerEmail} />}

      {/* ── Sticky header ──────────────────────────────────────────────────── */}
      <header data-reading-chrome="" className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur-sm">
        <div className="max-w-6xl mx-auto px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {firmLogo ? (
              <img src={firmLogo} alt={firmName ? `${firmName} logo` : "Brokerage logo"} className="h-8 max-w-[110px] w-auto object-contain rounded bg-white px-1 shrink-0" />
            ) : (
              <div className="h-8 w-8 rounded-md bg-teal flex items-center justify-center shrink-0">
                <Building className="h-4 w-4 text-teal-foreground" />
              </div>
            )}
            <div>
              <h1 className="font-semibold text-sm leading-tight">{deal.businessName}</h1>
              <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
                Confidential Information Memorandum
              </p>
            </div>
          </div>
          {data.dataRoom?.available && (
            <RoomSwitch token={token!} active="memo" newCount={data.dataRoom.newCount} className="hidden md:inline-flex" />
          )}
          <div className="flex items-center gap-3">
            <p className="text-xs text-muted-foreground hidden sm:block">{access.buyerEmail}</p>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground border border-border rounded-full px-2.5 py-1">
              <Clock className="h-3 w-3" />
              {formatTime(timeOnPage)}
            </span>
          </div>
        </div>
        {data.dataRoom?.available && (
          <div className="border-t border-border px-4 py-2 md:hidden">
            <RoomSwitch token={token!} active="memo" newCount={data.dataRoom.newCount} full />
          </div>
        )}
      </header>

      {/* ── Sticky section nav (appears after scrolling past cover) ────── */}
      {hasAiSections && (
        <StickyNav
          sections={visibleSections}
          onNavigate={(sectionKey) => {
            const target = pageIdOfKey(sectionKey);
            if (target) tracker.record("nav", null, undefined, `sticky:${target}`);
          }}
        />
      )}

      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8" data-cim-content>
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
                        onClick={() => tracker.record("nav", null, undefined, `toc:${s.id}`)}
                        className="flex items-start gap-1.5 px-2 py-1.5 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors leading-snug"
                      >
                        <span className="opacity-40 shrink-0 pt-px">{idx + 1}.</span>
                        <span className={isLocked(s) ? "opacity-60" : undefined}>{s.sectionTitle}</span>
                        {isLocked(s) && <Lock className="h-3 w-3 shrink-0 mt-0.5 opacity-50" aria-label="Locked" />}
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
                  <Badge variant="outline" className="text-[9px] h-4">{buyerAccessLabel(access.accessLevel)}</Badge>
                </div>
                {(data.dataRoom?.available ? !data.dataRoom.allowDownloads : access.canDownload === false) && (
                  <div className="flex items-center gap-1 text-muted-foreground/60">
                    <Lock className="h-3 w-3" /> No downloads
                  </div>
                )}
              </div>
            </div>
          </aside>

          {/* ── Main CIM content ─────────────────────────────────────────────── */}
          {/* Data-room citations (VdrCitationChip) and links inside the CIM open beside it (vdr §6.6). */}
          <VdrLinkProvider source={{ kind: "buyer", token: token! }} onDrawerChange={(open) => setRoomDrawerOpen(open)}>
          <main className="flex-1 min-w-0">
            {hasAiSections && !!data.pendingSections && (
              <p className="mb-3 text-xs text-muted-foreground flex items-center gap-2" data-testid="view-pending-sections">
                <span className="h-1.5 w-1.5 rounded-full bg-teal/60 animate-pulse" />
                {data.pendingSections === 1
                  ? "One more section is being finalized and will appear shortly."
                  : `${data.pendingSections} more sections are being finalized and will appear shortly.`}
              </p>
            )}
            {hasAiSections ? (
              /* The document itself: one continuous theme-locked paper sheet.
                 App chrome around it (header, TOC, decision panel) keeps app tokens. */
              /* Photos/videos load through /api/media/:id with this link's token. */
              <CimMediaProvider value={{ buyerToken: token }}>
              <CimDesignProvider design={design} sections={visibleSections}>
              {/* Reading analytics: every page and part carries its id inside this provider. */}
              <CimBlocksProvider host={tracker}>
              <CimSheet className="px-5 py-6 sm:px-10 sm:py-12" {...{ [READING_SHEET_ATTR]: "" }}>
                {withBrokeragePages(visibleSections, {
                  disclaimer: design.brokerage.showDisclaimerPage !== false,
                  contact: design.brokerage.showContactPage !== false,
                }).map(item => item.kind === "disclaimer" ? (
                  <CimDisclaimerPage key={item.key} />
                ) : item.kind === "contact" ? (
                  <CimContactPage key={item.key} />
                ) : (() => { const section = item.section; return (
                  /* scroll-mt clears the sticky header + section strip so
                     nav clicks, "See …" links and TOC anchors land the
                     heading below the chrome instead of under it. */
                  <div key={section.id} id={`section-${section.id}`} data-cim-page={section.id} className="scroll-mt-24">
                    {/* The page scope: interactions reported at the section's top level (expand/collapse) know their page. */}
                    <CimBlockScope pageId={section.id}>
                    <SectionBoundary sectionTitle={section.sectionTitle}>
                    <ExpandableSection
                      section={section}
                      branding={brandingCtx}
                      brokerMode={false}
                    />
                    <ConnectedContent
                      section={section}
                      allSections={visibleSections}
                      onNavigate={(_fromKey, toKey) => {
                        const target = pageIdOfKey(toKey);
                        if (target) tracker.record("nav", section.id, undefined, `related:${target}`);
                      }}
                    />
                    </SectionBoundary>
                    </CimBlockScope>
                  </div>
                ); })())}
              </CimSheet>
              </CimBlocksProvider>
              </CimDesignProvider>
              </CimMediaProvider>
            ) : legacySections.length > 0 ? (
              // Legacy text fallback — same theme-locked paper sheet
              <CimDesignProvider design={design}>
              <CimSheet className="px-5 py-6 sm:px-10 sm:py-12">
                {legacySections.map(section => (
                  <div key={section.key} id={`legacy-${section.key}`} className="scroll-mt-20">
                    <CimSectionHeading title={section.title} />
                    <div className="prose prose-sm max-w-prose text-sm leading-[1.7]">
                      <div dangerouslySetInnerHTML={{
                        __html: (cimContent?.[section.key] || "").replace(/\n/g, "<br />"),
                      }} />
                    </div>
                    <Separator className="mt-8" />
                  </div>
                ))}
              </CimSheet>
              </CimDesignProvider>
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
          </VdrLinkProvider>
        </div>
      </div>

      {/* ── Floating Q&A Chatbot ─────────────────────────────────────── */}
      <BuyerChatbot
        dealId={deal.id}
        buyerAccessId={access.id}
        accessToken={token!}
        businessName={deal.businessName}
        questionFeed={publishedQuestions}
        readingContext={() => ({ pageId: tracker.currentPageId(), renditionId: tracker.renditionId() })}
        onOpen={() => tracker.record("chat_open")}
      />

      {/* ── Footer ──────────────────────────────────────────────────────────── */}
      <footer className="border-t border-border mt-16 py-8">
        <div className="max-w-6xl mx-auto px-6 text-center space-y-1">
          {disclaimerText && !design.brokerage.showDisclaimerPage && (
            <p className="text-xs text-muted-foreground/70">{disclaimerText}</p>
          )}
          <p className="text-xs text-muted-foreground/50">
            This document is confidential and intended solely for the named recipient.
            Unauthorized distribution or reproduction is strictly prohibited.
          </p>
          <p className="text-xs text-muted-foreground/50" data-testid="view-room-reading-notice">
            Your broker can see which parts of this document you read.
          </p>
          {firmName && (
            <p className="text-xs text-muted-foreground/40 mt-2">Prepared by {firmName}</p>
          )}
          {access.ndaCopyAvailable && (
            <p className="text-xs mt-2">
              <a href={`/api/view/${token}/nda.txt`} className="text-muted-foreground/70 underline underline-offset-2 hover:text-foreground" data-testid="link-signed-nda">
                Download your signed NDA
              </a>
            </p>
          )}
        </div>
      </footer>
    </div>
  );
}
