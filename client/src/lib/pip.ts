/**
 * Document Picture-in-Picture helper — a small always-on-top browser window
 * we can render React into (via a portal). Used by the broker-led interview
 * so the question panel floats over Zoom / Meet / Teams instead of living in
 * a tab the broker has to keep switching to.
 *
 * Supported in Chrome and Edge (116+). Elsewhere `isPipSupported()` is false
 * and the UI explains instead of failing silently.
 */
import { useCallback, useEffect, useState } from "react";

interface DocumentPictureInPicture {
  requestWindow(options?: { width?: number; height?: number; disallowReturnToOpener?: boolean }): Promise<Window>;
  window: Window | null;
}

function api(): DocumentPictureInPicture | null {
  return (window as unknown as { documentPictureInPicture?: DocumentPictureInPicture }).documentPictureInPicture ?? null;
}

export function isPipSupported(): boolean {
  return !!api();
}

/** Copy the opener's stylesheets + theme so Tailwind classes render identically. */
function adoptStyles(pip: Window) {
  const doc = pip.document;
  for (const node of Array.from(document.querySelectorAll('style, link[rel="stylesheet"]'))) {
    doc.head.appendChild(node.cloneNode(true));
  }
  doc.documentElement.className = document.documentElement.className;
  const theme = document.documentElement.getAttribute("data-theme");
  if (theme) doc.documentElement.setAttribute("data-theme", theme);
  doc.body.className = "bg-background text-foreground antialiased";
  doc.title = "Cimple — interview";
}

/**
 * Manages one floating window. `container` is a mounted element inside the
 * PiP document to portal into; null when closed.
 */
export function usePictureInPicture(size: { width: number; height: number } = { width: 440, height: 560 }) {
  const [pipWindow, setPipWindow] = useState<Window | null>(null);
  const [container, setContainer] = useState<HTMLElement | null>(null);

  const open = useCallback(async () => {
    const dpip = api();
    if (!dpip) return false;
    if (dpip.window) {
      dpip.window.close();
    }
    const win = await dpip.requestWindow({ width: size.width, height: size.height });
    adoptStyles(win);
    const root = win.document.createElement("div");
    root.className = "min-h-screen";
    win.document.body.appendChild(root);
    win.addEventListener("pagehide", () => {
      setPipWindow(null);
      setContainer(null);
    });
    setPipWindow(win);
    setContainer(root);
    return true;
  }, [size.width, size.height]);

  const close = useCallback(() => {
    pipWindow?.close();
    setPipWindow(null);
    setContainer(null);
  }, [pipWindow]);

  // Closing the main page closes the floating window too.
  useEffect(() => () => { pipWindow?.close(); }, [pipWindow]);

  return { isOpen: !!pipWindow, container, open, close, supported: isPipSupported() };
}
