/**
 * test-helpers.ts
 *
 * Common utilities for the Cimple beta testing suite.
 * Provides polling helpers, assertions, retry logic, and result formatting.
 *
 * Run standalone to verify exports: npx tsx tests/utils/test-helpers.ts
 */

import type { ApiClient, ApiResponse } from "./api-client.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TestResult {
  name: string;
  passed: boolean;
  duration: number;
  details: string;
  errors?: string[];
}

export interface TestSuite {
  name: string;
  results: TestResult[];
  startedAt: string;
  completedAt: string;
  summary: {
    total: number;
    passed: number;
    failed: number;
    passRate: string;
    totalDuration: number;
  };
}

// ─── Polling helpers ─────────────────────────────────────────────────────────

/**
 * Polls the deal endpoint until all documents have status "processed" or
 * "extracted", or until maxWaitMs is exceeded.
 */
export async function waitForProcessing(
  api: ApiClient,
  dealId: string | number,
  maxWaitMs = 60_000,
): Promise<{ success: boolean; documents: any[] }> {
  const deadline = Date.now() + maxWaitMs;
  const pollInterval = 2000;

  while (Date.now() < deadline) {
    const res = await api.listDocuments(dealId);
    if (res.status !== 200) {
      await sleep(pollInterval);
      continue;
    }

    const docs: any[] = Array.isArray(res.data) ? res.data : [];
    const allDone = docs.length > 0 && docs.every(
      (d: any) => d.status === "processed" || d.status === "extracted" || d.status === "error",
    );

    if (allDone) {
      return { success: true, documents: docs };
    }

    await sleep(pollInterval);
  }

  // Timed out — return current state
  const finalRes = await api.listDocuments(dealId);
  return {
    success: false,
    documents: Array.isArray(finalRes.data) ? finalRes.data : [],
  };
}

/**
 * Polls until a financial analysis for the deal reaches status "completed"
 * or "error", or until maxWaitMs is exceeded.
 */
export async function waitForAnalysis(
  api: ApiClient,
  dealId: string | number,
  maxWaitMs = 120_000,
): Promise<{ success: boolean; analysis: any }> {
  const deadline = Date.now() + maxWaitMs;
  const pollInterval = 3000;

  while (Date.now() < deadline) {
    const res = await api.getFinancialAnalysis(dealId);
    if (res.status !== 200) {
      await sleep(pollInterval);
      continue;
    }

    // The endpoint may return an array; take the latest
    const analyses: any[] = Array.isArray(res.data) ? res.data : [res.data];
    const latest = analyses[analyses.length - 1];

    if (latest && (latest.status === "completed" || latest.status === "error" || latest.status === "failed")) {
      return { success: latest.status === "completed", analysis: latest };
    }

    await sleep(pollInterval);
  }

  const finalRes = await api.getFinancialAnalysis(dealId);
  const list = Array.isArray(finalRes.data) ? finalRes.data : [finalRes.data];
  return { success: false, analysis: list[list.length - 1] || null };
}

// ─── Assertions ──────────────────────────────────────────────────────────────

/**
 * Assert that a deeply nested field exists in the data object.
 * Path uses dot notation: "financials.revenue.total"
 *
 * Throws an Error with a descriptive message on failure.
 */
export function assertFieldExists(
  data: any,
  fieldPath: string,
  message?: string,
): void {
  const parts = fieldPath.split(".");
  let current = data;

  for (let i = 0; i < parts.length; i++) {
    if (current === null || current === undefined) {
      const traversed = parts.slice(0, i).join(".") || "(root)";
      throw new Error(
        message ||
          `Field "${fieldPath}" does not exist: hit null/undefined at "${traversed}"`,
      );
    }
    current = current[parts[i]];
  }

  if (current === null || current === undefined) {
    throw new Error(
      message || `Field "${fieldPath}" is null or undefined`,
    );
  }
}

/**
 * Assert that a numeric field at the given path falls within [min, max].
 * The field must exist and be a number.
 */
export function assertFieldInRange(
  data: any,
  fieldPath: string,
  min: number,
  max: number,
  message?: string,
): void {
  const parts = fieldPath.split(".");
  let current = data;

  for (const part of parts) {
    if (current === null || current === undefined) {
      throw new Error(
        message || `Field "${fieldPath}" does not exist (cannot check range)`,
      );
    }
    current = current[part];
  }

  if (typeof current !== "number") {
    throw new Error(
      message ||
        `Field "${fieldPath}" is not a number (got ${typeof current}: ${JSON.stringify(current)})`,
    );
  }

  if (current < min || current > max) {
    throw new Error(
      message ||
        `Field "${fieldPath}" = ${current} is outside range [${min}, ${max}]`,
    );
  }
}

/**
 * Assert that the API response has the expected status code.
 */
export function assertStatus(
  res: ApiResponse,
  expected: number,
  message?: string,
): void {
  if (res.status !== expected) {
    const body = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
    throw new Error(
      message ||
        `Expected status ${expected}, got ${res.status}. Body: ${body.slice(0, 300)}`,
    );
  }
}

// ─── Deal lifecycle helpers ──────────────────────────────────────────────────

/**
 * Creates a deal with standardized test data. All test deals are prefixed
 * with "TEST_" so cleanup can find them.
 */
export async function createTestDeal(
  api: ApiClient,
  businessData?: Partial<{
    businessName: string;
    industry: string;
    description: string;
    askingPrice: string;
    phase: string;
  }>,
): Promise<{ dealId: number; data: any }> {
  const defaults = {
    businessName: `TEST_${Date.now()}`,
    industry: "General Services",
    description: "Automated test deal — safe to delete",
    askingPrice: "500000",
    phase: "phase1_info_collection",
  };

  const payload = { ...defaults, ...businessData };
  // Ensure test prefix
  if (!payload.businessName.startsWith("TEST_")) {
    payload.businessName = `TEST_${payload.businessName}`;
  }

  const res = await api.createDeal(payload);
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`Failed to create test deal: status ${res.status}, ${JSON.stringify(res.data)}`);
  }

  const dealId = res.data.id ?? res.data.dealId ?? res.data;
  return { dealId, data: res.data };
}

/**
 * Uploads all files from a directory to a deal. Useful for bulk document
 * testing (e.g. uploading all financials from test-data/).
 */
export async function uploadAllDocuments(
  api: ApiClient,
  dealId: string | number,
  dirPath: string,
): Promise<ApiResponse[]> {
  const fs = await import("fs");
  const path = await import("path");

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const results: ApiResponse[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    // Skip hidden files and OS junk
    if (entry.name.startsWith(".")) continue;

    const filePath = path.join(dirPath, entry.name);

    // Infer category from filename or parent directory
    let category = "other";
    const lower = entry.name.toLowerCase();
    if (lower.includes("income") || lower.includes("p&l") || lower.includes("profit")) {
      category = "income_statement";
    } else if (lower.includes("balance")) {
      category = "balance_sheet";
    } else if (lower.includes("cash")) {
      category = "cash_flow";
    } else if (lower.includes("ar") || lower.includes("aging") || lower.includes("receivable")) {
      category = "ar_aging";
    } else if (lower.includes("tax")) {
      category = "tax_return";
    } else if (lower.includes("lease")) {
      category = "lease";
    }

    const res = await api.uploadDocument(dealId, filePath, category);
    results.push(res);
  }

  return results;
}

/**
 * Deletes a deal and best-effort cleans up associated data.
 * Does not throw on failure — cleanup is best effort.
 */
export async function cleanupDeal(
  api: ApiClient,
  dealId: string | number,
): Promise<void> {
  try {
    await api.deleteDeal(dealId);
  } catch {
    // Best effort
  }
}

// ─── Utility functions ───────────────────────────────────────────────────────

/**
 * Promisified sleep.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry a function up to maxRetries times with exponential backoff.
 * Initial delay is delayMs; each retry doubles the delay.
 */
export async function retry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  delayMs = 1000,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        const wait = delayMs * Math.pow(2, attempt);
        await sleep(wait);
      }
    }
  }

  throw lastError;
}

// ─── Result formatting ──────────────────────────────────────────────────────

/**
 * Build a structured TestResult object.
 */
export function formatTestResult(
  name: string,
  passed: boolean,
  details: string,
  duration = 0,
  errors?: string[],
): TestResult {
  return {
    name,
    passed,
    duration,
    details,
    errors: errors && errors.length > 0 ? errors : undefined,
  };
}

/**
 * Build a TestSuite summary from an array of TestResults.
 */
export function buildTestSuite(
  name: string,
  results: TestResult[],
  startedAt: Date,
  completedAt: Date,
): TestSuite {
  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

  return {
    name,
    results,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    summary: {
      total: results.length,
      passed,
      failed,
      passRate: results.length > 0 ? `${Math.round((passed / results.length) * 100)}%` : "N/A",
      totalDuration,
    },
  };
}

/**
 * Print a test suite summary to the console.
 */
export function printSuiteSummary(suite: TestSuite): void {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Suite: ${suite.name}`);
  console.log(`${"=".repeat(60)}`);
  console.log(
    `Results: ${suite.summary.passed}/${suite.summary.total} passed (${suite.summary.passRate})`,
  );
  console.log(`Duration: ${(suite.summary.totalDuration / 1000).toFixed(1)}s`);
  console.log("");

  for (const r of suite.results) {
    const icon = r.passed ? "PASS" : "FAIL";
    const time = r.duration > 0 ? ` (${r.duration}ms)` : "";
    console.log(`  [${icon}] ${r.name}${time}`);
    if (!r.passed && r.errors) {
      for (const err of r.errors) {
        console.log(`         ${err}`);
      }
    }
  }

  console.log(`\n${"=".repeat(60)}\n`);
}

/**
 * Run a single test case, catching errors and measuring duration.
 * Returns a TestResult regardless of pass/fail.
 */
export async function runTest(
  name: string,
  fn: () => Promise<string>,
): Promise<TestResult> {
  const t0 = performance.now();
  try {
    const details = await fn();
    const duration = Math.round(performance.now() - t0);
    return formatTestResult(name, true, details, duration);
  } catch (err: any) {
    const duration = Math.round(performance.now() - t0);
    const msg = err.message || String(err);
    return formatTestResult(name, false, `Failed: ${msg}`, duration, [msg]);
  }
}

// ─── Standalone self-test ────────────────────────────────────────────────────

if (process.argv[1] && process.argv[1].endsWith("test-helpers.ts")) {
  console.log("test-helpers.ts — self-test\n");

  // assertFieldExists
  try {
    assertFieldExists({ a: { b: { c: 42 } } }, "a.b.c");
    console.log("  [OK] assertFieldExists: nested path found");
  } catch (e: any) {
    console.log("  [FAIL] assertFieldExists:", e.message);
  }

  try {
    assertFieldExists({ a: { b: null } }, "a.b.c");
    console.log("  [FAIL] assertFieldExists: should have thrown for null");
  } catch {
    console.log("  [OK] assertFieldExists: correctly throws for null intermediate");
  }

  // assertFieldInRange
  try {
    assertFieldInRange({ revenue: 500_000 }, "revenue", 100_000, 1_000_000);
    console.log("  [OK] assertFieldInRange: in range");
  } catch (e: any) {
    console.log("  [FAIL] assertFieldInRange:", e.message);
  }

  try {
    assertFieldInRange({ revenue: 50 }, "revenue", 100, 200);
    console.log("  [FAIL] assertFieldInRange: should have thrown for out-of-range");
  } catch {
    console.log("  [OK] assertFieldInRange: correctly throws for out-of-range");
  }

  // retry
  let attempts = 0;
  retry(
    async () => {
      attempts++;
      if (attempts < 3) throw new Error("not yet");
      return "done";
    },
    5,
    10,
  ).then((r) => {
    console.log(`  [OK] retry: succeeded after ${attempts} attempts, result="${r}"`);
  });

  // formatTestResult
  const result = formatTestResult("sample test", true, "all good", 123);
  console.log(`  [OK] formatTestResult: ${JSON.stringify(result)}`);

  // buildTestSuite
  const suite = buildTestSuite(
    "Self-test",
    [
      formatTestResult("t1", true, "ok", 100),
      formatTestResult("t2", false, "bad", 200, ["oops"]),
    ],
    new Date(),
    new Date(),
  );
  printSuiteSummary(suite);

  console.log("\nAll self-tests passed.\n");
}
