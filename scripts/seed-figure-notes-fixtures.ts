/**
 * seed-figure-notes-fixtures — LOCAL TEST DATA, no AI.
 *
 * Writes recorded AI outputs (tests/fixtures/figures/<fixture>.notes.json,
 * hand-written to mimic the figure_reasons tool output) as SUGGESTED notes on
 * one of qa_cimgen's "QA OCT —" copies, so screenshots and checker streams can
 * see the whole figure-notes UI at $0. Nothing reaches a buyer until the
 * broker approves a note (Numbers & sources › Review and show).
 *
 * Every note goes through the same checks the AI pass applies (dd spec §9.5):
 *   - its figure must be on the deal (and, for a change, the year before);
 *   - every quote must be found word for word (whitespace, quotes, dashes and
 *     thousands separators normalised) in the cited document's text, or in a
 *     fact the deal recorded from that document; the document must be one
 *     buyers may be shown (never broker-only, CRM or email material);
 *   - figures in the text must come from the figures or the quotes;
 *   - the privacy guards (staff, held names, keep-out, sensitive detail,
 *     internal wording), at most two sentences and 320 characters;
 *   - the blind wording is dropped when it would identify the business.
 * A note that fails is reported and skipped.
 *
 * Refuses unless the deal belongs to qa_cimgen AND is named "QA OCT —".
 * DRY RUN by default. --apply writes; --remove deletes the notes this script
 * wrote (input fingerprint "fixture:…") — run --remove before deleting a copy.
 *
 *   ANTHROPIC_API_KEY=disabled DATABASE_URL=… npx tsx scripts/seed-figure-notes-fixtures.ts \
 *     --deal <copyId> --fixture pacific|lakeshore [--apply | --remove]
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { figureKey as figureKeyOf, parseFigureKey } from "../shared/figure-lines";
import type { FigureNoteSource } from "../shared/schema";
import type { MachineNote } from "../server/cim/figures/store";

export interface FixtureSource { kind: "document" | "transcript"; document: string; quote: string }
export interface FixtureNote {
  figureKey: string;
  kind: "movement" | "difference" | "context";
  compareKey: string;
  text: string;
  blindText: string | null;
  sources: FixtureSource[];
}
export interface FixtureFile { about?: string; notes: FixtureNote[] }

export interface SeedDoc { id: string; name: string; citable: boolean; text: string | null; sourceKind?: string | null; visibility?: string | null }
export interface SeedCtx {
  registry: Record<string, { value: number; lineLabel: string; line: string; year: string }>;
  docs: SeedDoc[];
  facts: Record<string, unknown>;
  /** guardBrokerText-like check (privacy, internal wording, blind leaks). */
  guard(text: string, blindText: string | null): { ok: true; blindText: string | null } | { ok: false; why: string };
  /** A figure in the text that isn't in the figures or the quotes (null = all known). */
  unknownFigure(text: string, knownText: string): string | null;
  normalize(s: string): string;
  sentenceCount(s: string): number;
}

export type Prepared = { ok: true; note: MachineNote } | { ok: false; figureKey: string; why: string };

/** Pure: each fixture note checked and turned into the row the AI pass would write. */
export function prepareFixtureNotes(file: FixtureFile, ctx: SeedCtx): Prepared[] {
  const out: Prepared[] = [];
  for (const n of file.notes) {
    const fail = (why: string) => out.push({ ok: false, figureKey: n.figureKey, why });
    const fig = ctx.registry[n.figureKey];
    if (!fig) { fail("that figure isn't on this deal"); continue; }
    const parsed = parseFigureKey(n.figureKey);
    let fromValue: number | undefined;
    if (n.kind === "movement") {
      const prev = parsed ? ctx.registry[figureKeyOf(parsed.line, n.compareKey)] : undefined;
      if (!prev) { fail(`no FY${n.compareKey} figure to measure the change from`); continue; }
      fromValue = prev.value;
    }
    const sources: FigureNoteSource[] = [];
    let bad: string | null = null;
    for (const s of n.sources) {
      const re = new RegExp(s.document, "i");
      const doc = ctx.docs.find((d) => re.test(d.name));
      if (!doc) { bad = `no document matching /${s.document}/`; break; }
      // A document is cited (it must be one buyers may open); a call or video
      // transcript is the owner's words (never broker-only, never cited as a file).
      if (s.kind === "document" && !doc.citable) { bad = `"${doc.name}" can't be shown to buyers`; break; }
      if (s.kind === "transcript" && (doc.visibility === "broker_only" || !["call", "video_call", "email"].includes(String(doc.sourceKind ?? "")))) {
        bad = `"${doc.name}" isn't a shared call or meeting transcript`; break;
      }
      const q = ctx.normalize(s.quote);
      const inText = !!doc.text && ctx.normalize(doc.text).includes(q);
      const sources_ = (ctx.facts._fieldSources ?? {}) as Record<string, { documentId?: string }>;
      const inFact = Object.entries(ctx.facts).some(([k, v]) => !k.startsWith("_") && sources_[k]?.documentId === doc.id && typeof v === "string" && ctx.normalize(v).includes(q));
      if (!inText && !inFact) { bad = `the quote isn't in "${doc.name}"`; break; }
      sources.push({ kind: s.kind, documentId: doc.id, quote: s.quote.slice(0, 240) });
    }
    if (bad) { fail(bad); continue; }
    if (ctx.sentenceCount(n.text) > 2 || n.text.length > 320) { fail("longer than two sentences / 320 characters"); continue; }
    const known = [`${fig.value}`, fromValue !== undefined ? `${fromValue}` : "", ...n.sources.map((s) => s.quote)].join("\n");
    const stray = ctx.unknownFigure(n.text, known);
    if (stray) { fail(`${stray} isn't in the figures or the quotes`); continue; }
    const g = ctx.guard(n.text, n.blindText);
    if (!g.ok) { fail(g.why); continue; }
    const snapshot = { year: fig.year, value: fig.value, ...(n.kind === "movement" ? { fromYear: n.compareKey, fromValue } : {}) };
    out.push({
      ok: true,
      note: {
        figureKey: n.figureKey,
        kind: n.kind,
        compareKey: n.compareKey,
        origin: "ai",
        text: n.text,
        blindText: g.blindText,
        sources,
        valuesSnapshot: snapshot as MachineNote["valuesSnapshot"],
        inputFingerprint: `fixture:${createHash("sha256").update(JSON.stringify(n)).digest("hex").slice(0, 16)}`,
      },
    });
  }
  return out;
}

const HERE = dirname(fileURLToPath(import.meta.url));
export function readFixtureNotes(name: string): FixtureFile {
  if (!/^[a-z]+$/.test(name)) throw new Error("fixture name: lower-case letters only");
  return JSON.parse(readFileSync(join(HERE, "..", "tests", "fixtures", "figures", `${name}.notes.json`), "utf8"));
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const dealId = arg("--deal");
  const fixtureName = arg("--fixture");
  const apply = args.includes("--apply");
  const remove = args.includes("--remove");
  if (!dealId || (!fixtureName && !remove)) throw new Error("usage: --deal <copyId> --fixture <name> [--apply | --remove]");
  if (apply && remove) throw new Error("--apply or --remove, not both");
  if (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== "disabled") throw new Error("run with ANTHROPIC_API_KEY=disabled");

  const { storage } = await import("../server/storage");
  const deal = await storage.getDeal(dealId);
  if (!deal) throw new Error("no such deal");
  const broker = deal.brokerId ? await storage.getUser(deal.brokerId) : undefined;
  if (broker?.username !== "qa_cimgen" || !/^QA OCT —/.test(deal.businessName ?? "")) {
    throw new Error("refusing: only qa_cimgen's \"QA OCT —\" copies take fixture notes");
  }
  const { db } = await import("../server/db");
  const { sql } = await import("drizzle-orm");

  if (remove) {
    const rows: any = await db.execute(sql`DELETE FROM cim_figure_notes WHERE deal_id = ${deal.id} AND input_fingerprint LIKE 'fixture:%' RETURNING id`);
    const n = Array.isArray(rows) ? rows.length : rows?.rows?.length ?? 0;
    const { invalidateFigureRaw } = await import("../server/cim/figures/serve");
    invalidateFigureRaw(deal.id);
    console.log(JSON.stringify({ deal: deal.businessName, removed: n }));
    return;
  }

  const file = readFixtureNotes(fixtureName!);
  const { loadFigureRaw, invalidateFigureRaw } = await import("../server/cim/figures/serve");
  const { guardBrokerText, normalizeQuote, sentenceCount, unknownFigure } = await import("../server/cim/figures/guards");
  const { guardCtxFor } = await import("../server/cim/figures/build");
  const { listNotes, upsertMachineNote } = await import("../server/cim/figures/store");
  const raw = await loadFigureRaw(deal.id);
  const texts: any = await db.execute(sql`SELECT id, extracted_text FROM documents WHERE deal_id = ${deal.id}`);
  const textRows: Array<{ id: string; extracted_text: string | null }> = Array.isArray(texts) ? texts : texts?.rows ?? [];
  const textOf = new Map(textRows.map((r) => [String(r.id), r.extracted_text]));
  const lineLabels = Object.values(raw.registry).filter((f) => String(f.line).startsWith("line:")).map((f) => f.lineLabel);
  const gctx = guardCtxFor(deal, raw.info, raw.state?.keepOut?.names ?? [], lineLabels);
  const prepared = prepareFixtureNotes(file, {
    registry: raw.registry as any,
    docs: Array.from(raw.docs.values()).map((d) => ({ id: d.id, name: d.name, citable: d.citable, text: textOf.get(d.id) ?? null, sourceKind: d.sourceKind, visibility: d.visibility })),
    facts: raw.info,
    guard: (text, blindText) => {
      const r = guardBrokerText(text, null, gctx);
      if (!r.ok) return { ok: false, why: r.message };
      // Guard 11: a blind wording that would identify the business is dropped (the named note stays).
      const b = blindText ? guardBrokerText(text, blindText, gctx) : null;
      return { ok: true, blindText: b && b.ok ? blindText : null };
    },
    unknownFigure,
    normalize: normalizeQuote,
    sentenceCount,
  });
  const existing = new Map((await listNotes(deal.id)).map((n) => [`${n.figureKey}|${n.kind}|${n.compareKey}`, n]));
  const report: Array<Record<string, unknown>> = [];
  for (const p of prepared) {
    if (!p.ok) { report.push({ figureKey: p.figureKey, skipped: p.why }); continue; }
    const row = existing.get(`${p.note.figureKey}|${p.note.kind}|${p.note.compareKey}`);
    if (!apply) { report.push({ figureKey: p.note.figureKey, wouldWrite: row ? "update (or a proposal beside the broker's version)" : "new suggested note", blind: !!p.note.blindText }); continue; }
    const r = await upsertMachineNote(deal.id, p.note, row?.inputFingerprint ?? null);
    report.push({ figureKey: p.note.figureKey, written: r });
  }
  if (apply) invalidateFigureRaw(deal.id);
  console.log(JSON.stringify({ deal: deal.businessName, fixture: fixtureName, apply, notes: report }, null, 2));
}

if (process.argv[1] && /seed-figure-notes-fixtures/.test(process.argv[1])) {
  main().then(() => process.exit(0), (err) => { console.error(err?.message ?? err); process.exit(1); });
}
