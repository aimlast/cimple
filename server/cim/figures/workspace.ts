/**
 * workspace — the "Numbers & sources" payload from a deal's figure inputs
 * (spec §5.2). Pure: the route passes the raw inputs, the sections the CIM
 * shows and the deal's state; nothing here reads or writes the database.
 */
import { anchorFigures } from "@shared/figure-anchors";
import { agrees, percentOf } from "@shared/figure-compare";
import { cimMismatchWarning, notLocatedMessage } from "@shared/figure-copy";
import { checkState, preTicked } from "@shared/figure-states";
import { baseLineOf, figureKey } from "@shared/figure-lines";
import { DERIVED_TOTAL_LINES, figureCitationLabel } from "@shared/figure-layer";
import type {
  FigurePlace, FiguresWorkspace, FixFirstItem, MoveStatus, WorkspaceAnswer, WorkspaceCheck, WorkspaceMove, WorkspaceNote, WorkspaceQuestion, WorkspaceSource,
} from "@shared/figure-workspace";
import type { CimFigureNote, CimFigureQuestion, FigureBuildStatus } from "@shared/schema";
import { askableLine, heldFigures } from "./candidates";
import { movedEnough, movementOf, previousOf } from "./computed";
import { mismatchMessage } from "./checks";
import { hintsFor } from "./hints";
import { questionDisplay } from "./requests";
import type { FigureRaw } from "./serve";
import { CIM_VERSIONS, servedSummary, type ServedFigures, type ServedVersion } from "./served";

const SOURCE_LABEL: Record<string, string> = {
  computed: "Worked out",
  interview: "The owner, in the interview",
  transcript: "A conversation with the owner",
  fact: "The owner",
  hint: "Cimple's analysis (you checked it)",
};

/** Short chip words ("Based on" column); the long label is the chip's tooltip. */
const CHIP_LABEL: Record<string, string> = {
  computed: "Worked out",
  interview: "Owner · interview",
  transcript: "Owner · call",
  fact: "The owner",
  hint: "Cimple's analysis",
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
  // One-line chips (F1): a document by its kind ("Lease", "Financial statements 2023"), the full
  // title on hover; other sources by a short word.
  const chipOf = (src: NonNullable<CimFigureNote["sources"]>[number], ws: WorkspaceSource): { label: string; title: string } => {
    if (src.kind === "document") {
      const doc = src.documentId ? raw.docs.get(src.documentId) : undefined;
      return { label: doc ? figureCitationLabel({ kind: doc.kind, period: doc.period }) : "A document", title: ws.label };
    }
    return { label: CHIP_LABEL[src.kind] ?? (src.kind === "discrepancy" ? (src.internal ? "Your resolution note" : "A settled difference") : ws.label), title: ws.label };
  };
  const chipList = n.origin === "broker" ? [{ label: "Your note", title: "Written by you" }] : (n.sources ?? []).map((src, i) => chipOf(src, sources[i]));
  const chips = chipList.filter((c, i) => chipList.findIndex((x) => x.label === c.label) === i).slice(0, 3);
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

/** A worked-out difference (D6): buyers read it from the check itself once the checks are on. */
function workedOutGrouping(n: Pick<CimFigureNote, "origin" | "kind">): boolean {
  return n.origin === "computed" && n.kind === "difference";
}

function moveStatus(note: CimFigureNote | undefined, held: boolean, served: { now: ServedVersion[]; later: ServedVersion[] } | null): MoveStatus {
  if (!note) return held ? "held" : "none";
  if (note.status === "hidden") return "hidden";
  if (note.staleReason === "seller_flagged") return "stale_seller";
  if (note.staleReason) return "stale_figures";
  if (held) return "held";
  if (note.status !== "approved") return "waiting";
  // "Shown to buyers" only when some buyer is served it now (checker r1 F3) — never from the working copy alone.
  if (!served) return "shown";
  if (served.now.some((v) => v.noteIds.has(note.id))) return "shown";
  if (served.later.some((v) => v.noteIds.has(note.id))) return "after_publish";
  return "not_served";
}

/** Derived totals and tax lines: the broker can rarely do more than write a reason for them (F10). */
function foldLine(fig: { line: string; category?: string }): boolean {
  const base = baseLineOf(String(fig.line));
  return DERIVED_TOTAL_LINES.has(base) || base === "incomeTaxes" || fig.category === "Taxes";
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
  /**
   * What each version serves now (server/cim/figures/served.ts). Omitted: the
   * working copy stands in (tests, or when it couldn't be worked out).
   */
  served?: ServedFigures | null;
}

export function buildWorkspace(input: WorkspaceInput): FiguresWorkspace {
  const { raw } = input;
  const reg = raw.registry;
  const anchors = input.sections.flatMap((s) => anchorFigures(s, reg));
  const workingKeys = new Set(anchors.map((a) => a.figureKey));
  // What buyers read now (any version) — and, while a kept copy or approved versions are served,
  // the figures only the update shows. Without served info the working copy stands in.
  const served = input.served ?? null;
  const nowVersions = served ? CIM_VERSIONS.map((v) => served.now[v]) : [];
  const laterVersions = served?.afterPublish ? CIM_VERSIONS.map((v) => served.afterPublish![v]) : [];
  // While buyers are served nothing (not published yet, or held), the pages are the ones they'll
  // read once it's published: a figure on them is "on a page", its approved note "shows once you
  // publish" — never "not on a page buyers read" (checker r2 R2-2).
  const nothingServed = !!served && (served.notLive || served.held) && !!served.afterPublish;
  const pageVersions = nothingServed ? laterVersions : nowVersions;
  const onPage = served ? new Set(pageVersions.flatMap((v) => Array.from(v.anchored))) : workingKeys;
  const anchoredKeys = Array.from(new Set([...Array.from(workingKeys), ...Array.from(onPage)]));
  const shownSet = new Set(anchoredKeys);
  const placeOf = (key: string): FigurePlace => (onPage.has(key) ? "page" : workingKeys.has(key) ? "update_only" : "inside_total");
  const ddPage = served ? (nothingServed ? served.afterPublish!.dd.anchored : served.now.dd.anchored) : workingKeys;
  const checks = raw.checks.checks;
  const held = heldFigures(checks, reg);
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
    const status = moveStatus(note, isHeld, served ? { now: nowVersions, later: laterVersions } : null);
    // A note buyers read now on a figure no page shows by itself is read under its total (DD "what's in it").
    const place = status === "shown" && placeOf(key) !== "page" ? "inside_total" : placeOf(key);
    // D9a: nothing measured from or to a held figure is offered for buyers — fix it first.
    const hint = isHeld || (note && note.status === "approved") ? null : hints[key] ?? null;
    const answer = q ? answerFor(facts, q.captureKey) : null;
    moves.push({
      figureKey: key,
      label: fig.lineLabel,
      year: fig.year,
      fromYear: prev?.year ?? null,
      from: prev ? prev.value : null,
      to: fig.value,
      delta,
      pct: prev && delta !== null ? percentOf(delta, prev.value, "change") : null,
      shown: place === "page",
      place,
      status,
      ...(status === "not_served" ? { unservedWhy: place === "inside_total"
        ? (ddOn ? "Inside a total; buyers don't see this line on any page." : "A line inside a total: due-diligence buyers see it once the checks are on.")
        : nothingServed ? "No page of the CIM shows this figure." : "No page buyers read shows this figure right now." } : {}),
      note: note ? workspaceNote(note, raw) : null,
      hint,
      question: q ? { id: q.id, status: q.status } : null,
      answer,
      askable: !isHeld && askableLine(fig),
      folded: foldLine(fig) && (status === "none" || status === "held") && !hint && !answer && !q,
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
    const note = diffNotes.filter((n) => !workedOutGrouping(n)).find((n) => n.status !== "hidden") ?? diffNotes.filter((n) => !workedOutGrouping(n))[0];
    const approvedReason = diffNotes.some((n) => n.status === "approved" && !n.staleReason);
    const state = checkState({ size: c.size, regrouped: c.regrouped, approvedReason });
    const mismatch = held.has(c.figureKey);
    // "Cimple read it wrong" (checker r2 R2-1): the broker's figure needs checking until the document
    // prints it on its own line, and stays with the differences until the broker shows it — a
    // correction never turns a difference into a match on its own.
    const correctedUnshown = !!c.corrected && c.decision !== "shown";
    const group = c.decision === "left_out" ? "left_out"
      : (!agrees(c.size) || c.corrected) && !c.located ? "needs_checking"
      : correctedUnshown ? "difference"
      : state === "match" ? "match"
      : state === "regrouped" ? "regrouped"
      : "difference";
    const refusal = mismatch ? "Your CIM differs from the statements on this figure. Fix it first."
      : c.corrected && !c.located ? "Cimple couldn't find your figure on that line of the document."
      : !c.located && !agrees(c.size) ? "Cimple couldn't find it in the document."
      : null;
    // Read from what DD buyers are actually served (the kept copy while an update waits), when known.
    const shownToBuyers = served ? served.now.dd.checkKeys.has(c.key)
      : ddOn && !mismatch && c.located && c.decision !== "left_out" && (c.corrected ? c.decision === "shown" : state === "match" || state === "regrouped" || c.decision === "shown");
    const afterPublish = !shownToBuyers && !!served?.afterPublish?.dd.checkKeys.has(c.key);
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
      corrected: !!c.corrected,
      leftOutReason: input.leftOutReasons?.[c.key] ?? null,
      regroupedText: c.regroupedText,
      note: note ? workspaceNote(note, raw) : null,
      group,
      shownToBuyers,
      afterPublish,
      onBuyerPage: ddPage.has(c.figureKey),
      preTicked: !correctedUnshown && preTicked(state, { cimMismatch: mismatch, located: c.located }),
      refusal,
      baseDocument: docRef(c.baseCitation?.documentId),
      otherDocument: docRef(c.otherCitation?.documentId),
      notLocatedMessage: missing ? notLocatedMessage(missing.value, missing.docWord, missing.lineWord) : null,
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
    fixFirst.push({ id: `located:${n.checkKey}`, kind: "not_located", message: notLocatedMessage(n.value, n.docWord, n.lineWord), checkKey: n.checkKey, documentId: doc?.id, documentName: doc?.name, documentHref: doc?.href ?? null });
  }

  // Other notes (difference / context notes not listed as a movement row) — for the review sheet.
  const moveNoteIds = new Set(moves.map((m) => m.note?.id).filter(Boolean) as string[]);
  const checkNoteIds = new Set(wsChecks.map((c) => c.note?.id).filter(Boolean) as string[]);
  // (A worked-out grouping's note is the check's own text — shown with the checks, never approved on its own.)
  const otherNotes = raw.notes
    .filter((n) => !moveNoteIds.has(n.id) && reg[n.figureKey] && n.status !== "hidden" && !workedOutGrouping(n) && (checkNoteIds.has(n.id) || n.kind === "context"))
    .map((n) => ({ figureKey: n.figureKey, label: reg[n.figureKey].lineLabel, year: reg[n.figureKey].year, note: workspaceNote(n, raw) }));

  // KPIs.
  // Every figure whose records differ — the arithmetic-explained ones too (they're tinted for buyers).
  const differing = wsChecks.filter((c) => c.group === "difference" || c.group === "regrouped" || c.group === "needs_checking");
  const cited = new Set<string>();
  for (const c of wsChecks) {
    if (c.baseDocument && raw.docs.get(c.baseDocument.id)?.citable) cited.add(c.baseDocument.id);
    if (c.otherDocument && raw.docs.get(c.otherDocument.id)?.citable) cited.add(c.otherDocument.id);
  }
  for (const n of raw.notes) for (const s of n.sources ?? []) if (s.documentId && raw.docs.get(s.documentId)?.citable) cited.add(s.documentId);
  for (const t of raw.keyTerms) if (raw.docs.get(t.citation.documentId)?.citable) cited.add(t.citation.documentId);
  const waiting = raw.notes.filter((n) => n.status === "suggested" && !n.staleReason && reg[n.figureKey] && !workedOutGrouping(n)).length;

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
      // Folded rows (derived totals and tax lines with nothing to do) aren't "changes to explain" (F10).
      changesExplained: moves.filter((m) => m.status === "shown" && !m.folded).length,
      changesAfterPublish: moves.filter((m) => m.status === "after_publish" && !m.folded).length,
      changesTotal: moves.filter((m) => m.status !== "hidden" && !m.folded).length,
      differences: differing.length,
      differencesExplained: differing.filter((c) => c.state === "explained" || c.state === "regrouped").length,
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
    served: served ? servedSummary(served) : null,
  };
}

/** The D9a message for a year (re-exported for the route's per-year line). */
export { cimMismatchWarning };
