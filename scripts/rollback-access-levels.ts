/**
 * Undo the October 2026 access levels — only if this release must be
 * reverted to the previous code. Run it while the NEW code is still serving,
 * then deploy the previous commit. No AI, no email.
 *
 *   named → loi, blind → full                 (the previous code reads these)
 *   teaser_only → teaser, and every ACTIVE Teaser link expires now: the
 *   previous code can't serve a teaser, so those links show "expired" (fail
 *   closed). Their ids go to scripts/out/access-levels-rollback-<time>.json.
 *   Tables: buyer_access, buyer_visits, deal_members. New tables and columns
 *   stay (additive; old code ignores them).
 *
 * DRY RUN (default, read-only):
 *   ANTHROPIC_API_KEY=disabled DATABASE_URL=… npx tsx scripts/rollback-access-levels.ts
 * APPLY (one transaction, one run at a time):
 *   … npx tsx scripts/rollback-access-levels.ts --apply
 * After a later re-deploy of the new code, put the Teaser links back exactly
 * as they were (only rows still as the rollback left them):
 *   … npx tsx scripts/rollback-access-levels.ts --restore-teaser-links scripts/out/access-levels-rollback-<time>.json [--apply]
 *
 * PROOF MODE: --deal <id> limits every statement to one deal (qa_cimgen
 * "QA OCT — …" deals only).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { db } from "../server/db";
import {
  TIDY_TABLES, applyRollback, countsLine, proofDealCheck, readRollbackPlan, restoreTeaserLinks,
  type RestoreLink, type TidyDb, type TidyPlan,
} from "../server/migrations/access-levels-2026-10";

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "out");
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
const short = (id: string | null | undefined) => (id ? `${id.slice(0, 8)}…` : "—");

function argValue(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : null;
}

function writeOut(name: string, data: unknown): string {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return path.relative(process.cwd(), file);
}

function printPlan(plan: TidyPlan, heading: string) {
  console.log(heading);
  for (const t of TIDY_TABLES) console.log(`  ${t.padEnd(14)} ${countsLine(plan.counts[t] ?? {})}`);
  const expiring = plan.changes.filter((c) => c.expire).length;
  console.log(`  total          ${plan.total}${expiring ? ` (${expiring} open Teaser link${expiring === 1 ? "" : "s"} expire${expiring === 1 ? "s" : ""} now)` : ""}`);
}

async function main() {
  const apply = process.argv.includes("--apply");
  const dealId = argValue("--deal");
  const restoreFile = argValue("--restore-teaser-links");
  if (process.argv.includes("--deal") && !dealId) throw new Error("--deal needs a deal id");
  if (process.argv.includes("--restore-teaser-links") && !restoreFile) throw new Error("--restore-teaser-links needs the rollback's output file");
  if (dealId) {
    const refusal = await proofDealCheck(db as unknown as TidyDb, dealId);
    if (refusal) {
      console.error(`Refused: ${refusal}`);
      process.exit(2);
    }
    console.log(`Proof mode: deal ${short(dealId)} only.`);
  }

  if (restoreFile) {
    const saved = JSON.parse(fs.readFileSync(restoreFile, "utf8")) as { teaserLinks?: RestoreLink[] };
    const links = (saved.teaserLinks ?? []).filter((l) => !dealId || l.dealId === dealId);
    console.log(`${links.length} Teaser link${links.length === 1 ? "" : "s"} in ${restoreFile}${dealId ? " for this deal" : ""}: ${links.slice(0, 10).map((l) => short(l.id)).join(", ")}${links.length > 10 ? " …" : ""}`);
    if (!apply) {
      console.log("Dry run only — nothing changed. Run again with --apply to put them back.");
      process.exit(0);
    }
    const r = await restoreTeaserLinks(db as unknown as TidyDb, links);
    console.log(`Restored ${r.restored.length}; left alone ${r.skipped.length} (changed since the rollback)${r.skipped.length ? `: ${r.skipped.map(short).join(", ")}` : ""}.`);
    process.exit(0);
  }

  const plan = await readRollbackPlan(db as unknown as TidyDb, { dealId });
  printPlan(plan, `Dry run${dealId ? " (one deal)" : ""} — rollback to the previous release's values:`);
  if (!apply) {
    console.log("Dry run only — nothing changed. Run again with --apply (only when reverting this release).");
    process.exit(0);
  }
  const result = await applyRollback(db as unknown as TidyDb, { dealId });
  const file = writeOut(`access-levels-rollback-${stamp()}.json`, {
    at: new Date().toISOString(), scope: dealId ? { dealId } : "all", counts: result.counts, total: result.total,
    changes: result.changes, teaserLinks: result.teaserLinks ?? [],
  });
  printPlan(result, "Rolled back (one transaction):");
  console.log(`Record written to ${file} — keep it: after a re-deploy, --restore-teaser-links ${file} puts the Teaser links back.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(String(err?.message || err).replace(/postgres(ql)?:\/\/[^\s"']+/g, "<DATABASE_URL>"));
  process.exit(1);
});
