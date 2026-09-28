/**
 * Pure rules behind the buyer-flow fixes (F2–F11) — no database, no email.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/unit/f-buyers-units.test.ts
 */
import assert from "node:assert/strict";
import { viewLinkProblem, isLinkableBuyerAccount, dashboardShowsLinkedDeals, viewStampFor } from "../../server/buyers/view-access";
import { buyerNdaTemplateFor, renderBuyerNdaTerms, validSignerName, STANDARD_BUYER_NDA_TERMS } from "../../shared/buyer-nda";
import { buildApprovalInviteEmail } from "../../server/buyers/approval-emails";
import { answerNoticeDue, buildAnswerNoticeEmail } from "../../server/qa/answer-notice";
import { sellerReviewPayload } from "../../server/buyers/seller-review-payload";
import { escapeHtml, buildEmailHtml } from "../../server/notifications/service";
import { outreachReplyTo } from "../../server/buyers/outreach-reply";

const DAY = 86400000;
const now = Date.parse("2026-09-26T12:00:00Z");

// ── F11: link state ─────────────────────────────────────────────────────
assert.equal(viewLinkProblem(undefined, now), "not_found");
assert.equal(viewLinkProblem({ revokedAt: new Date(now), expiresAt: null } as any, now), "revoked");
assert.equal(viewLinkProblem({ revokedAt: null, expiresAt: new Date(now - 1) } as any, now), "expired");
assert.equal(viewLinkProblem({ revokedAt: null, expiresAt: new Date(now + DAY) } as any, now), null);
assert.equal(viewLinkProblem({ revokedAt: null, expiresAt: null } as any, now), null);

// ── F4: which accounts may receive a link ───────────────────────────────
assert.equal(isLinkableBuyerAccount({ emailVerified: false, passwordHash: "x" }), false, "self-signup, unverified");
assert.equal(isLinkableBuyerAccount({ emailVerified: true, passwordHash: "x" }), true, "verified");
assert.equal(isLinkableBuyerAccount({ emailVerified: false, passwordHash: null }), true, "unclaimed (no password)");
assert.equal(isLinkableBuyerAccount(undefined), false);
assert.equal(dashboardShowsLinkedDeals({ emailVerified: false }), false);
assert.equal(dashboardShowsLinkedDeals({ emailVerified: true }), true);

// ── F6: what counts as a view ───────────────────────────────────────────
const t = new Date(now);
const fresh = { firstViewedAt: null, lastAccessedAt: null, viewCount: 0 } as any;
assert.deepEqual(viewStampFor(fresh, false, t), { lastAccessedAt: t }, "gate / preparing: no view");
assert.deepEqual(viewStampFor(fresh, true, t), { lastAccessedAt: t, viewCount: 1, firstViewedAt: t });
// Straight after the gate (same session): the first served fetch still counts.
const afterGate = { firstViewedAt: null, lastAccessedAt: new Date(now - 60_000), viewCount: 0 } as any;
assert.equal(viewStampFor(afterGate, true, t).viewCount, 1);
// Same session afterwards: not another view; a new session is.
const seen = { firstViewedAt: new Date(now - DAY), lastAccessedAt: new Date(now - 60_000), viewCount: 3 } as any;
assert.equal(viewStampFor(seen, true, t).viewCount, undefined);
assert.equal(viewStampFor({ ...seen, lastAccessedAt: new Date(now - 2 * 3600_000) }, true, t).viewCount, 4);
assert.equal(viewStampFor(seen, true, t).firstViewedAt, undefined, "firstViewedAt never moves");

// ── F10: terms, placeholders, signatures ────────────────────────────────
assert.equal(buyerNdaTemplateFor(null, "D1").source, "standard");
assert.equal(buyerNdaTemplateFor({ buyerNdaTerms: "   " }, "D1").source, "standard", "blank = standard");
assert.equal(buyerNdaTemplateFor({ buyerNdaTerms: "Ours" }, "D1").template, "Ours");
assert.equal(buyerNdaTemplateFor({ buyerNdaTerms: "Ours", buyerNdaDealTerms: { D1: "This deal" } }, "D1").source, "deal");
assert.equal(buyerNdaTemplateFor({ buyerNdaTerms: "Ours", buyerNdaDealTerms: { D2: "Other" } }, "D1").template, "Ours");
const rendered = renderBuyerNdaTerms(STANDARD_BUYER_NDA_TERMS, { firm: "Brassline Advisory", opportunity: "Project Lighthouse" });
assert.ok(rendered.includes("Brassline Advisory (the \"Broker\")") && rendered.includes("Project Lighthouse (the \"Business\")"));
assert.ok(!/\{firm\}|\{opportunity\}/.test(rendered));
for (const clause of ["No contact", "Non-solicitation", "Return or destruction", "governed by the laws"]) {
  assert.ok(rendered.includes(clause), `standard NDA covers ${clause}`);
}
assert.ok(renderBuyerNdaTerms("{firm} / {opportunity}", {}).startsWith("the broker who shared this opportunity with you / the business described"), "neutral fallbacks");
assert.equal(validSignerName("  Jordan   Lee "), "Jordan Lee");
assert.equal(validSignerName("李雷"), "李雷", "non-Latin names are names");
for (const bad of ["", " ", "J", "12345", "a@b.co", "..", null, 42]) assert.equal(validSignerName(bad), null, String(bad));

// ── F2 / F8: approval emails ────────────────────────────────────────────
const views = "https://app.test/view/tok-1";
for (const variant of ["set_password", "existing_account", "link_only"] as const) {
  const blind = buildApprovalInviteEmail({ variant, buyerName: "Casey", dealLabel: { blind: true, name: "Project Lighthouse" }, viewUrl: views, dashboardUrl: "https://app.test/buyer/dashboard" });
  assert.ok((blind.subject + blind.html).includes("Project Lighthouse"), variant);
  assert.ok(blind.html.includes(views), `${variant}: carries the view link`);
  assert.ok(!/memorandum for <strong>Project/i.test(blind.html), `${variant}: a blind buyer reads a "business profile"`);
  const neutral = buildApprovalInviteEmail({ variant, buyerName: null, dealLabel: { blind: true, name: null }, viewUrl: views, dashboardUrl: "x" });
  assert.ok(/confidential/i.test(neutral.subject) && neutral.html.includes("Hello,"), `${variant}: neutral`);
  const named = buildApprovalInviteEmail({ variant, buyerName: "<b>Casey</b>", dealLabel: { blind: false, name: "Harbour & Co" }, viewUrl: views, dashboardUrl: "x" });
  assert.ok(named.html.includes("Harbour &amp; Co") && named.html.includes("&lt;b&gt;Casey"), `${variant}: escaped`);
}

// ── F9: answer notices ──────────────────────────────────────────────────
assert.equal(answerNoticeDue({ status: "pending_broker", buyerAccessId: "A" } as any, { status: "published", publishedAnswer: "x" } as any), true);
assert.equal(answerNoticeDue({ status: "published", buyerAccessId: "A" } as any, { status: "published", publishedAnswer: "y" } as any), false, "only once");
assert.equal(answerNoticeDue({ status: "pending_broker", buyerAccessId: null } as any, { status: "published", publishedAnswer: "x" } as any), false, "no asker");
assert.equal(answerNoticeDue({ status: "pending_broker", buyerAccessId: "A" } as any, { status: "declined" } as any), false);
const notice = buildAnswerNoticeEmail({ businessName: "Harbour Point Dental", blindCodename: "Project Lighthouse" }, { accessLevel: "teaser", buyerName: "Sam Rivera" } as any, "Is <script> the lease long?", views);
assert.ok(!/Harbour Point/.test(notice.subject + notice.html));
assert.ok(notice.html.includes("&lt;script&gt;") && notice.html.includes("Hi Sam,"));
const ddNotice = buildAnswerNoticeEmail({ businessName: "Harbour Point Dental", blindCodename: "Project Lighthouse" }, { accessLevel: "due_diligence", buyerName: null } as any, "q", views);
assert.ok(ddNotice.subject.includes("Harbour Point Dental"), "named-CIM buyers see the name");

// ── F3: seller review payload ───────────────────────────────────────────
const payload = sellerReviewPayload({
  id: "R", dealId: "D", buyerName: "Casey", buyerEmail: "c@x.invalid", category: "search_fund", riskLevel: "low", status: "pending_seller_review",
  crmRawData: { notes: ["private"] }, crmRecordId: "9", crmSource: "pipedrive", brokerReviewNotes: "n", sellerReviewToken: "tok", ndaNotes: "nn",
  submittedBy: "m1", brokerReviewedBy: "m2", partners: [{ name: "P", role: "CFO", secret: "s" }, { role: "no name" }],
  financialCapability: { liquidFunds: "$1M", hasProofOfFunds: true, internal: "z" },
} as any);
const pt = JSON.stringify(payload);
for (const k of ["crmRawData", "crmRecordId", "crmSource", "brokerReviewNotes", "sellerReviewToken", "ndaNotes", "submittedBy\"", "brokerReviewedBy", "dealId", "secret", "internal", "private"]) {
  assert.ok(!pt.includes(k), `seller payload excludes ${k}`);
}
assert.equal(payload.partners.length, 1);
assert.equal(payload.financialCapability?.liquidFunds, "$1M");

// ── F7: email escaping ──────────────────────────────────────────────────
assert.equal(escapeHtml(`<a href="x">'&`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;");
const html = buildEmailHtml({ title: `<a href="https://evil">x</a>`, body: "ok", businessName: "<i>n</i>" });
assert.ok(!html.includes(`<a href="https://evil"`) && !html.includes("<i>n</i>"));

// ── F5: reply-to ────────────────────────────────────────────────────────
assert.equal(outreachReplyTo({ email: " morgan@firm.invalid " }), "morgan@firm.invalid");
for (const bad of [null, undefined, {}, { email: "" }, { email: "not-an-email" }]) assert.equal(outreachReplyTo(bad as any), null);

console.log("f-buyers units: all assertions passed");
