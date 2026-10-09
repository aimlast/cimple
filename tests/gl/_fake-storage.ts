/**
 * An in-memory stand-in for the parts of `storage` the ledger reader and
 * the GL routes use (tests only; no database). Patches the real storage
 * instance's methods and the gl store, and puts uploaded files in a temp
 * UPLOADS_DIR so resolveDocumentPath finds them.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { storage } from "../../server/storage";
import { memoryStore, _setGlStoreForTests } from "../../server/gl/store";
import type { Deal, DealDocumentRequirement, DealMember, Document, SellerInvite } from "../../shared/schema";

export interface FakeWorld {
  root: string;
  deals: Map<string, Deal>;
  documents: Map<string, Document>;
  requirements: DealDocumentRequirement[];
  members: DealMember[];
  invites: SellerInvite[];
  gl: ReturnType<typeof memoryStore>;
  addFile(fixturePath: string, name?: string): string;
  addDocument(doc: Partial<Document> & { dealId: string; fileUrl: string }): Document;
}

let n = 0;
const id = (p: string) => `${p}-${(++n).toString(36)}`;

export function fakeWorld(): FakeWorld {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gl-world-"));
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  process.env.UPLOADS_DIR = root;
  const w: FakeWorld = {
    root,
    deals: new Map(),
    documents: new Map(),
    requirements: [],
    members: [],
    invites: [],
    gl: memoryStore(),
    addFile(fixturePath, name) {
      const fileName = `doc_${(++n).toString(16).padStart(32, "0")}${path.extname(name ?? fixturePath)}`;
      fs.copyFileSync(fixturePath, path.join(root, "docs", fileName));
      return `/uploads/docs/${fileName}`;
    },
    addDocument(doc) {
      const now = new Date();
      const row = {
        id: id("doc"), uploadedBy: "broker", name: "file", originalName: "file", category: "other", subcategory: null,
        fileSize: null, mimeType: null, isProcessed: false, extractedText: null, extractedData: null, status: "pending",
        isRequired: false, promisedAt: null, sourceKind: "document", sourceMeta: null, visibility: "shared",
        createdAt: now, updatedAt: now, ...doc,
      } as Document;
      w.documents.set(row.id, row);
      return row;
    },
  };
  _setGlStoreForTests(w.gl);
  const s = storage as any;
  s.getDeal = async (dealId: string) => w.deals.get(dealId);
  s.getDocument = async (docId: string) => w.documents.get(docId);
  s.getDocumentsByDeal = async (dealId: string) => Array.from(w.documents.values()).filter((d) => d.dealId === dealId);
  s.getDocumentsByFileUrl = async (u: string) => Array.from(w.documents.values()).filter((d) => d.fileUrl === u);
  s.updateDocument = async (docId: string, patch: Partial<Document>) => {
    const d = w.documents.get(docId);
    if (!d) return undefined;
    Object.assign(d, patch, { updatedAt: new Date() });
    return d;
  };
  s.createDocument = async (doc: Partial<Document> & { dealId: string; fileUrl: string }) => w.addDocument(doc);
  s.deleteDocument = async (docId: string) => { w.documents.delete(docId); };
  s.getDocumentRequirementsByDeal = async (dealId: string) => w.requirements.filter((r) => r.dealId === dealId);
  s.getDocumentRequirement = async (rid: string) => w.requirements.find((r) => r.id === rid);
  s.createDocumentRequirement = async (data: Partial<DealDocumentRequirement>) => {
    const row = { id: id("req"), notes: null, uploadedFileId: null, uploadedBy: null, uploadedAt: null, sortOrder: 0, createdAt: new Date(), ...data } as DealDocumentRequirement;
    w.requirements.push(row);
    return row;
  };
  s.updateDocumentRequirement = async (rid: string, patch: Partial<DealDocumentRequirement>) => {
    const r = w.requirements.find((x) => x.id === rid);
    if (!r) return undefined;
    Object.assign(r, patch);
    return r;
  };
  s.getDealMembers = async (dealId: string) => w.members.filter((m) => m.dealId === dealId);
  s.getSellerInviteByToken = async (t: string) => w.invites.find((i) => i.token === t);
  s.getFinancialAnalysesByDeal = async () => [];
  return w;
}

export function fakeDeal(w: FakeWorld, over: Partial<Deal> = {}): Deal {
  const deal = { id: id("deal"), brokerId: "broker-1", businessName: "Brightwater Plumbing & Heating Ltd.", extractedInfo: {}, demoKey: "test", ...over } as Deal;
  w.deals.set(deal.id, deal);
  return deal;
}

export function cleanup(w: FakeWorld): void {
  _setGlStoreForTests(null);
  fs.rmSync(w.root, { recursive: true, force: true });
}
