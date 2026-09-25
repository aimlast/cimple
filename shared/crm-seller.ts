/**
 * Seller-side CRM import — response shapes shared by the server
 * (server/routes/crm-seller.ts) and the broker UI (CRM card, Seller card,
 * New Deal "Start from my CRM"). Pure types.
 */
import type { CrmImportStatus, CrmRecordType, DealCrmLink, DealSellerContact } from "./schema";

/** One hit from a CRM search (deals, organisations, people). */
export interface CrmSearchResult {
  type: CrmRecordType;
  id: string;
  title: string;
  /** "Maple Ridge Physiotherapy · Dana Whitfield · Open" */
  subtitle: string | null;
}

export interface CrmSearchResponse {
  connected: boolean;
  provider: "pipedrive" | null;
  results: CrmSearchResult[];
}

/** What New Deal can prefill from a picked CRM record. */
export interface CrmPrefill {
  businessName: string | null;
  /** The CRM's own industry wording, when a field for it exists. */
  industryText: string | null;
  location: string | null;
  websiteUrl: string | null;
  contact: Omit<DealSellerContact, "source" | "updatedAt"> | null;
  /** Display name of the picked record ("Maple Ridge Physio — sale"). */
  title: string;
}

/** The seller as the broker sees them: the saved contact, else the seller invite. */
export interface SellerContactView {
  name: string | null;
  email: string | null;
  phone: string | null;
  title: string | null;
  source: DealSellerContact["source"] | null;
  updatedAt: string | null;
  /** The seller invite, when there is one. */
  invite: { name: string | null; email: string | null; status: "created" | "emailed" | "opened" } | null;
}

export interface CrmStatusResponse {
  /** A CRM (Pipedrive) is connected for this broker. */
  connected: boolean;
  provider: "pipedrive" | null;
  link: (Omit<DealCrmLink, "imported" | "lastImportStatus"> & { importedCount: number }) | null;
  /** Live while an import runs, else the last one. */
  import: CrmImportStatus | null;
  seller: SellerContactView;
}
