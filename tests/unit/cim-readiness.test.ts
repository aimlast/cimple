// CIM readiness (shared/cim-readiness.ts) and the coverage it reads
// (buildSectionCoverage) — offline, no database, no AI.
//  - unverified leads (CRM notes, website) don't make a deal look ready;
//  - missing critical checklist items can't read "Buyer-ready 100" or
//    "Every section is well covered";
//  - the financial keys the pipeline writes cover the Financial Summary;
//  - the interview outline finds the playbook through the sub-industry.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/unit/cim-readiness.test.ts
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { computeCimReadiness, readinessLabel } from "../../shared/cim-readiness";
import { buildSectionCoverage } from "../../server/interview/knowledge-base";
import { baseSectionImportance } from "../../server/interview/section-importance";
import { planSubIndustry, ensureInterviewPlan, getInterviewPlan } from "../../server/interview/interview-plan";
import { matchIndustrySection, buildIndustryKnowledge } from "../../server/interview/industry-loader";
import { storage } from "../../server/storage";

let n = 0;
const ok = (name: string) => { n++; console.log("✓", name); };
const importance = baseSectionImportance();
const src = (source: string, extra: Record<string, unknown> = {}) => ({ source, ...extra });
const withSources = (facts: Record<string, [unknown, string]>) => {
  const info: Record<string, unknown> = {};
  const sources: Record<string, unknown> = {};
  for (const [k, [v, s]] of Object.entries(facts)) { info[k] = v; sources[k] = src(s); }
  info._fieldSources = sources;
  return info;
};

(async () => {
  // Maple & Main-like: one call, two CRM notes, a web page.
  {
    const info = withSources({
      businessName: ["Maple & Main Café", "broker"],
      industry: ["Restaurant", "broker"],
      askingPrice: ["$185,000", "broker"],
      annualRevenue: ["~$620K", "crm"],
      sde: ["~$140K", "crm"],
      employees: ["about 9 staff", "crm"],
      companyHistory: ["Opened in 2014 by the owner", "call"],
      reasonForSale: ["Owner relocating", "call"],
      strengths: ["Loyal local following, great reviews", "website"],
      keyProducts: ["Breakfast, lunch, specialty coffee", "website"],
      targetMarket: ["Downtown office workers and families", "website"],
      leaseDetails: ["Lease runs to 2029", "call"],
    });
    const sections = buildSectionCoverage(info as any, undefined, importance);
    const r = computeCimReadiness(sections);
    assert.ok(r.score < 60, `Maple-like deal scores below Solid (got ${r.score})`);
    assert.notEqual(r.label, "Solid");
    const fin = sections.find((s) => s.key === "financials")!;
    assert.notEqual(fin.status, "well_covered", "CRM-only revenue/SDE doesn't cover financials");
    assert.ok(fin.fields.find((f) => f.fieldName === "annualRevenue")!.unverified);
    assert.ok(r.unverifiedItems >= 3);
    assert.match(r.summary, /unverified leads/);
  }
  ok("a deal known only from a call, CRM notes and its website scores below Solid; leads are flagged unverified");

  // Everything covered by the seller, but a critical industry item is open.
  {
    const allGeneric: Record<string, [unknown, string]> = {};
    for (const k of ["businessName", "industry", "companyHistory", "entityType", "brandIdentity", "customerPerception", "competitiveAdvantage", "growthOpportunities", "targetMarket", "permitsLicenses", "seasonality", "revenueStreams", "customerConcentration", "annualRevenue", "leaseDetails", "employees", "keyEmployees", "ownerInvolvement", "suppliers", "technologySystems", "idealBuyer", "transitionPlan", "reasonForSale", "revenueByYear", "ebitda", "addbacks", "workingCapital", "askingPrice", "saleType", "assetsIncluded"]) {
      allGeneric[k] = [`value for ${k} 123`, "interview"];
    }
    // The statements are on file (financial figures from documents).
    for (const k of ["annualRevenue", "revenueByYear", "ebitda"]) allGeneric[k] = [`value for ${k} 123`, "document"];
    const info = withSources(allGeneric);
    const full = computeCimReadiness(buildSectionCoverage(info as any, undefined, importance));
    assert.equal(full.label, "Buyer-ready");
    const adjustments = { add: { employees: [{ key: "licensedHygienists", label: "Licensed hygienists", critical: true }], operations: [{ key: "sterilizationAudits", label: "Sterilization audit history", critical: false }] } };
    const sections = buildSectionCoverage(info as any, undefined, importance, [], adjustments);
    const emp = sections.find((s) => s.key === "employees")!;
    assert.equal(emp.status, "partial", "a missing critical checklist item keeps the section partial");
    const r = computeCimReadiness(sections);
    assert.ok(r.score <= 84 && r.label !== "Buyer-ready", `not buyer-ready with a critical item open (got ${r.label} ${r.score})`);
    assert.doesNotMatch(r.summary, /Every section is well covered/);
    assert.equal(r.openCriticalItems, 1);
    // Critical item captured, a non-critical one open → no "Every section is well covered" either.
    const info2 = { ...info, licensedHygienists: "4 RDHs", _fieldSources: { ...(info._fieldSources as object), licensedHygienists: src("interview") } };
    const r2 = computeCimReadiness(buildSectionCoverage(info2 as any, undefined, importance, [], adjustments));
    assert.equal(r2.openCriticalItems, 0);
    assert.doesNotMatch(r2.summary, /Every section is well covered\.$/);
    assert.match(r2.summary, /data point/);
    assert.ok(r2.score < 100);
  }
  ok("missing critical checklist items can't read Buyer-ready 100 or 'Every section is well covered'");

  // Documents only → never Buyer-ready without the seller.
  {
    const facts: Record<string, [unknown, string]> = {};
    for (const k of ["businessName", "industry", "companyHistory", "entityType", "brandIdentity", "customerPerception", "competitiveAdvantage", "growthOpportunities", "targetMarket", "permitsLicenses", "seasonality", "revenueStreams", "customerConcentration", "annualRevenue", "leaseDetails", "employees", "keyEmployees", "ownerInvolvement", "suppliers", "technologySystems", "idealBuyer", "transitionPlan", "reasonForSale", "revenueByYear", "ebitda", "addbacks", "workingCapital", "askingPrice", "saleType", "assetsIncluded"]) facts[k] = [`doc value ${k} 1`, "document"];
    const r = computeCimReadiness(buildSectionCoverage(withSources(facts) as any, undefined, importance));
    assert.ok(r.score <= 84, `documents alone cap below Buyer-ready (got ${r.score})`);
    assert.match(r.summary, /Nothing is confirmed by the seller/);
  }
  ok("documents alone can't make a deal Buyer-ready");

  // Everything said, no statements: not Solid yet.
  {
    const facts: Record<string, [unknown, string]> = {};
    for (const k of ["businessName", "industry", "companyHistory", "competitiveAdvantage", "growthOpportunities", "targetMarket", "permitsLicenses", "seasonality", "revenueStreams", "customerConcentration", "annualRevenue", "leaseDetails", "employees", "keyEmployees", "ownerInvolvement", "suppliers", "technologySystems", "idealBuyer", "transitionPlan", "reasonForSale", "sde", "askingPrice", "saleType", "assetsIncluded"]) facts[k] = [`said ${k} 1`, "call"];
    const r = computeCimReadiness(buildSectionCoverage(withSources(facts) as any, undefined, importance));
    assert.ok(r.score < 60, `no statements → below Solid (got ${r.score})`);
    assert.match(r.summary, /^No financial statements on file yet/);
  }
  ok("a deal known only from what was said (no financial statements) stays below Solid");

  // Financials from the keys the pipeline writes.
  {
    const info = withSources({
      annualRevenue: ["$3,180,000 (FY2024)", "document"],
      revenueByYear: [{ "2022": "$2.9M", "2023": "$3.0M", "2024": "$3.18M" }, "document"],
      ebitda: ["$412,000", "document"],
      sde: ["$598,000", "document"],
      netIncome: ["$233,000", "document"],
      workingCapital: ["$310,000", "document"],
    });
    const fin = buildSectionCoverage(info as any, undefined, importance).find((s) => s.key === "financials")!;
    assert.equal(fin.status, "well_covered");
    assert.match(fin.fields.find((f) => f.fieldName === "revenueByYear")!.value!, /2024: \$3\.18M/);
  }
  ok("{annualRevenue, revenueByYear, ebitda, sde, netIncome, workingCapital} from documents covers the Financial Summary");

  // Alternatives, not a quota: one full seasonality answer covers the section.
  {
    const info = withSources({ seasonality: ["Busy May–September; slow in January and February, when the crew does maintenance", "interview"] });
    assert.equal(buildSectionCoverage(info as any, undefined, importance).find((s) => s.key === "seasonality")!.status, "well_covered");
    assert.equal(readinessLabel(84), "Solid");
  }
  ok("coverage counts groups of alternative fields, not keys");

  // Outline: "Home Services" + a landscaping sub-industry finds the playbook.
  {
    const deal: any = { id: "nb", industry: "Home Services", subIndustry: "Landscaping and snow & ice management", businessName: "Northbeam Landscaping", description: null, interviewPlan: null, extractedInfo: {} };
    assert.equal(matchIndustrySection("Home Services", null), null, "the industry alone matches nothing");
    const target = planSubIndustry(deal);
    assert.equal(target.matched, true);
    assert.equal(target.subIndustry, "Landscaping and snow & ice management");
    assert.match(buildIndustryKnowledge(deal.industry, target.subIndustry), /1D\. LANDSCAPING AND SNOW MANAGEMENT/);

    // ensureInterviewPlan with no context reaches the model (mocked) with the landscaping playbook.
    const prompts: string[] = [];
    (Anthropic as any).Messages.prototype.create = async function (params: any) {
      prompts.push(JSON.stringify(params.messages));
      if (params.tool_choice?.name === "verify_matches") return { content: [{ type: "tool_use", input: { verdicts: [] } }] };
      return { content: [{ type: "tool_use", input: { items: [
        { sectionKey: "seasonality", key: "snowContractMix", label: "Seasonal vs per-push snow contracts", critical: true, answeredByKey: "" },
        { sectionKey: "operations", key: "saltStorageCapacity", label: "Salt storage capacity (tonnes)", critical: false, answeredByKey: "" },
      ] } }] };
    };
    const saved: any[] = [];
    (storage as any).updateDeal = async (_id: string, patch: any) => { saved.push(patch); return undefined; };
    ensureInterviewPlan(deal);
    for (let i = 0; i < 50 && saved.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(prompts.length >= 1, "the model is called");
    assert.match(prompts[0], /LANDSCAPING AND SNOW MANAGEMENT/);
    const plan = saved[0].interviewPlan;
    assert.equal(plan.status, "ready");
    assert.equal(plan.dealSubIndustry, "Landscaping and snow & ice management");
    assert.ok(getInterviewPlan({ ...deal, interviewPlan: plan }), "the plan is current for the deal");
    assert.equal(getInterviewPlan({ ...deal, subIndustry: "Residential HVAC", interviewPlan: plan }), null, "a sub-industry edit rebuilds it");
  }
  ok("outline: the sub-industry finds the landscaping playbook and a checklist is built without an interview");

  console.log(`\n${n} groups passed`);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
