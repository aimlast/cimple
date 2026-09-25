/**
 * SectionList — the builder's outline: drag to reorder (by the handle, or
 * Alt+↑/↓ on a focused row), "+" between any two sections, and a menu per
 * section (rename, duplicate, move, hide, access tier, redo its blind
 * version, delete).
 */
import { useEffect, useRef, useState } from "react";
import { Reorder, useDragControls } from "framer-motion";
import {
  AlertTriangle, ArrowDown, ArrowUp, CheckCircle2, Copy, Eye, EyeOff, GripVertical, Loader2, Lock,
  MoreHorizontal, Pencil, Plus, RefreshCw, Sparkles, Trash2, Users,
} from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup,
  DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { layoutLabel } from "@shared/cim-layouts";
import { cn } from "@/lib/utils";
import { LayoutIcon } from "./LayoutGallery";
import { TASK_LABEL, taskRunning, type BuilderSection } from "./api";

export interface SectionListActions {
  onSelect: (id: string) => void;
  onReorder: (ids: string[]) => void;
  onAddAfter: (afterId: string | null | undefined) => void;
  onRename: (id: string, title: string) => void;
  onDuplicate: (id: string) => void;
  onToggleVisible: (s: BuilderSection) => void;
  onSetTier: (id: string, tier: "teaser" | "full") => void;
  onDelete: (s: BuilderSection) => void;
  /** Redo this section's blind version (shown once the deal has a Blind CIM). */
  onRedoBlind?: (id: string) => void;
}

interface Props extends SectionListActions {
  sections: BuilderSection[];
  selectedId: string | null;
  showBlindStatus: boolean;
  readOnly: boolean;
}

export function SectionList({ sections, selectedId, showBlindStatus, readOnly, ...actions }: Props) {
  // Local order while dragging; follows the server otherwise.
  const [items, setItems] = useState(sections);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const dragging = useRef(false);
  useEffect(() => {
    if (!dragging.current) setItems(sections);
  }, [sections]);

  const commit = (next: BuilderSection[]) => {
    const ids = next.map((s) => s.id);
    if (ids.join() !== sections.map((s) => s.id).join()) actions.onReorder(ids);
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
    <div className="py-2">
      {!readOnly && <InsertGap label="Add a section at the start" onClick={() => actions.onAddAfter(null)} always={items.length === 0} />}
      <Reorder.Group axis="y" values={items} onReorder={setItems} className="space-y-0.5 px-2" as="div">
        {items.map((s, idx) => (
          <Row
            key={s.id}
            section={s}
            idx={idx}
            total={items.length}
            selected={s.id === selectedId}
            showBlindStatus={showBlindStatus}
            readOnly={readOnly}
            onDragStart={() => { dragging.current = true; }}
            onDragEnd={() => { dragging.current = false; commit(itemsRef.current); }}
            onMove={(dir) => move(idx, dir)}
            {...actions}
          />
        ))}
      </Reorder.Group>
    </div>
  );
}

interface RowProps extends SectionListActions {
  section: BuilderSection;
  idx: number;
  total: number;
  selected: boolean;
  showBlindStatus: boolean;
  readOnly: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onMove: (dir: -1 | 1) => void;
}

function Row({
  section: s, idx, total, selected, showBlindStatus, readOnly, onDragStart, onDragEnd, onMove,
  onSelect, onAddAfter, onRename, onDuplicate, onToggleVisible, onSetTier, onDelete, onRedoBlind,
}: RowProps) {
  const controls = useDragControls();
  const [renaming, setRenaming] = useState(false);
  // "Rename" from the menu: stop the menu handing focus back to its trigger,
  // which would blur (and close) the title field the moment it opens.
  const renameFromMenu = useRef(false);
  const [draft, setDraft] = useState(s.sectionTitle);
  useEffect(() => { if (!renaming) setDraft(s.sectionTitle); }, [s.sectionTitle, renaming]);

  const hidden = s.isVisible === false;
  const running = taskRunning(s);
  const ready = s.aiTask?.status === "ready";
  const failed = s.aiTask?.status === "failed";

  const saveRename = () => {
    const t = draft.replace(/\s+/g, " ").trim();
    setRenaming(false);
    if (t && t !== s.sectionTitle) onRename(s.id, t);
  };

  return (
    <Reorder.Item
      value={s}
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
        onClick={() => !renaming && onSelect(s.id)}
        onKeyDown={(e) => {
          if (renaming) return;
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(s.id); }
          if (!readOnly && e.altKey && e.key === "ArrowUp") { e.preventDefault(); onMove(-1); }
          if (!readOnly && e.altKey && e.key === "ArrowDown") { e.preventDefault(); onMove(1); }
        }}
        className={cn(
          "group flex items-center gap-1.5 rounded-md pl-1 pr-1.5 py-1.5 cursor-pointer select-none outline-none transition-colors bg-card",
          "focus-visible:ring-2 focus-visible:ring-teal/60",
          selected ? "bg-teal/10 ring-1 ring-teal/40" : "hover:bg-muted/60",
        )}
        data-testid={`section-row-${s.id}`}
      >
        {!readOnly ? (
          <span
            className="touch-none shrink-0 cursor-grab active:cursor-grabbing p-1 text-muted-foreground/50 hover:text-foreground"
            onPointerDown={(e) => { e.preventDefault(); controls.start(e); }}
            aria-label="Drag to reorder"
            title="Drag to reorder (or Alt + ↑/↓)"
          >
            <GripVertical className="h-3.5 w-3.5" />
          </span>
        ) : (
          <span className="w-2 shrink-0" />
        )}
        <span className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded border", selected ? "border-teal/40 text-teal" : "border-border text-muted-foreground")}>
          <LayoutIcon layoutType={s.layoutType} className="h-3.5 w-3.5" />
        </span>
        <div className="flex-1 min-w-0">
          {renaming ? (
            <Input
              autoFocus
              value={draft}
              maxLength={200}
              onChange={(e) => setDraft(e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
              onClick={(e) => e.stopPropagation()}
              onBlur={saveRename}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") saveRename();
                if (e.key === "Escape") { setDraft(s.sectionTitle); setRenaming(false); }
              }}
              className="h-7 text-xs"
              aria-label="Section title"
            />
          ) : (
            <p
              className={cn("text-xs leading-snug line-clamp-2 break-words", selected ? "font-medium text-foreground" : "text-foreground/85", hidden && "line-through text-muted-foreground")}
              onDoubleClick={(e) => { if (!readOnly) { e.stopPropagation(); setRenaming(true); } }}
              title={s.sectionTitle}
            >
              {s.sectionTitle}
            </p>
          )}
          <div className="flex items-center gap-1.5 mt-0.5 min-w-0 text-[10px] text-muted-foreground">
            <span className="truncate">{layoutLabel(s.layoutType)}</span>
            {s.accessTier === "full" && (
              <span className="inline-flex items-center gap-0.5 text-teal shrink-0" title="Full access only — locked for teaser buyers">
                <Lock className="h-2.5 w-2.5" /> Full
              </span>
            )}
            {hidden && <span className="inline-flex items-center gap-0.5 shrink-0"><EyeOff className="h-2.5 w-2.5" /> Hidden</span>}
            {running && (
              <span className="inline-flex items-center gap-0.5 text-teal shrink-0">
                <Loader2 className="h-2.5 w-2.5 animate-spin" /> {TASK_LABEL[s.aiTask!.kind]}…
              </span>
            )}
            {ready && <span className="inline-flex items-center gap-0.5 text-teal shrink-0"><Sparkles className="h-2.5 w-2.5" /> Rewrite ready</span>}
            {failed && <span className="inline-flex items-center gap-0.5 text-red-400 shrink-0"><AlertTriangle className="h-2.5 w-2.5" /> Needs attention</span>}
            {showBlindStatus && s.blindStatus === "updating" && !running && (
              <span className="inline-flex items-center gap-0.5 text-amber-500 shrink-0" title="The blind version is being redacted — blind buyers don't see this section until it's ready">
                <Loader2 className="h-2.5 w-2.5 animate-spin" /> Blind
              </span>
            )}
            {showBlindStatus && s.blindStatus === "held" && !running && (
              <span
                className="inline-flex items-center gap-0.5 text-red-400 shrink-0"
                title={`Blind buyers don't see this section: ${s.blindError || "its blind version couldn't be made"}. Edit the section or use "Redo blind version" in its menu.`}
              >
                <AlertTriangle className="h-2.5 w-2.5" /> Blind held back
              </span>
            )}
          </div>
        </div>
        {s.brokerApproved && <CheckCircle2 className="h-3 w-3 text-teal shrink-0" aria-label="Approved" />}
        {!readOnly && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="shrink-0 rounded p-1 text-muted-foreground opacity-60 hover:opacity-100 hover:bg-muted focus-visible:opacity-100 data-[state=open]:opacity-100"
                aria-label={`Actions for ${s.sectionTitle}`}
                onClick={(e) => e.stopPropagation()}
                data-testid={`section-menu-${s.id}`}
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
                <Pencil className="h-3.5 w-3.5 mr-2" /> Rename
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onDuplicate(s.id)} disabled={running}>
                <Copy className="h-3.5 w-3.5 mr-2" /> Duplicate
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onAddAfter(s.id)}>
                <Plus className="h-3.5 w-3.5 mr-2" /> Add a section below
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => onMove(-1)} disabled={idx === 0}>
                <ArrowUp className="h-3.5 w-3.5 mr-2" /> Move up
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onMove(1)} disabled={idx === total - 1}>
                <ArrowDown className="h-3.5 w-3.5 mr-2" /> Move down
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onToggleVisible(s)}>
                {hidden ? <Eye className="h-3.5 w-3.5 mr-2" /> : <EyeOff className="h-3.5 w-3.5 mr-2" />}
                {hidden ? "Show to buyers" : "Hide from buyers"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-[11px] font-medium text-muted-foreground">Who can see it</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={s.accessTier} onValueChange={(v) => onSetTier(s.id, v as "teaser" | "full")}>
                <DropdownMenuRadioItem value="teaser">
                  <Users className="h-3.5 w-3.5 mr-2" /> Every buyer (teaser)
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="full">
                  <Lock className="h-3.5 w-3.5 mr-2" /> Full access only
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
              {showBlindStatus && onRedoBlind && s.blindStatus !== "excluded" && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => onRedoBlind(s.id)} disabled={running} data-testid={`section-redo-blind-${s.id}`}>
                    <RefreshCw className="h-3.5 w-3.5 mr-2" /> Redo blind version
                  </DropdownMenuItem>
                </>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-red-500 focus:text-red-500" onSelect={() => onDelete(s)} disabled={running}>
                <Trash2 className="h-3.5 w-3.5 mr-2" /> Delete…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {!readOnly && <InsertGap label={`Add a section after “${s.sectionTitle}”`} onClick={() => onAddAfter(s.id)} />}
    </Reorder.Item>
  );
}

/** Thin hover strip with a "+" that inserts a section at that point. */
function InsertGap({ onClick, label, always = false }: { onClick: () => void; label: string; always?: boolean }) {
  return (
    <div className={cn("group/gap relative h-2 flex items-center", always && "h-8 px-2")}>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onClick(); }}
        aria-label={label}
        title={label}
        className={cn(
          "absolute inset-x-3 flex items-center gap-1.5 transition-opacity focus:opacity-100",
          always ? "static opacity-100 w-full justify-center rounded-md border border-dashed border-border py-1.5 text-xs text-muted-foreground hover:text-foreground" : "opacity-0 group-hover/gap:opacity-100",
        )}
      >
        {always ? (
          <><Plus className="h-3.5 w-3.5" /> Add your first section</>
        ) : (
          <>
            <span className="h-px flex-1 bg-teal/50" />
            <span className="flex h-4 w-4 items-center justify-center rounded-full bg-teal text-teal-foreground">
              <Plus className="h-3 w-3" />
            </span>
            <span className="h-px flex-1 bg-teal/50" />
          </>
        )}
      </button>
    </div>
  );
}
