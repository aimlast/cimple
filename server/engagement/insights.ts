/**
 * Engagement intelligence — pure functions over DealReadingFacts
 * (shared/analytics-v2.ts). No I/O, no AI, no clock except `ctx.now`:
 * every rule is unit-testable (tests/unit/engagement-insights.test.ts).
 * Owned by the INTELLIGENCE stream (signals, talking points, status, call
 * priority, headlines, journey moments). The capture stream's routes call
 * these; the signatures are the contract.
 *
 * Wording rules: seconds and minutes, never percent-of-max; suggestive,
 * never diagnostic ("Be ready to go through each add-back", never "they
 * are worried about the add-backs"); every talking point quotes its evidence.
 *
 *   status      what the buyer is doing, in words (first match wins):
 *               Reading now · Interested / Not interested / No response ·
 *               Hot · Went quiet · Warming up · Only skimmed · Opened ·
 *               Not opened yet — "Contacted today" replaces the reading
 *               status for 48 h after the broker marks a call.
 *   intent      0–1: how seriously they read (study ratio, depth, return
 *               visits, the money pages, questions).
 *   priority    intent × fit × recency × openness — the call order, never
 *               shown as a number.
 *   signals     15 kinds, each with evidence in seconds, pages and counts;
 *               the strongest three (one per topic) become talking points.
 */
import {
  BUYER_STATUS_TEXT,
  READING_RULES,
  formatReadingTime,
  viewerPageKey,
  type BuyerInsight,
  type BuyerQuestionRef,
  type BuyerReadingFacts,
  type BuyerStatus,
  type DocumentPage,
  type FactPage,
  type KeyMoment,
  type PageReading,
  type PageRef,
  type PageRole,
  type ReachPoint,
  type ReadLabel,
  type Signal,
  type SignalId,
  type TalkingPoint,
  type VisitFacts,
} from "@shared/analytics-v2";
import { quoteStart } from "@shared/cim-blocks";
import { pageReadLabel, studyRatio, timesWord } from "@shared/cim-reading-model";

export interface InsightContext {
  now: Date;
  /** The document's viewer pages (real titles), in order. */
  pages: FactPage[];
  /** Every buyer in the current filter (for "3× the other readers" comparisons). */
  buyers: BuyerReadingFacts[];
}

// ── Tunable rules (one place) ────────────────────────────────────────────

export const INSIGHT_RULES = {
  /** Intent weights (sum 1). */
  intentWeights: { study: 0.35, depth: 0.2, revisits: 0.15, money: 0.15, questions: 0.15 },
  /** Study ratio that counts as full marks. */
  studyCap: 1.5,
  hotIntent: 0.6,
  warmIntent: 0.3,
  /** Hot needs activity this recent. */
  hotWithinMs: 72 * 3_600_000,
  /** Went quiet: no visit for this long while still under review. */
  quietAfterMs: 5 * 86_400_000,
  /** Recency half-life-ish: exp(−days / recencyDays). */
  recencyDays: 5,
  /** A "Mark contacted" lowers priority and shows "Contacted today" this long. */
  contactedMs: 48 * 3_600_000,
  /** Only skimmed: under this share of the CIM's expected reading time, in one visit. */
  skimmedShare: 0.2,
  /** Completed: reached the last content page with at least this share of the expected time. */
  completedShare: 0.5,
  /** Outlier: this many times the other readers' median, with at least this many other readers. */
  outlierTimes: 3,
  outlierMinReaders: 3,
  outlierMinMs: 20_000,
  /** Locked interest: this many clicks, or this much time on locked pages. */
  lockedClicks: 2,
  lockedMs: 20_000,
  /** Normalized toggle signal needs this many switches. */
  normalizedToggles: 2,
  /** Several places: this many networks, or device/browser combinations. */
  places: 3,
} as const;

const DAY = 86_400_000;
const TZ = "America/Toronto";
const MONEY_ROLES: ReadonlySet<PageRole> = new Set<PageRole>(["financials", "normalization", "transaction"]);
const FIN_ROLES: ReadonlySet<PageRole> = new Set<PageRole>(["financials", "normalization"]);

// ── Small helpers ────────────────────────────────────────────────────────

const ms = (iso: string | null | undefined): number => (iso ? Date.parse(iso) || 0 : 0);

function dayKey(t: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(t);
}

/** "today", "yesterday", "3 days ago", "on 12 Sep" (broker's calendar days, Toronto). */
export function whenText(t: number, now: Date): string {
  if (!t) return "";
  const days = Math.round((Date.parse(dayKey(now.getTime())) - Date.parse(dayKey(t))) / DAY);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return `on ${new Intl.DateTimeFormat("en-GB", { timeZone: TZ, day: "numeric", month: "short" }).format(t)}`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function listWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function capitalise(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** A page as it is spoken about for one buyer (a blind buyer's pages carry the titles THEY saw). */
type SpokenPage = FactPage & { realTitle?: string };

/**
 * The pages with the words to use about this buyer. A blind buyer saw
 * codename titles: every "why" line and talking point about them quotes
 * the title they saw (never the real one — the broker may say it aloud to
 * them); the real title rides along on page refs as broker-only context.
 * A page with no known blind title is called "page N".
 */
export function pagesForBuyer(b: Pick<BuyerReadingFacts, "mode">, pages: FactPage[]): FactPage[] {
  if (b.mode !== "blind") return pages;
  return pages.map((p): SpokenPage => ({ ...p, title: p.blindTitle || `page ${p.label}`, realTitle: p.title }));
}

export function pageRefOf(p: Pick<FactPage, "pageId" | "part" | "label" | "title"> & { realTitle?: string }): PageRef {
  if (p.realTitle !== undefined) return { pageId: p.pageId, part: p.part, label: p.label, title: p.realTitle, servedTitle: p.title };
  return { pageId: p.pageId, part: p.part, label: p.label, title: p.title };
}

/** "Row: Adjusted EBITDA" → the row “Adjusted EBITDA”. */
export function blockPhrase(label: string): string {
  const m = /^([A-Za-z][A-Za-z ]{1,24}): (.+)$/.exec(label.trim());
  if (!m) return label.charAt(0).toLowerCase() + label.slice(1);
  const rest = m[2].replace(/^"(.*)"$/, "$1");
  return `the ${m[1].toLowerCase()} “${rest}”`;
}

function lastSeenOf(b: BuyerReadingFacts): number {
  return b.visits.reduce((m, v) => Math.max(m, ms(v.lastSeenAt)), 0);
}

function lastActivityOf(b: BuyerReadingFacts): number {
  const q = b.questions.reduce((m, x) => Math.max(m, ms(x.askedAt)), 0);
  return Math.max(lastSeenOf(b), q);
}

function isContent(p: FactPage): boolean {
  return p.role !== "front_matter";
}

function readingOf(b: BuyerReadingFacts, p: Pick<FactPage, "pageId" | "part">): PageReading | undefined {
  return b.pages[viewerPageKey(p.pageId, p.part)];
}

/** Page ids in document order (the rendition's pageOrder, which maxPageIndex indexes). */
function pageOrder(pages: FactPage[]): Map<string, number> {
  const order = new Map<string, number>();
  for (const p of [...pages].sort((a, b) => a.index - b.index)) if (!order.has(p.pageId)) order.set(p.pageId, order.size);
  return order;
}

interface PageRow {
  page: FactPage;
  attention: number;
  visits: number;
  reached: boolean;
  label: ReadLabel | null;
}

/** How one buyer read every page (reached = on screen at all, or before their furthest point). */
function pageRows(b: BuyerReadingFacts, pages: FactPage[]): PageRow[] {
  const order = pageOrder(pages);
  const furthest = b.visits.reduce((m, v) => Math.max(m, v.maxPageIndex ?? -1), -1);
  return pages.map((page) => {
    const r = readingOf(b, page);
    const attention = r?.attentionMs ?? 0;
    const onScreen = !!r && r.attentionMs + r.skimMs + r.visibleMs > 0;
    const reached = onScreen || (furthest >= 0 && (order.get(page.pageId) ?? Infinity) <= furthest);
    return { page, attention, visits: r?.visits ?? 0, reached, label: pageReadLabel(page.role, attention, page.expectedMs, reached) };
  });
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Seconds per page along a visit's path: [pageId, seconds][] in path order. */
export function pathDurations(v: Pick<VisitFacts, "path" | "activeMs" | "wallMs">): Array<{ pageId: string; startSec: number; seconds: number }> {
  const path = v.path ?? [];
  const endSec = Math.max(path.length ? path[path.length - 1][0] : 0, Math.round((v.activeMs || v.wallMs || 0) / 1000));
  return path.map(([t, pageId], i) => {
    const next = i + 1 < path.length ? path[i + 1][0] : Math.max(t, endSec);
    return { pageId, startSec: t, seconds: Math.max(0, next - t) };
  });
}

/** Distinct pages of a visit's path by seconds (front matter excluded), most first. */
function visitTopPages(v: VisitFacts, pages: FactPage[], min = 5): FactPage[] {
  const byId = new Map<string, number>();
  for (const s of pathDurations(v)) byId.set(s.pageId, (byId.get(s.pageId) ?? 0) + s.seconds);
  const first = new Map<string, FactPage>();
  for (const p of pages) if (!first.has(p.pageId)) first.set(p.pageId, p);
  return Array.from(byId.entries())
    .filter(([id, s]) => s >= min && first.get(id) && isContent(first.get(id)!))
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => first.get(id)!);
}

// ── Signals ──────────────────────────────────────────────────────────────

interface Sig extends Signal {
  /** A fragment for the one-line "why" ("studied the financials for 6 min"). */
  short: string;
  /** The talking point (null = evidence only). */
  talk: string | null;
  /** Talking points are one per topic: the page role, or the signal's own kind. */
  topic: string;
}

const ROLE_TALK: Partial<Record<PageRole, { talk: string; short: string }>> = {
  customers: { talk: "Have the top-customer retention story ready.", short: "studied the customer pages" },
  location: { talk: "Confirm the lease renewal option before you call.", short: "studied the lease and location" },
  owner_transition: { talk: "Be ready to explain the owner's transition plan.", short: "read the transition plan closely" },
  employees: { talk: "Be ready to talk about the key staff and who stays after the sale.", short: "studied the team pages" },
};

/**
 * Which earnings figure the deal leads with, from its normalization pages
 * (their titles and row labels): "sde" (Seller's Discretionary Earnings),
 * "ebitda", or null when there is no normalization page. SDE wins when a
 * page is about SDE — a dental practice's bridge must not be called EBITDA.
 */
export function earningsBasis(pages: ReadonlyArray<Pick<FactPage, "role" | "title" | "blocks">>): "sde" | "ebitda" | null {
  const norm = pages.filter((p) => p.role === "normalization");
  if (norm.length === 0) return null;
  const text = (p: Pick<FactPage, "title" | "blocks">) => [p.title, ...p.blocks.map((b) => b.label)].join(" ");
  const SDE = /\bSDE\b|discretionary/i;
  const EBITDA = /\bEBITDA\b/i;
  if (norm.some((p) => SDE.test(p.title))) return "sde";
  if (norm.some((p) => EBITDA.test(p.title))) return "ebitda";
  const all = norm.map(text).join(" ");
  if (SDE.test(all) && !EBITDA.test(all)) return "sde";
  if (EBITDA.test(all)) return "ebitda";
  return null;
}

function studiedIn(rows: PageRow[], roles: ReadonlySet<PageRole>): PageRow[] {
  return rows.filter((r) => roles.has(r.page.role) && r.label === "studied");
}

function names(rows: PageRow[], n = 2): string {
  const top = [...rows].sort((a, b) => b.attention - a.attention).slice(0, n);
  const more = rows.length - top.length;
  return listWords(top.map((r) => r.page.title)) + (more > 0 ? ` and ${plural(more, "other page")}` : "");
}

function sumAtt(rows: PageRow[]): number {
  return rows.reduce((s, r) => s + r.attention, 0);
}
function sumExp(rows: PageRow[]): number {
  return rows.reduce((s, r) => s + r.page.expectedMs, 0);
}

interface BuyerCore {
  rows: PageRow[];
  content: PageRow[];
  intent: number;
  lastSeen: number;
  lastActivity: number;
  totalAttention: number;
  totalExpected: number;
  readingNow: boolean;
  visits: VisitFacts[];
}

function coreOf(b: BuyerReadingFacts, ctx: InsightContext): BuyerCore {
  const W = INSIGHT_RULES.intentWeights;
  const rows = pageRows(b, ctx.pages);
  const content = rows.filter((r) => isContent(r.page) && !r.page.locked);
  const reached = content.filter((r) => r.reached);
  const visits = [...b.visits].sort((x, y) => ms(x.startedAt) - ms(y.startedAt));
  const totalAttention = sumAtt(rows);
  const totalExpected = sumExp(content);
  const lastSeen = lastSeenOf(b);
  const now = ctx.now.getTime();

  let intent = 0;
  if (visits.length > 0) {
    const ratio = reached.length ? studyRatio(sumAtt(reached), sumExp(reached)) : studyRatio(totalAttention, totalExpected);
    const study = Math.min(ratio, INSIGHT_RULES.studyCap) / INSIGHT_RULES.studyCap;
    const depth = content.length ? reached.length / content.length : 0;
    const revisits = Math.min(Math.max(visits.length - 1, 0), 3) / 3;
    const money = content.filter((r) => MONEY_ROLES.has(r.page.role));
    const moneyScore = money.length
      ? money.reduce((s, r) => s + (r.label === "studied" ? 1 : r.label === "read" ? 0.6 : r.label === "glanced" ? 0.2 : 0), 0) / money.length
      : 0;
    const questions = Math.min(b.questions.length, 3) / 3;
    intent = W.study * study + W.depth * depth + W.revisits * revisits + W.money * moneyScore + W.questions * questions;
    intent = Math.max(0, Math.min(1, Math.round(intent * 1000) / 1000));
  }
  return {
    rows, content, intent, lastSeen, lastActivity: lastActivityOf(b), totalAttention, totalExpected,
    readingNow: lastSeen > 0 && now - lastSeen <= READING_RULES.readingNowMs, visits,
  };
}

function isUndecided(decision: string): boolean {
  return !decision || decision === "under_review" || decision === "need_more_time";
}

function signalsOf(b: BuyerReadingFacts, core: BuyerCore, ctx: InsightContext): Sig[] {
  const R = INSIGHT_RULES;
  const now = ctx.now;
  const out: Sig[] = [];
  const { content, visits } = core;
  if (visits.length === 0) return out;
  const firstPage = new Map<string, FactPage>();
  for (const p of ctx.pages) if (!firstPage.has(p.pageId)) firstPage.set(p.pageId, p);
  const pageOfId = (id: string | null | undefined) => (id ? firstPage.get(id) ?? null : null);

  // 1. financial_deep_dive — the money pages Studied, or read on two visits.
  const fin = content.filter((r) => FIN_ROLES.has(r.page.role));
  const finStudied = studiedIn(fin, FIN_ROLES);
  const finRepeat = fin.filter((r) => r.visits >= 2 && r.attention >= READING_RULES.readerMinMs);
  if (finStudied.length > 0 || finRepeat.length > 0) {
    const read = fin.filter((r) => r.attention >= READING_RULES.readerMinMs);
    const time = formatReadingTime(sumAtt(read));
    const vis = Math.max(...read.map((r) => r.visits), 1);
    const over = vis >= 2 ? ` over ${plural(vis, "visit")}` : "";
    const basis = earningsBasis(ctx.pages);
    out.push({
      id: "financial_deep_dive",
      strength: 0.55 + 0.35 * Math.min(1, studyRatio(sumAtt(read), sumExp(read)) / 3),
      evidence: `Studied ${names(read)} for ${time}${over}.`,
      pageRefs: read.map((r) => pageRefOf(r.page)),
      short: `studied the financials for ${time}${over}`,
      talk: `They studied the numbers (${time}). Offer to walk through ${basis === "sde" ? "the SDE build-up" : basis === "ebitda" ? "the adjusted EBITDA" : "the financials"} with your accountant on the call.`,
      topic: "financials",
    });
  }

  // 2. normalized_toggle — switched the statements to Normalized.
  const toggles = b.events.filter((e) => e.type === "financial_view" && e.detail === "normalized");
  if (toggles.length >= R.normalizedToggles) {
    const pages = Array.from(new Set(toggles.map((e) => e.pageId))).map(pageOfId).filter((p): p is FactPage => !!p);
    out.push({
      id: "normalized_toggle",
      strength: 0.7,
      evidence: `Switched the financial tables to Normalized ${toggles.length} times${pages.length ? ` (${listWords(pages.map((p) => `page ${p.label} · ${p.title}`))})` : ""}.`,
      pageRefs: pages.map(pageRefOf),
      short: "compared the normalized figures",
      talk: "Be ready to go through each add-back — they compared the reported and normalized figures.",
      topic: "normalization",
    });
  }

  // 3. concern_focus — Studied a customers / lease / transition / team page.
  for (const role of ["customers", "location", "owner_transition", "employees"] as PageRole[]) {
    const studied = content.filter((r) => r.page.role === role && r.label === "studied");
    if (studied.length === 0) continue;
    const words = ROLE_TALK[role]!;
    const time = formatReadingTime(sumAtt(studied));
    out.push({
      id: "concern_focus",
      strength: 0.5 + 0.3 * Math.min(1, studyRatio(sumAtt(studied), sumExp(studied)) / 3),
      evidence: `Studied ${names(studied)} for ${time}.`,
      pageRefs: studied.map((r) => pageRefOf(r.page)),
      short: words.short,
      talk: words.talk,
      topic: role,
    });
  }

  // 4. price_first — the first real page of the first visit was price & terms.
  const firstVisit = visits[0];
  const firstContentId = (firstVisit.path ?? []).map(([, id]) => pageOfId(id)).find((p) => p && isContent(p));
  const docFirstContent = ctx.pages.find(isContent);
  if (firstContentId && firstContentId.role === "transaction" && docFirstContent && firstContentId.pageId !== docFirstContent.pageId) {
    out.push({
      id: "price_first",
      strength: 0.6,
      evidence: `Went to ${firstContentId.title} (page ${firstContentId.label}) right after the cover on their first visit.`,
      pageRefs: [pageRefOf(firstContentId)],
      short: "went straight to the price and terms",
      talk: "Went straight to price and structure. Ask about financing and timing.",
      topic: "transaction",
    });
  }

  // 5. growth_focus — the growth pages Studied.
  const growth = content.filter((r) => r.page.role === "growth" && r.label === "studied");
  if (growth.length > 0) {
    out.push({
      id: "growth_focus",
      strength: 0.45 + 0.3 * Math.min(1, studyRatio(sumAtt(growth), sumExp(growth)) / 3),
      evidence: `Studied ${names(growth)} for ${formatReadingTime(sumAtt(growth))}.`,
      pageRefs: growth.map((r) => pageRefOf(r.page)),
      short: "studied the growth plan",
      talk: "Lead with the growth plan and pipeline.",
      topic: "growth",
    });
  }

  // 6. returned — a visit ≥ 20 h after the previous one (the latest such).
  let lastReturn: VisitFacts | null = null;
  for (let i = 1; i < visits.length; i++) {
    if (ms(visits[i].startedAt) - ms(visits[i - 1].lastSeenAt) >= READING_RULES.returnGapMs) lastReturn = visits[i];
  }
  if (lastReturn) {
    const pages = visitTopPages(lastReturn, ctx.pages).slice(0, 2);
    const when = whenText(ms(lastReturn.startedAt), now);
    const onlyFor = visitTopPages(lastReturn, ctx.pages, 3).length <= 3;
    const forText = pages.length ? ` ${onlyFor ? "only " : ""}for ${listWords(pages.map((p) => p.title))}` : "";
    const days = (now.getTime() - ms(lastReturn.startedAt)) / DAY;
    out.push({
      id: "returned",
      strength: 0.5 + 0.35 * Math.exp(-days / R.recencyDays),
      evidence: `Came back ${when}${forText} (${plural(visits.length, "visit")} in all).`,
      pageRefs: pages.map(pageRefOf),
      short: `came back ${when}${pages.length ? ` for ${listWords(pages.map((p) => p.title))}` : ""}`,
      talk: pages.length
        ? `They came back for ${listWords(pages.map((p) => p.title))} — ask what they wanted to check.`
        : "They came back for another look — ask what they wanted to check.",
      topic: "returned",
    });
  }

  // 7. multi_network — opened from several places (a question, never a claim).
  const networks = new Set(visits.map((v) => v.networkKey).filter((x): x is string => !!x));
  const setups = new Set(visits.map((v) => `${v.device}|${v.uaFamily ?? ""}`));
  const places = Math.max(networks.size, setups.size);
  if (places >= R.places) {
    const byNetwork = networks.size >= setups.size;
    out.push({
      id: "multi_network",
      strength: 0.5,
      evidence: byNetwork ? `Opened from ${places} different networks.` : `Opened on ${places} different devices or browsers.`,
      pageRefs: [],
      short: `opened it from ${places} places`,
      talk: `Opened from ${places} places. Ask whether partners or a lender are reviewing it.`,
      topic: "multi_network",
    });
  }

  // 8. asked — each question, unanswered first.
  const qs = [...b.questions].sort((x, y) => Number(x.answered) - Number(y.answered) || ms(y.askedAt) - ms(x.askedAt));
  for (const q of qs.slice(0, 3)) {
    const page = pageOfId(q.pageId);
    const text = quoteStart(q.text.replace(/\s+/g, " ").trim(), 14);
    out.push({
      id: "asked",
      strength: q.answered ? 0.55 : 0.9,
      evidence: `Asked “${text}”${page ? ` on page ${page.label} · ${page.title}` : ""} ${whenText(ms(q.askedAt), now)}${q.answered ? "" : " — not answered yet"}.`,
      pageRefs: page ? [pageRefOf(page)] : [],
      short: `asked “${quoteStart(q.text.replace(/\s+/g, " ").trim(), 7)}”`,
      talk: q.answered
        ? `Follow up on their question “${text}” — check the answer covered it.`
        : `Answer their question on the call: “${text}”`,
      topic: page && isContent(page) ? page.role : `asked:${q.id}`,
    });
  }

  // 9. locked_interest — tried to open locked pages (teaser).
  const lockedClicks = b.events.filter((e) => e.type === "locked_click");
  const lockedRows = core.rows.filter((r) => r.page.locked && r.attention > 0);
  const lockedTime = sumAtt(lockedRows);
  if (lockedClicks.length >= R.lockedClicks || lockedTime >= R.lockedMs) {
    const pages = Array.from(new Set([...lockedClicks.map((e) => e.pageId), ...lockedRows.map((r) => r.page.pageId)]))
      .map(pageOfId).filter((p): p is FactPage => !!p);
    const list = listWords(pages.slice(0, 3).map((p) => p.title)) + (pages.length > 3 ? ` and ${plural(pages.length - 3, "more")}` : "");
    out.push({
      id: "locked_interest",
      strength: 0.8,
      evidence: lockedClicks.length >= R.lockedClicks
        ? `Tried to open ${plural(pages.length || lockedClicks.length, "locked page")}${list ? ` (${list})` : ""}.`
        : `Spent ${formatReadingTime(lockedTime)} on locked pages${list ? ` (${list})` : ""}.`,
      pageRefs: pages.map(pageRefOf),
      short: "tried to open locked pages",
      talk: `Tried to open locked pages${list ? ` (${list})` : ""}. Consider moving them to full access.`,
      topic: "locked",
    });
  }

  // 10. contact_click — clicked the broker's email / phone in the CIM.
  const contacts = b.events.filter((e) => e.type === "contact_click").sort((x, y) => ms(y.at) - ms(x.at));
  if (contacts.length > 0) {
    const c = contacts[0];
    const what = c.detail === "phone" ? "phone number" : c.detail === "website" ? "website" : "email";
    const when = whenText(ms(c.at), now);
    out.push({
      id: "contact_click",
      strength: 0.95,
      evidence: `Clicked your ${what} on the contact page ${when}.`,
      pageRefs: [],
      short: `tried to contact you ${when}`,
      talk: `They tried to reach you from the CIM ${when} — check your ${c.detail === "phone" ? "missed calls" : "inbox"}.`,
      topic: "contact",
    });
  }

  // 11. stalled — strong reading, then nothing for ≥ 5 days while undecided.
  const quietFor = now.getTime() - core.lastActivity;
  if (core.intent >= R.warmIntent && quietFor >= R.quietAfterMs && isUndecided(b.decision)) {
    const days = Math.floor(quietFor / DAY);
    out.push({
      id: "stalled",
      strength: 0.85,
      evidence: `No visit for ${days} days, after ${formatReadingTime(core.totalAttention)} of reading.`,
      pageRefs: [],
      short: `quiet for ${days} days`,
      talk: "Went quiet after strong reading. Follow up now.",
      topic: "stalled",
    });
  }

  // 12. skimmed — one visit, a small share of what the CIM needs.
  // Never when they studied a page: going straight to the numbers and
  // studying them is focus, not skimming.
  if (
    !core.readingNow && visits.length === 1 && core.totalExpected > 0 &&
    sumAtt(core.content) < R.skimmedShare * core.totalExpected &&
    !core.content.some((r) => r.label === "studied")
  ) {
    const read = core.content.filter((r) => r.attention >= READING_RULES.readerMinMs).length;
    // Time on the pages themselves (the cover left on screen while they walked away isn't reading).
    const contentMs = sumAtt(core.content);
    out.push(read === 0
      ? {
        id: "skimmed",
        strength: 0.7,
        evidence: `One visit that never got past the cover — no page read for 3 seconds or more.`,
        pageRefs: [],
        short: "opened it but didn't read past the cover",
        talk: "Opened it but didn't read past the cover. A short call may help.",
        topic: "skimmed",
      }
      : {
        id: "skimmed",
        strength: 0.7,
        evidence: `One visit with ${formatReadingTime(contentMs)} of reading across ${read} of ${plural(core.content.length, "page")} — the CIM takes about ${formatReadingTime(core.totalExpected)} to read.`,
        pageRefs: [],
        short: `only skimmed it (${formatReadingTime(contentMs)})`,
        talk: "Only skimmed. A short qualifying call may save time.",
        topic: "skimmed",
      });
  }

  // 13. completed — reached the last content page, with real reading.
  const lastContent = [...core.content].sort((a, b2) => b2.page.index - a.page.index)[0];
  if (lastContent && lastContent.reached && core.totalExpected > 0 && core.totalAttention >= R.completedShare * core.totalExpected) {
    out.push({
      id: "completed",
      strength: 0.3,
      evidence: `Read to the end — ${formatReadingTime(core.totalAttention)} across ${plural(core.content.filter((r) => r.reached).length, "page")}.`,
      pageRefs: [],
      short: "read to the end",
      talk: null,
      topic: "completed",
    });
  }

  // 14. copy_print — tried to copy, print or download.
  const copies = b.events.filter((e) => e.type === "copy");
  const prints = b.events.filter((e) => e.type === "print_attempt" || e.type === "download_attempt");
  if (copies.length + prints.length > 0) {
    const page = copies.length ? pageOfId(copies[copies.length - 1].pageId) : null;
    const parts: string[] = [];
    if (copies.length) parts.push(`tried to copy text${page ? ` on page ${page.label} · ${page.title}` : ""}${copies.length > 1 ? ` (${copies.length} times)` : ""}`);
    if (prints.length) parts.push(`tried to print or save it${prints.length > 1 ? ` (${prints.length} times)` : ""}`);
    out.push({
      id: "copy_print",
      strength: 0.4,
      evidence: `${capitalise(listWords(parts))}.`,
      pageRefs: page ? [pageRefOf(page)] : [],
      short: copies.length ? "tried to copy text" : "tried to print it",
      talk: "They tried to copy or print parts of it — ask who else is looking at the deal with them.",
      topic: "copy",
    });
  }

  // 15. outlier_attention — far longer than the other readers on one page.
  let best: { row: PageRow; times: number; med: number } | null = null;
  for (const row of content) {
    if (row.attention < R.outlierMinMs) continue;
    const others = ctx.buyers
      .filter((o) => o.accessId !== b.accessId)
      .map((o) => readingOf(o, row.page)?.attentionMs ?? 0)
      .filter((t) => t >= READING_RULES.readerMinMs);
    if (others.length < R.outlierMinReaders) continue;
    const med = median(others);
    const times = med > 0 ? row.attention / med : 0;
    if (times >= R.outlierTimes && (!best || times > best.times)) best = { row, times, med };
  }
  if (best) {
    const x = timesWord(best.times);
    out.push({
      id: "outlier_attention",
      strength: 0.55 + 0.1 * Math.min(3, best.times / 3),
      evidence: `Spent ${x} longer than other buyers on ${best.row.page.title} (${formatReadingTime(best.row.attention)} against ${formatReadingTime(best.med)}).`,
      pageRefs: [pageRefOf(best.row.page)],
      short: `spent ${x} longer than others on ${best.row.page.title}`,
      talk: ROLE_TALK[best.row.page.role]?.talk ?? `Spent ${x} longer than other buyers on ${best.row.page.title}. Ask what stood out.`,
      topic: best.row.page.role === "other" ? `outlier:${best.row.page.pageId}` : best.row.page.role,
    });
  }

  return out.sort((a, b2) => b2.strength - a.strength);
}

function talkingPointsOf(signals: Sig[]): TalkingPoint[] {
  const seen = new Set<string>();
  const out: TalkingPoint[] = [];
  for (const s of signals) {
    if (!s.talk || seen.has(s.topic)) continue;
    seen.add(s.topic);
    out.push({ signalId: s.id, text: s.talk, evidence: s.evidence, pageRefs: s.pageRefs });
    if (out.length === 3) break;
  }
  return out;
}

// ── Status ───────────────────────────────────────────────────────────────

function statusOf(b: BuyerReadingFacts, core: BuyerCore, signals: Sig[], now: Date): BuyerStatus {
  const R = INSIGHT_RULES;
  if (core.readingNow) return "reading_now";
  if (b.decision === "interested") return "interested";
  if (b.decision === "not_interested") return "not_interested";
  if (b.decision === "lapsed") return "lapsed";
  if (b.visits.length === 0) return b.firstViewedAt ? "opened" : "not_opened";
  const since = now.getTime() - core.lastActivity;
  if (core.intent >= R.hotIntent && since <= R.hotWithinMs) return "hot";
  if (signals.some((s) => s.id === "stalled")) return "went_quiet";
  if (core.intent >= R.warmIntent) return "warming";
  if (signals.some((s) => s.id === "skimmed")) return "skimmed";
  return "opened";
}

function contactedLabel(b: BuyerReadingFacts, now: Date): string | null {
  const at = ms(b.contactedAt);
  if (!at || now.getTime() - at > INSIGHT_RULES.contactedMs) return null;
  const w = whenText(at, now);
  return w === "today" ? "Contacted today" : w === "yesterday" ? "Contacted yesterday" : `Contacted ${w}`;
}

function fitScore(b: BuyerReadingFacts): number {
  const f = b.fit;
  if (f?.deepCheckFit != null) return Math.max(0.05, Math.min(1, f.deepCheckFit / 100));
  if (f?.criteriaMatched != null && f.criteriaTotal) return Math.max(0.2, Math.min(1, f.criteriaMatched / f.criteriaTotal));
  return 0.6;
}

function opennessOf(b: BuyerReadingFacts, now: Date): number {
  if (b.decision === "not_interested" || b.decision === "lapsed") return 0;
  const contacted = ms(b.contactedAt);
  if (contacted && now.getTime() - contacted <= INSIGHT_RULES.contactedMs) return 0.3;
  if (b.decision === "interested") return 0.7;
  return 1;
}

function whyOf(b: BuyerReadingFacts, core: BuyerCore, signals: Sig[], ctx: InsightContext): string {
  const now = ctx.now;
  if (b.visits.length === 0) {
    if (b.firstViewedAt) return `Opened the CIM ${whenText(ms(b.firstViewedAt), now)}; no reading time was recorded.`;
    return `Hasn't opened the CIM yet — access given ${whenText(ms(b.grantedAt), now)}.`;
  }
  const decided = b.decision === "interested" ? `Chose Interested ${whenText(ms(b.decisionAt), now)}` :
    b.decision === "not_interested" ? `Chose Not interested ${whenText(ms(b.decisionAt), now)}` : null;
  const frags = signals.filter((s) => s.id !== "completed" || signals.length === 1).slice(0, 3).map((s) => s.short);
  if (frags.length === 0) {
    const read = core.content.filter((r) => r.attention >= READING_RULES.readerMinMs).length;
    frags.push(`read ${read} of ${plural(core.content.length, "page")} — ${formatReadingTime(core.totalAttention)} over ${plural(core.visits.length, "visit")}, last ${whenText(core.lastSeen, now)}`);
  }
  const line = capitalise(listWords(frags));
  return decided ? `${decided}. ${line}.` : `${line}.`;
}

/** Status, why, signals, talking points, intent and call priority for one buyer. */
export function buyerInsight(buyer: BuyerReadingFacts, ctxIn: InsightContext): BuyerInsight {
  const ctx: InsightContext = { ...ctxIn, pages: pagesForBuyer(buyer, ctxIn.pages) };
  const core = coreOf(buyer, ctx);
  const sigs = signalsOf(buyer, core, ctx);
  const status = statusOf(buyer, core, sigs, ctx.now);
  const decisionStatus = status === "interested" || status === "not_interested" || status === "lapsed" || status === "reading_now";
  const contacted = contactedLabel(buyer, ctx.now);
  const recency = core.lastActivity ? Math.exp(-(ctx.now.getTime() - core.lastActivity) / DAY / INSIGHT_RULES.recencyDays) : 0;
  // (A buyer whose access the broker revoked — a competitor removed, one the
  // seller turned down — is never a lead to call: priority 0, labelled.)
  const revoked = !!buyer.revokedAt;
  const priority = buyer.visits.length === 0
    ? -1
    : revoked
      ? 0
      : core.intent * fitScore(buyer) * recency * opennessOf(buyer, ctx.now) + 0.001 * recency * (opennessOf(buyer, ctx.now) > 0 ? 1 : 0);
  const pageLabels: Record<string, ReadLabel> = {};
  for (const r of core.rows) if (r.label) pageLabels[viewerPageKey(r.page.pageId, r.page.part)] = r.label;
  return {
    status,
    statusLabel: revoked ? "Access revoked" : contacted && !decisionStatus ? contacted : BUYER_STATUS_TEXT[status],
    why: whyOf(buyer, core, sigs, ctx),
    signals: sigs.map(({ id, strength, evidence, pageRefs }) => ({ id, strength: Math.round(strength * 100) / 100, evidence, pageRefs })),
    talkingPoints: talkingPointsOf(sigs),
    intent: core.intent,
    priority: Math.round(priority * 1e6) / 1e6,
    pageLabels,
  };
}

/** One buyer's reading in numbers (for comparisons across deals and the buyer profile). */
export function readingSummary(buyer: BuyerReadingFacts, pages: FactPage[]): {
  attentionMs: number; pagesRead: number; pagesReached: number; contentPages: number; reachedEnd: boolean; lastSeenAt: number;
} {
  const rows = pageRows(buyer, pages);
  const content = rows.filter((r) => isContent(r.page) && !r.page.locked);
  const last = [...content].sort((a, b) => b.page.index - a.page.index)[0];
  return {
    attentionMs: sumAtt(rows),
    pagesRead: content.filter((r) => r.attention >= READING_RULES.readerMinMs).length,
    pagesReached: content.filter((r) => r.reached).length,
    contentPages: content.length,
    reachedEnd: !!last && last.reached && buyer.visits.length > 0,
    lastSeenAt: lastSeenOf(buyer),
  };
}

/** Buyers in call order (best lead first). */
export function rankBuyers(items: Array<{ facts: BuyerReadingFacts; insight: BuyerInsight }>): Array<{ facts: BuyerReadingFacts; insight: BuyerInsight }> {
  return [...items].sort((a, b) =>
    b.insight.priority - a.insight.priority ||
    lastSeenOf(b.facts) - lastSeenOf(a.facts) ||
    a.facts.name.localeCompare(b.facts.name));
}

// ── Headlines ────────────────────────────────────────────────────────────

const QUIET_KINDS = new Set(["heading", "page", "summary", "column", "locked", "point"]);

/** One sentence above a page in the Document view, or null when nothing notable. */
export function pageHeadline(page: DocumentPage, doc: { pages: DocumentPage[]; openedBy: number }): string | null {
  if (doc.openedBy === 0) return null;
  const content = doc.pages.filter((p) => p.role !== "front_matter");
  const perReader = page.readers > 0 ? page.attentionMs / page.readers : 0;
  const ratio = studyRatio(perReader, page.expectedMs);

  // Most studied page in the CIM.
  const top = content.reduce<DocumentPage | null>((m, p) => (p.attentionMs > (m?.attentionMs ?? 0) ? p : m), null);
  if (top && top.pageId === page.pageId && top.part === page.part && page.attentionMs > 0 && content.length > 1) {
    const x = ratio >= 1.5 ? `, ${timesWord(ratio)} its expected reading time` : "";
    return `Most studied page in the CIM — ${page.readers} of ${plural(doc.openedBy, "buyer")} read it${x}.`;
  }
  if (page.locked) {
    const n = page.interactions.locked_click ?? 0;
    if (n > 0) return `Locked for teaser buyers — ${plural(n, "click")} trying to open it.`;
  }
  if (page.questions.length > 0) {
    return `${plural(page.questions.length, "question")} asked on this page.`;
  }
  if (page.reachedBy === 0 && page.readers === 0) {
    return page.role === "front_matter" ? null : "No buyer has reached this page yet.";
  }
  if (page.reachedBy >= 2 && page.readers < page.reachedBy / 2) {
    return `${page.reachedBy} buyers reached this page but ${page.readers === 0 ? "none" : `only ${page.readers}`} stopped to read it.`;
  }
  if (page.readers > 0 && ratio >= 1.5 && page.expectedMs >= 5_000 && perReader >= 20_000) {
    return `Readers spend ${timesWord(ratio)} the expected reading time here — ${formatReadingTime(perReader)} each on average.`;
  }
  // A section buyers first saw collapsed: its opened parts count only once someone opened it.
  const collapsedOnly = page.blocks.some((bl) => bl.key === "summary") && (page.interactions.expand ?? 0) <= 0;
  // Only where every reader's time is placed on the parts (a page total can't say a part went unread).
  const partsOnly = page.heat ? page.heat.basis === "parts" : !page.pageLevelOnly;
  if (page.readers >= 2 && partsOnly && !collapsedOnly) {
    const unread = page.blocks
      .filter((bl) => !QUIET_KINDS.has(bl.kind) && bl.attentionMs < READING_RULES.unreadBlockMs && bl.visibleMs < READING_RULES.readerMinMs)
      .sort((a, b) => kindWeight(b.kind) - kindWeight(a.kind));
    if (unread.length > 0) {
      // A section buyers first saw collapsed: only those who opened it could stop on its rows.
      const collapsible = page.blocks.some((bl) => bl.key === "summary");
      return collapsible
        ? `Of the buyers who opened this section, nobody stopped on ${blockPhrase(unread[0].label)}.`
        : `Nobody stopped on ${blockPhrase(unread[0].label)}.`;
    }
  }
  return null;
}

function kindWeight(kind: string): number {
  return kind === "table" ? 4 : kind === "metric" || kind === "chart" ? 3 : kind === "highlight" ? 2 : 1;
}

/** A drop worth pointing at: at least 2 buyers AND at least 10% of those who opened the CIM. */
export function isMarkedDrop(drop: number, openedBy: number): boolean {
  return drop >= 2 && drop >= 0.1 * openedBy;
}

/**
 * "Most buyers stopped around page 14 · Employees & Management (9 → 4 readers)", or null.
 *
 * `lastRecorded` (the old tracking, heat-map spec §5.4): the last page the
 * old tracker could record. Later pages never had reading recorded, so they
 * are left out — never "6 → 0 readers" on a page nobody's tracker could see —
 * and the last page named is that one ("…, the last page recorded").
 */
export function reachHeadline(reach: ReachPoint[], opts: { lastRecorded?: number | null } = {}): string | null {
  const limited = opts.lastRecorded !== undefined;
  const pts = [...reach].sort((a, b) => a.index - b.index).filter((p) => !limited || (opts.lastRecorded != null && p.index <= opts.lastRecorded));
  if (pts.length === 0) return null;
  const n = pts[0].buyers;
  if (n <= 0) return null;
  let drop: { at: ReachPoint; from: number } | null = null;
  for (let i = 1; i < pts.length; i++) {
    const d = pts[i - 1].buyers - pts[i].buyers;
    if (d > 0 && (!drop || d > drop.from - drop.at.buyers)) drop = { at: pts[i], from: pts[i - 1].buyers };
  }
  const last = pts[pts.length - 1];
  const lastWords = `got to page ${last.label} · ${last.title}, the last page recorded`;
  if (n === 1) {
    // One buyer (or a view filtered to one): where they got to, never "most buyers".
    if (last.buyers >= 1) return limited ? `The buyer who opened the CIM ${lastWords}.` : "The buyer who opened the CIM reached the last page.";
    const furthest = [...pts].reverse().find((p) => p.buyers >= 1);
    return furthest ? `This buyer got as far as page ${furthest.label} · ${furthest.title}.` : null;
  }
  const significant = !!drop && isMarkedDrop(drop.from - drop.at.buyers, n);
  if (!drop || !significant) {
    if (limited) return last.buyers === n ? `All ${n} buyers who opened the CIM ${lastWords}.` : `${last.buyers} of ${plural(n, "buyer")} ${lastWords}.`;
    if (last.buyers === n) return `All ${n} buyers who opened the CIM reached the last page.`;
    return `${last.buyers} of ${plural(n, "buyer")} reached the last page.`;
  }
  const lead = drop.at.buyers < drop.from / 2 ? "Most buyers stopped" : "The biggest drop is";
  return `${lead} around page ${drop.at.label} · ${drop.at.title} (${drop.from} → ${plural(drop.at.buyers, "reader")}).`;
}

// ── Journeys ─────────────────────────────────────────────────────────────

const EVENT_MOMENT: Partial<Record<string, (title: string, detail?: string) => string>> = {
  financial_view: (t, d) => (d === "normalized" ? `Switched ${t} to Normalized` : `Switched ${t} back to Reported`),
  locked_click: (t) => `Tried to open a locked page (${t})`,
  contact_click: (_t, d) => `Clicked your ${d === "phone" ? "phone number" : d === "website" ? "website" : "email"} on the contact page`,
  copy: (t) => `Tried to copy text on ${t}`,
  print_attempt: () => "Tried to print the CIM",
  download_attempt: () => "Tried to download the CIM",
  media_play: (t) => `Played the video on ${t}`,
  expand: (t) => `Opened the details on ${t}`,
  gallery_open: (t) => `Opened the photos on ${t}`,
  map_interact: (t) => `Looked around the map on ${t}`,
};

/** Deterministic key moments of one visit ("Went straight to Financials after the cover"). */
export function journeyMoments(visit: VisitFacts, buyer: BuyerReadingFacts, ctxIn: InsightContext): KeyMoment[] {
  const ctx: InsightContext = { ...ctxIn, pages: pagesForBuyer(buyer, ctxIn.pages) };
  const start = ms(visit.startedAt);
  const end = Math.max(ms(visit.lastSeenAt), start);
  const iso = (t: number) => new Date(t).toISOString();
  const firstPage = new Map<string, FactPage>();
  for (const p of ctx.pages) if (!firstPage.has(p.pageId)) firstPage.set(p.pageId, p);
  const pageOf = (id: string | null | undefined) => (id ? firstPage.get(id) ?? null : null);
  const out: KeyMoment[] = [];
  const segs = pathDurations(visit);

  // A return visit, and what it was for.
  const visits = [...buyer.visits].sort((a, b) => ms(a.startedAt) - ms(b.startedAt));
  const i = visits.findIndex((v) => v.id === visit.id);
  if (i > 0) {
    const gap = start - ms(visits[i - 1].lastSeenAt);
    if (gap >= READING_RULES.returnGapMs) {
      const top = visitTopPages(visit, ctx.pages);
      const days = Math.max(1, Math.round(gap / DAY));
      const later = days === 1 ? "a day later" : `${days} days later`;
      out.push({
        at: iso(start),
        text: top.length && top.length <= 3 ? `Came back ${later} only for ${listWords(top.map((p) => p.title))}` : `Came back ${later}`,
        pageRef: top[0] ? pageRefOf(top[0]) : undefined,
      });
    }
  }

  // Where they went first.
  const contentOrder = ctx.pages.filter(isContent);
  const firstSeg = segs.find((s) => { const p = pageOf(s.pageId); return p && isContent(p); });
  if (firstSeg && i <= 0) {
    const p = pageOf(firstSeg.pageId)!;
    const docIdx = contentOrder.findIndex((x) => x.pageId === p.pageId);
    if (docIdx >= 3 || p.role === "transaction" || FIN_ROLES.has(p.role)) {
      if (docIdx > 0) out.push({ at: iso(start + firstSeg.startSec * 1000), text: `Went straight to ${p.title} after the cover`, pageRef: pageRefOf(p) });
    }
  }

  // The page they spent longest on.
  const byPage = new Map<string, number>();
  for (const s of segs) byPage.set(s.pageId, (byPage.get(s.pageId) ?? 0) + s.seconds);
  const longest = Array.from(byPage.entries()).filter(([id]) => { const p = pageOf(id); return p && isContent(p); }).sort((a, b) => b[1] - a[1])[0];
  if (longest && longest[1] >= 30) {
    const p = pageOf(longest[0])!;
    const at = segs.find((s) => s.pageId === longest[0])!;
    out.push({ at: iso(start + at.startSec * 1000), text: `Spent longest on ${p.title} (${formatReadingTime(longest[1] * 1000)})`, pageRef: pageRefOf(p) });
  }

  // What they did.
  for (const e of buyer.events) {
    if (e.visitId !== visit.id) continue;
    const make = EVENT_MOMENT[e.type];
    if (!make) continue;
    if (e.type === "financial_view" && e.detail !== "normalized") continue;
    const p = pageOf(e.pageId);
    out.push({ at: e.at, text: make(p ? p.title : "a page", e.detail), pageRef: p ? pageRefOf(p) : undefined });
  }

  // Questions asked during the visit.
  for (const q of buyer.questions as BuyerQuestionRef[]) {
    const t = ms(q.askedAt);
    if (t < start - 60_000 || t > end + 5 * 60_000) continue;
    const p = pageOf(q.pageId);
    out.push({ at: q.askedAt, text: `Asked “${quoteStart(q.text.replace(/\s+/g, " ").trim(), 12)}”${p ? ` on page ${p.label}` : ""}`, pageRef: p ? pageRefOf(p) : undefined });
  }

  // How far they got.
  const lastContent = [...contentOrder].sort((a, b) => b.index - a.index)[0];
  const order = pageOrder(ctx.pages);
  if (lastContent && visit.maxPageIndex >= 0) {
    const lastIdx = order.get(lastContent.pageId) ?? -1;
    const reachedPage = Array.from(order.entries()).find(([, idx]) => idx === visit.maxPageIndex)?.[0];
    const rp = pageOf(reachedPage);
    const total = contentOrder.length ? contentOrder[contentOrder.length - 1].label : "";
    if (visit.maxPageIndex >= lastIdx) out.push({ at: iso(end), text: "Read to the end" });
    else if (rp && isContent(rp)) out.push({ at: iso(end), text: `Stopped at page ${rp.label} of ${total}`, pageRef: pageRefOf(rp) });
  }

  // The decision, when it fell inside this visit.
  const dAt = ms(buyer.decisionAt);
  if (dAt && dAt >= start - 60_000 && dAt <= end + 10 * 60_000 && buyer.decision !== "under_review") {
    const word = buyer.decision === "interested" ? "Interested" : buyer.decision === "not_interested" ? "Not interested" : buyer.decision === "need_more_time" ? "Need more time" : null;
    if (word) out.push({ at: buyer.decisionAt!, text: `Chose ${word}` });
  }

  const seen = new Set<string>();
  return out
    .filter((m) => (seen.has(m.text) ? false : (seen.add(m.text), true)))
    .sort((a, b) => ms(a.at) - ms(b.at))
    .slice(0, 8);
}

/** "9 of 13 buyers have opened the CIM · 4 read it this week · 2 reading now" */
export function pulseSentence(p: { granted: number; opened: number; readThisWeek: number; readingNow: number }): string {
  if (p.granted === 0) return "No buyers have been given access yet.";
  const parts = [`${p.opened} of ${p.granted} buyer${p.granted === 1 ? " has" : "s have"} opened the CIM`];
  if (p.readThisWeek > 0) parts.push(`${p.readThisWeek} read it this week`);
  if (p.readingNow > 0) parts.push(`${p.readingNow} reading now`);
  return parts.join(" · ");
}

/** Signal ids whose talking point is evidence only (for UIs that list signals). */
export const EVIDENCE_ONLY_SIGNALS: ReadonlySet<SignalId> = new Set<SignalId>(["completed"]);
