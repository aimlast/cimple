/**
 * ExportHelp — "Which software do you use?" chips and the steps to export
 * the general ledger from it (gl spec §3.3 A, §3.9). The choice is
 * remembered in this browser only.
 */
import { useState } from "react";
import { EXPORT_FOOTER, EXPORT_LAST_RESORT, exportSteps, rememberedSoftware, rememberSoftware, type ExportSoftware } from "./export-help";

/** **bold** markup → <strong>. */
export function RichLine({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((p, i) => (p.startsWith("**") && p.endsWith("**") ? <strong key={i} className="font-semibold text-foreground">{p.slice(2, -2)}</strong> : <span key={i}>{p}</span>))}
    </>
  );
}

export function ExportHelp({ start, end, compact = false }: { start: string; end: string; compact?: boolean }) {
  const all = exportSteps(start, end);
  const [picked, setPicked] = useState<ExportSoftware | null>(() => rememberedSoftware());
  const current = all.find((s) => s.key === picked) ?? null;
  return (
    <div className="space-y-3" data-testid="gl-export-help">
      <p className={compact ? "text-xs font-medium" : "text-sm font-medium"}>Which software do you use?</p>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Accounting software">
        {all.map((s) => (
          <button
            key={s.key}
            type="button"
            role="radio"
            aria-checked={picked === s.key}
            onClick={() => { setPicked(s.key); rememberSoftware(s.key); }}
            className={`min-h-9 rounded-full border px-3 py-1.5 text-xs transition-colors ${
              picked === s.key ? "border-teal bg-teal/10 text-foreground" : "border-border text-muted-foreground hover:border-teal/40 hover:text-foreground"
            }`}
            data-testid={`gl-software-${s.key}`}
          >
            {s.label}
          </button>
        ))}
      </div>
      {current && (
        <div className="rounded-lg border border-border bg-muted/30 p-3 sm:p-4 text-sm text-muted-foreground space-y-2" data-testid="gl-export-steps">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Usually, in {current.label}:</p>
          <ol className="list-decimal pl-5 space-y-1.5">
            {current.steps.map((step, i) => <li key={i}><RichLine text={step} /></li>)}
          </ol>
          <div className="pt-1 space-y-1 text-xs">
            {EXPORT_FOOTER.map((l, i) => <p key={i}><RichLine text={l} /></p>)}
            <p>{EXPORT_LAST_RESORT}</p>
          </div>
        </div>
      )}
    </div>
  );
}
