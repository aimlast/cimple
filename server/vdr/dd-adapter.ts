import type { CimSection, CimSectionOverride, Deal, Document } from "@shared/schema";
import { citableDocument } from "@shared/vdr";

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
 * Until then (dd not merged) the spec's FALLBACK answers (vdr spec §11.1.4):
 * fact tracing over the DD version — every room document whose figures the
 * deal's due-diligence sections print (`documentCimLinks`, the same rule as
 * "Used in the CIM"). No DD version yet → null, so the Data room tab shows
 * "Share what the DD CIM cites" disabled ("Generate the due-diligence CIM
 * first"). Broker-only, email, call and CRM sources are never cited
 * (`citableDocument`). No AI.
 */
export async function ddCitedDocumentIds(dealId: string): Promise<string[] | null> {
  return citedByFactTracing(dealId);
}

export type FactTracingDeps = {
  getDeal: (id: string) => Promise<Pick<Deal, "id" | "extractedInfo"> | null | undefined>;
  ddOverrides: (dealId: string) => Promise<Array<Pick<CimSectionOverride, "cimSectionId" | "layoutData" | "contentOverride">>>;
  sections: (dealId: string) => Promise<Array<Pick<CimSection, "id" | "sectionTitle" | "isVisible">>>;
  documents: (dealId: string) => Promise<Document[]>;
};

async function defaultTracingDeps(): Promise<FactTracingDeps> {
  const { storage } = await import("../storage");
  return {
    getDeal: (id) => storage.getDeal(id),
    ddOverrides: (id) => storage.getCimSectionOverrides(id, "dd"),
    sections: (id) => storage.getCimSectionsByDeal(id),
    documents: (id) => storage.getDocumentsByDeal(id),
  };
}

const memo = new Map<string, { at: number; ids: string[] | null }>();
const MEMO_MS = 20_000;

/** The fallback: documents whose figures the DD sections print. Null when the deal has no DD version. Never throws. */
export async function citedByFactTracing(dealId: string, depsIn?: FactTracingDeps): Promise<string[] | null> {
  const hit = !depsIn ? memo.get(dealId) : undefined;
  if (hit && Date.now() - hit.at < MEMO_MS) return hit.ids;
  try {
    const deps = depsIn ?? (await defaultTracingDeps());
    const [deal, overrides, sections, docs] = await Promise.all([deps.getDeal(dealId), deps.ddOverrides(dealId), deps.sections(dealId), deps.documents(dealId)]);
    let ids: string[] | null = null;
    if (deal && overrides.length > 0) {
      const { documentCimLinks, documentFacts, sectionText } = await import("./analysis");
      const byId = new Map(sections.map((s) => [s.id, s]));
      const texts = overrides
        .map((o) => {
          const s = byId.get(o.cimSectionId);
          if (!s || s.isVisible === false) return null;
          return sectionText({ id: s.id, sectionTitle: s.sectionTitle, brokerEditedContent: o.contentOverride ?? null, aiDraftContent: null, layoutData: o.layoutData ?? null });
        })
        .filter((x): x is NonNullable<typeof x> => !!x);
      const info = (deal.extractedInfo ?? {}) as Record<string, unknown>;
      ids = docs
        .filter((doc) => citableDocument(doc))
        .filter((doc) => documentCimLinks(documentFacts(info, doc.id), texts).links.length > 0)
        .map((doc) => doc.id);
    }
    if (!depsIn) {
      memo.set(dealId, { at: Date.now(), ids });
      if (memo.size > 500) memo.clear();
    }
    return ids;
  } catch (err: any) {
    console.warn(`[vdr] couldn't trace what the DD CIM cites for ${dealId}:`, err?.message ?? err);
    return null;
  }
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
