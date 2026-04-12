/**
 * cleanup.ts
 *
 * Finds and deletes all deals whose businessName starts with "TEST_".
 * Deleting a deal cascades to associated documents, interview sessions,
 * CIM sections, buyer access records, analytics events, etc. (server-side).
 *
 * Run standalone: npx tsx tests/utils/cleanup.ts [baseUrl]
 *
 * Examples:
 *   npx tsx tests/utils/cleanup.ts
 *   npx tsx tests/utils/cleanup.ts http://localhost:5000
 *   npx tsx tests/utils/cleanup.ts https://cimple-production.up.railway.app
 */

import { ApiClient } from "./api-client.js";

const TEST_PREFIX = "TEST_";

export interface CleanupResult {
  found: number;
  deleted: number;
  failed: Array<{ id: number; name: string; error: string }>;
  durationMs: number;
}

/**
 * Delete all deals with the TEST_ prefix.
 * Requires an authenticated ApiClient (broker session).
 */
export async function cleanupTestDeals(api: ApiClient): Promise<CleanupResult> {
  const t0 = performance.now();

  // Fetch all deals
  const listRes = await api.listDeals();
  if (listRes.status !== 200) {
    throw new Error(`Failed to list deals: status ${listRes.status}`);
  }

  const allDeals: any[] = Array.isArray(listRes.data) ? listRes.data : [];
  const testDeals = allDeals.filter(
    (d: any) => typeof d.businessName === "string" && d.businessName.startsWith(TEST_PREFIX),
  );

  const failed: CleanupResult["failed"] = [];
  let deleted = 0;

  for (const deal of testDeals) {
    try {
      const res = await api.deleteDeal(deal.id);
      if (res.status === 200 || res.status === 204) {
        deleted++;
        console.log(`  Deleted: ${deal.businessName} (id=${deal.id})`);
      } else {
        failed.push({
          id: deal.id,
          name: deal.businessName,
          error: `status ${res.status}: ${JSON.stringify(res.data)}`,
        });
        console.log(`  Failed:  ${deal.businessName} (id=${deal.id}) -> status ${res.status}`);
      }
    } catch (err: any) {
      failed.push({
        id: deal.id,
        name: deal.businessName,
        error: err.message || String(err),
      });
      console.log(`  Error:   ${deal.businessName} (id=${deal.id}) -> ${err.message}`);
    }
  }

  return {
    found: testDeals.length,
    deleted,
    failed,
    durationMs: Math.round(performance.now() - t0),
  };
}

/**
 * Also clean up any test buyer accounts that were created during tests.
 * Buyer accounts created via the API signup with emails containing "+test"
 * or names starting with "TEST_" are candidates for cleanup.
 *
 * Note: There is no bulk-delete buyer endpoint in the current API,
 * so this is a best-effort operation that logs what it would delete.
 */
export async function reportTestBuyers(api: ApiClient): Promise<void> {
  try {
    const res = await api.listBrokerBuyers();
    if (res.status !== 200) return;

    const buyers: any[] = Array.isArray(res.data) ? res.data : [];
    const testBuyers = buyers.filter(
      (b: any) =>
        (typeof b.name === "string" && b.name.startsWith(TEST_PREFIX)) ||
        (typeof b.email === "string" && b.email.includes("+test")),
    );

    if (testBuyers.length > 0) {
      console.log(`\n  Found ${testBuyers.length} test buyer contact(s) in broker list:`);
      for (const b of testBuyers) {
        console.log(`    - ${b.name || "(no name)"} <${b.email}> (id=${b.id})`);
      }
      console.log("  (Manual cleanup may be needed for buyer contacts)");
    }
  } catch {
    // Non-critical
  }
}

// ─── Standalone execution ────────────────────────────────────────────────────

if (process.argv[1] && process.argv[1].endsWith("cleanup.ts")) {
  const baseUrl = process.argv[2] || "http://localhost:5000";
  console.log(`\nCimple Test Cleanup`);
  console.log(`Target: ${baseUrl}`);
  console.log(`Prefix: ${TEST_PREFIX}\n`);

  const api = new ApiClient({ baseUrl, verbose: false });

  (async () => {
    try {
      // Try to proceed without login first (some dev setups don't require auth)
      const result = await cleanupTestDeals(api);

      console.log(`\n--- Cleanup Summary ---`);
      console.log(`Found:   ${result.found} test deal(s)`);
      console.log(`Deleted: ${result.deleted}`);
      if (result.failed.length > 0) {
        console.log(`Failed:  ${result.failed.length}`);
        for (const f of result.failed) {
          console.log(`  - ${f.name} (id=${f.id}): ${f.error}`);
        }
      }
      console.log(`Time:    ${result.durationMs}ms`);

      await reportTestBuyers(api);

      if (result.found === 0) {
        console.log("\nNo test deals found. Nothing to clean up.");
      }

      console.log("");
    } catch (err: any) {
      console.error(`\nCleanup failed: ${err.message}`);
      console.error("Make sure the server is running and accessible.");
      process.exit(1);
    }
  })();
}
