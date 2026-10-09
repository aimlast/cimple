/**
 * gl spec §12.1 tests 20 + 23-adjacent: what buyers are shown about the
 * add-backs, end to end on the fictional Brightwater deal (memory store, no
 * AI): the broker reviews, the publish dialog's defaults and note, the
 * snapshot, and each version's payload —
 *   Blind   only constants, counts and fiscal years (the guard finds nothing)
 *   Full    labels and per-year counts, no account / vendor / description / software / dates
 *   DD      the entries (masked), ≤200 per year + "more", the documents, the reasons
 * line ids stable across re-runs and different across deals; the access
 * levels mapped through the registry (teaser → nothing; C4); the DD
 * writer's lines and the teaser line.
 */
import assert from "node:assert/strict";
import { test, done } from "./_harness";
import { cleanup } from "./_fake-storage";
import { brightwater } from "./_brightwater";
import { refreshGl } from "../../server/gl/service";
import { loadGlContext } from "../../server/gl/context";
import { confirmSummary, writeLinks } from "../../server/gl/links";
import { recomputeTraces } from "../../server/gl/match-run";
import {
  buildEvidence, buyerStatusFor, glEvidenceForBuyer, glLineId, glLineIdsForDeal, glPageId, glTeaserLine, glWriterLines, GL_TEASER_LINE,
  loadEvidenceState, projectEvidence, publishEvidence, publishPreview, snapshotFromState, GlPublishError,
} from "../../server/gl/evidence";
import { cimModeForAccessLevel, isTeaserOnly } from "../../server/gl/levels";
import { blindLeakTerms, collectStrings, findBlindLeaks } from "../../shared/blind-guard";
import type { GlTieOutYear } from "../../shared/gl-types";

const B = brightwater();
const dealId = B.deal.id;
await B.readLedger("qbo-classic.csv");
await refreshGl(dealId, { force: true });

const store = B.w.gl;
const byLabel = async () => new Map((await store.listTraces(dealId)).filter((t) => !t.removedAt).map((t) => [t.label, t]));

// The broker confirms what Cimple found and reviews every add-back.
{
  const traces = await byLabel();
  const c = await loadGlContext(dealId);
  for (const label of ["Owner vehicle expenses", "Meals & entertainment (50% personal use estimate)", "Employment settlement (one-time)", "Related party salary - Emma Brightwater (spouse)"]) {
    const t = traces.get(label)!;
    const n = await confirmSummary(t, { by: "broker", memberId: null }, c);
    if (n === 0) {
      // No one-tap summary: tick every proposal.
      const props = store.data.links.filter((k) => k.traceId === t.id && k.state === "proposed");
      await writeLinks(t, { add: props.map((k) => ({ ledgerId: k.ledgerId!, rowNo: k.rowNo! })) }, { by: "broker", memberId: null }, c);
    }
  }
  await recomputeTraces(dealId);
  for (const t of (await store.listTraces(dealId)).filter((x) => !x.removedAt && x.proof !== "statement")) {
    const computed = t.computed as any;
    await store.updateTrace(t.id, { reviewedAt: new Date(), brokerVerdict: computed?.suggestedVerdict ?? "not_found", buyerReason: t.label.startsWith("Owner vehicle") ? "The owner's personal vehicle; a new owner won't have it." : null } as any);
  }
  // The ledger agrees with the statements in every year (fixed for the test: the tie-out has its own tests).
  const tie: Record<string, GlTieOutYear> = { "2022": { state: "agrees" }, "2023": { state: "agrees" }, "2024": { state: "agrees" } };
  await store.updateTracing(dealId, { tieOut: tie, sellerConfirmation: { role: "owner", memberId: null, name: "Dan Brightwater", at: "2025-03-02T10:00:00.000Z" } } as any);
}

await test("publish preview: defaults, the exact note, the warnings", async () => {
  const p = await publishPreview(dealId);
  assert.equal(p.canPublish, true, p.blocked ?? "");
  assert.equal(p.versions.dd, true);
  assert.ok(p.lines.length >= 6, "every reviewed add-back (statement lines too)");
  assert.ok(p.notes.normal && /of \d+ add-backs?: /.test(p.notes.normal), p.notes.normal ?? "");
  assert.ok(/not an audit/.test(p.notes.normal!));
  assert.ok(p.warnings.some((w) => /every due-diligence buyer/.test(w)));
  if (!p.versions.normal) assert.ok(p.reasons.normal, "a version that starts off says why");
});

await test("publishing is refused until the review is done; nothing to show is refused", async () => {
  const t = (await store.listTraces(dealId)).find((x) => !x.removedAt && x.proof !== "statement")!;
  await store.updateTrace(t.id, { reviewedAt: null } as any);
  await assert.rejects(publishEvidence(dealId, { versions: { dd: true, normal: false, blind: false }, leaveOut: [] }, "broker-1"), (e: unknown) => e instanceof GlPublishError && /Finish 'Add-backs in the books'/.test((e as Error).message));
  await store.updateTrace(t.id, { reviewedAt: new Date() } as any);
  await assert.rejects(publishEvidence(dealId, { versions: { dd: false, normal: false, blind: false }, leaveOut: [] }, "broker-1"), GlPublishError);
});

await publishEvidence(dealId, { versions: { dd: true, normal: true, blind: true }, leaveOut: ["golf club dues"] }, "broker-1");

await test("Blind: constants, counts and fiscal years only — the guard finds nothing", async () => {
  const p = (await buildEvidence(dealId, "blind", "published"))!;
  assert.ok(p, "published with the Blind note on");
  assert.equal(p.mode, "blind");
  for (const l of p.lines) assert.deepEqual(Object.keys(l).sort(), ["lineId", "mark", "status"]);
  assert.ok(p.note && /add-backs?: the costs were/.test(p.note));
  const text = collectStrings(p).join(" ");
  for (const word of ["Brightwater", "Lexus", "Petro", "Holloway", "QuickBooks", "Emma", "Dan"]) assert.ok(!text.includes(word), `blind payload mentions ${word}`);
  assert.equal(findBlindLeaks(collectStrings(p), blindLeakTerms(B.deal as any, { codename: "Project Harbour" })).length, 0);
  assert.equal(p.lines.some((l) => p.lines.filter((x) => x.lineId === l.lineId).length > 1), false);
});

await test("Full: labels and per-year counts, never an account, a vendor, a description, the software or a date", async () => {
  const p = (await buildEvidence(dealId, "normal", "published"))!;
  const json = JSON.stringify(p);
  for (const word of ["Lexus", "Petro", "Holloway", "QuickBooks", "Vehicle – Owner", "2024-0"]) assert.ok(!json.includes(word), `full payload has ${word}`);
  assert.ok(p.lines.every((l) => (l.years ?? []).every((y) => y.entries.length === 0)));
  assert.ok(p.lines.some((l) => (l.years ?? []).some((y) => y.entryCount > 0)), "counts are there");
  assert.ok(!p.lines.some((l) => /golf/i.test(l.label ?? "")), "a left-out add-back isn't shown");
});

await test("DD: the entries, masked; the documents; the reason; the tie-out and the confirmation", async () => {
  const p = (await buildEvidence(dealId, "dd", "published"))!;
  assert.equal(p.pageId, glPageId(dealId));
  const vehicles = p.lines.find((l) => l.label === "Owner vehicle expenses")!;
  assert.ok(vehicles, "the vehicles line");
  const y24 = vehicles.years!.find((y) => y.year === "2024")!;
  assert.ok(y24.entries.length > 0 && y24.entries.length <= 200);
  assert.ok(y24.entries.some((e) => /Lexus/.test(`${e.name} ${e.memo}`)), "vendors shown to due-diligence buyers");
  assert.equal(vehicles.why, "The owner's personal vehicle; a new owner won't have it.");
  assert.ok(vehicles.ledger && vehicles.ledger.documentId);
  const spouse = p.lines.find((l) => /Related party salary/.test(l.label ?? ""));
  if (spouse) {
    const names = spouse.years!.flatMap((y) => y.entries.map((e) => e.name ?? ""));
    assert.ok(names.every((n) => !n || /Brightwater/.test(n)), "only the related party's own name on her pay rows");
  }
  assert.deepEqual(p.tieOut?.map((t) => t.state), ["agrees", "agrees", "agrees"]);
  assert.equal(p.confirmation?.role, "owner");
  assert.ok(!JSON.stringify(p).includes("Per an email"), "the broker's sourcing never reaches buyers");
});

await test("≤200 entries per year, the rest counted", async () => {
  const s = await loadEvidenceState(dealId);
  const { snapshot } = await snapshotFromState(s, { versions: { dd: true, normal: false, blind: false }, leaveOut: [], publishedBy: null });
  const line = snapshot.lines.find((l) => l.years.some((y) => y.entries.length > 0))!;
  const y = line.years.find((x) => x.entries.length > 0)!;
  const many = Array.from({ length: 260 }, (_, i) => ({ ...y.entries[0], linkId: `x${i}`, rowNo: 10_000 + i }));
  const big = { ...snapshot, lines: [{ ...line, years: [{ ...y, entries: many }] }] };
  const p = projectEvidence(big, "dd", { staffNames: [], heldNames: [] })!;
  assert.equal(p.lines[0].years![0].entries.length, 200);
  assert.equal(p.lines[0].years![0].moreEntries, 60);
  assert.equal(p.lines[0].years![0].entryCount, 260);
});

await test("line ids: stable across re-runs, different across deals; glLineIdsForDeal maps analysis ids", async () => {
  const before = (await buildEvidence(dealId, "dd", "published"))!.lines.map((l) => l.lineId).sort();
  await refreshGl(dealId, { force: true });
  const after = (await buildEvidence(dealId, "dd", "published"))!.lines.map((l) => l.lineId).sort();
  assert.deepEqual(after, before);
  assert.notEqual(glLineId(dealId, "owner vehicle expenses"), glLineId("another-deal", "owner vehicle expenses"));
  const ids = await glLineIdsForDeal(dealId);
  assert.equal(ids.get("ab_3"), glLineId(dealId, "owner vehicle expenses"));
  assert.equal(ids.get("ab_1"), ids.get("owner compensation president dan brightwater"), "owner pay: the excess line's id");
});

await test("buyers by access level (C4): teaser nothing; legacy and new keys map through the registry", async () => {
  assert.equal(await glEvidenceForBuyer(dealId, "teaser_only", "a1"), null);
  assert.equal(await glEvidenceForBuyer(dealId, "", "a1"), null, "unreadable → least access");
  assert.equal(await glEvidenceForBuyer(dealId, null, "a1"), null);
  assert.equal((await glEvidenceForBuyer(dealId, "teaser", "a1"))?.mode, "blind", "legacy teaser = the Blind CIM");
  assert.equal((await glEvidenceForBuyer(dealId, "full", "a1"))?.mode, "blind", "legacy full = the Blind CIM");
  assert.equal((await glEvidenceForBuyer(dealId, "blind", "a1"))?.mode, "blind");
  assert.equal((await glEvidenceForBuyer(dealId, "loi", "a1"))?.mode, "normal", "legacy loi = the Full CIM");
  assert.equal((await glEvidenceForBuyer(dealId, "named", "a1"))?.mode, "normal");
  assert.equal((await glEvidenceForBuyer(dealId, "due_diligence", "a1"))?.mode, "dd");
  assert.equal(isTeaserOnly("teaser_only"), true);
  assert.equal(isTeaserOnly("teaser"), false);
  assert.equal(cimModeForAccessLevel("teaser_only"), "blind", "fail-closed second lock");
});

await test("the DD writer's lines: label, status, years — no vendor, no description", async () => {
  const lines = await glWriterLines(dealId);
  assert.ok(lines.length > 0);
  assert.ok(lines.some((l) => /Owner vehicle expenses: found in the books/.test(l)), lines.join("\n"));
  for (const word of ["Lexus", "Petro", "Holloway", "Shell"]) assert.ok(!lines.join(" ").includes(word));
});

await test("the teaser line: only with the Blind note published and every line found in agreeing books", async () => {
  const line = await glTeaserLine(dealId);
  const p = (await buildEvidence(dealId, "blind", "published"))!;
  const proof = p.lines.filter((l) => l.status !== "statement");
  assert.equal(line, proof.every((l) => l.mark) ? GL_TEASER_LINE : null);
  await store.updateTracing(dealId, { published: { ...(await store.getTracing(dealId))!.published!, versions: { dd: true, normal: true, blind: false } } } as any);
  assert.equal(await glTeaserLine(dealId), null);
});

await test("nothing published → no evidence for buyers and no writer lines", async () => {
  await store.updateTracing(dealId, { published: null } as any);
  assert.equal(await glEvidenceForBuyer(dealId, "due_diligence", "a1"), null);
  assert.deepEqual(await glWriterLines(dealId), []);
  const live = await buildEvidence(dealId, "dd", "live");
  assert.equal(live?.preview, true, "the broker's preview is marked");
});

await test("the dialog warns when the CIM's earnings bridge predates the analysis the add-backs come from", async () => {
  const st = (await import("../../server/storage")).storage as any;
  // A bridge that shows the traced add-backs' amounts, but written before the analysis.
  const live = await buildEvidence(dealId, "normal", "live");
  const items = (live?.bridge ?? []).map((c, i) => ({ label: `Add-back ${i + 1}`, value: c.amounts[c.amounts.length - 1] }));
  assert.ok(items.length > 0, "the Full payload carries what the bridge must show");
  st.getCimSectionsByDeal = async () => [
    { id: "s1", sectionKey: "overview", sectionTitle: "Overview", layoutType: "prose_highlight", order: 1, isVisible: true, updatedAt: new Date("2025-03-01") },
    { id: "s2", sectionKey: "bridge", sectionTitle: "Earnings Bridge", layoutType: "waterfall_chart", layoutData: { items }, order: 2, isVisible: true, updatedAt: new Date("2025-01-15") },
  ];
  const p = await publishPreview(dealId);
  assert.ok(p.warnings.some((w) => /"Earnings Bridge" was written before the latest financial analysis/.test(w)), p.warnings.join(" | "));
  st.getCimSectionsByDeal = async () => [{ id: "s2", sectionKey: "bridge", sectionTitle: "Earnings Bridge", layoutType: "waterfall_chart", layoutData: { items }, order: 2, isVisible: true, updatedAt: new Date("2025-02-10") }];
  assert.ok(!(await publishPreview(dealId)).warnings.some((w) => /written before|shows different add-backs/.test(w)));
});

await test("GL-R1-05: a bridge showing other add-backs or amounts → Full and Blind start OFF with the reason, and the warning says why", async () => {
  const st = (await import("../../server/storage")).storage as any;
  st.getCimSectionsByDeal = async () => [
    { id: "s2", sectionKey: "bridge", sectionTitle: "SDE Bridge", layoutType: "waterfall_chart", order: 2, isVisible: true, updatedAt: new Date("2025-02-10"),
      layoutData: { items: [{ label: "Net income", value: 812_000 }, { label: "Non-working family salary", value: 62_000 }, { label: "Personal vehicle expenses", value: 38_123 }] } },
  ];
  const p = await publishPreview(dealId);
  assert.equal(p.versions.normal, false);
  assert.equal(p.versions.blind, false);
  assert.equal(p.versions.dd, true, "the DD page stays on");
  assert.match(p.reasons.normal ?? "", /earnings bridge \("SDE Bridge"\) shows different add-backs or amounts/);
  assert.ok(p.warnings.some((w) => /"SDE Bridge" shows different add-backs or amounts/.test(w)), p.warnings.join(" | "));
  assert.equal(p.bridgeMismatch, "SDE Bridge");
  // Publishing the Full or Blind note under it is refused; the DD page alone is fine.
  const pubBefore = (await store.getTracing(dealId))?.published ?? null;
  await assert.rejects(publishEvidence(dealId, { versions: { dd: true, normal: true, blind: false }, leaveOut: [] }, "b"), (e: unknown) => e instanceof GlPublishError && /Regenerate it before showing the Full or Blind note/.test((e as Error).message));
  const ok = await publishEvidence(dealId, { versions: { dd: true, normal: false, blind: false }, leaveOut: [] }, "b");
  assert.deepEqual(ok.versions, { dd: true, normal: false, blind: false });
  await store.updateTracing(dealId, { published: pubBefore } as any);
  st.getCimSectionsByDeal = async () => [];
});

await test("GL-R1-06: the dialog lists each add-back's 'Why it's added back' exactly as DD buyers read it — saved text, none, or held back", async () => {
  const traces = await byLabel();
  const meals = traces.get("Meals & entertainment (50% personal use estimate)")!;
  const settlement = traces.get("Employment settlement (one-time)")!;
  await store.updateTrace(meals.id, { buyerReason: "" } as any);
  // A text that names a kept-out party is held back (the seller asked to keep it out).
  const st = (await import("../../server/storage")).storage as any;
  const realDeal = st.getDeal;
  st.getDeal = async (id: string) => {
    const d = await realDeal(id);
    return d && id === dealId ? { ...d, extractedInfo: { ...(d.extractedInfo ?? {}), salesPipeline: "Shortlisted for the Harvest Lane Markets RFP.", _brokerPrivateNotes: ["Harvest Lane Markets RFP — keep out of the CIM."] } } : d;
  };
  await store.updateTrace(settlement.id, { buyerReason: "Paid while bidding for Harvest Lane Markets." } as any);
  const p = await publishPreview(dealId);
  st.getDeal = realDeal;
  const line = (label: string) => p.lines.find((l) => l.label === label)!;
  const veh = line("Owner vehicle expenses");
  assert.equal(veh.why, "The owner's personal vehicle; a new owner won't have it.");
  assert.equal(veh.whyText, veh.why);
  assert.equal(veh.whyHeld, false);
  assert.ok(veh.traceId);
  const m = line("Meals & entertainment (50% personal use estimate)");
  assert.equal(m.why, null);
  assert.equal(m.whyText, "", "the broker chose none");
  assert.equal(m.whyHeld, false);
  const set = line("Employment settlement (one-time)");
  assert.equal(set.why, null);
  assert.equal(set.whyHeld, true, "saved, but buyers don't see it");
  await store.updateTrace(settlement.id, { buyerReason: null } as any);
  await store.updateTrace(meals.id, { buyerReason: null } as any);
});

await test("GL-R1-05: buyers still reading a kept copy whose bridge shows other add-backs → the broker is told, Full/Blind may still be ticked (the note appears with the update)", async () => {
  const st = (await import("../../server/storage")).storage as any;
  const { memorySnapshotStore, _setSnapshotStoreForTests } = await import("../../server/cim/published-snapshot");
  const { bridgeMismatch } = await import("../../server/gl/evidence");
  const kept = memorySnapshotStore();
  _setSnapshotStoreForTests(kept);
  const realDeal = st.getDeal;
  st.getDeal = async (id: string) => { const d = await realDeal(id); return d && id === dealId ? { ...d, isLive: true, cimGeneration: { buyerHold: { servingPublished: true } } } : d; };
  st.getCimSectionsByDeal = async () => []; // the regenerated draft has no bridge yet
  await kept.save(dealId, { sections: [{ id: "k1", dealId, sectionKey: "ebitda_normalization", sectionTitle: "EBITDA Normalization & Adjustments", order: 6, layoutType: "waterfall_chart", isVisible: true,
    layoutData: { items: [{ label: "Personal vehicle expenses", value: 38_000, type: "add" }, { label: "Non-working family salary", value: 62_000, type: "add" }] } }], blindOverrides: [], ddOverrides: [], blindCodename: null } as any);
  const p = await publishPreview(dealId);
  assert.equal(p.bridgeMismatch, null, "the broker's current CIM doesn't contradict it");
  assert.equal(p.keptBridgeMismatch, "EBITDA Normalization & Adjustments", "GL-R2-02: the kept copy's bridge is named for the dialog and the seed script");
  assert.ok(p.warnings.some((w) => /still reading the previous version of your CIM, whose "EBITDA Normalization & Adjustments"/.test(w)), p.warnings.join(" | "));
  assert.ok(p.warnings.some((w) => /due-diligence buyers read this page right after that older bridge/.test(w)), "GL-R2-02: the DD side is warned too");
  // Published (DD + Full): the KPI's changes say what each version's buyers see now.
  const pubBefore = (await store.getTracing(dealId))?.published ?? null;
  await publishEvidence(dealId, { versions: { dd: true, normal: true, blind: false }, leaveOut: [] }, "b");
  const { evidenceChangeCount } = await import("../../server/gl/evidence");
  const ch = await evidenceChangeCount(dealId);
  // Notices, not changes: "Update what buyers see" wouldn't change them (the KPI never counts them as changes).
  assert.equal(ch.notices.length, 1, "one line");
  assert.match(ch.notices[0], /^Buyers still read the previous version of your CIM, whose "EBITDA Normalization & Adjustments" shows other add-backs or amounts: the Full and Blind note is held back, and the due-diligence page tells its readers its amounts are the current ones\. Publish the updated CIM/);
  assert.ok(!ch.changes.some((c) => /held back|Due-diligence buyers read/.test(c)), ch.changes.join(" | "));
  const again = await publishPreview(dealId);
  assert.ok(!again.changes.some((c) => /held back|Due-diligence buyers read/.test(c)), "the dialog says it once (in its warnings)");
  await store.updateTracing(dealId, { published: pubBefore } as any);
  const m = await bridgeMismatch(dealId, (await snapshotFromState(await loadEvidenceState(dealId), { versions: { dd: true, normal: true, blind: true }, leaveOut: [], publishedBy: null })).snapshot);
  assert.deepEqual(m, { title: "EBITDA Normalization & Adjustments", keptCopy: true });
  st.getDeal = realDeal;
  _setSnapshotStoreForTests(null);
});

await test("GL-R2-08: the broker's verdict words match what buyers read (a T4-proved add-back is 'Shown by a document' on both sides)", async () => {
  const { verdictWords, VERDICT_WORDS } = await import("../../shared/gl-copy");
  const { GL_BUYER_STATUS_WORDS } = await import("../../shared/gl-evidence");
  for (const overall of ["found", "document", "close", "short", "not_started"] as const) {
    for (const v of ["found", "partly_found", "not_found"] as const) {
      const buyer = buyerStatusFor({ proof: "payroll", brokerVerdict: v } as any, { overall, suggestedVerdict: v } as any);
      assert.equal(verdictWords(v, overall), GL_BUYER_STATUS_WORDS[buyer], `${v} / ${overall}`);
    }
  }
  assert.equal(verdictWords("found", "document"), "Shown by a document");
  assert.equal(verdictWords("found", "found"), VERDICT_WORDS.found);
});

cleanup(B.w);
done("evidence");
