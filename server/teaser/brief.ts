/**
 * The teaser AI's brief — anonymous by construction, in layers (spec §4.5):
 *
 *  1. Identity terms and codename: the Blind CIM's terms, with the codename
 *     blind buyers are served (servedBlindCodename ?? ensureDealCodename).
 *  2. The confidentiality review (keepOutFor). When it couldn't run (by
 *     "rules" with a warning) the AI is NOT used: reviewFailed.
 *  3. The narrative — raw fact text never reaches the prompt:
 *     (a) the SERVED Blind CIM (buildBuyerCim at BLIND_ACCESS_LEVEL, the same
 *         call the view room makes: held, failed and staff-private sections
 *         aren't served, so they aren't here), in role order, financial
 *         tables and charts skipped, ≤ 1,500 characters a section, 9,000 in all;
 *     (b) no Blind CIM served: the teaser facts (seller-safe view → screened
 *         by screenFactsForCim with the review) assembled into one section
 *         and redacted by the Blind CIM's own engine (redactOneSection). A
 *         throw → redactionFailed (the teaser starts from the template).
 *     _brokerPrivateNotes, _sellerKeepOut, CRM text and broker-only documents
 *     are never read.
 *  4. Every figure removed (stripFigures).
 *  5. The fixed figures (key-numbers.ts) and the allowed phrases (the chips).
 */
import type { Deal } from "@shared/schema";
import { collectStrings, type BlindTerm } from "@shared/blind-guard";
import type { BuyerSection } from "@shared/cim-buyer-view";
import { BLIND_ACCESS_LEVEL } from "@shared/access-levels";
import { yearsRange } from "@shared/deal-bands";
import { NO_CODENAME, teaserTerms } from "@shared/teaser-view";
import type { KeepOutResult } from "../cim/keep-out";
import { headerChips, type TeaserFigures } from "./key-numbers";
import { stripFigures } from "./figures";

export interface TeaserNarrativeItem {
  title: string;
  text: string;
}

export interface TeaserBrief {
  dealId: string;
  codename: string;
  /** Why the codename would point at the business (blocks publishing), else null. */
  codenameProblem: string | null;
  industry: string | null;
  region: string | null;
  /** The only digits the AI may write: the chips' exact strings. */
  allowedPhrases: string[];
  narrative: TeaserNarrativeItem[];
  basis: "blind_cim" | "redacted_facts" | "template";
  reviewFailed: boolean;
  reviewWarning: string | null;
  redactionFailed: boolean;
  /** Names the review holds (customers in an unannounced bid…): never in teaser text. */
  heldNames: string[];
  terms: BlindTerm[];
  figures: TeaserFigures;
  /** "Canadian" | "US" spelling. */
  spelling: "Canadian" | "US";
}

/** Everything the brief reads (the database by default; tests pass fakes). */
export interface TeaserBriefDeps {
  /** The deal's facts as the CIM writer reads them (broker view, resolved discrepancies applied). */
  facts(deal: Deal): Promise<Record<string, unknown>>;
  /** Documents (visibility), for the seller-safe view on the facts path. */
  documents(dealId: string): Promise<Array<{ id: string; sourceKind?: string | null; visibility?: string | null }>>;
  /** The codename blind buyers are served (kept copy) or the deal's own (created when missing). */
  codename(deal: Deal): Promise<string>;
  keepOut(dealId: string, info: Record<string, unknown>): Promise<KeepOutResult>;
  /** The Blind CIM as blind buyers are served it now, with each served section's live key; null = none served. */
  servedBlind(deal: Deal, codename: string): Promise<{ sections: BuyerSection[]; liveKeys: Map<string, string> } | null>;
  figures(deal: Deal): Promise<TeaserFigures>;
  /** The Blind CIM's redaction engine on one synthetic section. */
  redact(section: { title: string; body: string }, deal: Deal, codename: string): Promise<{ title: string; body: string }>;
}

export const NARRATIVE_BUDGET = 9_000;
export const SECTION_BUDGET = 1_500;
const FACTS_BUDGET = 6_000;
const FACTS_MAX = 40;

/** Role order for the narrative (by the live section key / title words). */
const ROLE_ORDER: Array<RegExp> = [
  /executive|summary|snapshot|at a glance/i,
  /overview|company|business|about|history/i,
  /highlight|usp|unique|selling|advantage|strength|moat|why/i,
  /product|service|offering|revenue ?sources|sources ?of ?revenue|mix/i,
  /customer|market|client|target/i,
  /operation|facility|fleet|process|capacity|equipment/i,
  /team|employee|staff|people|management|organi[sz]ation/i,
  /growth|opportunit|expansion|upside/i,
  /reason|transition|succession|sale|seller|owner/i,
  /real ?estate|location|site|premises|lease/i,
];
const SKIP_LAYOUTS = new Set([
  "financial_table", "comparison_table", "bar_chart", "horizontal_bar_chart", "line_chart", "pie_chart", "donut_chart",
  "waterfall_chart", "scorecard", "cover_page", "org_chart", "location_map", "location_card", "image_gallery", "video", "divider",
]);
const SKIP_KEYS = /financ|ebitda|sde|income|balance|cash ?flow|working ?capital|normali[sz]|add-?back|valuation|price|transaction|deal ?structure|terms|contact|disclaimer|confidential/i;

function roleRank(key: string, title: string): number {
  const probe = `${key} ${title}`;
  const i = ROLE_ORDER.findIndex((re) => re.test(probe));
  return i < 0 ? ROLE_ORDER.length : i;
}

const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t);

/** The served Blind CIM → narrative items (role order, budgets, no financial pages). Pure. */
export function narrativeFromServed(sections: BuyerSection[], liveKeys: Map<string, string>): TeaserNarrativeItem[] {
  const items = sections
    .filter((s) => !SKIP_LAYOUTS.has(s.layoutType))
    .map((s) => ({ s, key: liveKeys.get(s.id) ?? s.sectionKey }))
    .filter(({ s, key }) => !SKIP_KEYS.test(`${key} ${s.sectionTitle}`))
    .sort((a, b) => roleRank(a.key, a.s.sectionTitle) - roleRank(b.key, b.s.sectionTitle) || a.s.order - b.s.order)
    .map(({ s }) => {
      const parts = [s.brokerEditedContent ?? s.aiDraftContent ?? "", ...collectStrings(s.layoutData)]
        .map((t) => String(t).replace(/\s+/g, " ").trim())
        .filter((t) => t.length > 2 && !/^https?:\/\//.test(t));
      const text = Array.from(new Set(parts)).join(" ");
      return { title: s.sectionTitle, text: clip(stripFigures(text), SECTION_BUDGET) };
    })
    .filter((x) => x.text.trim().length > 0);
  const out: TeaserNarrativeItem[] = [];
  let used = 0;
  for (const it of items) {
    if (used >= NARRATIVE_BUDGET) break;
    const room = NARRATIVE_BUDGET - used;
    const text = clip(it.text, Math.min(SECTION_BUDGET, room));
    out.push({ title: stripFigures(it.title), text });
    used += text.length;
  }
  return out;
}

/** The teaser facts read on the facts path (never _-keys, CRM text or broker notes). */
export const TEASER_FACT_KEYS = [
  "businessDescription", "summary", "companyHistory", "competitiveAdvantage", "uniqueSellingPropositions", "businessStrengths",
  "customerBase", "customerDemographics", "targetMarket", "recurringRevenue", "revenueStreams", "growthOpportunities", "expansionPlans",
  "reasonForSale", "idealBuyer", "transitionPlan", "trainingSupport", "realEstateIncluded", "leaseDetails",
  "sellerFinancing", "vendorTakeBack", "operationsNotes",
] as const;

const valueText = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return v.map(valueText).filter(Boolean).join("; ");
  if (typeof v === "object") return Object.values(v as Record<string, unknown>).map(valueText).filter(Boolean).join("; ");
  return "";
};

/** The facts path's synthetic section text (screened pairs → "Label: text" lines, capped). Pure. */
export function factsDigest(pairs: Array<[string, unknown]>, planItems: string[] = []): string {
  const lines: string[] = [];
  let used = 0;
  for (const [k, v] of pairs) {
    if (lines.length >= FACTS_MAX || used >= FACTS_BUDGET) break;
    const t = valueText(v).replace(/\s+/g, " ").trim();
    if (!t) continue;
    const label = k.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
    const line = clip(`${label}: ${t}`, Math.min(800, FACTS_BUDGET - used));
    lines.push(line);
    used += line.length;
  }
  for (const p of planItems) {
    if (lines.length >= FACTS_MAX || used >= FACTS_BUDGET) break;
    lines.push(clip(p, 300));
    used += p.length;
  }
  return lines.join("\n");
}

export async function buildTeaserBrief(deal: Deal, deps: TeaserBriefDeps): Promise<TeaserBrief> {
  const codename = (await deps.codename(deal)) || NO_CODENAME;
  const { codenameProblem } = await import("../cim/codenames");
  const problem = codenameProblem(deal as never, codename);
  const info = await deps.facts(deal);
  const figures = await deps.figures(deal);
  const keepOut = await deps.keepOut(deal.id, info);
  const reviewFailed = keepOut.by === "rules" && !!keepOut.warning;
  const terms = teaserTerms(deal, codename);
  const years = yearsRange(figures.yearsInBusiness);
  const allowedPhrases = Array.from(new Set([...headerChips(figures), ...(years ? [years] : [])]));
  const spelling: TeaserBrief["spelling"] = /united states|usa|\bus\b/i.test(`${figures.region ?? ""}`) || /^(?:Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming)$/.test(figures.region ?? "") ? "US" : "Canadian";
  const base = {
    dealId: deal.id,
    codename,
    codenameProblem: problem,
    industry: figures.industry,
    region: figures.region,
    allowedPhrases,
    reviewFailed,
    reviewWarning: reviewFailed ? keepOut.warning ?? null : null,
    heldNames: keepOut.names,
    terms,
    figures,
    spelling,
  };
  // The review couldn't run: the AI isn't used, so no narrative is read.
  if (reviewFailed) return { ...base, narrative: [], basis: "template", redactionFailed: false };

  // (a) The served Blind CIM.
  const served = await deps.servedBlind(deal, codename).catch(() => null);
  if (served && served.sections.length > 0) {
    const narrative = narrativeFromServed(served.sections, served.liveKeys);
    if (narrative.length > 0) return { ...base, narrative, basis: "blind_cim", redactionFailed: false };
  }

  // (b) No Blind CIM served: the teaser facts, screened, through the Blind CIM's redaction engine.
  const { sellerInterviewView } = await import("../interview/seller-view");
  const { screenFactsForCim } = await import("../cim/sensitive-facts");
  const safeView = sellerInterviewView(info as never, (await deps.documents(deal.id)) as never) as Record<string, unknown>;
  const pairs = TEASER_FACT_KEYS.filter((k) => safeView[k] !== undefined).map((k) => [k, safeView[k]] as [string, unknown]);
  const screened = screenFactsForCim(pairs, keepOut);
  const plan = (deal as unknown as { interviewPlan?: { sections?: Array<{ items?: Array<{ label?: string; critical?: boolean; answeredByKey?: string | null }> }> } }).interviewPlan;
  const planLines = (plan?.sections ?? []).flatMap((s) => s.items ?? []).filter((i) => i.critical && i.answeredByKey && safeView[i.answeredByKey] !== undefined && !TEASER_FACT_KEYS.includes(i.answeredByKey as never))
    .map((i) => `${i.label ?? i.answeredByKey}: ${valueText(safeView[i.answeredByKey!])}`);
  const digest = factsDigest(screened.safe, planLines);
  if (!digest.trim()) return { ...base, narrative: [], basis: "template", redactionFailed: false };
  try {
    const red = await deps.redact({ title: "About the business", body: digest }, deal, codename);
    const text = stripFigures(red.body);
    return { ...base, narrative: [{ title: "About the business", text: clip(text, NARRATIVE_BUDGET) }], basis: "redacted_facts", redactionFailed: false };
  } catch (err) {
    console.warn(`[teaser] facts redaction failed for deal ${deal.id}:`, (err as Error)?.message);
    return { ...base, narrative: [], basis: "template", redactionFailed: true };
  }
}

/** The database-backed deps. */
export const dbBriefDeps: TeaserBriefDeps = {
  async facts(deal) {
    const { storage } = await import("../storage");
    const { brokerFactsView } = await import("../information/facts");
    const { settleResolvedFacts, resolvedNotes } = await import("../cim/resolved-block");
    const settled = settleResolvedFacts(
      (brokerFactsView(deal).extractedInfo as Record<string, unknown>) || {},
      resolvedNotes(await storage.getResolvedDiscrepancies(deal.id).catch(() => [])),
    );
    return settled.facts;
  },
  async documents(dealId) {
    const { storage } = await import("../storage");
    return storage.getDocumentsByDeal(dealId).catch(() => []);
  },
  async codename(deal) {
    const { servedBlindCodename } = await import("../cim/published-snapshot");
    const { ensureDealCodename } = await import("../cim/codenames");
    return (await servedBlindCodename(deal)) ?? (await ensureDealCodename(deal));
  },
  async keepOut(dealId, info) {
    const { keepOutFor } = await import("../cim/keep-out");
    return keepOutFor(dealId, info);
  },
  async servedBlind(deal, codename) {
    const { buyerCimRows } = await import("../cim/published-snapshot");
    const { buildBuyerCim } = await import("@shared/cim-buyer-view");
    const { listedAskingPrice } = await import("../information/deal-mirror");
    const rows = await buyerCimRows(deal, BLIND_ACCESS_LEVEL);
    if (rows.missing) return null;
    const cim = buildBuyerCim({
      deal: { ...deal, blindCodename: codename },
      accessLevel: BLIND_ACCESS_LEVEL,
      sections: rows.sections,
      overrides: rows.overrides,
      askingPrice: listedAskingPrice(deal),
      published: rows.published,
    });
    if (cim.preparing || cim.sections.length === 0) return null;
    return { sections: cim.sections, liveKeys: new Map(rows.sections.map((s) => [s.id, s.sectionKey])) };
  },
  async figures(deal) {
    const { teaserFigures } = await import("./key-numbers");
    return teaserFigures(deal);
  },
  async redact(section, deal, codename) {
    const { redactOneSection } = await import("../cim/redaction-engine");
    const synthetic = {
      id: `teaser-facts-${deal.id}`,
      dealId: deal.id,
      sectionKey: "teaserFacts",
      sectionTitle: section.title,
      layoutType: "prose_highlight",
      layoutData: { body: section.body },
      aiDraftContent: section.body,
      brokerEditedContent: null,
      isVisible: true,
      order: 0,
    };
    const r = await redactOneSection(synthetic as never, deal as never, codename);
    // The body is the content text (sent once): the redacted content comes back as both.
    const data = (r.layoutData as Record<string, unknown> | null) ?? {};
    const body = r.contentOverride || (typeof data.body === "string" ? data.body : "");
    return { title: r.sectionTitle, body };
  },
};
