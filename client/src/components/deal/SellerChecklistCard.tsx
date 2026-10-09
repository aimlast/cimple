/**
 * "Seller document checklist" — the broker's view of the list the seller
 * works through on /seller/:token/documents.
 *
 * The server could always add, remove, verify and waive checklist rows, but
 * no broker screen called it: uploads sat on "Pending review" forever, and a
 * seller with no lease / no A/R / no debt could never finish the Documents
 * step. Here the broker verifies files, marks rows not needed, asks again
 * when the seller said "I don't have this", adds a request, and leaves a
 * note the seller sees.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Circle,
  Clock,
  HelpCircle,
  ListChecks,
  Loader2,
  MessageSquare,
  Plus,
  RotateCcw,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { checklistCounts, sellerUnavailableReason, withSellerUnavailableNote, withoutSellerUnavailableNote } from "@shared/seller-portal";
import type { DealDocumentRequirement, Document as DocType } from "@shared/schema";
import type { RoomItemRow } from "@shared/vdr-api";
import { apiErrorText } from "./SellerReviewControls";

const CATEGORY_LABELS: Record<string, string> = {
  financial: "Financial",
  tax: "Tax",
  legal: "Legal",
  compliance: "Compliance",
  operational: "Operational",
};
const CATEGORY_ORDER = ["financial", "tax", "legal", "compliance", "operational"];

export function checklistKey(dealId: string) {
  return ["/api/deals", dealId, "document-requirements"] as const;
}

type Filter = "attention" | "all";

/**
 * `variant="room"` (the Data room's To do › Seller checklist): always open,
 * and each row says where its file is in the data room — Missing ·
 * Uploaded, not in the room (Put in the room) · In the room, not shared
 * (Share…) · Shared. Rows the broker added from a buyer's request say so
 * (the seller never sees who asked) with their "Needed by" date.
 */
export function SellerChecklistCard({ dealId, variant = "card", roomItems, onOpenItem }: { dealId: string; variant?: "card" | "room"; roomItems?: RoomItemRow[]; onOpenItem?: (itemId: string) => void }) {
  const { toast } = useToast();
  const room = variant === "room";
  const [open, setOpen] = useState(room);
  const [filter, setFilter] = useState<Filter>(room ? "all" : "attention");
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newCategory, setNewCategory] = useState("financial");
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [noteText, setNoteText] = useState("");

  const { data: rows = [], isLoading, error } = useQuery<DealDocumentRequirement[]>({
    queryKey: checklistKey(dealId),
    queryFn: async () => (await apiRequest("GET", `/api/deals/${dealId}/document-requirements`)).json(),
  });
  const { data: docs = [] } = useQuery<DocType[]>({
    queryKey: ["/api/deals", dealId, "documents"],
    queryFn: async () => {
      const r = await fetch(`/api/deals/${dealId}/documents`);
      if (!r.ok) throw new Error("Failed to load documents");
      return r.json();
    },
    enabled: open,
  });
  const docName = useMemo(() => new Map(docs.map((d) => [d.id, d.name])), [docs]);
  const roomByDoc = useMemo(() => new Map((roomItems ?? []).filter((i) => !i.removed && i.documentId).map((i) => [i.documentId!, i])), [roomItems]);
  const place = useMutation({
    mutationFn: async (documentId: string) => (await apiRequest("POST", `/api/deals/${dealId}/data-room/items`, { documentId })).json(),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "data-room"] }); toast({ title: "Put in the room" }); },
    onError: (e) => toast({ title: "Couldn't put it in the room", description: apiErrorText(e), variant: "destructive" }),
  });
  const roomLine = (r: DealDocumentRequirement) => {
    if (!room) return null;
    if (!r.uploadedFileId) return <span className="text-[11px] text-muted-foreground">Data room: missing</span>;
    const item = roomByDoc.get(r.uploadedFileId);
    if (!item) return (
      <span className="text-[11px] text-muted-foreground">Data room: uploaded, not in the room · <button className="text-teal underline-offset-2 hover:underline" disabled={place.isPending} onClick={() => place.mutate(r.uploadedFileId!)}>Put in the room</button></span>
    );
    if (!item.sharing.shared) return (
      <span className="text-[11px] text-muted-foreground">Data room: {item.number} · not shared · <button className="text-teal underline-offset-2 hover:underline" onClick={() => onOpenItem?.(item.id)}>Share…</button></span>
    );
    return <span className="text-[11px] text-muted-foreground">Data room: {item.number} · shared with {item.sharing.label.charAt(0).toLowerCase() + item.sharing.label.slice(1)}</span>;
  };

  const invalidate = () => queryClient.invalidateQueries({ queryKey: checklistKey(dealId) });
  const patch = useMutation({
    mutationFn: async ({ id, body }: { id: string; body: Record<string, unknown>; done: string }) =>
      (await apiRequest("PATCH", `/api/deals/${dealId}/document-requirements/${id}`, body)).json(),
    onSuccess: (_d, v) => {
      invalidate();
      toast({ title: v.done });
    },
    onError: (e) => toast({ title: "Couldn't update the checklist", description: apiErrorText(e), variant: "destructive" }),
  });
  const remove = useMutation({
    mutationFn: async (id: string) => (await apiRequest("DELETE", `/api/deals/${dealId}/document-requirements/${id}`)).json(),
    onSuccess: () => {
      invalidate();
      toast({ title: "Request removed" });
    },
    onError: (e) => toast({ title: "Couldn't remove it", description: apiErrorText(e), variant: "destructive" }),
  });
  const add = useMutation({
    mutationFn: async () =>
      (await apiRequest("POST", `/api/deals/${dealId}/document-requirements`, {
        documentName: newName.trim(),
        category: newCategory,
        isRequired: true,
        status: "missing",
        sortOrder: rows.length + 1,
      })).json(),
    onSuccess: () => {
      invalidate();
      setAdding(false);
      setNewName("");
      toast({ title: "Added to the seller's checklist" });
    },
    onError: (e) => toast({ title: "Couldn't add it", description: apiErrorText(e), variant: "destructive" }),
  });

  if (isLoading) return null;
  if (error) {
    return <div className="rounded-lg border border-border bg-card p-4 text-xs text-muted-foreground">Couldn't load the seller's document checklist.</div>;
  }

  const counts = checklistCounts(rows);
  const toReview = rows.filter((r) => r.status === "uploaded");
  const unavailable = rows.filter((r) => r.status === "unavailable" && r.isRequired);
  const attention = rows.filter((r) => r.status === "uploaded" || (r.status === "unavailable" && r.isRequired));
  const listed = filter === "attention" ? attention : rows;
  const grouped = CATEGORY_ORDER.map((c) => ({ c, items: listed.filter((r) => r.category === c) }))
    .concat([{ c: "other", items: listed.filter((r) => !CATEGORY_ORDER.includes(r.category)) }])
    .filter((g) => g.items.length > 0);

  const summary = [
    `${counts.requiredUploaded} of ${counts.requiredTotal} required uploaded`,
    toReview.length > 0 ? `${toReview.length} to review` : null,
    unavailable.length > 0 ? `${unavailable.length} the seller doesn't have` : null,
  ].filter(Boolean).join(" · ");

  return (
    <div className="rounded-lg border border-border bg-card" data-testid="card-seller-checklist">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-start gap-3 p-4 text-left"
        aria-expanded={open}
        data-testid="toggle-seller-checklist"
      >
        <ListChecks className="h-[1.125rem] w-[1.125rem] text-teal mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium">Seller document checklist</p>
          <p className="text-xs text-muted-foreground mt-0.5">{rows.length === 0 ? "No documents requested yet." : summary}</p>
        </div>
        {(toReview.length > 0 || unavailable.length > 0) && (
          <span className="text-2xs font-medium px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 shrink-0">
            {toReview.length + unavailable.length} need you
          </span>
        )}
        {open ? <ChevronUp className="h-4 w-4 text-muted-foreground shrink-0" /> : <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />}
      </button>

      {open && (
        <div className="border-t border-border px-4 pb-4 pt-3 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-md border border-border p-0.5 bg-muted/30" role="tablist">
              {(["attention", "all"] as Filter[]).map((f) => (
                <button
                  key={f}
                  role="tab"
                  aria-selected={filter === f}
                  onClick={() => setFilter(f)}
                  className={`rounded px-2.5 py-1 text-[11px] ${filter === f ? "bg-background text-foreground shadow-sm font-medium" : "text-muted-foreground hover:text-foreground"}`}
                >
                  {f === "attention" ? `Needs you (${attention.length})` : `All (${rows.length})`}
                </button>
              ))}
            </div>
            <Button size="sm" variant="outline" className="h-7 text-xs gap-1 ml-auto" onClick={() => setAdding((v) => !v)} data-testid="button-add-requirement">
              <Plus className="h-3 w-3" /> Request a document
            </Button>
          </div>

          {adding && (
            <div className="rounded-md border border-border p-3 flex flex-col gap-2 sm:flex-row sm:items-center">
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g. Equipment lease for the forklift"
                className="h-8 text-xs flex-1"
                maxLength={160}
              />
              <Select value={newCategory} onValueChange={setNewCategory}>
                <SelectTrigger className="h-8 text-xs sm:w-36"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CATEGORY_ORDER.map((c) => <SelectItem key={c} value={c}>{CATEGORY_LABELS[c]}</SelectItem>)}
                </SelectContent>
              </Select>
              <Button size="sm" className="h-8 text-xs bg-teal text-teal-foreground hover:bg-teal/90" disabled={newName.trim().length < 3 || add.isPending} onClick={() => add.mutate()}>
                {add.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Add"}
              </Button>
            </div>
          )}

          {listed.length === 0 ? (
            <p className="text-xs text-muted-foreground py-2">
              {filter === "attention" ? "Nothing waiting on you — uploads to review and items the seller doesn't have show here." : "No documents requested yet."}
            </p>
          ) : (
            grouped.map((g) => (
              <div key={g.c}>
                <p className="text-2xs font-medium uppercase tracking-wide text-muted-foreground mb-1">{CATEGORY_LABELS[g.c] ?? "Other"}</p>
                <ul className="divide-y divide-border rounded-md border border-border">
                  {g.items.map((r) => {
                    const reason = sellerUnavailableReason(r.notes);
                    const brokerNote = withoutSellerUnavailableNote(r.notes);
                    const busy = patch.isPending && patch.variables?.id === r.id;
                    return (
                      <li key={r.id} className="px-3 py-2.5" data-testid={`requirement-${r.id}`}>
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                          <div className="flex items-start gap-2 min-w-0">
                            <StatusIcon status={r.status} />
                            <div className="min-w-0">
                              <p className={`text-sm leading-snug break-words ${r.isRequired ? "" : "text-muted-foreground"}`}>
                                {r.documentName}
                                {!r.isRequired && <span className="text-[11px] ml-1.5">· not needed</span>}
                              </p>
                              <p className="text-[11px] text-muted-foreground mt-0.5 break-words">
                                {statusLabel(r.status, r.uploadedBy)}
                                {r.uploadedFileId && docName.get(r.uploadedFileId) ? ` · ${docName.get(r.uploadedFileId)}` : ""}
                              </p>
                              {room && r.source === "buyer_request" && (
                                <p className="text-[11px] text-teal mt-0.5">Asked for by a buyer{r.neededBy ? ` · needed by ${new Date(r.neededBy).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : ""}</p>
                              )}
                              {room && <p className="mt-0.5">{roomLine(r)}</p>}
                              {reason !== null && (
                                <p className="text-xs text-amber-600 mt-1 break-words">Seller: “{reason || "I don't have this"}”</p>
                              )}
                              {brokerNote && <p className="text-[11px] text-muted-foreground mt-1 break-words">Your note: {brokerNote}</p>}
                            </div>
                          </div>
                          <div className="flex flex-wrap items-center gap-1 shrink-0 pl-6 sm:pl-0">
                            {r.status === "uploaded" && (
                              <Button size="sm" variant="outline" className="h-7 text-xs gap-1" disabled={busy}
                                onClick={() => patch.mutate({ id: r.id, body: { status: "verified" }, done: "Verified" })}
                                data-testid={`button-verify-${r.id}`}>
                                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <ShieldCheck className="h-3 w-3" />} Verify
                              </Button>
                            )}
                            {r.status === "unavailable" && (
                              <Button size="sm" variant="outline" className="h-7 text-xs gap-1" disabled={busy}
                                onClick={() => patch.mutate({ id: r.id, body: { status: "missing" }, done: "Asked the seller again" })}
                                data-testid={`button-ask-again-${r.id}`}>
                                <RotateCcw className="h-3 w-3" /> Ask again
                              </Button>
                            )}
                            {r.isRequired ? (
                              <Button size="sm" variant="ghost" className="h-7 text-xs gap-1 text-muted-foreground" disabled={busy}
                                onClick={() => patch.mutate({ id: r.id, body: { isRequired: false }, done: "Marked not needed" })}
                                data-testid={`button-not-needed-${r.id}`}>
                                <X className="h-3 w-3" /> Not needed
                              </Button>
                            ) : (
                              <Button size="sm" variant="ghost" className="h-7 text-xs gap-1 text-muted-foreground" disabled={busy}
                                onClick={() => patch.mutate({ id: r.id, body: { isRequired: true }, done: "Required again" })}>
                                Require it
                              </Button>
                            )}
                            <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-muted-foreground" aria-label="Note for the seller"
                              onClick={() => { setNoteFor(noteFor === r.id ? null : r.id); setNoteText(brokerNote ?? ""); }}>
                              <MessageSquare className="h-3.5 w-3.5" />
                            </Button>
                            {r.source === "manual" && (
                              <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-muted-foreground hover:text-red-400" aria-label="Remove request"
                                disabled={remove.isPending} onClick={() => remove.mutate(r.id)}>
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            )}
                          </div>
                        </div>
                        {noteFor === r.id && (
                          <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-start">
                            <Textarea value={noteText} onChange={(e) => setNoteText(e.target.value)} rows={2} className="text-xs flex-1"
                              placeholder="Shown to the seller under this item, e.g. “The last 3 years, not just this one”" maxLength={500} />
                            <Button size="sm" className="h-8 text-xs" disabled={busy}
                              onClick={() => {
                                // (The seller's "I don't have this" line stays under the broker's note.)
                                const kept = reason !== null ? withSellerUnavailableNote(noteText.trim(), reason) : noteText.trim();
                                patch.mutate({ id: r.id, body: { notes: kept || null }, done: "Note saved" });
                                setNoteFor(null);
                              }}>
                              Save note
                            </Button>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function statusLabel(status: string, uploadedBy?: string | null): string {
  switch (status) {
    case "uploaded": return uploadedBy === "broker" ? "Added by you — verify when you have checked it" : "Uploaded by the seller — waiting for your review";
    case "verified": return "Verified";
    case "unavailable": return "The seller doesn't have this";
    default: return "Not uploaded yet";
  }
}

function StatusIcon({ status }: { status: string }) {
  if (status === "verified") return <Check className="h-3.5 w-3.5 mt-0.5 text-success shrink-0" />;
  if (status === "uploaded") return <Clock className="h-3.5 w-3.5 mt-0.5 text-amber-500 shrink-0" />;
  if (status === "unavailable") return <HelpCircle className="h-3.5 w-3.5 mt-0.5 text-amber-500 shrink-0" />;
  return <Circle className="h-3.5 w-3.5 mt-0.5 text-muted-foreground/40 shrink-0" />;
}

