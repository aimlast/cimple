/**
 * Reading recorded by the OLD tracker (analytics_events 'section_exit', before
 * reading analytics v2), shown without writing anything.
 *
 * A deal whose buyers read it before part-by-part tracking has no
 * buyer_visits and no stored rendition, so the Engagement tab would open
 * empty. Instead, the facts loader reads those old events on the fly
 * (read-only, nothing is stored) and turns them into page-level legacy
 * visits — the same shape scripts/backfill-legacy-reading.ts writes when the
 * founder chooses to store them — and draws them on the CIM as it would be
 * served right now (liveRendition: the view room's own inputs, so its id is
 * the one the next real serving records).
 *
 *   - every event counts (a visit's time is the buyer's, whatever became of
 *     the page); its page is found at read time — the same key, the blind
 *     view's neutral s_<id> key, the section continuing it after a
 *     regeneration, or a renamed key's words (legacyKeyResolver) — and
 *     reading on a page the current CIM no longer has is reported, never
 *     silently dropped (release review DEP-1);
 *   - stored (scripts/backfill-legacy-reading.ts, and automatically just
 *     before a regeneration replaces the sections — legacy-store.ts), it
 *     keeps the old key as its page id and the old section's lineage, so a
 *     later regeneration still finds its page;
 *   - one legacy visit per buyer link per 30-minute session;
 *   - the old tracker double counted overlapping sections, so a session's
 *     section seconds are scaled down to fit its wall-clock span;
 *   - cursor heat-map samples are never read (they carry no page).
 */
import { createHash } from "crypto";
import { READING_RULES, type CimMode, type CimVariant, type LegacyUnmatchedReading, type RenditionPage } from "@shared/analytics-v2";
import type { Deal } from "@shared/schema";
import { pageRole } from "@shared/cim-page-role";
import { WEAK_KEY_WORDS, keyWordsOf } from "@shared/section-words";
import type { RawBlockSum, RawRendition, RawVisit, RawVisitPage, ReadingQuery, RenditionRow } from "./queries";

/** A uuid-shaped id derived from a string (stable across runs). */
export function stableUuid(s: string): string {
  const h = createHash("sha256").update(s).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export interface LegacyExit { accessId: string; key: string; seconds: number; at: Date }

export interface LegacySession {
  visitId: string;
  accessId: string;
  startedAt: Date;
  lastSeenAt: Date;
  activeMs: number;
  wallMs: number;
  path: Array<[number, string]>;
  pages: Map<string, number>;   // pageId → attention ms
}

/** Section-exit events of one buyer → legacy sessions (pure). */
export function legacySessions(exits: LegacyExit[], resolve: (key: string) => string | null): LegacySession[] {
  const out: LegacySession[] = [];
  const byAccess = new Map<string, LegacyExit[]>();
  for (const e of exits) byAccess.set(e.accessId, [...(byAccess.get(e.accessId) ?? []), e]);
  byAccess.forEach((list, accessId) => {
    list.sort((a, b) => a.at.getTime() - b.at.getTime());
    let cur: LegacyExit[] = [];
    const flush = () => {
      const used = cur.map((e) => ({ ...e, pageId: resolve(e.key) })).filter((e) => e.pageId && e.seconds > 0) as Array<LegacyExit & { pageId: string }>;
      cur = [];
      if (used.length === 0) return;
      const start = new Date(used[0].at.getTime() - used[0].seconds * 1000);
      const end = used[used.length - 1].at;
      const wallMs = Math.max(1000, end.getTime() - start.getTime());
      const raw = used.reduce((s, e) => s + e.seconds * 1000, 0);
      const f = raw > wallMs ? wallMs / raw : 1;   // overlapping sections were double counted
      const pages = new Map<string, number>();
      const path: Array<[number, string]> = [];
      let t = 0;
      for (const e of used) {
        const ms = Math.round(e.seconds * 1000 * f);
        pages.set(e.pageId, (pages.get(e.pageId) ?? 0) + ms);
        if (!path.length || path[path.length - 1][1] !== e.pageId) path.push([Math.floor(t / 1000), e.pageId]);
        t += ms;
      }
      out.push({
        visitId: stableUuid(`legacy|${accessId}|${start.toISOString()}`),
        accessId, startedAt: start, lastSeenAt: end, wallMs, activeMs: Math.min(wallMs, Math.round(raw * f)), path, pages,
      });
    };
    for (const e of list) {
      if (cur.length && e.at.getTime() - cur[cur.length - 1].at.getTime() > READING_RULES.visitGapMs) flush();
      cur.push(e);
    }
    flush();
  });
  return out;
}

/** A current section as the legacy resolver sees it (title, layout and lineage are optional — tests pass keys only). */
export interface LegacySection {
  id: string;
  sectionKey: string;
  sectionTitle?: string | null;
  layoutType?: string | null;
  analyticsLineage?: string | null;
  order?: number | null;
}

/**
 * An old section key → the current section id. In order: the same key; the
 * blind view's neutral s_<id> key of the section, or of the old section it
 * continues (its lineage is that section's id — a regenerated CIM); the old
 * section's id itself (reading stored before a regeneration); then, for a
 * key a regeneration renamed (Beacon, 2026-09-29: services_revenue_streams →
 * revenue_streams, normalized_earnings → sde_normalization), the section
 * whose key and title share the old key's words (matchLegacyKey). Null when
 * no page of the current CIM is that page.
 */
export function legacyKeyResolver(
  sections: ReadonlyArray<LegacySection>,
  blindKey: (id: string) => string,
): (key: string) => string | null {
  const byKey = new Map(sections.map((s) => [s.sectionKey, s.id]));
  const byBlind = new Map(sections.map((s) => [blindKey(s.id), s.id]));
  const byLineage = new Map<string, string>();
  for (const s of sections) if (s.analyticsLineage) byLineage.set(s.analyticsLineage, s.id);
  const byLineageBlind = new Map(Array.from(byLineage.entries()).map(([lin, id]) => [blindKey(lin), id]));
  const ids = new Set(sections.map((s) => s.id));
  const fuzzy = new Map<string, string | null>();
  return (key) => {
    const hit = byKey.get(key) ?? byBlind.get(key) ?? byLineageBlind.get(key) ?? (ids.has(key) ? key : byLineage.get(key));
    if (hit) return hit;
    if (!fuzzy.has(key)) fuzzy.set(key, matchLegacyKey(key, sections)?.id ?? null);
    return fuzzy.get(key) ?? null;
  };
}

/**
 * A page of the reading on file (a legacy row: page id + lineage) → the
 * page it is on the version drawn (`drawn`, its page index; null = no
 * version — then the current sections): a page of that version already
 * (same id or lineage — a live CIM under review draws the kept copy, whose
 * old pages stored reading still names), else the current section it is —
 * the same section, the section continuing its lineage, or what its key
 * resolves to (legacyKeyResolver) — when the drawn version has that page.
 * Null when there is no such page.
 */
export function legacyPageRemap(
  sections: ReadonlyArray<LegacySection>,
  blindKey: (id: string) => string,
  drawn: ReadonlyArray<{ pageId: string; lineageId: string }> | null = null,
): (pageId: string, lineageId: string | null) => { pageId: string; lineageId: string } | null {
  const byId = new Map(sections.map((s) => [s.id, s]));
  const byLineage = new Map<string, LegacySection>();
  for (const s of sections) byLineage.set(s.analyticsLineage || s.id, s);
  const resolve = legacyKeyResolver(sections, blindKey);
  const drawnIds = drawn ? new Set(drawn.map((p) => p.pageId)) : null;
  const drawnLineages = drawn ? new Set(drawn.map((p) => p.lineageId)) : null;
  const onDrawn = (p: { pageId: string; lineageId: string | null }) =>
    !drawnIds || drawnIds.has(p.pageId) || (!!p.lineageId && drawnLineages!.has(p.lineageId));
  const out = (s: LegacySection | undefined) => (s ? { pageId: s.id, lineageId: s.analyticsLineage || s.id } : null);
  return (pageId, lineageId) => {
    if (drawnIds && onDrawn({ pageId, lineageId })) return { pageId, lineageId: lineageId ?? pageId };
    const to = out(byId.get(pageId)) ?? (lineageId ? out(byLineage.get(lineageId)) : null) ?? out(byId.get(resolve(pageId) ?? ""));
    return to && onDrawn(to) ? to : null;
  };
}

// ── Renamed keys (word helpers: shared/section-words.ts) ─────────────────

/**
 * The current section an old, since-renamed key was: the one sharing the
 * most of its words — a word in the section's key counts 2 (a broad word 1),
 * in its title 1, the same page role 1, a plainly different role (both
 * known) −2 — needing at least 2 and one telling
 * word in common; a tie goes to the earlier page. Null for neutral blind
 * keys and for a key no page shares a telling word with (Beacon's
 * business_overview, history_milestones, where_we_operate: pages the rebuilt
 * CIM no longer has). Pure.
 */
export function matchLegacyKey(key: string, sections: ReadonlyArray<LegacySection>): LegacySection | null {
  if (/^s_[a-z0-9]{4,}$/i.test(key)) return null;
  const words = keyWordsOf(key);
  if (words.size === 0) return null;
  const oldRole = pageRole({ layoutType: "", title: key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " "), sectionKey: key });
  let best: { s: LegacySection; score: number } | null = null;
  const ordered = [...sections].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (const s of ordered) {
    const inKey = keyWordsOf(s.sectionKey);
    const inTitle = keyWordsOf(s.sectionTitle);
    let score = 0;
    let telling = false;
    words.forEach((w) => {
      const weak = WEAK_KEY_WORDS.has(w);
      if (inKey.has(w)) { score += weak ? 1 : 2; telling ||= !weak; }
      else if (inTitle.has(w)) { score += 1; telling ||= !weak; }
    });
    if (!telling) continue;
    const role = pageRole({ layoutType: s.layoutType ?? "", title: s.sectionTitle ?? "", sectionKey: s.sectionKey });
    if (role === oldRole && role !== "other" && role !== "front_matter") score += 1;
    // Plainly different pages sharing a word ("history_milestones" is not
    // "Incident & Compliance History").
    else if (role !== oldRole && role !== "other" && oldRole !== "other") score -= 2;
    if (score >= 2 && (!best || score > best.score)) best = { s, score };
  }
  return best?.s ?? null;
}

/** "services_revenue_streams" → "Services revenue streams" (broker side: a page the current CIM no longer has). */
export function legacyKeyLabel(key: string): string {
  if (/^s_[a-z0-9]{4,}$/i.test(key)) return "A page of an earlier version";
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w.toLowerCase());
  const s = words.join(" ");
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : key;
}

/**
 * Legacy sessions as the rows the facts loader reads (visits, page sums,
 * visit pages), with the query's filters applied: the date range on the
 * last activity and the buyer list. Legacy visits have no device, so a
 * "phones only" filter leaves them out. Pure.
 */
export function legacyRows(
  sessions: LegacySession[],
  q: Pick<ReadingQuery, "since" | "device" | "accessIds">,
  lineageOf: (pageId: string) => string | null,
): { visits: RawVisit[]; sums: RawBlockSum[]; visitPages: RawVisitPage[] } {
  const kept = sessions.filter((s) =>
    (!q.since || s.lastSeenAt >= q.since) && q.device !== "phone" && (!q.accessIds || q.accessIds.includes(s.accessId)));
  const visits: RawVisit[] = kept.map((s) => ({
    id: s.visitId, accessId: s.accessId, renditionId: null, startedAt: s.startedAt, lastSeenAt: s.lastSeenAt,
    wallMs: s.wallMs, activeMs: s.activeMs, deviceClass: null, uaFamily: null, maxPageIndex: null, path: s.path, legacy: true, ipHash: null,
  }));
  const sumBy = new Map<string, RawBlockSum>();
  const visitPages: RawVisitPage[] = [];
  for (const s of kept) {
    s.pages.forEach((ms, pageId) => {
      visitPages.push({ accessId: s.accessId, visitId: s.visitId, renditionId: null, lineageId: lineageOf(pageId), pageId, attentionMs: ms });
      const k = `${s.accessId}|${pageId}`;
      const prev = sumBy.get(k) ?? {
        accessId: s.accessId, renditionId: null, lineageId: lineageOf(pageId), pageId, blockKey: "",
        attentionMs: 0, skimMs: 0, visibleMs: 0, pointerMs: 0, firstAt: s.startedAt, lastAt: s.lastSeenAt,
      };
      prev.attentionMs += ms;
      prev.visibleMs += ms;
      if (prev.firstAt && s.startedAt < prev.firstAt) prev.firstAt = s.startedAt;
      if (prev.lastAt && s.lastSeenAt > prev.lastAt) prev.lastAt = s.lastSeenAt;
      sumBy.set(k, prev);
    });
  }
  return { visits, sums: Array.from(sumBy.values()), visitPages };
}

/** Legacy reading on pages the current CIM no longer has (broker side). */
export type LegacyUnmatched = LegacyUnmatchedReading;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Legacy reading (on the fly or stored — rows with no rendition) placed on
 * the current sections: each page id / lineage goes through `remap`
 * (legacyPageRemap), visit paths too. Rows no current page is are left as
 * they are (the aggregation then skips them) and summed in `unmatched`, so
 * the Engagement tab can say what the current CIM no longer shows. Part-by-part
 * reading (a rendition id) is never touched. Pure.
 */
export function remapLegacyReading(
  rows: { visits: RawVisit[]; sums: RawBlockSum[]; visitPages: RawVisitPage[] },
  remap: (pageId: string, lineageId: string | null) => { pageId: string; lineageId: string } | null,
): { visits: RawVisit[]; sums: RawBlockSum[]; visitPages: RawVisitPage[]; unmatched: LegacyUnmatched | null } {
  const legacyVisitIds = new Set(rows.visits.filter((v) => v.legacy).map((v) => v.id));
  const lost = new Map<string, number>();
  const sums = rows.sums.map((s) => {
    if (s.renditionId !== null || s.blockKey !== "") return s;
    const to = remap(s.pageId, s.lineageId);
    if (to) return { ...s, pageId: to.pageId, lineageId: to.lineageId };
    if (s.attentionMs > 0) lost.set(s.pageId, (lost.get(s.pageId) ?? 0) + s.attentionMs);
    return s;
  });
  const visitPages = rows.visitPages.map((p) => {
    if (p.renditionId !== null || !legacyVisitIds.has(p.visitId)) return p;
    const to = remap(p.pageId, p.lineageId);
    return to ? { ...p, pageId: to.pageId, lineageId: to.lineageId } : p;
  });
  const visits = rows.visits.map((v) =>
    v.legacy ? { ...v, path: v.path.map(([t, pageId]) => [t, remap(pageId, null)?.pageId ?? pageId] as [number, string]) } : v);
  if (lost.size === 0) return { visits, sums, visitPages, unmatched: null };
  // One line per page the CIM no longer has (an old section id says only that).
  const byLabel = new Map<string, number>();
  lost.forEach((ms, pageId) => {
    const label = UUID_RE.test(pageId) ? "A page of an earlier version" : legacyKeyLabel(pageId);
    byLabel.set(label, (byLabel.get(label) ?? 0) + ms);
  });
  const pages = Array.from(byLabel.entries()).map(([label, attentionMs]) => ({ label, attentionMs })).sort((a, b) => b.attentionMs - a.attentionMs);
  return { visits, sums, visitPages, unmatched: { attentionMs: pages.reduce((s, p) => s + p.attentionMs, 0), pages } };
}

/** The access level most of these buyer links have (the version to draw legacy reading on). */
export function mainAccessLevel(levels: ReadonlyArray<string>): string {
  const n = new Map<string, number>();
  for (const l of levels) n.set(l, (n.get(l) ?? 0) + 1);
  return Array.from(n.entries()).sort((a, b) => b[1] - a[1] || (a[0] === "teaser" ? 1 : 0) - (b[0] === "teaser" ? 1 : 0))[0]?.[0] ?? "full";
}

/**
 * The CIM as a buyer at this access level would be served it right now
 * (the view room's own inputs: servedCimFor), as a rendition that isn't
 * stored. Null while the blind version is being prepared or nothing is shown.
 * opts.ignoreHold (broker side and scripts only): a CIM held from buyers is
 * drawn as they will get it (renditions.ts servedCimFor).
 *
 * Memoised for 30 s per (deal, level, CIM version, hold flag): each filter
 * set of the Engagement tab (and compare's two extra queries) would
 * otherwise rebuild the whole CIM. The date only labels the version.
 */
export async function liveRendition(
  deal: Deal,
  accessLevel: string,
  createdAt: Date = new Date(),
  opts: { ignoreHold?: boolean } = {},
): Promise<{ raw: RawRendition; row: RenditionRow } | null> {
  const key = [deal.id, accessLevel, deal.cimLayoutVersion ?? "", opts.ignoreHold ? 1 : 0].join("|");
  const hit = liveMemo.get(key);
  let built: Promise<LiveBuild | null>;
  if (hit && Date.now() - hit.at < LIVE_MEMO_MS) built = hit.value;
  else {
    built = buildLive(deal, accessLevel, opts);
    liveMemo.delete(key);
    liveMemo.set(key, { at: Date.now(), value: built });
    if (liveMemo.size > LIVE_MEMO_MAX) liveMemo.delete(liveMemo.keys().next().value as string);
    // A failed or empty build is not remembered.
    built.then((v) => { if (!v) liveMemo.delete(key); }, () => liveMemo.delete(key));
  }
  const b = await built;
  if (!b) return null;
  const raw: RawRendition = { id: b.id, mode: b.mode, variant: b.variant, createdAt, visits: 0 };
  return { raw, row: { ...raw, sections: b.sections, design: b.design, pageIndex: b.pageIndex } };
}

interface LiveBuild { id: string; mode: string; variant: string; sections: unknown[]; design: unknown; pageIndex: RenditionPage[] }
const LIVE_MEMO_MS = 30_000;
const LIVE_MEMO_MAX = 200;
const liveMemo = new Map<string, { at: number; value: Promise<LiveBuild | null> }>();

/** Tests: forget the memoised live renditions. */
export function _resetLiveRenditionMemo(): void {
  liveMemo.clear();
}

async function buildLive(deal: Deal, accessLevel: string, opts: { ignoreHold?: boolean }): Promise<LiveBuild | null> {
  const { servedCimFor, buildPageIndex, renditionId } = await import("../analytics/renditions");
  const served = await servedCimFor(deal, accessLevel, { ignoreHold: opts.ignoreHold }).catch(() => null);
  if (!served) return null;
  const id = renditionId({ mode: served.mode as CimMode, variant: served.variant as CimVariant, design: served.design, sections: served.sections });
  const pageIndex: RenditionPage[] = buildPageIndex(served.sections, served.design as never, served.live);
  return { id, mode: served.mode, variant: served.variant, sections: served.sections as unknown[], design: served.design ?? null, pageIndex };
}
