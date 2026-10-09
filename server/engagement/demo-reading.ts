/**
 * Sample reading for the fictional example deals (heat-map spec §5.6). Pure:
 * no DB, no AI, no network. scripts/seed-demo-reading.ts loads the inputs and
 * writes the plan; tests run it on fixtures.
 *
 * The example deals' buyers were recorded by the OLD tracker: one total per
 * page per visit, never which parts of a page they read — so the heat map
 * could only shade whole pages. This planner turns each of those old visits
 * into one sample visit with part-by-part reading on the version the buyer's
 * access level is served, so the founder sees what the heat map does:
 *
 *   - every page's time is kept EXACTLY (the old page total = the sum of
 *     its parts' reading time + a small "elsewhere on the page" remainder),
 *     so every number the Buyers view and the call list already show stays
 *     the same (reading time, studied/read/glanced, intent, "only skimmed");
 *     skim time (scrolled past) is added on top in the spec's proportions;
 *   - how a buyer reads is shaped by a reading depth (time, decision,
 *     visits): strong buyers dwell on the numbers and read further down a
 *     page, weak ones read the top and scroll past the rest;
 *   - one device and one network key per buyer (so "opened from several
 *     places" can never fire), and only two kinds of interaction: jumps in
 *     the contents (`nav`) and opening a collapsed section (`expand`) — no
 *     event that would invent a broker call signal (locked pages, the
 *     normalised figures, maps, copy, print, contact, chat, video);
 *   - deterministic (mulberry32 seeded per visit and page) and idempotent
 *     (stable ids); everything is tagged with the seed tag and removable.
 *
 * Real deals are never seeded: refuseReason() refuses anything that isn't a
 * fictional example deal owned by broker_demo or qa_cimgen.
 */
import { createHash } from "crypto";
import { sql, type SQL } from "drizzle-orm";
import type { CimMode, RenditionBlock, RenditionPage } from "@shared/analytics-v2";
import { chartOfPoint } from "@shared/cim-blocks";
import { cimModeForAccessLevel } from "@shared/cim-layouts";
import { stableUuid } from "./legacy";

export const DEMO_READING_TAG = "demo-reading-v1";

/** The only accounts whose example deals may get sample reading. */
export const DEMO_SEED_OWNERS: ReadonlySet<string> = new Set(["broker_demo", "qa_cimgen"]);
/** Real (or real-data test) deals, refused by id whatever their flags say. */
export const REAL_DEAL_IDS: ReadonlySet<string> = new Set([
  "216f9bee-6bf3-4b51-8f51-bc42bbf69c83", // Amlin Contracting Ltd.
  "d8175edb-eec7-4d26-be00-f6ccfe090820", // Amlin Contracting Ltd.
  "39cf1c4b-3a5c-41da-91e6-4e938c90b47e", // TEST_Amlin Contracting Ltd.
  "b9589b84-39ab-49a9-b894-0e9dbfc1bcf5", // TEST_Amlin Contracting Ltd.
  "a759e5a7-a6e9-4d67-b847-ae092ba65205", // SariKnotSari
  "d85a5d1e-9356-4ba5-bd6a-87da101182a5", // 180 Smoke Vape
]);
const REAL_DEAL_NAME_RE = /amlin|sariknotsari|180 smoke/i;

/**
 * What a buyer at this access level READS, in the new access names (the
 * dry run's "Sees" column and version list): "Blind CIM", "Full CIM" or
 * "Due diligence" — by the version served, never the old key's name (the
 * old `full` is the blind CIM with every section unlocked: "Blind CIM", not
 * "Full CIM"; the old `loi` is the named one: "Full CIM"). A buyer on the old
 * teaser (blind, some sections locked) reads "Blind CIM (old teaser)".
 */
export function seesLabel(level: string | null | undefined): string {
  const mode = cimModeForAccessLevel(level);
  if (mode === "dd") return "Due diligence";
  if (mode === "normal") return "Full CIM";
  return level === "teaser" ? "Blind CIM (old teaser)" : "Blind CIM";
}

// ── Inputs and outputs ───────────────────────────────────────────────────

export interface DemoBuyer {
  id: string;
  name: string;
  buyerType: string | null;
  accessLevel: string;
  decision: string | null;
  email: string;
}

export interface DemoOldVisit {
  id: string;
  accessId: string;
  startedAt: Date;
  lastSeenAt: Date;
  wallMs: number;
  activeMs: number;
  path: Array<[number, string]>;
}

export interface DemoOldPage {
  visitId: string;
  accessId: string;
  pageId: string;
  lineageId: string | null;
  attentionMs: number;
}

export interface DemoServed {
  renditionId: string;
  pages: RenditionPage[];
}

export interface DemoInput {
  tag: string;
  deal: { id: string; demoKey: string | null; businessName: string };
  buyers: DemoBuyer[];
  /** The old visits (stored legacy visits, or the ones storing would write). */
  visits: DemoOldVisit[];
  /** Their page totals (old key or section id as page id, lineage when stored). */
  pages: DemoOldPage[];
  /** Per access level: the version that level is served (renditionId + page index), or null. */
  served: Record<string, DemoServed | null>;
  /** An old page → the page of that level's version it is (null: not on that version). */
  place(level: string, pageId: string, lineageId: string | null): RenditionPage | null;
}

export interface DemoVisitRow {
  id: string;
  /** The old visit it replaces (hidden while the sample is in place). */
  legacyVisitId: string;
  dealId: string;
  accessId: string;
  renditionId: string;
  mode: CimMode;
  accessLevel: string;
  deviceClass: "desktop" | "phone";
  viewportW: number;
  viewportH: number;
  uaFamily: string;
  ipHash: string;
  startedAt: Date;
  lastSeenAt: Date;
  wallMs: number;
  activeMs: number;
  idleMs: number;
  maxPageIndex: number | null;
  path: Array<[number, string]>;
  demoSeed: string;
}

export interface DemoRollupRow {
  visitId: string;
  dealId: string;
  accessId: string;
  pageId: string;
  blockKey: string;
  /** Null only for old time on a page the version doesn't have (kept as earlier reading). */
  renditionId: string | null;
  lineageId: string | null;
  attentionMs: number;
  skimMs: number;
  visibleMs: number;
  pointerMs: number;
  firstAt: Date;
  lastAt: Date;
}

export interface DemoEventRow {
  dealId: string;
  visitId: string;
  accessId: string;
  renditionId: string;
  type: "nav" | "expand";
  pageId: string;
  blockKey: null;
  detail: string | null;
  seq: number;
  at: Date;
}

export interface DemoPlan {
  renditions: Array<{ level: string; renditionId: string }>;
  visits: DemoVisitRow[];
  rollups: DemoRollupRow[];
  events: DemoEventRow[];
  /** Old visit ids to hide while the sample reading is in place. */
  supersede: string[];
  skipped: Array<{ accessId: string; why: string }>;
  /** Old time on pages no version of the buyer's level has (kept on the sample visit as earlier reading). */
  unplaced: Array<{ key: string; ms: number; visits: number }>;
  perBuyer: Array<{
    accessId: string; name: string; level: string; depth: number; visits: number; pages: number; minutes: number; partRows: number;
    device: string;
  }>;
}

// ── Reading model ────────────────────────────────────────────────────────

const DECISION_WEIGHT: Record<string, number> = { interested: 0.85, not_interested: 0.15 };
/** Interested .85, passed .15, anything else (undecided, need more time, lapsed) .5. */
export function decisionWeight(decision: string | null | undefined): number {
  return DECISION_WEIGHT[decision ?? ""] ?? 0.5;
}

/**
 * How deeply a buyer reads, 0–1: 0.5·rank of their total reading time
 * among the deal's readers + 0.3·decision + 0.2·min(1, visits/4).
 */
export function readingDepth(
  buyer: Pick<DemoBuyer, "id" | "decision">,
  allBuyers: ReadonlyArray<Pick<DemoBuyer, "id">>,
  totalsByBuyer: ReadonlyMap<string, number>,
  visitsByBuyer: ReadonlyMap<string, number>,
): number {
  const ranked = allBuyers
    .filter((b) => (totalsByBuyer.get(b.id) ?? 0) > 0)
    .sort((a, b) => (totalsByBuyer.get(a.id) ?? 0) - (totalsByBuyer.get(b.id) ?? 0) || a.id.localeCompare(b.id))
    .map((b) => b.id);
  const i = ranked.indexOf(buyer.id);
  const pct = ranked.length > 1 && i >= 0 ? i / (ranked.length - 1) : 0.5;
  const s = 0.5 * pct + 0.3 * decisionWeight(buyer.decision) + 0.2 * Math.min(1, (visitsByBuyer.get(buyer.id) ?? 1) / 4);
  return Math.max(0, Math.min(1, s));
}

const KEY_FIGURE_RE = /\b(revenue|gross profit|gross margin|ebitda|sde|seller'?s discretionary|net income|net profit|add[- ]?backs?|margins?|cash|working capital|debt|capex|capital expend\w*|owner)\b/i;
const NUMERIC_KINDS = new Set(["table", "metric", "chart"]);

/** How much a part draws the eye, by kind (and whether it names a key figure). */
export function kindWeight(block: Pick<RenditionBlock, "kind" | "label" | "key">): number {
  const key = KEY_FIGURE_RE.test(block.label);
  switch (block.kind) {
    case "heading": return 0.12;
    case "table":
      if (/^(head|foot)/.test(block.key)) return 0.4;
      if (/^n?row:/.test(block.key)) return key ? 2.4 : 1.6;
      return 1;
    case "metric": return key ? 2.2 : 1.6;
    case "chart": return 1.5;
    case "highlight": return key ? 1.5 : 1.15;
    case "text":
    case "quote": return key ? 1.15 : 1;
    case "list":
    case "timeline": return 0.9;
    case "org": return 1.1;
    case "location":
    case "media": return 1.2;
    default: return 1;
  }
}

/** Private equity, financial, funds, family offices read numbers harder. */
export function isFinancialBuyer(buyerType: string | null | undefined): boolean {
  return /equity|financial|fund|family/i.test(buyerType ?? "");
}

const REMAINDER_SHARE = 0.04;
const SUMMARY_SHARE = 0.15;

/** Skimmed share (scrolled past) of a part's time: weak readers skim more; headings are half skimmed. */
export function skimShare(depth: number, kind: string): number {
  return kind === "heading" ? 0.5 : 0.06 + 0.5 * (1 - depth) ** 2;
}

// ── Deterministic randomness ─────────────────────────────────────────────

/** mulberry32 seeded from a string. */
export function prng(seed: string): () => number {
  let h = 1779033703;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
  let s = h >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function lognormal(r: () => number, sigma: number): number {
  return Math.exp(sigma * Math.sqrt(-2 * Math.log(1 - r() + 1e-12)) * Math.cos(2 * Math.PI * r()));
}
function hashInt(s: string): number {
  return parseInt(createHash("sha256").update(s).digest("hex").slice(0, 8), 16);
}

/** Integers summing exactly to `total`, proportional to `weights` (largest remainder). */
export function apportion(total: number, weights: number[]): number[] {
  const W = weights.reduce((a, x) => a + x, 0);
  if (weights.length === 0) return [];
  if (!(W > 0)) {
    const out = weights.map(() => 0);
    out[0] = total;
    return out;
  }
  const raw = weights.map((w) => (total * w) / W);
  const out = raw.map(Math.floor);
  let left = total - out.reduce((a, x) => a + x, 0);
  const order = raw.map((x, i) => ({ i, f: x - Math.floor(x) })).sort((a, b) => b.f - a.f || a.i - b.i);
  for (let k = 0; left > 0 && k < order.length; k++, left--) out[order[k].i] += 1;
  return out;
}

// ── One device and one network per buyer ─────────────────────────────────

const DESKTOPS: Array<[number, number]> = [[1440, 900], [1536, 864], [1920, 1080]];
const DESKTOP_UAS = ["Chrome/Mac", "Chrome/Windows", "Edge/Windows", "Safari/Mac"];

export interface DemoDevice { deviceClass: "desktop" | "phone"; w: number; h: number; uaFamily: string; ipHash: string }

/** The buyer's one device + browser and one network key (a hash of ids — never an address). */
export function demoDevice(dealId: string, accessId: string): DemoDevice {
  const h = hashInt(accessId);
  const ipHash = `demo${createHash("sha256").update(`${dealId}|${accessId}`).digest("hex").slice(0, 20)}`;
  if (h % 6 === 2) return { deviceClass: "phone", w: 390, h: 844, uaFamily: "Safari/iOS", ipHash };
  const [w, hh] = DESKTOPS[h % DESKTOPS.length];
  return { deviceClass: "desktop", w, h: hh, uaFamily: DESKTOP_UAS[Math.floor(h / 7) % DESKTOP_UAS.length], ipHash };
}

// ── The plan ─────────────────────────────────────────────────────────────

/** Parts of a page that can hold reading: drawn (not virtual, not a two-column container), never the normalised view. */
function readableBlocks(page: RenditionPage): RenditionBlock[] {
  return page.blocks.filter((b) => !b.virtual && b.kind !== "column" && b.when !== "normalized");
}

interface PageSplit {
  rows: Array<{ key: string; att: number; skim: number; pointer: number }>;
  remainder: number;
  expanded: boolean;
}

/** One visit's time T on one page, split over its parts (Σ part attention + remainder = T exactly). */
export function splitPage(page: RenditionPage, T: number, depth: number, financialBuyer: boolean, seed: string): PageSplit {
  const rnd = prng(seed);
  const all = readableBlocks(page);
  const summary = all.find((b) => b.when === "collapsed");
  const regular = all.filter((b) => b.when !== "collapsed");
  const remainder = Math.round(T * REMAINDER_SHARE);
  const body = T - remainder;
  // A collapsible section shows only its heading and summary until opened.
  const summaryExpected = summary ? Math.max(1, summary.expectedMs) : 0;
  const expanded = !!summary && depth >= 0.5 && T > 1.2 * summaryExpected;
  let blocks: RenditionBlock[];
  let summaryMs = 0;
  if (summary && !expanded) {
    blocks = [...regular.filter((b) => b.kind === "heading"), summary];
  } else {
    blocks = regular;
    if (summary) summaryMs = Math.round(body * SUMMARY_SHARE);
  }
  const n = blocks.length;
  const decay = 0.15 + 1.6 * (1 - depth);
  const weights = blocks.map((b, i) => {
    const numeric = NUMERIC_KINDS.has(b.kind);
    const typeBoost = financialBuyer && numeric ? 1.25 : !financialBuyer && (b.kind === "text" || b.kind === "highlight") ? 1.1 : 1;
    return Math.max(1, b.expectedMs) * kindWeight(b) * typeBoost * Math.exp(-decay * (n > 1 ? i / (n - 1) : 0)) * lognormal(rnd, 0.35);
  });
  const shares = n > 0 ? apportion(body - summaryMs, weights) : [];
  const rows: PageSplit["rows"] = [];
  const add = (b: RenditionBlock, att: number) => {
    if (att <= 0) return;
    const sh = skimShare(depth, b.kind);
    rows.push({ key: b.key, att, skim: Math.round((att * sh) / (1 - sh)), pointer: 0 });
  };
  if (n === 0) {
    // Nothing drawable (a page drawn as one piece has a "page" block, so this is rare): all on the page.
    return { rows: [], remainder: T, expanded: false };
  }
  blocks.forEach((b, i) => add(b, shares[i]));
  if (summary && summaryMs > 0) add(summary, summaryMs);
  // Pointer time on a chart's last one or two points (a deep reader checking values).
  if (depth >= 0.4) {
    for (const chart of blocks.filter((b) => b.kind === "chart")) {
      const row = rows.find((r) => r.key === chart.key);
      if (!row || row.att < 3000) continue;
      const points = page.blocks.filter((b) => b.virtual && chartOfPoint(b.key) === chart.key);
      if (points.length === 0) continue;
      const k = Math.min(points.length, rnd() < 0.5 ? 1 : 2);
      for (const pt of points.slice(-k)) {
        const ms = Math.round(1500 + rnd() * 6500);
        rows.push({ key: pt.key, att: 0, skim: 0, pointer: ms });
        row.pointer += ms;
      }
    }
  }
  return { rows, remainder, expanded };
}

/** The sample reading for a deal's old visits. Pure and deterministic. */
export function planDemoReading(input: DemoInput): DemoPlan {
  const { tag, deal } = input;
  const byBuyer = new Map(input.buyers.map((b) => [b.id, b]));
  const totals = new Map<string, number>();
  for (const p of input.pages) totals.set(p.accessId, (totals.get(p.accessId) ?? 0) + Math.max(0, p.attentionMs));
  const visitCount = new Map<string, number>();
  for (const v of input.visits) visitCount.set(v.accessId, (visitCount.get(v.accessId) ?? 0) + 1);
  const pagesByVisit = new Map<string, DemoOldPage[]>();
  for (const p of input.pages) pagesByVisit.set(p.visitId, [...(pagesByVisit.get(p.visitId) ?? []), p]);

  const plan: DemoPlan = { renditions: [], visits: [], rollups: [], events: [], supersede: [], skipped: [], unplaced: [], perBuyer: [] };
  const usedLevels = new Set<string>();
  const unplaced = new Map<string, { ms: number; visits: Set<string> }>();
  const perBuyer = new Map<string, DemoPlan["perBuyer"][number] & { pageSet: Set<string> }>();

  // Buyers who opened the link but have no old reading: nothing to convert.
  for (const b of input.buyers) {
    if (!visitCount.has(b.id)) plan.skipped.push({ accessId: b.id, why: "no reading recorded, so nothing to convert" });
  }

  const visits = [...input.visits].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime() || a.id.localeCompare(b.id));
  for (const old of visits) {
    const buyer = byBuyer.get(old.accessId);
    if (!buyer) continue;
    const level = buyer.accessLevel;
    const served = input.served[level] ?? null;
    if (!served) {
      if (!plan.skipped.some((s) => s.accessId === buyer.id)) plan.skipped.push({ accessId: buyer.id, why: "nothing is served at their access level right now" });
      continue;
    }
    usedLevels.add(level);
    const depth = readingDepth(buyer, input.buyers, totals, visitCount);
    const device = demoDevice(deal.id, buyer.id);
    const visitId = stableUuid(`demo-reading|${tag}|${old.id}`);
    const mode = cimModeForAccessLevel(level);
    const fin = isFinancialBuyer(buyer.buyerType);

    // Old page totals → the served page they are (several old keys can land on one page).
    const onPage = new Map<string, { page: RenditionPage; ms: number; old: DemoOldPage[] }>();
    const lost: DemoOldPage[] = [];
    for (const p of pagesByVisit.get(old.id) ?? []) {
      if (p.attentionMs <= 0) continue;
      const page = input.place(level, p.pageId, p.lineageId);
      if (!page) { lost.push(p); continue; }
      const cur = onPage.get(page.pageId) ?? { page, ms: 0, old: [] };
      cur.ms += p.attentionMs;
      cur.old.push(p);
      onPage.set(page.pageId, cur);
    }

    // The path on the served pages (unplaced steps dropped, repeats merged).
    const orderOf = new Map(served.pages.map((p) => [p.pageId, p.order]));
    const path: Array<[number, string]> = [];
    // A path step names the old page by its key; the visit's own page rows carry its stored lineage.
    const lineageOfOld = new Map((pagesByVisit.get(old.id) ?? []).map((p) => [p.pageId, p.lineageId]));
    for (const [t, pid] of old.path) {
      const page = input.place(level, pid, lineageOfOld.get(pid) ?? null);
      if (!page) continue;
      if (path.length && path[path.length - 1][1] === page.pageId) continue;
      path.push([t, page.pageId]);
    }
    const firstSecOn = new Map<string, number>();
    for (const [t, pid] of path) if (!firstSecOn.has(pid)) firstSecOn.set(pid, t);
    const at = (sec: number) => new Date(Math.min(old.lastSeenAt.getTime(), old.startedAt.getTime() + sec * 1000));

    let maxPageIndex = -1;
    let partRows = 0;
    const expandOn: string[] = [];
    const sortedPages = Array.from(onPage.values()).sort((a, b) => a.page.order - b.page.order);
    for (const { page, ms, old: olds } of sortedPages) {
      maxPageIndex = Math.max(maxPageIndex, page.order);
      const firstAt = at(firstSecOn.get(page.pageId) ?? 0);
      const lastAt = new Date(Math.min(old.lastSeenAt.getTime(), firstAt.getTime() + ms));
      if (page.locked) {
        // A locked stub (old versions only) isn't split: its time stays a page total.
        if (!plan.skipped.some((s) => s.accessId === buyer.id && s.why.includes(page.pageId))) {
          plan.skipped.push({ accessId: buyer.id, why: `page ${page.order + 1} was locked for them (${page.pageId}); its time stays a page total` });
        }
        for (const o of olds) {
          plan.rollups.push({
            visitId, dealId: deal.id, accessId: buyer.id, pageId: o.pageId, blockKey: "", renditionId: null, lineageId: o.lineageId,
            attentionMs: o.attentionMs, skimMs: 0, visibleMs: o.attentionMs, pointerMs: 0, firstAt, lastAt,
          });
        }
        continue;
      }
      const split = splitPage(page, ms, depth, fin, `${tag}|${old.id}|${page.pageId}`);
      for (const r of split.rows) {
        plan.rollups.push({
          visitId, dealId: deal.id, accessId: buyer.id, pageId: page.pageId, blockKey: r.key, renditionId: served.renditionId, lineageId: page.lineageId,
          attentionMs: r.att, skimMs: r.skim, visibleMs: r.att + r.skim > 0 ? Math.round((r.att + r.skim) * 1.15) + 400 : 0, pointerMs: r.pointer,
          firstAt, lastAt,
        });
        partRows++;
      }
      if (split.remainder > 0) {
        plan.rollups.push({
          visitId, dealId: deal.id, accessId: buyer.id, pageId: page.pageId, blockKey: "", renditionId: served.renditionId, lineageId: page.lineageId,
          attentionMs: split.remainder, skimMs: 0, visibleMs: split.remainder, pointerMs: 0, firstAt, lastAt,
        });
      }
      if (split.expanded) expandOn.push(page.pageId);
    }
    // Old time on pages this version doesn't have: kept as earlier reading (old key, no version).
    for (const p of lost) {
      plan.rollups.push({
        visitId, dealId: deal.id, accessId: buyer.id, pageId: p.pageId, blockKey: "", renditionId: null, lineageId: p.lineageId,
        attentionMs: p.attentionMs, skimMs: 0, visibleMs: p.attentionMs, pointerMs: 0, firstAt: old.startedAt, lastAt: old.lastSeenAt,
      });
      const u = unplaced.get(p.pageId) ?? { ms: 0, visits: new Set<string>() };
      u.ms += p.attentionMs;
      u.visits.add(old.id);
      unplaced.set(p.pageId, u);
    }

    // Interactions: contents jumps (backward, or forward by more than one page) and opened sections.
    const evs: Array<Omit<DemoEventRow, "seq">> = [];
    for (let i = 1; i < path.length; i++) {
      const from = path[i - 1][1], to = path[i][1];
      const a = orderOf.get(from), b = orderOf.get(to);
      if (a === undefined || b === undefined) continue;
      if (b < a || b - a > 1) {
        evs.push({ dealId: deal.id, visitId, accessId: buyer.id, renditionId: served.renditionId, type: "nav", pageId: from, blockKey: null, detail: `toc:${to}`, at: at(path[i][0]) });
      }
    }
    for (const pid of expandOn) {
      evs.push({ dealId: deal.id, visitId, accessId: buyer.id, renditionId: served.renditionId, type: "expand", pageId: pid, blockKey: null, detail: null, at: at((firstSecOn.get(pid) ?? 0) + 2) });
    }
    evs.sort((x, y) => x.at.getTime() - y.at.getTime() || (x.type === y.type ? 0 : x.type === "nav" ? -1 : 1));
    evs.forEach((e, i) => plan.events.push({ ...e, seq: i + 1 }));

    plan.visits.push({
      id: visitId, legacyVisitId: old.id, dealId: deal.id, accessId: buyer.id, renditionId: served.renditionId, mode, accessLevel: level,
      deviceClass: device.deviceClass, viewportW: device.w, viewportH: device.h, uaFamily: device.uaFamily, ipHash: device.ipHash,
      startedAt: old.startedAt, lastSeenAt: old.lastSeenAt, wallMs: old.wallMs, activeMs: old.activeMs,
      idleMs: Math.max(0, old.wallMs - old.activeMs), maxPageIndex: maxPageIndex >= 0 ? maxPageIndex : null, path, demoSeed: tag,
    });
    plan.supersede.push(old.id);

    const pb = perBuyer.get(buyer.id) ?? {
      accessId: buyer.id, name: buyer.name, level, depth: Math.round(depth * 100) / 100, visits: 0, pages: 0, minutes: 0, partRows: 0,
      device: device.deviceClass === "phone" ? `${device.uaFamily} (phone)` : device.uaFamily, pageSet: new Set<string>(),
    };
    pb.visits += 1;
    pb.partRows += partRows;
    pb.minutes += (sortedPages.reduce((s, x) => s + x.ms, 0) + lost.reduce((s, p) => s + p.attentionMs, 0)) / 60_000;
    sortedPages.forEach((x) => pb.pageSet.add(x.page.pageId));
    perBuyer.set(buyer.id, pb);
  }

  plan.renditions = Array.from(usedLevels).sort().map((level) => ({ level, renditionId: input.served[level]!.renditionId }));
  plan.unplaced = Array.from(unplaced.entries()).map(([key, u]) => ({ key, ms: u.ms, visits: u.visits.size })).sort((a, b) => b.ms - a.ms);
  plan.perBuyer = Array.from(perBuyer.values())
    .map(({ pageSet, ...rest }) => ({ ...rest, pages: pageSet.size, minutes: Math.round(rest.minutes * 10) / 10 }))
    .sort((a, b) => b.depth - a.depth || a.name.localeCompare(b.name));
  return plan;
}

/**
 * Per buyer and old page: the planned time equals the old total (within 1 s),
 * and each visit's active time is unchanged. Empty = exact.
 */
export function checkPlanTotals(input: DemoInput, plan: DemoPlan): Array<{ accessId: string; pageId: string; oldMs: number; newMs: number }> {
  const out: Array<{ accessId: string; pageId: string; oldMs: number; newMs: number }> = [];
  const level = new Map(input.buyers.map((b) => [b.id, b.accessLevel]));
  const planned = new Set(plan.supersede);
  const oldBy = new Map<string, number>();
  for (const p of input.pages) {
    if (!planned.has(p.visitId) || p.attentionMs <= 0) continue;
    const page = input.place(level.get(p.accessId) ?? "", p.pageId, p.lineageId);
    const k = `${p.accessId}|${page && !page.locked ? page.pageId : p.pageId}`;
    oldBy.set(k, (oldBy.get(k) ?? 0) + p.attentionMs);
  }
  const newBy = new Map<string, number>();
  for (const r of plan.rollups) {
    const k = `${r.accessId}|${r.pageId}`;
    newBy.set(k, (newBy.get(k) ?? 0) + r.attentionMs);
  }
  // A locked page's rows keep their old page ids: compare those under the old id.
  const keys = new Set([...Array.from(oldBy.keys()), ...Array.from(newBy.keys())]);
  keys.forEach((k) => {
    const o = oldBy.get(k) ?? 0, n = newBy.get(k) ?? 0;
    if (Math.abs(o - n) >= 1000) {
      const [accessId, pageId] = k.split("|");
      out.push({ accessId, pageId, oldMs: o, newMs: n });
    }
  });
  const oldVisits = new Map(input.visits.map((v) => [v.id, v]));
  for (const v of plan.visits) {
    const o = oldVisits.get(v.legacyVisitId);
    if (!o || o.activeMs !== v.activeMs || o.wallMs !== v.wallMs) {
      out.push({ accessId: v.accessId, pageId: "(visit active time)", oldMs: o?.activeMs ?? 0, newMs: v.activeMs });
    }
  }
  return out;
}

// ── Removal ──────────────────────────────────────────────────────────────

/** One deal-scoped removal step (every statement carries `deal_id = dealId`). */
export type RemovalStep =
  | { op: "delete_events"; dealId: string; tag: string }
  | { op: "delete_rollups"; dealId: string; tag: string }
  | { op: "delete_visits"; dealId: string; tag: string }
  | { op: "unhide_visits"; dealId: string; tag: string }
  | { op: "versions"; dealId: string; tag: string };

export interface RemovalStatements {
  dealId: string;
  tag: string;
  steps: RemovalStep[];
}

/** What --remove does, in order, for ONE deal. */
export function planRemoval(dealId: string, tag: string): RemovalStatements {
  if (!dealId) throw new Error("planRemoval needs a deal id");
  return {
    dealId, tag,
    steps: [
      { op: "delete_events", dealId, tag },
      { op: "delete_rollups", dealId, tag },
      { op: "delete_visits", dealId, tag },
      { op: "unhide_visits", dealId, tag },
      { op: "versions", dealId, tag },
    ],
  };
}

/**
 * The SQL of one removal step — every statement is scoped to the step's deal.
 * `serving`: version ids the deal serves at some level right now (a running
 * server may hold them; they are kept with the tag cleared).
 */
export function removalSql(step: RemovalStep, serving: ReadonlyArray<string> = []): SQL {
  const sampleVisits = sql`SELECT v.id FROM buyer_visits v WHERE v.deal_id = ${step.dealId} AND v.demo_seed = ${step.tag}`;
  switch (step.op) {
    case "delete_events":
      return sql`DELETE FROM analytics_events WHERE deal_id = ${step.dealId} AND visit_id IN (${sampleVisits})`;
    case "delete_rollups":
      return sql`DELETE FROM reading_rollups WHERE deal_id = ${step.dealId} AND visit_id IN (${sampleVisits})`;
    case "delete_visits":
      return sql`DELETE FROM buyer_visits WHERE deal_id = ${step.dealId} AND demo_seed = ${step.tag}`;
    case "unhide_visits":
      return sql`UPDATE buyer_visits SET superseded_by = NULL WHERE deal_id = ${step.dealId} AND superseded_by = ${step.tag}`;
    case "versions": {
      const keep = sql`(
        EXISTS (SELECT 1 FROM buyer_visits v WHERE v.deal_id = ${step.dealId} AND v.rendition_id = c.id)
        OR EXISTS (SELECT 1 FROM analytics_events e WHERE e.deal_id = ${step.dealId} AND e.rendition_id = c.id)
        OR EXISTS (SELECT 1 FROM buyer_questions q WHERE q.deal_id = ${step.dealId} AND q.rendition_id = c.id)
        OR c.id = ANY(string_to_array(${serving.join(",")}, ',')))`;
      // Versions only the sample used go; the rest stay, no longer tagged.
      return sql`WITH gone AS (
          DELETE FROM cim_renditions c WHERE c.deal_id = ${step.dealId} AND c.demo_seed = ${step.tag} AND NOT ${keep} RETURNING c.id),
        kept AS (
          UPDATE cim_renditions c SET demo_seed = NULL WHERE c.deal_id = ${step.dealId} AND c.demo_seed = ${step.tag} AND ${keep} RETURNING c.id)
        SELECT 'deleted' AS what, id FROM gone UNION ALL SELECT 'kept' AS what, id FROM kept`;
    }
  }
}

/** The reading tables as the removal sees them (tests; the script runs the SQL). */
export interface DemoMemoryTables {
  visits: Array<{ id: string; dealId: string; demoSeed: string | null; supersededBy: string | null; renditionId: string | null }>;
  rollups: Array<{ visitId: string; dealId: string }>;
  events: Array<{ visitId: string | null; dealId: string; renditionId?: string | null }>;
  questions?: Array<{ dealId: string; renditionId: string | null }>;
  renditions: Array<{ id: string; dealId: string; demoSeed: string | null }>;
}

/**
 * Runs a removal on in-memory tables (the SQL in scripts/seed-demo-reading.ts
 * mirrors it). `serving` = version ids the deal serves right now (kept, tag
 * cleared). Returns what was kept.
 */
export function applyRemovalInMemory(t: DemoMemoryTables, r: RemovalStatements, serving: ReadonlySet<string> = new Set()): { keptVersions: string[] } {
  const sampleIds = () => new Set(t.visits.filter((v) => v.dealId === r.dealId && v.demoSeed === r.tag).map((v) => v.id));
  const kept: string[] = [];
  for (const step of r.steps) {
    const ids = sampleIds();
    switch (step.op) {
      case "delete_events": t.events = t.events.filter((e) => !(e.dealId === step.dealId && e.visitId && ids.has(e.visitId))); break;
      case "delete_rollups": t.rollups = t.rollups.filter((x) => !(x.dealId === step.dealId && ids.has(x.visitId))); break;
      case "delete_visits": t.visits = t.visits.filter((v) => !(v.dealId === step.dealId && v.demoSeed === step.tag)); break;
      case "unhide_visits": for (const v of t.visits) if (v.dealId === step.dealId && v.supersededBy === step.tag) v.supersededBy = null; break;
      case "versions": {
        const used = (id: string) =>
          t.visits.some((v) => v.dealId === step.dealId && v.renditionId === id)
          || t.events.some((e) => e.dealId === step.dealId && e.renditionId === id)
          || (t.questions ?? []).some((q) => q.dealId === step.dealId && q.renditionId === id);
        const next: DemoMemoryTables["renditions"] = [];
        for (const v of t.renditions) {
          if (v.dealId !== step.dealId || v.demoSeed !== step.tag) { next.push(v); continue; }
          if (used(v.id) || serving.has(v.id)) { next.push({ ...v, demoSeed: null }); kept.push(v.id); }
        }
        t.renditions = next;
        break;
      }
    }
  }
  return { keptVersions: kept };
}

// ── Refusals ─────────────────────────────────────────────────────────────

/**
 * Why sample reading must NOT be written to this deal (null = it may):
 * only fictional example deals (demo_key) of broker_demo or qa_cimgen, never
 * the real deals by name or id, never a deal with a real buyer address or
 * real part-by-part reading (a broker's own preview doesn't count), and
 * never with a live AI key in the environment.
 */
export function refuseReason(
  deal: { id: string; businessName: string | null; demoKey: string | null },
  owner: string | null | undefined,
  buyers: ReadonlyArray<{ email: string | null }>,
  realVisitCount: number,
  env: { ANTHROPIC_API_KEY?: string } = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
): string | null {
  const key = env.ANTHROPIC_API_KEY;
  if (key && key !== "disabled" && key !== "unused") return "Run this with ANTHROPIC_API_KEY=disabled (it never calls the AI).";
  if (!deal.demoKey) return "This isn't an example deal (it has no demo key), so its reading is real and is never changed.";
  if (!owner || !DEMO_SEED_OWNERS.has(owner)) return `This deal belongs to ${owner ? `"${owner}"` : "nobody known"}; sample reading is only for the example deals of broker_demo and qa_cimgen.`;
  if (REAL_DEAL_IDS.has(deal.id) || REAL_DEAL_NAME_RE.test(deal.businessName ?? "")) return "This is a real deal; its reading is never changed.";
  const real = buyers.filter((b) => !/\.invalid$/i.test((b.email ?? "").trim()));
  if (real.length > 0) return `${real.length} buyer${real.length === 1 ? " has" : "s have"} a real email address; sample reading is only for fictional buyers.`;
  if (realVisitCount > 0) return `Buyers have already read this CIM part by part (${realVisitCount} visit${realVisitCount === 1 ? "" : "s"}); real reading is never replaced.`;
  return null;
}
