/**
 * Free round 2, stream "journeys" — round 2 of the checker's findings.
 *
 *   J5  the broker's industry correction survives the seller's next session
 *       (the interview's stored identification used to re-add the old
 *       industry's document requests); Hospitality / Real Estate get lists;
 *       food manufacturing / distribution aren't filed as restaurants
 *   J2  the 1-hour follow-up email window ends once the seller came back
 *   J3  a seller's change request makes the next step the broker's
 *   opt-out: a seller member who turned email off is never emailed at the
 *       invite address instead
 *
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/unit/f2-journeys-r2.test.ts
 */
import assert from "node:assert/strict";
import {
  industryDocsKey,
  requirementsForIndustry,
  documentRequirementsIndustry,
  ensureDealDocumentRequirements,
  switchIndustryDocumentRequirements,
} from "../../server/documents/requirements";
import { storage } from "../../server/storage";
import { shouldEmailFollowUp } from "../../server/interview/seller-followups";
import { sellerPortalRecipients } from "../../server/notifications/service";
import { sellerReviewTurn } from "../../shared/seller-portal";
import { computeNextStep, nextStepText } from "../../shared/deal-progress";
import { discrepancyBlocksCim } from "../../shared/discrepancy-gate";
import { discrepancyBlockMessage } from "../../server/routes/cim-builder";

let passed = 0;
const pending: Array<[string, () => void | Promise<void>]> = [];
const check = (name: string, fn: () => void | Promise<void>) => pending.push([name, fn]);

// ── J5: which list ──────────────────────────────────────────────────────
check("J5 Hospitality and Real Estate (New Deal labels) get lists of their own", () => {
  assert.equal(industryDocsKey("Hospitality"), "hospitality_lodging");
  assert.equal(industryDocsKey("Hospitality", "Boutique hotel, 42 rooms"), "hospitality_lodging");
  assert.equal(industryDocsKey("Hospitality", "Full-service restaurant and bar"), "restaurant_food_service", "a restaurant filed under Hospitality");
  assert.equal(industryDocsKey("Real Estate"), "real_estate");
  assert.equal(industryDocsKey("Real Estate", "Residential property management"), "real_estate");
  assert.equal(industryDocsKey("Property management"), "real_estate", "not the construction list (bonding, WIP, holdbacks)");
  assert.equal(industryDocsKey("Other", "Motel and campground"), "hospitality_lodging");
  const hotel = requirementsForIndustry("Hospitality").map((r) => r.documentName);
  assert.ok(hotel.includes("Occupancy, ADR and RevPAR Reports (3 Years)"));
  assert.ok(!hotel.includes("Grease Trap Maintenance Records"));
  assert.ok(requirementsForIndustry("Real Estate").some((r) => r.documentName === "Rent Roll (Current)"));
});
check("J5 food manufacturing is a plant and food distribution a distributor — not restaurants", () => {
  assert.equal(industryDocsKey("Food manufacturing"), "manufacturing");
  assert.equal(industryDocsKey("Food processing plant"), "manufacturing");
  assert.equal(industryDocsKey("Food distribution"), "wholesale_distribution");
  assert.equal(industryDocsKey("Other", "Wholesale food distribution"), "wholesale_distribution");
  assert.equal(industryDocsKey("Auto parts distribution"), "wholesale_distribution");
  // Unchanged: every New Deal label and the production mixes.
  assert.equal(industryDocsKey("Restaurant / Food Service"), "restaurant_food_service");
  assert.equal(industryDocsKey("Distribution / Wholesale"), "wholesale_distribution");
  assert.equal(industryDocsKey("Manufacturing", "Custom structural & miscellaneous metal fabrication and welding (oil & gas, agriculture, commercial construction)"), "manufacturing");
  assert.equal(industryDocsKey("Home Services", "Landscaping and snow & ice management"), "construction");
  assert.equal(industryDocsKey("Other", "Physiotherapy clinic"), "healthcare");
  assert.equal(industryDocsKey("Other"), null);
});

// ── J5: the broker's correction sticks ──────────────────────────────────
check("J5 the deal's own industry wins over the interview's stored identification", () => {
  const identified = { industry: "Manufacturing", subIndustry: "Metal fabrication" };
  assert.deepEqual(documentRequirementsIndustry({ industry: "Restaurant / Food Service", subIndustry: null }, identified), { industry: "Restaurant / Food Service", subIndustry: null });
  // "Other" has no list: what the interview identified fills in.
  assert.deepEqual(documentRequirementsIndustry({ industry: "Other", subIndustry: null }, identified), { industry: "Manufacturing", subIndustry: "Metal fabrication" });
  assert.deepEqual(documentRequirementsIndustry({ industry: "Other", subIndustry: "Physiotherapy" }, null), { industry: "Other", subIndustry: "Physiotherapy" });
});
check("J5 replay (Ridgeline clone): correction → the seller returns → the manufacturing rows stay gone", async () => {
  let n = 0;
  const rows: any[] = [];
  const S = storage as any;
  Object.assign(S, {
    getDocumentRequirementsByDeal: async (did: string) => rows.filter((r) => r.dealId === did).map((r) => ({ ...r })),
    createDocumentRequirement: async (row: any) => { const r = { id: `R${++n}`, notes: null, uploadedFileId: null, ...row }; rows.push(r); return { ...r }; },
    deleteDocumentRequirement: async (rid: string) => { const i = rows.findIndex((r) => r.id === rid); if (i >= 0) rows.splice(i, 1); return true; },
  });
  const deal = { id: "D-ridge", industry: "Manufacturing", subIndustry: "Metal fabrication" };
  const session = { industry: "Manufacturing", subIndustry: "Metal fabrication" }; // the interview's _industryContext
  await ensureDealDocumentRequirements(deal.id, deal, session);
  const names = () => rows.map((r) => r.documentName);
  const manufacturingOnly = requirementsForIndustry("Manufacturing").filter((r) => !requirementsForIndustry(null).some((u) => u.documentName === r.documentName)).map((r) => r.documentName);
  assert.equal(rows.length, requirementsForIndustry("Manufacturing").length);
  // The broker corrects the industry (PATCH → switchIndustryDocumentRequirements).
  deal.industry = "Restaurant / Food Service";
  deal.subIndustry = null as any;
  await switchIndustryDocumentRequirements(deal.id, deal.industry, deal.subIndustry);
  assert.ok(!manufacturingOnly.some((m) => names().includes(m)), "the untouched manufacturing rows are gone");
  const afterCorrection = rows.length;
  assert.equal(afterCorrection, requirementsForIndustry("Restaurant / Food Service").length);
  // The seller returns: session start + a turn, both with the session's stored "Manufacturing".
  await ensureDealDocumentRequirements(deal.id, deal, session);
  await ensureDealDocumentRequirements(deal.id, deal, session);
  assert.equal(rows.length, afterCorrection, "no manufacturing rows re-added (was 22 → 34 in the checker's run)");
  assert.ok(!manufacturingOnly.some((m) => names().includes(m)));
  // The interview's two call sites (session start, every turn) go through the deal-first helper.
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../../server/interview/session-manager.ts", import.meta.url), "utf8");
  assert.equal((src.match(/ensureDealDocumentRequirements\(/g) ?? []).length, 2, "session start + every turn");
  assert.ok(!/ensureIndustryDocumentRequirements\(/.test(src), "never the session's identification first");
  // An "Other" deal still gets what the interview identified.
  const other = { id: "D-other", industry: "Other", subIndustry: null };
  await ensureDealDocumentRequirements(other.id, other, { industry: "Healthcare", subIndustry: "Physiotherapy clinic" });
  assert.equal(rows.filter((r) => r.dealId === "D-other").length, requirementsForIndustry("Healthcare").length);
});

// ── J2: the follow-up email window ──────────────────────────────────────
check("J2 the 1-hour window only covers routings before the seller came back", () => {
  const now = Date.now();
  const notice = [{ type: "seller_followup_questions", createdAt: new Date(now - 10 * 60_000) }];
  assert.equal(shouldEmailFollowUp(notice, now), false, "a burst: one email");
  assert.equal(shouldEmailFollowUp(notice, now, new Date(now - 20 * 60_000)), false, "activity before the email doesn't count");
  assert.equal(shouldEmailFollowUp(notice, now, new Date(now - 5 * 60_000)), true, "they came back after it → a new routing emails again");
  assert.equal(shouldEmailFollowUp(notice, now, null), false);
  assert.equal(shouldEmailFollowUp([{ type: "seller_followup_questions", createdAt: new Date(now - 2 * 3600_000) }], now), true);
});

// ── Opt-out ──────────────────────────────────────────────────────────────
check("opt-out: an opted-out seller member is the audience, muted — never replaced by the invite address", () => {
  const invites: any[] = [{ id: "I1", token: "tok-pat", sellerEmail: "pat@seller.invalid", sellerName: "Pat", status: "accepted", expiresAt: null }];
  const optedOut: any[] = [{ id: "M1", teamType: "seller", role: "owner", email: "pat@seller.invalid", inviteStatus: "accepted", emailNotifications: false }];
  for (const ev of ["cim_ready", "seller_followup_questions"]) {
    const r = sellerPortalRecipients(ev, optedOut, invites);
    assert.deepEqual(r.map((x) => [x.recipientId, x.via, x.muted]), [["M1", "members", true]], ev);
  }
  // Opted in → emailed as before; no member → the invite.
  const optedIn = [{ ...optedOut[0], emailNotifications: true }];
  assert.deepEqual(sellerPortalRecipients("cim_ready", optedIn, invites).map((x) => [x.recipientId, x.muted]), [["M1", undefined]]);
  assert.deepEqual(sellerPortalRecipients("cim_ready", [], invites).map((x) => [x.recipientId, x.via]), [["I1", "seller_invite"]]);
});

// ── J3: whose move after "request changes" ──────────────────────────────
check("J3 the seller asked for changes → the broker's move until it's sent back", () => {
  const t0 = new Date("2026-09-28T10:00:00Z");
  const t1 = new Date("2026-09-28T11:00:00Z");
  const t2 = new Date("2026-09-28T12:00:00Z");
  const content = { id: "D", phase: "phase3_content_creation", cimContent: true, contentApprovedByBroker: true, interviewCompleted: true } as any;
  const step = (lastSent: any, req: any) => {
    const turn = sellerReviewTurn(content, lastSent, req);
    return nextStepText(computeNextStep(content, { hasCimSections: true, sellerReviewSent: turn.sent, sellerChangesRequested: turn.changesRequested }));
  };
  assert.equal(step({ content: t0 }, null), "Waiting on the seller: content approval");
  assert.equal(step({ content: t0 }, t1), "Your move: make the changes the seller asked for, then send it back");
  assert.equal(step({ content: t2 }, t1), "Waiting on the seller: content approval", "sent back after the changes");
  assert.equal(step({}, null), "Your move: send the CIM to the seller for review");
  assert.equal(step({}, t1), "Your move: make the changes the seller asked for, then send it back", "they reviewed it from their progress page");
  const design = { id: "D", phase: "phase4_design_finalization", cimContent: true, cimDesignData: true, designApprovedByBroker: true, contentApprovedByBroker: true, contentApprovedBySeller: true } as any;
  const turn = sellerReviewTurn(design, { content: t0, design: t1 }, t2);
  assert.equal(
    nextStepText(computeNextStep(design, { hasCimSections: true, sectionsAwaitingApproval: 0, sellerReviewSent: turn.sent, sellerChangesRequested: turn.changesRequested })),
    "Your move: make the design changes the seller asked for, then send it back",
  );
  // Nothing under review → no change request state.
  assert.equal(sellerReviewTurn({ contentApprovedByBroker: false }, {}, t1).changesRequested, false);
});

// ── The CIM builder's AI gate = the shared rule ─────────────────────────
check("the CIM builder's AI gate blocks a critical routed after the interview (server = useAiGate)", () => {
  const rows = [
    { severity: "critical", status: "ask_seller" },
    { severity: "significant", status: "open" },
    { severity: "critical", status: "resolved" },
  ];
  const finished = rows.filter((d) => discrepancyBlocksCim(d, true));
  assert.match(discrepancyBlockMessage(finished) ?? "", /Waiting on the seller to answer 1 critical question/);
  assert.equal(discrepancyBlockMessage(rows.filter((d) => discrepancyBlocksCim(d, false))), null, "while the interview runs, the interview raises it");
  assert.match(discrepancyBlockMessage([{ status: "open" }, { status: "ask_seller" }]) ?? "", /2 critical discrepancies must be resolved/);
});

(async () => {
  for (const [name, fn] of pending) {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  }
  console.log(`f2-journeys r2: ${passed} passed`);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
