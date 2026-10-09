/**
 * Helpers for stream dd's tests (figure notes / DD checks): a tiny runner,
 * the demo fixtures (fictional, copied read-only from the QA OCT copies) and
 * an in-process Postgres (PGlite) with dd's four tables — no network, no AI.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let passed = 0;
let failed = 0;
const queue: Array<{ name: string; fn: () => unknown }> = [];

export function test(name: string, fn: () => unknown): void {
  queue.push({ name, fn });
}

/** Run every registered test in order; exit 1 on any failure. */
export async function run(title: string): Promise<void> {
  console.log(title);
  for (const t of queue) {
    try {
      await t.fn();
      passed++;
      console.log(`  ✓ ${t.name}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${t.name}`);
      console.error(err);
    }
  }
  console.log(`${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

export interface FigureFixture {
  deal: { id: string; businessName: string; blindCodename: string | null };
  sections: Array<{ id: string; dealId: string; sectionKey: string; sectionTitle: string; order: number; layoutType: string; layoutData: any }>;
  analyses: any[];
  documents: Array<{
    id: string; name: string; category: string | null; subcategory: string | null; visibility: string | null; sourceKind: string | null;
    fileUrl: string | null; updatedAt: string; extractedData: Record<string, any>; extractedText: string | null;
  }>;
  facts: Record<string, any>;
}

const HERE = dirname(fileURLToPath(import.meta.url));
export function fixture(name: "pacific" | "beacon" | "lakeshore"): FigureFixture {
  return JSON.parse(readFileSync(join(HERE, "..", "..", "fixtures", "figures", `${name}.json`), "utf8"));
}

/** dd's four tables, exactly as db:push creates them (additive-ddl output, 2026-10-09). */
export const FIGURE_TABLES_DDL = `
CREATE TABLE IF NOT EXISTS "cim_figure_notes" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "deal_id" varchar NOT NULL, "figure_key" text NOT NULL, "kind" text NOT NULL, "compare_key" text DEFAULT '' NOT NULL,
  "origin" text NOT NULL, "status" text DEFAULT 'suggested' NOT NULL, "text" text NOT NULL, "blind_text" text,
  "sources" jsonb DEFAULT '[]'::jsonb NOT NULL, "values_snapshot" jsonb NOT NULL, "input_fingerprint" text NOT NULL,
  "stale_reason" text, "proposal" jsonb, "seller_comment" text, "history" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "approved_at" timestamp, "approved_by" varchar, "edited_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL, "updated_at" timestamp DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "cim_figure_questions" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "deal_id" varchar NOT NULL, "figure_key" text NOT NULL, "kind" text NOT NULL, "compare_key" text DEFAULT '' NOT NULL,
  "capture_key" text NOT NULL, "question" text NOT NULL, "values_shown" jsonb NOT NULL, "status" text DEFAULT 'suggested' NOT NULL,
  "routed_at" timestamp, "routed_by" text, "raised_at" timestamp, "session_id" varchar, "closed_reason" text,
  "created_at" timestamp DEFAULT now() NOT NULL, "updated_at" timestamp DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "cim_figure_state" (
  "deal_id" varchar PRIMARY KEY NOT NULL, "build" jsonb, "budget_day" text, "budget_calls" integer DEFAULT 0 NOT NULL,
  "auto_ask" boolean, "dd_shown_at" timestamp, "dd_shown_by" varchar, "keep_out" jsonb,
  "located" jsonb DEFAULT '{}'::jsonb NOT NULL, "refreshed_fingerprint" text, "refreshed_at" timestamp,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "dd_check_decisions" (
  "id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "deal_id" varchar NOT NULL, "check_key" text NOT NULL, "state" text NOT NULL, "reason" text,
  "corrected_value" numeric(18, 2), "values_snapshot" jsonb NOT NULL, "decided_by" varchar,
  "decided_at" timestamp DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "cim_figure_notes_uniq" ON "cim_figure_notes" USING btree ("deal_id","figure_key","kind","compare_key");
CREATE INDEX IF NOT EXISTS "cim_figure_notes_deal" ON "cim_figure_notes" USING btree ("deal_id","status");
CREATE UNIQUE INDEX IF NOT EXISTS "cim_figure_questions_uniq" ON "cim_figure_questions" USING btree ("deal_id","figure_key","kind","compare_key");
CREATE INDEX IF NOT EXISTS "cim_figure_questions_deal" ON "cim_figure_questions" USING btree ("deal_id","status");
CREATE UNIQUE INDEX IF NOT EXISTS "dd_check_decisions_uniq" ON "dd_check_decisions" USING btree ("deal_id","check_key");
`;

/** A fresh in-process Postgres with dd's tables, as a drizzle database. */
export async function figurePglite(): Promise<{ db: any; pg: any }> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("../../../shared/schema");
  const pg = new PGlite();
  await pg.exec(FIGURE_TABLES_DDL);
  return { db: drizzle(pg, { schema }), pg };
}

// ── Fixture → figure raw inputs (no DB) ────────────────────────────────────

export interface RawOpts {
  notes?: any[];
  decisions?: any[];
  ddShownAt?: Date | null;
  /** Locate every value in the fixture's document texts first (as the refresh does). Default true. */
  locate?: boolean;
  info?: Record<string, unknown>;
}

/** The audience-neutral raw inputs for a fixture deal, exactly as loadFigureRaw assembles them. */
export async function fixtureRaw(name: "pacific" | "beacon" | "lakeshore", opts: RawOpts = {}) {
  const fx = fixture(name);
  const { assembleFigureRaw } = await import("../../../server/cim/figures/serve");
  const { locateValues } = await import("../../../server/cim/figures/locate");
  const docs = fx.documents.map((d) => ({ ...d, extractedText: undefined })) as any[];
  const base = (located: Record<string, any>) => assembleFigureRaw(fx.deal.id, {
    info: opts.info ?? fx.facts,
    docs,
    analyses: fx.analyses,
    notes: opts.notes ?? [],
    questions: [],
    decisions: opts.decisions ?? [],
    state: { dealId: fx.deal.id, build: null, budgetDay: null, budgetCalls: 0, autoAsk: null, ddShownAt: opts.ddShownAt ?? null, ddShownBy: null, keepOut: null, located, refreshedFingerprint: null, refreshedAt: null, updatedAt: new Date() } as any,
  });
  let raw = base({});
  if (opts.locate !== false) {
    const text = (id: string) => fx.documents.find((d) => d.id === id)?.extractedText ?? null;
    raw = base(locateValues(raw.checks.toLocate, text));
  }
  return { fx, raw };
}

/** A cim_figure_notes row as the store returns it. */
export function noteRow(over: Record<string, any>): any {
  return {
    id: over.id ?? `note-${Math.random().toString(36).slice(2, 8)}`,
    dealId: "deal", kind: "movement", compareKey: "", origin: "computed", status: "approved",
    text: "A note.", blindText: null, sources: [{ kind: "computed" }], valuesSnapshot: { year: "2023", value: 0 },
    inputFingerprint: "fp", staleReason: null, proposal: null, sellerComment: null, history: [],
    approvedAt: new Date(), approvedBy: "b", editedAt: null, createdAt: new Date(), updatedAt: new Date(),
    ...over,
  };
}
