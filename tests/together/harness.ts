/**
 * In-memory world for live-filing tests (specs/together.md §11.2–§11.4): the
 * deal, its documents, discrepancies, marks and sittings live in memory;
 * every model call and every outbound fetch fails the test; the database is
 * never reached. Import this FIRST (it sets the environment).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";

process.env.DISABLE_SCHEDULERS = "1";
process.env.NODE_ENV = "test";
process.env.ANTHROPIC_API_KEY = "disabled";
process.env.UPLOADS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "together-capture-"));
delete process.env.RESEND_API_KEY;

export const counters = { modelCalls: 0 };
const proto = (Anthropic as any).Messages.prototype;
proto.create = function () { counters.modelCalls++; throw new Error("test: a model was called"); };
proto.stream = function () { counters.modelCalls++; throw new Error("test: a model was called"); };
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  const u = String(url);
  if (u.startsWith("http://127.0.0.1:")) return realFetch(url, init);
  throw new Error(`test: blocked outbound fetch to ${u}`);
}) as any;

export interface World {
  deals: Record<string, any>;
  documents: any[];
  discrepancies: any[];
  marks: any[];
  users: Record<string, any>;
  invites: any[];
  requirements: any[];
  sessions: any[];
}

export function newWorld(): World {
  return { deals: {}, documents: [], discrepancies: [], marks: [], users: { B1: { id: "B1", name: "Morgan Ellis", email: "morgan@brokerage.invalid" } }, invites: [], requirements: [], sessions: [] };
}

/** Installs the world into storage, db, the marks store and the together store. Returns the together store. */
export async function install(w: World) {
  const { storage } = await import("../../server/storage");
  const { db } = await import("../../server/db");
  const { _setMarksStoreForTests } = await import("../../server/together/marks");
  const { _setTogetherStoreForTests, memoryTogetherStore } = await import("../../server/together/store");
  const S = storage as any;
  let docId = 0;
  let discId = 0;
  Object.assign(S, {
    getDeal: async (id: string) => (w.deals[id] ? structuredClone(w.deals[id]) : undefined),
    updateDeal: async (id: string, patch: any) => { w.deals[id] = { ...w.deals[id], ...structuredClone(patch) }; return structuredClone(w.deals[id]); },
    getUser: async (id: string) => w.users[id],
    getSellerInviteByToken: async (t: string) => w.invites.find((i) => i.token === t),
    getSellerInvitesByDealId: async (id: string) => w.invites.filter((i) => i.dealId === id),
    getDiscrepanciesByDeal: async (id: string) => structuredClone(w.discrepancies.filter((d) => d.dealId === id)),
    getResolvedDiscrepancies: async (id: string) => structuredClone(w.discrepancies.filter((d) => d.dealId === id && d.status === "resolved")),
    createDiscrepancy: async (d: any) => { const row = { id: `X${++discId}`, createdAt: new Date(), status: "open", ...d }; w.discrepancies.push(row); return structuredClone(row); },
    updateDiscrepancy: async (id: string, patch: any) => { const d = w.discrepancies.find((x) => x.id === id); if (d) Object.assign(d, patch); return d ? structuredClone(d) : undefined; },
    getDocumentRequirementsByDeal: async (id: string) => w.requirements.filter((r) => r.dealId === id),
    getDocumentsByDeal: async (id: string) => structuredClone(w.documents.filter((d) => d.dealId === id)),
    getDocumentsByFileUrl: async (u: string) => structuredClone(w.documents.filter((d) => d.fileUrl === u)),
    getTasksByDeal: async () => [],
    createTask: async (t: any) => t,
    createDocument: async (d: any) => { const row = { id: `DOC${++docId}`, createdAt: new Date(), updatedAt: new Date(), ...d }; w.documents.push(row); return structuredClone(row); },
    getDocument: async (id: string) => structuredClone(w.documents.find((d) => d.id === id)),
    updateDocument: async (id: string, patch: any) => { const d = w.documents.find((x) => x.id === id); if (!d) return undefined; Object.assign(d, structuredClone(patch)); return structuredClone(d); },
    deleteDocument: async (id: string) => { const i = w.documents.findIndex((d) => d.id === id); if (i >= 0) w.documents.splice(i, 1); return true; },
  });
  (db as any).select = () => {
    let table: any = null;
    const chain: any = {
      from(t: any) { table = t; return chain; },
      where() { return chain; },
      orderBy() { return chain; },
      limit() { return chain; },
      then(res: any, rej: any) {
        const name = table?.[Symbol.for("drizzle:Name")];
        const rows = name === "documents" ? structuredClone(w.documents) : name === "interview_sessions" ? structuredClone(w.sessions) : [];
        return Promise.resolve(rows).then(res, rej);
      },
    };
    return chain;
  };
  (db as any).selectDistinct = () => ({ from: () => ({ where: async () => [] }) });
  _setMarksStoreForTests({
    active: async (dealId) => w.marks.filter((m) => m.dealId === dealId && !m.clearedAt),
    insert: async (row) => { const r = { id: `M${w.marks.length + 1}`, createdAt: new Date(), clearedAt: null, ...row }; w.marks.push(r); return r as any; },
    clear: async (dealId, itemId, kind) => {
      let n = 0;
      for (const m of w.marks) if (m.dealId === dealId && m.itemId === itemId && m.kind === kind && !m.clearedAt) { m.clearedAt = new Date(); n++; }
      return n;
    },
  });
  const store = memoryTogetherStore();
  _setTogetherStoreForTests(store);
  return store;
}

/** A small fictional deal (Lakeshore-like): statements' revenue on file, a CRM lead, a keep-out entry. */
export function lakeshoreDeal(id = "D1"): any {
  return {
    id,
    brokerId: "B1",
    businessName: "Lakeshore Home Comfort Ltd.",
    industry: "HVAC",
    subIndustry: null,
    location: "Barrie, Ontario",
    askingPrice: null,
    phase: "phase1_info_collection",
    interviewPlan: null,
    interviewOutline: null,
    sectionImportance: null,
    interviewEvidence: null,
    demoKey: "lakeshore-qa",
    interviewCompleted: false,
    extractedInfo: {
      annualRevenue: "$4,812,300",
      reasonForSale: "Retiring after 30 years",
      ownerName: "Tony Moretti",
      retentionPlan: "Dave K. - retention plan needed",
      customerConcentration: "Largest customer about 20% (from the CRM)",
      _fieldSources: {
        annualRevenue: { source: "document", documentId: "STMT" },
        reasonForSale: { source: "interview" },
        ownerName: { source: "interview" },
        retentionPlan: { source: "crm", documentId: "CRM1", brokerOnly: true },
        customerConcentration: { source: "crm", documentId: "CRM1", brokerOnly: true },
      },
      _sellerKeepOut: [{ detail: "Dave's divorce settlement", terms: ["divorce"] }],
    },
  };
}

export function statementDoc(dealId = "D1"): any {
  return { id: "STMT", dealId, name: "2024 Compilation.pdf", visibility: "shared", sourceKind: "document", category: "financials", subcategory: "income_statement", sourceMeta: { periodEnd: "2024-12-31" }, createdAt: new Date("2025-02-01"), extractedData: { annualRevenue: "$4,812,300" }, fileUrl: null };
}

export async function waitFor(cond: () => boolean | Promise<boolean>, ms = 4000, label = "condition"): Promise<void> {
  const until = Date.now() + ms;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > until) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
