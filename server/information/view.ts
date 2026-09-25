/**
 * Builds the broker's "Collected information" view for a deal: every fact,
 * grouped by CIM section, with its exact source, the values other sources
 * gave, what's still missing, and every source the deal has.
 *
 * Pure (no I/O) — the route loads the deal, its documents and interview
 * sessions and passes them in. Grouping follows the interview's CIM sections
 * (SECTION_FIELD_MAP + the industry checklist + broker-added items) so this
 * view, the interview's coverage and the quality score always agree.
 */
import { CIM_SECTIONS, type Deal, type Document, type InterviewSession, type DocumentSourceMeta } from "@shared/schema";
import type {
  InformationView,
  InformationFact,
  InformationSection,
  InformationSource,
  FactSourceInfo,
  FactAlternate,
  FactConfidence,
  FactSourceKind,
  DeletedFact,
  WebsiteItem,
} from "@shared/information";
import { computeCimReadiness } from "@shared/cim-readiness";
import { buildSectionCoverage, SECTION_FIELD_MAP, isSubstantiveValue } from "../interview/knowledge-base";
import { coverageAdjustmentsForDeal, getInterviewPlan, fieldLabel } from "../interview/interview-plan";
import { getSectionImportance } from "../interview/section-importance";
import { getInterviewOutline } from "../interview/outline";
import { brokerPrivacy } from "../interview/seller-view";
import {
  getFieldSources,
  getFieldAlternates,
  describeSource,
  isSourceKind,
  repairCharIndexedValue,
  serializeFactValue,
  getFieldCorroborations,
  SOURCE_META_KEYS,
  type FieldSource,
  type SourceKind,
} from "../interview/info-merger";
import { BROKER_DELETED_KEY, BROKER_SECTION_OF_KEY, BROKER_FACT_LABELS_KEY, websiteFactKey } from "./facts";
import { inferFieldSources, isUntrackedSource, type InferredFieldSource } from "./infer-sources";
import { brokerAcceptedSource } from "./cim-facts";

/**
 * Per-source notes the extractor records (summaries, call logistics) — about
 * a source rather than the business: shown on the source in the Sources
 * panel, never as facts. Defined next to the provenance helpers so every
 * consumer (ingest, CIM writers, interview prompt) filters the same set.
 */
export { SOURCE_META_KEYS };

/** Labels for common extractor / ad-hoc keys the generic map doesn't name. */
const EXTRA_LABELS: Record<string, string> = {
  revenueByYear: "Revenue by year",
  grossProfit: "Gross profit",
  grossMargin: "Gross margin",
  ebitda: "EBITDA",
  sde: "SDE (seller's discretionary earnings)",
  addbacks: "Add-backs",
  netIncome: "Net income",
  netProfit: "Net profit",
  yearsOfData: "Years of financials provided",
  keyFinancialNotes: "Notes on the financials",
  monthlyRent: "Monthly rent",
  leaseExpiry: "Lease expiry",
  leaseSqft: "Leased space",
  leaseAddress: "Premises address",
  leaseRenewalOptions: "Lease renewal options",
  fullTimeCount: "Full-time staff",
  partTimeCount: "Part-time staff",
  employeeNotes: "Notes on staff",
  legalNotes: "Legal notes",
  contracts: "Contracts",
  operationsNotes: "Notes on operations",
  locations: "Locations",
  numberOfLocations: "Number of locations",
  yearFounded: "Year founded",
  businessDescription: "Business description",
  websiteUrl: "Website",
};

/** Keys that sit in two generic sections — shown once, in their main one. */
const PRIMARY_SECTION: Record<string, string> = {
  annualRevenue: "financials",
  revenueGrowth: "financials",
  operatingMargins: "financials",
};

/** Where common non-section keys belong, for display. */
const DISPLAY_SECTION_HINTS: Record<string, string> = {
  revenueByYear: "financials", grossProfit: "financials", grossMargin: "financials", ebitda: "financials",
  sde: "financials", addbacks: "financials", netIncome: "financials", netProfit: "financials",
  yearsOfData: "financials", keyFinancialNotes: "financials", cashFlow: "financials", profitability: "financials",
  monthlyRent: "real_estate", leaseExpiry: "real_estate", leaseSqft: "real_estate", leaseAddress: "real_estate",
  leaseRenewalOptions: "real_estate",
  fullTimeCount: "employees", partTimeCount: "employees", employeeNotes: "employees",
  legalNotes: "permits_licenses",
  operationsNotes: "operations",
  locations: "overview", numberOfLocations: "overview", yearFounded: "overview", businessDescription: "overview",
  websiteUrl: "overview",
};

/**
 * Last-resort display grouping for ad-hoc keys the interview or a document
 * minted (ownerSalary, cerecMill, activePatientCount…) — first match wins.
 * Display only: coverage and the interview are unaffected.
 */
const KEY_SECTION_PATTERNS: Array<[RegExp, string]> = [
  [/^(companyName|ownerName|legalName|tradeName|dba|businessName)$/i, "overview"],
  [/askingPrice|dealStructure|saleType|sellerFinanc|earnOut/i, "asking_price"],
  [/revenueShare|revenueMix|Mix$|stream|services?$|products?$/i, "revenue_sources"],
  [/equipment|software|system|supplier|vendor|inventory|mill|technolog|process/i, "operations"],
  [/revenue|sales|ebitda|sde|profit|margin|income|expense|cost|wage|salary|payroll|depreciation|debt|loan|cash|fiscal|liabilit|receivable|payable|capex|addback|currency|tax/i, "financials"],
  [/lease|rent|premises|sqft|squareFeet|property|building/i, "real_estate"],
  [/licen|permit|compliance|regulat|insurance|accredit|certif/i, "permits_licenses"],
  [/employee|staff|hygienist|associate|dentist|manager|team|personnel|contractor|owner(Role|Hours|Involvement)/i, "employees"],
  [/patient|customer|client|market|referral|payer|demographic/i, "target_market"],
  [/season|peak|slow/i, "seasonality"],
  [/growth|expansion|opportunit/i, "growth_potential"],
  [/training|transition|handover/i, "training_support"],
];

const LIVE_KINDS = new Set(["interview", "call", "video_call"]);

type Info = Record<string, unknown>;

export function displayValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map((x) => displayValue(x)).join(", ");
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>);
    // Year maps read newest first
    entries.sort(([a], [b]) => (/^\d{4}$/.test(a) && /^\d{4}$/.test(b) ? Number(b) - Number(a) : a.localeCompare(b)));
    return entries.map(([k, val]) => `${k}: ${displayValue(val)}`).join(" · ");
  }
  return String(v);
}

function hasValue(v: unknown): boolean {
  if (v === null || v === undefined || v === "") return false;
  if (typeof v === "object" && !Array.isArray(v)) return Object.keys(v as object).length > 0;
  return true;
}

export interface InformationInputs {
  deal: Deal;
  documents: Document[];
  sessions: InterviewSession[];
}

export function buildInformationView({ deal, documents, sessions }: InformationInputs): InformationView {
  const info = ((deal.extractedInfo as Info | null) || {}) as Info;
  const sources = getFieldSources(info);
  const alternates = getFieldAlternates(info);
  const docById = new Map(documents.map((d) => [d.id, d]));
  const docName = (id: string) => docById.get(id)?.name;
  // A value a broker-only source asserted never reaches the interview (see
  // interview/seller-view.ts) — the chip says so instead of "the interview
  // confirms it".
  const { isPrivateSource } = brokerPrivacy(documents);
  const sessionKinds = new Map<string, SourceKind>();
  for (const s of sessions) {
    const meta = (s.extractedInfo as Info | null) || {};
    const via = meta._conductedVia;
    sessionKinds.set(
      s.id,
      meta._conductedBy === "broker_with_seller" ? (typeof via === "string" && via !== "person" ? "video_call" : "call") : "interview",
    );
  }
  // Latest session's confidence map (interview-captured facts only).
  const latest = [...sessions].sort((a, b) => +new Date(b.lastActivityAt) - +new Date(a.lastActivityAt))[0];
  const confidenceLevels = ((latest?.extractedInfo as Info | null)?._confidenceLevels as Record<string, string> | undefined) ?? {};

  const sourceInfo = (raw: InferredFieldSource | undefined | null): FactSourceInfo => {
    if (!raw || !isSourceKind(raw.source) || isUntrackedSource(raw)) {
      return { kind: "unknown", label: "Collected before Cimple recorded where each fact came from" };
    }
    const src = raw;
    const documentName = src.documentId ? docName(src.documentId) : undefined;
    return {
      kind: src.source,
      label: describeSource(src, docName) + (src.inferred ? " (inferred)" : ""),
      ...(src.inferred ? { inferred: true } : {}),
      ...(brokerAcceptedSource(src) ? { acceptedByBroker: true } : {}),
      ...(isPrivateSource(src) ? { brokerOnly: true } : {}),
      ...(src.documentId ? { documentId: src.documentId } : {}),
      ...(documentName ? { documentName } : {}),
      ...(src.sessionId ? { sessionId: src.sessionId } : {}),
      ...(typeof src.turn === "number" ? { turn: src.turn } : {}),
      ...(src.at ? { at: src.at } : {}),
      ...(src.note ? { note: src.note } : {}),
      ...(src.excerpt ? { excerpt: src.excerpt } : {}),
    };
  };

  const confidenceOf = (key: string, src: InferredFieldSource | undefined): FactConfidence => {
    const kind = src?.source;
    if (kind === "broker") return "confirmed";
    // A website / CRM / social value the broker accepted into the facts is
    // treated as a fact everywhere (CIM writers included) — shown as such.
    if (brokerAcceptedSource(src)) return "confirmed";
    // A fact collected before sources were tracked, now traced to the
    // questionnaire / a document / the website: the interview's own label for
    // it ("Approximate"…) still applies — the tracing only guesses the source.
    if (src?.inferred && !LIVE_KINDS.has(kind ?? "")) {
      const c = confidenceLevels[key];
      if (c === "confirmed" || c === "approximate" || c === "inferred") return c;
    }
    if (kind === "crm" || kind === "website" || kind === "social") return "unverified";
    if (!kind || LIVE_KINDS.has(kind)) {
      const c = confidenceLevels[key];
      if (c === "confirmed" || c === "approximate" || c === "inferred") return c;
      return "inferred";
    }
    return "inferred";
  };

  // Labels: industry checklist + broker-added items + the broker's own labels.
  const plan = getInterviewPlan(deal);
  const outline = getInterviewOutline(deal);
  const planLabels = new Map<string, { label: string; critical: boolean }>();
  for (const item of plan?.items ?? []) planLabels.set(item.key, { label: item.label, critical: item.critical });
  for (const item of outline.addedItems ?? []) if (!planLabels.has(item.key)) planLabels.set(item.key, { label: item.label, critical: false });
  const brokerLabels = (info[BROKER_FACT_LABELS_KEY] as Record<string, string> | undefined) || {};
  const labelOf = (key: string) =>
    brokerLabels[key] ?? planLabels.get(key)?.label ?? EXTRA_LABELS[key] ?? fieldLabel(key);

  const alternatesFor = (key: string): FactAlternate[] => {
    const out: FactAlternate[] = [];
    const push = (altKey: string, subKey?: string) => {
      // The value on file right now (a whole fact, or one year of a map) —
      // an alternate stating it isn't "another value".
      const currentRaw = subKey
        ? (repairCharIndexedValue(info[key]) as Record<string, unknown> | undefined)?.[subKey]
        : repairCharIndexedValue(info[key]);
      const current = currentRaw === undefined || currentRaw === null ? null : serializeFactValue(currentRaw);
      const seen = new Set<string>();
      (alternates[altKey] ?? []).forEach((a, index) => {
        if (!a || typeof a.value !== "string") return;
        const { value, ...src } = a;
        let parsed: unknown = value;
        if (/^[\[{]/.test(value)) { try { parsed = JSON.parse(value); } catch { /* keep text */ } }
        // Older rows stored a corrupted map as character soup — repair it.
        parsed = repairCharIndexedValue(parsed);
        const shown = serializeFactValue(parsed);
        if (shown === current || seen.has(shown)) return; // one row per distinct value
        seen.add(shown);
        out.push({
          altKey,
          index,
          ...(subKey ? { subKey } : {}),
          value,
          displayValue: subKey ? `${subKey}: ${displayValue(parsed)}` : displayValue(parsed),
          source: sourceInfo(src as FieldSource),
        });
      });
    };
    push(key);
    for (const altKey of Object.keys(alternates)) {
      if (altKey.startsWith(`${key}.`)) push(altKey, altKey.slice(key.length + 1));
    }
    return out;
  };

  // Sources that state exactly the value on file (whole facts only).
  const corroborations = getFieldCorroborations(info);
  const corroboratedBy = (key: string, value: unknown): FactSourceInfo[] => {
    const now = serializeFactValue(value);
    return (corroborations[key] ?? [])
      .filter((c) => c && c.value === now)
      .map(({ value: _v, ...src }) => sourceInfo(src as FieldSource));
  };

  const makeFact = (key: string, extra: { industrySpecific?: boolean; critical?: boolean } = {}): InformationFact => {
    const value = repairCharIndexedValue(info[key]);
    const src = traced[key];
    const agree = corroboratedBy(key, value);
    return {
      key,
      label: labelOf(key),
      value,
      displayValue: displayValue(value),
      isMap: !!value && typeof value === "object" && !Array.isArray(value),
      source: sourceInfo(src),
      confidence: confidenceOf(key, src),
      alternates: alternatesFor(key),
      ...(agree.length > 0 ? { corroboratedBy: agree } : {}),
      brokerEdited: src?.source === "broker",
      ...extra,
    };
  };

  // Every visible fact key on the deal
  const factKeys = Object.keys(info).filter(
    (k) => !k.startsWith("_") && !SOURCE_META_KEYS.has(k) && hasValue(info[k]),
  );
  const assigned = new Set<string>();

  // Recorded sources, completed (a session for pre-session interview facts)
  // and, for facts collected before provenance existed, traced back to the
  // interview / questionnaire / document / website they match (marked inferred).
  const traced: Record<string, InferredFieldSource> = inferFieldSources({
    info,
    sources,
    factKeys,
    documents,
    sessions,
    sessionKind: (s) => sessionKinds.get(s.id) ?? "interview",
    questionnaire: deal,
    scraped: (deal.scrapedData as Info | null) || null,
  });

  // Coverage — status per section (all sections, so excluded ones still
  // show their facts) and the readiness score (respecting exclusions).
  const importance = getSectionImportance(deal);
  const adjustments = coverageAdjustmentsForDeal(deal);
  const allCoverage = buildSectionCoverage(info as any, confidenceLevels, importance, [], adjustments);
  const readiness = computeCimReadiness(
    buildSectionCoverage(info as any, confidenceLevels, importance, outline.excludedSections, adjustments),
  );
  const coverageByKey = new Map(allCoverage.map((c) => [c.key, c]));
  const brokerSectionOf = (info[BROKER_SECTION_OF_KEY] as Record<string, string> | undefined) || {};
  const validSections = new Set<string>(CIM_SECTIONS.map((s) => s.key));

  const sectionFor = (key: string): string | null => {
    if (brokerSectionOf[key] && validSections.has(brokerSectionOf[key])) return brokerSectionOf[key];
    if (PRIMARY_SECTION[key]) return PRIMARY_SECTION[key];
    for (const s of CIM_SECTIONS) {
      if ((SECTION_FIELD_MAP[s.key] ?? []).includes(key)) return s.key;
      if ((adjustments.add?.[s.key] ?? []).some((x) => x.key === key)) return s.key;
    }
    if (DISPLAY_SECTION_HINTS[key]) return DISPLAY_SECTION_HINTS[key];
    return KEY_SECTION_PATTERNS.find(([re]) => re.test(key))?.[1] ?? null;
  };

  const bySection = new Map<string, string[]>();
  for (const key of factKeys) {
    const sec = sectionFor(key);
    if (!sec) continue;
    (bySection.get(sec) ?? bySection.set(sec, []).get(sec)!).push(key);
    assigned.add(key);
  }

  const sectionsOut: InformationSection[] = CIM_SECTIONS.map((s) => {
    const cov = coverageByKey.get(s.key);
    const covFields = cov?.fields ?? [];
    // Checklist order first (generic → industry → broker), then anything else grouped here.
    const ordered: string[] = [];
    for (const f of covFields) if ((bySection.get(s.key) ?? []).includes(f.fieldName)) ordered.push(f.fieldName);
    for (const k of bySection.get(s.key) ?? []) if (!ordered.includes(k)) ordered.push(k);
    const facts = ordered.map((k) => {
      const f = covFields.find((x) => x.fieldName === k);
      return makeFact(k, f?.industrySpecific ? { industrySpecific: true, critical: !!f.critical } : {});
    });
    // Missing = checklist items with nothing on file (own value or the alias
    // that answers it), each listed once across the whole view.
    const missing = covFields
      .filter((f) => f.value === null && !hasValue(info[f.fieldName]) && (PRIMARY_SECTION[f.fieldName] ?? s.key) === s.key)
      .map((f) => ({ key: f.fieldName, label: f.label ?? labelOf(f.fieldName), critical: !!f.critical || (s.key === "financials" && f.fieldName === "annualRevenue") || (s.key === "asking_price" && f.fieldName === "askingPrice") }));
    return {
      key: s.key,
      title: s.title,
      importance: cov?.importance ?? "important",
      importanceReason: cov?.importanceReason ?? "",
      status: cov?.status ?? "missing",
      excluded: outline.excludedSections.includes(s.key),
      facts,
      missing,
    };
  });

  const other = factKeys.filter((k) => !assigned.has(k)).map((k) => makeFact(k));

  // Counts per source kind (visible facts only)
  const counts: Partial<Record<FactSourceKind, number>> = {};
  let inferredFacts = 0;
  for (const key of factKeys) {
    const t = traced[key];
    const kind: FactSourceKind = t && !isUntrackedSource(t) ? t.source : "unknown";
    counts[kind] = (counts[kind] ?? 0) + 1;
    if (t?.inferred) inferredFacts++;
  }

  // Sources. Counts include traced (inferred) facts; `inferredFactCount`
  // says how many of them were matched rather than recorded.
  const tracedWhere = (pred: (s: InferredFieldSource) => boolean) =>
    factKeys.filter((k) => traced[k] && !isUntrackedSource(traced[k]) && pred(traced[k]));
  const factCountWhere = (pred: (s: InferredFieldSource) => boolean) => tracedWhere(pred).length;
  const inferredCountWhere = (pred: (s: InferredFieldSource) => boolean) => tracedWhere((s) => !!s.inferred && pred(s)).length;
  const sourcesOut: InformationSource[] = [];
  for (const d of documents) {
    const data = (d.extractedData as Record<string, unknown> | null) || {};
    const pick = (k: string) => (typeof data[k] === "string" && (data[k] as string).trim() ? (data[k] as string) : undefined);
    const meta = (d.sourceMeta as DocumentSourceMeta | null) ?? null;
    const highlights = {
      summary: pick("summary") === "Extraction failed" ? undefined : pick("summary"),
      keyFacts: pick("keyFacts"),
      redFlags: pick("redFlags"),
      actionItems: pick("actionItems"),
      sellerConcerns: pick("sellerConcerns"),
      followUpNeeded: pick("followUpNeeded"),
    };
    const hasHighlights = Object.values(highlights).some(Boolean);
    sourcesOut.push({
      id: d.id,
      documentId: d.id,
      kind: isSourceKind(d.sourceKind) ? d.sourceKind : "document",
      title: d.name,
      date: meta?.date ?? new Date(d.createdAt).toISOString(),
      meta,
      visibility: d.visibility === "broker_only" ? "broker_only" : "shared",
      factCount: factCountWhere((s) => s.documentId === d.id || Object.values(s.years ?? {}).includes(d.id)),
      inferredFactCount: inferredCountWhere((s) => s.documentId === d.id || Object.values(s.years ?? {}).includes(d.id)),
      status: d.status,
      uploadedBy: d.uploadedBy,
      fileUrl: d.fileUrl,
      category: d.category,
      hasText: !!d.extractedText,
      ...(hasHighlights ? { highlights } : {}),
    });
  }
  const orderedSessions = [...sessions].sort((a, b) => +new Date(a.startedAt) - +new Date(b.startedAt));
  orderedSessions.forEach((s, i) => {
    const kind = sessionKinds.get(s.id) ?? "interview";
    const msgs = Array.isArray(s.messages) ? (s.messages as Array<{ role: string }>) : [];
    const turns = msgs.filter((m) => m.role === "user").length;
    const meta = (s.extractedInfo as Info | null) || {};
    const via = typeof meta._conductedVia === "string" ? meta._conductedVia : null;
    const VIA_TITLE: Record<string, string> = { person: "in person", cimple: "Cimple call", zoom: "Zoom", meet: "Google Meet", teams: "Teams" };
    const title =
      kind === "interview"
        ? `AI interview · session ${i + 1}`
        : `Interview together${via ? ` · ${VIA_TITLE[via] ?? via}` : ""} · session ${i + 1}`;
    sourcesOut.push({
      id: `session:${s.id}`,
      sessionId: s.id,
      kind,
      title,
      date: new Date(s.startedAt).toISOString(),
      meta: via ? { platform: via } : null,
      visibility: "shared",
      factCount: factCountWhere((src) => src.sessionId === s.id),
      inferredFactCount: inferredCountWhere((src) => src.sessionId === s.id),
      status: s.status,
      turns,
    });
  });
  // Facts recorded by a live session before per-session provenance existed
  // (linked to a session of the same kind by inferFieldSources whenever one
  // exists) — one row per kind, so a fact is always counted under a row of
  // the kind its chip shows.
  const LEGACY_ROWS: Array<{ id: string; kind: SourceKind; title: string }> = [
    { id: "interview", kind: "interview", title: "AI interview" },
    { id: "legacy:call", kind: "call", title: "Interview together (call)" },
    { id: "legacy:video_call", kind: "video_call", title: "Interview together (video call)" },
  ];
  for (const row of LEGACY_ROWS) {
    const n = factCountWhere((src) => src.source === row.kind && !src.sessionId && !src.documentId);
    if (n > 0) sourcesOut.push({ id: row.id, kind: row.kind, title: row.title, date: null, meta: null, visibility: "shared", factCount: n });
  }
  if (deal.questionnaireData || (counts.questionnaire ?? 0) > 0) {
    sourcesOut.push({
      id: "questionnaire",
      kind: "questionnaire",
      title: "Seller intake questionnaire",
      date: null,
      meta: null,
      visibility: "shared",
      factCount: factCountWhere((src) => src.source === "questionnaire"),
      inferredFactCount: inferredCountWhere((src) => src.source === "questionnaire"),
    });
  }
  const scraped = (deal.scrapedData as Record<string, unknown> | null) || null;
  if (scraped && Object.keys(scraped).length > 0) {
    sourcesOut.push({
      id: "website",
      kind: "website",
      title: deal.websiteUrl || "Public web search",
      date: deal.scrapedAt ? new Date(deal.scrapedAt).toISOString() : null,
      meta: deal.websiteUrl ? { url: deal.websiteUrl } : null,
      visibility: "shared",
      factCount: factCountWhere((src) => src.source === "website" && !src.documentId),
      inferredFactCount: inferredCountWhere((src) => src.source === "website" && !src.documentId),
    });
  }
  if ((counts.broker ?? 0) > 0) {
    sourcesOut.push({
      id: "broker",
      kind: "broker",
      title: "Your edits",
      date: null,
      meta: null,
      visibility: "shared",
      factCount: counts.broker ?? 0,
    });
  }

  // Deleted facts (restorable)
  const deletedRaw = (info[BROKER_DELETED_KEY] as Record<string, { value: unknown; source: FieldSource | null; at: string; note?: string }> | undefined) || {};
  const deleted: DeletedFact[] = Object.entries(deletedRaw).map(([key, d]) => ({
    key,
    label: labelOf(key),
    displayValue: displayValue(d?.value),
    source: sourceInfo(d?.source ?? null),
    deletedAt: d?.at ?? "",
    ...(typeof d?.note === "string" && d.note ? { note: d.note } : {}),
  }));

  // Website (scraped, unverified) with accept status
  let website: InformationView["website"] = null;
  if (scraped && Object.keys(scraped).length > 0) {
    const items: WebsiteItem[] = [];
    for (const [field, raw] of Object.entries(scraped)) {
      if (!isSubstantiveValue(raw) || typeof raw !== "string") continue;
      const factKey = websiteFactKey(field);
      const src = sources[factKey];
      const status: WebsiteItem["status"] =
        src?.source === "website" || (src?.acceptedByBroker && String(info[factKey]) === raw.trim())
          ? "accepted"
          : hasValue(info[factKey]) ? "on_file" : "new";
      items.push({ field, label: EXTRA_LABELS[factKey] ?? labelOf(factKey), value: raw, factKey, status });
    }
    website = {
      url: deal.websiteUrl ?? null,
      scrapedAt: deal.scrapedAt ? new Date(deal.scrapedAt).toISOString() : null,
      scrapeSource: deal.scrapeSource ?? null,
      items,
    };
  }

  return {
    sections: sectionsOut,
    other,
    sources: sourcesOut,
    counts,
    totalFacts: factKeys.length,
    inferredFacts,
    readiness,
    deleted,
    website,
  };
}
