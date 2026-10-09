/**
 * computed — the notes Cimple can write at $0 (spec D6, D7), as machine
 * upserts for the refresh. Every one starts `suggested`; buyers see it only
 * after the broker approves it (D9).
 *
 *   movement    a total that changed ≥ 8% (and ≥ $2,500) from the year
 *               before, broken into the ≤ 3 lines that moved it (≥ 70% of
 *               the change). Measured on the CIM's own figures. Never on a
 *               figure held by D9a (its CIM figure disagrees with its
 *               statements), from or to.
 *   difference  a D6 reconciliation (the tax return's line includes …), so
 *               the workspace lists it; buyers get the same text from the
 *               check itself once the checks are on.
 */
import { createHash } from "node:crypto";
import type { FigureRegistry, RegistryFigure } from "@shared/figure-anchors";
import { decomposeMovement } from "@shared/figure-compare";
import { movementBlindText, movementText } from "@shared/figure-copy";
import type { FigureCheckInput } from "@shared/figure-layer";
import { figureKey, parseFigureKey, standardLineOf } from "@shared/figure-lines";
import type { MachineNote } from "./store";

/** Changes smaller than this share of the earlier figure get no suggested note. */
export const MOVEMENT_THRESHOLD = 0.08;
const MIN_MOVEMENT = 2500;

export function fingerprintOf(parts: unknown): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 24);
}

/** A material movement worth a note (D7 / the workspace's "Why figures moved"). */
export function movedEnough(from: number, to: number): boolean {
  const d = Math.abs(Math.abs(to) - Math.abs(from));
  return d >= MIN_MOVEMENT && Math.abs(from) > 0 && d / Math.abs(from) >= MOVEMENT_THRESHOLD;
}

/** The previous year's figure of the same line. */
export function previousOf(reg: FigureRegistry, fig: RegistryFigure): RegistryFigure | null {
  const prev = String(Number(fig.year) - 1);
  return reg[figureKey(fig.line, prev)] ?? null;
}

/** D7 breakdown of a total's movement, on the CIM's figures (components signed into the total). */
export function movementOf(reg: FigureRegistry, fig: RegistryFigure): ReturnType<typeof decomposeMovement> {
  const prev = previousOf(reg, fig);
  if (!prev || !fig.components || fig.components.length === 0) return null;
  let missingEarlier = false;
  const parts = fig.components.flatMap((c) => {
    const now = reg[c.key];
    const parsed = parseFigureKey(c.key);
    const before = parsed ? reg[figureKey(parsed.line, prev.year)] : undefined;
    if (!now) return [];
    if (!before) missingEarlier = true;
    return [{ id: c.key, label: now.lineLabel, from: c.sign * Math.abs(before?.value ?? 0), to: c.sign * Math.abs(now.value) }];
  });
  const total = fig.expense ? { from: Math.abs(prev.value), to: Math.abs(fig.value) } : { from: prev.value, to: fig.value };
  // The lines must add up to the total in BOTH years — a line the earlier
  // year's analysis doesn't have (Pacific's FY2021 revenue lines) would
  // otherwise read as "mostly X (+$13,480,000)" on a $3,160,000 change.
  const tol = (v: number) => Math.max(1, Math.abs(v) * 0.005);
  const sumFrom = parts.reduce((t, p) => t + p.from, 0);
  const sumTo = parts.reduce((t, p) => t + p.to, 0);
  if (missingEarlier || Math.abs(Math.abs(sumFrom) - Math.abs(total.from)) > tol(total.from) || Math.abs(Math.abs(sumTo) - Math.abs(total.to)) > tol(total.to)) return null;
  return decomposeMovement(total, parts);
}

export interface ComputedNotesInput {
  registry: FigureRegistry;
  checks: FigureCheckInput[];
  /** The figures the CIM shows (only these get notes). */
  anchoredKeys: Iterable<string>;
}

export function computedNotes(input: ComputedNotesInput): MachineNote[] {
  const reg = input.registry;
  const held = new Set(input.checks.filter((c) => c.kind === "cim_statements" && c.cimMismatch).map((c) => c.figureKey));
  const out: MachineNote[] = [];
  for (const key of Array.from(new Set(input.anchoredKeys))) {
    const fig = reg[key];
    if (!fig || !fig.total) continue;
    // Only totals whose parts all add the same way (revenue, cost of sales,
    // operating expenses…): for a profit line a single cost or revenue line
    // can move more than the total itself, and "mostly X" would mislead.
    if ((fig.components ?? []).some((c) => c.sign < 0)) continue;
    const prev = previousOf(reg, fig);
    if (!prev || held.has(fig.key) || held.has(prev.key)) continue;
    if (!movedEnough(prev.value, fig.value)) continue;
    const breakdown = movementOf(reg, fig);
    if (!breakdown) continue;
    const def = standardLineOf(fig.line);
    // Each part reads as its own change ("fuel (−$660,000)"), whatever it did to the total.
    const parts = breakdown.parts.map((p) => ({ label: p.label, delta: Math.abs(p.to) - Math.abs(p.from) }));
    const text = movementText({ from: Math.abs(prev.value), to: Math.abs(fig.value), fromYear: prev.year, parts });
    const blindText = def ? movementBlindText({ from: Math.abs(prev.value), to: Math.abs(fig.value), fromYear: prev.year, partCount: parts.length, blindWord: def.blindWord }) : null;
    const components = Object.fromEntries(breakdown.parts.map((p) => [p.id, p.to]));
    out.push({
      figureKey: fig.key,
      kind: "movement",
      compareKey: prev.year,
      origin: "computed",
      text,
      blindText,
      sources: [{ kind: "computed" }],
      valuesSnapshot: { year: fig.year, value: fig.value, fromYear: prev.year, fromValue: prev.value, components },
      inputFingerprint: fingerprintOf(["movement", fig.key, fig.value, prev.value, breakdown.parts.map((p) => [p.id, p.from, p.to, p.label])]),
    });
  }
  for (const c of input.checks) {
    if (!c.regrouped || !c.regroupedText || c.kind === "cim_statements") continue;
    if (held.has(c.figureKey)) continue;
    const fig = reg[c.figureKey];
    if (!fig) continue;
    out.push({
      figureKey: c.figureKey,
      kind: "difference",
      compareKey: c.compareKey,
      origin: "computed",
      text: c.regroupedText,
      blindText: null,
      sources: [{ kind: "computed" }, ...[c.baseCitation, c.otherCitation].filter((r): r is NonNullable<typeof r> => !!r).map((r) => ({ kind: "document" as const, documentId: r.documentId, page: r.page ?? null }))],
      valuesSnapshot: { year: fig.year, value: fig.value, other: c.other },
      inputFingerprint: fingerprintOf(["difference", c.key, c.base, c.other, c.regroupedText]),
    });
  }
  return out;
}
