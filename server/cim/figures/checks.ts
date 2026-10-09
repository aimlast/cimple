/**
 * checks — the due-diligence checks: each CIM figure beside the company's
 * other records (spec D4–D6, D9a, D11). Pure: registry + sources + stored
 * located results + the broker's decisions in, checks out.
 *
 *   cim_statements  the CIM's figure vs the statements as issued. Agreeing →
 *                   no check. Worked out by the analysis's one-time lines (D6)
 *                   → `regrouped` ("Financial statements as issued: …").
 *                   Anything else → D9a: a broker-only warning; no check and
 *                   no movement note on that figure reaches buyers.
 *   tax_return /    the other record vs the statements as issued (else the
 *   management      CIM's figure): match / regrouped (D6 families first) /
 *                   differs. A line tax forms group differently (operating
 *                   expenses, EBITDA) is only compared when the difference is
 *                   worked out; otherwise its cell is blank ("Grouped
 *                   differently on the tax return").
 *   restated        next year's statements' comparative vs this year's
 *                   statements (no reason claimed).
 *
 * The broker's decisions: `left_out` always applies (tightening); `shown` and
 * `corrected` apply only while the values are the ones decided on (D10).
 */
import type { FigureRegistry, RegistryFigure } from "@shared/figure-anchors";
import { agrees, reconcileByComponents, sizeOf, type ComponentLine, type Reconciliation } from "@shared/figure-compare";
import { cimMismatchWarning, cimVsStatementsText, differenceComponentsText, groupingOpexText, otherRecordLabel, restatedText } from "@shared/figure-copy";
import type { FigureCheckInput } from "@shared/figure-layer";
import { figureKey, standardLine, standardLineOf, type StandardLineId } from "@shared/figure-lines";
import type { FigureLocatedEntry } from "@shared/schema";
import { locatedEntry } from "./locate";
import { ownValue, sourceFor, sourceRef, type FinancialSource } from "./sources";
import { revenueOf } from "./registry";

export interface CheckDecision {
  checkKey: string;
  state: "shown" | "left_out" | "corrected";
  correctedValue: number | null;
  valuesSnapshot: { base: number; other: number };
}

export interface MismatchWarning {
  year: string;
  items: Array<{ figureKey: string; line: StandardLineId; lineWord: string; cim: number; statements: number; documentId: string }>;
}

export interface NotLocated {
  checkKey: string;
  figureKey: string;
  documentId: string;
  value: number;
  /** "tax return" / "financial statements". */
  docWord: string;
}

export interface ChecksResult {
  checks: FigureCheckInput[];
  /** D9a, grouped by year (the workspace's "Fix first"). */
  mismatches: MismatchWarning[];
  /** D11 failures (the workspace's "Needs checking"). */
  notLocated: NotLocated[];
  /** What needs locating (the refresh locates these, then calls buildChecks again). */
  toLocate: Array<{ documentId: string; updatedAt: string; value: number }>;
}

const near = (a: number, b: number) => Math.abs(Math.abs(a) - Math.abs(b)) <= 0.5;

function atomicLinesOf(reg: FigureRegistry, year: string): RegistryFigure[] {
  return Object.values(reg).filter((f) => f.year === year && f.line.startsWith("line:"));
}

const comp = (f: RegistryFigure): ComponentLine => ({ id: f.key, label: f.lineLabel, value: Math.abs(f.value) });

/** D6 families, per line (tried before the general 1–2 line search). */
function familyFor(line: StandardLineId, kind: "tax_return" | "management" | "cim_statements", reg: FigureRegistry, year: string, statements: FinancialSource | null): ComponentLine[] {
  const atomic = atomicLinesOf(reg, year);
  if (kind === "cim_statements") return atomic.filter((f) => f.category === "Non-Recurring").map(comp);
  switch (line) {
    case "interest":
      return atomic.filter((f) => /\bbank\b|merchant|card (?:fees|processing)|service charges|credit card/i.test(f.lineLabel)).map(comp);
    case "operatingExpenses": {
      // A tax form's operating expenses also carry amortization and interest.
      const amort = ownValue(statements, "amortization") ?? reg[figureKey("amortization", year)]?.value;
      const interest = ownValue(statements, "interest") ?? reg[figureKey("interest", year)]?.value;
      const out: ComponentLine[] = [];
      if (typeof amort === "number" && amort) out.push({ id: "amortization", label: "amortization", value: Math.abs(amort) });
      if (typeof interest === "number" && interest) out.push({ id: "interest", label: "interest", value: Math.abs(interest) });
      return out;
    }
    case "costOfSales":
      return atomic.filter((f) => f.category === "COGS" && /amorti[sz]|depreci/i.test(f.lineLabel)).map(comp);
    case "revenue": {
      const other = reg[figureKey("otherIncome", year)];
      return [
        ...(other ? [{ id: other.key, label: "other income", value: Math.abs(other.value) }] : []),
        ...atomic.filter((f) => f.category === "Other Income").map(comp),
      ];
    }
    default:
      return [];
  }
}

function explanationText(line: StandardLineId, rec: Reconciliation): string {
  const ids = rec.components.map((c) => c.id).sort().join(",");
  if (line === "operatingExpenses" && rec.family && /^(amortization,interest|amortization|interest)$/.test(ids)) {
    return groupingOpexText({
      amortization: rec.components.find((c) => c.id === "amortization")?.value ?? null,
      interest: rec.components.find((c) => c.id === "interest")?.value ?? null,
    });
  }
  const word = standardLine(line)?.blindWord ?? line;
  return differenceComponentsText({ lineWord: word, components: rec.components.map((c) => ({ label: c.label, value: c.value })) });
}

export interface BuildChecksInput {
  registry: FigureRegistry;
  sources: FinancialSource[];
  located: Record<string, FigureLocatedEntry>;
  decisions: CheckDecision[];
  /** Only these figures (the ones the CIM shows); omitted = every standard-line figure. */
  figureKeys?: Iterable<string>;
}

export function buildChecks(input: BuildChecksInput): ChecksResult {
  const { registry: reg, sources, located } = input;
  const decisions = new Map(input.decisions.map((d) => [d.checkKey, d]));
  const keys = input.figureKeys ? new Set(input.figureKeys) : null;
  const checks: FigureCheckInput[] = [];
  const mismatchByYear = new Map<string, MismatchWarning>();
  const notLocated: NotLocated[] = [];
  const toLocate: ChecksResult["toLocate"] = [];

  const find = (src: FinancialSource, value: number) => {
    toLocate.push({ documentId: src.documentId, updatedAt: src.updatedAt, value });
    return locatedEntry(located, src.documentId, src.updatedAt, value);
  };

  for (const fig of Object.values(reg)) {
    if (keys && !keys.has(fig.key)) continue;
    const line = standardLineOf(fig.line);
    if (!line) continue;
    const year = fig.year;
    const st = sourceFor(sources, "statements", year);
    const sValue = ownValue(st, line.id);
    const revenue = revenueOf(reg, year);
    let base = fig.value;
    let baseIsStatements = false;
    let cimMismatch = false;

    // 1. This CIM vs the statements as issued.
    if (st && typeof sValue === "number") {
      const size = sizeOf(fig.value, sValue, revenue);
      const sLoc = find(st, sValue);
      // The other records are compared with the statements as issued in every case.
      base = sValue;
      baseIsStatements = true;
      if (agrees(size)) {
        base = sValue;
        baseIsStatements = true;
      } else {
        const diff = Math.abs(sValue) - Math.abs(fig.value);
        const rec = reconcileByComponents(diff, [], familyFor(line.id, "cim_statements", reg, year, st));
        const compareKey = `cim_statements:${st.documentId}`;
        const key = `${fig.key}~${compareKey}`;
        if (rec) {
          base = sValue;
          baseIsStatements = true;
          const items = rec.components.map((c) => c.label);
          checks.push({
            key, figureKey: fig.key, compareKey, kind: "cim_statements", otherLabel: otherRecordLabel("statements"),
            base: fig.value, other: sValue, sourceLabel: sLoc?.sourceLabel ?? null, size, regrouped: true,
            regroupedText: cimVsStatementsText({ asIssued: sValue, items, total: rec.components.reduce((s, c) => s + c.value, 0), count: rec.components.length }),
            cimMismatch: false, located: !!sLoc, decision: null,
            asIssuedText: cimVsStatementsText({ asIssued: sValue, items, total: rec.components.reduce((s, c) => s + c.value, 0), count: rec.components.length }),
            baseCitation: null, otherCitation: sourceRef(st, { page: sLoc?.page ?? null, value: sValue }),
          });
        } else {
          cimMismatch = true;
          checks.push({
            key, figureKey: fig.key, compareKey, kind: "cim_statements", otherLabel: otherRecordLabel("statements"),
            base: fig.value, other: sValue, sourceLabel: sLoc?.sourceLabel ?? null, size, regrouped: false, regroupedText: null,
            cimMismatch: true, located: !!sLoc, decision: null,
            baseCitation: null, otherCitation: sourceRef(st, { page: sLoc?.page ?? null, value: sValue }),
          });
          const w = mismatchByYear.get(year) ?? { year, items: [] };
          w.items.push({ figureKey: fig.key, line: line.id, lineWord: line.blindWord, cim: fig.value, statements: sValue, documentId: st.documentId });
          mismatchByYear.set(year, w);
        }
      }
    }
    const baseLoc = baseIsStatements && st ? locatedEntry(located, st.documentId, st.updatedAt, base) : null;
    const baseCitation = baseIsStatements && st ? sourceRef(st, { page: baseLoc?.page ?? null, value: base }) : null;

    // 2. The tax return / management accounts vs the statements as issued (else this CIM).
    for (const kind of ["tax_return", "management"] as const) {
      if (line.comparable === "none") continue;
      if (kind === "management" && line.comparable !== "direct") continue;
      const other = sourceFor(sources, kind, year);
      const raw = ownValue(other, line.id);
      if (!other || typeof raw !== "number") continue;
      const compareKey = `${kind}:${other.documentId}`;
      const key = `${fig.key}~${compareKey}`;
      const decision = decisions.get(key) ?? null;
      const corrected = decision?.state === "corrected" && decision.correctedValue !== null && near(decision.valuesSnapshot.base, base) ? decision.correctedValue : null;
      const value = corrected ?? raw;
      const size = sizeOf(base, value, revenue);
      const oLoc = find(other, raw);
      const located = corrected !== null ? true : !!oLoc && (!baseIsStatements || !!baseLoc);
      let regrouped = false;
      let regroupedText: string | null = null;
      if (!agrees(size)) {
        const diff = Math.abs(value) - Math.abs(base);
        const pool = atomicLinesOf(reg, year).map(comp);
        const rec = reconcileByComponents(diff, pool, familyFor(line.id, kind, reg, year, st));
        if (rec) {
          regrouped = true;
          regroupedText = explanationText(line.id, rec);
        } else if (line.comparable === "grouping") {
          // Not like for like on a tax form and not worked out: no comparison (blank cell).
          checks.push({
            key, figureKey: fig.key, compareKey, kind, otherLabel: otherRecordLabel(kind, other.taxForm),
            base, other: value, sourceLabel: null, size, regrouped: false, regroupedText: null, cimMismatch, located, blank: "grouped",
            decision: null, baseCitation, otherCitation: sourceRef(other, { page: oLoc?.page ?? null, value: raw }),
          });
          continue;
        }
      }
      const decided = !decision ? null
        : decision.state === "left_out" ? "left_out"
        : decision.state === "corrected" ? (corrected !== null ? "corrected" : null)
        : near(decision.valuesSnapshot.base, base) && near(decision.valuesSnapshot.other, value) ? "shown" : null;
      checks.push({
        key, figureKey: fig.key, compareKey, kind, otherLabel: otherRecordLabel(kind, other.taxForm),
        base, other: value, sourceLabel: oLoc?.sourceLabel ?? null, size, regrouped, regroupedText, cimMismatch, located,
        decision: decided, baseCitation, otherCitation: sourceRef(other, { page: oLoc?.page ?? null, value: raw }),
      });
      if (!agrees(size) && !located && !cimMismatch) {
        notLocated.push({ checkKey: key, figureKey: fig.key, documentId: !oLoc ? other.documentId : st!.documentId, value: !oLoc ? raw : base, docWord: !oLoc ? (kind === "tax_return" ? "tax return" : "management accounts") : "financial statements" });
      }
    }

    // 3. Restated comparative: next year's statements show this year differently.
    if (st && typeof sValue === "number" && line.comparable !== "none") {
      const next = sourceFor(sources, "statements", String(Number(year) + 1));
      const comparative = next?.values[line.id]?.[year];
      if (next && typeof comparative === "number" && !agrees(sizeOf(sValue, comparative, revenue))) {
        const compareKey = `restated:${next.documentId}`;
        const key = `${fig.key}~${compareKey}`;
        const decision = decisions.get(key) ?? null;
        const cLoc = find(next, comparative);
        checks.push({
          key, figureKey: fig.key, compareKey, kind: "restated", otherLabel: `Financial statements FY${next.year} (comparative)`,
          base: sValue, other: comparative, sourceLabel: cLoc?.sourceLabel ?? null, size: sizeOf(sValue, comparative, revenue),
          regrouped: false, regroupedText: null, cimMismatch, located: !!cLoc && !!locatedEntry(located, st.documentId, st.updatedAt, sValue),
          decision: decision?.state === "left_out" ? "left_out" : decision && near(decision.valuesSnapshot.base, sValue) && near(decision.valuesSnapshot.other, comparative) ? (decision.state === "corrected" ? null : "shown") : null,
          asIssuedText: restatedText({ year, lineWord: line.blindWord, earlier: sValue, later: comparative }),
          baseCitation: sourceRef(st, { value: sValue }), otherCitation: sourceRef(next, { page: cLoc?.page ?? null, value: comparative }),
        });
      }
    }
  }
  const mismatches = Array.from(mismatchByYear.values()).sort((a, b) => a.year.localeCompare(b.year));
  return { checks, mismatches, notLocated, toLocate };
}

/** Lines a mismatch follows from (listed only when nothing more basic disagrees). */
const DERIVED_LINES = new Set<StandardLineId>(["grossProfit", "ebitda", "incomeBeforeTax", "netIncome"]);

/**
 * The broker-only "Fix first" warning for a year (D9a): "Your CIM shows FY2022
 * cost of sales of $20,384,000 and operating expenses of $4,127,000. The FY2022
 * statements say $20,948,200 and $4,282,000. Fix FY2022 on the Financials tab,
 * or explain the difference, before buyers see checks on these figures."
 */
export function mismatchMessage(w: MismatchWarning): string {
  const basic = w.items.filter((i) => !DERIVED_LINES.has(i.line));
  const items = (basic.length > 0 ? basic : w.items).map((i) => ({ lineWord: i.lineWord, cim: i.cim, statements: i.statements }));
  return cimMismatchWarning({ year: w.year, items });
}
