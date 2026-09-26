// Merge discrepancies (only real disputes, deduplicated, kept true) and the
// private-notes review (round V, stream f-conflicts-notes) — offline: storage
// is stubbed in memory, no database, no model.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/information/conflicts-notes-v.test.ts
import assert from "node:assert/strict";
import { storage } from "../../server/storage";
import { mergeExtractedData } from "../../server/documents/extractor";
import { addPrivateNotes, refreshSourceNotes } from "../../server/documents/ingest";
import { materiallyDifferent, settleConflicts, type MergeConflict } from "../../server/documents/merge-policy";
import { falseConflictReason, shareClaimsConflict, sumOfPartsMatches } from "../../server/documents/conflict-measures";
import {
  discrepancyForConflict, factsFalseReason, planMergeRowSupersession, recordMergeConflicts, sameConflict, staleMergeRowReason,
} from "../../server/documents/merge-conflicts";
import { mergeDiscrepancyConflicts } from "../../server/interview/source-context";
import {
  adoptFoldedWordings, applyNotesReview, collectNoteItems, currentGroups, emptyReview, inventedDetails, isDroppableNote, isPromotableFact,
  isPromotableNote, keepsEveryDetail, recordPlacements, settleRejects, MOVED_FROM_NOTES, type NotesReview, type ReviewDoc,
} from "../../server/documents/private-notes-review";
import { addPrivateNote, getFieldSources, getPrivateNotes, removePrivateNoteSource } from "../../server/interview/info-merger";
import { sellerInterviewView } from "../../server/interview/seller-view";

type Info = Record<string, unknown>;
let n = 0;
const ok = (name: string) => { n++; console.log("✓", name); };
const doc = (documentId: string, extra: Record<string, unknown> = {}) => ({ documentId, source: "document" as const, ...extra });

// In-memory discrepancy rows.
const rows: any[] = [];
const s = storage as any;
s.getDiscrepanciesByDeal = async () => rows.map((r) => ({ ...r }));
s.createDiscrepancy = async (data: any) => {
  const r = { id: `row-${rows.length + 1}`, createdAt: new Date(Date.now() + rows.length), resolvedValue: null, ...data };
  rows.push(r);
  return { ...r };
};
s.updateDiscrepancy = async (id: string, u: any) => Object.assign(rows.find((r) => r.id === id), u);

// ── Not one fact disputed ────────────────────────────────────────────────
{
  assert.ok(sumOfPartsMatches("$400,000", "$150,000 paid July 5, 2024; $250,000 paid December 20, 2024"));
  assert.ok(falseConflictReason("dividendsPaid", { value: "$400,000" }, { value: "$150,000 paid July 5, 2024; $250,000 paid December 20, 2024" }));
  assert.ok(falseConflictReason("amortization", { value: "$138,400" }, { value: "Tangible assets $96,400, Intangible assets $42,000" }), "equal parts");
  assert.ok(falseConflictReason("revenueByYear", { value: "$1,628,000", kind: "video_call" }, { value: "$4,711,680 ARR (annualized from March 31, 2025 MRR)", kind: "broker" }), "Q1 vs ARR");
  assert.ok(falseConflictReason("revenueByYear", { value: "approximately $10.1M", kind: "call" }, { value: "$4,180,000 (Jan-May YTD, +8% vs prior year)", kind: "document" }), "YTD");
  assert.ok(falseConflictReason("customerConcentration", { value: "Larkspur 18% of revenue" }, { value: "Top customer (Larkspur) represents $461,000 of $1,530,400 total AR (30.1%)" }), "AR share vs revenue share");
  const t2 = { kind: "document", title: "T2 corporate income tax return 2024" };
  const fs = { kind: "document", title: "Financial statements FY2024 (review engagement)" };
  for (const key of ["interestExpenseByYear", "operatingExpenses", "netIncomeByYear", "depreciation"]) {
    assert.ok(falseConflictReason(key, { value: "$395,000", ...fs }, { value: "$433,000", ...t2 }), `${key}: tax vs book`);
  }
  assert.ok(falseConflictReason("netIncome", { value: "$1,708,970", kind: "document", title: "Form 1120-S summary — tax year 2024 (mock)" }, { value: "$2,403,570", ...fs }));
  assert.equal(falseConflictReason("revenueByYear", { value: "$5,000,000", ...fs }, { value: "$4,000,000", ...t2 }), null, "revenue must agree on both bases");
  assert.ok(falseConflictReason("ownerSalary", { value: "Dad's full salary $285K — he won't be replaced; Mom's salary $62K", kind: "email", period: "2024-12-31" }, { value: "$522,000", kind: "document", period: "2024-12-31" }), "part vs whole");
  assert.ok(falseConflictReason("ownerSalary", { value: "$285K (Dad)", kind: "email", period: "2024-12-31" }, { value: "$488,000", kind: "document", period: "2022-12-31" }), "another fiscal year");
  assert.ok(falseConflictReason("ownerCompensation", { value: "$260,000 including dividends" }, { value: "$180,000" }), "salary vs total comp");
  // Real disputes stay
  assert.equal(falseConflictReason("annualRevenue", { value: "about $4.5M", kind: "call" }, { value: "$1,820,000", kind: "document", period: "2024-12-31" }), null);
  assert.equal(falseConflictReason("customerConcentration", { value: "Largest client is a 14-clinic dental group at approximately 4% of revenue." }, { value: "Largest client Maritime Smiles Dental Group (14 clinics) is $30,600/month = 7.8% of MRR" }), null, "MRR share = revenue share");
  ok("equal sums, different measures, tax vs book, part vs whole and other periods are not disputes");
}

// ── A narrative share conflict is raised ─────────────────────────────────
{
  const video = "Medical about 24% of 2024 sales, automotive about 62%, industrial the rest";
  const email = "Diane Kline-Morrow: Automotive is still the biggest piece, medical is about a third of revenue now and is where all growth has been";
  assert.ok(shareClaimsConflict(video, email));
  assert.ok(materiallyDifferent("revenueStreams", video, email), "long narrative values compared by their share claims");
  assert.ok(!shareClaimsConflict(video, "Automotive (Tier-2 to Tier-1 suppliers) 64.9% ($35,528,934), Medical device and diagnostics 20.9% ($11,418,562) in 2023"), "another year's mix is history");
  assert.ok(!shareClaimsConflict("Medical 24% of 2024 sales, closer to a third of gross margin dollars", "Medical 24% of sales"), "a share of margin is another measure");
  // A list of shares is one claim per segment; a parenthetical never sets the base for what follows
  const vid2 = "Medical ~24% of 2024 sales (~33% of gross margin dollars); automotive ~62%; industrial the rest";
  assert.ok(!shareClaimsConflict(vid2, "Revenue by end market FY2024: Automotive 62% / Medical 24% / Industrial & consumer 14%"), "the same mix, listed");
  assert.ok(shareClaimsConflict(vid2, "Diane Kline-Morrow: automotive is still the biggest piece, medical is about a third of revenue now"));
  const conflicts: MergeConflict[] = [];
  let info: Info = {};
  info = mergeExtractedData(info, { revenueStreams: email } as any, { documentId: "EMAIL", source: "email" }, { conflicts });
  info = mergeExtractedData(info, { revenueStreams: video } as any, { documentId: "VIDEO", source: "video_call" }, { conflicts });
  const settled = settleConflicts(info, conflicts).filter((c) => c.factKey === "revenueStreams");
  assert.equal(settled.length, 1, "the planted medical-share conflict is a discrepancy");
  const d = discrepancyForConflict(settled[0], () => undefined);
  assert.equal(d.severity, "significant");
  assert.equal(d.category, "financial");
  ok("Great Lakes: 'medical is about a third of revenue' vs 'Medical 24% of 2024 sales' is raised");
}

// ── Dedupe: same dispute however it is keyed, ordered or already settled ──
{
  // Reversed duplicate, headline vs its year map
  assert.ok(sameConflict("operatingExpensesByYear", "$5,766,500", "$8,111,500",
    { field: "Operating expenses", factKey: "operatingExpenses", interviewValue: "$8,111,500", documentValue: "$5,766,500", resolvedValue: null } as any) === true ||
    sameConflict("operatingExpenses", "$5,766,500", "$8,111,500",
      { field: "Operating expenses", factKey: "operatingExpenses", interviewValue: "$8,111,500", documentValue: "$5,766,500", resolvedValue: null } as any));
  assert.ok(sameConflict("annualRevenue", "$1,820,000", "about $4.5M",
    { field: "Revenue (2024)", factKey: "revenueByYear", interviewValue: "about $4.5M", documentValue: "$1,820,000", resolvedValue: null } as any), "headline ≡ its year");
  // Legacy rows (no fact key)
  assert.ok(sameConflict("revenueByYear", "$8,640,200", "$7,646,600",
    { field: "revenue2023", factKey: null, interviewValue: "$8,640,200 (per financial statements and T2)", documentValue: "$7,646,600 (dispensary sales only, per payer mix report)", resolvedValue: "$8,640,200" } as any));
  assert.ok(sameConflict("leaseExpiry", "August 31, 2027, with one 5-year renewal option to August 31, 2032", "2029",
    { field: "leaseExpiry", factKey: null, interviewValue: "Lease expires 2029 (stated in discovery call and initial email)", documentValue: "Lease expires August 31, 2027 per lease document and financial statements", resolvedValue: "August 31, 2027" } as any));
  assert.ok(sameConflict("customerConcentration", "Largest client Maritime Smiles Dental Group (14 clinics) is $30,600/month = 7.8% of MRR", "Largest client is a 14-clinic dental group at approximately 4% of revenue.",
    { field: "maritimeSmilesMRRPercentage", factKey: null, interviewValue: "Largest client is approximately 4% of revenue", documentValue: "Maritime Smiles is $30,600 MRR out of $392,640 total = 7.8% of MRR", resolvedValue: null } as any), "figures match although the labels differ");
  // The analysis' owner-comp row covers the merge's salary pair
  assert.ok(sameConflict("ownerSalary", "$180,000", "$260,000",
    { field: "Owner compensation (2024)", factKey: null, interviewValue: "$260,000 total owner compensation per seller's add-back list", documentValue: "$268,000 total (T4 salary $180,000 + T5 dividends $60,000 + personal expenses $28,000)", resolvedValue: null } as any));
  // Different disputes stay apart
  assert.ok(!sameConflict("annualRevenue", "$1,820,000", "about $4.5M",
    { field: "EBITDA", factKey: "ebitda", interviewValue: "about $1.5M", documentValue: "$1,199,100", resolvedValue: null } as any));
  ok("the same dispute is recognised across keys, orders, labels and settled rows");
}

// ── recordMergeConflicts: repeated merges and resolved rows stay quiet ───
await (async () => {
  rows.length = 0;
  const docs = [{ id: "CALL", name: "Intro call" }, { id: "FS24", name: "Financial statements FY2024", sourceMeta: { periodEnd: "2024-12-31" } }, { id: "LEASE", name: "Lease" }] as any[];
  let info: Info = {};
  for (let i = 0; i < 3; i++) {
    const conflicts: MergeConflict[] = [];
    info = mergeExtractedData(info, { annualRevenue: "about $4.5M" } as any, { documentId: "CALL", source: "call" }, { conflicts });
    info = mergeExtractedData(info, { annualRevenue: "$1,820,000", revenueByYear: { "2024": "$1,820,000" }, periodEnd: "2024-12-31" } as any, doc("FS24", { title: "Financial statements FY2024" }), { conflicts });
    await recordMergeConflicts("d1", conflicts, docs, info);
  }
  const revenueRows = rows.filter((r) => /revenue/i.test(r.factKey ?? ""));
  assert.equal(revenueRows.length, 1, `one revenue row after three merges (got ${revenueRows.map((r) => `${r.factKey}/${r.factYear}`).join(", ")})`);
  assert.equal(revenueRows[0].severity, "critical");
  // The broker resolves it; an unrelated lease upload re-merges everything
  Object.assign(rows[0], { status: "resolved", resolvedValue: "$1,820,000" });
  const conflicts: MergeConflict[] = [];
  info = mergeExtractedData(info, { annualRevenue: "about $4.5M" } as any, { documentId: "CALL", source: "call" }, { conflicts });
  info = mergeExtractedData(info, { leaseExpiry: "June 30, 2029" } as any, doc("LEASE", { title: "Lease" }), { conflicts });
  await recordMergeConflicts("d1", conflicts, docs, info);
  assert.equal(rows.filter((r) => r.status === "open" && /revenue/i.test(r.factKey ?? "")).length, 0, "a resolved conflict is never re-opened");
  // Statements for three years against one spoken salary → at most one row, and none for a part vs the whole
  rows.length = 0;
  const pc: MergeConflict[] = [];
  let pinfo: Info = {};
  pinfo = mergeExtractedData(pinfo, { ownerSalary: "Dad's full salary $285K — he won't be replaced; Mom's salary $62K", periodEnd: "2024-12-31" } as any, { documentId: "EMAIL", source: "email" }, { conflicts: pc });
  for (const [id, y, v] of [["FS22", "2022", "$488,000"], ["FS23", "2023", "$505,000"], ["FS24", "2024", "$522,000"]]) {
    pinfo = mergeExtractedData(pinfo, { ownerSalary: v, periodEnd: `${y}-12-31` } as any, doc(id, { title: `Financial statements FY${y}` }), { conflicts: pc });
  }
  await recordMergeConflicts("d2", pc, [{ id: "EMAIL", name: "Email" }, { id: "FS22", name: "FS 2022" }, { id: "FS23", name: "FS 2023" }, { id: "FS24", name: "FS 2024" }] as any, pinfo);
  assert.equal(rows.filter((r) => r.factKey === "ownerSalary").length, 0, "one owner's pay vs the shareholders' total is no dispute");
  ok("repeated merges raise one row; a resolved conflict stays resolved; no owner-salary rows for part vs whole");
})();

// ── Lifecycle: rows that no longer stand are superseded ──────────────────
{
  const base = { source: "merge", status: "open", severity: "critical", category: "financial", documentName: null, resolvedValue: null } as const;
  const info: Info = {
    annualRevenue: "$1,820,000",
    revenueByYear: { "2024": "$1,820,000" },
    _fieldSources: { annualRevenue: doc("FS24"), revenueByYear: doc("FS24") },
    _fieldAlternates: { annualRevenue: [{ value: "about $4.5M", source: "call", documentId: "CALL" }] },
  };
  const docsWith = [{ id: "CALL", name: "Call" }, { id: "FS24", name: "FS 2024" }] as any[];
  const row: any = {
    ...base, id: "r1", createdAt: new Date(1), field: "Annual revenue", factKey: "annualRevenue", factYear: null, interviewValue: "about $4.5M", documentValue: "$1,820,000",
    documentId: "FS24", sideSources: { interview: { kind: "call", documentId: "CALL" }, document: { kind: "document", documentId: "FS24" } },
  };
  assert.equal(staleMergeRowReason(row, info, new Map(docsWith.map((d) => [d.id, d]))), null, "still stands");
  // The call is deleted → superseded (never blocks, never reaches the seller)
  const without = docsWith.filter((d) => d.id !== "CALL");
  assert.ok(staleMergeRowReason(row, info, new Map(without.map((d) => [d.id, d]))));
  assert.deepEqual(planMergeRowSupersession([row], info, without), ["r1"]);
  assert.equal(mergeDiscrepancyConflicts([row], without as any).length, 0, "a side whose source is gone is never put to the seller");
  // The call's value no longer stated (the call was re-read and says $1.8M now)
  const moved: Info = { ...info, _fieldAlternates: {} };
  assert.ok(staleMergeRowReason(row, moved, new Map(docsWith.map((d) => [d.id, d]))));
  // The broker (or a newer source) moved the fact to a third value
  assert.ok(staleMergeRowReason(row, { ...info, annualRevenue: "$2,000,000" }, new Map(docsWith.map((d) => [d.id, d]))));
  // …but a row the seller answered stays unless its source went
  assert.equal(staleMergeRowReason({ ...row, status: "seller_responded" }, { ...info, annualRevenue: "$2,000,000" }, new Map(docsWith.map((d) => [d.id, d]))), null);
  // Equal-sum and different-measure rows raised by older rules
  const eq: any = { ...base, id: "r2", createdAt: new Date(2), severity: "significant", field: "Amortization", factKey: "amortization", factYear: null, interviewValue: "$138,400", documentValue: "Tangible assets $96,400, Intangible assets $42,000", documentId: null, sideSources: {} };
  const arr: any = { ...base, id: "r3", createdAt: new Date(3), field: "Revenue (2025)", factKey: "revenueByYear", factYear: "2025", interviewValue: "$1,628,000", documentValue: "$4,711,680 ARR (annualized from March 31, 2025 MRR)", documentId: null, sideSources: {} };
  // Reversed duplicate of r1 under the by-year key
  const dup: any = { ...row, id: "r4", createdAt: new Date(4), field: "Revenue (2024)", factKey: "revenueByYear", factYear: "2024", interviewValue: "$1,820,000", documentValue: "about $4.5M" };
  // A resolved legacy row about the same dispute supersedes a later open merge row
  const legacy: any = { id: "L1", createdAt: new Date(0), source: "interview", status: "resolved", field: "annualRevenue", factKey: null, interviewValue: "$4.5M (call)", documentValue: "$1,820,000 per FS", resolvedValue: "$1,820,000", severity: "critical" };
  const planned = planMergeRowSupersession([legacy, row, eq, arr, dup], info, docsWith);
  assert.deepEqual(planned.sort(), ["r1", "r2", "r3", "r4"], `got ${planned}`);
  assert.deepEqual(planMergeRowSupersession([row, dup], info, docsWith), ["r4"], "the later duplicate goes, the first stays");
  ok("merge rows are superseded when a source is deleted, a value is no longer stated, the fact moved on, the rules clear them or they repeat another row");
}

// ── Private notes review ─────────────────────────────────────────────────
{
  const docs = new Map<string, ReviewDoc>([
    ["CALL", { id: "CALL", name: "Phone call", visibility: "shared", sourceKind: "call" } as any],
    ["CRM", { id: "CRM", name: "CRM note", visibility: "broker_only", sourceKind: "crm" } as any],
    ["MB", { id: "MB", name: "Minute book extract", visibility: "shared", sourceKind: "document" } as any],
    ["AR", { id: "AR", name: "AR aging", visibility: "shared", sourceKind: "document" } as any],
  ]);
  let info: Info = {};
  addPrivateNote(info, "Seller had a cardiac event in October 2024 (stent placed); asked that it stay out of any brochure", { documentId: "CALL", reason: "From Phone call" });
  addPrivateNote(info, "Owner (Gord) had cardiac episode last Oct — noted as PRIVATE, do not put in CIM", { documentId: "CRM", brokerOnly: true, reason: "From CRM note" });
  addPrivateNote(info, "Grandkids in Kelowna", { documentId: "CRM", brokerOnly: true, reason: "From CRM note" });
  addPrivateNote(info, "Seller's daughter and two grandchildren live in Kelowna BC, seller's wife Donna wants to relocate there", { documentId: "CALL", reason: "From Phone call" });
  addPrivateNote(info, "Document prepared by D. McAllister from the accounting system as of May 31, 2025", { documentId: "AR", reason: "From AR aging" });
  addPrivateNote(info, "Class D dividend of $60,000 declared December 16, 2024 payable only to Gord McAllister", { documentId: "MB", reason: "From Minute book extract" });
  addPrivateNote(info, "Seller is 64 years old", { documentId: "CALL", reason: "From Phone call" });
  const before = getPrivateNotes(info).length;
  const items = collectNoteItems(info, docs);
  const id = (text: string) => `N${items.findIndex((i) => i.text.startsWith(text)) + 1}`;
  // What the model proposes — including unsafe moves the guards must refuse.
  const placement = {
    groups: [
      { text: "Owner Gord had a cardiac event in October 2024 (stent placed); keep it out of any brochure or CIM (PRIVATE).", notes: [id("Seller had a cardiac"), id("Owner (Gord)")] },
      // Loses "two", "Donna", "BC": refused → the notes stay apart
      { text: "Family in Kelowna.", notes: [id("Grandkids"), id("Seller's daughter")] },
    ],
    notNotes: [
      { note: id("Document prepared"), kind: "housekeeping" },
      { note: id("Class D dividend"), kind: "business_fact", factKey: "dividendsDeclared", factValue: "Class D dividend of $60,000 declared December 16, 2024, payable only to Gord McAllister" },
      { note: id("Seller is 64"), kind: "housekeeping" }, // personal: never dropped
    ],
  };
  const placed = recordPlacements(emptyReview(), placement, items, [], docs);
  assert.equal(placed.rejects.length, 1, "the lossy merge goes back for one repair");
  assert.ok(placed.rejects[0].missing.includes("donna"), `missing: ${placed.rejects[0].missing}`);
  // The repair also fails (drops "two") → the notes stay apart
  const review = settleRejects(placed.review, placed.rejects, ["Seller's daughter and grandchildren live in Kelowna BC; wife Donna wants to relocate there"]);
  const applied = applyNotesReview(info, review, docs);
  const notes = getPrivateNotes(applied.info);
  assert.equal(applied.pending.length, 0);
  assert.ok(notes.length < before, `${before} → ${notes.length}`);
  const heart = notes.find((x) => /cardiac/i.test(x.note))!;
  assert.equal(heart.note, "Owner Gord had a cardiac event in October 2024 (stent placed); keep it out of any brochure or CIM (PRIVATE).");
  const heartSources = [heart, ...(heart.alsoFrom ?? [])];
  assert.equal(heartSources.length, 2, "both sources kept");
  assert.ok(heartSources.every((x) => x.wording), "each keeps its own words");
  // The model's lossy words are refused; the members' own words (the fullest
  // covers the other) make the note, and both sources stay on it.
  const kelowna = notes.filter((x) => /Kelowna/.test(x.note));
  assert.equal(kelowna.length, 1, "one Kelowna note");
  assert.equal(kelowna[0].note, "Seller's daughter and two grandchildren live in Kelowna BC, seller's wife Donna wants to relocate there");
  assert.equal([kelowna[0], ...(kelowna[0].alsoFrom ?? [])].length, 2);
  assert.ok(!notes.some((x) => x.note === "Family in Kelowna."), "never the lossy draft");
  assert.ok(!notes.some((x) => /Document prepared/.test(x.note)), "housekeeping dropped");
  assert.ok(notes.some((x) => /64 years old/.test(x.note)), "a personal note is never dropped");
  assert.ok(!notes.some((x) => /Class D dividend/.test(x.note)), "the dividend left the notes…");
  assert.match(String(applied.info.dividendsDeclared), /\$60,000/, "…and is a fact");
  assert.equal(getFieldSources(applied.info).dividendsDeclared.documentId, "MB");
  assert.equal(getFieldSources(applied.info).dividendsDeclared.note, MOVED_FROM_NOTES);
  // Idempotent: re-applying (a reprocess that re-states nothing new) changes nothing, asks nothing
  const again = applyNotesReview(applied.info, review, docs);
  assert.equal(again.changed, false);
  assert.equal(again.pending.length, 0);
  // A reprocess re-adds each source's words (refreshSourceNotes) — the review folds them back
  const reread: Info = { ...applied.info };
  removePrivateNoteSource(reread, "CALL");
  for (const t of ["Seller had a cardiac event in October 2024 (stent placed); asked that it stay out of any brochure", "Seller's daughter and two grandchildren live in Kelowna BC, seller's wife Donna wants to relocate there", "Seller is 64 years old"]) {
    addPrivateNote(reread, t, { documentId: "CALL", reason: "From Phone call" });
  }
  const re = applyNotesReview(reread, review, docs);
  assert.equal(re.pending.length, 0, "every wording is known");
  assert.deepEqual(getPrivateNotes(re.info).map((x) => x.note).sort(), notes.map((x) => x.note).sort(), "same notes after a reprocess");
  // The dividend fact survives a reprocess that drops it (still its source's)
  const dropped: Info = { ...re.info };
  delete dropped.dividendsDeclared;
  assert.match(String(applyNotesReview(dropped, review, docs).info.dividendsDeclared), /\$60,000/);
  // …but never over a broker deletion
  const suppressed: Info = { ...dropped, _brokerSuppressed: ["dividendsDeclared"] };
  assert.equal(applyNotesReview(suppressed, review, docs).info.dividendsDeclared, undefined);
  // A new rewording joins the known matter through the model; the heart note's
  // consolidated words fall back to a source's own once a source is deleted.
  const del: Info = { ...applied.info };
  removePrivateNoteSource(del, "CRM");
  const afterDelete = getPrivateNotes(applyNotesReview(del, review, docs).info).find((x) => /cardiac/i.test(x.note))!;
  assert.equal(afterDelete.note, "Seller had a cardiac event in October 2024 (stent placed); asked that it stay out of any brochure", "no detail of a deleted source stays");
  // The seller side (interview) only ever sees its own source's words
  const view = sellerInterviewView(applied.info, Array.from(docs.values()) as any);
  const seen = getPrivateNotes(view).map((x) => x.note);
  assert.ok(seen.includes("Seller had a cardiac event in October 2024 (stent placed); asked that it stay out of any brochure"));
  assert.ok(!seen.some((t) => /Gord|PRIVATE|Grandkids/.test(t)), `no broker-only words reach the seller side: ${seen.join(" | ")}`);
  ok("notes review: merges keep every source and detail, housekeeping goes, facts move out, personal notes stay, idempotent across reprocesses");
}

// ── Guards ───────────────────────────────────────────────────────────────
{
  for (const t of ["Luis would need to consult with his wife before deciding on retaining equity", "Gord's negotiating position: wants most money at closing, willing to carry 15-20%", "Referral from Heather Kwan (Kwan & Brodeur, Leduc)", "Karen's number is $45–50M"]) {
    assert.ok(!isPromotableNote(t), `never a fact: ${t}`);
  }
  assert.ok(isPromotableNote("HV-1057 Himmelman & Sandhu Law gave 90-day non-renewal notice; lose $2,470 MRR"));
  assert.ok(isDroppableNote("EIN is masked in document"));
  assert.ok(isDroppableNote("Next: site visit + meeting Tue Mar 11. Send NDA + info request list after meeting."));
  for (const t of ["Seller is 64 years old", "Mentioned a competitor sniffed around a couple yrs ago, 'insulting number.'", "Ask: 6.5M, Jackpine approached in 2023 at ~3x"]) {
    assert.ok(!isDroppableNote(t), `never dropped: ${t}`);
  }
  assert.ok(keepsEveryDetail("Owner Gord had a cardiac event in October 2024 (stent)", ["Gord had cardiac episode last Oct", "Seller had a cardiac event in October 2024 (stent)"]));
  assert.ok(!keepsEveryDetail("Owner had a heart event", ["Gord had cardiac episode in 2024"]), "a lost name / year");
  assert.ok(!keepsEveryDetail("Seller will carry 15-25% over 3 years", ["willing to carry 15-20% over 3 years"]), "an invented figure");
  // A fact is never taken from the interview, the questionnaire or a broker-only source
  const docs = new Map<string, ReviewDoc>([["CRM", { id: "CRM", name: "CRM", visibility: "broker_only", sourceKind: "crm" } as any]]);
  const info: Info = {};
  addPrivateNote(info, "Customer HV-1057 gave 90-day non-renewal notice", { documentId: "CRM", brokerOnly: true });
  addPrivateNote(info, "Shareholder agreement amended November 2024", { turn: 4, reason: "Seller said" });
  const items = collectNoteItems(info, docs);
  const review: NotesReview = recordPlacements(emptyReview(), {
    groups: [],
    notNotes: items.map((_, i) => ({ note: `N${i + 1}`, kind: "business_fact", factKey: "customerNotices", factValue: "x" })),
  }, items, currentGroups(items, emptyReview()), docs).review;
  const out = applyNotesReview(info, review, docs);
  assert.equal(out.info.customerNotices, undefined);
  assert.equal(getPrivateNotes(out.info).length, 2, "both stay notes");
  ok("guards: nothing personal, negotiated or process-related becomes a fact or is dropped; merges must keep every detail");
}

// ── Repair, folding existing notes, drop guard details ───────────────────
{
  const docs = new Map<string, ReviewDoc>([["EM", { id: "EM", name: "Email", visibility: "shared", sourceKind: "email" } as any]]);
  const info: Info = {};
  addPrivateNote(info, "Negotiation position from Gord: wants most of purchase price at closing, willing to carry 15-20% seller financing for three years", { documentId: "EM" });
  addPrivateNote(info, "Seller personal negotiation position: will carry 15-20% financing but 'not half' - has seen others not get paid", { turn: 3 });
  addPrivateNote(info, "Luis confirmed 15% ownership stake", { documentId: "EM" });
  const items = collectNoteItems(info, docs);
  // First review: each its own note
  let review = recordPlacements(emptyReview(), { groups: items.map((_, i) => ({ text: items[i].text, notes: [`N${i + 1}`] })), notNotes: [] }, items, [], docs).review;
  assert.equal(getPrivateNotes(applyNotesReview(info, review, docs).info).length, 3);
  // A later review folds the two financing notes (existing) together; the first draft drops "Gord", the repair keeps it
  const current = currentGroups(items, review);
  const [g1, g2] = current;
  const placed = recordPlacements(review, { groups: [{ id: g1.id, merge: [g2.id], text: "The seller wants most of the price at closing; will carry 15-20% seller financing for 3 years.", notes: [] }], notNotes: [] }, [], current, docs);
  assert.equal(placed.rejects.length, 1);
  review = settleRejects(placed.review, placed.rejects, ["Gord wants most of the price at closing; will carry 15-20% seller financing for 3 years, but 'not half' — he has seen others not get paid."]);
  const notes = getPrivateNotes(applyNotesReview(info, review, docs).info);
  assert.equal(notes.length, 2, notes.map((x) => x.note).join(" | "));
  assert.match(notes[0].note, /not half/);
  assert.ok(!isDroppableNote("surinder salary = non-working, confirmed add-back"), "an add-back is substance");
  assert.ok(!isDroppableNote("Financial statements are unaudited compilation only"), "audit status is substance");
  assert.ok(isDroppableNote("Broker fee/commission and engagement terms not disclosed in this email thread"), "a remark that something is absent");
  assert.ok(!isDroppableNote("Referral from Heather Kwan (Kwan & Brodeur, Leduc)"));
  ok("a lossy consolidation is repaired once, else made from the notes' own words; existing notes about one matter fold together");
}

// ── Round V-2: a restated conflict keeps its row true ────────────────────
await (async () => {
  rows.length = 0;
  const docsList = [{ id: "CALL", name: "Intro call" }, { id: "LEASE", name: "Warehouse lease" }] as any[];
  const docsMap = new Map(docsList.map((d) => [d.id, d]));
  const src = (documentId: string, source: string) => ({ source, documentId }) as any;
  const conflict = (callWords: string, leaseWords: string): MergeConflict => ({
    factKey: "leaseTerms",
    winner: { value: leaseWords, src: src("LEASE", "document") },
    loser: { value: callWords, src: src("CALL", "call") },
  });
  const infoWith = (callWords: string, leaseWords: string): Info => ({
    leaseTerms: leaseWords,
    _fieldSources: { leaseTerms: { source: "document", documentId: "LEASE" } },
    _fieldAlternates: { leaseTerms: [{ value: callWords, source: "call", documentId: "CALL" }] },
  });
  const c1 = ["Silvergate warehouse lease runs to 2027.", "Lease term to September 30, 2037; renewed 2022 for 15 years"] as const;
  assert.equal(await recordMergeConflicts("D", [conflict(c1[0], c1[1])], docsList, infoWith(c1[0], c1[1])), 1);
  // The call is re-read in new words: the open row takes them and still stands
  const c2 = ["Silvergate warehouse lease runs to 2027; renewed last year (2024) for 15 years.", c1[1]] as const;
  assert.equal(await recordMergeConflicts("D", [conflict(c2[0], c2[1])], docsList, infoWith(c2[0], c2[1])), 0, "no second row");
  assert.equal(rows[0].interviewValue, c2[0], "the row shows the call's current words");
  assert.deepEqual(planMergeRowSupersession(rows as any, infoWith(c2[0], c2[1]), docsList), [], "…and is not superseded");
  // The lease is re-read in new words too
  const c3 = [c2[0], "Triple-net lease to September 30, 2037; annual basic rent $1,897,500"] as const;
  assert.equal(await recordMergeConflicts("D", [conflict(c3[0], c3[1])], docsList, infoWith(c3[0], c3[1])), 0);
  assert.equal(rows[0].documentValue, c3[1]);
  assert.deepEqual(planMergeRowSupersession(rows as any, infoWith(c3[0], c3[1]), docsList), []);
  assert.equal(staleMergeRowReason(rows[0], infoWith(c3[0], c3[1]), docsMap), null);
  // A row the broker routed to the seller, or settled, keeps what it showed
  rows[0].status = "ask_seller";
  const c4 = ["Lease to 2027 per the call", c3[1]] as const;
  await recordMergeConflicts("D", [conflict(c4[0], c4[1])], docsList, infoWith(c4[0], c4[1]));
  assert.equal(rows[0].interviewValue, c3[0], "a routed row is not reworded");
  assert.equal(rows.length, 1);
  ok("a restated conflict brings its open row to the current words — it never lapses for a cycle; routed rows keep theirs");
})();

// ── Round V-2: a row with the seller survives the seller's answer ────────
{
  const docsList = [{ id: "CALL", name: "Call" }, { id: "FS", name: "Statements" }] as any[];
  const docsMap = new Map(docsList.map((d) => [d.id, d]));
  const row: any = {
    id: "E1", createdAt: new Date(1), source: "merge", status: "ask_seller", severity: "critical", category: "financial", field: "EBITDA",
    factKey: "ebitda", factYear: null, interviewValue: "$7.5M", documentValue: "$5,274,900", documentId: "FS", resolvedValue: null,
    sideSources: { interview: { kind: "call", documentId: "CALL" }, document: { kind: "document", documentId: "FS" } },
  };
  // The seller's interview answer moved the fact to a third value
  const answered: Info = {
    ebitda: "$6.1M",
    _fieldSources: { ebitda: { source: "interview" } },
    _fieldAlternates: { ebitda: [{ value: "$5,274,900", source: "document", documentId: "FS" }, { value: "$7.5M", source: "call", documentId: "CALL" }] },
  };
  assert.equal(staleMergeRowReason(row, answered, docsMap), null, "routed: stays until the interview hands it back");
  assert.deepEqual(planMergeRowSupersession([row], answered, docsList), []);
  assert.ok(staleMergeRowReason({ ...row, status: "open" }, answered, docsMap), "an open row whose fact moved on still lapses");
  // …even when another row repeats it
  const earlier: any = { ...row, id: "E0", createdAt: new Date(0), source: "financial_analysis", status: "open", factKey: null, field: "EBITDA" };
  assert.deepEqual(planMergeRowSupersession([earlier, row], answered, docsList), []);
  // …but a deleted source still takes it out (never put to the seller from a deleted transcript)
  assert.ok(staleMergeRowReason(row, answered, new Map([["FS", docsMap.get("FS")]]) as any));
  ok("a row routed to the seller is never superseded by the seller's own answer; a deleted source still retires it");
}

// ── Round V-2: the notes review without the model, and restatements ──────
{
  const docs = new Map<string, ReviewDoc>([
    ["CALL", { id: "CALL", name: "Phone call", visibility: "shared", sourceKind: "call" } as any],
    ["CRM", { id: "CRM", name: "CRM note", visibility: "broker_only", sourceKind: "crm" } as any],
  ]);
  const info: Info = {};
  addPrivateNote(info, "Seller had a cardiac event in October 2024 (stent placed)", { documentId: "CALL" });
  addPrivateNote(info, "Seller had heart episode October 2024, stent placed, back to work in 2 weeks", { documentId: "CALL" });
  addPrivateNote(info, "Gord had cardiac episode last October - marked PRIVATE", { documentId: "CRM", brokerOnly: true });
  addPrivateNote(info, "Grandkids in Kelowna", { documentId: "CRM", brokerOnly: true });
  const notes = getPrivateNotes(info);
  assert.ok(notes.some((x) => (x.alsoFrom ?? []).length > 0), "addPrivateNote folded a restatement");
  // No decision at all (the model unavailable): every note stays exactly as it is
  const none = applyNotesReview(info, emptyReview(), docs);
  assert.equal(none.changed, false, "nothing is pulled apart");
  assert.deepEqual(getPrivateNotes(none.info), notes);
  assert.equal(none.pending.length, collectNoteItems(info, docs).length);
  // Decided: the heart notes are one note (group); a reprocess then re-reads the call in new words
  const items = collectNoteItems(info, docs);
  const heartIds = items.map((it, i) => (/cardiac|heart/i.test(it.text) ? `N${i + 1}` : null)).filter((x): x is string => !!x);
  const review = recordPlacements(emptyReview(), {
    groups: [
      { text: "Gord had a cardiac event in October 2024 (stent placed), back to work in 2 weeks; PRIVATE.", notes: heartIds },
      { text: "Grandkids in Kelowna", notes: [`N${items.findIndex((it) => /Kelowna/.test(it.text)) + 1}`] },
    ],
    notNotes: [],
  }, items, [], docs).review;
  const applied = applyNotesReview(info, review, docs).info;
  assert.equal(getPrivateNotes(applied).length, 2);
  const reread: Info = { ...applied };
  addPrivateNote(reread, "Seller had a heart episode in October 2024; a stent was placed and he was back at work in two weeks", { documentId: "CALL" });
  addPrivateNote(reread, "Seller's wife Donna wants to move to Kelowna", { documentId: "CALL" });
  const adopted = adoptFoldedWordings(reread, review, docs);
  const again = applyNotesReview(reread, adopted, docs);
  assert.equal(again.pending.length, 1, `only the new matter is left for the model: ${again.pending.map((p) => p.text)}`);
  assert.match(again.pending[0].text, /Donna/);
  const after = getPrivateNotes(again.info);
  assert.equal(after.filter((x) => /cardiac|heart/i.test(x.note)).length, 1, "the restatement joined its note");
  assert.equal(after.length, 3);
  // …and the model unavailable for the new one: it stays as it was, the rest as decided
  assert.equal(applyNotesReview(again.info, adopted, docs).changed, false, "stable");
  ok("without the model nothing is pulled apart; restatements follow their note without asking the model");
}

// ── Round V-2: facts only from the closed list, never a stance or a deal term ─
{
  for (const t of [
    "Gord McAllister: would carry some paper if it gets the deal done, 15-20%, three years, but wants most of it at closing",
    "Karen thinks $42M asking price is low",
    "Daniel does not yet know business is for sale",
    "Helen explicitly requested this not appear in any sale document",
    "Rob may roll 10-15% equity",
    "Seller financing: up to 10% seller note, 5 years, subordinated.",
    "Structure: $2,600,000 cash at close / $300,000 VTB 3 yrs @ 5% subordinated / $150,000 earnout",
    "Kyle says $9.0M fair",
    "Tom Brennan has known about sale process since January",
    "Target close end of Q1 2026 - seller's timeline",
    "Excluding Stillwater Ridge Molding at seller's request.",
  ]) assert.ok(!isPromotableFact("shareholdersAgreement", t) && !isPromotableFact("excludedAssets", t) && !isPromotableFact("dividendsDeclared", t) && !isPromotableNote(t), `never a fact: ${t}`);
  assert.ok(isPromotableFact("dividendsDeclared", "Class D dividend of $60,000 declared December 16, 2024 payable only to Gord McAllister"));
  assert.ok(isPromotableFact("customerNonRenewal", "HV-1057 Himmelman & Sandhu Law gave 90-day non-renewal notice Feb 2025, will lose $2,470 MRR in June 2025"));
  assert.ok(isPromotableFact("shareholdersAgreement", "Shareholder agreement amended November 2024: Luis's first refusal waived if Gord sells 100% to outside buyer, Luis gets same price per share as Gord"));
  assert.ok(isPromotableFact("relatedPartyTransactions", "Premises owned by entity controlled by majority shareholder (related party)"));
  assert.ok(!isPromotableFact("dividendsDeclared", "Financial statements are unaudited compilation only"), "the key must be what the note is about");
  assert.ok(!isPromotableFact("marketPosition", "Financial statements are unaudited compilation only"), "only the closed list of disclosures");
  // The model moving a negotiation note out is refused: it stays a note
  const docs = new Map<string, ReviewDoc>([["EM", { id: "EM", name: "Email", visibility: "shared", sourceKind: "email" } as any]]);
  const info: Info = {};
  addPrivateNote(info, "Karen thinks $42M asking price is low", { documentId: "EM" });
  const items = collectNoteItems(info, docs);
  const review = recordPlacements(emptyReview(), { groups: [], notNotes: [{ note: "N1", kind: "business_fact", factKey: "shareholdersAgreement", factValue: "$42M" }] }, items, [], docs).review;
  const out = applyNotesReview(info, review, docs);
  assert.equal(out.info.shareholdersAgreement, undefined);
  assert.equal(getPrivateNotes(out.info).length, 1);
  ok("a note becomes a fact only as a listed disclosure it is about — never a stance, a deal term or who knows about the sale");
}

// ── Round V-2: what the model put together stays together ────────────────
{
  const mk = (text: string, i: number) => ({ key: text.toLowerCase(), text, sources: [{ documentId: `D${i}` }], shared: true });
  const members = [
    "Seller had heart episode October 2024, stent placed, back to work in 2 weeks, doctor advised to slow down - this is partial motivation for sale but NOT to be disclosed in any buyer materials",
    "Gord had cardiac episode last October - marked PRIVATE, do not put in CIM",
    "Seller stated 'don't want it in any brochure' regarding health episode",
    "Seller had a cardiac event in October 2024 (stent placed), doctor advised him to slow down — this is the real trigger for the sale timeline. He explicitly asked this stay out of the CIM and any market",
  ].map(mk);
  const reject = { targets: [], existing: [], fresh: members, text: "Owner had a cardiac event in October 2024 (stent); doctor advised slowing down; keep out of all buyer materials", missing: ["2"] } as any;
  const settled = settleRejects(emptyReview(), [reject], [undefined]);
  const groupsUsed = new Set(members.map((m) => (settled.items[m.key] as any)?.g));
  assert.equal(groupsUsed.size, 1, "one note, never split");
  const g = settled.groups[Array.from(groupsUsed)[0] as string];
  assert.ok(inventedDetails(g.text, members.map((m) => m.text)).length === 0, `invents nothing: ${g.text}`);
  // A draft that invents a figure is never used
  const bad = { ...reject, text: "Owner had a cardiac event in October 2024 (2 stents, $40,000 treatment)" };
  const s2 = settleRejects(emptyReview(), [bad], ["Owner had a cardiac event (3 stents)"]);
  const t2 = s2.groups[(s2.items[members[0].key] as any).g].text;
  assert.ok(!/40,000|3 stents/.test(t2), t2);
  ok("a consolidation that can't keep every detail keeps the notes together in words that invent nothing");
}

// ── Round V-2: a notice window and a debt's current portion are not disputes ─
{
  const doc = "One (1) option to extend for five (5) years (July 1, 2029 to June 30, 2034) by written notice delivered not less than nine (9) months and not more than twelve (12) months prior to the expiry of the Term";
  assert.ok(falseConflictReason("leaseRenewalOptions", { value: "Renewal option window opens in 2028, not yet exercised", kind: "email" }, { value: doc, kind: "document" }));
  assert.equal(falseConflictReason("leaseRenewalOptions", { value: "Lease expires in 2028", kind: "email" }, { value: doc, kind: "document" }), null, "an expiry year stays a dispute");
  assert.equal(falseConflictReason("leaseTerms", { value: "Renewal option window opens in 2026", kind: "email" }, { value: doc, kind: "document" }), null, "a window years off stays a dispute");
  const info: Info = { longTermDebt: "Total long-term debt $1,342,000 (current portion $274,000, long-term portion $1,068,000)." };
  assert.ok(factsFalseReason("longTermDebtByYear", "$1,068,000", "$1,342,000", info));
  assert.ok(factsFalseReason("longTermDebt", "$1,068,000", "$1,342,000", { currentPortionLongTermDebtByYear: { "2023": "$274,000" } }));
  assert.equal(factsFalseReason("longTermDebtByYear", "$1,068,000", "$1,500,000", info), null);
  assert.equal(factsFalseReason("annualRevenue", "$1,068,000", "$1,342,000", info), null, "debt only");
  const row: any = {
    id: "LTD", createdAt: new Date(1), source: "merge", status: "open", severity: "significant", category: "financial", field: "Long term debt (2023)",
    factKey: "longTermDebtByYear", factYear: "2023", interviewValue: "$1,068,000", documentValue: "$1,342,000", documentId: null, resolvedValue: null, sideSources: {},
  };
  assert.ok(staleMergeRowReason(row, { ...info, longTermDebtByYear: { "2023": "$1,342,000" } }, new Map()), "an older row is superseded");
  ok("an option's notice window and a debt total vs its long-term portion are not raised");
}

// ── Round V-2: re-reading a source leaves its notes where they are ───────
{
  const call = { id: "CALL", name: "Intro call", sourceKind: "call", visibility: "shared" } as any;
  const crm = { id: "CRM", name: "CRM note", sourceKind: "crm", visibility: "broker_only" } as any;
  const info: Info = {};
  // A chain of restatements folded into one note in the order they arrived
  addPrivateNotes(info, ["Owner Harjit Grewal is 67; had a cardiac stent procedure last year; wife wants to travel"], call);
  addPrivateNotes(info, ["Founder (67) retiring after a 2024 heart procedure"], crm);
  addPrivateNotes(info, ["Harjit had cardiac stent procedure last year (recovered, walking daily)", "Class D dividend of $60,000 declared December 16, 2024"], call);
  const before = JSON.stringify(getPrivateNotes(info));
  const data = { _privateNotes: ["Harjit had cardiac stent procedure last year (recovered, walking daily)"], dividendsDeclared: "Class D dividend of $60,000 declared December 16, 2024" };
  refreshSourceNotes(info, call, data);
  const once = getPrivateNotes(info);
  assert.ok(!once.some((x) => /dividend/i.test(JSON.stringify(x))), "a note the source now records as a fact goes");
  assert.ok(once.some((x) => [x.note, ...(x.alsoFrom ?? []).map((a) => a.wording)].some((w) => /wife wants to travel/.test(w ?? ""))), "an earlier wording the fresh run didn't repeat stays");
  refreshSourceNotes(info, call, data);
  refreshSourceNotes(info, crm, { _privateNotes: ["Founder (67) retiring after a 2024 heart procedure"] });
  assert.equal(JSON.stringify(getPrivateNotes(info)), JSON.stringify(once), "re-reading again changes nothing");
  assert.notEqual(before, JSON.stringify(once));
  ok("a reprocess keeps each source's earlier wordings in place: no notes split or reordered, facts leave");
}

console.log(`\n${n} checks passed`);
