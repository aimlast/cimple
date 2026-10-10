/**
 * TeaserColumnsEditor — the teaser inspector's editor for a two-column
 * block ("Who it suits", "Transition", a two-column block the broker added).
 * Each column is a heading plus its content in plain words — a paragraph,
 * one line per point, figures (label + value) or highlights (title +
 * detail). No raw keys and no layout-type box: what a column holds never
 * changes here (two-column-edit.ts). When the right-hand column is drawn
 * from the deal's lines ("Deal at a glance"), only the left one is here.
 */
import { useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { StructuredDataEditor } from "@/components/cim/StructuredDataEditor";
import { MAX_COLUMN_ROWS, columnLabel, columnView, columnWith, type ColumnView } from "./two-column-edit";

type Json = Record<string, any>;
type Side = "left" | "right";

interface Props {
  /** The block's editable data: `{ left, right? }` (the rest of the block is kept by the caller). */
  value: Json;
  sides: Side[];
  disabled?: boolean;
  onChange: (next: Json) => void;
}

export function TeaserColumnsEditor({ value, sides, disabled, onChange }: Props) {
  const shown = sides.filter((s) => value[s] !== undefined && value[s] !== null);
  const fromValue = () => Object.fromEntries(shown.map((s) => [s, columnView(value[s])])) as Partial<Record<Side, ColumnView>>;
  const [views, setViews] = useState(fromValue);
  // The last value this editor sent: anything else (Cancel, a save, another tab) resets the rows.
  const sent = useRef<string>(JSON.stringify(value));
  useEffect(() => {
    const now = JSON.stringify(value);
    if (now === sent.current) return;
    sent.current = now;
    setViews(fromValue());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const update = (side: Side, next: ColumnView) => {
    setViews((v) => ({ ...v, [side]: next }));
    const out = { ...value, [side]: columnWith(value[side], next) };
    sent.current = JSON.stringify(out);
    onChange(out);
  };

  return (
    <div className="space-y-3" data-testid="teaser-columns-editor">
      {shown.map((side) => {
        const v = views[side];
        if (!v) return null;
        return (
          <fieldset key={side} className="space-y-2 rounded-md border border-border p-2.5" data-testid={`teaser-column-${side}`} disabled={disabled}>
            <legend className="px-1 text-xs font-medium">{columnLabel(value[side], side, shown.length)}</legend>
            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">Heading</Label>
              <Input value={v.heading} onChange={(e) => update(side, { ...v, heading: e.target.value })} maxLength={60} placeholder="No heading" className="h-8 text-xs" data-testid={`input-teaser-column-heading-${side}`} />
            </div>
            <ColumnBody side={side} view={v} onChange={(next) => update(side, next)} rawContent={(value[side] as Json | undefined)?.content} onRawChange={(content) => {
              const out = { ...value, [side]: { ...(value[side] as Json), content } };
              sent.current = JSON.stringify(out);
              onChange(out);
            }} />
          </fieldset>
        );
      })}
    </div>
  );
}

function ColumnBody({ side, view, onChange, rawContent, onRawChange }: { side: Side; view: ColumnView; onChange: (v: ColumnView) => void; rawContent: unknown; onRawChange: (c: unknown) => void }) {
  if (view.kind === "text") {
    return (
      <div className="space-y-1">
        <Label className="text-[11px] text-muted-foreground">Text</Label>
        <Textarea value={view.text} onChange={(e) => onChange({ ...view, text: e.target.value })} rows={4} className="resize-y text-xs leading-relaxed" data-testid={`input-teaser-column-text-${side}`} />
      </div>
    );
  }
  if (view.kind === "points") {
    const rows = view.points;
    const set = (i: number, p: string) => onChange({ ...view, points: rows.map((x, j) => (j === i ? p : x)) });
    return (
      <div className="space-y-1.5" data-testid={`teaser-column-points-${side}`}>
        <Label className="text-[11px] text-muted-foreground">Points</Label>
        {rows.length === 0 && <p className="text-[11px] text-muted-foreground">No points yet.</p>}
        {rows.map((p, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <Input value={p} onChange={(e) => set(i, e.target.value)} maxLength={140} placeholder="A point buyers read" className="h-8 text-xs" aria-label={`Point ${i + 1}`} data-testid={`input-teaser-column-point-${side}-${i}`} />
            <RemoveButton label={`Take point ${i + 1} off`} onClick={() => onChange({ ...view, points: rows.filter((_, j) => j !== i) })} />
          </div>
        ))}
        {rows.length < MAX_COLUMN_ROWS && <AddButton label="Add a point" onClick={() => onChange({ ...view, points: [...rows, ""] })} testId={`button-teaser-column-add-${side}`} />}
      </div>
    );
  }
  if (view.kind === "figures") {
    const rows = view.figures;
    const set = (i: number, f: { label: string; value: string }) => onChange({ ...view, figures: rows.map((x, j) => (j === i ? f : x)) });
    return (
      <div className="space-y-1.5" data-testid={`teaser-column-figures-${side}`}>
        <Label className="text-[11px] text-muted-foreground">Figures</Label>
        {rows.map((f, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <Input value={f.label} onChange={(e) => set(i, { ...f, label: e.target.value.replace(/:/g, "") })} maxLength={40} placeholder="Label" className="h-8 w-[42%] text-xs" aria-label={`Figure ${i + 1} label`} />
            <Input value={f.value} onChange={(e) => set(i, { ...f, value: e.target.value })} maxLength={60} placeholder="What buyers read" className="h-8 min-w-0 flex-1 text-xs" aria-label={`Figure ${i + 1} value`} />
            <RemoveButton label={`Take figure ${i + 1} off`} onClick={() => onChange({ ...view, figures: rows.filter((_, j) => j !== i) })} />
          </div>
        ))}
        {rows.length < MAX_COLUMN_ROWS && <AddButton label="Add a figure" onClick={() => onChange({ ...view, figures: [...rows, { label: "", value: "" }] })} />}
      </div>
    );
  }
  if (view.kind === "highlights") {
    const rows = view.highlights;
    const set = (i: number, h: { title: string; detail: string }) => onChange({ ...view, highlights: rows.map((x, j) => (j === i ? h : x)) });
    return (
      <div className="space-y-1.5" data-testid={`teaser-column-highlights-${side}`}>
        <Label className="text-[11px] text-muted-foreground">Highlights</Label>
        {rows.map((h, i) => (
          <div key={i} className="flex items-start gap-1.5">
            <div className="min-w-0 flex-1 space-y-1">
              <Input value={h.title} onChange={(e) => set(i, { ...h, title: e.target.value })} maxLength={80} placeholder="Highlight" className="h-8 text-xs" aria-label={`Highlight ${i + 1}`} />
              <Textarea value={h.detail} onChange={(e) => set(i, { ...h, detail: e.target.value })} rows={2} placeholder="A sentence about it (optional)" className="resize-y text-xs" aria-label={`Highlight ${i + 1} detail`} />
            </div>
            <RemoveButton label={`Take highlight ${i + 1} off`} onClick={() => onChange({ ...view, highlights: rows.filter((_, j) => j !== i) })} />
          </div>
        ))}
        {rows.length < MAX_COLUMN_ROWS && <AddButton label="Add a highlight" onClick={() => onChange({ ...view, highlights: [...rows, { title: "", detail: "" }] })} />}
      </div>
    );
  }
  // Something else (rare: a column a CIM layout put there): its content only — never its layout type.
  return (
    <div className="space-y-1">
      <Label className="text-[11px] text-muted-foreground">Content</Label>
      <StructuredDataEditor value={(rawContent ?? {}) as Json} onChange={(next) => onRawChange(next)} compact />
    </div>
  );
}

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button type="button" size="icon" variant="ghost" className="h-8 w-8 shrink-0 text-muted-foreground hover:text-red-500" aria-label={label} title={label} onClick={onClick}>
      <X className="h-3.5 w-3.5" />
    </Button>
  );
}

function AddButton({ label, onClick, testId }: { label: string; onClick: () => void; testId?: string }) {
  return (
    <Button type="button" size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs text-teal hover:text-teal" onClick={onClick} data-testid={testId}>
      <Plus className="h-3 w-3" /> {label}
    </Button>
  );
}
