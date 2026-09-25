/**
 * MatchCimDialog — "Match my existing CIM": upload one of the brokerage's
 * past CIMs; Cimple reads its section structure and saves it as a new
 * template the layout engine follows. The file is deleted once read.
 */
import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, FileText, Loader2, ShieldCheck, Upload } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { errorText } from "@/components/cim-builder/api";
import { templatesKey, uploadForm, type TemplateView } from "./api";

const ACCEPT = ".pdf,.docx,.pptx,application/pdf";

export function MatchCimDialog({
  open,
  onOpenChange,
  templates,
  defaultTemplateId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  templates: TemplateView[];
  defaultTemplateId: string;
  onCreated: (t: TemplateView, action: "edit" | "default" | "close") => void;
}) {
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [basedOn, setBasedOn] = useState(defaultTemplateId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TemplateView | null>(null);
  const [over, setOver] = useState(false);

  const reset = () => {
    setFile(null);
    setError(null);
    setResult(null);
    setBusy(false);
  };

  const pick = (f: File | undefined) => {
    setError(null);
    if (!f) return;
    if (!/\.(pdf|docx|pptx)$/i.test(f.name)) return setError("Use a PDF (Word .docx and PowerPoint .pptx also work).");
    if (f.size > 25 * 1024 * 1024) return setError("That file is over 25 MB.");
    setFile(f);
  };

  const run = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const t = await uploadForm<TemplateView>("/api/cim-templates/from-cim", file, { basedOn });
      setResult(t);
      qc.invalidateQueries({ queryKey: templatesKey });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) { onOpenChange(o); if (!o) reset(); } }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Match my existing CIM</DialogTitle>
          <DialogDescription>
            Upload a CIM your firm has already written. Cimple reads its sections, in order, and follows the same structure every time it writes a CIM with the new template.
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-3">
            <p className="flex items-center gap-2 text-sm font-medium"><CheckCircle2 className="h-4 w-4 text-success" /> “{result.name}” is ready</p>
            {result.sectionOutline && (
              <ol className="max-h-64 overflow-y-auto scrollbar-thin rounded-lg border border-border divide-y divide-border">
                {result.sectionOutline.sections.map((s, i) => (
                  <li key={i} className="px-3 py-2 flex gap-2.5">
                    <span className="text-[11px] text-muted-foreground tabular-nums w-4 pt-px">{i + 1}</span>
                    <span className="min-w-0">
                      <span className="block text-xs font-medium">{s.title}</span>
                      {s.notes && <span className="block text-[11px] text-muted-foreground">{s.notes}</span>}
                    </span>
                  </li>
                ))}
              </ol>
            )}
            {result.sectionOutline?.toneNotes && (
              <p className="text-[11px] text-muted-foreground leading-relaxed"><span className="font-medium text-foreground/80">How it reads: </span>{result.sectionOutline.toneNotes}</p>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setOver(true); }}
              onDragLeave={() => setOver(false)}
              onDrop={(e) => { e.preventDefault(); setOver(false); pick(e.dataTransfer.files?.[0]); }}
              disabled={busy}
              className={cn(
                "w-full rounded-lg border-2 border-dashed px-4 py-7 text-center transition-colors",
                over ? "border-teal bg-teal/5" : "border-border hover:border-teal/50",
              )}
              data-testid="match-cim-drop"
            >
              {file ? (
                <span className="flex items-center justify-center gap-2 text-sm"><FileText className="h-4 w-4 text-teal" /> {file.name}</span>
              ) : (
                <span className="flex flex-col items-center gap-1.5 text-sm text-muted-foreground">
                  <Upload className="h-5 w-5" />
                  Drop a past CIM here, or click to choose
                  <span className="text-[11px]">PDF, Word or PowerPoint · up to 25 MB</span>
                </span>
              )}
            </button>
            <input ref={inputRef} type="file" accept={ACCEPT} className="hidden" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} data-testid="match-cim-input" />
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">Style it like</span>
              <Select value={basedOn} onValueChange={setBasedOn}>
                <SelectTrigger className="h-8 w-[200px] text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {templates.map((t) => <SelectItem key={t.id} value={t.id} className="text-xs">{t.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <p className="text-[11px] text-muted-foreground flex items-start gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5 mt-px shrink-0" />
              Only the section structure is kept — never the business, names or numbers in it. The file is deleted as soon as it's read.
            </p>
            {error && <p className="text-xs text-red-400">{error}</p>}
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          {result ? (
            <>
              <Button variant="ghost" onClick={() => { onCreated(result, "close"); onOpenChange(false); reset(); }}>Done</Button>
              <Button variant="outline" onClick={() => { onCreated(result, "default"); onOpenChange(false); reset(); }}>Make it my default</Button>
              <Button className="bg-teal text-teal-foreground hover:bg-teal/90" onClick={() => { onCreated(result, "edit"); onOpenChange(false); reset(); }}>Edit its look</Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
              <Button className="bg-teal text-teal-foreground hover:bg-teal/90 gap-1.5" onClick={run} disabled={!file || busy} data-testid="button-match-cim">
                {busy ? <><Loader2 className="h-4 w-4 animate-spin" /> Reading your CIM…</> : "Read its structure"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
