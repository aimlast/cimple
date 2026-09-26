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

/** Earnings / normalisation vocabulary. */
const EARNINGS_TERM_RE =
  /\b(?:sde|seller'?s discretionary|discretionary (?:earnings|cash ?flow)|add[- ]?backs?|added[- ]back|adding (?:it |that |them |this |those |everything |it all |all (?:of )?that )?back|add (?:it|that|them|this|those|everything|it all|all (?:of )?that|all of it) back|normali[sz]\w*|recast|cash ?flow|ebitda|earnings|bottom line|multiple)\b/i;
/** "The number going in the book", "what figure is she using". */
const BOOK_NUMBER_RE =
  /\b(?:the|that|this|what|which|your|her|his|their|morgan'?s|the broker'?s)\s+(?:actual\s+|real\s+|final\s+)?(?:number|figure)\b[^.?!]{0,60}\b(?:book|cim|memorandum|listing|package|buyers?|going in|goes in|put(?:ting)? in|using|use|telling|came up with|come up with|working (?:with|from|off))\b|\bwhat(?:'s| is) the (?:actual |real |final )?(?:number|figure)\b/i;
/** A question about the figure itself (not about one item's treatment). */
const FIGURE_TERM_RE = /\b(?:sde|seller'?s discretionary|discretionary (?:earnings|cash ?flow)|ebitda|cash ?flow|earnings|bottom line|multiple|recast)\b/i;
/**
 * An earnings figure the owner states: a figure right after "clears",
 * "nets", "throws off", "takes home", or after "SDE / EBITDA / cash flow /
 * earnings / profit is…" — the cue must lead straight into the figure, so
 * "$1.4M net of trade-ins", "gets cleared at closing" or "80% of gross
 * profit … $6.2 million in revenue" (seeding corpus) are not claims.
 */
const CLAIM_FIGURE = String.raw`\$\s?\d[\d,.]*(?:\s?(?:k|m|mm|thousand|million|grand)\b)?|\d[\d,.]*\s?(?:k|m|mm|thousand|million|grand)\b|(?:a|one) million and a half|one and a half million|(?:a|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?(?: hundred)?(?: and a half)? (?:thousand|grand|million)`;
const CLAIM_CUE = String.raw`(?:clears?|cleared|clearing|nets?(?! of)|netted|netting|throws? off|threw off|takes? home|took home|pockets?|pocketed|(?<!gross )(?:sde|ebitda|cash ?flow|earnings|bottom line|take-home|(?:net )?profit)(?:'s|\s+(?:is|was|of|runs?(?: at)?|comes? (?:in )?(?:at|to)|came (?:in )?(?:at|to)|sits? at|would be|should be|around|about|at))?)`;
const CLAIM_HEDGE = String.raw`(?:about|around|roughly|approximately|close to|nearly|almost|over|under|north of|just over|just under|call it|maybe|like|a solid|a good|probably|easily)`;
const CLAIM_RE = new RegExp(String.raw`\b${CLAIM_CUE}\s+(?:me\s+|us\s+|the owner\s+)?(?:${CLAIM_HEDGE}\s+){0,2}(${CLAIM_FIGURE})`, "gi");

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
  if (!sellerMessage) return null;
  const text = sellerMessage.replace(/[’‘]/g, "'");
  // Question sentences: the text up to each "?" since the last sentence end.
  // A tag ("…when you add it all back, you know what I mean?", "…, right?")
  // makes a statement, not a question (seeding corpus: "Denise adds all that
  // back when they're showing the real cash flow, you know what I mean?").
  const TAG_RE = /,?\s*\b(?:you know what i mean|you know|right|correct|ok(?:ay)?|eh|yeah|no|isn'?t it|don'?t you think|agreed|see what i mean)\s*\?$/i;
  const questions = (text.match(/[^.!?\n]*\?/g) ?? []).filter((q) => !TAG_RE.test(q.trim()));
  const asked = questions.some((q) => EARNINGS_TERM_RE.test(q) || BOOK_NUMBER_RE.test(q));
  // What the business earns — not one item the seller counts as an add-back
  // ("my $240K salary is an add-back" is an item, not earnings).
  let claim: number | null = null;
  CLAIM_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CLAIM_RE.exec(text)) !== null) {
    const amounts = moneyAmounts(m[1]).filter((n) => n >= 50_000);
    if (amounts.length > 0) claim = Math.max(claim ?? 0, ...amounts);
  }
  if (!asked && claim === null) return null;
  const aboutFigure = claim !== null || questions.some((q) => FIGURE_TERM_RE.test(q) || BOOK_NUMBER_RE.test(q));
  const termMatch = text.match(/\b(sde|add[- ]?backs?|cash ?flow|ebitda|earnings)\b/i);
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

/** Reported (never normalised) earnings keys, most useful first. */
const STATEMENT_EARNINGS_KEYS: Array<[RegExp, string]> = [
  [/^netIncome$/, "net income"],
  [/^netIncomeAfterTax(?:es)?$/, "net income"],
  [/^netProfit$/, "net profit"],
  [/^netEarnings$/, "net earnings"],
  [/^(?:netIncomeBeforeTax(?:es)?|incomeBeforeTax(?:es)?|pretaxIncome|preTaxIncome)$/, "income before tax"],
];

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
  for (const [re, label] of STATEMENT_EARNINGS_KEYS) {
    const key = Object.keys(info).find((k) => re.test(k));
    if (!key) continue;
    if (sourceOf(key) !== "document") continue;
    const raw = info[key];
    if (typeof raw !== "string" && typeof raw !== "number") continue;
    // The headline clause ("$563,190 after tax (FY2024); FY2023 $482,930…").
    const head = String(raw).split(/;|\n/)[0];
    const fig = head.match(/-?\$\s?\d[\d,]*(?:\.\d+)?\s?(?:[kKmM](?![a-z])|million|thousand)?/);
    if (!fig) continue;
    const amounts = moneyAmounts(fig[0]);
    if (amounts.length === 0) continue;
    const period = head.match(/\bFY\s?'?(?:20)?\d{2}\b|\b(?:19|20)\d{2}\b/i)?.[0].replace(/\s+/g, "") ?? null;
    const basis = /\bafter[- ]tax/i.test(head) ? "after tax" : /\bbefore[- ]tax|\bpre-?tax/i.test(head) ? "before tax" : null;
    return { label, amount: amounts[0], shown: fig[0].replace(/\s+/g, ""), period, basis };
  }
  return null;
}

// ═══════════════════════ The hand-off ═══════════════════════

/** The broker, or a person named mid-sentence ("a question for Morgan"). */
const BROKER_RE = /\b(?:your broker|the broker|broker'?s)\b/i;
const NAME_RE = /(?<=\S\s+)(?!(?:The|This|That|These|Those|Your|For|On|In|If|And|But|So|It|I|We|You|They|He|She|What|When|How|Why|Is|Are|FY)\b)[A-Z][a-z]{2,}(?:'s)?\b/;
const HANDOFF_VERB_RE =
  /\b(?:walk(?:s|ing)? you through|go(?:es|ing)? (?:over|through)|take(?:s)? you through|confirm(?:s)?|finali[sz]e(?:s)?|decide(?:s)?|explain(?:s)?|discuss|review(?:s)?|work(?:s)? (?:it )?out|conversation (?:to have )?with|question for|(?:call|one) to make|to answer|sets?)\b/i;
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
export function earningsHandoffLine(talk: EarningsTalk): string {
  // A question about how items are treated gets the add-back hand-off.
  if (!talk.aboutFigure) return GENERIC_ADDBACK_HANDOFF;
  const what = talk.claim !== null ? `the ${formatMoney(talk.claim)}` : talk.term === "SDE" ? "the SDE question" : talk.term && /add/.test(talk.term) ? "the add-backs" : "your earnings question";
  return `On ${what}: the earnings figure that goes in the book is your broker's to walk you through, against your statements.`;
}

/** The neutral note of what the statements show ("For reference, …"). */
export function statementNoteLine(s: StatementEarnings): string {
  return `For reference, the ${s.period ? `${s.period} ` : ""}financials on file show ${s.label} of ${s.shown}${s.basis ? ` (${s.basis})` : ""}.`;
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
  const lead = `${earningsHandoffLine(talk)}${note}`;
  const rest = body.trim();
  const out = rest ? `${lead}\n\n${rest.charAt(0).toUpperCase()}${rest.slice(1)}` : lead;
  return { message: out, added: true };
}

/**
 * The turn's instruction to the interviewer when the seller raised
 * earnings, SDE or add-backs (null otherwise) — so the draft answers it
 * the right way the first time.
 */
export function earningsNudge(sellerMessage: string | null | undefined, statements: StatementEarnings | null): string | null {
  const talk = sellerEarningsTalk(sellerMessage);
  const addbacksRaised = !!sellerMessage && /\badd[- ]?backs?\b|\badd(?:ed|ing)? (?:it |that |them |this |those |everything |it all )?back\b|\b(?:that|it|this)(?:'s| is) personal\b|\bcomes? out\b/i.test(sellerMessage);
  if (!talk && !addbacksRaised) return null;
  const lines = [
    "# THE SELLER RAISED EARNINGS / SDE / ADD-BACKS",
    "Never ignore or dodge this, and never turn it into a list. In ONE or TWO sentences before your next question:",
    "- Acknowledge what they asked or said, and say plainly that the earnings figure for the book — and what is added back — is their broker's to walk them through, against their statements.",
  ];
  if (talk?.claim != null && statements) {
    lines.push(
      `- They stated ${formatMoney(talk.claim)}. The financials on file (seller-visible) show ${statements.label} of ${statements.shown}${statements.period ? ` for ${statements.period}` : ""}${statements.basis ? ` (${statements.basis})` : ""}. If you haven't already, you may note that figure NEUTRALLY ("For reference, the ${statements.period ?? "latest"} financials show ${statements.label} of ${statements.shown}") — no bridge between the two, no adjustments, no verdict on their number.`,
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
const AGREE_OBJECT_RE = /\b(?:items?|those|them|they|these|expenses?|costs?|sheet|list|schedule|documents?|breakdown|add[- ]?backs?)\b/i;
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
 * itself talks about them.
 */
export function candidateListStatements(message: string, sellerMessage?: string | null): string[] {
  const text = message.replace(/[’‘]/g, "'");
  const seller = (sellerMessage ?? "").replace(/[’‘]/g, "'");
  const sellerRaised = !!seller && (EARNINGS_TERM_RE.test(seller) || /\b(?:that|it|this)(?:'s| is) personal\b|\bcomes? out\b|\bone-?time\b/i.test(seller));
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
