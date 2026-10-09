/**
 * gl spec §12.1 test 21 (D13, §8.1.4): after the broker publishes, what
 * buyers get is tightened against the current state every time it is
 * served — with no republish:
 *   delete the ledger / make it private      → its entries go, status only lowered
 *   untick a detail (showDetails false)      → the entry is withheld
 *   a new held name / a seller keep-out term → masked at serve time
 *   a data-room deny row                     → entries on request, totals kept
 *   a removed add-back                       → the line goes
 *   a year that no longer agrees             → the note stops naming it
 * and loosening (a better status, a new line) waits for the broker.
 */
import assert from "node:assert/strict";
import { test, done } from "./_harness";
import { tightenPublished, projectEvidence, noteFor, type TightenCurrent } from "../../server/gl/evidence";
import type { GlPublishedEvidence, GlSnapshotLine } from "../../shared/gl-evidence";
import { keepOutFromNotes } from "../../server/cim/sensitive-facts";

const entry = (i: number, over: Partial<GlSnapshotLine["years"][number]["entries"][number]> = {}) => ({
  linkId: `k${i}`, ledgerId: "L1", rowNo: 100 + i, date: `2024-0${(i % 9) + 1}-01`, account: "Vehicle – Owner", name: "Lexus Financial", memo: `Lease ${i}`,
  amountCents: 115_000, showDetails: null, ...over,
});

function snapshot(): GlPublishedEvidence {
  const vehicles: GlSnapshotLine = {
    traceId: "t1", addbackKey: "owner vehicles", lineId: "line00000001", label: "Owner vehicles", status: "found",
    parties: [{ first: "dan", last: "moretti" }], personal: true, share: null, why: "Personal vehicle.", brokerNote: null, sellerNote: null,
    years: [{ year: "2024", yearLabel: "FY2024", claimedCents: 1_380_000, targetCents: 1_380_000, documentCents: 0, status: "found", docs: [],
      entries: Array.from({ length: 12 }, (_, i) => entry(i)) }],
    statementDocs: [],
  };
  const pay: GlSnapshotLine = {
    traceId: "t2", addbackKey: "owner pay", lineId: "line00000002", label: "Owner pay", status: "document",
    parties: [{ first: "dan", last: "moretti" }], personal: true, share: null, why: null, brokerNote: null, sellerNote: null,
    years: [{ year: "2024", yearLabel: "2024", claimedCents: 24_000_000, targetCents: 24_000_000, documentCents: 24_000_000, status: "document", entries: [],
      docs: [{ documentId: "T4", label: "T4 2024", year: "2024", amountCents: 24_000_000, check: "found_in_document" }] }],
    statementDocs: [],
  };
  const pharmacy: GlSnapshotLine = {
    traceId: "t3", addbackKey: "personal expenses", lineId: "line00000003", label: "Personal expenses", status: "found",
    parties: [], personal: true, share: null, why: null, brokerNote: null, sellerNote: null,
    years: [{ year: "2024", yearLabel: "2024", claimedCents: 50_000, targetCents: 50_000, documentCents: 0, status: "found", docs: [],
      entries: [
        entry(1, { linkId: "p1", account: "Shareholder expenses", name: "Shoppers Drug Mart", memo: "Prescription", amountCents: 25_000 }),
        entry(2, { linkId: "p2", account: "Shareholder expenses", name: "Harvest Lane Markets", memo: "Gift basket", amountCents: 25_000 }),
      ] }],
    statementDocs: [],
  };
  return {
    v: 1, publishedAt: "2025-03-05T00:00:00.000Z", publishedBy: "b", versions: { dd: true, normal: true, blind: true }, leaveOut: [], pageId: "glsec_abc",
    noteYears: ["2024"], ledgers: [{ ledgerId: "L1", documentId: "D1", software: "quickbooks_online", period: "Jan 2024–Dec 2024", showStaffNames: false }],
    tieOut: [{ year: "2024", state: "agrees" }], confirmation: { role: "owner", at: "2025-03-01T00:00:00.000Z" },
    lines: [vehicles, pay, pharmacy],
  };
}

const current = (over: Partial<TightenCurrent> = {}): TightenCurrent => ({
  liveLedgerIds: new Set(["L1"]),
  showStaffNames: new Map([["L1", false]]),
  liveDocIds: new Set(["T4", "D1"]),
  showDetails: new Map(),
  liveKeys: new Set(["owner vehicles", "owner pay", "personal expenses"]),
  agreeYears: new Set(["2024"]),
  ...over,
});
const ctx = { staffNames: [], heldNames: [] as string[] };

await test("nothing changed → nothing tightened", () => {
  const r = tightenPublished(snapshot(), current());
  assert.deepEqual(r.changes, []);
  assert.deepEqual(r.snapshot.lines.map((l) => l.status), ["found", "document", "found"]);
});

await test("the ledger deleted or made private: its entries go at once and the status is lowered", () => {
  const r = tightenPublished(snapshot(), current({ liveLedgerIds: new Set() }));
  const v = r.snapshot.lines.find((l) => l.addbackKey === "owner vehicles")!;
  assert.equal(v.years[0].entries.length, 0);
  assert.equal(v.status, "not_found");
  assert.equal(r.snapshot.lines.find((l) => l.addbackKey === "owner pay")!.status, "document", "a document-supported line keeps its status");
  assert.ok(r.changes.some((c) => /removed or made private/.test(c)));
  assert.equal(r.snapshot.ledgers.length, 0);
  const p = projectEvidence(r.snapshot, "dd", ctx)!;
  assert.ok(!JSON.stringify(p).includes("Lexus"));
});

await test("a supporting document deleted: no longer cited, status lowered", () => {
  const r = tightenPublished(snapshot(), current({ liveDocIds: new Set(["D1"]) }));
  const pay = r.snapshot.lines.find((l) => l.addbackKey === "owner pay")!;
  assert.equal(pay.years[0].docs.length, 0);
  assert.equal(pay.status, "not_found");
});

await test("an entry unticked for buyers (showDetails false) is withheld; showing needs both the published and the current choice", () => {
  const snap = snapshot();
  snap.lines[0].years[0].entries[0].showDetails = true;
  const r = tightenPublished(snap, current({ showDetails: new Map([["k0", false]]) }));
  const p = projectEvidence(r.snapshot, "dd", ctx)!;
  const e = p.lines[0].years![0].entries[0];
  assert.equal(e.withheld, "keep_out");
  assert.equal(e.name, null);
  assert.equal(e.account, "Vehicle – Owner", "date, account and amount stay");
  assert.equal(e.amount, 1150);
  const r2 = tightenPublished(snap, current({ showDetails: new Map([["k0", null]]) }));
  assert.equal(r2.snapshot.lines[0].years[0].entries[0].showDetails, null, "a reset to the rules is a tightening too");
});

await test("personal entries and a new held / keep-out name are masked at serve time", () => {
  const r = tightenPublished(snapshot(), current());
  const plain = projectEvidence(r.snapshot, "dd", ctx)!;
  const ph = plain.lines.find((l) => l.label === "Personal expenses")!.years![0].entries;
  assert.equal(ph[0].withheld, "personal", "a pharmacy on a shareholder account");
  assert.equal(ph[0].memo, "Personal expense — details withheld");
  assert.equal(ph[1].withheld, undefined);
  const held = projectEvidence(r.snapshot, "dd", { staffNames: [], heldNames: ["Harvest Lane"] })!;
  const h = held.lines.find((l) => l.label === "Personal expenses")!.years![0].entries[1];
  assert.equal(h.withheld, "keep_out");
  assert.ok(!JSON.stringify(held).includes("Harvest Lane"));
});

await test("a data-room deny on the ledger: entries on request, totals kept", () => {
  const r = tightenPublished(snapshot(), current());
  const p = projectEvidence(r.snapshot, "dd", { ...ctx, withheldLedgerDocs: new Set(["D1"]) })!;
  const y = p.lines[0].years![0];
  assert.equal(y.entries.length, 0);
  assert.equal(y.entriesOnRequest, true);
  assert.equal(y.entryCount, 12);
  assert.equal(y.found, 13_800);
});

await test("a removed add-back goes; a year that no longer agrees leaves the note", () => {
  const r = tightenPublished(snapshot(), current({ liveKeys: new Set(["owner pay", "personal expenses"]), agreeYears: new Set() }));
  assert.equal(r.snapshot.lines.length, 2);
  assert.deepEqual(r.snapshot.noteYears, []);
  assert.ok(!/agrees with the financial statements/.test(noteFor(r.snapshot) ?? ""));
  assert.ok(r.changes.some((c) => /no longer in the analysis/.test(c)));
  const blind = projectEvidence(r.snapshot, "blind", ctx)!;
  assert.equal(blind.lines.find((l) => l.lineId === "line00000003")!.mark, false, "no mark on a ledger line without agreeing years");
  assert.equal(blind.lines.find((l) => l.lineId === "line00000002")!.mark, true, "a year shown by a T4 needs no tie-out");
});

await test("never loosened: a status can only go down", () => {
  const snap = snapshot();
  snap.lines[0].status = "partly_found";
  const r = tightenPublished(snap, current());
  assert.equal(r.snapshot.lines[0].status, "partly_found", "the full entries don't raise it — that waits for a republish");
  snap.lines[0].years[0].entries = snap.lines[0].years[0].entries.slice(0, 1);
  const r2 = tightenPublished(snap, current());
  assert.equal(r2.snapshot.lines[0].status, "partly_found");
});

await test("staff: an unknown employee's name on a wages account is withheld; the add-back's own party is shown; the switch shows names", () => {
  const snap = snapshot();
  snap.lines[1].years[0].entries = [
    entry(1, { linkId: "w1", account: "Wages & Salaries", name: "Payroll — M. Chen", memo: "Biweekly pay" }),
    entry(2, { linkId: "w2", account: "Wages & Salaries", name: "Payroll — D. Moretti", memo: "Salary" }),
  ];
  const r = tightenPublished(snap, current());
  const p = projectEvidence(r.snapshot, "dd", ctx)!;
  const es = p.lines.find((l) => l.label === "Owner pay")!.years![0].entries;
  assert.equal(es[0].withheld, "staff");
  assert.equal(es[0].memo, "Employee pay — name withheld");
  assert.equal(es[1].withheld, undefined, "the owner on his own pay");
  snap.ledgers[0].showStaffNames = true;
  const r2 = tightenPublished(snap, current({ showStaffNames: new Map([["L1", true]]) }));
  assert.equal(projectEvidence(r2.snapshot, "dd", ctx)!.lines.find((l) => l.label === "Owner pay")!.years![0].entries[0].withheld, undefined);
  const r3 = tightenPublished(snap, current());
  assert.equal(projectEvidence(r3.snapshot, "dd", ctx)!.lines.find((l) => l.label === "Owner pay")!.years![0].entries[0].withheld, "staff", "switched off since → withheld again");
});

await test("a version that's off gives nothing", () => {
  const snap = snapshot();
  snap.versions = { dd: true, normal: false, blind: false };
  assert.equal(projectEvidence(snap, "normal", ctx), null);
  assert.equal(projectEvidence(snap, "blind", ctx), null);
  assert.ok(projectEvidence(snap, "dd", ctx));
});

// ── Fixer round 1 (GL-R1-01): the published words are screened again at serve time ──

function snapshotWithWords(): GlPublishedEvidence {
  const snap = snapshot();
  snap.versions = { dd: true, normal: true, blind: false };
  snap.tieOut = [{ year: "2024", state: "accepted", difference: 4100, note: "Karen Holt's year-end entry is not in the export." }];
  snap.lines[0] = {
    ...snap.lines[0],
    label: "Employment settlement — Karen Holt",
    why: "One-time payment to Karen Holt when her employment ended.",
    brokerNote: "Karen Holt signed a release.",
    sellerNote: "We paid Karen once, in July.",
  };
  return snap;
}
const karen = ["Karen Holt"];

await test("GL-R1-01: a name held back AFTER publishing leaves the label, the reasons, both notes and the tie-out note at once (tightening, with changes for the broker)", () => {
  const r = tightenPublished(snapshotWithWords(), current({ heldNames: karen, info: {} }));
  const l = r.snapshot.lines[0];
  assert.ok(!/Karen/.test(l.label), l.label);
  assert.equal(l.why, null);
  assert.equal(l.brokerNote, null);
  assert.equal(l.sellerNote, null, "the given name alone counts");
  assert.equal(r.snapshot.tieOut[0].note, null);
  assert.equal(r.snapshot.tieOut[0].state, "accepted", "the accepted difference stays — only the note goes");
  for (const re of [/now reads/, /"Why it's added back" is no longer shown/, /your note is no longer shown/, /the seller's explanation is no longer shown/, /accepted difference is no longer shown/]) {
    assert.ok(r.changes.some((c) => re.test(c)), `change logged: ${re}`);
  }
  for (const mode of ["dd", "normal"] as const) {
    const p = projectEvidence(r.snapshot, mode, { staffNames: karen, heldNames: karen })!;
    assert.ok(p, mode);
    assert.ok(!JSON.stringify(p).includes("Karen"), `${mode} payload names nobody held`);
  }
});

await test("GL-R1-01: the payload's own last pass holds them even when the caller's tightening didn't know the name (the checker's case)", () => {
  const t = tightenPublished(snapshotWithWords(), current()).snapshot; // no held names known to tightening
  for (const mode of ["dd", "normal"] as const) {
    const p = projectEvidence(t, mode, { staffNames: karen, heldNames: karen })!;
    assert.ok(!JSON.stringify(p).includes("Karen Holt"), `${mode}`);
    assert.ok(!JSON.stringify(p).includes("Karen"), `${mode}: given name alone too`);
  }
  const dd = projectEvidence(t, "dd", { staffNames: karen, heldNames: karen })!;
  assert.equal(dd.lines[0].why, null);
  assert.equal(dd.lines[0].brokerNote, null);
  assert.equal(dd.tieOut![0].note, null);
  assert.equal(dd.tieOut![0].state, "accepted");
});

await test("GL-R1-01: a seller keep-out request or a staff-private matter recorded after publishing hides the text (facts at serve time)", () => {
  const snap = snapshot();
  snap.lines[0] = { ...snap.lines[0], why: "Paid for the Harvest Lane Markets bid team's dinners.", brokerNote: "Harvest Lane Markets is the RFP." };
  const info = { salesPipeline: "Shortlisted for the Harvest Lane Markets RFP.", _brokerPrivateNotes: ["Harvest Lane Markets RFP — keep out of the CIM."] };
  const r = tightenPublished(snap, current({ info, heldNames: [] }));
  assert.equal(r.snapshot.lines[0].why, null);
  assert.equal(r.snapshot.lines[0].brokerNote, null);
  // Served as buyers get it (held names as loadEvidenceState reads them: the keep-out parties too).
  const heldNow = keepOutFromNotes(info).names;
  assert.deepEqual(heldNow, ["Harvest Lane Markets"]);
  const p = projectEvidence(r.snapshot, "dd", { staffNames: [], heldNames: heldNow, deal: { businessName: "Brightwater", extractedInfo: info, blindCodename: "Project X" } as any })!;
  assert.ok(!JSON.stringify(p).includes("Harvest Lane"));
  // Nothing held → the words stay as published.
  const clean = tightenPublished(snapshotWithWords(), current({ heldNames: [], info: {} }));
  assert.equal(clean.snapshot.lines[0].why, "One-time payment to Karen Holt when her employment ended.");
  assert.deepEqual(clean.changes, []);
});

// ── GL-R1-02: a data-room deny on ONE of two files ──

await test("GL-R1-02: entries from two files in one year — the denied file's entries go, the other's stay, totals kept, 'on request' said", () => {
  const snap = snapshot();
  snap.ledgers.push({ ledgerId: "L2", documentId: "D2", software: null, period: "", showStaffNames: false });
  snap.lines[0].years[0].entries = [
    entry(1, { linkId: "a1", ledgerId: "L1", name: "VendorL1", amountCents: 690_000 }),
    entry(2, { linkId: "a2", ledgerId: "L2", name: "VendorL2", amountCents: 690_000 }),
  ];
  const t = tightenPublished(snap, current({ liveLedgerIds: new Set(["L1", "L2"]) })).snapshot;
  const p = projectEvidence(t, "dd", { ...ctx, withheldLedgerDocs: new Set(["D2"]) })!;
  const y = p.lines[0].years![0];
  assert.deepEqual(y.entries.map((e) => e.name), ["VendorL1"]);
  assert.ok(!JSON.stringify(p).includes("VendorL2"));
  assert.equal(y.entriesOnRequest, true);
  assert.equal(y.entriesHeld, 1);
  assert.equal(y.entryCount, 2);
  assert.equal(y.found, 13_800, "the totals keep both files' entries");
  assert.equal(y.moreEntries, 0);
  // Nothing denied → both, no 'on request'.
  const all = projectEvidence(t, "dd", ctx)!.lines[0].years![0];
  assert.deepEqual(all.entries.map((e) => e.name), ["VendorL1", "VendorL2"]);
  assert.equal(all.entriesOnRequest, undefined);
  // Both denied → none listed.
  const none = projectEvidence(t, "dd", { ...ctx, withheldLedgerDocs: new Set(["D1", "D2"]) })!.lines[0].years![0];
  assert.equal(none.entries.length, 0);
  assert.equal(none.entriesHeld, 2);
});

done("tighten published");
