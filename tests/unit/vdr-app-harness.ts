/**
 * A small Express app running the data room's broker and buyer routes on an
 * in-memory store (tests only). No database, no AI, no email. The caller
 * sets UPLOADS_DIR before importing.
 */
import express from "express";
import { fakeVdrStore } from "./vdr-fake-store";
import { registerDataRoomRoutes } from "../../server/routes/data-room";
import { registerDataRoomBuyerRoutes } from "../../server/routes/data-room-buyer";

export async function vdrTestApp(i: {
  root: string;
  docs: any[];
  deals: any[];
  access: any[];
  now: Date;
  pool?: any;
  ddCited?: (dealId: string) => Promise<string[] | null>;
}) {
  const f = fakeVdrStore({ documents: i.docs });
  const deals = new Map(i.deals.map((d) => [d.id, d]));
  const getDeal = async (id: string) => deals.get(id);
  const accessRowsForDeal = async (dealId: string) => i.access.filter((a) => a.dealId === dealId).map((a) => ({ ...a }));
  const setupDeps = { store: f.store, enqueue: () => {}, now: () => i.now };
  const pool = i.pool ?? { run: async (job: any) => { if (job.kind === "composite") return { jpeg: new Uint8Array([0xff, 0xd8, 0xff]), width: 1, height: 1 }; throw new Error(`no ${job.kind}`); } };
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.session = { brokerId: req.get("x-test-broker") || undefined }; next(); });
  registerDataRoomRoutes(app as any, {
    store: f.store,
    getDeal,
    accessRowsForDeal,
    requirementsForDeal: async () => [],
    brokerName: async () => "Morgan",
    brand: async () => ({ firmName: "Brassline", logoUrl: null }),
    ddCited: i.ddCited ?? (async () => null),
    setup: () => setupDeps,
    serve: () => ({ pool, root: i.root }),
    root: () => i.root,
    now: () => i.now,
  });
  registerDataRoomBuyerRoutes(app as any, {
    store: f.store,
    accessByToken: async (t: string) => i.access.find((a) => a.accessToken === t),
    accessRowsForDeal,
    getDeal,
    now: () => i.now,
    root: i.root,
    serve: { pool, root: i.root },
    brand: async () => ({ firmName: "Brassline", logoUrl: null }),
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const call = async (method: string, p: string, body?: unknown, broker?: string) => {
    const r = await fetch(base + p, { method, headers: { "content-type": "application/json", ...(broker ? { "x-test-broker": broker } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* binary */ }
    return { status: r.status, json, text, headers: r.headers };
  };
  return { f, call, base, setupDeps, close: () => server.close() };
}
