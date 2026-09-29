/**
 * "Open items from the interview" — the to-dos the interview wrote down
 * and nobody could see.
 *
 * When the seller offers a document, can't answer a question or leaves a
 * mandatory probe unasked, the interview tells them "I'll note it so it
 * doesn't get lost" and saves a task. Nothing showed those tasks, so the
 * follow-through never happened. This card lists every open one — document
 * requests, follow-ups, questions it couldn't cover, and the seller's own
 * change requests on the CIM review — with Done / Not needed. The seller
 * sees their share (documents and look-ups) on their own portal.
 */
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronUp, FileText, HelpCircle, ListTodo, Loader2, MessageSquareWarning, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { openInterviewItems, openItemTaskIds, SELLER_REVIEW_TASK_CREATOR } from "@shared/seller-portal";
import type { Task } from "@shared/schema";

const KIND: Record<string, { label: string; icon: typeof FileText; seller?: boolean }> = {
  document_request: { label: "Document", icon: FileText, seller: true },
  follow_up: { label: "Follow up", icon: Search, seller: true },
  skipped_question: { label: "Not answered", icon: HelpCircle },
};

const VISIBLE = 6;

export function tasksKey(dealId: string) {
  return ["/api/deals", dealId, "tasks"] as const;
}

export function OpenInterviewItemsCard({ dealId, hideWhenEmpty = true }: { dealId: string; hideWhenEmpty?: boolean }) {
  const { toast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [openDetail, setOpenDetail] = useState<string | null>(null);
  const { data: tasks = [], isLoading, error } = useQuery<Task[]>({
    queryKey: tasksKey(dealId),
    queryFn: async () => (await apiRequest("GET", `/api/deals/${dealId}/tasks`)).json(),
  });
  const update = useMutation({
    // (Copies of the item an earlier turn re-created close with it.)
    mutationFn: async ({ id, status }: { id: string; status: "completed" | "authorized_skip" }) => {
      const item = tasks.find((t) => t.id === id);
      const ids = item ? openItemTaskIds(tasks, item) : [id];
      for (const taskId of ids) await apiRequest("PATCH", `/api/tasks/${taskId}`, { status });
      return ids.length;
    },
    onSuccess: (_d, v) => {
      queryClient.invalidateQueries({ queryKey: tasksKey(dealId) });
      toast({ title: v.status === "completed" ? "Marked done" : "Marked not needed" });
    },
    onError: (e: Error) => toast({ title: "Couldn't update the item", description: e.message.replace(/^\d{3}:\s*/, ""), variant: "destructive" }),
  });

  const items = openInterviewItems(tasks);
  if (isLoading) return null;
  if (error) {
    return (
      <div className="rounded-lg border border-border bg-card p-4 text-xs text-muted-foreground">
        Couldn't load the interview's open items.
      </div>
    );
  }
  if (items.length === 0 && hideWhenEmpty) return null;
  const shown = expanded ? items : items.slice(0, VISIBLE);

  return (
    <div className="rounded-lg border border-border bg-card p-4" data-testid="card-open-interview-items">
      <div className="flex items-start gap-3">
        <ListTodo className="h-[1.125rem] w-[1.125rem] text-teal mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium">
            Open items from the interview <span className="text-muted-foreground font-normal tabular-nums">{items.length}</span>
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            What the interview promised to follow up on. Documents and look-ups also show on the seller's portal.
          </p>
          {items.length === 0 ? (
            <p className="text-xs text-muted-foreground/70 mt-3">Nothing open.</p>
          ) : (
            <ul className="mt-3 divide-y divide-border rounded-md border border-border">
              {shown.map((t) => {
                const review = t.createdBy === SELLER_REVIEW_TASK_CREATOR;
                const kind = review ? { label: "Seller's request", icon: MessageSquareWarning, seller: false } : KIND[t.type] ?? { label: "To do", icon: ListTodo };
                const Icon = kind.icon;
                const detailOpen = openDetail === t.id;
                return (
                  <li key={t.id} className="px-3 py-2.5" data-testid={`open-item-${t.id}`}>
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                      <div className="flex items-start gap-2 min-w-0">
                        <Icon className="h-3.5 w-3.5 mt-0.5 text-muted-foreground shrink-0" />
                        <div className="min-w-0">
                          <p className="text-sm leading-snug break-words">{t.title}</p>
                          <p className="text-[11px] text-muted-foreground mt-0.5">
                            {kind.label}
                            {kind.seller ? " · on the seller's to-do list" : ""}
                            {t.createdAt ? ` · ${new Date(t.createdAt).toLocaleDateString()}` : ""}
                          </p>
                          {t.description && (
                            <button
                              type="button"
                              className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                              onClick={() => setOpenDetail(detailOpen ? null : t.id)}
                            >
                              {detailOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                              {detailOpen ? "Hide details" : "Details"}
                            </button>
                          )}
                          {detailOpen && t.description && (
                            <p className="mt-1 text-xs text-muted-foreground whitespace-pre-wrap border-l-2 border-border pl-2">{t.description}</p>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0 pl-5 sm:pl-0">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs gap-1"
                          disabled={update.isPending}
                          onClick={() => update.mutate({ id: t.id, status: "completed" })}
                          data-testid={`button-item-done-${t.id}`}
                        >
                          {update.isPending && update.variables?.id === t.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                          Done
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 text-xs gap-1 text-muted-foreground"
                          disabled={update.isPending}
                          onClick={() => update.mutate({ id: t.id, status: "authorized_skip" })}
                          data-testid={`button-item-dismiss-${t.id}`}
                        >
                          <X className="h-3 w-3" /> Not needed
                        </Button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {items.length > VISIBLE && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="mt-2 flex items-center gap-1 text-xs text-teal hover:underline"
            >
              {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              {expanded ? "Show fewer" : `Show ${items.length - VISIBLE} more`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
