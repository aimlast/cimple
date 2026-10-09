/**
 * Inline editors on a coverage-board row.
 *
 * ValueEditor — "Add answer" / "Edit": the broker's own edit of a fact
 * (PUT /api/deals/:dealId/information/facts/:key — final, "Your edit"; the
 * replaced value stays as another value). A multi-member item asks which
 * meaning the answer is ("EBITDA · Net income · Gross profit"), so a figure
 * is never written under another measure's key.
 *
 * NoteEditor — a private note on the item (broker only: never in the CIM,
 * never sent to the seller's interview or an email, hidden while the seller
 * can see the screen).
 */
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { boardRequest, invalidateCoverage } from "@/hooks/useCoverageBoard";
import type { CoverageItem } from "@shared/coverage-board";

function capitalise(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

export function ValueEditor({
  dealId,
  item,
  initialValue,
  mode,
  onDone,
  onCancel,
}: {
  dealId: string;
  item: CoverageItem;
  initialValue?: string | null;
  mode: "add" | "edit";
  onDone?: () => void;
  onCancel: () => void;
}) {
  const { toast } = useToast();
  const writable = item.members.filter((m) => m.writable);
  const startKey = item.valueKey && writable.some((m) => m.key === item.valueKey) ? item.valueKey : writable[0]?.key ?? "";
  const [memberKey, setMemberKey] = useState(startKey);
  const [value, setValue] = useState(initialValue ?? "");
  const [saving, setSaving] = useState(false);

  if (writable.length === 0) {
    return (
      <div className="mt-2 rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
        This one is your own calculation — change it on the deal's Financials tab.
        <div className="mt-2"><Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onCancel}>Close</Button></div>
      </div>
    );
  }

  const save = async () => {
    const v = value.trim();
    if (!v || !memberKey) return;
    setSaving(true);
    try {
      await boardRequest("PUT", `/api/deals/${dealId}/information/facts/${encodeURIComponent(memberKey)}`, { value: v }, "Couldn't save the answer");
      invalidateCoverage(dealId);
      toast({ title: mode === "add" ? "Answer added" : "Saved", description: `${item.label} is on file as your edit.` });
      onDone?.();
    } catch (e) {
      toast({ title: "Couldn't save", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-2 rounded-md border border-teal/30 bg-teal/5 p-3 space-y-2" data-testid={`editor-${item.id}`} onPointerDown={(e) => e.stopPropagation()}>
      <p className="text-xs font-medium">{mode === "add" ? "What's the answer?" : "Edit what's on file"}</p>
      {writable.length > 1 && (
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Which of these is it?">
          {writable.map((m) => (
            <button
              key={m.key}
              type="button"
              role="radio"
              aria-checked={memberKey === m.key}
              onClick={() => setMemberKey(m.key)}
              className={`rounded-full border px-2.5 py-1 text-[11px] ${memberKey === m.key ? "border-teal bg-teal/15 text-foreground" : "border-border text-muted-foreground hover:text-foreground"}`}
            >
              {capitalise(m.label)}
            </button>
          ))}
        </div>
      )}
      <Textarea
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={item.ask ? `e.g. the answer to "${item.ask}"` : "Type the answer"}
        className="min-h-[3.5rem] text-sm bg-background"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void save();
          if (e.key === "Escape") onCancel();
        }}
      />
      <p className="text-[11px] text-muted-foreground">Saved as your edit — it stands over what any source says, and the old value is kept.</p>
      <div className="flex gap-2">
        <Button size="sm" className="h-7 text-xs bg-teal text-teal-foreground hover:bg-teal/90" disabled={saving || !value.trim()} onClick={save} data-testid={`button-save-${item.id}`}>
          {saving && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}Save
        </Button>
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onCancel} disabled={saving}>Cancel</Button>
      </div>
    </div>
  );
}

export function NoteEditor({
  dealId,
  item,
  initial,
  onDone,
  onCancel,
}: {
  dealId: string;
  item: CoverageItem;
  initial?: string | null;
  onDone?: () => void;
  onCancel: () => void;
}) {
  const { toast } = useToast();
  const [note, setNote] = useState(initial ?? "");
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!note.trim()) return;
    setSaving(true);
    try {
      await boardRequest("POST", `/api/deals/${dealId}/coverage-board/items/${encodeURIComponent(item.id)}/marks`, { kind: "note", note: note.trim() }, "Couldn't save the note");
      invalidateCoverage(dealId);
      onDone?.();
    } catch (e) {
      toast({ title: "Couldn't save the note", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="mt-2 rounded-md border border-border bg-muted/30 p-3 space-y-2" onPointerDown={(e) => e.stopPropagation()}>
      <p className="text-xs font-medium">Private note</p>
      <Textarea autoFocus value={note} onChange={(e) => setNote(e.target.value.slice(0, 1000))} className="min-h-[3rem] text-sm bg-background" placeholder="Only you see this — never the seller, never the CIM." />
      <div className="flex gap-2">
        <Button size="sm" className="h-7 text-xs" disabled={saving || !note.trim()} onClick={save}>{saving && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}Save note</Button>
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onCancel} disabled={saving}>Cancel</Button>
      </div>
    </div>
  );
}

/**
 * "What did the seller say?" — behind ✓ Answered during a session together,
 * when there's nothing Cimple can file from (or the broker would rather
 * type it). Filed as the broker's own call note (never the seller's words,
 * never final): the seller's own answer later, or a document where documents
 * are the authority, takes its place; the note stays as another value.
 */
export function CallNoteEditor({
  dealId,
  item,
  sittingId,
  onDone,
  onCancel,
}: {
  dealId: string;
  item: CoverageItem;
  sittingId: string;
  onDone?: () => void;
  onCancel: () => void;
}) {
  const { toast } = useToast();
  const writable = item.members.filter((m) => m.writable);
  const startKey = item.valueKey && writable.some((m) => m.key === item.valueKey) ? item.valueKey : writable[0]?.key ?? "";
  const [memberKey, setMemberKey] = useState(startKey);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  if (writable.length === 0) {
    return (
      <div className="mt-2 rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
        This one is your own calculation — change it on the deal's Financials tab.
        <div className="mt-2"><Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onCancel}>Close</Button></div>
      </div>
    );
  }
  const save = async () => {
    const v = value.trim();
    if (!v || !memberKey) return;
    setSaving(true);
    try {
      const out = await boardRequest<{ filed?: boolean; keptBeside?: boolean; message?: string }>(
        "POST",
        `/api/deals/${dealId}/coverage-board/items/${encodeURIComponent(item.id)}/answer`,
        { sittingId, mode: "note", memberKey, value: v },
        "Couldn't file that",
      );
      invalidateCoverage(dealId);
      if (out.keptBeside) toast({ title: "Kept beside what's on file", description: out.message });
      else toast({ title: "Filed as your note", description: `${item.label} — from the call.` });
      onDone?.();
    } catch (e) {
      toast({ title: "Not filed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="mt-2 rounded-md border border-teal/30 bg-teal/5 p-3 space-y-2" data-testid={`call-note-editor-${item.id}`} onPointerDown={(e) => e.stopPropagation()}>
      <p className="text-xs font-medium">What did the seller say?</p>
      {writable.length > 1 && (
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Which of these is it?">
          {writable.map((m) => (
            <button
              key={m.key}
              type="button"
              role="radio"
              aria-checked={memberKey === m.key}
              onClick={() => setMemberKey(m.key)}
              className={`rounded-full border px-2.5 py-1 text-[11px] ${memberKey === m.key ? "border-teal bg-teal/15 text-foreground" : "border-border text-muted-foreground hover:text-foreground"}`}
            >
              {capitalise(m.label)}
            </button>
          ))}
        </div>
      )}
      <Textarea
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value.slice(0, 400))}
        placeholder={item.ask ? `e.g. their answer to "${item.ask}"` : "Type what the seller said"}
        className="min-h-[3.5rem] text-sm bg-background"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void save();
          if (e.key === "Escape") onCancel();
        }}
      />
      <p className="text-[11px] text-muted-foreground">Filed as your note from the call. The seller's own words, or a document, will take its place later.</p>
      <div className="flex gap-2">
        <Button size="sm" className="h-7 text-xs bg-teal text-teal-foreground hover:bg-teal/90" disabled={saving || !value.trim()} onClick={save} data-testid={`button-file-note-${item.id}`}>
          {saving && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}Save
        </Button>
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onCancel} disabled={saving}>Cancel</Button>
      </div>
    </div>
  );
}
