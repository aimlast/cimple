/**
 * Discrepancy rows as every screen and consumer reads them — pure helpers
 * shared by the server (engine, analyzer, routes) and the client
 * (DiscrepancyPanel, Overview).
 *
 * Contract (discrepancies table):
 *  - interviewValue = the seller-side / spoken value (interview, call,
 *    video_call, email, questionnaire — or a broker-private CRM claim);
 *    documentValue = the document / statement side.
 *  - sideSources = { interview?: SideSource; document?: SideSource } says
 *    where each side came from. A side with brokerOnly is the broker's
 *    private material: it is never shown to the seller or quoted by the
 *    interview, and privacy is decided from this flag, not from text.
 *  - factKey / factYear = the real extractedInfo key (and fiscal year for a
 *    per-year map) the discrepancy is about; resolution writes there.
 *  - source: "interview" (the verification check), "financial_analysis",
 *    or "merge" (raised by the fact merge itself when two sources disagree).
 */
import type { SourceKind } from "./schema";

export interface DiscrepancySideSource {
  kind: SourceKind;
  documentId?: string;
  /** The broker's private material (a CRM note, a broker-only file). */
  brokerOnly?: boolean;
  /** Broker-facing name of the source ("Premises lease 2019–2029"). Never shown to the seller. */
  label?: string;
}

export interface DiscrepancySideSources {
  interview?: DiscrepancySideSource;
  document?: DiscrepancySideSource;
}

type SideRow = {
  field?: string | null;
  factKey?: string | null;
  factYear?: string | null;
  source?: string | null;
  status?: string | null;
  interviewValue?: string | null;
  documentValue?: string | null;
  sideSources?: unknown;
};

/**
 * Wording that points at the broker's private material. A discrepancy text
 * that matches is treated as private (fail closed): it never reaches the
 * seller, and the engines never store it in routable text.
 */
export const PRIVATE_REFERENCE_RE =
  /\b(?:crm|pipedrive|hubspot|salesforce|broker(?:'s|’s)?\s+(?:note|notes|recast|estimate|estimates|valuation|meeting|call|memo|file|files)|per (?:the )?broker|site[- ]visit(?:\s+notes?)?|private notes?|broker[- ]only)\b/i;

export function mentionsPrivateSource(text: string | null | undefined): boolean {
  return !!text && PRIVATE_REFERENCE_RE.test(text);
}

export function getSideSources(d: Pick<SideRow, "sideSources">): DiscrepancySideSources {
  const raw = d.sideSources;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: DiscrepancySideSources = {};
  for (const side of ["interview", "document"] as const) {
    const s = (raw as Record<string, unknown>)[side];
    if (s && typeof s === "object" && typeof (s as DiscrepancySideSource).kind === "string") out[side] = s as DiscrepancySideSource;
  }
  return out;
}

/** True when either side is the broker's private material (flag, or text that names it). */
export function discrepancyHasPrivateSide(d: SideRow): { interview: boolean; document: boolean } {
  const sides = getSideSources(d);
  return {
    interview: !!sides.interview?.brokerOnly || sides.interview?.kind === "crm" || mentionsPrivateSource(d.interviewValue),
    document: !!sides.document?.brokerOnly || sides.document?.kind === "crm" || mentionsPrivateSource(d.documentValue),
  };
}

/**
 * The value on one side without the " — source" label the financial
 * analysis appends ("$1,894,000 — 2024 P&L" → "$1,894,000"). Rows from the
 * verification check and the merge store bare values already; legacy
 * verification rows are prose and are kept whole.
 */
export function discrepancySideValue(d: SideRow, side: "interview" | "document"): string {
  const raw = (side === "interview" ? d.interviewValue : d.documentValue) || "";
  const labelled = d.source === "financial_analysis";
  if (!labelled) return raw.trim();
  const idx = raw.indexOf(" — ");
  return (idx > 0 ? raw.slice(0, idx) : raw).trim();
}

/** The " — source" label of a financial-analysis side, if any. */
export function discrepancySideLabel(d: SideRow, side: "interview" | "document"): string | null {
  const sides = getSideSources(d);
  const s = sides[side];
  if (s?.label) return s.label;
  if (d.source !== "financial_analysis") return null;
  const raw = (side === "interview" ? d.interviewValue : d.documentValue) || "";
  const idx = raw.indexOf(" — ");
  return idx > 0 ? raw.slice(idx + 3).trim() || null : null;
}

const ACRONYMS: Record<string, string> = {
  sde: "SDE", ebitda: "EBITDA", ebit: "EBIT", mrr: "MRR", arr: "ARR", hst: "HST", gst: "GST", nwc: "NWC",
  cim: "CIM", fy: "FY", ar: "AR", ap: "AP", msa: "MSA", ltc: "LTC", odb: "ODB", ceo: "CEO", cfo: "CFO",
  coo: "COO", it: "IT", hvac: "HVAC", roi: "ROI", kpi: "KPI", sku: "SKU", pnl: "P&L", yoy: "YoY",
};

/**
 * Broker-readable name of a discrepancy's subject: an AI label as written
 * ("Alderbrook revenue percentage"); a raw camelCase key split into words
 * ("yardRentActual" → "Yard rent actual", "adjustedEBITDA2024" → "Adjusted
 * EBITDA 2024").
 */
export function humanizeFieldKey(field: string): string {
  const t = (field || "").trim();
  if (!t) return "";
  if (/\s/.test(t)) return t; // already a label
  const words = t
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/(\d)([A-Za-z])/g, "$1 $2")
    .split(/\s+/)
    .filter(Boolean);
  const out = words.map((w, i) => {
    const lower = w.toLowerCase();
    if (ACRONYMS[lower]) return ACRONYMS[lower];
    if (/^[A-Z]{2,}$/.test(w)) return w; // an acronym we don't know
    return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
  });
  return out.join(" ");
}

export function discrepancyFieldLabel(d: Pick<SideRow, "field" | "factKey" | "factYear">): string {
  const base = humanizeFieldKey(d.field || d.factKey || "");
  return d.factYear && !base.includes(String(d.factYear)) ? `${base} (${d.factYear})` : base;
}

/** "resolved" and "accepted" are both settled — shown with the same check mark. */
export function isSettledDiscrepancy(d: Pick<SideRow, "status">): boolean {
  return d.status === "resolved" || d.status === "accepted";
}

const KIND_LABELS: Record<string, string> = {
  interview: "Seller interview",
  call: "Call",
  video_call: "Video call",
  questionnaire: "Questionnaire",
  email: "Email",
  document: "Document",
  crm: "CRM note",
  website: "Website",
  social: "Social media",
  broker: "Broker edit",
  system: "System",
};

/** Heading for one side's value in the panel ("Call said", "Document shows", "Your private note"). */
export function discrepancySideHeading(d: SideRow, side: "interview" | "document"): string {
  const s = getSideSources(d)[side];
  if (s) {
    if (s.brokerOnly || s.kind === "crm") return "Your private notes";
    const kind = KIND_LABELS[s.kind] ?? "Source";
    return side === "interview" ? `${kind} said` : `${kind} shows`;
  }
  if (d.source === "financial_analysis") return side === "interview" ? "Source A" : "Source B";
  if (d.source === "merge") return side === "interview" ? "Seller said" : "Document shows";
  return side === "interview" ? "Interview / Seller said" : "Document shows";
}
