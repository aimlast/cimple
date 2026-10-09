/**
 * FigureSheet — a figure's note on a phone: a bottom sheet (Radix Dialog),
 * at most 85% of the screen, with a drag handle and ✕. Same body as the
 * popover. Paper colours (theme-locked).
 */
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";

export function FigureSheet({ open, onOpenChange, title, children }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; children: ReactNode }) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          className="cim-doc fig-sheet fixed inset-x-0 bottom-0 z-50 max-h-[85vh] overflow-y-auto rounded-t-2xl border-t border-[#E3DED0] bg-[#FBF9F4] px-4 pb-6 pt-2 shadow-2xl outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom"
          aria-describedby={undefined}
        >
          <div aria-hidden className="mx-auto mb-2 h-1 w-10 rounded-full bg-[#D8D2C2]" />
          <div className="mb-1 flex items-start justify-between gap-3">
            <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
            <span />
            <DialogPrimitive.Close aria-label="Close" className="-mr-1 rounded p-1.5 text-[#6B665C] hover:bg-[#F2EEE3]">
              <X className="h-4 w-4" />
            </DialogPrimitive.Close>
          </div>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
