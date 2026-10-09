/**
 * dd-citations — what the due-diligence CIM cites, for the data room
 * (stream "vdr" contract, dd spec §11.1, INTEGRATION §2.6).
 *
 *   ddCitedDocuments(dealId)            every document the DD CIM's figure layer
 *                                       would cite once its checks are on: the
 *                                       figures' own statements, both sides of each
 *                                       check, note citations, "Sources for this
 *                                       page", the "From the documents" key terms and
 *                                       the check page ("dd-source-check") — each with
 *                                       the section it is cited on. Only documents that
 *                                       may be cited (`citableDocument`: never
 *                                       broker-only, CRM, email or call sources).
 *   ddDocumentChecks(dealId, docId)     the figure checks in which a document is one
 *                                       side, in vdr's exact shape. `regrouped` counts
 *                                       as a match. `other` carries only the other
 *                                       document's id (vdr titles it for the reader).
 *
 * Both read the same raw inputs and the same buyer-side rules as the view room
 * (no AI, no writes). ddDocumentChecks defaults to what a due-diligence buyer
 * is served now; the broker's data room passes { audience: "broker" } to list
 * every check.
 *
 * vdr consumes these; nothing here builds a document link, a title or a route.
 */
import type { Deal } from "@shared/schema";
import { buildBuyerCim } from "@shared/cim-buyer-view";
import { DD_ACCESS_LEVEL } from "@shared/access-levels";
import {
  DD_SOURCE_CHECK_PAGE_ID,
  sourceCheckRowLabel,
  type FigureCheckInput,
  type FigureDocRef,
  type FigureInputs,
  type FigureLayer,
  type FigureView,
} from "@shared/figure-layer";
import { parseFigureKey } from "@shared/figure-lines";
import { dollars } from "@shared/figure-compare";

/** vdr's VdrDocRef + the section it is cited on ("dd-source-check" for the check page). */
export type DdCitedDocument = FigureDocRef & { sectionId: string };

/** vdr §11.1: one check of a document against another record. */
export interface DdDocumentCheck {
  label: string;
  thisValue: string;
  other: { documentId: string } | null;
  otherValue: string | null;
  status: "match" | "differs";
  explanation: string | null;
}

const refOnly = (r: FigureDocRef): FigureDocRef => ({
  documentId: r.documentId,
  kind: r.kind,
  period: r.period ?? null,
  page: r.page ?? null,
  needle: r.needle ?? null,
});

/**
 * Pure: every citation the layer serves, per section, deduplicated by
 * (document, section). `citable` is the serve-time rule (raw.docs).
 */
export function citedDocumentsOfLayer(layer: FigureLayer | null | undefined, citable: (documentId: string) => boolean): DdCitedDocument[] {
  if (!layer || layer.mode !== "dd") return [];
  const out: DdCitedDocument[] = [];
  const seen = new Set<string>();
  const add = (ref: FigureDocRef | null | undefined, sectionId: string) => {
    if (!ref || !ref.documentId || !citable(ref.documentId)) return;
    const k = `${ref.documentId}@${sectionId}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ ...refOnly(ref), sectionId });
  };
  const fromFigure = (f: FigureView, sectionId: string) => {
    for (const r of f.citations ?? []) add(r, sectionId);
    for (const r of f.why?.citations ?? []) add(r, sectionId);
    for (const p of f.parts ?? []) for (const r of p.why?.citations ?? []) add(r, sectionId);
    for (const c of f.checks ?? []) {
      if (c.preview) continue; // broker-only marks never count as cited
      add((c as { baseCitation?: FigureDocRef | null }).baseCitation ?? null, sectionId);
      add(c.citation, sectionId);
      for (const r of c.note?.citations ?? []) add(r, sectionId);
    }
  };
  for (const a of layer.anchors) {
    const f = layer.figures[a.fig];
    if (f) fromFigure(f, a.pageId);
  }
  for (const [pageId, refs] of Object.entries(layer.pageSources ?? {})) for (const r of refs) add(r, pageId);
  for (const [pageId, terms] of Object.entries(layer.keyTerms ?? {})) for (const t of terms) add(t.citation, pageId);
  return out;
}

/**
 * Pure: the served checks in which `documentId` is one side. `checks` are the
 * inputs the layer was built from (to know each side's document and value);
 * `idFor` maps a check key to the id the layer used (opaque for buyers).
 */
export function documentChecksOf(
  layer: FigureLayer | null | undefined,
  checks: ReadonlyArray<FigureCheckInput>,
  idFor: (key: string) => string,
  documentId: string,
  lineLabel: (figureKey: string) => string | null,
): DdDocumentCheck[] {
  if (!layer || layer.mode !== "dd") return [];
  const byId = new Map<string, FigureCheckInput>();
  for (const c of checks) byId.set(idFor(c.key), c);
  const out: DdDocumentCheck[] = [];
  const seen = new Set<string>();
  for (const f of Object.values(layer.figures)) {
    for (const cv of f.checks ?? []) {
      const c = byId.get(cv.id);
      if (!c || seen.has(c.key)) continue;
      const base = c.baseCitation?.documentId ?? null;
      const other = c.otherCitation?.documentId ?? null;
      const isBase = base === documentId;
      const isOther = other === documentId;
      if (!isBase && !isOther) continue;
      seen.add(c.key);
      const parsed = parseFigureKey(c.figureKey);
      const name = f.label ?? lineLabel(c.figureKey) ?? (parsed ? sourceCheckRowLabel(parsed.line) : "A figure");
      const year = parsed?.year ?? f.year;
      const match = cv.state === "match" || cv.state === "regrouped";
      out.push({
        label: `${name}, FY${year}`,
        thisValue: dollars(isBase ? c.base : c.other),
        other: (isBase ? other : base) ? { documentId: (isBase ? other : base)! } : null,
        otherValue: dollars(isBase ? c.other : c.base),
        status: match ? "match" : "differs",
        explanation: cv.note?.text ?? null,
      });
    }
  }
  return out;
}

// ── IO ────────────────────────────────────────────────────────────────────

interface DdBuild {
  layer: FigureLayer | null;
  inputs: FigureInputs | null;
  citable: (documentId: string) => boolean;
  lineLabel: (figureKey: string) => string | null;
}

/** The DD layer over the sections DD buyers are served (no writes, no AI). */
async function ddLayerFor(deal: Deal, opts: { audience: "buyer" | "broker"; checksOn: "as_is" | "on" }): Promise<DdBuild> {
  const [{ loadFigureRaw, figureInputsFor }, { buyerCimRows }, { loadMediaAssets }, { listedAskingPrice }] = await Promise.all([
    import("./figures/serve"),
    import("./published-snapshot"),
    import("./media-store"),
    import("../information/deal-mirror"),
  ]);
  const raw = await loadFigureRaw(deal.id);
  const citable = (id: string) => !!raw.docs.get(id)?.citable;
  const lineLabel = (k: string) => raw.registry[k]?.lineLabel ?? null;
  const base = figureInputsFor(raw, { audience: opts.audience, mode: "dd" });
  if (!base) return { layer: null, inputs: null, citable, lineLabel };
  const inputs: FigureInputs = opts.checksOn === "on" && !base.ddShownAt ? { ...base, ddShownAt: new Date().toISOString() } : base;
  const rows = await buyerCimRows(deal, DD_ACCESS_LEVEL);
  if (rows.missing) return { layer: null, inputs, citable, lineLabel };
  const media = await loadMediaAssets(deal.id).catch(() => []);
  const cim = buildBuyerCim({
    deal, accessLevel: DD_ACCESS_LEVEL, sections: rows.sections, overrides: rows.overrides, media,
    askingPrice: listedAskingPrice(deal), published: rows.published, figures: inputs,
  } as any);
  return { layer: cim.figureLayer, inputs, citable, lineLabel };
}

async function dealOf(dealId: string): Promise<Deal | null> {
  const { storage } = await import("../storage");
  return (await storage.getDeal(dealId)) ?? null;
}

/**
 * Every document the DD CIM cites once its checks are on, with the section
 * it is cited on. Never a broker-only, CRM, email or call document.
 */
export async function ddCitedDocuments(dealId: string): Promise<DdCitedDocument[]> {
  const deal = await dealOf(dealId);
  if (!deal) return [];
  try {
    const { layer, citable } = await ddLayerFor(deal, { audience: "buyer", checksOn: "on" });
    return citedDocumentsOfLayer(layer, citable);
  } catch (err) {
    console.warn("[dd-citations] cited documents:", (err as Error)?.message);
    return [];
  }
}

/**
 * The checks in which this document is one side. Buyers (default): what a
 * due-diligence buyer is served now. Broker: every check, marks included.
 */
export async function ddDocumentChecks(
  dealId: string,
  documentId: string,
  opts: { audience?: "buyer" | "broker" } = {},
): Promise<DdDocumentCheck[]> {
  const deal = await dealOf(dealId);
  if (!deal) return [];
  try {
    const audience = opts.audience ?? "buyer";
    const { layer, inputs, citable, lineLabel } = await ddLayerFor(deal, { audience, checksOn: "as_is" });
    if (!inputs || (audience === "buyer" && !citable(documentId))) return [];
    return documentChecksOf(layer, inputs.checks, inputs.idFor ?? ((k) => k), documentId, lineLabel);
  } catch (err) {
    console.warn("[dd-citations] document checks:", (err as Error)?.message);
    return [];
  }
}

export { DD_SOURCE_CHECK_PAGE_ID };
