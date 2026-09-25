/**
 * claim-conflicts — what the seller SAID (calls, video calls, emails, the
 * interview, the intake) against what the documents WRITE, for the claims a
 * buyer's diligence checks first — found mechanically, without the model.
 *
 * The one-value-per-fact checks (source-context.ts) only compare two values
 * stored under the same key, and the supporting model's source review
 * (source-review.ts) runs in the background. The planted conflicts that
 * matter most are usually stated under different keys or only in a source's
 * summary, so this reads the sources' digests (summary, key facts, red flags,
 * seller concerns), the facts on file and — for a few claims — the documents'
 * text, and compares like with like:
 *
 *  - backlog:        "$4.2M backlog" said        vs "Remaining backlog $3,100,000" (WIP report)
 *  - owner pay:      "owner salary $260,000"     vs "salary + dividends 240,000" (T2 of the same year)
 *  - concentration:  "no operator over ~25%"     vs "Maplecrest … 41% of LTC revenue"
 *  - key-person tenure: "Daniel (15 years)"      vs the staff list's start date (2014-03-10)
 *  - lease end:      "lease ends 2027"           vs "Lease expires June 30, 2029"
 *
 * Each detector is narrow on purpose: a false conflict makes the interview
 * challenge a true figure, which is worse than missing one (the source review
 * catches the rest). Seller-visible, non-lead sources only — a broker-only
 * row (CRM notes, private emails and files) is never read. Pure.
 */
import type { Document } from "@shared/schema";
import { getFieldSources, getFieldAlternates, isFactKey, repairCharIndexedValue } from "./info-merger";
import { sourceLabel, differentMeasure, type SourceConflict } from "./source-context";

type DocLike = Pick<Document, "id" | "name" | "visibility"> &
  Partial<Pick<Document, "sourceKind" | "sourceMeta" | "createdAt" | "extractedData" | "extractedText">>;

const LEAD_KINDS = new Set(["crm", "website", "social"]);
const SAID_KINDS = new Set(["interview", "call", "video_call", "email", "questionnaire"]);

/** One statement with where it came from. */
interface Stmt {
  text: string;
  /** Label for the agent ("said on a call (Jan 29, 2025)", "document: WIP report …"). */
  source: string;
  /** Years the statement is about: in its own words, else a document's title. */
  years: number[];
  /** Year the statement was made (a call's or email's date), when known. */
  madeIn?: number;
}

const yearsOf = (t: string): number[] => (t.match(/(?<!\d)(?:19|20)\d{2}(?!\d)/g) ?? []).map(Number);
const clip = (t: string, n = 170) => {
  const s = t.replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

/** Split a digest into clauses (keyFacts are comma/semicolon lists; parentheses stay whole). */
function clauses(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(") depth++;
    if (c === ")" && depth > 0) depth--;
    const numericComma = c === "," && /\d/.test(text[i - 1] ?? "") && /\d/.test(text[i + 1] ?? "");
    const end = depth === 0 && ((c === "," && !numericComma) || c === ";" || c === "\n" || (c === "." && /\s/.test(text[i + 1] ?? "") && !/\d/.test(text[i - 1] ?? "")));
    if (end) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** A clause that quotes a document or compares two figures — not the seller's own claim. */
const NOT_A_CLAIM_RE = /\b(vs\.?|versus|discrepanc|conflict|report shows|statements? show|shows?|per (?:the )?(?:report|statements?|p&l|t2|return|list)|according to (?:the )?(?:report|statements?|list))\b/i;

function dateYear(doc: DocLike): number | undefined {
  const meta = (doc.sourceMeta as { date?: string } | null | undefined)?.date;
  const y = meta ? yearsOf(String(meta))[0] : undefined;
  return y;
}

/** The statements each side makes: digests of seller-visible sources + the facts on file. */
function statements(documents: DocLike[], viewInfo: Record<string, unknown>) {
  const docs = new Map(documents.map((d) => [d.id, d]));
  const said: Stmt[] = [];
  const written: Stmt[] = [];
  for (const d of documents) {
    if (d.visibility === "broker_only" || LEAD_KINDS.has(String(d.sourceKind))) continue;
    const data = (d.extractedData as Record<string, unknown> | null | undefined) || null;
    if (!data) continue;
    const kind = String(d.sourceKind || "document");
    const isSaid = SAID_KINDS.has(kind);
    const label = sourceLabel({ source: kind as never, documentId: d.id }, docs);
    const titleYears = isSaid ? [] : yearsOf(d.name);
    for (const field of ["summary", "keyFacts", "redFlags", "sellerConcerns"]) {
      const raw = data[field];
      const text = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.join("; ") : "";
      for (const c of clauses(text)) {
        const own = yearsOf(c);
        (isSaid ? said : written).push({ text: c, source: label, years: own.length ? own : titleYears, madeIn: isSaid ? dateYear(d) : undefined });
      }
    }
  }
  // Facts on file, and the other values kept for them.
  const sources = getFieldSources(viewInfo);
  const alternates = getFieldAlternates(viewInfo);
  const push = (value: string, src: { source?: unknown; documentId?: string } | undefined) => {
    const kind = String(src?.source ?? "");
    if (!kind || LEAD_KINDS.has(kind) || kind === "broker" || kind === "system") return;
    const doc = src?.documentId ? docs.get(src.documentId) : undefined;
    if (src?.documentId && (!doc || doc.visibility === "broker_only")) return;
    const label = sourceLabel(src as never, docs);
    const titleYears = doc && kind === "document" ? yearsOf(doc.name) : [];
    for (const c of clauses(value)) {
      const own = yearsOf(c);
      const stmt = { text: c, source: label, years: own.length ? own : titleYears, madeIn: doc && kind !== "document" ? dateYear(doc) : undefined };
      (SAID_KINDS.has(kind) ? said : kind === "document" ? written : null)?.push(stmt);
    }
  };
  for (const [key, raw] of Object.entries(viewInfo)) {
    if (!isFactKey(key)) continue;
    const v = repairCharIndexedValue(raw);
    if (typeof v !== "string" || !v.trim()) continue;
    push(v, sources[key]);
    for (const alt of alternates[key] ?? []) if (alt && typeof alt.value === "string") push(alt.value, alt);
  }
  return { said, written, docs };
}

// ─── figures ────────────────────────────────────────────────────────────

/** Currency amounts in a text ("$4.2M", "$3,100,000", "260K", "240,000"). */
function amounts(text: string, min = 10_000): number[] {
  const out: number[] = [];
  const re = /\$?\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k|m|mm|million|thousand)?\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    let n = parseFloat(m[1].replace(/,/g, ""));
    if (Number.isNaN(n)) continue;
    const suf = (m[2] || "").toLowerCase();
    const hasDollar = /\$/.test(m[0]);
    if (!suf && !hasDollar && n >= 1900 && n <= 2099 && !m[1].includes(",")) continue; // a year
    if (suf === "k" || suf === "thousand") n *= 1e3;
    if (suf === "m" || suf === "mm" || suf === "million") n *= 1e6;
    if (n >= min) out.push(n);
  }
  return out;
}

/** Un-glues words PDF extraction ran together ("totalSalary + dividends240,000" → "total Salary + dividends 240,000"). */
const tidy = (t: string) =>
  t.replace(/([a-z]{3,})([A-Z])/g, "$1 $2").replace(/([A-Za-z])(\d)/g, "$1 $2").replace(/\s+/g, " ").trim();

const within = (a: number, b: number, tol: number) => Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-9) <= tol;
const periodsCompatible = (a: Stmt, b: Stmt) => a.years.length === 0 || b.years.length === 0 || a.years.some((y) => b.years.includes(y));

function conflict(key: string, topic: string, a: Stmt, b: Stmt, critical = true): SourceConflict {
  return {
    key,
    topic,
    values: [{ value: clip(a.text), source: a.source }, { value: clip(b.text), source: b.source }],
    critical,
    origin: "alternates",
  };
}

// ─── detectors ──────────────────────────────────────────────────────────

/** Backlog / order book: the figure said vs the document's total. */
function backlogConflicts(said: Stmt[], written: Stmt[]): SourceConflict[] {
  const RE = /\b(backlog|order book)\b/i;
  const saidFigs = said
    .filter((s) => RE.test(s.text) && !NOT_A_CLAIM_RE.test(s.text))
    .map((s) => ({ s, n: amounts(s.text) }))
    .filter((x) => x.n.length === 1);
  const writtenFigs = written
    .filter((w) => RE.test(w.text) && !/\bby (segment|customer|job|division)\b|\bopen quotes?\b/i.test(w.text))
    .map((w) => ({ w, n: amounts(w.text) }))
    .filter((x) => x.n.length > 0);
  for (const { s, n: [value] } of saidFigs) {
    const comparable = writtenFigs.filter(({ w }) => periodsCompatible(s, w) && !differentMeasure(s.text, w.text));
    if (comparable.some(({ n }) => n.some((x) => within(x, value, 0.04)))) continue; // a document agrees
    const hit = comparable.find(({ n }) => n.some((x) => !within(x, value, 0.04) && within(x, value, 0.6)));
    if (hit) return [conflict("backlog", "backlog", s, hit.w)];
  }
  return [];
}

/** Owner pay said vs what the tax return / statements record for the owner. */
function ownerPayConflicts(said: Stmt[], documents: DocLike[], docs: Map<string, DocLike>, ownerNames: string[]): SourceConflict[] {
  const SAID_RE = /\b(?:owner'?s?|my|his|her|seller'?s?)\s+(?:own\s+)?(?:salary|pay|compensation|comp|wages?|draw)\b|\bsalary\s*\((?:me|owner)\)/i;
  const saidFigs = said
    .filter((s) => SAID_RE.test(s.text) && !NOT_A_CLAIM_RE.test(s.text) && !/\b(market|replacement|manager|gm|hire)\b/i.test(s.text))
    .map((s) => ({ s, n: amounts(s.text) }))
    .filter((x) => x.n.length === 1);
  if (saidFigs.length === 0) return [];
  const names = ownerNames.map((n) => n.toLowerCase()).filter((n) => n.length >= 3);
  // No leading word boundary: PDF text glues words ("totalSalary + dividends240,000").
  const PAY_RE = /(salary|salaries|\bt4\b|employment income|compensation|wages?\b)/i;
  const WHO_RE = /\b(owner|majority shareholder|sole shareholder|principal shareholder|president)\b/i;
  const lines: Stmt[] = [];
  for (const d of documents) {
    if (d.visibility === "broker_only" || String(d.sourceKind || "document") !== "document") continue;
    const text = typeof d.extractedText === "string" ? d.extractedText : "";
    if (!text) continue;
    const label = sourceLabel({ source: "document", documentId: d.id }, docs);
    for (const line of text.split(/\n+/)) {
      if (line.length > 240 || !PAY_RE.test(line)) continue;
      const lower = line.toLowerCase();
      if (!WHO_RE.test(line) && !names.some((n) => lower.includes(n))) continue;
      if (/\b(market|replacement|spouse|wife|husband|son|daughter)\b/i.test(line)) continue;
      if (amounts(line).length === 0) continue;
      lines.push({ text: line.trim(), source: label, years: yearsOf(line).length ? yearsOf(line) : yearsOf(d.name) });
    }
  }
  for (const { s, n: [value] } of saidFigs) {
    const same = lines.filter((w) => periodsCompatible(s, w));
    if (same.length === 0) continue;
    if (same.some((w) => amounts(w.text).some((x) => within(x, value, 0.04)))) continue;
    // The document's total for the owner (salary + dividends) when it gives one.
    const pick = same.find((w) => /\btotal\b|\+\s*dividends?/i.test(w.text)) ?? same[0];
    const docValue = amounts(pick.text).sort((a, b) => b - a)[0];
    if (docValue && within(docValue, value, 0.6)) return [conflict("ownerCompensation", "owner pay", s, { ...pick, text: tidy(pick.text) })];
  }
  return [];
}

/** "No customer/operator over ~X%" said vs a named one above it in a document. */
function concentrationConflicts(said: Stmt[], written: Stmt[]): SourceConflict[] {
  const CAP_RE = /\bno (?:single |one |individual )?(?:customer|client|operator|account|payer|home|buyer|contract|group)s?\b[^.;]{0,60}?\b(?:over|more than|above|exceeds?|greater than|bigger than|beyond)\s+(?:about |roughly |around |~\s?)?(?:(\d{1,2}(?:\.\d+)?)\s*%|(a quarter|a third|half))/i;
  const SHARE_RE = /\b([A-Z][A-Za-z&'’.-]{2,}(?:\s+[A-Z][A-Za-z&'’.-]{2,}){0,3})\b[^;%]{0,80}?\(?~?\s?(\d{1,2}(?:\.\d+)?)\s*%\s+of\s+(?:(?:the|its|total|our)\s+)?([A-Za-z&/ -]{0,24}?)\s*(?:revenue|sales|billings|book)\b/;
  for (const s of said) {
    const m = s.text.match(CAP_RE);
    if (!m) continue;
    const cap = m[1] ? parseFloat(m[1]) : m[2] === "half" ? 50 : m[2] === "a third" ? 33.3 : 25;
    const base = (s.text.match(/\b(LTC|retail|wholesale|commercial|residential|community|institutional|government|automotive|medical)\b/i)?.[1] ?? "").toLowerCase();
    for (const w of written) {
      // One customer's share — not a revenue line ("Managed services … 72%
      // of revenue") or an aggregate ("Top 20 contracts … 41%").
      if (!/\b(customer|client|operator|account|payer|MSA|homes?|contract with|largest|biggest)\b/i.test(w.text)) continue;
      if (/\b(services|segment|stream|product|category|recurring|line of business)\b|\btop\s+(?:\d+|three|five|ten|twenty)\b|\b(combined|together|in total|all)\b/i.test(w.text)) continue;
      // A cap stated in the document ("no single customer over 10%") is not a named share.
      if (CAP_RE.test(w.text) || /\bno (?:single |one )?(?:customer|client|operator)\b/i.test(w.text)) continue;
      const x = w.text.match(SHARE_RE);
      if (!x) continue;
      const share = parseFloat(x[2]);
      const wBase = x[3].trim().toLowerCase();
      if (base ? !wBase.includes(base) : wBase.length > 0 && !/^(fy)?\s*\d*$/.test(wBase)) continue;
      if (share > cap + 3 && periodsCompatible(s, w)) return [conflict("customerConcentration", "customer concentration", s, w)];
    }
  }
  return [];
}

const SPELLED: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, "twenty-five": 25, thirty: 30,
};

/** A named key person's years with the business said vs the start date a document records. */
function tenureConflicts(said: Stmt[], documents: DocLike[], docs: Map<string, DocLike>, asOf: number | undefined): SourceConflict[] {
  // "Daniel (15 years, pharmacist)", "Paulo Fernandes (14 years)", "Daniel's been with me fifteen years".
  const SAID_RE = /\b((?:[A-Z][a-z]{2,})(?:\s+[A-Z][a-z]{2,})?)\b(?:\s*\(|'s been with (?:me|us|the (?:company|business))(?: for)?|,? (?:who )?has been (?:here|with (?:me|us|the (?:company|business)))(?: for)?|,? (?:with (?:me|us|the (?:company|business)) )?for)\s*(\d{1,2}|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|twenty-five|thirty)(\+)?\s+years?\b(?!\s+(?:old|ago|of (?:age|experience)))/;
  const FUTURE_OR_OTHER = /\b(lease|term|warranty|loan|contract|agreement|msa|option|renewal|extend|another|more|next|plan|plans|retire|retiring|post-close|transition|stay|within|in ~|over the next|experience|industry|career|licensed|certified)\b/i;
  const out: SourceConflict[] = [];
  for (const s of said) {
    const m = s.text.match(SAID_RE);
    if (!m || FUTURE_OR_OTHER.test(s.text)) continue;
    const fullName = m[1];
    const nameWords = fullName.split(/\s+/);
    if (nameWords.some((w) => /^(The|This|That|Our|Their|His|Her|Owner|Seller|Broker|Company|Business|Years?|About|Over|Since|Total|Key|Staff|Team)$/.test(w))) continue;
    const name = nameWords[0];
    const years = /^\d+$/.test(m[2]) ? parseInt(m[2], 10) : SPELLED[m[2].toLowerCase()] ?? NaN;
    if (!years || years < 3) continue;
    const ref = s.madeIn ?? asOf;
    if (!ref) continue;
    // The document's start date for that person: a roster row or a line naming them.
    for (const d of documents) {
      if (d.visibility === "broker_only" || String(d.sourceKind || "document") !== "document") continue;
      const text = typeof d.extractedText === "string" ? d.extractedText : "";
      for (const line of text.split(/\n+/)) {
        // The name as the seller used it (a first name alone, or first + last together).
        if (!new RegExp(`\\b${nameWords.join("\\s+")}\\b`).test(line) || line.length > 400) continue;
        const start =
          line.match(/\b((?:19|20)\d{2})-\d{2}-\d{2}\b/)?.[1] ??
          line.match(/\b(?:since|hired|joined|started)\s+(?:in\s+)?(?:[A-Z][a-z]+\s+)?((?:19|20)\d{2})\b/i)?.[1];
        if (!start) continue;
        const docYears = ref - parseInt(start, 10);
        // "10+ years" is a floor: any longer tenure agrees with it.
        const atLeast = !!m[3] || /\b(over|more than|at least)\s+$/i.test(s.text.slice(0, s.text.indexOf(m[2])));
        if (docYears <= 0 || Math.abs(docYears - years) < 2 || (atLeast && docYears >= years)) break;
        const written: Stmt = { text: `${clip(tidy(line), 140)} (joined ${start} — about ${docYears} years)`, source: sourceLabel({ source: "document", documentId: d.id }, docs), years: [] };
        out.push(conflict(`${name.charAt(0).toLowerCase()}${name.slice(1)}Tenure`, `${name}'s years with the business`, s, written));
        break;
      }
      if (out.length) break;
    }
    if (out.length) break;
  }
  return out;
}

/** The lease's end year said vs the lease document's. */
function leaseEndConflicts(said: Stmt[], written: Stmt[]): SourceConflict[] {
  const END_RE = /\blease\b[^.;]{0,60}?\b(?:ends?|ending|expires?|expiring|expiry|runs?(?: out)?(?: to| through| until)?|until|through|to)\b[^.;]{0,25}?\b((?:19|20)\d{2})\b/i;
  const NOT_PREMISES = /\b(equipment|machine|machines|vehicles?|trucks?|vans?|cars?|copier|packag\w*|packager|forklift|software|capital lease|finance lease|photocopier|printer|pos|terminal)\b/i;
  for (const s of said) {
    const m = s.text.match(END_RE);
    if (!m || NOT_PREMISES.test(s.text) || NOT_A_CLAIM_RE.test(s.text)) continue;
    const saidYear = parseInt(m[1], 10);
    const docEnds = written
      .filter((w) => !NOT_PREMISES.test(w.text))
      .map((w) => ({ w, y: w.text.match(END_RE)?.[1] }))
      .filter((x): x is { w: Stmt; y: string } => !!x.y)
      .map((x) => ({ w: x.w, y: parseInt(x.y, 10) }));
    if (docEnds.length === 0 || docEnds.some((x) => x.y === saidYear)) continue; // another lease, or agreement
    // Several premises on file (a lease per location): only a clause naming the same place compares.
    const place = s.text.match(/\b([A-Z][a-z]{3,})\b(?=[^.;]{0,30}\blease\b)/)?.[1];
    const target = place ? docEnds.find((x) => x.w.text.includes(place)) : new Set(docEnds.map((x) => x.y)).size === 1 ? docEnds[0] : undefined;
    if (target) return [conflict("leaseExpiry", "when the lease ends", s, target.w)];
  }
  return [];
}

/**
 * Conflicts between what the seller said and what the documents write, for
 * backlog, owner pay, customer concentration, key-person tenure and the lease
 * end. `ownerNames` are the owner's names on file (to find their pay lines);
 * `asOf` the deal's latest fiscal year (source-context dealAsOfYear).
 */
export function claimConflicts(
  documents: DocLike[],
  viewInfo: Record<string, unknown>,
  opts: { ownerNames?: string[]; asOf?: number } = {},
): SourceConflict[] {
  const { said, written, docs } = statements(documents, viewInfo);
  return [
    ...backlogConflicts(said, written),
    ...ownerPayConflicts(said, documents, docs, opts.ownerNames ?? []),
    ...concentrationConflicts(said, written),
    ...tenureConflicts(said, documents, docs, opts.asOf),
    ...leaseEndConflicts(said, written),
  ];
}
