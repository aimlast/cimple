/**
 * "Ask for a document" (vdr spec §6.2, §6.5): one document, or a pasted
 * list (one per line, up to 100). The request goes to the broker; the
 * buyer sees its status under "Your requests". Nothing here names other
 * buyers or what the seller was asked.
 */
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { queryClient } from "@/lib/queryClient";
import { sourceKey, vdrFetch, vdrUrls, type VdrSource } from "@/hooks/useDataRoom";

export type RequestPrefill = { text?: string; itemId?: string | null; documentId?: string | null } | null;

export function RequestDialog({ source, open, onOpenChange, prefill }: { source: VdrSource; open: boolean; onOpenChange: (o: boolean) => void; prefill?: RequestPrefill }) {
  const { toast } = useToast();
  const [mode, setMode] = useState<"one" | "list">("one");
  const [text, setText] = useState("");
  const [list, setList] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setMode("one");
    setText(prefill?.text ?? "");
    setList("");
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const lines = list.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const submit = async () => {
    setBusy(true);
    try {
      const body = mode === "list" ? { list } : { text, itemId: prefill?.itemId ?? null, documentId: prefill?.documentId ?? null };
      const r = await vdrFetch<{ count: number }>("POST", `${vdrUrls(source).room}/requests`, body);
      await queryClient.invalidateQueries({ queryKey: sourceKey(source) });
      toast({ title: r.count > 1 ? `Sent ${r.count} requests to your broker` : "Sent to your broker", description: "You'll see the answer under Your requests." });
      onOpenChange(false);
    } catch (e: any) {
      toast({ title: "Couldn't send it", description: e?.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">Ask for a document</DialogTitle>
          <DialogDescription>Your broker sees your request and lets you know when it's in the data room.</DialogDescription>
        </DialogHeader>
        <div className="inline-flex rounded-md border border-border p-0.5 text-xs" role="tablist">
          {(["one", "list"] as const).map((m) => (
            <button key={m} role="tab" aria-selected={mode === m} onClick={() => setMode(m)} className={cn("rounded-[5px] px-3 py-1.5", mode === m ? "bg-teal/15 text-teal" : "text-muted-foreground hover:text-foreground")}>
              {m === "one" ? "One document" : "Paste a list"}
            </button>
          ))}
        </div>
        {mode === "one" ? (
          <div>
            <label className="text-xs font-medium text-muted-foreground" htmlFor="vdr-request">Which document?</label>
            <Input id="vdr-request" value={text} onChange={(e) => setText(e.target.value)} maxLength={500} placeholder="For example: AR aging, June 2026" className="mt-1" autoFocus />
          </div>
        ) : (
          <div>
            <label className="text-xs font-medium text-muted-foreground" htmlFor="vdr-request-list">One document per line (up to 100)</label>
            <Textarea id="vdr-request-list" value={list} onChange={(e) => setList(e.target.value)} rows={8} className="mt-1 font-mono text-xs" placeholder={"Monthly bank statements, last 12 months\nAR aging, June 2026\nEquipment leases"} />
            <p className={cn("mt-1 text-xs", lines.length > 100 ? "text-destructive" : "text-muted-foreground")}>{lines.length} {lines.length === 1 ? "request" : "requests"}{lines.length > 100 ? ". Send up to 100 at a time." : ""}</p>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={busy || (mode === "one" ? !text.trim() : lines.length === 0 || lines.length > 100)} data-testid="vdr-request-send">
            {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />} Send to the broker
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
