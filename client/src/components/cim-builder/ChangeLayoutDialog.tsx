/**
 * ChangeLayoutDialog — pick a new layout for a section. Layouts with the same
 * data shape switch instantly; otherwise the broker chooses "Convert with AI"
 * (moves the content into the new layout) or "Start blank". Either way the
 * previous version stays in the section's undo history.
 */
import { useEffect, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { getCimLayout, layoutLabel, sameLayoutFamily } from "@shared/cim-layouts";
import { LayoutGallery } from "./LayoutGallery";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentLayout: string;
  sectionTitle: string;
  aiBlockedReason?: string | null;
  busy: boolean;
  onChoose: (layoutType: string, convert: "ai" | "blank") => void;
}

export function ChangeLayoutDialog({ open, onOpenChange, currentLayout, sectionTitle, aiBlockedReason, busy, onChoose }: Props) {
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => { if (open) setPicked(null); }, [open]);

  const target = picked && picked !== currentLayout ? getCimLayout(picked) : undefined;
  const instant = !!target && sameLayoutFamily(currentLayout, target.key);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl w-[calc(100vw-2rem)] p-0 gap-0 max-h-[90vh] flex flex-col overflow-hidden">
        <DialogHeader className="px-5 pt-5 pb-3 border-b border-border shrink-0">
          <DialogTitle>Change layout</DialogTitle>
          <DialogDescription>
            “{sectionTitle}” is a <span className="text-foreground">{layoutLabel(currentLayout)}</span> today. Pick how it should look instead.
          </DialogDescription>
        </DialogHeader>
        <div className="flex-1 min-h-0 overflow-y-auto p-5">
          <LayoutGallery value={picked ?? currentLayout} currentLayout={currentLayout} onSelect={(l) => setPicked(l.key)} columns={3} />
        </div>
        <div className="border-t border-border px-5 py-3 shrink-0 flex flex-col sm:flex-row sm:items-center gap-3 justify-between bg-background">
          <p className="text-xs text-muted-foreground">
            {!target
              ? "Choose a different layout."
              : instant
                ? `${target.label} uses the same data — your content carries straight over.`
                : aiBlockedReason
                  ? aiBlockedReason
                  : `The AI can move your content into ${target.label.toLowerCase()} for you. Undo brings the current version back.`}
          </p>
          <div className="flex gap-2 justify-end shrink-0">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
            {target && !instant && (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => onChoose(target.key, "blank")} data-testid="button-layout-blank">
                Start it blank
              </Button>
            )}
            {target && (
              <Button
                size="sm"
                className="bg-teal text-teal-foreground hover:bg-teal/90 gap-1.5"
                disabled={busy || (!instant && !!aiBlockedReason)}
                onClick={() => onChoose(target.key, instant ? "blank" : "ai")}
                data-testid="button-layout-convert"
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : !instant ? <Sparkles className="h-3.5 w-3.5" /> : null}
                {instant ? "Switch layout" : "Convert with AI"}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
