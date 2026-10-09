/**
 * Build a teaser on a QA copy with a RECORDED model output — no AI call, no
 * email (spec §9, §11 offline proof 1).
 *
 *   ANTHROPIC_API_KEY=disabled DATABASE_URL=… npx tsx scripts/teaser-offline-proof.ts \
 *     --deal <qa_cimgen "QA OCT —" deal id> --fixture tests/fixtures/teaser/pacific-write_teaser.json \
 *     [--template one_page|two_page|investor|listing] [--redaction-fixture <json>] [--apply] [--publish]
 *
 * It refuses unless ANTHROPIC_API_KEY is "disabled" and the deal belongs to
 * qa_cimgen and is named "QA OCT — …". The confidentiality review answers
 * with a recorded "nothing held"; the Blind CIM's redaction engine (only used
 * when the deal has no Blind CIM) answers with --redaction-fixture. The
 * fixture's "Project …" codename is swapped for the deal's own.
 *
 * Without --apply it only prints what it would write: the basis, the blocks,
 * every guard result (held blocks, pinpointing wording, layout problems).
 * --apply saves it as the deal's teaser draft; --publish then runs the
 * publish checks and publishes it (or prints why not).
 */
import fs from "fs";
import { sql } from "drizzle-orm";

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : null;
}
const has = (f: string) => process.argv.includes(f);

async function main() {
  if (process.env.ANTHROPIC_API_KEY !== "disabled") throw new Error("Refused: set ANTHROPIC_API_KEY=disabled (this proof never calls the AI).");
  const dealId = arg("--deal");
  const fixturePath = arg("--fixture");
  if (!dealId || !fixturePath) throw new Error("Usage: --deal <id> --fixture <json> [--template key] [--redaction-fixture <json>] [--apply] [--publish]");
  const templateKey = arg("--template") ?? "one_page";
  const { db } = await import("../server/db");
  const { proofDealCheck } = await import("../server/migrations/access-levels-2026-10");
  const refusal = await proofDealCheck(db as never, dealId);
  if (refusal) throw new Error(refusal);

  const { storage } = await import("../server/storage");
  const deal = await storage.getDeal(dealId);
  if (!deal) throw new Error("No such deal.");

  // ── Recorded models (no AI) ──
  const keepOut = await import("../server/cim/keep-out");
  keepOut._setKeepOutModelForTests({
    messages: { create: (async () => ({ content: [{ type: "tool_use", id: "recorded", name: "keep_out_review", input: { holds: [] } }], usage: { input_tokens: 0, output_tokens: 0 } })) as never },
  } as never);
  const redaction = await import("../server/cim/redaction-engine");
  const redFix = arg("--redaction-fixture");
  redaction.setRedactionModelForTests(async () => {
    if (!redFix) throw new Error("This deal has no Blind CIM: pass --redaction-fixture <json> (a recorded redaction reply).");
    const raw = fs.readFileSync(redFix, "utf8");
    const swapped = deal.blindCodename ? raw.replace(/Project [A-Z][a-z]+/g, deal.blindCodename) : raw;
    return { text: swapped, stopReason: "end_turn" };
  });
  const gen = await import("../server/teaser/generate");
  const { codenameFor } = { codenameFor: async () => {
    const { servedBlindCodename } = await import("../server/cim/published-snapshot");
    return (await servedBlindCodename(deal)) ?? deal.blindCodename ?? null;
  } };
  const codename = await codenameFor();
  const recorded = fs.readFileSync(fixturePath, "utf8");
  const reply = JSON.parse(codename ? recorded.replace(/Project [A-Z][a-z]+/g, codename) : recorded);
  let calls = 0;
  gen._setTeaserModelForTests(async () => {
    calls++;
    return { input: reply, usage: { input: 0, output: 0 } };
  });

  // ── Write (in memory) ──
  const store = await import("../server/teaser/store");
  const existing = await store.getDealTeaser(deal.id);
  const { templateDef } = await import("../shared/teaser-templates");
  const numbers = existing?.numbers ?? templateDef(templateKey).numbers;
  const bySlot = new Map((existing?.draft.blocks ?? []).map((b) => [b.slot, b.id]));
  const result = await gen.writeTeaser(deal, {
    templateKey, numbers, showAskingPrice: existing?.showAskingPrice ?? true, mode: "ai",
    startedAt: new Date().toISOString(), ownedBlockIds: [], idForSlot: (s) => bySlot.get(s),
  });
  const { checkTeaserDoc, teaserTerms } = await import("../shared/teaser-view");
  const checks = checkTeaserDoc(result.doc, teaserTerms(deal, result.codename));
  console.log(`Deal: ${deal.businessName}  (codename ${result.codename})`);
  console.log(`Template: ${templateKey} · numbers: ${numbers} · basis: ${result.generation.basis} · model calls (recorded): ${calls}`);
  if (result.generation.error) console.log(`Note: ${result.generation.error}`);
  for (const w of result.generation.warnings) console.log(`Warning: ${w}`);
  console.log(`Header: ${result.doc.header?.label} · "${result.doc.header?.tagline}" · [${result.doc.header?.chips.join(" | ")}]`);
  for (const b of result.doc.blocks) {
    const c = checks.find((x) => x.blockId === b.id)!;
    const flags = [b.hidden ? "hidden" : null, b.placeholder ? "write this" : null, c.held ? `HELD: ${c.reason}` : null, c.layoutProblem ? `layout: ${c.layoutProblem}` : null, c.pinpoint.length ? `may be recognisable: ${c.pinpoint.join("; ")}` : null].filter(Boolean).join(" · ");
    console.log(`  - [${b.slot}] ${b.title || "(no title)"} · ${b.layoutType} · ${b.origin}${flags ? ` · ${flags}` : ""}`);
  }
  const held = checks.filter((c) => c.held).length;
  console.log(`Held blocks: ${held} · pinpoint blocks: ${checks.filter((c) => c.pinpoint.length > 0).length}`);
  if (!has("--apply")) {
    console.log("\nDry run — nothing written. Re-run with --apply to save it as the teaser draft.");
    return;
  }

  // ── Save ──
  if (!existing) await store.teaserStore().create(deal.id, { templateKey, numbers });
  const saved = await store.teaserStore().update(deal.id, (r) => ({
    templateKey, numbers, draft: result.doc, draftRev: r.draftRev + 1,
    history: [...r.history, { at: new Date().toISOString(), reason: "Written by AI (recorded output — offline proof)", doc: r.draft }].slice(-20),
    codenameUsed: result.codename, generation: { ...result.generation, fullRewrite: false },
  }));
  console.log(`\nSaved: draft rev ${saved!.draftRev}.`);
  if (!has("--publish")) return;

  // ── Publish (the route's checks) ──
  const { publishProblems, publishedSnapshot } = await import("../server/teaser/doc-ops");
  const { codenameProblem } = await import("../server/cim/codenames");
  const { discrepancyGateFor } = gen;
  const discrepancies = discrepancyGateFor((await storage.getDiscrepanciesByDeal(deal.id)) as never, saved!.numbers);
  const problems = publishProblems(saved!.draft, {
    codenameProblem: result.codename ? codenameProblem(deal as never, result.codename) : "The deal has no codename yet.",
    checks, headerProblem: null, reviewOk: !result.generation.reviewFailed, discrepancyReasons: discrepancies.reasons,
  });
  if (problems.length > 0) {
    console.log("Not published:");
    for (const p of problems) console.log(`  - ${p}`);
    process.exitCode = 2;
    return;
  }
  const pub = await store.teaserStore().update(deal.id, (r) => ({
    published: publishedSnapshot(r.draft), publishedRev: r.publishedRev + 1, publishedAt: new Date(), unpublishedAt: null,
  }));
  console.log(`Published: rev ${pub!.publishedRev}.`);
  void sql;
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
