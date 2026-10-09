/**
 * gl-evidence.ts — what buyers are shown about the add-backs found in the
 * general ledger (gl spec §8.1, INTEGRATION §2.2). Pure; shared by the
 * server (server/gl/evidence.ts builds the payloads), buildBuyerCim (places
 * them) and the client (GlEvidenceBlock / GlMark render them).
 *
 *   DD CIM      a page of its own, "Where each add-back is in the books",
 *               right after the earnings-bridge section: per add-back the
 *               entries behind it (masked for buyers), the documents, the
 *               broker's reason, whether the ledger agrees with the
 *               statements, and who confirmed the entries.
 *   Full CIM    one note under the earnings bridge, counts and fiscal years only.
 *   Blind CIM   the same note — constants, numbers and fiscal years, nothing else.
 *   Teaser      nothing.
 *
 * Buyer words (D22): "found in the books" — never "traced", "verified" or
 * "substantiated"; always "matched by the owner, reviewed by the broker;
 * not an audit".
 */
import type { GlYearStatus } from "./gl-types";

export type GlEvidenceMode = "dd" | "normal" | "blind";
export type GlBuyerStatus = "found" | "partly_found" | "not_found" | "document" | "statement";

/** The synthetic DD page (layout registry key, section key, title). */
export const GL_EVIDENCE_LAYOUT = "gl_evidence";
export const GL_EVIDENCE_SECTION_KEY = "gl_addback_evidence";
export const GL_EVIDENCE_TITLE = "Where each add-back is in the books";
/** Entries shown per year on the DD page (the rest: "+n more in the general ledger"). */
export const GL_EVIDENCE_MAX_ENTRIES = 200;
/** Entries shown before "Show all". */
export const GL_EVIDENCE_FIRST_ENTRIES = 12;

export interface GlEvidenceEntry {
  date: string;
  account: string;
  name: string | null;
  memo: string | null;
  /** Dollars (debit − credit). */
  amount: number;
  /** Set when the details were withheld from buyers (date, account and amount stay). */
  withheld?: "personal" | "staff" | "keep_out";
  ledgerDocumentId: string | null;
  rowNo: number | null;
}

export interface GlEvidenceDoc {
  documentId: string;
  /** A neutral label ("T4 2024", "Supporting document (2024)") — never the file's own name. */
  name: string;
  year: string;
  /** Dollars typed against the document for the year. */
  amount: number;
  check: "found_in_document" | "not_found" | "unreadable";
}

export interface GlEvidenceYear {
  year: string;
  /** The analysis's own label ("FY2024"). */
  yearLabel: string;
  /** Dollars added back for the year. */
  claimed: number;
  /** Dollars the entries should total (claimed ÷ share for a portion). */
  target: number;
  /** Dollars of entries and documents that support it. */
  found: number;
  /** found − target. */
  difference: number;
  status: GlYearStatus;
  entryCount: number;
  /** DD only (≤ GL_EVIDENCE_MAX_ENTRIES). */
  entries: GlEvidenceEntry[];
  /** Entries not listed here (in the general ledger). */
  moreEntries: number;
  /** DD: some or all of this year's entries are held from this buyer (the data room's deny on their file) — totals kept. */
  entriesOnRequest?: boolean;
  /** DD: how many of `entryCount` are held (the rest are in `entries`). */
  entriesHeld?: number;
}

export interface GlEvidenceLine {
  /** HMAC(SESSION_SECRET, dealId + addbackKey).slice(0, 12) — stable across re-runs, different across deals. */
  lineId: string;
  status: GlBuyerStatus;
  /** Carries the Full/Blind row chip: found or shown by a document, and every year agrees with the statements (or the difference was accepted). */
  mark: boolean;
  /** Normal + DD: the bridge's wording (a held name taken out). Never in Blind. */
  label?: string;
  /** Normal: counts only; DD: entries. */
  years?: GlEvidenceYear[];
  /** DD: the share added back of a cost (meals at 50%). */
  share?: { pct: number; basis: "estimate" | "documented"; doc?: string } | null;
  /** DD: the owner's or a related party's pay — the year shows the pay, which the bridge may split (excess / market salary). */
  pay?: boolean;
  /** DD: "Why it's added back" — the broker's text, screened. */
  why?: string | null;
  /** DD, when the broker shows it. */
  brokerNote?: string | null;
  /** DD, when the broker shows it, screened. */
  sellerNote?: string | null;
  /** DD: the general ledger the entries come from. */
  ledger?: { documentId: string; software: string | null; period: string } | null;
  /** DD: supporting documents (a T4, an invoice). */
  docs?: GlEvidenceDoc[];
  /** DD: lines from the statements cite them. */
  statementDocs?: Array<{ documentId: string; name: string; year: string }>;
}

export interface GlEvidenceTieOut {
  year: string;
  state: "agrees" | "accepted" | "differs" | "cannot_check";
  /** Dollars. */
  difference?: number;
  /** The broker's note on an accepted difference (screened). */
  note?: string | null;
}

export interface GlEvidencePayload {
  mode: GlEvidenceMode;
  publishedAt: string | null;
  /** "glsec_" + HMAC(SESSION_SECRET, dealId + ":page").slice(0, 12) — computed on the server so buildBuyerCim needs no secret. */
  pageId: string;
  summary: { total: number; found: number; partly: number; notFound: number; document: number; statement: number };
  /** Normal/Blind: the exact note text, or null when that version is off. */
  note: string | null;
  /** DD. */
  tieOut?: GlEvidenceTieOut[];
  /** DD: who confirmed the entries ("the owner" / "the company's accountant") and when. */
  confirmation?: { role: "owner" | "accountant"; at: string } | null;
  /** DD: the export the entries come from ("QuickBooks Online export", "Jan 2022 – Dec 2024"). */
  source?: { software: string | null; period: string } | null;
  lines: GlEvidenceLine[];
  /** Broker previews only: this is the live data, not what buyers see yet. */
  preview?: boolean;
}

// ── The broker's published snapshot (gl_tracing.published; server only) ──

/** One entry as published (raw: masking is re-applied every time it is served). */
export interface GlSnapshotEntry {
  linkId: string;
  ledgerId: string | null;
  rowNo: number | null;
  date: string;
  account: string;
  name: string | null;
  memo: string | null;
  amountCents: number;
  /** The broker's per-entry choice when published: true shows a withheld entry, false withholds it, null = the rules. */
  showDetails: boolean | null;
}

export interface GlSnapshotDoc {
  documentId: string;
  label: string;
  year: string;
  amountCents: number;
  check: "found_in_document" | "not_found" | "unreadable";
}

export interface GlSnapshotYear {
  year: string;
  yearLabel: string;
  claimedCents: number;
  targetCents: number;
  documentCents: number;
  status: GlYearStatus;
  entries: GlSnapshotEntry[];
  docs: GlSnapshotDoc[];
}

export interface GlSnapshotLine {
  traceId: string;
  addbackKey: string;
  lineId: string;
  /** The bridge's wording at publish (held names taken out). */
  label: string;
  status: GlBuyerStatus;
  /** People the add-back is about (the owner, a related party; lower case): their entries are shown as the point of the add-back. */
  parties: Array<{ first: string; last: string }>;
  /** The add-back is a personal or related-party cost (personal entries in it are withheld). */
  personal: boolean;
  /** The owner's or a related party's pay (shown as pay, not as the amount added back). */
  pay?: boolean;
  share: { pct: number; basis: "estimate" | "documented"; doc?: string } | null;
  why: string | null;
  brokerNote: string | null;
  sellerNote: string | null;
  years: GlSnapshotYear[];
  statementDocs: Array<{ documentId: string; name: string; year: string }>;
}

export interface GlPublishedEvidence {
  v: 1;
  publishedAt: string;
  publishedBy: string | null;
  versions: { dd: boolean; normal: boolean; blind: boolean };
  /** addbackKeys the broker left out of what buyers see. */
  leaveOut: string[];
  pageId: string;
  /** The years the Full/Blind note says agree with the statements. */
  noteYears: string[];
  ledgers: Array<{ ledgerId: string; documentId: string; software: string | null; period: string; showStaffNames: boolean }>;
  tieOut: GlEvidenceTieOut[];
  confirmation: { role: "owner" | "accountant"; at: string } | null;
  lines: GlSnapshotLine[];
}

// ── Words ──

export const GL_BUYER_STATUS_WORDS: Record<GlBuyerStatus, string> = {
  found: "Found in the books",
  partly_found: "Partly found",
  not_found: "Not found",
  document: "Shown by a document",
  statement: "From the financial statements",
};

/** Every buyer surface says this (D22). */
export const GL_NOT_AN_AUDIT = "Matched by the owner and reviewed by the broker; not an audit.";

/** "2022–2024", "2022 and 2024". */
export function glYearsWords(years: string[]): string {
  const ys = Array.from(new Set(years)).filter((y) => /^\d{4}$/.test(y)).sort();
  if (ys.length === 0) return "";
  if (ys.length === 1) return ys[0];
  const consecutive = ys.every((y, i) => i === 0 || Number(y) === Number(ys[i - 1]) + 1);
  if (consecutive) return `${ys[0]}–${ys[ys.length - 1]}`;
  return `${ys.slice(0, -1).join(", ")} and ${ys[ys.length - 1]}`;
}

/**
 * The Full/Blind note (constants, counts and fiscal years only — blind-safe
 * by construction). null when nothing was found.
 *   "6 of 6 add-backs: the costs were found in the company's general ledger,
 *    which agrees with the financial statements for 2022–2024. Matched by the
 *    owner and reviewed by the broker; not an audit."
 */
export function glNoteText(input: { found: number; documents: number; total: number; agreeYears: string[] }): string | null {
  const shown = input.found + input.documents;
  if (input.total <= 0 || shown <= 0) return null;
  const head = `${shown} of ${input.total} add-back${input.total === 1 ? "" : "s"}`;
  const years = glYearsWords(input.agreeYears);
  const ledger = `found in the company's general ledger${years ? `, which agrees with the financial statements for ${years}` : ""}`;
  const where = input.documents > 0 && input.found > 0
    ? `the costs were ${ledger}${years ? "," : ""} or shown by supporting documents such as pay slips`
    : input.documents > 0
      ? "the costs were shown by supporting documents such as pay slips"
      : `the costs were ${ledger}`;
  return `${head}: ${where}. ${GL_NOT_AN_AUDIT}`;
}

/** The DD page's opening paragraph. */
export function glIntroText(source: { software: string | null; period: string } | null | undefined): string {
  const what = source?.software ? `${source.software}${source.period ? `, ${source.period}` : ""}` : source?.period ?? "";
  const from = what ? ` (${what})` : "";
  return `Each add-back below is matched to entries in the company's general ledger${from}. This shows where each cost is recorded. It was matched by the owner and reviewed by the broker; it is not an audit or a quality-of-earnings review.`;
}

/** The DD page's tie-out lines ("2022 and 2024: the ledger's revenue and net income agree with the financial statements."). */
export function glTieOutLines(rows: GlEvidenceTieOut[] | null | undefined, money: (dollars: number) => string): string[] {
  const list = rows ?? [];
  const out: string[] = [];
  const agree = list.filter((r) => r.state === "agrees").map((r) => r.year);
  if (agree.length) out.push(`${glYearsWords(agree)}: the ledger's revenue and net income agree with the financial statements.`);
  for (const r of list.filter((x) => x.state === "accepted")) {
    const diff = r.difference ? ` differs from the statements by ${money(Math.abs(r.difference))}` : " differs from the statements";
    out.push(`${r.year}: the ledger's net income${diff}.${r.note ? ` The broker notes: “${r.note}”` : ""}`);
  }
  for (const r of list.filter((x) => x.state === "differs")) {
    const diff = r.difference ? ` by ${money(Math.abs(r.difference))}` : "";
    out.push(`${r.year}: the ledger's net income differs from the statements${diff}. Ask the broker about this difference.`);
  }
  const cannot = list.filter((r) => r.state === "cannot_check").map((r) => r.year);
  if (cannot.length) out.push(`${glYearsWords(cannot)}: there were no financial statements to compare the ledger with.`);
  return out;
}

/** "Entries confirmed by the owner on Oct 12, 2026." */
export function glConfirmationText(c: { role: "owner" | "accountant"; at: string } | null | undefined): string | null {
  if (!c) return null;
  const d = new Date(c.at);
  if (Number.isNaN(+d)) return null;
  const when = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  return `Entries confirmed by ${c.role === "accountant" ? "the company's accountant" : "the owner"} on ${when}.`;
}

/** What a withheld entry says instead of its name and description. */
export const GL_WITHHELD_WORDS: Record<NonNullable<GlEvidenceEntry["withheld"]>, string> = {
  personal: "Personal expense — details withheld",
  staff: "Employee pay — name withheld",
  keep_out: "Details withheld",
};

/** "Meals & entertainment entries $22,000 × 50% personal share = $11,000 added back. The 50% is the owner's estimate; it is not recorded in the books." */
export function glShareText(label: string, share: NonNullable<GlEvidenceLine["share"]>, target: number, claimed: number, money: (d: number) => string): string {
  const basis = share.basis === "documented"
    ? `The ${share.pct}% is documented${share.doc ? ` by ${share.doc}` : ""}.`
    : `The ${share.pct}% is the owner's estimate; it is not recorded in the books.`;
  return `${label} entries ${money(target)} × ${share.pct}% personal share = ${money(claimed)} added back. ${basis}`;
}

// ── Placement (pure) ──

type AnchorSection = { sectionKey?: string | null; sectionTitle?: string | null; layoutType?: string | null };

const BRIDGE_RE = /normali[sz]|add-?backs?|adjusted (?:ebitda|earnings)|\bsde\b|earnings bridge|quality of earnings/i;
const FINANCIAL_RE = /financial|income statement|profit/i;
const CLOSING_RE = /contact|closing|next steps|disclaimer|confidential/i;

/**
 * The section the DD page follows and the Full/Blind note is attached to:
 * the last earnings bridge (a waterfall, or a section about normalisation,
 * add-backs, adjusted EBITDA, SDE); else the last financial section; else
 * the section before a contact/closing page; else the last. -1 for none.
 */
export function glEvidenceAnchor(sections: ReadonlyArray<AnchorSection>): number {
  if (sections.length === 0) return -1;
  const text = (s: AnchorSection) => `${s.sectionKey ?? ""} ${s.sectionTitle ?? ""}`.replace(/_/g, " ");
  for (let i = sections.length - 1; i >= 0; i--) {
    const s = sections[i];
    if (s.layoutType === "waterfall_chart" || BRIDGE_RE.test(text(s))) return i;
  }
  for (let i = sections.length - 1; i >= 0; i--) if (FINANCIAL_RE.test(text(sections[i]))) return i;
  const closing = sections.findIndex((s) => CLOSING_RE.test(text(s)) && s.layoutType !== "cover_page");
  if (closing > 0) return closing - 1;
  return sections.length - 1;
}

/** The note as the anchor section carries it (layoutData._glNote). */
export interface GlNoteData {
  text: string;
  /** The lines whose "Found in the books" mark is on (row chips elsewhere in the CIM). */
  lineIds: string[];
  /** A broker preview of the live data (not what buyers see yet). */
  preview?: boolean;
}

/** Read the note a section carries (renderer; ignores anything malformed). */
export function glNoteOf(layoutData: unknown): GlNoteData | null {
  if (!layoutData || typeof layoutData !== "object") return null;
  const n = (layoutData as Record<string, unknown>)._glNote as Partial<GlNoteData> | undefined;
  if (!n || typeof n.text !== "string" || !n.text.trim()) return null;
  return { text: n.text, lineIds: Array.isArray(n.lineIds) ? n.lineIds.filter((x): x is string => typeof x === "string") : [], ...(n.preview ? { preview: true } : {}) };
}

/** Is this a GL evidence payload (renderer guard)? */
export function isGlEvidencePayload(v: unknown): v is GlEvidencePayload {
  return !!v && typeof v === "object" && Array.isArray((v as GlEvidencePayload).lines) && typeof (v as GlEvidencePayload).pageId === "string";
}
