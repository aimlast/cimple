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
 *   - only events whose section key still resolves to a current section
 *     (real keys, or the blind view's neutral s_<id> keys) are used;
 *   - one legacy visit per buyer link per 30-minute session;
 *   - the old tracker double counted overlapping sections, so a session's
 *     section seconds are scaled down to fit its wall-clock span;
 *   - cursor heat-map samples are never read (they carry no page).
 */
import { createHash } from "crypto";
import { READING_RULES, type CimMode, type CimVariant, type RenditionPage } from "@shared/analytics-v2";
import type { Deal } from "@shared/schema";
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

/** An old section key → the current section id (real keys, or the blind view's neutral s_<id> keys). */
export function legacyKeyResolver(
  sections: ReadonlyArray<{ id: string; sectionKey: string }>,
  blindKey: (id: string) => string,
): (key: string) => string | null {
  const byKey = new Map(sections.map((s) => [s.sectionKey, s.id]));
  const byBlind = new Map(sections.map((s) => [blindKey(s.id), s.id]));
  return (key) => byKey.get(key) ?? byBlind.get(key) ?? null;
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
  lineageOf: (pageId: string) => string,
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
 */
export async function liveRendition(deal: Deal, accessLevel: string, createdAt: Date = new Date()): Promise<{ raw: RawRendition; row: RenditionRow } | null> {
  const { servedCimFor, buildPageIndex, renditionId } = await import("../analytics/renditions");
  const served = await servedCimFor(deal, accessLevel).catch(() => null);
  if (!served) return null;
  const id = renditionId({ mode: served.mode as CimMode, variant: served.variant as CimVariant, design: served.design, sections: served.sections });
  const pageIndex: RenditionPage[] = buildPageIndex(served.sections, served.design as never, served.live);
  const raw: RawRendition = { id, mode: served.mode, variant: served.variant, createdAt, visits: 0 };
  return { raw, row: { ...raw, sections: served.sections as unknown[], design: served.design ?? null, pageIndex } };
}
