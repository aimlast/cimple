/**
 * One deal in the broker's deal list — as a card (default) or a table row —
 * plus the small pieces both share: phase progress, the "whose move" line,
 * the readiness pill and the Open / Archive / Restore menu.
 */
import { useLocation } from "wouter";
import { formatDistanceToNowStrict } from "date-fns";
import {
  Archive,
  ArchiveRestore,
  ArrowUpRight,
  Eye,
  FileText,
  MoreHorizontal,
  TriangleAlert,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DEAL_PHASE_COUNT, phaseStep } from "@shared/deal-progress";
import type { NextStepOwner } from "@shared/deal-progress";
import { formatMoney, ownerPrefix, type DealListRow } from "./deal-list-model";

export interface DealItemActions {
  onArchive: (deal: DealListRow) => void;
  onRestore: (deal: DealListRow) => void;
}

/* ─── Shared bits ─────────────────────────────────────────────────────── */

function timeAgo(iso: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "—";
  if (Date.now() - t.getTime() < 60_000) return "just now";
  return `${formatDistanceToNowStrict(t)} ago`;
}

/** Four short segments, filled up to the deal's phase; all green when live. */
export function PhaseProgress({ deal, className = "" }: { deal: DealListRow; className?: string }) {
  const step = phaseStep(deal.phase);
  return (
    <div
      className={`flex items-center gap-0.5 ${className}`}
      role="img"
      aria-label={deal.isLive ? "Live" : `Phase ${step} of ${DEAL_PHASE_COUNT}`}
    >
      {Array.from({ length: DEAL_PHASE_COUNT }, (_, i) => (
        <span
          key={i}
          className={`h-1 w-3.5 rounded-full ${
            deal.isLive ? "bg-success/70" : i < step ? "bg-teal" : "bg-muted-foreground/20"
          }`}
        />
      ))}
    </div>
  );
}

const OWNER_DOT: Record<NextStepOwner, string> = {
  you: "bg-teal",
  seller: "bg-blue/70",
  buyers: "bg-success",
  none: "bg-muted-foreground/50 animate-pulse",
};
const OWNER_TEXT: Record<NextStepOwner, string> = {
  you: "text-teal",
  seller: "text-foreground/80",
  buyers: "text-success",
  none: "text-muted-foreground",
};

/** "Your move: review the CIM content" with the owner words emphasised. */
export function NextStepLine({ deal, className = "" }: { deal: DealListRow; className?: string }) {
  const { owner, label } = deal.nextStep;
  const prefix = deal.archivedAt ? null : ownerPrefix(owner);
  return (
    <p className={`flex items-baseline gap-2 text-xs leading-snug min-w-0 ${className}`}>
      <span className={`h-1.5 w-1.5 rounded-full shrink-0 translate-y-[-1px] ${deal.archivedAt ? "bg-muted-foreground/30" : OWNER_DOT[owner]}`} />
      <span className="min-w-0 truncate" title={prefix ? `${prefix}: ${label}` : label}>
        {deal.archivedAt ? (
          <span className="text-muted-foreground">Archived {timeAgo(deal.archivedAt)}</span>
        ) : prefix ? (
          <>
            <span className={`font-medium ${OWNER_TEXT[owner]}`}>{prefix}:</span>{" "}
            <span className="text-foreground/85">{label}</span>
          </>
        ) : (
          <span className={`font-medium ${OWNER_TEXT[owner]}`}>{label}</span>
        )}
      </span>
    </p>
  );
}

const READINESS_CLASS: Record<NonNullable<DealListRow["readiness"]>["label"], string> = {
  "Buyer-ready": "text-success border-success/30 bg-success/5",
  Solid: "text-teal border-teal/30 bg-teal/5",
  Developing: "text-foreground/80 border-border bg-muted/40",
  Thin: "text-muted-foreground border-border bg-transparent",
};

export function ReadinessPill({ readiness }: { readiness: DealListRow["readiness"] }) {
  // Nothing collected yet — a "Thin 0" pill on a brand-new deal is noise.
  if (!readiness || readiness.score === 0) return null;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-medium tabular-nums whitespace-nowrap ${READINESS_CLASS[readiness.label]}`}
      title={`CIM information quality: ${readiness.label} (${readiness.score}/100)`}
    >
      {readiness.label}
      <span className="opacity-60">{readiness.score}</span>
    </span>
  );
}

function DealMenu({ deal, actions }: { deal: DealListRow; actions: DealItemActions }) {
  const [, setLocation] = useLocation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={(e) => e.stopPropagation()}
          aria-label={`Actions for ${deal.businessName}`}
          data-testid={`deal-menu-${deal.id}`}
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuItem onSelect={() => setLocation(`/deal/${deal.id}`)}>
          <ArrowUpRight className="h-3.5 w-3.5 mr-2" /> Open
        </DropdownMenuItem>
        {deal.nextStep.href && !deal.archivedAt && (
          <DropdownMenuItem onSelect={() => setLocation(deal.nextStep.href!)}>
            <ArrowUpRight className="h-3.5 w-3.5 mr-2 opacity-0" /> Go to next step
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        {deal.archivedAt ? (
          <DropdownMenuItem onSelect={() => actions.onRestore(deal)} data-testid={`deal-restore-${deal.id}`}>
            <ArchiveRestore className="h-3.5 w-3.5 mr-2" /> Restore
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem onSelect={() => actions.onArchive(deal)} data-testid={`deal-archive-${deal.id}`}>
            <Archive className="h-3.5 w-3.5 mr-2" /> Archive
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function useOpenDeal(deal: DealListRow) {
  const [, setLocation] = useLocation();
  return {
    onClick: () => setLocation(`/deal/${deal.id}`),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && e.target === e.currentTarget) setLocation(`/deal/${deal.id}`);
    },
  };
}

function Counts({ deal }: { deal: DealListRow }) {
  const { documents, buyersWithAccess, buyerViews, openDiscrepancies } = deal.counts;
  return (
    <span className="flex items-center gap-3 text-2xs text-muted-foreground tabular-nums">
      <span className="inline-flex items-center gap-1" title={`${documents} document${documents === 1 ? "" : "s"}`}>
        <FileText className="h-3 w-3 opacity-60" /> {documents}
      </span>
      {(buyersWithAccess > 0 || deal.isLive) && (
        <span className="inline-flex items-center gap-1" title={`${buyersWithAccess} buyer${buyersWithAccess === 1 ? "" : "s"} with access`}>
          <Users className="h-3 w-3 opacity-60" /> {buyersWithAccess}
        </span>
      )}
      {buyerViews > 0 && (
        <span className="inline-flex items-center gap-1" title={`${buyerViews} buyer view${buyerViews === 1 ? "" : "s"}`}>
          <Eye className="h-3 w-3 opacity-60" /> {buyerViews}
        </span>
      )}
      {openDiscrepancies > 0 && (
        <span
          className="inline-flex items-center gap-1 text-amber-500"
          title={`${openDiscrepancies} conflicting fact${openDiscrepancies === 1 ? "" : "s"} to resolve`}
        >
          <TriangleAlert className="h-3 w-3" /> {openDiscrepancies}
        </span>
      )}
    </span>
  );
}

/** Shown on a figure only a CRM note, the website or a private note states. */
const UNVERIFIED_HINT = "Only in your private notes or on the website so far — not yet confirmed by the seller or a document.";

function Money({ label, value, unverified }: { label: string; value: string | null; unverified?: boolean }) {
  if (!value) return null;
  return (
    <span className="flex flex-col min-w-0" title={unverified ? UNVERIFIED_HINT : undefined}>
      <span className="text-2xs uppercase tracking-[0.08em] text-muted-foreground/70">{label}</span>
      <span className={`font-mono text-sm tabular-nums ${unverified ? "text-muted-foreground" : "text-foreground"}`}>
        {unverified ? "~" : ""}{value}
        {unverified && <span className="ml-1 font-sans text-2xs normal-case text-muted-foreground/70">unverified</span>}
      </span>
    </span>
  );
}

/* ─── Card ────────────────────────────────────────────────────────────── */

export function DealCard({ deal, actions }: { deal: DealListRow; actions: DealItemActions }) {
  const open = useOpenDeal(deal);
  const asking = formatMoney(deal.askingPriceValue) ?? (deal.askingPrice && deal.askingPrice.length <= 14 ? deal.askingPrice : null);
  const revenue = formatMoney(deal.annualRevenue);
  // SDE on SDE-sized deals, EBITDA on larger ones — labelled (older servers send only sde).
  const earnings = deal.earnings ?? (deal.sde ? { label: "SDE" as const, value: deal.sde } : null);
  const earningsText = formatMoney(earnings?.value ?? null);
  const place = [deal.subIndustry || deal.industry, deal.region].filter(Boolean).join(" · ");

  return (
    <div
      role="link"
      tabIndex={0}
      {...open}
      className={`group relative flex flex-col gap-3 rounded-xl border bg-card p-4 cursor-pointer transition-colors
        hover:border-teal/30 hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal/50
        ${deal.archivedAt ? "border-border/50 opacity-70" : "border-card-border"}`}
      data-testid={`deal-card-${deal.id}`}
    >
      {/* Name + menu */}
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium leading-snug text-foreground truncate" title={deal.businessName}>
            {deal.businessName}
          </h3>
          <p className="text-xs text-muted-foreground truncate mt-0.5">{place || "Industry not set"}</p>
        </div>
        <DealMenu deal={deal} actions={actions} />
      </div>

      {/* Phase (fixed height so cards line up with or without a readiness pill) */}
      <div className="flex items-center gap-2.5 min-h-[22px]">
        <PhaseProgress deal={deal} />
        <span className="text-2xs text-muted-foreground truncate">
          {deal.isLive ? (
            <span className="text-success font-medium">Live</span>
          ) : (
            <>
              <span className="text-muted-foreground/70">Phase {phaseStep(deal.phase) || "?"} ·</span> {deal.phaseLabel}
            </>
          )}
        </span>
        <span className="ml-auto">
          <ReadinessPill readiness={deal.readiness} />
        </span>
      </div>

      <NextStepLine deal={deal} />

      {(asking || revenue || earningsText) && (
        <div className="grid grid-cols-3 gap-3 pt-0.5">
          <Money label="Asking" value={asking} />
          <Money label="Revenue" value={revenue} unverified={deal.revenueUnverified} />
          <Money
            label={`${earnings?.label ?? "SDE"}${earnings && "year" in earnings && earnings.year ? ` · FY${earnings.year}` : ""}`}
            value={earningsText}
            unverified={earnings?.unverified}
          />
        </div>
      )}

      {/* Footer */}
      <div className="mt-auto flex items-center justify-between gap-3 border-t border-border/50 pt-2.5">
        <Counts deal={deal} />
        <span className="text-2xs text-muted-foreground/70 whitespace-nowrap" title={new Date(deal.lastActivityAt).toLocaleString()}>
          {timeAgo(deal.lastActivityAt)}
        </span>
      </div>
    </div>
  );
}

/* ─── Table ───────────────────────────────────────────────────────────── */

export function DealTableHeader() {
  return (
    <div
      className="hidden md:grid grid-cols-[minmax(0,2.2fr)_minmax(0,1.1fr)_minmax(0,2.4fr)_96px_88px_96px_36px] lg:grid-cols-[minmax(0,2.2fr)_minmax(0,1.1fr)_minmax(0,2.4fr)_96px_88px_88px_96px_36px] gap-4 px-4 py-2 text-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground/60 border-b border-border"
      role="row"
    >
      <span>Deal</span>
      <span>Phase</span>
      <span>Next step</span>
      <span>Readiness</span>
      <span className="text-right">Asking</span>
      <span className="text-right hidden lg:block">Revenue</span>
      <span className="text-right">Activity</span>
      <span />
    </div>
  );
}

export function DealTableRow({ deal, actions }: { deal: DealListRow; actions: DealItemActions }) {
  const open = useOpenDeal(deal);
  const asking = formatMoney(deal.askingPriceValue);
  const revenue = formatMoney(deal.annualRevenue);
  const place = [deal.industry, deal.region].filter(Boolean).join(" · ");
  return (
    <div
      role="link"
      tabIndex={0}
      {...open}
      className={`grid grid-cols-[minmax(0,1fr)_36px] md:grid-cols-[minmax(0,2.2fr)_minmax(0,1.1fr)_minmax(0,2.4fr)_96px_88px_96px_36px] lg:grid-cols-[minmax(0,2.2fr)_minmax(0,1.1fr)_minmax(0,2.4fr)_96px_88px_88px_96px_36px]
        gap-x-4 gap-y-1 items-center px-4 py-2.5 border-b border-border/60 cursor-pointer transition-colors
        hover:bg-accent/30 focus-visible:outline-none focus-visible:bg-accent/40 ${deal.archivedAt ? "opacity-70" : ""}`}
      data-testid={`deal-row-${deal.id}`}
    >
      {/* Deal */}
      <div className="min-w-0">
        <p className="text-sm font-medium truncate">{deal.businessName}</p>
        <p className="text-2xs text-muted-foreground truncate">{place}</p>
        {/* Narrow screens: phase + next step fold under the name */}
        <div className="md:hidden mt-1.5 space-y-1">
          <div className="flex items-center gap-2">
            <PhaseProgress deal={deal} />
            <span className="text-2xs text-muted-foreground">{deal.isLive ? "Live" : deal.phaseLabel}</span>
            <span className="text-2xs text-muted-foreground/60 ml-auto">{timeAgo(deal.lastActivityAt)}</span>
          </div>
          <NextStepLine deal={deal} />
        </div>
      </div>
      <div className="hidden md:flex flex-col gap-1 min-w-0">
        <PhaseProgress deal={deal} />
        <span className="text-2xs text-muted-foreground truncate">{deal.isLive ? "Live" : deal.phaseLabel}</span>
      </div>
      <NextStepLine deal={deal} className="hidden md:flex" />
      <span className="hidden md:block">
        {deal.readiness && deal.readiness.score > 0 ? <ReadinessPill readiness={deal.readiness} /> : <span className="text-xs text-muted-foreground/40">—</span>}
      </span>
      <span className="hidden md:block text-right font-mono text-xs tabular-nums">{asking ?? <span className="text-muted-foreground/40">—</span>}</span>
      <span
        className={`hidden lg:block text-right font-mono text-xs tabular-nums ${deal.revenueUnverified ? "text-muted-foreground" : ""}`}
        title={deal.revenueUnverified ? UNVERIFIED_HINT : undefined}
      >
        {revenue ? `${deal.revenueUnverified ? "~" : ""}${revenue}` : <span className="text-muted-foreground/40">—</span>}
      </span>
      <span className="hidden md:block text-right text-2xs text-muted-foreground whitespace-nowrap">{timeAgo(deal.lastActivityAt)}</span>
      <span className="justify-self-end row-start-1 col-start-2 md:row-auto md:col-auto">
        <DealMenu deal={deal} actions={actions} />
      </span>
    </div>
  );
}
