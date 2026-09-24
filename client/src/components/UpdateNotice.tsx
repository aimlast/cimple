/**
 * UpdateNotice — tells people when a newer version of Cimple is live.
 *
 * Cimple is a single-page app: a tab left open keeps running the code it
 * loaded, so after a deploy brokers kept seeing old screens until they
 * happened to reload (observed 2026-09-24). This checks the live index.html
 * on focus and every few minutes; if its main bundle differs from the one
 * this tab is running, it shows a small banner with a Reload button. It never
 * reloads on its own — that could cut off an interview or a call.
 */
import { useEffect, useState } from "react";
import { RefreshCw, X } from "lucide-react";

const CHECK_EVERY_MS = 5 * 60 * 1000;
const BUNDLE_RE = /\/assets\/index-[A-Za-z0-9_-]+\.js/;

function runningBundle(): string | null {
  const scripts = Array.from(document.querySelectorAll<HTMLScriptElement>("script[src]"));
  for (const s of scripts) {
    const m = s.src.match(BUNDLE_RE);
    if (m) return m[0];
  }
  return null;
}

export function UpdateNotice() {
  const [available, setAvailable] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const current = runningBundle();
    // Dev server (no hashed bundle) — nothing to compare.
    if (!current) return;
    let stopped = false;
    const check = async () => {
      if (stopped) return;
      try {
        const res = await fetch("/", { cache: "no-store", credentials: "same-origin" });
        if (!res.ok) return;
        const live = (await res.text()).match(BUNDLE_RE)?.[0];
        if (live && live !== current) setAvailable(true);
      } catch {
        /* offline or mid-deploy — try again later */
      }
    };
    const id = setInterval(check, CHECK_EVERY_MS);
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    void check();
    return () => {
      stopped = true;
      clearInterval(id);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, []);

  if (!available || dismissed) return null;
  return (
    <div
      role="status"
      className="fixed bottom-4 left-1/2 z-[100] -translate-x-1/2 flex items-center gap-3 rounded-full border border-teal/40 bg-card px-4 py-2 text-sm shadow-lg"
      data-testid="update-notice"
    >
      <span>Cimple has been updated.</span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="inline-flex items-center gap-1.5 rounded-full bg-teal px-3 py-1 text-xs font-medium text-teal-foreground hover:bg-teal/90"
        data-testid="button-update-reload"
      >
        <RefreshCw className="h-3 w-3" /> Reload
      </button>
      <button type="button" onClick={() => setDismissed(true)} className="text-muted-foreground hover:text-foreground" aria-label="Later">
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
