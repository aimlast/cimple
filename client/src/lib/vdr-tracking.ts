/**
 * Data-room reading time (vdr spec §10, §9.3): per opened document (a
 * server-issued view), the active time and the time on each page.
 *
 *  - A 1-second tick; a second counts when the tab is visible and the reader
 *    did something (scroll, key, pointer, touch) in the last 60 seconds.
 *  - The second goes to the page in view ("3"; a sheet is "s:<index>").
 *  - Sent every 15 s when something changed, and by navigator.sendBeacon
 *    (text/plain) when the page hides or closes. The server clamps and merges
 *    with GREATEST, so a repeat send never double-counts.
 */
import { useEffect, useRef } from "react";

const TICK_MS = 1000;
const IDLE_MS = 60_000;
const FLUSH_MS = 15_000;

export type VdrTrackingOptions = {
  enabled: boolean;
  beatUrl: string;
  viewId: string | null;
  /** The page in view right now ("3", "s:0"), or null. */
  currentPage: () => string | null;
};

export function useVdrTracking(opts: VdrTrackingOptions): void {
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    if (!opts.enabled || !opts.viewId || !opts.beatUrl) return;
    const viewId = opts.viewId;
    const beatUrl = opts.beatUrl;
    let activeMs = 0;
    const pageMs: Record<string, number> = {};
    let maxPage: number | null = null;
    let lastInput = Date.now();
    let dirty = false;

    const onInput = () => { lastInput = Date.now(); };
    const events: Array<keyof WindowEventMap> = ["scroll", "keydown", "pointerdown", "pointermove", "touchstart", "wheel"];
    for (const e of events) window.addEventListener(e, onInput, { passive: true, capture: true });

    const body = () => JSON.stringify({ viewId, activeMs, pageMs, maxPage });
    const flush = (beacon = false) => {
      if (!dirty) return;
      dirty = false;
      const payload = body();
      if (beacon && typeof navigator.sendBeacon === "function") {
        navigator.sendBeacon(beatUrl, new Blob([payload], { type: "text/plain" }));
        return;
      }
      fetch(beatUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: payload, keepalive: true, credentials: "include" }).catch(() => { dirty = true; });
    };

    const tick = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastInput > IDLE_MS) return;
      activeMs += TICK_MS;
      const page = optsRef.current.currentPage();
      if (page) {
        pageMs[page] = (pageMs[page] ?? 0) + TICK_MS;
        const n = Number(page);
        if (Number.isInteger(n) && n > 0) maxPage = Math.max(maxPage ?? 0, n);
      }
      dirty = true;
    }, TICK_MS);
    const flusher = setInterval(() => flush(false), FLUSH_MS);
    const onHide = () => { if (document.visibilityState === "hidden") flush(true); };
    const onPageHide = () => flush(true);
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onPageHide);

    return () => {
      clearInterval(tick);
      clearInterval(flusher);
      for (const e of events) window.removeEventListener(e, onInput, { capture: true } as EventListenerOptions);
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onPageHide);
      flush(true);
    };
  }, [opts.enabled, opts.viewId, opts.beatUrl]);
}
