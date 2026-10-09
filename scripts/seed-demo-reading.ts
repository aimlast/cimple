/**
 * Sample part-by-part reading for the fictional example deals (heat-map
 * spec §7.2): turns each existing demo buyer's OLD page totals into reading
 * on each part of the page, so the heat map shows colours on the example
 * deals the founder demonstrates (Pacific Coast Logistics, Beacon Pharmacy).
 * The plan is server/engagement/demo-reading.ts (pure, deterministic).
 *
 * What it writes (one transaction per deal), all marked as sample data:
 *   - the versions buyers are served at each access level (cim_renditions,
 *     tagged demo_seed only when this script inserted them);
 *   - one sample visit per old visit (buyer_visits.demo_seed = the tag), its
 *     part-by-part rows and its jumps/opened sections;
 *   - the old visits are HIDDEN, never deleted (superseded_by = the tag).
 * Every page's reading time is kept exactly, so the Buyers view's numbers
 * don't change. Nothing touches buyer_access, questions, email or SMS.
 *
 * DRY RUN by default. --apply writes; --remove takes it all out again (per
 * deal) and shows the old visits again. Refuses anything that isn't a
 * fictional example deal of broker_demo or qa_cimgen (refuseReason).
 * No AI, no email; never prints connection strings, tokens or emails.
 *
 *   ANTHROPIC_API_KEY=disabled DATABASE_URL=… npx tsx scripts/seed-demo-reading.ts
 *       (--deal <id> | --all-demo) [--tag demo-reading-v1] [--apply | --remove] [--allow-old-levels] [--qa-copy-preview]
 *
 * --allow-old-levels   (qa_cimgen copies only) run before the access-level
 *                      update (buyers still on teaser/full/loi).
 * --qa-copy-preview    (qa_cimgen "QA OCT — …" copies only) the builder's
 *                      proof before the sample columns exist: versions
 *                      untagged, the old visits flipped to the broker's own
 *                      view instead of hidden. Delete the copy afterwards.
 */
import { sql } from "drizzle-orm";
import type { Deal } from "@shared/schema";
import { DEFAULT_ENGAGEMENT_FILTERS, type CimMode, type CimVariant, type RenditionPage } from "@shared/analytics-v2";
import { blindSectionKey, cimHeldFromBuyers, servesPublishedSnapshot } from "@shared/cim-buyer-view";
import { BUYER_ACCESS_LEVELS, buyerAccessLabel } from "@shared/cim-layouts";
import { storage } from "../server/storage";
import { asDate } from "../server/analytics/reading-ingest";
import { buildPageIndex, renditionId, servedCimFor } from "../server/analytics/renditions";
import { legacyPageRemap, legacyPlacementHow, type LegacySection } from "../server/engagement/legacy";
import { planLegacyReading, storeLegacyReading, unstoredRows } from "../server/engagement/legacy-store";
import {
  DEMO_READING_TAG, checkPlanTotals, planDemoReading, planRemoval, refuseReason, removalSql,
  type DemoBuyer, type DemoInput, type DemoOldPage, type DemoOldVisit, type DemoPlan,
} from "../server/engagement/demo-reading";
import { loadDealReadingFacts } from "../server/engagement/facts";
import { buildDocumentResponse } from "../server/engagement/responses";
import { heatAcceptance, heatTable } from "../server/engagement/heat-acceptance";
import { fmtDay } from "../server/engagement/lineage-repair";

type Row = Record<string, unknown>;
type Exec = { execute: (q: ReturnType<typeof sql>) => Promise<unknown> };

async function db() {
  return (await import("../server/db")).db;
}
async function q(text: ReturnType<typeof sql>, ex?: Exec): Promise<Row[]> {
  return (await (ex ?? (await db())).execute(text)) as unknown as Row[];
}
const ts = (d: Date) => sql`${d.toISOString()}::timestamp`;
const min = (ms: number) => Math.round(ms / 60_000);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function args() {
  const a = process.argv.slice(2);
  const val = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  return {
    deal: val("--deal"), allDemo: a.includes("--all-demo"), tag: val("--tag") ?? DEMO_READING_TAG,
    apply: a.includes("--apply"), remove: a.includes("--remove"),
    allowOldLevels: a.includes("--allow-old-levels"), preview: a.includes("--qa-copy-preview"),
  };
}

async function columnsExist(): Promise<boolean> {
  const r = await q(sql`SELECT COUNT(*)::int AS n FROM information_schema.columns WHERE table_schema = current_schema()
    AND ((table_name = 'buyer_visits' AND column_name IN ('demo_seed', 'superseded_by')) OR (table_name = 'cim_renditions' AND column_name = 'demo_seed'))`);
  return Number(r[0]?.n ?? 0) === 3;
}

interface Ctx {
  deal: Deal;
  owner: string | null;
  buyers: DemoBuyer[];
  live: LegacySection[];
  cols: boolean;
}

async function loadCtx(dealId: string, cols: boolean): Promise<Ctx | null> {
  const deal = await storage.getDeal(dealId);
  if (!deal) return null;
  const [o] = deal.brokerId ? await q(sql`SELECT username FROM users WHERE id = ${deal.brokerId}`) : [];
  const accesses = await storage.getBuyerAccessByDeal(deal.id);
  const live = (await storage.getCimSectionsByDeal(deal.id)).map((s) => ({
    id: s.id, sectionKey: s.sectionKey, sectionTitle: s.sectionTitle, layoutType: s.layoutType, analyticsLineage: s.analyticsLineage ?? null, order: s.order,
  }));
  return {
    deal, owner: o ? String(o.username) : null, live, cols,
    buyers: accesses.map((a) => ({
      id: a.id, name: a.buyerName || a.buyerCompany || "A buyer", buyerType: a.buyerType ?? null, accessLevel: a.accessLevel,
      decision: a.decision ?? null, email: a.buyerEmail ?? "",
    })),
  };
}

async function realVisitCount(dealId: string, cols: boolean): Promise<number> {
  const r = await q(sql`SELECT COUNT(*)::int AS n FROM buyer_visits WHERE deal_id = ${dealId} AND NOT legacy AND NOT self_view
    AND mode IS DISTINCT FROM 'teaser'${cols ? sql` AND demo_seed IS NULL` : sql``}`);
  return Number(r[0]?.n ?? 0);
}

/** The deal's old visits and their page totals: stored, plus (dry run) what storing would add. */
async function oldReading(dealId: string, includeUnstored: boolean): Promise<{ visits: DemoOldVisit[]; pages: DemoOldPage[]; willStore: { exits: number; visits: number; keys: Array<{ key: string; exits: number }> } | null }> {
  const vs = await q(sql`SELECT id, buyer_access_id, started_at, last_seen_at, wall_ms, active_ms, path FROM buyer_visits
    WHERE deal_id = ${dealId} AND legacy AND NOT self_view ORDER BY started_at`);
  const visits: DemoOldVisit[] = vs.map((v) => ({
    id: String(v.id), accessId: String(v.buyer_access_id), startedAt: asDate(v.started_at), lastSeenAt: asDate(v.last_seen_at),
    wallMs: Number(v.wall_ms) || 0, activeMs: Number(v.active_ms) || 0, path: Array.isArray(v.path) ? (v.path as Array<[number, string]>) : [],
  }));
  const ps = await q(sql`SELECT r.visit_id, r.buyer_access_id, r.page_id, r.lineage_id, r.attention_ms FROM reading_rollups r
    JOIN buyer_visits v ON v.id = r.visit_id WHERE r.deal_id = ${dealId} AND v.legacy AND NOT v.self_view`);
  const pages: DemoOldPage[] = ps.map((p) => ({
    visitId: String(p.visit_id), accessId: String(p.buyer_access_id), pageId: String(p.page_id), lineageId: p.lineage_id == null ? null : String(p.lineage_id),
    attentionMs: Number(p.attention_ms) || 0,
  }));
  let willStore = null;
  // Like the Engagement tab (queries.legacyExits): once any old visit is
  // stored, the old exits are never read again — so nothing is planned from
  // them twice (a QA copy's stored visits carry new ids).
  if (includeUnstored && visits.length === 0) {
    const plan = await planLegacyReading(dealId);
    const todo = unstoredRows(plan, new Set(visits.map((v) => v.id)));
    if (todo.visits.length > 0) {
      willStore = { exits: plan.exits, visits: todo.visits.length, keys: plan.keys.map((k) => ({ key: k.key, exits: k.exits })) };
      for (const v of todo.visits) visits.push({ id: v.id, accessId: v.accessId, startedAt: v.startedAt, lastSeenAt: v.lastSeenAt, wallMs: v.wallMs, activeMs: v.activeMs, path: v.path });
      for (const r of todo.rollups) pages.push({ visitId: r.visitId, accessId: r.accessId, pageId: r.pageId, lineageId: r.lineageId, attentionMs: r.attentionMs });
    }
  }
  return { visits, pages, willStore };
}

interface Version {
  level: string;
  input: { dealId: string; mode: CimMode; variant: CimVariant; cimLayoutVersion: number | null; sections: unknown[]; design: unknown };
  served: { renditionId: string; pages: RenditionPage[] };
}

async function versionsFor(deal: Deal, levels: string[]): Promise<Record<string, Version | null>> {
  const out: Record<string, Version | null> = {};
  for (const level of levels) {
    const s = await servedCimFor(deal, level, { ignoreHold: true }).catch(() => null);
    if (!s) { out[level] = null; continue; }
    const id = renditionId({ mode: s.mode, variant: s.variant, design: s.design, sections: s.sections });
    out[level] = {
      level,
      input: { dealId: deal.id, mode: s.mode, variant: s.variant, cimLayoutVersion: s.cimLayoutVersion, sections: s.sections as unknown[], design: s.design ?? null },
      served: { renditionId: id, pages: buildPageIndex(s.sections, s.design as never, s.live) },
    };
  }
  return out;
}

/** What has to be the same at write time as when planning (else: run again). */
async function fingerprint(dealId: string, ex?: Exec): Promise<string> {
  const [d] = await q(sql`SELECT cim_layout_version, cim_generation FROM deals WHERE id = ${dealId}`, ex);
  const g = (d?.cim_generation ?? null) as { buyerHold?: unknown; status?: unknown } | null;
  const [k] = await q(sql`SELECT MAX(taken_at) AS t FROM cim_published_snapshots WHERE deal_id = ${dealId}`, ex);
  const ids = (await q(sql`SELECT id FROM buyer_visits WHERE deal_id = ${dealId} AND legacy ORDER BY id`, ex)).map((r) => String(r.id));
  return JSON.stringify({ v: d?.cim_layout_version ?? null, hold: g?.buyerHold ?? null, status: g?.status ?? null, kept: k?.t ? asDate(k.t).toISOString() : null, ids });
}

function stateLine(deal: Deal): string {
  if (servesPublishedSnapshot(deal)) return "live; buyers read the version kept while your update waits";
  if (cimHeldFromBuyers(deal)) return "waiting for your review (buyers can't open it); drawn on the version they'll get when you publish";
  return deal.isLive ? "live" : "not live";
}

function printPlan(ctx: Ctx, plan: DemoPlan, versions: Record<string, Version | null>, old: { visits: DemoOldVisit[]; pages: DemoOldPage[] }, firstVisit: Date, place: DemoInput["place"], lineageChecked: boolean) {
  const used = plan.renditions.map((r) => versions[r.level]!);
  if (used.length) console.log(`  Versions: ${used.map((v) => `${buyerAccessLabel(v.level)} ${v.served.pages.length} pages`).join(" · ")} — dated ${fmtDay(firstVisit)} (the first visit, as the Engagement tab shows today)`);
  // Every old key with how it lands.
  const levelOf = new Map(ctx.buyers.map((b) => [b.id, b.accessLevel]));
  const byKey = new Map<string, { ms: number; how: string; title: string }>();
  const howOf = new Map<string, ReturnType<typeof legacyPlacementHow>>();
  const keyHow = legacyPlacementHow(ctx.live, blindSectionKey, null);
  for (const p of old.pages) {
    const level = levelOf.get(p.accessId) ?? "";
    const v = versions[level];
    if (!v) continue;
    if (!howOf.has(level)) howOf.set(level, legacyPlacementHow(ctx.live, blindSectionKey, v.served.pages));
    let h: string | null = howOf.get(level)!(p.pageId, p.lineageId);
    const page = place(level, p.pageId, p.lineageId);
    // An old KEY drawn on the current sections: say how the key itself
    // resolves (same key / blind key / via lineage / key words). On a kept
    // copy the stored page is the page buyers read, as it was stored.
    if (h && page && !/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(p.pageId) && !servesPublishedSnapshot(ctx.deal)) {
      h = keyHow(p.pageId, null) ?? h;
    }
    const title = page ? ctx.live.find((x) => x.id === page.pageId)?.sectionTitle || page.servedTitle : "";
    const cur = byKey.get(p.pageId) ?? { ms: 0, how: h ?? "not placed", title };
    cur.ms += p.attentionMs;
    byKey.set(p.pageId, cur);
  }
  const placed = Array.from(byKey.entries()).filter(([, x]) => x.how !== "not placed");
  const groups = new Map<string, string[]>();
  for (const [key, x] of placed) {
    const label = /^[0-9a-f]{8}-/.test(key) ? x.title : key;
    groups.set(x.how, [...(groups.get(x.how) ?? []), `${label} → ${x.title}`]);
  }
  const totalMs = old.pages.reduce((s, p) => s + Math.max(0, p.attentionMs), 0);
  const lostMs = plan.unplaced.reduce((s, u) => s + u.ms, 0);
  console.log(`  Old reading: ${plural(old.visits.length, "visit")}, ${plural(old.pages.length, "page total")}, ${min(totalMs)} min — ${lostMs === 0 ? "all placed" : `${min(lostMs)} min on pages this version doesn't have`}`);
  for (const [h, list] of Array.from(groups.entries())) {
    const flag = h === "via lineage" && !lineageChecked ? "  ← check this one (this deal's lineage couldn't be checked)" : "";
    if (h === "on this version") console.log(`    ${list.length} on this version (the pages buyers read)`);
    else console.log(`    ${h}: ${list.join(" · ")}${flag}`);
  }
  if (plan.unplaced.length) {
    console.log(`    Not placed: ${plan.unplaced.map((u) => u.key).join(", ")} — ${min(lostMs)} min (kept on each visit as earlier reading)`);
  }
  const pageHas = new Set(plan.rollups.filter((r) => r.renditionId).map((r) => r.pageId));
  const main = used[0];
  if (main) {
    const content = main.served.pages.length;
    console.log(`  Colour will show on ${plural(pageHas.size, "page")} of ${content}; ${content - pageHas.size} have no old reading.`);
  }
  console.log("  Buyer                    Sees            Decision          Depth  Visits  Pages  Minutes  Part rows  Device");
  for (const b of plan.perBuyer) {
    const buyer = ctx.buyers.find((x) => x.id === b.accessId)!;
    console.log(`  ${b.name.slice(0, 23).padEnd(23)}  ${buyerAccessLabel(b.level).padEnd(14)}  ${(buyer.decision ?? "undecided").padEnd(16)}  ${b.depth.toFixed(2).padStart(5)}  ${String(b.visits).padStart(6)}  ${String(b.pages).padStart(5)}  ${String(Math.round(b.minutes)).padStart(7)}  ${String(b.partRows).padStart(9)}  ${b.device}`);
  }
  for (const s of plan.skipped) {
    const name = ctx.buyers.find((x) => x.id === s.accessId)?.name ?? "A buyer";
    console.log(`  · ${name}: ${s.why}`);
  }
  const partRows = plan.rollups.filter((r) => r.blockKey !== "").length;
  console.log(`  Totals: ${plural(plan.visits.length, "sample visit")} · ${partRows.toLocaleString("en-CA")} part rows · ${plural(plan.events.length, "event")} (jumps and opened sections only) · ${min(totalMs - lostMs)} min kept exactly · ${min(lostMs)} min not placed`);
  console.log(`  Will hide (not delete) ${plural(plan.supersede.length, "old visit")} while the sample reading is in place.`);
}

async function lineageChecked(deal: Deal): Promise<boolean> {
  const [k] = await q(sql`SELECT COUNT(*)::int AS n FROM cim_published_snapshots WHERE deal_id = ${deal.id}`);
  if (Number(k?.n ?? 0) > 0) return true;
  if (deal.cimLayoutVersion == null) return false;
  const [r] = await q(sql`SELECT COUNT(*)::int AS n FROM cim_renditions WHERE deal_id = ${deal.id} AND cim_layout_version = ${deal.cimLayoutVersion - 1}`);
  return Number(r?.n ?? 0) > 0;
}

async function writePlan(ctx: Ctx, plan: DemoPlan, versions: Record<string, Version | null>, firstVisit: Date, before: string, opts: { tag: string; preview: boolean }) {
  const dealId = ctx.deal.id;
  const d = await db();
  return d.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`legacy-store:${dealId}`}))`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`demo-reading:${dealId}`}))`);
    if ((await fingerprint(dealId, tx)) !== before) throw new Error("The CIM or its reading changed while planning; run again. Nothing was written.");
    const tag = opts.preview ? null : opts.tag;
    const inserted: string[] = [];
    for (const r of plan.renditions) {
      const v = versions[r.level]!;
      const rows = await q(sql`
        INSERT INTO cim_renditions (id, deal_id, mode, variant, cim_layout_version, sections, design, page_index, created_at${tag ? sql`, demo_seed` : sql``})
        VALUES (${r.renditionId}, ${dealId}, ${v.input.mode}, ${v.input.variant}, ${v.input.cimLayoutVersion},
          ${JSON.stringify(v.input.sections)}::jsonb, ${JSON.stringify(v.input.design ?? null)}::jsonb, ${JSON.stringify(v.served.pages)}::jsonb, ${ts(firstVisit)}${tag ? sql`, ${tag}` : sql``})
        ON CONFLICT (id) DO NOTHING RETURNING id`, tx);
      if (rows.length) inserted.push(r.renditionId);
    }
    let visitsAdded = 0;
    for (let i = 0; i < plan.visits.length; i += 100) {
      const chunk = plan.visits.slice(i, i + 100);
      visitsAdded += (await q(sql`
        INSERT INTO buyer_visits (id, deal_id, buyer_access_id, rendition_id, mode, access_level, device_class, viewport_w, viewport_h, ua_family, ip_hash,
          started_at, last_seen_at, wall_ms, active_ms, idle_ms, hidden_ms, away_ms, outside_ms, max_page_index, path, self_view, clamped, legacy, created_at${tag ? sql`, demo_seed` : sql``})
        VALUES ${sql.join(chunk.map((v) => sql`(${v.id}, ${dealId}, ${v.accessId}, ${v.renditionId}, ${v.mode}, ${v.accessLevel}, ${v.deviceClass}, ${v.viewportW}, ${v.viewportH},
          ${v.uaFamily}, ${v.ipHash}, ${ts(v.startedAt)}, ${ts(v.lastSeenAt)}, ${v.wallMs}, ${v.activeMs}, ${v.idleMs}, 0, 0, 0, ${v.maxPageIndex},
          ${JSON.stringify(v.path)}::jsonb, false, false, false, ${ts(v.startedAt)}${tag ? sql`, ${tag}` : sql``})`), sql`, `)}
        ON CONFLICT (id) DO NOTHING RETURNING id`, tx)).length;
    }
    for (let i = 0; i < plan.rollups.length; i += 500) {
      const chunk = plan.rollups.slice(i, i + 500);
      await tx.execute(sql`
        INSERT INTO reading_rollups (visit_id, page_id, block_key, deal_id, buyer_access_id, rendition_id, lineage_id, attention_ms, skim_ms, visible_ms, pointer_ms, first_at, last_at)
        VALUES ${sql.join(chunk.map((r) => sql`(${r.visitId}, ${r.pageId}, ${r.blockKey}, ${dealId}, ${r.accessId}, ${r.renditionId}, ${r.lineageId},
          ${r.attentionMs}, ${r.skimMs}, ${r.visibleMs}, ${r.pointerMs}, ${ts(r.firstAt)}, ${ts(r.lastAt)})`), sql`, `)}
        ON CONFLICT (visit_id, page_id, block_key) DO NOTHING`);
    }
    for (let i = 0; i < plan.events.length; i += 200) {
      const chunk = plan.events.slice(i, i + 200);
      await tx.execute(sql`
        INSERT INTO analytics_events (deal_id, buyer_access_id, event_type, event_data, visit_id, rendition_id, page_id, block_key, client_seq, created_at)
        VALUES ${sql.join(chunk.map((e) => sql`(${dealId}, ${e.accessId}, ${e.type}, ${JSON.stringify({ detail: e.detail, at: e.at.toISOString() })}::jsonb,
          ${e.visitId}, ${e.renditionId}, ${e.pageId}, ${e.blockKey}, ${e.seq}, ${ts(e.at)})`), sql`, `)}
        ON CONFLICT (visit_id, client_seq) WHERE visit_id IS NOT NULL DO NOTHING`);
    }
    const ids = plan.supersede;
    let hidden = 0;
    if (ids.length) {
      const r = opts.preview
        ? await q(sql`UPDATE buyer_visits SET self_view = true WHERE deal_id = ${dealId} AND legacy AND id IN (${sql.join(ids.map((x) => sql`${x}`), sql`, `)}) RETURNING id`, tx)
        : await q(sql`UPDATE buyer_visits SET superseded_by = ${opts.tag} WHERE deal_id = ${dealId} AND legacy AND superseded_by IS NULL
            AND id IN (${sql.join(ids.map((x) => sql`${x}`), sql`, `)}) RETURNING id`, tx);
      hidden = r.length;
    }
    return { inserted, hidden, visitsAdded };
  });
}

async function servingNow(deal: Deal, levels: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const level of levels) {
    const s = await servedCimFor(deal, level).catch(() => null);
    if (s) out.push(renditionId({ mode: s.mode, variant: s.variant, design: s.design, sections: s.sections }));
  }
  return out;
}

async function remove(ctx: Ctx, tag: string, apply: boolean) {
  const dealId = ctx.deal.id;
  const [c] = await q(sql`SELECT
      (SELECT COUNT(*)::int FROM buyer_visits WHERE deal_id = ${dealId} AND demo_seed = ${tag}) AS visits,
      (SELECT COUNT(*)::int FROM buyer_visits WHERE deal_id = ${dealId} AND superseded_by = ${tag}) AS hidden,
      (SELECT COUNT(*)::int FROM cim_renditions WHERE deal_id = ${dealId} AND demo_seed = ${tag}) AS versions`);
  console.log(`  On file: ${plural(Number(c.visits), "sample visit")} · ${plural(Number(c.hidden), "hidden old visit")} · ${plural(Number(c.versions), "version")} added by the seed`);
  if (!apply) { console.log("  Nothing removed (dry run). Re-run with --remove --apply to take the sample reading out."); return; }
  const levels = Array.from(new Set([...ctx.buyers.map((b) => b.accessLevel), ...BUYER_ACCESS_LEVELS.map((l) => l.key as string)]));
  const serving = await servingNow(ctx.deal, levels);
  const r = planRemoval(dealId, tag);
  const res = await (await db()).transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`demo-reading:${dealId}`}))`);
    const counts: string[] = [];
    let versions: Row[] = [];
    for (const step of r.steps) {
      const out = await q(removalSql(step, serving), tx);
      if (step.op === "versions") versions = out;
      else counts.push(`${step.op.replace("_", " ")}: ${(out as unknown as { count?: number }).count ?? "done"}`);
    }
    return { counts, versions };
  });
  const kept = res.versions.filter((v) => v.what === "kept").length;
  const deleted = res.versions.filter((v) => v.what === "deleted").length;
  console.log(`  Removed: ${res.counts.join(" · ")} · versions deleted ${deleted}${kept ? ` · ${kept} kept: buyers are served this version now (tag cleared)` : ""}`);
}

async function main() {
  const a = args();
  const key = process.env.ANTHROPIC_API_KEY;
  if (key !== "disabled" && key !== "unused") throw new Error("Run this with ANTHROPIC_API_KEY=disabled (it never calls the AI).");
  if (!a.deal && !a.allDemo) throw new Error("usage: seed-demo-reading.ts (--deal <id> | --all-demo) [--tag …] [--apply | --remove] [--allow-old-levels] [--qa-copy-preview]");
  if (a.apply && a.remove && a.preview) throw new Error("--remove isn't available with --qa-copy-preview: delete the QA copy instead.");
  const cols = await columnsExist();
  const mode = a.remove ? (a.apply ? "REMOVE" : "REMOVE — DRY RUN (nothing written)") : a.apply ? "APPLY" : "DRY RUN (nothing written)";
  console.log(`seed-demo-reading — ${mode} · tag ${a.tag}${a.preview ? " · QA copy preview" : ""}`);
  const ids = a.deal ? [a.deal] : (await q(sql`
    SELECT d.id FROM deals d JOIN users u ON u.id = d.broker_id
    WHERE u.username = 'broker_demo' AND d.demo_key IS NOT NULL
      AND (EXISTS (SELECT 1 FROM buyer_visits v WHERE v.deal_id = d.id AND v.legacy)
        OR EXISTS (SELECT 1 FROM analytics_events e WHERE e.deal_id = d.id AND e.event_type = 'section_exit'))
    ORDER BY d.business_name`)).map((r) => String(r.id));
  let failed = false;
  for (const id of ids) {
    const ctx = await loadCtx(id, cols);
    if (!ctx) { console.log(`No deal ${id}.`); failed = true; continue; }
    const { deal } = ctx;
    console.log(`${deal.businessName} (${deal.id.slice(0, 8)}…, demo_key ${deal.demoKey ?? "none"}, ${ctx.owner ?? "no owner"}) — ${stateLine(deal)}`);
    // Guards (plain refusals).
    const isQaCopy = ctx.owner === "qa_cimgen" && /^QA OCT — /.test(deal.businessName ?? "");
    const refusals: string[] = [];
    const real = await realVisitCount(deal.id, cols);
    const why = refuseReason({ id: deal.id, businessName: deal.businessName, demoKey: deal.demoKey ?? null }, ctx.owner, ctx.buyers.map((b) => ({ email: b.email })), a.remove ? 0 : real);
    if (why) refusals.push(why);
    if (!cols && !a.preview) refusals.push("Run this after the release that adds the sample-reading columns is deployed.");
    if (a.preview && !isQaCopy) refusals.push("--qa-copy-preview is only for qa_cimgen copies named “QA OCT — …”.");
    if (!a.remove) {
      const [lv] = await q(sql`SELECT COUNT(*)::int AS n FROM buyer_access WHERE deal_id = ${deal.id} AND access_level IN ('teaser', 'full', 'loi')`);
      if (Number(lv?.n ?? 0) > 0) {
        if (!a.allowOldLevels) refusals.push("Run this after the access-level update is deployed (buyers here still have the old access names).");
        else if (ctx.owner !== "qa_cimgen") refusals.push("--allow-old-levels is only for qa_cimgen copies.");
      }
    }
    if (refusals.length) {
      for (const r of refusals) console.log(`  Refused: ${r}`);
      if (a.apply) { failed = true; continue; }
      console.log("  (Planning anyway so you can review it — --apply will refuse.)");
    }
    if (a.remove) { await remove(ctx, a.tag, a.apply); continue; }

    // 1. The old reading (stored first on --apply, as a regeneration would).
    let stored = null;
    const [lv] = await q(sql`SELECT COUNT(*)::int AS n FROM buyer_visits WHERE deal_id = ${deal.id} AND legacy`);
    if (a.apply && !refusals.length && Number(lv?.n ?? 0) === 0) {
      const s = await storeLegacyReading(deal.id);
      if (s.visits.length > s.alreadyStored) stored = s;
    }
    const old = await oldReading(deal.id, !a.apply);
    if (old.willStore) {
      console.log(`  Will first store the old reading (as a regeneration would): ${old.willStore.exits} exits → ${plural(old.willStore.visits, "visit")}`);
    } else if (stored) {
      console.log(`  Stored the old reading first: ${stored.exits} exits → ${plural(stored.visits.length - stored.alreadyStored, "visit")}`);
    }
    if (old.visits.length === 0) { console.log("  No old reading on file: nothing to convert."); continue; }
    const firstVisit = new Date(Math.min(...old.visits.map((v) => v.startedAt.getTime())));
    const readingLevels = Array.from(new Set(ctx.buyers.filter((b) => old.visits.some((v) => v.accessId === b.id)).map((b) => b.accessLevel)));
    const versions = await versionsFor(deal, readingLevels);
    const remaps = new Map<string, ReturnType<typeof legacyPageRemap>>();
    const place: DemoInput["place"] = (level, pageId, lineageId) => {
      const v = versions[level];
      if (!v) return null;
      if (!remaps.has(level)) remaps.set(level, legacyPageRemap(ctx.live, blindSectionKey, v.served.pages));
      const to = remaps.get(level)!(pageId, lineageId);
      if (!to) return null;
      return v.served.pages.find((p) => p.pageId === to.pageId) ?? v.served.pages.find((p) => p.lineageId === to.lineageId) ?? null;
    };
    const input: DemoInput = {
      tag: a.tag, deal: { id: deal.id, demoKey: deal.demoKey ?? null, businessName: deal.businessName ?? "" },
      buyers: ctx.buyers, visits: old.visits, pages: old.pages,
      served: Object.fromEntries(Object.entries(versions).map(([k, v]) => [k, v ? v.served : null])),
      place,
    };
    const plan = planDemoReading(input);
    printPlan(ctx, plan, versions, old, firstVisit, place, await lineageChecked(deal));
    const diffs = checkPlanTotals(input, plan);
    if (diffs.length) {
      console.log(`  Refused: the plan doesn't keep the reading time exactly (${diffs.length} difference${diffs.length === 1 ? "" : "s"}, e.g. ${diffs[0].pageId}: ${diffs[0].oldMs} → ${diffs[0].newMs} ms). Nothing written.`);
      failed = true;
      continue;
    }
    if (!a.apply || refusals.length) continue;
    const before = await fingerprint(deal.id);
    const res = await writePlan(ctx, plan, versions, firstVisit, before, { tag: a.tag, preview: a.preview });
    console.log(`  Written: ${plural(res.inserted.length, "version")} added · ${plural(res.visitsAdded, "sample visit")} added${res.visitsAdded < plan.visits.length ? ` (${plan.visits.length - res.visitsAdded} already in place)` : ""} · ${plural(res.hidden, "old visit")} ${a.preview ? "set aside (preview)" : "hidden"}.`);
    // Read-only check: what the Engagement tab now shows.
    const doc = buildDocumentResponse(await loadDealReadingFacts(deal, DEFAULT_ENGAGEMENT_FILTERS));
    console.log(`  What “Where they read” shows now (${doc.rendition?.label ?? "no version"}):`);
    for (const line of heatTable(doc)) console.log(`    ${line}`);
    for (const line of heatAcceptance(doc, null, { preview: a.preview }).lines) console.log(`  ${line}`);
  }
  if (!a.apply) console.log(a.remove ? "" : "Nothing written. Re-run with --apply.");
  return !failed;
}

main().then((ok) => process.exit(ok ? 0 : 1)).catch((err) => {
  console.error(String(err?.message ?? err).replace(/postgres(ql)?:\/\/[^\s"']+/g, "<DATABASE_URL>"));
  process.exit(1);
});
