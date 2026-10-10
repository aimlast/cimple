/**
 * gl spec §6.7 (pass 3) on a real Express app (memory store, no database,
 * no AI, no email): what buyers see about the add-backs —
 *   broker: the publish dialog's data, "Show to buyers" (refused until the
 *   review is done; allowlisted body), the evidence a buyer would get per
 *   version, "{k} changes since", "Stop showing it to buyers";
 *   buyer: "Ask about this entry" (due diligence only, the view room's
 *   gates, a private question to the broker, never a withheld name).
 */
import assert from "node:assert/strict";
import { test, done } from "./_harness";
import { cleanup } from "./_fake-storage";
import { brightwater } from "./_brightwater";
import { applyGlRateLimits, registerGlRoutes } from "../../server/routes/gl";
import { storage } from "../../server/storage";
import { buyerCimExtras } from "../../server/cim/buyer-extras";
import { buildBuyerCim } from "../../shared/cim-buyer-view";
import type { GlTieOutYear } from "../../shared/gl-types";

const express = (await import("express")).default;
const B = brightwater({ brokerId: "b1", isLive: true, ndaRequired: false } as any);
const w = B.w;
const deal = B.deal;
await B.readLedger("qbo-classic.csv");

const s = storage as any;
const accesses = [
  { id: "a-dd", dealId: deal.id, accessToken: "tok-dd", accessLevel: "due_diligence", ndaSigned: true, revokedAt: null, expiresAt: null },
  { id: "a-blind", dealId: deal.id, accessToken: "tok-blind", accessLevel: "blind", ndaSigned: true, revokedAt: null, expiresAt: null },
  { id: "a-teaser", dealId: deal.id, accessToken: "tok-teaser", accessLevel: "teaser_only", ndaSigned: false, revokedAt: null, expiresAt: null },
];
s.getBuyerAccessByToken = async (t: string) => accesses.find((a) => a.accessToken === t);
const questions: any[] = [];
s.createBuyerQuestion = async (q: any) => { const row = { id: `q${questions.length + 1}`, ...q }; questions.push(row); return row; };
s.getDealMembers = async () => [];

let sessionBroker: string | undefined = "b1";
const app = express();
app.use(express.json());
app.use((req, _res, next) => { (req as any).session = { brokerId: sessionBroker }; next(); });
applyGlRateLimits(app);
registerGlRoutes(app);
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
const call = async (method: string, url: string, body?: unknown) => {
  const r = await fetch(base + url, { method, headers: body !== undefined ? { "Content-Type": "application/json" } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) as any };
};
const D = `/api/deals/${deal.id}/gl`;

let panel = (await call("GET", D)).json;

await test("before the review: the dialog says what's left; publishing is refused", async () => {
  const p = (await call("GET", `${D}/publish-preview`)).json;
  assert.equal(p.canPublish, false);
  assert.match(p.blocked, /Finish 'Add-backs in the books' first/);
  const r = await call("POST", `${D}/publish`, { versions: { dd: true, normal: false, blind: false }, leaveOut: [] });
  assert.equal(r.status, 409);
});

// The broker ticks what Cimple found and reviews everything.
for (const t of panel.traces.filter((x: any) => x.proof !== "statement")) {
  await call("POST", `${D}/traces/${t.id}/confirm-summary`);
}
for (const t of (await call("GET", D)).json.traces.filter((x: any) => x.proof !== "statement")) {
  await call("POST", `${D}/traces/${t.id}/review`, { verdict: t.computed?.suggestedVerdict ?? "not_found" });
}
await w.gl.updateTracing(deal.id, { tieOut: { "2022": { state: "agrees" }, "2023": { state: "agrees" }, "2024": { state: "agrees" } } as Record<string, GlTieOutYear> } as any);
panel = (await call("GET", D)).json;

await test("the dialog: can publish now; notes and lines; bodies are allowlisted", async () => {
  const p = (await call("GET", `${D}/publish-preview`)).json;
  assert.equal(p.canPublish, true, p.blocked);
  assert.ok(p.lines.length > 0 && p.lines.every((l: any) => typeof l.key === "string" && Array.isArray(l.years)));
  assert.ok(p.agreeYears.includes("2024"));
  assert.equal((await call("POST", `${D}/publish`, { versions: { dd: true, normal: true, blind: true }, leaveOut: [], published: {} })).status, 400);
  assert.equal((await call("POST", `${D}/publish`, { versions: { dd: "yes" }, leaveOut: [] })).status, 400);
  assert.equal((await call("POST", `${D}/publish`, { versions: { dd: false, normal: false, blind: false }, leaveOut: [] })).status, 409);
});

await test("Show to buyers: saved; the panel's Buyers cell knows; the evidence per version", async () => {
  const r = await call("POST", `${D}/publish`, { versions: { dd: true, normal: true, blind: true }, leaveOut: ["golf club dues"] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const p2 = (await call("GET", D)).json;
  assert.ok(p2.buyers.publishedAt);
  assert.deepEqual(p2.buyers.changes, []);
  const dd = (await call("GET", `${D}/evidence?mode=dd&source=published`)).json;
  assert.equal(dd.payload.mode, "dd");
  assert.ok(!dd.payload.lines.some((l: any) => /golf/i.test(l.label)), "left out");
  const blind = (await call("GET", `${D}/evidence?mode=blind&source=published`)).json;
  assert.ok(blind.payload.note);
  const prev = (await call("GET", `${D}/evidence?mode=dd&source=preview`)).json;
  assert.equal(prev.payload.preview, undefined, "published → the preview shows what buyers see");
  assert.equal((await call("GET", `${D}/evidence?mode=nope`)).status, 400);
});

await test("buyer paths get the page / the note through buyerCimExtras; the teaser nothing", async () => {
  const dd = await buyerCimExtras(deal, "due_diligence", "a-dd");
  assert.equal(dd.glEvidence?.mode, "dd");
  const sec = [{ id: "s1", dealId: deal.id, sectionKey: "earnings_bridge", sectionTitle: "Earnings Bridge", order: 1, layoutType: "waterfall_chart", layoutData: { items: [] }, isVisible: true } as any];
  const cim = buildBuyerCim({ deal, accessLevel: "due_diligence", sections: sec, overrides: [], ...dd });
  assert.deepEqual(cim.sections.map((x) => x.layoutType), ["waterfall_chart", "gl_evidence"]);
  assert.equal((await buyerCimExtras(deal, "teaser_only", "a-teaser")).glEvidence, null);
  assert.equal((await buyerCimExtras(deal, "loi", null)).glEvidence?.mode, "normal");
});

await test("a change after publishing: tightened at once and counted for the broker", async () => {
  // The broker withholds one shown entry.
  const ev = (await call("GET", `${D}/evidence?mode=dd&source=published`)).json.payload;
  const line = ev.lines.find((l: any) => l.years?.some((y: any) => y.entries.length > 0));
  const entry = line.years.find((y: any) => y.entries.length > 0).entries[0];
  const link = w.gl.data.links.find((k) => k.rowNo === entry.rowNo && k.state === "confirmed")!;
  const t = panel.traces.find((x: any) => x.id === link.traceId);
  assert.equal((await call("PATCH", `${D}/traces/${t.id}`, { links: [{ id: link.id, showDetails: false }] })).status, 200);
  const after = (await call("GET", `${D}/evidence?mode=dd&source=published`)).json.payload;
  const same = after.lines.find((l: any) => l.lineId === line.lineId).years.flatMap((y: any) => y.entries).find((e: any) => e.rowNo === entry.rowNo);
  assert.equal(same.withheld, "keep_out", "withheld for buyers without a republish");
});

await test("buyers ask about an entry: due diligence only, private, the entry as they saw it", async () => {
  const ev = (await call("GET", `${D}/evidence?mode=dd&source=published`)).json.payload;
  const line = ev.lines.find((l: any) => l.years?.some((y: any) => y.entries.length > 0));
  const entry = line.years.find((y: any) => y.entries.length > 0).entries.find((e: any) => !e.withheld);
  sessionBroker = undefined;
  const ok = await call("POST", "/api/view/tok-dd/gl/question", { lineId: line.lineId, rowNo: entry.rowNo, text: "Is this the owner's own car?" });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const q = questions[questions.length - 1];
  assert.equal(q.status, "pending_broker");
  assert.equal(q.answerScope, "private");
  assert.equal(q.aiAnswer, null, "no AI");
  assert.match(q.question, new RegExp(`^About the ledger entry of .* \\(row ${entry.rowNo}\\): Is this the owner's own car\\?$`));
  assert.equal((await call("POST", "/api/view/tok-blind/gl/question", { lineId: line.lineId, text: "Hello there" })).status, 403, "a Blind CIM buyer");
  assert.equal((await call("POST", "/api/view/tok-teaser/gl/question", { lineId: line.lineId, text: "Hello there" })).status, 403, "a teaser link");
  assert.equal((await call("POST", "/api/view/nope/gl/question", { lineId: line.lineId, text: "Hello there" })).status, 404);
  assert.equal((await call("POST", "/api/view/tok-dd/gl/question", { lineId: "000000000000", text: "Hello there" })).status, 404);
  assert.equal((await call("POST", "/api/view/tok-dd/gl/question", { lineId: line.lineId, text: "Hi", extra: 1 })).status, 400);
  assert.equal((await call("POST", "/api/view/tok-dd/gl/question", { lineId: line.lineId, text: "x".repeat(1001) })).status, 400);
  sessionBroker = "b1";
});

await test("Stop showing it to buyers", async () => {
  assert.equal((await call("DELETE", `${D}/publish`)).status, 200);
  assert.equal((await call("GET", `${D}/evidence?mode=dd&source=published`)).json.payload, null);
  assert.equal((await buyerCimExtras(deal, "due_diligence", "a-dd")).glEvidence, null);
  const prev = (await call("GET", `${D}/evidence?mode=dd&source=preview`)).json;
  assert.equal(prev.payload.preview, true, "unpublished → the builder previews the live data");
});

server.close();
cleanup(w);
done("routes: what buyers see");
