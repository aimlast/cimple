/**
 * api-client.ts
 *
 * HTTP client for testing all Cimple API endpoints.
 * Uses Node's built-in fetch (Node 18+) and FormData from undici for multipart uploads.
 *
 * Run standalone smoke test: npx tsx tests/utils/api-client.ts
 */

import fs from "fs";
import path from "path";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ApiResponse<T = any> {
  status: number;
  data: T;
  responseTime: number;
}

export interface ApiClientOptions {
  baseUrl?: string;
  /** If true, logs each request to stdout */
  verbose?: boolean;
}

// ─── Cookie jar ──────────────────────────────────────────────────────────────

/**
 * Minimal cookie jar that stores Set-Cookie headers and replays them.
 * Handles the broker session (express-session) and buyer session.
 */
class CookieJar {
  private cookies: Map<string, string> = new Map();

  update(headers: Headers): void {
    const raw = headers.getSetCookie?.();
    if (!raw) return;
    for (const line of raw) {
      // Extract "name=value" from "name=value; Path=/; HttpOnly"
      const pair = line.split(";")[0].trim();
      const eqIdx = pair.indexOf("=");
      if (eqIdx > 0) {
        this.cookies.set(pair.slice(0, eqIdx), pair.slice(eqIdx + 1));
      }
    }
  }

  header(): string {
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }

  clear(): void {
    this.cookies.clear();
  }
}

// ─── Client ──────────────────────────────────────────────────────────────────

export class ApiClient {
  readonly baseUrl: string;
  private jar = new CookieJar();
  private verbose: boolean;

  /** Running tally of response times per endpoint pattern */
  private timings: Array<{ endpoint: string; method: string; ms: number }> = [];

  constructor(opts?: ApiClientOptions) {
    this.baseUrl = (opts?.baseUrl ?? "http://localhost:5000").replace(/\/$/, "");
    this.verbose = opts?.verbose ?? false;
  }

  // ── Low-level HTTP ─────────────────────────────────────────────────────────

  private async request<T = any>(
    method: string,
    urlPath: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<ApiResponse<T>> {
    const url = `${this.baseUrl}${urlPath}`;
    const headers: Record<string, string> = {
      cookie: this.jar.header(),
      ...extraHeaders,
    };

    const init: RequestInit = { method, headers, redirect: "manual" };

    if (body !== undefined && !(body instanceof FormData)) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    } else if (body instanceof FormData) {
      // Let fetch set the multipart boundary automatically
      init.body = body as any;
    }

    const t0 = performance.now();
    const res = await fetch(url, init);
    const responseTime = Math.round(performance.now() - t0);

    this.jar.update(res.headers);

    let data: any;
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      data = await res.json();
    } else {
      data = await res.text();
    }

    this.timings.push({ endpoint: urlPath, method, ms: responseTime });

    if (this.verbose) {
      const tag = res.ok ? "OK" : "ERR";
      console.log(`  [${tag}] ${method} ${urlPath} → ${res.status} (${responseTime}ms)`);
    }

    return { status: res.status, data, responseTime };
  }

  async get<T = any>(urlPath: string): Promise<ApiResponse<T>> {
    return this.request<T>("GET", urlPath);
  }

  async post<T = any>(urlPath: string, body?: unknown): Promise<ApiResponse<T>> {
    return this.request<T>("POST", urlPath, body);
  }

  async patch<T = any>(urlPath: string, body?: unknown): Promise<ApiResponse<T>> {
    return this.request<T>("PATCH", urlPath, body);
  }

  async delete<T = any>(urlPath: string): Promise<ApiResponse<T>> {
    return this.request<T>("DELETE", urlPath);
  }

  // ── File upload ────────────────────────────────────────────────────────────

  /**
   * Upload a file via multipart/form-data.
   * Uses the global FormData (Node 18+) and reads the file into a Blob.
   */
  async uploadFile<T = any>(
    urlPath: string,
    filePath: string,
    fieldName = "file",
    extraFields?: Record<string, string>,
  ): Promise<ApiResponse<T>> {
    const buf = fs.readFileSync(filePath);
    const filename = path.basename(filePath);
    const blob = new Blob([buf]);

    const form = new FormData();
    form.append(fieldName, blob, filename);
    if (extraFields) {
      for (const [k, v] of Object.entries(extraFields)) {
        form.append(k, v);
      }
    }

    return this.request<T>("POST", urlPath, form);
  }

  // ── Session helpers ────────────────────────────────────────────────────────

  /** Log in as a broker (the default express-session auth) */
  async brokerLogin(username: string, password: string): Promise<ApiResponse> {
    return this.post("/api/login", { username, password });
  }

  /** Log in as a buyer (buyer-auth session) */
  async buyerLogin(email: string, password: string): Promise<ApiResponse> {
    return this.post("/api/buyer-auth/login", { email, password });
  }

  /** Clear stored cookies so subsequent requests are unauthenticated */
  clearSession(): void {
    this.jar.clear();
  }

  // ── Deals ──────────────────────────────────────────────────────────────────

  async createDeal(data: {
    businessName: string;
    industry?: string;
    description?: string;
    askingPrice?: string;
    phase?: string;
    [key: string]: unknown;
  }): Promise<ApiResponse> {
    return this.post("/api/deals", data);
  }

  async getDeal(id: string | number): Promise<ApiResponse> {
    return this.get(`/api/deals/${id}`);
  }

  async updateDeal(id: string | number, data: Record<string, unknown>): Promise<ApiResponse> {
    return this.patch(`/api/deals/${id}`, data);
  }

  async deleteDeal(id: string | number): Promise<ApiResponse> {
    return this.delete(`/api/deals/${id}`);
  }

  async listDeals(): Promise<ApiResponse> {
    return this.get("/api/deals");
  }

  // ── Documents ──────────────────────────────────────────────────────────────

  async uploadDocument(
    dealId: string | number,
    filePath: string,
    category?: string,
  ): Promise<ApiResponse> {
    const extras: Record<string, string> = {};
    if (category) extras.category = category;
    return this.uploadFile(`/api/deals/${dealId}/documents/upload`, filePath, "file", extras);
  }

  async listDocuments(dealId: string | number): Promise<ApiResponse> {
    return this.get(`/api/deals/${dealId}/documents`);
  }

  async parseDocument(documentId: string | number): Promise<ApiResponse> {
    return this.post(`/api/documents/${documentId}/parse`);
  }

  async getExtractedInfo(dealId: string | number): Promise<ApiResponse> {
    return this.get(`/api/deals/${dealId}/extracted-info`);
  }

  // ── Interview ──────────────────────────────────────────────────────────────

  async startInterview(dealId: string | number): Promise<ApiResponse> {
    return this.post(`/api/interview/${dealId}/start`);
  }

  async sendInterviewMessage(
    dealId: string | number,
    sessionId: string | number,
    message: string,
  ): Promise<ApiResponse> {
    return this.post(`/api/interview/${dealId}/message`, { sessionId, message });
  }

  async getInterviewHistory(sessionId: string | number): Promise<ApiResponse> {
    return this.get(`/api/interview/session/${sessionId}/history`);
  }

  // ── Financial analysis ─────────────────────────────────────────────────────

  async triggerFinancialAnalysis(dealId: string | number): Promise<ApiResponse> {
    return this.post(`/api/deals/${dealId}/financial-analysis`);
  }

  async getFinancialAnalysis(dealId: string | number): Promise<ApiResponse> {
    return this.get(`/api/deals/${dealId}/financial-analysis`);
  }

  async getFinancialAnalysisById(
    dealId: string | number,
    analysisId: string | number,
  ): Promise<ApiResponse> {
    return this.get(`/api/deals/${dealId}/financial-analysis/${analysisId}`);
  }

  async rerunFinancialAnalysis(
    dealId: string | number,
    analysisId: string | number,
  ): Promise<ApiResponse> {
    return this.post(`/api/deals/${dealId}/financial-analysis/${analysisId}/rerun`);
  }

  // ── Addback verification ───────────────────────────────────────────────────

  async createAddbackVerification(
    dealId: string | number,
    data: Record<string, unknown>,
  ): Promise<ApiResponse> {
    return this.post(`/api/deals/${dealId}/addback-verification`, data);
  }

  async getAddbackVerifications(dealId: string | number): Promise<ApiResponse> {
    return this.get(`/api/deals/${dealId}/addback-verification`);
  }

  // ── CIM layout / generation ────────────────────────────────────────────────

  async generateCimLayout(dealId: string | number): Promise<ApiResponse> {
    return this.post(`/api/deals/${dealId}/generate-layout`);
  }

  async getCimLayout(dealId: string | number): Promise<ApiResponse> {
    return this.get(`/api/deals/${dealId}/layout`);
  }

  async generateContent(dealId: string | number): Promise<ApiResponse> {
    return this.post(`/api/deals/${dealId}/generate-content`);
  }

  async generateBlindCim(dealId: string | number): Promise<ApiResponse> {
    return this.post(`/api/deals/${dealId}/generate-blind`);
  }

  async generateDdCim(dealId: string | number): Promise<ApiResponse> {
    return this.post(`/api/deals/${dealId}/generate-dd`);
  }

  async generateTeaser(dealId: string | number): Promise<ApiResponse> {
    return this.post(`/api/deals/${dealId}/generate-teaser`);
  }

  // ── CIM sections ──────────────────────────────────────────────────────────

  async getCimSections(dealId: string | number): Promise<ApiResponse> {
    return this.get(`/api/deals/${dealId}/cim-sections`);
  }

  async reorderCimSections(
    dealId: string | number,
    sectionIds: number[],
  ): Promise<ApiResponse> {
    return this.post(`/api/deals/${dealId}/cim-sections/reorder`, { sectionIds });
  }

  async updateCimSection(
    sectionId: string | number,
    data: Record<string, unknown>,
  ): Promise<ApiResponse> {
    return this.patch(`/api/cim-sections/${sectionId}`, data);
  }

  // ── Buyer matching ─────────────────────────────────────────────────────────

  async matchBuyers(dealId: string | number): Promise<ApiResponse> {
    return this.post(`/api/deals/${dealId}/match-buyers`);
  }

  async getSuggestedBuyers(dealId: string | number): Promise<ApiResponse> {
    return this.get(`/api/deals/${dealId}/suggested-buyers`);
  }

  // ── Broker buyer management ────────────────────────────────────────────────

  async listBrokerBuyers(): Promise<ApiResponse> {
    return this.get("/api/broker/buyers");
  }

  async getBrokerBuyer(buyerId: string | number): Promise<ApiResponse> {
    return this.get(`/api/broker/buyers/${buyerId}`);
  }

  async createBrokerBuyer(data: Record<string, unknown>): Promise<ApiResponse> {
    return this.post("/api/broker/buyers", data);
  }

  async importBuyersCSV(csvPath: string): Promise<ApiResponse> {
    return this.uploadFile("/api/broker/buyers/import-csv", csvPath, "file");
  }

  async updateBrokerBuyer(
    buyerId: string | number,
    data: Record<string, unknown>,
  ): Promise<ApiResponse> {
    return this.patch(`/api/broker/buyers/${buyerId}`, data);
  }

  // ── Buyer access ───────────────────────────────────────────────────────────

  async grantBuyerAccess(
    dealId: string | number,
    data: { email: string; name?: string; password?: string; [key: string]: unknown },
  ): Promise<ApiResponse> {
    return this.post(`/api/deals/${dealId}/buyers`, data);
  }

  async listBuyerAccess(dealId: string | number): Promise<ApiResponse> {
    return this.get(`/api/deals/${dealId}/buyers`);
  }

  async revokeBuyerAccess(accessId: string | number): Promise<ApiResponse> {
    return this.delete(`/api/buyer-access/${accessId}`);
  }

  // ── View room (token-based) ────────────────────────────────────────────────

  async getViewRoom(token: string): Promise<ApiResponse> {
    return this.get(`/api/view/${token}`);
  }

  async signNDA(token: string): Promise<ApiResponse> {
    return this.post(`/api/view/${token}/sign-nda`);
  }

  async submitDecision(
    token: string,
    decision: "interested" | "not_interested" | "need_more_time",
  ): Promise<ApiResponse> {
    return this.post(`/api/view/${token}/decision`, { decision });
  }

  async trackEvent(token: string, event: Record<string, unknown>): Promise<ApiResponse> {
    return this.post(`/api/buyer-access/${token}/events`, event);
  }

  // ── Buyer approvals (Firmex-style) ─────────────────────────────────────────

  async createBuyerApproval(
    dealId: string | number,
    data: Record<string, unknown>,
  ): Promise<ApiResponse> {
    return this.post(`/api/deals/${dealId}/buyer-approvals`, data);
  }

  async getBuyerApprovals(dealId: string | number): Promise<ApiResponse> {
    return this.get(`/api/deals/${dealId}/buyer-approvals`);
  }

  async brokerReviewApproval(
    approvalId: string | number,
    data: Record<string, unknown>,
  ): Promise<ApiResponse> {
    return this.post(`/api/buyer-approvals/${approvalId}/broker-review`, data);
  }

  // ── Buyer self-serve accounts ──────────────────────────────────────────────

  async createBuyerAccount(data: {
    email: string;
    password: string;
    name: string;
  }): Promise<ApiResponse> {
    return this.post("/api/buyer-auth/signup", data);
  }

  async getBuyerMe(): Promise<ApiResponse> {
    return this.get("/api/buyer-auth/me");
  }

  async updateBuyerProfile(data: Record<string, unknown>): Promise<ApiResponse> {
    return this.patch("/api/buyer-auth/me", data);
  }

  async getBuyerDashboard(): Promise<ApiResponse> {
    return this.get("/api/buyer-auth/dashboard");
  }

  // ── Branding ───────────────────────────────────────────────────────────────

  async getBranding(): Promise<ApiResponse> {
    return this.get("/api/branding");
  }

  async updateBranding(data: Record<string, unknown>): Promise<ApiResponse> {
    // POST for upsert if no branding exists, PATCH for updates
    const existing = await this.get("/api/branding");
    if (existing.data && existing.data.id) {
      return this.patch(`/api/branding/${existing.data.id}`, data);
    }
    return this.post("/api/branding", data);
  }

  // ── Web scraping ───────────────────────────────────────────────────────────

  async scrapeDeal(dealId: string | number, url?: string): Promise<ApiResponse> {
    return this.post(`/api/deals/${dealId}/scrape`, url ? { url } : {});
  }

  // ── Discrepancy check ──────────────────────────────────────────────────────

  async runDiscrepancyCheck(dealId: string | number): Promise<ApiResponse> {
    return this.post(`/api/deals/${dealId}/run-discrepancy-check`);
  }

  async getDiscrepancies(dealId: string | number): Promise<ApiResponse> {
    return this.get(`/api/deals/${dealId}/discrepancies`);
  }

  async resolveDiscrepancy(
    discrepancyId: string | number,
    data: Record<string, unknown>,
  ): Promise<ApiResponse> {
    return this.patch(`/api/discrepancies/${discrepancyId}`, data);
  }

  // ── Analytics ──────────────────────────────────────────────────────────────

  async getAnalytics(dealId: string | number): Promise<ApiResponse> {
    return this.get(`/api/deals/${dealId}/analytics`);
  }

  async getAnalyticsComputed(dealId: string | number): Promise<ApiResponse> {
    return this.get(`/api/deals/${dealId}/analytics/computed`);
  }

  async getAnalyticsSummary(dealId?: string | number): Promise<ApiResponse> {
    if (dealId) return this.get(`/api/deals/${dealId}/analytics/summary`);
    return this.get("/api/analytics/summary");
  }

  async getAnalyticsTimeline(dealId: string | number): Promise<ApiResponse> {
    return this.get(`/api/deals/${dealId}/analytics/timeline`);
  }

  async getBuyerScores(dealId: string | number): Promise<ApiResponse> {
    return this.get(`/api/deals/${dealId}/analytics/buyer-scores`);
  }

  async getDealsComparison(): Promise<ApiResponse> {
    return this.get("/api/analytics/deals-comparison");
  }

  async batchTrackEvents(
    dealId: string | number,
    events: Record<string, unknown>[],
  ): Promise<ApiResponse> {
    return this.post(`/api/deals/${dealId}/analytics/batch`, { events });
  }

  // ── Deal team / members ────────────────────────────────────────────────────

  async getTeamMembers(dealId: string | number): Promise<ApiResponse> {
    return this.get(`/api/deals/${dealId}/members`);
  }

  async getTeamMembersByType(
    dealId: string | number,
    teamType: string,
  ): Promise<ApiResponse> {
    return this.get(`/api/deals/${dealId}/members/${teamType}`);
  }

  async addTeamMember(
    dealId: string | number,
    data: {
      name: string;
      email: string;
      teamType: string;
      role: string;
      phone?: string;
      [key: string]: unknown;
    },
  ): Promise<ApiResponse> {
    return this.post(`/api/deals/${dealId}/members`, data);
  }

  async updateTeamMember(
    memberId: string | number,
    data: Record<string, unknown>,
  ): Promise<ApiResponse> {
    return this.patch(`/api/members/${memberId}`, data);
  }

  async removeTeamMember(memberId: string | number): Promise<ApiResponse> {
    return this.delete(`/api/members/${memberId}`);
  }

  // ── FAQ / Q&A ──────────────────────────────────────────────────────────────

  async createFaq(
    dealId: string | number,
    data: { question: string; answer: string; [key: string]: unknown },
  ): Promise<ApiResponse> {
    return this.post(`/api/deals/${dealId}/faq`, data);
  }

  async listFaq(dealId: string | number): Promise<ApiResponse> {
    return this.get(`/api/deals/${dealId}/faq`);
  }

  async updateFaq(faqId: string | number, data: Record<string, unknown>): Promise<ApiResponse> {
    return this.patch(`/api/faq/${faqId}`, data);
  }

  async deleteFaq(faqId: string | number): Promise<ApiResponse> {
    return this.delete(`/api/faq/${faqId}`);
  }

  // ── Buyer Q&A / questions ──────────────────────────────────────────────────

  async createQuestion(
    dealId: string | number,
    data: Record<string, unknown>,
  ): Promise<ApiResponse> {
    return this.post(`/api/deals/${dealId}/questions`, data);
  }

  async getQuestions(dealId: string | number): Promise<ApiResponse> {
    return this.get(`/api/deals/${dealId}/questions`);
  }

  async getPublishedQuestions(dealId: string | number): Promise<ApiResponse> {
    return this.get(`/api/deals/${dealId}/questions/published`);
  }

  async updateQuestion(
    questionId: string | number,
    data: Record<string, unknown>,
  ): Promise<ApiResponse> {
    return this.patch(`/api/questions/${questionId}`, data);
  }

  // ── Seller invites ─────────────────────────────────────────────────────────

  async createSellerInvite(
    dealId: string | number,
    data: Record<string, unknown>,
  ): Promise<ApiResponse> {
    return this.post(`/api/deals/${dealId}/invites`, data);
  }

  async getSellerInvite(token: string): Promise<ApiResponse> {
    return this.get(`/api/invites/${token}`);
  }

  // ── Outreach ───────────────────────────────────────────────────────────────

  async draftOutreach(
    dealId: string | number,
    data: Record<string, unknown>,
  ): Promise<ApiResponse> {
    return this.post(`/api/deals/${dealId}/draft-outreach`, data);
  }

  async sendOutreach(
    dealId: string | number,
    data: Record<string, unknown>,
  ): Promise<ApiResponse> {
    return this.post(`/api/deals/${dealId}/send-outreach`, data);
  }

  async getOutreachHistory(dealId: string | number): Promise<ApiResponse> {
    return this.get(`/api/deals/${dealId}/outreach-history`);
  }

  // ── Tasks ──────────────────────────────────────────────────────────────────

  async listTasks(dealId: string | number): Promise<ApiResponse> {
    return this.get(`/api/deals/${dealId}/tasks`);
  }

  async createTask(
    dealId: string | number,
    data: Record<string, unknown>,
  ): Promise<ApiResponse> {
    return this.post(`/api/deals/${dealId}/tasks`, data);
  }

  async updateTask(taskId: string | number, data: Record<string, unknown>): Promise<ApiResponse> {
    return this.patch(`/api/tasks/${taskId}`, data);
  }

  async deleteTask(taskId: string | number): Promise<ApiResponse> {
    return this.delete(`/api/tasks/${taskId}`);
  }

  // ── Notifications ──────────────────────────────────────────────────────────

  async getNotifications(dealId: string | number): Promise<ApiResponse> {
    return this.get(`/api/deals/${dealId}/notifications`);
  }

  async markNotificationRead(notificationId: string | number): Promise<ApiResponse> {
    return this.patch(`/api/notifications/${notificationId}/read`);
  }

  // ── Integrations ───────────────────────────────────────────────────────────

  async listIntegrations(): Promise<ApiResponse> {
    return this.get("/api/integrations");
  }

  async createIntegration(data: Record<string, unknown>): Promise<ApiResponse> {
    return this.post("/api/integrations", data);
  }

  // ── Logo upload ────────────────────────────────────────────────────────────

  async uploadLogo(filePath: string): Promise<ApiResponse> {
    return this.uploadFile("/api/upload-logo", filePath, "logo");
  }

  // ── Timing data ────────────────────────────────────────────────────────────

  getTimings() {
    return [...this.timings];
  }

  clearTimings(): void {
    this.timings = [];
  }

  getTimingSummary(): {
    totalRequests: number;
    totalTimeMs: number;
    avgTimeMs: number;
    slowest: { endpoint: string; ms: number } | null;
  } {
    const total = this.timings.reduce((sum, t) => sum + t.ms, 0);
    const sorted = [...this.timings].sort((a, b) => b.ms - a.ms);
    return {
      totalRequests: this.timings.length,
      totalTimeMs: total,
      avgTimeMs: this.timings.length > 0 ? Math.round(total / this.timings.length) : 0,
      slowest: sorted[0] ? { endpoint: `${sorted[0].method} ${sorted[0].endpoint}`, ms: sorted[0].ms } : null,
    };
  }
}

// ─── Standalone smoke test ───────────────────────────────────────────────────

if (process.argv[1] && process.argv[1].endsWith("api-client.ts")) {
  const url = process.argv[2] || "http://localhost:5000";
  console.log(`Smoke-testing ApiClient against ${url}...`);

  const client = new ApiClient({ baseUrl: url, verbose: true });

  (async () => {
    try {
      const health = await client.get("/api/deals");
      console.log(`\nGET /api/deals -> ${health.status} (${health.responseTime}ms)`);

      const summary = client.getTimingSummary();
      console.log("\nTiming summary:", JSON.stringify(summary, null, 2));
      console.log("\nSmoke test passed.");
    } catch (err: any) {
      console.error(`\nSmoke test failed: ${err.message}`);
      console.error("Is the server running at", url, "?");
      process.exit(1);
    }
  })();
}
