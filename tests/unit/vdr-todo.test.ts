/**
 * vdr spec §5.8: "Waiting on you" — every kind of item, in the spec's order,
 * with plain words; set-aside items stay set aside; a pasted list is one row.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled DISABLE_SCHEDULERS=1 npx tsx tests/unit/vdr-todo.test.ts
 */
import assert from "node:assert/strict";

process.env.DISABLE_SCHEDULERS = "1";
const { waitingItems, askerLabel, buyerLabelFor } = await import("../../server/vdr/todo");

const now = new Date("2026-10-09T12:00:00Z");
const ago = (days: number) => new Date(now.getTime() - days * 86_400_000);
const northgate: any = { id: "dd", dealId: "D", buyerEmail: "Jane@Northgate.invalid", buyerName: "Jane", buyerCompany: "Northgate Pharmacy Group", accessLevel: "due_diligence", createdAt: now };
const groups: any[] = [{ key: "jane@northgate.invalid", rows: [northgate], eligible: northgate, hasRoom: true, setting: null }];
const row = (id: string, extra: any = {}): any => ({
  id, folderId: "F1", documentId: `doc-${id}`, number: `1.2.${id.length}`, title: `Title ${id}`, position: 1, addedBy: "auto", addedAt: ago(1).toISOString(),
  doc: { name: `Doc ${id}` }, sizeLabel: "PDF", prepared: null, flags: [], unchecked: [], checked: null,
  sharing: { shared: false, levels: [], buyers: 0, hiddenFrom: 0, label: "Not shared", allow: [], deny: [] },
  downloadable: false, downloadOriginal: false, downloadLabel: "View only", cleanCopy: null, opened: { buyers: 0, activeMs: 0, lastAt: null },
  isLedger: false, newVersion: null, removed: null, summary: { text: null, points: [], source: null, status: null, hidden: false, basic: "Document." }, fileVersion: 1, ...extra,
});
const shared = { shared: true, levels: ["due_diligence"], buyers: 0, hiddenFrom: 0, label: "Due diligence buyers", allow: [], deny: [] };
const items = [
  row("old", { removed: null, sharing: shared }),
  row("nv", { newVersion: { replaces: "old", oldWasShared: true } }),
  row("hint"),
  row("flag", { flags: [{ key: "staff_records", look: true, copy: "Staff or pay records" }], unchecked: ["staff_records"], sharing: shared }),
  row("desc", { sharing: shared, summary: { text: "A T2 return.", points: [], source: "ai", status: "drafted", hidden: false, basic: "Document." } }),
  row("gone", { removed: { at: ago(2).toISOString(), reason: "seller_removed", wasShared: true, buyersCouldOpen: 2 } }),
];
const rawItems: any[] = [
  { id: "old", folderId: "F1", removedAt: null },
  { id: "nv", folderId: "F1", removedAt: null, replacesItemId: "old" },
  { id: "hint", folderId: "F1", removedAt: null },
  { id: "flag", folderId: "F1", removedAt: null },
  { id: "desc", folderId: "F1", removedAt: null },
];
const shares: any[] = ["old", "flag", "desc"].map((itemId) => ({ itemId, audience: "level", accessLevel: "due_diligence", buyerEmail: null, effect: "allow" }));
const requests: any[] = [
  { id: "r1", dealId: "D", buyerEmail: "jane@northgate.invalid", teamMemberId: null, listId: null, kind: "document", text: "Most recent AR aging (June 2026)", status: "open", createdAt: ago(2) },
  ...Array.from({ length: 34 }, (_, k) => ({ id: `l${k}`, dealId: "D", buyerEmail: "jane@northgate.invalid", teamMemberId: null, listId: "L", kind: "document", text: `Item ${k}`, status: k < 30 ? "open" : "asked_seller", createdAt: ago(3) })),
  { id: "r2", dealId: "D", buyerEmail: "jane@northgate.invalid", teamMemberId: "tm1", listId: null, kind: "document", text: "Bank statements", status: "ready_to_share", readyDocumentId: "up1", createdAt: ago(1) },
  { id: "r3", dealId: "D", buyerEmail: "jane@northgate.invalid", teamMemberId: null, listId: null, kind: "room_access", text: "Access to the data room", status: "open", createdAt: ago(0.1) },
];
const questions: any[] = [
  { id: "q1", status: "pending_broker", vdrItemId: "old", vdrPage: 3, vdrTeamMemberId: "tm1", buyerAccessId: "dd", createdAt: now },
  { id: "q2", status: "published", vdrItemId: "old", vdrPage: null, vdrTeamMemberId: null, buyerAccessId: "dd", createdAt: now },
  { id: "q3", status: "pending_broker", vdrItemId: null, buyerAccessId: "dd", createdAt: now },
];
const team: any[] = [{ id: "tm1", name: "Priya Shah", role: "accountant", principalEmail: "jane@northgate.invalid" }];
const buyers: any[] = [{ key: "jane@northgate.invalid", accessId: "dd", name: "Jane", company: "Northgate Pharmacy Group", email: "Jane@Northgate.invalid", hasRoom: true, endsInDays: 3, expiresAt: now.toISOString() }];
const input = {
  now, items, rawItems, shares, groups, buyers, accessRows: [northgate], requests, questions, team,
  folders: [{ id: "F1", number: "1.2", name: "Tax returns", shareHint: { levels: ["due_diligence"] } }],
  dismissed: new Set<string>(),
  ddCited: { available: true, total: 9, notShared: 6 },
  docNames: new Map([["up1", "Bank statements 2026"]]),
};
const out = waitingItems(input as any);
const kinds = out.map((x) => x.kind);
assert.deepEqual(Array.from(new Set(kinds)), ["request", "request_ready", "question", "new_version", "hinted", "flag", "dd_cited", "descriptions", "link_ending", "seller_removed"], "the spec's order");
const text = (k: string) => out.filter((x) => x.kind === k).map((x) => x.text);
assert.equal(out.filter((x) => x.kind === "request").length, 3, "the pasted list is one row");
assert.ok(text("request").some((t) => /^Northgate Pharmacy Group sent a list of 34 requests \(30 still open\)/.test(t)));
assert.ok(text("request").some((t) => t.startsWith("Northgate Pharmacy Group asked for: 'Most recent AR aging (June 2026)' · 2 days ago")));
assert.ok(text("request").some((t) => /asked for access to the data room/.test(t)));
assert.deepEqual(text("request_ready"), ["The seller uploaded 'Bank statements 2026' that Northgate Pharmacy Group asked for."]);
assert.deepEqual(text("question"), ["Priya Shah (Northgate Pharmacy Group's accountant) asked about 1.2.3 Title old page 3"], "only document questions waiting for the broker");
assert.match(text("new_version")[0], /^New version from the seller: 'Title nv'\. The old one was shared with 1 buyer\.$/);
assert.deepEqual(text("hinted"), ["New in 1.2 Tax returns: 'Title hint'. Share it like the rest?"]);
assert.equal(out.find((x) => x.kind === "flag")!.shared, true);
assert.equal(text("dd_cited")[0], "The DD CIM points to 9 documents. 6 aren't shared with due diligence buyers.");
assert.equal(text("descriptions")[0], "Cimple wrote descriptions for 1 shared document. Buyers see a basic line until you accept it.");
assert.equal(text("link_ending")[0], "Northgate Pharmacy Group's access ends in 3 days.");
assert.equal(text("seller_removed")[0], "The seller removed 'Title gone', which 2 buyers could open.");

// Set aside: "Not now" on the hinted file and the DD line.
const later = waitingItems({ ...input, dismissed: new Set(["hint:hint", "dd_cited"]) } as any);
assert.ok(!later.some((x) => x.kind === "hinted" || x.kind === "dd_cited"));
// No DD registry yet → no DD line.
assert.ok(!waitingItems({ ...input, ddCited: { available: false, total: 0, notShared: 0 } } as any).some((x) => x.kind === "dd_cited"));
// Labels.
assert.equal(askerLabel("Northgate", null), "Northgate");
assert.equal(buyerLabelFor("nobody@x.invalid", groups, [northgate]), "nobody@x.invalid");

console.log("vdr-todo: all passed");
