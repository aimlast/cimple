/**
 * Release review UX-F10: the Analytics heads-up read "6 buyer links run out
 * in the next 7 days: Natalie Vasconcelos, Natalie Vasconcelos and 4 more" —
 * one name per access row. Now one name per buyer: the same person's links
 * on several deals are grouped ("(2 deals)"), and two people who share a name
 * are told apart by the deal. Pure (no DB, no AI).
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/analytics-headsup-names.test.ts
 */
import assert from "node:assert/strict";
import { buyerNameList } from "../../server/analytics-dashboard/kpis";

const row = (name: string, email: string, dealId: string, businessName: string) => ({ b: { name, email } as any, item: { deal: { id: dealId, businessName } } as any });
const names = buyerNameList([
  row("Natalie Vasconcelos", "natalie@x.invalid", "pac", "Pacific Coast Logistics"),
  row("Natalie Vasconcelos", "Natalie@X.invalid", "bea", "Beacon Specialty Pharmacy"),
  row("Sam Lee", "sam.lee@a.invalid", "pac", "Pacific Coast Logistics"),
  row("Sam Lee", "slee@b.invalid", "bea", "Beacon Specialty Pharmacy"),
  row("Travis Holmgren", "travis@x.invalid", "pac", "Pacific Coast Logistics"),
  row("Travis Holmgren", "travis@x.invalid", "pac", "Pacific Coast Logistics"),
]);
assert.deepEqual(names, [
  "Natalie Vasconcelos (2 deals)",
  "Sam Lee (Pacific Coast Logistics)",
  "Sam Lee (Beacon Specialty Pharmacy)",
  "Travis Holmgren",
]);
assert.equal(new Set(names).size, names.length, "never the same words twice");
const src = (await import("node:fs")).readFileSync(new URL("../../server/analytics-dashboard/kpis.ts", import.meta.url), "utf8");
assert.ok(src.includes("const names = buyerNameList(sets.expiring);") && src.includes("names: buyerNameList(sets.not_opened)"), "both heads-up lines use it");
console.log("analytics-headsup-names: ok");
