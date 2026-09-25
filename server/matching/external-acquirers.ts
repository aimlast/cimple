/**
 * Outside acquirers — likely buyers who are NOT in the broker's list yet.
 *
 * The supporting model researches the web (Anthropic web search) for
 * strategic acquirers consolidating in the deal's industry and region, PE
 * platforms and family offices active in the space, and returns a cited
 * list. Two anti-hallucination rules:
 *   - every source URL must be one the search actually returned;
 *   - a contact (email/phone/page) is kept only if it appears verbatim in
 *     text the search cited — contact details are never guessed.
 * The research brief is blind: industry, region (province/state), size bands
 * and qualities only — never the business name, owner or city, so nothing
 * identifying is sent into web searches.
 *
 * Broker-facing only. Nothing is sent to anyone; the broker decides whom to
 * contact.
 */
import Anthropic from "@anthropic-ai/sdk";
import { storage } from "../storage";
import { agentConfig } from "../interview/config/load-config";
import type { Deal, ExternalAcquirer, ExternalAcquirerSearch } from "@shared/schema";
import { blindLeakTerms, findBlindLeaks, honorificNames, peopleInFact, type BlindTerm } from "@shared/blind-guard";
import { isRegionLabel } from "@shared/cim-media";
import { EVERYDAY_NAME_WORDS, isCommonWord, isOccupationWord } from "@shared/blind-vocabulary";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const running = new Set<string>();

const PROVINCES: Record<string, string> = { ON: "Ontario", QC: "Quebec", BC: "British Columbia", AB: "Alberta", MB: "Manitoba", SK: "Saskatchewan", NS: "Nova Scotia", NB: "New Brunswick", NL: "Newfoundland and Labrador", PE: "Prince Edward Island" };
const REGION_NAMES = ["Ontario", "Quebec", "British Columbia", "Alberta", "Manitoba", "Saskatchewan", "Nova Scotia", "New Brunswick", "Newfoundland", "Prince Edward Island", "Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut", "Delaware", "Florida", "Georgia", "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa", "Kansas", "Kentucky", "Louisiana", "Maine", "Maryland", "Massachusetts", "Michigan", "Minnesota", "Mississippi", "Missouri", "Montana", "Nebraska", "Nevada", "New Hampshire", "New Jersey", "New Mexico", "New York", "North Carolina", "North Dakota", "Ohio", "Oklahoma", "Oregon", "Pennsylvania", "Rhode Island", "South Carolina", "South Dakota", "Tennessee", "Texas", "Utah", "Vermont", "Virginia", "Washington", "West Virginia", "Wisconsin", "Wyoming"];
const REGION_RE = new RegExp(`\\b(${[...REGION_NAMES, "ON", "QC", "BC", "AB", "MB", "SK", "NS", "NB", "NL", "PE"].join("|")})\\b`);
// Multi-word region names: "British Columbia" is the province, even though
// the facts' people parser may list "Columbia" as a name.
const MULTI_WORD_REGION = new RegExp(`\\b(?:${REGION_NAMES.filter((n) => n.includes(" ")).join("|")})\\b`, "gi");

const txt = (v: unknown): string => (typeof v === "string" ? v : v && typeof v === "object" && "value" in (v as any) ? txt((v as any).value) : "");
function band(raw: string): string | null {
  const m = raw.replace(/,/g, "").match(/\$?\s*([\d.]+)\s*(m|mm|million|k|thousand)?/i);
  if (!m) return null;
  let n = parseFloat(m[1]);
  const u = (m[2] || "").toLowerCase();
  if (u.startsWith("m")) n *= 1_000_000; else if (u.startsWith("k") || u === "thousand") n *= 1000;
  if (!n || n < 10_000) return null;
  if (n < 500_000) return "under $500K";
  if (n < 1_000_000) return "$500K–$1M";
  if (n < 2_000_000) return "$1M–$2M";
  if (n < 5_000_000) return "$2M–$5M";
  if (n < 10_000_000) return "$5M–$10M";
  if (n < 25_000_000) return "$10M–$25M";
  return "$25M+";
}

const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const L = "A-Za-z0-9À-ÖØ-öø-ÿ";
const TITLE = "Dr|Dre|Mr|Mrs|Ms|Miss|Mx|Prof";
const RELATION =
  "son|daughter|wife|husband|spouse|partner|brother|sister|nephew|niece|cousin|father|mother|dad|mom|mum|grandson|granddaughter|son-in-law|daughter-in-law|stepson|stepdaughter";
/**
 * A term as a fold-tolerant pattern ("Manpreet Grewal" also matches
 * "Manpreet  Grewal's"), with what surrounds a name in prose captured so it
 * can be rewritten naturally: 1 = title ("Dr. "), 2 = relation ("son "),
 * 3 = the name itself, 4 = possessive "'s", 5 = " family".
 */
function termPattern(text: string): RegExp {
  const words = text.split(new RegExp(`[^${L}]+`)).filter(Boolean).map(escapeRe);
  return new RegExp(
    `(?<![${L}])(?:((?:${TITLE})\\.?\\s+)|((?:${RELATION})\\s+))?(${words.join(`[^${L}]+`)})(?![${L}])(['’]s)?(\\s+family\\b)?`,
    "gi",
  );
}
/** Replace a term with a neutral phrase that still reads well in its sentence. */
function neutralise(text: string, term: string, kind: BlindTerm["kind"], capitalisedOnly: boolean, regionWord?: BlindTerm): string {
  return text.replace(termPattern(term), (m, title: string | undefined, rel: string | undefined, core: string, poss: string | undefined, family: string | undefined, offset: number, whole: string) => {
    // Everyday-word terms count only capitalised — never rewrite the word itself.
    if (capitalisedOnly && core === core.toLowerCase()) return m;
    const before = whole.slice(0, offset);
    const after = whole.slice(offset + m.length);
    // A surname that is also a province/state ("Dana Washington"): leave the
    // place ("Washington State lanes", "customers in Montana") alone — the
    // blind guard decides from the words around this one mention.
    if (regionWord && !findBlindLeaks(`${before.slice(-40)}${m}${after.slice(0, 40)}`, [regionWord]).length) return m;
    const s = poss ? "’s" : "";
    const afterThe = /\bthe\s+$/i.test(before);
    if (kind === "person") {
      if (family) return `${afterThe ? "" : "the "}owner’s family`;
      if (rel) {
        const owned = /\b(?:my|our|his|her|their|the|owner['’]s|seller['’]s)\s+$/i.test(before);
        return `${owned ? "" : "the owner’s "}${rel.trim()}${s}`;
      }
      // "head baker Rosa" → "head baker": the role already says who.
      const prevWord = /([A-Za-z]+)\s+$/.exec(before)?.[1] ?? "";
      if (!s && /^[a-z]/.test(prevWord) && (isOccupationWord(prevWord) || /^(?:gm|manager|lead|controller|bookkeeper|foreman|supervisor)$/i.test(prevWord))) return "";
      return `a key person${s}`;
    }
    const tail = family ? family : "";
    if (kind === "name") return `${title ?? ""}${rel ?? ""}${afterThe ? "" : "the "}business${s}${tail}`;
    if (kind === "place") {
      // "Delta cross-dock" → "local cross-dock"; "in Delta" → "in the local area".
      const adjectival = /^\s+[a-z]/.test(after) && !poss;
      return `${title ?? ""}${rel ?? ""}${adjectival ? "local" : "the local area"}${s}${tail}`;
    }
    return `${title ?? ""}${rel ?? ""}`;
  });
}
/** Hide multi-word region names while checking/rewriting, then put them back. */
function withRegionsMasked(text: string, fn: (masked: string) => string): string {
  const kept: string[] = [];
  const masked = text.replace(MULTI_WORD_REGION, (m) => `⟦${kept.push(m) - 1}⟧`);
  return fn(masked).replace(/⟦(\d+)⟧/g, (_m, i) => kept[Number(i)] ?? "");
}
/** Identifying terms in text, ignoring words that are part of a province/state name. */
export function briefLeaks(text: string, terms: BlindTerm[]): string[] {
  let hits: string[] = [];
  withRegionsMasked(text, (masked) => {
    hits = findBlindLeaks(masked, terms);
    return masked;
  });
  return hits;
}

// Brands that look like people ("Tim Hortons", "Wendy's", "Mr. Lube",
// "Dr. Oetker", "Edward Jones"). For a franchise resale the brand is the
// research's key signal and identifies no single business, so the person
// heuristics must leave it alone. A name counts as a brand when the deal's
// industry label names it (the broker's own classification never names
// people) or when it is directly followed by a franchise/dealer word. A name
// after a relation word ("son Tim") is always a person. The deal's own terms
// are applied before this and still win: a business named "Tim Hortons
// Bedford" keeps its brand hidden.
const BRAND_WORDS = [
  "franchise", "franchises", "franchisee", "franchisees", "franchisor", "franchising", "dealer", "dealers", "dealership", "dealerships",
  "distributor", "distributors", "distributorship", "branch", "branches", "licensee", "licensees", "brand", "banner", "outlet", "outlets",
];
// Case-sensitive on purpose: the one word allowed between the name and the
// franchise word must be capitalised ("Mary Brown's Chicken franchise") or
// "restaurant" ("Harvey's restaurant franchise"), so "keeps Maria as branch
// manager" is not read as a brand.
const BRAND_AFTER = new RegExp(
  `^(?:['’]s)?(?:\\s+(?:[A-Z][${L}'’-]*|restaurants?))?\\s+(?:${BRAND_WORDS.flatMap((w) => [w, w[0].toUpperCase() + w.slice(1)]).join("|")})(?![${L}])`,
);
const RELATION_BEFORE = new RegExp(`\\b(?:${RELATION})\\s+$`, "i");

/** The person-looking names in text, as bare names (no title, no "Ms." variants). */
function nameCandidates(text: string): string[] {
  const raw = [...honorificNames(text), ...peopleInFact(text, "prose")].map((p) => p.replace(new RegExp(`^(?:${TITLE})\\.?\\s+`, "i"), "").trim());
  return Array.from(new Set(raw.filter(Boolean))).sort((a, b) => b.length - a.length);
}

/**
 * Hide brand names while the person heuristics run, then put them back.
 * `known` = brands the industry label names (always brands, wherever they
 * appear); any other name is a brand only where a franchise word follows it.
 */
function withBrandsMasked(text: string, known: string[], fn: (masked: string) => string): string {
  const kept: string[] = [];
  const pattern = (name: string) => {
    const words = name.split(new RegExp(`[^${L}]+`)).filter(Boolean).map(escapeRe);
    return words.length ? new RegExp(`(?<![${L}])((?:${TITLE})\\.?\\s+)?${words.join(`[^${L}]+`)}(?![${L}])`, "g") : null;
  };
  // A name is a brand when the label names it, or when any of its mentions
  // here is followed by a franchise word — then every mention is the brand
  // ("Mr. Lube franchise; Mr. Lube must approve the buyer").
  const brands = new Set(known.map((k) => k.toLowerCase()));
  for (const name of nameCandidates(text)) {
    const re = pattern(name);
    let hit: RegExpExecArray | null;
    while (re && (hit = re.exec(text))) {
      if (!RELATION_BEFORE.test(text.slice(0, hit.index)) && BRAND_AFTER.test(text.slice(hit.index + hit[0].length))) brands.add(name.toLowerCase());
    }
  }
  let masked = text;
  for (const name of Array.from(new Set([...known, ...nameCandidates(text)])).sort((a, b) => b.length - a.length)) {
    const re = pattern(name);
    if (!re || !brands.has(name.toLowerCase())) continue;
    masked = masked.replace(re, (m, _title, offset: number, whole: string) =>
      RELATION_BEFORE.test(whole.slice(0, offset)) ? m : `⟪${kept.push(m) - 1}⟫`,
    );
  }
  return fn(masked).replace(/⟪(\d+)⟫/g, (_m, i) => kept[Number(i)] ?? "");
}

/** Brand names in the deal's industry label ("Franchise — Tim Hortons franchise"). */
export function labelBrands(label: string): string[] {
  let found: string[] = [];
  withRegionsMasked(label, (masked) => {
    found = nameCandidates(masked).filter((n) => {
      const re = new RegExp(`(?<![${L}])${escapeRe(n)}(?![${L}])`, "g");
      let hit: RegExpExecArray | null;
      while ((hit = re.exec(masked))) {
        if (!RELATION_BEFORE.test(masked.slice(0, hit.index).replace(new RegExp(`(?:${TITLE})\\.?\\s+$`, "i"), ""))) return true;
      }
      return false;
    });
    return masked;
  });
  return found;
}

/**
 * Free text from the facts made blind: every identifying term the facts
 * name (business names, people, city, street, contacts) and any titled or
 * known-given-name person in the prose is replaced with a neutral phrase.
 * Brand names (see `withBrandsMasked`) are not people and stay.
 * Returns null when something identifying is still there — the caller
 * leaves the line out (fail closed).
 */
export function blindFreeText(text: string, terms: BlindTerm[], opts: { prose?: boolean; brands?: string[] } = {}): string | null {
  // prose=false: only the deal's own terms — for AI output about OTHER
  // organisations, where the name heuristics would rewrite real names.
  const prose = opts.prose !== false;
  const brands = opts.brands ?? [];
  const byLength = [...terms].sort((a, b) => b.text.length - a.text.length);
  let out = withRegionsMasked(text, (masked) => {
    let o = masked;
    for (const t of byLength) {
      if (!findBlindLeaks(o, [t]).length) continue;
      if (t.titled) {
        // "Ms. Winter" — the surname counts only with a title or "family".
        const surname = t.text.split(/\s+/).pop() || "";
        o = o.replace(new RegExp(`\\b(?:${TITLE})\\.?\\s+${escapeRe(surname)}\\b(['’]s)?`, "gi"), (_m, poss) => `a key person${poss ? "’s" : ""}`);
        o = o.replace(new RegExp(`\\b(the\\s+)?${escapeRe(surname)}(?:['’]s)?\\s+family\\b`, "gi"), "the owner’s family");
        continue;
      }
      o = neutralise(o, t.text, t.kind, !!t.common, t.regionWord ? t : undefined);
    }
    // People the facts don't list but the prose names ("son Manpreet", "Dr. Lee").
    if (!prose) return o;
    return withBrandsMasked(o, brands, (m) => {
      let x = m;
      for (const p of [...honorificNames(x), ...peopleInFact(x, "prose")].sort((a, b) => b.length - a.length)) {
        x = neutralise(x, p.replace(new RegExp(`^(?:${TITLE})\\.?\\s+`, "i"), ""), "person", false);
      }
      return x;
    });
  });
  out = out
    .replace(/\b(a key person)(?:\s+a key person)+/g, "$1")
    .replace(/\bthe\s+the\b/gi, "the")
    .replace(/(^|[.!?]\s+)(a key person|the owner’s|the business|the local area)/g, (_m, p: string, w: string) => p + w[0].toUpperCase() + w.slice(1))
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .trim();
  if (!out || briefLeaks(out, terms).length) return null;
  if (!prose) return out;
  let people = 0;
  withRegionsMasked(out, (masked) =>
    withBrandsMasked(masked, brands, (m) => {
      people = honorificNames(m).length + peopleInFact(m, "prose").length;
      return m;
    }),
  );
  return people ? null : out;
}

const DEAL_WORDS = /^(?:buyers?|sellers?|owners?|purchasers?|acquirers?|investors?|vendors?|brokers?|landlords?|tenants?|someone|anyone|company|companies|operators?|management|staff|team|employees?|customers?|clients?|partners?)$/i;

/** The terms that would identify this deal, for the brief and the stored results. */
export function briefTerms(deal: Deal): BlindTerm[] {
  // The province/state is part of the brief on purpose (Blind CIMs keep it
  // too), so a region name the facts happen to list is not an identifier here
  // — except a person's surname that is also a region ("Dana Washington"):
  // the blind guard marks it `regionWord` and counts it only where it means
  // the person, so it stays.
  // Words about the deal itself ("Buyer", "Seller", "Owner") are never an
  // identifier, even when a loosely written fact makes one look like a place.
  const terms = blindLeakTerms(deal as any, { codename: (deal as any).blindCodename ?? null })
    .filter((t) => (t.regionWord || !isRegionLabel(t.text)) && !DEAL_WORDS.test(t.text.trim()));
  // People are talked about by first name ("son Manpreet stays on"): each
  // person's given name counts on its own too (capitalised only).
  const have = new Set(terms.map((t) => t.text.toLowerCase()));
  for (const t of [...terms]) {
    if (t.kind !== "person" || t.titled) continue;
    const first = t.text.split(/\s+/)[0].replace(/[^A-Za-zÀ-ÖØ-öø-ÿ'’-]/g, "");
    if (first.length < 3 || first === t.text || have.has(first.toLowerCase()) || isRegionLabel(first)) continue;
    have.add(first.toLowerCase());
    // A first name that is also a word ("Mark", "Grant") counts only capitalised.
    const word = EVERYDAY_NAME_WORDS.has(first.toLowerCase()) || isCommonWord(first.toLowerCase());
    terms.push({ text: first, kind: "person", common: word });
  }
  return terms;
}

export class BlindBriefError extends Error {}

/**
 * Blind research brief — nothing that identifies the business. It goes into
 * web searches, so it is pre-NDA material: structured bands and region, and
 * free text only after `blindFreeText` (lines that can't be made blind are
 * left out). The whole brief is checked again before it is returned; if it
 * still names anything, it throws (the research never runs).
 */
export function blindBrief(deal: Deal): { brief: string; region: string | null; withheld: number } {
  const info = ((deal as any).extractedInfo || {}) as Record<string, unknown>;
  const terms = briefTerms(deal);
  let withheld = 0;
  const industryLabel = `${deal.industry || "unknown"}${(deal as any).subIndustry ? ` — ${(deal as any).subIndustry}` : ""}`;
  const brands = labelBrands(industryLabel);
  const free = (label: string, raw: string, max: number): string => {
    if (!raw.trim()) return "";
    const clean = blindFreeText(clip(raw, max * 2), terms, { brands });
    if (!clean) { withheld++; return ""; }
    return `${label}${clip(clean, max)}`;
  };
  const locText = [txt(info.locationSite), txt(info.location), txt(info.leaseAddress)].join(" ");
  const m = REGION_RE.exec(locText);
  const region = m ? PROVINCES[m[1]] ?? m[1] : null;
  const country = region && Object.values(PROVINCES).includes(region) ? "Canada" : region ? "United States" : null;
  const industry = free("", industryLabel, 240) || `${deal.industry && !briefLeaks(deal.industry, terms).length ? deal.industry : "unknown"}`;
  const lines = [
    `Industry: ${industry}`,
    free("Business type: ", txt(info.businessType), 200),
    region ? `Region: ${region}${country ? `, ${country}` : ""}` : "",
    band(txt(info.annualRevenue)) ? `Revenue: ${band(txt(info.annualRevenue))}` : "",
    band(txt(info.sde)) ? `SDE: ${band(txt(info.sde))}` : "",
    band(txt(info.ebitda)) ? `EBITDA: ${band(txt(info.ebitda))}` : "",
    txt(info.employees) ? `Employees: ${txt(info.employees).replace(/[^0-9–-]+/g, " ").trim().split(" ")[0] || "n/a"}` : "",
    free("Services / revenue streams: ", txt(info.revenueStreams), 300),
    free("SELLER'S BUYER PREFERENCES (binding): ", txt(info.idealBuyer), 400),
  ];
  const brief = lines.filter(Boolean).join("\n");
  // The fixed labels ("SELLER'S BUYER PREFERENCES") are ours; check what follows them.
  // The Region line is built from the fixed province/state list, never from
  // free text, so it is not re-checked (a surname like "Washington" would
  // otherwise read "Region: Washington" as the person).
  const values = lines.filter((l) => l && !l.startsWith("Region: ")).map((l) => l.slice(l.indexOf(": ") + 2)).join("\n");
  if (briefLeaks(values, terms).length) throw new BlindBriefError("research brief still names the business");
  return { brief, region, withheld };
}

const REPORT_TOOL = {
  name: "report_acquirers",
  description: "Structured list of likely acquirers found in the research.",
  input_schema: {
    type: "object",
    properties: {
      acquirers: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            type: { type: "string", enum: ["strategic", "private_equity", "family_office", "search_fund", "other"] },
            headquarters: { type: ["string", "null"] },
            website: { type: ["string", "null"] },
            whyInterested: { type: "string", description: "1-2 sentences: the specific evidence they'd want this business (e.g. acquired X similar businesses in the region in 2025; platform in this sector)." },
            evidence: { type: "array", items: { type: "string" }, description: "Up to 3 concrete facts, e.g. 'Acquired MCA Dental Group (27 clinics, ON/QC), Oct 2025'." },
            contact: { type: ["string", "null"], description: "ONLY an email/phone/contact page that appears in the research text. Otherwise null. Never guess." },
            sourceRefs: { type: "array", items: { type: "integer" }, description: "Numbers of the SOURCES entries (from the numbered list) that support this entry. Cite every source that mentions the organisation." },
            sources: { type: "array", items: { type: "string" }, description: "Any other URLs from the research text that support this entry." },
          },
          required: ["name", "type", "whyInterested", "evidence", "sourceRefs"],
        },
      },
      note: { type: ["string", "null"], description: "When few or no organisations fit (e.g. the seller's preferences point to individual buyers who aren't publicly visible), 1-2 sentences saying why. Otherwise null." },
      channels: {
        type: "array",
        description: "Up to 5 practical ways to reach the kind of buyer the seller prefers when they aren't findable as organisations (e.g. dental-practice lenders' acquisition teams, professional associations, alumni networks, specialist accountants). NEVER other business brokers, brokerages or M&A advisors.",
        items: { type: "object", properties: { name: { type: "string" }, how: { type: "string" }, url: { type: ["string", "null"] } }, required: ["name", "how"] },
      },
    },
    required: ["acquirers"],
  },
};

export function isExternalSearchRunning(dealId: string) {
  return running.has(dealId);
}

export async function startExternalAcquirerSearch(dealId: string, opts: { includeExcluded?: boolean } = {}): Promise<{ started: boolean; reason?: string }> {
  if (running.has(dealId)) return { started: false, reason: "already_running" };
  const deal = await storage.getDeal(dealId);
  if (!deal) return { started: false, reason: "not_found" };
  if (!process.env.ANTHROPIC_API_KEY) return { started: false, reason: "no_ai" };
  running.add(dealId);
  const state: ExternalAcquirerSearch = { status: "running", startedAt: new Date().toISOString(), results: ((deal.externalAcquirers as ExternalAcquirerSearch | null)?.results) || [] };
  await storage.updateDeal(dealId, { externalAcquirers: state } as any);
  void research(deal, !!opts.includeExcluded)
    .then(async ({ results, mode, note, channels, droppedCount }) => {
      await storage.updateDeal(dealId, { externalAcquirers: { status: "done", startedAt: state.startedAt, finishedAt: new Date().toISOString(), mode, results, note, channels, droppedCount, includeExcluded: !!opts.includeExcluded } } as any);
    })
    .catch(async (err) => {
      const blind = err instanceof BlindBriefError;
      console.error("[external-acquirers] failed:", blind ? "research brief could not be made blind — not sent" : err);
      await storage.updateDeal(dealId, {
        externalAcquirers: {
          ...state,
          status: "failed",
          finishedAt: new Date().toISOString(),
          error: blind
            ? "The research was stopped because the business profile still named the business or its people. Nothing was searched."
            : "The research didn't finish — try again in a minute.",
        },
      } as any);
    })
    .finally(() => running.delete(dealId));
  return { started: true };
}

/**
 * A URL in comparable form: no scheme, no "www.", lower-case host, no query
 * string, fragment or trailing slash. "https://www.mullen-group.com/" and
 * "http://mullen-group.com" are the same page.
 */
export function normaliseUrl(u: string): string {
  const s = String(u || "").trim();
  if (!s) return "";
  const noScheme = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const [hostPart, ...rest] = noScheme.split("/");
  const host = hostPart.toLowerCase().replace(/^www\./, "").replace(/:\d+$/, "").replace(/\.$/, "");
  const path = rest.join("/").split(/[?#]/)[0].replace(/\/+$/, "");
  return path ? `${host}/${path}` : host;
}

/** True when `u` is one of the known URLs, or a page/home page on the same site as one. */
export function urlMatches(u: string, known: string[]): boolean {
  const n = normaliseUrl(u);
  if (!n) return false;
  return known.some((k) => {
    const nk = normaliseUrl(k);
    return !!nk && (nk === n || nk.startsWith(`${n}/`) || n.startsWith(`${nk}/`));
  });
}

/** Shorten at a sentence (or word) boundary — never mid-word. */
export function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sentence = cut.lastIndexOf(". ");
  if (sentence >= max * 0.5) return cut.slice(0, sentence + 1);
  const word = cut.lastIndexOf(" ");
  return `${cut.slice(0, word > 0 ? word : max).replace(/[,;:\s]+$/, "")}…`;
}

export interface StructuredAcquirerInput {
  acquirers?: any[];
  note?: string | null;
  channels?: any[];
}

/**
 * The structured list, checked against what the research actually returned.
 *  - Sources are the numbered SOURCES the model cited (by index) plus any URL
 *    it wrote that matches a URL the search returned (normalised).
 *  - In web mode an organisation with no matching source is kept only when
 *    the research text itself names it — marked unverified, so the broker
 *    knows to check it; anything else is dropped and counted.
 *  - A contact is kept only when it appears verbatim in cited text.
 *  - Free text is kept blind (no names from the deal's facts).
 */
export function buildAcquirerList(
  input: StructuredAcquirerInput,
  ctx: {
    mode: "web" | "knowledge";
    sourceList: string[];
    researchText: string;
    citedText: string;
    theirs?: Set<string>;
    terms?: BlindTerm[];
  },
): { results: ExternalAcquirer[]; note: string | null; channels: Array<{ name: string; how: string; url?: string | null }>; droppedCount: number } {
  const { mode, sourceList } = ctx;
  const theirs = ctx.theirs ?? new Set<string>();
  const terms = ctx.terms ?? [];
  const cited = ctx.citedText.toLowerCase();
  const research = ctx.researchText.toLowerCase();
  const urlOk = (u: string) => mode === "knowledge" || urlMatches(u, sourceList);
  const clean = (s: string) => (terms.length ? blindFreeText(s, terms, { prose: false }) ?? "" : s);

  const raw = Array.isArray(input.acquirers) ? input.acquirers : [];
  // The note speaks about the seller's preferences, so it is kept blind too.
  // Entries describe OTHER companies and are left as researched: scrubbing
  // them against this deal's terms rewrote real facts (a shared city name).
  const noteRaw = input.note ? clip(String(input.note), 900) : null;
  const note = noteRaw ? clean(noteRaw) || null : null;
  const channels = (Array.isArray(input.channels) ? input.channels : [])
    .filter((c) => c?.name && c?.how && !/\bbroker|brokerage|m&a advis/i.test(`${c.name} ${c.how}`))
    .slice(0, 5)
    .map((c) => ({ name: String(c.name).slice(0, 120), how: clip(String(c.how), 300), url: c.url && urlOk(String(c.url)) ? String(c.url) : null }))
    .filter((c) => c.how);

  const verified: ExternalAcquirer[] = [];
  const unverified: ExternalAcquirer[] = [];
  let droppedCount = 0;
  for (const a of raw) {
    if (!a?.name || !a?.whyInterested) { droppedCount++; continue; }
    const name = String(a.name).trim();
    const byRef = (Array.isArray(a.sourceRefs) ? a.sourceRefs : [])
      .map((n: unknown) => sourceList[Number(n) - 1])
      .filter((u: string | undefined): u is string => !!u);
    const byUrl = (Array.isArray(a.sources) ? a.sources : []).map(String).filter(urlOk);
    const sources = Array.from(new Set([...byRef, ...byUrl])).slice(0, 4);
    let isVerified = true;
    if (mode === "web" && sources.length === 0) {
      // Named in the research but not tied to a source: keep it, flagged.
      const inResearch = name.length >= 3 && research.includes(name.toLowerCase());
      if (!inResearch) { droppedCount++; continue; }
      isVerified = false;
    }
    let contact: string | null = a.contact ? String(a.contact).trim() : null;
    if (contact && (mode === "knowledge" || !cited.includes(contact.toLowerCase()))) contact = null;
    const website = a.website ? String(a.website) : null;
    const domain = website ? normaliseUrl(website).split("/")[0] : "";
    const entry: ExternalAcquirer = {
      name: name.slice(0, 120),
      type: ["strategic", "private_equity", "family_office", "search_fund", "other"].includes(a.type) ? a.type : "other",
      headquarters: a.headquarters ? String(a.headquarters).slice(0, 120) : null,
      website,
      whyInterested: clip(String(a.whyInterested), 500),
      evidence: (Array.isArray(a.evidence) ? a.evidence : []).map((e: unknown) => clip(String(e), 240)).filter(Boolean).slice(0, 3),
      contact,
      sources,
      inYourList: theirs.has(name.toLowerCase().replace(/[^a-z0-9]/g, "")) || (!!domain && theirs.has(domain)),
      ...(isVerified ? {} : { unverified: true }),
    };
    (isVerified ? verified : unverified).push(entry);
  }
  return { results: [...verified, ...unverified].slice(0, 15), note, channels, droppedCount };
}

async function research(deal: Deal, includeExcluded: boolean): Promise<{ results: ExternalAcquirer[]; mode: "web" | "knowledge"; note: string | null; channels: Array<{ name: string; how: string; url?: string | null }>; droppedCount: number }> {
  let { brief, region } = blindBrief(deal);
  const terms = briefTerms(deal);
  if (includeExcluded) brief = brief.replace("SELLER'S BUYER PREFERENCES (binding):", "Seller's stated preference (broker asked to include ALL buyer types anyway — list them, and flag any that conflict with it):");
  // The brief is blind by construction; logging it lets anyone audit what
  // left the platform (no names, no city — see blindBrief).
  console.log(`[external-acquirers] deal ${deal.id} brief:\n${brief}`);
  const system = [
    "You are an M&A research analyst building a buyer list for a business for sale. Find 8-15 organisations likely to acquire it, beyond individual buyers:",
    "(1) strategic acquirers/consolidators actively buying similar businesses — especially in this region; (2) private-equity firms with a platform in this sector (add-on) or a stated thesis for it; (3) family offices or holding companies known to buy in this space.",
    "Prioritise evidence of RECENT acquisitions (last ~3 years) of similar-sized businesses. Exclude business brokers, M&A advisors and marketplaces.",
    "Never suggest other business brokers, brokerages or M&A advisors as buyers or as channels.",
    "The seller's buyer preferences are BINDING (unless the profile says the broker asked to include all types): never list a type of buyer the seller has ruled out (e.g. if they don't want to sell to a DSO/corporate consolidator/PE, list none of those). Instead look for the kinds of buyers they prefer — e.g. independent multi-location owner-operators or regional groups known to be adding locations — and say how each fits the preference.",
    "Never search for or mention the specific business — you only know its profile. For contacts, only report an email/phone/contact page you actually saw on the organisation's site or a cited page; otherwise leave it out.",
    "Finish with a concise write-up per organisation: name, type, HQ, website, why they'd be interested with specific evidence, any published contact, and the source URLs.",
  ].join(" ");
  const messages: any[] = [{ role: "user", content: `Business profile (confidential — do not search for the business itself):\n${brief}\n\nResearch likely acquirers${region ? `, with priority on ${region}` : ""}.` }];

  const urls = new Set<string>();
  const citedText: string[] = [];
  let finalText = "";
  let mode: "web" | "knowledge" = "web";
  // Bounded research: ~8 searches, at most one continuation, 4 minutes overall.
  const deadline = Date.now() + 4 * 60_000;
  try {
    for (let turn = 0; turn < 2 && Date.now() < deadline; turn++) {
      const r: any = await anthropic.messages.create({
        model: agentConfig.models.supportingAgents,
        max_tokens: 5000,
        system,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 } as any],
        messages,
      } as any, { timeout: Math.max(30_000, deadline - Date.now()) });
      for (const b of r.content as any[]) {
        if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
          for (const item of b.content) if (item?.url) urls.add(String(item.url));
        }
        if (b.type === "text") {
          finalText += b.text;
          for (const c of b.citations || []) {
            if (c?.url) urls.add(String(c.url));
            if (c?.cited_text) citedText.push(String(c.cited_text));
          }
        }
      }
      if (r.stop_reason !== "pause_turn") break;
      messages.push({ role: "assistant", content: r.content });
    }
  } catch (err: any) {
    // Timed out with research in hand → structure what we have; otherwise web
    // search is unavailable (not enabled for the key, outage) — say so.
    console.warn("[external-acquirers] research stopped:", err?.message);
    if (!finalText.trim()) mode = "knowledge";
  }

  // The URLs live in the search results, not in the prose — hand the
  // structuring pass a numbered list so it can cite by number.
  const sourceList = Array.from(urls).slice(0, 120);
  const sourcesBlock = sourceList.map((u, i) => `[${i + 1}] ${u}`).join("\n");
  const prefLine = brief.split("\n").find((l) => l.startsWith("SELLER'S BUYER PREFERENCES")) ?? "";
  const structure = async (extra = "") => anthropic.messages.create({
    model: agentConfig.models.supportingAgents,
    max_tokens: 4000,
    temperature: 0,
    tools: [REPORT_TOOL as any],
    tool_choice: { type: "tool", name: "report_acquirers" },
    system: mode === "web"
      ? `Turn the research into the structured list. Use only organisations, facts, URLs and contacts that appear in the research. Do not add anything. For each organisation, cite the numbered SOURCES that mention or support it in sourceRefs (a search result about the organisation or its acquisitions counts). Drop any organisation that conflicts with the seller's buyer preferences.${prefLine ? `\n\n${prefLine}` : ""}${extra}`
      : "List likely acquirers for this business profile from your own knowledge. Mark nothing as a contact. Sources may be the organisations' home pages only. Be conservative — only well-known, real organisations active in this sector.",
    messages: [{
      role: "user",
      content: mode === "web"
        ? `RESEARCH:\n${finalText.slice(0, 30000)}\n\nSOURCES (cite by number):\n${sourcesBlock || "(none)"}`
        : `Business profile:\n${brief}`,
    }],
  });

  // Mark organisations the broker already has in their buyer list.
  const contacts = await storage.getBrokerBuyerContactList(deal.brokerId!).catch(() => []);
  const theirs = new Set<string>();
  for (const { buyerUser } of contacts) {
    if (buyerUser.company) theirs.add(buyerUser.company.toLowerCase().replace(/[^a-z0-9]/g, ""));
    const dom = buyerUser.email.split("@")[1];
    if (dom) theirs.add(dom.toLowerCase());
  }

  const toList = (resp: Awaited<ReturnType<typeof structure>>) => {
    const block = resp.content.find((b) => b.type === "tool_use");
    const input = (block && block.type === "tool_use" ? block.input : {}) as StructuredAcquirerInput;
    return buildAcquirerList(input, { mode, sourceList, researchText: finalText, citedText: citedText.join("\n"), theirs, terms });
  };
  let out = toList(await structure());
  // Research that describes acquirers but structured to nothing: one retry,
  // told plainly that organisations named in the research belong in the list.
  if (mode === "web" && out.results.length === 0 && finalText.trim().length > 400) {
    const retry = toList(await structure("\n\nThe research names organisations — list every one that fits, with the numbers of the sources that mention it. Do not return an empty list unless the research names none."));
    if (retry.results.length > 0) out = retry;
    else out.droppedCount = Math.max(out.droppedCount, retry.droppedCount);
  }
  if (out.droppedCount) console.log(`[external-acquirers] deal ${deal.id}: ${out.results.length} kept, ${out.droppedCount} left out (not backed by the research)`);
  return { ...out, mode };
}
