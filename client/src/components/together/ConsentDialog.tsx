/**
 * Before Cimple first listens in a session (D15): one line reminding the
 * broker to tell the seller that Cimple is taking notes. Until the broker
 * confirms, nothing spoken is sent (the server refuses it too).
 */
import { useState } from "react";
import { Loader2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { listenCopy } from "@shared/together";

export function ConsentDialog({
  open,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <AlertDialog open={open} onOpenChange={(o) => { if (!o && !busy) onCancel(); }}>
      <AlertDialogContent className="sm:max-w-md" data-testid="consent-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Before Cimple listens</AlertDialogTitle>
          <AlertDialogDescription className="text-sm text-foreground/90">{listenCopy("consent")}</AlertDialogDescription>
        </AlertDialogHeader>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy} data-testid="button-consent-cancel">Cancel</AlertDialogCancel>
          <Button
            className="bg-teal text-teal-foreground hover:bg-teal/90"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onConfirm();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
            data-testid="button-consent-confirm"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}They know — start
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
