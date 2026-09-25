/**
 * completion-gaps — what must be discussed with the seller (or explicitly
 * deferred) before the interview may end on its own initiative.
 *
 * Completion governance used to block an end only when a critical section
 * had NO coverage at all. Document-rich deals looked covered before the
 * seller said a word, so interviews wrapped up with the critical real-estate
 * section partial, owner pay and add-backs never discussed, and planted
 * source conflicts never raised. This module lists the concrete items still
 * open; governCompletion (turn-guard.ts) blocks the end while any remain,
 * and the prompt shows them so the agent can plan. The seller asking to
 * stop always wins — that path never consults this list.
 *
 * Pure.
 */
import type { SectionCoverage } from "./knowledge-base";
import type { DeferralEntry } from "./deferral-ledger";
import { topicsMatch } from "./deferral-ledger";
import type { SourceConflict, FlaggedRisk } from "./source-context";
import { stemsOf } from "./source-context";
import { getFieldSources, isSourceKind } from "./info-merger";

/** One question → answer exchange (any session of the deal, including this turn). */
export interface Exchange { question: string; answer: string }

/** Seller-spoken kinds: the seller in the interview, on a call, or in the intake. */
const SELLER_KINDS = new Set(["interview", "call", "video_call", "questionnaire"]);

/**
 * Topics only the seller can speak to. Documents may hold a figure, but a
 * buyer needs the seller's own account — so each needs a seller-sourced
 * fact, an exchange in some session, or an explicit deferral.
 */
export const SELLER_ONLY_TOPICS: { label: string; keys: RegExp; talk: RegExp }[] = [
  {
    label: "reason for sale",
    keys: /^(reasonForSale|reasonForSelling|sellerMotivation)$/,
    talk: /reason.{0,20}(sale|sell)|why.{0,30}(sell|selling|exit)|retir(e|ing|ement)|what'?s (prompting|driving) (the|your) (sale|decision)/i,
  },
  {
    label: "transition and how long the owner will stay on",
    keys: /^(transitionPlan|trainingSupport|ownerTransition|transitionPeriod|stayOn\w*)$/,
    talk: /transition|stay on|stay involved|hand ?over|training period|after (the )?(sale|closing)|consult(ing)? (period|agreement)/i,
  },
  {
    label: "owner pay and perks",
    keys: /^(owner\w*(Comp\w*|Salary|Pay|Wage|Draw|Perks?|Benefits?)|ownerCompensation)$/,
    talk: /(your|owner'?s?|you) (own )?(salary|pay|paid|compensation|draw|wage)|pay yourself|perks|personal (expenses|vehicle|truck|car)|through the (business|company)/i,
  },
  {
    label: "add-backs (confirm the listed items)",
    keys: /^(addbacks|addBacks|normalizationAdjustments|sdeAdjustments)$/,
    talk: /add.?backs?|one.?time|non.?recurring|normali[sz]|discretionary/i,
  },
  {
    label: "deal structure preferences (share vs asset sale, seller financing)",
    keys: /^(saleType|dealStructure|sellerFinancing|vendorTakeBack|vendorFinancing|earnout|earnOut)$/,
    talk: /share sale|asset sale|seller financ|vendor (take.?back|financ)|earn.?out|deal structure|structure (the|a) (deal|sale)|financ(e|ing) (part|some)/i,
  },
  {
    label: "key-person risk (how the business runs without the owner)",
    keys: /^(ownerInvolvement|keyPersonRisk|ownerDependence|ownerDependency|ownerRole|ownerHours)$/,
    talk: /without you|if you (stepped|were|went) away|depend\w* on you|key (person|people|man)|run (it|the business|things) without|day.to.day role|your role/i,
  },
];

/** Generic items a critical section must have, as groups of alternative keys. */
const BASE_CRITICAL_ITEMS: Record<string, { label: string; keys: string[] }[]> = {
  real_estate: [{ label: "lease or property terms", keys: ["leaseDetails", "propertyInfo", "realEstateIncluded", "leaseExpiry", "monthlyRent", "annualRent"] }],
  revenue_sources: [{ label: "customer concentration", keys: ["customerConcentration", "topCustomers", "largestCustomer"] }],
  employees: [{ label: "key people and who runs what", keys: ["keyEmployees", "managementTeam", "employeeStructure"] }],
  financials: [
    { label: "revenue", keys: ["annualRevenue", "revenueByYear"] },
    { label: "profitability (SDE, EBITDA or margins)", keys: ["sde", "ebitda", "netIncome", "operatingMargins", "grossProfit", "adjustedEbitda"] },
  ],
  asking_price: [{ label: "the seller's asking-price expectation", keys: ["askingPrice"] }],
  reason_for_sale: [{ label: "reason for sale", keys: ["reasonForSale"] }],
};

const substantive = (v: unknown) =>
  v !== null && v !== undefined && !(typeof v === "string" && (v.trim().length < 2 || /^(n\/a|none|unknown|tbd|not sure)$/i.test(v.trim())));

/** A ledger entry (open or resolved) the agent created or that was settled — an explicit deferral counts as addressed. */
function addressedInLedger(ledger: DeferralEntry[], ...topics: string[]): boolean {
  return ledger.some(
    (e) => (e.status === "resolved" || e.origin !== "source") && topics.some((t) => t && topicsMatch(e.topic, t)),
  );
}

/** A substantive seller answer to a question on this topic, in any session. */
export function discussed(exchanges: Exchange[], re: RegExp): boolean {
  return exchanges.some((x) => re.test(x.question) && x.answer.trim().split(/\s+/).length >= 3);
}

/** True when an exchange covered a flagged risk (the question shares its distinctive words). */
export function riskDiscussed(exchanges: Exchange[], risk: FlaggedRisk): boolean {
  const r = stemsOf(`${risk.label} ${risk.text}`);
  return exchanges.some((x) => {
    const q = stemsOf(x.question);
    let shared = 0;
    q.forEach((w) => { if (r.has(w)) shared++; });
    return shared >= 2 && shared / Math.max(1, q.size) >= 0.3 && x.answer.trim().split(/\s+/).length >= 3;
  });
}

export interface CompletionGapInput {
  sectionCoverage: SectionCoverage[];
  /** Sections critical for this deal (base floor + industry ranking). */
  criticalSections: ReadonlySet<string>;
  /** The interview's view of the facts (with _fieldSources). */
  info: Record<string, unknown>;
  ledger: DeferralEntry[];
  exchanges: Exchange[];
  conflicts?: SourceConflict[];
  risks?: FlaggedRisk[];
  /** How many flagged risks must be covered (most-flagged first). */
  riskLimit?: number;
}

/**
 * Plain-language items still blocking a self-initiated wrap-up, most
 * important first. Each names the item so the agent (and the log) knows
 * exactly what to ask.
 */
export function completionBlockers(input: CompletionGapInput): string[] {
  const out: string[] = [];
  const sources = getFieldSources(input.info);
  const has = (k: string) => substantive(input.info[k]);
  const coveredKeys = new Set(
    input.sectionCoverage.flatMap((s) => s.fields.filter((f) => f.value !== null && !f.unverified).map((f) => f.fieldName)),
  );
  const verified = (k: string) => {
    if (coveredKeys.has(k)) return true;
    if (!has(k)) return false;
    const src = sources[k];
    return !src || !isSourceKind(src.source) || !["crm", "website", "social"].includes(src.source) || !!src.acceptedByBroker;
  };

  // 1. Unreconciled critical conflicts between sources.
  for (const c of input.conflicts ?? []) {
    if (!c.critical) continue;
    if (addressedInLedger(input.ledger, `reconcile ${c.key}`)) continue;
    out.push(`reconcile ${c.key} — ${c.values.map((v) => `"${v.value}" (${v.source})`).join(" vs ")}`);
  }

  // 2. Critical sections: their critical checklist items and base items.
  for (const s of input.sectionCoverage) {
    const critical = input.criticalSections.has(s.key) || s.importance === "critical";
    if (!critical || s.status === "missing") continue; // "missing" is governed separately
    for (const f of s.fields) {
      if (!f.critical || (f.value !== null && !f.unverified)) continue;
      if (addressedInLedger(input.ledger, f.fieldName, f.label ?? "")) continue;
      out.push(`${s.title}: ${f.label ?? f.fieldName} (record under ${f.fieldName})`);
    }
    for (const item of BASE_CRITICAL_ITEMS[s.key] ?? []) {
      if (item.keys.some(verified)) continue;
      if (addressedInLedger(input.ledger, item.label, ...item.keys)) continue;
      out.push(`${s.title}: ${item.label}`);
    }
  }

  // 3. Seller-only topics — the seller's own account, not a document's.
  for (const t of SELLER_ONLY_TOPICS) {
    const sellerFact = Object.keys(input.info).some(
      (k) => t.keys.test(k) && has(k) && SELLER_KINDS.has(String(sources[k]?.source ?? "")),
    );
    if (sellerFact) continue;
    if (discussed(input.exchanges, t.talk)) continue;
    if (input.ledger.some((e) => t.talk.test(e.topic) || topicsMatch(e.topic, t.label))) continue;
    out.push(`seller-only topic: ${t.label}`);
  }

  // 4. Risks the sources flag (the most-flagged first).
  for (const r of (input.risks ?? []).slice(0, input.riskLimit ?? 6)) {
    if (addressedInLedger(input.ledger, `risk: ${r.label}`)) continue;
    if (riskDiscussed(input.exchanges, r)) continue;
    out.push(`risk: ${r.label}`);
  }

  // De-duplicate (a base item and a seller-only topic can name the same thing).
  return Array.from(new Set(out));
}
