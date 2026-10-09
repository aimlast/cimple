/**
 * The order the broker sees stays put (specs/together.md D14): while the view,
 * filter and search are unchanged, a status change never moves or removes a
 * row — a confirmed or filed item stays where it is, shown as on file. Items
 * that newly match are appended at the end of their section group. While the
 * pointer is over the list, or a row's menu, editor or sheet is open, the
 * list is frozen. (shared/coverage-board.ts stableOrder is the rule.)
 */
import { useMemo, useRef, useState } from "react";
import { stableOrder, type CoverageBoard, type CoverageItem, type OrderSnapshot, type ViewGroup } from "@shared/coverage-board";

export function useStableOrder(board: CoverageBoard | undefined, groups: ViewGroup[], key: string) {
  const snapshot = useRef<OrderSnapshot | null>(null);
  const [openThings, setOpenThings] = useState<ReadonlySet<string>>(() => new Set());
  const [pointerInside, setPointerInside] = useState(false);
  const [tidyNonce, setTidyNonce] = useState(0);
  const frozen = openThings.size > 0 || pointerInside;

  const result = useMemo(() => {
    if (!board) return { groups: [] as ViewGroup[], parked: 0 };
    const all = new Map<string, CoverageItem>();
    const sectionOf: Record<string, string> = {};
    for (const s of board.sections) for (const i of s.items) { all.set(i.id, i); sectionOf[i.id] = s.key; }
    const currentIds = groups.flatMap((g) => g.items.map((i) => i.id));
    const fullKey = `${key}#${tidyNonce}`;
    // Frozen: keep the previous order exactly (new rows wait until unfrozen).
    if (!(frozen && snapshot.current && snapshot.current.key === fullKey)) {
      snapshot.current = stableOrder(snapshot.current, { key: fullKey, ids: currentIds }, sectionOf, new Set(all.keys()), Date.now());
    }
    const ids = snapshot.current.ids.filter((id) => all.has(id));
    const currentSet = new Set(currentIds);
    const parked = ids.filter((id) => !currentSet.has(id)).length;
    // Regroup by section in first-appearance order.
    const out: ViewGroup[] = [];
    const bySection = new Map<string, ViewGroup>();
    const sectionByKey = new Map(board.sections.map((s) => [s.key, s]));
    for (const id of ids) {
      const item = all.get(id)!;
      let g = bySection.get(item.sectionKey);
      if (!g) {
        g = { section: sectionByKey.get(item.sectionKey)!, items: [] };
        bySection.set(item.sectionKey, g);
        out.push(g);
      }
      g.items.push(item);
    }
    return { groups: out, parked };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board, groups, key, frozen, tidyNonce]);

  return {
    groups: result.groups,
    /** Rows that no longer match the view but stay put ("Tidy the list (n)" from 3). */
    parked: result.parked,
    tidy: () => setTidyNonce((n) => n + 1),
    /** Spread on the list container. */
    listProps: {
      onPointerEnter: () => setPointerInside(true),
      onPointerLeave: () => setPointerInside(false),
    },
    /** Rows call this when a menu, editor, popover or sheet opens/closes (key = "<itemId>:<what>"). */
    onMenuOpenChange: (key: string, open: boolean) =>
      setOpenThings((prev) => {
        if (open === prev.has(key)) return prev;
        const next = new Set(prev);
        if (open) next.add(key); else next.delete(key);
        return next;
      }),
    frozen,
  };
}
