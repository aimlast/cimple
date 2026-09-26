// PRIV-V-1: a private note moved into the facts is credited to its SHARED
// source, so the value written must say nothing that shared wording doesn't.
// Before the fix, recordPlacements used the model's free-text factValue
// whenever it kept the note's figures and names — an added "per Pipedrive,
// owner's wife Karen … cancer treatment …" clause went into the fact and
// reached the seller interview.
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/rv-notes-promotion.test.ts
import assert from "node:assert/strict";
import { recordPlacements, emptyReview, applyNotesReview, promotedValue } from "../../server/documents/private-notes-review";
import { sellerInterviewView } from "../../server/interview/seller-view";

const shared = "Westline Foods sent written notice of non-renewal of its supply agreement effective June 30, 2027";
const leaky = `${shared}; per Pipedrive, owner's wife Karen is negotiating to keep it quiet and her cancer treatment is why they are selling`;
const docs = new Map<string, any>([
  ["d1", { id: "d1", name: "Email from owner", visibility: "shared", sourceKind: "email" }],
  ["d2", { id: "d2", name: "CRM note", visibility: "broker_only", sourceKind: "crm" }],
]);
const items = [{ key: "k1", text: shared, sources: [{ documentId: "d1" } as any], shared: true }];

// 1. The model's value adds a clause from elsewhere: the note's own words are written.
{
  const { review } = recordPlacements(emptyReview(), { notNotes: [{ note: "N1", kind: "business_fact", factKey: "customerNonRenewal", factValue: leaky }] }, items as any, [], docs as any);
  const dec = review.items.k1 as any;
  assert.equal(dec.d, "fact");
  assert.equal(dec.value, shared, "the decision stores the shared wording");
  const applied = applyNotesReview({ _brokerPrivateNotes: [{ note: shared, documentId: "d1", source: "email" }] } as any, review as any, docs as any);
  assert.equal(applied.info.customerNonRenewal, shared);
  const view = sellerInterviewView(applied.info as any, [{ id: "d1", visibility: "shared" }, { id: "d2", visibility: "broker_only" }] as any) as any;
  assert.doesNotMatch(String(view.customerNonRenewal), /Pipedrive|Karen|cancer/);
  console.log("✓ a model value that adds content is replaced by the note's own words");
}

// 2. A decision stored before the check is cleaned when it is applied again (reprocess).
{
  const stored = { ...emptyReview(), items: { k1: { d: "fact", key: "customerNonRenewal", value: leaky, documentId: "d1", kind: "email", text: shared } } };
  const applied = applyNotesReview({ _brokerPrivateNotes: [{ note: shared, documentId: "d1", source: "email" }] } as any, stored as any, docs as any);
  assert.equal(applied.info.customerNonRenewal, shared);
  console.log("✓ a stored leaky decision is cleaned on re-apply");
}

// 3. A faithful rewording (a word dropped, brackets to a comma) is still used.
{
  const note = "Share transfers: 40 Class B shares (held by HoldCo) were transferred to Northgate Holdings in 2021";
  const tidy = "40 Class B shares, held by HoldCo, were transferred to Northgate Holdings in 2021";
  assert.equal(promotedValue("shareStructure", tidy, note), tidy, "a prefix dropped and brackets to commas: the model's wording stays");
  const note2 = "Dividends of $120,000 were declared in FY2023 (paid to HoldCo)";
  assert.equal(promotedValue("dividendsDeclared", "Dividends of $120,000 were declared in FY2023, paid to HoldCo", note2), "Dividends of $120,000 were declared in FY2023, paid to HoldCo");
  assert.equal(promotedValue("dividendsDeclared", "Dividends of $120,000 were declared in FY2023 (paid to HoldCo, per Pipedrive)", note2), note2, "an added source name is refused");
  assert.equal(promotedValue("dividendsDeclared", "Dividends of $120,000 were declared in FY2023 to Karen", note2), note2, "an added name is refused");
  console.log("✓ faithful rewordings stay; additions fall back to the note");
}

// 4. A leaky value an earlier promotion already WROTE into the facts is
//    cleaned on re-apply (it used to stay until a reprocess rebuilt the
//    facts); a value the broker has since written is left alone.
{
  const stored = { ...emptyReview(), items: { k1: { d: "fact", key: "customerNonRenewal", value: leaky, documentId: "d1", kind: "email", text: shared } } };
  const written = {
    _brokerPrivateNotes: [{ note: shared, documentId: "d1", source: "email" }],
    customerNonRenewal: leaky,
    _fieldSources: { customerNonRenewal: { source: "email", documentId: "d1", brokerOnly: false, note: "Moved from the private notes", at: "2026-09-20T00:00:00Z" } },
  };
  const applied = applyNotesReview(written as any, stored as any, docs as any);
  assert.equal(applied.info.customerNonRenewal, shared, "the written leaky value is replaced by the shared wording");
  const src = (applied.info._fieldSources as any).customerNonRenewal;
  assert.equal(src.documentId, "d1");
  assert.equal(src.brokerOnly, false);
  assert.equal((written._fieldSources as any).customerNonRenewal.at, "2026-09-20T00:00:00Z", "the input is not mutated");
  const brokerSaid = { ...written, _fieldSources: { customerNonRenewal: { source: "broker", at: "2026-09-21T00:00:00Z" } } };
  assert.equal(applyNotesReview(brokerSaid as any, stored as any, docs as any).info.customerNonRenewal, leaky, "the broker's own value is theirs");
  console.log("✓ a leaky value already written by an earlier promotion is cleaned on re-apply");
}

console.log("rv-notes-promotion: all passed");
