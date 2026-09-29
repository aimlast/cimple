// F2-DI-1: the financial analysis and the verification check decide on rows
// from a snapshot taken before a minutes-long model call. A row the broker
// resolved or routed to the seller meanwhile must never be superseded or
// rewritten by that run; two analysis runs on one deal must not overlap.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/f2-stale-snapshot.test.ts
import assert from "node:assert/strict";
import { storage } from "../../server/storage";
import {
  _persistFinancialDiscrepanciesForTests as persist,
  startFinancialAnalysis,
  isFinancialAnalysisRunning,
} from "../../server/financial/analyzer";
import { _setCheckModelForTests } from "../../server/cim/discrepancy-engine";
import { runAndPersistDiscrepancyCheck } from "../../server/cim/discrepancy-check";
import { updateDiscrepancyIfStill } from "../../server/cim/discrepancy-cas";

/** A store with the conditional write (same contract as DbStorage). */
function casStore(db: Record<string, any>, writes: any[]) {
  return {
    updateDiscrepancy: async (id: string, u: any) => { writes.push([id, u]); db[id] = { ...db[id], ...u }; return db[id]; },
    updateDiscrepancyIfStatus: async (id: string, statuses: readonly string[], u: any) => {
      if (!db[id] || !statuses.includes(db[id].status)) return undefined;
      writes.push([id, u]); db[id] = { ...db[id], ...u }; return db[id];
    },
    createDiscrepancy: async (r: any) => { const row = { id: `N${writes.length}`, createdAt: new Date(), ...r }; writes.push(["new", r]); db[row.id] = row; return row; },
  };
}

// ── 1. The analysis: the probe's scenario ──
{
  const db: Record<string, any> = {
    R: { id: "R", dealId: "d", field: "Revenue 2024", source: "financial_analysis", status: "resolved", resolvedValue: "$1,820,000", severity: "critical", interviewValue: "$2.3M — Interview", documentValue: "$1,820,000 — 2024 P&L", factKey: "revenueByYear", factYear: "2024", createdAt: new Date() },
    Q: { id: "Q", dealId: "d", field: "Owner salary", source: "financial_analysis", status: "ask_seller", severity: "significant", interviewValue: "$150,000 — Interview", documentValue: "$95,000 — 2024 P&L", factKey: "ownerSalary", createdAt: new Date() },
  };
  // What the run saw before its model call: both open.
  const snapshot = [{ ...db.R, status: "open", resolvedValue: null }, { ...db.Q, status: "open" }];
  const writes: any[] = [];
  await persist("d", casStore(db, writes) as any, [], ["R", "Q"], {}, snapshot as any, {}, undefined, {}, null);
  assert.deepEqual(writes, [], "nothing is written to rows settled or routed during the run");
  assert.equal(db.R.status, "resolved");
  assert.equal(db.R.resolvedValue, "$1,820,000");
  assert.equal(db.Q.status, "ask_seller");

  // A refreshed finding for a row resolved meanwhile: its sides stay as resolved, and no duplicate row is raised.
  const w2: any[] = [];
  const item = {
    field: "Revenue 2024", factKey: "revenueByYear", factYear: "2024", severity: "critical", category: "financial",
    sourceA: { source: "Interview", value: "$2.4M" }, sourceB: { source: "2024 P&L", value: "$1,820,000" },
    explanation: "x", suggestedResolution: "y", existingId: "R",
  };
  await persist("d", casStore(db, w2) as any, [item as any], [], {}, snapshot as any, {}, undefined, {}, null);
  assert.deepEqual(w2, [], "the resolved row is not rewritten and no new row replaces it");
  assert.equal(db.R.interviewValue, "$2.3M — Interview");

  // Control: a row still open as the run saw it is superseded as before.
  const db3: Record<string, any> = { O: { ...db.Q, id: "O", status: "open" } };
  const w3: any[] = [];
  await persist("d", casStore(db3, w3) as any, [], ["O"], {}, [{ ...db3.O }] as any, {}, undefined, {}, null);
  assert.equal(db3.O.status, "superseded", "an untouched open row the run cleared still closes");
  console.log("✓ analysis: rows resolved / routed during the run are neither superseded nor rewritten");
}

// ── 2. The helper on a store that only re-reads ──
{
  const db: Record<string, any> = { A: { id: "A", status: "resolved" } };
  const writes: any[] = [];
  const store = {
    getDiscrepancy: async (id: string) => db[id],
    updateDiscrepancy: async (id: string, u: any) => { writes.push(id); return Object.assign(db[id], u); },
  };
  assert.equal(await updateDiscrepancyIfStill(store as any, "A", ["open"], { status: "superseded" }), undefined);
  assert.deepEqual(writes, []);
  db.A.status = "open";
  assert.ok(await updateDiscrepancyIfStill(store as any, "A", ["open"], { status: "superseded" }));
  assert.equal(db.A.status, "superseded");
  console.log("✓ helper: re-read fallback writes only while the status holds");
}

// ── 3. The verification check: the broker acts during the model call ──
{
  const dealId = "deal-stale";
  const deal: any = {
    id: dealId, brokerId: "b1", businessName: "Probe Co", industry: "Distribution",
    extractedInfo: {
      revenueByYear: { "2024": "$2,300,000" },
      employeeCount: "24",
      _fieldSources: { revenueByYear: { source: "interview", years: { "2024": { source: "interview" } } }, employeeCount: { source: "interview" } },
    },
    discrepancyCheckedAt: null, discrepancyCheckSources: null,
  };
  const docs: any[] = [
    { id: "fs", name: "FY2024 Financial Statements", category: "financials", sourceKind: "document", visibility: "shared", isProcessed: true, extractedText: "Revenue 2024 1,820,000. Employees 22.", extractedData: null },
  ];
  const C1 = "00000001-0000-0000-0000-000000000000";
  const C2 = "00000002-0000-0000-0000-000000000000";
  const rows: any[] = [
    { id: C1, dealId, source: "interview", status: "open", severity: "critical", category: "financial", field: "FY2024 revenue", factKey: "revenueByYear", factYear: "2024", interviewValue: "$2.3 million", documentValue: "$1,820,000", documentId: "fs", documentName: "FY2024 Financial Statements", createdAt: new Date("2026-09-20"), resolvedValue: null },
    { id: C2, dealId, source: "interview", status: "open", severity: "significant", category: "operational", field: "Employees", factKey: "employeeCount", interviewValue: "24", documentValue: "22", documentId: "fs", documentName: "FY2024 Financial Statements", createdAt: new Date("2026-09-20"), resolvedValue: null },
  ];
  const writes: any[] = [];
  const s = storage as any;
  s.getDeal = async () => ({ ...deal });
  s.getDocumentsByDeal = async () => docs;
  s.getDiscrepanciesByDeal = async () => rows.map((r) => ({ ...r }));
  s.createDiscrepancy = async (data: any) => { const r = { id: `new-${rows.length + 1}`, createdAt: new Date(), ...data }; rows.push(r); writes.push(["new", data.field]); return r; };
  s.updateDiscrepancy = async (id: string, u: any) => { writes.push([id, u]); return Object.assign(rows.find((r) => r.id === id), u); };
  s.updateDiscrepancyIfStatus = async (id: string, st: readonly string[], u: any) => {
    const r = rows.find((x) => x.id === id);
    if (!r || !st.includes(r.status)) return undefined;
    writes.push([id, u]);
    return Object.assign(r, u);
  };
  s.updateDeal = async (_id: string, u: any) => Object.assign(deal, u);
  s.getDeal = async () => ({ ...deal });

  _setCheckModelForTests(async (_system, user) => {
    // While the model "thinks", the broker resolves the revenue row and routes the employee row.
    Object.assign(rows[0], { status: "resolved", resolvedValue: "$1,820,000" });
    Object.assign(rows[1], { status: "ask_seller" });
    const ref = (label: string) => user.match(new RegExp(`- (S\\d+): [^\\n]*${label}`))?.[1];
    return {
      discrepancies: [{
        field: "FY2024 revenue", factKey: "revenueByYear", factYear: "2024",
        claimValue: "$2.3 million", claimSource: ref("nterview"),
        evidenceValue: "$1,820,000", evidenceSource: ref("Financial Statements"),
        severity: "critical", category: "financial",
        explanation: "The seller said $2.3M; the statements show $1.82M.", suggestedResolution: "Confirm.",
        existingId: C1,
      }],
      clearedIds: [C2],
    };
  });
  await runAndPersistDiscrepancyCheck(dealId);
  _setCheckModelForTests(null);
  assert.equal(rows[0].status, "resolved", "the resolution made during the check stands");
  assert.equal(rows[0].resolvedValue, "$1,820,000");
  assert.equal(rows[1].status, "ask_seller", "the routing made during the check stands");
  assert.deepEqual(writes.filter((w) => w[0] === C1 || w[0] === C2), [], "neither row was rewritten");
  assert.equal(rows.length, 2, "no duplicate row was raised for the resolved dispute");
  console.log("✓ check: rows resolved / routed during the model call are left as the broker left them");
}

// ── 4. One analysis per deal at a time ──
{
  const s: any = {
    getFinancialAnalysesByDeal: async () => [],
    createFinancialAnalysis: async (d: any) => ({ id: `fa-${Math.random()}`, ...d }),
  };
  let finish!: () => void;
  const run = (() => new Promise<string>((resolve) => { finish = () => resolve("x"); })) as any;
  const first = await startFinancialAnalysis("deal-x", s, run);
  assert.ok(first.id);
  assert.equal(isFinancialAnalysisRunning("deal-x"), true);
  await assert.rejects(() => startFinancialAnalysis("deal-x", s, run), (e: any) => e.status === 409, "a second run while one runs is refused (409)");
  // Another deal is independent.
  const other = await startFinancialAnalysis("deal-y", s, (async () => "y") as any);
  assert.ok(other.id);
  finish();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(isFinancialAnalysisRunning("deal-x"), false, "the deal is free once the run finishes");
  const again = await startFinancialAnalysis("deal-x", s, (async () => { throw new Error("boom"); }) as any);
  assert.ok(again.id);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(isFinancialAnalysisRunning("deal-x"), false, "a failed run frees the deal too");
  console.log("✓ analysis: one run per deal at a time");
}

console.log("f2-stale-snapshot: all passed");
process.exit(0);
