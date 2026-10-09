/**
 * workspace — the "Numbers & sources" payload from a deal's figure inputs
 * (spec §5.2). Pure: the route passes the raw inputs, the sections the CIM
 * shows and the deal's state; nothing here reads or writes the database.
 */
import { anchorFigures } from "@shared/figure-anchors";
import { agrees, percentOf } from "@shared/figure-compare";
import { cimMismatchWarning, notLocatedMessage } from "@shared/figure-copy";
import { checkState, preTicked } from "@shared/figure-states";
import { figureKey } from "@shared/figure-lines";
import type {
  FiguresWorkspace, FixFirstItem, MoveStatus, WorkspaceAnswer, WorkspaceCheck, WorkspaceMove, WorkspaceNote, WorkspaceQuestion, WorkspaceSource,
} from "@shared/figure-workspace";
import type { CimFigureNote, CimFigureQuestion, FigureBuildStatus } from "@shared/schema";
import { askableLine, heldFigures } from "./candidates";
import { movedEnough, movementOf, previousOf } from "./computed";
import { mismatchMessage } from "./checks";
import { hintsFor } from "./hints";
import { questionDisplay } from "./requests";
import type { FigureRaw } from "./serve";

const SOURCE_LABEL: Record<string, string> = {
  computed: "Worked out",
  interview: "The owner, in the interview",
  transcript: "A conversation with the owner",
  fact: "The owner",
  hint: "Cimple's analysis (you checked it)",
};

function dateWord(v: string | Date | null | undefined): string {
  if (!v) return "";
  const d = new Date(v as any);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function workspaceNote(n: CimFigureNote, raw: Pick<FigureRaw, "docs">): WorkspaceNote {
  const sources: WorkspaceSource[] = (n.sources ?? []).map((s) => {
    const doc = s.documentId ? raw.docs.get(s.documentId) : undefined;
    const label = s.kind === "document" ? doc?.name || "A document"
      : s.kind === "discrepancy" ? (s.internal ? "Your resolution note (internal)" : "A settled difference")
      : SOURCE_LABEL[s.kind] ?? s.kind;
    return { kind: s.kind, label, quote: s.quote ?? null, page: s.page ?? null, documentId: doc ? doc.id : null, href: doc?.fileUrl ?? null, ...(s.internal ? { internal: true } : {}) };
  });
  const chips = Array.from(new Set(
    n.origin === "broker" ? ["Your note"] : sources.map((s) => (s.kind === "computed" ? "Worked out" : s.label)),
  )).slice(0, 3);
  const internalOnly = (n.sources ?? []).length > 0 && (n.sources ?? []).every((s) => s.internal === true);
  return {
    id: n.id,
    version: new Date(n.updatedAt as any).toISOString(),
    kind: n.kind as WorkspaceNote["kind"],
    compareKey: n.compareKey,
    origin: n.origin as WorkspaceNote["origin"],
    status: n.status as WorkspaceNote["status"],
    text: n.text,
    blindText: n.blindText,
    staleReason: n.staleReason,
    sellerComment: n.sellerComment,
    chips,
    sources,
    proposal: n.proposal ? { text: n.proposal.text, blindText: n.proposal.blindText, at: n.proposal.at } : null,
    history: n.history ?? [],
    internalOnly,
    fingerprint: n.inputFingerprint,
  };
}

/** The seller's (or broker's) answer under a capture key, worded for the workspace. */
export function answerFor(facts: Record<string, unknown>, captureKey: string): WorkspaceAnswer | null {
  const v = facts[captureKey];
  if (v === null || v === undefined || typeof v === "object" || !String(v).trim()) return null;
  const src = ((facts._fieldSources ?? {}) as Record<string, any>)[captureKey] ?? {};
  const when = dateWord(src.at);
  const from = src.source === "broker" ? "From you"
    : src.source === "call" || src.source === "video_call" ? `From Interview together${when ? `, ${when}` : ""}`
    : `From the interview${when ? `, ${when}` : ""}`;
  return { text: String(v).trim(), from };
}

function moveStatus(note: CimFigureNote | undefined, held: boolean): MoveStatus {
  if (!note) return held ? "held" : "none";
  if (note.status === "hidden") return "hidden";
  if (note.staleReason === "seller_flagged") return "stale_seller";
  if (note.staleReason) return "stale_figures";
  if (held) return "held";
  return note.status === "approved" ? "shown" : "waiting";
}

export interface WorkspaceInput {
  raw: FigureRaw;
  sections: Array<{ id: string; layoutType: string; layoutData: unknown }>;
  build: FigureBuildStatus | null;
  autoAsk: boolean;
  autoAskChosen: boolean;
  stale: boolean;
  ddBuyers: number;
  dailyLimit: boolean;
  oldDdWording: boolean;
  leftOutReasons?: Record<string, string>;
}

export function buildWorkspace(input: WorkspaceInput): FiguresWorkspace {
  const { raw } = input;
  const reg = raw.registry;
  const anchors = input.sections.flatMap((s) => anchorFigures(s, reg));
  const anchoredKeys = Array.from(new Set(anchors.map((a) => a.figureKey)));
  const shownSet = new Set(anchoredKeys);
  const checks = raw.checks.checks;
  const held = heldFigures(checks);
  const ddOn = !!raw.state?.ddShownAt;
  const facts = raw.info;

  const notesBy = new Map<string, CimFigureNote[]>();
  for (const n of raw.notes) {
    if (!notesBy.has(n.figureKey)) notesBy.set(n.figureKey, []);
    notesBy.get(n.figureKey)!.push(n);
  }
  const questionsBy = new Map<string, CimFigureQuestion>();
  for (const q of raw.questions) {
    if (q.status === "closed") continue;
    questionsBy.set(`${q.figureKey}|${q.kind}|${q.compareKey}`, q);
  }

  // Tab 1: figures the CIM shows that moved enough, and the lines that moved a total it shows.
  const moveKeys = new Set<string>();
  for (const key of anchoredKeys) {
    const fig = reg[key];
    if (!fig) continue;
    const prev = previousOf(reg, fig);
    if (!prev || !movedEnough(prev.value, fig.value)) continue;
    moveKeys.add(key);
    if (fig.total && !(fig.components ?? []).some((c) => c.sign < 0)) {
      for (const p of movementOf(reg, fig)?.parts ?? []) {
        const part = reg[p.id];
        const pp = part ? previousOf(reg, part) : null;
        if (part && pp && movedEnough(pp.value, part.value)) moveKeys.add(p.id);
      }
    }
  }
  for (const n of raw.notes) if ((n.kind === "movement" || n.kind === "context") && reg[n.figureKey]) moveKeys.add(n.figureKey);
  const hints = hintsFor(Array.from(moveKeys), reg, raw.hintSentences);

  const moves: WorkspaceMove[] = [];
  for (const key of Array.from(moveKeys)) {
    const fig = reg[key];
    const prev = previousOf(reg, fig);
    const notes = (notesBy.get(key) ?? []).filter((n) => n.kind === "movement" || n.kind === "context");
    const note = notes.find((n) => n.kind === "movement" && n.status !== "hidden") ?? notes.find((n) => n.status !== "hidden") ?? notes[0];
    const isHeld = held.has(key) || (!!prev && held.has(prev.key));
    const q = prev ? questionsBy.get(`${key}|movement|${prev.year}`) : undefined;
    const delta = prev ? Math.abs(fig.value) - Math.abs(prev.value) : null;
    moves.push({
      figureKey: key,
      label: fig.lineLabel,
      year: fig.year,
      fromYear: prev?.year ?? null,
      from: prev ? prev.value : null,
      to: fig.value,
      delta,
      pct: prev && delta !== null ? percentOf(delta, prev.value, "change") : null,
      shown: shownSet.has(key),
      status: moveStatus(note, isHeld),
      note: note ? workspaceNote(note, raw) : null,
      hint: note && note.status === "approved" ? null : hints[key] ?? null,
      question: q ? { id: q.id, status: q.status } : null,
      answer: q ? answerFor(facts, q.captureKey) : null,
      askable: askableLine(fig),
      ...(isHeld ? { heldYear: held.has(key) ? fig.year : prev!.year } : {}),
    });
  }
  moves.sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0) || a.figureKey.localeCompare(b.figureKey));

  // Tab 2: the checks on figures the CIM shows.
  const wsChecks: WorkspaceCheck[] = [];
  const docRef = (id: string | null | undefined) => {
    const d = id ? raw.docs.get(id) : undefined;
    return d ? { id: d.id, name: d.name || "A document", href: d.fileUrl ?? null } : null;
  };
  for (const c of checks) {
    if (c.kind === "cim_statements" || c.blank) continue;
    if (!shownSet.has(c.figureKey)) continue;
    const fig = reg[c.figureKey];
    if (!fig) continue;
    const diffNotes = (notesBy.get(c.figureKey) ?? []).filter((n) => n.kind === "difference" && n.compareKey === c.compareKey);
    const note = diffNotes.find((n) => n.status !== "hidden") ?? diffNotes[0];
    const approvedReason = diffNotes.some((n) => n.status === "approved" && !n.staleReason);
    const state = checkState({ size: c.size, regrouped: c.regrouped, approvedReason });
    const mismatch = held.has(c.figureKey);
    const group = c.decision === "left_out" ? "left_out"
      : !agrees(c.size) && !c.located ? "needs_checking"
      : state === "match" ? "match"
      : state === "regrouped" ? "regrouped"
      : "difference";
    const refusal = mismatch ? "Your CIM differs from the statements on this figure. Fix it first."
      : !c.located && !agrees(c.size) ? "Cimple couldn't find it in the document."
      : null;
    const shownToBuyers = ddOn && !mismatch && c.located && c.decision !== "left_out" && (state === "match" || state === "regrouped" || c.decision === "shown" || c.decision === "corrected");
    const missing = raw.checks.notLocated.find((n) => n.checkKey === c.key);
    wsChecks.push({
      checkKey: c.key,
      figureKey: c.figureKey,
      label: fig.lineLabel,
      year: fig.year,
      kind: c.kind as WorkspaceCheck["kind"],
      otherLabel: c.otherLabel,
      thisCim: fig.value,
      base: c.base,
      other: c.other,
      difference: Math.abs(c.other) - Math.abs(c.base),
      pct: agrees(c.size) ? null : percentOf(Math.abs(c.other) - Math.abs(c.base), c.base, "difference"),
      sourceLabel: c.sourceLabel,
      state,
      size: c.size,
      located: c.located,
      decision: c.decision,
      leftOutReason: input.leftOutReasons?.[c.key] ?? null,
      regroupedText: c.regroupedText,
      note: note ? workspaceNote(note, raw) : null,
      group,
      shownToBuyers,
      preTicked: preTicked(state, { cimMismatch: mismatch, located: c.located }),
      refusal,
      baseDocument: docRef(c.baseCitation?.documentId),
      otherDocument: docRef(c.otherCitation?.documentId),
      notLocatedMessage: missing ? notLocatedMessage(missing.value, missing.docWord) : null,
    });
  }

  // Tab 3: questions.
  const questions: WorkspaceQuestion[] = raw.questions.map((q) => ({
    id: q.id,
    figureKey: q.figureKey,
    label: reg[q.figureKey]?.lineLabel ?? String((q.valuesShown as any)?.line ?? ""),
    question: q.question,
    display: questionDisplay(q),
    status: q.status as WorkspaceQuestion["status"],
    routedAt: q.routedAt ? new Date(q.routedAt as any).toISOString() : null,
    routedBy: q.routedBy,
    raisedAt: q.raisedAt ? new Date(q.raisedAt as any).toISOString() : null,
    closedReason: q.closedReason,
    captureKey: q.captureKey,
    answer: answerFor(facts, q.captureKey),
  }));

  // Fix first (broker-only): D9a years the CIM shows, and figures not found in their documents.
  const fixFirst: FixFirstItem[] = [];
  for (const w of raw.checks.mismatches) {
    const items = w.items.filter((i) => shownSet.has(i.figureKey) || anchoredKeys.some((k) => k === figureKey(i.line, w.year)));
    if (items.length === 0) continue;
    fixFirst.push({ id: `mismatch:${w.year}`, kind: "mismatch", year: w.year, message: mismatchMessage({ ...w, items }) });
  }
  for (const n of raw.checks.notLocated) {
    if (!shownSet.has(n.figureKey)) continue;
    const doc = docRef(n.documentId);
    fixFirst.push({ id: `located:${n.checkKey}`, kind: "not_located", message: notLocatedMessage(n.value, n.docWord), checkKey: n.checkKey, documentId: doc?.id, documentName: doc?.name, documentHref: doc?.href ?? null });
  }

  // Other notes (difference / context notes not listed as a movement row) — for the review sheet.
  const moveNoteIds = new Set(moves.map((m) => m.note?.id).filter(Boolean) as string[]);
  const checkNoteIds = new Set(wsChecks.map((c) => c.note?.id).filter(Boolean) as string[]);
  const otherNotes = raw.notes
    .filter((n) => !moveNoteIds.has(n.id) && reg[n.figureKey] && n.status !== "hidden" && (checkNoteIds.has(n.id) || n.kind === "context"))
    .map((n) => ({ figureKey: n.figureKey, label: reg[n.figureKey].lineLabel, year: reg[n.figureKey].year, note: workspaceNote(n, raw) }));

  // KPIs.
  const differing = wsChecks.filter((c) => c.group === "difference" || (c.group === "needs_checking"));
  const cited = new Set<string>();
  for (const c of wsChecks) {
    if (c.baseDocument && raw.docs.get(c.baseDocument.id)?.citable) cited.add(c.baseDocument.id);
    if (c.otherDocument && raw.docs.get(c.otherDocument.id)?.citable) cited.add(c.otherDocument.id);
  }
  for (const n of raw.notes) for (const s of n.sources ?? []) if (s.documentId && raw.docs.get(s.documentId)?.citable) cited.add(s.documentId);
  for (const t of raw.keyTerms) if (raw.docs.get(t.citation.documentId)?.citable) cited.add(t.citation.documentId);
  const waiting = raw.notes.filter((n) => n.status === "suggested" && !n.staleReason && reg[n.figureKey]).length;

  return {
    status: {
      ddShownAt: raw.state?.ddShownAt ? new Date(raw.state.ddShownAt as any).toISOString() : null,
      autoAsk: input.autoAsk,
      autoAskChosen: input.autoAskChosen,
      build: input.build,
      refreshedAt: raw.state?.refreshedAt ? new Date(raw.state.refreshedAt as any).toISOString() : null,
      stale: input.stale,
      hasCim: input.sections.length > 0,
      noFigures: raw.noFigures,
      hasOtherRecords: raw.sources.some((s) => s.kind !== "statements"),
      ddBuyers: input.ddBuyers,
      dailyLimit: input.dailyLimit,
    },
    kpis: {
      changesExplained: moves.filter((m) => m.status === "shown").length,
      changesTotal: moves.filter((m) => m.status !== "hidden").length,
      differences: differing.length,
      differencesExplained: differing.filter((c) => c.state === "explained").length,
      waiting,
      withSeller: raw.questions.filter((q) => q.status === "ask_seller").length,
      documentsCited: cited.size,
      documentsShared: null,
    },
    fixFirst,
    moves,
    checks: wsChecks,
    questions,
    otherNotes,
    oldDdWording: input.oldDdWording,
  };
}

/** The D9a message for a year (re-exported for the route's per-year line). */
export { cimMismatchWarning };
