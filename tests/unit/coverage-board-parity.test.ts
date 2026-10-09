/**
 * Every surface agrees (specs/together.md §11.1 parity) — three trimmed
 * fictional demo deals (tests/together/fixtures/deal-*.json, from the QA OCT
 * copies), offline, no database, no AI:
 *  - the board's quality === computeDealReadiness (the Overview's "Solid 84")
 *    for the broker, and === the seller progress page's readiness for the seller;
 *  - sellerCoverageFacts is exactly the coverage view the interview reads
 *    (assembleKnowledgeBase's recorded coverage, built from it, is identical);
 *  - ids are unique and every key is counted once; the headline numbers;
 *  - the seller board differs from the broker board only where a value
 *    comes from a broker-only source;
 *  - the "Seller can see this screen" payload AND its rendered markup hold no
 *    value or source the seller-safe facts don't hold; money talk shows no value.
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/coverage-board-parity.test.ts
 */
import "./react-global";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import React from "react";
import { fileURLToPath } from "url";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { db } from "../../server/db";
import { computeDealReadiness } from "../../server/cim/generation-gate";
import { boardFromCoverage, coverageInputsFrom, coverageValueText } from "../../server/interview/coverage-board";
import { assembleKnowledgeBase, buildSectionCoverage, sellerCoverageFacts } from "../../server/interview/knowledge-base";
import { brokerFactsView } from "../../server/information/facts";
import { getSectionImportance } from "../../server/interview/section-importance";
import { getInterviewOutline } from "../../server/interview/outline";
import { coverageAdjustmentsForDeal } from "../../server/interview/interview-plan";
import { contextSessions } from "../../server/interview/session-mode";
import { computeCimReadiness } from "../../shared/cim-readiness";
import { getFieldSources } from "../../server/interview/info-merger";
import { BoardList } from "../../client/src/components/coverage/CoverageBoardView";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "together", "fixtures");
const load = (name: string) => JSON.parse(fs.readFileSync(path.join(FIX, `deal-${name}.json`), "utf8"));

let n = 0;
const ok = (name: string) => { n++; console.log("✓", name); };

function inputsFor(fx: any) {
  return coverageInputsFrom({
    deal: fx.deal,
    documents: fx.documents,
    sessions: fx.sessions,
    openDiscrepancies: fx.discrepancies,
    resolvedDiscrepancies: fx.discrepancies.filter((d: any) => ["resolved", "accepted", "ask_seller"].includes(d.status)),
    marks: [],
    requirements: fx.requirements,
    brokerFacts: (brokerFactsView(fx.deal).extractedInfo as Record<string, unknown>) || {},
  });
}

/** computeDealReadiness reads the deal's latest session from the database — answered here from the fixture. */
function stubLatestSession(fx: any) {
  const latest = [...fx.sessions].sort((a: any, b: any) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime())[0];
  const chain: any = {
    from: () => chain, where: () => chain, orderBy: () => chain, limit: () => chain,
    then: (res: any, rej: any) => Promise.resolve(latest ? [{ extractedInfo: latest.extractedInfo }] : []).then(res, rej),
  };
  (db as any).select = () => chain;
}

const EXPECT: Record<string, { items: number; on_file: number; partial: number; verify: number; missing: number; percent: number; quality: string; criticalOpen: number }> = {
  // Lakeshore: two merge conflicts, a CRM-only lead, two open guard flags on
  // the session's ledger, "Denise would have it", two missing.
  lakeshore: { items: 63, on_file: 55, partial: 1, verify: 5, missing: 2, percent: 87, quality: "Solid", criticalOpen: 4 },
  pacific: { items: 72, on_file: 57, partial: 0, verify: 1, missing: 14, percent: 79, quality: "Solid", criticalOpen: 7 },
  beacon: { items: 70, on_file: 64, partial: 0, verify: 1, missing: 5, percent: 91, quality: "Solid", criticalOpen: 1 },
};

(async () => {
  for (const name of ["lakeshore", "pacific", "beacon"]) {
    const fx = load(name);
    const inputs = inputsFor(fx);
    const broker = boardFromCoverage(inputs, "broker");
    const seller = boardFromCoverage(inputs, "seller");
    const screen = boardFromCoverage(inputs, "screen");

    // Quality === the Overview's readiness.
    stubLatestSession(fx);
    const { readiness } = await computeDealReadiness(fx.deal);
    assert.equal(broker.quality.label, readiness.label, `${name}: broker quality label = computeDealReadiness`);
    assert.equal(broker.quality.score, readiness.score, `${name}: broker quality score = computeDealReadiness`);

    // Quality === the seller progress page's (recorded coverage of the seller-safe KB).
    const sellerSession = contextSessions([...fx.sessions].sort((a: any, b: any) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime()))[0] ?? null;
    const resolved = fx.discrepancies.filter((d: any) => ["resolved", "accepted", "ask_seller"].includes(d.status));
    const kb = assembleKnowledgeBase(fx.deal, fx.documents, [], sellerSession, resolved);
    const progressReadiness = computeCimReadiness(kb.recordedCoverage!);
    assert.equal(seller.quality.label, progressReadiness.label, `${name}: seller quality = the progress page's`);

    // sellerCoverageFacts is the interview's coverage view.
    const view = sellerCoverageFacts(fx.deal, fx.documents, resolved);
    const fromView = buildSectionCoverage(
      view as any,
      (sellerSession?.extractedInfo as any)?._confidenceLevels,
      getSectionImportance(fx.deal),
      getInterviewOutline(fx.deal).excludedSections,
      coverageAdjustmentsForDeal(fx.deal),
    );
    assert.deepEqual(fromView, kb.recordedCoverage, `${name}: sellerCoverageFacts = the interview's coverage view`);

    // §3.4: no fixture source carries FieldSource.confidence, so today's numbers can't move.
    assert.ok(!Object.values(getFieldSources(fx.deal.extractedInfo)).some((s: any) => s.confidence), `${name}: no stored confidence on sources`);

    // Ids unique; every key counted once.
    const ids = broker.sections.flatMap((s) => s.items.map((i) => i.id));
    assert.equal(new Set(ids).size, ids.length, `${name}: unique ids`);
    // (A member key belongs to one item. An alias may also answer a checklist
    // item — "expansion plans" answering an industry growth item — that is
    // reading, not counting the key twice.)
    const seen = new Map<string, string>();
    for (const i of broker.sections.flatMap((s) => s.items)) for (const m of i.members) {
      assert.ok(!seen.has(m.key), `${name}: ${m.key} counted by ${seen.get(m.key)} and ${i.id}`);
      seen.set(m.key, i.id);
    }
    // The three audiences count the same items.
    assert.equal(seller.totals.items, broker.totals.items, `${name}: same items for the seller`);
    assert.deepEqual(screen.totals, broker.totals, `${name}: the screen keeps the broker's statuses`);

    // The seller board differs only where the broker's value comes from a broker-only source.
    const brokerOnlyDocs = new Set(fx.documents.filter((d: any) => d.visibility === "broker_only").map((d: any) => d.id));
    const brokerSources = getFieldSources(inputs.brokerFacts);
    const sellerById = new Map(seller.sections.flatMap((s) => s.items).map((i) => [i.id, i]));
    for (const it of broker.sections.flatMap((s) => s.items)) {
      const sIt = sellerById.get(it.id)!;
      if (sIt.status === it.status) continue;
      const src = it.valueKey ? brokerSources[it.valueKey] : undefined;
      // (Broker-only rows, CRM leads, a private-side conflict, and the broker's
      // own listed price — the seller's interview asks their own expectation.)
      const viaPrivate =
        (!!src && (src.brokerOnly || brokerOnlyDocs.has(String(src.documentId)) || src.source === "crm")) ||
        it.reason?.code === "conflict" ||
        (it.valueKey === "askingPrice" && src?.source === "broker");
      assert.ok(viaPrivate, `${name}: ${it.id} differs for the seller (${it.status} vs ${sIt.status}) without a broker-only source`);
    }

    // Screen parity: payload + markup hold nothing the seller-safe facts don't.
    const sellerText = JSON.stringify(view);
    for (const it of screen.sections.flatMap((s) => s.items)) {
      if (it.value) {
        const sellerValue = it.valueKey ? coverageValueText((view as Record<string, unknown>)[it.valueKey]) : null;
        assert.ok(sellerValue && sellerValue.startsWith(it.value.replace(/…$/, "")), `${name}: screen value of ${it.id} is the seller-safe view's`);
      }
      if (it.moneyTalk) assert.equal(it.value, null, `${name}: money talk shows no value`);
      if (it.source?.documentId) assert.ok(!brokerOnlyDocs.has(it.source.documentId), `${name}: no broker-only source on screen`);
    }
    for (const it of broker.sections.flatMap((s) => s.items)) {
      const src = it.valueKey ? brokerSources[it.valueKey] : undefined;
      const isPrivate = !!src && (src.brokerOnly || brokerOnlyDocs.has(String(src.documentId)));
      if (!isPrivate || !it.valueKey) continue;
      const text = coverageValueText(inputs.brokerFacts[it.valueKey]);
      if (!text || sellerText.includes(text.slice(0, 40))) continue;
      const json = JSON.stringify(screen);
      assert.ok(!json.includes(text.slice(0, 40)), `${name}: the broker-only value of ${it.id} never reaches the screen payload`);
      const qc = new QueryClient();
      const html = renderToStaticMarkup(
        React.createElement(QueryClientProvider, { client: qc },
          React.createElement(BoardList, {
            dealId: fx.deal.id, board: screen, audience: "screen", rowMode: "checklist",
            state: { view: "all", filter: "all", query: "" }, onState: () => {}, checklist: true,
          })),
      );
      assert.ok(!html.includes(text.slice(0, 40)), `${name}: …nor its rendered markup`);
      assert.ok(html.includes("On file — private to you"), `${name}: a private value reads 'On file — private to you'`);
    }

    // The headline numbers (recorded coverage; aliases count — spec §3.2 step 4).
    const e = EXPECT[name];
    if (e) {
      assert.deepEqual(
        { items: broker.totals.items, on_file: broker.totals.on_file, partial: broker.totals.partial, verify: broker.totals.verify, missing: broker.totals.missing, percent: broker.percentCollected, quality: broker.quality.label, criticalOpen: broker.totals.criticalOpen },
        e,
        `${name}: the board's numbers`,
      );
    }
    ok(`${name}: ${broker.percentCollected}% · ${broker.totals.on_file}/${broker.totals.partial}/${broker.totals.verify}/${broker.totals.missing} · quality ${broker.quality.label} ${broker.quality.score} — every surface agrees; screen holds nothing private`);
  }

  // Lakeshore specifics: the CRM-only items are private on the screen.
  {
    const fx = load("lakeshore");
    const screen = boardFromCoverage(inputsFor(fx), "screen");
    const json = JSON.stringify(screen);
    for (const s of ["$395K", "Dave K. - retention plan needed"]) assert.ok(!json.includes(s), `Lakeshore screen never holds "${s}"`);
    const retention = screen.sections.flatMap((s) => s.items).find((i) => /retention plan/i.test(i.label))!;
    assert.equal(retention.privateValue, true);
    const addbacks = screen.sections.flatMap((s) => s.items).find((i) => i.id === "financials:addbacks")!;
    assert.equal(addbacks.moneyTalk, true);
    assert.equal(addbacks.value, null);
    ok("Lakeshore: \"$395K\" and \"Dave K. - retention plan needed\" never reach the screen; add-backs show no value");
  }

  console.log(`\n${n} checks passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
