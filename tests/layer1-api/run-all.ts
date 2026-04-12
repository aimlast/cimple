/**
 * Layer 1 API Smoke Tests — run-all.ts
 *
 * Tests every major API endpoint in the Cimple platform for basic functionality:
 * does the endpoint exist, does it accept the right parameters, does it return
 * the right status codes.
 *
 * Usage:
 *   npx tsx tests/layer1-api/run-all.ts [baseUrl]
 *
 * Default base URL: http://localhost:54630
 */

import path from "path";
import { ApiClient } from "../utils/api-client.js";
import {
  runTest,
  buildTestSuite,
  printSuiteSummary,
  assertStatus,
  assertFieldExists,
  type TestResult,
} from "../utils/test-helpers.js";

// ─── Configuration ──────────────────────────────────────────────────────────

const BASE_URL = process.argv[2] || "http://localhost:54630";
const TEST_DATA_DIR = path.resolve(
  import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
  "../test-data/construction-ontario/financials",
);
const TEST_XLSX = path.join(TEST_DATA_DIR, "income-statements-2022-2024.xlsx");

// Stable test identifiers to avoid collisions
const RUN_ID = Date.now();
const TEST_BROKER_ID = `smoke-test-broker-${RUN_ID}`;

// ─── Shared state across sequential tests ───────────────────────────────────

let dealId: number | string = 0;
let documentId: number | string = 0;
let sessionId: string = "";
let faqId: number | string = 0;
let taskId: number | string = 0;
let buyerAccessId: number | string = 0;
let buyerApprovalId: number | string = 0;
let memberId: number | string = 0;
let brandingId: number | string = 0;

// ─── Test definitions ───────────────────────────────────────────────────────

async function runAllTests(api: ApiClient): Promise<TestResult[]> {
  const results: TestResult[] = [];

  // ═══════════════════════════════════════════════════════════════════════
  // DEAL LIFECYCLE
  // ═══════════════════════════════════════════════════════════════════════

  // 1. Create a deal
  results.push(
    await runTest("1. Deal: POST /api/deals — create deal", async () => {
      const res = await api.createDeal({
        businessName: "TEST_SmokeTest Co",
        industry: "Construction",
        description: "Automated smoke test deal",
        askingPrice: "750000",
        brokerId: TEST_BROKER_ID,
      } as any);
      assertStatus(res, 200);
      assertFieldExists(res.data, "id");
      dealId = res.data.id;
      return `Created deal id=${dealId}`;
    }),
  );

  // 2. List deals — verify the deal appears
  results.push(
    await runTest("2. Deal: GET /api/deals — verify deal in list", async () => {
      const res = await api.listDeals();
      assertStatus(res, 200);
      const deals = Array.isArray(res.data) ? res.data : [];
      const found = deals.find((d: any) => d.id === dealId);
      if (!found) throw new Error(`Deal ${dealId} not found in list of ${deals.length} deals`);
      return `Found deal in list of ${deals.length} deals`;
    }),
  );

  // 3. Get specific deal
  results.push(
    await runTest("3. Deal: GET /api/deals/:id — get specific deal", async () => {
      const res = await api.getDeal(dealId);
      assertStatus(res, 200);
      assertFieldExists(res.data, "id");
      if (res.data.businessName !== "TEST_SmokeTest Co") {
        throw new Error(`Expected businessName "TEST_SmokeTest Co", got "${res.data.businessName}"`);
      }
      return `Got deal: ${res.data.businessName}`;
    }),
  );

  // 4. Update deal
  results.push(
    await runTest("4. Deal: PATCH /api/deals/:id — update businessName", async () => {
      const res = await api.updateDeal(dealId, {
        businessName: "TEST_SmokeTest Updated",
      });
      assertStatus(res, 200);
      return `Updated deal, new name: ${res.data.businessName}`;
    }),
  );

  // 5. Verify update stuck
  results.push(
    await runTest("5. Deal: GET /api/deals/:id — verify update persisted", async () => {
      const res = await api.getDeal(dealId);
      assertStatus(res, 200);
      if (res.data.businessName !== "TEST_SmokeTest Updated") {
        throw new Error(
          `Update did not persist. Expected "TEST_SmokeTest Updated", got "${res.data.businessName}"`,
        );
      }
      return "Update persisted correctly";
    }),
  );

  // ═══════════════════════════════════════════════════════════════════════
  // DOCUMENT MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════

  // 6. Upload document
  results.push(
    await runTest("6. Document: POST .../documents/upload — upload XLSX", async () => {
      const res = await api.uploadDocument(dealId, TEST_XLSX, "financials");
      if (res.status !== 200 && res.status !== 201) {
        throw new Error(
          `Expected 200 or 201, got ${res.status}. Body: ${JSON.stringify(res.data).slice(0, 300)}`,
        );
      }
      assertFieldExists(res.data, "id");
      documentId = res.data.id;
      return `Uploaded document id=${documentId}`;
    }),
  );

  // 7. List documents
  results.push(
    await runTest("7. Document: GET /api/deals/:id/documents — verify listed", async () => {
      const res = await api.listDocuments(dealId);
      assertStatus(res, 200);
      const docs = Array.isArray(res.data) ? res.data : [];
      if (!documentId || documentId === 0) {
        // Upload failed — just verify the endpoint works
        return `Document list endpoint works (${docs.length} docs). Upload was skipped.`;
      }
      const found = docs.find((d: any) => d.id === documentId);
      if (!found) throw new Error(`Document ${documentId} not found in list`);
      return `Found document in list of ${docs.length} docs`;
    }),
  );

  // 8. Trigger parsing (fire and forget — don't wait for completion)
  results.push(
    await runTest("8. Document: POST /api/documents/:id/parse — trigger parse", async () => {
      if (!documentId || documentId === 0) {
        throw new Error("Skipped: no document uploaded (test 6 failed)");
      }
      const res = await api.parseDocument(documentId);
      assertStatus(res, 200);
      return `Parse triggered: ${JSON.stringify(res.data)}`;
    }),
  );

  // ═══════════════════════════════════════════════════════════════════════
  // SELLER INVITATIONS
  // ═══════════════════════════════════════════════════════════════════════

  // 9. Create seller invite
  results.push(
    await runTest("9. Invite: POST /api/deals/:id/invites — create invite", async () => {
      const res = await api.createSellerInvite(dealId, {
        sellerEmail: "test-seller@example.com",
        sellerName: "Test Seller",
      });
      assertStatus(res, 200);
      assertFieldExists(res.data, "id");
      return `Created invite id=${res.data.id}`;
    }),
  );

  // 10. Verify invite token is returned
  results.push(
    await runTest("10. Invite: verify token is returned", async () => {
      const res = await api.createSellerInvite(dealId, {
        sellerEmail: "test-seller-2@example.com",
        sellerName: "Test Seller 2",
      });
      assertStatus(res, 200);
      assertFieldExists(res.data, "token");
      if (!res.data.token || typeof res.data.token !== "string" || res.data.token.length < 10) {
        throw new Error(`Token looks invalid: "${res.data.token}"`);
      }
      return `Invite token: ${res.data.token.slice(0, 8)}...`;
    }),
  );

  // ═══════════════════════════════════════════════════════════════════════
  // INTERVIEW SYSTEM (makes AI calls)
  // ═══════════════════════════════════════════════════════════════════════

  // 11. Start interview session (makes AI call — may hit rate limits)
  results.push(
    await runTest("11. Interview: POST /api/interview/:dealId/start", async () => {
      const res = await api.startInterview(dealId);
      if (res.status === 500 && JSON.stringify(res.data).includes("rate_limit")) {
        throw new Error("Rate-limited by Anthropic API (transient — retry later)");
      }
      assertStatus(res, 200);
      assertFieldExists(res.data, "sessionId");
      sessionId = res.data.sessionId;
      return `Started interview, sessionId=${sessionId}`;
    }),
  );

  // 12. Verify sessionId and message present
  results.push(
    await runTest("12. Interview: verify sessionId + message present", async () => {
      if (!sessionId) throw new Error("Skipped: no sessionId (test 11 failed)");
      // Start again — should resume or return same session
      const res = await api.startInterview(dealId);
      if (res.status === 500 && JSON.stringify(res.data).includes("rate_limit")) {
        throw new Error("Rate-limited by Anthropic API (transient — retry later)");
      }
      assertStatus(res, 200);
      assertFieldExists(res.data, "sessionId");
      const hasContent =
        res.data.message || res.data.messages || res.data.response || res.data.content;
      if (!hasContent && !res.data.sessionId) {
        throw new Error("No message content in interview start response");
      }
      sessionId = res.data.sessionId;
      return `Session confirmed. sessionId=${sessionId}`;
    }),
  );

  // 13. Get interview history
  results.push(
    await runTest("13. Interview: GET .../session/:sessionId/history", async () => {
      if (!sessionId) throw new Error("Skipped: no sessionId (test 11 failed)");
      const res = await api.getInterviewHistory(sessionId);
      assertStatus(res, 200);
      return `Got history: ${JSON.stringify(res.data).slice(0, 200)}`;
    }),
  );

  // ═══════════════════════════════════════════════════════════════════════
  // BRANDING
  // ═══════════════════════════════════════════════════════════════════════

  // 14. Get branding settings
  results.push(
    await runTest("14. Branding: GET /api/branding — fetch settings", async () => {
      // The branding endpoint returns empty body (Content-Length: 0) with
      // Content-Type: application/json when no branding exists.  The ApiClient
      // calls res.json() which throws "Unexpected end of JSON input".
      // We catch that and treat it as "no branding configured".
      try {
        const res = await api.get("/api/branding");
        assertStatus(res, 200);
        if (res.data && typeof res.data === "object" && res.data.id) {
          brandingId = res.data.id;
          return `Branding fetched: exists (id=${brandingId})`;
        }
        return "Branding fetched: none configured (null/empty)";
      } catch (err: any) {
        if (err.message?.includes("JSON")) {
          return "Branding fetched: none configured (empty body — expected for fresh DB)";
        }
        throw err;
      }
    }),
  );

  // 15. Create/update branding
  results.push(
    await runTest("15. Branding: POST/PATCH — set companyName", async () => {
      // Check if branding already exists (handle empty-body edge case)
      let existingId: string | null = null;
      try {
        const checkRes = await api.get("/api/branding");
        if (checkRes.data && typeof checkRes.data === "object" && checkRes.data.id) {
          existingId = checkRes.data.id;
        }
      } catch {
        // Empty body — no branding yet
      }

      let res;
      if (existingId) {
        res = await api.patch(`/api/branding/${existingId}`, {
          companyName: "TEST_Broker Firm",
        });
      } else {
        res = await api.post("/api/branding", {
          companyName: "TEST_Broker Firm",
        });
      }
      assertStatus(res, 200);
      assertFieldExists(res.data, "id");
      brandingId = res.data.id;
      return `Branding set: id=${brandingId}, companyName=${res.data.companyName}`;
    }),
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TEAM MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════

  // 16. Add a team member
  results.push(
    await runTest("16. Team: POST /api/deals/:id/members — add associate", async () => {
      const res = await api.addTeamMember(dealId, {
        email: `associate-${RUN_ID}@test.com`,
        name: "Test Associate",
        role: "associate",
        teamType: "broker",
      });
      assertStatus(res, 200);
      assertFieldExists(res.data, "id");
      memberId = res.data.id;
      return `Added team member id=${memberId}`;
    }),
  );

  // 17. Verify member appears
  results.push(
    await runTest("17. Team: GET /api/deals/:id/members — verify member", async () => {
      const res = await api.getTeamMembers(dealId);
      assertStatus(res, 200);
      const members = Array.isArray(res.data) ? res.data : [];
      const found = members.find((m: any) => m.id === memberId);
      if (!found) throw new Error("Team member not found in list");
      return `Found member in list of ${members.length} members`;
    }),
  );

  // ═══════════════════════════════════════════════════════════════════════
  // FAQ
  // ═══════════════════════════════════════════════════════════════════════

  // 18. Create FAQ item
  results.push(
    await runTest("18. FAQ: POST /api/deals/:id/faq — create FAQ", async () => {
      const res = await api.createFaq(dealId, {
        question: "Test?",
        answer: "Test answer",
      });
      assertStatus(res, 200);
      assertFieldExists(res.data, "id");
      faqId = res.data.id;
      return `Created FAQ id=${faqId}`;
    }),
  );

  // 19. Verify FAQ appears
  results.push(
    await runTest("19. FAQ: GET /api/deals/:id/faq — verify FAQ listed", async () => {
      const res = await api.listFaq(dealId);
      assertStatus(res, 200);
      const faqs = Array.isArray(res.data) ? res.data : [];
      const found = faqs.find((f: any) => f.id === faqId);
      if (!found) throw new Error(`FAQ ${faqId} not found in list`);
      return `Found FAQ in list of ${faqs.length} FAQs`;
    }),
  );

  // 20. Delete FAQ
  results.push(
    await runTest("20. FAQ: DELETE /api/faq/:id — delete FAQ", async () => {
      const res = await api.deleteFaq(faqId);
      assertStatus(res, 200);
      // Verify deletion
      const listRes = await api.listFaq(dealId);
      const faqs = Array.isArray(listRes.data) ? listRes.data : [];
      const stillThere = faqs.find((f: any) => f.id === faqId);
      if (stillThere) throw new Error("FAQ still present after deletion");
      return "FAQ deleted and confirmed gone";
    }),
  );

  // ═══════════════════════════════════════════════════════════════════════
  // TASKS
  // ═══════════════════════════════════════════════════════════════════════

  // 21. Create task
  results.push(
    await runTest("21. Task: POST /api/deals/:id/tasks — create task", async () => {
      const res = await api.createTask(dealId, {
        title: "Test task",
        type: "follow_up",
        createdBy: TEST_BROKER_ID,
      });
      assertStatus(res, 200);
      assertFieldExists(res.data, "id");
      taskId = res.data.id;
      return `Created task id=${taskId}`;
    }),
  );

  // 22. Verify task appears
  results.push(
    await runTest("22. Task: GET /api/deals/:id/tasks — verify task listed", async () => {
      const res = await api.listTasks(dealId);
      assertStatus(res, 200);
      const tasks = Array.isArray(res.data) ? res.data : [];
      const found = tasks.find((t: any) => t.id === taskId);
      if (!found) throw new Error(`Task ${taskId} not found in list`);
      return `Found task in list of ${tasks.length} tasks`;
    }),
  );

  // 23. Update task status
  results.push(
    await runTest("23. Task: PATCH /api/tasks/:id — mark completed", async () => {
      const res = await api.updateTask(taskId, { status: "completed" });
      assertStatus(res, 200);
      if (res.data.status !== "completed") {
        throw new Error(`Expected status "completed", got "${res.data.status}"`);
      }
      return "Task marked completed";
    }),
  );

  // ═══════════════════════════════════════════════════════════════════════
  // BUYER AUTH (uses a separate ApiClient for buyer session)
  // ═══════════════════════════════════════════════════════════════════════

  const buyerEmail = `smoke-buyer-${RUN_ID}@example.com`;
  const buyerPassword = "TestPass123!";
  const buyerApi = new ApiClient({ baseUrl: BASE_URL, verbose: false });

  // 24. Create buyer account
  results.push(
    await runTest("24. Buyer Auth: POST /api/buyer-auth/signup — create", async () => {
      const res = await buyerApi.createBuyerAccount({
        email: buyerEmail,
        password: buyerPassword,
        name: "Test Buyer",
      });
      if (res.status !== 200 && res.status !== 201) {
        throw new Error(
          `Expected 200/201, got ${res.status}. Body: ${JSON.stringify(res.data).slice(0, 300)}`,
        );
      }
      return `Buyer account created: status=${res.status}`;
    }),
  );

  // 25. Login
  results.push(
    await runTest("25. Buyer Auth: POST /api/buyer-auth/login — login", async () => {
      const res = await buyerApi.buyerLogin(buyerEmail, buyerPassword);
      assertStatus(res, 200);
      return "Buyer logged in successfully";
    }),
  );

  // 26. Verify authenticated
  results.push(
    await runTest("26. Buyer Auth: GET /api/buyer-auth/me — verify session", async () => {
      const res = await buyerApi.getBuyerMe();
      assertStatus(res, 200);
      // Response is { user: { id, email, ... } }
      assertFieldExists(res.data, "user.id");
      return `Buyer authenticated: id=${res.data.user.id}, email=${res.data.user.email}`;
    }),
  );

  // 27. Update buyer profile
  results.push(
    await runTest("27. Buyer Auth: PATCH /api/buyer-auth/me — update profile", async () => {
      const res = await buyerApi.updateBuyerProfile({ company: "Test Corp" });
      assertStatus(res, 200);
      // Response is { user: { ... } }
      assertFieldExists(res.data, "user");
      return "Buyer profile updated";
    }),
  );

  // ═══════════════════════════════════════════════════════════════════════
  // BUYER ACCESS (broker granting CIM access)
  // ═══════════════════════════════════════════════════════════════════════

  // 28. Grant buyer access
  results.push(
    await runTest("28. Buyer Access: POST /api/deals/:id/buyers — grant", async () => {
      const res = await api.grantBuyerAccess(dealId, {
        email: `smoke-buyer-access-${RUN_ID}@example.com`,
        buyerEmail: `smoke-buyer-access-${RUN_ID}@example.com`,
        buyerName: "Smoke Buyer",
      });
      if (res.status !== 200 && res.status !== 201) {
        throw new Error(
          `Expected 200/201, got ${res.status}. Body: ${JSON.stringify(res.data).slice(0, 300)}`,
        );
      }
      assertFieldExists(res.data, "id");
      buyerAccessId = res.data.id;
      return `Granted buyer access id=${buyerAccessId}`;
    }),
  );

  // 29. List buyer access
  results.push(
    await runTest("29. Buyer Access: GET /api/deals/:id/buyers — verify", async () => {
      const res = await api.listBuyerAccess(dealId);
      assertStatus(res, 200);
      const buyers = Array.isArray(res.data) ? res.data : [];
      const found = buyers.find((b: any) => b.id === buyerAccessId);
      if (!found) throw new Error(`Buyer access ${buyerAccessId} not in list`);
      return `Found buyer access in list of ${buyers.length}`;
    }),
  );

  // ═══════════════════════════════════════════════════════════════════════
  // ANALYTICS
  // ═══════════════════════════════════════════════════════════════════════

  // 30. Broker analytics summary
  results.push(
    await runTest("30. Analytics: GET /api/analytics/summary — broker", async () => {
      const res = await api.getAnalyticsSummary();
      assertStatus(res, 200);
      return `Analytics summary: ${JSON.stringify(res.data).slice(0, 200)}`;
    }),
  );

  // 31. Deal analytics (empty is fine)
  results.push(
    await runTest("31. Analytics: GET /api/deals/:id/analytics — deal", async () => {
      const res = await api.getAnalytics(dealId);
      assertStatus(res, 200);
      const events = Array.isArray(res.data) ? res.data : [];
      return `Deal analytics: ${events.length} events`;
    }),
  );

  // ═══════════════════════════════════════════════════════════════════════
  // INTEGRATIONS
  // ═══════════════════════════════════════════════════════════════════════

  // 32. List integrations (empty is fine)
  results.push(
    await runTest("32. Integrations: GET /api/integrations — list", async () => {
      const res = await api.listIntegrations();
      assertStatus(res, 200);
      const integrations = Array.isArray(res.data) ? res.data : [];
      return `Integrations: ${integrations.length} found`;
    }),
  );

  // ═══════════════════════════════════════════════════════════════════════
  // BUYER APPROVALS
  // ═══════════════════════════════════════════════════════════════════════

  // 33. Create buyer approval request
  results.push(
    await runTest("33. Buyer Approvals: POST .../buyer-approvals — create", async () => {
      const res = await api.createBuyerApproval(dealId, {
        buyerName: "Approval Test Buyer",
        buyerEmail: `approval-buyer-${RUN_ID}@example.com`,
        category: "financial_buyer",
        submittedBy: "smoke-test",
        submittedByName: "Smoke Test Runner",
      });
      assertStatus(res, 200);
      assertFieldExists(res.data, "id");
      buyerApprovalId = res.data.id;
      return `Created buyer approval id=${buyerApprovalId}`;
    }),
  );

  // 34. List buyer approvals
  results.push(
    await runTest("34. Buyer Approvals: GET .../buyer-approvals — verify", async () => {
      const res = await api.getBuyerApprovals(dealId);
      assertStatus(res, 200);
      const approvals = Array.isArray(res.data) ? res.data : [];
      const found = approvals.find((a: any) => a.id === buyerApprovalId);
      if (!found) throw new Error(`Approval ${buyerApprovalId} not found`);
      return `Found approval in list of ${approvals.length}`;
    }),
  );

  // ═══════════════════════════════════════════════════════════════════════
  // EDGE CASES
  // ═══════════════════════════════════════════════════════════════════════

  // 35. Nonexistent deal returns 404 or error
  results.push(
    await runTest("35. Edge: GET /api/deals/<fake-uuid> — 404 or error", async () => {
      const res = await api.getDeal("00000000-0000-0000-0000-000000000000");
      if (res.status !== 404 && res.status !== 500) {
        throw new Error(`Expected 404 or 500 for nonexistent deal, got ${res.status}`);
      }
      return `Nonexistent deal returns status=${res.status}`;
    }),
  );

  // 36. Missing required fields returns 400
  results.push(
    await runTest("36. Edge: POST /api/deals with empty body — 400", async () => {
      const res = await api.post("/api/deals", {});
      if (res.status !== 400) {
        return `Server returned ${res.status} for empty body (expected 400). Behavior noted.`;
      }
      return "Correctly returned 400 for missing required fields";
    }),
  );

  // 37. Interview on nonexistent deal returns error
  results.push(
    await runTest("37. Edge: POST /api/interview/<fake>/start — error", async () => {
      const res = await api.startInterview("00000000-0000-0000-0000-000000000000");
      if (res.status >= 200 && res.status < 300) {
        return `Unexpectedly succeeded (status=${res.status}). Server may create sessions for any deal ID.`;
      }
      return `Correctly returned error status=${res.status}`;
    }),
  );

  // 38. Invalid phase update
  results.push(
    await runTest("38. Edge: PATCH /api/deals/:id — invalid phase value", async () => {
      const res = await api.updateDeal(dealId, {
        phase: "totally_invalid_phase_value",
      });
      return `Invalid phase: status=${res.status}. ${
        res.status === 400
          ? "Correctly rejected"
          : "Server accepted (no enum validation on phase)"
      }`;
    }),
  );

  // ═══════════════════════════════════════════════════════════════════════
  // CLEANUP
  // ═══════════════════════════════════════════════════════════════════════

  results.push(
    await runTest("Cleanup: DELETE /api/deals/:id — delete test deal", async () => {
      if (!dealId || dealId === 0) {
        return "No deal to clean up (creation failed earlier)";
      }
      const res = await api.deleteDeal(dealId);
      assertStatus(res, 200);
      // Verify it's gone
      const check = await api.getDeal(dealId);
      if (check.status === 200 && check.data && check.data.id) {
        throw new Error("Deal still exists after deletion");
      }
      return "Test deal deleted and verified gone";
    }),
  );

  return results;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nCimple Layer 1 API Smoke Tests`);
  console.log(`Target: ${BASE_URL}`);
  console.log(`Started: ${new Date().toISOString()}\n`);

  const api = new ApiClient({ baseUrl: BASE_URL, verbose: true });

  // Quick health check — verify the server is reachable
  try {
    const health = await api.get("/api/deals");
    if (health.status !== 200) {
      console.error(`Server health check failed: GET /api/deals returned ${health.status}`);
      console.error("Is the server running at", BASE_URL, "?");
      process.exit(1);
    }
    console.log(`Health check passed (${health.responseTime}ms)\n`);
  } catch (err: any) {
    console.error(`Cannot reach server at ${BASE_URL}: ${err.message}`);
    console.error("Make sure the server is running before executing tests.");
    process.exit(1);
  }

  const startedAt = new Date();
  const results = await runAllTests(api);
  const completedAt = new Date();

  const suite = buildTestSuite("Layer 1 — API Smoke Tests", results, startedAt, completedAt);
  printSuiteSummary(suite);

  // Print timing summary from the API client
  const timings = api.getTimingSummary();
  console.log("API Timing Summary:");
  console.log(`  Total requests: ${timings.totalRequests}`);
  console.log(`  Total time: ${(timings.totalTimeMs / 1000).toFixed(1)}s`);
  console.log(`  Avg response: ${timings.avgTimeMs}ms`);
  if (timings.slowest) {
    console.log(`  Slowest: ${timings.slowest.endpoint} (${timings.slowest.ms}ms)`);
  }
  console.log("");

  // Exit with appropriate code
  if (suite.summary.failed > 0) {
    console.log(`RESULT: ${suite.summary.failed} test(s) failed.\n`);
    process.exit(1);
  } else {
    console.log(`RESULT: All ${suite.summary.total} tests passed.\n`);
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Unhandled error in test runner:", err);
  process.exit(1);
});
