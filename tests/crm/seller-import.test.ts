// Seller-side CRM import — offline checks (no database, no AI), plus live
// checks against the local fake Pipedrive when it is running.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/crm/seller-import.test.ts
// With the fake:  node scripts/fake-pipedrive.mjs 5103 &
//                 PIPEDRIVE_API_BASE=http://localhost:5103 DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/crm/seller-import.test.ts
import assert from "node:assert/strict";
import { htmlToText, personEmail, personPhone, relId, pdAll, pd, PipedriveError, validatePipedriveToken, pipedriveRecordUrl } from "../../server/crm/pipedrive";
import { describeRecord, pipedriveErrorResponse, mayReplaceSellerContact, searchPipedrive, resolvePipedriveLink, CrmImportError } from "../../server/crm/seller-import";
import { sellerSafeDeal } from "../../server/seller-safe-deal";
import { mergeableExtraction } from "../../server/documents/ingest";
import { buildFactSourceLabels, renderKnowledgeBaseForPrompt, assembleKnowledgeBase } from "../../server/interview/knowledge-base";

let n = 0;
const ok = (name: string) => { n++; console.log("✓", name); };

// ── Pipedrive helpers ──
assert.equal(htmlToText("<p>Lease to <b>Aug 2029</b>&nbsp;&amp; one renewal</p><p>Rent $7,800</p>"), "Lease to Aug 2029 & one renewal\nRent $7,800");
assert.equal(htmlToText("<script>x()</script><ul><li>a</li><li>b</li></ul>"), "• a\n• b");
assert.equal(htmlToText(null), "");
ok("htmlToText");

assert.equal(personEmail({ email: [{ value: "a@x.invalid", primary: false }, { value: "B@X.invalid", primary: true }] }), "b@x.invalid");
assert.equal(personEmail({ emails: ["c@x.invalid"] }), "c@x.invalid");
assert.equal(personEmail({ email: [{ value: "", primary: true }] }), null);
assert.equal(personPhone({ phone: [{ value: " 604 555 ", primary: true }] }), "604 555");
assert.equal(relId({ name: "Org", value: 601 }), "601");
assert.equal(relId(42), "42");
assert.equal(relId(null), null);
ok("person / relation helpers");

assert.equal(pipedriveRecordUrl("acme", "deal", 5), "https://acme.pipedrive.com/deal/5");
assert.equal(pipedriveRecordUrl("evil.com/x", "deal", 5), null);
assert.equal(pipedriveRecordUrl(null, "deal", 5), null);
ok("record urls only from a plain company domain");

// ── Record → text ──
const fields = [
  { key: "title", name: "Title" },
  { key: "abc123", name: "Industry", field_type: "varchar" },
  { key: "def456", name: "Lead source", field_type: "enum", options: [{ id: 11, label: "Referral" }] },
  { key: "rev", name: "Annual revenue", field_type: "monetary" },
  { key: "org_id", name: "Organization" },
];
const lines = describeRecord(
  {
    id: 5, title: "Clinic sale", value: 2_100_000, currency: "CAD", stage_id: 3, owner_name: "Casey", add_time: "2026-01-01 10:00:00",
    abc123: "Physiotherapy", def456: "11", rev: 1400000, rev_currency: "CAD", org_id: { name: "Maple Ridge Physio", value: 601 },
    notes_count: 4, address_locality: "Maple Ridge", update_time: "2026-03-01 00:00:00",
  },
  fields,
);
assert.deepEqual(lines, ["Title: Clinic sale", "Industry: Physiotherapy", "Lead source: Referral", "Annual revenue: 1400000 CAD", "Organization: Maple Ridge Physio"]);
ok("describeRecord: custom fields by name, enum labels, housekeeping (value, owner, counts, times) dropped");

// ── Errors → broker messages ──
assert.equal(pipedriveErrorResponse(new PipedriveError("x", 401, "/v1/deals/1")).status, 400);
assert.match(pipedriveErrorResponse(new PipedriveError("x", 401, "/")).error, /reconnect Pipedrive/);
assert.equal(pipedriveErrorResponse(new PipedriveError("x", 404, "/")).status, 404);
assert.equal(pipedriveErrorResponse(new CrmImportError("busy", 409)).status, 409);
assert.equal(pipedriveErrorResponse(new Error("boom")).status, 500);
ok("Pipedrive errors map to plain broker messages");

// ── Seller contact precedence ──
assert.equal(mayReplaceSellerContact(null), true);
assert.equal(mayReplaceSellerContact({ source: "crm", updatedAt: "" }), true);
assert.equal(mayReplaceSellerContact({ source: "invite", updatedAt: "" }), true);
assert.equal(mayReplaceSellerContact({ source: "broker", updatedAt: "" }), false);
ok("a CRM contact never overwrites the broker's own edit");

// ── Seller never receives broker material ──
const fullDeal: any = {
  id: "d1", businessName: "Biz", industry: "Healthcare", location: "Maple Ridge, BC", questionnaireData: { a: 1 },
  extractedInfo: { annualRevenue: "$1M", _brokerPrivateNotes: [{ note: "health" }] },
  crmLink: { provider: "pipedrive", title: "secret deal", linkedAt: "" }, sellerContact: { name: "Dana", source: "crm", updatedAt: "" },
  sellerProfile: { sellingReason: "health" }, description: "seller desperate", interviewBot: { webhookToken: "t" }, interviewCall: { ownerToken: "o" },
};
const safe = sellerSafeDeal(fullDeal) as Record<string, unknown>;
for (const k of ["extractedInfo", "crmLink", "sellerContact", "sellerProfile", "description", "interviewBot", "interviewCall"]) assert.equal(k in safe, false, k);
assert.equal(safe.businessName, "Biz");
assert.deepEqual(safe.questionnaireData, { a: 1 });
ok("sellerSafeDeal whitelists the seller pages' fields only");

// ── Broker-only sources: per-source notes never become deal facts ──
const extraction: any = { annualRevenue: "$1.4M", summary: "Broker note: seller had a health scare", redFlags: "x", sellerConcerns: "y", keyFacts: "z" };
assert.deepEqual(Object.keys(mergeableExtraction({ visibility: "broker_only" } as any, extraction)), ["annualRevenue"]);
assert.deepEqual(Object.keys(mergeableExtraction({ visibility: "shared" } as any, extraction)), ["annualRevenue"]);
ok("mergeableExtraction strips summary/red flags/concerns from every source");

// ── Interview labels ──
const info = {
  leaseExpiry: "Aug 2029", annualRevenue: "$1.42M",
  _fieldSources: { leaseExpiry: { source: "crm", documentId: "n1" }, annualRevenue: { source: "document", documentId: "f1" } },
};
const docs: any[] = [
  { id: "n1", name: "CRM note — Site visit", createdAt: new Date(), sourceKind: "crm", sourceMeta: null, visibility: "broker_only" },
  { id: "f1", name: "2024 Income Statement.pdf", createdAt: new Date(), sourceKind: "document", sourceMeta: null, visibility: "broker_only" },
];
const labels = buildFactSourceLabels(info, docs);
assert.match(labels.leaseExpiry, /never mention the CRM/);
assert.match(labels.annualRevenue, /never mention or quote the source/);
assert.doesNotMatch(labels.annualRevenue, /2024 Income Statement/);
ok("CRM facts and broker-only files are labelled confirm-never-cite for the interview agent");

const kbDeal: any = {
  id: "d1", brokerId: "b1", businessName: "Biz", industry: "Healthcare", subIndustry: null, location: "Maple Ridge, BC", description: null,
  extractedInfo: {}, questionnaireData: null, operationalSystems: null, employeeChart: null, scrapedData: null, scrapeSource: null,
  sellerProfile: null, sectionImportance: null, interviewOutline: null, interviewPlan: null,
};
const discrepancy: any = {
  id: "x1", dealId: "d1", field: "annualRevenue", interviewValue: "$1.4M", documentValue: "$1.2M", documentId: "n1", documentName: "CRM note — Site visit",
  severity: "significant", category: "financial", status: "ask_seller", aiExplanation: "The CRM note says $1.2M", suggestedResolution: null,
};
const kb = assembleKnowledgeBase(kbDeal, docs as any, [], null, [discrepancy]);
assert.equal(kb.askSellerDiscrepancies?.[0]?.privateSource, true);
assert.equal(kb.documents.length, 0, "broker-only sources are not listed to the agent");
const rendered = renderKnowledgeBaseForPrompt(kb);
assert.match(rendered, /broker's private notes \(CRM\)[^\n]*never mention the CRM/);
ok("a discrepancy from a broker-only source carries the never-mention instruction; broker-only sources aren't listed");

// ── Live: the local fake Pipedrive ──
(async () => {
  if (!process.env.PIPEDRIVE_API_BASE) {
    console.log(`\n${n} checks passed (fake Pipedrive checks skipped — set PIPEDRIVE_API_BASE)`);
    return;
  }
  const T = process.env.FAKE_PIPEDRIVE_TOKEN || "fake-crm-seller-token";
  assert.equal(await validatePipedriveToken(T), true);
  assert.equal(await validatePipedriveToken("nope"), false);
  ok("token validation (good / rejected)");

  const notes = await pdAll(T, "/v1/notes", { deal_id: 501 });
  assert.ok(notes.length >= 3, "paginated notes");
  ok(`pdAll walks every page (fake serves 2 per page → ${notes.length} notes)`);

  await fetch(`${process.env.PIPEDRIVE_API_BASE}/__admin/reset`, { method: "POST" });
  const started = Date.now();
  const hits = await searchPipedrive(T, "maple");
  assert.ok(Date.now() - started >= 900, "retried after the 429");
  assert.deepEqual(hits.map((h) => h.type), ["deal", "organization", "person"]);
  ok("itemSearch retries a 429 and orders deals → organisations → people");

  const linked = await resolvePipedriveLink(T, "deal", "501");
  assert.equal(linked.link.orgId, "601");
  assert.equal(linked.link.personId, "701");
  assert.equal(linked.link.url, "https://qa-fake-brokerage.pipedrive.com/deal/501");
  assert.equal(linked.prefill.industryText, "Physiotherapy clinic");
  assert.equal(linked.prefill.location, "Maple Ridge, BC");
  assert.equal(linked.contact?.email, "dana.whitfield@mapleridge.invalid");
  ok("resolvePipedriveLink: deal → org + person, prefill, seller contact");

  await assert.rejects(pd(T, "/v1/deals/999"), (e: unknown) => e instanceof PipedriveError && e.status === 404);
  ok("missing records surface as PipedriveError 404");

  const log = await (await fetch(`${process.env.PIPEDRIVE_API_BASE}/__admin/log`)).json();
  assert.ok(log.filter((e: any) => e.path.startsWith("/v1/") && e.path !== "/v1/users/me").every((e: any) => e.auth === "header"), "token only in the header");
  ok("the token travels in the x-api-token header, never the URL");

  console.log(`\n${n} checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
