/**
 * candidates — which figures need a "why" (spec D8, D13). Pure.
 *
 *   movementTargets   material movements the CIM shows or implies: atomic
 *                     lines it shows, the lines that moved a total it shows
 *                     (D7), and a total D7 can't break down
 *   aiCandidates      what the AI pass may explain (≤ 16, largest first):
 *                     atomic movements and material differences D6 doesn't
 *                     work out — never one the broker owns, never a figure
 *                     held by D9a, never one already written for these inputs
 *   explainCandidates what the seller may be asked (D13): the same targets
 *                     on askable lines with nothing on file — no note, no
 *                     recorded reason, no analysis hint and no conflict about
 *                     the same line and year
 */
import type { FigureRegistry, RegistryFigure } from "@shared/figure-anchors";
import { agrees, differenceOf } from "@shared/figure-compare";
import { captureKeyFor } from "@shared/figure-explain";
import { cimMismatchHeld, type FigureCheckInput } from "@shared/figure-layer";
import { baseLineOf, figureKey, lineWords, parseFigureKey, standardLine, standardLineOf, type LineId } from "@shared/figure-lines";
import { fingerprintOf, movedEnough, movementOf, previousOf } from "./computed";
import { revenueOf } from "./registry";

export interface FigureCandidate {
  /** "<figureKey>|<kind>|<compareKey>" (= the note's unique key). */
  key: string;
  figureKey: string;
  kind: "movement" | "difference";
  /** movement: the earlier year; difference: "<kind>:<documentId>". */
  compareKey: string;
  line: LineId;
  lineLabel: string;
  year: string;
  value: number;
  fromYear?: string;
  fromValue?: number;
  /** difference: the other record's figure and what it is. */
  other?: number;
  otherKind?: "tax_return" | "management";
  otherLabel?: string;
  checkKey?: string;
  /** |change or difference| / that year's revenue: the ranking. */
  weight: number;
  total: boolean;
  /** Fingerprint of the figures alone (the build adds its evidence digest). */
  valuesFingerprint: string;
}

/** Statuses on which the broker owns a note (the machine only proposes beside it). */
function brokerOwns(n: { status: string; origin: string; editedAt?: unknown }): boolean {
  return n.origin === "broker" || n.status === "approved" || n.status === "hidden" || !!n.editedAt;
}

const keyOf = (figureKey: string, kind: string, compareKey: string) => `${figureKey}|${kind}|${compareKey}`;

function weightOf(reg: FigureRegistry, year: string, delta: number): number {
  const rev = revenueOf(reg, year);
  return Math.abs(delta) / (rev && Math.abs(rev) > 0 ? Math.abs(rev) : 1e9);
}

function movementCandidate(reg: FigureRegistry, fig: RegistryFigure, prev: RegistryFigure): FigureCandidate {
  const delta = Math.abs(fig.value) - Math.abs(prev.value);
  return {
    key: keyOf(fig.key, "movement", prev.year),
    figureKey: fig.key, kind: "movement", compareKey: prev.year,
    line: fig.line, lineLabel: fig.lineLabel, year: fig.year, value: fig.value,
    fromYear: prev.year, fromValue: prev.value,
    weight: weightOf(reg, fig.year, delta), total: !!fig.total,
    valuesFingerprint: fingerprintOf(["movement", fig.key, fig.value, prev.value]),
  };
}

/**
 * Figures held by D9a: a CIM figure that disagrees with its statements,
 * unexplained, and (with the registry) the derived totals of that year worked
 * out from it — EBITDA, gross profit, income before taxes, net income.
 */
export function heldFigures(checks: ReadonlyArray<FigureCheckInput>, reg?: FigureRegistry | null): Set<string> {
  return cimMismatchHeld(checks, reg);
}

/**
 * The movements the CIM shows or implies, material (≥ 8% and ≥ $2,500),
 * never touching a D9a figure. `undecomposedTotals` adds a total D7 can't
 * break down (the questions' case b).
 */
export function movementTargets(
  reg: FigureRegistry,
  anchoredKeys: Iterable<string>,
  checks: ReadonlyArray<FigureCheckInput>,
  opts: { undecomposedTotals?: boolean } = {},
): FigureCandidate[] {
  const held = heldFigures(checks, reg);
  const out = new Map<string, FigureCandidate>();
  const add = (fig: RegistryFigure | undefined) => {
    if (!fig) return;
    const prev = previousOf(reg, fig);
    if (!prev || held.has(fig.key) || held.has(prev.key)) return;
    if (!movedEnough(prev.value, fig.value)) return;
    const c = movementCandidate(reg, fig, prev);
    out.set(c.key, c);
  };
  for (const key of Array.from(new Set(anchoredKeys))) {
    const fig = reg[key];
    if (!fig) continue;
    if (String(fig.line).startsWith("line:")) {
      add(fig);
      continue;
    }
    // A total: the lines that moved it (D7), else the total itself.
    const prev = previousOf(reg, fig);
    if (!prev) continue;
    if ((fig.components ?? []).some((c) => c.sign < 0)) continue; // profit lines: a part can move more than the total
    if (held.has(fig.key) || held.has(prev.key)) {
      // D9a: the total itself is the broker's to fix, but the lines inside it
      // still moved (Pacific's fuel 2022 → 2023): its three largest movers.
      const movers = (fig.components ?? [])
        .map((c) => reg[c.key])
        .filter((c): c is RegistryFigure => !!c)
        .map((c) => ({ c, p: previousOf(reg, c) }))
        .filter((x) => !!x.p && movedEnough(x.p.value, x.c.value))
        .sort((a, b) => Math.abs(Math.abs(b.c.value) - Math.abs(b.p!.value)) - Math.abs(Math.abs(a.c.value) - Math.abs(a.p!.value)))
        .slice(0, 3);
      for (const m of movers) add(m.c);
      continue;
    }
    if (!movedEnough(prev.value, fig.value)) continue;
    const breakdown = movementOf(reg, fig);
    if (breakdown && breakdown.parts.length > 0) {
      for (const p of breakdown.parts) add(reg[p.id]);
    } else if (opts.undecomposedTotals) {
      add(fig);
    }
  }
  return Array.from(out.values());
}

/** Material differences between the statements and another record that D6 doesn't work out. */
export function differenceTargets(reg: FigureRegistry, checks: ReadonlyArray<FigureCheckInput>, anchoredKeys?: Iterable<string>): FigureCandidate[] {
  const shown = anchoredKeys ? new Set(anchoredKeys) : null;
  const held = heldFigures(checks, reg);
  const out: FigureCandidate[] = [];
  for (const c of checks) {
    if (c.kind !== "tax_return" && c.kind !== "management") continue;
    if (c.blank || c.regrouped || c.cimMismatch || held.has(c.figureKey) || !c.located || c.decision === "left_out") continue;
    if (agrees(c.size) || c.size !== "material") continue;
    if (shown && !shown.has(c.figureKey)) continue;
    const fig = reg[c.figureKey];
    if (!fig) continue;
    out.push({
      key: keyOf(c.figureKey, "difference", c.compareKey),
      figureKey: c.figureKey, kind: "difference", compareKey: c.compareKey,
      line: fig.line, lineLabel: fig.lineLabel, year: fig.year, value: c.base,
      other: c.other, otherKind: c.kind, otherLabel: c.otherLabel, checkKey: c.key,
      weight: weightOf(reg, fig.year, differenceOf(c.base, c.other, !!c.signed)), total: !!fig.total,
      valuesFingerprint: fingerprintOf(["difference", c.key, c.base, c.other]),
    });
  }
  return out;
}

export interface CandidateNoteRow {
  figureKey: string;
  kind: string;
  compareKey: string;
  status: string;
  origin: string;
  editedAt?: unknown;
  inputFingerprint: string;
}

/** The AI pass's candidates: ≤ `max`, largest first. `fingerprintFor` adds the evidence digest. */
export function aiCandidates(input: {
  registry: FigureRegistry;
  anchoredKeys: Iterable<string>;
  checks: ReadonlyArray<FigureCheckInput>;
  notes: ReadonlyArray<CandidateNoteRow>;
  scope: "changed" | "all";
  /** "<key>@<fingerprint>" the AI already found nothing for. */
  noReason?: ReadonlyArray<string>;
  fingerprintFor: (c: FigureCandidate) => string;
  max?: number;
}): Array<FigureCandidate & { fingerprint: string }> {
  const keys = Array.from(new Set(input.anchoredKeys));
  const all = [
    ...movementTargets(input.registry, keys, input.checks).filter((c) => !c.total),
    ...differenceTargets(input.registry, input.checks, keys),
  ];
  const notes = new Map(input.notes.map((n) => [keyOf(n.figureKey, n.kind, n.compareKey), n]));
  const noReason = new Set(input.noReason ?? []);
  const out: Array<FigureCandidate & { fingerprint: string }> = [];
  for (const c of all) {
    const fingerprint = input.fingerprintFor(c);
    const row = notes.get(c.key);
    if (row && (brokerOwns(row) || row.origin === "computed")) continue;
    if (input.scope === "changed") {
      if (row && row.inputFingerprint === fingerprint) continue;
      if (noReason.has(`${c.key}@${fingerprint}`)) continue;
    }
    out.push({ ...c, fingerprint });
  }
  out.sort((a, b) => b.weight - a.weight || a.key.localeCompare(b.key));
  return out.slice(0, input.max ?? 16);
}

// ── Questions for the seller (D13) ─────────────────────────────────────────

/** Lines the seller is never asked about: earnings, margins, taxes, pay, add-back material. */
export function askableLine(fig: Pick<RegistryFigure, "line" | "category">): boolean {
  const std = standardLineOf(fig.line);
  if (std && !std.askable) return false;
  // Never pay, one-time items (add-back material) or taxes (the accountant's computation) —
  // whatever the line is called.
  if (fig.category === "Owner Compensation" || fig.category === "Non-Recurring" || fig.category === "Taxes") return false;
  return true;
}

/**
 * Why the seller can't be asked about a figure (null = they can): earnings,
 * taxes, pay and one-time lines never (the money-talk rule), and nothing
 * measured from or to a figure held because the CIM doesn't match the
 * statements (D9a — fix it first). The route's last word before anything
 * reaches the seller's follow-up email (checker r2 R2-4).
 */
export function sellerAskRefusal(
  reg: FigureRegistry,
  checks: ReadonlyArray<FigureCheckInput>,
  key: string,
  kind: "movement" | "difference" | "context" = "movement",
): string | null {
  const fig = reg[key];
  if (!fig) return "That figure isn't in this CIM any more.";
  // "Income taxes" → "income taxes"; an acronym ("EBITDA") keeps its capitals.
  const word = fig.lineLabel.replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase());
  if (!askableLine(fig)) return `Cimple doesn't ask the seller about ${word}: it's worked out from other figures or by the accountant. Write the reason yourself.`;
  const held = heldFigures(checks, reg);
  const prev = kind === "movement" ? previousOf(reg, fig) : null;
  const heldYear = held.has(key) ? fig.year : prev && held.has(prev.key) ? prev.year : null;
  if (heldYear) return `The CIM's FY${heldYear} figures don't match the statements. Fix FY${heldYear} first.`;
  return null;
}

export interface DiscrepancyLike {
  field: string | null;
  factKey?: string | null;
  factYear?: string | null;
  status?: string | null;
}

/** Is a conflict (live or settled) about this line and year? */
export function discrepancyAbout(d: DiscrepancyLike, line: LineId, label: string, year: string): boolean {
  const std = standardLine(baseLineOf(line));
  const fk = String(d.factKey ?? "");
  const fy = String(d.factYear ?? "");
  if (std && fk && std.factKeys.includes(fk) && (!fy || fy === year)) return true;
  const field = `${d.field ?? ""} ${fk.replace(/([a-z])([A-Z])/g, "$1 $2")}`.toLowerCase();
  if (!field.includes(year) && fy !== year) return false;
  const words = lineWords(line, label).map((w) => w.toLowerCase()).filter((w) => w.length >= 3);
  return words.some((w) => new RegExp(`(?:^|[^a-z])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(field));
}

/** A recorded reason for this figure: its capture key, or any reason* fact naming its line and year. */
export function reasonOnFile(facts: Record<string, unknown>, c: Pick<FigureCandidate, "lineLabel" | "kind" | "year">): boolean {
  const capture = captureKeyFor(c.lineLabel, c.kind, c.year);
  const has = (k: string) => {
    const v = facts[k];
    return v !== undefined && v !== null && String(v).trim() !== "";
  };
  if (has(capture)) return true;
  const stem = capture.replace(/(?:Change|Difference)\d{4}$/, "").toLowerCase();
  return Object.keys(facts).some((k) => !k.startsWith("_") && /^reason/i.test(k) && k.toLowerCase().startsWith(stem) && k.includes(c.year) && has(k));
}

/**
 * The seller-question targets (D13 a–c), ranked by |Δ| / revenue, with
 * everything that already answers or covers them removed.
 */
export function explainCandidates(input: {
  registry: FigureRegistry;
  anchoredKeys: Iterable<string>;
  checks: ReadonlyArray<FigureCheckInput>;
  notes: ReadonlyArray<CandidateNoteRow>;
  facts: Record<string, unknown>;
  hints: Record<string, string>;
  discrepancies: ReadonlyArray<DiscrepancyLike>;
}): FigureCandidate[] {
  const keys = Array.from(new Set(input.anchoredKeys));
  const targets = [
    ...movementTargets(input.registry, keys, input.checks, { undecomposedTotals: true }),
    ...differenceTargets(input.registry, input.checks, keys),
  ];
  const noted = new Set(input.notes.filter((n) => n.status !== "hidden").map((n) => keyOf(n.figureKey, n.kind, n.compareKey)));
  const notedFigure = new Set(input.notes.filter((n) => n.status !== "hidden" && (n.kind === "movement" || n.kind === "context")).map((n) => n.figureKey));
  const out: FigureCandidate[] = [];
  for (const c of targets) {
    const fig = input.registry[c.figureKey];
    if (!fig || !askableLine(fig)) continue;
    if (noted.has(c.key) || (c.kind === "movement" && notedFigure.has(c.figureKey))) continue;
    if (reasonOnFile(input.facts, c)) continue;
    if (input.hints[c.figureKey]) continue;
    if (input.discrepancies.some((d) => discrepancyAbout(d, c.line, c.lineLabel, c.year))) continue;
    out.push(c);
  }
  out.sort((a, b) => b.weight - a.weight || a.key.localeCompare(b.key));
  return out;
}

/** The figures a deal's CIM will show when there is no CIM yet (planning during the interview): the P&L totals. */
export function defaultShownKeys(reg: FigureRegistry): string[] {
  const totals = new Set(["revenue", "costOfSales", "operatingExpenses", "interest", "amortization", "incomeTaxes"]);
  const years = Array.from(new Set(Object.values(reg).map((f) => f.year))).sort().slice(-3);
  return Object.values(reg).filter((f) => totals.has(String(f.line)) && years.includes(f.year)).map((f) => f.key);
}

/** The year before a figure's year, and its key (movement helpers for callers). */
export function priorKey(key: string): string | null {
  const p = parseFigureKey(key);
  return p ? figureKey(p.line, String(Number(p.year) - 1)) : null;
}

/**
 * What an "Ask the seller" request may send (checker r2 R2-4): the questions
 * and figures the seller may be asked about, and the refused ones with why.
 * `reject` = nothing left to ask (the route answers 422 with the reason).
 */
export function planSellerAsk(
  raw: { registry: FigureRegistry; checks: { checks: ReadonlyArray<FigureCheckInput> }; questions: ReadonlyArray<{ id: string; figureKey: string; kind: string }> },
  req: { questionIds?: string[]; figureKeys?: string[] },
): { questionIds: string[]; figureKeys: string[]; refused: Array<{ figureKey: string; reason: string }>; reject: string | null } {
  const refused: Array<{ figureKey: string; reason: string }> = [];
  const questionIds: string[] = [];
  const figureKeys: string[] = [];
  for (const id of req.questionIds ?? []) {
    const q = raw.questions.find((x) => x.id === id);
    const why = q ? sellerAskRefusal(raw.registry, raw.checks.checks, q.figureKey, q.kind as "movement" | "difference" | "context") : null;
    if (why) refused.push({ figureKey: q!.figureKey, reason: why });
    else questionIds.push(id);
  }
  for (const key of req.figureKeys ?? []) {
    const why = sellerAskRefusal(raw.registry, raw.checks.checks, key);
    if (why) refused.push({ figureKey: key, reason: why });
    else figureKeys.push(key);
  }
  const asked = (req.questionIds?.length ?? 0) + (req.figureKeys?.length ?? 0);
  const reject = asked > 0 && refused.length === asked
    ? (refused.length === 1 ? refused[0].reason : "None of these can go to the seller. Write the reasons yourself.")
    : null;
  return { questionIds, figureKeys, refused, reject };
}
