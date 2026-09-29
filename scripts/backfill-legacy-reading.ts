/**
 * Legacy reading backfill (optional: the Engagement tab already shows this
 * reading on the fly, read-only — server/engagement/legacy.ts; storing it
 * makes it permanent): turns the OLD tracker's section-exit events
 * (analytics_events.event_type = 'section_exit', before reading analytics v2)
 * into page-level reading on synthetic legacy visits, so a deal's older
 * buyers still show in the Engagement tab ("Page-level only — recorded
 * before detailed reading tracking"). Offline, no AI, idempotent (visit and
 * row ids are derived from the events; a visit already stored is never
 * written again, so re-runs change nothing — even after a regeneration).
 *
 * What is stored (server/engagement/legacy-store.ts): every exit (a visit's
 * time is the buyer's), each page row under its OLD section key with the
 * lineage of the section it is on now — so the reading survives any later
 * regeneration (release review DEP-1). A regeneration stores it by itself
 * just before it replaces the sections; running this first is the same
 * thing, earlier. After it, the Document view draws the reading on the CIM
 * as it is served now, as before (DEP-2: it used to show no pages at all).
 *
 * DRY RUN by default: prints each old key and the page it lands on.
 * --apply writes. Deals outside the qa_cimgen account also need --allow-real
 * (the founder's go-ahead: never on broker_demo without it).
 *
 *   ANTHROPIC_API_KEY=disabled DATABASE_URL=… npx tsx scripts/backfill-legacy-reading.ts --deal <id> [--apply] [--allow-real]
 */
import { storage } from "../server/storage";
import { planLegacyReading, storeLegacyReading } from "../server/engagement/legacy-store";

export { legacySessions, stableUuid, type LegacySession } from "../server/engagement/legacy";

async function main() {
  const args = process.argv.slice(2);
  const dealId = (() => { const i = args.indexOf("--deal"); return i >= 0 ? args[i + 1] : undefined; })();
  const apply = args.includes("--apply");
  const allowReal = args.includes("--allow-real");
  if (!dealId) throw new Error("usage: --deal <id> [--apply] [--allow-real]");
  const deal = await storage.getDeal(dealId);
  if (!deal) throw new Error("no such deal");
  const broker = deal.brokerId ? await storage.getUser(deal.brokerId) : undefined;
  if (apply && broker?.username !== "qa_cimgen" && !allowReal) {
    throw new Error(`refusing to write to "${deal.businessName}" (not a qa_cimgen deal) without --allow-real`);
  }
  const plan = apply ? await storeLegacyReading(deal.id) : await planLegacyReading(deal.id);
  const unplaced = plan.keys.filter((k) => !k.placedOn);
  console.log(JSON.stringify({
    deal: deal.businessName, apply, exits: plan.exits, sessions: plan.sessions, buyers: plan.buyers,
    pageRows: plan.rollups.length,
    placedExits: plan.keys.reduce((s, k) => s + (k.placedOn ? k.exits : 0), 0),
    // Pages the current CIM no longer has: stored all the same (they count in
    // the visits; a later version may have the page again).
    unplacedKeys: unplaced.map((k) => `${k.key} (${k.exits})`),
    keys: plan.keys.map((k) => `${k.key} (${k.exits}) → ${k.placedOn ? k.placedOn.title ?? k.placedOn.id : "—"}`),
  }, null, 2));
  if (apply) {
    const kept = "alreadyStored" in plan ? Number(plan.alreadyStored) : 0;
    console.log(`stored ${plan.visits.length - kept} legacy visits (${kept} already stored were kept as they are)`);
  }
}

if (process.argv[1] && /backfill-legacy-reading/.test(process.argv[1])) {
  main().then(() => process.exit(0)).catch((err) => { console.error(String(err?.message ?? err)); process.exit(1); });
}
