/**
 * CimCanvas — the paper CIM in the middle of the builder.
 *
 * "Editing" shows every section (hidden ones greyed) with the broker's
 * overlays. "Preview as …" renders exactly what that kind of buyer gets —
 * computed with the same function the server uses for the view room
 * (shared/cim-buyer-view.ts) and drawn with the same wrappers as the view
 * room (ExpandableSection + ConnectedContent on the theme-locked sheet).
 */
import { Check, EyeOff, Loader2, Lock, Pencil, Plus, Sparkles, X } from "lucide-react";
import type { CimSection, CimSectionOverride } from "@shared/schema";
import type { MediaAssetRef } from "@shared/cim-media";
import { buildBuyerCim } from "@shared/cim-buyer-view";
import { ExpandableSection } from "@/components/cim/ExpandableSection";
import { ConnectedContent } from "@/components/cim/ConnectedContent";
import { SectionBoundary } from "@/components/cim/SectionBoundary";
import type { CimBranding } from "@/components/cim/CimBrandingContext";
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
}

export function CimCanvas(props: Props) {
  const { previewAs } = props;
  return previewAs === "editor" ? <EditorSheet {...props} /> : <BuyerSheet {...props} />;
}

/** Section with a ready rewrite shown as the proposal. */
function withProposal(s: BuilderSection): CimSection {
  const p = s.aiTask?.kind === "rewrite" && s.aiTask.status === "ready" ? s.aiTask.proposal : undefined;
  const base = s as unknown as CimSection;
  if (!p) return base;
  return { ...base, layoutData: p.layoutData as any, aiDraftContent: p.aiDraftContent ?? null, brokerEditedContent: null };
}

function EditorSheet({ sections, branding, selectedId, onSelect, onAddAfter, onApplyRewrite, onDiscardRewrite, applying, draft }: Props) {
  const all = sections as unknown as CimSection[];
  return (
    <div className="cim-doc cim-sheet px-4 py-6 sm:px-10 sm:py-12 space-y-10">
      {sections.map((s) => {
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
                selected ? "ring-2 ring-teal ring-offset-4 ring-offset-[#FBF8F2]" : "hover:ring-1 hover:ring-[#E3DED0]",
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
                <WritingPlaceholder title={s.sectionTitle} headingColor={branding.headingColor} />
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
                  <span className="flex items-center gap-2 rounded-full border border-[#E3DED0] bg-[#FEFDFB] px-3 py-1.5 text-xs font-medium text-[#46423B] shadow-sm">
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-[#9E752E]" /> {TASK_LABEL[s.aiTask.kind]}…
                  </span>
                </div>
              )}
              {proposal && (
                <div className="mt-4 flex flex-wrap items-center justify-end gap-2" onClick={(e) => e.stopPropagation()}>
                  <Button size="sm" variant="outline" className="h-7 text-xs gap-1 bg-[#FEFDFB] text-[#201D18] border-[#E3DED0] hover:bg-[#F2EEE3]" onClick={() => onDiscardRewrite(s.id)} disabled={applying}>
                    <X className="h-3 w-3" /> Discard
                  </Button>
                  <Button size="sm" className="h-7 text-xs gap-1 bg-[#9E752E] text-white hover:bg-[#8a6627]" onClick={() => onApplyRewrite(s.id)} disabled={applying}>
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
                  className="flex items-center gap-1.5 rounded-full border border-dashed border-[#CFC9BB] px-3 py-1 text-xs text-[#6B665C] hover:border-[#9E752E] hover:text-[#9E752E]"
                >
                  <Plus className="h-3 w-3" /> Add a section below
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function BuyerSheet({ sections, previewAs, overrides, deal, branding, selectedId, onSelect, media }: Props) {
  const view = buildBuyerCim({
    deal,
    accessLevel: previewAs,
    sections: sections as unknown as CimSection[],
    overrides,
    media: media ?? [],
  });
  if (view.preparing) return null; // the page shows the "not generated yet" banner
  const shown = view.sections as unknown as CimSection[];
  if (shown.length === 0) {
    return (
      <div className="cim-doc cim-sheet px-6 py-16 text-center text-sm text-[#6B665C]">
        Nothing to show this buyer yet.
      </div>
    );
  }
  return (
    <div className="cim-doc cim-sheet px-4 py-6 sm:px-10 sm:py-12 space-y-10">
      {shown.map((s) => (
        <div
          key={s.id}
          id={`section-${s.id}`}
          className={cn("scroll-mt-6 rounded-xl -mx-2 px-2 sm:-mx-3 sm:px-3", selectedId === s.id && "ring-1 ring-teal/60 ring-offset-4 ring-offset-[#FBF8F2]")}
          onClick={() => onSelect(s.id)}
        >
          <SectionBoundary sectionTitle={s.sectionTitle}>
            <ExpandableSection section={s} branding={branding} brokerMode={false} />
            <ConnectedContent section={s} allSections={shown} />
          </SectionBoundary>
        </div>
      ))}
    </div>
  );
}

function WritingPlaceholder({ title, headingColor }: { title: string; headingColor: string }) {
  return (
    <div className="cim-doc cim-section">
      <h2 className="text-xl font-bold tracking-tight mb-4" style={{ color: headingColor }}>{title}</h2>
      <div className="rounded-lg border border-[#E3DED0] bg-[#FEFDFB] p-5 space-y-3">
        <p className="flex items-center gap-2 text-xs font-medium text-[#46423B]">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-[#9E752E]" /> Writing this section from the deal's information…
        </p>
        {["w-11/12", "w-4/5", "w-full", "w-3/5"].map((w, i) => (
          <div key={i} className={`h-2.5 rounded bg-[#F2EEE3] animate-pulse ${w}`} />
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
        tone === "brass" ? "border-[#9E752E]/50 bg-[#FBF3E4] text-[#7A5A22]" : "border-[#E3DED0] bg-[#FEFDFB] text-[#46423B]",
      )}
    >
      {children}
    </span>
  );
}
