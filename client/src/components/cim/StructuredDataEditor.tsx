/**
 * StructuredDataEditor — a form over a section's layoutData.
 *
 * Structured layouts (metric grids, charts, tables, org charts…) render from
 * layoutData, not from a content string, so "Edit text" cannot change them.
 * This editor walks the layoutData shape generically:
 *   string  → input (textarea when long)      number  → numeric input
 *   boolean → checkbox                        string[] → one per line
 *   object  → nested group                    object[] → rows (edit / remove / add)
 *
 * It is deliberately shape-agnostic: the AI invents fields per deal and the
 * renderer ignores what it doesn't know, so the editor must never drop keys.
 * Internal flags (expandable, relatedSections, colours, icons) are editable
 * but listed last so the broker sees the content fields first.
 */
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Plus, Trash2 } from "lucide-react";

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
type JsonObject = { [k: string]: Json };

interface StructuredDataEditorProps {
  value: JsonObject;
  onChange: (next: JsonObject) => void;
  /** Narrow layout (e.g. the Designer inspector) — stacks every field. */
  compact?: boolean;
}

const SECONDARY_KEYS = new Set([
  "expandable", "summary", "expandLabel", "collapseLabel", "relatedSections",
  "color", "icon", "accentColor", "columns", "style", "highlight", "trend",
]);
const MAX_DEPTH = 5;

function humanize(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase());
}

function orderedKeys(obj: JsonObject): string[] {
  const keys = Object.keys(obj);
  return [
    ...keys.filter((k) => !SECONDARY_KEYS.has(k)),
    ...keys.filter((k) => SECONDARY_KEYS.has(k)),
  ];
}

function isObject(v: Json): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function blankLike(template: Json): Json {
  if (typeof template === "number") return 0;
  if (typeof template === "boolean") return false;
  if (Array.isArray(template)) return [];
  if (isObject(template)) {
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(template)) out[k] = blankLike(v);
    return out;
  }
  return "";
}

export function StructuredDataEditor({ value, onChange, compact = false }: StructuredDataEditorProps) {
  return (
    <div className={compact ? "space-y-3" : "space-y-4"}>
      <ObjectFields value={value} onChange={onChange} depth={0} compact={compact} />
    </div>
  );
}

function ObjectFields({
  value, onChange, depth, compact,
}: { value: JsonObject; onChange: (next: JsonObject) => void; depth: number; compact: boolean }) {
  const keys = orderedKeys(value);
  if (keys.length === 0) {
    return <p className="text-xs text-muted-foreground italic">No editable fields in this section.</p>;
  }
  return (
    <>
      {keys.map((key) => (
        <Field
          key={key}
          label={humanize(key)}
          value={value[key]}
          depth={depth}
          compact={compact}
          onChange={(next) => onChange({ ...value, [key]: next })}
        />
      ))}
    </>
  );
}

function Field({
  label, value, onChange, depth, compact,
}: { label: string; value: Json; onChange: (next: Json) => void; depth: number; compact: boolean }) {
  const labelEl = (
    <span className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
  );

  if (value === null || value === undefined) {
    return (
      <label className="block space-y-1">
        {labelEl}
        <Input className="h-8 text-xs" value="" placeholder="—" onChange={(e) => onChange(e.target.value)} />
      </label>
    );
  }

  if (typeof value === "boolean") {
    return (
      <label className="flex items-center gap-2 text-xs">
        <Checkbox checked={value} onCheckedChange={(c) => onChange(c === true)} />
        {labelEl}
      </label>
    );
  }

  if (typeof value === "number") {
    return (
      <label className="block space-y-1">
        {labelEl}
        <Input
          type="number"
          className="h-8 text-xs tabular-nums"
          value={Number.isFinite(value) ? value : ""}
          onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))}
        />
      </label>
    );
  }

  if (typeof value === "string") {
    const long = value.length > 80 || value.includes("\n");
    return (
      <label className="block space-y-1">
        {labelEl}
        {long ? (
          <Textarea
            className="text-xs min-h-[72px] resize-y leading-relaxed"
            value={value}
            onChange={(e) => onChange(e.target.value)}
          />
        ) : (
          <Input className="h-8 text-xs" value={value} onChange={(e) => onChange(e.target.value)} />
        )}
      </label>
    );
  }

  if (Array.isArray(value)) {
    const allPrimitive = value.every((v) => typeof v === "string" || typeof v === "number");
    if (allPrimitive) {
      const numeric = value.length > 0 && value.every((v) => typeof v === "number");
      return (
        <label className="block space-y-1">
          {labelEl}
          <Textarea
            className="text-xs min-h-[64px] resize-y leading-relaxed"
            value={value.map(String).join("\n")}
            placeholder="One per line"
            onChange={(e) => {
              const lines = e.target.value.split("\n");
              onChange(numeric ? lines.map((l) => Number(l) || 0) : lines);
            }}
          />
        </label>
      );
    }
    if (depth >= MAX_DEPTH) return <RawJsonField label={label} value={value} onChange={onChange} />;
    const rows = value as Json[];
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          {labelEl}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-2xs gap-1 text-teal hover:text-teal"
            onClick={() => onChange([...rows, blankLike(rows[rows.length - 1] ?? {})])}
          >
            <Plus className="h-3 w-3" /> Add
          </Button>
        </div>
        <div className="space-y-2">
          {rows.map((row, i) => (
            <div key={i} className="rounded-md border border-border bg-muted/20 p-2.5 relative">
              <button
                type="button"
                className="absolute top-1.5 right-1.5 p-1 rounded text-muted-foreground/60 hover:text-destructive hover:bg-destructive/10"
                aria-label={`Remove ${label} row ${i + 1}`}
                onClick={() => onChange(rows.filter((_, j) => j !== i))}
              >
                <Trash2 className="h-3 w-3" />
              </button>
              <div className={compact ? "space-y-2 pr-5" : "grid grid-cols-1 sm:grid-cols-2 gap-2 pr-5"}>
                {isObject(row) ? (
                  <ObjectFields
                    value={row}
                    depth={depth + 1}
                    compact={compact}
                    onChange={(next) => onChange(rows.map((r, j) => (j === i ? next : r)))}
                  />
                ) : (
                  <Field
                    label={`${label} ${i + 1}`}
                    value={row}
                    depth={depth + 1}
                    compact={compact}
                    onChange={(next) => onChange(rows.map((r, j) => (j === i ? next : r)))}
                  />
                )}
              </div>
            </div>
          ))}
          {rows.length === 0 && (
            <p className="text-xs text-muted-foreground italic">No rows yet.</p>
          )}
        </div>
      </div>
    );
  }

  // Nested object
  if (depth >= MAX_DEPTH) return <RawJsonField label={label} value={value} onChange={onChange} />;
  return (
    <fieldset className="rounded-md border border-border/60 p-2.5 space-y-2">
      <legend className="px-1 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</legend>
      <ObjectFields value={value} depth={depth + 1} compact={compact} onChange={onChange} />
    </fieldset>
  );
}

/** Last-resort editor for shapes nested deeper than the form walks. */
function RawJsonField({ label, value, onChange }: { label: string; value: Json; onChange: (next: Json) => void }) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [invalid, setInvalid] = useState(false);
  return (
    <label className="block space-y-1">
      <span className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">{label} (JSON)</span>
      <Textarea
        className={`text-xs font-mono min-h-[96px] resize-y ${invalid ? "border-destructive" : ""}`}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          try {
            onChange(JSON.parse(e.target.value));
            setInvalid(false);
          } catch {
            setInvalid(true);
          }
        }}
      />
      {invalid && <span className="text-2xs text-destructive">Not valid JSON — last valid value is kept.</span>}
    </label>
  );
}
