/**
 * CimCanvas — the paper CIM in the middle of the builder.
 *
 * "Editing" shows every section (hidden ones greyed) with the broker's
 * overlays. "Preview as …" renders exactly what that kind of buyer gets —
 * computed with the same function the server uses for the view room
 * (shared/cim-buyer-view.ts) and drawn with the same wrappers as the view
 * room (ExpandableSection + ConnectedContent on the theme-locked sheet),
 * in the deal's design template: the named CIM's design while editing,
 * and each buyer version's own (Blind never shows business branding).
 * The brokerage pages (disclaimer, contact) appear where buyers see them.
 */
import { Check, EyeOff, Loader2, Lock, Pencil, Plus, Sparkles, X } from "lucide-react";
import type { CimSection, CimSectionOverride } from "@shared/schema";
import type { MediaAssetRef } from "@shared/cim-media";
import { buildBuyerCim } from "@shared/cim-buyer-view";
import { ExpandableSection } from "@/components/cim/ExpandableSection";
import { ConnectedContent } from "@/components/cim/ConnectedContent";
import { SectionBoundary } from "@/components/cim/SectionBoundary";
import type { CimBranding } from "@/components/cim/CimBrandingContext";
import { CimDesignProvider, buildCimDesign, type CimDesignPayload } from "@/components/cim/CimDesignContext";
import { CimSheet } from "@/components/cim/CimSheet";
import { CimSectionHeading } from "@/components/cim/CimSectionHeading";
import { CimContactPage, CimDisclaimerPage, useBrokeragePageFlags, withBrokeragePages } from "@/components/cim/CimFrontBackPages";
import { cimModeForAccessLevel } from "@shared/cim-layouts";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { TASK_LABEL, type BuilderSection } from "./api";

export type PreviewAs = "editor" | "teaser" | "full" | "loi" | "due_diligence";

interface Props {
  sections: BuilderSection[];
  previewAs: PreviewAs;
  overrides: CimSectionOverride[];
  deal: { id: string; businessName: string; extractedInfo?: unknown; blindCodename?: string | null };
  branding: CimBranding;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAddAfter: (afterId: string) => void;
  onApplyRewrite: (id: string) => void;
  onDiscardRewrite: (id: string) => void;
  applying: boolean;
  /** The deal's media library — buyer previews apply the same blind rules as the server. */
  media?: MediaAssetRef[];
  /** Unsaved edits of one section (photo/video/map editors), previewed live. */
  draft?: { id: string; layoutData: Record<string, any> } | null;
  /** The deal's design (template + branding); Classic Paper when absent. */
  design?: CimDesignPayload | null;
}

export function CimCanvas(props: Props) {
  const { previewAs } = props;
  return previewAs === "editor" ? <EditorSheet {...props} /> : <BuyerSheet {...props} />;
}

/** A brokerage page in the editor: shown as buyers see it, edited in Settings. */
function BrokeragePage({ kind }: { kind: "disclaimer" | "contact" }) {
  return (
    <div className="relative rounded-xl -mx-2 px-2 py-1 sm:-mx-3 sm:px-3" data-testid={`canvas-${kind}-page`}>
      <div className="absolute -top-3 right-2 z-20">
        <a
          href="/broker/settings?tab=brand"
          className="inline-flex items-center gap-1 rounded-full border border-[hsl(var(--cim-line))] bg-[hsl(var(--cim-card))] px-2 py-0.5 text-[10px] font-medium text-[hsl(var(--cim-ink-soft))] shadow-sm hover:underline"
          title="This page comes from your brand settings"
        >
          Brokerage page · edit in Settings
        </a>
      </div>
      {kind === "disclaimer" ? <CimDisclaimerPage /> : <CimContactPage />}
    </div>
  );
}

/** Section with a ready rewrite shown as the proposal. */
function withProposal(s: BuilderSection): CimSection {
  const p = s.aiTask?.kind === "rewrite" && s.aiTask.status === "ready" ? s.aiTask.proposal : undefined;
  const base = s as unknown as CimSection;
  if (!p) return base;
  return { ...base, layoutData: p.layoutData as any, aiDraftContent: p.aiDraftContent ?? null, brokerEditedContent: null };
}

function EditorSheet(props: Props) {
  const design = buildCimDesign(props.design, "normal");
  return (
    <CimDesignProvider design={design} sections={props.sections}>
      <EditorSheetBody {...props} />
    </CimDesignProvider>
  );
}

function EditorSheetBody({ sections, branding, selectedId, onSelect, onAddAfter, onApplyRewrite, onDiscardRewrite, applying, draft }: Props) {
  const all = sections as unknown as CimSection[];
  const pages = withBrokeragePages(sections, useBrokeragePageFlags());
  return (
    <CimSheet className="px-4 py-6 sm:px-10 sm:py-12">
      {pages.map((item) => {
        if (item.kind !== "section") return <BrokeragePage key={item.key} kind={item.kind} />;
        const s = item.section;
        const hidden = s.isVisible === false;
        const running = s.aiTask?.status === "running";
        // A brand-new section being written has nothing to show yet.
        const writing = running && s.aiTask?.kind === "write";
        const proposal = s.aiTask?.kind === "rewrite" && s.aiTask.status === "ready";
        const selected = selectedId === s.id;
        const drafted = draft && draft.id === s.id;
        const shown = drafted ? { ...withProposal(s), layoutData: draft.layoutData as any } : withProposal(s);
        return (
          <div key={s.id} id={`section-${s.id}`} className="scroll-mt-6">
            <div
              role="button"
              tabIndex={-1}
              onClick={() => onSelect(s.id)}
              className={cn(
                "relative rounded-xl transition-shadow cursor-pointer -mx-2 px-2 py-1 sm:-mx-3 sm:px-3",
                selected ? "ring-2 ring-teal ring-offset-4 ring-offset-[hsl(var(--cim-paper))]" : "hover:ring-1 hover:ring-[hsl(var(--cim-line))]",
                proposal && "ring-2 ring-teal/70",
              )}
              data-testid={`canvas-section-${s.id}`}
            >
              {/* Broker chips — app chrome over the paper, never part of the CIM */}
              {(hidden || s.accessTier === "full" || proposal || drafted) && (
                <div className="absolute -top-3 right-2 z-20 flex flex-wrap justify-end gap-1">
                  {drafted && <Chip tone="brass"><Pencil className="h-3 w-3" /> Unsaved changes</Chip>}
                  {proposal && <Chip tone="brass"><Sparkles className="h-3 w-3" /> Proposed rewrite — not applied yet</Chip>}
                  {s.accessTier === "full" && <Chip><Lock className="h-3 w-3" /> Full access only</Chip>}
                  {hidden && <Chip><EyeOff className="h-3 w-3" /> Hidden from buyers</Chip>}
                </div>
              )}
              {writing ? (
                <WritingPlaceholder title={s.sectionTitle} />
              ) : (
                <div className={cn(hidden && "opacity-40 grayscale", running && "opacity-50")}>
                  <SectionBoundary sectionTitle={s.sectionTitle}>
                    <ExpandableSection section={{ ...shown, isVisible: true }} branding={branding} brokerMode />
                    <ConnectedContent section={shown} allSections={all} />
                  </SectionBoundary>
                </div>
              )}
              {running && !writing && s.aiTask && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="flex items-center gap-2 rounded-full border border-[hsl(var(--cim-line))] bg-[hsl(var(--cim-card))] px-3 py-1.5 text-xs font-medium text-[hsl(var(--cim-ink-soft))] shadow-sm">
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-teal" /> {TASK_LABEL[s.aiTask.kind]}…
                  </span>
                </div>
              )}
              {proposal && (
                <div className="mt-4 flex flex-wrap items-center justify-end gap-2" onClick={(e) => e.stopPropagation()}>
                  <Button size="sm" variant="outline" className="h-7 text-xs gap-1 bg-[hsl(var(--cim-card))] text-[hsl(var(--cim-ink))] border-[hsl(var(--cim-line))] hover:bg-[hsl(var(--cim-stripe))]" onClick={() => onDiscardRewrite(s.id)} disabled={applying}>
                    <X className="h-3 w-3" /> Discard
                  </Button>
                  <Button size="sm" className="h-7 text-xs gap-1 bg-teal text-teal-foreground hover:bg-teal/90" onClick={() => onApplyRewrite(s.id)} disabled={applying}>
                    {applying ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />} Apply rewrite
                  </Button>
                </div>
              )}
            </div>
            {selected && (
              <div className="mt-4 flex justify-center">
                <button
                  type="button"
                  onClick={() => onAddAfter(s.id)}
                  className="flex items-center gap-1.5 rounded-full border border-dashed border-[hsl(var(--cim-line))] px-3 py-1 text-xs text-[hsl(var(--cim-ink-muted))] hover:border-teal hover:text-teal"
                >
                  <Plus className="h-3 w-3" /> Add a section below
                </button>
              </div>
            )}
          </div>
        );
      })}
    </CimSheet>
  );
}

function BuyerSheet({ sections, previewAs, overrides, deal, branding, selectedId, onSelect, media, design: designPayload }: Props) {
  const view = buildBuyerCim({
    deal,
    accessLevel: previewAs,
    sections: sections as unknown as CimSection[],
    overrides,
    media: media ?? [],
  });
  if (view.preparing) return null; // the page shows the "not generated yet" banner
  const shown = view.sections as unknown as CimSection[];
  // This buyer's version of the design (Blind: no business branding), with
  // chapter numbers following what this buyer actually sees.
  const design = buildCimDesign(designPayload, cimModeForAccessLevel(previewAs));
  const flags = { disclaimer: design.brokerage.showDisclaimerPage !== false, contact: design.brokerage.showContactPage !== false };
  if (shown.length === 0) {
    return (
      <CimDesignProvider design={design}>
        <CimSheet flow={false} className="px-6 py-16 text-center text-sm text-[hsl(var(--cim-ink-muted))]">
          Nothing to show this buyer yet.
        </CimSheet>
      </CimDesignProvider>
    );
  }
  return (
    <CimDesignProvider design={design} sections={shown}>
      <CimSheet className="px-4 py-6 sm:px-10 sm:py-12">
        {withBrokeragePages(shown, flags).map((item) =>
          item.kind !== "section" ? (
            item.kind === "disclaimer" ? <CimDisclaimerPage key={item.key} /> : <CimContactPage key={item.key} />
          ) : (
            <div
              key={item.key}
              id={`section-${item.section.id}`}
              className={cn("scroll-mt-6 rounded-xl -mx-2 px-2 sm:-mx-3 sm:px-3", selectedId === item.section.id && "ring-1 ring-teal/60 ring-offset-4 ring-offset-[hsl(var(--cim-paper))]")}
              onClick={() => onSelect(item.section.id)}
            >
              <SectionBoundary sectionTitle={item.section.sectionTitle}>
                <ExpandableSection section={item.section} branding={branding} brokerMode={false} />
                <ConnectedContent section={item.section} allSections={shown} />
              </SectionBoundary>
            </div>
          ),
        )}
      </CimSheet>
    </CimDesignProvider>
  );
}

function WritingPlaceholder({ title }: { title: string }) {
  return (
    <div className="cim-doc cim-section">
      <CimSectionHeading title={title} />
      <div className="rounded-lg border border-border bg-card p-5 space-y-3">
        <p className="flex items-center gap-2 text-xs font-medium text-[hsl(var(--cim-ink-soft))]">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-teal" /> Writing this section from the deal's information…
        </p>
        {["w-11/12", "w-4/5", "w-full", "w-3/5"].map((w, i) => (
          <div key={i} className={`h-2.5 rounded bg-muted animate-pulse ${w}`} />
        ))}
      </div>
    </div>
  );
}

function Chip({ children, tone }: { children: React.ReactNode; tone?: "brass" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium shadow-sm",
        tone === "brass" ? "border-teal/50 bg-teal-muted text-teal-muted-foreground" : "border-[hsl(var(--cim-line))] bg-[hsl(var(--cim-card))] text-[hsl(var(--cim-ink-soft))]",
      )}
    >
      {children}
    </span>
  );
}
