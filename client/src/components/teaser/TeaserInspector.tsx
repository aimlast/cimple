/**
 * TeaserInspector — the teaser editor's right pane.
 *
 *  - Header: label, one-line description (≤ 140), chips (≤ 5), each checked.
 *  - A block: title; layout [Change]; the check (red "Buyers won't see this
 *    block…", amber "“…” may let someone recognise the business", or the
 *    check line "✓ No names, places or contacts found"); the content —
 *    key-number cells typed over inline ("Edited by you · Reset from the
 *    facts"), "Deal at a glance" lines the broker can add and take off,
 *    prose, or the structured editor; "Rewrite with AI" for the
 *    blocks the AI writes (a proposal the broker applies or discards);
 *    hide / duplicate / delete.
 *
 * Everything saves through useTeaser (the draft's rev; a stale tab gets the
 * latest state back).
 */
import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, Check, CheckCircle2, Copy, Eye, EyeOff, Loader2, Plus, RotateCcw, ShieldAlert, Sparkles, Trash2, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { StructuredDataEditor } from "@/components/cim/StructuredDataEditor";
import { LayoutIcon } from "@/components/cim-builder/LayoutGallery";
import { TONES } from "@/components/cim-builder/AiWriterPanel";
import { layoutLabel } from "@shared/cim-layouts";
import { MAX_DEAL_LINES, TEASER_LIMITS, blockCells, cellLimit, shownCells, type KeyCell, type TeaserBlock } from "@shared/teaser";
import { cn } from "@/lib/utils";
import type { TeaserState } from "./api";
import type { BlockProposal, TeaserApi } from "./useTeaser";
import { CHECK_HELP, CHECK_LINE, blockName, checkFor, heldSentence, isFixedBlock, pinpointSentence } from "./draft-view";

const LENGTHS = [
  { key: "shorter", label: "Shorter" },
  { key: "same", label: "Same length" },
  { key: "longer", label: "Longer" },
] as const;

/** Layouts Cimple can rewrite (text, lists, highlights). */
const REWRITABLE = new Set(["prose_highlight", "callout_list", "numbered_list", "icon_stat_row", "stat_callout", "tag_cloud"]);

interface Props {
  api: TeaserApi;
  state: TeaserState;
  selectedId: string | null;
  /** Blocks Cimple is filling right now (owned by a running write). */
  writing: Set<string>;
  onChangeLayout: (b: TeaserBlock) => void;
  onDelete: (b: TeaserBlock) => void;
  onSelect: (id: string | null) => void;
}

export function TeaserInspector({ api, state, selectedId, writing, onChangeLayout, onDelete, onSelect }: Props) {
  if (selectedId === "header") return <HeaderEditor api={api} state={state} />;
  const block = state.teaser.draft.blocks.find((b) => b.id === selectedId) ?? null;
  if (!block) {
    return (
      <div className="flex h-full min-h-[240px] flex-col items-center justify-center gap-2 p-6 text-center">
        <Sparkles className="h-7 w-7 opacity-25" />
        <p className="max-w-[240px] text-xs text-muted-foreground">
          Select a block — on the page or in the list — to edit its words, its key numbers or its layout, or to rewrite it with AI.
        </p>
        <Button size="sm" variant="outline" className="mt-1 h-7 text-xs" onClick={() => onSelect("header")}>Edit the header</Button>
      </div>
    );
  }
  return (
    <BlockEditor
      key={`${block.id}:${state.teaser.draftRev}`}
      api={api}
      state={state}
      block={block}
      writing={writing.has(block.id)}
      onChangeLayout={() => onChangeLayout(block)}
      onDelete={() => onDelete(block)}
    />
  );
}

// ── The check (shared by blocks) ────────────────────────────────────────────
function CheckBox({ held, pinpoint }: { held: string | null; pinpoint: string[] }) {
  if (held) {
    return (
      <div className="flex gap-2 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-foreground" role="alert" data-testid="teaser-guard-banner">
        <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" />
        <span>{held}</span>
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      {pinpoint.map((p) => (
        <div key={p} className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs" data-testid="teaser-pinpoint-note">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
          <span>{pinpointSentence(p)}</span>
        </div>
      ))}
      <div className="flex gap-2 text-xs" data-testid="teaser-check-line">
        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
        <span>
          <span className="text-foreground">{CHECK_LINE}</span>
          <span className="mt-0.5 block text-[11px] text-muted-foreground">{CHECK_HELP}</span>
        </span>
      </div>
    </div>
  );
}

// ── Header ─────────────────────────────────────────────────────────────────
function HeaderEditor({ api, state }: { api: TeaserApi; state: TeaserState }) {
  const h = state.teaser.draft.header ?? { label: "CONFIDENTIAL OPPORTUNITY", tagline: "", chips: [] };
  const [label, setLabel] = useState(h.label);
  const [tagline, setTagline] = useState(h.tagline);
  const [chips, setChips] = useState<string[]>(h.chips);
  const [chip, setChip] = useState("");
  useEffect(() => {
    setLabel(h.label);
    setTagline(h.tagline);
    setChips(h.chips);
  }, [state.teaser.draftRev]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = label !== h.label || tagline !== h.tagline || JSON.stringify(chips) !== JSON.stringify(h.chips);
  const addChip = () => {
    const c = chip.replace(/\s+/g, " ").trim();
    if (!c || chips.length >= TEASER_LIMITS.chips) return;
    setChips([...chips, c]);
    setChip("");
  };
  return (
    <div className="space-y-4 p-4" data-testid="teaser-header-editor">
      <div>
        <p className="text-sm font-semibold">Header</p>
        <p className="text-[11px] text-muted-foreground">The top of page 1. The codename is the deal's — change it on the CIM tab (Blind CIM card).</p>
      </div>
      {state.teaser.headerProblem && <CheckBox held={`Buyers see a plain header instead: ${state.teaser.headerProblem.replace(/^The header /, "the header ")}`} pinpoint={[]} />}
      <div className="space-y-1.5">
        <Label className="text-xs">Label</Label>
        <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} className="h-8 text-xs" />
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs">Codename</Label>
        <p className="rounded-md border border-border bg-muted/30 px-2.5 py-1.5 text-xs">{state.teaser.codename}</p>
      </div>
      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between">
          <Label className="text-xs">One-line description</Label>
          <span className={cn("text-[10px] tabular-nums", tagline.length > TEASER_LIMITS.tagline ? "text-red-400" : "text-muted-foreground")}>{tagline.length}/{TEASER_LIMITS.tagline}</span>
        </div>
        <Textarea value={tagline} onChange={(e) => setTagline(e.target.value)} rows={3} className="resize-none text-xs" data-testid="input-teaser-tagline" />
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs">Chips ({chips.length}/{TEASER_LIMITS.chips})</Label>
        <div className="flex flex-wrap gap-1.5">
          {chips.map((c, i) => (
            <span key={`${c}-${i}`} className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 py-0.5 pl-2.5 pr-1 text-[11px]">
              {c}
              <button type="button" onClick={() => setChips(chips.filter((_, j) => j !== i))} className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`Remove ${c}`}>
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
        {chips.length < TEASER_LIMITS.chips && (
          <div className="flex gap-1.5">
            <Input value={chip} onChange={(e) => setChip(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addChip(); } }} placeholder="e.g. Recurring revenue" maxLength={40} className="h-8 text-xs" />
            <Button size="sm" variant="outline" className="h-8 shrink-0 text-xs" onClick={addChip} disabled={!chip.trim()}><Plus className="h-3.5 w-3.5" /></Button>
          </div>
        )}
        <p className="text-[11px] text-muted-foreground">The industry, the province or state and a years range work well. Never the town.</p>
      </div>
      <div className="flex gap-2 border-t border-border pt-3">
        <Button
          size="sm"
          className="h-8 flex-1 gap-1.5 bg-teal text-xs text-teal-foreground hover:bg-teal/90"
          disabled={!dirty || api.header.isPending || tagline.length > TEASER_LIMITS.tagline}
          onClick={() => api.header.mutate({ label: label.trim(), tagline: tagline.trim(), chips })}
          data-testid="button-save-teaser-header"
        >
          {api.header.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Save
        </Button>
        <Button size="sm" variant="ghost" className="h-8 text-xs" disabled={!dirty} onClick={() => { setLabel(h.label); setTagline(h.tagline); setChips(h.chips); }}>Cancel</Button>
      </div>
    </div>
  );
}

// ── A block ─────────────────────────────────────────────────────────────────
type Json = Record<string, any>;

/** Layout settings the editor keeps but doesn't show (how a list is drawn, the index flag…). */
const KEPT_KEYS = ["style", "columns", "ordered", "indexed", "expandable", "series"];

/** The part of layoutData the structured editor shows (cells and the data drawn from them stay out). */
function editableData(b: TeaserBlock): Json {
  const d: Json = { ...(b.layoutData ?? {}) };
  const hasCells = Array.isArray(d.cells);
  delete d.cells;
  if (hasCells) {
    delete d.metrics;
    delete d.stats;
    if (b.layoutType === "two_column") delete d.right;
  }
  if (b.layoutType === "prose_highlight") delete d.body;
  for (const k of KEPT_KEYS) delete d[k];
  return d;
}

/** The edited fields put back over everything the editor didn't show. */
function mergedData(b: TeaserBlock, edited: Json): Json {
  const { cells: _cells, ...rest } = (b.layoutData ?? {}) as Json;
  void _cells;
  return { ...rest, ...edited };
}

function BlockEditor({
  api, state, block, writing, onChangeLayout, onDelete,
}: { api: TeaserApi; state: TeaserState; block: TeaserBlock; writing: boolean; onChangeLayout: () => void; onDelete: () => void }) {
  const check = checkFor(state.teaser.checks, block.id);
  const held = block.hidden && !block.placeholder ? null : heldSentence(check);
  const fixed = isFixedBlock(block);
  const allCells = blockCells(block);
  const cells = shownCells(allCells);
  const isKeyNumbers = block.slot === "key_numbers" || block.slot === "listing_facts";
  // "Deal at a glance" / "The deal": a two-column block whose right column is drawn from lines.
  const dealLines = block.layoutType === "two_column" && Array.isArray(block.layoutData?.cells);
  const rewritable = !fixed && REWRITABLE.has(block.layoutType);

  const [title, setTitle] = useState(block.title);
  const [body, setBody] = useState(block.body ?? (typeof block.layoutData?.body === "string" ? (block.layoutData.body as string) : ""));
  const [data, setData] = useState<Json>(() => editableData(block));
  const initialData = useMemo(() => JSON.stringify(editableData(block)), [block]);
  const prose = block.layoutType === "prose_highlight";
  const showData = !prose && Object.keys(editableData(block)).length > 0;
  const dirty = title !== block.title || (prose && body !== (block.body ?? (block.layoutData?.body as string) ?? "")) || (showData && JSON.stringify(data) !== initialData);

  const save = () => {
    const patch: { id: string; title?: string; body?: string | null; layoutData?: Record<string, unknown> } = { id: block.id };
    if (title !== block.title) patch.title = title;
    if (prose) {
      patch.body = body;
      patch.layoutData = mergedData(block, { ...editableData(block), body });
    } else if (showData && JSON.stringify(data) !== initialData) {
      patch.layoutData = mergedData(block, data);
    }
    api.patchBlock.mutate(patch);
  };

  return (
    <div className="space-y-4 p-4" data-testid="teaser-block-editor">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{blockName(block)}</p>
          <p className="text-[11px] text-muted-foreground">
            {fixed ? "Made from the deal's information" : block.origin === "ai" ? "Written by Cimple from the Blind CIM" : "Your own block"}
          </p>
        </div>
        {writing && <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-teal"><Loader2 className="h-3 w-3 animate-spin" /> Writing…</span>}
      </div>

      {block.placeholder && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs" data-testid="teaser-write-this">
          Cimple didn't write this block, so buyers don't see it. Write it yourself below{rewritable ? ", or use Rewrite with AI" : ""} — it shows to buyers once it has words.
        </div>
      )}
      <CheckBox held={held} pinpoint={block.hidden ? [] : check?.pinpoint ?? []} />

      <div className="space-y-1.5">
        <Label className="text-xs">Title</Label>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={TEASER_LIMITS.title} placeholder="No heading" className="h-8 text-xs" data-testid="input-teaser-block-title" />
      </div>

      <div className="flex items-center gap-2 text-xs">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-border text-muted-foreground"><LayoutIcon layoutType={block.layoutType} className="h-3.5 w-3.5" /></span>
        <span className="min-w-0 flex-1 truncate">{layoutLabel(block.layoutType)}</span>
        {!isKeyNumbers && block.slot !== "trend" && (
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onChangeLayout} disabled={writing}>Change</Button>
        )}
      </div>

      {dealLines ? (
        <DealLinesEditor api={api} block={block} cells={allCells} disabled={writing} />
      ) : cells.length > 0 && (
        <CellsEditor api={api} state={state} block={block} cells={cells} isKeyNumbers={isKeyNumbers} disabled={writing} />
      )}

      {prose && (
        <div className="space-y-1.5">
          <Label className="text-xs">Text</Label>
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={7} className="resize-y text-xs leading-relaxed" data-testid="input-teaser-block-body" disabled={writing} />
        </div>
      )}
      {showData && (
        <div className="space-y-1.5">
          <Label className="text-xs">{cells.length > 0 || dealLines ? "The rest of the block" : "Content"}</Label>
          <StructuredDataEditor value={data} onChange={(next) => setData(next as Json)} compact />
        </div>
      )}

      {(dirty || prose || showData) && (
        <div className="flex gap-2">
          <Button size="sm" className="h-8 flex-1 gap-1.5 bg-teal text-xs text-teal-foreground hover:bg-teal/90" disabled={!dirty || api.patchBlock.isPending || writing} onClick={save} data-testid="button-save-teaser-block">
            {api.patchBlock.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Save
          </Button>
          <Button size="sm" variant="ghost" className="h-8 text-xs" disabled={!dirty} onClick={() => { setTitle(block.title); setBody(block.body ?? ""); setData(editableData(block)); }}>Cancel</Button>
        </div>
      )}

      {fixed && (
        <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/20 px-3 py-2">
          <p className="text-[11px] text-muted-foreground">
            {block.slot === "next_step" || block.slot === "confidentiality"
              ? <>Your brokerage's wording (<a href="/broker/settings?tab=brand&section=teaser" className="text-teal underline-offset-2 hover:underline">Settings → Brand & templates → Teaser</a>).</>
              : "Recalculated from the deal's information."}
          </p>
          <Button size="sm" variant="outline" className="h-7 shrink-0 gap-1 text-xs" disabled={api.reset.isPending || writing} onClick={() => api.reset.mutate(block.id)} data-testid="button-teaser-reset-facts">
            {api.reset.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />} Reset from the facts
          </Button>
        </div>
      )}

      {rewritable && <RewritePanel api={api} block={block} disabled={writing} />}

      <div className="flex flex-wrap gap-2 border-t border-border pt-3">
        <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={() => api.patchBlock.mutate({ id: block.id, hidden: !block.hidden })} disabled={api.patchBlock.isPending || (block.placeholder && block.hidden)}>
          {block.hidden ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />} {block.hidden ? "Show to buyers" : "Hide from buyers"}
        </Button>
        <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={() => api.duplicate.mutate(block.id)} disabled={api.duplicate.isPending}>
          <Copy className="h-3 w-3" /> Duplicate
        </Button>
        <Button size="sm" variant="ghost" className="ml-auto h-7 gap-1 text-xs text-red-500 hover:text-red-500" onClick={onDelete}>
          <Trash2 className="h-3 w-3" /> Delete
        </Button>
      </div>
    </div>
  );
}

/** Key-number cells, typed over inline; an edited one says so and can go back to the facts. */
function CellsEditor({ api, state, block, cells, isKeyNumbers, disabled }: { api: TeaserApi; state: TeaserState; block: TeaserBlock; cells: KeyCell[]; isKeyNumbers: boolean; disabled: boolean }) {
  const hasPrice = cells.some((c) => c.key === "askingPrice");
  return (
    <div className="space-y-2" data-testid="teaser-cells">
      <Label className="text-xs">{isKeyNumbers ? "Key numbers" : "Lines"}</Label>
      <div className="space-y-2">
        {cells.map((c) => (
          <CellRow key={c.key} api={api} blockId={block.id} cell={c} disabled={disabled} />
        ))}
      </div>
      {(hasPrice || isKeyNumbers) && (
        <label className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-xs">
          <span>
            Show the asking price
            <span className="block text-[11px] text-muted-foreground">
              {cells.find((c) => c.key === "askingPrice")?.edited ? "You typed over the price, so buyers read what you typed." : "Off: buyers read “Price on request”."}
            </span>
          </span>
          <Switch checked={state.teaser.showAskingPrice} onCheckedChange={(v) => api.settings.mutate({ showAskingPrice: v })} disabled={api.settings.isPending || disabled} data-testid="switch-teaser-show-price" />
        </label>
      )}
    </div>
  );
}

/**
 * "Deal at a glance": each line typed over inline (a facts line says "Edited
 * by you · Reset"), taken off with ×, and "Add a line" for the broker's own.
 * A facts line taken off is listed under "Taken off" with "Show again".
 */
function DealLinesEditor({ api, block, cells, disabled }: { api: TeaserApi; block: TeaserBlock; cells: KeyCell[]; disabled: boolean }) {
  const shown = cells.filter((c) => !c.removed);
  const off = cells.filter((c) => c.removed);
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [value, setValue] = useState("");
  const full = shown.length >= MAX_DEAL_LINES;
  const columnTitle = typeof (block.layoutData?.right as { title?: unknown } | undefined)?.title === "string" && (block.layoutData.right as { title: string }).title.trim()
    ? (block.layoutData.right as { title: string }).title
    : "Deal at a glance";
  const add = () => {
    const l = label.replace(/\s+/g, " ").trim();
    const v = value.replace(/\s+/g, " ").trim();
    if (!l || !v) return;
    api.addLine.mutate({ id: block.id, label: l, value: v }, { onSuccess: () => { setLabel(""); setValue(""); setAdding(false); } });
  };
  return (
    <div className="space-y-2" data-testid="teaser-deal-lines">
      <Label className="text-xs">{columnTitle}</Label>
      {shown.length === 0 && !adding && (
        <p className="rounded-md border border-dashed border-border px-3 py-2 text-[11px] text-muted-foreground">
          No lines yet — the deal's information doesn't say the sale type, the reason or the handover plainly. Add the ones you want buyers to see.
        </p>
      )}
      <div className="space-y-2">
        {shown.map((c) => (
          <div key={c.key} className="flex items-end gap-1.5">
            <div className="min-w-0 flex-1"><CellRow api={api} blockId={block.id} cell={c} disabled={disabled} /></div>
            <Button
              type="button" size="icon" variant="ghost" className="h-8 w-8 shrink-0 text-muted-foreground hover:text-red-500"
              aria-label={`Take “${c.label}” off`} title="Take this line off"
              disabled={disabled || api.removeLine.isPending}
              onClick={() => api.removeLine.mutate({ id: block.id, key: c.key })}
              data-testid={`button-teaser-line-remove-${c.key}`}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
      </div>
      {adding ? (
        <div className="space-y-1.5 rounded-md border border-border p-2.5" data-testid="teaser-line-add-form">
          <Input value={label} onChange={(e) => setLabel(e.target.value.replace(/:/g, ""))} maxLength={40} placeholder="Label, e.g. Training" className="h-8 text-xs" aria-label="Line label" autoFocus data-testid="input-teaser-line-label" />
          <Input
            value={value} onChange={(e) => setValue(e.target.value)} maxLength={TEASER_LIMITS.phraseCell} placeholder="What buyers read, e.g. Four weeks on site"
            className="h-8 text-xs" aria-label="Line value"
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } if (e.key === "Escape") setAdding(false); }}
            data-testid="input-teaser-line-value"
          />
          <div className="flex gap-2">
            <Button size="sm" className="h-7 flex-1 gap-1 bg-teal text-xs text-teal-foreground hover:bg-teal/90" disabled={!label.trim() || !value.trim() || api.addLine.isPending || disabled} onClick={add} data-testid="button-teaser-line-save">
              {api.addLine.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />} Add the line
            </Button>
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => { setAdding(false); setLabel(""); setValue(""); }}>Cancel</Button>
          </div>
        </div>
      ) : (
        <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" disabled={disabled || full} onClick={() => setAdding(true)} title={full ? `Up to ${MAX_DEAL_LINES} lines` : undefined} data-testid="button-teaser-line-add">
          <Plus className="h-3 w-3" /> Add a line
        </Button>
      )}
      {off.length > 0 && (
        <div className="space-y-1 text-[11px] text-muted-foreground" data-testid="teaser-lines-off">
          <p>Taken off (buyers don't see these):</p>
          {off.map((c) => (
            <p key={c.key} className="flex items-center justify-between gap-2">
              <span className="truncate">{c.label}</span>
              <button type="button" className="shrink-0 text-teal underline-offset-2 hover:underline" disabled={disabled || api.patchCell.isPending} onClick={() => api.patchCell.mutate({ id: block.id, key: c.key, reset: true })}>
                Show again
              </button>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function CellRow({ api, blockId, cell, disabled }: { api: TeaserApi; blockId: string; cell: KeyCell; disabled: boolean }) {
  // {price} / {contact}: filled for each buyer from your listing and brand — the box stays empty until you type over it.
  const token = /\{(price|contact|firm)\}/.test(cell.value);
  const shown = token ? "" : cell.value;
  const [value, setValue] = useState(shown);
  useEffect(() => setValue(shown), [shown]);
  const limit = cellLimit(cell.key);
  const commit = () => {
    const v = value.replace(/\s+/g, " ").trim();
    if (!v || v === shown) {
      setValue(shown);
      return;
    }
    api.patchCell.mutate({ id: blockId, key: cell.key, value: v });
  };
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">{cell.label}</span>
        {cell.added ? (
          <span className="text-[10px] text-teal">Your line</span>
        ) : cell.edited && (
          <span className="text-[10px] text-teal">
            Edited by you ·{" "}
            <button type="button" className="underline-offset-2 hover:underline" onClick={() => api.patchCell.mutate({ id: blockId, key: cell.key, reset: true })} disabled={disabled}>
              Reset from the facts
            </button>
          </span>
        )}
      </div>
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); } if (e.key === "Escape") setValue(shown); }}
        maxLength={limit}
        disabled={disabled}
        placeholder={token ? (cell.key === "askingPrice" ? "Your listed asking price" : "Filled in for each buyer") : undefined}
        title={token && cell.key === "askingPrice" ? "Buyers see your listed asking price in the teaser's number style. Type here to show something else." : undefined}
        className={cn("h-8 text-xs", cell.edited && "border-teal/50")}
        aria-label={cell.label}
        data-testid={`input-teaser-cell-${cell.key}`}
      />
    </div>
  );
}

/** Rewrite with AI: a proposal shown here, applied or discarded by the broker. */
function RewritePanel({ api, block, disabled }: { api: TeaserApi; block: TeaserBlock; disabled: boolean }) {
  const [instructions, setInstructions] = useState("");
  const [tones, setTones] = useState<string[]>([]);
  const [length, setLength] = useState<string>("same");
  const [proposal, setProposal] = useState<BlockProposal | null>(null);
  const nothing = !instructions.trim() && tones.length === 0 && length === "same";
  const ask = () =>
    api.rewrite.mutate(
      { id: block.id, instructions: instructions.trim() || null, tones, length: length === "same" ? null : length },
      { onSuccess: (r) => setProposal(r.proposal) },
    );
  const apply = () => {
    if (!proposal) return;
    api.patchBlock.mutate(
      { id: block.id, title: proposal.title, layoutData: proposal.layoutData, body: proposal.body },
      { onSuccess: () => setProposal(null) },
    );
  };

  if (proposal) {
    const items = Array.isArray(proposal.layoutData?.items) ? (proposal.layoutData.items as Array<{ title?: string; description?: string }>) : [];
    return (
      <div className="space-y-2.5 rounded-lg border border-teal/40 bg-teal/5 p-3" data-testid="teaser-rewrite-proposal">
        <p className="flex items-center gap-1.5 text-xs font-medium"><Sparkles className="h-3.5 w-3.5 text-teal" /> Rewrite ready</p>
        <div className="max-h-56 space-y-1.5 overflow-y-auto rounded-md border border-border bg-background/60 p-2.5 text-xs">
          {proposal.title && <p className="font-semibold">{proposal.title}</p>}
          {proposal.body && <p className="leading-relaxed text-foreground/85">{proposal.body}</p>}
          {items.length > 0 && (
            <ul className="list-disc space-y-1 pl-4">
              {items.map((it, i) => <li key={i}><span className="font-medium">{it.title}</span>{it.description ? ` — ${it.description}` : ""}</li>)}
            </ul>
          )}
        </div>
        {proposal.pinpoint.map((p) => (
          <p key={p} className="flex gap-1.5 text-[11px] text-amber-500"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />{pinpointSentence(p)}</p>
        ))}
        <div className="flex gap-2">
          <Button size="sm" className="h-7 flex-1 gap-1 bg-teal text-xs text-teal-foreground hover:bg-teal/90" onClick={apply} disabled={api.patchBlock.isPending}>
            {api.patchBlock.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />} Apply
          </Button>
          <Button size="sm" variant="outline" className="h-7 flex-1 gap-1 text-xs" onClick={() => setProposal(null)}>
            <X className="h-3 w-3" /> Discard
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      <p className="flex items-center gap-1.5 text-xs font-medium"><Sparkles className="h-3.5 w-3.5 text-teal" /> Rewrite with AI</p>
      <Textarea
        value={instructions}
        onChange={(e) => setInstructions(e.target.value)}
        maxLength={600}
        rows={2}
        disabled={api.rewrite.isPending || disabled}
        className="resize-none text-xs leading-relaxed"
        placeholder="What should change? e.g. “Lead with the recurring revenue.”"
        data-testid="input-teaser-rewrite"
      />
      <div className="flex flex-wrap gap-1.5">
        {TONES.slice(0, 4).map((t) => {
          const on = tones.includes(t.key);
          return (
            <button
              key={t.key}
              type="button"
              aria-pressed={on}
              disabled={api.rewrite.isPending || disabled}
              onClick={() => setTones(on ? tones.filter((x) => x !== t.key) : [...tones, t.key].slice(-3))}
              className={cn("rounded-full border px-2.5 py-1 text-[11px] transition-colors", on ? "border-teal bg-teal/15 text-foreground" : "border-border text-muted-foreground hover:text-foreground")}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      <div className="grid grid-cols-3 rounded-md border border-border bg-muted/30 p-0.5">
        {LENGTHS.map((l) => (
          <button
            key={l.key}
            type="button"
            aria-pressed={length === l.key}
            onClick={() => setLength(l.key)}
            className={cn("rounded px-2 py-1 text-[11px] transition-colors", length === l.key ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
          >
            {l.label}
          </button>
        ))}
      </div>
      <Button
        size="sm"
        className="h-8 w-full gap-1.5 bg-teal text-xs text-teal-foreground hover:bg-teal/90"
        disabled={nothing || api.rewrite.isPending || disabled}
        onClick={ask}
        title={nothing ? "Type an instruction, or pick a tone or length" : undefined}
        data-testid="button-teaser-rewrite"
      >
        {api.rewrite.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
        {api.rewrite.isPending ? "Rewriting… (about 15 seconds)" : "Rewrite this block"}
      </Button>
      <p className="text-[10px] text-muted-foreground">Written from the anonymous Blind CIM. You see it before anything changes.</p>
    </div>
  );
}
