/**
 * AiWriterPanel — rewrite one section with instructions, tone and length.
 * The result is a proposal: the page shows it in place, and the broker
 * applies or discards it. Applying keeps the old version for undo.
 */
import { useEffect, useState } from "react";
import { AlertTriangle, Check, Loader2, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { BuilderSection } from "./api";

export const TONES = [
  { key: "concise", label: "Concise" },
  { key: "detailed", label: "Detailed" },
  { key: "persuasive", label: "Persuasive" },
  { key: "formal", label: "Formal" },
  { key: "plain_english", label: "Plain English" },
] as const;

const LENGTHS = [
  { key: "shorter", label: "Shorter" },
  { key: "same", label: "Same length" },
  { key: "longer", label: "Longer" },
] as const;

interface Props {
  section: BuilderSection;
  aiBlockedReason?: string | null;
  starting: boolean;
  applying: boolean;
  onRewrite: (req: { instructions: string; tones: string[]; length: string }) => void;
  onApply: () => void;
  onDiscard: () => void;
}

export function AiWriterPanel({ section, aiBlockedReason, starting, applying, onRewrite, onApply, onDiscard }: Props) {
  const task = section.aiTask?.kind === "rewrite" ? section.aiTask : null;
  const otherTaskRunning = section.aiTask?.status === "running" && section.aiTask.kind !== "rewrite";
  const [instructions, setInstructions] = useState("");
  const [tones, setTones] = useState<string[]>([]);
  const [length, setLength] = useState<string>("same");

  // A new section → a fresh form (keep what the broker typed per section only while it's selected).
  useEffect(() => {
    setInstructions(task?.request?.instructions ?? "");
    setTones(task?.request?.tones ?? []);
    setLength(task?.request?.length ?? "same");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section.id]);

  const running = task?.status === "running";
  const ready = task?.status === "ready";
  const failed = task?.status === "failed";
  const nothingAsked = !instructions.trim() && tones.length === 0 && length === "same";

  if (ready) {
    return (
      <div className="rounded-lg border border-teal/40 bg-teal/5 p-3 space-y-2.5" data-testid="rewrite-ready">
        <div className="flex items-center gap-1.5">
          <Sparkles className="h-3.5 w-3.5 text-teal" />
          <p className="text-xs font-medium">Rewrite ready</p>
        </div>
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          The page shows the proposed version in place of this section. Apply it, or discard it to keep what you have.
        </p>
        <div className="flex gap-2">
          <Button size="sm" className="h-7 text-xs flex-1 gap-1 bg-teal text-teal-foreground hover:bg-teal/90" onClick={onApply} disabled={applying} data-testid="button-apply-rewrite">
            {applying ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />} Apply
          </Button>
          <Button size="sm" variant="outline" className="h-7 text-xs flex-1 gap-1" onClick={onDiscard} disabled={applying} data-testid="button-discard-rewrite">
            <X className="h-3 w-3" /> Discard
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <Textarea
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
        maxLength={2000}
        rows={3}
        disabled={running}
        className="text-xs resize-none leading-relaxed"
        placeholder="What should change? e.g. “Lead with the recurring revenue and mention the lease renewal.”"
        data-testid="input-rewrite-instructions"
      />
      <div>
        <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1.5">Tone</p>
        <div className="flex flex-wrap gap-1.5">
          {TONES.map((t) => {
            const on = tones.includes(t.key);
            return (
              <button
                key={t.key}
                type="button"
                disabled={running}
                aria-pressed={on}
                onClick={() => setTones(on ? tones.filter((x) => x !== t.key) : [...tones, t.key])}
                className={cn(
                  "rounded-full border px-2.5 py-1 text-[11px] transition-colors disabled:opacity-50",
                  on ? "border-teal bg-teal/15 text-foreground" : "border-border text-muted-foreground hover:text-foreground hover:bg-muted/50",
                )}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      </div>
      <div>
        <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1.5">Length</p>
        <div className="grid grid-cols-3 rounded-md border border-border p-0.5 bg-muted/30">
          {LENGTHS.map((l) => (
            <button
              key={l.key}
              type="button"
              disabled={running}
              aria-pressed={length === l.key}
              onClick={() => setLength(l.key)}
              className={cn(
                "rounded px-2 py-1 text-[11px] transition-colors",
                length === l.key ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {l.label}
            </button>
          ))}
        </div>
      </div>
      {failed && (
        <p className="flex items-start gap-1.5 text-[11px] text-red-400">
          <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" /> {task?.error || "The rewrite didn't finish. Try again."}
        </p>
      )}
      {aiBlockedReason && <p className="text-[11px] text-red-400">{aiBlockedReason}</p>}
      <Button
        size="sm"
        className="w-full h-8 text-xs gap-1.5 bg-teal text-teal-foreground hover:bg-teal/90"
        disabled={running || starting || nothingAsked || otherTaskRunning || !!aiBlockedReason}
        onClick={() => onRewrite({ instructions: instructions.trim(), tones, length })}
        data-testid="button-rewrite"
        title={nothingAsked ? "Type an instruction, or pick a tone or length" : undefined}
      >
        {running || starting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
        {running ? "Rewriting… (about 30 seconds)" : failed ? "Try again" : "Rewrite this section"}
      </Button>
    </div>
  );
}
