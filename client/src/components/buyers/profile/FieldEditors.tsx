/**
 * Inputs for editing a buyer profile field — one per criterion type
 * (currency, percent, number, select, multiselect, tags, boolean) plus a tag
 * editor for industries/locations and a tri-state proof-of-funds picker.
 */
import { useState } from "react";
import { X, Plus } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BUYER_CRITERIA_FIELDS, humanize, parseMoney, formatMoney } from "./types";

const NONE = "__none";

export function TagEditor({
  values,
  onChange,
  placeholder,
  testId,
}: {
  values: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  testId?: string;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const parts = draft.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return;
    const next = [...values];
    for (const p of parts) if (!next.some((v) => v.toLowerCase() === p.toLowerCase())) next.push(p);
    onChange(next);
    setDraft("");
  };
  return (
    <div className="rounded-md border border-input bg-background px-2 py-1.5 focus-within:ring-1 focus-within:ring-ring" data-testid={testId}>
      <div className="flex flex-wrap items-center gap-1">
        {values.map((v) => (
          <span key={v} className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs text-foreground">
            {v}
            <button type="button" aria-label={`Remove ${v}`} className="text-muted-foreground hover:text-foreground" onClick={() => onChange(values.filter((x) => x !== v))}>
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); }
            if (e.key === "Backspace" && !draft && values.length) onChange(values.slice(0, -1));
          }}
          onBlur={add}
          placeholder={values.length ? "Add…" : placeholder}
          className="min-w-[8rem] flex-1 bg-transparent px-1 py-0.5 text-sm outline-none placeholder:text-muted-foreground"
        />
        {draft.trim() && (
          <button type="button" onClick={add} className="text-muted-foreground hover:text-foreground" aria-label="Add">
            <Plus className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

export function ProofOfFundsSelect({ value, onChange }: { value: boolean | null; onChange: (v: boolean | null) => void }) {
  return (
    <Select value={value === true ? "yes" : value === false ? "no" : NONE} onValueChange={(v) => onChange(v === "yes" ? true : v === "no" ? false : null)}>
      <SelectTrigger className="h-9" data-testid="select-proof-of-funds"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value="yes">Yes — verified</SelectItem>
        <SelectItem value="no">No</SelectItem>
        <SelectItem value={NONE}>Unknown</SelectItem>
      </SelectContent>
    </Select>
  );
}

export function OptionSelect({
  value, onChange, options, placeholder = "Not set", testId,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  options: Array<{ value: string; label: string }>;
  placeholder?: string;
  testId?: string;
}) {
  return (
    <Select value={value || NONE} onValueChange={(v) => onChange(v === NONE ? null : v)}>
      <SelectTrigger className="h-9" data-testid={testId}><SelectValue placeholder={placeholder} /></SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>{placeholder}</SelectItem>
        {options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

/** Currency input: accepts "750k", "$1.2M", "2,000,000"; stores whole dollars as a string. */
export function MoneyInput({ value, onChange, placeholder = "$", testId }: { value: unknown; onChange: (v: string | null) => void; placeholder?: string; testId?: string }) {
  const [text, setText] = useState(() => (value == null || value === "" ? "" : formatMoney(value)));
  const commit = () => {
    if (!text.trim()) return onChange(null);
    const n = parseMoney(text);
    if (n == null) return onChange(text.trim());
    onChange(String(Math.round(n)));
    setText(formatMoney(n));
  };
  return (
    <Input value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && commit()}
      placeholder={placeholder} className="h-9" inputMode="decimal" data-testid={testId} />
  );
}

/** The right input for one acquisition criterion. */
export function CriterionEditor({ fieldKey, value, onChange }: { fieldKey: string; value: unknown; onChange: (v: unknown) => void }) {
  const def = BUYER_CRITERIA_FIELDS[fieldKey];
  if (!def) return null;
  const testId = `edit-criterion-${fieldKey}`;
  switch (def.type) {
    case "currency":
      return <MoneyInput value={value} onChange={onChange} testId={testId} />;
    case "percent":
    case "number":
      return (
        <div className="relative">
          <Input
            value={value == null ? "" : String(value)}
            onChange={(e) => {
              const t = e.target.value.replace(/[^0-9.\-]/g, "");
              onChange(t === "" ? null : Number.isFinite(Number(t)) && !t.endsWith(".") ? Number(t) : t);
            }}
            inputMode="decimal"
            className={`h-9 ${def.type === "percent" ? "pr-7" : ""}`}
            data-testid={testId}
          />
          {def.type === "percent" && <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">%</span>}
        </div>
      );
    case "boolean":
      return (
        <OptionSelect
          value={value === true ? "yes" : value === false ? "no" : null}
          onChange={(v) => onChange(v === "yes" ? true : v === "no" ? false : null)}
          options={[{ value: "yes", label: "Yes" }, { value: "no", label: "No" }]}
          testId={testId}
        />
      );
    case "select":
      return (
        <OptionSelect
          value={typeof value === "string" ? value : null}
          onChange={onChange}
          options={(def.options || []).map((o) => ({ value: o, label: humanize(o) }))}
          testId={testId}
        />
      );
    case "multiselect": {
      const arr = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div className="flex flex-wrap gap-1.5" data-testid={testId}>
          {(def.options || []).map((o) => {
            const on = arr.includes(o);
            return (
              <button
                key={o}
                type="button"
                onClick={() => {
                  const next = on ? arr.filter((x) => x !== o) : [...arr, o];
                  onChange(next.length ? next : null);
                }}
                className={`rounded-full border px-2 py-0.5 text-xs transition-colors ${on ? "border-teal/50 bg-teal/15 text-teal" : "border-border text-muted-foreground hover:text-foreground"}`}
              >
                {humanize(o)}
              </button>
            );
          })}
        </div>
      );
    }
    case "tags":
      return <TagEditor values={Array.isArray(value) ? (value as string[]) : []} onChange={(v) => onChange(v.length ? v : null)} placeholder="Type and press Enter" testId={testId} />;
    default:
      return null;
  }
}
