/**
 * A fictional deal for the add-back tests: "Brightwater Plumbing & Heating
 * Ltd." with a financial analysis whose add-backs are planted in the sample
 * ledgers (scripts/make-sample-gl.ts), its statements (the answer key's), and
 * helpers to read a ledger into the memory store. No database, no AI.
 */
import fs from "node:fs";
import { fixture } from "./_harness";
import { storage } from "../../server/storage";
import { fakeWorld, fakeDeal, type FakeWorld } from "./_fake-storage";
import { ingestDocument } from "../../server/documents/ingest";
import { _setGlIngestDepsForTests, glQueueIdle } from "../../server/gl/ingest";
import { _setExtractionClientForTests } from "../../server/documents/extractor";
import type { Deal, Document } from "../../shared/schema";
const key = JSON.parse(fs.readFileSync(fixture("answer-key.json"), "utf8"));

const ST = (key as any).statements as Record<string, { revenue: number; netIncome: number; amortization: number; incomeTax: number }>;
const d = (cents: number) => Math.round(cents) / 100;

/** The analysis's normalization (dollars, like production). */
export function brightwaterNormalization() {
  return {
    metric: "sde",
    years: ["2022", "2023", "2024"],
    netIncome: Object.fromEntries(Object.entries(ST).map(([y, s]) => [y, d(s.netIncome)])),
    addbacks: [
      { id: "ab_1", type: "ebitda", label: "Owner compensation (President - Dan Brightwater)", amounts: { "2022": 130000, "2023": 130000, "2024": 130000 }, approved: true, category: "owner_comp", ownerCompPart: "excess", marketSalary: 110000, ownerActualComp: { "2022": 240000, "2023": 240000, "2024": 240000 }, description: "Owner's pay less a market salary." },
      { id: "ab_1_market", type: "sde", label: "Owner compensation (President - Dan Brightwater) — market salary", amounts: { "2022": 110000, "2023": 110000, "2024": 110000 }, approved: true, category: "owner_comp", ownerCompPart: "market" },
      { id: "ab_2", label: "Related party salary - Emma Brightwater (spouse)", amounts: { "2022": 85000, "2023": 85000, "2024": 85000 }, approved: true, category: "discretionary", description: "Spouse paid for light admin work; no replacement needed." },
      { id: "ab_3", label: "Owner vehicle expenses", amounts: { "2022": 24000, "2023": 26000, "2024": 27840 }, approved: true, category: "discretionary", description: "Lexus lease, fuel and insurance for the owner's vehicle." },
      { id: "ab_4", label: "Meals & entertainment (50% personal use estimate)", amounts: { "2022": 9000, "2023": 10000, "2024": 11000 }, approved: true, category: "discretionary", description: "Half of meals are personal. Per an email from Denise." },
      { id: "ab_5", label: "Excess insurance (owner life insurance)", amounts: { "2022": 9000, "2023": 9000, "2024": 9000 }, approved: true, category: "discretionary", privateEvidence: true, approvedOverride: true, description: "The owner's life insurance policy." },
      { id: "ab_6", label: "Golf club dues", amounts: { "2022": 15000, "2023": 15000, "2024": 15000 }, approved: true, category: "discretionary", description: "Glen Abbey membership." },
      { id: "ab_7", label: "Employment settlement (one-time)", amounts: { "2022": 0, "2023": 0, "2024": 22000 }, approved: true, category: "one_time", description: "Wrongful dismissal settled July 2024." },
      { id: "ab_8", label: "Depreciation & amortization", amounts: Object.fromEntries(Object.entries(ST).map(([y, s]) => [y, d(s.amortization)])), approved: true, category: "other" },
      { id: "ab_9", label: "Interest expense", amounts: { "2022": 5000, "2023": 5000, "2024": 5000 }, approved: true, category: "other" },
      { id: "ab_10", label: "Dividends paid", amounts: { "2022": 50000 }, approved: true, category: "other", description: "Dividends." },
      { id: "ab_11", label: "Rejected thing", amounts: { "2024": 1000 }, approved: false, category: "discretionary" },
    ],
  };
}

export function brightwaterPnl() {
  const years = ["2022", "2023", "2024"];
  const by = (f: (s: (typeof ST)[string]) => number) => Object.fromEntries(years.map((y) => [y, d(f(ST[y]))]));
  return {
    years,
    rows: [
      { id: "r1", name: "Sales", category: "Revenue", values: by((s) => s.revenue) },
      { id: "r2", name: "Amortization", category: "Depreciation", values: by((s) => s.amortization) },
      { id: "r3", name: "Income taxes", category: "Taxes", values: by((s) => s.incomeTax) },
    ],
  };
}

export interface Brightwater {
  w: FakeWorld;
  deal: Deal;
  analysis: Record<string, any>;
  /** Uploads + reads a fixture as a ledger (seller-uploaded, shared by default). */
  readLedger(file: string, over?: Partial<Document>): Promise<Document>;
}

export function brightwater(over: Partial<Deal> = {}): Brightwater {
  _setExtractionClientForTests({ messages: { create: async () => { throw new Error("no AI in tests"); } } } as any);
  const w = fakeWorld();
  _setGlIngestDepsForTests({ now: () => new Date("2025-03-01T12:00:00Z") });
  const deal = fakeDeal(w, { location: "Burlington, Ontario", extractedInfo: { ownerName: "Dan Brightwater" }, ...over } as any);
  const analysis: Record<string, any> = {
    id: "fa-1", dealId: deal.id, version: 1, status: "completed", updatedAt: new Date("2025-02-01T00:00:00Z"),
    normalization: brightwaterNormalization(), reclassifiedPnl: brightwaterPnl(),
  };
  (globalThis as any).__glAnalyses = [analysis];
  const s = storage as any;
  s.getFinancialAnalysesByDeal = async (id: string) => (id === deal.id ? (globalThis as any).__glAnalyses : []);
  s.getSellerInvitesByDealId = async (id: string) => w.invites.filter((i) => i.dealId === id);
  s.getDealMember = async (id: string) => w.members.find((m) => m.id === id);
  s.updateDealMember = async (id: string, patch: any) => { const m = w.members.find((x) => x.id === id); if (m) Object.assign(m, patch); return m; };
  s.deleteDealMember = async (id: string) => { w.members = w.members.filter((m) => m.id !== id); };
  s.createDealMember = async (data: any) => { const m = { id: `mem-${w.members.length + 1}`, createdAt: new Date(), ...data }; w.members.push(m); return m; };
  s.getUser = async () => ({ id: "broker-1", name: "Morgan Ellis", email: "broker@brokerage.invalid" });
  s.createNotification = async () => ({});
  return {
    w,
    deal,
    analysis,
    async readLedger(file, docOver = {}) {
      const doc = w.addDocument({ dealId: deal.id, fileUrl: w.addFile(fixture(file), file), name: file, originalName: file, subcategory: "general_ledger", uploadedBy: "seller", ...docOver } as any);
      await ingestDocument(doc.id);
      await glQueueIdle();
      return doc;
    },
  };
}
