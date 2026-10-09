/**
 * Interview together — sessions on the board (specs/together.md §4.4, §5.2,
 * §7.2–§7.7), through a real Express app with in-memory storage, throwing
 * model seams (any model call fails the test) and blocked outbound fetches.
 * No database, no AI, no email, no Deepgram / Daily / Recall.
 *  - start/resume (no AI call, no interview session), another brokerage → 404,
 *    a sitting of another deal → 404, a stale sitting ends with its summary;
 *  - lines: limits → 400; spoken before consent → 409 (typed fine); a retried
 *    batch, a reload and two tabs; the other microphone's copy; roles; the
 *    transcript document holds only the seller's words;
 *  - SSE needs a session; PATCH "Seller can see this screen" → the next
 *    `board` event is the screen board; the poll fallback;
 *  - the notetaker's lines join only the sitting whose bot it is (token and
 *    bot id), a redelivered webhook adds nothing;
 *  - ✓ Answered: auto → type it (pass 2); note → the broker's call note
 *    (never final; a stronger value stays and keeps it beside; an add-back
 *    treatment is refused);
 *  - end: follow-ups screened (nothing written when one is private), the
 *    outline gets label + ask only, routed questions handed back with the
 *    seller's lines as theirs, the interview completed only when ticked;
 *  - the follow-up email: preview, demo deals record only, no address → 409;
 *  - the seller's own AI interview waits while a sitting is live (§7.4).
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/together/sittings.test.ts
 */
import assert from "node:assert/strict";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import Anthropic from "@anthropic-ai/sdk";

process.env.DISABLE_SCHEDULERS = "1";
process.env.NODE_ENV = "test";
process.env.UPLOADS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "together-sittings-"));
delete process.env.RESEND_API_KEY;

// ── Any model call fails the test; nothing leaves the machine ─────────
let modelCalls = 0;
const proto = (Anthropic as any).Messages.prototype;
proto.create = function () { modelCalls++; throw new Error("test: a model was called"); };
proto.stream = function () { modelCalls++; throw new Error("test: a model was called"); };
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  const u = String(url);
  if (u.startsWith("http://127.0.0.1:")) return realFetch(url, init);
  throw new Error(`test: blocked outbound fetch to ${u}`);
}) as any;

const deals: Record<string, any> = {
  D1: {
    id: "D1", brokerId: "B1", businessName: "Harbour Heating Ltd", industry: "", subIndustry: null, askingPrice: null, phase: "phase1_info_collection",
    interviewPlan: null, interviewOutline: null, sectionImportance: null, interviewEvidence: null, demoKey: null, interviewCompleted: false,
    interviewBot: null,
    extractedInfo: {
      annualRevenue: "$4.8M",
      reasonForSale: "Retiring",
      ownerName: "Tony Moretti",
      _sellerKeepOut: [{ detail: "Dave's divorce settlement", terms: ["divorce"] }],
      _fieldSources: { annualRevenue: { source: "interview" }, reasonForSale: { source: "interview" }, ownerName: { source: "interview" } },
    },
  },
  D2: { id: "D2", brokerId: "B2", businessName: "Other Brokerage Deal", industry: "", extractedInfo: {}, demoKey: null },
  D3: { id: "D3", brokerId: "B1", businessName: "Demo Deal Ltd", industry: "", extractedInfo: {}, demoKey: "demo-x", interviewOutline: null },
};
const users: Record<string, any> = { B1: { id: "B1", name: "Morgan Ellis", email: "morgan@brokerage.invalid" } };
const documents: any[] = [];
const invites = [{ id: "I1", dealId: "D1", token: "seller-token-1", sellerEmail: "tony@harbour.invalid", sellerName: "Tony", status: "accepted" }];
const requirements = [{ id: "R1", dealId: "D1", documentName: "General ledger", isRequired: true, status: "missing", source: "auto" }];

async function main() {
  const { storage } = await import("../../server/storage");
  const { db } = await import("../../server/db");
  const { registerTogetherRoutes } = await import("../../server/routes/together");
  const { _setMarksStoreForTests } = await import("../../server/together/marks");
  const { _setTogetherStoreForTests, memoryTogetherStore } = await import("../../server/together/store");
  const { _setSittingEndHooksForTests } = await import("../../server/together/summary");
  const { liveSittingFor } = await import("../../server/together/sittings");
  const { togetherLineFromWebhook, appendRecallLine } = await import("../../server/together/recall-lines");
  const { getInterviewOutline, renderOutlineForPrompt } = await import("../../server/interview/outline");
  const { BROKER_CALL_SOURCE_NOTE } = await import("../../server/interview/info-merger");

  const S = storage as any;
  let docId = 0;
  Object.assign(S, {
    getDeal: async (id: string) => (deals[id] ? structuredClone(deals[id]) : undefined),
    updateDeal: async (id: string, patch: any) => { deals[id] = { ...deals[id], ...patch }; return structuredClone(deals[id]); },
    getUser: async (id: string) => users[id],
    getSellerInviteByToken: async (t: string) => invites.find((i) => i.token === t),
    getSellerInvitesByDealId: async (id: string) => invites.filter((i) => i.dealId === id),
    getDiscrepanciesByDeal: async () => [],
    getResolvedDiscrepancies: async () => [],
    getDocumentRequirementsByDeal: async (id: string) => requirements.filter((r) => r.dealId === id),
    getDocumentsByDeal: async (id: string) => documents.filter((d) => d.dealId === id),
    getTasksByDeal: async () => [],
    createDocument: async (d: any) => { const row = { id: `DOC${++docId}`, createdAt: new Date(), updatedAt: new Date(), ...d }; documents.push(row); return structuredClone(row); },
    getDocument: async (id: string) => structuredClone(documents.find((d) => d.id === id)),
    updateDocument: async (id: string, patch: any) => { const d = documents.find((x) => x.id === id); Object.assign(d, patch); return structuredClone(d); },
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
        const rows = name === "documents" ? documents.filter((d) => d.dealId === "D1") : [];
        return Promise.resolve(rows).then(res, rej);
      },
    };
    return chain;
  };
  const marks: any[] = [];
  _setMarksStoreForTests({
    active: async (dealId) => marks.filter((m) => m.dealId === dealId && !m.clearedAt),
    insert: async (row) => { const r = { id: `M${marks.length + 1}`, createdAt: new Date(), clearedAt: null, ...row }; marks.push(r); return r as any; },
    clear: async () => 0,
  });
  const mem = memoryTogetherStore();
  _setTogetherStoreForTests(mem);
  const handedBack: any[] = [];
  let completed = 0;
  _setSittingEndHooksForTests({
    handBackRouted: async (dealId, messages) => { handedBack.push({ dealId, messages }); },
    completeInterview: async () => { completed++; },
    refreshEvidence: () => {},
  });

  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.session = { brokerId: req.get("x-test-broker") || undefined }; next(); });
  registerTogetherRoutes(app);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, p: string, body?: unknown, broker: string | null = "B1") => {
    const r = await realFetch(base + p, {
      method,
      headers: { "content-type": "application/json", ...(broker ? { "x-test-broker": broker } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* text */ }
    return { status: r.status, json };
  };
  const itemOf = (board: any, id: string) => board.sections.flatMap((s: any) => s.items).find((i: any) => i.id === id);
  let n = 0;
  const ok = (name: string) => { n++; console.log("✓", name); };
  const PAGE_A = "11111111-aaaa-4aaa-8aaa-000000000001";
  const PAGE_B = "22222222-bbbb-4bbb-8bbb-000000000002";

  try {
    // ── Start / resume / tenancy ──
    assert.equal((await call("POST", "/api/deals/D1/together/sittings", { via: "person" }, null)).status, 401);
    assert.equal((await call("POST", "/api/deals/D2/together/sittings", { via: "person" })).status, 404, "another brokerage's deal");
    const start = await call("POST", "/api/deals/D1/together/sittings", { via: "person" });
    assert.equal(start.status, 200);
    assert.equal(start.json.resumed, false);
    assert.equal(start.json.sitting.via, "person");
    assert.equal(start.json.sitting.sellerSeesScreen, true, "in person: the seller can see the screen by default");
    assert.equal(start.json.board.audience, "screen", "…so the board arrives seller-safe");
    assert.equal(start.json.sitting.consentAt, null);
    const sid = start.json.sitting.id;
    const again = await call("POST", "/api/deals/D1/together/sittings", { via: "person" });
    assert.equal(again.json.sitting.id, sid, "a return within 2 h resumes the same session");
    assert.equal(again.json.resumed, true);
    assert.equal(modelCalls, 0, "opening the board makes no AI call");
    const other = await call("POST", "/api/deals/D3/together/sittings", { via: "zoom" });
    assert.equal(other.json.sitting.sellerSeesScreen, false, "remote calls: off by default");
    assert.equal((await call("GET", `/api/deals/D1/together/sittings/${other.json.sitting.id}`)).status, 404, "a sitting of another deal → 404");
    assert.equal((await call("GET", `/api/deals/D2/together/sittings/${sid}`)).status, 404);
    ok("start/resume: no AI call; in person starts seller-safe; tenancy and sitting-to-deal checks");

    // ── Lines: limits and consent ──
    const L = (clientId: string, lines: any[]) => call("POST", `/api/deals/D1/together/sittings/${sid}/lines`, { clientId, lines });
    assert.equal((await L(PAGE_A, Array.from({ length: 51 }, (_, i) => ({ clientSeq: i, speaker: "dg:0", text: "a", source: "deepgram" })))).status, 400);
    assert.equal((await L(PAGE_A, [{ clientSeq: 0, speaker: "dg:0", text: "x".repeat(2001), source: "deepgram" }])).status, 400);
    assert.equal((await L(PAGE_A, [{ clientSeq: 0, speaker: "bad id", text: "a", source: "deepgram" }])).status, 400);
    assert.equal((await L("not a page id!", [{ clientSeq: 0, speaker: "dg:0", text: "a", source: "deepgram" }])).status, 400);
    const noConsent = await L(PAGE_A, [{ clientSeq: 0, speaker: "dg:0", text: "Which months are your busiest, and which are the quietest?", source: "deepgram" }]);
    assert.equal(noConsent.status, 409);
    assert.equal(noConsent.json.code, "consent_required");
    const typed = await L(PAGE_A, [{ clientSeq: 0, speaker: "typed:broker", text: "22 trucks in the fleet", source: "typed" }]);
    assert.equal(typed.status, 200, "typed lines need no consent");
    assert.equal(typed.json.accepted, 1);
    ok("lines: limits → 400; spoken before consent → 409; typed accepted");

    assert.equal((await call("POST", `/api/deals/D1/together/sittings/${sid}/consent`, {})).status, 200);
    // ── Idempotency: retry, reload, two tabs ──
    const batch = [
      { clientSeq: 1, speaker: "dg:0", text: "Which months are your busiest, and which are the quietest?", source: "deepgram" },
      { clientSeq: 2, speaker: "dg:1", text: "Summer and the cold snaps are crazy — June through August.", source: "deepgram" },
    ];
    const first = await L(PAGE_A, batch);
    assert.equal(first.json.accepted, 2);
    const retry = await L(PAGE_A, batch);
    assert.equal(retry.json.accepted, 0, "a retried batch is de-duplicated");
    assert.equal(retry.json.skipped, 2);
    const reload = await L(PAGE_B, [{ clientSeq: 0, speaker: "dg:1", text: "April and October are dead.", source: "deepgram" }]);
    assert.equal(reload.json.accepted, 1, "after a reload (new page id, numbers from 0) new lines are accepted");
    const tabA = await L(PAGE_A, [{ clientSeq: 3, speaker: "dg:0", text: "And how many staff?", source: "deepgram" }]);
    const tabB = await L(PAGE_B, [{ clientSeq: 1, speaker: "dg:1", text: "Thirty-six, give or take.", source: "deepgram" }]);
    assert.equal(tabA.json.accepted + tabB.json.accepted, 2, "two tabs both keep their lines");
    // The other microphone's copy (two devices in one room).
    const dupe = await L(PAGE_B, [{ clientSeq: 2, speaker: "dg:0", text: "Thirty six, give or take", source: "deepgram" }]);
    assert.equal(dupe.json.accepted, 0, "the same words from another speaker within 2.5 s are dropped");
    const seqs = mem.lines.filter((l) => l.sittingId === sid).map((l) => l.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "the server numbers lines in order");
    assert.equal(new Set(seqs).size, seqs.length);
    ok("idempotency: a retry is a no-op, a reload and a second tab keep theirs, the other microphone's copy is dropped");

    // ── Roles and the transcript document ──
    let detail = await call("GET", `/api/deals/D1/together/sittings/${sid}`);
    assert.equal(detail.json.sitting.speakers["dg:0"].role, "broker", "the voice that read a suggested question is the broker");
    assert.equal(detail.json.sitting.speakers["dg:1"].role, "seller");
    assert.equal(detail.json.sitting.speakers["typed:broker"].role, "broker");
    assert.equal(detail.json.sitting.hasTranscript, true, "the transcript row exists from the first seller line");
    const doc = documents.find((d) => d.id === mem.sittings.find((s) => s.id === sid)!.transcriptDocumentId);
    assert.ok(doc);
    assert.equal(doc.sourceMeta.recordType, "together_sitting");
    assert.equal(doc.sourceKind, "call");
    assert.equal(doc.visibility, "shared");
    assert.equal(doc.category, "transcripts");
    assert.match(doc.name, /^Interview together — \d{1,2} [A-Z][a-z]{2} \d{4} \(In person\)$/);
    // Pause writes the text: the seller's words only.
    assert.equal((await call("POST", `/api/deals/D1/together/sittings/${sid}/pause`, {})).json.sitting.status, "paused");
    const text = documents.find((d) => d.id === doc.id).extractedText as string;
    assert.match(text, /Summer and the cold snaps/);
    assert.match(text, /April and October/);
    assert.doesNotMatch(text, /busiest|how many staff|22 trucks/i, "never the broker's words (spoken or typed)");
    assert.equal(fs.readFileSync(path.join(process.env.UPLOADS_DIR!, "docs", doc.fileUrl.split("/").pop()), "utf8"), text, "the file holds the same text");
    assert.equal(await liveSittingFor("D1"), null, "a paused sitting never locks the seller out");
    assert.equal((await call("POST", `/api/deals/D1/together/sittings/${sid}/resume`, {})).json.sitting.status, "live");
    assert.ok(await liveSittingFor("D1"), "a live sitting with a recent line locks");
    // The broker corrects who's who: the other voice follows.
    const sp = await call("POST", `/api/deals/D1/together/sittings/${sid}/speakers`, { speaker: "dg:1", role: "broker" });
    assert.equal(sp.json.sitting.speakers["dg:1"].role, "broker");
    assert.equal(sp.json.sitting.speakers["dg:0"].role, "seller", "two voices: the other follows");
    assert.equal((await call("POST", `/api/deals/D1/together/sittings/${sid}/speakers`, { speaker: "dg:9", role: "broker" })).status, 400, "nobody with that label spoke");
    await call("POST", `/api/deals/D1/together/sittings/${sid}/speakers`, { speaker: "dg:0", role: "broker" });
    ok("roles: automatic (echo of a suggested question), the broker's choice wins; the transcript holds only the seller's words");

    // ── SSE and the screen toggle ──
    const sse = await realFetch(`${base}/api/deals/D1/together/sittings/${sid}/events`, { headers: {} });
    assert.equal(sse.status, 401, "SSE needs a broker session");
    await sse.text().catch(() => "");
    const ctl = new AbortController();
    const stream = await realFetch(`${base}/api/deals/D1/together/sittings/${sid}/events`, { headers: { "x-test-broker": "B1" }, signal: ctl.signal });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = stream.body!.getReader();
    const events: any[] = [];
    let buf = "";
    const readUntil = async (pred: (e: any) => boolean, ms = 4000) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const found = events.find(pred);
        if (found) return found;
        const chunk = await Promise.race([reader.read(), new Promise<any>((r) => setTimeout(() => r({ timeout: true }), 200))]);
        if (chunk?.timeout) continue;
        if (chunk.done) break;
        buf += new TextDecoder().decode(chunk.value);
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = block.split("\n").find((l) => l.startsWith("data: "));
          if (data) events.push(JSON.parse(data.slice(6)));
        }
      }
      return events.find(pred);
    };
    const hello = await readUntil((e) => e.type === "hello");
    assert.ok(hello && hello.sitting.id === sid);
    const toScreenOff = await call("PATCH", `/api/deals/D1/together/sittings/${sid}`, { sellerSeesScreen: false });
    assert.equal(toScreenOff.json.board.audience, "broker");
    const toScreen = await call("PATCH", `/api/deals/D1/together/sittings/${sid}`, { sellerSeesScreen: true });
    assert.equal(toScreen.status, 200);
    const boardEv = await readUntil((e) => e.type === "board" && e.board.audience === "screen");
    assert.ok(boardEv, "the next board event is the screen audience");
    const linesEv = await (async () => {
      await L(PAGE_A, [{ clientSeq: 4, speaker: "dg:1", text: "We also do commercial rooftops.", source: "deepgram" }]);
      return readUntil((e) => e.type === "lines" && e.lines.some((l: any) => /rooftops/.test(l.text)));
    })();
    assert.ok(linesEv, "lines reach every open tab");
    ctl.abort();
    // The board GET with the session id is always seller-safe while it's on.
    const forced = await call("GET", `/api/deals/D1/coverage-board?audience=broker&sittingId=${sid}`);
    assert.equal(forced.json.audience, "screen", "the server enforces the toggle");
    // Poll fallback.
    const poll = await call("GET", `/api/deals/D1/together/sittings/${sid}/state?after=0`);
    assert.equal(poll.status, 200);
    assert.ok(poll.json.events.length > 0 || poll.json.reset);
    const ahead = await call("GET", `/api/deals/D1/together/sittings/${sid}/state?after=99999`);
    assert.equal(ahead.json.reset, true, "too far ahead: a fresh snapshot");
    assert.equal(ahead.json.board.audience, "screen");
    await call("PATCH", `/api/deals/D1/together/sittings/${sid}`, { sellerSeesScreen: false });
    ok("SSE: needs a session; hello, lines and the screen board after the toggle; the GET is forced seller-safe; polling");

    // ── ✓ Answered ──
    const auto = await call("POST", "/api/deals/D1/coverage-board/items/seasonality:seasonality/answer", { sittingId: sid, mode: "auto" });
    assert.equal(auto.status, 409);
    assert.equal(auto.json.code, "no_capture", "until live filing runs, the broker types it");
    const note = await call("POST", "/api/deals/D1/coverage-board/items/seasonality:seasonality/answer", { sittingId: sid, mode: "note", value: "June to August is the peak; April and October are slow" });
    assert.equal(note.status, 400, "a multi-member item needs to know which member");
    assert.equal(note.json.code, "member_required");
    const note2 = await call("POST", "/api/deals/D1/coverage-board/items/seasonality:seasonality/answer", { sittingId: sid, mode: "note", memberKey: "seasonality", value: "June to August is the peak; April and October are slow" });
    assert.equal(note2.status, 200);
    assert.equal(note2.json.filed, true);
    const src = deals.D1.extractedInfo._fieldSources.seasonality;
    assert.equal(src.source, "broker");
    assert.equal(src.note, BROKER_CALL_SOURCE_NOTE, "the broker's call note — never a broker edit, never the seller's words");
    assert.equal(src.sittingId, sid);
    let board = (await call("GET", "/api/deals/D1/coverage-board")).json;
    const season = itemOf(board, "seasonality:seasonality");
    assert.equal(season.status, "on_file");
    assert.equal(season.yourNote, true);
    assert.equal(season.filedInSittingId, sid, "it shows as filed this session");
    // A stronger value (the seller's own interview answer) stays; the note is kept beside it.
    const kept = await call("POST", "/api/deals/D1/coverage-board/items/reason_for_sale:reasonForSale/answer", { sittingId: sid, mode: "note", value: "Health reasons" });
    assert.equal(kept.json.keptBeside, true);
    assert.equal(deals.D1.extractedInfo.reasonForSale, "Retiring");
    assert.ok(JSON.stringify(deals.D1.extractedInfo._fieldAlternates ?? {}).includes("Health reasons"), "kept as another value");
    // A detail the seller asked to keep out is held back.
    const team = board.sections.find((x: any) => x.key === "employees").items.find((i: any) => /team/i.test(i.label));
    const teamMember = team.members.find((m: any) => m.writable).key;
    const keepOut = await call("POST", `/api/deals/D1/coverage-board/items/${team.id}/answer`, { sittingId: sid, mode: "note", memberKey: teamMember, value: "Dave runs service; his divorce settlement is ongoing" });
    assert.equal(keepOut.status, 422);
    assert.equal(keepOut.json.code, "keep_out");
    // Validation.
    assert.equal((await call("POST", "/api/deals/D1/coverage-board/items/seasonality:seasonality/answer", { sittingId: "nope", mode: "note", value: "x" })).status, 404);
    assert.equal((await call("POST", "/api/deals/D2/coverage-board/items/seasonality:seasonality/answer", { sittingId: sid, mode: "note", value: "x" })).status, 404);
    assert.equal(modelCalls, 0);
    ok("✓ Answered: auto → type it; a call note is filed (rank 4, this session); a stronger value stays; keep-out held back");

    // ── The notetaker's lines ──
    const zoom = await call("POST", "/api/deals/D3/together/sittings", { via: "zoom" });
    const zid = zoom.json.sitting.id;
    await call("POST", `/api/deals/D3/together/sittings/${zid}/consent`, {});
    deals.D3.interviewBot = { botId: "bot-1", webhookToken: "tok-1", meetingUrl: "https://zoom.us/j/1", startedAt: new Date().toISOString() };
    await mem.updateSitting(zid, { botId: "bot-1" });
    const payload = (text: string, start: number | null, botId = "bot-1", pid = 101, name = "Tony Moretti", host = true) => ({
      event: "transcript.data",
      data: { bot: { id: botId }, data: { participant: { id: pid, name, is_host: host }, words: [{ text, start_timestamp: start === null ? null : { relative: start } }] } },
    });
    const parsed = togetherLineFromWebhook(payload("We run twelve trucks.", 12.5));
    assert.deepEqual({ ...parsed, text: parsed!.text }, { botId: "bot-1", participantId: "101", name: "Tony Moretti", isHost: true, text: "We run twelve trucks.", startMs: 12500 });
    assert.equal(await appendRecallLine("D3", "tok-1", parsed!), true);
    assert.equal(await appendRecallLine("D3", "tok-1", parsed!), false, "a redelivered webhook adds nothing");
    assert.equal(await appendRecallLine("D3", "wrong-token", togetherLineFromWebhook(payload("Other", 20))!), false, "a token that isn't this bot's");
    assert.equal(await appendRecallLine("D3", "tok-1", togetherLineFromWebhook(payload("Old bot", 30, "bot-0"))!), false, "a bot started for an earlier sitting");
    assert.equal(await appendRecallLine("D1", "tok-1", parsed!), false, "an in-person sitting never takes notetaker lines");
    assert.equal(mem.lines.filter((l) => l.sittingId === zid).length, 1);
    assert.equal(mem.lines.find((l) => l.sittingId === zid)!.clientId, "rc:bot-1:101");
    ok("notetaker: only the sitting whose bot it is (token + bot id); a redelivery is a no-op");

    // ── End ──
    const summary = await call("GET", `/api/deals/D1/together/sittings/${sid}/summary`);
    assert.equal(summary.status, 200);
    assert.ok(summary.json.filed.some((f: any) => f.itemId === "seasonality:seasonality" && f.yourNote), "the call note is in 'filed this session'");
    assert.ok(summary.json.documents.some((d: any) => d.requirementId === "R1" && d.ticked), "a required document starts ticked");
    const open = summary.json.stillToGet.find((r: any) => r.status === "missing");
    assert.ok(open);
    const refused = await call("POST", `/api/deals/D1/together/sittings/${sid}/end`, {
      completeInterview: false, addToNextSession: true, documents: [],
      followUps: [{ itemId: open.itemId, ask: "What would the add-backs come to on your SDE?" }],
    });
    assert.equal(refused.status, 400);
    assert.equal(refused.json.code, "private_ask");
    assert.match(refused.json.error, /private to you — reword it/);
    assert.equal(mem.sittings.find((s) => s.id === sid)!.status, "live", "nothing written when an ask is refused");
    const keepOutAsk = await call("POST", `/api/deals/D1/together/sittings/${sid}/end`, {
      completeInterview: false, addToNextSession: true, documents: [], followUps: [{ itemId: open.itemId, ask: "How is Dave's divorce going?" }],
    });
    assert.equal(keepOutAsk.status, 400, "a keep-out party never goes to the seller");
    const ended = await call("POST", `/api/deals/D1/together/sittings/${sid}/end`, {
      completeInterview: false, addToNextSession: true, documents: ["R1"],
      followUps: [{ itemId: open.itemId, ask: "Who are your main suppliers?" }],
    });
    assert.equal(ended.status, 200);
    assert.equal(ended.json.sitting.status, "ended");
    assert.equal(ended.json.followUpsAdded, 1);
    const outline = getInterviewOutline(deals.D1);
    assert.equal(outline.followUpItems?.length, 1);
    assert.deepEqual(Object.keys(outline.followUpItems![0]).sort(), ["addedAt", "ask", "itemId", "key", "label", "sectionKey", "sittingId"], "label and ask only — no note field");
    assert.match(renderOutlineForPrompt(outline), /Who are your main suppliers\?/);
    assert.equal(handedBack.length, 1, "routed questions handed back (always)");
    assert.ok(handedBack[0].messages.some((m: any) => m.role === "user" && /rooftops/.test(m.content)), "the seller's lines are the seller's");
    assert.ok(handedBack[0].messages.every((m: any) => !/22 trucks/.test(m.content)), "typed lines aren't part of the conversation");
    assert.equal(completed, 0, "not completed unless ticked");
    assert.equal((await call("POST", `/api/deals/D1/together/sittings/${sid}/lines`, { clientId: PAGE_A, lines: [{ clientSeq: 9, speaker: "typed:broker", text: "late", source: "typed" }] })).status, 409, "an ended session takes no lines");
    assert.equal((await call("POST", `/api/deals/D1/together/sittings/${sid}/end`, { completeInterview: true, followUps: [], documents: [] })).status, 409);
    const listed = await call("GET", "/api/deals/D1/together/sittings");
    assert.equal(listed.json[0].id, sid);
    assert.equal(listed.json[0].filed, ended.json.summary.filed.length);
    // A new start after the end is a new session.
    const fresh = await call("POST", "/api/deals/D1/together/sittings", { via: "person" });
    assert.notEqual(fresh.json.sitting.id, sid);
    const endFresh = await call("POST", `/api/deals/D1/together/sittings/${fresh.json.sitting.id}/end`, { completeInterview: true, followUps: [], documents: [], addToNextSession: false });
    assert.equal(endFresh.status, 200);
    assert.equal(completed, 1, "completed when ticked");
    assert.equal(endFresh.json.sitting.interviewCompleted, true);
    ok("end: private asks refused (nothing written), follow-ups as label + ask, routed questions handed back, completion only when ticked");

    // ── The follow-up email ──
    const prev = await call("POST", `/api/deals/D1/together/sittings/${sid}/follow-up-email`, { itemIds: [open.itemId], documentIds: ["R1"], preview: true });
    assert.equal(prev.status, 200);
    assert.equal(prev.json.to, "tony@harbour.invalid");
    assert.equal(prev.json.subject, "Harbour Heating Ltd: a few things to finish your business overview");
    assert.match(prev.json.html, /Who are your main suppliers\?/, "the screened ask stored at the end");
    assert.match(prev.json.html, /General ledger/);
    assert.match(prev.json.html, /\/seller\/seller-token-1\/documents/);
    assert.equal(prev.json.sent, false);
    const badAsk = await call("POST", `/api/deals/D1/together/sittings/${sid}/follow-up-email`, { itemIds: [open.itemId], documentIds: [], asks: { [open.itemId]: "Per the broker's recast, what's the SDE?" } });
    assert.equal(badAsk.status, 400, "an edited ask is screened again");
    assert.equal((await call("POST", `/api/deals/D1/together/sittings/${sid}/follow-up-email`, { itemIds: [], documentIds: [] })).status, 400);
    const demoEnd = await call("POST", `/api/deals/D3/together/sittings/${zid}/end`, { completeInterview: false, followUps: [], documents: [], addToNextSession: false });
    assert.equal(demoEnd.status, 200);
    const demoMail = await call("POST", `/api/deals/D3/together/sittings/${zid}/follow-up-email`, { itemIds: [], documentIds: [], preview: false });
    assert.equal(demoMail.status, 400, "nothing picked");
    requirements.push({ id: "R3", dealId: "D3", documentName: "Fleet list", isRequired: true, status: "missing", source: "auto" });
    const noAddress = await call("POST", `/api/deals/D3/together/sittings/${zid}/follow-up-email`, { itemIds: [], documentIds: ["R3"], preview: false });
    assert.equal(noAddress.status, 409, "no seller address on the deal");
    invites.push({ id: "I3", dealId: "D3", token: "seller-token-3", sellerEmail: "owner@demo.invalid", sellerName: "Pat", status: "sent" });
    const demoSend = await call("POST", `/api/deals/D3/together/sittings/${zid}/follow-up-email`, { itemIds: [], documentIds: ["R3"], preview: false });
    assert.equal(demoSend.status, 200);
    assert.equal(demoSend.json.recorded, true, "a demo deal records the send");
    assert.equal(demoSend.json.sent, false, "…and never emails");
    assert.ok((mem.sittings.find((x) => x.id === zid)!.summary as any).emailedAt, "the summary notes it was sent");
    ok("follow-up email: preview with the screened asks and the documents link; edited asks screened again; demo deals record only");

    // ── The seller's AI interview waits while a sitting is live ──
    const live = await call("POST", "/api/deals/D1/together/sittings", { via: "person" });
    await call("POST", `/api/deals/D1/together/sittings/${live.json.sitting.id}/consent`, {});
    const { startOrResumeSession } = await import("../../server/interview/session-manager");
    const r = await startOrResumeSession("D1", { conductedBy: "seller" });
    assert.equal(r.status, "together_live", "the seller is told the broker is going through it with them");
    assert.equal(r.sessionId, "");
    await call("POST", `/api/deals/D1/together/sittings/${live.json.sitting.id}/pause`, {});
    assert.equal(await liveSittingFor("D1"), null);
    // Over 30 minutes quiet: no longer locks.
    const s = mem.sittings.find((x) => x.id === live.json.sitting.id)!;
    s.status = "live";
    s.lastLineAt = new Date(Date.now() - 31 * 60_000);
    s.startedAt = new Date(Date.now() - 40 * 60_000);
    assert.equal(await liveSittingFor("D1"), null, "a sitting quiet for 30 minutes doesn't lock");
    assert.equal(modelCalls, 0, "no model call anywhere");
    ok("seller lockout: a live sitting returns together_live; paused or quiet for 30 min doesn't lock");

    // Another way of running it is another session (the earlier one ends, with its summary).
    s.lastLineAt = new Date();
    const personId = live.json.sitting.id;
    const viaZoom = await call("POST", "/api/deals/D1/together/sittings", { via: "zoom" });
    assert.notEqual(viaZoom.json.sitting.id, personId);
    assert.equal(viaZoom.json.sitting.via, "zoom");
    const old = mem.sittings.find((x) => x.id === personId)!;
    assert.equal(old.status, "ended");
    assert.ok(old.summary, "the ended one keeps its summary");
    ok("switching from in person to Zoom starts a new session and ends the earlier one with its summary");
  } finally {
    server.close();
    fs.rmSync(process.env.UPLOADS_DIR!, { recursive: true, force: true });
  }
  console.log(`\n${n} checks passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
