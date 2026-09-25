// Provenance v2 + Information tab logic — offline checks (no database, no AI).
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/information/provenance.test.ts
// (the imports need both variables set; nothing connects to either)
import assert from "node:assert/strict";
import { mergeExtractedData } from "../../server/documents/extractor";
import {
  removeDocumentFields, sourceRank, describeSource, sourceAllowsOverwrite, getFieldSources, getFieldAlternates,
} from "../../server/interview/info-merger";
import { editFact, addFact, deleteFact, restoreFact, useAlternate, acceptWebsiteFact, applyResolutionToInfo, coerceBrokerValue } from "../../server/information/facts";
import { buildFactSourceLabels } from "../../server/interview/knowledge-base";
import { buildInformationView } from "../../server/information/view";
import { seedExtractedInfoFromQuestionnaire } from "../../server/interview/session-manager";

let n = 0;
const ok = (name: string) => { n++; console.log("✓", name); };

// ranks
assert.equal(sourceRank("broker"), 7); assert.equal(sourceRank("nope"), 0); assert.equal(sourceRank(undefined), 0);
assert.equal(sourceRank("video_call"), 5);
ok("ranks, unknown → 0");

// describeSource
assert.equal(describeSource({ source: "interview", turn: 12 }), "Seller interview · turn 12");
assert.equal(describeSource({ source: "document", documentId: "d1" }, () => "2024 Compilation.pdf"), "Document · 2024 Compilation.pdf");
assert.equal(describeSource({ source: "crm" }), "CRM note");
assert.equal(describeSource(undefined), "Source not recorded");
ok("describeSource");

// merge: document fills empty, email outranks doc, crm doesn't, legacy protected, suppression
let info: Record<string, unknown> = { reasonForSale: "Retiring" /* untracked legacy */ };
info = mergeExtractedData(info, { annualRevenue: "$1.8M", reasonForSale: "Health" } as any, "doc1");
assert.equal(info.annualRevenue, "$1.8M");
assert.equal(getFieldSources(info).annualRevenue.source, "document");
assert.equal(getFieldSources(info).annualRevenue.documentId, "doc1");
assert.ok(getFieldSources(info).annualRevenue.at);
assert.equal(info.reasonForSale, "Retiring");
assert.equal(getFieldAlternates(info).reasonForSale[0].value, "Health");
info = mergeExtractedData(info, { annualRevenue: "$2.0M" } as any, { documentId: "email1", source: "email" });
assert.equal(info.annualRevenue, "$2.0M", "email outranks document");
assert.ok(getFieldAlternates(info).annualRevenue.some((a) => a.value === "$1.8M" && a.documentId === "doc1"));
info = mergeExtractedData(info, { annualRevenue: "$5M", employees: "12" } as any, { documentId: "crm1", source: "crm" });
assert.equal(info.annualRevenue, "$2.0M", "crm never displaces email");
assert.equal(info.employees, "12");
info._brokerSuppressed = ["seasonality"];
info = mergeExtractedData(info, { seasonality: "Summer peak" } as any, { documentId: "doc2", source: "document" });
assert.equal(info.seasonality, undefined, "suppressed key stays deleted");
ok("mergeExtractedData provenance + ranks + suppression");

// revenueByYear per-year
info = mergeExtractedData(info, { revenueByYear: { "2023": "$1.7M", "2024": "$1.8M" } } as any, "doc1");
info = mergeExtractedData(info, { revenueByYear: { "2024": "$1.9M", "2022": "$1.5M" } } as any, "doc3");
assert.deepEqual(info.revenueByYear, { "2023": "$1.7M", "2024": "$1.8M", "2022": "$1.5M" });
assert.equal(getFieldAlternates(info)["revenueByYear.2024"][0].value, "$1.9M");
ok("revenueByYear per-year merge");

// removeDocumentFields for an email source promotes the doc alternate back
let r = removeDocumentFields(info, "email1");
assert.equal(r.info.annualRevenue, "$1.8M");
assert.equal(getFieldSources(r.info).annualRevenue.documentId, "doc1");
r = removeDocumentFields(r.info, "crm1");
assert.equal(r.info.employees, undefined);
r = removeDocumentFields(r.info, "doc3");
assert.deepEqual(r.info.revenueByYear, { "2023": "$1.7M", "2024": "$1.8M" });
assert.equal(getFieldAlternates(r.info)["revenueByYear.2024"], undefined);
ok("removeDocumentFields for any kind + promotion");

// facts ops
const f: Record<string, unknown> = { ...r.info };
editFact(f, "annualRevenue", "$1.85M");
assert.equal(f.annualRevenue, "$1.85M");
assert.equal(getFieldSources(f).annualRevenue.source, "broker");
assert.ok(getFieldAlternates(f).annualRevenue.some((a) => a.value === "$1.8M"));
// a document can't override a broker edit
const f2 = mergeExtractedData(f, { annualRevenue: "$9M" } as any, "doc9");
assert.equal(f2.annualRevenue, "$1.85M");
assert.equal(sourceAllowsOverwrite(f, "annualRevenue", "interview"), false);
// map edit
editFact(f, "revenueByYear", "2024: $1.8M\n2023: $1.75M");
assert.deepEqual(f.revenueByYear, { "2024": "$1.8M", "2023": "$1.75M" });
assert.equal(coerceBrokerValue("text", "a: b"), "a: b");
// add
const key = addFact(f, "Number of dental chairs", "9", "operations");
assert.equal(key, "numberOfDentalChairs");
assert.equal((f._brokerSectionOf as any)[key], "operations");
const key2 = addFact(f, "Number of dental chairs", "10", null);
assert.equal(key2, "numberOfDentalChairs2");
// delete + restore
deleteFact(f, "employees" in f ? "employees" : "annualRevenue");
assert.equal(f.annualRevenue, undefined);
assert.ok((f._brokerSuppressed as string[]).includes("annualRevenue"));
const f3 = mergeExtractedData(f, { annualRevenue: "$3M" } as any, "doc10");
assert.equal(f3.annualRevenue, undefined, "deleted fact not brought back by a document");
restoreFact(f, "annualRevenue");
assert.equal(f.annualRevenue, "$1.85M");
assert.equal(getFieldSources(f).annualRevenue.source, "broker");
assert.ok(!(f._brokerSuppressed as string[] | undefined)?.includes("annualRevenue"));
// use alternate
const idx = getFieldAlternates(f).annualRevenue.findIndex((a) => a.value === "$1.8M");
useAlternate(f, "annualRevenue", idx);
assert.equal(f.annualRevenue, "$1.8M");
assert.ok(getFieldAlternates(f).annualRevenue.some((a) => a.value === "$1.85M"));
assert.match(getFieldSources(f).annualRevenue.note ?? "", /Chose/);
ok("broker edit / add / delete / restore / use-alternate");

// website accept
const w: Record<string, unknown> = { yearsOperating: "20 years" };
w._fieldSources = { yearsOperating: { source: "interview" } };
assert.equal(acceptWebsiteFact(w, "yearsOperating", "Since 2004").addedAs, "alternate");
assert.equal(acceptWebsiteFact(w, "awards", "Best clinic 2023").key, "accolades");
assert.equal(getFieldSources(w).accolades.source, "website");
ok("website accept");

// discrepancy resolution
const dz: Record<string, unknown> = { annualRevenue: "$2.3M", _fieldSources: { annualRevenue: { source: "interview" } } };
const k = applyResolutionToInfo(dz, { field: "Annual Revenue", resolvedValue: "$1.82M", interviewValue: "$2.3M", documentValue: "$1.82M", documentId: "p1", source: "interview" } as any);
assert.equal(k, "annualRevenue");
assert.equal(dz.annualRevenue, "$1.82M");
assert.equal(getFieldSources(dz).annualRevenue.note, "Resolved discrepancy");
assert.ok(getFieldAlternates(dz).annualRevenue.some((a) => a.value === "$2.3M"));
ok("discrepancy resolution → broker fact");

// questionnaire seeding with systems + staff
const seeded = seedExtractedInfoFromQuestionnaire({
  questionnaireData: { reasonForSelling: "Retiring", yearsInBusiness: "22", location: "Halifax, NS" },
  operationalSystems: { accounting: "QuickBooks", crm: "", pos: "Dentrix", erp: "", other: ["Slack"] },
  employeeChart: [{ name: "Ana", role: "Office manager", yearsWithCompany: "8", keyPerson: true }, { name: "Bo", role: "Hygienist", yearsWithCompany: "", keyPerson: false }],
  extractedInfo: { reasonForSale: "Moving", _fieldSources: { reasonForSale: { source: "document", documentId: "x" } } },
})!;
assert.equal(seeded.reasonForSale, "Retiring");
assert.equal(seeded.yearsOperating, "22");
assert.equal(seeded.operationalSystems, "Accounting: QuickBooks; POS: Dentrix; Other: Slack");
assert.match(String(seeded.employeeStructure), /Ana — Office manager \(8 yrs\); Bo — Hygienist/);
assert.equal(seeded.keyEmployees, "Ana — Office manager (8 yrs)");
assert.equal(getFieldSources(seeded).operationalSystems.source, "questionnaire");
assert.equal(getFieldAlternates(seeded).reasonForSale[0].value, "Moving");
// equal-rank email is not overwritten
const s2 = seedExtractedInfoFromQuestionnaire({ questionnaireData: { reasonForSelling: "Retiring" }, extractedInfo: { reasonForSale: "Burnout", _fieldSources: { reasonForSale: { source: "email", documentId: "e" } } } });
assert.equal(s2!.reasonForSale, "Burnout", "equal-rank email kept");
assert.equal((s2 as any)._fieldAlternates.reasonForSale[0].source, "questionnaire", "intake answer kept as alternate");
assert.equal(seedExtractedInfoFromQuestionnaire({ questionnaireData: { reasonForSelling: "Retiring" }, extractedInfo: s2 }), null, "idempotent");
ok("questionnaire seeding");

// KB labels
const labels = buildFactSourceLabels(
  { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, _fieldSources: {
    a: { source: "interview" }, b: { source: "document", documentId: "d1" }, c: { source: "email", documentId: "e1" },
    d: { source: "crm", documentId: "c1" }, e: { source: "website" }, f: { source: "call", sessionId: "s" },
  } },
  [
    { id: "d1", name: "2024 P&L.pdf", createdAt: new Date("2026-01-02"), sourceKind: "document", sourceMeta: null, visibility: "shared" },
    { id: "e1", name: "Re: numbers", createdAt: new Date("2026-03-03"), sourceKind: "email", sourceMeta: { date: "2026-03-03" }, visibility: "shared" },
    { id: "c1", name: "CRM", createdAt: new Date(), sourceKind: "crm", sourceMeta: null, visibility: "broker_only" },
  ] as any,
  { a: "confirmed" },
);
assert.equal(labels.a, "from the seller in the interview — confirmed");
assert.equal(labels.b, "from document: 2024 P&L.pdf");
assert.equal(labels.c, "from an email, Mar 3, 2026");
assert.match(labels.d, /CRM notes — confirm with the seller; never mention the CRM/);
assert.equal(labels.e, "from the website — unverified");
assert.equal(labels.f, "from a call with the broker");
assert.equal(labels.g, "on file before this interview");
ok("KB source labels");

// view builder
const view = buildInformationView({
  deal: {
    id: "deal1", industry: "Dental", extractedInfo: { ...f, summary: "doc summary", sde: "$600K", oddKey: "x yz" },
    questionnaireData: { reasonForSelling: "Retiring" }, scrapedData: { yearFounded: "2004", awards: "Best" }, websiteUrl: "https://x.test", scrapedAt: new Date(),
    interviewPlan: null, interviewOutline: null, sectionImportance: null, scrapeSource: "website",
  } as any,
  documents: [{ id: "doc1", name: "2024 Compilation.pdf", createdAt: new Date(), sourceKind: "document", sourceMeta: null, visibility: "shared", extractedData: { summary: "A P&L" }, extractedText: "t", status: "extracted", uploadedBy: "broker", fileUrl: "/uploads/docs/a.pdf", category: "financials" }] as any,
  sessions: [],
});
const fin = view.sections.find((s) => s.key === "financials")!;
assert.ok(fin.facts.some((x) => x.key === "annualRevenue"));
assert.ok(fin.facts.some((x) => x.key === "sde"));
assert.ok(!view.sections.find((s) => s.key === "revenue_sources")!.facts.some((x) => x.key === "annualRevenue"), "shown once");
assert.ok(view.other.some((x) => x.key === "oddKey"));
assert.ok(!view.other.some((x) => x.key === "summary"));
assert.ok(view.sources.some((s) => s.id === "doc1" && s.highlights?.summary === "A P&L"));
assert.ok(view.website && view.website.items.length === 2);
assert.equal(view.sections.find((s) => s.key === "operations")!.facts.find((x) => x.key === "numberOfDentalChairs")!.label, "Number of dental chairs");
// legacy char-indexed soup is repaired for readers
const { repairCharIndexedValue } = await import("../../server/interview/info-merger");
const soup = Object.fromEntries([...JSON.stringify({ "2025": "$2.01M" })].map((ch, i) => [String(i), ch]));
assert.deepEqual(repairCharIndexedValue(soup), { "2025": "$2.01M" });
assert.deepEqual(repairCharIndexedValue({ ...soup, "2024": "$1.9M" }), { "2025": "$2.01M", "2024": "$1.9M" });
assert.deepEqual(repairCharIndexedValue({ "2024": "$1.9M" }), { "2024": "$1.9M" });
ok(`view builder (${view.totalFacts} facts, readiness ${view.readiness.score})`);

console.log(`\n${n} checks passed`);
