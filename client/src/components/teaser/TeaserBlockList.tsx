/**
 * TeaserBlockList — the teaser editor's left pane: the header, then every
 * block in order. Drag by the handle (or Alt+↑/↓) to reorder, "+" between
 * rows to add a block, and a menu per block (rename, duplicate, hide, move,
 * delete). Chips say what needs the broker: "Names the business" (red, held
 * from buyers), "May be recognisable" (amber), "Write this" (Cimple didn't
 * write it), "Hidden", "Seller asked to change".
 */
import { useEffect, useRef, useState } from "react";
import { Reorder, useDragControls } from "framer-motion";
import {
  AlertTriangle, ArrowDown, ArrowUp, Copy, Eye, EyeOff, GripVertical, Loader2, MessageSquareText, MoreHorizontal,
  Pencil, PenLine, Plus, ShieldAlert, Trash2, PanelTop,
} from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { LayoutIcon } from "@/components/cim-builder/LayoutGallery";
import type { TeaserBlock, TeaserBlockCheck } from "@shared/teaser";
import { blockName, checkFor, heldSentence } from "./draft-view";

export interface TeaserBlockListActions {
  onSelect: (id: string) => void;
  onReorder: (ids: string[]) => void;
  onAddAfter: (afterId: string | null) => void;
  onRename: (id: string, title: string) => void;
  onDuplicate: (id: string) => void;
  onToggleHidden: (b: TeaserBlock) => void;
  onDelete: (b: TeaserBlock) => void;
}

interface Props extends TeaserBlockListActions {
  blocks: TeaserBlock[];
  checks: TeaserBlockCheck[];
  selectedId: string | null;
  headerProblem: string | null;
  /** Blocks Cimple is writing right now. */
  writing: Set<string>;
  /** The seller's note mentions these blocks ("Seller asked to change"). */
  sellerFlagged: Set<string>;
  disabled?: boolean;
}

export function TeaserBlockList({ blocks, checks, selectedId, headerProblem, writing, sellerFlagged, disabled = false, ...actions }: Props) {
  const [items, setItems] = useState(blocks);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const dragging = useRef(false);
  useEffect(() => {
    if (!dragging.current) setItems(blocks);
  }, [blocks]);

  const commit = (next: TeaserBlock[]) => {
    const ids = next.map((b) => b.id);
    if (ids.join() !== blocks.map((b) => b.id).join()) actions.onReorder(ids);
  };
  const move = (idx: number, dir: -1 | 1) => {
    const to = idx + dir;
    if (to < 0 || to >= items.length) return;
    const next = [...items];
    [next[idx], next[to]] = [next[to], next[idx]];
    setItems(next);
    commit(next);
  };

  return (
    <div className="py-2" data-testid="teaser-block-list">
      <button
        type="button"
        onClick={() => actions.onSelect("header")}
        aria-current={selectedId === "header" ? "true" : undefined}
        className={cn(
          "mx-2 mb-1 flex w-[calc(100%-1rem)] items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-teal/60",
          selectedId === "header" ? "bg-teal/10 ring-1 ring-teal/40" : "hover:bg-muted/60",
        )}
        data-testid="teaser-row-header"
      >
        <span className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded border", selectedId === "header" ? "border-teal/40 text-teal" : "border-border text-muted-foreground")}>
          <PanelTop className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-medium">Header</span>
          <span className="block text-[10px] text-muted-foreground">Codename, one line, chips</span>
        </span>
        {headerProblem && <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-red-400" aria-label="The header names the business" />}
      </button>
      <InsertGap label="Add a block at the top" onClick={() => actions.onAddAfter(null)} disabled={disabled} />
      <Reorder.Group axis="y" values={items} onReorder={setItems} className="space-y-0.5 px-2" as="div">
        {items.map((b, idx) => (
          <Row
            key={b.id}
            block={b}
            idx={idx}
            total={items.length}
            check={checkFor(checks, b.id)}
            selected={b.id === selectedId}
            writing={writing.has(b.id)}
            sellerFlagged={sellerFlagged.has(b.id)}
            disabled={disabled}
            onDragStart={() => { dragging.current = true; }}
            onDragEnd={() => { dragging.current = false; commit(itemsRef.current); }}
            onMove={(dir) => move(idx, dir)}
            {...actions}
          />
        ))}
      </Reorder.Group>
      <div className="px-3 pt-2">
        <button
          type="button"
          disabled={disabled}
          onClick={() => actions.onAddAfter(items[items.length - 1]?.id ?? null)}
          className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border py-2 text-xs text-muted-foreground hover:border-teal/50 hover:text-foreground disabled:opacity-50"
          data-testid="button-teaser-add-block"
        >
          <Plus className="h-3.5 w-3.5" /> Add a block
        </button>
      </div>
    </div>
  );
}

interface RowProps extends TeaserBlockListActions {
  block: TeaserBlock;
  idx: number;
  total: number;
  check: TeaserBlockCheck | null;
  selected: boolean;
  writing: boolean;
  sellerFlagged: boolean;
  disabled: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onMove: (dir: -1 | 1) => void;
}

function Row({
  block: b, idx, total, check, selected, writing, sellerFlagged, disabled, onDragStart, onDragEnd, onMove,
  onSelect, onAddAfter, onRename, onDuplicate, onToggleHidden, onDelete,
}: RowProps) {
  const controls = useDragControls();
  const name = blockName(b);
  const [renaming, setRenaming] = useState(false);
  const renameFromMenu = useRef(false);
  const [draft, setDraft] = useState(b.title);
  useEffect(() => { if (!renaming) setDraft(b.title); }, [b.title, renaming]);
  const held = !!heldSentence(check) && !b.hidden && !b.placeholder;
  const pinpoint = (check?.pinpoint.length ?? 0) > 0 && !b.hidden;

  const saveRename = () => {
    const t = draft.replace(/\s+/g, " ").trim();
    setRenaming(false);
    if (t !== b.title) onRename(b.id, t);
  };

  return (
    <Reorder.Item
      value={b}
      as="div"
      dragListener={false}
      dragControls={controls}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className="relative"
      whileDrag={{ scale: 1.02, boxShadow: "0 8px 24px rgba(0,0,0,0.25)", zIndex: 20 }}
    >
      <div
        role="button"
        tabIndex={0}
        aria-current={selected ? "true" : undefined}
        onClick={() => !renaming && onSelect(b.id)}
        onKeyDown={(e) => {
          if (renaming) return;
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(b.id); }
          if (!disabled && e.altKey && e.key === "ArrowUp") { e.preventDefault(); onMove(-1); }
          if (!disabled && e.altKey && e.key === "ArrowDown") { e.preventDefault(); onMove(1); }
        }}
        className={cn(
          "group flex items-center gap-1.5 rounded-md bg-card py-1.5 pl-1 pr-1.5 outline-none transition-colors cursor-pointer select-none",
          "focus-visible:ring-2 focus-visible:ring-teal/60",
          selected ? "bg-teal/10 ring-1 ring-teal/40" : "hover:bg-muted/60",
        )}
        data-testid={`teaser-row-${b.id}`}
      >
        <span
          className={cn("touch-none shrink-0 p-1 text-muted-foreground/50 hover:text-foreground", disabled ? "cursor-not-allowed" : "cursor-grab active:cursor-grabbing")}
          onPointerDown={(e) => { if (disabled) return; e.preventDefault(); controls.start(e); }}
          aria-label="Drag to reorder"
          title="Drag to reorder (or Alt + ↑/↓)"
        >
          <GripVertical className="h-3.5 w-3.5" />
        </span>
        <span className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded border", selected ? "border-teal/40 text-teal" : "border-border text-muted-foreground")}>
          <LayoutIcon layoutType={b.layoutType} className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          {renaming ? (
            <Input
              autoFocus
              value={draft}
              maxLength={120}
              onChange={(e) => setDraft(e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
              onClick={(e) => e.stopPropagation()}
              onBlur={saveRename}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") saveRename();
                if (e.key === "Escape") { setDraft(b.title); setRenaming(false); }
              }}
              className="h-7 text-xs"
              aria-label="Block title"
              placeholder="No heading"
            />
          ) : (
            <p
              className={cn("text-xs leading-snug line-clamp-2 break-words", selected ? "font-medium text-foreground" : "text-foreground/85", b.hidden && !b.placeholder && "line-through text-muted-foreground")}
              onDoubleClick={(e) => { if (!disabled) { e.stopPropagation(); setRenaming(true); } }}
              title={name}
            >
              {name}
            </p>
          )}
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] text-muted-foreground">
            {writing ? (
              <span className="inline-flex items-center gap-0.5 text-teal"><Loader2 className="h-2.5 w-2.5 animate-spin" /> Writing…</span>
            ) : (
              <>
                {held && (
                  <span className="inline-flex items-center gap-0.5 font-medium text-red-400" title={heldSentence(check) ?? undefined} data-testid={`chip-held-${b.id}`}>
                    <ShieldAlert className="h-2.5 w-2.5" /> {check?.held ? "Names the business" : "Held from buyers"}
                  </span>
                )}
                {!held && pinpoint && (
                  <span className="inline-flex items-center gap-0.5 text-amber-500" title={check!.pinpoint.join(" · ")} data-testid={`chip-pinpoint-${b.id}`}>
                    <AlertTriangle className="h-2.5 w-2.5" /> May be recognisable
                  </span>
                )}
                {b.placeholder && (
                  <span className="inline-flex items-center gap-0.5 text-amber-500" data-testid={`chip-write-${b.id}`}>
                    <PenLine className="h-2.5 w-2.5" /> Write this
                  </span>
                )}
                {b.hidden && !b.placeholder && <span className="inline-flex items-center gap-0.5"><EyeOff className="h-2.5 w-2.5" /> Hidden</span>}
                {sellerFlagged && <span className="inline-flex items-center gap-0.5 text-blue-400"><MessageSquareText className="h-2.5 w-2.5" /> Seller asked to change</span>}
              </>
            )}
          </div>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={disabled}
              className="shrink-0 rounded p-1 text-muted-foreground opacity-60 hover:bg-muted hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 disabled:opacity-30"
              aria-label={`Actions for ${name}`}
              onClick={(e) => e.stopPropagation()}
              data-testid={`teaser-row-menu-${b.id}`}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-52"
            onClick={(e) => e.stopPropagation()}
            onCloseAutoFocus={(e) => {
              if (!renameFromMenu.current) return;
              e.preventDefault();
              renameFromMenu.current = false;
              setRenaming(true);
            }}
          >
            <DropdownMenuItem onSelect={() => { renameFromMenu.current = true; }}>
              <Pencil className="mr-2 h-3.5 w-3.5" /> Rename
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onDuplicate(b.id)}>
              <Copy className="mr-2 h-3.5 w-3.5" /> Duplicate
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onToggleHidden(b)}>
              {b.hidden ? <Eye className="mr-2 h-3.5 w-3.5" /> : <EyeOff className="mr-2 h-3.5 w-3.5" />}
              {b.hidden ? "Show to buyers" : "Hide from buyers"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onMove(-1)} disabled={idx === 0}>
              <ArrowUp className="mr-2 h-3.5 w-3.5" /> Move up
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onMove(1)} disabled={idx === total - 1}>
              <ArrowDown className="mr-2 h-3.5 w-3.5" /> Move down
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onAddAfter(b.id)}>
              <Plus className="mr-2 h-3.5 w-3.5" /> Add a block below
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-red-500 focus:text-red-500" onSelect={() => onDelete(b)}>
              <Trash2 className="mr-2 h-3.5 w-3.5" /> Delete…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <InsertGap label={`Add a block after “${name}”`} onClick={() => onAddAfter(b.id)} disabled={disabled} />
    </Reorder.Item>
  );
}

function InsertGap({ onClick, label, disabled }: { onClick: () => void; label: string; disabled?: boolean }) {
  if (disabled) return <div className="h-2" />;
  return (
    <div className="group/gap relative flex h-2 items-center">
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onClick(); }}
        aria-label={label}
        title={label}
        className="absolute inset-x-3 flex items-center gap-1.5 opacity-0 transition-opacity focus:opacity-100 group-hover/gap:opacity-100"
      >
        <span className="h-px flex-1 bg-teal/50" />
        <span className="flex h-4 w-4 items-center justify-center rounded-full bg-teal text-teal-foreground">
          <Plus className="h-3 w-3" />
        </span>
        <span className="h-px flex-1 bg-teal/50" />
      </button>
    </div>
  );
}
