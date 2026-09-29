/**
 * Free round 2, stream "journeys" (J1–J11) — the pure rules behind the
 * seller portal, the broker's views of it and the CIM gate.
 *
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/unit/f2-journeys-units.test.ts
 */
import assert from "node:assert/strict";
import {
  checklistCounts,
  documentRequestLabel,
  intakeComplete,
  openInterviewItems,
  openItemTaskIds,
  sellerApprovalField,
  sellerIntakeState,
  sellerMaySatisfyTask,
  sellerReviewStage,
  sellerSteps,
  sellerTodoItems,
  sellerUnavailableReason,
  withSellerUnavailableNote,
  withoutSellerUnavailableNote,
} from "../../shared/seller-portal";
import { discrepancyBlocksCim, waitingOnSellerAfterInterview } from "../../shared/discrepancy-gate";
import { computeNextStep, phaseChecklist, nextStepText } from "../../shared/deal-progress";
import { industryDocsKey, requirementsForIndustry, getSupportedIndustries, untouchedOtherIndustryRows } from "../../server/documents/requirements";
import { shouldEmailFollowUp, awaitingSellerAfterInterview, turnFloorFor, followUpsAnsweredNotice } from "../../server/interview/seller-followups";
import { governCompletion } from "../../server/interview/turn-guard";
import { NOTIFICATION_ROUTING } from "../../shared/schema";
import { ctaCopy } from "../../client/src/components/deal/ReadyToBuildCta";
import { openItemsHtml } from "../../server/notifications/interview-complete";
import { sellerPortalRecipients, BROKER_EVENT_PREFERENCE, ownerGetsEvent } from "../../server/notifications/service";
import { faqKnowledgeRows } from "../../server/qa/cim-context";
import { readerMaySeeRow, rowScope } from "../../shared/buyer-qa-scope";
import { blindLeakTerms } from "../../shared/blind-guard";
import { shouldAutoScrape, scrapeInBackground, autoScrapeRunning, setAutoScrapeClock, AUTO_SCRAPE_RETRY_MS } from "../../server/scraper/auto-scrape";

let passed = 0;
const check = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
};

// ── J5: the New Deal label finds its industry's document list ────────────
check("J5 every New Deal label with an industry list resolves to it", () => {
  const cases: Array<[string, string | null]> = [
    ["Restaurant / Food Service", "restaurant_food_service"],
    ["Healthcare", "healthcare"],
    ["Manufacturing", "manufacturing"],
    ["Construction", "construction"],
    ["Professional Services", "professional_services"],
    ["Technology / SaaS", "technology_online"],
    ["Automotive", "automotive"],
    ["Retail", "retail"],
    ["Distribution / Wholesale", "wholesale_distribution"],
    ["E-commerce", "retail"], // a store selling online: sales, inventory, suppliers — not source code
    ["construction", "construction"], // a key still works
    ["Other", null],
  ];
  for (const [label, key] of cases) assert.equal(industryDocsKey(label), key, label);
  // The old lookup (INDUSTRY_DOCS[label]) found nothing for any label.
  for (const [label] of cases.slice(0, 10)) assert.ok(!getSupportedIndustries().includes(label), `"${label}" is not itself a key`);
});
check("J5 the industry decides before the sub-industry (production deals the combined text misfiled)", () => {
  // (The live dry run: Ridgeline → construction, Harborview → healthcare, Great Lakes → healthcare.)
  assert.equal(industryDocsKey("Manufacturing", "Custom structural & miscellaneous metal fabrication and welding (oil & gas, agriculture, commercial construction)"), "manufacturing");
  assert.equal(industryDocsKey("IT / Managed Services", "Managed service provider (MSP) for dental, legal and accounting practices"), "professional_services");
  assert.equal(industryDocsKey("Manufacturing", "Custom injection molding — automotive Tier-2 and medical device components"), "manufacturing");
  assert.equal(industryDocsKey("Home Services", "Landscaping and snow & ice management"), "construction");
  assert.equal(industryDocsKey("Technology / SaaS", "B2B SaaS"), "technology_online");
  assert.equal(industryDocsKey("E-commerce / Consumer Products (Amazon FBA)"), "retail");
});
check("J5 a construction deal is asked for the WIP schedule, bonding letter, holdbacks and WSIB clearance", () => {
  const names = requirementsForIndustry("Construction").map((r) => r.documentName);
  assert.ok(names.length > 12, "more than the 12 universal rows");
  for (const want of ["Work-in-Progress (WIP) Schedule", "Surety Bonding Capacity Letter", "Holdbacks Receivable Report", "WSIB/WCB Clearance Certificate"]) {
    assert.ok(names.includes(want), want);
  }
});
check("J5 correcting the industry drops the old list's untouched requests — never an upload, a note or a manual one", () => {
  const construction = requirementsForIndustry("Construction").filter((r) => !requirementsForIndustry(null).some((u) => u.documentName === r.documentName));
  let n = 0;
  const row = (documentName: string, o: any = {}) => ({ id: `r${++n}`, documentName, source: "auto", status: "missing", uploadedFileId: null, notes: null, ...o });
  const rows = [
    row(requirementsForIndustry(null)[0].documentName), // universal: stays
    row(construction[0].documentName), // untouched construction row: goes
    row(construction[1].documentName, { status: "uploaded", uploadedFileId: "doc1" }), // uploaded: stays
    row(construction[2].documentName, { notes: "Seller: I don't have this — no bonding" }), // annotated: stays
    row("Equipment lease for the forklift", { source: "manual" }), // the broker's own: stays
  ];
  assert.deepEqual(untouchedOtherIndustryRows(rows, "Restaurant / Food Service").map((r) => r.id), ["r2"]);
  assert.deepEqual(untouchedOtherIndustryRows(rows, "Construction"), [], "the deal's own list is never pruned");
});
check("J5 the sub-industry decides when the label doesn't (\"Other\" + physiotherapy clinic)", () => {
  assert.equal(industryDocsKey("Other", "Physiotherapy clinic"), "healthcare");
  assert.equal(requirementsForIndustry("Other").length, 12);
  assert.ok(requirementsForIndustry("Healthcare").length > 12);
});

// ── J7: intake is complete at Key People, not page 1 ─────────────────────
const page1 = { questionnaireData: { businessName: "Clearwater", reasonForSelling: "Retiring" } };
check("J7 page 1 alone is 'in progress', not complete", () => {
  assert.deepEqual(sellerIntakeState(page1), { status: "in_progress", pagesDone: 1, pagesTotal: 3 });
  assert.equal(intakeComplete(page1), false);
  const two = { ...page1, operationalSystems: { accounting: "QuickBooks" } };
  assert.equal(sellerIntakeState(two).pagesDone, 2);
  assert.equal(intakeComplete(two), false);
  assert.equal(intakeComplete({ ...two, employeeChart: [] }), true, "an empty Key People list is still a save");
  assert.equal(intakeComplete({ sqCompleted: true }), true, "received outside Cimple");
  assert.equal(intakeComplete({ ...page1, interviewCompleted: true }), true, "the intake wizard's own rule");
  assert.equal(sellerIntakeState({}).status, "not_started");
  assert.equal(sellerIntakeState({ questionnaireData: { businessName: "" } }).status, "not_started", "an empty autosave is nothing");
});
check("J7 the deal list's booleans read the same way", () => {
  assert.equal(intakeComplete({ questionnaireData: true, operationalSystems: true, employeeChart: true }), true);
  assert.equal(intakeComplete({ questionnaireData: true, operationalSystems: false, employeeChart: false }), false);
});
check("J7 the seller's steps send a page-1 seller back to the intake, not the interview", () => {
  const s = sellerSteps({ intake: sellerIntakeState(page1), interviewCompleted: false, interviewPct: 0, docPct: 0 });
  assert.equal(s.currentStep, "intake");
  assert.equal(s.steps[0].status, "current");
  assert.equal(s.steps[0].pct, 33);
});
check("J7 the broker's checklist and next step agree", () => {
  const deal = { id: "D", phase: "phase1_info_collection", ndaSigned: true, ...page1 } as any;
  assert.equal(phaseChecklist("phase1_info_collection", deal, { invited: true }).find((i) => i.label === "Seller questionnaire")!.done, false);
  assert.equal(phaseChecklist("phase2_platform_intake", deal).find((i) => i.label === "Seller onboarding")!.done, false);
  assert.equal(nextStepText(computeNextStep(deal, { invited: true })), "Waiting on the seller: questionnaire");
  const done = { ...deal, operationalSystems: {}, employeeChart: [{ name: "Dana" }] };
  assert.equal(phaseChecklist("phase2_platform_intake", done).find((i) => i.label === "Seller onboarding")!.done, true);
});

// ── J4: "I don't have this" and the document step ────────────────────────
check("J4 an unavailable required row no longer holds the seller on Documents", () => {
  const rows = [
    { isRequired: true, status: "uploaded" },
    { isRequired: true, status: "verified" },
    { isRequired: true, status: "unavailable" },
    { isRequired: true, status: "missing" },
    { isRequired: false, status: "missing" },
  ];
  assert.deepEqual(checklistCounts(rows), { requiredTotal: 4, requiredUploaded: 2, requiredUnavailable: 1, percentage: 75 });
  rows[3].status = "unavailable";
  assert.equal(checklistCounts(rows).percentage, 100);
  const s = sellerSteps({ intake: { status: "complete", pagesDone: 3, pagesTotal: 3 }, interviewCompleted: true, interviewPct: 90, docPct: 100 });
  assert.equal(s.currentStep, "review", "the cash café that owns its building can finish");
  assert.equal(checklistCounts([]).percentage, 100, "nothing required → nothing blocks (used to be 0% forever)");
});
check("J4 the seller's reason sits under the broker's note and comes off cleanly", () => {
  const n = withSellerUnavailableNote("Need the last 3 years", "We own the building");
  assert.equal(n, "Need the last 3 years\nSeller: I don't have this — We own the building");
  assert.equal(sellerUnavailableReason(n), "We own the building");
  assert.equal(withoutSellerUnavailableNote(n), "Need the last 3 years");
  assert.equal(sellerUnavailableReason(withSellerUnavailableNote(null, "")), "");
  assert.equal(withoutSellerUnavailableNote(withSellerUnavailableNote(null, "x")), null);
  // Saying it twice doesn't stack two lines.
  assert.equal(withSellerUnavailableNote(n, "No lease").split("\n").length, 2);
});

// ── J1: the interview's to-dos ───────────────────────────────────────────
const t = (o: any) => ({ status: "pending", createdBy: "ai_interview", createdAt: new Date("2026-09-20"), ...o });
const tasks = [
  t({ id: "1", type: "document_request", title: "Get IPAC inspection reports with exact dates" }),
  t({ id: "2", type: "follow_up", title: "Confirm WCB billing audit history" }),
  t({ id: "3", type: "follow_up", title: "Confirm WCB billing audit history", createdAt: new Date("2026-09-21") }), // a re-created duplicate
  t({ id: "4", type: "skipped_question", title: "Owner health" }),
  t({ id: "5", type: "follow_up", title: "Verify with counsel: nonCompete" }),
  t({ id: "6", type: "follow_up", title: "Broker's own note", createdBy: "ai_interview_broker" }),
  t({ id: "7", type: "document_request", title: "Get lease", status: "completed" }),
  t({ id: "8", type: "follow_up", title: "Seller asked for changes to the CIM content", createdBy: "seller_review" }),
  t({ id: "9", type: "follow_up", title: "Call the landlord", createdBy: "B1" }),
];
check("J1 the seller sees documents and look-ups only — never the broker's, counsel checks or skipped questions", () => {
  const todo = sellerTodoItems(tasks);
  assert.deepEqual(todo, [
    { id: "1", kind: "document", title: "IPAC inspection reports with exact dates" },
    { id: "2", kind: "follow_up", title: "Confirm WCB billing audit history" },
  ]);
});
check("J1 the broker sees every open interview item (and the seller's change request), once each", () => {
  assert.deepEqual(openInterviewItems(tasks).map((x) => x.id), ["1", "2", "4", "5", "6", "8"]);
  // Closing "Confirm WCB billing audit history" closes its re-created copy too (no copy pops up in its place).
  assert.deepEqual(openItemTaskIds(tasks, tasks[1]), ["2", "3"]);
  assert.deepEqual(openItemTaskIds(tasks, tasks[0]), ["1"]);
  // A document request re-created in other words ("Upload…" vs "Get…") is the same document —
  // one row for the seller, and an upload against either closes both (the Clearwater clone had
  // the IPAC request twice; closing one left the other on the seller's list).
  const docs = [
    t({ id: "d1", type: "document_request", title: "Get IPAC inspection reports with exact dates" }),
    t({ id: "d2", type: "document_request", title: "Upload the IPAC inspection reports with exact dates", createdAt: new Date("2026-09-21") }),
    t({ id: "d3", type: "document_request", title: "Get IPAC inspection reports with exact dates", status: "completed" }),
  ];
  assert.deepEqual(openItemTaskIds(docs, docs[1]), ["d1", "d2"]);
  assert.deepEqual(openInterviewItems(docs).map((x) => x.id), ["d1"]);
  assert.equal(sellerTodoItems(docs).length, 1);
});
check("J1 request titles read as document names", () => {
  assert.equal(documentRequestLabel("Get template employment agreement"), "Template employment agreement");
  assert.equal(documentRequestLabel("Obtain a copy of the lease"), "Lease");
  assert.equal(documentRequestLabel("Kyle's tooling cost spreadsheet"), "Kyle's tooling cost spreadsheet");
});
check("J1 an upload may only close an open document request of the seller's own interview on this deal", () => {
  assert.equal(sellerMaySatisfyTask(tasks[0], "D1", "D1"), true);
  assert.equal(sellerMaySatisfyTask(tasks[0], "D1", "D2"), false, "another deal's task");
  assert.equal(sellerMaySatisfyTask(tasks[1], "D1", "D1"), false, "a follow-up");
  assert.equal(sellerMaySatisfyTask(tasks[6], "D1", "D1"), false, "already done");
  assert.equal(sellerMaySatisfyTask(t({ id: "x", type: "document_request", title: "y", createdBy: "ai_interview_broker" }), "D1", "D1"), false, "the broker's own");
});
check("J1 the interview-complete email lists the open items, escaped", () => {
  const html = openItemsHtml([{ type: "document_request", title: "Get <b>IPAC</b> reports" }, { type: "follow_up", title: "Confirm WCB audits" }]);
  assert.match(html, /Open items from the interview \(2\)/);
  assert.match(html, /Document: Get &lt;b&gt;IPAC&lt;\/b&gt; reports/);
  assert.match(html, /Follow up: Confirm WCB audits/);
  assert.equal(openItemsHtml([]), "");
  assert.match(openItemsHtml(Array.from({ length: 12 }, (_, i) => ({ type: "follow_up", title: `x${i}` }))), /…and 2 more/);
});

// ── J2: a routed conflict after the interview keeps blocking ─────────────
check("J2 a critical row routed to a seller who had finished the interview blocks until they answer", () => {
  const routed = { severity: "critical", status: "ask_seller" };
  assert.equal(discrepancyBlocksCim(routed, false), false, "interview running: it raises it (unchanged)");
  assert.equal(discrepancyBlocksCim(routed, true), true, "interview finished: nothing raises it — it blocks");
  assert.equal(discrepancyBlocksCim({ severity: "significant", status: "ask_seller" }, true), false, "only criticals block");
  assert.equal(discrepancyBlocksCim({ severity: "critical", status: "open" }, false), true);
  assert.equal(discrepancyBlocksCim({ severity: "critical", status: "seller_responded" }, true), true);
  assert.equal(discrepancyBlocksCim({ severity: "critical", status: "resolved" }, true), false);
  assert.equal(awaitingSellerAfterInterview(routed, true), true);
  assert.deepEqual(waitingOnSellerAfterInterview([routed, { status: "open" }], true), [routed]);
  assert.deepEqual(waitingOnSellerAfterInterview([routed], false), []);
});
check("J2 the deal list says it's the seller's move", () => {
  const deal = { id: "D", phase: "phase3_content_creation", interviewCompleted: true, cimLayoutGeneratedAt: new Date(), contentApprovedByBroker: true, contentApprovedBySeller: true } as any;
  assert.equal(nextStepText(computeNextStep(deal, { sellerFollowUpsBlocking: 2 })), "Waiting on the seller: answer 2 follow-up questions");
  assert.equal(nextStepText(computeNextStep(deal, {})), "Your move: move the deal to Design");
  // Still in Seller Intake (the Ridgeline clone: interview done, both criticals sent back).
  const intake = { ...deal, phase: "phase2_platform_intake", contentApprovedByBroker: false, contentApprovedBySeller: false };
  assert.equal(nextStepText(computeNextStep(intake, { sellerFollowUpsBlocking: 2 })), "Waiting on the seller: answer 2 follow-up questions");
  assert.equal(nextStepText(computeNextStep(intake, {})), "Your move: start content creation");
});
check("J2 a follow-up session on a finished interview may end once its questions are covered (no 10-turn floor)", () => {
  assert.equal(turnFloorFor(false, 10), 10, "the first interview keeps the floor");
  assert.equal(turnFloorFor(null, 10), 10);
  assert.equal(turnFloorFor(true, 10), 0, "the seller answering follow-ups isn't held for ten turns");
  // Governance with the floor lifted: the model's end stands when nothing else blocks…
  const base = {
    shouldEnd: true,
    sellerMessage: "Yes, the 2023 revenue in the P&L is right — the $2.3M included the equipment sale.",
    userTurnCount: 2,
    sectionCoverage: [{ key: "companyOverview", status: "well_covered" as const }],
    deferredTopics: [],
    intentStop: "none" as const,
  };
  assert.equal(governCompletion({ ...base, minTurnsBeforeEnd: turnFloorFor(true, 10) }).allowEnd, true);
  assert.equal(governCompletion({ ...base, minTurnsBeforeEnd: turnFloorFor(false, 10) }).allowEnd, false);
  // …and every other end rule still applies (an undiscussed critical conflict holds it open).
  assert.equal(governCompletion({ ...base, minTurnsBeforeEnd: 0, blockingItems: ["the 2023 revenue conflict"] }).allowEnd, false);
});
check("J2 the broker is told when the seller answered the follow-ups", () => {
  const one = followUpsAnsweredNotice({ handedBack: 1, discussed: 1 }, "Clearwater Physio");
  assert.equal(one.title, "The seller answered your follow-up question — Clearwater Physio");
  assert.match(one.body, /the follow-up question you sent them/);
  assert.match(followUpsAnsweredNotice({ handedBack: 3, discussed: 3 }, "X").body, /the 3 follow-up questions/);
  // Never "answered" for a question nobody raised (the seller pressed End first).
  const none = followUpsAnsweredNotice({ handedBack: 2, discussed: 0 }, "X");
  assert.equal(none.title, "The seller ended the follow-up before your follow-up questions came up — X");
  assert.doesNotMatch(none.body, /answered|went through/);
  assert.match(followUpsAnsweredNotice({ handedBack: 3, discussed: 1 }, "X").title, /answered 1 of your 3 follow-up questions/);
  // A new broker event with a preference switch; no existing event's recipients change.
  assert.deepEqual(NOTIFICATION_ROUTING.seller_followups_answered, { teams: ["broker"], roles: ["lead", "associate"] });
  assert.equal(BROKER_EVENT_PREFERENCE.seller_followups_answered, "interviewUpdates");
  assert.equal(ownerGetsEvent("seller_followups_answered", "owner@brokerage.invalid", []), true);
});
check("J2 the Overview's next-step card says the CIM waits on the seller's follow-up answers", () => {
  const c = ctaCopy(0, false, 2);
  assert.equal(c.blocked, true);
  assert.match(c.title, /waiting on the seller to answer 2 follow-up questions/);
  assert.equal(ctaCopy(1, false, 2).title.includes("resolve 1 critical discrepancy"), true, "the broker's own conflicts come first");
  assert.equal(ctaCopy(0, false, 0).blocked, false);
});
check("J2 a burst of routings emails the seller once an hour", () => {
  const now = Date.parse("2026-09-28T12:00:00Z");
  assert.equal(shouldEmailFollowUp([], now), true);
  assert.equal(shouldEmailFollowUp([{ type: "seller_followup_questions", createdAt: new Date(now - 10 * 60_000) }], now), false);
  assert.equal(shouldEmailFollowUp([{ type: "seller_followup_questions", createdAt: new Date(now - 2 * 3600_000) }], now), true);
  assert.equal(shouldEmailFollowUp([{ type: "cim_ready", createdAt: new Date(now) }], now), true);
});
check("J2/J3 seller emails carry each person's OWN seller link — never someone else's token", () => {
  const invites: any[] = [
    { id: "I-seller", token: "tok-seller", sellerEmail: "pat@seller.invalid", sellerName: "Pat", status: "accepted", expiresAt: null },
    { id: "I-acct", token: "tok-acct", sellerEmail: "acct@seller.invalid", sellerName: "Acct", status: "pending", expiresAt: null },
    { id: "I-old", token: "tok-revoked", sellerEmail: "gone@seller.invalid", status: "revoked" },
  ];
  // No seller-team member → the sent/accepted invites.
  let r = sellerPortalRecipients("cim_ready", [], invites);
  assert.deepEqual(r.map((x) => [x.email, x.token, x.via]), [["pat@seller.invalid", "tok-seller", "seller_invite"]]);
  // Members routed for the event get their own minted link; one without a live link is skipped.
  const members: any[] = [
    { id: "M1", teamType: "seller", role: "owner", email: "Pat@Seller.invalid", inviteStatus: "accepted", emailNotifications: true },
    { id: "M2", teamType: "seller", role: "representative", email: "rep@seller.invalid", inviteStatus: "sent", emailNotifications: true },
    { id: "M3", teamType: "seller", role: "accountant", email: "acct@seller.invalid", inviteStatus: "accepted", emailNotifications: true },
  ];
  r = sellerPortalRecipients("cim_ready", members, invites);
  assert.deepEqual(r.map((x) => [x.recipientId, x.token]), [["M1", "tok-seller"]], "the rep has no link of their own; the accountant isn't routed");
});

// ── J3: which approval the seller is asked for ──────────────────────────
check("J3 the seller reviews only what the broker approved, content then design", () => {
  assert.equal(sellerReviewStage({}), "not_ready");
  assert.equal(sellerReviewStage({ contentApprovedByBroker: true }), "content");
  assert.equal(sellerReviewStage({ contentApprovedByBroker: true, contentApprovedBySeller: true }), "waiting");
  assert.equal(sellerReviewStage({ contentApprovedByBroker: true, contentApprovedBySeller: true, designApprovedByBroker: true }), "design");
  assert.equal(sellerReviewStage({ designApprovedByBroker: true, designApprovedBySeller: true }), "approved");
  assert.equal(sellerApprovalField("content"), "contentApprovedBySeller");
  assert.equal(sellerApprovalField("design"), "designApprovedBySeller");
  assert.equal(sellerApprovalField("waiting"), null);
});

check("J3 the deal list says 'Waiting on the seller' only once the CIM was sent to them", () => {
  const content = { id: "D", phase: "phase3_content_creation", cimContent: true, contentApprovedByBroker: true, interviewCompleted: true } as any;
  // Not sent yet: the broker's move (send it, or approve on the seller's behalf).
  assert.equal(nextStepText(computeNextStep(content, { hasCimSections: true, sellerReviewSent: { content: false, design: false } })), "Your move: send the CIM to the seller for review");
  assert.equal(nextStepText(computeNextStep(content, { hasCimSections: true, sellerReviewSent: { content: true, design: false } })), "Waiting on the seller: content approval");
  // Callers that don't know keep the old reading.
  assert.equal(nextStepText(computeNextStep(content, { hasCimSections: true })), "Waiting on the seller: content approval");
  const design = { id: "D", phase: "phase4_design_finalization", cimContent: true, cimDesignData: true, designApprovedByBroker: true, contentApprovedByBroker: true, contentApprovedBySeller: true } as any;
  assert.equal(nextStepText(computeNextStep(design, { hasCimSections: true, sectionsAwaitingApproval: 0, sellerReviewSent: { content: true, design: false } })), "Your move: send the design to the seller for sign-off");
  assert.equal(nextStepText(computeNextStep(design, { hasCimSections: true, sectionsAwaitingApproval: 0, sellerReviewSent: { content: true, design: true } })), "Waiting on the seller: design sign-off");
});

// ── J6: FAQ entries are part of the buyer Q&A knowledge base ─────────────
check("J6 published FAQs become 'all'-scope rows; a Blind buyer never gets one that names the business", () => {
  const deal = { id: "D1", businessName: "Harbour Point Dental Ltd", blindCodename: "Project Lighthouse", extractedInfo: {} };
  const rows = faqKnowledgeRows("D1", [
    { id: "f1", question: "How long is the lease?", answer: "Ten years remaining with two 5-year options.", isPublished: true, order: 2, createdAt: new Date(), updatedAt: new Date() },
    { id: "f2", question: "Who runs Harbour Point Dental day to day?", answer: "The office manager.", isPublished: true, order: 1, createdAt: new Date(), updatedAt: new Date() },
    { id: "f3", question: "Draft", answer: "not yet", isPublished: false, order: 0, createdAt: new Date(), updatedAt: new Date() },
    { id: "f4", question: "Empty", answer: "  ", isPublished: true, order: 0, createdAt: new Date(), updatedAt: new Date() },
  ]);
  assert.deepEqual(rows.map((r) => r.id), ["faq:f2", "faq:f1"], "published, answered, in the broker's order");
  const terms = blindLeakTerms(deal as any, { codename: deal.blindCodename });
  const visible = (level: string) =>
    rows.filter((q) => readerMaySeeRow(q, rowScope(q, false), { id: "A1", accessLevel: level }, terms)).map((q) => q.id);
  assert.deepEqual(visible("teaser"), ["faq:f1"], "Blind teaser: the lease answer only");
  assert.deepEqual(visible("full"), ["faq:f1"], "Blind full: still not the one naming the business");
  assert.deepEqual(visible("loi"), ["faq:f2", "faq:f1"], "named-CIM buyer: both");
});

// ── J11: the website is read without the broker finding the button ──────
check("J11 a real deal with an unread website is read once, in the background; demo deals never", async () => {
  assert.equal(shouldAutoScrape({ websiteUrl: "https://x.test", scrapedAt: null }), true);
  assert.equal(shouldAutoScrape({ websiteUrl: "https://x.test", scrapedAt: new Date() }), false);
  assert.equal(shouldAutoScrape({ websiteUrl: " ", scrapedAt: null }), false);
  assert.equal(shouldAutoScrape({ websiteUrl: "https://x.test", scrapedAt: null, demoKey: "maple" }), false);
});

async function asyncChecks() {
  let calls = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const fake = async () => { calls++; await gate; };
  const deal = { id: "D-scrape", websiteUrl: "https://clinic.test", scrapedAt: null };
  assert.equal(scrapeInBackground(deal, "deal created", fake), true);
  assert.equal(scrapeInBackground(deal, "interview started", fake), false, "never twice at once");
  assert.equal(autoScrapeRunning("D-scrape"), true);
  release();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls, 1);
  assert.equal(autoScrapeRunning("D-scrape"), false);
  // A failing read never throws out of the caller.
  assert.equal(scrapeInBackground(deal, "retry", async () => { throw new Error("no site"); }), true);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(autoScrapeRunning("D-scrape"), false);
  // …and a failed read isn't retried on every interview opening — only after the back-off.
  let t = Date.now();
  setAutoScrapeClock(() => t);
  let retried = 0;
  assert.equal(scrapeInBackground(deal, "interview started", async () => { retried++; }), false, "failed a moment ago");
  t += AUTO_SCRAPE_RETRY_MS + 1;
  assert.equal(scrapeInBackground(deal, "interview started", async () => { retried++; }), true, "tried again after 6 hours");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(retried, 1);
  setAutoScrapeClock();
  passed++;
  console.log("  ok  J11 background read is deduplicated and never throws");
}

asyncChecks()
  .then(() => {
    console.log(`f2-journeys units: ${passed} checks passed`);
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
