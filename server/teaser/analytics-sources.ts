/**
 * Teaser reading for the Analytics page (INTEGRATION §2.9; analytics.md §11.3).
 * The integrator registers these with analytics' extra sources once both land:
 *   registerActivitySource(teaserActivityItems)
 *   registerHeadsUpSource(teaserHeadsUp)
 * The shapes match analytics' ActivityItem / HeadsUp structurally (no import:
 * analytics isn't on this branch). Teaser numbers never mix into CIM numbers.
 */
import { teaserEngagement } from "./engagement";

export interface TeaserDealRef {
  id: string;
  dealName?: string | null;
  businessName?: string | null;
}

export interface TeaserActivityItem {
  id: string;
  at: string;
  kind: "teaser_opened" | "cim_requested" | "teaser_passed";
  group: "teaser";
  dealId: string;
  dealName: string;
  accessId: string;
  name: string | null;
  company: string | null;
  title: string;
  detail: string | null;
  tone: "positive" | "negative" | "neutral";
  link: { href: string; label: string } | null;
}

export interface TeaserHeadsUp {
  id: string;
  count: number;
  text: string;
  names: string[];
  link: string;
}

const minutes = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.max(1, Math.round(ms / 1000))} s`);
const inWindow = (at: string | null, w: { since?: Date | string | null; until?: Date | string | null }) => {
  if (!at) return false;
  const t = Date.parse(at);
  if (w.since && t < new Date(w.since).getTime()) return false;
  if (w.until && t > new Date(w.until).getTime()) return false;
  return true;
};

/** One "opened the teaser" item per buyer (at their first open), plus "asked for the CIM" and "not for me". */
export async function teaserActivityItems(deals: TeaserDealRef[], window: { since?: Date | string | null; until?: Date | string | null } = {}): Promise<TeaserActivityItem[]> {
  const out: TeaserActivityItem[] = [];
  for (const d of deals) {
    const e = await teaserEngagement(d.id).catch(() => null);
    if (!e) continue;
    const dealName = d.dealName ?? d.businessName ?? "";
    for (const b of e.buyers) {
      const who = b.name ?? b.email;
      if (inWindow(b.firstOpenedAt, window)) {
        out.push({
          id: `teaser-open-${b.accessId}`, at: b.firstOpenedAt!, kind: "teaser_opened", group: "teaser", dealId: d.id, dealName, accessId: b.accessId,
          name: b.name, company: b.company, title: `${who} read the teaser`,
          detail: `${minutes(b.activeMs)}${b.readToEnd ? " · read to the end" : b.furthestBlock ? ` · stopped at ${b.furthestBlock}` : ""}`,
          tone: "neutral", link: { href: `/deal/${d.id}/buyers?stage=teaser`, label: "Have the teaser" },
        });
      }
      if (b.request.state !== "none" && inWindow(b.request.at, window)) {
        out.push({
          id: `teaser-ask-${b.accessId}`, at: b.request.at!, kind: "cim_requested", group: "teaser", dealId: d.id, dealName, accessId: b.accessId,
          name: b.name, company: b.company, title: `${who} asked for the CIM`, detail: null, tone: "positive",
          link: { href: `/deal/${d.id}/buyers?stage=approval`, label: "Review" },
        });
      }
      if (b.passed && inWindow(b.passed.at, window)) {
        out.push({
          id: `teaser-pass-${b.accessId}`, at: b.passed.at, kind: "teaser_passed", group: "teaser", dealId: d.id, dealName, accessId: b.accessId,
          name: b.name, company: b.company, title: `${who} said the teaser isn't for them`, detail: b.passed.reasons.join(", ") || null, tone: "negative",
          link: null,
        });
      }
    }
  }
  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** "{n} buyers read the teaser but didn't ask for the CIM" — one line per deal that has any. */
export async function teaserHeadsUp(deals: TeaserDealRef[], now = Date.now()): Promise<TeaserHeadsUp[]> {
  const out: TeaserHeadsUp[] = [];
  for (const d of deals) {
    const e = await teaserEngagement(d.id, now).catch(() => null);
    const worth = e?.buyers.filter((b) => b.worthACall) ?? [];
    if (worth.length === 0) continue;
    out.push({
      id: `teaser-worth-${d.id}`,
      count: worth.length,
      text: `${worth.length === 1 ? "1 buyer" : `${worth.length} buyers`} read the teaser but didn't ask for the CIM`,
      names: worth.map((b) => b.name ?? b.email).slice(0, 5),
      link: `/deal/${d.id}/buyers?stage=teaser`,
    });
  }
  return out;
}
