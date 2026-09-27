/**
 * money-talk — earnings, SDE and add-backs in the seller conversation.
 *
 * Two live misses from the round-A acceptance test (Lakeshore, 8 turns):
 *
 *  1. THE AGENT BUILT THE ADD-BACK LIST ITSELF. Asked "what add-backs is
 *     Morgan using?", it answered "…making sure we've captured the items
 *     that typically get considered. From what's on file: your $240K
 *     management salary, Maria's $85K, the $38K in vehicle loan interest,
 *     and the $214K in amortization." — no add-back vocabulary, so the
 *     treatment-call guard (reply-guards.ts) saw a list of figures. And when
 *     the seller listed their own ("that comes out… should absolutely be an
 *     add-back… Are you guys not working off the same sheet?") it agreed:
 *     "You're right — those items are in the documents Denise sent… I'll
 *     make sure the owner vehicles ($28K), health and life insurance ($9K),
 *     discretionary meals ($11K), and…". Which items are added back is the
 *     broker's call, made against the statements; a list the interviewer
 *     puts together, or agrees to, is that call made in front of the seller.
 *     `candidateListStatements` finds those sentences (reply-guards removes
 *     them with the other add-back calls).
 *
 *  2. THE AGENT DODGED THE SELLER'S EARNINGS QUESTION. "The business clears
 *     about a million and a half when you add everything back — is that the
 *     number going in the book?" was asked four times ("you keep dodging my
 *     question") and answered with a question about Sal's tenure, "Let me ask
 *     about something else", and a request for a licence breakdown. The rule
 *     is to hand it off, never to ignore it: acknowledge, say the broker will
 *     walk them through the earnings figure, and — when the seller-visible
 *     statements show something different — note neutrally what they show,
 *     with no add-back treatment. `earningsNudge` tells the model this before
 *     it drafts; `ensureEarningsAcknowledged` (run by reply-polish on every
 *     reply the seller reads, so the streamed text and the saved text agree)
 *     puts the hand-off in when the draft still doesn't carry one.
 *
 * Pure, deterministic, no model calls.
 */

// ═══════════════════════ Reading the seller ═══════════════════════
//
// Every trigger below puts a sentence in front of the seller or pays for a
// corrective rewrite, so each is read in context, never off a bare word: "I've
// told you multiple times", "we have multiple locations", "the cash flow
// statement", "what's the number you have for our patients", "Maria takes
// home about $85K", "we clear $60K in scrap metal sales", "that's personal,
// I'd rather not say" and "it comes out to 40 hours a week" are not earnings
// talk (round-A review; each had reached the seller through polishMessage).

/** A valuation multiple, as a noun ("what multiple is she using", "4x SDE") — not "multiple times / locations". */
const MULTIPLE_NOUN = String.raw`(?:(?:what|which|the|a|an|your|my|our|his|her|their|that|this|same|[a-z]+'s)\s+(?:(?:kind|sort|type) of\s+)?(?:(?:valuation|earnings|sde|ebitda|typical|usual|fair|good|decent|market|going|industry|standard|realistic|higher|lower|same)\s+)*multiples?(?![\w-])(?!\s+(?:times|locations?|sites?|stores?|shops?|clinics?|branches|offices?|trucks?|vans?|vehicles?|customers?|clients?|patients?|people|staff|employees|techs?|units?|offers?|buyers?|years?|reasons?|ways?|sources?|contracts?|jobs?|projects?|suppliers?|vendors?|properties|buildings?|leases?|accounts?|products?|services?|lines?|owners?|shareholders?|partners?|kids|children|things|items|occasions|visits|calls|emails|documents|files|copies|versions|departments?|divisions?|brands?|streams?|revenue)\b)|multiples? (?:of|on) (?:the )?(?:earnings|sde|ebitda|cash ?flow|profit|business)|\d+(?:\.\d+)?\s?(?:x|times) (?:earnings|sde|ebitda|cash ?flow|profit))`;
/** Cash flow as earnings — not the statement, report or schedule. */
const CASH_FLOW = String.raw`cash[- ]?flows?(?!\s+(?:statements?|reports?|sheets?|spreadsheets?|schedules?|files?|documents?|forecasts?|projections?|budgets?|templates?)\b)`;
/**
 * Normalising earnings — not the working-capital peg ("we've pegged
 * normalized working capital at about $2.4M") or a rent structure ("that
 * normalizes the rent for a buyer's model").
 */
const NORMALISE = String.raw`normali[sz]\w*\b(?!\s+(?:the\s+|our\s+|net\s+)?(?:working capital|nwc|peg|inventory|capex|capital expenditures?|rent|lease|occupancy)\b)`;
/** "The bottom line" as earnings — not "the bottom line is, I want out". */
const BOTTOM_LINE = String.raw`bottom[- ]line(?!\s*(?:is|was|here)?\s*[,:—–-])`;
/** Earnings / normalisation vocabulary. */
const EARNINGS_TERM_RE = new RegExp(
  String.raw`\b(?:sde|seller'?s discretionary|discretionary (?:earnings|cash ?flow)|add[- ]?backs?|added[- ]back|adding (?:it |that |them |this |those |everything |it all |all (?:of )?that )?back|add (?:it|that|them|this|those|everything|it all|all (?:of )?that|all of it) back|${NORMALISE}|recast|${CASH_FLOW}|ebitda|earnings|${BOTTOM_LINE}|${MULTIPLE_NOUN})\b`,
  "i",
);
/** "The number going in the book", "what figure is she using" — never "the number of techs". */
const BOOK_NUMBER_RE =
  /\b(?:the|that|this|what|which|your|her|his|their|morgan'?s|the broker'?s)\s+(?:actual\s+|real\s+|final\s+)?(?:number|figure)\b(?!\s+(?:of|for|to|i|you|we)\b)[^.?!]{0,60}\b(?:book|cim|memorandum|listing|package|buyers?|going in|goes in|put(?:ting)? in|using|use|telling|came up with|come up with|working (?:with|from|off))\b|\bwhat(?:'s| is) the (?:actual |real |final )?(?:number|figure)\s*\?/i;
/** A question about the figure itself (not about one item's treatment). */
const FIGURE_TERM_RE = new RegExp(
  String.raw`\b(?:sde|seller'?s discretionary|discretionary (?:earnings|cash ?flow)|ebitda|${CASH_FLOW}|earnings|${BOTTOM_LINE}|recast|${MULTIPLE_NOUN})\b`,
  "i",
);
/**
 * A question about something else: clarifying what the interviewer asked
 * ("which number are we talking about here — you mean the EBITDA or
 * something specific on the P&L?", i-privacy-ux run 2), or offering a
 * document ("should I send you the EBITDA breakdown by division?").
 */
const CLARIFY_Q_RE =
  /\b(?:(?:do|did) you mean|you mean|are you asking|you'?re asking|(?:are|were) we talking about|we talking about|what do you mean|are you referring|you referring|which (?:one|number|figure) (?:do|did|are) you)\b/i;
const DOC_OFFER_Q_RE =
  /\b(?:(?:should|can|could|shall|want me to|need me to|i'?ll|i can|i could) (?:i )?(?:send|upload|share|give|attach|forward|provide|pull|email)|do you (?:need|want)(?: me to (?:send|upload|share|pull|forward))?)\b[^?]{0,60}\b(?:statements?|breakdown|reports?|schedules?|spreadsheets?|sheets?|files?|documents?|summary|worksheet|pdf|copy|copies)\b/i;

/**
 * Add-backs raised by the seller: the vocabulary, or an expense they say is
 * personal or comes out ("my RAM and Maria's Lexus lease, that's personal,
 * that comes out"). "That's personal, I'd rather not say", "it comes out to
 * about 40 hours a week" and "the sign comes out of the window" are not.
 */
const ADDBACK_EXPLICIT_RE = new RegExp(
  String.raw`\b(?:add[- ]?backs?|added[- ]back|add(?:s|ed|ing)? (?:it |that |them |this |those |all |everything |it all |all (?:of )?(?:it|that|this) )?back|sde|seller'?s discretionary|discretionary (?:earnings|cash ?flow)|${NORMALISE}|recast\w*)\b`,
  "i",
);
const ADDBACK_IMPLICIT_RE =
  /\b(?:that|it|this|those|these|which|they)(?:'s| is| are|'re| was| were)\s+(?:all\s+|just\s+|really\s+|purely\s+|totally\s+)?(?:personal|discretionary)\b(?!\s+(?:matter|question|thing|information|info|stuff|reasons?|choice|decision|preference|call|life|opinion|business|to me|for me)\b)|\b(?:comes?|came|should come|would come|gets? taken|should be taken|taken|take (?:it|that|them|those|this)|pull (?:it|that|them|those|this)|back (?:it|that|them|those|this)) out\b(?!\s+(?:to|at|with|in|on|for|of (?!(?:the |my |our )?(?:numbers|earnings|profit|p&l|books|expenses|financials|business)\b)))/i;
const EXPENSE_OR_MONEY_RE =
  /\$\s?\d|\b\d[\d,.]*\s?(?:k|grand|thousand|million)\b|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[- ]\w+)? (?:grand|thousand)\b|\b(?:salary|salaries|wages?|pay|interest|amorti[sz]ation|depreciation|vehicles?|trucks?|cars?|lease|insurance|premiums?|meals?|entertainment|travel|legal|fees|settlement|rent|bonus(?:es)?|perks?|dividends?|draws?|donations?|club|box|phone|expenses?|costs?)\b/i;

/**
 * The seller's side of a broker-led exchange ("Broker: …\nSeller: …", the
 * together mode's labelled transcript): a broker who says "your SDE is
 * about $1.2M" has not raised anything as the seller. Unlabelled text comes
 * back as is; with only "Speaker N" labels (nobody identified yet) every
 * line is kept.
 */
export function sellerSideOf(message: string | null | undefined): string | null {
  if (!message) return message ?? null;
  const LABEL = /^\s*(Broker|Seller|Speaker \d+)\s*:\s*/i;
  const lines = message.split("\n");
  if (!lines.some((l) => LABEL.test(l))) return message;
  const hasSeller = lines.some((l) => /^\s*Seller\s*:/i.test(l));
  const out: string[] = [];
  let keep = true;
  for (const l of lines) {
    const m = l.match(LABEL);
    if (m) {
      const who = m[1].toLowerCase();
      keep = hasSeller ? who === "seller" : who !== "broker";
      if (keep) out.push(l.slice(m[0].length));
    } else if (keep) out.push(l);
  }
  return out.join("\n");
}

/** Did the seller raise add-backs (the vocabulary, or an expense that is personal / comes out)? */
export function sellerRaisesAddbacks(sellerMessage: string | null | undefined): boolean {
  const text = sellerSideOf(sellerMessage);
  if (!text) return false;
  const t = text.replace(/[’‘]/g, "'");
  if (ADDBACK_EXPLICIT_RE.test(t)) return true;
  return sentencesOf(t).some((s) => ADDBACK_IMPLICIT_RE.test(s) && EXPENSE_OR_MONEY_RE.test(s));
}

/**
 * An earnings figure the owner states about the BUSINESS: "the business
 * clears about a million and a half", "we net around $600K", "I take home
 * 400 grand", "our SDE is about $1.2M". The cue must lead straight into the
 * figure ("$1.4M net of trade-ins", "gets cleared at closing" and "80% of
 * gross profit … $6.2 million in revenue" are not claims — seeding corpus);
 * a verb cue needs the business or the owner as its subject ("Maria takes
 * home about $85K" and "my shop foreman takes home $95K" are wages); and a
 * figure for one line or one period ("$60K in scrap metal sales", "$120K a
 * month") is not what the business earns.
 */
const CLAIM_FIGURE = String.raw`\$\s?\d[\d,.]*(?:\s?(?:k|m|mm|thousand|million|grand)\b)?|\d[\d,.]*\s?(?:k|m|mm|thousand|million|grand)\b|(?:a|one) million and a half|one and a half million|(?:a|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?(?: hundred)?(?: and a half)? (?:thousand|grand|million)`;
const CLAIM_VERB = String.raw`clears?|cleared|clearing|nets?(?! of)|netted|netting|throws? off|threw off|takes? home|took home|pockets?|pocketed`;
const CLAIM_NOUN = String.raw`(?<!gross )(?:sde|ebitda|cash ?flow|earnings|bottom line|take-home|(?:net )?profit)(?:'s|\s+(?:is|was|of|runs?(?: at)?|comes? (?:in )?(?:at|to)|came (?:in )?(?:at|to)|sits? at|would be|should be|around|about|at))?`;
const CLAIM_HEDGE = String.raw`(?:about|around|roughly|approximately|close to|nearly|almost|over|under|north of|just over|just under|call it|maybe|like|a solid|a good|probably|easily)`;
const CLAIM_RE = new RegExp(String.raw`\b(?:(${CLAIM_VERB})|${CLAIM_NOUN})\s+(?:me\s+|us\s+|the owner\s+)?(?:${CLAIM_HEDGE}\s+){0,2}(${CLAIM_FIGURE})`, "gi");
/** The words right before a verb cue name the business or the owner. */
const CLAIM_SUBJECT_RE =
  /(?:^|[\s,;:(])(?:i|we|it|(?:the|this|that|my|our|the whole) (?:business|company|shop|store|practice|clinic|firm|operation|place|pharmacy|restaurant|cafe|café|dealership|agency|franchise|plant|garage|thing|outfit))\s+(?:(?:usually|typically|normally|really|still|only|easily|basically|honestly|just|actually|consistently|always|probably|now|currently|comfortably|reliably|historically|roughly|generally)\s+){0,2}$/i;
/** Someone else's earnings in front of a noun cue ("Maria's take-home is $85K"). */
const OTHER_PERSON_BEFORE_RE = /(?:\b[A-Z][a-z]+'s|\b(?:his|her|their|your))\s+(?:\w+\s+)?$/;
/** A figure for one line or one period. */
const PARTIAL_FIGURE_AFTER_RE =
  /^\s+(?:a (?:month|week|day)|per (?:month|week|day)|monthly|weekly|in (?:(?:the|our|my)\s+)?(?:[a-z&-]+\s+){0,3}(?:sales|revenue|contracts?|jobs?|work|rentals?|fees|installs?|service|parts|commissions?|tips|billings?)\b|from (?:(?:the|our|my)\s+)?(?!(?:business|company)\b)(?:[a-z&-]+\s+){0,3}(?:contracts?|jobs?|work|rentals?|division|side|line|account|customer|client|location|store|shop|sales)\b|on (?:the|that|this|each|every|a|per) (?:[a-z&-]+\s+){0,2}(?:job|contract|unit|install|sale|deal|project|truck|van|call)\b)/i;

/** The largest earnings figure (≥ $50K) the text states about the business, or null. */
function earningsClaim(text: string): number | null {
  let claim: number | null = null;
  CLAIM_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CLAIM_RE.exec(text)) !== null) {
    const before = text.slice(0, m.index);
    const clause = before.split(/[.;!?\n]|,\s|\s[—–-]\s/).pop() ?? "";
    if (m[1] ? !CLAIM_SUBJECT_RE.test(clause) : OTHER_PERSON_BEFORE_RE.test(before.slice(-40))) continue;
    if (PARTIAL_FIGURE_AFTER_RE.test(text.slice(m.index + m[0].length))) continue;
    const amounts = moneyAmounts(m[2]).filter((n) => n >= 50_000);
    if (amounts.length > 0) claim = Math.max(claim ?? 0, ...amounts);
  }
  return claim;
}

const SPELLED: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, a: 1, half: 0.5,
};
const SCALE: Record<string, number> = { k: 1e3, grand: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6 };

/** The money amounts a text states ("$1.5M", "1,500,000", "a million and a half", "six hundred grand"). */
export function moneyAmounts(text: string): number[] {
  const out: number[] = [];
  const t = text.toLowerCase().replace(/[’‘]/g, "'");
  if (/\b(?:a|one) million and a half\b|\bone and a half million\b/.test(t)) out.push(1.5e6);
  const digit = /(\$\s?)?(?<![\d.,])(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(k|m|mm|thousand|million|grand)?(?![a-z\d])/g;
  let m: RegExpExecArray | null;
  while ((m = digit.exec(t)) !== null) {
    const n = parseFloat(m[2].replace(/,/g, ""));
    if (Number.isNaN(n)) continue;
    const scale = m[3] ? SCALE[m[3]] : 1;
    // A bare number is money only with a "$" (a year, a headcount…).
    if (!m[1] && !m[3]) continue;
    out.push(n * scale);
  }
  const spelled = /\b((?:a|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?)(?: (hundred))?(?: and a half)? (thousand|grand|million)\b/g;
  const words = t.replace(/\b(?:a|one) million and a half\b|\bone and a half million\b/g, " ");
  while ((m = spelled.exec(words)) !== null) {
    const parts = m[1].split(/[- ]/);
    let n = parts.reduce((s, p) => s + (SPELLED[p] ?? 0), 0);
    if (m[2]) n *= 100;
    if (/and a half/.test(m[0])) n += 0.5;
    out.push(n * SCALE[m[3]]);
  }
  return out;
}

const sentencesOf = (text: string): string[] =>
  text
    .replace(/[’‘]/g, "'")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

export interface EarningsTalk {
  /** The seller asked about the earnings figure, SDE or add-backs. */
  asked: boolean;
  /** …about the FIGURE (SDE, earnings, "the number in the book", a multiple), or stated one — not just how an item is treated. */
  aboutFigure: boolean;
  /** An earnings figure the seller stated ("clears about a million and a half"). */
  claim: number | null;
  /** The word the seller used for it, for the acknowledgement ("SDE", "add-backs"…). */
  term: string | null;
}

/**
 * What the seller said about earnings this turn: a question about the
 * figure / SDE / add-backs, and an earnings figure they stated. null when
 * the message is about something else.
 */
export function sellerEarningsTalk(sellerMessage: string | null | undefined): EarningsTalk | null {
  // (In a broker-led exchange, only what the seller said.)
  const own = sellerSideOf(sellerMessage);
  if (!own) return null;
  const text = own.replace(/[’‘]/g, "'");
  // Question sentences: the text up to each "?" since the last sentence end.
  // A tag ("…when you add it all back, you know what I mean?", "…, right?")
  // makes a statement, not a question (seeding corpus: "Denise adds all that
  // back when they're showing the real cash flow, you know what I mean?");
  // so does a question about the interviewer's question or a document offer.
  const TAG_RE = /,?\s*\b(?:you know what i mean|you know|right|correct|ok(?:ay)?|eh|yeah|no|isn'?t it|don'?t you think|agreed|see what i mean)\s*\?$/i;
  const questions = (text.match(/[^.!?\n]*\?/g) ?? []).filter((q) => !TAG_RE.test(q.trim()) && !CLARIFY_Q_RE.test(q) && !DOC_OFFER_Q_RE.test(q));
  const asked = questions.some((q) => EARNINGS_TERM_RE.test(q) || BOOK_NUMBER_RE.test(q));
  // What the business earns — not one item the seller counts as an add-back
  // ("my $240K salary is an add-back" is an item, not earnings).
  const claim = earningsClaim(text);
  if (!asked && claim === null) return null;
  const aboutFigure = claim !== null || questions.some((q) => FIGURE_TERM_RE.test(q) || BOOK_NUMBER_RE.test(q));
  const termMatch = (questions.join(" ") || text).match(/\b(sde|add[- ]?backs?|cash ?flow|ebitda|earnings)\b/i);
  const term = termMatch ? (/^sde$/i.test(termMatch[1]) ? "SDE" : /^ebitda$/i.test(termMatch[1]) ? "EBITDA" : termMatch[1].toLowerCase()) : null;
  return { asked, aboutFigure, claim, term };
}

/** "$1.5M", "$640K", "$1,250,000" → the short form a person would say back. */
export function formatMoney(n: number): string {
  if (n >= 1e6) {
    const m = n / 1e6;
    return `$${String(parseFloat(m.toFixed(m >= 10 ? 1 : 2)))}M`;
  }
  if (n >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${Math.round(n)}`;
}

// ═══════════════════════ What the statements show ═══════════════════════

/** An earnings line the seller-visible statements carry. */
export interface StatementEarnings {
  /** "net income" */
  label: string;
  amount: number;
  /** The figure as the file writes it ("$563,190"). */
  shown: string;
  /** "FY2024" / "2024", when the value names it. */
  period: string | null;
  /** "after tax" / "before tax", when the value says. */
  basis: string | null;
}

/**
 * Reported (never normalised) earnings keys, the measure nearest a seller's
 * "what it clears" first: reported EBITDA, then income before tax, then net
 * income. (Round A set after-tax net income — $563,190 — against a claim
 * that included add-backs; reported EBITDA, $917,000 on the same file, is
 * the statements' closest line. Neither is the seller's measure, which is
 * why the note says "as reported, before any adjustments".)
 */
const STATEMENT_EARNINGS_KEYS: Array<[RegExp, string]> = [
  [/^(?:ebitda|EBITDA|reportedEbitda|ebitdaReported)$/, "EBITDA"],
  [/^(?:netIncomeBeforeTax(?:es)?|incomeBeforeTax(?:es)?|pretaxIncome|preTaxIncome)$/, "income before tax"],
  [/^netIncome$/, "net income"],
  [/^netIncomeAfterTax(?:es)?$/, "net income"],
  [/^netProfit$/, "net profit"],
  [/^netEarnings$/, "net earnings"],
];
/** A value that is itself normalised ("adjusted EBITDA $1.1M", "$1,312,000 SDE"). */
const NORMALISED_VALUE_RE = /\b(?:adjusted|normali[sz]ed|recast|pro[- ]?forma|sde|add[- ]?backs?|seller'?s discretionary)\b/i;

/**
 * The seller-visible statements' reported earnings for the latest year on
 * file — from a DOCUMENT (never the seller's own words, never the broker's
 * work: `info` is the interview's view, so broker-only sources and held
 * values are already out). null when there is none.
 */
export function statementEarnings(
  info: Record<string, unknown>,
  sourceOf: (key: string) => string | undefined,
): StatementEarnings | null {
  const latest = latestFiscalYearOnFile(info);
  for (const [re, label] of STATEMENT_EARNINGS_KEYS) {
    const key = Object.keys(info).find((k) => re.test(k));
    if (!key) continue;
    if (sourceOf(key) !== "document") continue;
    const raw = info[key];
    if (typeof raw !== "string" && typeof raw !== "number") continue;
    // The headline clause ("$563,190 after tax (FY2024); FY2023 $482,930…").
    const head = String(raw).split(/;|\n/)[0];
    if (NORMALISED_VALUE_RE.test(head)) continue;
    const fig = head.match(/-?\$\s?\d[\d,]*(?:\.\d+)?\s?(?:[kKmM](?![a-z])|million|thousand)?/);
    if (!fig) continue;
    const amounts = moneyAmounts(fig[0]);
    if (amounts.length === 0) continue;
    const period = head.match(/\bFY\s?'?(?:20)?\d{2}\b|\b(?:19|20)\d{2}\b/i)?.[0].replace(/\s+/g, "") ?? null;
    // Only a figure named with the latest fiscal year on file: an undated
    // value can be an older year's (live: FY2022 pre-tax income was quoted
    // to the seller as what "the statements on file report").
    const year = periodYear(period);
    if (year === null || (latest !== null && year !== latest)) continue;
    const basis = /\bafter[- ]tax/i.test(head) ? "after tax" : /\bbefore[- ]tax|\bpre-?tax/i.test(head) ? "before tax" : null;
    return { label, amount: amounts[0], shown: fig[0].replace(/\s+/g, ""), period, basis };
  }
  return null;
}

/** "FY2024" / "FY24" / "2024" → 2024 (null when there is no year). */
function periodYear(period: string | null): number | null {
  if (!period) return null;
  const d = period.match(/(\d{2,4})$/)?.[1];
  if (!d) return null;
  const n = Number(d.length === 2 ? `20${d}` : d);
  return Number.isFinite(n) ? n : null;
}

/** The latest fiscal year any by-year figure on file covers (revenueByYear, ebitdaByYear…), or null. */
function latestFiscalYearOnFile(info: Record<string, unknown>): number | null {
  let latest: number | null = null;
  for (const [key, value] of Object.entries(info)) {
    if (key.startsWith("_") || !/ByYear$/.test(key) || !value || typeof value !== "object" || Array.isArray(value)) continue;
    for (const y of Object.keys(value as Record<string, unknown>)) {
      if (!/^(?:19|20)\d{2}$/.test(y)) continue;
      const n = Number(y);
      if (latest === null || n > latest) latest = n;
    }
  }
  return latest;
}

// ═══════════════════════ The hand-off ═══════════════════════

/** The broker, or a person named mid-sentence ("a question for Morgan"). */
const BROKER_RE = /\b(?:your broker|the broker|broker'?s)\b/i;
const NAME_RE = /(?<=\S\s+)(?!(?:The|This|That|These|Those|Your|For|On|In|If|And|But|So|It|I|We|You|They|He|She|What|When|How|Why|Is|Are|FY)\b)[A-Z][a-z]{2,}(?:'s)?\b/;
const HANDOFF_VERB_RE =
  /\b(?:walk(?:s|ing)? you through|go(?:es|ing)? (?:over|through)|take(?:s)? you through|confirm(?:s)?|finali[sz]e(?:s)?|decide(?:s)?|explain(?:s)?|discuss|review(?:s)?|work(?:s|ed|ing)? (?:it )?out|conversation (?:to have )?with|question for|(?:call|one) to make|to answer|sets?)\b|'s (?:call|decision)\b|\b(?:is|are) (?:up to|for) (?:your broker|the broker|them|her|him)\b/i;
const HANDED_OFF_TOPIC_RE = /\b(?:sde|earnings|cash ?flow|ebitda|add[- ]?backs?|added back|number|figure|normali[sz]\w*|recast|multiple)\b/i;

/** Does the reply hand the earnings question to the broker? */
export function handsOffEarnings(message: string): boolean {
  return sentencesOf(message).some((s) => !/\?\s*$/.test(s) && (BROKER_RE.test(s) || NAME_RE.test(s)) && HANDOFF_VERB_RE.test(s) && HANDED_OFF_TOPIC_RE.test(s));
}

/** The generic add-back hand-off — the same words as reply-guards.NORMALISATION_HANDOFF (a test holds them equal). */
export const GENERIC_ADDBACK_HANDOFF = "Your broker will confirm what gets added back when they normalize the numbers against your statements.";
const GENERIC_HANDOFF_RE = /\s*Your broker will confirm what gets added back when they normali[sz]e the numbers against your statements\.\s*/;

/**
 * The acknowledgement the seller gets when the reply didn't answer their
 * earnings question. Carries no add-back vocabulary and no normalised
 * figure (the add-back guard reads it as a hand-off, never as a call).
 */
export function earningsHandoffLine(talk: EarningsTalk, priorAiText = ""): string {
  // A question about how items are treated gets the add-back hand-off.
  if (!talk.aboutFigure) return GENERIC_ADDBACK_HANDOFF;
  const what = talk.claim !== null ? `the ${formatMoney(talk.claim)}` : talk.term === "SDE" ? "the SDE question" : talk.term && /add/.test(talk.term) ? "the add-backs" : "your earnings question";
  // Asked again, the seller hears it in other words, not the same sentence
  // word for word (a stuck record reads as a dodge too).
  const variants = [
    `On ${what}: the earnings figure that goes in the book is your broker's to walk you through, against your statements.`,
    "That figure is one your broker will go through with you directly, line by line against your statements.",
    "The number itself is your broker's to walk you through — it's worth putting to them directly.",
  ];
  const said = priorAiText.replace(/[’‘]/g, "'");
  const uses = variants.map((v) => said.split(v.replace(/^On [^:]+: /, "")).length - 1);
  return variants[uses.indexOf(Math.min(...uses))];
}

/** The neutral note of what the statements show ("For reference, …") — the reported line, named as such. */
export function statementNoteLine(s: StatementEarnings): string {
  return `For reference, the ${s.period ? `${s.period} ` : ""}statements on file report ${s.label} of ${s.shown}${s.basis ? ` ${s.basis}` : ""}, before any adjustments.`;
}

/** Is the statements' figure already in this text? */
function mentionsAmount(text: string, amount: number): boolean {
  return moneyAmounts(text).some((n) => Math.abs(n - amount) <= Math.max(1, amount * 0.01));
}

export interface EarningsAckContext {
  sellerMessage: string | null;
  /** What the interviewer has already said to the seller (all sessions). */
  priorAiText?: string;
  statements?: StatementEarnings | null;
}

/**
 * Puts the hand-off in a reply that doesn't answer the seller's earnings
 * question (or their first statement of an earnings figure), with the
 * statements' own figure beside it when it differs from what the seller
 * said and the seller hasn't been shown it yet. Placed first — it answers
 * what the seller just raised — in its own paragraph before the question.
 * Idempotent: a reply that already hands it off is returned unchanged.
 */
export function ensureEarningsAcknowledged(message: string, ctx: EarningsAckContext): { message: string; added: boolean } {
  const talk = sellerEarningsTalk(ctx.sellerMessage);
  if (!talk || !message.trim()) return { message, added: false };
  const prior = ctx.priorAiText ?? "";
  // A figure stated (not asked about) is acknowledged once: after that the
  // interview moves on, and the seller can always ask.
  if (!talk.asked) {
    if (talk.claim === null) return { message, added: false };
    if (mentionsAmount(prior, talk.claim) || mentionsAmount(message, talk.claim)) return { message, added: false };
  }
  let body = message;
  if (handsOffEarnings(body)) {
    // The generic add-back line answers "what's added back", not "is that
    // the number" — an earnings question gets the specific one in its place.
    if (!(talk.aboutFigure && GENERIC_HANDOFF_RE.test(body) && !handsOffEarnings(body.replace(GENERIC_HANDOFF_RE, " ")))) {
      return { message, added: false };
    }
    body = body.replace(GENERIC_HANDOFF_RE, " ").replace(/[ \t]{2,}/g, " ").trim();
  }
  const s = ctx.statements;
  const note =
    s && talk.claim !== null && Math.abs(talk.claim - s.amount) / Math.max(talk.claim, Math.abs(s.amount)) > 0.1 && !mentionsAmount(`${prior} ${body}`, s.amount)
      ? ` ${statementNoteLine(s)}`
      : "";
  const lead = `${earningsHandoffLine(talk, prior)}${note}`;
  const rest = body.trim();
  const out = rest ? `${lead}\n\n${rest.charAt(0).toUpperCase()}${rest.slice(1)}` : lead;
  return { message: out, added: true };
}

/**
 * The turn's instruction to the interviewer when the seller raised
 * earnings, SDE or add-backs (null otherwise) — so the draft answers it
 * the right way the first time.
 */
export function earningsNudge(
  sellerMessage: string | null | undefined,
  statements: StatementEarnings | null,
  opts: { together?: boolean; brokerAlone?: boolean } = {},
): string | null {
  // (Both readers take the seller's own lines of a broker-led exchange.)
  const talk = sellerEarningsTalk(sellerMessage);
  if (!talk && !sellerRaisesAddbacks(sellerMessage)) return null;
  if (opts.brokerAlone) {
    // The broker's own session: the person asking IS the broker.
    return [
      "# THE BROKER RAISED EARNINGS / SDE / ADD-BACKS",
      "This is the broker's own session — the person typing is the broker, not the seller. The earnings figure and what is added back are theirs to work out (the financial analysis does it from the statements): do not compute, list or total add-backs and do not state an SDE or adjusted figure. Record what they said as their view, and ask your next question.",
    ].join("\n");
  }
  if (opts.together) {
    // Broker-led: the broker is in the room and answers it themselves.
    return [
      "# THE SELLER RAISED EARNINGS / SDE / ADD-BACKS",
      "The broker is in the room and will answer this themselves — do not answer it, hand it off or comment on it. Do NOT list, name or total items that are or might be added back, and do NOT agree that an item is an add-back. Record what the seller said as their view, and give the broker the next question.",
    ].join("\n");
  }
  const lines = [
    "# THE SELLER RAISED EARNINGS / SDE / ADD-BACKS",
    "Never ignore or dodge this, and never turn it into a list. In ONE or TWO sentences before your next question:",
    "- Acknowledge what they asked or said, and say plainly that the earnings figure for the book — and what is added back — is their broker's to walk them through, against their statements.",
  ];
  if (talk?.claim != null && statements) {
    lines.push(
      `- They stated ${formatMoney(talk.claim)}. The statements on file (seller-visible) report ${statements.label} of ${statements.shown}${statements.period ? ` for ${statements.period}` : ""}${statements.basis ? ` (${statements.basis})` : ""} — a different measure from theirs (as reported, before any adjustments). If you haven't already, you may note that figure NEUTRALLY and name it as the reported line ("For reference, the ${statements.period ?? "latest"} statements report ${statements.label} of ${statements.shown}, before any adjustments") — no bridge between the two, no adjustments, no verdict on their number.`,
    );
  }
  lines.push(
    "- Do NOT list, name or total items that are or might be added back (salaries, vehicles, insurance, meals, interest, amortization, one-time costs) — not as \"items that typically get considered\", not \"from what's on file\". Do NOT agree that an item is an add-back or that it is \"on the sheet\" (\"You're right…\", \"I'll make sure X, Y and Z are captured\"). What the seller says about add-backs is recorded as their view, silently.",
    "- Then ask your next question. No SDE, add-back or adjusted figures of your own, ever.",
  );
  return lines.join("\n");
}

// ═══════════════════════ The interviewer's own add-back list ═══════════════════════

/** Framing that presents items as add-back candidates without the word. */
const CANDIDATE_FRAME_RE =
  /\b(?:items?|things?|expenses?|costs?)\s+(?:that\s+)?(?:typically\s+|usually\s+|normally\s+|commonly\s+|often\s+|generally\s+)?(?:(?:would|might|could|may|should|will)\s+)?(?:get|gets|are|be|is)\s+(?:considered|looked at|adjusted|backed out|taken out|pulled out|excluded|normali[sz]ed)\b|\bone-?time (?:or|and|\/) (?:discretionary|personal|non-?recurring)\b|\b(?:discretionary|personal) (?:or|and|\/) (?:one-?time|non-?recurring)\b|\bnon-?recurring (?:items?|expenses?|costs?)\b|\bwouldn'?t (?:recur|continue|carry over) (?:for|under|with) a (?:new owner|buyer)\b|\b(?:typical|usual|standard|common) (?:adjustments?|items?)\b/i;
const LIST_LEAD_RE = /\b(?:from what'?s on file|so far|that includes|those include|including|such as|items like)\b/i;
const EXPENSE_WORD_RE =
  /\b(?:salary|salaries|wages?|comp(?:ensation)?|pay|interest|amorti[sz]ation|depreciation|vehicles?|trucks?|cars?|lease|insurance|premiums?|meals?|entertainment|travel|legal|fees|settlement|personal|owner|rent|bonus(?:es)?|perks?|dividends?|draws?|donations?|club|box|family)\b/i;
const AGREE_START_RE =
  /^(?:you'?re (?:absolutely |completely |totally )?(?:right|correct)|that'?s (?:right|correct|true|fair)|correct|agreed|exactly|fair point|good (?:point|catch))\b/i;
// What the agreement is about: the items / the list — not "it's in the
// documents", which is the apology the never-re-ask rule asks for ("You're
// right — it's in the documents Denise sent, and I should have checked.").
const AGREE_OBJECT_RE = /\b(?:items?|expenses?|costs?|sheet|list|schedule|breakdown|add[- ]?backs?)\b/i;
const PROMISE_RE =
  /\b(?:i'?ll|i will|we'?ll|we will|let me)\s+(?:make sure|ensure|include|add|capture|count|list|put)\b|\bi(?:'ve| have) (?:got|captured|included|added|listed)\b/i;

/** How many money figures a sentence states ("$180K" once, "85 grand" once). */
const moneyCount = (s: string): number =>
  (s.match(/\$\s?\d[\d,.]*(?:\s?(?:k|m|mm|thousand|million|grand)\b)?|\b\d[\d,.]*\s?(?:k|m|mm|thousand|million|grand)\b/gi) ?? []).length;

/**
 * The statements in a reply that present items as add-back candidates or
 * agree to the seller's add-back claims (question sentences never count —
 * asking about one-time or personal costs is the interviewer's job). Only
 * in money context: the seller raised earnings / add-backs, or the reply
 * itself talks about them. "Raised" is read in context (sellerRaisesAddbacks,
 * sellerEarningsTalk): "I've told you multiple times" or "I already gave you
 * the cash flow statement" is a re-ask complaint, and its apology stays.
 */
export function candidateListStatements(message: string, sellerMessage?: string | null): string[] {
  const text = message.replace(/[’‘]/g, "'");
  const sellerRaised = sellerRaisesAddbacks(sellerMessage) || !!sellerEarningsTalk(sellerMessage)?.asked;
  const sentences = sentencesOf(text);
  const replyMoney = sentences.some((s) => EARNINGS_TERM_RE.test(s) || CANDIDATE_FRAME_RE.test(s));
  if (!sellerRaised && !replyMoney) return [];
  const framed = sentences.some((s) => CANDIDATE_FRAME_RE.test(s));
  const out: string[] = [];
  sentences.forEach((s, i) => {
    if (/\?\s*$/.test(s)) return;
    const money = moneyCount(s);
    // "…making sure we've captured the items that typically get considered."
    if (CANDIDATE_FRAME_RE.test(s)) { out.push(s); return; }
    // "From what's on file: your $240K management salary, Maria's $85K, …"
    const prevFrames = i > 0 && (CANDIDATE_FRAME_RE.test(sentences[i - 1]) || EARNINGS_TERM_RE.test(sentences[i - 1]));
    if (money >= 2 && EXPENSE_WORD_RE.test(s) && (framed || prevFrames || EARNINGS_TERM_RE.test(s) || LIST_LEAD_RE.test(s.split(/\$/)[0]))) { out.push(s); return; }
    // "I'll make sure the owner vehicles ($28K), health and life insurance ($9K)…"
    if (PROMISE_RE.test(s) && money >= 1 && (sellerRaised || EARNINGS_TERM_RE.test(s))) { out.push(s); return; }
    // "You're right — those items are in the documents Denise sent."
    if (sellerRaised && AGREE_START_RE.test(s) && AGREE_OBJECT_RE.test(s)) { out.push(s); return; }
  });
  return out;
}
