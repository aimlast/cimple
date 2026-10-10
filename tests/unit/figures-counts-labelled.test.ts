/**
 * Release fixes on the DD counts:
 *  ux-journeys F1 — the CIM tab's Versions card ("2 differences") and
 *    Numbers & sources ("Differences 4") counted different things with no
 *    label: the buyers' check page vs every check (a year to fix first is kept
 *    off the page). Each count now says which it is.
 *  security-integration F2 — the "Documents cited" KPI's "N shared" line was
 *    a hard-coded null: it now counts the cited documents shared with
 *    due-diligence buyers in the data room (null only with no room).
 * No AI, no DB (demo fixtures; an in-memory data room).
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/figures-counts-labelled.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fixtureRaw, run, test } from "./helpers/figure-test";
import { buildWorkspace } from "../../server/cim/figures/workspace";
import { ddSharedDocumentIds } from "../../server/vdr/dd-adapter";
import { fakeVdrStore } from "./vdr-fake-store";
import { DD_ON_CHECK_PAGE, ddDifferencesKpiSub, ddOffPageWords } from "../../shared/figure-copy";

async function ws(shared?: ReadonlySet<string> | null) {
  const { fx, raw } = await fixtureRaw("pacific", { notes: [] });
  return buildWorkspace({
    raw, sections: fx.sections, build: null, autoAsk: false, autoAskChosen: false, stale: false, ddBuyers: 1, dailyLimit: false, oldDdWording: false,
    ...(shared !== undefined ? { ddSharedDocumentIds: shared } : {}),
  });
}

test("F1: the KPI says how many differences are on the buyers' page and how many are kept off", () => {
  assert.equal(ddDifferencesKpiSub({ all: 4, explained: 4, onPage: 2 }), "2 on the buyers' page · 2 kept off until fixed or checked");
  assert.equal(ddDifferencesKpiSub({ all: 4, explained: 4, onPage: 4 }), "all explained");
  assert.equal(ddDifferencesKpiSub({ all: 4, explained: 3, onPage: null }), "3 explained", "no served info: the old sub-line");
  assert.equal(ddDifferencesKpiSub({ all: 0, explained: 0, onPage: 0 }), "none found");
  assert.equal(ddOffPageWords(2), "2 more kept off it until fixed or checked");
  const lines = readFileSync(new URL("../../client/src/pages/broker/deal/figures/CimTabLines.tsx", import.meta.url), "utf8");
  assert.ok(lines.includes("DD_ON_CHECK_PAGE") && lines.includes("ddOffPageWords(offPage)"), "the Versions card labels its count and links the rest");
  const nw = readFileSync(new URL("../../client/src/pages/broker/deal/figures/NumbersWorkspace.tsx", import.meta.url), "utf8");
  assert.ok(nw.includes("ddDifferencesKpiSub("), "the KPI uses the labelled sub-line");
  assert.equal(DD_ON_CHECK_PAGE, "On the buyers' check page");
});

test("F2: documentsShared counts the cited documents shared with due-diligence buyers; null with no room", async () => {
  const none = await ws();
  assert.equal(none.kpis.documentsShared, null, "no data room information → no line");
  const cited = Array.from(new Set(none.checks.flatMap((c) => [c.baseDocument?.id, c.otherDocument?.id]).filter((x): x is string => !!x)));
  assert.ok(cited.length >= 2, cited.join(","));
  assert.equal((await ws(new Set([cited[0], "not-cited-doc"]))).kpis.documentsShared, 1);
  assert.equal((await ws(new Set())).kpis.documentsShared, 0);
});

test("F2: ddSharedDocumentIds — the room's level shares for Due diligence; never a removed item or another level", async () => {
  const f = fakeVdrStore({ documents: [] });
  assert.equal(await ddSharedDocumentIds("D", f.store), null, "no room");
  await f.store.ensureRoom({ dealId: "D" } as any);
  f.items.push(
    { id: "i1", dealId: "D", documentId: "t2", removedAt: null },
    { id: "i2", dealId: "D", documentId: "fs", removedAt: null },
    { id: "i3", dealId: "D", documentId: "lease", removedAt: new Date() },
    { id: "i4", dealId: "D", documentId: "minutes", removedAt: null },
  );
  await f.store.insertShares([
    { dealId: "D", itemId: "i1", audience: "level", accessLevel: "due_diligence", buyerEmail: null, effect: "allow", createdBy: "t" },
    { dealId: "D", itemId: "i2", audience: "level", accessLevel: "named", buyerEmail: null, effect: "allow", createdBy: "t" },
    { dealId: "D", itemId: "i3", audience: "level", accessLevel: "due_diligence", buyerEmail: null, effect: "allow", createdBy: "t" },
    { dealId: "D", itemId: "i4", audience: "buyer", accessLevel: null, buyerEmail: "a@b.invalid", effect: "allow", createdBy: "t" },
  ] as any);
  assert.deepEqual(Array.from((await ddSharedDocumentIds("D", f.store))!).sort(), ["t2"]);
  const route = readFileSync(new URL("../../server/routes/figures.ts", import.meta.url), "utf8");
  assert.ok(route.includes("ddSharedDocumentIds: ddShared"), "the workspace route passes the room's shares");
});

await run("figures-counts-labelled");
