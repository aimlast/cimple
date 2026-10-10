/**
 * Re-checks the section lineage stored at past regenerations with lineage v2
 * (server/analytics/lineage.ts) and repairs the links it can check — the
 * heat map's page-19 mix-up ("Working Capital Summary" carrying the
 * capital-expenditure page's reading). Heat-map spec §7.1; the rules are in
 * server/engagement/lineage-repair.ts.
 *
 * DRY RUN by default (nothing written). --apply writes, one transaction per
 * deal, and saves the before/after (section ids and titles only) to
 * ~/.claude/cimple-backups/lineage-repair-<dealId>-<date>.json. Re-running
 * reports 0 changes. No AI, no email, no network besides the database; never
 * prints connection strings or tokens.
 *
 *   ANTHROPIC_API_KEY=disabled DATABASE_URL=… npx tsx scripts/repair-section-lineage.ts (--deal <id> | --all) [--apply]
 */
import fs from "fs";
import os from "os";
import path from "path";
import { sql } from "drizzle-orm";
import type { RenditionPage } from "@shared/analytics-v2";
import {
  applyLineageRepair, chooseEarlierVersion, planLineageRepair, repairChanges,
  type RepairKeptCopy, type RepairRendition, type RepairRow, type RepairSection, type RepairTx,
} from "../server/engagement/lineage-repair";
import { asDate } from "../server/analytics/reading-ingest";

type Row = Record<string, unknown>;

function args() {
  const a = process.argv.slice(2);
  const val = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  return { deal: val("--deal"), all: a.includes("--all"), apply: a.includes("--apply") };
}

async function db() {
  return (await import("../server/db")).db;
}
async function q(text: ReturnType<typeof sql>): Promise<Row[]> {
  return (await (await db()).execute(text)) as unknown as Row[];
}

interface DealInputs {
  id: string;
  name: string;
  version: number | null;
  current: RepairSection[];
  kept: RepairKeptCopy | null;
  renditions: RepairRendition[];
}

async function loadInputs(dealId: string): Promise<DealInputs | null> {
  const [d] = await q(sql`SELECT id, business_name, cim_layout_version FROM deals WHERE id = ${dealId}`);
  if (!d) return null;
  const current = (await q(sql`
    SELECT id, section_key, section_title, layout_type, analytics_lineage, created_at
    FROM cim_sections WHERE deal_id = ${dealId} ORDER BY "order", created_at, id`)).map((r) => ({
    id: String(r.id), sectionKey: String(r.section_key ?? ""), sectionTitle: String(r.section_title ?? ""), layoutType: String(r.layout_type ?? ""),
    analyticsLineage: r.analytics_lineage == null ? null : String(r.analytics_lineage), createdAt: asDate(r.created_at),
  }));
  const keptRows = await q(sql`
    SELECT p.taken_at, s->>'id' AS id, s->>'sectionKey' AS section_key, s->>'sectionTitle' AS section_title,
      s->>'layoutType' AS layout_type, s->>'analyticsLineage' AS lineage
    FROM cim_published_snapshots p, jsonb_array_elements(p.sections) s
    WHERE p.deal_id = ${dealId} AND p.taken_at = (SELECT MAX(taken_at) FROM cim_published_snapshots WHERE deal_id = ${dealId})
    ORDER BY (s->>'order')::numeric NULLS LAST`);
  const kept: RepairKeptCopy | null = keptRows.length
    ? {
      takenAt: asDate(keptRows[0].taken_at),
      sections: keptRows.filter((r) => r.id != null).map((r) => ({
        id: String(r.id), sectionKey: String(r.section_key ?? ""), sectionTitle: String(r.section_title ?? ""), layoutType: String(r.layout_type ?? ""),
        analyticsLineage: r.lineage == null || r.lineage === "" ? null : String(r.lineage),
      })),
    }
    : null;
  const version = d.cim_layout_version == null ? null : Number(d.cim_layout_version);
  const renditions: RepairRendition[] = version == null ? [] : (await q(sql`
    SELECT r.id, r.mode, r.cim_layout_version, r.created_at, r.page_index,
      (SELECT jsonb_object_agg(s->>'id', COALESCE(s->>'sectionKey', '')) FROM jsonb_array_elements(r.sections) s WHERE s->>'id' IS NOT NULL) AS keys
    FROM cim_renditions r WHERE r.deal_id = ${dealId} AND r.cim_layout_version = ${version - 1}`)).map((r) => ({
    id: String(r.id), mode: String(r.mode), cimLayoutVersion: Number(r.cim_layout_version), createdAt: asDate(r.created_at),
    pageIndex: (r.page_index as RenditionPage[]) ?? [], keys: (r.keys as Record<string, string>) ?? {},
  }));
  return { id: String(d.id), name: String(d.business_name ?? "(no name)"), version, current, kept, renditions };
}

const pad = (s: string, n: number) => (s.length >= n ? `${s.slice(0, n - 1)}… ` : s.padEnd(n));

function report(inp: DealInputs, rows: RepairRow[], titleOf: Map<string, string>, check: string) {
  const t = (lin: string | null) => (lin ? titleOf.get(lin) ?? `(a page not on file: ${lin.slice(0, 8)}…)` : "(fresh history)");
  const shown = rows.filter((r) => r.outcome !== "unchanged");
  for (const r of shown) {
    const from = r.stored ? t(r.stored) : "(fresh)";
    const to = r.outcome === "cant_check" ? "left alone" : t(r.proposed);
    const label = r.outcome === "change" ? "" : r.outcome === "addition" ? "addition"
      : r.outcome === "possible" ? "possible link, not applied" : r.outcome === "cant_check" ? "can't check (earlier page not on file)" : "skipped";
    console.log(`  ${pad(r.title, 36)}${pad(`${from} → ${to}`, 70)}${r.why ? `[${r.why}]` : ""}${label ? `   ${label}` : ""}`);
  }
  const n = (o: RepairRow["outcome"]) => rows.filter((r) => r.outcome === o).length;
  const changes = n("change") + n("addition");
  console.log(`  ${changes} change${changes === 1 ? "" : "s"} · ${n("unchanged")} unchanged · ${n("cant_check")} can't check`
    + `${n("possible") ? ` · ${n("possible")} possible (not applied: ${check} check)` : ""}${n("skipped") ? ` · ${n("skipped")} skipped` : ""}`);
}

function dbTx(tx: { execute: (q: ReturnType<typeof sql>) => Promise<unknown> }): RepairTx {
  const run = async (text: ReturnType<typeof sql>) => (await tx.execute(text)) as unknown as Row[];
  return {
    async updateSectionLineage(dealId, id, from, to) {
      const r = await run(sql`UPDATE cim_sections SET analytics_lineage = ${to}
        WHERE id = ${id} AND deal_id = ${dealId} AND analytics_lineage IS NOT DISTINCT FROM ${from} RETURNING id`);
      return r.length > 0;
    },
    async renditionsWithPages(dealId, sectionIds) {
      const r = await run(sql`SELECT id, page_index FROM cim_renditions WHERE deal_id = ${dealId}
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(page_index) p WHERE p->>'pageId' IN (${sql.join(sectionIds.map((x) => sql`${x}`), sql`, `)}))`);
      return r.map((x) => ({ id: String(x.id), pageIndex: (x.page_index as RenditionPage[]) ?? [] }));
    },
    async setRenditionPageIndex(dealId, id, pageIndex) {
      await run(sql`UPDATE cim_renditions SET page_index = ${JSON.stringify(pageIndex)}::jsonb WHERE id = ${id} AND deal_id = ${dealId}`);
    },
    async setRollupLineage(dealId, pageId, lineage) {
      const r = await run(sql`UPDATE reading_rollups SET lineage_id = ${lineage}
        WHERE deal_id = ${dealId} AND page_id = ${pageId} AND rendition_id IS NOT NULL AND lineage_id IS DISTINCT FROM ${lineage} RETURNING id`);
      return r.length;
    },
  };
}

function backup(inp: DealInputs, rows: RepairRow[], titleOf: Map<string, string>, applied: string[]): string {
  const dir = path.join(os.homedir(), ".claude", "cimple-backups");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `lineage-repair-${inp.id}-${new Date().toISOString().slice(0, 10)}.json`);
  const applyIds = new Set(applied);
  const body = {
    dealId: inp.id, at: new Date().toISOString(),
    sections: rows.filter((r) => applyIds.has(r.id)).map((r) => ({
      id: r.id, title: r.title,
      before: r.stored, beforeTitle: r.stored ? titleOf.get(r.stored) ?? null : null,
      after: r.proposed, afterTitle: r.proposed ? titleOf.get(r.proposed) ?? null : null,
    })),
  };
  // Never overwrite an earlier backup of the same day: append a counter.
  let out = file;
  for (let i = 2; fs.existsSync(out); i++) out = file.replace(/\.json$/, `-${i}.json`);
  fs.writeFileSync(out, JSON.stringify(body, null, 2));
  return out;
}

async function main() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (key !== "disabled" && key !== "unused") throw new Error("Run this with ANTHROPIC_API_KEY=disabled (it never calls the AI).");
  const { deal, all, apply } = args();
  if (!deal && !all) throw new Error("usage: repair-section-lineage.ts (--deal <id> | --all) [--apply]");
  if (apply && !deal) throw new Error("--apply needs --deal <id> (one deal at a time, after reviewing the dry run).");
  console.log(`repair-section-lineage — ${apply ? "APPLY" : "DRY RUN (nothing written)"}`);
  const ids = deal ? [deal] : (await q(sql`SELECT DISTINCT s.deal_id FROM cim_sections s JOIN deals d ON d.id = s.deal_id`)).map((r) => String(r.deal_id));
  const nothing: string[] = [];
  for (const id of ids) {
    const inp = await loadInputs(id);
    if (!inp) { console.log(`No deal ${id}.`); continue; }
    const earlier = chooseEarlierVersion({ current: inp.current, kept: inp.kept, renditions: inp.renditions, cimLayoutVersion: inp.version });
    if ("cantCheck" in earlier) {
      if (deal) console.log(`${inp.name} (${inp.id.slice(0, 8)}…) — can't check: ${earlier.cantCheck}. Nothing to do.`);
      else nothing.push(inp.name);
      continue;
    }
    console.log(`${inp.name} (${inp.id.slice(0, 8)}…) — earlier version: ${earlier.label} — ${earlier.check} check`);
    const titleOf = new Map(earlier.sections.map((o) => [o.analyticsLineage || o.id, o.sectionTitle || o.layoutType]));
    const rows = planLineageRepair(inp.current, earlier);
    report(inp, rows, titleOf, earlier.check);
    const changes = repairChanges(rows);
    if (!apply || changes.length === 0) continue;
    const res = await (await db()).transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`lineage-repair:${inp.id}`}))`);
      return applyLineageRepair(dbTx(tx), inp.id, changes);
    });
    const file = backup(inp, rows, titleOf, res.updated);
    console.log(`  Applied: ${res.updated.length} section${res.updated.length === 1 ? "" : "s"} · ${res.renditionsPatched} stored version${res.renditionsPatched === 1 ? "" : "s"} · ${res.rollupsPatched} part-by-part row${res.rollupsPatched === 1 ? "" : "s"} patched`);
    if (res.changedMeanwhile.length) console.log(`  Changed by someone else meanwhile (left alone): ${res.changedMeanwhile.join(", ")}`);
    console.log(`  Backup: ${file}`);
  }
  if (nothing.length) console.log(`${nothing.length} other deal${nothing.length === 1 ? "" : "s"}: no earlier version on file, nothing to check.`);
  if (!apply) console.log("Nothing written. Re-run with --apply --deal <id>.");
}

main().then(() => process.exit(0)).catch((err) => {
  const msg = String(err?.message ?? err).replace(/postgres(ql)?:\/\/[^\s"']+/g, "<DATABASE_URL>");
  console.error(msg);
  process.exit(1);
});
