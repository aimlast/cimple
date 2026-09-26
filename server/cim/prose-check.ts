/**
 * prose-check — the figure check for everything a section SAYS, not just its
 * tables and charts.
 *
 * The first figure check covered financial tables, charts, key-number grids
 * and the cover. Pacific's CIM (2026-09-26) showed what that missed: prose
 * with figures from general knowledge ("over three million TEUs", "a modern
 * highway tractor costs $180,000 to $200,000" — the $180,000 only matched an
 * unrelated legal claim on file), a margin "improvement from 11.9% to 11.7%",
 * "35 percent year-over-year" for a two-year change, "before fall 2026"
 * written in September 2026, a gender guessed from a name, "Top 5" badges and
 * "Fraser Valley Produce Importer" invented for customers, the seller's
 * "six-point-something years" copied verbatim, a confidential RFP, and a
 * second adjusted EBITDA. Each is checked here against the knowledge base the
 * writer was given (KnownFigures) and reported like any other figure problem:
 * the section is rewritten once with the list, and what's left is shown to
 * the broker.
 *
 * Pure: no database, no AI.
 */
import { offCanon, type EarningsCanon } from "./earnings-canon";
import type { CimGrowth } from "./cim-financials";
import { isKnownFigure, parseFiguresAt, type Figure, type KnownFigures } from "./figure-check";
import { spelledNumbers, CASUAL_FIGURE } from "./spoken-figures";
import { staleTargets } from "./fact-dates";
import { mentionsHeldName } from "./sensitive-facts";

/** What the prose checks need beyond the numbers: built once per knowledge base (proseKnowledge). */
export interface ProseKnowledge {
  /** Every number in the knowledge base, digits or words. */
  numbers: number[];
  /** The knowledge base line by line: normalised text, word stems, figures. */
  lines: Array<{ norm: string; raw: string; key: string; figs: Array<Figure & { index: number; end: number }> }>;
  /** People on file and the gender the file gives them ("m" / "f"), if any. */
  people: Map<string, "m" | "f" | null>;
  earnings?: EarningsCanon | null;
  growth?: CimGrowth[];
  today?: Date;
  /** Names held out as confidential (sensitive-facts holdConfidentialFacts). */
  heldNames?: string[];
}

/** Function words and scale words: sharing one of these says nothing about the subject. */
const STOP = new Set(
  "about above after again against among around based before being below between beyond could during every other their there these those through under until which while whose would should since still where within without across along approximately million thousand billion years months including include includes number currently approx percent".split(" "),
);

/** Short words that still name what a figure is. */
const SHORT_SUBJECT = new Set("rent fuel debt loan cost fees sale land yard shop bank cash fund bond lease wage".split(" "));

function stemsOf(text: string): Set<string> {
  const out = new Set<string>();
  const t = text
    .toLowerCase()
    .replace(/\bsde\b/g, "seller discretionary earnings")
    .replace(/\badd-?backs?\b|\badded back\b/g, "addback")
    // "offering the business for $4.8M" is the asking price.
    .replace(/\b(?:asking|offer(?:ed|ing)?|priced|listed|listing|valuation|valued)\b/g, "price");
  for (const w of t.match(/[a-z]{4,}/g) ?? []) {
    if (w.length === 4 && !SHORT_SUBJECT.has(w)) continue;
    if (!STOP.has(w)) out.add(w.slice(0, 5));
  }
  return out;
}

const norm = (s: string) => ` ${s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim()} `;

// ── People and the gender the file gives them ─────────────────────────────

const PEOPLE_KEY = /employee|management|manager|director|shareholder|owner|founder|president|personnel|staff|team|contact|succession|transition|key ?person|leadership|officer|family|partner|foreman|controller|successor/i;
const NOT_NAME = new Set(
  "The This That These Those When Where Which While With Without After Before During Since Until From Into Over Under About Above Also Both Each Every Many Most Some Such Their There They What Who Whose Will Would Could Should May Might Must Can Our Your His Her Its Owner Owners President Vice Manager Director Company Business Customer Customers Class Common Shares Share Holdings Group Limited Ltd Inc Corp Grocery Supply Building Logistics Coast Pacific North South East West Street Drive Road Avenue Highway Canada British Columbia Alberta Ontario Surrey Vancouver Calgary Toronto January February March April June July August September October November December Monday Tuesday Wednesday Thursday Friday Saturday Sunday None Yes Not Key Operations Sales Finance Accounting Warehouse Shop Fleet Safety Senior Junior Assistant Chief Head General Lead Red Seal Level Plan"
    .split(" "),
);

/** A parenthetical that says what a person does ("Dale (shop foreman since 2005"). */
const ROLE_WORD = /^\s*(?:the\s+)?(?:\w+\s+){0,2}(?:foreman|manager|president|vp|director|owner|founder|controller|dispatch\w*|tech\w*|books|bookkeeper|accountant|lawyer|son|daughter|wife|husband|brother|sister|driver|supervisor|lead|coordinator|ceo|cfo|coo|gm|operations|safety|sales|office|admin\w*|partner|shareholder|mechanic|estimator|superintendent|clerk|assistant)\b/i;
/** Words that make a capitalised pair a company, not a person ("Kestrel Building Supply"). */
const BUSINESS_WORD = /^(?:Grocery|Building|Supply|Supplies|Distributors?|Logistics|Ltd|Inc|Corp|Co|Group|Holdings|Markets?|Bank|Llp|Partners|Services|Company|Foods?|Beverage|Transport|Trucking|Warehouse|Farms?|Dairy|Produce|Industries|Manufacturing|Systems|Solutions|Insurance|Capital|Financial|Properties|Realty|Law|Cpa|Chartered|Consulting|Advisory|Motors?|Equipment|Leasing|Freight|Express|Lines|Carriers?|International|Canada|Pacific|Coast|Valley|Road|Drive|Street|Way|Avenue|Highway|Port)$/;

/**
 * First names of people on file: the EMPLOYEES block and people-type facts
 * ("Key Employees: Dale (shop foreman …)", "Directors: Harjit Singh Grewal
 * …"). Gender only where the file itself gives it: a pronoun about them
 * ("promoting him"), "X and wife" / "X's husband", or "son/daughter X".
 */
export function peopleOnFile(kbText: string): Map<string, "m" | "f" | null> {
  const people = new Map<string, "m" | "f" | null>();
  const lines = kbText.split("\n");
  let inEmployees = false;
  const add = (first: string) => {
    if (first.length < 3 || NOT_NAME.has(first) || !/^[A-Z][a-z]+$/.test(first)) return;
    if (!people.has(first)) people.set(first, null);
  };
  for (const line of lines) {
    if (/^---/.test(line.trim())) {
      inEmployees = /EMPLOYEES/.test(line);
      continue;
    }
    if (inEmployees) {
      const name = line.split(",")[0].trim();
      const first = name.split(/\s+/)[0];
      if (first) add(first);
      continue;
    }
    const m = /^([^:]{2,60}):\s(.*)$/.exec(line);
    if (!m || !PEOPLE_KEY.test(m[1])) continue;
    // "Harjit Singh Grewal", "Manpreet Grewal (VP Operations)", "Dale (shop
    // foreman …)": the first name only (a middle name or surname follows
    // another name), and never a company ("Alderbrook (grocery distributor",
    // "Kestrel Building Supply").
    for (const n of Array.from(m[2].matchAll(/(?<![A-Z][a-z]+\s)\b([A-Z][a-z]{2,})(\s+[A-Z][a-z]+\b|\s*\(\s*[^)]{0,40})/g))) {
      const next = n[2].trim();
      if (next.startsWith("(")) {
        if (ROLE_WORD.test(next.slice(1, 40))) add(n[1]);
      } else if (!NOT_NAME.has(next) && !BUSINESS_WORD.test(next)) add(n[1]);
    }
  }
  const text = kbText;
  // A surname ("Harjit S. Grewal (President)" made "Grewal" look like a first
  // name): a name that follows another person's first name somewhere on file.
  for (const n of Array.from(people.keys())) {
    const others = Array.from(people.keys()).filter((o) => o !== n);
    if (others.length && new RegExp(String.raw`\b(?:${others.join("|")})(?:\s+[A-Z][a-z]*\.?)?\s+${n}\b`).test(text)) people.delete(n);
  }
  const MALE = /\b(he|him|his|himself)\b/i;
  const FEMALE = /\b(she|her|hers|herself)\b/i;
  for (const first of Array.from(people.keys())) {
    let g: "m" | "f" | null = null;
    const set = (x: "m" | "f") => {
      g = g && g !== x ? null : x;
    };
    const re = new RegExp(String.raw`\b${first}\b`, "g");
    for (const hit of Array.from(text.matchAll(re))) {
      const after = text.slice(hit.index! + first.length, hit.index! + first.length + 120).split(/[.;\n]/)[0];
      const before = text.slice(Math.max(0, hit.index! - 30), hit.index!);
      // "Harjit and wife", "Harjit Grewal and his wife", "Harjit's wife".
      if (/^(?:\s+[A-Z][a-z]+){0,2}\s*(?:and|&)\s+(?:his\s+)?wife\b|^(?:\s+[A-Z][a-z]+){0,2}'s\s+wife\b/.test(after)) set("m");
      if (/^(?:\s+[A-Z][a-z]+){0,2}\s*(?:and|&)\s+(?:her\s+)?husband\b|^(?:\s+[A-Z][a-z]+){0,2}'s\s+husband\b/.test(after)) set("f");
      if (/\b(?:son|father|brother|uncle|nephew|grandson|husband|mr\.?)\s*,?\s*$/i.test(before) || /^\s*\((?:[^)]*\b)?(?:son|father|brother|husband)\b/i.test(after)) set("m");
      if (/\b(?:daughter|mother|sister|aunt|niece|granddaughter|wife|mrs\.?|ms\.?)\s*,?\s*$/i.test(before) || /^\s*\((?:[^)]*\b)?(?:daughter|mother|sister|wife)\b/i.test(after)) set("f");
      // A pronoun in the same clause, after the name, before anyone else is named.
      const others = Array.from(people.keys()).filter((o) => o !== first);
      // "Maria (office manager, his wife)": "his" there is about someone else.
      const clause = (others.length ? after.split(new RegExp(String.raw`\b(?:${others.join("|")})\b`))[0] : after).replace(
        /\b(?:his|her|their)\s+(?:wife|husband|son|daughter|father|mother|brother|sister|partner|spouse|family)\b/gi,
        " ",
      );
      if (MALE.test(clause) && !FEMALE.test(clause)) set("m");
      else if (FEMALE.test(clause) && !MALE.test(clause)) set("f");
    }
    people.set(first, g);
  }
  return people;
}

/** Build the prose knowledge from the writer's knowledge-base text. */
export function proseKnowledge(
  kbText: string,
  extras: Pick<ProseKnowledge, "earnings" | "growth" | "today" | "heldNames"> = {},
): ProseKnowledge {
  const lines: ProseKnowledge["lines"] = [];
  const numbers: number[] = [];
  // A fact's value can run over several lines: those lines keep the fact's name.
  let lastKey = "";
  for (const line of kbText.split("\n")) {
    if (!line.trim()) continue;
    const named = /^([A-Za-z][^:\n]{0,60}):\s/.exec(line);
    if (named) lastKey = named[1];
    else if (/^---|^[A-Z][A-Z ]{3,}/.test(line)) lastKey = "";
    const key = lastKey;
    const figs = parseFiguresAt(line);
    for (const s of spelledNumbers(line)) figs.push({ value: s.value, tolerance: 0.5, kind: "plain", text: s.text, index: s.index, end: s.index + s.text.length });
    numbers.push(...figs.map((f) => f.value));
    lines.push({ norm: norm(line), raw: line, key, figs });
  }
  for (const g of extras.growth ?? []) numbers.push(Number(g.pct.toFixed(1)));
  return { numbers, lines, people: peopleOnFile(kbText), ...extras };
}

// ── Walking a section's text ─────────────────────────────────────────────

interface Str {
  path: string;
  text: string;
  /** Checked structurally already (table cell, chart value, key figure): numbers skipped or plain only. */
  covered: "all" | "money" | null;
  /** The item's own title / label, for the "same thing?" test (a description under "Port Drayage"). */
  context: string;
}

const SKIP_KEYS = new Set([
  "layoutType", "style", "trend", "accentColor", "color", "icon", "id", "parentId", "reportsTo", "sectionKey", "relatedSections",
  "type", "expandLabel", "collapseLabel", "url", "src", "videoUrl", "embedUrl", "imageUrl", "mediaId", "provider", "category", "unit",
  "currency", "leftLabel", "rightLabel", "yLabel", "xLabel", "dataKey", "key",
]);

function strings(layoutType: string, data: unknown, path = "", out: Str[] = [], context = ""): Str[] {
  if (typeof data === "string") {
    if (data.trim()) out.push({ path, text: data, covered: coveredAs(layoutType, path), context });
    return out;
  }
  if (Array.isArray(data)) {
    data.forEach((v, i) => strings(layoutType, v, `${path}.${i}`, out, context));
    return out;
  }
  if (data && typeof data === "object") {
    const rec = data as Record<string, unknown>;
    // A two-column side with its own layout: walk it as that layout.
    const nested = typeof rec.layoutType === "string" && rec.content && typeof rec.content === "object" ? rec.layoutType : null;
    const own = ["title", "label", "name", "primaryLabel"].map((k) => (typeof rec[k] === "string" ? (rec[k] as string) : "")).join(" ").trim();
    const ctx = own ? `${context} ${own}`.trim() : context;
    for (const [k, v] of Object.entries(rec)) {
      if (SKIP_KEYS.has(k)) continue;
      // The cover's date and "Prepared by" are set by the system (finalizeLayoutData).
      if (layoutType === "cover_page" && (k === "date" || k === "preparedBy")) continue;
      if (nested && k === "content") strings(nested, v, `${path}.content`, out, ctx);
      // A field's own name says what its value is ("monthlyRent": "$158,125").
      else strings(layoutType, v, `${path}.${k}`, out, typeof v === "string" ? `${ctx} ${k.replace(/([a-z])([A-Z])/g, "$1 $2")}` : ctx);
    }
  }
  return out;
}

function coveredAs(layoutType: string, path: string): Str["covered"] {
  if (/\.(?:rows|normalizedRows)\.\d+\.values\.\d+$/.test(path)) return "all";
  if (/\.data\.\d+\.(?!name$)[^.]+$/.test(path) && /chart/.test(layoutType)) return "all";
  if (layoutType === "waterfall_chart" && /\.items\.\d+\.value$/.test(path)) return "all";
  if (/\.metrics\.\d+\.value$|\.primaryValue$|\.secondaryStats\.\d+\.value$|\.centerValue$/.test(path)) return "money";
  if (layoutType === "cover_page" && /^\.(askingPrice|revenue|ebitda|sde)$/.test(path)) return "money";
  return null;
}

// ── The checks ───────────────────────────────────────────────────────────

const within = (v: number, tol: number, k: number) => Math.abs(Math.abs(v) - Math.abs(k)) <= tol + 1e-6 * Math.max(1, Math.abs(k));

/** A number that sits in a code, time, ratio or phone number — not a figure. */
function inCode(text: string, index: number, end: number): boolean {
  const b = text[index - 1] ?? "";
  if (/[/:#]/.test(b)) return true; // "24/7", "1:1.25", "#2"
  const after = text.slice(end, end + 3);
  if (/^[/:]\d/.test(after)) return true;
  if (/^(?:st|nd|rd|th)\b/i.test(after)) return true; // ordinals
  return /^[A-Za-z]/.test(after) && !/^(?:x\b|×)/i.test(after); // "10am", model numbers
}

/** Sentences — a decimal point ("$3.60 million") or an abbreviation ("adj. EBITDA") doesn't end one. */
function sentences(text: string): Array<{ s: string }> {
  return text
    .split(/(?<!\b(?:[Aa]dj|[Aa]pprox|[Ii]ncl|[Ee]xcl|vs|[Nn]o|[Ee]st|[Aa]vg|[Ii]nc|[Ll]td|[Cc]o|[Cc]orp|[Ss]t|Mrs?|Ms|Dr|[Ee]\.g|[Ii]\.e)\.)(?<=[.!?])\s+(?=[A-Z0-9"“($])|\n+/)
    .filter((s) => s.trim())
    .map((s) => ({ s }));
}

/** The words just around a figure (what it is), not the whole sentence or fact. */
function around(text: string, index: number, end: number): string {
  return text.slice(Math.max(0, index - 60), end + 45);
}

/**
 * True when a figure is on file only among words this sentence doesn't share:
 * each place it appears is read with the words just around it and the fact's
 * own name (a long fact names many things — only the neighbourhood of the
 * figure says what it is). A bare value with fewer than two words of its own
 * can't be compared and is never called a coincidence.
 */
function coincidence(value: number, tol: number, sentence: string, pk: ProseKnowledge, moneyOnly: boolean): boolean {
  // Only round figures ("$180,000", "$18 million", "three million") collide by
  // chance; a precise one ("$628,000", "$13,500") that is on file is that figure.
  if (String(Math.round(Math.abs(value))).replace(/0+$/, "").length > 2) return false;
  const mine = stemsOf(sentence);
  if (mine.size < 2) return false;
  let seen = false;
  for (const l of pk.lines) {
    for (const k of l.figs) {
      if ((moneyOnly && k.kind === "percent") || !within(value, tol, k.value)) continue;
      seen = true;
      const near = stemsOf(`${l.key} ${around(l.raw, k.index, k.end)}`);
      if (Array.from(mine).some((w) => near.has(w))) return false;
    }
  }
  return seen;
}

/** Numbers in prose that aren't on file — and money on file only for something unrelated. */
function unknownProseNumbers(str: Str, known: KnownFigures, pk: ProseKnowledge): string[] {
  if (str.covered === "all") return [];
  const out: string[] = [];
  const onFile = (v: number, tol: number) => pk.numbers.some((k) => within(v, tol, k));
  const plainOnly = str.covered === "money";
  for (const { s } of sentences(str.text)) {
    for (const f of parseFiguresAt(s)) {
      if (inCode(s, f.index, f.end)) continue;
      if (f.kind === "plain") {
        // Small counts ("two sites", "Level 3") and bare years are covered elsewhere or harmless.
        if (Math.abs(f.value) < 10) continue;
        if (!onFile(f.value, f.tolerance)) out.push(`"${f.text}" (${clip(s)})`);
        continue;
      }
      if (plainOnly) continue;
      if (!isKnownFigure(f, known)) {
        out.push(`"${f.text}" (${clip(s)})`);
        continue;
      }
      // On file — but for the same thing? A money figure whose every
      // appearance on file sits among other words than this sentence is a
      // coincidence ($180,000 "tractor cost" vs a $180,000 legal claim).
      if (f.kind === "money" && Math.abs(f.value) >= 10000 && coincidence(f.value, f.tolerance, `${around(s, f.index, f.end)} ${str.context}`, pk, true)) {
        out.push(`"${f.text}" is on file only for something else (${clip(s)})`);
      }
    }
    for (const w of spelledNumbers(s)) {
      if (w.value < 10 && !/hundred|thousand|million|billion/i.test(w.text)) continue;
      if (!onFile(w.value, 0.5)) {
        out.push(`"${w.text}" (${clip(s)})`);
        continue;
      }
      // "three million TEUs" matching a $3,000,000 credit line is no source.
      if (w.value >= 10000 && coincidence(w.value, 0.5, `${around(s, w.index, w.index + w.text.length)} ${str.context}`, pk, false)) {
        out.push(`"${w.text}" is on file only for something else (${clip(s)})`);
      }
    }
  }
  return out;
}

function clip(s: string): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > 110 ? `${t.slice(0, 107)}…` : t;
}

const UP = /\b(improv\w*|increas\w*|grow\w*|grew|rose|rise[sn]?|rising|expand\w*|strengthen\w*|climb\w*|gain\w*)\b/i;
const DOWN = /\b(declin\w*|decreas\w*|fell|fall\w*|dropp?\w*|shr[ai]nk\w*|contract\w*|compress\w*|erod\w*|narrow\w*|weaken\w*)\b/i;

const isYear = (f: { value: number; text: string; kind: string }) => f.kind === "plain" && /^(?:FY\s?)?(?:19|20)\d{2}$/.test(f.text.trim());

/** "improvement from 11.9% in 2022 to 11.7% in 2024": the direction word says the opposite of the figures. */
function wrongDirection(text: string): string[] {
  const out: string[] = [];
  for (const { s } of sentences(text)) {
    const figs = parseFiguresAt(s).filter((f) => !isYear(f));
    for (let i = 0; i < figs.length; i++) {
      const a = figs[i];
      if (!/\bfrom\s+(?:about\s+|roughly\s+|approximately\s+)?$/i.test(s.slice(Math.max(0, a.index - 22), a.index))) continue;
      // The figure it goes "to": the next one of the same kind, "to" right before it.
      const b = figs.slice(i + 1).find((x) => x.kind === a.kind && x.index !== a.index);
      if (!b) continue;
      const mid = s.slice(a.end, b.index);
      if (mid.length > 45 || !/\bto\s+(?:about\s+|roughly\s+)?$/i.test(mid)) continue;
      const lead = s.slice(Math.max(0, a.index - 80), a.index);
      const up = UP.test(lead), down = DOWN.test(lead);
      if (up === down) continue;
      if (up && b.value < a.value) out.push(`says it rose from ${a.text} to ${b.text}, which is a fall (${clip(s)})`);
      if (down && b.value > a.value) out.push(`says it fell from ${a.text} to ${b.text}, which is a rise (${clip(s)})`);
    }
  }
  return out;
}

const GROWTH_WORD = /\b(grow\w*|grew|growth|increas\w*|expand\w*|rose|up|declin\w*|decreas\w*|fell|down|gain\w*|jump\w*|climb\w*)\b/i;
const ONE_YEAR = /\byear[- ]over[- ]year\b|\byoy\b|\bannual(?:ly)?\b|\bper year\b|\ba year\b|\bin (?:a single|one) year\b|\bin (?:FY\s?)?(?:19|20)\d{2}\b(?!\s*(?:to|through|–|-)\s*(?:FY\s?)?(?:19|20)\d{2})/i;
const MULTI_YEAR = /\bover (?:the )?(?:past |last )?(?:two|three|four|five|2|3|4|5) years\b|\bsince (?:FY\s?)?(?:19|20)\d{2}\b|\bfrom (?:FY\s?)?(?:19|20)\d{2}\b|\bbetween (?:FY\s?)?(?:19|20)\d{2}\b|(?:19|20)\d{2}\s*(?:–|-|to|through|→)\s*(?:FY\s?)?(?:19|20)\d{2}|\bcumulative\b|\b(?:two|three|four|2|3|4)-year\b|\bin (?:19|20)\d{2}\b[^,;]*\bto\b[^,;]*\bin (?:19|20)\d{2}\b/i;

/** A statement growth rate quoted with the wrong period ("35% year-over-year" for FY2022→FY2024). */
function wrongGrowthPeriod(text: string, growth: CimGrowth[]): string[] {
  if (growth.length === 0) return [];
  const out: string[] = [];
  for (const { s } of sentences(text)) {
    for (const f of parseFiguresAt(s)) {
      if (f.kind !== "percent") continue;
      // The clause the rate sits in says what period it claims.
      const from = Math.max(s.lastIndexOf(",", f.index), s.lastIndexOf(";", f.index), s.lastIndexOf(" and ", f.index)) + 1;
      const nextBreak = [",", ";", " and "].map((c) => s.indexOf(c, f.end)).filter((i) => i >= 0);
      const clause = s.slice(from, nextBreak.length ? Math.min(...nextBreak) : s.length);
      if (!GROWTH_WORD.test(clause) || !ONE_YEAR.test(clause) || MULTI_YEAR.test(clause)) continue;
      const hits = growth.filter((g) => within(f.value, f.tolerance + 0.051, g.pct));
      if (hits.length === 0 || hits.some((g) => Number(g.to) - Number(g.from) === 1)) continue;
      const g = hits[0];
      out.push(`${f.text} is the FY${g.from}→FY${g.to} change in ${g.label}, not a one-year figure (${clip(s)})`);
    }
  }
  return out;
}

const PRONOUN = /\b(she|her|hers|herself|he|him|his|himself)\b/gi;

/** A gendered pronoun for someone the file gives no gender (or the other one). */
function guessedGender(text: string, pk: ProseKnowledge): string[] {
  if (pk.people.size === 0) return [];
  const out: string[] = [];
  const names = Array.from(pk.people.keys());
  const nameRe = new RegExp(String.raw`\b(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\b`, "g");
  const mentions = Array.from(text.matchAll(nameRe)).map((m) => ({ name: m[1], at: m.index! }));
  if (mentions.length === 0) return [];
  const seen = new Set<string>();
  for (const p of Array.from(text.matchAll(PRONOUN))) {
    // People named shortly before the pronoun, nearest first.
    const before = mentions.filter((m) => m.at < p.index! && p.index! - m.at <= 400).reverse();
    if (before.length === 0) continue;
    const g = /^(she|her|hers|herself)$/i.test(p[1]) ? "f" : "m";
    // "Tony and his wife Maria … he": a person the file gives that gender is
    // the antecedent; otherwise the nearest one the file doesn't rule out.
    if (before.some((m) => pk.people.get(m.name) === g)) continue;
    const names = Array.from(new Set(before.map((m) => m.name)));
    const k = `${names.join(",")}:${g}`;
    if (seen.has(k)) continue;
    seen.add(k);
    if (names.length > 1) {
      out.push(`"${p[1]}" — the file gives no such gender for anyone named just before it (${names.join(", ")}); use names or roles`);
      continue;
    }
    const onFile = pk.people.get(names[0]);
    out.push(onFile ? `"${p[1]}" for ${names[0]} contradicts the file` : `"${p[1]}" for ${names[0]} — no gender is on file; use the name or role`);
  }
  return out;
}

const RANK = /\b(top\s*(?:\d+|three|five|ten|twenty)|#\s?\d+|no\.\s?\d+|number (?:one|two|three)|(?:second|third|fourth|fifth|2nd|3rd|4th|5th)[- ]largest|largest|biggest)\b/i;
const PARTY = /\b(customer|client|account|supplier|vendor|payer|concentration)s?\b/i;
const LEGAL = /\b(co-op|co-operative|cooperative|incorporated|inc|ltd|limited|llc|llp|lp|plc|corp|corporation|company|co|the|and|of)\b\.?/gi;
const GENERIC_PARTY = /^(customer|client|account|major|key|anchor|other|others|remaining|top|largest|second|third|new|long|standing|term|several|various|smaller|small|mid|sized|national|local)$/i;
const LEGAL_ENDING = /\b(inc|ltd|limited|llc|llp|lp|plc|corp|corporation|company|co)\b\.?/i;
/** Words that make a list item a party (customer / supplier), not a topic. */
const ORG_NOUN = /\b(distributors?|importers?|exporters?|manufacturers?|retailers?|wholesalers?|processors?|grocers?|grocery chain|chain|co-?op|cooperative|brand|suppliers?|vendors?|contractors?|builders?|developers?|hospital|clinic|school|municipality|agency|carriers?|producers?|farms?|stores?|dealers?|restaurants?|hotels?|operators?|partners?|customers?|clients?|accounts?)\b/i;

function rankSupported(entity: string, rank: string, pk: ProseKnowledge): boolean {
  const core = norm(entity.replace(LEGAL, " ")).trim().split(" ").filter((w) => w.length >= 3 && !GENERIC_PARTY.test(w));
  if (core.length === 0) return true;
  const r = rank.toLowerCase().replace(/[-\s]+/g, " ").trim();
  const forms = /largest|biggest|number one|#\s?1\b|no\.\s?1\b/.test(r) && !/second|third|fourth|fifth|2nd|3rd|4th|5th/.test(r)
    ? [" largest ", " biggest ", " number one ", " anchor "]
    : [` ${r.replace(/[#.]/g, "").replace(/\s+/g, " ")} `, ` ${r.replace("2nd", "second").replace("3rd", "third")} `, ` ${r.replace(/\bfive\b/, "5").replace(/\bten\b/, "10").replace(/\bthree\b/, "3")} `];
  return pk.lines.some((l) => core.every((w) => l.norm.includes(` ${w}`)) && forms.some((f) => l.norm.includes(norm(f))));
}

function descriptionOnFile(title: string, pk: ProseKnowledge): boolean {
  const core = norm(title.replace(/\s*\(.*?\)\s*/g, " ").replace(LEGAL, " "))
    .trim()
    .split(" ")
    .filter((w) => w.length >= 3 && !GENERIC_PARTY.test(w));
  if (core.length === 0) return true;
  const stem = (w: string) => w.replace(/(ies|es|s)$/, "");
  return pk.lines.some((l) => core.every((w) => l.norm.includes(` ${stem(w)}`)));
}

/** Customer/supplier items: ranks and descriptions must come from the facts about that party. */
function partyItems(section: { sectionTitle: string; layoutType: string; layoutData: unknown; tags?: unknown }, pk: ProseKnowledge): string[] {
  const out: string[] = [];
  const visit = (layoutType: string, data: any, context: string) => {
    if (!data || typeof data !== "object") return;
    if (layoutType === "two_column") {
      for (const side of ["left", "right"]) {
        const col = data[side];
        if (col && typeof col.content === "object" && typeof col.layoutType === "string") visit(col.layoutType, col.content, `${context} ${col.title ?? ""}`);
      }
      return;
    }
    if (!PARTY.test(`${context} ${data.title ?? ""}`)) return;
    if (layoutType !== "callout_list" && layoutType !== "numbered_list") return;
    for (const it of Array.isArray(data.items) ? data.items : []) {
      const title = String(it?.title ?? "").replace(/\s+[—–-]\s.*$/, "").trim();
      if (!title) continue;
      const badge = String(it?.badge ?? "");
      const rank = RANK.exec(badge) ?? RANK.exec(String(it?.description ?? "").split(/[.;]/)[0]);
      if (rank && !rankSupported(title, rank[0], pk)) out.push(`"${rank[0]}" for "${title}" — no such ranking for it is on file`);
      // Only an item that names a party ("Regional Pet Food Distributor",
      // "Tidewater Beverage Co.") — not "Individual Technician Licensing".
      if ((ORG_NOUN.test(title) || LEGAL_ENDING.test(title) || rank) && !descriptionOnFile(title, pk)) {
        out.push(`"${title}" isn't how the facts name or describe any customer or supplier`);
      }
    }
  };
  visit(section.layoutType, section.layoutData, `${section.sectionTitle} ${Array.isArray(section.tags) ? section.tags.join(" ") : ""}`);
  return out;
}

/** Text a buyer reads for a key-figure item, with its label ("Adjusted EBITDA: $3,900,000 (FY2024)"). */
function labelledFigures(layoutType: string, data: any, out: string[] = []): string[] {
  if (!data || typeof data !== "object") return out;
  const s = (v: unknown) => (v === null || v === undefined ? "" : String(v));
  const money = (v: string) => (/^\s*-?\(?\d[\d,]*(\.\d+)?\)?\s*$/.test(v) ? `$${v.trim()}` : v);
  switch (layoutType) {
    case "metric_grid":
      for (const m of data.metrics ?? []) out.push(`${s(m?.label)}: ${s(m?.value)}${s(m?.unit) && !s(m?.value).includes(s(m?.unit)) ? s(m?.unit) : ""}${m?.footnote ? ` (${s(m.footnote)})` : ""}`);
      break;
    case "icon_stat_row":
      for (const m of data.stats ?? []) out.push(`${s(m?.label)}: ${s(m?.value)}${m?.description ? ` (${s(m.description)})` : ""}`);
      break;
    case "stat_callout":
      out.push(`${s(data.primaryLabel)}: ${s(data.primaryValue)}`);
      for (const m of data.secondaryStats ?? []) out.push(`${s(m?.label)}: ${s(m?.value)}`);
      break;
    case "cover_page":
      if (data.ebitda) out.push(`${s(data.earningsLabel) || "EBITDA"}: ${s(data.ebitda)}`);
      if (data.sde) out.push(`${s(data.earningsLabel) || "SDE"}: ${s(data.sde)}`);
      break;
    case "financial_table": {
      const headers: string[] = (data.headers ?? []).map(s);
      for (const r of [...(data.rows ?? []), ...(data.normalizedRows ?? [])]) {
        (r?.values ?? []).forEach((v: unknown, i: number) => {
          if (s(v).trim()) out.push(`${s(r?.label)}: ${money(s(v))} (${headers[i + 1] ?? ""})`);
        });
      }
      break;
    }
    case "line_chart":
    case "bar_chart": {
      const series = (data.series ?? []).map((x: any) => ({ key: s(x?.key), name: s(x?.name) || s(x?.key) }));
      const unit = s(data.unit);
      const scale = (v: string) => (/\$?m\b|million/i.test(unit) && /^\d/.test(v) ? `$${v}M` : /000s|\$k|thousand/i.test(unit) && /^\d/.test(v) ? `$${v}K` : money(v));
      for (const pt of data.data ?? []) {
        for (const x of series) if (pt && pt[x.key] !== undefined) out.push(`${x.name}: ${scale(s(pt[x.key]))} (${s(pt.name)})`);
        if (series.length === 0 && pt?.value !== undefined) out.push(`${s(data.title) || s(data.yLabel)} ${s(pt.name)}: ${scale(s(pt.value))}`);
      }
      break;
    }
    case "two_column":
      for (const side of ["left", "right"]) {
        const col = data[side];
        if (col && typeof col.content === "object" && typeof col.layoutType === "string") labelledFigures(col.layoutType, col.content, out);
      }
      break;
  }
  return out;
}

/** Earnings figures that aren't the bridge's (one adjusted EBITDA / SDE / margin / multiple). */
function earningsIssues(section: { layoutType: string; layoutData: unknown }, texts: Str[], canon: EarningsCanon): string[] {
  const out: string[] = [];
  const read = [...labelledFigures(section.layoutType, section.layoutData), ...texts.filter((t) => t.covered === null).map((t) => t.text)];
  for (const t of read) {
    for (const { mention, expected } of offCanon(t, canon)) {
      out.push(`${mention.text} is not the CIM's ${mention.kind === "margin" ? "earnings margin" : mention.kind === "multiple" ? "multiple" : mention.kind === "sde" ? "SDE" : "EBITDA"} — use ${expected} (${clip(t)})`);
    }
  }
  return out;
}

/** Every prose problem in a section (empty = nothing found). */
export function proseProblems(
  section: { sectionTitle: string; layoutType: string; layoutData: unknown; tags?: unknown; aiDraftContent?: unknown },
  known: KnownFigures,
): string[] {
  const pk = known.prose;
  if (!pk) return [];
  const texts = strings(section.layoutType, section.layoutData);
  const draft = typeof section.aiDraftContent === "string" ? section.aiDraftContent : "";
  if (draft.trim() && !texts.some((t) => t.text.trim() === draft.trim())) texts.push({ path: ".aiDraftContent", text: draft, covered: null, context: "" });

  const issues: string[] = [];
  for (const t of texts) {
    for (const m of unknownProseNumbers(t, known, pk)) issues.push(`no source for ${m}`);
    if (t.covered === "all") continue;
    issues.push(...wrongDirection(t.text));
    issues.push(...wrongGrowthPeriod(t.text, pk.growth ?? []));
    if (pk.today) for (const st of staleTargets(t.text, pk.today)) issues.push(`"${st.phrase}" is not in the future any more — today is ${pk.today.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })}; restate the timeline from the recorded date or leave the date out`);
    issues.push(...guessedGender(t.text, pk));
    const held = mentionsHeldName(t.text, pk.heldNames ?? []);
    if (held) issues.push(`mentions "${held}", which the facts mark confidential — leave it out`);
    const casual = CASUAL_FIGURE.exec(t.text);
    if (casual) issues.push(`"${casual[0]}" is the seller's spoken wording — write it as a clean figure without changing its meaning`);
  }
  issues.push(...partyItems(section, pk));
  if (pk.earnings) issues.push(...earningsIssues(section, texts, pk.earnings));
  return Array.from(new Set(issues));
}
