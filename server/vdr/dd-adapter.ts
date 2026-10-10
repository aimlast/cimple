import type { CimSection, CimSectionOverride, Deal, Document } from "@shared/schema";
import { citableDocument } from "@shared/vdr";

/**
 * The data room's side of the dd contract (INTEGRATION §2.6, vdr spec §11.1):
 * what the due-diligence CIM cites comes from dd's registry
 * (server/cim/dd-citations.ts — the figures' statements, both sides of each
 * check, note citations, page sources, key terms and the check page), never
 * from a second rule here. Broker-only, email, call and CRM sources are never
 * cited (`citableDocument`, applied by dd at build AND serve time). No AI.
 *
 * Null = there is no CIM to cite anything yet, so the Data room tab shows
 * "Share what the DD CIM cites" disabled ("Generate the due-diligence CIM
 * first"). A CIM whose figure layer cites nothing → [] (nothing to share).
 *
 * `citedByFactTracing` (below) was the stand-in until dd merged — the
 * documents whose figures the DD sections print. It is kept (and tested) as
 * the documented fallback rule, but no route calls it any more.
 */
export type DdAdapterDeps = {
  cited: (dealId: string) => Promise<Array<{ documentId: string; sectionId: string; page?: number | null }>>;
  hasCim: (dealId: string) => Promise<boolean>;
};

async function defaultDdDeps(): Promise<DdAdapterDeps> {
  const [{ ddCitedDocuments }, { storage }] = await Promise.all([import("../cim/dd-citations"), import("../storage")]);
  return {
    cited: (id) => ddCitedDocuments(id),
    hasCim: async (id) => (await storage.getCimSectionsByDeal(id)).some((s) => s.isVisible !== false),
  };
}

const citedMemo = new Map<string, { at: number; ids: string[] | null }>();

export async function ddCitedDocumentIds(dealId: string, depsIn?: DdAdapterDeps): Promise<string[] | null> {
  const hit = !depsIn ? citedMemo.get(dealId) : undefined;
  if (hit && Date.now() - hit.at < MEMO_MS) return hit.ids;
  try {
    const deps = depsIn ?? (await defaultDdDeps());
    const rows = await deps.cited(dealId);
    const ids: string[] | null = rows.length > 0
      ? Array.from(new Set(rows.map((r) => r.documentId)))
      : (await deps.hasCim(dealId)) ? [] : null;
    if (!depsIn) {
      citedMemo.set(dealId, { at: Date.now(), ids });
      if (citedMemo.size > 500) citedMemo.clear();
    }
    return ids;
  } catch (err: any) {
    console.warn(`[vdr] couldn't read what the DD CIM cites for ${dealId}:`, err?.message ?? err);
    return null;
  }
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
 * dd's checks in which this document is one side (dd-citations
 * `ddDocumentChecks`). Buyers (the default): exactly what a due-diligence
 * buyer is served now. The broker's room passes { audience: "broker" } — every
 * check, marks included; when dd has none for the document, null, so the
 * broker sees the discrepancy-based checks instead (an empty list would hide
 * them).
 */
export async function ddDocumentChecks(dealId: string, documentId: string, opts: { audience?: "buyer" | "broker" } = {}): Promise<DdDocumentCheck[] | null> {
  const { ddDocumentChecks: dd } = await import("../cim/dd-citations");
  const checks = await dd(dealId, documentId, { audience: opts.audience ?? "buyer" });
  if (opts.audience === "broker" && checks.length === 0) return null;
  return checks;
}

/**
 * The DD CIM pages that point to one document ("Cited by the DD CIM" in the
 * broker's drawer), from dd's registry: each section it is cited on, with the
 * page when the citation names one. The check page ("How the figures check
 * out") is synthetic — it has no stored section, so it is titled here.
 */
export async function ddCitedSections(dealId: string, documentId: string, depsIn?: DdAdapterDeps & { sections?: (dealId: string) => Promise<Array<Pick<CimSection, "id" | "sectionTitle" | "isVisible">>> }): Promise<Array<{ sectionId: string; title: string; page: number | null }>> {
  try {
    const deps = depsIn ?? (await defaultDdDeps());
    const loadSections = depsIn?.sections ?? (async (id: string) => (await import("../storage")).storage.getCimSectionsByDeal(id));
    const rows = (await deps.cited(dealId)).filter((r) => r.documentId === documentId);
    if (rows.length === 0) return [];
    const [{ DD_SOURCE_CHECK_PAGE_ID }, { getCimLayout }, sections] = await Promise.all([
      import("@shared/figure-layer"),
      import("@shared/cim-layouts"),
      loadSections(dealId),
    ]);
    const byId = new Map(sections.map((s) => [s.id, s]));
    const out: Array<{ sectionId: string; title: string; page: number | null }> = [];
    const seen = new Set<string>();
    for (const r of rows) {
      if (seen.has(r.sectionId)) continue;
      const s = byId.get(r.sectionId);
      const title = r.sectionId === DD_SOURCE_CHECK_PAGE_ID ? getCimLayout("dd_source_check")?.label ?? "How the figures check out"
        : s && s.isVisible !== false ? s.sectionTitle : null;
      if (!title) continue;
      seen.add(r.sectionId);
      out.push({ sectionId: r.sectionId, title, page: typeof r.page === "number" && r.page > 0 ? r.page : null });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * The deal's documents shared with due-diligence buyers in the data room —
 * a live item with a level share for Due diligence (the same rule as the
 * Data room tab's "DD cited · not shared", broker-room.ts). Null when the
 * deal has no data room (dd's "Documents cited" KPI then shows no "shared"
 * line). Release fix (security-integration F2): the KPI's documentsShared was
 * a hard-coded null. Never throws.
 */
export async function ddSharedDocumentIds(dealId: string, storeIn?: Pick<import("./store").VdrStore, "getRoom" | "listItems" | "listShares">): Promise<Set<string> | null> {
  try {
    const store = storeIn ?? (await import("./store")).dbVdrStore;
    const room = await store.getRoom(dealId);
    if (!room) return null;
    const [items, shares] = await Promise.all([store.listItems(dealId), store.listShares(dealId)]);
    const { DD_ACCESS_LEVEL } = await import("@shared/access-levels");
    const { shareSummary } = await import("@shared/vdr");
    const out = new Set<string>();
    for (const it of items) {
      if (it.removedAt || !it.documentId) continue;
      if (shareSummary(shares.filter((s) => s.itemId === it.id) as any).levels.includes(DD_ACCESS_LEVEL as any)) out.add(it.documentId);
    }
    return out;
  } catch (err: any) {
    console.warn(`[vdr] couldn't read the shared documents for ${dealId}:`, err?.message ?? err);
    return null;
  }
}
