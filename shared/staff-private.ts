/**
 * Staff-private matters held back from the CIM — the shape the broker sees.
 *
 * An employee's private business with the owner (asking to buy in, a raise
 * request, talk of leaving, a warning on file, their health or family) is
 * not the buyer's to read: the rebuilt Beacon CIM printed the lead
 * pharmacist's informal ask for an equity stake in two sections (founder,
 * 2026-09-28: "I don't want to include it in the CIM"). Such clauses are held
 * out of every CIM input by default (server/cim/staff-private.ts); the
 * broker sees each one on the CIM tab and may switch it back in.
 *
 * Pure types and wording — shared by the server and the CIM tab.
 */

export type StaffPrivateKind = "equity" | "pay" | "departure" | "conduct" | "personal" | "conversation";

/** What the held clause is about, in the broker's words. */
export const STAFF_PRIVATE_LABEL: Record<StaffPrivateKind, string> = {
  equity: "interest in an ownership stake",
  pay: "pay request or dispute",
  departure: "possible departure",
  conduct: "performance or disciplinary matter",
  personal: "personal or family circumstances",
  conversation: "private conversation with the owner",
};

export interface StaffPrivateItem {
  /** Stable id of the held words (the include switch is keyed by it). */
  id: string;
  /** The fact the words come from. */
  key: string;
  kind: StaffPrivateKind;
  /** The held words, exactly as the fact states them. */
  text: string;
  /** Short description: "Daniel Okafor's interest in an ownership stake". */
  description: string;
  /** The staff member it is about, when the facts name them. */
  person?: string | null;
  /** "rules" = the deterministic screen; "ai" = the confidentiality review. */
  by: "rules" | "ai";
}

/** An item as the CIM tab lists it. */
export interface StaffPrivateListItem extends StaffPrivateItem {
  /** The broker switched it back in: it goes into the CIM on the next generation. */
  included: boolean;
  /** The fact's label as the Information tab shows it. */
  label: string;
}

/** Where the broker's include decisions are kept (extractedInfo bookkeeping key — never a CIM input). */
export const STAFF_PRIVATE_INCLUDED_KEY = "_cimIncludedPrivate";

/** An include decision's id as the API accepts it. */
export const STAFF_PRIVATE_ID_RE = /^sp[0-9a-z]{6,14}$/;

/** "Daniel Okafor's interest in an ownership stake" / "A staff member's possible departure". */
export function describeStaffPrivate(kind: StaffPrivateKind, person: string | null): string {
  const who = person ? `${person}${/s$/i.test(person) ? "'" : "'s"}` : "A staff member's";
  return `${who} ${STAFF_PRIVATE_LABEL[kind]}`;
}
