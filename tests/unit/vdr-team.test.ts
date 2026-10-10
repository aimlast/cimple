/**
 * vdr spec §6.8, §5.7, §9.2–§9.3 (V18): a buyer's team in the data room,
 * end to end over HTTP on an in-memory store. No database, no AI, no email
 * (emails are recorded by the harness, never sent).
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled DISABLE_SCHEDULERS=1 npx tsx tests/unit/vdr-team.test.ts
 *
 *  - input rules: name, email, one of five roles; never the buyer's own
 *    address; no duplicates; at most 5 per buyer
 *  - broker adds someone → a link (only its hash is stored); the first visit
 *    is the confidentiality step; then the buyer's room exactly (same
 *    documents), the member's own watermark "… for Northgate", no team list,
 *    can't add people
 *  - the buyer asks → "Waiting on you" shows it → Approve and send the link
 *    (ONE email, Reply-To the broker; demo deals record, never send) →
 *    "Your team" shows them
 *  - a new link kills the old one; Remove kills the link; the buyer's access
 *    ending ends theirs ("… access to this data room has ended")
 *  - tenancy: another deal's member → 404; a buyer without the room → 409
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "vdr-team-"));
process.env.UPLOADS_DIR = root;
process.env.DISABLE_SCHEDULERS = "1";
process.env.ANTHROPIC_API_KEY = "disabled";
delete process.env.RESEND_API_KEY;

const { vdrTestApp } = await import("./vdr-app-harness");
const { setUpRoom } = await import("../../server/vdr/setup");
const { vdrCacheDir } = await import("../../server/vdr/files");
const { parseTeamInput, teamAddProblem, teamLinkEmail, TEAM_MAX } = await import("../../server/vdr/team");
const { tokenHash } = await import("../../server/vdr/access");

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    throw err;
  }
}

const now = new Date("2026-10-09T12:00:00Z");
const later = new Date("2026-11-30T00:00:00Z");
fs.mkdirSync(path.join(root, "docs"), { recursive: true });
for (const n of ["t2.pdf", "lease.pdf", "e.pdf"]) fs.writeFileSync(path.join(root, "docs", n), "%PDF-1.4 fixture");
const docs: any[] = [
  { id: "t2", dealId: "D", name: "T2 corporate income tax return 2023", originalName: "T2.pdf", category: "financials", fileUrl: "/uploads/docs/t2.pdf", mimeType: "application/pdf", createdAt: now },
  { id: "lease", dealId: "D", name: "Warehouse lease", originalName: "Lease.pdf", category: "legal", fileUrl: "/uploads/docs/lease.pdf", mimeType: "application/pdf", createdAt: now },
  { id: "e", dealId: "E", name: "Other deal's T2", originalName: "T2.pdf", category: "financials", fileUrl: "/uploads/docs/e.pdf", mimeType: "application/pdf", createdAt: now },
];
const deals: any[] = [
  { id: "D", brokerId: "b1", businessName: "Pacific Test Logistics", isLive: true, extractedInfo: {}, demoKey: null },
  { id: "E", brokerId: "b2", businessName: "Another brokerage's deal", isLive: true, extractedInfo: {}, demoKey: "demo-e" },
];
const access: any[] = [
  { id: "dd", dealId: "D", buyerEmail: "Jane@Northgate.invalid", buyerName: "Jane Doe", buyerCompany: "Northgate Pharmacy Group", accessToken: "tok-dd-aaaaaaaaaaaa", accessLevel: "due_diligence", ndaSigned: true, revokedAt: null, expiresAt: later, createdAt: now },
  { id: "blind", dealId: "D", buyerEmail: "bo@blind.invalid", buyerName: "Bo", buyerCompany: "BlindCo", accessToken: "tok-blind-aaaaaaaaa", accessLevel: "full", ndaSigned: true, revokedAt: null, expiresAt: later, createdAt: now },
  { id: "E-dd", dealId: "E", buyerEmail: "x@e.invalid", buyerName: "Xavier", buyerCompany: "ECo", accessToken: "tok-E-aaaaaaaaaaaaa", accessLevel: "due_diligence", ndaSigned: true, revokedAt: null, expiresAt: later, createdAt: now },
];
const app = await vdrTestApp({ root, docs, deals, access, now });
const { f, call } = app;
const setupDeps = { store: f.store, enqueue: () => {}, now: () => now };
await setUpRoom("D", "b1", "auto", setupDeps);
await setUpRoom("E", "b2", "auto", setupDeps);
const itemOf = (docId: string) => f.items.find((i: any) => i.documentId === docId && !i.removedAt)!;
for (const it of f.items) {
  it.prepared = { status: "ready", kind: "image", forFile: "0123456789abcdef", pages: [{ w: 100, h: 140, hasText: true }], personal: { count: 0, kinds: [], pages: [] } };
  const dir = vdrCacheDir(it.dealId, it.id, "0123456789abcdef", root)!;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "p1.webp"), "webp");
}
await f.store.insertShares([{ dealId: "D", itemId: itemOf("t2").id, audience: "level", accessLevel: "due_diligence", buyerEmail: null, effect: "allow", createdBy: "test" }]);
await f.store.insertShares([{ dealId: "E", itemId: itemOf("e").id, audience: "level", accessLevel: "due_diligence", buyerEmail: null, effect: "allow", createdBy: "test" }]);

const B = "/api/deals/D/data-room";
const tokenOf = (link: string) => decodeURIComponent(link.split("/view/")[1].split("/")[0]);
let priyaToken = "";
let priyaId = "";

await test("input rules: name, email, five roles; never the buyer's own address; at most 5", () => {
  assert.deepEqual(parseTeamInput({ name: " Priya  Shah ", email: "Priya@Acct.invalid", role: "Accountant" }), { name: "Priya Shah", email: "priya@acct.invalid", role: "accountant" });
  assert.ok("error" in parseTeamInput({ name: "", email: "a@b.co", role: "lawyer" }));
  assert.ok("error" in parseTeamInput({ name: "A", email: "not-an-email", role: "lawyer" }));
  assert.ok("error" in parseTeamInput({ name: "A", email: "a@b.co", role: "ceo" }));
  const principal = { buyerEmail: "Jane@Northgate.invalid" };
  assert.match(teamAddProblem([], principal, { email: "jane@northgate.invalid" })!, /buyer's own address/);
  const five = Array.from({ length: TEAM_MAX }, (_, i) => ({ principalEmail: "jane@northgate.invalid", email: `p${i}@x.invalid`, status: "active" }));
  assert.match(teamAddProblem(five, principal, { email: "new@x.invalid" })!, /up to 5/);
  assert.match(teamAddProblem([{ principalEmail: "jane@northgate.invalid", email: "p@x.invalid", status: "requested" }], principal, { email: "p@x.invalid" })!, /already asked/);
  assert.equal(teamAddProblem([{ principalEmail: "jane@northgate.invalid", email: "p@x.invalid", status: "removed" }], principal, { email: "p@x.invalid" }), null, "a removed person can come back");
  const e = teamLinkEmail("Northgate Pharmacy Group");
  assert.match(e.message, /Northgate Pharmacy Group has invited you to review documents for a business they're considering/);
  assert.ok(!/Pacific/.test(e.subject + e.message), "never the business's name");
});

await test("the broker adds an accountant and copies the link (only a hash is stored)", async () => {
  const r = await call("POST", `${B}/buyers/dd/team`, { name: "Priya Shah", email: "priya@acct.invalid", role: "accountant", send: false }, "b1");
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.match(r.json.link, /^https:\/\/app\.example\.invalid\/view\/[A-Za-z0-9_-]{20,}\/data-room$/);
  assert.equal(r.json.emailed.sent, false);
  assert.equal(app.buyerEmails.length, 0, "Add and copy sends nothing");
  priyaToken = tokenOf(r.json.link);
  priyaId = r.json.id;
  const row = f.team.find((t: any) => t.id === priyaId);
  assert.equal(row.tokenHash, tokenHash(priyaToken));
  assert.ok(!JSON.stringify(f.team).includes(priyaToken), "the token itself is never stored");
  assert.equal(row.status, "active");
  assert.equal(row.principalEmail, "jane@northgate.invalid");
});

await test("first visit: the confidentiality step, then the buyer's room with their own name", async () => {
  const T = `/api/view/${priyaToken}/data-room`;
  let r = await call("GET", T);
  assert.equal(r.status, 403);
  assert.equal(r.json.code, "ack_required");
  assert.equal(r.json.principalCompany, "Northgate Pharmacy Group");
  assert.equal(r.json.role, "accountant");
  assert.equal((await call("GET", `${T}/items/${itemOf("t2").id}`)).status, 403, "nothing opens before the step");
  assert.equal((await call("POST", `${T}/acknowledge`, { name: "P" })).status, 400);
  assert.equal((await call("POST", `${T}/acknowledge`, { name: "Priya Shah" })).status, 200);
  const row = f.team.find((t: any) => t.id === priyaId);
  assert.ok(row.ackAt && row.ackName === "Priya Shah" && row.ackIpHash !== undefined);
  r = await call("GET", T);
  assert.equal(r.status, 200);
  assert.equal(r.json.reader.kind, "team");
  assert.equal(r.json.reader.principalCompany, "Northgate Pharmacy Group");
  assert.equal(r.json.team, undefined, "a team member never sees the team");
  assert.equal(r.json.canInviteTeam, false);
  const principal = await call("GET", "/api/view/tok-dd-aaaaaaaaaaaa/data-room");
  assert.deepEqual(r.json.items.map((i: any) => i.id).sort(), principal.json.items.map((i: any) => i.id).sort(), "exactly the buyer's documents");
  // Their own watermark: their name, for the buyer.
  const v = await call("POST", `${T}/views/start`, { itemId: itemOf("t2").id, source: "room" });
  assert.equal(v.status, 200);
  const page = await call("GET", `${T}/items/${itemOf("t2").id}/pages/1?w=700&v=${v.json.viewId}`);
  assert.equal(page.status, 200);
  const view = f.views.find((x: any) => x.id === v.json.viewId);
  assert.equal(view.teamMemberId, priyaId);
  assert.equal(view.buyerAccessId, "dd");
  // The view room answers their link with the data room (never the memorandum) — checked in vdr-routes; here: no adding people.
  assert.equal((await call("POST", `${T}/team`, { name: "Max", email: "max@x.invalid", role: "lawyer" })).status, 403);
});

await test("the buyer asks to add a lawyer → To do → Approve and send the link (one email, the broker's click)", async () => {
  const T = "/api/view/tok-dd-aaaaaaaaaaaa/data-room";
  const r = await call("POST", `${T}/team`, { name: "Max Lee", email: "max@law.invalid", role: "lawyer" });
  assert.equal(r.status, 200);
  assert.equal((await call("POST", `${T}/team`, { name: "Max Lee", email: "max@law.invalid", role: "lawyer" })).status, 409, "asked once");
  assert.equal(app.alerts.length > 0, true, "the broker is alerted in the app");
  const todo = await call("GET", `${B}/todo`, undefined, "b1");
  const row = todo.json.items.find((x: any) => x.kind === "team_request");
  assert.ok(row, "Waiting on you shows the ask");
  assert.match(row.text, /Northgate Pharmacy Group asked to add Max Lee \(lawyer, max@law\.invalid\)/);
  assert.equal(row.teamMemberName, "Max Lee");
  const room = await call("GET", T);
  assert.deepEqual(room.json.team.map((m: any) => [m.name, m.status]), [["Priya Shah", "active"], ["Max Lee", "requested"]]);
  assert.equal(room.json.canInviteTeam, true);
  const before = app.buyerEmails.length;
  const ok = await call("PATCH", `${B}/team/${row.teamMemberId}`, { action: "approve", send: true }, "b1");
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(app.buyerEmails.length, before + 1, "exactly one email");
  const mail = app.buyerEmails[app.buyerEmails.length - 1];
  assert.equal(mail.to, "max@law.invalid");
  assert.match(mail.subject, /Northgate Pharmacy Group invited you/);
  assert.ok(mail.html.includes(ok.json.link.replace(/&/g, "&amp;")), "their own link");
  assert.ok(!/Pacific/.test(mail.html), "never the business's name");
  const todo2 = await call("GET", `${B}/todo`, undefined, "b1");
  assert.ok(!todo2.json.items.some((x: any) => x.kind === "team_request"));
});

await test("Buyers lists the team under the buyer, with what each person opened", async () => {
  const r = await call("GET", `${B}/buyers`, undefined, "b1");
  const nb = r.json.eligible.find((b: any) => b.accessId === "dd");
  assert.deepEqual(nb.team.map((m: any) => [m.name, m.status, m.documentsOpened]), [["Priya Shah", "active", 1], ["Max Lee", "active", 0]]);
  assert.ok(nb.team[0].acknowledgedAt);
});

await test("a new link kills the old one; Remove kills the link", async () => {
  const fresh = await call("PATCH", `${B}/team/${priyaId}`, { action: "new_link" }, "b1");
  assert.equal(fresh.status, 200);
  const newToken = tokenOf(fresh.json.link);
  assert.notEqual(newToken, priyaToken);
  assert.equal((await call("GET", `/api/view/${priyaToken}/data-room`)).status, 404, "the old link is dead");
  assert.equal((await call("GET", `/api/view/${newToken}/data-room`)).status, 200, "the new link works (already acknowledged)");
  assert.equal((await call("PATCH", `${B}/team/${priyaId}`, { action: "remove" }, "b1")).status, 200);
  assert.equal((await call("GET", `/api/view/${newToken}/data-room`)).status, 404);
  const r = await call("GET", `${B}/buyers`, undefined, "b1");
  assert.ok(!r.json.eligible.find((b: any) => b.accessId === "dd").team.some((m: any) => m.id === priyaId));
});

await test("the buyer's access ends → their team's ends too", async () => {
  const max = f.team.find((t: any) => t.email === "max@law.invalid");
  const { newTeamToken } = await import("../../server/vdr/team");
  const { token, hash } = newTeamToken();
  max.tokenHash = hash;
  max.ackAt = now;
  assert.equal((await call("GET", `/api/view/${token}/data-room`)).status, 200);
  access[0].revokedAt = now;
  const r = await call("GET", `/api/view/${token}/data-room`);
  assert.equal(r.status, 403);
  assert.equal(r.json.code, "team_ended");
  assert.match(r.json.error, /Northgate Pharmacy Group's access to this data room has ended/);
  access[0].revokedAt = null;
});

await test("tenancy and eligibility: another deal's member → 404; a buyer without the room → 409; demo deals never send", async () => {
  const add = await call("POST", "/api/deals/E/data-room/buyers/E-dd/team", { name: "Ann", email: "ann@x.invalid", role: "adviser", send: true }, "b2");
  assert.equal(add.status, 200);
  assert.equal(add.json.emailed.demo, true, "demo deal: recorded, never sent");
  assert.equal(app.buyerEmails.filter((m: any) => m.to === "ann@x.invalid").length, 0);
  assert.equal((await call("PATCH", `${B}/team/${add.json.id}`, { action: "remove" }, "b1")).status, 404, "another deal's member");
  assert.equal((await call("POST", `${B}/buyers/E-dd/team`, { name: "Z", email: "z@x.invalid", role: "adviser" }, "b1")).status, 404, "another deal's link");
  assert.equal((await call("POST", `${B}/buyers/blind/team`, { name: "Z", email: "z@x.invalid", role: "adviser" }, "b1")).status, 409, "Blind CIM: no room");
  assert.equal((await call("POST", `${B}/buyers/dd/team`, { name: "Z", email: "z@x.invalid", role: "adviser" }, "b2")).status, 404, "another brokerage");
  // Five at most.
  for (let i = 0; i < 4; i++) await call("POST", `${B}/buyers/dd/team`, { name: `P${i}`, email: `p${i}@x.invalid`, role: "colleague" }, "b1");
  const sixth = await call("POST", `${B}/buyers/dd/team`, { name: "Six", email: "six@x.invalid", role: "colleague" }, "b1");
  assert.equal(sixth.status, 409);
  assert.match(sixth.json.error, /up to 5/);
});

app.close();
fs.rmSync(root, { recursive: true, force: true });
console.log(`\nvdr-team: ${passed} passed`);
