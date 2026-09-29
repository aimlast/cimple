/**
 * staff-private — an employee's private matters never reach the CIM by default.
 *
 * The seller talks about their people in the interview, and some of it is
 * between the owner and that person: the lead pharmacist who asked,
 * half-joking, whether he could ever buy in (Beacon, 2026-09-28 — the rebuilt
 * CIM printed it in Key Personnel AND turned it into an Ideal Buyer Profile
 * pitch: "Daniel informally expressed interest in an equity stake … A buyer
 * who can structure equity roll-over, earn-in …"). The founder: "I don't want
 * to include it in the CIM."
 *
 * Held by default (clause by clause — the rest of the fact stays):
 *   equity        a staff member's interest in equity / a stake / buying in,
 *                 or the idea of giving them one to keep them
 *   pay           a raise request, a pay complaint or dispute
 *   departure     a possible or rumoured departure (thinking of leaving,
 *                 flight risk, being recruited, notice given)
 *   conduct       performance or disciplinary matters (warnings, PIPs,
 *                 probation, attendance, misconduct)
 *   personal      their leave, health or family circumstances
 *   conversation  private conversations between the owner and staff
 *                 ("privately", "in confidence", "half-joking")
 *
 * Never held (a buyer should know, and the seller has made it official):
 * signed or agreed arrangements (an employment or retention agreement, an
 * agreed management rollover, a stake someone already owns), announced
 * departures or succession plans, anything the seller wants marketed; the
 * owner's own plans (their rollover, their retirement — the reason for sale);
 * positive or negative-free retention statements ("unlikely to leave", "no
 * departure signals"); staff history ("a pharmacist who left after 3 months").
 *
 * The broker sees every held item (CIM tab, generation warnings) and can
 * include it — the decision is kept on the deal (STAFF_PRIVATE_INCLUDED_KEY)
 * and the included words go back into the inputs on the next generation.
 *
 * Pure — no I/O.
 */
import { GIVEN_NAMES } from "@shared/blind-given-names";
import { describeStaffPrivate, STAFF_PRIVATE_INCLUDED_KEY, type StaffPrivateItem, type StaffPrivateKind } from "@shared/staff-private";
import { genderOfGivenName } from "./given-name-gender";

export { STAFF_PRIVATE_INCLUDED_KEY };

// ── Topics ────────────────────────────────────────────────────────────────

/** Equity words — a stake, buying in, a roll-over or earn-in offered to someone. */
const EQUITY_WORD = new RegExp(
  String.raw`\b(?:equity(?!\s+(?:line|loan|financing|investors?|firms?|funds?|groups?|sponsors?|method|accounting|section|statement))|stakes?\b|shareholding|ownership(?!\s+(?:change|transfer|structure|notification|approval|restrictions?|rules?|requirements?|of the (?:building|property|premises)))|buy(?:ing)?[- ]in\b|buy(?:ing)? (?:into|in)\b|piece of the (?:business|company|pharmacy|practice|clinic|shop|firm|action)|(?:become|becoming|make (?:him|her|them)|made (?:him|her|them))\s+(?:a\s+)?(?:partner|shareholder|co-?owner)|partnership (?:stake|interest|track)|roll-?over|earn-?ins?\b|phantom (?:equity|shares?)|(?:share|stock) options?|(?:some|a few) shares|(?:buy|own|get|have|take|purchase|acquire|hold)(?:s|ing)?\s+(?:a\s+|some\s+|an?\s+\w+\s+)?(?:share|part|piece|slice|portion|percentage|cut|bit)\s+(?:of|in)\s+(?:the\s+|his\s+|her\s+)?(?:business|company|pharmacy|practice|clinic|shop|firm|store|operation|firm)|\b(?:a|some)\s+(?:share|part|piece|slice|portion|cut)\s+of\s+(?:the\s+)?(?:business|company|pharmacy|practice|clinic|shop|firm|store|ownership))`,
  "i",
);

/** An ask, a wish, or an idea of offering it to keep someone — not a state ("owns 10%"). */
const WANTS = new RegExp(
  String.raw`\b(?:ask(?:ed|s|ing)?|rais(?:ed|es|ing)|inquir(?:ed|es|ing|y)|enquir(?:ed|es|ing|y)|interest(?:ed)?|want(?:s|ed)?|would (?:like|love)|hop(?:es|ed|ing)|keen|approach(?:ed)?|express(?:ed)?|floated|mentioned|brought up|pitched|propos(?:ed|al)|request(?:ed)?|push(?:ed|ing)? for|angling|eyeing|dreams? of|aspir\w*|let (?:him|her|them)|offer(?:ed|ing|s)? (?:him|her|them)|giv(?:e|ing|en) (?:him|her|them)|buyer-offered|(?:would|could|might|to|will) (?:help )?(?:retain|secure|keep|lock in|tie)|retain (?:him|her|them)|keep (?:him|her|them)|stay (?:forever|long[- ]term|on)|long[- ]term commitment|commitment|retention)\b`,
  "i",
);

/** The owner's own equity plans — the deal's structure, not a staff matter. */
const OWNER_EQUITY = /\b(?:seller|owner|vendor|founder)(?:'s|s')?\s+(?:(?:is|was|would be|will|may|might|could|would|to|plans to|intends to|is willing to|willing to|is open to|open to|prepared to|wants to|agreed to)\s+)?(?:roll(?:ing)?(?:[- ]?over)?|retain(?:ing)?|keep(?:ing)?|reinvest(?:ing)?|hold(?:ing)?)\b|\b(?:seller|owner|vendor)(?:'s)? (?:equity )?(?:roll-?over|reinvestment|retained (?:equity|stake))|\bvendor take-?back\b|\bvtb\b|\bearn-?out\b/i;

const PAY_RE = new RegExp(
  [
    String.raw`\b(?:ask(?:ed|s|ing)?|push(?:ed|ing)?|press(?:ed|ing)?|want(?:s|ed)?|request(?:ed|s|ing)?|demand(?:ed|s|ing)?|hint(?:ed|ing)?|lobb(?:y|ied|ying)|negotiat\w*|angling)\s+(?:for\s+|about\s+)?(?:[\w%$.,]+\s+){0,3}(?:raise|pay (?:rise|increase|bump)|salary (?:increase|bump|review)|more money|higher (?:pay|salary|wages?)|bigger bonus|a bonus|more pay|wage increase)\b`,
    String.raw`\b(?:pay|wage|salary|compensation|bonus|overtime|commission) (?:disputes?|grievances?|complaints?|disagreements?|arguments?|fights?)\b`,
    String.raw`\b(?:unhappy|upset|frustrated|disgruntled|complain(?:s|ed|ing)?|grumbl\w*|resent\w*|bitter)\b[^.;]{0,30}\b(?:pay|salary|wages?|compensation|bonus|raise)\b`,
    String.raw`\b(?:feels?|thinks?) (?:\w+ )?underpaid\b|\bunderpaid\b`,
  ].join("|"),
  "i",
);

const LEAVE = String.raw`(?:leav(?:e|es|ing)|quit(?:s|ting)?|resign(?:s|ed|ing|ation)?|retir(?:e|es|ing|ement)|move on|moving on|go (?:elsewhere|to a competitor|out on (?:his|her|their) own)|start(?:ing)? (?:his|her|their) own|open(?:ing)? (?:his|her|their) own|join(?:ing)? (?:a )?competitor|walk(?:ing)? (?:away|out)|depart(?:s|ure|ing)?|go(?:ing)? back to school|relocat(?:e|es|ing))`;
/** Leaving for another job — not retiring, which a seller states as a succession fact ("plans to retire in 2027"). */
const LEAVE_JOB = String.raw`(?:leav(?:e|es|ing)|quit(?:s|ting)?|resign(?:s|ed|ing|ation)?|move on|moving on|go (?:elsewhere|to a competitor|out on (?:his|her|their) own)|start(?:ing)? (?:his|her|their) own|open(?:ing)? (?:his|her|their) own|join(?:ing)? (?:a )?competitor|walk(?:ing)? (?:away|out)|go(?:ing)? back to school)`;
/** Uncertain or rumoured — any departure, retirement included ("thinking about retiring"). */
const MAYBE = String.raw`(?:may|might|could|likely to|probably|thinking (?:about|of)|considering|contemplating|talk(?:ed|ing|s)? (?:about|of)|talk of|rumou?r(?:s|ed)?|hint(?:ed|ing|s)?|threaten(?:s|ed|ing)?|at risk of|risk (?:of|that)|worried|concern(?:ed)?|fears?|feared|afraid)`;
/** A private plan to leave the job (a stated retirement date is succession, not held). */
const PLANS = String.raw`(?:plans? to|planning (?:to|on)|wants? to|intends? to|hopes? to|is expected to|expects to)`;
/** A possible, planned-in-private or rumoured departure. */
const DEPARTURE_MAYBE_RE = new RegExp(
  [
    String.raw`\b${MAYBE}\b[^.;]{0,40}?\b${LEAVE}\b`,
    String.raw`\b${PLANS}\b[^.;]{0,20}?\b${LEAVE_JOB}\b`,
    String.raw`\b(?:may|might|would|could) not stay\b|\bwon'?t stay\b|\bnot going to stay\b|\bunlikely to stay\b`,
    // Someone being recruited away — not the industry's hiring ("technicians are recruited by larger firms").
    String.raw`\bflight risk\b|\b(?:was|has been|had been|is being|been|got|getting) (?:poached|headhunted|recruited|courted|approached)\b|\bbeing (?:poached|headhunted|recruited|courted)\b|\b(?:trying|tried|tries|attempting|attempted|wants?|wanted) to (?:poach|recruit|hire away|lure)\s+(?:him|her|them|[A-Z]\w+)|\bapproached by (?:a |another )?(?:competitor|recruiter|headhunter|rival)`,
    String.raw`\blooking (?:for|at|around for) (?:another|other|a new|new) (?:jobs?|roles?|positions?|opportunit\w+|employers?)\b|\b(?:job[- ]hunting|applying (?:for|to) (?:other )?jobs)\b|\binterview(?:ing|ed) (?:elsewhere|with (?:a |another |other )?(?:competitors?|rivals?|employers?))`,
  ].join("|"),
  "i",
);
/** A departure that has happened or is fixed — held only while it isn't announced or agreed (DEPARTURE_ANNOUNCED). */
const DEPARTURE_DEFINITE_RE = /\b(?:gave|given|giving|handed in|tendered|submitted) (?:his |her |their )?(?:notice|resignation)\b|\bhas (?:just )?resigned\b|\bis leaving\b|\bwill be leaving\b|\blast day\b/i;
/**
 * The departure is official: a buyer should know it (a resignation with its
 * effective date, a replacement already hired, an agreed transition,
 * customers told).
 */
const DEPARTURE_ANNOUNCED = /\beffective (?:on |as of )?(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\.? \d{1,2}|\d{1,2} (?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*|\d{4}|the end of)|\b(?:replacement|successor)\b[^.;]{0,50}?\b(?:hired|in place|trained|named|appointed|identified|already|started|recruited)\b|\b(?:agreed|planned|orderly|announced|formal) (?:transition|departure|exit|handover|hand-?off)\b|\b(?:customers|clients|staff|the team|employees|suppliers) (?:have been|were|has been|are|all) (?:told|informed|notified|aware)\b|\bannounced\b|\bpublicly\b/i;
const DEPARTURE_UNANNOUNCED = /\b(?:not (?:yet )?(?:announced|public|told)|hasn'?t (?:yet )?(?:told|announced)|(?:doesn'?t|don'?t) know yet|no one (?:else )?knows|nobody (?:else )?knows|keeping (?:it|this) quiet)\b/i;
/** A departure statement that is really about staying ("unlikely to leave", "no departure signals"). */
const STAYING = /\b(?:no|not|never|neither|unlikely|nor|none|without|n't)\b[^.;]{0,40}\b(?:leav|quit|resign|depart|retir|move on|go elsewhere|signals?|signs?|risk|plans?)|\b(?:committed to|will|wants? to|plans? to|intends? to|expected to|expects to|agreed to) (?:stay|remain|continue)\b/i;

const CONDUCT_RE = new RegExp(
  String.raw`\b(?:performance (?:issues?|problems?|concerns?|improvement plan|warnings?|management|reviews? (?:flagged|noted))|under-?perform\w*|poor(?:ly)? perform\w*|\bPIP\b|(?:written|verbal|final|formal) warning|disciplin(?:ed|ary (?:action|matter|issue|hearing|meeting|record|process|letter|note))|reprimand\w*|(?:was |been |got |is )suspended|(?:put|placed) on probation|on (?:disciplinary|final) probation|on probation (?:for|after|because|over|following)|(?:was |got |been )?(?:fired|terminated|let go|dismissed) (?:for|over|because)|(?:drinking|alcohol|drug|substance) (?:problem|issue|abuse)|attendance (?:issues?|problems?)|(?:chronically|always|often|habitually) late|no-?shows?|harass(?:ed|ing|ment)|misconduct|insubordinat\w*|complaints? (?:about|against) (?:him|her|them)|attitude (?:problem|issues?)|clash(?:es|ed)? with|(?:doesn'?t|does not|don'?t) get along)\b`,
  "i",
);

const PERSONAL_RE = new RegExp(
  String.raw`\b(?:(?:maternity|paternity|parental) leave(?!\s+(?:top-?up|polic(?:y|ies)|benefits?|coverage|program|plan))|pregnan(?:t|cy)|on (?:medical|sick|stress|disability|compassionate|bereavement|personal) leave|(?:medical|sick|stress|disability|compassionate|bereavement) leave (?:since|until|for)|family (?:emergency|issues|problems|matters|situation|circumstances|reasons|troubles)|caring for (?:his|her|their) (?:sick|ill|elderly|ageing|aging|dying|disabled) \w+|(?:his|her|their|[a-z]+'s) (?:kids?|children|son|daughter|wife|husband|spouse|partner|mother|father|mom|mum|dad|parents?) (?:is |are |was |were |has been |have been )?(?:sick|ill|in (?:the )?hospital|unwell|dying|struggling|in palliative care|having (?:surgery|treatment))|(?:has|had|was|been) (?:recently )?diagnosed with|undergoing (?:chemo\w*|treatment|surgery)|mental health|burn(?:ed|t)?[- ]?out|(?:in|into|to|entered|out of|left|checked into) rehab\b|(?:going|went|is going) through a (?:divorce|separation|tough time|rough patch|hard time))\b`,
  "i",
);

const TOLD = String.raw`(?:told|asked|mentioned|raised|said|admitted|expressed|indicated|shared|hinted|confessed|let (?:slip|on)|floated)`;
/** "Privately" about a conversation — not "30 percent paying privately" or a privately held company. */
const CONVERSATION_RE = new RegExp(String.raw`\b(?:(?:privately|in private)\s+${TOLD}|${TOLD}\b[^.;]{0,40}\b(?:privately|in private)\b)|\b(?:confided|in confidence|off the record|behind closed doors|informally (?:asked|told|mentioned|raised|said|approached|floated|inquired|enquired)|half[- ]?jok\w*|jokingly|over (?:a )?(?:beers?|drinks|coffee|lunch)|quietly (?:asked|told|mentioned|raised)|(?:one-on-one|personal|private) conversation)\b`, "i");

/** Official, agreed or announced — a buyer should know it; never held. */
const SETTLED = new RegExp(
  [
    String.raw`\b(?:signed|executed)\s+(?:an?\s+|the\s+|his\s+|her\s+)?(?:employment|retention|stay|shareholders?'?|option|equity|non-?compete|management|rollover|roll-over|earn-in)\s+(?:agreement|contract|bonus|plan|letter)`,
    String.raw`\b(?:employment|retention|stay|shareholders?'?|option|equity|rollover|roll-over|earn-in)\s+(?:agreement|contract|bonus|plan|letter)\s+(?:is |was |has been |are |were )?(?:signed|executed|in place|agreed)`,
    String.raw`\b(?:agreed|committed|confirmed)\s+(?:in writing|to (?:stay|remain|roll|continue|join|sign))`,
    String.raw`\b(?:owns|holds|has held|currently holds|already holds)\s+(?:an?\s+)?(?:\d+(?:\.\d+)?\s*%\s*|minority\s+|small\s+)?(?:equity|stake|shares|interest)`,
    String.raw`\bis an? (?:minority |existing )?shareholder\b|\bvested\b|\bhas been (?:granted|issued)\b`,
    String.raw`\bannounced (?:to (?:staff|the team|employees|customers)|internally|publicly)\b|\b(?:staff|team|employees) (?:know|have been told|were told|are aware)\b`,
    String.raw`\b(?:disclosed|documented|agreed|announced|formal) succession plan\b|\bsuccession plan (?:is |has been )?(?:in place|documented|agreed|announced)\b`,
    String.raw`\b(?:seller|owner|broker|vendor) (?:wants|would like|asked|agreed) (?:this|it|that) (?:to be )?(?:marketed|highlighted|in the cim|shown to buyers|shared with buyers|disclosed)\b|\bto be marketed\b`,
    String.raw`\bmanagement (?:rollover|roll-over|buy-?in) (?:is |has been )?(?:agreed|in place|committed|confirmed)\b`,
    // Someone who already owns part of the company is the cap table, not a wish.
    String.raw`\b\d+(?:\.\d+)?\s*%\s*(?:shareholder|owner|partner|equity (?:holder|partner|stake)|stake(?:holder)?|interest)\b|\b(?:existing|current) (?:minority )?(?:shareholder|partner)\b|\bequity partner (?:since |in )?(?:19|20)\d{2}\b`,
    // A legal matter (a claim, a settlement, a tribunal) is litigation history for due diligence.
    String.raw`\b(?:settle(?:d|ment)|lawsuit|litigation|tribunal|court|wrongful dismissal|human rights (?:complaint|claim)|labou?r board|employment standards)\b`,
  ].join("|"),
  "i",
);

/** A clause that answers the one before it ("Helen declined but kept door open"). */
const BACKREF = /^(?:(?:the\s+)?(?:owner|seller|vendor|she|he|they|[A-Z][a-z]+)\s+)?(?:(?:has|had|was|is)\s+)?(?:declined|refused|said no|turned (?:it|him|her|them|this|that) down|kept (?:the\s+)?door open|(?:is|was) (?:open to|considering|thinking about|undecided)|hasn'?t (?:decided|answered|responded)|didn'?t (?:answer|respond|commit)|put (?:it|him|her|them) off|agreed to (?:think|consider)|laughed it off|would consider)\b|\b(?:the|that|this|his|her|their) (?:request|ask)\b|\bdoor open\b/i;

/** Negated at a position: "no", "not", "never", "unlikely" within the four words before. */
function negatedBefore(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 40), index).split(/\s+/).slice(-4).join(" ");
  return /\b(?:no|not|never|neither|unlikely|without|nor|none|nobody)\b|n't\b/i.test(before);
}

function matchNotNegated(re: RegExp, text: string): boolean {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  for (const m of Array.from(text.matchAll(g))) if (!negatedBefore(text, m.index ?? 0)) return true;
  return false;
}

/**
 * The staff-private topic a clause states, if any — before asking who it is
 * about. Exemptions (settled, the owner's equity, staying) are applied here.
 */
export function staffPrivateTopic(clause: string, around?: string): StaffPrivateKind | null {
  const t = clause.replace(/[’‘]/g, "'");
  if (!t.trim() || SETTLED.test(t)) return null;
  if (EQUITY_WORD.test(t) && matchNotNegated(WANTS, t) && !OWNER_EQUITY.test(t)) return "equity";
  if (matchNotNegated(PAY_RE, t)) return "pay";
  if (DEPARTURE_MAYBE_RE.test(t) && !STAYING.test(t)) return "departure";
  // A resignation or a fixed last day is held only while it is still quiet:
  // announced, dated with a replacement in place, or agreed, it is a fact a
  // buyer must read (the fact it sits in — `around` — may say so).
  if (DEPARTURE_DEFINITE_RE.test(t) && !STAYING.test(t)) {
    const ctx = (around ?? t).replace(/[’‘]/g, "'");
    if (DEPARTURE_UNANNOUNCED.test(ctx) || !DEPARTURE_ANNOUNCED.test(ctx)) return "departure";
  }
  if (matchNotNegated(CONDUCT_RE, t)) return "conduct";
  if (matchNotNegated(PERSONAL_RE, t)) return "personal";
  if (CONVERSATION_RE.test(t)) return "conversation";
  return null;
}

// ── Who it is about ───────────────────────────────────────────────────────

/** Staff words that name an employee whoever else the clause mentions. */
const STAFF_STRONG = /\b(?:employees?|staff(?:ers?)?|team members?|colleagues?|workers?|key (?:person|people|employees?|staff|hires?)|lead (?:pharmacist|technician|tech|hygienist|hand|carpenter|installer|mechanic|estimator|dispatcher|chef|cook|stylist|groomer|therapist|nurse|driver)|(?:ltc|shop|site|office|store|service|sales|operations|front[- ]store|compounding|kitchen|warehouse|production|plant|project|practice) (?:lead|manager|supervisor)|right[- ]hand|second[- ]in[- ]command|apprentices?)\b/i;
/** Job titles — the owner can hold one too ("owner + DM pharmacist"), so they count only when the clause doesn't name the owner. */
const STAFF_ROLE = /\b(?:managers?|supervisors?|foreman|forewoman|foremen|pharmacists?|technicians?|techs?|hygienists?|assistants?|associates?|dispatchers?|drivers?|estimators?|controllers?|bookkeepers?|chefs?|cooks?|nurses?|therapists?|physios?|physiotherapists?|dentists?|veterinarians?|vets?|mechanics?|installers?|operators?|machinists?|salesperson|sales ?reps?|coordinators?|administrators?|admins?|receptionists?|gm|general manager|electricians?|plumbers?|welders?|superintendents?|clerks?|cashiers?|bartenders?|servers?|groomers?|stylists?|analysts?|engineers?|developers?|carpenters?|labou?rers?)\b/i;
/** The owner and their family ("spouse Donna wants to relocate" is the reason for sale, not a staff matter). */
const OWNER_WORD = /\b(?:owner|owners|owner's|seller|seller's|vendor|founder|proprietor|principal|spouse|wife|husband)\b/i;
const PRONOUN = /\b(he|him|his|she|her|hers)\b/gi;

/** What the screen knows about the deal's people. */
export interface StaffContext {
  /** The owner(s)' name words, lower case ("helen", "park"). */
  ownerNames: string[];
  /** The owner's gender when their first name says it (a "his" then isn't hers). */
  ownerGender: "m" | "f" | null;
  /** Staff names the facts mention ("Daniel Okafor", "Mei-Lin"). */
  staffNames: string[];
}

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Given names that are also months, days or everyday capitalised words at a sentence start. */
const NOT_A_NAME = new Set("january february march april may june july august september october november december monday tuesday wednesday thursday friday saturday sunday summer autumn winter spring will grace hope joy faith art bill mark rose june dawn page chase grant hunter".split(" "));

/** A person's name that starts with a known given name ("Daniel Okafor", "Mei-Lin", "Farah"). */
function personNamesIn(text: string): string[] {
  const out: string[] = [];
  const re = /\b([A-Z][a-z]+(?:-[A-Z][a-z]+)?)(?:\s+([A-Z][a-z]+(?:-[A-Z][a-z]+)?))?/g;
  for (const m of Array.from(text.matchAll(re))) {
    const first = fold(m[1]);
    if (NOT_A_NAME.has(first)) continue;
    if (!GIVEN_NAMES.has(first) && !GIVEN_NAMES.has(first.split("-")[0])) continue;
    // "Daniel Okafor" — but not "Helen Believes": the second word must look like a surname.
    const second = m[2] && !/^(?:The|And|But|Or|If|Is|Was|Has|Had|Said|Asked|Believes|Thinks|Wants|Declined|Views|Says|Will|Would|Could|May|Might|Handles|Works|Knows|Manages|Leads|Runs|Took|Told|About|For|From|With|In|On|At|To|Since)$/.test(m[2]) ? m[2] : "";
    out.push(second ? `${m[1]} ${second}` : m[1]);
  }
  return out;
}

const OWNER_BEFORE = /\b((?:[A-Z][a-z]+)(?:\s+[A-Z][a-z]+)?)\s*\((?:the\s+)?(?:owner|founder|seller|vendor|president|ceo|sole shareholder|100% shareholder)\b/g;
const OWNER_AFTER = /\b(?:owner|founder|seller|vendor)(?:[\s/+-]+(?:operator|and [a-z ]+))?\s*[:,(]?\s+(?:Dr\.?\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/gi;
const FAMILY_BEFORE = /\b(?:spouse|wife|husband|son|daughter)\s*,?\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/gi;
const FAMILY_AFTER = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s*\((?:the\s+)?(?:owner'?s\s+|seller'?s\s+)?(?:spouse|wife|husband|son|daughter)\b/g;

const STAFF_KEY = /employee|staff|team|personnel|management|manager|retention|keyPe|keyStaff|dependenc|pharmacist|technician|hygienist|associate|workforce|orgChart|succession|crew|people|hires?\b|payroll|workers?/i;
const OWNER_KEY = /^(?:owner|owners|seller|sellers|vendor|founder|founders|proprietor|principal|principals)(?:Name|Names|FullName)?$|^(?:ownership|shareholders?|shareholderInfo|shareholderStructure)$/i;

function textOf(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return v.map(textOf).join("\n");
  if (typeof v === "object") return Object.values(v as Record<string, unknown>).map(textOf).join("\n");
  return "";
}

/** The deal's people, from its facts (owner keys; staff keys). */
export function staffContextFrom(info: Record<string, unknown> | null | undefined): StaffContext {
  const ownerNames = new Set<string>();
  let ownerGender: "m" | "f" | null = null;
  const entries = Object.entries(info ?? {}).map(([k, v]) => [k.replace(/^[cl]:/, ""), v] as [string, unknown]);
  for (const [key, value] of entries) {
    if (key.startsWith("_") || !OWNER_KEY.test(key)) continue;
    for (const name of personNamesIn(textOf(value))) {
      const words = name.split(/\s+/).map(fold);
      if (!ownerGender) ownerGender = genderOfGivenName(words[0]);
      for (const w of words) ownerNames.add(w);
    }
  }
  // "Dr. Amrit Sandhu (owner, …)", "Owner: Gord", and the owner's family
  // ("Spouse Harjit", "Richard Park (husband …)") — whichever fact says it.
  for (const [key, value] of entries) {
    if (key.startsWith("_")) continue;
    const t = textOf(value);
    for (const re of [OWNER_BEFORE, OWNER_AFTER, FAMILY_BEFORE, FAMILY_AFTER]) {
      for (const m of Array.from(t.matchAll(re))) {
        // A family member's name the given-name list may not know ("Spouse Harjit").
        const bare = m[1].split(/\s+/)[0];
        const name = personNamesIn(m[1])[0] ?? ((re === FAMILY_BEFORE || re === FAMILY_AFTER) && /^[A-Z][a-z]{2,}$/.test(bare) ? bare : null);
        if (!name) continue;
        const words = name.split(/\s+/).map(fold);
        if (!ownerGender && re === OWNER_BEFORE) ownerGender = genderOfGivenName(words[0]);
        ownerNames.add(words[0]);
      }
    }
  }
  const staffNames = new Set<string>();
  for (const [key, value] of entries) {
    if (key.startsWith("_") || !STAFF_KEY.test(key)) continue;
    for (const name of personNamesIn(textOf(value))) if (!ownerNames.has(fold(name.split(/\s+/)[0]))) staffNames.add(name);
  }
  // "Daniel" and "Daniel Okafor" are one person: keep the fuller name first.
  const names = Array.from(staffNames).sort((a, b) => b.length - a.length);
  return { ownerNames: Array.from(ownerNames), ownerGender, staffNames: names };
}

function isOwnerName(name: string, ctx: StaffContext): boolean {
  return ctx.ownerNames.includes(fold(name.split(/\s+/)[0]));
}

/** The staff member a text names (the fuller form the facts use), or null. */
function staffPersonIn(text: string, ctx: StaffContext): string | null {
  for (const name of personNamesIn(text)) {
    if (isOwnerName(name, ctx)) continue;
    const first = fold(name.split(/\s+/)[0]);
    const full = ctx.staffNames.find((s) => fold(s.split(/\s+/)[0]) === first && s.includes(" "));
    return full ?? name;
  }
  // A name the given-name list doesn't know, as a clause's subject ("Dana plans …", "Admin: Dana (since 2012 …").
  const lead = LEADING_NAME.exec(text);
  if (lead && !LEAD_STOP.test(lead[1]) && !isOwnerName(lead[1], ctx)) return lead[1];
  return null;
}

const LEADING_NAME = /^(?:[A-Z][a-z]+:\s*)?([A-Z][a-z]{2,})\b(?=\s*\((?:since|age|hired|\d)|\s+(?:plans|wants|asked|is|has|had|may|might|will|said|told|gave|received|was|would|could|hopes|intends|informally|privately|quietly|raised|floated|confided)\b)/;
const LEAD_STOP = /^(?:The|This|That|These|Those|Seller|Sellers|Owner|Owners|Staff|Buyer|Buyers|Management|Company|Business|Everyone|Nobody|Neither|Both|Each|Team|Employees|Customers|Revenue|It|He|She|They|We|There|Nothing|Someone|One|Another|Admin|Office|Service|Sales|Operations)$/;

/** The staff member named last before a position ("…; Farah Haddad: part-time; sounding out …" → Farah). */
function lastStaffPersonBefore(text: string, index: number, ctx: StaffContext): string | null {
  const before = index > 0 ? text.slice(0, index) : text;
  let found: string | null = null;
  for (const clause of clausesOf(before)) found = staffPersonIn(clause, ctx) ?? found;
  return found;
}

/** A staff member named in a fact's key ("danielEquityInterest" → "Daniel Okafor"). */
function staffPersonInKey(key: string, ctx: StaffContext): string | null {
  const k = fold(key);
  for (const s of ctx.staffNames) {
    const first = fold(s.split(/[\s-]+/)[0]);
    if (first.length >= 3 && k.startsWith(first)) return s;
  }
  return null;
}

interface Scope {
  /** The fact's key reads as a staff topic ("keyEmployees", "pharmacistRetention"). */
  staffKey: boolean;
  /** The surrounding text (the whole fact / paragraph) names a staff member. */
  staffAround: boolean;
  /**
   * The fact's key is the owner's own topic (reason for sale, the seller's
   * motivation, the transition, the deal): only an explicitly named staff
   * member makes a clause there a staff matter.
   */
  ownerKey?: boolean;
  /**
   * Precision first (routing a new fact to the private notes, where the
   * broker's Include switch can't reach it): the clause must name a known
   * staff member, a staff word or a job title, or go on from a clause that did.
   */
  strict?: boolean;
  /** The staff member the clause before this one (same fact) was about. */
  prevPerson?: string | null;
}

/** The owner's own topics — a first name there is the owner's until the facts say it is staff. */
const OWNER_TOPIC_KEY = /^(?:reasonForSale|reasonsForSale|saleReason|sellerMotivation|motivation|motivationForSale|sellerGoals|personalGoals|timeline|saleTimeline|exitTimeline|exitPlan|owner\w*|seller\w*|vendor\w*|founder\w*|proprietor\w*|transition\w*|retirement\w*|dealStructure|transactionStructure|financing\w*|askingPrice|ownership\w*|shareholder\w*|nonCompete\w*)$/i;

/**
 * A clause with no subject of its own — it goes on from the clause before
 * ("Daniel Okafor: LTC lead pharmacist since 2014; asked Helen about buying a
 * stake last year").
 */
const SUBJECTLESS = /^(?:(?:and|but|also|then|since|recently|once|later|last (?:year|month|week|spring|summer|fall|autumn|winter)|this (?:year|spring|summer|fall|autumn|winter)|(?:about |approximately |roughly |nearly |almost |over )?(?:a|an|one|two|three|\d+) (?:years?|months?|weeks?) ago|in (?:19|20)\d{2}),?\s+)*(?:has |had |have |was |is |also |once |recently |informally |privately |quietly |repeatedly |reportedly |even )*(?:asked|asks|asking|wants|wanted|would|raised|inquired|enquired|expressed|floated|mentioned|approached|told|hinted|may|might|could|plans|planned|planning|hopes|hoped|requested|pushed|complained|gave|handed|received|got|interested|keen|thinking|considering|looking|interviewing|seeking|sounding|angling|eyeing|confided|said|feels|thinks|believes|resents|is|was|has|had)\b/i;

const OUTSIDER = /\b(?:buyer|investor|lender|landlord|customer|client|competitor|acquirer|purchaser|supplier|vendor|bank)s?\b/i;

/** A staff member the clause names, as the scope allows (strict / the owner's topics: only people known as staff). */
function namedStaff(clause: string, ctx: StaffContext, scope: Scope): string | null {
  const person = staffPersonIn(clause, ctx);
  if (!person) return null;
  if (!scope.strict && !scope.ownerKey) return person;
  const first = fold(person.split(/[\s-]+/)[0]);
  if (ctx.staffNames.some((n) => fold(n.split(/[\s-]+/)[0]) === first)) return person;
  // A name in a staff fact when the owner is known (so it isn't the owner's).
  return !scope.ownerKey && scope.staffKey && ctx.ownerNames.length > 0 ? person : null;
}

/** "Two technicians", "one of our estimators", "both hygienists" — particular people, not the trade in general. */
const COUNTED = /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|several|a couple of|a few of|both|\d+)\s+(?:of\s+(?:our|the|his|her|their)\s+)?(?:[a-z-]+\s+)?[a-z-]+s\b/i;

/**
 * The clause's staff words only speak of staff in general ("technicians are
 * recruited by larger firms", "key employees may leave after a sale") — an
 * industry or deal risk, not one person's private matter.
 */
function onlyGenericStaff(clause: string, withRoles: boolean): boolean {
  const words: string[] = [];
  const all = (re: RegExp) => Array.from(clause.matchAll(new RegExp(re.source, "gi"))).map((m) => ({ w: m[0], at: m.index ?? 0 }));
  for (const { w, at } of [...all(STAFF_STRONG), ...(withRoles ? all(STAFF_ROLE) : [])]) {
    // "a staff member" is one person.
    if (/^staff$/i.test(w) && /^\s+member\b/i.test(clause.slice(at + w.length))) return false;
    words.push(w);
  }
  if (words.length === 0) return false;
  const plural = (w: string) => /(?:s|foremen|staff|people|personnel|workforce)$/i.test(w) && !/^(?:gm|sales ?reps?)$/i.test(w);
  if (!words.every(plural)) return false;
  return !COUNTED.test(clause) && !/\b(?:he|she|him|her|his|hers)\b/i.test(clause);
}

/** Is the clause about a staff member (not the owner, not a buyer)? */
function aboutStaff(clause: string, ctx: StaffContext, scope: Scope): boolean {
  if (namedStaff(clause, ctx, scope)) return true;
  const ownerNamed = OWNER_WORD.test(clause) || personNamesIn(clause).some((n) => isOwnerName(n, ctx));
  if (onlyGenericStaff(clause, !ownerNamed)) return false;
  if (STAFF_STRONG.test(clause)) return true;
  if (STAFF_ROLE.test(clause) && !ownerNamed) return true;
  if (scope.ownerKey) return false;
  // No subject: it goes on from a staff member named just before — the owner
  // may be the one asked ("…; asked the owner about an equity stake").
  const trimmed = clause.trim();
  if (scope.prevPerson && SUBJECTLESS.test(trimmed) && !OUTSIDER.test(trimmed.split(/\s+/).slice(0, 3).join(" "))) return true;
  if (scope.strict) {
    // A pronoun right after a staff member ("Daniel …. He asked about buying in.").
    if (!scope.prevPerson) return false;
    for (const m of Array.from(clause.matchAll(PRONOUN))) {
      const g = /^(?:he|him|his)$/i.test(m[1]) ? "m" : "f";
      if (ownerNamed && ctx.ownerGender === g) continue;
      return true;
    }
    return false;
  }
  if (!(scope.staffKey || scope.staffAround)) return false;
  // A pronoun in a staff context — unless it is the owner's own ("she" for Helen).
  for (const m of Array.from(clause.matchAll(PRONOUN))) {
    const g = /^(?:he|him|his)$/i.test(m[1]) ? "m" : "f";
    if (ownerNamed && ctx.ownerGender === g) continue;
    if (!ownerNamed && ctx.ownerGender === g && !scope.staffAround) continue;
    return true;
  }
  // No subject at all ("Asked about equity stake …") in a staff fact or next to a staff member's name.
  return personNamesIn(clause).length === 0 && !ownerNamed && !OUTSIDER.test(clause);
}

/** A fact whose key itself names the private matter ("danielEquityInterest"). */
const PRIVATE_KEY = /(?:equity|stake|buy ?in|ownership|partner(?:ship)?) (?:interest|request|ask|ambitions?|conversations?|talks?|wish)|raise request|pay (?:dispute|request|complaint)|resignation|departure (?:risk|rumou?r|talk)|flight risk|disciplin|performance (?:issue|problem|concern)|maternity|paternity|personal (?:matter|circumstance)/;

function keyWords(key: string): string {
  return key
    .replace(/^[cl]:/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .toLowerCase();
}

// ── Screening ─────────────────────────────────────────────────────────────

/** Stable id of held words: the include switch is keyed by it (same words → same id, anywhere). */
export function staffPrivateId(text: string): string {
  const norm = text.toLowerCase().replace(/[^a-z0-9%$]+/g, " ").trim();
  let h = 0x811c9dc5;
  for (let i = 0; i < norm.length; i++) {
    h ^= norm.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  let h2 = 0x12345678;
  for (let i = norm.length - 1; i >= 0; i--) {
    h2 ^= norm.charCodeAt(i);
    h2 = Math.imul(h2, 0x5bd1e995) >>> 0;
  }
  return `sp${h.toString(36)}${(h2 % 1296).toString(36)}`;
}

/** Sentences and "; " parts of a fact. */
function clausesOf(text: string): string[] {
  return text.split(/(?<=[.!?])\s+(?=[A-Z0-9])|\s*;\s*|\n+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Comma (and spaced-dash) parts outside parentheses, each with where it
 * starts in the sentence — a cut keeps the sentence's own words and
 * separators ("Daniel Okafor - LTC lead pharmacist - 11 years - …").
 */
function commaParts(sentence: string): Array<{ text: string; start: number }> {
  const out: Array<{ text: string; start: number }> = [];
  let depth = 0;
  let start = 0;
  const push = (end: number) => {
    const raw = sentence.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    if (raw.trim()) out.push({ text: raw.trim(), start: start + lead });
  };
  for (let i = 0; i < sentence.length; i++) {
    const ch = sentence[i];
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (depth !== 0) continue;
    const comma = ch === "," && sentence[i + 1] === " ";
    // " — ", " – ", and " - " between words (not "2014 - 2020").
    const dash = ch === " " && (/^ [—–] /.test(sentence.slice(i, i + 3)) || (/^ - \D/.test(sentence.slice(i, i + 4)) && !/\d$/.test(sentence.slice(0, i))));
    if (comma || dash) {
      push(i);
      i += comma ? 1 : 2;
      start = i + 1;
    }
  }
  push(sentence.length);
  return out;
}

/** A private-looking part of a sentence the AI review flagged as a whole (where to cut it). */
const STAFF_HINT = /\b(?:equity|stakes?|buy(?:ing)?[- ]?in|share of|part of the|piece of|partner|roll-?over|earn-?in|raise|pay|salary|underpaid|bonus|leav(?:e|ing)|quit|resign|notice|recruit|poach|headhunt|elsewhere|other (?:jobs?|roles?)|warning|probation|perform\w*|disciplin\w*|late|sick|ill\b|illness|health|hospital|surgery|family|divorce|pregnan\w*|maternity|paternity|burn(?:ed|t)?[- ]?out|privately|confided|informally|in confidence|jok\w*)\b/i;

/**
 * A clause with the private comma-parts of its parentheses removed (an
 * emptied parenthesis goes too), or null when no parenthesis holds one.
 */
function cutInParentheses(clause: string, isPrivate: (part: string) => boolean): { kept: string; cut: string[] } | null {
  const cut: string[] = [];
  const kept = clause.replace(/\(([^()]*)\)/g, (whole, inner: string) => {
    const parts = inner.split(/,\s+/);
    const keep = parts.filter((p) => !isPrivate(p));
    if (keep.length === parts.length) return whole;
    cut.push(...parts.filter((p) => isPrivate(p)).map((p) => p.trim()));
    return keep.length > 0 ? `(${keep.join(", ")})` : "";
  });
  if (cut.length === 0) return null;
  return { kept: kept.replace(/\s+([,.;])/g, "$1").replace(/\s{2,}/g, " ").trim(), cut };
}

export interface HeldPiece {
  text: string;
  kind: StaffPrivateKind;
  /** "ai" = held only because the AI review flagged it; "rules" = the deterministic screen. */
  by?: "rules" | "ai";
}

const normText = (t: string) => t.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim().replace(/[.;,]+$/, "");

/**
 * One fact value (or free-text paragraph) screened: the kept text (null
 * when nothing is left) and the held pieces. A sentence is cut at its commas
 * when the private part trails ("… knows all resident med lists, approximately
 * 1 year ago informally asked about buying equity stake"); otherwise the
 * sentence goes whole. A sentence that answers a held one ("Helen declined
 * but kept door open") goes with it, and so does an equity follow-up.
 */
export function splitStaffPrivate(
  text: string,
  ctx: StaffContext,
  opts: {
    key?: string;
    included?: ReadonlySet<string>;
    extraHeld?: ReadonlyArray<{ text: string; kind?: StaffPrivateKind }>;
    /** Precision first (upstream routing): see Scope.strict. */
    strict?: boolean;
  } = {},
): { kept: string | null; held: HeldPiece[]; changed: boolean } {
  const included = opts.included ?? new Set<string>();
  const bareKey = (opts.key ?? "").replace(/^[cl]:/, "");
  const staffKey = !!bareKey && STAFF_KEY.test(bareKey);
  const ownerKey = !!bareKey && OWNER_TOPIC_KEY.test(bareKey);
  const staffAround = STAFF_STRONG.test(text) || !!staffPersonIn(text, ctx) || ctx.staffNames.some((n) => text.includes(n));
  const clauses = clausesOf(text);
  const held: HeldPiece[] = [];
  const kept: string[] = [];
  let prevHeld: { kind: StaffPrivateKind; by: "rules" | "ai" } | null = null;
  let prevPerson: string | null = null;
  const ai = (opts.extraHeld ?? []).map((x) => ({ t: normText(x.text), kind: x.kind })).filter((x) => x.t.length >= 8);
  /** The AI review flagged this clause (the clause is what it flagged, or holds it). */
  const aiClause = (c: string): StaffPrivateKind | null => {
    const l = normText(c);
    for (const x of ai) {
      if (l.includes(x.t) || (x.t.includes(l) && l.length * 2 >= x.t.length)) return x.kind ?? staffPrivateTopic(c) ?? "conversation";
    }
    return null;
  };
  /** The AI review flagged exactly this part, or something inside it (never a wider sentence). */
  const aiPart = (p: string): boolean => {
    const l = normText(p);
    return ai.some((x) => l.includes(x.t));
  };
  // The held words, unless the broker included them; the id is always of the words listed.
  const hold = (words: string, kind: StaffPrivateKind, by: "rules" | "ai"): boolean => {
    const text = words.replace(/[.;,]+$/, "").trim().replace(/^(?:and|but|or|also|while|though|although)\s+/i, "");
    if (included.has(staffPrivateId(text))) return false;
    held.push({ text, kind, by });
    return true;
  };
  for (const clause of clauses) {
    const scope: Scope = { staffKey, staffAround, ownerKey, strict: !!opts.strict, prevPerson };
    // Whom this clause is about, for the next one ("…; asked Helen about a stake").
    const subject = staffPersonIn(clause, ctx);
    const ownerSubject = !subject && (OWNER_WORD.test(clause.split(/\s+/).slice(0, 2).join(" ")) || personNamesIn(clause.split(/\s+/).slice(0, 2).join(" ")).some((n) => isOwnerName(n, ctx)));
    const nextPerson: string | null = subject ?? (ownerSubject ? null : prevPerson);

    const topic = staffPrivateTopic(clause, text);
    let kind: StaffPrivateKind | null = topic && aboutStaff(clause, ctx, scope) ? topic : null;
    let by: "rules" | "ai" = "rules";
    if (!kind) {
      const k = aiClause(clause);
      if (k) { kind = k; by = "ai"; }
    }
    if (!kind && prevHeld && (BACKREF.test(clause) || (prevHeld.kind === "equity" && EQUITY_WORD.test(clause) && !OWNER_EQUITY.test(clause) && !SETTLED.test(clause)))) {
      kind = prevHeld.kind;
      by = prevHeld.by;
    }
    prevPerson = nextPerson;
    if (!kind) {
      kept.push(clause);
      prevHeld = null;
      continue;
    }
    prevHeld = { kind, by };
    const privatePart = (p: string) => !!staffPrivateTopic(p, text) || aiPart(p);
    // The private part inside a parenthesis ("Admin: Dana (since 2012, age 58,
    // may leave next year, knows all insurer reps)"): only that part goes.
    const inParen = cutInParentheses(clause, (p) => privatePart(p) && !included.has(staffPrivateId(p.trim().replace(/[.;,]+$/, ""))));
    if (inParen && !staffPrivateTopic(inParen.kept, text)) {
      for (const c of inParen.cut) hold(c, kind, by);
      kept.push(inParen.kept);
      continue;
    }
    // Cut only a trailing private part: the sentence's head stays when it is
    // clean. The rules (or a part the AI flagged exactly) say where; for a
    // sentence only the AI flagged as a whole, the first part that reads as
    // the private matter.
    const parts = commaParts(clause);
    let cut = -1;
    for (let i = 1; i < parts.length && cut < 0; i++) if (privatePart(parts[i].text)) cut = i;
    if (cut < 0 && by === "ai") for (let i = 1; i < parts.length && cut < 0; i++) if (STAFF_HINT.test(parts[i].text)) cut = i;
    if (cut > 0) {
      const head = clause.slice(0, parts[cut].start).replace(/[\s,:;–—-]+$/, "").trim();
      const tail = clause.slice(parts[cut].start);
      if (head.split(/\s+/).length >= 3 && !staffPrivateTopic(head, text) && !(by === "ai" && aiPart(head))) {
        if (hold(tail, kind, by)) kept.push(/[.!?]$/.test(clause) ? `${head}.` : head);
        else kept.push(clause);
        continue;
      }
    }
    if (!hold(clause, kind, by)) kept.push(clause);
  }
  if (held.length === 0) return { kept: text, held, changed: false };
  // Sentences stay sentences; "; " parts stay parts.
  let joined = "";
  for (const s of kept.map((x) => x.replace(/[;,\s]+$/, "")).filter(Boolean)) joined = joined ? `${joined}${/[.!?]$/.test(joined) ? " " : "; "}${s}` : s;
  joined = joined.trim();
  return { kept: joined || null, held, changed: true };
}

export interface StaffScreenOptions {
  ctx: StaffContext;
  /** Ids the broker switched back in (STAFF_PRIVATE_INCLUDED_KEY). */
  included?: ReadonlySet<string>;
  /** Clauses the AI review found (keep-out.ts), held the same way. */
  aiClauses?: ReadonlyArray<{ text: string; kind?: StaffPrivateKind }>;
  /** Precision first — upstream routing, where no Include switch can reach a wrong hold (Scope.strict). */
  strict?: boolean;
}

/** Walk a fact value (string, list or map). */
function screenValue(value: unknown, key: string, opts: StaffScreenOptions, held: HeldPiece[]): { value: unknown; dropped: boolean; changed: boolean } {
  if (typeof value === "string") {
    const r = splitStaffPrivate(value, opts.ctx, { key, included: opts.included, extraHeld: opts.aiClauses, strict: opts.strict });
    held.push(...r.held);
    return r.kept === null ? { value: null, dropped: true, changed: true } : { value: r.kept, dropped: false, changed: r.changed };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out: unknown[] = [];
    for (const v of value) {
      const r = screenValue(v, key, opts, held);
      changed ||= r.changed;
      if (!r.dropped) out.push(r.value);
    }
    return { value: out, dropped: out.length === 0 && value.length > 0, changed };
  }
  if (value && typeof value === "object") {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const r = screenValue(v, key, opts, held);
      changed ||= r.changed;
      if (!r.dropped) out[k] = r.value;
    }
    return { value: out, dropped: Object.keys(out).length === 0, changed };
  }
  return { value, dropped: false, changed: false };
}

/**
 * Screen fact pairs for a CIM input: staff-private clauses held (unless the
 * broker included them), a fact whose key itself names the matter held
 * whole. Returns the safe pairs and every held item (for the broker).
 */
export function screenStaffPrivatePairs(
  pairs: Array<[string, unknown]>,
  opts: StaffScreenOptions,
): { safe: Array<[string, unknown]>; items: StaffPrivateItem[] } {
  const safe: Array<[string, unknown]> = [];
  const items: StaffPrivateItem[] = [];
  const push = (key: string, piece: HeldPiece, whole?: string) => {
    const bareKey = key.replace(/^[cl]:/, "");
    const text = piece.text;
    // Whom it is about: the held words, else the sentence they came from, else the fact's label.
    const host = whole ? clausesOf(whole).find((c) => c.includes(text.slice(0, 40))) : undefined;
    const at = whole ? whole.indexOf(text.slice(0, 40)) : -1;
    const before = whole && at > 0 ? lastStaffPersonBefore(whole, at, opts.ctx) : null;
    // Held words with no subject of their own ("has asked Tom about buying
    // in") are about whoever the fact named before them, not the person asked.
    const person = SUBJECTLESS.test(text.trim())
      ? before ?? staffPersonInKey(bareKey, opts.ctx) ?? staffPersonIn(text, opts.ctx)
      : staffPersonIn(text, opts.ctx) ??
        (host ? staffPersonIn(host, opts.ctx) : null) ??
        staffPersonInKey(bareKey, opts.ctx) ??
        before;
    const id = staffPrivateId(text);
    if (items.some((i) => i.id === id && i.key === bareKey)) return;
    items.push({ id, key: bareKey, kind: piece.kind, text, description: describeStaffPrivate(piece.kind, person), person, by: piece.by ?? "rules" });
  };
  for (const [key, value] of pairs) {
    const held: HeldPiece[] = [];
    const r = screenValue(value, key, opts, held);
    // The key itself says it ("Daniel Equity Interest"): nothing of it may
    // reach the writer under that label — the whole fact is the item.
    if (held.length > 0 && PRIVATE_KEY.test(keyWords(key))) {
      const whole = textOf(value).replace(/\s+/g, " ").trim();
      const piece: HeldPiece = { text: whole, kind: held[0].kind, by: held.every((h) => h.by === "ai") ? "ai" : "rules" };
      if (opts.included?.has(staffPrivateId(whole))) {
        safe.push([key, value]);
        continue;
      }
      push(key, piece, whole);
      continue;
    }
    for (const h of held) push(key, h, textOf(value));
    if (!r.changed) safe.push([key, value]);
    else if (!r.dropped) safe.push([key, r.value]);
  }
  return { safe, items };
}

/**
 * Free text the writer reads (earlier drafts, the scrape, the resolved
 * block): staff-private sentences removed, paragraph by paragraph.
 */
export function screenStaffPrivateText(text: string, ctx: StaffContext, included?: ReadonlySet<string>): { text: string; held: HeldPiece[] } {
  if (!text) return { text, held: [] };
  const held: HeldPiece[] = [];
  const paras = text.split(/\n{2,}/).map((para) => {
    const r = splitStaffPrivate(para, ctx, { included });
    held.push(...r.held);
    return r.kept ?? "";
  });
  if (held.length === 0) return { text, held };
  return { text: paras.filter((p) => p.trim()).join("\n\n"), held };
}

/** The broker's include decisions on a deal's facts. */
export function includedStaffPrivate(info: Record<string, unknown> | null | undefined): Set<string> {
  const raw = info?.[STAFF_PRIVATE_INCLUDED_KEY];
  return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []);
}

/** The broker's warning for held items. */
export function staffPrivateWarning(items: ReadonlyArray<Pick<StaffPrivateItem, "description">>): string | null {
  const unique = Array.from(new Set(items.map((i) => i.description)));
  if (unique.length === 0) return null;
  return `Held back from the CIM: ${unique.join("; ")}. Private staff matters stay out of every version by default — to include one, switch it on under "Held back from the CIM" on the CIM tab, then regenerate.`;
}

// ── Upstream: where a new disclosure is recorded ──────────────────────────

/** The reason on a private note this routing writes. */
export const STAFF_PRIVATE_NOTE_REASON = "a private staff matter — for the broker, kept out of the CIM";

/**
 * A value about to become a fact (an interview turn, a document's
 * extraction), split: the business part stays the fact ("Daniel Okafor: LTC
 * lead pharmacist since 2014, primary contact for the homes") and each
 * staff-private part becomes a broker-private note naming whom it is about
 * ("Daniel Okafor — approximately 1 year ago informally asked about buying
 * equity stake"). `kept` is null when nothing business-like is left.
 */
export function routeStaffPrivate(key: string, value: string, ctx: StaffContext): { kept: string | null; notes: string[] } {
  // Strict: a wrong hold here moves a business fact out of the facts, where
  // the broker's Include switch can't reach it (the CIM screen, which the
  // broker can overrule, still reads everything that stays).
  const { safe, items } = screenStaffPrivatePairs([[key, value]], { ctx, strict: true });
  if (items.length === 0) return { kept: value, notes: [] };
  const kept = safe.length > 0 && typeof safe[0][1] === "string" ? (safe[0][1] as string) : null;
  const notes = items.map((i) => {
    const first = i.person?.split(/\s+/)[0];
    return i.person && first && !i.text.includes(first) ? `${i.person} — ${i.text}` : i.text;
  });
  return { kept, notes };
}

/**
 * The interview turn's guard (session-manager): each string fact the turn
 * would record is routed — the business part stays the change, each
 * staff-private part becomes a broker-private note. The deal's people come
 * from the facts on file plus this turn's. `droppedKeys` = changes with
 * nothing business-like left (not recorded at all). Pure.
 */
export function routeStaffPrivateChanges<C extends { fieldName: string; newValue: unknown }>(
  changes: ReadonlyArray<C>,
  existing: Record<string, unknown> | null | undefined,
): { changes: C[]; notes: Array<{ note: string; reason: string }>; routedKeys: string[]; droppedKeys: string[] } {
  const ctx = staffContextFrom({ ...(existing ?? {}), ...Object.fromEntries(changes.map((c) => [c.fieldName, c.newValue])) });
  const out: C[] = [];
  const notes: Array<{ note: string; reason: string }> = [];
  const routedKeys: string[] = [];
  const droppedKeys: string[] = [];
  for (const c of changes) {
    if (typeof c.newValue !== "string" || c.fieldName.startsWith("_")) {
      out.push(c);
      continue;
    }
    const r = routeStaffPrivate(c.fieldName, c.newValue, ctx);
    if (r.notes.length === 0) {
      out.push(c);
      continue;
    }
    routedKeys.push(c.fieldName);
    for (const note of r.notes) notes.push({ note, reason: STAFF_PRIVATE_NOTE_REASON });
    if (r.kept) out.push({ ...c, newValue: r.kept });
    else droppedKeys.push(c.fieldName);
  }
  return { changes: out, notes, routedKeys, droppedKeys };
}
