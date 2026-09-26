/**
 * discrepancy-fact-key.ts — the fact a financial-analysis discrepancy is
 * about, when the model named none (or one that isn't on file).
 *
 * Ridgeline's analysis raised "Owner compensation (2024)" and "Signed backlog
 * (May 2025)" with fact_key NULL although ownerSalary and backlog were on
 * file: resolving them wrote nothing back, and the merge and the check
 * couldn't recognise them by key. The analysis prompt asks for a key; this
 * is the deterministic backstop, from the finding's own label and values:
 *  - a key the model spelled differently (canonicalFieldName);
 *  - owner pay ("Owner compensation", "Management salary", "Owner's pay"):
 *    the owner-pay fact on file — the one that states a side's figure, else
 *    ownerSalary;
 *  - a fact key whose words are all in the label ("Signed backlog" →
 *    backlog), preferring one whose value states a side's figure;
 *  - never a guess: two equally good keys give none (the broker picks).
 * Pure.
 */
import { canonicalFieldName, isFactKey } from "../interview/info-merger";
import { isOwnerPayKey } from "../documents/conflict-measures";
import { sidesEquivalent, numberTokens, tokensMatch } from "../cim/discrepancy-filter";
import { HEADLINE_MAPS } from "../documents/merge-policy";

type Info = Record<string, unknown>;

export interface AnalysisFinding {
  field: string;
  factKey?: string | null;
  factYear?: string | null;
  sourceA: { value: string };
  sourceB: { value: string };
}

/** Words that name no subject of their own in a finding's label. */
const LABEL_FILLER = new Set([
  "total", "signed", "current", "annual", "reported", "stated", "per", "the", "and", "for", "from", "with", "as", "of",
  "value", "amount", "figure", "number", "count", "level", "details", "detail", "info", "claimed", "actual",
  "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec", "fy", "ytd", "year", "years",
]);

const singular = (w: string) => (w.length > 4 ? w.replace(/ies$/, "y").replace(/(?<![su])s$/, "") : w);

function labelWords(label: string): Set<string> {
  return new Set(
    label
      .replace(/\([^)]*\)/g, " ")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((w) => w.length >= 3 && !LABEL_FILLER.has(w))
      .map(singular),
  );
}

function keyWords(key: string): string[] {
  return key
    .replace(/ByYear$/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length >= 3 && !LABEL_FILLER.has(w))
    .map(singular);
}

/** "Owner compensation" → "ownerCompensation". */
function spelledKey(label: string): string {
  const words = label.replace(/\([^)]*\)/g, " ").replace(/[^A-Za-z0-9 ]+/g, " ").trim().split(/\s+/).filter(Boolean);
  return words.map((w, i) => (i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())).join("");
}

const OWNER_PAY_LABEL = /\bowner'?s?\b[^.;]{0,20}\b(?:comp\w*|pay|salar\w*|wages?|remuneration|draws?)\b|\b(?:management|shareholders?|officers?)'?\s+(?:salar\w*|comp\w*|remuneration)\b/i;

const OTHER_PERSON_RE = /\b(?:spouse|wife|husband|son|daughter|family|relative|partner's|employee|staff|bookkeeper|manager's)\b/i;

/** The side's value without the " — source" label the analysis appends. */
function bare(v: string): string {
  const idx = v.indexOf(" — ");
  return idx > 0 ? v.slice(0, idx) : v;
}

function valueText(v: unknown, year?: string | null): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const map = v as Record<string, unknown>;
    if (year && map[year] !== undefined) return valueText(map[year]);
    return Object.values(map).map((x) => valueText(x)).join("; ");
  }
  return "";
}

/** True when the fact on file states one side's figure. */
function statesASide(info: Info, key: string, finding: AnalysisFinding): boolean {
  const onFile = valueText(info[key], finding.factYear);
  if (!onFile) return false;
  return [finding.sourceA.value, finding.sourceB.value].some((side) => {
    const s = bare(side);
    if (sidesEquivalent(onFile, s)) return true;
    const first = numberTokens(s).find((t) => !t.year);
    return !!first && numberTokens(onFile).some((t) => !t.year && tokensMatch(first, t));
  });
}

function onFile(info: Info, key: string): boolean {
  const v = info[key];
  return isFactKey(key) && v !== undefined && v !== null && v !== "";
}

/**
 * The fact key for an analysis finding (the model's when it is on file),
 * with its year for a by-year map — or null when none fits for certain.
 */
export function analysisFactKey(finding: AnalysisFinding, info: Info): { factKey: string; factYear: string | null } | null {
  const keys = Object.keys(info).filter((k) => onFile(info, k));
  const year = finding.factYear ?? null;
  // A headline figure for one year is that year of its by-year map (revenue
  // 2024 → revenueByYear 2024), which the resolution keeps in step with the headline.
  const done = (k: string) => {
    const pair = year ? HEADLINE_MAPS.find((p) => p.head === k) : undefined;
    const map = pair && info[pair.map] && typeof info[pair.map] === "object" ? pair.map : k;
    return { factKey: map, factYear: year };
  };
  const given = (finding.factKey ?? "").trim();
  if (given && keys.includes(given)) return done(given);
  if (given) {
    const canon = canonicalFieldName(given, keys);
    if (keys.includes(canon)) return done(canon);
  }
  const spelled = spelledKey(finding.field);
  if (spelled && keys.includes(spelled)) return done(spelled);
  const canonSpelled = spelled ? canonicalFieldName(spelled, keys) : "";
  if (canonSpelled && keys.includes(canonSpelled)) return done(canonSpelled);

  // Owner pay: the owner-pay fact that states a side's figure, else ownerSalary.
  // (Someone else's pay — "Management salary (spouse)" — is not the owner's.)
  if ((OWNER_PAY_LABEL.test(finding.field) || (given && isOwnerPayKey(given))) && !OTHER_PERSON_RE.test(finding.field)) {
    // The headline owner-salary fact first (the one the CIM reads; a resolution
    // for a year keeps its year on the row).
    const pay = keys.filter(isOwnerPayKey).sort((a, b) => Number(b === "ownerSalary") - Number(a === "ownerSalary"));
    const stating = pay.filter((k) => statesASide(info, k, finding));
    if (stating.length > 0) return done(stating[0]);
    if (keys.includes("ownerSalary")) return done("ownerSalary");
    return pay.length === 1 ? done(pay[0]) : null;
  }

  // A key whose words are all in the label AND that names what the label is
  // about: more than half of the label's words ("Signed backlog" → backlog;
  // "Crane rebuild expense" → craneRebuild), or half with a value that states
  // a side's figure. A key naming one word of a longer label is a different
  // thing: "Owner's truck expenses" is not totalExpenses, "Legal fees —
  // shareholder agreement" is not the shareholders' agreement, "Rent paid to
  // holdco" is not annualRent.
  const words = labelWords(finding.field);
  const scored = keys
    .map((k) => ({ k, kw: keyWords(k) }))
    .filter(({ kw }) => kw.length > 0 && kw.every((w) => words.has(w)))
    .map(({ k, kw }) => ({ k, kw, states: statesASide(info, k, finding), share: new Set(kw).size / words.size }))
    .filter(({ share, states }) => share > 0.5 || (share >= 0.5 && states))
    .map(({ k, kw, states }) => ({ k, score: kw.length * 2 + (states ? 3 : 0) + (year && /ByYear$/.test(k) ? 1 : 0) }))
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) return null;
  if (scored.length > 1 && scored[1].score === scored[0].score) return null;
  return done(scored[0].k);
}
