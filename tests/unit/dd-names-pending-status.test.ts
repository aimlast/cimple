/**
 * Release fix F9 (ux-journeys, Pacific copy): the CIM tab said Due diligence
 * "Not made yet" while a due-diligence buyer was already reading the DD
 * version (Full CIM + figure checks + data room) — only the names pass hadn't
 * run. Now: "Ready · names not revealed yet" (amber), what's missing in words
 * on the Versions card, and the same note under Due diligence wherever the
 * broker gives access. Server-rendered, no browser, no DB, no AI.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/dd-names-pending-status.test.ts
 */
import "./react-global";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LevelRadio, LEVEL_TERMS } from "../../client/src/components/deal/buyers/LevelRadio";
import { builderKey } from "../../client/src/components/cim-builder/api";
import { DD_NAMES_PENDING_GRANT, DD_NAMES_PENDING_NOTE, DD_STATUS_NAMES_PENDING } from "../../shared/figure-copy";
import { BLIND_ACCESS_LEVEL, DD_ACCESS_LEVEL, NAMED_ACCESS_LEVEL } from "../../shared/access-levels";

const options = [BLIND_ACCESS_LEVEL, NAMED_ACCESS_LEVEL, DD_ACCESS_LEVEL].map((l) => ({ level: l as any, line: LEVEL_TERMS[l as keyof typeof LEVEL_TERMS] }));
const esc = (t: string) => t.replace(/'/g, "&#x27;");
function render(builder: unknown, dealId: string | null = "d1"): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  if (builder) qc.setQueryData(builderKey("d1"), builder);
  return renderToStaticMarkup(
    React.createElement(QueryClientProvider, { client: qc },
      React.createElement(LevelRadio, { name: "What should they get", options, value: BLIND_ACCESS_LEVEL as any, onChange: () => {}, dealId: dealId ?? undefined })),
  );
}

// 1. The give-access choice says it in words before the names pass.
const pending = render({ sections: [{ id: "s1" }], dd: { generated: false }, blind: { generated: true } });
assert.ok(pending.includes(esc(DD_NAMES_PENDING_GRANT)), "the DD option says names aren't revealed yet");
assert.equal((pending.match(/level-dd-names-pending/g) ?? []).length, 1, "only under Due diligence");
// 2. After the names pass — nothing extra.
assert.ok(!render({ sections: [{ id: "s1" }], dd: { generated: true }, blind: { generated: true } }).includes(esc(DD_NAMES_PENDING_GRANT)));
// 3. No CIM yet, no deal, or nothing loaded — nothing extra (never a guess).
assert.ok(!render({ sections: [], dd: { generated: false } }).includes(esc(DD_NAMES_PENDING_GRANT)));
assert.ok(!render(null).includes(esc(DD_NAMES_PENDING_GRANT)));
assert.ok(!render({ sections: [{ id: "s1" }], dd: { generated: false } }, null).includes(esc(DD_NAMES_PENDING_GRANT)));

// 4. The CIM tab: the DD tile and the Versions card never say "Not made yet" / "Not generated" for DD.
const tab = readFileSync(new URL("../../client/src/pages/broker/deal/CimTab.tsx", import.meta.url), "utf8");
const ddWord = tab.slice(tab.indexOf("const ddStatusWord"), tab.indexOf("\n", tab.indexOf("const ddStatusWord")));
assert.ok(ddWord.includes("DD_STATUS_NAMES_PENDING") && !ddWord.includes("Not made yet"), ddWord);
assert.ok(tab.includes("DD_NAMES_PENDING_NOTE"), "the Versions card says what's missing");
assert.ok(!/dd\.generated\s*\n?\s*\?\s*<span className="text-muted-foreground">Not generated<\/span>/.test(tab));
// 5. Every give-access dialog passes the deal so the note can show.
for (const f of ["../../client/src/pages/broker/deal/BuyersTab.tsx", "../../client/src/components/deal/BuyerApprovalsPanel.tsx", "../../client/src/components/deal/buyers/HaveTeaserStage.tsx"]) {
  const src = readFileSync(new URL(f, import.meta.url), "utf8");
  const radios = src.match(/<LevelRadio[\s\S]*?\/>/g) ?? [];
  assert.ok(radios.length > 0 && radios.every((r) => r.includes("dealId={dealId}")), `${f}: every LevelRadio gets dealId`);
}
assert.match(DD_STATUS_NAMES_PENDING, /^Ready/);
assert.match(DD_NAMES_PENDING_NOTE, /already get the Full CIM, the figure checks and the data room/);
console.log("dd-names-pending-status: ok");
