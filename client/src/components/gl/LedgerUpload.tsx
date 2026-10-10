/**
 * LedgerUpload — upload a general ledger and follow it being read (gl spec
 * §3.3 A "Upload states"): uploading (progress) → reading (entries so far) →
 * read (entries, dates, any problems with what to do) / needs another look
 * / couldn't read (with the reason and "Try another file").
 * Used on the seller's Documents page and the broker's Financials panel.
 */
import { useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Loader2, Upload, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useIsMobile } from "@/hooks/use-mobile";
import { checkLedgerFile, LEDGER_ACCEPT, uploadWithProgress } from "@/lib/gl-api";
import { formatCount, formatDay, NEEDS_COLUMNS_MESSAGE } from "@shared/gl-copy";

/** The parts of a ledger this component shows (broker and seller views both have them). */
export interface UploadLedgerState {
  id: string;
  fileName: string;
  status: "reading" | "needs_columns" | "ready" | "failed";
  rowCount: number;
  periodStart: string | null;
  periodEnd: string | null;
  progress: { rowsRead: number } | null;
  problems: Array<{ kind: string; message: string }>;
  failure: string | null;
}

interface Props {
  uploadUrl: string;
  /** Extra form fields (role, visibility). */
  fields?: Record<string, string>;
  /** The deal's ledgers (polled by the parent) — the one just uploaded is followed here. */
  ledgers: UploadLedgerState[];
  onUploaded?: () => void;
  /** A broker previewing the seller's page: nothing is saved. */
  disabled?: boolean;
  disabledReason?: string;
  audience: "seller" | "broker";
  testId?: string;
}

export function LedgerUpload({ uploadUrl, fields = {}, ledgers, onUploaded, disabled, disabledReason, audience, testId = "gl-ledger-upload" }: Props) {
  const isMobile = useIsMobile();
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastId, setLastId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const last = lastId ? ledgers.find((l) => l.id === lastId) ?? null : null;
  const you = audience === "seller" ? "your" : "the";

  const send = async (file: File) => {
    setError(null);
    const problem = checkLedgerFile(file);
    if (problem) { setError(problem); return; }
    setFileName(file.name);
    setProgress(0);
    try {
      const res = await uploadWithProgress<{ ledger: { id: string } }>(uploadUrl, file, fields, setProgress);
      setLastId(res.ledger.id);
      onUploaded?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The upload didn't go through — try again.");
    } finally {
      setProgress(null);
    }
  };
  const pick = () => input.current?.click();
  const reset = () => { setLastId(null); setError(null); setFileName(null); };

  if (progress !== null) {
    return (
      <div className="rounded-lg border border-teal/30 bg-teal/5 p-4 space-y-2" data-testid={`${testId}-uploading`} aria-live="polite">
        <p className="text-sm">Uploading {fileName}…</p>
        <Progress value={Math.round(progress * 100)} className="h-2" />
      </div>
    );
  }
  if (last && last.status === "reading") {
    return (
      <div className="rounded-lg border border-teal/30 bg-teal/5 p-4 flex items-center gap-3" data-testid={`${testId}-reading`} aria-live="polite">
        <Loader2 className="h-4 w-4 animate-spin text-teal shrink-0" />
        <p className="text-sm">
          Reading {you} ledger…{last.progress?.rowsRead ? ` ${formatCount(last.progress.rowsRead)} entries so far` : ""}
        </p>
      </div>
    );
  }
  if (last && last.status === "ready") {
    return (
      <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4 space-y-3" data-testid={`${testId}-ready`} aria-live="polite">
        <div className="flex items-start gap-3">
          <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0 mt-0.5" />
          <p className="text-sm">
            Read <strong>{formatCount(last.rowCount)} entries</strong>
            {last.periodStart && last.periodEnd ? <> from <strong>{formatDay(last.periodStart)}</strong> to <strong>{formatDay(last.periodEnd)}</strong></> : null}.
          </p>
        </div>
        {last.problems.length > 0 && (
          <ul className="space-y-1.5 pl-7" data-testid={`${testId}-problems`}>
            {last.problems.map((p, i) => (
              <li key={i} className="text-xs text-amber-600 dark:text-amber-400 flex items-start gap-1.5">
                <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />
                <span>{p.message}</span>
              </li>
            ))}
          </ul>
        )}
        <Button size="sm" variant="outline" className="h-8 text-xs ml-7" onClick={reset} disabled={disabled}>Add another file</Button>
      </div>
    );
  }
  if (last && (last.status === "needs_columns" || last.status === "failed")) {
    const failed = last.status === "failed";
    return (
      <div className={`rounded-lg border p-4 space-y-3 ${failed ? "border-red-500/30 bg-red-500/5" : "border-amber-500/30 bg-amber-500/5"}`} data-testid={`${testId}-${failed ? "failed" : "needs-columns"}`} aria-live="polite">
        <div className="flex items-start gap-3">
          {failed ? <XCircle className="h-4 w-4 text-red-500 shrink-0 mt-0.5" /> : <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />}
          <p className="text-sm">{failed ? last.failure : audience === "seller" ? NEEDS_COLUMNS_MESSAGE : "Cimple couldn't tell which column is which in this file. Ask for the standard General Ledger report, or set the columns on the ledger below."}</p>
        </div>
        <Button size="sm" variant="outline" className="h-8 text-xs ml-7" onClick={reset} disabled={disabled}>Try another file</Button>
      </div>
    );
  }

  return (
    <div className="space-y-2" data-testid={testId}>
      {isMobile ? (
        <Button className="w-full h-11 gap-2 bg-teal text-teal-foreground hover:bg-teal/90" onClick={pick} disabled={disabled} data-testid={`${testId}-choose`}>
          <Upload className="h-4 w-4" /> Choose a file
        </Button>
      ) : (
        <div
          role="button"
          tabIndex={disabled ? -1 : 0}
          aria-disabled={disabled}
          onClick={() => !disabled && pick()}
          onKeyDown={(e) => { if (!disabled && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); pick(); } }}
          onDragOver={(e) => { e.preventDefault(); if (!disabled) setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const f = e.dataTransfer.files?.[0];
            if (f && !disabled) void send(f);
          }}
          className={`rounded-lg border-2 border-dashed p-6 text-center transition-colors ${
            disabled ? "opacity-60 cursor-not-allowed border-border" : dragging ? "border-teal bg-teal/5 cursor-pointer" : "border-border hover:border-teal/40 cursor-pointer"
          }`}
          data-testid={`${testId}-drop`}
        >
          <FileSpreadsheet className="h-7 w-7 mx-auto text-muted-foreground/60 mb-2" />
          <p className="text-sm">Drop {you} ledger here, or <span className="text-teal underline-offset-2 hover:underline">choose a file</span></p>
        </div>
      )}
      <p className="text-xs text-muted-foreground">Excel (.xlsx, .xls) or CSV · CSV up to 60 MB, Excel up to 15 MB.</p>
      {disabled && disabledReason && <p className="text-xs text-muted-foreground">{disabledReason}</p>}
      {error && (
        <p className="text-xs text-red-600 dark:text-red-400 flex items-start gap-1.5" role="alert" data-testid={`${testId}-error`}>
          <XCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" /> <span>{error}</span>
        </p>
      )}
      <input
        ref={input}
        type="file"
        className="hidden"
        accept={LEDGER_ACCEPT}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void send(f);
        }}
      />
    </div>
  );
}
