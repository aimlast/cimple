/**
 * generate-all.ts
 *
 * Master generator script that runs all test data generators in sequence,
 * reports what was generated, and verifies all expected files exist.
 *
 * Run: npx tsx tests/generators/generate-all.ts
 */

import { execSync } from "child_process";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(import.meta.dirname, "..");
const GENERATORS_DIR = path.resolve(import.meta.dirname);
const TEST_DATA_DIR = path.join(ROOT, "test-data");

// ─── Generator registry ─────────────────────────────────────────────────────

interface GeneratorEntry {
  name: string;
  file: string;
  description: string;
}

const GENERATORS: GeneratorEntry[] = [
  {
    name: "Financials",
    file: "generate-financials.ts",
    description: "XLSX income statements + balance sheets for 5 fake businesses",
  },
  {
    name: "Buyers & Equipment",
    file: "generate-buyers-and-equipment.ts",
    description: "Buyer CSV files (5 industries) + equipment XLSX files (2 industries)",
  },
];

// ─── Expected output files ──────────────────────────────────────────────────

/**
 * These are the files that should exist after all generators have run.
 * Paths are relative to tests/test-data/.
 */
const EXPECTED_FILES = [
  // Financial generators
  "construction-ontario/financials/income-statements-2022-2024.xlsx",
  "construction-ontario/financials/balance-sheets-2022-2024.xlsx",
  "restaurant-toronto/financials/income-statements-2022-2024.xlsx",
  "medical-clinic-ontario/financials/income-statements-2022-2024.xlsx",
  "manufacturing-alberta/financials/income-statements-2022-2024.xlsx",
  "it-msp-bc/financials/income-statements-2022-2024.xlsx",

  // Buyer CSVs
  "construction-ontario/buyers/buyer-list-15.csv",
  "restaurant-toronto/buyers/buyer-list-10.csv",
  "medical-clinic-ontario/buyers/buyer-list-8.csv",
  "manufacturing-alberta/buyers/buyer-list-12.csv",
  "it-msp-bc/buyers/buyer-list-10.csv",

  // Equipment lists
  "construction-ontario/operations/equipment-list.xlsx",
  "manufacturing-alberta/operations/equipment-list-with-ages.xlsx",
];

// ─── Run generators ──────────────────────────────────────────────────────────

interface GeneratorResult {
  name: string;
  success: boolean;
  durationMs: number;
  error?: string;
}

function runGenerator(entry: GeneratorEntry): GeneratorResult {
  const filePath = path.join(GENERATORS_DIR, entry.file);

  if (!fs.existsSync(filePath)) {
    return {
      name: entry.name,
      success: false,
      durationMs: 0,
      error: `Generator file not found: ${entry.file}`,
    };
  }

  const t0 = performance.now();
  try {
    execSync(`npx tsx "${filePath}"`, {
      cwd: ROOT,
      stdio: "pipe",
      timeout: 30_000,
    });

    return {
      name: entry.name,
      success: true,
      durationMs: Math.round(performance.now() - t0),
    };
  } catch (err: any) {
    const stderr = err.stderr?.toString?.() || err.message || String(err);
    return {
      name: entry.name,
      success: false,
      durationMs: Math.round(performance.now() - t0),
      error: stderr.slice(0, 500),
    };
  }
}

function verifyExpectedFiles(): { present: string[]; missing: string[] } {
  const present: string[] = [];
  const missing: string[] = [];

  for (const relPath of EXPECTED_FILES) {
    const fullPath = path.join(TEST_DATA_DIR, relPath);
    if (fs.existsSync(fullPath)) {
      present.push(relPath);
    } else {
      missing.push(relPath);
    }
  }

  return { present, missing };
}

function collectAllGeneratedFiles(): string[] {
  const files: string[] = [];

  function walk(dir: string, prefix = "") {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), rel);
      } else if (!entry.name.startsWith(".")) {
        files.push(rel);
      }
    }
  }

  walk(TEST_DATA_DIR);
  return files.sort();
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
  console.log("===================================================");
  console.log("  Cimple Test Data Generator");
  console.log("===================================================\n");

  // Ensure test-data directory exists
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

  // Run each generator
  const results: GeneratorResult[] = [];

  for (const gen of GENERATORS) {
    console.log(`Running: ${gen.name}`);
    console.log(`  ${gen.description}`);
    console.log(`  File: ${gen.file}`);

    const result = runGenerator(gen);
    results.push(result);

    if (result.success) {
      console.log(`  Status: OK (${result.durationMs}ms)\n`);
    } else {
      console.log(`  Status: FAILED (${result.durationMs}ms)`);
      console.log(`  Error: ${result.error}\n`);
    }
  }

  // Verify expected files
  console.log("---------------------------------------------------");
  console.log("File verification:\n");

  const { present, missing } = verifyExpectedFiles();

  for (const f of present) {
    console.log(`  [OK] ${f}`);
  }
  for (const f of missing) {
    console.log(`  [MISSING] ${f}`);
  }

  // Full inventory
  console.log("\n---------------------------------------------------");
  console.log("Full test-data inventory:\n");

  const allFiles = collectAllGeneratedFiles();
  for (const f of allFiles) {
    const fullPath = path.join(TEST_DATA_DIR, f);
    const stat = fs.statSync(fullPath);
    const sizeKb = (stat.size / 1024).toFixed(1);
    console.log(`  ${f} (${sizeKb} KB)`);
  }

  // Summary
  console.log("\n===================================================");
  console.log("  Summary");
  console.log("===================================================");

  const successCount = results.filter((r) => r.success).length;
  const totalTime = results.reduce((sum, r) => sum + r.durationMs, 0);

  console.log(`Generators:     ${successCount}/${results.length} succeeded`);
  console.log(`Expected files: ${present.length}/${EXPECTED_FILES.length} present`);
  console.log(`Total files:    ${allFiles.length}`);
  console.log(`Total time:     ${totalTime}ms`);

  if (missing.length > 0) {
    console.log(`\nWARNING: ${missing.length} expected file(s) missing.`);
  }

  if (results.some((r) => !r.success)) {
    console.log(`\nWARNING: ${results.filter((r) => !r.success).length} generator(s) failed.`);
    process.exit(1);
  }

  if (missing.length === 0 && successCount === results.length) {
    console.log("\nAll generators passed. All expected files present.");
  }

  console.log("");
}

main();
