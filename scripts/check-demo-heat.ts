/**
 * Read-only acceptance check for the heat map (heat-map spec §7.3 — the
 * release gate of §8): builds exactly what the Engagement tab's
 * "Where they read" GET builds for a deal (loadDealReadingFacts +
 * buildDocumentResponse, default filters) — no writes, no sign-in — prints
 * every page (label, title, how it is coloured, reading time, readers,
 * recorded) and decides pass/fail (server/engagement/heat-acceptance.ts).
 *
 * Exit 0 on pass, 1 with the failing lines. No AI, no email; never prints
 * connection strings, tokens or buyer emails.
 *
 *   ANTHROPIC_API_KEY=disabled DATABASE_URL=… npx tsx scripts/check-demo-heat.ts --deal <id> [--expect pacific|beacon] [--preview]
 *
 * --preview: the deal was seeded with --qa-copy-preview (no sample tag), so
 * the "marked as sample" checks are skipped.
 */
import { DEFAULT_ENGAGEMENT_FILTERS } from "@shared/analytics-v2";
import { storage } from "../server/storage";
import { loadDealReadingFacts } from "../server/engagement/facts";
import { buildDocumentResponse } from "../server/engagement/responses";
import { heatAcceptance, heatTable, type HeatExpect } from "../server/engagement/heat-acceptance";

async function main() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (key !== "disabled" && key !== "unused") throw new Error("Run this with ANTHROPIC_API_KEY=disabled (it never calls the AI).");
  const a = process.argv.slice(2);
  const val = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const dealId = val("--deal");
  const expect = val("--expect") as HeatExpect | undefined;
  if (!dealId) throw new Error("usage: check-demo-heat.ts --deal <id> [--expect pacific|beacon] [--preview]");
  if (expect && expect !== "pacific" && expect !== "beacon") throw new Error("--expect is pacific or beacon");
  const deal = await storage.getDeal(dealId);
  if (!deal) throw new Error("no such deal");
  const doc = buildDocumentResponse(await loadDealReadingFacts(deal, DEFAULT_ENGAGEMENT_FILTERS));
  console.log(`check-demo-heat — ${deal.businessName} (${deal.id.slice(0, 8)}…) — read only`);
  console.log(`Version drawn: ${doc.rendition?.label ?? "none"}`);
  for (const line of heatTable(doc)) console.log(`  ${line}`);
  const res = heatAcceptance(doc, expect ?? null, { preview: a.includes("--preview") });
  for (const line of res.lines) console.log(line);
  console.log(res.pass ? "PASS" : "FAIL");
  return res.pass;
}

main().then((ok) => process.exit(ok ? 0 : 1)).catch((err) => {
  console.error(String(err?.message ?? err).replace(/postgres(ql)?:\/\/[^\s"']+/g, "<DATABASE_URL>"));
  process.exit(1);
});
