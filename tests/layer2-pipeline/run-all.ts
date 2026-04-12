/**
 * Layer 2 — Pipeline Integration Tests
 *
 * Tests the full data pipeline end-to-end:
 *   document upload -> parsing -> extraction -> financial analysis ->
 *   CIM generation -> buyer matching
 *
 * These tests make real AI calls (Claude Sonnet) and cost ~$3-8 total.
 *
 * Run: npx tsx tests/layer2-pipeline/run-all.ts [baseUrl]
 *
 * Default base URL: http://localhost:54630
 */

import fs from "fs";
import path from "path";
import { ApiClient } from "../utils/api-client.js";
import {
  type TestResult,
  runTest,
  buildTestSuite,
  printSuiteSummary,
  waitForProcessing,
  assertStatus,
  assertFieldExists,
  sleep,
  cleanupDeal,
} from "../utils/test-helpers.js";
import { CostTracker } from "../utils/cost-tracker.js";

// ─── Configuration ──────────────────────────────────────────────────────────

const BASE_URL = process.argv[2] || "http://localhost:54630";
const TEST_DATA = path.resolve(import.meta.dirname, "..", "test-data");

const api = new ApiClient({ baseUrl: BASE_URL, verbose: true });
const costs = new CostTracker();

// Deal IDs created during tests — cleaned up at the end
const createdDealIds: number[] = [];

// ─── Timing tracker ─────────────────────────────────────────────────────────

interface StageTimings {
  [stage: string]: number; // milliseconds
}

const scenarioTimings: Record<string, StageTimings> = {};

function timeStage(scenario: string, stage: string, ms: number) {
  if (!scenarioTimings[scenario]) scenarioTimings[scenario] = {};
  scenarioTimings[scenario][stage] = ms;
}

// ─── Helper: create a test deal with required fields ────────────────────────

async function createPipelineDeal(data: {
  businessName: string;
  industry: string;
  description: string;
  askingPrice: string;
}): Promise<{ dealId: number; data: any }> {
  const name = data.businessName.startsWith("TEST_") ? data.businessName : `TEST_${data.businessName}`;
  const res = await api.createDeal({
    businessName: name,
    industry: data.industry,
    description: data.description,
    askingPrice: data.askingPrice,
    brokerId: "default-broker",
    phase: "phase1_info_collection",
  });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`Failed to create deal: status ${res.status}, ${JSON.stringify(res.data).slice(0, 300)}`);
  }
  const dealId = res.data.id ?? res.data.dealId ?? res.data;
  return { dealId, data: res.data };
}

// ─── Helper: read CSV file as string ────────────────────────────────────────

function readCsvFile(filePath: string): string {
  return fs.readFileSync(filePath, "utf-8");
}

// ─── Helper: upload a list of documents and track costs ─────────────────────

interface DocSpec {
  relativePath: string;
  category: string;
}

async function uploadDocuments(
  dealId: number,
  baseDir: string,
  docs: DocSpec[],
): Promise<{ uploaded: string[]; failed: string[] }> {
  const uploaded: string[] = [];
  const failed: string[] = [];

  for (const doc of docs) {
    const fullPath = path.join(baseDir, doc.relativePath);
    if (!fs.existsSync(fullPath)) {
      console.log(`    [SKIP] File not found: ${doc.relativePath}`);
      failed.push(`${doc.relativePath} (file not found)`);
      continue;
    }
    const res = await api.uploadDocument(dealId, fullPath, doc.category);
    costs.trackRequest(`/api/deals/${dealId}/documents/upload`, res.responseTime);
    if (res.status === 200 || res.status === 201) {
      uploaded.push(doc.relativePath);
      // Upload auto-triggers parsing which uses AI extraction
      costs.trackRequest(`/api/documents/auto/parse`, res.responseTime);
    } else {
      console.log(`    [FAIL] Upload ${doc.relativePath}: status ${res.status}`);
      console.log(`           Response: ${JSON.stringify(res.data).slice(0, 200)}`);
      failed.push(`${doc.relativePath} (status ${res.status})`);
    }
  }

  return { uploaded, failed };
}

// ─── Helper: wait for document parsing with polling ─────────────────────────

async function waitForDocs(
  dealId: number,
  maxWaitMs = 90_000,
): Promise<{ allParsed: boolean; docs: any[]; parsedCount: number; failedCount: number }> {
  const result = await waitForProcessing(api, dealId, maxWaitMs);
  const docs: any[] = result.documents;
  const parsedCount = docs.filter(
    (d: any) => d.status === "processed" || d.status === "extracted",
  ).length;
  const failedCount = docs.filter((d: any) => d.status === "error" || d.status === "failed").length;

  for (const d of docs) {
    costs.trackRequest(`/api/deals/${dealId}/documents`, 0); // poll GET is free
  }

  return { allParsed: result.success, docs, parsedCount, failedCount };
}

// ─── Helper: poll for financial analysis completion ─────────────────────────

async function waitForFinancialAnalysis(
  dealId: number,
  maxWaitMs = 600_000, // 10 min — real deals have 10-20+ financial docs
): Promise<{ success: boolean; analysis: any }> {
  const deadline = Date.now() + maxWaitMs;
  const pollInterval = 5_000;

  while (Date.now() < deadline) {
    const res = await api.getFinancialAnalysis(dealId);
    costs.trackRequest(`/api/deals/${dealId}/financial-analysis`, res.responseTime);

    if (res.status === 404) {
      // Analysis hasn't been created yet — keep waiting
      await sleep(pollInterval);
      continue;
    }

    if (res.status !== 200) {
      await sleep(pollInterval);
      continue;
    }

    const data = res.data;

    // The endpoint may return a single object or an array
    const analysis = Array.isArray(data) ? data[data.length - 1] : data;
    if (!analysis) {
      await sleep(pollInterval);
      continue;
    }

    if (analysis.status === "completed" || analysis.status === "error" || analysis.status === "failed") {
      return { success: analysis.status === "completed", analysis };
    }

    await sleep(pollInterval);
  }

  // Final attempt
  const finalRes = await api.getFinancialAnalysis(dealId);
  const finalData = finalRes.data;
  const finalAnalysis = Array.isArray(finalData) ? finalData[finalData.length - 1] : finalData;
  return { success: false, analysis: finalAnalysis };
}

// ─── Helper: poll for CIM sections ──────────────────────────────────────────

async function waitForCimSections(
  dealId: number,
  minSections: number,
  maxWaitMs = 600_000, // 10 min — CIM layout generation can be slow for data-rich deals
): Promise<{ success: boolean; sections: any[] }> {
  const deadline = Date.now() + maxWaitMs;
  const pollInterval = 5_000;

  while (Date.now() < deadline) {
    const res = await api.getCimSections(dealId);
    costs.trackRequest(`/api/deals/${dealId}/cim-sections`, res.responseTime);

    if (res.status === 200) {
      const sections: any[] = Array.isArray(res.data) ? res.data : [];
      if (sections.length >= minSections) {
        return { success: true, sections };
      }
    }

    await sleep(pollInterval);
  }

  // Final attempt
  const finalRes = await api.getCimSections(dealId);
  const sections = Array.isArray(finalRes.data) ? finalRes.data : [];
  return { success: sections.length >= minSections, sections };
}

// ─── Helper: import buyers via CSV (JSON body, not file upload) ─────────────

async function importBuyersFromCsv(
  csvPath: string,
): Promise<{ success: boolean; accepted: number; rejected: number; data: any }> {
  if (!fs.existsSync(csvPath)) {
    return { success: false, accepted: 0, rejected: 0, data: { error: "CSV file not found" } };
  }
  const csv = readCsvFile(csvPath);
  const res = await api.post("/api/broker/buyers/import-csv", {
    brokerId: "default-broker",
    csv,
    sendInvites: false,
  });
  costs.trackRequest("/api/broker/buyers/import-csv", res.responseTime);

  if (res.status !== 200) {
    return { success: false, accepted: 0, rejected: 0, data: res.data };
  }

  const accepted = res.data?.accepted?.length ?? 0;
  const rejected = res.data?.rejected?.length ?? 0;
  return { success: true, accepted, rejected, data: res.data };
}

// ─── Helper: grant buyer access entries for matching ────────────────────────

async function grantBuyerAccessForMatching(
  dealId: number,
  csvPath: string,
): Promise<number> {
  if (!fs.existsSync(csvPath)) return 0;

  const csv = readCsvFile(csvPath);
  const rows = csv.split("\n").filter(Boolean);
  if (rows.length < 2) return 0;

  // Parse header to find email column
  const header = rows[0].toLowerCase().split(",").map((h) => h.trim().replace(/"/g, ""));
  const emailIdx = header.findIndex((h) => h === "email" || h === "emailaddress" || h === "email address");
  const nameIdx = header.findIndex((h) => h === "name" || h === "fullname" || h === "full name");
  const companyIdx = header.findIndex((h) => h === "company");
  if (emailIdx === -1) return 0;

  let granted = 0;
  for (let i = 1; i < rows.length && i <= 5; i++) {
    // Take at most 5 buyers for matching tests
    const cols = rows[i].split(",").map((c) => c.trim().replace(/"/g, ""));
    const email = cols[emailIdx];
    if (!email || !email.includes("@")) continue;

    const name = nameIdx !== -1 ? cols[nameIdx] : undefined;
    const company = companyIdx !== -1 ? cols[companyIdx] : undefined;

    const res = await api.grantBuyerAccess(dealId, {
      buyerEmail: email,
      buyerName: name,
      buyerCompany: company,
      email, // fallback
    });
    costs.trackRequest(`/api/deals/${dealId}/buyers`, res.responseTime);
    if (res.status === 200 || res.status === 201) granted++;
  }

  return granted;
}

// ═════════════════════════════════════════════════════════════════════════════
// Scenario 1: Construction Pipeline (Amlin Contracting)
// ═════════════════════════════════════════════════════════════════════════════

async function runConstructionScenario(): Promise<TestResult[]> {
  const scenario = "Construction";
  const results: TestResult[] = [];
  let dealId: number | null = null;

  // 1. Create deal
  results.push(
    await runTest(`${scenario}: Create deal`, async () => {
      const t0 = performance.now();
      const { dealId: id } = await createPipelineDeal({
        businessName: "TEST_Amlin Contracting Ltd.",
        industry: "Construction",
        description: "General contractor specializing in commercial and residential construction in Ontario. COR certified.",
        askingPrice: "2500000",
      });
      dealId = id;
      createdDealIds.push(id);
      costs.trackRequest("/api/deals", 0);
      timeStage(scenario, "create_deal", performance.now() - t0);
      return `Deal created: id=${id}`;
    }),
  );

  if (!dealId) return results;

  // 2. Upload documents
  const constructionDir = path.join(TEST_DATA, "construction-ontario");
  results.push(
    await runTest(`${scenario}: Upload documents`, async () => {
      const t0 = performance.now();
      const docs: DocSpec[] = [
        { relativePath: "financials/income-statements-2022-2024.xlsx", category: "financials" },
        { relativePath: "financials/balance-sheets-2022-2024.xlsx", category: "financials" },
        { relativePath: "legal/commercial-lease-agreement.pdf", category: "legal" },
        { relativePath: "compliance/wsib-clearance-certificate.pdf", category: "operations" },
        { relativePath: "operations/equipment-list.xlsx", category: "operations" },
      ];
      const { uploaded, failed } = await uploadDocuments(dealId!, constructionDir, docs);
      timeStage(scenario, "upload_docs", performance.now() - t0);
      if (uploaded.length === 0) throw new Error("No documents uploaded successfully");
      return `Uploaded ${uploaded.length}/${docs.length} docs. Failed: ${failed.length > 0 ? failed.join(", ") : "none"}`;
    }),
  );

  // 3. Wait for document parsing
  results.push(
    await runTest(`${scenario}: Document parsing`, async () => {
      const t0 = performance.now();
      const { allParsed, docs, parsedCount, failedCount } = await waitForDocs(dealId!, 90_000);
      timeStage(scenario, "doc_parsing", performance.now() - t0);
      const statuses = docs.map((d: any) => `${d.name}: ${d.status}`).join("; ");
      if (parsedCount === 0) throw new Error(`No documents parsed. Statuses: ${statuses}`);
      return `${parsedCount} parsed, ${failedCount} failed. ${allParsed ? "All done" : "Timed out"}. [${statuses}]`;
    }),
  );

  // 4. Check extracted info
  results.push(
    await runTest(`${scenario}: Extracted info populated`, async () => {
      const t0 = performance.now();
      const res = await api.getExtractedInfo(dealId!);
      costs.trackRequest(`/api/deals/${dealId}/extracted-info`, res.responseTime);
      timeStage(scenario, "check_extracted", performance.now() - t0);

      if (res.status !== 200) throw new Error(`Status ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`);

      const info = res.data;
      const fieldCount = typeof info === "object" && info ? Object.keys(info).length : 0;
      if (fieldCount === 0) throw new Error("extractedInfo is empty — no fields were populated by document extraction");

      const fieldNames = typeof info === "object" && info ? Object.keys(info).slice(0, 10).join(", ") : "";
      return `${fieldCount} top-level fields extracted. Sample: ${fieldNames}`;
    }),
  );

  // 5. Trigger financial analysis
  results.push(
    await runTest(`${scenario}: Trigger financial analysis`, async () => {
      const t0 = performance.now();
      const res = await api.triggerFinancialAnalysis(dealId!);
      costs.trackRequest(`/api/deals/${dealId}/financial-analysis`, res.responseTime);
      timeStage(scenario, "trigger_fa", performance.now() - t0);

      if (res.status !== 200) throw new Error(`Status ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`);
      return `Analysis started: ${JSON.stringify(res.data).slice(0, 100)}`;
    }),
  );

  // 6. Wait for financial analysis
  results.push(
    await runTest(`${scenario}: Financial analysis completes`, async () => {
      const t0 = performance.now();
      const { success, analysis } = await waitForFinancialAnalysis(dealId!, 600_000);
      timeStage(scenario, "wait_fa", performance.now() - t0);

      if (!success) {
        const status = analysis?.status ?? "unknown";
        const preview = JSON.stringify(analysis).slice(0, 300);
        throw new Error(`Analysis did not complete (status: ${status}). Data: ${preview}`);
      }
      return `Analysis completed (status: ${analysis.status})`;
    }),
  );

  // 7. Verify financial analysis results
  results.push(
    await runTest(`${scenario}: Financial analysis quality`, async () => {
      const res = await api.getFinancialAnalysis(dealId!);
      costs.trackRequest(`/api/deals/${dealId}/financial-analysis`, res.responseTime);

      if (res.status !== 200) throw new Error(`Status ${res.status}`);

      const analysis = Array.isArray(res.data) ? res.data[res.data.length - 1] : res.data;
      const findings: string[] = [];

      // Check for revenue data
      const hasRevenue =
        analysis.reclassifiedPnl ||
        analysis.incomeStatement ||
        analysis.insights;
      if (hasRevenue) findings.push("has financial data");
      else findings.push("MISSING financial data");

      // Check for addbacks
      const addbacks = analysis.normalization?.addbacks || analysis.addbacks;
      if (addbacks && (Array.isArray(addbacks) ? addbacks.length > 0 : true)) {
        findings.push(`addbacks identified`);
      } else {
        findings.push("no addbacks found");
      }

      // Check for insights
      if (analysis.insights) findings.push("has insights");

      if (!hasRevenue) throw new Error(`Financial analysis missing core data. Keys: ${Object.keys(analysis).join(", ")}`);

      return findings.join("; ");
    }),
  );

  // 8. Generate CIM content
  results.push(
    await runTest(`${scenario}: Generate CIM content`, async () => {
      const t0 = performance.now();
      const res = await api.generateContent(dealId!);
      costs.trackRequest(`/api/deals/${dealId}/generate-content`, res.responseTime);
      timeStage(scenario, "generate_cim", performance.now() - t0);

      if (res.status !== 200) throw new Error(`Status ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`);
      return `CIM generation triggered: ${JSON.stringify(res.data).slice(0, 150)}`;
    }),
  );

  // 9. Wait for CIM sections
  results.push(
    await runTest(`${scenario}: CIM sections populated`, async () => {
      const t0 = performance.now();
      const { success, sections } = await waitForCimSections(dealId!, 5, 600_000);
      timeStage(scenario, "wait_cim", performance.now() - t0);

      if (!success && sections.length === 0) throw new Error("No CIM sections generated");

      const sectionKeys = sections.map((s: any) => s.sectionKey || s.key || s.id).join(", ");
      const hasCover = sections.some(
        (s: any) => (s.sectionKey || s.key || "").toLowerCase().includes("cover"),
      );
      const hasFinancial = sections.some(
        (s: any) =>
          (s.sectionKey || s.key || "").toLowerCase().includes("financial") ||
          (s.sectionKey || s.key || "").toLowerCase().includes("asking"),
      );

      const details = [
        `${sections.length} sections`,
        hasCover ? "has cover" : "MISSING cover",
        hasFinancial ? "has financial section" : "MISSING financial section",
      ];

      return `${details.join("; ")}. Keys: ${sectionKeys}`;
    }),
  );

  // 10. Generate blind CIM
  results.push(
    await runTest(`${scenario}: Generate blind CIM`, async () => {
      const t0 = performance.now();
      const res = await api.generateBlindCim(dealId!);
      costs.trackRequest(`/api/deals/${dealId}/generate-blind`, res.responseTime);
      timeStage(scenario, "generate_blind", performance.now() - t0);

      if (res.status !== 200) throw new Error(`Status ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`);
      return `Blind CIM generated: ${JSON.stringify(res.data).slice(0, 150)}`;
    }),
  );

  // 11. Verify blind CIM overrides
  results.push(
    await runTest(`${scenario}: Blind CIM overrides exist`, async () => {
      // Give a moment for overrides to be written
      await sleep(2_000);
      const res = await api.get(`/api/deals/${dealId}/cim-overrides/blind`);
      costs.trackRequest(`/api/deals/${dealId}/cim-overrides/blind`, res.responseTime);

      if (res.status !== 200) throw new Error(`Status ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`);

      const overrides = Array.isArray(res.data) ? res.data : [];
      if (overrides.length === 0) throw new Error("No blind CIM overrides found");

      return `${overrides.length} blind override sections`;
    }),
  );

  // 12. Import buyers
  const buyerCsvPath = path.join(constructionDir, "buyers", "buyer-list-15.csv");
  results.push(
    await runTest(`${scenario}: Import buyers from CSV`, async () => {
      const t0 = performance.now();
      const result = await importBuyersFromCsv(buyerCsvPath);
      timeStage(scenario, "import_buyers", performance.now() - t0);

      if (!result.success) throw new Error(`Import failed: ${JSON.stringify(result.data).slice(0, 300)}`);
      return `${result.accepted} accepted, ${result.rejected} rejected`;
    }),
  );

  // 13. Grant buyer access for matching
  results.push(
    await runTest(`${scenario}: Grant buyer access for matching`, async () => {
      const granted = await grantBuyerAccessForMatching(dealId!, buyerCsvPath);
      if (granted === 0) throw new Error("No buyer access entries created");
      return `${granted} buyer access entries created`;
    }),
  );

  // 14. Run buyer matching
  results.push(
    await runTest(`${scenario}: Run buyer matching`, async () => {
      const t0 = performance.now();
      const res = await api.matchBuyers(dealId!);
      costs.trackRequest(`/api/deals/${dealId}/match-buyers`, res.responseTime);
      timeStage(scenario, "buyer_matching", performance.now() - t0);

      if (res.status !== 200) throw new Error(`Status ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`);

      const matchResults = Array.isArray(res.data) ? res.data : [];
      if (matchResults.length === 0) throw new Error("No matching results returned");

      const withScores = matchResults.filter((m: any) => m.matchScore !== null);
      const scores = withScores.map((m: any) => m.matchScore);
      const avgScore = scores.length > 0 ? (scores.reduce((a: number, b: number) => a + b, 0) / scores.length).toFixed(1) : "N/A";

      return `${matchResults.length} buyers matched, ${withScores.length} with scores. Avg score: ${avgScore}`;
    }),
  );

  return results;
}

// ═════════════════════════════════════════════════════════════════════════════
// Scenario 2: Restaurant Pipeline (Terrazza Kitchen & Bar)
// ═════════════════════════════════════════════════════════════════════════════

async function runRestaurantScenario(): Promise<TestResult[]> {
  const scenario = "Restaurant";
  const results: TestResult[] = [];
  let dealId: number | null = null;

  // 1. Create deal
  results.push(
    await runTest(`${scenario}: Create deal`, async () => {
      const t0 = performance.now();
      const { dealId: id } = await createPipelineDeal({
        businessName: "TEST_Terrazza Kitchen & Bar",
        industry: "Restaurant & Food Service",
        description: "Upscale Italian restaurant and bar in downtown Toronto. Full liquor license, 120 seats, established 2015.",
        askingPrice: "1800000",
      });
      dealId = id;
      createdDealIds.push(id);
      costs.trackRequest("/api/deals", 0);
      timeStage(scenario, "create_deal", performance.now() - t0);
      return `Deal created: id=${id}`;
    }),
  );

  if (!dealId) return results;

  // 2. Upload documents
  const restaurantDir = path.join(TEST_DATA, "restaurant-toronto");
  results.push(
    await runTest(`${scenario}: Upload documents`, async () => {
      const t0 = performance.now();
      const docs: DocSpec[] = [
        { relativePath: "financials/income-statements-2022-2024.xlsx", category: "financials" },
        { relativePath: "legal/commercial-lease-with-liquor-license.pdf", category: "legal" },
        { relativePath: "compliance/health-inspection-2024.pdf", category: "operations" },
      ];
      const { uploaded, failed } = await uploadDocuments(dealId!, restaurantDir, docs);
      timeStage(scenario, "upload_docs", performance.now() - t0);
      if (uploaded.length === 0) throw new Error("No documents uploaded successfully");
      return `Uploaded ${uploaded.length}/${docs.length} docs. Failed: ${failed.length > 0 ? failed.join(", ") : "none"}`;
    }),
  );

  // 3. Wait for parsing
  results.push(
    await runTest(`${scenario}: Document parsing`, async () => {
      const t0 = performance.now();
      const { allParsed, docs, parsedCount, failedCount } = await waitForDocs(dealId!, 90_000);
      timeStage(scenario, "doc_parsing", performance.now() - t0);
      const statuses = docs.map((d: any) => `${d.name}: ${d.status}`).join("; ");
      if (parsedCount === 0) throw new Error(`No documents parsed. Statuses: ${statuses}`);
      return `${parsedCount} parsed, ${failedCount} failed. ${allParsed ? "All done" : "Timed out"}`;
    }),
  );

  // 4. Check extracted info
  results.push(
    await runTest(`${scenario}: Extracted info populated`, async () => {
      const t0 = performance.now();
      const res = await api.getExtractedInfo(dealId!);
      costs.trackRequest(`/api/deals/${dealId}/extracted-info`, res.responseTime);
      timeStage(scenario, "check_extracted", performance.now() - t0);

      if (res.status !== 200) throw new Error(`Status ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`);

      const info = res.data;
      const fieldCount = typeof info === "object" && info ? Object.keys(info).length : 0;
      if (fieldCount === 0) throw new Error("extractedInfo is empty");

      return `${fieldCount} top-level fields extracted`;
    }),
  );

  // 5. Trigger financial analysis
  results.push(
    await runTest(`${scenario}: Trigger financial analysis`, async () => {
      const t0 = performance.now();
      const res = await api.triggerFinancialAnalysis(dealId!);
      costs.trackRequest(`/api/deals/${dealId}/financial-analysis`, res.responseTime);
      timeStage(scenario, "trigger_fa", performance.now() - t0);

      if (res.status !== 200) throw new Error(`Status ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`);
      return `Analysis started`;
    }),
  );

  // 6. Wait for financial analysis
  results.push(
    await runTest(`${scenario}: Financial analysis completes`, async () => {
      const t0 = performance.now();
      const { success, analysis } = await waitForFinancialAnalysis(dealId!, 600_000);
      timeStage(scenario, "wait_fa", performance.now() - t0);

      if (!success) throw new Error(`Analysis did not complete (status: ${analysis?.status ?? "unknown"})`);
      return `Analysis completed`;
    }),
  );

  // 7. Verify restaurant-specific financial data
  results.push(
    await runTest(`${scenario}: Financial analysis quality (restaurant)`, async () => {
      const res = await api.getFinancialAnalysis(dealId!);
      costs.trackRequest(`/api/deals/${dealId}/financial-analysis`, res.responseTime);
      if (res.status !== 200) throw new Error(`Status ${res.status}`);

      const analysis = Array.isArray(res.data) ? res.data[res.data.length - 1] : res.data;
      const findings: string[] = [];

      // Check for any financial data
      if (analysis.reclassifiedPnl || analysis.incomeStatement || analysis.insights) {
        findings.push("has financial data");
      } else {
        throw new Error(`No financial data found. Keys: ${Object.keys(analysis).join(", ")}`);
      }

      // Look for restaurant-specific metrics in insights or anywhere in the data
      const jsonStr = JSON.stringify(analysis).toLowerCase();
      if (jsonStr.includes("food") || jsonStr.includes("cogs") || jsonStr.includes("cost of goods")) {
        findings.push("mentions food/COGS cost");
      }
      if (jsonStr.includes("labour") || jsonStr.includes("labor") || jsonStr.includes("payroll") || jsonStr.includes("wage")) {
        findings.push("mentions labour/payroll");
      }

      return findings.join("; ");
    }),
  );

  // 8. Generate CIM layout
  results.push(
    await runTest(`${scenario}: Generate CIM layout`, async () => {
      const t0 = performance.now();
      const res = await api.generateCimLayout(dealId!);
      costs.trackRequest(`/api/deals/${dealId}/generate-layout`, res.responseTime);
      timeStage(scenario, "generate_layout", performance.now() - t0);

      if (res.status !== 200) throw new Error(`Status ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`);
      return `Layout generation triggered`;
    }),
  );

  // 9. Verify CIM sections
  results.push(
    await runTest(`${scenario}: CIM sections populated`, async () => {
      const t0 = performance.now();
      const { success, sections } = await waitForCimSections(dealId!, 3, 600_000);
      timeStage(scenario, "wait_cim", performance.now() - t0);

      if (!success && sections.length === 0) throw new Error("No CIM sections generated");

      const sectionKeys = sections.map((s: any) => s.sectionKey || s.key || s.id).join(", ");
      return `${sections.length} sections. Keys: ${sectionKeys}`;
    }),
  );

  // 10. Import buyers
  const buyerCsvPath = path.join(restaurantDir, "buyers", "buyer-list-10.csv");
  results.push(
    await runTest(`${scenario}: Import buyers from CSV`, async () => {
      const t0 = performance.now();
      const result = await importBuyersFromCsv(buyerCsvPath);
      timeStage(scenario, "import_buyers", performance.now() - t0);
      if (!result.success) throw new Error(`Import failed: ${JSON.stringify(result.data).slice(0, 300)}`);
      return `${result.accepted} accepted, ${result.rejected} rejected`;
    }),
  );

  // 11. Grant access + run matching
  results.push(
    await runTest(`${scenario}: Buyer matching`, async () => {
      const t0 = performance.now();
      const granted = await grantBuyerAccessForMatching(dealId!, buyerCsvPath);
      if (granted === 0) throw new Error("No buyer access entries created");

      const res = await api.matchBuyers(dealId!);
      costs.trackRequest(`/api/deals/${dealId}/match-buyers`, res.responseTime);
      timeStage(scenario, "buyer_matching", performance.now() - t0);

      if (res.status !== 200) throw new Error(`Status ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`);
      const matchResults = Array.isArray(res.data) ? res.data : [];
      return `${matchResults.length} buyers matched, ${granted} with access`;
    }),
  );

  return results;
}

// ═════════════════════════════════════════════════════════════════════════════
// Scenario 3: IT/MSP Pipeline (Cascadia Managed Services)
// ═════════════════════════════════════════════════════════════════════════════

async function runItMspScenario(): Promise<TestResult[]> {
  const scenario = "IT/MSP";
  const results: TestResult[] = [];
  let dealId: number | null = null;

  // 1. Create deal
  results.push(
    await runTest(`${scenario}: Create deal`, async () => {
      const t0 = performance.now();
      const { dealId: id } = await createPipelineDeal({
        businessName: "TEST_Cascadia Managed Services",
        industry: "Technology & Online",
        description: "Managed IT services provider in British Columbia. 85% MRR, SOC2 compliant, 120+ managed endpoints.",
        askingPrice: "3200000",
      });
      dealId = id;
      createdDealIds.push(id);
      costs.trackRequest("/api/deals", 0);
      timeStage(scenario, "create_deal", performance.now() - t0);
      return `Deal created: id=${id}`;
    }),
  );

  if (!dealId) return results;

  // 2. Upload documents
  const mspDir = path.join(TEST_DATA, "it-msp-bc");
  results.push(
    await runTest(`${scenario}: Upload documents`, async () => {
      const t0 = performance.now();
      const docs: DocSpec[] = [
        { relativePath: "financials/income-statements-2022-2024.xlsx", category: "financials" },
        { relativePath: "legal/msa-client-greenfield-holdings.pdf", category: "legal" },
        { relativePath: "compliance/vendor-partnership-certificates.pdf", category: "operations" },
      ];
      const { uploaded, failed } = await uploadDocuments(dealId!, mspDir, docs);
      timeStage(scenario, "upload_docs", performance.now() - t0);
      if (uploaded.length === 0) throw new Error("No documents uploaded successfully");
      return `Uploaded ${uploaded.length}/${docs.length} docs. Failed: ${failed.length > 0 ? failed.join(", ") : "none"}`;
    }),
  );

  // 3. Wait for parsing
  results.push(
    await runTest(`${scenario}: Document parsing`, async () => {
      const t0 = performance.now();
      const { allParsed, docs, parsedCount, failedCount } = await waitForDocs(dealId!, 90_000);
      timeStage(scenario, "doc_parsing", performance.now() - t0);
      const statuses = docs.map((d: any) => `${d.name}: ${d.status}`).join("; ");
      if (parsedCount === 0) throw new Error(`No documents parsed. Statuses: ${statuses}`);
      return `${parsedCount} parsed, ${failedCount} failed. ${allParsed ? "All done" : "Timed out"}`;
    }),
  );

  // 4. Check extracted info
  results.push(
    await runTest(`${scenario}: Extracted info populated`, async () => {
      const t0 = performance.now();
      const res = await api.getExtractedInfo(dealId!);
      costs.trackRequest(`/api/deals/${dealId}/extracted-info`, res.responseTime);
      timeStage(scenario, "check_extracted", performance.now() - t0);

      if (res.status !== 200) throw new Error(`Status ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`);

      const info = res.data;
      const fieldCount = typeof info === "object" && info ? Object.keys(info).length : 0;
      if (fieldCount === 0) throw new Error("extractedInfo is empty");

      // Check for MRR-related data
      const jsonStr = JSON.stringify(info).toLowerCase();
      const hasMrr = jsonStr.includes("mrr") || jsonStr.includes("recurring") || jsonStr.includes("monthly recurring");

      return `${fieldCount} fields extracted${hasMrr ? " (MRR data found)" : ""}`;
    }),
  );

  // 5. Trigger financial analysis
  results.push(
    await runTest(`${scenario}: Trigger financial analysis`, async () => {
      const t0 = performance.now();
      const res = await api.triggerFinancialAnalysis(dealId!);
      costs.trackRequest(`/api/deals/${dealId}/financial-analysis`, res.responseTime);
      timeStage(scenario, "trigger_fa", performance.now() - t0);

      if (res.status !== 200) throw new Error(`Status ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`);
      return `Analysis started`;
    }),
  );

  // 6. Wait for financial analysis
  results.push(
    await runTest(`${scenario}: Financial analysis completes`, async () => {
      const t0 = performance.now();
      const { success, analysis } = await waitForFinancialAnalysis(dealId!, 600_000);
      timeStage(scenario, "wait_fa", performance.now() - t0);

      if (!success) throw new Error(`Analysis did not complete (status: ${analysis?.status ?? "unknown"})`);
      return `Analysis completed`;
    }),
  );

  // 7. Verify MRR-related extraction
  results.push(
    await runTest(`${scenario}: Financial analysis quality (IT/MSP)`, async () => {
      const res = await api.getFinancialAnalysis(dealId!);
      costs.trackRequest(`/api/deals/${dealId}/financial-analysis`, res.responseTime);
      if (res.status !== 200) throw new Error(`Status ${res.status}`);

      const analysis = Array.isArray(res.data) ? res.data[res.data.length - 1] : res.data;
      const findings: string[] = [];

      if (analysis.reclassifiedPnl || analysis.incomeStatement || analysis.insights) {
        findings.push("has financial data");
      } else {
        throw new Error(`No financial data found. Keys: ${Object.keys(analysis).join(", ")}`);
      }

      // Check for MRR/recurring revenue mentions
      const jsonStr = JSON.stringify(analysis).toLowerCase();
      if (jsonStr.includes("mrr") || jsonStr.includes("recurring")) {
        findings.push("mentions MRR/recurring revenue");
      }
      if (jsonStr.includes("managed") || jsonStr.includes("service")) {
        findings.push("mentions managed services");
      }

      return findings.join("; ");
    }),
  );

  // 8. Generate CIM layout
  results.push(
    await runTest(`${scenario}: Generate CIM layout`, async () => {
      const t0 = performance.now();
      const res = await api.generateCimLayout(dealId!);
      costs.trackRequest(`/api/deals/${dealId}/generate-layout`, res.responseTime);
      timeStage(scenario, "generate_layout", performance.now() - t0);

      if (res.status !== 200) throw new Error(`Status ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`);
      return `Layout generation triggered`;
    }),
  );

  // 9. Verify CIM sections
  results.push(
    await runTest(`${scenario}: CIM sections populated`, async () => {
      const t0 = performance.now();
      const { success, sections } = await waitForCimSections(dealId!, 3, 600_000);
      timeStage(scenario, "wait_cim", performance.now() - t0);

      if (!success && sections.length === 0) throw new Error("No CIM sections generated");

      const sectionKeys = sections.map((s: any) => s.sectionKey || s.key || s.id).join(", ");
      return `${sections.length} sections. Keys: ${sectionKeys}`;
    }),
  );

  // 10. Import buyers + matching
  const buyerCsvPath = path.join(mspDir, "buyers", "buyer-list-10.csv");
  results.push(
    await runTest(`${scenario}: Import buyers from CSV`, async () => {
      const t0 = performance.now();
      const result = await importBuyersFromCsv(buyerCsvPath);
      timeStage(scenario, "import_buyers", performance.now() - t0);
      if (!result.success) throw new Error(`Import failed: ${JSON.stringify(result.data).slice(0, 300)}`);
      return `${result.accepted} accepted, ${result.rejected} rejected`;
    }),
  );

  results.push(
    await runTest(`${scenario}: Buyer matching`, async () => {
      const t0 = performance.now();
      const granted = await grantBuyerAccessForMatching(dealId!, buyerCsvPath);
      if (granted === 0) throw new Error("No buyer access entries created");

      const res = await api.matchBuyers(dealId!);
      costs.trackRequest(`/api/deals/${dealId}/match-buyers`, res.responseTime);
      timeStage(scenario, "buyer_matching", performance.now() - t0);

      if (res.status !== 200) throw new Error(`Status ${res.status}: ${JSON.stringify(res.data).slice(0, 300)}`);
      const matchResults = Array.isArray(res.data) ? res.data : [];
      return `${matchResults.length} buyers matched, ${granted} with access`;
    }),
  );

  return results;
}

// ═════════════════════════════════════════════════════════════════════════════
// Main runner
// ═════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log("=".repeat(70));
  console.log("Layer 2 — Pipeline Integration Tests");
  console.log("=".repeat(70));
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Test data: ${TEST_DATA}`);
  console.log(`Started:  ${new Date().toISOString()}`);
  console.log("");
  console.log("WARNING: These tests make real AI calls (Claude Sonnet) and cost ~$3-8.");
  console.log("=".repeat(70));
  console.log("");

  costs.startTracking();
  const suiteStart = new Date();
  const allResults: TestResult[] = [];

  // ── Verify server is reachable ──

  try {
    const health = await api.get("/api/deals");
    if (health.status === 200) {
      console.log(`Server reachable at ${BASE_URL} (${health.responseTime}ms)\n`);
    } else {
      console.log(`Server returned status ${health.status} — proceeding anyway.\n`);
    }
  } catch (err: any) {
    console.error(`Cannot reach server at ${BASE_URL}: ${err.message}`);
    console.error("Is the server running? Start it with: npm run dev");
    process.exit(1);
  }

  // ── Run scenarios sequentially ──

  console.log("\n" + "=".repeat(70));
  console.log("SCENARIO 1: Construction Pipeline (Amlin Contracting)");
  console.log("=".repeat(70) + "\n");
  try {
    const constructionResults = await runConstructionScenario();
    allResults.push(...constructionResults);
  } catch (err: any) {
    console.error(`\nConstruction scenario crashed: ${err.message}`);
    allResults.push({
      name: "Construction: SCENARIO CRASH",
      passed: false,
      duration: 0,
      details: err.message,
      errors: [err.message],
    });
  }

  console.log("\n" + "=".repeat(70));
  console.log("SCENARIO 2: Restaurant Pipeline (Terrazza Kitchen & Bar)");
  console.log("=".repeat(70) + "\n");
  try {
    const restaurantResults = await runRestaurantScenario();
    allResults.push(...restaurantResults);
  } catch (err: any) {
    console.error(`\nRestaurant scenario crashed: ${err.message}`);
    allResults.push({
      name: "Restaurant: SCENARIO CRASH",
      passed: false,
      duration: 0,
      details: err.message,
      errors: [err.message],
    });
  }

  console.log("\n" + "=".repeat(70));
  console.log("SCENARIO 3: IT/MSP Pipeline (Cascadia Managed Services)");
  console.log("=".repeat(70) + "\n");
  try {
    const mspResults = await runItMspScenario();
    allResults.push(...mspResults);
  } catch (err: any) {
    console.error(`\nIT/MSP scenario crashed: ${err.message}`);
    allResults.push({
      name: "IT/MSP: SCENARIO CRASH",
      passed: false,
      duration: 0,
      details: err.message,
      errors: [err.message],
    });
  }

  const suiteEnd = new Date();

  // ═════════════════════════════════════════════════════════════════════════
  // Summary
  // ═════════════════════════════════════════════════════════════════════════

  const suite = buildTestSuite("Layer 2 — Pipeline Integration", allResults, suiteStart, suiteEnd);
  printSuiteSummary(suite);

  // ── Cost report ──

  console.log(costs.formatReport());
  console.log("");

  // ── Pipeline timing breakdown ──

  console.log("=== Pipeline Timing Breakdown ===");
  for (const [scenario, stages] of Object.entries(scenarioTimings)) {
    console.log(`\n  ${scenario}:`);
    let total = 0;
    for (const [stage, ms] of Object.entries(stages)) {
      console.log(`    ${stage.padEnd(20)} ${(ms / 1000).toFixed(1)}s`);
      total += ms;
    }
    console.log(`    ${"TOTAL".padEnd(20)} ${(total / 1000).toFixed(1)}s`);
  }
  console.log("");

  // ── API timing summary ──

  const timingSummary = api.getTimingSummary();
  console.log("=== API Timing Summary ===");
  console.log(`  Total requests: ${timingSummary.totalRequests}`);
  console.log(`  Total time:     ${(timingSummary.totalTimeMs / 1000).toFixed(1)}s`);
  console.log(`  Avg response:   ${timingSummary.avgTimeMs}ms`);
  if (timingSummary.slowest) {
    console.log(`  Slowest:        ${timingSummary.slowest.endpoint} (${timingSummary.slowest.ms}ms)`);
  }
  console.log("");

  // ── Cleanup ──

  console.log("=== Cleanup ===");
  for (const dealId of createdDealIds) {
    try {
      await cleanupDeal(api, dealId);
      console.log(`  Deleted deal ${dealId}`);
    } catch {
      console.log(`  Failed to delete deal ${dealId} (best effort)`);
    }
  }
  console.log("");

  // ── Exit code ──

  const exitCode = suite.summary.failed > 0 ? 1 : 0;
  console.log(
    exitCode === 0
      ? "All tests passed."
      : `${suite.summary.failed} test(s) failed.`,
  );
  process.exit(exitCode);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(2);
});
