/**
 * useCimReading — the buyer view room's reading tracker.
 *
 * Measures how long a buyer actually reads each part of the CIM (a table
 * row, a chart, a highlight card, a paragraph) and sends it to
 * POST /api/view/:token/reading as cumulative counters
 * (shared/analytics-v2.ts ReadingPayload). The maths is the pure allocator
 * in shared/reading-allocator.ts; this file is only the browser side:
 *
 *   - starts only once real CIM content is on screen (never on the NDA
 *     form, the "preparing" or "updating" screens) and the server sent a
 *     `reading` block with the content (it doesn't for the owning broker);
 *   - one IntersectionObserver over every [data-cim-block] / [data-cim-page]
 *     element (rootMargin 50%) plus a debounced MutationObserver for
 *     sections that arrive late, expand/collapse and view switches — both
 *     disconnected on unmount;
 *   - a 1 s tick: hidden / away / idle / active (with tab election over a
 *     BroadcastChannel so two tabs never both count), the reading band
 *     under the [data-reading-chrome] bars, the part under the pointer;
 *   - sessionStorage resume (a reload within 30 min of the last active
 *     second continues the visit);
 *   - a NEW VISIT once the buyer comes back to a tab that sat unread for 30
 *     minutes or more (the old one is sent first): a CIM left open all
 *     morning and studied in the afternoon is two visits, not one;
 *   - a send every 15 s while the buyer is actually reading (or clicked
 *     something) — never for idle or hidden seconds alone, so the server's
 *     "last active" time (buyer_visits.last_seen_at) means reading, not an
 *     open tab — and a sendBeacon (text/plain, with the idle/hidden clocks)
 *     when the tab hides or closes; retry 15 → 30 → 60 s when offline.
 *     Counters are cumulative and the server keeps the GREATEST, so a lost,
 *     repeated or late send can never corrupt the totals.
 *
 * Nothing it sends carries CIM text: page ids are the section ids the buyer
 * was served and block keys are structural positions ("row:3").
 */
import { useEffect, useMemo, useRef } from "react";
import {
  CIM_BLOCK_ATTR,
  CIM_PAGE_ATTR,
  READING_CHROME_ATTR,
  READING_RULES,
  type BlockCounters,
  type ReadingInteraction,
  type ReadingInteractionType,
  type ReadingPayload,
  type ViewRoomReading,
} from "@shared/analytics-v2";
import {
  ACTIVITY_RULES,
  ReadingAllocator,
  activityState,
  type AllocatorSnapshot,
  type Frame,
  type FrameBlock,
  type PeerBeat,
  type Rect,
  type VisitClocks,
} from "@shared/reading-allocator";
import { chartOfPoint } from "@shared/cim-blocks";
import type { CimBlockHost } from "@/components/cim/blocks";

/** The attribute on the element that wraps the CIM sheet (the band's horizontal extent). */
export const READING_SHEET_ATTR = "data-reading-sheet";

export interface CimReadingTracker extends CimBlockHost {
  /** A view-room interaction (nav, locked_click, copy, chat_open…). pageId defaults to the page being read. */
  record(type: ReadingInteractionType, pageId?: string | null, blockKey?: string, detail?: string): void;
  /** The page the buyer is reading now (a section id they were served), or null. */
  currentPageId(): string | null;
  /** The served version's opaque id, or null while nothing is tracked. */
  renditionId(): string | null;
}

interface Options {
  token: string | undefined;
  accessId: string | undefined;
  reading: ViewRoomReading | null | undefined;
  /** Real content is on screen (not the NDA / preparing / updating screens). */
  enabled: boolean;
  /**
   * The buyer stepped out of the CIM inside the view room (the data room's
   * document drawer is open over it): the visit keeps going, but those
   * seconds count as away, never reading (shared/reading-allocator.ts).
   */
  paused?: boolean;
}

export function useCimReading({ token, accessId, reading, enabled, paused = false }: Options): CimReadingTracker {
  const sessionRef = useRef<ReadingSession | null>(null);
  const pausedRef = useRef(paused);
  const renditionId = reading?.renditionId ?? null;
  const pageOrderKey = reading?.pageOrder?.join(",") ?? "";

  useEffect(() => {
    pausedRef.current = paused;
    sessionRef.current?.setPaused(paused);
  }, [paused]);

  useEffect(() => {
    if (!enabled || !token || !accessId || !reading?.renditionId || typeof window === "undefined") return;
    const session = new ReadingSession({ token, accessId, renditionId: reading.renditionId, pageOrder: reading.pageOrder ?? [] });
    sessionRef.current = session;
    session.setPaused(pausedRef.current);
    session.start();
    return () => {
      session.stop();
      if (sessionRef.current === session) sessionRef.current = null;
    };
    // pageOrderKey stands for reading.pageOrder (a new array on every poll).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, token, accessId, renditionId, pageOrderKey]);

  // One stable host object: the CIM renderers keep it in context.
  return useMemo<CimReadingTracker>(() => ({
    onChartPoint: (pageId, blockKey, index) => sessionRef.current?.chartPoint(pageId, blockKey, index),
    onInteraction: (e) => sessionRef.current?.record(e.type, e.pageId, e.blockKey, e.detail),
    record: (type, pageId, blockKey, detail) => sessionRef.current?.record(type, pageId ?? null, blockKey, detail),
    currentPageId: () => sessionRef.current?.currentPageId() ?? null,
    renditionId: () => sessionRef.current?.renditionId ?? null,
  }), []);
}

// ── The session (plain class: no React state, nothing re-renders) ──────────

const TICK_MS = 1_000;
const SAVE_EVERY_MS = 5_000;
const RETRY_MS = [15_000, 30_000, 60_000];
const MAX_PENDING_EVENTS = 300;
const BEACON_MAX_BYTES = 60_000;
const BLOCKS_PER_CHUNK = 300;
const POINTER_RECENT_MS = 3_000;
const LONG_PARAGRAPH_WORDS = 120;

interface Stored {
  v: 1;
  visitId: string;
  renditionId: string;
  savedAt: number;
  /** Last second the buyer was actively reading (absent in older saves). */
  lastActiveAt?: number;
  snap: AllocatorSnapshot;
  acked: Array<[string, BlockCounters]>;
  ackedPathLen: number;
  ackedClocks: VisitClocks | null;
  seq: number;
  pending: ReadingInteraction[];
}

function uuid(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch { /* insecure context */ }
  const b = new Uint8Array(16);
  try { crypto.getRandomValues(b); } catch { for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256); }
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const toRect = (r: DOMRect): Rect => ({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });

/**
 * The page an interaction is recorded on: the one given, else the page being
 * read, else the first page — so an interaction without a page of its own
 * (vdr_open from the data-room drawer, print, chat) always carries a valid
 * page id. null when none of them is a valid id (nothing is recorded).
 */
export function interactionPageId(given: string | null | undefined, current: string | null | undefined, pageOrder: readonly string[]): string | null {
  const page = given ?? current ?? pageOrder[0];
  return page && ID_RE.test(page) ? page : null;
}
const sameCounters = (a: BlockCounters | undefined, b: BlockCounters) => !!a && a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

class ReadingSession {
  readonly renditionId: string;
  private readonly token: string;
  private readonly accessId: string;
  private readonly pageOrder: string[];
  private readonly storeKey: string;
  private visitId = "";
  private alloc!: ReadingAllocator;
  private acked = new Map<string, BlockCounters>();
  private ackedPathLen = 0;
  private ackedClocks: VisitClocks | null = null;
  private seq = 0;
  private pending: ReadingInteraction[] = [];

  private stopped = false;
  private paused = false;           // the buyer is in the data room drawer: seconds count as away
  private dead = false;             // the server said this link is gone: stop sending
  private inflight = false;
  private failures = 0;
  private nextFlushAt = 0;
  private lastTickAt = 0;
  private lastSaveAt = 0;
  /** When this visit last accrued active time (a gap of 30 min starts a new visit). */
  private lastActiveAt = Date.now();
  private lastSheetTop: number | null = null;

  private lastInputAt = Date.now();
  private lastPointerAt = 0;
  private pointerXY: { x: number; y: number } | null = null;
  private chartHover: { pageId: string; key: string; at: number } | null = null;

  private io: IntersectionObserver | null = null;
  private mo: MutationObserver | null = null;
  private moTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private readonly observed = new Set<Element>();
  private readonly near = new Set<Element>();
  private bc: BroadcastChannel | null = null;
  private readonly tabId = uuid();
  private readonly peers = new Map<string, PeerBeat>();
  private readonly off: Array<() => void> = [];

  constructor(o: { token: string; accessId: string; renditionId: string; pageOrder: string[] }) {
    this.token = o.token;
    this.accessId = o.accessId;
    this.renditionId = o.renditionId;
    this.pageOrder = o.pageOrder.filter((p) => ID_RE.test(p));
    this.storeKey = `cimple-visit-${o.accessId}`;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────

  start(): void {
    this.restoreOrBegin();
    const doc = document;
    const input = () => { this.lastInputAt = Date.now(); };
    const opts: AddEventListenerOptions = { capture: true, passive: true };
    for (const t of ["scroll", "wheel", "pointerdown", "keydown", "touchstart", "touchmove"]) {
      doc.addEventListener(t, input, opts);
      this.off.push(() => doc.removeEventListener(t, input, opts));
    }
    const sel = () => input();
    doc.addEventListener("selectionchange", sel);
    this.off.push(() => doc.removeEventListener("selectionchange", sel));
    const move = (e: PointerEvent) => {
      const p = this.pointerXY;
      if (p && Math.abs(e.clientX - p.x) < 4 && Math.abs(e.clientY - p.y) < 4) return;
      this.pointerXY = { x: e.clientX, y: e.clientY };
      this.lastPointerAt = this.lastInputAt = Date.now();
    };
    doc.addEventListener("pointermove", move, opts);
    this.off.push(() => doc.removeEventListener("pointermove", move, opts));
    const copy = () => {
      input();
      const node = window.getSelection?.()?.anchorNode ?? null;
      const el = node instanceof Element ? node : node?.parentElement ?? null;
      const page = el?.closest(`[${CIM_PAGE_ATTR}]`);
      if (page) this.record("copy", page.getAttribute(CIM_PAGE_ATTR), el?.closest(`[${CIM_BLOCK_ATTR}]`)?.getAttribute(CIM_BLOCK_ATTR) ?? undefined);
    };
    doc.addEventListener("copy", copy, true);
    this.off.push(() => doc.removeEventListener("copy", copy, true));
    const click = (e: MouseEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      const locked = t?.closest(`[${CIM_BLOCK_ATTR}="locked"]`);
      if (locked) this.record("locked_click", locked.closest(`[${CIM_PAGE_ATTR}]`)?.getAttribute(CIM_PAGE_ATTR) ?? null, "locked");
    };
    doc.addEventListener("click", click, true);
    this.off.push(() => doc.removeEventListener("click", click, true));
    const vis = () => {
      if (doc.visibilityState === "hidden") { this.save(); this.flush("beacon"); }
    };
    doc.addEventListener("visibilitychange", vis);
    this.off.push(() => doc.removeEventListener("visibilitychange", vis));
    const hide = () => { this.save(); this.flush("beacon"); };
    window.addEventListener("pagehide", hide);
    this.off.push(() => window.removeEventListener("pagehide", hide));
    const print = () => this.record("print_attempt", null);
    window.addEventListener("beforeprint", print);
    this.off.push(() => window.removeEventListener("beforeprint", print));

    try {
      this.bc = new BroadcastChannel(`cimple-view-${this.accessId}`);
      this.bc.onmessage = (m: MessageEvent) => {
        const d = m.data as { tab?: string; bye?: boolean; focused?: boolean; pointerAt?: number } | null;
        if (!d?.tab || d.tab === this.tabId) return;
        if (d.bye) this.peers.delete(d.tab);
        else this.peers.set(d.tab, { at: Date.now(), focused: !!d.focused, pointerAt: Number(d.pointerAt) || 0 });
      };
    } catch { this.bc = null; }

    try {
      this.io = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (e.isIntersecting) this.near.add(e.target);
          else this.near.delete(e.target);
        }
      }, { rootMargin: "50% 0px 50% 0px" });
      this.mo = new MutationObserver(() => {
        if (this.moTimer) clearTimeout(this.moTimer);
        this.moTimer = setTimeout(() => this.scan(), 300);
      });
      this.mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: [CIM_BLOCK_ATTR, CIM_PAGE_ATTR, "class"] });
    } catch { /* very old browser: no tracking */ }
    this.scan();

    this.lastTickAt = Date.now();
    this.nextFlushAt = this.lastTickAt + READING_RULES.flushEveryMs;
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.stopped) return;
    this.tick();
    this.stopped = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.moTimer) clearTimeout(this.moTimer);
    this.io?.disconnect();
    this.mo?.disconnect();
    this.io = null;
    this.mo = null;
    this.observed.clear();
    this.near.clear();
    for (const f of this.off.splice(0)) f();
    try { this.bc?.postMessage({ tab: this.tabId, bye: true }); this.bc?.close(); } catch { /* closed */ }
    this.save();
    this.flush("beacon");
  }

  private restoreOrBegin(): void {
    let stored: Stored | null = null;
    try {
      const raw = window.sessionStorage.getItem(this.storeKey);
      stored = raw ? (JSON.parse(raw) as Stored) : null;
    } catch { stored = null; }
    const lastActive = typeof stored?.lastActiveAt === "number" ? stored.lastActiveAt : stored?.savedAt ?? 0;
    if (stored && stored.v === 1 && stored.renditionId === this.renditionId && Date.now() - stored.savedAt < READING_RULES.visitGapMs
      && Date.now() - lastActive < READING_RULES.visitGapMs && typeof stored.visitId === "string") {
      this.visitId = stored.visitId;
      this.lastActiveAt = lastActive;
      this.alloc = new ReadingAllocator(this.pageOrder, stored.snap);
      this.acked = new Map(stored.acked ?? []);
      this.ackedPathLen = stored.ackedPathLen ?? 0;
      this.ackedClocks = stored.ackedClocks ?? null;
      this.seq = stored.seq ?? 0;
      this.pending = Array.isArray(stored.pending) ? stored.pending.slice(-MAX_PENDING_EVENTS) : [];
      return;
    }
    this.beginVisit();
  }

  private beginVisit(): void {
    this.visitId = uuid();
    this.lastActiveAt = Date.now();
    this.alloc = new ReadingAllocator(this.pageOrder);
    this.acked = new Map();
    this.ackedPathLen = 0;
    this.ackedClocks = null;
    this.seq = 0;
    this.pending = [];
  }

  private save(): void {
    this.lastSaveAt = Date.now();
    try {
      const s: Stored = {
        v: 1, visitId: this.visitId, renditionId: this.renditionId, savedAt: this.lastSaveAt, lastActiveAt: this.lastActiveAt,
        snap: this.alloc.snapshot(), acked: Array.from(this.acked.entries()), ackedPathLen: this.ackedPathLen,
        ackedClocks: this.ackedClocks, seq: this.seq, pending: this.pending,
      };
      window.sessionStorage.setItem(this.storeKey, JSON.stringify(s));
    } catch { /* private mode / quota: resume just won't happen */ }
  }

  // ── host callbacks ────────────────────────────────────────────────────

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  currentPageId(): string | null {
    return this.alloc?.currentPageId() ?? null;
  }

  chartPoint(pageId: string, key: string, index: number | null): void {
    this.lastInputAt = this.lastPointerAt = Date.now();
    this.chartHover = index == null ? null : { pageId, key, at: Date.now() };
  }

  record(type: ReadingInteractionType, pageId: string | null, blockKey?: string, detail?: string): void {
    if (this.stopped) return;
    const page = interactionPageId(pageId, this.currentPageId(), this.pageOrder);
    if (!page) return;
    this.lastInputAt = Date.now();
    this.pending.push({
      seq: ++this.seq,
      type,
      pageId: page,
      ...(blockKey ? { blockKey } : {}),
      ...(detail ? { detail: detail.slice(0, 80) } : {}),
      at: new Date().toISOString(),
    });
    if (this.pending.length > MAX_PENDING_EVENTS) this.pending.splice(0, this.pending.length - MAX_PENDING_EVENTS);
  }

  // ── measuring ─────────────────────────────────────────────────────────

  /** Observe every page and part element (new ones after a late render); forget removed ones. */
  private scan(): void {
    if (!this.io || this.stopped) return;
    const found = new Set<Element>(Array.from(document.querySelectorAll(`[${CIM_BLOCK_ATTR}],[${CIM_PAGE_ATTR}]`)));
    this.observed.forEach((el) => {
      if (!found.has(el)) { this.io!.unobserve(el); this.observed.delete(el); this.near.delete(el); }
    });
    found.forEach((el) => {
      if (!this.observed.has(el)) { this.io!.observe(el); this.observed.add(el); }
    });
  }

  private measure(now: number): Frame & { idleLimitMs: number } {
    const empty = { band: null, pages: [], blocks: [], scrollDelta: 0, pointer: null, idleLimitMs: ACTIVITY_RULES.idleMs };
    const sheet = document.querySelector(`[${READING_SHEET_ATTR}]`);
    if (!sheet) return { state: "active", ...empty };
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const sr = sheet.getBoundingClientRect();
    const scrollDelta = this.lastSheetTop == null ? 0 : Math.abs(sr.top - this.lastSheetTop);
    this.lastSheetTop = sr.top;
    let chromeBottom = 0;
    document.querySelectorAll(`[${READING_CHROME_ATTR}]`).forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.height <= 0 || r.bottom <= 0 || r.top > vh / 2) return;
      const cs = window.getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) < 0.1) return;
      chromeBottom = Math.max(chromeBottom, r.bottom);
    });
    const band: Rect = { top: chromeBottom, bottom: vh * 0.8, left: Math.max(0, sr.left), right: Math.min(vw, sr.right) };

    // Read every rect first, then compute (no layout thrash).
    const pagesById = new Map<string, Rect>();
    const blocks: FrameBlock[] = [];
    const elements: Array<[Element, DOMRect]> = [];
    this.near.forEach((el) => { if (el.isConnected) elements.push([el, el.getBoundingClientRect()]); });
    let middle: { key: string; el: Element } | null = null;
    const midY = (band.top + band.bottom) / 2;
    for (const [el, r] of elements) {
      if (r.width <= 0 || r.height <= 0) continue;
      const rect = toRect(r);
      const ownPage = el.getAttribute(CIM_PAGE_ATTR);
      if (ownPage && ID_RE.test(ownPage)) {
        const prev = pagesById.get(ownPage);
        if (!prev || (rect.bottom - rect.top) * (rect.right - rect.left) > (prev.bottom - prev.top) * (prev.right - prev.left)) pagesById.set(ownPage, rect);
      }
      const key = el.getAttribute(CIM_BLOCK_ATTR);
      if (key) {
        const pageId = el.closest(`[${CIM_PAGE_ATTR}]`)?.getAttribute(CIM_PAGE_ATTR);
        if (pageId && ID_RE.test(pageId)) {
          blocks.push({ pageId, key, rect });
          if (rect.top <= midY && rect.bottom >= midY && (!middle || key.length >= middle.key.length)) middle = { key, el };
        }
      }
    }

    // A long table or paragraph earns a longer idle allowance.
    let idleLimitMs: number = ACTIVITY_RULES.idleMs;
    if (middle) {
      const leaf = middle.key.split("/").pop() ?? "";
      if (/^(row|nrow|head|foot)(:|$)/.test(leaf)) idleLimitMs = ACTIVITY_RULES.idleLongMs;
      else if (/^(para|intro|desc)(:|$)/.test(leaf) && (middle.el.textContent ?? "").trim().split(/\s+/).length >= LONG_PARAGRAPH_WORDS) idleLimitMs = ACTIVITY_RULES.idleLongMs;
    }

    // The part under a pointer that moved in the last 3 s over the sheet.
    let pointer: Frame["pointer"] = null;
    const p = this.pointerXY;
    if (p && now - this.lastPointerAt <= POINTER_RECENT_MS && p.x >= sr.left && p.x <= sr.right && p.y >= sr.top && p.y <= sr.bottom) {
      const hit = document.elementFromPoint(p.x, p.y);
      const pageEl = hit?.closest(`[${CIM_PAGE_ATTR}]`);
      const pageId = pageEl?.getAttribute(CIM_PAGE_ATTR);
      if (pageEl && pageId && ID_RE.test(pageId)) {
        const blockEl = hit?.closest(`[${CIM_BLOCK_ATTR}]`);
        const key = blockEl && pageEl.contains(blockEl) ? blockEl.getAttribute(CIM_BLOCK_ATTR) ?? "" : "";
        const h = this.chartHover;
        const pointKey = h && now - h.at <= POINTER_RECENT_MS && h.pageId === pageId && chartOfPoint(h.key) === key ? h.key : undefined;
        pointer = { pageId, key, ...(pointKey ? { pointKey } : {}) };
      }
    }

    return {
      state: "active",
      band,
      pages: Array.from(pagesById.entries()).map(([pageId, rect]) => ({ pageId, rect })),
      blocks,
      scrollDelta,
      pointer,
      idleLimitMs,
    };
  }

  private tick(): void {
    if (this.stopped || !this.alloc) return;
    const now = Date.now();
    const dt = now - this.lastTickAt;
    this.lastTickAt = now;
    const visible = document.visibilityState === "visible";
    let frame: Frame & { idleLimitMs?: number } = { state: "hidden", band: null, pages: [], blocks: [], scrollDelta: 0, pointer: null };
    if (visible) {
      const measured = this.measure(now);
      // Drop peers that stopped beating.
      this.peers.forEach((b, tab) => { if (now - b.at > ACTIVITY_RULES.peerStaleMs * 4) this.peers.delete(tab); });
      const state = activityState({
        now, visible, focused: document.hasFocus(), lastInputAt: this.lastInputAt, lastPointerAt: this.lastPointerAt,
        idleLimitMs: measured.idleLimitMs, peers: Array.from(this.peers.values()), paused: this.paused,
      });
      frame = { ...measured, state };
    }
    // Back after 30+ minutes without reading (a tab left open): send the old
    // visit as it stands and start a new one before this second counts.
    if (frame.state === "active" && this.alloc.clocks.activeMs > 0 && now - this.lastActiveAt >= READING_RULES.visitGapMs) {
      this.rotateVisit();
    }
    const activeBefore = this.alloc.clocks.activeMs;
    this.alloc.tick(dt, frame);
    if (this.alloc.clocks.activeMs > activeBefore) this.lastActiveAt = now;
    try { this.bc?.postMessage({ tab: this.tabId, focused: document.hasFocus(), pointerAt: this.lastPointerAt }); } catch { /* closed */ }
    if (now - this.lastSaveAt >= SAVE_EVERY_MS) this.save();
    // Send every 15 s while the buyer reads (or has something new to report).
    if (now >= this.nextFlushAt && this.hasUnsent("fetch")) void this.flush("fetch");
  }

  // ── sending ───────────────────────────────────────────────────────────

  /** The visit so far goes out (a beacon), and a fresh visit begins. */
  private rotateVisit(): void {
    this.flush("beacon");
    this.beginVisit();
    this.save();
  }

  /**
   * Anything the server doesn't have yet. A periodic send ("fetch") only
   * goes for reading, parts, path or clicks — idle and hidden seconds alone
   * never cause one; the beacon on hide/close also carries those clocks.
   */
  private hasUnsent(mode: "fetch" | "beacon" = "fetch"): boolean {
    if (this.pending.length > 0 || this.alloc.path.length > this.ackedPathLen) return true;
    const c = this.alloc.roundedClocks();
    const a = this.ackedClocks;
    if (!a) return c.activeMs > 0 || (mode === "beacon" && c.wallMs > 0);
    if (a.activeMs !== c.activeMs) return true;
    if (mode === "beacon" && a.wallMs !== c.wallMs) return true;
    const blocks = this.alloc.roundedBlocks();
    let changed = false;
    blocks.forEach((v, k) => { if (!changed && !sameCounters(this.acked.get(k), v)) changed = true; });
    return changed;
  }

  /** The payloads to send now (blocks split into chunks; path and events ride on the first). */
  private payloads(): ReadingPayload[] {
    const clocks = this.alloc.roundedClocks();
    const changed: Array<[string, BlockCounters]> = [];
    this.alloc.roundedBlocks().forEach((v, k) => {
      if (!sameCounters(this.acked.get(k), v) && (v[0] || v[1] || v[2] || v[3])) changed.push([k, v]);
    });
    const base = {
      visitId: this.visitId,
      renditionId: this.renditionId,
      sentAt: new Date().toISOString(),
      device: {
        w: Math.round(window.innerWidth), h: Math.round(window.innerHeight),
        touch: (navigator.maxTouchPoints ?? 0) > 0 || !!window.matchMedia?.("(pointer: coarse)").matches,
        dpr: Math.min(10, window.devicePixelRatio || 1),
      },
      visit: { ...clocks, maxPageIndex: this.alloc.maxPageIndex },
    };
    const chunks: Array<Array<[string, BlockCounters]>> = [];
    for (let i = 0; i < changed.length; i += BLOCKS_PER_CHUNK) chunks.push(changed.slice(i, i + BLOCKS_PER_CHUNK));
    if (chunks.length === 0) chunks.push([]);
    const from = Math.min(this.ackedPathLen, this.alloc.path.length);
    return chunks.map((c, i) => ({
      ...base,
      blocks: Object.fromEntries(c),
      path: i === 0 ? { from, entries: this.alloc.path.slice(from, from + READING_RULES.maxPathEntries) } : { from: this.alloc.path.length, entries: [] },
      events: i === 0 ? this.pending.slice(0, READING_RULES.maxEvents) : [],
    }));
  }

  private ack(p: ReadingPayload): void {
    for (const [k, v] of Object.entries(p.blocks)) this.acked.set(k, v);
    this.ackedPathLen = Math.max(this.ackedPathLen, p.path.from + p.path.entries.length);
    const sent = new Set(p.events.map((e) => e.seq));
    this.pending = this.pending.filter((e) => !sent.has(e.seq));
    const { maxPageIndex: _m, ...clocks } = p.visit;
    this.ackedClocks = clocks;
  }

  private url(): string {
    return `/api/view/${encodeURIComponent(this.token)}/reading`;
  }

  async flush(mode: "fetch" | "beacon"): Promise<void> {
    if (this.dead || !this.alloc) return;
    if (!this.hasUnsent(mode)) return;
    const payloads = this.payloads();
    if (mode === "beacon") {
      // The page is going away: fire and forget (a later send repeats it harmlessly).
      for (const p of payloads) {
        const body = JSON.stringify(p);
        let sent = false;
        try {
          if (body.length <= BEACON_MAX_BYTES && typeof navigator.sendBeacon === "function") {
            sent = navigator.sendBeacon(this.url(), new Blob([body], { type: "text/plain" }));
          }
        } catch { sent = false; }
        if (!sent) {
          try { void fetch(this.url(), { method: "POST", headers: { "content-type": "text/plain" }, body, keepalive: body.length <= BEACON_MAX_BYTES }).catch(() => {}); } catch { /* gone */ }
        }
      }
      return;
    }
    if (this.inflight) return;
    this.inflight = true;
    this.nextFlushAt = Date.now() + READING_RULES.flushEveryMs;
    try {
      for (const p of payloads) {
        const res = await fetch(this.url(), { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify(p), keepalive: true });
        if (res.ok) { this.ack(p); continue; }
        if (res.status === 409) {
          // This visit id belongs to someone else (a copied session): start over.
          this.beginVisit();
          this.save();
          return;
        }
        if (res.status === 404 || res.status === 403) { this.dead = true; return; }
        if (res.status >= 400 && res.status < 500 && res.status !== 429) { this.ack(p); continue; } // refused: don't loop on it
        throw new Error(`reading ${res.status}`);
      }
      this.failures = 0;
    } catch {
      this.failures += 1;
      this.nextFlushAt = Date.now() + RETRY_MS[Math.min(this.failures - 1, RETRY_MS.length - 1)];
    } finally {
      this.inflight = false;
    }
  }
}
