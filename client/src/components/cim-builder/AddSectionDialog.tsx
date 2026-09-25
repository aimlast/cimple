/**
 * AddSectionDialog — "Add section": pick a layout from the gallery, name it,
 * choose where it goes and whether the AI writes it from the deal's
 * information or it starts blank.
 */
import { useEffect, useState } from "react";
import { Loader2, Lock, PenLine, Sparkles, Users } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getCimLayout } from "@shared/cim-layouts";
import { cn } from "@/lib/utils";
import { LayoutGallery, LayoutIcon } from "./LayoutGallery";
import type { BuilderSection } from "./api";
import type { AddSectionInput } from "./useCimBuilder";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sections: BuilderSection[];
  /** Pre-selected position: after this section (null = at the start). Undefined = end. */
  afterSectionId?: string | null;
  /** Why the AI can't write right now (e.g. open critical discrepancies). */
  aiBlockedReason?: string | null;
  busy: boolean;
  onSubmit: (input: AddSectionInput) => void;
}

const END = "__end";
const START = "__start";

export function AddSectionDialog({ open, onOpenChange, sections, afterSectionId, aiBlockedReason, busy, onSubmit }: Props) {
  const [layoutType, setLayoutType] = useState<string>("prose_highlight");
  const [title, setTitle] = useState("");
  const [position, setPosition] = useState<string>(END);
  const [mode, setMode] = useState<"ai" | "blank">("ai");
  const [brief, setBrief] = useState("");
  const [tier, setTier] = useState<"teaser" | "full">("teaser");

  // Fresh form each time it opens, positioned where the broker clicked.
  useEffect(() => {
    if (!open) return;
    setLayoutType("prose_highlight");
    setTitle("");
    setBrief("");
    setTier("teaser");
    setMode(aiBlockedReason ? "blank" : "ai");
    setPosition(afterSectionId === undefined ? END : afterSectionId === null ? START : afterSectionId);
  }, [open, afterSectionId, aiBlockedReason]);

  const layout = getCimLayout(layoutType);
  const canSubmit = title.trim().length > 0 && !!layout && !busy && !(mode === "ai" && aiBlockedReason);

  const submit = () => {
    if (!canSubmit) return;
    onSubmit({
      title: title.trim(),
      layoutType,
      mode,
      brief: mode === "ai" && brief.trim() ? brief.trim() : undefined,
      position: position === START ? "start" : position === END ? "end" : undefined,
      afterSectionId: position !== START && position !== END ? position : null,
      accessTier: tier,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl w-[calc(100vw-2rem)] p-0 gap-0 max-h-[92vh] flex flex-col overflow-hidden">
        <DialogHeader className="px-5 pt-5 pb-3 border-b border-border shrink-0">
          <DialogTitle>Add a section</DialogTitle>
          <DialogDescription>Choose how it looks, name it, and decide whether the AI writes it for you.</DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto md:overflow-hidden md:grid md:grid-cols-[1fr_360px]">
          {/* Layout gallery */}
          <div className="md:overflow-y-auto p-5 md:border-r border-border">
            <LayoutGallery value={layoutType} onSelect={(l) => setLayoutType(l.key)} />
          </div>

          {/* Details */}
          <form
            className="md:overflow-y-auto p-5 space-y-5 border-t md:border-t-0 border-border"
            onSubmit={(e) => { e.preventDefault(); submit(); }}
          >
            {layout && (
              <div className="flex items-center gap-2.5 rounded-lg border border-teal/30 bg-teal/5 px-3 py-2">
                <LayoutIcon layoutType={layout.key} className="h-4 w-4 text-teal shrink-0" />
                <p className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">{layout.label}</span> — {layout.description}
                </p>
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="add-section-title" className="text-xs">Section title</Label>
              <Input
                id="add-section-title"
                autoFocus
                value={title}
                maxLength={200}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Reason for sale"
                data-testid="input-new-section-title"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">Where it goes</Label>
              <Select value={position} onValueChange={setPosition}>
                <SelectTrigger className="h-9 text-sm" data-testid="select-new-section-position">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  <SelectItem value={START}>At the start</SelectItem>
                  {sections.map((s) => (
                    <SelectItem key={s.id} value={s.id}>After “{s.sectionTitle}”</SelectItem>
                  ))}
                  <SelectItem value={END}>At the end</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label className="text-xs">How to fill it</Label>
              <ChoiceCard
                selected={mode === "ai"}
                disabled={!!aiBlockedReason}
                onSelect={() => setMode("ai")}
                icon={<Sparkles className="h-4 w-4" />}
                title="Write it from the deal's information"
                body={aiBlockedReason || "The AI drafts it from everything collected — the interview, documents and financials. About 30 seconds."}
                testId="choice-ai"
              />
              {mode === "ai" && !aiBlockedReason && (
                <Textarea
                  value={brief}
                  onChange={(e) => setBrief(e.target.value)}
                  maxLength={1500}
                  rows={3}
                  className="text-sm resize-none"
                  placeholder="Optional: what should it cover? e.g. “The owner's transition plan and how long they'll stay on.”"
                  data-testid="input-new-section-brief"
                />
              )}
              <ChoiceCard
                selected={mode === "blank"}
                onSelect={() => setMode("blank")}
                icon={<PenLine className="h-4 w-4" />}
                title="Start blank"
                body="An empty section with this layout, ready for you to fill in."
                testId="choice-blank"
              />
            </div>

            <div className="space-y-2">
              <Label className="text-xs">Who can see it</Label>
              <div className="grid grid-cols-2 gap-2">
                <TierButton selected={tier === "teaser"} onClick={() => setTier("teaser")} icon={<Users className="h-3.5 w-3.5" />} label="Every buyer" hint="Teaser and up" />
                <TierButton selected={tier === "full"} onClick={() => setTier("full")} icon={<Lock className="h-3.5 w-3.5" />} label="Full access only" hint="Locked for teaser buyers" />
              </div>
            </div>
          </form>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3 shrink-0 bg-background">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button
            size="sm"
            className="bg-teal text-teal-foreground hover:bg-teal/90 gap-1.5"
            disabled={!canSubmit}
            onClick={submit}
            data-testid="button-add-section-confirm"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : mode === "ai" ? <Sparkles className="h-3.5 w-3.5" /> : null}
            {mode === "ai" ? "Add and write it" : "Add section"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ChoiceCard({
  selected, disabled, onSelect, icon, title, body, testId,
}: { selected: boolean; disabled?: boolean; onSelect: () => void; icon: React.ReactNode; title: string; body: string; testId: string }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      data-testid={testId}
      className={cn(
        "w-full flex items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors disabled:opacity-60 disabled:cursor-not-allowed",
        selected ? "border-teal bg-teal/10" : "border-border hover:bg-muted/40",
      )}
    >
      <span className={cn("mt-0.5 shrink-0", selected ? "text-teal" : "text-muted-foreground")}>{icon}</span>
      <span>
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground leading-snug mt-0.5">{body}</span>
      </span>
    </button>
  );
}

function TierButton({ selected, onClick, icon, label, hint }: { selected: boolean; onClick: () => void; icon: React.ReactNode; label: string; hint: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-lg border px-3 py-2 text-left transition-colors",
        selected ? "border-teal bg-teal/10" : "border-border hover:bg-muted/40",
      )}
    >
      <span className="flex items-center gap-1.5 text-sm font-medium">{icon}{label}</span>
      <span className="block text-[11px] text-muted-foreground mt-0.5">{hint}</span>
    </button>
  );
}
