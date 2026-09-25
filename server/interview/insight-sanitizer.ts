/**
 * Keeps the "Learned Interview Patterns" generic.
 *
 * interview_insights is keyed by INDUSTRY only and read into every broker's
 * interviews in that industry, so anything it stores about one deal lands in
 * another deal's interview prompt — possibly another brokerage's. An item
 * like "Team longevity (Maria 9 years, Priya 7 years)" or "a 65%/35%
 * ownership split" is cross-deal seller detail the agent could repeat.
 *
 * An item is kept only when it reads as a de-identified pattern that would
 * apply to any seller in the industry. Deterministic and conservative — a
 * doubtful item is dropped, never rewritten:
 *   - no digits, currency or percent signs, and no spelled-out quantities;
 *   - no quotations (they quote a seller) and no parentheses (they carry the
 *     specifics: names, figures, examples);
 *   - no capitalised word except at the start of a sentence (a name, a
 *     place, a brand, a supplier) or a known generic acronym (CIM, SDE…);
 *   - a sentence may only start with a generic word (an "-ing" technique, a
 *     role like "Sellers", a topic like "Lease"…) — a name can't open one;
 *   - no one seller's personal life (relatives, illness, legal trouble), and
 *     no retelling of one interview ("the seller admitted…") — patterns are
 *     about sellers in general, in the present tense;
 *   - nothing the boundaries forbid (tax / legal / valuation advice);
 *   - none of the source deal's own names or terms (write time only);
 *   - nothing that recommends recapping or praising the seller's answers —
 *     the conversation rules forbid it, and a learned "pattern" must never
 *     argue the agent back into it.
 *
 * Used when an insight is written (learning-loop upsert, which also re-checks
 * the stored items it merges with) AND when it is read into a prompt (so
 * rows written before this rule never reach an interview as they are).
 */

const ACRONYMS = new Set([
  "CIM", "SDE", "EBITDA", "NDA", "LOI", "HVAC", "CRA", "IRS", "HST", "GST", "PST", "QST", "WSIB", "OSHA",
  "KPI", "KPIS", "CRM", "POS", "ERP", "HR", "IT", "AR", "AP", "P&L", "PNL", "B2B", "B2C", "SAAS", "SKU", "SKUS",
  "FTE", "FTES", "ROI", "YOY", "COGS", "EHS", "ISO", "GAAP", "IFRS", "OK", "M&A", "Q&A", "FAQ", "DD",
]);

// Generic words a pattern sentence may start with (lower case). Anything else
// capitalised at a sentence start is treated as a possible name.
const STARTERS = new Set(`
a an the this that these those their its his her our your my some most many few several both each every all any no not none
when if once after before while during until unless whereas although though because since as so then also even only instead rather
and but or yet still just again early later first next last final finally initially throughout overall generally typically usually
often sometimes rarely frequently consistently gradually gently quickly briefly clearly naturally directly openly specifically
how what why where which who whether
seller sellers owner owners founder founders operator operators proprietor proprietors buyer buyers broker brokers interviewer interviewers
agent questions question topics topic answers answer responses response replies reply conversations conversation interviews interview sessions session
financial financials finances revenue revenues sales margin margins profit profits profitability cash costs cost expenses pricing price prices
customer customers client clients patient patients guest guests member members tenant tenants account accounts
employee employees staff team teams manager managers management leadership workforce labour labor crew crews technicians trades
lease leases landlord real property premises facility facilities location locations site sites equipment inventory assets asset
supplier suppliers vendor vendors franchise franchises licence licences license licenses licensing permits permit compliance regulatory regulation regulations insurance
growth expansion competition competitors competitive market markets marketing brand reputation seasonality contracts contract recurring
operations operational processes process systems system technology software documents document documentation records paperwork data numbers figures details specifics
history story stories background origin succession transition training handover retirement timing time timeline timelines deadlines schedule
trust rapport engagement openness confidence momentum pace tone framing context purpose confidentiality privacy
family spouse spouses partner partners partnership health personal emotional sensitive
direct open short long brief concrete gentle clear plain simple broad narrow specific structured unstructured closed vague detailed terse
passive hands-on first-time experienced serial sophisticated guarded reluctant anxious busy tired frustrated defensive
follow-up follow-ups probing deflection deflections defensiveness resistance reluctance hesitation uncertainty frustration fatigue irritation pushback confusion
key critical important useful helpful effective ineffective strong weak
avoid ask start begin lead open frame let explain keep move give use offer confirm probe follow return circle defer check skip
do don't never always try consider prefer expect be get make show tell treat save hold break split limit cap
most less more fewer better best worse worst
industry sector business businesses company companies practice practices clinic clinics shop shops store stores restaurant restaurants
product products service services menu programs program
`.split(/\s+/).filter(Boolean));

// Generic-noun endings (names rarely end this way).
const GENERIC_SUFFIX_RE = /(ing|tion|tions|sion|sions|ment|ments|ness|ity|ities|ship|ships|ics|ism|isms|ology)$/;

const NUMBER_WORD_RE =
  /\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|hundreds|thousand|thousands|million|millions|billion|dozen|dozens|percent|per cent)\b/i;

// Items that recommend what the conversation rules forbid (recap / praise).
const TONE_CONFLICT_RE =
  /\b(validat\w*|prais\w*|compliment\w*|mirror\w*|reflect\w*\s+back|recap\w*|affirm\w*|reinforc\w*|summari[sz]\w*\s+(what|the seller|their|his|her|back)|repeat\w*\s+back|echo\w*)\b/i;

// One seller's personal life (relatives, illness, legal trouble) — a generic
// pattern never needs it ("family involvement" and "health" stay allowed).
const PERSONAL_DETAIL_RE =
  /\b(wife|wives|husband|brother|sister|son|sons|daughter|daughters|mother|father|mom|dad|in-laws?|\w+-in-law|nephew|niece|cousin|uncle|aunt|grand(son|daughter|child|children|kids|mother|father|parents?)|kids|children|divorc\w*|died|death|passed away|funeral|cancer|tumou?r|stroke|heart (attack|episode|condition|surgery)|diagnos\w*|surgery|hospital\w*|pregnan\w*|affair|lawsuit|sued|arrest\w*|addict\w*|rehab|bankrupt\w*)\b/i;

// A retelling of one interview ("the seller admitted…", "this interview
// ended…") rather than a pattern: it carries that deal's story. Patterns are
// written in the present tense about sellers in general.
const REPORTAGE_RE =
  /\b(this seller|this owner|the interviewer|this interview|the transcript|this transcript|this session|the session)\b|\b(seller|owner|interviewer|they|he|she)\s+(\w+ly\s+)?(said|admitted|volunteered|mentioned|refused|requested|stated|deflected|explained|provided|gave|became|showed|opened|expanded|engaged|terminated|responded|answered|asked|ended|failed|seemed|appeared|shut|raised|cited|described|praised|preferred|struggled|offered|pushed|redirected|hit|had|was|were|did|got|went|told|wanted|needed|confirmed|declined)\b/i;

// Advice the boundaries forbid (tax, legal, valuation opinions) is never a
// pattern to repeat.
const BOUNDARY_CONFLICT_RE = /\b(providing|giving|offering|answering)\b.{0,40}\b(tax|legal|valuation|price opinion)\b/i;

const MAX_ITEM_LENGTH = 220;

export interface InsightSanitizeOptions {
  /** Names and terms of the deal the insight came from (write time). */
  forbiddenTerms?: string[];
  /** Maximum length of a kept item (topic keys are short). */
  maxLength?: number;
}

/** A word position is a sentence start: the item start, or after . ! ? : ; — – - */
function sentenceStarts(text: string): Set<number> {
  const starts = new Set<number>();
  const re = /(^|[.!?:;—–]\s+|\s-\s+)(?=\S)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    starts.add(m.index + m[0].length);
    if (m[0].length === 0) re.lastIndex++;
  }
  return starts;
}

function isGenericStarter(word: string): boolean {
  const lower = word.toLowerCase().replace(/['’]s$/, "");
  if (STARTERS.has(lower)) return true;
  if (lower.includes("-")) return lower.split("-").every((p) => !p || STARTERS.has(p) || GENERIC_SUFFIX_RE.test(p));
  if (lower.includes("_")) return word === lower; // a snake_case topic key, all lower case
  return lower.length >= 5 && GENERIC_SUFFIX_RE.test(lower);
}

/**
 * The item as a generic pattern, or null when it could carry a specific
 * deal's detail. Never rewrites an item's meaning (only trims whitespace).
 */
export function sanitizeInsightItem(raw: unknown, opts: InsightSanitizeOptions = {}): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.replace(/\s+/g, " ").trim();
  if (text.length < 3 || text.length > (opts.maxLength ?? MAX_ITEM_LENGTH)) return null;
  if (/\d/.test(text)) return null;
  if (/[$€£¥%#@]/.test(text)) return null;
  if (/["“”„«»]/.test(text)) return null;
  // An opening single quote ('we're like family', 'I don't know…') — an
  // apostrophe inside a word ("don't", "seller's") is fine.
  if (/(^|[\s(\[—–-])['‘][A-Za-zÀ-ÿ]/.test(text)) return null;
  if (/[()[\]{}]/.test(text)) return null;
  if (NUMBER_WORD_RE.test(text)) return null;
  if (TONE_CONFLICT_RE.test(text)) return null;
  if (PERSONAL_DETAIL_RE.test(text)) return null;
  if (REPORTAGE_RE.test(text)) return null;
  if (BOUNDARY_CONFLICT_RE.test(text)) return null;

  const starts = sentenceStarts(text);
  const wordRe = /[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ'’&_-]*/g;
  let m: RegExpExecArray | null;
  while ((m = wordRe.exec(text)) !== null) {
    const word = m[0].replace(/['’-]+$/, "");
    if (!/[A-ZÀ-ÖØ-Þ]/.test(word)) continue; // all lower case
    if (word === "I") continue;
    // "CIM's", "SDEs" → the acronym itself
    const letters = word.replace(/['’]s$/, "").replace(/[^A-Za-zÀ-ÖØ-öø-ÿ&]/g, "").replace(/(?<=[A-Z]{2})s$/, "");
    if (letters.length >= 2 && letters === letters.toUpperCase()) {
      if (ACRONYMS.has(letters.toUpperCase()) || ACRONYMS.has(word.toUpperCase())) continue;
      return null; // an unknown acronym may be a business's initials
    }
    if (!starts.has(m.index)) return null; // a capitalised word mid-sentence: a name, a place, a brand
    if (!isGenericStarter(word)) return null;
  }

  if (opts.forbiddenTerms && opts.forbiddenTerms.length > 0) {
    const lower = ` ${text.toLowerCase()} `;
    for (const term of opts.forbiddenTerms) {
      const t = term.toLowerCase().trim();
      if (t.length < 3) continue;
      const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`(^|[^a-z0-9à-ÿ])${escaped}($|[^a-z0-9à-ÿ])`, "i").test(lower)) return null;
    }
  }
  return text;
}

/** Sanitises a list: drops unsafe items and duplicates, keeps order, caps the length. */
export function sanitizeInsightList(list: unknown, opts: InsightSanitizeOptions = {}, cap = 10): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const clean = sanitizeInsightItem(item, opts);
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= cap) break;
  }
  return out;
}

/** Topic keys ("company_story", "Lease terms") — short, generic, no specifics. */
export function sanitizeTopicOrder(list: unknown, opts: InsightSanitizeOptions = {}): string[] {
  return sanitizeInsightList(list, { ...opts, maxLength: 60 }, 12);
}

const isMapLike = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * The source deal's own names and terms, for the write-time check: its
 * business name, codename, location, and every capitalised word in its facts
 * and in the transcript that never appears in lower case there (a proper
 * noun — "Maria", "Harbourline", "Kitchener" — rather than "The" or "Our").
 */
export function dealSpecificTerms(input: {
  businessName?: string | null;
  blindCodename?: string | null;
  location?: string | null;
  extractedInfo?: unknown;
  transcript?: string;
}): string[] {
  const texts: string[] = [];
  // Values of fields that hold names (people, places, firms): every
  // capitalised word counts there, even at the start ("Maria (office manager)").
  const nameValues: string[] = [];
  const NAME_FIELD_RE = /name|owner|employee|manager|staff|team|contact|accountant|lawyer|landlord|supplier|vendor|customer|client|partner|dentist|associate|hygienist|location|address|city|street|brand|franchis/i;
  const collect = (v: unknown, depth = 0, key = "") => {
    if (depth > 4 || v === null || v === undefined) return;
    if (typeof v === "string") {
      texts.push(v);
      if (NAME_FIELD_RE.test(key)) nameValues.push(v);
    } else if (Array.isArray(v)) v.forEach((x) => collect(x, depth + 1, key));
    else if (isMapLike(v)) for (const [k, x] of Object.entries(v)) if (!k.startsWith("_")) collect(x, depth + 1, k);
  };
  collect(input.businessName);
  collect(input.blindCodename);
  collect(input.location);
  collect(input.extractedInfo);
  if (input.transcript) texts.push(input.transcript);

  const all = texts.join("\n");
  const lowerWords = new Set((all.match(/\b[a-zà-ÿ][a-zà-ÿ'’-]*\b/g) ?? []).map((w) => w.toLowerCase()));
  const terms = new Set<string>();
  // A capitalised word counts only where capitals mean a name: mid-sentence
  // ("… run by Maria", "… in Kitchener"). At a sentence or value start it may
  // be any word ("Initial…", "Located…"), so it doesn't count there.
  const capRe = /\b[A-ZÀ-Þ][A-Za-zÀ-ÿ'’-]{2,}\b/g;
  let m: RegExpExecArray | null;
  while ((m = capRe.exec(all)) !== null) {
    const before = all.slice(Math.max(0, m.index - 6), m.index);
    const atStart = m.index === 0 || /(?:^|[.!?:;\n•—–-])\s*["'(]*$/.test(before) && !/\b(?:Dr|Mr|Mrs|Ms|St|Jr|Sr)\.\s*$/.test(before);
    if (atStart) continue;
    const lower = m[0].toLowerCase().replace(/['’]s$/, "");
    if (lowerWords.has(lower) || STARTERS.has(lower) || ACRONYMS.has(m[0].toUpperCase())) continue;
    terms.add(lower);
  }
  for (const w of nameValues.join("\n").match(capRe) ?? []) {
    const lower = w.toLowerCase().replace(/['’]s$/, "");
    if (lowerWords.has(lower) || STARTERS.has(lower) || ACRONYMS.has(w.toUpperCase())) continue;
    terms.add(lower);
  }
  // The deal's own names, whole and word by word.
  for (const name of [input.businessName, input.blindCodename, input.location]) {
    if (typeof name !== "string" || name.trim().length < 3) continue;
    terms.add(name.trim().toLowerCase());
    for (const w of name.split(/[^A-Za-zÀ-ÿ'’-]+/)) {
      const lower = w.toLowerCase();
      if (lower.length >= 3 && !STARTERS.has(lower) && !lowerWords.has(lower)) terms.add(lower);
    }
  }
  return Array.from(terms);
}
