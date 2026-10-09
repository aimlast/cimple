/**
 * BuyerDataRoom — the buyer's data room (vdr spec §6), at
 * /view/:token/data-room?folder=&doc=&q=&page=. Also rendered by the broker's
 * "View as a buyer" (source = broker + accessId, preview: nothing recorded)
 * and for a buyer's team member (their own link).
 *
 *  - Header: the brokerage's logo or name (never a Cimple logo), the deal,
 *    the "Memorandum | Data room" switch (buyers only), the reader's email.
 *  - Room: search (names and contents), "New since your last visit", "All
 *    documents", the numbered folder tree, the list; Index (CSV).
 *  - Viewer: the document (watermarked), prev/next, download or "View only",
 *    About this document; full screen on phones with an About sheet.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useParams, useSearch } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, ArrowLeft, Building, Download, Info, Lock, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { BuyerItemAbout, BuyerRoomPayload, BuyerSearchHit } from "@shared/vdr-api";
import { useBuyerRoom, useItemAbout, vdrFetch, vdrUrls, sourceKey, VdrRequestError, type VdrSource } from "@/hooks/useDataRoom";
import { RoomSwitch } from "@/components/vdr/RoomSwitch";
import { RoomList, RoomRail, SearchBox, SearchResults, YourRequests, type RoomPlace } from "@/components/vdr/buyer/RoomBrowser";
import { AboutPanel } from "@/components/vdr/buyer/AboutPanel";
import { RequestDialog, type RequestPrefill } from "@/components/vdr/buyer/RequestDialog";
import { YourTeam } from "@/components/vdr/buyer/YourTeam";
import { TeamAcknowledge } from "@/components/vdr/buyer/TeamAcknowledge";
import { DownloadControl, PrevNext, VdrViewer } from "@/components/vdr/VdrViewer";
import { parseRoomLink } from "@/components/vdr/links";
import type { ResolvePayload } from "@shared/vdr-api";
import { BuyerChatbot } from "@/components/buyer/BuyerChatbot";

type Nav = { place: RoomPlace; doc: string | null; q: string; page: number | null; rows?: number[] | null; sheet?: string | null; needle?: string | null };

function parseNav(search: string): Nav {
  const p = new URLSearchParams(search);
  const folder = p.get("folder");
  const place: RoomPlace = folder === "new" ? { kind: "new" } : folder && /^[A-Za-z0-9_-]{1,64}$/.test(folder) ? { kind: "folder", id: folder } : { kind: "all" };
  const doc = p.get("doc");
  const page = Number(p.get("page"));
  const link = parseRoomLink(search);
  return { place, doc: doc && /^[A-Za-z0-9_-]{1,64}$/.test(doc) ? doc : null, q: (p.get("q") ?? "").slice(0, 100), page: Number.isInteger(page) && page > 0 ? page : null, rows: link.rows, sheet: link.sheet, needle: link.needle };
}

function navSearch(n: Nav): string {
  const p = new URLSearchParams();
  if (n.place.kind === "new") p.set("folder", "new");
  if (n.place.kind === "folder") p.set("folder", n.place.id);
  if (n.doc) p.set("doc", n.doc);
  if (n.q) p.set("q", n.q);
  if (n.page && n.doc) p.set("page", String(n.page));
  if (n.doc && n.sheet) p.set("sheet", n.sheet);
  if (n.doc && n.rows && n.rows.length) p.set("rows", n.rows.join(","));
  if (n.doc && n.needle) p.set("needle", n.needle);
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** The route page: /view/:token/data-room. */
export default function BuyerDataRoomPage() {
  const { token } = useParams<{ token: string }>();
  const source = useMemo<VdrSource>(() => ({ kind: "buyer", token: token! }), [token]);
  return <BuyerDataRoom source={source} />;
}

export function BuyerDataRoom({ source, embedded }: { source: VdrSource; embedded?: boolean }) {
  const search = useSearch();
  const [location, setLocation] = useLocation();
  const qc = useQueryClient();
  // The buyer keeps their place in the URL; the broker's preview keeps it in memory.
  const [localNav, setLocalNav] = useState<Nav>({ place: { kind: "all" }, doc: null, q: "", page: null });
  const nav = source.kind === "buyer" ? parseNav(search) : localNav;
  const go = useCallback((next: Partial<Nav>) => {
    const n = { ...nav, ...next };
    if (source.kind === "buyer") setLocation(`${location.split("?")[0]}${navSearch(n)}`, { replace: !("doc" in next) });
    else setLocalNav(n);
  }, [nav, source.kind, setLocation, location]);

  const room = useBuyerRoom(source);
  // A link by document id (gl's "Open the general ledger in the data room →", a citation opened in a new tab):
  // find its room item for this reader, then open it like any other. Not visible → "isn't available to you".
  const byDocument = source.kind === "buyer" ? parseRoomLink(search).documentId : null;
  const [docMissing, setDocMissing] = useState(false);
  useEffect(() => {
    if (!byDocument || nav.doc || source.kind !== "buyer") return;
    let alive = true;
    vdrFetch<ResolvePayload>("GET", `/api/view/${encodeURIComponent(source.token)}/data-room/resolve?documentIds=${encodeURIComponent(byDocument)}`)
      .then((r) => {
        if (!alive) return;
        const hit = r.documents[byDocument];
        if (hit && hit.available) {
          const link = parseRoomLink(search);
          setLocation(`${location.split("?")[0]}${navSearch({ place: { kind: "all" }, doc: hit.itemId, q: "", page: hit.replaced ? null : link.page, rows: link.rows, sheet: link.sheet, needle: link.needle })}`, { replace: true });
        } else setDocMissing(true);
      })
      .catch(() => { if (alive) setDocMissing(true); });
    return () => { alive = false; };
  }, [byDocument, nav.doc]); // eslint-disable-line react-hooks/exhaustive-deps
  const [asking, setAsking] = useState<RequestPrefill | false>(false);
  const [qInput, setQInput] = useState(nav.q);
  useEffect(() => setQInput(nav.q), [nav.q]);
  useEffect(() => {
    const t = setTimeout(() => { if (qInput.trim() !== nav.q) go({ q: qInput.trim() }); }, 350);
    return () => clearTimeout(t);
  }, [qInput]); // eslint-disable-line react-hooks/exhaustive-deps

  const canSearch = source.kind === "buyer";
  const hits = useQuery<{ hits: BuyerSearchHit[] }>({
    queryKey: [...sourceKey(source), "search", nav.q],
    queryFn: () => vdrFetch("GET", vdrUrls(source).search(nav.q)),
    enabled: canSearch && nav.q.length >= 2,
  });

  if (room.isLoading) return <RoomSkeleton embedded={embedded} />;
  if (room.error || !room.data) return <RoomError error={room.error} source={source} embedded={embedded} onRetry={() => room.refetch()} />;
  const data = room.data;

  const token = source.kind === "buyer" ? source.token : null;
  const isTeam = data.reader.kind === "team";
  const canRequest = !!data.canRequest && source.kind === "buyer";
  const openAsk = canRequest ? (prefill: RequestPrefill = null) => setAsking(prefill) : null;
  const askDialog = canRequest ? <RequestDialog source={source} open={asking !== false} onOpenChange={(o) => { if (!o) setAsking(false); }} prefill={asking || null} /> : null;
  const header = (
    <RoomHeader data={data} token={token} isTeam={isTeam} embedded={embedded} onIndex={canSearch ? vdrUrls(source).index : null} />
  );

  if (byDocument && !nav.doc) {
    if (!docMissing) return <RoomSkeleton embedded={embedded} />;
    return (
      <div className={cn("min-h-screen bg-background", embedded && "min-h-0")}>
        {!embedded && header}
        <div className="mx-auto max-w-md px-6 py-20 text-center" data-testid="vdr-doc-missing">
          <AlertCircle className="mx-auto h-7 w-7 text-muted-foreground/60" />
          <p className="mt-3 text-sm font-medium">This document isn't in your data room yet.</p>
          <p className="mt-1 text-sm text-muted-foreground">Your broker shares documents as the process moves forward. You can ask for this one.</p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {openAsk && <Button size="sm" onClick={() => openAsk({ text: "The document the memorandum points to", documentId: byDocument })}>Ask your broker for it</Button>}
            <Button variant="outline" size="sm" onClick={() => setLocation(location.split("?")[0], { replace: true })}><ArrowLeft className="mr-1.5 h-3.5 w-3.5" /> Back to the data room</Button>
          </div>
        </div>
        {askDialog}
      </div>
    );
  }

  if (nav.doc) {
    return (
      <div className={cn("min-h-screen bg-background", embedded && "min-h-0")}>
        {/* Phones: the viewer is full screen (its own top bar); desktop keeps the header. */}
        {!embedded && <div className="sticky top-0 z-40 hidden lg:block">{header}</div>}
        <DocumentScreen
          key={nav.doc}
          embedded={embedded}
          source={source}
          data={data}
          itemId={nav.doc}
          initialPage={nav.page}
          cited={{ rows: nav.rows ?? null, sheet: nav.sheet ?? null, needle: nav.needle ?? null }}
          onBack={() => go({ doc: null, page: null })}
          onOpen={(id) => go({ doc: id, page: null })}
          onAsk={openAsk}
          memoHref={token && !isTeam ? (sectionId) => `/view/${encodeURIComponent(token)}#section-${encodeURIComponent(sectionId)}` : undefined}
        />
        {askDialog}
      </div>
    );
  }

  const empty = data.items.length === 0;
  return (
    <div className={cn("min-h-screen bg-background", embedded && "min-h-0")}>
      {!embedded && header}
      {data.endsInDays != null && data.endsInDays <= 5 && (
        <div className="border-b border-teal/30 bg-teal/10 px-4 py-2 text-center text-xs text-foreground sm:px-6" data-testid="room-expiry">
          {data.endsInDays === 0 ? "Your access ends today." : `Your access ends in ${data.endsInDays} ${data.endsInDays === 1 ? "day" : "days"}.`} Ask your broker to extend it.
        </div>
      )}
      <div className="mx-auto flex max-w-6xl gap-8 px-4 py-6 sm:px-6">
        <aside className="hidden w-[250px] shrink-0 lg:block">
          <div className="sticky top-20">
            <RoomRail folders={data.folders} items={data.items} place={nav.place} onPlace={(p) => go({ place: p, q: "" })} query={qInput} onQuery={setQInput} canSearch={canSearch} requests={data.requests ?? []} onAsk={openAsk ? () => openAsk(null) : null} />
            {token && !isTeam && data.team && <div className="mt-6"><YourTeam token={token} team={data.team} canInvite={!!data.canInviteTeam} /></div>}
          </div>
        </aside>
        <main className="min-w-0 flex-1">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-lg font-semibold">{isTeam ? `${data.reader.principalCompany ?? "The buyer"}'s data room` : "Data room"}</h1>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {isTeam
                  ? `Documents the broker has shared with ${(data.reader.principalCompany ?? "the buyer").replace(/\.+$/, "")}. Everything here is covered by the NDA they signed and the confidentiality terms you accepted.`
                  : "Documents your broker has shared with you. Everything here is covered by the NDA you signed."}
                {data.expiresAt ? ` Your access ends ${new Date(data.expiresAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}.` : ""}
              </p>
            </div>
            {canSearch && !empty && (
              <Button asChild size="sm" variant="ghost" className="hidden shrink-0 lg:inline-flex">
                <a href={vdrUrls(source).index} data-testid="room-index-csv"><Download className="mr-1.5 h-3.5 w-3.5" /> Index (CSV)</a>
              </Button>
            )}
          </div>
          {/* Phones: search + new + where you are */}
          <div className="mb-4 space-y-2 lg:hidden">
            {canSearch && <SearchBox value={qInput} onChange={setQInput} />}
            {!nav.q && (
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                <button onClick={() => go({ place: { kind: "all" } })} className={cn("rounded-full border px-2.5 py-1", nav.place.kind === "all" ? "border-teal/40 bg-teal/10 text-teal" : "border-border text-muted-foreground")}>All documents ({data.items.length})</button>
                <button onClick={() => go({ place: { kind: "new" } })} className={cn("rounded-full border px-2.5 py-1", nav.place.kind === "new" ? "border-teal/40 bg-teal/10 text-teal" : "border-border text-muted-foreground")}>New since your last visit ({data.newCount})</button>
              </div>
            )}
            {nav.place.kind === "folder" && !nav.q && <Breadcrumb data={data} folderId={nav.place.id} onPlace={(p) => go({ place: p })} />}
          </div>
          {empty ? (
            <div className="rounded-lg border border-dashed border-border px-6 py-14 text-center" data-testid="room-empty">
              <p className="text-sm font-medium">Nothing has been shared with you yet.</p>
              <p className="mt-1 text-sm text-muted-foreground">Your broker will add documents here.</p>
              {openAsk && <Button size="sm" variant="outline" className="mt-4" onClick={() => openAsk(null)}>Ask for a document</Button>}
            </div>
          ) : nav.q.length >= 2 && canSearch ? (
            <SearchResults q={nav.q} hits={hits.data?.hits} loading={hits.isLoading} error={!!hits.error} onOpen={(id, page) => go({ doc: id, page })} />
          ) : (
            <RoomList
              folders={data.folders}
              items={data.items}
              place={nav.place.kind === "all" ? nav.place : nav.place.kind === "new" ? nav.place : nav.place}
              onOpen={(id) => go({ doc: id, page: null })}
              onPlace={(p) => go({ place: p })}
              previousVisitAt={data.previousVisitAt}
            />
          )}
          {/* Phones: the top folders as rows under "All documents". */}
          {!empty && !nav.q && nav.place.kind === "all" && <PhoneFolders data={data} onPlace={(p) => go({ place: p })} />}
          {/* Phones: your requests and "Ask for a document". */}
          {(openAsk || (data.requests?.length ?? 0) > 0) && !(empty && (data.requests?.length ?? 0) === 0) && (
            <div className="mt-6 lg:hidden"><YourRequests requests={data.requests ?? []} onAsk={openAsk ? () => openAsk(null) : null} /></div>
          )}
          {/* Phones: your team. */}
          {token && !isTeam && data.team && <div className="mt-6 lg:hidden"><YourTeam token={token} team={data.team} canInvite={!!data.canInviteTeam} /></div>}
        </main>
      </div>
      {askDialog}
      {!embedded && token && !isTeam && <RoomChatbot token={token} qc={qc} />}
      {!embedded && (
        <footer className="border-t border-border py-6 text-center text-xs text-muted-foreground/70">
          Confidential. Your broker can see which documents you open.
        </footer>
      )}
    </div>
  );
}

function RoomHeader({ data, token, isTeam, embedded, onIndex }: { data: BuyerRoomPayload; token: string | null; isTeam: boolean; embedded?: boolean; onIndex: string | null }) {
  if (embedded) return null;
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur-sm">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          {data.deal.firmLogo ? (
            <img src={data.deal.firmLogo} alt={data.deal.firmName ? `${data.deal.firmName} logo` : "Brokerage logo"} className="h-8 w-auto max-w-[110px] shrink-0 rounded bg-white object-contain px-1" />
          ) : (
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-teal"><Building className="h-4 w-4 text-teal-foreground" /></div>
          )}
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold leading-tight">{data.deal.name}</p>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{isTeam ? `${data.reader.principalCompany ?? "The buyer"}'s data room` : "Data room"}</p>
          </div>
        </div>
        {token && !isTeam && <RoomSwitch token={token} active="room" className="hidden md:inline-flex" />}
        <div className="flex shrink-0 items-center gap-2">
          <p className="hidden text-xs text-muted-foreground sm:block">{data.reader.email}</p>
          {onIndex && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="icon" variant="ghost" className="h-8 w-8" aria-label="More"><MoreHorizontal className="h-4 w-4" /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem asChild><a href={onIndex}><Download className="mr-2 h-3.5 w-3.5" /> Index (CSV)</a></DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
      {token && !isTeam && (
        <div className="border-t border-border px-4 py-2 md:hidden"><RoomSwitch token={token} active="room" full /></div>
      )}
    </header>
  );
}

function Breadcrumb({ data, folderId, onPlace }: { data: BuyerRoomPayload; folderId: string; onPlace: (p: RoomPlace) => void }) {
  const byId = new Map(data.folders.map((f) => [f.id, f]));
  const trail = [];
  let f = byId.get(folderId);
  const seen = new Set<string>();
  while (f && !seen.has(f.id)) { seen.add(f.id); trail.unshift(f); f = f.parentId ? byId.get(f.parentId) : undefined; }
  return (
    <nav className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground" aria-label="Where you are">
      <button onClick={() => onPlace({ kind: "all" })} className="hover:text-foreground">Data room</button>
      {trail.map((t) => (
        <span key={t.id} className="flex items-center gap-1">›<button onClick={() => onPlace({ kind: "folder", id: t.id })} className="hover:text-foreground">{t.number} {t.name}</button></span>
      ))}
    </nav>
  );
}

function PhoneFolders({ data, onPlace }: { data: BuyerRoomPayload; onPlace: (p: RoomPlace) => void }) {
  const top = data.folders.filter((f) => !f.parentId);
  if (top.length === 0) return null;
  return (
    <div className="mt-6 lg:hidden">
      <h3 className="mb-1.5 px-1 text-xs font-semibold text-muted-foreground">Folders</h3>
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        {top.map((f) => (
          <button key={f.id} onClick={() => onPlace({ kind: "folder", id: f.id })} className="flex w-full items-center gap-3 border-b border-border px-3 py-3 text-left text-sm last:border-0">
            <span className="w-8 font-mono text-[11px] text-muted-foreground">{f.number}</span>
            <span className="flex-1 truncate">{f.name}</span>
            <span className="text-xs tabular-nums text-muted-foreground">{f.count}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function DocumentScreen({ source, data, itemId, initialPage, cited, onBack, onOpen, embedded, onAsk, memoHref }: { source: VdrSource; data: BuyerRoomPayload; itemId: string; initialPage: number | null; cited?: { rows: number[] | null; sheet: string | null; needle: string | null }; onBack: () => void; onOpen: (id: string) => void; embedded?: boolean; onAsk: ((p: RequestPrefill) => void) | null; memoHref?: (sectionId: string) => string }) {
  const about = useItemAbout(source, itemId, cited?.needle ?? null, initialPage);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [viewId, setViewId] = useState<string | null>(null);
  const [page, setPage] = useState<number | null>(initialPage);
  const a = about.data as BuyerItemAbout | undefined;
  const item = data.items.find((i) => i.id === itemId);
  if (about.error) {
    return (
      <div className="mx-auto max-w-md px-6 py-20 text-center" data-testid="vdr-doc-missing">
        <AlertCircle className="mx-auto h-7 w-7 text-muted-foreground/60" />
        <p className="mt-3 text-sm font-medium">This document isn't available to you.</p>
        <Button variant="outline" size="sm" className="mt-4" onClick={onBack}><ArrowLeft className="mr-1.5 h-3.5 w-3.5" /> Back to the data room</Button>
      </div>
    );
  }
  const title = a?.title ?? item?.title ?? "Document";
  const number = a?.number ?? item?.number ?? null;
  const download = a?.manifest.download ?? { allowed: false, label: "View only. Ask your broker if you need a copy." };
  const downloadHref = source.kind === "buyer" && download.allowed ? vdrUrls(source).download(itemId, viewId) : null;
  return (
    <div className={cn("flex flex-col", !embedded && "min-h-screen lg:min-h-[calc(100vh-57px)]")}>
      {/* Sticky under the header (57 px) or the preview banner (45 px); the viewer's page bar sticks under this (49 px). */}
      <div className={cn("sticky z-30 border-b border-border bg-background/95 backdrop-blur-sm", embedded ? "top-[45px]" : "top-0 lg:top-[57px]")}>
        <div className="mx-auto flex max-w-[1400px] items-center gap-2 px-3 py-2 sm:px-6">
          <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0" onClick={onBack} aria-label="Back to the data room"><ArrowLeft className="h-4 w-4" /></Button>
          <nav className="hidden min-w-0 flex-1 items-center gap-1 truncate text-xs text-muted-foreground md:flex" aria-label="Where this is">
            <button onClick={onBack} className="hover:text-foreground">Data room</button>
            {(a?.folderTrail ?? []).map((f) => <span key={f.id} className="truncate">/ {f.number} {f.name}</span>)}
            <span className="truncate text-foreground">/ {number} {title}</span>
          </nav>
          <p className="min-w-0 flex-1 truncate text-sm font-medium md:hidden">{number} {title}</p>
          {a && <PrevNext prevId={a.prevId} nextId={a.nextId} onOpen={onOpen} />}
          <div className="hidden sm:block">{a && <DownloadControl allowed={download.allowed} label={download.label} href={downloadHref} />}</div>
        </div>
      </div>
      <div className="mx-auto flex w-full max-w-[1400px] flex-1 gap-0 lg:gap-6 lg:px-6 lg:py-4">
        <div className="min-w-0 flex-1">
          <ViewerWithView source={source} itemId={itemId} about={a ?? null} loading={about.isLoading} reader={{ name: data.reader.name, email: data.reader.email }} initialPage={a?.focusPage ?? initialPage ?? null} cited={cited} focus={a?.focusPage ? { page: a.focusPage, boxes: a.focusBoxes ?? [] } : null} onView={setViewId} onPage={setPage} onAsk={onAsk ? () => onAsk({ text: `A copy of '${title}'`, itemId }) : undefined} barTop={embedded ? "top-[94px]" : "top-[49px] lg:top-[106px]"} />
        </div>
        <aside className="hidden w-[320px] shrink-0 lg:block">
          <div className={cn("sticky max-h-[calc(100vh-140px)] overflow-y-auto rounded-lg border border-border bg-card p-4", embedded ? "top-[110px]" : "top-[122px]")}>{a ? <AboutPanel about={a} source={source} page={page} memoHref={memoHref} /> : <Skeleton className="h-32 w-full" />}</div>
        </aside>
      </div>
      <p className="px-4 py-3 text-center text-[11px] text-muted-foreground/80">
        Viewed by {data.reader.name || data.reader.email} ({data.reader.email}) · {new Date().toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" })} · Confidential · Your broker can see which documents you open.
      </p>
      {/* Phones: About + Download at the bottom */}
      <div className="sticky bottom-0 z-30 flex items-center justify-between gap-2 border-t border-border bg-background/95 px-3 py-2 backdrop-blur-sm lg:hidden">
        <Button variant="outline" size="sm" onClick={() => setAboutOpen(true)} disabled={!a}><Info className="mr-1.5 h-3.5 w-3.5" /> About</Button>
        {a && <DownloadControl allowed={download.allowed} label={download.allowed ? "Download" : "View only"} href={downloadHref} />}
      </div>
      <Sheet open={aboutOpen} onOpenChange={setAboutOpen}>
        <SheetContent side="bottom" className="max-h-[80vh] overflow-y-auto">
          <SheetHeader><SheetTitle className="sr-only">About this document</SheetTitle></SheetHeader>
          {a && <AboutPanel about={a} source={source} page={page} memoHref={memoHref} />}
        </SheetContent>
      </Sheet>
    </div>
  );
}

/** The viewer, plus the download link once the buyer's view exists (its trace goes on the download). */
function ViewerWithView({ source, itemId, about, loading, reader, initialPage, cited, focus, onView, onPage, onAsk, barTop }: { source: VdrSource; itemId: string; about: BuyerItemAbout | null; loading: boolean; reader: { name: string | null; email: string }; initialPage: number | null; cited?: { rows: number[] | null; sheet: string | null }; focus?: { page: number; boxes: Array<[number, number, number, number]> } | null; onView: (id: string) => void; onPage: (n: number) => void; onAsk?: () => void; barTop: string }) {
  return (
    <VdrViewer
      focus={focus ?? null}
      initialSheet={cited?.sheet ?? null}
      highlightRows={cited?.rows ?? null}
      barTop={barTop}
      onView={onView}
      onPageChange={onPage}
      onAsk={onAsk}
      source={source}
      itemId={itemId}
      manifest={about?.manifest ?? null}
      loading={loading}
      reader={reader}
      openedFrom={initialPage ? "search" : "room"}
      initialPage={initialPage}
      className="lg:rounded-lg"
    />
  );
}

function RoomChatbot({ token, qc }: { token: string; qc: ReturnType<typeof useQueryClient> }) {
  // The Questions widget lives on the memorandum's data; it's shown here when the buyer came from there.
  const view = qc.getQueryData<any>(["/api/view", token]);
  if (!view?.access?.id || !view?.deal?.id) return null;
  return (
    <BuyerChatbot
      dealId={view.deal.id}
      buyerAccessId={view.access.id}
      accessToken={token}
      businessName={view.deal.businessName}
      questionFeed={view.publishedQuestions ?? []}
    />
  );
}

function RoomSkeleton({ embedded }: { embedded?: boolean }) {
  return (
    <div className={cn("mx-auto max-w-6xl space-y-4 px-6 py-8", !embedded && "min-h-screen")}>
      <Skeleton className="h-8 w-56" />
      <div className="flex gap-8">
        <div className="hidden w-[250px] space-y-2 lg:block">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-7 w-full" />)}</div>
        <div className="flex-1 space-y-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
      </div>
    </div>
  );
}

/** The screens a reader sees when the room isn't open to them (§6.5). */
function RoomError({ error, source, embedded, onRetry }: { error: VdrRequestError | null; source: VdrSource; embedded?: boolean; onRetry: () => void }) {
  const code = String(error?.body?.code ?? "");
  const token = source.kind === "buyer" ? source.token : null;
  const back = token ? `/view/${encodeURIComponent(token)}` : null;
  let title = "Access denied";
  let body: React.ReactNode = error?.message || "This link is invalid or has expired.";
  let action: React.ReactNode = null;
  if (code === "no_room_access" || code === "room_none") {
    title = "The data room isn't open to you yet.";
    body = "Your broker shares documents with buyers as the process moves forward.";
    // A teaser link never asks for the room (C23): it goes back to the summary, where "Ask for the CIM" lives.
    if (back) action = (
      <div className="flex flex-wrap justify-center gap-2">
        {token && !error?.body?.teaser && <AskForAccess token={token} />}
        <Button asChild variant="outline" size="sm"><Link href={back}>{error?.body?.teaser ? "Back to the summary" : "Back to the memorandum"}</Link></Button>
      </div>
    );
  } else if (code === "room_closed") {
    title = "The data room is closed.";
    body = "Contact your broker if you need anything.";
  } else if (code === "nda_required") {
    title = "Sign the NDA to open the data room.";
    body = "The data room opens once you've signed the confidentiality agreement.";
    if (back) action = <Button asChild size="sm"><Link href={back}>Go to the NDA</Link></Button>;
  } else if (code === "team_ended") {
    title = "Access has ended";
    body = String(error?.body?.error ?? "This data room is no longer open to you.") + ". Contact the broker if you need anything.";
  } else if (code === "ack_required" && token) {
    // A team member's first visit: the confidentiality step (§6.8).
    return <TeamAcknowledge token={token} principalCompany={(error?.body?.principalCompany as string) ?? null} role={(error?.body?.role as string) ?? null} name={(error?.body?.name as string) ?? null} firmName={(error?.body?.firmName as string) ?? null} onDone={onRetry} />;
  } else if (code === "ack_required") {
    title = "Please confirm before opening the data room.";
    body = "Open the link your broker sent you.";
  } else if (!error || (error.status >= 500)) {
    title = "Couldn't load the data room";
    body = "This is a loading problem. Try again.";
    action = <Button variant="outline" size="sm" onClick={onRetry}>Try again</Button>;
  }
  return (
    <div className={cn("flex items-center justify-center bg-background p-6", embedded ? "min-h-[360px]" : "min-h-screen")}>
      <div className="max-w-sm space-y-3 text-center" data-testid={`room-state-${code || "error"}`}>
        <Lock className="mx-auto h-8 w-8 text-muted-foreground/60" />
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground">{body}</p>
        {action && <div className="pt-1">{action}</div>}
      </div>
    </div>
  );
}

/** "Ask for access" (§6.5) — a room-access request to the broker (Blind CIM or Full CIM links; never a teaser link). */
function AskForAccess({ token }: { token: string }) {
  const [state, setState] = useState<"idle" | "busy" | "sent" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  if (state === "sent") return <p className="w-full text-sm text-teal" data-testid="room-access-sent">Sent. Your broker will let you know.</p>;
  return (
    <>
      <Button
        size="sm"
        onClick={async () => {
          setState("busy");
          try {
            await vdrFetch("POST", `/api/view/${encodeURIComponent(token)}/data-room/requests`, { kind: "room_access" });
            setState("sent");
          } catch (e: any) {
            setMessage(e?.message ?? "That didn't work.");
            setState("error");
          }
        }}
        disabled={state === "busy"}
        data-testid="room-ask-access"
      >
        Ask for access
      </Button>
      {state === "error" && message && <p className="w-full text-xs text-destructive">{message}</p>}
    </>
  );
}
