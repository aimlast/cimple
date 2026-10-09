/** Media-query hooks for the dashboards (false during server rendering). */
import { useEffect, useState } from "react";

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
