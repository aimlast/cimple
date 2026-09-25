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
import { stemsOf, MATERIAL_RISK_RE } from "./source-context";
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

/**
 * When an entry made THIS turn may count as addressing an item: only when
 * this turn's exchange was about it (the seller was just asked, or just
 * spoke to it). A deferral or "resolved" minted in a goodbye message — the
 * agent parking everything it never asked so it can end — is not an answer.
 */
export interface SameTurnContext {
  /** The seller turn being processed (the ledger's createdAtTurn / resolvedAtTurn numbering). */
  turn: number;
  /** The question the seller just answered and the seller's message this turn. */
  lastQuestion?: string;
  sellerMessage?: string;
}

/** Stems of a topic label, without the ledger's prefixes ("risk:", "reconcile …"). */
function topicStems(topic: string): Set<string> {
  return stemsOf(
    topic
      .replace(/^(risk:|reconcile\s+|verify\s+)/i, "")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2"),
  );
}

/** The text is about the topic: shares two of its words (or its only one). */
function talksAbout(text: string | undefined, topic: string): boolean {
  if (!text) return false;
  const t = topicStems(topic);
  if (t.size === 0) return false;
  const x = stemsOf(text.replace(/([a-z0-9])([A-Z])/g, "$1 $2"));
  let shared = 0;
  t.forEach((w) => { if (x.has(w)) shared++; });
  return shared >= Math.min(2, t.size);
}

/** An entry that counts as the item being addressed (see SameTurnContext). */
function entryCounts(e: DeferralEntry, now?: SameTurnContext): boolean {
  if (e.status === "open" && e.origin === "source") return false; // on the agenda, never raised
  if (!now || e.earlierSession) return true;
  const madeNow = e.status === "resolved" ? e.resolvedAtTurn === now.turn : e.createdAtTurn === now.turn;
  if (!madeNow) return true;
  return talksAbout(now.lastQuestion, e.topic) || talksAbout(now.sellerMessage, e.topic);
}

/** A ledger entry (open or resolved) the agent created or that was settled — an explicit deferral counts as addressed. */
function addressedInLedger(ledger: DeferralEntry[], now: SameTurnContext | undefined, ...topics: string[]): boolean {
  return ledger.some((e) => entryCounts(e, now) && topics.some((t) => t && topicsMatch(e.topic, t)));
}

/** A substantive seller answer to a question on this topic, in any session. */
export function discussed(exchanges: Exchange[], re: RegExp): boolean {
  return exchanges.some((x) => re.test(x.question) && x.answer.trim().split(/\s+/).length >= 3);
}

/** Words that make a risk material ("termination", "lawsuit", "guarantee"…), as stems. */
function materialStems(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().match(/[a-z][a-z'’-]{2,}/g) ?? []) {
    if (MATERIAL_RISK_RE.test(w)) out.add(w.slice(0, 5));
  }
  return out;
}

/**
 * True when an exchange covered a flagged risk: the question shares its
 * distinctive words — and, when the risk names what makes it material (a
 * termination right, a lawsuit, a guarantee), that too. A question about
 * Alderbrook's revenue share doesn't cover "Alderbrook can terminate on 90
 * days' notice".
 */
export function riskDiscussed(exchanges: Exchange[], risk: FlaggedRisk): boolean {
  const r = stemsOf(`${risk.label} ${risk.text}`);
  const material = materialStems(`${risk.label} ${risk.text}`);
  return exchanges.some((x) => {
    const q = stemsOf(x.question);
    let shared = 0;
    q.forEach((w) => { if (r.has(w)) shared++; });
    if (shared < 2 || x.answer.trim().split(/\s+/).length < 3) return false;
    let hit = false;
    material.forEach((m) => { if (q.has(m)) hit = true; });
    // Asked about what makes it material (and the subject): covered, however
    // long the question. Otherwise the question must be mostly about it.
    if (hit) return true;
    return material.size === 0 && shared / Math.max(1, q.size) >= 0.3;
  });
}

/** Generic words in checklist labels that say nothing about which item it is. */
const ITEM_NOISE = new Set(["any", "all", "list", "details", "detail", "status", "names", "name", "number", "count", "etc", "including", "whether", "current", "annual", "total", "type", "types", "level", "plan", "history"].map((w) => w.slice(0, 5)));

/**
 * A checklist item the seller already spoke to in some session: an earlier
 * question shares its distinctive words (an acronym like CARB counts double)
 * and got a real answer — "we don't run California lanes" answers "Any
 * emissions deadlines (CARB, etc.)" even though nothing was recorded under
 * the item's key.
 */
export function itemDiscussed(exchanges: Exchange[], label: string, key: string): boolean {
  const words = `${label} ${key.replace(/([a-z0-9])([A-Z])/g, "$1 $2")}`.replace(/-/g, " ");
  const stems = new Set(Array.from(stemsOf(words)).filter((w) => !ITEM_NOISE.has(w)));
  const acronyms = new Set((label.match(/\b[A-Z][A-Z0-9&]{1,6}\b/g) ?? []).map((a) => a.toLowerCase().slice(0, 5)));
  if (stems.size === 0) return false;
  return exchanges.some((x) => {
    if (x.answer.trim().split(/\s+/).length < 3) return false;
    const q = stemsOf(x.question.replace(/-/g, " ")); // "CARB-compliant" names CARB
    let shared = 0;
    let acronymHit = false;
    stems.forEach((w) => { if (q.has(w)) { shared++; if (acronyms.has(w)) acronymHit = true; } });
    return (acronymHit && shared >= 1) || shared >= Math.max(2, Math.ceil(stems.size * 0.6));
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
  /**
   * The turn being decided (governance of a proposed end): deferrals and
   * resolutions the agent records in this very turn count only when this
   * turn's exchange was about them.
   */
  now?: SameTurnContext;
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
    if (addressedInLedger(input.ledger, input.now, `reconcile ${c.key}`)) continue;
    out.push(`reconcile ${c.key} — ${c.values.map((v) => `"${v.value}" (${v.source})`).join(" vs ")}`);
  }

  // 2. Critical sections: their critical checklist items and base items.
  for (const s of input.sectionCoverage) {
    const critical = input.criticalSections.has(s.key) || s.importance === "critical";
    if (!critical || s.status === "missing") continue; // "missing" is governed separately
    for (const f of s.fields) {
      if (!f.critical || (f.value !== null && !f.unverified)) continue;
      if (addressedInLedger(input.ledger, input.now, f.fieldName, f.label ?? "")) continue;
      if (itemDiscussed(input.exchanges, f.label ?? "", f.fieldName)) continue;
      out.push(`${s.title}: ${f.label ?? f.fieldName} (record under ${f.fieldName})`);
    }
    for (const item of BASE_CRITICAL_ITEMS[s.key] ?? []) {
      if (item.keys.some(verified)) continue;
      if (addressedInLedger(input.ledger, input.now, item.label, ...item.keys)) continue;
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
    if (input.ledger.some((e) => entryCounts(e, input.now) && (t.talk.test(e.topic) || topicsMatch(e.topic, t.label)))) continue;
    out.push(`seller-only topic: ${t.label}`);
  }

  // 4. Risks the sources flag (the most-flagged first).
  for (const r of (input.risks ?? []).slice(0, input.riskLimit ?? 6)) {
    if (addressedInLedger(input.ledger, input.now, `risk: ${r.label}`)) continue;
    if (riskDiscussed(input.exchanges, r)) continue;
    out.push(`risk: ${r.label}`);
  }

  // De-duplicate (a base item and a seller-only topic can name the same thing).
  return Array.from(new Set(out));
}
