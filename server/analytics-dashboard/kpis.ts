/**
 * Every number on the analytics dashboards, counted once (spec §6.1).
 * Pure: inputs from load.ts → numbers. The Analytics page (scope "broker")
 * and the deal Engagement tab (scope "deal") call the same functions.
 *
 * Shared definitions:
 *   CIM link      a link with seesCim(level) — teaser-only links never
 *                 count as opened, read, "haven't opened" or worth a call
 *   active visit  activeMs ≥ READING_RULES.readerMinMs (3 s)
 *   reader        hasReadCim: at least one active visit (the one rule)
 *   first open    the earliest visit, else firstViewedAt
 *   windows       [since, now] and the window before it, [prevSince, since)
 *   "last on"     a period number at 0 while an earlier event of its kind
 *                 exists says when it last happened (never a bare 0)
 *
 * Reading-derived numbers come from the reading facts (items); a deal whose
 * facts failed to load is left out of every number (and reported as
 * partial), so each number's `ids` is always a subset of the Buyers tab's
 * rows and the tab's number filter shows exactly the set counted.
 */
import {
  READING_RULES,
  filterSince,
  formatReadingTime,
  type BuyerReadingFacts,
  type EngagementFilters,
  type VisitFacts,
} from "@shared/analytics-v2";
import {
  KPI_COPY,
  KPI_WHO_MAX,
  dayMonth,
  deltaWords,
  firstOpenAt,
  hasReadCim,
  isSampleVisit,
  openedCim,
  plural,
  questionWaitingOn,
  rangeWindow,
  type BuyerGroups,
  type DashboardRange,
  type GroupRow,
  type HeadsUp,
  type Kpi,
  type KpiId,
  type KpiWho,
  type LinkRanOut,
  type NoticeId,
  HEADS_UP_NOT_OPENED_DAYS,
} from "@shared/analytics-dashboard";
import { nextStepWords } from "@shared/buyer-next-steps";
import type { CaptureFacts } from "../engagement/facts";
import { buyerInsight, rankBuyers } from "../engagement/insights";
import { insightContext } from "../engagement/responses";
import { buildCallList } from "../routes/engagement-insights";
import type { AccessRow, BrokerInputs, DashboardItem, QuestionRow } from "./load";
import { accessLevelRank, isTeaserOnly, seesCim, TEASER_RENDITION_MODE } from "./levels";

const DAY = 86_400_000;
const CONTACTED_MS = 48 * 3_600_000;
const FINAL = new Set(["interested", "not_interested", "lapsed"]);
const DECLINED = new Set(["not_interested", "lapsed"]);

const t = (iso: string | null | undefined): number => (iso ? Date.parse(iso) || 0 : 0);

// ── CIM-only facts ────────────────────────────────────────────────────────

const cimCache = new WeakMap<CaptureFacts, CaptureFacts>();

/**
 * The same facts with only CIM links (teaser-only links removed). When the
 * version the facts were drawn on is a TEASER rendition (a deal whose only
 * rendition is the teaser), its blocks are not the CIM's pages: no pages
 * (so "How far they got" says "—", never "0 of 7"). After the teaser merge
 * the loader never picks a teaser rendition (INTEGRATION §2.13) and this
 * is a no-op; it stays as a second lock.
 */
export function cimOnly(facts: CaptureFacts): CaptureFacts {
  let out = cimCache.get(facts);
  if (!out) {
    out = { ...facts, buyers: facts.buyers.filter((b) => seesCim(b.accessLevel)) };
    if (isTeaserRendition(facts.rendition)) {
      out = { ...out, pages: [], rendition: null, renditions: facts.renditions.filter((r) => !isTeaserRendition(r)) };
    }
    cimCache.set(facts, out);
  }
  return out;
}

const isTeaserRendition = (r: { mode: string } | null | undefined): boolean => !!r && r.mode === TEASER_RENDITION_MODE;

/** Active visits (≥ 3 s of active reading). */
export function activeVisits(b: Pick<BuyerReadingFacts, "visits">): VisitFacts[] {
  return b.visits.filter((v) => v.activeMs >= READING_RULES.readerMinMs);
}

/** The deal tab's Buyers filters on an access row (the facts loader's segment rule). */
export function accessMatchesFilters(a: Pick<AccessRow, "id" | "decision" | "buyerType">, f: EngagementFilters | undefined): boolean {
  if (!f) return true;
  if (f.buyers.length > 0 && !f.buyers.includes(a.id)) return false;
  if (f.segment === "all") return true;
  if (f.segment === "interested") return a.decision === "interested";
  if (f.segment === "undecided") return !a.decision || a.decision === "under_review";
  return a.buyerType === f.segment.slice("type:".length);
}

const filtered = (f: EngagementFilters | undefined) => !!f && (f.buyers.length > 0 || f.segment !== "all");

/** A broker app link to one buyer on a deal's Engagement tab. */
export function buyerHref(dealId: string, accessId: string): string {
  return `/deal/${dealId}/engagement?buyer=${encodeURIComponent(accessId)}`;
}

export interface CimBuyer { item: DashboardItem; b: BuyerReadingFacts }

function cimBuyers(inputs: Pick<BrokerInputs, "items">, f: EngagementFilters | undefined): CimBuyer[] {
  const out: CimBuyer[] = [];
  for (const item of inputs.items) {
    for (const b of cimOnly(item.facts).buyers) {
      // (The loader already restricts the facts to the Buyers filters; this
      // keeps the pure functions right when given unrestricted facts.)
      if (f && f.buyers.length > 0 && !f.buyers.includes(b.accessId)) continue;
      out.push({ item, b });
    }
  }
  return out;
}

// ── Callable ("Worth a call") ─────────────────────────────────────────────

/** Every buyer worth a call on this deal, best lead first (the call list, uncapped). */
export function callableAccessIds(facts: CaptureFacts): string[] {
  return buildCallList([{ deal: { id: facts.dealId, businessName: facts.dealName }, facts: cimOnly(facts) }], Number.MAX_SAFE_INTEGER).map((e) => e.accessId);
}

function callList(items: DashboardItem[], f: EngagementFilters | undefined) {
  return buildCallList(items.map((it) => {
    const cf = cimOnly(it.facts);
    return { deal: it.deal, facts: f && f.buyers.length ? { ...cf, buyers: cf.buyers.filter((b) => f.buyers.includes(b.accessId)) } : cf };
  }), Number.MAX_SAFE_INTEGER);
}

// ── Waiting on you ────────────────────────────────────────────────────────

export interface WaitingItem {
  kind: "question" | "cim_request" | "approval";
  id: string;
  dealId: string;
  dealName: string;
  accessId: string | null;
  name: string;
  company: string | null;
  at: Date;
  note: string | null;
  href: string;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** Teaser "asked for the CIM" requests are approval rows with this source (teaser stream). */
const TEASER_REQUEST_SOURCE = "teaser_request";

/** What waits on the broker: questions nobody answered, CIM requests from the teaser, approvals. Oldest first. */
export function waitingItems(inputs: Pick<BrokerInputs, "deals" | "access" | "questions" | "approvals">, allowed: Set<string> | null = null): WaitingItem[] {
  const dealName = new Map(inputs.deals.map((d) => [d.id, d.businessName]));
  const accessById = new Map(inputs.access.map((a) => [a.id, a]));
  const out: WaitingItem[] = [];
  for (const q of inputs.questions) {
    if (questionWaitingOn(q.status, q.publishedAnswer) !== "broker") continue;
    if (allowed && (!q.accessId || !allowed.has(q.accessId))) continue;
    const a = q.accessId ? accessById.get(q.accessId) : undefined;
    out.push({
      kind: "question", id: q.id, dealId: q.dealId, dealName: dealName.get(q.dealId) ?? "",
      accessId: q.accessId, name: a ? a.buyerName || a.buyerEmail : "A buyer", company: a?.buyerCompany ?? null,
      at: q.askedAt, note: clip(q.text.trim(), 80), href: `/deal/${q.dealId}/qa`,
    });
  }
  for (const r of inputs.approvals) {
    if (allowed && (!r.buyerAccessId || !allowed.has(r.buyerAccessId))) continue;
    out.push({
      kind: r.source === TEASER_REQUEST_SOURCE ? "cim_request" : "approval", id: r.id, dealId: r.dealId, dealName: dealName.get(r.dealId) ?? "",
      accessId: r.buyerAccessId, name: r.buyerName, company: r.buyerCompany, at: r.createdAt, note: null,
      href: `/deal/${r.dealId}/buyers?stage=approval`,
    });
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime() || a.id.localeCompare(b.id));
}

/** "Pacific Coast Logistics: 3 · Beacon Specialty Pharmacy: 1": per deal, linked to its Q&A (or its approvals when nothing else waits there). */
export function waitingByDeal(waiting: WaitingItem[]): NonNullable<Kpi["byDeal"]> {
  const by = new Map<string, { dealId: string; dealName: string; count: number; questions: number }>();
  for (const w of waiting) {
    const d = by.get(w.dealId) ?? { dealId: w.dealId, dealName: w.dealName, count: 0, questions: 0 };
    d.count++;
    if (w.kind === "question") d.questions++;
    by.set(w.dealId, d);
  }
  return Array.from(by.values())
    .sort((a, b) => b.count - a.count || a.dealName.localeCompare(b.dealName))
    .map((d) => ({ dealId: d.dealId, dealName: d.dealName, count: d.count, href: d.questions > 0 ? `/deal/${d.dealId}/qa` : `/deal/${d.dealId}/buyers?stage=approval` }));
}

function sellerPendingCount(questions: QuestionRow[], allowed: Set<string> | null): number {
  return questions.filter((q) => questionWaitingOn(q.status, q.publishedAnswer) === "seller" && (!allowed || (!!q.accessId && allowed.has(q.accessId)))).length;
}

// ── The KPIs ──────────────────────────────────────────────────────────────

export interface KpiOptions {
  range: DashboardRange;
  now: Date;
  scope: "broker" | "deal";
  /** The deal tab's filters (only Buyers / segment are used here). */
  filters?: EngagementFilters;
}

function who(rows: KpiWho[]): { who: KpiWho[]; whoMore: number } {
  return { who: rows.slice(0, KPI_WHO_MAX), whoMore: Math.max(0, rows.length - KPI_WHO_MAX) };
}

function buyerLink(id: KpiId, range: DashboardRange, scope: "broker" | "deal"): Kpi["link"] {
  return scope === "broker" ? { tab: "buyers", query: { kpi: `${id}:${range}` } } : { tab: "buyers_view" };
}

function base(id: KpiId, block: Kpi["block"], range: DashboardRange, scope: "broker" | "deal"): Pick<Kpi, "id" | "block" | "label" | "shortLabel" | "explain" | "rangeBound"> {
  const c = KPI_COPY[id];
  return { id, block, label: c.label(range), shortLabel: c.shortLabel, explain: c.explain(range, scope), rangeBound: block === "period" };
}

/** Latest of a list of times (ms; 0 = none). */
const latest = (xs: number[]) => xs.reduce((m, x) => Math.max(m, x), 0);

/** The access ids the deal tab's Buyers filters allow (null = every buyer). */
export function allowedAccessIds(inputs: Pick<BrokerInputs, "access">, f: EngagementFilters | undefined): Set<string> | null {
  if (!filtered(f)) return null;
  return new Set(inputs.access.filter((a) => accessMatchesFilters(a, f)).map((a) => a.id));
}

export function computeKpis(inputs: BrokerInputs, opts: KpiOptions): { kpis: Kpi[]; callable: string[] } {
  const { range, now, scope, filters } = opts;
  const { since, prevSince } = rangeWindow(range, now);
  const nowMs = now.getTime();
  const inCur = (ms: number) => ms > 0 && (since == null || (ms >= since.getTime() && ms <= nowMs));
  const inPrev = (ms: number) => ms > 0 && since != null && prevSince != null && ms >= prevSince.getTime() && ms < since.getTime();
  const before = (ms: number) => ms > 0 && since != null && ms < since.getTime();
  const allowed = allowedAccessIds(inputs, filters);
  const buyers = cimBuyers(inputs, filters).filter(({ b }) => !allowed || allowed.has(b.accessId));
  const href = (dealId: string, accessId: string) => buyerHref(dealId, accessId);
  const kpis: Kpi[] = [];

  // ── Worth a call (now) ──
  const calls = callList(inputs.items, filters).filter((e) => !allowed || allowed.has(e.accessId));
  const contactedRecently = buyers.filter(({ b }) => b.contactedAt && nowMs - t(b.contactedAt) <= CONTACTED_MS).length;
  kpis.push({
    ...base("to_call", "now", range, scope),
    value: calls.length,
    display: String(calls.length),
    previous: null,
    lastAt: null,
    sub: calls.length > 0 ? `Best lead: ${calls[0].name}` : contactedRecently > 0 ? `${contactedRecently} contacted in the last 2 days` : null,
    ...who(calls.map((e) => ({
      kind: "buyer" as const, accessId: e.accessId, dealId: e.dealId, dealName: e.dealName, name: e.name, company: e.company,
      at: e.lastSeenAt, note: e.statusLabel, href: href(e.dealId, e.accessId),
    }))),
    ids: calls.map((e) => e.accessId),
    breakdown: null,
    sellerPending: null,
    link: buyerLink("to_call", "all", scope),
  });

  // ── Waiting on you (now) ──
  const waiting = waitingItems(inputs, allowed);
  const nQ = waiting.filter((w) => w.kind === "question").length;
  const nR = waiting.filter((w) => w.kind === "cim_request").length;
  const nA = waiting.filter((w) => w.kind === "approval").length;
  const parts = [
    nQ ? plural(nQ, "question") : null,
    nR ? `${nR} asked for the CIM` : null,
    nA ? `${nA} waiting for approval` : null,
  ].filter((x): x is string => !!x);
  const waitSub = waiting.length === 0
    ? null
    : parts.length === 1
      ? `${parts[0]} · oldest from ${dayMonth(waiting[0].at)}`
      : parts.join(" · ");
  const typeLabel = { question: "Question", cim_request: "Asked for the CIM", approval: "Waiting for your approval" } as const;
  kpis.push({
    ...base("waiting", "now", range, scope),
    value: waiting.length,
    display: String(waiting.length),
    previous: null,
    lastAt: null,
    sub: waitSub,
    ...who(waiting.map((w) => ({
      kind: w.kind === "question" ? ("question" as const) : w.kind === "cim_request" ? ("cim_request" as const) : ("approval" as const),
      accessId: w.accessId, dealId: w.dealId, dealName: w.dealName, name: w.name, company: w.company,
      at: w.at.toISOString(), note: w.kind === "question" ? w.note : typeLabel[w.kind], href: w.href,
    }))),
    ids: null,
    breakdown: [
      { label: "Questions waiting for your answer", count: nQ },
      { label: "Asked for the CIM", count: nR },
      { label: "Waiting for your approval", count: nA },
    ],
    sellerPending: sellerPendingCount(inputs.questions, allowed),
    byDeal: waitingByDeal(waiting),
    link: scope === "deal" ? { tab: "qa" } : null,
  });

  // ── Opened the CIM (deal only, period) ──
  if (scope === "deal") {
    const granted = buyers.length;
    const openers = buyers.filter(({ b }) => openedCim(b));
    if (range === "all") {
      const notYet = buyers.filter(({ b }) => !openedCim(b));
      kpis.push({
        ...base("opened", "period", range, scope),
        value: openers.length,
        display: `${openers.length} of ${granted}`,
        previous: null,
        lastAt: null,
        sub: granted === 0 ? null : notYet.length === 0 ? "everyone has opened it" : `${notYet.length} ${notYet.length === 1 ? "hasn't" : "haven't"} yet`,
        ...who(notYet
          .sort((x, y) => t(x.b.grantedAt) - t(y.b.grantedAt))
          .map(({ item, b }) => ({
            kind: "buyer" as const, accessId: b.accessId, dealId: item.deal.id, dealName: item.deal.businessName, name: b.name, company: b.company,
            at: b.grantedAt, note: `Access given ${dayMonth(b.grantedAt)}`, href: href(item.deal.id, b.accessId),
          }))),
        ids: openers.map(({ b }) => b.accessId),
        breakdown: null,
        sellerPending: null,
        link: buyerLink("opened", range, scope),
      });
    } else {
      const firstOf = (b: BuyerReadingFacts) => t(firstOpenAt(b));
      const cur = buyers.filter(({ b }) => inCur(firstOf(b)));
      const prev = buyers.filter(({ b }) => inPrev(firstOf(b))).length;
      const lastBefore = latest(buyers.map(({ b }) => firstOf(b)).filter(before));
      kpis.push({
        ...base("opened", "period", range, scope),
        value: cur.length,
        display: String(cur.length),
        previous: prev,
        lastAt: lastBefore ? new Date(lastBefore).toISOString() : null,
        sub: cur.length === 0 && lastBefore
          ? `last on ${dayMonth(lastBefore)}`
          : `${openers.length} of ${granted} so far`,
        ...who(cur
          .sort((x, y) => firstOf(y.b) - firstOf(x.b))
          .map(({ item, b }) => ({
            kind: "buyer" as const, accessId: b.accessId, dealId: item.deal.id, dealName: item.deal.businessName, name: b.name, company: b.company,
            at: firstOpenAt(b), note: "First opened", href: href(item.deal.id, b.accessId),
          }))),
        ids: cur.map(({ b }) => b.accessId),
        breakdown: null,
        sellerPending: null,
        link: buyerLink("opened", range, scope),
      });
    }
  }

  // ── Buyers who read (period) ──
  {
    const lastActive = (b: BuyerReadingFacts, pred: (ms: number) => boolean) =>
      latest(activeVisits(b).map((v) => t(v.lastSeenAt)).filter(pred));
    const cur = buyers.filter(({ b }) => (since == null ? hasReadCim(b) : lastActive(b, inCur) > 0));
    const prev = since == null ? null : buyers.filter(({ b }) => lastActive(b, inPrev) > 0).length;
    const lastBefore = since == null ? 0 : latest(buyers.map(({ b }) => lastActive(b, before)));
    const lastEver = latest(buyers.map(({ b }) => lastActive(b, (ms) => ms > 0)));
    const value = cur.length;
    // The "of N" counts the SAME links the value can count: every CIM link
    // ever given, removed ones included (a removed buyer's reading still
    // counts), so the value can never exceed it.
    const givenCim = buyers.length;
    let sub: string | null;
    if (value === 0 && lastBefore) sub = `last on ${dayMonth(lastBefore)}`;
    else if (scope === "broker") sub = `of ${givenCim} given the CIM`;
    else if (range === "all") sub = lastEver ? `last on ${dayMonth(lastEver)}` : null;
    else sub = deltaWords(value, prev, range);
    kpis.push({
      ...base("reading", "period", range, scope),
      value,
      display: String(value),
      previous: prev,
      lastAt: lastBefore ? new Date(lastBefore).toISOString() : null,
      sub,
      ...who(cur
        .map(({ item, b }) => {
          const vs = activeVisits(b).filter((v) => since == null || inCur(t(v.lastSeenAt)));
          const last = vs.reduce<VisitFacts | null>((m, v) => (!m || t(v.lastSeenAt) > t(m.lastSeenAt) ? v : m), null);
          const ms = vs.reduce((s, v) => s + v.activeMs, 0);
          const row: KpiWho = {
            kind: "buyer", accessId: b.accessId, dealId: item.deal.id, dealName: item.deal.businessName, name: b.name, company: b.company,
            at: last?.lastSeenAt ?? null, note: `${formatReadingTime(ms)} reading`, href: href(item.deal.id, b.accessId),
          };
          if (last && isSampleVisit(last)) row.sample = true;
          return row;
        })
        .sort((x, y) => t(y.at) - t(x.at))),
      ids: cur.map(({ b }) => b.accessId),
      breakdown: null,
      sellerPending: null,
      link: buyerLink("reading", range, scope),
    });
  }

  // ── NDAs signed (period; any level, teaser included) ──
  {
    const teaserRows = inputs.access.filter((a) => isTeaserOnly(a.accessLevel) && (!allowed || allowed.has(a.id)));
    const dealName = new Map(inputs.deals.map((d) => [d.id, d.businessName]));
    type Signer = { dealId: string; accessId: string; name: string; company: string | null; at: number };
    const signers: Signer[] = [
      ...buyers.filter(({ b }) => !!b.ndaSignedAt).map(({ item, b }) => ({ dealId: item.deal.id, accessId: b.accessId, name: b.name, company: b.company, at: t(b.ndaSignedAt) })),
      ...teaserRows.filter((a) => !!a.ndaSignedAt).map((a) => ({ dealId: a.dealId, accessId: a.id, name: a.buyerName || a.buyerEmail, company: a.buyerCompany, at: a.ndaSignedAt!.getTime() })),
    ];
    const cur = signers.filter((s) => inCur(s.at));
    const prev = since == null ? null : signers.filter((s) => inPrev(s.at)).length;
    const lastBefore = since == null ? 0 : latest(signers.map((s) => s.at).filter(before));
    kpis.push({
      ...base("nda", "period", range, scope),
      value: cur.length,
      display: String(cur.length),
      previous: prev,
      lastAt: lastBefore ? new Date(lastBefore).toISOString() : null,
      sub: cur.length === 0 && lastBefore ? `last on ${dayMonth(lastBefore)}` : deltaWords(cur.length, prev, range),
      ...who(cur.sort((x, y) => y.at - x.at).map((s) => ({
        kind: "buyer" as const, accessId: s.accessId, dealId: s.dealId, dealName: dealName.get(s.dealId) ?? "", name: s.name, company: s.company,
        at: new Date(s.at).toISOString(), note: `Signed ${dayMonth(s.at)}`, href: href(s.dealId, s.accessId),
      }))),
      ids: cur.map((s) => s.accessId),
      breakdown: null,
      sellerPending: null,
      link: buyerLink("nda", range, scope),
    });
  }

  // ── Said interested (period) ──
  {
    const interested = buyers.filter(({ b }) => b.decision === "interested");
    const at = (b: BuyerReadingFacts) => t(b.decisionAt);
    const cur = interested.filter(({ b }) => since == null || inCur(at(b)));
    const prev = since == null ? null : interested.filter(({ b }) => inPrev(at(b))).length;
    const lastBefore = since == null ? 0 : latest(interested.map(({ b }) => at(b)).filter(before));
    const inDd = buyers.filter(({ b }) => accessLevelRank(b.accessLevel) === 3 && !b.revokedAt).length;
    // Still deciding after asking for more time (a later final answer supersedes it).
    const deciding = new Set(buyers.filter(({ b }) => !FINAL.has(b.decision)).map(({ b }) => b.accessId));
    const moreTime = new Set(inputs.decisions
      .filter((d) => d.decision === "need_more_time" && deciding.has(d.accessId) && inCur(d.at.getTime()))
      .map((d) => d.accessId)).size;
    const accessById = new Map(inputs.access.map((a) => [a.id, a]));
    let sub: string | null;
    if (cur.length === 0 && lastBefore) sub = `last on ${dayMonth(lastBefore)}`;
    else if (inDd > 0) sub = `${inDd} in due diligence`;
    else if (moreTime > 0) sub = `${moreTime} asked for more time`;
    else sub = deltaWords(cur.length, prev, range);
    kpis.push({
      ...base("interested", "period", range, scope),
      value: cur.length,
      display: String(cur.length),
      previous: prev,
      lastAt: lastBefore ? new Date(lastBefore).toISOString() : null,
      sub,
      ...who(cur.sort((x, y) => at(y.b) - at(x.b)).map(({ item, b }) => ({
        kind: "buyer" as const, accessId: b.accessId, dealId: item.deal.id, dealName: item.deal.businessName, name: b.name, company: b.company,
        at: b.decisionAt, note: nextStepWords(accessById.get(b.accessId)?.decisionNextStep), href: href(item.deal.id, b.accessId),
      }))),
      ids: cur.map(({ b }) => b.accessId),
      breakdown: null,
      sellerPending: null,
      link: buyerLink("interested", range, scope),
    });
  }

  return { kpis, callable: calls.map((e) => e.accessId) };
}

// ── Heads-up lines ────────────────────────────────────────────────────────

/**
 * One name per buyer, in order (release review UX-F10: "Natalie Vasconcelos,
 * Natalie Vasconcelos and 4 more"): links of the same person (same email) are
 * grouped — "Natalie Vasconcelos (2 deals)" — and two different people with
 * the same name are told apart by the deal ("Sam Lee (Beacon Specialty
 * Pharmacy)"). Pure.
 */
export function buyerNameList(rows: ReadonlyArray<CimBuyer>): string[] {
  const groups: Array<{ name: string; email: string; deals: string[]; dealNames: string[] }> = [];
  for (const { b, item } of rows) {
    const email = (b.email ?? "").trim().toLowerCase();
    const g = groups.find((x) => (email ? x.email === email : x.name === b.name));
    if (g) {
      if (!g.deals.includes(item.deal.id)) { g.deals.push(item.deal.id); g.dealNames.push(item.deal.businessName); }
      continue;
    }
    groups.push({ name: b.name, email, deals: [item.deal.id], dealNames: [item.deal.businessName] });
  }
  return groups.map((g) => {
    if (g.deals.length > 1) return `${g.name} (${g.deals.length} deals)`;
    const twin = groups.some((o) => o !== g && o.name === g.name);
    return twin ? `${g.name} (${g.dealNames[0]})` : g.name;
  });
}

function namesWords(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}

/**
 * The buyers behind the two built-in heads-up lines, uncapped: CIM links on
 * LIVE deals only (a buyer can't open an unpublished CIM), never teaser-only
 * links, never removed links.
 *   expiring     the link runs out within the next 7 days, and the buyer
 *                hasn't said no or let the decision lapse (an Interested or
 *                "more time" buyer is warned about too: those are the links
 *                a broker most needs to extend in time; the same rule as
 *                linkRanOut, so a warning always comes before the chip)
 *   not_opened   never opened, 3+ days after access was given
 * The line's number, its "See them" list (`?notice=<id>` → exactly these
 * ids) and the response's `noticeIds` are all this one set.
 */
export function noticeSets(inputs: Pick<BrokerInputs, "items">, now: Date): Record<NoticeId, CimBuyer[]> {
  const nowMs = now.getTime();
  const live = cimBuyers({ items: inputs.items.filter((it) => it.live) }, undefined);
  const expiring = live
    .filter(({ b }) => !b.revokedAt && !!b.expiresAt && !DECLINED.has(b.decision))
    .filter(({ b }) => { const e = t(b.expiresAt); return e > nowMs && e - nowMs <= 7 * DAY; })
    .sort((x, y) => t(x.b.expiresAt) - t(y.b.expiresAt));
  const notOpened = live
    .filter(({ b }) => !b.revokedAt && !openedCim(b) && nowMs - t(b.grantedAt) >= HEADS_UP_NOT_OPENED_DAYS * DAY)
    .sort((x, y) => t(x.b.grantedAt) - t(y.b.grantedAt));
  return { expiring, not_opened: notOpened };
}

/** `noticeIds` on the overview response: each built-in line's exact access ids. */
export function noticeIds(inputs: Pick<BrokerInputs, "items">, now: Date): Record<NoticeId, string[]> {
  const sets = noticeSets(inputs, now);
  return { expiring: sets.expiring.map(({ b }) => b.accessId), not_opened: sets.not_opened.map(({ b }) => b.accessId) };
}

/**
 * The 1–2 lines under the numbers: registered sources first (data room),
 * then links running out within 7 days, then buyers who haven't opened 3
 * days after you gave access (noticeSets). Each built-in line carries the
 * exact ids it counted; "See them" opens exactly those buyers.
 */
export function headsUp(inputs: Pick<BrokerInputs, "items">, now: Date, extra: HeadsUp[] = [], max = 2): HeadsUp[] {
  const sets = noticeSets(inputs, now);
  const out: HeadsUp[] = [...extra];
  if (sets.expiring.length > 0) {
    const names = buyerNameList(sets.expiring);
    const n = sets.expiring.length;
    out.push({
      id: "expiring",
      count: n,
      text: `${n} buyer link${n === 1 ? " runs" : "s run"} out in the next 7 days: ${namesWords(names)}.`,
      names: names.slice(0, 20),
      link: "/broker/analytics?tab=buyers&notice=expiring",
      ids: sets.expiring.map(({ b }) => b.accessId),
    });
  }
  if (sets.not_opened.length > 0) {
    const n = sets.not_opened.length;
    out.push({
      id: "not_opened",
      count: n,
      text: `${n} buyer${n === 1 ? " hasn't" : "s haven't"} opened their link ${HEADS_UP_NOT_OPENED_DAYS} days after you gave it.`,
      names: buyerNameList(sets.not_opened).slice(0, 20),
      link: "/broker/analytics?tab=buyers&notice=not_opened",
      ids: sets.not_opened.map(({ b }) => b.accessId),
    });
  }
  return out.slice(0, max);
}

/**
 * CIM links that have run out (accessId → expiry): not removed, and not a
 * buyer who said no or didn't respond (those are out of every call list
 * anyway). They stay listed with "Link ran out" and Extend.
 */
export function linkRanOut(access: Pick<AccessRow, "id" | "accessLevel" | "expiresAt" | "revokedAt" | "decision">[], now: Date): LinkRanOut {
  const out: LinkRanOut = {};
  const nowMs = now.getTime();
  for (const a of access) {
    if (!seesCim(a.accessLevel) || a.revokedAt || !a.expiresAt) continue;
    if (a.decision && DECLINED.has(a.decision)) continue;
    if (a.expiresAt.getTime() <= nowMs) out[a.id] = a.expiresAt.toISOString();
  }
  return out;
}

// ── Last activity ─────────────────────────────────────────────────────────

const DECISION_WORDS: Record<string, string> = {
  interested: "chose Interested on",
  not_interested: "chose Not interested on",
  lapsed: "didn't decide in time on",
};

/**
 * The latest thing that happened, over every counted deal: a visit, a
 * question, an NDA signature, a final decision, a request for the CIM.
 * "Gurdeep Randhawa read Pacific Coast Logistics".
 */
export function lastActivity(
  inputs: Pick<BrokerInputs, "items" | "access" | "questions" | "deals">,
  /** The deal tab's Buyers filter: only these links' activity (null = everyone). */
  allowed: Set<string> | null = null,
): { at: Date; text: string; dealId: string } | null {
  let best: { at: number; text: string; dealId: string } | null = null;
  const consider = (at: number, text: string, dealId: string) => {
    if (at > 0 && (!best || at > best.at)) best = { at, text, dealId };
  };
  const ok = (accessId: string | null | undefined) => !allowed || (!!accessId && allowed.has(accessId));
  const dealName = new Map(inputs.deals.map((d) => [d.id, d.businessName]));
  for (const it of inputs.items) {
    const name = it.deal.businessName;
    for (const b of cimOnly(it.facts).buyers) {
      if (!ok(b.accessId)) continue;
      for (const v of b.visits) consider(t(v.lastSeenAt), `${b.name} ${v.activeMs >= READING_RULES.readerMinMs ? "read" : "opened"} ${name}`, it.deal.id);
      for (const q of b.questions) consider(t(q.askedAt), `${b.name} asked a question about ${name}`, it.deal.id);
    }
  }
  for (const a of inputs.access) {
    if (!ok(a.id)) continue;
    const who = a.buyerName || a.buyerEmail;
    const name = dealName.get(a.dealId) ?? "";
    if (a.ndaSignedAt) consider(a.ndaSignedAt.getTime(), `${who} signed the NDA for ${name}`, a.dealId);
    if (a.decisionAt && a.decision && DECISION_WORDS[a.decision]) consider(a.decisionAt.getTime(), `${who} ${DECISION_WORDS[a.decision]} ${name}`, a.dealId);
    for (const e of a.accessEvents) if (e.type === "cim_requested") consider(t(e.at), `${who} asked for the CIM of ${name}`, a.dealId);
  }
  for (const q of inputs.questions) {
    if (!ok(q.accessId)) continue;
    const a = inputs.access.find((x) => x.id === q.accessId);
    consider(q.askedAt.getTime(), `${a ? a.buyerName || a.buyerEmail : "A buyer"} asked a question about ${dealName.get(q.dealId) ?? ""}`, q.dealId);
  }
  const b = best as { at: number; text: string; dealId: string } | null;
  return b ? { at: new Date(b.at), text: b.text, dealId: b.dealId } : null;
}

// ── The Buyers view's groups (deal tab) ───────────────────────────────────

/**
 * The Buyers view's list, on the SAME facts as the cards (the When and
 * Buyers filters): Worth a call (call order) · Still reading, not yet a
 * lead · No reading in this period (date filter only) · Said no or didn't
 * respond · Access removed · Not opened yet (never opened, whatever the
 * period). CIM links only. Device and version never move anyone between
 * groups (they change what a card shows).
 */
export function buyerGroups(windowFactsIn: CaptureFacts, allFactsIn: CaptureFacts): BuyerGroups {
  const windowFacts = cimOnly(windowFactsIn);
  const allFacts = cimOnly(allFactsIn);
  const ctx = insightContext(windowFacts);
  const order = new Map(rankBuyers(windowFacts.buyers.map((f) => ({ facts: f, insight: buyerInsight(f, ctx) })))
    .map((x, i) => [x.facts.accessId, i]));
  const callable = callableAccessIds(windowFacts);
  const callRank = new Map(callable.map((id, i) => [id, i]));
  const win = new Map(windowFacts.buyers.map((b) => [b.accessId, b]));
  const rangeAll = windowFacts.filters.range === "all";
  // Opened in the period (a blocked tracker leaves only the first-view stamp) → still "reading".
  const sinceMs = filterSince(windowFacts.filters, new Date(windowFacts.now))?.getTime() ?? 0;
  const groups: BuyerGroups = { worthACall: [], reading: [], quietInRange: [], declined: [], revoked: [], notOpened: [] };
  const row = (b: BuyerReadingFacts, w: BuyerReadingFacts | undefined): GroupRow => ({
    accessId: b.accessId,
    name: b.name,
    company: b.company,
    accessLevel: b.accessLevel,
    grantedAt: b.grantedAt,
    ndaSigned: !!b.ndaSignedAt,
    lastSeenAt: b.visits.reduce<string | null>((m, v) => (!m || t(v.lastSeenAt) > t(m) ? v.lastSeenAt : m), null),
    hasCard: !!w && (w.visits.length > 0 || (rangeAll && !!w.firstViewedAt)),
  });
  for (const b of allFacts.buyers) {
    const w = win.get(b.accessId);
    const r = row(b, w);
    if (b.revokedAt) groups.revoked.push(r);
    else if (DECLINED.has(b.decision)) groups.declined.push(r);
    else if (!openedCim(b)) groups.notOpened.push(r);
    else if (callRank.has(b.accessId)) groups.worthACall.push(r);
    else if (rangeAll || (w && w.visits.length > 0) || t(firstOpenAt(b)) >= sinceMs) groups.reading.push(r);
    else groups.quietInRange.push(r);
  }
  const byOrder = (a: GroupRow, b: GroupRow) => (order.get(a.accessId) ?? 1e9) - (order.get(b.accessId) ?? 1e9) || a.name.localeCompare(b.name);
  groups.worthACall.sort((a, b) => (callRank.get(a.accessId) ?? 0) - (callRank.get(b.accessId) ?? 0));
  groups.reading.sort(byOrder);
  groups.quietInRange.sort((a, b) => t(b.lastSeenAt) - t(a.lastSeenAt) || a.name.localeCompare(b.name));
  groups.declined.sort(byOrder);
  groups.revoked.sort(byOrder);
  groups.notOpened.sort((a, b) => t(a.grantedAt) - t(b.grantedAt) || a.name.localeCompare(b.name));
  return groups;
}

/** Used by tests and the deal response: a deal's KPI value by id. */
export function kpiValue(kpis: Kpi[], id: KpiId): number {
  return kpis.find((k) => k.id === id)?.value ?? 0;
}
