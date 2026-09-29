/**
 * owner-pay-attribution — whose pay is on an owner-compensation line.
 *
 * Pacific (rebuild, 2026-09-28): the statements carry ONE line for all the
 * shareholders' pay ("Management salaries — shareholders" $522,000 = Harjit
 * $285K + Manpreet $175K + Surinder $62K). The analysis labelled that line
 * "Owner compensation — Harjit Grewal" and the owner-pay split took all of it
 * as his pay: a $402,000 add-back where the broker's is $165,000 ($285K less a
 * $120K market salary). It also counted Surinder twice (she has her own
 * add-back) and added back Manpreet's pay, though he stays on as VP
 * Operations.
 *
 * This module reads, from the deal's own material (documents, emails,
 * transcripts, facts and their other values), what each named person is
 * paid and whether they stay or leave after the sale. The rules that use it
 * live in normalization-rules.ts (applyAddbackRules):
 *  - an owner line whose pay is more than the named person's stated pay is
 *    cut to that person's pay, for the years it is stated;
 *  - an owner line that is a several-people statement line with no stated
 *    pay for the person is left for the broker to split (not added back);
 *  - a relative's pay is added back only when the facts say they don't work
 *    in the business, or are paid above market — not for one who stays.
 *
 * Pure: no database, no AI.
 */

export interface PayStatement {
  value: number;
  /** The year the words tie it to, when they name one. */
  year: string | null;
  /** Only the broker's private material states it. */
  private: boolean;
  /** The words it came from (for the broker note). */
  text: string;
}

export interface PersonPay {
  /** First name as written ("Harjit"). */
  name: string;
  pay: PayStatement[];
  /** The material says they stay on after the sale / leave at the sale. */
  stays: boolean;
  leaves: boolean;
  /**
   * The material says their pay is for no real work, above market, or ends
   * at the sale with nobody replacing them ("no operational role since
   * 2019", "income-splitting", "comes off at close") — the only grounds on
   * which a relative's pay is an add-back.
   */
  noRealCost: boolean;
}

export interface PayRoster {
  /** Keyed by first name, lower-case. */
  people: Map<string, PersonPay>;
}

export const EMPTY_ROSTER: PayRoster = { people: new Map() };

const MONEY = String.raw`\$\s?\d[\d,]*(?:\.\d+)?\s?(?:k|m|million|thousand)?\b`;
const PAY_WORD = String.raw`(?:salary|salaries|wages?|pay|paid|compensation|comp|remuneration|t4|takes|earns|draws|makes)`;
/** Words that make a figure something other than the person's pay ("$120K to replace him", "market salary"). */
const NOT_PAY_BETWEEN = /\b(?:replace\w*|market|assum\w*|above|below|over|instead|would|could|buyer|estimate\w*|budget\w*|target|raise|increase|bonus|dividend\w*|draws?\s+of\s+dividend|total|combined|together|all|every|both|and|plus|family|shareholders|owners|officers|directors|management)\b|&|\+/i;
/** A name followed by a possessive relation names someone else ("Harjit's wife"). */
const POSSESSIVE_RELATION = /^['’]s\s+(?:wife|husband|spouse|partner|son|daughter|child|kids?|brother|sister|mother|father|mom|dad|parents?|family|nephew|niece|in-laws?|email|note|notes)\b/i;
/** Words for a relative: a reference to someone other than the named person ("Dad's salary", "his wife"). */
const RELATION = String.raw`(?:dad|mom|mum|father|mother|wife|husband|spouse|son|daughter|brother|sister|uncle|aunt|cousin|nephew|niece|grandson|granddaughter|in-laws?)`;
const STAYS_RE = /\b(?:to\s+stay|will\s+stay|staying|stays\s+on|stay\s+on|remain(?:s|ing)?|will\s+continue|continue\s+(?:as|to\s+run|running)|under\s+an?\s+employment\s+agreement|roll(?:ing)?\s+(?:over|\d))\b/gi;
const LEAVES_RE = /\b(?:retir\w+|leav(?:e|es|ing)\s+(?:at|on|after)|exit(?:s|ing)?\b|transition(?:s|ing)?\s+out|step(?:s|ping)?\s+(?:down|away|back)|will\s+not\s+be\s+replaced|won['’]t\s+be\s+replaced|not\s+be\s+replaced|salary\s+ends|removed\s+day\s+one|to\s+be\s+removed|no\s+(?:active\s+|operating\s+|operational\s+)?role|non[- ]working|fully\s+out)\b/gi;
/** The material says the pay is for no real work / above market / ends at the sale unreplaced. */
const NO_REAL_COST_RE =
  /\bnon[- ](?:working|operating|operational)\b|\bno\s+(?:real\s+|active\s+|operating\s+|operational\s+|day[- ]to[- ]day\s+)?role\b|\bnot\s+(?:active|working|involved)\s+in\b|\bdoes(?:n['’]t| not)\s+(?:really\s+|actually\s+)?work\b|\bincome[- ]splitting\b|\babove[- ]market\b|\bin\s+excess\s+of\s+(?:the\s+)?market\b|\bover(?:paid|[- ]market)\b|\b(?:will\s+not|won['’]t|not)\s+be\s+replaced\b|\bnot\s+(?:an?\s+)?(?:operating\s+)?role\s+a\s+buyer\b|\brole\s+(?:is\s+)?not\s+needed\b|\bnot\s+(?:needed|required)\s+(?:post[- ]?close|after\s+(?:the\s+)?(?:sale|close|closing))\b|\b(?:comes?|coming|goes|going)\s+off\s+(?:the\s+)?(?:payroll\s+)?at\s+(?:the\s+)?(?:close|closing|sale)\b|\bremoved\s+(?:on\s+)?(?:day\s+one|at\s+(?:the\s+)?(?:close|closing|sale))\b|\bto\s+be\s+removed\b|\b(?:salary|pay)\s+(?:ends|stops)\b/gi;

function moneyValue(raw: string): number | null {
  const m = raw.replace(/\s+/g, "").match(/^\$(\d[\d,]*(?:\.\d+)?)(k|m|million|thousand)?$/i);
  if (!m) return null;
  let v = parseFloat(m[1].replace(/,/g, ""));
  const mag = (m[2] || "").toLowerCase();
  if (mag === "k" || mag === "thousand") v *= 1e3;
  else if (mag === "m" || mag === "million") v *= 1e6;
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** Sentences / clauses a pay statement must sit inside. */
function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?;])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

/** Whole sentences (a semicolon doesn't end one; a title's dot — "Dr. Park" — doesn't either). */
function planSentencesOf(text: string): string[] {
  return text.split(/(?<!\b(?:Dr|Mr|Mrs|Ms|St|Jr|Sr)\.)(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A transcript or note line's speaker label, and what follows it:
 * "Manpreet Grewal: Dad takes $285K" → speaker Manpreet, "Dad takes $285K";
 * "[00:04:18] Morgan Ellis: …", "Seller (Manpreet): …", "Surinder (Harjit's
 * wife): no operational role …". The label names who is SPEAKING (or, with
 * nobody named after it, who the note is about) — never the subject of what
 * follows when it names someone else.
 */
function splitSpeaker(sentence: string): { speaker: string | null; body: string } {
  const m = /^\s*(?:\[[\d:]+\]\s*)?(?:(?:Seller|Broker|Owner|Buyer|Interviewer|Advisor|Accountant)\s*\(\s*([A-Z][a-z]+)[^)]*\)|([A-Z][a-z]+)(?:\s+[A-Z][a-z]+){0,2}(?:\s*\([^)]*\))?)\s*:\s+/.exec(sentence);
  if (!m) return { speaker: null, body: sentence };
  return { speaker: m[1] ?? m[2], body: sentence.slice(m[0].length) };
}

/** Asides that don't change who a sentence is about: "(Harjit's wife)", ", Harjit's wife,". */
function withoutAsides(text: string): string {
  return text
    // "Dad (Harjit Grewal) full salary …": the aside names who the relative is.
    .replace(new RegExp(String.raw`\b${RELATION}\s*\(\s*([A-Za-z]{3,})[^()]*\)`, "gi"), (whole, name: string) => (/^[A-Z][a-z]/.test(name) && !NOT_A_FIRST_NAME.has(name) ? name : whole))
    .replace(/\([^()]*\)/g, " ")
    .replace(new RegExp(String.raw`,\s*(?:[A-Z][a-z]+['’]s\s+|(?:his|her|the\s+owner['’]s)\s+)${RELATION}\b[^,]{0,30},`, "gi"), " ");
}

const MONTH_OR_DAY = new Set(
  "January February March April May June July August September October November December Monday Tuesday Wednesday Thursday Friday Saturday Sunday".split(" "),
);

interface PersonRef { at: number; who: string | null }

/**
 * Who each part of a text is about: every roster name (keyed), another
 * person's name, a relative ("Dad", "his wife") or a first-person pronoun
 * (the speaker). `who` is the roster key, or null for anyone else.
 */
function personRefs(body: string, firsts: string[], speaker: string | null): PersonRef[] {
  const refs: PersonRef[] = [];
  const rosterKey = (w: string) => firsts.find((f) => f.toLowerCase() === w.toLowerCase())?.toLowerCase() ?? null;
  for (const m of Array.from(body.matchAll(/\b[A-Z][a-z]{2,}(?:\s+(?:[A-Z]\.\s+)?[A-Z][a-z]+)*/g))) {
    const words = m[0].split(/\s+/).filter((w) => /^[A-Z][a-z]/.test(w));
    const key = words.map(rosterKey).find((k) => k !== null) ?? null;
    if (key) { refs.push({ at: m.index!, who: key }); continue; }
    const first = words[0];
    if (NOT_A_FIRST_NAME.has(first) || MONTH_OR_DAY.has(first)) continue;
    // A capitalised first word is just the start of the sentence ("Retired in 2019").
    if (m.index === 0 && !/^['’]s\b/.test(body.slice(m[0].length))) continue;
    refs.push({ at: m.index!, who: null });
  }
  for (const m of Array.from(body.matchAll(new RegExp(String.raw`\b${RELATION}\b`, "gi")))) refs.push({ at: m.index!, who: null });
  const self = speaker ? rosterKey(speaker) : null;
  for (const m of Array.from(body.matchAll(/\bI(?:['’](?:m|ll|ve|d))?\b|\b[Mm](?:e|y|yself)\b/g))) refs.push({ at: m.index!, who: speaker ? self : null });
  return refs.sort((a, b) => a.at - b.at);
}

/**
 * The people a plan word is about ("Ranjit Bains retired" is Ranjit's,
 * "Dale's retirement" Dale's, "Dad's salary … won't be replaced" Dad's):
 * the nearest person named before it; else one named just after it
 * ("retiring owner Harjit"); else, in a labelled line naming nobody, the
 * label's person ("Seller (Manpreet): likely open to staying").
 */
function subjectsOf(re: RegExp, body: string, refs: PersonRef[], labelKey: string | null | undefined): Array<string | null> {
  const out: Array<string | null> = [];
  re.lastIndex = 0;
  for (const m of Array.from(body.matchAll(re))) {
    const at = m.index!;
    const before = refs.filter((r) => r.at < at);
    if (before.length > 0) { out.push(before[before.length - 1].who); continue; }
    const after = refs.find((r) => r.at >= at && r.at - at <= 30);
    if (after) { out.push(after.who); continue; }
    if (refs.length === 0 && labelKey !== undefined) out.push(labelKey);
  }
  return out;
}

/**
 * Pay statements for one person in a sentence: "<Name> … salary $285K",
 * "<Name> takes $285K", "<Name> (Dad, full salary $285K …)". Nothing when
 * another person is named between the name and the figure, or when the
 * words between make the figure something else (a market salary, a
 * replacement cost, several people's total).
 */
function statementsIn(sentence: string, first: string, others: string[], isPrivate: boolean): PayStatement[] {
  const out: PayStatement[] = [];
  const re = new RegExp(String.raw`\b${escape(first)}\b`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(sentence)) !== null) {
    const after = sentence.slice(m.index + m[0].length);
    if (POSSESSIVE_RELATION.test(after)) continue;
    // A pay word, then the figure, within a short reach of the name.
    const reach = after.slice(0, 110);
    const hit = new RegExp(String.raw`^([\s\S]{0,70}?)\b${PAY_WORD}\b([^$\d]{0,24}?)(${MONEY})`, "i").exec(reach);
    if (!hit) continue;
    const statement = payStatement(sentence, hit, others, isPrivate, after);
    if (statement) out.push(statement);
  }
  return out;
}

/** The speaker's own pay in the first person ("Harjit Grewal: my salary is $285,000"). */
function firstPersonStatementsIn(sentence: string, others: string[], isPrivate: boolean): PayStatement[] {
  const out: PayStatement[] = [];
  for (const m of Array.from(sentence.matchAll(/\b(?:I|[Mm]y)\b/g))) {
    const after = sentence.slice(m.index! + m[0].length);
    const hit = new RegExp(String.raw`^([\s\S]{0,40}?)\b(?:${PAY_WORD}|take|draw|make|earn)\b([^$\d]{0,24}?)(${MONEY})`, "i").exec(after.slice(0, 90));
    if (!hit) continue;
    const statement = payStatement(sentence, hit, others, isPrivate, after, true);
    if (statement) out.push(statement);
  }
  return out;
}

function payStatement(sentence: string, hit: RegExpExecArray, others: string[], isPrivate: boolean, after: string, firstPerson = false): PayStatement | null {
  // Complete parentheticals between the name and the pay word are an
  // aside ("Surinder (Harjit's wife) salary $62K"); a relation opening one
  // is who the person is ("Harjit Grewal (Dad, full salary $285K").
  const lead = hit[1].replace(/\([^()]*\)/g, " ").replace(new RegExp(String.raw`^\s*(?:[A-Z][a-z]+\s+)?\(\s*${RELATION}\b`, "i"), " ");
  const between = `${lead} ${hit[2]}`;
  if (NOT_PAY_BETWEEN.test(between)) return null;
  if (others.some((o) => new RegExp(String.raw`\b${escape(o)}\b`, "i").test(between))) return null;
  // Someone else between the name and the figure: a relative ("Dad takes").
  if (new RegExp(String.raw`\b${RELATION}\b`, "i").test(between)) return null;
  // A speaker's label ("Manpreet Grewal: he takes $285K"): what follows is theirs
  // only when it names nobody else ("Gord McAllister (seller): Owner salary $260,000").
  if (!firstPerson && /:/.test(between) && /\b(?:he|she|his|her|him|they|their|the\s+owner)\b/i.test(between.slice(between.lastIndexOf(":")))) return null;
  // "salaries of $522K for Harjit and Manpreet": plural pay of several people.
  if (/\bsalaries\b/i.test(hit[0]) && /\b(?:and|&)\b/.test(after.slice(0, 60))) return null;
  const value = moneyValue(hit[3]);
  if (value === null || value < 10_000) return null;
  const years = Array.from(new Set(sentence.match(/\b(?:19|20)\d{2}\b/g) ?? []));
  return { value, year: years.length === 1 ? years[0] : null, private: isPrivate, text: sentence.length > 200 ? `${sentence.slice(0, 197)}…` : sentence };
}

/**
 * The pay and plans of each named person, from the deal's material.
 * `names` are the people to look for (first names, or full names — the
 * first word is used). `shared` texts are the seller's side; `private` the
 * broker's own notes (statements from those are marked private; plans to
 * stay or leave are read from the shared side only).
 *
 * A speaker's label is not what a line is about: "Manpreet Grewal: Dad
 * takes $285K" is not Manpreet's pay, "Manpreet Grewal: Ranjit Bains
 * retired" not Manpreet's retirement. Questions state nothing.
 */
export function payRosterFrom(texts: { shared: string[]; private: string[] }, names: string[]): PayRoster {
  const firsts = Array.from(
    new Set(
      names
        .map((n) => (n || "").trim().split(/\s+/)[0] ?? "")
        .map((n) => n.replace(/[^A-Za-z'’-]/g, ""))
        .filter((n) => n.length >= 3 && /^[A-Z]/.test(n)),
    ),
  );
  const people = new Map<string, PersonPay>();
  for (const first of firsts) people.set(first.toLowerCase(), { name: first, pay: [], stays: false, leaves: false, noRealCost: false });
  if (firsts.length === 0) return { people };
  const keyOf = (name: string | null) => (name ? firsts.find((f) => f.toLowerCase() === name.toLowerCase())?.toLowerCase() ?? null : null);
  const scan = (list: string[], isPrivate: boolean) => {
    for (const text of list) {
      if (!text) continue;
      const lower = text.toLowerCase();
      if (!firsts.some((f) => lower.includes(f.toLowerCase()))) continue;
      for (const sentence of sentencesOf(text)) {
        if (/\?\s*$/.test(sentence)) continue;
        const { speaker, body } = splitSpeaker(sentence);
        const speakerKey = keyOf(speaker);
        // Pay: named in the body, or the speaker's own in the first person.
        for (const first of firsts) {
          const person = people.get(first.toLowerCase())!;
          const others = firsts.filter((o) => o !== first);
          if (new RegExp(String.raw`\b${escape(first)}\b`, "i").test(body)) person.pay.push(...statementsIn(body, first, others, isPrivate));
          if (speakerKey === first.toLowerCase()) person.pay.push(...firstPersonStatementsIn(body, others, isPrivate));
        }
      }
      // Plans and role: whoever each plan word is about — read over whole
      // sentences ("Surinder … salary $62K; no operational role since 2019").
      for (const sentence of planSentencesOf(text)) {
        if (/\?\s*$/.test(sentence)) continue;
        const { speaker, body } = splitSpeaker(sentence);
        const plain = withoutAsides(body);
        const refs = personRefs(plain, firsts, speaker);
        const label = speaker ? keyOf(speaker) : undefined;
        const mark = (re: RegExp, set: (p: PersonPay) => void) => {
          for (const who of subjectsOf(re, plain, refs, label)) {
            const p = who ? people.get(who) : undefined;
            if (p) set(p);
          }
        };
        if (!isPrivate) {
          mark(STAYS_RE, (p) => { p.stays = true; });
          mark(LEAVES_RE, (p) => { p.leaves = true; });
        }
        mark(NO_REAL_COST_RE, (p) => { p.noRealCost = true; });
      }
    }
  };

  scan(texts.shared, false);
  scan(texts.private, true);
  return { people };
}

/**
 * The pay the material states for a person: per named year, and one figure
 * the undated statements give most often (their pay now). Null when nothing
 * is stated. `current` is null when no undated statement gives it, or two
 * different figures are stated equally often — a figure tied to an earlier
 * year is never taken as this year's.
 */
export function statedPay(person: PersonPay | undefined): { byYear: Record<string, number>; current: number | null; private: boolean } | null {
  if (!person || person.pay.length === 0) return null;
  const byYear: Record<string, number> = {};
  for (const p of person.pay) if (p.year && byYear[p.year] === undefined) byYear[p.year] = p.value;
  // Shared statements decide; private ones only when nothing shared says it.
  const pool = person.pay.some((p) => !p.private) ? person.pay.filter((p) => !p.private) : person.pay;
  const counts = new Map<number, number>();
  for (const p of pool) if (!p.year) counts.set(p.value, (counts.get(p.value) ?? 0) + 1);
  const ranked = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  const current = ranked.length === 0 || (ranked.length > 1 && ranked[0][1] === ranked[1][1]) ? null : ranked[0][0];
  if (current === null && Object.keys(byYear).length === 0) return null;
  return { byYear, current, private: !person.pay.some((p) => !p.private) };
}

/** First names in a label that are people on the roster ("Owner compensation — Harjit Grewal (President)" → ["harjit"]). */
export function peopleNamedIn(text: string, roster: PayRoster): string[] {
  const out: string[] = [];
  for (const [key, p] of Array.from(roster.people.entries())) {
    if (new RegExp(String.raw`\b${escape(p.name)}\b`, "i").test(text)) out.push(key);
  }
  return out;
}

const PEOPLE_FACT_KEY = /^(?:owner(?:Name|s)?|shareholders?|shareholderStructure|shareholding|ownershipSplit|directors?|officers?|boardOfDirectors|managementTeam|keyEmployees|keyPersonnel|employeeStructure|familyMembers|familyEmployees|relatedParties|relatedPartyTransactions)$/i;
const NOT_A_FIRST_NAME = new Set(
  ("The This That These Those Class Common Voting Non Shares Share Holdings Group Limited Ltd Inc Corp Company Owner Owners President Vice Director Directors Manager Managers " +
    "Operations Secretary Treasurer Founder Chief Senior Junior Head General Lead Office Admin Administration Controller Shareholder Shareholders Board Family Holdings " +
    "Dad Mom Wife Husband Son Daughter Canada Ontario British Columbia Alberta Quebec Manitoba Saskatchewan Nova Scotia And With From Appointed Since None Not Yes " +
    "Shop Yard Warehouse Dispatch Safety Sales Accounting Finance Fleet Drivers Driver Technicians Technician Service Installation Plumbing Staff Team Customer Customers " +
    "Account Accounts Key Books Bookkeeper Payroll Maintenance Marketing Purchasing Logistics Transport Trucking Systems Human Resources Legal Compliance Quality " +
    "Production Plant Store Stores Location Locations Clinic Front Back Part Full Time Registered Licensed Certified Red Seal Assistant Associate Partner Partners " +
    "Principal Officer Officers Executive Vp Gm Ceo Cfo Coo Its Our Their His Her All Both Each Other").split(" "),
);

/**
 * People the deal's facts name as owners, shareholders, directors or managers
 * ("Harjit Singh Grewal (600 Class A …); Manpreet Grewal (…)" → Harjit, Manpreet),
 * plus any names given.
 */
export function peopleOnFile(info: Record<string, unknown> | null | undefined, extra: string[] = []): string[] {
  const out = new Set<string>();
  const add = (text: string) => {
    // A run of capitalised words is one name ("Harjit Singh Grewal"): its
    // first word. A lone word counts only with a role after it ("Dale (shop
    // foreman …)") — "Related party", "Delivery drivers" are not people.
    for (const m of Array.from(text.matchAll(/\b([A-Z][a-z]{2,})((?:\s+(?:[A-Z]\.?\s+)?[A-Z][a-z]+){0,3})(?=(\s*\()?)/g))) {
      if (NOT_A_FIRST_NAME.has(m[1])) continue;
      if (!m[2] && !m[3]) continue;
      out.add(m[1]);
    }
  };
  for (const [k, v] of Object.entries(info ?? {})) {
    if (k.startsWith("_") || !PEOPLE_FACT_KEY.test(k)) continue;
    add(typeof v === "string" ? v : JSON.stringify(v));
  }
  for (const e of extra) add(e);
  return Array.from(out);
}

const OWNERS_FACT_KEY = /^(?:owners?|shareholders?|shareholderStructure|shareholding|ownershipSplit|ownershipStructure)$/i;

/** The shareholders / owners the facts name (first names): who a "shareholders' salaries" line can cover. */
export function ownersOnFile(info: Record<string, unknown> | null | undefined): string[] {
  const out = new Set<string>();
  for (const [k, v] of Object.entries(info ?? {})) {
    if (k.startsWith("_") || !OWNERS_FACT_KEY.test(k)) continue;
    const text = typeof v === "string" ? v : JSON.stringify(v);
    for (const m of Array.from(text.matchAll(/\b([A-Z][a-z]{2,})(?:\s+(?:[A-Z][a-z]+\s+)?[A-Z][a-z]+)/g))) {
      if (!NOT_A_FIRST_NAME.has(m[1])) out.add(m[1]);
    }
  }
  return Array.from(out);
}

/**
 * Every text the roster reads: each fact's value AND its other values (a
 * figure a source stated that lost to another source is still what that
 * source said — Pacific's "Dad (Harjit Grewal) full salary $285K" is an
 * email's other value of ownerInvolvement), split by who holds it.
 */
export function payTextsFrom(
  info: Record<string, unknown> | null | undefined,
  base: { shared: string[]; private: string[] },
): { shared: string[]; private: string[] } {
  const shared = [...base.shared];
  const priv = [...base.private];
  const alternates = (info?._fieldAlternates ?? {}) as Record<string, unknown>;
  for (const list of Object.values(alternates)) {
    if (!Array.isArray(list)) continue;
    for (const a of list as Array<{ value?: unknown; brokerOnly?: boolean; source?: string }>) {
      if (!a || typeof a.value !== "string" || !a.value.trim()) continue;
      (a.brokerOnly || a.source === "crm" ? priv : shared).push(a.value);
    }
  }
  const notes = info?._brokerPrivateNotes;
  if (Array.isArray(notes)) for (const n of notes as Array<{ note?: unknown }>) if (n && typeof n.note === "string") priv.push(n.note);
  return { shared, private: priv };
}
