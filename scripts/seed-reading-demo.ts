/**
 * Seeds realistic, SYNTHETIC buyer reading for one deal so the Engagement
 * tab (heat map on the real CIM, call list, journeys) can be reviewed before
 * real buyers arrive. No AI. Deterministic (a seeded PRNG).
 *
 * It writes through server/analytics/reading-ingest.ts — the same checks,
 * clamp and merge as real view-room traffic — on renditions built exactly
 * as the view room builds them (buildBuyerCim + the design, per access level).
 *
 * Safety: it REFUSES unless the deal is a demo deal (deals.demo_key) or
 * belongs to the qa_cimgen broker, and unless every buyer it writes for has
 * a SUBMITTED decision (interested / not interested) — so the day-3/6/8
 * reminder pipeline never emails them. Buyers it creates use .invalid
 * emails, a signed NDA, a submitted decision and crmSyncStatus
 * "not_configured". Nothing is ever emailed.
 *
 *   ANTHROPIC_API_KEY=disabled DATABASE_URL=… npx tsx scripts/seed-reading-demo.ts --deal <id> [--create-buyers 8] [--seed 7] [--wipe] [--dry-run]
 *
 *   --create-buyers N  add N fictional buyers first (varied type, access level, decision)
 *   --wipe             delete this deal's earlier reading (visits, rollups, reading events) first
 *   --dry-run          plan and print, write nothing
 */
import { randomBytes } from "crypto";
import { sql } from "drizzle-orm";
import { db } from "../server/db";
import { storage } from "../server/storage";
import { dbReadingStore, ingestReading, networkKey } from "../server/analytics/reading-ingest";
import { recordRendition, servedCimFor, buildPageIndex } from "../server/analytics/renditions";
import { pageRole } from "../shared/cim-page-role";
import type { BlockCounters, PageRole, ReadingInteraction, ReadingPayload, RenditionPage } from "../shared/analytics-v2";
import type { BuyerAccess, Deal } from "../shared/schema";

// ── Arguments ───────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const arg = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const dealId = arg("deal");
const createN = Number(arg("create-buyers") ?? 0);
const seed = Number(arg("seed") ?? 7);
const dryRun = args.includes("--dry-run");
const wipe = args.includes("--wipe");
if (!dealId) { console.error("usage: --deal <id> [--create-buyers N] [--seed N] [--wipe] [--dry-run]"); process.exit(2); }
if (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== "disabled") {
  console.error("refusing: run with ANTHROPIC_API_KEY=disabled (this script never needs the AI)"); process.exit(2);
}

// ── Deterministic randomness ────────────────────────────────────────────
let s32 = seed >>> 0 || 1;
const rnd = () => { s32 = (s32 + 0x6d2b79f5) >>> 0; let t = s32; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)];
const lognormal = (sigma = 0.45) => Math.exp(sigma * Math.sqrt(-2 * Math.log(1 - rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd()));
const uuid = () => { const b = randomBytes(16); b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80; const h = b.toString("hex"); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };

// ── Personas: where each kind of buyer spends time ──────────────────────
type Persona = "pe" | "strategic" | "individual" | "skimmer";
const FOCUS: Record<Persona, Partial<Record<PageRole, number>>> = {
  pe: { financials: 2.5, normalization: 2, revenue_mix: 1.4, customers: 1.3, transaction: 1.3, front_matter: 0.3 },
  strategic: { customers: 2, operations: 2, market: 2, revenue_mix: 1.5, growth: 1.4, employees: 1.2, front_matter: 0.3 },
  individual: { location: 2, employees: 2, owner_transition: 2, transaction: 2, financials: 1.2, front_matter: 0.4 },
  skimmer: {},
};
const personaOf = (a: BuyerAccess, i: number): Persona => {
  if (i % 5 === 4) return "skimmer";
  const t = (a.buyerType ?? "").toLowerCase();
  if (/equity|financial|family|fund/.test(t)) return "pe";
  if (/strategic|company/.test(t)) return "strategic";
  return "individual";
};

const QUESTION_BANK: Partial<Record<PageRole, string[]>> = {
  financials: ["Can you share monthly revenue for the last 24 months?", "What drove the margin change last year?"],
  normalization: ["Can we walk through each add-back with the accountant?", "Is the owner's salary adjustment at market rate?"],
  customers: ["How long have the top five clients been with the business?", "Are any key contracts up for renewal this year?"],
  location: ["Is the lease transferable, and is there a renewal option?", "What is the current rent per square foot?"],
  employees: ["Will the key staff stay on after the sale?", "Are any employees on non-competes?"],
  owner_transition: ["How long would the owner stay for the transition?"],
  transaction: ["Is the seller open to a vendor take-back note?", "Is working capital included in the price?"],
  growth: ["Which growth initiative has the most traction today?"],
};

// ── Fictional buyers (created only with --create-buyers) ────────────────
const PEOPLE = [
  ["Jordan Lee", "Harbor Capital Partners", "private_equity", "full", "interested"],
  ["Priya Nair", "Northwind Dental Group", "strategic", "loi", "interested"],
  ["Marcus Bell", null, "individual", "full", "not_interested"],
  ["Elena Rossi", "Summit Family Office", "family_office", "teaser", "interested"],
  ["Tom Becker", null, "individual", "teaser", "not_interested"],
  ["Aisha Khan", "Cedar Ridge Holdings", "strategic", "full", "interested"],
  ["Daniel Wu", "Beacon Search Fund", "search_fund", "full", "not_interested"],
  ["Sofia Alvarez", "Granite Peak Equity", "private_equity", "loi", "interested"],
  ["Ben Carter", null, "individual", "full", "interested"],
  ["Hana Sato", "Pacific Rim Partners", "strategic", "teaser", "not_interested"],
] as const;

async function createBuyers(deal: Deal, n: number): Promise<void> {
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    const [name, company, type, level, decision] = PEOPLE[i % PEOPLE.length];
    const slug = name.toLowerCase().replace(/[^a-z]+/g, ".");
    const created = await storage.createBuyerAccess({
      dealId: deal.id,
      accessToken: randomBytes(24).toString("hex"),
      buyerEmail: `${slug}.${i}@example.invalid`,
      buyerName: name,
      buyerCompany: company,
      buyerType: type,
      accessLevel: level,
      ndaSigned: true,
      ndaSignedAt: new Date(now - (20 - i) * 86_400_000),
      expiresAt: new Date(now + 30 * 86_400_000),
    } as any);
    await storage.updateBuyerAccess(created.id, { decision, decisionAt: new Date(now - 86_400_000), crmSyncStatus: "not_configured" } as any);
  }
}

// ── One buyer's reading ─────────────────────────────────────────────────
interface Visit { start: number; pages: Array<{ page: RenditionPage; mult: number; jump?: boolean }>; device: { w: number; h: number; touch: boolean; dpr: number } }

function planVisits(persona: Persona, pages: RenditionPage[], phone: boolean, firstDaysAgo: number): Visit[] {
  const content = pages.filter((p) => !p.locked || rnd() < 0.5);
  const roleOf = (p: RenditionPage) => pageRole({ layoutType: p.layoutType, title: p.servedTitle, pageId: p.pageId });
  const mult = (p: RenditionPage) => (persona === "skimmer" ? 0.15 : FOCUS[persona][roleOf(p)] ?? 1) * (p.locked ? 0.3 : 1);
  const device = phone ? { w: 390, h: 844, touch: true, dpr: 3 } : { w: pick([1440, 1536, 1920]), h: pick([900, 864, 1080]), touch: false, dpr: pick([1, 2]) };
  const visits: Visit[] = [];
  const start = Date.now() - firstDaysAgo * 86_400_000 + Math.floor(rnd() * 8) * 3_600_000;
  // First visit: in order, maybe straight to the price first; skimmers and some others stop early.
  const order = [...content];
  const priceFirst = (persona === "individual" || persona === "pe") && rnd() < 0.35;
  const first: Visit = { start, pages: [], device };
  if (priceFirst) {
    const tx = order.find((p) => roleOf(p) === "transaction");
    if (tx) first.pages.push({ page: order[0], mult: 0.3 }, { page: tx, mult: mult(tx) * 1.3, jump: true });
  }
  const stopAt = persona === "skimmer" ? Math.ceil(order.length * (0.3 + rnd() * 0.3)) : rnd() < 0.3 ? Math.ceil(order.length * (0.55 + rnd() * 0.3)) : order.length;
  for (const p of order.slice(0, stopAt)) {
    if (first.pages.some((x) => x.page === p)) continue;
    first.pages.push({ page: p, mult: rnd() < 0.12 ? 0.08 : mult(p) });   // now and then a page is scrolled past
  }
  visits.push(first);
  // Return visits: 1–6 days later, for the pages this buyer cares about.
  const returns = persona === "skimmer" ? 0 : persona === "pe" ? 2 : rnd() < 0.6 ? 1 : 0;
  let at = start;
  for (let r = 0; r < returns; r++) {
    at += (1 + Math.floor(rnd() * 5)) * 86_400_000 + Math.floor(rnd() * 6) * 3_600_000;
    if (at > Date.now() - 3_600_000) break;
    const favourites = [...content].sort((a, b) => mult(b) - mult(a)).slice(0, 2 + Math.floor(rnd() * 2));
    visits.push({ start: at, device, pages: favourites.map((p, i) => ({ page: p, mult: mult(p) * (0.6 + rnd() * 0.6), jump: i === 0 })) });
  }
  return visits;
}

async function main() {
  const deal = await storage.getDeal(dealId!);
  if (!deal) throw new Error("no such deal");
  const broker = deal.brokerId ? await storage.getUser(deal.brokerId) : undefined;
  if (!deal.demoKey && broker?.username !== "qa_cimgen") {
    throw new Error(`refusing: "${deal.businessName}" is neither a demo deal nor a qa_cimgen deal`);
  }
  if (createN > 0 && !dryRun) await createBuyers(deal, createN);
  const accesses = (await storage.getBuyerAccessByDeal(deal.id)).filter((a) => !a.revokedAt);
  const undecided = accesses.filter((a) => a.decision !== "interested" && a.decision !== "not_interested");
  if (undecided.length) {
    throw new Error(`refusing: ${undecided.length} buyer(s) have no submitted decision (the reminder pipeline could email them): ${undecided.map((a) => a.buyerEmail).join(", ")}`);
  }
  if (accesses.length === 0) throw new Error("no buyers on this deal (use --create-buyers N)");
  if (accesses.some((a) => !/\.invalid$/i.test(a.buyerEmail))) throw new Error("refusing: every seeded buyer must have a .invalid email");

  if (wipe && !dryRun) {
    await db.execute(sql`DELETE FROM reading_rollups WHERE deal_id = ${deal.id}`);
    await db.execute(sql`DELETE FROM analytics_events WHERE deal_id = ${deal.id} AND visit_id IS NOT NULL`);
    await db.execute(sql`DELETE FROM buyer_visits WHERE deal_id = ${deal.id}`);
    await db.execute(sql`UPDATE buyer_access SET view_count = 0 WHERE deal_id = ${deal.id}`);
  }

  // The served version per access level (exactly what the view room would serve).
  const byLevel = new Map<string, { id: string; pages: RenditionPage[] } | null>();
  for (const level of Array.from(new Set(accesses.map((a) => a.accessLevel)))) {
    const served = await servedCimFor(deal, level);
    if (!served) { byLevel.set(level, null); console.warn(`[seed] ${level}: nothing served yet (blind version preparing?) — skipped`); continue; }
    const reading = dryRun ? { renditionId: "dry-run" } : await recordRendition(served);
    if (!reading) throw new Error("could not record the rendition");
    byLevel.set(level, { id: reading.renditionId, pages: buildPageIndex(served.sections, served.design as any, served.live) });
  }

  const report: Array<Record<string, unknown>> = [];
  let q = 0;
  for (const [i, a] of accesses.entries()) {
    const r = byLevel.get(a.accessLevel);
    if (!r) continue;
    const persona = personaOf(a, i);
    const phone = i % 6 === 2;
    const visits = planVisits(persona, r.pages, phone, 4 + Math.floor(rnd() * 14));
    let firstStart = Infinity;
    let lastEnd = 0;
    let totalActive = 0;
    for (const v of visits) {
      const visitId = uuid();
      const blocks = new Map<string, BlockCounters>();
      const add = (pageId: string, key: string, c: BlockCounters) => {
        const id = `${pageId}|${key}`;
        const p = blocks.get(id) ?? [0, 0, 0, 0];
        blocks.set(id, [p[0] + c[0], p[1] + c[1], p[2] + c[2], p[3] + c[3]].map(Math.round) as BlockCounters);
      };
      const path: Array<[number, string]> = [];
      const events: ReadingInteraction[] = [];
      let active = 0;
      let seq = 0;
      const ev = (type: ReadingInteraction["type"], pageId: string, extra: Partial<ReadingInteraction> = {}) =>
        events.push({ seq: ++seq, type, pageId, at: new Date(v.start + active + 5_000).toISOString(), ...extra });
      let maxOrder = -1;
      for (const { page, mult, jump } of v.pages) {
        if (jump && path.length) ev("nav", path[path.length - 1][1], { detail: `toc:${page.pageId}` });
        path.push([Math.floor(active / 1000), page.pageId]);
        maxOrder = Math.max(maxOrder, page.order);
        const skim = persona === "skimmer" || mult < 0.1 ? 0.6 : 0.08;
        const expandable = page.blocks.some((b) => b.when === "collapsed");
        const opens = !expandable || rnd() < 0.6;
        if (expandable && opens) ev("expand", page.pageId);
        let pageMs = 0;
        for (const b of page.blocks) {
          if (b.virtual) continue;
          if (b.when === "collapsed" && opens) continue;
          if (b.when === "normalized") continue;
          if (expandable && !opens && b.when !== "collapsed" && b.key !== "heading") continue;
          const t = b.expectedMs * mult * lognormal();
          add(page.pageId, b.key, [t * (1 - skim), t * skim, t * 1.15 + 800, 0]);
          pageMs += t;
          if (b.kind === "chart" && persona !== "skimmer") {
            const points = page.blocks.filter((x) => x.virtual && x.key.startsWith(`${b.key}/point:`));
            if (points.length) {
              const pt = points[points.length - 1 - Math.floor(rnd() * Math.min(2, points.length))];
              const ms = 1_500 + rnd() * 7_000;
              add(page.pageId, pt.key, [0, 0, 0, ms]);
              add(page.pageId, b.key, [0, 0, 0, ms]);
            }
          }
          if (b.kind === "locked") ev("locked_click", page.pageId, { blockKey: "locked" });
        }
        // PE buyers switch the income statement to Normalized and read it.
        const nrows = page.blocks.filter((b) => b.when === "normalized" && b.key.startsWith("nrow:"));
        if (nrows.length && persona === "pe") {
          ev("financial_view", page.pageId, { detail: "normalized" });
          for (const b of nrows) { const t = b.expectedMs * mult * 0.7 * lognormal(); add(page.pageId, b.key, [t, t * 0.05, t * 1.1, 0]); pageMs += t; }
        }
        const elsewhere = pageMs * 0.06;
        add(page.pageId, "", [elsewhere, 0, pageMs * 0.9, 0]);
        active += pageMs * (1 + skim) + elsewhere + 1_500;
        // A page-tied question now and then.
        const role = pageRole({ layoutType: page.layoutType, title: page.servedTitle, pageId: page.pageId });
        const bank = QUESTION_BANK[role];
        if (bank && persona !== "skimmer" && rnd() < 0.18 && !dryRun) {
          await db.execute(sql`INSERT INTO buyer_questions (deal_id, buyer_access_id, question, status, answer_scope, section_id, rendition_id, created_at, updated_at)
            VALUES (${deal.id}, ${a.id}, ${pick(bank)}, ${q++ % 2 ? "published" : "pending_broker"}, 'private', ${page.pageId}, ${r.id},
                    ${new Date(v.start + active).toISOString()}::timestamp, ${new Date(v.start + active).toISOString()}::timestamp)`);
        }
      }
      if (rnd() < 0.2 && persona !== "skimmer") ev("copy", v.pages[Math.floor(rnd() * v.pages.length)].page.pageId);
      const credited = Array.from(blocks.values()).reduce((s, c) => s + c[0] + c[1], 0);
      const idle = Math.round(active * (0.05 + rnd() * 0.2));
      const outside = Math.round(8_000 + rnd() * 20_000);
      const activeMs = Math.round(credited + outside);
      const wallMs = activeMs + idle;
      firstStart = Math.min(firstStart, v.start);
      lastEnd = Math.max(lastEnd, v.start + wallMs);
      totalActive += activeMs;
      const base: Omit<ReadingPayload, "blocks" | "path" | "events" | "visit" | "sentAt"> = { visitId, renditionId: r.id, device: v.device };
      const visitClock = { wallMs, activeMs, idleMs: idle, hiddenMs: 0, awayMs: 0, outsideMs: outside, maxPageIndex: maxOrder };
      const entries = Array.from(blocks.entries());
      // Two sends, as a tab would: half-way, then the rest (cumulative, merged with GREATEST).
      const half = entries.slice(0, Math.ceil(entries.length / 2));
      const sends: ReadingPayload[] = [
        { ...base, sentAt: "", visit: { ...visitClock, wallMs: Math.round(wallMs / 2), activeMs: Math.round(activeMs / 2), idleMs: Math.round(idle / 2), outsideMs: 0 },
          blocks: Object.fromEntries(half.map(([k, c]) => [k, c.map((x) => Math.floor(x / 2)) as BlockCounters])), path: { from: 0, entries: path.slice(0, 1) }, events: [] },
        { ...base, sentAt: "", visit: visitClock, blocks: Object.fromEntries(entries), path: { from: 0, entries: path }, events },
      ];
      if (dryRun) { report.push({ buyer: a.buyerName, persona, visitPages: v.pages.length, activeMs }); continue; }
      for (const [k, p] of sends.entries()) {
        const now = new Date(v.start + (k === 0 ? wallMs / 2 : wallMs) + 2_000);
        const res = await ingestReading(dbReadingStore, {
          deal: { id: deal.id }, access: { id: a.id, dealId: deal.id, accessLevel: a.accessLevel },
          payload: { ...p, sentAt: now.toISOString() }, now, selfView: false,
          ipHash: networkKey(deal.id, `198.51.100.${(i * 7 + (k % 2)) % 250}`), uaFamily: v.device.touch ? "Safari/iOS" : pick(["Chrome/Mac", "Chrome/Windows", "Edge/Windows", "Safari/Mac"]),
        });
        if (res.status !== 204) throw new Error(`ingest refused (${res.status}): ${res.reason}`);
      }
    }
    if (!dryRun && Number.isFinite(firstStart)) {
      const decisionAt = new Date(Math.min(Date.now() - 60_000, lastEnd + 3_600_000));
      await storage.updateBuyerAccess(a.id, { firstViewedAt: new Date(firstStart), lastAccessedAt: new Date(lastEnd), decisionAt } as any);
      await db.execute(sql`INSERT INTO analytics_events (deal_id, buyer_access_id, event_type, event_data, created_at)
        VALUES (${deal.id}, ${a.id}, 'decision', ${JSON.stringify({ decision: a.decision })}::jsonb, ${decisionAt.toISOString()}::timestamp)`);
    }
    report.push({ buyer: a.buyerName, level: a.accessLevel, persona, visits: visits.length, activeMin: Math.round(totalActive / 6000) / 10 });
  }
  console.log(JSON.stringify({ deal: deal.businessName, dryRun, renditions: Object.fromEntries(Array.from(byLevel.entries()).map(([l, r]) => [l, r?.id ?? null])), buyers: report }, null, 2));
}

main().then(() => process.exit(0)).catch((err) => { console.error(String(err?.message ?? err)); process.exit(1); });
