/**
 * VdrViewer — the secure in-browser viewer (vdr spec §6.3). One component for
 * the buyer's room, a team member, the broker's own view and "View as a
 * buyer".
 *
 *  - PDF / photo: page IMAGES rendered on the server with the reader's
 *    watermark burned in (never the file itself). Lazy-loaded, placeholders
 *    sized from the manifest, Fit width / 100% / 150%, no right-click or drag,
 *    printing turned off.
 *  - Spreadsheet: sheet tabs and a table with Excel's own row numbers and
 *    column letters, 200 rows at a time; personal numbers arrive covered.
 *  - Word: sanitised HTML in a sandboxed iframe (sandbox="", srcdoc).
 *  - PowerPoint / text: plain text.
 *  - Sheets, Word and text carry an on-screen watermark overlay.
 *
 * Buyers: opening a document asks the server for a view (its id is what the
 * watermark's trace comes from); reading time per page is sent by
 * useVdrTracking. The broker's own view records nothing.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Download, FileWarning, Loader2, Lock, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { VdrManifest, VdrSheetRows, ViewStart } from "@shared/vdr-api";
import { sourceKey, vdrFetch, vdrUrls, type VdrSource } from "@/hooks/useDataRoom";
import { useVdrTracking } from "@/lib/vdr-tracking";

const COLS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
/** Excel's column letters for an absolute 0-based column (A = 0). */
export function columnLetters(c: number): string {
  let n = c + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = COLS[r] + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

type Zoom = "fit" | "100" | "150";

export type VdrViewerProps = {
  source: VdrSource;
  itemId: string;
  manifest: VdrManifest | null;
  loading?: boolean;
  /** Who reads (the overlay watermark on sheets, Word and text). */
  reader?: { name: string | null; email: string } | null;
  /** Where the buyer opened it from (stored with the view). */
  openedFrom?: "room" | "search" | "new" | "cim" | "question";
  initialPage?: number | null;
  /** Broker only: try preparing again. */
  onRetry?: () => void;
  className?: string;
  /** The page in view changed (1-based; sheets report 1). */
  onPageChange?: (page: number) => void;
  /** A buyer's view started (its id goes on the download link, so the copy carries the same trace). */
  onView?: (viewId: string) => void;
};

function Overlay({ reader }: { reader: { name: string | null; email: string } | null | undefined }) {
  if (!reader) return null;
  const text = `${reader.name || reader.email} · ${reader.email} · ${new Date().toISOString().slice(0, 10)}`;
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden select-none" data-vdr-overlay>
      <div className="absolute -inset-1/2 flex flex-wrap content-start gap-x-24 gap-y-20 -rotate-[30deg] opacity-[0.08]">
        {Array.from({ length: 60 }).map((_, i) => (
          <span key={i} className="whitespace-nowrap text-sm font-medium" style={{ color: "#46423B" }}>{text}</span>
        ))}
      </div>
    </div>
  );
}

export function VdrViewer(props: VdrViewerProps) {
  const { source, itemId, manifest } = props;
  const urls = useMemo(() => vdrUrls(source), [source]);
  const buyer = source.kind === "buyer";
  const [viewId, setViewId] = useState<string | null>(null);
  const [viewFailed, setViewFailed] = useState(false);
  const currentPage = useRef<string | null>(null);

  // A buyer's view starts once the document is ready (the server issues its id and trace).
  useEffect(() => {
    setViewId(null);
    setViewFailed(false);
    if (!buyer || manifest?.status !== "ready") return;
    let alive = true;
    vdrFetch<ViewStart>("POST", urls.viewStart, { itemId, source: props.openedFrom ?? "room", width: window.innerWidth })
      .then((r) => { if (alive) { setViewId(r.viewId); props.onView?.(r.viewId); } })
      .catch(() => { if (alive) setViewFailed(true); });
    return () => { alive = false; };
  }, [buyer, itemId, manifest?.status, urls.viewStart, props.openedFrom]);

  useVdrTracking({ enabled: buyer && !!viewId, beatUrl: urls.beat, viewId, currentPage: () => currentPage.current });

  if (props.loading || !manifest) {
    return <ViewerFrame className={props.className}><Centered><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></Centered></ViewerFrame>;
  }
  if (manifest.status === "pending") {
    return (
      <ViewerFrame className={props.className}>
        <Centered>
          <Loader2 className="h-5 w-5 animate-spin text-teal" />
          <p className="mt-3 text-sm font-medium text-foreground">Getting this document ready…</p>
          <p className="mt-1 text-xs text-muted-foreground">Usually a few seconds.</p>
        </Centered>
      </ViewerFrame>
    );
  }
  if (manifest.status === "failed") {
    return (
      <ViewerFrame className={props.className}>
        <Centered>
          <FileWarning className="h-6 w-6 text-amber-500/80" />
          <p className="mt-3 max-w-sm text-sm text-foreground">{manifest.error || "We couldn't show this document here. Ask your broker for a copy."}</p>
          {props.onRetry && (
            <Button variant="outline" size="sm" className="mt-3" onClick={props.onRetry}>
              <RotateCw className="mr-1.5 h-3.5 w-3.5" /> Try again
            </Button>
          )}
        </Centered>
      </ViewerFrame>
    );
  }
  if (buyer && viewFailed) {
    return <ViewerFrame className={props.className}><Centered><p className="text-sm text-muted-foreground">We couldn't open this document. Reload the page to try again.</p></Centered></ViewerFrame>;
  }
  if (buyer && !viewId) {
    return <ViewerFrame className={props.className}><Centered><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></Centered></ViewerFrame>;
  }

  switch (manifest.kind) {
    case "pdf":
    case "image":
      return (
        <PagesView
          urls={urls}
          itemId={itemId}
          pages={manifest.pages}
          viewId={viewId}
          initialPage={props.initialPage ?? null}
          className={props.className}
          onPage={(n) => { currentPage.current = String(n); props.onPageChange?.(n); }}
        />
      );
    case "sheet":
      return <SheetView source={source} urls={urls} itemId={itemId} sheets={manifest.sheets} reader={props.reader} className={props.className} onSheet={(i) => { currentPage.current = `s:${i}`; props.onPageChange?.(1); }} />;
    case "html":
      return <HtmlView source={source} urls={urls} itemId={itemId} reader={props.reader} className={props.className} onReady={() => { currentPage.current = "1"; }} />;
    case "text":
      return <TextView source={source} urls={urls} itemId={itemId} reader={props.reader} className={props.className} onReady={() => { currentPage.current = "1"; }} />;
    case "ledger":
    case "ledger_pending":
      return (
        <ViewerFrame className={props.className}>
          <Centered>
            <p className="max-w-sm text-sm text-foreground">The general ledger opens in its own viewer.</p>
            {!buyer && <p className="mt-1 text-xs text-muted-foreground">Open it on Financials → Add-backs in the books.</p>}
          </Centered>
        </ViewerFrame>
      );
    default:
      return <ViewerFrame className={props.className}><Centered><p className="text-sm text-muted-foreground">This kind of file can't be shown here.</p></Centered></ViewerFrame>;
  }
}

/** The neutral backdrop the white pages sit on (so they read as documents in both themes). */
export function ViewerFrame({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("relative min-h-[320px] bg-[#EDEBE6] dark:bg-[#2A2724] vdr-noprint", className)}>{children}</div>;
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-[320px] flex-col items-center justify-center px-6 py-16 text-center">{children}</div>;
}

// ── Pages (PDF, photo) ─────────────────────────────────────────────────────

function PagesView(props: {
  urls: ReturnType<typeof vdrUrls>;
  itemId: string;
  pages: VdrManifest["pages"];
  viewId: string | null;
  initialPage: number | null;
  className?: string;
  onPage: (n: number) => void;
}) {
  const { pages } = props;
  const [zoom, setZoom] = useState<Zoom>("fit");
  const [page, setPage] = useState(1);
  const holder = useRef<HTMLDivElement>(null);
  const [holderW, setHolderW] = useState(800);
  const scrolled = useRef(false);

  useLayoutEffect(() => {
    const el = holder.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHolderW(el.clientWidth));
    ro.observe(el);
    setHolderW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const target = zoom === "fit" ? Math.min(holderW - 24, 980) : zoom === "100" ? 800 : 1200;
  const px = typeof window !== "undefined" ? target * (window.devicePixelRatio || 1) : target;
  const w = px > 900 ? 1400 : 700;

  // The page most in view.
  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const seen = new Map<number, number>();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) seen.set(Number((e.target as HTMLElement).dataset.page), e.intersectionRatio);
      let best = 0, bestR = 0;
      for (const [n, r] of Array.from(seen.entries())) if (r > bestR) { best = n; bestR = r; }
      if (best) { setPage(best); props.onPage(best); }
    }, { root: null, threshold: [0, 0.25, 0.5, 0.75, 1] });
    el.querySelectorAll("[data-page]").forEach((n) => io.observe(n));
    return () => io.disconnect();
  }, [pages.length]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (scrolled.current || !props.initialPage || props.initialPage < 2) return;
    const el = holder.current?.querySelector(`[data-page="${props.initialPage}"]`);
    if (el) { el.scrollIntoView({ block: "start" }); scrolled.current = true; }
  }, [props.initialPage, holderW]);

  return (
    <ViewerFrame className={props.className}>
      <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-black/5 bg-[#EDEBE6]/95 px-3 py-1.5 text-xs text-[#46423B] backdrop-blur dark:border-white/5 dark:bg-[#2A2724]/95 dark:text-[#D9D3C7]">
        <span data-testid="vdr-page-counter">Page {page} of {pages.length}</span>
        <label className="flex items-center gap-1.5">
          <span className="sr-only">Zoom</span>
          <select value={zoom} onChange={(e) => setZoom(e.target.value as Zoom)} className="rounded border border-black/10 bg-transparent px-1.5 py-0.5 dark:border-white/10" data-testid="vdr-zoom">
            <option value="fit">Fit width</option>
            <option value="100">100%</option>
            <option value="150">150%</option>
          </select>
        </label>
      </div>
      <div ref={holder} className="overflow-x-auto px-3 py-4" onContextMenu={(e) => e.preventDefault()}>
        <div className="mx-auto flex flex-col items-center gap-4" style={{ width: target }}>
          {pages.map((pg, i) => (
            <div key={i} data-page={i + 1} className="w-full bg-white shadow-[0_1px_4px_rgba(0,0,0,0.18)]" style={{ aspectRatio: `${pg.w} / ${pg.h}` }}>
              <img
                src={props.urls.page(props.itemId, i + 1, w, props.viewId)}
                alt={`Page ${i + 1}`}
                loading={i < 2 ? "eager" : "lazy"}
                draggable={false}
                className="block h-full w-full select-none"
                onDragStart={(e) => e.preventDefault()}
              />
            </div>
          ))}
        </div>
      </div>
      <p className="vdr-printonly hidden">Printing is turned off for this document.</p>
    </ViewerFrame>
  );
}

// ── Sheets ─────────────────────────────────────────────────────────────────

function SheetView(props: { source: VdrSource; urls: ReturnType<typeof vdrUrls>; itemId: string; sheets: VdrManifest["sheets"]; reader?: { name: string | null; email: string } | null; className?: string; onSheet: (i: number) => void }) {
  const [sheet, setSheet] = useState(props.sheets[0]?.index ?? 0);
  useEffect(() => { props.onSheet(sheet); }, [sheet]); // eslint-disable-line react-hooks/exhaustive-deps
  const PAGE = 200;
  const q = useInfiniteQuery<VdrSheetRows>({
    queryKey: [...sourceKey(props.source), "sheet", props.itemId, sheet],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => vdrFetch("GET", props.urls.sheet(props.itemId, `sheet=${sheet}&offset=${pageParam}&limit=${PAGE}`)),
    getNextPageParam: (last) => (last.offset + PAGE < last.total ? last.offset + PAGE : undefined),
  });
  const rows = useMemo(() => (q.data?.pages ?? []).flatMap((p) => p.rows), [q.data]);
  const covered = useMemo(() => new Set((q.data?.pages ?? []).flatMap((p) => p.covered).map(([r, c]) => `${r}:${c}`)), [q.data]);
  const meta = props.sheets.find((s) => s.index === sheet);
  const cols = meta ? Array.from({ length: Math.min(meta.cols, 200) }, (_, i) => meta.firstCol + i) : [];
  return (
    <ViewerFrame className={props.className}>
      {props.sheets.length > 1 && (
        <div className="flex gap-1 overflow-x-auto border-b border-black/5 px-2 pt-2 dark:border-white/5" role="tablist" aria-label="Sheets">
          {props.sheets.map((s) => (
            <button key={s.index} role="tab" aria-selected={s.index === sheet} onClick={() => setSheet(s.index)}
              className={cn("shrink-0 rounded-t-md px-3 py-1.5 text-xs", s.index === sheet ? "bg-white text-[#201D18]" : "text-[#46423B] hover:bg-white/60 dark:text-[#D9D3C7] dark:hover:bg-white/10")}>
              {s.name}
            </button>
          ))}
        </div>
      )}
      <div className="relative m-2 overflow-auto bg-white" style={{ maxHeight: "75vh" }} onContextMenu={(e) => e.preventDefault()}>
        {q.isLoading ? (
          <Centered><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></Centered>
        ) : q.error ? (
          <Centered><p className="text-sm text-[#46423B]">This sheet couldn't be loaded.</p></Centered>
        ) : rows.length === 0 ? (
          <Centered><p className="text-sm text-[#46423B]">This sheet is empty.</p></Centered>
        ) : (
          <table className="border-collapse select-none text-xs text-[#201D18]" data-testid="vdr-sheet">
            <thead className="sticky top-0 z-[1] bg-[#F3F1EC]">
              <tr>
                <th className="sticky left-0 z-[2] border border-[#E2DED5] bg-[#F3F1EC] px-2 py-1 text-[10px] font-medium text-[#6B655B]" />
                {cols.map((c) => <th key={c} className="border border-[#E2DED5] px-2 py-1 text-[10px] font-medium text-[#6B655B]">{columnLetters(c)}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.r}>
                  <td className="sticky left-0 border border-[#E2DED5] bg-[#F3F1EC] px-2 py-1 text-right text-[10px] text-[#6B655B]">{row.r}</td>
                  {cols.map((c, ci) => {
                    const v = row.v[ci] ?? "";
                    const isCovered = covered.has(`${row.r}:${c}`);
                    return <td key={c} className={cn("max-w-[260px] truncate border border-[#EEEBE4] px-2 py-1 align-top", isCovered && "bg-[#201D18]/5 font-mono")} title={v || undefined}>{v}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <Overlay reader={props.reader} />
      </div>
      {meta && (
        <div className="flex items-center justify-between gap-2 px-3 pb-3 text-xs text-[#46423B] dark:text-[#D9D3C7]">
          <span>{rows.length.toLocaleString()} of {meta.rows.toLocaleString()} rows{meta.cols > 200 ? " · first 200 columns" : ""}</span>
          {q.hasNextPage && (
            <Button variant="outline" size="sm" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>
              {q.isFetchingNextPage ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}Show 200 more rows
            </Button>
          )}
        </div>
      )}
    </ViewerFrame>
  );
}

// ── Word and text ──────────────────────────────────────────────────────────

const PAPER_CSS = `body{margin:0;padding:40px 48px;background:#FBF9F4;color:#201D18;font:14px/1.6 Georgia,'Times New Roman',serif}
table{border-collapse:collapse;margin:12px 0}td,th{border:1px solid #DDD7CB;padding:4px 8px;vertical-align:top}
img{max-width:100%;height:auto}h1,h2,h3{font-family:Inter,Arial,sans-serif;color:#201D18}`;

function HtmlView(props: { source: VdrSource; urls: ReturnType<typeof vdrUrls>; itemId: string; reader?: { name: string | null; email: string } | null; className?: string; onReady: () => void }) {
  const { data, isLoading, error } = useQuery<{ html: string }>({
    queryKey: [...sourceKey(props.source), "html", props.itemId],
    queryFn: () => vdrFetch("GET", props.urls.html(props.itemId)),
  });
  useEffect(() => { if (data) props.onReady(); }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  const doc = useMemo(() => (data ? `<!doctype html><html><head><meta charset="utf-8"><style>${PAPER_CSS}</style></head><body>${data.html}</body></html>` : ""), [data]);
  return (
    <ViewerFrame className={props.className}>
      {isLoading ? <Centered><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></Centered>
        : error || !data ? <Centered><p className="text-sm text-[#46423B]">This document couldn't be loaded.</p></Centered>
        : (
          <div className="relative mx-auto my-4 max-w-[860px] bg-[#FBF9F4] shadow-[0_1px_4px_rgba(0,0,0,0.18)]">
            <iframe title="Document" sandbox="" srcDoc={doc} className="block h-[78vh] w-full border-0" data-testid="vdr-html" />
            <Overlay reader={props.reader} />
          </div>
        )}
    </ViewerFrame>
  );
}

function TextView(props: { source: VdrSource; urls: ReturnType<typeof vdrUrls>; itemId: string; reader?: { name: string | null; email: string } | null; className?: string; onReady: () => void }) {
  const { data, isLoading, error } = useQuery<{ text: string }>({
    queryKey: [...sourceKey(props.source), "text", props.itemId],
    queryFn: () => vdrFetch("GET", props.urls.text(props.itemId)),
  });
  useEffect(() => { if (data) props.onReady(); }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <ViewerFrame className={props.className}>
      {isLoading ? <Centered><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></Centered>
        : error || !data ? <Centered><p className="text-sm text-[#46423B]">This document couldn't be loaded.</p></Centered>
        : (
          <div className="relative mx-auto my-4 max-w-[860px] bg-[#FBF9F4] px-6 py-8 shadow-[0_1px_4px_rgba(0,0,0,0.18)] sm:px-12">
            <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-[#201D18]" data-testid="vdr-text">{data.text}</pre>
            <Overlay reader={props.reader} />
          </div>
        )}
    </ViewerFrame>
  );
}

/** The viewer's download control (a link when allowed, else the plain reason). */
export function DownloadControl({ allowed, label, href, compact }: { allowed: boolean; label: string; href: string | null; compact?: boolean }) {
  if (allowed && !href) {
    return <Button size="sm" variant="outline" className="shrink-0" disabled><Download className="h-3.5 w-3.5 sm:mr-1.5" /><span className={compact ? "hidden sm:inline" : ""}>{label}</span></Button>;
  }
  if (allowed && href) {
    return (
      <Button asChild size="sm" variant="outline" className="shrink-0">
        <a href={href} data-testid="vdr-download"><Download className="h-3.5 w-3.5 sm:mr-1.5" /><span className={compact ? "hidden sm:inline" : ""}>{label}</span></a>
      </Button>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="vdr-view-only">
      <Lock className="h-3.5 w-3.5 shrink-0" /><span className={compact ? "hidden sm:inline" : ""}>{label}</span>
    </span>
  );
}

/** Prev / next controls. */
export function PrevNext({ prevId, nextId, onOpen }: { prevId: string | null; nextId: string | null; onOpen: (id: string) => void }) {
  const open = useCallback((id: string | null) => { if (id) onOpen(id); }, [onOpen]);
  return (
    <div className="flex items-center gap-1">
      <Button size="icon" variant="ghost" className="h-8 w-8" disabled={!prevId} onClick={() => open(prevId)} aria-label="Previous document"><ChevronLeft className="h-4 w-4" /></Button>
      <Button size="icon" variant="ghost" className="h-8 w-8" disabled={!nextId} onClick={() => open(nextId)} aria-label="Next document"><ChevronRight className="h-4 w-4" /></Button>
    </div>
  );
}
