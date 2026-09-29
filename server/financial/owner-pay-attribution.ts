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
const STAYS_RE = /\b(?:to\s+stay|will\s+stay|staying|stays\s+on|stay\s+on|remain(?:s|ing)?|will\s+continue|continue\s+(?:as|to\s+run|running)|under\s+an?\s+employment\s+agreement|roll(?:ing)?\s+(?:over|\d))\b/i;
const LEAVES_RE = /\b(?:retir\w+|leav(?:e|es|ing)\s+(?:at|on|after)|exit(?:s|ing)?\b|transition(?:s|ing)?\s+out|step(?:s|ping)?\s+(?:down|away|back)|will\s+not\s+be\s+replaced|won['’]t\s+be\s+replaced|not\s+be\s+replaced|salary\s+ends|removed\s+day\s+one|to\s+be\s+removed|no\s+(?:active\s+|operating\s+|operational\s+)?role|non[- ]working|fully\s+out)\b/i;

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

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
    // Complete parentheticals between the name and the pay word are an
    // aside ("Surinder (Harjit's wife) salary $62K").
    const lead = hit[1].replace(/\([^()]*\)/g, " ");
    const between = `${lead} ${hit[2]}`;
    if (NOT_PAY_BETWEEN.test(between)) continue;
    if (others.some((o) => new RegExp(String.raw`\b${escape(o)}\b`, "i").test(between))) continue;
    // "salaries of $522K for Harjit and Manpreet": plural pay of several people.
    if (/\bsalaries\b/i.test(hit[0]) && /\b(?:and|&)\b/.test(after.slice(0, 60))) continue;
    const value = moneyValue(hit[3]);
    if (value === null || value < 10_000) continue;
    const years = Array.from(new Set(sentence.match(/\b(?:19|20)\d{2}\b/g) ?? []));
    out.push({ value, year: years.length === 1 ? years[0] : null, private: isPrivate, text: sentence.length > 200 ? `${sentence.slice(0, 197)}…` : sentence });
  }
  return out;
}

/**
 * The pay and plans of each named person, from the deal's material.
 * `names` are the people to look for (first names, or full names — the
 * first word is used). `shared` texts are the seller's side; `private` the
 * broker's own notes (statements from those are marked private).
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
  for (const first of firsts) people.set(first.toLowerCase(), { name: first, pay: [], stays: false, leaves: false });
  if (firsts.length === 0) return { people };
  const scan = (list: string[], isPrivate: boolean) => {
    for (const text of list) {
      if (!text) continue;
      const lower = text.toLowerCase();
      const present = firsts.filter((f) => lower.includes(f.toLowerCase()));
      if (present.length === 0) continue;
      for (const sentence of sentencesOf(text)) {
        for (const first of present) {
          if (!new RegExp(String.raw`\b${escape(first)}\b`, "i").test(sentence)) continue;
          const person = people.get(first.toLowerCase())!;
          const others = firsts.filter((o) => o !== first);
          person.pay.push(...statementsIn(sentence, first, others, isPrivate));
          // Plans: only a sentence about this person alone.
          if (others.some((o) => new RegExp(String.raw`\b${escape(o)}\b(?!['’]s\s)`, "i").test(sentence))) continue;
          if (!isPrivate && STAYS_RE.test(sentence)) person.stays = true;
          if (!isPrivate && LEAVES_RE.test(sentence)) person.leaves = true;
        }
      }
    }
  };
  scan(texts.shared, false);
  scan(texts.private, true);
  return { people };
}

/**
 * The pay the material states for a person: per named year, and one figure
 * the words give most often (the undated statements). Null when nothing is
 * stated, or two different figures are stated equally often.
 */
export function statedPay(person: PersonPay | undefined): { byYear: Record<string, number>; current: number | null; private: boolean } | null {
  if (!person || person.pay.length === 0) return null;
  const byYear: Record<string, number> = {};
  for (const p of person.pay) if (p.year && byYear[p.year] === undefined) byYear[p.year] = p.value;
  // Shared statements decide; private ones only when nothing shared says it.
  const pool = person.pay.some((p) => !p.private) ? person.pay.filter((p) => !p.private) : person.pay;
  const counts = new Map<number, number>();
  for (const p of pool) counts.set(p.value, (counts.get(p.value) ?? 0) + 1);
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
