/**
 * The teaser editor's two dialogs:
 *   AddTeaserBlockDialog    — a title, a teaser layout, then blank or "Write it with AI"
 *   ChangeTeaserLayoutDialog — another teaser layout; keep the words (AI) or start blank
 * Only teaser layouts are offered (no tables, money charts, maps, photos or
 * org charts — they identify a business).
 */
import { useEffect, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { LayoutGallery } from "@/components/cim-builder/LayoutGallery";
import { TEASER_LAYOUTS } from "@shared/teaser";
import { layoutLabel } from "@shared/cim-layouts";
import { cn } from "@/lib/utils";

/** What a broker can add (the revenue trend is made from the facts; it comes with the templates). */
export const ADDABLE_TEASER_LAYOUTS: readonly string[] = TEASER_LAYOUTS.filter((l) => l !== "line_chart");
/** What Cimple can write (text, lists, highlights). */
export const AI_WRITABLE: ReadonlySet<string> = new Set(["prose_highlight", "callout_list", "numbered_list", "icon_stat_row", "stat_callout", "tag_cloud", "metric_grid"]);

export function AddTeaserBlockDialog({
  open, onOpenChange, busy, onSubmit,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  busy: boolean;
  onSubmit: (v: { title: string; layoutType: string; mode: "blank" | "ai"; brief: string | null }) => void;
}) {
  const [title, setTitle] = useState("");
  const [layout, setLayout] = useState<string>("callout_list");
  const [mode, setMode] = useState<"blank" | "ai">("blank");
  const [brief, setBrief] = useState("");
  useEffect(() => {
    if (open) { setTitle(""); setLayout("callout_list"); setMode("blank"); setBrief(""); }
  }, [open]);
  const aiOk = AI_WRITABLE.has(layout) && layout !== "metric_grid";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add a block</DialogTitle>
          <DialogDescription>Pick how it looks. Start it blank, or let Cimple write it from the anonymous Blind CIM.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="teaser-new-title" className="text-xs">Title</Label>
            <Input id="teaser-new-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Why it's a strong platform" maxLength={120} autoFocus />
          </div>
          <LayoutGallery value={layout} onSelect={(l) => setLayout(l.key)} only={ADDABLE_TEASER_LAYOUTS} />
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="How to start it">
            {(["blank", "ai"] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                disabled={m === "ai" && !aiOk}
                onClick={() => setMode(m)}
                className={cn("rounded-lg border px-3 py-2.5 text-left text-xs transition-colors disabled:opacity-40", mode === m ? "border-teal bg-teal/10" : "border-border hover:border-teal/40")}
              >
                <span className="block text-sm font-medium">{m === "blank" ? "Start it blank" : "Write it with AI"}</span>
                <span className="text-muted-foreground">{m === "blank" ? "You fill it in." : aiOk ? "About 15 seconds. You check it before buyers see it." : `Cimple doesn't write a ${layoutLabel(layout).toLowerCase()}.`}</span>
              </button>
            ))}
          </div>
          {mode === "ai" && aiOk && (
            <div className="space-y-1.5">
              <Label className="text-xs">What should it say? (optional)</Label>
              <Textarea value={brief} onChange={(e) => setBrief(e.target.value)} rows={2} maxLength={600} className="resize-none text-xs" placeholder="e.g. The growth room in the current premises." />
            </div>
          )}
        </div>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            className="gap-1.5 bg-teal text-teal-foreground hover:bg-teal/90"
            disabled={busy || (mode === "ai" && !aiOk)}
            onClick={() => onSubmit({ title: title.trim(), layoutType: layout, mode: mode === "ai" && aiOk ? "ai" : "blank", brief: brief.trim() || null })}
            data-testid="button-teaser-add-block-confirm"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : mode === "ai" ? <Sparkles className="h-4 w-4" /> : null} Add the block
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const SAME_FAMILY = [new Set(["callout_list", "numbered_list"]), new Set(["metric_grid", "icon_stat_row"])];
function sameFamily(a: string, b: string): boolean {
  return a === b || SAME_FAMILY.some((f) => f.has(a) && f.has(b));
}

export function ChangeTeaserLayoutDialog({
  open, onOpenChange, current, title, busy, onChoose,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  current: string;
  title: string;
  busy: boolean;
  onChoose: (layoutType: string, convert: "blank" | "ai") => void;
}) {
  const [layout, setLayout] = useState(current);
  useEffect(() => { if (open) setLayout(current); }, [open, current]);
  const keeps = sameFamily(current, layout);
  const aiOk = AI_WRITABLE.has(layout) && AI_WRITABLE.has(current) && layout !== "metric_grid";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Change the layout of “{title}”</DialogTitle>
          <DialogDescription>
            {keeps ? "This layout keeps the block's words." : aiOk ? "Cimple can rewrite the block in the new layout, keeping its meaning — or you can start it blank." : "The block starts blank in this layout. Undo brings the old one back."}
          </DialogDescription>
        </DialogHeader>
        <LayoutGallery value={layout} currentLayout={current} onSelect={(l) => setLayout(l.key)} only={ADDABLE_TEASER_LAYOUTS} />
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          {!keeps && aiOk && (
            <Button variant="outline" disabled={busy || layout === current} onClick={() => onChoose(layout, "blank")}>Start it blank</Button>
          )}
          <Button
            className="gap-1.5 bg-teal text-teal-foreground hover:bg-teal/90"
            disabled={busy || layout === current}
            onClick={() => onChoose(layout, !keeps && aiOk ? "ai" : "blank")}
            data-testid="button-teaser-change-layout"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : !keeps && aiOk ? <Sparkles className="h-4 w-4" /> : null}
            {!keeps && aiOk ? "Rewrite in this layout" : "Use this layout"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
