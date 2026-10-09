/**
 * gl spec §12.1 test 8 (§9.2): what buyers never read of a ledger entry —
 * recomputed at serve time (maskForBuyer).
 */
import assert from "node:assert/strict";
import { test, done } from "./_harness";
import { maskForBuyer, maskLongNumbers, type BuyerMaskContext } from "../../server/gl/sensitive";

const base: BuyerMaskContext = { staffNames: ["Priya Shah", "Daniel Okafor"], heldNames: [], parties: [{ first: "tony", last: "moretti" }], personalAddback: false, showStaffNames: false };

await test("a personal pharmacy bill on a shareholder account is withheld", () => {
  const m = maskForBuyer({ account: "Shareholder expenses", name: "Shoppers Drug Mart", memo: "Prescriptions" }, base);
  assert.equal(m.withheld, "personal");
  assert.equal(m.name, null);
  assert.equal(m.memo, "Personal expense — details withheld");
  assert.equal(m.account, "Shareholder expenses", "the account stays");
});

await test("a pharmacy's (or dental practice's) own supply account is not withheld", () => {
  assert.equal(maskForBuyer({ account: "Cost of goods sold:Pharmacy inventory", name: "McKesson Canada", memo: "Prescription stock" }, base).withheld, undefined);
  assert.equal(maskForBuyer({ account: "Dental supplies", name: "Henry Schein", memo: "Clinic consumables" }, base).withheld, undefined);
});

await test("a family cost inside a personal add-back is withheld even on a neutral account", () => {
  const m = maskForBuyer({ account: "Office expenses", name: "Little Steps Daycare", memo: "Tuition March" }, { ...base, personalAddback: true });
  assert.equal(m.withheld, "personal");
});

await test("an unknown employee's name on a wages account is withheld; the add-back's own party is shown", () => {
  const m = maskForBuyer({ account: "Wages & Salaries", name: "Payroll — M. Chen", memo: "Biweekly pay" }, base);
  assert.equal(m.withheld, "staff");
  assert.equal(m.memo, "Employee pay — name withheld");
  assert.equal(maskForBuyer({ account: "Wages - Officers", name: "Payroll — T. Moretti", memo: "Salary" }, base).withheld, undefined);
  assert.equal(maskForBuyer({ account: "Wages - Officers", name: "Payroll — A. Moretti", memo: "Salary" }, base).withheld, "staff", "a different initial is someone else");
  assert.equal(maskForBuyer({ account: "Wages & Salaries", name: "Payroll — M. Chen", memo: "Biweekly pay" }, { ...base, showStaffNames: true }).withheld, undefined, "the broker's switch");
});

await test("a staff member in a private context is withheld anywhere", () => {
  const m = maskForBuyer({ account: "Consulting", name: null, memo: "Retention bonus for Daniel Okafor after he asked for a raise" }, base);
  assert.equal(m.withheld, "staff");
});

await test("held names, keep-out parties and the seller's keep-out terms are withheld", () => {
  const ctx = { ...base, heldNames: ["Harvest Lane", "Karen Holt"] };
  assert.equal(maskForBuyer({ account: "Marketing", name: "Harvest Lane Markets", memo: "RFP samples" }, ctx).withheld, "keep_out");
  const acct = maskForBuyer({ account: "Consulting — Karen Holt", name: "KH Advisory", memo: "Strategy" }, ctx);
  assert.equal(acct.withheld, "keep_out");
  assert.equal(acct.account, "Other account", "a held name in the account goes too");
  assert.equal(maskForBuyer({ account: "Marketing", name: "Fresh Co", memo: "Samples" }, ctx).withheld, undefined);
  assert.equal(maskForBuyer({ account: "Vehicle", name: "Tony Moretti", memo: "Lease" }, { ...ctx, heldNames: ["Tony Moretti"] }).withheld, "keep_out", "held beats being the add-back's party");
});

await test("a health detail in a description is withheld", () => {
  assert.equal(maskForBuyer({ account: "Owner expenses", name: "Clinic", memo: "Chemotherapy for the owner's cancer" }, base).withheld !== undefined, true);
});

await test("the broker's per-entry choice: true shows it, false withholds it", () => {
  const row = { account: "Shareholder expenses", name: "Shoppers Drug Mart", memo: "Prescriptions" };
  assert.equal(maskForBuyer(row, base, true).withheld, undefined);
  assert.equal(maskForBuyer({ account: "Vehicle", name: "Lexus Financial", memo: "Lease" }, base, false).withheld, "keep_out");
});

await test("account and card numbers keep their last 4", () => {
  assert.equal(maskLongNumbers("Visa 4520 1234 5678 9012 payment"), "Visa ••••9012 payment");
  assert.equal(maskLongNumbers("Invoice 2024-118"), "Invoice 2024-118");
  const m = maskForBuyer({ account: "Bank charges", name: "RBC", memo: "Acct 00123456789" }, base);
  assert.equal(m.memo, "Acct ••••6789");
});

done("sensitive");
