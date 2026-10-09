/**
 * The data room's checker round 2 fixes (checks/vdr-r2.md). No AI, no DB.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled DISABLE_SCHEDULERS=1 npx tsx tests/unit/vdr-checker-r2.test.ts
 *
 *  R2-1 / R2-5  key figures (in vdr-checker-r1.test.ts, beside the F3 cases)
 *  R2-2  the demo seed's --all-demo (in vdr-demo-seed.test.ts)
 *  R2-3  a broker who skipped "Who sees what" is brought back to it: the
 *        first To do row while nothing is shared ("Choose" / "Not now"),
 *        gone once the plan is confirmed or anything is shared
 *  R2-4  the KPI strip's cells are top-aligned (a cell without a sub-line
 *        lines up with the rest); the loading strip has the same grid
 *  R2-6  one time zone on the viewer: the footer burned into each page says
 *        "viewed by … on <date, time> UTC", the line under it says UTC too
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
(globalThis as any).React = React; // tsx compiles the client's JSX to React.createElement

const root = fs.mkdtempSync(path.join(os.tmpdir(), "vdr-r2-"));
process.env.UPLOADS_DIR = root;
process.env.DISABLE_SCHEDULERS = "1";
process.env.ANTHROPIC_API_KEY = "disabled";

const { waitingItems } = await import("../../server/vdr/todo");
const { watermarkFooter, watermarkLine, watermarkWhen } = await import("../../shared/vdr");
const { vdrTestApp } = await import("./vdr-app-harness");
const { setUpRoom } = await import("../../server/vdr/setup");
const { RoomKpis } = await import("../../client/src/components/vdr/broker/parts");

let passed = 0;
const ok = (name: string) => { passed++; console.log(`  ✓ ${name}`); };

// ── R2-3: the sharing plan comes back as the first To do row ──
const now = new Date("2026-10-09T12:00:00Z");
const row = (id: string, shared: boolean): any => ({
  id, folderId: "F1", documentId: `doc-${id}`, number: "1.1.1", title: `Title ${id}`, position: 1, addedBy: "auto", addedAt: now.toISOString(),
  doc: { name: `Doc ${id}` }, sizeLabel: "PDF", prepared: null, flags: [], unchecked: [], checked: null,
  sharing: shared ? { shared: true, levels: ["due_diligence"], buyers: 0, hiddenFrom: 0, label: "Due diligence buyers", allow: [], deny: [] } : { shared: false, levels: [], buyers: 0, hiddenFrom: 0, label: "Not shared", allow: [], deny: [] },
  downloadable: false, downloadOriginal: false, downloadLabel: "View only", cleanCopy: null, opened: { buyers: 0, activeMs: 0, lastAt: null },
  isLedger: false, newVersion: null, removed: null, summary: { text: null, points: [], source: null, status: null, hidden: false, basic: "Document." }, fileVersion: 1,
});
const base = {
  now, rawItems: [], shares: [], groups: [], buyers: [], accessRows: [], questions: [], team: [], folders: [],
  dismissed: new Set<string>(), ddCited: { available: false, total: 0, notShared: 0 },
  requests: [{ id: "r1", dealId: "D", buyerEmail: "jane@n.invalid", teamMemberId: null, listId: null, kind: "document", text: "AR aging", status: "open", createdAt: now }],
};
let w = waitingItems({ ...base, items: [row("a", false), row("b", false)], planApplied: false } as any);
assert.equal(w[0].kind, "plan", `first: ${w.map((x) => x.kind).join(", ")}`);
assert.equal(w[0].key, "plan");
assert.equal(w[0].text, "Choose who sees what. Nothing in the data room is shared with buyers yet.");
assert.equal(w[1].kind, "request", "then everything else, in order");
assert.ok(!waitingItems({ ...base, items: [row("a", false)], planApplied: true } as any).some((x) => x.kind === "plan"), "plan confirmed: no row");
assert.ok(!waitingItems({ ...base, items: [row("a", true), row("b", false)], planApplied: false } as any).some((x) => x.kind === "plan"), "something shared already: no row");
assert.ok(!waitingItems({ ...base, items: [], planApplied: false } as any).some((x) => x.kind === "plan"), "an empty room: no row");
assert.ok(!waitingItems({ ...base, items: [row("a", false)], planApplied: false, dismissed: new Set(["plan"]) } as any).some((x) => x.kind === "plan"), "'Not now' sets it aside");
assert.ok(!waitingItems({ ...base, items: [row("a", false)] } as any).some((x) => x.kind === "plan"), "callers that don't know: no row");
ok("R2-3: 'Choose who sees what' leads the list while nothing is shared and the plan wasn't confirmed");

// Over HTTP: set up (auto) and skip the plan → the row; "Not now" accepted; confirming the plan clears it.
fs.mkdirSync(path.join(root, "docs"), { recursive: true });
fs.writeFileSync(path.join(root, "docs", "t2.pdf"), "x");
const later = new Date("2026-11-30T00:00:00Z");
const deal: any = { id: "D", brokerId: "b1", businessName: "Beacon Test", isLive: true, demoKey: "t", extractedInfo: {} };
const app = await vdrTestApp({
  root, now,
  docs: [{ id: "t2", dealId: "D", name: "T2 2023", originalName: "t2.pdf", category: "financials", fileUrl: "/uploads/docs/t2.pdf", mimeType: "application/pdf", createdAt: now }],
  deals: [deal],
  access: [{ id: "dd", dealId: "D", buyerEmail: "jane@n.invalid", buyerName: "Jane", buyerCompany: "Northgate", accessToken: "tok-dd-xxxxxxxxxx", accessLevel: "due_diligence", ndaSigned: true, revokedAt: null, expiresAt: later, createdAt: now }],
});
await setUpRoom("D", "b1", "auto", app.setupDeps);
let r = await app.call("GET", "/api/deals/D/data-room/todo", undefined, "b1");
assert.equal(r.status, 200, JSON.stringify(r.json));
assert.equal(r.json.items[0]?.kind, "plan", JSON.stringify(r.json.items.map((x: any) => x.kind)));
r = await app.call("GET", "/api/deals/D/data-room", undefined, "b1");
assert.equal(r.json.room.planAppliedAt, null);
assert.equal(r.json.kpis.waiting >= 1, true, "it counts in 'Waiting on you'");
r = await app.call("POST", "/api/deals/D/data-room/todo/dismiss", { key: "plan" }, "b1");
assert.equal(r.status, 200, JSON.stringify(r.json));
r = await app.call("GET", "/api/deals/D/data-room/todo", undefined, "b1");
assert.ok(!r.json.items.some((x: any) => x.kind === "plan"), "set aside after 'Not now'");
r = await app.call("POST", "/api/deals/D/data-room/todo/dismiss", { key: "nonsense" }, "b1");
assert.equal(r.status, 400, "other keys are still refused");
// A second deal of the same broker would get its own row; here: confirm the plan with nothing shared → never back.
const plan = await app.call("GET", "/api/deals/D/data-room/plan", undefined, "b1");
assert.equal(plan.status, 200, JSON.stringify(plan.json));
r = await app.call("POST", "/api/deals/D/data-room/plan", { folders: plan.json.folders.map((f: any) => ({ folderId: f.folderId, levels: [] })) }, "b1");
assert.equal(r.status, 200, JSON.stringify(r.json));
r = await app.call("GET", "/api/deals/D/data-room", undefined, "b1");
assert.ok(r.json.room.planAppliedAt, "the plan is confirmed (nothing shared, by choice)");
ok("R2-3: over HTTP — the row after a skipped plan, 'Not now' accepted, gone once the plan is confirmed");

// ── R2-4: the KPI strip lines up ──
const kpis: any = { inRoom: 9, shared: 4, buyersWithAccess: 1, openedThisWeek: { documents: 2, buyers: 1 }, waiting: 3, missingRequired: 5, sharedByLevel: {}, roomBuyersByLevel: {}, ddCitedNotShared: 0 };
const html = renderToStaticMarkup(React.createElement(RoomKpis, { kpis, onGo: () => {} }));
const buttons = html.match(/<button[^>]*>/g) ?? [];
assert.equal(buttons.length, 5);
for (const b of buttons) assert.match(b, /flex flex-col items-stretch justify-start/, `every cell top-aligned: ${b}`);
assert.match(html, /grid grid-cols-3 [^"]*md:grid-cols-5/, "3 on phones, 5 from md");
const tab = fs.readFileSync(path.join(process.cwd(), "client/src/pages/broker/deal/DataRoomTab.tsx"), "utf8");
const skeleton = /room\.isLoading[\s\S]{0,400}?className="(grid [^"]+)"/.exec(tab);
assert.ok(skeleton, "the loading strip");
assert.match(skeleton![1], /\bgrid-cols-3\b/, `the loading strip has the strip's phone grid: ${skeleton![1]}`);
assert.match(skeleton![1], /\bmd:grid-cols-5\b/);
ok("R2-4: KPI cells top-aligned; the loading strip uses the same 3/5 grid");

// ── R2-6: one time zone, named ──
const at = new Date("2026-10-09T18:53:07Z");
assert.equal(watermarkWhen(at), "Oct 9, 2026, 18:53 UTC");
assert.equal(watermarkFooter({ email: "jane@n.invalid", at, firm: "Brassline Advisory" }), "Confidential · viewed by jane@n.invalid on Oct 9, 2026, 18:53 UTC · shared by Brassline Advisory");
assert.equal(watermarkFooter({ email: "jane@n.invalid", at }), "Confidential · viewed by jane@n.invalid on Oct 9, 2026, 18:53 UTC");
assert.ok(!/shared with/.test(watermarkFooter({ email: "x@y.invalid", at, firm: "F" })), "never 'shared with … on' (it is the viewing date)");
// A view that starts late in the evening in Ottawa is the next day in UTC: the footer says UTC, like the trace line.
const late = new Date("2026-10-10T03:53:00Z");
assert.match(watermarkFooter({ email: "x@y.invalid", at: late }), /Oct 10, 2026, 03:53 UTC/);
assert.match(watermarkLine({ email: "x@y.invalid", at: late, trace: "ABC" }), /2026-10-10 03:53 UTC/, "the same basis as the trace line");
const room = fs.readFileSync(path.join(process.cwd(), "client/src/pages/buyer/BuyerDataRoom.tsx"), "utf8");
assert.match(room, /\{watermarkWhen\(new Date\(\)\)\}/, "the line under the page says UTC too");
assert.ok(!/toLocaleString\(undefined, \{ month: "short"/.test(room), "no local-time stamp beside the UTC one");
ok("R2-6: the burned-in footer and the line under it both say UTC; 'viewed by', never 'shared with … on'");

app.close();
fs.rmSync(root, { recursive: true, force: true });
console.log(`\nvdr-checker-r2: ${passed} passed`);
