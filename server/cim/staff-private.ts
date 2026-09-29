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
  String.raw`\b(?:equity(?!\s+(?:line|loan|financing|investors?|firms?|funds?|groups?|sponsors?|method|accounting|section|statement))|stakes?\b|shareholding|ownership(?!\s+(?:change|transfer|structure|notification|approval|restrictions?|rules?|requirements?|of the (?:building|property|premises)))|buy(?:ing)?[- ]in\b|buy(?:ing)? (?:into|in)\b|piece of the (?:business|company|pharmacy|practice|clinic|shop|firm|action)|(?:become|becoming|make (?:him|her|them)|made (?:him|her|them))\s+(?:a\s+)?(?:partner|shareholder|co-?owner)|partnership (?:stake|interest|track)|roll-?over|earn-?ins?\b|phantom (?:equity|shares?)|(?:share|stock) options?|(?:some|a few) shares)`,
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
    String.raw`\b(?:ask(?:ed|s|ing)?|push(?:ed|ing)?|press(?:ed|ing)?|want(?:s|ed)?|request(?:ed|s|ing)?|demand(?:ed|s|ing)?|hint(?:ed|ing)?|lobb(?:y|ied|ying)|negotiat\w*|angling)\s+(?:for\s+|about\s+)?(?:\w+\s+){0,3}(?:raise|pay (?:rise|increase|bump)|salary (?:increase|bump|review)|more money|higher (?:pay|salary|wages?)|bigger bonus|a bonus|more pay|wage increase)\b`,
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
const DEPARTURE_RE = new RegExp(
  [
    String.raw`\b${MAYBE}\b[^.;]{0,40}?\b${LEAVE}\b`,
    String.raw`\b${PLANS}\b[^.;]{0,20}?\b${LEAVE_JOB}\b`,
    String.raw`\b(?:may|might|would|could) not stay\b|\bwon'?t stay\b|\bnot going to stay\b|\bunlikely to stay\b`,
    String.raw`\bflight risk\b|\bpoach(?:ed|ing)?\b|\bbeing recruited\b|\brecruited by\b|\bapproached by (?:a |another )?(?:competitor|recruiter|headhunter|rival)`,
    String.raw`\blooking (?:for|at) (?:another|other|a new) (?:job|role|position|opportunit\w+)\b|\binterview(?:ing|ed) (?:elsewhere|with (?:a |another )?(?:competitor|rival))`,
    String.raw`\b(?:gave|given|giving|handed in|tendered|submitted) (?:his |her |their )?(?:notice|resignation)\b|\bhas resigned\b|\bis leaving\b|\bwill be leaving\b|\blast day\b`,
  ].join("|"),
  "i",
);
/** A departure statement that is really about staying ("unlikely to leave", "no departure signals"). */
const STAYING = /\b(?:no|not|never|neither|unlikely|nor|none|without|n't)\b[^.;]{0,40}\b(?:leav|quit|resign|depart|retir|move on|go elsewhere|signals?|signs?|risk|plans?)|\b(?:committed to|will|wants? to|plans? to|intends? to|expected to|expects to|agreed to) (?:stay|remain|continue)\b/i;

const CONDUCT_RE = new RegExp(
  String.raw`\b(?:performance (?:issues?|problems?|concerns?|improvement plan|warnings?|management|reviews? (?:flagged|noted))|under-?perform\w*|poor(?:ly)? perform\w*|\bPIP\b|(?:written|verbal|final|formal) warning|disciplin(?:ed|ary (?:action|matter|issue|hearing|meeting|record|process|letter|note))|reprimand\w*|(?:was |been |got |is )suspended|(?:put )?on probation|(?:was |got |been )?(?:fired|terminated|let go|dismissed) (?:for|over|because)|(?:drinking|alcohol|drug|substance) (?:problem|issue|abuse)|attendance (?:issues?|problems?)|(?:chronically|always|often|habitually) late|no-?shows?|harass(?:ed|ing|ment)|misconduct|insubordinat\w*|complaints? (?:about|against) (?:him|her|them)|attitude (?:problem|issues?)|clash(?:es|ed)? with|(?:doesn'?t|does not|don'?t) get along)\b`,
  "i",
);

const PERSONAL_RE = new RegExp(
  String.raw`\b(?:(?:maternity|paternity|parental) leave(?!\s+(?:top-?up|polic(?:y|ies)|benefits?|coverage|program|plan))|pregnan(?:t|cy)|on (?:medical|sick|stress|disability|compassionate|bereavement|personal) leave|(?:medical|sick|stress|disability|compassionate|bereavement) leave (?:since|until|for)|family (?:emergency|issues|problems|matters|situation|circumstances|reasons|troubles)|caring for (?:his|her|their) (?:sick|ill|elderly|ageing|aging|dying|disabled) \w+|(?:his|her|their) (?:kids?|children|son|daughter|wife|husband|spouse|partner|mother|father|mom|mum|dad|parents?) (?:is |are |was |were |has been |have been )?(?:sick|ill|in hospital|unwell|dying|struggling)|mental health|burn(?:ed|t)?[- ]?out|(?:in|into|to|entered|out of|left|checked into) rehab\b|(?:going|went|is going) through a (?:divorce|separation|tough time|rough patch|hard time))\b`,
  "i",
);

const CONVERSATION_RE = /\b(?:privately|in private|confided|in confidence|off the record|behind closed doors|informally (?:asked|told|mentioned|raised|said|approached|floated|inquired|enquired)|half[- ]?jok\w*|jokingly|over (?:a )?(?:beers?|drinks|coffee|lunch)|quietly (?:asked|told|mentioned|raised)|(?:one-on-one|personal|private) conversation)\b/i;

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
export function staffPrivateTopic(clause: string): StaffPrivateKind | null {
  const t = clause.replace(/[’‘]/g, "'");
  if (!t.trim() || SETTLED.test(t)) return null;
  if (EQUITY_WORD.test(t) && matchNotNegated(WANTS, t) && !OWNER_EQUITY.test(t)) return "equity";
  if (matchNotNegated(PAY_RE, t)) return "pay";
  if (DEPARTURE_RE.test(t) && !STAYING.test(t)) return "departure";
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
}

/** Is the clause about a staff member (not the owner, not a buyer)? */
function aboutStaff(clause: string, ctx: StaffContext, scope: Scope): boolean {
  if (STAFF_STRONG.test(clause)) return true;
  if (staffPersonIn(clause, ctx)) return true;
  const ownerNamed = OWNER_WORD.test(clause) || personNamesIn(clause).some((n) => isOwnerName(n, ctx));
  if (STAFF_ROLE.test(clause) && !ownerNamed) return true;
  if (!(scope.staffKey || scope.staffAround)) return false;
  // A pronoun in a staff context — unless it is the owner's own ("she" for Helen).
  for (const m of Array.from(clause.matchAll(PRONOUN))) {
    const g = /^(?:he|him|his)$/i.test(m[1]) ? "m" : "f";
    if (ownerNamed && ctx.ownerGender === g) continue;
    if (!ownerNamed && ctx.ownerGender === g && !scope.staffAround) continue;
    return true;
  }
  // No subject at all ("Asked about equity stake …") in a staff fact or next to a staff member's name.
  return personNamesIn(clause).length === 0 && !ownerNamed && !/\b(?:buyer|investor|lender|landlord|customer|client|competitor|acquirer|purchaser)s?\b/i.test(clause);
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

/** Comma parts outside parentheses. */
function commaParts(sentence: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < sentence.length; i++) {
    const ch = sentence[i];
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && ((ch === "," && sentence[i + 1] === " ") || (ch === " " && /^ [—–] /.test(sentence.slice(i, i + 3))))) {
      out.push(cur);
      cur = "";
      i += ch === "," ? 1 : 2;
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((p) => p.trim()).filter(Boolean);
}

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
}

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
  opts: { key?: string; included?: ReadonlySet<string>; extraHeld?: ReadonlyArray<{ text: string; kind?: StaffPrivateKind }> } = {},
): { kept: string | null; held: HeldPiece[]; changed: boolean } {
  const included = opts.included ?? new Set<string>();
  const staffKey = !!opts.key && STAFF_KEY.test(opts.key.replace(/^[cl]:/, ""));
  const staffAround = STAFF_STRONG.test(text) || !!staffPersonIn(text, ctx) || ctx.staffNames.some((n) => text.includes(n));
  const scope: Scope = { staffKey, staffAround };
  const clauses = clausesOf(text);
  const held: HeldPiece[] = [];
  const kept: string[] = [];
  let prevHeld: StaffPrivateKind | null = null;
  const extra = (c: string): StaffPrivateKind | null => {
    const l = c.toLowerCase().replace(/\s+/g, " ").trim();
    for (const x of opts.extraHeld ?? []) {
      const t = x.text.toLowerCase().replace(/\s+/g, " ").trim().replace(/[.;]+$/, "");
      if (t.length >= 8 && (l.includes(t) || t.includes(l.replace(/[.;]+$/, "")))) return x.kind ?? staffPrivateTopic(c) ?? "conversation";
    }
    return null;
  };
  for (const clause of clauses) {
    const topic = staffPrivateTopic(clause);
    let kind: StaffPrivateKind | null = topic && aboutStaff(clause, ctx, scope) ? topic : null;
    kind ??= extra(clause);
    if (!kind && prevHeld && (BACKREF.test(clause) || (prevHeld === "equity" && EQUITY_WORD.test(clause) && !OWNER_EQUITY.test(clause) && !SETTLED.test(clause)))) kind = prevHeld;
    if (!kind) {
      kept.push(clause);
      prevHeld = null;
      continue;
    }
    prevHeld = kind;
    // The private part inside a parenthesis ("Admin: Dana (since 2012, age 58,
    // may leave next year, knows all insurer reps)"): only that part goes.
    const inParen = cutInParentheses(clause, (p) => !!(staffPrivateTopic(p) || extra(p)) && !included.has(staffPrivateId(p.trim())));
    if (inParen && !staffPrivateTopic(inParen.kept)) {
      for (const c of inParen.cut) held.push({ text: c, kind });
      kept.push(inParen.kept);
      continue;
    }
    // Cut only a trailing private part: the sentence's head stays when it is clean.
    const parts = commaParts(clause);
    let cut = -1;
    if (parts.length > 1) {
      for (let i = 1; i < parts.length; i++) {
        if (staffPrivateTopic(parts[i]) || extra(parts[i])) { cut = i; break; }
      }
    }
    if (cut > 0) {
      const head = parts.slice(0, cut).join(", ").replace(/[,:–—-]+$/, "").trim();
      const tail = parts.slice(cut).join(", ").replace(/[.;]+$/, "").trim();
      if (head.split(/\s+/).length >= 3 && !staffPrivateTopic(head)) {
        if (included.has(staffPrivateId(tail))) kept.push(clause);
        else {
          held.push({ text: tail.replace(/^(?:and|but|or|also)\s+/i, ""), kind });
          kept.push(/[.!?]$/.test(clause) ? `${head}.` : head);
        }
        continue;
      }
    }
    const whole = clause.replace(/[.;]+$/, "").trim();
    if (included.has(staffPrivateId(whole))) kept.push(clause);
    else held.push({ text: whole, kind });
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
}

/** Walk a fact value (string, list or map). */
function screenValue(value: unknown, key: string, opts: StaffScreenOptions, held: HeldPiece[]): { value: unknown; dropped: boolean; changed: boolean } {
  if (typeof value === "string") {
    const r = splitStaffPrivate(value, opts.ctx, { key, included: opts.included, extraHeld: opts.aiClauses });
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
  const norm = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim().replace(/[.;]+$/, "");
  const aiTexts = new Set((opts.aiClauses ?? []).map((c) => norm(c.text)));
  const push = (key: string, piece: HeldPiece, whole?: string) => {
    const bareKey = key.replace(/^[cl]:/, "");
    const text = piece.text;
    // Whom it is about: the held words, else the sentence they came from, else the fact's label.
    const host = whole ? clausesOf(whole).find((c) => c.includes(text.slice(0, 40))) : undefined;
    const person =
      staffPersonIn(text, opts.ctx) ??
      (host ? staffPersonIn(host, opts.ctx) : null) ??
      staffPersonInKey(bareKey, opts.ctx) ??
      (whole ? lastStaffPersonBefore(whole, whole.indexOf(text.slice(0, 40)), opts.ctx) : null);
    const id = staffPrivateId(text);
    if (items.some((i) => i.id === id && i.key === bareKey)) return;
    const byAi = aiTexts.has(norm(text)) && !staffPrivateTopic(text);
    items.push({ id, key: bareKey, kind: piece.kind, text, description: describeStaffPrivate(piece.kind, person), person, by: byAi ? "ai" : "rules" });
  };
  for (const [key, value] of pairs) {
    const held: HeldPiece[] = [];
    const r = screenValue(value, key, opts, held);
    // The key itself says it ("Daniel Equity Interest"): nothing of it may
    // reach the writer under that label — the whole fact is the item.
    if (held.length > 0 && PRIVATE_KEY.test(keyWords(key))) {
      const whole = textOf(value).replace(/\s+/g, " ").trim();
      const piece = { text: whole, kind: held[0].kind };
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
  const { safe, items } = screenStaffPrivatePairs([[key, value]], { ctx });
  if (items.length === 0) return { kept: value, notes: [] };
  const kept = safe.length > 0 && typeof safe[0][1] === "string" ? (safe[0][1] as string) : null;
  const notes = items.map((i) => {
    const first = i.person?.split(/\s+/)[0];
    return i.person && first && !i.text.includes(first) ? `${i.person} — ${i.text}` : i.text;
  });
  return { kept, notes };
}
