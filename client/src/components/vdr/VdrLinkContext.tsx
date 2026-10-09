/**
 * VdrLinkProvider — the citation contract's client side (vdr spec §6.6,
 * §11.1.2–3, §11.2.7; INTEGRATION §2.4, §2.6).
 *
 * Mounted by the buyer view room around the CIM (`{ kind: "buyer", token }`)
 * and, by the integrator, around the broker's CIM preview
 * (`{ kind: "broker", dealId }`). It:
 *  - batches every `VdrCitationChip` on the page into ONE lookup call
 *    (≤ 50 ids per call) and keeps the answers — a chip never carries a
 *    document title; the room's title comes from here;
 *  - hosts the `VdrViewerDrawer` (buyer): a chip, or any link to this link's
 *    `/view/<token>/data-room?…` inside the CIM (gl's "Open the general ledger
 *    in the data room →"), opens the document beside the CIM instead of
 *    leaving it. The URL gains `?doc=&page=` so Back closes it, and a link
 *    with `?doc=` opens it on load;
 *  - tells the host when the drawer opens or closes (`onDrawerChange`) so
 *    the CIM reading tracker can pause (analytics' `paused`) and record
 *    `vdr_open`.
 * Broker: chips show the document's own name and link into the Data room tab.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { BrokerResolvedDocument, ResolvedDocument } from "@shared/vdr-api";
import { vdrFetch } from "@/hooks/useDataRoom";
import { parseRoomLink } from "./links";
import { VdrViewerDrawer, type DrawerTarget } from "./VdrViewerDrawer";

export type VdrLinkSource = { kind: "buyer"; token: string } | { kind: "broker"; dealId: string };

type Resolved = ResolvedDocument | BrokerResolvedDocument;

export type VdrLinkApi = {
  source: VdrLinkSource;
  /** The answer for a document id: undefined while loading. */
  resolved: (documentId: string) => Resolved | undefined;
  /** Asks for an id (batched with every other chip on the page). */
  request: (documentId: string) => void;
  /** Opens a document beside the CIM (buyer), or in the Data room tab (broker). */
  open: (t: DrawerTarget) => void;
  /** A buyer asks the broker for a document they can't open (`kind: "document"` with its id). */
  askFor: (documentId: string, label: string) => Promise<"asked" | "asked_room" | "failed">;
};

const Ctx = createContext<VdrLinkApi | null>(null);
/** The raw context (tests render a chip against fixed answers with it). */
export const VdrLinkContext = Ctx;

export function useVdrLinks(): VdrLinkApi | null {
  return useContext(Ctx);
}

const BATCH_MS = 40;
const MAX_PER_CALL = 50;

function resolveUrl(source: VdrLinkSource, ids: string[]): string {
  const q = `documentIds=${ids.map(encodeURIComponent).join(",")}`;
  return source.kind === "buyer"
    ? `/api/view/${encodeURIComponent(source.token)}/data-room/resolve?${q}`
    : `/api/deals/${encodeURIComponent(source.dealId)}/data-room/resolve?${q}`;
}

export function VdrLinkProvider({ source, children, onDrawerChange }: { source: VdrLinkSource; children: ReactNode; onDrawerChange?: (open: boolean, itemId: string | null) => void }) {
  const [results, setResults] = useState<Record<string, Resolved>>({});
  const asked = useRef(new Set<string>());
  const pending = useRef(new Set<string>());
  const timer = useRef<number | null>(null);
  const [target, setTarget] = useState<DrawerTarget | null>(null);
  const pushed = useRef(false);
  const sourceKey = source.kind === "buyer" ? `b:${source.token}` : `d:${source.dealId}`;

  const flush = useCallback(() => {
    timer.current = null;
    const ids = Array.from(pending.current);
    pending.current.clear();
    for (let i = 0; i < ids.length; i += MAX_PER_CALL) {
      const chunk = ids.slice(i, i + MAX_PER_CALL);
      vdrFetch<{ documents: Record<string, Resolved> }>("GET", resolveUrl(source, chunk))
        .then((r) => setResults((prev) => ({ ...prev, ...r.documents })))
        // A failed lookup reads as "not available" (the neutral label) — never a name.
        .catch(() => setResults((prev) => ({ ...prev, ...Object.fromEntries(chunk.map((id) => [id, { available: false } as Resolved])) })));
    }
  }, [sourceKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const request = useCallback((documentId: string) => {
    if (!documentId || asked.current.has(documentId)) return;
    asked.current.add(documentId);
    pending.current.add(documentId);
    if (timer.current == null) timer.current = window.setTimeout(flush, BATCH_MS);
  }, [flush]);

  useEffect(() => () => { if (timer.current != null) window.clearTimeout(timer.current); }, []);

  // ── The drawer (buyer): open/close with the URL so Back closes it ──
  const setUrl = useCallback((t: DrawerTarget | null, mode: "push" | "replace") => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.delete("doc");
    url.searchParams.delete("page");
    if (t) {
      url.searchParams.set("doc", t.itemId);
      if (t.page) url.searchParams.set("page", String(t.page));
    }
    const next = `${url.pathname}${url.search}${url.hash}`;
    if (mode === "push") window.history.pushState({ vdrDrawer: !!t }, "", next);
    else window.history.replaceState(window.history.state, "", next);
  }, []);

  const open = useCallback((t: DrawerTarget) => {
    if (source.kind === "broker") {
      window.location.assign(`/deal/${encodeURIComponent(source.dealId)}/data-room?open=${encodeURIComponent(t.itemId)}`);
      return;
    }
    setTarget(t);
    setUrl(t, pushed.current ? "replace" : "push");
    pushed.current = true;
  }, [sourceKey, setUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  const close = useCallback(() => {
    setTarget(null);
    if (pushed.current) {
      pushed.current = false;
      window.history.back();
    } else {
      setUrl(null, "replace");
    }
  }, [setUrl]);

  // Back (or Forward) moves the drawer with the URL.
  useEffect(() => {
    if (source.kind !== "buyer") return;
    const onPop = () => {
      const link = parseRoomLink(window.location.search);
      if (link.itemId) {
        setTarget((cur) => (cur && cur.itemId === link.itemId ? cur : { itemId: link.itemId!, title: null, number: null, page: link.page, needle: null, sheet: null, rows: null, replaced: false }));
        pushed.current = true;
      } else {
        pushed.current = false;
        setTarget(null);
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [sourceKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // A link with ?doc= opens the drawer on load.
  useEffect(() => {
    if (source.kind !== "buyer") return;
    const link = parseRoomLink(window.location.search);
    if (link.itemId) setTarget({ itemId: link.itemId, title: null, number: null, page: link.page, needle: null, sheet: null, rows: null, replaced: false });
  }, [sourceKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { onDrawerChange?.(!!target, target?.itemId ?? null); }, [target?.itemId]); // eslint-disable-line react-hooks/exhaustive-deps

  const askFor = useCallback(async (documentId: string, label: string): Promise<"asked" | "asked_room" | "failed"> => {
    if (source.kind !== "buyer") return "failed";
    const base = `/api/view/${encodeURIComponent(source.token)}/data-room/requests`;
    try {
      await vdrFetch("POST", base, { kind: "document", documentId, text: `${label} (from the CIM)` });
      return "asked";
    } catch (e: any) {
      // No data room for this link yet: ask for the room instead (the broker decides).
      const code = e?.body?.code;
      if (code === "no_room_access" || code === "room_none") {
        try { await vdrFetch("POST", base, { kind: "room_access" }); return "asked_room"; } catch { return "failed"; }
      }
      return "failed";
    }
  }, [sourceKey]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Clicks on this link's data-room URLs inside the CIM open the drawer (§11.2.7). */
  const onClickCapture = useCallback((e: React.MouseEvent) => {
    if (source.kind !== "buyer" || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = (e.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!a || a.target === "_blank") return;
    let url: URL;
    try { url = new URL(a.href, window.location.href); } catch { return; }
    if (url.origin !== window.location.origin || decodeURIComponent(url.pathname) !== `/view/${source.token}/data-room`) return;
    const link = parseRoomLink(url.search);
    if (link.itemId) {
      e.preventDefault();
      open({ itemId: link.itemId, title: null, number: null, page: link.page, needle: link.needle, sheet: link.sheet, rows: link.rows, replaced: false });
      return;
    }
    if (link.documentId) {
      e.preventDefault();
      const id = link.documentId;
      vdrFetch<{ documents: Record<string, ResolvedDocument> }>("GET", resolveUrl(source, [id]))
        .then((r) => {
          const hit = r.documents[id];
          if (hit && hit.available) open({ itemId: hit.itemId, title: hit.title, number: hit.number, page: hit.replaced ? null : link.page, needle: link.needle, sheet: link.sheet, rows: link.rows, replaced: !!hit.replaced });
          else window.location.assign(url.pathname + url.search);
        })
        .catch(() => window.location.assign(url.pathname + url.search));
    }
  }, [sourceKey, open]); // eslint-disable-line react-hooks/exhaustive-deps

  const api = useMemo<VdrLinkApi>(() => ({ source, resolved: (id) => results[id], request, open, askFor }), [sourceKey, results, request, open, askFor]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Ctx.Provider value={api}>
      <div onClickCapture={onClickCapture} style={{ display: "contents" }}>{children}</div>
      {source.kind === "buyer" && <VdrViewerDrawer token={source.token} target={target} onClose={close} />}
    </Ctx.Provider>
  );
}
