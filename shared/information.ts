/**
 * Collected information — the shape of GET /api/deals/:id/information.
 *
 * Every fact Cimple holds about the business, grouped by CIM section, with
 * the exact source of each (which document, which interview turn, which
 * email / call / CRM note / website item, or the broker's own edit), the
 * values other sources gave, and every source the deal has. Pure types —
 * shared by the server (server/information/view.ts) and the broker UI.
 */
import type { SourceKind, DocumentSourceMeta } from "./schema";
import type { CimReadiness } from "./cim-readiness";

/** A source kind, or "unknown" for values recorded before sources were tracked. */
export type FactSourceKind = SourceKind | "unknown";

export interface FactSourceInfo {
  kind: FactSourceKind;
  /** "Seller interview · turn 12", "Document · 2024 Compilation.pdf", "CRM note"… */
  label: string;
  documentId?: string;
  documentName?: string;
  sessionId?: string;
  turn?: number;
  at?: string;
  note?: string;
  excerpt?: string;
  /**
   * The fact was collected before Cimple recorded sources; this source was
   * traced by matching the value to the interview / questionnaire / a
   * document / the website, not recorded at the time.
   */
  inferred?: boolean;
  /** A website / CRM / social value the broker accepted into the facts — shown as a fact, not a lead. */
  acceptedByBroker?: boolean;
  /**
   * From a broker-only source (a CRM note or activity, a private email or
   * file): the seller never sees it and the interview doesn't use it.
   */
  brokerOnly?: boolean;
}

export interface FactAlternate {
  /** Key the alternate is stored under — the fact key, or "revenueByYear.2023" for one year of a map. */
  altKey: string;
  /** Position in that key's list — pass to POST …/facts/:altKey/use-alternate. */
  index: number;
  /** Map sub-key (the year) when altKey is dotted. */
  subKey?: string;
  value: string;
  displayValue: string;
  source: FactSourceInfo;
}

export type FactConfidence = "confirmed" | "inferred" | "approximate" | "unverified";

export interface InformationFact {
  key: string;
  label: string;
  value: unknown;
  displayValue: string;
  /** True when the value is a map (e.g. revenue by year) — edited as "key: value" lines. */
  isMap: boolean;
  source: FactSourceInfo;
  confidence: FactConfidence;
  alternates: FactAlternate[];
  /** Other sources that state the same value (deleting one keeps the fact). */
  corroboratedBy?: FactSourceInfo[];
  brokerEdited: boolean;
  /** Industry checklist / broker-added item flags. */
  industrySpecific?: boolean;
  critical?: boolean;
}

export interface InformationMissing {
  key: string;
  label: string;
  critical: boolean;
}

export interface InformationSection {
  key: string;
  title: string;
  importance: "critical" | "important" | "helpful";
  importanceReason: string;
  status: "well_covered" | "partial" | "missing";
  /** The broker left this section out of the interview outline. */
  excluded: boolean;
  facts: InformationFact[];
  missing: InformationMissing[];
}

export interface InformationSource {
  /** documents.id, or "session:<id>", "questionnaire", "website", "broker". */
  id: string;
  kind: SourceKind;
  title: string;
  /** ISO date the source is from (email/call date, upload date, session start). */
  date: string | null;
  meta: DocumentSourceMeta | null;
  visibility: "shared" | "broker_only";
  /** Facts on file from this source, including ones traced to it (see inferredFactCount). */
  factCount: number;
  /** How many of factCount were traced by matching values, not recorded at the time. */
  inferredFactCount?: number;
  /** documents rows only */
  documentId?: string;
  status?: string;
  uploadedBy?: string;
  fileUrl?: string;
  category?: string;
  hasText?: boolean;
  /** interview/call sessions only */
  sessionId?: string;
  turns?: number;
  /** What the extraction noted about the source as a whole. */
  highlights?: {
    summary?: string;
    keyFacts?: string;
    redFlags?: string;
    actionItems?: string;
    sellerConcerns?: string;
    followUpNeeded?: string;
  };
}

export interface DeletedFact {
  key: string;
  label: string;
  displayValue: string;
  source: FactSourceInfo;
  deletedAt: string;
}

export interface WebsiteItem {
  field: string;
  label: string;
  value: string;
  /** The fact key "Accept into facts" writes. */
  factKey: string;
  /** accepted = on file from the website; on_file = another source already holds this fact; new = not on file. */
  status: "accepted" | "on_file" | "new";
}

export interface InformationView {
  sections: InformationSection[];
  /** Facts that don't belong to any CIM section. */
  other: InformationFact[];
  sources: InformationSource[];
  /** Visible facts per source kind. */
  counts: Partial<Record<FactSourceKind, number>>;
  totalFacts: number;
  /** Facts whose source was traced (inferred), not recorded: collected before source tracking. */
  inferredFacts?: number;
  readiness: CimReadiness;
  deleted: DeletedFact[];
  website: {
    url: string | null;
    scrapedAt: string | null;
    scrapeSource: string | null;
    items: WebsiteItem[];
  } | null;
}
