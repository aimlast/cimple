/**
 * Resolving a discrepancy writes the real fact (factKey first), asks which
 * fact when none maps, and finds other facts that still repeat the ruled-out
 * value.
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/discrepancy-resolution.test.ts
 */
import assert from "node:assert/strict";
import { applyResolutionToInfo, suggestFactTargets, NEEDS_MAPPING, NO_FACT_KEY, NARRATIVE_FACT } from "../../server/information/facts";
import { getFieldSources, getFieldAlternates } from "../../server/interview/info-merger";
import { findStaleFacts, swapOutdatedFigures, proposeRewrites, _setRewriteModelForTests } from "../../server/information/resolution-propagation";
import { resolutionSubject } from "../../server/routes/discrepancies";
import { storage } from "../../server/storage";
import { buildLayoutParams } from "../../server/cim/generation-jobs";

type Info = Record<string, unknown>;
const row = (o: Record<string, unknown>) =>
  ({ id: "d1", dealId: "deal1", severity: "minor", category: "operational", source: "financial_analysis", status: "resolved", createdAt: new Date(), interviewValue: null, documentValue: null, documentId: null, ...o }) as any;

// ── Lakeshore: a descriptive label + factKey writes the real fact ──
{
  const info: Info = {
    comfortClubMembers: "3,100 members",
    _fieldSources: { comfortClubMembers: { source: "call", documentId: "c1" } },
  };
  const k = applyResolutionToInfo(info, row({
    field: "Comfort Club active member count",
    factKey: "comfortClubMembers",
    resolvedValue: "2,900 active members (Mar 31, 2025)",
    interviewValue: "3,100 members — Discovery call",
    documentValue: "2,900 active members — Comfort Club report",
  }));
  assert.equal(k, "comfortClubMembers");
  assert.equal(info.comfortClubMembers, "2,900 active members (Mar 31, 2025)");
  assert.equal(getFieldSources(info).comfortClubMembers.source, "broker", "written as the broker's fact");
  assert.ok(getFieldAlternates(info).comfortClubMembers.some((a) => a.value === "3,100 members"), "the old value is kept");
  assert.ok(!Object.keys(info).some((key) => /\s/.test(key)), "no label-named key");
}

// ── A label with no fact key and no match: "needs mapping", nothing written ──
{
  const info: Info = { sde: "~$1.5M" };
  const before = JSON.stringify(info);
  const k = applyResolutionToInfo(info, row({ field: "Owner's claimed SDE vs calculated SDE", resolvedValue: "$1,312,000" }));
  assert.equal(k, NEEDS_MAPPING);
  assert.equal(JSON.stringify(info), before);
  // The broker chose "keep as a note only" → nothing to write, no longer asks.
  assert.equal(applyResolutionToInfo(info, row({ field: "Owner's claimed SDE vs calculated SDE", factKey: NO_FACT_KEY, resolvedValue: "$1,312,000" })), null);
  // The picker's best match is the sde fact.
  const { suggestions, all } = suggestFactTargets({ sde: "~$1.5M", annualRevenue: "$9M", employees: "36" }, row({ field: "Owner's claimed SDE vs calculated SDE" }));
  assert.equal(suggestions[0]?.key, "sde");
  assert.equal(all.length, 3);
}

// ── A model-chosen key that plainly isn't this figure asks the broker ──
{
  const info: Info = { employees: "36 employees plus owner (37 total)" };
  const d = row({ source: "interview", field: "Licensed field technicians", factKey: "employees", resolvedValue: "22 licensed technicians", interviewValue: "24 licensed field technicians", documentValue: "22 licensed field technicians" });
  assert.equal(applyResolutionToInfo(info, d), NEEDS_MAPPING, "the headcount is not overwritten");
  assert.equal(info.employees, "36 employees plus owner (37 total)");
  // The broker's pick is trusted as the fact — but "36 employees plus owner"
  // says more than the figure, so it is offered for a rewrite, never
  // replaced with the bare "22 licensed technicians" (round V).
  assert.equal(applyResolutionToInfo({ ...info }, d, { brokerChoseFact: true }), NARRATIVE_FACT);
  // A fact the broker picked that is just a figure is written.
  const picked: Info = { fieldStaff: "two dozen" };
  assert.equal(applyResolutionToInfo(picked, { ...d, factKey: "fieldStaff" }, { brokerChoseFact: true }), "fieldStaff");
  assert.equal(picked.fieldStaff, "22 licensed technicians");
}

// ── A description the figure is only part of is not overwritten ──
{
  const long = "Staff: 24 licensed field technicians (17-18 HVAC, 5 plumbers) plus apprentices; office team of 6 led by Denise Tran; two service managers; seasonal installers hired each spring; no union; average tenure 9 years.";
  const info: Info = { employeeStructure: long };
  const k = applyResolutionToInfo(info, row({ source: "interview", field: "Licensed technicians", factKey: "employeeStructure", resolvedValue: "22 licensed technicians", interviewValue: "24 licensed field technicians", documentValue: "22 licensed field technicians" }));
  assert.equal(k, NARRATIVE_FACT);
  assert.equal(info.employeeStructure, long);
  const stale = findStaleFacts(info, { field: "Licensed technicians", factKey: "employeeStructure", resolvedValue: "22 licensed technicians", supersededValues: ["24 licensed field technicians"] });
  assert.deepEqual(stale.map((s) => s.key), ["employeeStructure"], "offered as a rewrite instead");
}

// ── Per-year fact via factKey + factYear ──
{
  const info: Info = { revenueByYear: { "2023": "$1.7M", "2024": "$1.95M" } };
  const k = applyResolutionToInfo(info, row({ field: "Revenue FY2024", factKey: "revenueByYear", factYear: "2024", resolvedValue: "$1,894,000" }));
  assert.equal(k, "revenueByYear.2024");
  assert.deepEqual(info.revenueByYear, { "2023": "$1.7M", "2024": "$1,894,000" });
}

// ── Pacific: every fact still saying ~18% / under 20% is found ──
{
  const info: Info = {
    customerConcentration: "Largest customer Alderbrook about 18%",
    strengths: "Diversified customer base, no customer over 18%, long-tenured staff",
    keyCustomerDetails: "Alderbrook (grocery distributor), roughly 18% of revenue, customer since 2009",
    revenueStreams: "Trucking approximately 80% of revenue, warehousing approximately 20%",
    employees: "148 (96 drivers + 52 staff)",
    revenueByYear: { "2024": "$31,020,000" },
  };
  const subject = { field: "Alderbrook revenue percentage", factKey: "customerConcentration", resolvedValue: "22.0%", supersededValues: ["~18% (approximately, under 20%)"] };
  const stale = findStaleFacts(info, subject);
  const keys = stale.map((s) => s.key).sort();
  assert.deepEqual(keys, ["customerConcentration", "keyCustomerDetails", "strengths"], "the Alderbrook facts, not the unrelated 20%");
  const cc = stale.find((s) => s.key === "customerConcentration")!;
  assert.equal(swapOutdatedFigures(cc, "22.0%"), "Largest customer Alderbrook 22.0%");
  // After the facts are rewritten, nothing is stale.
  const fixed: Info = { ...info, customerConcentration: "Largest customer Alderbrook 22.0% of FY2024 revenue", strengths: "Diversified customer base, largest customer 22.0%, long-tenured staff", keyCustomerDetails: "Alderbrook (grocery distributor), 22.0% of FY2024 revenue, customer since 2009" };
  assert.deepEqual(findStaleFacts(fixed, subject), []);
}

// ── Harborview: context beside the ruled-out figure is not outdated ──
{
  const info: Info = {
    keyClients: "Maritime Smiles Dental Group (14 clinics, $30,600 MRR), Harbour & Keel LLP ($14,200 MRR)",
    customerConcentration: "Very low - largest client is approximately 4% of revenue (dental group with 14 clinics)",
  };
  const stale = findStaleFacts(info, { field: "Largest client concentration", factKey: "customerConcentration", resolvedValue: "Maritime Smiles Dental Group at 7.8% of MRR ($30,600 MRR)", supersededValues: ["approximately 4% of revenue (dental group with 14 clinics)"] });
  assert.deepEqual(stale.map((s) => s.key), ["customerConcentration"], "only the 4%, never '14 clinics'");
  assert.deepEqual(stale[0].outdated, ["4%"]);
}

// ── Beacon: tenure in narrative facts ──
{
  const info: Info = {
    keyEmployees: "Daniel Okafor, pharmacy manager (15 years with the business)",
    companyHistory: "Opened in 2009; Daniel joined 15 years ago",
    customerBase: "14 homes, 15 homes under review",
  };
  const stale = findStaleFacts(info, { field: "Daniel's tenure", factKey: null, resolvedValue: "11 years (since 2014)", supersededValues: ["15 years"] });
  assert.deepEqual(stale.map((s) => s.key).sort(), ["companyHistory", "keyEmployees"], "'15 homes' is not a tenure");
}

// ── The resolution subject strips financial-analysis source labels ──
{
  const s = resolutionSubject(row({ field: "Alderbrook revenue percentage", resolvedValue: "22.0%", interviewValue: "~18% (approximately, under 20%) — Intro call", documentValue: "22.0% in FY2024 — Customer revenue schedule" }))!;
  assert.deepEqual(s.supersededValues, ["~18% (approximately, under 20%)"], "the accepted side isn't outdated");
  // Lakeshore: the private SDE figure is superseded; the accepted working isn't.
  const sde = resolutionSubject(row({
    field: "FY2024 Seller's Discretionary Earnings (SDE)", factKey: "sde", resolvedValue: "$1,202,000 FY2024 SDE",
    interviewValue: "$1,312,000 SDE with $395K total add-backs",
    documentValue: "$1,202,000 SDE (Net income $563,190 + owner salary add-back $130K) — Compiled financial statements FY2024",
  }))!;
  assert.deepEqual(sde.supersededValues, ["$1,312,000 SDE with $395K total add-backs"]);
  const stale = findStaleFacts({
    keyFinancialNotes: "FY2024 SDE $1,312,000 per the recast; Comfort Club generates $801,000",
    ownerComp: "Owner salary $240K; add-back $130K",
  }, sde);
  assert.deepEqual(stale.map((x) => x.key), ["keyFinancialNotes"], "a 3-letter subject (SDE) still counts");
}

// ── proposeRewrites falls back to a number swap without the model ──
(async () => {
  _setRewriteModelForTests(async () => { throw new Error("model unavailable"); });
  const stale = [{ key: "customerConcentration", label: "Customer concentration", value: "Largest customer about 18%", outdated: ["18%"] }];
  const proposals = await proposeRewrites(stale, { field: "Largest customer share", resolvedValue: "22.0%", supersededValues: ["about 18%"] });
  assert.equal(proposals[0].proposed, "Largest customer 22.0%");
  assert.equal(proposals[0].method, "swap");
  // A model suggestion that still states the old figure is not used.
  _setRewriteModelForTests(async () => [{ key: "customerConcentration", text: "Largest customer about 18%, stable" }]);
  const again = await proposeRewrites(stale, { field: "Largest customer share", resolvedValue: "22.0%", supersededValues: ["about 18%"] });
  assert.equal(again[0].method, "swap");
  _setRewriteModelForTests(async () => [{ key: "customerConcentration", text: "Largest customer 22.0% of FY2024 revenue" }]);
  const ai = await proposeRewrites(stale, { field: "Largest customer share", resolvedValue: "22.0%", supersededValues: ["about 18%"] });
  assert.equal(ai[0].method, "ai");
  _setRewriteModelForTests(null);

  // ── buildLayoutParams: resolved rows overlay only real keys ──
  const s = storage as any;
  s.getResolvedDiscrepancies = async () => [
    row({ field: "Alderbrook revenue percentage", factKey: "customerConcentration", resolvedValue: "22.0%", interviewValue: "about 18%", documentValue: "22.0%" }),
    row({ field: "Owner's claimed SDE vs calculated SDE", resolvedValue: "$1,312,000" }),
  ];
  s.getBrandingByBroker = async () => undefined;
  s.getEngagementInsightsByIndustry = async () => [];
  s.getCimTemplate = async () => undefined;
  // facts1: buildLayoutParams stamps sources from the deal's documents rows.
  s.getDocumentsByDeal = async () => [];
  const params = await buildLayoutParams({ id: "deal1", brokerId: "b", businessName: "X", industry: null, extractedInfo: { customerConcentration: "about 18%" } } as any, "content");
  assert.ok(!Object.keys(params.extractedInfo).some((key) => /\s/.test(key)), "no keys containing spaces");
  assert.equal((params.extractedInfo as any).customerConcentration, "22.0%");
  console.log("discrepancy-resolution: ok");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
