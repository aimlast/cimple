/**
 * The data room's side of the dd contract (INTEGRATION §2.6, vdr spec §11.1).
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ INTEGRATOR, at the dd merge: return the ids from dd's registry —         │
 * │   const { ddCitedDocuments } = await import("../cim/dd-citations");      │
 * │   return Array.from(new Set((await ddCitedDocuments(dealId))            │
 * │     .map((r) => r.documentId)));                                         │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Until then (dd not merged) there are no citations: null, so the Data room
 * tab shows "Share what the DD CIM cites" disabled ("Generate the
 * due-diligence CIM first") and the KPI's DD-cited count is 0.
 */
export async function ddCitedDocumentIds(_dealId: string): Promise<string[] | null> {
  return null;
}

/** dd's per-document checks (INTEGRATION §2.6 `ddDocumentChecks`; `regrouped` counts as match). */
export type DdDocumentCheck = {
  label: string;
  thisValue: string;
  other: { documentId: string } | null;
  otherValue: string | null;
  status: "match" | "differs";
  explanation: string | null;
};

/**
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ INTEGRATOR, at the dd merge:                                             │
 * │   const { ddDocumentChecks: dd } = await import("../cim/dd-citations");  │
 * │   return dd(dealId, documentId);                                         │
 * └──────────────────────────────────────────────────────────────────────────┘
 * Until then: null (the broker sees the discrepancy-based checks; buyers none).
 */
export async function ddDocumentChecks(_dealId: string, _documentId: string): Promise<DdDocumentCheck[] | null> {
  return null;
}
