/**
 * evidence.ts — what buyers are shown about the add-backs found in the
 * books (gl spec §8.1, D13, D14, D22, D30).
 *
 *   publishPreview(dealId)      the broker's dialog: per-version defaults,
 *                               the exact note texts, the warnings
 *   publishEvidence(dealId, …)  saves the broker's snapshot (gl_tracing.published)
 *   buildEvidence(dealId, mode, "live" | "published")
 *                               a payload for one CIM version: the DD page,
 *                               or the Full/Blind note
 *   glEvidenceForBuyer          what a buyer's link gets (null for a teaser)
 *   glLineIdsForDeal            bridge add-back → the line id its mark uses
 *   glWriterLines / glTeaserLine  context for the DD writer / the teaser
 *
 * Buyers only ever read the broker's published snapshot, tightened against
 * the current state every time it is served (tightenPublished): a deleted
 * or now-private ledger or document, a switched-off detail, a new held name
 * or keep-out request takes effect at once; only loosening waits for the
 * broker to publish again. Masking (sensitive.ts maskForBuyer) is applied
 * at serve time, to every entry. The Blind payload is constants, counts and
 * fiscal years only, and is checked by the blind guard (fail-closed → null).
 */
import { createHmac } from "node:crypto";
import { storage } from "../storage";
import type { Deal, Document, GlAddbackTrace, GlLedger, GlTraceLink, GlTracing } from "@shared/schema";
import type { GlTieOutYear, GlTraceComputed, GlYearStatus } from "@shared/gl-types";
import {
  GL_EVIDENCE_MAX_ENTRIES, glNoteText,
  type GlBuyerStatus, type GlEvidenceDoc, type GlEvidenceEntry, type GlEvidenceLine, type GlEvidenceMode, type GlEvidencePayload,
  type GlEvidenceTieOut, type GlEvidenceYear, type GlPublishedEvidence, type GlSnapshotEntry, type GlSnapshotLine, type GlSnapshotYear,
} from "@shared/gl-evidence";
import { amountStatus, claimedYears, reconcileTrace, type ReconcileContext } from "@shared/gl-reconcile";
import { formatCents, formatPeriod, payDocWords, softwareLabel, yearsWords } from "@shared/gl-copy";
import { blindLeakTerms, blindPlaceholders, collectStrings, findBlindLeaks } from "@shared/blind-guard";
import { glStore } from "./store";
import { withGlLock } from "./lock";
import { loadGlContext, ownerNamesText, type GlDealContext } from "./context";
import { isBuyerVisibleLedger } from "./audience";
import { personsFor } from "./match-run";
import type { Person } from "./match";
import { maskForBuyer, type BuyerMaskContext } from "./sensitive";
import { screenForBuyers } from "./screen";
import { gateFrom, type GlGate } from "./gate";
import { cimModeForAccessLevel, isTeaserOnly } from "./levels";


// ── Ids ──────────────────────────────────────────────────────────────────

function secret(): string {
  return process.env.SESSION_SECRET || "dev-session-secret-change-me";
}

/** A line's id: stable across analysis re-runs (keyed by the add-back's normalised label), different across deals. */
export function glLineId(dealId: string, addbackKey: string): string {
  return createHmac("sha256", secret()).update(`${dealId}${addbackKey}`).digest("hex").slice(0, 12);
}

/** The DD page's section id. */
export function glPageId(dealId: string): string {
  return `glsec_${createHmac("sha256", secret()).update(`${dealId}:page`).digest("hex").slice(0, 12)}`;
}

const dollars = (c: number) => Math.round(Number(c || 0)) / 100;
const money = (d: number) => formatCents(Math.round(d) * 100, { whole: true });

// ── The deal's current state (what tightening and masking read) ─────────

export interface EvidenceState {
  dealId: string;
  deal: Deal | undefined;
  c: GlDealContext;
  tracing: GlTracing;
  traces: GlAddbackTrace[];
  links: GlTraceLink[];
  /** Ready ledgers buyers may ever see (not private to the broker), with their document. */
  buyerLedgers: Map<string, { ledger: GlLedger; doc: Document }>;
  /** Documents a buyer may be shown (exist, not broker-only, not from email/calls/CRM). */
  citableDocIds: Set<string>;
  staffNames: string[];
  heldNames: string[];
  ownerText: string;
  payShort: string;
}

/** Documents that may be cited to buyers: present, shared, a real file (not an email, a call, the CRM). */
export function citableForBuyers(d: Pick<Document, "visibility"> & { sourceKind?: string | null; fileUrl?: string | null }): boolean {
  if ((d as { visibility?: string | null }).visibility === "broker_only") return false;
  const kind = d.sourceKind ?? null;
  if (kind && kind !== "document") return false;
  return true;
}

/** Names that must never reach a buyer in an entry: held staff-private people, keep-out parties (incl. the seller's own requests). */
async function heldNamesFor(deal: Deal | undefined): Promise<{ held: string[]; staff: string[] }> {
  if (!deal) return { held: [], staff: [] };
  const info = (deal.extractedInfo && typeof deal.extractedInfo === "object" ? deal.extractedInfo : {}) as Record<string, unknown>;
  const [{ keepOutFromNotes }, { staffContextFrom }, { heldPrivateForDeal }] = await Promise.all([
    import("../cim/sensitive-facts"),
    import("../cim/staff-private"),
    import("../cim/held-private"),
  ]);
  const held = new Set<string>();
  try {
    for (const item of heldPrivateForDeal(deal)) if (!item.included && item.person) held.add(item.person);
  } catch (err) {
    console.warn("[gl] held staff matters couldn't be read; withholding staff names:", (err as Error).message);
  }
  const keepOut = keepOutFromNotes(info);
  for (const n of keepOut.names) held.add(n);
  for (const p of keepOut.pairs) held.add(p.name);
  return { held: Array.from(held), staff: staffContextFrom(info).staffNames };
}

export async function loadEvidenceState(dealId: string): Promise<EvidenceState> {
  const c = await loadGlContext(dealId);
  const store = glStore();
  const [traces, links, tracing] = await Promise.all([store.listTraces(dealId), store.linksOfDeal(dealId), store.getTracing(dealId)]);
  const buyerLedgers = new Map<string, { ledger: GlLedger; doc: Document }>();
  for (const l of c.ready) {
    const doc = c.docById.get(l.documentId)!;
    if (isBuyerVisibleLedger(doc, l)) buyerLedgers.set(l.id, { ledger: l, doc });
  }
  const citableDocIds = new Set(c.docs.filter((d) => citableForBuyers(d as any)).map((d) => d.id));
  const names = await heldNamesFor(c.deal);
  const { jurisdictionOf } = await import("../interview/reply-guards");
  return {
    dealId, deal: c.deal, c, tracing: tracing ?? c.tracing, traces, links, buyerLedgers, citableDocIds,
    staffNames: names.staff, heldNames: names.held, ownerText: ownerNamesText(c.deal),
    payShort: payDocWords(jurisdictionOf(c.deal?.location ?? null)).short,
  };
}

// ── Building the snapshot (what publishing saves) ──────────────────────

const PERSONAL_CATEGORY = new Set(["discretionary", "owner_comp"]);
const PERSONAL_LABEL = /\b(?:personal|owner|family|spouse|wife|husband|son|daughter|related|shareholder)\b/i;

/** The bridge wording with any held name taken out ("Salary paid to Maria Chen" → "Salary paid"). */
async function buyerLabel(label: string, heldNames: string[]): Promise<string> {
  if (heldNames.length === 0) return label;
  const { mentionsHeldPerson, neutralBridgeLabel } = await import("../cim/sensitive-facts");
  return mentionsHeldPerson(label, heldNames) ? neutralBridgeLabel(label, heldNames) : label;
}

/** The buyer-facing status of a trace: the broker's verdict, never above what buyer-visible evidence supports. */
export function buyerStatusFor(
  t: Pick<GlAddbackTrace, "proof" | "brokerVerdict">,
  buyerComputed: Pick<GlTraceComputed, "overall" | "suggestedVerdict">,
): GlBuyerStatus {
  if (t.proof === "statement") return "statement";
  const verdict = (t.brokerVerdict ?? "not_found") as "found" | "partly_found" | "not_found";
  const rank = { not_found: 0, partly_found: 1, found: 2 } as const;
  // What buyer-visible support shows (a private ledger's entries don't count for buyers).
  const support = buyerComputed.suggestedVerdict;
  const capped = rank[support] < rank[verdict] ? support : verdict;
  if (capped === "found" && buyerComputed.overall === "document") return "document";
  return capped;
}

function supportLabel(proof: string, year: string, payShort: string): string {
  if (proof === "payroll") return `${payShort} ${year}`;
  if (proof === "one_off") return `Invoice or letter (${year})`;
  return `Supporting document (${year})`;
}

/** Statement documents to cite on a line from the statements (neutral names, years from the file). */
function statementDocsFor(s: EvidenceState, years: string[]): Array<{ documentId: string; name: string; year: string }> {
  const out: Array<{ documentId: string; name: string; year: string }> = [];
  for (const d of s.c.docs) {
    if (!s.citableDocIds.has(d.id)) continue;
    if (d.category !== "financials" || d.subcategory === "general_ledger" || d.subcategory === "addback_support") continue;
    const ys = Array.from(new Set((d.name.match(/\b20\d\d\b/g) ?? []))).filter((y) => years.includes(y));
    for (const y of ys) out.push({ documentId: d.id, name: `Financial statements ${y}`, year: y });
  }
  return out.slice(0, 12);
}

/**
 * The snapshot for the current state (pure over the loaded state): only
 * lines in the CIM, reviewed (or from the statements), not left out; only
 * entries of ledgers buyers may see; only citable documents.
 */
export async function snapshotFromState(
  s: EvidenceState,
  opts: { versions: GlPublishedEvidence["versions"]; leaveOut: string[]; publishedBy: string | null; now?: Date },
): Promise<{ snapshot: GlPublishedEvidence; skippedUnreviewed: string[] }> {
  const info = (s.deal?.extractedInfo as Record<string, unknown> | null) ?? null;
  const buyerLedgerIds = new Set(s.buyerLedgers.keys());
  const supportIds = new Set(s.c.docs.filter((d) => d.subcategory === "addback_support" && s.citableDocIds.has(d.id)).map((d) => d.id));
  const yearsBuyer = new Set<string>();
  for (const { ledger } of Array.from(s.buyerLedgers.values())) for (const y of Object.keys((ledger.years as Record<string, unknown> | null) ?? {})) yearsBuyer.add(y);
  const buyerCtx: ReconcileContext = { ledgerYears: yearsBuyer, hasLedger: buyerLedgerIds.size > 0, countedLedgerIds: buyerLedgerIds, countedDocumentIds: supportIds };
  const lines: GlSnapshotLine[] = [];
  const skippedUnreviewed: string[] = [];
  const live = s.traces.filter((t) => !t.removedAt && t.includeInCim && !opts.leaveOut.includes(t.addbackKey));
  for (const t of live) {
    const left = (t.leftOut as { years?: string[] } | null)?.years ?? [];
    const allYears = claimedYears({ claims: (t.claims as Record<string, number>) ?? {} });
    const years = allYears.filter((y) => !left.includes(y));
    if (years.length === 0) continue;
    if (t.proof !== "statement" && !t.reviewedAt) { skippedUnreviewed.push(t.label); continue; }
    const mine = s.links.filter((k) => k.traceId === t.id && k.state === "confirmed");
    const input = {
      proof: t.proof, sharePct: t.sharePct, claims: (t.claims as Record<string, number>) ?? {},
      leftOut: (t.leftOut as { years: string[]; reason: string } | null) ?? null, notInLedger: (t.notInLedger as any) ?? null,
    };
    const buyerComputed = reconcileTrace(input, mine, buyerCtx);
    const labels = (t.yearLabels as Record<string, string> | null) ?? {};
    const snapYears: GlSnapshotYear[] = years.map((y) => {
      const cy = buyerComputed.byYear[y];
      const entries: GlSnapshotEntry[] = mine
        .filter((k) => k.fiscalYear === y && k.ledgerId && buyerLedgerIds.has(k.ledgerId))
        .sort((a, b) => String(a.txnDate ?? "").localeCompare(String(b.txnDate ?? "")) || (a.rowNo ?? 0) - (b.rowNo ?? 0))
        .map((k) => ({
          linkId: k.id, ledgerId: k.ledgerId, rowNo: k.rowNo, date: k.txnDate ?? "", account: k.account ?? "", name: k.name, memo: k.memo,
          amountCents: Number(k.amountCents), showDetails: k.showDetails ?? null,
        }));
      const docs = mine
        .filter((k) => k.fiscalYear === y && k.documentId && supportIds.has(k.documentId))
        .map((k) => ({ documentId: k.documentId!, label: supportLabel(t.proof, y, s.payShort), year: y, amountCents: Math.abs(Number(k.amountCents)), check: ((k.docAmountCheck as GlEvidenceDoc["check"]) ?? "unreadable") }));
      return {
        year: y, yearLabel: labels[y] ?? y, claimedCents: cy?.claimedCents ?? Number(input.claims[y] ?? 0), targetCents: cy?.targetCents ?? 0,
        documentCents: cy?.documentCents ?? 0, status: (cy?.status ?? "not_started") as GlYearStatus, entries, docs,
      };
    });
    const ownParties = personsFor(t, s.ownerText);
    const share = t.sharePct && t.sharePct > 0 && t.sharePct < 100
      ? { pct: t.sharePct, basis: (t.shareBasis === "documented" ? "documented" : "estimate") as "estimate" | "documented", ...(t.shareBasis === "documented" && t.shareBasisDoc ? { doc: t.shareBasisDoc } : {}) }
      : null;
    lines.push({
      traceId: t.id,
      addbackKey: t.addbackKey,
      lineId: glLineId(s.dealId, t.addbackKey),
      label: await buyerLabel(t.label, s.heldNames),
      status: buyerStatusFor(t, buyerComputed),
      parties: ownParties.map((p) => ({ first: p.first, last: p.last })),
      personal: PERSONAL_CATEGORY.has(t.category ?? "") || PERSONAL_LABEL.test(t.label),
      share,
      why: screenForBuyers(t.buyerReason, info),
      brokerNote: t.brokerNoteShown ? screenForBuyers(t.brokerNote, info) : null,
      sellerNote: t.sellerNoteShown ? screenForBuyers(t.sellerNote, info) : null,
      years: snapYears,
      statementDocs: t.proof === "statement" ? statementDocsFor(s, years) : [],
    });
  }
  // Buyers read the add-backs found in the books first; lines straight from the statements go last.
  lines.sort((a, b) => Number(a.status === "statement") - Number(b.status === "statement"));
  const tieOut = tieOutRows(s.tracing, info);
  const agreeYears = tieOut.filter((r) => r.state === "agrees" || r.state === "accepted").map((r) => r.year);
  const ledgerYears = Array.from(new Set(lines.filter((l) => l.status !== "statement").flatMap((l) => l.years.map((y) => y.year))));
  const ledgers = Array.from(s.buyerLedgers.values()).map(({ ledger }) => ({
    ledgerId: ledger.id, documentId: ledger.documentId, software: ledger.software ?? null,
    period: formatPeriod(ledger.periodStart, ledger.periodEnd), showStaffNames: !!ledger.showStaffNames,
  }));
  const conf = s.tracing.sellerConfirmation as { role: "owner" | "accountant"; at: string } | null;
  return {
    snapshot: {
      v: 1,
      publishedAt: (opts.now ?? new Date()).toISOString(),
      publishedBy: opts.publishedBy,
      versions: opts.versions,
      leaveOut: opts.leaveOut,
      pageId: glPageId(s.dealId),
      noteYears: ledgerYears.filter((y) => agreeYears.includes(y)).sort(),
      ledgers,
      tieOut,
      confirmation: conf ? { role: conf.role, at: conf.at } : null,
      lines,
    },
    skippedUnreviewed,
  };
}

/** The tie-out as buyers may read it (an accepted difference carries the broker's screened note). */
function tieOutRows(tracing: GlTracing, info: Record<string, unknown> | null): GlEvidenceTieOut[] {
  const tie = (tracing.tieOut as Record<string, GlTieOutYear> | null) ?? {};
  const accepted = (tracing.tieOutAccepted as Record<string, { note: string }> | null) ?? {};
  return Object.keys(tie).sort().map((y) => {
    const t = tie[y];
    if (t.state === "agrees") return { year: y, state: "agrees" as const };
    if (t.state === "differs" && accepted[y]) return { year: y, state: "accepted" as const, difference: dollars(t.differenceCents ?? 0), note: screenForBuyers(accepted[y].note, info) };
    if (t.state === "differs") return { year: y, state: "differs" as const, difference: dollars(t.differenceCents ?? 0) };
    return { year: y, state: "cannot_check" as const };
  });
}

// ── Serve-time tightening (pure) ────────────────────────────────────────

export interface TightenCurrent {
  /** Ready ledgers buyers may see (their document still exists). */
  liveLedgerIds: ReadonlySet<string>;
  /** The broker's "show staff names" now, per ledger. */
  showStaffNames: ReadonlyMap<string, boolean>;
  /** Documents that may still be cited. */
  liveDocIds: ReadonlySet<string>;
  /** Each published entry's per-entry choice now (missing = the link is gone → the rules). */
  showDetails: ReadonlyMap<string, boolean | null>;
  /** Add-backs still in the analysis and in the CIM (by addbackKey). */
  liveKeys: ReadonlySet<string>;
  /** Years whose ledger agrees with the statements now (or the difference is accepted). */
  agreeYears: ReadonlySet<string>;
}

const STATUS_RANK: Record<GlBuyerStatus, number> = { not_found: 0, partly_found: 1, document: 2, found: 3, statement: 4 };
const YEAR_OK = (s: GlYearStatus) => s === "found" || s === "close" || s === "document";

/**
 * The snapshot as it may be served now: removals and switches since the
 * broker published take effect at once; nothing is ever loosened. Returns
 * the tightened snapshot and, for the broker, what changed in words.
 */
export function tightenPublished(snap: GlPublishedEvidence, cur: TightenCurrent): { snapshot: GlPublishedEvidence; changes: string[] } {
  const changes: string[] = [];
  const lines: GlSnapshotLine[] = [];
  for (const line of snap.lines) {
    if (!cur.liveKeys.has(line.addbackKey)) { changes.push(`${line.label}: no longer in the analysis — taken off what buyers see.`); continue; }
    let lowered = false;
    let droppedEntries = 0;
    let droppedDocs = 0;
    const years: GlSnapshotYear[] = line.years.map((y) => {
      const entries = y.entries
        .filter((e) => { const ok = !e.ledgerId || cur.liveLedgerIds.has(e.ledgerId); if (!ok) droppedEntries++; return ok; })
        .map((e) => {
          const now = cur.showDetails.has(e.linkId) ? cur.showDetails.get(e.linkId)! : null;
          // Only a withholding wins: showing needs both the published and the current choice.
          const eff = e.showDetails === false || now === false ? false : e.showDetails === true && now === true ? true : null;
          return eff === e.showDetails ? e : { ...e, showDetails: eff };
        });
      const docs = y.docs.filter((d) => { const ok = cur.liveDocIds.has(d.documentId); if (!ok) droppedDocs++; return ok; });
      if (y.status === "statement" || y.status === "left_out") return { ...y, entries, docs };
      const found = Math.abs(entries.reduce((n, e) => n + e.amountCents, 0));
      const docCents = docs.reduce((n, d) => n + d.amountCents, 0);
      const supported = found + docCents;
      let status: GlYearStatus = y.status;
      if (entries.length !== y.entries.length || docs.length !== y.docs.length) {
        const now: GlYearStatus = supported === 0 ? "not_in_ledger" : docs.length > 0 && found === 0 ? (amountStatus(supported, y.targetCents) === "found" || amountStatus(supported, y.targetCents) === "close" ? "document" : amountStatus(supported, y.targetCents)) : amountStatus(supported, y.targetCents);
        if (YEAR_OK(y.status) && !YEAR_OK(now)) { status = now; lowered = true; }
      }
      return { ...y, entries, docs, documentCents: docCents, status };
    });
    let status = line.status;
    if (lowered && (status === "found" || status === "document")) {
      const ok = years.filter((y) => y.status !== "left_out" && y.status !== "statement");
      status = ok.some((y) => y.entries.length > 0 || y.docs.length > 0) ? "partly_found" : "not_found";
    } else if (lowered && status === "partly_found" && years.every((y) => y.entries.length === 0 && y.docs.length === 0)) {
      status = "not_found";
    }
    if (STATUS_RANK[status] > STATUS_RANK[line.status]) status = line.status; // never raised
    if (droppedEntries) changes.push(`${line.label}: ${droppedEntries} entr${droppedEntries === 1 ? "y" : "ies"} from a ledger that was removed or made private are no longer shown.`);
    if (droppedDocs) changes.push(`${line.label}: a supporting document that was removed or made private is no longer cited.`);
    if (status !== line.status) changes.push(`${line.label}: now shown as "${status === "not_found" ? "Not found" : "Partly found"}".`);
    const statementDocs = line.statementDocs.filter((d) => cur.liveDocIds.has(d.documentId));
    lines.push({ ...line, status, years, statementDocs });
  }
  const noteYears = snap.noteYears.filter((y) => cur.agreeYears.has(y));
  if (noteYears.length < snap.noteYears.length) changes.push(`The note no longer says the ledger agrees with the statements for ${yearsWords(snap.noteYears.filter((y) => !cur.agreeYears.has(y)))}.`);
  const ledgers = snap.ledgers
    .filter((l) => cur.liveLedgerIds.has(l.ledgerId))
    .map((l) => ({ ...l, showStaffNames: l.showStaffNames && cur.showStaffNames.get(l.ledgerId) === true }));
  return { snapshot: { ...snap, lines, noteYears, ledgers }, changes };
}

/** The current state as tightening reads it. */
export function tightenCurrentFrom(s: EvidenceState): TightenCurrent {
  const tie = tieOutRows(s.tracing, null);
  return {
    liveLedgerIds: new Set(s.buyerLedgers.keys()),
    showStaffNames: new Map(Array.from(s.buyerLedgers.values()).map(({ ledger }) => [ledger.id, !!ledger.showStaffNames])),
    liveDocIds: s.citableDocIds,
    showDetails: new Map(s.links.filter((k) => k.state === "confirmed").map((k) => [k.id, k.showDetails ?? null])),
    liveKeys: new Set(s.traces.filter((t) => !t.removedAt && t.includeInCim).map((t) => t.addbackKey)),
    agreeYears: new Set(tie.filter((r) => r.state === "agrees" || r.state === "accepted").map((r) => r.year)),
  };
}

// ── Projection: one CIM version's payload (pure apart from the guard) ───

export interface ProjectContext {
  staffNames: string[];
  heldNames: string[];
  /** Ledger documents whose entries this buyer may not read (the data room's deny) — totals stay. */
  withheldLedgerDocs?: ReadonlySet<string>;
  preview?: boolean;
  /** Deal facts for the blind guard. */
  deal?: Pick<Deal, "businessName" | "extractedInfo" | "blindCodename"> & { employeeChart?: unknown; industry?: string | null; subIndustry?: string | null } | null;
}

/** Does a line carry the Full/Blind mark? Found (or shown by a document) and every year agrees with the statements (or was accepted). */
function markFor(line: GlSnapshotLine, agree: ReadonlySet<string>): boolean {
  if (line.status !== "found" && line.status !== "document") return false;
  const ys = line.years.filter((y) => y.status !== "left_out");
  // A year shown only by a document (a T4) needs no tie-out.
  return ys.length > 0 && ys.every((y) => agree.has(y.year) || (y.entries.length === 0 && y.docs.length > 0));
}

function summaryOf(lines: GlSnapshotLine[]): GlEvidencePayload["summary"] {
  const n = (s: GlBuyerStatus) => lines.filter((l) => l.status === s).length;
  return { total: lines.length, found: n("found"), partly: n("partly_found"), notFound: n("not_found"), document: n("document"), statement: n("statement") };
}

/** The Full/Blind note for a snapshot (lines from the statements aren't counted: nothing to find in the books). */
export function noteFor(snap: GlPublishedEvidence): string | null {
  const proofLines = snap.lines.filter((l) => l.status !== "statement");
  return glNoteText({
    found: proofLines.filter((l) => l.status === "found").length,
    documents: proofLines.filter((l) => l.status === "document").length,
    total: proofLines.length,
    agreeYears: snap.noteYears,
  });
}

export function projectEvidence(snap: GlPublishedEvidence, mode: GlEvidenceMode, ctx: ProjectContext): GlEvidencePayload | null {
  if (mode === "dd" ? !snap.versions.dd : mode === "normal" ? !snap.versions.normal : !snap.versions.blind) return null;
  // Found-in-the-books lines first, lines straight from the statements last (older snapshots too).
  const lines = [...snap.lines].sort((a, b) => Number(a.status === "statement") - Number(b.status === "statement"));
  if (lines.length === 0) return null;
  const agree = new Set(snap.noteYears);
  const summary = summaryOf(lines);
  const base = { mode, publishedAt: ctx.preview ? null : snap.publishedAt, pageId: snap.pageId, summary, ...(ctx.preview ? { preview: true } : {}) };

  if (mode === "blind") {
    const note = noteFor(snap);
    if (!note) return null;
    const payload: GlEvidencePayload = {
      ...base, note,
      lines: lines.map((l) => ({ lineId: l.lineId, status: l.status, mark: markFor(l, agree) })),
    };
    // Constants, counts and fiscal years only — and the guard still reads it (fail-closed).
    if (ctx.deal) {
      const terms = blindLeakTerms(ctx.deal as any, { codename: ctx.deal.blindCodename || "Confidential Opportunity" });
      const texts = collectStrings(payload);
      if (findBlindLeaks(texts, terms).length > 0 || blindPlaceholders(texts).length > 0) return null;
    }
    return payload;
  }

  if (mode === "normal") {
    const note = noteFor(snap);
    if (!note) return null;
    return {
      ...base, note,
      lines: lines.map((l) => ({
        lineId: l.lineId, status: l.status, mark: markFor(l, agree), label: l.label,
        years: l.years.map((y) => {
          const found = Math.abs(y.entries.reduce((n, e) => n + e.amountCents, 0)) + y.docs.reduce((n, d) => n + d.amountCents, 0);
          return {
            year: y.year, yearLabel: y.yearLabel, claimed: dollars(y.claimedCents), target: dollars(y.targetCents), found: dollars(found),
            difference: dollars(found - y.targetCents), status: y.status, entryCount: y.entries.length, entries: [], moreEntries: 0,
          };
        }),
      })),
    };
  }

  // ── DD ──
  const ledgerOf = new Map(snap.ledgers.map((l) => [l.ledgerId, l]));
  const out: GlEvidenceLine[] = lines.map((l) => {
    const parties: Person[] = l.parties.map((p) => ({ first: p.first, last: p.last }));
    const years: GlEvidenceYear[] = l.years.map((y) => {
      const found = Math.abs(y.entries.reduce((n, e) => n + e.amountCents, 0)) + y.docs.reduce((n, d) => n + d.amountCents, 0);
      const denied = y.entries.length > 0 && y.entries.every((e) => {
        const led = e.ledgerId ? ledgerOf.get(e.ledgerId) : null;
        return !!led && !!ctx.withheldLedgerDocs?.has(led.documentId);
      });
      const shown = denied ? [] : y.entries.slice(0, GL_EVIDENCE_MAX_ENTRIES);
      const entries: GlEvidenceEntry[] = shown.map((e) => {
        const led = e.ledgerId ? ledgerOf.get(e.ledgerId) : null;
        const mctx: BuyerMaskContext = {
          staffNames: ctx.staffNames, heldNames: ctx.heldNames, parties, personalAddback: l.personal, showStaffNames: !!led?.showStaffNames,
        };
        const m = maskForBuyer({ account: e.account, name: e.name, memo: e.memo }, mctx, e.showDetails);
        return {
          date: e.date, account: m.account, name: m.name, memo: m.memo, amount: dollars(e.amountCents),
          ...(m.withheld ? { withheld: m.withheld } : {}),
          ledgerDocumentId: led?.documentId ?? null, rowNo: e.rowNo,
        };
      });
      return {
        year: y.year, yearLabel: y.yearLabel, claimed: dollars(y.claimedCents), target: dollars(y.targetCents), found: dollars(found),
        difference: dollars(found - y.targetCents), status: y.status, entryCount: y.entries.length, entries,
        moreEntries: denied ? 0 : Math.max(0, y.entries.length - shown.length),
        ...(denied ? { entriesOnRequest: true } : {}),
      };
    });
    // The ledger most of this line's entries come from.
    const counts = new Map<string, number>();
    for (const y of l.years) for (const e of y.entries) if (e.ledgerId) counts.set(e.ledgerId, (counts.get(e.ledgerId) ?? 0) + 1);
    const top = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0];
    const led = top ? ledgerOf.get(top) : null;
    return {
      lineId: l.lineId, status: l.status, mark: markFor(l, agree), label: l.label, years,
      share: l.share, why: l.why, brokerNote: l.brokerNote, sellerNote: l.sellerNote,
      ledger: led ? { documentId: led.documentId, software: led.software && led.software !== "other" ? softwareLabel(led.software) : null, period: led.period } : null,
      docs: l.years.flatMap((y) => y.docs.map((d) => ({ documentId: d.documentId, name: d.label, year: d.year, amount: dollars(d.amountCents), check: d.check }))),
      statementDocs: l.statementDocs,
    };
  });
  const first = snap.ledgers[0];
  const starts = snap.ledgers.map((x) => x.period).filter(Boolean);
  return {
    ...base,
    note: null,
    tieOut: snap.tieOut,
    confirmation: snap.confirmation,
    source: first ? { software: first.software && first.software !== "other" ? softwareLabel(first.software) : null, period: snap.ledgers.length === 1 ? first.period : starts.join("; ") } : null,
    lines: out,
  };
}

// ── Reads ───────────────────────────────────────────────────────────────

function emptySnapshotVersions(): GlPublishedEvidence["versions"] {
  return { dd: true, normal: false, blind: false };
}

/** The defaults the publish dialog starts from, and why a version starts off. */
export function defaultVersions(snap: GlPublishedEvidence): { versions: GlPublishedEvidence["versions"]; reasons: { normal: string | null; blind: string | null } } {
  const proof = snap.lines.filter((l) => l.status !== "statement");
  const agree = new Set(snap.noteYears);
  const allFound = proof.length > 0 && proof.every((l) => l.status === "found" || l.status === "document");
  const allAgree = proof.every((l) => markFor(l, agree));
  const reason = proof.length === 0
    ? "None of the add-backs shown need the books."
    : !allFound
      ? "Off because not every add-back was found in the books."
      : !allAgree
        ? "Off because the ledger doesn't agree with the statements for every year these add-backs cover."
        : null;
  const on = reason === null;
  return { versions: { dd: true, normal: on, blind: on }, reasons: { normal: reason, blind: reason } };
}

/**
 * A payload for one version. "live": from the current state (broker
 * previews; versions as the publish dialog's defaults, DD always on).
 * "published": the broker's snapshot, tightened now.
 */
export async function buildEvidence(
  dealId: string,
  mode: GlEvidenceMode,
  source: "published" | "live",
  ctx: { accessId?: string | null; withheldLedgerDocs?: ReadonlySet<string> } = {},
): Promise<GlEvidencePayload | null> {
  const s = await loadEvidenceState(dealId);
  let snap: GlPublishedEvidence;
  if (source === "live") {
    const built = await snapshotFromState(s, { versions: emptySnapshotVersions(), leaveOut: [], publishedBy: null });
    // A preview shows every version, so the broker sees the note before deciding.
    snap = { ...built.snapshot, versions: { dd: true, normal: true, blind: true } };
  } else {
    const pub = s.tracing.published as GlPublishedEvidence | null;
    if (!pub || pub.v !== 1) return null;
    snap = tightenPublished(pub, tightenCurrentFrom(s)).snapshot;
  }
  return projectEvidence(snap, mode, {
    staffNames: s.staffNames, heldNames: s.heldNames, preview: source === "live",
    withheldLedgerDocs: ctx.withheldLedgerDocs ?? (ctx.accessId ? await deniedLedgerDocs(dealId, ctx.accessId) : undefined),
    deal: s.deal ? { ...s.deal, blindCodename: s.deal.blindCodename } : null,
  });
}

// The data room's per-buyer deny rows (installed by the data room at the merge).
type DenyLookup = (dealId: string, accessId: string) => Promise<ReadonlySet<string>>;
let denyLookup: DenyLookup | null = null;
/** INTEGRATOR: the data room installs "ledger documents this buyer is denied" here (vdr shares with a deny row). */
export function setGlLedgerDenyLookup(fn: DenyLookup | null): void {
  denyLookup = fn;
}
async function deniedLedgerDocs(dealId: string, accessId: string): Promise<ReadonlySet<string> | undefined> {
  if (!denyLookup) return undefined;
  try {
    return await denyLookup(dealId, accessId);
  } catch (err) {
    // Fail closed: when the room can't answer, no entry is listed (totals stay).
    console.warn("[gl] data-room deny lookup failed; entries held:", (err as Error).message);
    const s = await glStore().listLedgers(dealId);
    return new Set(s.map((l) => l.documentId));
  }
}

/**
 * What a buyer's link gets: null for the teaser (checked first, C4), for
 * anything unpublished, and for a Blind payload the guard stops.
 */
export async function glEvidenceForBuyer(dealId: string, accessLevel: string | null | undefined, accessId: string | null): Promise<GlEvidencePayload | null> {
  if (isTeaserOnly(accessLevel)) return null;
  const mode = cimModeForAccessLevel(accessLevel);
  try {
    const tracing = await glStore().getTracing(dealId);
    if (!tracing?.published) return null;
    return await buildEvidence(dealId, mode, "published", { accessId });
  } catch (err) {
    // Before the release's db:push (or a read failure) buyers simply get no GL evidence.
    console.warn(`[gl] evidence for ${dealId} unavailable:`, (err as Error).message);
    return null;
  }
}

/** Bridge add-back (analysis id, or addbackKey) → the line id its "Found in the books" mark uses. */
export async function glLineIdsForDeal(dealId: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const traces = await glStore().listTraces(dealId);
  for (const t of traces) {
    if (t.removedAt) continue;
    const id = glLineId(dealId, t.addbackKey);
    out.set(t.addbackKey, id);
    if (t.analysisAddbackId) out.set(t.analysisAddbackId, id);
  }
  return out;
}

/**
 * The DD writer's context: from the PUBLISHED, tightened DD payload only —
 * label, status, per-year added back / found / difference / entry count.
 * Never a vendor, a description or withheld text. [] when nothing is published.
 */
export async function glWriterLines(dealId: string): Promise<string[]> {
  try {
    const p = await buildEvidence(dealId, "dd", "published");
    if (!p) return [];
    const words: Record<GlBuyerStatus, string> = { found: "found in the books", partly_found: "partly found in the books", not_found: "not found in the books", document: "shown by a supporting document", statement: "from the financial statements" };
    return p.lines.map((l) => {
      const ys = (l.years ?? []).filter((y) => y.status !== "left_out").map((y) =>
        l.status === "statement"
          ? `${y.year}: added back ${money(y.claimed)}`
          : `${y.year}: added back ${money(y.claimed)}, ${y.entryCount} ledger entr${y.entryCount === 1 ? "y" : "ies"} totalling ${money(y.found)} (difference ${money(y.difference)})`);
      return `- ${l.label ?? "Add-back"}: ${words[l.status]}${ys.length ? `; ${ys.join("; ")}` : ""}.`;
    });
  } catch {
    return [];
  }
}

export const GL_TEASER_LINE = "Earnings adjustments matched to the company's general ledger";

/** The teaser's line: only when the Blind note is published and every add-back shown was found in books that agree with the statements. */
export async function glTeaserLine(dealId: string): Promise<string | null> {
  try {
    const s = await loadEvidenceState(dealId);
    const pub = s.tracing.published as GlPublishedEvidence | null;
    if (!pub || pub.v !== 1 || !pub.versions.blind) return null;
    const snap = tightenPublished(pub, tightenCurrentFrom(s)).snapshot;
    const proof = snap.lines.filter((l) => l.status !== "statement");
    const agree = new Set(snap.noteYears);
    if (proof.length === 0 || !proof.every((l) => markFor(l, agree))) return null;
    return GL_TEASER_LINE;
  } catch {
    return null;
  }
}

// ── The broker's publish dialog ─────────────────────────────────────────

export interface PublishPreview {
  gate: GlGate;
  canPublish: boolean;
  blocked: string | null;
  versions: GlPublishedEvidence["versions"];
  reasons: { normal: string | null; blind: string | null };
  notes: { normal: string | null; blind: string | null };
  lines: Array<{ key: string; label: string; status: GlBuyerStatus; statusWords: string; defaultLeftOut: boolean; years: string[] }>;
  warnings: string[];
  published: { at: string; versions: GlPublishedEvidence["versions"]; leaveOut: string[] } | null;
  changes: string[];
  /** Years whose ledger agrees with the statements (or the difference was accepted): the dialog rewrites the note exactly as lines are left out. */
  agreeYears: string[];
}

export async function publishPreview(dealId: string): Promise<PublishPreview> {
  const s = await loadEvidenceState(dealId);
  const confirmed = s.links.filter((k) => k.state === "confirmed").length;
  const gate = gateFrom(s.tracing, s.traces, { confirmedLinks: confirmed });
  const { snapshot, skippedUnreviewed } = await snapshotFromState(s, { versions: emptySnapshotVersions(), leaveOut: [], publishedBy: null });
  const d = defaultVersions(snapshot);
  const words: Record<GlBuyerStatus, string> = { found: "Found in the books", partly_found: "Partly found", not_found: "Not found", document: "Shown by a document", statement: "From the statements" };
  const warnings: string[] = [];
  const privateOnly = s.traces.filter((t) => !t.removedAt && t.includeInCim && Object.values(((t.computed as GlTraceComputed | null)?.byYear) ?? {}).some((y) => y.privateOnly));
  if (privateOnly.length) warnings.push(`${privateOnly.length} add-back${privateOnly.length === 1 ? " is" : "s are"} supported only by a ledger that's private to you — buyers won't see those entries.`);
  const dd = projectEvidence({ ...snapshot, versions: { dd: true, normal: false, blind: false } }, "dd", { staffNames: s.staffNames, heldNames: s.heldNames });
  const withheld = (dd?.lines ?? []).reduce((n, l) => n + (l.years ?? []).reduce((m, y) => m + y.entries.filter((e) => e.withheld).length, 0), 0);
  if (withheld) warnings.push(`${withheld} personal entr${withheld === 1 ? "y and employees' names are" : "ies and employees' names are"} withheld from buyers.`);
  warnings.push("The entries are shown in the due-diligence CIM to every due-diligence buyer, even one who doesn't have the ledger in their data room.");
  for (const r of snapshot.tieOut.filter((x) => x.state === "differs")) {
    warnings.push(`${r.year}: the ledger's net income differs from the statements${r.difference ? ` by ${money(Math.abs(r.difference))}` : ""} and you haven't accepted it — the Full and Blind notes won't mention ${r.year}.`);
  }
  if (skippedUnreviewed.length) warnings.push(`Not reviewed yet, so left out: ${skippedUnreviewed.join(", ")}.`);
  const pub = s.tracing.published as GlPublishedEvidence | null;
  const changes = pub && pub.v === 1 ? await changesSincePublished(s, pub) : [];
  const done = gate.state === "done" || gate.state === "waived";
  const blocked = !done
    ? `Finish 'Add-backs in the books' first (${gate.toGo} of ${gate.total} to go), or go ahead without the ledger.`
    : snapshot.lines.length === 0
      ? "There's nothing to show yet — no add-back has been reviewed."
      : null;
  return {
    gate,
    canPublish: !blocked,
    blocked,
    versions: d.versions,
    reasons: d.reasons,
    notes: { normal: noteFor(snapshot), blind: noteFor(snapshot) },
    lines: snapshot.lines.map((l) => ({ key: l.addbackKey, label: l.label, status: l.status, statusWords: words[l.status], defaultLeftOut: false, years: l.years.map((y) => y.year) })),
    warnings,
    published: pub && pub.v === 1 ? { at: pub.publishedAt, versions: pub.versions, leaveOut: pub.leaveOut } : null,
    changes,
    agreeYears: snapshot.tieOut.filter((r) => r.state === "agrees" || r.state === "accepted").map((r) => r.year),
  };
}

/** What changed since the broker published: what tightening took away, and what waits for "Update what buyers see". */
async function changesSincePublished(s: EvidenceState, pub: GlPublishedEvidence): Promise<string[]> {
  const tight = tightenPublished(pub, tightenCurrentFrom(s));
  const out = [...tight.changes];
  const { snapshot: live } = await snapshotFromState(s, { versions: pub.versions, leaveOut: pub.leaveOut, publishedBy: null });
  const was = new Map(tight.snapshot.lines.map((l) => [l.addbackKey, l]));
  for (const l of live.lines) {
    const p = was.get(l.addbackKey);
    if (!p) { if (!pub.leaveOut.includes(l.addbackKey)) out.push(`${l.label}: reviewed since — not shown to buyers until you update.`); continue; }
    if (p.status !== l.status) out.push(`${l.label}: now "${GL_STATUS_WORD[l.status]}" — buyers still see "${GL_STATUS_WORD[p.status]}" until you update.`);
    else {
      const n = (x: GlSnapshotLine) => x.years.reduce((k, y) => k + y.entries.length + y.docs.length, 0);
      if (n(p) !== n(l)) out.push(`${l.label}: the entries changed — buyers see the earlier list until you update.`);
    }
  }
  return out;
}

const GL_STATUS_WORD: Record<GlBuyerStatus, string> = { found: "Found in the books", partly_found: "Partly found", not_found: "Not found", document: "Shown by a document", statement: "From the statements" };

export class GlPublishError extends Error {
  status = 409;
  code = "gl_publish_refused";
}

/** "Show to buyers": the broker's snapshot, saved under the GL lock. */
export async function publishEvidence(
  dealId: string,
  body: { versions: GlPublishedEvidence["versions"]; leaveOut: string[] },
  by: string | null,
): Promise<{ publishedAt: string; versions: GlPublishedEvidence["versions"]; lines: number }> {
  return withGlLock(dealId, async () => {
    const s = await loadEvidenceState(dealId);
    const gate = gateFrom(s.tracing, s.traces, { confirmedLinks: s.links.filter((k) => k.state === "confirmed").length });
    if (gate.state !== "done" && gate.state !== "waived") {
      throw new GlPublishError(`Finish 'Add-backs in the books' first (${gate.toGo} of ${gate.total} to go), or go ahead without the ledger.`);
    }
    const known = new Set(s.traces.map((t) => t.addbackKey));
    const leaveOut = Array.from(new Set(body.leaveOut.filter((k) => known.has(k))));
    const { snapshot } = await snapshotFromState(s, { versions: body.versions, leaveOut, publishedBy: by });
    if (snapshot.lines.length === 0 || (!body.versions.dd && !body.versions.normal && !body.versions.blind)) {
      throw new GlPublishError("Nothing would be shown to buyers — tick at least one version and keep at least one add-back.");
    }
    if (!body.versions.dd && !noteFor(snapshot)) {
      throw new GlPublishError("The Full and Blind notes need at least one add-back found in the books.");
    }
    await glStore().updateTracing(dealId, { published: snapshot, publishedAt: new Date(snapshot.publishedAt), publishedBy: by } as Partial<GlTracing>);
    return { publishedAt: snapshot.publishedAt, versions: snapshot.versions, lines: snapshot.lines.length };
  });
}

/** "Stop showing it to buyers". */
export async function unpublishEvidence(dealId: string): Promise<void> {
  await withGlLock(dealId, async () => {
    await glStore().updateTracing(dealId, { published: null, publishedAt: null, publishedBy: null } as Partial<GlTracing>);
  });
}

/** The KPI cell's "{k} changes since you published". */
export async function evidenceChangeCount(dealId: string): Promise<{ publishedAt: string | null; changes: string[] }> {
  const s = await loadEvidenceState(dealId);
  const pub = s.tracing.published as GlPublishedEvidence | null;
  if (!pub || pub.v !== 1) return { publishedAt: null, changes: [] };
  return { publishedAt: pub.publishedAt, changes: await changesSincePublished(s, pub) };
}

