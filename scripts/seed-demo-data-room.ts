/**
 * Demo data rooms for the FICTIONAL demo deals (vdr spec §12, founder
 * question 2; INTEGRATION §3 C21 / §8 Q15). NOT RUN by the vdr stream — it
 * writes to the founder's account, so it runs only with the founder's yes.
 * Dry run first; removable in one command. Database rows only (page images
 * are prepared on the server the first time someone opens a document).
 *
 * For each deal given (each must have `deals.demo_key` set — Amlin,
 * SariKnotSari, 180 Smoke Vape and every other real deal are refused, twice:
 * by demo_key and by name):
 *   1. sets up the room (`set_up_by = 'demo-seed'`) and files every document;
 *   2. applies the recommended plan (folders the preset recommends → due
 *      diligence buyers) and shares every document the DD CIM points to with
 *      due diligence buyers (`created_by = 'demo-seed'`); demo flags are
 *      marked checked (`checked_by = 'demo-seed'`); the basic descriptions
 *      are accepted (no AI);
 *   3. adds data-room reading for demo buyers who can open the room, in
 *      proportion to their CIM reading (`vdr_views.source = 'demo'`,
 *      `vdr_activity.detail.demo = true`) — so Activity isn't empty and the
 *      DD CIM's source links open on the first click;
 *   4. Beacon only: one demo accountant on Northgate's team (`.invalid`
 *      email, `created_by = 'demo-seed'`, acknowledged, NO link and no email).
 *
 *   npx tsx scripts/seed-demo-data-room.ts --deal <id> [--deal <id>…] | --all-demo   (dry run: lists every row)
 *   … --apply        writes them (in one transaction per deal)
 *   … --remove       lists what it would delete; --remove --apply deletes ONLY rows marked
 *                    demo-seed / demo, then the room when nothing else is in it
 *
 * Never sends email; never calls AI (ANTHROPIC_API_KEY is not read).
 */
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  buyerAccess,
  buyerVisits,
  deals,
  vdrActivity,
  vdrFolders,
  vdrItems,
  vdrPageText,
  vdrRequests,
  vdrRooms,
  vdrShares,
  vdrBuyerSettings,
  vdrTeamMembers,
  vdrViews,
  type Deal,
} from "@shared/schema";
import { DD_ACCESS_LEVEL, cimModeForAccessLevel } from "@shared/access-levels";
import { buyerKey, hasRoomAccess, presetFolder, type RoomAccessSetting } from "@shared/vdr";

const SEED = "demo-seed";
const REAL_DEAL_NAMES = /\b(amlin|sari\s*knot\s*sari|sariknotsari|180\s*smoke)\b/i;

type Args = { deals: string[]; allDemo: boolean; apply: boolean; remove: boolean };
function parseArgs(argv: string[]): Args {
  const a: Args = { deals: [], allDemo: false, apply: false, remove: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--deal") a.deals.push(argv[++i]);
    else if (argv[i] === "--all-demo") a.allDemo = true;
    else if (argv[i] === "--apply") a.apply = true;
    else if (argv[i] === "--remove") a.remove = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!a.allDemo && a.deals.length === 0) throw new Error("name a deal (--deal <id>) or --all-demo");
  return a;
}

/** The two locks: a demo_key, and never a real deal's name. */
export function refuseReason(deal: Pick<Deal, "id" | "businessName" | "demoKey"> | null | undefined): string | null {
  if (!deal) return "no such deal";
  if (!deal.demoKey) return `refusing ${deal.id}: not a demo deal (no demo_key)`;
  if (REAL_DEAL_NAMES.test(deal.businessName ?? "")) return `refusing ${deal.id}: "${deal.businessName}" is a real business`;
  return null;
}

/** Deterministic spread of a buyer's data-room minutes over the documents they'd plausibly open (financial first). */
export function demoReadingPlan(
  buyerCimMs: number,
  items: ReadonlyArray<{ id: string; documentId: string | null; title: string; pages: number; financial: boolean }>,
  seed: string,
): Array<{ itemId: string; documentId: string | null; activeMs: number; pageMs: Record<string, number>; maxPage: number }> {
  if (buyerCimMs <= 0 || items.length === 0) return [];
  // Room time ≈ 60 % of their CIM reading, capped at 45 min; 1–5 documents.
  const total = Math.min(45 * 60_000, Math.round(buyerCimMs * 0.6));
  const ordered = items.slice().sort((a, b) => Number(b.financial) - Number(a.financial) || a.title.localeCompare(b.title));
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const n = Math.max(1, Math.min(ordered.length, 1 + (h % 5)));
  const picked = ordered.slice(0, n);
  const weights = picked.map((_, i) => 1 / (i + 1));
  const sum = weights.reduce((x, y) => x + y, 0);
  return picked.map((it, i) => {
    const ms = Math.max(20_000, Math.round((total * weights[i]) / sum));
    const pages = Math.max(1, it.pages);
    const read = Math.max(1, Math.min(pages, 1 + ((h >> (i + 1)) % pages)));
    const pageMs: Record<string, number> = {};
    for (let p = 1; p <= read; p++) pageMs[String(p)] = Math.round(ms / read);
    return { itemId: it.id, documentId: it.documentId, activeMs: ms, pageMs, maxPage: read };
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { db } = await import("../server/db");
  const { dbVdrStore } = await import("../server/vdr/store");
  const { setUpRoom } = await import("../server/vdr/setup");
  const { recommendedPlan, planShareRows } = await import("../server/vdr/auto-file");
  const { flagsFor, isLedgerItemDoc, loadRoom } = await import("../server/vdr/access");
  const { privateMattersByDocument } = await import("../server/vdr/analysis");
  const { citedByFactTracing } = await import("../server/vdr/dd-adapter");
  const { traceFor } = await import("../server/vdr/activity");
  const { basicDescription } = await import("@shared/vdr");

  const targets: Deal[] = args.allDemo
    ? await db.select().from(deals).where(isNotNull(deals.demoKey))
    : (await Promise.all(args.deals.map(async (id) => (await db.select().from(deals).where(eq(deals.id, id)))[0]))).filter(Boolean);
  if (!args.allDemo) for (const id of args.deals) if (!targets.some((d) => d.id === id)) throw new Error(`no such deal: ${id}`);

  for (const deal of targets) {
    const why = refuseReason(deal);
    if (why) { console.log(why); continue; }
    console.log(`\n── ${deal.businessName} (${deal.id}, ${deal.demoKey}) ──`);

    if (args.remove) {
      const room = (await db.select().from(vdrRooms).where(eq(vdrRooms.dealId, deal.id)))[0];
      const views = await db.select({ id: vdrViews.id }).from(vdrViews).where(and(eq(vdrViews.dealId, deal.id), eq(vdrViews.source, "demo")));
      const acts = await db.select({ id: vdrActivity.id }).from(vdrActivity).where(and(eq(vdrActivity.dealId, deal.id), sql`(${vdrActivity.detail}->>'demo') = 'true' OR ${vdrActivity.actorId} = ${SEED}`));
      const shares = await db.select({ id: vdrShares.id }).from(vdrShares).where(and(eq(vdrShares.dealId, deal.id), eq(vdrShares.createdBy, SEED)));
      const team = await db.select({ id: vdrTeamMembers.id }).from(vdrTeamMembers).where(and(eq(vdrTeamMembers.dealId, deal.id), eq(vdrTeamMembers.createdBy, SEED)));
      console.log(`  would remove: ${views.length} demo views, ${acts.length} demo log rows, ${shares.length} demo shares, ${team.length} demo team members${room?.setUpBy === SEED ? ", and the room if nothing else is in it" : ""}`);
      if (!args.apply) { console.log("  (dry run: add --apply to remove them)"); continue; }
      {
        await db.transaction(async (tx) => {
          if (views.length) await tx.delete(vdrViews).where(inArray(vdrViews.id, views.map((v) => v.id)));
          if (acts.length) await tx.delete(vdrActivity).where(inArray(vdrActivity.id, acts.map((v) => v.id)));
          if (shares.length) await tx.delete(vdrShares).where(inArray(vdrShares.id, shares.map((v) => v.id)));
          if (team.length) await tx.delete(vdrTeamMembers).where(inArray(vdrTeamMembers.id, team.map((v) => v.id)));
          await tx.update(vdrItems).set({ checkedAt: null, checkedBy: null, checkedFlags: null, checkedForFile: null }).where(and(eq(vdrItems.dealId, deal.id), eq(vdrItems.checkedBy, SEED)));
          if (room?.setUpBy === SEED) {
            const [others] = await tx.select({ n: sql<number>`count(*)::int` }).from(vdrShares).where(eq(vdrShares.dealId, deal.id));
            const [otherViews] = await tx.select({ n: sql<number>`count(*)::int` }).from(vdrViews).where(eq(vdrViews.dealId, deal.id));
            if ((others?.n ?? 0) === 0 && (otherViews?.n ?? 0) === 0) {
              for (const t of [vdrPageText, vdrRequests, vdrBuyerSettings, vdrActivity, vdrItems, vdrFolders] as const) await tx.delete(t).where(eq((t as any).dealId, deal.id));
              await tx.delete(vdrRooms).where(eq(vdrRooms.dealId, deal.id));
              console.log("  the room was removed (nothing else was in it)");
            } else console.log("  the room stays: someone else's shares or reading are in it");
          }
        });
        console.log("  removed.");
      }
      continue;
    }

    // 1. Room + filing (idempotent).
    const existingRoom = (await db.select().from(vdrRooms).where(eq(vdrRooms.dealId, deal.id)))[0];
    if (existingRoom && existingRoom.setUpBy !== SEED) { console.log("  skipped: this deal already has a data room set up by a person"); continue; }
    if (!args.apply) console.log(`  would ${existingRoom ? "reuse" : "set up"} the room (set_up_by=${SEED}) and file every document`);
    else await setUpRoom(deal.id, SEED, "auto", { store: dbVdrStore, enqueue: () => {}, now: () => new Date() } as any);

    const snap = await loadRoom(dbVdrStore, deal.id);
    const live = snap.items.filter((i) => !i.removedAt);
    const pm = privateMattersByDocument(deal, live.filter((i) => i.documentId).map((i) => i.documentId!));
    const look = new Map<string, any[]>();
    const unchecked = new Map<string, string[]>();
    for (const it of live) {
      const doc = it.documentId ? snap.docs.get(it.documentId) ?? null : null;
      const f = flagsFor(it, doc, { privateMatters: doc ? pm.get(doc.id) : [], fileMissing: false, isLedger: isLedgerItemDoc(doc) });
      look.set(it.id, f.flags.filter((x) => f.unchecked.includes(x.key)));
      if (f.unchecked.length) unchecked.set(it.id, f.unchecked);
    }

    // 2. The plan + what the DD CIM points to.
    const plan = recommendedPlan(snap.folders as any, live, look as any);
    const choice = plan.folders.map((f) => {
      const folder = snap.folders.find((x) => x.id === f.folderId)!;
      const parent = folder.parentId ? snap.folders.find((x) => x.id === folder.parentId) : null;
      const rec = presetFolder(folder.presetKey)?.recommended ?? presetFolder(parent?.presetKey ?? null)?.recommended ?? "not_yet";
      return { folderId: f.folderId, levels: rec === "dd" ? [DD_ACCESS_LEVEL] : [] };
    });
    const allLive = new Set(live.map((i) => i.id));
    const planRows = planShareRows(choice, live.map((i) => ({ ...i, isLedger: isLedgerItemDoc(i.documentId ? snap.docs.get(i.documentId) ?? null : null) })), new Set(unchecked.keys()), allLive);
    const cited = (await citedByFactTracing(deal.id)) ?? [];
    const citedItems = live.filter((i) => i.documentId && cited.includes(i.documentId) && !isLedgerItemDoc(snap.docs.get(i.documentId!) ?? null));
    const have = new Set(snap.shares.filter((s) => s.audience === "level").map((s) => `${s.itemId}|${s.accessLevel}`));
    const shareRows = [...planRows, ...citedItems.map((i) => ({ itemId: i.id, accessLevel: DD_ACCESS_LEVEL }))]
      .filter((r, idx, all) => all.findIndex((x) => x.itemId === r.itemId && x.accessLevel === r.accessLevel) === idx)
      .filter((r) => !have.has(`${r.itemId}|${r.accessLevel}`));
    const toTick = Array.from(unchecked.entries()).filter(([id]) => shareRows.some((r) => r.itemId === id));
    console.log(`  plan: ${shareRows.length} level shares (${citedItems.length} documents the DD CIM points to); ${toTick.length} demo flags marked checked; ${live.length} basic descriptions accepted`);
    for (const r of shareRows) console.log(`    share ${live.find((i) => i.id === r.itemId)?.title} → ${r.accessLevel}`);

    // 3. Demo reading for demo buyers who can open the room.
    const links = (await db.select().from(buyerAccess).where(eq(buyerAccess.dealId, deal.id))).filter((a) => !a.revokedAt && a.ndaSigned);
    const settings = await dbVdrStore.listBuyerSettings(deal.id);
    const sharedItemIds = new Set([...snap.shares.filter((s) => s.effect === "allow").map((s) => s.itemId), ...shareRows.map((r) => r.itemId)]);
    const sharedItems = live.filter((i) => sharedItemIds.has(i.id) && i.prepared?.kind !== "ledger" && i.prepared?.kind !== "ledger_pending");
    const now = Date.now();
    const viewRows: any[] = [];
    const actRows: any[] = [];
    for (const link of links) {
      const setting = settings.find((s) => s.buyerEmail === buyerKey(link.buyerEmail));
      if (!hasRoomAccess(link.accessLevel, setting?.roomAccess as RoomAccessSetting | undefined)) continue;
      if (cimModeForAccessLevel(link.accessLevel) !== "dd") continue; // DD buyers only (the plan shares at that level)
      const [r] = await db.select({ ms: sql<number>`coalesce(sum(${buyerVisits.activeMs}),0)::int` }).from(buyerVisits).where(eq(buyerVisits.buyerAccessId, link.id));
      const cimMs = Number(r?.ms ?? 0) || (link.firstViewedAt ? 20 * 60_000 : 0);
      const reading = demoReadingPlan(cimMs, sharedItems.map((i) => ({ id: i.id, documentId: i.documentId, title: i.title, pages: i.prepared?.pages?.length ?? 3, financial: /tax|statement|financial|revenue|bank/i.test(i.title) })), link.id);
      reading.forEach((x, k) => {
        const id = randomUUID();
        const started = new Date(now - (2 + k) * 86_400_000 + k * 3_600_000);
        viewRows.push({ id, dealId: deal.id, buyerAccessId: link.id, buyerEmail: buyerKey(link.buyerEmail), teamMemberId: null, itemId: x.itemId, documentId: x.documentId, fileVersion: 1, trace: traceFor(id), source: "demo", startedAt: started, lastSeenAt: new Date(started.getTime() + x.activeMs), activeMs: x.activeMs, pageMs: x.pageMs, maxPage: x.maxPage, deviceClass: "desktop", downloaded: false });
        actRows.push({ dealId: deal.id, at: started, actorKind: "buyer", actorId: link.id, action: "buyer_opened_item", itemId: x.itemId, buyerEmail: buyerKey(link.buyerEmail), detail: { demo: true, viewId: id, source: "demo" } });
      });
      console.log(`  reading: ${link.buyerCompany || link.buyerName || link.buyerEmail} — ${reading.length} documents, ${Math.round(reading.reduce((s, x) => s + x.activeMs, 0) / 60_000)} min (CIM reading ${Math.round(cimMs / 60_000)} min)`);
    }

    // 4. Beacon: one demo accountant on Northgate's team (no link, no email).
    const northgate = /beacon/i.test(deal.demoKey ?? "") ? links.find((l) => /northgate/i.test(`${l.buyerCompany ?? ""} ${l.buyerEmail}`) && cimModeForAccessLevel(l.accessLevel) === "dd") : undefined;
    if (northgate) console.log(`  team: Priya Shah (accountant, priya.shah@northgate-accounting.invalid) on ${northgate.buyerCompany || northgate.buyerEmail}'s team — no link, no email`);

    if (!args.apply) { console.log("  (dry run: nothing written)"); continue; }
    await db.transaction(async (tx) => {
      if (shareRows.length) await tx.insert(vdrShares).values(shareRows.map((r) => ({ dealId: deal.id, itemId: r.itemId, audience: "level", accessLevel: r.accessLevel, buyerEmail: null, effect: "allow", createdBy: SEED }))).onConflictDoNothing();
      for (const [itemId, flags] of toTick) {
        const it = live.find((i) => i.id === itemId)!;
        await tx.update(vdrItems).set({ checkedAt: new Date(), checkedBy: SEED, checkedFlags: flags, checkedForFile: it.prepared?.forFile ?? null }).where(eq(vdrItems.id, itemId));
      }
      for (const it of live) {
        if (it.buyerSummaryStatus === "accepted") continue;
        const doc = it.documentId ? snap.docs.get(it.documentId) ?? null : null;
        await tx.update(vdrItems).set({ buyerSummary: basicDescription(doc, it.prepared ?? null), buyerSummarySource: "basic", buyerSummaryStatus: "accepted" }).where(eq(vdrItems.id, it.id));
      }
      await tx.update(vdrRooms).set({ planAppliedAt: new Date() }).where(eq(vdrRooms.dealId, deal.id));
      if (viewRows.length) await tx.insert(vdrViews).values(viewRows);
      if (actRows.length) await tx.insert(vdrActivity).values(actRows);
      if (northgate) {
        await tx.insert(vdrTeamMembers).values({ dealId: deal.id, principalEmail: buyerKey(northgate.buyerEmail), addedViaAccessId: northgate.id, name: "Priya Shah", email: "priya.shah@northgate-accounting.invalid", role: "accountant", status: "active", tokenHash: null, ackAt: new Date(), ackName: "Priya Shah", createdBy: SEED }).onConflictDoNothing();
      }
      await tx.insert(vdrActivity).values({ dealId: deal.id, actorKind: "system", actorId: SEED, action: "plan_applied", detail: { demo: true, shared: shareRows.length } });
    });
    console.log("  applied.");
  }
  process.exit(0);
}

if (process.argv[1] && /seed-demo-data-room/.test(process.argv[1])) {
  main().catch((err) => { console.error(err?.message ?? err); process.exit(1); });
}
