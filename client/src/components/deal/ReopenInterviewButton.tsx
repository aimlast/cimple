/**
 * "Reopen interview" — for a finished interview that should keep going (for
 * example one that ended too early). The deal goes back to "interview in
 * progress": the seller's link opens the conversation again (picking up
 * from what's on file) instead of the "complete" card, and the interview
 * counts as finished again when it next ends.
 */
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { RotateCcw, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

export function ReopenInterviewButton({ dealId }: { dealId: string }) {
  const [open, setOpen] = useState(false);
  const { toast } = useToast();
  const reopen = useMutation({
    mutationFn: async () => (await apiRequest("POST", `/api/interview/${dealId}/reopen`)).json(),
    onSuccess: () => {
      setOpen(false);
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId] });
      toast({ title: "Interview reopened", description: "The seller's link opens the conversation again." });
    },
    onError: (e) => toast({ title: "Couldn't reopen the interview", description: (e as Error).message, variant: "destructive" }),
  });
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 text-xs gap-1.5 text-muted-foreground hover:text-foreground"
        onClick={() => setOpen(true)}
        data-testid="button-reopen-interview"
      >
        <RotateCcw className="h-3 w-3" /> Reopen interview
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reopen the interview?</AlertDialogTitle>
            <AlertDialogDescription>
              The interview will show as in progress again. The seller's link opens the conversation, which picks up from
              everything already collected — nothing is lost. It counts as complete again when it next ends.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={reopen.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                reopen.mutate();
              }}
              disabled={reopen.isPending}
              data-testid="button-confirm-reopen-interview"
            >
              {reopen.isPending && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
              Reopen interview
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
