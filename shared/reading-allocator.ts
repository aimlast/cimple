/**
 * reading-allocator — turns what is on a buyer's screen, second by second,
 * into reading time per page part (shared/analytics-v2.ts BlockCounters).
 * Pure: no DOM, no clock. The view room's tracker (client/src/lib/cim-reading.ts)
 * measures a Frame once a second and calls `tick`; the unit tests drive the
 * same class with synthetic frames.
 *
 * The model (final spec §3.2):
 *   - Time only counts while the buyer is ACTIVE: tab visible, window in
 *     front (or the pointer moving over it), some input in the last minute.
 *     Hidden / away / idle seconds go to their own clocks and credit nothing.
 *   - The READING BAND is where eyes are: from under the sticky chrome to
 *     80% of the viewport height, across the CIM sheet. Each second is
 *     shared between the parts inside the band by how much of the band each
 *     one covers (vertical × horizontal, so side-by-side columns split).
 *     Nested parts credit the innermost: a container (a two-column side, a
 *     list) passes the band area it covers between its children on to
 *     those children, in proportion to their size, and so does a page for
 *     the margins between its parts — so the gaps between six small KPI
 *     items count for the items, not for a container nobody can see. Only
 *     band area on a page with none of its parts on screen stays on the
 *     page itself (block key "").
 *   - A pointer that moved in the last 3 s over the sheet pulls 30% of the
 *     second onto the part under it, and its hover time is kept separately
 *     (pointerMs — chart points live only there).
 *   - Scrolling fast is skimming: attention keeps 100% / 60% / 25% of the
 *     time under 0.6 / 1.5 / faster band-heights per second, the rest is skim.
 *   - A part is VISIBLE while ≥ 50% of it is in the band, or it fills ≥ 50%
 *     of the band — so a table taller than the screen still counts.
 *   - The dominant page (largest share) enters the PATH once it has held
 *     for 2 s of active time.
 *
 * Invariant (tested): Σ(attention + skim) + outside = active ≤ wall, where
 * wall = active + idle + hidden + away.
 *
 * The 6-hour ceiling applies to ACTIVE time: a tab left open on screen all
 * day keeps its idle/hidden clocks running and still records the afternoon's
 * reading (the tracker also starts a new visit after 30 idle minutes).
 */
import { READING_RULES, blockId, type BlockCounters } from "./analytics-v2";

export interface Rect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export type ActivityState = "active" | "idle" | "hidden" | "away";

/** One [data-cim-block] element on screen. `key` "" = a page element itself. */
export interface FrameBlock {
  pageId: string;
  key: string;
  rect: Rect;
}

/** What the tracker measured this second. */
export interface Frame {
  state: ActivityState;
  /** The reading band, or null when there is none (no sheet on screen). */
  band: Rect | null;
  /** The outermost element of each page on screen. */
  pages: Array<{ pageId: string; rect: Rect }>;
  /** Every measured part on (or near) the screen, with its page. */
  blocks: FrameBlock[];
  /** Pixels the sheet moved since the previous frame (either direction). */
  scrollDelta: number;
  /** The part under a pointer that moved in the last 3 s over the sheet; pointKey = the chart datum under it. */
  pointer: { pageId: string; key: string; pointKey?: string } | null;
}

export const ALLOCATOR_RULES = {
  /** A tick never credits more than this (a throttled tab, a laptop waking). */
  maxTickMs: 2_000,
  /** A band shorter than this (buyer on the decision panel, footer, chat) is "outside". */
  minBandPx: 80,
  /** The band must be at least this much CIM (else the second is "outside"). */
  minCoverage: 0.2,
  /** The dominant page enters the path after holding this long (active ms). */
  pathHoldMs: 2_000,
  /** Scroll speeds (band heights per second) and the attention kept below each. */
  skimSlow: 0.6,
  skimFast: 1.5,
  readFactors: [1, 0.6, 0.25] as const,
  /** Share of the second the pointer's part gets. */
  pointerBlend: 0.3,
  /** A part is visible with this share of itself in the band, or of the band covered by it. */
  visibleShare: 0.5,
  /** A page counts as reached with at least this share of a second. */
  reachShare: 0.1,
} as const;

export interface VisitClocks {
  wallMs: number;
  activeMs: number;
  idleMs: number;
  hiddenMs: number;
  awayMs: number;
  outsideMs: number;
}

/** Everything needed to resume a visit (sessionStorage) — plain JSON. */
export interface AllocatorSnapshot {
  clocks: VisitClocks;
  blocks: Array<[string, BlockCounters]>;
  path: Array<[number, string]>;
  maxPageIndex: number;
  dominant: string | null;
  dominantSinceActive: number;
}

const ZERO_CLOCKS: VisitClocks = { wallMs: 0, activeMs: 0, idleMs: 0, hiddenMs: 0, awayMs: 0, outsideMs: 0 };

function height(r: Rect): number {
  return Math.max(0, r.bottom - r.top);
}
function width(r: Rect): number {
  return Math.max(0, r.right - r.left);
}
function area(r: Rect): number {
  return height(r) * width(r);
}
/** Area of a ∩ b. */
export function overlapArea(a: Rect, b: Rect): number {
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  return h > 0 && w > 0 ? h * w : 0;
}

/** The share of the second attention keeps at this scroll speed. */
export function readFactor(scrollDeltaPx: number, bandHeightPx: number, dtMs: number): number {
  if (bandHeightPx <= 0 || dtMs <= 0) return 1;
  const v = Math.abs(scrollDeltaPx) / bandHeightPx / (dtMs / 1000);
  if (v < ALLOCATOR_RULES.skimSlow) return ALLOCATOR_RULES.readFactors[0];
  if (v < ALLOCATOR_RULES.skimFast) return ALLOCATOR_RULES.readFactors[1];
  return ALLOCATOR_RULES.readFactors[2];
}

/** The direct parent key of a nested key ("left/para:1" → "left"), "" for a top-level key. */
function parentKey(key: string): string {
  const i = key.lastIndexOf("/");
  return i === -1 ? "" : key.slice(0, i);
}

/**
 * How much of the band each part covers, innermost first: a part's own
 * share is its band area minus its direct children's; a page's own share
 * ("" key) is its band area minus its top-level parts'. Then every
 * container with children on screen hands its own share down to those
 * children in proportion to their band area (outermost first, so it
 * reaches the leaves): containers and page margins keep nothing while any
 * of their parts is on screen. Pure geometry. Returns blockId → band-area units.
 */
export function exclusiveAreas(frame: Pick<Frame, "pages" | "blocks">, band: Rect): Map<string, number> {
  const out = new Map<string, number>();
  const byPage = new Map<string, Map<string, number>>();
  for (const b of frame.blocks) {
    if (!b.key) continue;
    const a = overlapArea(b.rect, band);
    if (a <= 0) continue;
    const m = byPage.get(b.pageId) ?? new Map<string, number>();
    m.set(b.key, (m.get(b.key) ?? 0) + a);
    byPage.set(b.pageId, m);
  }
  const pageArea = new Map<string, number>();
  for (const p of frame.pages) {
    const a = overlapArea(p.rect, band);
    if (a > 0) pageArea.set(p.pageId, Math.max(pageArea.get(p.pageId) ?? 0, a));
  }
  const pageIds = new Set<string>([...Array.from(byPage.keys()), ...Array.from(pageArea.keys())]);
  pageIds.forEach((pageId) => {
    const blocks = byPage.get(pageId) ?? new Map<string, number>();
    // Children's areas, summed per parent ("" = the page).
    const childSum = new Map<string, number>();
    blocks.forEach((a, key) => {
      let parent = parentKey(key);
      // A missing parent element (not on screen / not measured): climb to the nearest present one.
      while (parent && !blocks.has(parent)) parent = parentKey(parent);
      childSum.set(parent, (childSum.get(parent) ?? 0) + a);
    });
    // Own (exclusive) area of every part, and of the page ("").
    const own = new Map<string, number>();
    const children = new Map<string, string[]>();
    blocks.forEach((a, key) => {
      own.set(key, Math.max(0, a - (childSum.get(key) ?? 0)));
      let parent = parentKey(key);
      while (parent && !blocks.has(parent)) parent = parentKey(parent);
      const list = children.get(parent) ?? [];
      list.push(key);
      children.set(parent, list);
    });
    own.set("", Math.max(0, (pageArea.get(pageId) ?? 0) - (childSum.get("") ?? 0)));
    // Hand each container's own area down to its children (outermost first).
    const depth = (k: string) => (k === "" ? -1 : k.split("/").length);
    const order = ["", ...Array.from(blocks.keys()).sort((x, y) => depth(x) - depth(y))];
    for (const key of order) {
      const kids = children.get(key);
      const mine = own.get(key) ?? 0;
      if (!kids || kids.length === 0 || mine <= 0) continue;
      const total = kids.reduce((s, k) => s + (blocks.get(k) ?? 0), 0);
      if (total <= 0) continue;
      for (const k of kids) own.set(k, (own.get(k) ?? 0) + mine * ((blocks.get(k) ?? 0) / total));
      own.set(key, 0);
    }
    own.forEach((a, key) => { if (a > 0) out.set(blockId(pageId, key), a); });
  });
  return out;
}

export class ReadingAllocator {
  clocks: VisitClocks;
  /** blockId → cumulative [attention, skim, visible, pointer] (fractional ms). */
  readonly blocks = new Map<string, BlockCounters>();
  path: Array<[number, string]>;
  maxPageIndex: number;
  private dominant: string | null;
  private dominantSinceActive: number;
  private readonly pageIndex: Map<string, number>;

  constructor(pageOrder: readonly string[], restore?: AllocatorSnapshot | null) {
    this.pageIndex = new Map(pageOrder.map((id, i) => [id, i]));
    this.clocks = { ...ZERO_CLOCKS, ...(restore?.clocks ?? {}) };
    for (const [k, v] of restore?.blocks ?? []) this.blocks.set(k, [v[0], v[1], v[2], v[3]]);
    this.path = restore?.path ? restore.path.map(([t, p]) => [t, p] as [number, string]) : [];
    this.maxPageIndex = restore?.maxPageIndex ?? -1;
    this.dominant = restore?.dominant ?? null;
    this.dominantSinceActive = restore?.dominantSinceActive ?? 0;
  }

  /** The page the buyer is reading now (the dominant page), or null. */
  currentPageId(): string | null {
    return this.dominant ?? (this.path.length ? this.path[this.path.length - 1][1] : null);
  }

  /** The visit reached its 6-hour ceiling of ACTIVE time: no more reading accrues (idle/hidden clocks still run). */
  get capped(): boolean {
    return this.clocks.activeMs >= READING_RULES.visitMaxMs;
  }

  private counters(id: string): BlockCounters {
    let c = this.blocks.get(id);
    if (!c) {
      c = [0, 0, 0, 0];
      this.blocks.set(id, c);
    }
    return c;
  }

  tick(dtRaw: number, frame: Frame): void {
    const dt = Math.max(0, Math.min(ALLOCATOR_RULES.maxTickMs, Number.isFinite(dtRaw) ? dtRaw : 0));
    if (dt === 0) return;
    // Past the ceiling an active second is simply not counted (wall stays = the sum of the clocks).
    if (frame.state === "active" && this.capped) return;
    this.clocks.wallMs += dt;
    if (frame.state !== "active") {
      if (frame.state === "idle") this.clocks.idleMs += dt;
      else if (frame.state === "hidden") this.clocks.hiddenMs += dt;
      else this.clocks.awayMs += dt;
      return;
    }
    const activeBefore = this.clocks.activeMs;
    this.clocks.activeMs += dt;

    const band = frame.band;
    const bandH = band ? height(band) : 0;
    if (!band || bandH < ALLOCATOR_RULES.minBandPx || width(band) <= 0) {
      this.clocks.outsideMs += dt;
      return;
    }
    const bandArea = area(band);
    const raw = exclusiveAreas(frame, band);
    let total = 0;
    raw.forEach((a) => { total += a; });
    if (total <= 0 || total / bandArea < ALLOCATOR_RULES.minCoverage) {
      this.clocks.outsideMs += dt;
      return;
    }

    // Shares of this second.
    const share = new Map<string, number>();
    raw.forEach((a, id) => share.set(id, a / total));
    if (frame.pointer) {
      const { pageId: pp, key: pk } = frame.pointer;
      const target = blockId(pp, pk);
      // A pointer resting in the gap of a container (between a list's items, a
      // page's margin) doesn't pull time onto the container: its parts already
      // share that area.
      const container = frame.blocks.some((b) => b.pageId === pp && (pk === "" ? !!b.key : b.key.startsWith(`${pk}/`)) && overlapArea(b.rect, band) > 0);
      if (!container) {
        const k = ALLOCATOR_RULES.pointerBlend;
        share.forEach((s, id) => share.set(id, s * (1 - k)));
        share.set(target, (share.get(target) ?? 0) + k);
      }
      this.counters(blockId(pp, frame.pointer.pointKey || pk))[3] += dt;
    }

    // Attention vs skim.
    const rf = readFactor(frame.scrollDelta, bandH, dt);
    share.forEach((s, id) => {
      const c = this.counters(id);
      c[0] += dt * s * rf;
      c[1] += dt * s * (1 - rf);
    });

    // Visible: ≥ 50% of the part in the band, or the part fills ≥ 50% of the band.
    const vis = ALLOCATOR_RULES.visibleShare;
    const seen = new Set<string>();
    const isVisible = (r: Rect) => {
      const inBand = overlapArea(r, band);
      const own = area(r);
      return inBand > 0 && ((own > 0 && inBand / own >= vis) || inBand / bandArea >= vis);
    };
    for (const b of frame.blocks) {
      const id = blockId(b.pageId, b.key);
      if (seen.has(id) || !isVisible(b.rect)) continue;
      seen.add(id);
      this.counters(id)[2] += dt;
    }
    for (const p of frame.pages) {
      const id = blockId(p.pageId, "");
      if (seen.has(id) || !isVisible(p.rect)) continue;
      seen.add(id);
      this.counters(id)[2] += dt;
    }

    // Dominant page, path and furthest page.
    const perPage = new Map<string, number>();
    share.forEach((s, id) => {
      const pageId = id.slice(0, id.indexOf("|"));
      perPage.set(pageId, (perPage.get(pageId) ?? 0) + s);
    });
    let top: string | null = null;
    let topShare = 0;
    perPage.forEach((s, pageId) => {
      if (s > topShare) { top = pageId; topShare = s; }
      const idx = this.pageIndex.get(pageId);
      if (idx !== undefined && s >= ALLOCATOR_RULES.reachShare && idx > this.maxPageIndex) this.maxPageIndex = idx;
    });
    if (top !== this.dominant) {
      this.dominant = top;
      this.dominantSinceActive = activeBefore;
    }
    const last = this.path.length ? this.path[this.path.length - 1][1] : null;
    if (this.dominant && this.dominant !== last && this.clocks.activeMs - this.dominantSinceActive >= ALLOCATOR_RULES.pathHoldMs
      && this.path.length < READING_RULES.maxPathEntries) {
      this.path.push([Math.floor(this.dominantSinceActive / 1000), this.dominant]);
    }
  }

  /** Σ(attention + skim) over every part. */
  creditedMs(): number {
    let s = 0;
    this.blocks.forEach((c) => { s += c[0] + c[1]; });
    return s;
  }

  snapshot(): AllocatorSnapshot {
    return {
      clocks: { ...this.clocks },
      blocks: Array.from(this.blocks.entries()).map(([k, v]) => [k, [v[0], v[1], v[2], v[3]]]),
      path: this.path.map(([t, p]) => [t, p]),
      maxPageIndex: this.maxPageIndex,
      dominant: this.dominant,
      dominantSinceActive: this.dominantSinceActive,
    };
  }

  /** Whole-ms counters for sending (floors keep Σ ≤ active). */
  roundedBlocks(): Map<string, BlockCounters> {
    const out = new Map<string, BlockCounters>();
    this.blocks.forEach((c, k) => out.set(k, [Math.floor(c[0]), Math.floor(c[1]), Math.floor(c[2]), Math.floor(c[3])]));
    return out;
  }

  roundedClocks(): VisitClocks {
    const c = this.clocks;
    return {
      wallMs: Math.floor(c.wallMs), activeMs: Math.floor(c.activeMs), idleMs: Math.floor(c.idleMs),
      hiddenMs: Math.floor(c.hiddenMs), awayMs: Math.floor(c.awayMs), outsideMs: Math.floor(c.outsideMs),
    };
  }
}

// ── Activity state + tab election ─────────────────────────────────────────

export interface PeerBeat {
  /** When this peer tab last reported (ms). */
  at: number;
  focused: boolean;
  /** Its last pointer movement over the page (ms), 0 = never. */
  pointerAt: number;
}

export interface ActivityInput {
  now: number;
  visible: boolean;
  focused: boolean;
  lastInputAt: number;
  lastPointerAt: number;
  /** 60 s, or 90 s while the dominant part is a table or a long paragraph. */
  idleLimitMs: number;
  /** Other tabs of the same buyer link (BroadcastChannel beats). */
  peers: PeerBeat[];
  /**
   * The reader has stepped out of the CIM inside the view room (the data
   * room's document drawer is open over it): those seconds are AWAY, never
   * reading — so the visit's reading time stops growing and it leaves
   * "Reading now" within 90 s (buyer_visits.last_seen_at moves only with
   * active time).
   */
  paused?: boolean;
}

export const ACTIVITY_RULES = {
  idleMs: 60_000,
  idleLongMs: 90_000,
  /** An unfocused window counts only while the pointer moved over it this recently. */
  awayPointerMs: 10_000,
  /** "Pointer is moving over it now" for tab election. */
  pointerNowMs: 3_000,
  /** A peer beat older than this is ignored (tab closed / frozen). */
  peerStaleMs: 2_500,
} as const;

/**
 * hidden / away / idle / active for this tab, with tab election: only one
 * tab of the same buyer accrues. The focused tab accrues unless another tab
 * is being pointed at right now and this one isn't; a visible unfocused tab
 * accrues only while the pointer moves over it, and never while a focused
 * tab is also being used.
 */
export function activityState(i: ActivityInput): ActivityState {
  if (!i.visible) return "hidden";
  if (i.paused) return "away";
  const R = ACTIVITY_RULES;
  const myPointerNow = i.now - i.lastPointerAt <= R.pointerNowMs;
  const live = i.peers.filter((p) => i.now - p.at <= R.peerStaleMs);
  const peerPointerNow = live.some((p) => i.now - p.pointerAt <= R.pointerNowMs);
  if (i.focused) {
    if (peerPointerNow && !myPointerNow) return "away";
  } else {
    if (i.now - i.lastPointerAt > R.awayPointerMs) return "away";
    const focusedPeerInUse = live.some((p) => p.focused && (i.now - p.pointerAt <= R.pointerNowMs || !myPointerNow));
    if (focusedPeerInUse) return "away";
  }
  if (i.now - i.lastInputAt > i.idleLimitMs) return "idle";
  return "active";
}
