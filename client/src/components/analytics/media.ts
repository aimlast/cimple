/** Media-query hooks for the dashboards (false during server rendering), and keeping a selected row in view. */
import { useEffect, useState, type RefObject } from "react";

/** True when the viewport is at least `px` wide (lg = 1024, md = 768, sm = 640). */
export function useMinWidth(px: number): boolean {
  const [ok, setOk] = useState(() => typeof window !== "undefined" && !!window.matchMedia && window.matchMedia(`(min-width: ${px}px)`).matches);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(`(min-width: ${px}px)`);
    setOk(mq.matches);
    const on = (e: MediaQueryListEvent) => setOk(e.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, [px]);
  return ok;
}

/**
 * Scrolls the row for `accessId` (a `[data-access]` element inside `root`)
 * into view, only as far as needed (`block: "nearest"`: a row already on
 * screen doesn't move). Returns whether a row was found.
 */
export function scrollRowIntoView(root: ParentNode | null | undefined, accessId: string | null | undefined): boolean {
  if (!root || !accessId) return false;
  const value = accessId.replace(/["\\]/g, "\\$&");
  const el = root.querySelector<HTMLElement>(`[data-access="${value}"]`);
  if (!el || typeof el.scrollIntoView !== "function") return false;
  el.scrollIntoView({ block: "nearest" });
  return true;
}

/**
 * Keeps the selected row visible beside its card: once the list has
 * rendered, and whenever the selection changes. A `?buyer=` link to the
 * 12th buyer scrolls the list to that (highlighted) row instead of showing
 * a card that looks unconnected to the rows on screen.
 */
export function useScrollSelectedIntoView(ref: RefObject<HTMLElement | null>, accessId: string | null | undefined, ready: boolean): void {
  useEffect(() => {
    if (!ready || !accessId) return;
    scrollRowIntoView(ref.current, accessId);
  }, [ref, accessId, ready]);
}
