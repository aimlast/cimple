/**
 * The Activity feed: what buyers did, newest first (spec §6.3). Pure.
 *
 * Fixes the old feed (components/deal/ActivityTimeline, which read only the
 * old event tracker and so missed every visit since 29 Sept): visits come
 * from the reading facts (CIM visits only), the rest from the access rows,
 * the recorded decisions and the questions.
 *
 *   - a buyer's first visit is "opened", later ones "came back — visit N";
 *     every item's time is immutable (a visit uses its START), so paging
 *     never repeats or skips while a buyer is still reading — "reading
 *     now" is a pinned line outside the paged list, never an item;
 *   - every recorded decision is an item; the access row's decision is
 *     ALSO one when it is final and differs from that link's last recorded
 *     decision, or nothing was recorded (decisions before the event stream,
 *     and every auto-lapse: the reminder pipeline writes the row only);
 *   - level words come from the access-level registry, never literals;
 *   - other streams' items (teaser reads, data room) are appended.
 *
 * Ids are deterministic: v:<visitId>, nda:<accessId>, dec:<accessId>:<i>,
 * decrow:<accessId>, q:<questionId>, ev:<accessId>:<i>, grant:<accessId>,
 * rev:<accessId>, exp:<accessId>.
 */
import { formatReadingTime } from "@shared/analytics-v2";
import {
  ACTIVITY_GROUP_OF,
  ACTIVITY_PAGE_DEFAULT,
  ACTIVITY_PAGE_MAX,
  dayMonth,
  isSampleVisit,
  plural,
  questionWaitingOn,
  rangeWindow,
  type ActivityItem,
  type ActivityKind,
  type ActivityKindFilter,
  type DashboardRange,
} from "@shared/analytics-dashboard";
import { nextStepWords } from "@shared/buyer-next-steps";
import { buyerHref, cimOnly } from "./kpis";
import type { AccessRow, BrokerInputs, DecisionRow } from "./load";
import { grantNounOf, isTeaserOnly } from "./levels";

/** At most this many items before paging (newest kept). */
export const ACTIVITY_CAP = 5_000;

const t = (iso: string | null | undefined): number => (iso ? Date.parse(iso) || 0 : 0);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

const TONE: Record<ActivityKind, ActivityItem["tone"]> = {
  opened: "neutral", returned: "neutral", teaser_opened: "neutral",
  nda_signed: "positive", cim_requested: "positive", interested: "positive",
  not_interested: "negative", more_time: "neutral", lapsed: "negative", teaser_passed: "negative",
  question: "neutral",
  granted: "neutral", level_changed: "neutral", extended: "neutral", contacted: "neutral", revoked: "negative", link_expired: "negative",
  data_room: "neutral",
};

const DECISION_KIND: Record<string, ActivityKind | undefined> = {
  interested: "interested",
  not_interested: "not_interested",
  need_more_time: "more_time",
  lapsed: "lapsed",
};
const FINAL = new Set(["interested", "not_interested", "lapsed"]);

export interface ActivityOptions {
  range: DashboardRange;
  now: Date;
  kinds?: ActivityKindFilter;
  dealId?: string | null;
  /** Only these buyer links (the deal tab's Buyers filters). */
  accessIds?: string[] | null;
  /** Other streams' items (teaser reads, data room). */
  extra?: ActivityItem[];
}

function item(
  kind: ActivityKind,
  fields: Omit<ActivityItem, "kind" | "group" | "tone"> & { tone?: ActivityItem["tone"] },
): ActivityItem {
  const { tone, ...rest } = fields;
  return { ...rest, kind, group: ACTIVITY_GROUP_OF[kind], tone: tone ?? TONE[kind] };
}

const buyerName = (a: Pick<AccessRow, "buyerName" | "buyerEmail">) => a.buyerName || a.buyerEmail;

/** Where "Open buyer" goes: the buyer's card, or the Teaser view for a teaser-only link. */
function openBuyer(a: Pick<AccessRow, "id" | "dealId" | "accessLevel">): { href: string; label: string } {
  return isTeaserOnly(a.accessLevel)
    ? { href: `/deal/${a.dealId}/engagement?view=teaser`, label: "Open buyer" }
    : { href: buyerHref(a.dealId, a.id), label: "Open buyer" };
}

function manageAccess(a: Pick<AccessRow, "dealId" | "accessLevel">): { href: string; label: string } {
  return isTeaserOnly(a.accessLevel)
    ? { href: `/deal/${a.dealId}/buyers?stage=send&list=sent`, label: "Manage access" }
    : { href: `/deal/${a.dealId}/buyers?stage=have`, label: "Manage access" };
}

const QUESTION_WORDS = {
  broker: { detail: "Waiting for your answer", label: "Answer" },
  seller: { detail: "Waiting for the seller's OK", label: "See answer" },
  answered: { detail: "Answered", label: "See answer" },
  declined: { detail: "You declined it", label: "See answer" },
} as const;

export function activityItems(inputs: BrokerInputs, decisions: DecisionRow[], opts: ActivityOptions): ActivityItem[] {
  const { now } = opts;
  const out: ActivityItem[] = [];
  const dealName = new Map(inputs.deals.map((d) => [d.id, d.businessName]));
  const accessById = new Map(inputs.access.map((a) => [a.id, a]));

  // ── Visits (CIM only) and questions from the reading facts ──
  const seenQuestions = new Set<string>();
  for (const it of inputs.items) {
    const dealId = it.deal.id;
    const name = it.deal.businessName;
    for (const b of cimOnly(it.facts).buyers) {
      const visits = [...b.visits].sort((x, y) => t(x.startedAt) - t(y.startedAt) || (x.id < y.id ? -1 : 1));
      visits.forEach((v, i) => {
        const pages = new Set(v.path.map(([, p]) => p)).size;
        const detail = [
          `${formatReadingTime(v.activeMs)} reading`,
          pages > 0 ? `spent time on ${plural(pages, "page")}` : null,
          v.device === "phone" ? "on a phone" : v.device === "tablet" ? "on a tablet" : null,
        ].filter(Boolean).join(" · ");
        const row = item(i === 0 ? "opened" : "returned", {
          id: `v:${v.id}`, at: v.startedAt, dealId, dealName: name, accessId: b.accessId, name: b.name, company: b.company,
          title: i === 0 ? `${b.name} opened the CIM` : `${b.name} came back to the CIM — visit ${i + 1}`,
          detail,
          link: { href: `/deal/${dealId}/engagement?journey=${encodeURIComponent(b.accessId)}`, label: "See visit" },
        });
        if (isSampleVisit(v)) row.sample = true;
        out.push(row);
      });
      for (const q of b.questions) {
        seenQuestions.add(q.id);
        const waiting = questionWaitingOn(q.status, q.answered);
        out.push(item("question", {
          id: `q:${q.id}`, at: q.askedAt, dealId, dealName: name, accessId: b.accessId, name: b.name, company: b.company,
          title: `${b.name} asked: “${clip(q.text.trim(), 140)}”`,
          detail: QUESTION_WORDS[waiting].detail,
          link: { href: `/deal/${dealId}/qa`, label: QUESTION_WORDS[waiting].label },
        }));
      }
    }
  }
  for (const q of inputs.questions) {
    if (seenQuestions.has(q.id)) continue;
    const a = q.accessId ? accessById.get(q.accessId) : undefined;
    const who = a ? buyerName(a) : "A buyer";
    const waiting = questionWaitingOn(q.status, q.publishedAnswer);
    out.push(item("question", {
      id: `q:${q.id}`, at: q.askedAt.toISOString(), dealId: q.dealId, dealName: dealName.get(q.dealId) ?? "", accessId: q.accessId,
      name: who, company: a?.buyerCompany ?? null,
      title: `${who} asked: “${clip(q.text.trim(), 140)}”`,
      detail: QUESTION_WORDS[waiting].detail,
      link: { href: `/deal/${q.dealId}/qa`, label: QUESTION_WORDS[waiting].label },
    }));
  }

  // ── Per link: NDA, decisions, broker actions ──
  const decisionsByAccess = new Map<string, DecisionRow[]>();
  for (const d of decisions) {
    const list = decisionsByAccess.get(d.accessId) ?? [];
    list.push(d);
    decisionsByAccess.set(d.accessId, list);
  }
  for (const a of inputs.access) {
    const name = buyerName(a);
    const base = { dealId: a.dealId, dealName: dealName.get(a.dealId) ?? "", accessId: a.id, name, company: a.buyerCompany };

    if (a.ndaSignedAt) {
      out.push(item("nda_signed", { ...base, id: `nda:${a.id}`, at: a.ndaSignedAt.toISOString(), title: `${name} signed the NDA`, detail: null, link: openBuyer(a) }));
    }

    // Decisions: every recorded one, plus the row's when it's final and differs.
    const events = [...(decisionsByAccess.get(a.id) ?? [])].sort((x, y) => x.at.getTime() - y.at.getTime());
    const last = events[events.length - 1];
    const rowItem = !!a.decision && FINAL.has(a.decision) && !!a.decisionAt && (!last || last.decision !== a.decision);
    const reasonText = a.decisionReason?.trim() ? `“${clip(a.decisionReason.trim(), 160)}”` : null;
    const decisionDetail = (decision: string, nextStep: string | null, withReason: boolean): string | null => {
      if (decision === "interested") return [nextStepWords(nextStep), withReason ? reasonText : null].filter(Boolean).join(" · ") || null;
      if (decision === "not_interested") return withReason ? reasonText : null;
      if (decision === "lapsed") return "Marked as no response after 8 days";
      return null;
    };
    const decisionTitle: Record<string, string> = {
      interested: `${name} chose Interested`,
      not_interested: `${name} chose Not interested`,
      need_more_time: `${name} asked for more time`,
      lapsed: `${name} didn't decide in time`,
    };
    events.forEach((d, i) => {
      const kind = DECISION_KIND[d.decision];
      if (!kind) return;
      // The reason on the row belongs to the latest matching decision.
      const isCurrent = !rowItem && i === events.length - 1 && d.decision === a.decision;
      out.push(item(kind, {
        ...base, id: `dec:${a.id}:${i}`, at: d.at.toISOString(), title: decisionTitle[d.decision],
        detail: decisionDetail(d.decision, d.nextStep ?? (isCurrent ? a.decisionNextStep : null), isCurrent),
        link: openBuyer(a),
      }));
    });
    if (rowItem) {
      const kind = DECISION_KIND[a.decision!]!;
      out.push(item(kind, {
        ...base, id: `decrow:${a.id}`, at: a.decisionAt!.toISOString(), title: decisionTitle[a.decision!],
        detail: decisionDetail(a.decision!, a.decisionNextStep, true),
        link: openBuyer(a),
      }));
    }

    // Broker actions.
    const grantedLevel = a.accessEvents.find((e) => e.type === "granted" && e.accessLevel)?.accessLevel ?? a.accessLevel;
    out.push(item("granted", {
      ...base, id: `grant:${a.id}`, at: a.createdAt.toISOString(),
      title: isTeaserOnly(grantedLevel) ? `You sent ${name} the teaser` : `You gave ${name} ${grantNounOf(grantedLevel)}`,
      detail: null, link: manageAccess({ dealId: a.dealId, accessLevel: grantedLevel }),
    }));
    a.accessEvents.forEach((e, i) => {
      const at = t(e.at) ? new Date(t(e.at)).toISOString() : null;
      if (!at) return;
      const id = `ev:${a.id}:${i}`;
      if (e.type === "level_changed") {
        out.push(item("level_changed", { ...base, id, at, title: `You moved ${name} to ${grantNounOf(e.accessLevel ?? a.accessLevel)}`, detail: null, link: manageAccess(a) }));
      } else if (e.type === "extended") {
        out.push(item("extended", { ...base, id, at, title: `You extended ${name}'s link`, detail: e.expiresAt ? `Now runs out ${dayMonth(e.expiresAt)}` : null, link: manageAccess(a) }));
      } else if (e.type === "contacted") {
        out.push(item("contacted", { ...base, id, at, title: `You marked ${name} as contacted`, detail: null, link: openBuyer(a) }));
      } else if (e.type === "cim_requested") {
        out.push(item("cim_requested", { ...base, id, at, title: `${name} asked for the CIM`, detail: "From the teaser", link: { href: `/deal/${a.dealId}/buyers?stage=approval`, label: "Review request" } }));
      }
    });
    if (a.revokedAt) {
      out.push(item("revoked", { ...base, id: `rev:${a.id}`, at: a.revokedAt.toISOString(), title: `You removed ${name}'s access`, detail: null, link: manageAccess(a) }));
    } else if (a.expiresAt && a.expiresAt.getTime() < now.getTime()) {
      out.push(item("link_expired", {
        ...base, id: `exp:${a.id}`, at: a.expiresAt.toISOString(), title: `${name}'s link ran out`,
        detail: !a.decision || !FINAL.has(a.decision) ? "They haven't decided. Extend it from the Buyers tab." : null,
        link: manageAccess(a),
      }));
    }
  }

  out.push(...(opts.extra ?? []));
  return filterAndSort(out, opts);
}

function filterAndSort(items: ActivityItem[], opts: ActivityOptions): ActivityItem[] {
  const { since } = rangeWindow(opts.range, opts.now);
  const sinceMs = since?.getTime() ?? null;
  const nowMs = opts.now.getTime();
  const access = opts.accessIds ? new Set(opts.accessIds) : null;
  const kinds = opts.kinds && opts.kinds !== "all" ? opts.kinds : null;
  return items
    .filter((i) => {
      const at = t(i.at);
      if (!at || at > nowMs) return false;
      if (sinceMs != null && at < sinceMs) return false;
      if (kinds && i.group !== kinds) return false;
      if (opts.dealId && i.dealId !== opts.dealId) return false;
      if (access && (!i.accessId || !access.has(i.accessId))) return false;
      return true;
    })
    .sort(compareItems)
    .slice(0, ACTIVITY_CAP);
}

/** Newest first, then by id (descending) — a total order, so paging is stable. */
export function compareItems(a: Pick<ActivityItem, "at" | "id">, b: Pick<ActivityItem, "at" | "id">): number {
  const ta = t(a.at);
  const tb = t(b.at);
  if (ta !== tb) return tb - ta;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

// ── Paging ────────────────────────────────────────────────────────────────

export function encodeCursor(i: Pick<ActivityItem, "at" | "id">): string {
  return Buffer.from(`${new Date(t(i.at)).toISOString()}|${i.id}`, "utf8").toString("base64url");
}

export function decodeCursor(c: string | null | undefined): { at: string; id: string } | null {
  if (!c || typeof c !== "string" || c.length > 400) return null;
  try {
    const s = Buffer.from(c, "base64url").toString("utf8");
    const bar = s.indexOf("|");
    if (bar <= 0) return null;
    const at = s.slice(0, bar);
    const id = s.slice(bar + 1);
    if (!id || !Number.isFinite(Date.parse(at))) return null;
    return { at, id };
  } catch {
    return null;
  }
}

/** The page of items strictly after the cursor (an invalid cursor → the first page). */
export function pageItems(items: ActivityItem[], cursor: string | null | undefined, limit: number = ACTIVITY_PAGE_DEFAULT): { items: ActivityItem[]; next: string | null } {
  const n = Math.max(1, Math.min(ACTIVITY_PAGE_MAX, Math.floor(Number(limit)) || ACTIVITY_PAGE_DEFAULT));
  const c = decodeCursor(cursor);
  const rest = c ? items.filter((i) => compareItems(i, c) > 0) : items;
  const page = rest.slice(0, n);
  return { items: page, next: rest.length > n ? encodeCursor(page[page.length - 1]) : null };
}

/** limit query → a number in [1, 100] (default 50). */
export function parseLimit(v: unknown): number {
  const s = Array.isArray(v) ? v[0] : v;
  const n = Math.floor(Number(s));
  if (!Number.isFinite(n) || n <= 0) return ACTIVITY_PAGE_DEFAULT;
  return Math.min(ACTIVITY_PAGE_MAX, n);
}
