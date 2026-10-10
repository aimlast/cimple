/**
 * SupportDocUpload — "Upload your T4 slips" / an invoice or letter instead
 * of ledger entries (gl spec §3.3 D). One file (PDF, photo, spreadsheet;
 * 15 MB), which years it is for, and the amount on it per year ("The
 * amount in box 14 (Employment income) for Dan, 2024"). Cimple then looks
 * for that amount in the document's text; the result shows on the cost.
 */
import { useRef, useState } from "react";
import { FileUp, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { uploadWithProgress } from "@/lib/gl-api";

const ACCEPT = ".pdf,.jpg,.jpeg,.png,.xlsx,.xls,.csv";
const MAX = 15 * 1024 * 1024;

export function SupportDocUpload({ uploadUrl, years, kind, payDoc, personWord, disabled, onDone }: {
  uploadUrl: string;
  years: string[];
  /** payroll: pay slips; one_off: an invoice or letter; other: any document. */
  kind: "payroll" | "one_off" | "other";
  payDoc: { slips: string; short: string; box: string | null };
  /** "your" / "Maria's" — whose pay. */
  personWord?: string;
  disabled?: boolean;
  onDone: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [chosen, setChosen] = useState<string[]>(years.length === 1 ? years : []);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const label = (y: string) =>
    kind === "payroll"
      ? payDoc.box ? `The amount in ${payDoc.box} for ${y}` : `${personWord ? `${personWord} ` : ""}total pay for ${y}`.replace(/^your /, "Your ")
      : `The amount on it for ${y}`;
  const pick = (f: File | undefined) => {
    setError(null);
    if (!f) return;
    const ext = (f.name.match(/\.[^.]+$/)?.[0] ?? "").toLowerCase();
    if (!ACCEPT.split(",").includes(ext)) return setError("Upload a PDF, a photo (JPG or PNG) or a spreadsheet.");
    if (f.size > MAX) return setError("Documents can be up to 15 MB.");
    setFile(f);
  };
  const ready = !!file && chosen.length > 0 && chosen.every((y) => /\d/.test(amounts[y] ?? ""));
  const send = async () => {
    if (!file) return;
    setError(null);
    setProgress(0);
    try {
      await uploadWithProgress(uploadUrl, file, { years: chosen.join(","), amounts: JSON.stringify(Object.fromEntries(chosen.map((y) => [y, amounts[y] ?? ""]))) }, setProgress);
      setFile(null);
      setAmounts({});
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The upload didn't go through — try again.");
    } finally {
      setProgress(null);
    }
  };
  const title = kind === "payroll" ? `Upload ${payDoc.slips}` : kind === "one_off" ? "Upload the letter or invoice" : "Upload the document";
  return (
    <div className="rounded-lg border border-border bg-card p-3 sm:p-4 space-y-3" data-testid="support-upload">
      <p className="text-sm font-medium">{title}</p>
      <input ref={input} type="file" accept={ACCEPT} className="sr-only" onChange={(e) => pick(e.target.files?.[0])} aria-label={title} />
      {file ? (
        <p className="text-sm break-all">{file.name} <button type="button" className="ml-2 text-xs text-teal hover:underline" onClick={() => input.current?.click()}>Choose another</button></p>
      ) : (
        <Button variant="outline" className="h-10 gap-1.5" disabled={disabled} onClick={() => input.current?.click()}><FileUp className="h-4 w-4" /> Choose a file</Button>
      )}
      <p className="text-2xs text-muted-foreground">PDF, JPG, PNG, Excel or CSV · up to 15 MB</p>
      {file && (
        <>
          <div className="space-y-1.5">
            <p className="text-xs">Which year is this for?</p>
            <div className="flex flex-wrap gap-1.5">
              {years.map((y) => (
                <button key={y} type="button" aria-pressed={chosen.includes(y)} onClick={() => setChosen(chosen.includes(y) ? chosen.filter((x) => x !== y) : [...chosen, y].sort())}
                  className={cn("rounded-full border px-3 py-1 text-xs min-h-[36px]", chosen.includes(y) ? "border-teal bg-teal/10 text-teal" : "border-border text-muted-foreground")}>{y}</button>
              ))}
            </div>
          </div>
          {chosen.map((y) => (
            <div key={y} className="space-y-1">
              <label htmlFor={`amt-${y}`} className="text-xs">{label(y)}</label>
              <Input id={`amt-${y}`} inputMode="decimal" className="h-10 sm:w-56" placeholder="e.g. 240,000.00" value={amounts[y] ?? ""} onChange={(e) => setAmounts({ ...amounts, [y]: e.target.value.replace(/[^\d.,$\s]/g, "") })} />
            </div>
          ))}
          {progress !== null ? (
            <Progress value={Math.round(progress * 100)} className="h-2" />
          ) : (
            <Button className="h-10 bg-teal text-teal-foreground hover:bg-teal/90" disabled={!ready || disabled} onClick={send}>
              {progress !== null && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />} Upload
            </Button>
          )}
        </>
      )}
      {error && <p className="text-xs text-red-600 dark:text-red-400" role="alert">{error}</p>}
    </div>
  );
}

/** What Cimple saw on an uploaded document (§3.3 D). */
export function docCheckWords(check: string | null, amount: string): { tone: "good" | "warn" | "muted"; text: string } {
  if (check === "found_in_document") return { tone: "good", text: `Found ${amount} on the document.` };
  if (check === "not_found") return { tone: "warn", text: `We couldn't see ${amount} on the document — your broker will check it.` };
  if (check === "unreadable") return { tone: "muted", text: "We can't read this document — your broker will check it." };
  return { tone: "muted", text: "Reading it…" };
}
