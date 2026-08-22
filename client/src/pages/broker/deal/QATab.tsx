/**
 * QATab — Buyer Q&A management + FAQ.
 *
 * The FAQ section is a broker-curated list of published answers that the
 * buyer chatbot can draw on. Brokers add, edit, and remove entries here;
 * everything is wired to the existing /api/deals/:dealId/faq and
 * /api/faq/:id endpoints.
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useDeal } from "@/contexts/DealContext";
import { BuyerQAPanel } from "@/components/deal/BuyerQAPanel";
import { PanelError } from "@/components/deal/PanelError";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
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
import { useToast } from "@/hooks/use-toast";
import { Plus, Pencil, Trash2, Loader2, HelpCircle, X, Check } from "lucide-react";

interface FaqItem {
  id: string;
  dealId: string;
  question: string;
  answer: string;
  isPublished: boolean | null;
}

/** Read the server's JSON error body, falling back to a readable default. */
async function readError(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => null);
  return (body && typeof body.error === "string" && body.error) || fallback;
}

export function QATab() {
  const { dealId } = useDeal();
  const { toast } = useToast();
  const qc = useQueryClient();
  const faqKey = ["/api/deals", dealId, "faq"];

  // null = closed, "new" = creating, otherwise the id being edited
  const [editing, setEditing] = useState<"new" | string | null>(null);
  const [draft, setDraft] = useState<{ question: string; answer: string }>({ question: "", answer: "" });
  const [pendingDelete, setPendingDelete] = useState<FaqItem | null>(null);

  const {
    data: faqs = [],
    isLoading,
    error: faqError,
    refetch,
  } = useQuery<FaqItem[]>({
    queryKey: faqKey,
    enabled: !!dealId,
    queryFn: async () => {
      const r = await fetch(`/api/deals/${dealId}/faq`, { credentials: "include" });
      if (!r.ok) throw new Error(await readError(r, "Failed to load FAQ"));
      return r.json();
    },
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: faqKey });

  const closeEditor = () => {
    setEditing(null);
    setDraft({ question: "", answer: "" });
  };

  const createFaq = useMutation({
    mutationFn: async (body: { question: string; answer: string }) => {
      const r = await fetch(`/api/deals/${dealId}/faq`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(await readError(r, "Failed to add FAQ"));
      return r.json();
    },
    onSuccess: () => {
      invalidate();
      closeEditor();
      toast({ title: "FAQ added" });
    },
    onError: (e: Error) => toast({ title: "Couldn't add FAQ", description: e.message, variant: "destructive" }),
  });

  const updateFaq = useMutation({
    mutationFn: async ({ id, ...body }: { id: string; question: string; answer: string }) => {
      const r = await fetch(`/api/faq/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(await readError(r, "Failed to update FAQ"));
      return r.json();
    },
    onSuccess: () => {
      invalidate();
      closeEditor();
      toast({ title: "FAQ updated" });
    },
    onError: (e: Error) => toast({ title: "Couldn't update FAQ", description: e.message, variant: "destructive" }),
  });

  const deleteFaq = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(`/api/faq/${id}`, { method: "DELETE", credentials: "include" });
      if (!r.ok) throw new Error(await readError(r, "Failed to delete FAQ"));
      return r.json();
    },
    onSuccess: () => {
      invalidate();
      toast({ title: "FAQ removed" });
    },
    onError: (e: Error) => toast({ title: "Couldn't remove FAQ", description: e.message, variant: "destructive" }),
    onSettled: () => setPendingDelete(null),
  });

  const saving = createFaq.isPending || updateFaq.isPending;
  const canSave = draft.question.trim().length > 0 && draft.answer.trim().length > 0;

  const startNew = () => {
    setEditing("new");
    setDraft({ question: "", answer: "" });
  };
  const startEdit = (faq: FaqItem) => {
    setEditing(faq.id);
    setDraft({ question: faq.question, answer: faq.answer });
  };
  const save = () => {
    const body = { question: draft.question.trim(), answer: draft.answer.trim() };
    if (editing === "new") createFaq.mutate(body);
    else if (editing) updateFaq.mutate({ id: editing, ...body });
  };

  const editorCard = (
    <div className="p-3 rounded-lg bg-card border border-teal/40 space-y-2">
      <div className="space-y-1">
        <Label className="text-xs">Question</Label>
        <Input
          value={draft.question}
          onChange={(e) => setDraft((d) => ({ ...d, question: e.target.value }))}
          placeholder="e.g. Is the owner willing to stay on after the sale?"
          autoFocus
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Answer</Label>
        <Textarea
          value={draft.answer}
          onChange={(e) => setDraft((d) => ({ ...d, answer: e.target.value }))}
          placeholder="The answer buyers will see…"
          rows={3}
          className="resize-none"
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" className="h-7 text-xs gap-1" onClick={closeEditor} disabled={saving}>
          <X className="h-3 w-3" /> Cancel
        </Button>
        <Button
          size="sm"
          className="h-7 text-xs gap-1 bg-teal text-teal-foreground hover:bg-teal/90"
          onClick={save}
          disabled={!canSave || saving}
        >
          {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
          {editing === "new" ? "Add FAQ" : "Save"}
        </Button>
      </div>
    </div>
  );

  return (
    <div className="max-w-4xl mx-auto px-6 py-6 space-y-6">
      <BuyerQAPanel dealId={dealId} />

      <div className="pt-4 border-t border-border space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <HelpCircle className="h-4 w-4" />
              FAQ
            </h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Pre-answered questions the buyer assistant can use instantly — no seller approval loop.
            </p>
          </div>
          <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={startNew} disabled={editing === "new"}>
            <Plus className="h-3 w-3" /> Add FAQ
          </Button>
        </div>

        {editing === "new" && editorCard}

        {isLoading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : faqError ? (
          <PanelError what="FAQ" onRetry={() => refetch()} />
        ) : faqs.length === 0 && editing !== "new" ? (
          <div className="rounded-lg border border-dashed border-border p-5 text-center">
            <p className="text-sm text-muted-foreground">No FAQ entries yet.</p>
            <p className="text-xs text-muted-foreground/60 mt-1">
              Add the questions every buyer asks so the assistant can answer them on the spot.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {faqs.map((faq) =>
              editing === faq.id ? (
                <div key={faq.id}>{editorCard}</div>
              ) : (
                <div key={faq.id} className="p-3 rounded-lg bg-card border border-border group">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{faq.question}</p>
                      <p className="text-xs text-muted-foreground mt-1 whitespace-pre-wrap">{faq.answer}</p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 w-7 p-0"
                        onClick={() => startEdit(faq)}
                        aria-label="Edit FAQ"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 w-7 p-0 text-muted-foreground hover:text-red-400"
                        onClick={() => setPendingDelete(faq)}
                        aria-label="Delete FAQ"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </div>
              ),
            )}
          </div>
        )}
      </div>

      <AlertDialog open={!!pendingDelete} onOpenChange={(open) => { if (!open) setPendingDelete(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this FAQ?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete ? `"${pendingDelete.question}"` : "This entry"} will be permanently removed and
              the buyer assistant will stop using it. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteFaq.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteFaq.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (pendingDelete) deleteFaq.mutate(pendingDelete.id);
              }}
            >
              {deleteFaq.isPending ? (
                <><Loader2 className="h-3 w-3 mr-1 animate-spin" />Removing…</>
              ) : (
                <><Trash2 className="h-3 w-3 mr-1" />Remove</>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
